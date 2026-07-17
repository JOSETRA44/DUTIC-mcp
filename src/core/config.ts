import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Configuración central del cliente DUTIC.
 *
 * El aula virtual vive en https://aulavirtual.unsa.edu.pe/{SEMESTRE}/ donde SEMESTRE
 * (p.ej. "2026A") cambia cada período académico. Se toma de la variable de entorno
 * DUTIC_SEMESTER; si no existe, se usa un valor por defecto que también hay que
 * actualizar cada ciclo. Aun así, el siteUrl real se auto-deriva tras el login a partir
 * de la URL final del dashboard, por lo que el semestre efectivo se corrige solo.
 */

export const HOST = "aulavirtual.unsa.edu.pe";

/** UA de Chrome real: Google devuelve 403 a User-Agents genéricos de bot/WebView. */
export const CHROME_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Semestre por defecto — sobreescribible con DUTIC_SEMESTER. Actualizar cada período. */
export const DEFAULT_SEMESTER = "2026A";

export function getSemester(): string {
  return process.env.DUTIC_SEMESTER?.trim() || DEFAULT_SEMESTER;
}

/** URL base del sitio para el semestre configurado, ej. https://aulavirtual.unsa.edu.pe/2026A */
export function getSiteUrl(semester = getSemester()): string {
  return `https://${HOST}/${semester}`;
}

/** URL de login inicial (donde aparece el botón de Google OAuth). */
export function getLoginUrl(semester = getSemester()): string {
  return `${getSiteUrl(semester)}/login/index.php`;
}

// --- Rutas de estado local (fuera del repo, en el home del usuario) ---

export const DATA_DIR =
  process.env.DUTIC_DATA_DIR?.trim() || join(homedir(), ".dutic");

/** Perfil persistente del navegador Playwright: mantiene la sesión SSO de Google. */
export const BROWSER_PROFILE_DIR = join(DATA_DIR, "profile");

/** Sesión de Moodle serializada (cookie MoodleSession + sesskey + siteUrl). */
export const SESSION_FILE = join(DATA_DIR, "session.json");
