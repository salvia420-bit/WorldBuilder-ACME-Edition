// tests/envcell_skirt_wait.test.mjs — `?envcellSkirtWait` (2026-10-09).
//
// The interior ring (`tickPvsLoadExpansion`, PORTAL-P0 `?envcellRing`) bakes
// the render-set landblocks' EnvCells plus a radius-1 skirt. A new character
// spawns inside a Training Academy (0x8602, 568 cells); until that build lands
// nothing knows the dungeon is sealed, so the skirt started the west neighbour
// 0x8502 — another 568-cell academy — beside it, and on the 1070 the player's
// own academy appeared ~70 s after Enter. The skirt now waits while a
// render-set LB's own interior is mid-build.
//
//   S1  own interior in flight → no skirt bake starts
//   S2  own interior loaded → the skirt proceeds (one start per tick)
//   S3  nothing started yet → the tick starts the OWN interior, then waits
//   S4  a sealed dungeon still collapses the skirt to 0 (unchanged)
//   S5  `?envcellSkirtWait=off` → the old behaviour (skirt beside the build)
//
// Run: node tests/envcell_skirt_wait.test.mjs

import assert from "node:assert/strict";

globalThis.location = { search: "" };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.window = globalThis;

const { tickPvsLoadExpansion } = await import("../scene3d/cells.js");

const ACADEMY = 0x86020000;
const SPAWN_CELL = (ACADEMY | 0x01ad) >>> 0;
const cheb = (a, b) => Math.max(
  Math.abs(((a >>> 24) & 0xff) - ((b >>> 24) & 0xff)),
  Math.abs(((a >>> 16) & 0xff) - ((b >>> 16) & 0xff)),
);

function makeScene({ inFlight = [], loaded = [], sealed = 0 } = {}) {
  const calls = [];
  return {
    calls,
    pvsRingRadius: 5,
    _sealedEvictLbKey: sealed,
    envCellBuildInFlight: new Set(inFlight.map((k) => k >>> 0)),
    envCellLoadedLbs: new Set(loaded.map((k) => k >>> 0)),
    // Like cells.js: the in-flight mark is added synchronously at the start.
    loadEnvCellsForLandblock(lb) {
      calls.push(lb >>> 0);
      this.envCellBuildInFlight.add(lb >>> 0);
      return Promise.resolve();
    },
  };
}
const indoorHandle = {
  getRenderSet: () => new Uint32Array([SPAWN_CELL]),
  isCurrentCellIndoor: () => true,
};

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

await t("S1 own interior in flight: no skirt bake starts", () => {
  const s = makeScene({ inFlight: [ACADEMY] });
  for (let i = 0; i < 5; i++) tickPvsLoadExpansion(s, indoorHandle);
  assert.deepEqual(s.calls, []);
});

await t("S2 own interior loaded: the skirt proceeds, one start per tick", () => {
  const s = makeScene({ loaded: [ACADEMY] });
  tickPvsLoadExpansion(s, indoorHandle);
  assert.equal(s.calls.length, 1);
  assert.notEqual(s.calls[0], ACADEMY);
  assert.equal(cheb(s.calls[0], ACADEMY), 1);
});

await t("S3 nothing started: the tick starts the own interior, then the skirt waits", () => {
  const s = makeScene();
  tickPvsLoadExpansion(s, indoorHandle);
  assert.deepEqual(s.calls, [ACADEMY]);
  for (let i = 0; i < 5; i++) tickPvsLoadExpansion(s, indoorHandle);
  assert.deepEqual(s.calls, [ACADEMY]);
  // The build lands (cells.js moves it from in-flight to loaded) → skirt.
  s.envCellBuildInFlight.delete(ACADEMY);
  s.envCellLoadedLbs.add(ACADEMY);
  tickPvsLoadExpansion(s, indoorHandle);
  assert.equal(s.calls.length, 2);
  assert.equal(cheb(s.calls[1], ACADEMY), 1);
});

await t("S4 sealed dungeon: no skirt even once the own interior is loaded", () => {
  const s = makeScene({ loaded: [ACADEMY], sealed: ACADEMY });
  for (let i = 0; i < 5; i++) tickPvsLoadExpansion(s, indoorHandle);
  assert.deepEqual(s.calls, []);
});

await t("S5 ?envcellSkirtWait=off: the skirt starts beside the own build", async () => {
  globalThis.location = { search: "?envcellSkirtWait=off" };
  const off = await import("../scene3d/cells.js?skirtWait=off");
  globalThis.location = { search: "" };
  const s = makeScene({ inFlight: [ACADEMY] });
  off.tickPvsLoadExpansion(s, indoorHandle);
  assert.equal(s.calls.length, 1);
  assert.equal(cheb(s.calls[0], ACADEMY), 1);
});

console.log(`\n${groups} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
