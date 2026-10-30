// scene3d/pool_registry.js — persistent (world-sector × material-class) draw
// pools (ST9 / T22; SPEC §1.5, pass-07 D-07.1/D-07.4/D-07.5/D-07.7/S1/S2/S5).
//
// WHAT THIS IS
// ------------
// A pool is ONE `THREE.BatchedMesh` holding every resident placement of one
// material CLASS (`pool_class_key.js`) within one world-SECTOR (2×2 tiles =
// 4×4 LBs = 768 m, world-absolute lattice — so a pass-6 anchor shift never
// re-homes an instance). Pools are created on first member, persist across
// all residency churn, and are reaped when empty.
//
// This module is the ONLY writer of pool membership (pass-07 S1), and every
// mutation it performs is triggered by a residency/PVS/LOD EVENT — never by
// the camera and never by "the frame ticked". `census().events
// .mutationsThisFrame` exists to make violations of that law visible; a
// settled parked frame must read 0 (S2's anti-churn invariant, a CI gate).
//
// THE THREE EARLY-OUT (D-07.4) — why the properties below are load-bearing
// ------------------------------------------------------------------------
// r184's `BatchedMesh.onBeforeRender` opens with
//   `if (!this._visibilityChanged && !this.perObjectFrustumCulled &&
//        !this.sortObjects) return;`
// so an OPAQUE pool that sets `perObjectFrustumCulled = false` +
// `sortObjects = false` performs ZERO per-instance work on every frame in
// which its membership/visibility did not change — for EVERY camera, CSM
// shadow cascades included. That is the structural removal of the measured
// 5.72 ms multidraw-rebuild term (80% per-instance over ~13k instances), and
// unlike `?statBatchMemo` it is camera-independent, so the ultra/4-camera
// thrash case is covered by construction. Node-level culling is kept
// (`frustumCulled = true`, sector-bounded geometry).
//
// BATCHED RUNS (`?poolRuns`, 2026-10-22, handoff F1) — why opaque pools opt in
// ---------------------------------------------------------------------------
// The early-out deletes the JS rebuild; it does NOT shrink the draw. With
// `perObjectFrustumCulled = false` three's list holds one multidraw range for
// EVERY visible active instance of the pool, and ANGLE's D3D11 backend turns
// each range into a full draw plus an uncached gl_DrawID uniform and a vertex
// uniform-buffer re-upload, on Chrome's GPU-process main thread (CrGpuMain) —
// batched_runs.js header [M: ANGLE source read 2026-10-19; Holtburg 1,921
// counted calls = 5,838 ranges, 2026-07-15]. Sector pools hold thousands of
// placements over far fewer models [M: Nanto 26,212 opaque static instances
// over 11 sectors, T00 census — ~2.4k per sector D; Holtburg 17,774 instances
// over 324 geometries, net-review 2026-07-15], so, unmarked, the pooled arm
// would PUSH that term up, not down [D]. Pools already dedup geometry exactly
// by (content, layer) (`_ensureGeometry`), so their ranges repeat and
// batched_runs.js can regroup them into one INSTANCED range per distinct
// geometry. `poolFor` therefore marks every opaque pool whose class material
// draws ORDER-FREE (`poolDrawOrderFree`: depth test + depth write, no
// blending) — regrouping reorders instances inside the one draw, which only
// the depth test makes invisible (residual: an exact depth TIE between two
// different coplanar members, where LessEqual lets the later draw win — the
// caveat every batchedRuns bucket already carries). Measured terms it
// attacks: `issuedSubDraws` and CrGpuMain WebGL ms/frame (GATE-POOLS F1
// criteria, SPEC.md). No fps claim.
//   * Every program that draws a pool sees the patched chunks: the class
//     material is `makeArrayMaterial`'s MeshStandardMaterial (the same object
//     kind the already-marked atlas buckets draw with — static_atlas.js), its
//     shadow pass is three's MeshDepthMaterial / MeshDistanceMaterial (no
//     customDepthMaterial: a sway member is refused DEFORMED, and the class
//     material carries no `__vfxSetKey`), and all of those include
//     `batching_pars_vertex` + `batching_vertex` + `color_vertex`, which
//     `installBatchedRunsChunks` rewrites globally before the first compile
//     (index.js). Every consumer of `batchingMatrix` (CSM receiver, VFX hash,
//     the baked-light patch) reads the variable the patched chunk computes.
//   * The marker never changes a program (the chunk patch is global), so the
//     closed-class prewarm warms exactly the programs a marked pool links.
//   * Compare cost: an opaque pool is camera-independent, so
//     ?bmIndirectPerCamera passes it through (one canonical texture → one run
//     state for every camera), and three's early-out leaves the canonical
//     list byte-identical on settled frames, so batchedRuns' `_sameCanonical`
//     HITS (no rebuild, no upload) — it is still an O(ranges) JS compare per
//     draw. Handoff L1 replaces it with an O(1) write epoch for exactly this
//     early-out population (batched_runs.js `?batchedRunsStable`, built
//     2026-10-22, default on since 2026-10-23); the pools need nothing more for it — every pool list change
//     goes through three's API or `_visibilityChanged` (bandTick below).
//   * Translucent and additive pools stay unmarked (sorted, D-07.3); an
//     opaque-class pool whose material blends (transparent + alphaTest) or
//     skips depth is left on three's draw and COUNTED (`runs.orderBound`).
//   * `?poolRuns=off` (DEFAULT ON within the default-OFF `?drawPools`) leaves
//     every pool unmarked (and the producer back on object-identity keys) —
//     the arm that isolates F1 within THIS build; the bounds, band-swap,
//     multi-plan, park and vacate fixes are unconditional, so it is not HEAD's
//     pooled world. `?batchedRuns=off` (no patched chunks) also makes the
//     marker inert, for every bucket.
//
// TWO EARLY-OUT COROLLARIES (2026-10-22, both read-verified in three r184 and
// node-probed): (1) BatchedMesh caches its node `boundingSphere` on the FIRST
// frustum test and no add/delete/setMatrixAt ever clears it, so a sector pool
// fed tile by tile was culled by its first tile's sphere — `_dirtyBounds`
// nulls it on every SHRINK (release, abandon, cell release, band swap;
// static_batch_x's `_memoDirtyBounds` rule) and `_growBounds` unions each ADD
// into it (2026-10-23 — nulling per add re-ran the O(instances) recompute on
// every frame a stage-B feed stepped); (2) `setGeometryIdAt` does not set
// `_visibilityChanged`, so under the early-out a band swap never reached the
// multidraw list — `bandTick` raises the flag itself.
//
// v1 PASS STRUCTURE (D-07.3, SPEC §1.5): pools are OPAQUE-only for the
// early-out. Additive and translucent pools keep TODAY'S sorted-bucket
// semantics exactly (`sortObjects = true`, `perObjectFrustumCulled = true`)
// at sector partition — blend behaviour is bit-identical by construction and
// no eye-test is owed for v1 pass structure. `?poolAdditiveNoSort` is
// RESERVED behind an eye-gate and is not built here (the ClipMap eye-test
// failure is the cautionary tale: widening pass membership by predicate is
// invisible to every harness metric).
//
// LOAD-BEARING DEPENDENCY (F-11.18 / R-11): `three_batchedmesh_colortexture_fix
// .js` must be applied BEFORE any pool is constructed — without it, r184 reads
// `object.colorTexture` (BatchedMesh has `_colorsTexture`) and re-derives the
// program for every BatchedMesh every frame (−3.35 ms renderCPU when fixed).
// At pool scale that is per-pool-per-frame. `poolFor()` verifies the fix on
// the prototype and refuses silence: the first miss is a loud console.error
// and `census().fix.applied` reads false for the rest of the session.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT OWN
// ------------------------------------------
//   * class MATERIALS — injected via `materialFactory(classKey, member)`, so
//     the MaterialCache class tier is a separate seam (and the registry is
//     node-testable with no three material machinery);
//   * GEOMETRY decode — injected via a `geometrySource` with
//     `get(contentKey)`; HBG1 bundles (T13) are the production source;
//   * WHEN work runs — the FrameWorkScheduler owns that (P4/W3/W4); this
//     module exposes chunkable jobs and never schedules itself;
//   * terrain and animated scenery — charter I5-kept on their landed shapes;
//   * entities — charter-excluded (27 draws at 12.7 µs is not the cost).

import {
  classKeyOf, passClassOf, poolNodeName, isPooledDomain,
} from "./pool_class_key.js";
import { pipelineStageEnabled, pipelineOwnFlagOn, pipelinePrereqConflicts } from "./pipeline_flags.js";

// ---------------------------------------------------------------------------
// flag + prerequisite chain (F-11.3)
// ---------------------------------------------------------------------------

/**
 * `?drawPools` — the pipeline chain's shared default (pipeline_flags.js
 * `PIPELINE_DEFAULT_ON`: ON since 2026-10-25, `=off` escapes). Any prerequisite
 * cut (F-11.3: slotGrid / packSource / geomBundles / texCompressedOnly) takes
 * it down with it. No page ⇒ OFF.
 * Not memoised (the singleton below memoises once, as the house pattern does).
 */
export function drawPoolsEnabled(search) {
  return pipelineStageEnabled("drawPools", search);
}

/**
 * `?poolRuns` — opaque pools opt into `?batchedRuns` (handoff F1; see the
 * header). **DEFAULT ON** inside the default-OFF `?drawPools` chain; only
 * `off`/`0`/`false`/`no` (any case) escape — the batchedRuns FLAG grammar.
 * Not memoised: the registry reads it once at construction.
 */
