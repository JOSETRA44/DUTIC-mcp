import * as cheerio from "cheerio";
import { CHROME_USER_AGENT } from "../core/config.js";
import { SessionExpiredError } from "../core/errors.js";
import { fetchUnsa } from "../core/http.js";
import { daysBetween, findSpanishDates, parseSpanishDate } from "../core/dates.js";
import type { Session } from "../core/session.js";
import type { SubmissionStatus } from "../core/models.js";

export interface AssignAttachment {
  filename: string;
  url: string;
}

export interface AssignDetail {
  submission: SubmissionStatus;
  grade: string | null;
  /** epoch (segundos) de la fecha de entrega, si se puede extraer de la página. */
  dueDate: number | null;
  timeRemaining: string | null;
  /** Consigna/instrucciones de la tarea (texto de .activity-description). */
  description: string | null;
  /** Archivos adjuntos a la consigna (guías, rúbricas…) — legibles con read_resource. */
  attachments: AssignAttachment[];
  /** Fecha oficial de apertura (epoch s) según Moodle. */
  openDate: number | null;
  /** Fecha oficial de cierre/entrega (epoch s) según Moodle. */
  closeDate: number | null;
  /**
   * Fechas escritas DENTRO de la consigna. Los profesores a veces indican aquí una fecha
   * distinta a la configurada en Moodle — la causa típica de entregas perdidas.
   */
  datesInDescription: { text: string; epoch: number | null }[];
  /**
   * true si alguna fecha de la consigna difiere en más de un día de la fecha oficial de
   * cierre. Señal de alerta: hay que avisar al usuario de la discrepancia.
   */
  dateConflict: boolean;
  /** Nombre de quien calificó (suele ser el docente del curso). */
  gradedBy: string | null;
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

  const gradedBy = kv.get("calificado por") ?? null;

  // Consigna/instrucciones de la tarea. Se excluye el árbol de archivos adjuntos, porque Moodle
  // renderiza ahí la FECHA DE SUBIDA del adjunto y se confundiría con una fecha de la consigna.
  const descEl = $(".activity-description").first();
  const descClone = descEl.clone();
  descClone
    .find('[id^="assign_files_tree"], .fileuploadsubmission, .fileuploadsubmissiontime')
    .remove();
  const description = descClone.length
    ? descClone.text().replace(/\s+/g, " ").trim() || null
    : null;

  // Adjuntos de la consigna (guías, rúbricas): el agente puede leerlos con read_resource.
  const attachments: AssignAttachment[] = [];
  const seenUrls = new Set<string>();
  descEl.find('a[href*="pluginfile.php"]').each((_, a) => {
    const href = $(a).attr("href");
    if (!href || seenUrls.has(href)) return;
    seenUrls.add(href);
    const filename =
      $(a).text().trim() ||
      decodeURIComponent(href.split("/").pop()?.split("?")[0] ?? "archivo");
    attachments.push({ filename, url: href });
  });

  // Fechas oficiales que Moodle muestra en la cabecera de la actividad.
  let openDate: number | null = null;
  let closeDate: number | null = null;
  $(".activity-dates div, [data-region='activity-dates'] div").each((_, e) => {
    const t = $(e).text().replace(/\s+/g, " ").trim();
    if (/^apertura/i.test(t)) openDate = parseSpanishDate(t);
    else if (/^cierre|^vencimiento/i.test(t)) closeDate = parseSpanishDate(t);
  });

  // Fecha de entrega: prioriza el cierre oficial; si no, una fila explícita de la tabla.
  let dueDate: number | null = closeDate;
  if (dueDate == null) {
    const fechaRow = kv.get("fecha de entrega");
    if (fechaRow) dueDate = parseSpanishDate(fechaRow);
  }

  // Fechas escritas dentro de la consigna y detección de discrepancia con la oficial.
  const datesInDescription = description ? findSpanishDates(description) : [];
  const dateConflict =
    closeDate != null &&
    datesInDescription.some(
      (d) => d.epoch != null && Math.abs(daysBetween(d.epoch, closeDate!)) > 1,
    );

  return {
    submission,
    grade,
    dueDate,
    timeRemaining,
    description,
    attachments,
    openDate,
    closeDate,
    datesInDescription,
    dateConflict,
    gradedBy,
  };
}
