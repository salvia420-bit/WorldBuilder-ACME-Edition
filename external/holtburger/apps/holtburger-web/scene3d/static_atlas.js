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
// always rendered metalness 0) and POM/height.
//
// LRU-safe: bucketed PER landblock; each merged mesh carries userData.landblockId,
// so the existing per-LB eviction (which scans staticsGroup.children by
// landblockId) tears it down identically to the singletons it replaces.

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

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
/** X5 — `?statNra=on` adds the parallel normal/roughness/AO texture array to the
 *  cross-LB statics atlas (see the header). **DEFAULT-OFF** during development:
 *  the reader is an EXACT-MATCH opt-in (`on`/`1`/`true`/`yes`), never the
 *  `!== "off"` idiom (url-flags.md's flag-default footgun — that reads ON when
 *  the param is absent). Flag-absent ⇒ every byte of the v1 path is untouched:
 *  no second array is allocated, no shader chunk is replaced, and the material's
 *  `customProgramCacheKey` keeps its v1 value. */
export function statNraEnabled() {
  if (_nraFlag !== undefined) return _nraFlag;
  let on = false; // DEFAULT-OFF (X5 development gate)
  try {
    if (typeof window !== "undefined" && window.location?.search) {
      const v = new URLSearchParams(window.location.search).get("statNra");
      if (v != null) {
        const s = String(v).toLowerCase();
        on = s === "on" || s === "1" || s === "true" || s === "yes";
      }
    }
  } catch (_) { on = false; }
  return (_nraFlag = on);
}

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
function _texChannel(tex, ch, w, h) {
  const img = tex && tex.image;
  const data = img && img.data;
  const sw = img && (img.width | 0);
  const sh = img && (img.height | 0);
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

  const nR = _texChannel(mat.normalMap, 0, w, h);
  const nG = nR ? _texChannel(mat.normalMap, 1, w, h) : null;
  const rgh = _texChannel(mat.roughnessMap, 1, w, h); // three reads roughnessMap.g
  const ao = _texChannel(mat.aoMap, 0, w, h);         // three reads aoMap.r (RedFormat)

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
    dst[o + 3] = ao ? ao.px[i] : _NRA_FLAT_A;
  }

  if (stats) {
    stats.nraLayersPacked++;
    if (nR && nG) stats.nraWithNormal++;
    if (rgh) stats.nraWithRough++;
    if (ao) stats.nraWithAo++;
    if ((nR && nR.resampled) || (rgh && rgh.resampled) || (ao && ao.resampled)) stats.nraResampled++;
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
function makeArrayMaterial(diffArray, stateKey, nraArray) {
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
  // ONE sampling convention for every array in the bucket (diffuse + nra): the
  // wrap bucket's fract()+textureGrad, the clamp bucket's plain texture(). They
  // MUST agree or the relief would slide off its albedo on tiling surfaces.
  const sampleArray = (name) =>
    wrapBucket
      ? `textureGrad( ${name}, vec3( fract( vMapUv ), vLayer ), dFdx( vMapUv ), dFdy( vMapUv ) )`
      : `texture( ${name}, vec3( vMapUv, vLayer ) )`;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uDiffuseArray = { value: diffArray };
    if (nraArray) shader.uniforms.uNraArray = { value: nraArray };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aLayer;\nvarying float vLayer;")
      .replace("#include <uv_vertex>", "#include <uv_vertex>\n\tvLayer = aLayer;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nprecision highp sampler2DArray;\nuniform sampler2DArray uDiffuseArray;\nvarying float vLayer;" +
          // X5 — one global texel, sampled ONCE in <map_fragment> (the first of
          // our injected sites in main()) and reused by the roughness, normal
          // and AO sites further down. GLSL ES 3.0 forbids a non-constant
          // initializer on a global, so it is declared here and assigned there.
          (nraArray ? "\nuniform sampler2DArray uNraArray;\nvec4 _statNraTexel;" : "")
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
          nraArray ? `\t_statNraTexel = ${sampleArray("uNraArray")};` : null,
          "#ifdef USE_MAP",
          `\tvec4 sampledDiffuseColor = ${sampleArray("uDiffuseArray")};`,
          "\tdiffuseColor *= sampledDiffuseColor;",
          "#endif",
        ].filter(Boolean).join("\n")
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
        // A channel = texchan cavity AO at the singleton path's 0.6 intensity
        // (materials.js `_applyRough`). Body mirrors three's own aomap_fragment
        // minus the clearcoat/sheen branches this material can never have.
        .replace(
          "#include <aomap_fragment>",
          [
            "\tfloat ambientOcclusion = ( _statNraTexel.a - 1.0 ) * 0.6 + 1.0;",
            "\treflectedLight.indirectDiffuse *= ambientOcclusion;",
            "\t#if defined( USE_ENVMAP ) && defined( STANDARD )",
            "\t\tfloat dotNV = saturate( dot( geometryNormal, geometryViewDir ) );",
            "\t\treflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );",
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
    (wrapBucket ? "statAtlasArrayMatV3w" : "statAtlasArrayMatV3c") + (nraArray ? "nra" : "");
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

// Per-bucket DataArrayTexture VRAM budget → layer capacity. Pre-allocated fixed
// at creation (a DataArrayTexture cannot grow its layer count in place). The
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
  // X5 nra pack tally (all zero unless ?statNra=on).
  nraLayersPacked: 0, nraWithNormal: 0, nraWithRough: 0, nraWithAo: 0,
  nraResampled: 0, nraMetalDropped: 0, nraRepacked: 0, nraPendingDropped: 0 };
const _uniqueTexUuids = new Set(); // every distinct surface texture ever atlased
if (typeof window !== "undefined") {
  window.__atlasStats = () => {
    let liveLayers = 0;
    for (const b of _buckets.values()) liveLayers += b.bm?.userData?.layerOf?.size || 0;
    return {
      ..._atlasStats,
      // X5 — the before/after dedup headline. `surfaceRefs` in, `uniqueSurfacesEver`
      // distinct textures out; `liveLayers` is what is resident right now.
      uniqueSurfacesEver: _uniqueTexUuids.size,
      liveLayers,
      dedupRatio: _atlasStats.surfaceRefs > 0
        ? +(_atlasStats.surfaceRefs / Math.max(1, _uniqueTexUuids.size)).toFixed(2) : 0,
      nraEnabled: statNraEnabled(),
      nraPending: _nraPending.length,
      bucketCount: _buckets.size,
      atlasBakedLbs: _atlasBakedLbs.size,
      buckets: [..._buckets.entries()].map(([k, b]) => {
        const ud = (b.bm && b.bm.userData) || {};
        return { key: k, w: b.w, h: b.h, stateKey: b.stateKey, nextLayer: ud.nextLayer ?? null,
          capacity: ud.capacity ?? null, layersUsed: ud.layerOf ? ud.layerOf.size : null,
          nra: !!ud.nraArray,
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

function _bucketKeyFor(w, h, stateKey) {
  return `${w}x${h}|${stateKey}`;
}

function _layerCapacityFor(w, h) {
  // X5: with the nra pack live a layer costs TWICE the bytes (diffuse + nra),
  // and the ceiling halves — see _ATLAS_NRA_MAX_LAYERS. Flag-off arithmetic is
  // unchanged (arrays === 1, ceiling === _ATLAS_MAX_LAYERS).
  const arrays = statNraEnabled() ? 2 : 1;
  const per = Math.max(1, (w | 0) * (h | 0) * 4 * arrays);
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

function _getOrCreateBucket(bucketKey, w, h, stateKey, scene3d) {
  let b = _buckets.get(bucketKey);
  if (b) return b;
  const capacity = _layerCapacityFor(w, h);
  const diffArray = buildDiffuseArray([], w, h, capacity);
  // X5 — parallel nra array at the SAME capacity as the diffuse array, so the
  // layer index addresses both (one `aLayer`, one `vMapUv`). `_layerCapacityFor`
  // has already halved that capacity for the nra-on case, so the PAIR fits the
  // same per-bucket byte budget the albedo-only arm used (the un-halved first cut
  // OOM-killed the renderer — see _ATLAS_NRA_MAX_LAYERS).
  const nraArray = statNraEnabled() ? buildNraArray(w, h, capacity) : null;
  const material = makeArrayMaterial(diffArray, stateKey, nraArray);
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
    nraArray,            // X5: null unless ?statNra=on
    layerOf: new Map(),  // texUuid -> { layer, refs }
    freeLayers: [],      // recycled layer indices (pixels overwritten on reuse)
    capacity,
    nextLayer: 0,
    maxVerts: _ATLAS_INIT_VERTS,
    maxInst: _ATLAS_INIT_INST,
    deadVerts: 0,        // vertices in deleted geometries awaiting optimize()
    usedVerts: 0,        // total live+dead vertices ever appended (the buffer's used extent;
                         //   deleteGeometry does NOT compact, so this only drops on optimize())
    gidVerts: new Map(), // gid -> vertexCount (to account dead space on delete)
  };
  bm.name = `stat-atlas-x-${bucketKey}`;
  b = { bm, w, h, stateKey };
  _buckets.set(bucketKey, b);
  try { scene3d?.staticsGroup?.add(bm); } catch (_) { /* fail-soft */ }
  return b;
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
    _atlasStats.nodesIn++;
    try {
      const mat = n && n.material;
      const tex = mat && mat.map;
      const img = tex && tex.image;
      if (!n || !n.isMesh || n.isBatchedMesh || n.isLOD || !n.geometry || !n.geometry.attributes?.uv || !tex || !img || !img.data || n.userData?.__staticBatch) {
        _atlasStats.ptFiltered++; passthrough.push(n); continue; // ?staticBatch nodes already batched — never re-feed
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
      const bucketKey = _bucketKeyFor(w, h, stateKey);
      const b = _getOrCreateBucket(bucketKey, w, h, stateKey, scene3d);
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
        else if (ud.nextLayer < ud.capacity) layer = ud.nextLayer++;
        else { _atlasStats.ptLayerFull++; passthrough.push(n); continue; } // layer pool full → unbatched (fail-soft)
        const stride = w * h * 4;
        const src = img.data;
        if (src && src.length === stride) ud.diffArray.image.data.set(src, layer * stride);
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
          touchedNra.add(ud.nraArray);
          // Phase-5 texchan roughness/AO attach asynchronously; if they were not
          // there yet, queue a re-pack rather than lose the relief for the session.
          if (!mat.roughnessMap || !mat.aoMap) {
            _nraPending.push({ ud, layer: entry.layer, mat, w, h, texUuid: uuid, tries: 0, full });
          }
        }
      }
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
    } catch (e) {
      _atlasStats.ptError++;
      // per-node fail-soft: fall through to passthrough below.
    }
    if (!handled && n && !passthrough.includes(n)) passthrough.push(n);
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
    const both = !!(p.mat?.roughnessMap && p.mat?.aoMap);
    const expired = ++p.tries > _NRA_PENDING_TRIES;
    if (!both && !expired) continue;
    const any = !!(p.mat?.roughnessMap || p.mat?.aoMap);
    if (any) {
      // Scratch tally: the layer's normal was already counted at first pack;
      // only the newly-arrived rough/AO channels are added to the census.
      const s = { nraLayersPacked: 0, nraWithNormal: 0, nraWithRough: 0, nraWithAo: 0, nraResampled: 0, nraMetalDropped: 0 };
      packNraLayer(p.ud.nraArray, p.layer, p.mat, p.w, p.h, s);
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