export function poolRunsEnabled(search) {
  try {
    const s = search !== undefined ? search : typeof window !== "undefined" && window.location ? window.location.search : "";
    const v = (new URLSearchParams(s || "").get("poolRuns") || "").toLowerCase();
    return !(v === "off" || v === "0" || v === "false" || v === "no");
  } catch (_) {
    return true;
  }
}

/**
 * Can a pool drawn with `material` be regrouped into per-geometry runs
 * without moving a pixel? Regrouping only reorders instances inside the one
 * draw, which the depth test resolves only when the draw tests AND writes
 * depth and does not blend. three r184 turns blending off exactly for
 * `NoBlending`, or `NormalBlending` on a non-transparent material (WebGLState
 * `setMaterial`). The same predicate as static_atlas.js `_atlasDrawOrderFree`.
 * Pure; `THREE` supplies the blending constants (inlined fallbacks: three's
 * NoBlending 0, NormalBlending 1).
 */
export function poolDrawOrderFree(material, THREE) {
  if (!material || Array.isArray(material)) return false;
  if (material.depthTest === false || material.depthWrite === false) return false;
  const NO = THREE && typeof THREE.NoBlending === "number" ? THREE.NoBlending : 0;
  const NORMAL = THREE && typeof THREE.NormalBlending === "number" ? THREE.NormalBlending : 1;
  const b = material.blending === undefined || material.blending === null ? NORMAL : material.blending;
  return b === NO || (b === NORMAL && material.transparent !== true);
}

/** The F-11.3 prerequisite set, in SPEC §3 T22's order. */
export const DRAW_POOLS_PREREQS = Object.freeze([
  "slotGrid", "packSource", "geomBundles", "texCompressedOnly",
]);

/**
 * F-11.3 chain check. `?drawPools` requires `?slotGrid` + `?packSource` +
 * `?geomBundles` + `?texCompressedOnly` (pools consume grid events, pack
 * records, baked geometry and the compressed texture tier — there is no
 * adapter for any of them and none is built). `?frameWork` is additionally
 * required for scheduler stages B/C and is reported separately: stage-A
 * pools (feed on the caller's own cadence) are legal without it.
 *
 * Returns `{armed, reasons, frameWork}`; NEVER throws. A refusal is LOUD —
 * the kill path is "the flag did nothing", not "the flag half-worked".
 *
 * @param {string} [search] query string (defaults to window.location.search)
 * @param {(name:string, search?:string)=>boolean} [readerFor] injectable
 *   per-flag reader (tests); defaults to the exact-match house grammar.
 */
export function checkDrawPoolsPrereqs(search, readerFor) {
  const s = search !== undefined ? search : typeof window !== "undefined" && window.location ? window.location.search : null;
  // Each prerequisite is judged as the page would run it (its own escape AND
  // the cascade above it), not by its raw spelling (2026-10-25 default flip).
  const read = readerFor || ((name) => {
    try {
      return pipelineStageEnabled(name, s === null ? undefined : s);
    } catch (_) {
      return false;
    }
  });
  const reasons = [];
  let own = false;
  try {
    own = s !== null && pipelineOwnFlagOn("drawPools", s);
  } catch (_) {
    own = false;
  }
  if (!own) reasons.push("?drawPools is off");
  for (const flag of DRAW_POOLS_PREREQS) {
    if (!read(flag, s === null ? undefined : s)) reasons.push(`?drawPools requires ?${flag} (SPEC F-11.3)`);
  }
  return { armed: reasons.length === 0, reasons, frameWork: read("frameWork", s === null ? undefined : s) };
}

// ---------------------------------------------------------------------------
// sizing ([A] — pass-07 S5.1's anchors, re-classed by the first soak)
// ---------------------------------------------------------------------------

/** Initial pool capacities (static_batch_x's proven `_INIT` shape). */
export const POOL_INIT_INSTANCES = 256;
export const POOL_INIT_VERTS = 16_384;
/** Dead-extent fraction that makes `optimize()` worth its compaction. */
export const POOL_OPTIMIZE_FRAC = 0.30;
/** Bytes per vertex of the pass-4 indexed layout (pos f32×3, normal snorm8×3
 *  +pad, uv f32×2) — the M6 `allocatedBytes` denominator of the flag-off
 *  census (pinned by harness/test_draw_pools.mjs). That layout never shipped:
 *  what a pool stores (pool_material.js `normalizeForPool`) is position f32×3
 *  (12) + normal f32×3 (12) + uv f32×2 (8) + aLayer f32×1 (4) =
 *  POOL_VERTEX_BYTES_ACTUAL (36 B), plus acBakedLight u8×3 (3) =
 *  POOL_BAKED_VERTEX_BYTES (39 B) when the source carries a bake, so this
 *  census reads 2/3 of the truth (residency design §1.6). Under
 *  ?poolSizeToContent the census reads each pool's real buffers instead
 *  (`_poolGeometryBytes`). */
export const POOL_VERTEX_BYTES = 24;
/** What a pool vertex really costs (no baked light / with it). */
export const POOL_VERTEX_BYTES_ACTUAL = 36;
export const POOL_BAKED_VERTEX_BYTES = 39;
/** Bytes per u16 index (a pool's index buffer is u16 below 65,536 vertices). */
export const POOL_INDEX_BYTES = 2;
/** ?poolSizeToContent: the first allocation's floor (static_batch_x `_MIN_INIT_VERTS`). */
export const POOL_MIN_INIT_VERTS = 1_024;

/**
 * `?poolSizeToContent` (2026-10-26, stage-2 S1c; DEFAULT ON since 2026-10-26,
 * `=off`/0/false/no escape; read once per
 * registry). docs/2026-10-26-rust-residency-design.md §4 S1c.
 *
 * A pool's first allocation was always POOL_INIT_VERTS (16,384 vertices,
 * 32,768 indices: ~655 KB of vertex + index arrays, on the heap and on the
 * GPU) whatever it was created for — the 1070 chain boot: 76 pools, 34.9 MB
 * allocated for 0.29 MB used. Armed, a pool created by a feed is sized from
 * that feed's own members for it, with the chunk buckets' rule
 * (static_batch_x.js `_initialBucketVerts`): twice the need, a power of two,
 * clamped to [1,024, 16,384]; later feeds grow it by doubling exactly as
 * before. Pixel-identical: capacity is not an input to any draw — geometry
 * ranges are appended in the same order at the same offsets, and
 * `setGeometrySize` copies the arrays it grows. The need comes from the
 * feed's geometry source `sizeOf(contentKey, layer, member)` → `{verts,
 * indices}` (an upper bound read off the source geometry, so the first
 * allocation never undershoots what `get` produces); a source without it
 * keeps today's allocation. The census then reports each pool's real buffer
 * bytes.
 */
export function poolSizeToContentEnabled(search) {
  try {
    const s = search !== undefined ? search : typeof window !== "undefined" && window.location ? window.location.search : "";
    const v = (new URLSearchParams(s || "").get("poolSizeToContent") || "").trim().toLowerCase();
    // DEFAULT ON since 2026-10-26 (`=off|0|false|no` is the escape).
    return !(v === "off" || v === "0" || v === "false" || v === "no");
  } catch (_) {
    return true;
  }
}

/** The chunk rule (static_batch_x.js `_initialBucketVerts`) for a pool's first allocation. */
export function poolInitialVerts(verts, indices, ceiling = POOL_INIT_VERTS) {
  const need = Math.max(verts | 0, Math.ceil((indices | 0) / 2)) * 2;
  let size = POOL_MIN_INIT_VERTS;
  while (size < need && size < ceiling) size *= 2;
  return Math.min(size, Math.max(POOL_MIN_INIT_VERTS, ceiling));
}

// ---------------------------------------------------------------------------
// membership record (pass-07 S1 — the ONLY retained per-tile scene bookkeeping)
// ---------------------------------------------------------------------------

/** The grid tile (2×2 landblocks) a landblock key belongs to — the same key
 *  residency_grid.js `tileOfLb` gives the producer's plans (pinned equal in
 *  harness/test_draw_pools.mjs). */
export function tileKeyOfLbKey(lbKey) {
  const x = (lbKey >>> 24) & 0xff;
  const y = (lbKey >>> 16) & 0xff;
  return (((x >> 1) & 0xff) << 8) | ((y >> 1) & 0xff);
}

function makeMembership(pool) {
  return {
    pool,
    instanceIds: [],       // u32[] — this tile's instances in this pool
    gidRefs: new Map(),    // gid -> count (refcount-by-tile, S1)
    gidByInstance: new Map(), // instanceId -> gid (per-CELL release needs it:
                           // the tile-level `gidRefs` cannot name which gid a
                           // subset of instances held)
    layerRefs: new Set(),  // rsIds this tile needs resident in the class array
    cellRanges: null,      // Map<cellId, number[]> for envcell PVS ranges
    bands: null,           // Map<instanceId, {gids:[near,far], band:0|1}>
    lbRanges: null,        // Map<lbKey, number[]> — per-landblock ids (?objRadius hides)
    lbOfId: null,          // Map<instanceId, lbKey>
    live: false,
  };
}

// ---------------------------------------------------------------------------
// the registry
// ---------------------------------------------------------------------------

