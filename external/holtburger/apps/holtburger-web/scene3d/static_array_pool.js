// scene3d/static_array_pool.js — GLOBAL texture-array layer pools for the
// cross-LB statics BATCHER (`?statArrayMerge`, 2026-08-06, DEFAULT-OFF).
//
// WHAT THIS IS FOR. `static_batch_x.js` keys its region buckets by the MATERIAL
// OBJECT, so every distinct surface in a 3x3-LB region is its own BatchedMesh
// and its own draw. Merging them by (region, tile, state, format) collapses
// that — many textures of one (tile size, render state) sharing ONE array
// texture — at no fidelity cost.
//
// ⚠ SIZE CORRECTION (2026-08-06). Every earlier figure for this work
// (docs/2026-08-06-statics-array-merge-design.md, including its §0b "127 drawn
// -> 54, +2.92 ms") was computed over a RESIDENT population, not a SUBMITTED
// one: `projectStatMergeBuckets._projDrawn` tests `visible` + `instances > 0`
// and never the frustum, so "drawn" removed 4 buckets of 346. Re-measured with a
// real submitted-scale sampler (`__statMergeArmSubmitted`, which shadows
// `onBeforeRender` and counts what three actually submits) on a settled Nanto
// session:
//
//     submitted BatchedMesh nodes: 128   (mergeable 60 + deformed 68)
//
//     MERGEABLE  60 -> regionStrict 35   = +1.00 ms   <- image-preserving
//     DEFORMED   68 -> regionStrict 43   = +1.00 ms
//     COMBINED  128 -> 78                = +2.00 ms
//
// **Do not quote 2.9 ms.** The honest prize is ~1.00 ms per half. Note the
// deformed population is the LARGER half (68 of 128) — see the VFX hook below.
//
// THE TWO NUMBERS THAT FIX THE SHAPE — both measured, neither re-derivable here:
//   1. **The 3x3-LB region key stays.** A region-width sweep bought 0.00 ms
//      (376 -> 245 resident buckets removed 14 draws) and div=12 was 1.1 ms
//      WORSE, because a merged bucket then straddles visible and invisible
//      space. Resident bucket count and DRAWN bucket count are decoupled.
//      So the BatchedMesh must stay regional (node-level frustum culling).
//   2. **The arrays must be GLOBAL.** Region-scoped arrays re-cut every layer
//      once per region the surface appears in: 142.2 MB shared against
//      1,440.2 MB region-scoped (10.1x), on a page whose renderer OOM-crashes
//      near 2,800 MB. That multiplier is the same order as the incident the X7
//      grow-on-demand fix just closed (428 MB recovered).
//
// Hence the split this module exists to implement: **global array pools,
// regional BatchedMeshes.** A pool is keyed by (tile, strict render state,
// format) and owns the layer allocator, the two arrays and ONE shared material;
// `static_batch_x.js` owns the per-region BatchedMeshes that index into it.
//
// WHAT IS NOT DONE HERE, deliberately:
//   * **Canonical tile tiers are WITHDRAWN** (docs/2026-08-06-statics-array-merge-design.md
//     §0b). Re-measured in one keying they are worth at most +1.04 ms and that
//     setting downscales 31.6% of the corpus. Native tile sizes only — one pool
//     per (w, h). The prize was never the tiers.
//   * **Sub-rect packing** (many small surfaces inside one layer) is shader-
//     compatible but founders on mips: a 128^2 rect inside a 512^2 layer merges
//     with its neighbours at low mip levels, and a cross-SURFACE bleed is a
//     different order of wrong from the half-texel tile-repeat discontinuity the
//     wrap buckets already accept. Ruled out for this scope, not on principle.
//   * **Routing the batcher's population through `static_atlas.js` as-is.** The
//     atlas is a per-NODE copier (one addGeometry + one addInstance per node);
//     the batcher SHARES one geometry per model across placements (17,774
//     instances over 324 geometries). Routing bulk through the atlas copies
//     17,774 geometries — the measured 89 ms / 4,576-draw wall at
//     `?staticBatch=off&texBc7=off`. This module therefore supplies LAYERS and a
//     MATERIAL and nothing else; the batcher's shared-geometry model is
//     untouched.
//
// EVERY SHADER-SIDE PIECE IS THE ATLAS'S, IMPORTED not transcribed:
// `makeArrayMaterial` (the sampler2DArray / textureGrad(fract(uv)) injection,
// the nra normal/roughness/height unpack, statPom, `customProgramCacheKey`),
// `buildDiffuseArray` / `buildNraArray` (colour space, wrap, filter, mip
// policy), `packNraLayer`, `_stateKeyOf`, `_bucketKeyFor`, `_perLayerBytesFor`,
// `_layerCapacityFor`, `_atlasStartLayersFor`, `_atlasGrowTargetFor`. A pool
// array and an atlas bucket array are the same object by construction, so the
// two populations cannot drift.
//
// ONE THING IS RE-IMPLEMENTED: the growth step (`_growPoolLayers`), because the
// atlas's `_growBucketLayers` reads and writes `bm.userData` of a specific
// BatchedMesh and a pool has no BatchedMesh. The semantics are copied exactly,
// INCLUDING the load-bearing `addLayerUpdate` re-mark: three's first upload of a
// fresh array texture runs `texStorage3D` (contents undefined) and then uploads
// ONLY `layerUpdates` (three.module.js:12160-12195 DataArray, :12026-12070
// CompressedArray), so copying the CPU bytes without re-marking leaves every
// carried-over layer as GPU garbage — a black prop, not a warning.
//
// FAIL-SOFT IS THE CONTRACT. Every rejection path here returns null and the
// caller keeps today's per-material bucket. A surface that cannot be admitted
// (tile over capacity, format mismatch, deformed variant, missing pixels, a
// material property this pool's ONE material cannot replicate) must render
// exactly as it does today — never vanish, never wear another surface's pixels.

