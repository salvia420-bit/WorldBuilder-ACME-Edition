// scene3d/gpu_batch/layer_state.js — R3-3 K1: the layer state table, retail
// `D3DPolyRender::SetSurface` (acclient.c:454385-454565) as DATA
// (docs/2026-10-29-round3-gpu-driven.md §R3-3 item 2).
//
// Today every Surface (0x08) becomes one three.js material, and its render
// state is decoded by `applySurfaceRenderState` (materials.js — the single
// decoder that `MaterialCache._materialFromFlags` and entities.js
// `_applyPalettedSurfaceRenderState` both delegate to by default). A batch
// draw samples many surfaces through ONE class material, so the per-surface
// part of that state has to travel as data: one row per surface slot in an
// RGBA32F table, fetched in the vertex shader and handed to the fragment
// shader as flat varyings.
//
// TWO PRODUCERS, ONE ROW FORMAT:
//   - `layerStateFromSurface(surface, env, ladder)` — the decoder as data:
//     the Surface type bits + the T/L/D floats + the texture's palettedness
//     -> the state the decoder would write. No material involved (R3-4 needs
//     it for palette composites that never become materials). Proven equal to
//     the real ladders on every Surface in the retail client_portal.dat
//     (tests/gpu_batch_state_table.test.mjs).
//   - `layerStateFromMaterial(mat)` — the same fields read back off a built
//     material (what R3-3's anim-scenery consumer uses: the material three
//     would have drawn is the truth there, mutations included).
//
// ROW LAYOUT (LAYER_STATE_TEXELS = 4 vec4, std430 vec4 rows):
//   texel 0  (diffuse.r, diffuse.g, diffuse.b, opacity)       three: `diffuse`, `opacity`
//   texel 1  (roughness, metalness, normalScale.x, normalScale.y)
//   texel 2  (alphaRef, map layer, luminosity, flags)
//   texel 3  (normal-map layer, 0, 0, 0)
// `flags` is a small integer in a float (exact below 2^24): LS_FLAG bits plus
// the blend code in bits 8-11. `alphaRef` is the alpha-test reference the
// material would carry: the ClipMap per-format ref (paletted 100/255, DDS
// 200/255; acclient.c:45764-45765) or the legacy 0.5, and 0 for "no test".
// Retail's alpha-test compare is GREATEREQUAL; three discards `a < ref`, so
// the same ref reproduces it. opacity = 1 - translucency (acclient.c:454523).
// luminosity = the flat emissive scale three would get (min(2, L), only for
// L > 0; the emissive colour is white).
//
// The per-surface PBR scalars (roughness, metalness, normalScale) are not
// SetSurface state; they ride the same row because they are per-surface
// uniforms today (category defaults, materials.js CATEGORY_MATERIAL_DEFAULTS)
// and a class material must reproduce them exactly.

import * as THREE from "three";

export const LAYER_STATE_TEXELS = 4;
export const LAYER_STATE_FLOATS = LAYER_STATE_TEXELS * 4;

// Surface (0x08) type bits — ACE SurfaceType.cs / materials.js SURFACE_TYPE.
export const SURFACE_BITS = Object.freeze({
  Base1Solid: 0x1, Base1Image: 0x2, Base1ClipMap: 0x4, Translucent: 0x10,
  Diffuse: 0x20, Luminous: 0x40, Alpha: 0x100, InvAlpha: 0x200, Additive: 0x10000,
  Detail: 0x20000, Gouraud: 0x10000000, Stippled: 0x40000000, Perspective: 0x80000000,
});

export const CLIPMAP_REF_PALETTED = 100 / 255; // s_256AlphaTestRef
export const CLIPMAP_REF_DDS = 200 / 255;      // s_ddsAlphaTestRef
export const CLIPMAP_REF_LEGACY = 0.5;

export const LS_FLAG = Object.freeze({
  TRANSPARENT: 1, DEPTH_WRITE: 2, FOG_OFF: 4, TWO_SIDED: 8, ALPHA_TEST: 16,
  LUMINOUS: 32, SINGLE_PASS: 64, EMISSIVE_MAP: 128,
});

