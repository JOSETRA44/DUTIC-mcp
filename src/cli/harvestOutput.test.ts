import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Contrato de `--json`: por stdout sale JSON y NADA más.
 *
 * El workflow del barrido hace `dutic lib harvest --json | tee resultado.json` y luego lo
 * parsea. Cuando el banner se imprimía en stdout, ese archivo empezaba por el marco de la
 * tabla y el job moría con `Unexpected token '┌'`. Este test ejecuta el CLI de verdad,
 * porque el fallo estaba justamente en QUÉ flujo recibe cada cosa: un test que llame a las
 * funciones por dentro no lo habría visto.
 */

const CLI = join(process.cwd(), "dist", "cli", "index.js");

/** Corre el CLI aislado del entorno real (sin token, sin caché del usuario). */
async function cli(args: string[]) {
  return run(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      DUTIC_LIBRARY_INGEST_TOKEN: "",
      DUTIC_NO_CACHE: "1",
      // Sin colores: los códigos ANSI también ensuciarían stdout.
      NO_COLOR: "1",
    },
    timeout: 60_000,
  }).catch((err: Error & { stdout?: string; stderr?: string }) => ({
    stdout: err.stdout ?? "",
    stderr: err.stderr ?? "",
  }));
}

test("lib harvest --json: stdout es JSON puro aunque falte el token", async (t) => {
  if (!existsSync(CLI)) return t.skip("hace falta `npm run build`");

  const { stdout, stderr } = await cli(["lib", "harvest", "--json"]);

  // Lo que rompía el workflow: cualquier adorno antes del JSON.
  assert.doesNotMatch(stdout, /[┌│└]/, "el banner no debe salir por stdout en modo --json");
  const parsed = JSON.parse(stdout);
  assert.equal(typeof parsed.error, "string");
  assert.match(parsed.error, /DUTIC_LIBRARY_INGEST_TOKEN/);

  // La explicación para el humano sigue existiendo, pero por stderr.
  assert.match(stderr, /mint-harvest-token/);
});

test("lib harvest sin --json: el banner sí sale por stdout", async (t) => {
  if (!existsSync(CLI)) return t.skip("hace falta `npm run build`");

  const { stdout } = await cli(["lib", "harvest"]);
  assert.match(stdout, /Falta DUTIC_LIBRARY_INGEST_TOKEN/);
  assert.throws(() => JSON.parse(stdout));
});
