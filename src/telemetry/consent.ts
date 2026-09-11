import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../core/paths.js";

/**
 * Estado y consentimiento de la telemetría: `~/.dutic/telemetry.json` (chmod 600).
 *
 * Dos niveles con reglas distintas (Ley 29733):
 *   · TÉCNICA — errores, tiempos, versión, sistema operativo. Seudónima, activa por defecto,
 *     con aviso la primera vez y apagable con `dutic telemetry off`, `DUTIC_TELEMETRY=0` o
 *     `DO_NOT_TRACK=1`.
 *   · IDENTIDAD — nombre, correo e id de Moodle. Sólo con un "sí" explícito.
 *
 * Síncrono a propósito, como `core/registry.ts`: es un archivo diminuto que se lee una vez por
 * proceso, y hacerlo async contagiaría de `await` cada punto que emite un evento.
 */

export type IdentityConsent = "unasked" | "granted" | "denied" | "blocked_by_domain";

export interface TelemetryState {
  version: 1;
  technical: boolean;
  identity: IdentityConsent;
  /** Cuándo se mostró el aviso de primera ejecución (epoch ms). */
  noticeShownAt: number | null;
  /**
   * Credencial de la instalación. El secreto se guarda ANTES de registrarlo: si la respuesta
   * del alta se pierde, el reintento usa el mismo secreto y el servidor devuelve la misma
   * instalación en vez de crear otra.
   */
  install: { id: string | null; secret: string } | null;
}

export const TELEMETRY_DIR = join(DATA_DIR, "telemetry");
const STATE_FILE = join(DATA_DIR, "telemetry.json");

const DEFAULT_STATE: TelemetryState = {
  version: 1,
  technical: true,
  identity: "unasked",
  noticeShownAt: null,
  install: null,
};

let cached: TelemetryState | null = null;

export function loadState(): TelemetryState {
  if (cached) return cached;
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<TelemetryState>;
    cached = {
      ...DEFAULT_STATE,
      technical: raw.technical !== false,
      identity: raw.identity ?? "unasked",
      noticeShownAt: typeof raw.noticeShownAt === "number" ? raw.noticeShownAt : null,
      install:
        raw.install && typeof raw.install.secret === "string"
          ? { id: typeof raw.install.id === "string" ? raw.install.id : null, secret: raw.install.secret }
          : null,
    };
  } catch {
    cached = { ...DEFAULT_STATE };
  }
  return cached;
}

export function updateState(patch: Partial<Omit<TelemetryState, "version">>): TelemetryState {
  const next: TelemetryState = { ...loadState(), ...patch, version: 1 };
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(STATE_FILE, 0o600);
    } catch {
      /* sin permisos POSIX (Windows) */
    }
  } catch {
    /* sin disco escribible: el estado vale para este proceso y nada más */
  }
  cached = next;
  return next;
}

/** Olvida la caché en memoria (pruebas, o tras cambiar el archivo desde otro proceso). */
export function resetStateCache(): void {
  cached = null;
}

/** Motivo por el que el entorno desactiva la telemetría, o `null` si no lo hace. */
export function disabledByEnvironment(env: NodeJS.ProcessEnv = process.env): string | null {
  const flag = env.DUTIC_TELEMETRY?.trim().toLowerCase();
  if (flag === "0" || flag === "off" || flag === "false") return "DUTIC_TELEMETRY";
  if (env.DO_NOT_TRACK === "1" || env.DO_NOT_TRACK?.toLowerCase() === "true") return "DO_NOT_TRACK";
  // En CI no hay una persona a la que avisar ni nada que mejorar a partir de esos datos.
  if (env.CI && env.CI !== "0" && env.CI.toLowerCase() !== "false") return "CI";
  return null;
}

export function technicalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return disabledByEnvironment(env) === null && loadState().technical;
}

export function identityGranted(env: NodeJS.ProcessEnv = process.env): boolean {
  return technicalEnabled(env) && loadState().identity === "granted";
}
