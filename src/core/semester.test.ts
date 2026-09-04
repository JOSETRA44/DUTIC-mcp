import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  compareSemesters,
  defaultMatriculaPath,
  formatSemesterLabel,
  inferSemesterFromDate,
  latestSemester,
  nextSemester,
  normalizeSemester,
  parseSemester,
  prevSemester,
  semesterFromUrl,
  semesterRange,
  sortSemesters,
} from "./semester.js";

/**
 * El semestre es puro, así que se prueba entero sin red ni disco. Lo que se verifica aquí no son
 * detalles de formato sino las tres cosas de las que depende el aislamiento multi-semestre:
 * que dos escrituras distintas del mismo período colapsen al MISMO id (o dos directorios de datos
 * acabarían representando el mismo ciclo), que el orden cronológico sea correcto, y que lo que
 * dice el servidor gane a lo que diga la configuración.
 */

test("normaliza todas las formas en que se escribe un mismo período", () => {
  for (const raw of ["2026A", "2026a", "2026-A", "2026 a", "2026_a", "2026I", "2026-I"]) {
    assert.equal(normalizeSemester(raw), "2026A", `falló con "${raw}"`);
  }
  for (const raw of ["2026B", "2026b", "2026-B", "2026II", "2026-ii"]) {
    assert.equal(normalizeSemester(raw), "2026B", `falló con "${raw}"`);
  }
});

test("rechaza lo que no es un semestre", () => {
  for (const raw of ["", "2026", "26A", "2026C", "abc", "20261A", "1999A", null, undefined]) {
    assert.equal(normalizeSemester(raw as string), null, `aceptó "${raw}"`);
  }
});

test("parseSemester separa año y mitad", () => {
  assert.deepEqual(parseSemester("2025-b"), { year: 2025, half: "B" });
  assert.equal(parseSemester("2025C"), null);
});

test("ordena cronológicamente, no alfabéticamente", () => {
  const shuffled = ["2026B", "2025A", "2026A", "2024B"];
  assert.deepEqual(sortSemesters(shuffled), ["2024B", "2025A", "2026A", "2026B"]);
  assert.ok(compareSemesters("2025B", "2026A") < 0);
  assert.equal(compareSemesters("2026A", "2026A"), 0);
  assert.equal(latestSemester(shuffled), "2026B");
  assert.equal(latestSemester([]), null);
});

test("avanza y retrocede cruzando el cambio de año", () => {
  assert.equal(nextSemester("2026A"), "2026B");
  assert.equal(nextSemester("2026B"), "2027A");
  assert.equal(prevSemester("2026A"), "2025B");
  assert.equal(prevSemester("2026B"), "2026A");
});

test("semesterRange cubre los extremos y tolera el orden invertido", () => {
  assert.deepEqual(semesterRange("2025A", "2026A"), ["2025A", "2025B", "2026A"]);
  assert.deepEqual(semesterRange("2026A", "2025A"), ["2025A", "2025B", "2026A"]);
  assert.deepEqual(semesterRange("2026A", "2026A"), ["2026A"]);
  assert.deepEqual(semesterRange("basura", "2026A"), []);
});

test("infiere el período según el calendario de la UNSA", () => {
  // Marzo–julio: primera mitad.
  assert.equal(inferSemesterFromDate(new Date("2026-03-15T12:00:00")), "2026A");
  assert.equal(inferSemesterFromDate(new Date("2026-07-31T12:00:00")), "2026A");
  // Agosto–diciembre: segunda mitad.
  assert.equal(inferSemesterFromDate(new Date("2026-08-01T12:00:00")), "2026B");
  assert.equal(inferSemesterFromDate(new Date("2026-12-20T12:00:00")), "2026B");
  // Enero y febrero son vacaciones: el último ciclo con datos es el B del año anterior, no un
  // "2026A" que todavía no ha empezado y cuya aula puede ni existir.
  assert.equal(inferSemesterFromDate(new Date("2026-01-10T12:00:00")), "2025B");
  assert.equal(inferSemesterFromDate(new Date("2026-02-28T12:00:00")), "2025B");
});

test("extrae el semestre de una URL del aula (la fuente que manda)", () => {
  assert.equal(semesterFromUrl("https://aulavirtual.unsa.edu.pe/2026A/my"), "2026A");
  assert.equal(semesterFromUrl("https://aulavirtual.unsa.edu.pe/2026a"), "2026A");
  assert.equal(semesterFromUrl("https://aulavirtual.unsa.edu.pe/2025B/course/view.php?id=1"), "2025B");
  assert.equal(semesterFromUrl("https://aulavirtual.unsa.edu.pe/my"), null);
  assert.equal(semesterFromUrl(null), null);
});

test("deriva la carpeta de matrícula de SISACAD sin configuración manual", () => {
  assert.equal(defaultMatriculaPath("2026B"), "matr_int_2026b_v2.00");
  assert.equal(defaultMatriculaPath("2025A"), "matr_int_2025a_v2.00");
});

test("la etiqueta legible no se usa nunca como identificador", () => {
  assert.equal(formatSemesterLabel("2026A"), "2026-A");
  // Un id ilegible se devuelve tal cual en vez de reventar: es texto para mostrar.
  assert.equal(formatSemesterLabel("basura"), "basura");
});
