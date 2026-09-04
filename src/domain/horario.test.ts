import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SisacadProtocolError } from "../core/errors.js";
import {
  DAYS,
  parseAulaList,
  parseAulaScheduleHtml,
  parseCourseCatalog,
  parseHorarioHtml,
  parseSchoolName,
  parseSubjectScheduleHtml,
} from "./horario.js";

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

test("vista por asignatura: la cabecera da el código/nombre y las celdas el aula", () => {
  const h = parseSubjectScheduleHtml(fixture("horario-asignatura.html"));

  assert.equal(h.code, "2501209");
  assert.equal(h.label, "METODOLOGÍA DEL TRABAJO ACADÉMICO (A)");
  assert.equal(h.school, "ECONOMÍA");
  assert.equal(h.date, "2026/08/19");
  // Martes y Jueves 07:00 (rowspan=2): una entrada por día, sin duplicados en 07:50.
  assert.equal(h.blocks.length, 2);
  for (const b of h.blocks) {
    assert.equal(b.subject, "METODOLOGÍA DEL TRABAJO ACADÉMICO");
    assert.equal(b.group, "A");
    assert.equal(b.start, "07:00");
    assert.equal(b.location, "40.1-105/aula 105(Interfac/ECONOMÍA)MTA_A");
  }
  assert.deepEqual(
    h.blocks.map((b) => b.day).sort(),
    ["Jueves", "Martes"].sort(),
  );
});

test("vista por aula: la cabecera da el aula y las celdas asignatura + grupo", () => {
  const h = parseAulaScheduleHtml(fixture("horario-aula.html"));

  assert.equal(h.label, "40.1-105/AULA 105 AFORO REAL 55");
  assert.equal(h.school, "ECONOMÍA");
  assert.equal(h.blocks.length, 11, "11 bloques: 6 asignaturas en distintas franjas/días");
  for (const b of h.blocks) {
    assert.equal(b.location, h.label, "todas las celdas comparten el aula de la cabecera");
    assert.equal(b.group, "A");
    assert.ok(b.subject.length > 0);
  }
  // La clase larga de Literatura (rowspan=3) se registra una sola vez.
  const literatura = h.blocks.filter((b) => b.subject.startsWith("LITERATURA"));
  assert.equal(literatura.length, 1);
  assert.equal(literatura[0].start, "07:00");
  // Inglés aparece dos veces: martes y jueves a las 11:30.
  const ingles = h.blocks.filter((b) => b.subject === "INGLÉS");
  assert.equal(ingles.length, 2);
  assert.ok(ingles.every((b) => b.start === "11:30"));
});

test("catálogo: código, nombre, sección y año por cada opción del select", () => {
  const catalog = parseCourseCatalog(fixture("catalogo.html"));

  assert.equal(catalog.length, 19);
  const primera = catalog[0];
  assert.deepEqual(primera, {
    code: "2501209",
    name: "METODOLOGÍA DEL TRABAJO ACADÉMICO",
    group: "A",
    year: "Primer año",
  });
  // Las secciones B/C/D/E de la misma asignatura comparten código y año.
  const metodologia = catalog.filter((c) => c.code === "2501209");
  assert.equal(metodologia.length, 5);
  assert.ok(metodologia.every((c) => c.year === "Primer año"));
  assert.deepEqual(metodologia.map((c) => c.group), ["A", "B", "C", "D", "E"]);
  // El año cambia con las cabeceras del select.
  const segundo = catalog.find((c) => c.code === "2502225");
  assert.equal(segundo?.year, "Segundo año");
  const tercero = catalog.find((c) => c.code === "1705267");
  assert.equal(tercero?.year, "Tercer año");
  // El (A) del final del nombre se separa como sección, no se queda en el nombre.
  assert.ok(catalog.every((c) => !/\([A-Z]\)$/.test(c.name)));
  // La cabecera del listado trae también la escuela.
  assert.equal(parseSchoolName(fixture("catalogo.html")), "ECONOMÍA");
});

test("listado de aulas: código interno + nombre legible", () => {
  const aulas = parseAulaList(fixture("aulas.html"));

  assert.equal(aulas.length, 15);
  assert.deepEqual(aulas[0], { code: "15446", name: "40.1-105/AULA 105 AFORO REAL 55" });
  assert.equal(aulas[14].name, "Aula: 48.1.305 / AULA 305(Interfac/TURISMO Y HOTELERIA)CI_f");
  assert.ok(aulas.every((a) => /^\d+$/.test(a.code)));
});