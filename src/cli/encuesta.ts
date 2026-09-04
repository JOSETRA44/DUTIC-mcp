import type { Command } from "commander";
import { createInterface } from "node:readline";
import {
  CONFIRM_PHRASE,
  encuestaStatus,
  fillSurveys,
  listSurveys,
  previewSurveys,
  verifyCredentials,
  type SurveySelector,
} from "../domain/encuesta.js";
import { loadOrInitConfig, saveCreds, saveEncuestaConfig } from "../core/encuestaStore.js";
import { EncuestaPolicySchema, type EncuestaPolicy } from "../core/encuestaModels.js";
import type { AnswerOverrides } from "../domain/encuestaPolicy.js";
import { banner, c, mark, parentOpts, rule, statusLine, table } from "./ui.js";

const out = (msg = "") => process.stdout.write(msg + "\n");
const log = (msg: string) => process.stderr.write(msg + "\n");

/**
 * Comandos de la encuesta de desempeño docente (`dutic encuesta`).
 *
 * El envío es IRREVERSIBLE y único por docente, así que la ergonomía está deliberadamente
 * sesgada: simular es lo fácil y lo que pasa por defecto; enviar exige dos banderas explícitas,
 * incómodas de teclear por costumbre o por autocompletado.
 */

const CONFIRM_FLAG = "--si-es-irreversible";

/** Lee una contraseña por stdin sin eco. Se cae con elegancia si no hay TTY. */
async function promptHidden(question: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    throw new Error(
      "No hay terminal interactiva para pedir la clave. Usa --clave, " +
        "o exporta DUTIC_ENCUESTA_USER y DUTIC_ENCUESTA_PASSWORD.",
    );
  }
  const rl = createInterface({ input, output: process.stderr, terminal: true });
  // El truco estándar: se intercepta la escritura del prompt para no reflejar lo tecleado.
  const rlAny = rl as unknown as { _writeToOutput?: (s: string) => void; output: NodeJS.WriteStream };
  let muted = false;
  rlAny._writeToOutput = (s: string) => {
    if (!muted) rlAny.output.write(s);
  };
  const answer = await new Promise<string>((resolve) => {
    rl.question(question, (a) => resolve(a));
    muted = true;
  });
  muted = false;
  rl.close();
  process.stderr.write("\n");
  return answer;
}

/** `--pregunta 4=Nunca` (repetible) → { "4": "Nunca" } */
function collectQuestion(value: string, previous: Record<string, string>): Record<string, string> {
  const eq = value.indexOf("=");
  if (eq < 1) {
    throw new Error(`Formato inválido en --pregunta: "${value}". Usa <pregunta>=<respuesta>, p.ej. 4=Nunca.`);
  }
  return { ...previous, [value.slice(0, eq).trim()]: value.slice(eq + 1).trim() };
}

function overridesFrom(opts: {
  escala?: string;
  calificacion?: string;
  pregunta?: Record<string, string>;
}): AnswerOverrides {
  const o: AnswerOverrides = {};
  if (opts.escala !== undefined) o.default = opts.escala;
  if (opts.calificacion !== undefined) o.score = Number(opts.calificacion);
  if (opts.pregunta && Object.keys(opts.pregunta).length > 0) o.byQuestion = opts.pregunta;
  return o;
}

function selectorFrom(target: string | undefined, todas: boolean): SurveySelector {
  if (todas) return { all: true };
  if (!target) {
    throw new Error("Indica un docente/curso (o `--todas` para todas las pendientes).");
  }
  return /^\d+-\d+-\d+$/.test(target) ? { key: target } : { query: target };
}

function renderPlanTable(item: Awaited<ReturnType<typeof previewSurveys>>[number]): void {
  const { ref, plan, questionnaire } = item;

  out();
  out(banner(ref.teacher || "Encuesta docente", `${ref.course}${ref.school ? ` · ${ref.school}` : ""}`));
  out(c.dim(`  key ${ref.key}  ·  ${questionnaire.questions.length} preguntas`));
  out();

  if (plan.answers.length > 0) {
    out(
      table(
        [
          { header: "preg", align: "right" },
          { header: "enunciado" },
          { header: "respuesta", color: c.cyan },
          { header: "alt", align: "right", color: c.dim },
          { header: "regla", color: c.gray },
        ],
        plan.answers.map((a) => [
          `p${a.index}`,
          a.text.length > 58 ? `${a.text.slice(0, 57)}…` : a.text,
          a.kind === "scale" ? (a.label ?? "") : `${a.value} / 20`,
          a.alternativeId ?? "—",
          a.rule,
        ]),
      ),
    );
  }

  for (const w of questionnaire.warnings) out(`${mark.warn()} ${w}`);

  if (!plan.complete) {
    out();
    out(`${mark.err()} ${c.boldRed("Plan incompleto — no se puede enviar:")}`);
    for (const issue of plan.issues) out(`    ${mark.bullet()} ${issue}`);
    return;
  }

  out();
  out(
    `${mark.info()} Media de escala: ${c.bold(String(plan.scaleAverage))} / 4` +
      `  ·  Calificación: ${c.bold(String(plan.score))} / 20`,
  );
  out(`${mark.info()} Cuerpo que se enviaría:`);
  out(c.dim(`    ${item.body}`));
}

