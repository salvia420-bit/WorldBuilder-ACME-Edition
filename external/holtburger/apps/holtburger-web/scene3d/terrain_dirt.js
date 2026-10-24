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
//
// 2026-10-23 — "IMPROVE BEFORE THE VISTEST" (owner, 1070, high tier, noon,
// @teleloc 0x0D650025 96 96 78.5 — the whole landblock is code 7 PackedDirt):
// "nothing from the family reads; 426 dust-haze sprites 'visible' but not
// noticeable". Diagnosed from the before-stills + stats, each with a fix:
//   HAZE. (a) The quads lay FLAT in the ground plane (local z = 0): a chase
//     camera 14-22 degrees above the ground foreshortens a 1.35 m-wide sheet to
//     a sliver. Now an UPRIGHT camera-facing (cylindrical) billboard, 4.5-8.5 m
//     wide and 1.2-2.2 m tall, with a ground-hugging vertical profile and soft
//     streaky wisps — a dust LAYER seen side-on, which is how dust is seen.
//     (b) Effective alpha averaged ~0.1 % per sheet (0.09 opacity x the pack
//     weight 0.6 x a ~15 % gust coverage x the 1.6-power masks): ~0.027 now,
//     peaking at 0.25 in a gust bank, calibrated so a grazing view builds a
//     ~25 % veil over 40 m of dirt (~39 % at 70 m), not a wall.
//     (c) The per-instance alpha multiplied the pool's SCATTER-TIME fade, which
//     is frozen at placement: a leading-edge sheet is placed at the rim (fade 0)
//     and stayed invisible as the player walked onto it. Only the live shader
//     fade remains, and the pack weight is the accept probability (density),
//     not a second alpha factor. (d) The gust banks scrolled UPWIND (sign bug)
//     and the drift multiplied the ABSOLUTE clock by the live wind magnitude, so
//     the wind's 13 s breathing (and its 45 s direction wander, through the gust
//     scroll) raced the sheets at tens of m/s once the session was an hour old.
//     Travel and gust drift are now INTEGRATED on the CPU from the shared wind
//     (smooth, bounded, downwind), and a fade-in/fade-out life envelope hides
//     the recycle. (e) An unlit fixed colour glowed at night and sat a hair off
//     the ground's grey: the dust is now LIT by the terrain's own retail light
//     (`uAcSunVec/uAcSunColor/uAcAmb*`, copied each frame — dark at night by
//     construction, with a forward-scatter lift toward a low sun) and tinted per
//     code paler and less saturated than the soil it lifts off (the same
//     mineral, finer and in air). (f) It follows the ground PLANE at its anchor
//     (the pool's scattered normal) over a shorter 16 m span, so it hugs slopes.
//     (g) 2026-10-24 review: the foot ramp ran in quad uv from the bottom,
//     0.25 m UNDER the soil, so flat ground cut each sheet at 0.20-0.54 of its
//     peak — a hard line. It is now measured from the ground (and the sheet is
//     sheared along the ground plane so that holds on a lateral slope), with
//     the opacity re-calibrated 0.25 -> 0.28 for the lost visible column. And
//     the camera-only near fade (2.5 -> 8 m) let a sheet just in front of the
//     player, ~5.7 m from the chase camera, draw at ~0.6 alpha over them: the
//     sheets now also fade on their distance to the camera -> avatar segment
//     (see DIRT_TUNING.hazeSightFadeStart).
//   PUFFS. A 0.62 m sprite (visible blob ~0.45 m) at ~0.2 alpha in a grey close
//     to the ground vanished at chase distance — and needs walking to appear
//     at all. Now a ~1.6 m burst (main + a delayed satellite), rising 0.7 m over
//     ~1.35 s, at 0.62 opacity, lit like the ground and paler than it. The ring
//     default grew 48 -> 96 slots so the satellites do not recycle live puffs.
//   PRINTS. A dry stamp of 0.35 x the code multiplier, scaled again by the
//     shader's 0.35 dry factor and darkened by 0.28, was a ~2 % change. Dry
//     stamps now land at 0.6 and the shader seeds are 0.35 / 0.42 (terrain.js;
//     the dry scale went 0.65 -> 0.35 on 2026-10-24: grass stomp, default ON at
//     high/ultra, stamps the SAME map at 1.0 / 0.75 m under the player, max()-
//     combined, so the map reads 1.0 on every dirt code and the per-code stamp
//     never shows). Stomp live: a dry track darkens ~14.7 %, a soaked one 42 %
//     (2.86x), on every code. Stomp off: dry PackedDirt ~6 %, PatchyDirt ~8 %,
//     MudRichDirt ~11 %; soaked 29 / 38 / 42 % (test_terrain_dirt_shader.mjs
//     M5b). Live: `window.__terrainDirt.tune({...})`.
//   RESIDENCY. Nothing in this family is landblock-scoped (every field is
//     camera/player-scoped), so the "providers for landblocks the player left"
//     growth seen in the sand/volcano stats cannot happen here.

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
import { withLogDepth } from "./shader_logdepth.js";
import { createInteriorMask } from "./grass_interior_mask.js";

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
 *   puff   the dust colour a footfall throws, linear RGB — the ALBEDO of the
 *          airborne fines, lit at runtime by the terrain's own light. Paler and
 *          less saturated than the soil it lifts off (2026-10-23: PackedDirt's
 *          lit ground reads ~sRGB(172,122,55); its dust ~sRGB(212,193,165)).
 *          The dry-dust haze uses the SAME colour: it is the same dust.
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
  5: Object.freeze({ puff: [0.44, 0.36, 0.27], dust: 0.25, print: 1.25, haze: 0.15, clay: false }),
  // PackedDirt — road dirt. Hard underfoot but powdered on top: the best puff.
  7: Object.freeze({ puff: [0.68, 0.55, 0.39], dust: 1.0, print: 0.7, haze: 0.6, clay: false }),
  // PatchyDirt — the family reference.
  8: Object.freeze({ puff: [0.62, 0.51, 0.37], dust: 0.8, print: 0.9, haze: 0.5, clay: false }),
  // Argila — clay. Redder, and the slickest of the five once it is wet.
  24: Object.freeze({ puff: [0.68, 0.47, 0.34], dust: 0.55, print: 1.15, haze: 0.35, clay: true }),
  // DesolateLands — the driest. THE haze bias (plan §3.7 item 3).
  31: Object.freeze({ puff: [0.66, 0.58, 0.45], dust: 1.0, print: 0.6, haze: 1.0, clay: false }),
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

/**
 * Tuning that is NOT worth a URL flag. These are the DEFAULTS; the live values
 * are a mutable copy (`window.__terrainDirt.tune({...})`, reset by
 * `tune(null)` and on re-init).
 */
