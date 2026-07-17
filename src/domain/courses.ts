import { postAjax } from "../core/moodleClient.js";
import type { Session } from "../core/session.js";
import {
  type Course,
  type CourseModule,
  type CourseSection,
} from "../core/models.js";

/** Lista los cursos en los que el usuario está matriculado. */
export async function getEnrolledCourses(session: Session): Promise<Course[]> {
  const data = (await postAjax(
    session,
    "core_course_get_enrolled_courses_by_timeline_classification",
    { offset: 0, limit: 0, classification: "all", sort: "fullname" },
  )) as { courses?: unknown[] } | null;

  const courses = data?.courses ?? [];
  return courses.map((raw) => {
    const c = raw as {
      id: number;
      fullname: string;
      shortname: string;
      contacts?: { fullname?: string }[];
    };
    return {
      id: c.id,
      fullname: c.fullname,
      shortname: c.shortname,
      contacts: (c.contacts ?? [])
        .map((x) => x.fullname ?? "")
        .filter((s) => s.length > 0),
    };
  });
}

/** Un módulo tal como lo devuelve core_courseformat_get_state (cm[]). */
export interface StateModule {
  cmid: number;
  name: string;
  /** Nombre canónico del tipo de módulo: assign, folder, resource, url, label, quiz, ... */
  module: string;
  url: string | null;
  visible: boolean;
  uservisible: boolean;
  stealth: boolean;
  sectionId: number;
  completionState: number | null;
}

export interface CourseState {
  courseId: number;
  sections: { id: number; number: number; title: string; visible: boolean }[];
  modules: StateModule[];
}

/**
 * Obtiene el estado completo del curso vía core_courseformat_get_state — la API que usa la
 * propia página de curso de Moodle 4.x. En este Moodle (UNSA) está habilitada por AJAX,
 * mientras que core_course_get_contents está BLOQUEADA. Devuelve TODOS los módulos del curso
 * (incluidos assigns sin evento de calendario), que es lo que permite descubrir tareas ocultas.
 *
 * Nota: esta función devuelve su `data` como STRING JSON, no como objeto — hay que parsearlo.
 */
export async function getCourseState(
  session: Session,
  courseId: number,
): Promise<CourseState> {
  const raw = await postAjax(session, "core_courseformat_get_state", {
    courseid: courseId,
  });
  const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
    section?: { id: string | number; number?: number; section?: number; title?: string; visible?: boolean }[];
    cm?: {
      id: string | number;
      name: string;
      module: string;
      url?: string;
      visible?: boolean;
      uservisible?: boolean;
      stealth?: boolean;
      sectionid: string | number;
      completionstate?: number | null;
    }[];
  };

  const sections = (parsed.section ?? []).map((s) => ({
    id: Number(s.id),
    number: Number(s.number ?? s.section ?? 0),
    title: s.title ?? "",
    visible: s.visible !== false,
  }));

  const modules: StateModule[] = (parsed.cm ?? []).map((m) => ({
    cmid: Number(m.id),
    name: m.name,
    module: m.module,
    url: m.url ?? null,
    visible: m.visible !== false,
    uservisible: m.uservisible !== false,
    stealth: Boolean(m.stealth),
    sectionId: Number(m.sectionid),
    completionState: m.completionstate ?? null,
  }));

  return { courseId, sections, modules };
}

/**
 * Secciones y módulos de un curso, construidas a partir de core_courseformat_get_state.
 * Reemplaza al bloqueado core_course_get_contents.
 */
export async function getCourseContents(
  session: Session,
  courseId: number,
): Promise<CourseSection[]> {
  const state = await getCourseState(session, courseId);
  return state.sections.map((s) => {
    const modules: CourseModule[] = state.modules
      .filter((m) => m.sectionId === s.id)
      .map((m) => ({
        cmid: m.cmid,
        name: m.name,
        modname: m.module,
        url: m.url,
        visible: m.visible,
        instance: null,
      }));
    return { id: s.id, name: s.title, modules };
  });
}
