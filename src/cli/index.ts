#!/usr/bin/env node
import { Command } from "commander";
import { ensureSession, withSession } from "../core/auth.js";
import { loginWithPlaywright } from "../core/login.js";
import { getSemester } from "../core/config.js";
import { isExpired, isValid, loadSession } from "../core/session.js";
import { getEnrolledCourses } from "../domain/courses.js";
import {
  getAllTasks,
  getCourseTasks,
  getUpcomingTasks,
} from "../domain/tasks.js";
import {
  downloadFile,
  listCourseFiles,
  pullCourseFiles,
} from "../domain/resources.js";
import { formatTaskLine } from "./format.js";

const log = (msg: string) => process.stderr.write(msg + "\n");

const program = new Command();
program
  .name("dutic")
  .description("CLI del aula virtual DUTIC (Moodle UNSA): tareas, cursos y recursos.")
  .version("0.1.0");

program
  .command("login")
  .description("Inicia sesión con Google y guarda la sesión de Moodle.")
  .action(async () => {
    await loginWithPlaywright({ headless: false, onStatus: log });
    log("✅ Sesión guardada.");
  });

program
  .command("status")
  .description("Muestra el estado de la sesión y el semestre.")
  .action(async () => {
    const s = await loadSession();
    console.log(`Semestre configurado: ${getSemester()}`);
    if (!s) {
      console.log("Sesión: ninguna. Ejecuta `dutic login`.");
      return;
    }
    console.log(`Sitio: ${s.siteUrl}`);
    console.log(`Capturada: ${new Date(s.capturedAt).toLocaleString("es-PE")}`);
    console.log(
      `Estado: ${isValid(s) ? "✅ válida" : isExpired(s) ? "⏰ caducada" : "⚠️ incompleta"}`,
    );
  });

program
  .command("tasks")
  .description("Lista tus tareas. Por defecto las próximas del calendario.")
  .option("--all", "Barre todos los cursos para incluir tareas ocultas.")
  .option("--hidden", "Muestra sólo las tareas ocultas (implica --all).")
  .option("--fast", "No scrapear el estado de entrega de cada tarea (más rápido).")
  .option("--json", "Salida en JSON.")
  .action(async (opts) => {
    await withSession(
      async (session) => {
        if (opts.all || opts.hidden) {
          const { tasks, scanErrors } = await getAllTasks(session, { enrich: !opts.fast });
          const list = opts.hidden ? tasks.filter((t) => t.hidden) : tasks;
          if (opts.json) {
            console.log(JSON.stringify({ tasks: list, scanErrors }, null, 2));
            return;
          }
          console.log(`\n${list.length} tarea(s)${opts.hidden ? " ocultas" : ""}:\n`);
          for (const t of list) console.log(formatTaskLine(t) + "\n");
          if (scanErrors.length) {
            log(`\n⚠️ ${scanErrors.length} curso(s) no se pudieron barrer:`);
            for (const e of scanErrors) log(`   - ${e.courseName}: ${e.reason}`);
          }
        } else {
          const list = await getUpcomingTasks(session);
          if (opts.json) {
            console.log(JSON.stringify(list, null, 2));
            return;
          }
          console.log(`\n${list.length} tarea(s) próxima(s):\n`);
          for (const t of list) console.log(formatTaskLine(t) + "\n");
          log("💡 Usa `dutic tasks --all` para incluir tareas ocultas (no publicadas en el calendario).");
        }
      },
      { mode: "interactive", login: { onStatus: log } },
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
        if (opts.json) {
          console.log(JSON.stringify(courses, null, 2));
          return;
        }
        console.log(`\n${courses.length} curso(s):\n`);
        for (const c of courses) {
          console.log(`[${c.id}] ${c.fullname}`);
          if (c.contacts.length) console.log(`      Docente(s): ${c.contacts.join(", ")}`);
        }
      },
      { login: { onStatus: log } },
    );
  });

const course = program.command("course").description("Operaciones sobre un curso.");

course
  .command("tasks <courseId>")
  .description("Tareas de un curso (incluye ocultas).")
  .option("--fast", "No scrapear el estado de entrega de cada tarea.")
  .option("--json", "Salida en JSON.")
  .action(async (courseId, opts) => {
    await withSession(
      async (session) => {
        const list = await getCourseTasks(session, Number(courseId), "", {
          enrich: !opts.fast,
        });
        if (opts.json) {
          console.log(JSON.stringify(list, null, 2));
          return;
        }
        console.log(`\n${list.length} tarea(s) en el curso ${courseId}:\n`);
        for (const t of list) console.log(formatTaskLine(t) + "\n");
      },
      { login: { onStatus: log } },
    );
  });

course
  .command("files <courseId>")
  .description("Archivos/recursos de un curso.")
  .option("--json", "Salida en JSON.")
  .action(async (courseId, opts) => {
    await withSession(
      async (session) => {
        const files = await listCourseFiles(session, Number(courseId));
        if (opts.json) {
          console.log(JSON.stringify(files, null, 2));
          return;
        }
        console.log(`\n${files.length} recurso(s) en el curso ${courseId}:\n`);
        for (const f of files) console.log(`[${f.modname}] ${f.filename}\n     ${f.fileurl}`);
      },
      { login: { onStatus: log } },
    );
  });

program
  .command("download <url> <dest>")
  .description("Descarga un archivo por su URL a la ruta destino.")
  .action(async (url, dest) => {
    await withSession(
      async (session) => {
        const r = await downloadFile(session, url, dest);
        console.log(`✅ Descargado ${r.bytes} bytes → ${r.path}`);
      },
      { login: { onStatus: log } },
    );
  });

program
  .command("pull <courseId>")
  .description("Descarga todos los recursos de un curso.")
  .option("--dest <dir>", "Directorio destino.", "./descargas")
  .action(async (courseId, opts) => {
    await withSession(
      async (session) => {
        const results = await pullCourseFiles(session, Number(courseId), opts.dest);
        console.log(`✅ ${results.length} archivo(s) descargado(s) en ${opts.dest}`);
        for (const r of results) console.log(`   - ${r.path}`);
      },
      { login: { onStatus: log } },
    );
  });

program.parseAsync(process.argv).catch((err) => {
  log(`❌ ${err?.message ?? err}`);
  process.exitCode = 1;
});
