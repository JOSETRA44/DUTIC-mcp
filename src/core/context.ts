import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync } from "node:fs";
import { HOST } from "./config.js";
import {
  DATA_DIR,
  LEGACY_SESSION_FILE,
  migrateLegacyLayout,
  scopedPaths,
  semesterDir,
  type ScopedPaths,
} from "./paths.js";
import { getActiveSemester, getEntry, touchSemester } from "./registry.js";
import {
  defaultMatriculaPath,
  inferSemesterFromDate,
  normalizeSemester,
  semesterFromUrl,
  type SemesterId,
} from "./semester.js";
import { EXTRANET_HOST } from "./config.js";

/**
 * CONTEXTO DE SEMESTRE: el objeto que dice, para la operación en curso, en qué período estamos y
 * dónde vive su estado. Es la pieza que hace escalable el soporte multi-semestre.
 *
 * ¿Por qué ambiental (AsyncLocalStorage) y no un parámetro más?
 * La capa `domain/` ya es semestre-agnóstica: recibe una `Session` y `session.siteUrl` YA lleva el
 * prefijo del período, así que sus peticiones van al sitio correcto sin saber nada. Los únicos que
 * necesitan el contexto son los módulos de `core/` que tocan disco (sesión, caché, stores) y el
 * login. Pasar un `ctx` por las ~100 firmas del dominio sólo para que llegue a esos diez sitios
 * sería ruido puro. AsyncLocalStorage lo entrega ahí abajo y —clave para el MCP— aísla llamadas
 * concurrentes: dos herramientas pidiendo semestres distintos a la vez no se pisan, cosa que una
 * variable global mutable sí haría.
 *
 * PRECEDENCIA al resolver (de más fuerte a más débil):
 *   1. override explícito   — `--semester` de la CLI, argumento `semester` de una tool MCP.
 *   2. DUTIC_SEMESTER       — fijar el período desde el entorno (scripts, CI, un shell puntual).
 *   3. semestre activo      — la elección persistente del usuario (`dutic semester use`).
 *   4. sesión existente     — si ya hay una sesión guardada, su siteUrl manda: es lo que el
 *                             servidor confirmó, no lo que alguien configuró.
 *   5. inferencia por fecha — instalación nueva sin nada configurado.
 */

export type ContextSource = "override" | "env" | "registry" | "session" | "inferred";

export interface SemesterContext {
  id: SemesterId;
  /** Etiqueta legible del registro, si tiene. */
  label: string | null;
  /** Base del aula virtual para este período, p.ej. https://aulavirtual.unsa.edu.pe/2026A */
  siteUrl: string;
  /** Página de login (donde está el botón de Google OAuth). */
  loginUrl: string;
  /** Base del login de matrícula en SISACAD para este período. */
  matriculaBase: string;
  /** Rutas del estado en disco, todas dentro de `~/.dutic/semesters/<id>/`. */
  paths: ScopedPaths;
  /** De dónde salió el semestre — se muestra en `status` para que nadie adivine. */
  source: ContextSource;
}

const storage = new AsyncLocalStorage<SemesterContext>();

/** Contexto por defecto del proceso; lo fija el arranque de la CLI o del servidor MCP. */
let fallbackContext: SemesterContext | null = null;

/** Semestre que declara la sesión ya guardada, si existe alguna. */
function semesterFromStoredSession(): SemesterId | null {
  // Layout nuevo: cualquier sesión bajo semesters/<id>/session.json.
  const active = getActiveSemester();
  if (active && existsSync(scopedPaths(active).session)) return active;
  // Layout antiguo (aún sin migrar): el siteUrl del session.json plano.
  try {
    if (existsSync(LEGACY_SESSION_FILE)) {
      const raw = JSON.parse(readFileSync(LEGACY_SESSION_FILE, "utf8"));
      return semesterFromUrl(raw?.siteUrl);
    }
  } catch {
    /* archivo ilegible: se ignora y se cae al siguiente nivel */
  }
  return null;
}

