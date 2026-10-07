// Batched-material variant (2026-10-06) — one material OBJECT per program kind.
//
// THE COST. The statics batchers (static_batch_x.js `_getOrCreateBucket`,
// statics.js `consolidateStaticSingletons`) hand a member's own surface
// material to `new THREE.BatchedMesh(..., mat)`, and the same object keeps
// drawing on plain Meshes (passthrough singletons, buildings). three caches
// ONE current program per material object (renderer.properties is keyed by
// the material), and a BatchedMesh needs a different program (BATCHING
// define) — so every switch between a batched and a plain draw of that
// material sets `needsProgramChange` and re-runs getProgram → getParameters +
// getProgramCacheKey. Live, 1070, settled Holtburg: 76 re-resolves per frame,
// all on materials used as "mesh+batched"; getParameters + getProgram were
// 4.8% of main-thread self time. three r184's `materialVariant` sort already
// groups the two kinds inside a material; only distinct objects stop it.
//
// THE VARIANT. A per-member second material object (a shape-identical clone
// kept in sync once per frame — see "CLONES, NOT PROTOTYPES" below). three keys
// its per-material properties by the VARIANT object, so the batched program is
// cached apart and never flips.
//
// RULE: never WRITE through a bucket's `bm.material` — write the member
// material (the batchers already key and reap by the member object).
// `?batchMatVariant=off` restores sharing the member object.

const _variantOf = new WeakMap(); // member material -> variant
const _memberOf = new WeakMap();  // variant -> member material

let _flag;
let _runtimeOn; // runtime override (A/B seam); undefined => URL flag

/** DEFAULT-ON; `?batchMatVariant=off` escapes. */
export function batchMatVariantEnabled() {
  if (_runtimeOn !== undefined) return _runtimeOn;
  if (_flag !== undefined) return _flag;
  let on = true;
  try {
    if (typeof window !== "undefined" && window.location?.search) {
      const v = (new URLSearchParams(window.location.search).get("batchMatVariant") || "").toLowerCase();
      if (v === "off" || v === "0" || v === "false" || v === "no") on = false;
    }
  } catch (_) { on = true; }
  return (_flag = on);
}

// 2026-10-06 — CLONES, NOT PROTOTYPES. The first cut built each variant with
// `Object.create(mat)`. Every such object gets its own V8 hidden class (the
// prototype is part of the map), so mixing ~100 of them into three's material
// population made every material property read in the hot path megamorphic —
// refreshUniformsCommon / refreshMaterialUniforms / setMaterial / projectObject
// / renderBufferDirect all slowed for EVERY draw, not just the buckets' (node
// micro-bench: 2.2x slower reads; 1070 bench: `?batchMatVariant=off` +1.5 fps
// steady, but 1.3-1.5 s program-flip links on tours). A variant is now a real
// instance of the member's class whose own properties are assigned BY REFERENCE
// from the member in the member's key order — the same hidden class as the
// member, and the same Color / texture / userData / defines objects — and
// `syncBatchMatVariants()` (once per frame, before render) copies any own
// property whose value changed (opacity fades, re-seated maps, quality pokes,
// and `version`, so a member needsUpdate recompiles the variant too). Writes
// still go to the MEMBER (the RULE above); the sync makes the bucket follow.
const _live = new Map(); // variant -> { mat, keys, hot, ver, onVariantDispose, onMemberDispose }
let _forwarding = false;

