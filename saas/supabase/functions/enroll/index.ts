// Edge Function: enroll
//
// Registra a un estudiante para el piloto de notificaciones. La llama `dutic saas enroll`
// desde la PC del propio estudiante; nunca recibe la cookie ni el sesskey de Moodle, sólo
// la identidad ya resuelta localmente (unsa_user_id + nombre).
//
// SEGURIDAD (auditoría 2026-09-11, hallazgo C1). La versión anterior devolvía el
// enroll_token de cualquier estudiante ya inscrito a quien enviara su unsaUserId, y ese
// token permite encolar mensajes que el bot entrega a su WhatsApp. Reglas actuales:
//
//   · El token se entrega UNA sola vez, al crearlo. En la base sólo queda su hash.
//   · Quien ya tiene el token lo demuestra enviándolo; no se le reenvía nada.
//   · Un equipo nuevo (sin token) recibe un token PENDIENTE y un código. El token sólo se
//     activa cuando ese código llega por WhatsApp desde el número ya vinculado a la cuenta
//     (`confirm_reenroll`), así que conocer el unsaUserId de otro no sirve de nada.
//   · Una fila nunca vinculada sólo se puede reiniciar cuando lleva 48 h abandonada: antes
//     de eso, reiniciarla dejaría fuera a quien la creó.
//   · Los clientes anteriores a esta versión (sin clientVersion) reciben 409 en vez de un
//     token; su `callFunction` lanza antes de guardar, así que no pisan su saas.json.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// ── "Despertador" del dispatcher (arregla el síndrome del check gris) ──────────────
//
// El dispatcher sólo corre por cron o a demanda. Sin esto, un estudiante que enrola y
// manda su código por WhatsApp puede quedarse con el check gris horas hasta el próximo
// cron. Aquí disparamos un workflow_dispatch de GitHub Actions para que el bot conecte
// casi de inmediato, con una ventana de escucha más larga.
//
// `enroll` es un endpoint PÚBLICO (sin verify_jwt, auth propia por diseño) — sin
// límite, cualquiera podría llamarlo en bucle y agotar los minutos gratis de Actions o
// el rate-limit del token de GitHub (DDoS de costo, no de tráfico). El cooldown de
// `dispatch_wakeups` acota a **uno** el número de disparos por ventana de 2 minutos,
// sin importar cuántas veces se llame `enroll` — es la mitigación, no una opción.
// El worker vive en un repo PRIVADO aparte: sus secrets incluyen la service_role key,
// que se salta la RLS y protege datos personales de terceros. DUTIC-mcp es público
// (paquete npm), así que esa credencial no puede vivir ahí.
const GITHUB_OWNER = "JOSETRA44";
const GITHUB_REPO = "dutic-dispatcher";
const GITHUB_WORKFLOW_FILE = "dispatch-notifications.yml";
const WAKE_COOLDOWN_MS = 120_000;
const ON_DEMAND_LISTEN_SECONDS = 150;

/** Una inscripción que nadie vinculó por WhatsApp se considera abandonada pasado esto. */
const STALE_PENDING_MS = 48 * 60 * 60 * 1000;
/** Vida de una solicitud de reinscripción: el dispatcher corre al menos una vez al día. */
const REENROLL_TTL_MS = 24 * 60 * 60 * 1000;
/** Solicitudes vivas por estudiante. Sin tope, la tabla se podría llenar a voluntad. */
const MAX_OPEN_REENROLLS = 3;

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

// ── Utilidades ─────────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 256 bits de entropía en base64url (43 caracteres). */
function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Código corto, fácil de teclear en WhatsApp (sin 0/O/1/I). Con 32 símbolos, `byte & 31`
// es uniforme porque 256 es múltiplo de 32: no hay sesgo de módulo.
const LINK_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function randomLinkCode(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => LINK_ALPHABET[b & 31]).join("");
}

type DbError = { code?: string; message?: string } | null;
const isUniqueViolation = (error: DbError) => error?.code === "23505";

// ── Casos ──────────────────────────────────────────────────────────────────────────

async function createStudent(unsaUserId: number, fullName: string): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const enrollToken = randomToken();
    const linkCode = randomLinkCode();
    const { error } = await supabase.from("students").insert({
      unsa_user_id: unsaUserId,
      full_name: fullName,
      enroll_token_hash: await sha256Hex(enrollToken),
      link_code: linkCode,
      status: "pending_link",
    });

    if (!error) {
      await tryTriggerDispatcherWakeup();
      return json({ enrollToken, linkCode, status: "pending_link", alreadyEnrolled: false });
    }
    // Dos inscripciones simultáneas de la misma cuenta: la otra ganó.
    if (isUniqueViolation(error) && error.message?.includes("unsa_user_id")) {
      return json({ error: "enrollment_in_progress" }, 409);
    }
    // Colisión del código corto (1 en ~10⁹): se reintenta con otro.
    if (!isUniqueViolation(error)) break;
  }
  return json({ error: "insert_failed" }, 500);
}

