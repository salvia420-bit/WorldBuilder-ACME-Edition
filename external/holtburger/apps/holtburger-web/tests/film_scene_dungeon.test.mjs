// tests/film_scene_dungeon.test.mjs
//
// WHY: AC Film Mode flies cameras through dungeons and building interiors on
// the portal graph that rynth/indoor_router.js builds from the wasm EnvCells.
// A route aimed from cell centre to cell centre cuts wall corners; a polyline
// through doorways pivots on its corners; and indoor_router's walking search
// prunes drop edges, so a camera could never dive down a shaft. This suite
// EXECUTES scene3d/film/scene/dungeon_route.js on a synthetic graph shaped
// exactly like indoor_router graphs (Map cellId → {pos:{x,y,z}, neighbors,
// exits, doors:[{other, at, normal, height, bottom}], floorZMin, floorZMax}) —
// a room, a corridor with a 90° corridor turn, a landing with a floor hole, a
// vertical shaft and a bottom room — and proves:
//   D1  the graph really has a drop edge: indoor_router.findPath (walking)
//       returns null, planIndoorPath (camera variant via walkableOverrides)
//       routes through the shaft;
//   D2  doorwayControlPoints: centroid ∓ approach·normal at
//       bottomZ + heightFrac·height, reversed door copies, includeCentre;
//   D3  thin door-frame cells clamp the approach (no doubling back);
//   D4  floor openings: control points along the vertical normal;
//   D5  transitions without door data fall back to the anchor midpoint;
//   D6  the 90° corridor turn: the route passes through every doorway centre,
//       turns smoothly (no kinks), and the arc-length Path's tangent turns a
//       total of 90° continuously;
//   D7  the vertical shaft: the path tangent swings smoothly to straight down
//       and back, never leaving the shaft's z range;
//   D8  cameraFindPath: drops allowed, 3-D cost (no lower-floor detour), low
//       openings penalised, hazards / excludeEdges, determinism;
//   D9  planIndoorPath fallbacks (injected search null / throws / garbage /
//       array-shaped graph), errors (BAD_GRAPH, UNKNOWN_CELL, NO_INDOOR_ROUTE),
//       trivial routes, explicit start/end with depth clamps;
//   D10 indoorCameraPath (arcs of curvature 1/r, input errors) and the real
//       fpv.fpv-corridor technique flying the planned route (valid trajectory,
//       continuous heading through the turn and the dive).
//
// Flag: filmMode (DEFAULT OFF, `?filmMode=on`) — dungeon_route.js is one of its pure scene modules.
// Run from apps/holtburger-web/: node tests/film_scene_dungeon.test.mjs

import assert from "node:assert/strict";

