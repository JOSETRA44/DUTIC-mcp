import { open, readFile, unlink } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";

/**
 * Lock de instancia única basado en archivo.
 *
 * Existe por una razón concreta: el perfil persistente de Playwright
 * (BROWSER_PROFILE_DIR) sólo admite UN proceso a la vez — `launchContext` en
 * core/login.ts detecta el "ProcessSingleton/SingletonLock" de Chrome y falla. Si la
 * tarea programada renueva la sesión justo cuando el estudiante corre un comando a
 * mano, uno de los dos revienta con un error confuso. El proceso de fondo usa esto
 * para CEDER en silencio; los comandos manuales nunca esperan a nadie.
 *
 * La adquisición es atómica: `open(path, "wx")` falla si el archivo ya existe, que es
 * la primitiva estándar para esto (no hay carrera entre comprobar y crear).
 */

export interface LockInfo {
  pid: number;
  startedAt: number;
  label: string;
}

export interface LockHandle {
  release(): Promise<void>;
}

/** Un lock más viejo que esto se considera huérfano aunque el PID parezca vivo. */
const DEFAULT_STALE_MS = 15 * 60 * 1000;

function lockPath(name: string): string {
  return join(DATA_DIR, `${name}.lock`);
}

/** ¿Sigue vivo ese proceso? `kill(pid, 0)` no envía señal: sólo comprueba existencia. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = existe pero es de otro usuario; ESRCH = no existe.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Lee el lock actual, o null si no hay ninguno (o está corrupto). */
export async function readLock(name: string): Promise<LockInfo | null> {
  try {
    return JSON.parse(await readFile(lockPath(name), "utf8")) as LockInfo;
  } catch {
    return null;
  }
}

/**
 * Intenta tomar el lock. Devuelve null si otro proceso vivo lo tiene — el llamador
 * decide si ceder o continuar. Un lock huérfano (proceso muerto o demasiado viejo) se
 * roba automáticamente, para que un cuelgue no deje la automatización muerta para
 * siempre.
 */
export async function acquireLock(
  name: string,
  opts: { label?: string; staleMs?: number } = {},
): Promise<LockHandle | null> {
  const { label = name, staleMs = DEFAULT_STALE_MS } = opts;
  const file = lockPath(name);
  mkdirSync(DATA_DIR, { recursive: true });

  const write = async (): Promise<LockHandle | null> => {
    try {
      const handle = await open(file, "wx"); // atómico: falla si ya existe
      const info: LockInfo = { pid: process.pid, startedAt: Date.now(), label };
      await handle.writeFile(JSON.stringify(info), "utf8");
      await handle.close();
      return {
        release: async () => {
          // Sólo borrar si el lock sigue siendo nuestro (no pisar al que nos lo robó).
          const current = await readLock(name);
          if (current?.pid === process.pid) await unlink(file).catch(() => {});
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      return null;
    }
  };

  const first = await write();
  if (first) return first;

  // Ya existe: decidir si está huérfano.
  const existing = await readLock(name);
  const orphaned =
    !existing ||
    Date.now() - existing.startedAt > staleMs ||
    !processAlive(existing.pid);

  if (!orphaned) return null;

  await unlink(file).catch(() => {});
  return write();
}
