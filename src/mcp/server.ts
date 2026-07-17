#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ensureSession, withSession, type AuthMode } from "../core/auth.js";
import { SessionExpiredError } from "../core/errors.js";
import { getSemester } from "../core/config.js";
import { isExpired, isValid, loadSession } from "../core/session.js";
import { getEnrolledCourses, getCourseContents } from "../domain/courses.js";
import { getAllTasks, getCourseTasks, getUpcomingTasks } from "../domain/tasks.js";
import { downloadFile, listCourseFiles, pullCourseFiles } from "../domain/resources.js";
import { convertLocalPdfToMarkdown, readResourceAsMarkdown } from "../domain/documents.js";

/**
 * En contexto MCP la renovación de sesión es "headless-only": si el SSO de Google sigue
 * vivo en el perfil persistente, renueva sola; si no, devuelve un error que le pide al
 * usuario correr `dutic login` en una terminal (donde sí puede abrirse el navegador).
 */
const MCP_MODE: AuthMode = "headless-only";

const server = new McpServer({ name: "dutic-mcp", version: "0.1.0" });

/** Envuelve un handler traduciendo SessionExpiredError a un mensaje accionable. */
async function tool<T>(fn: () => Promise<T>) {
  try {
    const data = await fn();
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: "Sesión de DUTIC caducada y no se pudo renovar automáticamente. Ejecuta `dutic login` en una terminal para reautenticarte con Google.",
          },
        ],
      };
    }
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
    };
  }
}

server.registerTool(
  "dutic_list_tasks",
  {
    title: "Listar tareas DUTIC",
    description:
      "Lista tus tareas del aula virtual. scope='upcoming' usa el calendario (rápido). " +
      "scope='all' barre TODOS los cursos para incluir tareas ocultas que no aparecen en el " +
      "calendario (marcadas con hidden=true) — útil para no perder entregas.",
    inputSchema: {
      scope: z.enum(["upcoming", "all"]).default("upcoming"),
      onlyHidden: z.boolean().default(false).describe("Con scope='all', devolver sólo las ocultas."),
      detailed: z
        .boolean()
        .default(true)
        .describe("Con scope='all', scrapear el estado de entrega y la nota de cada tarea."),
    },
  },
  async ({ scope, onlyHidden, detailed }) =>
    tool(async () => {
      if (scope === "all" || onlyHidden) {
        return withSession(async (s) => {
          const { tasks, scanErrors } = await getAllTasks(s, { enrich: detailed });
          return { tasks: onlyHidden ? tasks.filter((t) => t.hidden) : tasks, scanErrors };
        }, { mode: MCP_MODE });
      }
      return withSession((s) => getUpcomingTasks(s), { mode: MCP_MODE });
    }),
);

server.registerTool(
  "dutic_list_courses",
  {
    title: "Listar cursos DUTIC",
    description: "Lista los cursos en los que estás matriculado (id, nombre, docentes).",
    inputSchema: {},
  },
  async () => tool(() => withSession((s) => getEnrolledCourses(s), { mode: MCP_MODE })),
);

server.registerTool(
  "dutic_get_course_contents",
  {
    title: "Contenido de un curso",
    description: "Devuelve las secciones y módulos (tareas, recursos, foros...) de un curso.",
    inputSchema: { courseId: z.number().int().positive() },
  },
  async ({ courseId }) =>
    tool(() => withSession((s) => getCourseContents(s, courseId), { mode: MCP_MODE })),
);

server.registerTool(
  "dutic_get_course_tasks",
  {
    title: "Tareas de un curso",
    description: "Lista las tareas de un curso concreto, incluidas las ocultas (hidden=true).",
    inputSchema: { courseId: z.number().int().positive() },
  },
  async ({ courseId }) =>
    tool(() => withSession((s) => getCourseTasks(s, courseId), { mode: MCP_MODE })),
);

server.registerTool(
  "dutic_list_course_files",
  {
    title: "Recursos descargables de un curso",
    description: "Lista los archivos/recursos descargables de un curso (con su URL de descarga).",
    inputSchema: { courseId: z.number().int().positive() },
  },
  async ({ courseId }) =>
    tool(() => withSession((s) => listCourseFiles(s, courseId), { mode: MCP_MODE })),
);

