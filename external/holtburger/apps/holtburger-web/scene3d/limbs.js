// scene3d/limbs.js — Phase 2: limb registry + visual limping (2026-08-02).
//
// AC creature models are RIGID PART ARRAYS: a Setup (0x02) is a flat list of
// parts, and our rig mirrors that literally — every `part_${i}` Group is a
// DIRECT child of `inst.root` (entities.js spawn loop), posed model-space by
// the rest frame (setup_rig.js `applyRestPoseFrame`) and then overwritten
// frame-by-frame by the AnimationMixer / `poseRigAt`. The Setup ALSO carries a
// parent index per part slot — the authoring-time hierarchy retail uses for
// attachment/parenting decisions. That hierarchy is invisible in the rendered
// rig (flat parenting is deliberate: anim frames are model-space), but it is
// exactly what we need to answer "which parts belong to the same limb?".
//
// This module owns that derivation:
//
//   1. `fetchSetupParentIndex(setupId)` (wasm) -> one u32 per part slot,
//      0xFFFFFFFF = root, empty = no hierarchy / failure.
//   2. Walk every leaf to the root -> one CHAIN per leaf.
//   3. Score each chain by the LOWEST point its parts reach in the REST pose
//      (part geometry bbox transformed by the part's rest frame, min Z — the
//      entity root is the AC frame, +Z up).
//   4. Legs = the cluster of chains whose lowest point sits markedly below the
//      rest of the model. Split by the largest gap in the LOWER HALF of the
//      sorted chain scores (robust against both bipeds and quadrupeds; the
//      absolute-height thresholds that "obviously" work on a human fail on an
//      Olthoi whose thorax hangs at knee height).
//
// Validated against two real Setups:
//   - Olthoi Noble (biped)      — 7 chains; 2 at z ~= 0.0 vs >= 1.14 for arms.
//   - Olthoi Primordial (quad)  — 12 chains; 4 at 0.23..0.86 vs >= 1.31.
//
// The registry is a pure classification — it changes NOTHING on its own. The
// consumer is `applyLimbLimp`, a POST-EVALUATION rig offset gated behind
// `?limbDamage` — DEFAULT ON since 2026-08-02 (owner direction); the literal
// "off" is the escape hatch (`!== "off"` reader shape).
//
// Seams: this module makes NO material / animation-track decisions and never
// touches the mixer, its clips, or their InterpolateDiscrete interpolation
// (retail-faithful, load-bearing). It only writes `position`/`quaternion` on
// part Groups AFTER the frame's pose has been evaluated, and it remembers what
// it wrote so a non-animating rig can be restored instead of drifting.
//
// No `three` import: every transform here is hand-rolled scalar math over the
// duck-typed `.position` / `.quaternion` fields (matching setup_rig.js's
// THREE-injection discipline). That keeps the pure classification functions
// unit-testable under bare Node.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Setup parent-index sentinel for "this part is the root". */
export const PARENT_ROOT = 0xffffffff;

/**
 * Minimum absolute score gap (metres) that may be read as the leg/not-leg
 * split. Guards the degenerate case where every chain bottoms out at the same
 * height (a static prop, a fan, a chest): the largest gap is then ~0 and would
 * otherwise "classify" an arbitrary prefix as legs. Both validated fixtures
 * clear this by a wide margin (Noble 1.12, Primordial 0.45).
 */
export const MIN_LEG_GAP = 0.1;

/** Gait period of the limp cycle, seconds (one buckle per cycle). */
export const LIMP_PERIOD_S = 0.9;

/** Peak limb rotation at severity 1.0, radians (~12 degrees). */
export const LIMP_MAX_ANGLE = 0.21;

/** Peak limb sink at severity 1.0, metres. */
export const LIMP_MAX_DIP = 0.06;

const TWO_PI = Math.PI * 2;

// ---------------------------------------------------------------------------
// Flag
// ---------------------------------------------------------------------------

let _flagCache;

/**
 * `?limbDamage` — DEFAULT ON (2026-08-02 owner direction); `?limbDamage=off`
 * is the escape hatch. Memoised (the URL cannot change mid-session) and lazy,
 * so importing this module under Node (unit tests) never touches `window`
 * (no window at all still reads OFF — bare-node stays inert).
 *
 * @returns {boolean} true when limb-damage visuals are active.
 */
export function limbDamageEnabled() {
  if (_flagCache !== undefined) return _flagCache;
  let on = false;
  try {
    if (typeof window !== "undefined" && window.location) {
      on = new URLSearchParams(window.location.search).get("limbDamage") !== "off";
    }
  } catch (_) {
    on = false;
  }
  _flagCache = on;
  return on;
}

/** Test-only: drop the memoised flag so a harness can re-read it. */
export function _resetLimbFlagCacheForTests() {
  _flagCache = undefined;
}

// ---------------------------------------------------------------------------
// Pure classification (plain arrays only — no THREE, no wasm, no DOM)
// ---------------------------------------------------------------------------

