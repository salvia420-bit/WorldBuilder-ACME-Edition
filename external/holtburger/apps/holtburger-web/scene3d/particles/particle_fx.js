// scene3d/particles/particle_fx.js — `?particleFx` (2026-10-09, DEFAULT ON,
// `=off` escape): an individual visual upgrade for EVERY particle effect.
//
// WHAT. Each of the 2,051 retail ParticleEmitters in client_portal.dat (0x32
// records) and each synthesized Visual-Behavior-Suite emitter (gemSparkle,
// brazierEmbers, foliage*, breathFog, terrain*) has its own row of upgrade
// parameters (particle_fx_profiles.js, generated from
// data/particle-fx-catalog.json — family, behaviour, a note on what the effect
// is in game, and the params). The row is chosen per EMITTER, and the upgrade
// runs per PARTICLE in one shared shader, so a fire plume, its paired smoke, a
// spell's sparkles and a lifestone's halo can each look different without one
// extra draw call or program:
//
//   gain / core    HDR lift (the late particle pass draws into the half-float
//                  buffer BEFORE bloom, threshold 1.1) and a white-hot core
//   tint0 → tint1  colour over life (fire cools, smoke greys, magic deepens)
//   sat            saturation
//   fadeIn/Out     no pop-in / pop-out (retail kills a particle at its lifespan
//                  whatever its opacity)
//   erode          dim texels dissolve first as the particle ages
//   flicker, twinkle, pulse   per-particle-phase temporal variation
//   spin           texture roll over life (radial sprites on full-UV quads)
//   wobble         UV turbulence (licking flames, shimmering water)
//   soft           soft particles against the scene depth (late pass only)
//   nearFade       fade near the camera (no screen-filling quads)
//   lit            follow day / night / indoor light (non-emissive sprites)
//
// HOW (zero draw-call cost). Only the instanced bucket path is upgraded — that
// is where every visible particle draws by default (`?particleInstancing`, ON).
// Each bucket instance's colour, which carried `(op, op, op)`, now carries
//   r = per-particle opacity (unchanged meaning)
//   g = age in [0, 1]  (lifetime / lifespan)
//   b = profileRow + seed  (integer row into the profile table + a stable
//       per-particle random in [0, 0.999])
// The vertex stage fetches the emitter's six-texel row from a float
// DataTexture (texelFetch) and folds everything that is constant per particle
// (tint, gain, flicker, twinkle, pulse, light, fades, erosion threshold, spin
// angle) into four varyings; the fragment stage rotates/wobbles the UV,
// samples, applies saturation, core, erosion, soft and near fades. Additive
// keeps opacity folded into rgb exactly as before (`HB_FX_ADDITIVE`); alpha
// keeps it as the alpha the alpha-test reads. Two programs total (additive,
// alpha) — constant `customProgramCacheKey`s, no per-instance keys.
//
// NEUTRAL ROW. Row 0 is the identity (gain 1, tints 1, every effect 0): the
// shader then computes exactly texel × opacity, the stock result.
// `window.__particleFx(false)` forces row 0 for every instance (live A/B,
// no recompile); `?particleFx=off` skips the patch entirely (stock materials,
// `(op, op, op)` instance colours — byte-identical to the pre-FX path).
//
// NOT UPGRADED (by design): the per-mesh slot path (`?particleInstancing=off`,
// and surface-less emitters, which draw nothing), and the sky chain
// (`skyGlow` emitters — owner rule: the sky's gaseous sheets stay subtle).
//
// SOFT PARTICLES. The late pass (particles_over_clouds.js, atmosphere_pipeline
// ParticlesOverCloudsPass) depth-tests against the composer's scene depth
// texture, which is ATTACHED to its target, so sampling it there would be a
// feedback loop. The pass calls the registered late-FX hooks around its draw:
// `before` copies the depth into a single-channel half-float target as linear
// view depth (log-depth aware: w = 2^(d·log2(far+1)) − 1), `after` switches the
// soft term off again, so any particle drawn outside the late pass (indoor
// split frames, `?particlesOverClouds=off`) simply gets no soft fade.
//
// TIER 1 (2026-10-10, scene3d/vfx/fx_tier1.js). Rows grow from 6 to 10 texels
// (data/particle-fx-tier1.json, tools/particle-fx/tier1.py): glow, GPU
// children, smoke shading, light + distortion. In THIS file:
//   `?fxSmoke`  compiled in as HB_FX_SMOKE (program keys gain an "s"; "c" when
//               the CSM is live): sun shading from a pseudo-normal (the screen
//               gradient of the sprite's own alpha), one CSM sun-shadow tap per
//               particle (vertex stage), noise erosion + breakup and curl flow
//               off a procedural tileable noise texture, a back-lit rim.
//   `?fxGlow`   the glow VARIANT (HB_FX_GLOW): the same row, drawn by
//               vfx/fx_glow_effect.js into its half-res glow buffer, carrying
//               `glow` x the calibrated colour, occluded by the scene depth.
//   children / lights / distortion read the row on the CPU (`particleFxTier1`)
//               — particle_fx_kids.js, vfx/fx_lights.js, vfx/fx_distort.js.
// DISPLAY CALIBRATION now follows the renderer exposure on EVERY path (the
// light tick below), not only inside the late pass: the single post-chain
// composer (no `?clouds=on`, i.e. the default boot) applies the same x5
// exposure, and there the 2026-10-09 calibration never ran.
//
// TIER 2 (2026-10-10, scene3d/vfx/fx_tier2.js). Rows grow from 10 to 12 texels
// (data/particle-fx-tier2.json, tools/particle-fx/tier2.py). Three more
// compile-time variants, latched with the tier-1 one (keys gain m / a / p):
//   `?fxMotion` HB_FX_MOTION — the instance matrix's unused bottom row carries
//               each particle's velocity (particle_manager.js writes it, the
//               vertex stage strips it before any chunk multiplies a position
//               by the matrix): rows with `stretch` are lengthened along their
//               screen-plane velocity, head at the particle, tail behind.
//   `?fxShapes` HB_FX_SHAPES — rows with `shape` draw an analytic star / orb /
//               ring computed in the fragment stage instead of the texture: a
//               crisp anti-aliased core, a halo, diffraction spikes with a
//               slight chromatic split (stars), swirling arms (the portal rim),
//               in the texture's own energy-matched colour (`sprite`).
//   `?fxClamp`  HB_FX_CLAMP — a particle whose projected radius is under
//               uFxMinPx (1.5 px) is drawn at 1.5 px with its opacity cut by the
//               area ratio: distant glints and specks shimmer steadily instead
//               of popping in and out.

import * as THREE from "three";

import { FX_PROFILE_ROWS, FX_ROW_EXTRA, FX_DID_ROWS, FX_NAMED_ROWS, FX_TEXELS_PER_ROW, FX_PROFILE_VERSION } from "./particle_fx_profiles.js";
import { registerLateFxHooks } from "../particles_over_clouds.js";
import { nightFactorFromAuthoredPitch } from "../night_ramp.js";
import { viewerIndoorOr } from "../viewer_cell.js";
import { fxTier1Enabled } from "../vfx/fx_tier1.js";
import { fxTier2Enabled } from "../vfx/fx_tier2.js";

const OFF_FORMS = new Set(["off", "0", "false", "no"]);

let _enabled = null;
/** `?particleFx` — DEFAULT ON; `off|0|false|no` keeps the stock bucket path. */
export function particleFxEnabled(search) {
  if (typeof search === "string") {
    try {
      const v = new URLSearchParams(search).get("particleFx");
      return v == null || !OFF_FORMS.has(String(v).trim().toLowerCase());
    } catch (_) {
      return true;
    }
  }
  if (_enabled === null) {
    let s = "";
    try { s = globalThis.location?.search || ""; } catch (_) { s = ""; }
    _enabled = particleFxEnabled(s);
  }
  return _enabled;
}
/** Test seam: force the module flag (`null` re-reads the URL). */
export function setParticleFxFlag(on) { _enabled = on == null ? null : !!on; }

// Live A/B: false ⇒ every instance uses row 0 (the neutral, stock-identical row)
// and the alpha display calibration is lifted, i.e. exactly the stock look.
let _live = true;
/** `window.__particleFx(on?)` backing store; returns the state now in force. */
export function setParticleFxLive(on) {
  _live = on !== false;
  if (!_live) { FX_UNIFORMS.uFxAlphaCal.value = 1; FX_UNIFORMS.uFxAddCal.value = 1; }
  return _live;
}
export function particleFxLive() { return _live; }

// ---------------------------------------------------------------------------
// `?particleAlphaCal` (DEFAULT ON with ?particleFx; `=off` escape) — display
// calibration for NORMAL-BLENDED (alpha) particles.
//
// Particles are unlit: their texels go into the HDR buffer as-is, and the
// composer then multiplies the whole frame by `toneMappingExposure` (5, the
// takram calibration — index.js) before the Neutral curve. Lit world surfaces
// are calibrated for that (worldLightScale, the terrain Gouraud scale); unlit
// particles never were (sky_glow.js does the same correction for the sky
// sheets: "strength / toneMappingExposure"). Measured through three r184's
// Neutral curve: an alpha texel of 0.40 (sRGB) displays as 0.81, 0.55 as 0.97 —
// grey smoke reads near-white, saturated sprites bleach (blood 0.91/0.05/0.05
// shows pink 0.99/0.54/0.54 where retail drew 0.80/0.13/0.10). Dividing the
// alpha sprite's colour by the exposure puts it back on retail's LDR value
// (0.40 → 0.38, blood stays red). ADDITIVE particles keep their colour: retail
// added in gamma space, which the linear add × exposure already approximates by
// day (and at night the extra glow is the look the upgrade wants anyway).
// The factor is set from the live renderer exposure in the late-pass hook (the
// only path where the composer applies it); everywhere else it stays 1.
let _alphaCalOn = null;
export function particleAlphaCalEnabled(search) {
  if (typeof search === "string") {
    try {
      const v = new URLSearchParams(search).get("particleAlphaCal");
      return v == null || !OFF_FORMS.has(String(v).trim().toLowerCase());
    } catch (_) { return true; }
  }
  if (_alphaCalOn === null) {
    let s = "";
    try { s = globalThis.location?.search || ""; } catch (_) { s = ""; }
    _alphaCalOn = particleAlphaCalEnabled(s);
  }
  return _alphaCalOn;
}
export function setParticleAlphaCalFlag(on) { _alphaCalOn = on == null ? null : !!on; }

