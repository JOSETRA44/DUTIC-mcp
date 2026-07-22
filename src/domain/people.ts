import * as cheerio from "cheerio";
import { CHROME_USER_AGENT } from "../core/config.js";
import { SessionExpiredError } from "../core/errors.js";
import { fetchUnsa } from "../core/http.js";
import type { Session } from "../core/session.js";
import { getCourseState, getEnrolledCourses } from "./courses.js";
import { getAssignDetail } from "./assign.js";
import { mapLimit } from "./concurrency.js";
import { parseCourseName } from "../core/coursename.js";

export interface Participant {
  userId: number;
  name: string;
  /** Rol tal cual lo muestra Moodle (Estudiante, Docente…). */
  role: string | null;
  group: string | null;
  lastAccess: string | null;
  courseId: number;
  /** Correo institucional; sólo se rellena si se pide (requiere abrir el perfil). */
  email?: string | null;
}

export interface ProfileCourse {
  /** id real del curso de ESA persona (puede diferir del mío: otra sección). */
  courseId: number;
  /** Asignatura limpia (sin prefijo ni grupo). */
  subject: string;
  /** Grupo/sección (GA → Grupo A). */
  group: string | null;
  fullname: string;
}

export interface PersonProfile {
  userId: number;
  name: string;
  email: string | null;
  timezone: string | null;
  /** TODOS los cursos que esa persona lleva (según su perfil), con su course id y grupo reales. */
  courses: ProfileCourse[];
}

function headers(session: Session): Record<string, string> {
  return {
    Cookie: `MoodleSession=${session.moodleSession}`,
    "User-Agent": CHROME_USER_AGENT,
  };
}

