import { chromium, type Browser } from "playwright";
import { CHROME_USER_AGENT, HOST } from "./config.js";
import type { Session } from "./session.js";

/**
 * Lanza un navegador headless para tareas que necesitan ejecutar el JS de Moodle (p. ej. listar
 * archivos de una carpeta, cuyo árbol se puebla por JavaScript). Se lanza y cierra por llamada
 * para no dejar el proceso vivo ni bloquear el perfil persistente del login.
 */
async function launchHeadless(): Promise<Browser> {
  const preferred = process.env.DUTIC_BROWSER_CHANNEL?.trim();
  const channels = preferred
    ? [preferred === "chromium" ? undefined : preferred]
    : ["chrome", "msedge", undefined];
  let lastErr: unknown;
  for (const channel of channels) {
    try {
      return await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `No se pudo lanzar un navegador headless: ${String((lastErr as Error)?.message ?? lastErr)}`,
  );
}

/**
 * Carga una URL del aula con la sesión inyectada, ejecuta su JS y devuelve todos los enlaces a
 * pluginfile.php presentes en el DOM final. Best-effort: si el tema no expone enlaces (algunos
 * temas renderizan el árbol de carpetas de forma que no deja anchors), devuelve lista vacía.
 */
export async function extractPluginfileLinks(
  session: Session,
  url: string,
): Promise<string[]> {
  const browser = await launchHeadless();
  try {
    const context = await browser.newContext({
      userAgent: CHROME_USER_AGENT,
      ignoreHTTPSErrors: true,
    });
    await context.addCookies([
      { name: "MoodleSession", value: session.moodleSession, domain: HOST, path: "/" },
    ]);
    const page = await context.newPage();
    await page
      .goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 })
      .catch(() => {});
    await page
      .waitForSelector('a[href*="pluginfile.php"]', { timeout: 8_000 })
      .catch(() => {});
    const hrefs = await page.evaluate(() => {
      const doc = (globalThis as unknown as { document: any }).document;
      return Array.from(doc.querySelectorAll('a[href*="pluginfile.php"]')).map(
        (a: any) => a.href as string,
      );
    });
    return [...new Set(hrefs)];
  } finally {
    await browser.close().catch(() => {});
  }
}
