// scene3d/film/pilot/sense_words.js — numbers → words for the JEV pilot (SPEC §2.14).
//
// WHY: JEV (TypeSafe's System-One decision model) is "not a calculator": the
// JEV-plays-DOOM / jev-drone prior art showed it judges reliably only when code
// has already turned every measurement into a named bucket and the question
// criteria quote those exact bucket names with explicit boundaries. This module
// is the ONE place those buckets are defined. `WORD_BOUNDS` is exported so the
// criteria text (questions.js) and the deterministic code policy
// (policy_code.js) are both built from the same table — text and code cannot
// drift. Perception (scene/sensors.js) produces metres / seconds / fractions;
// scene_state.js calls the bucketers below to build the words-only state.
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Pure module: no DOM, no three,
// no wasm, no clocks. Deterministic.
//
// Band semantics: each scale is an ordered list of bands, nearest/lowest first.
// A value belongs to the FIRST band whose upper bound it is below (`max`,
// exclusive) — or at/below when the band says `inclusive: true` (only the
// framing-size scale uses that: "right" is 0.8 ≤ r ≤ 1.25, SPEC §2.14).
// Signed scales (bearing, elevation) bucket the magnitude and pick the side
// word from the sign. Non-finite inputs never throw; each bucketer documents
// what it returns for them.

/**
 * Recursively freezes a plain object/array tree.
 * @template T
 * @param {T} o
 * @returns {T}
 */
function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/**
 * The bucket tables shared by scene_state.js, questions.js and policy_code.js.
 *
 * Every scale: `{unit, display?, bands:[…]}`; a band is `{word, max, inclusive?, text?}`
 * or, for signed scales, `{left|down: word, right|up: word, max}` (the magnitude band).
 * `text` overrides the generated boundary description used in criteria.
 *
 * - distance (m): touching <0.75, very close <2, close <4, near <8, medium <16, far <40, clear.
 * - ttc (s): imminent <0.75, soon <2, later <5, none.
 * - bearing (deg, + = right): dead ahead |b|<10, ahead-left|right <35, left|right <80,
 *   behind-left|right <150, behind.
 * - elevation (deg, + = up): level |e|<10, slightly above|below <30, above|below <60, overhead|underneath.
 * - visibility (fraction visible 0..1): fully hidden <0.1, mostly hidden <0.4, partly hidden <0.8, clear.
 * - unseen (s fully hidden): not hidden ≤0, brief <1, a while <3, long.
 * - size (actual/target subject size): much too small <0.5, too small <0.8, right ≤1.25, too large ≤2,
 *   much too large.
 * - offset (max |NDC| of the subject centre): centred <0.2, slightly off-centre <0.5, off-centre <0.8,
 *   near the edge <1, out of frame.
 * - speed (m/s): stopped <0.25, creeping <1, slow <3, moderate <7, fast <15, very fast.
 * - since (s a maneuver has been held): just now <0.5, recently <1.5, a while <4, long.
 * - room (m of free space the sensors see beside the camera): none <0.75, little <2, some <4, plenty.
 * - density (particle density 0..1): thin <0.3, moderate <0.7, thick.
 */
