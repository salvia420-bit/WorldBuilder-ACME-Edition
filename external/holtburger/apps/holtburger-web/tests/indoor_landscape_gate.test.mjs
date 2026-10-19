// tests/indoor_landscape_gate.test.mjs — cells-portals-2 (2026-10-13):
// `?indoorLandscapeGate` (DEFAULT ON since 2026-10-19; `=off`/`0`/`false`/`no`
// is the escape). Indoors, the armed split skips the landscape (world pass
// content, depth wipe, sky) on frames where the portal walk reaches no outside
// portal.
//
// Retail PView::DrawCells (acclient.c:461450) runs LScape::draw (sky + terrain
// blocks + weather) and the Clear(4) Z-wipe only under
// `if (this->outside_view.view_count)` (:461476).
//
//   L1  flag reader: absent / `=on` / any other value ⇒ ON; off/0/false/no
//       (trimmed, any case) ⇒ OFF; the bare page reads ON.
//   L2  indoorLandscapeSkip: false for flag off, unknown count, count > 0,
//       fewer than 2 zero frames, non-resident cells, a BFS outdoor portal
//       (or unknown), a camera within 1 m of an outdoor portal (or unknown);
//       true otherwise.
//   L3  indoorLandscapeCellState / hasOutdoorPortal: residency of the drawn
//       EnvCells, BFS-only doorway (frustum-refined), sentinels ignored.
//   L4  minDistToApertures parses the aperture wire shape.
//   L5  widenClipXY / boxQueryMvp matrix helpers.
//   L6  cells.js end to end (tickCellVisibility3D + tickPortalSeal): settles
//       for 2 ticks, then skips; every fail-open clause; the flag off never
//       reaches the pipeline (one `false` after a runtime toggle); the URL
//       default end to end (bare page skips, every `=off` spelling does not);
//       a throw in the gate's cell state fails the gate open and leaves the
//       split armed.
//   L7  REAL pipeline (vendored takram via a resolve hook, recording
//       renderer): the skip frame keeps the world RenderPass (colour + depth
//       clear) with an empty layer mask, no depth wipe, no sky pass; the
//       cells pass still draws layer 1. Off / outdoor frames are unchanged.
//   L8  source pins: the skip path sets the layer mask, never disables the
//       world RenderPass.
//
// Run: node tests/indoor_landscape_gate.test.mjs

import { register } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const v = (p) => pathToFileURL(path.join(APP, p)).href;

// index.html's import map, mirrored for node (atmosphere_pipeline.js, L7).
const MAP = {
  "@takram/three-clouds": v("vendor/takram-three-clouds/build/index.js"),
  "@takram/three-atmosphere": v("vendor/takram/three-atmosphere.js"),
  "@takram/three-atmosphere/shaders/bruneton": v("vendor/takram/three-atmosphere-shaders-bruneton.js"),
  "@takram/three-geospatial": v("vendor/takram/three-geospatial.js"),
  "@takram/three-geospatial/shaders": v("vendor/takram/three-geospatial-shaders.js"),
  "@takram/three-geospatial-effects": v("vendor/takram/three-geospatial-effects.js"),
};
register(
  "data:text/javascript," +
    encodeURIComponent(
      `const M = ${JSON.stringify(MAP)};
      export async function resolve(spec, ctx, next) {
        if (M[spec]) return { url: M[spec], shortCircuit: true };
        return next(spec, ctx);
      }`,
    ),
);

globalThis.location = { search: "" };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.window = globalThis;

const THREE = await import("three");
const gate = await import("../scene3d/indoor_landscape_gate.js");
const {
  readIndoorLandscapeGateFlag,
  indoorLandscapeGateEnabled,
  setIndoorLandscapeGateFlag,
  indoorLandscapeSkip,
  indoorLandscapeCellState,
  hasOutdoorPortal,
  isDrawnEnvCellId,
  minDistToApertures,
  widenClipXY,
  boxQueryMvp,
  INDOOR_LANDSCAPE_GATE_STATS,
  INDOOR_LANDSCAPE_MIN_ZERO_FRAMES,
  INDOOR_LANDSCAPE_NEAR_PORTAL_M,
} = gate;
const { tickCellVisibility3D, tickPortalSeal } = await import("../scene3d/cells.js");

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

const LB = 0x01d90000;
const A = (LB | 0x0100) >>> 0; // viewer room
const B = (LB | 0x0101) >>> 0; // walk-reached neighbour
const C = (LB | 0x0102) >>> 0; // BFS-only neighbour with a doorway
const D = (LB | 0x0103) >>> 0; // BFS-only neighbour, interior portals only
const SENTINEL = (LB | 0xffff) >>> 0;
const LANDCELL = (LB | 0x0021) >>> 0;