export class PoolRegistry {
  /**
   * @param {object} deps
   * @param {object} deps.THREE            the three namespace (injected — this
   *   module must stay importable in node harnesses that stub it)
   * @param {(classKey:string, member:object)=>object} deps.materialFactory
   *   ONE material per class (D-07.2); called at most once per class.
   * @param {object} [deps.group]          DEFAULT scene group pools attach to
   * @param {object|((domain:string)=>object|null)} [deps.groups]
   *   PER-DOMAIN groups — `{ st: staticsGroup, ec: cellsGroup }` or a
   *   `groupFor(domain)` function. ENVCELL-POOL-SWAP: interiors may NOT hang
   *   off the statics group (see `_groupFor`).
   * @param {object} [deps.layers]         per-domain render LAYER, e.g.
   *   `{ ec: 1 }` (RENDER_LAYER_INDOOR). three layer masks are per-OBJECT and
   *   never inherit from the parent group, so a pool that lives under
   *   `cellsGroup` still renders on layer 0 unless it is stamped here.
   * @param {(m:string, d?:any)=>void} [deps.warn]
   * @param {()=>number} [deps.now]
   * @param {number} [deps.initInstances]
   * @param {number} [deps.initVerts]
   * @param {(mesh:object)=>void} [deps.markRuns]  batched_runs.js
   *   `markBatchedRuns`, injected (pool_producer.js) so this module keeps no
   *   renderer-side import. Absent ⇒ no pool is marked, and every opaque pool
   *   is counted `runs.disabled`.
   * @param {string} [deps.search]        query string for `?poolRuns`
   *   (defaults to window.location.search)
   */
  constructor({ THREE, materialFactory, group = null, groups = null, layers = null, warn, now, initInstances, initVerts, markRuns, search } = {}) {
    if (!THREE || typeof THREE.BatchedMesh !== "function") {
      throw new Error("pool_registry: THREE with BatchedMesh required");
    }
    if (typeof materialFactory !== "function") {
      throw new Error("pool_registry: materialFactory required (one material per class)");
    }
    this.THREE = THREE;
    this.materialFactory = materialFactory;
    this.group = group;
    this.groups = groups;
    this.layers = layers;
    this.now = typeof now === "function" ? now : () => (typeof performance !== "undefined" ? performance.now() : Date.now());
    this.warn = typeof warn === "function" ? warn : (m, d) => { try { console.warn(m, d); } catch (_) { /* fail-soft */ } };
    this.initInstances = initInstances || POOL_INIT_INSTANCES;
    this.initVerts = initVerts || POOL_INIT_VERTS;
    // ?poolRuns (header): resolved ONCE — a pool's marker is decided at its
    // construction and never flips under it.
    this.runsEnabled = poolRunsEnabled(search);
    this.markRuns = this.runsEnabled && typeof markRuns === "function" ? markRuns : null;
    // ?poolSizeToContent (S1c, default ON): resolved ONCE, like ?poolRuns.
    this.sizeToContent = poolSizeToContentEnabled(search);

    /** poolKey ("<sectorKey>|<classKey>") -> pool state */
    this.pools = new Map();
    /** classKey -> {material, passClass, pools:Set<poolKey>, created:number} */
    this.classes = new Map();
    /** tileKey -> Map<poolKey, membership> */
    this.tiles = new Map();
    /** tileKeys the grid holds PARKED (2026-10-23). A tile is 2×2 LBs and
     *  every LB plan commits on its own, so a plan still feeding when its tile
     *  parks commits AFTER the park — and a park that lands before the tile's
     *  first commit has no record to mark. The tile-level mark is what `commit`
     *  reads: set by `parkTile` (record or not), cleared by `adoptTile` /
     *  `releaseTile` / `clearParked`. */
    this._parkedTiles = new Set();
    /** cellId -> Set<membership> — the ENVCELL PVS index (D-07.8). Built at
     *  commit, pruned at release. Without it a per-cell visibility delta would
     *  have to walk every resident tile's every cell on every tick, which is
     *  exactly the per-container walk pools exist to delete: the legacy path
     *  is DIFF-driven (0–3 cells/tick), so the pooled one must be too. */
    this._cellIndex = new Map();

    // D-07.9: the class set is CLOSED at boot. `sealClassSet()` is called once
    // the boot ring settles (the prewarm's own precondition); every class
    // minted after that is a class-key BUG by definition and is counted.
    this._sealed = false;
    this._fixApplied = null; // tri-state: null = not yet probed
    this._fixWarned = false;

    // 2026-10-25: landblocks whose instances an ?objRadius hide holds
    // invisible, whatever the tile's LIVE/PARKED state or the cell PVS says.
    this._hiddenLbs = new Set();
    globalThis.__hbRustWorld?.ownerPoolReg(this); // ?rustWorld: audit this registry from birth
    this._stats = {
      feeds: 0, parks: 0, adopts: 0, releases: 0,
      bandSwaps: 0, cellFlips: 0,
      mutationsThisFrame: 0, mutationsTotal: 0,
      dedupHits: 0, geometryAdds: 0, instanceAdds: 0, instanceDeletes: 0,
      poolsCreated: 0, poolsReaped: 0,
      cellsHidden: 0, cellsReleased: 0,
      lbHides: 0, lbShows: 0, lbHiddenInstances: 0,
      classesCreated: 0, classesCreatedPostBoot: 0,
      optimizeRuns: 0, growthDoublings: 0,
      // ?poolSizeToContent: pools whose first allocation was sized to content.
      sizedToContent: 0,
      unresolvedGeometry: 0, unpooledMembers: 0,
      // ?poolRuns — per pool CREATED (cumulative): marked for batchedRuns, an
      // opaque pool left on three's draw because its material blends or skips
      // depth, an opaque pool left unmarked because the flag is off or no
      // marker was injected.
      runsMarked: 0, runsOrderBound: 0, runsDisabled: 0,
      // Node-sphere upkeep: shrink events that null it (the next cull
      // recomputes) vs adds unioned into the cached sphere in O(1).
      boundsDirtied: 0, boundsGrown: 0,
      lastError: null,
    };
  }

  // ── frame edge ──────────────────────────────────────────────────────────

  /** Call once per frame BEFORE any pool work. Resets the per-frame mutation
   *  counter that the S2 anti-churn invariant is measured on. */
  beginFrame() {
    this._stats.mutationsThisFrame = 0;
  }

  _mutate(n = 1) {
    this._stats.mutationsThisFrame += n;
    this._stats.mutationsTotal += n;
  }

  /** D-07.9 — seal the class set (boot ring settled / prewarm complete). */
  sealClassSet() {
    this._sealed = true;
  }

  get sealed() {
    return this._sealed;
  }

  // ── pools ───────────────────────────────────────────────────────────────

  static poolKeyOf(sectorKey, classKey) {
    return `${sectorKey}|${classKey}`;
  }

  /**
   * The scene group a pool of `domain` attaches to (ENVCELL-POOL-SWAP).
   *
   * WHY THIS IS NOT ONE GROUP. `index.js:1455` puts `cellsGroup` on
   * RENDER_LAYER_INDOOR (1) and `cells.js:1642` stamps every node of every cell
   * container with `layers.set(1)`, because `atmosphere_pipeline`'s indoor
   * split renders layer 0 (terrain + outdoor buildings/statics), CLEARS DEPTH,
   * then renders layer 1 (EnvCells + entities) — the cottage-floor/z-fight fix.
   * An envcell pool parked on the layer-0 statics group would be drawn in the
   * pre-clear world pass and lose that isolation entirely. So the registry
   * takes per-domain groups, and the layer is stamped on the pool MESH (three
   * layer masks are per-object; a child never inherits its parent's mask).
   */
  _groupFor(domain) {
    if (typeof this.groups === "function") {
      const g = this.groups(domain);
      if (g) return g;
    } else if (this.groups && this.groups[domain]) {
      return this.groups[domain];
    }
    return this.group;
  }

  /** The render layer a pool of `domain` is stamped with, or null for three's
   *  default (layer 0). */
  _layerFor(domain) {
    if (!this.layers) return null;
    const l = this.layers[domain];
    return typeof l === "number" ? l : null;
  }

  _verifyColorTextureFix() {
    if (this._fixApplied !== null) return this._fixApplied;
    let ok = false;
    try {
      ok = Object.prototype.hasOwnProperty.call(this.THREE.BatchedMesh.prototype, "colorTexture")
        || "colorTexture" in this.THREE.BatchedMesh.prototype;
    } catch (_) {
      ok = false;
    }
    this._fixApplied = ok;
    if (!ok && !this._fixWarned) {
      this._fixWarned = true;
      // LOUD: at pool scale this is a per-pool-per-frame program re-derive
      // (upstream three #34054). R-11 keeps it on the doc-propagation register.
      try {
        console.error(
          "[drawPools] three_batchedmesh_colortexture_fix is NOT applied — "
          + "BatchedMesh.prototype.colorTexture is absent, so r184 re-derives the "
          + "program for EVERY pool EVERY frame (three #34054). Apply the fix "
          + "before constructing pools (scene3d/index.js applies it at boot).",
        );
      } catch (_) { /* fail-soft */ }
    }
    return ok;
  }

  _classOf(classKey, member) {
    let c = this.classes.get(classKey);
    if (c) return c;
    const material = this.materialFactory(classKey, member);
    if (!material) throw new Error(`pool_registry: materialFactory returned nothing for ${classKey}`);
    c = {
      classKey,
      material,
      passClass: member && member.passClass ? member.passClass : "opaque",
      pools: new Set(),
    };
    this.classes.set(classKey, c);
    this._stats.classesCreated += 1;
    if (this._sealed) {
      // D-07.9 / S5.3: a class minted after the boot ring settles is a bug —
      // it means the key depends on something that streams. Counted, never
      // hidden; the CI gate is `classesCreatedPostBoot === 0`.
      this._stats.classesCreatedPostBoot += 1;
      this.warn(`[drawPools] class minted POST-BOOT (D-07.9 violation): ${classKey}`);
    }
    return c;
  }

