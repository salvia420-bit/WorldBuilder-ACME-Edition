// test_terrain_rock.mjs — the ROCK / BARREN family (Wave 4A, plan §3.3 items
// 1 and 2): the opaque, LIT instanced pebble/rubble scatter and the grey grit
// streamers. Codes 0, 13, 14, 30.
//
// Zero dependencies beyond `three` (which resolves as a bare import through
// node_modules — the plan §6 tier for anything touching InstancedMesh), zero
// GPU, zero browser. The GLSL assertions read the exported template literals as
// text; the behavioural assertions drive the real module headless, where the
// scatter pool and both fields are first-class with no THREE at all.
//
// Locks (plan §3.3 "Tests" — density scales with tier; the instance up-axis
// matches `oracle.sample().normal` within 1e-3; the olthoi variant only for
// code 30; zero pebbles on a grass LB — plus the §5 invariants every
// terrain-VFX module signs up to):
//   R1  FAMILY MEMBERSHIP IS DERIVED from `terrain_families.js` (never a
//       hardcoded [0,13,14,30]), the OLTHOI set is derived from the variant
//       table as a strict subset, and the variant table covers the family
//       exactly.
//   R2  DENSITY SCALES WITH TIER: the four presets carry every key, `low` is
//       null for the whole family, the pebble ladder is the plan's
//       0/3000/9000/18000, and `?terrainRockDensity` multiplies BOTH counts on
//       the live path.
//   R3  THE UP-AXIS IS THE GROUND NORMAL to within 1e-3 — in the `aNormal`
//       attribute the pool writes AND in `pebbleBasis`, on a tilted pebble too
//       (the lean lives in a separate channel precisely so this stays
//       assertable). The basis is orthonormal and right-handed.
//   R4  THE OLTHOI VARIANT IS CODE 30 ONLY: only 30 carries emissive, only 30
//       is shard-biased, and a live field over any other rock code writes a
//       zero emissive channel for every instance.
//   R5  ZERO PEBBLES ON A GRASS LB (and on water, dirt, snow…): the pool's
//       family gate writes them degenerate — zero scale in the attribute AND in
//       the instance matrix (plan §3.8.1).
//   R6  PLACEMENT + SHAPE ARE HASH-STABLE and pure: same seed, same cell, same
//       pebble, forever; no `Math.random`; two runs are byte-identical, and the
//       grit pool does NOT reuse the pebble pool's jitter points.
//   R7  GRIT ADVECTION is a pure function of (wind, clock, hash), bounded by
//       the recycle span, reversing with the wind — the same expression as
//       sand's `streamerAdvect` and snow's `spindriftAdvect` — and the GLSL
//       computes what the JS twin does.
//   R8  LIGHTING WITHOUT A LIGHT: the AC sun/ambient conversion matches
//       `loop.js::tickTerrainSunDir` (heading from +Y clockwise, dirBright as
//       the sun-colour magnitude, LSCAPE_LIGHT_MINIMUM flooring AMBIENT only),
//       it is quantised to the retail 15 s light tick, and NOTHING in the module
//       constructs a light.
//   R9  GLSL HYGIENE: no backtick anywhere, every uniform declared exactly once
//       per stage, `instanceMatrix` carries the degenerate kill, and the
//       distance blend is a SHRINK (the material stays opaque).
//   R10 FIREWALL + INVARIANTS over the module source (§5.2 no light count,
//       §5.3 no `.visible =`, §5.4 no per-instance cache key, §5.5 no
//       `Math.random`, §5.7 `castShadow = false`).
//   R11 FLAGS: three strict ship-OFF `=== "on"` opt-ins, keys on all four tiers
//       in the right coercion sets, docs rows present, the router rows compose
//       the family master, and the DEFAULT-ON effect count is still 14.
//   R12 BARE DEFAULT IS BYTE-IDENTICAL: `initTerrainRock` registers nothing and
//       allocates nothing with no flags, and `?wireframe=1` is a hard no-op.
//   R13 HEADLESS: both fields run with no THREE at all (the `?nullRender=1`
//       path), and with THREE the meshes are `castShadow === false` with their
//       instance buffers allocated exactly once.
//
// Run from apps/holtburger-web/:  node test_terrain_rock.mjs

import { readFileSync } from "node:fs";
import * as THREE from "three";
import {
  ROCK_TUNING,
  ROCK_VARIANTS,
  ROCK_PEBBLE_VERTEX_GLSL,
  ROCK_PEBBLE_FRAGMENT_GLSL,
  ROCK_PEBBLE_SCHEMA,
  ROCK_GRIT_VERTEX_GLSL,
  ROCK_GRIT_FRAGMENT_GLSL,
  ROCK_GRIT_SCHEMA,
  ROCK_LIGHT_TICK_SEC,
  ROCK_AMBIENT_MINIMUM,
  OLTHOI_EMISSIVE_COLOUR,
  PEBBLE_SHAPE_ROUND,
  PEBBLE_SHAPE_PLATE,
  PEBBLE_SHAPE_SHARD,
  PEBBLE_SHAPE_COUNT,
  PEBBLE_SHAPE_PROFILES,
  PEBBLE_PROVIDER_ID,
  GRIT_PROVIDER_ID,
  rockTerrainCodes,
  rockCodeBitmask,
  olthoiTerrainCodes,
  olthoiCodeBitmask,
  resolveRockQuality,
  windAcFromGlobals,
  gritAdvect,
  pebbleShapeFor,
  pebbleDimensions,
  pebbleBasis,
  rockSunFromSkyState,
  createPebbleField,
  createGritField,
  initTerrainRock,
  terrainRockStats,
  _resetTerrainRock,
} from "./scene3d/terrain_rock.js";
import {
  FAM_ROCK, FAM_GRASS, TERRAIN_CODE_COUNT, familyForCode,
} from "./scene3d/terrain_families.js";
import { instanceCountFor } from "./scene3d/terrain_scatter.js";
import { PRESETS, PRESET_NAMES } from "./scene3d/quality.js";
import { _resetTerrainVfx } from "./scene3d/terrain_vfx.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

const ROCK_SRC = readFileSync("./scene3d/terrain_rock.js", "utf8");
const QUALITY = readFileSync("./scene3d/quality.js", "utf8");
const FLAGS = readFileSync("./scene3d/vfx_flags.js", "utf8");
const FLAGS_DOC = readFileSync("./docs/url-flags.md", "utf8");
const PRESET_DOC = readFileSync("../../docs/quality-presets.md", "utf8");
const INDEX = readFileSync("./scene3d/index.js", "utf8");
// Comment-stripped source, for the denylist sweeps: this module EXPLAINS its
// invariants in prose ("never a light", "no `Math.random`"), so a naive
// substring test over the raw text finds the very words it is proving absent.
const ROCK_CODE = ROCK_SRC
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
const countOf = (hay, needle) => hay.split(needle).length - 1;
/** Count `uniform <type> <name>;` declarations, tolerating the alignment
 *  whitespace the GLSL blocks use for readability. */
