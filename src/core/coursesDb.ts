import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { currentContext } from "./context.js";

/**
 * Base de datos persistente de cursos escaneados: mapa id → CourseRecord, en
 * `~/.dutic/semesters/<ID>/courses-db.json`.
 *
 * Permite al scan-courses saltar IDs ya conocidos y sólo re-escanear los que han expirado o los
 * que se piden explícitamente con --refresh.
 *
 * UNA BASE POR SEMESTRE, y no una sola con un campo `semester` dentro: los ids de curso se
 * reutilizan entre períodos, así que un mapa global hacía que el escaneo de 2026B sobrescribiera
 * el registro de 2026A con el mismo id — y el campo `semester` del superviviente pasaba a mentir
 * sobre la mitad de la tabla. Separar los archivos elimina la colisión de raíz.
 */

export interface CourseRecord {
  id: number;
  name: string | null;
  teachers: string[];
  enrolled: boolean;
  semester: string;
  status: number;
  error?: string;
  /** Timestamp (ms) del último escaneo exitoso */
  scannedAt: number;
}

export type CoursesDb = Record<number, CourseRecord>;

function dbFile(): string {
  return currentContext().paths.coursesDb;
}

/** TTL por defecto: 7 días. Los nombres de curso cambian muy raramente. */
export const COURSES_DB_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function load(): Promise<CoursesDb> {
  try {
    const raw = await readFile(dbFile(), "utf8");
    return JSON.parse(raw) as CoursesDb;
  } catch {
    return {};
  }
}

async function save(db: CoursesDb): Promise<void> {
  const ctx = currentContext();
  mkdirSync(ctx.paths.dir, { recursive: true });
  await writeFile(ctx.paths.coursesDb, JSON.stringify(db, null, 2), "utf8");
}

/** Lee la DB entera. */
export async function loadCoursesDb(): Promise<CoursesDb> {
  return load();
}

/** Devuelve el record de un curso si existe y no ha expirado. */
export async function getCachedCourse(
  id: number,
  ttlMs = COURSES_DB_TTL_MS,
): Promise<CourseRecord | null> {
  const db = await load();
  const rec = db[id];
  if (!rec) return null;
  if (Date.now() - rec.scannedAt > ttlMs) return null;
  return rec;
}

/** Guarda (o sobreescribe) uno o varios registros en la DB. */
export async function saveCoursesToDb(records: CourseRecord[]): Promise<void> {
  const db = await load();
  for (const r of records) {
    db[r.id] = { ...r, scannedAt: r.scannedAt ?? Date.now() };
  }
  await save(db);
}

/** Estadísticas rápidas de la DB. */
export async function coursesDbInfo(): Promise<{
  total: number;
  withName: number;
  file: string;
}> {
  const db = await load();
  const entries = Object.values(db);
  return {
    total: entries.length,
    withName: entries.filter((e) => e.name).length,
    file: dbFile(),
  };
}

/** Borra la DB entera. */
export async function clearCoursesDb(): Promise<number> {
  const db = await load();
  const n = Object.keys(db).length;
  await save({});
  return n;
}
