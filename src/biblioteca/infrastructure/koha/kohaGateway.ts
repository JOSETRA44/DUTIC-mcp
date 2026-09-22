import type {
  CatalogGateway,
  CatalogHarvestSource,
  GatewaySearchResult,
  HarvestBlock,
} from "../../application/ports.js";
import type { BiblioRecord, BiblioSummary, SearchQuery } from "../../domain/entities.js";
import { LibraryProtocolError, LibraryUnavailableError } from "../../domain/errors.js";
import { kohaGet } from "./kohaHttp.js";
import { parseDetail, parseSearchPage } from "./kohaParsers.js";
import {
  biblioIdFromUrl,
  detailUrl,
  harvestUrl,
  HARVEST_QUERY,
  KOHA_BASE_URL,
  newestUrl,
  searchUrl,
} from "./kohaUrls.js";

/** Adaptador del OPAC Koha 19.11 de la UNSA: puerta de consulta y de cosecha. */
export class KohaGateway implements CatalogGateway, CatalogHarvestSource {
  constructor(private readonly baseUrl: string = KOHA_BASE_URL) {}

  async search(query: SearchQuery): Promise<GatewaySearchResult> {
    const res = await kohaGet(searchUrl(this.baseUrl, query), this.baseUrl);

    // Un único resultado: Koha redirige al detalle (no hay parámetro que lo evite). Se abre la
    // ficha y se devuelve como página de un resultado — con más datos que el listado, de paso.
    if (isRedirect(res.status)) {
      const id = res.location ? biblioIdFromUrl(res.location) : null;
      if (!id) throw new LibraryProtocolError(`Redirect inesperado de la búsqueda: ${res.location}`);
      const record = await this.getRecord(id);
      return {
        page: { query, total: record ? 1 : 0, hasMore: false, results: record ? [toSummary(record)] : [] },
        records: record ? [record] : [],
      };
    }
    if (res.status !== 200) {
      throw new LibraryUnavailableError(`La búsqueda respondió HTTP ${res.status}.`);
    }
    return { page: parseSearchPage(res.text, query, this.baseUrl) };
  }

  /** CatalogHarvestSource: bloque por desplazamiento, en el orden estable del OPAC. */
  fetchBlock(offset: number, limit: number): Promise<HarvestBlock> {
    return fetchListing(harvestUrl(this.baseUrl, offset, limit), this.baseUrl, offset, limit);
  }

  /** CatalogHarvestSource: los más recientes, para el refresco incremental. */
  fetchNewest(limit: number, offset = 0): Promise<HarvestBlock> {
    return fetchListing(newestUrl(this.baseUrl, limit, offset), this.baseUrl, offset, limit);
  }

  async getRecord(id: string): Promise<BiblioRecord | null> {
    const res = await kohaGet(detailUrl(this.baseUrl, id), this.baseUrl);
    // Un biblionumber inexistente responde 404 o redirige a la página de error.
    if (res.status === 404 || isRedirect(res.status)) return null;
    if (res.status !== 200) {
      throw new LibraryUnavailableError(`La ficha respondió HTTP ${res.status}.`);
    }
    return parseDetail(res.text, id, this.baseUrl);
  }
}

/** Pide una página del barrido y la parsea con el mismo parser que la búsqueda normal. */
async function fetchListing(
  url: string,
  baseUrl: string,
  offset: number,
  limit: number,
): Promise<HarvestBlock> {
  const res = await kohaGet(url, baseUrl);
  if (res.status !== 200) {
    throw new LibraryUnavailableError(`El bloque del barrido respondió HTTP ${res.status}.`);
  }
  const page = parseSearchPage(
    res.text,
    { text: HARVEST_QUERY, field: "any", limit, offset },
    baseUrl,
  );
  return { total: page.total, results: page.results };
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function toSummary(r: BiblioRecord): BiblioSummary {
  const { description: _d, subjects: _s, classification: _c, items: _i, ...summary } = r;
  return summary;
}
