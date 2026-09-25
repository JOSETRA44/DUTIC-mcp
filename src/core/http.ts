import { Agent } from "undici";
import { record } from "../telemetry/index.js";
import { HOST } from "./config.js";
import { SessionExpiredError } from "./errors.js";

/**
 * Dispatcher de undici que acepta el certificado de la CA privada de la UNSA.
 * Sólo debe usarse para peticiones al host del aula virtual — no como dispatcher global.
 */
export const unsaAgent = new Agent({
  connect: {
    // La UNSA usa una CA no incluida en el trust store por defecto.
    rejectUnauthorized: false,
  },
  headersTimeout: 30_000,
  bodyTimeout: 60_000,
});

/**
 * true si la URL apunta al host indicado (por defecto, el del aula virtual).
 *
 * Ojo al parámetro `host`: esta función no es sólo un detector para elegir dispatcher, es la
 * PUERTA DE SEGURIDAD de `dutic fetch` (`domain/fetch.ts`), que rechaza cualquier URL fuera del
 * aula. Por eso el host se pasa explícitamente en vez de ampliar el permitido a `*.unsa.edu.pe`:
 * el cliente de la encuesta comprueba contra EXTRANET_HOST sin abrirle el extranet a `dutic fetch`.
 */
export function isUnsaUrl(url: string, host: string = HOST): boolean {
  try {
    return new URL(url).host === host;
  } catch {
    return false;
  }
}

/**
 * Ruta sin query para nombrar el evento: `/2026B/mod/assign/view.php`. Los ids viajan en la
 * query, que no se envía; así el nombre agrupa peticiones equivalentes sin datos de nadie.
 */
function endpointName(url: string): string {
  try {
    const { pathname } = new URL(url);
    return pathname.slice(0, 120) || "/";
  } catch {
    return "desconocido";
  }
}

/**
 * fetch contra el aula virtual con timeout duro (AbortController) y el dispatcher que acepta
 * la CA privada de la UNSA. Sin este timeout, una petición colgada bloquea todo el barrido.
 *
 * Los fallos se registran en la telemetría (`http.error`): el aula se cae, se pone lenta o
 * bloquea endpoints cada cierto tiempo, y sin esto cada estudiante lo vive como "dutic no
 * funciona" sin que quede rastro de dónde estuvo el problema.
 */
export async function fetchUnsa(
  url: string,
  init: RequestInit = {},
  timeoutMs = 25_000,
): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const started = performance.now();
  try {
    const res = await fetch(url, {
      ...init,
      signal: ac.signal,
      dispatcher: unsaAgent,
      redirect: init.redirect ?? "follow",
    });
    // Un 5xx del aula no lanza excepción, pero es exactamente lo que hay que ver.
    if (res.status >= 500) {
      record({
        kind: "http.error",
        name: endpointName(url),
        status: "error",
        durationMs: performance.now() - started,
        attrs: { httpStatus: res.status, host: new URL(url).host },
      });
    }
    return res;
  } catch (err) {
    // Con una sesión muerta, Moodle a veces entra en loop de redirección hacia login/index.php
    // en vez de servir una página de login limpia; undici agota su límite de redirects y lanza
    // un TypeError críptico ("fetch failed" / "redirect count exceeded"). Se traduce a la señal
    // de sesión expirada para que el llamador la renueve, en vez de un fallo de red genérico.
    const msg = String((err as Error)?.cause ?? (err as Error)?.message ?? "");
    const expired = /redirect/i.test(msg);
    record({
      kind: "http.error",
      name: endpointName(url),
      status: "error",
      error: err,
      durationMs: performance.now() - started,
      attrs: { aborted: ac.signal.aborted, expired, timeoutMs },
    });
    if (expired) throw new SessionExpiredError();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
