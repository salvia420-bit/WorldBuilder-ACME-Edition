// scene3d/pool_class_key.js — the (sector, material-class) POOL KEY (ST9/T22;
// SPEC §1.5, pass-07 D-07.1/D-07.2/S3, T00 re-key 2026-08-09).
//
// WHAT THIS IS
// ------------
// The ONE place the pass-7 S3 canonical class key is built. Three consumers
// must agree byte-for-byte or the census measures a different world than the
// renderer builds:
//
//   * `scene3d/pool_registry.js` — the runtime producer (pools, materials);
//   * `harness/census-class.mjs` — the CENSUS-CLASS reducer (T00 / GATE-POOLS);
//   * the boot prewarm work list (`scene3d/pool_prewarm.js`), which is the
//     census list by definition (pass-07 D-07.9).
//
// It is deliberately dependency-free (no `three`, no DOM): node harnesses
// import it directly, and the census reducer runs it over captured snapshots
// with no browser in the loop.
//
// THE KEY (pass-07 S3, as amended by the T00 re-key 2026-08-09)
// ------------------------------------------------------------
//   "<domain>|<state>|<patch>|<tex>|<shadow>"
//    domain = "st" | "ec"                  (outdoor-static, envcell; "tr"/"as"
//                                           are reserved labels, never pooled)
//    state  = t{0|1} a{exact alphaTest string} w{0|1} b{mode | cS.D.E}
//             r{w|c} s{f|b|d}              (_stateKeyOf axes + side; alphaTest
//                                           keeps FULL-PRECISION string
//                                           equality — the 100/255 rule)
//    patch  = _patchSetCacheKey verbatim (hb|d|c|p|l|a|b|f|s|k|v<set>)
//             + "#"+configKey for MECH-B VFX sets
//    tex    = x{t}{f7|f8}   ARRAY-PAGE TIER + format
//    shadow = c{0|1}r{0|1}
//
// THE TEX AXIS IS A PAGE TIER, NOT RAW DIMS (T00 re-key 2026-08-09)
// ----------------------------------------------------------------
// Raw `(log2w<<4|log2h)` keying was pass-7's original design and it MEASURED
// as the fragmenter: 122 classes / 352 pools at settled Nanto against bounds
// of ≤~72 / ≤300, with texDims alone contributing +92 classes (T00 report;
// re-key proposal `impl/t00-rekey-proposal-2026-08-09.md`). The amendment
// (applied to pass-07 S3/D-07.2/S5.3 + SPEC §1.5/§3 in commit 24de3936):
//
//   t = clamp(ceil(log2(max(TEXREF w, TEXREF h))), 8, 11)  ∈ {8, 9, 10, 11}
//     → square pow2 array pages 256² / 512² / 1024² / 2048², per format
//
// with the correctness half: a member whose native dims ≠ its page dims is
// stored RESAMPLED (upscale-only by construction of `t`) to page dims at
// bake/transcode time. Every layer is then fully covered — UV 0..1 spans the
// whole layer — so wrap, full mip chains and aniso all stay legal, and
// "every member of a class can share any layer of the class's one
// `texStorage3D` allocation" is a THEOREM of the key rather than a
// measurement. D-07.2's load-bearing sentence survives verbatim: the tier IS
// the (format, w, h) triple `texStorage3D` fixes.
//
// Tier derives from TEXREF-DECLARED (full-tier) dims, never live dims, so
// class identity is stable across preview→full (pass-5 D-05.6.2: bucket
// identity known before any payload arrives; pass-7 D-07.9: the class set is
// CLOSED at boot). `texRefDims()` is the seam that reads the declared dims;
// the census approximates it with live dims and says so.
//
// MEASURED under this key (real T00 snapshots, offline re-reduce):
//   nanto 63 classes / 271 pools · townnetwork 51 / 238 · program classes
//   24 / 23 · zero layer-share violations by construction.

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** Array-page tier bounds: log2 of the page edge. 8 = 256², 11 = 2048². */
export const PAGE_TIER_MIN = 8;
export const PAGE_TIER_MAX = 11;

/** World-sector edge in metres (2×2 tiles = 4×4 LBs; pass-07 D-07.1). */
export const SECTOR_METRES = 768;
/** World-sector edge in landblocks. */
export const SECTOR_LBS = 4;
/** World-sector edge in tiles. */
export const SECTOR_TILES = 2;

/** Domains that produce pools. Terrain ("tr") and animated scenery ("as")
 *  keep their landed shapes (charter I5-kept) — reserved labels only. */
export const POOL_DOMAINS = Object.freeze(["st", "ec"]);

/** three.js constants, inlined (this module never imports three). */
const REPEAT_WRAPPING = 1000;
const CUSTOM_BLENDING = 5;
const ADDITIVE_BLENDING = 2;

// ---------------------------------------------------------------------------
// the tex axis (page tier)
// ---------------------------------------------------------------------------

