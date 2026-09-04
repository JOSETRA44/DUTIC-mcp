import * as cheerio from "cheerio";
import { SisacadAuthError, SisacadProtocolError } from "../core/errors.js";
import { resolveSisacadLogin } from "../core/horarioStore.js";
import {
  fetchCatalogRaw,
  fetchHorarioRaw,
  fetchScheduleRaw,
  resolveEscuelaCode,
  sisacadLogin,
  type SisacadSession,
} from "../core/sisacadClient.js";

/**
 * Horario del sistema de matrícula (SISACAD extranet). La parte delicada es la tabla de la
 * semana: las celdas de curso llevan `rowspan` (una clase de 3 horas ocupa 3 filas y 1 columna de
 * día), así que hay que expandirlas contra la grilla de franjas horarias en vez de leer fila por
 * fila. `parseHorarioHtml` es puro y se prueba sin red (test/fixtures/horario/); `getHorario`
 * orquesta login + descarga + parseo para el CLI y el MCP.
 *
 * El sistema expone además dos vistas más de la misma grilla, por eso el parser es genérico:
 * - "personal": celdas `ASIGNATURA <BR> (AULA)` (la de `getHorario`).
 * - "asignatura" (tipo_hora=3): celdas `Aula: <AULA>`; la asignatura va en la cabecera
 *   (CODIGO/ASIGNATURA). El listado previo es la oferta completa del ciclo (todas las secciones).
 * - "aula" (tipo_hora=2): celdas `ASIGNATURA <BR> (Grupo: A)`; el aula va en la cabecera (AULA).
 */

export const DAYS = ["Lunes", "Martes", "Miercoles", "Jueves", "Viernes"] as const;

/** Una clase en un día y franja concretos. */
export interface HorarioBlock {
  day: string;
  /** Hora de inicio "07:00". */
  start: string;
  /** Hora de fin "07:50". */
  end: string;
  subject: string;
  /** Aula/lugar, p.ej. "40.1-206/AULA 206 AFORO REAL 55"; null si no aparece. */
  location: string | null;
  /** Sección de la asignatura (vista por aula: "(Grupo: A)"); null si no aplica. */
  group: string | null;
}

export interface Horario {
  /** CUI del alumno (vista personal); "" si la vista no lo muestra. */
  cui: string;
  /** Nombre del alumno (vista personal); null si la vista no lo muestra. */
  name: string | null;
  school: string | null;
  /** Fecha que muestra la cabecera ("2026/08/19"). */
  date: string | null;
  /** Código de la asignatura (vista por asignatura, p.ej. "2501209"); null en el resto. */
  code: string | null;
  /** Lo que la vista pone en su cabecera: asignatura+sección o el aula; null en la personal. */
  label: string | null;
  blocks: HorarioBlock[];
}

/** Una asignatura de la oferta del ciclo (vista "Por Asignatura" sin seleccionar). */
export interface CourseOffering {
  code: string;
  name: string;
  /** Sección: "A", "B", "C"… (el valor del select es código+sección, p.ej. "2501209A"). */
  group: string;
  /** Cabecera del select, p.ej. "Primer año"; null si el sistema no la agrupó. */
  year: string | null;
}

/** Un aula del listado (vista "Por Aula" sin seleccionar). */
export interface AulaOffering {
  /** Código interno (el value del select). */
  code: string;
  name: string;
}

type GridMode = "personal" | "subject" | "aula";

const TIME_RE = /^(\d{2}:\d{2})\/(\d{2}:\d{2})$/;

/** Extrae el contenido de una celda según la vista: el <br> separa asignatura de aula/grupo. */
function cellParts(
  $: cheerio.CheerioAPI,
  cell: cheerio.Cheerio<any>,
  mode: GridMode,
): { subject: string; location: string | null; group: string | null } {
  const clone = $(cell).clone();
  clone.find("br").replaceWith("\n");
  const lines = clone
    .text()
    .split("\n")
    .map((s) => s.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);

  if (lines.length === 0) return { subject: "", location: null, group: null };

  if (mode === "subject") {
    // Vista por asignatura: la celda sólo dice "Aula: <aula>".
    const first = lines[0];
    const location = first.startsWith("Aula:")
      ? first.slice(5).trim() || null
      : first || null;
    return { subject: "", location, group: null };
  }

  const subject = lines[0];
  const rest = lines.slice(1).join(" ");
  const unwrap = (s: string) => s.replace(/^\(/, "").replace(/\)$/, "").trim() || null;

  if (mode === "aula") {
    // Vista por aula: "(Grupo: A)".
    const group = (unwrap(rest) ?? "").replace(/^Grupo:\s*/i, "").trim() || null;
    return { subject, location: null, group };
  }

  // Vista personal: la segunda línea es el aula entre paréntesis.
  return { subject, location: unwrap(rest), group: null };
}

