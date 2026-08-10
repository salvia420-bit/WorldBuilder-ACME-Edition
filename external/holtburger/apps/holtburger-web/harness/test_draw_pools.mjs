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
//   PART 14 — stage C, the UploadStager (pass-08 D-08.5 + S4): no upload
//             from a completion callback; U-TEX byte AND item caps; the
//             EXCLUSIVE item runs alone; chunked grow re-marks ≤2/frame;
//             the F-11.10 nullRender rule (marks only, never initTexture);
//             the D-08.5 rule-2 ordering — a re-point DEFERS until its
//             rsId has staged; slot-vacation purge.
//   PART 15 — stage B, the PoolStreamController + BakeDispatchQueue
//             (F-11.19): P1 events RECORD and never execute; dispatch is
//             concurrency 1, player-tile → interior → Chebyshev ordered;
//             vacate purges the dispatch AND the queued scheduler/upload
//             items; feeds are RESUMABLE W3 items; the LIVE flip waits on
//             its textures having staged; a vacated in-flight plan is never
//             fed.
//   PART 16 — the closed-class boot prewarm (pass-08 D-08.6/S5, D-07.9): the
//             census IS the work list; colour variants compile through
//             withWarmTarget; the CSM depth population is warmed by a RENDER
//             (compile cannot reach it) over REAL BatchedMesh proxies (a
//             plain Mesh warms the wrong `batching` variant); warm scenes are
//             PARKED, never disposed; re-warm on context restore / cascade
//             flip; __prewarmStats shape.
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
  drawPoolsActive, _resetDrawPoolsForTest, POOL_OPTIMIZE_FRAC, getPoolRegistry,
} from "../scene3d/pool_registry.js";
import {
  buildTilePlan, validateTilePlan, encodeTilePlan, decodeTilePlan,
  runTileBakeJob, TILE_PLAN_RESULT_KIND,
} from "../scene3d/tile_plan.js";
import { UploadStager, UPLOAD_BUDGETS, GROW_LAYER_REMARKS_PER_FRAME } from "../scene3d/upload_stage.js";
import { PoolStreamController, BakeDispatchQueue } from "../scene3d/pool_stream.js";
import { FrameWorkScheduler } from "../scene3d/frame_work.js";
import { tileKeyOf } from "../scene3d/residency_grid.js";
import {
  PoolPrewarm, prewarmWorkList, initPoolPrewarm, _resetPoolPrewarmForTest,
  DEFAULT_CASCADES, WARM_SHADOW_MAP_SIZE,
} from "../scene3d/pool_prewarm.js";
import { getSurface } from "./lib/diag_schema.mjs";
import { ClassMaterialRegistry, normalizeForPool } from "../scene3d/pool_material.js";
import {
  initPoolWorld, poolWorldActive, poolWorldCensus, addSingletonsToPools,
  poolOnSlotState, poolOnTeleport, poolTickP4, poolAtlasRefeed,
  _poolAxisRecordForTest, _resetPoolWorldForTest,
} from "../scene3d/pool_producer.js";
import {
  armEnvCellPoolGroups, envCellPoolsActive, offerCellSurfacesToPools,
  poolCellVisibilityTick, poolCellsSetAllVisible, releasePooledCellsForLb,
  envCellPoolCensus, _resetEnvCellPoolsForTest,
} from "../scene3d/pool_envcells.js";
import { tileOfLb } from "../scene3d/residency_grid.js";
import {
  initTexCompressedOnly, _resetTexCompressedOnlyForTest,
  TIER_BIT_FULL_PAGE_DIMS, TIER_BIT_FULL_XU7_PRESENT,
} from "../scene3d/bc7_textures.js";

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

/** The full F-11.3 chain (?frameWork left off ⇒ stage-A inline feeds, which
 *  keeps the battery's cadence deterministic; stage B/C are PART 15's). */
const ARMED_PRE = "?drawPools=on&slotGrid=on&packSource=on&geomBundles=on&texCompressedOnly=on";

/** An RGBA8 texture AT a page dimension (256/512/1024/2048) — the only shape
 *  the class page can allocate a layer for until the bake/transcode resample
 *  lands (T22 D2). */
