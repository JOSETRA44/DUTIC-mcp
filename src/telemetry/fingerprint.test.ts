import { strict as assert } from "node:assert";
import { test } from "node:test";
import { identifyError, normalizeFrames } from "./fingerprint.js";

const ROOT = "C:\\Users\\ana\\AppData\\Roaming\\npm\\node_modules\\@josetra\\dutic-mcp";

function stackFor(dir: "dist" | "src", line: number): string {
  const ext = dir === "dist" ? "js" : "ts";
  return [
    "SessionExpiredError: La sesión de Moodle caducó",
    `    at fetchUnsa (${ROOT}\\${dir}\\core\\http.${ext}:${line}:11)`,
    `    at async getHtml (file:///${ROOT.replace(/\\/g, "/")}/${dir}/core/moodleClient.${ext}:${line + 7}:3)`,
    `    at Object.request (${ROOT}\\node_modules\\undici\\lib\\api.js:90:5)`,
    "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
  ].join("\n");
}

test("marcos: sólo código propio, sin líneas, dist y src igualados", () => {
  assert.deepEqual(normalizeFrames(stackFor("dist", 58), ROOT), [
    "fetchUnsa@core/http",
    "getHtml@core/moodleClient",
  ]);
  assert.deepEqual(normalizeFrames(stackFor("src", 12), ROOT), normalizeFrames(stackFor("dist", 58), ROOT));
});

test("huella estable entre versiones, distinta entre fallos", () => {
  const a = Object.assign(new Error("sesión caducada para 10432"), { name: "SessionExpiredError", stack: stackFor("dist", 58) });
  const b = Object.assign(new Error("sesión caducada para 20877"), { name: "SessionExpiredError", stack: stackFor("src", 61) });
  const c = Object.assign(new Error("otra cosa"), { name: "NetworkError", stack: stackFor("dist", 58) });

  assert.equal(identifyError(a, ROOT).fingerprint, identifyError(b, ROOT).fingerprint);
  assert.notEqual(identifyError(a, ROOT).fingerprint, identifyError(c, ROOT).fingerprint);
  assert.match(identifyError(a, ROOT).fingerprint, /^[0-9a-f]{64}$/);
});

test("códigos de Moodle y de sistema, saneados", () => {
  const moodle = Object.assign(new Error("x"), { name: "MoodleApiError", moodleErrorCode: "servicenotavailable" });
  const sys = Object.assign(new Error("x"), { code: "UND_ERR_CONNECT_TIMEOUT" });
  const weird = Object.assign(new Error("x"), { code: "a b/c" });

  assert.equal(identifyError(moodle, ROOT).code, "servicenotavailable");
  assert.equal(identifyError(sys, ROOT).code, "UND_ERR_CONNECT_TIMEOUT");
  assert.equal(identifyError(weird, ROOT).code, "a_b_c");
});

test("valores lanzados que no son Error", () => {
  assert.equal(identifyError("texto", ROOT).errorClass, "string");
  assert.equal(identifyError(null, ROOT).errorClass, "object");
  assert.equal(identifyError({ name: "no válido con espacios" }, ROOT).errorClass, "Object");
});