const uniformCount = (src, type, name) =>
  (src.match(new RegExp(`uniform\\s+${type}\\s+${name}\\s*;`, "g")) || []).length;

/** A terrain oracle stand-in. `codeAt` returns null for "no landblock". */
function fakeOracle(codeAt, normal = { x: 0, y: 0, z: 1 }, height = 10) {
  return {
    sample(x, y) {
      const code = codeAt(x, y);
      if (code === null || code === undefined) return null;
      return {
        code, family: familyForCode(code), height, hasHeight: true,
        normal, cornerCodes: null,
      };
    },
    heightAt: () => height,
  };
}

// The flag harness. Every reader memoizes, so the window has to be in place
// BEFORE the first read and `_resetVfxFlags()` after every change.
const {
  _resetVfxFlags, terrainRockEnabled, terrainRockPebblesEnabled,
  terrainRockGritEnabled, terrainRockPebbleCount, terrainRockGritCount,
  terrainRockRadiusM, terrainRockDensity, vfxEffectEnabled, VFX_EFFECT_FLAGS,
} = await import("./scene3d/vfx_flags.js");
const { _resetVfxCatalog } = await import("./scene3d/vfx_catalog.js");
function setUrl(search, qualityFlags = PRESETS.high) {
  globalThis.window = {
    location: { search },
    liveScene3d: { quality: { flags: { ...qualityFlags } } },
  };
  _resetVfxCatalog();
  _resetVfxFlags();
}
function clearUrl() { delete globalThis.window; _resetVfxCatalog(); _resetVfxFlags(); }

// ===========================================================================
console.log("\n-- R1 family membership is DERIVED, olthoi is a subset ----------");
// ===========================================================================
const CODES = rockTerrainCodes();
check("rockTerrainCodes() === FAM_ROCK codes {0,13,14,30}",
  CODES.join() === "0,13,14,30", CODES.join());
check("every rock code really is FAM_ROCK per the family LUT",
  CODES.every((c) => familyForCode(c) === FAM_ROCK));
check("no NON-rock code leaks into the set",
  Array.from({ length: TERRAIN_CODE_COUNT }, (_, c) => c)
    .filter((c) => familyForCode(c) === FAM_ROCK).join() === CODES.join());
check("the module never hardcodes the code list",
  !/\[\s*0\s*,\s*13\s*,\s*14\s*,\s*30\s*\]/.test(ROCK_CODE));
check("rockCodeBitmask() sets exactly bits 0, 13, 14, 30",
  rockCodeBitmask() === (((1 << 0) | (1 << 13) | (1 << 14) | (1 << 30)) >>> 0),
  rockCodeBitmask().toString(2));
check("olthoiTerrainCodes() === [30], DERIVED from the variant table",
  olthoiTerrainCodes().join() === "30", olthoiTerrainCodes().join());
check("the olthoi mask is a STRICT SUBSET of the rock mask",
  (olthoiCodeBitmask() & rockCodeBitmask()) === olthoiCodeBitmask()
  && olthoiCodeBitmask() !== rockCodeBitmask());
check("ROCK_VARIANTS covers the family EXACTLY (no orphan row, no gap)",
  Object.keys(ROCK_VARIANTS).map(Number).sort((a, b) => a - b).join() === CODES.join(),
  Object.keys(ROCK_VARIANTS).join());
check("every variant row carries the full parameter set",
  CODES.every((c) => {
    const v = ROCK_VARIANTS[c];
    return v && Number.isFinite(v.density) && Number.isFinite(v.sizeM)
      && Array.isArray(v.shape) && v.shape.length === PEBBLE_SHAPE_COUNT
      && Array.isArray(v.tint) && v.tint.length === 3
      && Number.isFinite(v.emissive) && Number.isFinite(v.grit)
      && typeof v.olthoi === "boolean";
  }));
check("13 and 14 are PLATE-biased (plan §3.3: flatter shale plates)",
  ROCK_VARIANTS[13].shape[PEBBLE_SHAPE_PLATE] > ROCK_VARIANTS[13].shape[PEBBLE_SHAPE_ROUND]
  && ROCK_VARIANTS[14].shape[PEBBLE_SHAPE_PLATE] > ROCK_VARIANTS[14].shape[PEBBLE_SHAPE_ROUND]);
check("0 (BarrenRock) is ROUND-biased, the reference cobble",
  ROCK_VARIANTS[0].shape[PEBBLE_SHAPE_ROUND] > ROCK_VARIANTS[0].shape[PEBBLE_SHAPE_PLATE]);
check("30 (olthoi) is SHARD-biased (plan §3.3: chitinous shards)",
  ROCK_VARIANTS[30].shape[PEBBLE_SHAPE_SHARD]
    > ROCK_VARIANTS[30].shape[PEBBLE_SHAPE_ROUND] + ROCK_VARIANTS[30].shape[PEBBLE_SHAPE_PLATE]);
check("there are exactly three shape profiles",
  PEBBLE_SHAPE_PROFILES.length === PEBBLE_SHAPE_COUNT && PEBBLE_SHAPE_COUNT === 3);
check("the shard profile leans hardest, the plate flattest",
  PEBBLE_SHAPE_PROFILES[PEBBLE_SHAPE_SHARD].tilt > PEBBLE_SHAPE_PROFILES[PEBBLE_SHAPE_PLATE].tilt
  && PEBBLE_SHAPE_PROFILES[PEBBLE_SHAPE_PLATE].scale[2] < PEBBLE_SHAPE_PROFILES[PEBBLE_SHAPE_ROUND].scale[2]);

// ===========================================================================
console.log("\n-- R2 the quality ladder + the density knob ---------------------");
// ===========================================================================
const ROCK_KEYS = ["terrainRock", "terrainRockPebbleCount", "terrainRockGritCount",
  "terrainRockRadius"];
for (const tier of PRESET_NAMES) {
  for (const k of ROCK_KEYS) {
    check(`PRESETS.${tier} carries ${k}`,
      Object.prototype.hasOwnProperty.call(PRESETS[tier], k));
  }
  check(`PRESETS.${tier}.terrainRock is false (ship-OFF master, §5.9)`,
    PRESETS[tier].terrainRock === false);
}
check("low is null for the whole family (plan §5.8)",
  resolveRockQuality(PRESETS.low) === null);
check("the pebble ladder is the plan's 0 / 3000 / 9000 / 18000",
  PRESETS.low.terrainRockPebbleCount === 0
  && PRESETS.mid.terrainRockPebbleCount === 3000
  && PRESETS.high.terrainRockPebbleCount === 9000
  && PRESETS.ultra.terrainRockPebbleCount === 18000);
check("the grit ladder is §3.2's streamer ladder at the 1/5 density §3.3 asks for",
  PRESETS.low.terrainRockGritCount === 0
  && PRESETS.mid.terrainRockGritCount === Math.round(PRESETS.mid.terrainSandStreamerCount / 5)
  && PRESETS.high.terrainRockGritCount === Math.round(PRESETS.high.terrainSandStreamerCount / 5)
  && PRESETS.ultra.terrainRockGritCount === Math.round(PRESETS.ultra.terrainSandStreamerCount / 5));
