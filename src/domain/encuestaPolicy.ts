import { EncuestaProtocolError } from "../core/errors.js";
import {
  SCALE_BY_LABEL,
  SCALE_LABELS,
  SCORE_MAX,
  SCORE_MIN,
  labelOfScale,
  normalizeLabel,
  type Answer,
  type AnswerSet,
  type AnswerSource,
  type EncuestaPolicy,
  type Option,
  type PolicyScope,
  type Question,
  type Questionnaire,
  type ScaleLabel,
  type ScaleValue,
} from "../core/encuestaModels.js";

/**
 * Resolución PURA de qué se responde en cada pregunta, a partir de la política guardada y de los
 * overrides de la llamada en curso. Sin I/O: se prueba entera con cuestionarios sintéticos.
 *
 * Principio deliberado: NO hay respuesta por defecto escondida en el código. Si no existe una
 * regla aplicable, la pregunta se queda sin responder y el AnswerSet sale `complete: false`, que
 * bloquea el envío. Un default implícito sería el camino silencioso a mandar una evaluación que
 * el usuario nunca expresó.
 */

/** Acepta 1-4, "1".."4", "Siempre", "SIEMPRE", "a veces"… Lanza si no lo reconoce. */
export function parseScaleValue(v: string | number): ScaleLabel {
  if (typeof v === "number" || /^[1-4]$/.test(String(v).trim())) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 4) {
      throw new EncuestaProtocolError(
        `Valor de escala inválido: ${v}. Usa 1-4 o ${SCALE_LABELS.join(" / ")}.`,
      );
    }
    return labelOfScale(n as ScaleValue);
  }
  const scale = SCALE_BY_LABEL.get(normalizeLabel(String(v)));
  if (!scale) {
    throw new EncuestaProtocolError(
      `Respuesta desconocida: "${v}". Usa ${SCALE_LABELS.join(" / ")} o 1-4.`,
    );
  }
  return labelOfScale(scale);
}

function parseScoreValue(v: string | number): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < SCORE_MIN || n > SCORE_MAX) {
    throw new EncuestaProtocolError(
      `Calificación inválida: ${v}. Debe ser un entero entre ${SCORE_MIN} y ${SCORE_MAX}.`,
    );
  }
  return n;
}