/**
 * Build one chain per leaf part from a Setup parent index.
 *
 * A LEAF is a part slot that is nobody's parent. Each chain is emitted
 * root-first: `[rootPart, ..., leafPart]`. A part whose parent is
 * `PARENT_ROOT` (or out of range — malformed data) terminates the walk and
 * becomes the chain head. Cyclic parent data is defended against with a step
 * cap so a bad Setup can never hang the caller.
 *
 * @param {ArrayLike<number>} parentIndex  one u32 per part slot.
 * @returns {{rootIndex: number, chains: number[][], leaves: number[]}}
 *   `rootIndex` is the first slot flagged `PARENT_ROOT` (-1 when none).
 */
export function buildChains(parentIndex) {
  const n = parentIndex ? parentIndex.length : 0;
  const out = { rootIndex: -1, chains: [], leaves: [] };
  if (n === 0) return out;

  const isParent = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    const p = parentIndex[i] >>> 0;
    if (p === PARENT_ROOT) {
      if (out.rootIndex < 0) out.rootIndex = i;
      continue;
    }
    if (p < n) isParent[p] = 1;
  }

  for (let i = 0; i < n; i += 1) {
    if (isParent[i]) continue;
    out.leaves.push(i);
    // Walk leaf -> root, then reverse. `seen` + the step cap make a cyclic
    // parent index terminate instead of spinning.
    const up = [i];
    const seen = new Set([i]);
    let cur = i;
    for (let step = 0; step < n; step += 1) {
      const p = parentIndex[cur] >>> 0;
      if (p === PARENT_ROOT || p >= n || seen.has(p)) break;
      up.push(p);
      seen.add(p);
      cur = p;
    }
    up.reverse();
    out.chains.push(up);
  }
  return out;
}

/**
 * Score one chain: the lowest rest-pose point any of its NON-ROOT parts
 * reaches. The root part is excluded because it is the body/torso anchor every
 * chain shares — including it would flatten all scores to the same value.
 *
 * @param {number[]} chain  root-first part indices (from `buildChains`).
 * @param {ArrayLike<number>|Map<number, number>} partMinZ  part index -> lowest
 *   rest-pose Z. Missing / non-finite entries are skipped (a part with no
 *   decoded geometry contributes nothing).
 * @returns {number|undefined} the chain score, or undefined when nothing in the
 *   chain is scorable.
 */
export function chainScore(chain, partMinZ) {
  if (!chain || chain.length < 2) return undefined;
  const read = typeof partMinZ?.get === "function"
    ? (i) => partMinZ.get(i)
    : (i) => partMinZ[i];
  let best;
  for (let k = 1; k < chain.length; k += 1) {
    const z = read(chain[k]);
    if (typeof z !== "number" || !Number.isFinite(z)) continue;
    if (best === undefined || z < best) best = z;
  }
  return best;
}

/**
 * Robust leg split over chain scores.
 *
 * Sort the scorable chain scores ascending and take the LARGEST GAP between
 * consecutive scores within the lower half; everything below that gap is a leg.
 * Half-scoping matters: on a quadruped the biggest gap overall often sits at
 * the top of the distribution (antennae vs body), which would sweep the legs
 * into the "not a leg" bucket.
 *
 * Rejects (returns `[]`) when the winning gap is smaller than `MIN_LEG_GAP`,
 * when it would yield fewer than two legs, or when it would classify every
 * chain as a leg.
 *
 * @param {Array<number|undefined>} scores  one entry per chain; undefined =
 *   unscorable (can never be a leg).
 * @param {{minGap?: number}} [opts]
 * @returns {number[]} chain indices classified as legs, ascending.
 */
export function splitLegChains(scores, opts) {
  const minGap = opts && typeof opts.minGap === "number" ? opts.minGap : MIN_LEG_GAP;
  const ranked = [];
  for (let i = 0; i < scores.length; i += 1) {
    const s = scores[i];
    if (typeof s === "number" && Number.isFinite(s)) ranked.push({ idx: i, s });
  }
  const n = ranked.length;
  if (n < 2) return [];
  ranked.sort((a, b) => a.s - b.s);

  const halfCount = Math.max(1, Math.floor(n / 2));
  let bestGap = -Infinity;
  let bestAt = -1;
  for (let i = 0; i < halfCount && i < n - 1; i += 1) {
    const gap = ranked[i + 1].s - ranked[i].s;
    if (gap > bestGap) {
      bestGap = gap;
      bestAt = i;
    }
  }
  if (bestAt < 0 || bestGap < minGap) return [];
  const legCount = bestAt + 1;
  if (legCount < 2 || legCount >= n) return [];
  return ranked.slice(0, legCount).map((e) => e.idx).sort((a, b) => a - b);
}

