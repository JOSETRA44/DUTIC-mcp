import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SemesterId } from "./semester.js";

/**
 * Layout del estado local en disco. La regla que lo ordena todo:
 *
 *   GLOBAL   — lo que identifica a la PERSONA y no cambia de ciclo a ciclo: el perfil del
 *              navegador (SSO de Google), las credenciales de extranet/SISACAD, la cuenta SaaS.
 *   SCOPED   — lo que describe un PERÍODO ACADÉMICO: sesión de Moodle, cursos, notas, horario,
 *              línea base de cambios, caché.
 *
 * Antes todo era plano en `~/.dutic/`, así que entrar a 2026B pisaba la sesión y los datos de
 * 2026A. Ahora lo scoped cuelga de `~/.dutic/semesters/<ID>/` y los dos períodos conviven.
 *
 *   ~/.dutic/
 *     profile/                 perfil persistente de Playwright (SSO Google)  [global]
 *     semesters.json           registro de semestres + cuál está activo       [global]
 *     encuesta.json            credenciales + política de la encuesta         [global]
 *     encuesta-log.json        ledger append-only de envíos                   [global]
 *     sisacad-login.json       credenciales de matrícula                      [global]
 *     saas.json                cuenta SaaS                                    [global]
 *     auto.log                 log del daemon                                 [global]
 *     semesters/
 *       2026A/
 *         session.json         cookie MoodleSession + sesskey + siteUrl
 *         courses-db.json      cursos escaneados
 *         snapshot.json        línea base de `watch`
 *         horario.json         último horario descargado
 *         sisacad.json         notas capturadas del SISACAD de notas
 *         cache/               caché de scraping
 *       2026B/  ...
 */

export const DATA_DIR =
  process.env.DUTIC_DATA_DIR?.trim() || join(homedir(), ".dutic");

// --- Estado global (independiente del semestre) ---

/** Perfil persistente del navegador Playwright: mantiene viva la sesión SSO de Google. */
export const BROWSER_PROFILE_DIR = join(DATA_DIR, "profile");

/** Registro de semestres conocidos y cuál es el activo. */
export const REGISTRY_FILE = join(DATA_DIR, "semesters.json");

/** Credenciales + política de respuestas de la encuesta docente (chmod 600). */
export const ENCUESTA_FILE = join(DATA_DIR, "encuesta.json");

/**
 * Registro append-only de envíos de encuesta. Va aparte de la configuración a propósito: el
 * sistema no devuelve comprobante, así que este log es la única prueba de lo enviado y no debe
 * poder perderse porque falle una escritura de la política.
 */
export const ENCUESTA_LEDGER_FILE = join(DATA_DIR, "encuesta-log.json");

/** Credenciales del sistema de matrícula (usuario, clave, escuela) — chmod 600. */
export const SISACAD_LOGIN_FILE = join(DATA_DIR, "sisacad-login.json");

// --- Estado por semestre ---

export interface ScopedPaths {
  /** Directorio raíz del semestre. */
  dir: string;
  session: string;
  coursesDb: string;
  snapshot: string;
  horario: string;
  sisacadGrades: string;
  cacheDir: string;
}

export function semesterDir(id: SemesterId): string {
  return join(DATA_DIR, "semesters", id);
}

export function scopedPaths(id: SemesterId): ScopedPaths {
  const dir = semesterDir(id);
  return {
    dir,
    session: join(dir, "session.json"),
    coursesDb: join(dir, "courses-db.json"),
    snapshot: join(dir, "snapshot.json"),
    horario: join(dir, "horario.json"),
    sisacadGrades: join(dir, "sisacad.json"),
    cacheDir: join(dir, "cache"),
  };
}

/** Crea el directorio del semestre si no existe (idempotente). */
export function ensureSemesterDir(id: SemesterId): string {
  const dir = semesterDir(id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// --- Migración del layout plano anterior ---

/** Marca de que la migración v2 ya corrió; evita re-mover archivos en cada arranque. */
const MIGRATION_MARKER = join(DATA_DIR, ".layout-v2");

/** Archivos planos de la versión anterior → su nombre dentro del directorio del semestre. */
const LEGACY_MOVES: [legacy: string, key: keyof ScopedPaths][] = [
  ["session.json", "session"],
  ["courses-db.json", "coursesDb"],
  ["snapshot.json", "snapshot"],
  ["horario.json", "horario"],
  ["sisacad.json", "sisacadGrades"],
];

/**
 * Mueve el estado plano de `~/.dutic/` al directorio del semestre indicado. Se ejecuta UNA vez
 * (marcador en disco) y es no destructiva: si el destino ya existe, deja el archivo antiguo
 * donde está en vez de pisarlo.
 *
 * Es síncrona a propósito: corre durante la resolución del contexto, antes de que nadie haya
 * podido leer una ruta, y así no hay ventana en la que un lector vea el layout a medias.
 */
export function migrateLegacyLayout(id: SemesterId): string[] {
  if (existsSync(MIGRATION_MARKER)) return [];
  if (!existsSync(DATA_DIR)) return [];

  const moved: string[] = [];
  try {
    const paths = scopedPaths(id);
    for (const [legacyName, key] of LEGACY_MOVES) {
      const from = join(DATA_DIR, legacyName);
      const to = paths[key] as string;
      if (!existsSync(from) || existsSync(to)) continue;
      mkdirSync(paths.dir, { recursive: true });
      renameSync(from, to);
      moved.push(legacyName);
    }
    // La caché antigua se BORRA en vez de moverse. Sus claves incluyen el siteUrl, así que
    // regenerarla es barato, y arrastrarla a un directorio que ahora afirma pertenecer a un
    // semestre concreto metería ahí entradas de procedencia incierta. Dejarla donde estaba
    // tampoco vale: nadie volvería a mirar esa ruta y quedarían megas huérfanos para siempre.
    // Es el único borrado de la migración, y sólo alcanza a datos regenerables por definición.
    const legacyCache = join(DATA_DIR, "cache");
    if (existsSync(legacyCache)) {
      rmSync(legacyCache, { recursive: true, force: true });
      moved.push("cache/ (descartada)");
    }
    writeFileSync(MIGRATION_MARKER, JSON.stringify({ at: Date.now(), semester: id, moved }), "utf8");
  } catch {
    /* si la migración falla, se sigue con el layout nuevo vacío; nada se pierde */
  }
  return moved;
}

/** Ruta del `session.json` plano anterior — sólo para deducir a qué semestre pertenecía. */
export const LEGACY_SESSION_FILE = join(DATA_DIR, "session.json");