console.log("indoor landscape gate — cells-portals-2");

// --- L1 ---------------------------------------------------------------------
await t("L1 flag reader is default-on with an off/0/false/no escape", () => {
  assert.equal(readIndoorLandscapeGateFlag(""), true);
  assert.equal(readIndoorLandscapeGateFlag("?x=1"), true, "other params only");
  assert.equal(readIndoorLandscapeGateFlag("?indoorLandscapeGate=on"), true);
  assert.equal(readIndoorLandscapeGateFlag("?x=1&indoorLandscapeGate=on"), true);
  for (const s of ["on", "ON", "1", "true", "yes", "", "garbage"]) {
    assert.equal(readIndoorLandscapeGateFlag(`?indoorLandscapeGate=${s}`), true, s);
  }
  for (const s of ["off", "OFF", "Off", "0", "false", "FALSE", "no", "%20off%20"]) {
    assert.equal(readIndoorLandscapeGateFlag(`?indoorLandscapeGate=${s}`), false, s);
  }
  assert.equal(readIndoorLandscapeGateFlag("?x=1&indoorLandscapeGate=off"), false);
  // Default (no URL param) is ON; the seam forces it either way.
  setIndoorLandscapeGateFlag(null);
  assert.equal(indoorLandscapeGateEnabled(), true);
  setIndoorLandscapeGateFlag(false);
  assert.equal(indoorLandscapeGateEnabled(), false);
  setIndoorLandscapeGateFlag(null);
  assert.equal(indoorLandscapeGateEnabled(), true);
  setIndoorLandscapeGateFlag(null);
});

// --- L2 ---------------------------------------------------------------------
await t("L2 indoorLandscapeSkip: every clause fails open", () => {
  assert.equal(INDOOR_LANDSCAPE_MIN_ZERO_FRAMES, 2);
  assert.equal(INDOOR_LANDSCAPE_NEAR_PORTAL_M, 1);
  const base = {
    flag: true,
    count: 0,
    zeroFrames: 2,
    allResident: true,
    bfsOutdoor: false,
    nearOutdoorPlaneM: 5,
  };
  assert.equal(indoorLandscapeSkip(base), true, "all clauses pass");
  assert.equal(indoorLandscapeSkip({ ...base, zeroFrames: 9 }), true);
  assert.equal(indoorLandscapeSkip({ ...base, nearOutdoorPlaneM: Infinity }), true, "no portal near");
  const no = (patch, why) => assert.equal(indoorLandscapeSkip({ ...base, ...patch }), false, why);
  no({ flag: false }, "flag off");
  no({ flag: undefined }, "flag unknown");
  no({ count: null }, "unknown count");
  no({ count: undefined }, "unknown count (undefined)");
  no({ count: NaN }, "NaN count");
  no({ count: 1 }, "an outside portal");
  no({ count: 3 }, "outside portals");
  no({ zeroFrames: 0 }, "zero frames 0");
  no({ zeroFrames: 1 }, "fewer than 2 zero frames");
  no({ allResident: false }, "a drawn cell not resident");
  no({ allResident: null }, "residency unknown");
  no({ bfsOutdoor: true }, "a BFS-only doorway");
  no({ bfsOutdoor: null }, "BFS state unknown");
  no({ nearOutdoorPlaneM: 0.2 }, "camera in the doorway");
  no({ nearOutdoorPlaneM: 0.99 }, "under 1 m");
  no({ nearOutdoorPlaneM: 1.0 }, "exactly 1 m is not MORE than 1 m");
  no({ nearOutdoorPlaneM: null }, "near distance unknown");
  no({ nearOutdoorPlaneM: NaN }, "near distance NaN");
  assert.equal(indoorLandscapeSkip(null), false);
  assert.equal(indoorLandscapeSkip(undefined), false);
});

// --- L3 ---------------------------------------------------------------------
function cellRegistry(spec) {
  const parent = new THREE.Group();
  const reg = new Map();
  for (const [id, portals, attached = true] of spec) {
    const c = new THREE.Group();
    c.userData = { cellId: id, isEnvCell: true, portalCellIds: portals };
    if (attached) parent.add(c);
    reg.set(id, c);
  }
  return reg;
}