import * as THREE from "three";
import {
  isBc7AtlasTexture,
  bc7AtlasShouldDefer,
  statNraEnabled,
  statAtlasGrowEnabled,
  makeArrayMaterial,
  buildDiffuseArray,
  buildNraArray,
  packNraLayer,
  _stateKeyOf,
  _bucketKeyFor,
  _perLayerBytesFor,
  _layerCapacityFor,
  _atlasStartLayersFor,
  _atlasGrowTargetFor,
} from "./static_atlas.js";
import { bc7LevelBytes, makeBc7ArrayTexture, writeBc7ArrayLayer } from "./bc7_textures.js";
import { aoMapIntensityValue } from "./vfx_flags.js";
import { PLANE, planeFor, canSupplyPlanes } from "./surface_planes.js";

let _flag;
/**
 * `?statArrayMerge=on` — array-texture merging of the cross-LB statics batcher's
 * region buckets. EXACT-match opt-in (url-flags.md header rule: an opt-in is
 * never `!== "off"`), **DEFAULT-OFF**. This is a subsystem touching the layer
 * pool, the shader, eviction refcounting and the X7 memory ceiling; the ~2.00 ms
 * is a projection off a live sampler, not a measurement of this code, and it
 * ships off until a 1070 A/B says otherwise.
 */
export function statArrayMergeEnabled() {
  if (_flag !== undefined) return _flag;
  let on = false;
  try {
    if (typeof globalThis !== "undefined" && globalThis.location?.search) {
      const v = (new URLSearchParams(globalThis.location.search).get("statArrayMerge") || "").toLowerCase();
      on = v === "on";
    }
  } catch (_) { on = false; }
  _flag = on;
  return on;
}
/** Test seam. */
export function __setStatArrayMergeForTest(v) { _flag = v; }

// ---------------------------------------------------------------------------
// THE VFX HOOK — how the DEFORMED half is admitted (2026-08-06)
//
// The atlas refuses any `deformation.` variant (`ptDeformed`) and this module's
// first cut copied that. Both were reasoning about the wrong thing. **Sway
// already survives batching today**: `per_instance.js` derives `vVfxHash` under
// an explicit `#ifdef USE_BATCHING` from `batchingMatrix[3].xy`, three r184
// applies `batchingMatrix` AFTER the `begin_vertex` seam where windSwayGpu
// writes its object-space shear, and 206 live BatchedMesh buckets already carry
// a windSwayGpu variant because `_getOrCreateBucket` uses the member material
// verbatim. The gate is about MATERIAL SUBSTITUTION — the array material never
// went through `buildFragVariant` — not about batching.
//
// So the fix is to build the variant INTO the pool material rather than to keep
// the population out. Three things make that sound and one makes it bounded:
//
//   1. **The set is in the KEY.** `__vfxSetKey` plus a config token joins the
//      pool key, so membership and material are decided by the same key: a
//      bucket can NEVER contain a member whose variant its material does not
//      carry. That is the only shape that cannot reproduce the 2026-07-02
//      "trunk sways, foliage frozen" split, where the two halves of one model
//      took different paths. (Per-instance data is not an option — r184
//      BatchedMesh's only channels are the matrix, `setVisibleAt` and
//      `setColorAt`, whose vec4 is consumed by `vColor`.)
//   2. **The chain composes.** `installVfxComponentPatch` goes through
//      `_chainBeforeCompile`, which PRESERVES the existing `onBeforeCompile`
//      and runs it first. `makeArrayMaterial`'s hook keeps `#include <common>`
//      and never touches `#include <begin_vertex>`, which are exactly the two
//      anchors a MECH-B vertex component splices.
//   3. **VERTEX-stage sets only.** A "frag" component anchors on a fragment
//      include — and `makeArrayMaterial` CONSUMES four of them (`<map_fragment>`,
//      `<roughnessmap_fragment>`, `<normal_fragment_maps>`, `<aomap_fragment>`).
//      Its hook runs first, so a frag component anchored on one of those would
//      find the seam gone and go silently inert: the effect would vanish with no
//      error. Any set containing a non-`mech: "B"` component is therefore
//      REJECTED, not composed. Live that costs nothing — the coordinator's
//      census found exactly one set in the world, `deformation.windSwayGpu`,
//      206 of 206.
//
// This also FIXES a hole in this module's first cut, which rejected only sets
// containing `deformation.` and would have silently dropped a frag set's effect
// (e.g. `emissive.glint`) off any other variant material it admitted. The rule
// is now uniform: a material carrying ANY `__vfxSetKey` is admitted only if that
// set can be reproduced on the pool material, and otherwise keeps its own bucket.
//
// Injected, like everything else here, so this module does not pull the vfx
// registry: statics.js owns `fragPlanForDid` / `installVfxComponentPatch` /
// `VFX_GLOBALS` and installs the hook at load.
//
//   tokenFor(mat) -> null            : no VFX set — merge as a plain surface
//                 -> false           : a set that CANNOT be reproduced — reject
//                 -> { token, setKey, entries } : reproducible; `token` joins the key
//   decorate(poolMaterial, token) -> boolean   : install the set; false ⇒ no pool
// ---------------------------------------------------------------------------
let _vfxHook = null;

/** Install the VFX composition hook (statics.js). Absent ⇒ every variant
 *  material is rejected, i.e. exactly the atlas's `ptDeformed` behaviour. */
