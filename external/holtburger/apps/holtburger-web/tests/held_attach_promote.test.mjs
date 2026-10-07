// tests/held_attach_promote.test.mjs — bug 14 (2026-10-07): a freshly
// wielded weapon/shield took 3-4 s to appear. Its (synthesized) spawn waited
// in the time-sliced spawn queue and then built at the wielder's pose, which
// sent it through the distance-LOD lookup on the low-priority fetch lane.
// Now the ATTACH promotes the queued spawn at once and makes it poseless
// (landblock 0, origin) like ACE's own parented CreateObject.
//
// Run from apps/holtburger-web/:  node tests/held_attach_promote.test.mjs

import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join as joinPath } from "node:path";
import { readFileSync } from "node:fs";

const APP = joinPath(dirname(fileURLToPath(import.meta.url)), "..");
const raw = readFileSync(joinPath(APP, "scene3d", "loop.js"), "utf8");
const stripped = raw.replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*$/gm, "");
const stubs = `
const tickCellVisibility3D = () => {}; const tickPvsLoadExpansion = () => {};
const noteEntityLandcell = () => {}; const tickLightingForCellState = () => {};
const getTerrainVisualZ = (sc, x, y, z) => z; const cullTerrainGroup = () => {};
const BUILDINGS_SHADOW_RANGE_SQ_M = 0; const STATICS_SHADOW_RANGE_SQ_M = 0;
const cullStaticsGroup = () => {}; const tickFrustumCull = () => {}; const setCullers = () => {};
const tickEntityRenderVisibility = () => {}; const tickPortalSpace = () => {};
const cloneEntityUpdate = (u) => ({ ...u }); const weatherForState = () => null;
const wxUpdateFromDayGroup = () => {}; const createClientEventDispatcher = () => () => false;
const VFX_GLOBALS = { uTime: { value: 0 } }; const setMasterClock = () => {};
const shouldDeferDeathRemove = () => false; const deathHoldVerdict = () => "remove"; const DEATH_CLAIM_POLL_MS = 150;
const KIND = Object.freeze({ POSITION: 0, SPAWN: 1, REMOVE: 2, META_REFRESH: 3, VELOCITY: 4,
  MOTION: 5, APPEARANCE: 6, ATTACH: 7, MOTION_ACTION: 8, TURN: 9 });
const createEntityDispatcher = ({ neutral = {}, backend = {} } = {}) => ({
  dispatch(upd) { if (!upd) return false; const k = upd.kind | 0;
    try { neutral[k]?.(upd); } catch (_) {} const h = backend[k];
    if (h) { try { h(upd); } catch (_) {} return true; } return false; } });
`;
const THREE_URL = pathToFileURL(joinPath(APP, "node_modules", "three", "build", "three.module.js")).href;
const src = `import * as THREE from ${JSON.stringify(THREE_URL)};\n${stubs}${stripped}\n`;
globalThis.window = { location: { search: "" } };
globalThis.location = { search: "" }; // time-sliced spawns (the default)
const mod = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));

let passed = 0, failed = 0;
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.message}`); }
};

const calls = [];
const em = {
  entityMap: new Map(),
  spawn: (m) => calls.push(["spawn", { ...m }]),
  remove: () => {},
  attachChildToParent: (...a) => calls.push(["attach", ...a]),
  _markWielderDirty: () => {},
};
const scene3d = { entityManager: em };
const CHILD = 0x80001234, WIELDER = 0x50000001;

mod.dispatchEntityUpdate(scene3d, em, {
  kind: 1, guid: CHILD, modelId: 0x02000162, landblockId: 0xa9b40021,
  x: 101.5, y: 22.25, z: 60.0, qw: 0.7, qx: 0, qy: 0, qz: 0.7,
  itemType: 0x1, name: "Round Shield", wcid: 92,
});
check("the held item's spawn is queued (time-sliced) before its attach", () => {
  assert.equal(calls.filter((c) => c[0] === "spawn").length, 0);
});
mod.dispatchEntityUpdate(scene3d, em, { kind: 7, guid: CHILD, modelId: WIELDER, motionCommand: 2, motionStance: 0 });
check("the attach builds the queued spawn immediately", () => {
  const sp = calls.filter((c) => c[0] === "spawn");
  assert.equal(sp.length, 1);
  assert.equal(calls.findIndex((c) => c[0] === "spawn") < calls.findIndex((c) => c[0] === "attach"), true);
});
check("the promoted spawn is poseless (landblock 0, origin) — no distance-LOD walk", () => {
  const m = calls.find((c) => c[0] === "spawn")[1];
  assert.equal(m.landblockId >>> 0, 0);
  assert.deepEqual([m.x, m.y, m.z], [0, 0, 0]);
  assert.equal(m.heldChild, true);
});
check("the attach still reaches the EntityManager", () => {
  const a = calls.find((c) => c[0] === "attach");
  assert.deepEqual(a.slice(1), [CHILD, WIELDER, 2, 0]);
});
check("an unwield (parent 0) does not touch the spawn queue", () => {
  const before = calls.length;
  mod.dispatchEntityUpdate(scene3d, em, { kind: 7, guid: CHILD, modelId: 0, motionCommand: 0, motionStance: 0 });
  assert.equal(calls.slice(before).filter((c) => c[0] === "spawn").length, 0);
});

console.log(`\nheld_attach_promote: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