// Additive display calibration: `K / exposure` (K = 5 ⇒ none at exposure 5).
// Retail added in GAMMA space; the client adds linear light and then scales by
// the exposure, which by day lands near retail but bleaches saturated colours
// toward white (Neutral desaturates past its shoulder) and at night shows
// additive sprites ~2× retail. `?particleAddCal=K` (number) tunes; `off` = none.
//
// K follows scene brightness (2026-10-10, from the offline preview + visual QA):
// retail's gamma-space addition put a sprite over a BRIGHT daytime background
// at about stock brightness (K ≈ 4-5), while over a dark night or indoor
// background it showed about half the client's linear add (K ≈ 2). One K
// either bloom-flooded the night or left emissive effects ~0.5× stock by day,
// so K = mix(K_DAY, K_NIGHT, night), and K_NIGHT indoors. `?particleAddCal=K`
// pins both.
let _addK = null;
export const PARTICLE_ADD_CAL_DEFAULT_K = 2.0;   // night / indoor
export const PARTICLE_ADD_CAL_DAY_K = 4.0;       // full day
export function particleAddCalK(search) {
  if (typeof search === "string") {
    try {
      const v = new URLSearchParams(search).get("particleAddCal");
      if (v == null) return PARTICLE_ADD_CAL_DEFAULT_K;
      const t = String(v).trim().toLowerCase();
      if (OFF_FORMS.has(t)) return 0;
      const n = Number(t);
      return Number.isFinite(n) && n > 0 ? Math.min(20, n) : PARTICLE_ADD_CAL_DEFAULT_K;
    } catch (_) { return PARTICLE_ADD_CAL_DEFAULT_K; }
  }
  if (_addK === null) {
    let s = "";
    try { s = globalThis.location?.search || ""; } catch (_) { s = ""; }
    _addK = particleAddCalK(s);
  }
  return _addK;
}
/** Test/preview seam: force K (0 = no calibration, null = re-read the URL). */
export function setParticleAddCalK(k) { _addK = k == null ? null : Math.max(0, +k || 0); }

let _addKPinned = null;
function _addKPinnedByUrl() {
  if (_addKPinned === null) {
    let s = "";
    try { s = globalThis.location?.search || ""; } catch (_) { s = ""; }
    try { _addKPinned = new URLSearchParams(s).get("particleAddCal") != null; } catch (_) { _addKPinned = false; }
  }
  return _addKPinned;
}

// Scene environment the calibration and `lit` follow (night fraction, indoor).
const _env = { night: 0, indoor: false };
/** Set the environment (particleFxFrame does this live; the offline preview pins it). */
export function setParticleFxEnvironment(night, indoor) {
  _env.night = Math.min(1, Math.max(0, Number.isFinite(night) ? night : 0));
  _env.indoor = !!indoor;
}
/** Pure: the additive K for a night fraction / indoor flag (URL- or test-pinned K wins). */
export function particleAddCalKFor(night, indoor, pinnedK) {
  if (pinnedK != null) return pinnedK;
  if (indoor) return PARTICLE_ADD_CAL_DEFAULT_K;
  const n = Math.min(1, Math.max(0, Number.isFinite(night) ? night : 0));
  return PARTICLE_ADD_CAL_DAY_K + (PARTICLE_ADD_CAL_DEFAULT_K - PARTICLE_ADD_CAL_DAY_K) * n;
}
function _liveAddK() {
  const pinned = (_addK !== null || _addKPinnedByUrl()) ? particleAddCalK() : null;
  return particleAddCalKFor(_env.night, _env.indoor, pinned);
}
/** Pure: the additive display factor for a renderer exposure and K (1 = none). */
export function particleAddCalFor(exposure, k) {
  const e = Number(exposure);
  if (!(k > 0) || !Number.isFinite(e) || e <= 1) return 1;
  return Math.min(1, k / Math.min(20, e));
}

/** Pure: the alpha display factor for a renderer exposure (1 = no correction). */
export function particleAlphaCalFor(exposure) {
  const e = Number(exposure);
  return Number.isFinite(e) && e > 1 ? 1 / Math.min(20, e) : 1;
}

// ---------------------------------------------------------------------------
// Profile table → DataTexture
// ---------------------------------------------------------------------------

/** Number of float params per row (FX_TEXELS_PER_ROW texels × 4). */
export const FX_ROW_FLOATS = FX_TEXELS_PER_ROW * 4;

/** Param names in row order (texel-major). Mirrors the generator. */
export const FX_PARAM_LAYOUT = Object.freeze([
  "gain", "core", "sat", "tintCurve",
  "tint0r", "tint0g", "tint0b", "fadeIn",
  "tint1r", "tint1g", "tint1b", "fadeOut",
  "erode", "flicker", "flickerHz", "twinkle",
  "spin", "wobble", "soft", "nearFade",
  "lit", "pulse", "pulseHz", "edgeSoft",
  // tier 1 (2026-10-10)
  "glow", "kids", "kidKind", "kidSize",
  "kidLife", "kidSpread", "kidGain", "rim",
  "sunLit", "noise", "flow", "shadow",
  "light", "lightRange", "distort", "distortKind",
  // tier 2 (2026-10-10)
  "stretch", "shape", "spikes", "bounce",
  "spriteR", "spriteG", "spriteB", "halo",
]);

/** Tier-1 child kinds (kidKind) and distortion kinds (distortKind). */
export const FX_KID_KIND = Object.freeze({ ember: 1, glitter: 2, spark: 3, drip: 4, inflow: 5, crackle: 6 });
export const FX_DISTORT_KIND = Object.freeze({ heat: 1, swirl: 2, ring: 3, ripple: 4 });
/** Tier-2 analytic sprite shapes (`shape`). */
export const FX_SHAPE = Object.freeze({ star: 1, orb: 2, ring: 3 });

let _table = null;
function _buildTable() {
  const rows = FX_PROFILE_ROWS.length;
  const data = new Float32Array(rows * FX_ROW_FLOATS);
  for (let r = 0; r < rows; r++) {
    const src = FX_PROFILE_ROWS[r];
    for (let k = 0; k < FX_ROW_FLOATS; k++) data[r * FX_ROW_FLOATS + k] = +src[k] || 0;
  }
  const tex = new THREE.DataTexture(data, FX_TEXELS_PER_ROW, rows, THREE.RGBAFormat, THREE.FloatType);
  tex.name = `particle-fx-profiles-v${FX_PROFILE_VERSION}`;
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}
/** The shared profile DataTexture (built once). */
export function particleFxTable() {
  if (!_table) _table = _buildTable();
  return _table;
}

/**
 * Profile row for an emitter's info: a synthesized `fxProfile` name wins, then
 * the retail emitter DID, else row 0 (neutral). Pure lookup.
 * @param {{fxProfile?: string|null, id?: number}} info
 * @returns {number}
 */
export function particleFxRowFor(info) {
  if (!info) return 0;
  const name = info.fxProfile;
  if (typeof name === "string" && name) {
    const r = FX_NAMED_ROWS[name];
    if (Number.isInteger(r)) return r;
  }
  const did = (info.id >>> 0);
  if (did) {
    const r = FX_DID_ROWS.get(did);
    if (Number.isInteger(r)) return r;
  }
  return 0;
}

/** Row params as an object (diagnostics / tests). */
export function particleFxRowParams(row) {
  const src = FX_PROFILE_ROWS[row] || FX_PROFILE_ROWS[0];
  const out = {};
  for (let k = 0; k < FX_ROW_FLOATS; k++) out[FX_PARAM_LAYOUT[k]] = +src[k] || 0;
  return out;
}

const _TIER1_BASE = 24;
const _tier1Cache = new Map();
/**
 * The CPU-side tier-1 terms of a row (cached, frozen): light (DAT intensity
 * units) + range + colour, distortion strength / kind / radius, children,
 * glow, smoke terms. Row 0 and an unknown row are all-zero.
 * @param {number} row
 */
export function particleFxTier1(row) {
  const r = row | 0;
  let hit = _tier1Cache.get(r);
  if (hit) return hit;
  const src = FX_PROFILE_ROWS[r] || FX_PROFILE_ROWS[0];
  const ex = FX_ROW_EXTRA[r] || FX_ROW_EXTRA[0] || [1, 1, 1, 0];
  const v = (i) => +src[_TIER1_BASE + i] || 0;
  hit = Object.freeze({
    glow: v(0), kids: v(1) | 0, kidKind: v(2) | 0, kidSize: v(3),
    kidLife: v(4), kidSpread: v(5), kidGain: v(6), rim: v(7),
    sunLit: v(8), noise: v(9), flow: v(10), shadow: v(11),
    light: v(12), lightRange: v(13), distort: v(14), distortKind: v(15) | 0,
    lightColor: Object.freeze([+ex[0] || 0, +ex[1] || 0, +ex[2] || 0]),
    distortRadius: +ex[3] || 0,
    // the base terms the CPU-side consumers echo (light flicker / pulse)
    flicker: +src[13] || 0, flickerHz: +src[14] || 0, pulse: +src[21] || 0, pulseHz: +src[22] || 0,
    tint0: Object.freeze([+src[4] || 0, +src[5] || 0, +src[6] || 0]),
    tint1: Object.freeze([+src[8] || 0, +src[9] || 0, +src[10] || 0]),
    gain: +src[0] || 0,
  });
  _tier1Cache.set(r, hit);
  return hit;
}

