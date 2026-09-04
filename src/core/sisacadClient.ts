import { load } from "cheerio";
import {
  CHROME_USER_AGENT,
  EXTRANET_HOST,
  SISACAD_HORARIO_BASE,
} from "./config.js";
import { currentContext } from "./context.js";
import { SisacadAuthError, SisacadProtocolError, SessionExpiredError } from "./errors.js";
import { fetchUnsa, isUnsaUrl } from "./http.js";

const RETRY_DELAYS_MS = [800, 1600];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Base del login de matrícula para el semestre en curso. SISACAD versiona esa carpeta por
 * período (`matr_int_2026b_v2.00`), así que se lee del contexto en cada llamada —y no de una
 * constante de módulo— para que cambiar de semestre en caliente apunte al sistema correcto.
 */
function matriculaBase(): string {
  return currentContext().matriculaBase;
}

/**
 * Cliente HTTP del sistema de matrícula de la UNSA (SISACAD extranet): el que sirve los horarios.
 *
 * A diferencia del SISACAD de notas parciales (`domain/sisacad.ts`), este sistema NO tiene
 * CAPTCHA: el login es un POST de formulario PHP corriente y el horario se lee por GET con la
 * cookie PHPSESSID, así que no hace falta navegador.
 *
 * Es deliberadamente TONTO (igual que encuestaClient.ts): no decide nada; la lógica que puede
 * equivocarse vive en `domain/horario.ts`, que se prueba sin red.
 */

export interface SisacadCreds {
  /** Usuario de 8 letras (campo logi_oper). */
  user: string;
  /** Clave numérica de 8 dígitos (campo pass_oper). */
  password: string;
  /** Código de Escuela/Programa del select de login (p.ej. "4700" = ECONOMÍA). */
  escuela: string;
}

export interface SisacadSession {
  /** Valor de la cookie PHPSESSID. */
  phpsessid: string;
  /** CUI del usuario logueado (del abrir_academico del login). */
  cui: string;
  /** Nombre del alumno, tal cual lo manda el sistema. */
  name: string;
  /** Código de dependencia (depe) para la URL del horario (p.ej. "470"). */
  depe: string;
  /** Nombre de la escuela (p.ej. "ECONOMÍA"). */
  school: string;
  /** Especialidad (param espe de la URL del horario). */
  espe: string;
}

/** Recorta un cuerpo de respuesta para poder diagnosticar sin volcar KB en un error. */
function summarize(text: string, max = 300): string {
  const flat = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function extractPhpSessId(setCookie: string[]): string | null {
  for (const raw of setCookie) {
    const m = /PHPSESSID=([^;]+)/.exec(raw);
    if (m) return m[1];
  }
  return null;
}

function readSetCookie(res: Response): string[] {
  const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") return anyHeaders.getSetCookie();
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

async function request(
  url: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    cookie?: string;
  } = {},
): Promise<{ status: number; text: string; setCookie: string[] }> {
  // Cinturón: este cliente no debe salir del extranet ni por un error de edición.
  if (!isUnsaUrl(url, EXTRANET_HOST)) {
    throw new SisacadProtocolError(`URL fuera de ${EXTRANET_HOST}: ${url}`);
  }

  let res: Response | undefined;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    try {
      res = await fetchUnsa(
        url,
        {
          method: opts.method ?? "GET",
          headers: {
            "User-Agent": CHROME_USER_AGENT,
            Referer: matriculaBase(),
            ...(opts.headers ?? {}),
            ...(opts.cookie ? { Cookie: opts.cookie } : {}),
          },
          body: opts.body,
          // Este sistema redirige por JavaScript, nunca por HTTP. Con "manual" evitamos que
          // fetchUnsa interprete un redirect inesperado como SessionExpiredError (que habla de
          // Moodle y de `dutic login`, y aquí sólo despistaría).
          redirect: "manual",
        },
        30_000,
      );
      break;
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        throw new SisacadAuthError("La sesión de matrícula se perdió a mitad de la operación. Vuelve a intentarlo.");
      }
      // El servidor del extranet es viejo y a veces corta la conexión sin motivo: se reintenta.
      lastErr = err;
    }
  }
  if (!res) throw lastErr;

  // OJO con la codificación: la cabecera declara charset=iso-8859-1 pero los bytes SON UTF-8
  // (verificado byte a byte: "ECONOMÍA" llega como C3 8D). Decodificar como latin1 partiría los
  // acentos. Igual que en la encuesta, se decodifica explícitamente como UTF-8.
  const text = new TextDecoder("utf-8").decode(await res.arrayBuffer());
  return { status: res.status, text, setCookie: readSetCookie(res) };
}

/**
 * Inicia sesión en el sistema de matrícula. El éxito se detecta por el `<SCRIPT>` que emite
 * `abrir_academico('CUI',"NOMBRE",'COD0','NUES','ESCUELA','ESPE')`; el rechazo por el redirect
 * JavaScript `acad_login.php?mensaje=…` (el mensaje usa `~` como espacio y `<BR>` como salto).
 * De ahí salen también el CUI propio y el código de dependencia que exige el horario.
 */
