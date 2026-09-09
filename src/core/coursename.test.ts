import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseCourseName, sameCourse } from "./coursename.js";

/**
 * El prefijo de Escuela es una ABREVIATURA que la OTI elige, no el nombre de la categoría, y
 * varía en forma: una palabra, con diéresis, con acentos o sin ellos. Lo que se prueba aquí es
 * que el prefijo desaparezca siempre, porque `subject` alimenta la comparación entre cursos.
 */

test("quita el prefijo de período y Escuela en todas sus formas", () => {
  const casos: [string, string, string | null][] = [
    ["26A ECONOMÍA: ESTADÍSTICA PARA ECONOMISTAS III GA", "ESTADÍSTICA PARA ECONOMISTAS III", "Grupo A"],
    ["26B SISTEMAS: MATEMÁTICA BÁSICA GC", "MATEMÁTICA BÁSICA", "Grupo C"],
    // La diéresis rompía el parser: el prefijo se quedaba pegado a la asignatura.
    ["26B LINGÜÍSTICA: PORTUGUÉS TÉCNICO (E) GA", "PORTUGUÉS TÉCNICO (E)", "Grupo A"],
    ["26B ECONOMA: ECOLOGA Y CONSERVACIN AMBIENTAL GA", "ECOLOGA Y CONSERVACIN AMBIENTAL", "Grupo A"],
    ["26B SISTEMAS: ASPECTOS FORMALES FUSION A-C", "ASPECTOS FORMALES FUSION A-C", null],
  ];
  for (const [full, subject, group] of casos) {
    const p = parseCourseName(full);
    assert.equal(p.subject, subject, `asignatura de "${full}"`);
    assert.equal(p.group, group, `grupo de "${full}"`);
  }
});

test("un nombre sin prefijo de período se deja intacto", () => {
  // Sin el ancla "26B" delante, un ":' del propio título no debe activar el recorte.
  const p = parseCourseName("SEMINARIO: METODOLOGÍA DE LA INVESTIGACIÓN");
  assert.equal(p.subject, "SEMINARIO: METODOLOGÍA DE LA INVESTIGACIÓN");
});

test("la misma asignatura con y sin acentos es la misma", () => {
  assert.ok(sameCourse("26B ECONOMÍA: ECOLOGÍA GA", "26B ECONOMA: ECOLOGA GB"));
  assert.ok(!sameCourse("26B ECONOMÍA: ESTADÍSTICA II GA", "26B ECONOMÍA: ESTADÍSTICA III GA"));
});