await t("L3 hasOutdoorPortal / isDrawnEnvCellId", () => {
  assert.equal(hasOutdoorPortal([B, C]), false);
  assert.equal(hasOutdoorPortal([B, SENTINEL]), true, "leads-outdoors resolves to |0xFFFF");
  assert.equal(hasOutdoorPortal(Uint32Array.from([(LB | 0xfffe) >>> 0])), true, ">= 0xFFFE sentinel");
  assert.equal(hasOutdoorPortal([]), false);
  assert.equal(hasOutdoorPortal(null), null, "no list = unknown");
  assert.equal(isDrawnEnvCellId(A), true);
  assert.equal(isDrawnEnvCellId(SENTINEL), false);
  assert.equal(isDrawnEnvCellId(LANDCELL), false);
});

await t("L3 indoorLandscapeCellState: residency + BFS-only doorway", () => {
  const reg = cellRegistry([
    [A, [B, C]],
    [B, [A]],
    [C, [A, SENTINEL]],
    [D, [A]],
  ]);
  // Drawn = BFS ∪ walk ∪ anchor, with the sentinel and a landcell mixed in
  // (the depth-1 BFS follows the outdoor edge): both are ignored.
  const drawn = [A, B, C, D, SENTINEL, LANDCELL];
  let s = indoorLandscapeCellState(reg, drawn, [A, B, C, D, SENTINEL], [A, B], [A, B, C, D], A);
  assert.equal(s.allResident, true);
  assert.equal(s.drawnCells, 4);
  assert.equal(s.bfsOutdoor, true, "C is drawn, in view, unreached, and has a doorway");
  // C's bounds outside the view frustum: its doorway cannot be on screen.
  s = indoorLandscapeCellState(reg, drawn, [A, B, C, D], [A, B], [A, B, D], A);
  assert.equal(s.bfsOutdoor, false);
  // No frustum set → every BFS-only cell is tested.
  s = indoorLandscapeCellState(reg, drawn, [A, B, C, D], [A, B], null, A);
  assert.equal(s.bfsOutdoor, true);
  // C reached by the walk → the walk vouches for its doorway.
  s = indoorLandscapeCellState(reg, drawn, [A, B, C, D], [A, B, C], [A, B, C, D], A);
  assert.equal(s.bfsOutdoor, false);
  // Only D BFS-only (interior portals) → false.
  s = indoorLandscapeCellState(reg, [A, B, D], [A, B, D], [B], null, A);
  assert.equal(s.bfsOutdoor, false, "the anchor counts as walk-reached");
  // Walk unknown → unknown.
  s = indoorLandscapeCellState(reg, drawn, [A, B, C, D], null, null, A);
  assert.equal(s.bfsOutdoor, null);
  // A BFS-only cell with no container / no portal list → unknown → true.
  const reg2 = cellRegistry([[A, [B]], [B, [A]], [D, undefined]]);
  s = indoorLandscapeCellState(reg2, [A, B], [A, B, C], [A, B], null, A);
  assert.equal(s.bfsOutdoor, true, "unregistered BFS-only cell");
  assert.equal(s.allResident, true, "C is not in the drawn list here");
  s = indoorLandscapeCellState(reg2, [A, B, D], [A, B, D], [A, B], null, A);
  assert.equal(s.bfsOutdoor, true, "BFS-only cell without a portal list");
});

await t("L3 residency fails open", () => {
  const reg = cellRegistry([[A, [B]], [B, [A], false]]);
  let s = indoorLandscapeCellState(reg, [A, B], [A, B], [A, B], null, A);
  assert.equal(s.allResident, false, "a detached (parked) drawn cell");
  s = indoorLandscapeCellState(reg, [A, C], [A], [A], null, A);
  assert.equal(s.allResident, false, "an unregistered drawn cell");
  s = indoorLandscapeCellState(reg, [SENTINEL, LANDCELL], [], [], null, A);
  assert.equal(s.allResident, false, "no EnvCell to draw at all");
  assert.equal(indoorLandscapeCellState(null, [A], [A], [A], null, A).allResident, false);
  assert.equal(indoorLandscapeCellState(reg, null, [A], [A], null, A).allResident, false);
});

// --- L4 ---------------------------------------------------------------------
// A 2 m-wide, 2 m-tall doorway in the AC plane y = `y`, x in [x0, x1].
function quadAt(y, x0, x1) {
  return [4, x0, y, 0, x1, y, 0, x1, y, 2, x0, y, 2];
}

