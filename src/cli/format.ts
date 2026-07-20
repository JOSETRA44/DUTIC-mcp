import type { Task } from "../core/models.js";
import { c } from "./ui.js";

export function formatDate(epochSeconds: number | null): string {
  if (epochSeconds == null) return "sin fecha";
  const d = new Date(epochSeconds * 1000);
  return d.toLocaleString("es-PE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function relativeDue(epochSeconds: number | null): string {
  if (epochSeconds == null) return "";
  const diffMs = epochSeconds * 1000 - Date.now();
  const days = Math.round(diffMs / 86_400_000);
  if (days < 0) return `vencida hace ${Math.abs(days)}d`;
  if (days === 0) return "¡hoy!";
  if (days === 1) return "mañana";
  return `en ${days}d`;
}

const SUBMISSION: Record<string, (s: string) => string> = {
  submitted: c.green,
  "not-submitted": c.boldRed,
  graded: c.cyan,
  unknown: c.gray,
};

const SUBMISSION_LABEL: Record<string, string> = {
  submitted: "ENTREGADA",
  "not-submitted": "SIN ENTREGAR",
  graded: "CALIFICADA",
  unknown: "—",
};

/**
 * Renderiza una tarea como bloque de líneas alineadas. Marca de estado a la izquierda:
 * ● (pendiente, rojo) resalta lo urgente sin emojis.
 */
export function formatTaskLine(t: Task): string {
  const paint = SUBMISSION[t.submission] ?? c.gray;
  const dot = t.submission === "not-submitted" ? c.boldRed("●") : c.gray("○");
  const scope = t.hidden ? c.yellow("OCULTA") : c.dim("timeline");
  const state = paint(SUBMISSION_LABEL[t.submission] ?? "—");
  const grade = t.grade ? c.dim(` · nota ${t.grade}`) : "";
  const due = `${formatDate(t.dueDate)}${t.dueDate != null ? c.dim(` (${relativeDue(t.dueDate)})`) : ""}`;

  const lines = [
    `${dot} ${c.bold(t.name)}  ${c.gray("[")}${scope}${c.gray("]")}`,
    `  ${c.dim("curso:")}   ${t.courseName}`,
    `  ${c.dim("entrega:")} ${due}`,
    `  ${c.dim("estado:")}  ${state}${grade}`,
  ];
  if (t.timeRemaining) lines.push(`  ${c.dim("resta:")}   ${t.timeRemaining}`);
  if (t.dateConflict) {
    const mencionadas = t.datesInDescription.map((d) => d.text).join(", ");
    lines.push(
      `  ${c.boldRed("[!] OJO:")} la consigna menciona ${c.yellow(mencionadas)} — distinta a la fecha oficial`,
    );
  }
  if (t.attachments.length) {
    lines.push(`  ${c.dim("adjuntos:")} ${t.attachments.map((a) => a.filename).join(", ")}`);
  }
  if (t.url) lines.push(`  ${c.gray(t.url)}`);
  return lines.join("\n");
}
