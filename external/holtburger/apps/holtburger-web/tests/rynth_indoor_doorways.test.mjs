// tests/rynth_indoor_doorways.test.mjs — rynth-macro-nav-5: indoor routing
// through the REAL doorway polygons (rynth/indoor_router.js node.doors, fed by
// the wasm EnvCellPlacement.takePortalDoorways getter) behind the DEFAULT-OFF
// ?indoorDoorways=on / opts.indoorDoorways (rynth/goto_compose.js).
//
// The synthetic graph is the Holtburg tavern (landblock 0xA9B4) as the base
// DATs give it: the bar room 0x0155 opens east over the counter (0x015C, a
// 1.8 m opening over a 1 m sill) and south through 2.5 m doors in 0.5 m deep
// door-frame cells; the east hall's vestibule 0x0164 has the outdoor door.
//
//   F1      the flag: absent / off reads false, on|1|true reads true;
//           opts.indoorDoorways wins over the URL
//   R1      doorsFromRows: the 9-value rows, the exact u32 outdoor id, NaN /
//           self rows dropped, a partial tail ignored
//   P1-P3   findPath {bodySized}: the counter edge is skipped when the doors
//           connect, used when it is the only way, and a graph without door
//           data gets the same path either way
//   E1-E2   findExitPath {bodySized}: a window exit is not an exit, the south
//           doors route to the east door; exitDoor's normal points outdoors
//   L1-L4   toLegs {doorways}: 2 legs per transition straddling each doorway
//           centroid at its floor, clamped in thin door-frame cells (no
//           doubling back); a transition without a doorway falls back to the
//           30 % / 50 % pair; lastCentre / exitDoor; the legacy modes ignore
//           node.doors
//   G1-G2   buildStitchedGraphFromWasm: node.doors from the getter; a stale
//           placement (no getter, or one that throws) has none
//   C1-C3   composeEgress: flag ON exits through the doors on the first walk,
//           the outdoor leg on the door's outward side; flag OFF walks the
//           legacy legs (identical with or without door data) and wedges on
//           the counter; flag ON without door data = flag OFF
//   C4      composeGoto indoor -> indoor: flag ON walks the doorways straight
//           to the goal; flag OFF is unchanged by node.doors
//
// Run from apps/holtburger-web/:  node tests/rynth_indoor_doorways.test.mjs

import assert from "node:assert/strict";