/**
 * Tag one leg chain by the rest-pose position of its leaf part.
 *
 * The rig is FLAT, so a part's rest origin is already model-space — no chain
 * composition needed. Model frame is AC: +Z up, +Y forward, +X right (right-
 * handed, forward x up = right).
 *
 * `end` (front/back) is only meaningful on a multi-leg creature: on a biped
 * both legs sit at the same fore/aft station and the sign is noise, so it is
 * reported as `null`.
 *
 * @param {number} leafX  leaf part rest origin X.
 * @param {number} leafY  leaf part rest origin Y.
 * @param {boolean} multiLeg  true when the creature has more than two legs.
 * @returns {{side: "L"|"R", end: "F"|"B"|null}}
 */
export function tagLeg(leafX, leafY, multiLeg) {
  const side = (Number.isFinite(leafX) && leafX < 0) ? "L" : "R";
  if (!multiLeg) return { side, end: null };
  const end = (Number.isFinite(leafY) && leafY < 0) ? "B" : "F";
  return { side, end };
}

/**
 * Full pure classification: parent index + per-part rest-pose lowest Z + flat
 * rest origins -> chains and tagged legs.
 *
 * @param {ArrayLike<number>} parentIndex  one u32 per part slot.
 * @param {ArrayLike<number>|Map<number, number>} partMinZ  part -> lowest rest Z.
 * @param {ArrayLike<number>} [restOrigins]  flat xyz triples (part p at p*3).
 *   Omitted -> every leg is tagged `{side:"R", end:null}` (harmless: side/end
 *   are cosmetic labels, the limp itself never reads them).
 * @param {{minGap?: number}} [opts]
 * @returns {{rootIndex: number, chains: number[][], legs: Array<object>}}
 */
export function classifyLimbs(parentIndex, partMinZ, restOrigins, opts) {
  const { rootIndex, chains } = buildChains(parentIndex);
  const scores = chains.map((c) => chainScore(c, partMinZ));
  const legIdx = splitLegChains(scores, opts);
  const multiLeg = legIdx.length > 2;
  const legs = legIdx.map((ci, li) => {
    const chain = chains[ci];
    const leaf = chain[chain.length - 1];
    // `parts` is the FULL chain (root-first) so it reads the same way the
    // classification fixtures do. `movable` is what the limp offsets: the
    // chain minus the shared root/torso part, which must never move (moving it
    // would drag the whole body, not the limb).
    const movable = chain.slice(1);
    const lx = restOrigins ? restOrigins[leaf * 3 + 0] : NaN;
    const ly = restOrigins ? restOrigins[leaf * 3 + 1] : NaN;
    const { side, end } = tagLeg(lx, ly, multiLeg);
    const hip = movable.length > 0 ? movable[0] : leaf;
    return {
      chainIndex: ci,
      parts: chain,
      movable,
      hip,
      leaf,
      side,
      end,
      score: scores[ci],
      // Deterministic per-leg phase so two damaged legs do not buckle in
      // lockstep. Alternating half-cycle offsets read as a stagger, not noise.
      phaseOffset: li * Math.PI,
    };
  });
  return { rootIndex, chains, legs };
}

// ---------------------------------------------------------------------------
// Rest-pose geometry probe (duck-typed three.js objects — still no import)
// ---------------------------------------------------------------------------

/**
 * Rotate `(x,y,z)` by a three.js-order quaternion `(qx,qy,qz,qw)` and write the
 * result into `out` (a 3-element array, reused by the caller — no allocation).
 *
 * @param {number[]} out  destination [x,y,z].
 */
function rotateVec3(x, y, z, qx, qy, qz, qw, out) {
  // v' = v + 2 * qv x (qv x v + w*v)
  const ux = qy * z - qz * y + qw * x;
  const uy = qz * x - qx * z + qw * y;
  const uz = qx * y - qy * x + qw * z;
  out[0] = x + 2 * (qy * uz - qz * uy);
  out[1] = y + 2 * (qz * ux - qx * uz);
  out[2] = z + 2 * (qx * uy - qy * ux);
  return out;
}

const _corner = [0, 0, 0];

/**
 * Lowest Z reached by an axis-aligned box after being placed by a rest frame.
 * Transforms all eight corners (the box is axis-aligned in PART space; the rest
 * quaternion is arbitrary, so a corner-sweep is required — rotating just the
 * min corner is wrong).
 *
 * Pure: plain arrays in, number out.
 *
 * @param {number[]} min  box min [x,y,z] in part space.
 * @param {number[]} max  box max [x,y,z] in part space.
 * @param {number[]} quat rest orientation, three.js order [qx,qy,qz,qw].
 * @param {number[]} origin rest origin [x,y,z].
 * @returns {number} lowest Z in model space.
 */
export function minZOfBoxUnderFrame(min, max, quat, origin) {
  let lowest = Infinity;
  for (let c = 0; c < 8; c += 1) {
    const x = (c & 1) ? max[0] : min[0];
    const y = (c & 2) ? max[1] : min[1];
    const z = (c & 4) ? max[2] : min[2];
    rotateVec3(x, y, z, quat[0], quat[1], quat[2], quat[3], _corner);
    const wz = _corner[2] + origin[2];
    if (wz < lowest) lowest = wz;
  }
  return lowest;
}