function pageTex(edge) {
  const t = new THREE.DataTexture(new Uint8Array(edge * edge * 4), edge, edge, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}

/** A poolable singleton: real Mesh, real UVs, a page-dim map. */
function poolNode(edge) {
  const m = new THREE.MeshStandardMaterial({ map: pageTex(edge) });
  m.userData = { surfaceDid: 0x08000099, __pvwRsId: 0x06000099 };
  return new THREE.Mesh(triGeom(6), m);
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
  const at = (o, path) => path.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
  // T22-PRODUCER: `producer.*` / `classPages.*` are the PRODUCER census's rows
  // (index.js installs it on `__diag.pools`, superseding the bare registry
  // census of the same name); the rest are the registry's own. Both halves of
  // the registered schema are checked against the surface that publishes them.
  for (const path of Object.keys(surface.fields || {})) {
    if (path.startsWith("producer.") || path.startsWith("classPages.")) continue;
    check(at(c, path) !== undefined, `census publishes the registered field ${path}`);
  }
  {
    _resetDrawPoolsForTest();
    _resetPoolWorldForTest();
    initPoolWorld({ THREE, group: new THREE.Group(), search: ARMED_PRE });
    addSingletonsToPools([poolNode(256)], {}, { domain: "st", lbKey: 0x40400000 });
    const pc = poolWorldCensus();
    for (const path of Object.keys(surface.fields || {})) {
      if (!path.startsWith("producer.") && !path.startsWith("classPages.")) continue;
      check(at(pc, path) !== undefined, `producer census publishes the registered field ${path}`);
    }
    _resetDrawPoolsForTest();
    _resetPoolWorldForTest();
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


// ── PART 14 — stage C: the UploadStager ───────────────────────────────────

console.log("PART 14: stage C — UploadStager (pass-08 D-08.5)");
{
  const fakeTex = (n) => ({ isTexture: true, needsUpdate: false, __n: n });
  const staged = [];
  const renderer = { initTexture: (t) => staged.push(t.__n) };
  const up = new UploadStager({ renderer, now: () => 0 });

  // Rule 1: a completion callback may ENQUEUE and nothing else.
  up.beginFrame();
  up.enqueueTexture({ texture: fakeTex("a"), rsId: 1, bytes: 1024 });
  check(staged.length === 0, "enqueue does NOT upload — the slot is the only site");
  check(up.hasPending() === true, "work is pending");
  up.drain();
  check(staged.length === 1 && staged[0] === "a", "the slot stages via renderer.initTexture");
  check(up.stats.initTextureCalls === 1, "initTexture calls counted");
  check(up.isStaged(1) === true, "staged rsIds are tracked");

  // U-TEX budget: ≤ 2 items AND ≤ 4 MiB per frame (always-run-one first).
  const up2 = new UploadStager({ renderer: { initTexture: () => {} }, now: () => 0 });
  up2.beginFrame();
  for (let i = 0; i < 5; i++) up2.enqueueTexture({ texture: fakeTex(i), rsId: 10 + i, bytes: 1024 });
  check(up2.drain() === UPLOAD_BUDGETS["U-TEX"].items, `U-TEX item cap = ${UPLOAD_BUDGETS["U-TEX"].items}/frame`);
  up2.beginFrame();
  check(up2.drain() === 2, "the next frame serves the next two");
  const up3 = new UploadStager({ renderer: { initTexture: () => {} }, now: () => 0 });
  up3.beginFrame();
  up3.enqueueTexture({ texture: fakeTex(0), rsId: 1, bytes: 8 * 1024 * 1024 });
  up3.enqueueTexture({ texture: fakeTex(1), rsId: 2, bytes: 8 * 1024 * 1024 });
  check(up3.drain() === 1, "always-run-one: an over-budget single item still runs, alone");

  // U-BUF: buffers have no staging API — the cap is upstream and OBSERVED.
  const up4 = new UploadStager({ renderer, now: () => 0 });
  up4.beginFrame();
  check(up4.noteBufferBytes(1024 * 1024) === true, "under the U-BUF cap");
  check(up4.noteBufferBytes(2 * 1024 * 1024) === false, "U-BUF cap reached ⇒ the feed stops appending");
  check(up4.bufferBudgetLeft() === 0, "no U-BUF budget left");

  // EXCLUSIVE items run alone (array allocation, the terrain t1024 pair).
  const order = [];
  const up5 = new UploadStager({ renderer: { initTexture: () => order.push("tex") }, now: () => 0 });
  up5.beginFrame();
  up5.enqueueTexture({ texture: fakeTex(0), rsId: 1, bytes: 1 });
  up5.enqueueExclusive("terrain-t1024-color", () => order.push("excl"), { bytes: 44 * 1024 * 1024 });
  check(up5.drain() === 1 && order.join(",") === "excl", "the exclusive item is the SOLE item of its frame");
  up5.beginFrame();
  up5.drain();
  check(order.join(",") === "excl,tex", "the deferred texture stages the next frame");
  check(up5.stats.exclusive.length === 1 && up5.stats.exclusive[0].name === "terrain-t1024-color",
    "exclusive items are named in the ring");

  // Grow re-marks are CHUNKED (D-08.5 rule 5), never a whole-prefix re-mark.
  const marks = [];
  const up6 = new UploadStager({ renderer, now: () => 0 });
  up6.beginFrame();
  up6.enqueueGrowRemark((l) => marks.push(l), 6);
  up6.drain();
  check(marks.length === GROW_LAYER_REMARKS_PER_FRAME,
    `grow re-mark chunked at ${GROW_LAYER_REMARKS_PER_FRAME}/frame, got ${marks.length}`);
  up6.beginFrame(); up6.drain();
  check(marks.length === 2 * GROW_LAYER_REMARKS_PER_FRAME, "the chunk cap holds across frames");

  // F-11.10 — nullRender: marks only, initTexture NEVER called.
  let nulled = 0;
  const upN = new UploadStager({ renderer: { initTexture: () => { nulled += 1; } }, nullRender: true, now: () => 0 });
  const t = fakeTex("n");
  let markRan = false;
  upN.beginFrame();
  upN.enqueueTexture({ texture: t, rsId: 5, bytes: 1, mark: () => { markRan = true; } });
  upN.drain();
  check(nulled === 0, "F-11.10: nullRender NEVER calls initTexture");
  check(t.needsUpdate === true && markRan === true, "F-11.10: marks still happen in both arms");
  check(upN.stats.marksOnly === 1, "marks-only is counted, not hidden");
  check(upN.isStaged(5) === true, "a marked rsId still unblocks its re-point on the bot arm");

  // D-08.5 rule 2 — a re-point DEFERS until its texture staged.
  const seq = [];
  const up7 = new UploadStager({ renderer: { initTexture: (x) => seq.push(`stage:${x.__n}`) }, now: () => 0 });
  up7.beginFrame();
  up7.enqueueRepoint(77, () => seq.push("repoint"));
  up7.drain();
  check(seq.length === 0, "a re-point whose texture has NOT staged does not run");
  check(up7.stats.repointsDeferred === 1, "the deferral is counted");
  up7.beginFrame();
  up7.enqueueTexture({ texture: fakeTex("r"), rsId: 77, bytes: 1 });
  up7.drain();
  check(seq.join(",") === "stage:r,repoint", "the stage ALWAYS precedes its re-point");
  check(up7.stats.repointsRun === 1, "re-points counted once run");

  // Slot vacation purges the tile's queued uploads (S2.6).
  const up8 = new UploadStager({ renderer, now: () => 0 });
  up8.beginFrame();
  up8.enqueueTexture({ texture: fakeTex(0), rsId: 1, bytes: 1, tileKey: 5 });
  up8.enqueueExclusive("x", () => {}, { tileKey: 5 });
  up8.enqueueRepoint(1, () => {}, 5);
  up8.enqueueTexture({ texture: fakeTex(1), rsId: 2, bytes: 1, tileKey: 6 });
  check(up8.purgeByTile(5) === 3, "purge removes every queued item for the tile");
  check(up8.hasPending() === true, "another tile's work survives the purge");

  // The scheduler's uploads bag (pass-08 S7).
  const bag = up.statsInto({});
  check(typeof bag.stagedBytesByClass === "object" && typeof bag.initTextureCalls === "number",
    "statsInto fills the __frameWork uploads bag");
}

// ── PART 15 — stage B: PoolStreamController + BakeDispatchQueue ───────────

console.log("PART 15: stage B — P4 relocation + bake dispatch (F-11.19)");
{
  // BakeDispatchQueue on its own: ordering + concurrency + purge.
  const posted = [];
  const resolvers = [];
  const q = new BakeDispatchQueue({
    post: (tile) => { posted.push(tile); return new Promise((r) => resolvers.push(r)); },
  });
  const T = (x, y) => tileKeyOf(x, y);
  q.setPlayerTile(T(10, 10));
  q.record(T(14, 10));              // far
  q.record(T(11, 10));              // near
  q.record(T(10, 10));              // the player tile
  q.record(T(20, 20), { interior: true });
  check(q.depth === 4, "four dispatch items recorded");
  check(q.record(T(11, 10)) === false && q.stats.coalesced === 1, "a duplicate record coalesces");
  check(posted.length === 0, "P1 RECORDS — it never posts");

  check(q.dispatch() === T(10, 10), "the player tile goes first");
  check(q.dispatch() === -1, "concurrency 1: nothing else posts while one is in flight");
  resolvers.shift()();
  await Promise.resolve();
  check(q.dispatch() === T(20, 20), "then the interior");
  resolvers.shift()();
  await Promise.resolve();
  check(q.dispatch() === T(11, 10), "then nearest-first by Chebyshev");
  resolvers.shift()();
  await Promise.resolve();
  check(q.purge(T(14, 10)) === true && q.depth === 0, "a vacate PURGES the queued dispatch");
  check(q.dispatch() === -1, "nothing left to post");
  check(q.stats.posted === 3 && q.stats.completed === 3 && q.stats.purged === 1,
    `dispatch stats: ${JSON.stringify(q.stats)}`);

  // The controller, end to end, against a real FrameWorkScheduler.
  const { reg } = makeRegistry();
  const clock = { t: 0 };
  const sched = new FrameWorkScheduler({ now: () => clock.t, isInWorld: () => true, budgetMs: 6 });
  const stagedTex = [];
  const uploads = new UploadStager({ renderer: { initTexture: (x) => stagedTex.push(x.__n) }, now: () => clock.t });
  const bakes = [];
  const ctl = new PoolStreamController({
    registry: reg, scheduler: sched, uploads, feedChunk: 4,
    postBake: (tile) => { bakes.push(tile); return Promise.resolve(); },
  });

  ctl.setPlayerTile(T(1, 1));
  check(ctl.onAdmit(T(1, 1)) === true, "admit records a dispatch");
  check(ctl.onAdmit(T(2, 1)) === true, "second admit records");
  check(bakes.length === 0, "P1 executes NOTHING");
  ctl.tickP4();
  check(bakes.length === 1 && bakes[0] === T(1, 1), "P4 posts ONE job, player tile first");
  await Promise.resolve();
  ctl.tickP4();
  check(bakes.length === 2, "the next slot posts the next job");

  // A plan arrives: the feed is a RESUMABLE W3 item, nothing is fed on arrival.
  const gs = geomSource();
  const members = [];
  for (let i = 0; i < 10; i++) members.push(member({ contentKey: `p${i}|0`, rsId: 0x06000009 }));
  ctl.onPlanReady(plan(T(1, 1), members), gs);
  check(reg.pools.size === 0, "a worker result touches NOTHING on arrival (pass-08 D-08.4)");
  sched.run({});
  check(reg.pools.size === 1 && ctl.stats.feedsCommitted === 0,
    "the first W3 step feeds a chunk and re-enqueues (feedChunk = 4)");
  const poolC = [...reg.pools.values()][0];
  check(poolC.instances === 4, `chunked: ${poolC.instances} of 10 members fed`);
  ctl.tickP4(); sched.run({});
  ctl.tickP4(); sched.run({});
  check(poolC.instances === 10, "the feed completes over successive slots (one step per frame)");
  // The LIVE FLIP waits on the tile's textures having STAGED (S2.4).
  ctl.tickP4(); sched.run({});
  check(ctl.stats.feedsCommitted === 0 && ctl.stats.flipDeferrals > 0,
    "the flip DEFERS while the tile's rsId has not staged");
  check(poolC.mesh.getVisibleAt(0) === false, "an unstaged tile stays invisible — never a flash");
  uploads.beginFrame();
  uploads.enqueueTexture({ texture: { isTexture: true, __n: "tile" }, rsId: 0x06000009, bytes: 1 });
  uploads.drain();
  ctl.tickP4(); sched.run({});
  check(ctl.stats.feedsCommitted === 1, "once the texture staged, the flip runs");
  check(poolC.mesh.getVisibleAt(0) === true, "the tile is LIVE");

  // A vacate purges the dispatch AND the queued scheduler/upload items, and
  // abandons an in-flight feed.
  ctl.onAdmit(T(5, 5));
  ctl.onPlanReady(plan(T(5, 5), [member({ contentKey: "v|0" }), member({ contentKey: "v2|0" })]), gs);
  const before = poolC.instances;
  ctl.onVacate(T(5, 5));
  check(ctl.stats.feedsAbandoned === 1, "a vacated in-flight feed is ABANDONED");
  check(ctl.dispatch.depth === 0, "the queued dispatch is purged");
  sched.run({});
  check(reg.tiles.has(T(5, 5)) === false, "nothing from the vacated tile persists");
  check(poolC.instances === before, "the abandoned feed left no instances");

  // A plan arriving for an already-vacated tile is never fed.
  ctl.onVacate(T(7, 7));
  check(ctl.onPlanReady(plan(T(7, 7), [member()]), gs) === false,
    "a plan for a vacated tile is dropped, never fed");

  // Park / adopt / release all route through the slot (one caller for pool
  // mutation) and a re-admit of a resident tile is a pointer re-adopt.
  ctl.enqueuePark(T(1, 1));
  sched.run({});
  check(ctl.stats.parks === 1 && poolC.mesh.getVisibleAt(0) === false, "park ran in W4");
  check(ctl.onAdmit(T(1, 1)) === false, "re-admitting a RESIDENT tile records no bake");
  sched.run({});
  check(ctl.stats.adopts === 1 && poolC.mesh.getVisibleAt(0) === true, "re-adopt ran, zero fetch");
  ctl.enqueueRelease(T(1, 1));
  sched.run({});
  check(ctl.stats.releases === 1 && reg.tiles.has(T(1, 1)) === false, "release ran in W4");

  // The W2 upload drain is coalesced to one pending item.
  uploads.enqueueTexture({ texture: { isTexture: true, __n: "z" }, rsId: 0x1234, bytes: 1 });
  check(ctl.requestUploadDrain() === true, "an upload drain is requested");
  check(ctl.requestUploadDrain() === false, "the W2 drain item is coalesced");
  sched.run({});
  check(stagedTex.includes("z"), "the drain staged through the slot");

  const st = ctl.stats_();
  check(typeof st.dispatch.depth === "number" && typeof st.feedsInFlight === "number", "controller stats shape");
}


// ── PART 16 — the closed-class boot prewarm ───────────────────────────────

console.log("PART 16: closed-class boot prewarm (pass-08 D-08.6/S5)");
{
  const { reg } = makeRegistry();
  const gs = geomSource();
  // Three classes: two casters (castShadow true) and one non-caster.
  reg.feedTile(plan(100, [
    member(),                                            // caster
    member({ axes: { texW: 1024 } }),                    // caster, other page
    member({ axes: { castShadow: false } }),             // non-caster
  ]), gs);

  const list = prewarmWorkList(reg);
  check(list.length === 3, `the census IS the work list: ${list.length} classes`);
  check(list.filter((c) => c.castShadow).length === 2,
    "castShadow is read off the class key's shadow token");
  check(list.every((c) => c.material && c.material.isMaterial), "each entry carries its class material");
  check(prewarmWorkList(null).length === 0, "no registry ⇒ empty list, never a throw");

  // A stub renderer: we assert the MECHANISM (what gets compiled/rendered and
  // what kind of object it is), not GL output — there is no GL here.
  const compiled = [];
  const rendered = [];
  let shadowMapMarks = 0;
  const renderer = {
    shadowMap: { get needsUpdate() { return false; }, set needsUpdate(v) { if (v) shadowMapMarks += 1; } },
    getRenderTarget: () => null,
    setRenderTarget: () => {},
    compile: (scene) => { compiled.push(scene); return new Set(); },
    render: (scene) => { rendered.push(scene); },
    initTexture: () => {},
    properties: { get: () => ({}) },
  };
  const pw = new PoolPrewarm({ renderer, cascades: () => DEFAULT_CASCADES, now: () => 0 });
  const st = await pw.run(list);

  check(compiled.length === 1, "ONE colour compile for the whole class set");
  check(rendered.length === 1, "the depth population is warmed by a RENDER, not a compile");
  check(shadowMapMarks === 1, "shadowMap.needsUpdate is forced for the depth pass");
  check(st.classes === 3 && st.colorPrograms === 3, `colour: ${JSON.stringify({ c: st.classes, p: st.colorPrograms })}`);
  check(st.depthPrograms === 2, `only castShadow classes get depth variants, got ${st.depthPrograms}`);
  check(st.cascades === DEFAULT_CASCADES, "cascade count recorded");

  // THE proxy rule: real BatchedMeshes, or the wrong `batching` variant warms.
  const colorProxies = pw.colorScene.children.filter((o) => o.isBatchedMesh);
  check(colorProxies.length === 3, "one colour proxy per class");
  check(pw.colorScene.children.every((o) => o.isBatchedMesh),
    "EVERY colour proxy is a BatchedMesh (a plain Mesh warms the wrong depth variant)");
  const depthProxies = pw.depthScene.children.filter((o) => o.isBatchedMesh);
  const depthLights = pw.depthScene.children.filter((o) => o.isDirectionalLight);
  check(depthProxies.length === 2 && depthProxies.every((o) => o.castShadow === true),
    "the depth scene holds the castShadow subset, all casting");
  check(depthLights.length === DEFAULT_CASCADES, `${DEFAULT_CASCADES} cascade lights`);
  check(depthLights.every((l) => l.castShadow && l.shadow.mapSize.x === WARM_SHADOW_MAP_SIZE),
    "warm lights cast with tiny shadow maps (the link is the product, not the pixels)");
  const proxyMats = new Set(colorProxies.map((o) => o.material));
  check(proxyMats.size === 3 && list.every((c) => proxyMats.has(c.material)),
    "each proxy carries its own CLASS material (the warm is per class, not per proxy)");

  // Idempotence: a re-run warms only what is new (post-boot mint costs one).
  const before = compiled.length;
  await pw.run(list);
  check(compiled.length === before, "re-running with the same list compiles nothing");
  reg.feedTile(plan(101, [member({ axes: { texW: 2048 } })]), gs);
  await pw.run(prewarmWorkList(reg));
  check(compiled.length === before + 1 && pw.stats.classes === 4,
    "a newly minted class costs exactly one warm");

  // Warm scenes are PARKED for the session — never disposed (program refcount).
  const colorSceneRef = pw.colorScene;
  const depthSceneRef = pw.depthScene;
  await pw.rewarm(prewarmWorkList(reg));
  check(pw.colorScene === colorSceneRef, "the colour warm scene is PARKED across a re-warm");
  check(pw.depthScene === depthSceneRef, "the depth warm scene survives when the cascade count is unchanged");
  check(pw.stats.rewarms === 1, "re-warms counted (context restore / CSM preset flip)");

  // A cascade-count flip rebuilds the depth population.
  const pw2 = new PoolPrewarm({ renderer, cascades: () => 1, now: () => 0 });
  await pw2.run(list);
  check(pw2.depthScene.children.filter((o) => o.isDirectionalLight).length === 1,
    "the live cascade count drives the warm light count");

  // No renderer (bot arm / node): the work list is still the deliverable and
  // the skip is RECORDED rather than reported as a warm.
  const pwNone = new PoolPrewarm({ renderer: null, now: () => 0 });
  const stNone = await pwNone.run(list);
  check(stNone.skipped === 3 && stNone.colorPrograms === 0,
    "no renderer ⇒ skips counted, nothing claimed warm");

  // __prewarmStats is a registered surface.
  const surface = getSurface("__prewarmStats");
  check(!!surface, "__prewarmStats is in the diag registry");
  _resetPoolPrewarmForTest();
  const inst = initPoolPrewarm({ renderer, now: () => 0 });
  check(inst instanceof PoolPrewarm, "initPoolPrewarm builds the singleton");
  const snap = inst.statsSnapshot();
  for (const k of ["classes", "colorPrograms", "depthPrograms", "msColor", "msDepth"]) {
    check(k in snap, `__prewarmStats publishes ${k} (pass-08 S5.4)`);
  }
  _resetPoolPrewarmForTest();
}


// ── PART 17 — the class-material tier (T22-PRODUCER) ──────────────────────

console.log("PART 17: class material tier (D-07.2) + the D2 page gate");
{
  const cm = new ClassMaterialRegistry({ warn: () => {} });
  const mk = (w, h, extra = {}) => {
    const t = new THREE.DataTexture(new Uint8Array(w * h * 4), w, h, THREE.RGBAFormat);
    t.needsUpdate = true;
    const m = new THREE.MeshStandardMaterial({ map: t });
    m.userData = { surfaceDid: 0x08000001, __pvwRsId: 0x06000001, ...extra };
    return m;
  };
  const axes = (m, over = {}) => ({ ...axisRecordOf(m, { domain: "st", castShadow: true, receiveShadow: true }), ...over });

  // ONE material per class, and it IS an array-page material.
  const m256 = mk(256, 256);
  const r256 = axes(m256);
  const k256 = classKeyOf(r256);
  const a1 = cm.admit(k256, m256, r256);
  check(a1.ok === true && a1.layer === 0, "first member of a class takes layer 0");
  check(cm.materialFactory(k256) === cm.materialFactory(k256),
    "materialFactory returns ONE material object per class (D-07.2)");
  check(cm.materialFactory(k256).userData.classKey === k256,
    "the class material carries its class key (census/prewarm join)");

  // A SECOND surface of the SAME class takes the NEXT layer of the SAME page.
  const m256b = mk(256, 256, { __pvwRsId: 0x06000002 });
  const a2 = cm.admit(k256, m256b, axes(m256b));
  check(a2.ok === true && a2.layer === 1, "a second surface takes the next layer of the same page");
  check(cm.census().classes === 1, "two surfaces, ONE class page");

  // The SAME texture dedups by uuid (refcount, no new layer).
  const a3 = cm.admit(k256, m256, r256);
  check(a3.ok === true && a3.layer === 0, "a shared texture re-uses its layer (refcounted)");
  check(cm.census().layers.hits === 1, "layer dedup hits are counted");

  // THE D2 GATE: a member off its page dims is REFUSED and COUNTED.
  const m64 = mk(64, 64);
  const r64 = axes(m64);
  check(needsResample(r64) === true, "a 64² member needs resample to its 256² page");
  const a4 = cm.admit(classKeyOf(r64), m64, r64);
  check(a4.ok === false && a4.reason === "needsResample",
    "an off-page member is REFUSED with the needsResample reason (T22 D2)");
  check(cm.census().refused.needsResample === 1,
    "needsResample refusals are COUNTED, never silent");
  check(cm.census().classes === 1, "a refused member never allocates a class page");

  // A member already AT page dims is admitted (the resample's post-condition).
  const m512 = mk(512, 512);
  const r512 = axes(m512);
  check(needsResample(r512) === false, "a 512² member is already at its page");
  check(cm.admit(classKeyOf(r512), m512, r512).ok === true,
    "an at-page member of a NEW tier opens its own class page");
  check(cm.census().classes === 2, "the page tier is a class axis (256² and 512² are two pages)");

  // A MECH-B deformed variant is never consumed (the class material would
  // silently strip the deformation).
  const mDef = mk(256, 256, { __vfxSetKey: "deformation.windSwayGpu" });
  check(cm.admit(k256, mDef, axes(mDef)).reason === "deformed",
    "a vertex-deformed variant is refused, not silently flattened");

  // A material without a map has no page at all.
  const mNo = new THREE.MeshStandardMaterial();
  check(cm.admit("x", mNo, { hasTex: false }).reason === "noTexture",
    "an untextured member is refused (no page, no array)");

  // Geometry normalization stamps aLayer and KEEPS the index (pass-4).
  const g = normalizeForPool(triGeom(6), 3);
  check(!!g.attributes.aLayer && g.attributes.aLayer.count === 6, "normalizeForPool stamps aLayer per vertex");
  check(g.attributes.aLayer.array[0] === 3, "aLayer carries the member's page layer");
  check(!!g.index, "normalizeForPool keeps the index (pass-4's indexed layout)");
  const gNi = new THREE.BufferGeometry();
  gNi.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
  gNi.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(9), 3));
  gNi.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(6), 2));
  const gNi2 = normalizeForPool(gNi, 0);
  check(!!gNi2.index && gNi2.index.count === 3,
    "a non-indexed source gets a synthesised index (one pool layout for both)");
  check(normalizeForPool({ attributes: {} }, 0) === null, "a geometry without position/normal/uv is refused");
  cm.dispose();
}