export const WORD_BOUNDS = deepFreeze({
  distance: {
    unit: "m",
    bands: [
      { word: "touching", max: 0.75 },
      { word: "very close", max: 2 },
      { word: "close", max: 4 },
      { word: "near", max: 8 },
      { word: "medium", max: 16 },
      { word: "far", max: 40 },
      { word: "clear", max: Infinity, text: "nothing within 40 m" },
    ],
  },
  ttc: {
    unit: "s",
    bands: [
      { word: "imminent", max: 0.75 },
      { word: "soon", max: 2 },
      { word: "later", max: 5 },
      { word: "none", max: Infinity, text: "5 s or more, or no contact on the planned path" },
    ],
  },
  bearing: {
    unit: "°",
    signed: true,
    bands: [
      { word: "dead ahead", max: 10 },
      { left: "ahead-left", right: "ahead-right", max: 35 },
      { left: "left", right: "right", max: 80 },
      { left: "behind-left", right: "behind-right", max: 150 },
      { word: "behind", max: Infinity },
    ],
  },
  elevation: {
    unit: "°",
    signed: true,
    bands: [
      { word: "level", max: 10 },
      { down: "slightly below", up: "slightly above", max: 30 },
      { down: "below", up: "above", max: 60 },
      { down: "underneath", up: "overhead", max: Infinity },
    ],
  },
  visibility: {
    unit: "%",
    display: "percent",
    bands: [
      { word: "fully hidden", max: 0.1, text: "under 10% of the subject visible" },
      { word: "mostly hidden", max: 0.4, text: "10–40% of the subject visible" },
      { word: "partly hidden", max: 0.8, text: "40–80% of the subject visible" },
      { word: "clear", max: Infinity, text: "80% or more of the subject visible" },
    ],
  },
  unseen: {
    unit: "s",
    bands: [
      { word: "not hidden", max: 0, inclusive: true, text: "visible now" },
      { word: "brief", max: 1, text: "fully hidden for under 1 s" },
      { word: "a while", max: 3, text: "fully hidden for 1–3 s" },
      { word: "long", max: Infinity, text: "fully hidden for 3 s or more" },
    ],
  },
  size: {
    unit: "×",
    bands: [
      { word: "much too small", max: 0.5, text: "under 0.5× the intended size" },
      { word: "too small", max: 0.8, text: "0.5–0.8× the intended size" },
      { word: "right", max: 1.25, inclusive: true, text: "0.8–1.25× the intended size" },
      { word: "too large", max: 2, inclusive: true, text: "over 1.25× up to 2× the intended size" },
      { word: "much too large", max: Infinity, text: "over 2× the intended size" },
    ],
  },
  offset: {
    unit: "NDC",
    bands: [
      { word: "centred", max: 0.2, text: "within 20% of the frame centre" },
      { word: "slightly off-centre", max: 0.5, text: "20–50% of the way from centre to the frame edge" },
      { word: "off-centre", max: 0.8, text: "50–80% of the way from centre to the frame edge (thirds placement)" },
      { word: "near the edge", max: 1, text: "80–100% of the way from centre to the frame edge" },
      { word: "out of frame", max: Infinity, text: "beyond the frame edge or behind the camera" },
    ],
  },
  speed: {
    unit: "m/s",
    bands: [
      { word: "stopped", max: 0.25 },
      { word: "creeping", max: 1 },
      { word: "slow", max: 3 },
      { word: "moderate", max: 7 },
      { word: "fast", max: 15 },
      { word: "very fast", max: Infinity },
    ],
  },
  since: {
    unit: "s",
    bands: [
      { word: "just now", max: 0.5 },
      { word: "recently", max: 1.5 },
      { word: "a while", max: 4 },
      { word: "long", max: Infinity },
    ],
  },
  room: {
    unit: "m",
    bands: [
      { word: "none", max: 0.75 },
      { word: "little", max: 2 },
      { word: "some", max: 4 },
      { word: "plenty", max: Infinity },
    ],
  },
  density: {
    unit: "",
    bands: [
      { word: "thin", max: 0.3 },
      { word: "moderate", max: 0.7 },
      { word: "thick", max: Infinity },
    ],
  },
});

/** Names of every scale in WORD_BOUNDS. */
export const SCALE_NAMES = Object.freeze(Object.keys(WORD_BOUNDS));

/**
 * Obstacle / occluder kinds the state may name (scene/los.js `kindForLayer` kinds plus
 * `player` and `particles`). Anything else becomes "obstacle" (obstacles) or "unknown"
 * (occluders) through kindWord().
 */
export const OBSTACLE_KINDS = Object.freeze([
  "tree", "rock", "wall", "building", "prop", "door", "creature", "player", "terrain", "particles",
]);

/**
 * Particle family names that normalise to the kind "particles" (perception may report the
 * family of a particle cloud instead of the generic kind).
 */
export const PARTICLE_FAMILIES = Object.freeze([
  "particles", "particle", "smoke", "fire", "flame", "mist", "fog", "dust", "steam", "spark", "sparks",
  "magic", "spell", "glow", "embers", "ash", "snow", "rain", "cloud",
]);

