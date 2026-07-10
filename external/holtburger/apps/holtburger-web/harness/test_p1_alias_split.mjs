// harness/test_p1_alias_split.mjs — R-1 (net-review 2026-07-09, S1 fix #1) gate.
//
// `bake_worker_client` must decode tex-swap alias DIDs (0x08F00000+n — minted
// into the MAIN-thread wasm's per-instance TEX_SWAP_ALIASES registry by
// `walk_setup_parts`, src/lib.rs) on the main-thread wasm, route real DIDs to
// the bake worker, and stitch results back in the caller's index order.
// Pre-fix, alias DIDs went to the worker's own wasm instance (whose registry
// was never populated), decoded empty, and were negative-cached → grey/white
// texture-swap armor; `?bakeWorker=0` sessions were correct.
//
// Pure Node (no browser, no wasm): a stub global `Worker` replies with
// recognizable per-DID payloads (diffuse=1 provenance mark); a fake
// `wasmExports` marks main-thread decodes (diffuse=2). The `luminosity`
// field carries the DID so order-preservation is asserted per slot.
//
// Run: node harness/test_p1_alias_split.mjs

import { assert, assertEqual } from "./lib/assert.mjs";

const WORKER_MARK = 1;
const MAIN_MARK = 2;

// Payload shaped for bake_transfer.js::reconstructSurfacePixels (worker leg).
function spPayload(did, mark) {
  return {
    width: 2,
    height: 2,
    pixels: new Uint8Array(16),
    surfaceType: 0,
    category: 0,
    normalPixels: new Uint8Array(0),
    heightPixels: new Uint8Array(0),
    roughnessOverride: NaN,
    normalScaleOverride: NaN,
    translucency: 0,
    luminosity: did >>> 0, // identity channel: which DID this slot decodes
    diffuse: mark, // provenance channel: worker=1 / main=2
  };
}

// wasm-bindgen-handle shape for the main-thread leg (has `free`).
function mainHandle(did) {
  return {
    width: 1,
    height: 1,
    pixels: new Uint8Array(4),
    luminosity: did >>> 0,
    diffuse: MAIN_MARK,
    _freed: false,
    free() {
      this._freed = true;
    },
  };
}

class StubWorker {
  constructor() {
    StubWorker.instances.push(this);
    this.onmessage = null;
    this.onerror = null;
    this.requests = [];
  }
  postMessage(msg) {
    this.requests.push(msg);
    queueMicrotask(() => {
      if (!this.onmessage) return;
      const reply = (data) => this.onmessage({ data });
      if (msg.type === "init") return reply({ type: "ready", id: msg.id });
      if (StubWorker.failNextFetch) {
        StubWorker.failNextFetch = false;
        return reply({ type: "error", id: msg.id, message: "stub worker fetch failure" });
      }
      if (msg.type === "fetchSurfacesPixels" || msg.type === "fetchEntitySurfacesPixels") {
        return reply({
          type: "result",
          id: msg.id,
          kind: msg.type === "fetchSurfacesPixels" ? "surfaces" : "entitySurfaces",
          payload: msg.dids.map((did) => spPayload(did, WORKER_MARK)),
        });
      }
      if (msg.type === "fetchEntitySurfacesPixelsBatch") {
        const groups = [];
        let off = 0;
        for (const len of msg.lens) {
          groups.push(msg.flatDids.slice(off, off + len).map((d) => spPayload(d, WORKER_MARK)));
          off += len;
        }
        return reply({ type: "result", id: msg.id, kind: "entitySurfacesBatch", payload: groups });
      }
      return reply({ type: "error", id: msg.id, message: "stub: unknown " + msg.type });
    });
  }
  terminate() {}
}
StubWorker.instances = [];
StubWorker.failNextFetch = false;

// Install the stub BEFORE the module is imported so `client.active` sees it.
globalThis.Worker = StubWorker;

const { configureBakeWorker, partitionTexSwapAliasDids } = await import(
  "../scene3d/bake_worker_client.js"
);

function makeWasmExports(log) {
  return {
    async fetch_surfaces_pixels(ids, urgent) {
      const returned = [...ids].map((did) => mainHandle(did));
      log.push({ fn: "fetch_surfaces_pixels", ids: [...ids], urgent, returned });
      return returned;
    },
    async fetchEntitySurfacesPixels(ids, paletteId, subPalettes) {
      const returned = [...ids].map((did) => mainHandle(did));
      log.push({
        fn: "fetchEntitySurfacesPixels",
        ids: [...ids],
        paletteId,
        subPalettes: [...(subPalettes || [])],
        returned,
      });
      return returned;
    },
    async fetchEntitySurfacesPixelsBatch(flatDids, lens) {
      log.push({ fn: "fetchEntitySurfacesPixelsBatch", flatDids: [...flatDids], lens: [...lens] });
      return { __mainBatch: true, free() {} };
    },
  };
}