check("the radius ladder rises 32 / 40 / 56 / 72",
  PRESETS.low.terrainRockRadius === 32 && PRESETS.mid.terrainRockRadius === 40
  && PRESETS.high.terrainRockRadius === 56 && PRESETS.ultra.terrainRockRadius === 72);
check("mid resolves to pebbles + grit, high and ultra scale up",
  (() => {
    const m = resolveRockQuality(PRESETS.mid);
    const h = resolveRockQuality(PRESETS.high);
    const u = resolveRockQuality(PRESETS.ultra);
    return m && h && u && m.pebbleCount < h.pebbleCount && h.pebbleCount < u.pebbleCount
      && m.gritCount < h.gritCount && h.gritCount < u.gritCount
      && m.radiusM < h.radiusM && h.radiusM < u.radiusM;
  })());
check("resolveRockQuality is null for an empty bag",
  resolveRockQuality({}) === null && resolveRockQuality(null) === null);
check("resolveRockQuality is PURE in flags (two calls agree)",
  JSON.stringify(resolveRockQuality(PRESETS.ultra))
  === JSON.stringify(resolveRockQuality(PRESETS.ultra)));
// Coercion sets — booleans OUT (the gfxRelief rule), numerics IN.
check("the three rock booleans are NOT in BOOL_FLAGS (the gfxRelief rule)",
  (() => {
    const bools = QUALITY.slice(QUALITY.indexOf("const BOOL_FLAGS"), QUALITY.indexOf("const INT_FLAGS"));
    return ["terrainRock", "terrainRockPebbles", "terrainRockGrit"]
      .every((k) => !bools.includes(`"${k}"`));
  })());
check("terrainRockPebbleCount + terrainRockGritCount are in INT_FLAGS",
  (() => {
    const ints = QUALITY.slice(QUALITY.indexOf("const INT_FLAGS"), QUALITY.indexOf("const FLOAT_FLAGS"));
    return ints.includes('"terrainRockPebbleCount"') && ints.includes('"terrainRockGritCount"');
  })());
check("terrainRockRadius is in FLOAT_FLAGS",
  QUALITY.slice(QUALITY.indexOf("const FLOAT_FLAGS"), QUALITY.indexOf("function parseBool"))
    .includes('"terrainRockRadius"'));
check("terrainRockDensity is URL-ONLY (no preset key on any tier)",
  PRESET_NAMES.every((t) => !Object.prototype.hasOwnProperty.call(PRESETS[t], "terrainRockDensity")));

// ===========================================================================
console.log("\n-- R3 the up-axis IS the ground normal --------------------------");
// ===========================================================================
{
  // A deliberately tilted, normalised ground normal.
  let n = { x: 0.24, y: -0.13, z: 0.96 };
  const nl = Math.hypot(n.x, n.y, n.z);
  n = { x: n.x / nl, y: n.y / nl, z: n.z / nl };
  const field = createPebbleField({
    oracle: fakeOracle(() => 0, n), count: 400, radiusM: 24, seed: 7,
  });
  field.update(0.016, 0, 500, 500, 10, null);
  const nrm = field.pool.arrays.aNormal;
  let live = 0;
  let worst = 0;
  for (let i = 0; i < field.pool.count; i += 1) {
    if (!field.pool.isLive(i)) continue;
    live += 1;
    worst = Math.max(worst,
      Math.abs(nrm[i * 3] - n.x), Math.abs(nrm[i * 3 + 1] - n.y), Math.abs(nrm[i * 3 + 2] - n.z));
  }
  check("the field placed live pebbles at all", live > 0, String(live));
  check("EVERY live instance's aNormal matches oracle.sample().normal within 1e-3",
    worst < 1e-3, String(worst));
  // The basis twin.
  const b0 = pebbleBasis(n.x, n.y, n.z, 1.234, 0);
  check("pebbleBasis(tilt=0).up === the ground normal within 1e-3",
    Math.abs(b0.up.x - n.x) < 1e-3 && Math.abs(b0.up.y - n.y) < 1e-3
    && Math.abs(b0.up.z - n.z) < 1e-3);
  const b1 = pebbleBasis(n.x, n.y, n.z, 1.234, 0.4);
  check("a TILTED pebble still reports the untilted groundUp === the normal",
    Math.abs(b1.groundUp.x - n.x) < 1e-3 && Math.abs(b1.groundUp.y - n.y) < 1e-3
    && Math.abs(b1.groundUp.z - n.z) < 1e-3);
  const dot = b1.up.x * n.x + b1.up.y * n.y + b1.up.z * n.z;
  check("the tilt is EXACTLY the requested angle (dot === cos(tilt))",
    approx(dot, Math.cos(0.4), 1e-9), String(dot));
  const len = (v) => Math.hypot(v.x, v.y, v.z);
  const dt3 = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  check("the basis is orthonormal",
    approx(len(b1.ex), 1, 1e-9) && approx(len(b1.ey), 1, 1e-9) && approx(len(b1.up), 1, 1e-9)
    && approx(dt3(b1.ex, b1.ey), 0, 1e-9) && approx(dt3(b1.ex, b1.up), 0, 1e-9)
    && approx(dt3(b1.ey, b1.up), 0, 1e-9));
  const cx = b1.ex.y * b1.ey.z - b1.ex.z * b1.ey.y;
  const cy = b1.ex.z * b1.ey.x - b1.ex.x * b1.ey.z;
  const cz = b1.ex.x * b1.ey.y - b1.ex.y * b1.ey.x;
  check("the basis is RIGHT-handed (ex x ey === up)",
    approx(cx, b1.up.x, 1e-9) && approx(cy, b1.up.y, 1e-9) && approx(cz, b1.up.z, 1e-9));
  check("a degenerate (zero) normal falls back to +Z rather than NaN",
    (() => { const b = pebbleBasis(0, 0, 0, 0, 0); return b.up.z === 1 && b.up.x === 0; })());
  field.dispose();
}

// ===========================================================================
console.log("\n-- R4 the olthoi variant is code 30 ONLY ------------------------");
// ===========================================================================
check("only code 30 carries a non-zero emissive in the variant table",
  CODES.every((c) => (c === 30) === (ROCK_VARIANTS[c].emissive > 0)));
check("only code 30 is flagged olthoi",
  CODES.every((c) => (c === 30) === (ROCK_VARIANTS[c].olthoi === true)));
check("the olthoi glow is a dim GREEN (a fragment term, never a light)",
  OLTHOI_EMISSIVE_COLOUR[1] > OLTHOI_EMISSIVE_COLOUR[0]
  && OLTHOI_EMISSIVE_COLOUR[1] > OLTHOI_EMISSIVE_COLOUR[2]
  && OLTHOI_EMISSIVE_COLOUR[1] < 1);
