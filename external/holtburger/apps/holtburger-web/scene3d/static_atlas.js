// scene3d/static_atlas.js — texture-array batching for unique-material static singletons.
//
// PROBLEM (2026-06-27, measured on a real GTX 1070 at Holtburg): after the
// foliage-instancing fix the scene is still CPU/draw-call bound — ~5,400 static
// SINGLETON meshes, each its own draw call, because they carry UNIQUE materials
// (different surface textures) and so cannot be collapsed by the material-keyed
// `consolidateStaticSingletons` (which only batches >=2 nodes sharing one material).
//
// FEASIBILITY SPIKE (same session): those ~5,400 singletons reference only ~353
// unique textures, ALL RGBA8 DataTextures (image.data accessible), ALL
// ClampToEdge, sRGB, MeshStandardMaterial/DoubleSide, across ~20 power-of-2 SIZE
// buckets. That is ideal for a sampler2DArray: bucket by texture size, pack each
// bucket's textures as layers of a DataArrayTexture, tag every vertex with its
// layer, and merge the bucket's geometry into ONE mesh sampling the array by
// layer. ~5,400 unique-material draws collapse to a few dozen.
//
// v1 scope: ALBEDO-ONLY (the source materials also carry a normalMap; v1 drops it
// for the atlased path -> slightly flatter shading, an eye-test trade). Gated
// DEFAULT-OFF behind `?statAtlas=on` so master is untouched until the 1070 A/B
// eye-test signs off. The frag-VFX suite still applies to non-atlased nodes.
//
// X5 (2026-07-28, `?statNra=on`, DEFAULT-OFF) — v2 lifts the albedo-only trade:
// a PARALLEL "nra" DataArrayTexture per bucket, sharing the ONE existing UV
// layout + layer index, mirroring the terrain T2 pack (adapter.js
// `buildPbrNraTexture`):  R,G = tangent-normal XY (Z reconstructed in-shader),
// B = roughness, A = ambient occlusion. Sources are exactly what the SINGLETON
// path already carries — nothing is invented here:
//   R,G  <- `material.normalMap` (adapter `surfacePixelsToNormalTexture`, the
//           wasm Sobel-from-luminance normal), with the member's `normalScale`
//           BAKED IN at pack time (three does `mapN.xy *= normalScale` before
//           normalize; baking it per layer avoids a per-layer uniform array and
//           keeps `customProgramCacheKey` per-BUCKET, never per-instance).
//   B    <- `material.roughness` * `material.roughnessMap.g` (Phase-5 texchan
//           bake) — the bucket material's own `roughness` stays 1.0 so the
//           multiply reproduces the member's value exactly.
//   A    <- `material.aoMap.r` (Phase-5 texchan cavity AO), applied with the
//           singleton path's 0.6 `aoMapIntensity`.
// Layers with no source read the flat texel (128,128,255,255) = flat normal,
// roughness 1.0, no occlusion — i.e. byte-identical shading to albedo-only v1.
// NOT carried: per-member `metalness` (no free channel; every atlas bucket has
// always rendered metalness 0).
// S3 (2026-07-30): the A channel now PREFERS the per-surface seam-height field
// over the texchan AO (see packNraLayer + the statPom block below) — height
// and POM ARE carried now, at zero additional bytes.
//
// LRU-safe: bucketed PER landblock; each merged mesh carries userData.landblockId,
// so the existing per-LB eviction (which scans staticsGroup.children by
// landblockId) tears it down identically to the singletons it replaces.

// X7 (2026-08-06, `?statAtlasGrow`, DEFAULT-ON) — GROW-ON-DEMAND layer depth.
// Every bucket used to allocate its FULL `_layerCapacityFor` depth at creation
// and never revisit it. Measured live on a 1070 after a four-town route
// (docs/RESULTS-atlas-occupancy-2026-08-05.json, and §11 of
// docs/2026-08-05-1070-black-flicker-and-renderer-oom-handoff.md):
//
//     29 buckets   1,941 layers ALLOCATED   112 layers USED
//                  551.1 MB allocated       123 MB occupied
//
// i.e. 428 MB of nra layers nothing had ever written to — the single largest
// item in a 2,445 MB heap on a page whose renderer OOM-crashes at ~2,800 MB.
// The `_ATLAS_NRA_MAX_LAYERS` comment below predicted the working set correctly
// ("28-47 layers across all buckets") and drew the wrong conclusion: that is
// true of the CEILING and false of the ALLOCATION underneath it.
//
// So `capacity` is now ONLY a ceiling. A bucket allocates `allocLayers` (a
// handful, byte-capped for big tiles) and doubles — CLAMPED TO `capacity`, so
// the allocation can never exceed what the pre-X7 code allocated on day one —
// when the layer allocator runs out. Growth means a NEW array plus a re-upload
// of the live layers, because `texStorage3D` fixes the depth at allocation.
// Three moving parts make that safe:
//   1. the material's array uniforms are re-pointed at the new arrays
//      (`_rebindArrayUniforms`), AND `makeArrayMaterial`'s `onBeforeCompile`
//      closure now reads a mutable HOLDER rather than capturing the array
//      object, so a three RECOMPILE (light-count change ⇒ new program cache
//      key ⇒ onBeforeCompile re-runs) rebuilds the uniforms against the
//      CURRENT arrays instead of resurrecting the disposed one;
//   2. every already-allocated layer is re-marked with `addLayerUpdate` on the
//      new array. This is REQUIRED, not an optimisation: three's first upload
//      of an array texture does `texStorage3D` (contents undefined) and then,
//      if `layerUpdates` is non-empty, uploads ONLY those layers
//      (three.module.js:12160-12195 DataArray, :12026-12070 CompressedArray).
//      Copying the CPU bytes without re-marking would leave every carried-over
//      layer as GPU garbage. Re-marking is also CHEAPER than a full-depth
//      upload — it sends the live prefix, not the padding;
//   3. BC7 buckets grow too, with no bc7_textures.js change: a
//      `CompressedArrayTexture` keeps its whole payload in `mipmaps[0].data`
//      (`makeBc7ArrayTexture` allocates it, `writeBc7ArrayLayer` writes into
//      it), so the carried-over blocks are copied from the array's own CPU
//      mirror — no per-layer source retention, nothing re-fetched.
// Overflow past `capacity` still falls back to an unbatched singleton
// (`ptLayerFull`), exactly as before. `?statAtlasGrow=off` allocates at
// `capacity` again and can never enter the growth path — byte-identical.
//
// X6 (2026-07-29, `?texBc7=on`, DEFAULT-OFF) — BC7 buckets. A member whose
// `material.map` is already a BC7 `CompressedTexture` (the direct-upload path in
// bc7_textures.js) is batched into a `CompressedArrayTexture` bucket instead of a
// `DataArrayTexture` one: same fixed (w, h), same fixed capacity, same refcounted
// layer index, same `aLayer` attribute, same shader — only the array object and
// the per-layer write differ. The bucket KEY gains a format field because a
// compressed array's format is fixed at allocation and cannot be mixed with
// RGBA8 layers. See BC7-CLIENT-REPORT.md for the compatibility analysis.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  bc7Available,
  bc7PendingOn,
  bc7LevelBytes,
  makeBc7ArrayTexture,
  writeBc7ArrayLayer,
  _bumpBc7Stat,
} from "./bc7_textures.js";
import { aoMapIntensityValue } from "./vfx_flags.js";
import { getQuality } from "./quality.js";
// 2026-08-03 — the seam-height plane moved out of `material.userData` (three's
// Material.copy JSON round-trips userData); read it through the accessor.
import { heightTexForMaterial } from "./materials.js";
// 2026-08-05 (task 2) — pixel source of last resort for atlas staging, so a
// texture's CPU copy stops being the only place a surface's pixels live.
import { PLANE, planeFor, canSupplyPlanes } from "./surface_planes.js";

let _flag;
/** `?statAtlas=off` escapes the cross-LB texture-array batching of unique-material
 *  STATIC LIT singletons. DEFAULT-ON (2026-06-28). NOTE: the atlas only ever captures
 *  genuinely static lit singletons (`buildSingletonNode` output). Animated scenery
 *  (`isAnimatedScenery` Groups) and additive particle billboards (`particle-unlit-*`)
 *  are a DIFFERENT subsystem and are correctly never fed here — they must keep their
 *  per-frame animation/orientation/blend. See docs/2026-06-28-cross-lb-atlas-feedbug-handoff.md. */
export function statAtlasEnabled() {
  if (_flag !== undefined) return _flag;
  let on = true; // DEFAULT-ON; ?statAtlas=off is the escape hatch (byte-identical legacy path)
  try {
    if (typeof window !== "undefined" && window.location?.search) {
      const v = new URLSearchParams(window.location.search).get("statAtlas");
      if (v != null) { const s = v.toLowerCase(); on = !(s === "off" || s === "0" || s === "false" || s === "no"); }
    }
  } catch (_) { on = true; }
  return (_flag = on);
}

let _nraFlag;
/** X5 — the parallel normal/roughness(/height, since S3) texture array for the
 *  cross-LB statics atlas (see the header). **DEFAULT-ON** since 2026-07-30;
 *  `?statNra=off` is the escape back to the albedo-only v1 path (no second
 *  array allocated, no shader chunk replaced, v1 `customProgramCacheKey`). */
export function statNraEnabled() {
  if (_nraFlag !== undefined) return _nraFlag;
  // DEFAULT-ON since 2026-07-30 (see bc7_textures.js `bc7Enabled` for the
  // measurement). This is also what carries the Phase-5 texchan CAVITY AO to
  // atlased statics: the atlas replaces the member material wholesale, so with
  // the nra array absent every atlased static rendered with no aoMap at all —
  // a regression hiding in a default, not a missing feature.
  let on = true;
  try {
    if (typeof window !== "undefined" && window.location?.search) {
      const v = new URLSearchParams(window.location.search).get("statNra");
      if (v != null) {
        const s = String(v).toLowerCase();
        on = !(s === "off" || s === "0" || s === "false" || s === "no");
      }
    }
  } catch (_) { on = true; }
  return (_nraFlag = on);
}

let _growFlag;
/** X7 — grow the bucket layer arrays on demand instead of allocating the full
 *  `_layerCapacityFor` depth up front (see the header). **DEFAULT-ON**;
 *  `?statAtlasGrow=off` (or `0`/`false`/`no`) allocates at `capacity` at bucket
 *  creation exactly as the pre-2026-08-06 code did, which also makes the growth
 *  path unreachable (`nextLayer < allocLayers` covers the whole range) — a
 *  byte-identical escape, not a re-implementation of it. Absent or misspelled
 *  ⇒ ARMED: a typo must never silently hand back 428 MB. */
export function statAtlasGrowEnabled() {
  if (_growFlag !== undefined) return _growFlag;
  let on = true;
  try {
    if (typeof window !== "undefined" && window.location?.search) {
      const v = new URLSearchParams(window.location.search).get("statAtlasGrow");
      if (v != null) {
        const s = String(v).toLowerCase();
        on = !(s === "off" || s === "0" || s === "false" || s === "no");
      }
    }
  } catch (_) { on = true; }
  return (_growFlag = on);
}

// === S3 (2026-07-30) — atlas POM over the seam-height field ("statPom") =====
// The nra ALPHA channel now carries the per-surface seam height (255 = proud
// face, grooves dip toward 0 — height_seam.rs, the operator that won the
// 10-way comparison), packed from `heightTexForMaterial(mat)` by `packNraLayer`.
// `makeArrayMaterial` marches it per-fragment: a correct POM (derivative
// tangent frame via three's own `getTangentFrame` — NOT the legacy
// view-space fabrication that swam with the camera), a self-shadow ray toward
// the REAL sun (`directionalLights[0]`), and cavity AO derived from the same
// texel applied to indirect AND direct light. Costs 0 extra bytes, 0 extra
// samplers, 0 capacity change: the alpha channel was already allocated.
//
// Resolution is (URL `?statPom=on|off` > quality preset `statPom` > off),
// via quality.js's BOOL_FLAGS override path; step counts ride the preset's
// existing `pomStepsPrimary`/`pomStepsSelfShadow`. Resolved ONCE, at first
// bucket creation, through `getQuality()` (memoized, main-thread only) — NOT
// through `window.liveScene3d`, which is stamped ~35 s after in-world and
// would race every boot-ring bucket. `uStatPomOn` is a UNIFORM, not a define,
// so `window.__statPom({on, depth, ...})` can A/B live without recompiling.
let _statPomCfg;
export function statPomConfig() {
  if (_statPomCfg !== undefined) return _statPomCfg;
  let enabled = false;
  let steps = 8;
  let shadowSteps = 4;
  try {
    const f = getQuality()?.flags || {};
    enabled = f.statPom === true;
    if (Number.isFinite(f.pomStepsPrimary) && f.pomStepsPrimary > 0) steps = f.pomStepsPrimary;
    if (Number.isFinite(f.pomStepsSelfShadow) && f.pomStepsSelfShadow > 0) shadowSteps = f.pomStepsSelfShadow;
  } catch (_) { enabled = false; }
  // UV-space depth scale: 0.07 of a tile ≈ 10-14 cm of apparent depth on the
  // 1-2 m retail wall tiles. Raised from 0.04 with the relief_height pillow
  // field (user: "not pronounced enough" vs the sculpted reference): the
  // field now spends most of its range on rounded per-region volume, so the
  // same knob buys visibly bulging stones rather than deeper hairlines.
  // Genuinely flat surfaces still get ZERO offset (empty field ⇒ no height).
  let depth = 0.07;
  try {
    if (typeof window !== "undefined" && window.location?.search) {
      const v = Number.parseFloat(new URLSearchParams(window.location.search).get("statPomDepth") ?? "");
      if (Number.isFinite(v)) depth = Math.min(0.15, Math.max(0, v));
    }
  } catch (_) { /* keep default */ }
  _statPomCfg = {
    enabled,
    steps: Math.min(24, Math.max(4, steps | 0)),
    shadowSteps: Math.min(12, Math.max(2, shadowSteps | 0)),
    depth,
    near: 5.0,   // full strength below (m)
    far: 14.0,   // fully off beyond (m) — bounds the dependent-fetch loop cost
    shadowDark: 0.55,
  };
  return _statPomCfg;
}

/**
 * Live A/B seam: update the statPom uniforms on every existing bucket material
 * (and the memoized config new buckets will read). `window.__statPom({on:false})`,
 * `window.__statPom({depth:0.08})`, etc. Uniform-only — no shader recompile,
 * no draw-call change, safe mid-frame.
 */
export function setStatPom(opts = {}) {
  const cfg = statPomConfig();
  if (typeof opts.on === "boolean") cfg.enabled = opts.on;
  if (Number.isFinite(opts.depth)) cfg.depth = Math.min(0.15, Math.max(0, opts.depth));
  if (Number.isFinite(opts.steps)) cfg.steps = Math.min(24, Math.max(4, opts.steps | 0));
  if (Number.isFinite(opts.shadowSteps)) cfg.shadowSteps = Math.min(12, Math.max(2, opts.shadowSteps | 0));
  if (Number.isFinite(opts.near)) cfg.near = opts.near;
  if (Number.isFinite(opts.far)) cfg.far = opts.far;
  if (Number.isFinite(opts.shadowDark)) cfg.shadowDark = Math.min(1, Math.max(0, opts.shadowDark));
  let touched = 0;
  for (const b of _buckets.values()) {
    const u = b.bm?.material?.userData?._statPomUniforms;
    if (!u) continue;
    u.uStatPomOn.value = cfg.enabled ? 1 : 0;
    u.uStatPomDepth.value = cfg.depth;
    u.uStatPomSteps.value = cfg.steps;
    u.uStatPomShadowSteps.value = cfg.shadowSteps;
    u.uStatPomNear.value = cfg.near;
    u.uStatPomFar.value = cfg.far;
    u.uStatPomShadowDark.value = cfg.shadowDark;
    touched++;
  }
  return { ...cfg, bucketsTouched: touched };
}
if (typeof window !== "undefined") window.__statPom = setStatPom;

// One shared 1x1 white map forces USE_MAP so three emits the vMapUv plumbing the
// injected array sampler reuses. Never sampled itself.
let _dummyMap = null;
function dummyMap() {
  if (_dummyMap) return _dummyMap;
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
  t.needsUpdate = true;
  _dummyMap = t;
  return t;
}

