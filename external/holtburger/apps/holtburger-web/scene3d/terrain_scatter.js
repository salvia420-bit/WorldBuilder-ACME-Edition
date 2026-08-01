// scene3d/terrain_scatter.js — the effect-agnostic instanced scatter pool
// (Wave 1 pre-work; plan `docs/2026-07-31-terrain-vfx-plan.md` §3.1
// "Placement (CPU, amortised)", §3.2 item 1, §3.3 item 1).
//
// WHAT THIS OWNS
//   Placement, residency and amortisation for a fixed-size field of instances
//   that follows the player: where each instance sits, when it is re-scattered,
//   whether the ground under it is the right terrain family, and how the
//   per-instance buffers are uploaded. NOTHING ELSE.
//
// WHAT THE CONSUMER OWNS
//   The LOOK — geometry, material, the per-instance attribute schema and the
//   shader that reads it — and the GATING — the `?flag` readers, the quality
//   tier, the family set, the density and the radius. The pool has no flags of
//   its own and reads no URL parameters (plan §2.4: one flag, one reader, and
//   that reader belongs to the effect, not to shared machinery).
//
// THE PLACEMENT MODEL — a world-anchored slot grid (why it is not a ring of
// random points). The window is a `2R x 2R` square of `gridSize x gridSize`
// cells; instance `i` owns slot `(sx, sy) = (i % gridSize, i / gridSize)` and
// that slot maps, by modular wrap, to the ONE cell in the current window whose
// index is congruent to it (`wrapSlotToCell`). This is the same fixed-slot
// torus mapping retail uses for landblock residency (`LScape::update_block`),
// and it buys three things at once:
//
//   1. LEADING-EDGE re-entry for free. When the window scrolls, exactly the
//      cells that fell off the trailing edge are the ones whose slot now points
//      at a new cell on the LEADING edge. Nothing pops in the middle of the
//      view, and the re-scatter set is minimal by construction.
//   2. HASH-STABLE placement (plan §5.4/§5.5). A cell's jittered point is a
//      pure function of its WORLD cell index and the seed — never of the
//      player, the frame, the tier or `Math.random`. Walk away and come back,
//      teleport out and back, park/unpark, rebake: the same blades reappear in
//      the same places. That is what makes park invisible and node tests
//      possible.
//   3. Even, low-discrepancy coverage. A jittered (stratified) grid is
//      blue-noise-ish by construction — no clumps, no bald patches, and no
//      rejection sampling.
//
// AMORTISATION. `update()` walks a cursor through the ring, examining at most
// `scanBudget` instances and RE-SCATTERING at most `sliceSize` of them. An
// instance is re-scattered when (a) its slot now maps to a different world cell
// or (b) its last oracle sample came back `null` (an unbaked landblock — retry
// on the next lap). Everything else is untouched: no per-frame CPU write, no
// per-frame buffer upload. Steady state allocates nothing — every scratch
// object, every typed array and every buffer-update range is allocated once at
// construction.
//
// DEGENERATE INSTANCES. An instance whose ground is the wrong family, is
// outside the disc, has no cached height, or sits on an unbaked landblock is
// written as ZERO SCALE — in the consumer's scale attribute AND in the
// instance matrix, so it is zero-area for any material, including one that
// ignores the attribute. It costs a vertex shader invocation and nothing else.
//
// DISTANCE BLEND. The pool publishes `uniforms` (centre, radius, fade start,
// shape) and a per-instance scatter-time `fade` in the fill context; the
// CONSUMER's shader applies the blend. The pool builds no material and injects
// no GLSL — `SCATTER_FADE_GLSL` at the bottom is an OPTIONAL copy-in helper so
// grass and sand fade identically, not something this module installs.
//
// INJECTED THREE (the `trail_map.js` / `particle_attach.js` idiom). This module
// imports nothing. `createScatterPool({ THREE, ... })` takes THREE as an
// argument and it is OPTIONAL: with no THREE the pool still runs its full CPU
// bookkeeping into its own Float32Arrays and simply builds no GPU objects. That
// is what makes `test_terrain_scatter.mjs` a pure-node test and `?nullRender=1`
// free.
//
// INVARIANTS (plan §5). This is a HOST module, not a registered VFX component,
// so it is not swept by `vfx/lint_caps.js` — it obeys the firewall anyway. It
// reads only terrain (static/derived) + a player position + the frame clock,
// writes only its own buffers, adds no light (§5.2), varies no program cache
// key (§5.4), uses no `Math.random` (§5.5), and forces `castShadow = false` on
// the mesh it creates (§5.7 — added geometry is paid twice by the depth pass).
//
// COORDINATE FRAME. AC world metres: +X east, +Y north, +Z up — the frame you
// are already in inside `terrainGroup` (plan §2.1). Do not run coordinates
// through `acToThree`. Offsets are ABSOLUTE world coordinates in f32; at the
// far corner of Dereth (~49 km) one f32 ULP is ~4 mm, which is below the
// visible jitter of any effect in this plan. If a consumer ever needs better,
// it must re-base the mesh and re-scatter, not silently accept a smaller world.