const IR = await import("../rynth/indoor_router.js");
const GC = await import("../rynth/goto_compose.js");

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 5).join("\n       ") : e}`);
  }
}

// ── the tavern (world frame: lb origin + landblock-local metres) ────────────
const LB = 0xa9b40000;
const BX = 0xa9 * 192;
const BY = 0xb4 * 192;
const W = (x, y, z) => ({ x: BX + x, y: BY + y, z });
const id = (lo) => (LB | lo) >>> 0;
const BAR = id(0x0155);
const COUNTER = id(0x015c);
const HALL = id(0x0162);
const VEST = id(0x0164);
const FRAME_N = id(0x0153);
const SOUTH = id(0x0154);
const FRAME_E = id(0x0152);
const OUTSIDE = id(0xffff);
const COUNTER_X = 109.75; // the counter cell's mid-plane (lb-local)

function tavern({ doors = true, southRoute = true, barWindow = false } = {}) {
  const g = new Map();
  const cell = (cid, x, y) => g.set(cid, { pos: W(x, y, 94), neighbors: [], exits: [], ...(doors ? { doors: [] } : {}) });
  cell(BAR, 107.5, 36);
  cell(COUNTER, 109.75, 36);
  cell(HALL, 114, 36);
  cell(VEST, 118.25, 36);
  if (southRoute) {
    cell(FRAME_N, 107.5, 31.25);
    cell(SOUTH, 107.5, 29.25);
    cell(FRAME_E, 110.95, 31.25);
  }
  // A doorway joining a and b: centroid (lb-local), normal out of a, height, bottom.
  // Each side keeps its own copy, as the wasm getter gives them.
  const join = (a, b, x, y, cz, nx, ny, height, bottom) => {
    g.get(a).neighbors.push(b);
    g.get(b).neighbors.push(a);
    if (!doors) return;
    g.get(a).doors.push({ other: b, at: W(x, y, cz), normal: { x: nx, y: ny, z: 0 }, height, bottom });
    g.get(b).doors.push({ other: a, at: W(x, y, cz), normal: { x: -nx, y: -ny, z: 0 }, height, bottom });
  };
  join(BAR, COUNTER, 109.5, 36, 95.9, 1, 0, 1.8, 95.0);
  join(COUNTER, HALL, 110.0, 36, 95.9, 1, 0, 1.8, 95.0);
  join(HALL, VEST, 118.0, 36, 95.25, 1, 0, 2.5, 94.0);
  if (southRoute) {
    join(BAR, FRAME_N, 107.5, 31.5, 95.25, 0, -1, 2.5, 94.0);
    join(FRAME_N, SOUTH, 107.5, 31.0, 95.25, 0, -1, 2.5, 94.0);
    join(SOUTH, FRAME_E, 110.95, 31.0, 95.25, 0, 1, 2.5, 94.0);
    join(FRAME_E, HALL, 110.95, 31.5, 95.25, 0, 1, 2.5, 94.0);
  }
  const exit = (a, x, y, cz, nx, ny, height, bottom) => {
    g.get(a).exits.push(OUTSIDE);
    if (doors) g.get(a).doors.push({ other: OUTSIDE, at: W(x, y, cz), normal: { x: nx, y: ny, z: 0 }, height, bottom });
  };
  exit(VEST, 118.5, 36, 95.25, 1, 0, 2.5, 94.0);
  if (barWindow) exit(BAR, 105.5, 36, 96.0, -1, 0, 1.5, 95.0); // a window: too low for a body
  return g;
}

const worldOf = (leg) => ({ x: (((leg.lb >>> 0) >>> 24) & 0xff) * 192 + leg.x, y: (((leg.lb >>> 0) >>> 16) & 0xff) * 192 + leg.y });
const SOUTH_ROUTE = [BAR, FRAME_N, SOUTH, FRAME_E, HALL, VEST];

// ── F1 ──────────────────────────────────────────────────────────────────────
await check("F1 ?indoorDoorways: default off, on|1|true on; opts wins", () => {
  assert.equal(IR.indoorDoorwaysEnabled(""), false);
  assert.equal(IR.indoorDoorwaysEnabled("?indoorDoorways=off"), false);
  assert.equal(IR.indoorDoorwaysEnabled("?indoorDoorways=yes"), false);
  assert.equal(IR.indoorDoorwaysEnabled("?indoorDoorways=on"), true);
  assert.equal(IR.indoorDoorwaysEnabled("?indoorDoorways=1"), true);
  assert.equal(IR.indoorDoorwaysEnabled("?a=b&indoorDoorways=TRUE"), true);
  assert.equal(IR.indoorDoorwaysEnabled(), false, "no page URL in node");
  assert.equal(IR.resolveIndoorDoorways({}), false);
  assert.equal(IR.resolveIndoorDoorways(undefined), false);
  assert.equal(IR.resolveIndoorDoorways({ indoorDoorways: true }), true);
  assert.equal(IR.resolveIndoorDoorways({ indoorDoorways: false }), false);
});

// ── R1 ──────────────────────────────────────────────────────────────────────
await check("R1 doorsFromRows decodes the takePortalDoorways rows", () => {
  assert.equal(IR.DOORWAY_ROW_STRIDE, 9, "lib.rs PORTAL_DOORWAY_STRIDE");
  const rows = new Float64Array([
    OUTSIDE, BX + 118.5, BY + 36, 95.25, 1, 0, 0, 2.5, 94,
    HALL, BX + 118, BY + 36, 95.25, -1, 0, 0, 2.5, 94,
    COUNTER, NaN, 0, 0, 1, 0, 0, 1.8, 95, // non-finite: dropped
    VEST, 0, 0, 0, 1, 0, 0, 1, 1, // leads back into the cell itself: dropped
    HALL, 1, 2, // partial tail: ignored
  ]);
  const doors = IR.doorsFromRows(rows, VEST);
  assert.equal(doors.length, 2);
  assert.equal(doors[0].other, OUTSIDE, "the outdoor id is the exact u32");
  assert.deepEqual(doors[0].at, { x: BX + 118.5, y: BY + 36, z: 95.25 });
  assert.deepEqual(doors[0].normal, { x: 1, y: 0, z: 0 });
  assert.equal(doors[0].height, 2.5);
  assert.equal(doors[0].bottom, 94);
  assert.equal(doors[1].other, HALL);
  assert.deepEqual(IR.doorsFromRows(null, VEST), []);
  assert.deepEqual(IR.doorsFromRows([1, 2, 3], VEST), []);
  assert.equal(IR.doorTooLow({ normal: { x: 1, y: 0, z: 0 }, height: 1.8 }), true);
  assert.equal(IR.doorTooLow({ normal: { x: 1, y: 0, z: 0 }, height: 1.83 }), false);
  assert.equal(IR.doorTooLow({ normal: { x: 0, y: 0, z: 1 }, height: 0 }), false, "a floor opening is never too low");
  assert.equal(IR.walkableExitDoor({ normal: { x: 0, y: 0, z: 1 }, height: 0 }), false, "nor a walkable exit");
});

// ── P1-P3 ───────────────────────────────────────────────────────────────────
await check("P1 findPath {bodySized} skips the counter when the doors connect", () => {
  const g = tavern();
  assert.deepEqual(IR.findPath(g, BAR, HALL), [BAR, COUNTER, HALL], "default: over the counter (shortest)");
  assert.deepEqual(IR.findPath(g, BAR, HALL, { bodySized: true }), [BAR, FRAME_N, SOUTH, FRAME_E, HALL]);
});

await check("P2 findPath {bodySized} uses the low opening when it is the only way", () => {
  const g = tavern({ southRoute: false });
  assert.deepEqual(IR.findPath(g, BAR, HALL, { bodySized: true }), [BAR, COUNTER, HALL]);
  // ...and an excluded doorway edge still wins over the fallback.
  const ex = new Set([IR.edgeKey(COUNTER, HALL)]);
  assert.equal(IR.findPath(g, BAR, HALL, { bodySized: true, excludeEdges: ex }), null);
});

await check("P3 no door data: {bodySized} finds the same path as the default", () => {
  const g = tavern({ doors: false });
  assert.equal(IR.hasDoorways(g), false);
  assert.equal(IR.hasDoorways(tavern()), true);
  assert.deepEqual(IR.findPath(g, BAR, HALL, { bodySized: true }), IR.findPath(g, BAR, HALL));
  assert.deepEqual(IR.findExitPath(g, BAR, { bodySized: true }), IR.findExitPath(g, BAR));
  assert.equal("exitDoor" in IR.findExitPath(g, BAR), false, "no exitDoor without door data");
});

// ── E1-E2 ───────────────────────────────────────────────────────────────────
await check("E1 findExitPath {bodySized}: a window is not an exit, the doors are", () => {
  const g = tavern({ barWindow: true });
  const plain = IR.findExitPath(g, BAR);
  assert.deepEqual(plain.path, [BAR], "default: the bar's own window counts as an exit");
  assert.equal(plain.exitDoor.height, 1.5);
  const body = IR.findExitPath(g, BAR, { bodySized: true });
  assert.deepEqual(body.path, SOUTH_ROUTE);
  assert.equal(body.exitCell, VEST);
  assert.equal(body.outdoorId, null, "the outside sentinel");
  assert.equal(body.exitDoor.other, OUTSIDE);
  assert.ok(body.exitDoor.normal.x > 0.99, "exitDoor's normal points outdoors (east)");
});

await check("E2 findExitPath {bodySized}: the default BFS goes over the counter, bodySized does not", () => {
  const g = tavern();
  assert.deepEqual(IR.findExitPath(g, BAR).path, [BAR, COUNTER, HALL, VEST]);
  assert.deepEqual(IR.findExitPath(g, BAR, { bodySized: true }).path, SOUTH_ROUTE);
  // Only a window out: the fallback pass still finds it.
  const w = tavern({ barWindow: true });
  w.get(VEST).exits = [];
  w.get(VEST).doors = w.get(VEST).doors.filter((d) => d.other !== OUTSIDE);
  const r = IR.findExitPath(w, BAR, { bodySized: true });
  assert.deepEqual(r.path, [BAR]);
});

// ── L1-L4 ───────────────────────────────────────────────────────────────────
// Signed distance of a leg's world point from a doorway plane, along its normal.
const side = (leg, d) => {
  const p = worldOf(leg);
  return (p.x - d.at.x) * d.normal.x + (p.y - d.at.y) * d.normal.y;
};
const offAxis = (leg, d) => {
  const p = worldOf(leg);
  return Math.abs(-(p.x - d.at.x) * d.normal.y + (p.y - d.at.y) * d.normal.x);
};
const doorOf = (g, a, b) => g.get(a).doors.find((d) => d.other === b);

await check("L1 toLegs {doorways}: 2 legs per transition through each doorway centroid", () => {
  const g = tavern();
  const legs = IR.toLegs(g, SOUTH_ROUTE, { doorways: true });
  assert.equal(legs.length, 2 * (SOUTH_ROUTE.length - 1) + 1, "2 per edge + the last centre");
  for (let i = 0; i + 1 < SOUTH_ROUTE.length; i++) {
    const d = doorOf(g, SOUTH_ROUTE[i], SOUTH_ROUTE[i + 1]);
    const pre = legs[2 * i];
    const post = legs[2 * i + 1];
    assert.ok(side(pre, d) < 0 && side(post, d) > 0, `edge ${i}: the pair straddles the doorway`);
    assert.ok(offAxis(pre, d) < 1e-9 && offAxis(post, d) < 1e-9, `edge ${i}: on the doorway's axis`);
    assert.ok(-side(pre, d) <= IR.DOORWAY_STEP_M + 1e-9 && side(post, d) <= IR.DOORWAY_STEP_M + 1e-9);
    assert.equal(pre.z, d.bottom, "feet height");
    assert.equal(pre.lb, SOUTH_ROUTE[i], "the pre leg is stamped with the cell it is in");
    assert.equal(post.lb, SOUTH_ROUTE[i + 1]);
    assert.equal(pre.arriveM, IR.DOORWAY_ARRIVE_M);
    assert.equal(post.doorway, true);
  }
  const last = legs[legs.length - 1];
  assert.deepEqual(last, { lb: VEST, x: 118.25, y: 36, z: 94 }, "the last cell centre, as the other modes");
  // The 0.5 m deep door frame: the step past the first door and the step
  // before the second meet halfway, so y never goes back up.
  const ys = legs.slice(0, 4).map((l) => l.y);
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] <= ys[i - 1] + 1e-9, `no doubling back: ${ys}`);
  assert.ok(Math.abs(ys[1] - 31.25) < 1e-9 && Math.abs(ys[2] - 31.25) < 1e-9, `clamped to the frame's middle: ${ys}`);
});