const DR = await import("../scene3d/film/scene/dungeon_route.js");
const IR = await import("../rynth/indoor_router.js");
const { FilmError, FilmShotError } = await import("../scene3d/film/core/errors.js");
const SHOTS = await import("../scene3d/film/shots/index.js");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err && err.message ? err.message : err}`);
  }
}

function near(a, b, eps, msg) {
  assert.ok(Math.abs(a - b) <= eps, `${msg ?? "value"}: ${a} vs ${b} (eps ${eps})`);
}
function nearV(a, b, eps, msg) {
  for (let i = 0; i < b.length; i++) near(a[i], b[i], eps, `${msg ?? "vec"}[${i}]`);
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (len(a) * len(b)))));
const DEG = Math.PI / 180;

/** Distance from point p to the polyline. */
function distToPolyline(p, pts) {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], d = sub(pts[i + 1], a);
    const L2 = dot(d, d);
    const s = L2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), d) / L2)) : 0;
    best = Math.min(best, len(sub(p, [a[0] + d[0] * s, a[1] + d[1] * s, a[2] + d[2] * s])));
  }
  return best;
}

// ---------------------------------------------------------------------------
// The synthetic dungeon (world frame: landblock 0x01F6 origin + local metres)
// ---------------------------------------------------------------------------
const LB = 0x01f60000;
const BX = 0x01 * 192;
const BY = 0xf6 * 192;
const W = (x, y, z) => ({ x: BX + x, y: BY + y, z });
const Wa = (x, y, z) => [BX + x, BY + y, z];
const id = (lo) => (LB | lo) >>> 0;
const ROOM = id(0x0100);   // (10, 10) floor 0
const HALL = id(0x0101);   // corridor north (10, 25)
const CORNER = id(0x0102); // the 90° corner (10, 40)
const EAST = id(0x0103);   // corridor east (24, 40)
const LANDING = id(0x0104); // landing with a floor hole (35, 40)
const SHAFT = id(0x0105);  // vertical shaft below the hole (35, 40) floor −12
const BOTTOM = id(0x0106); // bottom room (45, 40) floor −12
const OUTSIDE = (LB | 0xffff) >>> 0;

/**
 * Door record (indoor_router doorsFromRows shape) with its reverse copy on the
 * other cell. `normal` points OUT of `a`.
 */
function link(g, a, b, at, normal, height, bottom, { reverse = true } = {}) {
  g.get(a).neighbors.push(b);
  g.get(b).neighbors.push(a);
  g.get(a).doors.push({ other: b, at: W(...at), normal: { x: normal[0], y: normal[1], z: normal[2] }, height, bottom });
  if (reverse) {
    g.get(b).doors.push({ other: a, at: W(...at), normal: { x: -normal[0], y: -normal[1], z: -normal[2] }, height, bottom });
  }
}

function dungeon({ hole = true } = {}) {
  const g = new Map();
  const cell = (cid, x, y, floor, top) =>
    g.set(cid, { pos: W(x, y, floor), neighbors: [], exits: [], doors: [], floorZMin: floor, floorZMax: floor, ceil: top });
  cell(ROOM, 10, 10, 0, 4);
  cell(HALL, 10, 25, 0, 4);
  cell(CORNER, 10, 40, 0, 4);
  cell(EAST, 24, 40, 0, 4);
  cell(LANDING, 35, 40, 0, 4);
  cell(SHAFT, 35, 40, -12, 0);
  cell(BOTTOM, 45, 40, -12, -8);
  g.get(ROOM).exits.push(OUTSIDE);
  link(g, ROOM, HALL, [10, 15, 1.5], [0, 1, 0], 3, 0);
  link(g, HALL, CORNER, [10, 35, 1.5], [0, 1, 0], 3, 0);
  link(g, CORNER, EAST, [15, 40, 1.5], [1, 0, 0], 3, 0);
  link(g, EAST, LANDING, [32, 40, 1.5], [1, 0, 0], 3, 0);
  if (hole) link(g, LANDING, SHAFT, [35, 40, 0], [0, 0, -1], 0, 0);
  link(g, SHAFT, BOTTOM, [38.5, 40, -10.5], [1, 0, 0], 3, -12);
  return g;
}

// ---------------------------------------------------------------------------
// D1 drop edges
// ---------------------------------------------------------------------------
check("D1 the shaft is a drop edge: walking findPath fails, the camera route dives", () => {
  const g = dungeon();
  assert.equal(IR.isDropEdge(g.get(LANDING), g.get(SHAFT)), true, "indoor_router classifies the shaft as a drop");
  assert.equal(IR.findPath(g, ROOM, BOTTOM), null, "a walker cannot plan through the shaft");
  const plan = DR.planIndoorPath(g, ROOM, BOTTOM);
  assert.deepEqual(plan.cells, [ROOM, HALL, CORNER, EAST, LANDING, SHAFT, BOTTOM]);
  assert.equal(plan.search, "router", "indoor_router.findPath with walkableOverrides did the search");
  assert.equal(plan.doorways.length, 6);
  for (const p of plan.points) assert.ok(p.every(Number.isFinite), "finite points");
  assert.ok(DR.allEdgeKeys(g).has(IR.edgeKey(LANDING, SHAFT)), "overrides include the drop edge");
  assert.equal(DR.allEdgeKeys(g).size, 6, "one key per undirected edge");
});

// ---------------------------------------------------------------------------
// D2 doorway control points
// ---------------------------------------------------------------------------
check("D2 doorwayControlPoints: centroid ∓ approach·normal at bottomZ + heightFrac·height", () => {
  const g = dungeon();
  const pts = DR.doorwayControlPoints(g, [ROOM, HALL, CORNER]);
  assert.equal(pts.length, 4, "2 per transition");
  nearV(pts[0], Wa(10, 15 - 1.2, 1.65), 1e-9, "before door 1");
  nearV(pts[1], Wa(10, 15 + 1.2, 1.65), 1e-9, "after door 1");
  nearV(pts[2], Wa(10, 35 - 1.2, 1.65), 1e-9, "before door 2");
  nearV(pts[3], Wa(10, 35 + 1.2, 1.65), 1e-9, "after door 2");
  const custom = DR.doorwayControlPoints(g, [ROOM, HALL], { heightFrac: 0.5, approach: 2 });
  nearV(custom[0], Wa(10, 13, 1.5), 1e-9, "custom before");
  nearV(custom[1], Wa(10, 17, 1.5), 1e-9, "custom after");
  const withC = DR.doorwayControlPoints(g, [ROOM, HALL], { includeCentre: true });
  assert.equal(withC.length, 3);
  nearV(withC[1], Wa(10, 15, 1.65), 1e-9, "the crossing point");
  assert.deepEqual(DR.doorwayControlPoints(g, [ROOM]), []);
  assert.deepEqual(DR.doorwayControlPoints(g, []), []);
  assert.deepEqual(DR.doorwayControlPoints(null, [ROOM, HALL]), []);
});

check("D2 the reverse direction and a one-sided door record use the reversed normal", () => {
  const g = dungeon();
  const back = DR.doorwayControlPoints(g, [HALL, ROOM]);
  nearV(back[0], Wa(10, 16.2, 1.65), 1e-9, "before (north of the door)");
  nearV(back[1], Wa(10, 13.8, 1.65), 1e-9, "after (south of the door)");
  const one = new Map([
    [ROOM, { pos: W(10, 10, 0), neighbors: [HALL], exits: [], doors: [] }],
    [HALL, { pos: W(10, 25, 0), neighbors: [ROOM], exits: [], doors: [
      { other: ROOM, at: W(10, 15, 1.5), normal: { x: 0, y: -1, z: 0 }, height: 3, bottom: 0 },
    ] }],
  ]);
  const f = DR.doorwayFrames(one, [ROOM, HALL])[0];
  nearV(f.normal, [0, 1, 0], 1e-12, "normal out of ROOM, from HALL's record");
  nearV(f.before, Wa(10, 13.8, 1.65), 1e-9, "before");
  assert.equal(f.upright, true);
  assert.equal(f.fallback, false);
});

// ---------------------------------------------------------------------------
// D3 thin door-frame cells
// ---------------------------------------------------------------------------
check("D3 a 0.5 m door-frame cell clamps the approach — the route never doubles back", () => {
  const A = id(0x0110), F = id(0x0111), B = id(0x0112);
  const g = new Map();
  g.set(A, { pos: W(0, 0, 0), neighbors: [], exits: [], doors: [] });
  g.set(F, { pos: W(0, 5.25, 0), neighbors: [], exits: [], doors: [] });
  g.set(B, { pos: W(0, 10, 0), neighbors: [], exits: [], doors: [] });
  link(g, A, F, [0, 5, 1.25], [0, 1, 0], 2.5, 0);
  link(g, F, B, [0, 5.5, 1.25], [0, 1, 0], 2.5, 0);
  const pts = DR.doorwayControlPoints(g, [A, F, B]);
  assert.equal(pts.length, 4);
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i][1] >= pts[i - 1][1] - 1e-12, `monotone north at ${i}`);
  near(pts[1][1] - (BY + 5), 0.25, 1e-9, "after door 1 = half the 0.5 m gap");
  near((BY + 5.5) - pts[2][1], 0.25, 1e-9, "before door 2 = half the gap");
  const plan = DR.planIndoorPath(g, A, B);
  for (let i = 1; i < plan.points.length; i++) {
    assert.ok(plan.points[i][1] >= plan.points[i - 1][1] - 1e-9, "control polyline monotone");
  }
  for (let i = 1; i < plan.filleted.length; i++) {
    assert.ok(plan.filleted[i][1] >= plan.filleted[i - 1][1] - 1e-9, "filleted route monotone");
  }
});

// ---------------------------------------------------------------------------
// D4 floor openings
// ---------------------------------------------------------------------------
check("D4 a floor opening puts the control points above and below the hole", () => {
  const g = dungeon();
  const f = DR.doorwayFrames(g, [LANDING, SHAFT])[0];
  assert.equal(f.upright, false);
  nearV(f.normal, [0, 0, -1], 1e-12, "travel straight down");
  nearV(f.center, Wa(35, 40, 0), 1e-12, "the hole centroid");
  nearV(f.before, Wa(35, 40, 1.2), 1e-9, "above");
  nearV(f.after, Wa(35, 40, -1.2), 1e-9, "below");
  const up = DR.doorwayFrames(g, [SHAFT, LANDING])[0];
  nearV(up.normal, [0, 0, 1], 1e-12, "climbing the shaft");
  nearV(up.after, Wa(35, 40, 1.2), 1e-9, "after = above the hole");
});

// ---------------------------------------------------------------------------
// D5 no door data
// ---------------------------------------------------------------------------
check("D5 a transition without door data uses the midpoint of the cell anchors", () => {
  const A = id(0x0120), B = id(0x0121);
  const g = new Map([
    [A, { pos: W(0, 0, 0), neighbors: [B], exits: [] }],
    [B, { pos: W(0, 8, 0), neighbors: [A], exits: [] }],
  ]);
  const f = DR.doorwayFrames(g, [A, B])[0];
  assert.equal(f.fallback, true);
  const zc = 0.55 * DR.FALLBACK_OPENING_HEIGHT_M;
  nearV(f.center, Wa(0, 4, zc), 1e-9, "midpoint at camera height");
  nearV(f.before, Wa(0, 4 - 1.2, zc), 1e-9, "before along the anchor direction");
  nearV(f.after, Wa(0, 4 + 1.2, zc), 1e-9, "after");
  const tight = new Map([
    [A, { pos: W(0, 0, 0), neighbors: [B], exits: [] }],
    [B, { pos: W(0, 2, 0), neighbors: [A], exits: [] }],
  ]);
  const t = DR.doorwayFrames(tight, [A, B])[0];
  near(t.after[1] - t.before[1], 1, 1e-9, "approach clamped to a quarter of the 2 m span each side");
  assert.deepEqual(DR.doorwayFrames(g, [A, id(0x0999)]), [], "unknown cell without door data is skipped");
});

// ---------------------------------------------------------------------------
// D6 the 90° corridor turn
// ---------------------------------------------------------------------------
check("D6 the 90° corridor turn: through every doorway centre, no kinks", () => {
  const g = dungeon();
  const plan = DR.planIndoorPath(g, ROOM, EAST, { fillet: 1.5 });
  assert.deepEqual(plan.cells, [ROOM, HALL, CORNER, EAST]);
  assert.equal(plan.fillet, 1.5);
  const F = plan.filleted;
  for (const f of plan.doorways) {
    assert.ok(distToPolyline(f.center, F) < 1e-6, `route crosses the doorway centre ${f.center}`);
    // the leg through the doorway is straight along its normal (the fillet never cuts it)
    const i = F.findIndex((p) => len(sub(p, f.center)) < 1e-9);
    assert.ok(i > 0 && i < F.length - 1, "centre kept as a vertex");
    const dIn = sub(F[i], F[i - 1]), dOut = sub(F[i + 1], F[i]);
    assert.ok(angle(dIn, f.normal) < 1e-6 && angle(dOut, f.normal) < 1e-6, "straight through the doorway");
  }
  let maxTurn = 0;
  for (let i = 1; i + 1 < F.length; i++) {
    maxTurn = Math.max(maxTurn, angle(sub(F[i], F[i - 1]), sub(F[i + 1], F[i])));
  }
  assert.ok(maxTurn < 12 * DEG, `largest vertex turn ${(maxTurn / DEG).toFixed(2)}° (filleted)`);
  near(plan.length, F.slice(1).reduce((acc, p, i) => acc + len(sub(p, F[i])), 0), 1e-9, "length");
  // the unfilleted control polyline really has the hard corner
  let ctrlTurn = 0;
  const c = plan.points;
  for (let i = 1; i + 1 < c.length; i++) ctrlTurn = Math.max(ctrlTurn, angle(sub(c[i], c[i - 1]), sub(c[i + 1], c[i])));
  assert.ok(ctrlTurn >= 40 * DEG, `control polyline corner ${(ctrlTurn / DEG).toFixed(1)}°`);
});

check("D6 the arc-length Path turns 90° continuously (tangent never jumps)", () => {
  const g = dungeon();
  const plan = DR.planIndoorPath(g, ROOM, EAST);
  const path = DR.indoorCameraPath(plan.points, { fillet: 1.5 });
  const t0 = path.tangentAt(0);
  const t1 = path.tangentAt(path.length);
  near(angle(t0, t1), 90 * DEG, 0.5 * DEG, "total turn north → east");
  let prev = path.tangentAt(0);
  let maxStep = 0;
  for (let s = 0.05; s <= path.length; s += 0.05) {
    const t = path.tangentAt(s);
    maxStep = Math.max(maxStep, angle(prev, t));
    prev = t;
  }
  assert.ok(maxStep < 6 * DEG, `largest tangent change per 5 cm: ${(maxStep / DEG).toFixed(2)}°`);
  for (let s = 0; s <= path.length; s += 0.25) {
    const p = path.at(s);
    assert.ok(p[2] > 1 && p[2] < 2, `stays at camera height (z ${p[2]})`);
  }
});

// ---------------------------------------------------------------------------
// D7 the vertical shaft
// ---------------------------------------------------------------------------
check("D7 the shaft dive: tangent swings smoothly to straight down and back", () => {
  const g = dungeon();
  const plan = DR.planIndoorPath(g, EAST, BOTTOM);
  assert.deepEqual(plan.cells, [EAST, LANDING, SHAFT, BOTTOM]);
  const path = DR.indoorCameraPath(plan.points);
  let minTz = 1, maxStep = 0;
  let prev = path.tangentAt(0);
  for (let s = 0.05; s <= path.length; s += 0.05) {
    const t = path.tangentAt(s);
    minTz = Math.min(minTz, t[2]);
    maxStep = Math.max(maxStep, angle(prev, t));
    prev = t;
    const p = path.at(s);
    assert.ok(p[2] >= -12 && p[2] <= 4, `inside the dungeon's z range (z ${p[2].toFixed(2)})`);
  }
  assert.ok(minTz < -0.999, `passes straight down (min tangent z ${minTz})`);
  assert.ok(maxStep < 8 * DEG, `largest tangent change per 5 cm: ${(maxStep / DEG).toFixed(2)}°`);
  const hole = Wa(35, 40, 0);
  assert.ok(distToPolyline(hole, plan.points) < 1e-6, "through the hole centroid");
  assert.ok(distToPolyline(hole, plan.filleted) < 1e-6, "the filleted route too");
  near(path.at(path.length)[2], -12 + DR.ROUTE_ANCHOR_HEIGHT_M, 1e-6, "ends at the bottom room anchor");
});

