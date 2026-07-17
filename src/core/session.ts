import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { z } from "zod";
import { DATA_DIR, SESSION_FILE } from "./config.js";

/**
 * Sesión de Moodle capturada tras el login. Los dos artefactos que importan son:
 *  - moodleSession: valor de la cookie MoodleSession (autenticación).
 *  - sesskey: token CSRF que Moodle exige en cada llamada AJAX.
 * siteUrl se auto-deriva del dashboard (incluye el semestre real).
 */
export const SessionSchema = z.object({
  moodleSession: z.string().min(1),
  sesskey: z.string().min(1),
  siteUrl: z.string().url(),
  /** epoch ms del momento de captura. */
  capturedAt: z.number(),
});
export type Session = z.infer<typeof SessionSchema>;

/**
 * TTL sólo informativo (para `status` y para decidir un refresco proactivo). NO se usa como
 * puerta dura: las sesiones de Moodle de la UNSA duran más de lo que sugiere este valor, así
 * que la autoridad real es el servidor — si responde requireloginerror, renovamos. Gatear por
 * tiempo provocaba re-logins prematuros con la sesión aún viva.
 */
const SESSION_TTL_MS = 10 * 60 * 60 * 1000;

export function isExpired(session: Session): boolean {
  return Date.now() - session.capturedAt >= SESSION_TTL_MS;
}

/**
 * Una sesión es "usable" si tiene cookie y sesskey. No se descarta por antigüedad: se intenta
 * usar y, si el servidor la rechaza, el cliente renueva. Así se reutiliza al máximo la sesión
 * viva y se evita abrir el navegador sin necesidad.
 */
export function isValid(session: Session | null): session is Session {
  return (
    session !== null &&
    session.moodleSession.length > 0 &&
    session.sesskey.length > 0
  );
}

export async function saveSession(session: Session): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SESSION_FILE, JSON.stringify(session, null, 2), "utf8");
  // Permisos restrictivos (best-effort; en Windows es no-op práctico).
  try {
    await chmod(SESSION_FILE, 0o600);
  } catch {
    /* ignorar en plataformas sin permisos POSIX */
  }
}

export async function loadSession(): Promise<Session | null> {
  try {
    const raw = await readFile(SESSION_FILE, "utf8");
    return SessionSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Deriva el siteUrl (con semestre) recortando la URL del dashboard en "/my". */
export function deriveSiteUrl(dashboardUrl: string, fallbackOrigin: string): string {
  const idx = dashboardUrl.indexOf("/my");
  if (idx > 0) return dashboardUrl.slice(0, idx);
  return fallbackOrigin;
}
