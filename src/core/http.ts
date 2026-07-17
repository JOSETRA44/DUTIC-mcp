import { Agent } from "undici";
import { HOST } from "./config.js";

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

/** true si la URL apunta al host del aula virtual (para decidir si usar unsaAgent). */
export function isUnsaUrl(url: string): boolean {
  try {
    return new URL(url).host === HOST;
  } catch {
    return false;
  }
}

/**
 * fetch contra el aula virtual con timeout duro (AbortController) y el dispatcher que acepta
 * la CA privada de la UNSA. Sin este timeout, una petición colgada bloquea todo el barrido.
 */
export async function fetchUnsa(
  url: string,
  init: RequestInit = {},
  timeoutMs = 25_000,
): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: ac.signal,
      dispatcher: unsaAgent,
      redirect: init.redirect ?? "follow",
    });
  } finally {
    clearTimeout(timer);
  }
}
