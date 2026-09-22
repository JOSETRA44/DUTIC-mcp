import type { CatalogGateway, GatewaySearchResult } from "../../application/ports.js";
import type { BiblioRecord, BiblioSummary, SearchQuery } from "../../domain/entities.js";
import { LibraryProtocolError, LibraryUnavailableError } from "../../domain/errors.js";
import { kohaGet } from "./kohaHttp.js";
import { parseDetail, parseSearchPage } from "./kohaParsers.js";
import { biblioIdFromUrl, detailUrl, KOHA_BASE_URL, searchUrl } from "./kohaUrls.js";

/** Adaptador del OPAC Koha 19.11 de la UNSA al puerto `CatalogGateway`. */
export class KohaGateway implements CatalogGateway {
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

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function toSummary(r: BiblioRecord): BiblioSummary {
  const { description: _d, subjects: _s, classification: _c, items: _i, ...summary } = r;
  return summary;
}
