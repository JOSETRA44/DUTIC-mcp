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
import {
  downloadFile,
  listCourseFiles,
  listCourseMaterials,
  pullCourseFiles,
} from "../domain/resources.js";
import {
  convertLocalPdfToMarkdown,
  readResourceAsMarkdown,
  studyCourseMaterials,
} from "../domain/documents.js";
import {
  getAllGrades,
  getCourseGrades,
  type CourseGrades,
} from "../domain/grades.js";
import { getAssignDetail } from "../domain/assign.js";
import {
  findPeople,
  getCourseTeachers,
  getPersonProfile,
  listCourseParticipants,
} from "../domain/people.js";
import { fetchAulaPage } from "../domain/fetch.js";
import { getMyProfile } from "../domain/people.js";
import { checkChanges } from "../domain/watch.js";
import { loadSisacadGrades } from "../domain/sisacad.js";
import { setCacheRefresh } from "../core/cache.js";

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
  "dutic_check_changes",
  {
    title: "Novedades desde la última revisión",
    description:
      "Compara el estado académico actual con la última vez que se revisó y devuelve QUÉ cambió: " +
      "tareas nuevas (incl. ocultas), notas recién publicadas o modificadas, cambios de estado de " +
      "entrega y de fecha. Actualiza la línea base salvo que `save` sea false. Ideal para responder " +
      "'¿hay algo nuevo?' o para un chequeo periódico. Usa datos frescos (ignora la caché).",
    inputSchema: {
      save: z
        .boolean()
        .default(true)
        .describe("Actualizar la línea base con el estado actual (false = sólo comparar)."),
    },
  },
  async ({ save }) =>
    tool(() => {
      setCacheRefresh(true);
      return withSession((s) => checkChanges(s, { save }), { mode: MCP_MODE });
    }),
);

server.registerTool(
  "dutic_get_sisacad_grades",
  {
    title: "Notas de SISACAD (parciales oficiales)",
    description:
      "Devuelve las notas parciales de SISACAD que el usuario capturó con el comando `dutic sisacad` " +
      "(SISACAD es un sistema aparte con CAPTCHA; el usuario hace su propio login). Sólo lee lo ya " +
      "guardado — no abre navegador ni accede a datos de terceros. Si no hay datos, indícale al " +
      "usuario que ejecute `dutic sisacad` en una terminal.",
    inputSchema: {},
  },
  async () =>
    tool(async () => {
      const cap = await loadSisacadGrades();
      if (!cap) {
        return {
          available: false,
          message: "No hay notas de SISACAD guardadas. Ejecuta `dutic sisacad` en una terminal.",
        };
      }
      return {
        available: true,
        capturedAt: new Date(cap.capturedAt).toISOString(),
        header: cap.header,
        gradesTable: cap.gradesTable,
      };
    }),
);

server.registerTool(
  "dutic_whoami",
  {
    title: "Mi propio perfil",
    description: "Devuelve el perfil del propio usuario: nombre, correo institucional e id.",
    inputSchema: {},
  },
  async () => tool(() => withSession((s) => getMyProfile(s), { mode: MCP_MODE })),
);

server.registerTool(
  "dutic_get_assignment_detail",
  {
    title: "Detalle completo de una tarea",
    description:
      "Devuelve TODO lo de una tarea: la consigna/instrucciones completas, los archivos adjuntos " +
      "a la consigna (guías, rúbricas — puedes leerlos con dutic_read_resource), fechas oficiales " +
      "de apertura y cierre, estado de entrega, nota y quién calificó. IMPORTANTE: incluye " +
      "`dateConflict` y `datesInDescription` — los docentes a veces escriben en el texto una fecha " +
      "distinta a la configurada en Moodle; si dateConflict es true, AVISA al usuario de la " +
      "discrepancia. Úsalo cuando el usuario pregunte qué pide una tarea o cuándo se entrega.",
    inputSchema: {
      cmid: z.number().int().positive().describe("Course module id de la tarea."),
    },
  },
  async ({ cmid }) =>
    tool(() =>
      withSession(
        (s) => getAssignDetail(s, `${s.siteUrl}/mod/assign/view.php?id=${cmid}`),
        { mode: MCP_MODE },
      ),
    ),
);

