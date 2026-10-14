// tests/film_scene_los.test.mjs
//
// WHY: AC Film Mode's perception, safety clamp and scout all ask ONE question
// many times per second — "is this segment blocked, and by what?" — through
// scene3d/film/scene/los.js `segmentBlocked(sh, …)`. The wasm collision layers
// it chains have sharp edges that silently produce wrong answers or leaks:
// building triangles are indexed per landblock and statics/scenery only scan
// the 3×3 ring around the landblock passed (an unchunked long segment passes
// through trees two landblocks away), every CollisionHit is a wasm box that
// must be copied and then freed, a stale pkg/ may lack a method, a t ≈ 0 hit
// means an embedded start, and the subject must never occlude itself. This
// suite EXECUTES the real module against fake session handles whose sweeps
// return fake CollisionHit boxes (getters throw after free(), free() is a
// spy) and proves:
//   L1  kindForLayer: every layer → tree|rock|wall|building|prop|door|creature|terrain,
//       wasm method names / aliases, extra.kind override, scenery rock-vs-tree
//       by normal, indoor building mesh = wall;
//   L2  segmentChunks: per-landblock split, ≤ 192 m chunks, contiguous t, lbKeys,
//       vertical runs subdivided, degenerate inputs;
//   L3  chunking: a 500 m segment crossing 3 landblocks calls the building sweep
//       once per landblock with that landblock's key and the chunk's endpoints,
//       and finds a tree two landblocks away that one unchunked call misses;
//   L4  every CollisionHit is freed exactly once (kept, ignored, later-than-best,
//       embedded) and fields are copied before free;
//   L5  earliest hit wins across layers and chunks, chunk-local t → segment t,
//       point/normal/kind attribution, chunks after the best hit are skipped;
//   L6  subjectGuid is passed as missile_guid to sweepSphereAgainstObjects
//       (exemptLocalPlayer default true), entity range = chunk length + 5 m,
//       cell layers get the cell ids as a Uint32Array;
//   L7  missing / throwing methods are tolerated; sh null → terrain only;
//   L8  the embedded-start rule (projectileHitStops): moving away ignored,
//       moving into the surface blocks at t = 0;
//   L9  terrain via an injected terrainZAt (projectileTerrainCrossing): ridge
//       crossing point + normal, throwing terrainZAt tolerated, no terrainZAt →
//       no terrain layer, terrain earlier than wasm hits wins;
//   L10 the layers option, unknown layer names (FilmError), non-finite and
//       zero-length segments.
//
// Flag: filmMode (DEFAULT OFF, `?filmMode=on`) — los.js is one of its pure scene modules.
// Run from apps/holtburger-web/: node tests/film_scene_los.test.mjs

import assert from "node:assert/strict";

const LOS = await import("../scene3d/film/scene/los.js");
const { FilmError } = await import("../scene3d/film/core/errors.js");
const PS = await import("../scene3d/projectile_sweep.js");

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
  assert.equal(a.length, b.length, `${msg ?? "vec"} length`);
  for (let i = 0; i < a.length; i++) near(a[i], b[i], eps, `${msg ?? "vec"}[${i}]`);
}

const LB = (x, y) => (((x & 0xff) << 24) | ((y & 0xff) << 16)) >>> 0;

// ---------------------------------------------------------------------------
// Fake wasm CollisionHit: fields readable until free(); free() counted.
// ---------------------------------------------------------------------------
const ALL_HITS = [];
class FakeHit {
  constructor(t, p, n) {
    this._d = { t, x: p[0], y: p[1], z: p[2], normalX: n[0], normalY: n[1], normalZ: n[2] };
    this.freed = 0;
    ALL_HITS.push(this);
  }
  _get(k) {
    if (this.freed) throw new Error(`CollisionHit.${k} read after free()`);
    return this._d[k];
  }
  get t() { return this._get("t"); }
  get x() { return this._get("x"); }
  get y() { return this._get("y"); }
  get z() { return this._get("z"); }
  get normalX() { return this._get("normalX"); }
  get normalY() { return this._get("normalY"); }
  get normalZ() { return this._get("normalZ"); }
  free() {
    if (this.freed) throw new Error("double free");
    this.freed += 1;
  }
}