/** Lee un par etiqueta→valor de la tabla de cabecera (C.U.I., NOMBRE, FECHA, ESCUELA…). */
function headerValue($: cheerio.CheerioAPI, label: string): string | null {
  const norm = (s: string) =>
    s.normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim().toLowerCase();
  const wanted = norm(label);
  let found: string | null = null;
  // children() y no find(): la cabecera vive en una tabla anidada, y find() arrastraría los tds
  // de la tabla interna (el td envoltorio tiene como "siguiente" el primer td de la cabecera).
  $("table tr").each((_, tr) => {
    if (found) return;
    const tds = $(tr).children("td").toArray();
    for (let i = 0; i + 1 < tds.length; i++) {
      const cell = norm($(tds[i]).text());
      if (cell.startsWith(wanted)) {
        found = $(tds[i + 1]).text().replace(/\s+/g, " ").trim();
        return;
      }
    }
  });
  return found;
}

/** Parsea la grilla semanal común a las tres vistas y rellena la cabecera correspondiente. */
function parseGridHtml(html: string, mode: GridMode): Horario {
  const $ = cheerio.load(html);

  // La grilla es la tabla cuya cabecera contiene los días de la semana.
  const grids: cheerio.Cheerio<any>[] = [];
  $("table").each((_, t) => {
    const $t = $(t);
    const text = $t.text();
    if (/Lunes/.test(text) && /Viernes/.test(text)) grids.push($t);
  });
  const grid = grids[0];
  if (!grid) {
    throw new SisacadProtocolError(
      "No se encontró la tabla de horario en la respuesta del sistema de matrícula.",
    );
  }

  const blocks: HorarioBlock[] = [];
  // Filas restantes que cada día sigue ocupado por una celda con rowspan de una fila anterior.
  const pending = new Array<number>(5).fill(0);

  grid.find("tr").each((_, tr) => {
    const tds = $(tr).children("td").toArray();
    if (tds.length === 0) return;

    const time = TIME_RE.exec($(tds[0]).text().replace(/\s+/g, " ").trim());
    if (!time) return; // fila espaciadora (colspan) o sin franja horaria
    const [, start, end] = time;

    let cellIdx = 1;
    for (let day = 0; day < 5; day++) {
      if (pending[day] > 0) {
        // Esta columna ya la ocupa una clase que empezó en una fila anterior.
        pending[day]--;
        continue;
      }
      const td = tds[cellIdx++];
      if (!td) continue;

      const { subject, location, group } = cellParts($, $(td), mode);
      // En la vista por asignatura el nombre va en la cabecera: la celda sólo aporta el aula.
      if (mode === "subject" ? !location : !subject) continue;

      const rowspan = Math.max(Number($(td).attr("rowspan") ?? "1") || 1, 1);
      blocks.push({ day: DAYS[day], start, end, subject, location, group });
      pending[day] = rowspan - 1;
    }
  });

  const cui = headerValue($, "C.U.I.") ?? "";
  const name = headerValue($, "NOMBRE");
  const code = headerValue($, "CODIGO");
  const label =
    mode === "subject"
      ? headerValue($, "ASIGNATURA")
      : mode === "aula"
        ? headerValue($, "AULA")
        : null;

  // Vista por asignatura: la cabecera trae "NOMBRE (A)"; se reparte entre subject y group.
  if (mode === "subject" && label) {
    const m = /^(.*?)\s*\(([A-Za-z])\)\s*$/.exec(label);
    for (const b of blocks) {
      b.subject = m ? m[1].trim() : label;
      b.group = m ? m[2].toUpperCase() : null;
    }
  }
  // Vista por aula: todas las celdas comparten el aula de la cabecera.
  if (mode === "aula" && label) {
    for (const b of blocks) b.location = label;
  }

  return { cui, name, school: headerValue($, "ESCUELA"), date: headerValue($, "FECHA"), code, label, blocks };
}

/** Vista personal: `ASIGNATURA <BR> (AULA)` por celda. */
export function parseHorarioHtml(html: string): Horario {
  return parseGridHtml(html, "personal");
}

/** Vista por asignatura: una grilla por asignatura-sección; el aula va en cada celda. */
export function parseSubjectScheduleHtml(html: string): Horario {
  return parseGridHtml(html, "subject");
}

