import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, writeFile, rm, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { currentContext } from "./context.js";

/**
 * Caché en disco (`~/.dutic/cache/`) para operaciones lentas de scraping que cambian poco
 * (perfiles, listas de participantes, cursos). Reduce muchísimo el tiempo de `person`/`people`,
 * que abren muchas páginas. Clave = hash de (namespace | partes), TTL por namespace.
 *
 * Nota: la caché es por-usuario (vive en el home del usuario) — asume un único dueño del aula.
 * Se puede desactivar con DUTIC_NO_CACHE=1, forzar refresco con --refresh, o limpiar con
 * `dutic cache clear`.
 *
 * Vive DENTRO del directorio del semestre. Las claves ya incluían el siteUrl, así que no había
 * riesgo de leer datos cruzados; separarla por período sirve para otra cosa: que `cache clear`
 * y las estadísticas hablen del semestre que el usuario tiene delante, y que archivar un ciclo
 * viejo se lleve su caché consigo.
 */

function cacheDir(): string {
  return currentContext().paths.cacheDir;
}

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
  return join(cacheDir(), `${ns}-${h}.json`);
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
    mkdirSync(cacheDir(), { recursive: true });
    await writeFile(file, JSON.stringify({ ts: Date.now(), data }), "utf8");
  } catch {
    /* si no se puede escribir, seguimos sin cachear */
  }
  return data;
}

/** Borra la caché del semestre en curso. Devuelve cuántas entradas había. */
export async function clearCache(): Promise<number> {
  const dir = cacheDir();
  try {
    const files = await readdir(dir);
    await rm(dir, { recursive: true, force: true });
    return files.length;
  } catch {
    return 0;
  }
}

export async function cacheInfo(): Promise<{ entries: number; bytes: number; dir: string }> {
  const dir = cacheDir();
  try {
    const files = await readdir(dir);
    let bytes = 0;
    for (const f of files) bytes += (await stat(join(dir, f)).catch(() => ({ size: 0 }))).size;
    return { entries: files.length, bytes, dir };
  } catch {
    return { entries: 0, bytes: 0, dir };
  }
}