/**
 * Analytic sphere(R) sweep p0→p1 against a sphere obstacle (c, r): the first
 * contact s in [0,1] (0 when the start already overlaps), contact point on the
 * obstacle surface, normal from the obstacle centre toward the swept centre.
 */
function sphereSweep(p0, p1, R, c, r) {
  const d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const m = [p0[0] - c[0], p0[1] - c[1], p0[2] - c[2]];
  const rr = R + r;
  const A = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const B = 2 * (m[0] * d[0] + m[1] * d[1] + m[2] * d[2]);
  const C = m[0] * m[0] + m[1] * m[1] + m[2] * m[2] - rr * rr;
  let s;
  if (C <= 0) s = 0;
  else {
    const disc = B * B - 4 * A * C;
    if (disc < 0 || A === 0) return null;
    s = (-B - Math.sqrt(disc)) / (2 * A);
    if (s < 0 || s > 1) return null;
  }
  const q = [p0[0] + d[0] * s, p0[1] + d[1] * s, p0[2] + d[2] * s];
  const nv = [q[0] - c[0], q[1] - c[1], q[2] - c[2]];
  const nl = Math.hypot(nv[0], nv[1], nv[2]) || 1;
  const n = [nv[0] / nl, nv[1] / nl, nv[2] / nl];
  return new FakeHit(s, [c[0] + n[0] * r, c[1] + n[1] * r, c[2] + n[2] * r], n);
}

const lbOf = (x, y) => LB(Math.floor(x / 192), Math.floor(y / 192));
const inRing = (lbKey, x, y) => {
  const ox = (lbKey >>> 24) & 0xff, oy = (lbKey >>> 16) & 0xff;
  return Math.abs(Math.floor(x / 192) - ox) <= 1 && Math.abs(Math.floor(y / 192) - oy) <= 1;
};

/**
 * A fake SessionHandle with geometric sweeps. `world` = list of
 * {layer, c, r, guid?, cells?}; building obstacles only answer for their OWN
 * landblock, statics/scenery for the 3×3 ring around the lb passed (exactly the
 * wasm contract), cell layers for listed cells, objects skip missile_guid.
 * Every call is recorded in `calls[method]`.
 */
function geoSh(world, { omit = [] } = {}) {
  const calls = {};
  const rec = (name, args) => (calls[name] ||= []).push(args);
  const best = (hits) => {
    let b = null;
    for (const h of hits) {
      if (!h) continue;
      if (!b || h._d.t < b._d.t) {
        if (b) b.free();
        b = h;
      } else h.free();
    }
    return b ?? undefined;
  };
  const sweepList = (fx, fy, fz, tx, ty, tz, R, filter) =>
    best(world.filter(filter).map((o) => sphereSweep([fx, fy, fz], [tx, ty, tz], R, o.c, o.r)));
  const sh = {
    calls,
    sweepSphereAgainstBuildingMesh(fx, fy, fz, tx, ty, tz, R, lb) {
      rec("building", [fx, fy, fz, tx, ty, tz, R, lb]);
      return sweepList(fx, fy, fz, tx, ty, tz, R, (o) => o.layer === "buildingMesh" && lbOf(o.c[0], o.c[1]) === lb);
    },
    sweepSphereAgainstStatics(fx, fy, fz, tx, ty, tz, R, lb) {
      rec("statics", [fx, fy, fz, tx, ty, tz, R, lb]);
      return sweepList(fx, fy, fz, tx, ty, tz, R, (o) => o.layer === "statics" && inRing(lb, o.c[0], o.c[1]));
    },
    sweepSphereAgainstScenery(fx, fy, fz, tx, ty, tz, R, lb) {
      rec("scenery", [fx, fy, fz, tx, ty, tz, R, lb]);
      return sweepList(fx, fy, fz, tx, ty, tz, R, (o) => o.layer === "scenery" && inRing(lb, o.c[0], o.c[1]));
    },
    sweepSphereAgainstCellMesh(fx, fy, fz, tx, ty, tz, R, cells) {
      rec("cellMesh", [fx, fy, fz, tx, ty, tz, R, cells]);
      return sweepList(fx, fy, fz, tx, ty, tz, R, (o) => o.layer === "cellMesh" && cells.includes(o.cell));
    },
    sweepSphereAgainstCellStatics(fx, fy, fz, tx, ty, tz, R, cells) {
      rec("cellStatics", [fx, fy, fz, tx, ty, tz, R, cells]);
      return sweepList(fx, fy, fz, tx, ty, tz, R, (o) => o.layer === "cellStatics" && cells.includes(o.cell));
    },
    sweepSphereAgainstEntities(fx, fy, fz, tx, ty, tz, R, range) {
      rec("entities", [fx, fy, fz, tx, ty, tz, R, range]);
      return sweepList(fx, fy, fz, tx, ty, tz, R,
        (o) => o.layer === "entities" && Math.hypot(o.c[0] - fx, o.c[1] - fy, o.c[2] - fz) < range);
    },
    sweepSphereAgainstObjects(fx, fy, fz, tx, ty, tz, R, missileGuid, exempt) {
      rec("objects", [fx, fy, fz, tx, ty, tz, R, missileGuid, exempt]);
      return sweepList(fx, fy, fz, tx, ty, tz, R, (o) => o.layer === "objects" && o.guid !== missileGuid);
    },
  };
  for (const m of omit) delete sh[m];
  return sh;
}