await check("L2 toLegs {doorways}: a transition with no doorway falls back to the 30 % / 50 % pair", () => {
  const g = tavern();
  // Strip the SOUTH <-> FRAME_E doorway from both sides.
  g.get(SOUTH).doors = g.get(SOUTH).doors.filter((d) => d.other !== FRAME_E);
  g.get(FRAME_E).doors = g.get(FRAME_E).doors.filter((d) => d.other !== SOUTH);
  const legs = IR.toLegs(g, SOUTH_ROUTE, { doorways: true });
  const legacy = IR.toLegs(g, SOUTH_ROUTE, { doorwayApproach: true });
  assert.equal(legs.length, 2 * (SOUTH_ROUTE.length - 1) + 1);
  assert.deepEqual(legs.slice(4, 6), legacy.slice(4, 6), "edge 2 = the doorwayApproach legs");
  assert.equal(legs[4].doorway, undefined);
  // Only ONE side's copy: the other cell's copy is used, normal reversed.
  const h = tavern();
  h.get(BAR).doors = h.get(BAR).doors.filter((d) => d.other !== FRAME_N);
  const one = IR.toLegs(h, [BAR, FRAME_N], { doorways: true });
  const d = doorOf(tavern(), BAR, FRAME_N);
  assert.ok(side(one[0], d) < 0 && side(one[1], d) > 0, "still walks from BAR's side to FRAME_N's");
});

