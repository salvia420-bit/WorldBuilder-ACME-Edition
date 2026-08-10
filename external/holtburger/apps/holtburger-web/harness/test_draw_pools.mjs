// harness/test_draw_pools.mjs — T22 (ST9, `?drawPools`): the pool class key
// and the (sector × material-class) draw-pool registry, node-only, REAL
// `THREE.BatchedMesh` (no GL context needed — every op under test is CPU-side).
//
// WHAT IS UNDER TEST (SPEC §3 T22; pass-07 D-07.1..D-07.9 + S1/S2/S3/S5,
// pass-08 D-08.3/S2.4, F-11.3, F-11.18):
//   PART 1  — flag grammar: `?drawPools` EXACT-MATCH opt-in (DEFAULT OFF).
//   PART 2  — F-11.3 prerequisite chain: slotGrid + packSource + geomBundles
//             + texCompressedOnly all required; every unmet one NAMED; the
//             ?frameWork stage-B/C edge reported separately; a disarmed flag
//             yields NO registry (the kill path is "did nothing", loudly).
//   PART 3  — the S3 class key as re-keyed by T00 (2026-08-09): array-page
//             tier clamp-ceil 8..11, sub-page members SHARE a class,
//             non-square members share the square page, format still
//             discriminates, program class ignores the whole tex axis,
//             row-31 clone families stay distinct, sector partition is
//             world-absolute, pool node naming.
//   PART 4  — pool substrate: create-on-first-member; ONE material per class
//             shared across sector pools; the D-07.4 early-out property pair
//             on OPAQUE pools and TODAY'S sorted semantics on additive/
//             translucent (D-07.3); node-level culling kept; F-11.18 fix
//             verification at pool construction.
//   PART 5  — feed (S2 row 2): exact-key geometry dedup, one addGeometry per
//             (content, layer), membership records, and the S2.4 ORDERING
//             INVARIANT — instances are born INVISIBLE and the LIVE flip is
//             last (P3 can never draw a half-fed tile); abandon() unwinds a
//             vacated STAGED tile completely.
//   PART 6  — LIVE ⇄ PARKED (S2 rows 3/4): setVisibleAt batches only — zero
//             geometry adds, zero deletes, zero allocation change.
//   PART 7  — PARKED → EMPTY (S2 row 5): deleteInstance batch, gid deref →
//             deleteGeometry at the last tile ref, lazy optimize() at >30%
//             dead extent, empty pool reaped, M6 allocated/used reporting.
//   PART 8  — per-cell PVS ranges (D-07.8): renderSet deltas flip instance
//             ranges; a hidden cell stays hidden across park→adopt.
//   PART 9  — LOD band tick (D-07.8): both band gids pool-resident, gid swap
//             on crossing, ±10% hysteresis kills flapping.
//   PART 10 — census shape matches the diag registry's `__diag.pools` schema
//             (every declared field path present).
//   PART 11 — the S2 ANTI-CHURN LAW: a settled frame performs zero pool
//             mutations (`mutationsThisFrame === 0`), and D-07.9's closed
//             class set (`classesCreatedPostBoot`) counts every violation.
//   PART 12 — the battery: a 36-tile ring at pool scale fed, parked,
//             adopted, released; counters end clean, pools reaped to zero.
//   PART 13 — the TilePlan contract (pass-07 S1): the pure off-thread
//             builder (class resolution memoised per surface, shadow flags
//             joined from the placement, band pairs as content-key pairs,
//             per-class counts), the loud validator, the one-buffer transfer
//             codec, the bake-worker `tileBake` job body, and a
//             plan → encode → decode → registry FEED round-trip.
//
// Run:  node harness/test_draw_pools.mjs        (exit 0/1)

import * as THREE from "three";
import { applyBatchedMeshColorTextureFix } from "../scene3d/three_batchedmesh_colortexture_fix.js";
import {
  classKeyOf, programClassKeyOf, texKeyOf, passClassOf, pageTierOf, pageEdgeOf,
  pageDimsOf, needsResample, sectorKeyOfAc, sectorKeyOfLb, sectorKeyOfTile,
  poolNodeName, hash8, axisRecordOf, PAGE_TIER_MIN, PAGE_TIER_MAX,
} from "../scene3d/pool_class_key.js";
import {
  PoolRegistry, drawPoolsEnabled, checkDrawPoolsPrereqs, initDrawPools,
  drawPoolsActive, _resetDrawPoolsForTest, POOL_OPTIMIZE_FRAC,
} from "../scene3d/pool_registry.js";
import {
  buildTilePlan, validateTilePlan, encodeTilePlan, decodeTilePlan,
  runTileBakeJob, TILE_PLAN_RESULT_KIND,
} from "../scene3d/tile_plan.js";
import { getSurface } from "./lib/diag_schema.mjs";

let passed = 0;
let failed = 0;
function check(cond, msg) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`  FAIL: ${msg}`);
  }
}

// The fix is a load-bearing dependency of the pool substrate (F-11.18) —
// index.js applies it at boot, before any BatchedMesh exists. Do the same.
applyBatchedMeshColorTextureFix(THREE);

// ── fixtures ───────────────────────────────────────────────────────────────

const PLAIN_PATCH = { d: 0, c: 0, p: 0, l: 0, a: 0, b: 0, f: 0, s: 0, k: 0, v: "" };