const _q4 = [0, 0, 0, 1];
const _o3 = [0, 0, 0];
const _bmin = [0, 0, 0];
const _bmax = [0, 0, 0];

/**
 * Per-part lowest rest-pose Z for one spawned entity.
 *
 * Reads the part Groups' OWN surface meshes only — filtered by
 * `mesh.userData.partIndex === p`, the stamp `buildPartSurfaceMeshes` puts on
 * every mesh it creates. Without that filter a wielded child entity (whose root
 * is parented under the wielder's part node by `attachChildToParent`) would
 * drag its sword geometry into the host part's bounding box and poison the
 * score.
 *
 * The rest frame comes from the arrays entities.js stashes at spawn
 * (`inst._restOrigins` / `inst._restOrientations`, AC wire order
 * `(qw,qx,qy,qz)`) — NOT from the live Group transforms, which the mixer has
 * very likely already overwritten by the time this runs.
 *
 * @param {object} inst  EntityInstance.
 * @returns {Array<number|undefined>|null} part -> lowest Z, or null when the
 *   entity carries no usable rest pose.
 */
export function partMinZFromInstance(inst) {
  const parts = inst && inst.parts;
  const origins = inst && inst._restOrigins;
  const orients = inst && inst._restOrientations;
  if (!Array.isArray(parts) || parts.length === 0) return null;
  if (!origins || !orients) return null;
  if (origins.length < parts.length * 3 || orients.length < parts.length * 4) return null;

  const out = new Array(parts.length);
  let any = false;
  for (let p = 0; p < parts.length; p += 1) {
    const g = parts[p];
    const kids = g && g.children;
    if (!kids || kids.length === 0) continue;
    let have = false;
    for (let k = 0; k < kids.length; k += 1) {
      const m = kids[k];
      if (!m || !m.geometry) continue;
      if (!m.userData || m.userData.partIndex !== p) continue; // skip attachments
      let bb = m.geometry.boundingBox;
      if (!bb && typeof m.geometry.computeBoundingBox === "function") {
        try { m.geometry.computeBoundingBox(); } catch (_) { /* ignore */ }
        bb = m.geometry.boundingBox;
      }
      if (!bb || !bb.min || !bb.max) continue;
      if (!have) {
        _bmin[0] = bb.min.x; _bmin[1] = bb.min.y; _bmin[2] = bb.min.z;
        _bmax[0] = bb.max.x; _bmax[1] = bb.max.y; _bmax[2] = bb.max.z;
        have = true;
      } else {
        if (bb.min.x < _bmin[0]) _bmin[0] = bb.min.x;
        if (bb.min.y < _bmin[1]) _bmin[1] = bb.min.y;
        if (bb.min.z < _bmin[2]) _bmin[2] = bb.min.z;
        if (bb.max.x > _bmax[0]) _bmax[0] = bb.max.x;
        if (bb.max.y > _bmax[1]) _bmax[1] = bb.max.y;
        if (bb.max.z > _bmax[2]) _bmax[2] = bb.max.z;
      }
    }
    if (!have) continue;
    // AC wire order is (qw,qx,qy,qz); three.js wants (qx,qy,qz,qw).
    _q4[0] = orients[p * 4 + 1];
    _q4[1] = orients[p * 4 + 2];
    _q4[2] = orients[p * 4 + 3];
    _q4[3] = orients[p * 4 + 0];
    _o3[0] = origins[p * 3 + 0];
    _o3[1] = origins[p * 3 + 1];
    _o3[2] = origins[p * 3 + 2];
    out[p] = minZOfBoxUnderFrame(_bmin, _bmax, _q4, _o3);
    any = true;
  }
  return any ? out : null;
}

// ---------------------------------------------------------------------------
// Registry (async, cached per setupId)
// ---------------------------------------------------------------------------

/** setupId -> registry object, or null for "asked the DAT, there is none". */
const _registry = new Map();
/** setupId -> in-flight build promise (dedupes concurrent spawns). */
const _pending = new Map();
let _warnedNoWasm = false;

/**
 * Synchronous accessor: the cached registry for a setup, or null.
 *
 * NEVER builds. The per-frame path calls this and bails on null, so an entity
 * whose registry is still in flight (or whose Setup has no hierarchy) simply
 * does not limp.
 *
 * @param {number} setupId
 * @returns {object|null}
 */
export function getLimbRegistry(setupId) {
  const r = _registry.get(setupId >>> 0);
  return r === undefined ? null : r;
}

