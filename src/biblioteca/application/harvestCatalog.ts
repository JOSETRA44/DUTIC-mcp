import { LibraryProtocolError } from "../domain/errors.js";
import type {
  CatalogHarvestSource,
  CatalogRepository,
  Clock,
  HarvestStatus,
} from "./ports.js";
import { systemClock } from "./ports.js";

/**
 * Orquestador del barrido del catálogo.
 *
 * Todo el diseño sale de lo medido en docs/biblioteca-diagnostico.md:
 *
 *  - El OPAC enumera el catálogo entero con `Any,alwaysmatches=''`, en orden estable
 *    (≈ biblionumber ascendente), sin solapes y con paginación profunda que NO se degrada.
 *    Eso permite un cursor por desplazamiento y reanudar en cualquier punto.
 *  - Un bloque de 500 cuesta ~22 s. El barrido completo son ~400 bloques (~2.4 h), así que
 *    se parte en TANDAS con presupuesto de tiempo: cada tanda deja el run en `paused` con su
 *    cursor y la siguiente continúa.
 *  - Nunca hay más de una petición en vuelo, y no se duerme entre bloques: la conexión se
 *    mantiene caliente (si se enfría, el bloque siguiente paga ~10 s extra). La cortesía está
 *    en el horario y en el tope de la tanda, no en pausas artificiales.
 *
 * No hace I/O por su cuenta: recibe el origen, el repositorio y el reloj. Así se prueba
 * entero sin red ni base.
 */

/** Registros por bloque. No es entrada de usuario: es el punto óptimo medido (44 ms/registro). */
export const HARVEST_BLOCK_SIZE = 500;
/** Página del refresco incremental (los más recientes primero). */
export const INCREMENTAL_PAGE_SIZE = 100;
const MAX_INCREMENTAL_PAGES = 5;
/** Reintentos por bloque y sus esperas. Un timeout no se reintenta gratis: cuesta otros ~110 s. */
const RETRY_DELAYS_MS = [5_000, 20_000];
/** Bloques fallidos seguidos antes de rendirse y dejar el run como `failed`. */
const MAX_CONSECUTIVE_FAILURES = 3;

export type StoppedBy = "complete" | "budget" | "window" | "failures" | "error" | "up_to_date";

export interface HarvestOptions {
  mode?: "full" | "incremental";
  /** Presupuesto de la tanda. Al agotarse, el run queda `paused` con su cursor. */
  budgetMs?: number;
  blockSize?: number;
  /** Fuerza el punto de partida, ignorando el cursor guardado. */
  startOffset?: number;
  /** Ventana horaria permitida (hora local, `to` exclusivo). null = sin restricción. */
  window?: { fromHour: number; toHour: number } | null;
  /**
   * Si el último barrido completo terminó hace menos de estos días, no se hace nada.
   * Es lo que hace idempotente al cron: la tanda nocturna sólo trabaja si hace falta.
   */
  maxAgeDays?: number | null;
  onProgress?: (p: HarvestProgress) => void;
}

export interface HarvestProgress {
  offset: number;
  total: number | null;
  recordsUpserted: number;
  blocksOk: number;
  blocksFailed: number;
  lastBlockMs: number;
}

export interface HarvestResult {
  runId: number;
  mode: "full" | "incremental";
  status: HarvestStatus;
  stoppedBy: StoppedBy;
  cursorOffset: number;
  total: number | null;
  recordsUpserted: number;
  blocksOk: number;
  blocksFailed: number;
  elapsedMs: number;
  error?: string;
}

export interface HarvesterDeps {
  source: CatalogHarvestSource;
  repository: CatalogRepository;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
}

