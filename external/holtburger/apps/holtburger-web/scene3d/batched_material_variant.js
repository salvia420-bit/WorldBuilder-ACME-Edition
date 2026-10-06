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
// THE VARIANT. `Object.create(mat)`: every read (opacity, uniforms, textures,
// userData, onBeforeCompile, customProgramCacheKey, `version`, `id`) falls
// through to the member material, so the bucket keeps following every state
// change made to the member (fades, re-seats, quality pokes, needsUpdate) and
// sorts beside it (same `id`). three keys its per-material properties by the
// VARIANT object, so the batched program is cached apart and never flips.
// Own state is limited to `_listeners` (so three's per-material 'dispose'
// listener is not registered on the member's map) — a member 'dispose' is
// forwarded so three frees the variant's slot too.
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

/** The material a BatchedMesh built from member material `mat` should use. */
export function batchedMaterialFor(mat) {
  if (!mat || Array.isArray(mat) || !mat.isMaterial || !batchMatVariantEnabled()) return mat;
  if (_memberOf.has(mat)) return mat; // already a variant
  let v = _variantOf.get(mat);
  if (v) return v;
  v = Object.create(mat);
  v._listeners = {};
  // Disposing the bucket's material must mean what it meant before: dispose
  // the member (whose 'dispose' is forwarded back to free the variant's slot).
  v.dispose = function () { mat.dispose(); };
  _variantOf.set(mat, v);
  _memberOf.set(v, mat);
  try {
    mat.addEventListener("dispose", () => {
      try { v.dispatchEvent({ type: "dispose" }); } catch (_) { /* fail-soft */ }
      _variantOf.delete(mat);
    });
  } catch (_) { /* fail-soft */ }
  return v;
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
