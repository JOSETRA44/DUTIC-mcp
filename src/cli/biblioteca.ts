import type { Command } from "commander";
import { humanizeAgo } from "../core/dates.js";
import { libraryService } from "../biblioteca/composition.js";
import type { Availability, BiblioRecord, Fetched, SearchField, SearchPage } from "../biblioteca/domain/entities.js";
import { DEFAULT_LIMIT, MAX_LIMIT } from "../biblioteca/domain/query.js";
import { banner, c, mark, rule, statusLine, table } from "./ui.js";

const out = (msg = "") => process.stdout.write(msg + "\n");

/** Nombres en español del CLI → campos del dominio. */
const FIELDS: Record<string, SearchField> = {
  cualquiera: "any",
  titulo: "title",
  autor: "author",
  tema: "subject",
  isbn: "isbn",
};

/** Opciones globales (--refresh / --no-cache) declaradas en el programa raíz. */
function globalOpts(cmd: Command): { refresh: boolean; cache: boolean } {
  const o = cmd.optsWithGlobals() as { refresh?: boolean; cache?: boolean };
  return { refresh: Boolean(o.refresh), cache: o.cache !== false };
}

/**
 * Spinner con segundos transcurridos. El OPAC tarda ~11 s por petición: ver el contador
 * avanzar evita que el usuario crea que el comando se colgó.
 */
async function withElapsed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const status = statusLine();
  const t0 = Date.now();
  const tick = () => status.set(`${label} ${c.dim(`${((Date.now() - t0) / 1000).toFixed(0)} s`)}`);
  tick();
  const timer = setInterval(tick, 250);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    status.done();
  }
}

function availabilityLine(a: Availability): string {
  switch (a.state) {
    case "available":
      return a.holdings
        .map((h) => `${c.green("disponible")} ${h.branch ?? c.gray("sede no registrada")}${h.callNumber ? c.dim(` · ${h.callNumber}`) : ""}${h.count ? c.dim(` (${h.count})`) : ""}`)
        .join("\n      ");
    case "no_items":
      return c.gray("sin ejemplares físicos");
    case "unavailable":
      return c.yellow(a.notes.join("; ") || "no disponible");
    default:
      return c.gray("disponibilidad desconocida");
  }
}

function provenance<T>(f: Fetched<T>, elapsedMs: number): string {
  const ago = humanizeAgo((Date.now() - f.fetchedAt) / 1000);
  if (f.source === "network") return c.dim(`OPAC en ${(elapsedMs / 1000).toFixed(1)} s`);
  const base = c.dim(`de caché (${ago})`);
  if (f.warning) return `${base} ${mark.warn()} ${c.yellow(`el OPAC falló: ${f.warning}`)}`;
  return f.stale ? `${base} ${c.yellow("· puede estar desactualizada, usa --refresh")}` : base;
}

function renderSearch(f: Fetched<SearchPage>, elapsedMs: number): void {
  const page = f.data;
  out(banner("Biblioteca Virtual UNSA", `"${page.query.text}" · ${page.total} resultado(s)`));
  if (page.results.length === 0) {
    out(`${mark.info()} Sin resultados. Prueba con menos palabras o con --por autor / tema.`);
  }
  page.results.forEach((r, i) => {
    const n = String(page.query.offset + i + 1).padStart(3);
    out(`\n${c.dim(n + ".")} ${c.bold(r.title)}${r.year ? c.dim(` (${r.year})`) : ""}  ${c.gray(`id ${r.id}`)}`);
    const meta = [r.authors.join("; "), r.edition, r.publisher].filter(Boolean).join(c.dim(" · "));
    if (meta) out(`      ${meta}`);
    out(`      ${availabilityLine(r.availability)}`);
  });
  out("");
  if (page.hasMore) {
    const next = page.query.offset + page.results.length;
    out(`${mark.info()} Mostrando ${page.results.length} de ${page.total}. Más: --limit ${Math.min(MAX_LIMIT, page.query.limit * 2)} o --offset ${next}.`);
  }
  out(provenance(f, elapsedMs));
}

