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
  getBatchPersonProfiles,
  getCourseTeachers,
  getTeachersByCourse,
  getPersonProfile,
  getPersonProfileAuto,
  listCourseParticipants,
} from "../domain/people.js";
import { fetchAulaPage } from "../domain/fetch.js";
import { getMyProfile } from "../domain/people.js";
import { checkChanges } from "../domain/watch.js";
import { compareSisacadWithMoodle, loadSisacadGrades } from "../domain/sisacad.js";
import {
  CONFIRM_PHRASE,
  encuestaStatus,
  fillSurveys,
  listSurveys,
  previewSurveys,
} from "../domain/encuesta.js";
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
  async () =>
    tool(() =>
      withSession(async (s) => {
        // `contacts` del web service llega vacío en esta instalación; los docentes
        // reales salen del listado de participantes (rol "Profesor"). Sin esto, este
        // tool prometía "docentes" en su descripción y devolvía siempre una lista vacía.
        const courses = await getEnrolledCourses(s);
        const teachers = await getTeachersByCourse(
          s,
          courses.map((c) => c.id),
        ).catch(() => new Map<number, string[]>());
        return courses.map((c) => ({
          ...c,
          teachers: c.contacts.length ? c.contacts : (teachers.get(c.id) ?? []),
        }));
      }, { mode: MCP_MODE }),
    ),
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
      "Devuelve las notas parciales OFICIALES de SISACAD que el usuario capturó con `dutic sisacad` " +
      "(sistema aparte del aula, protegido con CAPTCHA; el usuario hace su propio login). Cada curso " +
      "trae sus ítems (parcial, nota 0-20, peso %, ausente) y el `weightedAverageSoFar` (promedio " +
      "ponderado con lo ya calificado). Sólo lee lo ya guardado — no abre navegador ni accede a datos " +
      "de terceros. Si no hay datos, indícale al usuario que ejecute `dutic sisacad` en una terminal.",
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
        courses: cap.courses,
      };
    }),
);

