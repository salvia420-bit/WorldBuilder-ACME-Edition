// tests/pack_ring_hold.test.mjs — `?packRingHold` (2026-10-09, cold-load A2 (c)).
//
// Under `?packSource`, `notePlayerLandblock` queues the ring on lane R (ring
// tiles, every ring interior pack, regionals; 12 in flight) with no regard for
// an interior build: at the academy that is 24 tile packs + 48 neighbour
// interior packs (5.9 MB) on the six HTTP/1.1 connections the build's records
// need. ON: while `interiorBuildPending()` (bandwidth_tier.js, the
// `?interiorHold` predicate) is true, queued lane-R packs stay queued — each
// at most `INTERIOR_HOLD_MAX_MS` — except the packs covering the building
// landblock (the player's tile pack, interior pack and supergrid regionals).
//
// Real controller, hand-built HBSI1 index, mocked fetch, injected clock and
// timer; hash-on-receipt runs (node webcrypto) against real CAS names.
//
//   H1  flag grammar
//   H2  not pending: lane R goes out as before (today's behaviour)
//   H3  pending: only lane U + the covering regionals go; neighbour
//       interiors (same tile included), ring tiles and other-supergrid
//       regionals wait; diag counts them
//   H4  the build lands → the recheck timer releases them in FIFO order
//   H5  ceiling: a pack held INTERIOR_HOLD_MAX_MS leaves on its own
//   H6  a held pack promoted to lane U goes at once
//   H7  =off / ?interiorHold=off / outdoors: no hold (the default predicate
//       reads window.__interiorBuildPending)
//   H8  in-flight packs are never cancelled; crossing away drops held packs
//   H9  one recheck timer at a time, none when nothing is held
//   H10 __hbFetch schema fields still published + ringHold; docs row
//
// Run: node tests/pack_ring_hold.test.mjs

import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

const {
  createPackFetchController, packRingHoldEnabled, SHARED_KIND, PACK_KIND, PackFetchError,
} = await import("../scene3d/pack_fetch_controller.js");
const { INTERIOR_HOLD_MAX_MS } = await import("../scene3d/bandwidth_tier.js");
const { getSurface } = await import("../harness/lib/diag_schema.mjs");

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

// ── a hand-built world: player LB 0x8102 (tile 64,1; supergrid 32) ──────────
// Ring tiles around it cross into supergrid 24 (tile x 62/63).
const PLAYER_LB = 0x8102;
const sgOf = (tx, ty) => ((tx * 2) >> 5) * 8 + ((ty * 2) >> 5);
const PACKS = []; // {name, kind, body, hash}
function addPack(name, kind) {
  const body = new TextEncoder().encode(`pack:${name}`);
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 32);
  PACKS.push({ name, kind, body, hash });
  return PACKS.length - 1;
}
const TILES = new Map(); // "tx,ty" -> ord
for (const [tx, ty] of [[64, 1], [65, 1], [64, 2], [63, 1], [62, 2]]) {
  TILES.set(`${tx},${ty}`, addPack(`tile ${tx},${ty}`, PACK_KIND.TILE));
}
const INTERIORS = new Map(); // lb -> ord
for (const lb of [PLAYER_LB, 0x8002 /* same tile, neighbour */, 0x8302 /* tile 65,1 */, 0x7e02 /* tile 63,1 */]) {
  INTERIORS.set(lb, addPack(`interior ${lb.toString(16)}`, PACK_KIND.INTERIOR));
}
const SHARED = []; // {kind, ord(sg), packOrd}
for (const [kind, sg, label] of [
  [SHARED_KIND.META_REGIONAL, 32, "meta-r sg32"],
  [SHARED_KIND.ENV_REGIONAL, 32, "env-r sg32"],
  [SHARED_KIND.PVW_REGIONAL, 32, "pvw-r sg32"],
  [SHARED_KIND.META_REGIONAL, 24, "meta-r sg24"],
  [SHARED_KIND.PVW_REGIONAL, 24, "pvw-r sg24"],
]) {
  SHARED.push({ kind, ord: sg, packOrd: addPack(label, PACK_KIND.META_SHARED) });
}
assert.equal(sgOf(64, 1), 32);
assert.equal(sgOf(63, 1), 24);