// ---------------------------------------------------------------------------
// D8 cameraFindPath
// ---------------------------------------------------------------------------
check("D8 cameraFindPath allows drops and finds the full dungeon route", () => {
  const g = dungeon();
  assert.deepEqual(DR.cameraFindPath(g, ROOM, BOTTOM), [ROOM, HALL, CORNER, EAST, LANDING, SHAFT, BOTTOM]);
  assert.deepEqual(DR.cameraFindPath(g, ROOM, ROOM), [ROOM]);
  assert.equal(DR.cameraFindPath(g, ROOM, id(0x0999)), null);
  assert.equal(DR.cameraFindPath(dungeon({ hole: false }), ROOM, BOTTOM), null, "no hole → unreachable");
  assert.equal(DR.cameraFindPath(null, ROOM, BOTTOM), null);
});

check("D8 3-D cost: the camera stays on its floor where the 2-D router cost would dive", () => {
  // S → T along an upper corridor bent through U (13.4 m), or down a shaft to a
  // lower floor and up another (12.0 m in 2-D, but 52 m of actual flight).
  const S = id(0x0130), U = id(0x0131), T = id(0x0132), L1 = id(0x0133), L2 = id(0x0134);
  const g = new Map();
  const cell = (c, x, y, z) => g.set(c, { pos: W(x, y, z), neighbors: [], exits: [], doors: [] });
  cell(S, 0, 0, 0); cell(U, 3, 6, 0); cell(T, 0, 12, 0); cell(L1, 0, 0.2, -20); cell(L2, 0, 11.8, -20);
  const edge = (a, b) => { g.get(a).neighbors.push(b); g.get(b).neighbors.push(a); };
  edge(L1, S); edge(L1, L2); edge(L2, T); edge(S, U); edge(U, T);
  assert.deepEqual(IR.findPath(g, S, T, { walkableOverrides: DR.allEdgeKeys(g) }), [S, L1, L2, T],
    "indoor_router's 2-D cost dives through the shafts");
  assert.deepEqual(DR.cameraFindPath(g, S, T), [S, U, T]);
  const plan = DR.planIndoorPath(g, S, T);
  assert.deepEqual(plan.cells, [S, U, T], "planIndoorPath keeps the camera on its floor");
  assert.equal(plan.search, "camera");
  assert.deepEqual(DR.cameraFindPath(g, S, T), DR.cameraFindPath(g, S, T), "deterministic");
  assert.equal(DR.planIndoorPath(dungeon(), ROOM, BOTTOM).search, "router", "equal cost → the router's route stands");
});