const _TIER2_BASE = 40;
const _tier2Cache = new Map();
/**
 * The tier-2 terms of a row (cached, frozen): velocity stretch, analytic shape
 * + spikes + halo + energy-matched sprite colour, spark bounce. Row 0 and an
 * unknown row are all-zero.
 * @param {number} row
 */
export function particleFxTier2(row) {
  const r = row | 0;
  let hit = _tier2Cache.get(r);
  if (hit) return hit;
  const src = FX_PROFILE_ROWS[r] || FX_PROFILE_ROWS[0];
  const v = (i) => +src[_TIER2_BASE + i] || 0;
  hit = Object.freeze({
    stretch: v(0), shape: v(1) | 0, spikes: v(2) | 0, bounce: v(3),
    sprite: Object.freeze([v(4), v(5), v(6)]), halo: v(7),
  });
  _tier2Cache.set(r, hit);
  return hit;
}

// ---------------------------------------------------------------------------
// Shared uniforms (one object per uniform, shared by every FX material)
// ---------------------------------------------------------------------------

const _softDummy = (() => {
  const t = new THREE.DataTexture(new Float32Array([1e6, 0, 0, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = THREE.NearestFilter; t.magFilter = THREE.NearestFilter; t.generateMipmaps = false;
  t.needsUpdate = true;
  t.name = "particle-fx-soft-dummy";
  return t;
})();

export const FX_UNIFORMS = {
  uFxTable: { value: null },
  uFxAlphaCal: { value: 1 },
  uFxAddCal: { value: 1 },
  uFxTime: { value: 0 },
  uFxLight: { value: new THREE.Vector3(1, 1, 1) },
  uFxSoftOn: { value: 0 },
  uFxSceneW: { value: _softDummy },
  uFxInvRes: { value: new THREE.Vector2(1, 1) },
  // tier 1 — `?fxSmoke`
  uFxNoise: { value: null },
  uFxSunWorld: { value: new THREE.Vector3(0.3, 0.8, 0.5).normalize() },
  uFxSunAmt: { value: 1 },
  // tier 1 — `?fxGlow` (set per frame by vfx/fx_glow_effect.js through the provider)
  uFxGlowDepth: { value: null },
  uFxGlowRes: { value: new THREE.Vector2(1, 1) },
  uFxGlowLogFar: { value: 1 },
  uFxGlowIsLog: { value: 1 },
  uFxGlowNearFar: { value: new THREE.Vector2(0.1, 1000) },
  uFxGlowScale: { value: 1 },
  // tier 2 — `?fxMotion` (shutter seconds the velocity stretch spans) and
  // `?fxClamp` (the drawing-buffer height in px; the minimum projected radius)
  uFxStretchT: { value: 0.04 },
  uFxViewH: { value: 1080 },
  uFxMinPx: { value: 1.5 },
};

// ---------------------------------------------------------------------------
// Tier-1 noise texture (`?fxSmoke`): 128² tileable, RGBA8, built once.
//   r, g  two value-noise fBm fields (4 octaves, different lattices)
//   b, a  the 2-D curl of a third fBm field, remapped to [0, 1]
// Deterministic (a fixed xorshift seed): the same frame on every load.
// ---------------------------------------------------------------------------
export const FX_NOISE_SIZE = 128;
let _noiseTex = null;
/** Pure: the noise texel data (exported for tests). */
export function buildParticleFxNoiseData(size = FX_NOISE_SIZE) {
  let s = 0x2545f491;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; };
  const lattices = [0, 1, 2].map(() => Float32Array.from({ length: 64 * 64 }, rnd));
  const vnoise = (lat, x, y, period) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const at = (i, j) => lat[(((j % period) + period) % period) * 64 + (((i % period) + period) % period)];
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  };
  const fbm = (lat, u, v) => {
    let sum = 0, amp = 0.5, norm = 0;
    for (let o = 0; o < 4; o++) {
      const period = 4 << o; // 4, 8, 16, 32 cells per tile: tileable at every octave
      sum += amp * vnoise(lat, u * period, v * period, period);
      norm += amp;
      amp *= 0.5;
    }
    return sum / norm;
  };
  const data = new Uint8Array(size * size * 4);
  const h = 1 / size;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = i / size, v = j / size;
      const n0 = fbm(lattices[0], u, v);
      const n1 = fbm(lattices[1], u, v);
      // curl of psi = fbm2: (dpsi/dy, -dpsi/dx), central differences (wrapping)
      const dx = (fbm(lattices[2], (u + h) % 1, v) - fbm(lattices[2], (u - h + 1) % 1, v)) / (2 * h);
      const dy = (fbm(lattices[2], u, (v + h) % 1) - fbm(lattices[2], u, (v - h + 1) % 1)) / (2 * h);
      let cx = dy, cy = -dx;
      const m = Math.max(1e-6, Math.hypot(cx, cy));
      const k = Math.min(1, m / 6) / m; // unit direction, magnitude saturating
      cx *= k; cy *= k;
      const o = (j * size + i) * 4;
      data[o] = Math.round(Math.min(1, Math.max(0, (n0 - 0.2) / 0.6)) * 255);
      data[o + 1] = Math.round(Math.min(1, Math.max(0, (n1 - 0.2) / 0.6)) * 255);
      data[o + 2] = Math.round((cx * 0.5 + 0.5) * 255);
      data[o + 3] = Math.round((cy * 0.5 + 0.5) * 255);
    }
  }
  return data;
}
/** The shared noise texture (built on first use). */
export function particleFxNoiseTexture() {
  if (_noiseTex) return _noiseTex;
  const t = new THREE.DataTexture(buildParticleFxNoiseData(FX_NOISE_SIZE), FX_NOISE_SIZE, FX_NOISE_SIZE,
    THREE.RGBAFormat, THREE.UnsignedByteType);
  t.name = "particle-fx-noise";
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  _noiseTex = t;
  return t;
}

// Light the `lit` param follows: day white → moonlit night → indoor torch-dim.
const LIGHT_DAY = [1.0, 1.0, 1.0];
const LIGHT_NIGHT = [0.30, 0.34, 0.45];
const LIGHT_INDOOR = [0.62, 0.60, 0.58];

/** Pure: the `lit` target colour for a night fraction + indoor flag. */
export function particleFxLightFor(night, indoor, out = [0, 0, 0]) {
  if (indoor) { out[0] = LIGHT_INDOOR[0]; out[1] = LIGHT_INDOOR[1]; out[2] = LIGHT_INDOOR[2]; return out; }
  const n = Math.min(1, Math.max(0, Number.isFinite(night) ? night : 0));
  for (let i = 0; i < 3; i++) out[i] = LIGHT_DAY[i] + (LIGHT_NIGHT[i] - LIGHT_DAY[i]) * n;
  return out;
}

let _lastFrameStamp = -1;
let _lightCountdown = 0;
const _lightScratch = [1, 1, 1];
const _bufSize = new THREE.Vector2();
/**
 * Per-frame uniform update (time; light every ~30 calls). Called from every
 * ParticleManager tick — idempotent within one timestamp.
 * @param {number} [nowMs] test seam
 */
export function particleFxFrame(nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : (typeof performance !== "undefined" ? performance.now() : 0);
  if (now === _lastFrameStamp) return;
  _lastFrameStamp = now;
  // Wrapped so GPU-side t·hz stays small (fract/sin precision); a jump every
  // ~17 min in a noise phase is invisible.
  FX_UNIFORMS.uFxTime.value = (now / 1000) % 1024;
  if (--_lightCountdown > 0) return;
  _lightCountdown = 30;
  let night = 0;
  let indoor = false;
  let st = null;
  try {
    st = globalThis.window?.liveScene3d?.skyLightingController?._lastState ?? null;
    if (st && Number.isFinite(st.dirPitch)) night = nightFactorFromAuthoredPitch(st.dirPitch);
  } catch (_) { night = 0; }
  try { indoor = viewerIndoorOr(false); } catch (_) { indoor = false; }
  setParticleFxEnvironment(night, indoor);
  particleFxLightFor(night, indoor, _lightScratch);
  FX_UNIFORMS.uFxLight.value.set(_lightScratch[0], _lightScratch[1], _lightScratch[2]);
  // Tier 1 `?fxSmoke`: the sun the smoke is shaded by, in THREE world space
  // (AC heading/pitch → AC (x, y, z) → three (x, z, -y), as loop.js
  // tickTerrainSunDir derives the terrain's sun), fading out at night and
  // indoors (the flat `lit` tint above carries those).
  if (st && Number.isFinite(st.dirHeading) && Number.isFinite(st.dirPitch)) {
    const D = Math.PI / 180;
    const cp = Math.cos(st.dirPitch * D);
    const ax = cp * Math.sin(st.dirHeading * D), ay = cp * Math.cos(st.dirHeading * D), az = Math.sin(st.dirPitch * D);
    FX_UNIFORMS.uFxSunWorld.value.set(ax, az, -ay).normalize();
  }
  FX_UNIFORMS.uFxSunAmt.value = indoor ? 0 : 1 - _env.night;
  // Display calibration on EVERY render path (see the tier-1 header note): the
  // renderer carries the composer exposure (index.js sets it with the
  // atmosphere composer; without one it stays 1 ⇒ factor 1). The late hook
  // keeps writing the same values each frame where it runs.
  try {
    const r = globalThis.window?.liveScene3d?.renderer;
    if (r && Number.isFinite(r.toneMappingExposure) && _live) {
      FX_UNIFORMS.uFxAlphaCal.value = particleAlphaCalEnabled() ? particleAlphaCalFor(r.toneMappingExposure) : 1;
      FX_UNIFORMS.uFxAddCal.value = particleAddCalFor(r.toneMappingExposure, _liveAddK());
    }
    // Tier 2 `?fxClamp`: the pixel height a projected radius is measured in
    // (the late pass refines it to its own target before drawing).
    if (r && typeof r.getDrawingBufferSize === "function") {
      r.getDrawingBufferSize(_bufSize);
      if (_bufSize.y > 0) FX_UNIFORMS.uFxViewH.value = _bufSize.y;
    }
  } catch (_) { /* keep the last values */ }
}