/** Blend function as data (bits 8-11 of the flags). */
export const BLEND = Object.freeze({
  NONE: 0,                  // opaque: blending off (transparent false)
  NORMAL: 1,                // THREE.NormalBlending: SRCALPHA / INVSRCALPHA
  ADDITIVE: 2,              // THREE.AdditiveBlending: SRCALPHA / ONE (three's ONE/ONE stand-in)
  SRCALPHA_ONE: 3,          // Custom SRCALPHA / ONE (Alpha+Additive, acclient.c:454474)
  ONE_INVSRCALPHA: 4,       // Custom ONE / INVSRCALPHA (ClipMap blend arm, :454547)
  INVSRCALPHA_ONE: 5,       // Custom INVSRCALPHA / ONE (parityV2 InvAlpha+Additive)
  INVSRCALPHA_SRCALPHA: 6,  // Custom INVSRCALPHA / SRCALPHA (parityV2 InvAlpha)
});

/** Draw classes the kit builds class materials for. */
export const BLEND_CLASS = Object.freeze({ OPAQUE: "opaque", ALPHA_TEST: "alphaTest", TRANSLUCENT: "translucent", ADDITIVE: "additive" });

/**
 * The decoder's environment: the URL flags `applySurfaceRenderState` reads
 * (all read through materials.js at call time; passed in here so this module
 * stays import-light). Defaults = the shipped defaults.
 */
export const DEFAULT_SURFACE_ENV = Object.freeze({
  clipMapParity: "full",   // readClipMapParityMode(): "full" | "ref" | "legacy"
  clipMapOpaque: true,     // clipMapOpaqueEnabled()
  parityV2: false,         // readSurfaceParityV2Flag()
  additiveObjFog: true,    // additiveObjFogExemptEnabled()
  singlePass: true,        // surfaceSinglePassEnabled()
});

function _state() {
  return {
    diffuse: [1, 1, 1], opacity: 1, roughness: 0.9, metalness: 0, normalScale: [1, 1],
    alphaRef: 0, luminosity: 0, transparent: false, depthWrite: true, fogOff: false,
    twoSided: true, singlePass: false, emissiveMap: false, blend: BLEND.NONE,
  };
}

/**
 * The state `applySurfaceRenderState` writes for one surface, on a material
 * built the way both ladders build it (DoubleSide, opaque, alphaTest 0).
 *
 * @param {{flags:number, translucency?:number, luminosity?:number, diffuse?:number,
 *          hasPalette?:boolean, textured?:boolean}} surface
 *   `hasPalette`: STRICT boolean-or-undefined, as the wasm getter hands it
 *   (undefined = stale pkg -> legacy 0.5 ClipMap ref). `textured`: the
 *   material has a map (decides the luminous emissiveMap), default true.
 * @param {object} [env]    see DEFAULT_SURFACE_ENV
 * @param {"cache"|"paletted"} [ladder="cache"]  the paletted ladder returns
 *   early for type 0 (entities.js: fail-soft opaque, no lum / diffuse); the
 *   cache ladder still applies the float-driven half.
 */
