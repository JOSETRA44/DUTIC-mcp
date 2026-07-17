import { CHROME_USER_AGENT } from "./config.js";
import { MoodleApiError, NetworkError, SessionExpiredError } from "./errors.js";
import { unsaAgent } from "./http.js";
import type { Session } from "./session.js";

/** Backoff entre reintentos para errores de red transitorios. */
const RETRY_DELAYS_MS = [800, 1600];
const REQUEST_TIMEOUT_MS = 20_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface AjaxCall {
  methodname: string;
  args: Record<string, unknown>;
}

/**
 * Ejecuta una o varias llamadas contra el endpoint AJAX interno de Moodle
 * ({siteUrl}/lib/ajax/service.php?sesskey=...). Reproduce exactamente la petición que hace
 * el navegador: cuerpo batch JSON, cookie MoodleSession, Origin y User-Agent de Chrome.
 *
 * Devuelve el array `data` de cada llamada, en el mismo orden. Lanza:
 *  - SessionExpiredError si Moodle responde requireloginerror/servicerequireslogin.
 *  - MoodleApiError para otros errores de aplicación (definitivos, sin reintento).
 *  - NetworkError si se agotan los reintentos por fallos de red.
 */
export async function postAjaxBatch(
  session: Session,
  calls: AjaxCall[],
): Promise<unknown[]> {
  const siteUri = new URL(session.siteUrl);
  const url = `${session.siteUrl}/lib/ajax/service.php?sesskey=${encodeURIComponent(session.sesskey)}`;
  const headers = {
    "Content-Type": "application/json",
    Cookie: `MoodleSession=${session.moodleSession}`,
    Origin: `${siteUri.protocol}//${siteUri.host}`,
    "User-Agent": CHROME_USER_AGENT,
  };
  const body = JSON.stringify(
    calls.map((c, index) => ({ index, methodname: c.methodname, args: c.args })),
  );

  let lastNetworkError: unknown = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: ac.signal,
        dispatcher: unsaAgent,
      });

      if (res.status !== 200) {
        // 3xx (redirect a login) o 4xx suelen indicar sesión muerta.
        if (res.status === 303 || res.status === 302 || res.status === 401) {
          throw new SessionExpiredError();
        }
        throw new MoodleApiError(`HTTP ${res.status}`);
      }

      const text = await res.text();
      let decoded: unknown;
      try {
        decoded = JSON.parse(text);
      } catch {
        // Moodle devuelve HTML de login cuando la sesión murió.
        if (/login\/index\.php|loginform/i.test(text)) throw new SessionExpiredError();
        throw new MoodleApiError("Respuesta no es JSON válido");
      }

      if (!Array.isArray(decoded)) {
        throw new MoodleApiError("Respuesta inesperada del servidor AJAX");
      }

      return decoded.map((entry) => {
        const item = entry as {
          error?: boolean;
          data?: unknown;
          exception?: { errorcode?: string; message?: string };
        };
        if (item.error) {
          const code = item.exception?.errorcode ?? "";
          const msg = item.exception?.message ?? "Error desconocido de Moodle";
          if (code === "requireloginerror" || code === "servicerequireslogin") {
            throw new SessionExpiredError();
          }
          throw new MoodleApiError(msg, code);
        }
        return item.data;
      });
    } catch (err) {
      if (err instanceof SessionExpiredError || err instanceof MoodleApiError) {
        throw err; // definitivo: no reintentar
      }
      // AbortError / TypeError de red / undici errors → transitorio.
      lastNetworkError = err;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new NetworkError(
    `Fallo de red tras reintentos: ${String((lastNetworkError as Error)?.message ?? lastNetworkError)}`,
  );
}

/** Atajo para una sola llamada; devuelve directamente su `data`. */
export async function postAjax(
  session: Session,
  methodname: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const [data] = await postAjaxBatch(session, [{ methodname, args }]);
  return data;
}