// 2026-10-07 — HOLDERS. `_live` is walked every frame and references each
// member strongly, so a variant has to LEAVE it when the last BatchedMesh
// drawing with it goes away. Before this, nothing removed an entry short of
// the member being disposed — which the material cache never does to a
// handed-out material (its `?matBudgetMB` eviction drops the cache's reference
// and leaves the rest to GC) — so every surface ever batched stayed synced
// each frame and reachable, textures included, for the whole session (scout
// measurement: 0.61 ms/frame at 400 variants, 14.2 ms at 8,000). The batchers
// call `holdBatchedMaterial(bm)` when they build a BatchedMesh and
// `releaseBatchedMaterial(bm)` when they dispose it; the last release drops
// the variant and disposes ONLY it (three frees its program reference and
// per-material state; the member and the textures they share are untouched).
const _holds = new WeakMap();    // member -> number of BatchedMeshes holding it
const _holderOf = new WeakMap(); // BatchedMesh -> member it holds
let _holdersLive = 0;
let _variantsDropped = 0;
function _skipKey(k) {
  return k === "id" || k === "uuid" || k === "_listeners" ||
    (k.charCodeAt(0) === 95 && k.charCodeAt(1) === 95 && (k.startsWith("__hb") || k.startsWith("__dsp")));
}
function _mirrorKeys(mat) {
  const keys = [];
  for (const k of Object.keys(mat)) if (!_skipKey(k)) keys.push(k);
  return keys;
}
/** Copy changed values for `keys`; returns the keys that differed. */
function _mirror(v, mat, keys, changed) {
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const val = mat[k];
    if (v[k] !== val) { v[k] = val; if (changed) changed.push(k); }
  }
}
// Keys compared EVERY frame (the ones members actually change at runtime:
// fades, texture re-seats, render-state pokes, needsUpdate). Everything else is
// compared on a round-robin full sweep (FULL_SWEEP_DIV variants per frame); a key
// the sweep finds changed joins that variant's per-frame list for good. Measured
// on the 1070 street view: a full compare of every variant every frame cost
// 0.67 ms/frame (~400 variants x ~70 keys).
const HOT_DEFAULT = ["version", "opacity", "visible", "transparent", "depthWrite", "depthTest", "_alphaTest",
  "map", "normalMap", "roughnessMap", "aoMap", "emissiveMap", "alphaMap", "emissiveIntensity", "side",
  "blending", "colorWrite", "fog", "wireframe"];
const FULL_SWEEP_DIV = 32;
let _sweepPhase = 0;

/** Once per frame, before render: bring every live variant up to its member. */
export function syncBatchMatVariants() {
  _sweepPhase = (_sweepPhase + 1) % FULL_SWEEP_DIV;
  let i = 0;
  for (const [v, e] of _live) {
    const mat = e.mat;
    if (mat.version !== e.ver || (i++ % FULL_SWEEP_DIV) === _sweepPhase) {
      // Full compare: a version bump can come with NEW own properties (an
      // onBeforeCompile / customProgramCacheKey installed by a VFX patch).
      if (mat.version !== e.ver) { e.keys = _mirrorKeys(mat); e.ver = mat.version; }
      const changed = [];
      _mirror(v, mat, e.keys, changed);
      for (const k of changed) if (!e.hot.includes(k)) e.hot.push(k);
    } else {
      _mirror(v, mat, e.hot, null);
    }
  }
}

/** The material a BatchedMesh built from member material `mat` should use. */
export function batchedMaterialFor(mat) {
  if (!mat || Array.isArray(mat) || !mat.isMaterial || !batchMatVariantEnabled()) return mat;
  if (_memberOf.has(mat)) return mat; // already a variant
  let v = _variantOf.get(mat);
  if (v) return v;
  try { v = new mat.constructor(); } catch (_) { v = null; }
  if (!v || !v.isMaterial) return mat; // exotic subclass: share the member (legacy behaviour)
  const keys = _mirrorKeys(mat);
  _mirror(v, mat, keys, null);
  _variantOf.set(mat, v);
  _memberOf.set(v, mat);
  const e = { mat, keys, hot: HOT_DEFAULT.filter((k) => keys.includes(k)), ver: mat.version,
    onVariantDispose: null, onMemberDispose: null };
  _live.set(v, e);
  // Disposal stays what it meant before the variant existed, in both
  // directions: disposing the bucket's material disposes the member, and a
  // member dispose frees the variant's three slot. `_forwarding` stops the
  // two listeners bouncing. Kept on the entry so `_dropVariant` can unhook them.
  try {
    e.onVariantDispose = () => {
      if (_forwarding) return;
      _forwarding = true;
      try { mat.dispose(); } catch (_) { /* fail-soft */ } finally { _forwarding = false; }
    };
    e.onMemberDispose = () => {
      _live.delete(v);
      _variantOf.delete(mat);
      if (_forwarding) return;
      _forwarding = true;
      try { v.dispatchEvent({ type: "dispose" }); } catch (_) { /* fail-soft */ } finally { _forwarding = false; }
    };
    v.addEventListener("dispose", e.onVariantDispose);
    mat.addEventListener("dispose", e.onMemberDispose);
  } catch (_) { /* fail-soft */ }
  return v;
}

