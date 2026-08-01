// scene3d/terrain_snow.js — SNOW / ICE terrain VFX (Wave 2A).
//
// Design plan: `docs/2026-07-31-terrain-vfx-plan.md` §3.4. Terrain codes 2
// (`Ice`), 15 (`Snow`) and 27 (`BlueIce`) = `FAM_SNOWICE` — derived from
// `terrain_families.js`, never hardcoded here (plan §8 risk 12: family
// membership is a property of the CODE, and another region could name the same
// code differently).
//
// THE LOOK (plan §3.4). Snow is ALIVE: spindrift ribbons blowing off crests,
// sun-glitter that twinkles as the camera moves, footprints that persist. Ice
// (2) and BlueIce (27) instead read hard and wet: sharp specular, low
// roughness, a hint of refractive depth.
//
// FOUR EFFECTS, THREE OWNERS:
//   1. SPINDRIFT RIBBONS — here. A camera-scoped instanced ribbon field built
//      on `terrain_scatter.js` (the shared pool: placement, residency, family
//      gating, amortisation), additively blended, riding the SAME shared wind
//      vector sand and grass ride, and SLOPE-BIASED: ribbons lift where the
//      ground tilts past `?terrainSnowSlope`, because that is where real
//      spindrift comes off. Intensifies while it is snowing, read from the
//      injected weather env.
//   2. CRYSTAL SPARKLE — in the TERRAIN FRAGMENT SHADER (`terrain.js`, search
//      `SNOW CRYSTAL SPARKLE`), gated on FAM_SNOWICE read from `uVertexTypes`
//      (plan trap T3 — the subdiv path IGNORES the `terrainCode` geometry
//      attribute), sited after the POM `cellUv` offset and bypassed on any
//      water-touching cell (plan §2.7.3). NOT in this file; this file owns its
//      flag and nothing else about it.
//   3. FOOTPRINTS — split: `trail_map.js` (wave 0B) owns the render target, the
//      terrain fragment shader owns the dent + the darkening, and THIS file
//      owns the STAMP and the per-frame uniform push that connects them.
//   4. ICE MATERIAL — terrain fragment shader again (`ICE MATERIAL TREATMENT`),
//      codes 2/27 only. This file owns the per-code table that says WHICH
//      members of the family are ice, and its flag.
//   (GROUND MIST IN HOLLOWS, plan §3.4 item 5, is deliberately NOT implemented:
//   it is the shared `ground_fog.js` that wave 3A owns. FALLING SNOW is
//   `scene3d/weather/snow.js` + `weather/manager.js` and is never duplicated
//   here — this family is the GROUND.)
//
// ── THE TRAIL-RT DECISION (plan §8 risk 7, deferred to this wave) ──────────
// **No second, higher-resolution trail render target. Snow reuses the shared
// one.** The four reasons, in the order that decided it:
//
//   (a) THE SAMPLER BUDGET. The terrain fragment shader already binds 14
//       samplers; the print adds the 15th. WebGL2's guaranteed minimum for
//       MAX_TEXTURE_IMAGE_UNITS is 16, and SwiftShader reports exactly 16. A
//       second map would sit on that floor with nothing left for wave 2B's
//       crack glow or wave 3B's mud.
//   (b) THE RESOLUTION/EXTENT TRADEOFF IS ALREADY A URL BISECT.
//       `?terrainTrailRes` (128..2048) and `?terrainTrailRadius` (4..512 m) are
//       shipped knobs with preset ladders. A second RT would hardcode ONE point
//       on that curve; the knobs reach every point, including the sharp-print
//       regime — `?terrainTrailRes=512&terrainTrailRadius=32` is 0.125 m/texel,
//       where an individual dent resolves. There is nothing a second map can do
//       that two URL params cannot.
//   (c) RECOVERY = INFINITY IS ALREADY TRUE ENOUGH, and this is the argument
//       that would otherwise have forced a second map. The plan asks for
//       `recovery = infinity` for snow while grass wants 4 s, and the map has
//       ONE fade constant. But the map's EXTENT bounds a print's life long
//       before its fade does: crossing a 96 m map at a ~4 m/s run takes ~24 s,
//       after which the print has scrolled out of the footprint and is gone
//       whatever the fade said. So `?terrainTrailFade=300` (the clamp ceiling)
//       is pixel-identical to a true infinity for any print still ON the map.
//       `SNOW_RECOMMENDED_FADE_SEC` below is that number, and
//       `initTerrainSnow` warns once when the live fade is short — the
//       `gfx_relief.js:137` rule: never be silently wrong.
//   (d) COST vs BUDGET. The plan budgets "prints ~= 0". A second 512² R8
//       ping-pong pair is ~0.5 MB plus a second full-target pass every frame,
//       for a sharpness the (b) knobs already deliver.
//
// If the 1070 eye-test says prints read as mush even at
// `?terrainTrailRes=512&terrainTrailRadius=32`, the second map is a CONTAINED
// follow-up: `trail_map.js::createTrailMap` is already a factory and this
// module already owns the only stamp and the only uniform push.
//
// INJECTED THREE (the `terrain_vfx.js` / `trail_map.js` / `terrain_scatter.js`
// idiom). This module imports no three: `initTerrainSnow({THREE, ...})` takes
// it, and every GPU object is optional — with no THREE the providers still run
// their full CPU bookkeeping. That is what keeps `test_terrain_snow.mjs` a
// pure-node test and what makes `?nullRender=1` free.
//
// INVARIANTS (plan §5). A HOST module, not a registered VFX component, so
// `vfx/lint_caps.js` does not sweep it — its test runs `lintSource` over this
// file anyway. It reads static terrain, a server-derived player position, the
// shared clock, the shared wind and the derived client weather; it writes only
// its own buffers and uniforms. It adds NO light (§5.2), varies no program
// cache key (§5.4 — one material, no per-instance key), uses no `Math.random`
// (§5.5), binds the clock and the wind BY REFERENCE (§5.6) and sets
// `castShadow = false` (§5.7 — added geometry is paid twice).
//
// FLAGS (plan §2.4, all STRICT `=== "on"` opt-ins that ship OFF):
//   ?terrainSnow            family master (spindrift + sparkle + prints)
//   ?terrainSnowSpindrift   ?terrainSnowSparkle   ?terrainSnowPrints
//   ?terrainIce             ?terrainIceRefraction   (a SEPARATE master)
//   ?terrainSnowSpindriftCount  ?terrainSnowRadius  ?terrainSnowSlope
//   (?terrainVfx=off, ?visual=off and ?wireframe=1 each kill all of it.)