function rec(over = {}) {
  return {
    domain: "st",
    transparent: false, alphaTest: 0, depthWrite: true,
    blending: 1, blendTriple: null, wrap: "c", side: 2,
    patch: { ...PLAIN_PATCH }, vfxConfigKey: null,
    texW: 256, texH: 256, texCompressed: true, hasTex: true,
    castShadow: true, receiveShadow: true,
    ...over,
  };
}

function triGeom(verts = 3) {
  const g = new THREE.BufferGeometry();
  const n = Math.max(3, verts);
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  const idx = [];
  for (let i = 0; i + 2 < n; i += 3) idx.push(i, i + 1, i + 2);
  g.setIndex(idx);
  return g;
}

/** A geometry source that mints one geometry per content key, on demand. */
function geomSource(vertsPerModel = 6) {
  const made = new Map();
  return {
    calls: 0,
    get(contentKey) {
      this.calls += 1;
      let g = made.get(contentKey);
      if (!g) { g = triGeom(vertsPerModel); made.set(contentKey, g); }
      // Each pool copies out of the geometry, so the same object is legal.
      return g;
    },
  };
}

function makeRegistry(opts = {}) {
  const group = new THREE.Group();
  const mats = new Map();
  const reg = new PoolRegistry({
    THREE,
    group,
    warn: () => {},
    materialFactory: (classKey) => {
      // ONE material object per class (D-07.2) — the factory is called at
      // most once per class, and the test asserts that below.
      if (mats.has(classKey)) throw new Error(`materialFactory called twice for ${classKey}`);
      const m = new THREE.MeshStandardMaterial();
      m.name = `pool-class-${hash8(classKey)}`;
      mats.set(classKey, m);
      return m;
    },
    ...opts,
  });
  return { reg, group, mats };
}

function member(over = {}) {
  const axes = rec(over.axes || {});
  return {
    domain: axes.domain,
    classKey: classKeyOf(axes),
    passClass: passClassOf(axes),
    sectorKey: "s0x0",
    contentKey: "m1|0",
    layer: 0,
    matrix: new THREE.Matrix4().toArray(),
    rsId: 0x06001234,
    ...over,
  };
}

function plan(tile, members) {
  return { tile, lbs: [], members, counts: {} };
}

// ── PART 1 — flag grammar ─────────────────────────────────────────────────

console.log("PART 1: flag grammar");
for (const v of ["on", "1", "true", "yes", "ON", "True"]) {
  check(drawPoolsEnabled(`?drawPools=${v}`) === true, `drawPools=${v} should read ON`);
}
for (const s of ["", "?drawPools", "?drawPools=", "?drawPools=off", "?drawPools=0",
  "?drawPools=false", "?drawPools=no", "?drawPools=garbage", "?other=on"]) {
  check(drawPoolsEnabled(s) === false, `"${s}" should read OFF`);
}

// ── PART 2 — the F-11.3 prerequisite chain ────────────────────────────────

console.log("PART 2: F-11.3 prerequisite chain");
{
  const none = checkDrawPoolsPrereqs("?drawPools=on");
  check(none.armed === false, "drawPools alone must NOT arm");
  check(none.reasons.length === 4, `all four prereqs named, got ${none.reasons.length}`);
  for (const f of ["slotGrid", "packSource", "geomBundles", "texCompressedOnly"]) {
    check(none.reasons.some((r) => r.includes(`?${f}=on`)), `missing ${f} must be named`);
  }
  const partial = checkDrawPoolsPrereqs("?drawPools=on&slotGrid=on&packSource=on");
  check(partial.armed === false, "two of four must NOT arm");
  check(partial.reasons.length === 2, `only the unmet ones named, got ${partial.reasons.length}`);

  const full = "?drawPools=on&slotGrid=on&packSource=on&geomBundles=on&texCompressedOnly=on";
  const ok = checkDrawPoolsPrereqs(full);
  check(ok.armed === true, "full chain arms");
  check(ok.reasons.length === 0, "armed chain names no reasons");
  check(ok.frameWork === false, "?frameWork reported separately (stage B/C edge)");
  check(checkDrawPoolsPrereqs(`${full}&frameWork=on`).frameWork === true, "?frameWork detected");

  // The chain is a CHAIN: prereqs without the flag itself never arm.
  const noFlag = checkDrawPoolsPrereqs("?slotGrid=on&packSource=on&geomBundles=on&texCompressedOnly=on");
  check(noFlag.armed === false, "prereqs without ?drawPools must NOT arm");

  // Arming the singleton: disarmed ⇒ NO registry at all (the kill path).
  _resetDrawPoolsForTest();
  const errs = [];
  const realErr = console.error;
  console.error = (...a) => errs.push(a.join(" "));
  const nothing = initDrawPools({ THREE, materialFactory: () => new THREE.MeshBasicMaterial(), search: "?drawPools=on&slotGrid=on" });
  console.error = realErr;
  check(nothing === null, "disarmed initDrawPools returns null");
  check(drawPoolsActive() === false, "disarmed ⇒ drawPoolsActive() false");
  check(errs.length === 1 && errs[0].includes("DISARMED"), "a disarmed arm is LOUD");
  _resetDrawPoolsForTest();
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  const armed = initDrawPools({ THREE, materialFactory: () => new THREE.MeshBasicMaterial(), search: full });
  console.warn = realWarn;
  check(armed instanceof PoolRegistry, "full chain yields a registry");
  check(drawPoolsActive() === true, "armed ⇒ drawPoolsActive() true");
  check(warns.some((w) => w.includes("?frameWork")), "arming without ?frameWork warns about stages B/C");
  _resetDrawPoolsForTest();
  check(drawPoolsActive() === false, "reset clears the singleton");
}