// Build a sRGB RGBA8 DataArrayTexture from same-size RGBA8 source DataTextures.
// `layerCount` (optional) pre-allocates a fixed capacity larger than the supplied
// textures (the cross-LB path allocates an empty array of `capacity` layers up
// front and writes each layer's pixels on demand). Omitted ⇒ exactly textures.length
// (the original per-(LB,size) path — byte-identical).
function buildDiffuseArray(textures, w, h, layerCount) {
  const layers = layerCount != null ? layerCount : textures.length;
  const data = new Uint8Array(w * h * 4 * layers);
  const stride = w * h * 4;
  for (let i = 0; i < textures.length; i++) {
    const src = textures[i]?.image?.data;
    if (src && src.length === stride) data.set(src, i * stride);
    // missing/mismatched source -> that layer stays black (rare; fail-soft).
  }
  const arr = new THREE.DataArrayTexture(data, w, h, layers);
  arr.format = THREE.RGBAFormat;
  arr.type = THREE.UnsignedByteType;
  arr.colorSpace = THREE.SRGBColorSpace; // GPU sRGB->linear decode on sample
  arr.wrapS = THREE.ClampToEdgeWrapping;
  arr.wrapT = THREE.ClampToEdgeWrapping;
  arr.minFilter = THREE.LinearMipmapLinearFilter;
  arr.magFilter = THREE.LinearFilter;
  arr.generateMipmaps = true;
  arr.needsUpdate = true;
  return arr;
}

// === X5 — the parallel normal/rough/AO ("nra") array =======================
// Same w/h/capacity/layer-index as the bucket's diffuse array, so ONE `aLayer`
// attribute and ONE `vMapUv` address both. Linear (NoColorSpace): vector +
// scalar data, never colour. Layers default to the FLAT texel so an unpacked or
// recycled layer shades exactly like albedo-only v1.
const _NRA_FLAT_N = 128; // 0.5 -> tangent normal (0,0,1) after decode
const _NRA_FLAT_R = 255; // roughness multiplier 1.0 (bucket material roughness = 1.0)
const _NRA_FLAT_A = 255; // AO 1.0 = unoccluded

function buildNraArray(w, h, layerCount) {
  const data = new Uint8Array(w * h * 4 * layerCount);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = _NRA_FLAT_N;
    data[i + 1] = _NRA_FLAT_N;
    data[i + 2] = _NRA_FLAT_R;
    data[i + 3] = _NRA_FLAT_A;
  }
  const arr = new THREE.DataArrayTexture(data, w, h, layerCount);
  arr.format = THREE.RGBAFormat;
  arr.type = THREE.UnsignedByteType;
  arr.colorSpace = THREE.NoColorSpace; // CRITICAL: sRGB would corrupt the vectors
  // Same addressing contract as the diffuse array: ClampToEdge per layer, with
  // the shader's fract() supplying the tiling for wrap buckets.
  arr.wrapS = THREE.ClampToEdgeWrapping;
  arr.wrapT = THREE.ClampToEdgeWrapping;
  arr.minFilter = THREE.LinearMipmapLinearFilter;
  arr.magFilter = THREE.LinearFilter;
  arr.generateMipmaps = true;
  arr.needsUpdate = true;
  return arr;
}

// Nearest-neighbour channel lift. The normalMap always matches the albedo's
// dimensions (both go through adapter.js `downscaleRgba` with the same divisor),
// but the Phase-5 texchan roughness/AO come from a SEPARATE bake whose tile size
// need not match — resample instead of dropping them. Runs once per unique
// surface, never per frame.
function _liftChannel(src, sw, sh, srcStride, ch, dw, dh) {
  const out = new Uint8Array(dw * dh);
  if (sw === dw && sh === dh) {
    for (let i = 0, n = dw * dh; i < n; i++) out[i] = src[i * srcStride + ch];
    return out;
  }
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, ((y * sh) / dh) | 0);
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, ((x * sw) / dw) | 0);
      out[y * dw + x] = src[(sy * sw + sx) * srcStride + ch];
    }
  }
  return out;
}

// Pull one channel out of a THREE texture's CPU-side image, or null.
function _texChannel(tex, ch, w, h, plane, surfaceDid) {
  const img = tex && tex.image;
  // 2026-08-05 (task 2) — the texture's own bytes are the FIRST source, not the
  // only one. This read is why the 1,332 MB of CPU copies cannot simply be
  // released: "uploaded first, atlased later" is routine (LRU evict -> re-enter
  // frees the layer while the texture survives, `landblock_lru.js:1730` skips
  // `__cacheOwned`), so a released plane would silently pack as black. When the
  // copy is gone, `surface_planes.js` re-supplies it from the wasm decode memo;
  // a miss returns null and the caller falls back exactly as it always has for
  // an absent map.
  let data = img && img.data;
  let sw = img && (img.width | 0);
  let sh = img && (img.height | 0);
  if ((!data || !sw || !sh) && plane && surfaceDid) {
    const p = planeFor({ map: tex, normalMap: tex, roughnessMap: tex, aoMap: tex }, plane, surfaceDid);
    if (p) { data = p.data; sw = p.width | 0; sh = p.height | 0; }
  }
  if (!data || !sw || !sh) return null;
  const stride = Math.floor(data.length / (sw * sh));
  if (stride < 1 || ch >= stride) return null;
  return { px: _liftChannel(data, sw, sh, stride, ch, w, h), resampled: sw !== w || sh !== h };
}

/**
 * Pack ONE layer of a bucket's nra array from a member material. Every channel
 * is written (never a partial update) so a RECYCLED layer can never bleed its
 * previous surface's relief. `stats` is the module tally (mutated).
 * Returns true when at least one real source was found.
 */
function packNraLayer(nraArray, layer, mat, w, h, stats) {
  const dst = nraArray?.image?.data;
  if (!dst || !mat) return false;
  const px = w * h;
  const base = layer * px * 4;
  if (base + px * 4 > dst.length) return false;

  // normalScale is BAKED IN here (three's `mapN.xy *= normalScale`), so the
  // bucket material needs no per-layer uniform. Fallback chain matches
  // materials.js: userData.normalScaleEffective -> normalScale.x -> 1.0.
  let scale = Number(mat.userData?.normalScaleEffective);
  if (!Number.isFinite(scale)) scale = Number(mat.normalScale?.x);
  if (!Number.isFinite(scale)) scale = 1.0;

  // `surfaceDid` is stamped by `MaterialCache._installCacheEntry`; it is what the
  // wasm fallback inside `_texChannel` needs to re-ask for a released plane.
  // Roughness and AO deliberately get no plane hint: they are texchan sidecars,
  // absent from the decode memo, so a fallback could only invent zeros — and
  // task 4 correspondingly never releases them.
  const did = mat.userData?.surfaceDid >>> 0;
  const nR = _texChannel(mat.normalMap, 0, w, h, PLANE.NORMAL, did);
  const nG = nR ? _texChannel(mat.normalMap, 1, w, h, PLANE.NORMAL, did) : null;
  const rgh = _texChannel(mat.roughnessMap, 1, w, h); // three reads roughnessMap.g
  const ao = _texChannel(mat.aoMap, 0, w, h);         // three reads aoMap.r (RedFormat)
  // S3 — the seam-height field (materials.js stashes it per material; 255 =
  // proud face, grooves dip). When present it OWNS the alpha channel: the
  // bucket shader both marches it (statPom) and derives cavity AO from it
  // (`ao = 1 - k*(1 - h)` — a groove darkens across its full width, which the
  // 1-texel texchan luminance cavity never did). Surfaces with NO seam field
  // (constant-luminance ⇒ wasm returns empty heightPixels) fall back to the
  // texchan AO exactly as before — under the same shader formula both
  // semantics shade correctly, and a near-flat AO field makes the POM march a
  // no-op, so the fallback can never invent relief.
  const hgt = _texChannel(heightTexForMaterial(mat), 0, w, h, PLANE.HEIGHT, did);

  const roughScalar = Math.min(1, Math.max(0, Number.isFinite(mat.roughness) ? mat.roughness : 1));
  const roughFlat = Math.round(roughScalar * 255);

  for (let i = 0; i < px; i++) {
    const o = base + i * 4;
    if (nR && nG) {
      // decode -> scale -> re-encode (0.5-centred, the NormalGL convention the
      // wasm normal-gen emits and three decodes with `* 2.0 - 1.0`).
      const x = ((nR.px[i] / 255) * 2 - 1) * scale;
      const y = ((nG.px[i] / 255) * 2 - 1) * scale;
      dst[o] = Math.max(0, Math.min(255, Math.round((x * 0.5 + 0.5) * 255)));
      dst[o + 1] = Math.max(0, Math.min(255, Math.round((y * 0.5 + 0.5) * 255)));
    } else {
      dst[o] = _NRA_FLAT_N;
      dst[o + 1] = _NRA_FLAT_N;
    }
    dst[o + 2] = rgh ? Math.round((roughScalar * rgh.px[i]) ) : roughFlat;
    dst[o + 3] = hgt ? hgt.px[i] : (ao ? ao.px[i] : _NRA_FLAT_A);
  }

  if (stats) {
    stats.nraLayersPacked++;
    if (nR && nG) stats.nraWithNormal++;
    if (rgh) stats.nraWithRough++;
    if (ao) stats.nraWithAo++;
    if (hgt) stats.nraWithHeight++;
    if ((nR && nR.resampled) || (rgh && rgh.resampled) || (ao && ao.resampled) || (hgt && hgt.resampled)) stats.nraResampled++;
    if ((mat.metalness || 0) > 0.01) stats.nraMetalDropped++;
  }
  return !!(nR || rgh || ao);
}

// === RND-08/33 (2026-07-27) — buckets must carry the EXACT source render state.
// The bucket key used to collapse the members' alpha-test ref to `>0 ? 0.5 : 0`
// and to ignore blending entirely. That was survivable while every ClipMap
// material was `alphaTest = 0.5, transparent = false`; it is not now that
// ClipMap carries retail's per-format ref (100/255 paletted, 200/255 DDS) plus a
// CustomBlending ONE/INVSRCALPHA state (materials.js `applyClipMapRenderState`,
// acclient.c:454497-454511) — the collapse would silently re-cut every atlased
// foliage prop at 0.5 and drop the blend. `_stateKeyOf` therefore encodes the
// ref verbatim and the blend factors, and `_applyStateKey` replays them onto the
// bucket material. `alphaTest` is a uniform (not a define) in three, so the
// distinct refs still share one compiled program.
function _stateKeyOf(mat) {
  const at = +(mat.alphaTest || 0);
  const dw = mat.depthWrite === false ? 0 : 1;
  const b = mat.blending ?? THREE.NormalBlending;
  const blend =
    b === THREE.CustomBlending
      ? `c${mat.blendSrc}.${mat.blendDst}.${mat.blendEquation}`
      : `b${b}`;
  // RND-33 — the sampler ADDRESS MODE is part of the render state: a surface
  // batched into a texture ARRAY layer can only be addressed one way, and a
  // WRAP member sharing a bucket with CLAMP members would sample the wrong
  // texels once its UVs leave [0,1]. Keyed on the resolved wrapS (wrapT is
  // always set with it -- SetSurface applies one mode to both U and V,
  // acclient.c:454437) so WRAP and CLAMP surfaces never co-bucket.
  const wr = mat.map?.wrapS === THREE.RepeatWrapping ? "w" : "c";
  // full precision, not toFixed — the key must round-trip the ref EXACTLY
  // (100/255 and 200/255 are non-terminating) so the bucket material's cutoff
  // is bit-identical to its members'.
  return `${mat.transparent ? 1 : 0}|${String(at)}|${dw}|${blend}|${wr}`;
}

function _applyStateKey(m, stateKey) {
  // RND-33: the trailing wrap field is deliberately NOT applied here. The
  // bucket material samples the packed ATLAS ARRAY, whose own addressing must
  // stay ClampToEdge (Repeat on a packed layer bleeds into the neighbouring
  // tile); the field exists only to keep WRAP and CLAMP members in separate
  // buckets. See _stateKeyOf.
  const [tr, at, dw, blend] = String(stateKey).split("|");
  m.transparent = tr === "1";
  m.alphaTest = Number(at) || 0;
  m.depthWrite = dw !== "0";
  if (blend && blend[0] === "c") {
    const [s, d, e] = blend.slice(1).split(".").map(Number);
    m.blending = THREE.CustomBlending;
    m.blendSrc = s;
    m.blendDst = d;
    m.blendEquation = e;
  } else {
    m.blending = Number(String(blend).slice(1));
  }
  return m;
}

