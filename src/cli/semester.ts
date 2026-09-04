import type { Command } from "commander";
import { currentContext, resolveContext, setDefaultContext } from "../core/context.js";
import { discoverSemesters } from "../core/discovery.js";
import { clearActiveSemester, upsertSemester } from "../core/registry.js";
import { formatSemesterLabel, normalizeSemester } from "../core/semester.js";
import {
  currentSemesterSummary,
  forgetSemester,
  labelSemester,
  listSemesterStates,
  switchSemester,
  type SemesterState,
} from "../domain/semesters.js";
import { loginWithPlaywright } from "../core/login.js";
import { banner, c, mark, statusLine, table } from "./ui.js";

const out = (msg = "") => process.stdout.write(msg + "\n");
const log = (msg: string) => process.stderr.write(msg + "\n");

const kb = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(0)} KB`);

/** De dónde salió el semestre en curso, en castellano llano. */
const SOURCE_TEXT: Record<string, string> = {
  override: "opción --semester",
  env: "variable DUTIC_SEMESTER",
  registry: "semestre activo guardado",
  session: "sesión existente en disco",
  inferred: "deducido de la fecha de hoy",
};

function stateRow(s: SemesterState): string[] {
  return [
    (s.active ? `${c.green("*")} ` : "  ") + s.display,
    s.label ?? "—",
    s.hasSession ? c.green("sí") : c.gray("no"),
    s.scannedCourses > 0 ? String(s.scannedCourses) : "—",
    s.verified ? "ok" : "—",
    kb(s.bytes),
  ];
}

function printStates(states: SemesterState[]): void {
  if (states.length === 0) {
    out(`${mark.warn()} No hay semestres registrados todavía.`);
    out(`  ${mark.arrow()} ${c.cyan("dutic semester discover")} busca cuáles existen en el aula.`);
    return;
  }
  out(
    table(
      [
        { header: "Semestre" },
        { header: "Etiqueta", color: c.dim },
        { header: "Sesión" },
        { header: "Cursos", align: "right" },
        { header: "Verif." },
        { header: "Datos", align: "right", color: c.dim },
      ],
      states.map(stateRow),
    ),
  );
}

export function registerSemesterCommands(program: Command): void {
  const sem = program
    .command("semester")
    .alias("sem")
    .description("Gestiona los semestres: lista, cambia el activo, descubre y archiva períodos.");

  sem
    .command("list", { isDefault: true })
    .alias("ls")
    .description("Lista los semestres conocidos y cuál está activo.")
    .option("--json", "Salida en JSON.")
    .action(async (opts: { json?: boolean }) => {
      const states = await listSemesterStates();
      if (opts.json) {
        out(JSON.stringify(states, null, 2));
        return;
      }
      const ctx = currentContext();
      out(banner("Semestres", `activo ${formatSemesterLabel(ctx.id)}`));
      printStates(states);
      out(`\n${c.dim("origen del activo:")} ${SOURCE_TEXT[ctx.source] ?? ctx.source}`);
      out(`${mark.arrow()} Cambiar: ${c.cyan("dutic semester use 2025A")}`);
    });

  sem
    .command("current")
    .description("Muestra el semestre en curso y de dónde salió.")
    .option("--json", "Salida en JSON.")
    .action(async (opts: { json?: boolean }) => {
      const s = await currentSemesterSummary();
      if (opts.json) {
        out(JSON.stringify(s, null, 2));
        return;
      }
      out(banner("Semestre actual", s.display));
      out(`  ${c.dim("sitio:")}    ${s.siteUrl}`);
      out(`  ${c.dim("origen:")}   ${SOURCE_TEXT[s.source] ?? s.source}`);
      out(`  ${c.dim("sesión:")}   ${s.hasSession ? c.green("activa") : c.yellow("sin sesión")}`);
      out(`  ${c.dim("datos:")}    ${s.dir} ${c.dim(`(${kb(s.bytes)})`)}`);
      if (!s.hasSession) {
        out(`\n${mark.arrow()} ${c.cyan("dutic login")} para entrar a este semestre.`);
      }
    });

  sem
    .command("use <semestre>")
    .description("Cambia el semestre activo (p.ej. 2025A, 2026-B).")
    .option("--login", "Si ese semestre no tiene sesión, iniciarla ahora mismo.")
    .action(async (raw: string, opts: { login?: boolean }) => {
      const result = await switchSemester(raw);
      // El contexto del proceso se recoloca en el acto: si el mismo comando sigue haciendo algo
      // más (como --login), tiene que verse ya dentro del semestre nuevo.
      setDefaultContext(resolveContext(result.current));
      out(
        `${mark.ok()} Semestre activo: ${c.cyan(formatSemesterLabel(result.current))}` +
          (result.previous !== result.current
            ? c.dim(` (antes ${formatSemesterLabel(result.previous)})`)
            : ""),
      );
      if (result.hasSession) {
        out(
          `  ${c.dim("sesión:")} ${c.green("activa")} · ${result.state.scannedCourses} curso(s) en caché`,
        );
        return;
      }
      if (!opts.login) {
        out(`  ${mark.warn()} Sin sesión para este semestre.`);
        out(`  ${mark.arrow()} ${c.cyan("dutic login")} (o repite con ${c.cyan("--login")}).`);
        return;
      }
      await loginWithPlaywright({ headless: false, onStatus: log });
      out(`${mark.ok()} Sesión guardada para ${formatSemesterLabel(result.current)}.`);
    });

  sem
    .command("add <semestre>")
    .description("Registra un semestre a mano, sin sondear el servidor.")
    .option("--label <texto>", "Etiqueta libre para reconocerlo en la lista.")
    .option("--matricula-path <ruta>", "Carpeta del login de matrícula, si no sigue el patrón.")
    .action((raw: string, opts: { label?: string; matriculaPath?: string }) => {
      const id = normalizeSemester(raw);
      if (!id) {
        out(`${mark.err()} "${raw}" no es un semestre válido (se espera 2026A, 2026-B, 2026II).`);
        process.exitCode = 1;
        return;
      }
      upsertSemester(id, {
        label: opts.label ?? null,
        matriculaPath: opts.matriculaPath ?? null,
      });
      out(`${mark.ok()} Registrado ${c.cyan(formatSemesterLabel(id))}.`);
    });

  sem
    .command("label <semestre> [texto]")
    .description("Pone (o quita, si omites el texto) la etiqueta de un semestre.")
    .action((raw: string, text?: string) => {
      const id = normalizeSemester(raw);
      if (!id) {
        out(`${mark.err()} "${raw}" no es un semestre válido.`);
        process.exitCode = 1;
        return;
      }
      labelSemester(id, text ?? null);
      out(
        `${mark.ok()} ${formatSemesterLabel(id)} → ${text ? c.cyan(text) : c.gray("sin etiqueta")}`,
      );
    });

  sem
    .command("discover")
    .description("Sondea el aula virtual para averiguar qué semestres existen y los registra.")
    .option("--from <semestre>", "Inicio del rango a sondear.")
    .option("--to <semestre>", "Fin del rango a sondear.")
    .option("--json", "Salida en JSON.")
    .action(async (opts: { from?: string; to?: string; json?: boolean }) => {
      const spin = statusLine();
      const results = await discoverSemesters({
        from: opts.from,
        to: opts.to,
        onProgress: (done, total, last) => spin.set(`sondeando ${last.id}… (${done}/${total})`),
      });
      spin.done();
      if (opts.json) {
        out(JSON.stringify(results, null, 2));
        return;
      }

      const found = results.filter((r) => r.exists);
      const unknown = results.filter((r) => !r.exists && !r.conclusive);
      out(banner("Descubrimiento", `${found.length} de ${results.length} períodos existen`));
      out(
        table(
          [
            { header: "Semestre" },
            { header: "Existe" },
            { header: "HTTP", align: "right", color: c.dim },
            { header: "Título", color: c.dim },
          ],
          results.map((r) => [
            formatSemesterLabel(r.id),
            r.exists ? c.green("sí") : r.conclusive ? c.gray("no") : c.yellow("?"),
            r.status ? String(r.status) : "—",
            (r.title ?? r.error ?? (r.conclusive ? "—" : "no se pudo comprobar")).slice(0, 46),
          ]),
        ),
      );
      if (unknown.length > 0) {
        out(
          `