check("D8 low openings are penalised, hazards and excluded edges avoided", () => {
  const A = id(0x0140), B = id(0x0141), C = id(0x0142);
  const g = new Map();
  const cell = (c, x, y) => g.set(c, { pos: W(x, y, 0), neighbors: [], exits: [], doors: [] });
  cell(A, 0, 0); cell(B, 5, 3); cell(C, 10, 0);
  link(g, A, C, [5, 0, 1.4], [1, 0, 0], 1.2, 0.8);      // a serving window straight across (10 m)
  link(g, A, B, [2.5, 1.5, 1.5], [0.857, 0.514, 0], 3, 0); // real doors around (≈11.7 m)
  link(g, B, C, [7.5, 1.5, 1.5], [0.857, -0.514, 0], 3, 0);
  assert.deepEqual(DR.cameraFindPath(g, A, C), [A, B, C], "doors beat the shorter window");
  assert.deepEqual(DR.cameraFindPath(g, A, C, { lowOpeningPenalty: 0 }), [A, C], "no penalty → window");
  assert.deepEqual(DR.cameraFindPath(g, A, C, { hazards: new Set([B]) }), [A, C], "hazard avoided");
  assert.deepEqual(DR.cameraFindPath(g, A, C, { excludeEdges: new Set([IR.edgeKey(A, B)]) }), [A, C]);
  const plan = DR.planIndoorPath(g, A, C);
  assert.deepEqual(plan.cells, [A, B, C], "the router's bodySized pass also prefers the doors");
  const f = DR.doorwayFrames(g, [A, C])[0];
  assert.equal(f.low, true, "window flagged low");
  nearV(f.center, Wa(5, 0, 0.8 + 0.55 * 1.2), 1e-9, "window crossing height");
});