await t("L4 minDistToApertures", () => {
  assert.equal(minDistToApertures(Float32Array.from([0]), 0, 0, 1), Infinity, "no aperture");
  const one = Float32Array.from([1, ...quadAt(5, -1, 1)]);
  assert.ok(Math.abs(minDistToApertures(one, 0, 0, 1) - 5) < 1e-6);
  assert.equal(minDistToApertures(one, 0, 5, 1), 0, "standing in the doorway");
  // Off to the side: distance to the nearest edge of the box (3-4-5).
  assert.ok(Math.abs(minDistToApertures(one, 4, 1, 1) - 5) < 1e-6);
  const two = Float32Array.from([2, ...quadAt(5, -1, 1), ...quadAt(-0.5, -1, 1)]);
  assert.ok(Math.abs(minDistToApertures(two, 0, 0, 1) - 0.5) < 1e-6, "nearest of two");
  assert.equal(minDistToApertures(Float32Array.from([2, ...quadAt(5, -1, 1)]), 0, 0, 1), null, "truncated");
  assert.equal(minDistToApertures(Float32Array.from([]), 0, 0, 0), null, "empty");
  assert.equal(minDistToApertures(null, 0, 0, 0), null);
});

// --- L5 ---------------------------------------------------------------------
function project(m, x, y, z) {
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
  const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
  const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [cx / cw, cy / cw, cz / cw];
}

await t("L5 widenClipXY widens the view, keeps depth", () => {
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  cam.position.set(0, 0, 0);
  cam.lookAt(0, 0, -1);
  cam.updateMatrixWorld(true);
  const m = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements;
  const src = Float32Array.from(m);
  const out = new Float32Array(16);
  widenClipXY(src, 0.75, out);
  // A point just off the right edge of the real view lands inside the wide one.
  const halfW = Math.tan((60 * Math.PI) / 360) * (16 / 9) * 10;
  const p = [halfW * 1.2, 0, -10];
  assert.ok(project(src, ...p)[0] > 1, "outside the real view");
  const pw = project(out, ...p);
  assert.ok(pw[0] < 1 && pw[0] > 0.85, `inside the wide view (${pw[0]})`);
  // Depth/w rows untouched → the same near plane.
  for (const i of [2, 3, 6, 7, 10, 11, 14, 15]) assert.equal(out[i], src[i], `elem ${i}`);
  assert.equal(src[0], Float32Array.from(m)[0], "source not mutated");
});

await t("L5 boxQueryMvp is the cube of half-size h around the point", () => {
  const out = new Float32Array(16);
  boxQueryMvp(25000, 31000, 60, 1.5, out);
  // f32 at ~3e4 m: NDC error ~1e-3 here = ~2 mm of world, the same f32 math
  // the wasm frustum does.
  const c = project(out, 25000, 31000, 60);
  for (const v of c) assert.ok(Math.abs(v) < 5e-3, `centre ${c}`);
  const k = project(out, 25001.5, 30998.5, 61.5);
  assert.ok(Math.abs(k[0] - 1) < 1e-2 && Math.abs(k[1] + 1) < 1e-2 && Math.abs(k[2] - 1) < 1e-2, `corner ${k}`);
  const o = project(out, 25003, 31000, 60);
  assert.ok(o[0] > 1, "a point 3 m away is outside the box");
});

// --- L6: cells.js end to end ------------------------------------------------
function makeScene3d(reg) {
  const worldRoot = new THREE.Group();
  worldRoot.rotation.x = -Math.PI / 2; // AC Z-up → three Y-up (adapter.js)
  worldRoot.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  camera.position.set(0, 1, 0); // = AC (0, 0, 1)
  camera.lookAt(0, 1, -10); // = AC +y
  camera.updateMatrixWorld(true);
  const pushed = [];
  const seal = { setApertures() {}, outdoorRemainder: null, remainderRect: null };
  return {
    pushed,
    camera,
    worldRoot,
    cellContainers3d: reg,
    terrainGroup: { visible: true },
    buildingsGroup: { visible: true, children: [] },
    staticsGroup: { visible: true, children: [] },
    atmospherePipeline: {
      portalSealPass: seal,
      setIndoorSplitArmed() {},
      setIndoorLandscapeSkip(v) { pushed.push(v); },
    },
  };
}

function makeSession(state) {
  return {
    getCurrentCellId: () => state.player,
    isCurrentCellIndoor: () => state.indoor,
    isCurrentCellSeenOutside: () => true,
    isCellSeenOutside: () => true,
    getRenderSet: () => [state.player],
    getViewerRenderSet: () => state.bfs,
    getRenderSetWithFrustum: () => state.frustum,
    getRenderSetWithPView: () => state.walk,
    getLocalPlayerPose: () => ({ landblockId: state.player, x: 0, y: -3, z: 0, free() {} }),
    terrainHeightAt: () => 50,
    resolveViewerCell: () => state.player,
    setViewerCell() {},
    getPViewOutsidePortals: (mvp) => {
      // First call per tick = the seal's real walk, second = the wide walk.
      state.walkCalls++;
      return Float32Array.from(state.walkCalls === 1 ? state.raw : state.wide);
    },
    getVisiblePortalApertures: () => Float32Array.from(state.near),
  };
}

