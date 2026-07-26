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
  splitEntityBatchGroupWaves,
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

// ==========================================================================
// ENTITY LEGS (2026-07-26) — `fetchEntitySurfacesPixels` +
// `fetchEntitySurfacesPixelsBatch`. A16 shipped covering only the landblock
// pair, so "verdict 4's refutation never armed the entity legs". Same
// assertions as above, plus the group-boundary splitter the batch leg needs.
// ==========================================================================

// ---- group-wave split ----------------------------------------------------
check("entity-batch: empty group list => no waves",
  eq(splitEntityBatchGroupWaves([], 16), []));
check("entity-batch: uncapped => ONE whole-batch group range",
  eq(splitEntityBatchGroupWaves([4, 4, 4], 0), [[0, 3]]));
check("entity-batch: under budget => ONE range",
  eq(splitEntityBatchGroupWaves([4, 4, 4], 16), [[0, 3]]));
check("entity-batch: packs whole groups up to the DID budget",
  eq(splitEntityBatchGroupWaves([6, 6, 6, 6], 12), [[0, 2], [2, 4]]),
  JSON.stringify(splitEntityBatchGroupWaves([6, 6, 6, 6], 12)));
check("entity-batch: a group LONGER than the cap ships alone (never split)",
  eq(splitEntityBatchGroupWaves([2, 40, 2], 8), [[0, 1], [1, 2], [2, 3]]),
  JSON.stringify(splitEntityBatchGroupWaves([2, 40, 2], 8)));
check("entity-batch: zero-length groups never emit an empty wave",
  eq(splitEntityBatchGroupWaves([0, 0, 0], 4), [[0, 3]]));
{
  // Same tiling invariant as the flat splitter, over GROUPS.
  let ok = true;
  for (const lens of [[6, 6, 6, 6], [1, 1, 1, 1, 1], [40], [3, 9, 2, 7, 5]]) {
    for (const cap of [1, 4, 8, 12, 64]) {
      let next = 0;
      for (const [lo, hi] of splitEntityBatchGroupWaves(lens, cap)) {
        if (lo !== next || hi <= lo || hi > lens.length) { ok = false; break; }
        next = hi;
      }
      if (next !== lens.length) ok = false;
    }
  }
  check("entity-batch: group ranges tile [0,nGroups) exactly for every shape", ok);
}

/** Entity-leg twin of `stubbedClient`. */
function stubbedEntityClient(batchMax) {
  const c = new BakeWorkerClient().configure({ batchMax });
  Object.defineProperty(c, "active", { value: true });
  const calls = [];
  c._fetchEntitySurfacesPixelsOnce = async (_w, dids, paletteId, subPalettes, urgent) => {
    calls.push({ dids, paletteId, subPalettes, urgent });
    const out = Array.from(dids, (d) => ({ did: d >>> 0 }));
    out.decodeMisses = 1;
    out.provenAbsent = [`0x${(dids[0] >>> 0).toString(16)}`];
    return out;
  };
  c._fetchEntitySurfacesPixelsBatchOnce = async (
    _w, flatDids, lens, basePals, flatSubs, tripleCounts, urgent,
  ) => {
    calls.push({ flatDids, lens, basePals, flatSubs, tripleCounts, urgent });
    // Mimic the handle: one group per `lens` entry, single-shot payloadAt.
    let off = 0;
    const groups = Array.from(lens, (l) => {
      const g = Array.from({ length: l >>> 0 }, (_, k) => ({ did: flatDids[off + k] >>> 0 }));
      off += l >>> 0;
      return g;
    });
    const h = {
      get len() { return groups.length; },
      payloadAt(i) { const g = groups[i] ?? null; groups[i] = null; return g; },
      wasDrained(i) { return groups[i] == null; },
      free() { h.freed = true; },
      freed: false,
    };
    h.decodeMisses = 1;
    h.provenAbsent = [`0x${(basePals[0] >>> 0).toString(16)}`];
    return h;
  };
  return { c, calls };
}

const SUBS = Uint32Array.from([0x11, 0x22, 0x33]);