// ---------------------------------------------------------------------------
// D9 planIndoorPath fallbacks / errors / options
// ---------------------------------------------------------------------------
check("D9 the camera A* decides when the injected search fails", () => {
  const g = dungeon();
  const want = [ROOM, HALL, CORNER, EAST, LANDING, SHAFT, BOTTOM];
  const seen = [];
  const p1 = DR.planIndoorPath(g, ROOM, BOTTOM, { findPath: (gr, a, b, o) => { seen.push(o); return null; } });
  assert.deepEqual(p1.cells, want);
  assert.equal(p1.search, "camera");
  assert.ok(seen[0].walkableOverrides instanceof Set && seen[0].walkableOverrides.size === 6, "overrides passed");
  assert.equal(seen[0].bodySized, true);
  const p2 = DR.planIndoorPath(g, ROOM, BOTTOM, { findPath: () => { throw new Error("boom"); } });
  assert.deepEqual(p2.cells, want);
  const p3 = DR.planIndoorPath(g, ROOM, BOTTOM, { findPath: () => [ROOM, BOTTOM] });
  assert.deepEqual(p3.cells, want, "a path over non-edges is rejected");
  const p4 = DR.planIndoorPath(g, ROOM, BOTTOM, { findPath: null });
  assert.equal(p4.search, "camera");
  const p6 = DR.planIndoorPath(g, ROOM, BOTTOM, { findPath: IR.findPath });
  assert.equal(p6.search, "router", "an injected indoor_router.findPath is used");
  assert.deepEqual(p6.cells, want);
  // array-shaped / plain-object graphs skip indoor_router (it reads pos.x)
  const arr = {};
  for (const [k, v] of g) {
    arr[String(k)] = { ...v, pos: [v.pos.x, v.pos.y, v.pos.z], doors: v.doors.map((d) => ({ ...d, at: [d.at.x, d.at.y, d.at.z], normal: [d.normal.x, d.normal.y, d.normal.z] })) };
  }
  const p5 = DR.planIndoorPath(arr, ROOM, BOTTOM);
  assert.deepEqual(p5.cells, want);
  assert.equal(p5.search, "camera");
  for (let i = 0; i < p1.points.length; i++) nearV(p5.points[i], p1.points[i], 1e-9, `array graph point ${i}`);
});