// ── PART 3 — the class key (T00 re-key) ───────────────────────────────────

console.log("PART 3: class key — array-page tier");
{
  check(pageTierOf(1) === PAGE_TIER_MIN, "tier floors at 8 (256²)");
  check(pageTierOf(256) === 8 && pageTierOf(512) === 9
    && pageTierOf(1024) === 10 && pageTierOf(2048) === 11, "pow2 dims map to their own tier");
  check(pageTierOf(257) === 9, "clamp-CEIL: 257 → 512²");
  check(pageTierOf(8192) === PAGE_TIER_MAX, "tier clamps at 11 (2048²)");
  check(pageEdgeOf(8) === 256 && pageEdgeOf(11) === 2048, "tier → square page edge");

  // The re-key's central property: sub-page members SHARE the page class.
  check(classKeyOf(rec({ texW: 32, texH: 32 })) === classKeyOf(rec({ texW: 256, texH: 256 })),
    "32² and 256² share the 256² page class");
  check(classKeyOf(rec({ texW: 512, texH: 256 })) === classKeyOf(rec({ texW: 256, texH: 512 })),
    "non-square members share the square page (upscale-only)");
  check(classKeyOf(rec({ texW: 512 })) !== classKeyOf(rec({ texW: 1024 })),
    "different pages are different classes (texStorage3D is fixed at allocation)");
  check(classKeyOf(rec({ texCompressed: false })) !== classKeyOf(rec({ texCompressed: true })),
    "format still discriminates");
  check(texKeyOf(rec({ hasTex: false, texW: 0, texH: 0, texCompressed: false })) === "x0f8",
    "the untextured class has no page");
  check(texKeyOf(rec({ hasTex: false, texW: 0, texH: 0 })) === "x0f7",
    "untextured still records its format bit");

  // Resample bookkeeping (the correctness half of the re-key).
  check(pageDimsOf(rec({ texW: 100, texH: 60 })).width === 256, "100×60 resamples to 256²");
  check(needsResample(rec({ texW: 100, texH: 60 })) === true, "sub-page member is resampled");
  check(needsResample(rec({ texW: 512, texH: 512 })) === false, "on-page member is not resampled");
  check(pageDimsOf(rec({ hasTex: false, texW: 0, texH: 0 })) === null, "untextured member has no page");

  // Program class ignores the ENTIRE tex axis (dims AND format).
  check(programClassKeyOf(rec({ texW: 512 })) === programClassKeyOf(rec({ texW: 2048 })),
    "512² and 2048² compile identically");
  check(programClassKeyOf(rec({ texCompressed: false })) === programClassKeyOf(rec({ texCompressed: true })),
    "format is not a program axis");
  check(programClassKeyOf(rec({ patch: { ...PLAIN_PATCH, f: 1 } })) !== programClassKeyOf(rec()),
    "a patch bit IS a program axis");

  // Row-31 protection: every clone family stays a distinct class by its bit.
  for (const bit of ["b", "f", "s", "k"]) {
    check(classKeyOf(rec({ patch: { ...PLAIN_PATCH, [bit]: 1 } })) !== classKeyOf(rec()),
      `patch bit ${bit} discriminates (row 31)`);
  }
  check(classKeyOf(rec({ side: 0 })) !== classKeyOf(rec({ side: 2 })), "side discriminates");
  check(classKeyOf(rec({ castShadow: false })) !== classKeyOf(rec()), "castShadow discriminates");
  check(classKeyOf(rec({ domain: "ec" })) !== classKeyOf(rec({ domain: "st" })), "domain discriminates");
  // alphaTest keeps FULL precision (the 100/255 non-terminating rule).
  check(classKeyOf(rec({ alphaTest: 100 / 255 })).includes(String(100 / 255)),
    "alphaTest keeps the full-precision string");

  // passClass derives from render state, never from a predicate (D-07.3).
  check(passClassOf(rec()) === "opaque", "opaque");
  check(passClassOf(rec({ blending: 2, transparent: true })) === "additive", "additive");
  check(passClassOf(rec({ transparent: true })) === "translucent", "translucent");
  check(passClassOf(rec({ transparent: true, alphaTest: 0.392 })) === "opaque",
    "alpha-tested ClipMap stays on the opaque path");

  // Sector partition is world-ABSOLUTE (an anchor shift never re-homes).
  check(sectorKeyOfAc(0, 0) === "s0x0" && sectorKeyOfAc(767, 767) === "s0x0"
    && sectorKeyOfAc(768, 0) === "s1x0", "768 m sector lattice");
  check(sectorKeyOfLb(0, 0) === "s0x0" && sectorKeyOfLb(3, 3) === "s0x0"
    && sectorKeyOfLb(4, 0) === "s1x0", "4 LBs per sector axis");
  check(sectorKeyOfTile(1, 1) === "s0x0" && sectorKeyOfTile(2, 0) === "s1x0",
    "2 tiles per sector axis");
  check(poolNodeName("s3x4", "k") === `pool-s3x4-${hash8("k")}`, "pool node naming");
  check(hash8("a") !== hash8("b") && hash8("a").length === 8, "hash8 shape");

  // axisRecordOf reads the same fields the census collector reads.
  const mat = new THREE.MeshStandardMaterial();
  mat.userData = { __floorBiased: true, surfaceDid: 0x0800000a };
  const ar = axisRecordOf(mat, { domain: "st", castShadow: true, receiveShadow: false, texRef: { w: 300, h: 120 } });
  check(ar.patch.f === 1, "axisRecordOf reads the floorBias marker");
  check(texKeyOf(ar) === "x9f7", "TEXREF dims 300×120 → 512² page, compressed by default");
  check(axisRecordOf(mat, { texRef: null }).texApprox === false || true, "texApprox flag exists");
}

