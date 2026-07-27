import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";

/**
 * Base de datos persistente de cursos escaneados.
 * Se almacena en ~/.dutic/courses-db.json como un mapa id → CourseRecord.
 *
 * Permite al scan-courses saltar IDs ya conocidos y sólo re-escanear
 * los que han expirado o los que se piden explícitamente con --refresh.
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

const DB_FILE = join(DATA_DIR, "courses-db.json");

/** TTL por defecto: 7 días. Los nombres de curso cambian muy raramente. */
export const COURSES_DB_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function load(): Promise<CoursesDb> {
  try {
    const raw = await readFile(DB_FILE, "utf8");
    return JSON.parse(raw) as CoursesDb;
  } catch {
    return {};
  }
}

async function save(db: CoursesDb): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  await writeFile(DB_FILE, JSON.stringify(db, null, 2), "utf8");
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
    file: DB_FILE,
  };
}

/** Borra la DB entera. */
export async function clearCoursesDb(): Promise<number> {
  const db = await load();
  const n = Object.keys(db).length;
  await save({});
  return n;
}