check("D9 errors: empty graph, unknown cell, disconnected cells", () => {
  const code = (c) => (e) => e instanceof FilmShotError && e.code === c && e.message.length > 20;
  assert.throws(() => DR.planIndoorPath(new Map(), ROOM, HALL), code("BAD_GRAPH"));
  assert.throws(() => DR.planIndoorPath(null, ROOM, HALL), code("BAD_GRAPH"));
  assert.throws(() => DR.planIndoorPath(dungeon(), ROOM, id(0x0999)), (e) => code("UNKNOWN_CELL")(e) && /0x01F60999/.test(e.message));
  assert.throws(() => DR.planIndoorPath(dungeon(), "nope", HALL), code("UNKNOWN_CELL"));
  assert.throws(() => DR.planIndoorPath(dungeon({ hole: false }), ROOM, BOTTOM), code("NO_INDOOR_ROUTE"));
});

check("D9 trivial route, explicit start/end and their depth clamps", () => {
  const g = dungeon();
  const t = DR.planIndoorPath(g, HALL, HALL);
  assert.equal(t.search, "trivial");
  assert.deepEqual(t.cells, [HALL]);
  assert.equal(t.points.length, 1);
  nearV(t.points[0], Wa(10, 25, DR.ROUTE_ANCHOR_HEIGHT_M), 1e-9, "the cell anchor");
  const start = Wa(10, 14.4, 1.6), end = Wa(10, 30, 1.6);
  const p = DR.planIndoorPath(g, ROOM, HALL, { start, end, fillet: 0 });
  nearV(p.points[0], start, 1e-12, "explicit start");
  nearV(p.points[p.points.length - 1], end, 1e-12, "explicit end");
  near(p.doorways[0].before[1], BY + 15 - 0.3, 1e-9, "before clamped to half the 0.6 m depth of the start");
  near(p.doorways[0].after[1], BY + 15 + 1.2, 1e-9, "after unclamped (end is 15 m away)");
  assert.deepEqual(p.filleted, p.points, "fillet 0 → the control polyline");
  const anchors = DR.planIndoorPath(g, ROOM, HALL, { anchorHeight: 2 });
  near(anchors.points[0][2], 2, 1e-9, "anchorHeight");
  assert.throws(() => DR.cellAnchor({ pos: [NaN, 0, 0] }), FilmShotError);
  nearV(DR.cellAnchor({ pos: { x: 1, y: 2, z: 3 }, floorZMin: 2.5 }, 1), [1, 2, 3.5], 1e-12, "floorZMin wins");
});