/** Resolve the wasm namespace: explicit arg first, live scene second. */
function _resolveWasm(wasmExports) {
  if (wasmExports && typeof wasmExports.fetchSetupParentIndex === "function") {
    return wasmExports;
  }
  try {
    if (typeof window !== "undefined") {
      const w = window.liveScene3d?.entityManager?.wasmExports;
      if (w && typeof w.fetchSetupParentIndex === "function") return w;
    }
  } catch (_) { /* fail-soft */ }
  return null;
}

/**
 * Build (or return the cached) limb registry for a setup.
 *
 * Cached per `setupId` — the classification is a property of the Setup, not of
 * the spawn, so the first entity of a given model pays the wasm fetch and every
 * sibling reads the same object. A setup with no hierarchy (empty parent index)
 * is cached as `null` so we never re-ask. A missing rest pose / undecoded
 * geometry is NOT cached (transient — a later spawn of the same setup may have
 * both), it just returns null for now.
 *
 * @param {number} setupId
 * @param {object} inst  a spawned EntityInstance of that setup (supplies the
 *   part geometry + rest arrays the scoring needs).
 * @param {object} [wasmExports]  wasm namespace; falls back to
 *   `liveScene3d.entityManager.wasmExports`.
 * @returns {Promise<object|null>} the registry, or null.
 */
