import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

/**
 * Pruebas de la resolución de contexto y de la migración del layout plano. Tocan disco (un
 * directorio temporal) pero nunca la red.
 *
 * `DATA_DIR` se fija al CARGAR el módulo y en ESM no hay forma limpia de recargar el grafo entero
 * —reimportar con `?v=N` sólo invalida el módulo pedido, no sus dependencias—, así que el
 * directorio temporal se prepara ANTES del primer import y los casos controlan el estado del
 * registro entre sí en vez de fingir que arrancan de cero.
 */

const ROOT = mkdtempSync(join(tmpdir(), "dutic-test-"));
process.env.DUTIC_DATA_DIR = ROOT;
delete process.env.DUTIC_SEMESTER;

const { contextFor, resolveSemesterId } = await import("./context.js");
const { clearActiveSemester, setActiveSemester } = await import("./registry.js");
const { migrateLegacyLayout, scopedPaths } = await import("./paths.js");
const { loadSession } = await import("./session.js");

beforeEach(() => {
  clearActiveSemester();
  delete process.env.DUTIC_SEMESTER;
});

after(() => rmSync(ROOT, { recursive: true, force: true }));

test("un override explícito gana a todo lo demás", () => {
  setActiveSemester("2026B");
  process.env.DUTIC_SEMESTER = "2025A";

  const { id, source } = resolveSemesterId("2024-B");
  assert.equal(id, "2024B");
  assert.equal(source, "override");
});

test("sin override, el entorno gana al activo guardado", () => {
  setActiveSemester("2026B");
  process.env.DUTIC_SEMESTER = "2025A";

  const { id, source } = resolveSemesterId();
  assert.equal(id, "2025A");
  assert.equal(source, "env");
});

test("sin override ni entorno, manda el semestre activo del registro", () => {
  setActiveSemester("2026B");

  const { id, source } = resolveSemesterId();
  assert.equal(id, "2026B");
  assert.equal(source, "registry");
});

test("sin nada configurado, se deduce de la fecha", () => {
  const { id, source } = resolveSemesterId();
  assert.equal(source, "inferred");
  assert.match(id, /^\d{4}[AB]$/);
});

test("un override ilegible no secuestra la resolución: se cae al siguiente nivel", () => {
  setActiveSemester("2026B");
  // Una tool MCP puede recibir `semester: "el ciclo pasado"` de un modelo. Eso no debe
  // convertirse en un directorio con ese nombre ni reventar: simplemente no cuenta como override.
  const { id, source } = resolveSemesterId("el ciclo pasado");
  assert.equal(id, "2026B");
  assert.equal(source, "registry");
});

test("cada semestre tiene su propio directorio de estado", () => {
  const a = contextFor("2026A");
  const b = contextFor("2026B");

  assert.notEqual(a.paths.session, b.paths.session);
  assert.ok(a.paths.session.startsWith(join(ROOT, "semesters", "2026A")));
  assert.ok(b.paths.cacheDir.startsWith(join(ROOT, "semesters", "2026B")));
  // La carpeta de matrícula de SISACAD se deriva del período, no de una constante compartida.
  assert.ok(a.matriculaBase.endsWith("matr_int_2026a_v2.00"));
  assert.ok(b.matriculaBase.endsWith("matr_int_2026b_v2.00"));
});

test("la sesión guardada decide el semestre cuando no hay nada configurado", () => {
  const ctx = contextFor("2025B");
  mkdirSync(ctx.paths.dir, { recursive: true });
  writeFileSync(ctx.paths.session, JSON.stringify({ siteUrl: ctx.siteUrl }));
  setActiveSemester("2025B");

  // Con el activo apuntando ahí, la resolución lo confirma contra el disco.
  assert.equal(resolveSemesterId().id, "2025B");
  rmSync(ctx.paths.dir, { recursive: true, force: true });
});

test("el layout plano anterior se mueve al directorio del semestre", () => {
  // Estado de la versión anterior: todo plano en la raíz de ~/.dutic.
  writeFileSync(
    join(ROOT, "session.json"),
    JSON.stringify({
      moodleSession: "abc",
      sesskey: "xyz",
      siteUrl: "https://aulavirtual.unsa.edu.pe/2025B",
      capturedAt: Date.now(),
    }),
  );
  writeFileSync(join(ROOT, "courses-db.json"), JSON.stringify({ 42: { id: 42 } }));
  writeFileSync(join(ROOT, "snapshot.json"), JSON.stringify({ takenAt: 1, tasks: {}, grades: {} }));

  const moved = migrateLegacyLayout("2025B");
  assert.deepEqual(moved.sort(), ["courses-db.json", "session.json", "snapshot.json"]);

  const paths = scopedPaths("2025B");
  assert.ok(existsSync(paths.session), "la sesión debe acabar en el directorio del semestre");
  assert.ok(existsSync(paths.coursesDb));
  assert.ok(!existsSync(join(ROOT, "session.json")), "no debe quedar copia en la raíz");

  // Idempotente: una segunda pasada no vuelve a mover nada.
  assert.deepEqual(migrateLegacyLayout("2025B"), []);
});

test("una sesión colocada en el semestre equivocado no se acepta", async () => {
  const ctx = contextFor("2026A");
  mkdirSync(ctx.paths.dir, { recursive: true });
  // Sesión de 2025B archivada bajo 2026A (copia manual, restore de backup): usarla devolvería
  // datos del período ajeno sin ningún aviso, así que se descarta.
  writeFileSync(
    ctx.paths.session,
    JSON.stringify({
      moodleSession: "abc",
      sesskey: "xyz",
      siteUrl: "https://aulavirtual.unsa.edu.pe/2025B",
      capturedAt: Date.now(),
    }),
  );

  assert.equal(await loadSession(ctx), null);

  // La misma sesión bajo su propio semestre sí se lee.
  const right = contextFor("2025B");
  mkdirSync(right.paths.dir, { recursive: true });
  writeFileSync(
    right.paths.session,
    JSON.stringify({
      moodleSession: "abc",
      sesskey: "xyz",
      siteUrl: "https://aulavirtual.unsa.edu.pe/2025B",
      capturedAt: Date.now(),
    }),
  );
  const loaded = await loadSession(right);
  assert.equal(loaded?.moodleSession, "abc");
});
