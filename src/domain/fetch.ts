import * as cheerio from "cheerio";
import { CHROME_USER_AGENT, HOST } from "../core/config.js";
import { SessionExpiredError } from "../core/errors.js";
import { fetchUnsa, isUnsaUrl } from "../core/http.js";
import type { Session } from "../core/session.js";

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
  /** Contenido según `format`. */
  content: string;
  /** Enlaces internos del aula encontrados en la página (para explorar por URL). */
  links?: { text: string; href: string }[];
}

export type FetchFormat = "text" | "html" | "links";

/** Normaliza una URL/ruta relativa contra el sitio del aula. */
function resolveUrl(session: Session, urlOrPath: string): string {
  if (/^https?:\/\//i.test(urlOrPath)) return urlOrPath;
  const path = urlOrPath.startsWith("/") ? urlOrPath : `/${urlOrPath}`;
  // Si ya incluye el prefijo de semestre, respétalo; si no, cuélgalo del siteUrl.
  return /^\/\d{4}[A-Z]\//.test(path) ? `https://${HOST}${path}` : `${session.siteUrl}${path}`;
}

/**
 * Descarga CUALQUIER página del aula con la sesión activa y devuelve su contenido. Pensada para
 * explorar el Moodle "jugando con las URLs" (cambiar ids, ver páginas sin botón directo): perfiles
 * `user/view.php?id=N`, cursos, foros, etc. Restringida al host del aula por seguridad.
 *
 * `format`:
 *  - "text": texto legible de la zona principal (limpio, para leer/analizar).
 *  - "html": HTML crudo (para inspeccionar estructura).
 *  - "links": sólo los enlaces internos del aula (para descubrir a dónde navegar).
 */
export async function fetchAulaPage(
  session: Session,
  urlOrPath: string,
  format: FetchFormat = "text",
  maxChars = 20_000,
): Promise<FetchedPage> {
  const url = resolveUrl(session, urlOrPath);
  if (!isUnsaUrl(url)) {
    throw new Error(`Sólo se permiten URLs de ${HOST}. Recibido: ${url}`);
  }

  const res = await fetchUnsa(
    url,
    {
      headers: { Cookie: `MoodleSession=${session.moodleSession}`, "User-Agent": CHROME_USER_AGENT },
    },
    45_000,
  );
  if (res.status === 302 || res.status === 303) throw new SessionExpiredError();
  const html = await res.text();
  if (/\/login\//.test(res.url) && /loginform/i.test(html)) throw new SessionExpiredError();

  const $ = cheerio.load(html);
  const base: Omit<FetchedPage, "content" | "links"> = {
    url,
    finalUrl: res.url,
    status: res.status,
    contentType: res.headers.get("content-type"),
  };

  if (format === "html") {
    return { ...base, content: html.slice(0, maxChars) };
  }

  // Enlaces internos del aula (para explorar).
  const links: { text: string; href: string }[] = [];
  const seen = new Set<string>();
  $("#region-main a[href], .userprofile a[href]").each((_, a) => {
    const href = $(a).attr("href") ?? "";
    if (!href || !isUnsaUrl(href) || seen.has(href)) return;
    if (/logout|#/.test(href)) return;
    seen.add(href);
    links.push({ text: $(a).text().replace(/\s+/g, " ").trim().slice(0, 80), href });
  });

  if (format === "links") {
    return { ...base, content: `${links.length} enlaces`, links: links.slice(0, 200) };
  }

  // format "text": zona principal limpia.
  const main = $("#region-main").length ? $("#region-main") : $("body");
  main.find("script, style, nav, .navbar, footer").remove();
  const text = main.text().replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return { ...base, content: text.slice(0, maxChars), links: links.slice(0, 60) };
}
