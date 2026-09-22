import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildQuery } from "../../domain/query.js";
import { parseDetail, parseSearchPage } from "./kohaParsers.js";
import { KOHA_BASE_URL, searchUrl } from "./kohaUrls.js";

/** Respuestas reales del OPAC (catálogo público, sin datos personales) en test/fixtures/biblioteca/. */
const FIXTURES = join(process.cwd(), "test", "fixtures", "biblioteca");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

test("parseSearchPage: 16 resultados con metadatos y disponibilidad por sede", () => {
  const q = buildQuery({ text: "matematica para economistas", limit: 100 });
  const page = parseSearchPage(fixture("search-matematica-economistas.html"), q, KOHA_BASE_URL);

  assert.equal(page.total, 16);
  assert.equal(page.results.length, 16);
  assert.equal(page.hasMore, false);

  const dowling = page.results.find((r) => r.id === "823127");
  assert.ok(dowling);
  assert.equal(dowling.title, "Matemáticas para economistas");
  assert.deepEqual(dowling.authors, ["Dowling, Edward"]);
  assert.equal(dowling.year, "1982");
  assert.equal(dowling.availability.state, "available");
  assert.deepEqual(dowling.availability.holdings, [
    { branch: "Bibl. Central de Sociales", callNumber: "E01-21-023", count: 3 },
  ]);
  assert.match(dowling.url, /opac-detail\.pl\?biblionumber=823127$/);

  // Dato real mal catalogado: un ejemplar sin sede. Se conserva con branch null.
  const allen = page.results.find((r) => r.id === "822930");
  assert.deepEqual(allen?.availability.holdings, [
    { branch: "Bibl. Central de Sociales", callNumber: "E01-13-013", count: 2 },
    { branch: null, callNumber: null, count: 1 },
  ]);
});

test("parseSearchPage: total de la consulta, no sólo de la página", () => {
  const q = buildQuery({ text: "economia", limit: 20 });
  const page = parseSearchPage(fixture("search-economia-p1.html"), q, KOHA_BASE_URL);
  assert.equal(page.total, 3772);
  assert.equal(page.results.length, 20);
  assert.equal(page.hasMore, true);

  const first = page.results[0];
  assert.equal(first.id, "1151808");
  assert.equal(first.isbn, "9786071745903");
  assert.equal(first.edition, "3a edición");
  assert.equal(first.language, "Español");
  assert.equal(first.publisher, "México Trillas 2023");
});

test("parseSearchPage: varios autores separados, iniciales conservadas", () => {
  const q = buildQuery({ text: "economia", limit: 20 });
  const page = parseSearchPage(fixture("search-economia-p1.html"), q, KOHA_BASE_URL);
  const multi = page.results.find((r) => r.authors.length > 1);
  assert.ok(multi);
  assert.deepEqual(multi.authors.slice(0, 2), ["González Ortiz, Oscar Claret", "Arciniegas Ortiz, Jaime Alonso"]);

  const chiang = parseSearchPage(fixture("search-autor-chiang.html"), buildQuery({ text: "chiang", field: "author" }), KOHA_BASE_URL);
  assert.ok(chiang.results.some((r) => r.authors[0] === "Chiang, Alpha C."));
});

test("parseSearchPage: registros sin ejemplares → no_items", () => {
  const q = buildQuery({ text: "chiang", field: "author" });
  const page = parseSearchPage(fixture("search-autor-chiang.html"), q, KOHA_BASE_URL);
  assert.equal(page.total, 6);
  const states = page.results.map((r) => r.availability.state);
  assert.equal(states.filter((s) => s === "available").length, 4);
  assert.equal(states.filter((s) => s === "no_items").length, 2);
});

test("parseSearchPage: sin resultados", () => {
  const q = buildQuery({ text: "zzqxxnoexiste" });
  const page = parseSearchPage(fixture("search-sin-resultados.html"), q, KOHA_BASE_URL);
  assert.equal(page.total, 0);
  assert.deepEqual(page.results, []);
  assert.equal(page.hasMore, false);
});

test("parseSearchPage: HTML desconocido falla fuerte en vez de devolver 0", () => {
  const q = buildQuery({ text: "x" });
  assert.throws(() => parseSearchPage("<html><body>Mantenimiento</body></html>", q, KOHA_BASE_URL), {
    name: "LibraryProtocolError",
  });
});

test("parseDetail: ficha completa con ejemplares", () => {
  const r = parseDetail(fixture("detail-823127.html"), "823127", KOHA_BASE_URL);
  assert.ok(r);
  assert.equal(r.title, "Matemáticas para economistas");
  assert.deepEqual(r.authors, ["Dowling, Edward"]);
  assert.equal(r.year, "1982");
  assert.equal(r.edition, "1ra. ed");
  assert.equal(r.isbn, "B9684512805");
  assert.equal(r.description, "411 Páginas 27x20x30 ctms");
  assert.deepEqual(r.subjects, ["CÁLCULO DIFERENCIAL", "HIPÓTESIS", "OPTIMIZACIÓN", "TERMINOLOGÍA", "VARIABLES"]);
  assert.equal(r.items.length, 3);
  assert.deepEqual(r.items[0], {
    itemType: "Libros",
    branch: "Bibl. Central de Sociales",
    shelvingLocation: null,
    callNumber: "E01-21-023",
    copyNumber: "1",
    status: "available",
    statusLabel: "Disponible",
    dueDate: null,
    barcode: "BCS/M09380-1",
  });
  assert.equal(r.availability.state, "available");
  assert.equal(r.availability.holdings[0].count, 3);
});

test("parseDetail: página sin registro → null", () => {
  assert.equal(parseDetail("<html><body>404</body></html>", "1", KOHA_BASE_URL), null);
});

test("searchUrl: índice por campo y count en una sola petición", () => {
  const url = searchUrl(KOHA_BASE_URL, buildQuery({ text: "Matemática  para", field: "title", limit: 80 }));
  assert.equal(url, `${KOHA_BASE_URL}/cgi-bin/koha/opac-search.pl?idx=ti&q=matematica+para&count=80`);
});
