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

// --- Encuesta de desempeño docente (extranet) ---

/**
 * La encuesta de evaluación docente vive en el extranet, un sistema SEPARADO del aula virtual y
 * también de SISACAD: PHP 5.3 sobre HTTP plano, sesión por cookie PHPSESSID y —a diferencia de
 * SISACAD— SIN CAPTCHA, así que todo el flujo se puede hacer por HTTP sin navegador.
 * Sus respuestas llegan en latin1 aunque la cabecera declare utf-8; ver core/encuestaClient.ts.
 */
export const EXTRANET_HOST = "extranet.unsa.edu.pe";
export const ENCUESTA_BASE = `http://${EXTRANET_HOST}/encuesta2`;

// --- Sistema de matrícula (SISACAD extranet: horarios) ---

/**
 * El login de matrícula vive en una ruta que cambia cada período (`matr_int_2026b_v2.00`),
 * mientras que el horario (`/sisacad/horario/`) no. La ruta se sobreescribe con
 * DUTIC_MATRICULA_PATH cuando cambie el ciclo.
 */
export const SISACAD_MATRICULA_BASE = `http://${EXTRANET_HOST}/sisacad/${
  process.env.DUTIC_MATRICULA_PATH?.trim() || "matr_int_2026b_v2.00"
}`;

/** Página del horario (a la que el menú llega por GET). */
export const SISACAD_HORARIO_BASE = `http://${EXTRANET_HOST}/sisacad/horario`;

/** Credenciales + política de respuestas de la encuesta (chmod 600, como session.json). */
export const ENCUESTA_FILE = join(DATA_DIR, "encuesta.json");

/**
 * Registro append-only de envíos. Va en un archivo aparte de la configuración a propósito: el
 * sistema no devuelve ningún comprobante de lo enviado, así que este log es la única prueba, y
 * no debe poder perderse porque falle una escritura de la política.
 */
export const ENCUESTA_LEDGER_FILE = join(DATA_DIR, "encuesta-log.json");

/** Credenciales del sistema de matrícula (usuario, clave, escuela) — chmod 600. */
export const SISACAD_LOGIN_FILE = join(DATA_DIR, "sisacad-login.json");

/** Último horario descargado (para `dutic hrs show` sin red). */
export const HORARIO_CACHE_FILE = join(DATA_DIR, "horario.json");
