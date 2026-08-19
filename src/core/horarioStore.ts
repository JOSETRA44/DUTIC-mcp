import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { DATA_DIR, HORARIO_CACHE_FILE, SISACAD_LOGIN_FILE } from "./config.js";
import type { SisacadCreds } from "./sisacadClient.js";

/**
 * Estado local del sistema de matrícula (horarios), en dos archivos separados:
 *
 *  - `sisacad-login.json`  credenciales del login de matrícula (chmod 600).
 *  - `horario.json`        último horario descargado, para `dutic hrs show` sin red.
 */

export async function saveSisacadLogin(creds: SisacadCreds): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SISACAD_LOGIN_FILE, JSON.stringify(creds, null, 2), "utf8");
  try {
    await chmod(SISACAD_LOGIN_FILE, 0o600);
  } catch {
    /* ignorar en plataformas sin permisos POSIX */
  }
}

export async function loadSisacadLogin(): Promise<SisacadCreds | null> {
  try {
    const raw = JSON.parse(await readFile(SISACAD_LOGIN_FILE, "utf8"));
    if (!raw || typeof raw.user !== "string" || typeof raw.password !== "string") return null;
    return { user: raw.user, password: raw.password, escuela: String(raw.escuela ?? "") };
  } catch {
    return null;
  }
}

/**
 * Credenciales efectivas. Las variables de entorno tienen prioridad sobre el archivo para poder
 * usar la herramienta en entornos donde no se quiera dejar la clave en disco.
 */
export async function resolveSisacadLogin(): Promise<SisacadCreds | null> {
  const user = process.env.DUTIC_SISACAD_USER?.trim();
  const password = process.env.DUTIC_SISACAD_PASSWORD;
  const escuela = process.env.DUTIC_SISACAD_ESCUELA?.trim();
  if (user && password && escuela) return { user, password, escuela };
  return loadSisacadLogin();
}

export interface HorarioCache {
  fetchedAt: number;
  horario: {
    cui: string;
    name: string | null;
    school: string | null;
    date: string | null;
    blocks: {
      day: string;
      start: string;
      end: string;
      subject: string;
      location: string | null;
    }[];
  };
}

export async function saveHorarioCache(entry: HorarioCache): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(HORARIO_CACHE_FILE, JSON.stringify(entry, null, 2), "utf8");
}

export async function loadHorarioCache(): Promise<HorarioCache | null> {
  try {
    const raw = JSON.parse(await readFile(HORARIO_CACHE_FILE, "utf8"));
    return raw && Array.isArray(raw.horario?.blocks) ? (raw as HorarioCache) : null;
  } catch {
    return null;
  }
}