server.registerTool(
  "dutic_compare_grades",
  {
    title: "Comparar notas SISACAD vs. Moodle",
    description:
      "Compara el promedio ponderado de SISACAD (oficial) con el total que calcula Moodle, curso por " +
      "curso (usando el nombre normalizado, sin confundir 'II' con 'III'). Útil para detectar si el " +
      "aula virtual y el sistema oficial de notas están desincronizados. Requiere haber capturado " +
      "antes con `dutic sisacad`; si no hay datos, avisa al usuario.",
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
      return withSession(async (s) => {
        const moodleGrades = await getAllGrades(s);
        return {
          available: true,
          discrepancies: compareSisacadWithMoodle(
            cap.courses,
            moodleGrades.map((g) => ({ courseName: g.courseName, total: g.total })),
          ),
        };
      }, { mode: MCP_MODE });
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
      "Perfil de CUALQUIER usuario por su userId (sirve también para DOCENTES): nombre, correo, " +
      "ROL ('Estudiante'/'Profesor' — así confirmas si es docente), zona horaria y TODOS sus cursos " +
      "reales con course id y grupo. Sin `courseId`, prueba automáticamente tus propios cursos hasta " +
      "encontrar uno que la persona también curse/dicte — no hace falta que el usuario lo busque a " +
      "mano. Puede recibir un array de userIds (máx. 50) para resolver múltiples perfiles en lote.",
    inputSchema: {
      userId: z.union([
        z.number().int().positive(),
        z
          .array(z.number().int().positive())
          .min(1)
          .max(50)
          .describe("Array de userIds para resolver múltiples perfiles en lote."),
      ]),
      courseId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Curso de contexto ya conocido (si se omite, se busca automáticamente)."),
    },
  },
  async ({ userId, courseId }) =>
    tool(() =>
      withSession(async (s) => {
        if (Array.isArray(userId)) {
          return getBatchPersonProfiles(s, userId, { courseId });
        }
        return courseId
          ? getPersonProfile(s, userId, courseId)
          : getPersonProfileAuto(s, userId);
      }, { mode: MCP_MODE }),
    ),
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

// --- Encuesta de desempeño docente (sistema extranet, aparte del aula virtual) ---

server.registerTool(
  "dutic_encuesta_status",
  {
    title: "Estado de la encuesta docente",
    description:
      "Estado de la ENCUESTA DE DESEMPEÑO DOCENTE de la UNSA (sistema del extranet, distinto del " +
      "aula virtual y de SISACAD): si hay credenciales guardadas, cuántas encuestas quedan por " +
      "llenar, cuáles ya se enviaron desde aquí y qué política de respuestas hay configurada. " +
      "Empieza SIEMPRE por esta tool antes de listar o llenar nada. No envía nada.",
    inputSchema: {},
  },
  async () => tool(() => encuestaStatus()),
);

server.registerTool(
  "dutic_encuesta_list",
  {
    title: "Listar encuestas docentes",
    description:
      "Lista las encuestas de desempeño docente del usuario con su `key`, docente, curso, escuela " +
      "y estado (pendiente o ya llenada). La `key` es lo que se pasa a las demás tools. Sólo lee.",
    inputSchema: {},
  },
  async () => tool(() => listSurveys()),
);

server.registerTool(
  "dutic_encuesta_preview",
  {
    title: "Ver el cuestionario y simular las respuestas (no envía)",
    description:
      "Descarga el cuestionario de UNA encuesta y devuelve las 21 preguntas con su enunciado, las " +
      "4 alternativas de cada una, y qué se respondería con la política guardada más los " +
      "`answers` que le pases. NO ENVÍA NADA.\n\n" +
      "Úsala SIEMPRE antes de `dutic_encuesta_submit`: es la forma de leerle las preguntas al " +
      "usuario y acordar con él una evaluación real. Devuelve además el cuerpo exacto que se " +
      "enviaría y, por cada respuesta, la `rule` que la produjo, para poder explicar el porqué.",
    inputSchema: {
      key: z
        .string()
        .describe("Identificador de la encuesta, de dutic_encuesta_list (p.ej. '1937-8353-470')."),
      answers: z
        .record(z.union([z.string(), z.number()]))
        .optional()
        .describe(
          "Respuestas explícitas para esta simulación. Clave = id de pregunta ('120') o índice " +
            "('p1'). Valor = 'Nunca' | 'A veces' | 'Usualmente' | 'Siempre' (o 1-4). La pregunta " +
            "de calificación general acepta un entero 0-20. Lo que no indiques se completa con la " +
            "política guardada del usuario.",
        ),
      escala: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Respuesta para TODAS las preguntas de escala en esta simulación."),
      calificacion: z
        .number()
        .int()
        .min(0)
        .max(20)
        .optional()
        .describe("Calificación general 0-20 para esta simulación."),
    },
  },
  async ({ key, answers, escala, calificacion }) =>
    tool(() =>
      previewSurveys(
        { key },
        { answers: { byQuestion: answers, default: escala, score: calificacion } },
      ),
    ),
);

server.registerTool(
  "dutic_encuesta_submit",
  {
    title: "ENVIAR una encuesta docente (IRREVERSIBLE)",
    description:
      "Envía DEFINITIVAMENTE la encuesta de UN docente. Es IRREVERSIBLE y sólo se puede hacer una " +
      "vez por docente: el sistema no permite corregirla ni volver a verla.\n\n" +
      "Requisitos antes de llamarla: (1) haber usado `dutic_encuesta_preview` y haberle mostrado " +
      "al usuario las respuestas exactas; (2) que el usuario haya dicho explícitamente que la " +
      "envíes; (3) pasar confirm='ENVIAR'.\n\n" +
      "Este es el modo de EVALUACIÓN REAL: con `answers` mandas la valoración concreta que " +
      "acordaste con el usuario, pregunta por pregunta. Las respuestas deben reflejar lo que el " +
      "usuario opina — nunca las inventes tú. Si la encuesta ya estaba llenada, no se reenvía.",
    inputSchema: {
      key: z.string().describe("Identificador de la encuesta (de dutic_encuesta_list)."),
      answers: z
        .record(z.union([z.string(), z.number()]))
        .optional()
        .describe(
          "Igual que en preview. Recomendado: indicar TODAS las preguntas explícitamente para no " +
            "depender de la política guardada.",
        ),
      escala: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Respuesta para todas las preguntas de escala."),
      calificacion: z.number().int().min(0).max(20).optional().describe("Calificación general 0-20."),
      confirm: z
        .literal(CONFIRM_PHRASE)
        .describe("Literal 'ENVIAR'. Confirma que el usuario aprobó este envío irreversible."),
    },
  },
  async ({ key, answers, escala, calificacion, confirm }) =>
    tool(() =>
      fillSurveys(
        { key },
        {
          apply: true,
          confirm,
          answers: { byQuestion: answers, default: escala, score: calificacion },
        },
      ),
    ),
);

server.registerTool(
  "dutic_encuesta_fill_all",
  {
    title: "Llenar TODAS las encuestas pendientes con la política guardada",
    description:
      "Modo ZERO TOUCH: aplica la política de respuestas guardada del usuario a TODAS las " +
      "encuestas pendientes de una vez.\n\n" +
      "Por defecto sólo SIMULA (dryRun=true) y devuelve el plan completo — muéstraselo al " +
      "usuario. Para enviar de verdad hay que pasar dryRun=false Y confirm='ENVIAR', y eso es " +
      "IRREVERSIBLE para todos los docentes a la vez; no lo hagas sin que el usuario haya visto " +
      "antes el plan y lo haya aprobado.\n\n" +
      "Usa esta tool cuando el usuario diga 'llénalas todas' o 'ponles a todos X'. Si en cambio " +
      "quiere evaluar docente por docente, usa preview + submit.",
    inputSchema: {
      dryRun: z
        .boolean()
        .default(true)
        .describe("true (por defecto) = sólo simular. false = enviar de verdad."),
      confirm: z
        .string()
        .optional()
        .describe("Obligatorio y exactamente 'ENVIAR' cuando dryRun=false."),
      escala: z
        .union([z.string(), z.number()])
        .optional()
        .describe(
          "Respuesta para todas las preguntas de escala en esta tanda: " +
            "'Nunca'|'A veces'|'Usualmente'|'Siempre' o 1-4. Sobreescribe la política guardada.",
        ),
      calificacion: z
        .number()
        .int()
        .min(0)
        .max(20)
        .optional()
        .describe("Calificación general 0-20 para esta tanda."),
      docente: z
        .string()
        .optional()
        .describe("Limitar a los docentes o cursos cuyo nombre contenga este texto."),
      continuarSiFalla: z
        .boolean()
        .default(false)
        .describe("Si el servidor rechaza una, seguir con el resto en vez de detener el lote."),
    },
  },
  async ({ dryRun, confirm, escala, calificacion, docente, continuarSiFalla }) =>
    tool(() =>
      fillSurveys(docente ? { query: docente } : { all: true }, {
        apply: !dryRun,
        confirm,
        answers: { default: escala, score: calificacion },
        continueOnError: continuarSiFalla,
      }),
    ),
);

const transport = new StdioServerTransport();
await server.connect(transport);
