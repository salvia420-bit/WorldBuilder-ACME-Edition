// scene3d/tile_plan.js — the TilePlan: the bake worker's scene-level product
// (ST9 / T22; pass-07 S1 + D-07.5's precomputation ladder, pass-08 D-08.4/S3).
//
// WHAT A TILEPLAN IS
// ------------------
// Today the bake worker returns decoded GEOMETRY and TEXELS, and every
// grouping/class/matrix decision happens on the main thread after the payload
// lands. Under pools that inverts: the worker emits, alongside pass-4's
// GeometryBundle, a **TilePlan** — for every (placement × subset) the RESOLVED
// class key, the content key, the precomposed world matrix, the layer
// requirement, and the per-cell grouping for envcells.
//
//   **The main thread never derives a class.** (pass-07 D-07.5)
//
// That is the whole point of the artefact: class resolution is pure function
// of pack-resident records (surface flags → renderState, VFX plan → set#config
// token, TEXREF → array page), so it belongs off-thread with the rest of the
// decode, and the main thread's feed becomes "look up, addInstance, flip".
//
// FORMAT (pass-07 S1, normative)
// ------------------------------
//   { tile, lbs: [u32],
//     members: [{ classKey, contentKey, matrix, rsId, domain, passClass,
//                 sectorKey, layer?, cellId?, bandGids?, band?, pos?,
//                 lightList? }],
//     counts: { byClass: {classKey: n}, members, sectors } }
//
// WIRE SHAPE — `encodeTilePlan` packs the per-member Float32Array(16) matrices
// into ONE Float32Array so a plan structured-clones as a handful of objects
// plus one transferable buffer, instead of N tiny typed arrays (N ≈ hundreds
// per tile). `decodeTilePlan` restores views over that buffer without copying.
//
// LIFETIME — the plan is DROPPED after feed (pass-07 D-07.6). The only
// retained per-tile bookkeeping is the pool registry's membership record;
// re-derivation on any future need re-reads the resident pack.
//
// STATE OF THIS FILE (2026-08-10, T22): the format, the validator, the pure
// builder and the transfer codec are landed and battery-covered, and the bake
// worker carries the `tileBake` job that runs the builder off-thread. What is
// NOT landed is the worker-side resolution of raw pack records into axis
// records — that reproduces materials.js's builder ladder (ClipMap render
// state, patch installers, VFX plans) off-thread and is the T22 report's named
// remainder. Until it lands, `buildTilePlan` takes its axis facts from an
// injected resolver, so the seam is real and the missing half is one function.

import { classKeyOf, passClassOf, sectorKeyOfLb, isPooledDomain } from "./pool_class_key.js";

/** Members per plan above which a producer should split the tile (the W3
 *  feed budget bounds the BATCH, not the plan; this is a sanity ceiling that
 *  makes a runaway producer loud instead of slow). [A] */
export const TILE_PLAN_MAX_MEMBERS = 20_000;

// ---------------------------------------------------------------------------
// validation (loud, cheap, run on every plan the registry is asked to feed)
// ---------------------------------------------------------------------------

