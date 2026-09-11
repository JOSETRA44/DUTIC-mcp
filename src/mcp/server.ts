#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ensureSession, withSession, type AuthMode } from "../core/auth.js";
import { SessionExpiredError } from "../core/errors.js";
import { APP_VERSION } from "../core/version.js";
import {
  currentContext,
  resolveContext,
  runWithSemester,
  setDefaultContext,
} from "../core/context.js";
import { formatSemesterLabel } from "../core/semester.js";
import { discoverSemesters } from "../core/discovery.js";
import {
  currentSemesterSummary,
  listSemesterStates,
  switchSemester,
} from "../domain/semesters.js";
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
  getAulaSchedule,
  getCourseCatalog,
  getHorario,
  getSubjectSchedule,
} from "../domain/horario.js";
import { resolveSisacadLogin } from "../core/horarioStore.js";
import {
  CONFIRM_PHRASE,
  encuestaStatus,
  fillSurveys,
  listSurveys,
  previewSurveys,
} from "../domain/encuesta.js";
import { setCacheRefresh } from "../core/cache.js";
import {
  categoryPath,
  findCategories,
  getCategoryTree,
  groupByTeacher,
  listSchoolCourses,
} from "../domain/catalog.js";
import {
  addDashboardBlock,
  getDashboardState,
  listAddableBlocks,
  removeDashboardBlock,
} from "../domain/dashboard.js";
import { getOnlinePresence, matchOnline } from "../domain/presence.js";

/**
 * En contexto MCP la renovación de sesión es "headless-only": si el SSO de Google sigue
 * vivo en el perfil persistente, renueva sola; si no, devuelve un error que le pide al
 * usuario correr `dutic login` en una terminal (donde sí puede abrirse el navegador).
 */
const MCP_MODE: AuthMode = "headless-only";

const server = new McpServer({ name: "dutic-mcp", version: APP_VERSION });

/**
 * Parámetro común a todas las herramientas que leen el aula virtual. Cada semestre es un Moodle
 * distinto, así que "¿qué tareas tengo?" sólo está bien planteada dentro de un período.
 */
const SEMESTER_PARAM = {
  semester: z
    .string()
    .optional()
    .describe(
      "Semestre sobre el que consultar (p.ej. '2025A', '2026B'). " +
        "Si se omite, se usa el semestre activo. Usa dutic_semester_list para ver cuáles hay.",
    ),
};

type ToolResult = Awaited<ReturnType<typeof tool>>;

/**
 * Telemetría (`telemetry/index.ts`). Cada herramienta se mide como un span `tool.call`: nombre,
 * duración y, si falló, la clase del error. NUNCA sus argumentos ni su resultado, que llevan
 * datos académicos del usuario.
 */
const telemetry = await import("../telemetry/index.js");
telemetry.initTelemetry({ surface: "mcp" });

/**
 * Registra una herramienta con alcance de semestre: le añade el parámetro `semester` al esquema
 * y ejecuta el handler dentro de ese contexto.
 *
 * Se hace en UN solo sitio, y no repitiendo el parámetro en cada herramienta, por dos razones:
 * ninguna tool nueva puede olvidarse de soportarlo, y el aislamiento queda garantizado por
 * construcción — `runWithSemester` usa AsyncLocalStorage, así que dos llamadas concurrentes con
 * semestres distintos no comparten estado, cosa que una variable global sí les dejaría hacer.
 *
 * El span va DENTRO de `runWithSemester`: el evento sale con el semestre de ESTA llamada, no con
 * el activo del servidor.
 */
function registerScoped<S extends z.ZodRawShape>(
  name: string,
  config: { title: string; description: string; inputSchema: S },
  handler: (args: z.objectOutputType<S, z.ZodTypeAny> & { semester?: string }) => Promise<ToolResult>,
): void {
  const inputSchema = { ...config.inputSchema, ...SEMESTER_PARAM };
  server.registerTool(name, { ...config, inputSchema } as never, ((args: Record<string, unknown>) =>
    runWithSemester(resolveContext((args?.semester as string | undefined) ?? null), () =>
      telemetry.span("tool.call", name, () => handler(args as never)),
    )) as never);
}

