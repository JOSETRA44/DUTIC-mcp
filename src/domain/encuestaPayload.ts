import { EncuestaProtocolError } from "../core/errors.js";
import {
  SCALE_BY_LABEL,
  SCORE_MAX,
  SCORE_MIN,
  normalizeLabel,
  type AnswerSet,
  type Questionnaire,
} from "../core/encuestaModels.js";

/**
 * Construcción PURA del cuerpo del envío y última barrera de seguridad antes de la red.
 *
 * Todo lo que hay aquí es reversible y testeable; lo que viene después (el POST) no lo es.
 */

/**
 * Reproduce exactamente la cadena que arma el JS del sitio (`creaCadenaPregconRptas` + `send`):
 *
 *   dato0 = id_doc
 *   dato1 = asi (id de la asignatura)
 *   dato2..datoN = "{idPregunta}|{respuesta}" en el orden del formulario
 *   nElem = índice del ÚLTIMO dato (= 1 + nº de preguntas)
 *   opcion = 2
 *
 * La respuesta es el ID DE ALTERNATIVA para las preguntas de escala y el número 0-20 para la
 * calificación. El carácter `|` viaja SIN codificar, igual que hacía jQuery al pasar la cadena
 * tal cual, y la cadena empieza por `&`.
 */
export function buildSubmitBody(a: AnswerSet): string {
  const data: string[] = [a.idDoc, a.asi];
  for (const ans of a.answers) {
    const value = ans.kind === "scale" ? ans.alternativeId! : String(ans.value);
    data.push(`${ans.questionId}|${value}`);
  }
  const nElem = data.length - 1;
  return `&${data.map((v, i) => `dato${i}=${v}`).join("&")}&nElem=${nElem}&opcion=2`;
}

/**
 * Última verificación antes del POST. Replica las validaciones que hace el JS del sitio y añade
 * las que ese JS no hace pero nos protegen de un fallo propio.
 *
 * La comprobación decisiva es la nº 3: confirma, de forma INDEPENDIENTE de cómo se resolvió la
 * respuesta, que el id de alternativa que va a viajar corresponde de verdad a la etiqueta que se
 * le mostró al usuario en el dry-run. Si la capa de política tuviera un fallo de inversión, aquí
 * revienta — antes de tocar la red y no después, que es cuando ya no habría remedio.
 */
export function assertPayloadSane(body: string, q: Questionnaire, a: AnswerSet): void {
  // 1. Completitud: es lo que valida el JS ("Olvido responder todas las preguntas").
  if (!a.complete) {
    throw new EncuestaProtocolError(`Respuestas incompletas: ${a.issues.join(" · ")}`);
  }
  if (a.answers.length !== q.questions.length) {
    throw new EncuestaProtocolError(
      `Se resolvieron ${a.answers.length} respuestas para ${q.questions.length} preguntas.`,
    );
  }
  if (a.idDoc !== q.idDoc || a.asi !== q.asi) {
    throw new EncuestaProtocolError(
      `El plan es de ${a.idDoc}/${a.asi} pero el cuestionario es de ${q.idDoc}/${q.asi}.`,
    );
  }

  for (const [i, ans] of a.answers.entries()) {
    const question = q.questions[i];

    // 2. Alineación posicional: detecta un cruce de índices entre plan y cuestionario.
    if (ans.questionId !== question.questionId) {
      throw new EncuestaProtocolError(
        `Desalineación en la posición ${i}: la respuesta es de la pregunta ${ans.questionId} ` +
          `pero el cuestionario espera ${question.questionId}.`,
      );
    }

    if (ans.kind === "scale") {
      const own = question.options.find((o) => o.alternativeId === ans.alternativeId);
      if (!own) {
        throw new EncuestaProtocolError(
          `p${question.index}: la alternativa ${ans.alternativeId} no pertenece a esta pregunta.`,
        );
      }
      // 3. La alternativa elegida DEBE corresponder a la etiqueta mostrada al usuario.
      const expected = SCALE_BY_LABEL.get(normalizeLabel(ans.label ?? ""));
      if (!expected || own.scale !== expected) {
        throw new EncuestaProtocolError(
          `p${question.index}: se iba a enviar la alternativa ${ans.alternativeId} ` +
            `("${own.label}") cuando la respuesta elegida era "${ans.label}". ` +
            `Evaluación potencialmente invertida: se aborta sin enviar.`,
        );
      }
    } else if (!Number.isInteger(ans.value) || ans.value < SCORE_MIN || ans.value > SCORE_MAX) {
      throw new EncuestaProtocolError(
        `Calificación inválida: ${ans.value} (debe ser un entero entre ${SCORE_MIN} y ${SCORE_MAX}).`,
      );
    }
  }

  // 4. Forma del cuerpo: ningún dato vacío y nElem coherente con lo que se envía.
  if (/dato\d+=(?=&|$)/.test(body)) {
    throw new EncuestaProtocolError("El cuerpo del envío contiene un dato vacío.");
  }
  const nElem = Number(/&nElem=(\d+)/.exec(body)?.[1]);
  if (nElem !== q.questions.length + 1) {
    throw new EncuestaProtocolError(
      `nElem=${nElem} incoherente: con ${q.questions.length} preguntas debería ser ${q.questions.length + 1}.`,
    );
  }
  if (!/&opcion=2$/.test(body)) {
    throw new EncuestaProtocolError("El cuerpo del envío no termina en opcion=2.");
  }
}