import {
  FAM_SNOWICE,
  TERRAIN_CODE_COUNT,
  familyForCode,
} from "./terrain_families.js";
import { createScatterPool, SCATTER_FADE_GLSL } from "./terrain_scatter.js";
import { registerTerrainVfx, unregisterTerrainVfx, lbKeyFromXY, wireframeActive } from "./terrain_vfx.js";
import {
  terrainSnowEnabled,
  terrainSnowSpindriftEnabled,
  terrainSnowSparkleEnabled,
  terrainSnowPrintsEnabled,
  terrainIceEnabled,
  terrainIceRefractionEnabled,
  terrainSnowSpindriftCount,
  terrainSnowRadiusM,
  terrainSnowSlopeBias,
  terrainTrailEnabled,
  terrainTrailRecoverySec,
} from "./vfx_flags.js";

/** Provider ids — also the `VFX_EFFECT_FLAGS` router rows. */
export const SPINDRIFT_PROVIDER_ID = "terrain.snowSpindrift";
export const PRINT_PROVIDER_ID = "terrain.snowPrints";

/**
 * The trail fade snow asks for. 300 s is the `trail_map.js` clamp ceiling and,
 * per decision (c) in the header, is pixel-identical to a true infinity: the
 * map's 2R extent scrolls a print out of existence in ~24 s of running long
 * before a 300 s linear fade removes 8 % of it.
 */
export const SNOW_RECOMMENDED_FADE_SEC = 300;

/** Below this live `?terrainTrailFade`, prints visibly melt — warn (see above). */
export const SNOW_SHORT_FADE_WARN_SEC = 30;

// ---------------------------------------------------------------------------
// Pure helpers + the per-code sub-variant table. No THREE, no window.
// ---------------------------------------------------------------------------

/**
 * The per-code sub-variant table (plan §1.3: "sub-variants that matter to a
 * family's tuning are a per-code parameter table INSIDE the family module, not
 * a separate family"). Keyed by TERRAIN CODE — never by name and never by
 * texture (plan §2.7.2 / §8 risk 12).
 *
 *   ice    true ⇒ this code gets the hard/wet MATERIAL treatment (roughness
 *          down, sharper specular, env term, fake refraction). 15 `Snow` is
 *          matte and must never get it — that is the whole 2/27-vs-15 split.
 *   drift  relative spindrift density, 0..1. Ice sheds far less than powder:
 *          there is nothing loose on it to lift.
 *   tint   ribbon colour multiplier. BlueIce throws a cold, faintly blue veil.
 */
export const SNOWICE_VARIANTS = Object.freeze({
  // Ice — hard, wet, almost nothing to blow off it.
  2: Object.freeze({ ice: true, drift: 0.15, tint: [0.92, 0.96, 1.0] }),
  // Snow — the powder reference. Everything spindrift is tuned against.
  15: Object.freeze({ ice: false, drift: 1.0, tint: [1.0, 1.0, 1.0] }),
  // BlueIce — hard like 2, but a colder cast on what little it does shed.
  27: Object.freeze({ ice: true, drift: 0.2, tint: [0.82, 0.9, 1.0] }),
});

/** The terrain codes that are FAM_SNOWICE, DERIVED from the family LUT. */
export function snowTerrainCodes() {
  const out = [];
  for (let c = 0; c < TERRAIN_CODE_COUNT; c += 1) {
    if (familyForCode(c) === FAM_SNOWICE) out.push(c);
  }
  return out;
}

/** The same set as a GPU bitmask (the `computeCodeBitmask` convention). */
export function snowCodeBitmask() {
  let mask = 0;
  for (const c of snowTerrainCodes()) mask |= (1 << c);
  return mask >>> 0;
}

/**
 * The ICE MATERIAL codes: the FAM_SNOWICE members whose sub-variant row says
 * `ice: true` — i.e. 2 and 27, never 15. Derived rather than written out, so
 * the family LUT stays the single source of truth for membership and this table
 * stays the single source of truth for which members are ice.
 */
export function iceTerrainCodes() {
  return snowTerrainCodes().filter((c) => SNOWICE_VARIANTS[c] && SNOWICE_VARIANTS[c].ice === true);
}

/** The ice set as a GPU bitmask. A STRICT SUBSET of `snowCodeBitmask()`. */
export function iceCodeBitmask() {
  let mask = 0;
  for (const c of iceTerrainCodes()) mask |= (1 << c);
  return mask >>> 0;
}

/** Tuning that is NOT worth a URL flag. */
export const SNOW_TUNING = Object.freeze({
  // Ribbon geometry, metres. HIGHER-FREQUENCY than a sand streamer (plan
  // §3.4 item 1): shorter, narrower, and many more of them per metre of wind.
  ribbonLengthM: 1.5,
  ribbonWidthM: 0.13,
  ribbonLengthJitter: 0.55,        // ±55% per instance
  // Lift above the ground. Spindrift hugs the surface harder than sand does —
  // it is snow being scraped off a crest, not a sheet in suspension.
  liftMinM: 0.03,
  liftMaxM: 0.28,
  // Advection. Faster than sand (5.4 vs 3.2 m/s per unit wind) over a SHORTER
  // recycle span, which is what "higher-frequency" means in motion.
  advectSpeed: 5.4,
  advectSpanM: 17,
  // The lateral serpentine that makes a ribbon a ribbon rather than a streak:
  // radians of sideways travel per metre of ribbon length, and its rate.
  waveAmpM: 0.22,
  waveFreq: 0.9,
  waveHz: 0.55,
  // The pulse field: gusts of drift form and dissolve. Tighter than sand's
  // ~18 m sheets — spindrift comes in ropes, not blankets.
  pulseFreq: 0.11,                 // cycles per metre (~9 m ropes)
  pulseScrollHz: 0.12,
  pulseThreshold: 0.38,
  // Colour + opacity. Additive over the whole near field, so DIM.
  colour: [0.96, 0.98, 1.0],
  opacity: 0.2,
  // Snowfall response (plan §3.4: "read the weather env so ground spindrift
  // intensifies while it snows"). alpha = base + snowfall * gain.
  snowfallBase: 0.45,
  snowfallGain: 0.55,
  // Footprint stamp. Tighter than grass's 0.75 m stomp blob: a print, not a
  // crushed swathe. At the DEFAULT map (0.375 m/texel) this is barely more than
  // a texel — see the trail-RT decision in the header for why that is a URL
  // knob rather than a second render target.
  stampRadiusM: 0.42,
  stampStrength: 1,
});