// ---------------------------------------------------------------------------
// Shader patch
// ---------------------------------------------------------------------------

export const FX_KEY_ADDITIVE = "hbParticleFxAdd1";
export const FX_KEY_ALPHA = "hbParticleFxAlpha1";

const VERT_PARS = /* glsl */`
uniform highp sampler2D uFxTable;
uniform float uFxTime;
uniform vec3 uFxLight;
varying vec4 vFxA;
varying vec4 vFxB;
varying vec4 vFxC;
varying vec4 vFxD;
varying float vFxE;
#ifdef HB_FX_SMOKE
varying vec4 vFxF;   // sunLit, noise, flow, sun visibility (CSM tap mixed by the shadow amount)
varying vec4 vFxG;   // rim, age, 0, 0
#endif
#ifdef HB_FX_GLOW
varying float vFxGlow;
#endif
#if defined( HB_FX_MOTION ) || defined( HB_FX_CLAMP )
uniform float uFxStretchT;
uniform float uFxViewH;
uniform float uFxMinPx;
#endif
#ifdef HB_FX_SHAPES
varying vec4 vFxSh;  // shape, spikes, halo, spin direction
varying vec3 vFxSC;  // the analytic sprite's energy-matched colour
#endif
#ifdef HB_FX_CSM
uniform highp sampler2DShadow uFxCsm0;
uniform highp sampler2DShadow uFxCsm1;
uniform highp sampler2DShadow uFxCsm2;
uniform mat4 uFxCsmM0;
uniform mat4 uFxCsmM1;
uniform mat4 uFxCsmM2;
uniform vec2 uFxCsmSplits;
uniform float uFxCsmFar;
float hbFxCsmTap( highp sampler2DShadow sm, mat4 m, vec3 wp ) {
	vec4 sc = m * vec4( wp, 1.0 );
	sc.xyz /= max( sc.w, 1e-6 );
	if ( sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0 ) return 1.0;
	return texture( sm, vec3( sc.xy, sc.z - 0.0015 ) );
}
float hbFxCsm( vec3 wp, float viewDepth ) {
	if ( viewDepth > uFxCsmFar ) return 1.0;
	if ( viewDepth < uFxCsmSplits.x ) return hbFxCsmTap( uFxCsm0, uFxCsmM0, wp );
	if ( viewDepth < uFxCsmSplits.y ) return hbFxCsmTap( uFxCsm1, uFxCsmM1, wp );
	return hbFxCsmTap( uFxCsm2, uFxCsmM2, wp );
}
#endif
float hbFxHash( float p ) {
	p = fract( p * 0.1031 );
	p *= p + 33.33;
	p *= p + p;
	return fract( p );
}
`;

// Runs right after <color_vertex>: everything constant per particle.
const VERT_BODY = /* glsl */`
#if ( defined( HB_FX_MOTION ) || defined( HB_FX_CLAMP ) ) && defined( USE_INSTANCING )
	// tier 2: the instance matrix's bottom row carries the particle's velocity
	// (particle_manager.js _appendInstances, _scene-local m/s). Strip it before
	// any chunk multiplies a position by the matrix — every later use of
	// instanceMatrix (project_vertex, worldpos_vertex, the depth stage) reads
	// the stripped copy through the macro.
	mat4 hbFxIm = instanceMatrix;
	vec3 hbFxVel = vec3( hbFxIm[ 0 ][ 3 ], hbFxIm[ 1 ][ 3 ], hbFxIm[ 2 ][ 3 ] );
	hbFxIm[ 0 ][ 3 ] = 0.0;
	hbFxIm[ 1 ][ 3 ] = 0.0;
	hbFxIm[ 2 ][ 3 ] = 0.0;
	float hbFxStretchK = 0.0;
	#define instanceMatrix hbFxIm
#endif
#ifdef USE_INSTANCING_COLOR
	{
		float fxB = instanceColor.b;
		float fxRowF = floor( fxB );
		float fxSeed = clamp( fxB - fxRowF, 0.0, 0.999 );
		int fxRow = int( fxRowF );
		vec4 p0 = texelFetch( uFxTable, ivec2( 0, fxRow ), 0 ); // gain, core, sat, tintCurve
		vec4 p1 = texelFetch( uFxTable, ivec2( 1, fxRow ), 0 ); // tint0.rgb, fadeIn
		vec4 p2 = texelFetch( uFxTable, ivec2( 2, fxRow ), 0 ); // tint1.rgb, fadeOut
		vec4 p3 = texelFetch( uFxTable, ivec2( 3, fxRow ), 0 ); // erode, flicker, flickerHz, twinkle
		vec4 p4 = texelFetch( uFxTable, ivec2( 4, fxRow ), 0 ); // spin, wobble, soft, nearFade
		vec4 p5 = texelFetch( uFxTable, ivec2( 5, fxRow ), 0 ); // lit, pulse, pulseHz, edgeSoft
		float fxAge = clamp( instanceColor.g, 0.0, 1.0 );
		float fxT = uFxTime;
		vec3 fxCol = mix( p1.rgb, p2.rgb, pow( fxAge, max( p0.w, 0.01 ) ) ) * p0.x;
		// flicker: smooth value noise, per-particle phase
		float fxN = fxT * p3.z + fxSeed * 37.0;
		float fxI = floor( fxN );
		float fxF = fract( fxN );
		float fxNoise = mix( hbFxHash( fxI ), hbFxHash( fxI + 1.0 ), fxF * fxF * ( 3.0 - 2.0 * fxF ) );
		fxCol *= 1.0 + p3.y * ( 2.0 * fxNoise - 1.0 );
		// twinkle: brief sharp glints (phase wrapped before sin — precision)
		float fxTw = sin( fract( fxT * p3.z * 0.7 + fxSeed * 5.3 ) * 6.2831853 );
		fxCol *= 1.0 + p3.w * 2.5 * pow( max( fxTw, 0.0 ), 24.0 );
		// pulse: smooth breathing
		fxCol *= 1.0 + p5.y * sin( fract( fxT * p5.z + fxSeed ) * 6.2831853 );
		// scene light (non-emissive sprites)
		fxCol *= mix( vec3( 1.0 ), uFxLight, clamp( p5.x, 0.0, 1.0 ) );
		float fxAm = 1.0;
		if ( p1.w > 0.0 ) fxAm *= smoothstep( 0.0, p1.w, fxAge );
		if ( p2.w > 0.0 ) fxAm *= 1.0 - smoothstep( 1.0 - p2.w, 1.0, fxAge );
		vFxA = vec4( fxCol, fxAm );
		// Erosion window: fully open at birth (threshold 0), closing to
		// erode + w at death, so texels below erode (perceived energy) are
		// gone by then and none is dimmed early.
		float fxErW = 0.10 + 0.12 * ( 1.0 - clamp( p3.x, 0.0, 1.0 ) );
		vFxB = vec4( p0.y, p0.z, p3.x > 0.0 ? ( p3.x + fxErW ) * pow( fxAge, 1.5 ) : 0.0, fxErW );
		float fxDir = fxSeed < 0.5 ? -1.0 : 1.0;
		float fxRate = 0.6 + 0.8 * fract( fxSeed * 7.31 );
		float fxSpinOn = step( 1e-4, p4.x );
		float fxAng = fxSpinOn * ( fxSeed * 6.2831853 + fxDir * fxRate * p4.x * 6.2831853 * fxAge );
		vFxC = vec4( cos( fxAng ), sin( fxAng ), p4.y, fxSeed );
		vFxD = vec4( p4.z, p4.w, fxSpinOn, 0.0 );
		vFxE = p5.w;
	#ifdef HB_FX_SMOKE
		vec4 p7 = texelFetch( uFxTable, ivec2( 7, fxRow ), 0 ); // kidLife, kidSpread, kidGain, rim
		vec4 p8 = texelFetch( uFxTable, ivec2( 8, fxRow ), 0 ); // sunLit, noise, flow, shadow
		vFxF = p8;   // .w = shadow AMOUNT here; becomes the visibility after <project_vertex>
		vFxG = vec4( p7.w, fxAge, 0.0, 0.0 );
	#endif
	#ifdef HB_FX_GLOW
		vFxGlow = texelFetch( uFxTable, ivec2( 6, fxRow ), 0 ).x; // glow, kids, kidKind, kidSize
	#endif
	#if defined( HB_FX_MOTION ) || defined( HB_FX_SHAPES )
		vec4 p10 = texelFetch( uFxTable, ivec2( 10, fxRow ), 0 ); // stretch, shape, spikes, bounce
	#endif
	#if defined( HB_FX_MOTION ) && defined( USE_INSTANCING )
		hbFxStretchK = p10.x;
	#endif
	#ifdef HB_FX_SHAPES
		vec4 p11 = texelFetch( uFxTable, ivec2( 11, fxRow ), 0 ); // sprite.rgb, halo
		vFxSh = vec4( p10.y, p10.z, p11.w, fxDir );
		vFxSC = p11.rgb;
	#endif
	}
#else
	vFxA = vec4( 1.0 );
	vFxB = vec4( 0.0, 1.0, 0.0, 1.0 );
	vFxC = vec4( 1.0, 0.0, 0.0, 0.0 );
	vFxD = vec4( 0.0 );
	vFxE = 0.0;
	#ifdef HB_FX_SMOKE
	vFxF = vec4( 0.0 );
	vFxG = vec4( 0.0 );
	#endif
	#ifdef HB_FX_GLOW
	vFxGlow = 0.0;
	#endif
	#ifdef HB_FX_SHAPES
	vFxSh = vec4( 0.0 );
	vFxSC = vec3( 0.0 );
	#endif
#endif
`;