/** Normaliza nombres para comparar claves de política: sin acentos, sin puntuación, minúsculas. */
export function matchKey(s: string): string {
  return normalizeLabel(s).replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

export interface ScopeMatch {
  scope: PolicyScope;
  key: string;
}

/**
 * Busca en una tabla de la política (byTeacher / byCourse) la entrada que casa con el nombre real,
 * por subcadena normalizada — así basta con escribir "QUENAYA/CALLE" o "Microeconomía".
 *
 * Si más de una clave casa, se considera AMBIGUA y no se aplica ninguna: aplicar la política del
 * docente equivocado es peor que no aplicar ninguna, porque el envío no se puede deshacer.
 */
export function resolveScope(
  table: Record<string, PolicyScope> | undefined,
  name: string,
): { match: ScopeMatch } | { ambiguous: string[] } | null {
  if (!table || !name) return null;
  const target = matchKey(name);
  const hits = Object.keys(table).filter((k) => {
    const needle = matchKey(k);
    return needle.length > 0 && target.includes(needle);
  });
  if (hits.length === 0) return null;
  if (hits.length > 1) return { ambiguous: hits };
  return { match: { scope: table[hits[0]], key: hits[0] } };
}

/** Overrides puntuales de esta ejecución (flags del CLI o `answers` de una tool MCP). */
export interface AnswerOverrides {
  /** Respuesta para todas las preguntas de escala de esta tanda. */
  default?: string | number;
  /** Calificación 0-20 de esta tanda. */
  score?: number;
  /** Clave = id de pregunta ("127") o índice del formulario ("p7" / "7"). */
  byQuestion?: Record<string, string | number>;
}

/** Busca un override de pregunta aceptando id ("127"), "p7" o "7". */
function lookupQuestion(
  table: Record<string, string | number> | undefined,
  q: Question,
): { value: string | number; key: string } | null {
  if (!table) return null;
  for (const key of [q.questionId, `p${q.index}`, String(q.index)]) {
    if (Object.prototype.hasOwnProperty.call(table, key)) {
      return { value: table[key], key };
    }
  }
  return null;
}

/** Localiza la opción por ETIQUETA. Nunca por índice ni por orden de id. */
export function pickOption(q: Question, label: ScaleLabel): Option {
  const scale = SCALE_BY_LABEL.get(normalizeLabel(label));
  const found = q.options.find((o) => o.scale === scale);
  if (!found) {
    throw new EncuestaProtocolError(
      `p${q.index}: la pregunta no ofrece la alternativa "${label}".`,
    );
  }
  return found;
}

/**
 * Resuelve TODAS las respuestas de un cuestionario.
 *
 * Precedencia, de más específica a menos:
 *   1. overrides.byQuestion         (lo que el usuario dictó ahora para esa pregunta)
 *   2. overrides.default / .score   (lo que dictó ahora para toda la tanda)
 *   3. byTeacher[T].byQuestion
 *   4. byCourse[C].byQuestion
 *   5. policy.byQuestion
 *   6. byTeacher[T].default / .score
 *   7. byCourse[C].default / .score
 *   8. policy.default / policy.score
 *   9. sin regla ⇒ no se inventa nada: issue + complete=false
 *
 * No lanza por falta de regla (acumula `issues`, para poder enseñar el plan entero), pero sí
 * lanza si una regla existe y es inválida: eso es un error de configuración, no una laguna.
 */
export function resolveAnswers(
  q: Questionnaire,
  policy: EncuestaPolicy,
  overrides: AnswerOverrides = {},
): AnswerSet {
  const issues: string[] = [];

  const teacherName = q.teacherName ?? q.ref.teacher;
  const courseName = q.courseName ?? q.ref.course;

  const teacherRes = resolveScope(policy.byTeacher, teacherName);
  const courseRes = resolveScope(policy.byCourse, courseName);

  if (teacherRes && "ambiguous" in teacherRes) {
    issues.push(
      `La política tiene ${teacherRes.ambiguous.length} claves de docente que casan con ` +
        `"${teacherName}" (${teacherRes.ambiguous.join(", ")}). Afina las claves: no se aplica ninguna.`,
    );
  }
  if (courseRes && "ambiguous" in courseRes) {
    issues.push(
      `La política tiene ${courseRes.ambiguous.length} claves de curso que casan con ` +
        `"${courseName}" (${courseRes.ambiguous.join(", ")}). Afina las claves: no se aplica ninguna.`,
    );
  }

  const teacher = teacherRes && "match" in teacherRes ? teacherRes.match : null;
  const course = courseRes && "match" in courseRes ? courseRes.match : null;

  const answers: Answer[] = [];

  for (const question of q.questions) {
    // Cadena de candidatos en orden de precedencia. El primero que exista, gana.
    const candidates: {
      value: string | number | undefined;
      source: AnswerSource;
      rule: string;
    }[] = [];

    const ov = lookupQuestion(overrides.byQuestion, question);
    if (ov) candidates.push({ value: ov.value, source: "explicit", rule: `respuesta explícita [${ov.key}]` });

    if (question.kind === "scale") {
      if (overrides.default !== undefined) {
        candidates.push({ value: overrides.default, source: "explicit", rule: "respuesta explícita (toda la tanda)" });
      }
    } else if (overrides.score !== undefined) {
      candidates.push({ value: overrides.score, source: "explicit", rule: "calificación explícita" });
    }

    const tq = teacher ? lookupQuestion(teacher.scope.byQuestion, question) : null;
    if (tq) {
      candidates.push({
        value: tq.value,
        source: "question-override",
        rule: `byTeacher["${teacher!.key}"].byQuestion["${tq.key}"]`,
      });
    }
    const cq = course ? lookupQuestion(course.scope.byQuestion, question) : null;
    if (cq) {
      candidates.push({
        value: cq.value,
        source: "question-override",
        rule: `byCourse["${course!.key}"].byQuestion["${cq.key}"]`,
      });
    }
    const gq = lookupQuestion(policy.byQuestion, question);
    if (gq) {
      candidates.push({ value: gq.value, source: "question-override", rule: `byQuestion["${gq.key}"]` });
    }

    const scopeValue = (scope: PolicyScope | undefined) =>
      question.kind === "scale" ? scope?.default : scope?.score;

    if (teacher && scopeValue(teacher.scope) !== undefined) {
      candidates.push({
        value: scopeValue(teacher.scope),
        source: "teacher-override",
        rule: `byTeacher["${teacher.key}"].${question.kind === "scale" ? "default" : "score"}`,
      });
    }
    if (course && scopeValue(course.scope) !== undefined) {
      candidates.push({
        value: scopeValue(course.scope),
        source: "course-override",
        rule: `byCourse["${course.key}"].${question.kind === "scale" ? "default" : "score"}`,
      });
    }
    if (scopeValue(policy) !== undefined) {
      candidates.push({
        value: scopeValue(policy),
        source: "default",
        rule: question.kind === "scale" ? "policy.default" : "policy.score",
      });
    }

    const chosen = candidates.find((c) => c.value !== undefined);
    if (!chosen) {
      issues.push(
        `p${question.index} (${question.kind === "score" ? "calificación" : "escala"}) sin respuesta: ` +
          `no hay ninguna regla aplicable.`,
      );
      continue;
    }

    if (question.kind === "scale") {
      const label = parseScaleValue(chosen.value!);
      const option = pickOption(question, label);
      answers.push({
        questionId: question.questionId,
        index: question.index,
        kind: "scale",
        text: question.text,
        value: option.scale,
        label,
        alternativeId: option.alternativeId,
        source: chosen.source,
        rule: chosen.rule,
      });
    } else {
      const value = parseScoreValue(chosen.value!);
      answers.push({
        questionId: question.questionId,
        index: question.index,
        kind: "score",
        text: question.text,
        value,
        label: null,
        alternativeId: null,
        source: chosen.source,
        rule: chosen.rule,
      });
    }
  }

  const scaleAnswers = answers.filter((a) => a.kind === "scale");
  const scoreAnswer = answers.find((a) => a.kind === "score");

  return {
    ref: q.ref,
    idDoc: q.idDoc,
    asi: q.asi,
    answers,
    complete: issues.length === 0 && answers.length === q.questions.length,
    issues,
    scaleAverage: scaleAnswers.length
      ? Number((scaleAnswers.reduce((s, a) => s + a.value, 0) / scaleAnswers.length).toFixed(2))
      : null,
    score: scoreAnswer?.value ?? null,
  };
}
