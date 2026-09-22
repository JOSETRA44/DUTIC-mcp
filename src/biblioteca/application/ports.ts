import type { BiblioRecord, SearchPage, SearchQuery } from "../domain/entities.js";

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

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
