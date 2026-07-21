import * as cheerio from "cheerio";
import { CHROME_USER_AGENT } from "../core/config.js";
import { SessionExpiredError } from "../core/errors.js";
import { fetchUnsa } from "../core/http.js";
import type { Session } from "../core/session.js";
import { getCourseState, getEnrolledCourses } from "./courses.js";
import { getAssignDetail } from "./assign.js";
import { mapLimit } from "./concurrency.js";

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

export interface PersonProfile {
  userId: number;
  name: string;
  email: string | null;
  timezone: string | null;
  /** Cursos en los que esa persona coincide contigo. */
  courses: string[];
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
  const { withEmail = false, concurrency = 8 } = opts;
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
    // Fin de la paginación: la página no trajo nadie nuevo, o ya tenemos el total declarado.
    if (byUser.size === before || rows.length < PER_PAGE) break;
    if (declaredTotal != null && byUser.size >= declaredTotal) break;
  }

  const people = [...byUser.values()];
  if (!withEmail) return people;

  return mapLimit(people, concurrency, async (p) => {
    const prof = await getPersonProfile(session, p.userId, courseId, p.name).catch(() => null);
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

  // En contexto de curso el <h1> puede ser el nombre del curso, así que se prefiere el nombre
  // ya conocido del listado de participantes.
  const heading = clean($(".page-header-headings h1").first().text());
  const name = fallbackName || heading || `usuario ${userId}`;

  const email = extractEmail($);

  const profileText = $(".userprofile, #region-main").text();
  // Cortar en la siguiente mayúscula para no arrastrar el texto pegado ("America/LimaDetalles").
  const timezone = /(?:America|Europe|Asia)\/[A-Z][a-z_]+|UTC[+-]?\d*/.exec(profileText)?.[0] ?? null;

  // Enlaces a cursos del perfil, descartando etiquetas genéricas ("Curso", "Cursos"…).
  const courses = $('.userprofile a[href*="course/view.php"], a[href*="course/view.php"]')
    .map((_, a) => clean($(a).text()))
    .get()
    .filter((t) => t.length > 8 && !/^cursos?$/i.test(t));

  return { userId, name, email, timezone, courses: [...new Set(courses)] };
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

export interface SharedCourse {
  courseId: number;
  courseName: string;
  group: string | null;
  role: string | null;
}

export interface PersonMatch {
  userId: number;
  name: string;
  email: string | null;
  lastAccess: string | null;
  /** TODOS los cursos donde esa persona coincide contigo. */
  courses: SharedCourse[];
  /** Cursos que Moodle lista en su perfil (puede incluir alguno más que el cruce anterior). */
  profileCourses: string[];
}


/** Normaliza para comparar ignorando mayúsculas y acentos. */
const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/**
 * Busca personas entre los participantes de TODOS tus cursos, por nombre o por correo.
 * Agrega **todos los cursos** en los que cada persona coincide contigo (no sólo el primero) y
 * resuelve su correo institucional, para poder responder "quién es y dónde lo tengo".
 */
export async function findPeople(
  session: Session,
  query: string,
  opts: { concurrency?: number } = {},
): Promise<PersonMatch[]> {
  const { concurrency = 4 } = opts;
  const looksLikeEmail = /@/.test(query);
  const q = fold(query);

  const courses = await getEnrolledCourses(session);
  const perCourse = await mapLimit(courses, concurrency, async (c) => {
    const list = await listCourseParticipants(session, c.id).catch(() => [] as Participant[]);
    return list.map((p) => ({ p, courseName: c.fullname }));
  });

  // Agrupar por persona acumulando TODOS los cursos compartidos.
  const byUser = new Map<number, PersonMatch>();
  for (const { p, courseName } of perCourse.flat()) {
    const shared: SharedCourse = {
      courseId: p.courseId,
      courseName,
      group: p.group,
      role: p.role,
    };
    const existing = byUser.get(p.userId);
    if (existing) {
      if (!existing.courses.some((x) => x.courseId === shared.courseId)) {
        existing.courses.push(shared);
      }
    } else {
      byUser.set(p.userId, {
        userId: p.userId,
        name: p.name,
        email: null,
        lastAccess: p.lastAccess,
        courses: [shared],
        profileCourses: [],
      });
    }
  }

  const candidates = [...byUser.values()];
  const byName = candidates.filter((p) => fold(p.name).includes(q));
  // Buscar por correo obliga a abrir todos los perfiles; por nombre basta con los que casan.
  const pool = looksLikeEmail ? candidates : byName;

  const enriched = await mapLimit(pool, concurrency, async (p) => {
    const prof = await getPersonProfile(
      session,
      p.userId,
      p.courses[0]?.courseId,
      p.name,
    ).catch(() => null);
    return { ...p, email: prof?.email ?? null, profileCourses: prof?.courses ?? [] };
  });

  return enriched.filter(
    (p) => fold(p.name).includes(q) || (p.email ?? "").toLowerCase().includes(q),
  );
}
