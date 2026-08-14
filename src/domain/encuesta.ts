import { ENCUESTA_FILE, ENCUESTA_LEDGER_FILE } from "../core/config.js";
import {
  encuestaLogin,
  fetchQuestionnaireRaw,
  fetchSurveyListRaw,
  postAnswersRaw,
  type EncuestaSession,
} from "../core/encuestaClient.js";
import type {
  AnswerSet,
  EncuestaPolicy,
  FillReport,
  Questionnaire,
  SubmitResult,
  SurveyRef,
} from "../core/encuestaModels.js";
import {
  alreadySubmitted,
  appendLedger,
  loadLedger,
  resolveCreds,
  resolvePolicy,
} from "../core/encuestaStore.js";
import { EncuestaAuthError, EncuestaProtocolError } from "../core/errors.js";
import { acquireLock } from "../core/lock.js";
import { parseQuestionnaire, parseSurveyList, stripDebugAndCode } from "./encuestaParse.js";
import { matchKey, resolveAnswers, type AnswerOverrides } from "./encuestaPolicy.js";
import { assertPayloadSane, buildSubmitBody } from "./encuestaPayload.js";

/**
 * Casos de uso de la encuesta docente. Es la única capa que combina red, estado en disco y las
 * decisiones de los módulos puros — y por tanto donde viven las salvaguardas contra el único
 * error que no tiene arreglo: enviar algo que no se puede deshacer.
 *
 * Reglas de la casa:
 *  - Simular es lo normal; enviar exige un acto deliberado y explícito.
 *  - Nunca se envía en paralelo ni se reintenta un envío.
 *  - Todo intento queda en el ledger, incluso los fallidos.
 */

export const CONFIRM_PHRASE = "ENVIAR";

/** Qué encuestas tocar. */
export type SurveySelector = { all: true } | { key: string } | { query: string };

export interface FillOptions {
  /** Sin `apply: true` no se toca la red de escritura: sólo se simula. */
  apply?: boolean;
  /** Frase literal exigida cuando apply=true. Sin ella se rechaza aunque apply sea true. */
  confirm?: string;
  answers?: AnswerOverrides;
  /** Por defecto false: un rechazo del servidor detiene el lote. */
  continueOnError?: boolean;
  onStatus?: (msg: string) => void;
}

async function openSession(): Promise<EncuestaSession> {
  const creds = await resolveCreds();
  if (!creds) {
    throw new EncuestaAuthError(
      "No hay credenciales de la encuesta. Ejecuta `dutic encuesta login` " +
        "(o exporta DUTIC_ENCUESTA_USER y DUTIC_ENCUESTA_PASSWORD).",
    );
  }
  return encuestaLogin(creds);
}

/** Comprueba que las credenciales entran. Se usa en `dutic encuesta login`. */
export async function verifyCredentials(): Promise<boolean> {
  await openSession();
  return true;
}

export interface SurveyListing {
  surveys: SurveyRef[];
  pending: SurveyRef[];
  done: SurveyRef[];
}

async function listWithSession(session: EncuestaSession): Promise<SurveyListing> {
  const raw = await fetchSurveyListRaw(session);
  const { code, body } = stripDebugAndCode(raw);
  if (code === "0") {
    throw new EncuestaProtocolError(`El sistema rechazó el listado: ${body.trim()}`);
  }
  const surveys = parseSurveyList(body);
  return {
    surveys,
    pending: surveys.filter((s) => s.status === "pending"),
    done: surveys.filter((s) => s.status === "done"),
  };
}

export async function listSurveys(): Promise<SurveyListing> {
  return listWithSession(await openSession());
}

/** Selecciona encuestas pendientes según el selector, casando por key, docente o curso. */
function select(pending: SurveyRef[], sel: SurveySelector): SurveyRef[] {
  if ("all" in sel) return pending;
  if ("key" in sel) return pending.filter((s) => s.key === sel.key);
  const needle = matchKey(sel.query);
  return pending.filter(
    (s) => matchKey(s.teacher).includes(needle) || matchKey(s.course).includes(needle),
  );
}