for (const code of CODES) {
  const field = createPebbleField({
    oracle: fakeOracle(() => code), count: 256, radiusM: 20, seed: 11,
  });
  field.update(0.016, 0, 300, 300, 10, null);
  const rock = field.pool.arrays.aRock;
  let anyEmissive = false;
  let allEmissive = true;
  let liveN = 0;
  for (let i = 0; i < field.pool.count; i += 1) {
    if (!field.pool.isLive(i)) continue;
    liveN += 1;
    if (rock[i * 3 + 2] > 0) anyEmissive = true; else allEmissive = false;
  }
  check(`code ${code}: ${code === 30 ? "every" : "no"} live pebble carries emissive`,
    liveN > 0 && (code === 30 ? allEmissive : !anyEmissive), `live=${liveN}`);
  field.dispose();
}
check("pebbleShapeFor on code 30 draws SHARD for the bulk of the hash range",
  (() => {
    let shards = 0;
    for (let i = 0; i < 1000; i += 1) {
      if (pebbleShapeFor(30, i / 1000) === PEBBLE_SHAPE_SHARD) shards += 1;
    }
    return shards > 700;
  })());
check("pebbleShapeFor on code 13 draws PLATE for the bulk of the hash range",
  (() => {
    let plates = 0;
    for (let i = 0; i < 1000; i += 1) {
      if (pebbleShapeFor(13, i / 1000) === PEBBLE_SHAPE_PLATE) plates += 1;
    }
    return plates > 550;
  })());
check("pebbleShapeFor is a partition (every draw returns a valid shape)",
  (() => {
    for (const c of CODES) {
      for (let i = 0; i <= 1000; i += 1) {
        const s = pebbleShapeFor(c, i / 1000);
        if (!(s >= 0 && s < PEBBLE_SHAPE_COUNT)) return false;
      }
    }
    return true;
  })());
check("pebbleShapeFor on an UNKNOWN code falls back to ROUND",
  pebbleShapeFor(99, 0.9) === PEBBLE_SHAPE_ROUND);
check("pebbleDimensions is deterministic and positive on every axis",
  (() => {
    const a = pebbleDimensions(30, PEBBLE_SHAPE_SHARD, 0.3, 0.4, 0.5, 0.6);
    const b = pebbleDimensions(30, PEBBLE_SHAPE_SHARD, 0.3, 0.4, 0.5, 0.6);
    return a.x === b.x && a.y === b.y && a.z === b.z && a.x > 0 && a.y > 0 && a.z > 0;
  })());
check("a SHARD is taller than wide, a PLATE wider than tall",
  (() => {
    const s = pebbleDimensions(0, PEBBLE_SHAPE_SHARD, 0.5, 0.5, 0.5, 0.5);
    const p = pebbleDimensions(0, PEBBLE_SHAPE_PLATE, 0.5, 0.5, 0.5, 0.5);
    return s.z > s.x && p.x > p.z;
  })());

// ===========================================================================
console.log("\n-- R5 zero pebbles off-family ----------------------------------");
// ===========================================================================
for (const [label, code] of [["grass (1)", 1], ["water (17)", 17], ["dirt (5)", 5],
  ["snow (15)", 15], ["swamp (4)", 4], ["volcano (6)", 6]]) {
  const field = createPebbleField({
    oracle: fakeOracle(() => code), count: 400, radiusM: 24, seed: 3,
  });
  field.update(0.016, 0, 700, 700, 10, null);
  const st = field.pool.stats();
  check(`a ${label} landblock places ZERO pebbles`, st.live === 0, JSON.stringify(st.live));
  check(`a ${label} landblock writes them DEGENERATE (zero scale)`,
    (() => {
      const sc = field.pool.arrays.aScale;
      for (let i = 0; i < sc.length; i += 1) if (sc[i] !== 0) return false;
      return true;
    })());
  field.dispose();
}
check("FAM_GRASS really is a different family (the gate is not vacuous)",
  familyForCode(1) === FAM_GRASS && FAM_GRASS !== FAM_ROCK);
{
  // Half the world is rock: pebbles land on the rock half and nowhere else.
  const field = createPebbleField({
    oracle: fakeOracle((x) => (x > 1000 ? 0 : 1)), count: 900, radiusM: 40, seed: 5,
  });
  field.update(0.016, 0, 1000, 1000, 10, null);
  const off = field.pool.arrays.aOffset;
  let bad = 0;
  let live = 0;
  for (let i = 0; i < field.pool.count; i += 1) {
    if (!field.pool.isLive(i)) continue;
    live += 1;
    if (off[i * 3] <= 1000) bad += 1;
  }
  check("a MIXED landblock places pebbles only on the rock side",
    live > 0 && bad === 0, `live=${live} bad=${bad}`);
  field.dispose();
}
{
  const field = createPebbleField({ oracle: fakeOracle(() => null), count: 100, radiusM: 16 });
  field.update(0.016, 0, 200, 200, 10, null);
  check("an UNBAKED landblock (null sample) places nothing and does not throw",
    field.pool.stats().live === 0 && field.pool.stats().nullSamples > 0);
  field.dispose();
}

// ===========================================================================
console.log("\n-- R6 placement + shape are hash-stable ------------------------");
// ===========================================================================
{
  const mk = () => {
    const f = createPebbleField({
      oracle: fakeOracle(() => 0), count: 256, radiusM: 24, seed: 0x1234,
    });
    f.update(0.016, 0, 400, 400, 10, null);
    return f;
  };
  const a = mk();
  const b = mk();
  // LIVE instances only: the pool leaves stale attribute residue on the
  // degenerate ones (they are zero-area, so nothing reads it), and a window
  // that has scrolled has a different set of out-of-disc corner slots.
  const same = () => {
    if (a.pool.stats().live !== b.pool.stats().live) return false;
    for (let i = 0; i < a.pool.count; i += 1) {
      if (a.pool.isLive(i) !== b.pool.isLive(i)) return false;
      if (!a.pool.isLive(i)) continue;
      for (const s of ROCK_PEBBLE_SCHEMA) {
        const x = a.pool.arrays[s.name];
        const y = b.pool.arrays[s.name];
        for (let k = 0; k < s.itemSize; k += 1) {
          if (x[i * s.itemSize + k] !== y[i * s.itemSize + k]) return false;
        }
      }
    }
    return true;
  };
  check("two independent fields at the same seed are BYTE-identical", same());
  // Walk away and come back — the same pebbles return to the same places.
  a.update(0.016, 0, 900, 900, 10, null);
  for (let i = 0; i < 40; i += 1) a.update(0.016, 0, 400, 400, 10, null);
  check("walking away and back restores the identical placement", same());
  a.dispose();
  b.dispose();
}
{
  // The grit pool must NOT sit on top of the pebbles: a different pool SEED,
  // not merely a different rand salt (placement is unsalted by design).
  const oracle = fakeOracle(() => 0);
  const p = createPebbleField({ oracle, count: 256, radiusM: 24, seed: 0x99 });
  const g = createGritField({ oracle, count: 256, radiusM: 24, seed: 0x99 });
  p.update(0.016, 0, 600, 600, 10, null);
  g.update(0.016, 0, 600, 600, 10);
  check("the grit pool uses a DIFFERENT seed from the pebble pool",
    g.pool.seed !== p.pool.seed, `${g.pool.seed} vs ${p.pool.seed}`);
  let coincident = 0;
  const pa = p.pool.arrays.aOffset;
  const ga = g.pool.arrays.aOffset;
  for (let i = 0; i < p.pool.count; i += 1) {
    if (Math.abs(pa[i * 3] - ga[i * 3]) < 1e-6 && Math.abs(pa[i * 3 + 1] - ga[i * 3 + 1]) < 1e-6) {
      coincident += 1;
    }
  }
  check("no grit streak lands exactly on its pebble", coincident === 0, String(coincident));
  p.dispose();
  g.dispose();
}
check("the module never calls Math.random (plan §5.5)",
  !/Math\s*\.\s*random/.test(ROCK_CODE));

