import * as cheerio from "cheerio";
import { EncuestaProtocolError } from "../core/errors.js";
import {
  SCALE_BY_LABEL,
  SCALE_LABELS,
  SCORE_MAX,
  SCORE_MIN,
  normalizeLabel,
  type Option,
  type Question,
  type Questionnaire,
  type SurveyRef,
} from "../core/encuestaModels.js";

/**
 * Parseo PURO de las respuestas del sistema de encuestas. Este módulo no hace I/O: recibe strings
 * y devuelve estructuras, para que se pueda probar entero contra las respuestas reales guardadas
 * en `test/fixtures/encuesta/` sin credenciales ni red.
 *
 * Aquí vive la defensa contra el fallo más grave posible de esta herramienta: enviar la evaluación
 * invertida. Ver `assertScaleGroup` y el comentario de `ScaleValue` en core/encuestaModels.ts.
 */

// --- Envoltorio `1|payload` ---

export interface PipePayload {
  code: "0" | "1";
  body: string;
}

/**
 * El backend antepone a la respuesta su propio debug de SQL
 * (`<BR> sql: SELECT * FROM encuestas WHERE ...`, repetido varias veces) y sólo después emite el
 * payload real `1|...`. Peor: el marcador queda pegado al debug, sin separador
 * (`...est_enc='A'1| <br><div...`), así que no se puede anclar a inicio de línea.
 *
 * Se localiza el ÚLTIMO bloque de debug y se busca el marcador a partir de ahí; si no hay debug,
 * se busca desde el principio. No se parte el resto por `|`: el HTML contiene ese carácter y
 * cualquier corte adicional sería una apuesta.
 */
export function stripDebugAndCode(raw: string): PipePayload {
  const lastSql = raw.lastIndexOf("sql:");
  const from = lastSql >= 0 ? lastSql : 0;
  const m = /([01])\|/.exec(raw.slice(from));
  if (!m) {
    throw new EncuestaProtocolError(
      "La respuesta del sistema de encuestas no trae el marcador '1|' ni '0|'.",
      raw.slice(0, 500),
    );
  }
  return {
    code: m[1] as "0" | "1",
    body: raw.slice(from + m.index + m[0].length),
  };
}

const clean = (s: string): string => s.replace(/\s+/g, " ").trim();

// --- Lista de encuestas ---

/**
 * Extrae las encuestas del HTML del listado.
 *
 * Estructura real: un `<h3>` con la ESCUELA, y luego, por cada asignatura, un `<h3>` con el nombre
 * del curso seguido de un `<div>` con la tabla y el enlace `ir_llenado(...)`. Para distinguir
 * escuela de curso se usa la POSICIÓN (dos `<h3>` seguidos sin enlace en medio ⇒ el primero es la
 * escuela) en vez del color de fondo del estilo: sobrevive a un rediseño y no depende de literales
 * de CSS.
 */
