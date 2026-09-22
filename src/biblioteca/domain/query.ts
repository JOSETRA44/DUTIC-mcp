import type { SearchField, SearchQuery } from "./entities.js";

/**
 * Cuántos resultados pedir por defecto. Una petición cuesta ~10 s si la conexión está fría, más
 * ~0.05 s por registro. Como las consultas de un usuario llegan espaciadas (conexión fría otra
 * vez), traer 30 de una vez sale mucho más barato que paginar; y más de 30 ya pesa en el render
 * del servidor y en la salida del MCP.
 */
export const DEFAULT_LIMIT = 30;
/** Tope propio: `count` del OPAC no tiene límite, pero 500 registros ya son 35 s y 1.7 MB. */
export const MAX_LIMIT = 200;

export const SEARCH_FIELDS: readonly SearchField[] = ["any", "title", "author", "subject", "isbn"];

/**
 * Normaliza el texto de búsqueda para que variantes triviales compartan entrada de caché:
 * minúsculas, sin tildes, espacios colapsados. Zebra (el motor de Koha) ya ignora tildes y
 * mayúsculas, así que esto no cambia los resultados.
 */
export function normalizeText(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Construye una consulta válida a partir de entrada de usuario (CLI, MCP o API). */
export function buildQuery(input: {
  text: string;
  field?: SearchField;
  limit?: number;
  offset?: number;
}): SearchQuery {
  const field = input.field ?? "any";
  let text = normalizeText(input.text);
  // En un ISBN los guiones y espacios no significan nada: 978-958-778-162-5 == 9789587781625.
  if (field === "isbn") text = text.replace(/[\s-]/g, "");
  if (!text) throw new RangeError("La búsqueda está vacía.");
  const limit = clampInt(input.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = Math.max(0, Math.trunc(input.offset ?? 0));
  return { text, field, limit, offset };
}

/** Clave estable de caché para una consulta ya normalizada. */
export function searchCacheKey(q: SearchQuery): string {
  return `search|${q.field}|${q.text}|${q.offset}|${q.limit}`;
}

export function recordCacheKey(id: string): string {
  return `record|${id}`;
}

/** Un biblionumber de Koha es un entero positivo; cualquier otra cosa se rechaza antes de la red. */
export function assertBiblioId(id: string): string {
  const trimmed = String(id).trim();
  if (!/^\d{1,10}$/.test(trimmed)) throw new RangeError(`Id de registro inválido: "${id}".`);
  return trimmed;
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