// ===========================================================================
console.log("\n-- R7 grit advection is pure, bounded and reversible ------------");
// ===========================================================================
{
  const span = ROCK_TUNING.advectSpanM;
  const speed = ROCK_TUNING.advectSpeed;
  const a = gritAdvect(1, 0, 12.5, 0.31, span, speed);
  const b = gritAdvect(1, 0, 12.5, 0.31, span, speed);
  check("same inputs ⇒ same offset (pure)", a.x === b.x && a.y === b.y && a.s === b.s);
  check("the offset is bounded by half the recycle span",
    Math.abs(a.s) <= span * 0.5 + 1e-9, String(a.s));
  const fwd = gritAdvect(1, 0, 3, 0, span, speed);
  const rev = gritAdvect(-1, 0, 3, 0, span, speed);
  check("reversing the wind reverses the travel", approx(fwd.x, -rev.x, 1e-9));
  check("the offset runs ALONG the wind direction",
    approx(gritAdvect(0, 1, 3, 0, span, speed).x, 0, 1e-9));
  let maxS = -Infinity, minS = Infinity;
  for (let i = 0; i < 4000; i += 1) {
    const o = gritAdvect(0.7, -0.7, i * 0.01, 0.5, span, speed);
    maxS = Math.max(maxS, o.s); minS = Math.min(minS, o.s);
  }
  check("the streak sweeps the whole span over time",
    maxS > span * 0.45 && minS < -span * 0.45, `${minS}..${maxS}`);
  check("a zero wind does not divide by zero",
    Number.isFinite(gritAdvect(0, 0, 5, 0.2, span, speed).x));
  // The GLSL twin: the same expression, symbol for symbol.
  check("the grit GLSL computes the same advection expression",
    ROCK_GRIT_VERTEX_GLSL.includes("float travelled = uTime * uSpeed * aGrit.y * wl + aGrit.x * uSpanM;")
    && ROCK_GRIT_VERTEX_GLSL.includes("float s = mod(travelled, uSpanM) - uSpanM * 0.5;"));
  check("the rock parameters really are the plan's 'shorter, greyer' block",
    ROCK_TUNING.advectSpanM < 26 && ROCK_TUNING.streakLengthM < 2.6
    && ROCK_TUNING.opacity < 0.16
    && ROCK_TUNING.colour[0] > ROCK_TUNING.colour[2]
    && Math.abs(ROCK_TUNING.colour[0] - ROCK_TUNING.colour[2]) < 0.1);
}
{
  // The shared wind vector, and the tree_wind fallback.
  const w = windAcFromGlobals({ uWindDir: { value: { x: 0.6, y: -0.8 } } }, { x: 0, y: 0 });
  check("VFX_GLOBALS.uWindDir maps (x, z_three) → (x, -y_ac)",
    w.x === 0.6 && w.y === 0.8);
  const f = windAcFromGlobals(null, { x: 0, y: 0 });
  check("no globals ⇒ the 135° SE tree_wind fallback, unit length",
    approx(Math.hypot(f.x, f.y), 1, 1e-9) && f.x < 0 && f.y > 0);
}

// ===========================================================================
console.log("\n-- R8 lighting without a light ---------------------------------");
// ===========================================================================
{
  // Noon: heading 90 (east), pitch 60.
  const s = rockSunFromSkyState({
    dirHeading: 90, dirPitch: 60, dirBright: 0.8,
    dirColorArgb: 0xffffffff, ambColorArgb: 0xff808080, ambBright: 0.5,
  });
  check("the sun vector is the loop.js conversion (heading from +Y, clockwise)",
    s.ok && approx(s.x, Math.cos(Math.PI / 3) * 1, 1e-9)
    && approx(s.y, Math.cos(Math.PI / 3) * Math.cos(Math.PI / 2), 1e-9)
    && approx(s.z, Math.sin(Math.PI / 3), 1e-9),
    `${s.x},${s.y},${s.z}`);
  check("the sun vector is unit length",
    approx(Math.hypot(s.x, s.y, s.z), 1, 1e-9));
  check("dirBright is the sun-colour MAGNITUDE (acclient SkyDesc::GetLighting)",
    approx(s.sun[0], 0.8, 1e-9) && approx(s.sun[1], 0.8, 1e-9));
  check("the ambient colour is unpacked from ARGB",
    approx(s.amb[0], 128 / 255, 1e-9));
  check("ambBright above the floor passes through", approx(s.ambLevel, 0.5, 1e-9));
  const night = rockSunFromSkyState({
    dirHeading: 270, dirPitch: -20, dirBright: 0,
    dirColorArgb: 0xff203040, ambColorArgb: 0xff101018, ambBright: 0.02,
  });
  check("at night dirBright 0 kills the sun term entirely (no glowing rocks)",
    night.sun[0] === 0 && night.sun[1] === 0 && night.sun[2] === 0);
  check("LSCAPE_LIGHT_MINIMUM floors the AMBIENT only",
    approx(night.ambLevel, ROCK_AMBIENT_MINIMUM, 1e-9) && ROCK_AMBIENT_MINIMUM === 0.2);
  check("a missing/!finite snapshot reports ok:false and changes nothing",
    rockSunFromSkyState(null).ok === false
    && rockSunFromSkyState({ dirHeading: NaN, dirPitch: 1 }).ok === false);
}
{
  // The 15 s retail light tick (LScape::UseTime; loop.js quantises the ground
  // to the same cadence, and the pebbles must step WITH it).
  const field = createPebbleField({ oracle: fakeOracle(() => 0), count: 64, radiusM: 16 });
  const sky = (bright) => ({
    dirHeading: 90, dirPitch: 45, dirBright: bright,
    dirColorArgb: 0xffffffff, ambColorArgb: 0xffffffff, ambBright: 0.4,
  });
  field.update(0.016, 0, 100, 100, 10, sky(1));
  check("the first frame resolves the sun", field.stats().lightTicks === 1);
  field.update(0.016, ROCK_LIGHT_TICK_SEC - 1, 100, 100, 10, sky(0.1));
  check("a mid-tick sky change does NOT re-light (retail cadence)",
    field.stats().lightTicks === 1 && approx(field.light.sun[0], 1, 1e-9));
  field.update(0.016, ROCK_LIGHT_TICK_SEC + 0.1, 100, 100, 10, sky(0.1));
  check("crossing the tick re-lights", field.stats().lightTicks === 2
    && approx(field.light.sun[0], 0.1, 1e-9));
  check("the light tick is the retail 15 s", ROCK_LIGHT_TICK_SEC === 15);
  field.invalidateLight();
  field.update(0.016, ROCK_LIGHT_TICK_SEC + 0.2, 100, 100, 10, sky(0.7));
  check("invalidateLight() forces an out-of-cadence re-read (diag seam)",
    field.stats().lightTicks === 3);
  field.update(0.016, 1e6, 100, 100, 10, null);
  check("a NULL snapshot leaves the last light standing (fail-soft)",
    approx(field.light.sun[0], 0.7, 1e-9));
  field.dispose();
}
check("nothing in the module constructs a light (§5.2)",
  !/new\s+THREE\.[A-Za-z]*Light/.test(ROCK_CODE) && !/lightCount/.test(ROCK_CODE));