/** Registra una herramienta SIN alcance de semestre, con la misma instrumentación. */
function registerTool<S extends z.ZodRawShape>(
  name: string,
  config: { title: string; description: string; inputSchema: S },
  handler: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<ToolResult>,
): void {
  server.registerTool(name, config as never, ((args: Record<string, unknown>) =>
    telemetry.span("tool.call", name, () => handler(args as never))) as never);
}

/** Envuelve un handler traduciendo SessionExpiredError a un mensaje accionable. */
async function tool<T>(fn: () => Promise<T>) {
  try {
    const data = await fn();
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  } catch (err) {
    // El error se convierte en un resultado `isError` y no se relanza: se anota en el span para
    // que la telemetría no lo registre como un éxito.
    telemetry.noteError(err);
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

registerScoped(
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

registerScoped(
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

registerScoped(
  "dutic_get_course_contents",
  {
    title: "Contenido de un curso",
    description: "Devuelve las secciones y módulos (tareas, recursos, foros...) de un curso.",
    inputSchema: { courseId: z.number().int().positive() },
  },
  async ({ courseId }) =>
    tool(() => withSession((s) => getCourseContents(s, courseId), { mode: MCP_MODE })),
);

registerScoped(
  "dutic_get_course_tasks",
  {
    title: "Tareas de un curso",
    description: "Lista las tareas de un curso concreto, incluidas las ocultas (hidden=true).",
    inputSchema: { courseId: z.number().int().positive() },
  },
  async ({ courseId }) =>
    tool(() => withSession((s) => getCourseTasks(s, courseId), { mode: MCP_MODE })),
);

registerScoped(
  "dutic_list_course_files",
  {
    title: "Recursos descargables de un curso",
    description: "Lista los archivos/recursos descargables de un curso (con su URL de descarga).",
    inputSchema: { courseId: z.number().int().positive() },
  },
  async ({ courseId }) =>
    tool(() => withSession((s) => listCourseFiles(s, courseId), { mode: MCP_MODE })),
);

registerScoped(
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

registerScoped(
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

registerScoped(
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

registerScoped(
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

registerScoped(
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

registerScoped(
  "dutic_get_horario",
  {
    title: "Horario de clases (sistema de matrícula)",
    description:
      "Devuelve el horario de clases de un alumno del sistema de matrícula de la UNSA " +
      "(extranet, distinto del aula virtual y de SISACAD de notas). Sin `cui` usa el del propio " +
      "usuario; con `cui` el de ese alumno (de la misma escuela por defecto). Cada bloque trae " +
      "día, hora de inicio/fin, asignatura y aula. Requiere credenciales guardadas con " +
      "`dutic hrs login` en una terminal; si no las hay, avisa en vez de fallar.",
    inputSchema: {
      cui: z
        .string()
        .optional()
        .describe("CUI del alumno (por defecto, el del usuario logueado)."),
      depe: z
        .string()
        .optional()
        .describe("Código de dependencia/escuela (por defecto, la del login, p.ej. 470 = ECONOMÍA)."),
      escuela: z
        .string()
        .optional()
        .describe("Otra Escuela/Programa por nombre (BIOLOGÍA) o código (4020); su depe se deriva solo."),
    },
  },
  async ({ cui, depe, escuela }) =>
    tool(async () => {
      const creds = await resolveSisacadLogin();
      if (!creds) {
        return {
          available: false,
          message: "No hay credenciales del sistema de matrícula. Ejecuta `dutic hrs login` en una terminal.",
        };
      }
      const horario = await getHorario({ cui, depe, escuela });
      return { available: true, ...horario };
    }),
);

registerScoped(
  "dutic_get_course_catalog",
  {
    title: "Oferta de asignaturas del ciclo (matrícula)",
    description:
      "Lista la oferta de asignaturas del ciclo vigente de una Escuela/Programa del sistema de " +
      "matrícula de la UNSA: todas las secciones de cada asignatura, agrupadas por año. " +
      "Sirve para ver qué se dicta en otras carreras (p.ej. BIOLOGÍA). Con `codigo` en " +
      "`dutic_get_subject_schedule` se obtiene el horario semanal de una asignatura-sección.",
    inputSchema: {
      depe: z
        .string()
        .optional()
        .describe("Código de dependencia/escuela (por defecto, la del login, p.ej. 470 = ECONOMÍA)."),
      escuela: z
        .string()
        .optional()
        .describe("Otra Escuela/Programa por nombre (BIOLOGÍA) o código (4020); su depe se deriva solo."),
    },
  },
  async ({ depe, escuela }) =>
    tool(async () => {
      const creds = await resolveSisacadLogin();
      if (!creds) {
        return {
          available: false,
          message: "No hay credenciales del sistema de matrícula. Ejecuta `dutic hrs login` en una terminal.",
        };
      }
      return { available: true, ...(await getCourseCatalog({ depe, escuela })) };
    }),
);

registerScoped(
  "dutic_get_subject_schedule",
  {
    title: "Horario de una asignatura-sección (matrícula)",
    description:
      "Horario semanal (días, horas y aulas) de una asignatura-sección del sistema de matrícula, " +
      "p.ej. '2501209A'. El código pelado ('2501209') se resuelve contra la oferta: si la " +
      "asignatura tiene varias secciones hay que pasar el código completo. Requiere credenciales " +
      "guardadas con `dutic hrs login`.",
    inputSchema: {
      codigo: z
        .string()
        .describe("Código de asignatura: '2501209A' (con sección) o '2501209' (se resuelve)."),
      depe: z
        .string()
        .optional()
        .describe("Código de dependencia/escuela (por defecto, la del login)."),
      escuela: z
        .string()
        .optional()
        .describe("Otra Escuela/Programa por nombre (BIOLOGÍA) o código (4020)."),
    },
  },
  async ({ codigo, depe, escuela }) =>
    tool(async () => {
      const creds = await resolveSisacadLogin();
      if (!creds) {
        return {
          available: false,
          message: "No hay credenciales del sistema de matrícula. Ejecuta `dutic hrs login` en una terminal.",
        };
      }
      return { available: true, ...(await getSubjectSchedule(codigo, { depe, escuela })) };
    }),
);

registerScoped(
  "dutic_get_aula_schedule",
  {
    title: "Horario de un aula (matrícula)",
    description:
      "Qué asignaturas (y secciones) se dictan en un aula del sistema de matrícula y cuándo. " +
      "Acepta un código interno ('15446') o parte del nombre ('105', 'MTA_A'), sin distinguir " +
      "acentos; si el texto coincide con varias aulas avisa para ser más específico.",
    inputSchema: {
      aula: z
        .string()
        .describe("Aula: código interno o parte del nombre (p.ej. '105', 'MTA_A')."),
      depe: z
        .string()
        .optional()
        .describe("Código de dependencia/escuela (por defecto, la del login)."),
      escuela: z
        .string()
        .optional()
        .describe("Otra Escuela/Programa por nombre (BIOLOGÍA) o código (4020)."),
    },
  },
  async ({ aula, depe, escuela }) =>
    tool(async () => {
      const creds = await resolveSisacadLogin();
      if (!creds) {
        return {
          available: false,
          message: "No hay credenciales del sistema de matrícula. Ejecuta `dutic hrs login` en una terminal.",
        };
      }
      return { available: true, ...(await getAulaSchedule(aula, { depe, escuela })) };
    }),
);

registerScoped(
  "dutic_whoami",
  {
    title: "Mi propio perfil",
    description: "Devuelve el perfil del propio usuario: nombre, correo institucional e id.",
    inputSchema: {},
  },
  async () => tool(() => withSession((s) => getMyProfile(s), { mode: MCP_MODE })),
);

registerScoped(
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

registerScoped(
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

registerScoped(
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

registerScoped(
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

registerScoped(
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

registerScoped(
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

registerScoped(
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

registerScoped(
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

registerScoped(
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

registerScoped(
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

registerTool(
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

registerScoped(
  "dutic_session_status",
  {
    title: "Estado de sesión DUTIC",
    description:
      "Indica si hay una sesión válida para el semestre indicado (o el activo), y de dónde " +
      "salió ese semestre.",
    inputSchema: {},
  },
  async () =>
    tool(async () => {
      const ctx = currentContext();
      const s = await loadSession();
      return {
        semester: ctx.id,
        semesterLabel: formatSemesterLabel(ctx.id),
        semesterSource: ctx.source,
        hasSession: s !== null,
        siteUrl: s?.siteUrl ?? null,
        valid: isValid(s),
        expired: s ? isExpired(s) : null,
        capturedAt: s ? new Date(s.capturedAt).toISOString() : null,
      };
    }),
);

// --- Gestión de semestres ---

registerTool(
  "dutic_semester_list",
  {
    title: "Listar semestres DUTIC",
    description:
      "Lista los períodos académicos conocidos: cuál está activo, cuáles tienen sesión iniciada " +
      "y cuántos cursos hay guardados de cada uno. Úsala antes de consultar datos de un ciclo " +
      "anterior, para saber qué identificador pasar en el parámetro `semester`.",
    inputSchema: {},
  },
  async () =>
    tool(async () => ({
      active: currentContext().id,
      semesters: await listSemesterStates(),
    })),
);

registerTool(
  "dutic_semester_current",
  {
    title: "Semestre actual DUTIC",
    description:
      "Devuelve el semestre sobre el que se está trabajando, su URL y de dónde salió esa " +
      "elección (opción explícita, entorno, activo guardado, sesión existente o la fecha).",
    inputSchema: {},
  },
  async () => tool(() => currentSemesterSummary()),
);

registerTool(
  "dutic_semester_use",
  {
    title: "Cambiar de semestre DUTIC",
    description:
      "Cambia el semestre ACTIVO de forma persistente: a partir de aquí, las herramientas que no " +
      "reciban un `semester` explícito consultarán ese período. Para una consulta puntual es " +
      "mejor pasar `semester` en la propia herramienta que cambiar el activo. " +
      "No inicia sesión: si el período no la tiene, se indica en `hasSession` y el usuario " +
      "debe ejecutar `dutic login` en una terminal.",
    inputSchema: {
      semester: z.string().describe("Semestre al que cambiar, p.ej. '2025A' o '2026-B'."),
    },
  },
  async ({ semester }) =>
    tool(async () => {
      const result = await switchSemester(semester);
      return {
        ...result,
        hint: result.hasSession
          ? null
          : `No hay sesión guardada para ${result.current}. Ejecuta \`dutic login\` en una terminal.`,
      };
    }),
);

registerTool(
  "dutic_semester_discover",
  {
    title: "Descubrir semestres DUTIC",
    description:
      "Sondea el aula virtual para averiguar qué períodos existen realmente y los registra. " +
      "Útil al empezar un ciclo nuevo o para localizar uno antiguo cuyo identificador no se " +
      "recuerda. Hace unas pocas peticiones de sólo lectura a la página de login de cada período.",
    inputSchema: {
      from: z.string().optional().describe("Inicio del rango a sondear (por defecto, dos períodos atrás)."),
      to: z.string().optional().describe("Fin del rango a sondear (por defecto, el período siguiente)."),
    },
  },
  async ({ from, to }) =>
    tool(async () => {
      const results = await discoverSemesters({ from, to });
      return {
        found: results.filter((r) => r.exists).map((r) => r.id),
        probed: results,
      };
    }),
);

registerScoped(
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

registerTool(
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

registerTool(
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

registerTool(
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

registerTool(
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

registerTool(
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

/**
 * Contexto por defecto del proceso. Se resuelve UNA vez al arrancar —migrando de paso el layout
 * plano anterior— para que el primer `resolveContext` no ocurra a mitad de una llamada. Cada
 * herramienta puede seguir apuntando a otro período con su parámetro `semester`; esto sólo fija
 * el que se usa cuando no se indica ninguno.
 *
 * Se registra en stderr, no en stdout: stdout es el canal del protocolo MCP.
 */
registerScoped(
  "dutic_online_users",
  {
    title: "Quién está conectado ahora mismo",
    description:
      "Presencia en vivo del aula, leída del bloque 'Usuarios en línea' del Dashboard: cuánta " +
      "gente hay conectada en los últimos minutos y, de ella, QUIÉNES son los que compartes " +
      "curso contigo, con la antigüedad de su última señal en segundos. Con `person` responde " +
      "'¿está conectado X?' buscando por nombre (sin acentos, palabras en cualquier orden) o id. " +
      "IMPORTANTE al redactar la respuesta: `total` es el recuento global del sitio y `users` " +
      "sólo la parte que el servidor te deja identificar — no son la misma cifra, y que alguien " +
      "no aparezca en `users` NO significa que esté desconectado: puede estar entre los " +
      "`hiddenCount` anónimos. El dato caduca en segundos, así que no lo reutilices de una " +
      "respuesta anterior; vuelve a llamar.",
    inputSchema: {
      person: z
        .string()
        .optional()
        .describe("Nombre (o parte) o id de usuario para comprobar si esa persona está conectada."),
    },
  },
  async ({ person }) =>
    tool(async () => {
      const presence = await withSession((s) => getOnlinePresence(s), { mode: MCP_MODE });
      if (!presence.blockPresent) {
        return {
          ...presence,
          message:
            "El Dashboard de este usuario no tiene el bloque 'Usuarios en línea'. " +
            "Añádelo con dutic_dashboard_add_block({ block: 'online_users' }) y vuelve a consultar.",
        };
      }
      if (!person) return presence;
      const matches = matchOnline(presence, person);
      return {
        query: person,
        online: matches.length > 0,
        matches,
        total: presence.total,
        hiddenCount: presence.hiddenCount,
        windowMinutes: presence.windowMinutes,
        note:
          matches.length === 0
            ? "No aparece entre los usuarios identificables. Puede estar conectado y ser uno de " +
              "los anónimos (hiddenCount), o no compartir ningún curso contigo."
            : undefined,
      };
    }),
);

registerScoped(
  "dutic_list_schools",
  {
    title: "Escuelas y áreas del aula",
    description:
      "Árbol de categorías del semestre: las tres áreas (BIOMÉDICAS, INGENIERÍAS, SOCIALES) y las " +
      "~46 Escuelas Profesionales que cuelgan de ellas, con su id de categoría. Úsalo ANTES de " +
      "dutic_school_courses para resolver el nombre que dijo el usuario ('sistemas', 'derecho') " +
      "al id correcto. Los ids son distintos en cada semestre: no los memorices entre períodos.",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe("Filtra por nombre (sin acentos, por trozo) o id. Si se omite, devuelve todo."),
    },
  },
  async ({ query }) =>
    tool(async () => {
      const tree = await withSession((s) => getCategoryTree(s), { mode: MCP_MODE });
      const schools = query ? findCategories(tree, query) : tree.categories;
      return {
        total: tree.categories.length,
        matched: schools.length,
        categories: schools.map((cat) => ({
          id: cat.id,
          name: cat.name,
          depth: cat.depth,
          kind: cat.depth === 3 ? "escuela" : cat.depth === 2 ? "área" : "período",
          path: categoryPath(tree, cat.id),
        })),
      };
    }),
);

registerScoped(
  "dutic_school_courses",
  {
    title: "Cursos de una Escuela, con su docente",
    description:
      "Todos los cursos que una Escuela Profesional dicta este semestre —de cualquier carrera, sin " +
      "estar matriculado en ella— con la asignatura, el grupo (GA, GB…) y QUIÉN LO ENSEÑA. " +
      "Responde a '¿qué cursos lleva la escuela de X?', '¿quién dicta Y en Z?' y, con " +
      "`byTeacher`, '¿qué dicta el profesor W?'. Acepta el nombre de la Escuela o su id " +
      "(dutic_list_schools). Cuesta dos peticiones, así que es barato incluso para Escuelas " +
      "grandes; `deep` sólo si quedaron cursos sin docente y de verdad hacen falta.",
    inputSchema: {
      school: z.string().describe("Nombre de la Escuela ('sistemas', 'ECONOMÍA') o su id de categoría."),
      byTeacher: z
        .boolean()
        .optional()
        .describe("Agrupar por docente en vez de por curso (para '¿qué dicta el profesor X?')."),
      deep: z
        .boolean()
        .optional()
        .describe("Abrir la ficha de los cursos sin docente, uno a uno. Lento: úsalo sólo si hace falta."),
    },
  },
  async ({ school, byTeacher, deep }) =>
    tool(() =>
      withSession(
        async (s) => {
          const tree = await getCategoryTree(s);
          const hits = findCategories(tree, school);
          if (hits.length === 0) {
            return {
              found: false,
              message: `Ninguna categoría coincide con "${school}". Usa dutic_list_schools para ver los nombres exactos.`,
            };
          }
          const target = hits[0];
          const courses = await listSchoolCourses(s, target.id, { deep });
          return byTeacher
            ? { found: true, category: courses.categoryName, path: courses.path, teachers: groupByTeacher(courses) }
            : { found: true, ...courses };
        },
        { mode: MCP_MODE },
      ),
    ),
);

registerScoped(
  "dutic_dashboard_blocks",
  {
    title: "Bloques del Dashboard del aula",
    description:
      "Qué bloques tiene puestos el usuario en su Dashboard (/my/) y, con `available`, cuáles " +
      "puede añadir. Importa porque el Dashboard se renderiza en el servidor: un bloque que no " +
      "está puesto es información que NO llega — 'Usuarios en línea' (online_users) es el caso " +
      "típico, y 'Estado de Finalización' (completion_progress) o 'Próximos eventos' " +
      "(calendar_upcoming) añaden datos que hoy no se ven.",
    inputSchema: {
      available: z
        .boolean()
        .optional()
        .describe("Incluir el catálogo de bloques añadibles. Cuesta un par de peticiones más."),
    },
  },
  async ({ available }) =>
    tool(() =>
      withSession(
        async (s) => {
          const state = await getDashboardState(s);
          return {
            editing: state.editing,
            blocks: state.blocks,
            addable: available ? await listAddableBlocks(s) : undefined,
          };
        },
        { mode: MCP_MODE },
      ),
    ),
);

registerScoped(
  "dutic_dashboard_add_block",
  {
    title: "Añadir un bloque al Dashboard",
    description:
      "Añade un bloque al Dashboard del usuario. MODIFICA la cuenta del usuario en el aula (su " +
      "Dashboard cambiará también cuando entre desde el navegador), así que pídele permiso antes " +
      "salvo que te lo haya pedido él. Es idempotente y reversible con " +
      "dutic_dashboard_remove_block. El uso previsto es habilitar 'online_users' cuando " +
      "dutic_online_users avisa de que falta.",
    inputSchema: {
      block: z
        .string()
        .describe("Nombre del plugin: 'online_users', 'completion_progress', 'calendar_upcoming'…"),
    },
  },
  async ({ block }) =>
    tool(() => withSession((s) => addDashboardBlock(s, block), { mode: MCP_MODE })),
);

registerScoped(
  "dutic_dashboard_remove_block",
  {
    title: "Quitar un bloque del Dashboard",
    description:
      "Quita un bloque del Dashboard del usuario. MODIFICA su cuenta en el aula: pide permiso " +
      "antes salvo que te lo haya pedido él. Se identifica por nombre de plugin, no por instancia.",
    inputSchema: { block: z.string().describe("Nombre del plugin a quitar, p.ej. 'online_users'.") },
  },
  async ({ block }) =>
    tool(() => withSession((s) => removeDashboardBlock(s, block), { mode: MCP_MODE })),
);

const bootCtx = resolveContext();
setDefaultContext(bootCtx);
process.stderr.write(
  `dutic-mcp · semestre ${bootCtx.id} (${bootCtx.source}) · ${bootCtx.siteUrl}
`,
);

// Qué agente usa este servidor (Claude Code, OpenCode, Antigravity…): lo declara el cliente en
// `initialize`. Permite ver si una herramienta falla sólo en ciertos entornos.
server.server.oninitialized = () => {
  const client = server.server.getClientVersion();
  telemetry.setMcpClient(client?.name, client?.version);
};

// Envío periódico que no mantiene vivo el proceso. El servidor dura lo que la sesión del agente;
// al cerrarse intenta un último envío corto, y lo que no alcance sale en la próxima ejecución.
const flushTimer = setInterval(() => void telemetry.flush({ budgetMs: 5000 }), 60_000);
flushTimer.unref();
const flushAndExit = () => {
  clearInterval(flushTimer);
  void telemetry.flush({ budgetMs: 1500 }).finally(() => process.exit(0));
};
process.stdin.once("end", flushAndExit);
process.once("SIGTERM", flushAndExit);
process.once("SIGINT", flushAndExit);

const transport = new StdioServerTransport();
await server.connect(transport);