export const DIRT_TUNING = Object.freeze({
  // --- footfall puffs ------------------------------------------------------
  // A puff is a BURST that dies fast: seconds of life, metres of size at birth
  // and at death, and how far it drifts up while it does it. The "radius" is
  // the billboard's FULL WIDTH (the shader offsets a +-0.5 quad by it); the
  // soft disc inside reads at ~70 % of that. 2026-10-23: 0.14->0.62 m was a
  // ~0.45 m blob at ~0.2 alpha, invisible from a chase camera; a footfall in
  // loose dry dirt throws a ~1-1.5 m cloud that hangs for a second or more.
  puffLifeSec: 1.35,
  puffLifeJitter: 0.3,           // +-30% per puff
  puffRadiusStartM: 0.35,
  puffRadiusEndM: 1.6,
  puffRiseM: 0.7,
  puffLiftM: 0.08,               // spawn height above the ground sample
  // The quad is CENTRED on its origin, so without this its lower half sits in
  // the ground and the terrain clips the disc along a hard line. Lifting the
  // centre by this fraction of the live width keeps the faint rim at the soil.
  puffRadiusLift: 0.3,
  puffOpacity: 0.62,
  // Wind pushes a puff downwind as it rises (the shared vector, not a fork).
  puffWindDrift: 0.55,
  // A BURST, not a ball: each footfall writes the main puff plus this many
  // smaller satellites, offset by a hashed direction and born a beat later.
  puffSatellites: 1,
  puffSatelliteSpreadM: 0.32,
  puffSatelliteScale: 0.7,
  puffSatelliteDelaySec: 0.07,
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
  stampRadiusM: 0.6,
  // Strength at bone-dry vs soaked. THE rain-dependent persistence knob — see
  // decision (b) in the header. 2026-10-23: dry 0.35 -> 0.6. A track through
  // DRY dirt is still a track (the scuffed fines are darker and rougher than
  // the crusted top); it was a ~2 % change. 2026-10-24 (terrain.js dry scale
  // 0.65 -> 0.35, grass stomp max()-combined on the same map): a dry track now
  // reads ~14.7 % with the stomp live, ~6-11 % by code with it off (the PRINTS
  // note in the header; test_terrain_dirt_shader.mjs M5b).
  stampStrengthDry: 0.6,
  stampStrengthWet: 1.0,

  // --- dry dust haze -------------------------------------------------------
  // A dust LAYER seen side-on: upright, camera-facing (about the vertical),
  // wide and low, with a ground-hugging profile, drifting slowly downwind in
  // gust banks. Width/height in metres, jittered per sheet.
  hazeWidthM: 6.5,
  hazeHeightM: 1.7,
  hazeSizeJitter: 0.3,           // +-30 % on both
  // The sheet's foot sits this far INTO the ground so its (transparent) bottom
  // edge never shows a seam on a gentle rise. 2026-10-24: the foot ramp is
  // measured from the GROUND, not the quad bottom (the fragment's
  // smoothstep(uSinkM, uSinkM + 0.45, metres-from-bottom)), so the
  // alpha is exactly 0 where the sheet meets flat ground; the old uv ramp met
  // it at 0.20-0.54 of the peak (by sheet height) — a hard straight line. The
  // vertex stage also SHEARS each sheet along the ground plane at its anchor,
  // so "from the ground" holds across a lateral slope too.
  hazeSinkM: 0.25,
  hazeAdvectSpeed: 2.1,          // m/s per unit wind; slower than sand and snow
  // Distance a sheet travels downwind before it recycles. Short enough that the
  // ground-PLANE approximation at its anchor holds on a hillside; the life
  // envelope below hides the recycle.
  hazeAdvectSpanM: 16,
  hazeLifeFadeIn: 0.2,           // fraction of the span spent fading in
  hazeLifeFadeOut: 0.25,         // ... and out
  // Gust BANKS: two octaves of world-anchored value noise drifting DOWNWIND at
  // this speed (integrated from the shared wind, never clock x magnitude).
  hazePulseFreq: 0.045,          // cycles per metre (~22 m banks)
  hazeGustSpeedMps: 2.6,
  hazePulseLo: 0.3,              // smoothstep window over the noise: ~45 %
  hazePulseHi: 0.75,             //   of the ground sits in a bank
  hazeVeilFloor: 0.35,           // between banks the veil thins, never vanishes
  // Fallback dust albedo for a code with no variant row (linear RGB); every
  // FAM_DIRT code has one, so this is only the headless/default tint.
  hazeColour: [0.64, 0.52, 0.37],
  // Calibrated (Monte-Carlo of the GLSL masks, 2026-10-23) so a grazing view
  // through PackedDirt (~0.26 sheets crossed per metre) builds a ~13 % veil
  // over 20 m, ~25 % over 40 m, ~39 % at 70 m — dust, not a wall. 2026-10-24
  // re-check after the ground-measured foot: the profile's VISIBLE column (the
  // part above the soil, which is all a ray ever crosses) fell 0.863 -> 0.758
  // m (x0.878, averaged over the height jitter), so 0.25 -> 0.28 keeps that
  // calibration (12.8 / 24.0 / 38.1 %). Side x profile x wisp now averages
  // ~0.22 over the whole quad (~0.27 over its visible part), the gust veil
  // ~0.64 (~44 % of the ground in a bank): ~0.025 mean alpha per sheet, 0.28
  // at a bank peak (the tallest-profile pixel of a sheet sitting in a bank).
  hazeOpacity: 0.28,
  // 2026-10-23 — INDOORS (the owner's "grass through interiors" bug class): an
  // upright sheet anchored under or beside a building rises through its floor.
  // No sheet is placed within this many metres of an EnvCell box (the anchor and
  // four points this far out are tested), and the whole field fades out over
  // hazeIndoorFadeSec while the player stands inside one.
  hazeIndoorMarginM: 6,
  hazeIndoorFadeSec: 0.5,
  // Sheets this close to the CAMERA fade out (start -> end, flat metres), so
  // the chase camera never looks through a card.
  hazeNearFadeStartM: 2.5,
  hazeNearFadeEndM: 8,
  // 2026-10-24 — THE SIGHTLINE. The chase camera sits ~5.7 m (flat) behind the
  // avatar, INSIDE the camera window above, so a sheet just in front of the
  // player drew at up to ~0.6 of its alpha straight over them (and at any
  // zoom past 8 m, at full). Sheets also fade on their flat distance to the
  // camera -> avatar SEGMENT, measured in units of the sheet's OWN half-width
  // (start -> end): a sheet's side mask is ~0 past one half-width, so this
  // clears exactly the sheets whose body crosses the sightline whatever their
  // jittered width and whatever the zoom. Worst residual veil on the avatar
  // (side mask at the crossing x this fade x the camera fade) <= 0.05 of a
  // sheet's alpha at 3 / 5.7 / 12 m chase for every width in the jitter; it
  // costs ~0.3-0.8 % of the field's haze. The same segment distance keeps a
  // sheet from cutting through the avatar itself. Per-VERTEX (4 per sheet).
  hazeSightFadeStart: 0.6,
  hazeSightFadeEnd: 1.2,
  // Forward scatter: looking toward a LOW sun through dust lifts it (Mie). Gain
  // on the sun term, x dirBright, so it is zero at night by construction.
  hazeForwardScatter: 0.6,
  // Dryness response. Haze is a DRY-HEAT effect: rain kills it outright and a
  // cold day barely lifts any.
  hazeWetKill: 0.35,             // wetness at which the haze is fully gone
  hazeWarmC: 22,                 // full strength at/above this air temperature
  hazeColdC: 4,                  // nothing below this
});

/**
 * The quantised per-sheet speed multipliers (k/8). Quantised so the CPU travel
 * accumulator can wrap SEAMLESSLY: at a wrap of `span * 8 * HAZE_TRAVEL_WRAP_LAPS`
 * metres, `travel * (k/8) / span` changes by an integer for every k, so `fract`
 * — and therefore every sheet — is unchanged across the wrap.
 */
export const HAZE_SPEED_STEPS = Object.freeze([6, 7, 8, 9, 10]);
export const HAZE_TRAVEL_WRAP_LAPS = 512;

/** The live-tunable keys (numbers) and their clamps — `tune()` rejects others. */
const _TUNE_LIMITS = Object.freeze({
  puffLifeSec: [0.2, 6], puffRadiusStartM: [0.02, 4], puffRadiusEndM: [0.05, 8],
  puffRiseM: [0, 4], puffOpacity: [0, 1], puffWindDrift: [0, 4], puffRadiusLift: [0, 1],
  puffSatellites: [0, 3], puffSatelliteSpreadM: [0, 2], puffSatelliteScale: [0.1, 2],
  stampRadiusM: [0.1, 3], stampStrengthDry: [0, 1], stampStrengthWet: [0, 1],
  hazeWidthM: [0.5, 30], hazeHeightM: [0.2, 10], hazeSinkM: [0, 2],
  hazeAdvectSpeed: [0, 20], hazeAdvectSpanM: [2, 80], hazeLifeFadeIn: [0.01, 0.5],
  hazeLifeFadeOut: [0.01, 0.5], hazePulseFreq: [0.001, 1], hazeGustSpeedMps: [0, 30],
  hazePulseLo: [0, 1], hazePulseHi: [0, 1], hazeVeilFloor: [0, 1], hazeOpacity: [0, 1],
  hazeNearFadeStartM: [0, 50], hazeNearFadeEndM: [0, 80], hazeForwardScatter: [0, 4],
  hazeIndoorMarginM: [0, 20], hazeIndoorFadeSec: [0, 5],
  hazeSightFadeStart: [0, 4], hazeSightFadeEnd: [0, 6],
  // Mud-print SHADER overrides (the seeds live in terrain.js; null = the seed).
  printDarken: [0, 1], printDryScale: [0, 1], printDepth: [0, 0.03],
});

/** A fresh mutable live-tuning record (defaults + the print overrides off). */
function _freshTuning() {
  return {
    ...DIRT_TUNING,
    hazeColour: DIRT_TUNING.hazeColour.slice(),
    printDarken: null,
    printDryScale: null,
    printDepth: null,
  };
}

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
 * @param {object} [tuning] the live tuning record (default `DIRT_TUNING`)
 * @returns {{radiusM:number, strength:number}}
 */
export function mudStampFor(wetness, printMul, tuning) {
  const T = tuning || DIRT_TUNING;
  const w = Number.isFinite(wetness) ? Math.min(1, Math.max(0, wetness)) : 0;
  const m = Number.isFinite(printMul) && printMul > 0 ? printMul : 1;
  const strength = Math.min(
    1,
    (T.stampStrengthDry
      + (T.stampStrengthWet - T.stampStrengthDry) * w) * m,
  );
  // Wet mud spreads: the blob widens with the water, up to +25 %.
  return { radiusM: T.stampRadiusM * (1 + 0.25 * w), strength };
}

/**
 * Should a footfall at this ground sample throw a puff, and what colour?
 * PURE — the whole "puff colour follows the sampled code / no puff on a
 * water or ice code" contract of the plan's test lives here.
 *
 * @param {{code:number}|null} sample the oracle sample under the foot
 * @param {number} wetness 0..1 — rain lays the dust
 * @param {object} [tuning] the live tuning record (default `DIRT_TUNING`)
 * @returns {{keep:boolean, colour:number[], dust:number, code:number}}
 */