// MeshStandardMaterial whose `map` is replaced by a sampler2DArray indexed per
// vertex (aLayer). Shares ONE compiled program across buckets (customProgramCacheKey)
// so the array variant compiles once; the array uniform differs per material.
//
// X7 — `arrays` is an optional MUTABLE holder `{ diff, nra }` owned by the
// bucket. `onBeforeCompile` reads the arrays THROUGH it instead of closing over
// the array objects, because a grown bucket swaps in NEW array textures and
// disposes the old ones: a closure that captured `diffArray` would re-bind the
// disposed array on any recompile (three re-runs `onBeforeCompile` whenever the
// program cache key changes — a light-count change is enough), which is a black
// bucket, not a warning. Post-compile swaps go through `_rebindArrayUniforms`
// against `userData._statArrayUniforms` (the same live object `setStatPom`
// mutates — three keeps `materialProperties.uniforms === parameters.uniforms`,
// three.module.js:18153). Omitted ⇒ a holder is synthesised from the args, so
// the non-growing per-(LB,size) path below is unchanged.
function makeArrayMaterial(diffArray, stateKey, nraArray, arrays) {
  // Shape decisions (shader source, defines, cache key) are taken from the
  // CONSTRUCTION-time nra presence, which growth never changes; only the array
  // OBJECTS are late-bound.
  const bound = arrays || { diff: diffArray, nra: nraArray };
  const m = new THREE.MeshStandardMaterial({
    map: dummyMap(),
    side: THREE.DoubleSide,
    roughness: 1.0,
    metalness: 0.0,
  });
  _applyStateKey(m, stateKey);
  // X5 — the SAME 1x1 white dummy trick as `map`: assigning `normalMap` is what
  // makes three define USE_NORMALMAP_TANGENTSPACE, which is what emits the
  // derivative `tbn` frame (`getTangentFrame`, normal_fragment_begin) our
  // injected array sampler needs. The dummy is never sampled — the whole
  // <normal_fragment_maps> include is replaced below. Only when nra is live.
  if (nraArray) m.normalMap = dummyMap();
  // RND-33 follow-through (2026-07-28) — THE building/statics SMEAR fix. The
  // stateKey's trailing wrap field kept WRAP and CLAMP members from
  // co-bucketing, but the wrap bucket's sampler still addressed the
  // ClampToEdge array RAW: every surface whose UVs tile past [0,1] (ALL
  // retail buildings — roofs tile to u≈6.75, terrainplan §X3) clamped to the
  // edge texel and smeared it across the face (Holtburg A/B: statAtlas=off
  // crisp thatch, default arm brown goo — scratchpad ab-statatlas-*.png).
  // Wrap buckets now sample fract(vMapUv) through textureGrad with the
  // UNWRAPPED uv's derivatives, so mip selection stays continuous across the
  // fract() seam (no per-tile min-mip seam lines). Residual known trade: the
  // half-texel bilinear discontinuity at each tile repeat (a packed layer
  // cannot cross-filter its own wrap seam) — invisible on the edge-matched
  // retail tiles.
  const wrapBucket = String(stateKey).split("|")[4] === "w";
  // ONE addressing convention for every array in the bucket (diffuse + nra):
  // the wrap bucket fract()s, the clamp bucket samples raw (ClampToEdge does
  // the rest). They MUST agree or the relief would slide off its albedo on
  // tiling surfaces. `addr` wraps an arbitrary uv EXPRESSION so the statPom
  // march can reuse the convention at offset coordinates; every sample goes
  // through textureGrad with derivatives of the UNWRAPPED base uv, which (a)
  // keeps mip selection continuous across the fract() seam and (b) keeps the
  // march loops legal — implicit-LOD sampling inside non-uniform control flow
  // is undefined behaviour.
  const addr = (uvExpr) => (wrapBucket ? `fract( ${uvExpr} )` : `( ${uvExpr} )`);
  const sampleAt = (name, uvExpr) =>
    `textureGrad( ${name}, vec3( ${addr(uvExpr)}, vLayer ), _statUvGx, _statUvGy )`;
  m.onBeforeCompile = (shader) => {
    // X7 — read the CURRENT arrays off the holder (see the note above).
    shader.uniforms.uDiffuseArray = { value: bound.diff };
    // The swap seam for `_rebindArrayUniforms`. Stamped on EVERY compile so a
    // recompile hands over the fresh uniform objects rather than leaving a
    // grow-swap writing into the retired set.
    m.userData._statArrayUniforms = shader.uniforms;
    if (nraArray) {
      shader.uniforms.uNraArray = { value: bound.nra };
      // S3 — statPom uniforms (uniforms, not defines: `window.__statPom` can
      // A/B live, and quality resolution timing can never bake a stale gate
      // into a compiled program).
      const pc = statPomConfig();
      shader.uniforms.uStatPomOn = { value: pc.enabled ? 1 : 0 };
      shader.uniforms.uStatPomDepth = { value: pc.depth };
      shader.uniforms.uStatPomNear = { value: pc.near };
      shader.uniforms.uStatPomFar = { value: pc.far };
      shader.uniforms.uStatPomSteps = { value: pc.steps };
      shader.uniforms.uStatPomShadowSteps = { value: pc.shadowSteps };
      shader.uniforms.uStatPomShadowDark = { value: pc.shadowDark };
      m.userData._statPomUniforms = shader.uniforms;
    }
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aLayer;\nvarying float vLayer;")
      .replace("#include <uv_vertex>", "#include <uv_vertex>\n\tvLayer = aLayer;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nprecision highp sampler2DArray;\nuniform sampler2DArray uDiffuseArray;\nvarying float vLayer;\nvec2 _statUvGx;\nvec2 _statUvGy;" +
          // X5 — one global texel, sampled ONCE in <map_fragment> (the first of
          // our injected sites in main()) and reused by the roughness, normal
          // and AO sites further down. GLSL ES 3.0 forbids a non-constant
          // initializer on a global — constants are fine, so the statPom state
          // defaults here cover every early-out (POM off / too far / grazing /
          // backface) without a second assignment site.
          (nraArray
            ? "\nuniform sampler2DArray uNraArray;" +
              "\nuniform float uStatPomOn;" +
              "\nuniform float uStatPomDepth;" +
              "\nuniform float uStatPomNear;" +
              "\nuniform float uStatPomFar;" +
              "\nuniform int uStatPomSteps;" +
              "\nuniform int uStatPomShadowSteps;" +
              "\nuniform float uStatPomShadowDark;" +
              "\nvec4 _statNraTexel;" +
              "\nvec2 _statPomUv;" +
              "\nfloat _statPomFade = 0.0;" +
              "\nfloat _statPomHitDepth = 0.0;" +
              "\nmat3 _statPomTbn;" +
              // The seam-height field lives in the nra ALPHA channel
              // (packNraLayer): 1.0 = proud face, grooves dip toward 0.
              `\nfloat _statPomHeightAt( vec2 uv ) {\n\treturn ${sampleAt("uNraArray", "uv")}.a;\n}`
            : "")
      )
      .replace(
        // onBeforeCompile runs BEFORE three resolves #include directives, so the
        // expanded `vec4 sampledDiffuseColor = texture2D( map, vMapUv );` line
        // does not exist in the source yet — the old replace never matched, the
        // array sampler was optimized out of the linked program
        // (getUniformLocation(uDiffuseArray) === null), and every bucket rendered
        // its 1x1 white dummy `map` instead (the 2026-07-02 white-trees bug,
        // exposed once the origin-sphere cull stopped hiding the buckets). Swap
        // the whole <map_fragment> include at the directive level instead: same
        // diffuse multiply, sampled from the layer array. sRGB decode is
        // hardware-side (SRGB8_ALPHA8 upload path), so no manual EOTF here.
        "#include <map_fragment>",
        [
          "\t_statUvGx = dFdx( vMapUv );",
          "\t_statUvGy = dFdy( vMapUv );",
          nraArray
            ? [
                // S3 — parallax-occlusion march over the seam-height field.
                // The tangent frame is three's own derivative frame
                // (getTangentFrame, declared by <normalmap_pars_fragment>) —
                // UV-correct and camera-stable, unlike the retired legacy
                // view-space fabrication. Computed UNCONDITIONALLY: dFdx
                // inside the distance branch (non-uniform control flow) is
                // undefined behaviour, and it is 4 derivatives — cheap.
                "\t_statPomUv = vMapUv;",
                "\tfloat _pomFace = gl_FrontFacing ? 1.0 : -1.0;",
                "\tvec3 _pomN = normalize( vNormal );",
                "\t#ifdef DOUBLE_SIDED",
                "\t\t_pomN *= _pomFace;",
                "\t#endif",
                "\t_statPomTbn = getTangentFrame( - vViewPosition, _pomN, vMapUv );",
                "\t#if defined( DOUBLE_SIDED ) && ! defined( FLAT_SHADED )",
                "\t\t_statPomTbn[ 0 ] *= _pomFace;",
                "\t\t_statPomTbn[ 1 ] *= _pomFace;",
                "\t#endif",
                "\tfloat _pomVd = length( vViewPosition );",
                "\tif ( uStatPomOn > 0.5 && _pomVd < uStatPomFar ) {",
                "\t\tvec3 _pomV = normalize( transpose( _statPomTbn ) * normalize( vViewPosition ) );",
                // Grazing rays explode the uv offset (xy/z); the fade to zero
                // strength happens via distance, the hard z gate via view angle
                // — same pair of guards terrain.js's shipping POM uses.
                "\t\tif ( _pomV.z > 0.15 ) {",
                "\t\t\t_statPomFade = 1.0 - smoothstep( uStatPomNear, uStatPomFar, _pomVd );",
                "\t\t\tvec2 _pomStep = ( _pomV.xy / _pomV.z ) * ( uStatPomDepth * _statPomFade ) / float( uStatPomSteps );",
                "\t\t\tfloat _pomLayerStep = 1.0 / float( uStatPomSteps );",
                "\t\t\tvec2 _pomUv = vMapUv;",
                "\t\t\tfloat _pomLd = 0.0;",
                "\t\t\tfloat _pomHd = 1.0 - _statPomHeightAt( _pomUv );",
                "\t\t\tfor ( int i = 0; i < 24; i ++ ) {",
                "\t\t\t\tif ( i >= uStatPomSteps || _pomLd >= _pomHd ) break;",
                "\t\t\t\t_pomUv -= _pomStep;",
                "\t\t\t\t_pomLd += _pomLayerStep;",
                "\t\t\t\t_pomHd = 1.0 - _statPomHeightAt( _pomUv );",
                "\t\t\t}",
                // One secant refinement between the last two samples. Guarded
                // denominator: a march that never crossed (flat seam field —
                // the overwhelmingly common texel) keeps the base uv exactly.
                "\t\t\tvec2 _pomPrev = _pomUv + _pomStep;",
                "\t\t\tfloat _pomAfter = _pomHd - _pomLd;",
                "\t\t\tfloat _pomBefore = ( 1.0 - _statPomHeightAt( _pomPrev ) ) - ( _pomLd - _pomLayerStep );",
                "\t\t\tfloat _pomDen = _pomAfter - _pomBefore;",
                "\t\t\tfloat _pomW = _pomDen < -1e-6 ? clamp( _pomAfter / _pomDen, 0.0, 1.0 ) : 0.0;",
                "\t\t\t_statPomUv = mix( _pomUv, _pomPrev, _pomW );",
                "\t\t\t_statPomHitDepth = 1.0 - _statPomHeightAt( _statPomUv );",
                "\t\t}",
                "\t}",
                // Both arrays sample at the SAME (possibly offset) uv so the
                // relief never slides off its albedo — terrain's rule.
                `\t_statNraTexel = ${sampleAt("uNraArray", "_statPomUv")};`,
                "#ifdef USE_MAP",
                `\tvec4 sampledDiffuseColor = ${sampleAt("uDiffuseArray", "_statPomUv")};`,
                "\tdiffuseColor *= sampledDiffuseColor;",
                "#endif",
              ].join("\n")
            : [
                "#ifdef USE_MAP",
                `\tvec4 sampledDiffuseColor = ${sampleAt("uDiffuseArray", "vMapUv")};`,
                "\tdiffuseColor *= sampledDiffuseColor;",
                "#endif",
              ].join("\n"),
        ].join("\n")
      );
    if (nraArray) {
      shader.fragmentShader = shader.fragmentShader
        // B channel = the member's own roughness (material scalar already folded
        // in at pack time), so the bucket material's `roughness` stays 1.0 and
        // the multiply reproduces the singleton value. This is ALSO what feeds
        // the T3 sky-IBL env specular: three drives `envMap` reflection sharpness
        // and strength off roughnessFactor, so an atlased building now picks up
        // exactly the same treatment the terrain got.
        .replace(
          "#include <roughnessmap_fragment>",
          "\tfloat roughnessFactor = roughness * _statNraTexel.b;"
        )
        // R,G = tangent-normal XY, Z reconstructed on the unit hemisphere —
        // the SAME pack + reconstruction as the terrain nra array
        // (terrain.js `pbrN`, adapter.js buildPbrNraTexture). normalScale was
        // baked into XY at pack time, so no per-layer uniform is needed.
        // `tbn` comes from the stock <normal_fragment_begin> (derivative frame).
        .replace(
          "#include <normal_fragment_maps>",
          [
            "\tvec3 mapN = vec3( _statNraTexel.rg * 2.0 - 1.0, 0.0 );",
            "\tmapN.z = sqrt( max( 1.0 - dot( mapN.xy, mapN.xy ), 0.04 ) );",
            "\tnormal = normalize( tbn * mapN );",
          ].join("\n")
        )
        // A channel = seam height (or the texchan AO fallback — same formula
        // shades both correctly, see packNraLayer). Three terms land here:
        //   1. cavity AO on indirect light (the pre-S3 behaviour, now derived
        //      from the seam field: a groove darkens across its full width);
        //   2. Frostbite-style micro-shadow on DIRECT light — the term that
        //      turned a 6%-of-the-normal-map effect into a first-order cue;
        //   3. the POM self-shadow ray toward the REAL sun (the single
        //      largest measured "this is 3D" term, +0.61 on timber) — the
        //      legacy patch marched toward a camera proxy, which is the most
        //      reliable way to make relief read as painted-on.
        // aomap_fragment runs AFTER lights_fragment_end, so directDiffuse is
        // fully accumulated and `normal`/`directionalLights` are in scope.
        .replace(
          "#include <aomap_fragment>",
          [
            `\tfloat ambientOcclusion = ( _statNraTexel.a - 1.0 ) * ${aoMapIntensityValue().toFixed(3)} + 1.0;`,
            "\treflectedLight.indirectDiffuse *= ambientOcclusion;",
            "\t#if defined( USE_ENVMAP ) && defined( STANDARD )",
            "\t\tfloat dotNV = saturate( dot( geometryNormal, geometryViewDir ) );",
            "\t\treflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );",
            "\t#endif",
            "\t#if NUM_DIR_LIGHTS > 0",
            "\tif ( uStatPomOn > 0.5 && _statPomFade > 0.001 ) {",
            "\t\tvec3 _pomL = directionalLights[ 0 ].direction;",
            "\t\tfloat _pomNdl = saturate( dot( normal, _pomL ) );",
            // ao = 1 ⇒ saturate(ndl + 1) = 1: flat texels are untouched, so
            // the term can only darken grooves, never shift overall exposure.
            "\t\tfloat _pomMicro = clamp( _pomNdl + 2.0 * ambientOcclusion - 1.0, 0.0, 1.0 );",
            "\t\tfloat _pomSun = 1.0;",
            "\t\tvec3 _pomLt = normalize( transpose( _statPomTbn ) * _pomL );",
            "\t\tif ( _pomLt.z > 0.05 && _statPomHitDepth > 0.001 ) {",
            "\t\t\tvec2 _sunStep = ( _pomLt.xy / max( _pomLt.z, 0.05 ) ) * uStatPomDepth / float( uStatPomShadowSteps );",
            "\t\t\tfloat _sunLayerStep = _statPomHitDepth / float( uStatPomShadowSteps );",
            "\t\t\tvec2 _sunUv = _statPomUv + _sunStep;",
            "\t\t\tfloat _sunD = _statPomHitDepth - _sunLayerStep;",
            "\t\t\tfor ( int i = 0; i < 12; i ++ ) {",
            "\t\t\t\tif ( i >= uStatPomShadowSteps || _sunD <= 0.0 ) break;",
            "\t\t\t\tif ( 1.0 - _statPomHeightAt( _sunUv ) < _sunD ) { _pomSun = uStatPomShadowDark; break; }",
            "\t\t\t\t_sunUv += _sunStep;",
            "\t\t\t\t_sunD -= _sunLayerStep;",
            "\t\t\t}",
            "\t\t}",
            "\t\tfloat _pomDirect = mix( 1.0, min( _pomMicro, _pomSun ), _statPomFade );",
            "\t\treflectedLight.directDiffuse *= _pomDirect;",
            "\t\treflectedLight.directSpecular *= _pomDirect;",
            "\t}",
            "\t#endif",
          ].join("\n")
        );
    }
  };
  // One program per address-mode variant (wrap buckets fract-sample); the
  // per-material uDiffuseArray uniform is bound per-draw. Distinct from the
  // stock MeshStandard key so each variant links once. X5 adds a THIRD axis
  // (nra on/off) — still per-BUCKET-CLASS, never per instance (the #1 cold-load
  // cost); with ?statNra absent the key is byte-identical to v1.
  m.customProgramCacheKey = () =>
    (wrapBucket ? "statAtlasArrayMatV4w" : "statAtlasArrayMatV4c")
    + (nraArray ? "nra" + aoMapIntensityValue().toFixed(3) : "");
  m.userData = { __statAtlasMat: true };
  return m;
}

// Normalize a cloned geometry to exactly {position, normal, uv, aLayer}, non-indexed,
// so a whole bucket merges with consistent attributes regardless of source variety.
function normalizeForMerge(geom, layer) {
  let g = geom.index ? geom.toNonIndexed() : geom;
  if (g === geom) g = geom.clone(); // ensure we own it
  for (const name of Object.keys(g.attributes)) {
    if (name !== "position" && name !== "normal" && name !== "uv") g.deleteAttribute(name);
  }
  if (!g.attributes.position || !g.attributes.normal || !g.attributes.uv) return null;
  const cnt = g.attributes.position.count;
  g.setAttribute("aLayer", new THREE.BufferAttribute(new Float32Array(cnt).fill(layer), 1));
  return g;
}

/**
 * Collapse unique-material static SINGLETON Mesh nodes into per-(landblock, size)
 * texture-array-batched merged meshes. Returns { meshes, passthrough }: `meshes`
 * are the new atlas meshes to add; `passthrough` are nodes that couldn't be atlased
 * (no map/uv, LOD, lone-in-bucket, or merge failure) and must be added unchanged.
 * Fail-soft per bucket. Disposes the consumed singleton geometries (cloned into the
 * merge); leaves passthrough nodes intact.
 */
