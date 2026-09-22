import { Agent } from "undici";
import { CHROME_USER_AGENT } from "../../../core/config.js";
import { LibraryProtocolError, LibraryUnavailableError } from "../../domain/errors.js";

/**
 * Cliente HTTP del OPAC. No usa `fetchUnsa` (core/http.ts) por tres motivos medidos
 * (docs/biblioteca-diagnostico.md):
 *
 *  - Conexión caliente: Koha responde en ~0.25 s si la petición llega por una conexión que tuvo
 *    otra hace menos de ~1 s; si no, paga ~10 s. Es POR CONEXIÓN: una conexión nueva siempre es
 *    fría. Por eso el pool es chico y las ráfagas (búsqueda + fichas) van en secuencia por el
 *    mismo socket, en vez de en paralelo por sockets nuevos.
 *  - Timeouts: en frío, una búsqueda de 500 registros tardó 35 s; el `unsaAgent` corta a los 30 s.
 *  - Redirects: con un único resultado Koha responde 302 al detalle. Se piden con
 *    `redirect: "manual"` para que el gateway decida (y cachee) en vez de seguirlo a ciegas.
 */

const agent = new Agent({
  headersTimeout: 90_000,
  bodyTimeout: 90_000,
  // Apache anuncia `Keep-Alive: timeout=5`; más allá el socket ya está cerrado del otro lado.
  keepAliveTimeout: 4_000,
  keepAliveMaxTimeout: 4_000,
  // undici reutiliza primero el socket ocioso, que es el caliente. El segundo sólo existe para
  // que una búsqueda simultánea no espere en cola detrás de otra de ~15 s.
  connections: 2,
});

const TIMEOUT_MS = 110_000;
const RETRY_DELAY_MS = 1_500;

export interface KohaResponse {
  status: number;
  text: string;
  /** Cabecera Location en un 3xx, absoluta. */
  location: string | null;
}

/**
 * GET contra el OPAC. Reintenta UNA vez sólo ante un fallo de conexión o un 502/503/504:
 * reintentar un timeout costaría otros 110 s y casi nunca lo arregla.
 */
export async function kohaGet(url: string, baseUrl: string): Promise<KohaResponse> {
  // Cinturón: este cliente no debe salir del OPAC ni por un error de edición.
  if (new URL(url).origin !== new URL(baseUrl).origin) {
    throw new LibraryProtocolError(`URL fuera del OPAC: ${url}`);
  }

  for (let attempt = 0; ; attempt++) {
    try {
      const res = await request(url);
      if ([502, 503, 504].includes(res.status) && attempt === 0) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      if (res.status >= 500) {
        throw new LibraryUnavailableError(`La Biblioteca Virtual respondió HTTP ${res.status}.`);
      }
      return res;
    } catch (err) {
      if (err instanceof LibraryUnavailableError || err instanceof LibraryProtocolError) throw err;
      if (isTimeout(err)) {
        throw new LibraryUnavailableError(
          `La Biblioteca Virtual no respondió en ${TIMEOUT_MS / 1000} s. Prueba con menos resultados.`,
        );
      }
      if (attempt === 0) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw new LibraryUnavailableError(
        `No se pudo conectar con la Biblioteca Virtual: ${describe(err)}`,
      );
    }
  }
}

async function request(url: string): Promise<KohaResponse> {
  const res = await fetch(url, {
    headers: { "User-Agent": CHROME_USER_AGENT, "Accept-Language": "es-PE,es;q=0.9" },
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    dispatcher: agent,
  } as RequestInit);
  const location = res.headers.get("location");
  return {
    status: res.status,
    text: await res.text(),
    location: location ? new URL(location, url).toString() : null,
  };
}

function isTimeout(err: unknown): boolean {
  const e = err as { name?: string; cause?: { code?: string; name?: string } };
  return (
    e?.name === "TimeoutError" ||
    e?.name === "AbortError" ||
    e?.cause?.code === "UND_ERR_HEADERS_TIMEOUT" ||
    e?.cause?.code === "UND_ERR_BODY_TIMEOUT"
  );
}

function describe(err: unknown): string {
  const e = err as { message?: string; cause?: { code?: string; message?: string } };
  return e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(err);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