/** Resuelve el id del semestre según la precedencia documentada arriba. */
export function resolveSemesterId(override?: string | null): {
  id: SemesterId;
  source: ContextSource;
} {
  const fromOverride = normalizeSemester(override);
  if (fromOverride) return { id: fromOverride, source: "override" };

  const fromEnv = normalizeSemester(process.env.DUTIC_SEMESTER);
  if (fromEnv) return { id: fromEnv, source: "env" };

  const fromRegistry = getActiveSemester();
  if (fromRegistry) return { id: fromRegistry, source: "registry" };

  const fromSession = semesterFromStoredSession();
  if (fromSession) return { id: fromSession, source: "session" };

  return { id: inferSemesterFromDate(), source: "inferred" };
}

/** Construye el contexto de un semestre concreto, sin aplicar precedencia ni tocar el registro. */
export function contextFor(id: SemesterId, source: ContextSource = "override"): SemesterContext {
  const entry = getEntry(id);
  const siteUrl = `https://${HOST}/${id}`;
  const matriculaPath =
    process.env.DUTIC_MATRICULA_PATH?.trim() || entry?.matriculaPath || defaultMatriculaPath(id);
  return {
    id,
    label: entry?.label ?? null,
    siteUrl,
    loginUrl: `${siteUrl}/login/index.php`,
    matriculaBase: `http://${EXTRANET_HOST}/sisacad/${matriculaPath}`,
    paths: scopedPaths(id),
    source,
  };
}

let migrationDone = false;

/**
 * Contexto efectivo para un override dado. La primera invocación del proceso migra el layout
 * plano anterior al directorio del semestre al que pertenecían esos archivos —deducido del
 * siteUrl de la sesión guardada, no de la configuración actual, que podría estar desfasada.
 */
export function resolveContext(override?: string | null): SemesterContext {
  const { id, source } = resolveSemesterId(override);
  if (!migrationDone) {
    migrationDone = true;
    const legacyOwner = semesterFromStoredSession() ?? id;
    if (existsSync(DATA_DIR)) migrateLegacyLayout(legacyOwner);
  }
  return contextFor(id, source);
}

/**
 * Contexto de la operación en curso. Lo leen los stores de `core/`. Si nadie estableció uno
 * (una prueba, un script que importa un módulo suelto), se resuelve uno por defecto en vez de
 * fallar: ningún módulo debería reventar sólo porque no pasó por el arranque de la CLI.
 */
export function currentContext(): SemesterContext {
  const active = storage.getStore();
  if (active) return active;
  if (!fallbackContext) fallbackContext = resolveContext();
  return fallbackContext;
}

/** Fija el contexto por defecto del proceso (arranque de la CLI / del servidor MCP). */
export function setDefaultContext(ctx: SemesterContext): void {
  fallbackContext = ctx;
}

/**
 * Ejecuta `fn` con un contexto de semestre concreto. Todo lo que `fn` lance —incluidas las
 * continuaciones async— verá ese contexto y no el por defecto. Es lo que permite que una tool
 * MCP atienda `semester: "2025A"` sin alterar el estado del servidor para las demás llamadas.
 */
export function runWithSemester<T>(ctx: SemesterContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Azúcar: resuelve el override y ejecuta dentro de ese contexto. */
export function withSemester<T>(override: string | null | undefined, fn: (ctx: SemesterContext) => T): T {
  const ctx = resolveContext(override);
  return runWithSemester(ctx, () => fn(ctx));
}

/** Registra el semestre como usado. Se llama tras una operación con red exitosa. */
export function markContextUsed(ctx: SemesterContext = currentContext()): void {
  try {
    touchSemester(ctx.id);
  } catch {
    /* el registro es conveniencia, nunca motivo de fallo */
  }
}

/** Directorio del semestre en curso (para mensajes de la CLI). */
export function currentSemesterDir(): string {
  return semesterDir(currentContext().id);
}