/** A fake sh whose every method returns the scripted hit factory result for its layer. */
function scriptSh(script) {
  const calls = [];
  const sh = { calls };
  for (const [layer, method] of Object.entries(LOS.LOS_LAYER_METHODS)) {
    sh[method] = (...args) => {
      calls.push({ layer, args });
      const f = script[layer];
      return f ? f(args, calls.filter((c) => c.layer === layer).length - 1) : undefined;
    };
  }
  return sh;
}

// ---------------------------------------------------------------------------
// L1 kindForLayer
// ---------------------------------------------------------------------------
check("L1 kindForLayer: every layer maps to a SPEC kind", () => {
  assert.deepEqual([...LOS.LOS_KINDS].sort(), ["building", "creature", "door", "prop", "rock", "terrain", "tree", "wall"]);
  assert.equal(LOS.kindForLayer("terrain"), "terrain");
  assert.equal(LOS.kindForLayer("buildingMesh"), "building");
  assert.equal(LOS.kindForLayer("buildingMesh", { indoor: true }), "wall");
  assert.equal(LOS.kindForLayer("statics"), "prop");
  assert.equal(LOS.kindForLayer("scenery"), "tree");
  assert.equal(LOS.kindForLayer("scenery", { normal: [0.2, 0.1, 0.9] }), "rock");
  assert.equal(LOS.kindForLayer("scenery", { normal: { x: 1, y: 0, z: 0.1 } }), "tree");
  assert.equal(LOS.kindForLayer("cellMesh"), "wall");
  assert.equal(LOS.kindForLayer("cellStatics"), "prop");
  assert.equal(LOS.kindForLayer("entities"), "door");
  assert.equal(LOS.kindForLayer("objects"), "creature");
  assert.equal(LOS.kindForLayer("nonsense"), "prop");
  assert.equal(LOS.kindForLayer(undefined, null), "prop");
  for (const layer of LOS.LOS_LAYER_NAMES) assert.ok(LOS.LOS_KINDS.includes(LOS.kindForLayer(layer)), layer);
});

check("L1 kindForLayer: wasm method names, aliases and extra.kind", () => {
  assert.equal(LOS.kindForLayer("sweepSphereAgainstScenery"), "tree");
  assert.equal(LOS.kindForLayer("sweepSphereAgainstEntities"), "door");
  assert.equal(LOS.kindForLayer("sweepSphereAgainstCellMesh"), "wall");
  assert.equal(LOS.kindForLayer("building"), "building");
  assert.equal(LOS.kindForLayer("doors"), "door");
  assert.equal(LOS.kindForLayer("scenery", { kind: "boulder" }), "rock");
  assert.equal(LOS.kindForLayer("objects", { kind: "player" }), "creature");
  assert.equal(LOS.kindForLayer("statics", { kind: "Furniture" }), "prop");
  assert.equal(LOS.kindForLayer("objects", { kind: "not-a-kind" }), "creature");
  assert.equal(LOS.normalizeKind("Boulder"), "rock");
  assert.equal(LOS.normalizeKind("house"), "building");
  assert.equal(LOS.normalizeKind("smoke"), null);
  assert.equal(LOS.normalizeKind(3), null);
  assert.equal(LOS.normalizeLayerName("sweepSphereAgainstObjects"), "objects");
  assert.equal(LOS.normalizeLayerName("CELL"), "cellMesh");
  assert.equal(LOS.normalizeLayerName("??"), null);
  assert.equal(LOS.normalizeLayerName(7), null);
});

