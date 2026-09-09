import type { Command } from "commander";
import { withSession } from "../core/auth.js";
import { humanizeAgo } from "../core/dates.js";
import {
  findCategories,
  getCategoryTree,
  groupByTeacher,
  listSchoolCourses,
} from "../domain/catalog.js";
import {
  addDashboardBlock,
  getDashboardState,
  listAddableBlocks,
  removeDashboardBlock,
} from "../domain/dashboard.js";
import { getOnlinePresence, matchOnline, type OnlinePresence } from "../domain/presence.js";
import { banner, c, mark, statusLine, table } from "./ui.js";

const out = (msg = "") => process.stdout.write(msg + "\n");
const log = (msg: string) => process.stderr.write(msg + "\n");

/** Antigüedad de la última señal, en la forma más corta que sigue siendo exacta. */
function idleLabel(seconds: number | null, raw: string): string {
  if (seconds === null) return raw || "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}min`;
  return `${Math.round(seconds / 3600)}h`;
}

function printPresence(p: OnlinePresence): void {
  if (!p.blockPresent) {
    out(`${mark.err()} El Dashboard no tiene el bloque "Usuarios en línea".`);
    out(`  ${mark.arrow()} ${c.cyan("dutic dashboard add online_users")} lo añade.`);
    return;
  }
  out(
    banner(
      "Usuarios en línea",
      `${p.total ?? "?"} conectados · ventana ${p.windowMinutes ?? "?"} min`,
    ),
  );
  if (p.users.length === 0) {
    out(`${mark.warn()} Ninguno de tus contactos de curso está conectado ahora mismo.`);
  } else {
    out(
      table(
        [{ header: "Persona" }, { header: "Visto", align: "right" }, { header: "id", color: c.dim }],
        p.users.map((u) => [
          (u.isMe ? `${c.green("*")} ` : "  ") + u.name,
          idleLabel(u.idleSeconds, u.idle),
          String(u.id),
        ]),
      ),
    );
  }
  // Las dos cifras miden cosas distintas y confundirlas sería mentir sobre el aula.
  out(
    `\n${c.dim("nombrados:")} ${p.users.length} (gente con la que compartes curso) · ` +
      `${c.dim("anónimos para ti:")} ${p.hiddenCount}`,
  );
  if (p.myVisibility) {
    out(
      p.myVisibility === "visible"
        ? `${c.dim("tu estado:")} los demás te ven conectado`
        : `${c.dim("tu estado:")} ${c.yellow("oculto")} para los demás`,
    );
  }
}

