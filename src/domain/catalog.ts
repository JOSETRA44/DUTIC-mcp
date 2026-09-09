import * as cheerio from "cheerio";
import { withCache } from "../core/cache.js";
import { parseCourseName } from "../core/coursename.js";
import type { Session } from "../core/session.js";
import { mapLimit } from "./concurrency.js";
import { fetchAulaHtml } from "./fetch.js";
import { shouldPayForDeepLookup } from "./people.js";

/**
 * Catálogo institucional del aula: el árbol de categorías (áreas → Escuelas) y los cursos de
 * cada Escuela CON su docente, para cualquier carrera, sin estar matriculado en ella.
 *
 * Dos fuentes, porque ninguna sola sirve:
 *
 *  1. `course/index.php?categoryid=N&browse=courses&perpage=…` — es la lista AUTORITATIVA de qué
 *     cursos pertenecen a la Escuela, pero renderiza las fichas COLAPSADAS: sólo id y nombre.
 *  2. `course/search.php?search=…&perpage=…` — renderiza las fichas EXPANDIDAS, con docente y
 *     categoría, pero la pertenencia es difusa: busca por palabras y arrastra cursos de otras
 *     Escuelas.
 *
 * Se combinan: (1) fija el conjunto, (2) le pone los docentes, y la intersección por id descarta
 * los falsos positivos de la búsqueda. Dos peticiones por Escuela en vez de una por curso.
 *
 * El término de búsqueda NO se adivina a partir del nombre de la categoría: el prefijo de los
 * cursos es una abreviatura que no siempre coincide ("INGENIERÍA DE SISTEMAS" → "26B SISTEMAS:",
 * "LITERATURA Y LINGÜÍSTICA" → "26B LINGÜÍSTICA:"). Se extrae del propio listado del paso (1),
 * que ya tenemos delante. Medido sobre ECONOMÍA, DERECHO, SISTEMAS y LINGÜÍSTICA: 100% de los
 * cursos cubiertos.
 *
 * Los ids de categoría son POR SEMESTRE — cada período es un Moodle distinto — así que el árbol
 * se descubre y se cachea dentro del semestre activo, nunca se codifica.
 */

/** Tope de páginas a seguir por listado; con perpage alto sobra, pero evita un bucle infinito. */
const MAX_PAGES = 6;
const PER_PAGE = 500;
/**
 * Niveles a recorrer. El árbol real del aula es raíz → período ("2026-B") → área (SOCIALES) →
 * Escuela (ECONOMÍA): la Escuela está en el nivel 3, no en el 2 como sugiere la navegación (que
 * arranca ya dentro del período). Cuesta 6 peticiones y se cachea un día.
 */
const TREE_DEPTH = 3;

export interface CategoryNode {
  id: number;
  name: string;
  parentId: number | null;
  /** 1 = período ("2026-B"), 2 = área (SOCIALES…), 3 = Escuela (ECONOMÍA…). */
  depth: number;
}

export interface CategoryTree {
  categories: CategoryNode[];
  fetchedAt: number;
}

export interface CatalogTeacher {
  id: number;
  name: string;
  /** Rol tal cual lo etiqueta el aula: "Profesor", "Profesor no editor"… */
  role: string;
}

export interface CatalogCourse {
  id: number;
  fullname: string;
  /** Asignatura sin el prefijo de período/Escuela ni el sufijo de grupo. */
  subject: string;
  /** "Grupo A", "Grupo D-I"… o null. */
  group: string | null;
  url: string;
  teachers: CatalogTeacher[];
}

