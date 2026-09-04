import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { DATA_DIR, REGISTRY_FILE } from "./paths.js";
import {
  compareSemesters,
  isSemesterId,
  latestSemester,
  normalizeSemester,
  sortSemesters,
  type SemesterId,
} from "./semester.js";

/**
 * Registro de semestres: `~/.dutic/semesters.json`. Responde a dos preguntas —"¿qué períodos
 * conoce esta instalación?" y "¿en cuál estoy trabajando ahora?"— y guarda lo aprendido de cada
 * uno (que existe de verdad en el servidor, cuándo se usó por última vez, si tiene ruta de
 * matrícula propia).
 *
 * Deliberadamente SÍNCRONO. Es un archivo diminuto que se lee al resolver el contexto, en el
 * camino crítico de cada comando; hacerlo async obligaría a que `currentContext()` fuese async y
 * eso contagiaría de `await` a todos los stores. La ganancia de I/O no compensa ese contagio.
 */

const SemesterEntrySchema = z.object({
  id: z.string(),
  /** Etiqueta que el usuario le puso ("intercambio", "último ciclo"); null si ninguna. */
  label: z.string().nullable().default(null),
  /** true si se confirmó contra el servidor que el aula de ese período existe. */
  verified: z.boolean().default(false),
  /** Ruta del login de matrícula, si difiere del patrón derivado. */
  matriculaPath: z.string().nullable().default(null),
  addedAt: z.number(),
  /** epoch ms del último uso; ordena la lista por relevancia. */
  lastUsedAt: z.number().nullable().default(null),
});
export type SemesterEntry = z.infer<typeof SemesterEntrySchema>;

const RegistrySchema = z.object({
  version: z.literal(1).default(1),
  /** Semestre activo. null = usar la inferencia por fecha. */
  active: z.string().nullable().default(null),
  semesters: z.record(SemesterEntrySchema).default({}),
});
export type Registry = z.infer<typeof RegistrySchema>;

const EMPTY: Registry = { version: 1, active: null, semesters: {} };

export function loadRegistry(): Registry {
  try {
    const parsed = RegistrySchema.parse(JSON.parse(readFileSync(REGISTRY_FILE, "utf8")));
    // Sanea claves corruptas: una entrada cuyo id no normaliza no puede nombrar un directorio.
    const semesters: Record<string, SemesterEntry> = {};
    for (const [key, entry] of Object.entries(parsed.semesters)) {
      const id = normalizeSemester(key);
      if (id) semesters[id] = { ...entry, id };
    }
    const active = parsed.active ? normalizeSemester(parsed.active) : null;
    return { version: 1, active, semesters };
  } catch {
    return { ...EMPTY };
  }
}

export function saveRegistry(reg: Registry): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2) + "\n", "utf8");
  try {
    chmodSync(REGISTRY_FILE, 0o600);
  } catch {
    /* sin permisos POSIX (Windows): no-op */
  }
}

/** Semestres conocidos, del más reciente al más antiguo. */
export function listSemesters(): SemesterEntry[] {
  const reg = loadRegistry();
  return sortSemesters(Object.keys(reg.semesters))
    .reverse()
    .map((id) => reg.semesters[id]);
}

export function getEntry(id: SemesterId): SemesterEntry | null {
  return loadRegistry().semesters[id] ?? null;
}

/**
 * Da de alta o actualiza un semestre. Las propiedades no indicadas se conservan, para que
 * marcar `lastUsedAt` no borre la etiqueta que el usuario escribió ni el `verified` que costó
 * una petición de red.
 */
export function upsertSemester(
  id: SemesterId,
  patch: Partial<Omit<SemesterEntry, "id" | "addedAt">> = {},
): SemesterEntry {
  const reg = loadRegistry();
  const prev = reg.semesters[id];
  const entry: SemesterEntry = {
    id,
    label: patch.label !== undefined ? patch.label : (prev?.label ?? null),
    verified: patch.verified !== undefined ? patch.verified : (prev?.verified ?? false),
    matriculaPath:
      patch.matriculaPath !== undefined ? patch.matriculaPath : (prev?.matriculaPath ?? null),
    addedAt: prev?.addedAt ?? Date.now(),
    lastUsedAt: patch.lastUsedAt !== undefined ? patch.lastUsedAt : (prev?.lastUsedAt ?? null),
  };
  reg.semesters[id] = entry;
  saveRegistry(reg);
  return entry;
}

/** Marca el semestre como usado ahora. Alta implícita si aún no estaba registrado. */
export function touchSemester(id: SemesterId): void {
  upsertSemester(id, { lastUsedAt: Date.now() });
}

export function setActiveSemester(id: SemesterId): void {
  const reg = loadRegistry();
  reg.active = id;
  if (!reg.semesters[id]) {
    reg.semesters[id] = {
      id,
      label: null,
      verified: false,
      matriculaPath: null,
      addedAt: Date.now(),
      lastUsedAt: Date.now(),
    };
  }
  saveRegistry(reg);
}

export function getActiveSemester(): SemesterId | null {
  const active = loadRegistry().active;
  return active && isSemesterId(active) ? active : null;
}

export function clearActiveSemester(): void {
  const reg = loadRegistry();
  reg.active = null;
  saveRegistry(reg);
}

/** Baja del registro. NO borra los datos en disco; de eso se encarga el comando de la CLI. */
export function removeSemester(id: SemesterId): boolean {
  const reg = loadRegistry();
  if (!reg.semesters[id]) return false;
  delete reg.semesters[id];
  if (reg.active === id) {
    // Al quitar el activo, el sucesor natural es el más reciente que quede — no "ninguno",
    // porque dejar el registro sin activo devolvería al usuario a la inferencia por fecha
    // sin avisarle, y podría apuntar a un período que ni siquiera tiene sesión.
    reg.active = latestSemester(Object.keys(reg.semesters));
  }
  saveRegistry(reg);
  return true;
}

/** Semestres conocidos ordenados cronológicamente (ascendente). */
export function knownSemesterIds(): SemesterId[] {
  return sortSemesters(Object.keys(loadRegistry().semesters));
}

export { compareSemesters };
