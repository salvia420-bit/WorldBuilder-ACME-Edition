// 2026-08-05 (renderer-OOM attribution) — the page-side census roll-up
// (`scene3d/mem_census.js`).
//
// The Rust half is pinned by `cargo test -p holtburger-web --lib
// tests_mem_census`; this pins the half that turns two per-instance readings
// into the page-wide number a fix gets chosen from:
//
//   PART 1 — the two linear memories SUM. They are independent allocations
//            against one renderer-process cap, so a store that is large on
//            both halves must read as the sum, not as one half.
//   PART 2 — a missing half is UNKNOWN, never zero. A `pkg/` that predates
//            `hb_mem_census` (the standing staleness trap) must not make the
//            worker's memory look like it holds nothing.
//   PART 3 — `top` ranks by bytes, because "what is holding it" is the whole
//            question.
//   PART 4 — the verdict names the right one of the two OOM shapes, and warns
//            when the residual says the census itself is incomplete.
//   PART 5 — static: the shipped `index.js` actually consumes the module (a
//            diagnostic wired to nothing is the failure mode this catches).
//
// Run:
//   cd apps/holtburger-web/
//   node test_mem_census.mjs

import { fileURLToPath } from "node:url";
import { dirname, join as joinPath } from "node:path";
import { readFileSync } from "node:fs";
import { summarizeMemCensus, memCensusVerdict } from "./scene3d/mem_census.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

const MB = 1024 * 1024;

/** A census half shaped exactly like `hb_mem_census()`'s JSON. */
function half({ memory, live, peak, stores }) {
  const storeBytes = Object.values(stores).reduce((a, r) => a + r.bytes, 0);
  return {
    memoryBytes: memory,
    allocLive: live,
    allocPeak: peak,
    allocTotal: 999,
    storeBytes,
    unattributed: Math.max(0, live - storeBytes),
    slackBytes: Math.max(0, memory - live),
    decodePeakLiveBytes: 8 * MB,
    stores,
  };
}

console.log("PART 1 — the two instances sum");
{
  const main = half({
    memory: 400 * MB,
    live: 300 * MB,
    peak: 320 * MB,
    stores: {
      shardRecords: { bytes: 200 * MB, entries: 0, budget: -1 },
      surfacePixels: { bytes: 24 * MB, entries: 30, budget: 24 * MB },
    },
  });
  const worker = half({
    memory: 300 * MB,
    live: 250 * MB,
    peak: 260 * MB,
    stores: {
      shardRecords: { bytes: 150 * MB, entries: 0, budget: -1 },
      surfacePixels: { bytes: 64 * MB, entries: 80, budget: 64 * MB },
    },
  });
  const { page, missing } = summarizeMemCensus(main, worker);
  check("no half missing", missing.length === 0, `missing=${JSON.stringify(missing)}`);
  check("memoryBytes sums", page.memoryBytes === 700 * MB, `${page.memoryBytes / MB}MB`);
  check("allocLive sums", page.allocLive === 550 * MB, `${page.allocLive / MB}MB`);
  check("allocPeak sums", page.allocPeak === 580 * MB, `${page.allocPeak / MB}MB`);
  check(
    "a store large on BOTH halves reports the sum",
    page.stores.shardRecords.bytes === 350 * MB,
    `${page.stores.shardRecords.bytes / MB}MB`,
  );
  check(
    "entries sum too",
    page.stores.surfacePixels.entries === 110,
    `${page.stores.surfacePixels.entries}`,
  );
  check(
    "slack sums (100 + 50)",
    page.slackBytes === 150 * MB,
    `${page.slackBytes / MB}MB`,
  );
}

console.log("PART 2 — a missing half is UNKNOWN, not zero");
{
  const main = half({
    memory: 400 * MB,
    live: 300 * MB,
    peak: 320 * MB,
    stores: { shardRecords: { bytes: 200 * MB, entries: 0, budget: -1 } },
  });
  for (const [label, w] of [
    ["worker inactive (null)", null],
    ["stale pkg (no hb_mem_census export → no allocLive)", { memoryBytes: 1, stores: {} }],
  ]) {
    const { page, missing } = summarizeMemCensus(main, w);
    check(`${label}: named in missing`, missing.includes("worker"), JSON.stringify(missing));
    check(
      `${label}: main's numbers still land`,
      page.allocLive === 300 * MB,
      `${page.allocLive / MB}MB`,
    );
  }
  const { missing: bothGone } = summarizeMemCensus(null, null);
  check("both halves absent", bothGone.length === 2, JSON.stringify(bothGone));
}

