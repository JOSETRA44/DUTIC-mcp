// Edge Function: enroll
//
// Registra (o reactiva) a un estudiante para el piloto de notificaciones. La llama
// `dutic saas enroll` desde la PC del propio estudiante, autenticado con su sesión de
// Moodle ya validada localmente (nunca se envía la cookie/sesskey aquí, sólo su
// identidad de Moodle ya resuelta: unsa_user_id + nombre).
//
// Devuelve un enroll_token de un solo uso que `dutic saas push` usará para autenticar
// los envíos posteriores. Usa la service_role key internamente (no expuesta al
// cliente) porque `students` no tiene políticas RLS para anon/authenticated.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

function randomToken(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

// Código corto, fácil de teclear en un chat de WhatsApp (sin 0/O/1/I para evitar confusión).
const LINK_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function randomLinkCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) code += LINK_ALPHABET[Math.floor(Math.random() * LINK_ALPHABET.length)];
  return code;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405 });
  }

  let body: { unsaUserId?: number; fullName?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400 });
  }

  const { unsaUserId, fullName } = body;
  if (!unsaUserId || !fullName) {
    return new Response(
      JSON.stringify({ error: "missing_fields", required: ["unsaUserId", "fullName"] }),
      { status: 400 },
    );
  }

  const { data: existing } = await supabase
    .from("students")
    .select("id, enroll_token, link_code, status")
    .eq("unsa_user_id", unsaUserId)
    .maybeSingle();

  if (existing) {
    // Filas creadas antes de que existiera link_code (o ya consumido pero aún pending_link
    // por alguna carrera): backfill para no dejar al estudiante sin código para vincularse.
    let linkCode = existing.link_code;
    if (!linkCode && existing.status === "pending_link") {
      linkCode = randomLinkCode();
      await supabase.from("students").update({ link_code: linkCode }).eq("id", existing.id);
    }
    return new Response(
      JSON.stringify({
        enrollToken: existing.enroll_token,
        linkCode,
        status: existing.status,
        alreadyEnrolled: true,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  const enrollToken = randomToken();
  const linkCode = randomLinkCode();
  const { error } = await supabase.from("students").insert({
    unsa_user_id: unsaUserId,
    full_name: fullName,
    enroll_token: enrollToken,
    link_code: linkCode,
    status: "pending_link",
  });

  if (error) {
    return new Response(JSON.stringify({ error: "insert_failed", detail: error.message }), { status: 500 });
  }

  return new Response(
    JSON.stringify({ enrollToken, linkCode, status: "pending_link", alreadyEnrolled: false }),
    { headers: { "Content-Type": "application/json" } },
  );
});