export function setStatArrayVfxHook(h) {
  _vfxHook = (h && typeof h.tokenFor === "function" && typeof h.decorate === "function") ? h : null;
}
/** Test seam. */
export function __setStatArrayVfxHookForTest(h) { _vfxHook = h || null; }

// poolKey -> pool. GLOBAL, never region-scoped (see the header memory argument).
const _pools = new Map();

const _stats = {
  // Admission, by reason. `admitted` counts material GROUPS offered and taken;
  // every `reject*` is a group that kept its own per-material bucket, so the sum
  // is the honest denominator for "how much of the population merged".
  admitted: 0,
  rejectNoFlag: 0,      // provider installed but flag off (never reached in the app)
  rejectNonStandard: 0, // wireframe MeshBasic and friends — the batcher's own path
  rejectNoMap: 0,
  rejectNoPixels: 0,
  rejectNoWH: 0,
  rejectBc7Pending: 0,  // BC7 verdict in flight — committing now pins the wrong tile
  // A VFX component set the pool material cannot reproduce (no hook installed,
  // no resolvable plan, or a "frag" component whose fragment seam the array
  // material has already consumed). NOT the deformed population — that is
  // admitted; see the VFX hook above.
  rejectVfxUnsafe: 0,
  rejectColorSpace: 0,
  rejectUvTransform: 0,
  rejectMetalness: 0,
  rejectUnreplicated: 0, // a map/flag this pool's ONE material cannot carry
  // Spill: admitted, then the pool could not seat it. Each one is a prop that
  // stays on today's path — never a lost prop.
  spillLayerFull: 0,
  spillWriteFail: 0,
  spillGrowFail: 0,
  // Layer lifecycle (mirrors __atlasStats naming so the two read the same way).
  layerAllocs: 0,
  layerHits: 0,
  layerRecycles: 0,
  layerWriteZeroed: 0,
  poolsCreated: 0,
  poolsDisposed: 0,
  // Pools whose shared material carries a reproduced VFX set (the sway half).
  vfxPools: 0,
  // A pool whose VFX set could not be installed after all. The pool is torn down
  // and the group keeps its own bucket — a sway-less pool must NEVER be shipped,
  // because the members would render frozen with no error anywhere.
  vfxDecorateFailed: 0,
  layerGrows: 0,
  layerGrowUploads: 0,
  layerGrowFails: 0,
  // A member material whose render state changed AFTER its pool material was
  // minted (`_reseatSurfaceState`, materials.js, runs in both directions when a
  // real surface lands after a spawn-race fallback). Today's buckets track that
  // for free because the bucket material IS a member material; a pool material
  // is a fresh object and cannot. Non-zero means some merged prop is rendering
  // with a stale blend/alpha state until its LB re-streams. Detected, counted,
  // NOT silently fixed — see `tickStatArrayPool`.
  stateDrift: 0,
};

// Arrays whose CPU mirror was written this feed; `flushStatArrayPools` sets
// `needsUpdate` once at the end rather than per acquire (the atlas's own
// touchedDiff/touchedNra pattern).
const _touched = new Set();

// ---------------------------------------------------------------------------
// ADMISSION
// ---------------------------------------------------------------------------

/**
 * Properties a pool's ONE shared material cannot carry per member. Each entry
 * would otherwise be flattened across thousands of instances, which is the G10-G13
 * finding of the design study restated as code: those omissions are survivable for
 * the atlas's population (lone props, one per material) and are NOT survivable
 * across a batched one, where flattening a depth bias is z-fighting and flattening
 * sidedness reverses the `?perPolyCull` decision.
 *
 * The ones that can be REPLICATED are in the strict state key instead (side,
 * polygonOffset, emissive, opacity, colour, blend-alpha, filters, shadow flags):
 * a key that carries them costs buckets back but changes no pixel. The ones that
 * cannot be replicated at all are rejected here.
 *
 * `emissiveMap` is the important one and the easy one to miss: luminous surfaces
 * attach their own DIFFUSE texture as `emissiveMap` (materials.js — retail's
 * texture x emissive reading), which is a PER-SURFACE map. One shared material
 * has exactly one emissiveMap slot, so a luminous surface can never merge.
 */
const _UNREPLICATED_MAPS = [
  "emissiveMap", "alphaMap", "lightMap", "bumpMap", "displacementMap",
  "metalnessMap", "envMap", "clearcoatMap", "clearcoatNormalMap",
  "clearcoatRoughnessMap", "specularMap", "iridescenceMap", "sheenColorMap",
];

/**
 * Can this material's surface be admitted to a shared array pool, and under
 * which pool key? Returns a handle, or null (with a reason counted) when the
 * caller must keep today's per-material bucket.
 *
 * `node` supplies `castShadow` / `receiveShadow`, which are per-BUCKET flags in
 * three (not material properties) and therefore belong in the key: flattening
 * them changes the depth-only shadow pass, which ignores opacity entirely.
 * Note `receiveShadow` is decided PER PLACEMENT by the distance tier
 * (`staticsReceiveShadowForPlacement`), so today's (region, material) buckets
 * already flatten it across their members from the template node; keying on it
 * makes the merge no worse than the status quo and no better.
 */