// ---------------------------------------------------------------------------
// Defaults + pure helpers (no THREE — the directly tested surface).
// ---------------------------------------------------------------------------

export const SCATTER_DEFAULTS = Object.freeze({
  count: 20000,        // requested instances; rounded UP to a square grid
  radiusM: 48,         // half-extent of the window: it covers 2*radiusM metres
  sliceSize: 512,      // MAX instances re-scattered per update() (plan §3.1)
  scanBudget: 2048,    // MAX instances examined per update()
  fadeFraction: 0.2,   // fade to zero over the last 20% of R (plan §3.1)
  jitter: 1,           // 0 = exact lattice, 1 = full cell-sized jitter
  shape: "disc",       // "disc" (plan-faithful, circular) | "square"
  seed: 0x5bd1e995,
  heightOffsetM: 0,    // lift above ground (sand streamers sit 0.05..0.4 up)
  teleportJumpM: 192,  // one landblock — beyond this a move is a teleport and
                       // triggers a full re-scatter (same rule as trail_map.js)
  maxUpdateRuns: 4,    // buffer-upload ranges per flush before going full-buffer
  maxPendingRanges: 16, // un-consumed ranges tolerated before going full-buffer
});

/**
 * Deterministic 32-bit hash of three integers + a seed. This is the INTEGER
 * form of `wind_rig.js:199 hash01(str)` — same FNV-1a spirit, but it takes
 * numbers so a scatter loop never builds a string (which would allocate, and
 * the steady state must not). The murmur3 `fmix32` avalanche at the end is not
 * optional: word-wise FNV alone leaves the low bits badly correlated, and the
 * low bits are exactly what a per-cell jitter uses.
 *
 * @returns {number} u32
 */
