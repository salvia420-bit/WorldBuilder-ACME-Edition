// tests/interior_hold.test.mjs — `?interiorHold` (2026-10-09).
//
// A new character spawns inside a Training Academy. On the 1070 (fresh
// profile, raw link) the t1024 terrain promotion (68 MB) and the macro maps
// (9 MB) shared Chrome's six HTTP/1.1 connections with the academy's 2,037
// one-record requests. `tickPvsLoadExpansion` (cells.js) now publishes
// `window.__interiorBuildPending` and those downloads wait on it
// (bandwidth_tier.js `interiorBuildPending` / `holdForInterior`; the ladder
// side is PART 11 of harness/test_terrain_tier_ladder.mjs).
//
//   H1  indoors, own interior in flight → pending
//   H2  own interior built → not pending
//   H3  outdoors → never pending (even with a build in flight)
//   H4  own interior out of retries (not in flight, not built) → not pending
//   H5  `?interiorHold=off` → interiorBuildPending() is false
//   H6  holdForInterior: "not-pending" at once / "built" / "timeout"
//   H7  the full-tier texture record fetch (bc7_textures.js `_begin`) waits
//   H8  texchan sidecar fetches wait; other suite artifact types do not
//
// Run: node tests/interior_hold.test.mjs

import assert from "node:assert/strict";

globalThis.location = { search: "" };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.window = globalThis;

const { tickPvsLoadExpansion } = await import("../scene3d/cells.js");
const { interiorBuildPending, holdForInterior } = await import("../scene3d/bandwidth_tier.js");

const ACADEMY = 0x86020000;
const SPAWN_CELL = (ACADEMY | 0x01ad) >>> 0;

function makeScene({ inFlight = [], loaded = [] } = {}) {
  return {
    pvsRingRadius: 5,
    _sealedEvictLbKey: 0,
    envCellBuildInFlight: new Set(inFlight.map((k) => k >>> 0)),
    envCellLoadedLbs: new Set(loaded.map((k) => k >>> 0)),
    loadEnvCellsForLandblock(lb) {
      this.envCellBuildInFlight.add(lb >>> 0);
      return Promise.resolve();
    },
  };
}
const handle = (indoor) => ({
  getRenderSet: () => new Uint32Array([indoor ? SPAWN_CELL : (ACADEMY | 0x0021) >>> 0]),
  isCurrentCellIndoor: () => indoor,
});

let groups = 0;
let failures = 0;
async function t(name, fn) {
  try {
    await fn();
    groups++;
    console.log("  ok ", name);
  } catch (e) {
    failures++;
    console.log("  FAIL", name);
    console.log(e);
  }
}

await t("H1 indoors, own interior in flight: pending", () => {
  window.__interiorBuildPending = false;
  tickPvsLoadExpansion(makeScene({ inFlight: [ACADEMY] }), handle(true));
  assert.equal(window.__interiorBuildPending, true);
  assert.equal(interiorBuildPending(), true);
});

await t("H2 own interior built: not pending", () => {
  window.__interiorBuildPending = true;
  tickPvsLoadExpansion(makeScene({ loaded: [ACADEMY] }), handle(true));
  assert.equal(window.__interiorBuildPending, false);
});

await t("H3 outdoors: never pending", () => {
  window.__interiorBuildPending = true;
  tickPvsLoadExpansion(makeScene({ inFlight: [ACADEMY] }), handle(false));
  assert.equal(window.__interiorBuildPending, false);
});

await t("H4 own interior out of retries: not pending (the hold cannot wedge)", () => {
  const s = makeScene();
  s._envCellRingAttempts = new Map([[ACADEMY >>> 0, { n: 99, nextMs: Infinity }]]);
  window.__interiorBuildPending = true;
  tickPvsLoadExpansion(s, handle(true));
  assert.equal(window.__interiorBuildPending, false);
});

await t("H5 ?interiorHold=off: interiorBuildPending() is false", () => {
  window.__interiorBuildPending = true;
  assert.equal(interiorBuildPending("?interiorHold=off"), false);
  assert.equal(interiorBuildPending("?interiorHold=0"), false);
  assert.equal(interiorBuildPending(""), true);
});

await t("H6 holdForInterior: not-pending / built / timeout", async () => {
  window.__interiorBuildPending = false;
  assert.equal(await holdForInterior({ pollMs: 5 }), "not-pending");
  window.__interiorBuildPending = true;
  const p = holdForInterior({ pollMs: 5 });
  setTimeout(() => { window.__interiorBuildPending = false; }, 30);
  assert.equal(await p, "built");
  window.__interiorBuildPending = true;
  assert.equal(await holdForInterior({ pollMs: 5, maxMs: 20 }), "timeout");
  window.__interiorBuildPending = false;
});

await t("H7 full-tier record fetch waits while an interior is pending", async () => {
  const { Bc7RecordSource } = await import("../scene3d/bc7_textures.js");
  const asked = [];
  const src = new Bc7RecordSource({ budgetBytes: Infinity, fetchImpl: (id) => { asked.push(id); return new Uint8Array(0); } });
  window.__interiorBuildPending = true;
  const p = src.getAsync(0x06001234);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(asked, []);
  window.__interiorBuildPending = false;
  await p;
  assert.deepEqual(asked, [0x06001234]);
});

await t("H8 texchan sidecars wait; other suite artifacts do not", async () => {
  const { SuiteAssetSource } = await import("../scene3d/suite_assets.js");
  const asked = [];
  const src = new SuiteAssetSource({ fetchImpl: (key, type) => { asked.push(type); return new Uint8Array(0); } });
  window.__interiorBuildPending = true;
  const tc = src.getByKeyAsync("0x0800ABCD", "texchan");
  const other = src.getByKeyAsync("0x0800ABCD", "wind");
  await other;
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(asked, ["wind"]);
  window.__interiorBuildPending = false;
  await tc;
  assert.deepEqual(asked, ["wind", "texchan"]);
});

console.log(`\n${groups} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
