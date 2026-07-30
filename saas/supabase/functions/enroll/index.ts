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

// ── "Despertador" del dispatcher (arregla el síndrome del check gris) ──────────────
//
// El dispatcher sólo corre por cron (2x/día) o a demanda. Sin esto, un estudiante que
// enrola y manda su link_code por WhatsApp puede quedarse con el check gris horas
// hasta el próximo cron. Aquí disparamos un workflow_dispatch de GitHub Actions para
// que el bot conecte casi de inmediato, con una ventana de escucha más larga.
//
// `enroll` es un endpoint PÚBLICO (sin verify_jwt, auth propia por diseño) — sin
// límite, cualquiera podría llamarlo en bucle y agotar los minutos gratis de Actions o
// el rate-limit del token de GitHub (DDoS de costo, no de tráfico). El cooldown de
// `dispatch_wakeups` acota a **uno** el número de disparos por ventana de 2 minutos,
// sin importar cuántas veces se llame `enroll` — es la mitigación, no una opción.
const GITHUB_OWNER = "JOSETRA44";
const GITHUB_REPO = "DUTIC-mcp";
const GITHUB_WORKFLOW_FILE = "dispatch-notifications.yml";
const WAKE_COOLDOWN_MS = 120_000;
const ON_DEMAND_LISTEN_SECONDS = 150;

async function tryTriggerDispatcherWakeup(): Promise<void> {
  const githubToken = Deno.env.get("GITHUB_PAT");
  if (!githubToken) return; // no configurado: el piloto sigue andando por cron, sólo sin despertador

  // Claim atómico vía UPDATE...WHERE (Postgres serializa filas concurrentes): sólo la
  // llamada que gana el WHERE dispara el workflow. Bajo carga, sólo una lo hace.
  const cutoff = new Date(Date.now() - WAKE_COOLDOWN_MS).toISOString();
  const { data: claimed, error: claimError } = await supabase
    .from("dispatch_wakeups")
    .update({ last_triggered_at: new Date().toISOString() })
    .eq("id", 1)
    .or(`last_triggered_at.is.null,last_triggered_at.lt.${cutoff}`)
    .select("id");

  if (claimError || !claimed?.length) return; // cooldown activo: alguien más ya despertó al bot hace poco

  try {
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 5000);
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW_FILE}/dispatches`,
      {
        method: "POST",
        signal: ac.signal,
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "dutic-saas-enroll",
        },
        body: JSON.stringify({ ref: "main", inputs: { listen_seconds: String(ON_DEMAND_LISTEN_SECONDS) } }),
      },
    );
    clearTimeout(timeout);
    if (!res.ok) console.error("wake-up dispatch failed", res.status, await res.text().catch(() => ""));
  } catch (err) {
    // Nunca debe tumbar el enroll del estudiante por un problema de red hacia GitHub.
    console.error("wake-up dispatch error", err);
  }
}

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
  // Validación barata (endpoint público, sin verify_jwt): descarta ruido/abuso obvio
  // antes de tocar la base de datos o considerar despertar al dispatcher.
  if (!Number.isInteger(unsaUserId) || unsaUserId <= 0 || unsaUserId > 100_000_000) {
    return new Response(JSON.stringify({ error: "invalid_unsa_user_id" }), { status: 400 });
  }
  if (typeof fullName !== "string" || fullName.length === 0 || fullName.length > 200) {
    return new Response(JSON.stringify({ error: "invalid_full_name" }), { status: 400 });
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

  // Sólo para altas nuevas: reintentos de un estudiante ya enrolado no deben volver a
  // despertar al bot (ya está cubierto por el cooldown igual, pero así evitamos hasta
  // intentarlo).
  await tryTriggerDispatcherWakeup();

  return new Response(
    JSON.stringify({ enrollToken, linkCode, status: "pending_link", alreadyEnrolled: false }),
    { headers: { "Content-Type": "application/json" } },
  );
});