function tick(s3, sh, state) {
  state.walkCalls = 0;
  tickCellVisibility3D(s3, sh);
  tickPortalSeal(s3, sh);
  return INDOOR_LANDSCAPE_GATE_STATS;
}

await t("L6 cells.js: settles, skips, and fails open on every clause", () => {
  setIndoorLandscapeGateFlag(true);
  try {
    const reg = cellRegistry([[A, [B]], [B, [A, C]], [C, [B, SENTINEL]]]);
    const s3 = makeScene3d(reg);
    const state = {
      player: A,
      indoor: true,
      bfs: [A, B],
      frustum: [A, B],
      walk: [A, B],
      raw: [0],
      wide: [0],
      near: [1, ...quadAt(6, -1, 1)], // a doorway 6 m ahead
      walkCalls: 0,
    };
    const sh = makeSession(state);
    let st = tick(s3, sh, state);
    assert.equal(s3._indoorSplitArmed, true, "fixture: the split arms");
    assert.equal(st.count, 0);
    assert.equal(st.zeroFrames, 1);
    assert.equal(st.skip, false);
    assert.equal(st.reason, "settling");
    assert.equal(s3.pushed.at(-1), false);
    st = tick(s3, sh, state);
    assert.equal(st.zeroFrames, 2);
    assert.equal(st.allResident, true);
    assert.equal(st.bfsOutdoor, false);
    assert.ok(Math.abs(st.nearOutdoorPlaneM - 6) < 1e-3, `near=${st.nearOutdoorPlaneM}`);
    assert.equal(st.skip, true, st.reason);
    assert.equal(st.reason, "skip");
    assert.equal(s3.pushed.at(-1), true, "the pipeline is told to skip");
    assert.equal(s3._indoorLandscapeGate, INDOOR_LANDSCAPE_GATE_STATS);

    // A doorway in view: immediately draw, and the settle restarts.
    state.raw = [1, ...quadAt(5, -1, 1)];
    st = tick(s3, sh, state);
    assert.equal(st.skip, false);
    assert.equal(st.reason, "outside-view");
    assert.equal(st.zeroFrames, 0);
    assert.equal(st.wideCount, null, "no wide walk when the raw walk already sees out");
    state.raw = [0];
    tick(s3, sh, state);
    st = tick(s3, sh, state);
    assert.equal(st.skip, true, "settled again");

    // Raw 0 but the wider walk sees a doorway turning into view.
    state.wide = [1, ...quadAt(5, 8, 9)];
    st = tick(s3, sh, state);
    assert.equal(st.skip, false);
    assert.equal(st.reason, "outside-view-wide");
    assert.equal(state.walkCalls, 2, "the wide walk ran");
    state.wide = [0];
    tick(s3, sh, state);
    assert.equal(tick(s3, sh, state).skip, true);

    // The camera within 1 m of a doorway (one that projects to nothing).
    state.near = [1, ...quadAt(0.5, -1, 1)];
    st = tick(s3, sh, state);
    assert.equal(st.skip, false);
    assert.equal(st.reason, "near-portal");
    state.near = []; // unreadable
    st = tick(s3, sh, state);
    assert.equal(st.skip, false);
    assert.equal(st.reason, "near-unknown");
    state.near = [0]; // no outdoor portal near
    st = tick(s3, sh, state);
    assert.equal(st.skip, true);
    assert.equal(st.nearOutdoorPlaneM, Infinity);

    // A drawn cell not resident.
    reg.get(B).parent.remove(reg.get(B));
    st = tick(s3, sh, state);
    assert.equal(st.skip, false);
    assert.equal(st.reason, "not-resident");
    s3.cellContainers3d = cellRegistry([[A, [B]], [B, [A, C]], [C, [B, SENTINEL]]]);
    assert.equal(tick(s3, sh, state).skip, true);

    // A BFS-only neighbour with a doorway, in view.
    state.bfs = [A, B, C];
    state.frustum = [A, B, C];
    st = tick(s3, sh, state);
    assert.equal(st.skip, false);
    assert.equal(st.reason, "bfs-doorway");
    // …out of view: its doorway cannot be on screen.
    state.frustum = [A, B];
    assert.equal(tick(s3, sh, state).skip, true);
    state.bfs = [A, B];

    // Stale pkg (no outside-view export): unknown → draw.
    const stale = { ...sh };
    delete stale.getPViewOutsidePortals;
    st = tick(s3, stale, state);
    assert.equal(st.skip, false);
    assert.equal(st.reason, "count-unknown");
    assert.equal(st.zeroFrames, 0);

    // Viewer outdoors → the split disarms → never skip.
    tick(s3, sh, state);
    tick(s3, sh, state);
    state.player = LANDCELL;
    state.indoor = false;
    st = tick(s3, sh, state);
    assert.equal(s3._indoorSplitArmed, false);
    assert.equal(st.skip, false);
    assert.equal(st.reason, "not-armed");
    assert.equal(s3.pushed.at(-1), false);
  } finally {
    setIndoorLandscapeGateFlag(null);
  }
});