  /**
   * Get-or-create the pool for (sector, class). Create-on-first-member;
   * persists across residency churn; reaped when empty.
   */
  poolFor(sectorKey, classKey, member, sizeHint = null) {
    const key = PoolRegistry.poolKeyOf(sectorKey, classKey);
    let p = this.pools.get(key);
    if (p) return p;
    this._verifyColorTextureFix();
    const cls = this._classOf(classKey, member);
    const THREE = this.THREE;
    // ?poolSizeToContent: a pool created by a feed that knows its need starts
    // at the chunk rule's size (never above the default); otherwise as before.
    const initVerts = sizeHint && this.sizeToContent
      ? poolInitialVerts(sizeHint.verts, sizeHint.indices, this.initVerts)
      : this.initVerts;
    if (initVerts !== this.initVerts) this._stats.sizedToContent += 1;
    const bm = new THREE.BatchedMesh(
      this.initInstances, initVerts, initVerts * 2, cls.material,
    );
    globalThis.__hbRustWorld?.track(bm, "pool", null, this); // ?rustWorld shadow (scene3d/rust/world.js)
    bm.name = poolNodeName(sectorKey, classKey);
    // Node-level culling KEPT (sector-bounded geometry, D-07.4 step 1).
    bm.frustumCulled = true;
    bm.matrixAutoUpdate = false;
    // The domain decides the group AND the render layer. It rides the member;
    // the class key's first field is the same value, so a member-less
    // construction (tests) still resolves it.
    const domain = (member && member.domain) || String(classKey).split("|")[0] || "st";
    const layer = this._layerFor(domain);
    if (layer !== null) bm.layers.set(layer);
    // D-07.6: shadow flags are POOL-uniform — they are class-key axes, so every
    // member of this pool agrees on them by construction. Taken from the first
    // member (the producer swap carries them on the plan row); a member-less
    // construction keeps three's defaults.
    if (member && member.castShadow !== undefined) bm.castShadow = member.castShadow === true;
    if (member && member.receiveShadow !== undefined) bm.receiveShadow = member.receiveShadow === true;
    if (cls.passClass === "opaque") {
      // D-07.4 step 2 — three's own early-out on every settled frame, every
      // camera, CSM included.
      bm.perObjectFrustumCulled = false;
      bm.sortObjects = false;
    } else {
      // D-07.3 — additive/translucent keep TODAY'S sorted-bucket semantics
      // exactly. `?poolAdditiveNoSort` is reserved behind an eye-gate.
      bm.perObjectFrustumCulled = true;
      bm.sortObjects = true;
    }
    // ?poolRuns (header, handoff F1): an opaque pool's repeated ranges draw as
    // per-geometry instanced runs — only when the class material is draw-order
    // free; translucent/additive pools sort and are never marked.
    let runs = false;
    if (cls.passClass === "opaque") {
      if (!this.markRuns) {
        this._stats.runsDisabled += 1;
      } else if (!poolDrawOrderFree(cls.material, THREE)) {
        this._stats.runsOrderBound += 1;
      } else {
        try {
          this.markRuns(bm);
          runs = true;
          this._stats.runsMarked += 1;
        } catch (e) {
          // fail-soft: an unmarked pool is three's own draw, exactly as before.
          this._stats.lastError = String(e && e.message || e);
        }
      }
    }
    bm.userData = {
      __drawPool: true,
      sectorKey,
      classKey,
      domain,
      passClass: cls.passClass,
      runs,
    };
    const grp = this._groupFor(domain);
    p = {
      key, sectorKey, classKey, domain, group: grp, passClass: cls.passClass, mesh: bm, runs,
      /** contentKey|layer -> gid (exact bake identities; the statGeomDedup
       *  FNV fingerprint existed to guard partial decodes, a failure class
       *  --verify-closure deletes — D-07.7). */
      geomByContent: new Map(),
      /** gid -> {refs, contentKey, verts, indices} */
      gids: new Map(),
      instances: 0,
      deadInstances: 0,
      maxInstances: this.initInstances,
      maxVerts: initVerts,
      maxIndices: initVerts * 2,
      usedVerts: 0,
      usedIndices: 0,
      /** vertices freed by deleteGeometry since the last optimize() — the
       *  DEAD EXTENT the >30% compaction threshold is measured on. */
      freedVerts: 0,
    };
    this.pools.set(key, p);
    cls.pools.add(key);
    this._stats.poolsCreated += 1;
    if (grp && typeof grp.add === "function") grp.add(bm);
    return p;
  }

  /**
   * Membership changed ⇒ the pool's NODE bounds are stale. three r184 computes
   * a BatchedMesh's `boundingSphere` on the first frustum test
   * (Frustum.intersectsObject: `if (object.boundingSphere === null)
   * object.computeBoundingSphere()`) and NOTHING in BatchedMesh clears it —
   * not addInstance, not setMatrixAt, not deleteInstance — so without this a
   * sector pool keeps the sphere of whatever was resident the first frame it
   * was culled, and three culls the whole pool whenever the camera sees only
   * instances fed after that [M: node probe 2026-10-22, a member 600 m east
   * of the first one culled with it]. Nulling makes the next cull recompute
   * over every ACTIVE instance (visibility is not an input — park/adopt/cell
   * flips need no call). static_batch_x's `_memoDirtyBounds` is the same rule.
   * Only a SHRINK needs it — deletes (release / abandon / cell release) and
   * band swaps; an add GROWS the cached sphere instead (`_growBounds`).
   */
  _dirtyBounds(p) {
    const bm = p && p.mesh;
    if (!bm) return;
    bm.boundingSphere = null;
    bm.boundingBox = null;
    this._stats.boundsDirtied += 1;
  }

  /**
   * An instance was ADDED (2026-10-23 review): union its world sphere into the
   * cached node sphere — O(1) — instead of nulling it. A stage-B feed adds a
   * chunk per W3 step and `tickP4` re-arms every plan every frame, so nulling
   * per add made every frame with a feed step recompute the pool's sphere over
   * ALL its instances in the next cull (three r184 `computeBoundingSphere`
   * walks `_instanceInfo`) [M: node probe, 2.5k instances 0.55 ms, 10k
   * 1.99 ms per recompute]. The union is the same per-instance term
   * `computeBoundingSphere` adds (`getBoundingSphereAt` + the instance
   * matrix), so the result still contains every active instance — it can
   * only be looser than a fresh compute until the next shrink event nulls it.
   * No cached sphere ⇒ nothing to grow: the next cull computes it.
   */
  _growBounds(p, id, gid) {
    const bm = p && p.mesh;
    if (!bm) return;
    bm.boundingBox = null; // never read by the cull; recomputed on demand
    if (bm.boundingSphere === null) return;
    try {
      const s = this._scratchSphere || (this._scratchSphere = new this.THREE.Sphere());
      const m4 = this._scratchGrowM4 || (this._scratchGrowM4 = new this.THREE.Matrix4());
      if (bm.getBoundingSphereAt(gid, s) === null) throw new Error("no geometry sphere");
      bm.getMatrixAt(id, m4);
      bm.boundingSphere.union(s.applyMatrix4(m4));
      this._stats.boundsGrown += 1;
    } catch (_) {
      this._dirtyBounds(p); // fail-safe: a fresh compute is always correct
    }
  }

  _reapIfEmpty(p) {
    if (p.instances > 0 || p.gids.size > 0) return false;
    this.pools.delete(p.key);
    const cls = this.classes.get(p.classKey);
    if (cls) cls.pools.delete(p.key);
    if (p.group && typeof p.group.remove === "function") p.group.remove(p.mesh);
    try { p.mesh.dispose?.(); } catch (_) { /* fail-soft */ }
    this._stats.poolsReaped += 1;
    return true;
  }

  // ── capacity (growth doublings are exclusive P4 items; see upload_stage) ──

  _ensureGeometryRoom(p, geometry) {
    const posAttr = geometry.getAttribute ? geometry.getAttribute("position") : null;
    const verts = posAttr ? posAttr.count : 0;
    const idx = geometry.getIndex && geometry.getIndex() ? geometry.getIndex().count : verts;
    let grew = false;
    let maxV = p.maxVerts;
    let maxI = p.maxIndices;
    while (p.usedVerts + verts > maxV) { maxV *= 2; grew = true; }
    while (p.usedIndices + idx > maxI) { maxI *= 2; grew = true; }
    if (grew) {
      p.mesh.setGeometrySize(maxV, maxI);
      p.maxVerts = maxV;
      p.maxIndices = maxI;
      this._stats.growthDoublings += 1;
    }
    return { verts, indices: idx };
  }

  _ensureInstanceRoom(p) {
    if (p.instances < p.maxInstances) return;
    const next = p.maxInstances * 2;
    p.mesh.setInstanceCount(next);
    p.maxInstances = next;
    this._stats.growthDoublings += 1;
  }

