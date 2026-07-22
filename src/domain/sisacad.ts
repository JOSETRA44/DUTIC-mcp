import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { CHROME_USER_AGENT, DATA_DIR } from "../core/config.js";
import { parseCourseName } from "../core/coursename.js";

/**
 * Integración ASISTIDA con SISACAD (consulta de notas parciales de la UNSA), un sistema aparte
 * del aula virtual protegido por CAPTCHA. La herramienta NO resuelve el CAPTCHA ni automatiza el
 * login: abre el navegador, el USUARIO ingresa con sus credenciales y resuelve el CAPTCHA, y sólo
 * cuando aparecen SUS PROPIAS notas la herramienta lee la tabla y la guarda. Sólo datos del propio
 * usuario; nunca de terceros.
 */

export const SISACAD_URL = "http://extranet.unsa.edu.pe/sisacad/parciales18/";
const STORE_FILE = join(DATA_DIR, "sisacad.json");

/** Un ítem evaluado: una fila real de la tabla de SISACAD. */
export interface SisacadItem {
  parcial: string;
  group: string | null;
  /** Nota 0–20, o null si aún no está registrada. */
  grade: number | null;
  /** Peso en el promedio del curso (0–100), o null si no se pudo leer. */
  weight: number | null;
  absent: boolean;
}

/** Notas de un curso, agrupadas y con el promedio ponderado calculado hasta ahora. */
export interface SisacadCourseGrades {
  subject: string;
  group: string | null;
  items: SisacadItem[];
  /** Suma de pesos de los ítems ya calificados (0–100). */
  weightSoFar: number;
  /** Promedio ponderado sobre lo ya calificado (no proyecta lo pendiente). */
  weightedAverageSoFar: number | null;
  /** true si todos los ítems con peso > 0 tienen nota. */
  complete: boolean;
}

export interface SisacadCapture {
  capturedAt: number;
  /** Título/encabezado de la página (p. ej. nombre del alumno, si aparece). */
  header: string | null;
  /** Todas las tablas de la página, como filas de celdas de texto (crudo, por si el parser falla). */
  tables: string[][][];
  /** Notas agrupadas por curso — la forma útil para mostrar/comparar. */
  courses: SisacadCourseGrades[];
}