export function puffForGround(sample, wetness, tuning) {
  const T = tuning || DIRT_TUNING;
  const code = sample && Number.isFinite(sample.code) ? (sample.code | 0) : -1;
  const out = { keep: false, colour: [0, 0, 0], dust: 0, code };
  // FAMILY FIRST (plan §2.7.2 — never key off the texture). Water, ice, grass,
  // rock and swamp all fall out here, which is the test's "no puff on a
  // water/ice code".
  if (code < 0 || familyForCode(code) !== FAM_DIRT) return out;
  const v = DIRT_VARIANTS[code];
  if (!v) return out;
  const w = Number.isFinite(wetness) ? Math.min(1, Math.max(0, wetness)) : 0;
  if (w >= T.puffWetCutoff) return out;   // soaked ground does not puff
  const wetFade = 1 - (w / T.puffWetCutoff);
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
 * @param {object} [tuning] the live tuning record (default `DIRT_TUNING`)
 * @returns {number} 0..1
 */
export function dustHazeIntensity(env, tuning) {
  const T = tuning || DIRT_TUNING;
  if (!env) return 0.5;                     // no weather at all ⇒ a middling veil
  const wet = Number.isFinite(env.wetness) ? Math.min(1, Math.max(0, env.wetness)) : 0;
  const dry = 1 - Math.min(1, wet / T.hazeWetKill);
  if (dry <= 0) return 0;
  const tC = Number.isFinite(env.temperatureC) ? env.temperatureC : 15;
  const warm = Math.min(1, Math.max(0,
    (tC - T.hazeColdC) / (T.hazeWarmC - T.hazeColdC)));
  return dry * warm;
}

/**
 * Puff advection — the offset (metres, AC frame) and size of one puff at age
 * `age` seconds. A PURE function of (wind, age, life): no frame history, no
 * `Math.random`. The GLSL in `DIRT_PUFF_VERTEX_GLSL` computes exactly this
 * expression, so the JS is both the test oracle and the readable spec. `r` is
 * the billboard's full width at unit size scale; `z` includes the
 * `puffRadiusLift` that keeps the disc's lower half out of the ground.
 *
 * @param {number} windX AC east component
 * @param {number} windY AC north component
 * @param {number} age   seconds since the puff was emitted
 * @param {number} life  the puff's lifetime in seconds
 * @param {{x:number,y:number,z:number,r:number,a:number}} [out]
 * @param {object} [tuning] the live tuning record (default `DIRT_TUNING`)
 */
export function puffState(windX, windY, age, life, out, tuning) {
  const T = tuning || DIRT_TUNING;
  const o = out || { x: 0, y: 0, z: 0, r: 0, a: 0 };
  const L = Number.isFinite(life) && life > 0 ? life : T.puffLifeSec;
  const t = Number.isFinite(age) ? age : 0;
  if (t < 0 || t > L) { o.x = 0; o.y = 0; o.z = 0; o.r = 0; o.a = 0; return o; }
  const n = t / L;                       // normalised age, 0..1
  o.x = windX * T.puffWindDrift * t;
  o.y = windY * T.puffWindDrift * t;
  o.r = T.puffRadiusStartM
      + (T.puffRadiusEndM - T.puffRadiusStartM) * n;
  // Rises fast then eases — sqrt, not linear: a real puff decelerates. Plus
  // the centre lift that keeps the growing disc's rim at the soil.
  o.z = T.puffRiseM * Math.sqrt(n) + T.puffRadiusLift * o.r;
  // Fast fade-in (a puff APPEARS), long fade-out.
  const fadeIn = Math.min(1, n / 0.12);
  const fadeOut = (1 - n) * (1 - n);
  o.a = fadeIn * fadeOut;
  return o;
}

/**
 * The per-sheet speed multiplier: one of `HAZE_SPEED_STEPS / 8` picked by a
 * 0..1 hash. Quantised so the CPU travel accumulator wraps seamlessly.
 * @param {number} h01
 * @returns {number}
 */
export function hazeSpeedMul(h01) {
  const n = HAZE_SPEED_STEPS.length;
  const h = Number.isFinite(h01) ? Math.min(0.999999, Math.max(0, h01)) : 0.5;
  return HAZE_SPEED_STEPS[Math.floor(h * n)] / 8;
}

/** The travel wrap period for a span (see `HAZE_SPEED_STEPS`). */
export function hazeTravelWrapM(spanM) {
  const s = Number.isFinite(spanM) && spanM > 0 ? spanM : DIRT_TUNING.hazeAdvectSpanM;
  return s * 8 * HAZE_TRAVEL_WRAP_LAPS;
}

const _smooth01 = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / ((e1 - e0) || 1e-9)));
  return t * t * (3 - 2 * t);
};

/**
 * One haze sheet's downwind offset and life envelope — the JS twin of the
 * advection at the top of `DIRT_HAZE_VERTEX_GLSL`. PURE in (travel, phase,
 * speed, span, envelope). `travelM` is the CPU-integrated downwind distance
 * (`uTravel`), so a changing wind magnitude changes the SPEED smoothly instead
 * of re-scaling the whole history (the 2026-10-23 racing bug).
 *
 * @returns {{u:number, s:number, life:number}} s = metres along the wind
 *   (centred on the anchor), life = 0..1 envelope (0 at the recycle seam).
 */
export function hazeAdvect(travelM, phase01, speedMul, spanM, lifeIn, lifeOut, out) {
  const o = out || { u: 0, s: 0, life: 0 };
  const span = Number.isFinite(spanM) && spanM > 0 ? spanM : DIRT_TUNING.hazeAdvectSpanM;
  const x = ((Number.isFinite(travelM) ? travelM : 0) * (Number.isFinite(speedMul) ? speedMul : 1)) / span
    + (Number.isFinite(phase01) ? phase01 : 0);
  const u = x - Math.floor(x);
  o.u = u;
  o.s = (u - 0.5) * span;
  const fi = Number.isFinite(lifeIn) ? lifeIn : DIRT_TUNING.hazeLifeFadeIn;
  const fo = Number.isFinite(lifeOut) ? lifeOut : DIRT_TUNING.hazeLifeFadeOut;
  o.life = _smooth01(0, fi, u) * (1 - _smooth01(1 - fo, 1, u));
  return o;
}

/**
 * One haze sheet's view fade, 0..1 — the JS twin of the `near` term in
 * `DIRT_HAZE_VERTEX_GLSL` (2026-10-24). All positions are FLAT (any horizontal
 * frame, metres): the sheet's (advected) anchor, the camera and the avatar.
 * The product of the camera window (`hazeNearFadeStartM -> EndM` on the flat
 * camera distance: no card in the camera's face) and the SIGHTLINE window
 * (`hazeSightFadeStart -> End` on the flat distance to the camera -> avatar
 * segment, in units of the sheet's half-width: no sheet over the player).
 * The start clamps mirror `applyTuning` (a GLSL smoothstep needs e0 < e1).
 *
 * @param {number} widthM the sheet's full width (aScale.x)
 * @param {object} [tuning] defaults to DIRT_TUNING
 * @returns {number}
 */
export function hazeNearFade(ax, ay, camX, camY, avX, avY, widthM, tuning) {
  const T = tuning || DIRT_TUNING;
  const fx = camX - ax, fy = camY - ay;            // flatCam (anchor -> camera)
  const flatLen = Math.hypot(fx, fy);
  const sx = avX - camX, sy = avY - camY;          // seg (camera -> avatar)
  const l2 = sx * sx + sy * sy;
  const t = l2 > 1e-4 ? Math.min(1, Math.max(0, (-fx * sx - fy * sy) / l2)) : 0;
  const hw = Math.max(0.5 * (Number.isFinite(widthM) ? widthM : T.hazeWidthM), 0.25);
  const sightN = Math.hypot(fx + sx * t, fy + sy * t) / hw;
  const nearEnd = T.hazeNearFadeEndM, sightEnd = T.hazeSightFadeEnd;
  return _smooth01(Math.min(T.hazeNearFadeStartM, nearEnd - 0.01), nearEnd, flatLen)
    * _smooth01(Math.min(T.hazeSightFadeStart, sightEnd - 0.01), sightEnd, sightN);
}

/**
 * The light a dust particle receives, as a per-channel multiplier on its
 * albedo — the JS twin of the GLSL in both dirt shaders, and THE RETAIL TERRAIN
 * FORMULA for a flat (+Z) receiver: `min(1, sunColor * max(0, sunVec.z) +
 * ambColor * ambLevel)` (terrain.js, RND-20/21: `|sunVec|` IS dirBright, so the
 * sun term is 0 at night and the ambient floor carries the dark). Dust is lit
 * like the ground it lifts off, so it darkens with it and never glows.
 *
 * @param {{sunVec:number[], sunCol:number[], amb:number[]}} light AC frame
 * @param {number} [forward] extra forward-scatter weight (0..1 phase x gain)
 * @param {number[]} [out]
 */
export function dustLitFactor(light, forward, out) {
  const o = out || [0, 0, 0];
  const sv = light && light.sunVec ? light.sunVec : [0, 0, 0];
  const sc = light && light.sunCol ? light.sunCol : [0, 0, 0];
  const am = light && light.amb ? light.amb : [0, 0, 0];
  const dirB = Math.hypot(sv[0], sv[1], sv[2]);
  const k = Math.max(0, sv[2]) + (Number.isFinite(forward) ? Math.max(0, forward) : 0) * dirB;
  for (let i = 0; i < 3; i += 1) o[i] = Math.min(1, sc[i] * k + am[i]);
  return o;
}

// Componentwise copy: Vector3 / Color / plain {x,y,z} or {r,g,b} source into
// an {x,y,z} (Vector3-like) target. Module scope, no per-frame closure.
function _copy3(dst, src, scale) {
  if (!dst || !src) return;
  const k = Number.isFinite(scale) ? scale : 1;
  if ("x" in src) { dst.x = src.x * k; dst.y = src.y * k; dst.z = src.z * k; }
  else { dst.x = src.r * k; dst.y = src.g * k; dst.z = src.b * k; }
}

