import type { SearchField, SearchQuery } from "../../domain/entities.js";

export const KOHA_BASE_URL = "http://bibliotecavirtual.unsa.edu.pe:8081";

/** Índices de Zebra que expone `opac-search.pl` (parámetro `idx`). "" = palabra clave. */
const IDX: Record<SearchField, string> = {
  any: "",
  title: "ti",
  author: "au",
  subject: "su",
  isbn: "nb",
};

export function searchUrl(base: string, q: SearchQuery): string {
  const params = new URLSearchParams({ idx: IDX[q.field], q: q.text, count: String(q.limit) });
  if (q.offset > 0) params.set("offset", String(q.offset));
  return `${base}/cgi-bin/koha/opac-search.pl?${params}`;
}

/**
 * Consulta canónica de Koha para "todo el catálogo". Medido el 2026-09-22: devuelve
 * 199 270 registros, en orden estable (≈ biblionumber ascendente), sin solapes entre
 * bloques y con paginación profunda que no se degrada (offset 150 000 cuesta lo mismo que
 * offset 1 000). Las alternativas —vocales, comodines— no garantizan cobertura.
 */
export const HARVEST_QUERY = "Any,alwaysmatches=''";

/** Un bloque del barrido, por desplazamiento. */
export function harvestUrl(base: string, offset: number, count: number): string {
  const params = new URLSearchParams({ idx: "", q: HARVEST_QUERY, count: String(count) });
  if (offset > 0) params.set("offset", String(offset));
  return `${base}/cgi-bin/koha/opac-search.pl?${params}`;
}

/** Los registros más recientes primero: el refresco incremental sólo mira la punta. */
export function newestUrl(base: string, count: number, offset = 0): string {
  const params = new URLSearchParams({
    idx: "",
    q: HARVEST_QUERY,
    count: String(count),
    sort_by: "acqdate_dsc",
  });
  if (offset > 0) params.set("offset", String(offset));
  return `${base}/cgi-bin/koha/opac-search.pl?${params}`;
}

export function detailUrl(base: string, id: string): string {
  return `${base}/cgi-bin/koha/opac-detail.pl?biblionumber=${encodeURIComponent(id)}`;
}

/** biblionumber de una URL de detalle (el Location del redirect de un único resultado). */
export function biblioIdFromUrl(url: string): string | null {
  const m = /[?&]biblionumber=(\d+)/.exec(url);
  return m ? m[1] : null;
}