/** Vista por aula: todo lo que se dicta en un aula; la asignatura+grupo va en cada celda. */
export function parseAulaScheduleHtml(html: string): Horario {
  return parseGridHtml(html, "aula");
}

/** La oferta del ciclo: opciones del select "codi_asig_grup" (código + sección, por año). */
export function parseCourseCatalog(html: string): CourseOffering[] {
  const $ = cheerio.load(html);
  const out: CourseOffering[] = [];
  let year: string | null = null;
  $('select[name="codi_asig_grup"] option').each((_, el) => {
    const $el = $(el);
    const value = ($el.attr("value") ?? "").trim();
    const text = $el.text().replace(/\s+/g, " ").trim();
    if (!value || value === "0") {
      // Cabeceras del select: "<- Primer año ------------------------------>"
      const clean = text.replace(/^<-\s*/, "").replace(/\s*-+>\s*$/, "").trim();
      year = clean && clean !== "Seleccione Asignatura" ? clean : null;
      return;
    }
    const m = /^(\d{3,})([A-Za-z])$/.exec(value);
    if (!m) return;
    const name = text.replace(/^\d+\s*-\s*/, "").replace(/\s*\(([A-Za-z])\)\s*$/, "");
    out.push({ code: m[1], name, group: m[2].toUpperCase(), year });
  });
  return out;
}

/** Listado de aulas: opciones del select "codi_aula". */
export function parseAulaList(html: string): AulaOffering[] {
  const $ = cheerio.load(html);
  const out: AulaOffering[] = [];
  $('select[name="codi_aula"] option').each((_, el) => {
    const $el = $(el);
    const value = ($el.attr("value") ?? "").trim();
    if (!/^\d+$/.test(value) || value === "0") return;
    out.push({ code: value, name: $el.text().replace(/\s+/g, " ").trim() });
  });
  return out;
}

/** Nombre de la escuela que el sistema pone en la cabecera (p.ej. "ECONOMÍA"). */
export function parseSchoolName(html: string): string | null {
  return headerValue(cheerio.load(html), "ESCUELA");
}

/**
 * Resuelve el `codi_depe` del horario. Acepta el código de dependencia tal cual ("470"), el
 * código de Escuela/Programa del login ("4700" → "470": el depe es escuela/10) o el nombre
 * ("ECONOMÍA"), consultando las opciones reales del login cuando hace falta.
 */
async function resolveDepe(
  opts: { depe?: string; escuela?: string },
  session: SisacadSession,
): Promise<string> {
  const raw = opts.depe?.trim() ?? opts.escuela?.trim();
  if (!raw) return session.depe;
  if (/^\d{3}$/.test(raw)) return raw;
  const code = /^\d{4}$/.test(raw) ? raw : await resolveEscuelaCode(raw);
  return String(Math.floor(Number(code) / 10));
}

/**
 * Login + llamada con reintento automático: si una operación larga (catálogo, horario de varias
 * vistas) se topa con la sesión caducada a mitad, se reloguea una vez y se reintenta.
 */
async function withSession<T>(fn: (session: SisacadSession) => Promise<T>): Promise<T> {
  const creds = await resolveSisacadLogin();
  if (!creds) {
    throw new SisacadAuthError(
      "No hay credenciales del sistema de matrícula. Ejecuta `dutic hrs login`.",
    );
  }

  // El código de escuela puede venir como nombre ("ECONOMÍA") desde las variables de entorno;
  // el login sólo acepta el código numérico del select.
  const escuela = /^\d+$/.test(creds.escuela)
    ? creds.escuela
    : await resolveEscuelaCode(creds.escuela);

  try {
    const session = await sisacadLogin({ ...creds, escuela });
    return await fn(session);
  } catch (err) {
    if (err instanceof SisacadAuthError) {
      // Sesión caducada a mitad de la operación (o el primer login no fraguó): un intento más.
      const session = await sisacadLogin({ ...creds, escuela });
      return await fn(session);
    }
    throw err;
  }
}

/**
 * Orquesta el flujo completo: login con las credenciales guardadas, descarga del horario y
 * parseo. Sin `cui` usa el del propio usuario (lo devuelve el login); `depe` y `espe` por defecto
 * son también los del login (para consultar a un compañero de otra escuela hay que pasarlos).
 */
export async function getHorario(opts: {
  cui?: string;
  depe?: string;
  escuela?: string;
  espe?: string;
} = {}): Promise<Horario> {
  return withSession(async (session) => {
    const cui = opts.cui?.trim() || session.cui;
    const depe = await resolveDepe(opts, session);
    const espe = opts.espe?.trim() || session.espe;
    const html = await fetchHorarioRaw(session, cui, depe, espe);
    return parseHorarioHtml(html);
  });
}