function buildIndex() {
  const packCount = PACKS.length;
  const buf = new Uint8Array(24 + packCount * 24 + 32768 + INTERIORS.size * 6 + SHARED.length * 4 + 8);
  const dv = new DataView(buf.buffer);
  buf.set([0x48, 0x42, 0x53, 0x49], 0);
  buf[4] = 1;
  dv.setUint32(8, packCount, true);
  dv.setUint32(12, INTERIORS.size, true);
  dv.setUint16(16, SHARED.length, true);
  dv.setUint32(20, 7, true);
  let pos = 24;
  for (const p of PACKS) {
    for (let j = 0; j < 16; j += 1) buf[pos + j] = parseInt(p.hash.slice(j * 2, j * 2 + 2), 16);
    dv.setUint32(pos + 16, p.body.length, true);
    buf[pos + 20] = p.kind;
    pos += 24;
  }
  for (let i = 0; i < 128 * 128; i += 1) dv.setUint16(pos + i * 2, 0xffff, true);
  for (const [k, ord] of TILES) {
    const [tx, ty] = k.split(",").map(Number);
    dv.setUint16(pos + (tx * 128 + ty) * 2, ord, true);
  }
  pos += 32768;
  for (const [lb, ord] of INTERIORS) {
    dv.setUint16(pos, lb, true);
    dv.setUint16(pos + 2, ord, true);
    pos += 6;
  }
  for (const s of SHARED) {
    buf[pos] = s.kind;
    buf[pos + 1] = s.ord;
    dv.setUint16(pos + 2, s.packOrd, true);
    pos += 4;
  }
  return buf;
}
const INDEX = buildIndex();
const INDEX_HASH = createHash("sha256").update(INDEX).digest("hex").slice(0, 32);
const BASE = "http://dist";
const MANIFEST = new TextEncoder().encode(JSON.stringify({
  world_index: { url: `index/${INDEX_HASH}.bin`, size: INDEX.length, sha256_16: INDEX_HASH },
  pack_url_template: "packs/{sha256_prefix2}/{sha256}.hbp",
}));
const URL_TO_NAME = new Map(PACKS.map((p) => [`${BASE}/packs/${p.hash.slice(0, 2)}/${p.hash}.hbp`, p.name]));

/** fetch mock: auto-serves known URLs unless stalled; logs pack names. */
function mockFetch() {
  const calls = [];
  const stalled = new Map(); // url -> resolve()
  const stall = new Set();
  const body = (url) => {
    if (url === `${BASE}/manifest.json`) return MANIFEST;
    if (url === `${BASE}/index/${INDEX_HASH}.bin`) return INDEX;
    const p = PACKS.find((x) => url.endsWith(`/${x.hash}.hbp`));
    return p ? p.body : null;
  };
  const impl = async (url) => {
    calls.push(URL_TO_NAME.get(url) || url);
    if (stall.has(url)) await new Promise((r) => stalled.set(url, r));
    const b = body(url);
    if (!b) return { ok: false, status: 404 };
    return {
      ok: true, status: 200,
      arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
      json: async () => JSON.parse(new TextDecoder().decode(b)),
    };
  };
  return { impl, calls, stall, stalled };
}
const digestSubtle = async (buf) => {
  const d = await webcrypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
};
const tick = async (n = 30) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
};

/** A booted controller with an injectable predicate, clock and timer. */
async function boot(extra = {}) {
  const fm = mockFetch();
  const state = { pending: false, clock: 1000, timers: [] };
  const ctl = createPackFetchController({
    fetchImpl: fm.impl,
    digestImpl: digestSubtle,
    now: () => state.clock,
    setTimeoutImpl: (fn, ms) => state.timers.push({ fn, ms }),
    interiorPending: () => state.pending,
    log: () => {}, warn: () => {}, error: () => {},
    ...extra,
  });
  const { armed } = await ctl.boot(`${BASE}/manifest.json`);
  assert.equal(armed, true);
  fm.calls.length = 0;
  return { ctl, fm, state };
}
const fire = async (state) => {
  const ts = state.timers.splice(0);
  for (const x of ts) x.fn();
  await tick();
};

const LANE_U = ["tile 64,1", "interior 8102"];
const COVER = ["meta-r sg32", "env-r sg32", "pvw-r sg32"];
const HELD = ["interior 8002", "tile 65,1", "interior 8302", "tile 64,2", "tile 63,1", "interior 7e02", "meta-r sg24", "pvw-r sg24", "tile 62,2"];

await t("H1 flag grammar: default on; off/0/false/no off", () => {
  assert.equal(packRingHoldEnabled(""), true);
  for (const on of ["on", "1", "true", "yes", "garbage", ""]) {
    assert.equal(packRingHoldEnabled(`?packRingHold=${on}`), true, on);
  }
  for (const off of ["off", "0", "false", "no"]) {
    assert.equal(packRingHoldEnabled(`?packRingHold=${off}`), false, off);
  }
});

