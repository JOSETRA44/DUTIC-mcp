import { load, type CheerioAPI } from "cheerio";
import type {
  Availability,
  BiblioRecord,
  BiblioSummary,
  HoldingSummary,
  Item,
  ItemStatus,
  SearchPage,
  SearchQuery,
} from "../../domain/entities.js";
import { LibraryProtocolError } from "../../domain/errors.js";
import { detailUrl } from "./kohaUrls.js";

/**
 * Parsers del HTML del OPAC Koha 19.11 (tema bootstrap, en español). Son funciones puras
 * probadas contra respuestas reales guardadas en test/fixtures/biblioteca/: si la UNSA
 * actualiza Koha y cambia el marcado, los tests fallan antes que los usuarios.
 */

type Node = ReturnType<CheerioAPI>;

const NO_RESULTS_RE = /No se encontraron resultados/i;

/** Marcador entre autores ("⁂"): no aparece en datos bibliográficos y, a diferencia de un NUL, cheerio no lo descarta. */
const AUTHOR_SEP = "⁂";

export function parseSearchPage(html: string, query: SearchQuery, baseUrl: string): SearchPage {
  const $ = load(html);
  const results: BiblioSummary[] = [];

  $("div.title_summary").each((_, el) => {
    const summary = parseSummary($, $(el), baseUrl);
    if (summary) results.push(summary);
  });

  const numText = clean($("#numresults").text());
  let total: number;
  const m = /([\d.,]+)\s+resultados?/i.exec(numText);
  if (m) {
    total = Number(m[1].replace(/[.,]/g, ""));
  } else if (NO_RESULTS_RE.test(numText) || (results.length === 0 && NO_RESULTS_RE.test(html))) {
    total = 0;
  } else if (results.length > 0) {
    // Sin contador pero con resultados: al menos sabemos cuántos vinieron.
    total = query.offset + results.length;
  } else {
    throw new LibraryProtocolError(
      "La página de resultados de la biblioteca no tiene la estructura esperada.",
      clean($("body").text()).slice(0, 300),
    );
  }

  return { query, total, hasMore: query.offset + results.length < total, results };
}

function parseSummary($: CheerioAPI, box: Node, baseUrl: string): BiblioSummary | null {
  const titleLink = box.find("a.title").first();
  const id =
    /title_summary_(\d+)/.exec(box.attr("id") ?? "")?.[1] ??
    /biblionumber=(\d+)/.exec(titleLink.attr("href") ?? "")?.[1];
  if (!id) return null;

  // El COinS vive en la misma celda que el resumen; trae ISBN y fecha normalizados.
  const coins = parseCoins(box.closest("td").find("span.Z3988").first().attr("title"));
  const publisher = labeledText(box.find(".results_summary.publisher").first());

  return {
    id,
    title: clean(titleLink.text()),
    authors: splitAuthors($, box.find("span.author").first()),
    edition: labeledText(box.find(".results_summary.edition").first()),
    publisher,
    year: coins.get("rft.date") ?? yearOf(publisher),
    isbn: coins.get("rft.isbn") ?? null,
    language: clean(box.find(".results_summary.languages [class^='lang_code']").first().text()) || null,
    availability: parseAvailability($, box.find(".results_summary.availability").first()),
    url: detailUrl(baseUrl, id),
  };
}

/**
 * Bloque de disponibilidad del listado. Variantes vistas en producción:
 *  - `span.available` con uno o varios `span.ItemSummary` (sede + signatura + "(n)");
 *  - `span.noitems` → "No hay ítems disponibles" (registro sin ejemplares físicos);
 *  - `span.unavailable` u otras clases de estado → texto libre ("Prestado (1)").
 */
function parseAvailability($: CheerioAPI, block: Node): Availability {
  if (block.length === 0) return { state: "unknown", holdings: [], notes: [] };

  const holdings: HoldingSummary[] = [];
  const notes: string[] = [];
  let noItems = false;

  block.children("span").each((_, el) => {
    const span = $(el);
    const cls = span.attr("class") ?? "";
    if (/\blabel\b/.test(cls)) return;
    if (/\bnoitems\b/.test(cls)) {
      noItems = true;
      return;
    }
    const isAvailable = /\bavailable\b/.test(cls) && !/\bunavailable\b/.test(cls);
    if (isAvailable) {
      span.find(".ItemSummary").each((_, it) => {
        holdings.push(parseItemSummary($, $(it)));
      });
    } else {
      const text = clean(span.text());
      if (text) notes.push(text);
    }
  });

  const state = holdings.length > 0 ? "available" : noItems ? "no_items" : notes.length > 0 ? "unavailable" : "unknown";
  return { state, holdings, notes };
}

function parseItemSummary($: CheerioAPI, it: Node): HoldingSummary {
  const count = /\((\d+)\)/.exec(it.text())?.[1];
  return {
    branch: clean(it.find(".ItemBranch").text()) || null,
    callNumber: clean(it.find(".CallNumber").text()) || null,
    count: count ? Number(count) : null,
  };
}

// --- Ficha ---------------------------------------------------------------------------------

