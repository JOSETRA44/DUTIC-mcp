import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { CHROME_USER_AGENT, DATA_DIR } from "../core/config.js";

/**
 * Integración ASISTIDA con SISACAD (consulta de notas parciales de la UNSA), un sistema aparte
 * del aula virtual protegido por CAPTCHA. La herramienta NO resuelve el CAPTCHA ni automatiza el
 * login: abre el navegador, el USUARIO ingresa con sus credenciales y resuelve el CAPTCHA, y sólo
 * cuando aparecen SUS PROPIAS notas la herramienta lee la tabla y la guarda. Sólo datos del propio
 * usuario; nunca de terceros.
 */

export const SISACAD_URL = "http://extranet.unsa.edu.pe/sisacad/parciales18/";
const STORE_FILE = join(DATA_DIR, "sisacad.json");

export interface SisacadCapture {
  capturedAt: number;
  /** Título/encabezado de la página (p. ej. nombre del alumno, si aparece). */
  header: string | null;
  /** Todas las tablas de la página, como filas de celdas de texto. */
  tables: string[][][];
  /** Mejor intento de tabla de notas (la más grande con celdas numéricas). */
  gradesTable: string[][] | null;
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

/** Elige la tabla que más parece de notas: varias filas y celdas numéricas (0–20). */
function pickGradesTable(tables: string[][][]): string[][] | null {
  let best: string[][] | null = null;
  let bestScore = 0;
  for (const t of tables) {
    if (t.length < 2) continue;
    let numeric = 0;
    for (const row of t)
      for (const cell of row)
        if (/^\d{1,2}([.,]\d+)?$/.test(cell.trim())) numeric++;
    const score = numeric + t.length;
    if (numeric > 0 && score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

/**
 * Abre SISACAD y espera a que el USUARIO inicie sesión (usuario + clave + CAPTCHA). Detecta que
 * ya está dentro cuando el formulario de login desaparece y hay una tabla con datos, entonces lee
 * las tablas de la página. `onStatus` reporta el progreso. Timeout amplio para dar tiempo al login.
 */
export async function captureSisacadGrades(opts: {
  timeoutMs?: number;
  onStatus?: (msg: string) => void;
}): Promise<SisacadCapture> {
  const { timeoutMs = 600_000, onStatus = () => {} } = opts;
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
      "Ingresa con tu usuario y clave y resuelve el CAPTCHA en la ventana. " +
        "Cuando se muestren tus notas, la herramienta las leerá automáticamente…",
    );

    // Dentro = ya no hay campo de clave (login enviado) y hay una tabla con contenido.
    await page.waitForFunction(
      () => {
        const g = globalThis as unknown as { document: any };
        const hasLogin = !!g.document.querySelector('input[name="clave"], input[type="password"]');
        const tables = Array.from(g.document.querySelectorAll("table")) as any[];
        const hasData = tables.some((t) => t.querySelectorAll("tr").length > 2);
        return !hasLogin && hasData;
      },
      { timeout: timeoutMs },
    );
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
      gradesTable: pickGradesTable(tables),
    };
    await writeFile(STORE_FILE, JSON.stringify(capture, null, 2), "utf8");
    onStatus("Notas de SISACAD guardadas.");
    return capture;
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Lee las notas de SISACAD guardadas (las capturó el usuario con `dutic sisacad`). */
export async function loadSisacadGrades(): Promise<SisacadCapture | null> {
  try {
    return JSON.parse(await readFile(STORE_FILE, "utf8")) as SisacadCapture;
  } catch {
    return null;
  }
}