export function layerStateFromSurface(surface, env = DEFAULT_SURFACE_ENV, ladder = "cache") {
  const e = env || DEFAULT_SURFACE_ENV;
  const s = _state();
  const flags = (surface?.flags ?? 0) >>> 0;
  const T = +(surface?.translucency ?? 0);
  const L = +(surface?.luminosity ?? 0);
  const D = +(surface?.diffuse ?? 0);
  const textured = surface?.textured !== false;
  if (flags === 0 && ladder === "paletted") return s;
  if (flags !== 0) {
    const isTranslucent = (flags & SURFACE_BITS.Translucent) !== 0;
    const isClipMap = (flags & SURFACE_BITS.Base1ClipMap) !== 0;
    const isAdditive = (flags & SURFACE_BITS.Additive) !== 0;
    const isAlpha = (flags & SURFACE_BITS.Alpha) !== 0;
    const isInvAlpha = (flags & SURFACE_BITS.InvAlpha) !== 0;
    if (isAdditive && isAlpha) {
      s.blend = BLEND.SRCALPHA_ONE; s.transparent = true; s.depthWrite = false;
    } else if (e.parityV2 && isInvAlpha && !isAlpha && !isTranslucent) {
      s.blend = isAdditive ? BLEND.INVSRCALPHA_ONE : BLEND.INVSRCALPHA_SRCALPHA;
      s.transparent = true; s.depthWrite = false;
    } else if (isAdditive) {
      s.blend = BLEND.ADDITIVE; s.transparent = true; s.depthWrite = false;
    } else if (isTranslucent || isAlpha || isInvAlpha) {
      s.blend = BLEND.NORMAL; s.transparent = true; s.depthWrite = false;
      if (isTranslucent && T > 0) s.opacity = Math.max(0, 1 - T);
    } else if (isClipMap) {
      const mode = e.clipMapParity;
      s.alphaRef = mode !== "legacy" && typeof surface.hasPalette === "boolean"
        ? (surface.hasPalette ? CLIPMAP_REF_PALETTED : CLIPMAP_REF_DDS)
        : CLIPMAP_REF_LEGACY;
      if (mode === "full" && !e.clipMapOpaque) {
        s.blend = BLEND.ONE_INVSRCALPHA; s.transparent = true; s.depthWrite = true;
      } else if (mode === "full") {
        s.depthWrite = true;
      }
    }
    if (isAdditive && (e.parityV2 || e.additiveObjFog)) s.fogOff = true;
  }
  if (L > 0) {
    s.luminosity = Math.min(2.0, L);
    s.emissiveMap = textured;
  }
  if (D > 0 && Math.abs(D - 1.0) > 0.01) s.diffuse = [D, D, D];
  // applyRetailSinglePass: transparent DoubleSide surfaces draw once.
  if (s.transparent && s.twoSided) s.singlePass = e.singlePass;
  return s;
}

/** Blend code of a built material (see BLEND). */
export function blendCodeOf(mat) {
  if (!mat || mat.transparent !== true) return BLEND.NONE;
  if (mat.blending === THREE.NormalBlending) return BLEND.NORMAL;
  if (mat.blending === THREE.AdditiveBlending) return BLEND.ADDITIVE;
  if (mat.blending === THREE.CustomBlending && mat.blendEquation === THREE.AddEquation) {
    const s = mat.blendSrc, d = mat.blendDst;
    if (s === THREE.SrcAlphaFactor && d === THREE.OneFactor) return BLEND.SRCALPHA_ONE;
    if (s === THREE.OneFactor && d === THREE.OneMinusSrcAlphaFactor) return BLEND.ONE_INVSRCALPHA;
    if (s === THREE.OneMinusSrcAlphaFactor && d === THREE.OneFactor) return BLEND.INVSRCALPHA_ONE;
    if (s === THREE.OneMinusSrcAlphaFactor && d === THREE.SrcAlphaFactor) return BLEND.INVSRCALPHA_SRCALPHA;
  }
  return -1; // a blend the table cannot express
}

/** The state read back off a built material (three's uniform sources). */
export function layerStateFromMaterial(mat) {
  return fillStateFromMaterial(_state(), mat);
}