// ---------------------------------------------------------------------------
// L2 segmentChunks
// ---------------------------------------------------------------------------
check("L2 segmentChunks: a 500 m segment over 3 landblocks → 3 contiguous chunks ≤ 192 m", () => {
  const a = [10, 100, 50], b = [510, 100, 50];
  const ch = LOS.segmentChunks(a, b);
  assert.equal(ch.length, 3);
  assert.deepEqual(ch.map((c) => c.lbKey), [LB(0, 0), LB(1, 0), LB(2, 0)]);
  near(ch[0].t0, 0, 1e-12, "t0");
  near(ch[2].t1, 1, 1e-12, "t1");
  for (let i = 0; i < ch.length; i++) {
    assert.ok(ch[i].length <= 192 + 1e-9, `chunk ${i} ${ch[i].length} m`);
    if (i > 0) near(ch[i].t0, ch[i - 1].t1, 1e-12, "contiguous");
    nearV(ch[i].from, [a[0] + 500 * ch[i].t0, 100, 50], 1e-9, "from on the line");
  }
  near(ch[0].to[0], 192, 1e-9, "split at x=192");
  near(ch[1].to[0], 384, 1e-9, "split at x=384");
});

check("L2 segmentChunks: diagonal corner crossing, vertical subdivision, degenerate inputs", () => {
  const diag = LOS.segmentChunks([180, 150, 0], [220, 230, 0]);
  assert.deepEqual(diag.map((c) => c.lbKey), [LB(0, 0), LB(1, 0), LB(1, 1)]);
  const vert = LOS.segmentChunks([50, 50, 0], [50, 50, 500]);
  assert.equal(vert.length, 3, "500 m vertical → 3 chunks");
  for (const c of vert) {
    assert.equal(c.lbKey, LB(0, 0));
    near(c.length, 500 / 3, 1e-9, "even split");
  }
  assert.deepEqual(LOS.segmentChunks([1, 2, 3], [1, 2, 3]), []);
  assert.deepEqual(LOS.segmentChunks([NaN, 2, 3], [1, 2, 3]), []);
  assert.deepEqual(LOS.segmentChunks(null, [1, 2, 3]), []);
  const objs = LOS.segmentChunks({ x: 10, y: 10, z: 0 }, { x: 20, y: 10, z: 0 });
  assert.equal(objs.length, 1, "{x,y,z} points accepted");
  const onEdge = LOS.segmentChunks([192, 10, 0], [300, 10, 0]);
  assert.equal(onEdge.length, 1, "start exactly on a boundary adds no empty chunk");
  assert.equal(onEdge[0].lbKey, LB(1, 0));
});

// ---------------------------------------------------------------------------
// L3 chunking against the wasm layer contract
// ---------------------------------------------------------------------------
check("L3 a 500 m segment crossing 3 landblocks sweeps building mesh once per landblock", () => {
  const sh = geoSh([]);
  const r = LOS.segmentBlocked(sh, [10, 100, 50], [510, 100, 50], { radius: 0.3 });
  assert.equal(r.blocked, false);
  assert.equal(r.chunks, 3);
  const b = sh.calls.building;
  assert.equal(b.length, 3, "one building sweep per landblock");
  assert.deepEqual(b.map((c) => c[7]), [LB(0, 0), LB(1, 0), LB(2, 0)]);
  near(b[0][0], 10, 1e-9, "chunk 1 from");
  near(b[0][3], 192, 1e-9, "chunk 1 to");
  near(b[1][0], 192, 1e-9, "chunk 2 from");
  near(b[1][3], 384, 1e-9, "chunk 2 to");
  near(b[2][3], 510, 1e-9, "chunk 3 to");
  for (const c of b) near(c[6], 0.3, 1e-12, "radius passed");
  assert.equal(sh.calls.statics.length, 3);
  assert.equal(sh.calls.scenery.length, 3);
  assert.deepEqual(sh.calls.scenery.map((c) => c[7]), [LB(0, 0), LB(1, 0), LB(2, 0)]);
  assert.equal(sh.calls.cellMesh, undefined, "no cell ids → no cell sweeps");
  assert.equal(r.calls, 3 * 5, "building+statics+scenery+entities+objects per chunk");
});