/**
 * Page tier for a declared max dimension.
 * `t = clamp(ceil(log2(maxDim)), 8, 11)` — the clamp-ceil of the T00 re-key.
 * @param {number} maxDim  max(TEXREF w, TEXREF h), in texels
 * @returns {number} t ∈ {8, 9, 10, 11}
 */
export function pageTierOf(maxDim) {
  const d = Math.max(1, Math.floor(Number(maxDim) || 0));
  const t = Math.ceil(Math.log2(d));
  if (!Number.isFinite(t) || t < PAGE_TIER_MIN) return PAGE_TIER_MIN;
  return t > PAGE_TIER_MAX ? PAGE_TIER_MAX : t;
}

/** Square page edge in texels for a tier (256/512/1024/2048). */
export function pageEdgeOf(tier) {
  return 1 << Math.max(PAGE_TIER_MIN, Math.min(PAGE_TIER_MAX, tier | 0));
}

/**
 * Page dims a member is RESAMPLED to. Returns `null` for the untextured
 * class (no page, no array, no resample).
 * @param {{hasTex?: boolean, texW?: number, texH?: number}} rec
 */
export function pageDimsOf(rec) {
  if (rec && rec.hasTex === false) return null;
  const w = (rec && rec.texW) | 0;
  const h = (rec && rec.texH) | 0;
  if (!w && !h && !(rec && rec.hasTex)) return null;
  const e = pageEdgeOf(pageTierOf(Math.max(w, h)));
  return { width: e, height: e };
}

/** True when the member's native dims differ from its page (⇒ resampled). */
export function needsResample(rec) {
  const p = pageDimsOf(rec);
  if (!p) return false;
  return ((rec.texW | 0) !== p.width) || ((rec.texH | 0) !== p.height);
}

/**
 * `tex` token: `x{t}{f7|f8}` — page tier + compressed-format bit. The
 * untextured class is tier `0` (no page allocation at all).
 */
export function texKeyOf(rec) {
  const fmt = rec && rec.texCompressed ? "f7" : "f8";
  const dims = pageDimsOf(rec);
  if (!dims) return `x0${fmt}`;
  return `x${pageTierOf(Math.max(rec.texW | 0, rec.texH | 0))}${fmt}`;
}

// ---------------------------------------------------------------------------
// the remaining axes (S3 verbatim)
// ---------------------------------------------------------------------------

/** `state` token: t{0|1}a{exact}w{0|1}b{mode|cS.D.E}r{w|c}s{f|b|d}. */
export function stateKeyOf(rec) {
  const at = String(+(rec.alphaTest || 0)); // full precision (100/255 rule)
  const dw = rec.depthWrite === false ? 0 : 1;
  const b = rec.blending == null ? 1 : rec.blending;
  const blend = b === CUSTOM_BLENDING && rec.blendTriple ? `c${rec.blendTriple}` : String(b);
  const wr = rec.wrap === "w" ? "w" : "c";
  const side = rec.side === 0 ? "f" : rec.side === 1 ? "b" : "d";
  return `t${rec.transparent ? 1 : 0}a${at}w${dw}b${blend}r${wr}s${side}`;
}

/** `patch` token: `_patchSetCacheKey` verbatim + "#"+configKey for VFX sets. */
export function patchKeyOf(rec) {
  const u = rec.patch || {};
  let key = "hb"
    + "|d" + (u.d ? 1 : 0) + "|c" + (u.c ? 1 : 0) + "|p" + (u.p ? 1 : 0)
    + "|l" + (u.l ? 1 : 0) + "|a" + (u.a ? 1 : 0) + "|b" + (u.b ? 1 : 0)
    + "|f" + (u.f ? 1 : 0) + "|s" + (u.s ? 1 : 0) + "|k" + (u.k ? 1 : 0)
    + "|v" + (u.v || "");
  if (u.v && rec.vfxConfigKey != null) key += "#" + rec.vfxConfigKey;
  return key;
}

/** `shadow` token: c{0|1}r{0|1} (node flags become pool-uniform, D-07.6). */
export function shadowKeyOf(rec) {
  return `c${rec.castShadow ? 1 : 0}r${rec.receiveShadow ? 1 : 0}`;
}

/** THE class key. Produced ONLY here (S3: "never hand-built"). */
export function classKeyOf(rec) {
  return `${rec.domain}|${stateKeyOf(rec)}|${patchKeyOf(rec)}|${texKeyOf(rec)}|${shadowKeyOf(rec)}`;
}

/**
 * The PROGRAM class — the class key modulo the ENTIRE tex axis (dims AND
 * format: a 512² and a 2048² `sampler2DArray` compile identically). This is
 * the population D-07.9's prewarm list and the p99 link-storm term key on;
 * the gate is `programClasses ≤ ~48` (T00 re-key §5/§6, measured 24/23).
 */
export function programClassKeyOf(rec) {
  return `${rec.domain}|${stateKeyOf(rec)}|${patchKeyOf(rec)}|${shadowKeyOf(rec)}`;
}

