import { postAjax } from "../core/moodleClient.js";
import { MoodleApiError } from "../core/errors.js";
import type { Session } from "../core/session.js";
import type { Course, Task } from "../core/models.js";
import { getCourseContents, getEnrolledCourses } from "./courses.js";
import { mapLimit } from "./concurrency.js";

/** Extrae el course module id (cmid) de una URL tipo mod/assign/view.php?id=123. */
function cmidFromUrl(url: string | null | undefined): number | null {
  if (!url) return null;
  const m = /[?&]id=(\d+)/.exec(url);
  return m ? Number(m[1]) : null;
}

/**
 * Tareas próximas según el calendario (core_calendar_get_action_events_by_timesort).
 * Es exactamente lo que ve la app Flutter: rápido, pero omite tareas sin evento de calendario.
 */
export async function getUpcomingTasks(
  session: Session,
  limitNum = 50,
): Promise<Task[]> {
  const timesortFrom = Math.floor(Date.now() / 1000);
  const data = (await postAjax(
    session,
    "core_calendar_get_action_events_by_timesort",
    { timesortfrom: timesortFrom, limitnum: limitNum },
  )) as { events?: unknown[] } | null;

  const events = data?.events ?? [];
  return events
    .filter((raw) => (raw as { modulename?: string }).modulename === "assign")
    .map((raw) => {
      const e = raw as {
        id: number;
        name: string;
        timesort?: number;
        timestart?: number;
        url?: string;
        action?: { url?: string };
        course?: { id?: number; fullname?: string };
        instance?: number;
      };
      const url = e.url ?? e.action?.url ?? null;
      return {
        id: e.id,
        name: e.name,
        courseId: e.course?.id ?? 0,
        courseName: e.course?.fullname ?? "",
        dueDate: e.timesort ?? e.timestart ?? null,
        url,
        description: null,
        source: "calendar" as const,
        hidden: false,
        submission: "unknown" as const,
        cmid: cmidFromUrl(url),
      } satisfies Task;
    });
}

interface AssignMeta {
  duedate: number | null;
  cutoffdate: number | null;
}

/**
 * Intenta obtener metadatos reales de las tareas (fecha de entrega) vía
 * mod_assign_get_assignments para un conjunto de cursos. Devuelve un mapa cmid -> meta.
 * Si la función no está habilitada como AJAX en este Moodle, devuelve mapa vacío (el
 * llamador degrada a la fecha del calendario / sin fecha).
 */
async function fetchAssignMeta(
  session: Session,
  courseIds: number[],
): Promise<Map<number, AssignMeta>> {
  const byCmid = new Map<number, AssignMeta>();
  if (courseIds.length === 0) return byCmid;
  try {
    const data = (await postAjax(session, "mod_assign_get_assignments", {
      courseids: courseIds,
    })) as { courses?: { assignments?: unknown[] }[] } | null;

    for (const course of data?.courses ?? []) {
      for (const araw of course.assignments ?? []) {
        const a = araw as {
          cmid: number;
          duedate?: number;
          cutoffdate?: number;
        };
        byCmid.set(a.cmid, {
          duedate: a.duedate && a.duedate > 0 ? a.duedate : null,
          cutoffdate: a.cutoffdate && a.cutoffdate > 0 ? a.cutoffdate : null,
        });
      }
    }
  } catch (err) {
    if (!(err instanceof MoodleApiError)) throw err;
    // Función no disponible → degradar silenciosamente.
  }
  return byCmid;
}

export interface AllTasksResult {
  tasks: Task[];
  /** Cursos que no se pudieron barrer (id -> motivo), para transparencia. */
  scanErrors: { courseId: number; courseName: string; reason: string }[];
}

/**
 * Obtiene TODAS las tareas cruzando dos fuentes y deduplicando por cmid:
 *  1. Calendario (tareas con fecha próxima).
 *  2. Barrido de cada curso matriculado (core_course_get_contents) buscando módulos `assign`.
 *
 * Las tareas que salen sólo del barrido y no del calendario se marcan `hidden: true` — el
 * caso que causa entregas perdidas cuando el profesor no publica evento de calendario.
 */
