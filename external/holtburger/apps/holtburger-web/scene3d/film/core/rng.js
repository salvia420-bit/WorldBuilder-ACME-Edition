// scene3d/film/core/rng.js — seeded randomness for AC Film Mode (SPEC §2.7).
//
// WHY: a take must be reproducible — the same plan + seed must produce the
// same trajectory, the same shake and the same candidate poses on every
// rehearsal and every machine (scouting samples trajectories by random
// access; the director compares takes). Film code therefore never calls
// Math.random(); it threads one of these seeded generators instead.
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Pure module: no DOM, no three,
// no wasm, no clocks.

/**
 * 32-bit FNV-1a over the string's UTF-16 code units, finished with the
 * murmur3 fmix32 avalanche (so near-identical strings give unrelated seeds).
 * Non-strings are stringified first.
 * @param {*} str
 * @returns {number} uint32
 */
export function hashString(str) {
  const s = typeof str === "string" ? str : String(str);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Normalise any seed to a uint32: integers wrap modulo 2³² (negative values
 * included), strings / non-integer numbers / bigints are hashed, anything else
 * (undefined, null, NaN, objects) becomes 0.
 * @param {*} seed
 * @returns {number} uint32
 */
export function seedOf(seed) {
  if (typeof seed === "number") {
    if (!Number.isFinite(seed)) return 0;
    if (Number.isInteger(seed)) return Number(BigInt.asUintN(32, BigInt(seed)));
    return hashString(String(seed));
  }
  if (typeof seed === "string") return hashString(seed);
  if (typeof seed === "bigint") return Number(BigInt.asUintN(32, seed));
  if (typeof seed === "boolean") return seed ? 1 : 0;
  return 0;
}

/**
 * Independent sub-seed for a named stream (e.g. one per shake channel or per
 * candidate) so adding a consumer never shifts another stream's numbers.
 * @param {*} seed @param {string|number} salt
 * @returns {number} uint32
 */
export function deriveSeed(seed, salt) {
  return hashString(`${seedOf(seed)}:${String(salt)}`);
}

/**
 * Mulberry32 PRNG: `rng() → [0, 1)`, period 2³², deterministic per seed
 * (seed normalised by seedOf, so strings work too).
 * @param {*} seed
 * @returns {() => number}
 */
export function mulberry32(seed) {
  let a = seedOf(seed) | 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Uniform float in [a, b).
 * @param {() => number} rng @param {number} a @param {number} b
 * @returns {number}
 */
export function rngRange(rng, a, b) {
  return a + (b - a) * rng();
}

/**
 * Uniform integer in [lo, hi] inclusive (bounds are rounded; swapped if reversed).
 * @param {() => number} rng @param {number} lo @param {number} hi
 * @returns {number}
 */
export function rngInt(rng, lo, hi) {
  let a = Math.ceil(Math.min(lo, hi)), b = Math.floor(Math.max(lo, hi));
  if (b < a) b = a;
  return Math.min(b, a + Math.floor(rng() * (b - a + 1)));
}

/**
 * Uniform pick from an array (undefined for an empty / missing array).
 * @template T
 * @param {() => number} rng @param {T[]} arr
 * @returns {T|undefined}
 */
export function rngPick(rng, arr) {
  if (!arr || !(arr.length > 0)) return undefined;
  return arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))];
}
