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

export function formatTaskLine(t: Task): string {
  const flag = t.hidden ? "🔒OCULTA" : "📅";
  return `${flag}  ${t.name}\n     ${t.courseName}\n     Entrega: ${formatDate(t.dueDate)} ${relativeDue(t.dueDate)}${t.url ? `\n     ${t.url}` : ""}`;
}