await check("L3 toLegs {doorways}: lastCentre:false, and exitDoor walks out instead of to the centre", () => {
  const g = tavern();
  assert.equal(IR.toLegs(g, SOUTH_ROUTE, { doorways: true, lastCentre: false }).length, 10);
  assert.deepEqual(IR.toLegs(g, [BAR], { doorways: true, lastCentre: false }), []);
  const exitDoor = IR.findExitPath(g, BAR, { bodySized: true }).exitDoor;
  const legs = IR.toLegs(g, SOUTH_ROUTE, { doorways: true, exitDoor });
  assert.equal(legs.length, 12, "2 per edge + 2 through the exit doorway, no centre");
  const [pre, post] = legs.slice(10);
  assert.ok(side(pre, exitDoor) < 0 && side(post, exitDoor) > 0, "straddles the outdoor door");
  // The 0.5 m vestibule: the hall door's step-past and the exit door's
  // step-before meet in its middle.
  assert.ok(Math.abs(worldOf(legs[9]).x - (BX + 118.25)) < 1e-9 && Math.abs(worldOf(pre).x - (BX + 118.25)) < 1e-9);
});

await check("L4 the legacy toLegs modes ignore node.doors", () => {
  const withDoors = tavern();
  const without = tavern({ doors: false });
  for (const o of [{}, { midpoints: true }, { doorwayApproach: true }]) {
    assert.deepEqual(IR.toLegs(withDoors, SOUTH_ROUTE, o), IR.toLegs(without, SOUTH_ROUTE, o), JSON.stringify(o));
  }
  // {doorways} without any door data = the doorwayApproach legs.
  assert.deepEqual(IR.toLegs(without, SOUTH_ROUTE, { doorways: true }), IR.toLegs(without, SOUTH_ROUTE, { doorwayApproach: true }));
});