check("L3 chunking finds a tree two landblocks away that one unchunked call misses", () => {
  const tree = { layer: "scenery", c: [450, 100, 50], r: 0.5 };
  const sh = geoSh([tree]);
  const r = LOS.segmentBlocked(sh, [10, 100, 50], [510, 100, 50], { radius: 0.25 });
  assert.equal(r.blocked, true);
  assert.equal(r.layer, "scenery");
  assert.equal(r.kind, "tree");
  near(r.t, (450 - 0.75 - 10) / 500, 1e-9, "t on the full segment");
  near(r.distance, 450 - 0.75 - 10, 1e-6, "distance");
  nearV(r.point, [449.5, 100, 50], 1e-9, "contact point on the trunk");
  nearV(r.normal, [-1, 0, 0], 1e-9, "normal toward the start");
  // Sanity of the fake = the wasm contract: one call keyed at the START landblock misses.
  const once = sh.sweepSphereAgainstScenery(10, 100, 50, 510, 100, 50, 0.25, LB(0, 0));
  assert.equal(once, undefined, "unchunked sweep (3×3 ring of lb 0) cannot see lb 2");
});

// ---------------------------------------------------------------------------
// L4 frees
// ---------------------------------------------------------------------------
check("L4 every CollisionHit is copied then freed exactly once", () => {
  ALL_HITS.length = 0;
  const sh = scriptSh({
    buildingMesh: ([fx, fy, fz]) => new FakeHit(0.6, [fx + 1, fy, fz], [-1, 0, 0]),
    statics: ([fx, fy, fz]) => new FakeHit(0.3, [fx + 2, fy, fz], [-1, 0, 0]),
    // embedded start moving AWAY (normal along the direction) → ignored, still freed
    scenery: () => new FakeHit(0, [0, 0, 0], [1, 0, 0]),
    entities: () => new FakeHit(0.9, [0, 0, 0], [-1, 0, 0]),
    objects: () => new FakeHit(0.95, [0, 0, 0], [-1, 0, 0]),
    cellMesh: () => new FakeHit(0.99, [0, 0, 0], [-1, 0, 0]),
    cellStatics: () => new FakeHit(0.98, [0, 0, 0], [-1, 0, 0]),
  });
  const r = LOS.segmentBlocked(sh, [10, 10, 5], [60, 10, 5], { cellIds: [0x01f60105] });
  assert.equal(r.blocked, true);
  assert.equal(r.layer, "statics");
  assert.equal(ALL_HITS.length, 7, "one hit per layer");
  for (const h of ALL_HITS) assert.equal(h.freed, 1, "freed once");
});

check("L4 hits whose free() throws or that are not objects never break the sweep", () => {
  const sh = scriptSh({
    buildingMesh: () => ({ t: 0.5, x: 1, y: 2, z: 3, normalX: -1, normalY: 0, normalZ: 0, free() { throw new Error("already freed"); } }),
    statics: () => 42,
    scenery: () => ({ t: NaN, free() {} }),
  });
  const r = LOS.segmentBlocked(sh, [10, 10, 5], [20, 10, 5]);
  assert.equal(r.blocked, true);
  assert.equal(r.layer, "buildingMesh");
  nearV(r.point, [1, 2, 3], 0, "copied point");
});

// ---------------------------------------------------------------------------
// L5 earliest hit / attribution
// ---------------------------------------------------------------------------
check("L5 earliest hit wins across layers; chunk-local t → segment t", () => {
  const world = [
    { layer: "buildingMesh", c: [300, 100, 50], r: 2 },  // lb 1, 290 m from the start
    { layer: "scenery", c: [450, 100, 50], r: 0.5 },     // lb 2, later
    { layer: "objects", c: [350, 100, 50], r: 0.4, guid: 0x50000001 },
  ];
  const sh = geoSh(world);
  const r = LOS.segmentBlocked(sh, [10, 100, 50], [510, 100, 50], { radius: 0.25 });
  assert.equal(r.layer, "buildingMesh");
  assert.equal(r.kind, "building");
  near(r.t, (300 - 2.25 - 10) / 500, 1e-9, "t");
  assert.equal(sh.calls.building.length, 2, "chunk 3 (after the hit) is skipped");
  assert.equal(r.chunks, 2);
});

