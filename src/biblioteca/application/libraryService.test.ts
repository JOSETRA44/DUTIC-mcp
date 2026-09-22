import { test } from "node:test";
import assert from "node:assert/strict";
import type { BiblioRecord, SearchPage, SearchQuery } from "../domain/entities.js";
import { MemoryCache } from "../infrastructure/cache/caches.js";
import type { Freshness } from "./freshness.js";
import { LibraryService } from "./libraryService.js";
import type { CatalogGateway, GatewaySearchResult } from "./ports.js";

/** Gateway falso: cuenta llamadas y deja controlar cuándo resuelve cada una. */
class FakeGateway implements CatalogGateway {
  calls = 0;
  fail = false;
  private pending: (() => void)[] = [];
  manual = false;

  async search(query: SearchQuery): Promise<GatewaySearchResult> {
    this.calls++;
    if (this.manual) await new Promise<void>((r) => this.pending.push(r));
    if (this.fail) throw new Error("OPAC caído");
    const page: SearchPage = { query, total: this.calls, hasMore: false, results: [] };
    return query.field === "isbn" ? { page, records: [this.record] } : { page };
  }
  record = { id: "42", title: "Ficha de paso" } as BiblioRecord;
  async getRecord(): Promise<BiblioRecord | null> {
    return null;
  }
  releaseAll(): void {
    this.pending.splice(0).forEach((r) => r());
  }
}

function setup(freshness: Freshness) {
  const gateway = new FakeGateway();
  let now = 1_000_000;
  const service = new LibraryService({
    gateway,
    cache: new MemoryCache(),
    clock: { now: () => now },
    decide: () => freshness,
  });
  return { gateway, service, advance: (ms: number) => (now += ms) };
}

test("fresco: la segunda búsqueda no toca la red, y tildes/mayúsculas comparten entrada", async () => {
  const { gateway, service } = setup("fresh");
  const a = await service.search({ text: "Matemática para Economistas" });
  const b = await service.search({ text: "matematica  para economistas" });
  assert.equal(gateway.calls, 1);
  assert.equal(a.source, "network");
  assert.equal(b.source, "cache");
  assert.equal(b.stale, false);
});

test("singleflight: búsquedas idénticas simultáneas → una sola petición", async () => {
  const { gateway, service } = setup("expired");
  gateway.manual = true;
  const all = Promise.all([1, 2, 3].map(() => service.search({ text: "calculo" })));
  await new Promise((r) => setImmediate(r));
  gateway.releaseAll();
  const res = await all;
  assert.equal(gateway.calls, 1);
  assert.ok(res.every((r) => r.data.total === 1));
});

test("stale: responde al instante con la copia y revalida en segundo plano", async () => {
  const { gateway, service } = setup("stale");
  await service.search({ text: "calculo" }, { refresh: true }); // siembra (calls=1)
  const r = await service.search({ text: "calculo" });
  assert.equal(r.stale, true);
  assert.equal(r.data.total, 1);
  await service.settle();
  assert.equal(gateway.calls, 2);
  const again = await service.search({ text: "calculo" });
  assert.equal(again.data.total, 2);
});

test("stale con revalidate:none (CLI) no dispara red", async () => {
  const { gateway, service } = setup("stale");
  await service.search({ text: "calculo" }, { refresh: true });
  await service.search({ text: "calculo" }, { revalidate: "none" });
  await service.settle();
  assert.equal(gateway.calls, 1);
});

test("respaldo: si el OPAC falla se sirve la copia vencida con aviso", async () => {
  const { gateway, service } = setup("expired");
  await service.search({ text: "calculo" });
  gateway.fail = true;
  const r = await service.search({ text: "calculo" });
  assert.equal(r.stale, true);
  assert.equal(r.source, "cache");
  assert.equal(r.warning, "OPAC caído");
});

test("sin copia y con el OPAC caído, el error se propaga", async () => {
  const { gateway, service } = setup("expired");
  gateway.fail = true;
  await assert.rejects(service.search({ text: "calculo" }), /OPAC caído/);
});

test("fichas descargadas de paso quedan en caché: abrirlas no toca la red", async () => {
  const { gateway, service } = setup("fresh");
  let recordCalls = 0;
  gateway.getRecord = async () => {
    recordCalls++;
    return null;
  };
  await service.search({ text: "9789587781625", field: "isbn" });
  const r = await service.getRecord("42");
  assert.equal(recordCalls, 0);
  assert.equal(r.source, "cache");
  assert.equal(r.data?.title, "Ficha de paso");
});

test("entrada inválida se rechaza antes de la red", async () => {
  const { gateway, service } = setup("expired");
  await assert.rejects(service.search({ text: "   " }), RangeError);
  await assert.rejects(service.getRecord("12abc"), RangeError);
  assert.equal(gateway.calls, 0);
});