/** Ficha de `opac-detail.pl`. null si la página no contiene un registro. */
export function parseDetail(html: string, id: string, baseUrl: string): BiblioRecord | null {
  const $ = load(html);
  const record = $("#catalogue_detail_biblio .record").first();
  if (record.length === 0) return null;

  const items = parseItems($);
  const publisherBlock = record.find(".results_summary.publisher").first();
  const coins = parseCoins($("#catalogue_detail_biblio span.Z3988").first().attr("title"));

  const authors = record
    .find("[property='author'] [property='name'], .results_summary.author [property='name']")
    .map((_, el) => clean($(el).text()))
    .get()
    .filter(Boolean);

  return {
    id,
    title: clean(record.find("h2.title").first().text()),
    authors: [...new Set(authors)],
    edition: clean(record.find("[property='bookEdition']").first().text()) || null,
    publisher: labeledText(publisherBlock),
    year:
      clean(publisherBlock.find("[property='datePublished']").first().text()) ||
      coins.get("rft.date") ||
      null,
    isbn: clean(record.find("[property='isbn']").first().text()) || coins.get("rft.isbn") || null,
    language: labeledText(record.find(".results_summary.languages").first()),
    description: clean(record.find("[property='description']").first().text()) || null,
    subjects: record
      .find("[property='keywords']")
      .map((_, el) => clean($(el).text()))
      .get()
      .filter(Boolean),
    classification: labeledText(record.find(".results_summary.ddc").first()),
    availability: availabilityFromItems(items),
    items,
    url: detailUrl(baseUrl, id),
  };
}

function parseItems($: CheerioAPI): Item[] {
  const items: Item[] = [];
  $("#holdingst tbody tr").each((_, tr) => {
    const row = $(tr);
    const statusCell = row.find("td.status");
    const statusLabel = clean(statusCell.text());
    const callCell = row.find("td.call_no").clone();
    callCell.find("a").remove(); // "(Navegar estantería)"
    items.push({
      itemType: clean(row.find("td.itype").text()) || null,
      branch: clean(row.find("td.location > span").first().text()) || null,
      shelvingLocation: clean(row.find("td.location .shelvingloc").text()) || null,
      callNumber: clean(callCell.text()).replace(/\(\s*\)$/, "").trim() || null,
      copyNumber: clean(row.find("td.copynumber").text()) || null,
      status: itemStatus(statusCell.find(".item-status").attr("class") ?? "", statusLabel),
      statusLabel,
      dueDate: clean(row.find("td.date_due").text()) || null,
      barcode: clean(row.find("td.barcode").text()) || null,
    });
  });
  return items;
}

function itemStatus(cls: string, label: string): ItemStatus {
  if (/\bavailable\b/.test(cls) || /^disponible/i.test(label)) return "available";
  if (/checkedout|datedue/.test(cls) || /prestado|vence|checked out/i.test(label)) return "checked_out";
  return "unavailable";
}

/** Resumen de disponibilidad a partir de los ejemplares: prestables agrupados por sede. */
function availabilityFromItems(items: Item[]): Availability {
  if (items.length === 0) return { state: "no_items", holdings: [], notes: [] };
  const byBranch = new Map<string | null, HoldingSummary>();
  const notes = new Map<string, number>();
  for (const it of items) {
    if (it.status === "available") {
      const h = byBranch.get(it.branch) ?? { branch: it.branch, callNumber: it.callNumber, count: 0 };
      h.count = (h.count ?? 0) + 1;
      byBranch.set(it.branch, h);
    } else {
      notes.set(it.statusLabel, (notes.get(it.statusLabel) ?? 0) + 1);
    }
  }
  const holdings = [...byBranch.values()];
  return {
    state: holdings.length > 0 ? "available" : "unavailable",
    holdings,
    notes: [...notes].map(([label, n]) => `${label} (${n})`),
  };
}

// --- Utilidades ----------------------------------------------------------------------------

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Texto de un `.results_summary` sin su `<span class="label">`. */
function labeledText(node: Node): string | null {
  if (node.length === 0) return null;
  const copy = node.clone();
  copy.find(".label").remove();
  return clean(copy.text()) || null;
}

/**
 * Autores del listado. Vienen separados por `<span class="separator"> | </span>` y con el punto
 * final de la catalogación ("Dowling, Edward."), que se quita salvo que sea una inicial
 * ("Chiang, Alpha C.").
 */
function splitAuthors($: CheerioAPI, node: Node): string[] {
  if (node.length === 0) return [];
  const copy = node.clone();
  copy.find(".separator").replaceWith(AUTHOR_SEP);
  return copy
    .text()
    .split(AUTHOR_SEP)
    .map((a) => clean(a))
    .map((a) => (/\.$/.test(a) && !/(^|[\s,])\p{Lu}\.$/u.test(a) ? a.slice(0, -1) : a))
    .filter(Boolean);
}

/** COinS (OpenURL Z39.88): el `title` llega doblemente escapado (`&amp;amp;`). */
function parseCoins(title: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!title) return out;
  for (const [k, v] of new URLSearchParams(title.replace(/&amp;/g, "&"))) {
    if (v && !out.has(k)) out.set(k, v.trim());
  }
  return out;
}

function yearOf(text: string | null): string | null {
  const years = text?.match(/\b(1[5-9]\d\d|20\d\d)\b/g);
  return years ? years[years.length - 1] : null;
}
