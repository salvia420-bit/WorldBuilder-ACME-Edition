// Terrain-VFX Wave 0A — terrain code → effect family LUT.
//
// Design plan: `docs/2026-07-31-terrain-vfx-plan.md` §1.3.
//
// THE RULE (plan §8 risk 12): family membership is a property of the terrain
// CODE, never of a name and never of a texture. `data/terrain_palette.json`
// names are Dereth's (Region `0x13000000`); another region could name the same
// code differently, and retail SHARES RenderSurfaces across codes that live in
// DIFFERENT families here — `0x06006D6F` is BarrenRock (0, ROCK) *and* Argila
// (24, DIRT) *and* DesolateLands (31, DIRT); `0x06006D3C` is PatchyGrassland
// (9) *and* Moss (28). Anything keyed off texture identity would fuse those.
// The names below are DIAGNOSTIC ONLY — do not branch on them.
//
// THREE-free on purpose (plan §6): this module and `terrain_oracle.js` are
// pure-ESM leaves so their node tests need no stub loader.
//
// Water membership is DERIVED, not hardcoded — see `buildTerrainFamilyLut`.

// ----- families -----------------------------------------------------
//
// Values are LUT slots; keep them dense and 0-based so `familyCoverage()`
// can index a `Uint16Array(FAM_COUNT)` directly.
export const FAM_NONE = 0;
export const FAM_GRASS = 1;    // 1, 3, 9, 21, 28, 29
export const FAM_SAND = 2;     // 10, 11, 12
export const FAM_ROCK = 3;     // 0, 13, 14, 30
export const FAM_SNOWICE = 4;  // 2, 15, 27
export const FAM_SWAMP = 5;    // 4 (+ 23 when 23 is NOT in the water set)
export const FAM_VOLCANO = 6;  // 6, 25, 26
export const FAM_DIRT = 7;     // 5, 7, 8, 24, 31
export const FAM_WATER = 8;    // OWNED BY THE WATER AGENT — never place on it
export const FAM_COUNT = 9;

/** Diagnostic names, indexed by FAM_*. Never branch on these. */
export const FAM_NAMES = Object.freeze([
  "none", "grass", "sand", "rock", "snowice", "swamp", "volcano", "dirt", "water",
]);

/**
 * DAT terrain names for Dereth (`data/terrain_palette.json` → `palette[].name`,
 * dumped from Region `0x13000000`). DIAGNOSTIC ONLY (plan §8 risk 12) — the
 * LUT below is code-indexed and never consults this array.
 */
export const TERRAIN_CODE_NAMES = Object.freeze([
  "BarrenRock", "Grassland", "Ice", "LushGrass",
  "MarshSparseSwamp", "MudRichDirt", "ObsidianPlain", "PackedDirt",
  "PatchyDirt", "PatchyGrassland", "sand-yellow", "sand-grey",
  "sand-rockStrewn", "SedimentaryRock", "SemiBarrenRock", "Snow",
  "WaterRunning", "WaterStandingFresh", "WaterShallowSea", "WaterShallowStillSea",
  "WaterDeepSea", "forestfloor", "FauxWaterRunning", "SeaSlime",
  "Argila", "Volcano1", "Volcano2", "BlueIce",
  "Moss", "DarkMoss", "olthoi", "DesolateLands",
]);

export const TERRAIN_CODE_COUNT = 32;

// ----- the base (dry) table -----------------------------------------
//
// Each code's family IGNORING the water set. `buildTerrainFamilyLut` then
// stamps FAM_WATER over every code in the supplied water set, so flipping
// `?strictWaterCodes` moves 22/23 without touching this table.
//
// 16-20 are retail SurfChar water in every configuration (they have no dry
// identity), so their base is already FAM_WATER. 22 (FauxWaterRunning) has no
// dry identity either but IS visually running water, so its dry base is
// FAM_NONE — nothing scatters on it. 23 (SeaSlime) has a real dry identity:
// it is marsh, so it falls to FAM_SWAMP when the water set drops it
// (plan §3.8.3).
const BASE_FAMILY = Object.freeze([
  /*  0 BarrenRock           */ FAM_ROCK,
  /*  1 Grassland            */ FAM_GRASS,
  /*  2 Ice                  */ FAM_SNOWICE,
  /*  3 LushGrass            */ FAM_GRASS,
  /*  4 MarshSparseSwamp     */ FAM_SWAMP,
  /*  5 MudRichDirt          */ FAM_DIRT,
  /*  6 ObsidianPlain        */ FAM_VOLCANO,
  /*  7 PackedDirt           */ FAM_DIRT,
  /*  8 PatchyDirt           */ FAM_DIRT,
  /*  9 PatchyGrassland      */ FAM_GRASS,
  /* 10 sand-yellow          */ FAM_SAND,
  /* 11 sand-grey            */ FAM_SAND,
  /* 12 sand-rockStrewn      */ FAM_SAND,
  /* 13 SedimentaryRock      */ FAM_ROCK,
  /* 14 SemiBarrenRock       */ FAM_ROCK,
  /* 15 Snow                 */ FAM_SNOWICE,
  /* 16 WaterRunning         */ FAM_WATER,
  /* 17 WaterStandingFresh   */ FAM_WATER,
  /* 18 WaterShallowSea      */ FAM_WATER,
  /* 19 WaterShallowStillSea */ FAM_WATER,
  /* 20 WaterDeepSea         */ FAM_WATER,
  /* 21 forestfloor          */ FAM_GRASS,
  /* 22 FauxWaterRunning     */ FAM_NONE,
  /* 23 SeaSlime             */ FAM_SWAMP,
  /* 24 Argila               */ FAM_DIRT,
  /* 25 Volcano1             */ FAM_VOLCANO,
  /* 26 Volcano2             */ FAM_VOLCANO,
  /* 27 BlueIce              */ FAM_SNOWICE,
  /* 28 Moss                 */ FAM_GRASS,
  /* 29 DarkMoss             */ FAM_GRASS,
  /* 30 olthoi               */ FAM_ROCK,
  /* 31 DesolateLands        */ FAM_DIRT,
]);

