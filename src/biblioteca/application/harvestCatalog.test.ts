import { test } from "node:test";
import assert from "node:assert/strict";
import type { BiblioSummary } from "../domain/entities.js";
import { LibraryProtocolError, LibraryUnavailableError } from "../domain/errors.js";
import { CatalogHarvester } from "./harvestCatalog.js";
import type {
  CatalogHarvestSource,
  CatalogRepository,
  HarvestBlock,
  HarvestRun,
  HarvestStatus,
} from "./ports.js";

/**
 * El barrido dura horas contra un servidor ajeno y frágil: lo que importa es que reanude
 * donde quedó, que no duplique y que se rinda de forma ordenada. Todo eso se prueba aquí
 * con dobles, sin tocar el OPAC ni Supabase.
 */

const CATALOG_TOTAL = 1_000;

function row(id: number): BiblioSummary {
  return {
    id: String(id),
    title: `Libro ${id}`,
    authors: [],
    edition: null,
    publisher: null,
    year: null,
    isbn: null,
    language: null,
    availability: { state: "unknown", holdings: [], notes: [] },
    url: `http://x/${id}`,
  };
}

/** OPAC falso con el mismo contrato medido: total fijo, orden estable, sin solapes. */
class FakeSource implements CatalogHarvestSource {
  calls: { offset: number; limit: number }[] = [];
  newestCalls = 0;
  failures = 0; // cuántas peticiones seguidas deben fallar
  failWith: Error = new LibraryUnavailableError("timeout");
  total = CATALOG_TOTAL;

  async fetchBlock(offset: number, limit: number): Promise<HarvestBlock> {
    this.calls.push({ offset, limit });
    if (this.failures > 0) {
      this.failures--;
      throw this.failWith;
    }
    const end = Math.min(offset + limit, this.total);
    const results = [];
    for (let i = offset; i < end; i++) results.push(row(i + 1));
    return { total: this.total, results };
  }

  async fetchNewest(limit: number, offset = 0): Promise<HarvestBlock> {
    this.newestCalls++;
    const results = [];
    for (let i = 0; i < limit; i++) results.push(row(this.total - offset - i));
    return { total: this.total, results };
  }
}

/** Repositorio falso: guarda por id (idempotente) y conserva el cursor entre tandas. */
class FakeRepository implements CatalogRepository {
  rows = new Map<string, BiblioSummary>();
  run: HarvestRun = { id: 7, cursorOffset: 0, recordsUpserted: 0, totalExpected: null };
  finished: { status: HarvestStatus; error: string | null; blocksFailed: number }[] = [];
  failIngestOnce = false;

  /** null = "no hay nada que hacer" (el catálogo ya está al día). */
  upToDate = false;

  async startRun(): Promise<HarvestRun | null> {
    return this.upToDate ? null : { ...this.run };
  }

  async ingestBlock(_runId: number, rows: BiblioSummary[], nextOffset: number, total: number | null) {
    if (this.failIngestOnce) {
      this.failIngestOnce = false;
      throw new Error("PostgREST 503");
    }
    for (const r of rows) this.rows.set(r.id, r);
    this.run.cursorOffset = Math.max(this.run.cursorOffset, nextOffset);
    this.run.recordsUpserted += rows.length;
    this.run.totalExpected = total;
    return rows.length;
  }

  async finishRun(_runId: number, status: HarvestStatus, error: string | null = null, blocksFailed = 0) {
    this.finished.push({ status, error, blocksFailed });
  }

  async knownIds(ids: string[]): Promise<Set<string>> {
    return new Set(ids.filter((id) => this.rows.has(id)));
  }
}

function setup(startAt = 0) {
  const source = new FakeSource();
  const repository = new FakeRepository();
  let now = startAt;
  const harvester = new CatalogHarvester({
    source,
    repository,
    clock: { now: () => now },
    // Los reintentos no deben hacer esperar al test: el reloj avanza a mano.
    sleep: async (ms) => {
      now += ms;
    },
  });
  return { source, repository, harvester, advance: (ms: number) => (now += ms) };
}

test("barrido completo: recorre todo el catálogo y termina en done", async () => {
  const { harvester, repository, source } = setup();
  const res = await harvester.run({ blockSize: 250, window: null });

  assert.equal(res.status, "done");
  assert.equal(res.stoppedBy, "complete");
  assert.equal(res.recordsUpserted, CATALOG_TOTAL);
  assert.equal(repository.rows.size, CATALOG_TOTAL);
  assert.equal(res.cursorOffset, CATALOG_TOTAL);
  assert.deepEqual(
    source.calls.map((c) => c.offset),
    [0, 250, 500, 750],
  );
});