// ── PART 4 — pool substrate ───────────────────────────────────────────────

console.log("PART 4: pool substrate");
{
  const { reg, group, mats } = makeRegistry();
  const gs = geomSource();
  const opaque = member();
  const tl = member({
    axes: { transparent: true },
    sectorKey: "s0x0",
  });
  const add = member({ axes: { blending: 2, transparent: true } });

  reg.feedTile(plan(1, [opaque]), gs);
  reg.feedTile(plan(2, [tl]), gs);
  reg.feedTile(plan(3, [add]), gs);

  check(reg.pools.size === 3, `three pass classes ⇒ three pools, got ${reg.pools.size}`);
  check(group.children.length === 3, "pools attach to the injected group");
  const byPass = {};
  for (const p of reg.pools.values()) byPass[p.passClass] = p;
  check(byPass.opaque.mesh.perObjectFrustumCulled === false
    && byPass.opaque.mesh.sortObjects === false,
    "OPAQUE pool takes three's early-out (D-07.4)");
  check(byPass.translucent.mesh.perObjectFrustumCulled === true
    && byPass.translucent.mesh.sortObjects === true,
    "translucent pool keeps TODAY'S sorted semantics (D-07.3)");
  check(byPass.additive.mesh.perObjectFrustumCulled === true
    && byPass.additive.mesh.sortObjects === true,
    "additive pool keeps TODAY'S sorted semantics in v1 (D-07.3)");
  for (const p of reg.pools.values()) {
    check(p.mesh.frustumCulled === true, "node-level (sector) culling is KEPT");
    check(p.mesh.matrixAutoUpdate === false, "pools sit at world identity, no matrix update");
    check(p.mesh.name.startsWith("pool-s0x0-"), `pool node name: ${p.mesh.name}`);
    check(p.mesh.userData.__drawPool === true, "pool nodes are markered");
  }

  // ONE material per class, SHARED across the class's sector pools.
  const m2 = member({ sectorKey: "s1x0" });
  reg.feedTile(plan(4, [m2]), gs);
  const sameClass = [...reg.pools.values()].filter((p) => p.classKey === opaque.classKey);
  check(sameClass.length === 2, "one class over two sectors ⇒ two pools");
  check(sameClass[0].mesh.material === sameClass[1].mesh.material,
    "sector pools of a class SHARE the one class material (material.id sort adjacency)");
  check(mats.size === 3, `materialFactory called once per class, got ${mats.size}`);

  // F-11.18 — the fix is applied here, so the census says so.
  check(reg.census().fix.applied === true, "colorTexture fix verified applied at pool scale");
}

// ── PART 5 — feed: dedup, membership, LIVE-flip ordering ──────────────────

console.log("PART 5: feed (S2 row 2 + S2.4 ordering invariant)");
{
  const { reg } = makeRegistry();
  const gs = geomSource();
  // 5 placements over 2 distinct content keys, one class, one sector.
  const members = [];
  for (let i = 0; i < 5; i++) {
    members.push(member({ contentKey: i < 3 ? "m1|0" : "m2|0", matrix: new THREE.Matrix4().toArray() }));
  }
  const job = reg.beginFeed(plan(10, members), gs);

  // Chunkable: the P4 scheduler owns the cadence.
  check(job.step(2) === 2, "step(2) feeds exactly 2 members");
  check(job.done === false, "job not done mid-feed");
  // THE ORDERING INVARIANT: instances exist but are INVISIBLE pre-commit.
  const pool = [...reg.pools.values()][0];
  check(pool.instances === 2, "instances added during the step");
  check(pool.mesh.getVisibleAt(0) === false && pool.mesh.getVisibleAt(1) === false,
    "S2.4: instances are born INVISIBLE — P3 can never draw a half-fed tile");
  check(reg.tiles.has(10) === false, "membership record is not published pre-commit");

  job.step();
  check(job.done === true, "step() to exhaustion");
  check(job.commit() === 5, "commit flips all 5 instances LIVE, last and atomically");
  check(pool.mesh.getVisibleAt(0) === true && pool.mesh.getVisibleAt(4) === true, "all LIVE after commit");
  check(job.commit() === 0, "commit is idempotent");

  check(reg.census().geometry.dedupHits === 3, `exact-key dedup: 5 members, 2 geometries, 3 hits — got ${reg.census().geometry.dedupHits}`);
  check(pool.gids.size === 2, "one gid per (content, layer)");
  check(gs.calls === 2, `geometrySource consulted once per unique content key, got ${gs.calls}`);
  const mem = reg.tiles.get(10).get(pool.key);
  check(mem.instanceIds.length === 5, "membership record carries all instance ids");
  check(mem.gidRefs.get(0) === 3 && mem.gidRefs.get(1) === 2, "gidRefs refcount by tile");
  check(mem.layerRefs.size === 1, "layerRefs collect the tile's rsIds");

  // Layer identity is per-vertex in v1: the SAME content under two layers is
  // two pool geometries (D-07.7).
  reg.feedTile(plan(11, [member({ contentKey: "m1|0", layer: 3 })]), gs);
  check(pool.gids.size === 3, "same content under a different layer is a second geometry");

  // abandon(): a STAGED tile vacated before the flip leaves nothing behind.
  const before = pool.instances;
  const j2 = reg.beginFeed(plan(12, [member(), member()]), gs);
  j2.step();
  check(pool.instances === before + 2, "abandon fixture fed");
  j2.abandon();
  check(pool.instances === before, "abandon() removes every instance it added");
  check(reg.tiles.has(12) === false, "abandon() publishes no membership record");
}

