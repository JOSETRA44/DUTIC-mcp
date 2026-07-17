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

/**
 * Obtiene las secciones y módulos de un curso vía core_course_get_contents (habilitado como
 * AJAX en Moodle 4.x). Es la fuente autoritativa para descubrir TODOS los módulos del curso,
 * incluidas las tareas que no emiten evento de calendario.
 */
export async function getCourseContents(
  session: Session,
  courseId: number,
): Promise<CourseSection[]> {
  const data = (await postAjax(session, "core_course_get_contents", {
    courseid: courseId,
  })) as unknown[];

  const sections = Array.isArray(data) ? data : [];
  return sections.map((raw) => {
    const s = raw as {
      id: number;
      name?: string;
      modules?: unknown[];
    };
    const modules: CourseModule[] = (s.modules ?? []).map((mraw) => {
      const m = mraw as {
        id: number;
        name: string;
        modname: string;
        url?: string;
        visible?: number | boolean;
        instance?: number;
      };
      return {
        cmid: m.id,
        name: m.name,
        modname: m.modname,
        url: m.url ?? null,
        visible: m.visible === undefined ? true : Boolean(m.visible),
        instance: m.instance ?? null,
      };
    });
    return { id: s.id, name: s.name ?? "", modules };
  });
}