export function consolidateSingletonsViaTexArray(nodes) {
  const meshes = [];
  const passthrough = [];
  const buckets = new Map();
  for (const n of nodes) {
    const mat = n && n.material;
    const tex = mat && mat.map;
    const img = tex && tex.image;
    if (!n || !n.isMesh || n.isLOD || !n.geometry || !n.geometry.attributes?.uv || !tex || !img || !img.data) {
      passthrough.push(n);
      continue;
    }
    const w = img.width | 0, h = img.height | 0;
    if (!w || !h) { passthrough.push(n); continue; }
    const lb = (n.userData?.landblockId >>> 0) || 0;
    const key = `${lb}|${w}x${h}|${_stateKeyOf(mat)}`;
    let a = buckets.get(key);
    if (!a) { a = []; buckets.set(key, a); }
    a.push(n);
  }
  for (const [key, bucketNodes] of buckets) {
    if (bucketNodes.length < 2) { passthrough.push(...bucketNodes); continue; }
    try {
      const parts = key.split("|");
      const lb = (Number(parts[0]) >>> 0);
      const [w, h] = parts[1].split("x").map(Number);
      const stateKey = parts.slice(2).join("|");
      // unique textures -> layer index
      const layerOf = new Map();
      const texList = [];
      for (const n of bucketNodes) {
        const u = n.material.map.uuid;
        if (!layerOf.has(u)) { layerOf.set(u, texList.length); texList.push(n.material.map); }
      }
      // merge geometry (baked transform + aLayer), normalized
      const geos = [];
      const consumed = [];
      for (const n of bucketNodes) {
        n.updateMatrix();
        const g = normalizeForMerge(n.geometry, layerOf.get(n.material.map.uuid));
        if (!g) { passthrough.push(n); continue; }
        g.applyMatrix4(n.matrix);
        geos.push(g);
        consumed.push(n);
      }
      if (geos.length < 2) { for (const g of geos) g.dispose?.(); passthrough.push(...consumed); continue; }
      const merged = mergeGeometries(geos, false);
      for (const g of geos) g.dispose?.();
      if (!merged) { passthrough.push(...consumed); continue; }
      const diffArray = buildDiffuseArray(texList, w, h);
      const mat = makeArrayMaterial(diffArray, stateKey);
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = !!consumed[0].castShadow;
      mesh.receiveShadow = !!consumed[0].receiveShadow;
      mesh.frustumCulled = true;
      mesh.userData = { landblockId: lb, __statAtlas: true, layers: texList.length, props: consumed.length };
      mesh.name = `stat-atlas-lb${lb.toString(16)}-${parts[1]}-x${consumed.length}`;
      meshes.push(mesh);
      // the merged mesh owns its geometry (cloned); free the originals' GPU geometry.
      for (const n of consumed) { try { n.geometry?.dispose?.(); } catch (_) {} }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[static_atlas] bucket failed, passthrough:", String(e?.message ?? e));
      passthrough.push(...bucketNodes);
    }
  }
  return { meshes, passthrough };
}

// ===========================================================================
// CROSS-LANDBLOCK texture-array batching (the real win — ?statAtlas=on).
//
// The per-(LB,size) `consolidateSingletonsViaTexArray` above is a near-no-op:
// within ONE landblock too few singletons share a size bucket. The structure
// is GLOBAL — ~5,400 singletons collapse to ~20 size buckets across the whole
// resident ring. So we bucket by SIZE ONLY (drop the `${lb}|` prefix) and back
// each bucket with ONE persistent THREE.BatchedMesh that spans the ring:
//   - addGeometry/addInstance per singleton → ONE multidraw call per bucket.
//   - per-instance world transform via setMatrixAt (NOT baked into geometry).
//   - the PROVEN sampler2DArray shader (makeArrayMaterial/normalizeForMerge)
//     is reused UNCHANGED — `aLayer` is a per-vertex attribute that BatchedMesh
//     copies into its merged buffer and `optimize()` carries with its vertices.
//
// EVICTION (the hard part): a cross-LB BatchedMesh has NO single landblockId,
// so the LRU per-LB statics scan (landblock_lru step 3) naturally SKIPS it.
// Per-LB removal is done by a dedicated hook `scene3d._evictStaticAtlasForLb`
// (installed below, mirrors `_evictStaticParticlesForLb`) that calls
// `bm.deleteGeometry(gid)` for every gid that LB contributed. deleteGeometry
// flips the geometry+instance to active=false and onBeforeRender drops it from
// the multidraw THE SAME FRAME — no orphan, no wrong render, other LBs' gids
// untouched (ids are integer-keyed, not slot-keyed). The bucket BatchedMesh is
// NEVER disposed on per-LB eviction (it spans the ring). Buffer space freed by
// delete is reclaimed LAZILY via `bm.optimize()` off the per-frame hot path
// (driven from the ~10 Hz PVS tick). Layers are refcounted + recycled.
//
// Re-entry: eviction clears `_atlasBakedLbs[lbKey]`; the per-LB baker's atlas
// feed seam re-feeds the LB's singletons with fresh gids from the recycled pool.
// ===========================================================================

// Per-bucket DataArrayTexture VRAM budget → layer CEILING. X7 (2026-08-06): this
// is no longer what gets allocated — it is the cap the doubling growth clamps to
// (`_growTargetFor`), so a bucket can never allocate MORE than the pre-X7 code
// did, at any point in a session. A DataArrayTexture still cannot grow its layer
// count in place; growth allocates a new array and re-uploads the live prefix. The
// spike measured max 123 layers (128×128) and only 353 unique textures total, so
// a memory-bounded capacity comfortably covers every bucket; overflow is fail-soft
// (the offending node falls back to an unbatched singleton — never vanishes).
const _ATLAS_LAYER_BUDGET_BYTES = 32 * 1024 * 1024;
const _ATLAS_MIN_LAYERS = 32;
const _ATLAS_MAX_LAYERS = 256;
// X5 — the budget above is a per-bucket TEXTURE budget, and with ?statNra=on a
// bucket carries TWO arrays of identical dimensions. The first cut kept the
// capacity unchanged (for A/B parity) and the arm DIED: earlyoom SIGTERM'd the
// renderer at 5,164 MiB RSS on this 8 GB box (SwiftShader keeps every texture in
// system RAM; 14 live buckets went from ~175 MB of array bytes to ~350 MB, ×~1.33
// for mips, ×2 for the driver's own copy). So the two arrays SHARE the budget:
// per-layer cost counts both, and the hard layer ceiling halves. Measured live
// working set at Holtburg is 28–47 layers across all buckets, so the smaller
// ceiling costs nothing real — and overflow is fail-soft anyway (the node falls
// back to an unbatched singleton, `ptLayerFull`).
const _ATLAS_NRA_MAX_LAYERS = 128;
// The MIN floor overrides the budget (it exists so a huge tile size still gets a
// usable bucket), so it has to halve too or the 512×512 bucket alone would carry
// 2 × 32 × 1 MiB. Live usage there is 2 layers.
const _ATLAS_NRA_MIN_LAYERS = 16;
// X7 — the layer depth a bucket actually ALLOCATES at creation, and the byte cap
// on that first allocation. 4 layers is roughly the median bucket's whole live
// working set (14 of the 29 measured buckets never exceed 4, and 21 never exceed
// 8 — RESULTS-atlas-occupancy-2026-08-05.json), so most buckets never grow at all.
// The BYTE cap is what stops the flat count from being a footgun on huge tiles:
// the 2048×2048 bucket costs 16 MiB PER nra LAYER, where 4 layers up front would
// be 64 MiB for a bucket whose measured live use is 2. Same shape of trap the BC7
// floor hit in `_layerCapacityFor` — a flat LAYER count is not a memory bound.
const _ATLAS_GROW_START_LAYERS = 4;
const _ATLAS_GROW_START_BYTES = 2 * 1024 * 1024;
const _ATLAS_INIT_VERTS = 1 << 15; // 32,768; grows via setGeometrySize on demand
const _ATLAS_INIT_INST = 1024;     // grows via setInstanceCount on demand
const _ATLAS_OPTIMIZE_FRAC = 0.30; // compact a bucket once >30% of its buffer is dead

// Lazy module state — allocated only when the cross-LB path actually runs (i.e.
// only under ?statAtlas=on). Flag-off, nothing here is ever touched.
const _buckets = new Map();        // bucketKey -> { bm, w, h, stateKey }
const _lbMembership = new Map();   // lbKey -> Array<{ bucketKey, gid, texUuid }>
const _atlasBakedLbs = new Set();  // lbKeys whose singletons are live in the buckets

// Diagnostic (2026-07-14): cumulative passthrough-reason tally + per-bucket fullness, so a
// census can see WHY a static stays individual — layer-pool-full (capacity) vs never-fed
// (routing) vs merge-fail. Cheap counters, no behaviour change. Read via window.__atlasStats().
const _atlasStats = { feeds: 0, nodesIn: 0, atlased: 0, ptFiltered: 0, ptDeformed: 0, ptNoWH: 0, ptLayerFull: 0, ptNormFail: 0, ptGeomFail: 0, ptInstFail: 0, ptError: 0,
  // X5 surface-dedup census: `surfaceRefs` counts every atlased member's surface
  // REFERENCE (pre-dedup); `layerAllocs` counts the layers actually cut (post-
  // dedup, incl. re-allocation after an LB evicted its last user); `layerHits`
  // is the refcount reuse. `uniqueSurfacesEver` is the distinct-texture count
  // across the whole session (see `_uniqueTexUuids`).
  surfaceRefs: 0, layerAllocs: 0, layerHits: 0, layerRecycles: 0,
  // X7 grow-on-demand tally. `layerGrows` is the number of array reallocations
  // (bounded by log2(capacity) per bucket — the four-town route models at 19
  // across all 29 buckets); `layerGrowUploads` is the layers re-uploaded by
  // them, the whole GPU cost of the scheme. `layerGrowFails` should stay 0 —
  // non-zero means an allocation was refused and that bucket is now capped
  // below its ceiling (props route to `ptLayerFull`, never vanish).
  layerGrows: 0, layerGrowUploads: 0, layerGrowFails: 0,
  // X5 nra pack tally (all zero unless ?statNra=on).
  nraLayersPacked: 0, nraWithNormal: 0, nraWithRough: 0, nraWithAo: 0,
  nraWithHeight: 0, // S3: layers whose alpha carries the seam-height field
  nraResampled: 0, nraMetalDropped: 0, nraRepacked: 0, nraPendingDropped: 0,
  // X6 BC7 tally (all zero unless ?texBc7=on AND the GPU has BPTC).
  bc7Buckets: 0, bc7Layers: 0, ptBc7Deferred: 0,
  // 2026-08-03 layer-write invariant: a recycled layer whose source could not be
  // written is zeroed (RGBA8) or released (BC7) instead of bleeding its previous
  // surface. Both should stay 0 in a healthy session.
  layerWriteZeroed: 0, ptLayerWriteFail: 0,
  // Per-node exceptions whose partial commit had to be unwound.
  ptErrorUnwound: 0 };
const _uniqueTexUuids = new Set(); // every distinct surface texture ever atlased
if (typeof window !== "undefined") {
  window.__atlasStats = () => {
    let liveLayers = 0;
    // X7 — the two aggregates the 2026-08-05 occupancy measurement wanted:
    // `allocLayers` is what the arrays actually hold (the number that used to
    // BE `capacity`), `capLayers` is the ceiling it is allowed to reach.
    let allocLayers = 0;
    let capLayers = 0;
    for (const b of _buckets.values()) {
      const ud = b.bm?.userData;
      liveLayers += ud?.layerOf?.size || 0;
      allocLayers += ud?.allocLayers || 0;
      capLayers += ud?.capacity || 0;
    }
    return {
      ..._atlasStats,
      allocLayers,
      capLayers,
      growEnabled: statAtlasGrowEnabled(),
      // X5 — the before/after dedup headline. `surfaceRefs` in, `uniqueSurfacesEver`
      // distinct textures out; `liveLayers` is what is resident right now.
      uniqueSurfacesEver: _uniqueTexUuids.size,
      liveLayers,
      dedupRatio: _atlasStats.surfaceRefs > 0
        ? +(_atlasStats.surfaceRefs / Math.max(1, _uniqueTexUuids.size)).toFixed(2) : 0,
      nraEnabled: statNraEnabled(),
      statPom: _statPomCfg ? { ..._statPomCfg } : null, // S3; null = no bucket yet
      nraPending: _nraPending.length,
      bucketCount: _buckets.size,
      atlasBakedLbs: _atlasBakedLbs.size,
      buckets: [..._buckets.entries()].map(([k, b]) => {
        const ud = (b.bm && b.bm.userData) || {};
        return { key: k, w: b.w, h: b.h, stateKey: b.stateKey, nextLayer: ud.nextLayer ?? null,
          capacity: ud.capacity ?? null, alloc: ud.allocLayers ?? null, // X7: alloc <= capacity
          layersUsed: ud.layerOf ? ud.layerOf.size : null,
          nra: !!ud.nraArray, bc7: !!ud.bc7,
          full: (ud.nextLayer != null && ud.capacity != null) ? ud.nextLayer >= ud.capacity : null };
      }),
    };
  };
}
const _dirtyBuckets = new Set();   // buckets with freed geometry awaiting optimize()
// X5 — layers packed while their material's Phase-5 texchan roughness/AO bake was
// still in flight (materials.js `_resolveRough` attaches ASYNCHRONOUSLY, often
// after the atlas has already consumed the node). Re-packed from the ~10 Hz
// PVS tick until the maps land or the retry budget runs out. Empty (and never
// appended to) unless ?statNra=on.
const _nraPending = [];
// ~60 s at the 10 Hz tick. The first cut used 6 s and EVERY entry expired
// unfed (`nraPendingDropped=28`, `nraWithRough=0`): `_resolveRough` does an HTTP
// fetch of a per-DID `.texchan.bin` plus a wasm decode, which on a cold boot
// lands well after the atlas has consumed the surface. The list holds only the
// layers still waiting (tens), and each tick costs two property reads per entry.
const _NRA_PENDING_TRIES = 600;

function _lbKeyOfId(id) {
  return (((id >>> 0) & 0xffff0000) >>> 0);
}

/**
 * X6 — a BC7 map carries its bytes in `mipmaps[0].data`, NOT `image.data`, so
 * an `img.data` test alone rejects every BC7 surface. Exported so caller-side
 * pre-filters (statics.js's walk-in feed) use the same rule as the feed itself
 * and can't silently drop BC7 nodes back to one-draw-per-prop.
 */
/**
 * Should this node be held out of a bucket because its BC7 verdict is still in
 * flight? Exported so the regression suite exercises THE gate rather than a
 * transcription of it — the 2026-08-05 P1 hole (see the call site) was
 * invisible precisely because nothing tested the predicate itself.
 */
export function bc7AtlasShouldDefer(mat) {
  return bc7Available() && bc7PendingOn(mat);
}

export function isBc7AtlasTexture(tex) {
  return !!(
    tex &&
    tex.isCompressedTexture &&
    tex.format === THREE.RGBA_BPTC_Format &&
    tex.mipmaps &&
    tex.mipmaps[0] &&
    tex.mipmaps[0].data
  );
}

// X6 — the trailing format field. `f8` = RGBA8 `DataArrayTexture` (every bucket
// before X6, so a flag-off key is byte-identical to the pre-X6 string only if the
// suffix is omitted — it is NOT omitted, see below); `f7` = BC7
// `CompressedArrayTexture`. A compressed array's internal format is baked in by
// `texStorage3D` at allocation, so a BC7 layer and an RGBA8 layer can NEVER share
// a bucket; the key is the only place that can enforce it.
// NOTE the deliberate asymmetry: the `f8` suffix is appended ONLY when the BC7
// path is live, so with `?texBc7` absent every bucket key is character-identical
// to the pre-X6 key (bucket identity is used in `bm.name` and `__atlasStats`).
function _bucketKeyFor(w, h, stateKey, bc7) {
  if (!bc7Available()) return `${w}x${h}|${stateKey}`;
  return `${w}x${h}|${stateKey}|${bc7 ? "f7" : "f8"}`;
}

/**
 * X7 — bytes ONE layer of this bucket costs across every array it carries
 * (diffuse + nra). Lifted verbatim out of `_layerCapacityFor` so the growth
 * sizing and the ceiling arithmetic can never drift apart; the expressions are
 * unchanged, including the `Math.max(1, …)` guard.
 */
function _perLayerBytesFor(w, h, bc7) {
  const nra = statNraEnabled();
  if (bc7) return Math.max(1, bc7LevelBytes(w, h) + (nra ? (w | 0) * (h | 0) * 4 : 0));
  return Math.max(1, (w | 0) * (h | 0) * 4 * (nra ? 2 : 1));
}

