/**
 * Constantes de los sistemas de la UNSA. Todo lo que depende del SEMESTRE se mudó a
 * `core/semester.ts` (qué es un semestre), `core/registry.ts` (cuáles conoce esta instalación) y
 * `core/context.ts` (en cuál estamos ahora); este archivo se queda con lo que es igual siempre.
 *
 * El aula virtual monta un Moodle independiente por período en https://HOST/{SEMESTRE}/, así que
 * el semestre no es un filtro de consulta sino una frontera de aislamiento: sesión, cursos, notas
 * y caché son distintos en cada uno. Ver `core/context.ts`.
 */

export const HOST = "aulavirtual.unsa.edu.pe";

/** UA de Chrome real: Google devuelve 403 a User-Agents genéricos de bot/WebView. */
export const CHROME_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// --- Encuesta de desempeño docente (extranet) ---

/**
 * La encuesta de evaluación docente vive en el extranet, un sistema SEPARADO del aula virtual y
 * también de SISACAD: PHP 5.3 sobre HTTP plano, sesión por cookie PHPSESSID y —a diferencia de
 * SISACAD— SIN CAPTCHA, así que todo el flujo se puede hacer por HTTP sin navegador.
 * Sus respuestas llegan en latin1 aunque la cabecera declare utf-8; ver core/encuestaClient.ts.
 */
export const EXTRANET_HOST = "extranet.unsa.edu.pe";
export const ENCUESTA_BASE = `http://${EXTRANET_HOST}/encuesta2`;

/**
 * Página del horario de SISACAD. A diferencia del login de matrícula —cuya carpeta se versiona
 * por período y por eso la deriva el contexto (`ctx.matriculaBase`)— esta ruta no cambia de ciclo.
 */
export const SISACAD_HORARIO_BASE = `http://${EXTRANET_HOST}/sisacad/horario`;

// --- Rutas de estado local ---
// Se re-exportan desde `core/paths.ts`, que define el layout completo (global vs. por semestre).
export {
  DATA_DIR,
  BROWSER_PROFILE_DIR,
  ENCUESTA_FILE,
  ENCUESTA_LEDGER_FILE,
  SISACAD_LOGIN_FILE,
} from "./paths.js";