// ── G1-G2 ───────────────────────────────────────────────────────────────────
function placement(cid, x, y, portalIds, rows, getter = "ok") {
  const p = {
    cellId: cid,
    cellOriginX: BX + x,
    cellOriginY: BY + y,
    cellOriginZ: 94,
    takePortalCellIds: () => portalIds.slice(),
    free() {},
  };
  if (getter === "ok") p.takePortalDoorways = () => new Float64Array(rows);
  if (getter === "throws") p.takePortalDoorways = () => { throw new Error("moved"); };
  return p;
}

await check("G1 buildStitchedGraphFromWasm stores node.doors from the getter", async () => {
  const fetchEnvCells = async () => [
    placement(HALL, 114, 36, [VEST], [VEST, BX + 118, BY + 36, 95.25, 1, 0, 0, 2.5, 94]),
    placement(VEST, 118.25, 36, [HALL, OUTSIDE], [
      HALL, BX + 118, BY + 36, 95.25, -1, 0, 0, 2.5, 94,
      OUTSIDE, BX + 118.5, BY + 36, 95.25, 1, 0, 0, 2.5, 94,
    ]),
  ];
  const g = await IR.buildStitchedGraphFromWasm([LB], { fetchEnvCells });
  assert.equal(g.get(HALL).doors.length, 1);
  assert.equal(g.get(VEST).doors[1].other, OUTSIDE);
  assert.deepEqual(g.get(VEST).exits, [OUTSIDE]);
  assert.equal(IR.hasDoorways(g), true);
  const exit = IR.findExitPath(g, HALL, { bodySized: true });
  assert.equal(exit.exitDoor.other, OUTSIDE);
});