export function admitToArrayPool(mat, node) {
  if (!statArrayMergeEnabled()) { _stats.rejectNoFlag++; return null; }
  try {
    if (!mat || mat.isMeshStandardMaterial !== true) { _stats.rejectNonStandard++; return null; }
    const tex = mat.map;
    if (!tex) { _stats.rejectNoMap++; return null; }
    // A surface whose BC7 verdict is still IN FLIGHT must not be committed: a
    // pool's format AND dimensions are fixed by texStorage3D at allocation, so
    // committing a quarter-res PRE record pins that surface at quarter
    // resolution until its LB re-streams (the 2026-08-05 P1 hole). Same gate,
    // same predicate object, as the atlas — imported, not transcribed.
    if (bc7AtlasShouldDefer(mat)) { _stats.rejectBc7Pending++; return null; }
    // A VFX variant material (windSwayGpu and friends). The pool material
    // REPLACES the member's material wholesale, so the set has to be reproduced
    // on it — or the member keeps its own bucket. Never merged silently: a
    // dropped set is a frozen tree or a missing glint with no error anywhere.
    // See the VFX hook block above for why vertex sets compose and frag sets do
    // not, and why the set token joins the pool key.
    let vfx = null;
    if (typeof mat.userData?.__vfxSetKey === "string" && mat.userData.__vfxSetKey !== "") {
      vfx = _vfxHook ? _vfxHook.tokenFor(mat) : false;
      if (!vfx) { _stats.rejectVfxUnsafe++; return null; }
    }
    const bc7 = isBc7AtlasTexture(tex);
    const img = tex.image;
    const w = (img && img.width) | 0;
    const h = (img && img.height) | 0;
    if (!w || !h) { _stats.rejectNoWH++; return null; }
    // Ask whether pixels CAN be supplied, not whether this texture still carries
    // them: an `img.data` test answers no for every released texture (the LRU
    // frees CPU copies while the texture survives) and would route the whole
    // population back to per-material buckets.
    const did = mat.userData?.surfaceDid >>> 0;
    if (!bc7 && !(img && img.data) && !canSupplyPlanes(mat, did)) { _stats.rejectNoPixels++; return null; }
    // The arrays decode sRGB in hardware; a linear map would be double-decoded.
    if (!bc7 && tex.colorSpace !== THREE.SRGBColorSpace) { _stats.rejectColorSpace++; return null; }
    // The injected sampler addresses `vMapUv` directly (raw, or fract() for a
    // wrap pool). three's map transform is a per-MATERIAL uniform, so a member
    // with a non-identity offset/repeat/rotation would sample through the pool
    // material's transform, not its own.
    if ((tex.offset && (tex.offset.x !== 0 || tex.offset.y !== 0)) ||
        (tex.repeat && (tex.repeat.x !== 1 || tex.repeat.y !== 1)) ||
        (tex.rotation || 0) !== 0) { _stats.rejectUvTransform++; return null; }
    // The array material fixes metalness 0 (there is no free nra channel for it,
    // and every atlas bucket has always rendered metalness 0). A member that
    // actually uses it keeps its own bucket rather than losing it silently.
    if (Math.abs(mat.metalness || 0) > 0.01) { _stats.rejectMetalness++; return null; }
    for (const k of _UNREPLICATED_MAPS) {
      if (mat[k]) { _stats.rejectUnreplicated++; return null; }
    }
    if (mat.vertexColors || mat.flatShading || mat.wireframe || mat.alphaHash ||
        mat.alphaToCoverage || mat.premultipliedAlpha || mat.dithering ||
        mat.depthTest !== true || mat.colorWrite !== true || mat.stencilWrite === true ||
        mat.fog !== true || mat.toneMapped !== true ||
        (mat.clippingPlanes && mat.clippingPlanes.length > 0)) {
      _stats.rejectUnreplicated++; return null;
    }
    // The shader bakes the SHARED aoMapIntensity into its <aomap_fragment>
    // replacement as a LITERAL (`makeArrayMaterial`), so a member carrying a
    // different one would shade differently.
    //
    // ⚠ Only when the member actually HAS an aoMap. Three's default is 1.0 and
    // materials.js only writes `aoMapIntensityValue()` (0.6) alongside a texchan
    // aoMap — testing the intensity unconditionally would reject every surface
    // without cavity AO, i.e. most of the population, and the flag would look
    // inert rather than broken. (The atlas ignores this axis entirely; this is
    // the stricter of the two and still admits the same population.)
    if (mat.aoMap && Math.abs((mat.aoMapIntensity ?? 1) - aoMapIntensityValue()) > 1e-4) {
      _stats.rejectUnreplicated++; return null;
    }
    // The VFX set + its config join the key. This is what makes membership and
    // material one decision: a bucket cannot hold a member whose variant its
    // material does not carry, because they are the same key.
    const stateStrict = _strictStateKeyOf(mat, node) + (vfx ? `|x${vfx.token}` : "|x-");
    // Otherwise the SAME key function the read-only projection uses for its
    // `regionStrict` row, so the live collapse this ships can be compared
    // against the number that justified it without a transcription in between.
    const poolKey = _bucketKeyFor(w, h, stateStrict, bc7);
    _stats.admitted++;
    return { poolKey, w, h, bc7, stateStrict, mat, node, vfx };
  } catch (_) {
    _stats.rejectUnreplicated++;
    return null; // fail-soft: an unexpected material shape keeps its own bucket
  }
}

/**
 * `_stateKeyOf` (transparent | alphaTest | depthWrite | blending | wrap) plus
 * every OTHER image-visible property the pool material replicates. Fields 0..4
 * are left in place because `makeArrayMaterial` reads `split("|")[4]` for the
 * wrap variant and `_applyStateKey` reads 0..3 — the suffix is invisible to both.
 */
