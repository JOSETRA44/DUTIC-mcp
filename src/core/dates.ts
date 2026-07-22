/** Utilidades de fechas en español, compartidas por los scrapers de Moodle. */

const MONTHS_ES: Record<string, number> = {
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
  julio: 6, agosto: 7, septiembre: 8, setiembre: 8, octubre: 9,
  noviembre: 10, diciembre: 11,
};

/** Patrón de fecha larga en español: "19 de julio de 2026, 12:00" (hora opcional). */
export const SPANISH_DATE_RE =
  /(\d{1,2})\s+de\s+([a-záéíóúñ]+)(?:\s+de\s+(\d{4}))?(?:[,\s]+(\d{1,2}):(\d{2}))?/gi;

/** Convierte una fecha larga en español a epoch (segundos). null si no se puede. */
export function parseSpanishDate(text: string, defaultYear?: number): number | null {
  const re = new RegExp(SPANISH_DATE_RE.source, "i");
  const m = re.exec(text.toLowerCase());
  if (!m) return null;
  const day = Number(m[1]);
  const month = MONTHS_ES[m[2]];
  if (month === undefined) return null;
  const year = m[3] ? Number(m[3]) : (defaultYear ?? new Date().getFullYear());
  const hour = m[4] ? Number(m[4]) : 0;
  const min = m[5] ? Number(m[5]) : 0;
  const d = new Date(year, month, day, hour, min);
  const t = d.getTime();
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

/** Encuentra todas las fechas en español dentro de un texto, con su epoch. */
export function findSpanishDates(
  text: string,
): { text: string; epoch: number | null }[] {
  const out: { text: string; epoch: number | null }[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(SPANISH_DATE_RE)) {
    const raw = m[0].trim();
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push({ text: raw, epoch: parseSpanishDate(raw) });
  }
  return out;
}

/** Diferencia en días entre dos epochs (segundos). */
export function daysBetween(a: number, b: number): number {
  return Math.round((a - b) / 86_400);
}

const UNIT_SECONDS: Record<string, number> = {
  segundo: 1, minuto: 60, hora: 3600, dia: 86_400, día: 86_400,
  semana: 604_800, mes: 2_592_000, ano: 31_536_000, año: 31_536_000,
};

/**
 * Convierte un "último acceso" relativo de Moodle a **segundos transcurridos** desde ahora, para
 * poder comparar accesos entre cursos y elegir el más reciente. Ejemplos: "9 días 4 horas",
 * "58 segundos", "ahora", "Nunca". Devuelve Infinity si nunca accedió o no se puede interpretar
 * (así "nunca" queda como el menos reciente).
 */
export function relativeAccessToSeconds(text: string | null | undefined): number {
  if (!text) return Infinity;
  const t = text.toLowerCase().trim();
  if (/nunca|never/.test(t)) return Infinity;
  if (/ahora|justo ahora|now|segundos?$/.test(t) && !/\d/.test(t)) return 0;
  let total = 0;
  let matched = false;
  for (const m of t.matchAll(/(\d+)\s*(segundo|minuto|hora|d[ií]a|semana|mes|a[nñ]o)s?/g)) {
    total += Number(m[1]) * (UNIT_SECONDS[m[2]] ?? 0);
    matched = true;
  }
  return matched ? total : Infinity;
}

/** Formatea segundos-transcurridos a un texto corto en español ("hace 3 h", "hace 9 d"). */
export function humanizeAgo(seconds: number): string {
  if (!Number.isFinite(seconds)) return "nunca";
  if (seconds < 90) return "hace un momento";
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.round(seconds / 3600);
  if (hours < 48) return `hace ${hours} h`;
  const days = Math.round(seconds / 86_400);
  if (days < 60) return `hace ${days} d`;
  const months = Math.round(days / 30);
  return `hace ${months} mes(es)`;
}