/**
 * @param {object} plan
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateTilePlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== "object") return { ok: false, errors: ["plan is not an object"] };
  if (!Number.isInteger(plan.tile)) errors.push("tile must be an integer tile key");
  if (!Array.isArray(plan.members)) {
    errors.push("members must be an array");
    return { ok: false, errors };
  }
  if (plan.members.length > TILE_PLAN_MAX_MEMBERS) {
    errors.push(`members ${plan.members.length} exceeds TILE_PLAN_MAX_MEMBERS ${TILE_PLAN_MAX_MEMBERS}`);
  }
  const seen = new Set();
  for (let i = 0; i < plan.members.length; i++) {
    const m = plan.members[i];
    if (!m || typeof m !== "object") { errors.push(`member ${i}: not an object`); continue; }
    if (typeof m.classKey !== "string" || m.classKey.length === 0) errors.push(`member ${i}: classKey missing`);
    if (typeof m.sectorKey !== "string" || m.sectorKey.length === 0) errors.push(`member ${i}: sectorKey missing`);
    if (m.contentKey == null) errors.push(`member ${i}: contentKey missing`);
    if (!isPooledDomain(m.domain)) errors.push(`member ${i}: domain "${m.domain}" is not pooled (st|ec)`);
    if (m.matrix != null && m.matrix.length !== 16) errors.push(`member ${i}: matrix must have 16 elements`);
    if (m.bandGids != null && (!Array.isArray(m.bandGids) || m.bandGids.length !== 2)) {
      errors.push(`member ${i}: bandGids must be a [near, far] pair`);
    }
    if (m.classKey) seen.add(m.classKey);
  }
  if (plan.counts && plan.counts.byClass) {
    for (const k of Object.keys(plan.counts.byClass)) {
      if (!seen.has(k)) errors.push(`counts.byClass has class "${k}" no member carries`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// the builder (pure — runs in the bake worker; no three, no DOM, no fetch)
// ---------------------------------------------------------------------------

/**
 * Build a TilePlan from resolved pack facts.
 *
 * Everything class-shaped is derived HERE, once, off-thread: `classKeyOf` is
 * the only key producer (S3: never hand-built) and `passClassOf` derives the
 * pass from post-ladder render state, never from a predicate (D-07.3 — the
 * ClipMap eye-test failure is the standing proof that a predicate arm is
 * invisible to every harness metric).
 *
 * @param {object} input
 * @param {number} input.tile                 tile key
 * @param {number[]} [input.lbs]              the tile's landblock keys
 * @param {Array<object>} input.placements    one row per placement:
 *   `{ lbx, lby, modelId, partId, subsetIdx, matrix:Float32Array(16),
 *      surfaceKey, rsId?, cellId?, degradeContentKey?, band?, pos?,
 *      castShadow?, receiveShadow?, domain? }`
 * @param {(surfaceKey:any, placement:object)=>object|null} input.resolveAxes
 *   surfaceKey → the raw AXIS RECORD (`pool_class_key.axisRecordOf` shape).
 *   Memoised by the builder per surfaceKey, so a tile's ~hundreds of
 *   placements resolve a handful of surfaces.
 * @param {(placement:object)=>string} [input.contentKeyOf]
 * @returns {{plan: object, stats: object}}
 */
export function buildTilePlan(input) {
  const {
    tile, lbs = [], placements = [], resolveAxes,
    contentKeyOf = (p) => `${p.modelId}|${p.partId ?? 0}|${p.subsetIdx ?? 0}`,
  } = input || {};
  if (typeof resolveAxes !== "function") throw new Error("tile_plan: resolveAxes required");

  const axisMemo = new Map();
  const classMemo = new Map();
  const members = [];
  const byClass = Object.create(null);
  const sectors = new Set();
  const stats = { placements: placements.length, unresolved: 0, unpooled: 0, surfaces: 0 };

  for (const p of placements) {
    let axes = axisMemo.get(p.surfaceKey);
    if (axes === undefined) {
      axes = resolveAxes(p.surfaceKey, p) || null;
      axisMemo.set(p.surfaceKey, axes);
      stats.surfaces += 1;
    }
    if (!axes) { stats.unresolved += 1; continue; }

    // domain rides the placement (statics vs envcell); the axis record's own
    // domain is the fallback so a resolver may carry it either way.
    const domain = p.domain || axes.domain || "st";
    if (!isPooledDomain(domain)) { stats.unpooled += 1; continue; }

    // Shadow flags are NODE-level today and become POOL-level under pools
    // (D-07.6): they belong to the placement, not the surface, so they join
    // the axis record before the key is built.
    const cast = p.castShadow !== undefined ? p.castShadow === true : axes.castShadow === true;
    const recv = p.receiveShadow !== undefined ? p.receiveShadow === true : axes.receiveShadow === true;
    const ckKey = `${p.surfaceKey}|${domain}|${cast ? 1 : 0}|${recv ? 1 : 0}`;
    let resolved = classMemo.get(ckKey);
    if (resolved === undefined) {
      const rec = { ...axes, domain, castShadow: cast, receiveShadow: recv };
      resolved = { classKey: classKeyOf(rec), passClass: passClassOf(rec) };
      classMemo.set(ckKey, resolved);
    }

    const sectorKey = sectorKeyOfLb(p.lbx, p.lby);
    sectors.add(sectorKey);
    const member = {
      classKey: resolved.classKey,
      passClass: resolved.passClass,
      domain,
      sectorKey,
      contentKey: contentKeyOf(p),
      matrix: p.matrix,
      rsId: p.rsId >>> 0 || 0,
      layer: p.layer | 0,
    };
    if (p.cellId != null) member.cellId = p.cellId;
    if (p.degradeContentKey != null) {
      // D-07.8: both band geometries are pool-resident members of the SAME
      // class (same surface ⇒ same class by construction), so the band pair
      // is a content-key pair, never a class decision.
      member.bandGids = [member.contentKey, p.degradeContentKey];
      member.band = p.band | 0;
      if (p.pos) member.pos = p.pos;
    }
    if (p.lightList) member.lightList = p.lightList;
    members.push(member);
    byClass[resolved.classKey] = (byClass[resolved.classKey] || 0) + 1;
  }

  const plan = {
    tile,
    lbs: Array.from(lbs),
    members,
    counts: { byClass, members: members.length, sectors: sectors.size },
  };
  return { plan, stats };
}

