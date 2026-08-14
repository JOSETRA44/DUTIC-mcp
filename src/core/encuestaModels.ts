import { z } from "zod";

/**
 * Modelo de datos de la encuesta de desempeño docente (extranet UNSA).
 *
 * Este archivo no hace I/O: define los tipos, la escala y las normalizaciones que usan tanto el
 * parseo puro (`domain/encuestaParse.ts`) como el cliente HTTP (`core/encuestaClient.ts`).
 */

// --- La escala, y por qué se trata con tanto cuidado ---

/** Escala declarada por el propio sistema: 1 NUNCA · 2 A VECES · 3 USUALMENTE · 4 SIEMPRE. */
export const SCALE_LABELS = ["Nunca", "A veces", "Usualmente", "Siempre"] as const;
export type ScaleLabel = (typeof SCALE_LABELS)[number];

/**
 * Valor lógico 1..4 de la escala.
 *
 * ATENCIÓN: no tiene NINGUNA relación con el orden de los ids de alternativa que viajan al
 * servidor. En el HTML real los ids van en orden DESCENDENTE respecto a la escala
 * (731=Nunca, 730=A veces, 729=Usualmente, 728=Siempre): la MEJOR respuesta lleva el id MÁS BAJO.
 * Cualquier código que derive la respuesta de la posición del radio o del orden numérico del id
 * enviaría la evaluación invertida — y el envío es irreversible. La única fuente de verdad es la
 * ETIQUETA de texto contigua al radio.
 */
export type ScaleValue = 1 | 2 | 3 | 4;

/**
 * Normalización agresiva para casar etiquetas: "A VECES", "A&nbsp;veces" y "A veces" son la misma
 * respuesta. El HTML llega en latin1 y con espacios duros, pero `\s` ya cubre el U+00A0, así que
 * basta con colapsar espacios. Quitar los acentos (NFD + marcas combinantes) hace además que el
 * casado sobreviva incluso a una decodificación fallida, que es justo cuando más falta hace.
 */