server.registerTool(
  "dutic_download_file",
  {
    title: "Descargar un archivo",
    description:
      "Descarga un archivo del aula virtual a una ruta local. Acepta la URL de vista del " +
      "módulo o directamente una URL de pluginfile.php.",
    inputSchema: {
      url: z.string().url(),
      destPath: z.string().describe("Ruta local de destino."),
    },
  },
  async ({ url, destPath }) =>
    tool(() => withSession((s) => downloadFile(s, url, destPath), { mode: MCP_MODE })),
);

server.registerTool(
  "dutic_read_resource",
  {
    title: "Leer un recurso como texto/Markdown",
    description:
      "Descarga un recurso del aula (PDF, texto…) y devuelve su CONTENIDO como Markdown listo " +
      "para analizar, SIN gastar tokens en el binario. Convierte PDFs a texto automáticamente. " +
      "Úsalo cuando el usuario quiera que analices, resumas o extraigas algo de un material del " +
      "curso (sílabo, informe, guía, lectura). Para binarios no soportados (docx, imágenes) " +
      "avisa y sugiere descargar. Acepta la URL de vista del módulo o de pluginfile.php.",
    inputSchema: {
      url: z.string().url(),
      maxChars: z
        .number()
        .int()
        .positive()
        .default(24_000)
        .describe("Máximo de caracteres a devolver (trunca lo demás)."),
    },
  },
  async ({ url, maxChars }) =>
    tool(() => withSession((s) => readResourceAsMarkdown(s, url, maxChars), { mode: MCP_MODE })),
);

server.registerTool(
  "dutic_pull_course_files",
  {
    title: "Descargar todos los recursos de un curso",
    description:
      "Descarga en bloque todos los archivos/recursos de un curso a un directorio local. " +
      "Devuelve la lista de archivos guardados con su tamaño.",
    inputSchema: {
      courseId: z.number().int().positive(),
      destDir: z.string().describe("Directorio local de destino."),
    },
  },
  async ({ courseId, destDir }) =>
    tool(() => withSession((s) => pullCourseFiles(s, courseId, destDir), { mode: MCP_MODE })),
);

server.registerTool(
  "dutic_pdf_to_markdown",
  {
    title: "Convertir un PDF local a Markdown",
    description:
      "Convierte un PDF que ya está en disco a Markdown/texto para analizarlo sin gastar tokens " +
      "en el binario. Opcionalmente guarda el resultado en outPath. No requiere sesión de Moodle.",
    inputSchema: {
      filePath: z.string().describe("Ruta local del PDF."),
      outPath: z.string().optional().describe("Si se indica, guarda el Markdown aquí."),
      maxChars: z
        .number()
        .int()
        .nonnegative()
        .default(0)
        .describe("Máximo de caracteres a devolver (0 = sin límite)."),
    },
  },
  async ({ filePath, outPath, maxChars }) =>
    tool(() => convertLocalPdfToMarkdown(filePath, outPath, maxChars)),
);

server.registerTool(
  "dutic_session_status",
  {
    title: "Estado de sesión DUTIC",
    description: "Indica si hay una sesión válida, el semestre y cuándo caduca.",
    inputSchema: {},
  },
  async () =>
    tool(async () => {
      const s = await loadSession();
      return {
        semester: getSemester(),
        hasSession: s !== null,
        siteUrl: s?.siteUrl ?? null,
        valid: isValid(s),
        expired: s ? isExpired(s) : null,
        capturedAt: s ? new Date(s.capturedAt).toISOString() : null,
      };
    }),
);

server.registerTool(
  "dutic_refresh_session",
  {
    title: "Renovar sesión DUTIC",
    description:
      "Intenta renovar la sesión sin interacción (si el SSO de Google sigue vivo). Si falla, " +
      "hay que ejecutar `dutic login` en una terminal.",
    inputSchema: {},
  },
  async () =>
    tool(async () => {
      const s = await ensureSession({ mode: "headless-only" });
      return { ok: true, siteUrl: s.siteUrl, capturedAt: new Date(s.capturedAt).toISOString() };
    }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
