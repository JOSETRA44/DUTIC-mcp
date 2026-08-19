import * as cheerio from "cheerio";
import { SisacadAuthError, SisacadProtocolError } from "../core/errors.js";
import { resolveSisacadLogin } from "../core/horarioStore.js";
import { fetchHorarioRaw, resolveEscuelaCode, sisacadLogin } from "../core/sisacadClient.js";

/**
 * Horario del sistema de matrícula (SISACAD extranet). La parte delicada es la tabla de la
 * semana: las celdas de curso llevan `rowspan` (una clase de 3 horas ocupa 3 filas y 1 columna de
 * día), así que hay que expandirlas contra la grilla de franjas horarias en vez de leer fila por
 * fila. `parseHorarioHtml` es puro y se prueba sin red (test/fixtures/horario/); `getHorario`
 * orquesta login + descarga + parseo para el CLI y el MCP.
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
}

export interface Horario {
  cui: string;
  name: string | null;
  school: string | null;
  /** Fecha que muestra la cabecera ("2026/08/19"). */
  date: string | null;
  blocks: HorarioBlock[];
}

const TIME_RE = /^(\d{2}:\d{2})\/(\d{2}:\d{2})$/;

/** Extrae el contenido de una celda: el <br> separa asignatura de aula. */
function cellContent(
  $: cheerio.CheerioAPI,
  cell: cheerio.Cheerio<any>,
): { subject: string; location: string | null } {
  const clone = $(cell).clone();
  clone.find("br").replaceWith("\n");
  const lines = clone
    .text()
    .split("\n")
    .map((s) => s.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);

  if (lines.length === 0) return { subject: "", location: null };
  const subject = lines[0];
  const rawLocation = lines.slice(1).join(" ");
  const location = rawLocation
    ? rawLocation.replace(/^\(/, "").replace(/\)$/, "").trim() || null
    : null;
  return { subject, location };
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

export function parseHorarioHtml(html: string): Horario {
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

      const { subject, location } = cellContent($, $(td));
      if (!subject) continue;

      const rowspan = Math.max(Number($(td).attr("rowspan") ?? "1") || 1, 1);
      blocks.push({ day: DAYS[day], start, end, subject, location });
      pending[day] = rowspan - 1;
    }
  });

  return {
    cui: headerValue($, "C.U.I.") ?? "",
    name: headerValue($, "NOMBRE"),
    school: headerValue($, "ESCUELA"),
    date: headerValue($, "FECHA"),
    blocks,
  };
}

/**
 * Orquesta el flujo completo: login con las credenciales guardadas, descarga del horario y
 * parseo. Sin `cui` usa el del propio usuario (lo devuelve el login); `depe` y `espe` por defecto
 * son también los del login (para consultar a un compañero de otra escuela hay que pasarlos).
 */
export async function getHorario(opts: {
  cui?: string;
  depe?: string;
  espe?: string;
} = {}): Promise<Horario> {
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

  const session = await sisacadLogin({ ...creds, escuela });
  const cui = opts.cui?.trim() || session.cui;
  const depe = opts.depe?.trim() || session.depe;
  const espe = opts.espe?.trim() || session.espe;

  const html = await fetchHorarioRaw(session, cui, depe, espe);
  return parseHorarioHtml(html);
}