/**
 * X7 — the depth a bucket allocates at CREATION: a small flat layer count,
 * capped by bytes so a huge tile still starts at 1–3 layers rather than 64 MiB
 * of padding. Never above `capacity` (a bucket whose ceiling is 1 must not
 * allocate 4), never below 1. Exported for the regression suite so the sizing
 * is tested where it lives rather than through a transcription of it.
 */
export function _atlasStartLayersFor(w, h, bc7, capacity) {
  const cap = Math.max(1, capacity | 0);
  const affordable = Math.floor(_ATLAS_GROW_START_BYTES / _perLayerBytesFor(w, h, bc7));
  return Math.max(1, Math.min(_ATLAS_GROW_START_LAYERS, cap, affordable || 1));
}

/**
 * X7 — the next allocated depth: double, but take at least `needed` (so one
 * step always satisfies the request even from a start of 1) and NEVER exceed
 * `capacity`. The clamp is the guarantee that matters: at no point in a session
 * does a bucket hold more layers than the pre-X7 code allocated on creation.
 * Returns <= `alloc` when there is no room left — the caller then falls through
 * to the unchanged `ptLayerFull` passthrough.
 */
export function _atlasGrowTargetFor(alloc, needed, capacity) {
  const a = Math.max(1, alloc | 0);
  const cap = Math.max(1, capacity | 0);
  if (a >= cap) return a;
  return Math.min(cap, Math.max(needed | 0, a * 2));
}

/** The per-bucket layer CEILING (X7: no longer the allocated depth — see the
 *  header). Exported for the regression suite. */
export function _layerCapacityFor(w, h, bc7) {
  // X6 — BC7 layers are 8 bpp, not 32, so the same byte budget buys 4x the
  // layers. The RGBA8 arithmetic below is left untouched (flag-off parity).
  if (bc7) {
    const nra = statNraEnabled();
    const per = _perLayerBytesFor(w, h, bc7);
    const ceiling = nra ? _ATLAS_NRA_MAX_LAYERS : _ATLAS_MAX_LAYERS;
    let c = Math.floor(_ATLAS_LAYER_BUDGET_BYTES / per);
    // BYTE-AWARE FLOOR (the trap the RGBA8 path never hit): the flat 32/16-layer
    // minimum exists so a big tile still gets a usable bucket, but the x4-upscaled
    // BC7 content reaches 2048x2048 = 4 MiB PER LAYER, where a 32-layer floor
    // would allocate 128 MiB for one bucket (and the RGBA8 equivalent, 512 MiB,
    // is exactly the shape of the OOM that killed the first ?statNra arm). Clamp
    // the floor to what the budget actually affords, never below 4.
    const floor = Math.min(nra ? _ATLAS_NRA_MIN_LAYERS : _ATLAS_MIN_LAYERS, Math.max(4, c));
    if (c < floor) c = floor;
    if (c > ceiling) c = ceiling;
    return c;
  }
  // X5: with the nra pack live a layer costs TWICE the bytes (diffuse + nra),
  // and the ceiling halves — see _ATLAS_NRA_MAX_LAYERS. Flag-off arithmetic is
  // unchanged (arrays === 1, ceiling === _ATLAS_MAX_LAYERS).
  const arrays = statNraEnabled() ? 2 : 1;
  const per = _perLayerBytesFor(w, h, bc7);
  const floor = arrays === 2 ? _ATLAS_NRA_MIN_LAYERS : _ATLAS_MIN_LAYERS;
  const ceiling = arrays === 2 ? _ATLAS_NRA_MAX_LAYERS : _ATLAS_MAX_LAYERS;
  let c = Math.floor(_ATLAS_LAYER_BUDGET_BYTES / per);
  if (c < floor) c = floor;
  if (c > ceiling) c = ceiling;
  return c;
}

/** Whether an LB's singletons are currently live in the cross-LB buckets. */
export function hasAtlasLb(lbKey) {
  return _atlasBakedLbs.has((lbKey >>> 0));
}

function _getOrCreateBucket(bucketKey, w, h, stateKey, scene3d, bc7) {
  let b = _buckets.get(bucketKey);
  if (b) return b;
  const capacity = _layerCapacityFor(w, h, bc7);
  // X7 — `capacity` is the CEILING; `alloc` is what is actually allocated now.
  // Disarmed (`?statAtlasGrow=off`) the two are equal, which both restores the
  // pre-X7 allocation byte for byte AND makes `_growBucketLayers` unreachable
  // (the feed's `nextLayer < allocLayers` branch then spans the whole range).
  const alloc = statAtlasGrowEnabled() ? _atlasStartLayersFor(w, h, bc7, capacity) : capacity;
  // X6 — a BC7 bucket's array is a CompressedArrayTexture allocated EMPTY at the
  // bucket's fixed (w, h, depth); layers are written with
  // `compressedTexSubImage3D` via `addLayerUpdate` (bc7_textures.js). That is
  // strictly cheaper than the RGBA8 arm, which re-uploads the WHOLE array every
  // time a layer is written (`needsUpdate` on a DataArrayTexture).
  const diffArray = bc7
    ? makeBc7ArrayTexture(w, h, alloc)
    : buildDiffuseArray([], w, h, alloc);
  // X5 — parallel nra array at the SAME depth as the diffuse array, so the
  // layer index addresses both (one `aLayer`, one `vMapUv`). `_layerCapacityFor`
  // has already halved that ceiling for the nra-on case, so the PAIR fits the
  // same per-bucket byte budget the albedo-only arm used (the un-halved first cut
  // OOM-killed the renderer — see _ATLAS_NRA_MAX_LAYERS). X7 grows them TOGETHER,
  // in one `_growBucketLayers` call, so the two depths can never diverge.
  const nraArray = statNraEnabled() ? buildNraArray(w, h, alloc) : null;
  // X7 — the mutable holder the material's onBeforeCompile closure reads. Owned
  // by the bucket record so a grow-swap is visible to a later RECOMPILE.
  const arrays = { diff: diffArray, nra: nraArray };
  const material = makeArrayMaterial(diffArray, stateKey, nraArray, arrays);
  const bm = new THREE.BatchedMesh(_ATLAS_INIT_INST, _ATLAS_INIT_VERTS, _ATLAS_INIT_VERTS * 2, material);
  // OPAQUE: skip the per-frame depth sort of every instance (the CPU win we are
  // here for). Transparent buckets keep the sort for correct blending order —
  // EXCEPT alpha-tested ones (RND-08/33 made ClipMap `transparent = true`): the
  // surviving texels are ~opaque and z-writes stay on, so their draw order is
  // already independent and re-sorting every foliage instance per frame would
  // hand back the CPU win for nothing.
  bm.sortObjects = material.transparent === true && !(material.alphaTest > 0);
  bm.perObjectFrustumCulled = true; // cheap per-instance sphere cull trims the multidraw
  bm.frustumCulled = false;         // the whole batch spans the ring; never cull as one
  bm.castShadow = true;
  bm.receiveShadow = true;
  // NO userData.landblockId — that is what keeps the LRU per-LB statics scan
  // (landblock_lru step 3) from removing/disposing this ring-spanning batch.
  bm.userData = {
    __statAtlasCrossLb: true,
    diffArray,
    bc7: !!bc7,          // X6: diffArray is a CompressedArrayTexture, not RGBA8
    nraArray,            // X5: null unless ?statNra=on
    layerOf: new Map(),  // texUuid -> { layer, refs }
    freeLayers: [],      // recycled layer indices (pixels overwritten on reuse)
    capacity,            // X7: the CEILING the doubling clamps to — not the allocation
    allocLayers: alloc,  // X7: the depth diffArray/nraArray are allocated at RIGHT NOW
    nextLayer: 0,
    maxVerts: _ATLAS_INIT_VERTS,
    maxInst: _ATLAS_INIT_INST,
    deadVerts: 0,        // vertices in deleted geometries awaiting optimize()
    usedVerts: 0,        // total live+dead vertices ever appended (the buffer's used extent;
                         //   deleteGeometry does NOT compact, so this only drops on optimize())
    gidVerts: new Map(), // gid -> vertexCount (to account dead space on delete)
  };
  bm.name = `stat-atlas-x-${bucketKey}`;
  b = { bm, w, h, stateKey, bc7: !!bc7, arrays };
  if (bc7) {
    _atlasStats.bc7Buckets++;
    _bumpBc7Stat("atlasBuckets");
  }
  _buckets.set(bucketKey, b);
  try { scene3d?.staticsGroup?.add(bm); } catch (_) { /* fail-soft */ }
  return b;
}

/**
 * X7 — re-point a COMPILED bucket material's array uniforms at the bucket's
 * current arrays. `userData._statArrayUniforms` is the very object three keeps
 * as `materialProperties.uniforms` (three.module.js:18153) and uploads from per
 * draw, which is the same seam `setStatPom` uses to A/B live — mutating
 * `.value` is a uniform rebind, not a recompile, and is safe between frames.
 * Returns false when the material has not compiled yet: nothing to rebind, and
 * the first compile will read the (already updated) holder anyway.
 */
function _rebindArrayUniforms(material, ud) {
  const u = material && material.userData && material.userData._statArrayUniforms;
  if (!u) return false;
  if (u.uDiffuseArray) u.uDiffuseArray.value = ud.diffArray;
  // Only present when the bucket was built with nra; growth never changes that.
  if (u.uNraArray) u.uNraArray.value = ud.nraArray;
  return true;
}

/**
 * X7 — grow a bucket's layer arrays to hold at least `needed` layers, by
 * doubling and clamping to `ud.capacity`. Returns true when the arrays now have
 * room; false leaves the bucket EXACTLY as it was, so the caller falls through
 * to the unchanged fail-soft `ptLayerFull` passthrough.
 *
 * Why a new array and not a resize: layer count is fixed by `texStorage3D` at
 * allocation for both `DataArrayTexture` and `CompressedArrayTexture`. So:
 * allocate at the new depth, copy the live prefix from the OLD array's own CPU
 * mirror (the BC7 arm included — `makeBc7ArrayTexture` owns `mipmaps[0].data`
 * and `writeBc7ArrayLayer` writes into it, so nothing has to be re-fetched or
 * retained per layer), re-mark the carried-over layers dirty, swap, dispose.
 *
 * The re-mark is LOAD-BEARING. Three's first upload of a fresh array texture
 * runs `texStorage3D` (contents undefined) and then, when `layerUpdates` is
 * non-empty, uploads ONLY the marked layers (three.module.js:12160-12195 for
 * DataArrayTexture, :12026-12070 for CompressedArrayTexture). Copying the CPU
 * bytes and setting `needsUpdate` alone would upload the ONE layer the feed is
 * about to mark and leave every carried-over layer as GPU garbage. Marking the
 * prefix is also cheaper than the full-depth `texSubImage3D` the empty-set
 * branch would do — it sends the live layers, not the padding.
 */
function _growBucketLayers(b, needed) {
  const bm = b.bm;
  const ud = bm.userData;
  const target = _atlasGrowTargetFor(ud.allocLayers, needed, ud.capacity);
  if (target <= ud.allocLayers) return false; // at the ceiling — caller passthroughs
  const w = b.w, h = b.h;
  const rgbaStride = (w | 0) * (h | 0) * 4;
  let newDiff = null;
  let newNra = null;
  try {
    if (ud.bc7) {
      const blockStride = bc7LevelBytes(w, h);
      newDiff = makeBc7ArrayTexture(w, h, target);
      newDiff.mipmaps[0].data.set(
        ud.diffArray.mipmaps[0].data.subarray(0, ud.allocLayers * blockStride), 0);
    } else {
      newDiff = buildDiffuseArray([], w, h, target);
      newDiff.image.data.set(
        ud.diffArray.image.data.subarray(0, ud.allocLayers * rgbaStride), 0);
    }
    if (ud.nraArray) {
      // buildNraArray pre-fills the FLAT texel, so the tail beyond the copied
      // prefix keeps the "unpacked layer shades like albedo-only v1" contract.
      newNra = buildNraArray(w, h, target);
      newNra.image.data.set(
        ud.nraArray.image.data.subarray(0, ud.allocLayers * rgbaStride), 0);
    }
  } catch (e) {
    // Out of memory / allocation refused: drop the partial pair and leave the
    // bucket untouched. This is the one case where growing is WORSE than not
    // having grown, so it must not be allowed to half-apply.
    try { newDiff && newDiff.dispose && newDiff.dispose(); } catch (_) {}
    try { newNra && newNra.dispose && newNra.dispose(); } catch (_) {}
    _atlasStats.layerGrowFails++;
    return false;
  }
  // Re-mark every layer index already handed out (free-list entries included:
  // they are cheap, and a recycled layer is fully rewritten before reuse anyway).
  for (let i = 0; i < ud.nextLayer; i++) {
    if (typeof newDiff.addLayerUpdate === "function") newDiff.addLayerUpdate(i);
    if (newNra && typeof newNra.addLayerUpdate === "function") newNra.addLayerUpdate(i);
  }
  const oldDiff = ud.diffArray;
  const oldNra = ud.nraArray;
  ud.diffArray = newDiff;
  ud.nraArray = newNra;
  ud.allocLayers = target;
  // Both seams, in this order: the holder first (what a RECOMPILE will read),
  // then the live uniform objects (what the CURRENT program samples). Anything
  // that reads through `ud` — the feed's layer writes, `_drainNraPending`'s
  // `p.ud.nraArray` — picks the new arrays up automatically.
  if (b.arrays) { b.arrays.diff = newDiff; b.arrays.nra = newNra; }
  newDiff.needsUpdate = true;
  if (newNra) newNra.needsUpdate = true;
  _rebindArrayUniforms(bm.material, ud);
  // Only now: nothing samples the old pair any more.
  try { oldDiff && oldDiff.dispose && oldDiff.dispose(); } catch (_) {}
  try { oldNra && oldNra.dispose && oldNra.dispose(); } catch (_) {}
  _atlasStats.layerGrows++;
  _atlasStats.layerGrowUploads += ud.nextLayer;
  return true;
}

// addGeometry, growing the vertex buffer on demand (delete never reclaims space;
// optimize() does, lazily). unusedVertexCount is the public free-tail getter.
function _addGeometryGrow(bm, g, vcount) {
  const ud = bm.userData;
  if (bm.unusedVertexCount < vcount) {
    const newMax = Math.max(ud.maxVerts * 2, ud.maxVerts + vcount + 4096);
    bm.setGeometrySize(newMax, newMax * 2);
    ud.maxVerts = newMax;
  }
  return bm.addGeometry(g);
}

// addInstance, growing the instance capacity on demand.
function _addInstanceGrow(bm, gid) {
  const ud = bm.userData;
  try {
    return bm.addInstance(gid);
  } catch (_) {
    const newInst = ud.maxInst * 2;
    bm.setInstanceCount(newInst);
    ud.maxInst = newInst;
    return bm.addInstance(gid);
  }
}

/**
 * Feed plain-Mesh static SINGLETON nodes into the GLOBAL (cross-LB) size-bucket
 * BatchedMeshes. Each qualifying node's texture takes a refcounted layer in its
 * bucket's DataArrayTexture; its geometry is added to the bucket BatchedMesh in
 * OBJECT space and its world transform is applied via setMatrixAt. Membership is
 * recorded under the node's lbKey so `evictStaticAtlasForLb` can excise it later.
 *
 * Returns { passthrough }: nodes that couldn't be atlased (no map/uv/image.data,
 * LOD, layer overflow, or any per-node error) — the caller must add these to the
 * scene graph unchanged so props NEVER vanish (fail-soft). The bucket BatchedMeshes
 * self-add to scene3d.staticsGroup on first use; the caller adds only passthrough.
 */