/**
 * Record that `bm` (a statics BatchedMesh, already constructed with
 * `batchedMaterialFor(member)` or the member itself) draws the member's
 * variant until `releaseBatchedMaterial(bm)`. Counted with the flag off too,
 * so a variant made later by `setBatchMatVariant(root, true)` still drops.
 */
export function holdBatchedMaterial(bm) {
  const m = bm?.material;
  if (!m || Array.isArray(m) || !m.isMaterial || _holderOf.has(bm)) return false;
  const member = memberMaterialOf(m);
  _holderOf.set(bm, member);
  _holds.set(member, (_holds.get(member) || 0) + 1);
  _holdersLive += 1;
  return true;
}

/** Teardown half of `holdBatchedMaterial`; idempotent per BatchedMesh. */
export function releaseBatchedMaterial(bm) {
  const member = bm ? _holderOf.get(bm) : undefined;
  if (member === undefined) return false;
  _holderOf.delete(bm);
  _holdersLive -= 1;
  const n = (_holds.get(member) || 1) - 1;
  if (n > 0) { _holds.set(member, n); return true; }
  _holds.delete(member);
  _dropVariant(member);
  return true;
}

function _dropVariant(member) {
  const v = _variantOf.get(member);
  if (!v) return;
  const e = _live.get(v);
  _live.delete(v);
  _variantOf.delete(member);
  _memberOf.delete(v);
  // Unhook BOTH listeners before the dispose: the variant's would forward it
  // to the member, which plain meshes are still drawing with.
  if (e) {
    try { v.removeEventListener("dispose", e.onVariantDispose); } catch (_) { /* fail-soft */ }
    try { member.removeEventListener("dispose", e.onMemberDispose); } catch (_) { /* fail-soft */ }
  }
  _forwarding = true;
  try { v.dispose(); } catch (_) { /* fail-soft */ } finally { _forwarding = false; }
  _variantsDropped += 1;
}

/** Diag/test snapshot: variants synced per frame, BatchedMeshes holding one, variants dropped. */
export function batchMatVariantStats() {
  return { live: _live.size, holders: _holdersLive, dropped: _variantsDropped };
}

/** The member material behind `m` (identity for a non-variant). */
export function memberMaterialOf(m) {
  return _memberOf.get(m) || m;
}

/** Test seam. */
export function __resetBatchMatVariantForTest() { _flag = undefined; _runtimeOn = undefined; }

/**
 * Runtime A/B seam: re-point every statics BatchedMesh under `root` at the
 * variant (on) or the member (off). Returns the number of buckets touched.
 */
export function setBatchMatVariant(root, on) {
  _runtimeOn = !!on;
  let n = 0;
  root?.traverse?.((o) => {
    if (!o.isBatchedMesh || !o.material || Array.isArray(o.material)) return;
    const ud = o.userData || {};
    if (!(ud.__staticBatchCrossLb || ud.__staticBatch)) return;
    const member = memberMaterialOf(o.material);
    const want = on ? batchedMaterialFor(member) : member;
    if (o.material !== want) { o.material = want; n++; }
  });
  return n;
}