function _strictStateKeyOf(mat, node) {
  const off = mat.polygonOffset
    ? `p${mat.polygonOffsetFactor}.${mat.polygonOffsetUnits}`
    : "p-";
  const emi = mat.emissive
    ? `e${(mat.emissive.getHex() >>> 0).toString(16)}.${Number(mat.emissiveIntensity ?? 1).toFixed(3)}`
    : "e-";
  const col = mat.color ? `k${(mat.color.getHex() >>> 0).toString(16)}` : "k-";
  const op = `o${Number(mat.opacity ?? 1).toFixed(4)}`;
  // Only meaningful under CustomBlending, but free to always carry: the alpha
  // triplet is absent from `_stateKeyOf`, and the ClipMap render state sets it.
  const ba = `a${mat.blendSrcAlpha ?? "-"}.${mat.blendDstAlpha ?? "-"}.${mat.blendEquationAlpha ?? "-"}`;
  // The pool's arrays get ONE filter/aniso setting; members that disagree would
  // be resampled differently from how they render today.
  const flt = `t${mat.map?.magFilter ?? "-"}.${mat.map?.minFilter ?? "-"}.${mat.map?.anisotropy ?? 1}`;
  const sh = `sh${node?.castShadow ? 1 : 0}${node?.receiveShadow ? 1 : 0}`;
  return `${_stateKeyOf(mat)}|s${mat.side}|${op}|${col}|${emi}|${off}|${ba}|${flt}|${sh}`;
}

// ---------------------------------------------------------------------------
// POOLS
// ---------------------------------------------------------------------------

function _createPool(handle) {
  const { poolKey, w, h, bc7, stateStrict, mat, vfx } = handle;
  const capacity = _layerCapacityFor(w, h, bc7);
  // X7 semantics, unchanged: `capacity` is a CEILING, `alloc` is what is
  // allocated now. Disarmed (`?statAtlasGrow=off`) the two are equal and
  // `_growPoolLayers` is unreachable.
  const alloc = statAtlasGrowEnabled() ? _atlasStartLayersFor(w, h, bc7, capacity) : capacity;
  const diffArray = bc7 ? makeBc7ArrayTexture(w, h, alloc) : buildDiffuseArray([], w, h, alloc);
  const nraArray = statNraEnabled() ? buildNraArray(w, h, alloc) : null;
  // The strict key carries the member's sampler filtering, so REPLICATE it
  // rather than merely fragmenting on it: a surface authored at anisotropy 16
  // must not go blurry because it moved into a shared array. Diffuse only — the
  // nra array is vector/scalar data whose Linear/LinearMipmapLinear pair is a
  // deliberate choice, not an inherited one. (The atlas does not do this; its
  // members are lone props where the difference is a single surface.)
  try {
    const src = mat.map;
    if (src) {
      if (src.magFilter != null) diffArray.magFilter = src.magFilter;
      if (src.minFilter != null) diffArray.minFilter = src.minFilter;
      if (src.anisotropy > 1) diffArray.anisotropy = src.anisotropy;
    }
  } catch (_) { /* keep the array's defaults */ }
  const arrays = { diff: diffArray, nra: nraArray };
  const material = makeArrayMaterial(diffArray, stateStrict, nraArray, arrays);
  _applyReplicatedState(material, mat);
  material.name = `stat-array-pool-${poolKey}`;
  material.userData.__statArrayPool = true;
  if (vfx) {
    // Capture the array variant's own program key BEFORE decorating: chaining a
    // VFX patch goes through `_chainBeforeCompile`, which OVERWRITES
    // `customProgramCacheKey` with materials.js's `_patchSetCacheKey`. Left
    // alone, the wrap and clamp array variants (which differ only in the
    // injected `fract()`) would collapse onto ONE compiled program — three's
    // cache is keyed renderer-wide and links from whichever material compiled
    // first, which is the exact shape of the 2026-07-28 `__staticBiased` /
    // `__acBakedLight` regression that key exists to prevent.
    const arrayKey = material.customProgramCacheKey();
    const ok = _vfxHook && _vfxHook.decorate(material, vfx);
    if (!ok) {
      // A sway-less pool must never ship: its members would render frozen with
      // nothing logged. Tear the half-built pool down; the group keeps its own
      // per-material bucket.
      _stats.vfxDecorateFailed++;
      try { diffArray?.dispose?.(); } catch (_) {}
      try { nraArray?.dispose?.(); } catch (_) {}
      try { material?.dispose?.(); } catch (_) {}
      return null;
    }
    // Re-compose: array variant token + the VFX set. Nothing else is installed
    // on this material (it is minted here, not a MaterialCache clone), so these
    // two are the complete set of program discriminators.
    material.customProgramCacheKey = () => `${arrayKey}|v${material.userData.__vfxSetKey || ""}`;
    _stats.vfxPools++;
  }
  // Deliberately NOT copied: `__baseTranslucency`. `?skipDeadBatch` hides a
  // bucket whose material is PROVABLY invisible forever, and that proof is
  // per-SURFACE (a Transparent hook floors its ramp to the authored base). Two
  // surfaces that are both at opacity 0 right now — which is all the pool key
  // guarantees — can have different base translucencies, so copying the template's
  // value could hide a bucket that later becomes visible. Without the stamp the
  // predicate returns false and merged buckets are simply never hidden: 4 draws
  // and 27 triangles not saved (measured), which is below this workload's noise
  // floor and the correct side to err on.
  const pool = {
    key: poolKey, w, h, bc7, stateStrict,
    diffArray, nraArray, arrays, material,
    capacity,
    allocLayers: alloc,
    nextLayer: 0,
    layerOf: new Map(),  // texUuid -> { layer, refs, matRef }
    freeLayers: [],      // recycled indices (fully rewritten before reuse)
    buckets: new Set(),  // region BatchedMeshes indexing into this pool
  };
  _pools.set(poolKey, pool);
  _stats.poolsCreated++;
  return pool;
}

