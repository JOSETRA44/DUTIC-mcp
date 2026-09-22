// Edge Function: library-ingest
//
// Única puerta de escritura del catálogo de la Biblioteca Virtual UNSA. Existe para que el
// barrido automático (GitHub Actions, ver .github/workflows/library-harvest.yml) NO necesite
// la service_role key.
//
// POR QUÉ IMPORTA. La service_role key salta el RLS del proyecto ENTERO: con ella, un secreto
// de CI filtrado leería `students`, `whatsapp_sessions` y todo `telemetry`. El token que sí
// viaja a GitHub sólo sirve para llamar a esta función, que únicamente sabe escribir
// bibliografía. Revocarlo es un UPDATE (`library_revoke_ingest_client`), no una rotación de
// claves del proyecto.
//
// AUTENTICACIÓN EN DOS CAPAS, igual que `enroll`/`ingest`:
//   1. El gateway verifica el JWT del header Authorization (el anon key, que es público).
//   2. Esta función valida el token de ingesta que viaja EN EL CUERPO, comparando su sha256
//      contra `library.ingest_clients`. La base nunca guarda el token en claro.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

/** Un bloque del barrido son 500 registros (~200-400 KB). 2 MB deja margen de sobra. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Pasado esto se deja de drenar el cuerpo y se corta la conexión. */
const MAX_DRAIN_BYTES = 16 * 1024 * 1024;
const MAX_ROWS = 1000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Lee el cuerpo con tope de memoria; `null` si se pasa.
 *
 * SIGUE LEYENDO aunque ya se haya pasado, antes de responder. Medido el 2026-09-11 en este
 * mismo proyecto: responder sin consumir un cuerpo grande no produce un 413 limpio, deja la
 * petición colgada en el gateway hasta su timeout (~160 s, 503). El drenaje también tiene
 * tope para que un cuerpo gigante no ocupe el worker sin fin.
 */
async function readBody(req: Request): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total <= MAX_BODY_BYTES) {
      chunks.push(value);
    } else if (total > MAX_DRAIN_BYTES) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  if (total > MAX_BODY_BYTES) return null;

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

const int = (v: unknown, fallback: number | null = null): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : fallback;

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // Primero el cuerpo, siempre: ver readBody.
  const raw = await readBody(req);
  if (raw === null) return json({ error: "payload_too_large" }, 413);

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const token = typeof body.token === "string" ? body.token : "";
  if (token.length < 32) return json({ error: "invalid_token" }, 401);

  const { data: valid, error: authError } = await supabase.rpc("library_check_ingest_token", {
    p_hash: await sha256Hex(token),
  });
  if (authError) return json({ error: "auth_check_failed" }, 500);
  if (valid !== true) return json({ error: "invalid_token" }, 401);

  const action = typeof body.action === "string" ? body.action : "";

  try {
    switch (action) {
      case "start": {
        const { data, error } = await supabase.rpc("library_harvest_start", {
          p_mode: body.mode === "incremental" ? "incremental" : "full",
          p_total: int(body.total),
          p_max_age_days: int(body.maxAgeDays),
        });
        if (error) throw error;
        return json({ run: data });
      }

      case "batch": {
        const rows = Array.isArray(body.rows) ? body.rows : null;
        if (!rows) return json({ error: "rows_required" }, 400);
        if (rows.length > MAX_ROWS) return json({ error: "too_many_rows" }, 400);
        const run = int(body.run);
        const nextOffset = int(body.nextOffset, 0);
        if (run === null) return json({ error: "run_required" }, 400);
        const { data, error } = await supabase.rpc("library_ingest_batch", {
          p_run: run,
          p_rows: rows,
          p_next_offset: nextOffset,
          p_total: int(body.total),
        });
        if (error) throw error;
        return json({ written: data });
      }

      case "finish": {
        const run = int(body.run);
        const status = body.status;
        if (run === null) return json({ error: "run_required" }, 400);
        if (status !== "paused" && status !== "done" && status !== "failed") {
          return json({ error: "invalid_status" }, 400);
        }
        const { error } = await supabase.rpc("library_harvest_finish", {
          p_run: run,
          p_status: status,
          p_error: typeof body.error === "string" ? body.error.slice(0, 500) : null,
          p_blocks_failed: int(body.blocksFailed, 0),
        });
        if (error) throw error;
        return json({ ok: true });
      }

      case "known_ids": {
        const ids = Array.isArray(body.ids) ? body.ids.map((v) => int(v)).filter((v) => v !== null) : [];
        if (ids.length > MAX_ROWS) return json({ error: "too_many_ids" }, 400);
        const { data, error } = await supabase.rpc("library_known_ids", { p_ids: ids });
        if (error) throw error;
        return json({ ids: data ?? [] });
      }

      default:
        return json({ error: "unknown_action" }, 400);
    }
  } catch (err) {
    // El mensaje de Postgres puede traer fragmentos de la consulta; se recorta y no se
    // devuelve nada más del entorno.
    return json({ error: "ingest_failed", detail: String((err as Error).message ?? err).slice(0, 300) }, 500);
  }
});