// ---------------------------------------------------------------------------
// D10 indoorCameraPath + the fpv-corridor technique
// ---------------------------------------------------------------------------
check("D10 indoorCameraPath: true arcs of curvature 1/r on a 90° polyline", () => {
  const pts = [[0, 0, 1.5], [0, 20, 1.5], [20, 20, 1.5]];
  const path = DR.indoorCameraPath(pts, { fillet: 3 });
  near(path.length, 20 - 3 + (Math.PI / 2) * 3 + 20 - 3, 0.01, "length = legs + quarter circle");
  near(path.curvatureAt(17 + (Math.PI / 4) * 3), 1 / 3, 0.02, "mid-arc curvature 1/r");
  near(path.curvatureAt(5), 0, 1e-6, "straight leg");
  const sharp = DR.indoorCameraPath(pts, { fillet: 0 });
  assert.ok(sharp.length >= 40, `no fillet → catmull-rom through the corner (${sharp.length})`);
  assert.throws(() => DR.indoorCameraPath(null), (e) => e instanceof FilmShotError && e.code === "BAD_ARGUMENT");
  const g = dungeon();
  const plan = DR.planIndoorPath(g, ROOM, EAST);
  const viaPlan = DR.indoorCameraPath(plan.points, { fillet: plan.fillet });
  near(viaPlan.length, plan.length, 0.02, "indoorCameraPath(points) flies the plan's filleted length");
  assert.throws(() => DR.indoorCameraPath([]), FilmError);
  assert.throws(() => DR.indoorCameraPath([[0, NaN, 0]]), FilmError);
  assert.equal(DR.indoorCameraPath([[1, 2, 3]]).length, 0, "single point → zero-length path");
});