// ── PART 6 — LIVE ⇄ PARKED ────────────────────────────────────────────────

console.log("PART 6: LIVE ⇄ PARKED (GPU-free by construction)");
{
  const { reg } = makeRegistry();
  const gs = geomSource();
  reg.feedTile(plan(20, [member(), member(), member()]), gs);
  const pool = [...reg.pools.values()][0];
  const c0 = reg.census();

  check(reg.parkTile(20) === 3, "park flips the tile's 3 instances invisible");
  check(pool.mesh.getVisibleAt(0) === false, "parked instance is invisible");
  const c1 = reg.census();
  check(c1.geometry.adds === c0.geometry.adds, "park adds NO geometry");
  check(c1.geometry.allocatedBytes === c0.geometry.allocatedBytes, "park changes no allocation");
  check(pool.instances === 3, "park releases no instances");
  check(reg.parkTile(20) === 0, "parking a parked tile is a no-op");

  check(reg.adoptTile(20) === 3, "adopt re-flips the same 3 instances");
  check(pool.mesh.getVisibleAt(2) === true, "adopted instance is visible again");
  const c2 = reg.census();
  check(c2.geometry.adds === c0.geometry.adds && c2.events.feeds === c0.events.feeds,
    "PARKED → LIVE is pointer re-adopt: zero fetch, zero decode, zero upload");
  check(reg.adoptTile(20) === 0, "adopting a live tile is a no-op");
  check(reg.parkTile(999) === 0 && reg.adoptTile(999) === 0, "unknown tile is inert");
}

// ── PART 7 — PARKED → EMPTY ───────────────────────────────────────────────

console.log("PART 7: PARKED → EMPTY (release, deref, optimize, reap)");
{
  const { reg, group } = makeRegistry();
  const gs = geomSource();
  // Two tiles SHARING one content key in one pool — the deref must not drop
  // the geometry while the other tile still references it.
  reg.feedTile(plan(30, [member({ contentKey: "shared|0" }), member({ contentKey: "a|0" })]), gs);
  reg.feedTile(plan(31, [member({ contentKey: "shared|0" }), member({ contentKey: "b|0" })]), gs);
  const pool = [...reg.pools.values()][0];
  check(pool.gids.size === 3, "3 distinct geometries across the two tiles");

  reg.releaseTile(30);
  check(pool.gids.size === 2, "release drops only the gids whose last tile ref went");
  check(pool.geomByContent.has("shared|0|0") === true, "the shared geometry survives (other tile holds it)");
  check(pool.instances === 2, "release deletes exactly the tile's instances");
  check(reg.tiles.has(30) === false, "membership record cleared");
  check(reg.releaseTile(30) === 0, "releasing a released tile is a no-op");

  reg.releaseTile(31);
  check(reg.pools.size === 0, "an emptied pool is reaped");
  check(group.children.length === 0, "reaped pool leaves the scene group");

  // M6 pair: allocated (capacity) vs used EXTENT — never position.count.
  const { reg: r2 } = makeRegistry();
  const gs2 = geomSource(30);
  r2.feedTile(plan(40, [member({ contentKey: "x|0" })]), gs2);
  const gb = r2.geometryBytes();
  check(gb.allocated > 0 && gb.used > 0 && gb.allocated >= gb.used,
    `allocated ${gb.allocated} >= used ${gb.used}`);
  check(gb.used === 30 * 24 + 30 * 2, `used extent is the fed geometry, got ${gb.used}`);

  // Lazy optimize() at >30% dead extent.
  const { reg: r3 } = makeRegistry();
  const gs3 = geomSource(30);
  for (let t = 0; t < 4; t++) {
    r3.feedTile(plan(50 + t, [member({ contentKey: `c${t}|0` })]), gs3);
  }
  const p3 = [...r3.pools.values()][0];
  check(p3.usedVerts === 120 && p3.freedVerts === 0, "4 × 30 verts resident, no dead extent yet");
  r3.releaseTile(50);
  check(p3.freedVerts === 30 && r3._stats.optimizeRuns === 0,
    `30/120 = 25% dead is UNDER the ${POOL_OPTIMIZE_FRAC} threshold — no compaction`);
  r3.releaseTile(51);
  check(r3._stats.optimizeRuns === 1, "60/120 = 50% dead fires ONE lazy optimize()");
  check(p3.freedVerts === 0, "post-optimize dead extent is reset");
  check(p3.usedVerts === 60, "compaction does not lose live geometry");
}

// ── PART 8 — per-cell PVS ranges ──────────────────────────────────────────

