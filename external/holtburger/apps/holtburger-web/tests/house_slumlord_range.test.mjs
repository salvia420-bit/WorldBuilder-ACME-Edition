// tests/house_slumlord_range.test.mjs — messages-objects-3 (2026-10-13).
//
// The house (slumlord) window closes as you walk away from the covenant
// crystal, like retail: gmSlumlordUI::RecvNotice_UpdateHouseProfile
// (acclient.c:250593) registers RegisterObjectRangeHandler(crystal, 9.0,
// useRadii=1, ignoreZDelta=0, 1.0 s) and OnObjectRangeExit (:249388) hides
// the window; ObjectsInRange (:436730) is 0 when the object is gone.
//   [verdict] plugins/slumlord_range.js — 9 m surface to surface
//             (Position::cylinder_distance), Z counts, overlap is in range,
//             centre-distance fallback when a body's size is unknown;
//   [panel]   plugins/house-panel.js on a fake DOM with a stubbed session
//             handle — a profile-opened window closes out of range / when
//             the crystal disappears after being seen; a new HouseProfile
//             for the same crystal (wasm `seq`) reopens it; a manual open
//             and `?slumlordRange=off` never range-close; the 1 s timer
//             runs the check by itself.
// Human Setup 0x02000001 dims: 0.6788225 / 1.835 (vendor_range_cylinder
// test). The crystal dims are made up (any non-zero pair works).
//
// Run from apps/holtburger-web/:  node tests/house_slumlord_range.test.mjs

import assert from "node:assert/strict";
import { installFakeDom } from "./helpers/fake_dom_items.mjs";
import {
  slumlordRangeVerdict,
  SLUMLORD_MAX_DISTANCE_M,
  SLUMLORD_NO_DIMS_SLACK_M,
  SLUMLORD_RANGE_POLL_MS,
} from "../plugins/slumlord_range.js";