// Fetch messages the stub worker saw across all instances (init excluded).
function workerFetches() {
  return StubWorker.instances.flatMap((w) => w.requests.filter((r) => r.type !== "init"));
}
function resetWorkerLog() {
  for (const w of StubWorker.instances) w.requests.length = 0;
}

const ALIAS_A = 0x08f00000;
const ALIAS_B = 0x08f00007;
const REAL_A = 0x08000123;
const REAL_B = 0x08000456;

const failures = [];
async function run(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failures.push(name);
    console.error(`FAIL ${name}: ${(e && e.message) || e}`);
  }
}

// ── 1. partition: mask edges ────────────────────────────────────────────────
await run("partition mask edges", () => {
  const { arr, aliasIdx, realIdx } = partitionTexSwapAliasDids(
    Uint32Array.from([0x08f00000, 0x08efffff, 0x08ffffff, 0x09f00000, 0x08000123]),
  );
  assertEqual(arr.length, 5, "arr length");
  assertEqual(aliasIdx.join(","), "0,2", "alias indices (0x08F00000..0x08FFFFFF)");
  assertEqual(realIdx.join(","), "1,3,4", "real indices");
});

// ── 2. entity-surfaces: mixed request splits and stitches in order ─────────
await run("entity-surfaces mixed split", async () => {
  const client = configureBakeWorker({ enabled: true, aliasSplit: true });
  resetWorkerLog();
  const log = [];
  const wasm = makeWasmExports(log);
  const dids = Uint32Array.from([REAL_A, ALIAS_A, REAL_B, ALIAS_B]);
  const subs = Uint32Array.from([0x0400007e, 0, 0]);
  const out = await client.fetchEntitySurfacesPixels(wasm, dids, 0x04001234, subs);
  assertEqual(out.length, 4, "result length");
  for (let i = 0; i < 4; i += 1) {
    assertEqual(out[i].luminosity, dids[i], `slot ${i} decodes its own DID`);
  }
  assertEqual(out[0].diffuse, WORKER_MARK, "real slot 0 from worker");
  assertEqual(out[1].diffuse, MAIN_MARK, "alias slot 1 from main wasm");
  assertEqual(out[2].diffuse, WORKER_MARK, "real slot 2 from worker");
  assertEqual(out[3].diffuse, MAIN_MARK, "alias slot 3 from main wasm");
  const wf = workerFetches();
  assertEqual(wf.length, 1, "one worker fetch");
  assertEqual(wf[0].dids.join(","), [REAL_A, REAL_B].join(","), "worker got only real DIDs");
  assertEqual(log.length, 1, "one main-wasm call");
  assertEqual(log[0].ids.join(","), [ALIAS_A, ALIAS_B].join(","), "main got only alias DIDs");
  assertEqual(log[0].paletteId, 0x04001234, "same paletteId on the main leg");
  assertEqual(log[0].subPalettes.join(","), [...subs].join(","), "same subPalettes on the main leg");
});

// ── 3. no aliases → pure worker path, main untouched ────────────────────────
await run("no-alias request stays on the worker", async () => {
  const client = configureBakeWorker({ enabled: true, aliasSplit: true });
  resetWorkerLog();
  const log = [];
  const out = await client.fetchEntitySurfacesPixels(
    makeWasmExports(log),
    Uint32Array.from([REAL_A, REAL_B]),
    0,
    new Uint32Array(0),
  );
  assertEqual(log.length, 0, "main wasm never called");
  assertEqual(workerFetches().length, 1, "worker fetch fired");
  assert(out.every((sp) => sp.diffuse === WORKER_MARK), "all results from worker");
});

// ── 4. all-alias request → main only, no worker fetch ───────────────────────
await run("all-alias request skips the worker", async () => {
  const client = configureBakeWorker({ enabled: true, aliasSplit: true });
  resetWorkerLog();
  const log = [];
  const out = await client.fetchEntitySurfacesPixels(
    makeWasmExports(log),
    Uint32Array.from([ALIAS_A, ALIAS_B]),
    0,
    new Uint32Array(0),
  );
  assertEqual(workerFetches().length, 0, "no worker fetch for an all-alias list");
  assertEqual(log.length, 1, "one main-wasm call");
  assert(out.every((sp) => sp.diffuse === MAIN_MARK), "all results from main wasm");
});