/**
 * Occluder classes for the `occluder_action` question (questions.js) and the code policy:
 * soft things the runtime may fade (placed trees and props of known size, particle clouds — a soft
 * occluder with no fade id, e.g. procedural scenery, is rerouted around instead; mapper.js), solid
 * structure the camera must route around, and moving things that pass by themselves.
 */
export const OCCLUDER_CLASSES = deepFreeze({
  soft: ["tree", "prop", "particles"],
  solid: ["wall", "building", "rock", "terrain", "door"],
  moving: ["creature", "player"],
});

// ---------------------------------------------------------------------------
// Rank tables
// ---------------------------------------------------------------------------

/** @param {object} band @returns {string[]} the band's words (1 or 2) */
function bandWords(band) {
  if (typeof band.word === "string") return [band.word];
  const out = [];
  for (const k of ["left", "right", "down", "up"]) if (typeof band[k] === "string") out.push(band[k]);
  return out;
}

/** @type {Record<string, Map<string, number>>} scale → word → rank (band index) */
const RANKS = {};
/** @type {Record<string, string[]>} scale → words, longest first (prefix matching) */
const BY_LENGTH = {};
for (const name of SCALE_NAMES) {
  const m = new Map();
  WORD_BOUNDS[name].bands.forEach((b, i) => {
    for (const w of bandWords(b)) m.set(w, i);
  });
  RANKS[name] = m;
  BY_LENGTH[name] = [...m.keys()].sort((a, b) => b.length - a.length);
}

/**
 * Every word of a scale in rank order (signed scales list the left/down variant before
 * right/up within a band).
 * @param {string} scale a WORD_BOUNDS key
 * @returns {string[]} (empty for an unknown scale)
 */
export function scaleWords(scale) {
  const s = WORD_BOUNDS[scale];
  if (!s) return [];
  return s.bands.flatMap(bandWords);
}

/**
 * Words of a scale from the lowest rank up to and including `word`'s rank, e.g.
 * `wordsUpTo('distance', 'close')` → ["touching", "very close", "close"].
 * @param {string} scale
 * @param {string} word
 * @returns {string[]} (empty when the word is unknown)
 */
export function wordsUpTo(scale, word) {
  const r = rankOf(word, scale);
  if (r < 0) return [];
  return scaleWords(scale).filter((w) => rankOf(w, scale) <= r);
}

/**
 * Words of a scale from `word`'s rank up to the highest rank, e.g.
 * `wordsFrom('distance', 'near')` → ["near", "medium", "far", "clear"].
 * @param {string} scale
 * @param {string} word
 * @returns {string[]} (empty when the word is unknown)
 */
export function wordsFrom(scale, word) {
  const r = rankOf(word, scale);
  if (r < 0) return [];
  return scaleWords(scale).filter((w) => rankOf(w, scale) >= r);
}

/**
 * Rank (band index, 0 = nearest / lowest) of a word on a scale. Also accepts a
 * compound text that STARTS with a scale word followed by a space or "(" — e.g.
 * `rankOf("close tree", "distance")` → 2, `rankOf("near the edge (left)", "offset")` → 3.
 * The longest matching word wins ("very close tree" is "very close", not "close").
 * `scale` may also be an array of words (rank = array index).
 * @param {string} word
 * @param {string|string[]} scale a WORD_BOUNDS key or an ordered word list
 * @returns {number} rank, or −1 when the word is not on the scale
 */
export function rankOf(word, scale) {
  if (typeof word !== "string") return -1;
  if (Array.isArray(scale)) {
    const i = scale.indexOf(word);
    if (i >= 0) return i;
    let best = -1;
    let bestLen = -1;
    scale.forEach((w, k) => {
      if (typeof w === "string" && w.length > bestLen && startsWithWord(word, w)) {
        best = k;
        bestLen = w.length;
      }
    });
    return best;
  }
  const ranks = RANKS[scale];
  if (!ranks) return -1;
  const exact = ranks.get(word);
  if (exact !== undefined) return exact;
  for (const w of BY_LENGTH[scale]) if (startsWithWord(word, w)) return ranks.get(w);
  return -1;
}