// After <project_vertex>: the tier-2 sub-pixel clamp and velocity stretch
// (they move the vertex, so they run first); view depth for the soft / near
// terms; the per-particle sun-shadow tap (`?fxSmoke` + CSM); the glow variant
// drops glow-less rows.
const VERT_DEPTH = /* glsl */`
#if ( defined( HB_FX_MOTION ) || defined( HB_FX_CLAMP ) ) && defined( USE_INSTANCING )
	{
		// work on the vertex's offset from the particle centre, in view space
		vec4 hbC = modelViewMatrix * ( hbFxIm * vec4( 0.0, 0.0, 0.0, 1.0 ) );
		vec3 hbOff = mvPosition.xyz - hbC.xyz;
		float hbR = length( hbOff ) * 0.70710678; // a centred quad's half-size (its corners)
		float hbE = 1.0;
		bool hbMod = false;
	#ifdef HB_FX_CLAMP
		{
			// sub-pixel clamp: at least uFxMinPx projected radius, the opacity
			// cut by the area ratio (the same light, no popping)
			float hbW = isPerspectiveMatrix( projectionMatrix ) ? max( -hbC.z, 1e-4 ) : 1.0;
			float hbPx = hbR * projectionMatrix[ 1 ][ 1 ] / hbW * 0.5 * uFxViewH;
			if ( hbPx > 1e-6 && hbPx < uFxMinPx ) {
				float hbK = uFxMinPx / hbPx;
				hbOff *= hbK;
				hbR *= hbK;
				hbE /= hbK * hbK;
				hbMod = true;
			}
		}
	#endif
	#ifdef HB_FX_MOTION
		if ( hbFxStretchK > 0.0 && hbR > 1e-5 ) {
			// velocity stretch: lengthen the quad along its screen-plane velocity
			// by |v| x uFxStretchT x stretch — head at the particle, tail behind;
			// the opacity is partly conserved over the longer streak
			vec3 hbV = ( modelViewMatrix * vec4( hbFxVel, 0.0 ) ).xyz;
			vec3 hbN = normalize( hbC.xyz );
			vec3 hbVp = hbV - hbN * dot( hbV, hbN );
			float hbSp = length( hbVp );
			if ( hbSp > 1e-3 ) {
				vec3 hbDir = hbVp / hbSp;
				float hbL = min( hbSp * uFxStretchT * hbFxStretchK, hbR * 14.0 );
				float hbS = 1.0 + hbL / ( 2.0 * hbR );
				hbOff += hbDir * ( dot( hbOff, hbDir ) * ( hbS - 1.0 ) - 0.5 * hbL );
				hbE /= mix( 1.0, hbS, 0.5 );
				hbMod = true;
			}
		}
	#endif
		if ( hbMod ) {
			mvPosition = vec4( hbC.xyz + hbOff, 1.0 );
			gl_Position = projectionMatrix * mvPosition;
			vFxA.a *= hbE;
		}
	}
#endif
	vFxD.w = gl_Position.w;
#ifdef HB_FX_SMOKE
	{
		float fxShAmt = clamp( vFxF.w, 0.0, 1.0 );
		float fxVis = 1.0;
	#if defined( HB_FX_CSM ) && defined( USE_INSTANCING )
		if ( fxShAmt > 0.0 ) {
			vec4 fxCw = modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
			vec4 fxCv = viewMatrix * fxCw;
			fxVis = hbFxCsm( fxCw.xyz, -fxCv.z );
		}
	#endif
		vFxF.w = mix( 1.0, fxVis, fxShAmt );
	}
#endif
#ifdef HB_FX_GLOW
	if ( vFxGlow <= 0.0 ) gl_Position = vec4( 0.0, 0.0, 2.0, 1.0 );
#endif
`;

const FRAG_PARS = /* glsl */`
uniform float uFxTime;
uniform float uFxSoftOn;
uniform float uFxAlphaCal;
uniform float uFxAddCal;
uniform highp sampler2D uFxSceneW;
uniform vec2 uFxInvRes;
varying vec4 vFxA;
varying vec4 vFxB;
varying vec4 vFxC;
varying vec4 vFxD;
varying float vFxE;
#ifdef HB_FX_SMOKE
uniform highp sampler2D uFxNoise;
uniform vec3 uFxSunWorld;
uniform float uFxSunAmt;
varying vec4 vFxF;
varying vec4 vFxG;
#endif
#ifdef HB_FX_GLOW
uniform highp sampler2D uFxGlowDepth;
uniform vec2 uFxGlowRes;
uniform float uFxGlowLogFar;
uniform float uFxGlowIsLog;
uniform vec2 uFxGlowNearFar;
uniform float uFxGlowScale;
varying float vFxGlow;
#endif
#ifdef HB_FX_SHAPES
varying vec4 vFxSh;
varying vec3 vFxSC;
// Tier-2 analytic sprites. MIRRORED by tools/particle-fx/tier2.py (the energy
// match): change a constant here, change it there.
vec4 hbFxAnalytic( vec2 uv ) {
	vec2 p = uv * 2.0 - 1.0;
	float r = length( p );
	float fw = max( fwidth( r ), 1e-4 );
	float edge = 1.0 - smoothstep( 0.80, 1.0, r );
	float H = vFxSh.z;
	vec3 I;
	if ( vFxSh.x < 1.5 ) {
		// star: a crisp core, an exponential halo, diffraction spikes turning
		// slowly with the seed, a slight chromatic split along them
		float core = 1.0 - smoothstep( 0.07 - fw, 0.07 + fw, r );
		float m = max( 1.0, floor( vFxSh.y * 0.5 + 0.5 ) );
		float ang = vFxC.w * 6.2831853 + uFxTime * 0.25 * vFxSh.w * ( 0.5 + vFxC.w );
		vec3 S = vec3( 0.0 );
		for ( int i = 0; i < 3; i++ ) {
			if ( float( i ) >= m ) break;
			float a = ang + float( i ) * 3.14159265 / m;
			vec2 ax = vec2( cos( a ), sin( a ) );
			float al = abs( dot( p, ax ) );
			float ac = abs( dot( p, vec2( -ax.y, ax.x ) ) );
			vec3 ws = ( 0.028 + 0.035 * al ) * vec3( 1.08, 1.0, 0.9 );
			float fall = max( 1.0 - al, 0.0 );
			S = max( S, exp( -( ac * ac ) / ( ws * ws ) ) * fall * fall );
		}
		I = vec3( 1.6 * core + 0.75 * exp( -r * H ) ) + 0.85 * S;
	} else if ( vFxSh.x < 2.5 ) {
		// orb: a crisp core in a gaussian halo
		float core = 1.0 - smoothstep( 0.16 - fw, 0.16 + fw, r );
		I = vec3( core + 0.85 * exp( -r * r * H ) );
	} else {
		// ring (the portal rim): a crisp glowing ring with swirling arms
		float d = abs( r - 0.74 );
		float ring = 1.0 - smoothstep( 0.03 - fw, 0.03 + fw, d );
		float th = r > 1e-4 ? atan( p.y, p.x ) : 0.0;
		float arms = 0.62 + 0.38 * sin( 5.0 * th + 6.0 * log( r + 0.06 ) - uFxTime * 1.6 + vFxC.w * 6.2831853 );
		float inner = 0.10 * ( 1.0 - smoothstep( 0.64, 0.74, r ) ) * ( 0.6 + 0.4 * arms );
		I = vec3( 1.35 * ring + 0.7 * exp( -d * H ) * arms + inner );
	}
	I *= edge;
	#ifdef HB_FX_ADDITIVE
	return vec4( vFxSC * I, 1.0 );
	#else
	return vec4( vFxSC, clamp( max( max( I.r, I.g ), I.b ), 0.0, 1.0 ) );
	#endif
}
#endif
`;

// Replaces <map_fragment>: spin (masked to the texture square) + wobble
// (+ the `?fxSmoke` curl flow).
const FRAG_MAP = /* glsl */`
#ifdef USE_MAP
	vec2 fxUv = vMapUv;
	float fxInside = 1.0;
	if ( vFxD.z > 0.5 ) {
		vec2 fxD = fxUv - 0.5;
		fxUv = vec2( vFxC.x * fxD.x - vFxC.y * fxD.y, vFxC.y * fxD.x + vFxC.x * fxD.y ) + 0.5;
	}
	if ( vFxC.z > 0.0 ) {
		fxUv += vFxC.z * vec2(
			sin( fxUv.y * 11.0 + uFxTime * 4.3 + vFxC.w * 31.0 ),
			cos( fxUv.x * 9.0 + uFxTime * 3.7 + vFxC.w * 17.0 ) );
	}
	#ifdef HB_FX_SMOKE
	if ( vFxF.z > 0.0 ) {
		// curl flow: advect the lookup along a divergence-free field that
		// scrolls with time (licking flames, roiling smoke)
		vec2 fxFl = texture2D( uFxNoise, vMapUv * 0.55 + vec2( vFxC.w * 5.17, vFxC.w * 2.31 - uFxTime * 0.045 ) ).ba * 2.0 - 1.0;
		fxUv += fxFl * vFxF.z;
	}
	#endif
	if ( vFxD.z > 0.5 ) {
		vec2 fxE = step( vec2( 0.0 ), fxUv ) * step( fxUv, vec2( 1.0 ) );
		fxInside = fxE.x * fxE.y;
	}
	#ifdef HB_FX_SHAPES
	// tier 2: an analytic star / orb / ring instead of the texture (rows with
	// a shape; the condition is constant per particle)
	vec4 sampledDiffuseColor;
	if ( vFxSh.x > 0.5 ) sampledDiffuseColor = hbFxAnalytic( fxUv );
	else sampledDiffuseColor = texture2D( map, fxUv );
	#else
	vec4 sampledDiffuseColor = texture2D( map, fxUv );
	#endif
	diffuseColor *= sampledDiffuseColor;
	diffuseColor.a *= fxInside;
	// edgeSoft: fade toward the quad border (full-UV sprites whose texture
	// still carries energy at its edge would otherwise show a hard square).
	if ( vFxE > 0.0 ) {
		vec2 fxEd = min( vMapUv, 1.0 - vMapUv );
		diffuseColor.a *= smoothstep( 0.0, vFxE, min( fxEd.x, fxEd.y ) );
	}
#endif
`;

