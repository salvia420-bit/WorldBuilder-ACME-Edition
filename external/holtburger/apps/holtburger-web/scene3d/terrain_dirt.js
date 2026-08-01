// scene3d/terrain_dirt.js — DIRT / MUD terrain VFX (Wave 3B).
//
// Design plan: `docs/2026-07-31-terrain-vfx-plan.md` §3.7. Terrain codes 5
// (`MudRichDirt`), 7 (`PackedDirt`), 8 (`PatchyDirt`), 24 (`Argila`) and 31
// (`DesolateLands`) = `FAM_DIRT` — DERIVED from `terrain_families.js`, never
// hardcoded here (plan §8 risk 12: family membership is a property of the CODE,
// and another region could name the same code differently).
//
// THE LOOK (plan §3.7). Ground that RESPONDS. Dry dirt coughs a puff of dust
// where a foot lands; wet mud goes dark and glossy, deforms under a print and
// heals slowly; `DesolateLands` lifts a low brown haze in the dry heat; clay
// (`Argila`) goes redder and slicker than the rest of the family after rain.
//
// FOUR EFFECTS, THREE OWNERS:
//   1. FOOTFALL PUFFS — here. A fixed-capacity RING BUFFER of billboarded dust
//      quads, emitted on the EXISTING footstep-audio trigger (plan §3.7 item 1:
//      "hang off the existing footstep-audio trigger rather than re-deriving
//      contact from velocity"). The trigger is the animation SoundTable hook for
//      `Sound.Footstep1/2` (0x37/0x38, `ACE.Entity/Enum/Sound.cs`) in
//      `entities.js::_fireHook`, which calls `scene3d.onTerrainFootfall(...)` —
//      a function property THIS module installs on all three facades and
//      NOBODY else defines, so with the family off the notify is one
//      `typeof undefined` test on a hook that fires a few times a second.
//      Puff colour comes from `oracle.sample().code` through `DIRT_VARIANTS`;
//      NON-dirt ground (water, ice, grass, rock, ...) emits NOTHING.
//   2. MUD PRINTS — split three ways, exactly as snow prints are: `trail_map.js`
//      (wave 0B) owns the render target, the terrain fragment shader owns the
//      dent + the darkening, and THIS file owns the STAMP and the per-frame
//      uniform push that connects them.
//   3. WETNESS — the terrain fragment shader again, reusing the RESPONSE CURVE
//      of `vfx/components/wetness.js` (plan §3.7 item 2) so puddled statics and
//      puddled ground agree: the same up-facing `smoothstep(0.05, 0.6, n_up)`
//      weight, the same 0.62 darken and the same 0.25 roughness drop. The
//      DRIVER is the already-smoothed `VFX_GLOBALS.uWetness` (plan §3.7 item 4:
//      "read getWeatherInputs().wetness; do not re-derive from weather/rain.js")
//      — this file adds NO lag of its own, it only copies the value onto the
//      terrain materials each frame.
//   4. DRY DUST HAZE — here. A camera-scoped `terrain_scatter.js` pool of low,
//      slow, brown haze quads (the §3.2 streamer system, plan §3.7 item 3),
//      `DesolateLands`-biased through the per-code table and suppressed by the
//      same wetness signal that drives the mud (rain lays the dust).
//
// ── THE TRAIL-FADE DECISION (the wave-2A tension, restated for mud) ────────
// The trail map has ONE global fade (`?terrainTrailFade`), and three families
// want three different numbers: grass wants ~4 s springback, snow runs at 300 s
// (its "effectively infinite"), and the plan asks mud for a ~30 s recovery that
// ALSO depends on the rain. Wave 2A's ruling stands and this family does NOT
// re-open it: **there is NO second trail render target.** The terrain fragment
// shader is at 15 of a guaranteed 16 samplers, so a second map would sit on the
// floor with nothing left for anyone; `?terrainTrailRes` + `?terrainTrailRadius`
// already reach every point on the resolution/extent curve; and the map's own
// EXTENT bounds a print's life (~24 s to cross a 96 m map at a run) long before
// most fades do. Full rationale in the `terrain_snow.js` header.
//
// So mud resolves the tension WITHOUT a second constant:
//   (a) THE FADE IS A PER-FAMILY CLAIM, and mud's is 30 s —
//       `MUD_RECOMMENDED_FADE_SEC`, exactly the plan's "slow recovery (~30 s)".
//       Since 2026-08-01 it APPLIES ITSELF: with mud prints live and no explicit
//       `?terrainTrailFade=`, `vfx_flags.js::terrainTrailFadeSource` resolves
//       the longest live claim, so mud alone runs at 30 s and mud beside snow
//       runs at snow's 300 s (longest wins — a fade shorter than a family asked
//       for destroys its effect, a longer one only makes it linger).
//       `initTerrainDirt` still warns ONCE when the LIVE fade is far below the
//       ask (only reachable by an explicit URL now) and notes ONCE when it is
//       far above (snow co-tenancy — legitimate, just not what mud asked for).
//       Never silently wrong — the `gfx_relief.js:137` rule.
//   (b) THE RAIN DEPENDENCE IS NOT A FADE AT ALL. It rides amplitude, which is
//       per-family and free: wet ground takes a DEEPER, STRONGER stamp
//       (`mudStampFor`) and the shader scales the dent + darkening by the same
//       wetness (`uMudPrintDryScale`). A dry-dirt print is therefore faint and
//       is erased by the shared fade almost immediately in APPEARANCE, while
//       the same fade leaves a rain-soaked print reading for its whole life.
//       That is the observable the plan asked for, obtained from a knob this
//       family already owns rather than from a second render target.
//   (c) CO-TENANCY IS EXPLICIT. Snow and mud read the SAME map through the SAME
//       sampler (see `pushMudTrailUniforms`), each with its own float gate, so
//       whichever fade the URL carries, both families keep working and neither
//       silently disables the other.
//
// INJECTED THREE (the `terrain_vfx.js` / `trail_map.js` / `terrain_scatter.js`
// idiom). This module imports no three: `initTerrainDirt({THREE, ...})` takes
// it, and every GPU object is optional — with no THREE the providers still run
// their full CPU bookkeeping. That is what keeps `test_terrain_dirt.mjs` a pure
// node test and what makes `?nullRender=1` free.
//
// INVARIANTS (plan §5). A HOST module, not a registered VFX component, so
// `vfx/lint_caps.js` does not sweep it — its test runs `lintSource` over this
// file anyway. It reads static terrain, a server-derived player position, the
// shared clock, the shared wind and the derived client weather; it writes only
// its own buffers and uniforms. It adds NO light (§5.2), varies no program cache
// key (§5.4 — one material per field, no per-instance key), uses no
// `Math.random` (§5.5), binds the clock BY REFERENCE (§5.6) and sets
// `castShadow = false` (§5.7 — added geometry is paid twice).
//
// FLAGS (plan §2.4, all STRICT `=== "on"` opt-ins that ship OFF):
//   ?terrainDirt          family master (puffs + prints + wetness + haze)
//   ?terrainFootfall      ?terrainMudPrints   ?terrainMudWetness
//   ?terrainDustHaze      ?terrainDirtDustCount  ?terrainDirtRadius
//   ?terrainDirtDustDensity  ?terrainFootfallPuffs
//   (?terrainVfx=off, ?visual=off and ?wireframe=1 each kill all of it.)

import {
  FAM_DIRT,
  TERRAIN_CODE_COUNT,
  familyForCode,
} from "./terrain_families.js";
import { createScatterPool, SCATTER_FADE_GLSL, scatterHash01 } from "./terrain_scatter.js";
import { registerTerrainVfx, unregisterTerrainVfx, lbKeyFromXY, wireframeActive } from "./terrain_vfx.js";
import {
  terrainDirtEnabled,
  terrainFootfallEnabled,
  terrainMudPrintsEnabled,
  terrainMudWetnessEnabled,
  terrainDustHazeEnabled,
  terrainDirtDustCount,
  terrainDirtRadiusM,
  terrainDirtDustDensity,
  terrainFootfallPuffCount,
  terrainTrailEnabled,
  terrainTrailRecoverySec,
  terrainTrailFadeSource,
  TRAIL_FAMILY_FADE_SEC,
} from "./vfx_flags.js";

/** Provider ids — also the `VFX_EFFECT_FLAGS` router rows. */
export const FOOTFALL_PROVIDER_ID = "terrain.footfall";
export const MUD_PRINT_PROVIDER_ID = "terrain.mudPrints";
export const DUST_HAZE_PROVIDER_ID = "terrain.dirtDust";

/**
 * The trail fade MUD asks for: the plan's "slow recovery (~30 s)" (§3.7 item 2).
 * See decision (a) in the header — it is a URL number, not a second constant in
 * the map.
 */
export const MUD_RECOMMENDED_FADE_SEC = TRAIL_FAMILY_FADE_SEC.mudPrints;
/** Below this, a mud print flashes and vanishes (grass springback) — warn. */
export const MUD_SHORT_FADE_WARN_SEC = 10;
/** Above this, mud prints are effectively permanent (snow's 300 s) — note. */
export const MUD_LONG_FADE_NOTE_SEC = 120;

