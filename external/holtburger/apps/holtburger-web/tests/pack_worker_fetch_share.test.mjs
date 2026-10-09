// tests/pack_worker_fetch_share.test.mjs — `?packWorkerFetchShare` (2026-10-09,
// cold-load A2 (a)).
//
// With `?packSource` armed on an unauthored page, index.html (D-03.10) caps the
// page's legacy fetch total at 8 and marks it (`__hbFetchConcurrencyPackCapped`).
// The quarter split then left the bake worker 2 permits (8 without packs) —
// but only the MAIN wasm instance has the pack seam, so the worker still
// fetches every record it decodes one request at a time. ON (default): under
// the marker the worker keeps its no-packs share (8); the main thread keeps
// D-03.10's 6. `off`/`0`/`false`/`no` restores the plain split.
//
//   W1  no packs, unauthored: 32 → main 24 / worker 8 (unchanged)
//   W2  D-03.10 marker: main 6 / worker 8 / total 14, packFloor
//   W3  `?packWorkerFetchShare=off|0|false|no`: today's 6 / 2 / 8
//   W4  authored total 8 (no marker): today's 6 / 2 — the floor never applies
//   W5  worker off (`?bakeWorker=0`) or no Worker: main keeps everything
//   W6  an authored total whose quarter is already ≥ 8: no change
//   W7  flag grammar
//   W8  index.html sets the marker inside the D-03.10 block; docs row
//
// Run: node tests/pack_worker_fetch_share.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

class FakeWorker {
  postMessage() {}
  terminate() {}
}
globalThis.Worker = FakeWorker;
globalThis.location = { search: "" };

const { applyFetchConcurrencySplit, resolvePackWorkerFetchShare } = await import(
  "../scene3d/bake_worker_client.js"
);

let passed = 0;
let failed = 0;
async function t(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log("  ok  ", name);
  } catch (e) {
    failed += 1;
    console.log("  FAIL", name);
    console.log(e);
  }
}

/** A fresh page-global stand-in; `search` drives both URL readers. */
function page(search = "", extra = {}) {
  globalThis.location = { search };
  return { location: globalThis.location, ...extra };
}
const pick = (g, r) => ({
  total: r.total, main: r.main, worker: r.worker, packFloor: r.packFloor,
  gTotal: g.__hbFetchConcurrencyTotal, gMain: g.__hbFetchConcurrency, gWorker: g.__hbFetchConcurrencyWorker,
});

await t("W1 no packs, unauthored: 32 -> main 24 / worker 8 (unchanged)", () => {
  const g = page("");
  const r = applyFetchConcurrencySplit(g);
  assert.deepEqual(pick(g, r), { total: 32, main: 24, worker: 8, packFloor: false, gTotal: 32, gMain: 24, gWorker: 8 });
});

await t("W2 D-03.10 marker: main keeps 6, worker keeps its no-packs 8", () => {
  const g = page("?packSource=on", { __hbFetchConcurrencyTotal: 8, __hbFetchConcurrencyPackCapped: true });
  const r = applyFetchConcurrencySplit(g);
  assert.deepEqual(pick(g, r), { total: 14, main: 6, worker: 8, packFloor: true, gTotal: 14, gMain: 6, gWorker: 8 });
});

await t("W3 =off|0|false|no restores the plain D-03.10 split (6 / 2 / 8)", () => {
  for (const v of ["off", "0", "false", "no"]) {
    const g = page(`?packSource=on&packWorkerFetchShare=${v}`, {
      __hbFetchConcurrencyTotal: 8, __hbFetchConcurrencyPackCapped: true,
    });
    const r = applyFetchConcurrencySplit(g);
    assert.deepEqual(pick(g, r), { total: 8, main: 6, worker: 2, packFloor: false, gTotal: 8, gMain: 6, gWorker: 2 }, v);
  }
});

