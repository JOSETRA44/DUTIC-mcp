import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Huella de un error: el mismo fallo produce la misma huella aunque ocurra en mil máquinas,
 * y así la consola lo cuenta como UN problema en vez de mil filas.
 *
 * Qué entra: clase del error, código y los primeros marcos de pila DENTRO del código de dutic,
 * como `función@módulo`. Qué no entra, a propósito:
 *   · el mensaje — lleva datos variables (ids, nombres de curso) que partirían el grupo;
 *   · los números de línea — cambian con cualquier edición y cada versión rompería el grupo;
 *   · marcos de Node o de dependencias — describen DÓNDE se manifestó, no NUESTRO fallo;
 *   · la ruta absoluta — contiene el usuario del sistema y difiere entre instalaciones.
 * `dist/` y `src/` se igualan, así que el mismo fallo en desarrollo y publicado coincide.
 */

/** Raíz del paquete (`dist/telemetry/` o `src/telemetry/` → dos niveles arriba). */
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const FRAME = /^at (?:(.+?) \()?(.+?):\d+:\d+\)?$/;

function toPath(location: string): string {
  if (location.startsWith("file:")) {
    try {
      return fileURLToPath(location);
    } catch {
      return location;
    }
  }
  return location;
}

const withSlashes = (p: string) => p.replace(/\\/g, "/");

/** Marcos de pila propios de dutic, normalizados como `función@módulo`. */
export function normalizeFrames(stack: string | undefined, root: string = PKG_ROOT, limit = 5): string[] {
  if (!stack) return [];
  const base = withSlashes(root).replace(/\/$/, "");
  const frames: string[] = [];

  for (const raw of stack.split("\n")) {
    const match = FRAME.exec(raw.trim());
    if (!match) continue;
    const file = withSlashes(toPath(match[2]));
    // Windows no distingue mayúsculas en rutas: la comparación sí se hace en minúsculas, pero
    // el nombre del módulo se conserva tal cual.
    if (!file.toLowerCase().startsWith(`${base.toLowerCase()}/`)) continue;

    const relative = file.slice(base.length + 1);
    // Instalado globalmente, el paquete vive dentro de node_modules; lo que importa es que el
    // marco no sea de una dependencia DEL paquete.
    if (relative.includes("node_modules/")) continue;

    const module = relative.replace(/^(?:dist|src)\//, "").replace(/\.(?:[cm]?js|ts)$/, "");
    const fn = (match[1] ?? "<anónima>").replace(/^async /, "").replace(/ \[as .+\]$/, "");
    frames.push(`${fn}@${module}`);
    if (frames.length >= limit) break;
  }
  return frames;
}

export interface ErrorIdentity {
  errorClass: string;
  code: string | null;
  fingerprint: string;
}

const CLASS_NAME = /^[\w.$]{1,80}$/;

/** Clase, código y huella de cualquier cosa que se haya lanzado (no sólo instancias de Error). */
export function identifyError(err: unknown, root: string = PKG_ROOT): ErrorIdentity {
  const isObject = typeof err === "object" && err !== null;
  const e = (isObject ? err : {}) as {
    name?: unknown;
    code?: unknown;
    moodleErrorCode?: unknown;
    stack?: unknown;
    constructor?: { name?: string };
  };

  // Un `throw "texto"` no es un String: se clasifica por su tipo primitivo.
  const name = typeof e.name === "string" && CLASS_NAME.test(e.name) ? e.name : null;
  const ctor = isObject ? e.constructor?.name : undefined;
  const errorClass = name ?? (ctor && CLASS_NAME.test(ctor) ? ctor : typeof err);

  const rawCode = e.moodleErrorCode ?? e.code;
  const code =
    typeof rawCode === "string" || typeof rawCode === "number"
      ? String(rawCode).replace(/[^\w.:-]/g, "_").slice(0, 80) || null
      : null;

  const frames = normalizeFrames(typeof e.stack === "string" ? e.stack : undefined, root);
  const fingerprint = createHash("sha256")
    .update([errorClass, code ?? "", ...frames].join("|"))
    .digest("hex");

  return { errorClass, code, fingerprint };
}