// ----- water sets ---------------------------------------------------
//
// Mirrors `terrain.js` (search `TERRAIN_WATER_CODES`) VERBATIM. That module is
// the single source of truth; these copies exist only so this file stays
// THREE-free. `setTerrainWaterCodes()` below lets the boot path inject
// `terrain.js`'s live set and remove all doubt.

/** `?strictWaterCodes` OFF — the legacy set, 22 and 23 animate as water. */
export const LEGACY_WATER_CODES = Object.freeze([16, 17, 18, 19, 20, 22, 23]);
/** `?strictWaterCodes` ON — retail's SurfChar water codes only. */
export const STRICT_WATER_CODES = Object.freeze([16, 17, 18, 19, 20]);

/**
 * ⚠ Reader copied VERBATIM from `terrain.js::readStrictWaterCodesFlag`,
 * INCLUDING its two surprises, because consistency with the shader's
 * `uWaterCodeMask` matters more than idiom purity here:
 *
 *  1. It is a `!== "off"` reader, so in a browser an ABSENT `?strictWaterCodes`
 *     reads ON — the live default is the STRICT set {16..20}, NOT the
 *     {16..23} set the design plan §1.2/§3.8.3 assumes. (Reported to the plan
 *     owner; the derivation requirement is met either way.)
 *  2. Outside a browser (`window` undefined — i.e. node tests) it returns
 *     FALSE, so the module default under node is the LEGACY set. Tests must
 *     therefore drive `buildTerrainFamilyLut()` explicitly rather than lean on
 *     the module-level LUT.
 *
 * @param {string} [search] optional query string, for tests. Defaults to
 *   `window.location.search`.
 */
export function readStrictWaterCodesFlag(search) {
  try {
    if (typeof search === "string") {
      return new URLSearchParams(search).get("strictWaterCodes") !== "off";
    }
    return typeof window !== "undefined" && window.location
      ? new URLSearchParams(window.location.search).get("strictWaterCodes") !== "off"
      : false;
  } catch (_) {
    return false;
  }
}

/** The water-code list this module would pick with no injection. */
export function defaultTerrainWaterCodes() {
  return readStrictWaterCodesFlag() ? STRICT_WATER_CODES : LEGACY_WATER_CODES;
}

/**
 * Build a fresh code→family `Uint8Array(32)`.
 *
 * @param {Iterable<number>} waterCodes the codes that count as water — pass
 *   `terrain.js`'s `PHASE_2_2_WATER_CODES` (or `LEGACY_/STRICT_WATER_CODES`).
 *   Out-of-range entries are ignored.
 * @returns {Uint8Array} length 32, values FAM_*
 */
export function buildTerrainFamilyLut(waterCodes) {
  const lut = new Uint8Array(TERRAIN_CODE_COUNT);
  for (let code = 0; code < TERRAIN_CODE_COUNT; code += 1) lut[code] = BASE_FAMILY[code];
  if (waterCodes) {
    for (const raw of waterCodes) {
      const code = raw | 0;
      if (code >= 0 && code < TERRAIN_CODE_COUNT) lut[code] = FAM_WATER;
    }
  }
  return lut;
}

/**
 * The live LUT. Mutated IN PLACE by `setTerrainWaterCodes` so every importer
 * keeps working off the same reference (module-eval order across the client is
 * not something an effect module should have to reason about).
 */
export const TERRAIN_CODE_TO_FAMILY = buildTerrainFamilyLut(defaultTerrainWaterCodes());

let _activeWaterCodes = Object.freeze(Array.from(defaultTerrainWaterCodes()));

/**
 * Re-derive the shared LUT from an authoritative water set. Call once at boot
 * with `terrain.js`'s `PHASE_2_2_WATER_CODES` so the whole client agrees about
 * `?strictWaterCodes`; the module default is only a fallback for early init
 * and node.
 */
export function setTerrainWaterCodes(waterCodes) {
  const next = buildTerrainFamilyLut(waterCodes);
  TERRAIN_CODE_TO_FAMILY.set(next);
  const list = [];
  for (let code = 0; code < TERRAIN_CODE_COUNT; code += 1) {
    if (TERRAIN_CODE_TO_FAMILY[code] === FAM_WATER) list.push(code);
  }
  _activeWaterCodes = Object.freeze(list);
  return TERRAIN_CODE_TO_FAMILY;
}

/** The codes currently mapped to FAM_WATER, ascending. */
export function terrainWaterCodes() {
  return _activeWaterCodes;
}

/**
 * Family for a terrain code. Masks to 5 bits exactly like `terrain.js:145`,
 * so a stray road/flag bit can never index off the end.
 * @param {number} code
 * @returns {number} FAM_*
 */
export function familyForCode(code) {
  return TERRAIN_CODE_TO_FAMILY[(code | 0) & 0x1f];
}

/** Convenience predicate — every scatter/emitter path must filter on this. */
export function isWaterCode(code) {
  return familyForCode(code) === FAM_WATER;
}

/** Diagnostic name for a FAM_* value. */
export function familyName(family) {
  return FAM_NAMES[family | 0] || "unknown";
}
