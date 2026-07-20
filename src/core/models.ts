import { z } from "zod";

/** Un curso en el que el usuario está matriculado. */
export const CourseSchema = z.object({
  id: z.number(),
  fullname: z.string(),
  shortname: z.string(),
  /** Nombres de contacto/profesor que Moodle asocia al curso (si los expone). */
  contacts: z.array(z.string()).default([]),
});
export type Course = z.infer<typeof CourseSchema>;

/** Estado de entrega de una tarea, cuando se puede determinar. */
export const SubmissionStatusSchema = z.enum([
  "submitted",
  "not-submitted",
  "graded",
  "unknown",
]);
export type SubmissionStatus = z.infer<typeof SubmissionStatusSchema>;

/**
 * Una tarea/assignment. `source` indica de dónde salió:
 *  - "calendar": apareció como evento de calendario (lo que ve la app Flutter).
 *  - "course-scan": se encontró barriendo el contenido del curso.
 * `hidden` es true cuando NO estaba en el calendario — el caso que causa entregas perdidas.
 */
export const TaskSchema = z.object({
  id: z.number(),
  name: z.string(),
  courseId: z.number(),
  courseName: z.string(),
  /** Fecha de entrega en epoch (segundos). null si no tiene fecha definida. */
  dueDate: z.number().nullable(),
  url: z.string().nullable(),
  description: z.string().nullable().default(null),
  source: z.enum(["calendar", "course-scan"]),
  hidden: z.boolean(),
  submission: SubmissionStatusSchema.default("unknown"),
  /** Nota, si la tarea ya fue calificada (texto tal cual lo muestra Moodle, ej. "16,00 / 20,00"). */
  grade: z.string().nullable().default(null),
  /** Texto de "Tiempo restante" de Moodle, cuando aplica. */
  timeRemaining: z.string().nullable().default(null),
  /** Archivos adjuntos a la consigna (guías, rúbricas) — legibles con read_resource. */
  attachments: z
    .array(z.object({ filename: z.string(), url: z.string() }))
    .default([]),
  /**
   * true si la consigna menciona una fecha distinta (>1 día) a la fecha oficial de cierre.
   * Señal de alerta: el profesor escribió otra fecha en el texto.
   */
  dateConflict: z.boolean().default(false),
  /** Fechas encontradas dentro del texto de la consigna. */
  datesInDescription: z
    .array(z.object({ text: z.string(), epoch: z.number().nullable() }))
    .default([]),
  /** Course module id (cmid) — identificador único del módulo en el curso. */
  cmid: z.number().nullable().default(null),
});
export type Task = z.infer<typeof TaskSchema>;

/** Un módulo dentro de una sección de curso (assign, quiz, resource, url, forum, ...). */
export const CourseModuleSchema = z.object({
  cmid: z.number(),
  name: z.string(),
  modname: z.string(),
  url: z.string().nullable(),
  visible: z.boolean().default(true),
  instance: z.number().nullable().default(null),
});
export type CourseModule = z.infer<typeof CourseModuleSchema>;

export const CourseSectionSchema = z.object({
  id: z.number(),
  name: z.string(),
  modules: z.array(CourseModuleSchema),
});
export type CourseSection = z.infer<typeof CourseSectionSchema>;

/** Un archivo descargable (recurso, adjunto de carpeta, etc.). */
export const ResourceFileSchema = z.object({
  filename: z.string(),
  /** URL de vista del módulo (mod/resource/view.php...) o directamente pluginfile.php. */
  fileurl: z.string(),
  moduleName: z.string(),
  modname: z.string(),
  mimetype: z.string().nullable().default(null),
  filesize: z.number().nullable().default(null),
});
export type ResourceFile = z.infer<typeof ResourceFileSchema>;
