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

  console.log(`\nindoorsim: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(`ERR ${e.stack || e.message}`);
  process.exit(1);
});
