/**
 * Utilidades de presentación para el CLI: color ANSI, tablas con caracteres de caja, barras de
 * progreso y marcadores de estado en ASCII (sin emojis). Respeta NO_COLOR y salidas sin TTY.
 */

const useColor =
  !process.env.NO_COLOR && (process.stdout.isTTY || process.env.FORCE_COLOR === "1");

const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  reset: wrap("0"),
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  magenta: wrap("35"),
  cyan: wrap("36"),
  gray: wrap("90"),
  boldCyan: wrap("1;36"),
  boldRed: wrap("1;31"),
  boldGreen: wrap("1;32"),
  boldYellow: wrap("1;33"),
};

/** Longitud visible (sin códigos ANSI), para alinear columnas. */
function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padEndVisible(s: string, width: number): string {
  const pad = width - visibleLen(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

/** Marcadores de estado ASCII (sin emojis). */
export const mark = {
  ok: () => c.green("[OK]"),
  warn: () => c.yellow("[!]"),
  err: () => c.red("[x]"),
  info: () => c.cyan("[i]"),
  bullet: () => c.gray("•"),
  arrow: () => c.cyan("›"),
  pending: () => c.boldYellow("○"),
  done: () => c.green("●"),
};

/** Título en caja de doble/simple línea, opcionalmente con subtítulo. */
export function banner(title: string, subtitle?: string): string {
  const lines = [title, ...(subtitle ? [subtitle] : [])];
  const width = Math.max(...lines.map((l) => l.length)) + 2;
  const top = "┌" + "─".repeat(width) + "┐";
  const bot = "└" + "─".repeat(width) + "┘";
  const body = lines
    .map((l, i) => {
      const styled = i === 0 ? c.boldCyan(l) : c.dim(l);
      return "│ " + styled + " ".repeat(width - 1 - l.length) + "│";
    })
    .join("\n");
  return c.cyan(top) + "\n" + body + "\n" + c.cyan(bot);
}

/** Regla horizontal con etiqueta opcional. */
export function rule(label?: string, width = 60): string {
  if (!label) return c.gray("─".repeat(width));
  const line = `── ${c.bold(label)} `;
  const rest = width - visibleLen(line);
  return c.gray("──") + " " + c.bold(label) + " " + c.gray("─".repeat(Math.max(rest, 0)));
}

export interface Column {
  header: string;
  /** Alineación del contenido. */
  align?: "left" | "right";
  /** Color aplicado a las celdas (no a la cabecera). */
  color?: (s: string) => string;
}

/**
 * Tabla con bordes de caja. `rows` son celdas ya en texto plano; el color de columna se aplica
 * al renderizar para no romper el cálculo de anchos.
 */
export function table(columns: Column[], rows: string[][]): string {
  const widths = columns.map((col, i) =>
    Math.max(visibleLen(col.header), ...rows.map((r) => visibleLen(r[i] ?? ""))),
  );
  const sep = (l: string, m: string, r: string) =>
    c.gray(l + widths.map((w) => "─".repeat(w + 2)).join(m) + r);

  const fmt = (cells: string[], color = false) =>
    c.gray("│") +
    cells
      .map((cell, i) => {
        const col = columns[i];
        const painted = color && col.color ? col.color(cell) : cell;
        const padded =
          col.align === "right"
            ? " ".repeat(Math.max(widths[i] - visibleLen(cell), 0)) + painted
            : padEndVisible(painted, widths[i]);
        return " " + padded + " ";
      })
      .join(c.gray("│")) +
    c.gray("│");

  const head = fmt(columns.map((col) => c.bold(col.header)));
  const body = rows.map((r) => fmt(r, true)).join("\n");
  return [sep("┌", "┬", "┐"), head, sep("├", "┼", "┤"), body, sep("└", "┴", "┘")].join("\n");
}

/**
 * Barra de progreso en una sola línea (se reescribe con \r sobre stderr). Llama a `done()` al
 * terminar para dejar la línea limpia.
 */
export function progressBar(total: number, label = "") {
  const width = 28;
  const stream = process.stderr;
  const render = (current: number, note = "") => {
    if (!stream.isTTY) return;
    const ratio = total > 0 ? Math.min(current / total, 1) : 0;
    const filled = Math.round(ratio * width);
    const bar = c.cyan("█".repeat(filled)) + c.gray("░".repeat(width - filled));
    const pct = String(Math.round(ratio * 100)).padStart(3);
    stream.write(`\r${label} ${bar} ${pct}% ${c.dim(`(${current}/${total})`)} ${c.dim(note)}   `);
  };
  return {
    update: render,
    done: () => {
      if (stream.isTTY) stream.write("\r" + " ".repeat(width + 40) + "\r");
    },
  };
}
