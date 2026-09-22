import type { Fetched } from "../domain/entities.js";
import { decideFreshness, type Freshness, type FreshnessPolicy } from "./freshness.js";
import type { CacheEntry, CatalogCache, Clock } from "./ports.js";

export interface ResolveOptions {
  /** Ignora la caché al leer (pero la reescribe). Si la red falla, igual se cae a la copia. */
  refresh?: boolean;
  /**
   * Qué hacer al servir una copia `stale`:
   *  - "background": lanzar la revalidación y no esperarla (procesos largos: el servidor MCP).
   *  - "none": no revalidar (procesos cortos: el CLI, que si no quedaría vivo ~15 s de más).
   */
  revalidate?: "background" | "none";
}

/**
 * Lectura de caché con tres garantías pensadas para un origen de ~11 s por petición:
 *
 *  1. stale-while-revalidate: una copia algo vieja se sirve al instante.
 *  2. singleflight: N consultas idénticas simultáneas generan UNA sola petición al origen.
 *  3. respaldo: si el origen falla y hay copia (aunque esté vencida), se sirve marcada `stale`.
 */
export class CachedResolver {
  private readonly inflight = new Map<string, Promise<CacheEntry<unknown>>>();

  constructor(
    private readonly cache: CatalogCache,
    private readonly clock: Clock,
    private readonly decide: (ageMs: number, policy: FreshnessPolicy) => Freshness = decideFreshness,
    private readonly onBackgroundError: (err: unknown) => void = () => {},
  ) {}

  async resolve<T>(
    key: string,
    policy: FreshnessPolicy,
    producer: () => Promise<T>,
    opts: ResolveOptions = {},
  ): Promise<Fetched<T>> {
    const cached = await this.cache.get<T>(key).catch(() => null);

    if (cached && !opts.refresh) {
      const freshness = this.decide(this.clock.now() - cached.storedAt, policy);
      if (freshness === "fresh") return fromCache(cached, false);
      if (freshness === "stale") {
        if ((opts.revalidate ?? "background") === "background") {
          this.load(key, producer).catch(this.onBackgroundError);
        }
        return fromCache(cached, true);
      }
    }

    try {
      const entry = (await this.load(key, producer)) as CacheEntry<T>;
      return { data: entry.value, fetchedAt: entry.storedAt, stale: false, source: "network" };
    } catch (err) {
      if (cached) return { ...fromCache(cached, true), warning: (err as Error).message };
      throw err;
    }
  }

  /** Espera a que terminen las revalidaciones en curso (tests, apagado ordenado). */
  async settle(): Promise<void> {
    await Promise.allSettled([...this.inflight.values()]);
  }

  private load<T>(key: string, producer: () => Promise<T>): Promise<CacheEntry<T>> {
    const running = this.inflight.get(key);
    if (running) return running as Promise<CacheEntry<T>>;

    const promise = (async () => {
      const value = await producer();
      const entry: CacheEntry<T> = { value, storedAt: this.clock.now() };
      // Una caché que no puede escribir no debe tumbar una respuesta que ya tenemos.
      await this.cache.set(key, entry).catch(() => {});
      return entry;
    })().finally(() => this.inflight.delete(key));

    this.inflight.set(key, promise);
    return promise;
  }
}

function fromCache<T>(entry: CacheEntry<T>, stale: boolean): Fetched<T> {
  return { data: entry.value, fetchedAt: entry.storedAt, stale, source: "cache" };
}