/**
 * Replay onto the pool material everything the strict key promised its members
 * share. `makeArrayMaterial` -> `_applyStateKey` has already done fields 0..3
 * (transparent / alphaTest / depthWrite / blending); this is the rest.
 *
 * `side` is the one with a program consequence: three derives `doubleSided` /
 * `flipSided` from it into the program parameters AND the program cache key
 * (three.module.js:7739-7740, :7939-7941), and `customProgramCacheKey` is
 * APPENDED to that key (:7802) rather than replacing it — so distinct sidedness
 * still links distinct programs and cannot collapse.
 */
function _applyReplicatedState(m, src) {
  m.side = src.side;
  m.opacity = Number(src.opacity ?? 1);
  if (src.color && m.color) m.color.copy(src.color);
  if (src.emissive && m.emissive) m.emissive.copy(src.emissive);
  m.emissiveIntensity = Number(src.emissiveIntensity ?? 1);
  m.polygonOffset = !!src.polygonOffset;
  m.polygonOffsetFactor = src.polygonOffsetFactor || 0;
  m.polygonOffsetUnits = src.polygonOffsetUnits || 0;
  if (src.blending === THREE.CustomBlending) {
    if (src.blendSrcAlpha != null) m.blendSrcAlpha = src.blendSrcAlpha;
    if (src.blendDstAlpha != null) m.blendDstAlpha = src.blendDstAlpha;
    if (src.blendEquationAlpha != null) m.blendEquationAlpha = src.blendEquationAlpha;
  }
  return m;
}

/**
 * Grow a pool's layer arrays to hold at least `needed`, by doubling and clamping
 * to `capacity`. Returns true when there is room; false leaves the pool EXACTLY
 * as it was so the caller falls through to the fail-soft spill.
 *
 * Semantics copied from `static_atlas.js _growBucketLayers` (which cannot be
 * reused: it reads/writes a BatchedMesh's userData and a pool has no
 * BatchedMesh). Two clauses are load-bearing and are the reason this is a copy
 * rather than a paraphrase:
 *   1. the `addLayerUpdate` re-mark of every already-handed-out index — three
 *      uploads ONLY `layerUpdates` on a fresh array, so an unmarked carried-over
 *      layer is GPU garbage;
 *   2. the all-or-nothing failure: a refused allocation must not half-apply, or
 *      growing is worse than not having grown.
 * Unlike the atlas's version this re-points ONE shared material instead of one
 * per bucket, so growth amortises across every region bucket of the class.
 */
function _growPoolLayers(pool, needed) {
  const target = _atlasGrowTargetFor(pool.allocLayers, needed, pool.capacity);
  if (target <= pool.allocLayers) return false; // at the ceiling
  const { w, h } = pool;
  const rgbaStride = (w | 0) * (h | 0) * 4;
  let newDiff = null;
  let newNra = null;
  try {
    if (pool.bc7) {
      const blockStride = bc7LevelBytes(w, h);
      newDiff = makeBc7ArrayTexture(w, h, target);
      newDiff.mipmaps[0].data.set(
        pool.diffArray.mipmaps[0].data.subarray(0, pool.allocLayers * blockStride), 0);
    } else {
      newDiff = buildDiffuseArray([], w, h, target);
      newDiff.image.data.set(
        pool.diffArray.image.data.subarray(0, pool.allocLayers * rgbaStride), 0);
    }
    if (pool.nraArray) {
      newNra = buildNraArray(w, h, target);
      newNra.image.data.set(
        pool.nraArray.image.data.subarray(0, pool.allocLayers * rgbaStride), 0);
    }
  } catch (_) {
    try { newDiff && newDiff.dispose && newDiff.dispose(); } catch (_2) {}
    try { newNra && newNra.dispose && newNra.dispose(); } catch (_2) {}
    _stats.layerGrowFails++;
    return false;
  }
  // Carry the sampler state forward. `buildDiffuseArray`/`makeBc7ArrayTexture`
  // hand back their DEFAULTS, so a pool that replicated a member's filtering at
  // creation would silently lose it on the first growth — a prop going blurry at
  // the exact moment the pool got busier, which is a horrible thing to debug.
  newDiff.magFilter = pool.diffArray.magFilter;
  newDiff.minFilter = pool.diffArray.minFilter;
  newDiff.anisotropy = pool.diffArray.anisotropy;
  for (let i = 0; i < pool.nextLayer; i++) {
    if (typeof newDiff.addLayerUpdate === "function") newDiff.addLayerUpdate(i);
    if (newNra && typeof newNra.addLayerUpdate === "function") newNra.addLayerUpdate(i);
  }
  const oldDiff = pool.diffArray;
  const oldNra = pool.nraArray;
  pool.diffArray = newDiff;
  pool.nraArray = newNra;
  pool.allocLayers = target;
  // Holder first (what a RECOMPILE reads — a light-count change is enough to
  // re-run onBeforeCompile), then the live uniform objects (what the CURRENT
  // program samples). Both seams, in that order, exactly as X7 established.
  pool.arrays.diff = newDiff;
  pool.arrays.nra = newNra;
  newDiff.needsUpdate = true;
  if (newNra) newNra.needsUpdate = true;
  const u = pool.material?.userData?._statArrayUniforms;
  if (u) {
    if (u.uDiffuseArray) u.uDiffuseArray.value = newDiff;
    if (u.uNraArray) u.uNraArray.value = newNra;
  }
  try { oldDiff && oldDiff.dispose && oldDiff.dispose(); } catch (_) {}
  try { oldNra && oldNra.dispose && oldNra.dispose(); } catch (_) {}
  _stats.layerGrows++;
  _stats.layerGrowUploads += pool.nextLayer;
  return true;
}