// NEGATIVE CONTROL — unarmed single leg.
{
  const { c, calls } = stubbedEntityClient(0);
  const res = await c.fetchEntitySurfacesPixels({}, DIDS, 0x0400007E, SUBS, false);
  check("unarmed entity-surfaces: exactly one round trip", calls.length === 1,
    String(calls.length));
  check("unarmed entity-surfaces: the ORIGINAL argument objects pass through",
    calls[0].dids === DIDS && calls[0].subPalettes === SUBS);
  check("unarmed entity-surfaces: result is the untouched single-call result",
    res.length === 35 && res.decodeMisses === 1 && eq(res.provenAbsent, ["0x8000000"]));
}
{
  const { c, calls } = stubbedEntityClient(64);
  await c.fetchEntitySurfacesPixels({}, DIDS, 1, SUBS, false);
  check("entity-surfaces armed above the batch size: one round trip, original object",
    calls.length === 1 && calls[0].dids === DIDS);
}

// Armed and exceeded — waves, order, audit merge, and palette-state identity.
{
  const { c, calls } = stubbedEntityClient(16);
  const res = await c.fetchEntitySurfacesPixels({}, DIDS, 0x0400007E, SUBS, true);
  check("armed entity-surfaces: ceil(35/16) = 3 waves", calls.length === 3,
    String(calls.length));
  check("armed entity-surfaces: wave sizes are 16/16/3",
    eq(calls.map((w) => w.dids.length), [16, 16, 3]));
  check("armed entity-surfaces: every wave is a Uint32Array (wasm ABI unchanged)",
    calls.every((w) => w.dids instanceof Uint32Array));
  check("armed entity-surfaces: EVERY wave carries the same palette state",
    calls.every((w) => w.paletteId === 0x0400007E && w.subPalettes === SUBS));
  check("armed entity-surfaces: urgent rides through to every wave",
    calls.every((w) => w.urgent === true));
  check("armed entity-surfaces: result length == input length", res.length === 35);
  check("armed entity-surfaces: results are in INPUT order",
    res.every((r, i) => r.did === (DIDS[i] >>> 0)));
  check("armed entity-surfaces: decodeMisses SUM across waves", res.decodeMisses === 3,
    String(res.decodeMisses));
  check("armed entity-surfaces: provenAbsent is the UNION across waves",
    eq(res.provenAbsent, ["0x8000000", "0x8000010", "0x8000020"]),
    JSON.stringify(res.provenAbsent));
}
{
  const c = new BakeWorkerClient().configure({ batchMax: 16 });
  Object.defineProperty(c, "active", { value: true });
  c._fetchEntitySurfacesPixelsOnce = async (_w, dids) =>
    Array.from(dids, (d) => ({ did: d >>> 0 }));
  const res = await c.fetchEntitySurfacesPixels({}, DIDS, 1, SUBS, false);
  check("entity-surfaces legacy legs (no audit) => result stays legacy-shaped",
    res.length === 35 && !("decodeMisses" in res) && !("provenAbsent" in res));
}
{
  const c = new BakeWorkerClient().configure({ enabled: false, batchMax: 4 });
  let got = null;
  const wasm = {
    fetchEntitySurfacesPixels: (d) => { got = d; return "RAW"; },
  };
  const r = await c.fetchEntitySurfacesPixels(wasm, DIDS, 1, SUBS, false);
  check("inactive entity-surfaces: straight to the raw wasm export, original object",
    r === "RAW" && got === DIDS);
}

// ---- the GROUP-encoded batch leg ----------------------------------------
// 4 groups x 6 DIDs, 1 sub-palette triple each.
const B_LENS = Uint32Array.from([6, 6, 6, 6]);
const B_FLAT = Uint32Array.from({ length: 24 }, (_, i) => 0x08000000 + i);
const B_PALS = Uint32Array.from([0x04000001, 0x04000002, 0x04000003, 0x04000004]);
const B_TRIPLES = Uint32Array.from([1, 1, 1, 1]);
const B_SUBS = Uint32Array.from({ length: 12 }, (_, i) => 0x0500 + i);

