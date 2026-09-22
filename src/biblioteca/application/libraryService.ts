import { mapLimit } from "../../domain/concurrency.js";
import type { BiblioRecord, Fetched, SearchField, SearchPage } from "../domain/entities.js";
import { assertBiblioId, buildQuery, recordCacheKey, searchCacheKey } from "../domain/query.js";
import { CachedResolver, type ResolveOptions } from "./cachedResolver.js";
import { RECORD_POLICY, SEARCH_POLICY, type Freshness, type FreshnessPolicy } from "./freshness.js";
import { systemClock, type CatalogCache, type CatalogGateway, type Clock } from "./ports.js";

export interface SearchInput {
  text: string;
  field?: SearchField;
  limit?: number;
  offset?: number;
}

export interface LibraryServiceDeps {
  gateway: CatalogGateway;
  cache: CatalogCache;
  clock?: Clock;
  decide?: (ageMs: number, policy: FreshnessPolicy) => Freshness;
  onBackgroundError?: (err: unknown) => void;
}

/**
 * Casos de uso del catálogo. Es la única puerta que usan el CLI, el MCP y —más adelante— la API
 * de la app: ninguno de ellos habla con Koha ni con la caché directamente.
 */
export class LibraryService {
  /**
   * Fichas abiertas a la vez: UNA. Contraintuitivo pero medido: en secuencia por la conexión
   * caliente cada ficha cuesta ~0.25 s; en paralelo cada una abre un socket frío y paga ~10 s.
   */
  static readonly RECORD_CONCURRENCY = 1;

  /** Fichas que se precargan tras una búsqueda (ver `prefetchRecords`). */
  static readonly PREFETCH_RECORDS = 5;

  private readonly resolver: CachedResolver;
  private readonly clock: Clock;

  constructor(private readonly deps: LibraryServiceDeps) {
    this.clock = deps.clock ?? systemClock;
    this.resolver = new CachedResolver(
      deps.cache,
      this.clock,
      deps.decide,
      deps.onBackgroundError,
    );
  }

  async search(input: SearchInput, opts: ResolveOptions = {}): Promise<Fetched<SearchPage>> {
    const query = buildQuery(input);
    return this.resolver.resolve(
      searchCacheKey(query),
      SEARCH_POLICY,
      async () => {
        const { page, records = [] } = await this.deps.gateway.search(query);
        const storedAt = this.clock.now();
        await Promise.allSettled(
          records.map((r) => this.deps.cache.set(recordCacheKey(r.id), { value: r, storedAt })),
        );
        return page;
      },
      opts,
    );
  }

  async getRecord(id: string, opts: ResolveOptions = {}): Promise<Fetched<BiblioRecord | null>> {
    const biblio = assertBiblioId(id);
    return this.resolver.resolve(
      recordCacheKey(biblio),
      RECORD_POLICY,
      () => this.deps.gateway.getRecord(biblio),
      opts,
    );
  }

  /** Varias fichas en paralelo acotado; conserva el orden de `ids`. */
  getRecords(ids: string[], opts: ResolveOptions = {}): Promise<Fetched<BiblioRecord | null>[]> {
    return mapLimit(ids, LibraryService.RECORD_CONCURRENCY, (id) => this.getRecord(id, opts));
  }

  /**
   * Precarga en caché las fichas de `ids` en ráfaga secuencial, sin propagar errores. Debe
   * llamarse JUSTO después de una búsqueda que fue a la red: la conexión sigue caliente (<1 s) y
   * cada ficha cuesta ~0.25 s en vez de ~10 s. Las que ya están frescas en caché no tocan la red.
   */
  async prefetchRecords(ids: string[], max = LibraryService.PREFETCH_RECORDS): Promise<void> {
    for (const id of ids.slice(0, max)) {
      await this.getRecord(id, { revalidate: "none" }).catch(() => {});
    }
  }

  clearCache(): Promise<number> {
    return this.deps.cache.clear();
  }

  /** Espera revalidaciones en segundo plano pendientes. */
  settle(): Promise<void> {
    return this.resolver.settle();
  }
}
