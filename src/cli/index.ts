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
  getBatchPersonProfiles,
  getCourseTeachers,
  getMyProfile,
  getPersonProfile,
  getPersonProfileAuto,
  listCourseParticipants,
} from "../domain/people.js";
import { fetchAulaPage } from "../domain/fetch.js";
import { checkChanges } from "../domain/watch.js";
import {
  captureSisacadGrades,
  compareSisacadWithMoodle,
  loadSisacadGrades,
  type SisacadCapture,
} from "../domain/sisacad.js";
import { cacheInfo, clearCache, setCacheEnabled, setCacheRefresh } from "../core/cache.js";
import {
  clearCoursesDb,
  coursesDbInfo,
  getCachedCourse,
  loadCoursesDb,
  saveCoursesToDb,
  type CourseRecord,
} from "../core/coursesDb.js";
import { syncUserToSupabase, syncScannedCoursesToSupabase } from "../core/supabase.js";
import { formatDate, relativeDue } from "./format.js";
import { parseCourseName } from "../core/coursename.js";
import { humanizeAgo } from "../core/dates.js";
import { formatTaskLine } from "./format.js";
import { banner, c, mark, progressBar, rule, statusLine, table } from "./ui.js";
import { MCP_SERVER_PATH, runSetup } from "./setup.js";
import { registerSaasCommands } from "./saas.js";
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
    const session = await loginWithPlaywright({ headless: false, onStatus: log });
    out(`${mark.ok()} Sesión guardada.`);

    // Sincronizar usuario con Supabase de forma silenciosa
    try {
      const spin = statusLine();
      spin.set("sincronizando perfil…");
      const profile = await getMyProfile(session);
      spin.done();
      if (profile.userId) {
        // Extraer semestre del siteUrl (e.g. "https://...unsa.edu.pe/2026A" → "2026A")
        const semesterMatch = session.siteUrl.match(/\/([0-9]{4}[A-Z])\/?$/);
        const semester = semesterMatch?.[1] ?? getSemester();
        await syncUserToSupabase({
          moodle_user_id: profile.userId,
          name: profile.name,
          email: profile.email ?? null,
          site_url: session.siteUrl,
          semester,
          last_login_at: new Date().toISOString(),
        });
        out(`${mark.info()} Perfil sincronizado: ${c.cyan(profile.name)}`);
      }
    } catch {
      // Nunca bloquear el login por un fallo de Supabase
    }
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
  .command("whoami")
  .description("Muestra tu propio perfil (nombre, correo, id) y el estado de la sesión.")
  .action(async () => {
    await withSession(
      async (session) => {
        const me = await getMyProfile(session);
        out(banner("Yo", me.name));
        out(`  ${c.dim("correo:")}   ${me.email ? c.cyan(me.email) : c.gray("—")}`);
        out(`  ${c.dim("id:")}       ${me.userId ?? "—"}`);
        out(`  ${c.dim("sitio:")}    ${session.siteUrl}`);
        out(`  ${c.dim("semestre:")} ${getSemester()}`);
      },
      { login: { onStatus: log } },
    );
  });