/**
 * Copy the TERRAIN's live retail light (`uAcSunVec`, `uAcSunColor`,
 * `uAcAmbColor x uAcAmbLevel`) off the FIRST terrain material that carries it
 * (every terrain material gets the same values from `loop.js`) into a dust
 * light record `{uSunVec, uSunCol, uAmbCol}` of `{value: {x,y,z}}` entries —
 * the same entries both dirt materials hold BY REFERENCE. Indexed loop, no
 * allocation. The `terrain_snow.js::copyTerrainLighting` /
 * `terrain_sand.js::setTerrainLight` shape, duplicated rather than imported
 * for the reason `windAcFromGlobals` records.
 *
 * @returns {boolean} a source was found
 */
export function copyTerrainLight(materials, light) {
  if (!light || !materials || typeof materials.length !== "number") return false;
  // Prefer a material `loop.js` has already LIT (it stamps
  // `userData.__acLightEpoch`); a landblock baked this frame still carries the
  // seed uniforms (a black sun) until the next light pass reaches it.
  let src = null;
  let fallback = null;
  for (let i = 0; i < materials.length; i += 1) {
    const m = materials[i];
    const u = m && m.uniforms;
    if (!(u && u.uAcSunVec && u.uAcSunColor && u.uAcAmbColor && u.uAcAmbLevel)) continue;
    if (!m.userData || m.userData.__acLightEpoch !== undefined) { src = u; break; }
    if (!fallback) fallback = u;
  }
  if (!src) src = fallback;
  if (!src || !src.uAcSunVec.value || !src.uAcSunColor.value || !src.uAcAmbColor.value) return false;
  const lvl = Number.isFinite(src.uAcAmbLevel.value) ? src.uAcAmbLevel.value : 0.2;
  _copy3(light.uSunVec.value, src.uAcSunVec.value, 1);
  _copy3(light.uSunCol.value, src.uAcSunColor.value, 1);
  _copy3(light.uAmbCol.value, src.uAcAmbColor.value, lvl);
  light.fromTerrain = true;
  return true;
}

/**
 * A dust light record with neutral NOON defaults (lit ≈ albedo) — used until
 * the first terrain material exists, and headless. `THREE` optional: the
 * entries are real `Vector3`s when it is given (the uniform upload wants them),
 * plain `{x,y,z}` otherwise.
 */
