import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EncuestaPolicy, SurveyRef } from "../core/encuestaModels.js";
import { parseQuestionnaire, stripDebugAndCode } from "./encuestaParse.js";
import { parseScaleValue, resolveAnswers } from "./encuestaPolicy.js";
import { assertPayloadSane, buildSubmitBody } from "./encuestaPayload.js";

const FIXTURES = join(process.cwd(), "test", "fixtures", "encuesta");

const ref: SurveyRef = {
  key: "1937-8353-470",
  idDoc: "1937",
  idAsig: "8353",
  idNues: "470",
  teacher: "DOCENTE/UNO, NOMBRE EJEMPLO",
  course: "ECOLOGÍA Y CONSERVACIÓN AMBIENTAL",
  school: "ECONOMIA",
  kind: "Docente",
  status: "pending",
  statusText: "Por llenar",
};

const load = () =>
  parseQuestionnaire(
    stripDebugAndCode(readFileSync(join(FIXTURES, "cuestionario-1937.raw"), "utf8")).body,
    ref,
  );

test("parseScaleValue acepta etiquetas y números, y rechaza lo demás", () => {
  assert.equal(parseScaleValue("Siempre"), "Siempre");
  assert.equal(parseScaleValue("SIEMPRE"), "Siempre");
  assert.equal(parseScaleValue(4), "Siempre");
  assert.equal(parseScaleValue("1"), "Nunca");
  assert.equal(parseScaleValue("a veces"), "A veces");
  assert.throws(() => parseScaleValue("Casi siempre"), /desconocida/i);
  assert.throws(() => parseScaleValue(7), /inválido/i);
});

test("sin política ni overrides no se inventa nada: incompleto y sin enviar", () => {
  const plan = resolveAnswers(load(), {});
  assert.equal(plan.complete, false);
  assert.equal(plan.answers.length, 0);
  assert.equal(plan.issues.length, 21);
});

test("policy.default + score responde las 21 y elige el id correcto", () => {
  const q = load();
  const plan = resolveAnswers(q, { default: "Siempre", score: 18 });

  assert.equal(plan.complete, true);
  assert.equal(plan.answers.length, 21);
  assert.equal(plan.score, 18);
  assert.equal(plan.scaleAverage, 4);

  // "Siempre" debe mapear al id MÁS BAJO del grupo (728 en p1), no al primero del DOM.
  assert.equal(plan.answers[0].alternativeId, "728");
  assert.equal(plan.answers[0].label, "Siempre");
  assert.equal(plan.answers[0].rule, "policy.default");
});

test("precedencia: pregunta > docente > curso > global", () => {
  const q = load();
  const policy: EncuestaPolicy = {
    default: "Nunca",
    score: 5,
    byCourse: { "ECOLOGIA": { default: "A veces", score: 10 } },
    byTeacher: {
      "DOCENTE/UNO": { default: "Usualmente", score: 15, byQuestion: { "122": "Siempre" } },
    },
    byQuestion: { "121": "A veces" },
  };
  const plan = resolveAnswers(q, policy);

  const byId = (id: string) => plan.answers.find((a) => a.questionId === id)!;

  // p3 (id 122): override por pregunta del docente, lo más específico.
  assert.equal(byId("122").label, "Siempre");
  assert.equal(byId("122").rule, 'byTeacher["DOCENTE/UNO"].byQuestion["122"]');

  // p2 (id 121): override global por pregunta, gana al default del docente.
  assert.equal(byId("121").label, "A veces");

  // p1 (id 120): sin override de pregunta, manda el docente sobre curso y global.
  assert.equal(byId("120").label, "Usualmente");
  assert.equal(byId("120").rule, 'byTeacher["DOCENTE/UNO"].default');

  // La calificación sigue la misma cadena sin nivel de pregunta: gana el docente.
  assert.equal(plan.score, 15);
});

test("los overrides de la llamada ganan a toda la política", () => {
  const q = load();
  const policy: EncuestaPolicy = { default: "Nunca", score: 0 };
  const plan = resolveAnswers(q, policy, { default: "Siempre", score: 20, byQuestion: { p1: "Nunca" } });

  assert.equal(plan.answers[0].label, "Nunca", "el override por pregunta manda");
  assert.equal(plan.answers[1].label, "Siempre", "el override de tanda manda sobre la política");
  assert.equal(plan.score, 20);
});

test("una clave de política ambigua no se aplica y se reporta", () => {
  const q = load();
  const plan = resolveAnswers(q, {
    default: "Siempre",
    score: 18,
    byTeacher: { DOCENTE: { default: "Nunca" }, UNO: { default: "A veces" } },
  });
  assert.equal(plan.complete, false);
  assert.match(plan.issues.join(" "), /claves de docente que casan/i);
});

test("buildSubmitBody reproduce exactamente la cadena del JS original", () => {
  const q = load();
  const plan = resolveAnswers(q, { default: "Siempre", score: 18 });
  const body = buildSubmitBody(plan);

  assert.ok(body.startsWith("&dato0=1937&dato1=8353&dato2=120|728&"), body.slice(0, 80));
  assert.ok(body.endsWith("&dato21=139|804&dato22=140|18&nElem=22&opcion=2"), body.slice(-60));
  assert.ok(body.includes("|"), "la barra vertical viaja sin codificar");
  assert.equal((body.match(/&dato\d+=/g) ?? []).length, 23, "dato0..dato22");

  assert.doesNotThrow(() => assertPayloadSane(body, q, plan));
});

test("assertPayloadSane detecta una evaluación invertida antes de enviar", () => {
  const q = load();
  const plan = resolveAnswers(q, { default: "Siempre", score: 18 });

  // Se simula el fallo catastrófico: la etiqueta dice "Siempre" pero el id es el de "Nunca".
  const saboteado = structuredClone(plan);
  saboteado.answers[0].alternativeId = "731";

  assert.throws(
    () => assertPayloadSane(buildSubmitBody(saboteado), q, saboteado),
    /potencialmente invertida/i,
  );
});

test("assertPayloadSane rechaza un plan incompleto", () => {
  const q = load();
  const plan = resolveAnswers(q, { default: "Siempre" }); // sin score
  assert.equal(plan.complete, false);
  assert.throws(() => assertPayloadSane(buildSubmitBody(plan), q, plan), /incompletas/i);
});