/** @param {string} text @param {string} w @returns {boolean} text is `w` + " …" or `w` + "(…" */
function startsWithWord(text, w) {
  if (!text.startsWith(w)) return false;
  const c = text.charAt(w.length);
  return c === " " || c === "(";
}

/**
 * The scale word a compound text starts with: `leadingWord("close tree", "distance")` →
 * "close"; `leadingWord("clear", "distance")` → "clear".
 * @param {string} text
 * @param {string} scale a WORD_BOUNDS key
 * @returns {string|null} null when the text does not start with a word of the scale
 */
export function leadingWord(text, scale) {
  if (typeof text !== "string") return null;
  const ranks = RANKS[scale];
  if (!ranks) return null;
  if (ranks.has(text)) return text;
  for (const w of BY_LENGTH[scale]) if (startsWithWord(text, w)) return w;
  return null;
}

// ---------------------------------------------------------------------------
// Bucketers
// ---------------------------------------------------------------------------

/**
 * Index of the band a magnitude belongs to (first band whose upper bound it is
 * below, or at/below for an inclusive band).
 * @param {string} scale
 * @param {number} v finite number
 * @returns {number}
 */
function bandIndex(scale, v) {
  const bands = WORD_BOUNDS[scale].bands;
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    if (b.inclusive ? v <= b.max : v < b.max) return i;
  }
  return bands.length - 1;
}

/**
 * Generic bucketer for the unsigned scales.
 * @param {string} scale a WORD_BOUNDS key (unsigned)
 * @param {number} v
 * @returns {string}
 */
function bucket(scale, v) {
  return WORD_BOUNDS[scale].bands[bandIndex(scale, v)].word;
}

/**
 * Range (metres) → distance word. `touching` <0.75, `very close` <2, `close` <4, `near` <8,
 * `medium` <16, `far` <40, else `clear`. Negative (embedded) → "touching"; NaN / null /
 * undefined / +Infinity → "clear" (perception reports Infinity for "nothing within 25 m").
 * @param {number} m
 * @returns {string}
 */
export function distanceWord(m) {
  const v = Number(m);
  if (m == null || Number.isNaN(v)) return "clear";
  if (v === -Infinity) return "touching";
  return bucket("distance", v);
}

/**
 * Time to contact (seconds) → `imminent` <0.75, `soon` <2, `later` <5, else `none`.
 * NaN / null / Infinity / negative (no predicted contact) → "none".
 * @param {number} s
 * @returns {string}
 */
export function ttcWord(s) {
  const v = Number(s);
  if (s == null || !Number.isFinite(v) || v < 0) return "none";
  return bucket("ttc", v);
}

/**
 * Wrap degrees into (−180, 180].
 * @param {number} d
 * @returns {number}
 */
function wrapDeg(d) {
  let x = d % 360;
  if (x <= -180) x += 360;
  else if (x > 180) x -= 360;
  return x;
}

/**
 * Bearing (degrees, + = right of the camera's forward, wrapped into (−180, 180]) →
 * `dead ahead` |b|<10, `ahead-left|right` <35, `left|right` <80, `behind-left|right` <150,
 * else `behind`. Non-finite → "unknown".
 * @param {number} deg
 * @returns {string}
 */
export function bearingWord(deg) {
  const v = Number(deg);
  if (deg == null || !Number.isFinite(v)) return "unknown";
  const b = wrapDeg(v);
  const band = WORD_BOUNDS.bearing.bands[bandIndex("bearing", Math.abs(b))];
  if (typeof band.word === "string") return band.word;
  return b < 0 ? band.left : band.right;
}

/**
 * Elevation (degrees, + = above the camera's horizontal) → `level` |e|<10,
 * `slightly above|below` <30, `above|below` <60, else `overhead|underneath`.
 * Values are clamped to [−90, 90]. Non-finite → "unknown".
 * @param {number} deg
 * @returns {string}
 */
export function elevationWord(deg) {
  const v = Number(deg);
  if (deg == null || !Number.isFinite(v)) return "unknown";
  const e = Math.max(-90, Math.min(90, v));
  const band = WORD_BOUNDS.elevation.bands[bandIndex("elevation", Math.abs(e))];
  if (typeof band.word === "string") return band.word;
  return e < 0 ? band.down : band.up;
}