/**
 * Take a refcounted layer for `handle`'s surface, creating the pool on first
 * use. Returns a REF the caller must hand to `releaseArrayPoolLayer` exactly
 * once, or null (spill counted) when the layer could not be seated — in which
 * case the caller keeps today's per-material bucket and nothing is lost.
 *
 * ONE ACQUIRE = ONE RELEASE. The ref is the unit the eviction path balances
 * against the geometry refcount; see `static_batch_x.js`'s membership records.
 */
export function acquireArrayPoolLayer(handle) {
  if (!handle) return null;
  let pool = _pools.get(handle.poolKey);
  try {
    if (!pool) pool = _createPool(handle);
  } catch (_) {
    pool = null;
  }
  if (!pool) {
    // Array allocation refused, or the VFX set could not be reproduced. Either
    // way: today's per-material bucket, fail-soft.
    _stats.spillGrowFail++;
    return null;
  }
  const mat = handle.mat;
  const tex = mat.map;
  const uuid = tex.uuid;
  const entry = pool.layerOf.get(uuid);
  if (entry) {
    entry.refs += 1;
    _stats.layerHits++;
    return { pool, layer: entry.layer, texUuid: uuid, material: pool.material };
  }
  let layer;
  if (pool.freeLayers.length > 0) { layer = pool.freeLayers.pop(); _stats.layerRecycles++; }
  else if (pool.nextLayer < pool.allocLayers) layer = pool.nextLayer++;
  else if (pool.nextLayer < pool.capacity && _growPoolLayers(pool, pool.nextLayer + 1)) layer = pool.nextLayer++;
  else { _stats.spillLayerFull++; return null; }
  // LAYER-WRITE INVARIANT: a layer index is RECYCLED, so a skipped or failed
  // write leaves the PREVIOUS surface's texels resident and the prop renders
  // someone else's texture. Every allocation below either rewrites the layer in
  // full or releases it.
  const { w, h } = pool;
  if (pool.bc7) {
    const ok = writeBc7ArrayLayer(pool.diffArray, layer, {
      width: w, height: h,
      levels: [{ data: tex.mipmaps[0].data, width: w, height: h }],
    });
    if (!ok) {
      // A compressed layer cannot be cleared in place — release it.
      pool.freeLayers.push(layer);
      _stats.spillWriteFail++;
      return null;
    }
  } else {
    const stride = w * h * 4;
    let src = tex.image && tex.image.data;
    if (!src) {
      const p = planeFor(mat, PLANE.ALBEDO, mat?.userData?.surfaceDid >>> 0);
      if (p) src = p.data;
    }
    if (src && src.length === stride) {
      pool.diffArray.image.data.set(src, layer * stride);
    } else {
      pool.diffArray.image.data.fill(0, layer * stride, (layer + 1) * stride);
      _stats.layerWriteZeroed++;
    }
    if (typeof pool.diffArray.addLayerUpdate === "function") pool.diffArray.addLayerUpdate(layer);
  }
  _touched.add(pool.diffArray);
  if (pool.nraArray) {
    packNraLayer(pool.nraArray, layer, mat, w, h, null);
    if (typeof pool.nraArray.addLayerUpdate === "function") pool.nraArray.addLayerUpdate(layer);
    _touched.add(pool.nraArray);
  }
  // WeakRef, not a strong one: the drift check below must never keep a
  // MaterialCache material alive past its LB's eviction. Absent WeakRef (old
  // runtimes) the check simply does not run.
  const matRef = typeof WeakRef === "function" ? new WeakRef(mat) : null;
  pool.layerOf.set(uuid, { layer, refs: 1, matRef });
  _stats.layerAllocs++;
  return { pool, layer, texUuid: uuid, material: pool.material };
}

/**
 * Release one layer reference. At the last reference the index goes back on the
 * free list and the surface is forgotten.
 *
 * THE ORDERING THAT MATTERS: the caller releases this at the SAME moment it
 * releases the geometry reference the layer index is baked into (`aLayer` is a
 * per-vertex attribute copied into the BatchedMesh's buffer). Because every
 * membership record holds exactly one of each, a layer can never be recycled to
 * a different surface while a geometry still addresses it — which is the whole
 * failure mode ("props render with another surface's pixels") this design has
 * to rule out. See the eviction path in static_batch_x.js.
 */
export function releaseArrayPoolLayer(ref) {
  if (!ref || !ref.pool) return;
  const pool = ref.pool;
  const entry = pool.layerOf.get(ref.texUuid);
  if (!entry) return;
  if (--entry.refs <= 0) {
    pool.freeLayers.push(entry.layer);
    pool.layerOf.delete(ref.texUuid);
    _maybeDisposePool(pool);
  }
}

/** Register a region BatchedMesh as a user of this pool. */
export function attachArrayPoolBucket(pool, bm) {
  if (pool && pool.buckets) pool.buckets.add(bm);
}

/** Unregister a reaped region BatchedMesh; disposes the pool if it was the last. */
export function detachArrayPoolBucket(pool, bm) {
  if (!pool || !pool.buckets) return;
  pool.buckets.delete(bm);
  _maybeDisposePool(pool);
}