// Replaces <color_fragment>: colour, erosion, soft + near fades, opacity
// (+ the `?fxSmoke` noise / sun / shadow / rim terms, + the glow output).
const FRAG_COLOR = /* glsl */`
	{
		vec3 fxTex = diffuseColor.rgb;
		float fxMx = max( max( fxTex.r, fxTex.g ), fxTex.b );
		float fxMxP = sqrt( fxMx ); // perceptual (≈ sRGB) brightness of the texel
	#ifdef HB_FX_ADDITIVE
		// Perceptual (≈ sRGB) energy: the texel is linear here, so a mid-grey
		// 0.5 sRGB texel reads 0.21 — thresholding that ate whole puffs.
		float fxEnergy = fxMxP * diffuseColor.a;
	#else
		float fxEnergy = diffuseColor.a;
	#endif
		float fxLum = dot( fxTex, vec3( 0.2126, 0.7152, 0.0722 ) );
		vec3 fxC = mix( vec3( fxLum ), fxTex, vFxB.y );
		fxC *= 1.0 + vFxB.x * smoothstep( 0.45, 1.0, fxMxP );
		fxC *= vFxA.rgb;
		float fxA = diffuseColor.a * vFxA.a;
		float fxThr = vFxB.z;
		float fxThrW = vFxB.w;
	#ifdef HB_FX_SMOKE
		if ( vFxF.y > 0.0 ) {
			// noise breakup + erosion: the sprite dissolves into wisps, not
			// as a shrinking blob (two octaves of the shared tileable noise,
			// a per-particle offset, drifting over life)
			vec2 fxNuv = vMapUv * 0.85 + vec2( vFxC.w * 7.13, vFxC.w * 3.71 + vFxG.y * 0.35 );
			float fxN = texture2D( uFxNoise, fxNuv ).r * 0.65 + texture2D( uFxNoise, fxNuv * 2.3 + 0.37 ).g * 0.35;
			fxEnergy *= mix( 1.0, 0.25 + 1.5 * fxN, vFxF.y );
			fxA *= mix( 1.0, 0.55 + 0.9 * fxN, vFxF.y * 0.6 );
			float fxThrN = vFxF.y * 0.3 * pow( vFxG.y, 1.4 );
			if ( fxThrN > fxThr ) { fxThr = fxThrN; fxThrW = 0.12; }
		}
		if ( vFxF.x > 0.0 || vFxG.x > 0.0 || vFxF.w < 1.0 ) {
			vec3 fxSunV = normalize( ( viewMatrix * vec4( uFxSunWorld, 0.0 ) ).xyz );
			float fxSh = 1.0;
			if ( vFxF.x > 0.0 ) {
				// pseudo-normal: the screen gradient of the sprite's own density
				// (alpha), per sprite-UV unit; +z faces the camera
				float fxAl = diffuseColor.a;
				vec2 fxG = vec2( dFdx( fxAl ), dFdy( fxAl ) ) / max( length( fwidth( vMapUv ) ), 1e-5 );
				vec3 fxN3 = normalize( vec3( -fxG * 0.35, 1.0 ) );
				float fxW = clamp( dot( fxN3, fxSunV ) * 0.5 + 0.5, 0.0, 1.0 );
				fxSh = mix( 1.0, 0.45 + 0.9 * fxW, vFxF.x * uFxSunAmt );
			}
			// sun shadow (vFxF.w = 1 lit .. 0 shadowed, already scaled by the amount)
			fxSh *= mix( 1.0, 0.5 + 0.5 * vFxF.w, uFxSunAmt );
			fxC *= fxSh;
			if ( vFxG.x > 0.0 ) {
				// forward scatter: thin, back-lit edges glow when looking toward the sun
				float fxFs = pow( clamp( -fxSunV.z, 0.0, 1.0 ), 4.0 ) * ( 1.0 - clamp( fxA, 0.0, 1.0 ) );
				fxC *= 1.0 + 1.6 * vFxG.x * fxFs * uFxSunAmt * vFxF.w;
			}
		}
	#endif
		if ( fxThr > 0.0 ) fxA *= smoothstep( fxThr - fxThrW, fxThr, fxEnergy );
	#ifndef HB_FX_GLOW
		if ( vFxD.x > 0.0 && uFxSoftOn > 0.5 ) {
			float fxSceneW = texture2D( uFxSceneW, gl_FragCoord.xy * uFxInvRes ).r;
			fxA *= clamp( ( fxSceneW - vFxD.w ) / vFxD.x, 0.0, 1.0 );
		}
	#endif
		if ( vFxD.y > 0.0 ) fxA *= smoothstep( 0.35 * vFxD.y, vFxD.y, vFxD.w );
	#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
		#ifdef HB_FX_ADDITIVE
		fxC *= vColor.r * uFxAddCal;
		#else
		fxA *= vColor.r;
		fxC *= uFxAlphaCal;
		#endif
	#endif
	#ifdef HB_FX_GLOW
		{
			// the glow buffer has no depth attachment: occlude against the
			// scene depth by hand (a 0.5 m soft edge)
			float fxGd = texture2D( uFxGlowDepth, gl_FragCoord.xy / uFxGlowRes ).x;
			float fxGw;
			if ( fxGd >= 0.999999 ) fxGw = 1e7;
			else if ( uFxGlowIsLog > 0.5 ) fxGw = exp2( fxGd * uFxGlowLogFar ) - 1.0;
			else {
				float fxZ = fxGd * 2.0 - 1.0;
				fxGw = ( 2.0 * uFxGlowNearFar.x * uFxGlowNearFar.y ) / ( uFxGlowNearFar.y + uFxGlowNearFar.x - fxZ * ( uFxGlowNearFar.y - uFxGlowNearFar.x ) );
			}
			fxC *= vFxGlow * uFxGlowScale * clamp( 1.0 - ( vFxD.w - fxGw ) * 2.0, 0.0, 1.0 );
		}
	#endif
		diffuseColor = vec4( fxC, fxA );
	}
`;