{
  const { c, calls } = stubbedEntityClient(0);
  const h = await c.fetchEntitySurfacesPixelsBatch(
    {}, B_FLAT, B_LENS, B_PALS, B_SUBS, B_TRIPLES, false);
  check("unarmed entity-batch: exactly one round trip", calls.length === 1,
    String(calls.length));
  check("unarmed entity-batch: ALL FIVE original argument objects pass through",
    calls[0].flatDids === B_FLAT && calls[0].lens === B_LENS
      && calls[0].basePals === B_PALS && calls[0].flatSubs === B_SUBS
      && calls[0].tripleCounts === B_TRIPLES);
  check("unarmed entity-batch: the single-call handle is returned untouched",
    h.len === 4 && h.decodeMisses === 1);
}
{
  const { c, calls } = stubbedEntityClient(64);
  await c.fetchEntitySurfacesPixelsBatch(
    {}, B_FLAT, B_LENS, B_PALS, B_SUBS, B_TRIPLES, false);
  check("entity-batch armed above the batch size: one round trip, original objects",
    calls.length === 1 && calls[0].flatDids === B_FLAT);
}
{
  const { c, calls } = stubbedEntityClient(12); // 2 groups per wave
  const h = await c.fetchEntitySurfacesPixelsBatch(
    {}, B_FLAT, B_LENS, B_PALS, B_SUBS, B_TRIPLES, true);
  check("armed entity-batch: 2 waves of 2 groups", calls.length === 2, String(calls.length));
  check("armed entity-batch: each wave is a SELF-CONSISTENT sub-batch (lens sum == flatDids len)",
    calls.every((w) =>
      Array.from(w.lens).reduce((a, b) => a + b, 0) === w.flatDids.length
      && w.lens.length === w.basePals.length
      && w.lens.length === w.tripleCounts.length
      && Array.from(w.tripleCounts).reduce((a, b) => a + b, 0) * 3 === w.flatSubs.length),
    JSON.stringify(calls.map((w) => [Array.from(w.lens), w.flatDids.length, w.flatSubs.length])));
  check("armed entity-batch: per-group palettes stay bound to their group",
    eq(Array.from(calls[0].basePals), [0x04000001, 0x04000002])
      && eq(Array.from(calls[1].basePals), [0x04000003, 0x04000004]));
  check("armed entity-batch: sub-palette triples are sliced with the *3 stride",
    eq(Array.from(calls[0].flatSubs), [0x0500, 0x0501, 0x0502, 0x0503, 0x0504, 0x0505])
      && eq(Array.from(calls[1].flatSubs), [0x0506, 0x0507, 0x0508, 0x0509, 0x050a, 0x050b]),
    JSON.stringify([Array.from(calls[0].flatSubs), Array.from(calls[1].flatSubs)]));
  check("armed entity-batch: urgent rides through to every wave",
    calls.every((w) => w.urgent === true));
  check("armed entity-batch: merged handle exposes all groups in INPUT order",
    h.len === 4);
  const g0 = h.payloadAt(0);
  const g3 = h.payloadAt(3);
  check("armed entity-batch: payloadAt returns the right group's DIDs",
    g0[0].did === 0x08000000 && g3[0].did === 0x08000012,
    `${g0[0].did.toString(16)} ${g3[0].did.toString(16)}`);
  check("armed entity-batch: payloadAt is single-shot (MOVE) like the wasm handle",
    h.payloadAt(0) === null && h.wasDrained(0) === true && h.wasDrained(1) === false);
  check("armed entity-batch: out-of-range payloadAt is null / wasDrained true",
    h.payloadAt(99) === null && h.wasDrained(99) === true);
  check("armed entity-batch: decodeMisses SUM + provenAbsent UNION across waves",
    h.decodeMisses === 2 && eq(h.provenAbsent, ["0x4000001", "0x4000003"]),
    `${h.decodeMisses} ${JSON.stringify(h.provenAbsent)}`);
}
{
  // Oversized single group: still one wave for it, and the batch stays valid.
  const lens = Uint32Array.from([2, 9, 2]);
  const flat = Uint32Array.from({ length: 13 }, (_, i) => 0x08000000 + i);
  const pals = Uint32Array.from([1, 2, 3]);
  const triples = Uint32Array.from([0, 0, 0]);
  const { c, calls } = stubbedEntityClient(4);
  const h = await c.fetchEntitySurfacesPixelsBatch(
    {}, flat, lens, pals, Uint32Array.from([]), triples, false);
  check("armed entity-batch: an oversized group ships alone, batch still complete",
    calls.length === 3 && h.len === 3
      && eq(calls.map((w) => w.flatDids.length), [2, 9, 2]),
    JSON.stringify(calls.map((w) => w.flatDids.length)));
  check("armed entity-batch: empty flatSubs round-trips as empty per wave",
    calls.every((w) => w.flatSubs.length === 0));
}
{
  const c = new BakeWorkerClient().configure({ enabled: false, batchMax: 4 });
  let got = null;
  const wasm = {
    fetchEntitySurfacesPixelsBatch: (f) => { got = f; return "RAW"; },
  };
  const r = await c.fetchEntitySurfacesPixelsBatch(
    wasm, B_FLAT, B_LENS, B_PALS, B_SUBS, B_TRIPLES, false);
  check("inactive entity-batch: straight to the raw wasm export, original object",
    r === "RAW" && got === B_FLAT);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