async function loadQuestionnaire(
  session: EncuestaSession,
  ref: SurveyRef,
): Promise<Questionnaire> {
  const raw = await fetchQuestionnaireRaw(session, ref);
  const { code, body } = stripDebugAndCode(raw);
  if (code === "0") {
    throw new EncuestaProtocolError(`El sistema rechazó el cuestionario: ${body.trim()}`);
  }
  return parseQuestionnaire(body, ref);
}

export interface PreviewItem {
  ref: SurveyRef;
  questionnaire: Questionnaire;
  plan: AnswerSet;
  /** Cuerpo exacto que se enviaría. Se muestra para poder auditarlo antes de nada. */
  body: string;
}

/**
 * Descarga los cuestionarios seleccionados y calcula qué se respondería. NO envía nada nunca:
 * es la operación que hay que usar para revisar antes de decidir.
 */
export async function previewSurveys(
  sel: SurveySelector,
  opts: { answers?: AnswerOverrides; policy?: EncuestaPolicy } = {},
): Promise<PreviewItem[]> {
  const session = await openSession();
  const { pending } = await listWithSession(session);
  const chosen = select(pending, sel);
  const policy = opts.policy ?? (await resolvePolicy());

  const items: PreviewItem[] = [];
  for (const ref of chosen) {
    const questionnaire = await loadQuestionnaire(session, ref);
    const plan = resolveAnswers(questionnaire, policy, opts.answers);
    // El cuerpo sólo se puede construir si el plan está completo; si no, se muestra vacío junto
    // con los `issues` para que el usuario vea exactamente qué le falta configurar.
    const body = plan.complete ? buildSubmitBody(plan) : "";
    items.push({ ref, questionnaire, plan, body });
  }
  return items;
}

/** Interpreta la respuesta del servidor a un envío. */
function readSubmitOutcome(raw: string): { outcome: SubmitResult["outcome"]; message: string } {
  try {
    const { code, body } = stripDebugAndCode(raw);
    if (code === "1") return { outcome: "ok", message: "Encuesta registrada." };
    return { outcome: "rejected", message: body.trim() || "El servidor rechazó el envío." };
  } catch {
    return {
      outcome: "unknown",
      message:
        "El servidor respondió algo irreconocible. NO se sabe si la encuesta quedó registrada: " +
        "compruébalo en la web antes de reintentar.",
    };
  }
}

/**
 * Simula o envía las encuestas seleccionadas.
 *
 * Con `apply: false` (lo normal) sólo devuelve el plan. Con `apply: true` y la frase de
 * confirmación correcta, envía SECUENCIALMENTE y registra cada intento en el ledger.
 */