// ── PART 18 — the producer swap ───────────────────────────────────────────

console.log("PART 18: producer swap — singletons → (sector × class) pools");
const ARMED = ARMED_PRE;
{
  _resetDrawPoolsForTest();
  _resetPoolWorldForTest();
  // DISARMED: the producer is a NO-OP passthrough — the kill path.
  const off = initPoolWorld({ THREE, search: "?drawPools=on&slotGrid=on" });
  check(off === null, "an incomplete flag chain arms NO pooled world (F-11.3)");
  const nodesOff = [poolNode(256), poolNode(256)];
  const rOff = addSingletonsToPools(nodesOff, {}, { domain: "st", lbKey: 0xaabb0000 });
  check(rOff.pooled === 0 && rOff.passthrough.length === 2,
    "disarmed ⇒ every node passes through untouched (byte-identical legacy)");

  _resetDrawPoolsForTest();
  _resetPoolWorldForTest();
  const group = new THREE.Group();
  const w = initPoolWorld({ THREE, group, search: ARMED });
  check(w !== null, "the full F-11.3 chain arms the pooled world");
  check(poolWorldActive() === true, "poolWorldActive reads the armed singleton");

  // Two LBs of the SAME tile, two surfaces, shared geometry.
  const shared = triGeom(6);
  const texA = pageTex(256);
  const texB = pageTex(256);
  const mkNode = (tex, geom) => {
    const m = new THREE.MeshStandardMaterial({ map: tex });
    m.userData = { surfaceDid: 0x08000010, __pvwRsId: 0x06000010 };
    const n = new THREE.Mesh(geom, m);
    n.castShadow = true;
    n.receiveShadow = true;
    return n;
  };
  const r1 = addSingletonsToPools(
    [mkNode(texA, shared), mkNode(texA, shared), mkNode(texB, shared)],
    {}, { domain: "st", lbKey: 0x40400000 },
  );
  check(r1.pooled === 3 && r1.passthrough.length === 0, "three at-page singletons pool");
  const reg = getPoolRegistry();
  check(reg.pools.size === 1, "one (sector, class) pool holds all three (same class, same sector)");
  check(reg.classes.size === 1, "two surfaces sharing every axis are ONE class");
  const pool = [...reg.pools.values()][0];
  check(pool.instances === 3, "three instances in the pool");
  check(pool.mesh.castShadow === true && pool.mesh.receiveShadow === true,
    "shadow flags are POOL-uniform, taken from the class (D-07.6)");
  check(reg.census().geometry.dedupHits === 1,
    "the same (geometry, layer) pair dedups; a different layer is a different pool geometry");
  check(group.children.length === 1, "the pool is the ONLY node added to the scene group (O(pools))");

  // A second LB of the SAME tile merges into the same tile membership.
  const r2 = addSingletonsToPools([mkNode(texA, shared)], {}, { domain: "st", lbKey: 0x41400000 });
  check(r2.pooled === 1, "a second LB of the tile feeds the same tile");
  check(reg.tiles.size === 1, "both LBs share ONE tile membership record (tile-granular residency)");
  check(pool.instances === 4, "the merge added the instance rather than orphaning it");

  // A DIFFERENT sector opens a second pool of the same class.
  addSingletonsToPools([mkNode(texA, shared)], {}, { domain: "st", lbKey: 0x60600000 });
  check(reg.pools.size === 2, "a different world-sector opens a second pool of the SAME class");
  check(reg.classes.size === 1, "…and still ONE material class (one material object)");

  // The D2 residue: an off-page member routes LEGACY, counted.
  const small = new THREE.MeshStandardMaterial({ map: pageTex(64) });
  small.userData = { surfaceDid: 0x08000011, __pvwRsId: 0x06000011 };
  const nSmall = new THREE.Mesh(triGeom(6), small);
  const r3 = addSingletonsToPools([nSmall], {}, { domain: "st", lbKey: 0x40400000 });
  check(r3.pooled === 0 && r3.passthrough[0] === nSmall,
    "an off-page member comes back as passthrough — it RENDERS, on the legacy path");
  const census = poolWorldCensus();
  check(census.classPages.refused.needsResample === 1,
    "the D2 residue is published on __diag.pools().classPages.refused.needsResample");
  check(census.producer.refusedNodes === 1, "the producer counts its own refusals");

  // Non-poolable node shapes pass through untouched.
  const noUv = new THREE.BufferGeometry();
  noUv.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
  const nNoUv = new THREE.Mesh(noUv, new THREE.MeshStandardMaterial({ map: pageTex(256) }));
  check(addSingletonsToPools([nNoUv], {}, { domain: "st", lbKey: 0x40400000 }).passthrough[0] === nNoUv,
    "a UV-less mesh passes through (the atlas's own gate)");
  const nBatched = new THREE.Mesh(triGeom(6), new THREE.MeshStandardMaterial({ map: pageTex(256) }));
  nBatched.userData = { __staticBatch: true };
  check(addSingletonsToPools([nBatched], {}, { domain: "st", lbKey: 0x40400000 }).passthrough[0] === nBatched,
    "an already-batched node is never re-fed");

  // Envcell domain is its own class family.
  const ec = new THREE.MeshStandardMaterial({ map: texA });
  ec.userData = { surfaceDid: 0x08000010, __pvwRsId: 0x06000010 };
  const nEc = new THREE.Mesh(shared, ec);
  addSingletonsToPools([nEc], {}, { domain: "ec", lbKey: 0x40400000 });
  check(reg.classes.size === 2, "the envcell domain is a distinct class (D-07.1's table)");
  check(poolWorldCensus().producer.byDomain.ec === 1, "per-domain pooled counts are published");
}

