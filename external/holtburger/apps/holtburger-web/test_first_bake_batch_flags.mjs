// A16 (2026-07-25) — `?bakeBatchMax=N`: per-SUBMISSION batch cap for the
// worker-routed decode funnels.
//
// The lever exists because every gate in the pipeline bounds CONCURRENCY and
// none bounds SIZE: `fetch_surfaces_pixels` / `fetch_model_meshes` (src/lib.rs)
// each materialise the whole batch's decoded output before returning, so one
// submission is one decode-admission lease no matter how tight the cap. This
// suite pins the host half — the grammar, the wave split, the ORDER-PRESERVING
// concatenation and audit merge, and above all the negative control: an
// unauthored page takes the single-call path with the caller's original
// argument object, i.e. bit-for-bit the pre-A16 behaviour.
//
//   node apps/holtburger-web/test_first_bake_batch_flags.mjs

import {
  BakeWorkerClient,
  parseBakeBatchMax,
  resolveBakeBatchMax,
  splitBatchWaves,
} from "./scene3d/bake_worker_client.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- grammar -------------------------------------------------------------
check("plain integer parses", parseBakeBatchMax("64") === 64);
check("whitespace tolerated", parseBakeBatchMax("  64 ") === 64);
check("float floors", parseBakeBatchMax("64.9") === 64);
check("1 is a legal (degenerate) cap", parseBakeBatchMax("1") === 1);
for (const off of [null, undefined, "", "off", "false", "0", "-4", "abc", "1e", "NaN"]) {
  check(`${JSON.stringify(off)} => 0 (uncapped)`, parseBakeBatchMax(off) === 0,
    String(parseBakeBatchMax(off)));
}

check("no param => 0", resolveBakeBatchMax("") === 0);
check("unrelated params => 0", resolveBakeBatchMax("?nosw=1&agent=1") === 0);
check("?bakeBatchMax=48 resolves", resolveBakeBatchMax("?nosw=1&bakeBatchMax=48") === 48);
check("?bakeBatchMax=off resolves to 0", resolveBakeBatchMax("?bakeBatchMax=off") === 0);

// ---- wave split ----------------------------------------------------------
check("empty input => no waves", eq(splitBatchWaves(0, 16), []));
check("uncapped => ONE whole-batch range", eq(splitBatchWaves(500, 0), [[0, 500]]));
check("len <= cap => ONE whole-batch range", eq(splitBatchWaves(16, 16), [[0, 16]]));
check("len > cap splits", eq(splitBatchWaves(35, 16), [[0, 16], [16, 32], [32, 35]]));
check("cap 1 => one wave per item", eq(splitBatchWaves(3, 1), [[0, 1], [1, 2], [2, 3]]));
{
  // Coverage invariant: the ranges tile [0, len) exactly, in order, with no
  // gap or overlap — the property the index-binding consumers depend on.
  let ok = true;
  for (const [len, cap] of [[35, 16], [64, 16], [1, 16], [129, 32], [7, 3]]) {
    let next = 0;
    for (const [lo, hi] of splitBatchWaves(len, cap)) {
      if (lo !== next || hi <= lo || hi > len) { ok = false; break; }
      next = hi;
    }
    if (next !== len) ok = false;
  }
  check("wave ranges tile [0,len) exactly for every shape", ok);
}

// ---- client wiring -------------------------------------------------------
// `configure({})` reads the page query string; node has no `location`, so the
// unauthored default must survive that.
check("configure() with no location => uncapped",
  new BakeWorkerClient().configure({}).batchMax === 0);
check("configure({batchMax}) arms without a URL",
  new BakeWorkerClient().configure({ batchMax: 24 }).batchMax === 24);
check("configure({batchMax: 0}) stays uncapped",
  new BakeWorkerClient().configure({ batchMax: 0 }).batchMax === 0);

/** A client with the worker pretend-active and the round-trip stubbed. */
function stubbedClient(batchMax) {
  const c = new BakeWorkerClient().configure({ batchMax });
  Object.defineProperty(c, "active", { value: true });
  const calls = [];
  c._fetchSurfacesPixelsOnce = async (_w, dids, _urgent) => {
    calls.push(dids);
    const out = Array.from(dids, (d) => ({ did: d >>> 0 }));
    out.decodeMisses = 1;
    out.provenAbsent = [`0x${(dids[0] >>> 0).toString(16)}`];
    return out;
  };
  c._fetchModelMeshesOnce = async (_w, ids, _urgent) => {
    calls.push(ids);
    return Array.from(ids, (v) => ({ id: v >>> 0 }));
  };
  return { c, calls };
}