export function createDustLight(THREE) {
  const v3 = (x, y, z) => (THREE && typeof THREE.Vector3 === "function"
    ? new THREE.Vector3(x, y, z) : { x, y, z });
  return {
    uSunVec: { value: v3(0, 0, 0.75) },
    uSunCol: { value: v3(1, 1, 1) },
    uAmbCol: { value: v3(0.3, 0.3, 0.3) },
    fromTerrain: false,
  };
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
attribute vec4 aPuffCfg;   // (life, dust, seed01, sizeScale)
attribute vec3 aPuffColour;

uniform float uTime;       // the SHARED clock, bound by reference (plan 5.6)
uniform vec2  uWindAc;     // AC ground wind (+X east, +Y north), live
uniform float uRiseM;
uniform float uDrift;
uniform float uRadiusStart;
uniform float uRadiusEnd;
uniform float uRadiusLift;
// The terrain's own retail light, copied each frame (AC frame; the length of
// uSunVec IS dirBright, 0 at night). Dust is lit like the flat ground it
// lifts off, so it darkens with it and never glows.
uniform vec3  uSunVec;
uniform vec3  uSunCol;
uniform vec3  uAmbCol;

varying vec2 vQuadUv;
varying float vAlpha;
varying vec3 vColour;
varying vec2 vLobe;

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

  float radius = mix(uRadiusStart, uRadiusEnd, clamp(n, 0.0, 1.0)) * alive * max(aPuffCfg.w, 0.0);
  // The quad is centred on its origin: lift it by a fraction of its live
  // width so the growing disc keeps its faint rim at the soil instead of
  // being clipped by the ground along a hard line.
  origin.z += uRadiusLift * radius;

  float fadeIn = clamp(n / 0.12, 0.0, 1.0);
  float fadeOut = (1.0 - clamp(n, 0.0, 1.0)) * (1.0 - clamp(n, 0.0, 1.0));
  vAlpha = fadeIn * fadeOut * aPuffCfg.y * alive;
  // JS twin: terrain_dirt.js::dustLitFactor (flat receiver, no forward term).
  vec3 lit = min(vec3(1.0), uSunCol * max(uSunVec.z, 0.0) + uAmbCol);
  vColour = aPuffColour * lit;
  vQuadUv = uv;
  // Rim lobes phase, from the seed (no clock, no rand).
  float ph = aPuffCfg.z * 6.2831853;
  vLobe = vec2(cos(ph), sin(ph));

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
varying vec2 vLobe;

void main() {
  // A soft round puff with a LUMPY rim (three seeded lobes), so a burst reads
  // as a small cloud rather than a disc, and a slightly thinner core, which is
  // what a real dust burst looks like: the rim carries the light.
  vec2 d = vQuadUv * 2.0 - 1.0;
  float r = length(d);
  // cos(3 theta + phase) from the triple-angle identities on the unit
  // direction, never an arctangent: the angle of (0, 0) is undefined, and a
  // NaN here would poison the HDR target's bloom.
  vec2 u = d / max(r, 1e-4);
  float c3 = 4.0 * u.x * u.x * u.x - 3.0 * u.x;
  float s3 = 3.0 * u.y - 4.0 * u.y * u.y * u.y;
  float lobe = 0.86 + 0.14 * (c3 * vLobe.x - s3 * vLobe.y);
  float disc = 1.0 - smoothstep(0.3 * lobe, lobe, r);
  float core = mix(0.75, 1.0, smoothstep(0.0, 0.55, r));
  float a = disc * core * vAlpha * uOpacity;
  if (a <= 0.0) discard;
  gl_FragColor = vec4(vColour, a);
}
`;

// ---------------------------------------------------------------------------
// The dry dust haze — GLSL (2026-10-23 rewrite). An UPRIGHT camera-facing
// sheet about the world vertical (a dust LAYER seen side-on), drifting
// downwind over a short span behind a life envelope, in gust banks that drift
// downwind too, lit by the terrain's own light. Alpha (not additive) blend:
// dust OCCLUDES, it does not glow.
// ---------------------------------------------------------------------------

/** The sine-free value-noise helpers both haze stages carry (ASCII GLSL). */
const DIRT_HAZE_NOISE_GLSL = `
// Hash WITHOUT sine: fract first, so it stays stable for the large world
// coordinates the gust field feeds it (sin of a 1e5 argument is not portable).
float dirtHash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float dirtNoise2D(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = dirtHash21(i);
  float b = dirtHash21(i + vec2(1.0, 0.0));
  float c = dirtHash21(i + vec2(0.0, 1.0));
  float d = dirtHash21(i + vec2(1.0, 1.0));
  vec2 w = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}
`;

export const DIRT_HAZE_VERTEX_GLSL = `
precision highp float;

attribute vec3 aOffset;    // AC world anchor (x, y, z = ground), from the pool
attribute vec2 aScale;     // (width, height) metres; (0, 0) on a rejected slot
attribute vec4 aDrift;     // (phase01, speedMul, hazeWeight, alpha)
attribute vec3 aNormal;    // AC ground normal at the anchor, from the pool
attribute vec3 aTint;      // the per-code dust albedo, linear

uniform vec2  uWindAc;     // AC ground wind (+X east, +Y north), live
uniform float uTravel;     // CPU-integrated downwind travel, metres
uniform vec2  uGustOffset; // CPU-integrated gust-field drift, metres (AC)
uniform float uSpanM;
uniform float uLifeIn;
uniform float uLifeOut;
uniform float uPulseFreq;
uniform float uPulseLo;
uniform float uPulseHi;
uniform float uVeilFloor;
uniform float uDryness;    // 0..1 from dustHazeIntensity()
uniform highp float uSinkM; // read by BOTH stages: highp in both, explicitly
uniform float uNearStart;
uniform float uNearEnd;
uniform vec3  uAvatarAc;   // the player (AC frame), live: the sightline's far end
uniform float uSightStart; // in units of the sheet's half-width
uniform float uSightEnd;
uniform float uForward;
uniform float uOpacity;    // read here only for the zero-area cull below
uniform vec3  uSunVec;     // the terrain's retail light, AC frame
uniform vec3  uSunCol;
uniform vec3  uAmbCol;

varying vec2 vQuadUv;
varying float vAlpha;
varying vec3 vColour;
varying vec2 vWisp;

${SCATTER_FADE_GLSL}
${DIRT_HAZE_NOISE_GLSL}

void main() {
  float wl = length(uWindAc);
  vec2 dir = wl > 1e-4 ? uWindAc / wl : vec2(1.0, 0.0);

  // --- the JS twin is terrain_dirt.js::hazeAdvect ---------------------------
  // uTravel is INTEGRATED from the live wind on the CPU, so a gust changes the
  // drift SPEED smoothly; it is never the absolute clock times the live wind
  // magnitude (that re-scales the whole history every frame and races).
  float u = fract(uTravel * aDrift.y / uSpanM + aDrift.x);
  float s = (u - 0.5) * uSpanM;
  float life = smoothstep(0.0, uLifeIn, u) * (1.0 - smoothstep(1.0 - uLifeOut, 1.0, u));
  vec2 adv = dir * s;

  // A rejected / out-of-window slot carries aScale (0, 0): zero area below.
  float live = step(1e-3, aScale.x * aScale.y);

  // Follow the ground PLANE at the anchor (the pool's scattered normal), so a
  // sheet drifting across a hillside neither floats off it nor buries itself.
  float nz = max(aNormal.z, 0.35);
  float rise = clamp(-(aNormal.x * adv.x + aNormal.y * adv.y) / nz, -3.0, 3.0);
  vec3 placed = vec3(aOffset.xy + adv, aOffset.z + rise);

  // UPRIGHT CAMERA-FACING BILLBOARD about the world vertical, built in three
  // world space. modelMatrix (worldRoot) carries AC +Z to world up, so this
  // is frame-agnostic. Never edge-on, never tilted into the ground.
  vec4 wAnchor = modelMatrix * vec4(placed, 1.0);
  vec3 upW = normalize((modelMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
  vec3 toCam = cameraPosition - wAnchor.xyz;
  vec3 flatCam = toCam - upW * dot(toCam, upW);
  float flatLen = length(flatCam);
  vec3 side = flatLen > 1e-3 ? cross(upW, flatCam / flatLen) : vec3(1.0, 0.0, 0.0);

  // Gust BANKS: world-anchored noise drifting DOWNWIND (the offset grows
  // along +wind, so a feature at noise q sits at q / f + offset).
  vec2 gp = (placed.xy - uGustOffset) * uPulseFreq;
  float g = 0.65 * dirtNoise2D(gp) + 0.35 * dirtNoise2D(gp * 2.3 + vec2(17.0, 5.0));
  float veil = mix(uVeilFloor, 1.0, smoothstep(uPulseLo, uPulseHi, g));

  // The pool's LIVE distance fade (never the frozen scatter-time one), the
  // near-camera fade (no card in the chase camera's face) and the SIGHTLINE
  // fade (no veiled player): the flat distance from the sheet to the camera ->
  // avatar segment, in units of the sheet's own half-width, since its side
  // mask is ~0 past one half-width. JS twin: terrain_dirt.js::hazeNearFade.
  float fade = hbScatterFade(placed.xy);
  vec3 toAv = (modelMatrix * vec4(uAvatarAc, 1.0)).xyz - cameraPosition;
  vec3 seg = toAv - upW * dot(toAv, upW);
  float segL2 = dot(seg, seg);
  float tSeg = segL2 > 1e-4 ? clamp(-dot(flatCam, seg) / segL2, 0.0, 1.0) : 0.0;
  float sightN = length(flatCam + seg * tSeg) / max(0.5 * aScale.x, 0.25);
  float near = smoothstep(uNearStart, uNearEnd, flatLen) * smoothstep(uSightStart, uSightEnd, sightN);
  vAlpha = veil * fade * near * life * aDrift.w * clamp(uDryness, 0.0, 1.0) * live;
  // A sheet with nothing to show (inside the near fade, at its recycle seam,
  // past the window, or rain-laid) collapses to ZERO AREA: a sheet a metre
  // from the camera would otherwise rasterise a full screen of discards. The
  // threshold is the fragment stage's own discard (peak alpha <= 0.002).
  float keep = step(0.002, vAlpha * uOpacity);

  float w = aScale.x * live * keep;
  float h = aScale.y * live * keep;
  // SHEAR the sheet along the ground PLANE at its anchor: each column drops or
  // rises with the plane at its lateral offset, so the whole foot sits uSinkM
  // under the soil and the fragment's foot ramp (measured from the ground)
  // holds across a lateral slope, not only on the flat. A zero normal (a dead
  // slot) falls back to flat; the shear is bounded like the drift rise.
  vec3 nRaw = (modelMatrix * vec4(aNormal, 0.0)).xyz;
  float nLen = length(nRaw);
  vec3 nW = nLen > 1e-4 ? nRaw / nLen : upW;
  float xM = position.x * w;
  float shear = clamp(-dot(nW, side) * xM / max(dot(nW, upW), 0.35), -3.0, 3.0);
  float yUp = (position.y + 0.5) * h - uSinkM * live * keep + shear;
  vec3 wp = wAnchor.xyz + side * xM + upW * yUp;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);

  // LIT like flat ground (JS twin: dustLitFactor), plus forward scatter when
  // the view looks toward the sun (x dirBright: zero at night).
  float dirB = length(uSunVec);
  vec3 sunW = (modelMatrix * vec4(uSunVec, 0.0)).xyz;
  float sunWl = length(sunW);
  vec3 vd = wp - cameraPosition;
  vec3 viewW = vd / max(length(vd), 1e-4);
  float cosT = sunWl > 1e-6 ? dot(viewW, sunW / sunWl) : 0.0;
  float f2 = max(cosT, 0.0);
  f2 *= f2;
  f2 *= f2;
  float fwd = f2 * f2;
  vec3 lit = min(vec3(1.0), uSunCol * (max(uSunVec.z, 0.0) + uForward * fwd * dirB) + uAmbCol);
  vColour = aTint * lit;

  vQuadUv = uv;
  vWisp = vec2(position.x * w + aDrift.x * 53.0, (position.y + 0.5) * h);
}
`;

export const DIRT_HAZE_FRAGMENT_GLSL = `
precision highp float;

uniform float uOpacity;
uniform highp float uSinkM; // the foot's depth under the soil; highp in both stages

varying vec2 vQuadUv;
varying float vAlpha;
varying vec3 vColour;
varying vec2 vWisp;        // (along-sheet metres + phase, metres above the quad bottom)

${DIRT_HAZE_NOISE_GLSL}

void main() {
  // Soft sides; a ground-hugging vertical profile, densest under half-height,
  // feathering out on top. No hard edge anywhere, or a sheet reads as a card.
  // The FOOT ramp is measured from the GROUND: the quad bottom sits uSinkM
  // under the soil plane (sheared along it), so vWisp.y - uSinkM is the
  // height above the ground and the alpha is exactly zero where the sheet
  // meets it, rising over the first 0.45 m. A ramp in quad uv started under
  // the soil and met flat ground at a fifth to a half of the peak: a hard line.
  float x = abs(vQuadUv.x * 2.0 - 1.0);
  float sideMask = 1.0 - smoothstep(0.3, 1.0, x);
  float y = vQuadUv.y;
  float prof = smoothstep(uSinkM, uSinkM + 0.45, vWisp.y) * (1.0 - smoothstep(0.45, 1.0, y));
  float base = sideMask * prof * vAlpha * uOpacity;
  // Early out BEFORE the noise: the soft rim of every sheet is most of its area.
  if (base <= 0.002) discard;
  // Streaky wisps: two octaves of value noise stretched along the sheet.
  float n1 = dirtNoise2D(vec2(vWisp.x * 0.35, vWisp.y * 1.6));
  float n2 = dirtNoise2D(vec2(vWisp.x * 0.9 + 7.0, vWisp.y * 3.1 + 3.0));
  float wisp = mix(0.4, 1.0, smoothstep(0.25, 0.75, 0.65 * n1 + 0.35 * n2));
  gl_FragColor = vec4(vColour, base * wisp);
}
`;

/** The per-instance attribute schema the pool allocates for the haze field.
 *  `aNormal` is written by the pool itself (its `normalAttr`). */
export const DIRT_HAZE_SCHEMA = Object.freeze([
  { name: "aOffset", itemSize: 3 },
  { name: "aScale", itemSize: 2 },
  { name: "aDrift", itemSize: 4 },
  { name: "aNormal", itemSize: 3 },
  { name: "aTint", itemSize: 3 },
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
    Number.isFinite(opts.capacity) ? opts.capacity : 96));
  const seed = (Number.isFinite(opts.seed) ? opts.seed : 0x3d17b00b) | 0;
  const globals = opts.globals || null;
  // The LIVE tuning record: the module passes its mutable copy (so `tune()`
  // reaches emit-time values too); a standalone field gets its own.
  const tuning = opts.liveTuning || { ...DIRT_TUNING, ...(opts.tuning || {}) };
  // The dust light, shared BY REFERENCE with the haze field when the module
  // builds both (one per-frame copy off the terrain material feeds both).
  const light = opts.light || createDustLight(THREE);

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
    uRadiusLift: { value: tuning.puffRadiusLift },
    uOpacity: { value: tuning.puffOpacity },
    uSunVec: light.uSunVec,
    uSunCol: light.uSunCol,
    uAmbCol: light.uAmbCol,
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
      material = new THREE.ShaderMaterial(withLogDepth({
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
      }));
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
  const state = { cursor: 0, emitted: 0, dropped: 0, frames: 0, live: 0, counter: 0, bursts: 0 };

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
   * @param {number} [sizeScale=1] multiplies the puff's width (satellites < 1)
   * @param {number} [lifeScale=1] multiplies its jittered life
   * @returns {boolean} was a slot written?
   */
  function emit(x, y, z, tSec, colour, dust, sizeScale, lifeScale) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
    if (!(dust > 0)) { state.dropped += 1; return false; }
    const i = state.cursor % capacity;
    state.cursor = (state.cursor + 1) % capacity;
    state.counter += 1;
    const qx = Math.round(x * 4) | 0;
    const qy = Math.round(y * 4) | 0;
    const h1 = scatterHash01(qx, qy, state.counter, seed);
    const h2 = scatterHash01(qy, state.counter, qx, seed ^ 0x51ed270b);
    const ls = Number.isFinite(lifeScale) && lifeScale > 0 ? lifeScale : 1;
    const life = tuning.puffLifeSec * ls * (1 + (h1 - 0.5) * 2 * tuning.puffLifeJitter);
    aPuff[i * 4] = x;
    aPuff[i * 4 + 1] = y;
    aPuff[i * 4 + 2] = z + tuning.puffLiftM;
    aPuff[i * 4 + 3] = Number.isFinite(tSec) ? tSec : 0;
    aPuffCfg[i * 4] = Math.max(0.05, life);
    aPuffCfg[i * 4 + 1] = Math.min(1, Math.max(0, dust));
    aPuffCfg[i * 4 + 2] = h2;
    aPuffCfg[i * 4 + 3] = Number.isFinite(sizeScale) && sizeScale > 0 ? sizeScale : 1;
    const c = colour || DIRT_TUNING.hazeColour;
    aPuffColour[i * 3] = c[0];
    aPuffColour[i * 3 + 1] = c[1];
    aPuffColour[i * 3 + 2] = c[2];
    state.emitted += 1;
    _markDirty();
    return true;
  }

  /**
   * One FOOTFALL's burst: the main puff plus `puffSatellites` smaller ones,
   * each offset by a hashed direction and born `puffSatelliteDelaySec` later
   * (an unborn slot is zero-area until its birth — the shader's `alive`), so a
   * footfall reads as a small cloud kicked up, not one ball. Deterministic.
   *
   * @returns {number} slots written
   */
  function burst(x, y, z, tSec, colour, dust) {
    if (!emit(x, y, z, tSec, colour, dust, 1, 1)) return 0;
    state.bursts += 1;
    let n = 1;
    const sats = Math.max(0, Math.min(3, Math.round(tuning.puffSatellites || 0)));
    for (let k = 0; k < sats; k += 1) {
      const h = scatterHash01(Math.round(x * 4) | 0, Math.round(y * 4) | 0, state.counter + 101 * (k + 1), seed ^ 0x2c1b3c6d);
      const ang = h * Math.PI * 2;
      const r = tuning.puffSatelliteSpreadM * (0.6 + 0.4 * h);
      const t0 = (Number.isFinite(tSec) ? tSec : 0) + tuning.puffSatelliteDelaySec * (k + 1);
      if (emit(x + Math.cos(ang) * r, y + Math.sin(ang) * r, z, t0, colour, dust * 0.85,
        tuning.puffSatelliteScale, 0.85)) n += 1;
    }
    return n;
  }

  /** Re-read the live tuning into the uniforms (after `tune()`). Zero-alloc. */
  function applyTuning() {
    uniforms.uRiseM.value = tuning.puffRiseM;
    uniforms.uDrift.value = tuning.puffWindDrift;
    uniforms.uRadiusStart.value = tuning.puffRadiusStartM;
    uniforms.uRadiusEnd.value = tuning.puffRadiusEndM;
    uniforms.uRadiusLift.value = tuning.puffRadiusLift;
    uniforms.uOpacity.value = tuning.puffOpacity;
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
    tuning,
    light,
    /** false ⇒ `uniforms.uTime` IS `VFX_GLOBALS.uTime` (bound by identity). */
    ownsClock: _ownsClock,
    get mesh() { return mesh; },
    get material() { return material; },
    get geometry() { return geometry; },
    /** Raw buffers — the test seam (read-only by convention). */
    buffers: { aPuff, aPuffCfg, aPuffColour },
    emit,
    burst,
    applyTuning,
    update,
    /** The CPU twin of the shader, for diagnostics and tests. */
    stateOf(index, tSec, out) {
      const i = ((index | 0) % capacity + capacity) % capacity;
      windAcFromGlobals(globals, wind);
      const age = (Number.isFinite(tSec) ? tSec : 0) - aPuff[i * 4 + 3];
      const s = puffState(wind.x, wind.y, age, aPuffCfg[i * 4], out, tuning);
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
        bursts: state.bursts,
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
 * @param {object} [opts.light]    the shared dust light (`createDustLight`).
 * @param {object} [opts.liveTuning] the module's mutable tuning record.
 */
export function createDustHazeField(opts = {}) {
  const THREE = opts.THREE || null;
  const count = Math.max(1, Math.round(Number.isFinite(opts.count) ? opts.count : 800));
  const radiusM = Math.min(512, Math.max(8, Number.isFinite(opts.radiusM) ? opts.radiusM : 56));
  const seed = (Number.isFinite(opts.seed) ? opts.seed : 0x3d17b00b) | 0;
  const globals = opts.globals || null;
  const tuning = opts.liveTuning || { ...DIRT_TUNING, ...(opts.tuning || {}) };
  const light = opts.light || createDustLight(THREE);

  let geometry = null;
  let material = null;

  // THE UNIFORM BAG. Built FIRST and handed to the ShaderMaterial AND to the
  // pool via `opts.uniforms` (wave 2A), so the pool publishes its four
  // distance-blend uniforms straight into the bag the compiled shader already
  // holds — no placeholder-then-repoint dance. `uTime` stays adopted BY
  // IDENTITY (plan §5.6) for the diagnostics/clock contract even though the
  // 2026-10-23 shader drives its motion from the CPU-integrated `uTravel` /
  // `uGustOffset` instead (see `update`).
  const _sharedTime = globals && globals.uTime && typeof globals.uTime === "object"
    ? globals.uTime
    : null;
  const _ownsClock = _sharedTime === null;
  const v2 = (x, y) => (THREE && typeof THREE.Vector2 === "function" ? new THREE.Vector2(x, y) : { x, y });
  const uniforms = {
    uTime: _sharedTime || { value: 0 },
    uWindAc: { value: v2(1, 0) },
    uTravel: { value: 0 },
    uGustOffset: { value: v2(0, 0) },
    uSpanM: { value: tuning.hazeAdvectSpanM },
    uLifeIn: { value: tuning.hazeLifeFadeIn },
    uLifeOut: { value: tuning.hazeLifeFadeOut },
    uPulseFreq: { value: tuning.hazePulseFreq },
    uPulseLo: { value: tuning.hazePulseLo },
    uPulseHi: { value: tuning.hazePulseHi },
    uVeilFloor: { value: tuning.hazeVeilFloor },
    uDryness: { value: 1 },
    uSinkM: { value: tuning.hazeSinkM },
    uNearStart: { value: tuning.hazeNearFadeStartM },
    uNearEnd: { value: tuning.hazeNearFadeEndM },
    // The sightline (2026-10-24): the avatar's AC position, copied per frame in
    // `update`, and the half-width-unit window (JS twin: hazeNearFade).
    uAvatarAc: { value: THREE && typeof THREE.Vector3 === "function" ? new THREE.Vector3(0, 0, 0) : { x: 0, y: 0, z: 0 } },
    uSightStart: { value: Math.min(tuning.hazeSightFadeStart, tuning.hazeSightFadeEnd - 0.01) },
    uSightEnd: { value: tuning.hazeSightFadeEnd },
    uForward: { value: tuning.hazeForwardScatter },
    uOpacity: { value: tuning.hazeOpacity },
    uSunVec: light.uSunVec,
    uSunCol: light.uSunCol,
    uAmbCol: light.uAmbCol,
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
      uniforms.uScatterCenter.value = new THREE.Vector3(0, 0, 0);
      material = new THREE.ShaderMaterial(withLogDepth({
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
      }));
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
    // 2026-10-23 — no sheet near a building (see DIRT_TUNING.hazeIndoorMarginM).
    exclude: typeof opts.exclude === "function" ? opts.exclude : undefined,
    // DesolateLands BIAS (plan §3.7 item 3) — as DENSITY: the per-code weight
    // is the accept probability. Rejected quads are written degenerate
    // (zero-area), i.e. one vertex invocation and nothing else.
    accept(sample, ctx) {
      const v = DIRT_VARIANTS[ctx.code];
      const weight = v ? v.haze : 0;
      if (!(weight > 0)) return false;
      return ctx.rand(9) < weight;
    },
    fill(ctx) {
      // Size, jittered per sheet. The anchor stays ON the ground (the shader
      // sinks the foot `hazeSinkM` and lifts the body with the profile).
      const wJ = 1 + (ctx.rand(4) - 0.5) * 2 * tuning.hazeSizeJitter;
      const hJ = 1 + (ctx.rand(3) - 0.5) * 2 * tuning.hazeSizeJitter;
      ctx.set("aScale", tuning.hazeWidthM * wJ, tuning.hazeHeightM * hJ);
      const v = DIRT_VARIANTS[ctx.code];
      const weight = v ? v.haze : 0;
      // NOT x ctx.fade: that is the pool's SCATTER-TIME fade, frozen at
      // placement — a leading-edge sheet is placed at the rim (fade ~0) and
      // would stay invisible as the player walks onto it (the 2026-10-23 bug).
      // The shader applies the LIVE fade (hbScatterFade). And NOT x weight:
      // the weight already thinned the field through `accept`.
      ctx.set(
        "aDrift",
        ctx.rand(5),                       // advection phase
        hazeSpeedMul(ctx.rand(6)),         // quantised k/8 (seamless wrap)
        weight,                            // published for diagnosis
        0.6 + ctx.rand(8) * 0.4,           // per-sheet alpha
      );
      const c = v ? v.puff : tuning.hazeColour;
      ctx.set("aTint", c[0], c[1], c[2]);
    },
    oracle: opts.oracle,
    geometry,
    material,
    parent: opts.parent || null,
    writeInstanceMatrix: true,   // stock-material-safe degenerates (pool contract)
    frustumCulled: false,        // the window follows the player
  });

  let mesh = pool.mesh || null;
  if (mesh) {
    mesh.name = "terrain-dirt-haze";
    mesh.castShadow = false;      // §5.7
    mesh.receiveShadow = false;
    mesh.renderOrder = 2;
  }

  const state = {
    frames: 0, lastRescattered: 0, dryness: 1, built: !!mesh,
    travel: 0, gustX: 0, gustY: 0, wraps: 0,
  };

  /** Re-read the live tuning into the uniforms (after `tune()`). Zero-alloc. */
  function applyTuning() {
    uniforms.uSpanM.value = Math.max(2, tuning.hazeAdvectSpanM);
    uniforms.uLifeIn.value = tuning.hazeLifeFadeIn;
    uniforms.uLifeOut.value = tuning.hazeLifeFadeOut;
    uniforms.uPulseFreq.value = tuning.hazePulseFreq;
    uniforms.uPulseLo.value = Math.min(tuning.hazePulseLo, tuning.hazePulseHi - 0.01);
    uniforms.uPulseHi.value = tuning.hazePulseHi;
    uniforms.uVeilFloor.value = tuning.hazeVeilFloor;
    uniforms.uSinkM.value = tuning.hazeSinkM;
    uniforms.uNearStart.value = Math.min(tuning.hazeNearFadeStartM, tuning.hazeNearFadeEndM - 0.01);
    uniforms.uNearEnd.value = tuning.hazeNearFadeEndM;
    uniforms.uSightStart.value = Math.min(tuning.hazeSightFadeStart, tuning.hazeSightFadeEnd - 0.01);
    uniforms.uSightEnd.value = tuning.hazeSightFadeEnd;
    uniforms.uForward.value = tuning.hazeForwardScatter;
    uniforms.uOpacity.value = tuning.hazeOpacity;
  }

  return {
    pool,
    uniforms,
    tuning,
    light,
    ownsClock: _ownsClock,
    get mesh() { return mesh; },
    get material() { return material; },
    get geometry() { return geometry; },
    applyTuning,
    /**
     * Per-frame. The drift is INTEGRATED from the live shared wind: travel
     * (scalar, metres downwind) and the gust-field offset (2-D, metres) each
     * advance by `dt x speed x wind` — so a gust or the 45 s direction wander
     * changes the motion smoothly. `dt` is clamped (a tab resume must not
     * jump), and the travel wraps SEAMLESSLY (see `HAZE_SPEED_STEPS`). The gust
     * offset is not wrapped: at 2.6 m/s it reaches 1e5 m in ~11 h, where
     * float32 still resolves ~1 cm. Zero-alloc.
     */
    update(dt, tSec, px, py, pz, dryness) {
      state.frames += 1;
      windAcFromGlobals(globals, wind);
      if (_ownsClock) uniforms.uTime.value = Number.isFinite(tSec) ? tSec : 0;
      const wv = uniforms.uWindAc.value;
      if (wv) { wv.x = wind.x; wv.y = wind.y; }
      const d = Number.isFinite(dt) ? Math.min(0.25, Math.max(0, dt)) : 0;
      const wl = Math.hypot(wind.x, wind.y);
      state.travel += d * tuning.hazeAdvectSpeed * wl;
      const wrap = hazeTravelWrapM(uniforms.uSpanM.value);
      if (state.travel >= wrap) { state.travel -= wrap; state.wraps += 1; }
      state.gustX += d * tuning.hazeGustSpeedMps * wind.x;
      state.gustY += d * tuning.hazeGustSpeedMps * wind.y;
      uniforms.uTravel.value = state.travel;
      const go = uniforms.uGustOffset.value;
      if (go) { go.x = state.gustX; go.y = state.gustY; }
      state.dryness = Number.isFinite(dryness) ? Math.min(1, Math.max(0, dryness)) : 1;
      uniforms.uDryness.value = state.dryness;
      // The sightline's far end: the player the window is centred on (AC).
      const av = uniforms.uAvatarAc.value;
      if (av && Number.isFinite(px) && Number.isFinite(py)) {
        av.x = px; av.y = py; av.z = Number.isFinite(pz) ? pz : av.z;
      }
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
        travelM: state.travel,
        travelWraps: state.wraps,
        gustOffset: { x: state.gustX, y: state.gustY },
        sightAvatar: { x: uniforms.uAvatarAc.value.x, y: uniforms.uAvatarAc.value.y },
        light: {
          fromTerrain: light.fromTerrain === true,
          sunVec: [light.uSunVec.value.x, light.uSunVec.value.y, light.uSunVec.value.z],
          sunCol: [light.uSunCol.value.x, light.uSunCol.value.y, light.uSunCol.value.z],
          amb: [light.uAmbCol.value.x, light.uAmbCol.value.y, light.uAmbCol.value.z],
        },
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
 * `uSnowTrailEnabled` stays snow's.
 *
 * Both families may run at once. While BOTH have a live map they write
 * identical values into the shared entries, so the write order does not matter
 * — but that is only true for the has-a-map case, and the ABSENT-map case is
 * the one that bites: whichever family writes `null` into the shared sampler
 * disables the OTHER family's still-gated read. So the rule (2026-08-03, now
 * symmetric in both files) is: touch the shared entries ONLY when you have a
 * map, and clear nothing but your own gate.
 *
 * With `trail` null every material is driven to `uMudTrailEnabled = 0` — the
 * ABSENT-MAP contract (grass precedent): no lazy-ensure, no error, no print.
 *
 * LIVE PRINT KNOBS (2026-10-23). `overrides` — the live tuning record's
 * `printDarken` / `printDryScale` / `printDepth` — are written onto the
 * matching shader uniforms when FINITE, and left alone when null, so the
 * `terrain.js` seeds (`DEFAULT_MUD_PRINT_*`) stay the single source of truth
 * for the shipped values and `window.__terrainDirt.tune({printDarken: 0.5})`
 * still reaches every material, including ones baked after the call.
 *
 * @param {Array<object>|null} materials `scene3d.terrainMaterials`
 * @param {object|null} trail the `trail_map.js` handle, or null
 * @param {number} wetness 0..1 (`mudWetnessFrom`)
 * @param {{printDarken?:number|null, printDryScale?:number|null,
 *   printDepth?:number|null}|null} [overrides]
 * @returns {number} materials touched
 */
export function pushMudTrailUniforms(materials, trail, wetness, overrides) {
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
    if (overrides) {
      if (Number.isFinite(overrides.printDarken) && u.uMudPrintDarken) u.uMudPrintDarken.value = overrides.printDarken;
      if (Number.isFinite(overrides.printDryScale) && u.uMudPrintDryScale) u.uMudPrintDryScale.value = overrides.printDryScale;
      if (Number.isFinite(overrides.printDepth) && u.uMudPrintDepth) u.uMudPrintDepth.value = overrides.printDepth;
    }
    touched += 1;
  }
  return touched;
}

// ---------------------------------------------------------------------------
// Module state + the three providers.
// ---------------------------------------------------------------------------

let _dirt = null;       // the init record, or null

/** The LIVE tuning (a mutable copy of DIRT_TUNING; `tune()` writes it). */
let _L = _freshTuning();

const _stats = {
  inits: 0,
  puffBuilds: 0,
  hazeBuilds: 0,
  hazeIndoorInvalidates: 0,
  footfalls: 0,
  footfallsRejected: 0,
  puffs: 0,
  stamps: 0,
  stampsDropped: 0,
  pushFrames: 0,
  materialsTouched: 0,
  noTrail: 0,
  lightCopies: 0,
  tunes: 0,
};

function _envSnapshot() {
  if (!_dirt || typeof _dirt.readEnv !== "function") return null;
  try { return _dirt.readEnv(_dirt.scene3d) || null; } catch (_) { return null; }
}

// Reusable oracle-sample result objects. `terrain_oracle.js::sample(x, y, out)`
// fills a caller-supplied object and documents the parameter as the way "to keep
// the sampler allocation-free" — without it every call mints a fresh result
// object PLUS a Uint8Array(4) for cornerCodes PLUS a normal object. Both call
// sites below run hot (one per rAF, one per footstep on the SoundTable audio
// hook), so both bring their own.
//
// TWO scratches, not one: the footfall hook is driven from the audio path and
// the state provider from the frame tick. Neither yields, so they cannot
// actually interleave today — but a shared buffer would make that a silent
// correctness bug the day one of them grows an await, and a second object costs
// nothing.
const _footfallSample = {};
const _stateSample = {};

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

// The per-entity rate limit keys on guid, and monsters respawn under fresh
// guids, so a long hunt would grow `lastStepAt` without bound. An entry stops
// mattering puffMinIntervalSec after its step, and the per-frame puff budget
// keeps at most ~60 live even at 144 fps, so a sweep past this size frees most
// of the map and runs rarely.
const LAST_STEP_SWEEP_AT = 256;

function _sweepLastSteps(tSec) {
  for (const [key, last] of _dirt.lastStepAt) {
    if (tSec - last >= DIRT_TUNING.puffMinIntervalSec) _dirt.lastStepAt.delete(key);
  }
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
    sample = oracle && typeof oracle.sample === "function"
      ? oracle.sample(x, y, _footfallSample) : null;
  } catch (_) { sample = null; }
  if (!sample) { _stats.footfallsRejected += 1; return false; }
  const ground = Number.isFinite(sample.height) ? sample.height : z;
  // A footfall hook fires on the ANIMATION, not on contact: a jumping or
  // levitating entity still cycles its gait. Reject anything well off grade.
  if (Math.abs(z - ground) > DIRT_TUNING.puffMaxGroundGapM) {
    _stats.footfallsRejected += 1;
    return false;
  }
  const p = puffForGround(sample, _dirt.wetness, _L);
  if (!p.keep) { _stats.footfallsRejected += 1; return false; }
  _dirt.lastStepAt.set(key, tSec);
  if (_dirt.lastStepAt.size > LAST_STEP_SWEEP_AT) _sweepLastSteps(tSec);
  _dirt.frameEmits += 1;
  // A BURST (main + satellites), not one sprite — see `createPuffField.burst`.
  if (_dirt.puffs.burst(x, y, ground, tSec, p.colour, p.dust) > 0) {
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
          light: _dirt.light,
          liveTuning: _L,
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
        if (materials) _stats.materialsTouched += pushMudTrailUniforms(materials, null, wet, _L);
        return;
      }
      // PLAYER-ONLY stamps, the grass/snow limitation: there is no cheap
      // accessor for other creatures' ground positions in the per-frame path.
      // (A footfall EVENT does carry one — see `terrainFootfall` — so a
      // creature-track follow-up is contained, but it is not this wave's.)
      if (frameCtx.hasPlayer && terrainMudPrintsEnabled() && typeof trail.stamp === "function") {
        const p = frameCtx.playerPos;
        const s = mudStampFor(wet, _dirt.lastPrintMul, _L);
        if (trail.stamp(p.x, p.y, s.radiusM, s.strength)) _stats.stamps += 1;
        else _stats.stampsDropped += 1;
      }
      if (materials) {
        _stats.pushFrames += 1;
        _stats.materialsTouched += pushMudTrailUniforms(materials, trail, wet, _L);
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
        // 2026-10-23 — the CPU interior mask (grass_interior_mask.js, the
        // grass pattern): no sheet anchored in or near a building.
        if (!_dirt.indoorMask) {
          try { _dirt.indoorMask = createInteriorMask(); } catch (_) { _dirt.indoorMask = null; }
        }
        const mask = _dirt.indoorMask;
        const M = _L.hazeIndoorMarginM;
        _dirt.haze = createDustHazeField({
          THREE: _dirt.THREE,
          parent: _dirt.parent,
          globals: _dirt.globals,
          oracle: () => (_dirt ? _dirt.oracleRef() : null),
          count,
          radiusM: (q && q.radiusM) || terrainDirtRadiusM(),
          seed: _dirt.seed,
          light: _dirt.light,
          liveTuning: _L,
          exclude: mask
            ? (x, y, z) => mask.contains(x, y, z) || (M > 0 && (mask.contains(x + M, y, z)
              || mask.contains(x - M, y, z) || mask.contains(x, y + M, z) || mask.contains(x, y - M, z)))
            : undefined,
        });
        _stats.hazeBuilds += 1;
      }
      const p = frameCtx.playerPos;
      // The loaded interior cells changed: re-place the sheets (841 slots, so a
      // full invalidate is cheap; the mask itself checks every checkFrames).
      const mask = _dirt.indoorMask;
      if (mask && mask.sync(frameCtx.scene3d || null)) {
        try { _dirt.haze.pool.invalidate(); } catch (_) { /* fail-soft */ }
        _stats.hazeIndoorInvalidates += 1;
      }
      // Standing inside a building: fade the whole field out (sheets near the
      // walls can still drift past the margin).
      const inside = mask ? mask.contains(p.x, p.y, p.z) : false;
      const step = Number.isFinite(dt) ? Math.min(0.25, Math.max(0, dt)) : 0;
      const k = _L.hazeIndoorFadeSec > 0 ? 1 - Math.exp(-step / _L.hazeIndoorFadeSec) : 1;
      const prev = Number.isFinite(_dirt.hazeIndoorFade) ? _dirt.hazeIndoorFade : 1;
      _dirt.hazeIndoorFade = prev + ((inside ? 0 : 1) - prev) * k;
      _dirt.haze.update(dt, frameCtx.tSec, p.x, p.y, p.z, dustHazeIntensity(_dirt.env, _L) * _dirt.hazeIndoorFade);
    },
    dispose() {
      if (_dirt && _dirt.haze) { _dirt.haze.dispose(); _dirt.haze = null; }
      if (_dirt) { _dirt.indoorMask = null; _dirt.hazeIndoorFade = 1; }
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
      // The dust is LIT like the ground: copy the terrain's live retail light
      // into the shared light record both dirt materials hold by reference.
      // 9 floats; the scan stops at the first terrain material.
      if (copyTerrainLight(_terrainMaterials(), _dirt.light)) _stats.lightCopies += 1;
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
            ? oracle.sample(frameCtx.playerPos.x, frameCtx.playerPos.y, _stateSample) : null;
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
    // The dust light both dirt materials hold BY REFERENCE (the state provider
    // copies the terrain's retail light into it each frame).
    light: createDustLight(opts.THREE || null),
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
  // Live tuning resets on (re-)init; in place, so every holder sees it.
  Object.assign(_L, _freshTuning());
  _printSeeds = null;

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
    dryness: dustHazeIntensity(_dirt ? _dirt.env : null, _L),
    // true once the dust light has been copied off a terrain material (until
    // then the dust is lit by neutral noon defaults).
    lightFromTerrain: !!(_dirt && _dirt.light && _dirt.light.fromTerrain),
    // THE live-check fields (mirroring __terrainSand.field /
    // __terrainSnow.visibleRibbons): non-zero means the effect actually landed.
    // NB `visibleHaze` counts PLACED sheets (pool.live: accepted, in-window),
    // not how much shows — the before-tour's "426 visible" were ~1 % alpha.
    livePuffs: _dirt && _dirt.puffs ? _dirt.puffs.stats().live : 0,
    visibleHaze: _dirt && _dirt.haze ? _dirt.haze.pool.stats().live : 0,
    // Per-entity rate-limit entries (swept, so bounded however many guids step).
    rateLimitEntries: _dirt ? _dirt.lastStepAt.size : 0,
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
    /** Live tuning — see `tuneTerrainDirt`. */
    tune: tuneTerrainDirt,
    lbKeyFromXY,
  };
}

// Fill-time haze keys: a change re-fills the pool (amortised, no spike).
const _HAZE_FILL_KEYS = Object.freeze(["hazeWidthM", "hazeHeightM", "hazeSizeJitter"]);
// The terrain.js print seeds, captured off the first material the first time
// a print override is set, so `tune(null)` can write them back.
let _printSeeds = null;

function _capturePrintSeeds() {
  if (_printSeeds) return;
  const mats = _terrainMaterials();
  if (!mats) return;
  for (let i = 0; i < mats.length; i += 1) {
    const u = mats[i] && mats[i].uniforms;
    if (u && u.uMudPrintDarken && u.uMudPrintDryScale && u.uMudPrintDepth) {
      _printSeeds = {
        printDarken: u.uMudPrintDarken.value,
        printDryScale: u.uMudPrintDryScale.value,
        printDepth: u.uMudPrintDepth.value,
      };
      return;
    }
  }
}

/**
 * LIVE TUNING for the 1070 vistest — `window.__terrainDirt.tune({...})`.
 * Every numeric key of `DIRT_TUNING` that is safe to change live (the
 * `_TUNE_LIMITS` table) is clamped and applied to the running fields at once:
 * puff and haze uniforms immediately, emit/stamp-time values on the next
 * footfall/frame, fill-time haze sizes through an amortised pool re-fill.
 * `printDarken` / `printDryScale` / `printDepth` override the `terrain.js`
 * mud-print seeds on every terrain material (the per-frame push). `hazeColour`
 * takes a linear [r, g, b] (the fallback tint only — the per-code tint is
 * `DIRT_VARIANTS[code].puff`). `tune(null)` restores the defaults (and the
 * print seeds); `tune()` just reads. Unknown or non-numeric keys are REPORTED
 * in `rejected`, never silently dropped.
 *
 * @param {object|null} [patch]
 * @returns {{tuning:object, rejected:string[]}}
 */
export function tuneTerrainDirt(patch) {
  const rejected = [];
  let refill = false;
  if (patch === null) {
    const seeds = _printSeeds;
    Object.assign(_L, _freshTuning());
    if (seeds) Object.assign(_L, seeds);
    refill = true;
  } else if (patch && typeof patch === "object") {
    for (const k of Object.keys(patch)) {
      const v = patch[k];
      if (k === "hazeColour") {
        if (Array.isArray(v) && v.length === 3 && v.every((c) => Number.isFinite(c))) {
          _L.hazeColour = v.map((c) => Math.min(1, Math.max(0, c)));
        } else rejected.push(k);
        continue;
      }
      const lim = _TUNE_LIMITS[k];
      if (!lim || !Number.isFinite(v)) { rejected.push(k); continue; }
      if (k.startsWith("print")) _capturePrintSeeds();
      _L[k] = Math.min(lim[1], Math.max(lim[0], v));
      if (_HAZE_FILL_KEYS.includes(k)) refill = true;
    }
  }
  if (patch !== undefined) _stats.tunes += 1;
  if (_dirt && _dirt.puffs) _dirt.puffs.applyTuning();
  if (_dirt && _dirt.haze) {
    _dirt.haze.applyTuning();
    if (refill) { try { _dirt.haze.pool.invalidate(); } catch (_) { /* fail-soft */ } }
  }
  const out = {};
  for (const k of Object.keys(_L)) out[k] = Array.isArray(_L[k]) ? _L[k].slice() : _L[k];
  return { tuning: out, rejected };
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
  // In place: a field built later must see the same record object.
  Object.assign(_L, _freshTuning());
  _printSeeds = null;
}
