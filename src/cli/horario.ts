import type { Command } from "commander";
import { createInterface } from "node:readline";
import {
  loadHorarioCache,
  resolveSisacadLogin,
  saveHorarioCache,
  saveSisacadLogin,
} from "../core/horarioStore.js";
import { resolveEscuelaCode, sisacadLogin } from "../core/sisacadClient.js";
import {
  DAYS,
  getAulaList,
  getAulaSchedule,
  getCourseCatalog,
  getHorario,
  getSubjectSchedule,
  type Horario,
} from "../domain/horario.js";
import { banner, c, mark, parentOpts, rule, statusLine, table } from "./ui.js";

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
  const subtitle = [horario.code, horario.label, horario.cui, horario.name, horario.school]
    .filter(Boolean)
    .join(" · ");
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
        blocks.map((b) => [
          `${b.start}-${b.end}`,
          b.group ? `${b.subject} ${c.dim(`(${b.group})`)}` : b.subject,
          b.location ?? "—",
        ]),
      ),
    );
  }
}

/** Descarga y guarda en caché. El renderizado depende del formato pedido (tabla o JSON). */
async function fetchAndSave(
  cui: string | undefined,
  opts: { depe?: string; escuela?: string; espe?: string },
): Promise<Horario> {
  const status = statusLine();
  status.set("consultando horario en el sistema de matrícula…");
  const horario = await getHorario({ cui, depe: opts.depe, escuela: opts.escuela, espe: opts.espe });
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
    .option(
      "--escuela <nombre|codigo>",
      "Otra Escuela/Programa por nombre (BIOLOGÍA) o código (4020); su depe se deriva solo.",
    )
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
    .action(async (opts, cmd) => {
      const cache = await loadHorarioCache();
      if (!cache) {
        out(`${mark.warn()} No hay horario guardado. Ejecuta ${c.cyan("dutic hrs")}.`);
        return;
      }
      if (opts.json || parentOpts(cmd).json) {
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
    .action(async (opts, cmd) => {
      const creds = await resolveSisacadLogin();
      const cache = await loadHorarioCache();
      if (opts.json || parentOpts(cmd).json) {
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

  hrs
    .command("courses")
    .description(
      "Oferta de asignaturas del ciclo de una escuela (todas las secciones, por año). " +
        "`dutic hrs courses <codigo>` muestra el horario semanal de esa asignatura-sección.",
    )
    .argument("[codigo]", "Código de asignatura: '2501209A' (con sección) o '2501209' (se resuelve).")
    .option("--json", "Salida en JSON.")
    .option(
      "--depe <codigo>",
      "Código de dependencia/escuela para el horario (por defecto el del login, p.ej. 470 = ECONOMÍA).",
    )
    .option(
      "--escuela <nombre|codigo>",
      "Otra Escuela/Programa por nombre (BIOLOGÍA) o código (4020); su depe se deriva solo.",
    )
    .option("--espe <codigo>", "Parámetro espe (por defecto el del login).")
    .action(async (codigo: string | undefined, opts, cmd) => {
      try {
        const parent = parentOpts(cmd);
        const escuela = (opts.escuela ?? parent.escuela) as string | undefined;
        const json = Boolean(opts.json || parent.json);
        if (codigo) {
          const horario = await getSubjectSchedule(codigo, {
            depe: opts.depe,
            escuela,
            espe: opts.espe,
          });
          if (json) {
            out(JSON.stringify(horario, null, 2));
          } else {
            renderHorario(horario);
          }
          return;
        }
        const status = statusLine();
        status.set("consultando la oferta del ciclo…");
        const { school, courses } = await getCourseCatalog({
          depe: opts.depe,
          escuela,
          espe: opts.espe,
        });
        status.done();
        if (json) {
          out(JSON.stringify({ school, courses }, null, 2));
          return;
        }
        out(banner("Oferta del ciclo", school ?? undefined));
        if (courses.length === 0) {
          out(`${mark.warn()} La escuela no tiene asignaturas registradas para este ciclo.`);
          return;
        }
        // Una línea por asignatura: las secciones se unen en el corchete (A, B, C…).
        const byCode = new Map<string, (typeof courses)[number]>();
        for (const course of courses) {
          const existing = byCode.get(course.code);
          if (!existing) {
            byCode.set(course.code, { ...course });
          } else {
            byCode.set(course.code, { ...existing, group: `${existing.group}, ${course.group}` });
          }
        }
        let year: string | null = null;
        for (const course of byCode.values()) {
          if (course.year !== year) {
            year = course.year;
            out("\n" + rule(year ?? "Sin agrupar"));
          }
          out(` ${c.cyan(course.code)}  ${course.name}  ${c.dim(`[${course.group}]`)}`);
        }
      } catch (err) {
        out(`${mark.err()} ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  hrs
    .command("aulas")
    .description(
      "Aulas de la escuela. `dutic hrs aulas <aula>` muestra qué asignaturas (y secciones) se " +
        "dictan ahí y cuándo.",
    )
    .argument("[aula]", "Aula: código interno o parte del nombre (p.ej. '105').")
    .option("--json", "Salida en JSON.")
    .option(
      "--depe <codigo>",
      "Código de dependencia/escuela para el horario (por defecto el del login, p.ej. 470 = ECONOMÍA).",
    )
    .option(
      "--escuela <nombre|codigo>",
      "Otra Escuela/Programa por nombre (BIOLOGÍA) o código (4020); su depe se deriva solo.",
    )
    .option("--espe <codigo>", "Parámetro espe (por defecto el del login).")
    .action(async (aula: string | undefined, opts, cmd) => {
      try {
        const parent = parentOpts(cmd);
        const escuela = (opts.escuela ?? parent.escuela) as string | undefined;
        const json = Boolean(opts.json || parent.json);
        if (aula) {
          const horario = await getAulaSchedule(aula, {
            depe: opts.depe,
            escuela,
            espe: opts.espe,
          });
          if (json) {
            out(JSON.stringify(horario, null, 2));
          } else {
            renderHorario(horario);
          }
          return;
        }
        const status = statusLine();
        status.set("consultando el listado de aulas…");
        const { school, aulas } = await getAulaList({
          depe: opts.depe,
          escuela,
          espe: opts.espe,
        });
        status.done();
        if (json) {
          out(JSON.stringify({ school, aulas }, null, 2));
          return;
        }
        out(banner("Aulas de la escuela", school ?? undefined));
        if (aulas.length === 0) {
          out(`${mark.warn()} La escuela no tiene aulas registradas para este ciclo.`);
          return;
        }
        out(
          table(
            [{ header: "código", align: "right" }, { header: "aula" }],
            aulas.map((a) => [a.code, a.name]),
          ),
        );
        out(c.dim(`    ${aulas.length} aulas · dutic hrs aulas "<parte del nombre>" para ver su uso`));
      } catch (err) {
        out(`${mark.err()} ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}