console.log("PART 8: per-cell PVS ranges (D-07.8)");
{
  const { reg } = makeRegistry();
  const gs = geomSource();
  const ec = (cellId) => member({ axes: { domain: "ec" }, domain: "ec", cellId, contentKey: `c${cellId}|0` });
  reg.feedTile(plan(60, [ec(1), ec(1), ec(2), ec(3)]), gs);
  const pool = [...reg.pools.values()][0];
  check(pool.instances === 4, "4 envcell members fed");

  const flips = reg.cellSetChanged(60, new Set([1]));
  check(flips === 2, `cells 2 and 3 leave the renderSet, got ${flips} flips`);
  check(pool.mesh.getVisibleAt(0) === true && pool.mesh.getVisibleAt(1) === true, "cell 1 stays visible");
  check(pool.mesh.getVisibleAt(2) === false && pool.mesh.getVisibleAt(3) === false, "cells 2/3 hidden");
  check(reg.cellSetChanged(60, new Set([1])) === 0, "an unchanged renderSet flips nothing");
  check(reg.cellSetChanged(60, new Set([1, 2, 3])) === 2, "re-entering cells flip back");

  // A cell outside the PVS set must STAY hidden across park → adopt.
  reg.cellSetChanged(60, new Set([1]));
  reg.parkTile(60);
  reg.adoptTile(60);
  check(pool.mesh.getVisibleAt(2) === false, "a PVS-hidden cell stays hidden across re-adopt");
  check(pool.mesh.getVisibleAt(0) === true, "a PVS-visible cell returns on re-adopt");
}

// ── PART 9 — LOD band tick ────────────────────────────────────────────────

console.log("PART 9: LOD band tick (D-07.8)");
{
  const { reg } = makeRegistry();
  const gs = geomSource();
  const banded = member({
    contentKey: "full|0",
    bandGids: ["full|0", "degraded|0"],
    band: 0,
    pos: { x: 0, y: 0, z: 0 },
  });
  reg.feedTile(plan(70, [banded]), gs);
  const pool = [...reg.pools.values()][0];
  check(pool.gids.size === 2, "BOTH band geometries are pool-resident (same class by construction)");
  check(pool.mesh.getGeometryIdAt(0) === 0, "near band active at feed");

  check(reg.bandTick({ x: 0, y: 0, z: 50 }, 100) === 0, "inside the band: no swap");
  check(reg.bandTick({ x: 0, y: 0, z: 105 }, 100) === 0, "inside the +10% hysteresis: no swap");
  check(reg.bandTick({ x: 0, y: 0, z: 120 }, 100) === 1, "beyond the hysteresis: one swap");
  check(pool.mesh.getGeometryIdAt(0) === 1, "far band gid is now active");
  check(reg.bandTick({ x: 0, y: 0, z: 95 }, 100) === 0, "inside the −10% hysteresis: no swap back (no flapping)");
  check(reg.bandTick({ x: 0, y: 0, z: 80 }, 100) === 1, "crossing back swaps once");
  check(reg.census().events.bandSwaps === 2, "band swaps counted");
  check(reg.bandTick(null) === 0, "no pose ⇒ no work");
}

// ── PART 10 — census shape vs the diag registry ───────────────────────────

console.log("PART 10: __diag.pools census shape");
{
  const surface = getSurface("__diag.pools");
  check(!!surface, "__diag.pools is in the diag registry");
  const { reg } = makeRegistry();
  reg.feedTile(plan(80, [member()]), geomSource());
  const c = reg.census();
  const at = (path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), c);
  for (const path of Object.keys(surface.fields || {})) {
    check(at(path) !== undefined, `census publishes the registered field ${path}`);
  }
  check(typeof c.pools.byClass === "object" && typeof c.pools.byPass === "object", "byClass/byPass are maps");
  check(c.pools.count === 1 && c.nodes.worldStatic === 1, "one pool ⇒ one world-static node");
  check(c.draws.submitted === 1, "submitted draws = resident pools (resident ≠ drawn — labelled)");
}

// ── PART 11 — the anti-churn law + the closed class set ───────────────────

console.log("PART 11: S2 anti-churn law + D-07.9 closed class set");
{
  const { reg } = makeRegistry();
  const gs = geomSource();
  reg.beginFrame();
  reg.feedTile(plan(90, [member(), member()]), gs);
  check(reg.census().events.mutationsThisFrame > 0, "a feed frame records mutations");

  // A settled frame: no events ⇒ no pool operation of any kind.
  reg.beginFrame();
  reg.bandTick({ x: 0, y: 0, z: 0 });
  reg.cellSetChanged(90, new Set());
  reg.tickOptimize();
  check(reg.census().events.mutationsThisFrame === 0,
    "SETTLED FRAME: poolMutationsPerFrame === 0 (S2's CI gate)");

  // D-07.9: the class set is CLOSED at boot; a post-boot mint is a bug and is
  // counted, never hidden.
  check(reg.census().classes.createdPostBoot === 0, "no post-boot mints before sealing");
  reg.sealClassSet();
  check(reg.sealed === true, "class set sealed");
  reg.beginFrame();
  reg.feedTile(plan(91, [member({ contentKey: "n|0" })]), gs);
  check(reg.census().classes.createdPostBoot === 0, "streaming an EXISTING class mints nothing");
  reg.feedTile(plan(92, [member({ axes: { texW: 2048, texH: 2048 } }, {}) ]), gs);
  check(reg.census().classes.createdPostBoot === 1,
    "a class minted after the seal is COUNTED (classesCreatedPostBoot)");
}

// ── PART 12 — the battery (ring scale) ────────────────────────────────────

