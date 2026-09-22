import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CacheEntry, CatalogCache } from "../../application/ports.js";

/**
 * Implementaciones de `CatalogCache`. Ninguna decide si un dato está fresco: sólo guardan
 * `{ value, storedAt }`. La política vive en `application/freshness.ts`.
 */

/** LRU en memoria: sirve dentro de un proceso largo (el servidor MCP) sin tocar disco. */
export class MemoryCache implements CatalogCache {
  private readonly map = new Map<string, CacheEntry<unknown>>();

  constructor(private readonly maxEntries = 256) {}

  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const hit = this.map.get(key);
    if (!hit) return null;
    // Reinsertar la mueve al final: el Map conserva orden de inserción, así el primero es el LRU.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit as CacheEntry<T>;
  }

  async set<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    this.map.delete(key);
    this.map.set(key, entry);
    while (this.map.size > this.maxEntries) {
      this.map.delete(this.map.keys().next().value as string);
    }
  }

  async clear(): Promise<number> {
    const n = this.map.size;
    this.map.clear();
    return n;
  }
}

/**
 * Un archivo JSON por clave en `dir`. La escritura es atómica (tmp + rename) porque el CLI y el
 * servidor MCP pueden escribir la misma entrada a la vez.
 */
export class FileCache implements CatalogCache {
  constructor(private readonly dir: string) {}

  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    try {
      const raw = JSON.parse(await readFile(this.file(key), "utf8")) as {
        key: string;
        storedAt: number;
        value: T;
      };
      // El hash está truncado: se guarda la clave completa para descartar colisiones.
      if (raw.key !== key || typeof raw.storedAt !== "number") return null;
      return { value: raw.value, storedAt: raw.storedAt };
    } catch {
      return null;
    }
  }

  async set<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const file = this.file(key);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify({ key, storedAt: entry.storedAt, value: entry.value }), "utf8");
    await rename(tmp, file);
  }

  async clear(): Promise<number> {
    try {
      const files = (await readdir(this.dir)).filter((f) => f.endsWith(".json"));
      await rm(this.dir, { recursive: true, force: true });
      return files.length;
    } catch {
      return 0;
    }
  }

  private file(key: string): string {
    return join(this.dir, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);
  }
}

/**
 * Varios niveles, del más rápido al más lento (memoria → disco → mañana Supabase). Un acierto en
 * un nivel lento se copia a los rápidos; una escritura va a todos.
 */
export class TieredCache implements CatalogCache {
  constructor(private readonly layers: CatalogCache[]) {}

  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    for (let i = 0; i < this.layers.length; i++) {
      const hit = await this.layers[i].get<T>(key).catch(() => null);
      if (hit) {
        await Promise.allSettled(this.layers.slice(0, i).map((l) => l.set(key, hit)));
        return hit;
      }
    }
    return null;
  }

  async set<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    await Promise.allSettled(this.layers.map((l) => l.set(key, entry)));
  }

  async clear(): Promise<number> {
    const counts = await Promise.all(this.layers.map((l) => l.clear().catch(() => 0)));
    return Math.max(0, ...counts);
  }
}

/** Caché desactivada (DUTIC_NO_CACHE=1 / --no-cache). */
export class NullCache implements CatalogCache {
  async get<T>(): Promise<CacheEntry<T> | null> {
    return null;
  }
  async set(): Promise<void> {}
  async clear(): Promise<number> {
    return 0;
  }
}