await t("L6 flag off: the pipeline is never told anything (one false after a toggle)", () => {
  setIndoorLandscapeGateFlag(false);
  const reg = cellRegistry([[A, [B]], [B, [A]]]);
  const s3 = makeScene3d(reg);
  const state = {
    player: A, indoor: true, bfs: [A, B], frustum: [A, B], walk: [A, B],
    raw: [0], wide: [0], near: [0], walkCalls: 0,
  };
  const sh = makeSession(state);
  for (let i = 0; i < 4; i++) tick(s3, sh, state);
  assert.deepEqual(s3.pushed, [], "flag off: no call at all");
  assert.equal("_indoorLandscapeGate" in s3, false);
  assert.equal(state.walkCalls, 1, "flag off: only the seal's own walk");
  // Runtime A/B: on (skip set) → off → exactly one `false`, then silence.
  setIndoorLandscapeGateFlag(true);
  for (let i = 0; i < 3; i++) tick(s3, sh, state);
  assert.equal(s3.pushed.at(-1), true);
  setIndoorLandscapeGateFlag(false);
  const n = s3.pushed.length;
  tick(s3, sh, state);
  tick(s3, sh, state);
  assert.deepEqual(s3.pushed.slice(n), [false]);
  setIndoorLandscapeGateFlag(null);
});

await t("L6 URL default end to end: a bare page skips, every =off spelling never does", () => {
  const prev = globalThis.location.search;
  const fresh = () => ({
    player: A, indoor: true, bfs: [A, B], frustum: [A, B], walk: [A, B],
    raw: [0], wide: [0], near: [0], walkCalls: 0,
  });
  try {
    // Bare page: the cached reader resolves ON through cells.js itself.
    globalThis.location.search = "";
    setIndoorLandscapeGateFlag(null);
    let s3 = makeScene3d(cellRegistry([[A, [B]], [B, [A]]]));
    let state = fresh();
    const sh = makeSession(state);
    tick(s3, sh, state);
    const st = tick(s3, sh, state);
    assert.equal(indoorLandscapeGateEnabled(), true, "bare page reads ON");
    assert.equal(st.skip, true, st.reason);
    assert.equal(s3.pushed.at(-1), true, "the pipeline is told to skip");
    assert.equal(s3._indoorLandscapeGate, INDOOR_LANDSCAPE_GATE_STATS);
    assert.equal(typeof globalThis.__indoorLandscapeGateDiag, "function");
    assert.equal(globalThis.__indoorLandscapeGateDiag().on, true);
    // The escape: the gate never runs, so the pipeline never hears `true`.
    for (const v of ["off", "0", "false", "no", "OFF"]) {
      globalThis.location.search = `?indoorLandscapeGate=${v}`;
      setIndoorLandscapeGateFlag(null);
      s3 = makeScene3d(cellRegistry([[A, [B]], [B, [A]]]));
      state = fresh();
      const shOff = makeSession(state);
      for (let i = 0; i < 3; i++) tick(s3, shOff, state);
      assert.equal(indoorLandscapeGateEnabled(), false, v);
      assert.equal(s3.pushed.includes(true), false, `${v}: ${JSON.stringify(s3.pushed)}`);
      assert.equal("_indoorLandscapeGate" in s3, false, v);
      assert.equal(state.walkCalls, 1, `${v}: only the seal's own walk`);
    }
    // Live A/B from the =off arm: the handle turns the gate back on.
    assert.equal(globalThis.__setIndoorLandscapeGate(true).on, true);
    state = fresh();
    const shOn = makeSession(state);
    tick(s3, shOn, state);
    assert.equal(tick(s3, shOn, state).skip, true);
  } finally {
    globalThis.location.search = prev;
    setIndoorLandscapeGateFlag(null);
  }
});