export function ensureLimbRegistry(setupId, inst, wasmExports) {
  const key = setupId >>> 0;
  if (!key) return Promise.resolve(null);
  const cached = _registry.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const inflight = _pending.get(key);
  if (inflight) return inflight;

  const p = (async () => {
    const wasm = _resolveWasm(wasmExports);
    if (!wasm) {
      // Not cached — wasm may arrive later. Warn ONCE: a permanently-missing
      // fetchSetupParentIndex (plumb-through gap in index.html's wasmExports
      // bag) otherwise kills limp+ragdoll with zero console output.
      if (!_warnedNoWasm) {
        _warnedNoWasm = true;
        // eslint-disable-next-line no-console
        console.warn("[limbs] fetchSetupParentIndex unavailable on wasmExports — limb registry (limp/ragdoll) disabled until it appears");
      }
      return null;
    }
    let parentIndex;
    try {
      parentIndex = await wasm.fetchSetupParentIndex(key);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[limbs] fetchSetupParentIndex(0x${key.toString(16)}) failed:`, e);
      _registry.set(key, null);
      return null;
    }
    if (!parentIndex || parentIndex.length === 0) {
      _registry.set(key, null); // no hierarchy in this Setup — permanent
      return null;
    }
    const partMinZ = partMinZFromInstance(inst);
    if (!partMinZ) return null; // transient — retry on a later spawn
    const { rootIndex, chains, legs } = classifyLimbs(
      parentIndex,
      partMinZ,
      inst._restOrigins,
    );
    // Pivot = the hip part's REST origin. The per-frame path prefers the hip's
    // live animated position, but this is the fallback when the hip part Group
    // is missing (half-decoded rig).
    //
    // BOUNDS (2026-08-03). `leg.hip` is a SETUP slot index drawn from
    // `parentIndex`, whose length is independent of `inst.parts.length` — and
    // the ONLY length check upstream (`partMinZFromInstance`) validates
    // `origins` against `parts.length`, not against the slot indices the chains
    // actually name. An out-of-range read produced `pivot = [undefined × 3]`,
    // which `applyLimbLimp` fed straight into `position.set(…)` as NaN — and
    // `_resolveBase` then adopted that NaN off the Group as the NEXT frame's
    // base, so the part's matrix could never recover for the entity's whole
    // life. A leg with no usable pivot now simply gets none: the per-frame path
    // skips it unless the live hip Group answers.
    const origins = inst._restOrigins;
    for (const leg of legs) {
      const o = leg.hip * 3;
      const px = origins[o + 0];
      const py = origins[o + 1];
      const pz = origins[o + 2];
      leg.pivot = (Number.isFinite(px) && Number.isFinite(py) && Number.isFinite(pz))
        ? [px, py, pz]
        : null;
    }
    const reg = {
      setupId: key,
      parentIndex,
      rootIndex,
      chains,
      legs,
      partMinZ,
    };
    _registry.set(key, reg);
    return reg;
  })().finally(() => {
    _pending.delete(key);
  });

  _pending.set(key, p);
  return p;
}

/** Test/diag helper: drop every cached registry (forces a rebuild). */
export function clearLimbRegistryCache() {
  _registry.clear();
  _pending.clear();
}

/**
 * Test-only: seed the cache with a hand-built registry so the per-frame limp
 * can be exercised without wasm. Never called by production code.
 */
export function _setLimbRegistryForTests(setupId, reg) {
  _registry.set(setupId >>> 0, reg);
}

// ---------------------------------------------------------------------------
// Damage state
// ---------------------------------------------------------------------------

/**
 * Set (or clear) limb damage on one entity.
 *
 * Keyed by the LEAF part index of the damaged leg chain — the stable identity
 * of a limb in this registry (`registry.legs[i].leaf`). Severity is clamped to
 * [0,1]; `<= 0` removes the entry AND restores the parts that limb had offset,
 * so a cleared limb never leaves a bent rig behind on a non-animating entity.
 *
 * @param {object} inst  EntityInstance.
 * @param {number} leafPart  leg chain leaf part index.
 * @param {number} severity  0..1.
 * @returns {boolean} true when the state changed.
 */
export function setLimbDamage(inst, leafPart, severity) {
  if (!inst) return false;
  const leaf = leafPart | 0;
  const sev = Number.isFinite(severity) ? Math.max(0, Math.min(1, severity)) : 0;
  if (sev <= 0) {
    if (!inst._limbDamage || !inst._limbDamage.has(leaf)) return false;
    inst._limbDamage.delete(leaf);
    // Restoring ALL bases is the simple correct move: the remaining damaged
    // limbs re-establish their bases on the very next tick.
    restoreLimbPose(inst);
    return true;
  }
  if (!inst._limbDamage) inst._limbDamage = new Map();
  inst._limbDamage.set(leaf, sev);
  return true;
}

/**
 * Clear ALL limb damage on an entity and restore the rig it had offset.
 *
 * @param {object} inst  EntityInstance.
 */
export function clearLimbDamage(inst) {
  if (!inst) return;
  restoreLimbPose(inst);
  if (inst._limbDamage) inst._limbDamage.clear();
}

/**
 * Write every remembered pre-offset transform back onto its part Group and drop
 * the bookkeeping. Safe to call on an entity that never limped.
 *
 * @param {object} inst  EntityInstance.
 */
export function restoreLimbPose(inst) {
  const st = inst && inst._limpState;
  if (!st || st.recs.size === 0) return;
  const parts = inst.parts;
  for (const [pi, r] of st.recs) {
    if (!r.valid) continue;
    const g = parts && parts[pi];
    if (!g || !g.position || !g.quaternion) continue;
    g.position.set(r.bx, r.by, r.bz);
    g.quaternion.set(r.bqx, r.bqy, r.bqz, r.bqw);
  }
  st.recs.clear();
  st.t = 0;
}

// ---------------------------------------------------------------------------
// Per-frame limp (zero allocation on the warm path)
// ---------------------------------------------------------------------------

/**
 * Resolve the BASE (pre-offset) transform of a part for this frame.
 *
 * The mixer re-evaluates the rig every frame, so normally the base is just
 * "whatever is on the Group right now". But when nothing drove the rig this
 * frame (no action playing, sequence clamped on a death pose, entity paused),
 * the Group still holds LAST frame's offset — adopting that as the base would
 * integrate the limp and fold the creature in half within a second. So we
 * remember the exact values we wrote and, if the Group still carries them
 * bit-for-bit, we reuse the stored base instead. Exact `===` is correct here:
 * we wrote those doubles ourselves and any pose writer produces different ones.
 */
function _resolveBase(st, pi, g) {
  let r = st.recs.get(pi);
  if (!r) {
    r = {
      bx: 0, by: 0, bz: 0, bqx: 0, bqy: 0, bqz: 0, bqw: 1,
      ox: 0, oy: 0, oz: 0, oqx: 0, oqy: 0, oqz: 0, oqw: 0,
      valid: false,
    };
    st.recs.set(pi, r);
  }
  const p = g.position;
  const q = g.quaternion;
  const untouched = r.valid
    && p.x === r.ox && p.y === r.oy && p.z === r.oz
    && q.x === r.oqx && q.y === r.oqy && q.z === r.oqz && q.w === r.oqw;
  if (!untouched) {
    r.bx = p.x; r.by = p.y; r.bz = p.z;
    r.bqx = q.x; r.bqy = q.y; r.bqz = q.z; r.bqw = q.w;
  }
  return r;
}

/**
 * POST-EVALUATION limp offset for one entity.
 *
 * Call AFTER the frame's pose writers (`mixer.update` / `poseRigAt` and the
 * jump-pose tween) so the offset lands on top of the evaluated pose rather than
 * being overwritten by it. Purely visual: it touches only the damaged leg
 * chains' part Groups, never the root, never the mixer, never a clip.
 *
 * Effect per damaged leg, per frame:
 *   - `w = (1 - cos(phase)) / 2` in [0,1], phase advancing at
 *     `2*pi / LIMP_PERIOD_S` with a per-leg half-cycle offset — one smooth
 *     buckle per gait cycle.
 *   - The whole movable chain is rotated about the model X axis (the sagittal
 *     hinge for a +Y-forward model) through the hip, by
 *     `severity * LIMP_MAX_ANGLE * w`, positions swung about the same pivot so
 *     the limb stays connected.
 *   - The chain additionally sinks `severity * LIMP_MAX_DIP * w` in -Z.
 *
 * Fast bail-outs, in order: flag off, no damage map, no cached registry, no
 * parts. After warm-up there is no allocation on this path.
 *
 * @param {object} inst  EntityInstance.
 * @param {number} dt  seconds since last tick.
 * @returns {boolean} true when an offset was applied this frame.
 */
export function applyLimbLimp(inst, dt) {
  if (!limbDamageEnabled()) return false;
  const dmg = inst && inst._limbDamage;
  if (!dmg || dmg.size === 0) return false;
  const reg = getLimbRegistry(inst._setupId);
  if (!reg || reg.legs.length === 0) return false;
  const parts = inst.parts;
  if (!parts || parts.length === 0) return false;

  let st = inst._limpState;
  if (!st) {
    st = { t: 0, recs: new Map() };
    inst._limpState = st;
  }
  // Clamp pathological dt (tab restore, first frame) so the phase never jumps.
  st.t += (dt > 0 && dt < 0.25) ? dt : 1 / 60;

  let applied = false;
  const legs = reg.legs;
  for (let li = 0; li < legs.length; li += 1) {
    const leg = legs[li];
    const sev = dmg.get(leg.leaf);
    if (!(sev > 0)) continue;
    const movable = leg.movable;
    if (!movable || movable.length === 0) continue;

    const w = 0.5 - 0.5 * Math.cos((st.t * TWO_PI) / LIMP_PERIOD_S + leg.phaseOffset);
    const half = sev * LIMP_MAX_ANGLE * w * 0.5;
    const qs = Math.sin(half);
    const qc = Math.cos(half);
    const dip = -sev * LIMP_MAX_DIP * w;

    // Pivot = the hip part's live (animated) base position, so the swing hinges
    // where the limb actually is this frame. Falls back to the rest-pose pivot
    // when the hip Group is missing.
    const hipG = parts[leg.hip];
    let px;
    let py;
    let pz;
    let hipRec = null;
    if (hipG && hipG.position && hipG.quaternion) {
      hipRec = _resolveBase(st, leg.hip, hipG);
      px = hipRec.bx; py = hipRec.by; pz = hipRec.bz;
    } else if (leg.pivot) {
      px = leg.pivot[0]; py = leg.pivot[1]; pz = leg.pivot[2];
    } else {
      continue;
    }
    // INVARIANT (2026-08-03): this module never writes a non-finite transform.
    // One NaN write is PERMANENT — the offset we write is remembered as the
    // next frame's base, and `_resolveBase`'s bit-exact `===` comparison can
    // never match a NaN, so the rig would re-derive its base from the NaN it
    // just received, every frame, forever. Cheap: this runs only for legs that
    // are actually damaged.
    if (!(Number.isFinite(px) && Number.isFinite(py) && Number.isFinite(pz))) continue;

    for (let k = 0; k < movable.length; k += 1) {
      const pi = movable[k];
      const g = parts[pi];
      if (!g || !g.position || !g.quaternion) continue;
      const r = (pi === leg.hip && hipRec) ? hipRec : _resolveBase(st, pi, g);
      // Same invariant as the pivot above: a base an upstream pose writer has
      // already NaN'd must not be latched into `r.o*` as "we wrote this".
      if (!(Number.isFinite(r.bx) && Number.isFinite(r.by) && Number.isFinite(r.bz))) continue;

      // Swing the base position about the hip, rotating around +X:
      //   y' = y*cos - z*sin,  z' = y*sin + z*cos   (half-angle form below).
      const vx = r.bx - px;
      const vy = r.by - py;
      const vz = r.bz - pz;
      const ny = vy - 2 * qs * (qc * vz + qs * vy);
      const nz = vz + 2 * qs * (qc * vy - qs * vz);

      const nx2 = px + vx;
      const ny2 = py + ny;
      const nz2 = pz + nz + dip;

      // Premultiply the base orientation by q = (sin, 0, 0, cos).
      const nqx = qc * r.bqx + qs * r.bqw;
      const nqy = qc * r.bqy - qs * r.bqz;
      const nqz = qc * r.bqz + qs * r.bqy;
      const nqw = qc * r.bqw - qs * r.bqx;

      g.position.set(nx2, ny2, nz2);
      g.quaternion.set(nqx, nqy, nqz, nqw);

      r.ox = nx2; r.oy = ny2; r.oz = nz2;
      r.oqx = nqx; r.oqy = nqy; r.oqz = nqz; r.oqw = nqw;
      r.valid = true;
      applied = true;
    }
  }
  return applied;
}

// ---------------------------------------------------------------------------
// __diag surface
// ---------------------------------------------------------------------------

function _entityByGuid(guid) {
  try {
    const em = window.liveScene3d?.entityManager;
    if (!em || !em.entityMap) return null;
    const g = typeof guid === "string" ? Number.parseInt(guid, 16) : guid;
    return em.entityMap.get(g >>> 0) ?? em.entityMap.get(g) ?? null;
  } catch (_) {
    return null;
  }
}

/** Resolve "a guid or a setup id" to `{ inst, setupId }`. */
function _resolveTarget(guidOrSetupId) {
  const inst = _entityByGuid(guidOrSetupId);
  if (inst) return { inst, setupId: inst._setupId >>> 0 };
  const raw = typeof guidOrSetupId === "string"
    ? Number.parseInt(guidOrSetupId, 16)
    : guidOrSetupId;
  return { inst: null, setupId: (raw | 0) >>> 0 };
}

function _summarize(reg) {
  if (!reg) return null;
  return {
    setupId: `0x${reg.setupId.toString(16)}`,
    rootIndex: reg.rootIndex,
    partCount: reg.parentIndex.length,
    chainCount: reg.chains.length,
    legs: reg.legs.map((l) => ({
      leaf: l.leaf,
      hip: l.hip,
      parts: l.parts.slice(),
      side: l.side,
      end: l.end,
      score: l.score,
    })),
    chains: reg.chains.map((c) => c.slice()),
  };
}

/**
 * `window.__diag.limbs` — devtools driver for the Phase 2 work.
 *
 *   __diag.limbs.enabled()                  -> limb damage on? (DEFAULT ON)
 *   __diag.limbs.registry(guidOrSetupId)    -> cached classification (or null)
 *   __diag.limbs.build(guid)                -> Promise, forces the wasm fetch
 *   __diag.limbs.damage(guid, leaf, sev)    -> start limping that leg
 *   __diag.limbs.clear(guid)                -> stop + restore the rig
 *   __diag.limbs.list()                     -> every entity currently limping
 *
 * Attached from diag.js's single installation point, mirroring the
 * `attach<Name>(diag)` pattern the other surfaces use.
 *
 * @param {object} diag  the `window.__diag` bag under construction.
 */
export function attachLimbs(diag) {
  diag.limbs = {
    enabled() {
      return limbDamageEnabled();
    },

    registry(guidOrSetupId) {
      const { setupId } = _resolveTarget(guidOrSetupId);
      return _summarize(getLimbRegistry(setupId));
    },

    build(guidOrSetupId) {
      const { inst, setupId } = _resolveTarget(guidOrSetupId);
      const src = inst || _findInstForSetup(setupId);
      if (!src) {
        return Promise.resolve({ error: `no spawned entity for setup 0x${setupId.toString(16)}` });
      }
      return ensureLimbRegistry(setupId, src).then(_summarize);
    },

    damage(guid, leaf, sev) {
      const inst = _entityByGuid(guid);
      if (!inst) return { error: `no entity ${guid}` };
      const setupId = inst._setupId >>> 0;
      const ok = setLimbDamage(inst, leaf, sev ?? 1);
      const out = {
        guid: `0x${(inst.guid >>> 0).toString(16)}`,
        setupId: `0x${setupId.toString(16)}`,
        leaf,
        severity: inst._limbDamage?.get(leaf | 0) ?? 0,
        changed: ok,
        enabled: limbDamageEnabled(),
        registry: getLimbRegistry(setupId) ? "ready" : "building",
      };
      if (!getLimbRegistry(setupId)) {
        ensureLimbRegistry(setupId, inst).catch(() => {});
      }
      // `?limbDamage` is DEFAULT-ON (owner flip 2026-08-02; url-flags.md:798,
      // reader shape `!== "off"`), so the ONLY way to reach this line is an
      // explicit `?limbDamage=off`. The old text said "=on is NOT set", which
      // reads as "you forgot a flag" and invites re-tightening the reader.
      if (!out.enabled) out.note = "?limbDamage=off is set — no visual change";
      return out;
    },

    clear(guid) {
      const inst = _entityByGuid(guid);
      if (!inst) return { error: `no entity ${guid}` };
      clearLimbDamage(inst);
      return { guid: `0x${(inst.guid >>> 0).toString(16)}`, cleared: true };
    },

    list() {
      const out = [];
      try {
        const em = window.liveScene3d?.entityManager;
        if (em?.entityMap) {
          for (const [guid, inst] of em.entityMap) {
            if (!inst?._limbDamage || inst._limbDamage.size === 0) continue;
            out.push({
              guid: `0x${(guid >>> 0).toString(16)}`,
              setupId: `0x${(inst._setupId >>> 0).toString(16)}`,
              damage: Array.from(inst._limbDamage.entries()).map(([leaf, sev]) => ({ leaf, sev })),
            });
          }
        }
      } catch (_) { /* fail-soft */ }
      return out;
    },

    cacheClear() {
      clearLimbRegistryCache();
      return { cleared: true };
    },
  };
}

/** First spawned entity carrying the given setup id (diag `build()` helper). */
function _findInstForSetup(setupId) {
  try {
    const em = window.liveScene3d?.entityManager;
    if (!em?.entityMap) return null;
    for (const inst of em.entityMap.values()) {
      if ((inst?._setupId >>> 0) === (setupId >>> 0)) return inst;
    }
  } catch (_) { /* fail-soft */ }
  return null;
}