await check("G2 a stale placement (no getter, or a throwing one) has no node.doors", async () => {
  const fetchEnvCells = async () => [
    placement(HALL, 114, 36, [VEST], [], "none"),
    placement(VEST, 118.25, 36, [HALL, OUTSIDE], [], "throws"),
  ];
  const g = await IR.buildStitchedGraphFromWasm([LB], { fetchEnvCells });
  assert.equal(g.size, 2);
  assert.equal("doors" in g.get(HALL), false);
  assert.equal("doors" in g.get(VEST), false);
  assert.deepEqual(g.get(HALL).neighbors, [VEST]);
  assert.equal(IR.hasDoorways(g), false);
});

// ── C1-C4: goto_compose ─────────────────────────────────────────────────────
// A tavern world: the walk is blocked where a straight leg crosses the bar
// counter (the x = 109.75 plane between y 31.5 and 40.5); a wedge leaves the
// pose at the last completed leg.
function tavernWorld(graphOpts = {}) {
  const graph = tavern(graphOpts);
  const centre = graph.get(BAR).pos;
  const state = { pos: { wx: centre.x, wy: centre.y, z: 94 }, cell: BAR, walks: [] };
  const nearest = (wx, wy) => {
    let best = 0;
    let bd = Infinity;
    for (const [cid, n] of graph) {
      const d = Math.hypot(n.pos.x - wx, n.pos.y - wy);
      if (d < bd) {
        bd = d;
        best = cid;
      }
    }
    return best;
  };
  const host = {
    s: { getCurrentCellId: () => state.cell >>> 0 },
    TryGetPlayerPose: () => {
      const lbX = Math.floor(state.pos.wx / 192);
      const lbY = Math.floor(state.pos.wy / 192);
      return { objCellId: state.cell >>> 0, x: state.pos.wx - lbX * 192, y: state.pos.wy - lbY * 192, z: state.pos.z };
    },
  };
  const crossesCounter = (ax, ay, bx, by) => {
    const cx = BX + COUNTER_X;
    if ((ax - cx) * (bx - cx) >= 0) return false;
    const y = ay + ((cx - ax) / (bx - ax)) * (by - ay) - BY;
    return y > 31.5 && y < 40.5;
  };
  const walk = async (legs, o = {}) => {
    state.walks.push({ label: o.label, legs: legs.map((l) => ({ ...l })) });
    for (let i = 0; i < legs.length; i++) {
      const p = worldOf(legs[i]);
      if (crossesCounter(state.pos.wx, state.pos.wy, p.x, p.y)) {
        return { ok: false, state: "FAILED", error: "walk stalled", legsWalked: i };
      }
      state.pos = { wx: p.x, wy: p.y, z: legs[i].z };
      const lo = legs[i].lb & 0xffff;
      state.cell = i === legs.length - 1 && lo < 0x100 ? legs[i].lb >>> 0 : nearest(p.x, p.y);
    }
    return { ok: true, state: "DONE", legsWalked: legs.length };
  };
  const buildGraph = async (lb) => ((((lb >>> 0) & 0xffff0000) >>> 0) === (LB >>> 0) ? graph : null);
  return { state, graph, deps: { host, router: null, walk, buildGraph } };
}
const EOPTS = { poseTimeoutMs: 60, pollMs: 2, egressAttempts: 5 };