/** layerStateFromMaterial into an existing state object (no allocation). */
export function fillStateFromMaterial(s, mat) {
  if (!mat) return s;
  const c = mat.color;
  if (c) { s.diffuse[0] = c.r; s.diffuse[1] = c.g; s.diffuse[2] = c.b; } else { s.diffuse[0] = 1; s.diffuse[1] = 1; s.diffuse[2] = 1; }
  s.opacity = mat.opacity;
  s.roughness = typeof mat.roughness === "number" ? mat.roughness : 1;
  s.metalness = typeof mat.metalness === "number" ? mat.metalness : 0;
  const ns = mat.normalScale;
  if (ns) { s.normalScale[0] = ns.x; s.normalScale[1] = ns.y; } else { s.normalScale[0] = 1; s.normalScale[1] = 1; }
  s.alphaRef = mat.alphaTest > 0 ? mat.alphaTest : 0;
  const em = mat.emissive;
  const lum = em && (em.r !== 0 || em.g !== 0 || em.b !== 0) ? mat.emissiveIntensity : 0;
  s.luminosity = lum > 0 ? lum : 0;
  s.transparent = mat.transparent === true;
  s.depthWrite = mat.depthWrite !== false;
  s.fogOff = mat.fog === false;
  s.twoSided = mat.side === THREE.DoubleSide;
  s.singlePass = mat.forceSinglePass === true;
  s.emissiveMap = !!mat.emissiveMap;
  s.blend = blendCodeOf(mat);
  return s;
}

/** The draw class a state belongs to. */
export function blendClassOf(s) {
  if (!s.transparent) return s.alphaRef > 0 ? BLEND_CLASS.ALPHA_TEST : BLEND_CLASS.OPAQUE;
  if (s.blend === BLEND.ADDITIVE || s.blend === BLEND.SRCALPHA_ONE || s.blend === BLEND.INVSRCALPHA_ONE) {
    return BLEND_CLASS.ADDITIVE;
  }
  return BLEND_CLASS.TRANSLUCENT;
}

/** Integer flags word (LS_FLAG bits | blend << 8). */
export function flagsWordOf(s) {
  let f = 0;
  if (s.transparent) f |= LS_FLAG.TRANSPARENT;
  if (s.depthWrite) f |= LS_FLAG.DEPTH_WRITE;
  if (s.fogOff) f |= LS_FLAG.FOG_OFF;
  if (s.twoSided) f |= LS_FLAG.TWO_SIDED;
  if (s.alphaRef > 0) f |= LS_FLAG.ALPHA_TEST;
  if (s.luminosity > 0) f |= LS_FLAG.LUMINOUS;
  if (s.singlePass) f |= LS_FLAG.SINGLE_PASS;
  if (s.emissiveMap) f |= LS_FLAG.EMISSIVE_MAP;
  return f | ((s.blend & 0xf) << 8);
}

/**
 * Pack a state + its texture layers into LAYER_STATE_FLOATS floats at
 * `out[off]` (`out` is a Float32Array: every value is stored as the f32 three
 * would upload for the matching uniform). `normalLayer` defaults to 0.
 */
export function packLayerState(s, layer, out, off, normalLayer = 0) {
  out[off + 0] = s.diffuse[0]; out[off + 1] = s.diffuse[1]; out[off + 2] = s.diffuse[2]; out[off + 3] = s.opacity;
  out[off + 4] = s.roughness; out[off + 5] = s.metalness; out[off + 6] = s.normalScale[0]; out[off + 7] = s.normalScale[1];
  out[off + 8] = s.alphaRef; out[off + 9] = layer; out[off + 10] = s.luminosity; out[off + 11] = flagsWordOf(s);
  out[off + 12] = normalLayer; out[off + 13] = 0; out[off + 14] = 0; out[off + 15] = 0;
  return out;
}

/** Inverse of packLayerState (values as stored, i.e. f32). */
export function unpackLayerState(arr, off) {
  const f = arr[off + 11] | 0;
  return {
    diffuse: [arr[off], arr[off + 1], arr[off + 2]], opacity: arr[off + 3],
    roughness: arr[off + 4], metalness: arr[off + 5], normalScale: [arr[off + 6], arr[off + 7]],
    alphaRef: arr[off + 8], layer: arr[off + 9], luminosity: arr[off + 10], normalLayer: arr[off + 12],
    transparent: (f & LS_FLAG.TRANSPARENT) !== 0, depthWrite: (f & LS_FLAG.DEPTH_WRITE) !== 0,
    fogOff: (f & LS_FLAG.FOG_OFF) !== 0, twoSided: (f & LS_FLAG.TWO_SIDED) !== 0,
    singlePass: (f & LS_FLAG.SINGLE_PASS) !== 0, emissiveMap: (f & LS_FLAG.EMISSIVE_MAP) !== 0,
    blend: (f >> 8) & 0xf,
  };
}