export function registerEncuestaCommands(program: Command): void {
  const enc = program
    .command("encuesta")
    .description(
      "Encuesta de desempeño docente (extranet UNSA). Simula por defecto; enviar es irreversible.",
    );

  // --- estado (acción por defecto) ---

  const showStatus = async (opts: { json?: boolean; offline?: boolean }, cmd?: unknown) => {
    const parent = parentOpts(cmd);
    opts = {
      json: opts.json ?? (parent.json as boolean | undefined),
      offline: opts.offline ?? (parent.offline as boolean | undefined),
    };
    const status = await encuestaStatus({ online: !opts.offline });
    if (opts.json) {
      out(JSON.stringify(status, null, 2));
      return;
    }

    out(banner("Encuesta de desempeño docente"));
    out(
      `${status.hasCredentials ? mark.ok() : mark.err()} Credenciales: ` +
        (status.hasCredentials ? "guardadas" : `no configuradas — corre ${c.cyan("dutic encuesta login")}`),
    );
    out(
      `${status.policyConfigured ? mark.ok() : mark.warn()} Política: ` +
        (status.policyConfigured
          ? `por defecto ${c.cyan(String(status.policy.default))}, calificación ${c.cyan(String(status.policy.score))}`
          : `sin configurar — corre ${c.cyan("dutic encuesta policy set")}`),
    );
    out(c.dim(`    config: ${status.configPath}`));

    if (status.onlineError) {
      out(`${mark.warn()} No se pudo consultar el sistema: ${status.onlineError}`);
    } else if (status.hasCredentials && !opts.offline) {
      out(`${mark.info()} Pendientes: ${c.boldYellow(String(status.pending))}  ·  Llenadas: ${status.done}`);
    }

    if (status.ledger.length > 0) {
      out();
      out(rule("envíos registrados"));
      out(
        table(
          [{ header: "docente" }, { header: "resultado" }, { header: "fecha", color: c.dim }],
          status.ledger.map((e) => [e.teacher, e.outcome, e.submittedAt.replace("T", " ").slice(0, 16)]),
        ),
      );
    }
  };

  enc
    .option("--json", "Salida en JSON.")
    .option("--offline", "No consultar el sistema; sólo el estado local.")
    .action(showStatus);

  enc
    .command("status")
    .description("Estado: credenciales, política, pendientes y envíos ya registrados.")
    .option("--json", "Salida en JSON.")
    .option("--offline", "No consultar el sistema; sólo el estado local.")
    .action(showStatus);

  // --- credenciales ---

  enc
    .command("login")
    .description("Guarda y verifica tus credenciales de la encuesta (usuario y clave de matrícula).")
    .option("--usuario <usuario>", "Código de usuario.")
    .option("--clave <clave>", "Clave. Si se omite, se pide por teclado sin eco (recomendado).")
    .action(async (opts) => {
      const user = opts.usuario ?? (await promptHidden("Usuario: "));
      const password = opts.clave ?? (await promptHidden("Clave (no se mostrará): "));
      if (!user || !password) {
        out(`${mark.err()} Usuario y clave son obligatorios.`);
        process.exitCode = 1;
        return;
      }

      await saveCreds({ user, password });
      const status = statusLine();
      status.set("verificando credenciales…");
      try {
        await verifyCredentials();
        status.done();
        out(`${mark.ok()} Credenciales verificadas y guardadas con permisos restringidos.`);
        out(c.dim("    Siguiente paso: dutic encuesta policy set --escala Siempre --calificacion 18"));
      } catch (err) {
        status.done();
        out(`${mark.err()} ${(err as Error).message}`);
        out(c.dim("    Se guardaron de todos modos; corrígelas con `dutic encuesta login`."));
        process.exitCode = 1;
      }
    });

  // --- listado ---

  enc
    .command("list")
    .description("Lista tus encuestas: pendientes y ya llenadas.")
    .option("--json", "Salida en JSON.")
    .action(async (opts, cmd) => {
      const status = statusLine();
      status.set("consultando encuestas…");
      const listing = await listSurveys();
      status.done();

      if (opts.json || parentOpts(cmd).json) {

        out(JSON.stringify(listing, null, 2));

        return;

      }

      out(banner("Encuestas", `${listing.pending.length} pendiente(s) · ${listing.done.length} llenada(s)`));
      if (listing.surveys.length === 0) {
        out(`${mark.info()} No hay encuestas abiertas ahora mismo.`);
        return;
      }
      out(
        table(
          [
            { header: "estado" },
            { header: "docente" },
            { header: "curso" },
            { header: "key", color: c.dim },
          ],
          listing.surveys.map((s) => [
            s.status === "pending" ? `${mark.pending()} por llenar` : `${mark.done()} llenada`,
            s.teacher,
            s.course,
            s.status === "pending" ? s.key : "—",
          ]),
        ),
      );
    });

  // --- ver un cuestionario y su plan ---

  enc
    .command("show <docente>")
    .description("Muestra el cuestionario de un docente y las respuestas que se aplicarían. No envía.")
    .option("--escala <valor>", "Respuesta para todas las preguntas: Nunca|A veces|Usualmente|Siempre o 1-4.")
    .option("--calificacion <0-20>", "Calificación general.")
    .option("--pregunta <n=valor>", "Override puntual, repetible (p.ej. --pregunta 4=Nunca).", collectQuestion, {})
    .option("--json", "Salida en JSON.")
    .action(async (docente, opts, cmd) => {
      const status = statusLine();
      status.set("cargando cuestionario…");
      const items = await previewSurveys(selectorFrom(docente, false), {
        answers: overridesFrom(opts),
      });
      status.done();

      if (items.length === 0) {
        out(`${mark.warn()} Ninguna encuesta pendiente casa con "${docente}".`);
        return;
      }
      if (opts.json || parentOpts(cmd).json) {
        out(JSON.stringify(items, null, 2));
        return;
      }
      for (const item of items) renderPlanTable(item);
    });

  // --- política ---

  const policyCmd = enc
    .command("policy")
    .description("Ver o editar la política de respuestas guardada.");

  policyCmd
    .option("--json", "Salida en JSON.")
    .action(async (opts, cmd) => {
      const cfg = await loadOrInitConfig();
      if (opts.json || parentOpts(cmd).json) {
        out(JSON.stringify(cfg.policy, null, 2));
        return;
      }
      out(banner("Política de respuestas"));
      out(JSON.stringify(cfg.policy, null, 2));
      out();
      out(c.dim("Edítala a mano o con `dutic encuesta policy set`. Precedencia:"));
      out(c.dim("  pregunta del docente > pregunta del curso > pregunta global >"));
      out(c.dim("  docente > curso > global"));
    });

  policyCmd
    .command("set")
    .description("Fija valores de la política. Sin --docente/--curso escribe en el ámbito global.")
    .option("--escala <valor>", "Respuesta por defecto: Nunca|A veces|Usualmente|Siempre o 1-4.")
    .option("--calificacion <0-20>", "Calificación general por defecto.")
    .option("--docente <texto>", "Aplica sólo a los docentes cuyo nombre contenga este texto.")
    .option("--curso <texto>", "Aplica sólo a los cursos cuyo nombre contenga este texto.")
    .option("--pregunta <n=valor>", "Override por pregunta, repetible.", collectQuestion, {})
    .action(async (opts) => {
      const cfg = await loadOrInitConfig();
      const policy: EncuestaPolicy = structuredClone(cfg.policy);

      const scope = (() => {
        if (opts.docente) {
          policy.byTeacher ??= {};
          policy.byTeacher[opts.docente] ??= {};
          return policy.byTeacher[opts.docente];
        }
        if (opts.curso) {
          policy.byCourse ??= {};
          policy.byCourse[opts.curso] ??= {};
          return policy.byCourse[opts.curso];
        }
        return policy;
      })();

      if (opts.escala !== undefined) scope.default = opts.escala;
      if (opts.calificacion !== undefined) scope.score = Number(opts.calificacion);
      if (Object.keys(opts.pregunta ?? {}).length > 0) {
        scope.byQuestion = { ...(scope.byQuestion ?? {}), ...opts.pregunta };
      }

      // Se valida antes de escribir: mejor rechazar aquí que descubrirlo al ir a enviar.
      const parsed = EncuestaPolicySchema.parse(policy);
      await saveEncuestaConfig({ ...cfg, policy: parsed, savedAt: Date.now() });

      out(`${mark.ok()} Política actualizada.`);
      out(JSON.stringify(parsed, null, 2));
    });

  // --- llenar ---

  enc
    .command("fill [docente]")
    .description(
      "Rellena encuestas. SIMULA por defecto: para enviar de verdad hacen falta --enviar y " +
        CONFIRM_FLAG +
        ".",
    )
    .option("--todas", "Todas las encuestas pendientes.")
    .option("--escala <valor>", "Respuesta para todas las preguntas de esta tanda.")
    .option("--calificacion <0-20>", "Calificación general de esta tanda.")
    .option("--pregunta <n=valor>", "Override puntual, repetible.", collectQuestion, {})
    .option("--enviar", "Envía de verdad (IRREVERSIBLE). Requiere también " + CONFIRM_FLAG + ".")
    .option(CONFIRM_FLAG, "Confirma que entiendes que el envío no se puede deshacer.")
    .option("--seguir-si-falla", "No detener el lote si el servidor rechaza una encuesta.")
    .option("--json", "Salida en JSON.")
    .action(async (docente, opts, cmd) => {
      const selector = selectorFrom(docente, Boolean(opts.todas));
      const answers = overridesFrom(opts);

      // Enviar exige las DOS banderas. Con una sola se explica qué falta y no se envía nada.
      const wantsSend = Boolean(opts.enviar);
      const confirmed = Boolean(opts.siEsIrreversible);
      if (wantsSend && !confirmed) {
        out(`${mark.err()} ${c.boldRed("Falta la confirmación.")}`);
        out(`    El envío es irreversible y sólo se puede hacer una vez por docente.`);
        out(`    Añade ${c.cyan(CONFIRM_FLAG)} si de verdad quieres enviarlo.`);
        process.exitCode = 1;
        return;
      }

      if (!wantsSend) {
        // Simulación: se muestra el plan completo y no se toca la red de escritura.
        const status = statusLine();
        status.set("cargando cuestionarios…");
        const items = await previewSurveys(selector, { answers });
        status.done();

        if (items.length === 0) {
          out(`${mark.warn()} No hay encuestas pendientes que casen con la selección.`);
          return;
        }
        if (opts.json || parentOpts(cmd).json) {
          out(JSON.stringify(items, null, 2));
          return;
        }

        for (const item of items) renderPlanTable(item);

        const listas = items.filter((i) => i.plan.complete).length;
        out();
        out(rule());
        out(`${mark.warn()} ${c.boldYellow("SIMULACIÓN")} — no se envió nada.`);
        out(`    ${listas} de ${items.length} encuesta(s) están listas para enviar.`);
        if (listas > 0) {
          const target = "all" in selector ? "--todas" : (docente ?? "");
          out(`    Para enviarlas de verdad: ${c.cyan(`dutic encuesta fill ${target} --enviar ${CONFIRM_FLAG}`)}`);
        }
        return;
      }

      const report = await fillSurveys(selector, {
        apply: true,
        confirm: CONFIRM_PHRASE,
        answers,
        continueOnError: Boolean(opts.seguirSiFalla),
        onStatus: log,
      });

      if (opts.json || parentOpts(cmd).json) {

        out(JSON.stringify(report, null, 2));

        return;

      }

      out();
      out(banner("Envío de encuestas"));
      for (const r of report.submitted) {
        const icon = r.outcome === "ok" ? mark.ok() : mark.err();
        out(`${icon} ${r.teacher} — ${r.outcome === "ok" ? "enviada" : r.message}`);
      }
      for (const s of report.skipped) {
        if (s.reason === "filtered") continue;
        out(`${mark.bullet()} ${s.teacher} — omitida (${s.reason})`);
      }
      for (const f of report.failed) {
        out(`${mark.err()} ${f.teacher} — ${f.error}`);
      }
      const ok = report.submitted.filter((r) => r.outcome === "ok").length;
      out();
      out(`${mark.info()} ${ok} encuesta(s) enviadas correctamente.`);
      if (report.failed.length > 0 || report.submitted.some((r) => r.outcome !== "ok")) {
        process.exitCode = 1;
      }
    });
}