await t("L6 a throw in the gate's cell state fails the gate open, never the split", () => {
  // Default-on raises the stakes: the cell-state build runs inside the split's
  // try in tickCellVisibility3D, whose catch disarms ?indoorDepthSplit.
  setIndoorLandscapeGateFlag(null);
  try {
    const s3 = makeScene3d(cellRegistry([[A, [B]], [B, [A]]]));
    const state = {
      player: A, indoor: true, bfs: [A, B], frustum: [A, B], walk: [A, B],
      raw: [0], wide: [0], near: [0], walkCalls: 0,
    };
    const sh = makeSession(state);
    // The split's own union iterates the depth-1 set fine; the gate's second
    // pass over it (indoorLandscapeCellState's BFS-only doorway scan) throws.
    sh.getViewerRenderSet = () => {
      let passes = 0;
      return {
        *[Symbol.iterator]() {
          if (passes++ > 0) throw new Error("gate pass");
          yield A;
          yield B;
        },
      };
    };
    let st;
    for (let i = 0; i < 3; i++) st = tick(s3, sh, state);
    assert.equal(indoorLandscapeGateEnabled(), true);
    assert.equal(s3._indoorSplitArmed, true, "the split stays armed");
    assert.equal(st.skip, false);
    assert.equal(st.reason, "cells-unknown");
    assert.equal(s3.pushed.at(-1), false, "the world is drawn");
  } finally {
    setIndoorLandscapeGateFlag(null);
  }
});

// --- L7: the real pipeline --------------------------------------------------
const W = 1280, H = 720;
const gl = new Proxy({ getContextAttributes: () => ({ alpha: false }), getExtension: () => null, getParameter: () => 0 }, {
  get(tgt, k) {
    if (k in tgt) return tgt[k];
    return typeof k === "string" && /^[A-Z_0-9]+$/.test(k) ? 1 : () => null;
  },
});
const calls = [];
const renderer = {
  autoClear: true, outputColorSpace: THREE.SRGBColorSpace, toneMappingExposure: 1,
  shadowMap: { autoUpdate: true, needsUpdate: false }, capabilities: { isWebGL2: true, maxSamples: 4 },
  info: { render: { frame: 0 }, autoReset: true },
  _target: null,
  getSize: (vv) => vv.set(W, H), getDrawingBufferSize: (vv) => vv.set(W, H), getPixelRatio: () => 1,
  setSize() {}, setOpaqueSort() {}, setTransparentSort() {}, getContext: () => gl,
  getRenderTarget() { return this._target; },
  setRenderTarget(rt) { this._target = rt ?? null; },
  render(sc, cam) { calls.push({ kind: "render", scene: sc, mask: cam?.layers?.mask }); },
  clear(color, depth, stencil) { calls.push({ kind: "clear", color: !!color, depth: !!depth, stencil: !!stencil }); },
  clearDepth() {}, setClearColor() {}, getClearColor: (c) => c, getClearAlpha: () => 1, setClearAlpha() {},
  state: { buffers: { stencil: { setFunc() {} } } }, properties: { get: () => ({}) },
};