export interface SchoolCourses {
  category: CategoryNode | null;
  categoryId: number;
  categoryName: string;
  /** Ruta legible: ["SOCIALES", "ECONOMÍA"]. */
  path: string[];
  courses: CatalogCourse[];
  /** Cuántos cursos quedaron con docente conocido. */
  withTeachers: number;
  /** Término con el que se enriqueció (para poder reproducir la consulta a mano). */
  searchTerm: string | null;
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** Subcategorías directas que declara una página de categoría. */
function parseSubcategories(html: string, parentId: number | null, depth: number): CategoryNode[] {
  const $ = cheerio.load(html);
  const out: CategoryNode[] = [];
  $("div.category[data-categoryid]").each((_, el) => {
    const id = Number($(el).attr("data-categoryid"));
    const name = $(el).find(".categoryname a").first().text().replace(/\s+/g, " ").trim();
    if (id && name) out.push({ id, name, parentId, depth });
  });
  return out;
}

async function fetchCategoryTree(session: Session): Promise<CategoryTree> {
  const root = parseSubcategories(await fetchAulaHtml(session, "/course/index.php"), null, 1);
  const categories = [...root];

  let frontier = root;
  for (let depth = 2; depth <= TREE_DEPTH && frontier.length > 0; depth++) {
    const levels = await mapLimit(frontier, 3, async (parent) =>
      parseSubcategories(
        await fetchAulaHtml(session, `/course/index.php?categoryid=${parent.id}`),
        parent.id,
        depth,
      ),
    );
    frontier = levels.flat();
    categories.push(...frontier);
  }

  return { categories, fetchedAt: Date.now() };
}

/** Árbol de categorías del semestre activo. Cambia una vez por período: se cachea 24 h. */
export async function getCategoryTree(session: Session): Promise<CategoryTree> {
  // La "v1" es la versión de la FORMA del árbol, no del contenido: si cambia el recorrido o los
  // campos, subirla invalida lo cacheado en vez de dejar a la gente con un árbol viejo e
  // incompatible que no tiene forma de detectar.
  return withCache("catalog", ["tree", "v1", session.siteUrl], () => fetchCategoryTree(session));
}

/** Ruta legible de una categoría, de la raíz hacia abajo. */
export function categoryPath(tree: CategoryTree, id: number): string[] {
  const byId = new Map(tree.categories.map((c) => [c.id, c]));
  const path: string[] = [];
  let node = byId.get(id);
  while (node) {
    path.unshift(node.name);
    node = node.parentId === null ? undefined : byId.get(node.parentId);
  }
  return path;
}

/**
 * Busca categorías por id exacto o por nombre. Sin acentos y por subcadena, porque el usuario
 * escribe "sistemas" y la categoría se llama "INGENIERÍA DE SISTEMAS". Prioriza las Escuelas
 * (depth 3) sobre las áreas: preguntar por "económicas" casi siempre es preguntar por la Escuela.
 */
export function findCategories(tree: CategoryTree, query: string): CategoryNode[] {
  const q = query.trim();
  if (/^\d+$/.test(q)) {
    const exact = tree.categories.find((c) => c.id === Number(q));
    return exact ? [exact] : [];
  }
  const needle = fold(q);
  const hits = tree.categories.filter((c) => fold(c.name).includes(needle));
  const exact = hits.filter((c) => fold(c.name) === needle);
  const pool = exact.length > 0 ? exact : hits;
  return [...pool].sort((a, b) => b.depth - a.depth || a.name.localeCompare(b.name));
}

interface RawBox {
  id: number;
  fullname: string;
  teachers: CatalogTeacher[];
}

/** Fichas de curso de cualquier listado del aula (categoría o búsqueda). */
function parseCourseBoxes(html: string): RawBox[] {
  const $ = cheerio.load(html);
  const out: RawBox[] = [];
  $("div.coursebox[data-courseid]").each((_, el) => {
    const box = $(el);
    const id = Number(box.attr("data-courseid"));
    if (!id) return;
    const fullname = box.find(".coursename a").first().text().replace(/\s+/g, " ").trim();
    const teachers: CatalogTeacher[] = [];
    box.find("ul.teachers li").each((__, li) => {
      const a = $(li).find('a[href*="profile.php?id="]').first();
      const tid = Number(/[?&]id=(\d+)/.exec(a.attr("href") ?? "")?.[1] ?? 0);
      const name = a.text().replace(/\s+/g, " ").trim();
      const role = $(li).find("span").first().text().replace(/[\s:]+$/g, "").trim();
      if (tid && name) teachers.push({ id: tid, name, role: role || "Profesor" });
    });
    out.push({ id, fullname, teachers });
  });
  return out;
}

/** true si el listado anuncia páginas más allá de la actual. */
function hasNextPage(html: string, page: number): boolean {
  const $ = cheerio.load(html);
  return $(`li.page-item[data-page-number="${page + 2}"]`).length > 0;
}

async function fetchPagedBoxes(
  session: Session,
  buildUrl: (page: number) => string,
): Promise<RawBox[]> {
  const all: RawBox[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const html = await fetchAulaHtml(session, buildUrl(page));
    all.push(...parseCourseBoxes(html));
    if (!hasNextPage(html, page)) break;
  }
  return all;
}

/**
 * Prefijo dominante de un conjunto de nombres ("26B ECONOMÍA"). Se elige por votación en vez de
 * mirar el primero porque una Escuela puede tener algún curso suelto con otro prefijo.
 */
export function dominantPrefix(names: string[]): string | null {
  const votes = new Map<string, number>();
  for (const n of names) {
    const m = /^\s*(\d{2}[A-Za-z])\s+([^:]{2,60}):/.exec(n);
    if (!m) continue;
    const key = `${m[1].toUpperCase()} ${m[2].trim()}`;
    votes.set(key, (votes.get(key) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [key, count] of votes) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

export interface SchoolCoursesOptions {
  /** Traer también el docente. Cuesta una petición más (o unas cuantas si `deep`). */
  teachers?: boolean;
  /**
   * Rellenar los cursos que la búsqueda no cubrió abriendo su ficha una a una. Preciso pero
   * caro: sólo tiene sentido cuando faltan pocos.
   */
  deep?: boolean;
}

export async function listSchoolCourses(
  session: Session,
  categoryId: number,
  opts: SchoolCoursesOptions = {},
): Promise<SchoolCourses> {
  const { teachers = true, deep = false } = opts;

  const boxes = await fetchPagedBoxes(
    session,
    (page) =>
      `/course/index.php?categoryid=${categoryId}&browse=courses&perpage=${PER_PAGE}&page=${page}`,
  );

  const byId = new Map(boxes.map((b) => [b.id, b]));
  let searchTerm: string | null = null;

  if (teachers && boxes.length > 0) {
    searchTerm = dominantPrefix(boxes.map((b) => b.fullname));
    const term = searchTerm;
    if (term) {
      const found = await fetchPagedBoxes(
        session,
        (page) =>
          `/course/search.php?search=${encodeURIComponent(term)}&perpage=${PER_PAGE}&page=${page}`,
      );
      // La búsqueda desborda a otras Escuelas: sólo se acepta lo que ya estaba en el listado.
      for (const hit of found) {
        const mine = byId.get(hit.id);
        if (mine && hit.teachers.length > 0) mine.teachers = hit.teachers;
      }
    }

    // Con `deep` sin decidir, la política es la MISMA que ya gobierna la búsqueda cara de
    // docentes en `people.ts`: si faltan cuatro de 129 vale la pena rematarlo, si falta casi todo
    // es que algo más va mal. Compartir la función evita que las dos partes del proyecto acaben
    // con criterios distintos para la misma pregunta.
    const missingNow = boxes.filter((b) => b.teachers.length === 0).length;
    const worthIt = deep ?? shouldPayForDeepLookup(missingNow, boxes.length);

    if (worthIt) {
      const missing = boxes.filter((b) => b.teachers.length === 0);
      await mapLimit(missing, 4, async (b) => {
        const html = await fetchAulaHtml(session, `/course/info.php?id=${b.id}`);
        const [info] = parseCourseBoxes(html);
        if (info?.teachers.length) b.teachers = info.teachers;
      });
    }
  }

  const tree = await getCategoryTree(session).catch(() => null);
  const node = tree?.categories.find((c) => c.id === categoryId) ?? null;

  const courses: CatalogCourse[] = boxes.map((b) => {
    const parsed = parseCourseName(b.fullname);
    return {
      id: b.id,
      fullname: b.fullname,
      subject: parsed.subject,
      group: parsed.group,
      url: `${session.siteUrl}/course/view.php?id=${b.id}`,
      teachers: b.teachers,
    };
  });

  return {
    category: node,
    categoryId,
    categoryName: node?.name ?? `Categoría ${categoryId}`,
    path: tree ? categoryPath(tree, categoryId) : [],
    courses,
    withTeachers: courses.filter((c) => c.teachers.length > 0).length,
    searchTerm,
  };
}

export interface TeacherCourses {
  teacher: CatalogTeacher;
  courses: { id: number; fullname: string; subject: string; group: string | null; url: string }[];
}

/** Agrupa por docente los cursos de una Escuela: "¿qué dicta este profesor aquí?". */
export function groupByTeacher(school: SchoolCourses): TeacherCourses[] {
  const map = new Map<number, TeacherCourses>();
  for (const course of school.courses) {
    for (const t of course.teachers) {
      const entry = map.get(t.id) ?? { teacher: t, courses: [] };
      entry.courses.push({
        id: course.id,
        fullname: course.fullname,
        subject: course.subject,
        group: course.group,
        url: course.url,
      });
      map.set(t.id, entry);
    }
  }
  return [...map.values()].sort(
    (a, b) => b.courses.length - a.courses.length || a.teacher.name.localeCompare(b.teacher.name),
  );
}
