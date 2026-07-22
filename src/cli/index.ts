#!/usr/bin/env node
import { Command } from "commander";
import { writeFile } from "node:fs/promises";
import { withSession } from "../core/auth.js";
import { loginWithPlaywright } from "../core/login.js";
import { getSemester } from "../core/config.js";
import { isExpired, isValid, loadSession } from "../core/session.js";
import { getEnrolledCourses } from "../domain/courses.js";
import { getAllTasks, getCourseTasks, getUpcomingTasks } from "../domain/tasks.js";
import {
  downloadFile,
  listCourseMaterials,
  pullCourseFiles,
} from "../domain/resources.js";
import {
  convertLocalPdfToMarkdown,
  readResourceAsMarkdown,
  studyCourseMaterials,
} from "../domain/documents.js";
import { getAllGrades, getCourseGrades, type CourseGrades } from "../domain/grades.js";
import { getAssignDetail } from "../domain/assign.js";
import {
  findPeople,
  getCourseTeachers,
  getPersonProfile,
  listCourseParticipants,
} from "../domain/people.js";
import { fetchAulaPage } from "../domain/fetch.js";
import { cacheInfo, clearCache, setCacheEnabled, setCacheRefresh } from "../core/cache.js";
import { parseCourseName } from "../core/coursename.js";
import { humanizeAgo } from "../core/dates.js";
import { formatTaskLine } from "./format.js";
import { banner, c, mark, progressBar, rule, statusLine, table } from "./ui.js";
import { MCP_SERVER_PATH, runSetup } from "./setup.js";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Versión leída del package.json del propio paquete (evita que se desincronice). */
function pkgVersion(): string {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const fmtDate = (e: number | null | undefined) =>
  e == null ? "—" : new Date(e * 1000).toLocaleString("es-PE");

const log = (msg: string) => process.stderr.write(msg + "\n");
const out = (msg = "") => process.stdout.write(msg + "\n");

const program = new Command();
program
  .name("dutic")
  .description("CLI del aula virtual DUTIC (Moodle UNSA): tareas, notas, cursos y materiales.")
  .version(pkgVersion())
  .option("--refresh", "Ignora la caché y trae datos frescos (reescribe la caché).")
  .option("--no-cache", "Desactiva la caché para este comando.")
  .hook("preAction", (thisCommand) => {
    const o = thisCommand.opts();
    if (o.cache === false) setCacheEnabled(false);
    if (o.refresh) setCacheRefresh(true);
  });

const cache = program.command("cache").description("Gestiona la caché local (perfiles, cursos…).");
cache
  .command("clear")
  .description("Borra toda la caché.")
  .action(async () => {
    const n = await clearCache();
    out(`${mark.ok()} Caché borrada (${n} entrada(s)).`);
  });
cache
  .command("info")
  .description("Muestra el tamaño de la caché.")
  .action(async () => {
    const i = await cacheInfo();
    out(`${mark.info()} ${i.entries} entrada(s) · ${(i.bytes / 1024).toFixed(1)} KB`);
    out(`  ${c.dim(i.dir)}`);
  });

program
  .command("setup")
  .description("Configura el MCP en tus agentes (Claude Code, Antigravity, OpenCode…) e instala la skill.")
  .action(() => {
    out(banner("Configuración de dutic", `semestre ${getSemester()}`));
    const results = runSetup(getSemester());
    for (const r of results) {
      const icon = r.status === "ok" ? mark.ok() : r.status === "skip" ? c.gray("[-]") : mark.err();
      out(`  ${icon} ${r.label.padEnd(20)} ${c.dim(r.detail)}`);
    }
    const ok = results.filter((r) => r.status === "ok").length;
    out(`\n${mark.info()} ${ok} destino(s) configurado(s). Servidor MCP:`);
    out(`  ${c.gray(MCP_SERVER_PATH)}`);
    out(`\n${mark.arrow()} Siguiente paso: ${c.cyan("dutic login")} y luego ${c.cyan("dutic tasks --all")}`);
    out(c.dim("  Reinicia tus agentes para que carguen el servidor MCP."));
  });

program
  .command("login")
  .description("Inicia sesión con Google y guarda la sesión de Moodle.")
  .action(async () => {
    await loginWithPlaywright({ headless: false, onStatus: log });
    out(`${mark.ok()} Sesión guardada.`);
  });

program
  .command("status")
  .description("Muestra el estado de la sesión y el semestre.")
  .action(async () => {
    const s = await loadSession();
    out(banner("DUTIC", `semestre ${getSemester()}`));
    if (!s) {
      out(`${mark.warn()} Sin sesión. Ejecuta ${c.cyan("dutic login")}.`);
      return;
    }
    const estado = isValid(s)
      ? c.green("válida")
      : isExpired(s)
        ? c.yellow("caducada")
        : c.red("incompleta");
    out(`${mark.info()} sitio:     ${s.siteUrl}`);
    out(`${mark.info()} capturada: ${new Date(s.capturedAt).toLocaleString("es-PE")}`);
    out(`${mark.info()} estado:    ${estado}`);
  });

program
  .command("tasks")
  .description("Lista tus tareas. Por defecto las próximas del timeline.")
  .option("--all", "Barre todos los cursos para incluir tareas ocultas.")
  .option("--hidden", "Muestra sólo las tareas ocultas (implica --all).")
  .option("--fast", "No scrapear el estado de entrega (más rápido).")
  .option("--json", "Salida en JSON.")
  .action(async (opts) => {
    await withSession(
      async (session) => {
        if (opts.all || opts.hidden) {
          const { tasks, scanErrors } = await getAllTasks(session, { enrich: !opts.fast });
          const list = opts.hidden ? tasks.filter((t) => t.hidden) : tasks;
          if (opts.json) return out(JSON.stringify({ tasks: list, scanErrors }, null, 2));
          const pending = list.filter((t) => t.submission === "not-submitted");
          out(banner("Tareas", `${list.length} en total${opts.hidden ? " · ocultas" : ""}`));
          if (pending.length) out(`${mark.err()} ${c.boldRed(`${pending.length} SIN ENTREGAR`)} ${c.dim("(orden por urgencia)")}`);
          else if (list.every((t) => t.submission === "unknown")) out(`${mark.info()} ${c.dim("estado no consultado (--fast)")}`);
          else out(`${mark.ok()} nada pendiente por entregar.`);
          out();
          for (const t of list) out(formatTaskLine(t) + "\n");
          if (scanErrors.length) {
            log(c.yellow(`\n${scanErrors.length} curso(s) no se pudieron barrer:`));
            for (const e of scanErrors) log(`  ${mark.bullet()} ${e.courseName}: ${e.reason}`);
          }
        } else {
          const list = await getUpcomingTasks(session);
          if (opts.json) return out(JSON.stringify(list, null, 2));
          out(banner("Tareas próximas", `${list.length} en el timeline`));
          out();
          for (const t of list) out(formatTaskLine(t) + "\n");
          log(c.dim(`Sugerencia: ${c.cyan("dutic tasks --all")} incluye las tareas ocultas.`));
        }
      },
      { mode: "interactive", login: { onStatus: log } },
    );
  });

program
  .command("task <cmid>")
  .description("Detalle completo de una tarea: consigna, fechas, adjuntos y estado de entrega.")
  .option("--json", "Salida en JSON.")
  .action(async (cmid, opts) => {
    await withSession(
      async (session) => {
        const url = `${session.siteUrl}/mod/assign/view.php?id=${cmid}`;
        const d = await getAssignDetail(session, url);
        if (opts.json) return out(JSON.stringify(d, null, 2));
        out(banner("Detalle de tarea", `cmid ${cmid}`));
        out(`  ${c.dim("estado:")}   ${d.submission === "not-submitted" ? c.boldRed("SIN ENTREGAR") : c.green(d.submission)}`);
        out(`  ${c.dim("apertura:")} ${fmtDate(d.openDate)}`);
        out(`  ${c.dim("cierre:")}   ${c.bold(fmtDate(d.closeDate))}`);
        if (d.grade) out(`  ${c.dim("nota:")}     ${d.grade}${d.gradedBy ? c.dim(` (por ${d.gradedBy})`) : ""}`);
        if (d.timeRemaining) out(`  ${c.dim("resta:")}    ${d.timeRemaining}`);
        if (d.dateConflict) {
          out("");
          out(`${mark.err()} ${c.boldRed("CONFLICTO DE FECHAS")}`);
          out(`  La consigna menciona: ${d.datesInDescription.map((x) => c.yellow(x.text)).join(", ")}`);
          out(`  pero Moodle cierra el ${c.bold(fmtDate(d.closeDate))}. ${c.dim("Confirma con el docente.")}`);
        }
        if (d.description) {
          out("\n" + rule("consigna"));
          out("  " + d.description.slice(0, 1200));
        }
        if (d.attachments.length) {
          out("\n" + rule("adjuntos de la consigna"));
          for (const a of d.attachments) out(`  ${mark.bullet()} ${a.filename}\n    ${c.gray(a.url)}`);
        }
      },
      { login: { onStatus: log } },
    );
  });

program
  .command("people <courseId>")
  .description("Participantes del curso, con su correo (recorre todas las páginas).")
  .option("--no-email", "No resolver los correos (más rápido).")
  .option("--json", "Salida en JSON.")
  .action(async (courseId, opts) => {
    await withSession(
      async (session) => {
        const withEmail = opts.email !== false; // commander: --no-email ⇒ opts.email === false
        const status = statusLine();
        const ppl = await listCourseParticipants(session, Number(courseId), {
          withEmail,
          onProgress: ({ phase, done, total, label }) =>
            status.set(`${phase} ${done}/${total} ${c.dim((label ?? "").slice(0, 34))}`),
        });
        status.done();
        if (opts.json) return out(JSON.stringify(ppl, null, 2));
        out(banner("Participantes", `${ppl.length} · curso ${courseId}`));
        out(
          table(
            [
              { header: "nombre" },
              { header: "rol", color: c.dim },
              { header: "grupo", color: c.dim },
              { header: "último acceso", color: c.dim },
              ...(withEmail ? [{ header: "correo", color: c.cyan }] : []),
            ],
            ppl.map((p) => [
              p.name,
              p.role ?? "—",
              p.group ?? "—",
              p.lastAccess ?? "—",
              ...(withEmail ? [p.email ?? "—"] : []),
            ]),
          ),
        );
      },
      { login: { onStatus: log } },
    );
  });

program
  .command("person <query>")
  .description("Busca una persona en tus cursos por nombre o correo.")
  .option("--json", "Salida en JSON.")
  .action(async (query, opts) => {
    await withSession(
      async (session) => {
        const status = statusLine();
        const found = await findPeople(session, query, {
          onProgress: ({ phase, done, total, label }) =>
            status.set(`${phase} ${done}/${total} ${c.dim((label ?? "").slice(0, 38))}`),
        });
        status.done();
        if (opts.json) return out(JSON.stringify(found, null, 2));
        out(banner("Personas", `"${query}" · ${found.length} resultado(s)`));
        for (const p of found) {
          out(`\n${mark.arrow()} ${c.bold(p.name)}`);
          out(`  ${c.dim("correo:")}        ${p.email ? c.cyan(p.email) : c.gray("no visible")}`);
          out(
            `  ${c.dim("visto:")}         ${p.lastAccess ?? c.gray("—")}` +
              ` ${c.dim(`(${humanizeAgo(p.lastSeenAgoSeconds)}, lo más reciente)`)}`,
          );
          out(
            `  ${c.dim("cursos:")}        ${c.bold(String(p.courses.length))} en total · ` +
              `${c.green(String(p.sharedCount))} contigo`,
          );
          for (const cr of p.courses) {
            const grp = cr.group ? c.dim(` · ${cr.group}`) : "";
            const flag = cr.shared ? c.green("✓ contigo") : c.gray("· su curso");
            const acc = cr.shared && cr.lastAccess ? c.dim(`  visto ${cr.lastAccess}`) : "";
            out(`    ${cr.shared ? c.green("●") : c.gray("○")} ${cr.subject}${grp}  ${flag}${acc}`);
          }
        }
      },
      { login: { onStatus: log } },
    );
  });

program
  .command("profile <userId>")
  .description("Perfil de cualquier usuario por id: correo y sus cursos (sirve para docentes).")
  .option("--course <id>", "Curso de contexto que revela sus cursos (usa uno que compartas).")
  .option("--json", "Salida en JSON.")
  .action(async (userId, opts) => {
    await withSession(
      async (session) => {
        const prof = await getPersonProfile(
          session,
          Number(userId),
          opts.course ? Number(opts.course) : undefined,
        );
        if (opts.json) return out(JSON.stringify(prof, null, 2));
        out(banner("Perfil", prof.name));
        out(`  ${c.dim("id:")}     ${prof.userId}`);
        out(`  ${c.dim("correo:")} ${prof.email ? c.cyan(prof.email) : c.gray("no visible")}`);
        if (prof.role) {
          const isTeacher = /profesor|docente|teacher/i.test(prof.role);
          out(`  ${c.dim("rol:")}    ${isTeacher ? c.boldYellow(prof.role) : prof.role}`);
        }
        out(`  ${c.dim("zona:")}   ${prof.timezone ?? "—"}`);
        if (prof.lastAccessAt) out(`  ${c.dim("visto:")}  ${prof.lastAccessAt}`);
        out(`  ${c.dim("cursos:")} ${c.bold(String(prof.courses.length))}`);
        for (const cr of prof.courses) {
          out(`    ${mark.bullet()} ${cr.subject}${cr.group ? c.dim(` · ${cr.group}`) : ""} ${c.gray(`(id ${cr.courseId})`)}`);
        }
        if (!prof.courses.length) {
          log(c.dim("  (sin cursos visibles; prueba --course <id de un curso que compartas>)"));
        }
      },
      { login: { onStatus: log } },
    );
  });

program
  .command("fetch <url>")
  .description("Descarga cualquier página del aula con tu sesión (explorar por URL, cambiar ids…).")
  .option("--format <f>", "text | html | links", "text")
  .option("--max <n>", "Máximo de caracteres.", "20000")
  .action(async (url, opts) => {
    await withSession(
      async (session) => {
        const r = await fetchAulaPage(session, url, opts.format, Number(opts.max));
        log(c.dim(`# ${r.finalUrl} (${r.status})`));
        if (opts.format === "links" && r.links) {
          for (const l of r.links) out(`${c.cyan(l.href)}  ${c.dim(l.text)}`);
        } else {
          out(r.content);
        }
      },
      { login: { onStatus: log } },
    );
  });

program
  .command("teachers <courseId>")
  .description("Docentes del curso (deducidos de contactos y de quién califica).")
  .action(async (courseId) => {
    await withSession(
      async (session) => {
        const t = await getCourseTeachers(session, Number(courseId));
        out(banner("Docentes", `curso ${courseId}`));
        if (!t.length) out(`${mark.warn()} No se pudo identificar docentes (el aula no los expone).`);
        for (const n of t) out(`  ${mark.bullet()} ${n}`);
      },
      { login: { onStatus: log } },
    );
  });

program
  .command("grades [courseId]")
  .description("Muestra tus calificaciones. Sin curso: resumen de todos; con curso: detalle.")
  .option("--json", "Salida en JSON.")
  .action(async (courseId, opts) => {
    await withSession(
      async (session) => {
        if (courseId) {
          const g = await getCourseGrades(session, Number(courseId));
          if (opts.json) return out(JSON.stringify(g, null, 2));
          renderCourseGrades(g);
        } else {
          const all = await getAllGrades(session);
          if (opts.json) return out(JSON.stringify(all, null, 2));
          renderGradesSummary(all);
        }
      },
      { login: { onStatus: log } },
    );
  });

program
  .command("courses")
  .description("Lista tus cursos matriculados.")
  .option("--json", "Salida en JSON.")
  .action(async (opts) => {
    await withSession(
      async (session) => {
        const courses = await getEnrolledCourses(session);
        if (opts.json) return out(JSON.stringify(courses, null, 2));
        out(banner("Cursos", `${courses.length} matriculados`));
        out(
          table(
            [
              { header: "id", align: "right", color: c.dim },
              { header: "curso" },
              { header: "grupo", color: c.dim },
              { header: "docente(s)", color: c.dim },
            ],
            courses.map((cr) => {
              const parsed = parseCourseName(cr.fullname);
              return [
                String(cr.id),
                parsed.subject,
                parsed.group ?? "—",
                cr.contacts.join(", ") || "—",
              ];
            }),
          ),
        );
      },
      { login: { onStatus: log } },
    );
  });

const course = program.command("course").description("Operaciones sobre un curso.");

course
  .command("tasks <courseId>")
  .description("Tareas de un curso (incluye ocultas).")
  .option("--fast", "No scrapear el estado de entrega.")
  .option("--json", "Salida en JSON.")
  .action(async (courseId, opts) => {
    await withSession(
      async (session) => {
        const list = await getCourseTasks(session, Number(courseId), "", { enrich: !opts.fast });
        if (opts.json) return out(JSON.stringify(list, null, 2));
        out(banner("Tareas del curso", `${list.length} · curso ${courseId}`));
        out();
        for (const t of list) out(formatTaskLine(t) + "\n");
      },
      { login: { onStatus: log } },
    );
  });

program
  .command("materials <courseId>")
  .description("Lista los materiales de un curso, agrupados por unidad/sección.")
  .option("--section <texto>", "Filtra por unidad/sección (subcadena).")
  .option("--json", "Salida en JSON.")
  .action(async (courseId, opts) => {
    await withSession(
      async (session) => {
        const mats = await listCourseMaterials(session, Number(courseId), { section: opts.section });
        if (opts.json) return out(JSON.stringify(mats, null, 2));
        out(banner("Materiales", `${mats.length} archivo(s) · curso ${courseId}`));
        const bySection = new Map<string, typeof mats>();
        for (const m of mats) {
          const key = m.section || "(sin sección)";
          (bySection.get(key) ?? bySection.set(key, []).get(key)!).push(m);
        }
        for (const [section, items] of bySection) {
          out("\n" + rule(section));
          for (const m of items) {
            const tag = m.folder ? c.dim(`[${m.folder}] `) : "";
            out(`  ${mark.bullet()} ${tag}${m.filename}`);
            out(`    ${c.gray(m.url)}`);
          }
        }
      },
      { login: { onStatus: log } },
    );
  });

program
  .command("study <courseId>")
  .description("Descarga los materiales de un curso y convierte los PDFs a Markdown para estudiar.")
  .option("--dest <dir>", "Directorio destino.", "./materiales")
  .option("--section <texto>", "Sólo una unidad/sección (subcadena).")
  .action(async (courseId, opts) => {
    await withSession(
      async (session) => {
        const dest = `${opts.dest}/curso-${courseId}`;
        out(banner("Preparar para estudiar", `curso ${courseId}${opts.section ? ` · ${opts.section}` : ""}`));
        const bar = progressBar(1, "  descargando");
        const items = await studyCourseMaterials(session, Number(courseId), dest, {
          section: opts.section,
          onProgress: (done, total, name) => bar.update(done, name.slice(0, 30)),
        });
        bar.done();
        const md = items.filter((i) => i.kind === "markdown").length;
        const files = items.filter((i) => i.kind === "file").length;
        const errs = items.filter((i) => i.kind === "error").length;
        out(`${mark.ok()} ${c.bold(String(md))} PDF→Markdown · ${files} otros · ${errs ? c.red(`${errs} error(es)`) : "0 errores"}`);
        out(`  ${c.dim("destino:")} ${dest}`);
      },
      { login: { onStatus: log } },
    );
  });

program
  .command("read <url>")
  .description("Lee un recurso (PDF/texto) y muestra su contenido como Markdown para analizar.")
  .option("--out <file>", "Guarda el Markdown en un archivo en vez de imprimirlo.")
  .option("--max <n>", "Máximo de caracteres.", "24000")
  .action(async (url, opts) => {
    await withSession(
      async (session) => {
        const r = await readResourceAsMarkdown(session, url, Number(opts.max));
        if (r.markdown == null) return log(`${mark.warn()} ${r.note}`);
        if (opts.out) {
          await writeFile(opts.out, r.markdown, "utf8");
          out(`${mark.ok()} ${r.filename} (${r.kind}, ${r.pages ?? "?"} pág) → ${opts.out}`);
        } else {
          log(c.dim(`# ${r.filename} (${r.kind}${r.pages ? `, ${r.pages} pág` : ""})\n`));
          out(r.markdown);
        }
      },
      { login: { onStatus: log } },
    );
  });

program
  .command("md <pdfPath>")
  .description("Convierte un PDF local a Markdown.")
  .option("--out <file>", "Guarda el Markdown en un archivo.")
  .option("--max <n>", "Máximo de caracteres (0 = sin límite).", "0")
  .action(async (pdfPath, opts) => {
    const r = await convertLocalPdfToMarkdown(pdfPath, opts.out, Number(opts.max));
    if (r.savedTo) out(`${mark.ok()} ${r.pages} pág, ${r.totalChars} chars → ${r.savedTo}`);
    else out(r.markdown);
  });

program
  .command("download <url> <dest>")
  .description("Descarga un archivo por su URL a la ruta destino.")
  .action(async (url, dest) => {
    await withSession(
      async (session) => {
        const r = await downloadFile(session, url, dest);
        out(`${mark.ok()} ${r.bytes} bytes → ${r.path}`);
      },
      { login: { onStatus: log } },
    );
  });

program
  .command("pull <courseId>")
  .description("Descarga todos los materiales de un curso (expande carpetas).")
  .option("--dest <dir>", "Directorio destino.", "./descargas")
  .option("--section <texto>", "Sólo una unidad/sección (subcadena).")
  .action(async (courseId, opts) => {
    await withSession(
      async (session) => {
        out(banner("Descargar materiales", `curso ${courseId}`));
        const bar = progressBar(1, "  descargando");
        const results = await pullCourseFiles(session, Number(courseId), opts.dest, {
          section: opts.section,
          onProgress: (done, total, name) => bar.update(done, name.slice(0, 30)),
        });
        bar.done();
        out(`${mark.ok()} ${c.bold(String(results.length))} archivo(s) → ${opts.dest}`);
      },
      { login: { onStatus: log } },
    );
  });

// --- Renderers de notas ---

function gradeColor(grade: string | null, range: string | null): (s: string) => string {
  if (!grade) return c.gray;
  const val = parseFloat(grade.replace(",", "."));
  const max = range ? parseFloat((range.split(/[–-]/)[1] ?? "20").replace(",", ".")) : 20;
  if (isNaN(val)) return c.reset;
  const ratio = val / (max || 20);
  return ratio >= 0.7 ? c.green : ratio >= 0.55 ? c.yellow : c.boldRed;
}

function renderCourseGrades(g: CourseGrades): void {
  out(banner("Calificaciones", g.courseName || `curso ${g.courseId}`));
  const rows = g.items
    .filter((i) => !i.isTotal)
    .map((i) => [
      i.name,
      gradeColor(i.grade, i.range)(i.grade ?? "—"),
      c.dim(i.range ?? "—"),
      c.dim(i.percentage ?? "—"),
    ]);
  out(
    table(
      [
        { header: "ítem" },
        { header: "nota", align: "right" },
        { header: "rango", align: "right" },
        { header: "%", align: "right" },
      ],
      rows,
    ),
  );
  if (g.total) out(`\n  ${c.bold("Total del curso:")} ${gradeColor(g.total, "0-20")(g.total)} ${c.dim(g.totalPercentage ?? "")}`);
}

function renderGradesSummary(all: CourseGrades[]): void {
  out(banner("Resumen de calificaciones", `${all.length} cursos`));
  const rows = all.map((g) => {
    const pend = g.items.filter((i) => !i.isTotal && !i.grade).length;
    return [
      g.courseName.slice(0, 42),
      g.total ? gradeColor(g.total, "0-20")(g.total) : c.gray("—"),
      pend ? c.yellow(`${pend} pend.`) : c.green("al día"),
    ];
  });
  out(
    table(
      [{ header: "curso" }, { header: "total", align: "right" }, { header: "por calificar" }],
      rows,
    ),
  );
  log(c.dim(`\nDetalle de un curso: ${c.cyan("dutic grades <courseId>")}`));
}

program.parseAsync(process.argv).catch((err) => {
  log(`${mark.err()} ${err?.message ?? err}`);
  process.exitCode = 1;
});
