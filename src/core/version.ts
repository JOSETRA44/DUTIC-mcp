import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Versión del paquete, leída de su propio package.json (`dist/core/` y `src/core/` están a dos
 * niveles de la raíz). Una sola fuente para la CLI, el servidor MCP y lo que se envía a los
 * servicios remotos: así el número nunca se desincroniza de lo que realmente se publicó.
 */
export const APP_VERSION: string = (() => {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
