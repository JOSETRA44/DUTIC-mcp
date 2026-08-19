import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SisacadProtocolError } from "../core/errors.js";
import { DAYS, parseHorarioHtml } from "./horario.js";

/**
 * Tests contra la respuesta REAL del sistema de matrícula, capturada en
 * test/fixtures/horario/ (con CUI y nombre del alumno anonimizados). No hace falta red ni
 * credenciales: aquí se gana la confianza en el manejo de la grilla con rowspans.
 */

const FIXTURES = join(process.cwd(), "test", "fixtures", "horario");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

test("parseHorarioHtml lee cabecera y los 13 bloques de la semana", () => {
  const h = parseHorarioHtml(fixture("horario-personalizado.html"));

  assert.equal(h.cui, "20250001");
  assert.equal(h.name, "PRUEBA/A, ESTUDIANTE");
  assert.equal(h.school, "ECONOMÍA");
  assert.equal(h.date, "2026/08/19");
  assert.equal(h.blocks.length, 13);
});

test("expande los rowspans sin duplicar clases en franjas intermedias", () => {
  const h = parseHorarioHtml(fixture("horario-personalizado.html"));

  // CONTABILIDAD del lunes ocupa 07:00-08:40 (rowspan=2): aparece UNA vez, en la franja inicial.
  const contabilidad = h.blocks.filter(
    (b) => b.day === "Lunes" && b.subject === "CONTABILIDAD GERENCIAL Y TRIBUTACIÓN",
  );
  assert.equal(contabilidad.length, 1);
  assert.equal(contabilidad[0].start, "07:00");

  // No hay nada registrado en 07:50 para el lunes (la franja la sigue ocupando el rowspan).
  const at0750 = h.blocks.filter((b) => b.day === "Lunes" && b.start === "07:50");
  assert.equal(at0750.length, 0);

  // La clase de 3 horas del miércoles (rowspan=3) se registra una sola vez.
  const ciudadania = h.blocks.filter((b) => b.day === "Miercoles" && b.subject.startsWith("CIUDADANIA"));
  assert.equal(ciudadania.length, 1);
  assert.equal(ciudadania[0].start, "07:00");
});

test("separa asignatura de aula en el <BR> y limpia el paréntesis", () => {
  const h = parseHorarioHtml(fixture("horario-personalizado.html"));

  const eco = h.blocks.find(
    (b) => b.day === "Miercoles" && b.start === "14:00",
  );
  assert.ok(eco);
  assert.equal(eco.subject, "DOCTRINAS ECONÓMICAS (E)", "el (E) es parte del nombre, no del aula");
  assert.equal(eco.location, "40.1-106/AULA 106 AFORO REAL 55");
});

test("respeta el orden de los días y cubre la semana completa", () => {
  const h = parseHorarioHtml(fixture("horario-personalizado.html"));

  const daysWithClass = [...new Set(h.blocks.map((b) => b.day))].sort();
  assert.deepEqual(daysWithClass, [...DAYS].sort(), "hay clases los 5 días de la semana");
  assert.ok(h.blocks.every((b) => /^\d{2}:\d{2}$/.test(b.start) && /^\d{2}:\d{2}$/.test(b.end)));
});

test("sin tabla de horario lanza SisacadProtocolError", () => {
  assert.throws(
    () => parseHorarioHtml("<html><body>acad_login.php?mensaje=sin sesion</body></html>"),
    SisacadProtocolError,
  );
});