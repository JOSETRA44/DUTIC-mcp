import type { BiblioRecord, BiblioSummary, SearchPage, SearchQuery } from "../domain/entities.js";

/**
 * Puertos de la capa de aplicación. Los casos de uso sólo conocen estas interfaces; los
 * adaptadores concretos (Koha por HTTP, caché en memoria/disco, y mañana Supabase o un índice
 * propio) viven en `infrastructure/` y se enchufan en `composition.ts`.
 */

export interface GatewaySearchResult {
  page: SearchPage;
  /**
   * Fichas completas que el origen ya descargó de paso (p.ej. Koha, con un único resultado,
   * redirige al detalle). El servicio las guarda en caché para que abrirlas no cueste otra
   * petición de ~12 s.
   */
  records?: BiblioRecord[];
}

/** Fuente del catálogo. Hoy: el OPAC Koha. Mañana: un índice propio con la misma forma. */
export interface CatalogGateway {
  search(query: SearchQuery): Promise<GatewaySearchResult>;
  /** null si el registro no existe. */
  getRecord(id: string): Promise<BiblioRecord | null>;
}

export interface CacheEntry<T> {
  value: T;
  /** Epoch ms de cuando se obtuvo el valor del origen. */
  storedAt: number;
}

/** Almacén clave → valor JSON. Las políticas de frescura NO viven aquí, sino en la aplicación. */
export interface CatalogCache {
  get<T>(key: string): Promise<CacheEntry<T> | null>;
  set<T>(key: string, entry: CacheEntry<T>): Promise<void>;
  /** Borra todo. Devuelve cuántas entradas había (si el almacén lo sabe). */
  clear(): Promise<number>;
}

/** Un bloque del barrido: los registros de una página y el total que reporta el origen. */
export interface HarvestBlock {
  total: number;
  results: BiblioSummary[];
}

/**
 * Origen capaz de entregar el catálogo ENTERO por bloques, no sólo de responder búsquedas.
 * Se separa de `CatalogGateway` porque es una capacidad de cosecha, no de consulta: un
 * origen podría saber buscar y no saber enumerar.
 */
export interface CatalogHarvestSource {
  /** Bloque por desplazamiento, en el orden estable del origen (≈ biblionumber ascendente). */
  fetchBlock(offset: number, limit: number): Promise<HarvestBlock>;
  /** Los `limit` registros más recientes, para el refresco incremental. */
  fetchNewest(limit: number, offset?: number): Promise<HarvestBlock>;
}

/** Estado de un barrido tal como lo guarda el repositorio. */
export interface HarvestRun {
  id: number;
  cursorOffset: number;
  recordsUpserted: number;
  totalExpected: number | null;
}

export type HarvestStatus = "paused" | "done" | "failed";

/** Destino persistente del catálogo (hoy Postgres/Supabase). */
export interface CatalogRepository {
  /**
   * Abre un barrido o retoma el que quedó a medias en ese modo.
   *
   * Devuelve null cuando NO hay nada que hacer: con `maxAgeDays`, si el último barrido
   * completo terminó hace menos de ese plazo. Es lo que permite dejar un cron nocturno
   * encendido sin que vuelva a barrer el catálogo entero cada noche.
   */
  startRun(
    mode: "full" | "incremental",
    totalExpected?: number | null,
    maxAgeDays?: number | null,
  ): Promise<HarvestRun | null>;
  /**
   * Upsert de un bloque Y avance del cursor, atómicos. Devuelve cuántas filas escribió.
   * Si falla, el cursor NO avanza y la tanda siguiente reintenta ese mismo bloque.
   */
  ingestBlock(
    runId: number,
    rows: BiblioSummary[],
    nextOffset: number,
    total: number | null,
  ): Promise<number>;
  finishRun(runId: number, status: HarvestStatus, error?: string | null, blocksFailed?: number): Promise<void>;
  /** Cuáles de esos ids ya están guardados (corta el refresco incremental). */
  knownIds(ids: string[]): Promise<Set<string>>;
}

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
