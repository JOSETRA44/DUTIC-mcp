import type { Task } from "../core/models.js";

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
  if (days < 0) return `(vencida hace ${Math.abs(days)}d)`;
  if (days === 0) return "(¡hoy!)";
  if (days === 1) return "(mañana)";
  return `(en ${days}d)`;
}

const SUBMISSION_LABEL: Record<string, string> = {
  submitted: "✅ Enviada",
  "not-submitted": "⚠️ SIN ENTREGAR",
  graded: "🎓 Calificada",
  unknown: "",
};

export function formatTaskLine(t: Task): string {
  const flag = t.hidden ? "🔒 OCULTA" : "📅 en timeline";
  const sub = SUBMISSION_LABEL[t.submission] ?? "";
  const gradeStr = t.grade ? ` · Nota: ${t.grade}` : "";
  const lines = [
    `${flag}  ${t.name}`,
    `     ${t.courseName}`,
    `     Entrega: ${formatDate(t.dueDate)} ${relativeDue(t.dueDate)}`,
  ];
  if (sub || gradeStr) lines.push(`     Estado: ${sub}${gradeStr}`);
  if (t.timeRemaining) lines.push(`     ${t.timeRemaining}`);
  if (t.url) lines.push(`     ${t.url}`);
  return lines.join("\n");
}