/** Rewrite a MeshBasicMaterial shader object in place. Returns true when every anchor matched. */
export function patchParticleFxShader(shader) {
  if (!shader || typeof shader.vertexShader !== "string" || typeof shader.fragmentShader !== "string") return false;
  const v = shader.vertexShader;
  const f = shader.fragmentShader;
  const anchors = [
    v.includes("#include <common>"), v.includes("#include <color_vertex>"), v.includes("#include <project_vertex>"),
    f.includes("#include <common>"), f.includes("#include <map_fragment>"), f.includes("#include <color_fragment>"),
  ];
  if (anchors.some((a) => !a)) return false;
  shader.vertexShader = v
    .replace("#include <common>", `#include <common>\n${VERT_PARS}`)
    .replace("#include <color_vertex>", `#include <color_vertex>\n${VERT_BODY}`)
    .replace("#include <project_vertex>", `#include <project_vertex>\n${VERT_DEPTH}`);
  shader.fragmentShader = f
    .replace("#include <common>", `#include <common>\n${FRAG_PARS}`)
    .replace("#include <map_fragment>", FRAG_MAP)
    .replace("#include <color_fragment>", FRAG_COLOR);
  shader.uniforms.uFxTable = FX_UNIFORMS.uFxTable;
  shader.uniforms.uFxTime = FX_UNIFORMS.uFxTime;
  shader.uniforms.uFxLight = FX_UNIFORMS.uFxLight;
  shader.uniforms.uFxSoftOn = FX_UNIFORMS.uFxSoftOn;
  shader.uniforms.uFxAlphaCal = FX_UNIFORMS.uFxAlphaCal;
  shader.uniforms.uFxAddCal = FX_UNIFORMS.uFxAddCal;
  shader.uniforms.uFxSceneW = FX_UNIFORMS.uFxSceneW;
  shader.uniforms.uFxInvRes = FX_UNIFORMS.uFxInvRes;
  // tier 1 (bound always; three uploads only what the program declares)
  shader.uniforms.uFxNoise = FX_UNIFORMS.uFxNoise;
  shader.uniforms.uFxSunWorld = FX_UNIFORMS.uFxSunWorld;
  shader.uniforms.uFxSunAmt = FX_UNIFORMS.uFxSunAmt;
  shader.uniforms.uFxGlowDepth = FX_UNIFORMS.uFxGlowDepth;
  shader.uniforms.uFxGlowRes = FX_UNIFORMS.uFxGlowRes;
  shader.uniforms.uFxGlowLogFar = FX_UNIFORMS.uFxGlowLogFar;
  shader.uniforms.uFxGlowIsLog = FX_UNIFORMS.uFxGlowIsLog;
  shader.uniforms.uFxGlowNearFar = FX_UNIFORMS.uFxGlowNearFar;
  shader.uniforms.uFxGlowScale = FX_UNIFORMS.uFxGlowScale;
  // tier 2 (bound always; three uploads only what the program declares)
  shader.uniforms.uFxStretchT = FX_UNIFORMS.uFxStretchT;
  shader.uniforms.uFxViewH = FX_UNIFORMS.uFxViewH;
  shader.uniforms.uFxMinPx = FX_UNIFORMS.uFxMinPx;
  // the CSM's own shared uniform set (csm.js `csmState.uniforms`), BY IDENTITY:
  // refreshCsmUniforms rewrites it every frame
  const cu = _csmUniforms;
  if (cu) {
    shader.uniforms.uFxCsm0 = cu.uCsmShadowMap0;
    shader.uniforms.uFxCsm1 = cu.uCsmShadowMap1;
    shader.uniforms.uFxCsm2 = cu.uCsmShadowMap2;
    shader.uniforms.uFxCsmM0 = cu.uCsmMatrix0;
    shader.uniforms.uFxCsmM1 = cu.uCsmMatrix1;
    shader.uniforms.uFxCsmM2 = cu.uCsmMatrix2;
    shader.uniforms.uFxCsmSplits = cu.uCsmSplits;
    shader.uniforms.uFxCsmFar = cu.uCsmFar;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Tier-1 compile-time variants (decided ONCE, at the first FX material: a
// bucket built later must not create a second program family)
// ---------------------------------------------------------------------------
let _smokeOn = null;
let _csmUniforms = null;
function _tier1Variant() {
  if (_smokeOn === null) {
    _smokeOn = fxTier1Enabled("fxSmoke");
    if (_smokeOn) {
      try {
        const u = globalThis.window?.liveScene3d?.csmState?.uniforms ?? null;
        _csmUniforms = u && u.uCsmShadowMap0 && u.uCsmMatrix0 && u.uCsmSplits && u.uCsmFar ? u : null;
      } catch (_) { _csmUniforms = null; }
      if (!FX_UNIFORMS.uFxNoise.value) FX_UNIFORMS.uFxNoise.value = particleFxNoiseTexture();
    }
  }
  return { smoke: _smokeOn, csm: _smokeOn && !!_csmUniforms };
}
/** Test seam: forget the latched variant (`smoke`/`csmUniforms` force it). */
export function _setParticleFxVariantForTest(smoke = null, csmUniforms = null) {
  _smokeOn = smoke;
  _csmUniforms = csmUniforms;
  if (smoke && !FX_UNIFORMS.uFxNoise.value) FX_UNIFORMS.uFxNoise.value = particleFxNoiseTexture();
}

// Tier 2 (`?fxMotion` / `?fxShapes` / `?fxClamp`): latched with the same rule —
// at the first FX material of the session, so no bucket built later can start
// a second program family.
let _tier2 = null;
function _tier2Variant() {
  if (_tier2 === null) {
    _tier2 = Object.freeze({
      motion: fxTier2Enabled("fxMotion"),
      shapes: fxTier2Enabled("fxShapes"),
      clamp: fxTier2Enabled("fxClamp"),
    });
  }
  return _tier2;
}
/** Test seam: force (`{motion, shapes, clamp}`) or forget (`null`) the latched tier-2 variant. */
export function _setParticleFxTier2VariantForTest(v = null) {
  _tier2 = v ? Object.freeze({ motion: !!v.motion, shapes: !!v.shapes, clamp: !!v.clamp }) : null;
}
/** The latched tier-2 variant (latches it when no FX material exists yet). */
export function particleFxTier2Variant() { return _tier2Variant(); }
/**
 * True when the FX programs carry HB_FX_MOTION, i.e. the manager must write
 * each stretch row's velocity into the instance matrix's bottom row (and the
 * programs strip it). Never write it otherwise: a program WITHOUT the variant
 * would read the row as projective w.
 */
export function particleFxMotionOn() { return _tier2Variant().motion; }

function _tier2Suffix() {
  const t = _tier2Variant();
  return (t.motion ? "m" : "") + (t.shapes ? "a" : "") + (t.clamp ? "p" : "");
}
function _applyTier2Defines(defines) {
  const t = _tier2Variant();
  if (t.motion) defines.HB_FX_MOTION = ""; else delete defines.HB_FX_MOTION;
  if (t.shapes) defines.HB_FX_SHAPES = ""; else delete defines.HB_FX_SHAPES;
  if (t.clamp) defines.HB_FX_CLAMP = ""; else delete defines.HB_FX_CLAMP;
  return defines;
}

/** The program cache key a bucket material gets (constant per session and blend). */
export function particleFxProgramKey(additive) {
  const v = _tier1Variant();
  return (additive ? FX_KEY_ADDITIVE : FX_KEY_ALPHA) + (v.smoke ? "s" : "") + (v.csm ? "c" : "") + _tier2Suffix();
}

let _patchWarned = false;
/**
 * Turn a bucket material (a MeshBasicMaterial clone already configured for its
 * blend branch) into the FX material. Additive: opacity stays folded into rgb.
 * Alpha: replaces the `hbParticleInstAlpha` patch (same alpha-from-vColor.r
 * rule, same alphaTest/depthWrite state the bucket configurator set).
 * @returns {boolean} true if the material is now an FX material
 */
export function applyParticleFxMaterial(mat, { additive }) {
  if (!mat || mat.isMeshBasicMaterial !== true || mat.wireframe === true) return false;
  if (!FX_UNIFORMS.uFxTable.value) FX_UNIFORMS.uFxTable.value = particleFxTable();
  mat.vertexColors = true; // USE_COLOR ⇒ vColor reaches the fragment stage
  mat.defines = { ...(mat.defines || {}) };
  if (additive) mat.defines.HB_FX_ADDITIVE = "";
  else delete mat.defines.HB_FX_ADDITIVE;
  // tier 1 `?fxSmoke` (+ the CSM sun-shadow tap when the cascades are live)
  const variant = _tier1Variant();
  if (variant.smoke) mat.defines.HB_FX_SMOKE = "";
  else delete mat.defines.HB_FX_SMOKE;
  if (variant.csm) mat.defines.HB_FX_CSM = "";
  else delete mat.defines.HB_FX_CSM;
  // tier 2 `?fxMotion` / `?fxShapes` / `?fxClamp`
  _applyTier2Defines(mat.defines);
  const key = particleFxProgramKey(additive);
  mat.onBeforeCompile = function hbParticleFx(shader) {
    if (!patchParticleFxShader(shader) && !_patchWarned) {
      _patchWarned = true;
      // eslint-disable-next-line no-console
      console.warn("[particle_fx] three's MeshBasicMaterial chunks changed shape; particle upgrade left out (stock shader).");
    }
  };
  mat.customProgramCacheKey = () => key;
  mat.userData.__particleFx = additive ? "add" : "alpha";
  mat.needsUpdate = true;
  return true;
}

// ---------------------------------------------------------------------------
// Tier 1 `?fxGlow` — the glow variant
// ---------------------------------------------------------------------------

export const FX_KEY_GLOW = "hbParticleFxGlow1";

/**
 * The glow-variant material for an additive FX bucket: same texture, same
 * profile row, same calibration — draws `glow` x the particle's colour into
 * the half-res glow buffer (vfx/fx_glow_effect.js), occluded by hand against
 * the scene depth (no depth attachment there). One constant program.
 * @returns {THREE.MeshBasicMaterial|null}
 */
export function makeParticleFxGlowMaterial(bucketMat) {
  if (!bucketMat || bucketMat.isMeshBasicMaterial !== true) return null;
  if (!FX_UNIFORMS.uFxTable.value) FX_UNIFORMS.uFxTable.value = particleFxTable();
  const m = new THREE.MeshBasicMaterial({
    map: bucketMat.map ?? null,
    color: bucketMat.color ? bucketMat.color.clone() : new THREE.Color(1, 1, 1),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    side: bucketMat.side,
    vertexColors: true,
    fog: false,
    toneMapped: false,
  });
  m.forceSinglePass = true;
  // The tier-2 variant rides along: the twin shares the bucket's instance
  // matrices, whose bottom row carries velocity under HB_FX_MOTION — a glow
  // program without the variant would read it as projective w.
  m.defines = _applyTier2Defines({ HB_FX_ADDITIVE: "", HB_FX_GLOW: "" });
  m.onBeforeCompile = function hbParticleFxGlow(shader) { patchParticleFxShader(shader); };
  const glowKey = FX_KEY_GLOW + _tier2Suffix();
  m.customProgramCacheKey = () => glowKey;
  m.name = "particle-fx-glow";
  m.userData = { __particleFxGlow: true };
  return m;
}

/**
 * Per-frame glow inputs (the glow effect calls this through the provider
 * before it draws): scene depth, glow-target size, depth decode, strength.
 */
export function setParticleFxGlowFrame({ depthTexture, width, height, camera, isLog, scale }) {
  const U = FX_UNIFORMS;
  U.uFxGlowDepth.value = depthTexture || null;
  U.uFxGlowRes.value.set(Math.max(1, width | 0), Math.max(1, height | 0));
  const far = Number.isFinite(camera?.far) && camera.far > 0 ? camera.far : 1000;
  const near = Number.isFinite(camera?.near) && camera.near > 0 ? camera.near : 0.1;
  U.uFxGlowLogFar.value = Math.log2(far + 1);
  U.uFxGlowIsLog.value = isLog === false ? 0 : 1;
  U.uFxGlowNearFar.value.set(near, far);
  if (Number.isFinite(scale)) U.uFxGlowScale.value = Math.max(0, scale);
}

// ---------------------------------------------------------------------------
// Per-instance data
// ---------------------------------------------------------------------------

// xorshift32 — per-particle seeds only need to be stable for one particle's
// life and decorrelated between particles; they never reach the wire.
let _rng = 0x9e3779b9 | 0;
function _nextSeed() {
  _rng ^= _rng << 13; _rng ^= _rng >>> 17; _rng ^= _rng << 5;
  return ((_rng >>> 0) % 999) / 1000; // [0, 0.998]
}

/**
 * Per-slot seed with respawn detection: a slot whose particle's lifetime went
 * DOWN since the last frame holds a new particle (killed + re-emitted), so it
 * draws a fresh seed. Persistent emitters rewrite `birthtime` every update, so
 * birthtime cannot key the seed; lifetime monotonicity can.
 */
export function particleFxSeed(emitter, slot, lifetime) {
  let seeds = emitter._fxSeeds;
  let lives = emitter._fxLives;
  const n = emitter.parts ? emitter.parts.length : 0;
  if (!seeds || seeds.length < n) {
    const ns = new Float32Array(Math.max(n, 1));
    const nl = new Float32Array(Math.max(n, 1)).fill(Infinity);
    if (seeds) { ns.set(seeds); nl.set(lives); }
    for (let i = seeds ? seeds.length : 0; i < ns.length; i++) ns[i] = -1;
    emitter._fxSeeds = seeds = ns;
    emitter._fxLives = lives = nl;
  }
  const lt = Number.isFinite(lifetime) ? lifetime : 0;
  if (seeds[slot] < 0 || lt + 1e-6 < lives[slot]) seeds[slot] = _nextSeed();
  lives[slot] = lt;
  return seeds[slot];
}

/**
 * Tier 2 `?fxMotion`: a slot's velocity (`_scene`-local m/s) from its position
 * history, lightly smoothed. A changed seed (the slot respawned) or a jump over
 * 60 m/s (a respawn the seed missed, a teleport) restarts it at rest; a second
 * call in the same tick returns the last value. `e` = the slot mesh's local
 * matrix elements. Writes `out[0..2]`, returns `out`.
 */
export function particleFxSlotVelocity(emitter, slot, e, seed, nowSec, out) {
  const n = emitter.parts ? emitter.parts.length : 0;
  let c = emitter._fxVel;
  if (!c || c.length < n * 8) {
    const nc = new Float32Array(Math.max(n, 1) * 8).fill(NaN);
    if (c) nc.set(c.subarray(0, Math.min(c.length, nc.length)));
    emitter._fxVel = c = nc;
  }
  const o = slot * 8;
  const x = e[12], y = e[13], z = e[14];
  let vx = 0, vy = 0, vz = 0;
  if (c[o + 4] === seed && Number.isFinite(c[o + 3])) {
    const dt = nowSec - c[o + 3];
    if (!(dt > 1e-4)) {
      out[0] = c[o + 5] || 0; out[1] = c[o + 6] || 0; out[2] = c[o + 7] || 0;
      return out;
    }
    if (dt < 0.5) {
      let rx = (x - c[o]) / dt, ry = (y - c[o + 1]) / dt, rz = (z - c[o + 2]) / dt;
      if (rx * rx + ry * ry + rz * rz > 3600) { rx = 0; ry = 0; rz = 0; }
      const px = c[o + 5], py = c[o + 6], pz = c[o + 7];
      if (Number.isFinite(px) && (px !== 0 || py !== 0 || pz !== 0)) {
        vx = 0.5 * (px + rx); vy = 0.5 * (py + ry); vz = 0.5 * (pz + rz);
      } else {
        vx = rx; vy = ry; vz = rz;
      }
    }
  }
  c[o] = x; c[o + 1] = y; c[o + 2] = z; c[o + 3] = nowSec; c[o + 4] = seed;
  c[o + 5] = vx; c[o + 6] = vy; c[o + 7] = vz;
  out[0] = vx; out[1] = vy; out[2] = vz;
  return out;
}

/** Age in [0, 1] of a particle record. */
export function particleFxAge(p) {
  if (!p || !(p.lifespan > 0)) return 0;
  const a = p.lifetime / p.lifespan;
  return a <= 0 ? 0 : (a >= 1 ? 1 : a);
}

/**
 * The `b` instance channel for an emitter's particle: row + seed (row 0 when
 * the live A/B is off).
 */
export function particleFxPacked(row, seed) {
  return (_live ? (row | 0) : 0) + Math.min(0.999, Math.max(0, seed));
}

// ---------------------------------------------------------------------------
// Soft-particle depth (late pass hooks)
// ---------------------------------------------------------------------------

let _soft = null;
function _softState() {
  if (_soft) return _soft;
  const target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    format: THREE.RedFormat,
    depthBuffer: false,
    stencilBuffer: false,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
  });
  target.texture.name = "particle-fx-scene-w";
  const mat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      tDepth: { value: null },
      uLogFar: { value: 1 },
      uNear: { value: 0.1 },
      uFar: { value: 1000 },
      uIsLog: { value: 1 },
    },
    vertexShader: /* glsl */`
in vec3 position;
out vec2 vUv;
void main() {
	vUv = position.xy * 0.5 + 0.5;
	gl_Position = vec4( position.xy, 0.0, 1.0 );
}`,
    fragmentShader: /* glsl */`
precision highp float;
precision highp sampler2D;
uniform sampler2D tDepth;
uniform float uLogFar;
uniform float uNear;
uniform float uFar;
uniform float uIsLog;
in vec2 vUv;
out vec4 fxOut;
void main() {
	float d = texture( tDepth, vUv ).x;
	float w;
	if ( uIsLog > 0.5 ) {
		w = exp2( d * uLogFar ) - 1.0;
	} else {
		float z = d * 2.0 - 1.0;
		w = ( 2.0 * uNear * uFar ) / ( uFar + uNear - z * ( uFar - uNear ) );
	}
	fxOut = vec4( w, 0.0, 0.0, 1.0 );
}`,
    depthTest: false,
    depthWrite: false,
  });
  // One big triangle covering clip space.
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const mesh = new THREE.Mesh(geom, mat);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  scene.matrixWorldAutoUpdate = false;
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  _soft = { target, mat, scene, cam, w: 0, h: 0, stats: { copies: 0, skipped: 0 } };
  return _soft;
}