/**
 * The footstep SoundTable enum values the notify in `entities.js::_fireHook`
 * matches: `Sound.Footstep1 = 0x37`, `Sound.Footstep2 = 0x38`
 * (`external/ACE/Source/ACE.Entity/Enum/Sound.cs`). Exported so the test can
 * assert the two sides agree rather than trusting a literal in each file.
 */
export const FOOTSTEP_SOUND_ENUMS = Object.freeze([0x37, 0x38]);

// ---------------------------------------------------------------------------
// Pure helpers + the per-code sub-variant table. No THREE, no window.
// ---------------------------------------------------------------------------

/**
 * The per-code sub-variant table (plan §1.3: "sub-variants that matter to a
 * family's tuning are a per-code parameter table INSIDE the family module, not
 * a separate family"). Keyed by TERRAIN CODE — never by name and never by
 * texture (plan §2.7.2: retail SHARES one RenderSurface across BarrenRock (0),
 * Argila (24) and DesolateLands (31), which straddle two families here).
 *
 *   puff   the dust colour a footfall throws, linear RGB.
 *   dust   how much dust there IS to throw, 0..1 (packed/desolate ground is
 *          loose and dry; mud-rich ground barely puffs at all).
 *   print  print depth/strength multiplier — soft ground takes a deeper print.
 *   haze   dry-dust-haze density weight, 0..1. `DesolateLands` is the bias the
 *          plan asks for (§3.7 item 3: "DesolateLands biased").
 *   clay   true ⇒ this code gets the redder, slicker wet treatment (Argila).
 */
export const DIRT_VARIANTS = Object.freeze({
  // MudRichDirt — the wet end of the family. Almost nothing to kick up, but it
  // takes the deepest print and goes the darkest in rain.
  5: Object.freeze({ puff: [0.34, 0.27, 0.20], dust: 0.25, print: 1.25, haze: 0.15, clay: false }),
  // PackedDirt — road dirt. Hard underfoot but powdered on top: the best puff.
  7: Object.freeze({ puff: [0.52, 0.44, 0.33], dust: 1.0, print: 0.7, haze: 0.6, clay: false }),
  // PatchyDirt — the family reference.
  8: Object.freeze({ puff: [0.47, 0.40, 0.30], dust: 0.8, print: 0.9, haze: 0.5, clay: false }),
  // Argila — clay. Redder, and the slickest of the five once it is wet.
  24: Object.freeze({ puff: [0.55, 0.36, 0.26], dust: 0.55, print: 1.15, haze: 0.35, clay: true }),
  // DesolateLands — the driest. THE haze bias (plan §3.7 item 3).
  31: Object.freeze({ puff: [0.50, 0.45, 0.36], dust: 1.0, print: 0.6, haze: 1.0, clay: false }),
});

/** The terrain codes that are FAM_DIRT, DERIVED from the family LUT. */
export function dirtTerrainCodes() {
  const out = [];
  for (let c = 0; c < TERRAIN_CODE_COUNT; c += 1) {
    if (familyForCode(c) === FAM_DIRT) out.push(c);
  }
  return out;
}

/** The same set as a GPU bitmask (the `computeCodeBitmask` convention). */
export function dirtCodeBitmask() {
  let mask = 0;
  for (const c of dirtTerrainCodes()) mask |= (1 << c);
  return mask >>> 0;
}

/**
 * The CLAY codes: the FAM_DIRT members whose sub-variant row says `clay: true`
 * — i.e. 24 (`Argila`) alone. Derived rather than written out, so the family LUT
 * stays the single source of truth for membership and this table stays the
 * single source of truth for which members are clay (the `iceTerrainCodes()`
 * shape from wave 2A).
 */
export function clayTerrainCodes() {
  return dirtTerrainCodes().filter((c) => DIRT_VARIANTS[c] && DIRT_VARIANTS[c].clay === true);
}

/** The clay set as a GPU bitmask. A STRICT SUBSET of `dirtCodeBitmask()`. */
export function clayCodeBitmask() {
  let mask = 0;
  for (const c of clayTerrainCodes()) mask |= (1 << c);
  return mask >>> 0;
}

/** Tuning that is NOT worth a URL flag. */
export const DIRT_TUNING = Object.freeze({
  // --- footfall puffs ------------------------------------------------------
  // A puff is a BURST that dies fast: seconds of life, metres of radius at
  // birth and at death, and how far it drifts up while it does it.
  puffLifeSec: 0.85,
  puffLifeJitter: 0.35,          // +-35% per puff
  puffRadiusStartM: 0.14,
  puffRadiusEndM: 0.62,
  puffRiseM: 0.42,
  puffLiftM: 0.06,               // spawn height above the ground sample
  puffOpacity: 0.34,
  // Wind pushes a puff downwind as it rises (the shared vector, not a fork).
  puffWindDrift: 0.55,
  // Rate limiting. A footfall hook can fire twice per gait cycle per entity and
  // a crowded landblock has many entities; these are the guards that keep the
  // ring buffer from being a churn machine.
  puffMinIntervalSec: 0.11,      // per entity
  puffMaxPerFrame: 4,
  puffMaxDistanceM: 42,          // beyond this from the player, do not bother
  // A footfall hook fires on the ANIMATION, not on contact, so a jumping or
  // flying entity can fire one well off the ground. Reject those.
  puffMaxGroundGapM: 1.5,
  // Rain lays the dust: no puff at all once the world is this wet.
  puffWetCutoff: 0.55,

  // --- mud prints ----------------------------------------------------------
  // Wider than snow's 0.42 m: mud squelches out sideways under a boot, and the
  // shared map is coarse enough (0.375 m/texel at the defaults) that a tighter
  // blob would be sub-texel anyway.
  stampRadiusM: 0.55,
  // Strength at bone-dry vs soaked. THE rain-dependent persistence knob — see
  // decision (b) in the header.
  stampStrengthDry: 0.35,
  stampStrengthWet: 1.0,

  // --- dry dust haze -------------------------------------------------------
  // A haze SHEET, not a streamer: long, wide, low and slow, so it reads as a
  // ground-hugging veil rather than as individual moving objects.
  hazeLengthM: 3.4,
  hazeWidthM: 1.35,
  hazeLengthJitter: 0.45,
  hazeLiftMinM: 0.05,
  hazeLiftMaxM: 0.85,
  hazeAdvectSpeed: 2.1,          // slower than sand (3.2) and snow (5.4)
  hazeAdvectSpanM: 26,
  hazePulseFreq: 0.045,          // cycles per metre (~22 m banks)
  hazePulseScrollHz: 0.05,
  hazePulseThreshold: 0.42,
  hazeColour: [0.46, 0.39, 0.30],
  hazeOpacity: 0.09,
  // Dryness response. Haze is a DRY-HEAT effect: rain kills it outright and a
  // cold day barely lifts any.
  hazeWetKill: 0.35,             // wetness at which the haze is fully gone
  hazeWarmC: 22,                 // full strength at/above this air temperature
  hazeColdC: 4,                  // nothing below this
});

/**
 * Resolve the live DIRT quality tier. `null` ⇒ the whole family is disabled at
 * this tier (plan §5.8: "`low` is null/disabled for every effect here without
 * exception"). Pure in `flags`.
 *
 * @param {object|null} flags `liveScene3d.quality.flags`-shaped bag.
 * @returns {{footfall:boolean, prints:boolean, wetness:boolean,
 *   dustCount:number, radiusM:number}|null}
 */
export function resolveDirtQuality(flags) {
  const num = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);
  const footfall = flags?.terrainFootfall === true;
  const prints = flags?.terrainMudPrints === true;
  const wetness = flags?.terrainMudWetness === true;
  const dustCount = Math.max(0, Math.round(num(flags?.terrainDirtDustCount, 0)));
  const radiusM = Math.min(512, Math.max(8, num(flags?.terrainDirtRadius, 56)));
  if (!footfall && !prints && !wetness && dustCount === 0) return null;
  return { footfall, prints, wetness, dustCount, radiusM };
}

/**
 * The shared wind vector in AC ground coordinates (+X east, +Y north).
 *
 * `VFX_GLOBALS.uWindDir` is a `Vector2` holding the THREE-space ground wind
 * `(x, z)` (`vfx/weather_inputs.js::writeWindVector`), and three `z` is AC `-y`
 * — so the conversion is `(w.x, -w.y)`. It is bound BY REFERENCE and written
 * once per frame by `loop.js::tickVfxWeatherInputs`; never snapshot it.
 *
 * DUPLICATED from `terrain_snow.js::windAcFromGlobals` (which duplicated
 * `terrain_sand.js`) for the reason recorded there: `terrain_sand.js` imports
 * `vfx/components/terrainDustDevil.js`, which calls `registerComponent` AT
 * IMPORT TIME, so importing a sibling family for six lines of arithmetic would
 * register a foreign component descriptor in every dirt session.
 *
 * @param {{uWindDir?:{value:{x:number,y:number}}}|null} globals VFX_GLOBALS
 * @param {{x:number,y:number}} out zero-alloc target
 */
export function windAcFromGlobals(globals, out) {
  const o = out || { x: 0, y: 0 };
  const v = globals && globals.uWindDir ? globals.uWindDir.value : null;
  if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) {
    o.x = v.x;
    o.y = -v.y;
    if (o.x !== 0 || o.y !== 0) return o;
  }
  // 135 degrees = SE, the tree_wind default (`tree_wind.js:53 treeWindDir`).
  o.x = Math.cos((135 * Math.PI) / 180);
  o.y = Math.sin((135 * Math.PI) / 180);
  return o;
}

