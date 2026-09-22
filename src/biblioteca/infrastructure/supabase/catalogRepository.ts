import type { BiblioSummary } from "../../domain/entities.js";
import type { CatalogRepository, HarvestRun, HarvestStatus } from "../../application/ports.js";

/**
 * Destino del catálogo en Supabase (Postgres), por PostgREST y con `fetch` directo, igual
 * que `src/core/saasClient.ts` (sin dependencias nuevas).
 *
 * SEGURIDAD. Escribir exige la `service_role` key, que vive SÓLO en el entorno del operador
 * que corre el barrido (`DUTIC_LIBRARY_INGEST_KEY`): nunca en el repositorio, ni en
 * `~/.dutic`, ni en el paquete npm, ni en un log. Los usuarios del CLI y del MCP jamás
 * escriben aquí; leen por `public.library_search`, que es la única función que `anon` puede
 * ejecutar. Las tablas viven en el esquema `library`, que PostgREST no expone.
 *
 * El esquema y las funciones están en
 * saas/supabase/migrations/20260922031500_library_catalog.sql.
 */

const DEFAULT_SUPABASE_URL = "https://udihgiwdddrtoqdwopcb.supabase.co";

export class SupabaseCatalogRepository implements CatalogRepository {
  constructor(
    private readonly serviceKey: string,
    private readonly baseUrl: string = process.env.DUTIC_LIBRARY_SUPABASE_URL?.trim() || DEFAULT_SUPABASE_URL,
  ) {
    if (!serviceKey) throw new Error("Falta la clave de ingesta del catálogo.");
  }

  async startRun(mode: "full" | "incremental", totalExpected: number | null = null): Promise<HarvestRun> {
    const run = (await this.rpc("library_harvest_start", {
      p_mode: mode,
      p_total: totalExpected,
    })) as {
      id: number;
      cursor_offset: number;
      records_upserted: number;
      total_expected: number | null;
    };
    return {
      id: Number(run.id),
      cursorOffset: Number(run.cursor_offset ?? 0),
      recordsUpserted: Number(run.records_upserted ?? 0),
      totalExpected: run.total_expected ?? null,
    };
  }

  async ingestBlock(
    runId: number,
    rows: BiblioSummary[],
    nextOffset: number,
    total: number | null,
  ): Promise<number> {
    const written = (await this.rpc("library_ingest_batch", {
      p_run: runId,
      p_rows: rows.map(toRow),
      p_next_offset: nextOffset,
      p_total: total,
    })) as number;
    return Number(written ?? 0);
  }

  async finishRun(
    runId: number,
    status: HarvestStatus,
    error: string | null = null,
    blocksFailed = 0,
  ): Promise<void> {
    await this.rpc("library_harvest_finish", {
      p_run: runId,
      p_status: status,
      // Un mensaje de error puede traer una URL larga; se recorta para no inflar la fila.
      p_error: error ? error.slice(0, 500) : null,
      p_blocks_failed: blocksFailed,
    });
  }

  async knownIds(ids: string[]): Promise<Set<string>> {
    const numeric = ids.map(Number).filter(Number.isFinite);
    if (numeric.length === 0) return new Set();
    const found = (await this.rpc("library_known_ids", { p_ids: numeric })) as number[] | null;
    return new Set((found ?? []).map(String));
  }

  private async rpc(fn: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: this.serviceKey,
        Authorization: `Bearer ${this.serviceKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (!res.ok) {
      // NUNCA se incluye la clave en el mensaje, aunque el servidor la devolviera.
      throw new Error(`Supabase ${fn}: HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : null;
  }
}

/** Fila tal como la espera `library_ingest_batch` (jsonb). */
function toRow(r: BiblioSummary) {
  return {
    id: r.id,
    title: r.title,
    authors: r.authors,
    edition: r.edition,
    publisher: r.publisher,
    year: parseYear(r.year),
    isbn: r.isbn,
    language: r.language,
    availability: r.availability,
  };
}

/** El año viene como texto del OPAC y la columna es smallint: fuera de rango, mejor null. */
function parseYear(year: string | null): number | null {
  if (!year) return null;
  const n = Number.parseInt(year, 10);
  return Number.isInteger(n) && n > 1000 && n < 3000 ? n : null;
}