/**
 * The SetSurface fields of two states agree (what the state table must carry
 * exactly). Values compared as f32, since that is what reaches the GPU.
 */
export function sameSurfaceState(a, b) {
  const f = Math.fround;
  return f(a.alphaRef) === f(b.alphaRef) && f(a.opacity) === f(b.opacity)
    && f(a.luminosity) === f(b.luminosity)
    && f(a.diffuse[0]) === f(b.diffuse[0]) && f(a.diffuse[1]) === f(b.diffuse[1]) && f(a.diffuse[2]) === f(b.diffuse[2])
    && a.transparent === b.transparent && a.depthWrite === b.depthWrite && a.fogOff === b.fogOff
    && a.twoSided === b.twoSided && a.singlePass === b.singlePass && a.emissiveMap === b.emissiveMap
    && a.blend === b.blend;
}

/** The fields that differ (diagnostics for a failing comparison). */
export function surfaceStateDiff(a, b) {
  const out = [];
  const f = Math.fround;
  for (const k of ["alphaRef", "opacity", "luminosity"]) if (f(a[k]) !== f(b[k])) out.push(`${k} ${a[k]} vs ${b[k]}`);
  for (let i = 0; i < 3; i += 1) if (f(a.diffuse[i]) !== f(b.diffuse[i])) out.push(`diffuse[${i}] ${a.diffuse[i]} vs ${b.diffuse[i]}`);
  for (const k of ["transparent", "depthWrite", "fogOff", "twoSided", "singlePass", "emissiveMap", "blend"]) {
    if (a[k] !== b[k]) out.push(`${k} ${a[k]} vs ${b[k]}`);
  }
  return out;
}

// ===========================================================================
// The table: one row per surface slot, in a RowTexture.
// ===========================================================================

export class LayerStateTable {
  /** @param {import("./row_texture.js").RowTexture} rows texelsPerRow must be >= LAYER_STATE_TEXELS */
  constructor(rows) {
    if (!rows || rows.texelsPerRow < LAYER_STATE_TEXELS) throw new Error("LayerStateTable: rows need >= 4 texels");
    this.rows = rows;
    this._scratch = new Float32Array(LAYER_STATE_FLOATS);
  }

  /** Allocate a slot row for (state, layers); -1 when the budget refused growth. */
  add(state, layer, budget, normalLayer = 0) {
    const row = this.rows.alloc(budget);
    if (row < 0) return -1;
    this.write(row, state, layer, normalLayer);
    return row;
  }

  /** Allocate a slot row written from a built material; -1 when the budget refused growth. */
  addFromMaterial(mat, layer, budget, normalLayer = 0) {
    const row = this.rows.alloc(budget);
    if (row < 0) return -1;
    this.writeFromMaterial(row, mat, layer, normalLayer);
    return row;
  }

  /** Rewrite a slot straight from a built material (no allocation); true when changed. */
  writeFromMaterial(row, mat, layer, normalLayer = 0) {
    if (!this._s) this._s = _state();
    return this.write(row, fillStateFromMaterial(this._s, mat), layer, normalLayer);
  }

  /** Rewrite a slot; returns true when any stored float changed. */
  write(row, state, layer, normalLayer = 0) {
    const sc = packLayerState(state, layer, this._scratch, 0, normalLayer);
    const d = this.rows.data;
    const b = row * this.rows.floatsPerRow;
    let changed = false;
    for (let i = 0; i < LAYER_STATE_FLOATS; i += 1) {
      if (d[b + i] !== sc[i]) { d[b + i] = sc[i]; changed = true; }
    }
    if (changed) this.rows.markDirty();
    return changed;
  }

  remove(row) { this.rows.free(row); }
}