check("the module reads the CACHED sky snapshot, never getSkyState() (plan §2.3)",
  ROCK_CODE.includes("skyLightingController?._lastState") && !ROCK_CODE.includes("getSkyState()"));

// ===========================================================================
console.log("\n-- R9 GLSL hygiene ---------------------------------------------");
// ===========================================================================
const GLSL = [
  ["pebble vertex", ROCK_PEBBLE_VERTEX_GLSL],
  ["pebble fragment", ROCK_PEBBLE_FRAGMENT_GLSL],
  ["grit vertex", ROCK_GRIT_VERTEX_GLSL],
  ["grit fragment", ROCK_GRIT_FRAGMENT_GLSL],
];
for (const [name, src] of GLSL) {
  check(`${name} GLSL contains no backtick`, !src.includes("`"));
  check(`${name} GLSL declares precision once`, countOf(src, "precision highp float;") === 1);
}
const PEBBLE_UNIFORMS = [
  ["uTime", "float"], ["uSunDir", "vec3"], ["uSunColour", "vec3"],
  ["uAmbColour", "vec3"], ["uAmbLevel", "float"], ["uPulseHz", "float"],
  ["uScatterCenter", "vec3"], ["uScatterRadius", "float"],
  ["uScatterFadeStart", "float"], ["uScatterShape", "int"],
];
for (const [n, t] of PEBBLE_UNIFORMS) {
  check(`pebble vertex declares ${n} exactly once`,
    uniformCount(ROCK_PEBBLE_VERTEX_GLSL, t, n) === 1);
  check(`pebble FRAGMENT does not redeclare ${n}`,
    uniformCount(ROCK_PEBBLE_FRAGMENT_GLSL, t, n) === 0);
}
check("uEmissiveColour is declared in the FRAGMENT stage only",
  uniformCount(ROCK_PEBBLE_FRAGMENT_GLSL, "vec3", "uEmissiveColour") === 1
  && !ROCK_PEBBLE_VERTEX_GLSL.includes("uEmissiveColour"));
for (const [n, t] of [["uTime", "float"], ["uWindAc", "vec2"], ["uSpanM", "float"],
  ["uSpeed", "float"], ["uPulseFreq", "float"], ["uPulseScroll", "float"],
  ["uPulseThreshold", "float"], ["uScatterRadius", "float"]]) {
  check(`grit vertex declares ${n} exactly once`,
    uniformCount(ROCK_GRIT_VERTEX_GLSL, t, n) === 1);
}
check("neither vertex shader redeclares three's built-in position/normal/uv",
  !/attribute\s+vec3\s+position;/.test(ROCK_PEBBLE_VERTEX_GLSL)
  && !/attribute\s+vec3\s+normal;/.test(ROCK_PEBBLE_VERTEX_GLSL)
  && !/attribute\s+vec2\s+uv;/.test(ROCK_GRIT_VERTEX_GLSL));
check("both vertex shaders route through instanceMatrix (the degenerate kill)",
  ROCK_PEBBLE_VERTEX_GLSL.includes("instanceMatrix * vec4(local, 1.0)")
  && ROCK_GRIT_VERTEX_GLSL.includes("instanceMatrix * vec4(local, 1.0)"));
check("the pebble distance blend is a SHRINK, not an alpha ramp",
  ROCK_PEBBLE_VERTEX_GLSL.includes("vec3 s = aScale * fade;")
  && !ROCK_PEBBLE_FRAGMENT_GLSL.includes("discard")
  && ROCK_PEBBLE_FRAGMENT_GLSL.includes("vec4(c, 1.0)"));
check("the pebble shader lights from the AC sun with the ambient floored",
  ROCK_PEBBLE_VERTEX_GLSL.includes("clamp(dot(nAc, uSunDir), 0.0, 1.0)")
  && ROCK_PEBBLE_VERTEX_GLSL.includes("uAmbColour * uAmbLevel"));
check("the emissive is ADDED after the light term (it survives the night)",
  ROCK_PEBBLE_FRAGMENT_GLSL.includes("vTint * vLight + uEmissiveColour"));
check("the pebble basis GLSL matches pebbleBasis's reference-axis branch",
  ROCK_PEBBLE_VERTEX_GLSL.includes("abs(up.x) > 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)"));
check("both schemas name aOffset first (the pool's offset attribute)",
  ROCK_PEBBLE_SCHEMA[0].name === "aOffset" && ROCK_GRIT_SCHEMA[0].name === "aOffset");
check("every pebble schema attribute is declared in the pebble vertex shader",
  ROCK_PEBBLE_SCHEMA.every((a) => ROCK_PEBBLE_VERTEX_GLSL.includes(` ${a.name};`)));
check("every grit schema attribute is declared in the grit vertex shader",
  ROCK_GRIT_SCHEMA.every((a) => ROCK_GRIT_VERTEX_GLSL.includes(` ${a.name};`)));
check("the pool's normal attribute name matches the schema (aNormal)",
  ROCK_PEBBLE_SCHEMA.some((a) => a.name === "aNormal" && a.itemSize === 3));

// ===========================================================================
console.log("\n-- R10 firewall + invariants over the source --------------------");
// ===========================================================================
check("§5.3 — no `.visible =` anywhere in the module",
  !/\.\s*visible\s*=/.test(ROCK_CODE));
check("§5.4 — no customProgramCacheKey, no per-instance key",
  !/customProgramCacheKey/.test(ROCK_CODE));
check("§5.7 — castShadow is forced false on BOTH meshes",
  countOf(ROCK_CODE, "castShadow = false") === 2);