async function getHtml(session: Session, url: string): Promise<string> {
  const res = await fetchUnsa(url, { headers: headers(session) }, 45_000);
  if (res.status === 302 || res.status === 303) throw new SessionExpiredError();
  const html = await res.text();
  if (/\/login\//.test(res.url) && /loginform/i.test(html)) throw new SessionExpiredError();
  return html;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

const EMAIL_RE = /[\w.+-]+@[\w.-]+\.\w{2,}/;

/**
 * Extrae el correo del perfil. Moodle lo ofusca percent-encoding los caracteres del mailto
 * (anti-spam), p. ej. "%79%67...@%75ns%61.pe", así que hay que decodificarlo.
 */
function extractEmail($: cheerio.CheerioAPI): string | null {
  const mailto = $('a[href^="mailto:"]').first().attr("href");
  if (mailto) {
    const raw = mailto.slice("mailto:".length);
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      /* si no es percent-encoding válido, se usa tal cual */
    }
    const m = EMAIL_RE.exec(decoded);
    if (m) return m[0];
  }
  const body = $(".userprofile, #region-main").text();
  return EMAIL_RE.exec(body)?.[0] ?? null;
}

/**
 * Lista los participantes visibles de un curso. Ojo: si el curso usa "grupos separados", Moodle
 * sólo muestra a los del propio grupo del usuario (es lo mismo que ve en la web).
 */
/** Parsea las filas de participantes de una página del listado. */
function parseParticipantRows(html: string, courseId: number): Participant[] {
  const $ = cheerio.load(html);
  const people: Participant[] = [];
  $("table#participants tbody tr").each((_, tr) => {
    const cells = $(tr).find("th,td");
    // La primera celda es el checkbox; el nombre (con enlace al perfil) va en la segunda.
    // Moodle rellena la tabla con filas vacías hasta `perpage`, por eso se exige el enlace.
    const nameCell = cells.length > 1 ? $(cells[1]) : $(cells[0]);
    const link = nameCell.find('a[href*="user/view.php"]').first();
    const href = link.attr("href") ?? "";
    const userId = Number(/id=(\d+)/.exec(href)?.[1] ?? 0);
    const name = clean(link.text()) || clean(nameCell.text());
    if (!userId || !name) return;
    people.push({
      userId,
      name,
      role: clean($(cells[2]).text()) || null,
      group: clean($(cells[3]).text()) || null,
      lastAccess: clean($(cells[4]).text()) || null,
      courseId,
    });
  });
  return people;
}

/** Total de participantes que declara la página ("N participantes encontrados"). */
function parseDeclaredTotal(html: string): number | null {
  const m = /(\d+)\s+participantes?\s+encontrad/i.exec(cheerio.load(html)("body").text());
  return m ? Number(m[1]) : null;
}

const PER_PAGE = 100;

export interface ParticipantsOptions {
  /** Resuelve el correo de cada participante (abre su perfil; más lento). */
  withEmail?: boolean;
  concurrency?: number;
  /** Reporte de progreso (páginas cargadas, correos resueltos) para una carga visual. */
  onProgress?: (info: { phase: string; done: number; total: number; label?: string }) => void;
}

/**
 * Lista TODOS los participantes visibles de un curso, recorriendo la paginación de Moodle
 * (`page=0,1,2…`) hasta agotarla — no sólo la primera página. Ojo: si el curso usa "grupos
 * separados", Moodle sólo muestra a los del propio grupo del usuario (es lo mismo que ve en la web).
 */
export async function listCourseParticipants(
  session: Session,
  courseId: number,
  opts: ParticipantsOptions = {},
): Promise<Participant[]> {
  const { withEmail = false, concurrency = 8, onProgress } = opts;
  const byUser = new Map<number, Participant>();
  let declaredTotal: number | null = null;

  for (let page = 0; page < 50; page++) {
    const html = await getHtml(
      session,
      `${session.siteUrl}/user/index.php?id=${courseId}&page=${page}&perpage=${PER_PAGE}`,
    );
    if (page === 0) declaredTotal = parseDeclaredTotal(html);
    const rows = parseParticipantRows(html, courseId);
    const before = byUser.size;
    for (const p of rows) if (!byUser.has(p.userId)) byUser.set(p.userId, p);
    onProgress?.({
      phase: "páginas",
      done: page + 1,
      total: declaredTotal ? Math.ceil(declaredTotal / PER_PAGE) : page + 1,
      label: `${byUser.size} participantes`,
    });
    // Fin de la paginación: la página no trajo nadie nuevo, o ya tenemos el total declarado.
    if (byUser.size === before || rows.length < PER_PAGE) break;
    if (declaredTotal != null && byUser.size >= declaredTotal) break;
  }

  const people = [...byUser.values()];
  if (!withEmail) return people;

  let done = 0;
  return mapLimit(people, concurrency, async (p) => {
    const prof = await getPersonProfile(session, p.userId, courseId, p.name).catch(() => null);
    onProgress?.({ phase: "correos", done: ++done, total: people.length, label: p.name });
    return { ...p, email: prof?.email ?? null };
  });
}

/**
 * Perfil de una persona: correo institucional, zona horaria y cursos compartidos. Moodle oculta
 * el correo en el listado pero lo muestra en el perfil cuando la política del sitio lo permite.
 */
export async function getPersonProfile(
  session: Session,
  userId: number,
  courseId?: number,
  fallbackName?: string,
): Promise<PersonProfile> {
  const url = `${session.siteUrl}/user/view.php?id=${userId}${courseId ? `&course=${courseId}` : ""}`;
  const html = await getHtml(session, url);
  const $ = cheerio.load(html);

  // En contexto de curso el <h1> es el NOMBRE DEL CURSO, no de la persona. El nombre real está
  // en el alt de la foto de perfil o en el <title> tras "Información personal:".
  const looksLikeCourse = (t: string) => /^\d{2}[A-Z]\s+[A-ZÁÉÍÓÚÑ]/.test(t);
  const heading = clean($(".page-header-headings h1").first().text());
  const picAlt = clean($(".page-context-header img[alt]").attr("alt") ?? "");
  const titleName = clean(
    /informaci[oó]n personal:\s*([^|]+)/i.exec($("title").text())?.[1] ?? "",
  );
  const name =
    fallbackName ||
    picAlt ||
    titleName ||
    (heading && !looksLikeCourse(heading) ? heading : "") ||
    `usuario ${userId}`;

  const email = extractEmail($);

  const profileText = $(".userprofile, #region-main").text();
  // Cortar en la siguiente mayúscula para no arrastrar el texto pegado ("America/LimaDetalles").
  const timezone = /(?:America|Europe|Asia)\/[A-Z][a-z_]+|UTC[+-]?\d*/.exec(profileText)?.[0] ?? null;

  return { userId, name, email, timezone, courses: extractProfileCourses($) };
}

/**
 * Extrae los cursos REALES de la persona del nodo "Perfiles de curso". Cada curso es un enlace
 * `user/view.php?id=<userId>&course=<COURSE_ID>` cuyo texto es el nombre completo con su grupo.
 * El course id sale del propio enlace — así se identifica el curso exacto (y su sección), sin
 * confundirlo con un curso mío de nombre parecido pero otro grupo.
 */
function extractProfileCourses($: cheerio.CheerioAPI): ProfileCourse[] {
  const node = $(".node_category, .contentnode")
    .filter((_, e) => /perfiles de curso|course profiles/i.test($(e).text()))
    .first();
  const scope = node.length ? node : $(".userprofile");
  const out: ProfileCourse[] = [];
  const seen = new Set<number>();
  scope.find('a[href*="user/view.php"]').each((_, a) => {
    const href = $(a).attr("href") ?? "";
    const courseId = Number(/[?&]course=(\d+)/.exec(href)?.[1] ?? 0);
    const fullname = clean($(a).text());
    if (!courseId || seen.has(courseId) || fullname.length < 6) return;
    seen.add(courseId);
    const parsed = parseCourseName(fullname);
    out.push({ courseId, subject: parsed.subject, group: parsed.group, fullname });
  });
  return out;
}

/**
 * Docentes de un curso. En este Moodle los profesores no aparecen en la lista de participantes
 * del alumno, así que se combinan dos fuentes: los "contactos" que expone la API de cursos y el
 * rol detectado en el listado (por si algún curso sí los muestra).
 */
export async function getCourseTeachers(
  session: Session,
  courseId: number,
): Promise<string[]> {
  const [courses, participants] = await Promise.all([
    getEnrolledCourses(session).catch(() => []),
    listCourseParticipants(session, courseId).catch(() => [] as Participant[]),
  ]);
  const fromApi = courses.find((c) => c.id === courseId)?.contacts ?? [];
  const fromList = participants
    .filter((p) => /docente|profesor|teacher/i.test(p.role ?? ""))
    .map((p) => p.name);

  // Tercera fuente (la que suele funcionar aquí): quién calificó las tareas del curso.
  let fromGrading: string[] = [];
  try {
    const state = await getCourseState(session, courseId);
    const assigns = state.modules.filter((m) => m.module === "assign" && m.url).slice(0, 12);
    const details = await mapLimit(assigns, 5, (m) =>
      getAssignDetail(session, m.url!).catch(() => null),
    );
    fromGrading = details
      .map((d) => d?.gradedBy)
      .filter((n): n is string => Boolean(n && n.length > 3));
  } catch {
    /* si falla, nos quedamos con las otras fuentes */
  }

  return [...new Set([...fromApi, ...fromList, ...fromGrading])];
}

export interface PersonCourse {
  /** Course id real de ESA persona (puede ser una sección distinta a la tuya). */
  courseId: number;
  subject: string;
  group: string | null;
  /** true si TÚ llevas exactamente ese curso (mismo course id). */
  shared: boolean;
}

export interface PersonMatch {
  userId: number;
  name: string;
  email: string | null;
  lastAccess: string | null;
  /** TODOS los cursos que la persona lleva (de su perfil), con flag `shared` por cada uno. */
  courses: PersonCourse[];
  /** Cuántos de esos cursos compartes con ella. */
  sharedCount: number;
}

/** Normaliza para comparar ignorando mayúsculas y acentos. */
const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

export interface FindPeopleOptions {
  concurrency?: number;
  /** Reporte de progreso: fase y avance, para mostrar una carga visual en el CLI. */
  onProgress?: (info: { phase: string; done: number; total: number; label?: string }) => void;
}

/**
 * Busca personas entre los participantes de TODOS tus cursos, por nombre o por correo. Para cada
 * coincidencia abre su PERFIL y extrae sus cursos reales (course id + grupo). Marca cuáles
 * compartes contigo por **course id exacto** — así nunca confunde tu sección con la suya (p. ej.
 * "Derecho GA" de la persona vs tu "Derecho GD"). Muestra qué cursos lleva y cuáles contigo.
 */
export async function findPeople(
  session: Session,
  query: string,
  opts: FindPeopleOptions = {},
): Promise<PersonMatch[]> {
  const { concurrency = 4, onProgress } = opts;
  const looksLikeEmail = /@/.test(query);
  const q = fold(query);

  const myCourses = await getEnrolledCourses(session);
  const myCourseIds = new Set(myCourses.map((c) => c.id));

  // 1) Localizar candidatos escaneando tus listas de participantes (con nombre + un curso de contexto).
  let scanned = 0;
  const perCourse = await mapLimit(myCourses, concurrency, async (c) => {
    const list = await listCourseParticipants(session, c.id).catch(() => [] as Participant[]);
    onProgress?.({ phase: "cursos", done: ++scanned, total: myCourses.length, label: c.fullname });
    return list.map((p) => ({ p, contextCourseId: c.id }));
  });

  const byUser = new Map<number, { p: Participant; contextCourseId: number }>();
  for (const item of perCourse.flat()) if (!byUser.has(item.p.userId)) byUser.set(item.p.userId, item);

  const candidates = [...byUser.values()];
  const pool = looksLikeEmail
    ? candidates
    : candidates.filter(({ p }) => fold(p.name).includes(q));

  // 2) Para cada candidato, abrir su perfil y extraer sus cursos reales (id + grupo).
  let done = 0;
  const enriched = await mapLimit(pool, concurrency, async ({ p, contextCourseId }) => {
    const prof = await getPersonProfile(session, p.userId, contextCourseId, p.name).catch(() => null);
    onProgress?.({ phase: "perfiles", done: ++done, total: pool.length, label: p.name });

    const courses: PersonCourse[] = (prof?.courses ?? []).map((pc) => ({
      courseId: pc.courseId,
      subject: pc.subject,
      group: pc.group,
      shared: myCourseIds.has(pc.courseId),
    }));
    // Si el perfil no expuso cursos, al menos deja constancia del curso donde lo encontraste.
    if (courses.length === 0) {
      const c = myCourses.find((x) => x.id === contextCourseId);
      if (c) {
        const parsed = parseCourseName(c.fullname);
        courses.push({ courseId: c.id, subject: parsed.subject, group: parsed.group, shared: true });
      }
    }
    courses.sort((a, b) => Number(b.shared) - Number(a.shared));

    return {
      userId: p.userId,
      name: prof?.name || p.name,
      email: prof?.email ?? null,
      lastAccess: p.lastAccess,
      courses,
      sharedCount: courses.filter((x) => x.shared).length,
    } satisfies PersonMatch;
  });

  return enriched.filter((p) => fold(p.name).includes(q) || (p.email ?? "").toLowerCase().includes(q));
}