server.registerTool(
  "dutic_list_participants",
  {
    title: "Participantes de un curso",
    description:
      "Lista TODOS los participantes de un curso recorriendo la paginación (nombre, rol, grupo, " +
      "último acceso y, con `withEmail`, su correo institucional). Si el curso usa grupos separados, " +
      "Moodle sólo muestra a los del grupo del usuario — es lo mismo que ve en la web. Úsalo para " +
      "saber quiénes son sus compañeros o de qué grupo es alguien.",
    inputSchema: {
      courseId: z.number().int().positive(),
      withEmail: z
        .boolean()
        .default(false)
        .describe("Resolver el correo de cada participante (abre su perfil; más lento)."),
    },
  },
  async ({ courseId, withEmail }) =>
    tool(() =>
      withSession((s) => listCourseParticipants(s, courseId, { withEmail }), { mode: MCP_MODE }),
    ),
);

server.registerTool(
  "dutic_find_person",
  {
    title: "Buscar una persona por nombre o correo",
    description:
      "Busca a una persona entre los participantes de TODOS los cursos del usuario, por nombre o " +
      "por correo. Abre su perfil y devuelve su correo, su acceso MÁS RECIENTE (`lastAccess` + " +
      "`lastSeenAgoSeconds`; se toma el más reciente entre todos los cursos, no el más antiguo) y " +
      "TODOS sus cursos reales (course id + grupo, GA = Grupo A). Cada curso trae `shared: true/false` " +
      "según si TÚ llevas exactamente ese curso (mismo course id — nunca confunde tu sección con la " +
      "suya) y, si lo compartes, su `lastAccess` a ese curso. `sharedCount` = cuántos comparten. " +
      "Úsalo para '¿quién es X?', '¿qué cursos lleva X?', '¿cuándo se conectó X?' o buscar por correo.",
    inputSchema: {
      query: z.string().min(2).describe("Nombre (o parte) o correo a buscar."),
    },
  },
  async ({ query }) =>
    tool(() => withSession((s) => findPeople(s, query), { mode: MCP_MODE })),
);

server.registerTool(
  "dutic_get_person_profile",
  {
    title: "Perfil de una persona (por id)",
    description:
      "Perfil de CUALQUIER usuario por su userId (sirve también para DOCENTES): correo, zona horaria " +
      "y TODOS sus cursos con course id y grupo. Para que Moodle revele sus cursos, pasa en `courseId` " +
      "un curso que compartas con esa persona (contexto). Combínalo con dutic_fetch_page para " +
      "descubrir userIds explorando URLs (user/view.php?id=N).",
    inputSchema: {
      userId: z.number().int().positive(),
      courseId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Curso de contexto (uno que compartas) para que se listen sus cursos."),
    },
  },
  async ({ userId, courseId }) =>
    tool(() => withSession((s) => getPersonProfile(s, userId, courseId), { mode: MCP_MODE })),
);

server.registerTool(
  "dutic_fetch_page",
  {
    title: "Explorar cualquier página del aula por URL",
    description:
      "Descarga CUALQUIER página del aula virtual con la sesión activa y devuelve su contenido. " +
      "Pensada para explorar Moodle 'jugando con las URLs' — cambiar ids, ver páginas a las que no " +
      "llegas por un botón: perfiles (user/view.php?id=N), cursos, foros, calificadores, etc. " +
      "`format`: 'text' (texto legible), 'html' (crudo, para inspeccionar), 'links' (sólo enlaces " +
      "internos, para descubrir a dónde navegar). Restringida al host del aula. Úsala cuando el " +
      "usuario quiera investigar algo que las otras herramientas no cubren, o para descubrir ids.",
    inputSchema: {
      url: z.string().describe("URL completa del aula o ruta (p. ej. 'user/view.php?id=3492&course=2271')."),
      format: z.enum(["text", "html", "links"]).default("text"),
      maxChars: z.number().int().positive().default(20_000),
    },
  },
  async ({ url, format, maxChars }) =>
    tool(() => withSession((s) => fetchAulaPage(s, url, format, maxChars), { mode: MCP_MODE })),
);