/** Fila nunca vinculada y abandonada: se le rotan token y código. */
async function restartPending(studentId: string, fullName: string): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const enrollToken = randomToken();
    const linkCode = randomLinkCode();
    const { data, error } = await supabase
      .from("students")
      .update({
        full_name: fullName,
        enroll_token_hash: await sha256Hex(enrollToken),
        enroll_token: null,
        link_code: linkCode,
        enrolled_at: new Date().toISOString(),
      })
      .eq("id", studentId)
      .is("whatsapp_number", null)
      .select("id");

    if (!error && data?.length) {
      await tryTriggerDispatcherWakeup();
      return json({ enrollToken, linkCode, status: "pending_link", alreadyEnrolled: true });
    }
    if (!error) return json({ error: "enrollment_in_progress" }, 409); // se vinculó mientras tanto
    if (!isUniqueViolation(error)) break;
  }
  return json({ error: "update_failed" }, 500);
}

/** Cuenta ya vinculada, pedida desde un equipo sin token: solicitud pendiente de confirmar. */
async function requestReenroll(studentId: string): Promise<Response> {
  const now = new Date();
  const { count, error: countError } = await supabase
    .from("reenroll_requests")
    .select("id", { count: "exact", head: true })
    .eq("student_id", studentId)
    .is("consumed_at", null)
    .gt("expires_at", now.toISOString());
  if (countError) return json({ error: "lookup_failed" }, 500);
  if ((count ?? 0) >= MAX_OPEN_REENROLLS) {
    return json({ error: "too_many_reenroll_requests" }, 429, { "Retry-After": "3600" });
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const enrollToken = randomToken();
    const linkCode = randomLinkCode();
    const { error } = await supabase.from("reenroll_requests").insert({
      student_id: studentId,
      token_hash: await sha256Hex(enrollToken),
      link_code: linkCode,
      expires_at: new Date(now.getTime() + REENROLL_TTL_MS).toISOString(),
    });

    if (!error) {
      await tryTriggerDispatcherWakeup();
      return json({ enrollToken, linkCode, status: "reenroll_pending", alreadyEnrolled: true });
    }
    if (!isUniqueViolation(error)) break;
  }
  return json({ error: "insert_failed" }, 500);
}

// ── Entrada ────────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const { unsaUserId, fullName, clientVersion, enrollToken } = body ?? {};
  if (
    typeof unsaUserId !== "number" ||
    !Number.isInteger(unsaUserId) ||
    unsaUserId <= 0 ||
    unsaUserId > 100_000_000
  ) {
    return json({ error: "invalid_unsa_user_id" }, 400);
  }
  if (typeof fullName !== "string" || !fullName.trim() || fullName.length > 200) {
    return json({ error: "invalid_full_name" }, 400);
  }
  if (
    enrollToken !== undefined &&
    (typeof enrollToken !== "string" || enrollToken.length < 16 || enrollToken.length > 128)
  ) {
    return json({ error: "invalid_enroll_token" }, 400);
  }

  const { data: existing, error: lookupError } = await supabase
    .from("students")
    .select("id, status, link_code, enroll_token_hash, whatsapp_number, enrolled_at")
    .eq("unsa_user_id", unsaUserId)
    .maybeSingle();
  if (lookupError) return json({ error: "lookup_failed" }, 500);

  if (!existing) return createStudent(unsaUserId, fullName.trim());

  if (typeof clientVersion !== "string") {
    return json(
      {
        error: "already_enrolled",
        detail: "Actualiza dutic (npm i -g @josetra/dutic-mcp) y vuelve a correr `dutic saas enroll`.",
      },
      409,
    );
  }

  // Quien ya tiene el token no necesita otro: se confirma, no se reenvía.
  if (typeof enrollToken === "string" && (await sha256Hex(enrollToken)) === existing.enroll_token_hash) {
    return json({
      status: existing.status,
      linkCode: existing.status === "pending_link" ? existing.link_code : null,
      alreadyEnrolled: true,
      tokenValid: true,
    });
  }

  if (!existing.whatsapp_number) {
    const age = Date.now() - new Date(existing.enrolled_at).getTime();
    if (age < STALE_PENDING_MS) {
      return json(
        {
          error: "enrollment_in_progress",
          detail:
            "Esta cuenta ya tiene una inscripción sin vincular. Termínala desde el equipo donde " +
            "la empezaste, o espera 48 h a que caduque.",
        },
        409,
      );
    }
    return restartPending(existing.id, fullName.trim());
  }

  return requestReenroll(existing.id);
});
