/**
 * Parseo de nombres de curso de la UNSA. Formato típico:
 *   "26A ECONOMÍA: ESTADÍSTICA PARA ECONOMISTAS III GA"
 *    └ período  └ escuela  └ asignatura                └ grupo (GA = Grupo A)
 *
 * El sufijo de grupo (GA, GD, GD-I…) codifica la sección del curso — un dato útil que hasta
 * ahora se descartaba. La clave normalizada permite comparar cursos de forma fiable (p. ej.
 * distinguir "III" de "II") ignorando acentos, mayúsculas, el prefijo y el grupo — necesario
 * porque la misma asignatura aparece con y sin acentos (duplicados de la OTI).
 */

export interface ParsedCourse {
  /** Nombre completo original. */
  fullname: string;
  /** Asignatura sin el prefijo de período/escuela ni el sufijo de grupo. */
  subject: string;
  /** Código de grupo tal cual ("GA", "GD-I") o null. */
  groupCode: string | null;
  /** Grupo legible ("Grupo A", "Grupo D-I") o null. */
  group: string | null;
  /** Clave para comparar cursos: minúsculas, sin acentos, sin prefijo ni grupo. */
  key: string;
}

/**
 * Genera la clave de comparación ELIMINANDO las letras acentuadas por completo. Esto es a
 * propósito: los duplicados de la OTI vienen con las vocales acentuadas y la ñ **borradas**
 * (ECOLOGÍA→ECOLOGA, CONSERVACIÓN→CONSERVACIN), no mal codificadas. Borrarlas en ambos lados hace
 * que la versión con y sin acentos produzcan la misma clave, sin conflacionar "II" con "III"
 * (los números no llevan acento).
 */
const keyify = (s: string) =>
  s
    .replace(/[áéíóúÁÉÍÓÚñÑüÜ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Sufijo de grupo al final del nombre: G + letra, con posible "-X" (GD-I). */
const GROUP_RE = /\s+G([A-Z])(-[A-Z0-9]+)?\s*$/;

/** Prefijo de período + escuela: "26A ECONOMÍA:" / "26A ECONOMA:" (con o sin acentos). */
const PREFIX_RE = /^\s*\d{2}[A-Z]\s+[A-Za-zÁÉÍÓÚÑ]+\s*:\s*/;

export function parseCourseName(fullname: string): ParsedCourse {
  let subject = fullname.trim();

  const groupMatch = GROUP_RE.exec(subject);
  const groupCode = groupMatch ? `G${groupMatch[1]}${groupMatch[2] ?? ""}` : null;
  const group = groupMatch ? `Grupo ${groupMatch[1]}${groupMatch[2] ?? ""}` : null;
  if (groupMatch) subject = subject.slice(0, groupMatch.index).trim();

  subject = subject.replace(PREFIX_RE, "").trim();

  return { fullname, subject, groupCode, group, key: keyify(subject) };
}

/** true si dos nombres de curso son la MISMA asignatura (ignora grupo, acentos, prefijo). */
export function sameCourse(a: string, b: string): boolean {
  const ka = parseCourseName(a).key;
  const kb = parseCourseName(b).key;
  return ka.length > 0 && ka === kb;
}
