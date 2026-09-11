// Edge Function: telemetry-forget
//
// Derecho de cancelación (Ley 29733). Borra una instalación, todos sus eventos y las cuentas
// que sólo ella había visto. Lo invoca `dutic telemetry forget` desde el propio equipo.
//
// Autenticación: la misma credencial que la ingesta (`X-Dutic-Install: <id>.<secreto>`).
// Sin cuerpo: todo lo necesario va en la cabecera.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  // No se usa el cuerpo, pero hay que consumirlo: responder sin leerlo deja la petición
  // colgada en el gateway.
  await req.body?.cancel().catch(() => {});
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const credential = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{32,128})$/i.exec(req.headers.get("x-dutic-install") ?? "");
  if (!credential || !UUID.test(credential[1])) return json({ error: "invalid_install" }, 401);

  const { data, error } = await supabase.rpc("telemetry_forget", {
    p_install_id: credential[1].toLowerCase(),
    p_secret_hash: await sha256Hex(credential[2]),
  });
  if (error || typeof data !== "object" || data === null) {
    console.error(JSON.stringify({ evt: "telemetry_forget_failed", code: error?.code }));
    return json({ error: "forget_failed" }, 500);
  }
  if ((data as { error?: string }).error) return json({ error: "invalid_install" }, 401);

  return json(data);
});