check("L5 ties keep the layer order; a later chunk never beats an earlier one", () => {
  const sh = scriptSh({
    buildingMesh: (args, n) => (n === 1 ? new FakeHit(0.1, [0, 0, 0], [-1, 0, 0]) : undefined),
    scenery: (args, n) => (n === 0 ? new FakeHit(0.99, [0, 0, 0], [-1, 0, 0]) : undefined),
    statics: (args, n) => (n === 0 ? new FakeHit(0.99, [0, 0, 0], [-1, 0, 0]) : undefined),
  });
  const r = LOS.segmentBlocked(sh, [10, 100, 50], [510, 100, 50]);
  assert.equal(r.layer, "statics", "statics precedes scenery at the same t");
  assert.ok(r.t < 0.364, `found in chunk 1 (t ${r.t})`);
  assert.equal(sh.calls.filter((c) => c.layer === "buildingMesh").length, 1, "chunk 2 skipped: it starts after the hit");
});

// ---------------------------------------------------------------------------
// L6 argument plumbing
// ---------------------------------------------------------------------------
check("L6 subjectGuid → missile_guid; the subject never occludes itself", () => {
  const subject = { layer: "objects", c: [40, 10, 1], r: 0.5, guid: 0x80000a01 };
  const bystander = { layer: "objects", c: [25, 10, 1], r: 0.5, guid: 0x80000a02 };
  const sh = geoSh([subject]);
  const r = LOS.segmentBlocked(sh, [10, 10, 1], [40, 10, 1], { subjectGuid: 0x80000a01 });
  assert.equal(r.blocked, false, "the subject is excluded");
  const args = sh.calls.objects[0];
  assert.equal(args[7], 0x80000a01, "missile_guid");
  assert.equal(args[8], true, "exemptLocalPlayer defaults true");
  const sh2 = geoSh([subject, bystander]);
  const r2 = LOS.segmentBlocked(sh2, [10, 10, 1], [40, 10, 1], { subjectGuid: 0x80000a01, exemptLocalPlayer: false });
  assert.equal(r2.blocked, true);
  assert.equal(r2.layer, "objects");
  assert.equal(r2.kind, "creature");
  assert.equal(sh2.calls.objects[0][8], false);
  const sh3 = geoSh([]);
  LOS.segmentBlocked(sh3, [10, 10, 1], [40, 10, 1], { subjectGuid: -1 });
  assert.equal(sh3.calls.objects[0][7], 0xffffffff, "guid passed as u32");
});

check("L6 entity range = chunk length + 5 m; cell ids as Uint32Array; indoor building = wall", () => {
  const sh = geoSh([{ layer: "cellMesh", c: [30, 10, 1], r: 0.5, cell: 0xa9b40105 }]);
  const r = LOS.segmentBlocked(sh, [10, 10, 1], [40, 10, 1], { cellIds: [0xa9b40105, 0xa9b40106] });
  near(sh.calls.entities[0][7], 30 + 5, 1e-9, "range");
  const cells = sh.calls.cellMesh[0][7];
  assert.ok(cells instanceof Uint32Array, "Uint32Array");
  assert.deepEqual([...cells], [0xa9b40105, 0xa9b40106]);
  assert.ok(sh.calls.cellStatics[0][7] instanceof Uint32Array);
  assert.equal(r.layer, "cellMesh");
  assert.equal(r.kind, "wall");
  const sh2 = geoSh([{ layer: "buildingMesh", c: [30, 10, 1], r: 0.5 }]);
  const r2 = LOS.segmentBlocked(sh2, [10, 10, 1], [40, 10, 1], { cellIds: new Set([0xa9b40105]) });
  assert.equal(r2.kind, "wall", "building mesh seen from an interior = wall");
  const r3 = LOS.segmentBlocked(geoSh([{ layer: "buildingMesh", c: [30, 10, 1], r: 0.5 }]), [10, 10, 1], [40, 10, 1], {
    cellIds: [0xa9b4001c],
  });
  assert.equal(r3.kind, "building", "outdoor cell ids keep 'building'");
});

