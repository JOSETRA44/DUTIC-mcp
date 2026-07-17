import * as cheerio from "cheerio";
import { CHROME_USER_AGENT } from "../core/config.js";
import { SessionExpiredError } from "../core/errors.js";
import { fetchUnsa } from "../core/http.js";
import type { Session } from "../core/session.js";
import type { SubmissionStatus } from "../core/models.js";

export interface AssignDetail {
  submission: SubmissionStatus;
  grade: string | null;
  /** epoch (segundos) de la fecha de entrega, si se puede extraer de la página. */
  dueDate: number | null;
  timeRemaining: string | null;
}

const MONTHS_ES: Record<string, number> = {
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
  julio: 6, agosto: 7, septiembre: 8, setiembre: 8, octubre: 9,
  noviembre: 10, diciembre: 11,
};

/** Parsea fechas largas en español tipo "jueves, 19 de julio de 2026, 17:00" → epoch s. */
function parseSpanishDate(text: string): number | null {
  const m = /(\d{1,2})\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})(?:[,\s]+(\d{1,2}):(\d{2}))?/i.exec(
    text.toLowerCase(),
  );
  if (!m) return null;
  const day = Number(m[1]);
  const month = MONTHS_ES[m[2]];
  const year = Number(m[3]);
  if (month === undefined) return null;
  const hour = m[4] ? Number(m[4]) : 0;
  const min = m[5] ? Number(m[5]) : 0;
  const d = new Date(year, month, day, hour, min);
  return Math.floor(d.getTime() / 1000);
}

function classifySubmission(estadoEntrega: string, estadoCalif: string): SubmissionStatus {
  const e = estadoEntrega.toLowerCase();
  const g = estadoCalif.toLowerCase();
  if (/^calificado|(?<!sin )calificado/.test(g) && !/sin calificar/.test(g)) {
    return "graded";
  }
  if (/no se han realizado|no entregado|sin intento|nada entregado|todav[ií]a no/.test(e)) {
    return "not-submitted";
  }
  if (/enviado|entregado|para calificar/.test(e)) return "submitted";
  return "unknown";
}

/**
 * Descarga y parsea la página mod/assign/view.php de una tarea para extraer el estado de
 * entrega, la nota y (si aparece) la fecha de entrega. Es el complemento necesario a
 * core_courseformat_get_state, porque los eventos de calendario "de acción" sólo aparecen
 * cuando la tarea está pendiente y futura — no sirven para tareas ya entregadas o vencidas.
 */
export async function getAssignDetail(session: Session, url: string): Promise<AssignDetail> {
  const res = await fetchUnsa(url, {
    headers: {
      Cookie: `MoodleSession=${session.moodleSession}`,
      "User-Agent": CHROME_USER_AGENT,
    },
  });
  if (res.status === 302 || res.status === 303) throw new SessionExpiredError();
  const html = await res.text();
  if (/\/login\//.test(res.url) && /loginform|login\/index\.php/i.test(html)) {
    throw new SessionExpiredError();
  }
  const $ = cheerio.load(html);

  const kv = new Map<string, string>();
  $("table tr").each((_, tr) => {
    const cells = $(tr).find("th,td");
    if (cells.length >= 2) {
      const k = $(cells[0]).text().trim().replace(/\s+/g, " ").toLowerCase();
      const v = $(cells[1]).text().trim().replace(/\s+/g, " ");
      if (k && v && k.length < 60 && !kv.has(k)) kv.set(k, v);
    }
  });

  const estadoEntrega = kv.get("estado de la entrega") ?? "";
  const estadoCalif = kv.get("estado de la calificación") ?? "";
  const submission = classifySubmission(estadoEntrega, estadoCalif);

  const grade = kv.get("calificación") ?? null;
  const timeRemaining = kv.get("tiempo restante") ?? null;

  // Fecha de entrega: buscar una fila explícita; si no, dejar null (la app usará el calendario).
  let dueDate: number | null = null;
  const fechaRow = kv.get("fecha de entrega");
  if (fechaRow) dueDate = parseSpanishDate(fechaRow);

  return { submission, grade, dueDate, timeRemaining };
}