function renderRecord(f: Fetched<BiblioRecord | null>, id: string, elapsedMs: number): void {
  const r = f.data;
  if (!r) {
    out(`${mark.err()} No existe el registro ${id}.`);
    process.exitCode = 1;
    return;
  }
  out(banner(r.title, [r.authors.join("; "), r.year].filter(Boolean).join(" · ")));
  const fields: [string, string | null][] = [
    ["Edición", r.edition],
    ["Editorial", r.publisher],
    ["Descripción", r.description],
    ["ISBN", r.isbn],
    ["Clasificación", r.classification],
    ["Temas", r.subjects.join(" | ") || null],
  ];
  for (const [k, v] of fields) if (v) out(`${c.dim(k.padEnd(14))}${v}`);
  out("\n" + rule(`Ejemplares (${r.items.length})`));
  if (r.items.length === 0) out(c.gray("  Sin ejemplares físicos."));
  else
    out(
      table(
        [{ header: "sede" }, { header: "signatura" }, { header: "estado" }, { header: "vence", color: c.dim }],
        r.items.map((it) => [
          it.branch ?? "—",
          it.callNumber ?? "—",
          it.status === "available" ? c.green(it.statusLabel) : c.yellow(it.statusLabel),
          it.dueDate ?? "",
        ]),
      ),
    );
  out(`\n${c.dim(r.url)}`);
  out(provenance(f, elapsedMs));
}

export function registerBibliotecaCommands(program: Command): void {
  const lib = program
    .command("lib")
    .alias("biblioteca")
    .description(
      "Catálogo de la Biblioteca Virtual UNSA (Koha). El OPAC tarda ~15 s por consulta; " +
        "las repetidas salen de caché al instante.",
    );

  lib
    .command("search")
    .alias("buscar")
    .description("Busca libros en el catálogo, con disponibilidad por sede y signatura.")
    .argument("<texto...>", "Qué buscar.")
    .option("--por <campo>", "cualquiera | titulo | autor | tema | isbn", "cualquiera")
    .option("-n, --limit <n>", `Resultados a traer en UNA petición (máx. ${MAX_LIMIT}).`, String(DEFAULT_LIMIT))
    .option("--offset <n>", "Saltar los primeros N resultados.", "0")
    .option(
      "--fichas <n>",
      "Precarga la ficha de los primeros N resultados (~0.3 s c/u aprovechando la conexión caliente), " +
        "para que `dutic lib show` salga al instante.",
    )
    .option("--json", "Salida en JSON.")
    .action(async (words: string[], opts, cmd: Command) => {
      try {
        const field = FIELDS[String(opts.por).toLowerCase()];
        if (!field) throw new Error(`--por inválido: "${opts.por}". Usa: ${Object.keys(FIELDS).join(", ")}.`);
        const g = globalOpts(cmd);
        const svc = libraryService({ cache: g.cache });
        const t0 = Date.now();
        const res = await withElapsed("consultando la Biblioteca Virtual…", () =>
          svc.search(
            { text: words.join(" "), field, limit: Number(opts.limit), offset: Number(opts.offset) },
            // Proceso corto: una copia vieja se muestra con aviso en vez de dejar el CLI vivo
            // ~15 s más revalidando en segundo plano.
            { refresh: g.refresh, revalidate: "none" },
          ),
        );
        const elapsed = Date.now() - t0;
        // Inmediatamente después de la búsqueda, antes de imprimir nada: la conexión al OPAC sólo
        // sigue caliente ~1 s.
        const fichas = Math.max(0, Math.min(20, Number(opts.fichas ?? 0) || 0));
        let prefetchMs = 0;
        if (fichas > 0) {
          const p0 = Date.now();
          await withElapsed(`precargando ${fichas} ficha(s)…`, () =>
            svc.prefetchRecords(res.data.results.map((r) => r.id), fichas),
          );
          prefetchMs = Date.now() - p0;
        }
        if (opts.json) out(JSON.stringify(res, null, 2));
        else {
          renderSearch(res, elapsed);
          if (fichas > 0) out(c.dim(`${fichas} ficha(s) precargada(s) en ${(prefetchMs / 1000).toFixed(1)} s`));
        }
      } catch (err) {
        out(`${mark.err()} ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  lib
    .command("show")
    .alias("ver")
    .description("Ficha completa de un registro: temas, descripción y cada ejemplar con su estado.")
    .argument("<id>", "Id del registro (biblionumber), el que muestra `dutic lib search`.")
    .option("--json", "Salida en JSON.")
    .action(async (id: string, opts, cmd: Command) => {
      try {
        const g = globalOpts(cmd);
        const t0 = Date.now();
        const res = await withElapsed("abriendo la ficha…", () =>
          libraryService({ cache: g.cache }).getRecord(id, { refresh: g.refresh, revalidate: "none" }),
        );
        if (opts.json) out(JSON.stringify(res, null, 2));
        else renderRecord(res, id, Date.now() - t0);
      } catch (err) {
        out(`${mark.err()} ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  lib
    .command("cache-clear")
    .description("Borra la caché del catálogo (~/.dutic/biblioteca/cache).")
    .action(async () => {
      const n = await libraryService().clearCache();
      out(`${mark.ok()} Caché de la biblioteca borrada (${n} entrada(s)).`);
    });
}
