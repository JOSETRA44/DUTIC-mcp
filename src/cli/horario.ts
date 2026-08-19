import type { Command } from "commander";
import { createInterface } from "node:readline";
import {
  loadHorarioCache,
  resolveSisacadLogin,
  saveHorarioCache,
  saveSisacadLogin,
} from "../core/horarioStore.js";
import { resolveEscuelaCode, sisacadLogin } from "../core/sisacadClient.js";
import { DAYS, getHorario, type Horario } from "../domain/horario.js";
import { banner, c, mark, rule, statusLine, table } from "./ui.js";

const out = (msg = "") => process.stdout.write(msg + "\n");
const log = (msg: string) => process.stderr.write(msg + "\n");

/** Lee una contraseña por stdin sin eco. Se cae con elegancia si no hay TTY. */
async function promptHidden(question: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    throw new Error(
      "No hay terminal interactiva para pedir la clave. Usa --clave, " +
        "o exporta DUTIC_SISACAD_USER, DUTIC_SISACAD_PASSWORD y DUTIC_SISACAD_ESCUELA.",
    );
  }
  const rl = createInterface({ input, output: process.stderr, terminal: true });
  const rlAny = rl as unknown as { _writeToOutput?: (s: string) => void; output: NodeJS.WriteStream };
  let muted = false;
  rlAny._writeToOutput = (s: string) => {
    if (!muted) rlAny.output.write(s);
  };
  const answer = await new Promise<string>((resolve) => {
    rl.question(question, (a) => resolve(a));
    muted = true;
  });
  muted = false;
  rl.close();
  process.stderr.write("\n");
  return answer;
}

function renderHorario(horario: Horario): void {
  const subtitle = [horario.cui, horario.name, horario.school].filter(Boolean).join(" · ");
  out(banner("Horario", subtitle));
  if (horario.blocks.length === 0) {
    out(`${mark.warn()} El horario está vacío (¿semana sin clases registradas?).`);
    return;
  }
  for (const day of DAYS) {
    const blocks = horario.blocks
      .filter((b) => b.day === day)
      .sort((a, b) => a.start.localeCompare(b.start));
    if (blocks.length === 0) continue;
    out("\n" + rule(day));
    out(
      table(
        [
          { header: "hora", align: "right" },
          { header: "curso" },
          { header: "aula", color: c.dim },
        ],
        blocks.map((b) => [`${b.start}-${b.end}`, b.subject, b.location ?? "—"]),
      ),
    );
  }
}

/** Descarga y guarda en caché. El renderizado depende del formato pedido (tabla o JSON). */
async function fetchAndSave(
  cui: string | undefined,
  opts: { depe?: string; espe?: string },
): Promise<Horario> {
  const status = statusLine();
  status.set("consultando horario en el sistema de matrícula…");
  const horario = await getHorario({ cui, depe: opts.depe, espe: opts.espe });
  status.done();
  await saveHorarioCache({ fetchedAt: Date.now(), horario });
  return horario;
}

export function registerHorarioCommands(program: Command): void {
  const hrs = program
    .command("hrs")
    .description(
      "Horario de clases del sistema de matrícula (extranet UNSA). `dutic hrs` muestra el tuyo; " +
        "`dutic hrs <CUI>` el de ese alumno. Requiere `dutic hrs login` una vez.",
    )
    .argument("[cui]", "CUI del alumno (por defecto, el tuyo).")
    .option("--json", "Salida en JSON.")
    .option("--depe <codigo>", "Código de dependencia/escuela para el horario (por defecto el del login).")
    .option("--espe <codigo>", "Parámetro espe (por defecto el del login).")
    .action(async (cui: string | undefined, opts) => {
      try {
        const horario = await fetchAndSave(cui, opts);
        if (opts.json) {
          out(JSON.stringify(horario, null, 2));
        } else {
          renderHorario(horario);
        }
      } catch (err) {
        out(`${mark.err()} ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  hrs
    .command("login")
    .description(
      "Guarda y verifica tus credenciales del sistema de matrícula (usuario de 8 letras, clave " +
        "de 8 dígitos y Escuela/Programa, p.ej. ECONOMÍA o su código 4700).",
    )
    .option("--usuario <usuario>", "Usuario de matrícula (8 letras).")
    .option("--clave <clave>", "Clave (8 dígitos). Si se omite, se pide por teclado sin eco.")
    .option("--escuela <escuela>", "Escuela/Programa: nombre (ECONOMÍA) o código (4700).")
    .action(async (opts) => {
      let saved = false;
      try {
        const user = opts.usuario ?? (await promptHidden("Usuario: "));
        const password = opts.clave ?? (await promptHidden("Clave (no se mostrará): "));
        const escuelaInput = opts.escuela ?? (await promptHidden("Escuela/Programa: "));
        if (!user || !password || !escuelaInput) {
          out(`${mark.err()} Usuario, clave y escuela son obligatorios.`);
          process.exitCode = 1;
          return;
        }

        // El código de escuela se valida (y normaliza) ANTES de guardar nada.
        const escuela = await resolveEscuelaCode(escuelaInput);
        await saveSisacadLogin({ user, password, escuela });
        saved = true;

        const status = statusLine();
        status.set("verificando credenciales…");
        const session = await sisacadLogin({ user, password, escuela });
        status.done();
        out(`${mark.ok()} Credenciales verificadas y guardadas con permisos restringidos.`);
        out(c.dim(`    ${session.cui} · ${session.name} · ${session.school}`));
        out(c.dim("    Siguiente paso: dutic hrs"));
      } catch (err) {
        out(`${mark.err()} ${(err as Error).message}`);
        if (saved) {
          out(c.dim("    Se guardaron de todos modos; corrígelas con `dutic hrs login`."));
        } else {
          out(c.dim("    No se guardó nada. Revisa los datos e inténtalo de nuevo."));
        }
        process.exitCode = 1;
      }
    });

  hrs
    .command("show")
    .description("Muestra el último horario descargado (sin consultar el sistema).")
    .option("--json", "Salida en JSON.")
    .action(async (opts) => {
      const cache = await loadHorarioCache();
      if (!cache) {
        out(`${mark.warn()} No hay horario guardado. Ejecuta ${c.cyan("dutic hrs")}.`);
        return;
      }
      if (opts.json) {
        out(JSON.stringify(cache.horario, null, 2));
        return;
      }
      log(c.dim(`capturado ${new Date(cache.fetchedAt).toLocaleString("es-PE")}`));
      renderHorario(cache.horario);
    });

  hrs
    .command("status")
    .description("Estado: credenciales guardadas y horario en caché.")
    .option("--json", "Salida en JSON.")
    .action(async (opts) => {
      const creds = await resolveSisacadLogin();
      const cache = await loadHorarioCache();
      if (opts.json) {
        out(
          JSON.stringify(
            {
              hasCredentials: !!creds,
              cached: !!cache,
              cachedAt: cache?.fetchedAt ?? null,
            },
            null,
            2,
          ),
        );
        return;
      }
      out(banner("Horarios · estado"));
      out(
        `${creds ? mark.ok() : mark.err()} Credenciales de matrícula: ` +
          (creds ? "guardadas" : `no configuradas — corre ${c.cyan("dutic hrs login")}`),
      );
      out(
        `${cache ? mark.ok() : mark.warn()} Horario en caché: ` +
          (cache
            ? `${cache.horario.cui} · ${new Date(cache.fetchedAt).toLocaleString("es-PE")}`
            : `ninguno — corre ${c.cyan("dutic hrs")}`),
      );
    });
}