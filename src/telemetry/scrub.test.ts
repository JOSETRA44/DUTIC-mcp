import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MAX_MESSAGE_LENGTH, redactPersonal, redactSecrets, scrub } from "./scrub.js";

/**
 * Pruebas del saneado. Si alguna falla, la telemetría filtraría credenciales o datos de una
 * persona: son el contrato que permite tener `PERSONAL_POLICY_READY = true`.
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

// ── Nivel 2: datos personales y académicos ────────────────────────────────────────

test("personal: los correos no salen del equipo", () => {
  const out = redactPersonal("No se encontró el perfil de ana.perez@unsa.edu.pe");
  assert.equal(out, "No se encontró el perfil de <correo>");
});

test("personal: el número de WhatsApp de un jid tampoco", () => {
  const out = redactPersonal("no se pudo enviar a 51987654321@s.whatsapp.net");
  assert.ok(!out.includes("51987654321"), out);
});

test("personal: el id de una persona en una URL no sale del equipo", () => {
  const out = redactPersonal("HTTP 404 en /2026B/user/view.php?id=10432&course=2911");
  assert.ok(out.includes("id=<persona>"), out);
  assert.ok(out.includes("course=2911"), "el curso sí se conserva: reproduce el fallo");
});

test("personal: parámetros con nombre de persona, en cualquier orden", () => {
  assert.ok(redactPersonal("scan userid=13263 ok").includes("userid=<persona>"));
  assert.ok(redactPersonal("payload {moodle_user_id=12048}").includes("moodle_user_id=<persona>"));
});

test("personal: los números largos sueltos (DNI, CUI, teléfono) no salen", () => {
  assert.equal(redactPersonal("Participante 70412345 sin correo"), "Participante <numero> sin correo");
});

test("personal: lo que reproduce el fallo se conserva", () => {
  const out = redactPersonal('HTTP 500 en /2026B/mod/assign/view.php?id=64821 — "Informe final" sin fecha');
  assert.ok(out.includes("id=64821"), "el cmid de una tarea no señala a nadie");
  assert.ok(out.includes('"Informe final"'), "el nombre de la tarea explica el fallo");
});

test("personal: el id de un curso de 4-6 cifras sobrevive", () => {
  assert.equal(redactPersonal("course/view.php?id=2279"), "course/view.php?id=2279");
});
