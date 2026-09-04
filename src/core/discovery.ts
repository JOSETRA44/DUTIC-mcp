import { HOST } from "./config.js";
import { fetchUnsa } from "./http.js";
import { upsertSemester } from "./registry.js";
import {
  inferSemesterFromDate,
  nextSemester,
  prevSemester,
  semesterRange,
  type SemesterId,
} from "./semester.js";

/**
 * Descubrimiento de semestres: en vez de que el usuario escriba a mano qué períodos existen, se
 * sondea el aula virtual. Cada período es un Moodle montado en https://HOST/{ID}/, así que la
 * pregunta "¿existe 2025A?" se responde pidiendo su página de login.
 *
 * El sondeo es de sólo lectura, va con concurrencia limitada y sobre un rango acotado. No es un
 * barrido: son unas pocas peticiones GET a una página pública que cualquiera vería en el
 * navegador, del mismo orden que abrir el sitio a mano.
 */

export interface ProbeResult {
  id: SemesterId;
  exists: boolean;
  status: number;
  /**
   * false cuando el sondeo NO permite concluir nada: fallo de red o un 5xx del servidor. Se
   * separa de `exists` a propósito, porque "el aula no existe" (404) y "el servidor estaba caído
   * en ese instante" (503) son cosas distintas y mezclarlas haría desaparecer de la lista un
   * semestre real por un problema pasajero.
   */
  conclusive: boolean;
  /** Título del sitio, si la página lo trae — sirve para confirmar que es el aula correcta. */
  title: string | null;
  error?: string;
}

/** Cuántos sondeos en paralelo. Bajo a propósito: el servidor de la UNSA no es rápido. */
const PROBE_CONCURRENCY = 4;
const PROBE_TIMEOUT_MS = 12_000;

/**
 * Un período existe si su login responde 200 y la página es realmente de Moodle. El código de
 * estado por sí solo no basta: los servidores mal configurados devuelven 200 con una página de
 * error genérica, y eso registraría semestres fantasma.
 */
function looksLikeMoodleLogin(html: string): boolean {
  return /moodle|loginform|potentialidps|login\/index\.php/i.test(html);
}

function extractTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(html);
  return m ? m[1].replace(/\s+/g, " ").trim() || null : null;
}

export async function probeSemester(id: SemesterId): Promise<ProbeResult> {
  const url = `https://${HOST}/${id}/login/index.php`;
  try {
    const res = await fetchUnsa(url, { redirect: "follow" }, PROBE_TIMEOUT_MS);
    const html = res.status === 200 ? await res.text() : "";
    return {
      id,
      exists: res.status === 200 && looksLikeMoodleLogin(html),
      status: res.status,
      conclusive: res.status < 500,
      title: extractTitle(html),
    };
  } catch (err) {
    return {
      id,
      exists: false,
      status: 0,
      conclusive: false,
      title: null,
      error: (err as Error).message,
    };
  }
}

/** Sondea varios períodos con concurrencia acotada, preservando el orden de entrada. */
export async function probeSemesters(
  ids: SemesterId[],
  onProgress: (done: number, total: number, last: ProbeResult) => void = () => {},
): Promise<ProbeResult[]> {
  const results = new Array<ProbeResult>(ids.length);
  let cursor = 0;
  let done = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= ids.length) return;
      const r = await probeSemester(ids[i]);
      results[i] = r;
      onProgress(++done, ids.length, r);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(PROBE_CONCURRENCY, ids.length) }, () => worker()),
  );
  return results;
}

/**
 * Rango por defecto a sondear: un año hacia atrás y medio hacia delante desde el período que
 * toca por calendario. Cubre el caso real —consultar el ciclo pasado y anticiparse al siguiente
 * cuando el aula ya está montada pero aún no empieza— sin convertirse en un escaneo amplio.
 */
export function defaultProbeRange(from?: string | null, to?: string | null): SemesterId[] {
  const now = inferSemesterFromDate();
  const start = from ?? prevSemester(prevSemester(now));
  const end = to ?? nextSemester(now);
  return semesterRange(start, end);
}

/**
 * Sondea y da de alta en el registro los que existan. Devuelve todos los resultados —también los
 * negativos— para que la CLI pueda mostrar qué se descartó y por qué.
 */
export async function discoverSemesters(opts: {
  from?: string | null;
  to?: string | null;
  onProgress?: (done: number, total: number, last: ProbeResult) => void;
} = {}): Promise<ProbeResult[]> {
  const ids = defaultProbeRange(opts.from, opts.to);
  const results = await probeSemesters(ids, opts.onProgress);
  for (const r of results) {
    if (r.exists) upsertSemester(r.id, { verified: true });
  }
  return results;
}