// ---------------------------------------------------------------------------
// L7 missing / throwing methods
// ---------------------------------------------------------------------------
check("L7 missing methods are skipped; throwing methods are tolerated", () => {
  const tree = { layer: "scenery", c: [30, 10, 1], r: 0.5 };
  const sh = geoSh([tree], { omit: ["sweepSphereAgainstBuildingMesh", "sweepSphereAgainstObjects", "sweepSphereAgainstStatics"] });
  sh.sweepSphereAgainstEntities = () => {
    throw new Error("RefCell already borrowed");
  };
  const r = LOS.segmentBlocked(sh, [10, 10, 1], [40, 10, 1]);
  assert.equal(r.blocked, true);
  assert.equal(r.layer, "scenery");
  assert.equal(LOS.segmentBlocked({}, [10, 10, 1], [40, 10, 1]).blocked, false, "empty handle → clear");
  const n = LOS.segmentBlocked(null, [10, 10, 1], [40, 10, 1]);
  assert.equal(n.blocked, false);
  assert.equal(n.calls, 0);
  const stale = { sweepSphereAgainstScenery: "not a function" };
  assert.equal(LOS.segmentBlocked(stale, [10, 10, 1], [40, 10, 1]).blocked, false);
});

// ---------------------------------------------------------------------------
// L8 embedded start
// ---------------------------------------------------------------------------
check("L8 embedded start: moving away ignored, moving into the surface blocks at t = 0", () => {
  const away = scriptSh({ cellMesh: () => new FakeHit(0, [10, 10, 1], [1, 0, 0]) });
  const ra = LOS.segmentBlocked(away, [10, 10, 1], [20, 10, 1], { cellIds: [0x01f60100] });
  assert.equal(ra.blocked, false, "normal along the motion → leaving the wall");
  const into = scriptSh({ cellMesh: () => new FakeHit(0, [10, 10, 1], [-1, 0, 0]) });
  const ri = LOS.segmentBlocked(into, [10, 10, 1], [20, 10, 1], { cellIds: [0x01f60100] });
  assert.equal(ri.blocked, true);
  assert.equal(ri.t, 0);
  assert.equal(ri.distance, 0);
  // Same rule as the shared helper.
  assert.equal(PS.projectileHitStops(0, -1, false), true);
  assert.equal(PS.projectileHitStops(0, 1, false), false);
  // An overlapping start in the geometric fake (sphere already touching, moving in).
  const sh = geoSh([{ layer: "scenery", c: [10.5, 10, 1], r: 0.5 }]);
  const rg = LOS.segmentBlocked(sh, [10, 10, 1], [20, 10, 1]);
  assert.equal(rg.blocked, true);
  assert.equal(rg.t, 0);
  const sh2 = geoSh([{ layer: "scenery", c: [9.5, 10, 1], r: 0.5 }]);
  assert.equal(LOS.segmentBlocked(sh2, [10, 10, 1], [20, 10, 1]).blocked, false, "overlap behind, moving away");
});

// ---------------------------------------------------------------------------
// L9 terrain
// ---------------------------------------------------------------------------
const ridge = (x) => 10 - Math.abs(x - 50) * 0.5; // peak z 10 at x = 50, slope 0.5
check("L9 terrain: a ridge between camera and subject blocks at the crossing", () => {
  const zAt = (x) => ridge(x);
  const r = LOS.segmentBlocked(null, [20, 10, 6], [80, 10, 6], { terrainZAt: zAt });
  assert.equal(r.blocked, true);
  assert.equal(r.layer, "terrain");
  assert.equal(r.kind, "terrain");
  // ridge(x) = 6 → x = 42 (rising side)
  near(r.point[0], 42, 0.01, "crossing x");
  near(r.point[2], ridge(r.point[0]), 1e-9, "point on the surface");
  near(r.t, (r.point[0] - 20) / 60, 1e-9, "t");
  const n = r.normal;
  near(Math.hypot(n[0], n[1], n[2]), 1, 1e-9, "unit normal");
  assert.ok(n[2] > 0.8 && n[0] < 0, `up-facing, tilted toward -x: ${n}`);
  const clear = LOS.segmentBlocked(null, [20, 10, 12], [80, 10, 12], { terrainZAt: zAt });
  assert.equal(clear.blocked, false, "over the ridge");
});

