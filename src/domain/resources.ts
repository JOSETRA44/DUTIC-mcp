import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as cheerio from "cheerio";
import { CHROME_USER_AGENT } from "../core/config.js";
import { SessionExpiredError } from "../core/errors.js";
import { unsaAgent } from "../core/http.js";
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
  const res = await fetch(url, {
    headers: moodleHeaders(session),
    dispatcher: unsaAgent,
    redirect: "follow",
  });
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

  const res = await fetch(realUrl, {
    headers: moodleHeaders(session, url),
    dispatcher: unsaAgent,
    redirect: "follow",
  });
  if (res.status === 302 || res.status === 303) throw new SessionExpiredError();
  if (!res.ok || !res.body) {
    throw new Error(`No se pudo descargar (HTTP ${res.status}): ${realUrl}`);
  }

  const nodeStream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  const out = createWriteStream(destPath);
  await pipeline(nodeStream, out);

  const bytes = Number(res.headers.get("content-length")) || 0;
  return {
    path: destPath,
    bytes,
    contentType: res.headers.get("content-type"),
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
