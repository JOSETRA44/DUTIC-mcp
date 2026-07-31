// Edge Function: ingest
//
// Recibe el *diff* que ya calculó `dutic watch` en la PC del estudiante (mismo shape
// que produce domain/watch.ts: Changes + Snapshot) y lo convierte en filas de
// `pending_notifications` que el dispatcher de GitHub Actions recogerá más tarde.
//
// Nunca recibe ni guarda MoodleSession/sesskey — sólo el resultado ya calculado del
// scraping, que ocurrió enteramente en la máquina del estudiante.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// course_id=0: la foto no se parte por curso (domain/watch.ts ya combina todos los
// cursos en un solo snapshot); una fila global por estudiante alcanza.
const GLOBAL_COURSE_ID = 0;

interface IngestBody {
  enrollToken?: string;
  snapshot?: unknown;
  changes?: {
    newTasks?: unknown[];
    newGrades?: unknown[];
    gradeChanges?: unknown[];
    submissionChanges?: unknown[];
    dueDateChanges?: unknown[];
  } | null;
  /**
   * Aviso del propio sistema, no una novedad de Moodle (p.ej. "tu sesión expiró").
   * Llega SIN snapshot a propósito: se envía justo cuando el agente local no pudo
   * hablar con Moodle, así que no hay foto que mandar.
   */
  notice?: { kind?: string; payload?: Record<string, unknown> };
}

/** Avisos del sistema permitidos — lista blanca para que este campo no sea un canal libre. */
const ALLOWED_NOTICES = new Set(["session_expired"]);

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405 });
  }

  let body: IngestBody;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400 });
  }

  const { enrollToken, snapshot, changes, notice } = body;
  if (!enrollToken || (!snapshot && !notice)) {
    return new Response(
      JSON.stringify({ error: "missing_fields", required: ["enrollToken", "snapshot | notice"] }),
      { status: 400 },
    );
  }
  if (notice && !ALLOWED_NOTICES.has(notice.kind ?? "")) {
    return new Response(JSON.stringify({ error: "unknown_notice_kind" }), { status: 400 });
  }

  const { data: student, error: lookupError } = await supabase
    .from("students")
    .select("id, status")
    .eq("enroll_token", enrollToken)
    .maybeSingle();

  if (lookupError || !student) {
    return new Response(JSON.stringify({ error: "invalid_enroll_token" }), { status: 401 });
  }
  if (student.status === "paused") {
    return new Response(JSON.stringify({ error: "student_paused" }), { status: 403 });
  }

  // Un aviso del sistema llega sin foto; no hay nada que guardar en course_snapshot.
  if (snapshot) {
    await supabase.from("course_snapshot").upsert(
      {
        student_id: student.id,
        course_id: GLOBAL_COURSE_ID,
        snapshot,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "student_id,course_id" },
    );
  }

  const rows: { student_id: string; kind: string; payload: unknown }[] = [];

  if (notice) {
    // Anti-repetición: si ya hay un aviso igual sin enviar, no encolar otro. El agente
    // local corre cada pocas horas y seguiría fallando hasta que el estudiante haga
    // login — sin esto le llegarían decenas de mensajes idénticos.
    const { data: dup } = await supabase
      .from("pending_notifications")
      .select("id")
      .eq("student_id", student.id)
      .eq("kind", notice.kind!)
      .is("sent_at", null)
      .limit(1);
    if (!dup?.length) {
      rows.push({ student_id: student.id, kind: notice.kind!, payload: notice.payload ?? {} });
    }
  }

  if (changes) {
    for (const t of changes.newTasks ?? []) rows.push({ student_id: student.id, kind: "new_task", payload: t });
    for (const g of changes.newGrades ?? []) rows.push({ student_id: student.id, kind: "new_grade", payload: g });
    for (const g of changes.gradeChanges ?? [])
      rows.push({ student_id: student.id, kind: "grade_change", payload: g });
    for (const s of changes.submissionChanges ?? [])
      rows.push({ student_id: student.id, kind: "submission_change", payload: s });
    for (const d of changes.dueDateChanges ?? [])
      rows.push({ student_id: student.id, kind: "due_date_change", payload: d });
  }

  if (rows.length) await supabase.from("pending_notifications").insert(rows);

  await supabase.from("students").update({ last_push_at: new Date().toISOString() }).eq("id", student.id);

  return new Response(JSON.stringify({ ok: true, notificationsQueued: rows.length }), {
    headers: { "Content-Type": "application/json" },
  });
});