export function addSingletonsToCrossLbAtlas(nodes, scene3d) {
  const passthrough = [];
  // Install the per-LB eviction hook on the baker's scene3d (the per-LB walk-in path
  // passes liveScene3d directly; the boot-ring path passes scene3dForBuilders). The
  // LRU reads this hook off liveScene3d, which is ALSO wired deterministically at LRU
  // construction (index.js) so a ring-fed LB evicting before the first per-LB feed still
  // excises (no orphan). ?statAtlas=off ⇒ this never runs ⇒ landblock_lru typeof-guard no-ops.
  if (scene3d && scene3d._evictStaticAtlasForLb !== evictStaticAtlasForLb) {
    scene3d._evictStaticAtlasForLb = evictStaticAtlasForLb;
  }
  const touchedDiff = new Set();
  const touchedNra = new Set(); // X5
  const fedLbs = new Set();
  _atlasStats.feeds++;
  for (const n of nodes) {
    let handled = false;
    // 2026-08-03 — partial-commit tracking so the blanket catch below can
    // unwind. Without it a throw between the layer take and the membership
    // push leaked the layer refcount AND left an unevictable geometry in the
    // bucket that rendered alongside the passthrough copy of the same node.
    let heldEntry = null;   // { ud, uuid, entry }
    let heldGeom = null;    // { bm, gid, vcount }
    _atlasStats.nodesIn++;
    try {
      const mat = n && n.material;
      const tex = mat && mat.map;
      const img = tex && tex.image;
      // X6 — a BC7 map has NO `image.data` (its bytes live in `mipmaps[0].data`
      // and `image` carries only the dims), so the pre-X6 `!img.data` gate would
      // have silently passed every BC7 surface through as an unbatched singleton —
      // exactly the ~5,400-draw-call wall the atlas exists to remove. Accept
      // either pixel source.
      const bc7Tex = isBc7AtlasTexture(tex);
      // 2026-08-05 — the twin of `statics.js:2379`. Ask whether pixels CAN be
      // supplied, not whether this texture still carries them: an `img.data`
      // test answers no for every released texture and routes every static to an
      // unbatched singleton, back toward the ~5,400-draw-call wall this atlas
      // exists to remove. Identical today, since tier 1 of `canSupplyPlanes` IS
      // the `img.data` test.
      const canPixels = (img && img.data) || bc7Tex ||
        canSupplyPlanes(n?.material, n?.material?.userData?.surfaceDid);
      if (!n || !n.isMesh || n.isBatchedMesh || n.isLOD || !n.geometry || !n.geometry.attributes?.uv || !tex || !img || !canPixels || n.userData?.__staticBatch) {
        _atlasStats.ptFiltered++; passthrough.push(n); continue; // ?staticBatch nodes already batched — never re-feed
      }
      // X6 — a surface whose BC7 verdict is still IN FLIGHT must not be committed
      // to a bucket: a bucket's array format AND dimensions are fixed by
      // `texStorage3D` at allocation, so the wrong choice pins that surface until
      // its LB re-streams. Hold the node out for this round instead (unbatched,
      // still rendered — fail-soft); the next per-LB feed after eviction/re-entry
      // sees the resolved `mat.map`. Only reachable under `?texBc7=on`.
      //
      // 2026-08-05 — the gate USED TO read `!bc7Tex && bc7PendingOn(mat)`, and
      // P1 preview-first walked straight through it. Once the quarter-res PRE
      // record swaps in, `mat.map` IS a BC7 CompressedTexture while
      // `__bc7Pending` is still set (upgradeMaterialToBc7 clears the marker only
      // in the FULL phase), so `!bc7Tex` was false and the node committed — into
      // a bucket keyed at the PRE's dimensions, e.g. 128x128 instead of 512x512.
      // The later full swap re-points `mat.map`, but the atlas layer holds a
      // COPY, so that prop rendered at quarter resolution until its LB
      // re-streamed, and layer dedup split as well (pre uuid != full uuid). It
      // also contradicted the documented contract — url-flags.md `texPre`:
      // "Statics-ATLAS buckets are full-only by design".
      //
      // `bc7PendingOn` alone is the correct and sufficient test: while the
      // marker is set, `mat.map` is either the RGBA8 twin or the PRE texture and
      // NEVER the full record (the full phase deletes the marker before it
      // swaps), so dropping `!bc7Tex` restores exactly the pre-P1 behaviour.
      if (bc7AtlasShouldDefer(mat)) {
        _atlasStats.ptBc7Deferred++; _bumpBc7Stat("deferredNodes"); passthrough.push(n); continue;
      }
      // A MECH-B vertex-deformed variant (deformation.windSwayGpu — swaying
      // trees/foliage) must NOT be consumed: the bucket's array material
      // replaces the node's variant, silently stripping the deformation. That
      // produced the 2026-07-02 "trunk sways, foliage frozen" split — the
      // trunk's surface group hit the ?staticBatch consolidator (variant
      // material kept) while the foliage singleton landed here. Pass it
      // through instead; the singleton keeps its swaying variant. Frag-only
      // (color-effect) sets still atlas — match the deformation prefix only.
      if (typeof mat.userData?.__vfxSetKey === "string" && mat.userData.__vfxSetKey.includes("deformation.")) {
        _atlasStats.ptDeformed++; passthrough.push(n); continue;
      }
      const w = img.width | 0, h = img.height | 0;
      if (!w || !h) { _atlasStats.ptNoWH++; passthrough.push(n); continue; }
      const stateKey = _stateKeyOf(mat);
      const bucketKey = _bucketKeyFor(w, h, stateKey, bc7Tex);
      const b = _getOrCreateBucket(bucketKey, w, h, stateKey, scene3d, bc7Tex);
      const bm = b.bm;
      const ud = bm.userData;
      const uuid = tex.uuid;
      _atlasStats.surfaceRefs++; // X5 dedup census: one per atlas-able member (pre-dedup)
      // refcounted layer (dedup shared textures across LBs)
      let entry = ud.layerOf.get(uuid);
      if (entry) {
        entry.refs += 1;
        _atlasStats.layerHits++;
      } else {
        let layer;
        if (ud.freeLayers.length > 0) { layer = ud.freeLayers.pop(); _atlasStats.layerRecycles++; }
        else if (ud.nextLayer < ud.allocLayers) layer = ud.nextLayer++;
        // X7 — the allocated depth is exhausted but the CEILING is not: double
        // the arrays and carry on. Disarmed, `allocLayers === capacity` so this
        // branch is unreachable and the next line is the pre-X7 behaviour.
        // A refused growth (allocation threw) falls through to passthrough
        // rather than losing the prop — same fail-soft rule as a full pool.
        else if (ud.nextLayer < ud.capacity && _growBucketLayers(b, ud.nextLayer + 1)) layer = ud.nextLayer++;
        else { _atlasStats.ptLayerFull++; passthrough.push(n); continue; } // layer pool full → unbatched (fail-soft)
        // LAYER-WRITE INVARIANT (2026-08-03): a layer index is RECYCLED, so a
        // skipped or failed write leaves the PREVIOUS surface's texels resident
        // and the prop renders someone else's texture. Every allocation below
        // either rewrites the layer in full or releases it — the same rule
        // `packNraLayer` already states for the nra array.
        if (ud.bc7) {
          // X6 — one `compressedTexSubImage3D` for THIS layer (block-aligned by
          // construction: every layer is `ceil(w/4)*ceil(h/4)*16` bytes and the
          // array's dims equal the payload's, enforced by the bucket key).
          const ok = writeBc7ArrayLayer(ud.diffArray, layer, {
            width: w,
            height: h,
            levels: [{ data: tex.mipmaps[0].data, width: w, height: h }],
          });
          if (ok) { _atlasStats.bc7Layers++; _bumpBc7Stat("atlasLayers"); }
          else {
            // A compressed layer cannot be cleared in place — release it and
            // let this node render unbatched.
            ud.freeLayers.push(layer);
            _atlasStats.ptLayerWriteFail++; passthrough.push(n); continue;
          }
        } else {
          const stride = w * h * 4;
          // Same two-source rule as `_texChannel` above: the texture's bytes
          // first, the wasm decode memo when they have been released.
          let src = img.data;
          if (!src) {
            const p = planeFor(mat, PLANE.ALBEDO, mat?.userData?.surfaceDid >>> 0);
            if (p) src = p.data;
          }
          if (src && src.length === stride) {
            ud.diffArray.image.data.set(src, layer * stride);
          } else {
            // Wrong-stride source (non-RGBA8 map, truncated decode): zero the
            // layer rather than inherit its previous tenant's pixels.
            ud.diffArray.image.data.fill(0, layer * stride, (layer + 1) * stride);
            _atlasStats.layerWriteZeroed++;
          }
          // 2026-08-01 — mark ONLY this layer dirty (terrain_batch.js:315
          // precedent). Without it, `needsUpdate = true` below re-uploads the
          // ENTIRE pre-allocated array (up to 128 layers × 2 arrays ≈ 16-32 MiB)
          // on every per-LB feed — the measured walk-stall texture-upload cost
          // (RESULTS-task12). With layerUpdates non-empty three emits one
          // texSubImage3D per touched layer instead.
          if (typeof ud.diffArray.addLayerUpdate === "function") ud.diffArray.addLayerUpdate(layer);
        }
        entry = { layer, refs: 1 };
        ud.layerOf.set(uuid, entry);
        touchedDiff.add(ud.diffArray);
        _atlasStats.layerAllocs++;
        _uniqueTexUuids.add(uuid);
        // X5 — pack the matching nra layer from THIS member's material. Only the
        // FIRST member of a deduped surface writes it, exactly like the diffuse
        // pixels above: same texture ⇒ same DID ⇒ same category ⇒ same
        // normalScale/roughness, so the first-writer choice carries no drift.
        if (ud.nraArray) {
          const full = packNraLayer(ud.nraArray, entry.layer, mat, w, h, _atlasStats);
          // Same single-layer dirty mark as the diffuse write above.
          if (typeof ud.nraArray.addLayerUpdate === "function") ud.nraArray.addLayerUpdate(entry.layer);
          touchedNra.add(ud.nraArray);
          // Phase-5 texchan roughness/AO attach asynchronously; if they were not
          // there yet, queue a re-pack rather than lose the relief for the session.
          // S3: with a seam-height field in hand the alpha channel never wants
          // the texchan AO, so only the roughness bake is worth waiting for.
          if (!mat.roughnessMap || (!heightTexForMaterial(mat) && !mat.aoMap)) {
            _nraPending.push({ ud, layer: entry.layer, mat, w, h, texUuid: uuid, tries: 0, full });
          }
        }
      }
      heldEntry = { ud, uuid, entry };
      const g = normalizeForMerge(n.geometry, entry.layer);
      if (!g) {
        if (--entry.refs <= 0) { ud.freeLayers.push(entry.layer); ud.layerOf.delete(uuid); }
        _atlasStats.ptNormFail++; passthrough.push(n); continue;
      }
      const vcount = g.attributes.position.count;
      let gid;
      try {
        gid = _addGeometryGrow(bm, g, vcount);
      } catch (_) {
        g.dispose?.();
        if (--entry.refs <= 0) { ud.freeLayers.push(entry.layer); ud.layerOf.delete(uuid); }
        _atlasStats.ptGeomFail++; passthrough.push(n); continue;
      }
      let iid;
      try {
        iid = _addInstanceGrow(bm, gid);
      } catch (_) {
        try { bm.deleteGeometry(gid); } catch (_2) {}
        g.dispose?.();
        if (--entry.refs <= 0) { ud.freeLayers.push(entry.layer); ud.layerOf.delete(uuid); }
        _atlasStats.ptInstFail++; passthrough.push(n); continue;
      }
      heldGeom = { bm, gid, vcount, bucketKey };
      n.updateMatrix();
      bm.setMatrixAt(iid, n.matrix); // world transform (node is staticsGroup-relative)
      ud.gidVerts.set(gid, vcount);
      ud.usedVerts += vcount; // grow the used-extent denominator for the optimize() trigger
      g.dispose?.(); // copied into the batch buffer; the clone is no longer needed
      const lbKey = _lbKeyOfId(n.userData?.landblockId);
      let list = _lbMembership.get(lbKey);
      if (!list) { list = []; _lbMembership.set(lbKey, list); }
      list.push({ bucketKey, gid, iid, texUuid: uuid }); // iid: Phase 9a park hide/show seam
      fedLbs.add(lbKey);
      // free the consumed source geometry's GPU buffer (mirrors the merge path).
      try { n.geometry?.dispose?.(); } catch (_) {}
      _atlasStats.atlased++;
      handled = true;
      heldEntry = null; // committed to _lbMembership — eviction owns it now
      heldGeom = null;
    } catch (e) {
      _atlasStats.ptError++;
      // Unwind whatever this node committed before the throw, then fall through
      // to passthrough below (fail-soft: the prop still renders, once).
      if (heldGeom) {
        _atlasStats.ptErrorUnwound++;
        try { heldGeom.bm.deleteGeometry(heldGeom.gid); } catch (_) {}
        try {
          const gud = heldGeom.bm.userData;
          if (gud?.gidVerts?.delete(heldGeom.gid)) gud.deadVerts += heldGeom.vcount;
          _dirtyBuckets.add(heldGeom.bucketKey);
        } catch (_) {}
      }
      if (heldEntry) {
        try {
          if (--heldEntry.entry.refs <= 0) {
            heldEntry.ud.freeLayers.push(heldEntry.entry.layer);
            heldEntry.ud.layerOf.delete(heldEntry.uuid);
          }
        } catch (_) {}
      }
    }
    // Every `continue` above pushes exactly once and leaves the loop body, so
    // this is the only other push — no membership scan needed (it was O(n^2)
    // across a ~5,400-node ring feed).
    if (!handled && n) passthrough.push(n);
  }
  for (const d of touchedDiff) d.needsUpdate = true; // batch the array re-upload once
  for (const d of touchedNra) d.needsUpdate = true;  // X5, same single re-upload
  for (const k of fedLbs) _atlasBakedLbs.add(k);
  // X5 — surface-dedup census, on the DEV flag only (never on the default path).
  if (statNraEnabled()) {
    let liveLayers = 0;
    for (const b of _buckets.values()) liveLayers += b.bm?.userData?.layerOf?.size || 0;
    // eslint-disable-next-line no-console
    console.info(
      `[static_atlas/nra] feed#${_atlasStats.feeds}: surfaceRefs=${_atlasStats.surfaceRefs} ` +
        `uniqueSurfacesEver=${_uniqueTexUuids.size} liveLayers=${liveLayers} ` +
        `(allocs=${_atlasStats.layerAllocs} hits=${_atlasStats.layerHits} recycles=${_atlasStats.layerRecycles}) ` +
        `nra[packed=${_atlasStats.nraLayersPacked} n=${_atlasStats.nraWithNormal} r=${_atlasStats.nraWithRough} ` +
        `ao=${_atlasStats.nraWithAo} resampled=${_atlasStats.nraResampled} repacked=${_atlasStats.nraRepacked} ` +
        `pending=${_nraPending.length}] buckets=${_buckets.size}`
    );
  }
  return { passthrough };
}

/**
 * Per-LB eviction hook (installed as scene3d._evictStaticAtlasForLb; called by
 * landblock_lru.evict). Excises every geometry this LB contributed from its
 * cross-LB bucket — same-frame, no rebuild, no orphan — decrefs/recycles its
 * layers, and unmarks the LB so a re-walk re-feeds it. The bucket BatchedMesh
 * itself is never removed (it spans the ring).
 */
export function evictStaticAtlasForLb(lbKey) {
  const key = (lbKey >>> 0);
  const list = _lbMembership.get(key);
  if (!list) return;
  for (const m of list) {
    const b = _buckets.get(m.bucketKey);
    if (!b) continue;
    const bm = b.bm;
    const ud = bm.userData;
    try { bm.deleteGeometry(m.gid); } catch (_) {} // cascades deleteInstance; same-frame drop
    const dead = ud.gidVerts.get(m.gid);
    if (dead) { ud.deadVerts += dead; ud.gidVerts.delete(m.gid); }
    const entry = ud.layerOf.get(m.texUuid);
    if (entry && --entry.refs <= 0) {
      ud.freeLayers.push(entry.layer);
      ud.layerOf.delete(m.texUuid);
    }
    _dirtyBuckets.add(m.bucketKey);
  }
  _lbMembership.delete(key);
  _atlasBakedLbs.delete(key);
}

/**
 * Phase 9a warm-park (W4 §3.2): hide an LB's atlas instances WITHOUT
 * deleting geometry — `setVisibleAt(iid, false)` per membership entry.
 * Membership, gids and texture-layer refs are all retained, and the bucket
 * is NOT marked dirty (nothing deleted → the optimize() compactor stays
 * untouched). Pre-iid membership entries (a live session that fed before
 * this landed) are skipped fail-soft — worst case those instances stay
 * visible while parked, never the reverse.
 */