export function normalizeLabel(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Etiqueta normalizada → valor de escala. Incluye variantes vistas o plausibles. */
export const SCALE_BY_LABEL: ReadonlyMap<string, ScaleValue> = new Map<string, ScaleValue>([
  ["nunca", 1],
  ["a veces", 2],
  ["aveces", 2],
  ["usualmente", 3],
  ["siempre", 4],
]);

/** Valor de escala → etiqueta canónica. */
export function labelOfScale(v: ScaleValue): ScaleLabel {
  return SCALE_LABELS[v - 1];
}

/** Rango de la pregunta de calificación general (validado también por el JS del sitio). */
export const SCORE_MIN = 0;
export const SCORE_MAX = 20;

// --- Entidades ---

/** Una encuesta de la lista. `key` es el identificador estable que usan CLI y MCP. */
export interface SurveyRef {
  /** `${idDoc}-${idAsig}-${idNues}`, los tres argumentos de ir_llenado(). */
  key: string;
  idDoc: string;
  idAsig: string;
  idNues: string;
  /** "PRIETO/VALENCIA, GIOVANNI ANTONIO" */
  teacher: string;
  /** "ECOLOGÍA Y CONSERVACIÓN AMBIENTAL" */
  course: string;
  /** "ECONOMIA" (escuela profesional), si el listado la agrupa. */
  school: string | null;
  /** Etiqueta del bloque: "Docente", "General"… */
  kind: string;
  /**
   * "pending" SÓLO si la fila trae `onclick ir_llenado(...)`. Sin onclick se asume LLENADA y no
   * se reenvía jamás. La regla es deliberadamente conservadora: un falso "done" cuesta una
   * encuesta sin llenar (visible y corregible a mano), mientras que un falso "pending" costaría
   * un envío duplicado irreversible.
   */
  status: "pending" | "done";
  /** Texto de la celda de estado, tal cual ("Por llenar"). */
  statusText: string;
}

export type QuestionKind = "scale" | "score";

export interface Option {
  /** Id de alternativa que viaja al servidor. NO tiene orden semántico ascendente. */
  alternativeId: string;
  /** Etiqueta literal leída junto al radio. */
  label: string;
  /** Valor 1..4 derivado de la ETIQUETA — nunca de la posición ni del id. */
  scale: ScaleValue;
}

export interface Question {
  /** x del bucle del formulario (1..np-1); el grupo de radios se llama radio{index}. */
  index: number;
  /** Id real de pregunta (p.ej. "120"). Clave estable para los overrides de política. */
  questionId: string;
  /** Tipo crudo del hidden p{x} ("120:0" → "0"). */
  rawType: string;
  kind: QuestionKind;
  text: string;
  /** 4 opciones si kind="scale"; vacío si kind="score". */
  options: Option[];
  min?: number;
  max?: number;
  /**
   * Diagnóstico, no lógica: true si los ids del grupo van en orden descendente respecto a la
   * escala (como se observó). Si algún día deja de cumplirse, el envío sigue siendo correcto
   * (se resuelve por etiqueta) pero conviene enterarse.
   */
  idsDescendingVsScale: boolean;
}

export interface Questionnaire {
  ref: SurveyRef;
  /** Del hidden #id_doc del propio formulario: es la AUTORIDAD sobre a quién se evalúa. */
  idDoc: string;
  /** Del hidden #asi. */
  asi: string;
  /** Valor del hidden #np: número de preguntas + 1. */
  np: number;
  teacherName: string | null;
  courseName: string | null;
  questions: Question[];
  /** Anomalías no fatales (enunciado vacío, orden de ids inesperado…) para mostrar en el preview. */
  warnings: string[];
}

/** De dónde salió cada respuesta, para poder explicar el preview. */
export type AnswerSource =
  | "explicit"
  | "question-override"
  | "teacher-override"
  | "course-override"
  | "default";

export interface Answer {
  questionId: string;
  index: number;
  kind: QuestionKind;
  text: string;
  /** 1..4 para scale, 0..20 para score. */
  value: number;
  /** Etiqueta elegida (scale); es lo que se le muestra al usuario. null para score. */
  label: ScaleLabel | null;
  /** Id que viajará en el body (scale). null para score. */
  alternativeId: string | null;
  source: AnswerSource;
  /** Regla que la produjo, p.ej. `byTeacher["PRIETO"].byQuestion["127"]`. */
  rule: string;
}

export interface AnswerSet {
  ref: SurveyRef;
  idDoc: string;
  asi: string;
  answers: Answer[];
  /** Todas las de escala respondidas y la calificación entera 0-20. Si es false, NO se envía. */
  complete: boolean;
  /** Problemas legibles: "p7 sin respuesta", "clave 'PRIETO' ambigua (2 docentes)". */
  issues: string[];
  /** Media de los valores 1..4, sólo informativa. */
  scaleAverage: number | null;
  score: number | null;
}

export interface SubmitResult {
  key: string;
  teacher: string;
  course: string;
  /** "ok" = respuesta 1|… · "rejected" = 0|mensaje · "unknown" = irreconocible o error de red. */
  outcome: "ok" | "rejected" | "unknown";
  message: string;
  submittedAt: number;
  /** Body exacto enviado (nunca contiene credenciales: por aquí no viajan). */
  body: string;
  answers: {
    questionId: string;
    label: string | null;
    value: number;
    alternativeId: string | null;
  }[];
}

export interface FillReport {
  dryRun: boolean;
  planned: AnswerSet[];
  submitted: SubmitResult[];
  skipped: {
    key: string;
    teacher: string;
    reason: "already-submitted" | "not-pending" | "filtered";
  }[];
  failed: { key: string; teacher: string; error: string }[];
}

// --- Configuración persistida ---

/** Una respuesta de escala configurada: etiqueta ("Siempre") o número (1-4). */
export const ScaleAnswerSchema = z.union([z.string().min(1), z.number().int().min(1).max(4)]);
export const ScoreSchema = z.number().int().min(SCORE_MIN).max(SCORE_MAX);

/** Un ámbito de política: valor por defecto, calificación y overrides por pregunta. */
export const PolicyScopeSchema = z.object({
  /** Respuesta para toda pregunta de escala de este ámbito. */
  default: ScaleAnswerSchema.optional(),
  /** Calificación general 0-20. */
  score: ScoreSchema.optional(),
  /** Clave = id de pregunta ("127") o índice del formulario ("p7" / "7"). */
  byQuestion: z.record(z.union([ScaleAnswerSchema, ScoreSchema])).optional(),
});
export type PolicyScope = z.infer<typeof PolicyScopeSchema>;

export const EncuestaPolicySchema = PolicyScopeSchema.extend({
  byCourse: z.record(PolicyScopeSchema).optional(),
  byTeacher: z.record(PolicyScopeSchema).optional(),
});
export type EncuestaPolicy = z.infer<typeof EncuestaPolicySchema>;

export const EncuestaCredsSchema = z.object({
  user: z.string().min(1),
  password: z.string().min(1),
});
export type EncuestaCreds = z.infer<typeof EncuestaCredsSchema>;

export const EncuestaConfigSchema = z.object({
  version: z.literal(1).default(1),
  /** Se puede tener política sin credenciales guardadas (y viceversa). */
  credentials: EncuestaCredsSchema.optional(),
  policy: EncuestaPolicySchema.default({}),
  savedAt: z.number().default(0),
});
export type EncuestaConfig = z.infer<typeof EncuestaConfigSchema>;
