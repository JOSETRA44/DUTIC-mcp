/**
 * Semestre como VALUE OBJECT. Todo lo que sabe el proyecto sobre "qué es un semestre" vive aquí
 * y es puro: sin red, sin disco, sin variables de entorno. Así se puede probar el calendario y el
 * ordenamiento sin montar nada, y el resto del código no vuelve a inventarse un regex propio.
 *
 * La UNSA nombra sus períodos como AÑO + mitad: "2026A" (primera mitad) y "2026B" (segunda).
 * El aula virtual monta un Moodle DISTINTO por período en https://host/{ID}/, con su propia
 * cookie, su propio sesskey y sus propios cursos — de ahí que el semestre sea una dimensión de
 * aislamiento y no un simple parámetro de consulta.
 */

/** Identificador canónico, siempre en la forma "2026A". */
export type SemesterId = string;

export type SemesterHalf = "A" | "B";

export interface SemesterParts {
  year: number;
  half: SemesterHalf;
}

/**
 * Acepta las variantes que la gente escribe de verdad —"2026a", "2026-A", "2026 b", "2026-I",
 * "2026_II"— y devuelve las partes canónicas. Los números romanos existen porque otras oficinas
 * de la UNSA nombran así el mismo período: I ≡ A, II ≡ B.
 */
export function parseSemester(raw: string | null | undefined): SemesterParts | null {
  if (!raw) return null;
  const m = /^\s*(\d{4})\s*[-_\s]?\s*(A|B|I{1,2})\s*$/i.exec(raw);
  if (!m) return null;
  const year = Number(m[1]);
  if (year < 2000 || year > 2100) return null;
  const token = m[2].toUpperCase();
  const half: SemesterHalf = token === "A" || token === "I" ? "A" : "B";
  return { year, half };
}

/** Normaliza a la forma canónica "2026A", o null si no es un semestre reconocible. */
export function normalizeSemester(raw: string | null | undefined): SemesterId | null {
  const parts = parseSemester(raw);
  return parts ? formatSemesterId(parts) : null;
}

export function formatSemesterId({ year, half }: SemesterParts): SemesterId {
  return `${year}${half}`;
}

/** Etiqueta legible para la interfaz ("2026-A"). Nunca se usa como clave ni como ruta. */
export function formatSemesterLabel(id: SemesterId): string {
  const p = parseSemester(id);
  return p ? `${p.year}-${p.half}` : id;
}

export function isSemesterId(value: unknown): value is SemesterId {
  return typeof value === "string" && normalizeSemester(value) === value;
}

/** Orden cronológico: negativo si `a` es anterior. Sirve para ordenar y para "el más reciente". */
export function compareSemesters(a: SemesterId, b: SemesterId): number {
  const pa = parseSemester(a);
  const pb = parseSemester(b);
  if (!pa || !pb) return a.localeCompare(b);
  if (pa.year !== pb.year) return pa.year - pb.year;
  return pa.half === pb.half ? 0 : pa.half === "A" ? -1 : 1;
}

/** Ordena de más antiguo a más reciente (copia; no muta la entrada). */
export function sortSemesters(ids: SemesterId[]): SemesterId[] {
  return [...ids].sort(compareSemesters);
}

/** El más reciente de una lista, o null si está vacía. */
export function latestSemester(ids: SemesterId[]): SemesterId | null {
  return sortSemesters(ids).at(-1) ?? null;
}

export function nextSemester(id: SemesterId): SemesterId {
  const p = parseSemester(id);
  if (!p) return id;
  return p.half === "A"
    ? formatSemesterId({ year: p.year, half: "B" })
    : formatSemesterId({ year: p.year + 1, half: "A" });
}

export function prevSemester(id: SemesterId): SemesterId {
  const p = parseSemester(id);
  if (!p) return id;
  return p.half === "B"
    ? formatSemesterId({ year: p.year, half: "A" })
    : formatSemesterId({ year: p.year - 1, half: "B" });
}

/**
 * Todos los semestres entre dos extremos, inclusive. Lo usa el descubrimiento para generar los
 * candidatos que va a sondear contra el servidor.
 */
export function semesterRange(from: SemesterId, to: SemesterId): SemesterId[] {
  const start = normalizeSemester(from);
  const end = normalizeSemester(to);
  if (!start || !end) return [];
  const [lo, hi] = compareSemesters(start, end) <= 0 ? [start, end] : [end, start];
  const out: SemesterId[] = [];
  let cur = lo;
  // Cota dura: evita un bucle infinito si alguien pasa un rango absurdo.
  for (let i = 0; i < 200 && compareSemesters(cur, hi) <= 0; i++) {
    out.push(cur);
    cur = nextSemester(cur);
  }
  return out;
}

/**
 * Mes (1-12) en que arranca cada mitad del año académico de la UNSA. Son constantes de CALENDARIO
 * INSTITUCIONAL, no de programación: si la universidad corre el inicio de ciclo, se ajustan aquí
 * y todo lo demás (inferencia del semestre activo, descubrimiento) se recoloca solo.
 */
export const SEMESTER_A_START_MONTH = 3; // marzo
export const SEMESTER_B_START_MONTH = 8; // agosto

/**
 * Semestre que le corresponde a una fecha. Enero y febrero son vacaciones: no existe un período
 * "en curso", así que se devuelve el B del año anterior — el último con datos reales, que es lo
 * que el usuario querría consultar en esas semanas.
 */
export function inferSemesterFromDate(date: Date = new Date()): SemesterId {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  if (month < SEMESTER_A_START_MONTH) {
    return formatSemesterId({ year: year - 1, half: "B" });
  }
  if (month < SEMESTER_B_START_MONTH) {
    return formatSemesterId({ year, half: "A" });
  }
  return formatSemesterId({ year, half: "B" });
}

/**
 * Extrae el semestre de cualquier URL del aula virtual ("https://host/2026A/my" → "2026A").
 * Es la fuente MÁS fiable que existe: la escribe el propio servidor tras el login, así que
 * corrige cualquier configuración desfasada del usuario.
 */
export function semesterFromUrl(url: string | null | undefined): SemesterId | null {
  if (!url) return null;
  const m = /\/(\d{4}[ABab])(?:\/|$)/.exec(url);
  return m ? normalizeSemester(m[1]) : null;
}

/**
 * Ruta del login de matrícula de SISACAD para un semestre ("matr_int_2026b_v2.00"). El sistema
 * de matrícula versiona su carpeta por período; el patrón se ha mantenido estable, así que se
 * deriva en vez de exigir configuración manual cada ciclo (que es lo que se hacía antes).
 */
export function defaultMatriculaPath(id: SemesterId): string {
  const p = parseSemester(id);
  if (!p) return "matr_int_2026b_v2.00";
  return `matr_int_${p.year}${p.half.toLowerCase()}_v2.00`;
}