export class CatalogHarvester {
  private readonly clock: Clock;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: HarvesterDeps) {
    this.clock = deps.clock ?? systemClock;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async run(opts: HarvestOptions = {}): Promise<HarvestResult> {
    return (opts.mode ?? "full") === "incremental" ? this.runIncremental(opts) : this.runFull(opts);
  }

  /** Barrido completo por bloques, reanudable. */
  private async runFull(opts: HarvestOptions): Promise<HarvestResult> {
    const blockSize = opts.blockSize ?? HARVEST_BLOCK_SIZE;
    const budgetMs = opts.budgetMs ?? Number.POSITIVE_INFINITY;
    const startedAt = this.clock.now();

    const run = await this.deps.repository.startRun("full", null, opts.maxAgeDays ?? null);
    if (!run) return upToDate("full", this.clock.now() - startedAt);
    let offset = opts.startOffset ?? run.cursorOffset;
    let total = run.totalExpected;
    let recordsUpserted = 0;
    let blocksOk = 0;
    let blocksFailed = 0;
    let consecutiveFailures = 0;
    let stoppedBy: StoppedBy = "complete";
    let error: string | undefined;

    for (;;) {
      if (total !== null && offset >= total) {
        stoppedBy = "complete";
        break;
      }
      if (this.clock.now() - startedAt >= budgetMs) {
        stoppedBy = "budget";
        break;
      }
      if (!this.insideWindow(opts.window)) {
        stoppedBy = "window";
        break;
      }

      const blockStart = this.clock.now();
      let block;
      try {
        block = await this.withRetries(() => this.deps.source.fetchBlock(offset, blockSize));
      } catch (err) {
        // HTML inesperado: el OPAC cambió o está en mantenimiento. Abortar antes que
        // escribir basura en la base.
        if (err instanceof LibraryProtocolError) {
          stoppedBy = "error";
          error = err.message;
          break;
        }
        blocksFailed++;
        consecutiveFailures++;
        error = (err as Error).message;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          stoppedBy = "failures";
          break;
        }
        continue; // el cursor no avanzó: se reintenta el mismo bloque
      }

      consecutiveFailures = 0;
      total = block.total;

      if (block.results.length === 0) {
        stoppedBy = "complete";
        break;
      }

      const nextOffset = offset + block.results.length;
      recordsUpserted += await this.deps.repository.ingestBlock(
        run.id,
        block.results,
        nextOffset,
        total,
      );
      offset = nextOffset;
      blocksOk++;

      opts.onProgress?.({
        offset,
        total,
        recordsUpserted,
        blocksOk,
        blocksFailed,
        lastBlockMs: this.clock.now() - blockStart,
      });
    }

    const status: HarvestStatus =
      stoppedBy === "complete" ? "done" : stoppedBy === "budget" || stoppedBy === "window" ? "paused" : "failed";
    await this.deps.repository.finishRun(run.id, status, error ?? null, blocksFailed);

    return {
      runId: run.id,
      mode: "full",
      status,
      stoppedBy,
      cursorOffset: offset,
      total,
      recordsUpserted,
      blocksOk,
      blocksFailed,
      elapsedMs: this.clock.now() - startedAt,
      ...(error ? { error } : {}),
    };
  }

  /**
   * Refresco incremental: pide los registros más recientes y se detiene en cuanto una página
   * no trae ninguno nuevo. Como el orden del catálogo es por biblionumber ascendente, lo nuevo
   * está al final; bastan 2-3 peticiones al día.
   */
  private async runIncremental(opts: HarvestOptions): Promise<HarvestResult> {
    const startedAt = this.clock.now();
    const pageSize = opts.blockSize ?? INCREMENTAL_PAGE_SIZE;
    const run = await this.deps.repository.startRun("incremental");
    if (!run) return upToDate("incremental", this.clock.now() - startedAt);

    let recordsUpserted = 0;
    let blocksOk = 0;
    let blocksFailed = 0;
    let total: number | null = run.totalExpected;
    let stoppedBy: StoppedBy = "complete";
    let error: string | undefined;

    for (let page = 0; page < MAX_INCREMENTAL_PAGES; page++) {
      if (this.clock.now() - startedAt >= (opts.budgetMs ?? Number.POSITIVE_INFINITY)) {
        stoppedBy = "budget";
        break;
      }

      let block;
      try {
        block = await this.withRetries(() => this.deps.source.fetchNewest(pageSize, page * pageSize));
      } catch (err) {
        blocksFailed++;
        error = (err as Error).message;
        stoppedBy = err instanceof LibraryProtocolError ? "error" : "failures";
        break;
      }

      total = block.total;
      if (block.results.length === 0) break;

      const ids = block.results.map((r) => r.id);
      const known = await this.deps.repository.knownIds(ids);
      const fresh = block.results.filter((r) => !known.has(r.id));

      if (fresh.length > 0) {
        // `nextOffset` 0: el modo incremental no mueve el cursor del barrido completo.
        recordsUpserted += await this.deps.repository.ingestBlock(run.id, fresh, 0, total);
        blocksOk++;
      }

      opts.onProgress?.({
        offset: page * pageSize,
        total,
        recordsUpserted,
        blocksOk,
        blocksFailed,
        lastBlockMs: 0,
      });

      // Página entera ya conocida: de aquí en adelante todo es más viejo. Listo.
      if (fresh.length === 0) break;
    }

    const status: HarvestStatus = stoppedBy === "complete" ? "done" : stoppedBy === "budget" ? "paused" : "failed";
    await this.deps.repository.finishRun(run.id, status, error ?? null, blocksFailed);

    return {
      runId: run.id,
      mode: "incremental",
      status,
      stoppedBy,
      cursorOffset: 0,
      total,
      recordsUpserted,
      blocksOk,
      blocksFailed,
      elapsedMs: this.clock.now() - startedAt,
      ...(error ? { error } : {}),
    };
  }

  /** Reintenta ante fallos transitorios; un LibraryProtocolError sube de inmediato. */
  private async withRetries<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) await this.sleep(RETRY_DELAYS_MS[attempt - 1]);
      try {
        return await fn();
      } catch (err) {
        if (err instanceof LibraryProtocolError) throw err;
        lastErr = err;
      }
    }
    throw lastErr;
  }

  /** `toHour` exclusivo; una ventana que cruza medianoche (22→6) se interpreta como tal. */
  private insideWindow(window: HarvestOptions["window"]): boolean {
    if (!window) return true;
    const hour = new Date(this.clock.now()).getHours();
    const { fromHour, toHour } = window;
    return fromHour <= toHour ? hour >= fromHour && hour < toHour : hour >= fromHour || hour < toHour;
  }
}

/** El catálogo ya está al día: ni una petición al OPAC. */
function upToDate(mode: "full" | "incremental", elapsedMs: number): HarvestResult {
  return {
    runId: 0,
    mode,
    status: "done",
    stoppedBy: "up_to_date",
    cursorOffset: 0,
    total: null,
    recordsUpserted: 0,
    blocksOk: 0,
    blocksFailed: 0,
    elapsedMs,
  };
}