export function parkStaticAtlasForLb(lbKey) {
  const list = _lbMembership.get(lbKey >>> 0);
  if (!list) return 0;
  let hidden = 0;
  for (const m of list) {
    if (m.iid == null) continue;
    const b = _buckets.get(m.bucketKey);
    if (!b) continue;
    try { b.bm.setVisibleAt(m.iid, false); hidden += 1; } catch (_) {}
  }
  return hidden;
}

/** Phase 9a: show a parked LB's atlas instances again (see parkStaticAtlasForLb). */
export function unparkStaticAtlasForLb(lbKey) {
  const list = _lbMembership.get(lbKey >>> 0);
  if (!list) return 0;
  let shown = 0;
  for (const m of list) {
    if (m.iid == null) continue;
    const b = _buckets.get(m.bucketKey);
    if (!b) continue;
    try { b.bm.setVisibleAt(m.iid, true); shown += 1; } catch (_) {}
  }
  return shown;
}

/**
 * X5 — re-pack nra layers whose Phase-5 texchan roughness/AO bake landed after
 * the atlas consumed the surface (materials.js `_resolveRough` is async). Runs
 * off the same ~10 Hz PVS tick as the compactor; the list is empty (and this is
 * never reached) unless ?statNra=on. Fail-soft: an entry whose layer has since
 * been recycled to a DIFFERENT surface is dropped, never re-written.
 */
function _drainNraPending() {
  const touched = new Set();
  for (let i = _nraPending.length - 1; i >= 0; i--) {
    const p = _nraPending[i];
    const cur = p.ud?.layerOf?.get(p.texUuid);
    if (!p.ud?.nraArray || !cur || cur.layer !== p.layer) { _nraPending.splice(i, 1); continue; }
    // S3 — with a seam-height field the alpha channel never takes the texchan
    // AO, so only the roughness bake is worth waiting for on those entries.
    const both = !!(p.mat?.roughnessMap && (heightTexForMaterial(p.mat) || p.mat?.aoMap));
    const expired = ++p.tries > _NRA_PENDING_TRIES;
    if (!both && !expired) continue;
    const any = !!(p.mat?.roughnessMap || p.mat?.aoMap);
    if (any) {
      // Scratch tally: the layer's normal was already counted at first pack;
      // only the newly-arrived rough/AO channels are added to the census.
      const s = { nraLayersPacked: 0, nraWithNormal: 0, nraWithRough: 0, nraWithAo: 0, nraResampled: 0, nraMetalDropped: 0 };
      packNraLayer(p.ud.nraArray, p.layer, p.mat, p.w, p.h, s);
      // Single-layer dirty mark — see the feed path; keeps the ~10 Hz repack
      // from re-uploading the whole nra array per drained entry.
      if (typeof p.ud.nraArray.addLayerUpdate === "function") p.ud.nraArray.addLayerUpdate(p.layer);
      _atlasStats.nraWithRough += s.nraWithRough;
      _atlasStats.nraWithAo += s.nraWithAo;
      _atlasStats.nraResampled += s.nraResampled;
      _atlasStats.nraRepacked++;
      touched.add(p.ud.nraArray);
    } else {
      _atlasStats.nraPendingDropped++;
    }
    _nraPending.splice(i, 1);
  }
  for (const t of touched) t.needsUpdate = true;
}

/**
 * Reclaim freed buffer space in fragmented buckets (deleteGeometry does NOT free
 * space — addGeometry appends; optimize() compacts). Driven LAZILY from the ~10 Hz
 * PVS tick, NOT the per-frame eviction tick. Only compacts a bucket once >30% of
 * its vertex buffer is dead. Compaction preserves geometryIds and carries the
 * aLayer attribute with its vertices, so live gids/instances stay valid.
 */
export function tickStatAtlasOptimize() {
  if (_nraPending.length > 0) _drainNraPending();
  if (_dirtyBuckets.size === 0) return;
  for (const bucketKey of _dirtyBuckets) {
    const b = _buckets.get(bucketKey);
    if (!b) continue;
    const bm = b.bm;
    const ud = bm.userData;
    // Trigger on dead / USED-EXTENT (live+dead actually appended), not / CAPACITY
    // (maxVerts, the pre-allocated/grown buffer size) — capacity over-counts the
    // denominator so a small-but-mostly-dead bucket would never compact. optimize()
    // compacts away the dead verts, so the used extent drops by deadVerts.
    if (ud.usedVerts > 0 && ud.deadVerts / ud.usedVerts > _ATLAS_OPTIMIZE_FRAC) {
      try { bm.optimize(); ud.usedVerts -= ud.deadVerts; ud.deadVerts = 0; } catch (_) {}
    }
  }
  _dirtyBuckets.clear();
}

// ===========================================================================
// BULK-MERGE PROJECTION (2026-08-06) — what would array-texture merging of the
// `?statBatchChunk` population actually cost and buy?
//
// TWO CORRECTIONS ARE BAKED INTO THIS FILE. Both were live measurements that
// overturned an estimate, and either one alone would have made the projection
// wrong by about a factor of two.
//
// CORRECTION 1 — COUNT DRAWN BUCKETS, NOT RESIDENT ONES.
// docs/2026-08-06-frame-cost-structure-measured.md §5a scaled an all-buckets
// figure (396 -> 86) down by the rendered fraction and quoted ~6.4 ms. That
// scaling is unsafe, and the region-width sweep says so directly:
//
//     regionDiv=3 (shipped)  376 buckets  452.2 draws  p50 23.4 ms
//     regionDiv=6            245 buckets  438.3 draws  p50 23.4 ms
//     regionDiv=12           142 buckets  437.9 draws  p50 24.5 ms
//
// 131 fewer buckets bought 14 fewer draws and 0.00 ms — because most buckets are
// frustum-culled and never submitted. Bucket COUNT and DRAWN-bucket count are
// decoupled. (It also kills "just use bigger regions": at div=12 a merged bucket
// straddles visible and invisible space and the frame got WORSE.) Re-measured
// over drawn buckets only, at Nanto: 376 resident, **129 drawn**, 5,063
// instances submitted; drawn keyed by (region, material VALUE) = 123, drawn
// keyed by (region, render STATE) = **37**. So the ceiling is 129 -> 37 drawn
// buckets at ~40 us each ≈ **3.68 ms**, not 6.4. Every projection below is
// therefore reported over BOTH populations, and `drawn` is the one that pays.
//
// CORRECTION 2 — A TEXTURE ARRAY CANNOT IGNORE TILE SIZE.
// That 37 comes from `bucketfrag.mjs`'s `stateOnlyKey`, which ignores the bound
// texture ENTIRELY, dimensions included. `texStorage3D` fixes (format, w, h,
// depth) at allocation — which is exactly why `_bucketKeyFor` carries `w x h`
// and a format field. The reachable key is
//
//     (region x TILE x state x format),  NOT  (region x state),
//
// and the tile axis has never been measured on the batched population. The only
// size distribution on record is the atlas's own residue
// (docs/RESULTS-atlas-occupancy-2026-08-05.json: 112 layers over ~15 distinct
// sizes, 16x16 through 2048x2048, top three sizes only 62%), and that sample is
// biased twice over — it is the surfaces the batcher did NOT take, and BC7's 4x
// upscale inflates its tail. The live drawn census says the state axis is nearly
// free (only **6** distinct render states across all drawn buckets, against 38
// distinct material values), so the tile axis is essentially the whole problem.
// Modelling the occupancy distribution onto ~14 surfaces per drawn region
// predicts ~75 drawn buckets, not 37 — i.e. the tile axis plausibly eats half
// the ceiling. That is the single number the design turns on.
//
// Hence `snapped`: the same projection with tile sizes SNAPPED to a small set of
// canonical tiers before keying. Because each layer holds exactly one surface
// addressed by normalized UV, resampling a surface to another tile size is a
// pure RESOLUTION change with no UV math anywhere (and `_liftChannel` above
// already resamples nra channels for precisely this reason). So the tier sets
// are a real, implementable dial, and `snapped` prices each setting in buckets
// AND in array-texture megabytes — the two halves of that trade.
//
// This computes everything FROM THE LIVE SCENE using the atlas's OWN key
// functions (`_stateKeyOf`, `_bucketKeyFor`, `_perLayerBytesFor`,
// `_layerCapacityFor`) rather than a transcription of them — the same rule
// `bc7AtlasShouldDefer` states for the regression suite. If a key function
// changes, this projection changes with it, because it IS that function.
//
// TWO STATE KEYS ARE REPORTED, AND THE GAP BETWEEN THEM IS THE POINT.
// `_stateKeyOf` encodes transparent / alphaTest / depthWrite / blending / wrap.
// It does NOT encode `side` (`makeArrayMaterial` hardcodes DoubleSide),
// `polygonOffset` (the `staticBias` / `floorBias` derived clones exist for
// nothing else — materials.js `staticBiasMaterials` / `floorBiasMaterials`),
// `emissive` (the Luminosity term the array material drops), or `castShadow` /
// `receiveShadow` (per-BUCKET flags a merge would have to flatten). Those
// omissions are survivable for the atlas's population — lone props, one per
// material — and are NOT survivable across a batched population, where
// flattening a depth bias is z-fighting and flattening sidedness is the
// `?perPolyCull` decision reversed. `strict` re-keys with all of them included:
// it is the floor a merge can reach WITHOUT changing the image, and the gap
// between it and `class` is a visual bill, not a saving.
//
// Read-only, allocation-light, never called by the app. Costs nothing unless a
// probe calls `window.__statMergeProjection()`.
// ===========================================================================

// Canonical tile tiers to price. Each entry is a SQUARE side length; a surface
// snaps to the tier nearest its geometric mean side in log space, so a 128x512
// lands with the 256s rather than being torn between two tiers. One tier
// collapses the axis entirely (the 37-bucket ceiling); three keeps most of the
// resolution and most of the fragmentation. The point is not to pick one here —
// it is to price all three off the same live population.
const _PROJ_TIER_SETS = [[512], [256, 1024], [128, 512, 2048]];

/**
 * The (w, h, bc7) a texture would be atlased at, or null when it cannot be
 * atlased at all. Mirrors the feed's own reads: `image.width/height` for RGBA8,
 * and `isBc7AtlasTexture` for compressed payloads (whose bytes live in
 * `mipmaps[0].data` while `image` carries only the dims).
 */
function _projTileOf(tex) {
  if (!tex) return null;
  const bc7 = isBc7AtlasTexture(tex);
  const img = tex.image;
  const w = (img && img.width) | 0;
  const h = (img && img.height) | 0;
  if (!w || !h) return null;
  return { w, h, bc7 };
}