async function launchBrowser(): Promise<Browser> {
  const preferred = process.env.DUTIC_BROWSER_CHANNEL?.trim();
  const channels = preferred
    ? [preferred === "chromium" ? undefined : preferred]
    : ["chrome", "msedge", undefined];
  let lastErr: unknown;
  for (const channel of channels) {
    try {
      return await chromium.launch({ headless: false, ...(channel ? { channel } : {}) });
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`No se pudo lanzar el navegador: ${String((lastErr as Error)?.message ?? lastErr)}`);
}

/**
 * Convierte las tablas crudas capturadas en cursos agrupados con notas. Formato real de SISACAD
 * (`parciales18`): columnas "Nro. | Asignatura | Parcial | Grupo | Nota | Peso | Ausente", con
 * una fila vacía como separador entre asignaturas. Es tolerante a variaciones de columnas.
 */
export function parseSisacadTables(tables: string[][][]): SisacadCourseGrades[] {
  // Tomar la tabla con más filas de datos (la de notas).
  const main = tables
    .slice()
    .sort((a, b) => b.length - a.length)[0];
  if (!main || main.length < 2) return [];

  const header = main[0].map((h) => h.toLowerCase());
  const idx = (name: string) => header.findIndex((h) => h.includes(name));
  const iSubject = idx("asignatura");
  const iParcial = idx("parcial");
  const iGroup = idx("grupo");
  const iGrade = idx("nota");
  const iWeight = idx("peso");
  const iAbsent = idx("ausente");
  if (iSubject < 0) return [];

  const byCourse = new Map<string, SisacadCourseGrades>();
  const order: string[] = [];

  for (const row of main.slice(1)) {
    const subject = row[iSubject]?.trim();
    if (!subject) continue; // fila vacía separadora
    const group = iGroup >= 0 ? row[iGroup]?.trim() || null : null;
    const gradeRaw = iGrade >= 0 ? row[iGrade]?.trim() : "";
    const weightRaw = iWeight >= 0 ? row[iWeight]?.trim() : "";
    const grade = gradeRaw && /^\d+([.,]\d+)?$/.test(gradeRaw) ? Number(gradeRaw.replace(",", ".")) : null;
    const weight = weightRaw ? Number(weightRaw.replace(/[^\d.,]/g, "").replace(",", ".")) : null;
    const absent = /^s[ií]$/i.test((iAbsent >= 0 ? row[iAbsent] : "") ?? "");

    const key = `${subject}|${group ?? ""}`;
    if (!byCourse.has(key)) {
      byCourse.set(key, { subject, group, items: [], weightSoFar: 0, weightedAverageSoFar: null, complete: true });
      order.push(key);
    }
    byCourse.get(key)!.items.push({
      parcial: iParcial >= 0 ? row[iParcial]?.trim() || "?" : "?",
      group,
      grade,
      weight,
      absent,
    });
  }

  const courses = order.map((k) => byCourse.get(k)!);
  for (const c of courses) {
    let weightedSum = 0;
    let weightSoFar = 0;
    let complete = true;
    for (const it of c.items) {
      if (it.weight == null) continue;
      if (it.grade != null) {
        weightedSum += it.grade * it.weight;
        weightSoFar += it.weight;
      } else if (it.weight > 0) {
        complete = false;
      }
    }
    c.weightSoFar = weightSoFar;
    c.weightedAverageSoFar = weightSoFar > 0 ? Math.round((weightedSum / weightSoFar) * 100) / 100 : null;
    c.complete = complete;
  }
  return courses;
}

/**
 * Abre SISACAD y espera a que el USUARIO inicie sesión (usuario + clave + CAPTCHA). Detecta que
 * ya está dentro cuando el formulario de login desaparece y hay una tabla con datos, entonces lee
 * las tablas de la página. `onStatus` reporta el progreso (incluye avisos periódicos de tiempo
 * restante, para no dejar al usuario sin feedback mientras resuelve el CAPTCHA).
 */
export async function captureSisacadGrades(opts: {
  timeoutMs?: number;
  onStatus?: (msg: string) => void;
}): Promise<SisacadCapture> {
  // 15 min por defecto: da margen de sobra para leer, escribir usuario/clave y resolver el
  // CAPTCHA sin sentir presión de tiempo (antes 5 min resultaba justo).
  const { timeoutMs = 900_000, onStatus = () => {} } = opts;
  await mkdir(DATA_DIR, { recursive: true });

  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({
      userAgent: CHROME_USER_AGENT,
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    onStatus(`Abriendo SISACAD → ${SISACAD_URL}`);
    await page.goto(SISACAD_URL, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
    onStatus(
      "Ingresa con tu usuario y clave y resuelve el CAPTCHA en la ventana (sin apuro, hay 15 min). " +
        "Cuando se muestren tus notas, la herramienta las leerá sola…",
    );

    // Sondeo propio (en vez de un solo waitForFunction largo) para poder avisar el tiempo
    // restante y sobrevivir a recargas de página tras un CAPTCHA fallido.
    const deadline = Date.now() + timeoutMs;
    let ready = false;
    while (Date.now() < deadline) {
      ready = await page
        .evaluate(() => {
          const g = globalThis as unknown as { document: any };
          const hasLogin = !!g.document.querySelector('input[name="clave"], input[type="password"]');
          const tables = Array.from(g.document.querySelectorAll("table")) as any[];
          const hasData = tables.some((t) => t.querySelectorAll("tr").length > 2);
          return !hasLogin && hasData;
        })
        .catch(() => false);
      if (ready) break;
      const remaining = Math.round((deadline - Date.now()) / 60_000);
      if (remaining > 0 && remaining % 3 === 0) {
        onStatus(`Esperando tu login/CAPTCHA… (~${remaining} min restantes)`);
      }
      await page.waitForTimeout(1500);
    }
    if (!ready) {
      throw new Error(
        "Tiempo agotado esperando el login en SISACAD. Vuelve a ejecutar `dutic sisacad` con más calma.",
      );
    }
    onStatus("Notas detectadas. Leyendo…");

    const header = (await page.evaluate(() => {
      const g = globalThis as unknown as { document: any };
      const h = g.document.querySelector("h1,h2,h3,caption,.titulo");
      return h ? h.textContent.replace(/\s+/g, " ").trim() : null;
    })) as string | null;

    const tables = (await page.evaluate(() => {
      const g = globalThis as unknown as { document: any };
      return (Array.from(g.document.querySelectorAll("table")) as any[]).map((t) =>
        (Array.from(t.querySelectorAll("tr")) as any[]).map((tr) =>
          (Array.from(tr.querySelectorAll("th,td")) as any[]).map((c) =>
            c.textContent.replace(/\s+/g, " ").trim(),
          ),
        ),
      );
    })) as string[][][];

    const capture: SisacadCapture = {
      capturedAt: Date.now(),
      header,
      tables,
      courses: parseSisacadTables(tables),
    };
    await writeFile(STORE_FILE, JSON.stringify(capture, null, 2), "utf8");
    onStatus(`Notas de SISACAD guardadas (${capture.courses.length} curso(s)).`);
    return capture;
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Lee las notas de SISACAD guardadas (las capturó el usuario con `dutic sisacad`). */
export async function loadSisacadGrades(): Promise<SisacadCapture | null> {
  try {
    const raw = JSON.parse(await readFile(STORE_FILE, "utf8"));
    // Compatibilidad: capturas antiguas no tenían `courses` estructurado, sólo `tables`.
    if (!raw.courses && raw.tables) raw.courses = parseSisacadTables(raw.tables);
    return raw as SisacadCapture;
  } catch {
    return null;
  }
}

export interface GradeDiscrepancy {
  subject: string;
  sisacadAverage: number | null;
  moodleTotal: string | null;
  /** Diferencia absoluta cuando ambos son comparables (misma escala 0–20). */
  diff: number | null;
}

/**
 * Compara las notas de SISACAD (oficiales) con las del aula virtual, por asignatura (usando la
 * misma clave normalizada que distingue "II" de "III" y separa duplicados de la OTI). Revela
 * discrepancias entre lo que Moodle calcula y lo que SISACAD tiene registrado oficialmente.
 */
export function compareSisacadWithMoodle(
  sisacad: SisacadCourseGrades[],
  moodle: { courseName: string; total: string | null }[],
): GradeDiscrepancy[] {
  const moodleByKey = new Map<string, string | null>();
  for (const m of moodle) moodleByKey.set(parseCourseName(m.courseName).key, m.total);

  return sisacad.map((s) => {
    const key = parseCourseName(s.subject).key;
    const moodleTotal = moodleByKey.get(key) ?? null;
    const moodleNum = moodleTotal ? Number(moodleTotal.replace(",", ".")) : null;
    const diff =
      s.weightedAverageSoFar != null && moodleNum != null && !Number.isNaN(moodleNum)
        ? Math.abs(s.weightedAverageSoFar - moodleNum)
        : null;
    return { subject: s.subject, sisacadAverage: s.weightedAverageSoFar, moodleTotal, diff };
  });
}
