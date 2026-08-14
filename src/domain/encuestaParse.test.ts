import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCALE_LABELS, type SurveyRef } from "../core/encuestaModels.js";
import { parseQuestionnaire, parseSurveyList, stripDebugAndCode } from "./encuestaParse.js";

/**
 * Tests contra las respuestas REALES del sistema, capturadas en test/fixtures/encuesta/.
 * No hace falta red ni credenciales: es donde se gana casi toda la confianza antes de que exista
 * una sola línea capaz de hacer un POST.
 */

const FIXTURES = join(process.cwd(), "test", "fixtures", "encuesta");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const refOf = (idDoc: string, idAsig: string): SurveyRef => ({
  key: `${idDoc}-${idAsig}-470`,
  idDoc,
  idAsig,
  idNues: "470",
  teacher: "",
  course: "",
  school: null,
  kind: "Docente",
  status: "pending",
  statusText: "Por llenar",
});

test("stripDebugAndCode descarta el debug SQL y devuelve el payload", () => {
  const { code, body } = stripDebugAndCode(fixture("lista.raw"));
  assert.equal(code, "1");
  assert.ok(!body.includes("sql: SELECT"), "el debug SQL no debe llegar al parser");
  assert.ok(body.includes("ir_llenado"), "el payload debe traer los enlaces de las encuestas");
});

test("stripDebugAndCode reconoce un rechazo 0|mensaje", () => {
  const { code, body } = stripDebugAndCode("0|Ya registro esta encuesta");
  assert.equal(code, "0");
  assert.equal(body, "Ya registro esta encuesta");
});

test("parseSurveyList extrae las 7 encuestas pendientes con su terna", () => {
  const refs = parseSurveyList(stripDebugAndCode(fixture("lista.raw")).body);
  const pending = refs.filter((r) => r.status === "pending");

  assert.equal(pending.length, 7);
  assert.ok(pending.every((r) => r.idNues === "470"));
  assert.ok(pending.every((r) => r.teacher.length > 0));
  assert.ok(pending.every((r) => r.course.length > 0));
  assert.equal(new Set(pending.map((r) => r.key)).size, 7, "las keys deben ser únicas");

  const eco = pending.find((r) => r.teacher.startsWith("DOCENTE/UNO"));
  assert.ok(eco);
  assert.equal(eco.key, "1937-8353-470");
  assert.equal(eco.course, "ECOLOGÍA Y CONSERVACIÓN AMBIENTAL");
  assert.equal(eco.school, "ECONOMIA", "la escuela se distingue del curso por posición");
  assert.equal(eco.kind, "Docente");
});

test("parseQuestionnaire lee las 21 preguntas y la calificación final", () => {
  const q = parseQuestionnaire(
    stripDebugAndCode(fixture("cuestionario-1937.raw")).body,
    refOf("1937", "8353"),
  );

  assert.equal(q.np, 22);
  assert.equal(q.questions.length, 21);
  assert.equal(q.idDoc, "1937");
  assert.equal(q.asi, "8353");

  const scale = q.questions.filter((x) => x.kind === "scale");
  const score = q.questions.filter((x) => x.kind === "score");
  assert.equal(scale.length, 20);
  assert.equal(score.length, 1);
  assert.equal(score[0].questionId, "140");

  // Todas las de escala traen exactamente las 4 alternativas, con las 4 etiquetas distintas.
  for (const x of scale) {
    assert.equal(x.options.length, 4, `p${x.index} debe tener 4 opciones`);
    assert.equal(new Set(x.options.map((o) => o.scale)).size, 4);
  }

  assert.ok(q.questions[0].text.includes("sílabo"), "el enunciado debe llegar en UTF-8 correcto");
});

/**
 * EL TEST QUE IMPORTA. Los ids de alternativa van en orden descendente respecto a la escala
 * (731=Nunca … 728=Siempre). Si alguien "optimizara" el parser para elegir por posición o por
 * orden de id, la evaluación saldría invertida y el envío es irreversible.
 */
test("la alternativa se resuelve por ETIQUETA, no por el orden de los ids", () => {
  const q = parseQuestionnaire(
    stripDebugAndCode(fixture("cuestionario-1937.raw")).body,
    refOf("1937", "8353"),
  );
  const p1 = q.questions[0];

  const byLabel = (label: string) => p1.options.find((o) => o.label === label)!;

  // El orden documental es Nunca, A veces, Usualmente, Siempre — pero los ids DECRECEN.
  assert.deepEqual(
    p1.options.map((o) => o.label),
    [...SCALE_LABELS],
  );
  assert.equal(byLabel("Nunca").alternativeId, "731");
  assert.equal(byLabel("A veces").alternativeId, "730");
  assert.equal(byLabel("Usualmente").alternativeId, "729");
  assert.equal(byLabel("Siempre").alternativeId, "728");

  // La MEJOR respuesta tiene el id MÁS BAJO del grupo: exactamente al revés de lo intuitivo.
  const ids = p1.options.map((o) => Number(o.alternativeId));
  assert.equal(Number(byLabel("Siempre").alternativeId), Math.min(...ids));
  assert.equal(Number(byLabel("Nunca").alternativeId), Math.max(...ids));
  assert.equal(p1.idsDescendingVsScale, true);

  // Y la escala se deriva de la etiqueta, no del id.
  assert.equal(byLabel("Siempre").scale, 4);
  assert.equal(byLabel("Nunca").scale, 1);
});

test("parseQuestionnaire aborta si una etiqueta de la escala no se reconoce", () => {
  const raw = stripDebugAndCode(fixture("cuestionario-1937.raw")).body;
  const mutado = raw.replace("<font size=\"2\">Siempre</font>", '<font size="2">Casi siempre</font>');
  assert.notEqual(mutado, raw, "la mutación debe aplicarse para que el test tenga sentido");

  assert.throws(
    () => parseQuestionnaire(mutado, refOf("1937", "8353")),
    /etiqueta desconocida|grupo de alternativas inválido/i,
  );
});

test("parseQuestionnaire aborta si el servidor devuelve otro docente", () => {
  const raw = stripDebugAndCode(fixture("cuestionario-1937.raw")).body;
  assert.throws(
    () => parseQuestionnaire(raw, refOf("9999", "8353")),
    /otro docente\/asignatura/i,
  );
});

test("el cuestionario de otro docente tiene la misma estructura", () => {
  const q = parseQuestionnaire(
    stripDebugAndCode(fixture("cuestionario-1164.raw")).body,
    refOf("1164", "8355"),
  );
  assert.equal(q.questions.length, 21);
  assert.equal(q.questions[0].questionId, "120");
  assert.equal(q.questions[0].options.find((o) => o.label === "Siempre")?.alternativeId, "728");
});
