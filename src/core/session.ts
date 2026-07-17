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

/** TTL conservador: Moodle expira ~8h; marcamos caducada a las 6h para renovar con margen. */
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

export function isExpired(session: Session): boolean {
  return Date.now() - session.capturedAt >= SESSION_TTL_MS;
}

export function isValid(session: Session | null): session is Session {
  return (
    session !== null &&
    session.moodleSession.length > 0 &&
    session.sesskey.length > 0 &&
    !isExpired(session)
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