/** passClass per D-07.3 (derived from renderState, never from a predicate). */
export function passClassOf(rec) {
  if (rec.blending === ADDITIVE_BLENDING) return "additive";
  if (rec.transparent === true && !(rec.alphaTest > 0)) return "translucent";
  return "opaque";
}

/** True when the class is pooled at all (statics + envcells; D-07.1 table). */
export function isPooledDomain(domain) {
  return domain === "st" || domain === "ec";
}

// ---------------------------------------------------------------------------
// axis extraction from a live material (the runtime producer's entry point)
// ---------------------------------------------------------------------------

/**
 * Build the raw axis record from a resolved material + node flags. This is
 * the runtime counterpart of the census collector's `coreAxesOf`; it reads
 * the SAME fields, so runtime keys and census keys are the same strings.
 *
 * `texRef` carries the TEXREF-DECLARED dims + format (pass-5): pass it
 * whenever it is known (pack TEXREF rows / `pack_texref`), and the key is
 * stable across preview→full. Absent, live `material.map` dims are used and
 * the record is stamped `texApprox: true` so callers can count the
 * approximation instead of hiding it.
 *
 * @param {object} material  a resolved THREE material (duck-typed)
 * @param {object} [opts]
 * @param {"st"|"ec"} [opts.domain]
 * @param {boolean} [opts.castShadow]
 * @param {boolean} [opts.receiveShadow]
 * @param {{w:number,h:number,compressed?:boolean}|null} [opts.texRef]
 * @param {string|null} [opts.vfxConfigKey]
 */
export function axisRecordOf(material, opts = {}) {
  const mat = material || {};
  const mu = mat.userData || {};
  const texRef = opts.texRef || null;
  let texW = 0;
  let texH = 0;
  let texCompressed = false;
  let hasTex = false;
  let texApprox = false;
  if (texRef && (texRef.w | 0) > 0) {
    texW = texRef.w | 0;
    texH = (texRef.h | 0) || texW;
    texCompressed = texRef.compressed !== false;
    hasTex = true;
  } else {
    const tex = mat.map || null;
    const img = tex && tex.image;
    if (img && img.width) {
      texW = img.width | 0;
      texH = img.height | 0;
      texCompressed = tex.isCompressedTexture === true;
      hasTex = true;
      texApprox = true;
    }
  }
  const b = (mat.blending === undefined || mat.blending === null) ? 1 : mat.blending;
  return {
    domain: opts.domain || "st",
    transparent: mat.transparent === true,
    alphaTest: +(mat.alphaTest || 0),
    depthWrite: mat.depthWrite === false ? false : true,
    blending: b,
    blendTriple: b === CUSTOM_BLENDING
      ? `${mat.blendSrc}.${mat.blendDst}.${mat.blendEquation}` : null,
    wrap: (mat.map && mat.map.wrapS === REPEAT_WRAPPING) ? "w" : "c",
    side: mat.side | 0,
    patch: {
      d: mu.detailEnabled ? 1 : 0, c: mu.csmEnabled ? 1 : 0, p: mu.pomEnabled ? 1 : 0,
      l: mu.lightClampRetail ? 1 : 0, a: mu.__aoPatched ? 1 : 0, b: mu.__depthBiased ? 1 : 0,
      f: mu.__floorBiased ? 1 : 0, s: mu.__staticBiased ? 1 : 0, k: mu.__acBakedLight ? 1 : 0,
      v: typeof mu.__vfxSetKey === "string" ? mu.__vfxSetKey : "",
    },
    vfxConfigKey: opts.vfxConfigKey ?? null,
    texW, texH, texCompressed, hasTex, texApprox,
    castShadow: opts.castShadow === true,
    receiveShadow: opts.receiveShadow === true,
    surfaceDid: (mu.surfaceDid >>> 0) || 0,
  };
}

// ---------------------------------------------------------------------------
// sector partition (world-absolute — an anchor shift never re-homes anything)
// ---------------------------------------------------------------------------

/** Sector key from world-absolute AC metres. */
export function sectorKeyOfAc(acX, acY) {
  return `s${Math.floor(acX / SECTOR_METRES)}x${Math.floor(acY / SECTOR_METRES)}`;
}

/** Sector key from landblock indices (lbx, lby ∈ 0..254). */
export function sectorKeyOfLb(lbx, lby) {
  return `s${Math.floor(lbx / SECTOR_LBS)}x${Math.floor(lby / SECTOR_LBS)}`;
}

/** Sector key from tile indices (pass-6 tiles; `s(t) = floor(t/2)`). */
export function sectorKeyOfTile(tx, ty) {
  return `s${Math.floor(tx / SECTOR_TILES)}x${Math.floor(ty / SECTOR_TILES)}`;
}

// ---------------------------------------------------------------------------
// naming
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit, hex, 8 chars — the pool node-name suffix (S3). */
export function hash8(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Pool node name: `pool-<sectorKey>-<hash8(classKey)>` (S3). Census joins on
 *  the full key; names stay short for the devtools tree. */
export function poolNodeName(sectorKey, classKey) {
  return `pool-${sectorKey}-${hash8(classKey)}`;
}