/**
 * Visible fraction of the subject (0..1) → `fully hidden` <0.1, `mostly hidden` <0.4,
 * `partly hidden` <0.8, else `clear`. Values are clamped to [0, 1]; NaN / null → "clear"
 * (unknown visibility is treated as "not occluded" — the pilot never acts on a guess).
 * @param {number} frac
 * @returns {string}
 */
export function visibilityWord(frac) {
  const v = Number(frac);
  if (frac == null || Number.isNaN(v)) return "clear";
  return bucket("visibility", Math.max(0, Math.min(1, v)));
}

/**
 * Seconds the subject has been fully hidden → `not hidden` (≤ 0), `brief` <1, `a while` <3,
 * else `long`. NaN / null / negative → "not hidden"; +Infinity → "long".
 * @param {number} s
 * @returns {string}
 */
export function unseenWord(s) {
  const v = Number(s);
  if (s == null || Number.isNaN(v) || v <= 0) return "not hidden";
  return bucket("unseen", v);
}

/**
 * Subject size relative to the intended framing (actual / target) → `much too small` <0.5,
 * `too small` <0.8, `right` ≤1.25, `too large` ≤2, else `much too large`.
 * Negative → treated as 0 ("much too small"); NaN / null → "right" (no framing change on
 * unknown size); +Infinity → "much too large".
 * @param {number} ratio
 * @returns {string}
 */
export function sizeWord(ratio) {
  const v = Number(ratio);
  if (ratio == null || Number.isNaN(v)) return "right";
  return bucket("size", Math.max(0, v));
}

/**
 * Screen position of the subject centre (NDC, x right / y up, ±1 = frame edge) →
 * "<band>" or "<band> (<direction>)". Band on m = max(|x|, |y|): `centred` <0.2,
 * `slightly off-centre` <0.5, `off-centre` <0.8, `near the edge` <1, else `out of frame`.
 * Direction (omitted when centred): "left"/"right" when |x| ≥ m/2, "up"/"down" when
 * |y| ≥ m/2, combined vertical-first ("up-left"). Null / non-finite input (subject
 * behind the camera or not projected) → "out of frame".
 * @param {number|null} ndcX
 * @param {number|null} [ndcY]
 * @returns {string}
 */