check("L9 terrain: unknown/throwing terrain never blocks; absent terrainZAt skips the layer", () => {
  let calls = 0;
  const throwing = () => {
    calls += 1;
    throw new Error("landblock not resident");
  };
  assert.equal(LOS.segmentBlocked(null, [20, 10, 0], [80, 10, 0], { terrainZAt: throwing }).blocked, false);
  assert.ok(calls > 0);
  assert.equal(LOS.segmentBlocked(null, [20, 10, 0], [80, 10, 0], { terrainZAt: () => null }).blocked, false);
  assert.equal(LOS.segmentBlocked(null, [20, 10, 6], [80, 10, 6]).blocked, false, "no terrainZAt");
  assert.equal(LOS.segmentBlocked(null, [20, 10, 6], [80, 10, 6], { terrainZAt: ridge, layers: ["scenery"] }).blocked, false,
    "terrain not selected");
});

check("L9 terrain earlier than every wasm hit wins and skips later chunks", () => {
  const sh = geoSh([{ layer: "scenery", c: [450, 100, 6], r: 0.5 }]);
  const r = LOS.segmentBlocked(sh, [10, 100, 6], [510, 100, 6], { terrainZAt: (x) => (x > 100 && x < 120 ? 20 : 0) });
  assert.equal(r.layer, "terrain");
  near(r.point[0], 100, 0.6, "first probe beyond x=100");
  assert.equal(sh.calls.building.length, 1, "only chunk 1 starts before the terrain hit");
});

// ---------------------------------------------------------------------------
// L10 options and degenerate input
// ---------------------------------------------------------------------------
check("L10 layers option selects layers; unknown names throw FilmError", () => {
  const sh = geoSh([{ layer: "scenery", c: [30, 10, 1], r: 0.5 }]);
  const r = LOS.segmentBlocked(sh, [10, 10, 1], [40, 10, 1], { layers: ["buildingMesh", "cell"] });
  assert.equal(r.blocked, false);
  assert.equal(sh.calls.scenery, undefined, "scenery not swept");
  assert.equal(sh.calls.building.length, 1);
  const r2 = LOS.segmentBlocked(sh, [10, 10, 1], [40, 10, 1], { layers: new Set(["sweepSphereAgainstScenery"]) });
  assert.equal(r2.layer, "scenery");
  assert.throws(() => LOS.segmentBlocked(sh, [10, 10, 1], [40, 10, 1], { layers: ["trees"] }),
    (e) => e instanceof FilmError && /unknown layer/.test(e.message) && /buildingMesh/.test(e.message));
  assert.throws(() => LOS.segmentBlocked(sh, [10, 10, 1], [40, 10, 1], { layers: 5 }), FilmError);
});

check("L10 non-finite and zero-length segments are clear, never throw", () => {
  const sh = geoSh([{ layer: "scenery", c: [25, 10, 1], r: 0.5 }]);
  const bad = LOS.segmentBlocked(sh, [NaN, 10, 1], [40, 10, 1]);
  assert.equal(bad.blocked, false);
  assert.equal(bad.valid, false);
  assert.equal(LOS.segmentBlocked(sh, undefined, [40, 10, 1]).valid, false);
  const zero = LOS.segmentBlocked(sh, [10, 10, 1], [10, 10, 1]);
  assert.equal(zero.blocked, false);
  assert.equal(zero.valid, true);
  assert.equal(zero.calls, 0);
  const r = LOS.segmentBlocked(sh, [10, 10, 1], [40, 10, 1], { radius: -3 });
  assert.equal(sh.calls.scenery.at(-1)[6], LOS.LOS_DEFAULT_RADIUS, "bad radius → default");
  assert.equal(r.blocked, true);
  const objs = LOS.segmentBlocked(sh, { x: 40, y: 10, z: 1 }, { x: 20, y: 10, z: 1 });
  assert.equal(objs.valid, true, "{x,y,z} endpoints");
  near(objs.length, 20, 1e-12, "length");
});

console.log(`film_scene_los: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
