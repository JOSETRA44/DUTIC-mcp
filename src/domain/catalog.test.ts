import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  categoryPath,
  dominantPrefix,
  findCategories,
  groupByTeacher,
  type CategoryTree,
  type SchoolCourses,
} from "./catalog.js";

/** Recorte del árbol real de 2026-B: raíz → período → área → Escuela. */
const TREE: CategoryTree = {
  fetchedAt: 0,
  categories: [
    { id: 2, name: "2026-B", parentId: null, depth: 1 },
    { id: 4, name: "INGENIERÍAS", parentId: 2, depth: 2 },
    { id: 5, name: "SOCIALES", parentId: 2, depth: 2 },
    { id: 20, name: "INGENIERÍA DE SISTEMAS", parentId: 4, depth: 3 },
    { id: 41, name: "ECONOMÍA", parentId: 5, depth: 3 },
    { id: 46, name: "LITERATURA Y LINGÜÍSTICA", parentId: 5, depth: 3 },
  ],
};

test("el prefijo de búsqueda sale de los cursos, no del nombre de la Escuela", () => {
  // Éste es el hallazgo que hace funcionar el enriquecimiento: la abreviatura que la OTI pone
  // delante NO coincide con la categoría, así que deducirla del nombre de la Escuela fallaría.
  assert.equal(
    dominantPrefix([
      "26B SISTEMAS: MATEMÁTICA BÁSICA GC",
      "26B SISTEMAS: POLÍTICAS PÚBLICAS GA",
      "26B SISTEMAS: ECOLOGÍA GC",
    ]),
    "26B SISTEMAS",
  );
  assert.equal(dominantPrefix(["26B LINGÜÍSTICA: PORTUGUÉS TÉCNICO (E) GA"]), "26B LINGÜÍSTICA");
});

test("un curso suelto con otro prefijo no secuestra la búsqueda", () => {
  const nombres = [
    "26B ECONOMÍA: DOCTRINAS ECONÓMICAS GA",
    "26B ECONOMÍA: DOCTRINAS ECONÓMICAS GB",
    "26B GESTION: TALLER COMPARTIDO GA",
  ];
  assert.equal(dominantPrefix(nombres), "26B ECONOMÍA");
});

test("sin prefijos reconocibles no se inventa uno", () => {
  assert.equal(dominantPrefix(["CURSO LIBRE", "OTRO CURSO"]), null);
});

test("buscar Escuela prioriza la Escuela sobre el área que la contiene", () => {
  assert.deepEqual(
    findCategories(TREE, "sistemas").map((c) => c.id),
    [20],
  );
  // Sin acentos y por trozo: es como escribe la gente.
  assert.deepEqual(
    findCategories(TREE, "linguistica").map((c) => c.id),
    [46],
  );
  assert.deepEqual(
    findCategories(TREE, "41").map((c) => c.name),
    ["ECONOMÍA"],
  );
  // "SOCIALES" es área y no debe quedar por delante de ninguna Escuela que también coincida.
  assert.equal(findCategories(TREE, "sociales")[0].id, 5);
  assert.deepEqual(findCategories(TREE, "veterinaria"), []);
});

test("la ruta se lee de la raíz hacia abajo", () => {
  assert.deepEqual(categoryPath(TREE, 41), ["2026-B", "SOCIALES", "ECONOMÍA"]);
  assert.deepEqual(categoryPath(TREE, 2), ["2026-B"]);
  assert.deepEqual(categoryPath(TREE, 999), []);
});

test("agrupar por docente ordena por carga y no pierde los cursos sin profesor", () => {
  const school = {
    courses: [
      { id: 1, fullname: "A GA", subject: "A", group: "Grupo A", url: "u1", teachers: [{ id: 9, name: "ANA", role: "Profesor" }] },
      { id: 2, fullname: "B GA", subject: "B", group: "Grupo A", url: "u2", teachers: [{ id: 9, name: "ANA", role: "Profesor" }] },
      { id: 3, fullname: "C GA", subject: "C", group: "Grupo A", url: "u3", teachers: [{ id: 7, name: "BETO", role: "Profesor" }] },
      { id: 4, fullname: "D GA", subject: "D", group: "Grupo A", url: "u4", teachers: [] },
    ],
  } as unknown as SchoolCourses;

  const grupos = groupByTeacher(school);
  assert.deepEqual(
    grupos.map((g) => [g.teacher.name, g.courses.length]),
    [
      ["ANA", 2],
      ["BETO", 1],
    ],
  );
  // El curso sin docente no aparece aquí; se cuenta aparte en `withTeachers`.
  assert.equal(
    grupos.flatMap((g) => g.courses).some((c) => c.id === 4),
    false,
  );
});