  _ensureGeometry(p, member, geometrySource) {
    const layer = member.layer == null ? 0 : member.layer | 0;
    // Layer identity stays per-vertex `aLayer` in v1 (D-07.7), so a geometry
    // used under two layers is two pool geometries — proven, shader-risk-free.
    const ck = `${member.contentKey}|${layer}`;
    const hit = p.geomByContent.get(ck);
    if (hit !== undefined) {
      const g = p.gids.get(hit);
      g.refs += 1;
      this._stats.dedupHits += 1;
      return hit;
    }
    const geometry = geometrySource && typeof geometrySource.get === "function"
      ? geometrySource.get(member.contentKey, layer, member)
      : null;
    if (!geometry) {
      this._stats.unresolvedGeometry += 1;
      return -1;
    }
    const room = this._ensureGeometryRoom(p, geometry);
    const gid = p.mesh.addGeometry(geometry);
    p.geomByContent.set(ck, gid);
    p.gids.set(gid, { refs: 1, contentKey: ck, verts: room.verts, indices: room.indices });
    p.usedVerts += room.verts;
    p.usedIndices += room.indices;
    this._stats.geometryAdds += 1;
    return gid;
  }

  _releaseGeometry(p, gid) {
    const g = p.gids.get(gid);
    if (!g) return;
    g.refs -= 1;
    if (g.refs > 0) return;
    p.gids.delete(gid);
    p.geomByContent.delete(g.contentKey);
    p.usedVerts -= g.verts;
    p.usedIndices -= g.indices;
    p.freedVerts += g.verts;
    try { p.mesh.deleteGeometry(gid); } catch (e) { this._stats.lastError = String(e && e.message || e); }
  }

  // ── STAGED → LIVE (the feed; pass-07 S2 row 2) ───────────────────────────

  /**
   * Begin feeding a TilePlan. Returns a chunkable job so the P4 scheduler
   * (W3) owns the cadence — this module never schedules itself.
   *
   * ORDERING INVARIANT (pass-08 S2.4, shared with the stage-C upload path):
   * geometry appends → texture stages → matrices/instances → membership
   * record → **LIVE flip last**. Instances are added INVISIBLE and flipped
   * visible only in `commit()`, so P3 can never draw a half-fed tile.
   *
   * @param {object} tilePlan  pass-07 S1 TilePlan
   * @param {{get:(contentKey:any, layer:number, member:object)=>object}} geometrySource
   * @param {{onLayer?:(rsId:number, member:object)=>void}} [hooks]
   */
  beginFeed(tilePlan, geometrySource, hooks = {}) {
    const tileKey = tilePlan.tile;
    const members = tilePlan.members || [];
    const self = this;
    let i = 0;
    let committed = false;
    const touched = new Map(); // poolKey -> membership
    // ?poolSizeToContent: what this plan will add to each pool (unique content
    // per pool, both LOD bands), for a pool this feed creates.
    const sizeHints = this.sizeToContent ? this._planSizeHints(members, geometrySource) : null;

    const job = {
      tileKey,
      total: members.length,
      get index() { return i; },
      get done() { return i >= members.length; },
      get committed() { return committed; },

      /** Feed up to `maxMembers` members (or until `deadline()` returns true).
       *  @returns {number} members fed this step. */
      step(maxMembers = Infinity, deadline = null) {
        let fed = 0;
        while (i < members.length) {
          if (fed >= maxMembers) break;
          if (fed > 0 && typeof deadline === "function" && deadline()) break;
          const m = members[i++];
          try {
            self._feedMember(tileKey, m, geometrySource, touched, hooks, sizeHints);
          } catch (e) {
            self._stats.lastError = String(e && e.message || e);
          }
          fed += 1;
        }
        return fed;
      },

      /** LIVE flip — last, atomic, one visibility batch per touched pool.
       *  A plan of a PARKED tile (2026-10-23: the grid parked it while this
       *  plan was still feeding) commits INTO the parked state — its
       *  instances stay born-invisible and its record reads parked, so the
       *  tile's `adoptTile` flips every plan's instances together. */
      commit() {
        if (committed) return 0;
        committed = true;
        globalThis.__hbRustWorld?.poolCommit(self, tileKey, touched); // ?rustWorld: the kernel derives the flips
        const live = !self._parkedTiles.has(tileKey);
        let flipped = 0;
        for (const mem of touched.values()) {
          if (live) {
            for (const id of mem.instanceIds) {
              if (self._lbHides(mem, id)) continue; // an ?objRadius hide outranks the flip
              mem.pool.mesh.setVisibleAt(id, true);
              flipped += 1;
            }
          }
          mem.live = live;
        }
        if (touched.size > 0) {
          let byTile = self.tiles.get(tileKey);
          if (!byTile) { byTile = new Map(); self.tiles.set(tileKey, byTile); }
          for (const [pk, mem] of touched) {
            const prev = byTile.get(pk);
            if (prev) {
              // Re-feed of a tile already resident in this pool (idempotent
              // producers do this): merge instead of orphaning the old ids.
              for (const id of mem.instanceIds) prev.instanceIds.push(id);
              for (const [g, n] of mem.gidRefs) prev.gidRefs.set(g, (prev.gidRefs.get(g) || 0) + n);
              for (const [id, g] of mem.gidByInstance) prev.gidByInstance.set(id, g);
              for (const r of mem.layerRefs) prev.layerRefs.add(r);
              if (mem.cellRanges) {
                if (!prev.cellRanges) prev.cellRanges = new Map();
                for (const [c, ids] of mem.cellRanges) {
                  const cur = prev.cellRanges.get(c) || [];
                  prev.cellRanges.set(c, cur.concat(ids));
                }
              }
              if (mem.bands) {
                if (!prev.bands) prev.bands = new Map();
                for (const [id, b] of mem.bands) prev.bands.set(id, b);
              }
              if (mem.lbRanges) {
                if (!prev.lbRanges) { prev.lbRanges = new Map(); prev.lbOfId = new Map(); }
                for (const [lb, ids] of mem.lbRanges) {
                  const cur = prev.lbRanges.get(lb);
                  prev.lbRanges.set(lb, cur ? cur.concat(ids) : ids.slice());
                }
                for (const [id, lb] of mem.lbOfId) prev.lbOfId.set(id, lb);
              }
              // The tile's state, not "true": a merge into a PARKED tile's
              // record must leave it parked or `adoptTile` skips it and the
              // earlier plan's instances never come back (2026-10-23).
              prev.live = live;
            } else {
              byTile.set(pk, mem);
            }
            // ENVCELL-POOL-SWAP: keep the per-cell index in step with the
            // membership record, so the PVS delta is O(cells that changed).
            self._indexCells(prev || mem);
          }
          self._stats.feeds += 1;
          self._mutate(touched.size);
        }
        return flipped;
      },

      /** STAGED-but-vacated: nothing entered any pool that must persist. */
      abandon() {
        if (committed) return;
        committed = true;
        for (const mem of touched.values()) {
          for (const id of mem.instanceIds) {
            try { mem.pool.mesh.deleteInstance(id); } catch (_) { /* fail-soft */ }
            self._stats.instanceDeletes += 1;
          }
          for (const [gid, n] of mem.gidRefs) {
            for (let k = 0; k < n; k++) self._releaseGeometry(mem.pool, gid);
          }
          mem.pool.instances -= mem.instanceIds.length;
          self._dirtyBounds(mem.pool);
          self._reapIfEmpty(mem.pool);
        }
        touched.clear();
      },
    };
    return job;
  }

  /** One-shot convenience (tests + non-budgeted callers). */
  feedTile(tilePlan, geometrySource, hooks) {
    const job = this.beginFeed(tilePlan, geometrySource, hooks);
    job.step();
    job.commit();
    return job;
  }

  /** ?poolSizeToContent: poolKey → {verts, indices} this plan adds, or null
   *  when the geometry source cannot size content without building it. */
  _planSizeHints(members, geometrySource) {
    if (!geometrySource || typeof geometrySource.sizeOf !== "function") return null;
    const hints = new Map();
    const seen = new Set();
    const add = (pk, contentKey, layer, m) => {
      const ck = `${pk}#${contentKey}|${layer}`;
      if (seen.has(ck)) return;
      seen.add(ck);
      let sz = null;
      try { sz = geometrySource.sizeOf(contentKey, layer, m); } catch (_) { sz = null; }
      if (!sz) return;
      let h = hints.get(pk);
      if (!h) { h = { verts: 0, indices: 0 }; hints.set(pk, h); }
      h.verts += sz.verts | 0;
      h.indices += sz.indices | 0;
    };
    for (const m of members) {
      if (!m || !isPooledDomain(m.domain || "st")) continue;
      const pk = PoolRegistry.poolKeyOf(m.sectorKey, m.classKey);
      const layer = m.layer == null ? 0 : m.layer | 0;
      if (Array.isArray(m.bandGids) && m.bandGids.length === 2) {
        add(pk, m.bandGids[0], layer, m);
        add(pk, m.bandGids[1], layer, m);
      } else {
        add(pk, m.contentKey, layer, m);
      }
    }
    return hints;
  }