/**
 * Resolve the live SNOW quality tier. `null` ⇒ the whole family is disabled at
 * this tier (plan §5.8: "`low` is null/disabled for every effect here without
 * exception"). Pure in `flags`.
 *
 * NOTE the ICE treatment is deliberately NOT part of this: it is a separate
 * master with its own tier keys, and a tier that disables SNOW must not also
 * silently disable ICE.
 *
 * @param {object|null} flags `liveScene3d.quality.flags`-shaped bag.
 * @returns {{spindriftCount:number, sparkle:boolean, prints:boolean,
 *   radiusM:number}|null}
 */
export function resolveSnowQuality(flags) {
  const num = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);
  const spindriftCount = Math.max(0, Math.round(num(flags?.terrainSnowSpindriftCount, 0)));
  const sparkle = flags?.terrainSnowSparkle === true;
  const prints = flags?.terrainSnowPrints === true;
  const radiusM = Math.min(512, Math.max(8, num(flags?.terrainSnowRadius, 64)));
  if (spindriftCount === 0 && !sparkle && !prints) return null;
  return { spindriftCount, sparkle, prints, radiusM };
}

/** Resolve the live ICE tier. `null` ⇒ disabled. Pure in `flags`. */
export function resolveIceQuality(flags) {
  const refraction = flags?.terrainIceRefraction === true;
  return { refraction };
}

/**
 * The shared wind vector in AC ground coordinates (+X east, +Y north).
 *
 * `VFX_GLOBALS.uWindDir` is a `Vector2` holding the THREE-space ground wind
 * `(x, z)` (`vfx/weather_inputs.js::writeWindVector`), and three `z` is AC `-y`
 * — so the conversion is `(w.x, -w.y)`. It is bound BY REFERENCE and written
 * once per frame by `loop.js::tickVfxWeatherInputs`; never snapshot it.
 *
 * ⚠ DUPLICATED from `terrain_sand.js::windAcFromGlobals` on purpose, not
 * imported: `terrain_sand.js` imports `vfx/components/terrainDustDevil.js`,
 * which calls `registerComponent` AT IMPORT TIME. Importing sand from snow
 * would register the sand dust-devil descriptor in every session that turns
 * snow on — a real side effect for six lines of arithmetic. (Same reasoning as
 * `terrain_scatter.js` duplicating `isTeleportJump` to stay a leaf.)
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
  // 135° = SE, the tree_wind default (`tree_wind.js:53 treeWindDir`).
  o.x = Math.cos((135 * Math.PI) / 180);
  o.y = Math.sin((135 * Math.PI) / 180);
  return o;
}

/**
 * How hard is it snowing, 0..1 — the spindrift intensity multiplier.
 *
 * Reads the SAME derived, smoothed client env `vfx/particle_env.js` builds for
 * the foliage gates (injected, so this module stays THREE-free). "Snowing"
 * matches `weather/manager.js::_selectPrecip` EXACTLY — a storm plus a profile
 * temperature at or below `SNOW_TEMPERATURE_C` (1 °C) — so ground spindrift and
 * the falling-snow system agree about the weather instead of each deciding for
 * themselves. `frost` (the lowpassed cold signal) supplies the ramp so onset and
 * offset never pop, and a non-storm cold day still lifts a little drift.
 *
 * Pure. With no env at all it returns 0 (calm), which is the fail-soft answer:
 * spindrift still runs at `snowfallBase`.
 *
 * @param {{isStorm?:boolean, temperatureC?:number, frost?:number,
 *   stormness?:number}|null} env
 * @returns {number} 0..1
 */
export function snowfallIntensity(env) {
  if (!env) return 0;
  const frost = Number.isFinite(env.frost) ? Math.min(1, Math.max(0, env.frost)) : 0;
  const tempC = Number.isFinite(env.temperatureC) ? env.temperatureC : 15;
  // `weather/manager.js` SNOW_TEMPERATURE_C — kept as a literal with the name
  // in the comment because importing the manager would pull the whole
  // rain/snow/lightning stack into a node test.
  const cold = tempC <= 1.0;
  if (!cold) return 0;
  const storming = env.isStorm === true;
  const stormness = Number.isFinite(env.stormness) ? Math.min(1, Math.max(0, env.stormness)) : 0;
  // Falling snow ⇒ full intensity ramped by the smoothed storm signal; a cold,
  // clear day ⇒ a third of it, off the frost ramp (wind still lifts loose snow).
  return storming ? Math.min(1, 0.45 + 0.55 * stormness) : 0.33 * frost;
}

/**
 * The SLOPE BIAS (plan §3.4 item 1: "spawn preferentially where
 * `oracle.sample().normal` tilts past a threshold, which is exactly where real
 * spindrift lifts").
 *
 * PURE and deterministic: a probability curve in the ground slope, decided by
 * the pool's per-cell hash stream. Flat ground keeps a floor (`FLAT_KEEP`)
 * rather than going to zero — a dead-flat snowfield with no drift at all reads
 * as broken, and a real one does have some.
 *
 * @param {number} slope `1 - normal.z`; 0 = dead flat, ~0.5 ≈ 30°.
 * @param {number} threshold the `?terrainSnowSlope` knob. <= 0 ⇒ no bias.
 * @param {number} r01 a deterministic [0,1) draw (the pool's `ctx.rand`).
 * @returns {boolean} keep this ribbon?
 */
