import { APP_VERSION } from "../core/version.js";

/**
 * Transporte HTTP de la telemetría. Deliberadamente tonto: una petición, un timeout corto y
 * la respuesta tal cual. La política (reintentos, backoff, qué hacer con cada código) vive en
 * quien lo llama, porque el agente de fondo y un comando interactivo tienen paciencias muy
 * distintas.
 *
 * `DUTIC_TELEMETRY_URL` permite apuntar a otro proyecto (pruebas, auto-hospedaje).
 */
export const TELEMETRY_ENDPOINT = (
  process.env.DUTIC_TELEMETRY_URL?.trim() || "https://udihgiwdddrtoqdwopcb.supabase.co/functions/v1"
).replace(/\/$/, "");

export interface PostResult {
  status: number;
  data: Record<string, unknown>;
  /** De la cabecera Retry-After, en ms; `null` si no vino. */
  retryAfterMs: number | null;
}

/** POST JSON. Lanza sólo ante fallos de red o timeout; los códigos HTTP se devuelven. */
export async function postJson(
  functionName: string,
  body: unknown,
  headers: Record<string, string> = {},
  timeoutMs = 3000,
): Promise<PostResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  // Un envío pendiente nunca debe mantener vivo el proceso de la CLI.
  timer.unref?.();
  try {
    const res = await fetch(`${TELEMETRY_ENDPOINT}/${functionName}`, {
      method: "POST",
      signal: ac.signal,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `dutic/${APP_VERSION}`,
        ...headers,
      },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const retryAfter = Number(res.headers.get("retry-after"));
    return {
      status: res.status,
      data,
      retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null,
    };
  } finally {
    clearTimeout(timer);
  }
}
