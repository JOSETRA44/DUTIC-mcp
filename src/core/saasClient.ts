import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";
import { APP_VERSION } from "./version.js";

/**
 * Cliente del piloto de notificaciones (SaaS). Sólo habla con dos Edge Functions
 * (`enroll`, `ingest`): nunca toca las tablas directamente ni envía MoodleSession/sesskey
 * — sólo el diff que ya calculó `domain/watch.ts` localmente. Usa el anon key, que es
 * público por diseño: las tablas no conceden nada a anon/authenticated y sólo las Edge
 * Functions (con service_role) leen y escriben.
 */

const SAAS_SUPABASE_URL = "https://udihgiwdddrtoqdwopcb.supabase.co";
const SAAS_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVkaWhnaXdkZGRydG9xZHdvcGNiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0Mjg5MDUsImV4cCI6MjEwMTAwNDkwNX0.ZmyvTVZm0mzywDjp3EhCUpzVkJgEmkmKd9JVSXvCFkE";

const SAAS_FILE = join(DATA_DIR, "saas.json");

export interface SaasEnrollment {
  enrollToken: string;
  /** Código para escribirle al bot; null cuando ya no hace falta (cuenta vinculada). */
  linkCode: string | null;
  unsaUserId: number;
  /**
   * `reenroll_pending`: la cuenta ya estaba vinculada desde otro equipo. El token de este
   * equipo sólo se activa cuando el código llega desde el WhatsApp ya vinculado.
   */
  status: "pending_link" | "active" | "paused" | "reenroll_pending";
  enrolledAt: string;
}

export async function loadSaasEnrollment(): Promise<SaasEnrollment | null> {
  try {
    return JSON.parse(await readFile(SAAS_FILE, "utf8")) as SaasEnrollment;
  } catch {
    return null;
  }
}

async function saveSaasEnrollment(enrollment: SaasEnrollment): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SAAS_FILE, JSON.stringify(enrollment, null, 2), { encoding: "utf8", mode: 0o600 });
}

/** Errores del servidor traducidos a algo que el estudiante pueda hacer. */
const FRIENDLY_ERRORS: Record<string, string> = {
  reenroll_pending:
    "Este equipo aún no está confirmado. Envía el código de `dutic saas enroll` desde tu WhatsApp ya vinculado.",
  rate_limited: "Demasiados envíos seguidos. Se reintentará en la próxima pasada.",
  invalid_enroll_token: "Tu inscripción ya no es válida. Corre `dutic saas enroll` de nuevo.",
  student_paused: "Tu inscripción está en pausa. Consulta con el operador del piloto.",
  too_many_reenroll_requests: "Ya hay varias reinscripciones pendientes para esta cuenta. Espera una hora.",
};

async function callFunction(
  name: "enroll" | "ingest",
  body: unknown,
): Promise<Record<string, any>> {
  const res = await fetch(`${SAAS_SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SAAS_ANON_KEY,
      Authorization: `Bearer ${SAAS_ANON_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) {
    const code = typeof data?.error === "string" ? data.error : `HTTP ${res.status}`;
    throw new Error(data?.detail ?? FRIENDLY_ERRORS[code] ?? code);
  }
  return data;
}

/**
 * Registra al estudiante, o confirma la inscripción que ya tiene este equipo.
 *
 * Si hay un token guardado para ESTA cuenta se envía como prueba: el servidor ya no
 * devuelve tokens existentes a quien sólo conoce el unsaUserId.
 */
export async function enrollStudent(unsaUserId: number, fullName: string): Promise<SaasEnrollment> {
  const previous = await loadSaasEnrollment();
  const knownToken = previous?.unsaUserId === unsaUserId ? previous.enrollToken : undefined;

  const data = await callFunction("enroll", {
    unsaUserId,
    fullName,
    clientVersion: APP_VERSION,
    enrollToken: knownToken,
  });

  // El servidor sólo manda un token cuando emite uno nuevo; si confirmó el nuestro, se conserva.
  const enrollToken: string | undefined = data.enrollToken ?? knownToken;
  if (!enrollToken) throw new Error("El servidor no devolvió un token de inscripción.");

  const enrollment: SaasEnrollment = {
    enrollToken,
    linkCode: data.linkCode ?? null,
    unsaUserId,
    status: data.status,
    enrolledAt: data.enrollToken ? new Date().toISOString() : (previous?.enrolledAt ?? new Date().toISOString()),
  };
  await saveSaasEnrollment(enrollment);
  return enrollment;
}

/** Envía el diff (Changes) y la foto (Snapshot) que ya calculó `checkChanges` localmente. */
export async function pushChanges(
  enrollToken: string,
  snapshot: unknown,
  changes: unknown,
): Promise<{ ok: boolean; notificationsQueued: number }> {
  const data = await callFunction("ingest", { enrollToken, snapshot, changes, clientVersion: APP_VERSION });
  return { ok: Boolean(data.ok), notificationsQueued: Number(data.notificationsQueued ?? 0) };
}

/**
 * Encola un aviso del propio sistema (no una novedad de Moodle). Sirve para el caso en
 * que la automatización queda ciega: si el SSO de Google muere, la renovación headless
 * no puede hacer nada y el estudiante dejaría de recibir avisos SIN ENTERARSE. Como el
 * enrollToken vive en disco y no requiere sesión de Moodle, podemos avisarle por el
 * mismo WhatsApp que ya usa, pidiéndole que corra `dutic login`.
 *
 * No lleva texto: el mensaje lo fija el dispatcher según `kind`, para que este canal no
 * pueda usarse para escribirle cualquier cosa a nadie.
 */
export async function pushNotice(
  enrollToken: string,
  kind: string,
): Promise<{ ok: boolean; notificationsQueued: number }> {
  const data = await callFunction("ingest", { enrollToken, notice: { kind }, clientVersion: APP_VERSION });
  return { ok: Boolean(data.ok), notificationsQueued: Number(data.notificationsQueued ?? 0) };
}