export function parseSurveyList(payloadBody: string): SurveyRef[] {
  const $ = cheerio.load(payloadBody);
  const refs: SurveyRef[] = [];
  const seen = new Set<string>();

  let school: string | null = null;
  let course: string | null = null;
  let headingsSinceRow: string[] = [];

  const rowSelector = "h3, a[onclick*='ir_llenado'], table tr";
  $(rowSelector).each((_, el) => {
    const tag = (el as { tagName?: string }).tagName?.toLowerCase();

    if (tag === "h3") {
      headingsSinceRow.push(clean($(el).text()));
      return;
    }

    // Sólo interesan las filas que describen una encuesta.
    const $row = tag === "a" ? $(el).closest("tr") : $(el);
    const rowText = clean($row.text());
    if (!/Encuesta\s/i.test(rowText)) return;

    if (headingsSinceRow.length >= 2) {
      school = headingsSinceRow[headingsSinceRow.length - 2];
      course = headingsSinceRow[headingsSinceRow.length - 1];
    } else if (headingsSinceRow.length === 1) {
      course = headingsSinceRow[0];
    }
    headingsSinceRow = [];

    const onclick = $row.find("a[onclick*='ir_llenado']").attr("onclick") ?? "";
    const ids = /ir_llenado\(\s*'(\d+)'\s*,\s*'(\d+)'\s*,\s*'(\d+)'\s*\)/.exec(onclick);

    // "Encuesta Docente (APELLIDO/APELLIDO, NOMBRES)"
    const who = /Encuesta\s+([^(]+?)\s*\(([^)]*)\)/.exec(rowText);
    const kind = who ? clean(who[1]) : "Docente";
    const teacher = who ? clean(who[2]) : "";

    // El estado es lo que queda de la fila tras quitar la parte del "Encuesta X (docente)".
    const statusText = clean(rowText.replace(/^.*?\)\s*/, "")) || (ids ? "Por llenar" : "");

    if (!ids) {
      // Sin enlace ir_llenado la damos por LLENADA y no se reenvía jamás. Es la lectura
      // conservadora: un falso "llenada" se ve a simple vista y se arregla a mano, mientras que
      // un falso "pendiente" costaría un envío duplicado e irreversible.
      if (!teacher) return;
      const key = `done:${teacher}:${course ?? ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      refs.push({
        key,
        idDoc: "",
        idAsig: "",
        idNues: "",
        teacher,
        course: course ?? "",
        school,
        kind,
        status: "done",
        statusText,
      });
      return;
    }

    const [, idDoc, idAsig, idNues] = ids;
    const key = `${idDoc}-${idAsig}-${idNues}`;
    if (seen.has(key)) return;
    seen.add(key);

    refs.push({
      key,
      idDoc,
      idAsig,
      idNues,
      teacher,
      course: course ?? "",
      school,
      kind,
      status: "pending",
      statusText,
    });
  });

  return refs;
}

// --- Cuestionario ---

/**
 * Exige que un grupo de alternativas traiga EXACTAMENTE las 4 de la escala.
 *
 * Es la salvaguarda central de toda la herramienta. Los ids de alternativa van en orden
 * DESCENDENTE respecto a la escala (731=Nunca … 728=Siempre): la mejor respuesta lleva el id más
 * bajo. Por eso la alternativa se elige SIEMPRE casando la etiqueta de texto, nunca la posición ni
 * el orden del id — y por eso, si las etiquetas no son exactamente las esperadas, no hay forma
 * fiable de decidir y se aborta sin enviar nada.
 */
export function assertScaleGroup(index: number, options: Option[]): void {
  const scales = new Set(options.map((o) => o.scale));
  if (options.length !== 4 || scales.size !== 4) {
    throw new EncuestaProtocolError(
      `p${index}: grupo de alternativas inválido (${options.length} opciones, ` +
        `escalas [${[...scales].sort().join(", ")}]). Se esperaban las 4: ` +
        `${SCALE_LABELS.join(" / ")}. No se envía nada.`,
    );
  }
}

export function parseQuestionnaire(payloadBody: string, ref: SurveyRef): Questionnaire {
  const $ = cheerio.load(payloadBody);
  const warnings: string[] = [];

  const idDoc = $('input[name="id_doc"]').attr("value")?.trim();
  const asi = $('input[name="asi"]').attr("value")?.trim();
  const np = Number($('input[name="np"]').attr("value"));

  if (!idDoc || !asi || !Number.isInteger(np) || np < 2) {
    throw new EncuestaProtocolError(
      "El cuestionario no trae id_doc/asi/np: el formato del sistema cambió.",
      payloadBody.slice(0, 500),
    );
  }

  // El servidor es la autoridad sobre a quién se está evaluando. Enviar la encuesta al docente
  // equivocado es tan irreversible como enviarla mal, así que ante una discrepancia se aborta.
  if (idDoc !== ref.idDoc || asi !== ref.idAsig) {
    throw new EncuestaProtocolError(
      `El servidor devolvió otro docente/asignatura: ${idDoc}/${asi} en vez de ` +
        `${ref.idDoc}/${ref.idAsig}. No se envía nada.`,
    );
  }

  const questions: Question[] = [];

  for (let x = 1; x < np; x++) {
    const rawValue = $(`input[name="p${x}"]`).attr("value");
    if (!rawValue) {
      throw new EncuestaProtocolError(
        `Falta la pregunta p${x} de las ${np - 1} declaradas por el formulario.`,
      );
    }
    const [questionId, rawType] = rawValue.split(":");
    if (!questionId || rawType === undefined) {
      throw new EncuestaProtocolError(`p${x}: valor inesperado "${rawValue}" (se esperaba "id:tipo").`);
    }

    // El enunciado vive en la misma fila de cabecera que el hidden: "1.- El docente ...".
    const headingText = clean($(`input[name="p${x}"]`).closest("tr").text()).replace(
      /^\d+\.-\s*/,
      "",
    );
    const text = headingText || `Pregunta ${x}`;
    if (!headingText) warnings.push(`p${x}: no se pudo leer el enunciado.`);

    if (rawType === "1") {
      // Opción múltiple: sólo aparece en la "encuesta general", que esta herramienta no cubre.
      // Se corta explícitamente en vez de mandar algo mal formado.
      throw new EncuestaProtocolError(
        `p${x} es de opción múltiple (tipo 1), propia de la encuesta general. ` +
          `Esta herramienta sólo cubre la encuesta docente; complétala en la web.`,
      );
    }

    if (rawType === "0") {
      const options: Option[] = [];
      $(`input[type="radio"][name="radio${x}"]`).each((_, r) => {
        const alternativeId = ($(r).attr("value") ?? "").trim();
        const rawLabel = clean($(r).nextAll("font").first().text() || $(r).parent().text());
        const scale = SCALE_BY_LABEL.get(normalizeLabel(rawLabel));
        if (!alternativeId || !scale) {
          throw new EncuestaProtocolError(
            `p${x}: alternativa con etiqueta desconocida "${rawLabel}". ` +
              `Esperadas: ${SCALE_LABELS.join(", ")}. Sin una etiqueta fiable no se puede decidir ` +
              `la respuesta, porque los ids NO indican el orden de la escala. No se envía nada.`,
          );
        }
        options.push({ alternativeId, label: rawLabel, scale });
      });

      assertScaleGroup(x, options);

      // Diagnóstico, nunca lógica de decisión: comprobamos si se mantiene el orden descendente
      // observado. Si dejara de cumplirse el envío seguiría siendo correcto (se resuelve por
      // etiqueta), pero conviene enterarse de que el sistema cambió.
      const byScale = [...options].sort((a, b) => a.scale - b.scale).map((o) => Number(o.alternativeId));
      const idsDescendingVsScale = byScale.every((v, i, arr) => i === 0 || v < arr[i - 1]);
      if (!idsDescendingVsScale) {
        warnings.push(
          `p${x}: los ids de alternativa ya no van en orden descendente respecto a la escala ` +
            `(${byScale.join(", ")}). No afecta al envío, pero revisa el sistema.`,
        );
      }

      questions.push({
        index: x,
        questionId,
        rawType,
        kind: "scale",
        text,
        options,
        idsDescendingVsScale,
      });
      continue;
    }

    // Resto de tipos (en la práctica "2"): campo numérico de calificación general 0-20.
    questions.push({
      index: x,
      questionId,
      rawType,
      kind: "score",
      text,
      options: [],
      min: SCORE_MIN,
      max: SCORE_MAX,
      idsDescendingVsScale: false,
    });
  }

  if (questions.length !== np - 1) {
    throw new EncuestaProtocolError(
      `Se leyeron ${questions.length} preguntas pero el formulario declara ${np - 1}.`,
    );
  }

  const teacherName = clean($('font[color="#993300"]').first().text()) || null;
  const courseName = clean($('font[color="#993300"]').eq(1).text()) || null;

  return { ref, idDoc, asi, np, teacherName, courseName, questions, warnings };
}