// ---------------------------------------------------------------------------
// transfer codec (ONE buffer for N matrices — the worker→main hop)
// ---------------------------------------------------------------------------

/**
 * Pack a plan for `postMessage`. The member matrices collapse into one
 * Float32Array (transferable); every other field structured-clones as plain
 * data.
 * @returns {{payload: object, transfer: ArrayBuffer[]}}
 */
export function encodeTilePlan(plan) {
  const n = plan.members.length;
  const mats = new Float32Array(n * 16);
  const members = new Array(n);
  for (let i = 0; i < n; i++) {
    const m = plan.members[i];
    if (m.matrix) mats.set(m.matrix, i * 16);
    const { matrix, ...rest } = m;
    members[i] = rest;
  }
  const payload = {
    v: 1,
    tile: plan.tile,
    lbs: plan.lbs,
    members,
    matrices: mats,
    counts: plan.counts,
  };
  return { payload, transfer: [mats.buffer] };
}

/** Restore a plan from `encodeTilePlan`'s payload. Matrices become subarray
 *  VIEWS over the transferred buffer — no copy, and `setMatrixAt` accepts
 *  them through the registry's `fromArray`. */
export function decodeTilePlan(payload) {
  if (!payload || payload.v !== 1) throw new Error("tile_plan: unsupported payload version");
  const mats = payload.matrices instanceof Float32Array
    ? payload.matrices
    : new Float32Array(payload.matrices);
  const members = payload.members.map((m, i) => ({
    ...m,
    matrix: mats.subarray(i * 16, i * 16 + 16),
  }));
  return { tile: payload.tile, lbs: payload.lbs, members, counts: payload.counts };
}

// ---------------------------------------------------------------------------
// bake-worker job shape (pass-08 S3 vocabulary)
// ---------------------------------------------------------------------------

/** The worker message type for a tile bake. */
export const TILE_BAKE_MESSAGE = "tileBake";
/** The result `kind` the client branches on. */
export const TILE_PLAN_RESULT_KIND = "tilePlan";

/**
 * Worker-side handler body, factored out so it is testable in node without a
 * Worker. `job` is the posted message; `deps.resolveAxes` is the surface →
 * axis-record resolution (the named remainder: the wasm record ladder).
 * Returns the `postMessage` argument pair.
 */
export function runTileBakeJob(job, deps = {}) {
  const { plan, stats } = buildTilePlan({
    tile: job.tile,
    lbs: job.lbs,
    placements: job.placements || [],
    resolveAxes: deps.resolveAxes || ((k) => (job.axes ? job.axes[k] : null)),
    contentKeyOf: deps.contentKeyOf,
  });
  const check = validateTilePlan(plan);
  if (!check.ok) {
    // A malformed plan is LOUD: it is a producer bug, and a half-plan fed
    // into pools is exactly the silent-corruption class the S2.4 ordering
    // invariant exists to prevent.
    throw new Error(`tile_plan: invalid plan for tile ${job.tile}: ${check.errors.slice(0, 4).join("; ")}`);
  }
  const { payload, transfer } = encodeTilePlan(plan);
  return {
    message: {
      type: "result",
      id: job.id,
      kind: TILE_PLAN_RESULT_KIND,
      payload,
      stats,
    },
    transfer,
  };
}