  _feedMember(tileKey, m, geometrySource, touched, hooks, sizeHints = null) {
    if (!isPooledDomain(m.domain || "st")) {
      this._stats.unpooledMembers += 1;
      return;
    }
    const p = this.poolFor(m.sectorKey, m.classKey, m,
      sizeHints ? sizeHints.get(PoolRegistry.poolKeyOf(m.sectorKey, m.classKey)) || null : null);
    let mem = touched.get(p.key);
    if (!mem) { mem = makeMembership(p); touched.set(p.key, mem); }

    // LOD (D-07.8): both band gids are pool-resident members of the SAME
    // class (same surface ⇒ same class by construction). The active gid is
    // chosen at feed by band and re-chosen by the throttled band tick.
    const band = m.band | 0;
    let gid = -1;
    let bandGids = null;
    if (Array.isArray(m.bandGids) && m.bandGids.length === 2) {
      const near = this._ensureGeometry(p, { ...m, contentKey: m.bandGids[0] }, geometrySource);
      const far = this._ensureGeometry(p, { ...m, contentKey: m.bandGids[1] }, geometrySource);
      bandGids = [near, far];
      gid = band === 1 ? far : near;
      if (near >= 0) mem.gidRefs.set(near, (mem.gidRefs.get(near) || 0) + 1);
      if (far >= 0) mem.gidRefs.set(far, (mem.gidRefs.get(far) || 0) + 1);
    } else {
      gid = this._ensureGeometry(p, m, geometrySource);
      if (gid >= 0) mem.gidRefs.set(gid, (mem.gidRefs.get(gid) || 0) + 1);
    }
    if (gid < 0) return; // unresolved geometry — counted, never a silent draw

    this._ensureInstanceRoom(p);
    const id = p.mesh.addInstance(gid);
    // The flip is LAST (commit): an instance is born invisible.
    p.mesh.setVisibleAt(id, false);
    globalThis.__hbRustWorld?.poolAttr(p.mesh, id, tileKey, m.lbKey, m.cellId); // ?rustWorld membership
    if (m.matrix) p.mesh.setMatrixAt(id, this._matrixOf(m.matrix));
    // The node sphere must cover the new instance (an invisible-but-active
    // instance counts too — conservative until the LIVE flip).
    this._growBounds(p, id, gid);
    p.instances += 1;
    this._stats.instanceAdds += 1;
    mem.instanceIds.push(id);
    mem.gidByInstance.set(id, gid);
    if (m.lbKey != null) {
      const lb = m.lbKey >>> 0;
      if (!mem.lbRanges) { mem.lbRanges = new Map(); mem.lbOfId = new Map(); }
      const arr = mem.lbRanges.get(lb);
      if (arr) arr.push(id); else mem.lbRanges.set(lb, [id]);
      mem.lbOfId.set(id, lb);
    }
    if (m.rsId) {
      mem.layerRefs.add(m.rsId >>> 0);
      if (hooks && typeof hooks.onLayer === "function") hooks.onLayer(m.rsId >>> 0, m);
    }
    if (m.cellId != null) {
      if (!mem.cellRanges) mem.cellRanges = new Map();
      const arr = mem.cellRanges.get(m.cellId) || [];
      arr.push(id);
      mem.cellRanges.set(m.cellId, arr);
    }
    if (bandGids) {
      if (!mem.bands) mem.bands = new Map();
      mem.bands.set(id, { gids: bandGids, band, pos: m.pos || null });
    }
  }

  _matrixOf(matrix) {
    if (matrix && matrix.isMatrix4) return matrix;
    const m4 = this._scratchM4 || (this._scratchM4 = new this.THREE.Matrix4());
    m4.fromArray(matrix);
    return m4;
  }

  // ── LIVE ⇄ PARKED (S2 rows 3/4 — GPU-free by construction) ───────────────

  /** LIVE → PARKED: `setVisibleAt(false)` batch. No GPU or heap release.
   *  The tile is marked parked even with nothing committed yet, so a plan
   *  still in flight commits invisible (`commit`). */
  parkTile(tileKey) {
    globalThis.__hbRustWorld?.poolPark(this, tileKey); // ?rustWorld: the kernel derives the same flips
    this._parkedTiles.add(tileKey);
    const byTile = this.tiles.get(tileKey);
    if (!byTile) return 0;
    let n = 0;
    for (const mem of byTile.values()) {
      if (!mem.live) continue;
      for (const id of mem.instanceIds) { mem.pool.mesh.setVisibleAt(id, false); n += 1; }
      mem.live = false;
    }
    if (n > 0) { this._stats.parks += 1; this._mutate(byTile.size); }
    return n;
  }

  /** PARKED → LIVE: pointer re-adopt — zero fetch, zero decode, zero upload. */
  adoptTile(tileKey) {
    globalThis.__hbRustWorld?.poolAdopt(this, tileKey); // ?rustWorld
    this._parkedTiles.delete(tileKey);
    const byTile = this.tiles.get(tileKey);
    if (!byTile) return 0;
    let n = 0;
    for (const mem of byTile.values()) {
      if (mem.live) continue;
      for (const id of mem.instanceIds) {
        // A cell outside the current PVS set stays hidden across a re-adopt,
        // and so does a landblock under an ?objRadius hide.
        if (mem.hiddenCells && mem.hiddenCells.has(id)) continue;
        if (this._lbHides(mem, id)) continue;
        mem.pool.mesh.setVisibleAt(id, true);
        n += 1;
      }
      mem.live = true;
    }
    if (n > 0) { this._stats.adopts += 1; this._mutate(byTile.size); }
    return n;
  }

  isTileResident(tileKey) {
    return this.tiles.has(tileKey);
  }

  /** The grid emptied a tile the registry holds nothing of (no release to
   *  run): drop its park mark, or the tile's NEXT life — a fresh admit, not a
   *  PARKED → LIVE re-adopt — would commit invisible for good. */
  clearParked(tileKey) {
    globalThis.__hbRustWorld?.poolClearParked(this, tileKey); // ?rustWorld
    this._parkedTiles.delete(tileKey);
  }

  // ── PARKED → EMPTY (S2 row 5 — amortized, ≤1 tile/tick under the budget) ─

  /**
   * True release. `deleteInstance` per id, gid deref → `deleteGeometry` at
   * zero, layer refs released, pool marked dirty, lazy `optimize()` at >30%
   * dead extent, empty pool reaped.
   * @returns {number} instances deleted.
   */
  releaseTile(tileKey) {
    globalThis.__hbRustWorld?.poolRelease(this, tileKey); // ?rustWorld (the deletes arrive as structure events)
    this._parkedTiles.delete(tileKey);
    const byTile = this.tiles.get(tileKey);
    if (!byTile) return 0;
    let n = 0;
    for (const mem of byTile.values()) {
      const p = mem.pool;
      this._unindexCells(mem);
      if (mem.hiddenCells) this._stats.cellsHidden -= mem.hiddenCells.size;
      for (const id of mem.instanceIds) {
        try { p.mesh.deleteInstance(id); } catch (e) { this._stats.lastError = String(e && e.message || e); }
        n += 1;
        this._stats.instanceDeletes += 1;
      }
      p.instances -= mem.instanceIds.length;
      p.deadInstances += mem.instanceIds.length;
      for (const [gid, refs] of mem.gidRefs) {
        for (let k = 0; k < refs; k++) this._releaseGeometry(p, gid);
      }
      this._dirtyBounds(p);
      this._maybeOptimize(p);
      this._reapIfEmpty(p);
    }
    this.tiles.delete(tileKey);
    if (n > 0) { this._stats.releases += 1; this._mutate(byTile.size); }
    return n;
  }

  _maybeOptimize(p) {
    if (!this.pools.has(p.key)) return false;
    const extent = p.usedVerts + p.freedVerts;
    if (extent <= 0) return false;
    if (p.freedVerts / extent < POOL_OPTIMIZE_FRAC) return false;
    try {
      p.mesh.optimize();
      p.freedVerts = 0;
      p.deadInstances = 0;
      this._stats.optimizeRuns += 1;
      return true;
    } catch (e) {
      this._stats.lastError = String(e && e.message || e);
      return false;
    }
  }

  /** Explicit compaction pass (a W4 item) — returns pools compacted. */
  tickOptimize(maxPools = 1) {
    let done = 0;
    for (const p of this.pools.values()) {
      if (done >= maxPools) break;
      if (this._maybeOptimize(p)) done += 1;
    }
    return done;
  }

  // ── per-landblock hides (?objRadius, 2026-10-25) ─────────────────────────

  /** Is this instance held invisible by a hidden landblock? */
  _lbHides(mem, id) {
    if (this._hiddenLbs.size === 0 || !mem.lbOfId) return false;
    const lb = mem.lbOfId.get(id);
    return lb !== undefined && this._hiddenLbs.has(lb);
  }

  _forEachLbInstance(lbKey, fn) {
    const lb = lbKey >>> 0;
    const tileKey = tileKeyOfLbKey(lb);
    const byTile = this.tiles.get(tileKey);
    if (!byTile) return;
    for (const mem of byTile.values()) {
      const ids = mem.lbRanges && mem.lbRanges.get(lb);
      if (ids) for (const id of ids) fn(mem, id);
    }
  }

  /**
   * Hide one landblock's pooled instances (the ?objRadius hide — object_radius.js
   * `_hide`). Sticky: a later commit, re-adopt or cell-PVS show leaves them hidden
   * until `showLb`. Membership is kept; nothing is released.
   * @returns {number} instances flipped invisible
   */
  hideLb(lbKey) {
    globalThis.__hbRustWorld?.poolHideLb(this, lbKey >>> 0); // ?rustWorld
    const lb = lbKey >>> 0;
    if (this._hiddenLbs.has(lb)) return 0;
    this._hiddenLbs.add(lb);
    let n = 0;
    this._forEachLbInstance(lb, (mem, id) => { mem.pool.mesh.setVisibleAt(id, false); n += 1; });
    this._stats.lbHides += 1;
    this._stats.lbHiddenInstances += n;
    if (n > 0) this._mutate(1);
    return n;
  }

