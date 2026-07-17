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