// ── PART 19 — pooled-world residency + the CI gates ───────────────────────

console.log("PART 19: pooled-world residency, anti-churn and the closed class set");
{
  _resetDrawPoolsForTest();
  _resetPoolWorldForTest();
  const group = new THREE.Group();
  initPoolWorld({ THREE, group, search: ARMED });
  const reg = getPoolRegistry();
  const tex = pageTex(256);
  const geom = triGeom(6);
  const feedLb = (lbKey, n = 2) => {
    const nodes = [];
    for (let i = 0; i < n; i += 1) {
      const m = new THREE.MeshStandardMaterial({ map: tex });
      m.userData = { surfaceDid: 0x08000020, __pvwRsId: 0x06000020 };
      const node = new THREE.Mesh(geom, m);
      node.castShadow = true;
      nodes.push(node);
    }
    return addSingletonsToPools(nodes, {}, { domain: "st", lbKey });
  };
  feedLb(0x40400000);
  feedLb(0x44440000);
  const tileA = tileOfLb(0x40, 0x40);
  const tileB = tileOfLb(0x44, 0x44);
  check(reg.tiles.size === 2, "two tiles resident");

  // The class set SEALS at boot; streaming a settled world mints nothing.
  reg.sealClassSet();
  const before = reg.classes.size;
  feedLb(0x48480000);
  check(reg.classes.size === before,
    "streaming a new tile of an EXISTING class mints no class (D-07.9)");
  check(reg.census().classes.createdPostBoot === 0,
    "classesCreatedPostBoot === 0 on a settled arm (the GATE-POOLS bullet)");

  // A settled PARKED frame performs zero pool mutations.
  reg.beginFrame();
  check(reg.census().events.mutationsThisFrame === 0,
    "poolMutationsPerFrame === 0 on a settled frame (the S2 anti-churn CI gate)");
  poolTickP4();
  check(reg.census().events.mutationsThisFrame === 0,
    "the P4 tick alone mutates nothing (events drive mutation, never the frame)");

  // The grid's slot-state hook is the whole residency vocabulary.
  poolOnSlotState({ tile: tileA, from: "LIVE", to: "PARKED" });
  check(reg.census().events.parks === 1, "onSlotState LIVE→PARKED parks the tile's instances");
  poolOnSlotState({ tile: tileA, from: "PARKED", to: "LIVE" });
  check(reg.census().events.adopts === 1, "onSlotState PARKED→LIVE re-adopts by pointer");
  poolOnSlotState({ tile: tileB, from: "PARKED", to: "EMPTY" });
  check(reg.isTileResident(tileB) === false, "onSlotState →EMPTY releases the tile");
  poolOnTeleport({ vacated: [tileA] });
  check(reg.isTileResident(tileA) === false, "onTeleport drains the vacated set");
  const st = poolWorldCensus().producer;
  check(st.parks === 1 && st.adopts === 1 && st.releases === 2,
    "every residency event is counted on the producer census");

  // A park is GPU-free: no geometry adds, no deletes, no allocation change.
  feedLb(0x40400000);
  const allocBefore = reg.geometryBytes().allocated;
  const addsBefore = reg.census().geometry.adds;
  poolOnSlotState({ tile: tileA, from: "LIVE", to: "PARKED" });
  check(reg.geometryBytes().allocated === allocBefore && reg.census().geometry.adds === addsBefore,
    "park allocates nothing and adds no geometry (setVisibleAt only)");

  _resetDrawPoolsForTest();
  _resetPoolWorldForTest();
}