/**
 * THE wetness driver, 0..1 — plan §3.7 item 4 ("read `getWeatherInputs()
 * .wetness`; do not re-derive from `weather/rain.js`").
 *
 * `VFX_GLOBALS.uWetness` is preferred and `env.wetness` is the fallback: they
 * are THE SAME NUMBER from the same producer — `weather_inputs.js
 * ::tickWeatherInputs` writes `VFX_GLOBALS.uWetness.value = _st.wetness` and
 * `vfx/particle_env.js::readParticleEnv` copies `getWeatherInputs().wetness` —
 * so preferring the uniform costs nothing and keeps the terrain agreeing with
 * every `weathering.wetness` material in the scene to the last bit.
 *
 * THE LAG IS NOT OURS. `weather_inputs.js` already applies the `WET_TAU`
 * exponential approach, with `dt = Infinity` on the first frame so boot snaps
 * and a clamped `dt` so a tab resume does not spike. This function adds NO
 * smoothing of its own; that is the documented lag the plan's test asks about.
 *
 * @param {{uWetness?:{value:number}}|null} globals VFX_GLOBALS
 * @param {{wetness?:number}|null} env `readParticleEnv` snapshot
 * @returns {number} 0..1
 */
export function mudWetnessFrom(globals, env) {
  const raw = globals && globals.uWetness && Number.isFinite(globals.uWetness.value)
    ? globals.uWetness.value
    : (env && Number.isFinite(env.wetness) ? env.wetness : 0);
  return Math.min(1, Math.max(0, raw));
}

/**
 * Trail stamp parameters for a mud print at the live wetness — decision (b) in
 * the header. PURE, and the only place the rain-dependent persistence lives.
 *
 * @param {number} wetness 0..1
 * @param {number} [printMul] the per-code `DIRT_VARIANTS.print` multiplier
 * @returns {{radiusM:number, strength:number}}
 */
export function mudStampFor(wetness, printMul) {
  const w = Number.isFinite(wetness) ? Math.min(1, Math.max(0, wetness)) : 0;
  const m = Number.isFinite(printMul) && printMul > 0 ? printMul : 1;
  const strength = Math.min(
    1,
    (DIRT_TUNING.stampStrengthDry
      + (DIRT_TUNING.stampStrengthWet - DIRT_TUNING.stampStrengthDry) * w) * m,
  );
  // Wet mud spreads: the blob widens with the water, up to +25 %.
  return { radiusM: DIRT_TUNING.stampRadiusM * (1 + 0.25 * w), strength };
}

/**
 * Should a footfall at this ground sample throw a puff, and what colour?
 * PURE — the whole "puff colour follows the sampled code / no puff on a
 * water or ice code" contract of the plan's test lives here.
 *
 * @param {{code:number}|null} sample the oracle sample under the foot
 * @param {number} wetness 0..1 — rain lays the dust
 * @returns {{keep:boolean, colour:number[], dust:number, code:number}}
 */
export function puffForGround(sample, wetness) {
  const code = sample && Number.isFinite(sample.code) ? (sample.code | 0) : -1;
  const out = { keep: false, colour: [0, 0, 0], dust: 0, code };
  // FAMILY FIRST (plan §2.7.2 — never key off the texture). Water, ice, grass,
  // rock and swamp all fall out here, which is the test's "no puff on a
  // water/ice code".
  if (code < 0 || familyForCode(code) !== FAM_DIRT) return out;
  const v = DIRT_VARIANTS[code];
  if (!v) return out;
  const w = Number.isFinite(wetness) ? Math.min(1, Math.max(0, wetness)) : 0;
  if (w >= DIRT_TUNING.puffWetCutoff) return out;   // soaked ground does not puff
  const wetFade = 1 - (w / DIRT_TUNING.puffWetCutoff);
  const dust = v.dust * wetFade;
  if (!(dust > 0.02)) return out;
  out.keep = true;
  out.colour = v.puff.slice();
  out.dust = dust;
  return out;
}

/**
 * The dry-dust-haze intensity, 0..1 — plan §3.7 item 3 ("wind-lifted dry dust").
 * PURE. Dust is a DRY-HEAT effect: rain lays it and cold air does not lift it.
 *
 * @param {{wetness?:number, temperatureC?:number}|null} env
 * @returns {number} 0..1
 */
export function dustHazeIntensity(env) {
  if (!env) return 0.5;                     // no weather at all ⇒ a middling veil
  const wet = Number.isFinite(env.wetness) ? Math.min(1, Math.max(0, env.wetness)) : 0;
  const dry = 1 - Math.min(1, wet / DIRT_TUNING.hazeWetKill);
  if (dry <= 0) return 0;
  const tC = Number.isFinite(env.temperatureC) ? env.temperatureC : 15;
  const warm = Math.min(1, Math.max(0,
    (tC - DIRT_TUNING.hazeColdC) / (DIRT_TUNING.hazeWarmC - DIRT_TUNING.hazeColdC)));
  return dry * warm;
}

/**
 * Puff advection — the offset (metres, AC frame) and radius of one puff at age
 * `age` seconds. A PURE function of (wind, age, life): no frame history, no
 * `Math.random`. The GLSL in `DIRT_PUFF_VERTEX_GLSL` computes exactly this
 * expression, so the JS is both the test oracle and the readable spec.
 *
 * @param {number} windX AC east component
 * @param {number} windY AC north component
 * @param {number} age   seconds since the puff was emitted
 * @param {number} life  the puff's lifetime in seconds
 * @param {{x:number,y:number,z:number,r:number,a:number}} [out]
 */
export function puffState(windX, windY, age, life, out) {
  const o = out || { x: 0, y: 0, z: 0, r: 0, a: 0 };
  const L = Number.isFinite(life) && life > 0 ? life : DIRT_TUNING.puffLifeSec;
  const t = Number.isFinite(age) ? age : 0;
  if (t < 0 || t > L) { o.x = 0; o.y = 0; o.z = 0; o.r = 0; o.a = 0; return o; }
  const n = t / L;                       // normalised age, 0..1
  o.x = windX * DIRT_TUNING.puffWindDrift * t;
  o.y = windY * DIRT_TUNING.puffWindDrift * t;
  // Rises fast then eases — sqrt, not linear: a real puff decelerates.
  o.z = DIRT_TUNING.puffRiseM * Math.sqrt(n);
  o.r = DIRT_TUNING.puffRadiusStartM
      + (DIRT_TUNING.puffRadiusEndM - DIRT_TUNING.puffRadiusStartM) * n;
  // Fast fade-in (a puff APPEARS), long fade-out.
  const fadeIn = Math.min(1, n / 0.12);
  const fadeOut = (1 - n) * (1 - n);
  o.a = fadeIn * fadeOut;
  return o;
}

// ---------------------------------------------------------------------------
// The footfall puff field — GLSL. Kept as exported strings so the shader test
// can assert on them without a GPU (the `terrain.js` / `terrain_snow.js`
// convention).
//
// NO BACKTICKS anywhere in this GLSL, including comments: a stray backtick
// closes the JS template literal (this has bitten `terrain.js` twice).
// ---------------------------------------------------------------------------

export const DIRT_PUFF_VERTEX_GLSL = `
precision highp float;

// Per-instance (written by the ring buffer below).
attribute vec4 aPuff;      // (x, y, z) AC world origin, w = birth time (uTime)
attribute vec4 aPuffCfg;   // (life, dust, seed01, unused)
attribute vec3 aPuffColour;

uniform float uTime;       // the SHARED clock, bound by reference (plan 5.6)
uniform vec2  uWindAc;     // AC ground wind (+X east, +Y north), live
uniform float uRiseM;
uniform float uDrift;
uniform float uRadiusStart;
uniform float uRadiusEnd;

varying vec2 vQuadUv;
varying float vAlpha;
varying vec3 vColour;

void main() {
  // --- the JS twin of everything below is terrain_dirt.js::puffState --------
  float life = max(aPuffCfg.x, 1e-3);
  float age = uTime - aPuff.w;
  float n = age / life;
  // A dead or unborn slot collapses to a degenerate point: one vertex
  // invocation and zero area, the same contract terrain_scatter.js uses for a
  // rejected instance. No branch on gl_Position, no discard cost.
  float alive = step(0.0, age) * step(n, 1.0) * step(0.001, aPuffCfg.y);

  vec3 origin = aPuff.xyz;
  origin.xy += uWindAc * (uDrift * age);
  origin.z += uRiseM * sqrt(max(n, 0.0));

  float radius = mix(uRadiusStart, uRadiusEnd, clamp(n, 0.0, 1.0)) * alive;

  float fadeIn = clamp(n / 0.12, 0.0, 1.0);
  float fadeOut = (1.0 - clamp(n, 0.0, 1.0)) * (1.0 - clamp(n, 0.0, 1.0));
  vAlpha = fadeIn * fadeOut * aPuffCfg.y * alive;
  vColour = aPuffColour;
  vQuadUv = uv;

  // CAMERA-FACING BILLBOARD: offset in VIEW space after the origin has been
  // transformed, so the quad needs no orientation of its own and the parent
  // group's rotation (worldRoot is AC space) is irrelevant.
  vec4 mv = modelViewMatrix * vec4(origin, 1.0);
  // A slow per-puff spin off the seed, so two puffs never read as the same
  // sprite. Deterministic: seed only, no clock, no rand.
  float rot = aPuffCfg.z * 6.2831853;
  float cs = cos(rot);
  float sn = sin(rot);
  vec2 q = vec2(position.x * cs - position.y * sn, position.x * sn + position.y * cs);
  mv.xy += q * radius;
  gl_Position = projectionMatrix * mv;
}
`;