console.log("PART 3 — top ranks by bytes");
{
  const stores = {
    surfacePixels: { bytes: 24 * MB, entries: 1, budget: 24 * MB },
    shardRecords: { bytes: 200 * MB, entries: 0, budget: -1 },
    modelTri: { bytes: 64 * MB, entries: 9, budget: 64 * MB },
    sceneryRecords: { bytes: 1 * MB, entries: 200, budget: -1 },
  };
  const { page } = summarizeMemCensus(
    half({ memory: 400 * MB, live: 300 * MB, peak: 300 * MB, stores }),
    null,
  );
  check("largest store first", page.top[0].startsWith("shardRecords"), page.top[0]);
  check("second largest next", page.top[1].startsWith("modelTri"), page.top[1]);
  check("MB-formatted", page.top[0] === "shardRecords 200.0MB", page.top[0]);
}

console.log("PART 4 — the verdict names the right OOM shape");
{
  // Retention: most of the linear memory is still owned, and a named store
  // holds it.
  const retention = summarizeMemCensus(
    half({
      memory: 400 * MB,
      live: 360 * MB,
      peak: 360 * MB,
      stores: { shardRecords: { bytes: 350 * MB, entries: 0, budget: -1 } },
    }),
    null,
  ).page;
  const rv = memCensusVerdict(retention);
  check("retention-shaped reading says RETENTION", rv.includes("RETENTION"), rv);
  check("...and does not cry unattributed", !rv.includes("unattributed"), rv);

  // High-water: linear memory is mostly allocator slack — no cache budget can
  // return it, which is the opposite fix.
  const highWater = summarizeMemCensus(
    half({
      memory: 700 * MB,
      live: 120 * MB,
      peak: 690 * MB,
      stores: { shardRecords: { bytes: 100 * MB, entries: 0, budget: -1 } },
    }),
    null,
  ).page;
  const hv = memCensusVerdict(highWater);
  check("slack-dominated reading says HIGH-WATER", hv.includes("HIGH-WATER"), hv);
  check("...and points at the decode bound", hv.includes("bound the decode"), hv);

  // Incomplete census: live bytes no row claims.
  const unattributed = summarizeMemCensus(
    half({
      memory: 700 * MB,
      live: 600 * MB,
      peak: 600 * MB,
      stores: { shardRecords: { bytes: 20 * MB, entries: 0, budget: -1 } },
    }),
    null,
  ).page;
  const uv = memCensusVerdict(unattributed);
  check("large residual is called out", uv.includes("unattributed"), uv);
  check("no reading at all degrades cleanly", memCensusVerdict(null) === "no reading");
}

console.log("PART 5 — the shipped renderer consumes the module");
{
  const idx = readFileSync(joinPath(__dirname, "scene3d", "index.js"), "utf8");
  check(
    "index.js imports the roll-up",
    /import\s*{[^}]*summarizeMemCensus[^}]*}\s*from\s*"\.\/mem_census\.js"/.test(idx),
  );
  check("__diag.wasmMem is defined", /window\.__diag\.wasmMem\s*=/.test(idx));
  check(
    "it asks the worker for its half",
    /getBakeWorkerClient\(\)\.wasmMemCensus\(\)/.test(idx),
  );
  const client = readFileSync(joinPath(__dirname, "scene3d", "bake_worker_client.js"), "utf8");
  check("the client relays wasmMemCensus", /_request\("wasmMemCensus"/.test(client));
  const worker = readFileSync(joinPath(__dirname, "scene3d", "bake_worker.js"), "utf8");
  check('the worker answers "wasmMemCensus"', /case "wasmMemCensus":/.test(worker));
  check(
    "the worker reads the export off the NAMESPACE (stale-pkg safety)",
    /__wasmNs\.hb_mem_census/.test(worker),
  );
  check(
    "...and does not name-import it (a stale pkg would module-link-error)",
    !/^\s*hb_mem_census,\s*$/m.test(worker),
  );
  // THE curated-opts plumb-through trap, which index.html documents in four
  // places because it keeps happening: `wasmExports` handed to init3D is a
  // hand-written object, not the module namespace. An export missing from it
  // is `undefined` at the reader, and this diagnostic's typeof guard would
  // then report the main instance as "no census" — indistinguishable from the
  // main instance holding nothing.
  const html = readFileSync(joinPath(__dirname, "index.html"), "utf8");
  check(
    "index.html threads hb_mem_census into the curated init3D opts",
    /hb_mem_census:\s*__hbWasmNs\.hb_mem_census/.test(html),
  );
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
