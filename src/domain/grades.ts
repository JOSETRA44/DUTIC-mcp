import * as cheerio from "cheerio";
import { CHROME_USER_AGENT } from "../core/config.js";
import { SessionExpiredError } from "../core/errors.js";
import { fetchUnsa } from "../core/http.js";
import type { Session } from "../core/session.js";
import { getEnrolledCourses } from "./courses.js";
import { mapLimit } from "./concurrency.js";

export interface GradeItem {
  name: string;
  /** Tipo de ítem (Tarea, Asistencia, …) inferido del icono de Moodle. */
  type: string | null;
  /** Nota tal cual la muestra Moodle ("16,00") o null si está pendiente/vacía. */
  grade: string | null;
  /** Rango, p. ej. "0–20". */
  range: string | null;
  /** Porcentaje del ítem, p. ej. "80,00 %". */
  percentage: string | null;
  /** Ponderación del ítem en el total. */
  weight: string | null;
  isTotal: boolean;
}

export interface CourseGrades {
  courseId: number;
  courseName: string;
  items: GradeItem[];
  /** Nota total del curso, si Moodle la calcula. */
  total: string | null;
  totalPercentage: string | null;
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function textOrNull(v: string): string | null {
  const t = clean(v);
  if (!t || t === "-" || /^\(\s*vac[ií]o\s*\)$/i.test(t)) return null;
  return t;
}

/**
 * Extrae la nota numérica de la celda, descartando el menú de acciones que Moodle añade
 * ("… Acciones Análisis de calificaciones"). Devuelve el número tal cual ("9,64") o null.
 */
function parseGradeCell($: cheerio.CheerioAPI, cell: cheerio.Cheerio<any>): string | null {
  const clone = cell.clone();
  clone.find(".action-menu, .dropdown, .menubar, script, .accesshide").remove();
  const raw = clean(clone.text());
  const m = /-?\d+(?:[.,]\d+)?/.exec(raw);
  if (m) return m[0];
  return textOrNull(raw);
}

/**
 * Nombre limpio del ítem. La celda concatena el tipo (alt del icono) con el nombre, p. ej.
 * "TareaTarea Individual 01". Se prefiere el texto del enlace; si no, se quita el prefijo tipo.
 */
function itemName($: cheerio.CheerioAPI, cell: cheerio.Cheerio<any>, type: string | null): string {
  const link = clean(cell.find("a").first().text());
  if (link) return link;
  let name = clean(cell.text());
  if (type && name.startsWith(type)) name = name.slice(type.length).trim();
  return name;
}

/**
 * Descarga y parsea el reporte de notas del usuario de un curso
 * (grade/report/user/index.php). Devuelve cada ítem calificable con su nota, rango y peso.
 */
export async function getCourseGrades(
  session: Session,
  courseId: number,
  courseName = "",
): Promise<CourseGrades> {
  const url = `${session.siteUrl}/grade/report/user/index.php?id=${courseId}`;
  const res = await fetchUnsa(url, {
    headers: {
      Cookie: `MoodleSession=${session.moodleSession}`,
      "User-Agent": CHROME_USER_AGENT,
    },
  });
  if (res.status === 302 || res.status === 303) throw new SessionExpiredError();
  const html = await res.text();
  if (/login\/index\.php/.test(res.url)) throw new SessionExpiredError();

  const $ = cheerio.load(html);
  const items: GradeItem[] = [];
  let total: string | null = null;
  let totalPercentage: string | null = null;

  $("table.user-grade tbody tr").each((_, tr) => {
    const row = $(tr);
    const nameCell = row.find(".column-itemname").first();
    if (nameCell.length === 0) return;
    const type = clean(nameCell.find("img").first().attr("alt") ?? "") || null;
    const name = itemName($, nameCell, type);
    if (!name) return;

    const grade = parseGradeCell($, row.find(".column-grade").first());
    const range = textOrNull(row.find(".column-range").first().text());
    const percentage = textOrNull(row.find(".column-percentage").first().text());
    const weight = textOrNull(row.find(".column-weight").first().text());
    const isTotal = /total del curso/i.test(name);

    if (isTotal) {
      total = grade;
      totalPercentage = percentage;
    }
    // Saltar la fila cabecera del curso (sin datos).
    if (!isTotal && !grade && !range && !percentage && !weight) return;

    items.push({ name, type, grade, range, percentage, weight, isTotal });
  });

  return { courseId, courseName, items, total, totalPercentage };
}

/** Notas de todos los cursos matriculados (en paralelo, acotado). */
export async function getAllGrades(
  session: Session,
  concurrency = 4,
): Promise<CourseGrades[]> {
  const courses = await getEnrolledCourses(session);
  return mapLimit(courses, concurrency, (c) =>
    getCourseGrades(session, c.id, c.fullname).catch(() => ({
      courseId: c.id,
      courseName: c.fullname,
      items: [],
      total: null,
      totalPercentage: null,
    })),
  );
}
