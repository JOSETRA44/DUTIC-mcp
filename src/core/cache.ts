import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, writeFile, rm, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";

/**
 * Caché en disco (`~/.dutic/cache/`) para operaciones lentas de scraping que cambian poco
 * (perfiles, listas de participantes, cursos). Reduce muchísimo el tiempo de `person`/`people`,
 * que abren muchas páginas. Clave = hash de (namespace | partes), TTL por namespace.
 *
 * Nota: la caché es por-usuario (vive en el home del usuario) — asume un único dueño del aula.
 * Se puede desactivar con DUTIC_NO_CACHE=1, forzar refresco con --refresh, o limpiar con
 * `dutic cache clear`.
 */

const CACHE_DIR = join(DATA_DIR, "cache");

let enabled = process.env.DUTIC_NO_CACHE !== "1";
/** --refresh: ignora lo cacheado al leer, pero reescribe con datos frescos. */
let refresh = false;

export function setCacheEnabled(v: boolean): void {
  enabled = v;
}
export function setCacheRefresh(v: boolean): void {
  refresh = v;
}

/** TTL por defecto (min) por namespace; sobreescribible con DUTIC_CACHE_TTL_MIN. */
export const TTL = {
  courses: 12 * 60 * 60 * 1000,
  profile: 12 * 60 * 60 * 1000,
  participants: 6 * 60 * 60 * 1000,
  state: 60 * 60 * 1000,
  grades: 20 * 60 * 1000,
} as const;

function ttlFor(ns: string, fallback: number): number {
  const override = Number(process.env.DUTIC_CACHE_TTL_MIN);
  if (Number.isFinite(override) && override > 0) return override * 60 * 1000;
  return fallback;
}

function keyFile(ns: string, parts: (string | number)[]): string {
  const h = createHash("sha256").update(`${ns}|${parts.join("|")}`).digest("hex").slice(0, 24);
  return join(CACHE_DIR, `${ns}-${h}.json`);
}

/**
 * Devuelve el resultado cacheado si está fresco; si no, ejecuta `producer`, guarda y devuelve.
 * `data` debe ser serializable a JSON (los modelos del proyecto lo son).
 */
export async function withCache<T>(
  ns: keyof typeof TTL,
  parts: (string | number)[],
  producer: () => Promise<T>,
): Promise<T> {
  if (!enabled) return producer();
  const file = keyFile(ns, parts);
  const ttl = ttlFor(ns, TTL[ns]);

  if (!refresh) {
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as { ts: number; data: T };
      if (Date.now() - raw.ts < ttl) return raw.data;
    } catch {
      /* miss */
    }
  }

  const data = await producer();
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    await writeFile(file, JSON.stringify({ ts: Date.now(), data }), "utf8");
  } catch {
    /* si no se puede escribir, seguimos sin cachear */
  }
  return data;
}

export async function clearCache(): Promise<number> {
  try {
    const files = await readdir(CACHE_DIR);
    await rm(CACHE_DIR, { recursive: true, force: true });
    return files.length;
  } catch {
    return 0;
  }
}

export async function cacheInfo(): Promise<{ entries: number; bytes: number; dir: string }> {
  try {
    const files = await readdir(CACHE_DIR);
    let bytes = 0;
    for (const f of files) bytes += (await stat(join(CACHE_DIR, f)).catch(() => ({ size: 0 }))).size;
    return { entries: files.length, bytes, dir: CACHE_DIR };
  } catch {
    return { entries: 0, bytes: 0, dir: CACHE_DIR };
  }
}