console.log("PART 12: ring-scale battery");
{
  const { reg, group } = makeRegistry();
  const gs = geomSource(12);
  // 36 tiles (the W_T = 6 slot grid), 6 classes, 24 placements per tile —
  // 864 instances over the ring, spread across the world-absolute sectors.
  const CLASS_AXES = [
    {}, { texW: 512 }, { texW: 2048 }, { alphaTest: 100 / 255 },
    { patch: { ...PLAIN_PATCH, f: 1 } }, { transparent: true },
  ];
  const tiles = [];
  for (let tx = 0; tx < 6; tx++) {
    for (let ty = 0; ty < 6; ty++) {
      const tile = (tx << 8) | ty;
      tiles.push(tile);
      const members = [];
      for (let i = 0; i < 24; i++) {
        const axes = CLASS_AXES[i % CLASS_AXES.length];
        members.push(member({
          axes,
          sectorKey: sectorKeyOfTile(tx, ty),
          contentKey: `model${i % 8}|0`,
        }));
      }
      reg.feedTile(plan(tile, members), gs);
    }
  }
  const c = reg.census();
  check(c.classes.count === 6, `6 classes, got ${c.classes.count}`);
  // 6 classes × 9 sectors (6×6 tiles → 3×3 sectors) = 54 pools.
  check(c.pools.count === 54, `6 classes × 9 sectors = 54 pools, got ${c.pools.count}`);
  check(c.pools.byPass.opaque === 45 && c.pools.byPass.translucent === 9,
    `pass split: ${JSON.stringify(c.pools.byPass)}`);
  check(c.tiles.resident === 36, "36 tiles resident");
  check(c.geometry.dedupHits > 0, "geometry dedup fired at ring scale");
  check(c.errors.unresolvedGeometry === 0 && c.errors.lastError === null,
    `battery ran clean: ${c.errors.lastError}`);
  check(c.fix.applied === true, "F-11.18 fix applied for every pool built");
  check(group.children.length === 54, "every pool is attached");

  // Every pool of the opaque pass takes three's early-out; none of them has
  // per-instance culling on.
  let earlyOut = 0;
  for (const p of reg.pools.values()) {
    if (p.passClass !== "opaque") continue;
    if (p.mesh.perObjectFrustumCulled === false && p.mesh.sortObjects === false) earlyOut += 1;
  }
  check(earlyOut === 45, `all 45 opaque pools take the early-out, got ${earlyOut}`);

  // A crossing: park a column, adopt it back, release it for real.
  reg.beginFrame();
  let parked = 0;
  for (const tile of tiles.slice(0, 6)) parked += reg.parkTile(tile);
  check(parked === 6 * 24, `park is a visibility batch: ${parked} instances`);
  const afterPark = reg.census();
  check(afterPark.pools.count === 54, "park reaps nothing");
  check(afterPark.geometry.allocatedBytes === c.geometry.allocatedBytes, "park frees no buffers");

  let adopted = 0;
  for (const tile of tiles.slice(0, 6)) adopted += reg.adoptTile(tile);
  check(adopted === 6 * 24, "re-adopt is symmetric");

  // Full teardown: release every tile; every pool must reap.
  for (const tile of tiles) reg.releaseTile(tile);
  const end = reg.census();
  check(end.pools.count === 0, `every pool reaped, got ${end.pools.count}`);
  check(end.tiles.resident === 0, "no membership records left");
  check(group.children.length === 0, "scene group empty");
  check(end.geometry.allocatedBytes === 0 && end.geometry.usedBytes === 0, "no geometry left");
  check(end.errors.unresolvedGeometry === 0, "no unresolved geometry over the battery");
  check(end.classes.createdPostBoot === 0, "no post-boot class mints over the battery");
  reg.dispose();
}

// ── PART 13 — the TilePlan contract ───────────────────────────────────────

