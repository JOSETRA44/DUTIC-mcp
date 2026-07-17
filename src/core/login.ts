import { mkdir } from "node:fs/promises";
import { chromium, type BrowserContext } from "playwright";
import {
  BROWSER_PROFILE_DIR,
  CHROME_USER_AGENT,
  DATA_DIR,
  getLoginUrl,
  HOST,
} from "./config.js";
import { deriveSiteUrl, saveSession, type Session } from "./session.js";

/**
 * Extrae el sesskey desde la página cargada. Moodle 4.x inyecta window.M.cfg.sesskey de
 * forma asíncrona vía RequireJS, así que se consultan varias fuentes en orden.
 */
const SESSKEY_SNIPPET = `(() => {
  try { if (window.M && window.M.cfg && window.M.cfg.sesskey) return window.M.cfg.sesskey; } catch (_) {}
  const el = document.querySelector('input[name="sesskey"]');
  if (el && el.value) return el.value;
  const a = document.querySelector('a[href*="logout.php?sesskey="]');
  if (a) { const p = a.href.split('sesskey='); if (p.length > 1) return p[1].split('&')[0]; }
  const node = document.querySelector('[data-sesskey]');
  if (node) return node.getAttribute('data-sesskey');
  return '';
})()`;

/**
 * Lanza el contexto persistente. Por defecto usa el Google Chrome instalado del sistema
 * (channel 'chrome'), evitando descargar el Chromium de Playwright (~184 MB). Si Chrome no
 * está disponible, cae al Chromium empaquetado. Se puede forzar con DUTIC_BROWSER_CHANNEL
 * ('chrome' | 'msedge' | 'chromium').
 */
async function launchContext(headless: boolean): Promise<BrowserContext> {
  const common = {
    headless,
    userAgent: CHROME_USER_AGENT,
    // La UNSA usa una CA privada no confiada por defecto.
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 800 },
  } as const;

  const preferred = process.env.DUTIC_BROWSER_CHANNEL?.trim();
  const channels = preferred
    ? [preferred === "chromium" ? undefined : preferred]
    : ["chrome", "msedge", undefined];

  let lastErr: unknown;
  for (const channel of channels) {
    try {
      return await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
        ...common,
        ...(channel ? { channel } : {}),
      });
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `No se pudo lanzar un navegador (Chrome/Edge/Chromium). ` +
      `Instala Google Chrome o ejecuta \`npx playwright install chromium\`. Detalle: ${String((lastErr as Error)?.message ?? lastErr)}`,
  );
}

export interface LoginOptions {
  /**
   * Si es true, corre headless (sólo sirve cuando la sesión SSO de Google ya está viva en
   * el perfil persistente y no requiere interacción). Si false, muestra el navegador para
   * que el usuario complete el login de Google la primera vez.
   */
  headless?: boolean;
  /** Timeout total para completar el login, en ms. */
  timeoutMs?: number;
  /** Callback opcional para reportar progreso (a stderr en CLI, a log en MCP). */
  onStatus?: (msg: string) => void;
}

/**
 * Lanza un navegador con perfil persistente, deja que el usuario/SSO complete el login de
 * Google, y captura la cookie MoodleSession + el sesskey al llegar al dashboard /my.
 *
 * El perfil persistente en BROWSER_PROFILE_DIR mantiene viva la sesión de Google entre
 * ejecuciones, de modo que las renovaciones futuras normalmente no requieren volver a
 * escribir credenciales.
 */
export async function loginWithPlaywright(opts: LoginOptions = {}): Promise<Session> {
  const { headless = false, timeoutMs = 180_000, onStatus = () => {} } = opts;
  await mkdir(DATA_DIR, { recursive: true });

  const loginUrl = getLoginUrl();
  onStatus(`Abriendo navegador → ${loginUrl}`);

  const context = await launchContext(headless);

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

    onStatus(
      "Completa el inicio de sesión con Google en la ventana del navegador. " +
        "Esperando a llegar al panel /my ...",
    );

    // Esperar a que la navegación aterrice en el dashboard del usuario.
    await page.waitForURL((url) => /\/my\/?($|\?)/.test(url.pathname), {
      timeout: timeoutMs,
      waitUntil: "domcontentloaded",
    });

    const dashboardUrl = page.url();
    const origin = new URL(dashboardUrl).origin;
    const siteUrl = deriveSiteUrl(dashboardUrl, origin);

    // Extraer sesskey con reintentos (RequireJS lo inyecta async).
    let sesskey = "";
    for (const delay of [0, 800, 1600, 2500, 4000]) {
      if (delay) await page.waitForTimeout(delay);
      sesskey = String((await page.evaluate(SESSKEY_SNIPPET)) ?? "").trim();
      if (sesskey) break;
    }
    if (!sesskey) {
      throw new Error("No se pudo extraer el sesskey del dashboard de Moodle.");
    }

    // Cookie MoodleSession: se busca sobre la URL del sitio (scope Path=/{semestre}/).
    const cookies = await context.cookies(siteUrl);
    const moodleCookie = cookies.find((c) => c.name === "MoodleSession");
    if (!moodleCookie?.value) {
      throw new Error("No se encontró la cookie MoodleSession tras el login.");
    }

    const session: Session = {
      moodleSession: moodleCookie.value,
      sesskey,
      siteUrl,
      capturedAt: Date.now(),
    };
    await saveSession(session);
    onStatus(`Sesión capturada para ${siteUrl}`);
    return session;
  } finally {
    await context.close();
  }
}

/** Comprueba si el host de trabajo es el esperado (defensa mínima). */
export function isExpectedHost(siteUrl: string): boolean {
  try {
    return new URL(siteUrl).host === HOST;
  } catch {
    return false;
  }
}
