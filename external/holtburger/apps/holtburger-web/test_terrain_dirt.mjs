// test_terrain_dirt.mjs — the DIRT/MUD family (Wave 3B, plan §3.7 items 1-4):
// footfall dust puffs, mud prints + wetness through the shared trail map, and
// the dry dust haze.
//
// Zero dependencies, zero GPU, zero browser. The behavioural assertions drive
// the real module headless (no THREE — the ring buffer, the scatter pool and
// every provider are first-class in that mode); the terrain FRAGMENT shader has
// its own suite, `test_terrain_dirt_shader.mjs`.
//
// Locks (the plan §3.7 test spec, plus the invariants):
//   D1  FAMILY MEMBERSHIP is DERIVED from `terrain_families.js` (codes
//       {5,7,8,24,31}), never hardcoded, and clay is a strict subset of it.
//   D2  PUFF COLOUR FOLLOWS THE SAMPLED CODE — the plan's first test line.
//   D3  NO PUFF ON A WATER OR ICE CODE (nor on grass / rock / swamp) — the
//       plan's second test line — and none on soaked ground.
//   D4  PRINT RECOVERY IS MONOTONIC — the plan's third test line — and the
//       rain-dependent persistence rides stamp AMPLITUDE, not a second fade.
//   D5  WETNESS TRACKS `VFX_GLOBALS.uWetness` WITH THE DOCUMENTED LAG — the
//       plan's fourth test line: the documented lag is `weather_inputs.js`'s
//       `WET_TAU`, and this module adds NONE of its own.
//   D6  NO LIGHT ADDED — the plan's fifth test line — and no `.visible=`, no
//       `Math.random`, no program-cache-key variance (§5.2/§5.3/§5.4/§5.5).
//   D7  THE FOOTFALL TRIGGER IS THE EXISTING FOOTSTEP-AUDIO HOOK: the
//       `Sound.Footstep1/2` (0x37/0x38) SoundTable hook in `entities.js`, wired
//       through a facade property this module owns, notified before the audio
//       guards, and installed on all three facades.
//   D8  PUFF DYNAMICS are a pure function of (wind, age, life) and the GLSL
//       computes the same expression the JS twin does.
//   D9  THE TRAIL MAP IS SHARED, NEVER FORKED: no second render target, no
//       second sampler; an ABSENT map drives the gate to 0 with NO lazy-ensure;
//       the push reaches every terrain material (including the batched one) and
//       skips pre-Wave-3B ones.
//   D10 THE DUST HAZE is DesolateLands-biased, wetness/temperature-gated, and
//       placed only on FAM_DIRT through the shared scatter pool.
//   D11 FLAGS + TIERS: five strict ship-OFF opt-ins, keys on all four tiers in
//       the plan's shape, in the right coercion sets, and the DEFAULT-ON effect
//       count is still the suite's own (16 since the 2026-10-10 per-weapon rows).
//   D12 BARE DEFAULT IS BYTE-IDENTICAL: `initTerrainDirt` registers nothing,
//       allocates nothing and installs no facade property with the flag absent.
//   D15 THE 2026-10-23 "MAKE IT READ" PASS: the haze is an UPRIGHT lit sheet
//       (never a flat card), its alpha never carries the frozen scatter-time
//       fade, its drift is INTEGRATED (no clock x live-wind racing) with gust
//       banks moving DOWNWIND and a life envelope over a seamless wrap; puffs
//       are a lit BURST; dry prints read; live `tune()` reaches every field.
//   D16 THE 2026-10-24 REVIEW: the haze foot ramp is measured from the GROUND
//       (the fragment stage's own profile line is EVALUATED: zero alpha where
//       a sheet meets flat ground, for every height in the jitter; the sheet
//       is sheared along the ground plane), the opacity re-calibration keeps
//       the 2026-10-23 grazing veil, and no sheet veils the player: the worst
//       veil on the camera -> avatar sightline stays <= 0.06 of a sheet's alpha
//       at 3 / 5.7 / 12 m chase for every width (the camera-only window it
//       replaces scores ~0.6 at the default chase and 1.0 at 12 m).
//
// Run from apps/holtburger-web/:  node test_terrain_dirt.mjs

import { readFileSync } from "node:fs";
import {
  DIRT_TUNING,
  DIRT_VARIANTS,
  DIRT_PUFF_VERTEX_GLSL,
  DIRT_PUFF_FRAGMENT_GLSL,
  DIRT_HAZE_VERTEX_GLSL,
  DIRT_HAZE_FRAGMENT_GLSL,
  DIRT_HAZE_SCHEMA,
  DIRT_PUFF_SCHEMA,
  HAZE_SPEED_STEPS,
  FOOTSTEP_SOUND_ENUMS,
  FOOTFALL_PROVIDER_ID,
  MUD_PRINT_PROVIDER_ID,
  DUST_HAZE_PROVIDER_ID,
  MUD_RECOMMENDED_FADE_SEC,
  MUD_SHORT_FADE_WARN_SEC,
  MUD_LONG_FADE_NOTE_SEC,
  dirtTerrainCodes,
  dirtCodeBitmask,
  clayTerrainCodes,
  clayCodeBitmask,
  resolveDirtQuality,
  mudWetnessFrom,
  mudStampFor,
  puffForGround,
  dustHazeIntensity,
  puffState,
  windAcFromGlobals,
  createPuffField,
  createDustHazeField,
  createDustLight,
  copyTerrainLight,
  dustLitFactor,
  hazeAdvect,
  hazeSpeedMul,
  hazeTravelWrapM,
  tuneTerrainDirt,
  pushMudTrailUniforms,
  installFootfallHook,
  initTerrainDirt,
  terrainFootfall,
  terrainDirtStats,
  _resetTerrainDirt,
} from "./scene3d/terrain_dirt.js";
// 2026-10-24 exports read through the namespace, so a module without them
// reports a FAIL line (D16) instead of throwing at import.
import * as DIRT_NS from "./scene3d/terrain_dirt.js";
import {
  FAM_DIRT, FAM_WATER, FAM_SNOWICE, FAM_GRASS, FAM_ROCK,
  familyForCode, TERRAIN_CODE_COUNT,
} from "./scene3d/terrain_families.js";
import { createTrailMap, fadeAmountFor } from "./scene3d/trail_map.js";
import { _resetTerrainVfx } from "./scene3d/terrain_vfx.js";
import { VFX_EFFECT_FLAGS, _resetVfxFlags } from "./scene3d/vfx_flags.js";
import { _resetVfxCatalog } from "./scene3d/vfx_catalog.js";
import { PRESETS, PRESET_NAMES } from "./scene3d/quality.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