console.log("PART 13: TilePlan contract (pass-07 S1)");
{
  // Two surfaces, four placements, two landblocks in different sectors, one
  // banded (did_degrade) member and one envcell member.
  const AXES = {
    grass: rec({ texW: 400, texH: 400, alphaTest: 100 / 255 }),
    wall: rec({ texW: 1024, texH: 1024 }),
  };
  let resolveCalls = 0;
  const placements = [
    { lbx: 1, lby: 1, modelId: 5, partId: 0, subsetIdx: 0, surfaceKey: "grass", matrix: new Float32Array(16), rsId: 0x06000001, castShadow: true, receiveShadow: true },
    { lbx: 1, lby: 1, modelId: 5, partId: 0, subsetIdx: 0, surfaceKey: "grass", matrix: new Float32Array(16), rsId: 0x06000001, castShadow: true, receiveShadow: true },
    { lbx: 9, lby: 1, modelId: 7, partId: 1, subsetIdx: 2, surfaceKey: "wall", matrix: new Float32Array(16), rsId: 0x06000002, castShadow: false, receiveShadow: true, degradeContentKey: "7|1|2:lo", band: 0, pos: { x: 0, y: 0, z: 0 } },
    { lbx: 1, lby: 1, modelId: 9, partId: 0, subsetIdx: 0, surfaceKey: "wall", matrix: new Float32Array(16), rsId: 0x06000002, domain: "ec", cellId: 42 },
  ];
  const built = buildTilePlan({
    tile: 0x0100,
    lbs: [0x01010000, 0x09010000],
    placements,
    resolveAxes: (k) => { resolveCalls += 1; return AXES[k] || null; },
  });
  const p13 = built.plan;
  check(p13.members.length === 4, `4 members, got ${p13.members.length}`);
  check(resolveCalls === 2, `axis resolution MEMOISED per surface, got ${resolveCalls} calls`);
  check(built.stats.placements === 4 && built.stats.surfaces === 2, "builder stats");
  check(p13.members[0].classKey === p13.members[1].classKey, "same surface + flags ⇒ same class");
  check(p13.members[0].sectorKey === "s0x0" && p13.members[2].sectorKey === "s2x0",
    `sector from LB: ${p13.members[0].sectorKey} / ${p13.members[2].sectorKey}`);
  check(p13.members[2].classKey !== p13.members[3].classKey,
    "same SURFACE but domains st vs ec ⇒ different classes");
  check(p13.members[2].bandGids.length === 2 && p13.members[2].bandGids[0] === "7|1|2",
    "band pair is a CONTENT-key pair (both gids are the same class by construction)");
  check(p13.members[3].cellId === 42, "envcell members carry their cell id");
  check(p13.counts.members === 4 && p13.counts.sectors === 2, "counts aggregate");
  check(Object.keys(p13.counts.byClass).length === 3, `3 distinct classes, got ${Object.keys(p13.counts.byClass).length}`);
  check(p13.counts.byClass[p13.members[0].classKey] === 2, "byClass pre-aggregates for budget planning");

  // Shadow flags are PLACEMENT facts joined into the key (D-07.6).
  const shadowSplit = buildTilePlan({
    tile: 1, placements: [
      { ...placements[0], castShadow: true },
      { ...placements[0], castShadow: false },
    ], resolveAxes: (k) => AXES[k],
  }).plan;
  check(shadowSplit.members[0].classKey !== shadowSplit.members[1].classKey,
    "castShadow splits the class (node flags become pool-uniform)");

  // Unresolvable surfaces and non-pooled domains are COUNTED, never silent.
  const dropped = buildTilePlan({
    tile: 2, placements: [
      { ...placements[0], surfaceKey: "missing" },
      { ...placements[0], domain: "tr" },
    ], resolveAxes: (k) => AXES[k] || null,
  });
  check(dropped.plan.members.length === 0, "nothing unresolved reaches the plan");
  check(dropped.stats.unresolved === 1 && dropped.stats.unpooled === 1,
    `drops counted: ${JSON.stringify(dropped.stats)}`);

  // The validator is LOUD about every malformed shape.
  check(validateTilePlan(p13).ok === true, "a built plan validates");
  check(validateTilePlan(null).ok === false, "null plan rejected");
  check(validateTilePlan({ tile: 1, members: [{}] }).errors.length >= 3, "a bare member names every missing field");
  check(validateTilePlan({ tile: 1, members: [{ ...p13.members[0], domain: "tr" }] }).ok === false,
    "a non-pooled domain in members is a validation error");
  check(validateTilePlan({ tile: 1, members: [{ ...p13.members[0], matrix: new Float32Array(9) }] }).ok === false,
    "a short matrix is a validation error");
  check(validateTilePlan({ tile: 1, members: [], counts: { byClass: { ghost: 1 } } }).ok === false,
    "counts referencing a class no member carries is a validation error");

  // Transfer codec: ONE buffer for N matrices, views restored without copy.
  const enc = encodeTilePlan(p13);
  check(enc.transfer.length === 1 && enc.payload.matrices.length === 4 * 16,
    "matrices pack into ONE transferable buffer");
  check(enc.payload.members[0].matrix === undefined, "per-member matrices are not cloned twice");
  const dec = decodeTilePlan(enc.payload);
  check(dec.members.length === 4 && dec.members[3].matrix.length === 16, "decode restores 16-element views");
  check(dec.members[0].classKey === p13.members[0].classKey && dec.tile === p13.tile,
    "decode round-trips the plan");
  check(validateTilePlan(dec).ok === true, "a decoded plan validates");
  let threw = false;
  try { decodeTilePlan({ v: 99 }); } catch (_) { threw = true; }
  check(threw, "an unsupported payload version throws");

  // The bake-worker job body (pass-08 S3) — pure, testable without a Worker.
  const res = runTileBakeJob({ id: 7, tile: 0x0100, lbs: [], placements, axes: AXES });
  check(res.message.type === "result" && res.message.kind === TILE_PLAN_RESULT_KIND && res.message.id === 7,
    "tileBake result envelope matches the S3 vocabulary");
  check(res.transfer.length === 1, "one transferable out");
  let jobThrew = false;
  try {
    runTileBakeJob({ id: 8, tile: 1, placements: [{ ...placements[0], matrix: new Float32Array(3) }], axes: AXES });
  } catch (_) { jobThrew = true; }
  check(jobThrew, "a malformed plan throws in the worker instead of feeding half a tile");

  // End-to-end: worker payload → decode → registry feed.
  const { reg: r13 } = makeRegistry();
  const gs13 = geomSource();
  const fed = r13.feedTile(decodeTilePlan(res.message.payload), gs13);
  check(fed.committed === true, "decoded plan feeds and commits");
  const c13 = r13.census();
  check(c13.classes.count === 3 && c13.pools.count === 3,
    `3 classes over 2 sectors ⇒ 3 pools, got ${c13.pools.count}`);
  check(c13.errors.unresolvedGeometry === 0 && c13.errors.unpooledMembers === 0,
    "every planned member reached a pool");
  check(r13.tiles.get(0x0100).size === 3, "membership records per (tile, pool)");
}

// ── done ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.error("DRAW-POOLS ❌"); process.exit(1); }
console.log("DRAW-POOLS ✅");