  /**
   * Undo `hideLb`: instances come back only where the tile is LIVE and the cell
   * PVS does not hide them.
   * @returns {number} instances flipped visible
   */
  showLb(lbKey) {
    globalThis.__hbRustWorld?.poolShowLb(this, lbKey >>> 0); // ?rustWorld
    const lb = lbKey >>> 0;
    if (!this._hiddenLbs.delete(lb)) return 0;
    let n = 0;
    let held = 0;
    this._forEachLbInstance(lb, (mem, id) => {
      held += 1;
      if (!mem.live) return;
      if (mem.hiddenCells && mem.hiddenCells.has(id)) return;
      mem.pool.mesh.setVisibleAt(id, true);
      n += 1;
    });
    this._stats.lbShows += 1;
    this._stats.lbHiddenInstances = Math.max(0, this._stats.lbHiddenInstances - held);
    if (n > 0) this._mutate(1);
    return n;
  }

  isLbHidden(lbKey) {
    return this._hiddenLbs.has(lbKey >>> 0);
  }

  // ── per-cell PVS ranges (D-07.8) ─────────────────────────────────────────

  /**
   * Interior renderSet delta → `setVisibleAt` batches over the entering and
   * leaving cells' instance ranges. Replaces the per-container visibility
   * walk (cells.js's ~1,100 containers at Town Network).
   * @param {number} tileKey
   * @param {Set<number>} renderSet  cellIds that should be visible
   */
  cellSetChanged(tileKey, renderSet) {
    globalThis.__hbRustWorld?.poolCellSet(this, tileKey, renderSet); // ?rustWorld
    const byTile = this.tiles.get(tileKey);
    if (!byTile) return 0;
    let flips = 0;
    for (const mem of byTile.values()) {
      if (!mem.cellRanges) continue;
      if (!mem.hiddenCells) mem.hiddenCells = new Set();
      for (const [cellId, ids] of mem.cellRanges) {
        const want = renderSet.has(cellId);
        for (const id of ids) {
          const hidden = mem.hiddenCells.has(id);
          if (want && hidden) {
            mem.hiddenCells.delete(id);
            this._stats.cellsHidden -= 1;
            if (mem.live && !this._lbHides(mem, id)) mem.pool.mesh.setVisibleAt(id, true);
            flips += 1;
          } else if (!want && !hidden) {
            mem.hiddenCells.add(id);
            this._stats.cellsHidden += 1;
            mem.pool.mesh.setVisibleAt(id, false);
            flips += 1;
          }
        }
      }
    }
    if (flips > 0) { this._stats.cellFlips += 1; this._mutate(1); }
    return flips;
  }

  /** Index a membership record's cells (commit-time; idempotent). */
  _indexCells(mem) {
    if (!mem || !mem.cellRanges) return;
    for (const cellId of mem.cellRanges.keys()) {
      let s = this._cellIndex.get(cellId);
      if (!s) { s = new Set(); this._cellIndex.set(cellId, s); }
      s.add(mem);
    }
  }

  /** Drop a membership record from the cell index (release-time). */
  _unindexCells(mem) {
    if (!mem || !mem.cellRanges) return;
    for (const cellId of mem.cellRanges.keys()) {
      const s = this._cellIndex.get(cellId);
      if (!s) continue;
      s.delete(mem);
      if (s.size === 0) this._cellIndex.delete(cellId);
    }
  }

  /**
   * The per-cell visibility DELTA — the pooled equivalent of cells.js's
   * `container.visible = want` per cellId (`cells.js:2248-2262`), driven by the
   * same PVS/portal tick and applied the same way: only the cells that CHANGED
   * this tick are touched.
   *
   * `cellSetChanged` (above) is the full-set form the substrate landed with;
   * this is the form the live tick uses, because the legacy path it replaces is
   * itself diff-driven (0–3 cells/tick steady) and a full walk would be a
   * regression dressed as a swap.
   *
   * Hidden-ness is recorded on the membership record, so a cell outside the PVS
   * set stays hidden across park → adopt exactly as `cellSetChanged` leaves it.
   *
   * @param {Iterable<number>} cellIds
   * @param {boolean} visible
   * @returns {number} instance flips performed
   */
  setCellsVisible(cellIds, visible) {
    globalThis.__hbRustWorld?.poolCellsVisible(this, cellIds, visible); // ?rustWorld (the cell PVS delta)
    let flips = 0;
    for (const cellId of cellIds) {
      const mems = this._cellIndex.get(cellId >>> 0);
      if (!mems) continue;
      for (const mem of mems) {
        const ids = mem.cellRanges && mem.cellRanges.get(cellId >>> 0);
        if (!ids || ids.length === 0) continue;
        if (!mem.hiddenCells) mem.hiddenCells = new Set();
        for (const id of ids) {
          const hidden = mem.hiddenCells.has(id);
          if (visible && hidden) {
            mem.hiddenCells.delete(id);
            this._stats.cellsHidden -= 1;
            // A PARKED tile's instances are all invisible; un-hiding records
            // the intent and `adoptTile` performs the flip.
            if (mem.live && !this._lbHides(mem, id)) mem.pool.mesh.setVisibleAt(id, true);
            flips += 1;
          } else if (!visible && !hidden) {
            mem.hiddenCells.add(id);
            this._stats.cellsHidden += 1;
            mem.pool.mesh.setVisibleAt(id, false);
            flips += 1;
          }
        }
      }
    }
    if (flips > 0) { this._stats.cellFlips += 1; this._mutate(1); }
    return flips;
  }

  /** Cells this registry currently holds pooled instances for. */
  hasCell(cellId) {
    return this._cellIndex.has(cellId >>> 0);
  }

  /**
   * True release of a SUBSET of cells (ENVCELL-POOL-SWAP).
   *
   * The grid releases whole TILES; an envcell LB is rebuilt on a granularity of
   * its own (`buildEnvCellsForLandblock` after an LRU evict), and a rebuild that
   * re-fed without releasing would double every interior surface — the tile is
   * 2×2 LBs, so releasing the tile is not an option either. Same bookkeeping as
   * `releaseTile`, scoped to the named cells.
   *
   * @param {Iterable<number>} cellIds
   * @returns {number} instances deleted
   */
  releaseCells(cellIds) {
    globalThis.__hbRustWorld?.poolReleaseCells(this, cellIds); // ?rustWorld (the deletes arrive as structure events)
    let n = 0;
    const touchedPools = new Set();
    const touchedMems = new Set();
    for (const raw of cellIds) {
      const cellId = raw >>> 0;
      const mems = this._cellIndex.get(cellId);
      if (!mems) continue;
      for (const mem of [...mems]) {
        const ids = mem.cellRanges && mem.cellRanges.get(cellId);
        mem.cellRanges.delete(cellId);
        mems.delete(mem);
        if (!ids || ids.length === 0) continue;
        const p = mem.pool;
        const dead = new Set(ids);
        for (const id of ids) {
          try { p.mesh.deleteInstance(id); } catch (e) { this._stats.lastError = String(e && e.message || e); }
          this._stats.instanceDeletes += 1;
          n += 1;
          const gid = mem.gidByInstance.get(id);
          if (gid !== undefined) {
            const refs = mem.gidRefs.get(gid);
            if (refs !== undefined) {
              if (refs <= 1) mem.gidRefs.delete(gid);
              else mem.gidRefs.set(gid, refs - 1);
            }
            this._releaseGeometry(p, gid);
          }
          mem.gidByInstance.delete(id);
          if (mem.hiddenCells && mem.hiddenCells.delete(id)) this._stats.cellsHidden -= 1;
          if (mem.bands) mem.bands.delete(id);
        }
        mem.instanceIds = mem.instanceIds.filter((id) => !dead.has(id));
        p.instances -= ids.length;
        p.deadInstances += ids.length;
        touchedPools.add(p);
        touchedMems.add(mem);
      }
      if (mems.size === 0) this._cellIndex.delete(cellId);
    }
    // Prune membership records (and tiles) the release emptied.
    if (touchedMems.size > 0) {
      for (const [tileKey, byTile] of this.tiles) {
        for (const [pk, mem] of [...byTile]) {
          if (!touchedMems.has(mem) || mem.instanceIds.length > 0) continue;
          this._unindexCells(mem);
          byTile.delete(pk);
        }
        if (byTile.size === 0) this.tiles.delete(tileKey);
      }
    }
    for (const p of touchedPools) { this._dirtyBounds(p); this._maybeOptimize(p); this._reapIfEmpty(p); }
    if (n > 0) { this._stats.cellsReleased += n; this._mutate(touchedPools.size); }
    return n;
  }

  // ── LOD band tick (D-07.8 — 2 Hz + moved-≥8 m gate, owned by the caller) ─

