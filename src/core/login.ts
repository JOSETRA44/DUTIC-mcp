import { mkdir } from "node:fs/promises";
import {
  chromium,
  type BrowserContext,
  type Cookie,
  type Page,
} from "playwright";
import {
  BROWSER_PROFILE_DIR,
  CHROME_USER_AGENT,
  DATA_DIR,
  getLoginUrl,
  HOST,
} from "./config.js";
import { deriveSiteUrl, saveSession, type Session } from "./session.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** true si la URL (string) apunta al dashboard /my del aula virtual. */
function isDashboardUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    return u.host === HOST && /\/my\/?$/.test(u.pathname);
  } catch {
    return false;
  }
}

/** Normaliza un dominio de cookie (quita el punto inicial de dominios tipo ".host"). */
function cookieDomainMatchesHost(domain: string): boolean {
  return domain.replace(/^\./, "") === HOST;
}

/**
 * Elige la cookie MoodleSession correcta. Moodle pone una cookie de sesión de invitado
 * (path "/") ANTES del login y otra autenticada con scope "/{semestre}/" DESPUÉS. Se prefiere
 * la de path más específico que sea prefijo de la ruta del dashboard.
 */
function pickMoodleCookie(cookies: Cookie[], dashboardPath: string): Cookie | undefined {
  const candidates = cookies.filter(
    (c) =>
      c.name === "MoodleSession" &&
      cookieDomainMatchesHost(c.domain) &&
      c.value.length > 0 &&
      dashboardPath.startsWith((c.path || "/").replace(/\/$/, "") || "/"),
  );
  candidates.sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0));
  if (candidates.length > 0) return candidates[0];
  // Fallback: cualquier MoodleSession del host, por si el path no encaja.
  return cookies.find(
    (c) => c.name === "MoodleSession" && cookieDomainMatchesHost(c.domain) && c.value.length > 0,
  );
}

/**
 * Sondea todas las páginas del contexto (principal y popups de Google) hasta que alguna
 * aterriza de verdad en el dashboard /my — señal inequívoca de autenticación completada.
 * Tolerante a redirecciones intermedias, popups y a que el usuario tarde en elegir su correo.
 */
async function waitForDashboardPage(
  context: BrowserContext,
  deadline: number,
  onStatus: (msg: string) => void,
): Promise<Page> {
  while (Date.now() < deadline) {
    for (const pg of context.pages()) {
      if (isDashboardUrl(pg.url())) return pg;
    }
    // Aviso periódico de que seguimos esperando (cada ~20s).
    const remaining = Math.round((deadline - Date.now()) / 1000);
    if (remaining > 0 && remaining % 20 === 0) {
      onStatus(`Esperando a que completes el login… (${remaining}s restantes)`);
    }
    await sleep(1000);
  }
  throw new Error(
    "Tiempo agotado esperando el dashboard /my. ¿Completaste el login con tu correo UNSA? " +
      "Vuelve a ejecutar `dutic login` y termina el flujo de Google en la ventana.",
  );
}

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
  const { headless = false, timeoutMs = 300_000, onStatus = () => {} } = opts;
  await mkdir(DATA_DIR, { recursive: true });

  const loginUrl = getLoginUrl();
  onStatus(`Abriendo navegador → ${loginUrl}`);

  const context = await launchContext(headless);
  const deadline = Date.now() + timeoutMs;

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

    onStatus(
      headless
        ? "Renovando sesión en segundo plano…"
        : "En la ventana: pulsa «Ingresar con Correo UNSA» y elige tu cuenta de Google. " +
            "No cierres la ventana; se cerrará sola al terminar.",
    );

    // Esperar (tolerante) a que CUALQUIER página aterrice de verdad en el dashboard /my.
    // No cerramos ni extraemos nada hasta confirmar la autenticación real.
    const dashPage = await waitForDashboardPage(context, deadline, onStatus);
    onStatus("Login detectado. Capturando sesión…");

    const dashboardUrl = dashPage.url();
    const dashboardPath = new URL(dashboardUrl).pathname;
    const siteUrl = deriveSiteUrl(dashboardUrl, new URL(dashboardUrl).origin);

    // Asegurar que la página del dashboard está estable para leer el sesskey.
    try {
      await dashPage.waitForLoadState("domcontentloaded", { timeout: 15_000 });
    } catch {
      /* ya cargada o navegando; los reintentos de abajo lo cubren */
    }

    // Extraer sesskey con reintentos (RequireJS lo inyecta async).
    let sesskey = "";
    for (const delay of [0, 800, 1600, 2500, 4000, 6000]) {
      if (delay) await sleep(delay);
      try {
        sesskey = String((await dashPage.evaluate(SESSKEY_SNIPPET)) ?? "").trim();
      } catch {
        sesskey = "";
      }
      if (sesskey) break;
    }
    if (!sesskey) {
      throw new Error("No se pudo extraer el sesskey del dashboard de Moodle.");
    }

    // Cookie MoodleSession: leer TODAS las cookies del contexto y elegir la autenticada
    // (path "/{semestre}/"), evitando el filtro por path que dejaba fuera la cookie correcta.
    const allCookies = await context.cookies();
    const moodleCookie = pickMoodleCookie(allCookies, dashboardPath);
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
