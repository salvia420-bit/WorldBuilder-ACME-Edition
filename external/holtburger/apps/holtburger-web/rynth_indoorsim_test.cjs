// Indoor-router sim test: node-only fixture tests for rynth/indoor_router.js
// (the DungeonPathfinder.cs pure-layer port, report 09 §1b) on SYNTHETIC cell
// graphs — no browser, no wasm, no server. Covers: straight corridor, branch
// choice, hazard avoidance (goal-hazard allowed), drop-edge pruning (detour
// forced; drop-only route null = the J3 limitation), unreachable -> null,
// 2-core patrol prune (spur dropped; small-graph fallback), Euler closed-walk
// patrol (every corridor once, returns home), toLegs frame conversion, and
// buildGraphFromWasm's off-wasm guards + mock-placement happy path.
//
// The module is ESM and this repo has no package.json, so import() of a .js
// would parse as CJS — copy it to a tmpdir .mjs first (same trick the run
// rules prescribe for node --check).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// Fake dungeon landblock 0x01A9 -> world origin (lbX=0x01, lbY=0xA9).
const LB = 0x01a90000;
const X0 = 0x01 * 192;
const Y0 = 0xa9 * 192;
const id = (lo) => (LB | lo) >>> 0;

// Graph builder: cells = { lo16: [localX, localY, z, [neighborLo16...]] }.
// pos is WORLD frame per the module contract (local + landblock origin).
function mk(cells) {
  const g = {};
  for (const [lo, [x, y, z, nbs]] of Object.entries(cells)) {
    g[id(Number(lo))] = { pos: { x: X0 + x, y: Y0 + y, z }, neighbors: nbs.map((n) => id(n)) };
  }
  return g;
}

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`PASS ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}

(async () => {
  const src = path.join(__dirname, "rynth", "indoor_router.js");
  const tmp = path.join(os.tmpdir(), `indoor_router.${process.pid}.mjs`);
  fs.copyFileSync(src, tmp);
  let M;
  try {
    M = await import(pathToFileURL(tmp).href);
  } finally {
    fs.unlinkSync(tmp);
  }

  // ── fixtures ────────────────────────────────────────────────────────────
  // Straight corridor A(0x100)-B-C-D(0x103), 10m spacing, flat.
  const corridor = mk({
    0x100: [0, 0, 5, [0x101]],
    0x101: [10, 0, 5, [0x100, 0x102]],
    0x102: [20, 0, 5, [0x101, 0x103]],
    0x103: [30, 0, 5, [0x102]],
  });

  // Branch: A->G short via B (30m), long via C-D-E (~72m).
  const branch = mk({
    0x100: [0, 0, 0, [0x101, 0x102]], // A
    0x101: [15, 0, 0, [0x100, 0x105]], // B (short arm)
    0x102: [0, 20, 0, [0x100, 0x103]], // C
    0x103: [15, 25, 0, [0x102, 0x104]], // D
    0x104: [30, 20, 0, [0x103, 0x105]], // E
    0x105: [30, 0, 0, [0x101, 0x104]], // G
  });

  // Drop: direct A-B edge is a 63° drop; detour A-C-B is two gentle slopes.
  // X(0x113) hangs off B via drop-only edges -> unreachable from A (J3).
  const dropg = mk({
    0x110: [0, 0, 0, [0x111, 0x112]], // A
    0x111: [4, 0, -8, [0x110, 0x112, 0x113]], // B (below A)
    0x112: [10, 0, -4, [0x110, 0x111]], // C (ramp landing)
    0x113: [4.5, 0, -16, [0x111]], // X: B->X is a shaft (dHoriz .5m)
  });

  // 8-ring (octagon r=20) + 3-cell spur off R0: prune keeps the ring (8 >= 8).
  const ringSpur = (() => {
    const cells = {};
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      cells[0x100 + i] = [
        20 * Math.cos(a),
        20 * Math.sin(a),
        0,
        [0x100 + ((i + 7) % 8), 0x100 + ((i + 1) % 8)],
      ];
    }
    cells[0x100][3].push(0x110); // R0 -> S0
    cells[0x110] = [30, 0, 0, [0x100, 0x111]];
    cells[0x111] = [40, 0, 0, [0x110, 0x112]];
    cells[0x112] = [50, 0, 0, [0x111]];
    return mk(cells);
  })();

  // 4-ring + 1 spur: pruned 2-core (4) < PATROL_MIN_KEEP_NODES(8) -> fallback.
  const smallRing = mk({
    0x100: [0, 0, 0, [0x101, 0x103, 0x110]],
    0x101: [10, 0, 0, [0x100, 0x102]],
    0x102: [10, 10, 0, [0x101, 0x103]],
    0x103: [0, 10, 0, [0x102, 0x100]],
    0x110: [-10, 0, 0, [0x100]],
  });

  // Disconnected island T0-T1 alongside the corridor cells.
  const split = mk({
    0x100: [0, 0, 0, [0x101]],
    0x101: [10, 0, 0, [0x100]],
    0x120: [100, 100, 0, [0x121]],
    0x121: [110, 100, 0, [0x120]],
  });

  // ── isEnvCellId / isDropEdge ────────────────────────────────────────────
  await t("isEnvCellId range", () => {
    assert.equal(M.isEnvCellId(id(0x100)), true);
    assert.equal(M.isEnvCellId(id(0xfffd)), true);
    assert.equal(M.isEnvCellId(id(0xfffe)), false); // outdoor sentinel
    assert.equal(M.isEnvCellId(id(0x00ff)), false); // below EnvCell range
    assert.equal(M.isEnvCellId(0), false);
  });

  await t("isDropEdge classification", () => {
    const n = (x, y, z) => ({ pos: { x, y, z } });
    assert.equal(M.isDropEdge(n(0, 0, 0), n(4, 0, -8)), true); // 63 deg drop
    assert.equal(M.isDropEdge(n(0, 0, 0), n(10, 0, -4)), false); // 22 deg ramp
    assert.equal(M.isDropEdge(n(0, 0, 0), n(0.5, 0, -3)), true); // shaft
    assert.equal(M.isDropEdge(n(0, 0, 0), n(0.1, 0, 0.4)), false); // flat dz<0.5
    assert.equal(M.isDropEdge(n(0, 0, 0), n(4, 0, 8)), true); // symmetric: up-drop
  });

  // ── isDropEdge floor-span refinement (2026-07-20, HANDOFF-wedge-closeout
  // Track E3/F) ───────────────────────────────────────────────────────────
  // Real geometry captured live (chrome-devtools headless probe against the
  // booted holtburger-web client, fetchEnvCellsInLandblock + takeMesh(), see
  // docs/rynth-integration/HANDOFF-wedge-closeout-phi4-rig-2026-07-20.md
  // Track E3/F Venue 1 + Venue 2):
  //
  //   Venue 2 (apartment z-stack, lb 0x7200): cell 0x72000100 origin
  //   (world x=21928,y=-40,z=0), bbox [1.9667,-1.9667,4.6194, 5,1.9667,6],
  //   6 tris, 2 of them FLOOR (flat, world Z=6 exactly — floorZMin=
  //   floorZMax=6). Cell 0x720002C4 (the hub/shaft above it) origin
  //   (21928,-40,6), bbox [-5,-5,0, 5,5,6], 4 tris, ALL walls (floorTriCount
  //   0 — a pure vertical shaft, no floor of its own). Post the existing
  //   bbox-anchor fix (collectLandblockIntoGraph ~:760-775), the ACTUAL
  //   node-center geometry for this pair is dHoriz=3.48 dZ=1.38 (NOT the
  //   dZ=6/dHoriz=0 the handoff worried about pre-verification) — the plain
  //   angle test (21.6° < 45°) already calls it walkable, no floor-span
  //   rescue needed. Encoded below as a regression pin.
  //
  //   Venue 1 (Holtburg building, lb-frame): cells 0xA9B40104 (ground,
  //   bbox [-4.5,-10.5,0, 3.5,-0.5,3], 2/24 floor tris, floorZ 66),
  //   0xA9B4010C (landing, bbox [1.9,-7,3, 3.5,-0.5,3.5], 0/8 floor tris —
  //   also a pure-wall connector), 0xA9B40101 (upper, bbox
  //   [-3.5,-10.5,3.5, 3.5,-0.5,9.5], 18/43 floor tris, floorZ 69.5); shared
  //   building origin (32532.09,34691.54,66), quat (0.70711,0,0,-0.70711)
  //   (pure yaw — preserves world Z exactly, sanity-checked against the
  //   dumped floorZ values). Computed node centers: 0104=(32526.59,
  //   34692.04,66), 010C=(32528.34,34688.84,69), 0101=(32526.59,34691.54,
  //   69.5). Both real sequential edges (0104-010C: dHoriz=3.65 dZ=3
  //   angle=39.4°; 010C-0101: dHoriz=3.22 dZ=0.5 angle=8.8°) already clear
  //   the plain angle test too.
  //
  // Neither flagged venue's REAL portal-connected edges currently hit the
  // SHAFT_HORIZ_M branch post-bbox-fix — this suite pins that (regression:
  // "already walkable pre-refinement") AND exercises the floor-span
  // override's actual branch two ways: (a) a same-cell-pair-derived probe
  // forcing SHAFT_HORIZ_M with 0x72000100's REAL floor span (a spiral-stair
  // footprint elsewhere in the world could realistically anchor this close
  // horizontally — the classifier must handle it), and (b) 0104/0101's own
  // real floor spans plugged into a HYPOTHETICAL direct edge (skipping
  // 010C) to prove the override does NOT overreach when the floors don't
  // actually touch (66-66 vs 69.5-69.5, a real 3.5m unaccounted gap).
  await t("floor-span refinement: real Venue 2 edge already walkable pre-refinement", () => {
    const apt = { pos: { x: 21931.483, y: -40, z: 4.6194 }, floorZMin: 6, floorZMax: 6 };
    const hub = { pos: { x: 21928, y: -40, z: 6 }, floorZMin: undefined, floorZMax: undefined };
    assert.equal(M.isDropEdge(apt, hub), false); // 21.6 deg, plain angle test alone
  });

  await t("floor-span refinement: real Venue 1 sequential edges already walkable", () => {
    const c0104 = { pos: { x: 32526.59, y: 34692.04, z: 66 }, floorZMin: 66, floorZMax: 66 };
    const c010c = { pos: { x: 32528.34, y: 34688.84, z: 69 } }; // no floor of its own
    const c0101 = { pos: { x: 32526.59, y: 34691.54, z: 69.5 }, floorZMin: 69.5, floorZMax: 69.5 };
    assert.equal(M.isDropEdge(c0104, c010c), false); // 39.4 deg
    assert.equal(M.isDropEdge(c010c, c0101), false); // 8.8 deg
  });

  await t("floor-span refinement: SHAFT_HORIZ_M rescued when a real floor span bridges it", () => {
    // Same 0x72000100 floor data (flat at world Z=6), but positioned dHoriz
    // < 1m from its shaft neighbor (the branch these two venues' REAL edges
    // don't currently trigger, per the regression pin above) — the stacked-
    // shaft trap the anchor fix alone can't resolve for a tight footprint.
    const stairLanding = { pos: { x: 100, y: 100, z: 0 }, floorZMin: 0, floorZMax: 6.2 };
    const shaftAbove = { pos: { x: 100.3, y: 100, z: 6 } }; // dHoriz=0.3, dZ=6
    assert.equal(M.isDropEdge(stairLanding, shaftAbove), false); // floor span covers [0,6]
  });

  await t("floor-span refinement: no override when floors don't actually bridge (real gap)", () => {
    // 0104 and 0101's REAL floor spans plugged into a hypothetical DIRECT
    // edge (no 010C hop): dHoriz=0.5 triggers SHAFT_HORIZ_M, but 66-66 and
    // 69.5-69.5 leave a real 3.5m gap neither cell's floor covers — must
    // stay a drop (the override must not overreach).
    const c0104 = { pos: { x: 32526.59, y: 34692.04, z: 66 }, floorZMin: 66, floorZMax: 66 };
    const c0101 = { pos: { x: 32526.59, y: 34691.54, z: 69.5 }, floorZMin: 69.5, floorZMax: 69.5 };
    assert.equal(M.isDropEdge(c0104, c0101), true); // dHoriz=0.5, gap unbridged
  });

  await t("floor-span refinement: true drop (no floor data anywhere) unaffected", () => {
    // 0x720002C4's real geometry: a pure-wall shaft, no floor triangles at
    // all. A neighbor one tier further up with the same shape (also no
    // floor) over a near-zero-dHoriz gap must remain a drop.
    const hub6 = { pos: { x: 21928, y: -40, z: 6 } };
    const hub12 = { pos: { x: 21928, y: -40, z: 12 } }; // dHoriz=0, dZ=6
    assert.equal(M.isDropEdge(hub6, hub12), true);
  });

  await t("floor-span refinement: nodes without the hint degrade to pure geometry (back-compat)", () => {
    // Plain {pos} fixtures (no floorZMin/Max at all, e.g. every pre-existing
    // synthetic graph in this file) must classify identically to before.
    const n = (x, y, z) => ({ pos: { x, y, z } });
    assert.equal(M.isDropEdge(n(0, 0, 0), n(0.5, 0, -3)), true); // shaft, no hint -> still a drop
  });

  // ── findPath ────────────────────────────────────────────────────────────
  await t("straight corridor", () => {
    const p = M.findPath(corridor, id(0x100), id(0x103));
    assert.deepEqual(p, [id(0x100), id(0x101), id(0x102), id(0x103)]);
  });

  await t("start == goal returns [start]", () => {
    assert.deepEqual(M.findPath(corridor, id(0x102), id(0x102)), [id(0x102)]);
  });

  await t("branch picks shorter arm", () => {
    const p = M.findPath(branch, id(0x100), id(0x105));
    assert.deepEqual(p, [id(0x100), id(0x101), id(0x105)]);
  });

  await t("hazard forces detour; hazardous goal still allowed", () => {
    const detour = M.findPath(branch, id(0x100), id(0x105), { hazards: new Set([id(0x101)]) });
    assert.deepEqual(detour, [id(0x100), id(0x102), id(0x103), id(0x104), id(0x105)]);
    const toHazard = M.findPath(branch, id(0x100), id(0x105), { hazards: new Set([id(0x105)]) });
    assert.deepEqual(toHazard, [id(0x100), id(0x101), id(0x105)]);
  });

  await t("drop edge pruned -> detour via ramp", () => {
    const p = M.findPath(dropg, id(0x110), id(0x111));
    assert.deepEqual(p, [id(0x110), id(0x112), id(0x111)]);
  });

  await t("drop-only route returns null (J3 limitation)", () => {
    assert.equal(M.findPath(dropg, id(0x110), id(0x113)), null);
  });

  // ── walkableOverrides escape hatch (2026-07-20, HANDOFF-wedge-closeout
  // Track E3/F deliverable #2): corpus-derived ground truth (e.g. confirmed
  // live on stream) can force a specific edge walkable regardless of what
  // isDropEdge says — the last-resort hatch for venues the classifier still
  // gets wrong. Canonical key = the same undirected `${min}:${max}` pairing
  // buildPatrolRoute's internal edgeKey uses (documented in findPath's opts).
  const ek = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);

  await t("findPath: walkableOverrides forces the direct drop edge open", () => {
    const direct = M.findPath(dropg, id(0x110), id(0x111), {
      walkableOverrides: new Set([ek(id(0x110), id(0x111))]),
    });
    assert.deepEqual(direct, [id(0x110), id(0x111)]);
  });

  await t("findPath: walkableOverrides is per-edge, not global (other drops still pruned)", () => {
    // Overriding 0x110-0x111 does NOT also open 0x111-0x113 (a separate
    // shaft edge) — X stays unreachable.
    const p = M.findPath(dropg, id(0x110), id(0x113), {
      walkableOverrides: new Set([ek(id(0x110), id(0x111))]),
    });
    assert.equal(p, null);
    // Overriding BOTH edges on the only path opens it end to end.
    const p2 = M.findPath(dropg, id(0x110), id(0x113), {
      walkableOverrides: new Set([ek(id(0x110), id(0x111)), ek(id(0x111), id(0x113))]),
    });
    assert.deepEqual(p2, [id(0x110), id(0x111), id(0x113)]);
  });

  await t("findPath: bogus/empty walkableOverrides is inert (behaves like no override)", () => {
    const p = M.findPath(dropg, id(0x110), id(0x111), { walkableOverrides: new Set() });
    assert.deepEqual(p, [id(0x110), id(0x112), id(0x111)]); // unchanged detour
  });

  await t("getMainRouteNodes: walkableOverrides pulls the drop-gated cell into reachability", () => {
    const withoutOverride = M.getMainRouteNodes(dropg, id(0x110));
    assert.equal(withoutOverride.has(id(0x113)), false); // baseline: behind a drop
    const withOverride = M.getMainRouteNodes(dropg, id(0x110), null, {
      walkableOverrides: new Set([ek(id(0x111), id(0x113))]),
    });
    assert.equal(withOverride.has(id(0x113)), true);
  });

  await t("buildPatrolRoute: walkableOverrides adds the freed edge to the patrol walk", () => {
    const walk = M.buildPatrolRoute(dropg, id(0x110), null, {
      walkableOverrides: new Set([ek(id(0x111), id(0x113))]),
    });
    assert.ok(walk.includes(id(0x113)), JSON.stringify(walk));
    assert.equal(walk[0], id(0x110));
    assert.equal(walk[walk.length - 1], id(0x110)); // still closes back home
  });

  await t("findExitPath: walkableOverrides lets an exit hide behind a drop", () => {
    const withExit = mk({
      0x120: [0, 0, 0, [0x121]],
      0x121: [4, 0, -8, [0x120]], // drop below A; 0x121 has the only exit
    });
    withExit[id(0x121)].exits = [(LB | 0x0005) >>> 0]; // direct outdoor LandCell
    assert.equal(M.findExitPath(withExit, id(0x120)), null); // exit unreachable, drop-gated
    const rescued = M.findExitPath(withExit, id(0x120), {
      walkableOverrides: new Set([ek(id(0x120), id(0x121))]),
    });
    assert.ok(rescued && rescued.exitCell === id(0x121), JSON.stringify(rescued));
  });

  await t("findExitPath: excludeEdges re-routes to the NEXT-nearest exit (egress ladder)", () => {
    // Two exits: a near one behind edge A-B (the tavern serving-window class —
    // a portal record that is not walkable at floor level), and a farther one
    // via A-C-D. Excluding A-B must fall through to the D exit; excluding the
    // whole frontier returns null (honest unreachable).
    const g = mk({
      0x130: [0, 0, 0, [0x131, 0x132]],
      0x131: [4, 0, 0, [0x130]], // near exit, 1 hop
      0x132: [0, 4, 0, [0x130, 0x133]],
      0x133: [0, 8, 0, [0x132]], // far exit, 2 hops
    });
    g[id(0x131)].exits = [(LB | 0x0005) >>> 0];
    g[id(0x133)].exits = [(LB | 0x0009) >>> 0];
    const near = M.findExitPath(g, id(0x130));
    assert.ok(near && near.exitCell === id(0x131), JSON.stringify(near));
    const rerouted = M.findExitPath(g, id(0x130), { excludeEdges: new Set([ek(id(0x130), id(0x131))]) });
    assert.ok(rerouted && rerouted.exitCell === id(0x133), JSON.stringify(rerouted));
    assert.deepEqual(rerouted.path, [id(0x130), id(0x132), id(0x133)]);
    const none = M.findExitPath(g, id(0x130), {
      excludeEdges: new Set([ek(id(0x130), id(0x131)), ek(id(0x130), id(0x132))]),
    });
    assert.equal(none, null);
  });

  await t("unreachable / missing endpoints return null", () => {
    assert.equal(M.findPath(split, id(0x100), id(0x121)), null);
    assert.equal(M.findPath(split, id(0x100), id(0x1ff)), null); // goal not in graph
    assert.equal(M.findPath(split, id(0x1ff), id(0x100)), null); // start not in graph
  });

  // ── nearestCell ─────────────────────────────────────────────────────────
  await t("nearestCell prefers same-floor band", () => {
    const stacked = mk({
      0x100: [0, 0, 0, []],
      0x101: [1, 0, -20, []], // slightly farther 2D, 20m below
    });
    assert.equal(M.nearestCell(stacked, X0, Y0), id(0x100)); // no z: 2D nearest
    assert.equal(M.nearestCell(stacked, X0, Y0, -19), id(0x101)); // z band wins
  });

  // ── toLegs ──────────────────────────────────────────────────────────────
  await t("toLegs: full EnvCell id + landblock-local positions", () => {
    const legs = M.toLegs(corridor, [id(0x100), id(0x101), id(0x102), id(0x103)]);
    assert.equal(legs.length, 4);
    legs.forEach((l, i) => {
      assert.equal(l.lb, id(0x100 + i)); // lb IS the objCellId
      assert.equal(l.x, i * 10); // world -> lb-local (wx - lbX*192)
      assert.equal(l.y, 0);
      assert.equal(l.z, 5);
    });
  });

  await t("toLegs midpoints option interleaves doorway midpoints", () => {
    const legs = M.toLegs(corridor, [id(0x100), id(0x101)], { midpoints: true });
    assert.equal(legs.length, 3); // center A, midpoint(A,B), center B
    assert.equal(legs[1].lb, id(0x101)); // stamped with destination cell
    assert.equal(legs[1].x, 5);
  });

  // ── 2-core patrol prune ─────────────────────────────────────────────────
  await t("2-core prune drops dead-end spur, keeps ring", () => {
    const main = M.getMainRouteNodes(ringSpur, id(0x100));
    assert.equal(main.size, 8);
    for (let i = 0; i < 8; i++) assert.equal(main.has(id(0x100 + i)), true);
    for (const s of [0x110, 0x111, 0x112]) assert.equal(main.has(id(s)), false);
  });

  await t("2-core prune small-graph fallback keeps full reachable set", () => {
    const main = M.getMainRouteNodes(smallRing, id(0x100));
    assert.equal(main.size, 5); // pruned core (4) < 8 -> fallback incl. spur
    assert.equal(main.has(id(0x110)), true);
  });

  await t("2-core prune respects drop edges + hazards in reachability", () => {
    const main = M.getMainRouteNodes(dropg, id(0x110));
    assert.equal(main.has(id(0x113)), false); // behind a drop, never reachable
    const hz = M.getMainRouteNodes(branch, id(0x100), new Set([id(0x102)]));
    assert.equal(hz.has(id(0x102)), false);
  });

  // ── Euler closed-walk patrol ────────────────────────────────────────────
  const edgeCounts = (walk) => {
    const c = new Map();
    for (let i = 0; i + 1 < walk.length; i++) {
      const k = walk[i] < walk[i + 1] ? `${walk[i]}:${walk[i + 1]}` : `${walk[i + 1]}:${walk[i]}`;
      c.set(k, (c.get(k) || 0) + 1);
    }
    return c;
  };

  await t("patrol on ring covers every corridor exactly once and closes", () => {
    const walk = M.buildPatrolRoute(ringSpur, id(0x100));
    assert.equal(walk.length, 9); // pure cycle: 8 edges + return to start
    assert.equal(walk[0], id(0x100));
    assert.equal(walk[walk.length - 1], id(0x100));
    const counts = edgeCounts(walk);
    assert.equal(counts.size, 8);
    for (const n of counts.values()) assert.equal(n, 1); // no backtracking on a loop
    for (const s of [0x110, 0x111, 0x112]) assert.equal(walk.includes(id(s)), false);
  });

  await t("patrol fallback graph covers all edges (dead-end retread) and closes", () => {
    const walk = M.buildPatrolRoute(smallRing, id(0x100));
    assert.equal(walk[0], id(0x100));
    assert.equal(walk[walk.length - 1], id(0x100));
    const counts = edgeCounts(walk);
    assert.equal(counts.size, 5); // 4 ring edges + spur edge all visited
  });

  await t("patrol with no walkable edges returns []", () => {
    const lone = mk({ 0x100: [0, 0, 0, []] });
    assert.deepEqual(M.buildPatrolRoute(lone, id(0x100)), []);
  });

  await t("patrol legs feed toLegs", () => {
    const walk = M.buildPatrolRoute(ringSpur, id(0x100));
    const legs = M.toLegs(ringSpur, walk);
    assert.equal(legs.length, walk.length);
    for (const l of legs) {
      assert.equal(typeof l.lb, "number");
      assert.equal(typeof l.x, "number");
      assert.ok(Math.abs(l.x) < 192 && Math.abs(l.y) < 192); // lb-local range
    }
  });

  // ── buildGraphFromWasm guards + mock happy path ─────────────────────────
  await t("buildGraphFromWasm degrades to null off-wasm", async () => {
    assert.equal(await M.buildGraphFromWasm(null), null);
    assert.equal(await M.buildGraphFromWasm({}), null); // no getCurrentCellId
    assert.equal(await M.buildGraphFromWasm({ getCurrentCellId: () => 0 }), null); // pre-spawn
    assert.equal(
      await M.buildGraphFromWasm({ getCurrentCellId: () => (LB | 0xfffe) >>> 0 }),
      null // outdoors
    );
    assert.equal(
      await M.buildGraphFromWasm({ getCurrentCellId: () => id(0x100) }),
      null // indoor but no fetchEnvCells export anywhere
    );
    assert.equal(
      await M.buildGraphFromWasm(
        { getCurrentCellId: () => id(0x100) },
        0,
        {
          fetchEnvCells: async () => {
            throw new Error("wasm trap");
          },
        }
      ),
      null // fetch failure swallowed
    );
  });

  // Mock EnvCellPlacement objects (shape per lib.rs:15939-15977): getters +
  // one-shot takePortalCellIds returning a Uint32Array with sentinel/self junk.
  function mockPlacement(lo, x, y, z, nbLos, freed) {
    let taken = false;
    return {
      cellId: id(lo),
      cellOriginX: X0 + x,
      cellOriginY: Y0 + y,
      cellOriginZ: z,
      takePortalCellIds() {
        if (taken) return new Uint32Array(0); // move semantics (lib.rs:15966)
        taken = true;
        return Uint32Array.from([...nbLos.map((n) => id(n)), (LB | 0xffff) >>> 0, id(lo)]);
      },
      free() {
        freed.push(lo);
      },
    };
  }

  await t("buildGraphFromWasm mock: filters sentinels/self, frees placements", async () => {
    const freed = [];
    const handle = { getCurrentCellId: () => id(0x100) };
    const g = await M.buildGraphFromWasm(handle, 0, {
      fetchEnvCells: async (lbId) => {
        assert.equal(lbId >>> 0, LB); // asked for the current cell's landblock
        return [
          mockPlacement(0x100, 0, 0, 5, [0x101], freed),
          mockPlacement(0x101, 10, 0, 5, [0x100, 0x102], freed),
          mockPlacement(0x102, 20, 0, 5, [0x101], freed),
        ];
      },
    });
    assert.ok(g instanceof Map);
    assert.equal(g.size, 3);
    const n = g.get(id(0x101));
    assert.deepEqual(n.pos, { x: X0 + 10, y: Y0, z: 5 });
    assert.deepEqual(n.neighbors, [id(0x100), id(0x102)]); // sentinel + self dropped
    assert.deepEqual(freed.sort(), [0x100, 0x101, 0x102]); // wasm objects freed
    // and the built graph routes end-to-end:
    assert.deepEqual(M.findPath(g, id(0x100), id(0x102)), [id(0x100), id(0x101), id(0x102)]);
  });

  // ── floor-span wiring: takeMesh() -> collectLandblockIntoGraph -> node
  // .floorZMin/floorZMax -> isDropEdge override, end to end through
  // buildGraphFromWasm. Mesh fixtures reproduce the REAL aggregate geometry
  // dumped for 0x72000100 (2 floor tris flat at local z=6, of 6 total) and
  // 0x720002C4 (4 wall tris, 0 floor) — same bbox/triCount/floorTriCount/
  // floorZMin/Max cited in the floor-span refinement block above; only the
  // individual vertex/normal arrays are synthesized (the live probe reported
  // aggregates, not raw arrays) to reproduce those exact aggregates.
  function flatFloorTri(z, x0, y0, x1, y1) {
    // One up-facing (normal (0,0,1)) triangle of a horizontal quad at local z.
    return { positions: [x0, y0, z, x1, y0, z, x1, y1, z], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1] };
  }
  function wallTri(nx, ny, x, y0, y1, z0, z1) {
    // One vertical-normal triangle — never counts as floor (FLOOR_Z gate).
    return { positions: [x, y0, z0, x, y1, z0, x, y0, z1], normals: [nx, ny, 0, nx, ny, 0, nx, ny, 0] };
  }
  function mkMesh(bboxArr, tris) {
    const positions = [], normals = [];
    for (const tr of tris) {
      positions.push(...tr.positions);
      normals.push(...tr.normals);
    }
    return {
      bbox: Float32Array.from(bboxArr),
      positions: Float32Array.from(positions),
      normals: Float32Array.from(normals),
      free() {},
    };
  }
  // Real dump: 0x72000100 bbox [1.9667,-1.9667,4.6194, 5,1.9667,6], 6 tris
  // (2 floor @ world Z=6, 4 wall), origin (world) x=21928 y=-40 z=0.
  const APT_BBOX = [1.9667, -1.9667, 4.6194, 5, 1.9667, 6];
  const aptMesh = () =>
    mkMesh(APT_BBOX, [
      flatFloorTri(6, 2, -1.9667, 5, 1.9667),
      flatFloorTri(6, 2, -1.9667, 5, 1.9667),
      wallTri(1, 0, 5, -1.9667, 1.9667, 4.6194, 6),
      wallTri(-1, 0, 1.9667, -1.9667, 1.9667, 4.6194, 6),
      wallTri(0, 1, 3, -1.9667, 1.9667, 4.6194, 6),
      wallTri(0, -1, 3, -1.9667, 1.9667, 4.6194, 6),
    ]);
  // Real dump: 0x720002C4 bbox [-5,-5,0, 5,5,6], 4 tris, ALL wall (0 floor).
  const HUB_BBOX = [-5, -5, 0, 5, 5, 6];
  const hubMesh = () =>
    mkMesh(HUB_BBOX, [
      wallTri(1, 0, 5, -5, 5, 0, 6),
      wallTri(-1, 0, -5, -5, 5, 0, 6),
      wallTri(0, 1, 0, -5, 5, 0, 6),
      wallTri(0, -1, 0, -5, 5, 0, 6),
    ]);

  await t("buildGraphFromWasm wires floorZMin/floorZMax from the real Venue 2 mesh shapes", async () => {
    const freed = [];
    const APT = id(0x100), HUB = id(0x2c4);
    const handle = { getCurrentCellId: () => APT };
    const g = await M.buildGraphFromWasm(handle, 0, {
      fetchEnvCells: async () => [
        {
          cellId: APT, cellOriginX: X0 + 40, cellOriginY: Y0 - 40, cellOriginZ: 0,
          cellOrientationQw: 1, cellOrientationQx: 0, cellOrientationQy: 0, cellOrientationQz: 0,
          takeMesh: () => aptMesh(),
          takePortalCellIds: () => Uint32Array.from([HUB]),
          free: () => freed.push("apt"),
        },
        {
          cellId: HUB, cellOriginX: X0 + 40, cellOriginY: Y0 - 40, cellOriginZ: 6,
          cellOrientationQw: 1, cellOrientationQx: 0, cellOrientationQy: 0, cellOrientationQz: 0,
          takeMesh: () => hubMesh(),
          takePortalCellIds: () => Uint32Array.from([APT]),
          free: () => freed.push("hub"),
        },
      ],
    });
    const aptNode = g.get(APT), hubNode = g.get(HUB);
    assert.equal(aptNode.floorZMin, 6); // matches the real dump exactly
    assert.equal(aptNode.floorZMax, 6);
    assert.equal(hubNode.floorZMin, undefined); // no floor tris -> no hint
    assert.equal(hubNode.floorZMax, undefined);
    assert.deepEqual(freed.sort(), ["apt", "hub"]);
    // And the wiring is live in isDropEdge/findPath (not just stored data):
    const p = M.findPath(g, APT, HUB);
    assert.ok(p && p.length === 2, JSON.stringify(p));
  });

  await t("buildGraphFromWasm floor-span rescues a forced SHAFT_HORIZ_M edge end-to-end", async () => {
    // A stacked stair-shaft cell: same real 0x72000100 footprint (bbox
    // dimensions), but modeled with flat treads at BOTH its own bbox-min Z
    // (4.6194, matching the real dump) AND the neighbor's Z (6) — a graduated
    // stair floor is exactly a series of flat horizontal treads, so this is
    // a realistic (if synthesized, since the live probe gave aggregates not
    // raw vertices) stand-in for "the real mesh had more tread tris than the
    // 0x100 probe's 2, spanning the full rise." Origin chosen so the bbox
    // anchor lands dHoriz < 1m from the shaft above it — the SHAFT_HORIZ_M
    // branch these two flagged venues' REAL edges don't happen to trigger
    // post-bbox-fix (see the regression pin above), but a tighter real
    // stairwell footprint elsewhere plausibly would.
    const stairMesh = () =>
      mkMesh(APT_BBOX, [
        flatFloorTri(4.6194, 2, -1.9667, 5, 1.9667),
        flatFloorTri(6, 2, -1.9667, 5, 1.9667),
        wallTri(1, 0, 5, -1.9667, 1.9667, 4.6194, 6),
        wallTri(-1, 0, 1.9667, -1.9667, 1.9667, 4.6194, 6),
      ]);
    const LO = id(0x300), HI = id(0x301);
    const handle = { getCurrentCellId: () => LO };
    const g = await M.buildGraphFromWasm(handle, 0, {
      fetchEnvCells: async () => [
        {
          cellId: LO, cellOriginX: X0, cellOriginY: Y0, cellOriginZ: 0,
          cellOrientationQw: 1, cellOrientationQx: 0, cellOrientationQy: 0, cellOrientationQz: 0,
          takeMesh: () => stairMesh(),
          takePortalCellIds: () => Uint32Array.from([HI]),
          free() {},
        },
        {
          // origin chosen so the anchor (bbox center = origin, symmetric hub
          // shape) lands dHoriz < 1m from LO's anchor (~x0+3.48).
          cellId: HI, cellOriginX: X0 + 3.7, cellOriginY: Y0, cellOriginZ: 6,
          cellOrientationQw: 1, cellOrientationQx: 0, cellOrientationQy: 0, cellOrientationQz: 0,
          takeMesh: () => hubMesh(),
          takePortalCellIds: () => Uint32Array.from([LO]),
          free() {},
        },
      ],
    });
    const loNode = g.get(LO), hiNode = g.get(HI);
    const dHoriz = Math.hypot(loNode.pos.x - hiNode.pos.x, loNode.pos.y - hiNode.pos.y);
    assert.ok(dHoriz < 1.0, `fixture must land in the SHAFT_HORIZ_M branch (dHoriz=${dHoriz})`);
    assert.ok(Math.abs(loNode.floorZMin - 4.6194) < 1e-3, loNode.floorZMin); // treads span the full rise (Float32 round-trip)
    assert.equal(loNode.floorZMax, 6);
    assert.equal(M.isDropEdge(loNode, hiNode), false); // rescued: floor bridges the gap
    assert.deepEqual(M.findPath(g, LO, HI), [LO, HI]); // and A* takes the direct edge
  });

  await t("buildGraphFromWasm floor-span leaves a genuine SHAFT_HORIZ_M drop pruned", async () => {
    // Same forced-close-anchor setup, but LO's real (non-stair) mesh — floor
    // flat at z=6 only, matching the actual 0x72000100 dump — does NOT reach
    // down to LO's own cell-center (4.6194), so the gap stays unbridged.
    const LO = id(0x310), HI = id(0x311);
    const handle = { getCurrentCellId: () => LO };
    const g = await M.buildGraphFromWasm(handle, 0, {
      fetchEnvCells: async () => [
        {
          cellId: LO, cellOriginX: X0, cellOriginY: Y0, cellOriginZ: 0,
          cellOrientationQw: 1, cellOrientationQx: 0, cellOrientationQy: 0, cellOrientationQz: 0,
          takeMesh: () => aptMesh(), // real dump: floor flat at z=6 only
          takePortalCellIds: () => Uint32Array.from([HI]),
          free() {},
        },
        {
          cellId: HI, cellOriginX: X0 + 3.7, cellOriginY: Y0, cellOriginZ: 6,
          cellOrientationQw: 1, cellOrientationQx: 0, cellOrientationQy: 0, cellOrientationQz: 0,
          takeMesh: () => hubMesh(),
          takePortalCellIds: () => Uint32Array.from([LO]),
          free() {},
        },
      ],
    });
    const loNode = g.get(LO), hiNode = g.get(HI);
    const dHoriz = Math.hypot(loNode.pos.x - hiNode.pos.x, loNode.pos.y - hiNode.pos.y);
    assert.ok(dHoriz < 1.0, `fixture must land in the SHAFT_HORIZ_M branch (dHoriz=${dHoriz})`);
    assert.equal(M.isDropEdge(loNode, hiNode), true); // NOT rescued: floor doesn't reach LO's own level
    assert.equal(M.findPath(g, LO, HI), null); // J3: no jump primitive, drop-only route is unreachable
  });

  await t("buildGraphFromWasm depth bounds the graph (JS-side BFS radius)", async () => {
    const freed = [];
    const handle = { getCurrentCellId: () => id(0x100) };
    const fetchEnvCells = async () => [
      mockPlacement(0x100, 0, 0, 0, [0x101], freed),
      mockPlacement(0x101, 10, 0, 0, [0x100, 0x102], freed),
      mockPlacement(0x102, 20, 0, 0, [0x101, 0x103], freed),
      mockPlacement(0x103, 30, 0, 0, [0x102], freed),
    ];
    const g1 = await M.buildGraphFromWasm(handle, 1, { fetchEnvCells });
    assert.deepEqual([...g1.keys()].sort(), [id(0x100), id(0x101)].sort());
    const g0 = await M.buildGraphFromWasm(handle, 0, { fetchEnvCells });
    assert.equal(g0.size, 4); // depth 0 = whole landblock
  });

  // ── buildStitchedGraphFromWasm: cross-LB stitching (2026-07-18) ──────────
  // Second landblock one block east; seam portal records reference full
  // 32-bit ids across the boundary (lib.rs:15970-15977), so the merged graph
  // routes through the seam with no synthetic edges.
  const LB2 = 0x02a90000;
  const id2 = (lo) => (LB2 | lo) >>> 0;
  function mockPlacementAt(cellId, wx, wy, z, nbIds, freed) {
    let taken = false;
    return {
      cellId,
      cellOriginX: wx,
      cellOriginY: wy,
      cellOriginZ: z,
      takePortalCellIds() {
        if (taken) return new Uint32Array(0);
        taken = true;
        return Uint32Array.from(nbIds);
      },
      free() {
        freed.push(cellId >>> 0);
      },
    };
  }
  const twoLbFetch = (freed, calls) => async (lbId) => {
    calls.push(lbId >>> 0);
    if ((lbId >>> 0) === LB)
      return [
        mockPlacementAt(id(0x100), X0 + 180, Y0 + 50, 0, [id(0x101)], freed),
        mockPlacementAt(id(0x101), X0 + 190, Y0 + 50, 0, [id(0x100), id2(0x100)], freed),
      ];
    if ((lbId >>> 0) === LB2)
      return [
        mockPlacementAt(id2(0x100), X0 + 202, Y0 + 50, 0, [id(0x101), id2(0x101)], freed),
        mockPlacementAt(id2(0x101), X0 + 212, Y0 + 50, 0, [id2(0x100)], freed),
      ];
    return [];
  };

  await t("stitched graph merges two landblocks and routes across the seam", async () => {
    const freed = [];
    const calls = [];
    const g = await M.buildStitchedGraphFromWasm([id(0x100), id2(0x101)], {
      fetchEnvCells: twoLbFetch(freed, calls),
    });
    assert.ok(g instanceof Map);
    assert.equal(g.size, 4);
    assert.deepEqual(
      M.findPath(g, id(0x100), id2(0x101)),
      [id(0x100), id(0x101), id2(0x100), id2(0x101)]
    );
    assert.equal(freed.length, 4); // wasm placements freed on every path
  });

  await t("stitched graph expand chases seam references from ONE seed lb", async () => {
    const freed = [];
    const calls = [];
    // Seed with only the player's landblock; the 0x101 -> LB2 portal record
    // must pull LB2 in via expansion.
    const g = await M.buildStitchedGraphFromWasm([id(0x100)], {
      fetchEnvCells: twoLbFetch(freed, calls),
    });
    assert.deepEqual(calls.sort(), [LB, LB2].sort());
    assert.equal(g.size, 4);
    assert.ok(M.findPath(g, id(0x100), id2(0x101)));
  });

  await t("stitched graph expand:false stays single-lb; maxLandblocks caps", async () => {
    const g1 = await M.buildStitchedGraphFromWasm([id(0x100)], {
      fetchEnvCells: twoLbFetch([], []),
      expand: false,
    });
    assert.equal(g1.size, 2); // LB only; seam neighbor dangles (skipped by A*)
    const calls = [];
    const g2 = await M.buildStitchedGraphFromWasm([id(0x100)], {
      fetchEnvCells: twoLbFetch([], calls),
      maxLandblocks: 1,
    });
    assert.equal(calls.length, 1);
    assert.equal(g2.size, 2);
  });

  await t("stitched graph degrades to null (no lbs, no fetch, fetch throws)", async () => {
    assert.equal(await M.buildStitchedGraphFromWasm([], { fetchEnvCells: async () => [] }), null);
    assert.equal(await M.buildStitchedGraphFromWasm([id(0x100)]), null); // no fetchEnvCells anywhere
    assert.equal(
      await M.buildStitchedGraphFromWasm([id(0x100)], {
        fetchEnvCells: async () => {
          throw new Error("wasm trap");
        },
      }),
      null
    );
  });

  console.log(`\nindoorsim: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(`ERR ${e.stack || e.message}`);
  process.exit(1);
});