export const DIRT_PUFF_FRAGMENT_GLSL = `
precision highp float;

uniform float uOpacity;

varying vec2 vQuadUv;
varying float vAlpha;
varying vec3 vColour;

void main() {
  // A soft round puff with a slightly hollow core, which is what a real dust
  // burst looks like: the rim carries the light, the middle is thin.
  vec2 d = vQuadUv * 2.0 - 1.0;
  float r = length(d);
  float disc = 1.0 - smoothstep(0.35, 1.0, r);
  float a = disc * vAlpha * uOpacity;
  if (a <= 0.0) discard;
  gl_FragColor = vec4(vColour, a);
}
`;

// ---------------------------------------------------------------------------
// The dry dust haze — GLSL. Structurally the sand/snow streamer with slower,
// wider, lower, browner parameters and an alpha (not additive) blend: dust
// OCCLUDES, it does not glow.
// ---------------------------------------------------------------------------

export const DIRT_HAZE_VERTEX_GLSL = `
precision highp float;

attribute vec3 aOffset;    // AC world position of the anchor (x, y, z=ground+lift)
attribute vec2 aScale;     // (length, width) in metres
attribute vec4 aDrift;     // (phase01, speedMul, hazeWeight, alpha)

uniform float uTime;
uniform vec2  uWindAc;
uniform float uSpanM;
uniform float uSpeed;
uniform float uPulseFreq;
uniform float uPulseScroll;
uniform float uPulseThreshold;
uniform float uDryness;    // 0..1 from dustHazeIntensity()

varying vec2 vQuadUv;
varying float vAlpha;

${SCATTER_FADE_GLSL}

float dirtHash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float dirtNoise2D(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = dirtHash21(i);
  float b = dirtHash21(i + vec2(1.0, 0.0));
  float c = dirtHash21(i + vec2(0.0, 1.0));
  float d = dirtHash21(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

void main() {
  float wl = max(length(uWindAc), 1e-4);
  vec2 dir = uWindAc / wl;
  vec2 side = vec2(-dir.y, dir.x);
  float travelled = uTime * uSpeed * aDrift.y * wl + aDrift.x * uSpanM;
  float s = mod(travelled, uSpanM) - uSpanM * 0.5;
  vec2 adv = dir * s;

  float along = position.x * aScale.x;
  vec2 local2 = adv + dir * along + side * (position.y * aScale.y);
  vec3 local = vec3(local2, 0.0);

  // instanceMatrix carries the anchor translation AND the pool 0/1 live scale,
  // so a degenerate (wrong-family / unbaked / out-of-range) instance collapses
  // to a point and is zero-area for this material too.
  vec4 placed = instanceMatrix * vec4(local, 1.0);

  // Wide, slow banks of haze rather than discrete streaks.
  vec2 pulseXy = placed.xy * uPulseFreq + dir * (uTime * uPulseScroll);
  float n = dirtNoise2D(pulseXy);
  float pulse = smoothstep(uPulseThreshold, 1.0, n);

  float fade = hbScatterFade(placed.xy);

  vAlpha = pulse * fade * aDrift.w * clamp(uDryness, 0.0, 1.0);
  vQuadUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(placed.xyz, 1.0);
}
`;

export const DIRT_HAZE_FRAGMENT_GLSL = `
precision highp float;

uniform vec3 uColour;
uniform float uOpacity;

varying vec2 vQuadUv;
varying float vAlpha;

void main() {
  // A very soft sheet: no hard edge anywhere, or a haze quad reads as a card.
  vec2 c = abs(vQuadUv * 2.0 - 1.0);
  float along = 1.0 - c.x;
  float across = 1.0 - c.y;
  float mask = pow(max(along, 0.0), 1.6) * pow(max(across, 0.0), 1.6);
  float a = mask * vAlpha * uOpacity;
  if (a <= 0.0) discard;
  gl_FragColor = vec4(uColour, a);
}
`;

/** The per-instance attribute schema the pool allocates for the haze field. */
export const DIRT_HAZE_SCHEMA = Object.freeze([
  { name: "aOffset", itemSize: 3 },
  { name: "aScale", itemSize: 2 },
  { name: "aDrift", itemSize: 4 },
]);

/** The per-instance attribute schema of the footfall ring buffer. */
export const DIRT_PUFF_SCHEMA = Object.freeze([
  { name: "aPuff", itemSize: 4 },
  { name: "aPuffCfg", itemSize: 4 },
  { name: "aPuffColour", itemSize: 3 },
]);

// ---------------------------------------------------------------------------
// The footfall puff ring buffer (THREE optional).
// ---------------------------------------------------------------------------

function _quadGeometry(THREE, name) {
  // A unit quad, centred, with uv — built by hand rather than with
  // PlaneGeometry so the winding and the uv are explicit.
  const geom = new THREE.BufferGeometry();
  const pos = new Float32Array([
    -0.5, -0.5, 0,
    0.5, -0.5, 0,
    0.5, 0.5, 0,
    -0.5, 0.5, 0,
  ]);
  const uv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geom.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geom.setIndex([0, 1, 2, 0, 2, 3]);
  geom.name = name;
  return geom;
}

/**
 * Create the footfall puff field: a fixed-capacity RING BUFFER, not a scatter
 * pool. Puffs are EVENTS at arbitrary world points, so the world-anchored slot
 * grid `terrain_scatter.js` owns would be exactly the wrong structure — the
 * pool's job is "cover a moving window evenly", and this one's is "hold the
 * last N bursts". Everything else (injected THREE, degenerate-instance
 * discipline, determinism, castShadow=false) follows the same rules.
 *
 * @param {object} opts
 * @param {object} [opts.THREE]   injected; omit for a headless CPU-only field.
 * @param {object} [opts.parent]  Object3D to hang the mesh off (AC space).
 * @param {object} [opts.globals] VFX_GLOBALS (uTime + uWindDir, BY REFERENCE).
 * @param {number} [opts.capacity]
 * @param {number} [opts.seed]
 */