/** Oferta de asignaturas del ciclo de una escuela (todas las secciones). */
export async function getCourseCatalog(opts: {
  depe?: string;
  escuela?: string;
  espe?: string;
} = {}): Promise<{ school: string | null; courses: CourseOffering[] }> {
  return withSession(async (session) => {
    const depe = await resolveDepe(opts, session);
    const html = await fetchCatalogRaw(session, depe, "course");
    return { school: parseSchoolName(html), courses: parseCourseCatalog(html) };
  });
}

/**
 * Horario semanal de una asignatura-sección. Acepta el código del select ("2501209A") o el código
 * pelado ("2501209"): en ese caso se resuelve la sección contra la oferta (error si hay varias).
 */
export async function getSubjectSchedule(
  codigo: string,
  opts: { depe?: string; escuela?: string; espe?: string } = {},
): Promise<Horario> {
  const cod = codigo.trim().toUpperCase();
  return withSession(async (session) => {
    const depe = await resolveDepe(opts, session);
    const full = /^\d{3,}[A-Z]$/.test(cod)
      ? cod
      : await resolveSubjectGroup(cod, session, depe);
    const html = await fetchScheduleRaw(session, depe, "course", full);
    return parseSubjectScheduleHtml(html);
  });
}

/** Si el usuario pasó sólo el código (sin sección), la resuelve contra el catálogo. */
async function resolveSubjectGroup(
  code: string,
  session: SisacadSession,
  depe: string,
): Promise<string> {
  const catalog = parseCourseCatalog(await fetchCatalogRaw(session, depe, "course"));
  const matches = catalog.filter((c) => c.code === code);
  if (matches.length === 0) {
    throw new SisacadAuthError(
      `Asignatura "${code}" no está en la oferta del ciclo (${catalog.length} asignaturas). ` +
        `Revisa con \`dutic hrs courses\`.`,
    );
  }
  if (matches.length > 1) {
    throw new SisacadAuthError(
      `La asignatura ${code} tiene ${matches.length} secciones (${matches
        .map((m) => m.group)
        .join(", ")}). Pasa el código completo, p.ej. ${code}${matches[0].group}.`,
    );
  }
  return `${matches[0].code}${matches[0].group}`;
}

/** Listado de aulas de la escuela. */
export async function getAulaList(opts: {
  depe?: string;
  escuela?: string;
  espe?: string;
} = {}): Promise<{ school: string | null; aulas: AulaOffering[] }> {
  return withSession(async (session) => {
    const depe = await resolveDepe(opts, session);
    const html = await fetchCatalogRaw(session, depe, "aula");
    return { school: parseSchoolName(html), aulas: parseAulaList(html) };
  });
}

/** Horario semanal de un aula: qué asignaturas (y secciones) se dictan ahí y cuándo. */
export async function getAulaSchedule(
  aula: string,
  opts: { depe?: string; escuela?: string; espe?: string } = {},
): Promise<Horario> {
  const target = aula.trim();
  return withSession(async (session) => {
    const depe = await resolveDepe(opts, session);
    const fetchOne = async (code: string) =>
      parseAulaScheduleHtml(await fetchScheduleRaw(session, depe, "aula", code));
    if (!/^\d+$/.test(target)) {
      return fetchOne(await resolveAulaCode(target, session, depe));
    }
    try {
      // Primero se intenta como código interno (15446…). Si no hay horario, es probablemente un
      // nombre tipo '105': se resuelve contra el listado (que da error claro si es ambiguo).
      return await fetchOne(target);
    } catch {
      return fetchOne(await resolveAulaCode(target, session, depe));
    }
  });
}

/** Resuelve un aula por código o por nombre (subcadena, sin distinguir acentos). */
async function resolveAulaCode(
  name: string,
  session: SisacadSession,
  depe: string,
): Promise<string> {
  const norm = (s: string) =>
    s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const aulas = parseAulaList(await fetchCatalogRaw(session, depe, "aula"));
  const target = norm(name);
  const matches = aulas.filter(
    (a) => a.name === name || norm(a.name).includes(target),
  );
  if (matches.length === 0) {
    throw new SisacadAuthError(
      `No encontré el aula "${name}" (${aulas.length} aulas en la escuela). ` +
        `Revisa con \`dutic hrs aulas\`.`,
    );
  }
  if (matches.length > 1) {
    throw new SisacadAuthError(
      `"${name}" coincide con ${matches.length} aulas: ${matches
        .map((m) => m.name)
        .join(" | ")}. Sé más específico o pasa el código.`,
    );
  }
  return matches[0].code;
}