server.registerTool(
  "dutic_get_course_teachers",
  {
    title: "Docentes de un curso",
    description:
      "Identifica a los docentes del curso combinando los contactos del curso, los roles del " +
      "listado y —lo que suele funcionar en esta aula— el nombre de quien calificó las tareas. " +
      "Úsalo cuando el usuario pregunte quién es su profesor de un curso.",
    inputSchema: { courseId: z.number().int().positive() },
  },
  async ({ courseId }) =>
    tool(() => withSession((s) => getCourseTeachers(s, courseId), { mode: MCP_MODE })),
);

server.registerTool(
  "dutic_get_grades",
  {
    title: "Ver calificaciones",
    description:
      "Devuelve las calificaciones del usuario. Sin courseId: resumen de TODOS los cursos (nota " +
      "total + cuántos ítems quedan por calificar). Con courseId: detalle por ítem (nota, rango, " +
      "porcentaje, peso). Úsalo cuando el usuario pregunte por sus notas, promedio, o cómo va en un curso.",
    inputSchema: {
      courseId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Si se indica, detalle de ese curso; si no, resumen de todos."),
    },
  },
  async ({ courseId }) =>
    tool(() =>
      withSession<CourseGrades | CourseGrades[]>(
        (s) => (courseId ? getCourseGrades(s, courseId) : getAllGrades(s)),
        { mode: MCP_MODE },
      ),
    ),
);

server.registerTool(
  "dutic_list_course_materials",
  {
    title: "Listar materiales de un curso (carpetas expandidas)",
    description:
      "Lista TODOS los archivos descargables de un curso, expandiendo las carpetas a sus archivos " +
      "reales (diapositivas, lecturas, prácticas…). Devuelve nombre, URL, sección (unidad) y carpeta. " +
      "Úsalo para saber qué materiales hay, y por qué unidad, antes de leer o descargar. Con `section` " +
      "filtras a una unidad concreta.",
    inputSchema: {
      courseId: z.number().int().positive(),
      section: z
        .string()
        .optional()
        .describe("Filtra por nombre de unidad/sección (subcadena, ignora acentos)."),
    },
  },
  async ({ courseId, section }) =>
    tool(() => withSession((s) => listCourseMaterials(s, courseId, { section }), { mode: MCP_MODE })),
);

server.registerTool(
  "dutic_study_course",
  {
    title: "Preparar materiales de un curso para estudiar",
    description:
      "Descarga todos los materiales de un curso a un directorio y CONVIERTE los PDFs a Markdown " +
      "(.md) organizados por carpeta, para estudiar/analizar offline sin gastar tokens en binarios. " +
      "Devuelve el manifiesto de lo guardado. Úsalo cuando el usuario quiera 'preparar/bajar el " +
      "material para estudiar' de un curso. Con `section` bajas sólo esa unidad — útil para no " +
      "descargar todo de golpe cuando el usuario quiere estudiar una unidad concreta.",
    inputSchema: {
      courseId: z.number().int().positive(),
      destDir: z.string().describe("Directorio local de destino."),
      section: z
        .string()
        .optional()
        .describe("Sólo materiales de esta unidad/sección (subcadena)."),
    },
  },
  async ({ courseId, destDir, section }) =>
    tool(() => withSession((s) => studyCourseMaterials(s, courseId, destDir, { section }), { mode: MCP_MODE })),
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
      section: z
        .string()
        .optional()
        .describe("Sólo materiales de esta unidad/sección (subcadena)."),
    },
  },
  async ({ courseId, destDir, section }) =>
    tool(() => withSession((s) => pullCourseFiles(s, courseId, destDir, { section }), { mode: MCP_MODE })),
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