export const SPINDRIFT_FLAT_KEEP = 0.12;
export function spindriftKeep(slope, threshold, r01) {
  if (!(threshold > 0)) return true;
  const s = Number.isFinite(slope) ? Math.max(0, slope) : 0;
  const t = Math.min(1, s / threshold);
  // Quadratic ramp: the bias is gentle just off flat and hard by the threshold,
  // so ribbons cluster on the crest faces rather than forming a hard ring.
  const p = SPINDRIFT_FLAT_KEEP + (1 - SPINDRIFT_FLAT_KEEP) * t * t;
  return r01 < p;
}

/**
 * Spindrift advection — the offset (metres, AC frame) of one ribbon from its
 * scattered anchor at time `tSec`. A PURE function of (wind, clock, hash): no
 * player state, no frame history, no `Math.random`. The GLSL in
 * `SNOW_SPINDRIFT_VERTEX_GLSL` computes exactly this expression, so the JS is
 * both the test oracle and the readable spec.
 *
 * @param {number} windX AC east component
 * @param {number} windY AC north component
 * @param {number} tSec  the shared clock (`scene3d.frameTime.tsSec`)
 * @param {number} phase01 per-instance hash, [0,1)
 * @param {number} spanM recycle distance
 * @param {number} speed metres/second per unit wind magnitude
 * @param {{x:number,y:number,s:number}} [out]
 */
export function spindriftAdvect(windX, windY, tSec, phase01, spanM, speed, out) {
  const o = out || { x: 0, y: 0, s: 0 };
  const span = Number.isFinite(spanM) && spanM > 0 ? spanM : SNOW_TUNING.advectSpanM;
  const wl = Math.max(Math.hypot(windX, windY), 1e-4);
  const dx = windX / wl;
  const dy = windY / wl;
  const travelled = tSec * speed * wl + phase01 * span;
  let s = travelled % span;
  if (s < 0) s += span;
  s -= span * 0.5;
  o.s = s;
  o.x = dx * s;
  o.y = dy * s;
  return o;
}

// ---------------------------------------------------------------------------
// The spindrift field — GLSL. Kept as exported strings so the shader test can
// assert on them without a GPU (the `terrain.js` / `terrain_sand.js` convention).
//
// ⚠ NO BACKTICKS anywhere in this GLSL, including comments: a stray backtick
// closes the JS template literal (this has bitten `terrain.js`, and it bit this
// wave too).
// ---------------------------------------------------------------------------

export const SNOW_SPINDRIFT_VERTEX_GLSL = `
precision highp float;

// Per-instance (written by terrain_scatter.js; see the schema below).
attribute vec3 aOffset;    // AC world position of the anchor (x, y, z=ground+lift)
attribute vec2 aScale;     // (length, width) in metres
attribute vec4 aDrift;     // (phase01, speedMul, slope01, alpha)

uniform float uTime;       // the SHARED clock, bound by reference (plan 5.6)
uniform vec2  uWindAc;     // AC ground wind (+X east, +Y north), live
uniform float uSpanM;      // advection recycle distance
uniform float uSpeed;      // metres/sec per unit wind magnitude
uniform float uWaveAmp;    // lateral serpentine amplitude, metres
uniform float uWaveFreq;   // radians of serpentine per metre downwind
uniform float uWaveHz;
uniform float uPulseFreq;  // cycles per metre
uniform float uPulseScroll;
uniform float uPulseThreshold;
uniform float uSnowfall;   // 0..1 weather intensity (see snowfallIntensity)
uniform float uSnowfallBase;
uniform float uSnowfallGain;

varying vec2 vQuadUv;
varying float vAlpha;

${SCATTER_FADE_GLSL}

// Cheap value noise (the terrain.js fragValueNoise2D shape, vertex-side).
float snowHash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float snowNoise2D(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = snowHash21(i);
  float b = snowHash21(i + vec2(1.0, 0.0));
  float c = snowHash21(i + vec2(0.0, 1.0));
  float d = snowHash21(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

void main() {
  // --- advection: the JS twin is terrain_snow.js::spindriftAdvect -----------
  float wl = max(length(uWindAc), 1e-4);
  vec2 dir = uWindAc / wl;
  vec2 side = vec2(-dir.y, dir.x);
  float travelled = uTime * uSpeed * aDrift.y * wl + aDrift.x * uSpanM;
  float s = mod(travelled, uSpanM) - uSpanM * 0.5;
  vec2 adv = dir * s;

  // --- the ribbon: a flat quad stretched along the wind, then SERPENTINED.
  // The lateral wave is what makes this a RIBBON rather than sand's straight
  // streak, and it is a pure function of (downwind distance, clock, hash), so
  // it stays deterministic.
  float along = position.x * aScale.x;
  float wave = sin(s * uWaveFreq + uTime * uWaveHz * 6.2831853 + aDrift.x * 6.2831853)
             * uWaveAmp;
  vec2 local2 = adv + dir * along + side * (position.y * aScale.y + wave);
  vec3 local = vec3(local2, 0.0);

  // instanceMatrix carries the anchor translation AND the pool 0/1 live scale,
  // so a degenerate (wrong-family / too-flat / unbaked / out-of-range) instance
  // collapses to a point and is zero-area for this material too.
  vec4 placed = instanceMatrix * vec4(local, 1.0);

  // --- the pulse field: ropes of drift form and dissolve -------------------
  vec2 pulseXy = placed.xy * uPulseFreq + dir * (uTime * uPulseScroll);
  float n = snowNoise2D(pulseXy);
  float pulse = smoothstep(uPulseThreshold, 1.0, n);

  // Distance blend, identical in form to the CPU fadeFor() (LINEAR).
  float fade = hbScatterFade(placed.xy);

  // WEATHER: spindrift intensifies while it is snowing (plan 3.4). The base
  // term keeps a calm cold day drifting rather than switching the field off.
  float wx = uSnowfallBase + uSnowfallGain * clamp(uSnowfall, 0.0, 1.0);

  vAlpha = pulse * fade * aDrift.w * wx;
  vQuadUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(placed.xyz, 1.0);
}
`;