/** Diagnostics for the soft-depth copy. */
export function particleFxSoftStats() { return _soft ? { ..._soft.stats, w: _soft.w, h: _soft.h } : null; }

/**
 * Late-pass `before` hook: copy the scene depth to linear view depth and turn
 * the soft term on. Never throws; leaves the soft term off on any failure.
 */
export function particleFxBeforeLate(renderer, depthTexture, camera, width, height) {
  FX_UNIFORMS.uFxSoftOn.value = 0;
  // The late pass only runs under the composer, i.e. where the exposure is
  // applied: keep the alpha calibration in step with the live exposure
  // (`__setExposure`, `?exposure`). Persists for any world-pass draw after.
  if (renderer) {
    FX_UNIFORMS.uFxAlphaCal.value = (_live && particleAlphaCalEnabled())
      ? particleAlphaCalFor(renderer.toneMappingExposure) : 1;
    FX_UNIFORMS.uFxAddCal.value = _live ? particleAddCalFor(renderer.toneMappingExposure, _liveAddK()) : 1;
  }
  if (!particleFxEnabled() || !renderer || !depthTexture || !camera) return false;
  // `low` quality spends nothing on soft particles (the copy is a full-screen
  // pass); every other upgrade term is per-particle ALU and stays on.
  try { if (globalThis.window?.liveScene3d?.quality?.preset === "low") return false; } catch (_) { /* fail open */ }
  const s = _softState();
  try {
    // Size to the late target (the pixels gl_FragCoord addresses in the draw);
    // the depth texture is sampled by normalised UV, so its own size is free.
    const img = depthTexture.image || {};
    const w = (width | 0) > 0 ? (width | 0) : (img.width | 0);
    const h = (height | 0) > 0 ? (height | 0) : (img.height | 0);
    if (w <= 0 || h <= 0) { s.stats.skipped++; return false; }
    if (w !== s.w || h !== s.h) { s.target.setSize(w, h); s.w = w; s.h = h; }
    const far = Number.isFinite(camera.far) && camera.far > 0 ? camera.far : 1000;
    const isLog = renderer.capabilities?.logarithmicDepthBuffer === true;
    const u = s.mat.uniforms;
    u.tDepth.value = depthTexture;
    u.uLogFar.value = Math.log2(far + 1);
    u.uNear.value = Number.isFinite(camera.near) ? camera.near : 0.1;
    u.uFar.value = far;
    u.uIsLog.value = isLog ? 1 : 0;
    const prev = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    try {
      renderer.setRenderTarget(s.target);
      renderer.render(s.scene, s.cam);
    } finally {
      renderer.autoClear = prevAuto;
      renderer.setRenderTarget(prev);
      u.tDepth.value = null;
    }
    FX_UNIFORMS.uFxSceneW.value = s.target.texture;
    FX_UNIFORMS.uFxInvRes.value.set(1 / w, 1 / h);
    FX_UNIFORMS.uFxSoftOn.value = 1;
    // tier 2 `?fxClamp`: measure projected sizes in THIS target's pixels
    FX_UNIFORMS.uFxViewH.value = h;
    s.stats.copies++;
    return true;
  } catch (_) {
    FX_UNIFORMS.uFxSoftOn.value = 0;
    s.stats.skipped++;
    return false;
  }
}

/** Late-pass `after` hook: the soft term is off for every other draw. */
export function particleFxAfterLate() {
  FX_UNIFORMS.uFxSoftOn.value = 0;
}

registerLateFxHooks({ before: particleFxBeforeLate, after: particleFxAfterLate });

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------
if (typeof window !== "undefined") {
  window.__particleFx = (on) => {
    if (on === undefined) {
      return {
        enabled: particleFxEnabled(), live: _live, rows: FX_PROFILE_ROWS.length,
        dids: FX_DID_ROWS.size, named: Object.keys(FX_NAMED_ROWS).length,
        version: FX_PROFILE_VERSION, soft: particleFxSoftStats(),
        light: FX_UNIFORMS.uFxLight.value.toArray(),
        alphaCal: FX_UNIFORMS.uFxAlphaCal.value,
        addCal: FX_UNIFORMS.uFxAddCal.value,
        tier2: _tier2 ? { ..._tier2 } : null,
        stretchT: FX_UNIFORMS.uFxStretchT.value,
        minPx: FX_UNIFORMS.uFxMinPx.value,
        viewH: FX_UNIFORMS.uFxViewH.value,
      };
    }
    return setParticleFxLive(!!on);
  };
  // Tier 2 live tuning: the velocity stretch's shutter (s) and the sub-pixel
  // clamp's minimum projected radius (px) — shared uniforms, no recompile.
  window.__fxTier2 = {
    get stretchT() { return FX_UNIFORMS.uFxStretchT.value; },
    set stretchT(v) { if (Number.isFinite(+v)) FX_UNIFORMS.uFxStretchT.value = Math.max(0, Math.min(0.5, +v)); },
    get minPx() { return FX_UNIFORMS.uFxMinPx.value; },
    set minPx(v) { if (Number.isFinite(+v)) FX_UNIFORMS.uFxMinPx.value = Math.max(0, Math.min(8, +v)); },
    variant: () => (_tier2 ? { ..._tier2 } : null),
  };
}