export function offsetWord(ndcX, ndcY) {
  let x = ndcX;
  let y = ndcY;
  if (Array.isArray(ndcX)) {
    x = ndcX[0];
    y = ndcX[1];
  }
  if (x == null || y == null) return "out of frame";
  x = Number(x);
  y = Number(y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return "out of frame";
  const m = Math.max(Math.abs(x), Math.abs(y));
  const word = bucket("offset", m);
  if (word === "centred") return word;
  const parts = [];
  if (Math.abs(y) >= m / 2) parts.push(y > 0 ? "up" : "down");
  if (Math.abs(x) >= m / 2) parts.push(x > 0 ? "right" : "left");
  return `${word} (${parts.join("-")})`;
}

/**
 * Camera speed (m/s) → `stopped` <0.25, `creeping` <1, `slow` <3, `moderate` <7, `fast` <15,
 * else `very fast`. Uses |v|; NaN / null → "stopped".
 * @param {number} mps
 * @returns {string}
 */
export function speedWord(mps) {
  const v = Number(mps);
  if (mps == null || Number.isNaN(v)) return "stopped";
  return bucket("speed", Math.abs(v));
}

/**
 * Seconds the current maneuver has been held → `just now` <0.5, `recently` <1.5,
 * `a while` <4, else `long`. NaN / null / negative → "just now".
 * @param {number} s
 * @returns {string}
 */
export function sinceWord(s) {
  const v = Number(s);
  if (s == null || Number.isNaN(v) || v < 0) return "just now";
  return bucket("since", v);
}

/**
 * Lateral room (metres of free space the sensors see beside the camera on one side; the
 * shot's lateral bound is stated separately as `limits.can_drift_left/right`) → `none` <0.75,
 * `little` <2, `some` <4, else `plenty`. Booleans: true → "plenty", false → "none".
 * NaN / null / negative → "none" (unknown room never invites a drift).
 * @param {number|boolean} m
 * @returns {string}
 */
export function roomWord(m) {
  if (m === true) return "plenty";
  if (m === false) return "none";
  const v = Number(m);
  if (m == null || Number.isNaN(v) || v < 0) return "none";
  return bucket("room", v);
}

/**
 * Particle density (0..1) → `thin` <0.3, `moderate` <0.7, else `thick`. NaN / null → "thin".
 * @param {number} d
 * @returns {string}
 */
export function densityWord(d) {
  const v = Number(d);
  if (d == null || Number.isNaN(v)) return "thin";
  return bucket("density", Math.max(0, v));
}

/**
 * Boolean → "yes" / "no" (anything not strictly true is "no").
 * @param {*} b
 * @returns {"yes"|"no"}
 */
export function yesNo(b) {
  return b === true ? "yes" : "no";
}

/**
 * Normalise an obstacle / occluder kind: known kinds pass through (lower-cased), particle
 * family names become "particles", anything else becomes `fallback`.
 * @param {*} kind
 * @param {string} [fallback="obstacle"]
 * @returns {string}
 */
export function kindWord(kind, fallback = "obstacle") {
  if (typeof kind !== "string") return fallback;
  const k = kind.trim().toLowerCase();
  if (!k) return fallback;
  if (OBSTACLE_KINDS.includes(k)) return k;
  if (PARTICLE_FAMILIES.includes(k)) return "particles";
  if (k === "scenery" || k === "foliage" || k === "bush" || k === "plant") return "tree";
  if (k === "statics" || k === "static" || k === "object") return "prop";
  if (k === "entity" || k === "npc" || k === "monster") return "creature";
  if (k === "cell" || k === "dungeon") return "wall";
  return fallback;
}

/**
 * The occluder class of a kind word: "soft" | "solid" | "moving" | null.
 * @param {string} kind a kindWord() result
 * @returns {"soft"|"solid"|"moving"|null}
 */
export function occluderClass(kind) {
  for (const c of /** @type {const} */ (["soft", "solid", "moving"])) {
    if (OCCLUDER_CLASSES[c].includes(kind)) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Boundary text (for criteria)
// ---------------------------------------------------------------------------

/** @param {number} x @returns {string} compact number (no trailing zeros) */
function fmt(x) {
  if (!Number.isFinite(x)) return String(x);
  return String(Math.round(x * 1000) / 1000);
}

/**
 * Human boundary description of a band, generated from WORD_BOUNDS (or the band's
 * `text` override), e.g. `bandText('distance', 'close')` → "2–4 m",
 * `bandText('distance', 'touching')` → "under 0.75 m", `bandText('ttc', 'soon')` → "0.75–2 s".
 * Signed scales describe the magnitude ("10–35°").
 * @param {string} scale
 * @param {string} word
 * @returns {string} "" when the word is not on the scale
 */
export function bandText(scale, word) {
  const s = WORD_BOUNDS[scale];
  if (!s) return "";
  const i = rankOf(word, scale);
  if (i < 0) return "";
  const band = s.bands[i];
  if (band.text) return band.text;
  const pct = s.display === "percent";
  const conv = (v) => (pct ? v * 100 : v);
  const unit = s.unit === "%" || s.unit === "°" || s.unit === "×" ? s.unit : s.unit ? ` ${s.unit}` : "";
  const prev = i > 0 ? s.bands[i - 1] : null;
  const lo = prev ? conv(prev.max) : null;
  const hi = conv(band.max);
  if (lo == null) return `${band.inclusive ? "up to" : "under"} ${fmt(hi)}${unit}`;
  if (!Number.isFinite(hi)) return prev.inclusive ? `over ${fmt(lo)}${unit}` : `${fmt(lo)}${unit} or more`;
  return `${fmt(lo)}–${fmt(hi)}${unit}`;
}

/**
 * `"word" (boundary)` — the quoting style every criterion uses, e.g.
 * `quoteBand('distance', 'close')` → `"close" (2–4 m)`.
 * @param {string} scale
 * @param {string} word
 * @returns {string}
 */
export function quoteBand(scale, word) {
  const t = bandText(scale, word);
  return t ? `"${word}" (${t})` : `"${word}"`;
}
