import { createHash, randomBytes } from "node:crypto";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { APP_VERSION } from "../core/version.js";
import { loadState, updateState } from "./consent.js";
import { postJson } from "./transport.js";

/**
 * Credencial de la instalación.
 *
 * El secreto (256 bits) se genera y se queda en ESTE equipo; al servidor sólo le llega su
 * sha256 en el alta, y el secreto viaja únicamente en la cabecera de cada envío, sobre TLS.
 * Así la base nunca guarda algo con lo que se pueda escribir en nombre de nadie.
 */

export interface InstallCredential {
  id: string;
  secret: string;
}

/** Entorno técnico: lo que explica un fallo. Ni hostname, ni usuario del sistema, ni rutas. */
export function deviceInfo() {
  const intl = Intl.DateTimeFormat().resolvedOptions();
  return {
    os: platform(),
    osRelease: release(),
    arch: arch(),
    node: process.version,
    cpuCount: cpus().length,
    memGb: Math.round(totalmem() / 1024 ** 3),
    locale: intl.locale,
    timezone: intl.timeZone,
    appVersion: APP_VERSION,
  };
}

export const hashSecret = (secret: string): string => createHash("sha256").update(secret).digest("hex");

let inflight: Promise<InstallCredential | null> | null = null;

/**
 * Devuelve la credencial, registrando la instalación la primera vez. `null` si todavía no se
 * pudo (sin red, servidor caído, límite de altas): se reintentará en el próximo envío.
 */
export function ensureInstall(): Promise<InstallCredential | null> {
  const current = loadState().install;
  if (current?.id) return Promise.resolve({ id: current.id, secret: current.secret });

  inflight ??= (async () => {
    try {
      // El secreto se persiste ANTES del alta: si la respuesta se pierde, el reintento envía
      // el mismo hash y el servidor devuelve la misma instalación.
      const secret = current?.secret ?? randomBytes(32).toString("base64url");
      if (!current) updateState({ install: { id: null, secret } });

      const res = await postJson("telemetry-register", { secretHash: hashSecret(secret), device: deviceInfo() });
      const id = typeof res.data.installId === "string" ? res.data.installId : null;
      if (res.status !== 200 || !id) return null;

      updateState({ install: { id, secret } });
      return { id, secret };
    } catch {
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** El servidor ya no reconoce la credencial (olvidada o revocada): se descarta y se pedirá otra. */
export function resetInstall(): void {
  updateState({ install: null });
}
