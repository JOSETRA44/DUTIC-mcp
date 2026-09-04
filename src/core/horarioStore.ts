import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { DATA_DIR, SISACAD_LOGIN_FILE } from "./config.js";
import { currentContext } from "./context.js";
import type { Horario } from "../domain/horario.js";
import type { SisacadCreds } from "./sisacadClient.js";

/**
 * Estado local del sistema de matrícula (horarios), en dos archivos separados:
 *
 *  - `sisacad-login.json`  credenciales del login de matrícula (chmod 600) — GLOBAL: el usuario
 *                          y la clave de matrícula son los mismos en todos los períodos.
 *  - `horario.json`        último horario descargado, para `dutic hrs show` sin red — POR
 *                          SEMESTRE: el horario es justamente lo que cambia cada ciclo.
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
  horario: Horario;
}

export async function saveHorarioCache(entry: HorarioCache): Promise<void> {
  const ctx = currentContext();
  await mkdir(ctx.paths.dir, { recursive: true });
  await writeFile(ctx.paths.horario, JSON.stringify(entry, null, 2), "utf8");
}

export async function loadHorarioCache(): Promise<HorarioCache | null> {
  try {
    const raw = JSON.parse(await readFile(currentContext().paths.horario, "utf8"));
    if (!raw || !Array.isArray(raw.horario?.blocks)) return null;
    // Normaliza cachés de versiones anteriores (sin code/label/group) al formato actual.
    const h = raw.horario;
    const horario: Horario = {
      cui: String(h.cui ?? ""),
      name: h.name ?? null,
      school: h.school ?? null,
      date: h.date ?? null,
      code: h.code ?? null,
      label: h.label ?? null,
      blocks: h.blocks.map((b: { day: string; start: string; end: string; subject: string; location: string | null; group: string | null }) => ({
        day: String(b.day),
        start: String(b.start),
        end: String(b.end),
        subject: String(b.subject),
        location: b.location ?? null,
        group: b.group ?? null,
      })),
    };
    return { fetchedAt: raw.fetchedAt, horario };
  } catch {
    return null;
  }
}