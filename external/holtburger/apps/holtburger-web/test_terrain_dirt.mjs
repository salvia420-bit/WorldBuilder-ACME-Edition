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
//       count is still 14.
//   D12 BARE DEFAULT IS BYTE-IDENTICAL: `initTerrainDirt` registers nothing,
//       allocates nothing and installs no facade property with the flag absent.
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
  pushMudTrailUniforms,
  installFootfallHook,
  initTerrainDirt,
  terrainFootfall,
  terrainDirtStats,
  _resetTerrainDirt,
} from "./scene3d/terrain_dirt.js";
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
  check("the puff RISES and decelerates (sqrt, not linear)",
    puffState(0, 0, 0.25, 1).z > 0.25 * DIRT_TUNING.puffRiseM
    && Math.abs(puffState(0, 0, 1, 1).z - DIRT_TUNING.puffRiseM) < 1e-9);
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
  check("haze schema matches the sand/snow streamer shape",
    DIRT_HAZE_SCHEMA.map((a) => a.name).join() === "aOffset,aScale,aDrift");
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
check("the DEFAULT-ON effect count is STILL 14 after the wave-3B rows",
  ALL_IDS.filter((id) => !id.startsWith("terrain.")).length === 14);
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
  check("no flags: the puff ring is 48", m.terrainFootfallPuffCount() === 48);
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