await t("W4 an authored total of 8 (no marker) keeps today's split", () => {
  const g = page("?packSource=on", { __hbFetchConcurrencyTotal: 8 });
  const r = applyFetchConcurrencySplit(g);
  assert.deepEqual(pick(g, r), { total: 8, main: 6, worker: 2, packFloor: false, gTotal: 8, gMain: 6, gWorker: 2 });
  const g2 = page("?packSource=on", { __hbFetchConcurrency: 8, __hbFetchConcurrencyPackCapped: false });
  const r2 = applyFetchConcurrencySplit(g2);
  assert.equal(r2.worker, 2);
  assert.equal(r2.packFloor, false);
});

await t("W5 worker off or unavailable: the main thread keeps the whole budget", () => {
  for (const v of ["0", "off", "false"]) {
    const g = page(`?packSource=on&bakeWorker=${v}`, {
      __hbFetchConcurrencyTotal: 8, __hbFetchConcurrencyPackCapped: true,
    });
    const r = applyFetchConcurrencySplit(g);
    assert.deepEqual(pick(g, r), { total: 8, main: 8, worker: 0, packFloor: false, gTotal: 8, gMain: 8, gWorker: 0 }, v);
  }
  const saved = globalThis.Worker;
  delete globalThis.Worker;
  try {
    const g = page("?packSource=on", { __hbFetchConcurrencyTotal: 8, __hbFetchConcurrencyPackCapped: true });
    const r = applyFetchConcurrencySplit(g);
    assert.equal(r.worker, 0);
    assert.equal(r.main, 8);
    assert.equal(r.packFloor, false);
  } finally {
    globalThis.Worker = saved;
  }
});

await t("W6 a share already at or above the floor is left alone", () => {
  const g = page("?packSource=on", { __hbFetchConcurrencyTotal: 40, __hbFetchConcurrencyPackCapped: true });
  const r = applyFetchConcurrencySplit(g);
  assert.deepEqual(pick(g, r), { total: 40, main: 30, worker: 10, packFloor: false, gTotal: 40, gMain: 30, gWorker: 10 });
});

await t("W7 flag grammar: default on; off/0/false/no off", () => {
  assert.equal(resolvePackWorkerFetchShare(""), true);
  assert.equal(resolvePackWorkerFetchShare("?x=1"), true);
  for (const on of ["on", "1", "true", "yes", "", "garbage"]) {
    assert.equal(resolvePackWorkerFetchShare(`?packWorkerFetchShare=${on}`), true, on);
  }
  for (const off of ["off", "0", "false", "no"]) {
    assert.equal(resolvePackWorkerFetchShare(`?packWorkerFetchShare=${off}`), false, off);
  }
});

await t("W8 index.html marks D-03.10's cap; url-flags.md row", () => {
  const htmlPath = process.env.HB_INDEX_HTML || path.join(APP, "index.html");
  const html = readFileSync(htmlPath, "utf8");
  const at = html.indexOf("globalThis.__hbFetchConcurrencyTotal = 8;");
  assert.ok(at > 0, "D-03.10 block not found");
  const block = html.slice(at, at + 600);
  assert.match(block, /globalThis\.__hbFetchConcurrencyPackCapped = true;/, "D-03.10 block must set the marker");
  // The marker is set before the split runs.
  const split = html.indexOf("applyFetchConcurrencySplit();");
  assert.ok(split > at, "the split must run after the D-03.10 block");
  const docsPath = process.env.HB_URL_FLAGS_MD || path.join(APP, "docs", "url-flags.md");
  const docs = readFileSync(docsPath, "utf8");
  const row = docs.split("\n").find((l) => l.startsWith("| `packWorkerFetchShare` |"));
  assert.ok(row, "url-flags.md row `| \\`packWorkerFetchShare\\` |` missing");
  assert.match(row, /`off`\/`0`\/`false`\/`no`/);
  assert.match(row, /bake_worker_client\.js/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
