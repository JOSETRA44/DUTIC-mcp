import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MAX_MESSAGE_LENGTH, redactPersonal, redactSecrets, scrub } from "./scrub.js";

/**
 * Pruebas del saneado. Las de secretos son obligatorias: si alguna falla, la telemetría
 * filtraría credenciales. Las de datos personales están como `todo` hasta decidir la política.
 */

const HOME = "C:\\Users\\ana";

test("secretos: sesskey en una URL", () => {
  const out = redactSecrets("GET /lib/ajax/service.php?sesskey=Ab12Cd34Ef&info=core", HOME);
  assert.equal(out, "GET /lib/ajax/service.php?sesskey=<redacted>&info=core");
});

test("secretos: cookie MoodleSession y PHPSESSID", () => {
  const out = redactSecrets("Cookie: MoodleSession=q9w8e7r6t5; PHPSESSID=zzz111", HOME);
  assert.ok(!out.includes("q9w8e7r6t5") && !out.includes("zzz111"), out);
});

test("secretos: JWT y cabecera Bearer", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  const out = redactSecrets(`Authorization: Bearer ${jwt} y suelto ${jwt}`, HOME);
  assert.ok(!out.includes("dozjgNryP4J3"), out);
});

test("secretos: credencial de instalación y campos con nombre de secreto", () => {
  const out = redactSecrets('DUTIC-Install 4f1c.s3cr3t {"enrollToken":"AAAABBBBCCCC","clave":"hunter2"}', HOME);
  assert.ok(!out.includes("s3cr3t") && !out.includes("AAAABBBBCCCC") && !out.includes("hunter2"), out);
});

test("secretos: carpeta personal con ambos separadores", () => {
  const out = redactSecrets(
    "at load (C:\\Users\\ana\\AppData\\npm\\dist\\core\\http.js:40) | file:///C:/Users/ana/.dutic/session.json",
    HOME,
  );
  assert.ok(!/ana/i.test(out), out);
  assert.ok(out.includes("~\\AppData") && out.includes("~/.dutic"), out);
});

test("scrub: recorta al largo máximo y acepta cualquier valor", () => {
  assert.equal(scrub("x".repeat(10_000), HOME).length, MAX_MESSAGE_LENGTH);
  assert.equal(scrub(undefined, HOME), "");
  assert.equal(scrub(new Error("boom"), HOME), "Error: boom");
});

test("scrub: un secreto largo cerca del límite no se filtra a medias", () => {
  const out = scrub(`${"a".repeat(480)} sesskey=${"Z".repeat(60)}`, HOME);
  assert.ok(!out.includes("ZZZZ"), out);
});

// ── Nivel 2: activa (quita `todo`) los que describan la política que implementes ──

test("personal: los correos no salen del equipo", { todo: true }, () => {
  assert.ok(!redactPersonal("No se encontró el perfil de ana.perez@unsa.edu.pe").includes("ana.perez"));
});

test("personal: el id de una persona en una URL no sale del equipo", { todo: true }, () => {
  assert.ok(!redactPersonal("HTTP 404 en /2026B/user/view.php?id=10432&course=2911").includes("10432"));
});

test("personal: los números largos sueltos (DNI, CUI, teléfono) no salen", { todo: true }, () => {
  assert.ok(!redactPersonal("Participante 70412345 sin correo").includes("70412345"));
});
