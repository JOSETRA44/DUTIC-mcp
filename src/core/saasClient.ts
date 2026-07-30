import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";

/**
 * Cliente para el proyecto Supabase del piloto de notificaciones (SaaS), separado del
 * proyecto usado por `core/supabase.ts` para el registro de usuarios/cursos. Sólo habla
 * con dos Edge Functions (`enroll`, `ingest`): nunca toca las tablas directamente ni
 * envía MoodleSession/sesskey — sólo el diff que ya calculó `domain/watch.ts`
 * localmente. Usa el anon key (seguro: las tablas no tienen políticas RLS para
 * anon/authenticated, sólo las Edge Functions con service_role pueden leer/escribir).
 */

const SAAS_SUPABASE_URL = "https://udihgiwdddrtoqdwopcb.supabase.co";
const SAAS_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVkaWhnaXdkZGRydG9xZHdvcGNiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0Mjg5MDUsImV4cCI6MjEwMTAwNDkwNX0.ZmyvTVZm0mzywDjp3EhCUpzVkJgEmkmKd9JVSXvCFkE";

const SAAS_FILE = join(DATA_DIR, "saas.json");

export interface SaasEnrollment {
  enrollToken: string;
  linkCode: string;
  unsaUserId: number;
  status: "pending_link" | "active" | "paused";
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
  await writeFile(SAAS_FILE, JSON.stringify(enrollment, null, 2), "utf8");
}

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
    const msg = data?.error ? `${data.error}${data.detail ? `: ${data.detail}` : ""}` : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

/** Registra al estudiante (idempotente: si ya existe, devuelve su token existente). */
export async function enrollStudent(unsaUserId: number, fullName: string): Promise<SaasEnrollment> {
  const data = await callFunction("enroll", { unsaUserId, fullName });
  const enrollment: SaasEnrollment = {
    enrollToken: data.enrollToken,
    linkCode: data.linkCode,
    unsaUserId,
    status: data.status,
    enrolledAt: new Date().toISOString(),
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
  const data = await callFunction("ingest", { enrollToken, snapshot, changes });
  return { ok: Boolean(data.ok), notificationsQueued: Number(data.notificationsQueued ?? 0) };
}