${mark.warn()} ${unknown.length} período(s) sin comprobar (servidor caído o red). ` +
            `No se descartan: vuelve a intentarlo más tarde.`,
        );
      }
      if (found.length > 0) {
        const latest = found[found.length - 1].id;
        out(
          `\n${mark.arrow()} ${c.cyan(`dutic semester use ${latest}`)} para trabajar en el más reciente.`,
        );
      }
    });

  sem
    .command("forget <semestre>")
    .description("Quita un semestre del registro. Con --purge borra también sus datos locales.")
    .option("--purge", "Borrar el directorio del semestre (sesión, cursos, notas, horario).")
    .option("--yes", "No pedir confirmación para --purge.")
    .action(async (raw: string, opts: { purge?: boolean; yes?: boolean }) => {
      const id = normalizeSemester(raw);
      if (!id) {
        out(`${mark.err()} "${raw}" no es un semestre válido.`);
        process.exitCode = 1;
        return;
      }
      // Borrar el expediente de un ciclo entero es irreversible: sin --yes no se hace a ciegas.
      if (opts.purge && !opts.yes) {
        out(
          `${mark.warn()} ${c.bold("--purge")} borra TODOS los datos locales de ${formatSemesterLabel(id)}:`,
        );
        out(`  ${c.dim("sesión, cursos escaneados, notas, horario y caché.")}`);
        out(`  ${mark.arrow()} Repite con ${c.cyan("--yes")} si es lo que quieres.`);
        process.exitCode = 1;
        return;
      }
      const r = await forgetSemester(id, { purge: opts.purge });
      if (r.purgedDir) {
        out(`${mark.ok()} ${formatSemesterLabel(id)} eliminado (${kb(r.bytesFreed)} liberados).`);
      } else if (r.removedFromRegistry) {
        out(`${mark.ok()} ${formatSemesterLabel(id)} quitado del registro; sus datos siguen en disco.`);
      } else {
        out(`${mark.warn()} ${formatSemesterLabel(id)} no estaba registrado.`);
      }
    });

  sem
    .command("auto")
    .description("Vuelve a la selección automática (por fecha / sesión existente).")
    .action(() => {
      clearActiveSemester();
      const ctx = resolveContext();
      setDefaultContext(ctx);
      out(
        `${mark.ok()} Selección automática. Ahora resuelve a ${c.cyan(formatSemesterLabel(ctx.id))}.`,
      );
      out(`  ${c.dim("origen:")} ${SOURCE_TEXT[ctx.source] ?? ctx.source}`);
    });
}