  /**
   * Re-choose each banded member's active gid by distance band, with ±10%
   * hysteresis on the edge. Walks the membership records (JS arrays), NOT
   * scene nodes. Parked cost 0; moving cost O(band crossings).
   * @param {{x:number,y:number,z:number}} playerPos
   * @param {number} bandRadius  metres (the ~100 m band, [A])
   * @returns {number} band swaps performed.
   */
  bandTick(playerPos, bandRadius = 100) {
    if (!playerPos) return 0;
    const near = bandRadius * 0.9;
    const far = bandRadius * 1.1;
    let swaps = 0;
    for (const byTile of this.tiles.values()) {
      for (const mem of byTile.values()) {
        if (!mem.bands) continue;
        for (const [id, b] of mem.bands) {
          if (!b.pos) continue;
          const dx = b.pos.x - playerPos.x;
          const dy = (b.pos.y || 0) - (playerPos.y || 0);
          const dz = (b.pos.z || 0) - (playerPos.z || 0);
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const want = b.band === 0 ? (d > far ? 1 : 0) : (d < near ? 0 : 1);
          if (want === b.band) continue;
          const gid = b.gids[want];
          if (gid == null || gid < 0) continue;
          try {
            const bm = mem.pool.mesh;
            bm.setGeometryIdAt(id, gid);
            // three r184's setGeometryIdAt does NOT raise `_visibilityChanged`
            // (only add/delete/optimize/setVisibleAt/setGeometryAt do), so an
            // opaque pool's early-out would keep drawing the OLD band's range
            // until some unrelated visibility change — the header's corollary
            // (2). Raise it: this is the swap EVENT's one rebuild. The band's
            // geometry has its own bounds, so the node sphere is stale too.
            bm._visibilityChanged = true;
            this._dirtyBounds(mem.pool);
            b.band = want;
            swaps += 1;
          } catch (e) {
            this._stats.lastError = String(e && e.message || e);
          }
        }
      }
    }
    if (swaps > 0) { this._stats.bandSwaps += swaps; this._mutate(1); }
    return swaps;
  }

  // ── census (__diag.pools — the registry schema is the contract) ──────────

  /** M6: allocated (buffer capacity) vs used EXTENT — never `position.count`
   *  (the §5c allocated-vs-used lesson). */
  geometryBytes() {
    let allocated = 0;
    let used = 0;
    for (const p of this.pools.values()) {
      if (this.sizeToContent) {
        const b = this._poolGeometryBytes(p);
        allocated += b.allocated;
        used += b.used;
        continue;
      }
      allocated += p.maxVerts * POOL_VERTEX_BYTES + p.maxIndices * POOL_INDEX_BYTES;
      used += p.usedVerts * POOL_VERTEX_BYTES + p.usedIndices * POOL_INDEX_BYTES;
    }
    return { allocated, used };
  }

  /** ?poolSizeToContent: a pool's real buffers — three r184 BatchedMesh keeps
   *  one array per attribute (`maxVertexCount × itemSize`, the first
   *  geometry's array type) plus the index array, created at its first
   *  addGeometry. Used = the used extent through the same per-vertex /
   *  per-index widths. */
  _poolGeometryBytes(p) {
    const g = p.mesh && p.mesh.geometry;
    const attrs = g && g.attributes ? g.attributes : null;
    let allocated = 0;
    let perVertex = 0;
    if (attrs) {
      for (const name of Object.keys(attrs)) {
        const a = attrs[name];
        const arr = a && a.array;
        if (!arr) continue;
        allocated += arr.byteLength;
        perVertex += (a.itemSize | 0) * (arr.BYTES_PER_ELEMENT | 0);
      }
    }
    const idx = g && g.index && g.index.array;
    const perIndex = idx ? idx.BYTES_PER_ELEMENT : POOL_INDEX_BYTES;
    if (idx) allocated += idx.byteLength;
    return { allocated, used: p.usedVerts * perVertex + p.usedIndices * perIndex };
  }

  census() {
    const byClass = {};
    const byPass = { opaque: 0, additive: 0, translucent: 0 };
    let runsLive = 0;
    for (const p of this.pools.values()) {
      byClass[p.classKey] = (byClass[p.classKey] || 0) + 1;
      byPass[p.passClass] = (byPass[p.passClass] || 0) + 1;
      if (p.runs) runsLive += 1;
    }
    const g = this.geometryBytes();
    const s = this._stats;
    return {
      pools: { count: this.pools.size, byClass, byPass },
      classes: { count: this.classes.size, createdPostBoot: s.classesCreatedPostBoot, sealed: this._sealed },
      nodes: { scene: this.pools.size, worldStatic: this.pools.size, entity: 0 },
      geometry: {
        allocatedBytes: g.allocated,
        usedBytes: g.used,
        dedupHits: s.dedupHits,
        adds: s.geometryAdds,
        // ?poolSizeToContent (S1c): armed, and pools sized to their first feed.
        sizeToContent: this.sizeToContent === true,
        sizedToContent: s.sizedToContent,
      },
      tiles: { resident: this.tiles.size, parked: this._parkedTiles.size },
      // ENVCELL-POOL-SWAP: the interior half of residency. `tracked` counts the
      // cells that have pooled instances at all; `hidden` counts the instances
      // the PVS delta currently holds invisible (the pooled form of
      // `container.visible === false`).
      cells: { tracked: this._cellIndex.size, hidden: s.cellsHidden, released: s.cellsReleased },
      events: {
        feeds: s.feeds, parks: s.parks, adopts: s.adopts, releases: s.releases,
        bandSwaps: s.bandSwaps, cellFlips: s.cellFlips,
        mutationsThisFrame: s.mutationsThisFrame,
        mutationsTotal: s.mutationsTotal,
      },
      draws: { submitted: this.pools.size, switchRate: null, programSwitches: null },
      // ?poolRuns (handoff F1). `live` = resident pools drawing as runs now;
      // the rest are cumulative per pool created. The draw-side numbers (ranges
      // asked for vs issued) are batchedRuns' own: `__batchedRuns.frame()` /
      // `__diag.render.issuedSubDraws` — this block only says WHICH pools opted in.
      runs: {
        enabled: this.runsEnabled === true,
        injected: this.markRuns !== null,
        live: runsLive,
        marked: s.runsMarked,
        orderBound: s.runsOrderBound,
        disabled: s.runsDisabled,
      },
      bounds: { dirtied: s.boundsDirtied, grown: s.boundsGrown },
      fix: { applied: this._fixApplied === true },
      errors: { unresolvedGeometry: s.unresolvedGeometry, unpooledMembers: s.unpooledMembers, lastError: s.lastError },
    };
  }

  /** Teardown (context loss / arm switch). */
  dispose() {
    globalThis.__hbRustWorld?.poolRegReset(this); // ?rustWorld
    for (const p of [...this.pools.values()]) {
      const grp = p.group || this.group;
      if (grp && typeof grp.remove === "function") grp.remove(p.mesh);
      try { p.mesh.dispose?.(); } catch (_) { /* fail-soft */ }
    }
    this.pools.clear();
    this.classes.clear();
    this.tiles.clear();
    this._parkedTiles.clear();
    this._cellIndex.clear();
  }
}

// ---------------------------------------------------------------------------
// helpers shared with the producers
// ---------------------------------------------------------------------------

/**
 * Resolve a member's class + pass from its raw axis record (the producer's
 * one call into the key). Kept here so no producer ever hand-builds a key.
 */
export function resolveMemberClass(axisRecord) {
  return { classKey: classKeyOf(axisRecord), passClass: passClassOf(axisRecord) };
}

// ---------------------------------------------------------------------------
// singleton (browser wiring; inert unless the flag chain is armed)
// ---------------------------------------------------------------------------

let _registry = null;
let _armed = null; // null = not yet resolved

/**
 * Arm the pool registry. Returns the registry when the F-11.3 chain is
 * satisfied, else `null` after logging every unmet reason (kill path: the
 * flag did nothing and said so).
 */
export function initDrawPools(deps = {}) {
  const chk = checkDrawPoolsPrereqs(deps.search);
  if (!chk.armed) {
    _armed = false;
    // Loud only for a CONTRADICTORY url (`?drawPools=on` with a prerequisite
    // cut). Under a default-on chain an escape like `?packSource=off` takes the
    // pools down quietly, by design (pipeline_flags.js).
    let conflicts = [];
    try { conflicts = pipelinePrereqConflicts("drawPools", deps.search); } catch (_) { conflicts = []; }
    if (conflicts.length > 0) {
      try {
        console.error(
          "[drawPools] flag ON but DISARMED (legacy producer stack stays in charge):\n  - "
          + chk.reasons.filter((r) => r !== "?drawPools is off").join("\n  - "),
        );
      } catch (_) { /* fail-soft */ }
    }
    return null;
  }
  if (!chk.frameWork) {
    // Stage A is legal without ?frameWork; stages B/C are not (SPEC §3 T22).
    try {
      console.warn("[drawPools] armed WITHOUT ?frameWork — scheduler stages B/C are inert (feeds run on the caller's cadence).");
    } catch (_) { /* fail-soft */ }
  }
  _registry = new PoolRegistry(deps);
  _armed = true;
  // Publish the census on the RESERVED registry name `__diag.pools` (the
  // declared successor of `__atlasStats`). Merged onto whatever `__diag`
  // already holds — never assigned wholesale, so ordering against index.js's
  // own `__diag` construction cannot clobber either side. The registry entry
  // stays `reserved` until the producer swap makes this live on a real run
  // (T22 report: "remainder").
  if (typeof window !== "undefined") {
    try {
      window.__diag = window.__diag || {};
      window.__diag.pools = () => (_registry ? _registry.census() : { enabled: false });
    } catch (_) { /* fail-soft */ }
  }
  return _registry;
}

export function drawPoolsActive() {
  return _armed === true && _registry !== null;
}

export function getPoolRegistry() {
  return _registry;
}

/** Test hook — drop the singleton between arms. */
export function _resetDrawPoolsForTest() {
  if (_registry) { try { _registry.dispose(); } catch (_) { /* fail-soft */ } }
  _registry = null;
  _armed = null;
}