await t("H2 not pending: lane R goes out as before", async () => {
  const { ctl, fm, state } = await boot();
  state.pending = false;
  ctl.notePlayerLandblock(PLAYER_LB);
  await tick();
  assert.deepEqual(new Set(fm.calls), new Set([...LANE_U, ...COVER, ...HELD]));
  assert.equal(ctl.diag.ringHold.active, false);
  assert.equal(ctl.diag.ringHold.heldTotal, 0);
  assert.equal(state.timers.length, 0, "no recheck timer when nothing is held");
});

await t("H3 pending: only lane U + the covering regionals go; the rest waits", async () => {
  const { ctl, fm, state } = await boot();
  state.pending = true;
  ctl.notePlayerLandblock(PLAYER_LB);
  await tick();
  assert.deepEqual(new Set(fm.calls), new Set([...LANE_U, ...COVER]));
  for (const n of HELD) assert.ok(!fm.calls.includes(n), `${n} must be held`);
  const rh = ctl.diag.ringHold;
  assert.equal(rh.enabled, true);
  assert.equal(rh.active, true);
  assert.equal(rh.held, HELD.length);
  assert.equal(rh.heldTotal, HELD.length);
  assert.equal(rh.exempt, COVER.length);
  assert.equal(ctl.diag.lanes.R.queued, HELD.length);
});

await t("H4 the build lands: the recheck releases them in FIFO order", async () => {
  const { ctl, fm, state } = await boot();
  state.pending = true;
  ctl.notePlayerLandblock(PLAYER_LB);
  await tick();
  const queuedOrder = ctl._queues.R.map((e) => URL_TO_NAME.get(e.url));
  fm.calls.length = 0;
  state.clock += 2500;
  await fire(state); // still pending: nothing moves, timer re-armed
  assert.equal(fm.calls.length, 0);
  assert.equal(state.timers.length, 1);
  state.pending = false;
  state.clock += 500;
  await fire(state);
  assert.deepEqual(fm.calls, queuedOrder, "released in queue (FIFO) order");
  const rh = ctl.diag.ringHold;
  assert.equal(rh.releasedBuilt, HELD.length);
  assert.equal(rh.releasedTimeout, 0);
  assert.equal(rh.maxHeldMs, 3000);
  assert.equal(rh.held, 0);
  assert.equal(rh.active, false);
  assert.equal(state.timers.length, 0, "no timer once nothing is held");
});

await t("H5 ceiling: a pack held INTERIOR_HOLD_MAX_MS leaves on its own", async () => {
  assert.equal(INTERIOR_HOLD_MAX_MS, 180000);
  const { ctl, fm, state } = await boot();
  state.pending = true;
  ctl.notePlayerLandblock(PLAYER_LB);
  await tick();
  fm.calls.length = 0;
  state.clock += INTERIOR_HOLD_MAX_MS - 1;
  await fire(state);
  assert.equal(fm.calls.length, 0, "1 ms before the ceiling: still held");
  state.clock += 1;
  await fire(state);
  assert.deepEqual(new Set(fm.calls), new Set(HELD), "at the ceiling every held pack goes");
  assert.equal(ctl.diag.ringHold.releasedTimeout, HELD.length);
  assert.equal(ctl.diag.ringHold.maxHeldMs, INTERIOR_HOLD_MAX_MS);
});

await t("H6 a held pack promoted to lane U goes at once", async () => {
  const { ctl, fm, state } = await boot();
  state.pending = true;
  ctl.notePlayerLandblock(PLAYER_LB);
  await tick();
  fm.calls.length = 0;
  const ord = INTERIORS.get(0x8002);
  const p = ctl.needPack(ord, { lane: "U" });
  await tick();
  assert.deepEqual(fm.calls, ["interior 8002"]);
  await p;
  assert.equal(ctl.diag.ringHold.releasedBuilt + ctl.diag.ringHold.releasedTimeout, 0, "a promotion is not a release");
  // The rest is still held.
  assert.equal(ctl.diag.ringHold.held, HELD.length - 1);
});

