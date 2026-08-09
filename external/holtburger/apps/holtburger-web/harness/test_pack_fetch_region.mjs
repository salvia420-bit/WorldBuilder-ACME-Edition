// harness/test_pack_fetch_region.mjs — T12 GATE-WIRE-BOOT local battery
// (node arm): the REAL PackFetchController booting the REAL T10 baked
// region end-to-end — manifest → verified+pinned index → boot waves
// (CORE/commons/PVW/t128) → spawn ring + crossing — with hash-on-receipt
// via node's webcrypto for every CAS object and a mock wasm namespace
// capturing admissions.
//
// GATE-WIRE-BOOT criteria scored here at node/localhost scale:
//   0 hash mismatches, 0 terminal quarantines over the battery.
// Wire figures printed at the end are @scale:wire (T10 bounded region,
// file-backed fetch — NOT a T3-line measurement; those arms are
// DEFERRED-TO-BATCH per the T12 report).
//
// FAILS LOUD when the corpus mount is missing (house rule; the
// test_texture_worker_real.mjs precedent). Run:
//   node harness/test_pack_fetch_region.mjs

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createPackFetchController } from "../scene3d/pack_fetch_controller.js";

const REGION = "/mnt/wbterminal2/reeng/T10/ci-run1";
if (!existsSync(path.join(REGION, "manifest.json"))) {
  console.error(`FAIL: T10 baked region missing at ${REGION} — mount /mnt/wbterminal2`);
  process.exit(1);
}

let passed = 0;
let failed = 0;
const ok = (cond, label) => {
  if (cond) { passed += 1; }
  else { failed += 1; console.error(`  FAIL ${label}`); }
};

// fs-backed fetch: http://dist/<rel> → REGION/<rel>. Counts requests+bytes.
const wire = { requests: 0, bytes: 0 };
const fetchImpl = async (url, _init) => {
  const rel = url.replace(/^http:\/\/dist\//, "");
  const file = path.join(REGION, rel);
  wire.requests += 1;
  if (!existsSync(file)) return { ok: false, status: 404 };
  const body = readFileSync(file);
  wire.bytes += body.byteLength;
  return {
    ok: true, status: 200,
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    json: async () => JSON.parse(body.toString("utf8")),
  };
};

// Mock wasm namespace: records admissions like pack_source_glue would.
const inserted = new Map(); // hash -> bytes length
const wasmNs = {
  pack_source_insert: (hash, bytes) => {
    inserted.set(hash, bytes.length);
    return JSON.stringify({ kind: -1, recordsRegistered: 0, duplicate: inserted.has(hash) });
  },
  pack_source_stats: () => JSON.stringify({ packsResident: inserted.size }),
};

const ctl = createPackFetchController({
  fetchImpl,
  wasmNs,
  log: () => {}, warn: () => {},
  // deploy-skew/quarantine errors print via console.error — keep them loud.
});

const report = JSON.parse(readFileSync(path.join(REGION, "pack-report.json"), "utf8"));

// ── wave 0: manifest → pinned index ────────────────────────────────────────
{
  const { armed } = await ctl.boot("http://dist/manifest.json");
  ok(armed === true, "boot arms on a world_index manifest");
  ok(ctl.diag.pinnedIndex.length === 32, "session pinned to the index hash");
  ok(ctl.index.packs.length === report.packs_emitted,
    `index pack table matches bake report (${ctl.index.packs.length})`);
  const tiles = ctl.index.tileGrid.filter((v) => v !== 0xffff).length;
  ok(tiles === report.tiles, `tile grid population (${tiles})`);
  ok(ctl.index.interiors.size === report.interiors, `interior table (${ctl.index.interiors.size})`);
}

// ── waves 1–2 tail: commons + t128 slices, all hash-verified ───────────────
{
  await ctl.bootCommons();
  ok(ctl.getT128Slice("color") != null && ctl.getT128Slice("nra") != null,
    "t128 slices fetched on lane B (D-12.6)");
  ok(ctl.getT128Slice("color").byteLength === report.terrain_slice_color_bytes,
    "t128 color slice byte-exact vs bake report");
  ok(ctl.diag.byComponent.core.requests === 1, "CORE fetched once (component row)");
  ok(ctl.diag.byComponent.terrainTier.requests === 2, "2 terrain slice requests");
  ok(ctl.diag.milestones.inWorldMs != null, "in-world milestone stamped after wave 1");
}

// ── spawn ring (Holtburg boot LB 0xA9B4 — the T10 bake's boot ring) ────────
{
  ctl.notePlayerLandblock(0xa9b4);
  await ctl._idle(); // deterministic drain (queued+inflight empty)
  const d = ctl.diag;
  ok(d.lanes.U.done >= 1, "spawn tile rode lane U");
  ok(d.byComponent.tiles.requests >= 30, `ring tiles fetched (${d.byComponent.tiles.requests})`);
  ok(d.byComponent.pvw.requests >= 1, `ring PVW packs fetched (${d.byComponent.pvw.requests})`);
  ok(d.wireWaitEvents === 0, "cold-boot spawn tile does not count as a wire-wait (C5 is a walk gate)");
}

// ── crossing: one-LB west hop → lookahead + no duplicate fetches ───────────
{
  const before = wire.requests;
  ctl.notePlayerLandblock(0xa8b4);
  await ctl._idle();
  const delta = wire.requests - before;
  ok(delta <= 12, `crossing request budget C1-class (${delta} ≤ 12)`);
  // Same hop again: everything resident → zero network (C3 shape).
  const before2 = wire.requests;
  ctl.notePlayerLandblock(0xa9b4);
  ctl.notePlayerLandblock(0xa8b4);
  await ctl._idle();
  ok(wire.requests - before2 === 0, "re-crossing cached territory = 0 network (C3 shape)");
}

// ── THE GATE COUNTERS ──────────────────────────────────────────────────────
{
  const d = ctl.diag;
  ok(d.verify.mismatch === 0, `GATE-WIRE-BOOT: 0 hash mismatches (${d.verify.mismatch})`);
  ok(d.quarantinedTotal === 0, `GATE-WIRE-BOOT: 0 terminal quarantines (${d.quarantinedTotal})`);
  ok(d.verify.ok >= 40, `every CAS receipt verified (${d.verify.ok} ok)`);
  const failedTotal = Object.values(d.lanes).reduce((a, l) => a + l.failed, 0);
  ok(failedTotal === 0, `0 failed fetches across lanes (${failedTotal})`);
  // Every admitted pack hash is listed by the pinned index.
  const known = new Set(ctl.index.packs.map((p) => p.hash));
  ok([...inserted.keys()].every((h) => known.has(h)), "every admission is index-listed");
  ok(inserted.size >= 40, `admissions pushed to the wasm seam (${inserted.size} packs)`);

  console.log("\n[RESULTS] pack-fetch region battery (T10 bounded region, file-backed):");
  console.log(`  requests@wire@boot+ring+crossing = ${wire.requests}`);
  console.log(`  bytes@wire@boot+ring+crossing    = ${wire.bytes} (${(wire.bytes / 1048576).toFixed(2)} MiB)`);
  console.log(`  verify.ok=${d.verify.ok} mismatch=${d.verify.mismatch} quarantinedTotal=${d.quarantinedTotal}`);
  console.log(`  byComponent = ${JSON.stringify(Object.fromEntries(Object.entries(d.byComponent).filter(([, v]) => v.requests)))}`);
}

console.log(`\n${passed} passed, ${failed} failed  PACK-FETCH-REGION ${failed ? "❌" : "✅"}`);
process.exit(failed ? 1 : 0);
