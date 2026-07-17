import { postAjax } from "../core/moodleClient.js";
import type { Session } from "../core/session.js";
import type { Course, Task } from "../core/models.js";
import { getCourseState, getEnrolledCourses, type StateModule } from "./courses.js";
import { getAssignDetail } from "./assign.js";
import { mapLimit } from "./concurrency.js";

/** Extrae el course module id (cmid) de una URL tipo mod/assign/view.php?id=123. */
function cmidFromUrl(url: string | null | undefined): number | null {
  if (!url) return null;
  const m = /[?&]id=(\d+)/.exec(url);
  return m ? Number(m[1]) : null;
}

/**
 * Prioridad por estado de entrega: lo NO entregado es lo urgente y va primero, sin importar
 * su fecha; lo ya entregado/calificado baja al fondo. Es el orden que evita perder entregas.
 */
function urgencyRank(t: Task): number {
  switch (t.submission) {
    case "not-submitted":
      return 0;
    case "unknown":
      return 1;
    case "submitted":
      return 2;
    case "graded":
      return 3;
    default:
      return 1;
  }
}

/**
 * Ordena por urgencia: primero las pendientes (SIN ENTREGAR), y dentro de cada grupo por
 * fecha de entrega ascendente (vencidas y próximas arriba; sin fecha al final del grupo).
 */
function sortByUrgency(a: Task, b: Task): number {
  const ra = urgencyRank(a);
  const rb = urgencyRank(b);
  if (ra !== rb) return ra - rb;
  if (a.dueDate == null && b.dueDate == null) return 0;
  if (a.dueDate == null) return 1;
  if (b.dueDate == null) return -1;
  return a.dueDate - b.dueDate;
}

/**
 * Tareas del "timeline" del estudiante vía core_calendar_get_action_events_by_timesort.
 * Es lo que la app previa mostraba: SÓLO tareas accionables (futuras y sin entregar). Las
 * tareas ya entregadas, vencidas o sin fecha NO salen aquí — por eso "se esconden".
 */
export async function getUpcomingTasks(session: Session, limitNum = 50): Promise<Task[]> {
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
        grade: null,
        timeRemaining: null,
        cmid: cmidFromUrl(url),
      } satisfies Task;
    });
}

/** Convierte un módulo assign del estado del curso en una Task preliminar. */
function assignToTask(
  m: StateModule,
  course: { id: number; fullname: string },
  timeline: Map<number, Task>,
): Task {
  const inTimeline = timeline.get(m.cmid);
  return {
    id: m.cmid,
    name: m.name,
    courseId: course.id,
    courseName: course.fullname,
    dueDate: inTimeline?.dueDate ?? null,
    url: m.url,
    description: null,
    source: "course-scan",
    hidden: !inTimeline, // no aparece en el timeline del estudiante → oculta
    submission: "unknown",
    grade: null,
    timeRemaining: null,
    cmid: m.cmid,
  };
}

/** Enriquecer una tarea scrapeando su página (estado de entrega, nota, fecha, tiempo restante). */
async function enrichTask(session: Session, task: Task): Promise<Task> {
  if (!task.url) return task;
  try {
    const d = await getAssignDetail(session, task.url);
    return {
      ...task,
      submission: d.submission,
      grade: d.grade ?? task.grade,
      dueDate: task.dueDate ?? d.dueDate,
      timeRemaining: d.timeRemaining,
    };
  } catch {
    return task; // no romper el barrido por un fallo puntual
  }
}

export interface AllTasksResult {
  tasks: Task[];
  scanErrors: { courseId: number; courseName: string; reason: string }[];
}

export interface AllTasksOptions {
  concurrency?: number;
  courses?: Course[];
  /** Si true (por defecto), scrapea cada tarea para su estado de entrega/nota. */
  enrich?: boolean;
}

/**
 * Obtiene TODAS las tareas de todos los cursos, incluidas las OCULTAS (las que no aparecen en
 * el timeline del estudiante). Estrategia validada para el Moodle de la UNSA:
 *  1. core_courseformat_get_state por curso → descubre TODOS los módulos assign (fuente fiable;
 *     core_course_get_contents y mod_assign_get_assignments están bloqueadas aquí).
 *  2. core_calendar_get_action_events_by_timesort → marca cuáles están en el timeline (no ocultas)
 *     y aporta su fecha de entrega exacta.
 *  3. (enrich) scraping de mod/assign/view.php por tarea → estado de entrega, nota, tiempo restante.
 */
export async function getAllTasks(
  session: Session,
  opts: AllTasksOptions = {},
): Promise<AllTasksResult> {
  const { concurrency = 5, enrich = true } = opts;

  const [timelineTasks, courses] = await Promise.all([
    getUpcomingTasks(session).catch(() => [] as Task[]),
    opts.courses ? Promise.resolve(opts.courses) : getEnrolledCourses(session),
  ]);

  const timeline = new Map<number, Task>();
  for (const t of timelineTasks) if (t.cmid != null) timeline.set(t.cmid, t);

  const scanErrors: AllTasksResult["scanErrors"] = [];

  // 1) Descubrir assigns por curso (concurrencia acotada).
  const perCourse = await mapLimit(courses, concurrency, async (course) => {
    try {
      const state = await getCourseState(session, course.id);
      return state.modules
        .filter((m) => m.module === "assign" && m.uservisible)
        .map((m) => assignToTask(m, course, timeline));
    } catch (err) {
      scanErrors.push({
        courseId: course.id,
        courseName: course.fullname,
        reason: (err as Error).message,
      });
      return [] as Task[];
    }
  });

  let tasks = perCourse.flat();

  // 2) Enriquecer con estado de entrega/nota (scraping), concurrencia acotada.
  if (enrich) {
    tasks = await mapLimit(tasks, Math.max(concurrency, 6), (t) => enrichTask(session, t));
  }

  tasks.sort(sortByUrgency);
  return { tasks, scanErrors };
}

/** Tareas de un solo curso (incluye ocultas), con estado de entrega. */
export async function getCourseTasks(
  session: Session,
  courseId: number,
  courseName = "",
  opts: { enrich?: boolean } = {},
): Promise<Task[]> {
  const { enrich = true } = opts;
  const [state, timelineTasks] = await Promise.all([
    getCourseState(session, courseId),
    getUpcomingTasks(session).catch(() => [] as Task[]),
  ]);
  const timeline = new Map<number, Task>();
  for (const t of timelineTasks) if (t.cmid != null) timeline.set(t.cmid, t);

  let tasks = state.modules
    .filter((m) => m.module === "assign" && m.uservisible)
    .map((m) => assignToTask(m, { id: courseId, fullname: courseName }, timeline));

  if (enrich) {
    tasks = await mapLimit(tasks, 6, (t) => enrichTask(session, t));
  }
  tasks.sort(sortByUrgency);
  return tasks;
}
