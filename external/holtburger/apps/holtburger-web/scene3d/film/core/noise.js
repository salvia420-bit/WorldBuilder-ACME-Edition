// scene3d/film/core/noise.js — smooth seeded noise and camera shake for AC Film Mode (SPEC §2.7).
//
// WHY: handheld / steadicam / snorricam techniques, drone wind and "operated"
// micro-motion all need organic jitter that is (a) smooth — C¹ or better, so
// the footage never pops between frames — (b) bounded, so a shake can never
// throw the subject out of frame, and (c) PURE IN TIME: scouting samples a
// trajectory at random times and rehearsal/shoot must reproduce the exact same
// motion from the same seed. Gradient noise on an integer lattice hashed from
// (seed, cell) satisfies all three without any state.
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Pure module: no DOM, no three,
// no wasm, no clocks, no Math.random.

import { deriveSeed, seedOf } from "./rng.js";

const DEG = Math.PI / 180;

/**
 * Integer hash of (seed, lattice index) → uint32 (murmur3 fmix32 over a
 * golden-ratio mix). Works for any finite integer index, including negatives
 * and values beyond 2³² (they are folded through a second word).
 * @param {number} seed uint32 @param {number} i integer
 * @returns {number} uint32
 */
function latticeHash(seed, i) {
  const lo = i | 0;
  const hi = Math.floor(i / 4294967296) | 0;
  let h = (seed ^ Math.imul(lo, 0x9e3779b1) ^ Math.imul(hi, 0x85ebca77)) | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Lattice gradient in [−1, 1] for (seed, i). */
function gradient(seed, i) {
  return (latticeHash(seed, i) / 4294967295) * 2 - 1;
}

/** Quintic fade 6t⁵ − 15t⁴ + 10t³ (zero slope AND curvature at lattice points → C² noise). */
function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Seeded 1-D gradient (Perlin) noise. The returned function maps time (any
 * real; units are "lattice cells", so scale t by a frequency first) to
 * [−1, 1]: it is 0 at every integer, C² continuous (quintic fade), pure in t
 * and identical for identical seeds. The raw 1-D Perlin range [−½, ½] is
 * rescaled ×2 (the bound is reached only in the worst-case gradient pair) and
 * clamped for float safety. Non-finite t → 0.
 * @param {*} seed any seed accepted by rng.js seedOf (number, string, …)
 * @returns {(t:number) => number}
 */
export function createNoise1D(seed) {
  const s = seedOf(seed);
  return function noise1D(t) {
    if (!Number.isFinite(t)) return 0;
    const i0 = Math.floor(t);
    const f = t - i0;
    const g0 = gradient(s, i0);
    const g1 = gradient(s, i0 + 1);
    const v = 2 * (g0 * f + (g1 * (f - 1) - g0 * f) * fade(f));
    return v > 1 ? 1 : v < -1 ? -1 : v;
  };
}

/**
 * Fractal Brownian motion over a 1-D noise function: Σ gainᵏ·noise(t·lacunarityᵏ + offsetₖ)
 * normalised by Σ gainᵏ, so the result stays in [−1, 1] for a [−1, 1] noise.
 * Each octave is shifted by a fixed irrational offset so octaves do not share
 * the zero crossings of the integer lattice. octaves is clamped to [1, 12]
 * (rounded); non-finite t → 0; gain ≤ 0 keeps only the base octave.
 * @param {(t:number) => number} noise e.g. createNoise1D(seed)
 * @param {number} t
 * @param {{octaves?:number, lacunarity?:number, gain?:number}} [opts]
 * @returns {number}
 */
export function fbm1D(noise, t, opts = {}) {
  const o = opts || {};
  if (!Number.isFinite(t) || typeof noise !== "function") return 0;
  const octaves = Math.max(1, Math.min(12, Math.round(Number.isFinite(o.octaves) ? o.octaves : 3)));
  const lacunarity = Number.isFinite(o.lacunarity) && o.lacunarity > 0 ? o.lacunarity : 2;
  const gain = Number.isFinite(o.gain) ? o.gain : 0.5;
  let sum = 0, norm = 0, amp = 1, freq = 1;
  for (let k = 0; k < octaves; k++) {
    if (k > 0 && !(gain > 0)) break;
    const n = noise(t * freq + k * 17.31415926535);
    sum += amp * (Number.isFinite(n) ? n : 0);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  const v = norm > 0 ? sum / norm : 0;
  return v > 1 ? 1 : v < -1 ? -1 : v;
}

/** Non-negative finite option or the default. */
function nonNeg(v, def) {
  return Number.isFinite(v) && v >= 0 ? v : def;
}

/**
 * Seeded, bounded, time-pure camera shake (handheld / steadicam / wind).
 *
 * The returned function gives offsets to ADD to a nominal pose at film time t:
 * `dh`, `dp`, `dr` in radians and `dpos` `[dx, dy, dz]` in metres (world
 * axes). Every channel is an independent fbm stream (its own derived seed), so
 * the bounds hold per channel:
 *   |dh|, |dp| ≤ amplitudeDeg·π/180,  |dr| ≤ rollScale·amplitudeDeg·π/180,
 *   |dpos[i]| ≤ posAmplitude.
 * `frequencyHz` is the base-octave rate; `roughness` ∈ [0, 1] is the fbm gain
 * (0 = one smooth octave, 1 = equal-weight octaves = jittery). Same seed →
 * identical motion; non-finite t → all zeros.
 * @param {{seed?:*, amplitudeDeg?:number, frequencyHz?:number, posAmplitude?:number,
 *   roughness?:number, octaves?:number, rollScale?:number}} [opts]
 *   defaults seed 0, amplitudeDeg 0.6, frequencyHz 1.2, posAmplitude 0.03, roughness 0.5, octaves 3, rollScale 0.5
 * @returns {(t:number) => {dh:number, dp:number, dr:number, dpos:number[]}}
 */
export function createShake(opts = {}) {
  const o = opts || {};
  const seed = o.seed === undefined ? 0 : o.seed;
  const ampRad = nonNeg(o.amplitudeDeg, 0.6) * DEG;
  const freq = nonNeg(o.frequencyHz, 1.2);
  const posAmp = nonNeg(o.posAmplitude, 0.03);
  const roughness = Math.min(1, nonNeg(o.roughness, 0.5));
  const octaves = Number.isFinite(o.octaves) ? o.octaves : 3;
  const rollAmp = ampRad * nonNeg(o.rollScale, 0.5);
  const fb = { octaves, lacunarity: 2, gain: roughness };
  const ch = ["h", "p", "r", "x", "y", "z"].map((k) => createNoise1D(deriveSeed(seed, `shake:${k}`)));
  return function shake(t) {
    if (!Number.isFinite(t)) return { dh: 0, dp: 0, dr: 0, dpos: [0, 0, 0] };
    const u = t * freq;
    return {
      dh: ampRad * fbm1D(ch[0], u, fb),
      dp: ampRad * fbm1D(ch[1], u, fb),
      dr: rollAmp * fbm1D(ch[2], u, fb),
      dpos: [posAmp * fbm1D(ch[3], u, fb), posAmp * fbm1D(ch[4], u, fb), posAmp * fbm1D(ch[5], u, fb)],
    };
  };
}
