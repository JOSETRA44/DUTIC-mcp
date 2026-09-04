import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { contextFor, currentContext, resolveSemesterId, runWithSemester } from "../core/context.js";
import { DATA_DIR, semesterDir } from "../core/paths.js";
import {
  getEntry,
  listSemesters,
  removeSemester,
  setActiveSemester,
  upsertSemester,
} from "../core/registry.js";
import {
  compareSemesters,
  formatSemesterLabel,
  normalizeSemester,
  sortSemesters,
  type SemesterId,
} from "../core/semester.js";
import { isValid, loadSession } from "../core/session.js";

/**
 * Vista de alto nivel del multi-semestre: es lo que consumen por igual la CLI (`dutic semester`)
 * y el MCP (`dutic_semester_*`). Ninguna de las dos capas vuelve a razonar sobre el registro ni
 * sobre el disco por su cuenta, así que las dos responden exactamente lo mismo —que es el punto
 * de tener una fachada y no dos implementaciones parecidas.
 */

export interface SemesterState {
  id: SemesterId;
  label: string | null;
  /** Etiqueta legible "2026-A". */
  display: string;
  /** true si es el semestre en el que se está trabajando ahora. */
  active: boolean;
  /** true si fue confirmado contra el servidor por el descubrimiento. */
  verified: boolean;
  /** true si hay una sesión de Moodle guardada y utilizable para ese período. */
  hasSession: boolean;
  sessionCapturedAt: string | null;
  /** Cursos guardados en la base de ese semestre (0 si nunca se escaneó). */
  scannedCourses: number;
  lastUsedAt: string | null;
  /** Bytes que ocupa el estado local del período. */
  bytes: number;
  dir: string;
}

/** Suma recursiva del tamaño de un directorio; 0 si no existe. */
function dirBytes(dir: string): number {
  let total = 0;
  try {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      total += st.isDirectory() ? dirBytes(full) : st.size;
    }
  } catch {
    /* inexistente o sin permisos */
  }
  return total;
}

function countScannedCourses(id: SemesterId): number {
  try {
    const file = join(semesterDir(id), "courses-db.json");
    if (!existsSync(file)) return 0;
    // Sólo se necesita el número de claves; leerlo entero es barato frente a una petición de red.
    return Object.keys(JSON.parse(readFileSync(file, "utf8")) ?? {}).length;
  } catch {
    return 0;
  }
}

/**
 * Semestres conocidos = los del registro MÁS los que tienen datos en disco. La unión importa:
 * un usuario que restaura un backup, o que viene del layout plano anterior, tiene directorios
 * cuyo período nunca pasó por el registro, y esconderlos haría creer que esos datos se perdieron.
 */
export function knownSemesters(): SemesterId[] {
  const ids = new Set(listSemesters().map((e) => e.id));
  try {
    for (const name of readdirSync(join(DATA_DIR, "semesters"))) {
      const id = normalizeSemester(name);
      if (id) ids.add(id);
    }
  } catch {
    /* aún no hay directorio de semestres */
  }
  return sortSemesters([...ids]).reverse();
}

/** Estado completo de un semestre (toca disco, no red). */
export async function getSemesterState(id: SemesterId): Promise<SemesterState> {
  const entry = getEntry(id);
  const ctx = contextFor(id);
  const session = await runWithSemester(ctx, () => loadSession(ctx));
  return {
    id,
    label: entry?.label ?? null,
    display: formatSemesterLabel(id),
    active: currentContext().id === id,
    verified: entry?.verified ?? false,
    hasSession: isValid(session),
    sessionCapturedAt: session ? new Date(session.capturedAt).toISOString() : null,
    scannedCourses: countScannedCourses(id),
    lastUsedAt: entry?.lastUsedAt ? new Date(entry.lastUsedAt).toISOString() : null,
    bytes: dirBytes(semesterDir(id)),
    dir: semesterDir(id),
  };
}

/** Estado de todos los semestres conocidos, del más reciente al más antiguo. */
export async function listSemesterStates(): Promise<SemesterState[]> {
  return Promise.all(knownSemesters().map(getSemesterState));
}

export interface SwitchResult {
  previous: SemesterId;
  current: SemesterId;
  /** true si ese período ya tiene sesión: si es false, hay que correr `dutic login`. */
  hasSession: boolean;
  state: SemesterState;
}

/**
 * Cambia el semestre activo. NO inicia sesión: informar de que falta es más honesto que abrir un
 * navegador sin que nadie lo haya pedido —y en el MCP, donde no hay a quién enseñárselo, sería
 * directamente un cuelgue silencioso. El llamador decide qué hacer con `hasSession: false`.
 */
export async function switchSemester(raw: string): Promise<SwitchResult> {
  const id = normalizeSemester(raw);
  if (!id) {
    throw new Error(
      `"${raw}" no es un semestre válido. Se espera algo como 2026A, 2026-B o 2026II.`,
    );
  }
  const previous = currentContext().id;
  setActiveSemester(id);
  // El estado se calcula YA dentro del semestre nuevo. Si se calculara fuera, `active` saldría
  // false —porque el contexto de la llamada sigue siendo el anterior— y el llamador recibiría un
  // objeto que se contradice a sí mismo justo en el campo que acaba de cambiar.
  const next = contextFor(id, "registry");
  const state = await runWithSemester(next, () => getSemesterState(id));
  return { previous, current: id, hasSession: state.hasSession, state };
}

/** Pone o quita la etiqueta de un semestre. */
export function labelSemester(id: SemesterId, label: string | null): void {
  upsertSemester(id, { label: label?.trim() || null });
}

export interface ForgetResult {
  id: SemesterId;
  removedFromRegistry: boolean;
  purgedDir: string | null;
  bytesFreed: number;
}

/**
 * Da de baja un semestre. Por defecto sólo lo quita del registro y DEJA los datos en disco: son
 * el expediente académico de un ciclo entero y no deben evaporarse por un comando de gestión de
 * listas. Con `purge` se borra el directorio, que es una operación explícita y aparte.
 */
export async function forgetSemester(
  raw: string,
  opts: { purge?: boolean } = {},
): Promise<ForgetResult> {
  const id = normalizeSemester(raw);
  if (!id) throw new Error(`"${raw}" no es un semestre válido.`);
  const dir = semesterDir(id);
  const bytes = opts.purge ? dirBytes(dir) : 0;
  const removed = removeSemester(id);
  let purged: string | null = null;
  if (opts.purge && existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    purged = dir;
  }
  return { id, removedFromRegistry: removed, purgedDir: purged, bytesFreed: bytes };
}

/** Resumen del contexto en curso, con la procedencia del semestre (para `status`). */
export async function currentSemesterSummary(): Promise<
  SemesterState & { source: string; siteUrl: string }
> {
  const ctx = currentContext();
  const state = await getSemesterState(ctx.id);
  return { ...state, source: ctx.source, siteUrl: ctx.siteUrl };
}

export { compareSemesters, resolveSemesterId };