export async function sisacadLogin(creds: SisacadCreds): Promise<SisacadSession> {
  const body =
    `logi_oper=${encodeURIComponent(creds.user)}` +
    `&pass_oper=${encodeURIComponent(creds.password)}` +
    `&escuela=${encodeURIComponent(creds.escuela)}`;

  const { text, setCookie } = await request(`${matriculaBase()}/acad_usuario.php`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  // Nunca se incluye la contraseña en el mensaje; sí un extracto del cuerpo para diagnosticar.
  const msg = /mensaje=([^&"')]+)/.exec(text);
  if (msg) {
    const readable = decodeURIComponent(msg[1])
      .replace(/<[^>]+>/g, ", ")
      .replace(/~/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    throw new SisacadAuthError(`El sistema de matrícula rechazó el login: ${readable}`);
  }

  const m = /abrir_academico\('(\d+)',"([^"]*)",'([^']*)','([^']*)','([^']*)','([^']*)'\)/.exec(text);
  if (!m) {
    throw new SisacadProtocolError(
      `El sistema de matrícula respondió algo inesperado al login. Respuesta: ${summarize(text)}`,
    );
  }

  const phpsessid = extractPhpSessId(setCookie);
  if (!phpsessid) {
    throw new SisacadProtocolError("Login aceptado pero sin cookie PHPSESSID.", summarize(text));
  }

  return { phpsessid, cui: m[1], name: m[2], depe: m[4], school: m[5], espe: m[6] };
}

const AUTH_REDIRECT_MSG =
  "El sistema de matrícula pidió volver a iniciar sesión. Revisa `dutic hrs login`.";

/** Las tres vistas del horario: personal, por asignatura y por aula. */
export type HorarioVista = "course" | "aula";

/** Comprueba el redirect JavaScript de sesión caducada y lo traduce a SisacadAuthError. */
function assertActiveSession(text: string): void {
  if (/acad_login\.php/.test(text)) {
    throw new SisacadAuthError(AUTH_REDIRECT_MSG);
  }
}

/** POST al formulario del horario (vistas por asignatura/aula) con la sesión activa. */
async function postHorario(
  session: SisacadSession,
  fields: Record<string, string>,
): Promise<string> {
  const body = Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const { text } = await request(`${SISACAD_HORARIO_BASE}/horario_datos.php3`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cookie: `PHPSESSID=${session.phpsessid}`,
  });
  assertActiveSession(text);
  return text;
}

/**
 * Descarga la página del horario de un CUI. El sistema no exige que el CUI sea el del propio
 * usuario: el menú mismo navega por GET cambiando `codi_usua`. Con la sesión caducada responde un
 * `<SCRIPT>top.location.href=…acad_login.php`, que aquí se traduce a SisacadAuthError.
 */
export async function fetchHorarioRaw(
  session: SisacadSession,
  cui: string,
  depe: string,
  espe = "0",
): Promise<string> {
  const url = `${SISACAD_HORARIO_BASE}/horario_datos.php3?codi_usua=${encodeURIComponent(cui)}&codi_depe=${encodeURIComponent(depe)}&espe=${encodeURIComponent(espe)}`;
  const { text } = await request(url, {
    cookie: `PHPSESSID=${session.phpsessid}`,
  });
  assertActiveSession(text);
  return text;
}

/**
 * Listado previo de una vista (sin seleccionar): para "course" la oferta del ciclo (todas las
 * secciones de cada asignatura) y para "aula" las aulas de la escuela. Lo parsea domain/horario.ts.
 */
export async function fetchCatalogRaw(
  session: SisacadSession,
  depe: string,
  vista: HorarioVista,
): Promise<string> {
  return postHorario(session, {
    codi_usua: session.cui,
    codi_depe: depe,
    tipo_hora: vista === "course" ? "3" : "2",
  });
}

/**
 * Descarga la grilla semanal de una asignatura-sección (`selector` = "2501209A") o de un aula
 * (`selector` = código interno de aula). El sistema no pide anno/cicl: usa el periodo vigente.
 */
export async function fetchScheduleRaw(
  session: SisacadSession,
  depe: string,
  vista: HorarioVista,
  selector: string,
): Promise<string> {
  return postHorario(session, {
    codi_usua: session.cui,
    codi_depe: depe,
    tipo_hora: vista === "course" ? "3" : "2",
    [vista === "course" ? "codi_asig_grup" : "codi_aula"]: selector,
  });
}

/**
 * Resuelve el código de Escuela/Programa del select de login. Acepta el código ("4700") tal cual
 * o el nombre ("ECONOMÍA", sin distinguir acentos) consultando las opciones reales de la página.
 */
export async function resolveEscuelaCode(input: string): Promise<string> {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;

  const { text } = await request(`${matriculaBase()}/acad_login.php`, {});
  const $ = load(text);
  const options: { code: string; name: string }[] = [];
  $('select[name="escuela"] option').each((_, el) => {
    const code = $(el).attr("value") ?? "";
    const name = $(el).text().trim();
    if (code) options.push({ code, name });
  });

  const norm = (s: string) =>
    s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const target = norm(trimmed);
  const hit = options.find((o) => norm(o.name) === target);
  if (!hit) {
    const available = options.map((o) => `${o.code} (${o.name})`).join(", ");
    throw new SisacadAuthError(
      `Escuela "${trimmed}" no reconocida. Códigos disponibles: ${available}`,
    );
  }
  return hit.code;
}