export function registerAulaCommands(program: Command): void {
  program
    .command("online [persona]")
    .description("Quién está conectado ahora mismo en el aula (bloque del Dashboard).")
    .option("--json", "Salida en JSON.")
    .action(async (persona: string | undefined, opts: { json?: boolean }) => {
      await withSession(
        async (session) => {
          const presence = await getOnlinePresence(session);
          if (persona) {
            const hits = matchOnline(presence, persona);
            if (opts.json) {
              out(JSON.stringify({ query: persona, online: hits.length > 0, matches: hits }, null, 2));
              return;
            }
            if (hits.length === 0) {
              out(`${mark.warn()} "${persona}" no aparece conectado.`);
              // Ausente del bloque NO es lo mismo que desconectado: puede estar entre los anónimos.
              out(
                c.dim(
                  `  El bloque sólo nombra a quien comparte curso contigo; hay ${presence.hiddenCount} ` +
                    "conectados que no puede identificar.",
                ),
              );
              return;
            }
            for (const u of hits) {
              out(
                `${mark.ok()} ${c.bold(u.name)} conectado · última señal hace ${idleLabel(u.idleSeconds, u.idle)}`,
              );
              out(`  ${c.dim(u.profileUrl)}`);
            }
            return;
          }
          if (opts.json) {
            out(JSON.stringify(presence, null, 2));
            return;
          }
          printPresence(presence);
        },
        { login: { onStatus: log } },
      );
    });

  const escuela = program
    .command("escuela")
    .alias("escuelas")
    .description("Explora las Escuelas del aula y sus cursos, aunque no estés matriculado.");

  escuela
    .command("list", { isDefault: true })
    .alias("ls")
    .description("Lista las Escuelas y áreas del semestre.")
    .option("--json", "Salida en JSON.")
    .option("--areas", "Mostrar también las áreas y el período, no sólo las Escuelas.")
    .action(async (opts: { json?: boolean; areas?: boolean }) => {
      await withSession(
        async (session) => {
          const status = statusLine();
          status.set("leyendo el árbol de categorías…");
          const tree = await getCategoryTree(session);
          status.done();
          if (opts.json) {
            out(JSON.stringify(tree, null, 2));
            return;
          }
          const byId = new Map(tree.categories.map((cat) => [cat.id, cat]));
          const shown = tree.categories.filter((cat) => (opts.areas ? true : cat.depth === 3));
          out(
            banner(
              "Escuelas",
              `${tree.categories.filter((cat) => cat.depth === 3).length} · actualizado ${humanizeAgo((Date.now() - tree.fetchedAt) / 1000)}`,
            ),
          );
          out(
            table(
              [{ header: "id", align: "right" }, { header: "Nombre" }, { header: "Área", color: c.dim }],
              shown
                .sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name))
                .map((cat) => [
                  String(cat.id),
                  cat.name,
                  cat.parentId ? (byId.get(cat.parentId)?.name ?? "—") : "—",
                ]),
            ),
          );
          out(`\n${mark.arrow()} ${c.cyan("dutic escuela cursos ECONOMÍA")} lista sus cursos y docentes.`);
        },
        { login: { onStatus: log } },
      );
    });

  escuela
    .command("cursos <escuela>")
    .alias("courses")
    .description("Cursos de una Escuela con su docente (nombre o id de categoría).")
    .option("--json", "Salida en JSON.")
    .option("--no-docentes", "Sólo los cursos, sin resolver docentes (una petición menos).")
    .option("--deep", "Abrir la ficha de los cursos que quedaron sin docente (lento).")
    .option("--por-docente", "Agrupar por profesor en vez de por curso.")
    .action(
      async (
        query: string,
        opts: { json?: boolean; docentes?: boolean; deep?: boolean; porDocente?: boolean },
      ) => {
        await withSession(
          async (session) => {
            const status = statusLine();
            status.set("buscando la Escuela…");
            const tree = await getCategoryTree(session);
            const hits = findCategories(tree, query);
            status.done();

            if (hits.length === 0) {
              out(`${mark.err()} No hay ninguna Escuela que coincida con "${query}".`);
              out(`  ${mark.arrow()} ${c.cyan("dutic escuela list")} las muestra todas.`);
              process.exitCode = 1;
              return;
            }
            if (hits.length > 1 && hits[0].depth !== 3) {
              out(`${mark.warn()} "${query}" coincide con varias categorías:`);
              for (const h of hits.slice(0, 8)) out(`   ${h.id}  ${h.name}`);
              out(`  ${mark.arrow()} Repite con el id exacto.`);
              process.exitCode = 1;
              return;
            }

            const target = hits[0];
            const spin = statusLine();
            spin.set(`leyendo ${target.name}…`);
            const school = await listSchoolCourses(session, target.id, {
              teachers: opts.docentes !== false,
              deep: opts.deep,
            });
            spin.done();

            if (opts.json) {
              out(JSON.stringify(opts.porDocente ? groupByTeacher(school) : school, null, 2));
              return;
            }

            out(
              banner(
                school.categoryName,
                `${school.courses.length} cursos · ${school.withTeachers} con docente`,
              ),
            );
            out(c.dim(`  ${school.path.join(" › ")}`));

            if (opts.porDocente) {
              const grupos = groupByTeacher(school);
              out(
                table(
                  [
                    { header: "Docente" },
                    { header: "Cursos", align: "right" },
                    { header: "Asignaturas", color: c.dim },
                  ],
                  grupos.map((g) => [
                    g.teacher.name,
                    String(g.courses.length),
                    [...new Set(g.courses.map((cur) => cur.subject))].join(", ").slice(0, 60),
                  ]),
                ),
              );
              return;
            }

            out(
              table(
                [
                  { header: "id", align: "right", color: c.dim },
                  { header: "Asignatura" },
                  { header: "Grupo", color: c.dim },
                  { header: "Docente", color: c.cyan },
                ],
                school.courses.map((cur) => [
                  String(cur.id),
                  cur.subject,
                  cur.group ?? "—",
                  cur.teachers.map((t) => t.name).join("; ") || "—",
                ]),
              ),
            );
            if (school.withTeachers < school.courses.length && !opts.deep) {
              out(
                `\n${mark.warn()} ${school.courses.length - school.withTeachers} sin docente publicado. ` +
                  `${c.cyan("--deep")} abre su ficha una a una para intentarlo.`,
              );
            }
          },
          { login: { onStatus: log } },
        );
      },
    );

  const dash = program
    .command("dashboard")
    .description("Bloques del Dashboard: qué información renderiza el aula en /my/.");

  dash
    .command("list", { isDefault: true })
    .alias("ls")
    .description("Bloques puestos ahora mismo y cuáles se pueden añadir.")
    .option("--json", "Salida en JSON.")
    .option("--disponibles", "Consultar también el catálogo de bloques añadibles.")
    .action(async (opts: { json?: boolean; disponibles?: boolean }) => {
      await withSession(
        async (session) => {
          const state = await getDashboardState(session);
          const addable = opts.disponibles ? await listAddableBlocks(session) : null;
          if (opts.json) {
            out(JSON.stringify({ ...state, addable }, null, 2));
            return;
          }
          out(banner("Dashboard", `${state.blocks.length} bloques`));
          out(
            table(
              [{ header: "Bloque" }, { header: "Título", color: c.dim }, { header: "inst.", color: c.dim }],
              state.blocks.map((b) => [b.name, b.title || "—", String(b.instanceId)]),
            ),
          );
          if (addable) {
            out(`\n${c.dim("añadibles:")}`);
            out(
              table(
                [{ header: "Bloque" }, { header: "Título", color: c.dim }],
                addable.map((b) => [b.name, b.title || "—"]),
              ),
            );
            out(`\n${mark.arrow()} ${c.cyan("dutic dashboard add <bloque>")}`);
          } else {
            out(`\n${mark.arrow()} ${c.cyan("dutic dashboard list --disponibles")} para ver qué más se puede añadir.`);
          }
        },
        { login: { onStatus: log } },
      );
    });

  dash
    .command("add <bloque>")
    .description("Añade un bloque al Dashboard (p.ej. online_users, completion_progress).")
    .action(async (bloque: string) => {
      await withSession(
        async (session) => {
          const r = await addDashboardBlock(session, bloque);
          out(`${r.changed ? mark.ok() : mark.warn()} ${r.reason}`);
          out(c.dim(`  bloques: ${r.blocks.map((b) => b.name).join(", ")}`));
        },
        { login: { onStatus: log } },
      );
    });

  dash
    .command("remove <bloque>")
    .alias("rm")
    .description("Quita un bloque del Dashboard.")
    .action(async (bloque: string) => {
      await withSession(
        async (session) => {
          const r = await removeDashboardBlock(session, bloque);
          out(`${r.changed ? mark.ok() : mark.warn()} ${r.reason}`);
          out(c.dim(`  bloques: ${r.blocks.map((b) => b.name).join(", ")}`));
        },
        { login: { onStatus: log } },
      );
    });
}