export function createPuffField(opts = {}) {
  const THREE = opts.THREE || null;
  const capacity = Math.max(1, Math.round(
    Number.isFinite(opts.capacity) ? opts.capacity : 48));
  const seed = (Number.isFinite(opts.seed) ? opts.seed : 0x3d17b00b) | 0;
  const globals = opts.globals || null;
  const tuning = { ...DIRT_TUNING, ...(opts.tuning || {}) };

  // CPU-side buffers — allocated ONCE, here. Steady state allocates nothing.
  const aPuff = new Float32Array(capacity * 4);
  const aPuffCfg = new Float32Array(capacity * 4);
  const aPuffColour = new Float32Array(capacity * 3);

  // THE CLOCK IS BOUND BY IDENTITY (plan §5.6, the `test_vfx_glint.mjs`
  // assertion): when VFX_GLOBALS is injected we ADOPT its `uTime` object rather
  // than minting a clone, exactly as `glint.js::declareUniforms` does.
  // `_ownsClock` records whether we may write it — writing an adopted
  // VFX_GLOBALS.uTime would fight `loop.js::tickVfxOscillators`.
  const _sharedTime = globals && globals.uTime && typeof globals.uTime === "object"
    ? globals.uTime
    : null;
  const _ownsClock = _sharedTime === null;
  const uniforms = {
    uTime: _sharedTime || { value: 0 },
    uWindAc: { value: null },
    uRiseM: { value: tuning.puffRiseM },
    uDrift: { value: tuning.puffWindDrift },
    uRadiusStart: { value: tuning.puffRadiusStartM },
    uRadiusEnd: { value: tuning.puffRadiusEndM },
    uOpacity: { value: tuning.puffOpacity },
  };

  let geometry = null;
  let material = null;
  let mesh = null;
  let attrPuff = null;
  let attrCfg = null;
  let attrColour = null;

  if (THREE && typeof THREE.ShaderMaterial === "function"
      && typeof THREE.InstancedMesh === "function") {
    try {
      geometry = _quadGeometry(THREE, "dirt-puff");
      attrPuff = new THREE.InstancedBufferAttribute(aPuff, 4);
      attrCfg = new THREE.InstancedBufferAttribute(aPuffCfg, 4);
      attrColour = new THREE.InstancedBufferAttribute(aPuffColour, 3);
      for (const a of [attrPuff, attrCfg, attrColour]) {
        if (a && typeof a.setUsage === "function" && THREE.DynamicDrawUsage !== undefined) {
          a.setUsage(THREE.DynamicDrawUsage);
        }
      }
      geometry.setAttribute("aPuff", attrPuff);
      geometry.setAttribute("aPuffCfg", attrCfg);
      geometry.setAttribute("aPuffColour", attrColour);
      uniforms.uWindAc.value = new THREE.Vector2(1, 0);
      material = new THREE.ShaderMaterial({
        vertexShader: DIRT_PUFF_VERTEX_GLSL,
        fragmentShader: DIRT_PUFF_FRAGMENT_GLSL,
        uniforms,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        // NORMAL, not additive: dust scatters light, it does not emit. An
        // additive puff would glow at night, which is the tell of a fake one.
        blending: THREE.NormalBlending,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      material.name = "terrain-dirt-puff";
      mesh = new THREE.InstancedMesh(geometry, material, capacity);
      mesh.name = "terrain-dirt-puff";
      mesh.castShadow = false;      // §5.7 — added geometry is paid twice
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;   // the field follows the player
      mesh.renderOrder = 3;
      if (opts.parent && typeof opts.parent.add === "function") opts.parent.add(mesh);
    } catch (_) {
      geometry = null;
      material = null;
      mesh = null;
    }
  }

  const wind = { x: 0, y: 0 };
  const state = { cursor: 0, emitted: 0, dropped: 0, frames: 0, live: 0, counter: 0 };

  function _markDirty() {
    if (attrPuff) attrPuff.needsUpdate = true;
    if (attrCfg) attrCfg.needsUpdate = true;
    if (attrColour) attrColour.needsUpdate = true;
  }

  /**
   * Emit one puff. Deterministic: the per-puff jitter is a hash of the
   * QUANTISED world position and a monotone event counter — never `Math.random`
   * (§5.5), so a replayed event stream reproduces the field exactly.
   *
   * @returns {boolean} was a slot written?
   */
  function emit(x, y, z, tSec, colour, dust) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
    if (!(dust > 0)) { state.dropped += 1; return false; }
    const i = state.cursor % capacity;
    state.cursor = (state.cursor + 1) % capacity;
    state.counter += 1;
    const qx = Math.round(x * 4) | 0;
    const qy = Math.round(y * 4) | 0;
    const h1 = scatterHash01(qx, qy, state.counter, seed);
    const h2 = scatterHash01(qy, state.counter, qx, seed ^ 0x51ed270b);
    const life = tuning.puffLifeSec * (1 + (h1 - 0.5) * 2 * tuning.puffLifeJitter);
    aPuff[i * 4] = x;
    aPuff[i * 4 + 1] = y;
    aPuff[i * 4 + 2] = z + tuning.puffLiftM;
    aPuff[i * 4 + 3] = Number.isFinite(tSec) ? tSec : 0;
    aPuffCfg[i * 4] = Math.max(0.05, life);
    aPuffCfg[i * 4 + 1] = Math.min(1, Math.max(0, dust));
    aPuffCfg[i * 4 + 2] = h2;
    aPuffCfg[i * 4 + 3] = 0;
    const c = colour || [0.5, 0.42, 0.32];
    aPuffColour[i * 3] = c[0];
    aPuffColour[i * 3 + 1] = c[1];
    aPuffColour[i * 3 + 2] = c[2];
    state.emitted += 1;
    _markDirty();
    return true;
  }

  /** Per-frame: refresh the live uniforms and recount the living puffs. */
  function update(dt, tSec) {
    state.frames += 1;
    windAcFromGlobals(globals, wind);
    if (_ownsClock) uniforms.uTime.value = Number.isFinite(tSec) ? tSec : 0;
    const wv = uniforms.uWindAc.value;
    if (wv) { wv.x = wind.x; wv.y = wind.y; }
    const t = Number.isFinite(tSec) ? tSec : uniforms.uTime.value;
    let live = 0;
    for (let i = 0; i < capacity; i += 1) {
      const life = aPuffCfg[i * 4];
      if (!(life > 0)) continue;
      const age = t - aPuff[i * 4 + 3];
      if (age >= 0 && age <= life && aPuffCfg[i * 4 + 1] > 0) live += 1;
    }
    state.live = live;
    return live;
  }

  return {
    uniforms,
    capacity,
    /** false ⇒ `uniforms.uTime` IS `VFX_GLOBALS.uTime` (bound by identity). */
    ownsClock: _ownsClock,
    get mesh() { return mesh; },
    get material() { return material; },
    get geometry() { return geometry; },
    /** Raw buffers — the test seam (read-only by convention). */
    buffers: { aPuff, aPuffCfg, aPuffColour },
    emit,
    update,
    /** The CPU twin of the shader, for diagnostics and tests. */
    stateOf(index, tSec, out) {
      const i = ((index | 0) % capacity + capacity) % capacity;
      windAcFromGlobals(globals, wind);
      const age = (Number.isFinite(tSec) ? tSec : 0) - aPuff[i * 4 + 3];
      const s = puffState(wind.x, wind.y, age, aPuffCfg[i * 4], out);
      s.x += aPuff[i * 4];
      s.y += aPuff[i * 4 + 1];
      s.z += aPuff[i * 4 + 2];
      s.a *= aPuffCfg[i * 4 + 1];
      return s;
    },
    dispose() {
      if (mesh && mesh.parent && typeof mesh.parent.remove === "function") {
        try { mesh.parent.remove(mesh); } catch (_) { /* fail-soft */ }
      }
      if (mesh && typeof mesh.dispose === "function") { try { mesh.dispose(); } catch (_) {} }
      mesh = null;
      if (geometry) { try { geometry.dispose(); } catch (_) {} geometry = null; }
      if (material) { try { material.dispose(); } catch (_) {} material = null; }
      attrPuff = attrCfg = attrColour = null;
    },
    stats() {
      return {
        built: !!mesh,
        capacity,
        frames: state.frames,
        emitted: state.emitted,
        dropped: state.dropped,
        live: state.live,
        cursor: state.cursor,
        wind: { x: wind.x, y: wind.y },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The dry dust haze field (THREE optional). Built on the shared scatter pool.
// ---------------------------------------------------------------------------

/**
 * Create the camera-scoped dry-dust haze field.
 *
 * @param {object} opts
 * @param {object} [opts.THREE]    injected; omit for a headless CPU-only field.
 * @param {object} [opts.parent]   Object3D to hang the mesh off (AC space).
 * @param {object|Function} opts.oracle the terrain oracle, or a GETTER (use the
 *   getter form: `ctx.oracle` / `frameCtx.oracle` is LIVE and must never be
 *   stashed — wave-0 handoff §5).
 * @param {object} [opts.globals]  VFX_GLOBALS (uTime + uWindDir, BY REFERENCE).
 * @param {number} [opts.count]
 * @param {number} [opts.radiusM]
 * @param {number} [opts.seed]
 */
export function createDustHazeField(opts = {}) {
  const THREE = opts.THREE || null;
  const count = Math.max(1, Math.round(Number.isFinite(opts.count) ? opts.count : 800));
  const radiusM = Math.min(512, Math.max(8, Number.isFinite(opts.radiusM) ? opts.radiusM : 56));
  const seed = (Number.isFinite(opts.seed) ? opts.seed : 0x3d17b00b) | 0;
  const globals = opts.globals || null;
  const tuning = { ...DIRT_TUNING, ...(opts.tuning || {}) };

  let geometry = null;
  let material = null;

  // THE UNIFORM BAG. Built FIRST and handed to the ShaderMaterial AND to the
  // pool via `opts.uniforms` (wave 2A), so the pool publishes its four
  // distance-blend uniforms straight into the bag the compiled shader already
  // holds — no placeholder-then-repoint dance.
  const _sharedTime = globals && globals.uTime && typeof globals.uTime === "object"
    ? globals.uTime
    : null;
  const _ownsClock = _sharedTime === null;
  const uniforms = {
    uTime: _sharedTime || { value: 0 },
    uWindAc: { value: null },
    uSpanM: { value: tuning.hazeAdvectSpanM },
    uSpeed: { value: tuning.hazeAdvectSpeed },
    uPulseFreq: { value: tuning.hazePulseFreq },
    uPulseScroll: { value: tuning.hazePulseScrollHz },
    uPulseThreshold: { value: tuning.hazePulseThreshold },
    uDryness: { value: 1 },
    uColour: { value: null },
    uOpacity: { value: tuning.hazeOpacity },
    // Adopted + populated by the pool below (never placeholders to re-point).
    uScatterCenter: { value: null },
    uScatterRadius: { value: radiusM },
    uScatterFadeStart: { value: radiusM * 0.75 },
    uScatterShape: { value: 0 },
  };

  const wind = { x: 0, y: 0 };

  if (THREE && typeof THREE.ShaderMaterial === "function") {
    try {
      geometry = _quadGeometry(THREE, "dirt-haze");
      uniforms.uWindAc.value = new THREE.Vector2(1, 0);
      uniforms.uColour.value = new THREE.Color(
        tuning.hazeColour[0], tuning.hazeColour[1], tuning.hazeColour[2],
      );
      uniforms.uScatterCenter.value = new THREE.Vector3(0, 0, 0);
      material = new THREE.ShaderMaterial({
        vertexShader: DIRT_HAZE_VERTEX_GLSL,
        fragmentShader: DIRT_HAZE_FRAGMENT_GLSL,
        uniforms,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        // Alpha, not additive — see the puff material for the reasoning.
        blending: THREE.NormalBlending,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      material.name = "terrain-dirt-haze";
    } catch (_) {
      geometry = null;
      material = null;
    }
  }

  const pool = createScatterPool({
    THREE,
    name: "terrain-dirt-haze",
    count,
    radiusM,
    seed,
    // Salted so a haze quad and a grass blade (or a sand streak, or a snow
    // ribbon) that land in the SAME world cell do not draw the same jitter.
    randSalt: 0x3b,
    shape: "disc",
    fadeFraction: 0.3,
    jitter: 1,
    families: [FAM_DIRT],
    attributes: DIRT_HAZE_SCHEMA.map((a) => ({ ...a })),
    uniforms,
    // DesolateLands BIAS (plan §3.7 item 3). Rejected quads are written
    // degenerate (zero-area), i.e. one vertex invocation and nothing else.
    accept(sample, ctx) {
      const v = DIRT_VARIANTS[ctx.code];
      const weight = v ? v.haze : 0;
      if (!(weight > 0)) return false;
      return ctx.rand(9) < weight;
    },
    fill(ctx) {
      const lift = tuning.hazeLiftMinM + ctx.rand(3) * (tuning.hazeLiftMaxM - tuning.hazeLiftMinM);
      ctx.z += lift;
      const lenJ = 1 + (ctx.rand(4) - 0.5) * 2 * tuning.hazeLengthJitter;
      ctx.set("aScale", tuning.hazeLengthM * lenJ, tuning.hazeWidthM);
      const v = DIRT_VARIANTS[ctx.code];
      const weight = v ? v.haze : 0;
      ctx.set(
        "aDrift",
        ctx.rand(5),                       // advection phase
        0.7 + ctx.rand(6) * 0.6,           // per-quad speed multiplier
        weight,                            // published for diagnosis
        (0.55 + ctx.rand(8) * 0.45) * ctx.fade * weight,
      );
    },
    oracle: opts.oracle,
    geometry,
    material,
    parent: opts.parent || null,
    writeInstanceMatrix: true,   // the shader reads instanceMatrix (see the GLSL)
    frustumCulled: false,        // the window follows the player
  });

  let mesh = pool.mesh || null;
  if (mesh) {
    mesh.name = "terrain-dirt-haze";
    mesh.castShadow = false;      // §5.7
    mesh.receiveShadow = false;
    mesh.renderOrder = 2;
  }

  const state = { frames: 0, lastRescattered: 0, dryness: 1, built: !!mesh };

  return {
    pool,
    uniforms,
    ownsClock: _ownsClock,
    get mesh() { return mesh; },
    get material() { return material; },
    get geometry() { return geometry; },
    update(dt, tSec, px, py, pz, dryness) {
      state.frames += 1;
      windAcFromGlobals(globals, wind);
      if (_ownsClock) uniforms.uTime.value = Number.isFinite(tSec) ? tSec : 0;
      const wv = uniforms.uWindAc.value;
      if (wv) { wv.x = wind.x; wv.y = wind.y; }
      state.dryness = Number.isFinite(dryness) ? Math.min(1, Math.max(0, dryness)) : 1;
      uniforms.uDryness.value = state.dryness;
      state.lastRescattered = pool.update(dt, px, py, pz);
      return state.lastRescattered;
    },
    dispose() {
      try { pool.dispose(); } catch (_) { /* fail-soft */ }
      mesh = null;
      if (geometry) { try { geometry.dispose(); } catch (_) {} geometry = null; }
      if (material) { try { material.dispose(); } catch (_) {} material = null; }
    },
    stats() {
      return {
        built: !!mesh,
        frames: state.frames,
        lastRescattered: state.lastRescattered,
        dryness: state.dryness,
        wind: { x: wind.x, y: wind.y },
        pool: pool.stats(),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The mud-print / wetness uniform push. THE bridge between `trail_map.js`
// (which owns the render target), `VFX_GLOBALS.uWetness` (which owns the rain)
// and the terrain fragment shader (which owns the dent, the darkening and the
// sheen). Exported and pure-ish so the test can drive it with fakes.
// ---------------------------------------------------------------------------

/**
 * Push the trail map's live state AND the live wetness onto every terrain
 * ShaderMaterial.
 *
 * WHY A PER-FRAME PUSH and not a bind-once: (a) the trail map PING-PONGS its
 * render target, swapping `uTrailMap.value` in place every frame, (b) landblock
 * materials are baked continuously, long after the map was constructed, (c) the
 * map may not exist at all, and (d) `terrain_batch.js::_buildBatchMaterial`
 * CLONES every uniform VALUE onto the batched material, so a by-reference
 * binding would silently freeze on the `?terrainBatch=on` path (the wave-2B
 * crack-glow lesson). This is the same shape as `loop.js::tickTerrainUTime`,
 * `IblEnvironment.tick` and `terrain_snow.js::pushSnowTrailUniforms`, all of
 * which walk `scene3d.terrainMaterials` — and that array carries the batched
 * material too (`terrain_batch.js:447`), so one loop covers both terrain paths.
 *
 * ⚠ THE TRAIL SAMPLER IS SHARED AND ITS NAME IS A WAVE-2A ARTEFACT. There is
 * ONE trail map and ONE `sampler2D` for it in the terrain shader, and wave 2A
 * landed first, so it is called `uSnowTrailMap`. Renaming it now would be a
 * cross-family churn edit for zero behaviour change, and adding a second
 * sampler is exactly what the wave-2A sampler-budget ruling forbids (15 of a
 * guaranteed 16 are already bound). So mud writes the SAME sampler, centre and
 * radius, and gates itself with its OWN float (`uMudTrailEnabled`) — snow's
 * `uSnowTrailEnabled` stays snow's. Both families may run at once; they write
 * identical values into the shared entries, so the write order does not matter.
 *
 * With `trail` null every material is driven to `uMudTrailEnabled = 0` — the
 * ABSENT-MAP contract (grass precedent): no lazy-ensure, no error, no print.
 *
 * @param {Array<object>|null} materials `scene3d.terrainMaterials`
 * @param {object|null} trail the `trail_map.js` handle, or null
 * @param {number} wetness 0..1 (`mudWetnessFrom`)
 * @returns {number} materials touched
 */
export function pushMudTrailUniforms(materials, trail, wetness) {
  if (!Array.isArray(materials) || materials.length === 0) return 0;
  const tu = trail && trail.uniforms ? trail.uniforms : null;
  const tex = tu && tu.uTrailMap ? tu.uTrailMap.value : null;
  const cx = tu && tu.uTrailCenter && tu.uTrailCenter.value ? tu.uTrailCenter.value.x : 0;
  const cy = tu && tu.uTrailCenter && tu.uTrailCenter.value ? tu.uTrailCenter.value.y : 0;
  const radius = tu && tu.uTrailRadius && Number.isFinite(tu.uTrailRadius.value)
    ? tu.uTrailRadius.value : 48;
  const on = tex ? 1 : 0;
  const wet = Number.isFinite(wetness) ? Math.min(1, Math.max(0, wetness)) : 0;
  let touched = 0;
  for (const mat of materials) {
    const u = mat && mat.uniforms;
    if (!u || !u.uMudTrailEnabled) continue;   // pre-Wave-3B material: skip
    if (tex && u.uSnowTrailMap) u.uSnowTrailMap.value = tex;
    if (tex) {
      const c = u.uSnowTrailCenter ? u.uSnowTrailCenter.value : null;
      // Written componentwise rather than with .set(): the batched material's
      // clone is a real Vector2, but a headless/stub material may carry a plain
      // {x, y} and this path must not care.
      if (c) { c.x = cx; c.y = cy; }
      if (u.uSnowTrailRadius) u.uSnowTrailRadius.value = radius;
    }
    u.uMudTrailEnabled.value = on;
    if (u.uMudWetness) u.uMudWetness.value = wet;
    touched += 1;
  }
  return touched;
}

// ---------------------------------------------------------------------------
// Module state + the three providers.
// ---------------------------------------------------------------------------

let _dirt = null;       // the init record, or null

const _stats = {
  inits: 0,
  puffBuilds: 0,
  hazeBuilds: 0,
  footfalls: 0,
  footfallsRejected: 0,
  puffs: 0,
  stamps: 0,
  stampsDropped: 0,
  pushFrames: 0,
  materialsTouched: 0,
  noTrail: 0,
};

function _envSnapshot() {
  if (!_dirt || typeof _dirt.readEnv !== "function") return null;
  try { return _dirt.readEnv(_dirt.scene3d) || null; } catch (_) { return null; }
}

function _terrainMaterials() {
  if (!_dirt) return null;
  try {
    const s = _dirt.scene3d;
    if (Array.isArray(s?.terrainMaterials)) return s.terrainMaterials;
    if (typeof window !== "undefined" && Array.isArray(window.liveScene3d?.terrainMaterials)) {
      return window.liveScene3d.terrainMaterials;
    }
  } catch (_) { /* fail-soft */ }
  return null;
}

/**
 * THE footfall entry point — the function `entities.js::_fireHook` calls when a
 * `Sound.Footstep1/2` SoundTable hook fires (plan §3.7 item 1). Installed as
 * `scene3d.onTerrainFootfall` on all three facades by `installFootfallHook`.
 *
 * Everything here is a REJECT-EARLY ladder, because this runs on an audio hot
 * path: no field ⇒ out, too soon after this entity's last step ⇒ out, too far
 * from the player ⇒ out, budget spent ⇒ out, no oracle ⇒ out, not FAM_DIRT ⇒
 * out, airborne ⇒ out. Only then does a puff get written.
 *
 * @param {number} guid the entity that stepped (rate limiting is per entity)
 * @param {number} x AC world x
 * @param {number} y AC world y
 * @param {number} z AC world z (the entity origin, i.e. its feet)
 * @returns {boolean} was a puff emitted?
 */
export function terrainFootfall(guid, x, y, z) {
  if (!_dirt || !_dirt.puffs) return false;
  _stats.footfalls += 1;
  const tSec = _dirt.lastTSec;
  const key = guid >>> 0;
  const last = _dirt.lastStepAt.get(key);
  if (last !== undefined && tSec - last < DIRT_TUNING.puffMinIntervalSec) {
    _stats.footfallsRejected += 1;
    return false;
  }
  if (_dirt.frameEmits >= DIRT_TUNING.puffMaxPerFrame) {
    _stats.footfallsRejected += 1;
    return false;
  }
  if (_dirt.hasPlayer) {
    const dx = x - _dirt.playerX;
    const dy = y - _dirt.playerY;
    if (dx * dx + dy * dy > DIRT_TUNING.puffMaxDistanceM * DIRT_TUNING.puffMaxDistanceM) {
      _stats.footfallsRejected += 1;
      return false;
    }
  }
  const oracle = _dirt.oracleRef();
  let sample = null;
  try {
    sample = oracle && typeof oracle.sample === "function" ? oracle.sample(x, y) : null;
  } catch (_) { sample = null; }
  if (!sample) { _stats.footfallsRejected += 1; return false; }
  const ground = Number.isFinite(sample.height) ? sample.height : z;
  // A footfall hook fires on the ANIMATION, not on contact: a jumping or
  // levitating entity still cycles its gait. Reject anything well off grade.
  if (Math.abs(z - ground) > DIRT_TUNING.puffMaxGroundGapM) {
    _stats.footfallsRejected += 1;
    return false;
  }
  const p = puffForGround(sample, _dirt.wetness);
  if (!p.keep) { _stats.footfallsRejected += 1; return false; }
  _dirt.lastStepAt.set(key, tSec);
  _dirt.frameEmits += 1;
  if (_dirt.puffs.emit(x, y, ground, tSec, p.colour, p.dust)) {
    _stats.puffs += 1;
    return true;
  }
  return false;
}

/**
 * Install `onTerrainFootfall` on every facade, the `terrain_batch.js:548
 * _installHooksOn` discipline: `scene3d`, `scene3d.landblockLru.scene3d` and
 * `window.liveScene3d` can be three different objects, and `entities.js` holds
 * whichever one it was constructed with.
 *
 * @returns {number} facades touched
 */
export function installFootfallHook(scene3d, fn) {
  let n = 0;
  const targets = [];
  if (scene3d) targets.push(scene3d);
  try {
    const lru = scene3d && scene3d.landblockLru ? scene3d.landblockLru.scene3d : null;
    if (lru && !targets.includes(lru)) targets.push(lru);
  } catch (_) { /* fail-soft */ }
  try {
    if (typeof window !== "undefined" && window.liveScene3d
        && !targets.includes(window.liveScene3d)) {
      targets.push(window.liveScene3d);
    }
  } catch (_) { /* fail-soft */ }
  for (const t of targets) {
    try {
      if (t.onTerrainFootfall !== fn) { t.onTerrainFootfall = fn; }
      n += 1;
    } catch (_) { /* fail-soft */ }
  }
  return n;
}

function _footfallProvider() {
  return {
    id: FOOTFALL_PROVIDER_ID,
    families: [FAM_DIRT],
    scope: "camera",
    enabled() { return terrainDirtEnabled() && terrainFootfallEnabled(); },
    quality(flags) {
      const q = resolveDirtQuality(flags);
      return q && q.footfall ? q : null;
    },
    update(dt, frameCtx) {
      if (!_dirt) return;
      // Re-assert the facade hook every frame for the same reason the spine
      // re-asserts its own: `terrain_batch.js` re-installs BARE function
      // properties on absorb, and a facade can be swapped in late.
      installFootfallHook(_dirt.scene3d, terrainFootfall);
      if (!_dirt.puffs) {
        _dirt.puffs = createPuffField({
          THREE: _dirt.THREE,
          parent: _dirt.parent,
          globals: _dirt.globals,
          capacity: terrainFootfallPuffCount(),
          seed: _dirt.seed,
        });
        _stats.puffBuilds += 1;
      }
      _dirt.frameEmits = 0;
      _dirt.puffs.update(dt, frameCtx ? frameCtx.tSec : 0);
    },
    dispose() {
      if (_dirt && _dirt.puffs) { _dirt.puffs.dispose(); _dirt.puffs = null; }
    },
  };
}

function _mudPrintProvider() {
  return {
    id: MUD_PRINT_PROVIDER_ID,
    families: [FAM_DIRT],
    scope: "camera",
    enabled() {
      return terrainDirtEnabled()
        && (terrainMudPrintsEnabled() || terrainMudWetnessEnabled());
    },
    quality(flags) {
      const q = resolveDirtQuality(flags);
      return q && (q.prints || q.wetness) ? q : null;
    },
    update(dt, frameCtx) {
      if (!_dirt) return;
      const trail = frameCtx ? frameCtx.trail : null;
      const materials = _terrainMaterials();
      const wet = _dirt.wetness;
      if (!trail) {
        _stats.noTrail += 1;
        // ABSENT MAP ⇒ drive the trail gate OFF, but STILL push the wetness:
        // the sheen/darkening is a weather effect and does not need a trail
        // map. No lazy-ensure — the map is `?terrainTrail=on`'s to build,
        // exactly as grass stomp and snow prints have it.
        if (materials) _stats.materialsTouched += pushMudTrailUniforms(materials, null, wet);
        return;
      }
      // PLAYER-ONLY stamps, the grass/snow limitation: there is no cheap
      // accessor for other creatures' ground positions in the per-frame path.
      // (A footfall EVENT does carry one — see `terrainFootfall` — so a
      // creature-track follow-up is contained, but it is not this wave's.)
      if (frameCtx.hasPlayer && terrainMudPrintsEnabled() && typeof trail.stamp === "function") {
        const p = frameCtx.playerPos;
        const s = mudStampFor(wet, _dirt.lastPrintMul);
        if (trail.stamp(p.x, p.y, s.radiusM, s.strength)) _stats.stamps += 1;
        else _stats.stampsDropped += 1;
      }
      if (materials) {
        _stats.pushFrames += 1;
        _stats.materialsTouched += pushMudTrailUniforms(materials, trail, wet);
      }
    },
    dispose() {
      // Leave no mud uniform live on a material that outlives us.
      const materials = _terrainMaterials();
      if (materials) pushMudTrailUniforms(materials, null, 0);
    },
  };
}

function _dustHazeProvider() {
  return {
    id: DUST_HAZE_PROVIDER_ID,
    families: [FAM_DIRT],
    scope: "camera",
    enabled() { return terrainDirtEnabled() && terrainDustHazeEnabled(); },
    quality(flags) {
      const q = resolveDirtQuality(flags);
      return q && q.dustCount > 0 ? q : null;
    },
    update(dt, frameCtx) {
      if (!_dirt) return;
      if (!frameCtx || !frameCtx.hasPlayer) return;
      // `frameCtx.oracle` is a LIVE getter on the spine (wave-0 handoff §5) —
      // read it every frame, never stash it. The pool holds a GETTER for the
      // same reason, so a field built before the oracle resolved comes alive.
      if (!_dirt.haze) {
        const q = resolveDirtQuality(frameCtx.quality);
        const tierCount = q && q.dustCount > 0 ? q.dustCount : terrainDirtDustCount();
        const count = Math.round(tierCount * terrainDirtDustDensity());
        if (count <= 0) return;
        _dirt.haze = createDustHazeField({
          THREE: _dirt.THREE,
          parent: _dirt.parent,
          globals: _dirt.globals,
          oracle: () => (_dirt ? _dirt.oracleRef() : null),
          count,
          radiusM: (q && q.radiusM) || terrainDirtRadiusM(),
          seed: _dirt.seed,
        });
        _stats.hazeBuilds += 1;
      }
      const p = frameCtx.playerPos;
      _dirt.haze.update(dt, frameCtx.tSec, p.x, p.y, p.z, dustHazeIntensity(_dirt.env));
    },
    dispose() {
      if (_dirt && _dirt.haze) { _dirt.haze.dispose(); _dirt.haze = null; }
    },
  };
}

/**
 * The once-per-frame shared read: the smoothed weather env and the wetness the
 * three providers all want. Registered as its OWN provider so the env is read
 * exactly once per frame no matter how many of the three are live, and so the
 * puff path (which runs OUTSIDE the tick, on an audio hook) always has a fresh
 * player position and clock to reject against.
 */
function _stateProvider() {
  return {
    id: "terrain.dirtState",
    families: [FAM_DIRT],
    scope: "camera",
    enabled() { return terrainDirtEnabled(); },
    quality(flags) { return resolveDirtQuality(flags); },
    update(dt, frameCtx) {
      if (!_dirt || !frameCtx) return;
      _dirt.env = _envSnapshot();
      _dirt.wetness = mudWetnessFrom(_dirt.globals, _dirt.env);
      _dirt.lastTSec = Number.isFinite(frameCtx.tSec) ? frameCtx.tSec : _dirt.lastTSec;
      _dirt.hasPlayer = !!frameCtx.hasPlayer;
      if (frameCtx.hasPlayer) {
        _dirt.playerX = frameCtx.playerPos.x;
        _dirt.playerY = frameCtx.playerPos.y;
        // The per-code print multiplier under the player, for the stamp. One
        // oracle sample per frame; null (unbaked LB) keeps the last value.
        try {
          const oracle = _dirt.oracleRef();
          const s = oracle && typeof oracle.sample === "function"
            ? oracle.sample(frameCtx.playerPos.x, frameCtx.playerPos.y) : null;
          const v = s && Number.isFinite(s.code) ? DIRT_VARIANTS[s.code | 0] : null;
          _dirt.lastPrintMul = v ? v.print : 1;
        } catch (_) { /* keep the last value */ }
      }
    },
  };
}

/**
 * Construct + register the DIRT/MUD family. Called once from `scene3d/index.js`
 * right after `initTerrainVolcano` (the spine must exist first — providers are
 * replayed onto the already-resident ring by `registerTerrainVfx`).
 *
 * Returns `null` — registering nothing, allocating nothing — when the master is
 * off, so a bare-default boot is byte-identical.
 *
 * @param {object} opts
 * @param {object} [opts.THREE]    the three namespace (injected).
 * @param {object} opts.scene3d    the live facade.
 * @param {object} [opts.parent]   Object3D for the puff/haze meshes; defaults to
 *   `terrainGroup.parent` (worldRoot) — a SIBLING of terrainGroup with the same
 *   transform, so the fields are in AC space and the LRU's terrainGroup scans
 *   cannot take them.
 * @param {object} [opts.globals]  VFX_GLOBALS (uTime/uWindDir/uWetness, BY REF).
 * @param {Function} [opts.readEnv] `vfx/particle_env.js::readParticleEnv`
 *   (injected so this module stays THREE-free).
 * @param {Function} [opts.getOracle] override for the terrain oracle.
 */
export function initTerrainDirt(opts = {}) {
  const scene3d = opts.scene3d || null;
  if (wireframeActive(opts.search)) return null;   // plan §8 risk 8
  if (!terrainDirtEnabled()) return null;          // ship-OFF master (plan §5.9)

  const footfallOn = terrainFootfallEnabled();
  const printsOn = terrainMudPrintsEnabled();
  const wetOn = terrainMudWetnessEnabled();
  const hazeOn = terrainDustHazeEnabled();

  _dirt = {
    THREE: opts.THREE || null,
    scene3d,
    parent: opts.parent || scene3d?.terrainGroup?.parent || null,
    globals: opts.globals || null,
    readEnv: typeof opts.readEnv === "function" ? opts.readEnv : null,
    seed: Number.isFinite(opts.seed) ? opts.seed | 0 : 0x3d17b00b,
    puffs: null,
    haze: null,
    env: null,
    wetness: 0,
    lastTSec: 0,
    lastPrintMul: 1,
    hasPlayer: false,
    playerX: 0,
    playerY: 0,
    frameEmits: 0,
    lastStepAt: new Map(),
    registered: [],
    oracleRef: typeof opts.getOracle === "function"
      ? opts.getOracle
      : () => {
        try {
          return (typeof window !== "undefined" && window.__terrainVfx)
            ? window.__terrainVfx.oracle
            : null;
        } catch (_) { return null; }
      },
  };
  _stats.inits += 1;

  if (printsOn) {
    // The two things that make a print silently not appear, said ONCE and
    // loudly — the `gfx_relief.js:137` rule (a silent no-op is
    // indistinguishable from a broken decode).
    if (terrainTrailEnabled() !== true) {
      // eslint-disable-next-line no-console
      console.warn(
        "[terrainMudPrints] ?terrainMudPrints=on but the shared trail map is "
        + "NOT enabled — only an EXPLICIT ?terrainTrail=off can reach this now "
        + "(mud prints otherwise imply the map). Nothing will be drawn.",
      );
    } else {
      const fade = terrainTrailRecoverySec();
      if (Number.isFinite(fade) && fade < MUD_SHORT_FADE_WARN_SEC) {
        // eslint-disable-next-line no-console
        console.warn(
          `[terrainMudPrints] the shared trail recovery is ${fade}s — an EXPLICIT `
          + `?terrainTrailFade beats mud's ${MUD_RECOMMENDED_FADE_SEC}s claim, so prints `
          + `will flash and vanish. Drop the flag (or set ?terrainTrailFade=${MUD_RECOMMENDED_FADE_SEC}). `
          + "The map is family-agnostic and has ONE fade — see the trail-fade decision in "
          + "scene3d/terrain_dirt.js.",
        );
      } else if (Number.isFinite(fade) && fade > MUD_LONG_FADE_NOTE_SEC) {
        // eslint-disable-next-line no-console
        console.warn(
          `[terrainMudPrints] the shared trail recovery is ${fade}s (a snow-tuned fade). `
          + `Mud prints will be effectively PERMANENT; mud asks for `
          + `?terrainTrailFade=${MUD_RECOMMENDED_FADE_SEC}. Legitimate when snow prints `
          + "share the session — the map has ONE fade for every family.",
        );
      }
    }
  }
  if (hazeOn && terrainDirtDustCount() <= 0) {
    // "I turned the flag on and nothing happened" is exactly the silence
    // `gfx_relief.js:137` argues against, and at low/mid the tier ships
    // `terrainDirtDustCount: 0`. Say so once; the fix is a one-line URL.
    // eslint-disable-next-line no-console
    console.warn(
      "[terrainDustHaze] ?terrainDustHaze=on but the resolved haze count is 0 "
      + "(quality low/mid ship terrainDirtDustCount: 0). Raise it with "
      + "?terrainDirtDustCount=N or use ?quality=high or higher.",
    );
  }

  // The state provider runs whenever the master is on — the other three read
  // its per-frame snapshot, and the footfall hook needs it even in a session
  // where only the fragment-shader half of the family is live.
  _dirt.registered.push(registerTerrainVfx(_stateProvider()));
  if (footfallOn) {
    _dirt.registered.push(registerTerrainVfx(_footfallProvider()));
    installFootfallHook(scene3d, terrainFootfall);
  }
  if (printsOn || wetOn) _dirt.registered.push(registerTerrainVfx(_mudPrintProvider()));
  if (hazeOn && terrainDirtDustCount() > 0) {
    _dirt.registered.push(registerTerrainVfx(_dustHazeProvider()));
  }
  return terrainDirtSurface();
}

/** Diagnostics — mirrored onto `window.__terrainDirt` by `scene3d/index.js`. */
export function terrainDirtStats() {
  const on = terrainDirtEnabled();
  return {
    enabled: on,
    footfall: on && terrainFootfallEnabled(),
    prints: on && terrainMudPrintsEnabled(),
    wetness: on && terrainMudWetnessEnabled(),
    dustHaze: on && terrainDustHazeEnabled(),
    trailFlag: terrainTrailEnabled(),
    trailFadeSec: terrainTrailRecoverySec(),
    // WHERE the live fade came from: "family" ⇒ this module's own claim won,
    // "url" ⇒ an explicit ?terrainTrailFade beat it, "preset" ⇒ the tier is longer.
    trailFadeSource: terrainTrailFadeSource(),
    recommendedFadeSec: MUD_RECOMMENDED_FADE_SEC,
    inited: !!_dirt,
    dirtCodes: dirtTerrainCodes(),
    dirtCodeMask: dirtCodeBitmask(),
    clayCodes: clayTerrainCodes(),
    clayCodeMask: clayCodeBitmask(),
    liveWetness: _dirt ? _dirt.wetness : 0,
    dryness: dustHazeIntensity(_dirt ? _dirt.env : null),
    // THE live-check fields (mirroring __terrainSand.field /
    // __terrainSnow.visibleRibbons): non-zero means the effect actually landed.
    livePuffs: _dirt && _dirt.puffs ? _dirt.puffs.stats().live : 0,
    visibleHaze: _dirt && _dirt.haze ? _dirt.haze.pool.stats().live : 0,
    puffs: _dirt && _dirt.puffs ? _dirt.puffs.stats() : null,
    haze: _dirt && _dirt.haze ? _dirt.haze.stats() : null,
    counters: { ..._stats },
  };
}

function terrainDirtSurface() {
  return {
    stats: terrainDirtStats,
    get puffs() { return _dirt ? _dirt.puffs : null; },
    get haze() { return _dirt ? _dirt.haze : null; },
    /** Manual puff trigger for the 1070 eye-test (same path the hook takes). */
    footfall: terrainFootfall,
    lbKeyFromXY,
  };
}

/** Test seam — unregister every provider and drop all state. */
export function _resetTerrainDirt() {
  if (_dirt) {
    for (const h of _dirt.registered) {
      try { unregisterTerrainVfx(h.id); } catch (_) {}
    }
    if (_dirt.puffs) { try { _dirt.puffs.dispose(); } catch (_) {} }
    if (_dirt.haze) { try { _dirt.haze.dispose(); } catch (_) {} }
  }
  _dirt = null;
  for (const k of Object.keys(_stats)) _stats[k] = 0;
}