await check("C1 composeEgress flag ON: out through the doors on the first walk, outdoor leg on the door's outward side", async () => {
  for (const barWindow of [false, true]) {
    const tw = tavernWorld({ barWindow });
    const r = await GC.composeEgress(tw.deps, { ...EOPTS, indoorDoorways: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.attempts, 1, `one walk, no wedge (barWindow ${barWindow})`);
    assert.equal(r.exitCell, VEST);
    const legs = tw.state.walks[0].legs;
    assert.equal(legs.length, 2 * (SOUTH_ROUTE.length - 1) + 2 + 1, "doorway legs + the exit doorway + outdoors");
    const out = legs[legs.length - 1];
    assert.ok((out.lb & 0xffff) > 0 && (out.lb & 0xffff) < 0x100, "the outdoor leg is a LandCell");
    assert.equal(r.outdoorId, out.lb >>> 0);
    const ow = worldOf(out);
    assert.ok(ow.x > BX + 118.5 + 3.9 && Math.abs(ow.y - (BY + 36)) < 1e-6, `EXIT_DOORSTEP_M east of the door: ${ow.x - BX}`);
    assert.equal(out.z, 94, "the doorway's floor");
    assert.ok(legs.every((l) => Number.isFinite(l.timeoutMs)), "the indoor watchdog is stamped");
    assert.ok(((tw.state.cell & 0xffff) >>> 0) < 0x100, "ended outdoors");
  }
});

await check("C2 composeEgress flag OFF: legacy legs, unchanged by node.doors; wedges on the counter first", async () => {
  const a = tavernWorld();
  const ra = await GC.composeEgress(a.deps, EOPTS);
  const b = tavernWorld({ doors: false });
  const rb = await GC.composeEgress(b.deps, EOPTS);
  assert.deepEqual(a.state.walks, b.state.walks, "door data changes nothing with the flag off");
  assert.deepEqual(ra, rb);
  assert.equal(ra.ok, true, JSON.stringify(ra));
  assert.ok(ra.attempts > 1, `the counter wedges the legacy walk first (attempts ${ra.attempts})`);
  assert.ok(a.state.walks[0].legs.every((l) => l.doorway === undefined && l.arriveM === undefined));
});

await check("C3 composeEgress flag ON without door data = flag OFF", async () => {
  const a = tavernWorld({ doors: false });
  const ra = await GC.composeEgress(a.deps, { ...EOPTS, indoorDoorways: true });
  const b = tavernWorld({ doors: false });
  const rb = await GC.composeEgress(b.deps, EOPTS);
  assert.deepEqual(a.state.walks, b.state.walks);
  assert.deepEqual(ra, rb);
});

await check("C4 composeGoto indoor -> indoor: flag ON walks the doorways to the goal; OFF unchanged", async () => {
  const to = { lb: HALL, x: 115, y: 37, z: 94 };
  const outdoorGoto = async () => {
    throw new Error("no outdoor leg in a same-landblock indoor goto");
  };
  const run = async (graphOpts, opts) => {
    const tw = tavernWorld(graphOpts);
    const r = await GC.composeGoto({ ...tw.deps, outdoorGoto }, to, { poseTimeoutMs: 60, pollMs: 2, ...opts });
    return { r, walks: tw.state.walks };
  };
  const on = await run({}, { indoorDoorways: true });
  assert.equal(on.r.ok, true, JSON.stringify(on.r));
  const legs = on.walks[0].legs;
  assert.equal(legs.length, 2 * 4 + 1, "4 doorway transitions (south route) + the goal, no last centre");
  assert.deepEqual(legs[legs.length - 1], { lb: HALL, x: 115, y: 37, z: 94 });
  assert.ok(legs.slice(0, -1).every((l) => l.doorway === true));
  const offDoors = await run({}, {});
  const offPlain = await run({ doors: false }, {});
  assert.deepEqual(offDoors.walks, offPlain.walks, "flag off: node.doors changes nothing");
  assert.deepEqual(offDoors.walks[0].legs, [...IR.toLegs(tavern(), [BAR, COUNTER, HALL], { midpoints: true }), to]);
});

console.log(`\nrynth_indoor_doorways: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
