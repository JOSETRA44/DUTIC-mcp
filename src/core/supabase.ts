/**
 * Integración con Supabase para el registro de usuarios de dutic.
 *
 * Usa el anon key directamente (es seguro en paquetes públicos — la RLS
 * controla el acceso, no la clave). No depende de @supabase/supabase-js;
 * usa fetch nativo para mantener el bundle liviano.
 *
 * Al hacer `dutic login` se registra/actualiza automáticamente el usuario
 * en la tabla `dutic_users` de Supabase.
 */

const SUPABASE_URL = "https://ctowimobmorctvsotibf.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN0b3dpbW9ibW9yY3R2c290aWJmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUxNjQ2MDYsImV4cCI6MjEwMDc0MDYwNn0.OEmjFqHGMp3zv6st8LiB0WoyzH6jwKrDGJ5PksbCChk";

export interface DuticUser {
  moodle_user_id: number;
  name: string;
  email: string | null;
  site_url: string;
  semester: string;
  last_login_at: string; // ISO 8601
}

/**
 * Hace un upsert del usuario en Supabase.
 * Se llama tras un login exitoso — falla silenciosamente para no interrumpir.
 */
export async function syncUserToSupabase(user: DuticUser): Promise<void> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/dutic_users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
        // Upsert: si ya existe el moodle_user_id, actualiza
        "Prefer": "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({
        moodle_user_id: user.moodle_user_id,
        name: user.name,
        email: user.email,
        site_url: user.site_url,
        semester: user.semester,
        last_login_at: user.last_login_at,
      }),
    });

    if (!res.ok) {
      // Loguea solo si hay un error inesperado (no 409 conflict que ya maneja upsert)
      const body = await res.text().catch(() => "");
      if (res.status !== 409) {
        console.error(`[dutic] Supabase sync warning: ${res.status} ${body.slice(0, 120)}`);
      }
    }
  } catch {
    // Red caída, timeout, etc. — no bloquear el flujo del usuario.
  }
}

/**
 * Incrementa el contador de escaneos y sincroniza cursos escaneados.
 * Llamado al finalizar un scan-courses exitoso.
 */
export async function syncScannedCoursesToSupabase(
  moodleUserId: number,
  courses: { id: number; name: string | null; teachers: string[]; semester: string }[],
): Promise<void> {
  if (!courses.length) return;
  try {
    const rows = courses
      .filter((c) => c.name) // solo guardar los que tienen nombre
      .map((c) => ({
        course_id: c.id,
        name: c.name,
        teachers: c.teachers,
        semester: c.semester,
        scanned_by: moodleUserId,
        updated_at: new Date().toISOString(),
      }));

    if (!rows.length) return;

    await fetch(`${SUPABASE_URL}/rest/v1/dutic_courses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
        "Prefer": "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(rows),
    });
  } catch {
    // Silencioso
  }
}