export function scatterHashU32(a, b, c, seed) {
  let h = ((seed | 0) ^ 2166136261) >>> 0;
  h = Math.imul(h ^ (a | 0), 16777619) >>> 0;
  h = Math.imul(h ^ (b | 0), 16777619) >>> 0;
  h = Math.imul(h ^ (c | 0), 16777619) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** `scatterHashU32` normalised to [0, 1). */
export function scatterHash01(a, b, c, seed) {
  return scatterHashU32(a, b, c, seed) / 4294967296;
}

/**
 * Side of the square slot grid for a requested instance count. The grid is
 * SQUARE on purpose: a `cols != rows` grid gives non-square cells (uneven
 * density), and a grid with fewer cells than instances would leave a band of
 * empty slots that travels with the player.
 */
export function gridSizeFor(count) {
  const n = Number.isFinite(count) && count > 0 ? count : 1;
  return Math.max(1, Math.ceil(Math.sqrt(n)));
}

/** Actual instance count for a requested count (always a perfect square). */
export function instanceCountFor(count) {
  const g = gridSizeFor(count);
  return g * g;
}

/** Metres per grid cell. */
export function cellSizeFor(radiusM, gridSize) {
  const r = Number.isFinite(radiusM) && radiusM > 0 ? radiusM : SCATTER_DEFAULTS.radiusM;
  const g = gridSize >= 1 ? gridSize : 1;
  return (2 * r) / g;
}

/**
 * Map a fixed slot index to the one world cell index in
 * `[minCell, minCell + gridSize)` congruent to it. THE torus mapping — see the
 * header. Pure, bijective over a full window, and stable: a slot keeps its cell
 * until the window itself scrolls past it.
 */
export function wrapSlotToCell(slot, minCell, gridSize) {
  const g = gridSize >= 1 ? gridSize : 1;
  const m = (slot - minCell) % g;
  return minCell + (m < 0 ? m + g : m);
}

/**
 * Distance blend weight, 1 near the centre falling to 0 at the edge over the
 * last `fadeFraction` of the extent. `shape: "disc"` measures euclidean
 * distance (plan-faithful, circular horizon); `"square"` measures Chebyshev
 * distance, which wastes none of the pool in the corners at the cost of a
 * square footprint. Mirror this exactly in GLSL — or use `SCATTER_FADE_GLSL`.
 */
export function fadeFor(dx, dy, radiusM, fadeFraction, shape) {
  const r = Number.isFinite(radiusM) && radiusM > 0 ? radiusM : 1;
  const f = Number.isFinite(fadeFraction) ? Math.min(1, Math.max(0, fadeFraction)) : 0;
  const d = shape === "square"
    ? Math.max(Math.abs(dx), Math.abs(dy))
    : Math.sqrt(dx * dx + dy * dy);
  if (f <= 0) return d <= r ? 1 : 0;
  const t = (r - d) / (r * f);
  return t <= 0 ? 0 : (t >= 1 ? 1 : t);
}

/**
 * Did the player teleport between these two positions? Any move larger than a
 * landblock in one frame is discontinuous by construction. Same rule and same
 * default as `trail_map.js::isTeleportJump`; duplicated rather than imported so
 * this module stays a true leaf (a scatter pool that does not use the trail map
 * should not have to load it).
 */
export function isScatterTeleport(x0, y0, x1, y1, thresholdM) {
  const t = Number.isFinite(thresholdM) ? thresholdM : SCATTER_DEFAULTS.teleportJumpM;
  const dx = x1 - x0;
  const dy = y1 - y0;
  return dx * dx + dy * dy > t * t;
}

// ---------------------------------------------------------------------------
// The pool.
// ---------------------------------------------------------------------------

function _num(v, fallback, lo, hi) {
  const n = Number.isFinite(v) ? v : fallback;
  if (Number.isFinite(lo) && n < lo) return lo;
  if (Number.isFinite(hi) && n > hi) return hi;
  return n;
}

/**
 * Create an instanced scatter pool.
 *
 * @param {object} opts
 * @param {object} [opts.THREE]        injected THREE namespace. Omit for a
 *   headless CPU-only pool (no mesh, no buffers on the GPU, everything else
 *   identical) — that is the node-test and `?nullRender=1` path.
 * @param {object} [opts.geometry]     the consumer's instance geometry. The
 *   pool CALLS `setAttribute` on it for each schema entry and never disposes
 *   it — the consumer owns the look, including its lifetime.
 * @param {object} [opts.material]     the consumer's material. Never disposed.
 * @param {object} [opts.parent]       optional Object3D to `add()` the mesh to.
 * @param {object|Function} [opts.oracle] the terrain oracle, or a GETTER
 *   returning it. Use the getter form with `terrain_vfx.js`: `ctx.oracle` is a
 *   LIVE getter there and must never be stashed.
 * @param {number} [opts.count]        requested instances (rounded up square).
 * @param {number} [opts.radiusM]
 * @param {number} [opts.sliceSize]    max re-scatters per update().
 * @param {number} [opts.scanBudget]   max instances examined per update().
 * @param {number} [opts.fadeFraction]
 * @param {number} [opts.jitter]       0..1 in-cell jitter amount.
 * @param {"disc"|"square"} [opts.shape]
 * @param {number} [opts.seed]
 * @param {number} [opts.heightOffsetM]
 * @param {number[]|Set<number>} [opts.families] accepted `FAM_*` ids. Empty or
 *   omitted ⇒ every family is accepted (the pool never imports
 *   `terrain_families.js`; ids are just integers to it).
 * @param {(sample:object, ctx:object)=>boolean} [opts.accept] extra predicate,
 *   applied after the family test. Return false ⇒ degenerate.
 * @param {(ctx:object)=>void} [opts.fill] per-instance consumer callback, called
 *   ONLY for accepted instances, before the pool commits the instance. It may
 *   write any attribute (`ctx.set(name, ...)` or `ctx.arrays[name]` +
 *   `ctx.offsets[name]`), adjust `ctx.z`, or set `ctx.live = false` to reject.
 * @param {Array<{name:string,itemSize:number,normalized?:boolean,arrayType?:Function}>}
 *   [opts.attributes] the per-instance schema. Each buffer is allocated EXACTLY
 *   ONCE, here.
 * @param {string} [opts.offsetAttr="aOffset"] name of the world-offset attribute
 *   (written by the pool when present in the schema).
 * @param {string} [opts.scaleAttr="aScale"] name of the scale attribute; the
 *   pool writes 1s on accept (before `fill`) and 0s on reject.
 * @param {string} [opts.normalAttr="aNormal"] name of the ground-normal
 *   attribute (written by the pool when present).
 * @param {boolean} [opts.writeInstanceMatrix=true] also write translation (and
 *   a 0/1 uniform scale) into `InstancedMesh.instanceMatrix`, so a stock
 *   material positions instances with no shader work, degenerate instances are
 *   zero-area for ANY material, and `vfx/per_instance.js ensureVfxHashVarying`
 *   (which derives its hash from `instanceMatrix[3].xy`) works.
 * @param {boolean} [opts.frustumCulled=false] the window moves with the player,
 *   so a computed bounding sphere is stale the moment it is built.
 * @param {boolean} [opts.autoTeleport=true] treat a > `teleportJumpM` jump in
 *   one update as a teleport and re-scatter everything.
 * @param {string} [opts.name="terrain-scatter"]
 */
export function createScatterPool(opts = {}) {
  const THREE = opts.THREE || null;
  const name = typeof opts.name === "string" ? opts.name : "terrain-scatter";

  const gridSize = gridSizeFor(_num(opts.count, SCATTER_DEFAULTS.count, 1, 4194304));
  const count = gridSize * gridSize;
  const radiusM = _num(opts.radiusM, SCATTER_DEFAULTS.radiusM, 1, 4096);
  const cellSizeM = cellSizeFor(radiusM, gridSize);
  const sliceSize = Math.max(1, Math.round(_num(opts.sliceSize, SCATTER_DEFAULTS.sliceSize, 1, count)));
  const scanBudget = Math.max(sliceSize, Math.round(
    _num(opts.scanBudget, Math.max(SCATTER_DEFAULTS.scanBudget, sliceSize), 1, count),
  ));
  const fadeFraction = _num(opts.fadeFraction, SCATTER_DEFAULTS.fadeFraction, 0, 1);
  const jitter = _num(opts.jitter, SCATTER_DEFAULTS.jitter, 0, 1);
  const shape = opts.shape === "square" ? "square" : "disc";
  const seed = (Number.isFinite(opts.seed) ? opts.seed : SCATTER_DEFAULTS.seed) | 0;
  const heightOffsetM = _num(opts.heightOffsetM, SCATTER_DEFAULTS.heightOffsetM, -4096, 4096);
  const teleportJumpM = _num(opts.teleportJumpM, SCATTER_DEFAULTS.teleportJumpM, 1, 1e9);
  const maxUpdateRuns = Math.max(1, Math.round(_num(opts.maxUpdateRuns, SCATTER_DEFAULTS.maxUpdateRuns, 1, 64)));
  const maxPendingRanges = Math.max(maxUpdateRuns, Math.round(
    _num(opts.maxPendingRanges, SCATTER_DEFAULTS.maxPendingRanges, 1, 4096),
  ));
  const autoTeleport = opts.autoTeleport !== false;
  const writeInstanceMatrix = opts.writeInstanceMatrix !== false;
  const frustumCulled = opts.frustumCulled === true;

  const offsetAttrName = typeof opts.offsetAttr === "string" ? opts.offsetAttr : "aOffset";
  const scaleAttrName = typeof opts.scaleAttr === "string" ? opts.scaleAttr : "aScale";
  const normalAttrName = typeof opts.normalAttr === "string" ? opts.normalAttr : "aNormal";

  const fill = typeof opts.fill === "function" ? opts.fill : null;
  const accept = typeof opts.accept === "function" ? opts.accept : null;

  // Family gate. Ids are small integers (FAM_* is 0..8) so a byte mask beats a
  // Set lookup in the hot loop; an empty list means "accept everything".
  const familyMask = new Uint8Array(64);
  let familyGated = false;
  if (opts.families) {
    for (const f of opts.families) {
      const fi = f | 0;
      if (fi >= 0 && fi < familyMask.length) { familyMask[fi] = 1; familyGated = true; }
    }
  }

  const oracleOpt = opts.oracle || null;
  function resolveOracle() {
    if (!oracleOpt) return null;
    if (typeof oracleOpt === "function") {
      try { return oracleOpt() || null; } catch (_) { return null; }
    }
    return oracleOpt;
  }

  // --- per-instance state (allocated once) --------------------------------
  const cellX = new Int32Array(count);
  const cellY = new Int32Array(count);
  const liveFlags = new Uint8Array(count);
  // 1 = the last oracle sample RESOLVED (accepted or legitimately rejected);
  // 0 = it returned null (unbaked landblock) and must be retried on the next
  // lap. Family rejects are resolved on purpose: retrying them every lap would
  // burn the whole slice budget over non-matching terrain.
  const resolvedFlags = new Uint8Array(count);
  // `cellX/cellY` start at a value no real cell can hold so the first pass
  // always re-scatters.
  cellX.fill(0x7fffffff);
  cellY.fill(0x7fffffff);

  // --- attribute buffers (allocated EXACTLY once) -------------------------
  const schema = Array.isArray(opts.attributes) ? opts.attributes : [];
  /** @type {Array<{name:string,itemSize:number,array:Float32Array,attr:object|null,ranges:Array}>} */
  const attrs = [];
  const arrays = Object.create(null);
  const offsets = Object.create(null);
  const attributes = Object.create(null);
  let allocations = 0;

  for (const entry of schema) {
    if (!entry || typeof entry.name !== "string" || entry.name === "") {
      throw new Error(`createScatterPool(${name}): every attribute needs a name`);
    }
    if (arrays[entry.name]) {
      throw new Error(`createScatterPool(${name}): duplicate attribute ${JSON.stringify(entry.name)}`);
    }
    const itemSize = Math.max(1, Math.min(4, entry.itemSize | 0));
    const ArrayType = typeof entry.arrayType === "function" ? entry.arrayType : Float32Array;
    const array = new ArrayType(count * itemSize);
    allocations += 1;
    const rec = {
      name: entry.name,
      itemSize,
      array,
      attr: null,
      normalized: entry.normalized === true,
      ranges: [],
    };
    for (let i = 0; i < maxUpdateRuns; i += 1) rec.ranges.push({ start: 0, count: 0 });
    arrays[entry.name] = array;
    offsets[entry.name] = 0;
    attrs.push(rec);
  }

  const offsetRec = attrs.find((a) => a.name === offsetAttrName) || null;
  const scaleRec = attrs.find((a) => a.name === scaleAttrName) || null;
  const normalRec = attrs.find((a) => a.name === normalAttrName) || null;

  // --- GPU objects (only with THREE) --------------------------------------
  // Declared before the build block: the fail-soft catch below writes it.
  let state_lastError = null;
  let mesh = null;
  let matrixArray = null;
  let matrixAttr = null;
  const matrixRanges = [];
  if (THREE && typeof THREE.InstancedMesh === "function" && opts.geometry && opts.material) {
    try {
      mesh = new THREE.InstancedMesh(opts.geometry, opts.material, count);
      mesh.name = name;
      // §5.7 — added geometry is paid a SECOND time by the shadow depth pass,
      // because three's shadow map swaps the material, not the geometry.
      mesh.castShadow = false;
      mesh.frustumCulled = frustumCulled;
      for (const rec of attrs) {
        const attr = new THREE.InstancedBufferAttribute(rec.array, rec.itemSize, rec.normalized, 1);
        if (THREE.DynamicDrawUsage !== undefined && typeof attr.setUsage === "function") {
          attr.setUsage(THREE.DynamicDrawUsage);
        }
        attr.name = rec.name;
        rec.attr = attr;
        attributes[rec.name] = attr;
        opts.geometry.setAttribute(rec.name, attr);
      }
      matrixAttr = mesh.instanceMatrix || null;
      if (matrixAttr) {
        matrixArray = matrixAttr.array;
        if (THREE.DynamicDrawUsage !== undefined && typeof matrixAttr.setUsage === "function") {
          matrixAttr.setUsage(THREE.DynamicDrawUsage);
        }
        // Identity-with-zero-scale everywhere: nothing renders until the first
        // scatter commits an instance.
        for (let i = 0; i < count; i += 1) {
          const b = i * 16;
          matrixArray[b + 15] = 1;
        }
        for (let i = 0; i < maxUpdateRuns; i += 1) matrixRanges.push({ start: 0, count: 0 });
      }
      if (opts.parent && typeof opts.parent.add === "function") opts.parent.add(mesh);
    } catch (e) {
      // Fail-soft: a pool that cannot build its mesh still runs its CPU
      // bookkeeping, exactly like `trail_map.js` without a renderer.
      mesh = null;
      matrixAttr = null;
      matrixArray = null;
      state_lastError = e;
    }
  }

  // --- uniforms, bound BY REFERENCE by the consumer (plan §5.6) -----------
  const centerVec = THREE && typeof THREE.Vector3 === "function"
    ? new THREE.Vector3(0, 0, 0)
    : { x: 0, y: 0, z: 0 };
  const uniforms = {
    uScatterCenter: { value: centerVec },                        // AC world x,y,z
    uScatterRadius: { value: radiusM },
    uScatterFadeStart: { value: radiusM * (1 - fadeFraction) },
    uScatterShape: { value: shape === "square" ? 1 : 0 },
  };

  const state = {
    name,
    centerX: 0,
    centerY: 0,
    centerZ: 0,
    centered: false,
    cursor: 0,
    frames: 0,
    scans: 0,
    rescatters: 0,
    lastScanned: 0,
    lastRescattered: 0,
    fullRescatters: 0,
    teleports: 0,
    liveCount: 0,
    nullSamples: 0,
    familyRejects: 0,
    outOfRange: 0,
    noHeight: 0,
    fillRejects: 0,
    fillErrors: 0,
  };

  // --- buffer-upload run tracking (allocated once) ------------------------
  // Touched indices arrive in cursor order, so they form a small number of
  // contiguous runs (two at most, when the cursor wraps). We record the runs
  // and translate them into `updateRanges` at flush time; if a flush ever
  // produced more runs than `maxUpdateRuns` we fall back to a full upload
  // rather than growing an array per frame.
  const runStart = new Int32Array(maxUpdateRuns);
  const runEnd = new Int32Array(maxUpdateRuns);
  let runCount = 0;
  let runOverflow = false;

  function markTouched(i) {
    if (runCount > 0 && runEnd[runCount - 1] === i - 1) {
      runEnd[runCount - 1] = i;
      return;
    }
    if (runCount >= maxUpdateRuns) { runOverflow = true; return; }
    runStart[runCount] = i;
    runEnd[runCount] = i;
    runCount += 1;
  }

  function pushRanges(attr, ranges, itemSize) {
    if (!attr) return;
    const pending = attr.updateRanges;
    if (runOverflow || !pending || pending.length + runCount > maxPendingRanges) {
      // Empty `updateRanges` means "upload the whole buffer" in three's
      // WebGLAttributes — the correct, always-safe fallback.
      if (pending && typeof attr.clearUpdateRanges === "function") attr.clearUpdateRanges();
      attr.needsUpdate = true;
      return;
    }
    for (let r = 0; r < runCount; r += 1) {
      const range = ranges[r];
      range.start = runStart[r] * itemSize;
      range.count = (runEnd[r] - runStart[r] + 1) * itemSize;
      pending.push(range);
    }
    attr.needsUpdate = true;
  }

  function flushRanges() {
    if (runCount === 0 && !runOverflow) return;
    for (const rec of attrs) pushRanges(rec.attr, rec.ranges, rec.itemSize);
    pushRanges(matrixAttr, matrixRanges, 16);
    runCount = 0;
    runOverflow = false;
  }

  function markAllTouched() {
    runCount = 1;
    runStart[0] = 0;
    runEnd[0] = count - 1;
    runOverflow = false;
  }

  // --- the reusable scratch objects (steady state allocates NOTHING) ------
  const _sample = {};
  const _ctx = {
    /** instance index */
    index: 0,
    /** world cell this instance owns (the hash domain — stable placement) */
    cellX: 0,
    cellY: 0,
    /** world position; `fill` may adjust `z` (e.g. to lift a streamer) */
    x: 0,
    y: 0,
    z: 0,
    /** ground normal at (x, y) */
    nx: 0,
    ny: 0,
    nz: 1,
    /** terrain code / family / cell-corner codes from the oracle sample */
    code: -1,
    family: 0,
    cornerCodes: null,
    /** the raw oracle sample (do not retain — it is reused every instance) */
    sample: null,
    /** distance from the pool centre at SCATTER time, and the matching blend */
    dist: 0,
    fade: 1,
    /** set false to reject this instance (it becomes degenerate) */
    live: true,
    /** raw buffers + this instance's base index into each */
    arrays,
    offsets,
    /** deterministic per-instance [0,1) stream; `channel` is any small int */
    rand(channel) {
      return scatterHash01(_ctx.cellX, _ctx.cellY, (channel | 0) + 16, seed);
    },
    /** write up to 4 components into a named attribute for this instance */
    set(attrName, v0, v1, v2, v3) {
      const arr = arrays[attrName];
      if (!arr) return false;
      const base = offsets[attrName];
      arr[base] = v0;
      if (v1 !== undefined) arr[base + 1] = v1;
      if (v2 !== undefined) arr[base + 2] = v2;
      if (v3 !== undefined) arr[base + 3] = v3;
      return true;
    },
  };

  function setOffsets(i) {
    for (let a = 0; a < attrs.length; a += 1) {
      const rec = attrs[a];
      offsets[rec.name] = i * rec.itemSize;
    }
  }

  function writeMatrix(i, x, y, z, live) {
    if (!matrixArray) return;
    const b = i * 16;
    const s = live ? 1 : 0;
    matrixArray[b] = s;
    matrixArray[b + 5] = s;
    matrixArray[b + 10] = s;
    matrixArray[b + 12] = x;
    matrixArray[b + 13] = y;
    matrixArray[b + 14] = z;
  }

  function commitDegenerate(i, x, y, z) {
    if (liveFlags[i]) { liveFlags[i] = 0; state.liveCount -= 1; }
    if (offsetRec) {
      const base = i * offsetRec.itemSize;
      offsetRec.array[base] = x;
      if (offsetRec.itemSize > 1) offsetRec.array[base + 1] = y;
      if (offsetRec.itemSize > 2) offsetRec.array[base + 2] = z;
    }
    if (scaleRec) {
      const base = i * scaleRec.itemSize;
      for (let k = 0; k < scaleRec.itemSize; k += 1) scaleRec.array[base + k] = 0;
    }
    if (writeInstanceMatrix) writeMatrix(i, x, y, z, false);
  }

  /**
   * Place instance `i` in world cell (gx, gy). The ONE place placement is
   * decided; everything else in this module is bookkeeping.
   */
  function scatterInstance(i, gx, gy) {
    cellX[i] = gx;
    cellY[i] = gy;
    state.rescatters += 1;
    markTouched(i);

    const jx = jitter > 0 ? (scatterHash01(gx, gy, 1, seed) - 0.5) * jitter : 0;
    const jy = jitter > 0 ? (scatterHash01(gx, gy, 2, seed) - 0.5) * jitter : 0;
    const x = (gx + 0.5 + jx) * cellSizeM;
    const y = (gy + 0.5 + jy) * cellSizeM;

    const dx = x - state.centerX;
    const dy = y - state.centerY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Corner cells of the window lie outside the disc. They are a legitimate,
    // STABLE rejection (the shader fade would hide them anyway) — skipping the
    // oracle for them is the point.
    if (shape !== "square" && dist > radiusM) {
      resolvedFlags[i] = 1;
      state.outOfRange += 1;
      commitDegenerate(i, x, y, 0);
      return;
    }

    const oracle = resolveOracle();
    const s = oracle && typeof oracle.sample === "function" ? oracle.sample(x, y, _sample) : null;
    if (!s) {
      // Unbaked landblock (or no oracle yet). NOT resolved: retry next lap —
      // this is the "blades stay degenerate until the LB lands" case in the
      // plan's grass lifecycle note.
      resolvedFlags[i] = 0;
      state.nullSamples += 1;
      commitDegenerate(i, x, y, 0);
      return;
    }
    resolvedFlags[i] = 1;

    if (familyGated && !familyMask[s.family & 63]) {
      state.familyRejects += 1;
      commitDegenerate(i, x, y, s.hasHeight ? s.height : 0);
      return;
    }
    if (s.hasHeight !== true || !Number.isFinite(s.height)) {
      // The oracle cached codes but no heights (a mesh baked before Wave 0A
      // added `heights` to userData). Grounding is impossible; do not guess.
      state.noHeight += 1;
      commitDegenerate(i, x, y, 0);
      return;
    }

    _ctx.index = i;
    _ctx.cellX = gx;
    _ctx.cellY = gy;
    _ctx.x = x;
    _ctx.y = y;
    _ctx.z = s.height + heightOffsetM;
    const n = s.normal;
    _ctx.nx = n ? n.x : 0;
    _ctx.ny = n ? n.y : 0;
    _ctx.nz = n ? n.z : 1;
    _ctx.code = s.code;
    _ctx.family = s.family;
    _ctx.cornerCodes = s.cornerCodes || null;
    _ctx.sample = s;
    _ctx.dist = dist;
    _ctx.fade = fadeFor(dx, dy, radiusM, fadeFraction, shape);
    _ctx.live = true;
    setOffsets(i);

    if (accept && accept(s, _ctx) === false) {
      state.familyRejects += 1;
      commitDegenerate(i, x, y, _ctx.z);
      return;
    }

    // Sensible defaults BEFORE `fill`, so a consumer that only cares about
    // tint never has to remember to un-degenerate the scale.
    if (scaleRec) {
      const base = i * scaleRec.itemSize;
      for (let k = 0; k < scaleRec.itemSize; k += 1) scaleRec.array[base + k] = 1;
    }
    if (normalRec) {
      const base = i * normalRec.itemSize;
      normalRec.array[base] = _ctx.nx;
      if (normalRec.itemSize > 1) normalRec.array[base + 1] = _ctx.ny;
      if (normalRec.itemSize > 2) normalRec.array[base + 2] = _ctx.nz;
    }

    if (fill) {
      try {
        fill(_ctx);
      } catch (e) {
        state.fillErrors += 1;
        state_lastError = e;
        _ctx.live = false;
      }
    }

    if (_ctx.live === false) {
      state.fillRejects += 1;
      commitDegenerate(i, x, y, _ctx.z);
      return;
    }

    // The consumer may have moved the instance in z (lift) — commit AFTER fill.
    if (offsetRec) {
      const base = i * offsetRec.itemSize;
      offsetRec.array[base] = _ctx.x;
      if (offsetRec.itemSize > 1) offsetRec.array[base + 1] = _ctx.y;
      if (offsetRec.itemSize > 2) offsetRec.array[base + 2] = _ctx.z;
    }
    if (writeInstanceMatrix) writeMatrix(i, _ctx.x, _ctx.y, _ctx.z, true);
    if (!liveFlags[i]) { liveFlags[i] = 1; state.liveCount += 1; }
  }

  function windowMinCell(v) {
    return Math.floor((v - radiusM) / cellSizeM);
  }

  function syncUniforms() {
    centerVec.x = state.centerX;
    centerVec.y = state.centerY;
    centerVec.z = state.centerZ;
  }

  /**
   * Full, non-amortised re-scatter of every instance. THE teleport entry point
   * (plan §3.1 "On teleport: full re-scatter"); also used for the very first
   * frame, which is a teleport from nowhere.
   * @returns {number} instances re-scattered (always the full count)
   */
  function rescatterAll(cx, cy, cz) {
    if (Number.isFinite(cx) && Number.isFinite(cy)) {
      state.centerX = cx;
      state.centerY = cy;
      if (Number.isFinite(cz)) state.centerZ = cz;
      state.centered = true;
      syncUniforms();
    }
    const gxMin = windowMinCell(state.centerX);
    const gyMin = windowMinCell(state.centerY);
    runCount = 0;
    runOverflow = false;
    for (let i = 0; i < count; i += 1) {
      const sx = i % gridSize;
      const sy = (i / gridSize) | 0;
      scatterInstance(i, wrapSlotToCell(sx, gxMin, gridSize), wrapSlotToCell(sy, gyMin, gridSize));
    }
    markAllTouched();
    flushRanges();
    state.fullRescatters += 1;
    state.lastRescattered = count;
    state.lastScanned = count;
    state.cursor = 0;
    return count;
  }

  /**
   * Advance one frame: re-centre, then re-scatter an amortised slice.
   *
   * @param {number} dt seconds (accepted for symmetry with the rest of the VFX
   *   tick surface; placement is time-INDEPENDENT by design — plan §5.5).
   * @param {number} cx AC world x of the player/camera.
   * @param {number} cy AC world y.
   * @param {number} [cz] AC world z (published in the centre uniform only).
   * @returns {number} instances re-scattered this call (≤ sliceSize, or the
   *   full count on a teleport / first frame).
   */
  function update(dt, cx, cy, cz) {
    state.frames += 1;
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
      state.lastScanned = 0;
      state.lastRescattered = 0;
      return 0;
    }
    const teleported = autoTeleport && state.centered
      && isScatterTeleport(state.centerX, state.centerY, cx, cy, teleportJumpM);
    if (teleported) state.teleports += 1;
    if (!state.centered || teleported) return rescatterAll(cx, cy, cz);

    state.centerX = cx;
    state.centerY = cy;
    if (Number.isFinite(cz)) state.centerZ = cz;
    syncUniforms();

    const gxMin = windowMinCell(cx);
    const gyMin = windowMinCell(cy);
    let scanned = 0;
    let written = 0;
    runCount = 0;
    runOverflow = false;
    let i = state.cursor;
    while (scanned < scanBudget && written < sliceSize && scanned < count) {
      const sx = i % gridSize;
      const sy = (i / gridSize) | 0;
      const gx = wrapSlotToCell(sx, gxMin, gridSize);
      const gy = wrapSlotToCell(sy, gyMin, gridSize);
      if (gx !== cellX[i] || gy !== cellY[i] || resolvedFlags[i] === 0) {
        scatterInstance(i, gx, gy);
        written += 1;
      }
      scanned += 1;
      i += 1;
      if (i >= count) i = 0;
    }
    state.cursor = i;
    state.scans += scanned;
    state.lastScanned = scanned;
    state.lastRescattered = written;
    if (written > 0) flushRanges();
    return written;
  }

  /**
   * Force every instance to be re-examined by subsequent amortised ticks
   * (without an immediate full re-scatter). Use it when the ground under the
   * pool may have changed but the player did not move — a landblock finished
   * baking, a rebake landed, the family set changed.
   */
  function invalidate() {
    resolvedFlags.fill(0);
  }

  function dispose() {
    if (mesh) {
      try { if (mesh.parent) mesh.parent.remove(mesh); } catch (_) {}
      // `InstancedMesh.dispose()` releases the instance matrix/colour buffers
      // it created. The GEOMETRY and MATERIAL belong to the consumer — the
      // pool never disposes what it did not allocate.
      try { mesh.dispose(); } catch (_) {}
      mesh = null;
    }
    matrixAttr = null;
    matrixArray = null;
    for (const rec of attrs) rec.attr = null;
  }

  function stats() {
    return {
      name,
      count,
      gridSize,
      radiusM,
      cellSizeM,
      shape,
      sliceSize,
      scanBudget,
      fadeFraction,
      seed,
      hasMesh: !!mesh,
      centered: state.centered,
      centerX: state.centerX,
      centerY: state.centerY,
      cursor: state.cursor,
      frames: state.frames,
      scans: state.scans,
      rescatters: state.rescatters,
      lastScanned: state.lastScanned,
      lastRescattered: state.lastRescattered,
      fullRescatters: state.fullRescatters,
      teleports: state.teleports,
      live: state.liveCount,
      degenerate: count - state.liveCount,
      nullSamples: state.nullSamples,
      familyRejects: state.familyRejects,
      outOfRange: state.outOfRange,
      noHeight: state.noHeight,
      fillRejects: state.fillRejects,
      fillErrors: state.fillErrors,
      allocations,
      lastError: state_lastError ? String(state_lastError && state_lastError.message || state_lastError) : null,
    };
  }

  return {
    // identity / config (read-only)
    name,
    count,
    gridSize,
    radiusM,
    cellSizeM,
    shape,
    sliceSize,
    seed,
    get mesh() { return mesh; },
    uniforms,
    arrays,
    attributes,
    // lifecycle
    update,
    rescatterAll,
    invalidate,
    dispose,
    stats,
    // per-instance introspection (tests, diagnostics — not a hot path)
    isLive: (i) => liveFlags[i] === 1,
    cellOf: (i, out) => {
      const o = out || { x: 0, y: 0 };
      o.x = cellX[i];
      o.y = cellY[i];
      return o;
    },
    // Test seams. Read-only by convention.
    _cellX: cellX,
    _cellY: cellY,
    _live: liveFlags,
    _resolved: resolvedFlags,
    _state: state,
  };
}

// ---------------------------------------------------------------------------
// OPTIONAL shader helper. The pool installs nothing and builds no material —
// this is a copy-in so every consumer of the pool fades identically. Inject it
// with the repo's own substrate (`vfx/vertex_install.js`), declare the four
// uniforms from `pool.uniforms` BY REFERENCE (plan §5.6), and remember that
// `hbScatterFade` must be fed the instance's WORLD xy — which is
// `instanceMatrix[3].xy` on the default path, or the `aOffset` attribute.
// ---------------------------------------------------------------------------

export const SCATTER_FADE_GLSL = `
uniform vec3 uScatterCenter;
uniform float uScatterRadius;
uniform float uScatterFadeStart;
uniform int uScatterShape;
float hbScatterFade(vec2 worldXy) {
  vec2 d = worldXy - uScatterCenter.xy;
  float dist = (uScatterShape == 1) ? max(abs(d.x), abs(d.y)) : length(d);
  // LINEAR, matching fadeFor() on the CPU exactly. A smoothstep here would
  // disagree with the scatter-time fade a consumer may have baked per instance.
  float band = max(uScatterRadius - uScatterFadeStart, 1e-4);
  return clamp((uScatterRadius - dist) / band, 0.0, 1.0);
}
`;