await t("L7 real pipeline: the skip frame clears, draws no world, keeps the cells pass", async () => {
  const { createAtmospherePipeline } = await import("../scene3d/atmosphere_pipeline.js");
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  camera.layers.enable(1);
  camera.updateMatrixWorld(true);
  const skyScene = new THREE.Scene();
  skyScene.name = "sky";
  const skyCamera = new THREE.PerspectiveCamera();
  const p = createAtmospherePipeline(renderer, scene, camera, {
    atmosphereRuntime: { textures: {} }, skyScene, skyCamera, bloom: false, vignette: false,
  });
  assert.equal(typeof p.setIndoorLandscapeSkip, "function");
  assert.ok(p.skyRenderPass, "fixture: a sky pass");
  // A SeenOutside room (sky not blocked by the static test).
  const skyDome = { _lastIsIndoor: true, _lastSkyBlocked: false, syncSkyCamera() {} };
  const frame = () => {
    calls.length = 0;
    p.preFrameSkySync(skyDome, camera);
    p.render(camera, 0);
    const main = calls.filter((c) => c.kind === "render" && c.scene === scene);
    const sky = calls.filter((c) => c.kind === "render" && c.scene === skyScene);
    return { main, sky, all: calls.slice() };
  };

  // Armed, no skip: today's split (world layer 0, depth wipe, cells layer 1).
  p.setIndoorSplitArmed(true);
  let f = frame();
  assert.equal(f.sky.length, 1, "sky drawn (SeenOutside room)");
  assert.deepEqual(f.main.map((c) => c.mask), [1, 2], "world WORLD_ONLY, then cells INDOOR_ONLY");
  assert.equal(p.depthClearPass.enabled, true);
  let iCells = f.all.findIndex((c) => c.kind === "render" && c.scene === scene && c.mask === 2);
  assert.ok(
    f.all.slice(0, iCells).some((c) => c.kind === "clear" && !c.color && c.depth),
    "the Z wipe precedes the cells pass",
  );
  const before = INDOOR_LANDSCAPE_GATE_STATS.skippedFrames;

  // Skip.
  p.setIndoorLandscapeSkip(true);
  f = frame();
  assert.equal(f.sky.length, 0, "no sky pass");
  assert.equal(p.skyRenderPass.enabled, false);
  assert.equal(p.worldRenderPass.enabled, true, "the world RenderPass still runs");
  assert.equal(p.worldRenderPass.clear, true, "…and clears");
  assert.deepEqual(f.main.map((c) => c.mask), [0, 2], "world pass draws NO layer; cells pass unchanged");
  const iWorld = f.all.findIndex((c) => c.kind === "render" && c.scene === scene);
  assert.ok(
    f.all.slice(0, iWorld).some((c) => c.kind === "clear" && c.color && c.depth),
    "a colour + depth clear precedes the (empty) world pass",
  );
  iCells = f.all.findIndex((c) => c.kind === "render" && c.scene === scene && c.mask === 2);
  assert.ok(
    !f.all.slice(iWorld + 1, iCells).some((c) => c.kind === "clear"),
    "no depth wipe and no colour clear between the world and cells passes",
  );
  assert.equal(p.depthClearPass.enabled, false);
  assert.equal(p.cellsRenderPass.enabled, true);
  assert.equal(p.cellsRenderPass.clear, false, "the cells pass never clears");
  if (p.portalSealPass) assert.equal(p.portalSealPass.enabled, false);
  assert.equal(INDOOR_LANDSCAPE_GATE_STATS.skippedFrames, before + 1);

  // A stale skip never reaches an outdoor or disarmed frame.
  skyDome._lastIsIndoor = false;
  f = frame();
  assert.deepEqual(f.main.map((c) => c.mask), [3], "outdoor: the single BOTH pass");
  assert.equal(f.sky.length, 1);
  skyDome._lastIsIndoor = true;
  p.setIndoorSplitArmed(false);
  f = frame();
  assert.deepEqual(f.main.map((c) => c.mask), [3], "disarmed: the single BOTH pass");

  // Skip cleared → back to the split exactly.
  p.setIndoorSplitArmed(true);
  p.setIndoorLandscapeSkip(false);
  f = frame();
  assert.deepEqual(f.main.map((c) => c.mask), [1, 2]);
  assert.equal(f.sky.length, 1);
  assert.equal(p.depthClearPass.enabled, true);
  assert.equal(INDOOR_LANDSCAPE_GATE_STATS.skippedFrames, before + 1);
  p.dispose?.();
});

// --- L8: source pins --------------------------------------------------------
await t("L8 source pins: layer mask, never a disabled world pass", () => {
  const PIPE = readFileSync(path.join(APP, "scene3d", "atmosphere_pipeline.js"), "utf8");
  assert.match(PIPE, /const CAM_LAYER_MASK_NONE = 0;/);
  assert.match(PIPE, /worldMaskPass\.mask = landscapeSkip \? CAM_LAYER_MASK_NONE : CAM_LAYER_MASK_WORLD_ONLY;/);
  assert.match(PIPE, /depthClearPass\.enabled = !landscapeSkip;/);
  assert.match(PIPE, /const landscapeSkip = indoorLandscapeSkip && indoorSplitArmed && isIndoor;/);
  assert.match(PIPE, /const skyBlocked = landscapeSkip \|\| /);
  assert.doesNotMatch(PIPE, /worldRenderPass\.enabled\s*=/, "the world RenderPass is never disabled");
  // With no sky pass the world pass clears colour + depth.
  assert.match(PIPE, /\} else \{\s*\n\s*worldRenderPass\.clear = true;\s*\/\/ no sky → clear color \+ depth/);
  const CELLS = readFileSync(path.join(APP, "scene3d", "cells.js"), "utf8");
  // The gate reads the RAW walk count, before the punch clip.
  const iRaw = CELLS.indexOf("if (_lsCapture && hasOutside) _lsRawCount = _lsFlatCount(flat);");
  const iClip = CELLS.indexOf("const res = clipAperturesForPunch(flat, _psMvpArr, {");
  assert.ok(iRaw > 0 && iClip > iRaw, "raw count captured before clipAperturesForPunch");
});

console.log(`\nindoor landscape gate: ${groups} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