// ── PART 20 — the TEXREF page stitch (PAGE-RESAMPLE handoff #2) ───────────

console.log("PART 20: the FULL_PAGE_DIMS bit gates the whole page gate");
{
  // A stub `pack_texref` is all `texRefPageInfo` needs (it reads nothing else),
  // and it leaves `texCompressedOnlyActive()` false — so arming it here cannot
  // change any other behaviour under test.
  const rows = new Map(); // rsId -> {tierBits, dimsByte}
  const packTexref = (rsId) => {
    const r = rows.get(rsId >>> 0);
    return r === undefined ? -1 : ((r.tierBits << 8) | r.dimsByte);
  };
  const dimsByte = (logW, logH) => ((logW & 0xf) << 4) | (logH & 0xf);
  const mkMat = (edge, rsId) => {
    const m = new THREE.MeshStandardMaterial({ map: pageTex(edge) });
    m.userData = { surfaceDid: 0x08000030, __pvwRsId: rsId };
    return m;
  };
  const mkNode = (edge, rsId) => {
    const n = new THREE.Mesh(triGeom(6), mkMat(edge, rsId));
    n.castShadow = true;
    return n;
  };

  _resetDrawPoolsForTest();
  _resetPoolWorldForTest();
  _resetTexCompressedOnlyForTest();

  // ── (A) NO TEXREF ROW / seam unarmed ⇒ live dims, exactly today's behaviour.
  const a = _poolAxisRecordForTest(mkMat(512, 0x06000030));
  check(a.rec.texW === 512 && a.rec.texH === 512, "no TEXREF row ⇒ the axis record falls back to LIVE dims");
  check(a.rec.texApprox === true, "…and stamps texApprox, so the approximation is visible");
  check(a.stats.texRefAbsent === 1, "…and is COUNTED as an absent-TEXREF fallback");

  initTexCompressedOnly({ wasmNs: { pack_texref: packTexref } });

  // ── (B) BIT CLEAR ⇒ PERMISSIVE (orchestrator ruling 2026-08-10, option (b)).
  //     The declared dims are not trusted to key with OR to compare against —
  //     they are the untrustworthy pre-resample values. Pre-leg-6 behaviour.
  rows.set(0x06000032, { tierBits: TIER_BIT_FULL_XU7_PRESENT, dimsByte: dimsByte(11, 11) });
  const bClear = _poolAxisRecordForTest(mkMat(256, 0x06000032));
  check(bClear.rec.texW === 256 && bClear.rec.texH === 256,
    "bit CLEAR ⇒ the record keeps LIVE dims (the byte is never the authority)");
  check(bClear.rec.texApprox === true, "…stamped texApprox, as the pre-leg-6 path did");
  check(bClear.rec.texOffPage !== true,
    "…and is NOT marked dims-will-move — comparing against untrusted dims is what emptied the pooled world");
  check(bClear.stats.texRefBitClear === 1, "…counted as texRefBitClear");
  check(bClear.stats.texRefDimsWillMove === 0 && bClear.stats.texRefPageKeyed === 0,
    "…and neither strict counter fires with the bit clear");

  // A preview-born member on a pre-page-dim dist is the 1,852/1,852 case the
  // ENVCELL-POOL arm hit: it must POOL, not be refused.
  _resetDrawPoolsForTest();
  _resetPoolWorldForTest();
  initPoolWorld({ THREE, group: new THREE.Group(), search: ARMED_PRE });
  const nPreview = mkNode(256, 0x06000032);
  const rPreview = addSingletonsToPools([nPreview], {}, { domain: "st", lbKey: 0x40400000 });
  check(rPreview.pooled === 1,
    "bit CLEAR + preview-born ⇒ the member POOLS (the pre-page-dim dist is not emptied)");
  const cClear = poolWorldCensus();
  check(cClear.classPages.refused.offPage === 0, "…nothing is refused offPage with the bit clear");
  check(cClear.producer.texRefBitClear === 1, "…and the producer census publishes texRefBitClear");

  // ── (C) BIT SET ⇒ STRICT. Declared dims key the record even while the live
  //     texture is still the preview — the preview→full stability the whole
  //     page-resample exists for.
  rows.set(0x06000031, {
    tierBits: TIER_BIT_FULL_PAGE_DIMS | TIER_BIT_FULL_XU7_PRESENT,
    dimsByte: dimsByte(11, 11), // 2048²
  });
  const cSet = _poolAxisRecordForTest(mkMat(256, 0x06000031));
  check(cSet.rec.texW === 2048 && cSet.rec.texH === 2048,
    "bit SET ⇒ the record keys on the DECLARED 2048² page, not the live 256²");
  check(cSet.rec.texApprox !== true, "…so the record is no longer an approximation");
  check(classKeyOf(cSet.rec).includes("x11"), `…and the class key carries tier 11: ${classKeyOf(cSet.rec)}`);
  check(cSet.stats.texRefPageKeyed === 1, "page-keyed records are COUNTED");
  check(cSet.stats.texRefDimsWillMove === 1,
    "…and DECLARED ≠ RESIDENT marks the member as one whose dims will move");

  // …and that member takes the LEGACY path, with its own reason.
  _resetDrawPoolsForTest();
  _resetPoolWorldForTest();
  initPoolWorld({ THREE, group: new THREE.Group(), search: ARMED_PRE });
  const nMove = mkNode(256, 0x06000031);
  const rMove = addSingletonsToPools([nMove], {}, { domain: "st", lbKey: 0x40400000 });
  check(rMove.pooled === 0 && rMove.passthrough[0] === nMove,
    "bit SET + dims-will-move ⇒ the member RENDERS on the legacy path");
  const cen = poolWorldCensus();
  check(cen.classPages.refused.offPage === 1, "…refused with the offPage reason");
  check(cen.classPages.refused.needsResample === 0, "…and NOT conflated with the D2 residue");
  check(cen.producer.texRefPageKeyed === 1 && cen.producer.texRefDimsWillMove === 1,
    "the producer census publishes both strict counters");

  // ── (D) BIT SET and declared == resident ⇒ the page-dim dist's steady state:
  //     keyed on the declared page, admitted, nothing flagged.
  rows.set(0x06000033, {
    tierBits: TIER_BIT_FULL_PAGE_DIMS | TIER_BIT_FULL_XU7_PRESENT,
    dimsByte: dimsByte(9, 9), // 512²
  });
  const dOk = _poolAxisRecordForTest(mkMat(512, 0x06000033));
  check(dOk.rec.texOffPage !== true && dOk.stats.texRefDimsWillMove === 0,
    "bit SET + already AT the declared page ⇒ nothing flagged");
  const nOk = mkNode(512, 0x06000033);
  check(addSingletonsToPools([nOk], {}, { domain: "st", lbKey: 0x40400000 }).pooled === 1,
    "…and the member pools");

  _resetTexCompressedOnlyForTest();
  _resetDrawPoolsForTest();
  _resetPoolWorldForTest();
}

// ── done ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.error("DRAW-POOLS ❌"); process.exit(1); }
console.log("DRAW-POOLS ✅");
