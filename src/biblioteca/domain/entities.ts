/**
 * Entidades del catálogo bibliográfico. Son independientes de Koha: describen un libro y dónde
 * está, no cómo lo pinta el OPAC. Un adaptador de otro sistema (o un índice propio) debería
 * poder producir exactamente estas mismas formas.
 *
 * Todo es JSON plano a propósito: estas estructuras viajan tal cual a la caché en disco, a la
 * salida del MCP y, más adelante, a la API de la app.
 */

/** Campo sobre el que se busca. */
export type SearchField = "any" | "title" | "author" | "subject" | "isbn";

export interface SearchQuery {
  /** Texto normalizado (ver `normalizeQuery`). */
  text: string;
  field: SearchField;
  /** Resultados a traer en UNA petición. */
  limit: number;
  offset: number;
}

/** Ejemplares agrupados por sede y signatura, tal como los resume el listado de resultados. */
export interface HoldingSummary {
  /** null cuando el ejemplar no tiene sede catalogada (pasa en datos reales). */
  branch: string | null;
  callNumber: string | null;
  /** Nº de ejemplares en ese grupo, si el OPAC lo informa. */
  count: number | null;
}

export type AvailabilityState = "available" | "unavailable" | "no_items" | "unknown";

export interface Availability {
  state: AvailabilityState;
  /** Grupos de ejemplares prestables. */
  holdings: HoldingSummary[];
  /** Texto libre de estados no prestables ("Prestado (1)", "Perdido (2)"…), si los hay. */
  notes: string[];
}

/** Una línea de resultado de búsqueda. */
export interface BiblioSummary {
  /** biblionumber de Koha. */
  id: string;
  title: string;
  authors: string[];
  edition: string | null;
  publisher: string | null;
  year: string | null;
  isbn: string | null;
  language: string | null;
  availability: Availability;
  url: string;
}

export type ItemStatus = "available" | "checked_out" | "unavailable";

/** Un ejemplar físico (fila de la tabla de ejemplares de la ficha). */
export interface Item {
  itemType: string | null;
  branch: string | null;
  shelvingLocation: string | null;
  callNumber: string | null;
  copyNumber: string | null;
  status: ItemStatus;
  statusLabel: string;
  dueDate: string | null;
  barcode: string | null;
}

/** Ficha completa de un registro. */
export interface BiblioRecord extends BiblioSummary {
  description: string | null;
  subjects: string[];
  classification: string | null;
  items: Item[];
}

export interface SearchPage {
  query: SearchQuery;
  total: number;
  hasMore: boolean;
  results: BiblioSummary[];
}

/** Envoltorio de toda respuesta del servicio: el dato y de dónde/cuándo salió. */
export interface Fetched<T> {
  data: T;
  /** Epoch ms de cuando se obtuvo del OPAC (no de cuando se leyó de caché). */
  fetchedAt: number;
  /** true si se sirvió una copia vencida (revalidando en segundo plano, o porque el OPAC falló). */
  stale: boolean;
  source: "network" | "cache";
  /** Presente cuando se sirvió caché porque el OPAC falló: el motivo del fallo. */
  warning?: string;
}
