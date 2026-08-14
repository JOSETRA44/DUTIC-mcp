import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { DATA_DIR, ENCUESTA_FILE, ENCUESTA_LEDGER_FILE } from "./config.js";
import {
  EncuestaConfigSchema,
  type EncuestaConfig,
  type EncuestaCreds,
  type EncuestaPolicy,
  type SubmitResult,
} from "./encuestaModels.js";

/**
 * Estado local de la encuesta docente, en dos archivos separados a propósito:
 *
 *  - `encuesta.json`      credenciales + política de respuestas (chmod 600).
 *  - `encuesta-log.json`  registro append-only de envíos.
 *
 * Van separados porque el sistema de encuestas NO devuelve ningún comprobante de lo enviado: ese
 * log es la única prueba de qué se mandó y cuándo, así que no debe poder perderse porque falle una
 * reescritura de la política. Además el log no contiene secretos y el otro sí.
 */

// --- Configuración (credenciales + política) ---

export async function saveEncuestaConfig(cfg: EncuestaConfig): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(ENCUESTA_FILE, JSON.stringify(cfg, null, 2), "utf8");
  // Permisos restrictivos (best-effort; en Windows es no-op práctico), igual que session.json.
  try {
    await chmod(ENCUESTA_FILE, 0o600);
  } catch {
    /* ignorar en plataformas sin permisos POSIX */
  }
}

export async function loadEncuestaConfig(): Promise<EncuestaConfig | null> {
  try {
    const raw = await readFile(ENCUESTA_FILE, "utf8");
    return EncuestaConfigSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Config existente, o una vacía y válida si aún no hay archivo (para poder editarla parcialmente). */
export async function loadOrInitConfig(): Promise<EncuestaConfig> {
  return (await loadEncuestaConfig()) ?? EncuestaConfigSchema.parse({ policy: {} });
}

export async function saveCreds(creds: EncuestaCreds): Promise<void> {
  const cfg = await loadOrInitConfig();
  await saveEncuestaConfig({ ...cfg, credentials: creds, savedAt: Date.now() });
}

export async function savePolicy(policy: EncuestaPolicy): Promise<void> {
  const cfg = await loadOrInitConfig();
  await saveEncuestaConfig({ ...cfg, policy, savedAt: Date.now() });
}

/**
 * Credenciales efectivas. Las variables de entorno tienen prioridad sobre el archivo para poder
 * usar la herramienta en entornos donde no se quiera dejar la clave en disco.
 */
export async function resolveCreds(): Promise<EncuestaCreds | null> {
  const user = process.env.DUTIC_ENCUESTA_USER?.trim();
  const password = process.env.DUTIC_ENCUESTA_PASSWORD;
  if (user && password) return { user, password };
  const cfg = await loadEncuestaConfig();
  return cfg?.credentials ?? null;
}

/** Política efectiva (vacía si no hay nada configurado). */
export async function resolvePolicy(): Promise<EncuestaPolicy> {
  const cfg = await loadEncuestaConfig();
  return cfg?.policy ?? {};
}

// --- Ledger de envíos ---

export async function loadLedger(): Promise<SubmitResult[]> {
  try {
    const raw = await readFile(ENCUESTA_LEDGER_FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SubmitResult[]) : [];
  } catch {
    return [];
  }
}

/**
 * Añade una entrada al registro. Se llama SIEMPRE tras un intento de envío —también cuando el
 * servidor rechaza o responde algo irreconocible—, porque el caso peligroso es justo ese: si no
 * sabemos si el envío llegó, tiene que quedar constancia para que nadie lo reintente a ciegas.
 */
export async function appendLedger(entry: SubmitResult): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const all = await loadLedger();
  all.push(entry);
  await writeFile(ENCUESTA_LEDGER_FILE, JSON.stringify(all, null, 2), "utf8");
}

/** Último intento registrado para una encuesta, si lo hay. */
export async function findLedgerEntry(key: string): Promise<SubmitResult | undefined> {
  const all = await loadLedger();
  return all.filter((e) => e.key === key).at(-1);
}

/** true si esa encuesta ya se envió con éxito desde esta máquina. */
export async function alreadySubmitted(key: string): Promise<boolean> {
  const all = await loadLedger();
  return all.some((e) => e.key === key && e.outcome === "ok");
}