export const SNOW_SPINDRIFT_FRAGMENT_GLSL = `
precision highp float;

uniform vec3 uColour;
uniform float uOpacity;

varying vec2 vQuadUv;
varying float vAlpha;

void main() {
  // Soft ribbon: a long smooth falloff along it, a tight one across, and a
  // sharper leading edge than sand so it reads as blown rather than suspended.
  vec2 c = abs(vQuadUv * 2.0 - 1.0);
  float along = 1.0 - c.x;
  float across = 1.0 - c.y;
  float mask = pow(max(along, 0.0), 1.1) * pow(max(across, 0.0), 2.4);
  float a = mask * vAlpha * uOpacity;
  if (a <= 0.0) discard;
  gl_FragColor = vec4(uColour * a, a);
}
`;

/** The per-instance attribute schema the pool allocates for a ribbon field. */
export const SNOW_SPINDRIFT_SCHEMA = Object.freeze([
  { name: "aOffset", itemSize: 3 },
  { name: "aScale", itemSize: 2 },
  { name: "aDrift", itemSize: 4 },
]);

// ---------------------------------------------------------------------------
// The spindrift field (THREE optional).
// ---------------------------------------------------------------------------

function _ribbonGeometry(THREE) {
  // A unit quad in the XY plane (AC ground plane), centred, with uv — built by
  // hand rather than with PlaneGeometry so the winding and the uv are explicit.
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
  geom.name = "snow-ribbon";
  return geom;
}

/**
 * Create the camera-scoped spindrift ribbon field.
 *
 * @param {object} opts
 * @param {object} [opts.THREE]    injected; omit for a headless CPU-only field.
 * @param {object} [opts.parent]   Object3D to hang the mesh off (AC space).
 * @param {object|Function} opts.oracle the terrain oracle, or a GETTER (use the
 *   getter form: `ctx.oracle` / `frameCtx.oracle` is LIVE and must never be
 *   stashed — wave-0 handoff §5).
 * @param {object} [opts.globals]  VFX_GLOBALS (uTime + uWindDir, BY REFERENCE).
 * @param {number} [opts.count]    instances (rounded up to a square).
 * @param {number} [opts.radiusM]
 * @param {number} [opts.slopeBias] `1 - normal.z` threshold; 0 ⇒ no bias.
 * @param {number} [opts.seed]
 */
