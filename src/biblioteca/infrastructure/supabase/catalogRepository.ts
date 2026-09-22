import type { BiblioSummary } from "../../domain/entities.js";
import type { CatalogRepository, HarvestRun, HarvestStatus } from "../../application/ports.js";
import { SAAS_ANON_KEY, SAAS_SUPABASE_URL } from "../../../core/saasClient.js";

/**
 * Destino del catálogo en Supabase, a través de la Edge Function `library-ingest`
 * (saas/supabase/functions/library-ingest/index.ts).
 *
 * POR QUÉ NO SE ESCRIBE DIRECTO CONTRA PostgREST. Hacerlo exigiría la `service_role` key en
 * quien corra el barrido — y eso, en GitHub Actions, significa poner en un secreto de CI una
 * llave que salta el RLS del proyecto ENTERO (incluidas las tablas con datos personales del
 * piloto). Con la función, el token que viaja a CI sólo sabe escribir bibliografía, y
 * revocarlo es un UPDATE en `library.ingest_clients`, no una rotación de claves.
 *
 * El token va EN EL CUERPO, no en Authorization: ese header lo ocupa el anon key, que es lo
 * que el gateway de Supabase verifica como JWT. Mismo patrón que `enroll`/`ingest`.
 */

const FUNCTION_NAME = "library-ingest";

export class SupabaseCatalogRepository implements CatalogRepository {
  constructor(
    private readonly token: string,
    private readonly baseUrl: string = process.env.DUTIC_LIBRARY_SUPABASE_URL?.trim() || SAAS_SUPABASE_URL,
  ) {
    if (!token) throw new Error("Falta el token de ingesta del catálogo.");
  }

  async startRun(
    mode: "full" | "incremental",
    totalExpected: number | null = null,
    maxAgeDays: number | null = null,
  ): Promise<HarvestRun | null> {
    const { run } = (await this.call({
      action: "start",
      mode,
      total: totalExpected,
      maxAgeDays,
    })) as { run: Record<string, unknown> | null };

    if (!run || run.skip === true) return null;
    return {
      id: Number(run.id),
      cursorOffset: Number(run.cursor_offset ?? 0),
      recordsUpserted: Number(run.records_upserted ?? 0),
      totalExpected: (run.total_expected as number | null) ?? null,
    };
  }

  async ingestBlock(
    runId: number,
    rows: BiblioSummary[],
    nextOffset: number,
    total: number | null,
  ): Promise<number> {
    const { written } = (await this.call({
      action: "batch",
      run: runId,
      rows: rows.map(toRow),
      nextOffset,
      total,
    })) as { written: number };
    return Number(written ?? 0);
  }

  async finishRun(
    runId: number,
    status: HarvestStatus,
    error: string | null = null,
    blocksFailed = 0,
  ): Promise<void> {
    await this.call({
      action: "finish",
      run: runId,
      status,
      // Un mensaje de error puede traer una URL larga; se recorta para no inflar la fila.
      error: error ? error.slice(0, 500) : null,
      blocksFailed,
    });
  }

  async knownIds(ids: string[]): Promise<Set<string>> {
    const numeric = ids.map(Number).filter(Number.isFinite);
    if (numeric.length === 0) return new Set();
    const { ids: found } = (await this.call({ action: "known_ids", ids: numeric })) as {
      ids: number[] | null;
    };
    return new Set((found ?? []).map(String));
  }

  private async call(body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/functions/v1/${FUNCTION_NAME}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SAAS_ANON_KEY,
        Authorization: `Bearer ${SAAS_ANON_KEY}`,
      },
      body: JSON.stringify({ ...body, token: this.token }),
      // Un bloque de 500 filas puede tardar en escribirse; el OPAC es el lento, no esto.
      signal: AbortSignal.timeout(60_000),
    });

    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      /* respuesta no-JSON: se informa por status */
    }

    if (!res.ok) {
      // NUNCA se incluye el token en el mensaje, aunque el servidor lo devolviera.
      const code = typeof data.error === "string" ? data.error : `HTTP ${res.status}`;
      const detail = typeof data.detail === "string" ? ` (${data.detail})` : "";
      throw new Error(
        code === "invalid_token"
          ? "El token de ingesta no es válido o fue revocado."
          : `library-ingest: ${code}${detail}`,
      );
    }
    return data;
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
