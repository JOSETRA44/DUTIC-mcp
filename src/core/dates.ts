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
