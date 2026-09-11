// Edge Function: telemetry-register
//
// Da de alta una instalación de dutic para la telemetría.
//
// La credencial la genera el CLIENTE (256 bits con node:crypto) y aquí sólo llega su
// sha256: el secreto nunca viaja en el alta ni queda en la base. El alta es idempotente
// (mismo hash → misma instalación), así que una respuesta perdida no crea fantasmas.
//
// Pública (verify_jwt=false): una instalación nueva todavía no tiene identidad que
// presentar. El abuso se acota dentro de la base: 60 altas por hora por IP, con la IP
// guardada sólo como HMAC con sal diaria. Una instalación falsa sólo puede escribir sus
// propios eventos, nunca los de otra.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const MAX_BODY_BYTES = 8 * 1024;
const MAX_DRAIN_BYTES = 1024 * 1024;

type Json = Record<string, unknown>;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/**
 * Lee el cuerpo con tope. Si se pasa, drena sin guardar antes de responder: responder sin
 * consumir el cuerpo deja la petición colgada en el gateway (~160 s, 503) en vez de dar 413.
 */
async function readBody(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total <= max) chunks.push(value);
    else if (total > MAX_DRAIN_BYTES) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  if (total > max) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function text(v: unknown, max: number, pattern: RegExp): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().slice(0, max);
  return s && pattern.test(s) ? s : undefined;
}

const int = (v: unknown, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? v : undefined;

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const raw = await readBody(req, MAX_BODY_BYTES);
  if (raw === null) return json({ error: "payload_too_large" }, 413);

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!isObj(body)) return json({ error: "invalid_json" }, 400);

  const secretHash = text(body.secretHash, 64, /^[0-9a-f]{64}$/);
  if (!secretHash) return json({ error: "invalid_secret" }, 400);

  // Sólo lo que describe el entorno técnico. Ni hostname ni usuario del sistema.
  const d = isObj(body.device) ? body.device : {};
  const device = {
    os: text(d.os, 40, /^[\w.-]+$/),
    osRelease: text(d.osRelease, 60, /^[\w .()+-]+$/),
    arch: text(d.arch, 20, /^\w+$/),
    node: text(d.node, 20, /^v?[\d.]+$/),
    cpuCount: int(d.cpuCount, 1024),
    memGb: int(d.memGb, 4096),
    locale: text(d.locale, 20, /^[\w-]+$/),
    timezone: text(d.timezone, 60, /^[\w/+-]+$/),
    appVersion: text(d.appVersion, 40, /^[\w.+-]+$/),
  };

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;

  const { data, error } = await supabase.rpc("telemetry_register", {
    p_secret_hash: secretHash,
    p_ip: ip,
    p_device: device,
  });
  if (error || !isObj(data)) {
    console.error(JSON.stringify({ evt: "telemetry_register_failed", code: error?.code }));
    return json({ error: "register_failed" }, 500);
  }
  if (data.error === "rate_limited") {
    return json({ error: "rate_limited" }, 429, { "Retry-After": String(data.retry_after ?? 3600) });
  }
  if (data.error) return json({ error: data.error }, 400);

  return json({ installId: data.installId });
});
