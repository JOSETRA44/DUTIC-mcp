import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as cheerio from "cheerio";
import { CHROME_USER_AGENT } from "../core/config.js";
import { SessionExpiredError } from "../core/errors.js";
import { fetchUnsa } from "../core/http.js";
import { extractPluginfileLinks } from "../core/browser.js";
import type { Session } from "../core/session.js";
import type { ResourceFile } from "../core/models.js";
import { getCourseContents } from "./courses.js";

function moodleHeaders(session: Session, referer?: string): Record<string, string> {
  const h: Record<string, string> = {
    Cookie: `MoodleSession=${session.moodleSession}`,
    "User-Agent": CHROME_USER_AGENT,
  };
  if (referer) h.Referer = referer;
  return h;
}

async function getHtml(session: Session, url: string): Promise<string> {
  const res = await fetchUnsa(url, { headers: moodleHeaders(session) });
  if (res.status === 302 || res.status === 303) throw new SessionExpiredError();
  const text = await res.text();
  if (/login\/index\.php|loginform/i.test(text) && /\/login\//.test(res.url)) {
    throw new SessionExpiredError();
  }
  return text;
}

/**
 * Lista los archivos descargables de un curso. Recorre los módulos de tipo `resource`,
 * `folder` y `url`, quedándose con su URL de vista (la resolución al pluginfile.php real
 * se hace en el momento de descargar).
 */
export async function listCourseFiles(
  session: Session,
  courseId: number,
): Promise<ResourceFile[]> {
  const sections = await getCourseContents(session, courseId);
  const files: ResourceFile[] = [];
  for (const section of sections) {
    for (const m of section.modules) {
      if (!["resource", "folder", "url"].includes(m.modname)) continue;
      if (!m.url) continue;
      files.push({
        filename: m.name,
        fileurl: m.url,
        moduleName: m.name,
        modname: m.modname,
        mimetype: null,
        filesize: null,
      });
    }
  }
  return files;
}

/**
 * Resuelve la URL real de descarga (pluginfile.php) a partir de una URL de vista de módulo
 * (mod/resource/view.php...). Muchos recursos redirigen o incrustan el archivo; se parsea el
 * HTML buscando el enlace/objeto de pluginfile.
 */
async function resolvePluginFileUrl(session: Session, viewUrl: string): Promise<string> {
  if (/pluginfile\.php/.test(viewUrl)) return viewUrl;
  if (!/mod\/(resource|folder)\/view\.php/.test(viewUrl)) return viewUrl;

  const html = await getHtml(session, viewUrl);
  const $ = cheerio.load(html);
  const candidates = [
    $("object#resourceobject").attr("data"),
    $('object[data*="pluginfile"]').attr("data"),
    $(".resourceworkaround a[href]").attr("href"),
    $('a[href*="pluginfile"]').attr("href"),
    $('.resourcecontent a[href*="pluginfile"]').attr("href"),
  ];
  const found = candidates.find((c) => c && /pluginfile\.php/.test(c));
  return found ?? viewUrl;
}

export interface DownloadResult {
  path: string;
  bytes: number;
  contentType: string | null;
}

/**
 * Descarga un archivo a disco. Acepta tanto una URL de vista de módulo como una URL directa
 * de pluginfile.php; en el primer caso resuelve la URL real primero. Envía cookie, UA de
 * Chrome y Referer (Moodle exige coherencia de origen para servir pluginfile).
 */
export async function downloadFile(
  session: Session,
  url: string,
  destPath: string,
): Promise<DownloadResult> {
  const realUrl = await resolvePluginFileUrl(session, url);
  await mkdir(dirname(destPath), { recursive: true });

  // Descarga con timeout más amplio (archivos grandes).
  const res = await fetchUnsa(realUrl, { headers: moodleHeaders(session, url) }, 120_000);
  if (res.status === 302 || res.status === 303) throw new SessionExpiredError();
  if (!res.ok || !res.body) {
    throw new Error(`No se pudo descargar (HTTP ${res.status}): ${realUrl}`);
  }

  const nodeStream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  const out = createWriteStream(destPath);
  await pipeline(nodeStream, out);

  // El servidor a veces omite content-length (respuesta chunked); usar el tamaño real escrito.
  const declared = Number(res.headers.get("content-length")) || 0;
  const bytes = declared || (await stat(destPath)).size;
  return {
    path: destPath,
    bytes,
    contentType: res.headers.get("content-type"),
  };
}

