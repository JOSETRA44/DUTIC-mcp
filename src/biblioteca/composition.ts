import { join } from "node:path";
import { DATA_DIR } from "../core/paths.js";
import { CatalogHarvester } from "./application/harvestCatalog.js";
import { LibraryService } from "./application/libraryService.js";
import { FileCache, MemoryCache, NullCache, TieredCache } from "./infrastructure/cache/caches.js";
import { KohaGateway } from "./infrastructure/koha/kohaGateway.js";
import { SupabaseCatalogRepository } from "./infrastructure/supabase/catalogRepository.js";
import { KOHA_BASE_URL } from "./infrastructure/koha/kohaUrls.js";

/**
 * Raíz de composición del catálogo: el ÚNICO archivo que conoce las implementaciones concretas.
 * CLI y MCP piden aquí el servicio; cambiar Koha por un índice propio, o sumar un nivel de caché
 * remoto, se hace sólo en este archivo.
 *
 * La caché es GLOBAL (`~/.dutic/biblioteca/cache`), no por semestre: el catálogo es público y no
 * depende del período académico.
 */
export const LIBRARY_CACHE_DIR = join(DATA_DIR, "biblioteca", "cache");

export interface LibraryOptions {
  /** false desactiva toda caché (DUTIC_NO_CACHE=1 / --no-cache). */
  cache?: boolean;
}

/**
 * Token de ingesta del catálogo. NO es la service_role key: es un token propio que sólo
 * puede llamar a la Edge Function `library-ingest` y que se revoca con un UPDATE. Vive en el
 * entorno de quien corre el barrido (tu máquina, o el secreto de GitHub Actions).
 */
export function ingestKey(): string | null {
  return process.env.DUTIC_LIBRARY_INGEST_TOKEN?.trim() || null;
}

/**
 * Orquestador del barrido. null si este equipo no tiene clave de ingesta, que es el caso
 * normal: los usuarios del CLI y del MCP sólo leen.
 */
export function catalogHarvester(): CatalogHarvester | null {
  const key = ingestKey();
  if (!key) return null;
  const baseUrl = process.env.DUTIC_LIBRARY_URL?.trim().replace(/\/+$/, "") || KOHA_BASE_URL;
  return new CatalogHarvester({
    source: new KohaGateway(baseUrl),
    repository: new SupabaseCatalogRepository(key),
  });
}

let instance: LibraryService | null = null;

export function libraryService(opts: LibraryOptions = {}): LibraryService {
  if (instance) return instance;
  const cacheEnabled = (opts.cache ?? true) && process.env.DUTIC_NO_CACHE !== "1";
  const baseUrl = process.env.DUTIC_LIBRARY_URL?.trim().replace(/\/+$/, "") || KOHA_BASE_URL;
  instance = new LibraryService({
    gateway: new KohaGateway(baseUrl),
    cache: cacheEnabled
      ? new TieredCache([new MemoryCache(), new FileCache(LIBRARY_CACHE_DIR)])
      : new NullCache(),
    onBackgroundError: () => {
      /* una revalidación fallida no afecta: la copia servida sigue marcada como stale */
    },
  });
  return instance;
}