/** Nearest canonical tier to this tile's geometric-mean side, in log space. */
function _projSnap(w, h, tiers) {
  const g = Math.sqrt(Math.max(1, w) * Math.max(1, h));
  let best = tiers[0];
  let bestD = Infinity;
  for (const t of tiers) {
    const d = Math.abs(Math.log(g / t));
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

/**
 * Everything `_stateKeyOf` deliberately leaves out, appended. See the section
 * header: each of these is a property the bucket material would have to flatten
 * across its members, and each has a live population that would notice.
 */
function _projStrictStateKeyOf(mat, bm) {
  const off = mat.polygonOffset
    ? `p${mat.polygonOffsetFactor}.${mat.polygonOffsetUnits}`
    : "p-";
  const emi = mat.emissive
    ? `e${(mat.emissive.getHex() >>> 0).toString(16)}.${Number(mat.emissiveIntensity ?? 1).toFixed(3)}`
    : "e-";
  return `${_stateKeyOf(mat)}|s${mat.side}|${off}|${emi}` +
    `|sh${bm.castShadow ? 1 : 0}${bm.receiveShadow ? 1 : 0}`;
}

/**
 * Is this bucket VISIBLE? Visibility up the parent chain plus a live instance.
 *
 * ⚠ THIS IS NOT THE SUBMITTED POPULATION, AND THE NAME `drawn` OVERSTATES IT.
 * Frustum culling is not re-derived here — three does it inside `render()` and
 * this probe runs between frames — so every resident bucket in a visible group
 * with instances passes. The 2026-08-06 live run is the proof: it reported
 * `drawnBuckets 342` against `batchBuckets 346`, i.e. the filter removed FOUR
 * buckets, while the independently measured submitted count for the same
 * population at the same place was 177 (`2026-08-06-frame-cost-structure-
 * measured.md` §2, `statics | static-batch-c`) and the region-width sweep put it
 * at 129 of 376. So `drawn` here is a RESIDENT-scale number wearing a
 * submitted-scale name, and every ms figure scaled off it is high by ~2x.
 *
 * That is the same members-vs-draws / resident-vs-submitted confusion that has
 * now produced three separate 2x overestimates on this workload (§0 of the
 * design doc records the first two). Rather than delete the field — the design
 * doc and its results JSON quote it — `armStatMergeSubmittedSampler` below adds
 * the honest population next to it, and callers should quote `submitted`.
 *
 * `visible === undefined` counts as visible so a headless fixture (a plain
 * object standing in for a BatchedMesh) is visible by default; the app always
 * sets it.
 */
function _projDrawn(bm) {
  if ((bm.userData?.instances | 0) <= 0) return false;
  for (let o = bm; o; o = o.parent) if (o.visible === false) return false;
  return true;
}

// Per-bucket submitted-frame counter stamped by the sampler below. Lives on
// userData so it dies with the BatchedMesh and can never outlive one.
const _PROJ_SUBMIT_FRAMES = "__projSubmitFrames";
const _PROJ_SUBMIT_ORIG = "__projSubmitOrig";

/**
 * Arm the SUBMITTED-bucket sampler: count, per bucket, the frames in which three
 * actually submitted it.
 *
 * WHY A SAMPLER AND NOT A FRUSTUM TEST. Re-deriving the cull here would be a
 * transcription of `WebGLRenderer.projectObject` — the exact mistake the
 * projection's header forbids ("computes everything FROM THE LIVE SCENE using
 * the atlas's OWN key functions rather than a transcription of them"). Three
 * calls `onBeforeRender` on an object if and only if it reaches
 * `renderObject`, i.e. exactly when it survives the cull and is drawn, so
 * wrapping it measures the real thing rather than a model of it. It is also the
 * same instrument `2026-08-06-frame-cost-structure-measured.md` used to attribute
 * per-draw µs, so the two censuses are directly comparable.
 *
 * BatchedMesh defines `onBeforeRender` on its PROTOTYPE (the multidraw rebuild).
 * We shadow it with an own property that increments and then delegates, and
 * `disarm` deletes the own property to restore the prototype lookup — never
 * assigning the captured function back, which would pin a stale method.
 *
 * Costs one function call per submitted bucket per frame while armed (~µs at
 * these counts, but non-zero): DISARM BEFORE QUOTING A FRAME TIME.
 *
 * Usage: `window.__statMergeArmSubmitted()`, let a couple of seconds of frames
 * run, then `window.__statMergeProjection()` — the `submitted` projection is
 * populated — then `window.__statMergeDisarmSubmitted()`.
 *
 * @param {object} [root] scene root; defaults to `window.liveScene3d.scene`
 * @returns {{armed:number}|{error:string}}
 */
export function armStatMergeSubmittedSampler(root) {
  const scene = root ||
    (typeof window !== "undefined" ? window.liveScene3d?.scene : null);
  if (!scene || typeof scene.traverse !== "function") {
    return { error: "no scene — pass a root or wait for window.liveScene3d" };
  }
  let armed = 0;
  scene.traverse((o) => {
    if (!o || !o.isBatchedMesh) return;
    const ud = o.userData;
    if (!ud || (!ud.__staticBatchCrossLb && !ud.__statAtlasCrossLb)) return;
    ud[_PROJ_SUBMIT_FRAMES] = 0; // re-arming resets the count
    if (Object.prototype.hasOwnProperty.call(o, "onBeforeRender")) { armed += 1; return; }
    ud[_PROJ_SUBMIT_ORIG] = o.onBeforeRender; // the prototype's multidraw rebuild
    o.onBeforeRender = function (...args) {
      const u = this.userData;
      u[_PROJ_SUBMIT_FRAMES] = (u[_PROJ_SUBMIT_FRAMES] | 0) + 1;
      const orig = u[_PROJ_SUBMIT_ORIG];
      if (typeof orig === "function") return orig.apply(this, args);
      return undefined;
    };
    armed += 1;
  });
  return { armed };
}

/**
 * Disarm the sampler: drop the own `onBeforeRender` so the prototype's runs
 * again. Counts are LEFT IN PLACE so a projection can still be read after
 * disarming (which is the order a measurement wants: disarm, then quote).
 * @param {object} [root] @returns {{disarmed:number}|{error:string}}
 */
export function disarmStatMergeSubmittedSampler(root) {
  const scene = root ||
    (typeof window !== "undefined" ? window.liveScene3d?.scene : null);
  if (!scene || typeof scene.traverse !== "function") {
    return { error: "no scene — pass a root or wait for window.liveScene3d" };
  }
  let disarmed = 0;
  scene.traverse((o) => {
    if (!o || !o.isBatchedMesh) return;
    if (!Object.prototype.hasOwnProperty.call(o, "onBeforeRender")) return;
    delete o.onBeforeRender;
    if (o.userData) delete o.userData[_PROJ_SUBMIT_ORIG];
    disarmed += 1;
  });
  return { disarmed };
}

/** Did this bucket reach `renderObject` at least once since the sampler armed? */
function _projSubmitted(bm) {
  return ((bm.userData?.[_PROJ_SUBMIT_FRAMES] | 0) > 0);
}

/**
 * Project the bucket count and texture-array memory of merging the cross-LB
 * statics batcher's live buckets into array-texture buckets.
 *
 * `root` defaults to `window.liveScene3d.scene`. Counts only buckets carrying
 * `__staticBatchCrossLb` (static_batch_x.js `_getOrCreateBucket`) — the atlas's
 * own `__statAtlasCrossLb` buckets are already merged and are reported
 * separately so the two populations are never conflated.
 *
 * Returns `{ all, drawn, submitted, deformed }` projections plus the shared
 * class/layer census. `submitted` is the one that pays — and it is populated
 * only after `armStatMergeSubmittedSampler` has seen frames; `drawn` is a
 * resident-scale over-count kept for continuity with the 2026-08-06 results
 * JSON (see `_projDrawn`).
 *
 * COUNTING UNIT, stated because it has been misread: every count here is
 * BUCKETS (one per BatchedMesh), never members or instances. `blocked.deformed`
 * is 193 BUCKETS in the 2026-08-06 run, not 193 props — instance totals are
 * reported separately as `instances` / `drawnInstances`.
 */
export function projectStatMergeBuckets(root) {
  const scene = root ||
    (typeof window !== "undefined" ? window.liveScene3d?.scene : null);
  if (!scene || typeof scene.traverse !== "function") {
    return { error: "no scene — pass a root or wait for window.liveScene3d" };
  }

  const recs = [];
  // The `deformation.` residue, projected SEPARATELY rather than discarded. A
  // count alone cannot price it: 193 blocked buckets are worth a lot if they
  // collapse to a handful and nothing if they are already near their floor, and
  // that collapse factor is the whole question. These rows are keyed exactly
  // like `recs`, so `deformed.*.buckets.today` minus `regionClass` IS the saving
  // an un-blocking would buy, in the same units as the main projection.
  const defRecs = [];
  const defSetKeys = new Map(); // __vfxSetKey -> buckets carrying it
  let atlasBuckets = 0;
  let batchBuckets = 0;
  let drawnBuckets = 0;
  let submittedBuckets = 0;
  let sampled = 0;          // buckets carrying a sampler stamp (armed or not)
  let instances = 0;
  let drawnInstances = 0;
  let submittedInstances = 0;
  // BUCKETS that cannot merge at all, by reason — one count per BatchedMesh,
  // never per member. Nothing is subtracted for them — a blocked bucket keeps
  // its own draw — so they are the residue the design must still carry, and they
  // are what makes any projection a floor rather than a promise.
  const blocked = { noMap: 0, noTile: 0, deformed: 0, nonStandard: 0 };
  const blockedDrawn = { noMap: 0, noTile: 0, deformed: 0, nonStandard: 0 };
  const blockedSubmitted = { noMap: 0, noTile: 0, deformed: 0, nonStandard: 0 };

  scene.traverse((o) => {
    if (!o || !o.isBatchedMesh) return;
    const ud = o.userData || {};
    if (ud.__statAtlasCrossLb) { atlasBuckets += 1; return; }
    if (!ud.__staticBatchCrossLb) return;
    batchBuckets += 1;
    instances += ud.instances | 0;
    const drawn = _projDrawn(o);
    if (drawn) { drawnBuckets += 1; drawnInstances += ud.instances | 0; }
    if (ud[_PROJ_SUBMIT_FRAMES] !== undefined) sampled += 1;
    const submitted = _projSubmitted(o);
    if (submitted) { submittedBuckets += 1; submittedInstances += ud.instances | 0; }
    const bump = (why) => {
      blocked[why] += 1;
      if (drawn) blockedDrawn[why] += 1;
      if (submitted) blockedSubmitted[why] += 1;
    };
    const mat = o.material;
    if (!mat) { bump("noMap"); return; }
    // Build the row a merge would key on, or null when a later gate rejects it.
    // Shared by the mergeable and the deformed populations so the residue is
    // priced with the SAME key functions — a residue scored by a second,
    // hand-rolled key would be exactly the transcription this file forbids.
    const rowOf = (why) => {
      if (!mat.isMeshStandardMaterial) { if (why) why("nonStandard"); return null; }
      if (!mat.map) { if (why) why("noMap"); return null; }
      const tile = _projTileOf(mat.map);
      if (!tile) { if (why) why("noTile"); return null; }
      return {
        region: ud.regionKey ?? "?",
        matId: mat.id,
        texUuid: mat.map.uuid,
        w: tile.w, h: tile.h, bc7: tile.bc7,
        stateKey: _stateKeyOf(mat),
        strictKey: _projStrictStateKeyOf(mat, o),
        drawn, submitted,
      };
    };
    // The gates that reject a bucket OUTRIGHT rather than fragmenting it.
    // `deformation.` is the MECH-B wind-sway variant the atlas already refuses
    // (`ptDeformed`, ~:1464): an array material replaces the member's material
    // wholesale and would silently freeze the sway. Note what this bucket IS,
    // though — a BatchedMesh already rendering a windSwayGpu variant, i.e. live
    // proof that the sway survives batching (per_instance.js carries a
    // `USE_BATCHING` branch and three applies `batchingMatrix` in
    // `project_vertex`, AFTER the `begin_vertex` seam the shear writes). The
    // block is about MATERIAL SUBSTITUTION by the array merge, not about
    // batching, which is why the row is still scored below.
    if (typeof mat.userData?.__vfxSetKey === "string" &&
        mat.userData.__vfxSetKey.includes("deformation.")) {
      bump("deformed");
      // WHICH deformation sets, not just how many. `deformation.` also matches
      // `deformation.tipFlex`, and the cheapest safe merge (key the bucket by
      // __vfxSetKey) is only cheap while the set count is small — one set splits
      // each class in two, five sets split it in six.
      const k = mat.userData.__vfxSetKey;
      defSetKeys.set(k, (defSetKeys.get(k) | 0) + 1);
      const r = rowOf(null); // no second bump — the bucket is already counted once
      if (r) defRecs.push(r);
      return;
    }
    const rec = rowOf(bump);
    if (rec) recs.push(rec);
  });

  // -------------------------------------------------------------------------
  // Projections over one population (all buckets, or the drawn subset).
  // -------------------------------------------------------------------------
  function project(rows) {
    const today = new Set();
    const regionClass = new Set();
    const regionStrict = new Set();
    const regionState = new Set();
    const regions = new Set();
    const tiles = new Set();
    const states = new Set();
    const values = new Set();
    const classKeys = new Map(); // classKey -> { w, h, bc7, texUuids, regions }
    for (const r of rows) {
      regions.add(r.region);
      states.add(r.stateKey);
      values.add(`${r.texUuid}|${r.stateKey}`);
      tiles.add(`${r.w}x${r.h}${r.bc7 ? "f7" : "f8"}`);
      today.add(`${r.region}#${r.matId}`);
      const classKey = _bucketKeyFor(r.w, r.h, r.stateKey, r.bc7);
      regionClass.add(`${r.region}#${classKey}`);
      regionStrict.add(`${r.region}#${_bucketKeyFor(r.w, r.h, r.strictKey, r.bc7)}`);
      regionState.add(`${r.region}#${r.stateKey}`);
      let c = classKeys.get(classKey);
      if (!c) { c = { w: r.w, h: r.h, bc7: r.bc7, texUuids: new Set(), regions: new Set() }; classKeys.set(classKey, c); }
      c.texUuids.add(r.texUuid);
      c.regions.add(r.region);
    }

    // Texture-array memory, both scopings. THE number that decides the design's
    // shape: the atlas's arrays are GLOBAL and refcount a layer once per
    // distinct surface, so `sharedMB` is what a global layer pool costs.
    // Making the ARRAYS region-scoped instead (the naive reading of "merge
    // within a region") re-cuts a layer per region the surface appears in —
    // `regionalMB` — and that multiplier is the whole reason the design keeps
    // arrays global while keeping the BatchedMeshes regional.
    let sharedLayers = 0, regionLayers = 0, sharedBytes = 0, regionBytes = 0, capped = 0;
    const classes = [];
    for (const [key, c] of classKeys) {
      const per = _perLayerBytesFor(c.w, c.h, c.bc7);
      const cap = _layerCapacityFor(c.w, c.h, c.bc7);
      sharedLayers += c.texUuids.size;
      sharedBytes += c.texUuids.size * per;
      // Upper bound: every surface in every region the class touches. The true
      // figure is between this and the shared one; the UPPER bound is the one
      // that decides feasibility, so it is the one reported.
      regionLayers += c.texUuids.size * c.regions.size;
      regionBytes += c.texUuids.size * c.regions.size * per;
      if (c.texUuids.size > cap) capped += 1;
      classes.push({ key, w: c.w, h: c.h, bc7: c.bc7, surfaces: c.texUuids.size,
        regions: c.regions.size, capacity: cap, perLayerKiB: Math.round(per / 1024) });
    }
    classes.sort((a, b) => b.surfaces - a.surfaces);

    // The tile axis, priced. Snapping to canonical tiers collapses it toward
    // `regionState` at the cost of resampling every surface — and of memory,
    // because a small tile snapped UP costs its tier's full layer.
    const snapped = _PROJ_TIER_SETS.map((tiers) => {
      const rc = new Set(), rs = new Set();
      const pools = new Map(); // snapKey -> Set<texUuid>
      for (const r of rows) {
        const t = _projSnap(r.w, r.h, tiers);
        const ck = _bucketKeyFor(t, t, r.stateKey, r.bc7);
        rc.add(`${r.region}#${ck}`);
        rs.add(`${r.region}#${_bucketKeyFor(t, t, r.strictKey, r.bc7)}`);
        let p = pools.get(ck);
        if (!p) { p = { t, bc7: r.bc7, uuids: new Set() }; pools.set(ck, p); }
        p.uuids.add(r.texUuid);
      }
      let bytes = 0, layers = 0;
      for (const p of pools.values()) {
        layers += p.uuids.size;
        bytes += p.uuids.size * _perLayerBytesFor(p.t, p.t, p.bc7);
      }
      return { tiers, regionClass: rc.size, regionStrict: rs.size,
        pools: pools.size, layers, sharedMB: +(bytes / (1024 * 1024)).toFixed(1) };
    });

    const mb = (b) => +(b / (1024 * 1024)).toFixed(1);
    return {
      buckets: {
        today: today.size,
        regionClass: regionClass.size,   // (region, tile, state, format) — the design
        regionStrict: regionStrict.size, // + side/polygonOffset/emissive/shadow
        regionState: regionState.size,   // (region, state) — the idealised ceiling
        globalClasses: classKeys.size,   // distinct array-texture pools needed
      },
      regions: regions.size,
      distinctTiles: tiles.size,
      distinctStates: states.size,
      distinctValues: values.size,
      layers: { shared: sharedLayers, regional: regionLayers,
        sharedMB: mb(sharedBytes), regionalMB: mb(regionBytes), classesOverCapacity: capped },
      snapped,
      classes,
    };
  }

  return {
    // Populations. `all.buckets.today` must equal `batchBuckets` minus the
    // blocked ones; a divergence means a bucket lost its `regionKey`.
    batchBuckets, drawnBuckets, atlasBuckets, instances, drawnInstances,
    blocked, blockedDrawn,
    // Every count above and below is BUCKETS unless its name says instances.
    // Stated in the payload because the field names alone have been read as
    // members three times, at a cost of two 2x overestimates.
    units: { buckets: "BatchedMesh nodes", blocked: "buckets", instances: "instances" },
    all: project(recs),
    // Resident-scale, despite the name — `_projDrawn` cannot see the frustum.
    // Kept because the 2026-08-06 results JSON quotes it. Do not price off it.
    drawn: project(recs.filter((r) => r.drawn)),
    // THE ONE THAT PAYS. Null until `armStatMergeSubmittedSampler` has seen
    // frames — an absent measurement must read as absent, never as zero.
    submittedSampled: sampled > 0,
    submittedBuckets, submittedInstances, blockedSubmitted,
    submitted: sampled > 0 ? project(recs.filter((r) => r.submitted)) : null,
    // The `deformation.` residue, priced in the same units by the same keys.
    // `today - regionClass` on each population is what un-blocking would buy.
    deformed: {
      buckets: blocked.deformed,
      drawnBuckets: blockedDrawn.deformed,
      submittedBuckets: blockedSubmitted.deformed,
      setKeys: Object.fromEntries(defSetKeys),
      all: project(defRecs),
      drawn: project(defRecs.filter((r) => r.drawn)),
      submitted: sampled > 0 ? project(defRecs.filter((r) => r.submitted)) : null,
    },
  };
}

if (typeof window !== "undefined") {
  window.__statMergeProjection = (root) => {
    try { return projectStatMergeBuckets(root); } catch (e) { return { error: String(e?.message ?? e) }; }
  };
  // Arm → let frames run → project → disarm. See armStatMergeSubmittedSampler.
  window.__statMergeArmSubmitted = (root) => {
    try { return armStatMergeSubmittedSampler(root); } catch (e) { return { error: String(e?.message ?? e) }; }
  };
  window.__statMergeDisarmSubmitted = (root) => {
    try { return disarmStatMergeSubmittedSampler(root); } catch (e) { return { error: String(e?.message ?? e) }; }
  };
}

// ===========================================================================
// Test seams (X7). The module memoizes its flags off `window.location` and
// keeps all bucket state module-global, so a node regression run needs a way to
// re-arm both between cases. Nothing in the app calls these.
// ===========================================================================

/**
 * Reset the cross-LB bucket state and (optionally) force the flag memos.
 * `opts.grow` / `opts.nra` accept a boolean to pin `statAtlasGrowEnabled()` /
 * `statNraEnabled()`; omitted leaves the memo cleared, so the next call
 * re-resolves from the URL (i.e. the armed defaults under node).
 */
export function _resetStatAtlasForTest(opts = {}) {
  for (const b of _buckets.values()) {
    const ud = b.bm?.userData;
    try { ud?.diffArray?.dispose?.(); } catch (_) {}
    try { ud?.nraArray?.dispose?.(); } catch (_) {}
  }
  _buckets.clear();
  _lbMembership.clear();
  _atlasBakedLbs.clear();
  _dirtyBuckets.clear();
  _nraPending.length = 0;
  _uniqueTexUuids.clear();
  for (const k of Object.keys(_atlasStats)) _atlasStats[k] = 0;
  _growFlag = typeof opts.grow === "boolean" ? opts.grow : undefined;
  _nraFlag = typeof opts.nra === "boolean" ? opts.nra : undefined;
}

/** The live bucket map (bucketKey -> { bm, w, h, stateKey, bc7, arrays }). */
export function _statAtlasBucketsForTest() {
  return _buckets;
}

/** The module tally `window.__atlasStats()` wraps (window-only in the app). */
export function _statAtlasStatsForTest() {
  return _atlasStats;
}