export interface FolderFile {
  filename: string;
  url: string;
}

/** true si la URL es la vista de una carpeta (mod/folder). */
export function isFolderUrl(url: string): boolean {
  return /mod\/folder\/view\.php/.test(url);
}

/**
 * Lista los archivos de una carpeta (mod/folder). Su árbol se renderiza por JavaScript, así que
 * se usa un navegador headless para obtener los enlaces reales de pluginfile.php.
 */
export async function listFolderFiles(
  session: Session,
  folderUrl: string,
): Promise<FolderFile[]> {
  const links = await extractPluginfileLinks(session, folderUrl);
  const files = links
    .filter((u) => /mod_folder\/content/.test(u))
    .map((u) => {
      const path = new URL(u).pathname;
      const last = path.split("/").filter(Boolean).pop() ?? "archivo";
      return { filename: decodeURIComponent(last), url: u };
    });
  // Dedup por URL.
  const seen = new Set<string>();
  return files.filter((f) => (seen.has(f.url) ? false : (seen.add(f.url), true)));
}

export interface FetchedResource {
  buffer: Buffer;
  contentType: string | null;
  /** Nombre de archivo inferido de la URL o de Content-Disposition. */
  filename: string;
  /** URL real de pluginfile tras resolver la vista del módulo. */
  resolvedUrl: string;
}

/** Infiere un nombre de archivo desde Content-Disposition o el último segmento de la URL. */
function inferFilename(url: string, contentDisposition: string | null): string {
  if (contentDisposition) {
    const m = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(contentDisposition);
    if (m) return decodeURIComponent(m[1].replace(/"$/, ""));
  }
  try {
    const p = new URL(url).pathname;
    const last = p.split("/").filter(Boolean).pop() ?? "archivo";
    return decodeURIComponent(last);
  } catch {
    return "archivo";
  }
}

/**
 * Descarga un recurso a memoria (Buffer), resolviendo antes la URL real de pluginfile.php si
 * hace falta. Útil para procesar el contenido (p. ej. convertir un PDF a Markdown) sin escribir
 * a disco. Con `maxBytes` aborta descargas demasiado grandes.
 */
export async function fetchResourceBuffer(
  session: Session,
  url: string,
  maxBytes = 40 * 1024 * 1024,
): Promise<FetchedResource> {
  const resolvedUrl = await resolvePluginFileUrl(session, url);
  const res = await fetchUnsa(resolvedUrl, { headers: moodleHeaders(session, url) }, 120_000);
  if (res.status === 302 || res.status === 303) throw new SessionExpiredError();
  if (!res.ok) throw new Error(`No se pudo descargar (HTTP ${res.status}): ${resolvedUrl}`);

  const declared = Number(res.headers.get("content-length")) || 0;
  if (declared > maxBytes) {
    throw new Error(`Archivo demasiado grande (${declared} bytes > ${maxBytes}).`);
  }
  const arrayBuf = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);
  if (buffer.byteLength > maxBytes) {
    throw new Error(`Archivo demasiado grande (${buffer.byteLength} bytes > ${maxBytes}).`);
  }
  return {
    buffer,
    contentType: res.headers.get("content-type"),
    filename: inferFilename(resolvedUrl, res.headers.get("content-disposition")),
    resolvedUrl,
  };
}

/** Descarga todos los recursos de un curso a un directorio destino. */
export async function pullCourseFiles(
  session: Session,
  courseId: number,
  destDir: string,
): Promise<DownloadResult[]> {
  const files = await listCourseFiles(session, courseId);
  const results: DownloadResult[] = [];
  for (const f of files) {
    if (f.modname === "url") continue; // enlaces externos, no archivos
    const safeName = f.filename.replace(/[<>:"/\\|?*]+/g, "_").slice(0, 120);
    try {
      const r = await downloadFile(session, f.fileurl, join(destDir, safeName));
      results.push(r);
    } catch {
      // Continuar con el resto de archivos aunque uno falle.
    }
  }
  return results;
}
