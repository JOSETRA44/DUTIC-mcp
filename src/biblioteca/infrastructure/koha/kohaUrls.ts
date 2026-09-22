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

export function detailUrl(base: string, id: string): string {
  return `${base}/cgi-bin/koha/opac-detail.pl?biblionumber=${encodeURIComponent(id)}`;
}

/** biblionumber de una URL de detalle (el Location del redirect de un único resultado). */
export function biblioIdFromUrl(url: string): string | null {
  const m = /[?&]biblionumber=(\d+)/.exec(url);
  return m ? m[1] : null;
}