export function createSpindriftField(opts = {}) {
  const THREE = opts.THREE || null;
  const count = Math.max(1, Math.round(Number.isFinite(opts.count) ? opts.count : 1200));
  const radiusM = Math.min(512, Math.max(8, Number.isFinite(opts.radiusM) ? opts.radiusM : 64));
  const seed = (Number.isFinite(opts.seed) ? opts.seed : 0x5170e1f7) | 0;
  const slopeBias = Number.isFinite(opts.slopeBias) ? Math.min(1, Math.max(0, opts.slopeBias)) : 0.12;
  const globals = opts.globals || null;
  const tuning = { ...SNOW_TUNING, ...(opts.tuning || {}) };

  let geometry = null;
  let material = null;

  // THE UNIFORM BAG. Built FIRST, handed to the ShaderMaterial AND to the pool
  // via the wave-2A `opts.uniforms` in-parameter — so the pool publishes its
  // four distance-blend uniforms straight into the bag the compiled shader is
  // already holding, and there is no placeholder-then-repoint dance (the
  // wave-1 handoff §6 rough edge this family dogfoods).
  //
  // THE CLOCK IS BOUND BY IDENTITY (plan §5.6, the `test_vfx_glint.mjs`
  // assertion): when VFX_GLOBALS is injected we ADOPT its `uTime` object rather
  // than minting a clone, exactly as `glint.js::declareUniforms` does
  // (`shader.uniforms.uTime = g.uTime || ...`). `loop.js::tickVfxOscillators`
  // then drives spindrift, tree sway and every frag component off ONE object,
  // so they can never drift apart. `_ownsClock` records whether we may write
  // it: writing an adopted VFX_GLOBALS.uTime would fight the oscillator tick.
  //   ⚠ DIVERGENCE from `terrain_grass.js`, which deliberately mints its own
  //   uTime and writes it from `frameCtx.tSec` so its shader test can stay
  //   pure-ESM with no `materials.js` import. This module needs no such import
  //   either — the globals arrive as an ARGUMENT — so it can have both.
  const _sharedTime = globals && globals.uTime && typeof globals.uTime === "object"
    ? globals.uTime
    : null;
  const _ownsClock = _sharedTime === null;
  const uniforms = {
    uTime: _sharedTime || { value: 0 },
    uWindAc: { value: null },
    uSpanM: { value: tuning.advectSpanM },
    uSpeed: { value: tuning.advectSpeed },
    uWaveAmp: { value: tuning.waveAmpM },
    uWaveFreq: { value: tuning.waveFreq },
    uWaveHz: { value: tuning.waveHz },
    uPulseFreq: { value: tuning.pulseFreq },
    uPulseScroll: { value: tuning.pulseScrollHz },
    uPulseThreshold: { value: tuning.pulseThreshold },
    uSnowfall: { value: 0 },
    uSnowfallBase: { value: tuning.snowfallBase },
    uSnowfallGain: { value: tuning.snowfallGain },
    uColour: { value: null },
    uOpacity: { value: tuning.opacity },
    // Adopted + populated by the pool below (never placeholders to re-point).
    uScatterCenter: { value: null },
    uScatterRadius: { value: radiusM },
    uScatterFadeStart: { value: radiusM * 0.75 },
    uScatterShape: { value: 0 },
  };

  const wind = { x: 0, y: 0 };
  const advect = { x: 0, y: 0, s: 0 };

  if (THREE && typeof THREE.ShaderMaterial === "function") {
    try {
      geometry = _ribbonGeometry(THREE);
      uniforms.uWindAc.value = new THREE.Vector2(1, 0);
      uniforms.uColour.value = new THREE.Color(
        tuning.colour[0], tuning.colour[1], tuning.colour[2],
      );
      uniforms.uScatterCenter.value = new THREE.Vector3(0, 0, 0);
      material = new THREE.ShaderMaterial({
        vertexShader: SNOW_SPINDRIFT_VERTEX_GLSL,
        fragmentShader: SNOW_SPINDRIFT_FRAGMENT_GLSL,
        // The SAME objects the pool will publish into — no spread, no copy.
        uniforms,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      material.name = "terrain-snow-spindrift";
    } catch (_) {
      geometry = null;
      material = null;
    }
  }

  const pool = createScatterPool({
    THREE,
    name: "terrain-snow-spindrift",
    count,
    radiusM,
    seed,
    // Salted so a spindrift ribbon and a grass blade (or a sand streak) that
    // land in the SAME world cell do not draw the same jitter numbers — the
    // other wave-1 handoff §6 rough edge, dogfooded here.
    randSalt: 0x2a,
    shape: "disc",
    fadeFraction: 0.25,
    jitter: 1,
    families: [FAM_SNOWICE],
    attributes: SNOW_SPINDRIFT_SCHEMA.map((a) => ({ ...a })),
    uniforms,
    // SLOPE BIAS — the pool has already written ctx.nx/ny/nz from the oracle
    // face normal when `accept` runs. Rejected ribbons are written degenerate
    // (zero-area), i.e. one vertex invocation and nothing else.
    accept(sample, ctx) {
      return spindriftKeep(1 - ctx.nz, slopeBias, ctx.rand(9));
    },
    fill(ctx) {
      // Lift: 0.03..0.28 m. Hash-stable per cell.
      const lift = tuning.liftMinM + ctx.rand(3) * (tuning.liftMaxM - tuning.liftMinM);
      ctx.z += lift;
      const lenJ = 1 + (ctx.rand(4) - 0.5) * 2 * tuning.ribbonLengthJitter;
      ctx.set("aScale", tuning.ribbonLengthM * lenJ, tuning.ribbonWidthM);
      // Per-code density: ice sheds far less than powder (SNOWICE_VARIANTS).
      const v = SNOWICE_VARIANTS[ctx.code];
      const drift = v ? v.drift : 1;
      const slope01 = Math.min(1, Math.max(0, 1 - ctx.nz));
      ctx.set(
        "aDrift",
        ctx.rand(5),                       // advection phase
        0.8 + ctx.rand(6) * 0.7,           // per-ribbon speed multiplier
        slope01,                           // published for diagnosis + future use
        // Steeper ground drifts harder; ice barely drifts at all.
        (0.5 + ctx.rand(8) * 0.5) * ctx.fade * drift * (0.6 + 0.4 * Math.min(1, slope01 * 4)),
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
    mesh.name = "terrain-snow-spindrift";
    mesh.castShadow = false;      // §5.7 — added geometry is paid twice
    mesh.receiveShadow = false;
    mesh.renderOrder = 3;
  }

  const state = { frames: 0, lastRescattered: 0, snowfall: 0, built: !!mesh };

  return {
    pool,
    uniforms,
    slopeBias,
    /** false ⇒ `uniforms.uTime` IS `VFX_GLOBALS.uTime` (bound by identity). */
    ownsClock: _ownsClock,
    get mesh() { return mesh; },
    get material() { return material; },
    get geometry() { return geometry; },
    /** Per-frame: re-centre the pool and refresh the live uniforms. */
    update(dt, tSec, px, py, pz, snowfall) {
      state.frames += 1;
      windAcFromGlobals(globals, wind);
      // Only when we MINTED the clock. An adopted VFX_GLOBALS.uTime belongs to
      // `loop.js::tickVfxOscillators`; writing it here would fight that tick.
      if (_ownsClock) uniforms.uTime.value = Number.isFinite(tSec) ? tSec : 0;
      const wv = uniforms.uWindAc.value;
      if (wv) { wv.x = wind.x; wv.y = wind.y; }
      state.snowfall = Number.isFinite(snowfall) ? Math.min(1, Math.max(0, snowfall)) : 0;
      uniforms.uSnowfall.value = state.snowfall;
      state.lastRescattered = pool.update(dt, px, py, pz);
      return state.lastRescattered;
    },
    /** The CPU twin of the shader advection, for diagnostics and tests. */
    advectionOf(phase01, tSec, speedMul) {
      windAcFromGlobals(globals, wind);
      return spindriftAdvect(
        wind.x, wind.y,
        Number.isFinite(tSec) ? tSec : 0,
        phase01,
        uniforms.uSpanM.value,
        uniforms.uSpeed.value * (Number.isFinite(speedMul) ? speedMul : 1),
        advect,
      );
    },
    dispose() {
      // The pool owns the mesh (it built it) and deliberately never disposes
      // the geometry/material it was handed — those are ours.
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
        snowfall: state.snowfall,
        slopeBias,
        wind: { x: wind.x, y: wind.y },
        pool: pool.stats(),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The footprint uniform push. THE bridge between `trail_map.js` (which owns the
// render target) and the terrain fragment shader (which owns the dent + the
// darkening). Exported and pure-ish so the test can drive it with fakes.
// ---------------------------------------------------------------------------

/**
 * Push the trail map's live state onto every terrain ShaderMaterial.
 *
 * WHY A PER-FRAME PUSH and not a bind-once: (a) the trail map PING-PONGS its
 * render target, swapping `uTrailMap.value` in place every frame, (b) landblock
 * materials are baked continuously, long after the map was constructed, and (c)
 * the map may not exist at all. This is the same shape as
 * `loop.js::tickTerrainUTime` and `IblEnvironment.tick`, both of which walk
 * `scene3d.terrainMaterials` for exactly these reasons — and that array carries
 * the `?terrainBatch=on` BatchedMesh material too (`terrain_batch.js:447`), so
 * one loop covers both terrain paths.
 *
 * With `trail` null every material is driven to `uSnowTrailEnabled = 0` — the
 * ABSENT-MAP contract (grass precedent): no lazy-ensure, no error, no print.
 *
 * @param {Array<object>|null} materials `scene3d.terrainMaterials`
 * @param {object|null} trail the `trail_map.js` handle, or null
 * @returns {number} materials touched
 */
export function pushSnowTrailUniforms(materials, trail) {
  if (!Array.isArray(materials) || materials.length === 0) return 0;
  const tu = trail && trail.uniforms ? trail.uniforms : null;
  const tex = tu && tu.uTrailMap ? tu.uTrailMap.value : null;
  const cx = tu && tu.uTrailCenter && tu.uTrailCenter.value ? tu.uTrailCenter.value.x : 0;
  const cy = tu && tu.uTrailCenter && tu.uTrailCenter.value ? tu.uTrailCenter.value.y : 0;
  const radius = tu && tu.uTrailRadius && Number.isFinite(tu.uTrailRadius.value)
    ? tu.uTrailRadius.value : 48;
  const on = tex ? 1 : 0;
  let touched = 0;
  for (const mat of materials) {
    const u = mat && mat.uniforms;
    if (!u || !u.uSnowTrailEnabled) continue;   // pre-Wave-2A material: skip
    if (u.uSnowTrailMap) u.uSnowTrailMap.value = tex;
    const c = u.uSnowTrailCenter ? u.uSnowTrailCenter.value : null;
    // Written componentwise rather than with .set(): the batched material's
    // clone is a real Vector2, but a headless/stub material may carry a plain
    // {x, y} and this path must not care.
    if (c) { c.x = cx; c.y = cy; }
    if (u.uSnowTrailRadius) u.uSnowTrailRadius.value = radius;
    u.uSnowTrailEnabled.value = on;
    touched += 1;
  }
  return touched;
}

// ---------------------------------------------------------------------------
// Module state + the two providers.
// ---------------------------------------------------------------------------

let _snow = null;       // the init record, or null

const _stats = {
  inits: 0,
  spindriftBuilds: 0,
  stamps: 0,
  stampsDropped: 0,
  pushFrames: 0,
  materialsTouched: 0,
  noTrail: 0,
};

function _envSnapshot() {
  if (!_snow || typeof _snow.readEnv !== "function") return null;
  try { return _snow.readEnv(_snow.scene3d) || null; } catch (_) { return null; }
}

function _terrainMaterials() {
  if (!_snow) return null;
  try {
    const s = _snow.scene3d;
    if (Array.isArray(s?.terrainMaterials)) return s.terrainMaterials;
    if (typeof window !== "undefined" && Array.isArray(window.liveScene3d?.terrainMaterials)) {
      return window.liveScene3d.terrainMaterials;
    }
  } catch (_) { /* fail-soft */ }
  return null;
}

function _spindriftProvider() {
  return {
    id: SPINDRIFT_PROVIDER_ID,
    families: [FAM_SNOWICE],
    scope: "camera",
    enabled() { return terrainSnowEnabled() && terrainSnowSpindriftEnabled(); },
    quality(flags) {
      const q = resolveSnowQuality(flags);
      return q && q.spindriftCount > 0 ? q : null;
    },
    update(dt, frameCtx) {
      if (!_snow) return;
      if (!frameCtx || !frameCtx.hasPlayer) return;
      // `frameCtx.oracle` is a LIVE getter on the spine (wave-0 handoff §5) —
      // read it every frame, never stash it. The pool holds a GETTER for the
      // same reason, so a field built before the oracle resolved comes alive.
      if (!_snow.field) {
        const q = resolveSnowQuality(frameCtx.quality) || {
          spindriftCount: terrainSnowSpindriftCount(),
          radiusM: terrainSnowRadiusM(),
        };
        const count = q.spindriftCount > 0 ? q.spindriftCount : terrainSnowSpindriftCount();
        if (count <= 0) return;
        _snow.field = createSpindriftField({
          THREE: _snow.THREE,
          parent: _snow.parent,
          globals: _snow.globals,
          oracle: () => (_snow ? _snow.oracleRef() : null),
          count,
          radiusM: q.radiusM || terrainSnowRadiusM(),
          slopeBias: _snow.slopeBias,
          seed: _snow.seed,
        });
        _stats.spindriftBuilds += 1;
      }
      const p = frameCtx.playerPos;
      _snow.field.update(dt, frameCtx.tSec, p.x, p.y, p.z, snowfallIntensity(_envSnapshot()));
    },
    dispose() {
      if (_snow && _snow.field) { _snow.field.dispose(); _snow.field = null; }
    },
  };
}

function _printProvider() {
  return {
    id: PRINT_PROVIDER_ID,
    families: [FAM_SNOWICE],
    scope: "camera",
    enabled() { return terrainSnowEnabled() && terrainSnowPrintsEnabled(); },
    quality(flags) {
      const q = resolveSnowQuality(flags);
      return q && q.prints ? q : null;
    },
    update(dt, frameCtx) {
      if (!_snow) return;
      const trail = frameCtx ? frameCtx.trail : null;
      const materials = _terrainMaterials();
      if (!trail) {
        _stats.noTrail += 1;
        // ABSENT MAP ⇒ drive the uniform OFF and do nothing else. No
        // lazy-ensure: the map is `?terrainTrail=on`'s to build, exactly as
        // grass stomp has it (wave-1 handoff).
        if (materials) _stats.materialsTouched += pushSnowTrailUniforms(materials, null);
        return;
      }
      // PLAYER-ONLY stamps. Same limitation as the grass stomp: there is no
      // cheap accessor for other creatures' ground positions today, so a
      // creature leaves no track. Noted rather than faked.
      if (frameCtx.hasPlayer && typeof trail.stamp === "function") {
        const p = frameCtx.playerPos;
        if (trail.stamp(p.x, p.y, SNOW_TUNING.stampRadiusM, SNOW_TUNING.stampStrength)) {
          _stats.stamps += 1;
        } else {
          _stats.stampsDropped += 1;
        }
      }
      if (materials) {
        _stats.pushFrames += 1;
        _stats.materialsTouched += pushSnowTrailUniforms(materials, trail);
      }
    },
    dispose() {
      // Leave no print uniform live on a material that outlives us.
      const materials = _terrainMaterials();
      if (materials) pushSnowTrailUniforms(materials, null);
    },
  };
}

/**
 * Construct + register the SNOW family. Called once from `scene3d/index.js`
 * right after `initTerrainVfx` (the spine must exist first — providers are
 * replayed onto the already-resident ring by `registerTerrainVfx`).
 *
 * Returns `null` — registering nothing, allocating nothing — when the masters
 * are off, so a bare-default boot is byte-identical. The ICE treatment needs no
 * provider at all (it is bake-time terrain-shader uniforms), so `?terrainIce=on`
 * alone returns the diagnostic surface without registering anything.
 *
 * @param {object} opts
 * @param {object} [opts.THREE]    the three namespace (injected).
 * @param {object} opts.scene3d    the live facade.
 * @param {object} [opts.parent]   Object3D for the ribbon mesh; defaults to
 *   `terrainGroup.parent` (worldRoot) — a SIBLING of terrainGroup with the same
 *   transform, so the field is in AC space and the LRU's terrainGroup scans
 *   cannot take it.
 * @param {object} [opts.globals]  VFX_GLOBALS (uTime/uWindDir, BY REFERENCE).
 * @param {Function} [opts.readEnv] `vfx/particle_env.js::readParticleEnv`
 *   (injected so this module stays THREE-free).
 * @param {Function} [opts.getOracle] override for the terrain oracle.
 */
export function initTerrainSnow(opts = {}) {
  const scene3d = opts.scene3d || null;
  if (wireframeActive(opts.search)) return null;   // plan §8 risk 8
  const snowOn = terrainSnowEnabled();
  const iceOn = terrainIceEnabled();
  if (!snowOn && !iceOn) return null;              // ship-OFF masters (plan §5.9)

  const spindriftOn = snowOn && terrainSnowSpindriftEnabled();
  const printsOn = snowOn && terrainSnowPrintsEnabled();

  _snow = {
    THREE: opts.THREE || null,
    scene3d,
    parent: opts.parent || scene3d?.terrainGroup?.parent || null,
    globals: opts.globals || null,
    readEnv: typeof opts.readEnv === "function" ? opts.readEnv : null,
    seed: Number.isFinite(opts.seed) ? opts.seed | 0 : 0x5170e1f7,
    slopeBias: Number.isFinite(opts.slopeBias) ? opts.slopeBias : terrainSnowSlopeBias(),
    field: null,
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
        "[terrainSnowPrints] ?terrainSnowPrints=on but the shared trail map is "
        + "NOT enabled — prints need ?terrainTrail=on as well (this family never "
        + "creates the map itself). Nothing will be drawn.",
      );
    } else {
      const fade = terrainTrailRecoverySec();
      if (Number.isFinite(fade) && fade < SNOW_SHORT_FADE_WARN_SEC) {
        // eslint-disable-next-line no-console
        console.warn(
          `[terrainSnowPrints] the shared trail recovery is ${fade}s (grass springback). `
          + `Snow prints should persist: add ?terrainTrailFade=${SNOW_RECOMMENDED_FADE_SEC}. `
          + "The map is family-agnostic and has ONE fade — see the trail-RT decision in "
          + "scene3d/terrain_snow.js.",
        );
      }
    }
  }

  // "I turned the flag on and nothing happened" is exactly the silence
  // `gfx_relief.js:137` argues against, and at `low`/`mid` the tier ships
  // `terrainSnowSpindriftCount: 0`. Say so once; the fix is a one-line URL.
  if (spindriftOn) {
    if (terrainSnowSpindriftCount() > 0) {
      _snow.registered.push(registerTerrainVfx(_spindriftProvider()));
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        "[terrainSnowSpindrift] ?terrainSnowSpindrift=on but the resolved ribbon "
        + "count is 0 (quality low/mid ship terrainSnowSpindriftCount: 0). Raise it "
        + "with ?terrainSnowSpindriftCount=N or use ?quality=high or higher.",
      );
    }
  }
  if (printsOn) _snow.registered.push(registerTerrainVfx(_printProvider()));
  // Sparkle-only (the whole `mid` tier) and ice-only both register NO provider
  // — they are terrain-shader terms baked into the material — but the
  // diagnostic surface is still worth returning.
  return terrainSnowSurface();
}

/** Diagnostics — mirrored onto `window.__terrainSnow` by `scene3d/index.js`. */
export function terrainSnowStats() {
  const snowOn = terrainSnowEnabled();
  const iceOn = terrainIceEnabled();
  return {
    enabled: snowOn,
    spindrift: snowOn && terrainSnowSpindriftEnabled(),
    sparkle: snowOn && terrainSnowSparkleEnabled(),
    prints: snowOn && terrainSnowPrintsEnabled(),
    ice: iceOn,
    iceRefraction: iceOn && terrainIceRefractionEnabled(),
    trailFlag: terrainTrailEnabled(),
    trailFadeSec: terrainTrailRecoverySec(),
    inited: !!_snow,
    slopeBias: _snow ? _snow.slopeBias : terrainSnowSlopeBias(),
    snowCodes: snowTerrainCodes(),
    snowCodeMask: snowCodeBitmask(),
    iceCodes: iceTerrainCodes(),
    iceCodeMask: iceCodeBitmask(),
    // THE live-check field (mirrors __terrainGrass.visibleBlades /
    // __terrainSand.field): non-zero means ribbons actually landed on snow.
    visibleRibbons: _snow && _snow.field ? _snow.field.pool.stats().live : 0,
    field: _snow && _snow.field ? _snow.field.stats() : null,
    counters: { ..._stats },
  };
}

function terrainSnowSurface() {
  return {
    stats: terrainSnowStats,
    get field() { return _snow ? _snow.field : null; },
    get uniforms() { return _snow && _snow.field ? _snow.field.uniforms : null; },
    lbKeyFromXY,
  };
}

/** Test seam — unregister both providers and drop all state. */
export function _resetTerrainSnow() {
  if (_snow) {
    for (const h of _snow.registered) {
      try { unregisterTerrainVfx(h.id); } catch (_) {}
    }
    if (_snow.field) { try { _snow.field.dispose(); } catch (_) {} }
  }
  _snow = null;
  for (const k of Object.keys(_stats)) _stats[k] = 0;
}