test("presupuesto agotado: queda en pausa y la tanda siguiente continúa sin repetir", async () => {
  const source = new FakeSource();
  const repository = new FakeRepository();
  let now = 0;
  const make = () =>
    new CatalogHarvester({
      source,
      repository,
      clock: { now: () => now },
      sleep: async () => {},
    });

  // Cada bloque "cuesta" 10 s de reloj; con 25 s de presupuesto entran 3.
  const tick = { blockSize: 250, window: null, onProgress: () => (now += 10_000) };
  const first = await make().run({ ...tick, budgetMs: 25_000 });
  assert.equal(first.status, "paused");
  assert.equal(first.stoppedBy, "budget");
  assert.equal(first.cursorOffset, 750);

  const second = await make().run({ ...tick, budgetMs: 25_000 });
  assert.equal(second.status, "done");
  assert.equal(second.cursorOffset, CATALOG_TOTAL);
  // Idempotencia: aunque se reprocesara algo, la base tiene exactamente el catálogo.
  assert.equal(repository.rows.size, CATALOG_TOTAL);
  assert.deepEqual(source.calls.map((c) => c.offset), [0, 250, 500, 750]);
});

test("fallo transitorio: reintenta el mismo bloque y sigue", async () => {
  const { harvester, repository, source } = setup();
  source.failures = 1;
  const res = await harvester.run({ blockSize: 500, window: null });

  assert.equal(res.status, "done");
  assert.equal(repository.rows.size, CATALOG_TOTAL);
  // El bloque 0 se pidió dos veces: el reintento no mueve el cursor.
  assert.equal(source.calls.filter((c) => c.offset === 0).length, 2);
});

test("tres bloques fallidos seguidos: se rinde como failed sin perder el cursor", async () => {
  const { harvester, repository, source } = setup();
  source.failures = 99;
  const res = await harvester.run({ blockSize: 500, window: null });

  assert.equal(res.status, "failed");
  assert.equal(res.stoppedBy, "failures");
  assert.equal(res.blocksFailed, 3);
  assert.equal(res.cursorOffset, 0);
  assert.equal(repository.finished.at(-1)?.status, "failed");
});

test("HTML inesperado: aborta de inmediato en vez de escribir basura", async () => {
  const { harvester, repository, source } = setup();
  source.failures = 1;
  source.failWith = new LibraryProtocolError("La página no tiene la estructura esperada.");
  const res = await harvester.run({ blockSize: 500, window: null });

  assert.equal(res.status, "failed");
  assert.equal(res.stoppedBy, "error");
  assert.equal(repository.rows.size, 0);
  // Sin reintentos: un cambio del OPAC no se arregla insistiendo.
  assert.equal(source.calls.length, 1);
});

test("fuera de la ventana horaria no empieza", async () => {
  // 12:00 local: fuera de 00:00-06:00.
  const noon = new Date(2026, 8, 22, 12, 0, 0).getTime();
  const { harvester, source } = setup(noon);
  const res = await harvester.run({ window: { fromHour: 0, toHour: 6 } });

  assert.equal(res.stoppedBy, "window");
  assert.equal(res.status, "paused");
  assert.equal(source.calls.length, 0);
});

test("dentro de la ventana sí corre", async () => {
  const threeAm = new Date(2026, 8, 22, 3, 0, 0).getTime();
  const { harvester, source } = setup(threeAm);
  const res = await harvester.run({ blockSize: 500, window: { fromHour: 0, toHour: 6 } });

  assert.equal(res.status, "done");
  assert.ok(source.calls.length > 0);
});

test("cron nocturno: si el catálogo ya está al día no toca el OPAC", async () => {
  const { harvester, repository, source } = setup();
  repository.upToDate = true;

  const res = await harvester.run({ maxAgeDays: 30, window: null });

  assert.equal(res.stoppedBy, "up_to_date");
  assert.equal(res.status, "done");
  // Lo que de verdad importa: ni una petición al servidor de la biblioteca.
  assert.equal(source.calls.length, 0);
  assert.equal(res.recordsUpserted, 0);
  // Tampoco se abre ni se cierra un run: no hubo barrido que registrar.
  assert.equal(repository.finished.length, 0);
});

test("incremental: escribe sólo lo nuevo y para en cuanto la página ya es conocida", async () => {
  const { harvester, repository, source } = setup();
  // El catálogo ya está guardado salvo los 3 más recientes.
  for (let i = 1; i <= CATALOG_TOTAL - 3; i++) repository.rows.set(String(i), row(i));

  const res = await harvester.run({ mode: "incremental", blockSize: 10, window: null });

  assert.equal(res.mode, "incremental");
  assert.equal(res.status, "done");
  assert.equal(res.recordsUpserted, 3);
  assert.equal(repository.rows.size, CATALOG_TOTAL);
  // Dos páginas: la primera traía novedades (así que hay que mirar más atrás) y la
  // segunda ya era toda conocida, que es la señal de parada.
  assert.equal(source.newestCalls, 2);
});