globalThis.window = globalThis;
const { document } = installFakeDom(globalThis);

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err.stack?.split("\n").slice(0, 3).join(" | ") ?? err}`);
  }
}

const R = 0.6788225, H = 1.835; // human
const CR = 0.5, CH = 1.2; // covenant crystal (fixture)
const at = (x, y = 0, z = 0) => ({ x, y, z });
const dimsBoth = { crystalDims: [CR, CH], playerDims: [R, H] };

console.log("[verdict]");
await check("constants: MaxLordDistance 9 m, CHECK_LORD_INTERVAL 1 s", () => {
  assert.equal(SLUMLORD_MAX_DISTANCE_M, 9.0);
  assert.equal(SLUMLORD_RANGE_POLL_MS, 1000);
});

await check("flat ground: 8.9 m surface to surface is in range, 9.1 m is out", () => {
  const near = slumlordRangeVerdict(dimsBoth, at(0), at(8.9 + R + CR));
  assert.equal(near.mode, "cylinder");
  assert.equal(near.inRange, true);
  assert.ok(Math.abs(near.dist - 8.9) < 1e-9, `distance ${near.dist}`);
  const far = slumlordRangeVerdict(dimsBoth, at(0), at(9.1 + R + CR));
  assert.equal(far.inRange, false);
  assert.equal(far.range, 9.0);
});

await check("the radii count: 9.5 m centre to centre is still in range", () => {
  assert.equal(slumlordRangeVerdict(dimsBoth, at(0), at(9.5)).inRange, true);
});

await check("overlapping cylinders are in range (negative distance)", () => {
  const v = slumlordRangeVerdict(dimsBoth, at(0), at(0.3));
  assert.ok(v.dist < 0, `dist ${v.dist}`);
  assert.equal(v.inRange, true);
});

await check("Z counts (ignoreZDelta=0): 5 m across but 10 m up is out of range", () => {
  // player p1 at z=10 over a crystal at z=0: vgap = 10 - 1.2 = 8.8,
  // radial = hypot(5, 10) - (R + CR) ≈ 10.0 → hypot ≈ 13.3.
  const v = slumlordRangeVerdict(dimsBoth, at(0, 0, 0), at(5, 0, 10));
  assert.equal(v.inRange, false);
  assert.ok(v.dist > 13 && v.dist < 13.5, `dist ${v.dist}`);
  // Same spot on the ground is in range.
  assert.equal(slumlordRangeVerdict(dimsBoth, at(0), at(5)).inRange, true);
});

await check("a body of unknown size (stale pkg/, Setup not resident): centre distance + slack", () => {
  const range = SLUMLORD_MAX_DISTANCE_M + SLUMLORD_NO_DIMS_SLACK_M;
  for (const dims of [{ crystalDims: [], playerDims: [R, H] }, { crystalDims: [CR, CH], playerDims: null }, null]) {
    const inV = slumlordRangeVerdict(dims, at(0), at(range - 0.1));
    assert.equal(inV.mode, "fallback");
    assert.equal(inV.inRange, true);
    assert.equal(slumlordRangeVerdict(dims, at(0), at(range + 0.1)).inRange, false);
  }
});

console.log("[panel]");
const PLAYER = 0x50000001;
const CRYSTAL = 0x7A9B4001;
const LB = 0xA9B40019;
const CRYSTAL_XY = [100, 100, 0];
let profile = null;
let profileSeq = 0;
let crystalAt = [...CRYSTAL_XY]; // null = the crystal is gone
let playerAt = [105, 100, 0];
const partDims = { [CRYSTAL]: [CR, CH], [PLAYER]: [R, H] };
const handle = {
  playerHouseStatus: () => undefined,
  playerHouseData: () => undefined,
  playerHouseProfile: () => (profile ? { ...profile, free() {} } : undefined),
  playerHouseRestrictions: () => undefined,
  playerInventory: () => [],
  objectName: (g) => ((g >>> 0) === CRYSTAL ? "Covenant Crystal" : undefined),
  objectIntProperty: () => undefined,
  objectPosition: (g) => ((g >>> 0) === CRYSTAL && crystalAt
    ? Float64Array.of(LB, ...crystalAt)
    : new Float64Array(0)),
  getLocalPlayerPose: () => ({ landblockId: LB, x: playerAt[0], y: playerAt[1], z: playerAt[2], free() {} }),
  objectPartDims: (g) => Float32Array.from(partDims[g >>> 0] ?? []),
  houseQuery() {},
};
Object.assign(globalThis, {
  __sessionHandle: handle,
  getLocalPlayerGuid: () => PLAYER,
});

const { watchProfile, slumlordRangeTick, slumlordRangeEnabled } = await import("../plugins/house-panel.js");

const isOpen = () => document.getElementById("hb-house-panel")?.dataset.open === "1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The player stands `d` m (surface to surface) east of the crystal. */
function standAt(d) {
  playerAt = [CRYSTAL_XY[0] + d + R + CR, CRYSTAL_XY[1], 0];
}
/** ACE answers a crystal Use with a HouseProfile (a fresh receipt). */
function useCrystal(extra = {}) {
  profile = {
    crystalGuid: CRYSTAL, dwellingId: 77, ownerId: 0, ownerName: "", houseType: 1,
    maintenanceFree: false, bitmask: 0, seq: ++profileSeq, ...extra,
  };
  watchProfile();
}

watchProfile(); // the watcher's first look records the (empty) baseline

await check("a profile-opened Buy window stays open within 9 m", () => {
  standAt(5);
  useCrystal();
  assert.equal(isOpen(), true, "the HouseProfile opened the window");
  assert.equal(slumlordRangeTick(), "ok");
  standAt(8.9);
  assert.equal(slumlordRangeTick(), "ok");
  assert.equal(isOpen(), true);
});

await check("walking past 9 m closes it, and the registration ends", () => {
  standAt(9.1);
  assert.equal(slumlordRangeTick(), "close");
  assert.equal(isOpen(), false);
  assert.equal(slumlordRangeTick(), "off", "nothing registered after the close");
});

await check("using the same crystal again (a new HouseProfile) reopens and re-registers", () => {
  standAt(3);
  useCrystal();
  assert.equal(isOpen(), true);
  assert.equal(slumlordRangeTick(), "ok");
});

await check("the crystal disappearing after it was seen closes the window", () => {
  assert.equal(slumlordRangeTick(), "ok"); // seen
  crystalAt = null;
  assert.equal(slumlordRangeTick(), "close");
  assert.equal(isOpen(), false);
  crystalAt = [...CRYSTAL_XY];
});

await check("a crystal never seen (no position yet) does not close it", () => {
  crystalAt = null;
  standAt(3);
  useCrystal();
  assert.equal(slumlordRangeTick(), "unknown");
  assert.equal(slumlordRangeTick(), "unknown");
  assert.equal(isOpen(), true);
  crystalAt = [...CRYSTAL_XY];
  assert.equal(slumlordRangeTick(), "ok");
});

await check("a manually opened window never closes on distance", () => {
  window.__closeHousePanel();
  window.__openHousePanel("buy");
  standAt(50);
  assert.equal(slumlordRangeTick(), "off");
  assert.equal(isOpen(), true);
  // Closing a profile-opened window by hand drops the registration too.
  standAt(3);
  useCrystal();
  window.__closeHousePanel();
  window.__openHousePanel("buy");
  standAt(50);
  assert.equal(slumlordRangeTick(), "off");
  assert.equal(isOpen(), true);
  window.__closeHousePanel();
});

await check("?slumlordRange=off: a profile-opened window never range-closes", () => {
  const saved = globalThis.location.search;
  try {
    globalThis.location.search = "?slumlordRange=off";
    assert.equal(slumlordRangeEnabled(), false);
    standAt(3);
    useCrystal();
    assert.equal(isOpen(), true);
    standAt(50);
    assert.equal(slumlordRangeTick(), "off");
    assert.equal(isOpen(), true);
  } finally {
    globalThis.location.search = saved;
    window.__closeHousePanel();
  }
  assert.equal(slumlordRangeEnabled(), true, "default on");
});

await check("no objectPartDims (stale pkg/): centre distance with the slack", () => {
  const savedDims = handle.objectPartDims;
  try {
    delete handle.objectPartDims;
    const edge = SLUMLORD_MAX_DISTANCE_M + SLUMLORD_NO_DIMS_SLACK_M;
    playerAt = [CRYSTAL_XY[0] + edge - 0.1, CRYSTAL_XY[1], 0];
    useCrystal();
    assert.equal(slumlordRangeTick(), "ok");
    playerAt = [CRYSTAL_XY[0] + edge + 0.1, CRYSTAL_XY[1], 0];
    assert.equal(slumlordRangeTick(), "close");
    assert.equal(isOpen(), false);
  } finally {
    handle.objectPartDims = savedDims;
  }
});

await check("stale pkg/ profile (no seq): keyed on dwelling:crystal:owner as before", () => {
  standAt(3);
  const { seq: _s, ...noSeq } = { ...profile, dwellingId: 90 };
  profile = noSeq;
  watchProfile();
  assert.equal(isOpen(), true, "a changed profile still opens");
  window.__closeHousePanel();
  profile = { ...noSeq };
  watchProfile();
  assert.equal(isOpen(), false, "an identical seq-less profile does not");
});

await check("the 1 s timer runs the check by itself (CHECK_LORD_INTERVAL)", async () => {
  standAt(3);
  useCrystal();
  assert.equal(isOpen(), true);
  standAt(20);
  await sleep(SLUMLORD_RANGE_POLL_MS + 200);
  assert.equal(isOpen(), false, "closed without a manual tick");
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
for (const k of ["__hbHouseProfileWatch"]) { try { clearInterval(globalThis[k]); } catch (_) {} }
window.__closeHousePanel?.();
process.exit(failed === 0 ? 0 : 1);