const DIDS = Uint32Array.from({ length: 35 }, (_, i) => 0x08000000 + i);

// NEGATIVE CONTROL — unarmed: exactly one round trip, and it receives the
// caller's ORIGINAL argument object (not a copy), so the pre-A16 path is
// entered byte-for-byte.
{
  const { c, calls } = stubbedClient(0);
  const res = await c.fetchSurfacesPixels({}, DIDS, false);
  check("unarmed surfaces: exactly one round trip", calls.length === 1, String(calls.length));
  check("unarmed surfaces: the ORIGINAL argument object is passed through", calls[0] === DIDS);
  check("unarmed surfaces: result is the untouched single-call result",
    res.length === 35 && res.decodeMisses === 1 && eq(res.provenAbsent, ["0x8000000"]));
}
{
  const { c, calls } = stubbedClient(0);
  await c.fetchModelMeshes({}, DIDS, false);
  check("unarmed meshes: exactly one round trip", calls.length === 1, String(calls.length));
  check("unarmed meshes: the ORIGINAL argument object is passed through", calls[0] === DIDS);
}

// Armed but not exceeded — still the single-call path with the original object.
{
  const { c, calls } = stubbedClient(64);
  await c.fetchSurfacesPixels({}, DIDS, false);
  check("armed above the batch size: still one round trip, original object",
    calls.length === 1 && calls[0] === DIDS);
}

// Armed and exceeded — sequential waves, order preserved, audits merged.
{
  const { c, calls } = stubbedClient(16);
  const res = await c.fetchSurfacesPixels({}, DIDS, false);
  check("armed surfaces: ceil(35/16) = 3 waves", calls.length === 3, String(calls.length));
  check("armed surfaces: wave sizes are 16/16/3",
    eq(calls.map((w) => w.length), [16, 16, 3]));
  check("armed surfaces: every wave is a Uint32Array (wasm ABI unchanged)",
    calls.every((w) => w instanceof Uint32Array));
  check("armed surfaces: result length == input length", res.length === 35);
  check("armed surfaces: results are in INPUT order (consumers bind by index)",
    res.every((r, i) => r.did === (DIDS[i] >>> 0)));
  check("armed surfaces: decodeMisses SUM across waves", res.decodeMisses === 3,
    String(res.decodeMisses));
  check("armed surfaces: provenAbsent is the UNION across waves",
    eq(res.provenAbsent, ["0x8000000", "0x8000010", "0x8000020"]),
    JSON.stringify(res.provenAbsent));
}
{
  const { c, calls } = stubbedClient(10);
  const res = await c.fetchModelMeshes({}, DIDS, false);
  check("armed meshes: ceil(35/10) = 4 waves", calls.length === 4, String(calls.length));
  check("armed meshes: result length == input length", res.length === 35);
  check("armed meshes: results are in INPUT order",
    res.every((m, i) => m.id === (DIDS[i] >>> 0)));
}

// A wave-split call whose legs carry NO audit must stay legacy-shaped, so
// materials.js's `surfaceResultProvenAbsent` never poisons its negative cache.
{
  const c = new BakeWorkerClient().configure({ batchMax: 16 });
  Object.defineProperty(c, "active", { value: true });
  c._fetchSurfacesPixelsOnce = async (_w, dids) => Array.from(dids, (d) => ({ did: d >>> 0 }));
  const res = await c.fetchSurfacesPixels({}, DIDS, false);
  check("legacy legs (no audit) => stitched result stays legacy-shaped",
    res.length === 35 && !("decodeMisses" in res) && !("provenAbsent" in res));
}

// Inactive client: the cap must never divert the `?bakeWorker=0` path, which
// is contractually the raw wasm export.
{
  const c = new BakeWorkerClient().configure({ enabled: false, batchMax: 4 });
  let got = null;
  const wasm = { fetch_surfaces_pixels: (d) => { got = d; return "RAW"; } };
  const r = await c.fetchSurfacesPixels(wasm, DIDS, false);
  check("inactive: goes straight to the raw wasm export with the original object",
    r === "RAW" && got === DIDS);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