const DIRT_SRC = readFileSync("./scene3d/terrain_dirt.js", "utf8");
const ENTITIES = readFileSync("./scene3d/entities.js", "utf8");
const INDEX = readFileSync("./scene3d/index.js", "utf8");
const QUALITY = readFileSync("./scene3d/quality.js", "utf8");
const FLAGS = readFileSync("./scene3d/vfx_flags.js", "utf8");
const FLAGS_DOC = readFileSync("./docs/url-flags.md", "utf8");
// Comment-stripped module source. The header EXPLAINS itself in prose ("no
// second render target", "never Math.random"), so a naive substring test over
// the raw text finds the very words it is trying to prove absent.
const stripComments = (s) => s.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
const DIRT_CODE = stripComments(DIRT_SRC.replace(/\/\*[\s\S]*?\*\//g, ""));
const countOf = (hay, needle) => hay.split(needle).length - 1;

function setUrl(search) { globalThis.window = { location: { search } }; _resetVfxCatalog(); _resetVfxFlags(); }
function clearUrl() { delete globalThis.window; _resetVfxCatalog(); _resetVfxFlags(); }

/** A minimal oracle: a code map keyed by (x, y), flat ground at z=10. The
 *  `family` field is what `terrain_scatter.js` gates on, so it is derived here
 *  exactly as the real oracle derives it. */
function fakeOracle(codeAt, height = 10) {
  return {
    sample(x, y) {
      const code = codeAt(x, y);
      if (code === null || code === undefined) return null;
      return { code, family: familyForCode(code), height, hasHeight: true, nx: 0, ny: 0, nz: 1 };
    },
  };
}
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// ===========================================================================
console.log("\n-- D1 family membership is DERIVED, clay is a subset ------------");
// ===========================================================================
const CODES = dirtTerrainCodes();
check("dirtTerrainCodes() === FAM_DIRT codes {5,7,8,24,31}",
  CODES.join() === "5,7,8,24,31", CODES.join());
check("every dirt code really is FAM_DIRT per the family LUT",
  CODES.every((c) => familyForCode(c) === FAM_DIRT));
check("no NON-dirt code leaks into the set",
  Array.from({ length: TERRAIN_CODE_COUNT }, (_, c) => c)
    .filter((c) => familyForCode(c) === FAM_DIRT).join() === CODES.join());
check("the module hardcodes no code list (it walks familyForCode)",
  DIRT_CODE.includes("familyForCode(c) === FAM_DIRT")
  && !/\[\s*5\s*,\s*7\s*,\s*8\s*,\s*24\s*,\s*31\s*\]/.test(DIRT_CODE));
check("dirtCodeBitmask() has exactly the five bits",
  dirtCodeBitmask() === ((1 << 5) | (1 << 7) | (1 << 8) | (1 << 24) | (1 << 31)) >>> 0,
  "0x" + dirtCodeBitmask().toString(16));
check("clayTerrainCodes() is [24] (Argila alone)", clayTerrainCodes().join() === "24");
check("clay is a STRICT SUBSET of the dirt mask",
  (clayCodeBitmask() & dirtCodeBitmask()) === clayCodeBitmask()
  && clayCodeBitmask() !== dirtCodeBitmask());
check("DIRT_VARIANTS has a row for every family code and no extras",
  CODES.every((c) => !!DIRT_VARIANTS[c])
  && Object.keys(DIRT_VARIANTS).map(Number).join() === CODES.join());
check("DIRT_VARIANTS is frozen (and its rows are)",
  Object.isFrozen(DIRT_VARIANTS) && CODES.every((c) => Object.isFrozen(DIRT_VARIANTS[c])));

// ===========================================================================
console.log("\n-- D2 puff colour FOLLOWS THE SAMPLED CODE ----------------------");
// ===========================================================================
for (const c of CODES) {
  const p = puffForGround({ code: c }, 0);
  check(`code ${c}: puff kept, colour === DIRT_VARIANTS[${c}].puff`,
    p.keep === true && p.colour.join() === DIRT_VARIANTS[c].puff.join(), JSON.stringify(p));
}
const pPacked = puffForGround({ code: 7 }, 0);      // PackedDirt — the dusty one
const pMud = puffForGround({ code: 5 }, 0);         // MudRichDirt — the damp one
check("two different dirt codes give two DIFFERENT colours",
  pPacked.colour.join() !== pMud.colour.join());
check("PackedDirt throws more dust than MudRichDirt", pPacked.dust > pMud.dust);
check("DesolateLands is at the dry end (dust === 1)", puffForGround({ code: 31 }, 0).dust === 1);
check("the puff carries the code it was sampled from", puffForGround({ code: 24 }, 0).code === 24);

// ===========================================================================
console.log("\n-- D3 NO puff on water / ice / any non-dirt family --------------");
// ===========================================================================
for (let c = 0; c < TERRAIN_CODE_COUNT; c += 1) {
  if (familyForCode(c) === FAM_DIRT) continue;
  const p = puffForGround({ code: c }, 0);
  if (p.keep) check(`code ${c} (${familyForCode(c)}) must NOT puff`, false, JSON.stringify(p));
}
check("no non-dirt code puffs (all 27 of them)",
  Array.from({ length: TERRAIN_CODE_COUNT }, (_, c) => c)
    .filter((c) => familyForCode(c) !== FAM_DIRT)
    .every((c) => puffForGround({ code: c }, 0).keep === false));
const WATER_CODE = Array.from({ length: 32 }, (_, c) => c).find((c) => familyForCode(c) === FAM_WATER);
const ICE_CODE = Array.from({ length: 32 }, (_, c) => c).find((c) => familyForCode(c) === FAM_SNOWICE);
const GRASS_CODE = Array.from({ length: 32 }, (_, c) => c).find((c) => familyForCode(c) === FAM_GRASS);
const ROCK_CODE = Array.from({ length: 32 }, (_, c) => c).find((c) => familyForCode(c) === FAM_ROCK);
check(`water code ${WATER_CODE} does not puff`, puffForGround({ code: WATER_CODE }, 0).keep === false);
check(`ice code ${ICE_CODE} does not puff`, puffForGround({ code: ICE_CODE }, 0).keep === false);
check(`grass code ${GRASS_CODE} does not puff`, puffForGround({ code: GRASS_CODE }, 0).keep === false);
check(`rock code ${ROCK_CODE} does not puff`, puffForGround({ code: ROCK_CODE }, 0).keep === false);
check("a null sample does not puff", puffForGround(null, 0).keep === false);
check("a sample with no code does not puff", puffForGround({}, 0).keep === false);
// Rain lays the dust — monotone down to a hard cutoff.
const wetSeries = [0, 0.1, 0.2, 0.3, 0.4, 0.5].map((w) => puffForGround({ code: 7 }, w).dust);
check("dust decreases monotonically with wetness",
  wetSeries.every((v, i) => i === 0 || v <= wetSeries[i - 1] + 1e-9), wetSeries.join());
check("soaked ground (wetness >= cutoff) does not puff at all",
  puffForGround({ code: 7 }, DIRT_TUNING.puffWetCutoff).keep === false
  && puffForGround({ code: 7 }, 1).keep === false);

// ===========================================================================
console.log("\n-- D4 print recovery is MONOTONIC; rain rides AMPLITUDE ---------");
// ===========================================================================
// The map's recovery is `trail_map.js`'s and is linear in dt/recoverySec; this
// family neither forks it nor adds a second fade constant. Drive the real map
// headless (no renderer ⇒ CPU bookkeeping only) and walk the fade.
const map = createTrailMap({ recoverySec: MUD_RECOMMENDED_FADE_SEC });
let prevFade = null;
let monotonic = true;
let level = 1;
const levels = [];
for (let i = 0; i < 20; i += 1) {
  map.update(0.5, 0, 0);
  const f = map.stats().lastFade;
  level = Math.max(0, level - f);
  levels.push(level);
  if (prevFade !== null && Math.abs(f - prevFade) > 1e-9) monotonic = false;
  prevFade = f;
}
check("the shared fade is constant per dt (linear recovery)", monotonic, String(prevFade));
check("a stamp level decays MONOTONICALLY to zero",
  levels.every((v, i) => i === 0 || v <= levels[i - 1] + 1e-12) && levels[levels.length - 1] < 1);
check(`fadeAmountFor at the mud fade is dt/${MUD_RECOMMENDED_FADE_SEC}`,
  Math.abs(fadeAmountFor(1, MUD_RECOMMENDED_FADE_SEC) - 1 / MUD_RECOMMENDED_FADE_SEC) < 1e-12);
check("recovery is frame-rate independent (2x dt = 2x fade)",
  Math.abs(fadeAmountFor(2, 30) - 2 * fadeAmountFor(1, 30)) < 1e-12);
// The rain dependence: amplitude, not fade.
const dryStamp = mudStampFor(0);
const wetStamp = mudStampFor(1);
check("a WET stamp is stronger than a DRY one (the rain-persistence knob)",
  wetStamp.strength > dryStamp.strength, JSON.stringify([dryStamp, wetStamp]));
check("a WET stamp is also wider (mud spreads)", wetStamp.radiusM > dryStamp.radiusM);
check("stamp strength is monotone in wetness",
  [0, 0.25, 0.5, 0.75, 1].map((w) => mudStampFor(w).strength)
    .every((v, i, a) => i === 0 || v >= a[i - 1]));
check("stamp strength is clamped to 1 even with the deepest code multiplier",
  mudStampFor(1, DIRT_VARIANTS[5].print).strength <= 1);
check("soft ground (MudRichDirt) takes a deeper print than packed ground",
  mudStampFor(0.5, DIRT_VARIANTS[5].print).strength
  > mudStampFor(0.5, DIRT_VARIANTS[7].print).strength);
check("mud asks for a ~30 s recovery (plan §3.7 item 2)", MUD_RECOMMENDED_FADE_SEC === 30);
check("the warn thresholds bracket it", MUD_SHORT_FADE_WARN_SEC < MUD_RECOMMENDED_FADE_SEC
  && MUD_LONG_FADE_NOTE_SEC > MUD_RECOMMENDED_FADE_SEC);
map.dispose();

// ===========================================================================
console.log("\n-- D5 wetness tracks VFX_GLOBALS.uWetness, no lag of our own ----");
// ===========================================================================
check("mudWetnessFrom prefers the shared uniform",
  mudWetnessFrom({ uWetness: { value: 0.7 } }, { wetness: 0.1 }) === 0.7);
check("mudWetnessFrom falls back to the env snapshot",
  mudWetnessFrom(null, { wetness: 0.42 }) === 0.42);
check("mudWetnessFrom with nothing is 0 (dry, fail-soft)", mudWetnessFrom(null, null) === 0);
check("mudWetnessFrom clamps to 0..1",
  mudWetnessFrom({ uWetness: { value: 5 } }, null) === 1
  && mudWetnessFrom({ uWetness: { value: -3 } }, null) === 0);
check("it is a PURE COPY — no smoothing state, no tau, no ema in this module",
  !/\bTAU\b|_ema|lerpWet|smoothWet/.test(DIRT_CODE));
check("a step in uWetness appears IMMEDIATELY (the lag is weather_inputs.js's)",
  (() => {
    const g = { uWetness: { value: 0 } };
    const a = mudWetnessFrom(g, null);
    g.uWetness.value = 1;
    return a === 0 && mudWetnessFrom(g, null) === 1;
  })());
check("the module documents WHOSE lag it is (WET_TAU / weather_inputs)",
  DIRT_SRC.includes("WET_TAU") && DIRT_SRC.includes("weather_inputs"));
check("it never imports weather/rain.js (plan §3.7 item 4)",
  !/from\s+["'][^"']*weather\/rain/.test(DIRT_SRC));
// The push copies it verbatim onto the materials.
const wetMat = { uniforms: { uMudTrailEnabled: { value: 0 }, uMudWetness: { value: 0 } } };
pushMudTrailUniforms([wetMat], null, 0.63);
check("the per-frame push copies the wetness verbatim", wetMat.uniforms.uMudWetness.value === 0.63);
pushMudTrailUniforms([wetMat], null, 2);
check("the push clamps a bad wetness", wetMat.uniforms.uMudWetness.value === 1);

// ===========================================================================
console.log("\n-- D6 no light, no .visible=, no Math.random, no cache key ------");
// ===========================================================================
check("NO light is constructed anywhere (§5.2)",
  !/new\s+THREE\.\w*Light\b/.test(DIRT_CODE) && !/PointLight|SpotLight|DirectionalLight/.test(DIRT_CODE));
check("no `.visible =` in the module source (§5.3)", !/\.visible\s*=/.test(DIRT_CODE));
check("no Math.random (§5.5 — determinism)", !/Math\.random\s*\(/.test(DIRT_CODE));
check("no argless Date.now()", !/Date\.now\s*\(\s*\)/.test(DIRT_CODE));
check("no customProgramCacheKey (§5.4)", !/customProgramCacheKey/.test(DIRT_CODE));
check("no performance.now() — the clock is frameTime.tsSec (plan §2.3)",
  !/performance\.now\s*\(/.test(DIRT_CODE));
check("castShadow = false on both meshes (§5.7)",
  countOf(DIRT_CODE, "castShadow = false") === 2);
check("determinism comes from the shared scatter hash",
  DIRT_CODE.includes("scatterHash01("));
check("no wire / physics / collision writes (the §5.1 firewall)",
  !/wasmExports\.(enqueue|send)/.test(DIRT_CODE)
  && !/\.setPosition\(|\.moveTo\(|\.teleport\(/.test(DIRT_CODE));
check("no backtick inside either GLSL string",
  !DIRT_PUFF_VERTEX_GLSL.includes("`") && !DIRT_PUFF_FRAGMENT_GLSL.includes("`")
  && !DIRT_HAZE_VERTEX_GLSL.includes("`") && !DIRT_HAZE_FRAGMENT_GLSL.includes("`"));

// ===========================================================================
console.log("\n-- D7 the footfall trigger IS the footstep-audio hook -----------");
// ===========================================================================
check("Sound.Footstep1/2 are 0x37/0x38 (ACE.Entity/Enum/Sound.cs)",
  FOOTSTEP_SOUND_ENUMS.length === 2
  && FOOTSTEP_SOUND_ENUMS[0] === 0x37 && FOOTSTEP_SOUND_ENUMS[1] === 0x38);
check("entities.js matches exactly those two enum values",
  ENTITIES.includes("if (soundEnum === 0x37 || soundEnum === 0x38)"));
check("entities.js calls scene3d.onTerrainFootfall",
  /onTerrainFootfall/.test(ENTITIES) && ENTITIES.includes("this.scene3d?.onTerrainFootfall"));
check("the notify passes the RAW AC position (no acToThree on this path)",
  /onFootfall\(inst\.guid >>> 0, pos\.x, pos\.y, pos\.z\)/.test(ENTITIES));
check("the notify runs BEFORE the SoundTable guards (a muted session still puffs)",
  ENTITIES.indexOf("if (soundEnum === 0x37 || soundEnum === 0x38)")
  < ENTITIES.indexOf("if (soundEnum === 0 || !cache || !audioMgr) return;"));
check("the notify is try/wrapped so it can never break audio",
  /try \{ onFootfall\([^)]*\); \} catch/.test(ENTITIES));
check("terrain_dirt.js is the ONLY definer of onTerrainFootfall",
  DIRT_CODE.includes("onTerrainFootfall = fn"));
check("the module re-derives NO velocity contact (plan §3.7 item 1)",
  !/velocity|_emaSpeed|groundSpeed/i.test(DIRT_CODE));
// The three-facade install (`terrain_batch.js:548 _installHooksOn` discipline).
{
  const lruFacade = {};
  const facade = { landblockLru: { scene3d: lruFacade } };
  const live = {};
  globalThis.window = { location: { search: "" }, liveScene3d: live };
  const n = installFootfallHook(facade, terrainFootfall);
  check("installFootfallHook touches all THREE facades", n === 3, String(n));
  check("scene3d facade got the property", facade.onTerrainFootfall === terrainFootfall);
  check("landblockLru.scene3d facade got it", lruFacade.onTerrainFootfall === terrainFootfall);
  check("window.liveScene3d got it", live.onTerrainFootfall === terrainFootfall);
  const again = installFootfallHook(facade, terrainFootfall);
  check("re-installing is idempotent", again === 3 && facade.onTerrainFootfall === terrainFootfall);
  delete globalThis.window;
}

// ===========================================================================
console.log("\n-- D8 puff dynamics are pure; the GLSL is the same expression ---");
// ===========================================================================
{
  const a = puffState(1, 0, 0.4, 1);
  const b = puffState(1, 0, 0.4, 1);
  check("puffState is deterministic", JSON.stringify(a) === JSON.stringify(b));
  check("radius GROWS with age",
    puffState(0, 0, 0.1, 1).r < puffState(0, 0, 0.5, 1).r);
  check("radius starts and ends at the tuned values",
    Math.abs(puffState(0, 0, 0, 1).r - DIRT_TUNING.puffRadiusStartM) < 1e-9
    && Math.abs(puffState(0, 0, 1, 1).r - DIRT_TUNING.puffRadiusEndM) < 1e-9);
  // z = rise * sqrt(n) + radiusLift * r — the lift keeps the growing disc's
  // rim at the soil; subtract it to see the rise curve itself.
  const riseOnly = (age) => { const st = puffState(0, 0, age, 1); return st.z - DIRT_TUNING.puffRadiusLift * st.r; };
  check("the puff RISES and decelerates (sqrt, not linear)",
    riseOnly(0.25) > 0.25 * DIRT_TUNING.puffRiseM
    && Math.abs(riseOnly(1) - DIRT_TUNING.puffRiseM) < 1e-9);
  check("the centre is lifted by puffRadiusLift x the live width (no ground clip)",
    Math.abs(puffState(0, 0, 1, 1).z - (DIRT_TUNING.puffRiseM + DIRT_TUNING.puffRadiusLift * DIRT_TUNING.puffRadiusEndM)) < 1e-9);
  check("the puff DRIFTS downwind, proportional to age",
    Math.abs(puffState(2, 0, 0.5, 1).x - 2 * DIRT_TUNING.puffWindDrift * 0.5) < 1e-9
    && puffState(0, -3, 0.5, 1).y < 0);
  check("alpha fades IN then OUT (a puff appears, then dissipates)",
    puffState(0, 0, 0.001, 1).a < puffState(0, 0, 0.12, 1).a
    && puffState(0, 0, 0.12, 1).a > puffState(0, 0, 0.9, 1).a);
  check("a dead or unborn puff is exactly zero",
    puffState(0, 0, 1.5, 1).a === 0 && puffState(0, 0, 1.5, 1).r === 0
    && puffState(0, 0, -1, 1).a === 0);
  // The GLSL twin.
  const V = DIRT_PUFF_VERTEX_GLSL;
  check("GLSL: age = uTime - birth", V.includes("float age = uTime - aPuff.w;"));
  check("GLSL: radius is the same mix(start, end, n)",
    V.includes("mix(uRadiusStart, uRadiusEnd, clamp(n, 0.0, 1.0))"));
  check("GLSL: rise is the same sqrt(n)", V.includes("uRiseM * sqrt(max(n, 0.0))"));
  check("GLSL: drift is the same wind * uDrift * age",
    V.includes("origin.xy += uWindAc * (uDrift * age);"));
  check("GLSL: the same 0.12 fade-in and squared fade-out",
    V.includes("clamp(n / 0.12, 0.0, 1.0)") && V.includes("(1.0 - clamp(n, 0.0, 1.0)) * (1.0 - clamp(n, 0.0, 1.0))"));
  check("GLSL: a dead slot collapses to ZERO AREA rather than branching",
    V.includes("float alive = step(0.0, age) * step(n, 1.0)") && V.includes("* alive"));
  check("GLSL: the quad is a VIEW-SPACE billboard (parent rotation-agnostic)",
    V.includes("vec4 mv = modelViewMatrix * vec4(origin, 1.0);") && V.includes("mv.xy += q * radius;"));
  check("GLSL: the per-puff spin is seeded, NOT clocked (determinism)",
    V.includes("float rot = aPuffCfg.z * 6.2831853;"));
  check("puff GLSL declares uTime exactly once", countOf(V, "uniform float uTime;") === 1);
  check("puff schema is the three instanced attributes",
    DIRT_PUFF_SCHEMA.map((a2) => a2.name).join() === "aPuff,aPuffCfg,aPuffColour");
}

// ===========================================================================
console.log("\n-- D8b the ring buffer, headless -------------------------------");
// ===========================================================================
{
  const globals = { uTime: { value: 0 }, uWindDir: { value: { x: 1, y: 0 } } };
  const field = createPuffField({ globals, capacity: 4, seed: 7 });
  check("no THREE ⇒ no mesh, but the field still works", field.mesh === null);
  check("the clock is ADOPTED by identity (§5.6)",
    field.uniforms.uTime === globals.uTime && field.ownsClock === false);
  check("emit writes a slot", field.emit(10, 20, 5, 1, [0.5, 0.4, 0.3], 1) === true);
  check("emit refuses a zero-dust puff", field.emit(10, 20, 5, 1, [0, 0, 0], 0) === false);
  check("the origin is lifted off the ground",
    Math.abs(field.buffers.aPuff[2] - (5 + DIRT_TUNING.puffLiftM)) < 1e-6);
  check("the colour reached the buffer",
    approx(field.buffers.aPuffColour[0], 0.5) && approx(field.buffers.aPuffColour[2], 0.3));
  field.update(0.016, 1.2);
  check("one live puff after emit", field.stats().live === 1);
  field.update(0.016, 99);
  check("the puff is dead well after its life", field.stats().live === 0);
  // Ring wrap: capacity 4, five emits ⇒ the oldest slot is recycled.
  for (let i = 0; i < 5; i += 1) field.emit(i, i, 0, 100, [1, 1, 1], 1);
  field.update(0.016, 100);
  check("the ring never exceeds its capacity", field.stats().live <= 4, String(field.stats().live));
  check("emitted counts every accepted emit", field.stats().emitted === 6, String(field.stats().emitted));
  // Determinism: the same event stream reproduces the same buffers.
  const f2 = createPuffField({ globals, capacity: 4, seed: 7 });
  const f3 = createPuffField({ globals, capacity: 4, seed: 7 });
  for (const f of [f2, f3]) {
    f.emit(10, 20, 5, 1, [0.5, 0.4, 0.3], 1);
    f.emit(11, 21, 5, 2, [0.5, 0.4, 0.3], 1);
  }
  check("the same event stream gives byte-identical buffers (§5.5)",
    f2.buffers.aPuffCfg.join() === f3.buffers.aPuffCfg.join()
    && f2.buffers.aPuff.join() === f3.buffers.aPuff.join());
  const f4 = createPuffField({ globals, capacity: 4, seed: 9 });
  f4.emit(10, 20, 5, 1, [0.5, 0.4, 0.3], 1);
  check("a different seed gives different jitter",
    f4.buffers.aPuffCfg[2] !== f2.buffers.aPuffCfg[2]);
  field.dispose(); f2.dispose(); f3.dispose(); f4.dispose();
}
check("windAcFromGlobals converts three (x,z) to AC (+X east, +Y north)",
  (() => { const o = windAcFromGlobals({ uWindDir: { value: { x: 0.6, y: 0.8 } } }, {});
    return Math.abs(o.x - 0.6) < 1e-9 && Math.abs(o.y + 0.8) < 1e-9; })());
check("windAcFromGlobals falls back to the 135-degree tree_wind default",
  (() => { const o = windAcFromGlobals(null, {}); return o.x < 0 && o.y > 0; })());

// ===========================================================================
console.log("\n-- D9 the trail map is SHARED, never forked ---------------------");
// ===========================================================================
check("the module NEVER constructs a trail map (no lazy-ensure)",
  !DIRT_CODE.includes("createTrailMap"));
check("the module imports no trail_map.js at all", !/from\s+["']\.\/trail_map\.js["']/.test(DIRT_SRC));
check("it reuses the WAVE-2A sampler rather than binding a second one",
  DIRT_CODE.includes("u.uSnowTrailMap") && !DIRT_CODE.includes("uMudTrailMap"));
check("its own gate is a FLOAT, not a sampler", DIRT_CODE.includes("u.uMudTrailEnabled.value = on"));
check("it never writes snow's gate (families stay independent)",
  !DIRT_CODE.includes("uSnowTrailEnabled"));
check("the header records the no-second-RT decision and defers to wave 2A",
  /NO second trail render target/i.test(DIRT_SRC) && DIRT_SRC.includes("terrain_snow.js"));
{
  // The push, driven with fakes: a wave-3B material, a pre-wave-3B one, and a
  // batched-style clone whose centre is a plain {x, y}.
  const modern = { uniforms: {
    uMudTrailEnabled: { value: 0 }, uMudWetness: { value: 0 },
    uSnowTrailMap: { value: null }, uSnowTrailCenter: { value: { x: 0, y: 0 } },
    uSnowTrailRadius: { value: 0 },
  } };
  const legacy = { uniforms: { uSnowTrailEnabled: { value: 0 } } };
  const fakeTrail = { uniforms: {
    uTrailMap: { value: { isTexture: true } },
    uTrailCenter: { value: { x: 12, y: -34 } },
    uTrailRadius: { value: 64 },
  } };
  const n = pushMudTrailUniforms([modern, legacy, null], fakeTrail, 0.5);
  check("the push touches only wave-3B materials", n === 1, String(n));
  check("the push binds the shared texture", modern.uniforms.uSnowTrailMap.value !== null);
  check("the push writes the centre componentwise (no .set() requirement)",
    modern.uniforms.uSnowTrailCenter.value.x === 12
    && modern.uniforms.uSnowTrailCenter.value.y === -34);
  check("the push writes the radius", modern.uniforms.uSnowTrailRadius.value === 64);
  check("the mud gate goes ON with a map bound", modern.uniforms.uMudTrailEnabled.value === 1);
  check("a pre-wave-3B material is untouched", legacy.uniforms.uSnowTrailEnabled.value === 0);
  // ABSENT MAP ⇒ gate off, wetness still pushed.
  pushMudTrailUniforms([modern], null, 0.8);
  check("an ABSENT map drives the gate to 0", modern.uniforms.uMudTrailEnabled.value === 0);
  check("an ABSENT map does NOT clear the wetness (the sheen is weather, not trail)",
    modern.uniforms.uMudWetness.value === 0.8);
  check("an ABSENT map leaves the shared sampler alone (snow may still own it)",
    modern.uniforms.uSnowTrailMap.value !== null);
  check("an empty material list is a no-op", pushMudTrailUniforms([], fakeTrail, 1) === 0
    && pushMudTrailUniforms(null, fakeTrail, 1) === 0);
}

// ===========================================================================
console.log("\n-- D10 the dry dust haze ---------------------------------------");
// ===========================================================================
check("DesolateLands (31) carries the HIGHEST haze weight (plan §3.7 item 3)",
  CODES.every((c) => DIRT_VARIANTS[c].haze <= DIRT_VARIANTS[31].haze)
  && DIRT_VARIANTS[31].haze === 1);
check("MudRichDirt carries the lowest (wet ground lifts no dust)",
  CODES.every((c) => DIRT_VARIANTS[c].haze >= DIRT_VARIANTS[5].haze));
check("dustHazeIntensity: dry + hot ⇒ full", dustHazeIntensity({ wetness: 0, temperatureC: 30 }) === 1);
check("dustHazeIntensity: rain kills it",
  dustHazeIntensity({ wetness: DIRT_TUNING.hazeWetKill, temperatureC: 30 }) === 0
  && dustHazeIntensity({ wetness: 1, temperatureC: 30 }) === 0);
check("dustHazeIntensity: cold air lifts none",
  dustHazeIntensity({ wetness: 0, temperatureC: DIRT_TUNING.hazeColdC }) === 0);
check("dustHazeIntensity is monotone in dryness",
  [1, 0.3, 0.2, 0.1, 0].map((w) => dustHazeIntensity({ wetness: w, temperatureC: 30 }))
    .every((v, i, a) => i === 0 || v >= a[i - 1]));
check("dustHazeIntensity with no env at all is a middling veil (fail-soft)",
  dustHazeIntensity(null) === 0.5);
{
  // A headless haze field over a chequerboard of dirt and water.
  const oracle = fakeOracle((x) => (Math.floor(x / 50) % 2 === 0 ? 31 : WATER_CODE));
  const field = createDustHazeField({ oracle, count: 64, radiusM: 40, seed: 3 });
  check("no THREE ⇒ no mesh, the pool still runs", field.mesh === null);
  field.update(0.016, 0, 0, 0, 10, 1);
  for (let i = 0; i < 20; i += 1) field.update(0.016, i * 0.016, 0, 0, 10, 1);
  const st = field.stats();
  check("the pool placed SOME quads", st.pool.live > 0, JSON.stringify(st.pool));
  check("the pool rejected the water half (family gating)",
    st.pool.live < st.pool.count, JSON.stringify(st.pool));
  check("the pool is FAM_DIRT-gated by construction",
    DIRT_CODE.includes("families: [FAM_DIRT]"));
  check("dryness reaches the shader uniform", field.uniforms.uDryness.value === 1);
  field.update(0.016, 1, 0, 0, 10, 0);
  check("a wet world drives dryness to 0", field.uniforms.uDryness.value === 0);
  check("the haze pool carries its own rand salt (decorrelated from grass/sand/snow)",
    DIRT_CODE.includes("randSalt: 0x3b"));
  check("the haze rides the SHARED scatter fade GLSL (one blend for every family)",
    DIRT_HAZE_VERTEX_GLSL.includes("hbScatterFade(placed.xy)"));
  check("haze schema: the streamer trio + the pool's ground normal + the per-code tint",
    DIRT_HAZE_SCHEMA.map((a) => a.name).join() === "aOffset,aScale,aDrift,aNormal,aTint");
  check("the haze is SLOWER than the sand streamer and the snow ribbon",
    DIRT_TUNING.hazeAdvectSpeed < 3.2 && DIRT_TUNING.hazeAdvectSpeed < 5.4);
  check("the haze is WIDER-banded than either", DIRT_TUNING.hazePulseFreq < 0.11);
  check("the haze is BROWN, not white",
    DIRT_TUNING.hazeColour[0] > DIRT_TUNING.hazeColour[2]);
  check("both dirt materials are ALPHA-blended, never additive (dust does not glow)",
    countOf(DIRT_CODE, "THREE.NormalBlending") === 2
    && !DIRT_CODE.includes("AdditiveBlending"));
  field.dispose();
}
{
  // 2026-10-23 — INDOORS (verifier finding: upright sheets rose through
  // building floors over dirt). The field honours an exclude; the provider
  // hands it the interior mask with a margin and fades the field indoors.
  const oracle = fakeOracle(() => 31);
  const base = createDustHazeField({ oracle, count: 64, radiusM: 40, seed: 3 });
  const banned = (x) => x > -12 && x < 12;            // a 24 m wide "building + margin"
  let calls = 0;
  const ex = createDustHazeField({ oracle, count: 64, radiusM: 40, seed: 3, exclude: (x) => { calls += 1; return banned(x); } });
  for (let i = 0; i < 20; i += 1) { base.update(0.016, i * 0.016, 0, 0, 10, 1); ex.update(0.016, i * 0.016, 0, 0, 10, 1); }
  const sb = base.stats().pool, se = ex.stats().pool;
  check("haze indoors: the field consults its exclude and places fewer sheets where it says no",
    calls > 0 && se.excludeRejects > 0 && se.live < sb.live, `${calls} ${JSON.stringify(se)} vs ${sb.live}`);
  check("haze indoors: the provider wires the CPU interior mask with a margin (anchor + 4 points)",
    DIRT_CODE.includes("createInteriorMask()") && DIRT_CODE.includes("mask.contains(x + M, y, z)")
    && DIRT_CODE.includes("mask.contains(x, y - M, z)") && DIRT_TUNING.hazeIndoorMarginM >= 4);
  check("haze indoors: a changed cell set re-places the sheets, and standing inside fades the field",
    DIRT_CODE.includes("mask.sync(frameCtx.scene3d || null)") && DIRT_CODE.includes("_dirt.haze.pool.invalidate()")
    && DIRT_CODE.includes("dustHazeIntensity(_dirt.env, _L) * _dirt.hazeIndoorFade") && DIRT_TUNING.hazeIndoorFadeSec > 0);
  base.dispose(); ex.dispose();
}

// ===========================================================================
console.log("\n-- D11 flags + tiers -------------------------------------------");
// ===========================================================================
const DIRT_FLAGS = ["terrainDirt", "terrainFootfall", "terrainMudPrints",
  "terrainMudWetness", "terrainDustHaze"];
const DIRT_ROWS = ["terrain.dirt", "terrain.footfall", "terrain.mudPrints",
  "terrain.mudWetness", "terrain.dirtDust"];
const ALL_IDS = Object.keys(VFX_EFFECT_FLAGS);
check("the five DIRT rows are in the VFX_EFFECT_FLAGS router",
  DIRT_ROWS.every((id) => typeof VFX_EFFECT_FLAGS[id] === "function"), ALL_IDS.join());
check("the DEFAULT-ON effect count is unchanged by the wave-3B rows (16 since the 2026-10-10 per-weapon rows)",
  ALL_IDS.filter((id) => !id.startsWith("terrain.")).length === 16);
clearUrl();
check("no flags: every DIRT row is OFF (ship-OFF, plan §5.9)",
  DIRT_ROWS.every((id) => VFX_EFFECT_FLAGS[id]() === false));
for (const f of DIRT_FLAGS) {
  setUrl(`?${f}=1`);
  check(`?${f}=1 does NOT enable (strict exact-match opt-in)`,
    VFX_EFFECT_FLAGS[DIRT_ROWS[DIRT_FLAGS.indexOf(f)]]() === false);
  setUrl(`?${f}=true`);
  check(`?${f}=true does NOT enable`,
    VFX_EFFECT_FLAGS[DIRT_ROWS[DIRT_FLAGS.indexOf(f)]]() === false);
}
setUrl("?terrainDirt=on");
check("?terrainDirt=on lights the family master", VFX_EFFECT_FLAGS["terrain.dirt"]() === true);
setUrl("?terrainDirt=on&terrainFootfall=on");
check("footfall composes the master", VFX_EFFECT_FLAGS["terrain.footfall"]() === true);
setUrl("?terrainFootfall=on");
check("footfall alone does NOT run (the master is required)",
  VFX_EFFECT_FLAGS["terrain.footfall"]() === false);
setUrl("?terrainDirt=off&terrainFootfall=on&terrainMudPrints=on&terrainDustHaze=on&terrainMudWetness=on");
check("?terrainDirt=off kills every sub-effect",
  DIRT_ROWS.every((id) => VFX_EFFECT_FLAGS[id]() === false));
setUrl("?visual=off&terrainDirt=on&terrainFootfall=on");
check("?visual=off kills the family (the firewall composition rule)",
  ALL_IDS.filter((id) => VFX_EFFECT_FLAGS[id]()).length >= 0
  && (await import("./scene3d/vfx_flags.js")).vfxEffectEnabled("terrain.footfall") === false);
setUrl("?visual=all");
check("?visual=all does NOT light the ship-OFF dirt rows",
  DIRT_ROWS.every((id) => VFX_EFFECT_FLAGS[id]() === false));
clearUrl();
// Numerics.
{
  const m = await import("./scene3d/vfx_flags.js");
  setUrl("?terrainDirtDustCount=1234&terrainDirtRadius=100&terrainDirtDustDensity=0.5&terrainFootfallPuffs=17");
  check("?terrainDirtDustCount override", m.terrainDirtDustCount() === 1234);
  check("?terrainDirtRadius override", m.terrainDirtRadiusM() === 100);
  check("?terrainDirtDustDensity override", m.terrainDirtDustDensity() === 0.5);
  check("?terrainFootfallPuffs override", m.terrainFootfallPuffCount() === 17);
  setUrl("?terrainDirtDustDensity=9");
  check("?terrainDirtDustDensity out of range (0..2) ⇒ default 1", m.terrainDirtDustDensity() === 1);
  clearUrl();
  check("no flags: dust count falls back to the high tier (800)", m.terrainDirtDustCount() === 800);
  check("no flags: dirt radius falls back to 56 m", m.terrainDirtRadiusM() === 56);
  check("no flags: the puff ring is 96 (main + satellite per footfall)", m.terrainFootfallPuffCount() === 96);
  check("a numeric knob cannot enable the family",
    m.terrainDirtDustCount() > 0 && m.terrainDirtEnabled() === false);
}
// Preset ladder — plan §3.7's tier table exactly.
const TIER_EXPECT = {
  low: { terrainDirt: false, terrainFootfall: false, terrainMudPrints: false, terrainMudWetness: false, terrainDirtDustCount: 0 },
  mid: { terrainDirt: false, terrainFootfall: true, terrainMudPrints: false, terrainMudWetness: false, terrainDirtDustCount: 0 },
  high: { terrainDirt: false, terrainFootfall: true, terrainMudPrints: true, terrainMudWetness: false, terrainDirtDustCount: 800 },
  ultra: { terrainDirt: false, terrainFootfall: true, terrainMudPrints: true, terrainMudWetness: true, terrainDirtDustCount: 2000 },
};
for (const tier of PRESET_NAMES) {
  const p = PRESETS[tier];
  for (const [k, v] of Object.entries(TIER_EXPECT[tier])) {
    check(`PRESETS.${tier}.${k} === ${v}`, p[k] === v, String(p[k]));
  }
  check(`PRESETS.${tier} carries terrainDirtRadius`, Number.isFinite(p.terrainDirtRadius));
}
check("the radius ladder rises low→ultra",
  PRESETS.low.terrainDirtRadius <= PRESETS.mid.terrainDirtRadius
  && PRESETS.mid.terrainDirtRadius <= PRESETS.high.terrainDirtRadius
  && PRESETS.high.terrainDirtRadius <= PRESETS.ultra.terrainDirtRadius);
check("low is null for the whole family (plan §5.8)",
  resolveDirtQuality(PRESETS.low) === null);
check("mid resolves to footfall only",
  (() => { const q = resolveDirtQuality(PRESETS.mid);
    return q && q.footfall && !q.prints && !q.wetness && q.dustCount === 0; })());
check("high resolves to footfall + prints + 800 haze",
  (() => { const q = resolveDirtQuality(PRESETS.high);
    return q && q.footfall && q.prints && !q.wetness && q.dustCount === 800; })());
check("ultra adds the wetness",
  (() => { const q = resolveDirtQuality(PRESETS.ultra);
    return q && q.footfall && q.prints && q.wetness && q.dustCount === 2000; })());
check("resolveDirtQuality is null for an empty bag", resolveDirtQuality({}) === null
  && resolveDirtQuality(null) === null);
// Coercion sets — booleans OUT (the gfxRelief rule), numerics IN.
check("the four dirt booleans are NOT in BOOL_FLAGS (the gfxRelief rule)",
  (() => {
    const bools = QUALITY.slice(QUALITY.indexOf("const BOOL_FLAGS"), QUALITY.indexOf("const INT_FLAGS"));
    return ["terrainDirt", "terrainFootfall", "terrainMudPrints", "terrainMudWetness"]
      .every((k) => !bools.includes(`"${k}"`));
  })());
check("terrainDirtDustCount is in INT_FLAGS",
  QUALITY.slice(QUALITY.indexOf("const INT_FLAGS"), QUALITY.indexOf("const FLOAT_FLAGS"))
    .includes('"terrainDirtDustCount"'));
check("terrainDirtRadius is in FLOAT_FLAGS",
  QUALITY.slice(QUALITY.indexOf("const FLOAT_FLAGS"), QUALITY.indexOf("function parseBool"))
    .includes('"terrainDirtRadius"'));
// Docs rows (the lint's hard gate, asserted here too so a missing row fails fast).
for (const f of [...DIRT_FLAGS, "terrainDirtDustCount", "terrainDirtRadius",
  "terrainDirtDustDensity", "terrainFootfallPuffs"]) {
  check(`docs/url-flags.md has a row for ${f}`, FLAGS_DOC.includes("| `" + f + "` |"));
}
check("every dirt reader is exported from vfx_flags.js",
  ["terrainDirtEnabled", "terrainFootfallEnabled", "terrainMudPrintsEnabled",
    "terrainMudWetnessEnabled", "terrainDustHazeEnabled", "terrainDirtDustCount",
    "terrainDirtRadiusM", "terrainDirtDustDensity", "terrainFootfallPuffCount"]
    .every((fn) => FLAGS.includes(`export function ${fn}(`)));
check("_resetVfxFlags clears the dirt memos", FLAGS.includes("_terrainDirt = _terrainFootfall"));

// ===========================================================================
console.log("\n-- D12 bare default is byte-identical ---------------------------");
// ===========================================================================
clearUrl();
_resetTerrainVfx();
_resetTerrainDirt();
{
  const facade = { terrainMaterials: [], terrainGroup: { parent: null } };
  const r = initTerrainDirt({ scene3d: facade });
  check("no flags: initTerrainDirt returns null", r === null);
  check("no flags: it installs NO facade property", facade.onTerrainFootfall === undefined);
  check("no flags: terrainDirtStats reports the family off and uninited",
    terrainDirtStats().enabled === false && terrainDirtStats().inited === false);
  check("no flags: a stray footfall notify is a no-op", terrainFootfall(1, 0, 0, 0) === false);
}
setUrl("?wireframe=1&terrainDirt=on");
check("?wireframe=1 is a hard no-op (plan §8 risk 8)",
  initTerrainDirt({ scene3d: {}, search: "?wireframe=1&terrainDirt=on" }) === null);
clearUrl();
_resetTerrainDirt();

// ===========================================================================
console.log("\n-- D13 the live family, headless --------------------------------");
// ===========================================================================
{
  _resetTerrainVfx();
  _resetTerrainDirt();
  setUrl("?terrainDirt=on&terrainFootfall=on&terrainMudPrints=on&terrainMudWetness=on&terrainTrail=on&terrainTrailFade=30");
  const materials = [{ uniforms: {
    uMudTrailEnabled: { value: 0 }, uMudWetness: { value: 0 },
    uSnowTrailMap: { value: null }, uSnowTrailCenter: { value: { x: 0, y: 0 } },
    uSnowTrailRadius: { value: 0 },
  } }];
  const facade = {
    terrainMaterials: materials, terrainGroup: { parent: null },
    frameTime: { tsSec: 100, dt: 0.016 },
    cameraSwitcher: { _safePlayerPos: () => ({ x: 5, y: 5, z: 10 }) },
    quality: { flags: PRESETS.ultra },
  };
  const oracle = fakeOracle(() => 5);   // MudRichDirt everywhere
  const globals = { uTime: { value: 0 }, uWindDir: { value: { x: 1, y: 0 } },
    uWetness: { value: 0.9 } };
  const { initTerrainVfx, terrainVfxStats, terrainVfxTick } = await import("./scene3d/terrain_vfx.js");
  initTerrainVfx({ scene3d: facade });
  const surface = initTerrainDirt({
    scene3d: facade, globals, getOracle: () => oracle,
    readEnv: () => ({ wetness: 0.9, temperatureC: 12, isStorm: true }),
  });
  check("the family inits and returns its diagnostic surface", !!surface);
  check("it installed onTerrainFootfall on the facade",
    typeof facade.onTerrainFootfall === "function");
  check("window.__terrainDirt-shaped surface exposes stats()",
    typeof surface.stats === "function");
  const ids = terrainVfxStats().providers.map((p) => p.id).sort();
  check("the state + footfall + print providers registered",
    ids.includes(FOOTFALL_PROVIDER_ID) && ids.includes(MUD_PRINT_PROVIDER_ID)
    && ids.includes("terrain.dirtState"), ids.join());
  check("the haze provider did NOT register (?terrainDustHaze absent at high)",
    !ids.includes(DUST_HAZE_PROVIDER_ID), ids.join());
  check("the spine built the SHARED trail map under ?terrainTrail=on",
    terrainVfxStats().trail !== null);
  // Run one frame through every registered provider: the state provider is what
  // the footfall path reads, so drive the real spine tick.
  terrainVfxTick(0.016, facade);
  const s1 = surface.stats();
  check("the live wetness reached the module", Math.abs(s1.liveWetness - 0.9) < 1e-9,
    String(s1.liveWetness));
  check("the wetness reached the terrain material",
    Math.abs(materials[0].uniforms.uMudWetness.value - 0.9) < 1e-9);
  // The map exists but is CPU-only (no renderer) ⇒ no texture ⇒ gate stays 0,
  // which is exactly the ABSENT-MAP contract, and nothing threw.
  check("a CPU-only map leaves the gate at 0 (no texture bound)",
    materials[0].uniforms.uMudTrailEnabled.value === 0);
  check("the print provider still STAMPED into the shared map",
    terrainVfxStats().trail.stampsQueued > 0, JSON.stringify(terrainVfxStats().trail));
  check("the stamp is wetness-scaled (a soaked world stamps at full strength)",
    mudStampFor(0.9, DIRT_VARIANTS[5].print).strength === 1);
  // A footfall on soaked mud must NOT puff (wetness 0.9 > cutoff).
  check("a footfall on SOAKED ground throws no puff",
    facade.onTerrainFootfall(0x50000001, 5, 5, 10) === false);
  _resetTerrainDirt();
  _resetTerrainVfx();
  clearUrl();
}
{
  // Dry world: the same footfall now puffs, and the rate limiter holds.
  _resetTerrainVfx();
  _resetTerrainDirt();
  setUrl("?terrainDirt=on&terrainFootfall=on");
  const facade = {
    terrainMaterials: [], terrainGroup: { parent: null },
    frameTime: { tsSec: 50, dt: 0.016 },
    cameraSwitcher: { _safePlayerPos: () => ({ x: 0, y: 0, z: 10 }) },
    quality: { flags: PRESETS.high },
  };
  const oracle = fakeOracle(() => 7);   // PackedDirt — the dusty one
  const { initTerrainVfx, terrainVfxTick } = await import("./scene3d/terrain_vfx.js");
  initTerrainVfx({ scene3d: facade });
  const surface = initTerrainDirt({
    scene3d: facade, getOracle: () => oracle, readEnv: () => ({ wetness: 0, temperatureC: 25 }),
  });
  terrainVfxTick(0.016, facade);
  check("a footfall on DRY packed dirt throws a puff",
    facade.onTerrainFootfall(0x50000001, 1, 1, 10) === true);
  check("the SAME entity is rate-limited on the next step",
    facade.onTerrainFootfall(0x50000001, 1.2, 1, 10) === false);
  check("a DIFFERENT entity is not",
    facade.onTerrainFootfall(0x50000002, 1.4, 1, 10) === true);
  check("an AIRBORNE footfall (jump) throws nothing",
    facade.onTerrainFootfall(0x50000003, 2, 2, 40) === false);
  check("a FAR-AWAY footfall throws nothing",
    facade.onTerrainFootfall(0x50000004, 900, 900, 10) === false);
  const st = surface.stats();
  check("counters record both the accepted and the rejected footfalls",
    st.counters.footfalls >= 5 && st.counters.footfallsRejected >= 3,
    JSON.stringify(st.counters));
  check("puffs were written to the ring", st.counters.puffs === 2, JSON.stringify(st.counters));
  // livePuffs is recomputed on the provider tick, so it reports LAST frame's
  // ring — exactly what a diagnostic read from the console sees.
  terrainVfxTick(0.016, facade);
  check("livePuffs is the live-check field (non-zero once puffs land)",
    surface.stats().livePuffs > 0, JSON.stringify(surface.stats().puffs));
  // The per-frame budget.
  facade.frameTime.tsSec = 60;
  terrainVfxTick(0.016, facade);
  let accepted = 0;
  for (let i = 0; i < 12; i += 1) {
    if (facade.onTerrainFootfall(0x51000000 + i, 1 + i * 0.1, 1, 10)) accepted += 1;
  }
  check("the per-frame emit budget is enforced",
    accepted === DIRT_TUNING.puffMaxPerFrame, String(accepted));
  _resetTerrainDirt();
  _resetTerrainVfx();
  clearUrl();
}

// ===========================================================================
console.log("\n-- D14 index.js wiring -----------------------------------------");
// ===========================================================================
check("index.js imports initTerrainDirt", INDEX.includes('import { initTerrainDirt } from "./terrain_dirt.js";'));
check("index.js constructs it next to initTerrainVolcano",
  INDEX.indexOf("initTerrainVolcano({") < INDEX.indexOf("initTerrainDirt({"));
check("index.js injects THREE, the shared globals and the env producer",
  /initTerrainDirt\(\{[\s\S]{0,240}globals: VFX_GLOBALS,[\s\S]{0,80}readEnv: readParticleEnv,/.test(INDEX));
check("index.js mirrors the surface onto window.__terrainDirt",
  INDEX.includes("window.__terrainDirt = dirtSurface"));
check("index.js parents the fields to worldRoot (AC space, LRU-scan-proof)",
  /initTerrainDirt\(\{[\s\S]{0,200}parent: worldRoot,/.test(INDEX));
check("the construction is try/caught like every other family",
  INDEX.includes("[terrainDirt] initTerrainDirt threw"));

// ===========================================================================
console.log("\n-- D15 2026-10-23: the family READS (haze, puffs, prints, tune) --");
// ===========================================================================
{
  const V = DIRT_HAZE_VERTEX_GLSL;
  const F = DIRT_HAZE_FRAGMENT_GLSL;
  // (a) An UPRIGHT camera-facing sheet, never the flat ground-plane card a
  //     chase camera foreshortened to a sliver.
  check("haze: the flat ground-plane quad is gone",
    !V.includes("vec3 local = vec3(local2, 0.0);"));
  check("haze: an UPRIGHT billboard about the world vertical",
    V.includes("vec3 upW = normalize((modelMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);")
    && V.includes("cross(upW, flatCam / flatLen)") && V.includes("upW * yUp")
    && V.includes("gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);"));
  check("haze: a rejected slot (aScale 0, 0) is ZERO-AREA",
    V.includes("float live = step(1e-3, aScale.x * aScale.y);")
    && V.includes("float w = aScale.x * live * keep;") && V.includes("float h = aScale.y * live * keep;"));
  check("haze: the foot sinks into the soil, the profile lifts the body",
    V.includes("(position.y + 0.5) * h - uSinkM * live")
    && V.includes("vWisp = vec2(position.x * w + aDrift.x * 53.0, (position.y + 0.5) * h);"));
  // (c) the frozen scatter-time fade is gone from the per-instance alpha.
  check("haze fill no longer multiplies the FROZEN scatter-time ctx.fade",
    !/ctx\.fade/.test(DIRT_CODE));
  check("haze: the LIVE pool fade + a near-camera fade",
    V.includes("float fade = hbScatterFade(placed.xy);")
    && V.includes("smoothstep(uNearStart, uNearEnd, flatLen)"));
  // (d) integrated drift; gusts DOWNWIND; envelope.
  check("haze: no absolute-clock x live-wind product (the racing bug)",
    !V.includes("uTime * uSpeed") && !/uTime\s*\*/.test(V) && !/uniform float uTime;/.test(V));
  check("haze: gust banks drift DOWNWIND (the integrated offset is SUBTRACTED)",
    V.includes("(placed.xy - uGustOffset) * uPulseFreq"));
  check("haze: a fade-in/fade-out life envelope hides the recycle",
    V.includes("smoothstep(0.0, uLifeIn, u) * (1.0 - smoothstep(1.0 - uLifeOut, 1.0, u))"));
  check("haze: follows the ground PLANE at its anchor",
    V.includes("-(aNormal.x * adv.x + aNormal.y * adv.y) / nz"));
  // (e) lit like the ground.
  check("haze: LIT by the terrain light, forward scatter x dirBright",
    V.includes("uSunCol * (max(uSunVec.z, 0.0) + uForward * fwd * dirB) + uAmbCol")
    && V.includes("vColour = aTint * lit;"));
  check("puff: LIT by the terrain light (flat-ground Gouraud)",
    DIRT_PUFF_VERTEX_GLSL.includes("min(vec3(1.0), uSunCol * max(uSunVec.z, 0.0) + uAmbCol)"));
  // Robustness.
  check("no sine hash in either haze stage (1e5-metre world coords)",
    !V.includes("sin(dot(") && !F.includes("sin(dot("));
  check("puff fragment has no atan (undefined at the centre -> NaN -> bloom)",
    !DIRT_PUFF_FRAGMENT_GLSL.includes("atan("));
  check("no pow() in the haze vertex (zero base)", !V.includes("pow("));
  check("haze: a sheet with nothing to show collapses to ZERO AREA (no full-screen discards)",
    V.includes("float keep = step(0.002, vAlpha * uOpacity);")
    && V.includes("float w = aScale.x * live * keep;"));
  check("haze fragment: early-out BEFORE the wisp noise",
    F.indexOf("if (base <= 0.002) discard;") > 0
    && F.indexOf("if (base <= 0.002) discard;") < F.indexOf("dirtNoise2D(vec2(vWisp"));
  check("all four GLSL strings are pure ASCII",
    [DIRT_PUFF_VERTEX_GLSL, DIRT_PUFF_FRAGMENT_GLSL, V, F].every((g) => /^[\x00-\x7e]*$/.test(g)));
}
{
  // hazeAdvect — the JS twin; the envelope and the SEAMLESS wrap.
  const a0 = hazeAdvect(0, 0, 1, 16, 0.2, 0.25);
  const aMid = hazeAdvect(8, 0, 1, 16, 0.2, 0.25);
  check("envelope is 0 at the recycle seam and 1 mid-span",
    a0.life === 0 && Math.abs(aMid.life - 1) < 1e-9, JSON.stringify([a0, aMid]));
  check("s spans the anchor symmetrically", Math.abs(aMid.s) < 1e-9
    && Math.abs(hazeAdvect(0, 0.25, 1, 16).s + 4) < 1e-9);
  check("speed multipliers are the quantised k/8 steps",
    [0, 0.21, 0.5, 0.79, 0.999].map(hazeSpeedMul).every((m) => HAZE_SPEED_STEPS.includes(m * 8)));
  const wrap = hazeTravelWrapM(16);
  let seamless = true;
  for (const k of HAZE_SPEED_STEPS) {
    for (const ph of [0, 0.37, 0.81]) {
      for (const t of [3.3, 1234.5]) {
        const x = hazeAdvect(t, ph, k / 8, 16);
        const y = hazeAdvect(t + wrap, ph, k / 8, 16);
        if (Math.abs(x.s - y.s) > 1e-6 || Math.abs(x.life - y.life) > 1e-6) seamless = false;
      }
    }
  }
  check("the travel wrap is SEAMLESS for every speed step", seamless, String(wrap));
}
{
  // The CPU integration: smooth, downwind, dt-clamped, never racing.
  const globals = { uTime: { value: 0 }, uWindDir: { value: { x: 1, y: 0 } } };
  const oracle = fakeOracle(() => 31);
  const field = createDustHazeField({ oracle, globals, count: 64, radiusM: 40, seed: 3 });
  check("the haze still adopts the shared clock BY IDENTITY", field.uniforms.uTime === globals.uTime);
  for (let i = 0; i < 60; i += 1) field.update(1 / 60, 5000 + i / 60, 0, 0, 10, 1);
  const t1 = field.uniforms.uTravel.value;
  check("travel = integral of dt x speed x |wind| (1 s at wind 1)",
    Math.abs(t1 - DIRT_TUNING.hazeAdvectSpeed) < 1e-6, String(t1));
  check("the gust field drifts DOWNWIND (+X wind -> +X offset)",
    field.uniforms.uGustOffset.value.x > 0 && Math.abs(field.uniforms.uGustOffset.value.y) < 1e-9);
  field.update(30, 5031, 0, 0, 10, 1);
  check("a tab-resume dt is clamped (no jump)",
    field.uniforms.uTravel.value - t1 <= 0.25 * DIRT_TUNING.hazeAdvectSpeed + 1e-9);
  // A breathing wind at a LARGE clock never makes the sheets race: the per-
  // frame advance is bounded by dt x speed x |wind| whatever the clock reads.
  let maxStep = 0;
  let prev = field.uniforms.uTravel.value;
  for (let i = 0; i < 600; i += 1) {
    const g = 1 + 0.6 * Math.sin(i * 0.9);
    globals.uWindDir.value = { x: g, y: 0 };
    field.update(1 / 60, 3600 + i / 60, 0, 0, 10, 1);
    const cur = field.uniforms.uTravel.value;
    maxStep = Math.max(maxStep, cur - prev);
    prev = cur;
  }
  check("no racing: per-frame travel <= dt x speed x max|wind| at clock 3600 s",
    maxStep <= (1 / 60) * DIRT_TUNING.hazeAdvectSpeed * 1.6 + 1e-9, String(maxStep));
  // The frozen-fade regression: walk the window so leading-edge sheets are
  // scattered at the rim, then check EVERY live sheet's alpha.
  globals.uWindDir.value = { x: 1, y: 0 };
  for (let i = 0; i < 120; i += 1) field.update(1 / 60, 4000 + i / 60, i * 0.4, 0, 10, 1);
  const pool = field.pool;
  const drift = pool.arrays.aDrift;
  const tint = pool.arrays.aTint;
  const scale = pool.arrays.aScale;
  let live = 0, minAlpha = 1, tintOk = true, sizeOk = true;
  for (let i = 0; i < pool.count; i += 1) {
    if (!pool.isLive(i)) continue;
    live += 1;
    minAlpha = Math.min(minAlpha, drift[i * 4 + 3]);
    if (Math.abs(tint[i * 3] - DIRT_VARIANTS[31].puff[0]) > 1e-6) tintOk = false;
    const w = scale[i * 2], h = scale[i * 2 + 1];
    const j = DIRT_TUNING.hazeSizeJitter;
    if (w < DIRT_TUNING.hazeWidthM * (1 - j) - 1e-6 || w > DIRT_TUNING.hazeWidthM * (1 + j) + 1e-6
      || h < DIRT_TUNING.hazeHeightM * (1 - j) - 1e-6 || h > DIRT_TUNING.hazeHeightM * (1 + j) + 1e-6) sizeOk = false;
  }
  check("live sheets exist after the walk", live > 0, String(live));
  check("NO live sheet carries a frozen rim fade (per-sheet alpha >= 0.6)", minAlpha >= 0.6 - 1e-6, String(minAlpha));
  check("every sheet is tinted with its code's dust colour", tintOk);
  check("sheet sizes are (width, height) within the jitter", sizeOk);
  check("the sheet is TALL and WIDE enough to read side-on (>= 1 m x 4 m)",
    DIRT_TUNING.hazeHeightM * (1 - DIRT_TUNING.hazeSizeJitter) >= 1
    && DIRT_TUNING.hazeWidthM * (1 - DIRT_TUNING.hazeSizeJitter) >= 4);
  field.dispose();
}
{
  // Lighting: the retail flat-ground formula, dark at night, clamped at noon.
  const noon = dustLitFactor({ sunVec: [0, 0.3, 0.72], sunCol: [1, 0.98, 0.94], amb: [0.35, 0.35, 0.38] });
  const night = dustLitFactor({ sunVec: [0, 0, 0], sunCol: [0.6, 0.6, 0.8], amb: [0.08, 0.08, 0.1] });
  check("noon dust is lit to ~albedo (clamped at 1)", noon.every((c) => c > 0.95 && c <= 1));
  check("night dust is DARK (ambient floor only; never glows)", night.every((c) => c <= 0.1));
  check("forward scatter is zero at night (x dirBright)",
    dustLitFactor({ sunVec: [0, 0, 0], sunCol: [1, 1, 1], amb: [0.1, 0.1, 0.1] }, 1)[0] === 0.1);
  check("forward scatter lifts a low-sun view",
    dustLitFactor({ sunVec: [0.7, 0, 0.05], sunCol: [1, 0.8, 0.6], amb: [0.2, 0.2, 0.2] }, 0.6)[0]
    > dustLitFactor({ sunVec: [0.7, 0, 0.05], sunCol: [1, 0.8, 0.6], amb: [0.2, 0.2, 0.2] }, 0)[0]);
  const light = createDustLight(null);
  check("no terrain material ⇒ no copy, neutral defaults kept",
    copyTerrainLight([{ uniforms: {} }], light) === false && light.fromTerrain === false);
  const mat = { uniforms: {
    uAcSunVec: { value: { x: 0.1, y: 0.2, z: 0.6 } },
    uAcSunColor: { value: { r: 1, g: 0.9, b: 0.8 } },
    uAcAmbColor: { value: { r: 0.5, g: 0.5, b: 0.6 } },
    uAcAmbLevel: { value: 0.4 },
  } };
  check("the terrain light is copied off the first carrying material",
    copyTerrainLight([null, { uniforms: {} }, mat], light) === true && light.fromTerrain === true
    && light.uSunVec.value.z === 0.6 && light.uSunCol.value.y === 0.9
    && Math.abs(light.uAmbCol.value.z - 0.24) < 1e-12);
  const fresh = { userData: {}, uniforms: {
    uAcSunVec: { value: { x: 0, y: 0, z: 0 } }, uAcSunColor: { value: { r: 0, g: 0, b: 0 } },
    uAcAmbColor: { value: { r: 0, g: 0, b: 0 } }, uAcAmbLevel: { value: 0 } } };
  const lit = { userData: { __acLightEpoch: 3 }, uniforms: mat.uniforms };
  const l2 = createDustLight(null);
  check("a just-baked (unlit, black-sun) material is skipped for a lit one",
    copyTerrainLight([fresh, lit], l2) === true && l2.uSunVec.value.z === 0.6);
  // Both dirt fields hold the SAME light entries by reference.
  const pf = createPuffField({ light, capacity: 4 });
  const hf = createDustHazeField({ light, oracle: fakeOracle(() => 7), count: 16, radiusM: 20 });
  check("puff + haze share the light uniforms BY REFERENCE",
    pf.uniforms.uSunVec === light.uSunVec && hf.uniforms.uSunVec === light.uSunVec
    && pf.uniforms.uAmbCol === hf.uniforms.uAmbCol);
  pf.dispose(); hf.dispose();
}
{
  // Puffs: a lit BURST — main + satellite, the satellite smaller and later.
  const globals = { uTime: { value: 0 }, uWindDir: { value: { x: 1, y: 0 } } };
  const field = createPuffField({ globals, capacity: 8, seed: 5 });
  const n = field.burst(10, 20, 5, 1, DIRT_VARIANTS[7].puff, 1);
  check("a footfall burst writes 1 + puffSatellites slots", n === 1 + DIRT_TUNING.puffSatellites, String(n));
  const cfg = field.buffers.aPuffCfg;
  const puff = field.buffers.aPuff;
  check("the main puff is full size, the satellite scaled down",
    cfg[3] === 1 && Math.abs(cfg[7] - DIRT_TUNING.puffSatelliteScale) < 1e-6);
  check("the satellite is born a beat later (unborn = zero-area)",
    Math.abs(puff[7] - (1 + DIRT_TUNING.puffSatelliteDelaySec)) < 1e-6);
  check("the satellite is offset within the spread",
    Math.hypot(puff[4] - 10, puff[5] - 20) <= DIRT_TUNING.puffSatelliteSpreadM + 1e-6
    && Math.hypot(puff[4] - 10, puff[5] - 20) > 0);
  const b2 = createPuffField({ globals, capacity: 8, seed: 5 });
  b2.burst(10, 20, 5, 1, DIRT_VARIANTS[7].puff, 1);
  check("bursts are deterministic (§5.5)", b2.buffers.aPuff.join() === field.buffers.aPuff.join());
  check("the puff is a ~1-1.6 m cloud now, not a 0.45 m speck",
    DIRT_TUNING.puffRadiusEndM >= 1.2 && DIRT_TUNING.puffOpacity >= 0.5 && DIRT_TUNING.puffLifeSec >= 1);
  // Dust is PALER and LESS SATURATED than the soil (PackedDirt lit ground
  // reads ~linear (0.41, 0.19, 0.04) in the owner's noon still).
  const c7 = DIRT_VARIANTS[7].puff;
  const lum = 0.2126 * c7[0] + 0.7152 * c7[1] + 0.0722 * c7[2];
  check("PackedDirt dust is paler than its ground (linear luminance > 0.4)", lum > 0.4, String(lum));
  check("... and less saturated ((max-min)/max < 0.5)",
    (Math.max(...c7) - Math.min(...c7)) / Math.max(...c7) < 0.5);
  field.dispose(); b2.dispose();
}
{
  // Prints: a DRY track reads, wet reads ~2-3x deeper. 2026-10-24: the mud
  // stamp shares the trail map with the grass stomp (DEFAULT ON at high/ultra,
  // max()-combined), so at high/ultra the track centre reads the stomp's
  // stamp, not the per-code one; the full model and the 0.65 -> 0.35 dry seed
  // are test_terrain_dirt_shader.mjs M5b (terrain.js owns the seeds).
  const SRC_T = readFileSync("./scene3d/terrain.js", "utf8");
  const num = (name) => Number((new RegExp(`const ${name} = ([0-9.]+);`).exec(SRC_T) || [])[1]);
  const darken = num("DEFAULT_MUD_PRINT_DARKEN");
  const dryScale = num("DEFAULT_MUD_PRINT_DRY_SCALE");
  const { GRASS_DEFAULTS } = await import("./scene3d/terrain_grass.js");
  const stomp = PRESETS.high.terrainGrassStomp === true ? GRASS_DEFAULTS.stampStrength : 0;
  const centre = (wet, code) => Math.max(stomp, mudStampFor(wet, DIRT_VARIANTS[code].print).strength);
  const dryPacked = darken * dryScale * centre(0, 7);
  const wetPacked = darken * 1 * centre(1, 7);
  check("a DRY PackedDirt track darkens >= 10 % at high/ultra (stomp-composed; was ~2 %)",
    dryPacked >= 0.1, dryPacked.toFixed(3));
  check("stomp off, a DRY PackedDirt track still reads (>= 5 %)",
    darken * dryScale * mudStampFor(0, DIRT_VARIANTS[7].print).strength >= 0.05);
  check("a SOAKED track still reads >= 2x the dry one", wetPacked >= 2 * dryPacked, wetPacked.toFixed(3));
  check("a soaked MudRichDirt track stays <= 45 % (not a black hole)",
    darken * centre(1, 5) <= 0.45);
}
{
  // Live tuning.
  _resetTerrainVfx();
  _resetTerrainDirt();
  setUrl("?terrainDirt=on&terrainDustHaze=on&terrainFootfall=on&terrainMudPrints=on&terrainTrail=on");
  const materials = [{ uniforms: {
    uMudTrailEnabled: { value: 0 }, uMudWetness: { value: 0 },
    uMudPrintDarken: { value: 0.42 }, uMudPrintDryScale: { value: 0.65 }, uMudPrintDepth: { value: 0.006 },
    uAcSunVec: { value: { x: 0, y: 0.3, z: 0.7 } }, uAcSunColor: { value: { r: 1, g: 0.95, b: 0.9 } },
    uAcAmbColor: { value: { r: 0.4, g: 0.4, b: 0.45 } }, uAcAmbLevel: { value: 0.5 },
  } }];
  const facade = {
    terrainMaterials: materials, terrainGroup: { parent: null },
    frameTime: { tsSec: 10, dt: 0.016 },
    cameraSwitcher: { _safePlayerPos: () => ({ x: 0, y: 0, z: 10 }) },
    quality: { flags: PRESETS.high },
  };
  const { initTerrainVfx, terrainVfxTick } = await import("./scene3d/terrain_vfx.js");
  initTerrainVfx({ scene3d: facade });
  const surface = initTerrainDirt({
    scene3d: facade, getOracle: () => fakeOracle(() => 7),
    readEnv: () => ({ wetness: 0, temperatureC: 25 }),
  });
  terrainVfxTick(0.016, facade);
  terrainVfxTick(0.016, facade);
  const st = surface.stats();
  check("the live haze field built and the dust light came off the terrain",
    !!surface.haze && st.lightFromTerrain === true && st.counters.lightCopies > 0, JSON.stringify(st.counters));
  check("the haze holds the copied terrain light",
    surface.haze.uniforms.uSunVec.value.z === 0.7 && Math.abs(surface.haze.uniforms.uAmbCol.value.x - 0.2) < 1e-12);
  check("surface.tune exists", typeof surface.tune === "function");
  const r1 = surface.tune({ hazeOpacity: 0.4, puffOpacity: 2, bogusKey: 1, hazeWidthM: "x" });
  check("tune() applies a haze key live", surface.haze.uniforms.uOpacity.value === 0.4);
  check("the live provider feeds the player into the sightline uniform (D16)",
    !!surface.haze.uniforms.uAvatarAc && surface.haze.uniforms.uAvatarAc.value.x === 0
    && surface.haze.uniforms.uAvatarAc.value.z === 10);
  surface.tune({ hazeSightFadeEnd: 2, hazeSightFadeStart: 3 });
  check("tune() reaches the sightline window live, start kept below end (D16)",
    !!surface.haze.uniforms.uSightEnd && surface.haze.uniforms.uSightEnd.value === 2
    && Math.abs(surface.haze.uniforms.uSightStart.value - 1.99) < 1e-9);
  check("tune() clamps (puffOpacity 2 -> 1)", r1.tuning.puffOpacity === 1);
  check("tune() REPORTS unknown / non-numeric keys", r1.rejected.join() === "bogusKey,hazeWidthM", r1.rejected.join());
  surface.tune({ stampStrengthDry: 0.9 });
  check("emit/stamp-time keys reach the next stamp (live record)",
    mudStampFor(0, 1, r1.tuning).strength === 0.6 && surface.tune().tuning.stampStrengthDry === 0.9);
  surface.tune({ printDarken: 0.5 });
  terrainVfxTick(0.016, facade);
  check("a print override reaches every terrain material through the push",
    materials[0].uniforms.uMudPrintDarken.value === 0.5);
  surface.tune(null);
  terrainVfxTick(0.016, facade);
  check("tune(null) restores the defaults AND the terrain.js print seed",
    surface.haze.uniforms.uOpacity.value === DIRT_TUNING.hazeOpacity
    && !!surface.haze.uniforms.uSightEnd && surface.haze.uniforms.uSightEnd.value === DIRT_TUNING.hazeSightFadeEnd
    && materials[0].uniforms.uMudPrintDarken.value === 0.42);
  check("pushMudTrailUniforms leaves the seeds alone without overrides",
    (() => { const m = { uniforms: { uMudTrailEnabled: { value: 0 }, uMudPrintDarken: { value: 0.33 } } };
      pushMudTrailUniforms([m], null, 0); pushMudTrailUniforms([m], null, 0, { printDarken: null });
      return m.uniforms.uMudPrintDarken.value === 0.33; })());
  _resetTerrainDirt();
  _resetTerrainVfx();
  clearUrl();
}

// ===========================================================================
console.log("\n-- D16 2026-10-24 review: a soft GROUND foot; no veiled player ---");
// ===========================================================================
const glslSmooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const glslClamp = (x, a, b) => Math.min(b, Math.max(a, x));
{
  const V = DIRT_HAZE_VERTEX_GLSL;
  const F = DIRT_HAZE_FRAGMENT_GLSL;
  const T = DIRT_TUNING;
  // (1) THE FOOT LINE. The fragment stage's OWN profile line, evaluated (its
  //     only calls are smoothstep), on FLAT ground: the quad bottom sits
  //     uSinkM under the soil and vWisp.y is metres above the quad bottom.
  const m = /float prof = ([^;]+);/.exec(F);
  check("haze fragment: one `float prof = ...;` line to evaluate", !!m);
  let profFn = null;
  try {
    profFn = m ? new Function("smoothstep", "uSinkM", "vWisp", "y", "vQuadUv", `return (${m[1]});`) : null;
  } catch (_) { profFn = null; }
  const prof = (aboveGroundM, h) => {
    const yQ = aboveGroundM + T.hazeSinkM;
    return profFn ? profFn(glslSmooth, T.hazeSinkM, { x: 0, y: yQ }, yQ / h, { x: 0.5, y: yQ / h }) : NaN;
  };
  const H = [T.hazeHeightM * (1 - T.hazeSizeJitter), T.hazeHeightM, T.hazeHeightM * (1 + T.hazeSizeJitter)];
  const atGround = H.map((h) => prof(0, h));
  check("the alpha is ZERO where a sheet meets flat ground, for every height in the jitter",
    atGround.every((p) => p <= 1e-6), atGround.map((p) => p.toFixed(3)).join("/"));
  check("the foot ramps in softly (<= 0.05 at 5 cm, <= 0.2 at 10 cm above the soil)",
    H.every((h) => prof(0.05, h) <= 0.05 && prof(0.1, h) <= 0.2),
    H.map((h) => prof(0.05, h).toFixed(3)).join("/"));
  check("the buried part of the quad is fully transparent",
    H.every((h) => prof(-0.1, h) === 0 && prof(-T.hazeSinkM, h) === 0));
  let mono = true;
  const peaks = H.map((h) => {
    let best = 0, prev = -1, rising = true;
    for (let a = 0; a <= h - T.hazeSinkM + 1e-9; a += 0.005) {
      const p = prof(a, h);
      if (rising && p + 1e-12 < prev) rising = false;
      if (!rising && p > prev + 1e-12) mono = false;   // a second hump
      prev = p;
      best = Math.max(best, p);
    }
    return best;
  });
  check("one hump: the profile rises from the ground to its peak, then only feathers out", mono);
  check("every sheet still reaches >= 0.85 of the peak alpha, the default height 1.0",
    peaks.every((p) => p >= 0.85) && peaks[1] >= 0.999, peaks.map((p) => p.toFixed(3)).join("/"));
  check("the old quad-uv foot ramp is gone", !F.includes("smoothstep(0.0, 0.4, y)"));
  check("uSinkM is declared highp in BOTH stages",
    V.includes("uniform highp float uSinkM;") && F.includes("uniform highp float uSinkM;"));
  // The SHEAR, evaluated: a column at lateral offset xM must land ON the
  // ground plane at the anchor (n . offset = 0), so the foot follows a slope.
  const sm = /float shear = ([^;]+);/.exec(V);
  check("haze vertex: the sheet is sheared along the ground plane",
    !!sm && V.includes("- uSinkM * live * keep + shear;") && V.includes("vec3 nW = nLen > 1e-4 ? nRaw / nLen : upW;")
    && V.includes("vec3 wp = wAnchor.xyz + side * xM + upW * yUp;"));
  if (sm) {
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const shearFn = new Function("dot", "max", "clamp", "nW", "side", "upW", "xM", `return (${sm[1]});`);
    let onPlane = true;
    for (const deg of [-25, -10, 0, 15, 30]) {
      const r = (deg * Math.PI) / 180;
      const nW = [Math.sin(r), Math.cos(r), 0];          // a lateral slope (+Y up)
      const side = [1, 0, 0], upW = [0, 1, 0];
      for (const xM of [-3, -1, 0, 1.5, 3]) {
        const sh = shearFn(dot, Math.max, glslClamp, nW, side, upW, xM);
        const off = [xM, sh, 0];
        if (Math.abs(dot(nW, off)) > 1e-9 && Math.abs(sh) < 3 - 1e-9) onPlane = false;
      }
    }
    check("the sheared foot lies ON the anchor's ground plane (lateral slopes 0-30 deg)", onPlane);
  }
  // Alpha model re-check: a ray crosses the VISIBLE column (above the soil),
  // so visible-column x opacity must keep the 2026-10-23 calibration (the old
  // uv profile at hazeOpacity 0.25), within 3 %, averaged over the jitter.
  const oldProf = (aboveGroundM, h) => {
    const y = (aboveGroundM + T.hazeSinkM) / h;
    return glslSmooth(0, 0.4, y) * (1 - glslSmooth(0.45, 1, y));
  };
  const column = (fn) => {
    let acc = 0, k = 0;
    for (let j = -1; j <= 1 + 1e-9; j += 0.1) {
      const h = T.hazeHeightM * (1 + j * T.hazeSizeJitter);
      let s = 0;
      for (let a = 0; a <= h - T.hazeSinkM; a += 0.002) s += fn(a, h) * 0.002;
      acc += s; k += 1;
    }
    return acc / k;
  };
  const cOld = column(oldProf), cNew = column(prof);
  const ratio = (cNew * T.hazeOpacity) / (cOld * 0.25);
  check("the opacity re-calibration keeps the 2026-10-23 grazing veil (visible column x opacity, +-3 %)",
    Math.abs(ratio - 1) <= 0.03, `old ${cOld.toFixed(3)} m, new ${cNew.toFixed(3)} m, ratio ${ratio.toFixed(3)}`);
  check("... and the bank peak stays dust, not a wall (hazeOpacity <= 0.3)", T.hazeOpacity <= 0.3);
}
{
  const V = DIRT_HAZE_VERTEX_GLSL;
  const F = DIRT_HAZE_FRAGMENT_GLSL;
  const T = DIRT_TUNING;
  const hazeNearFade = DIRT_NS.hazeNearFade;
  // (2) THE AVATAR VEIL.
  check("haze vertex: the near fade includes the camera -> avatar SIGHTLINE",
    V.includes("vec3 toAv = (modelMatrix * vec4(uAvatarAc, 1.0)).xyz - cameraPosition;")
    && V.includes("float tSeg = segL2 > 1e-4 ? clamp(-dot(flatCam, seg) / segL2, 0.0, 1.0) : 0.0;")
    && V.includes("float sightN = length(flatCam + seg * tSeg) / max(0.5 * aScale.x, 0.25);")
    && V.includes("float near = smoothstep(uNearStart, uNearEnd, flatLen) * smoothstep(uSightStart, uSightEnd, sightN);"));
  check("the sightline costs nothing per FRAGMENT (vertex stage only)",
    !F.includes("uAvatarAc") && !F.includes("sightN") && !F.includes("uSight"));
  check("hazeNearFade (the JS twin) is exported", typeof hazeNearFade === "function");
  if (typeof hazeNearFade === "function") {
    const side = (x) => 1 - glslSmooth(0.3, 1.0, Math.abs(x));
    // The worst veil a sheet lays over the player: for every anchor between
    // the camera and the avatar, the sheet faces the camera, so the camera ->
    // avatar ray crosses its plane at an in-plane offset; veil = view fade x
    // the side mask at that offset. Flat frame: avatar at the origin, camera
    // `camDist` behind on -Y.
    const worstVeil = (camDist, widthM, tuning) => {
      const cx = 0, cy = -camDist, dx = 0, dy = camDist;
      let worst = 0;
      for (let t = 0.02; t <= 0.995; t += 0.01) {
        for (let lat = -6; lat <= 6; lat += 0.1) {
          const ax = cx + dx * t + lat, ay = cy + dy * t;
          const fx = ax - cx, fy = ay - cy, fl = Math.hypot(fx, fy);
          const nx = fx / fl, ny = fy / fl;
          const k = (fx * nx + fy * ny) / (dx * nx + dy * ny);
          if (!(k > 0 && k < 1)) continue;               // the plane is behind the player
          const off = Math.hypot(cx + dx * k - ax, cy + dy * k - ay);
          const v = hazeNearFade(ax, ay, cx, cy, 0, 0, widthM, tuning) * side(off / (widthM / 2));
          if (v > worst) worst = v;
        }
      }
      return worst;
    };
    const W = [T.hazeWidthM * (1 - T.hazeSizeJitter), T.hazeWidthM, T.hazeWidthM * (1 + T.hazeSizeJitter)];
    const rows = [];
    let ok = true;
    for (const camDist of [3, 5.7, 12]) {
      for (const w of W) {
        const v = worstVeil(camDist, w);
        rows.push(`${camDist}m/w${w.toFixed(2)}=${v.toFixed(3)}`);
        if (!(v <= 0.06)) ok = false;
      }
    }
    check("no sheet veils the player: worst sightline veil <= 0.06 of a sheet's alpha (3 / 5.7 / 12 m chase, every width)",
      ok, rows.join(" "));
    // Control: the camera-only window this replaces (sightline window off)
    // DOES veil the player — the metric catches the reviewer's bug.
    const camOnly = { ...T, hazeSightFadeStart: 0, hazeSightFadeEnd: 1e-3 };
    const c57 = worstVeil(5.7, T.hazeWidthM, camOnly), c12 = worstVeil(12, T.hazeWidthM, camOnly);
    check("control: the camera-only 2.5 -> 8 m window veils the player (~0.6 at the default chase, ~1 at 12 m)",
      c57 >= 0.5 && c12 >= 0.95, `${c57.toFixed(3)} / ${c12.toFixed(3)}`);
    check("the camera window still holds: a sheet 1.5 m from the camera is gone",
      hazeNearFade(-1.5, -5.7, 0, -5.7, 0, 0, T.hazeWidthM) === 0
      && hazeNearFade(0, -7.2, 0, -5.7, 0, 0, T.hazeWidthM) === 0);
    check("no sheet cuts through the avatar itself", hazeNearFade(0.3, 0.2, 0, -5.7, 0, 0, T.hazeWidthM) === 0);
    check("a sheet well clear of the sightline is untouched (20 m ahead, 10 m aside)",
      hazeNearFade(10, 20, 0, -5.7, 0, 0, T.hazeWidthM) >= 0.999);
    check("first person (camera at the avatar) degenerates to the camera window",
      hazeNearFade(0, 20, 0, 0, 0, 0, T.hazeWidthM) >= 0.999 && hazeNearFade(0, 1, 0, 0, 0, 0, T.hazeWidthM) === 0);
    // The cost in haze: the field's fade-weighted area loses < 2 % against
    // the camera window alone (the cleared corridor is one sheet wide).
    let all = 0, kept = 0;
    for (let x = -56; x <= 56; x += 0.5) {
      for (let y = -56; y <= 56; y += 0.5) {
        const r = Math.hypot(x, y);
        if (r > 56) continue;
        const rim = 1 - glslSmooth(56 * 0.7, 56, r);
        all += hazeNearFade(x, y, 0, -5.7, 0, 0, T.hazeWidthM, camOnly) * rim;
        kept += hazeNearFade(x, y, 0, -5.7, 0, 0, T.hazeWidthM) * rim;
      }
    }
    check("the sightline clears a corridor, not the field (< 2 % of the haze)",
      kept / all >= 0.98, ((1 - kept / all) * 100).toFixed(2) + " % lost");
  }
  // The field copies the player into the sightline uniform every frame.
  const field = createDustHazeField({ oracle: fakeOracle(() => 31), count: 16, radiusM: 20, seed: 9 });
  field.update(1 / 60, 1, 12.5, -7.25, 3, 1);
  const av = field.uniforms.uAvatarAc && field.uniforms.uAvatarAc.value;
  check("update() copies the player into uAvatarAc (and stats() shows it)",
    !!av && av.x === 12.5 && av.y === -7.25 && av.z === 3
    && field.stats().sightAvatar && field.stats().sightAvatar.x === 12.5);
  check("the sightline window ships in DIRT_TUNING with start < end",
    T.hazeSightFadeStart >= 0 && T.hazeSightFadeStart < T.hazeSightFadeEnd
    && field.uniforms.uSightStart && field.uniforms.uSightStart.value === T.hazeSightFadeStart
    && field.uniforms.uSightEnd.value === T.hazeSightFadeEnd);
  field.dispose();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
