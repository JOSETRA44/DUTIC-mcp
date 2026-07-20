import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import {
  fetchResourceBuffer,
  isFolderUrl,
  listCourseMaterials,
  listFolderFiles,
} from "./resources.js";
import { mapLimit } from "./concurrency.js";
import type { Session } from "../core/session.js";

export interface ConvertedDoc {
  markdown: string;
  pages: number;
  /** Caracteres del markdown completo (antes de truncar). */
  totalChars: number;
  truncated: boolean;
}

/**
 * Limpia el texto crudo de un PDF y lo aproxima a Markdown legible: normaliza espacios, une
 * líneas partidas por guion, separa párrafos y marca como encabezado (##) las líneas cortas
 * en mayúsculas (títulos de sección típicos de sílabos/informes). No pretende ser perfecto:
 * el objetivo es texto limpio y estructurado que un agente pueda leer y analizar barato.
 */
function textToMarkdown(text: string): string {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim());

  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }
    // Une palabra cortada con guion al final de línea.
    if (/[a-záéíóúñ]-$/i.test(line) && lines[i + 1]) {
      lines[i + 1] = line.slice(0, -1) + lines[i + 1];
      continue;
    }
    // Heurística de encabezado: línea corta, sin punto final, mayormente mayúsculas.
    const isHeading =
      line.length <= 80 &&
      !/[.:,;]$/.test(line) &&
      line === line.toUpperCase() &&
      /[A-ZÁÉÍÓÚÑ]/.test(line);
    out.push(isHeading ? `## ${line}` : line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Convierte un Buffer de PDF a Markdown. `maxChars` trunca el resultado (0 = sin límite). */
export async function pdfBufferToMarkdown(
  buffer: Buffer,
  maxChars = 0,
): Promise<ConvertedDoc> {
  // verbosity 0 (ERRORS) silencia los warnings de fuentes de pdf.js ("TT: undefined function")
  // que no afectan al texto extraído. Es seguro con conversiones concurrentes (sin tocar consola).
  const pdf = await getDocumentProxy(new Uint8Array(buffer), { verbosity: 0 });
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  const rawText: string = Array.isArray(text) ? (text as string[]).join("\n\n") : String(text);
  const full = textToMarkdown(rawText);
  const truncated = maxChars > 0 && full.length > maxChars;
  return {
    markdown: truncated ? full.slice(0, maxChars) + "\n\n…(truncado)" : full,
    pages: totalPages,
    totalChars: full.length,
    truncated,
  };
}

/** Detecta si un buffer es un PDF por su cabecera mágica (%PDF). */
export function looksLikePdf(buffer: Buffer, contentType?: string | null): boolean {
  if (contentType && /pdf/i.test(contentType)) return true;
  return buffer.length >= 5 && buffer.toString("latin1", 0, 5) === "%PDF-";
}

export interface ReadResourceResult {
  filename: string;
  contentType: string | null;
  kind: "pdf" | "text" | "binary";
  /** Contenido en Markdown/texto cuando es convertible; null para binarios no soportados. */
  markdown: string | null;
  pages?: number;
  totalChars?: number;
  truncated?: boolean;
  bytes: number;
  note?: string;
}

/**
 * Descarga un recurso del aula y devuelve su contenido como Markdown/texto listo para que el
 * agente lo analice — sin gastar tokens en el binario. Convierte PDFs con `unpdf`, devuelve tal
 * cual los recursos de texto, y para binarios no soportados (docx, xlsx, imágenes) informa el
 * tipo y sugiere descargar. Reutiliza la resolución de pluginfile.php de resources.ts.
 */
export async function readResourceAsMarkdown(
  session: Session,
  url: string,
  maxChars = 24_000,
): Promise<ReadResourceResult> {
  // Carpeta (mod/folder): puede tener varios archivos. Se listan (vía navegador headless) y se
  // concatena el contenido convertido de cada uno, con un encabezado por archivo.
  if (isFolderUrl(url)) {
    const files = await listFolderFiles(session, url);
    if (files.length === 0) {
      return {
        filename: "carpeta",
        contentType: null,
        kind: "binary",
        markdown: null,
        bytes: 0,
        note: "La carpeta está vacía (sin archivos subidos).",
      };
    }
    const parts: string[] = [];
    let used = 0;
    let bytes = 0;
    for (const f of files) {
      if (used >= maxChars) {
        parts.push(`\n\n…(quedan ${files.length} archivos sin mostrar; sube maxChars)`);
        break;
      }
      try {
        const sub = await readResourceAsMarkdown(session, f.url, maxChars - used);
        bytes += sub.bytes;
        if (sub.markdown) {
          const block = `\n\n# ${f.filename}\n\n${sub.markdown}`;
          parts.push(block);
          used += block.length;
        } else {
          parts.push(`\n\n# ${f.filename}\n\n(${sub.note})`);
        }
      } catch (e) {
        parts.push(`\n\n# ${f.filename}\n\n(error: ${(e as Error).message})`);
      }
    }
    return {
      filename: `carpeta (${files.length} archivo(s))`,
      contentType: "inode/directory",
      kind: "text",
      markdown: parts.join("").trim(),
      totalChars: used,
      truncated: used >= maxChars,
      bytes,
    };
  }

  const { buffer, contentType, filename } = await fetchResourceBuffer(session, url);
  const bytes = buffer.byteLength;

  if (looksLikePdf(buffer, contentType)) {
    const doc = await pdfBufferToMarkdown(buffer, maxChars);
    return {
      filename,
      contentType,
      kind: "pdf",
      markdown: doc.markdown,
      pages: doc.pages,
      totalChars: doc.totalChars,
      truncated: doc.truncated,
      bytes,
    };
  }

  const isText =
    (contentType && /^text\/|json|xml|csv|markdown/i.test(contentType)) ||
    /\.(txt|md|csv|json|xml|html?)$/i.test(filename);
  if (isText) {
    const text = buffer.toString("utf8");
    const truncated = text.length > maxChars;
    return {
      filename,
      contentType,
      kind: "text",
      markdown: truncated ? text.slice(0, maxChars) + "\n\n…(truncado)" : text,
      totalChars: text.length,
      truncated,
      bytes,
    };
  }

  return {
    filename,
    contentType,
    kind: "binary",
    markdown: null,
    bytes,
    note:
      `Tipo no convertible a texto (${contentType ?? "desconocido"}). ` +
      `Usa dutic_download_file para guardarlo y procesarlo con otra herramienta.`,
  };
}

export interface StudyMaterial {
  filename: string;
  folder: string | null;
  savedTo: string;
  kind: "markdown" | "file" | "error";
  chars?: number;
  error?: string;
}

const sanitize = (name: string) => name.replace(/[<>:"/\\|?*]+/g, "_").slice(0, 120);

/**
 * Descarga todos los materiales de un curso a `destDir` para estudiar offline: los PDFs se
 * CONVIERTEN a Markdown (.md) para poder leerlos/analizarlos sin gastar tokens en el binario;
 * el resto se guarda tal cual. Organiza por carpeta y devuelve un manifiesto de lo guardado.
 */
export interface StudyOptions {
  concurrency?: number;
  section?: string;
  onProgress?: (done: number, total: number, name: string) => void;
}

export async function studyCourseMaterials(
  session: Session,
  courseId: number,
  destDir: string,
  opts: StudyOptions = {},
): Promise<StudyMaterial[]> {
  const { concurrency = 5, section, onProgress } = opts;
  const materials = await listCourseMaterials(session, courseId, { section });
  let done = 0;
  return mapLimit(materials, concurrency, async (m): Promise<StudyMaterial> => {
    const sub = m.folder ? join(destDir, sanitize(m.folder)) : destDir;
    try {
      const { buffer, contentType } = await fetchResourceBuffer(session, m.url);
      await mkdir(sub, { recursive: true });
      if (looksLikePdf(buffer, contentType)) {
        const doc = await pdfBufferToMarkdown(buffer, 0);
        const out = join(sub, sanitize(m.filename).replace(/\.pdf$/i, "") + ".md");
        await writeFile(out, `# ${m.filename}\n\n${doc.markdown}`, "utf8");
        return {
          filename: m.filename,
          folder: m.folder,
          savedTo: out,
          kind: "markdown",
          chars: doc.totalChars,
        };
      }
      const out = join(sub, sanitize(m.filename));
      await writeFile(out, buffer);
      return { filename: m.filename, folder: m.folder, savedTo: out, kind: "file" };
    } catch (e) {
      return {
        filename: m.filename,
        folder: m.folder,
        savedTo: "",
        kind: "error",
        error: (e as Error).message,
      };
    } finally {
      onProgress?.(++done, materials.length, m.filename);
    }
  });
}

/** Convierte un PDF local a Markdown; opcionalmente lo guarda en outPath. */
export async function convertLocalPdfToMarkdown(
  inputPath: string,
  outPath?: string,
  maxChars = 0,
): Promise<ConvertedDoc & { savedTo?: string }> {
  const buffer = await readFile(inputPath);
  if (!looksLikePdf(buffer)) {
    throw new Error(`No parece un PDF: ${inputPath}`);
  }
  const doc = await pdfBufferToMarkdown(buffer, maxChars);
  if (outPath) {
    await writeFile(outPath, doc.markdown, "utf8");
    return { ...doc, savedTo: outPath };
  }
  return doc;
}