check("no wire / physics / collision writes (the read-write firewall §5.1)",
  !/wasmExports\s*\.\s*(enqueue|send)/.test(ROCK_CODE)
  && !/Collision/.test(ROCK_CODE)
  && !/\.\s*(setPosition|moveTo|teleport)\s*\(/.test(ROCK_CODE));
check("no argless Date.now() clock (the shared clock is the only clock)",
  !/Date\s*\.\s*now\s*\(\s*\)/.test(ROCK_CODE));
check("the module imports NO three (injected only)",
  !/^\s*import[^\n]*["']three["']/m.test(ROCK_SRC));
check("the module derives FAM_ROCK from terrain_families.js",
  ROCK_SRC.includes('from "./terrain_families.js"') && ROCK_SRC.includes("FAM_ROCK"));

// ===========================================================================
console.log("\n-- R11 flags: three strict ship-OFF opt-ins ---------------------");
// ===========================================================================
clearUrl();
check("no window at all: every rock flag reads false",
  terrainRockEnabled() === false && terrainRockPebblesEnabled() === false
  && terrainRockGritEnabled() === false);
setUrl("");
check("no flags at quality=high: the master is OFF (ship-OFF, §5.9)",
  terrainRockEnabled() === false);
setUrl("?terrainRock=on");
check("?terrainRock=on lights the master", terrainRockEnabled() === true);
check("...and the tier's non-zero counts light both effects",
  terrainRockPebblesEnabled() === true && terrainRockGritEnabled() === true);
check("...with the high-tier numbers", terrainRockPebbleCount() === 9000
  && terrainRockGritCount() === 400 && terrainRockRadiusM() === 56);
setUrl("?terrainRock=on", PRESETS.low);
check("at quality=low the tier's zero counts leave both effects off",
  terrainRockEnabled() === true && terrainRockPebblesEnabled() === false
  && terrainRockGritEnabled() === false);
setUrl("?terrainRock=on&terrainRockGrit=off");
check("?terrainRockGrit=off bisects one effect out",
  terrainRockPebblesEnabled() === true && terrainRockGritEnabled() === false);
setUrl("?terrainRock=1");
check("a NON-'on' value does NOT enable (strict exact-match, plan §2.4)",
  terrainRockEnabled() === false);
setUrl("?terrainRock=off");
check("?terrainRock=off is honoured", terrainRockEnabled() === false);
setUrl("?terrainRockDensity=0.5");
check("?terrainRockDensity parses and clamps", terrainRockDensity() === 0.5);
setUrl("?terrainRockDensity=9");
check("an OUT-OF-RANGE density falls back to the default (never a silent clamp)",
  terrainRockDensity() === 1);
setUrl("");
check("terrainRockDensity defaults to 1.0", terrainRockDensity() === 1);
setUrl("?terrainRockPebbleCount=250&terrainRockRadius=30");
check("the numeric URL overrides win over the tier",
  terrainRockPebbleCount() === 250 && terrainRockRadiusM() === 30);
check("...but a count alone cannot turn the family on",
  terrainRockEnabled() === false);
// The router rows.
setUrl("?terrainRock=on");
check("VFX_EFFECT_FLAGS carries the three rock rows",
  ["terrain.rock", "terrain.rockPebbles", "terrain.rockGrit"]
    .every((id) => typeof VFX_EFFECT_FLAGS[id] === "function"));
check("the effect rows COMPOSE the family master",
  vfxEffectEnabled("terrain.rockPebbles") === true);
setUrl("?terrainRock=off&terrainRockPebbles=on");
check("master off ⇒ the composed row is off even with the sub-flag on",
  vfxEffectEnabled("terrain.rockPebbles") === false);
setUrl("?visual=off&terrainRock=on&terrainRockPebbles=on");
check("?visual=off kills the family (the firewall composition rule)",
  vfxEffectEnabled("terrain.rockPebbles") === false);
clearUrl();
check("no flags: the rock rows are OFF, so the DEFAULT-ON count stays 14",
  ["terrain.rock", "terrain.rockPebbles", "terrain.rockGrit"]
    .every((id) => vfxEffectEnabled(id) === false)
  && Object.keys(VFX_EFFECT_FLAGS).filter((id) => !id.startsWith("terrain.")).length === 14);
check("every rock row is under the `terrain.` ship-OFF prefix",
  ["terrain.rock", "terrain.rockPebbles", "terrain.rockGrit"]
    .every((id) => id.startsWith("terrain.")));
for (const f of ["terrainRock", "terrainRockPebbles", "terrainRockGrit",
  "terrainRockPebbleCount", "terrainRockGritCount", "terrainRockRadius",
  "terrainRockDensity"]) {
  check(`docs/url-flags.md has a row for ${f}`, FLAGS_DOC.includes("| `" + f + "` |"));
}
for (const k of ROCK_KEYS) {
  check(`docs/quality-presets.md documents ${k}`, PRESET_DOC.includes("`" + k + "`"));
}
check("every rock reader is exported from vfx_flags.js",
  ["terrainRockEnabled", "terrainRockPebblesEnabled", "terrainRockGritEnabled",
    "terrainRockPebbleCount", "terrainRockGritCount", "terrainRockRadiusM",
    "terrainRockDensity"].every((fn) => FLAGS.includes(`export function ${fn}(`)));
check("_resetVfxFlags clears the rock memos",
  FLAGS.includes("_terrainRock = _terrainRockPebbles = _terrainRockGrit = undefined;"));

// ===========================================================================
console.log("\n-- R12 bare default is byte-identical ---------------------------");
// ===========================================================================
clearUrl();
_resetTerrainVfx();
_resetTerrainRock();
{
  const facade = { terrainGroup: { parent: null } };
  check("no flags: initTerrainRock returns null", initTerrainRock({ scene3d: facade }) === null);
  check("no flags: terrainRockStats reports the family off and uninited",
    terrainRockStats().enabled === false && terrainRockStats().inited === false);
}
check("?wireframe=1 is a hard no-op (plan §8 risk 8)",
  initTerrainRock({ scene3d: {}, search: "?wireframe=1&terrainRock=on" }) === null);
_resetTerrainRock();
check("index.js imports initTerrainRock",
  INDEX.includes('import { initTerrainRock } from "./terrain_rock.js";'));
check("index.js registers ROCK after SWAMP (the wave order)",
  INDEX.indexOf("initTerrainSwamp({") < INDEX.indexOf("initTerrainRock({"));
check("index.js injects THREE, the facade, worldRoot and VFX_GLOBALS",
  /initTerrainRock\(\{[\s\S]{0,260}parent: worldRoot,[\s\S]{0,80}globals: VFX_GLOBALS,/.test(INDEX));
check("index.js mirrors the surface onto window.__terrainRock",
  INDEX.includes("window.__terrainRock = rockSurface"));
check("index.js catches an init throw", INDEX.includes("[terrainRock] initTerrainRock threw"));

// ===========================================================================
console.log("\n-- R13 the live family, headless and with THREE ------------------");
// ===========================================================================
{
  _resetTerrainVfx();
  _resetTerrainRock();
  setUrl("?terrainRock=on&terrainRockDensity=0.5", PRESETS.mid);
  const facade = {
    terrainGroup: { parent: null },
    frameTime: { tsSec: 100, dt: 0.016 },
    cameraSwitcher: { _safePlayerPos: () => ({ x: 500, y: 500, z: 10 }) },
    quality: { flags: PRESETS.mid },
    skyLightingController: {
      _lastState: {
        dirHeading: 120, dirPitch: 35, dirBright: 0.9,
        dirColorArgb: 0xfff0e0c0, ambColorArgb: 0xff607080, ambBright: 0.35,
      },
    },
  };
  const oracle = fakeOracle(() => 13);      // SedimentaryRock everywhere
  const globals = { uTime: { value: 42 }, uWindDir: { value: { x: 1, y: 0 } } };
  const { initTerrainVfx, terrainVfxStats, terrainVfxTick } = await import("./scene3d/terrain_vfx.js");
  initTerrainVfx({ scene3d: facade });
  const surface = initTerrainRock({
    scene3d: facade, globals, getOracle: () => oracle,
  });
  check("the family inits and returns its diagnostic surface", !!surface);
  const ids = terrainVfxStats().providers.map((p) => p.id).sort();
  check("both providers registered with the spine",
    ids.includes(PEBBLE_PROVIDER_ID) && ids.includes(GRIT_PROVIDER_ID), ids.join());
  check("both providers are CAMERA-scoped (immune to evict/park/rebake)",
    terrainVfxStats().providers.filter((p) => p.id.startsWith("terrain.rock"))
      .every((p) => p.scope === "camera"));
  terrainVfxTick(0.016, facade);
  const st = surface.stats();
  check("the density knob reached the module", st.density === 0.5);
  check("the pebble pool is the MID tier count at half density (rounded up square)",
    st.pebbleField.pool.count === instanceCountFor(Math.round(3000 * 0.5)),
    String(st.pebbleField.pool.count));
  check("the grit pool is the MID tier count at half density",
    st.gritField.pool.count === instanceCountFor(Math.round(160 * 0.5)),
    String(st.gritField.pool.count));
  check("both fields use the tier RADIUS (mid = 40 m)",
    st.pebbleField.pool.radiusM === 40 && st.gritField.pool.radiusM === 40);
  check("pebbles actually landed on the rock", st.visiblePebbles > 0, String(st.visiblePebbles));
  check("grit actually landed on the rock", st.visibleGrit > 0, String(st.visibleGrit));
  check("the pebble field resolved the AC sun from the facade snapshot",
    st.pebbleField.sunResolved === true && st.pebbleField.lightTicks === 1);
  check("stats expose the derived code sets for the live check",
    st.rockCodes.join() === "0,13,14,30" && st.olthoiCodes.join() === "30");
  check("the pool allocated its buffers EXACTLY once (one per schema entry)",
    st.pebbleField.pool.allocations === ROCK_PEBBLE_SCHEMA.length);
  // A second tick must not reallocate or rebuild.
  terrainVfxTick(0.016, facade);
  check("a second tick rebuilds nothing",
    surface.stats().counters.pebbleBuilds === 1 && surface.stats().counters.gritBuilds === 1);
  _resetTerrainRock();
  _resetTerrainVfx();
  clearUrl();
}
{
  // The `?nullRender=1` / node path: no THREE at all.
  const f = createPebbleField({ oracle: fakeOracle(() => 0), count: 100, radiusM: 16 });
  f.update(0.016, 0, 100, 100, 10, null);
  check("headless (no THREE): the pebble field runs its full CPU bookkeeping",
    f.mesh === null && f.pool.stats().live > 0);
  check("headless: it owns its own clock (no VFX_GLOBALS injected)", f.ownsClock === true);
  f.dispose();
  const g = createGritField({ oracle: fakeOracle(() => 0), count: 100, radiusM: 16 });
  g.update(0.016, 0, 100, 100, 10);
  check("headless (no THREE): the grit field runs too",
    g.mesh === null && g.pool.stats().live > 0);
  g.dispose();
}
{
  // With real THREE: the meshes, the shadow rule and the clock binding.
  const globals = { uTime: { value: 7 }, uWindDir: { value: { x: 1, y: 0 } } };
  const parent = new THREE.Object3D();
  const f = createPebbleField({
    THREE, parent, globals, oracle: fakeOracle(() => 0), count: 64, radiusM: 16,
  });
  check("THREE: the pebble field built an InstancedMesh", !!f.mesh && f.mesh.isInstancedMesh);
  check("THREE: castShadow === false (§5.7 — added geometry is paid twice)",
    f.mesh.castShadow === false && f.mesh.receiveShadow === false);
  check("THREE: the mesh is NOT frustum-culled (the window follows the player)",
    f.mesh.frustumCulled === false);
  check("THREE: the material is OPAQUE (no transparent pass, no sorting)",
    f.material.transparent === false && f.material.depthWrite === true);
  check("THREE: the clock is bound BY IDENTITY to VFX_GLOBALS.uTime (§5.6)",
    f.material.uniforms.uTime === globals.uTime && f.ownsClock === false);
  check("THREE: the pool published its LIVE centre into the material's bag",
    f.material.uniforms.uScatterCenter === f.pool.uniforms.uScatterCenter);
  check("THREE: the geometry is the faceted octahedron (8 tris, non-indexed)",
    f.geometry.getAttribute("position").count === 24 && f.geometry.index === null
    && f.geometry.getAttribute("normal").count === 24);
  check("THREE: every schema attribute reached the geometry as an instanced attribute",
    ROCK_PEBBLE_SCHEMA.every((a) => {
      const at = f.geometry.getAttribute(a.name);
      return at && at.isInstancedBufferAttribute && at.itemSize === a.itemSize;
    }));
  check("THREE: the mesh was added to the injected parent", parent.children.includes(f.mesh));
  f.update(0.016, 9, 400, 400, 10, {
    dirHeading: 10, dirPitch: 20, dirBright: 0.5,
    dirColorArgb: 0xffffffff, ambColorArgb: 0xffffffff, ambBright: 0.3,
  });
  check("THREE: the adopted clock is NOT overwritten by the field",
    globals.uTime.value === 7);
  check("THREE: the sun uniform was pushed as a Vector3",
    approx(Math.hypot(f.material.uniforms.uSunDir.value.x,
      f.material.uniforms.uSunDir.value.y,
      f.material.uniforms.uSunDir.value.z), 1, 1e-6));
  f.dispose();
  check("THREE: dispose() detaches the mesh", parent.children.length === 0);

  const g = createGritField({
    THREE, parent, globals, oracle: fakeOracle(() => 0), count: 64, radiusM: 16,
  });
  check("THREE: the grit mesh is additive, depth-write off, castShadow false",
    g.material.blending === THREE.AdditiveBlending && g.material.depthWrite === false
    && g.mesh.castShadow === false);
  check("THREE: the grit advection twin agrees with its own uniforms",
    (() => {
      const a = g.advectionOf(0.25, 5, 1);
      const b = gritAdvect(1, 0, 5, 0.25, g.uniforms.uSpanM.value, g.uniforms.uSpeed.value);
      return approx(a.x, b.x, 1e-9) && approx(a.y, b.y, 1e-9);
    })());
  g.dispose();
}

// ===========================================================================
console.log(`\nterrain rock: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