export async function getAllTasks(
  session: Session,
  opts: { concurrency?: number; courses?: Course[] } = {},
): Promise<AllTasksResult> {
  const { concurrency = 5 } = opts;

  const [calendarTasks, courses] = await Promise.all([
    getUpcomingTasks(session).catch(() => [] as Task[]),
    opts.courses ? Promise.resolve(opts.courses) : getEnrolledCourses(session),
  ]);

  // cmids ya conocidos por el calendario, para marcar el resto como oculto.
  const calendarCmids = new Set(
    calendarTasks.map((t) => t.cmid).filter((c): c is number => c != null),
  );

  const scanErrors: AllTasksResult["scanErrors"] = [];

  // Barrer cada curso en paralelo (acotado).
  const perCourse = await mapLimit(courses, concurrency, async (course) => {
    try {
      const sections = await getCourseContents(session, course.id);
      const assignModules = sections
        .flatMap((s) => s.modules)
        .filter((m) => m.modname === "assign");

      const meta = await fetchAssignMeta(session, [course.id]);

      return assignModules.map((m) => {
        const md = meta.get(m.cmid);
        return {
          id: m.cmid,
          name: m.name,
          courseId: course.id,
          courseName: course.fullname,
          dueDate: md?.duedate ?? null,
          url: m.url,
          description: null,
          source: "course-scan" as const,
          hidden: !calendarCmids.has(m.cmid),
          submission: "unknown" as const,
          cmid: m.cmid,
        } satisfies Task;
      });
    } catch (err) {
      scanErrors.push({
        courseId: course.id,
        courseName: course.fullname,
        reason: (err as Error).message,
      });
      return [] as Task[];
    }
  });

  // Fusionar: partir del calendario, añadir del barrido lo que no esté ya (por cmid).
  const merged = new Map<string, Task>();
  const keyOf = (t: Task) =>
    t.cmid != null ? `cmid:${t.cmid}` : `ci:${t.courseId}:${t.name}`;

  for (const t of calendarTasks) merged.set(keyOf(t), t);
  for (const t of perCourse.flat()) {
    const key = keyOf(t);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, t);
    } else if (existing.dueDate == null && t.dueDate != null) {
      // Completar la fecha real si el calendario no la traía.
      merged.set(key, { ...existing, dueDate: t.dueDate });
    }
  }

  const tasks = [...merged.values()].sort((a, b) => {
    if (a.dueDate == null) return 1;
    if (b.dueDate == null) return -1;
    return a.dueDate - b.dueDate;
  });

  return { tasks, scanErrors };
}

/** Tareas de un solo curso (incluye ocultas). */
export async function getCourseTasks(
  session: Session,
  courseId: number,
  courseName = "",
): Promise<Task[]> {
  const sections = await getCourseContents(session, courseId);
  const assignModules = sections
    .flatMap((s) => s.modules)
    .filter((m) => m.modname === "assign");
  const meta = await fetchAssignMeta(session, [courseId]);

  // Cruzar con el calendario para marcar cuáles NO estaban publicadas.
  const calendarCmids = new Set(
    (await getUpcomingTasks(session).catch(() => []))
      .map((t) => t.cmid)
      .filter((c): c is number => c != null),
  );

  return assignModules
    .map((m) => {
      const md = meta.get(m.cmid);
      return {
        id: m.cmid,
        name: m.name,
        courseId,
        courseName,
        dueDate: md?.duedate ?? null,
        url: m.url,
        description: null,
        source: "course-scan" as const,
        hidden: !calendarCmids.has(m.cmid),
        submission: "unknown" as const,
        cmid: m.cmid,
      } satisfies Task;
    })
    .sort((a, b) => {
      if (a.dueDate == null) return 1;
      if (b.dueDate == null) return -1;
      return a.dueDate - b.dueDate;
    });
}