program
  .command("watch")
  .description("Detecta qué cambió desde la última revisión: tareas nuevas/ocultas, notas, entregas.")
  .option("--no-save", "No actualizar la línea base (sólo mostrar cambios).")
  .option("--json", "Salida en JSON.")
  .action(async (opts) => {
    // Para detectar cambios reales hay que mirar datos frescos, no la caché.
    setCacheRefresh(true);
    await withSession(
      async (session) => {
        const status = statusLine();
        status.set("revisando tareas y notas…");
        const { changes, previousAt } = await checkChanges(session, { save: opts.save });
        status.done();
        if (opts.json) return out(JSON.stringify({ changes, previousAt }, null, 2));

        out(banner("Novedades", previousAt ? `desde ${formatDate(Math.floor(previousAt / 1000))}` : "primera revisión"));
        if (!previousAt) {
          out(`${mark.info()} Línea base guardada. Vuelve a correr ${c.cyan("dutic watch")} más tarde para ver novedades.`);
          return;
        }
        if (!changes || !changes.hasChanges) {
          out(`${mark.ok()} Sin novedades desde la última revisión.`);
          return;
        }
        if (changes.newTasks.length) {
          out(`\n${rule("tareas nuevas")}`);
          for (const t of changes.newTasks) {
            const flag = t.hidden ? c.yellow("OCULTA") : c.dim("timeline");
            const pend = t.submission === "not-submitted" ? c.boldRed(" · SIN ENTREGAR") : "";
            out(`  ${c.boldGreen("+")} ${t.name} ${c.gray("[")}${flag}${c.gray("]")}${pend}`);
            out(`    ${c.dim(t.courseName)}  ${t.dueDate ? c.dim(`entrega ${formatDate(t.dueDate)} (${relativeDue(t.dueDate)})`) : ""}`);
          }
        }
        if (changes.newGrades.length) {
          out(`\n${rule("notas publicadas")}`);
          for (const g of changes.newGrades) out(`  ${c.cyan("★")} ${g.item}: ${c.bold(g.grade ?? "")}  ${c.dim(g.courseName)}`);
        }
        if (changes.gradeChanges.length) {
          out(`\n${rule("notas modificadas")}`);
          for (const g of changes.gradeChanges) out(`  ${c.cyan("~")} ${g.grade.item}: ${g.from} → ${c.bold(g.to ?? "")}  ${c.dim(g.grade.courseName)}`);
        }
        if (changes.submissionChanges.length) {
          out(`\n${rule("cambios de entrega")}`);
          for (const s of changes.submissionChanges) out(`  ${c.blue("»")} ${s.task.name}: ${s.from} → ${s.to}`);
        }
        if (changes.dueDateChanges.length) {
          out(`\n${rule("fechas cambiadas")}`);
          for (const d of changes.dueDateChanges) out(`  ${c.yellow("!")} ${d.task.name}: ${formatDate(d.from)} → ${c.bold(formatDate(d.to))}`);
        }
      },
      { login: { onStatus: log } },
    );
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
  .command("profile [userId]")
  .description(
    "Perfil de cualquier usuario por id: nombre, correo, rol y cursos (sirve para docentes). " +
      "Con --from/--to escanea un rango de ids para descubrir docentes.",
  )
  .option("--course <id>", "Curso de contexto conocido (salta la búsqueda automática).")
  .option("--from <id>", "Inicio del rango de ids a escanear.")
  .option("--to <id>", "Fin del rango de ids a escanear (inclusive).")
  .option("--teachers", "Filtra: mostrar sólo los que tienen rol de docente.")
  .option("--json", "Salida en JSON.")
  .action(async (userId, opts) => {
    // --- Rango: --from/--to ---
    if (opts.from || opts.to) {
      const start = Number(opts.from ?? userId);
      const end = Number(opts.to);
      if (!start || !end || start > end) {
        log(`${mark.err()} Especifica --from <inicio> --to <fin> con números válidos (inicio ≤ fin).`);
        return;
      }
      const ids = Array.from({ length: end - start + 1 }, (_, i) => start + i);
      await withSession(
        async (session) => {
          const status = statusLine();
          const profiles = await getBatchPersonProfiles(session, ids, {
            courseId: opts.course ? Number(opts.course) : undefined,
            concurrency: 4,
            onProgress: ({ done, total, label }) =>
              status.set(`perfil ${done}/${total} · id ${label}`),
          });
          status.done();

          const filtered = opts.teachers
            ? profiles.filter((p) => /profesor|docente|teacher/i.test(p.role ?? ""))
            : profiles;

          if (opts.json) return out(JSON.stringify(filtered, null, 2));

          out(banner("Perfiles", `${filtered.length} de ${ids.length} ids escaneados (${start}–${end})`));
          if (opts.teachers) out(c.dim(`  filtrado: sólo docentes`));
          out();
          for (const prof of filtered) {
            const isTeacher = /profesor|docente|teacher/i.test(prof.role ?? "");
            const roleTag = isTeacher ? c.boldYellow(` [${prof.role}]`) : prof.role ? c.dim(` [${prof.role}]`) : "";
            out(`${mark.arrow()} ${c.bold(prof.name)}${roleTag}  ${c.dim(`id ${prof.userId}`)}`);
            out(`  ${c.dim("correo:")} ${prof.email ? c.cyan(prof.email) : c.gray("no visible")}`);
            if (prof.lastAccessAt) out(`  ${c.dim("visto:")}  ${prof.lastAccessAt}`);
            out(`  ${c.dim("cursos:")} ${c.bold(String(prof.courses.length))}`);
            for (const cr of prof.courses) {
              out(`    ${mark.bullet()} ${cr.subject}${cr.group ? c.dim(` · ${cr.group}`) : ""} ${c.gray(`(id ${cr.courseId})`)}`);
            }
            out();
          }
          if (!filtered.length) {
            log(c.dim("  No se encontraron perfiles válidos en el rango."));
          }
        },
        { login: { onStatus: log } },
      );
      return;
    }

    // --- Single userId (existente) ---
    if (!userId) {
      log(`${mark.err()} Especifica un userId o usa --from/--to para escanear un rango.`);
      return;
    }
    await withSession(
      async (session) => {
        let prof;
        if (opts.course) {
          prof = await getPersonProfile(session, Number(userId), Number(opts.course));
        } else {
          const status = statusLine();
          status.set("buscando un curso en común…");
          try {
            prof = await getPersonProfileAuto(session, Number(userId));
          } finally {
            status.done();
          }
        }
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

// Comando especial para scrapear cursos por rango de ID
program
  .command("scan-courses")
  .description(
    "Escanea cursos por rango de ID en /SEMESTRE/enrol/index.php?id=N. Guarda resultados en DB local (~/.dutic/courses-db.json).",
  )
  .requiredOption("--from <id>", "ID inicial del curso")
  .requiredOption("--to <id>", "ID final del curso (inclusive)")
  .option("--concurrency <n>", "Peticiones paralelas (cuidado: > 4 puede ser bloqueado).", "3")
  .option("--delay <ms>", "Pausa en ms entre lotes de peticiones.", "300")
  .option("--refresh", "Re-escanea aunque el ID ya esté en la DB local.")
  .option("--json", "Salida en JSON")
  .action(async (opts) => {
    const from = Number(opts.from);
    const to = Number(opts.to);
    const concurrency = Math.max(1, Number(opts.concurrency) || 3);
    const delay = Math.max(0, Number(opts.delay) || 300);
    if (!from || !to || from > to) {
      log(`${mark.err()} Especifica --from y --to válidos (from <= to)`);
      return;
    }

    await withSession(
      async (session) => {
        const semester = getSemester();
        const allResults: CourseRecord[] = [];
        const spin = statusLine();

        // ── Separar IDs que ya están en DB de los que hay que escanear ──
        const idsToScan: number[] = [];
        const cachedResults: CourseRecord[] = [];
        const allIds = Array.from({ length: to - from + 1 }, (_, i) => from + i);

        if (!opts.refresh) {
          for (const id of allIds) {
            const cached = await getCachedCourse(id);
            if (cached) cachedResults.push(cached);
            else idsToScan.push(id);
          }
        } else {
          idsToScan.push(...allIds);
        }

        const total = allIds.length;
        const cached = cachedResults.length;
        const toFetch = idsToScan.length;

        if (!opts.json) {
          out(
            banner(
              "Scan de cursos",
              `IDs ${from}–${to} · ${total} total · semestre ${semester}`,
            ),
          );
          if (cached > 0) {
            out(
              `  ${c.dim(`DB local: ${cached} ya conocidos · ${toFetch} a escanear · concurrencia: ${concurrency} · delay: ${delay}ms`)}\n`,
            );
          } else {
            out(`  ${c.dim(`${toFetch} a escanear · concurrencia: ${concurrency} · delay: ${delay}ms`)}\n`);
          }
        }

        // Mostrar los ya cacheados directamente
        for (const rec of cachedResults.sort((a, b) => a.id - b.id)) {
          allResults.push(rec);
          if (!opts.json) {
            const teacherStr = rec.teachers.length ? c.dim(" · " + rec.teachers.join(", ")) : "";
            const enrollMark = rec.enrolled ? c.green(" [matrícula abierta]") : "";
            const cacheTag = c.dim(" [DB]");
            out(
              `  ${c.dim(String(rec.id).padStart(5))} ${rec.name ? c.bold(rec.name) : c.gray("(sin nombre)")}${teacherStr}${enrollMark}${cacheTag}`,
            );
          }
        }

        // ── Escanear los que faltan ──
        // scanOne NO imprime: devuelve el registro y la línea a mostrar.
        // Así el status spinner nunca se mezcla con output.
        async function scanOne(id: number): Promise<{ record: CourseRecord; line: string }> {
          const path = `/${semester}/enrol/index.php?id=${id}`;
          try {
            const page = await fetchAulaPage(session, path, "html", 50000);
            const html = page.content;

            // ── Nombre del curso ──
            // Estructura real de Moodle:
            //   <div class="page-header-headings">
            //     <h1 class="h2 mb-0">NOMBRE DEL CURSO</h1>
            //   </div>
            let name: string | null = null;
            const headerM = html.match(/class="page-header-headings"[^>]*>[\s\S]*?<h1[^>]*>([^<]+)<\/h1>/i);
            if (headerM) {
              name = headerM[1].trim() || null;
            }
            // Fallback: <h3 class="coursename"><a ...>NOMBRE</a>
            if (!name) {
              const h3M = html.match(/class="coursename"[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/i);
              if (h3M) name = h3M[1].trim() || null;
            }

            // ── Docentes ──
            // Estructura real:
            //   <ul class="teachers">
            //     <li><span>Profesor: </span><a href="...">NOMBRE APELLIDO</a></li>
            //   </ul>
            const teachers: string[] = [];
            const teachersBlockM = html.match(/<ul\s+class="teachers">([\s\S]*?)<\/ul>/i);
            if (teachersBlockM) {
              const anchors = teachersBlockM[1].matchAll(/<a\s+href="[^"]*\/user\/profile[^"]*">([^<]+)<\/a>/gi);
              for (const a of anchors) {
                const t = a[1].trim();
                if (t) teachers.push(t);
              }
            }

            // ── Matrícula abierta ──
            // La página muestra "No se puede auto matricular" si está cerrado,
            // o un formulario de inscripción si está abierto.
            const canEnrol = !/No se puede auto matricular/i.test(html) &&
              /class="enrolmentplugins"|enrol_self|enrol_manual|Acceso de huésped/i.test(html);

            const record: CourseRecord = {
              id,
              name,
              teachers,
              enrolled: canEnrol,
              semester,
              status: page.status,
              scannedAt: Date.now(),
            };

            const teacherStr = teachers.length ? c.dim(" · " + teachers.join(", ")) : "";
            const enrollMark = canEnrol ? c.green(" [matrícula abierta]") : "";
            const line = `  ${c.dim(String(id).padStart(5))} ${
              name ? c.bold(name) : c.gray("(sin nombre)")
            }${teacherStr}${enrollMark}`;

            return { record, line };
          } catch (e: any) {
            const record: CourseRecord = {
              id,
              name: null,
              teachers: [],
              enrolled: false,
              semester,
              status: 0,
              error: e.message as string,
              scannedAt: Date.now(),
            };
            const line = `  ${c.dim(String(id).padStart(5))} ${c.boldRed("ERROR")} ${c.dim(e.message)}`;
            return { record, line };
          }
        }

        let done = 0;
        const newRecords: CourseRecord[] = [];

        for (let i = 0; i < idsToScan.length; i += concurrency) {
          const batch = idsToScan.slice(i, i + concurrency);
          // Actualiza el spinner ANTES de lanzar las peticiones
          spin.set(`escaneando ${done + 1}–${Math.min(done + batch.length, toFetch)} de ${toFetch} nuevos…`);

          // Esperar todo el lote
          const batchResults = await Promise.all(batch.map(scanOne));

          // Limpiar el spinner y luego imprimir — sin interleaving
          spin.done();
          for (const { record, line } of batchResults.sort((a, b) => a.record.id - b.record.id)) {
            allResults.push(record);
            newRecords.push(record);
            if (!opts.json) out(line);
          }

          done += batch.length;

          if (i + concurrency < idsToScan.length && delay > 0) {
            await new Promise((r) => setTimeout(r, delay));
          }
        }

        // Guardar nuevos en la DB local y sincronizar con Supabase
        if (newRecords.length > 0) {
          await saveCoursesToDb(newRecords);
          // Sync a Supabase: silencioso, usa userId de sesión si hay perfil disponible
          const { loadSession } = await import("../core/session.js");
          const sess = await loadSession().catch(() => null);
          const userId = (sess as any)?.userId as number | undefined;
          await syncScannedCoursesToSupabase(
            userId ?? 0,
            newRecords.map((r) => ({
              id: r.id,
              name: r.name,
              teachers: r.teachers,
              semester: r.semester,
            })),
          );
        }

        if (opts.json) {
          out(JSON.stringify(allResults.sort((a, b) => a.id - b.id), null, 2));
        } else {
          const found = allResults.filter((r) => r.name).length;
          const savedNew = newRecords.filter((r) => r.name).length;
          out(`\n${mark.ok()} ${c.bold(String(found))} cursos con nombre de ${total} IDs.`);
          if (savedNew > 0)
            out(
              `  ${c.dim(`${savedNew} nuevos guardados en DB · próximo scan de estos IDs usará la DB local`)}`,
            );
        }
      },
      { login: { onStatus: log } },
    );
  });

const coursesDb = program
  .command("courses-db")
  .description("Gestiona la base de datos local de cursos escaneados (~/.dutic/courses-db.json).");

coursesDb
  .command("info")
  .description("Muestra estadísticas de la DB local.")
  .action(async () => {
    const info = await coursesDbInfo();
    out(banner("Courses DB", "base de datos local"));
    out(`  ${c.dim("total:")}     ${info.total} registros`);
    out(`  ${c.dim("con nombre:")} ${info.withName}`);
    out(`  ${c.dim("archivo:")}   ${c.gray(info.file)}`);
  });

coursesDb
  .command("list")
  .description("Lista todos los cursos guardados en la DB.")
  .option("--json", "Salida en JSON")
  .option("--with-name", "Sólo los que tienen nombre.")
  .action(async (opts) => {
    const db = await loadCoursesDb();
    let entries = Object.values(db).sort((a, b) => a.id - b.id);
    if (opts.withName) entries = entries.filter((e) => e.name);
    if (opts.json) { out(JSON.stringify(entries, null, 2)); return; }
    out(banner("Courses DB", `${entries.length} registros`));
    out();
    out(
      table(
        [
          { header: "id", align: "right", color: c.dim },
          { header: "nombre" },
          { header: "docente(s)", color: c.dim },
          { header: "semestre", color: c.dim },
          { header: "escaneado", color: c.dim },
        ],
        entries.map((e) => [
          String(e.id),
          e.name?.slice(0, 42) ?? c.gray("(sin nombre)"),
          e.teachers.join(", ") || "—",
          e.semester,
          new Date(e.scannedAt).toLocaleDateString("es-PE"),
        ]),
      ),
    );
  });

coursesDb
  .command("clear")
  .description("Borra toda la DB de cursos.")
  .action(async () => {
    const n = await clearCoursesDb();
    out(`${mark.ok()} DB borrada (${n} registros eliminados).`);
  });

program
  .command("search <query>")
  .description("Busca cursos o docentes en la base de datos local.")
  .option("--json", "Salida en JSON")
  .action(async (query, opts) => {
    const db = await loadCoursesDb();
    const q = query.toLowerCase();
    const results = Object.values(db).filter((e) => {
      const matchName = e.name && e.name.toLowerCase().includes(q);
      const matchTeacher = e.teachers.some((t) => t.toLowerCase().includes(q));
      return matchName || matchTeacher;
    }).sort((a, b) => a.id - b.id);

    if (opts.json) {
      out(JSON.stringify(results, null, 2));
      return;
    }

    out(banner("Búsqueda", `"${query}" · ${results.length} resultados`));
    out();
    if (results.length === 0) {
      out(`  No se encontraron coincidencias.`);
      out(`  (Tip: usa 'dutic scan-courses' para alimentar tu base de datos local)`);
      return;
    }

    out(
      table(
        [
          { header: "id", align: "right", color: c.dim },
          { header: "nombre" },
          { header: "docente(s)", color: c.yellow },
          { header: "semestre", color: c.dim },
        ],
        results.map((e) => [
          String(e.id),
          e.name ? e.name.slice(0, 45) : c.gray("(sin nombre)"),
          e.teachers.join(", ") || "—",
          e.semester,
        ])
      )
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

function renderSisacad(cap: SisacadCapture): void {
  out(banner("SISACAD · Notas parciales", cap.header ?? `capturado ${new Date(cap.capturedAt).toLocaleString("es-PE")}`));
  if (!cap.courses.length) {
    out(`${mark.warn()} No se pudo estructurar la tabla de notas. Tablas capturadas: ${cap.tables.length}.`);
    out(c.dim("  Usa `dutic sisacad show --json` para ver el contenido crudo."));
    return;
  }
  for (const course of cap.courses) {
    out("\n" + rule(course.subject + (course.group ? ` (Grupo ${course.group})` : "")));
    out(
      table(
        [
          { header: "parcial" },
          { header: "nota", align: "right" },
          { header: "peso", align: "right", color: c.dim },
          { header: "ausente", color: c.dim },
        ],
        course.items.map((it) => [
          it.parcial,
          it.grade != null ? gradeColor(String(it.grade), "0-20")(String(it.grade)) : c.gray("—"),
          it.weight != null ? `${it.weight}%` : "—",
          it.absent ? c.yellow("Sí") : "No",
        ]),
      ),
    );
    const avgStr = course.weightedAverageSoFar != null ? course.weightedAverageSoFar.toFixed(2) : "—";
    const avgPainted =
      course.weightedAverageSoFar != null ? gradeColor(avgStr, "0-20")(avgStr) : c.gray(avgStr);
    out(
      `  ${c.bold("Promedio ponderado hasta ahora:")} ${avgPainted}` +
        `  ${c.dim(`(${course.weightSoFar}% del curso calificado${course.complete ? ", completo" : ""})`)}`,
    );
  }
}

const sisacad = program
  .command("sisacad")
  .description("Integra tus notas de SISACAD (consulta de notas parciales UNSA). Tú haces el login+CAPTCHA.");
sisacad
  .action(async () => {
    log(c.dim("Se abrirá SISACAD. Ingresa con tu usuario/clave y resuelve el CAPTCHA; el resto es automático."));
    const cap = await captureSisacadGrades({ onStatus: log });
    renderSisacad(cap);
  });
sisacad
  .command("show")
  .description("Muestra las notas de SISACAD ya capturadas (sin abrir el navegador).")
  .option("--json", "Salida en JSON.")
  .action(async (opts) => {
    const cap = await loadSisacadGrades();
    if (!cap) {
      out(`${mark.warn()} No hay notas de SISACAD guardadas. Ejecuta ${c.cyan("dutic sisacad")}.`);
      return;
    }
    if (opts.json) {
      out(JSON.stringify(cap, null, 2));
      return;
    }
    renderSisacad(cap);
  });
sisacad
  .command("compare")
  .description("Compara el promedio de SISACAD con el total que calcula Moodle, por curso.")
  .option("--json", "Salida en JSON.")
  .action(async (opts) => {
    const cap = await loadSisacadGrades();
    if (!cap) {
      out(`${mark.warn()} No hay notas de SISACAD guardadas. Ejecuta ${c.cyan("dutic sisacad")}.`);
      return;
    }
    await withSession(
      async (session) => {
        const moodleGrades = await getAllGrades(session);
        const diffs = compareSisacadWithMoodle(
          cap.courses,
          moodleGrades.map((g) => ({ courseName: g.courseName, total: g.total })),
        );
        if (opts.json) return out(JSON.stringify(diffs, null, 2));
        out(banner("SISACAD vs. Moodle", "comparación por curso"));
        out(
          table(
            [
              { header: "curso" },
              { header: "sisacad", align: "right" },
              { header: "moodle", align: "right" },
              { header: "diferencia", align: "right" },
            ],
            diffs.map((d) => [
              d.subject,
              d.sisacadAverage != null ? d.sisacadAverage.toFixed(2) : "—",
              d.moodleTotal ?? "—",
              d.diff != null
                ? d.diff > 0.5
                  ? c.boldYellow(`± ${d.diff.toFixed(2)}`)
                  : c.green("≈ igual")
                : c.gray("no comparable"),
            ]),
          ),
        );
        log(c.dim("\nUna diferencia grande puede deberse a ítems que Moodle aún no registra, o a ponderaciones distintas."));
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

registerSaasCommands(program);

program.parseAsync(process.argv).catch((err) => {
  log(`${mark.err()} ${err?.message ?? err}`);
  process.exitCode = 1;
});
