import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as cheerio from "cheerio";
import { CHROME_USER_AGENT } from "../core/config.js";
import { SessionExpiredError } from "../core/errors.js";
import { fetchUnsa } from "../core/http.js";
import type { Session } from "../core/session.js";
import type { ResourceFile } from "../core/models.js";
import { getCourseContents } from "./courses.js";
import { mapLimit } from "./concurrency.js";

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

export interface CourseMaterial {
  filename: string;
  /** URL descargable (pluginfile.php) o de vista del módulo (resource) que se resuelve al bajar. */
  url: string;
  modname: string;
  section: string;
  /** Nombre de la carpeta contenedora, si el archivo está dentro de un mod/folder. */
  folder: string | null;
}

/**
 * Lista TODOS los archivos descargables de un curso, **expandiendo las carpetas** a sus archivos
 * reales (los recursos `resource` quedan como URL de módulo, que se resuelve al descargar). Las
 * carpetas vacías se omiten. Las carpetas se expanden en paralelo (acotado).
 */
export interface MaterialsOptions {
  concurrency?: number;
  /** Filtra por nombre de sección/unidad (subcadena, sin distinguir mayúsculas/acentos). */
  section?: string;
}

/** Normaliza para comparar secciones ignorando acentos y mayúsculas. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

export async function listCourseMaterials(
  session: Session,
  courseId: number,
  opts: MaterialsOptions = {},
): Promise<CourseMaterial[]> {
  const { concurrency = 8, section: sectionFilter } = opts;
  const sections = await getCourseContents(session, courseId);
  const filterNorm = sectionFilter ? norm(sectionFilter) : null;
  const out: CourseMaterial[] = [];
  const folderJobs: { section: string; name: string; url: string }[] = [];

  for (const section of sections) {
    if (filterNorm && !norm(section.name).includes(filterNorm)) continue;
    for (const m of section.modules) {
      if (!m.url) continue;
      if (m.modname === "resource") {
        out.push({
          filename: m.name,
          url: m.url,
          modname: "resource",
          section: section.name,
          folder: null,
        });
      } else if (m.modname === "folder") {
        folderJobs.push({ section: section.name, name: m.name, url: m.url });
      }
    }
  }

  const expanded = await mapLimit(folderJobs, concurrency, async (j) => {
    const files = await listFolderFiles(session, j.url).catch(() => [] as FolderFile[]);
    return files.map((f) => ({
      filename: f.filename,
      url: f.url,
      modname: "folder",
      section: j.section,
      folder: j.name,
    }));
  });
  for (const arr of expanded) out.push(...arr);
  return out;
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
 * Lista los archivos de una carpeta (mod/folder). Moodle renderiza el árbol de archivos
 * server-side dentro de `#folder_tree0` como enlaces `<a href="pluginfile.php/...">`, así que
 * basta HTTP + cheerio (rápido, sin navegador). Una carpeta vacía devuelve lista vacía.
 */
export async function listFolderFiles(
  session: Session,
  folderUrl: string,
): Promise<FolderFile[]> {
  const html = await getHtml(session, folderUrl);
  const $ = cheerio.load(html);
  const files: FolderFile[] = [];
  const seen = new Set<string>();
  $('#folder_tree0 a[href*="pluginfile.php"]').each((_, a) => {
    const href = $(a).attr("href");
    if (!href || seen.has(href)) return;
    seen.add(href);
    const text = $(a).text().trim();
    const filename = text || decodeURIComponent(new URL(href).pathname.split("/").pop() ?? "archivo");
    files.push({ filename, url: href });
  });
  return files;
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

const sanitize = (name: string) => name.replace(/[<>:"/\\|?*]+/g, "_").slice(0, 120);

/**
 * Descarga TODOS los materiales de un curso a un directorio destino, expandiendo carpetas y
 * organizando los archivos en subdirectorios por carpeta. Descarga en paralelo (acotado) y no
 * se detiene por un fallo puntual.
 */
export interface PullOptions extends MaterialsOptions {
  onProgress?: (done: number, total: number, name: string) => void;
}

export async function pullCourseFiles(
  session: Session,
  courseId: number,
  destDir: string,
  opts: PullOptions = {},
): Promise<DownloadResult[]> {
  const { concurrency = 6, onProgress } = opts;
  const materials = await listCourseMaterials(session, courseId, opts);
  let done = 0;
  const results = await mapLimit(materials, concurrency, async (f) => {
    const subDir = f.folder ? join(destDir, sanitize(f.folder)) : destDir;
    const dest = join(subDir, sanitize(f.filename));
    try {
      return await downloadFile(session, f.url, dest);
    } catch {
      return null;
    } finally {
      onProgress?.(++done, materials.length, f.filename);
    }
  });
  return results.filter((r): r is DownloadResult => r !== null);
}
