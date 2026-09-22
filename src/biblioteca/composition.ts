import { join } from "node:path";
import { DATA_DIR } from "../core/paths.js";
import { LibraryService } from "./application/libraryService.js";
import { FileCache, MemoryCache, NullCache, TieredCache } from "./infrastructure/cache/caches.js";
import { KohaGateway } from "./infrastructure/koha/kohaGateway.js";
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