/**
 * A pool with no live layers AND no region bucket is dead weight — two array
 * textures plus a compiled program for nothing. This is the sibling of
 * `static_batch_x.js _reapBucketIfEmpty`, and it exists for the same reason that
 * one does: the 2026-08-03 leak was a bucket population that only ever grew.
 * Both conditions are required — a pool can transiently hold layers with no
 * bucket (between acquire and bucket creation) and buckets with no layers
 * (between the last release and the reap).
 */
function _maybeDisposePool(pool) {
  if (pool.layerOf.size > 0 || pool.buckets.size > 0) return;
  _pools.delete(pool.key);
  try { pool.diffArray?.dispose?.(); } catch (_) {}
  try { pool.nraArray?.dispose?.(); } catch (_) {}
  try { pool.material?.dispose?.(); } catch (_) {}
  _stats.poolsDisposed++;
}

/**
 * One `needsUpdate` per touched array per feed rather than per acquired layer.
 * `addLayerUpdate` has already marked the individual layers, so this uploads the
 * touched layers only — not the whole (up to 128-layer) array.
 */
export function flushStatArrayPools() {
  for (const t of _touched) t.needsUpdate = true;
  _touched.clear();
}

/**
 * ~10 Hz drift detector, driven off the PVS tick beside the batcher's compactor.
 *
 * A pool material is minted ONCE from the strict state key. `_reseatSurfaceState`
 * (materials.js, 2026-08-03) rewrites `transparent`/`opacity`/`depthWrite`/
 * `blending` on a live material — in BOTH directions — when a real surface lands
 * after a spawn-race fallback. Today's buckets track that for free because the
 * bucket material IS a member material; a pool material cannot, so a reseated
 * member renders with its pool's ORIGINAL state until its LB re-streams.
 *
 * This is a KNOWN, BOUNDED limitation of the merge, and the honest thing to do
 * with it is measure it rather than assert it does not happen: re-deriving the
 * strict key would need the node's shadow flags (not retained) and re-pooling a
 * live surface mid-session is a far larger change than the drift it would fix.
 * `stateDrift > 0` in the stats is the signal to take this seriously; it is
 * expected to be 0.
 */
export function tickStatArrayPool() {
  if (_pools.size === 0) return;
  for (const pool of _pools.values()) {
    const want = String(pool.stateStrict).split("|").slice(0, 5).join("|");
    for (const entry of pool.layerOf.values()) {
      const m = entry.matRef && entry.matRef.deref ? entry.matRef.deref() : null;
      if (!m) continue;
      let now;
      try { now = _stateKeyOf(m); } catch (_) { continue; }
      if (now !== want) { _stats.stateDrift++; entry.matRef = null; /* count once */ }
    }
  }
}

/** Read-only census. `layerBytes` is the GLOBAL pool cost — the §2b number. */
export function getStatArrayPoolStats() {
  let layers = 0, allocLayers = 0, layerBytes = 0, allocBytes = 0, buckets = 0;
  const pools = [];
  for (const p of _pools.values()) {
    const per = _perLayerBytesFor(p.w, p.h, p.bc7);
    layers += p.layerOf.size;
    allocLayers += p.allocLayers;
    layerBytes += p.layerOf.size * per;
    allocBytes += p.allocLayers * per;
    buckets += p.buckets.size;
    pools.push({
      key: p.key, w: p.w, h: p.h, bc7: p.bc7,
      layersUsed: p.layerOf.size, alloc: p.allocLayers, capacity: p.capacity,
      free: p.freeLayers.length, buckets: p.buckets.size,
      perLayerKiB: Math.round(per / 1024),
    });
  }
  pools.sort((a, b) => b.layersUsed - a.layersUsed);
  const mb = (b) => +(b / (1024 * 1024)).toFixed(1);
  return {
    enabled: statArrayMergeEnabled(),
    pools: _pools.size,
    bucketsAttached: buckets,
    layers,
    allocLayers,
    // What the GLOBAL pools actually cost. The design's load-bearing memory
    // claim is that this stays near the atlas's 142.2 MB rather than the
    // 1,440.2 MB a region-scoped array would cost (10.1x).
    layerMB: mb(layerBytes),
    allocMB: mb(allocBytes),
    ..._stats,
    detail: pools,
  };
}

if (typeof window !== "undefined") {
  window.__statArrayPoolStats = () => { try { return getStatArrayPoolStats(); } catch (_) { return null; } };
}

/** Test seam: drop every pool and zero the tally. */
export function _resetStatArrayPoolForTest() {
  for (const p of _pools.values()) {
    try { p.diffArray?.dispose?.(); } catch (_) {}
    try { p.nraArray?.dispose?.(); } catch (_) {}
    try { p.material?.dispose?.(); } catch (_) {}
  }
  _pools.clear();
  _touched.clear();
  for (const k of Object.keys(_stats)) _stats[k] = 0;
}

/** Test seam: the live pool map (poolKey -> pool). */
export function _statArrayPoolsForTest() { return _pools; }

/**
 * The provider object `static_batch_x.js` is handed at module load (statics.js
 * installs it, exactly as it installs `setDeadBatchPredicate`). The batcher is a
 * deliberate THREE-only leaf — its headless test loads it by stripping the
 * import lines outright — so it must never import this module; the whole array
 * surface reaches it through this one injected object.
 */
export const STAT_ARRAY_MERGE_PROVIDER = {
  setVfxHook: setStatArrayVfxHook,
  admit: admitToArrayPool,
  acquire: acquireArrayPoolLayer,
  release: releaseArrayPoolLayer,
  attachBucket: attachArrayPoolBucket,
  detachBucket: detachArrayPoolBucket,
  flush: flushStatArrayPools,
  tick: tickStatArrayPool,
  stats: getStatArrayPoolStats,
};