check("D10 fpv.fpv-corridor flies the planned route: valid, continuous through turn and dive", () => {
  const g = dungeon();
  const plan = DR.planIndoorPath(g, ROOM, BOTTOM);
  const traj = SHOTS.buildShot(
    { technique: "fpv.fpv-corridor", duration: 12, params: { speed: 5 }, seed: 7 },
    { anchor: plan.points[0], indoor: { route: plan.points }, aspect: 16 / 9, fps: 30 },
  );
  const v = SHOTS.validateTrajectory(traj, { fps: 30 });
  assert.equal(v.ok, true, `validateTrajectory: ${JSON.stringify(v.issues).slice(0, 300)}`);
  let prev = traj.sample(0);
  near(prev.pos[0], plan.points[0][0], 0.05, "starts at the route start");
  let minP = 0;
  for (let k = 1; k <= 360; k++) {
    const pose = traj.sample((12 * k) / 360);
    for (const x of [...pose.pos, pose.h, pose.p, pose.r, ...pose.q]) assert.ok(Number.isFinite(x), "finite pose");
    assert.ok(Math.abs(pose.h - prev.h) < 25 * DEG, `heading continuous at k=${k}: ${pose.h} vs ${prev.h}`);
    minP = Math.min(minP, pose.p);
    prev = pose;
  }
  assert.ok(minP < -45 * DEG, `the camera pitches down into the shaft (min pitch ${(minP / DEG).toFixed(1)}°)`);
  const end = traj.sample(12).pos;
  near(end[2], plan.points[plan.points.length - 1][2], 0.1, "ends at the bottom room");
});

console.log(`film_scene_dungeon: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
