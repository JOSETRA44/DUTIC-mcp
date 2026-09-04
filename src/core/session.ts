import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { z } from "zod";
import { currentContext, type SemesterContext } from "./context.js";

/**
 * Sesión de Moodle capturada tras el login. Los dos artefactos que importan son:
 *  - moodleSession: valor de la cookie MoodleSession (autenticación).
 *  - sesskey: token CSRF que Moodle exige en cada llamada AJAX.
 * siteUrl se auto-deriva del dashboard (incluye el semestre real).
 *
 * Hay UNA sesión por semestre, en `~/.dutic/semesters/<ID>/session.json`: cada período es un
 * Moodle distinto, con su propia cookie y su propio sesskey. Guardarlas en un único archivo
 * —como antes— hacía que entrar a 2026B invalidara silenciosamente el acceso a 2026A.
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

/** Guarda la sesión en el directorio del semestre indicado (por defecto, el del contexto). */
export async function saveSession(
  session: Session,
  ctx: SemesterContext = currentContext(),
): Promise<void> {
  await mkdir(ctx.paths.dir, { recursive: true });
  await writeFile(ctx.paths.session, JSON.stringify(session, null, 2), "utf8");
  // Permisos restrictivos (best-effort; en Windows es no-op práctico).
  try {
    await chmod(ctx.paths.session, 0o600);
  } catch {
    /* ignorar en plataformas sin permisos POSIX */
  }
}

export async function loadSession(
  ctx: SemesterContext = currentContext(),
): Promise<Session | null> {
  try {
    const raw = await readFile(ctx.paths.session, "utf8");
    const session = SessionSchema.parse(JSON.parse(raw));
    // Cinturón contra un archivo colocado en el directorio equivocado (copia manual, restore de
    // backup): una sesión cuyo siteUrl apunta a otro período no sirve para éste y usarla daría
    // datos del semestre ajeno sin ningún aviso.
    if (!session.siteUrl.includes(`/${ctx.id}`)) return null;
    return session;
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