// ── 5. plain surfaces path splits too (non-dyed entity preload) ─────────────
await run("plain surfaces split + urgent passthrough", async () => {
  const client = configureBakeWorker({ enabled: true, aliasSplit: true });
  resetWorkerLog();
  const log = [];
  const dids = Uint32Array.from([ALIAS_A, REAL_A]);
  const out = await client.fetchSurfacesPixels(makeWasmExports(log), dids, true);
  assertEqual(out[0].diffuse, MAIN_MARK, "alias slot from main wasm");
  assertEqual(out[1].diffuse, WORKER_MARK, "real slot from worker");
  const wf = workerFetches();
  assertEqual(wf[0].urgent, true, "urgent rode the worker leg");
  assertEqual(log[0].fn, "fetch_surfaces_pixels", "main leg used the plain fetcher");
  assertEqual(log[0].urgent, true, "urgent rode the main leg");
});

// ── 6. ?aliasSplit=off → pre-split routing (the bug arm) ────────────────────
await run("aliasSplit=off routes aliases to the worker", async () => {
  const client = configureBakeWorker({ enabled: true, aliasSplit: false });
  resetWorkerLog();
  const log = [];
  await client.fetchEntitySurfacesPixels(
    makeWasmExports(log),
    Uint32Array.from([ALIAS_A, REAL_A]),
    0,
    new Uint32Array(0),
  );
  assertEqual(log.length, 0, "main wasm never called with the flag off");
  assertEqual(
    workerFetches()[0].dids.join(","),
    [ALIAS_A, REAL_A].join(","),
    "worker received the alias DID (pre-split behaviour)",
  );
});

// ── 7. URL flag reader: 0/off/false = OFF, else ON ──────────────────────────
await run("aliasSplit URL reader", () => {
  for (const [search, want] of [
    ["?aliasSplit=off", false],
    ["?aliasSplit=0", false],
    ["?aliasSplit=false", false],
    ["?aliasSplit=1", true],
    ["", true],
  ]) {
    globalThis.location = { search };
    const client = configureBakeWorker({ enabled: true });
    assertEqual(client.aliasSplit, want, `search=${JSON.stringify(search)}`);
  }
  delete globalThis.location;
});

// ── 8. worker-leg failure mid-split → whole-request main fallback + no leak ─
await run("split worker failure falls back whole-request", async () => {
  const client = configureBakeWorker({ enabled: true, aliasSplit: true });
  resetWorkerLog();
  const log = [];
  StubWorker.failNextFetch = true;
  const dids = Uint32Array.from([REAL_A, ALIAS_A]);
  const out = await client.fetchEntitySurfacesPixels(
    makeWasmExports(log),
    dids,
    0,
    new Uint32Array(0),
  );
  assertEqual(log.length, 2, "main called for the alias leg + the full fallback");
  assertEqual(log[0].ids.join(","), String(ALIAS_A), "first main call = alias leg");
  assertEqual(log[1].ids.join(","), [REAL_A, ALIAS_A].join(","), "fallback carries ALL DIDs");
  assert(
    log[0].returned.every((sp) => sp._freed),
    "orphaned alias-leg handles were freed",
  );
  assertEqual(out.length, 2, "fallback result length");
  assert(out.every((sp) => sp.diffuse === MAIN_MARK), "fallback results from main wasm");
});

// ── 9. batch: any alias reroutes the whole batch to main wasm ───────────────
await run("batch with alias reroutes whole batch", async () => {
  const client = configureBakeWorker({ enabled: true, aliasSplit: true });
  resetWorkerLog();
  const log = [];
  const res = await client.fetchEntitySurfacesPixelsBatch(
    makeWasmExports(log),
    [REAL_A, ALIAS_A],
    [2],
    [0],
    [],
    [0],
  );
  assert(res.__mainBatch === true, "whole batch decoded on main wasm");
  assertEqual(workerFetches().length, 0, "no worker batch message");
  // Control: alias-free batch keeps the worker offload (facade round-trip).
  resetWorkerLog();
  const res2 = await client.fetchEntitySurfacesPixelsBatch(
    makeWasmExports(log),
    [REAL_A, REAL_B],
    [2],
    [0],
    [],
    [0],
  );
  assertEqual(workerFetches().length, 1, "alias-free batch went to the worker");
  assertEqual(res2.len, 1, "reconstructed batch group count");
});

if (failures.length) {
  console.error(`\n${failures.length} FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nOK test_p1_alias_split (9/9)");
