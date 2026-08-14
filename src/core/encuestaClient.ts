import { CHROME_USER_AGENT, ENCUESTA_BASE, EXTRANET_HOST } from "./config.js";
import { EncuestaAuthError, EncuestaProtocolError, SessionExpiredError } from "./errors.js";
import { fetchUnsa, isUnsaUrl } from "./http.js";
import type { EncuestaCreds, SurveyRef } from "./encuestaModels.js";

/**
 * Cliente HTTP del sistema de encuestas (extranet UNSA).
 *
 * Es deliberadamente TONTO: no decide nada, no valida respuestas ni elige alternativas. Sólo
 * transporta bytes. Toda la lógica que puede equivocarse vive en los módulos puros de
 * `domain/encuesta*.ts`, que se prueban sin red.
 *
 * A diferencia de SISACAD, este sistema NO tiene CAPTCHA: el login es un POST de formulario PHP
 * corriente, así que no hace falta navegador y el servidor MCP puede operarlo de principio a fin.
 */

export interface EncuestaSession {
  /** Valor de la cookie PHPSESSID. */
  phpsessid: string;
  startedAt: number;
}

type Script = "logueoEncuestado.php" | "listaEncEst.php" | "llenaEnc.php";

/** Recorta un cuerpo de respuesta para poder diagnosticar sin volcar 70 KB en un error. */
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

async function post(
  script: Script,
  body: string,
  session?: EncuestaSession,
): Promise<{ status: number; text: string; setCookie: string[] }> {
  const url = `${ENCUESTA_BASE}/php/${script}`;

  // Cinturón: este cliente no debe salir del extranet ni por un error de edición. Se comprueba
  // contra EXTRANET_HOST explícitamente, sin ampliar el host permitido de `dutic fetch`.
  if (!isUnsaUrl(url, EXTRANET_HOST)) {
    throw new EncuestaProtocolError(`URL fuera de ${EXTRANET_HOST}: ${url}`);
  }

  let res: Response;
  try {
    res = await fetchUnsa(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": CHROME_USER_AGENT,
          Referer: `${ENCUESTA_BASE}/form/menuAlumno.php`,
          ...(session ? { Cookie: `PHPSESSID=${session.phpsessid}` } : {}),
        },
        body,
        // Este sistema redirige por JavaScript, nunca por HTTP. Con "manual" evitamos que
        // fetchUnsa interprete un redirect inesperado como SessionExpiredError, cuyo mensaje
        // habla de Moodle y de `dutic login` y aquí sólo despistaría.
        redirect: "manual",
      },
      30_000,
    );
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      throw new EncuestaAuthError(
        "La sesión de la encuesta se perdió a mitad de la operación. Vuelve a intentarlo.",
      );
    }
    throw err;
  }

  // El cuerpo es UTF-8 de verdad (la cabecera charset=utf-8 es honesta; verificado byte a byte
  // sobre las respuestas reales), así que se decodifica explícitamente como tal.
  const text = new TextDecoder("utf-8").decode(await res.arrayBuffer());
  return { status: res.status, text, setCookie: readSetCookie(res) };
}

/**
 * Inicia sesión. El éxito NO llega como redirección HTTP sino como un `<script>location.href=…`
 * apuntando a menuAlumno.php, así que hay que detectarlo leyendo el cuerpo.
 */
export async function encuestaLogin(creds: EncuestaCreds): Promise<EncuestaSession> {
  const body =
    `txt_usuario=${encodeURIComponent(creds.user)}` +
    `&txt_password=${encodeURIComponent(creds.password)}` +
    `&logueo=Aceptar`;

  const { text, setCookie } = await post("logueoEncuestado.php", body);

  if (!/menuAlumno\.php/.test(text)) {
    // Nunca se incluye la contraseña en el mensaje; sí un extracto del cuerpo para diagnosticar.
    throw new EncuestaAuthError(
      `El sistema de encuestas rechazó el login. Respuesta: ${summarize(text)}`,
    );
  }

  const phpsessid = extractPhpSessId(setCookie);
  if (!phpsessid) {
    throw new EncuestaProtocolError("Login aceptado pero sin cookie PHPSESSID.", summarize(text));
  }
  return { phpsessid, startedAt: Date.now() };
}

/** Listado crudo de encuestas (incluye el debug SQL del servidor; lo limpia el parser). */
export async function fetchSurveyListRaw(session: EncuestaSession): Promise<string> {
  return (await post("listaEncEst.php", "opcion=1", session)).text;
}

/**
 * Cuestionario crudo de una encuesta. Se replica literalmente `opcion=3+` tal y como lo manda el
 * JS del sitio (ese `+` se decodifica como espacio); no se "arregla" para no arriesgar un cambio
 * de comportamiento en un backend de PHP 5.3.
 */
export async function fetchQuestionnaireRaw(
  session: EncuestaSession,
  ref: SurveyRef,
): Promise<string> {
  const body = `&opcion=3+&id_doc=${ref.idDoc}&id_asig=${ref.idAsig}&id_nues=${ref.idNues}`;
  return (await post("llenaEnc.php", body, session)).text;
}

/**
 * ENVÍA las respuestas. Recibe el cuerpo ya construido y validado por los módulos puros y lo manda
 * TAL CUAL: el `|` viaja sin codificar, igual que hacía jQuery.
 *
 * Esta función no valida nada a propósito — cuando se llega aquí la decisión ya está tomada y
 * comprobada. Tampoco reintenta: ver la nota sobre reintentos en domain/encuesta.ts.
 */
export async function postAnswersRaw(session: EncuestaSession, body: string): Promise<string> {
  return (await post("llenaEnc.php", body, session)).text;
}