export async function fillSurveys(sel: SurveySelector, opts: FillOptions = {}): Promise<FillReport> {
  const { apply = false, confirm, continueOnError = false, onStatus = () => {} } = opts;

  if (apply && confirm !== CONFIRM_PHRASE) {
    throw new EncuestaProtocolError(
      `Para enviar de verdad hace falta la confirmación literal "${CONFIRM_PHRASE}". ` +
        `El envío es irreversible y sólo se puede hacer una vez por docente.`,
    );
  }

  const report: FillReport = {
    dryRun: !apply,
    planned: [],
    submitted: [],
    skipped: [],
    failed: [],
  };

  // Dos procesos enviando a la vez (p.ej. el agente y el usuario en su terminal) es justo el
  // escenario que produce duplicados. No se espera al otro: se aborta y que decida la persona.
  const lock = apply ? await acquireLock("encuesta", { label: "envío de encuestas" }) : null;
  if (apply && !lock) {
    throw new EncuestaProtocolError(
      "Hay otro proceso enviando encuestas ahora mismo. Espera a que termine y vuelve a intentarlo.",
    );
  }

  try {
    const session = await openSession();
    const listing = await listWithSession(session);
    const policy = await resolvePolicy();
    const chosen = select(listing.pending, sel);

    for (const ref of listing.pending) {
      if (!chosen.some((c) => c.key === ref.key)) {
        report.skipped.push({ key: ref.key, teacher: ref.teacher, reason: "filtered" });
      }
    }

    for (const ref of chosen) {
      // Idempotencia (a): el registro local dice que ya se envió con éxito desde aquí.
      if (await alreadySubmitted(ref.key)) {
        report.skipped.push({ key: ref.key, teacher: ref.teacher, reason: "already-submitted" });
        onStatus(`${ref.teacher}: ya enviada anteriormente, se omite.`);
        continue;
      }

      try {
        onStatus(`${ref.teacher}: cargando cuestionario…`);
        // El cuestionario se vuelve a descargar siempre: el cuerpo se construye a partir de lo
        // que el servidor acaba de decir, nunca de algo cacheado.
        const questionnaire = await loadQuestionnaire(session, ref);
        const plan = resolveAnswers(questionnaire, policy, opts.answers);
        report.planned.push(plan);

        if (!plan.complete) {
          report.failed.push({
            key: ref.key,
            teacher: ref.teacher,
            error: `Respuestas incompletas: ${plan.issues.join(" · ")}`,
          });
          if (!continueOnError) break;
          continue;
        }

        const body = buildSubmitBody(plan);
        assertPayloadSane(body, questionnaire, plan);

        if (!apply) {
          onStatus(`${ref.teacher}: simulado (no se envió nada).`);
          continue;
        }

        // Idempotencia (b): el servidor es la autoridad final. Se re-comprueba contra el listado
        // que se acaba de traer en esta misma sesión.
        const stillPending = listing.pending.some((s) => s.key === ref.key);
        if (!stillPending) {
          report.skipped.push({ key: ref.key, teacher: ref.teacher, reason: "not-pending" });
          continue;
        }

        onStatus(`${ref.teacher}: ENVIANDO…`);
        const raw = await postAnswersRaw(session, body);
        const { outcome, message } = readSubmitOutcome(raw);

        const result: SubmitResult = {
          key: ref.key,
          teacher: ref.teacher,
          course: ref.course,
          outcome,
          message,
          submittedAt: Date.now(),
          body,
          answers: plan.answers.map((a) => ({
            questionId: a.questionId,
            label: a.label,
            value: a.value,
            alternativeId: a.alternativeId,
          })),
        };

        // Se registra SIEMPRE, incluso si falló: si no sabemos si llegó, tiene que constar para
        // que nadie lo reintente a ciegas.
        await appendLedger(result);
        report.submitted.push(result);
        onStatus(`${ref.teacher}: ${outcome === "ok" ? "enviada." : `${outcome} — ${message}`}`);

        if (outcome !== "ok" && !continueOnError) break;

        // Respiro entre envíos: el backend es PHP 5.3 con sesión compartida.
        await new Promise((r) => setTimeout(r, 800));
      } catch (err) {
        report.failed.push({
          key: ref.key,
          teacher: ref.teacher,
          error: (err as Error).message,
        });
        // Un fallo de protocolo con `apply` puede significar "no sé si llegó". Nunca se reintenta
        // automáticamente: se corta y que la persona compruebe.
        if (!continueOnError) break;
      }
    }
  } finally {
    await lock?.release();
  }

  return report;
}

export interface EncuestaStatus {
  hasCredentials: boolean;
  configPath: string;
  ledgerPath: string;
  policy: EncuestaPolicy;
  policyConfigured: boolean;
  pending: number;
  done: number;
  surveys?: SurveyRef[];
  ledger: { key: string; teacher: string; outcome: string; submittedAt: string }[];
  /** null si no se pudo consultar (sin credenciales o sin red); el resto sigue siendo útil. */
  onlineError: string | null;
}

export async function encuestaStatus(opts: { online?: boolean } = {}): Promise<EncuestaStatus> {
  const { online = true } = opts;
  const creds = await resolveCreds();
  const policy = await resolvePolicy();
  const ledger = await loadLedger();

  const status: EncuestaStatus = {
    hasCredentials: creds !== null,
    configPath: ENCUESTA_FILE,
    ledgerPath: ENCUESTA_LEDGER_FILE,
    policy,
    policyConfigured: policy.default !== undefined || policy.score !== undefined,
    pending: 0,
    done: 0,
    ledger: ledger.map((e) => ({
      key: e.key,
      teacher: e.teacher,
      outcome: e.outcome,
      submittedAt: new Date(e.submittedAt).toISOString(),
    })),
    onlineError: null,
  };

  if (online && creds) {
    try {
      const listing = await listSurveys();
      status.pending = listing.pending.length;
      status.done = listing.done.length;
      status.surveys = listing.surveys;
    } catch (err) {
      status.onlineError = (err as Error).message;
    }
  }

  return status;
}