await t("H7 =off / ?interiorHold=off / outdoors: no hold", async () => {
  // Flag off.
  {
    const { ctl, fm, state } = await boot({ ringHold: false });
    state.pending = true;
    ctl.notePlayerLandblock(PLAYER_LB);
    await tick();
    assert.equal(fm.calls.length, LANE_U.length + COVER.length + HELD.length);
    assert.equal(ctl.diag.ringHold.enabled, false);
    const f2 = await boot({ search: "?packRingHold=0" });
    f2.state.pending = true;
    assert.equal(f2.ctl.diag.ringHold.enabled, false);
  }
  // The default predicate: bandwidth_tier.js interiorBuildPending (window flag
  // + ?interiorHold). Drop the injected predicate.
  const savedWindow = globalThis.window;
  globalThis.window = globalThis;
  try {
    for (const [search, pendingFlag, expectHeld] of [
      ["", true, true],
      ["?interiorHold=off", true, false],
      ["?interiorHold=0", true, false],
      ["", false, false],
    ]) {
      globalThis.__interiorBuildPending = pendingFlag;
      const fm = mockFetch();
      const ctl = createPackFetchController({
        fetchImpl: fm.impl, digestImpl: digestSubtle, search,
        setTimeoutImpl: () => {}, log: () => {}, warn: () => {}, error: () => {},
      });
      await ctl.boot(`${BASE}/manifest.json`);
      fm.calls.length = 0;
      ctl.notePlayerLandblock(PLAYER_LB);
      await tick();
      const heldNow = HELD.filter((n) => !fm.calls.includes(n)).length;
      assert.equal(heldNow, expectHeld ? HELD.length : 0, `search=${search} pending=${pendingFlag}`);
    }
  } finally {
    delete globalThis.__interiorBuildPending;
    if (savedWindow === undefined) delete globalThis.window;
    else globalThis.window = savedWindow;
  }
});

await t("H8 in-flight packs are never cancelled; crossing away drops held packs", async () => {
  const { ctl, fm, state } = await boot();
  // Stall one ring pack so it is in flight when the hold starts.
  const stalledUrl = [...URL_TO_NAME].find(([, n]) => n === "tile 63,1")[0];
  fm.stall.add(stalledUrl);
  state.pending = false;
  ctl.notePlayerLandblock(PLAYER_LB);
  await tick();
  assert.ok(fm.calls.includes("tile 63,1"));
  state.pending = true;
  const inflight = ctl._entries.get(stalledUrl);
  assert.equal(inflight.state, "inflight");
  fm.stalled.get(stalledUrl)();
  await tick();
  assert.equal(inflight.state, "done", "the in-flight pack completed under the hold");

  // Held packs, then a crossing far away: they leave the keep set and drop.
  const b = await boot();
  b.state.pending = true;
  b.ctl.notePlayerLandblock(PLAYER_LB);
  await tick();
  const held = b.ctl._queues.R.filter((e) => e.state === "queued");
  assert.equal(held.length, HELD.length);
  const errs = [];
  for (const e of held) e.promise.catch((err) => errs.push(err));
  b.ctl.notePlayerLandblock(0x2020); // far away: empty world there
  await tick();
  assert.equal(errs.length, HELD.length);
  assert.ok(errs.every((e) => e instanceof PackFetchError && e.kind === "dropped"));
  b.state.pending = false;
  await fire(b.state);
  assert.equal(b.ctl.diag.ringHold.releasedBuilt, 0, "dropped packs are not released");
});

await t("H9 one recheck timer at a time, none when nothing is held", async () => {
  const { ctl, state } = await boot();
  state.pending = true;
  ctl.notePlayerLandblock(PLAYER_LB);
  await tick();
  assert.equal(state.timers.length, 1);
  assert.equal(state.timers[0].ms, 500);
  ctl._pump();
  ctl._pump();
  assert.equal(state.timers.length, 1, "repeated pumps do not stack timers");
  await fire(state);
  assert.equal(state.timers.length, 1, "re-armed while still held");
  state.pending = false;
  await fire(state);
  assert.equal(state.timers.length, 0);
});

await t("H10 __hbFetch schema fields + ringHold; docs row", async () => {
  const { ctl } = await boot();
  const surface = getSurface("__hbFetch");
  for (const f of Object.keys(surface.fields)) {
    let cur = ctl.diag;
    for (const p of f.split(".")) {
      if (cur == null) break;
      cur = p === "*" ? cur[Object.keys(cur)[0]] : cur[p];
    }
    assert.notEqual(cur, undefined, `__hbFetch publishes ${f}`);
  }
  assert.deepEqual(Object.keys(ctl.diag.ringHold).sort(), [
    "active", "enabled", "exempt", "held", "heldTotal", "maxHeldMs", "releasedBuilt", "releasedTimeout",
  ]);
  const docsPath = process.env.HB_URL_FLAGS_MD || path.join(APP, "docs", "url-flags.md");
  const docs = readFileSync(docsPath, "utf8");
  const row = docs.split("\n").find((l) => l.startsWith("| `packRingHold` |"));
  assert.ok(row, "url-flags.md row `| \\`packRingHold\\` |` missing");
  assert.match(row, /`off`\/`0`\/`false`\/`no`/);
  assert.match(row, /pack_fetch_controller\.js/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
