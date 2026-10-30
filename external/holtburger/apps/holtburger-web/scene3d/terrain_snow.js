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
// FIVE EFFECTS, THREE OWNERS:
//   0. SNOW EXPOSURE (2026-10-23 look pass) — terrain fragment shader
//      (`terrain.js`, search `SNOW EXPOSURE`), powder (code 15) only. WHY IT
//      EXISTS: the composer runs exposure 5 into the Neutral curve, which puts
//      sunlit snow (albedo ~0.85) at HDR ~4 — deep in the shoulder, displayed
//      as flat (255,255,241) paper (the 2026-10-23 owner stills). In that
//      regime NOTHING on the snow can read: a 32 % print darkening, a cast
//      shadow, a spindrift veil and a sparkle halo all tone-map to the same
//      white. A camera (or an eye) adapts to a bright snowfield; this is that
//      adaptation, done per surface: the lit powder colour is scaled by
//      `uSnowExposure` (0.6; 0.3 until 2026-10-24, which read grey at retail
//      noon on the 1070) by DAY only (ramped off the flat-ground light
//      level, 0.25 -> 0.6 = `SNOW_EXPOSURE_RAMP`, so retail noon gets the full
//      scale and night snow is untouched). Ratios are preserved — it is a
//      plain multiply — so prints, shadows and slope shading come back, and
//      sparkles (added through iblSpec, unscaled) now sit ABOVE the snow.
//      Skipped in the far-ring albedo bake (`uBakeAlbedo`). Knob:
//      `__terrainSnow.tune({exposure})`, 1 = off.
//   1. SPINDRIFT RIBBONS — here. A camera-scoped instanced ribbon field built
//      on `terrain_scatter.js` (the shared pool: placement, residency, family
//      gating, amortisation), riding the SAME shared wind vector sand and
//      grass ride, and SLOPE-BIASED: ribbons lift where the ground tilts past
//      `?terrainSnowSlope`, because that is where real spindrift comes off.
//      Intensifies while it is snowing (injected weather env) and with the
//      gust strength (|uWindDir|). 2026-10-23: it was a flat, ADDITIVE white
//      quad 13 cm wide lying 3..28 cm off the ground — invisible over white
//      snow (additive white on white adds nothing) and edge-on to the chase
//      camera. It is now an AXIAL BILLBOARD (long axis down-wind and climbing,
//      width turned to the eye) drawn with NORMAL premultiplied blending in a
//      LIT colour: the terrain's own sun/ambient (copied from a terrain
//      material each frame) times a single-scattering phase term. Suspended
//      powder scattering side/back-lit is ~1/3 as bright as the sunlit snow
//      surface (an isotropic scatterer spreads over 4 pi, the Lambertian
//      ground over a hemisphere), so with the sun behind the camera it reads
//      as a cool grey veil drifting over the white; looking toward the sun the
//      forward-scatter lobe makes it glow. Night darkens it with the ground.
//      Ribbons now follow their anchor's ground PLANE as they travel (a flat z
//      buried them blowing up crest faces), and advect by `uTravel`, the
//      per-frame integral of the gust — the old `uTime * |wind|` raced at
//      ~100 m/s ten minutes into a session as the calm wind breathed.
//      2026-10-24: the GUST PULSE had the same flaw through the wind
//      DIRECTION. Its scroll was `dir * (uTime * uPulseScroll)`, whose time
//      derivative carries `uTime * uPulseScroll * d(dir)/dt`; the calm wind's
//      direction wanders +-12 deg over 45 s, so an hour in the rope pattern
//      swept sideways at ~115 m/s (the intended scroll is ~1.1 m/s) and the
//      ribbons strobed on and off. The
//      offset is now INTEGRATED on the CPU (`uPulseOffset += dir * scroll *
//      dt`, the same clamped dt as `uTravel`; `spindriftPulseStep`), the
//      `terrain_rock.js` grit fix. For a constant direction the per-frame
//      step is exactly the old one (the same pattern scrolling at the same
//      rate; only its phase at field creation differs, and value noise has
//      no preferred phase).
//      2026-10-24 (verifier): `uTravel` now also WRAPS SEAMLESSLY, the rest
//      of the rock fix. Unwrapped, float32 lost the per-frame step: 24 h in
//      a ribbon's frame-to-frame motion was off by ~a whole step (~12 cm of
//      ~12 cm), i.e. visible stutter. Per-ribbon speeds are quantised to
//      1/SPINDRIFT_SPEED_QUANTUM (`spindriftSpeedMul`, under 1 % change) so
//      at `spindriftTravelWrap` every ribbon has crossed a whole number of
//      recycle spans and `mod(travelled, uSpanM)` does not move.
//
// ⚠ NOT OURS — the large translucent PINK/SALMON TRIANGLES in the 2026-10-23
// owner stills (before-snow-near/-wide/-low.png) are NOT a snow effect. They
// are the RynthAi/VTank "Show steep ground" overlay
// (`scene3d/passability_overlay.js`, 0xff2020 at 0x60 alpha, whole retail
// terrain triangles whose normal z < floor_z = cos 48.4 deg, within ~5 cells
// of the player), DEFAULT ON via the VTank profile option
// ShowTerrainPassability (`plugins/rynth-vt/display.js`, Route tab > Steep).
// Red at 38 % over white snow IS salmon-pink; the steep ice walls there are
// unwalkable, so the overlay is correct. Hide for a vistest:
// `window.__rynthPassabilityOverlay.setVisible(false)`.
//   2. CRYSTAL SPARKLE — in the TERRAIN FRAGMENT SHADER (`terrain.js`, search
//      `SNOW CRYSTAL SPARKLE`), gated on FAM_SNOWICE read from `uVertexTypes`
//      (plan trap T3 — the subdiv path IGNORES the `terrainCode` geometry
//      attribute), sited after the POM `cellUv` offset and bypassed on any
//      water-touching cell (plan §2.7.3). NOT in this file; this file owns its
//      flag and the live `tune()` knobs. 2026-10-23: each crystal cell used
//      to light WHOLE (a 2.4 cm square, sub-pixel past ~10 m, i.e. aliasing
//      noise at +1.35 on paper-white snow). A cell now holds ONE glint: a
//      hashed point drawn as a round Gaussian of `uSnowSparkleCorePx` screen
//      pixels (the inverse screen Jacobian of the crystal grid), bright enough
//      (HDR, x4) to bloom, direct-sun only (un-floored cloud/CSM terms, and
//      the sand sparkle's night-specular term: sun elevation 0.05..0.25 x
//      dirBright, EXACTLY 0 at retail night where the sun parks 0.9 deg up),
//      and faded where one pixel spans too much of a cell instead of at a
//      fixed distance.
//   3. FOOTPRINTS — split: `trail_map.js` (wave 0B) owns the render target, the
//      terrain fragment shader owns the dent + the darkening, and THIS file
//      owns the STAMP and the per-frame uniform push that connects them.
//      2026-10-23: the darkening is now a COLD shade (`uSnowPrintTint`, the
//      sky-filled blue of a trench in sunlit snow) plus a one-tap SUN-SIDE
//      RELIEF from the same trail map (the wall facing the sun brightens, the
//      wall facing away darkens — stronger with a low sun), so a walked track
//      reads as a trench rather than a grey smear.
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
// ?rustTerrainFx (2026-10-26, lane E, default OFF): the pool's per-frame
// re-scatter plan from Rust (null with the flag off ⇒ the pool's own loops).
import { rustScatterPlanner } from "./rust/terrain_fx.js";
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
  terrainTrailFadeSource,
  terrainVfxEnabled,
  TRAIL_FAMILY_FADE_SEC,
} from "./vfx_flags.js";
// Leaf module (imports nothing from the scene3d graph) — read only to resolve
// the shipped `uSnowExposure` for `tune({ reset: true })` (snowExposureShipped).
import { visualEnabled } from "./vfx_catalog.js";
import { withLogDepth } from "./shader_logdepth.js";

/** Provider ids — also the `VFX_EFFECT_FLAGS` router rows. */
export const SPINDRIFT_PROVIDER_ID = "terrain.snowSpindrift";
export const PRINT_PROVIDER_ID = "terrain.snowPrints";

/**
 * The trail fade snow asks for. 300 s is the `trail_map.js` clamp ceiling and,
 * per decision (c) in the header, is pixel-identical to a true infinity: the
 * map's 2R extent scrolls a print out of existence in ~24 s of running long
 * before a 300 s linear fade removes 8 % of it.
 *
 * Since 2026-08-01 this is no longer only a RECOMMENDATION: with prints live
 * and no explicit `?terrainTrailFade=`, `vfx_flags.js::terrainTrailFadeSource`
 * applies it automatically (longest claim wins). The number is owned by
 * `trail_map.js` so the reader and this module cannot drift apart.
 */
export const SNOW_RECOMMENDED_FADE_SEC = TRAIL_FAMILY_FADE_SEC.snowPrints;

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

/** Tuning that is NOT worth a URL flag (live: `__terrainSnow.tune({...})`). */
export const SNOW_TUNING = Object.freeze({
  // Ribbon geometry, metres. HIGHER-FREQUENCY than a sand streamer (plan
  // §3.4 item 1): shorter, and many more of them per metre of wind.
  // 2026-10-23: 1.5 x 0.13 m was 2-5 px wide at the chase camera; a wisp has
  // to be a few decimetres across to register at 10-30 m. The width is now an
  // eye-facing billboard width, not a ground-plane one.
  ribbonLengthM: 2.4,
  ribbonWidthM: 0.42,
  ribbonLengthJitter: 0.45,        // ±45% per instance
  // Lift of the ribbon CENTRE above the ground. Spindrift hugs the surface —
  // it is snow scraped off a crest, not a sheet in suspension — but the
  // eye-facing half-width (~0.2 m) must clear the snow or the ribbon is cut
  // by the terrain along a hard line.
  liftMinM: 0.22,
  liftMaxM: 0.6,
  // The ribbon axis CLIMBS down-wind (metres up per metre along), more off a
  // steep face: the plume lifting off a crest. Times (0.4 + 2 * slope01).
  riseSlope: 0.12,
  // Mid-travel lift: the centre rises by up to this (x (0.5 + 1.5 * slope01))
  // half-way along its recycle span and settles at both ends.
  humpM: 0.35,
  // Advection. Faster than sand (5.4 vs 3.2 m/s per unit wind) over a SHORTER
  // recycle span, which is what "higher-frequency" means in motion.
  advectSpeed: 5.4,
  advectSpanM: 17,
  // The lateral serpentine that makes a ribbon a ribbon rather than a streak:
  // radians of sideways travel per metre of ribbon length, and its rate.
  waveAmpM: 0.3,
  waveFreq: 0.9,
  waveHz: 0.55,
  // The pulse field: gusts of drift form and dissolve. Tighter than sand's
  // ~18 m sheets — spindrift comes in ropes, not blankets. 2026-10-23: the
  // ramp is now threshold..threshold+soft (it was threshold..1, so a typical
  // noise value of ~0.5 left a ribbon at ~10 % — most of the field was dark).
  pulseFreq: 0.11,                 // cycles per metre (~9 m ropes)
  pulseScrollHz: 0.12,
  pulseThreshold: 0.30,
  pulseSoft: 0.25,
  // LIT colour (2026-10-23; was additive white at 0.2, invisible on snow).
  // colour = albedo-ish cool white; the light is the TERRAIN's flat-ground
  // Gouraud term x shade + sky fill + sun x forward-scatter phase.
  colour: [0.84, 0.88, 0.95],
  shade: 0.42,                     // side/back-scatter vs the sunlit surface
  skyFill: 0.35,                   // the shaded side sees the (blue) sky
  forward: 2.2,                    // forward-scatter lobe gain (toward the sun)
  forwardPow: 6.0,                 // lobe tightness
  opacity: 0.65,                   // core alpha (normal, premultiplied blend)
  streak: 0.7,                     // internal streak texture amount, 0..1
  streakHz: 1.6,                   // streak scroll along the ribbon
  nearFadeM: 1.2,                  // no ribbon pasted over the lens
  // Wind response: |uWindDir| is the GUST strength (1.0 = the calm baseline
  // every clear day has, ~1.7 in a storm gust — weather_inputs.js
  // writeWindVector). The field is TUNED at the calm baseline (it must read on
  // a clear day, which is most days); gusts add up to this fraction on top.
  gustGain: 0.3,
  // Snowfall response (plan §3.4: "read the weather env so ground spindrift
  // intensifies while it snows"). alpha x (base + snowfall * gain); base 1 so
  // a clear day is the tuned look and a snowstorm is louder, never the reverse.
  snowfallBase: 1.0,
  snowfallGain: 0.35,
  // Footprint stamp. Tighter than grass's 0.75 m stomp blob: a print, not a
  // crushed swathe. At the DEFAULT map (0.375 m/texel) this is barely more than
  // a texel — see the trail-RT decision in the header for why that is a URL
  // knob rather than a second render target.
  stampRadiusM: 0.42,
  stampStrength: 1,
});

/**
 * SNOW EXPOSURE — the day-time scale on the lit POWDER colour (effect 0 in the
 * header). Mirrors `terrain.js` `DEFAULT_SNOW_EXPOSURE`; `test_terrain_snow.mjs`
 * locks the two together. 1 ⇒ off (the shader block is then a strict no-op).
 */
export const SNOW_EXPOSURE_DAY = 0.6;
/** Flat-ground light level (Rec.709 luminance of the retail Gouraud term) at
 *  which the exposure starts / reaches full strength. MIRRORED, as literals, in
 *  the terrain fragment (`terrain.js` SNOW EXPOSURE block) and in
 *  SNOW_SPINDRIFT_VERTEX_GLSL; `test_terrain_snow.mjs` locks all three.
 *
 *  2026-10-24: the top was 0.85, which retail never reaches. Both colour terms
 *  carry the 0.55 terrain light scale (`loop.js` AC_TERRAIN_LIGHT_SCALE_DEFAULT),
 *  so the noon sun term is <= ~0.41 (dirBright ~0.8 x sin(elevation) x 0.55)
 *  and the ambient ~0.2: noon sits at ~0.61, where the old ramp weight was
 *  ~0.66 and lit powder got a 0.54 scale instead of 0.3 (HDR ~2.1, not ~1.3).
 *  At 0.6 retail noon reaches the full day scale; a low sun (~0.35) gets a
 *  ~0.2 weight and night (~0.05-0.15: ambient only, LSCAPE floor 0.2 x 0.55)
 *  stays under the 0.25 start, untouched. */
export const SNOW_EXPOSURE_RAMP = Object.freeze([0.25, 0.6]);

/**
 * The JS twin of the shader's snow exposure factor — the same expression the
 * terrain fragment (`SNOW EXPOSURE` block) and the spindrift vertex stage both
 * compute from the terrain's own light uniforms, so ground and ribbons are
 * always "exposed" alike. Pure; zero-alloc.
 *
 * @param {number} sunVecZ   terrain `uAcSunVec.z` (dirBright-scaled; flat L)
 * @param {{r:number,g:number,b:number}} sunCol  terrain `uAcSunColor`
 * @param {{r:number,g:number,b:number}} ambCol  terrain `uAcAmbColor`
 * @param {number} ambLevel  terrain `uAcAmbLevel`
 * @param {number} exposure  the day-time scale (`uSnowExposure`)
 * @returns {number} the multiplier on lit powder, in [min(1, exposure), 1]
 */
export function snowExposureScale(sunVecZ, sunCol, ambCol, ambLevel, exposure) {
  const L = Math.max(0, Number.isFinite(sunVecZ) ? sunVecZ : 0);
  const al = Number.isFinite(ambLevel) ? ambLevel : 0;
  const ch = (s, a) => Math.min(1, (Number.isFinite(s) ? s : 0) * L + (Number.isFinite(a) ? a : 0) * al);
  const day = 0.2126 * ch(sunCol?.r, ambCol?.r) + 0.7152 * ch(sunCol?.g, ambCol?.g)
    + 0.0722 * ch(sunCol?.b, ambCol?.b);
  const [e0, e1] = SNOW_EXPOSURE_RAMP;
  const t = Math.min(1, Math.max(0, (day - e0) / (e1 - e0)));
  const w = t * t * (3 - 2 * t);   // GLSL smoothstep
  const ex = Number.isFinite(exposure) ? exposure : 1;
  return 1 + (ex - 1) * w;
}

/**
 * The TERRAIN-MATERIAL half of the live knobs: `tune()` key → the terrain
 * uniform it drives. Values are written onto every material in
 * `scene3d.terrainMaterials` (the batched BatchedMesh material included) by
 * `applySnowTerrainTuning`, and re-applied each frame by the providers so a
 * landblock baked after the call picks the override up too.
 */
export const SNOW_TERRAIN_TUNE_KEYS = Object.freeze({
  exposure: "uSnowExposure",
  sparkleStrength: "uSnowSparkleStrength",
  sparkleDensity: "uSnowSparkleDensity",
  sparkleSharpness: "uSnowSparkleSharpness",
  sparkleCorePx: "uSnowSparkleCorePx",
  sparkleFadeStart: "uSnowSparkleFadeStart",
  sparkleFadeEnd: "uSnowSparkleFadeEnd",
  printDarken: "uSnowPrintDarken",
  printDepth: "uSnowPrintDepth",
  printTint: "uSnowPrintTint",
  printRim: "uSnowPrintRim",
  printRimM: "uSnowPrintRimM",
});

/**
 * The SHIPPED value of every terrain knob: what `tune({ reset: true })` writes
 * back for a knob that has no recorded original (see `tuneTerrainSnow`).
 * MIRRORS `terrain.js` `DEFAULT_SNOW_*`; `test_terrain_snow.mjs` locks each
 * pair. `exposure` is the value the snow master ships. A terrain material
 * carries 1.0 (off) whenever the master does not light the SNOW EXPOSURE block,
 * and `snowTuneShippedValue("exposure")` resolves that.
 */
export const SNOW_TERRAIN_TUNE_DEFAULTS = Object.freeze({
  exposure: SNOW_EXPOSURE_DAY,      // DEFAULT_SNOW_EXPOSURE
  sparkleStrength: 4.0,             // DEFAULT_SNOW_SPARKLE_STRENGTH
  sparkleDensity: 3.5,              // DEFAULT_SNOW_SPARKLE_DENSITY
  sparkleSharpness: 160.0,          // DEFAULT_SNOW_SPARKLE_SHARPNESS
  sparkleCorePx: 0.9,               // DEFAULT_SNOW_SPARKLE_CORE_PX
  sparkleFadeStart: 22.0,           // DEFAULT_SNOW_SPARKLE_FADE_START
  sparkleFadeEnd: 40.0,             // DEFAULT_SNOW_SPARKLE_FADE_END
  printDarken: 0.45,                // DEFAULT_SNOW_PRINT_DARKEN
  printDepth: 0.004,                // DEFAULT_SNOW_PRINT_DEPTH
  printTint: Object.freeze([0.84, 0.93, 1.1]),   // DEFAULT_SNOW_PRINT_TINT
  printRim: 0.55,                   // DEFAULT_SNOW_PRINT_RIM
  printRimM: 0.35,                  // DEFAULT_SNOW_PRINT_RIM_M
});

/**
 * The SPINDRIFT half of the live knobs: `tune()` key → the field uniform it
 * drives (live on the field's own bag; `sizeMul` [len, wid] is the vec2
 * `uSizeMul`, handled apart).
 */
export const SPINDRIFT_TUNE_KEYS = Object.freeze({
  opacity: "uOpacity",
  shade: "uShade",
  skyFill: "uSkyFill",
  forward: "uForward",
  forwardPow: "uForwardPow",
  streak: "uStreak",
  streakHz: "uStreakHz",
  rise: "uRise",
  hump: "uHumpM",
  gustGain: "uGustGain",
  pulseThreshold: "uPulseThreshold",
  pulseSoft: "uPulseSoft",
  waveAmp: "uWaveAmp",
  speed: "uSpeed",
  nearFade: "uNearFadeM",
  snowfallBase: "uSnowfallBase",
});

/**
 * Spindrift knob → the `SNOW_TUNING` field `createSpindriftField` seeds its
 * uniform from, so a reset can name the shipped value without a field.
 * `test_terrain_snow.mjs` checks that a fresh field carries exactly these.
 */
export const SPINDRIFT_TUNE_FIELDS = Object.freeze({
  opacity: "opacity",
  shade: "shade",
  skyFill: "skyFill",
  forward: "forward",
  forwardPow: "forwardPow",
  streak: "streak",
  streakHz: "streakHz",
  rise: "riseSlope",
  hump: "humpM",
  gustGain: "gustGain",
  pulseThreshold: "pulseThreshold",
  pulseSoft: "pulseSoft",
  waveAmp: "waveAmpM",
  speed: "advectSpeed",
  nearFade: "nearFadeM",
  snowfallBase: "snowfallBase",
});

/**
 * The `uSnowExposure` a terrain material is BUILT with this session: the day
 * scale when the SNOW EXPOSURE block is lit, else 1.0. Mirrors
 * `terrain.js::resolveTerrainRingOpts` `snowExposureEnabled` =
 * `terrainVfxShaderLive() && terrainSnowEnabled()` (`terrainVfxShaderLive` =
 * `visualEnabled() && terrainVfxEnabled()`). The wireframe opts also force it
 * off, but `initTerrainSnow` returns null under wireframe, so `tune()` reaches
 * no material there. All three readers are memoised URL flags.
 */
export function snowExposureShipped() {
  const live = visualEnabled() === true && terrainVfxEnabled() === true && terrainSnowEnabled() === true;
  return live ? SNOW_EXPOSURE_DAY : 1.0;
}

/**
 * The shipped value of ANY `tune()` key, terrain or spindrift: a number, a
 * fresh array for `printTint` / `sizeMul`, or `undefined` for an unknown key.
 * Pure apart from the memoised flags `snowExposureShipped` reads.
 */
export function snowTuneShippedValue(key) {
  if (key === "exposure") return snowExposureShipped();
  if (Object.prototype.hasOwnProperty.call(SNOW_TERRAIN_TUNE_DEFAULTS, key)) {
    const v = SNOW_TERRAIN_TUNE_DEFAULTS[key];
    return Array.isArray(v) ? v.slice() : v;
  }
  if (key === "sizeMul") return [1, 1];
  const field = Object.prototype.hasOwnProperty.call(SPINDRIFT_TUNE_FIELDS, key)
    ? SPINDRIFT_TUNE_FIELDS[key] : null;
  return field ? SNOW_TUNING[field] : undefined;
}

/**
 * Write a terrain-side tuning bag onto terrain materials. Scalars go to
 * `.value`; a 3-array goes componentwise into a Color/Vector3 (`r,g,b` or
 * `x,y,z`) so no object is allocated or re-pointed. Unknown keys and
 * materials without the uniform (pre-2026-10-23 / non-terrain) are skipped.
 * Pure-ish; zero-alloc. Returns the number of uniform writes.
 *
 * @param {Array<object>|null} materials
 * @param {object|null} tune  e.g. `{ exposure: 0.45, printTint: [0.8, 0.9, 1.1] }`
 */
export function applySnowTerrainTuning(materials, tune) {
  if (!Array.isArray(materials) || !tune) return 0;
  let writes = 0;
  for (const key in tune) {
    const uname = SNOW_TERRAIN_TUNE_KEYS[key];
    if (!uname) continue;
    const v = tune[key];
    for (let i = 0; i < materials.length; i += 1) {
      const u = materials[i] && materials[i].uniforms ? materials[i].uniforms[uname] : null;
      if (!u) continue;
      if (Array.isArray(v)) {
        const o = u.value;
        if (!o) continue;
        if ("r" in o) { o.r = v[0]; o.g = v[1]; o.b = v[2]; } else { o.x = v[0]; o.y = v[1]; o.z = v[2]; }
      } else if (Number.isFinite(v)) {
        u.value = v;
      } else {
        continue;
      }
      writes += 1;
    }
  }
  return writes;
}

// Module-scope (no per-frame closure): Vector3 / Color / plain {x,y,z} or
// {r,g,b} source into an {x,y,z} target, componentwise.
function _copyVec3(dst, src) {
  if (!dst || !src) return;
  if ("x" in src) { dst.x = src.x; dst.y = src.y; dst.z = src.z; } else { dst.x = src.r; dst.y = src.g; dst.z = src.b; }
}

/**
 * Copy the TERRAIN's live light onto the spindrift uniforms: the flat-ground
 * Gouraud inputs (`uAcSunVec`, `uAcSunColor`, `uAcAmbColor`, `uAcAmbLevel`),
 * the unit sun direction (`uSunDir`, for the scatter phase) and the snow
 * exposure, read from the FIRST terrain material that carries them (every
 * terrain material gets the same values from `loop.js`). This is what keeps a
 * ribbon exactly as lit — and exactly as "exposed" — as the snow under it.
 * Componentwise, zero-alloc. Returns true when a source was found.
 */
export function copyTerrainLighting(materials, uniforms) {
  if (!Array.isArray(materials) || !uniforms) return false;
  let src = null;
  for (let i = 0; i < materials.length; i += 1) {
    const u = materials[i] && materials[i].uniforms;
    if (u && u.uAcSunVec && u.uAcSunColor && u.uAcAmbColor && u.uAcAmbLevel) { src = u; break; }
  }
  if (!src) return false;
  _copyVec3(uniforms.uSunVec.value, src.uAcSunVec.value);
  _copyVec3(uniforms.uSunCol.value, src.uAcSunColor.value);
  _copyVec3(uniforms.uAmbCol.value, src.uAcAmbColor.value);
  uniforms.uAmbLevel.value = Number.isFinite(src.uAcAmbLevel.value) ? src.uAcAmbLevel.value : 0.2;
  if (src.uSunDir && src.uSunDir.value) _copyVec3(uniforms.uSunDir.value, src.uSunDir.value);
  if (src.uSnowExposure && Number.isFinite(src.uSnowExposure.value)) {
    uniforms.uSnowExposure.value = src.uSnowExposure.value;
  }
  return true;
}

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
  const radiusM = Math.min(512, Math.max(8, num(flags?.terrainSnowRadius, 48)));
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
 * 2026-10-23: the floor was 0.12, and the owner's tour spot (0x27F10011, a
 * broad flat snow/ice field — the common case in Dereth's snow country) kept
 * 232 of 1225 ribbons, ~3 within 15 m of the camera: nothing read. A gusty
 * flat field does carry a saltation layer, so the floor is now 0.4 — crests
 * still get ~2.5x the density.
 *
 * @param {number} slope `1 - normal.z`; 0 = dead flat, ~0.5 ≈ 30°.
 * @param {number} threshold the `?terrainSnowSlope` knob. <= 0 ⇒ no bias.
 * @param {number} r01 a deterministic [0,1) draw (the pool's `ctx.rand`).
 * @returns {boolean} keep this ribbon?
 */
export const SPINDRIFT_FLAT_KEEP = 0.4;
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
 * scattered anchor at time `tSec`, for a CONSTANT wind. A PURE function of
 * (wind, clock, hash): no player state, no `Math.random`. The GLSL computes
 * the same expression with `tSec * |wind|` replaced by `uTravel`, the
 * per-frame INTEGRAL of the live gust magnitude (identical for a constant
 * wind; for a breathing one the product's derivative grows with session time
 * — see the GLSL note), so the JS is the test oracle and the readable spec.
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

/**
 * The longest frame the spindrift integrators (`uTravel`, `uPulseOffset`)
 * accept: a resumed background tab advances the field by at most this much
 * instead of jumping it. (The value the 2026-10-23 `uTravel` fix shipped.)
 */
export const SPINDRIFT_MAX_DT = 0.1;

/**
 * Per-ribbon speed multipliers are QUANTISED to multiples of
 * `1 / SPINDRIFT_SPEED_QUANTUM` (the 0.8..1.5 spread is unchanged; a draw
 * moves by at most 1/128, under 1 % of the speed, invisible). That is what lets
 * `update` wrap the `uTravel` accumulator with no seam: at a wrap of
 * `spindriftTravelWrap(span, speed)` every ribbon's travelled distance changes
 * by a WHOLE number of recycle spans, so `mod(travelled, uSpanM)` — and the
 * serpentine, hump and fades derived from it — is unchanged for every ribbon.
 * The `terrain_rock.js` GRIT_SPEED_QUANTUM fix, same numbers (2026-10-24).
 */
export const SPINDRIFT_SPEED_QUANTUM = 64;
/** Spans a k = 1 ribbon crosses per travel wrap (~806 s of unit wind at the
 *  shipped 17 m / 5.4 m/s tuning, where float32 resolves uTravel to ~6e-5). */
export const SPINDRIFT_TRAVEL_WRAP_LAPS = 4;

/**
 * The per-ribbon speed multiplier: the 0.8..1.5 spread drawn by a [0,1) hash,
 * QUANTISED to k / SPINDRIFT_SPEED_QUANTUM so the travel wrap is seamless.
 * PURE; exact in float32 (the `aDrift.y` attribute).
 *
 * @param {number} r01 the pool's `ctx.rand` draw
 * @returns {number} k / 64, in [51/64, 96/64]
 */
export function spindriftSpeedMul(r01) {
  const r = Number.isFinite(r01) ? Math.min(1, Math.max(0, r01)) : 0.5;
  return Math.round((0.8 + r * 0.7) * SPINDRIFT_SPEED_QUANTUM) / SPINDRIFT_SPEED_QUANTUM;
}

/**
 * The travel wrap period, in `uTravel` units (seconds x gust): the integral
 * after which every quantised ribbon has crossed a WHOLE number of recycle
 * spans, `span * QUANTUM * LAPS / speed`. Infinity for a non-positive speed
 * (nothing moves, nothing to wrap).
 *
 * @param {number} spanM recycle distance (`uSpanM`)
 * @param {number} speed metres/second per unit wind (`uSpeed`)
 */
export function spindriftTravelWrap(spanM, speed) {
  const span = Number.isFinite(spanM) && spanM > 0 ? spanM : SNOW_TUNING.advectSpanM;
  const v = Number.isFinite(speed) ? Math.abs(speed) : 0;
  if (!(v > 0)) return Infinity;
  return (span * SPINDRIFT_SPEED_QUANTUM * SPINDRIFT_TRAVEL_WRAP_LAPS) / v;
}

/**
 * One frame of the gust-pulse scroll — the increment `update` adds to
 * `uPulseOffset` (noise units). `dir * scroll * dt`, with `dir` formed EXACTLY
 * as the spindrift GLSL forms it (`uWindAc / |uWindAc|`, or +X at a dead calm)
 * and `dt` clamped to [0, SPINDRIFT_MAX_DT].
 *
 * 2026-10-24: the GLSL used to add `dir * (uTime * uPulseScroll)`, whose time
 * derivative carries `uTime * uPulseScroll * d(dir)/dt`: the calm wind's
 * +-12 deg / 45 s direction wander swept the rope pattern sideways faster the
 * older the session (~115 m/s an hour in). Summing these steps instead moves
 * the pattern at exactly `scroll` noise units per second whatever the clock
 * reads; for a constant direction each step equals the old form's step.
 * PURE; zero-alloc with `out`.
 *
 * @param {number} windX AC east component (the live `uWindAc`)
 * @param {number} windY AC north component
 * @param {number} dt    frame seconds (clamped)
 * @param {number} scroll noise units per second (`uPulseScroll`)
 * @param {{x:number,y:number}} [out]
 * @returns {{x:number,y:number}}
 */
export function spindriftPulseStep(windX, windY, dt, scroll, out) {
  const o = out || { x: 0, y: 0 };
  const d = Number.isFinite(dt) ? Math.min(SPINDRIFT_MAX_DT, Math.max(0, dt)) : 0;
  const rate = Number.isFinite(scroll) ? scroll : 0;
  const wx = Number.isFinite(windX) ? windX : 0;
  const wy = Number.isFinite(windY) ? windY : 0;
  const len = Math.hypot(wx, wy);
  // vec2 dir = length(uWindAc) > 1e-4 ? uWindAc / wl : vec2(1.0, 0.0);
  const k = d * rate;
  if (len > 1e-4) {
    const wl = Math.max(len, 1e-4);
    o.x = k * (wx / wl);
    o.y = k * (wy / wl);
  } else {
    o.x = k;
    o.y = 0;
  }
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
attribute vec2 aScale;     // (length, width) in metres; 0 = degenerate
attribute vec4 aDrift;     // (phase01, speedMul, slope01, alpha)
attribute vec3 aNormal;    // AC ground face normal at the anchor (pool-written)

uniform float uTime;       // the SHARED clock, bound by reference (plan 5.6)
uniform float uTravel;     // integral of |wind| dt (seconds x gust), CPU, wrapped seamlessly
uniform vec2  uWindAc;     // AC ground wind (+X east, +Y north), live; |w| = gust
uniform float uSpanM;      // advection recycle distance
uniform float uSpeed;      // metres/sec per unit wind magnitude
uniform float uWaveAmp;    // lateral serpentine amplitude, metres
uniform float uWaveFreq;   // radians of serpentine per metre downwind
uniform float uWaveHz;
uniform float uPulseFreq;  // cycles per metre
uniform vec2  uPulseOffset; // integral of dir x pulse scroll dt (noise units), CPU-accumulated
uniform float uPulseThreshold;
uniform float uPulseSoft;  // pulse ramp width above the threshold
uniform float uSnowfall;   // 0..1 weather intensity (see snowfallIntensity)
uniform float uSnowfallBase;
uniform float uSnowfallGain;
uniform float uGustGain;   // extra alpha fraction a full storm gust adds
uniform float uRise;       // axis climb (m up per m along) before the slope boost
uniform float uHumpM;      // mid-travel centre lift
uniform float uNearFadeM;  // view distance under which a ribbon fades out
uniform vec2  uSizeMul;    // live (length, width) multiplier
uniform float uStreakHz;
// LIGHT: the terrain material's own values, copied once per frame
// (terrain_snow.js copyTerrainLighting), so a ribbon is lit and exposed exactly
// like the snow under it.
uniform vec3  uSunVec;     // terrain uAcSunVec: AC, dirBright magnitude
uniform vec3  uSunDir;     // terrain uSunDir: AC unit, for the scatter phase
uniform vec3  uSunCol;     // terrain uAcSunColor
uniform vec3  uAmbCol;     // terrain uAcAmbColor
uniform float uAmbLevel;   // terrain uAcAmbLevel
uniform float uSnowExposure; // terrain uSnowExposure (the SNOW EXPOSURE block)
uniform vec3  uColour;     // cool snow-powder albedo
uniform float uShade;      // side/back-scatter radiance vs the sunlit surface
uniform float uSkyFill;    // skylight on the shaded side
uniform float uForward;    // forward-scatter lobe gain
uniform float uForwardPow; // forward-scatter lobe exponent

varying vec2 vQuadUv;
varying float vAlpha;
varying vec3 vColour;
varying vec2 vStreak;

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
  vec2 dir = length(uWindAc) > 1e-4 ? uWindAc / wl : vec2(1.0, 0.0);
  vec2 side = vec2(-dir.y, dir.x);
  // 2026-10-23: uTravel = the INTEGRAL of the gust magnitude over the clock
  // (accumulated per frame on the CPU), NOT uTime * |wind|. The product's
  // time derivative carries uTime * d|wind|/dt, which grows with session
  // time: with the calm +-6 % / 13 s breathing, ten minutes in the ribbons
  // raced at ~100 m/s and the field read as flicker. For a constant wind the
  // two are identical (spindriftAdvect, the JS twin, is that closed form).
  float travelled = uTravel * uSpeed * aDrift.y + aDrift.x * uSpanM;
  float s = mod(travelled, uSpanM) - uSpanM * 0.5;
  vec2 adv = dir * s;
  // 0 at the up-wind recycle end, 1 at the down-wind one.
  float u01 = s / uSpanM + 0.5;

  // --- the ribbon CENTRE: advected, SERPENTINED, and lifted mid-travel.
  // The lateral wave is what makes this a RIBBON rather than sand's straight
  // streak; the hump is the plume lifting off and settling. Both are pure
  // functions of (downwind distance, clock, hash), so it stays deterministic.
  float slope01 = clamp(aDrift.z, 0.0, 1.0);
  float wave = sin(s * uWaveFreq + uTime * uWaveHz * 6.2831853 + aDrift.x * 6.2831853)
             * uWaveAmp;
  float hump = uHumpM * sin(3.14159265 * u01) * (0.5 + 1.5 * slope01);
  // FOLLOW THE GROUND PLANE. A ribbon travels up to span/2 from its anchor;
  // with a flat z it was buried blowing UP a crest face (exactly where the
  // slope bias puts most of them). AC terrain is planar per 24 m triangle, so
  // the anchor's face plane is exact inside that triangle. Clamped so a near-
  // vertical face cannot fling a ribbon metres into the air.
  vec2 travel = adv + side * wave;
  float gnz = max(aNormal.z, 0.25);
  float follow = clamp(-dot(aNormal.xy, travel) / gnz, -6.0, 6.0);
  vec3 local = vec3(travel, hump + follow);

  // instanceMatrix carries the anchor translation AND the pool 0/1 live scale,
  // so a degenerate (wrong-family / too-flat / unbaked / out-of-range) instance
  // collapses to its anchor; with aScale = 0 as well it is zero-area.
  vec4 placed = instanceMatrix * vec4(local, 1.0);
  float live = step(0.5, instanceMatrix[0][0]) * step(1e-4, aScale.x);

  // --- AXIAL BILLBOARD. The long axis runs down-wind and CLIMBS (more off a
  // steep face); the width is turned to the eye: perpendicular to both the
  // axis and the view ray, in view space. A flat ground-plane quad (the old
  // form) is edge-on to a chase camera and vanished.
  // The axis lies along the ground plane down-wind, plus the climb.
  vec3 axisAc = normalize(vec3(dir, clamp(-dot(aNormal.xy, dir) / gnz, -3.0, 3.0)
                                    + uRise * (0.4 + 2.0 * slope01)));
  vec4 cView = modelViewMatrix * vec4(placed.xyz, 1.0);
  vec3 aView = normalize(mat3(modelViewMatrix) * axisAc);
  vec3 rayView = cView.xyz * inversesqrt(max(dot(cView.xyz, cView.xyz), 1e-8));
  vec3 sideView = cross(aView, rayView);
  float sideLen = length(sideView);
  sideView = sideLen > 1e-4 ? sideView / sideLen : vec3(1.0, 0.0, 0.0);
  float len = aScale.x * uSizeMul.x * live;
  float wid = aScale.y * uSizeMul.y * live;
  vec3 pView = cView.xyz + aView * (position.x * len) + sideView * (position.y * wid);

  // --- the pulse field: ropes of drift form and dissolve -------------------
  // 2026-10-24: the scroll is INTEGRATED on the CPU (uPulseOffset accumulates
  // dir x scroll x dt each frame, terrain_snow.js::spindriftPulseStep). The
  // old dir x (uTime x scroll) moved at uTime x scroll x d(dir)/dt as well:
  // the 45 s +-12 deg wind wander swept the ropes sideways ever faster as the
  // session aged. Same step as before for a constant wind direction.
  vec2 pulseXy = placed.xy * uPulseFreq + uPulseOffset;
  float n = snowNoise2D(pulseXy);
  float pulse = smoothstep(uPulseThreshold, uPulseThreshold + uPulseSoft, n);

  // Distance blend, identical in form to the CPU fadeFor() (LINEAR).
  float fade = hbScatterFade(placed.xy);
  // No pop at the recycle wrap: born faint up-wind, gone before the jump.
  float travelFade = smoothstep(0.0, 0.15, u01) * (1.0 - smoothstep(0.8, 1.0, u01));
  // Nothing pasted over the lens.
  float nearM = max(uNearFadeM, 0.01);
  float nearFade = smoothstep(nearM, nearM * 2.5, -cView.z);

  // WEATHER: spindrift intensifies while it is snowing (plan 3.4). The base
  // term keeps a calm cold day drifting rather than switching the field off.
  float wx = uSnowfallBase + uSnowfallGain * clamp(uSnowfall, 0.0, 1.0);
  // WIND: |uWindAc| is the gust strength (1 = the calm baseline the field is
  // tuned at); storm gusts lift more snow.
  float gust = 1.0 + uGustGain * smoothstep(1.05, 1.6, wl);

  vAlpha = live * pulse * fade * travelFade * nearFade * aDrift.w * wx * gust;

  // --- LIGHT: single scattering by suspended powder, in the terrain's light.
  // snowRef is the retail Gouraud term on FLAT ground (terrainAcGouraud with
  // n = +Z), i.e. what lights the snow under the ribbon. Side/back-scatter
  // gives a fraction of it (uShade) plus skylight on the shaded side; looking
  // toward the sun the forward lobe takes over and the wisp glows.
  vec3 snowRef = min(vec3(1.0), uSunCol * max(uSunVec.z, 0.0) + uAmbCol * uAmbLevel);
  float snowDay = dot(snowRef, vec3(0.2126, 0.7152, 0.0722));
  float snowExpo = mix(1.0, uSnowExposure, smoothstep(0.25, 0.6, snowDay));
  vec3 sunView = mat3(modelViewMatrix) * uSunDir;
  sunView *= inversesqrt(max(dot(sunView, sunView), 1e-8));
  float phase = pow(max(dot(rayView, sunView), 0.0), uForwardPow)
              * smoothstep(-0.05, 0.1, uSunDir.z);
  vec3 lit = snowRef * uShade + uAmbCol * (uAmbLevel * uSkyFill)
           + uSunCol * (max(uSunVec.z, 0.0) * uForward * phase);
  vColour = uColour * lit * snowExpo;

  vQuadUv = uv;
  // Streak texture coords: periodic (8) along the ribbon so the scroll can
  // wrap without a jump; per-instance offsets so no two wisps match.
  vStreak = vec2((position.x + 0.5) * 2.5 + aDrift.x * 8.0 - mod(uTime * uStreakHz, 8.0),
                 (position.y + 0.5) * 4.0 + aDrift.x * 37.0);
  gl_Position = projectionMatrix * vec4(pView, 1.0);
}
`;

export const SNOW_SPINDRIFT_FRAGMENT_GLSL = `
precision highp float;

uniform float uOpacity;
uniform float uStreak;

varying vec2 vQuadUv;
varying float vAlpha;
varying vec3 vColour;
varying vec2 vStreak;

float snowStreakHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
// Value noise, PERIODIC in x with period 8 (the vertex stage wraps the scroll).
float snowStreakNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float x0 = mod(i.x, 8.0);
  float x1 = mod(i.x + 1.0, 8.0);
  float a = snowStreakHash(vec2(x0, i.y));
  float b = snowStreakHash(vec2(x1, i.y));
  float c = snowStreakHash(vec2(x0, i.y + 1.0));
  float d = snowStreakHash(vec2(x1, i.y + 1.0));
  vec2 w = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

void main() {
  if (vAlpha <= 0.0) discard;
  // A blown wisp: a long soft tail up-wind, a firmer head down-wind (uv.x = 1),
  // feathered sides.
  float along = vQuadUv.x;
  float across = abs(vQuadUv.y * 2.0 - 1.0);
  float tail = smoothstep(0.0, 0.6, along);
  float head = 1.0 - smoothstep(0.78, 1.0, along);
  float side = 1.0 - smoothstep(0.2, 1.0, across);
  // Internal streaks scrolling down the ribbon: moving texture is what the eye
  // picks out of a low-contrast veil.
  float n = snowStreakNoise(vStreak);
  float streak = mix(1.0, 1.5 * smoothstep(0.15, 0.85, n), uStreak);
  float a = clamp(tail * head * side * streak * vAlpha * uOpacity, 0.0, 1.0);
  if (a <= 0.003) discard;
  // PREMULTIPLIED, NORMAL blend (the material sets premultipliedAlpha): over
  // white snow an additive white term adds nothing, a lit veil does.
  gl_FragColor = vec4(vColour * a, a);
}
`;

/** The per-instance attribute schema the pool allocates for a ribbon field. */
export const SNOW_SPINDRIFT_SCHEMA = Object.freeze([
  { name: "aOffset", itemSize: 3 },
  { name: "aScale", itemSize: 2 },
  { name: "aDrift", itemSize: 4 },
  // 2026-10-23: the anchor's ground face normal (the pool writes `aNormal`
  // from the oracle by default), so a travelling ribbon follows its slope.
  { name: "aNormal", itemSize: 3 },
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
  const radiusM = Math.min(512, Math.max(8, Number.isFinite(opts.radiusM) ? opts.radiusM : 48));
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
    uTravel: { value: 0 },
    uWindAc: { value: null },
    uSpanM: { value: tuning.advectSpanM },
    uSpeed: { value: tuning.advectSpeed },
    uWaveAmp: { value: tuning.waveAmpM },
    uWaveFreq: { value: tuning.waveFreq },
    uWaveHz: { value: tuning.waveHz },
    uPulseFreq: { value: tuning.pulseFreq },
    // CPU-SIDE rate (noise units / s), NOT declared in the GLSL since
    // 2026-10-24: `update` integrates it into `uPulseOffset` along the live
    // wind direction (`spindriftPulseStep`). Still live-writable here.
    uPulseScroll: { value: tuning.pulseScrollHz },
    // A plain {x, y} headless; a THREE.Vector2 once THREE is injected.
    uPulseOffset: { value: { x: 0, y: 0 } },
    uPulseThreshold: { value: tuning.pulseThreshold },
    uPulseSoft: { value: tuning.pulseSoft },
    uSnowfall: { value: 0 },
    uSnowfallBase: { value: tuning.snowfallBase },
    uSnowfallGain: { value: tuning.snowfallGain },
    uGustGain: { value: tuning.gustGain },
    uRise: { value: tuning.riseSlope },
    uHumpM: { value: tuning.humpM },
    uNearFadeM: { value: tuning.nearFadeM },
    uSizeMul: { value: null },
    uStreakHz: { value: tuning.streakHz },
    // LIGHT — overwritten every frame from a terrain material
    // (copyTerrainLighting). The seeds are a plausible noon so a field that never
    // finds a terrain material (headless, an interior) still renders sanely.
    uSunVec: { value: { x: 0.25, y: 0.25, z: 0.9 } },
    uSunDir: { value: { x: 0.26, y: 0.26, z: 0.93 } },
    uSunCol: { value: { x: 1, y: 0.98, z: 0.94 } },
    uAmbCol: { value: { x: 0.55, y: 0.62, z: 0.75 } },
    uAmbLevel: { value: 0.35 },
    uSnowExposure: { value: SNOW_EXPOSURE_DAY },
    uColour: { value: null },
    uShade: { value: tuning.shade },
    uSkyFill: { value: tuning.skyFill },
    uForward: { value: tuning.forward },
    uForwardPow: { value: tuning.forwardPow },
    uOpacity: { value: tuning.opacity },
    uStreak: { value: tuning.streak },
    // Adopted + populated by the pool below (never placeholders to re-point).
    uScatterCenter: { value: null },
    uScatterRadius: { value: radiusM },
    uScatterFadeStart: { value: radiusM * 0.75 },
    uScatterShape: { value: 0 },
  };

  const wind = { x: 0, y: 0 };
  const advect = { x: 0, y: 0, s: 0 };
  const pulseStep = { x: 0, y: 0 };

  if (!uniforms.uSizeMul.value) uniforms.uSizeMul.value = { x: 1, y: 1 };
  if (THREE && typeof THREE.ShaderMaterial === "function") {
    try {
      geometry = _ribbonGeometry(THREE);
      uniforms.uWindAc.value = new THREE.Vector2(1, 0);
      uniforms.uSizeMul.value = new THREE.Vector2(1, 1);
      uniforms.uPulseOffset.value = new THREE.Vector2(0, 0);
      // Light vectors as Vector3 (a vec3 uniform; copyTerrainLighting writes
      // x/y/z componentwise, so the objects are never re-pointed).
      for (const k of ["uSunVec", "uSunDir", "uSunCol", "uAmbCol"]) {
        const v = uniforms[k].value;
        uniforms[k].value = new THREE.Vector3(v.x, v.y, v.z);
      }
      uniforms.uColour.value = new THREE.Color(
        tuning.colour[0], tuning.colour[1], tuning.colour[2],
      );
      uniforms.uScatterCenter.value = new THREE.Vector3(0, 0, 0);
      material = new THREE.ShaderMaterial(withLogDepth({
        vertexShader: SNOW_SPINDRIFT_VERTEX_GLSL,
        fragmentShader: SNOW_SPINDRIFT_FRAGMENT_GLSL,
        // The SAME objects the pool will publish into — no spread, no copy.
        uniforms,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        // 2026-10-23: NORMAL, premultiplied (was Additive). An additive white
        // veil over white snow adds nothing the tone curve can show; a lit,
        // partly opaque one (darker than sunlit snow side-on, brighter toward
        // the sun) reads over snow, ice, rock and sky alike.
        blending: THREE.NormalBlending,
        premultipliedAlpha: true,
        side: THREE.DoubleSide,
        toneMapped: false,
      }));
      material.name = "terrain-snow-spindrift";
    } catch (_) {
      geometry = null;
      material = null;
    }
  }

  const pool = createScatterPool({
    scanPlanner: rustScatterPlanner(),
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
      // Centre lift: liftMinM..liftMaxM. Hash-stable per cell.
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
        spindriftSpeedMul(ctx.rand(6)),    // per-ribbon speed multiplier, k/64 (seamless travel wrap)
        slope01,                           // climb + hump boost (the GLSL reads it)
        // Steeper ground drifts harder; ice barely drifts at all. NO ctx.fade
        // here any more (2026-10-23): that is the scatter-time fade relative to
        // where the pool was centred THEN, and the shader already applies the
        // live hbScatterFade — the product faded the field twice.
        (0.75 + ctx.rand(8) * 0.25) * drift * (0.8 + 0.2 * Math.min(1, slope01 * 4)),
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

  const state = {
    frames: 0, lastRescattered: 0, snowfall: 0, built: !!mesh, lightSynced: false,
    // Integral of |wind| over the clock (see uTravel in the GLSL), a double
    // here, WRAPPED seamlessly at spindriftTravelWrap (~806 s of unit wind), so
    // float32 on the GPU resolves it to ~6e-5 however long the session runs.
    travel: 0, travelWraps: 0,
    // Integral of dir x pulseScroll dt (`uPulseOffset`), noise units. Not
    // wrapped (value noise is not periodic): its length is at most scroll x
    // the elapsed seconds, never more than the old closed form's uTime x
    // scroll, so float32 resolves it no worse than before (~1 cm of pattern
    // a day in, at 0.12 units/s and 0.11 cycles/m).
    pulseX: 0, pulseY: 0,
  };

  return {
    pool,
    uniforms,
    slopeBias,
    /** false ⇒ `uniforms.uTime` IS `VFX_GLOBALS.uTime` (bound by identity). */
    ownsClock: _ownsClock,
    get mesh() { return mesh; },
    get material() { return material; },
    get geometry() { return geometry; },
    /**
     * Per-frame: take the terrain's live light (and snow exposure) so the
     * ribbons are lit like the ground under them. Zero-alloc; returns true
     * when a terrain material supplied it.
     */
    syncLighting(materials) {
      state.lightSynced = copyTerrainLighting(materials, uniforms);
      return state.lightSynced;
    },
    /** Per-frame: re-centre the pool and refresh the live uniforms. */
    update(dt, tSec, px, py, pz, snowfall) {
      state.frames += 1;
      windAcFromGlobals(globals, wind);
      // Only when we MINTED the clock. An adopted VFX_GLOBALS.uTime belongs to
      // `loop.js::tickVfxOscillators`; writing it here would fight that tick.
      if (_ownsClock) uniforms.uTime.value = Number.isFinite(tSec) ? tSec : 0;
      const wv = uniforms.uWindAc.value;
      if (wv) { wv.x = wind.x; wv.y = wind.y; }
      // Integrate the gust: a clamped dt so a backgrounded tab resumes calmly.
      const ddt = Number.isFinite(dt) ? Math.min(SPINDRIFT_MAX_DT, Math.max(0, dt)) : 0;
      state.travel += ddt * Math.hypot(wind.x, wind.y);
      // Wrap SEAMLESSLY (every ribbon speed is k/64, see spindriftSpeedMul):
      // unwrapped, float32 lost the per-frame step within a day.
      const wrap = spindriftTravelWrap(uniforms.uSpanM.value, uniforms.uSpeed.value);
      if (state.travel >= wrap) {
        state.travel -= wrap * Math.floor(state.travel / wrap);
        state.travelWraps += 1;
      }
      uniforms.uTravel.value = state.travel;
      // ...and the pulse scroll along the live direction (2026-10-24): the
      // same clamped dt, the direction formed exactly as the GLSL forms it.
      spindriftPulseStep(wind.x, wind.y, ddt, uniforms.uPulseScroll.value, pulseStep);
      state.pulseX += pulseStep.x;
      state.pulseY += pulseStep.y;
      const po = uniforms.uPulseOffset.value;
      if (po) { po.x = state.pulseX; po.y = state.pulseY; }
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
        gust: Math.hypot(wind.x, wind.y),
        travel: state.travel,
        travelWrap: spindriftTravelWrap(uniforms.uSpanM.value, uniforms.uSpeed.value),
        travelWraps: state.travelWraps,
        pulseOffset: { x: state.pulseX, y: state.pulseY },
        lightSynced: state.lightSynced,
        exposure: uniforms.uSnowExposure.value,
        exposureNow: snowExposureScale(
          uniforms.uSunVec.value.z,
          { r: uniforms.uSunCol.value.x, g: uniforms.uSunCol.value.y, b: uniforms.uSunCol.value.z },
          { r: uniforms.uAmbCol.value.x, g: uniforms.uAmbCol.value.y, b: uniforms.uAmbCol.value.z },
          uniforms.uAmbLevel.value,
          uniforms.uSnowExposure.value,
        ),
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
    // ⚠ uSnowTrailMap / uSnowTrailCenter / uSnowTrailRadius are SHARED with the
    // wave-3B MUD family (there is one trail map and one sampler; the snow name
    // is a wave-2A artefact — see terrain_dirt.js::pushMudTrailUniforms). Only
    // write them when we actually HAVE a map, exactly as the mud sibling does.
    //
    // 2026-08-03: this used to write unconditionally, so the absent-map and
    // dispose() paths NULLED the sampler out from under a live mud provider
    // while `uMudTrailEnabled` was still 1 — the mud block then sampled three's
    // default 1x1 white texture and painted a full-strength dent + darkening
    // over the whole dirt family. Each family clears its OWN gate and nothing
    // else; a stale texture ref behind two closed gates is never read.
    if (tex) {
      if (u.uSnowTrailMap) u.uSnowTrailMap.value = tex;
      const c = u.uSnowTrailCenter ? u.uSnowTrailCenter.value : null;
      // Written componentwise rather than with .set(): the batched material's
      // clone is a real Vector2, but a headless/stub material may carry a plain
      // {x, y} and this path must not care.
      if (c) { c.x = cx; c.y = cy; }
      if (u.uSnowTrailRadius) u.uSnowTrailRadius.value = radius;
    }
    u.uSnowTrailEnabled.value = on;
    touched += 1;
  }
  return touched;
}

// ---------------------------------------------------------------------------
// Module state + the two providers.
// ---------------------------------------------------------------------------

let _snow = null;       // the init record, or null

// Live terrain-side knob overrides set through `tune()` (null = none). The
// providers re-apply them every frame so a landblock baked after the call
// picks them up; with no provider live (the sparkle-only `mid` tier) `tune()`
// still writes the materials resident at call time.
let _terrainTune = null;
// Spindrift-side overrides (the knob → uniform table is SPINDRIFT_TUNE_KEYS).
let _spindriftTune = null;
// The value each knob had BEFORE its first write, so `tune({ reset: true })`
// can put the shipped look back without a reload. 2026-10-24: recorded LAZILY,
// at the first application that actually reaches a material / the field (the
// per-frame provider re-apply, the field build), not only at `tune()` time. A
// knob tuned before the field or any terrain material existed used to have no
// original at all, so the provider re-apply wrote the override onto every
// material baked later and reset left it there. Anything still unrecorded at
// reset falls back to `snowTuneShippedValue`.
let _tuneOrig = { terrain: {}, spindrift: {} };

function _origOfTerrain(key, materials) {
  if (key in _tuneOrig.terrain || !Array.isArray(materials)) return;
  const uname = SNOW_TERRAIN_TUNE_KEYS[key];
  for (const m of materials) {
    const u = m && m.uniforms ? m.uniforms[uname] : null;
    if (!u) continue;
    const v = u.value;
    if (v && typeof v === "object") {
      _tuneOrig.terrain[key] = "r" in v ? [v.r, v.g, v.b] : [v.x, v.y, v.z];
    } else if (Number.isFinite(v)) {
      _tuneOrig.terrain[key] = v;
    }
    return;
  }
}

// Record every live terrain override's original, then write the bag. THE one
// path a terrain override reaches a material by (tune() and both providers'
// per-frame re-apply), so no write can skip the record. Zero-alloc once every
// key is recorded (`key in` short-circuits).
function _applyTerrainTune(materials) {
  if (!_terrainTune || !Array.isArray(materials) || materials.length === 0) return 0;
  for (const key in _terrainTune) _origOfTerrain(key, materials);
  return applySnowTerrainTuning(materials, _terrainTune);
}

function _origOfSpindrift(key, f) {
  if (!f || key in _tuneOrig.spindrift) return;
  if (key === "sizeMul") {
    const o = f.uniforms.uSizeMul ? f.uniforms.uSizeMul.value : null;
    if (o && Number.isFinite(o.x) && Number.isFinite(o.y)) _tuneOrig.spindrift.sizeMul = [o.x, o.y];
    return;
  }
  const uname = SPINDRIFT_TUNE_KEYS[key];
  const u = uname ? f.uniforms[uname] : null;
  if (u && Number.isFinite(u.value)) _tuneOrig.spindrift[key] = u.value;
}

// Write a spindrift bag onto a field's uniforms (no bookkeeping).
function _writeSpindrift(f, bag) {
  if (!f || !bag) return 0;
  let n = 0;
  for (const key in bag) {
    const v = bag[key];
    if (key === "sizeMul") {
      const o = f.uniforms.uSizeMul.value;
      if (o && Array.isArray(v)) { o.x = v[0]; o.y = v[1]; n += 1; }
      continue;
    }
    const uname = SPINDRIFT_TUNE_KEYS[key];
    if (uname && f.uniforms[uname] && Number.isFinite(v)) { f.uniforms[uname].value = v; n += 1; }
  }
  return n;
}

// Record originals, then write the live spindrift overrides — on tune() and
// right after the provider builds the field (a knob tuned before the field
// existed is recorded off the fresh SNOW_TUNING-seeded uniforms there).
function _applySpindriftTune() {
  const f = _snow && _snow.field ? _snow.field : null;
  if (!f || !_spindriftTune) return 0;
  for (const key in _spindriftTune) _origOfSpindrift(key, f);
  return _writeSpindrift(f, _spindriftTune);
}

// The reset bag: every recorded original, plus the shipped value of any live
// override that never reached a material / the field (so has no original).
function _resetBag(orig, live) {
  const out = {};
  for (const key in orig) out[key] = Array.isArray(orig[key]) ? orig[key].slice() : orig[key];
  if (live) {
    for (const key in live) {
      if (key in out) continue;
      const v = snowTuneShippedValue(key);
      if (v !== undefined) out[key] = v;
    }
  }
  return out;
}

/**
 * LIVE KNOBS — `window.__terrainSnow.tune({...})` (2026-10-23). One bag, both
 * halves of the family:
 *   terrain (every terrain material, re-applied per frame by the providers):
 *     exposure, sparkleStrength, sparkleDensity, sparkleSharpness,
 *     sparkleCorePx, sparkleFadeStart, sparkleFadeEnd, printDarken,
 *     printDepth, printTint [r,g,b], printRim, printRimM
 *   spindrift (the field's own uniforms): opacity, shade, skyFill, forward,
 *     forwardPow, streak, streakHz, rise, hump, gustGain, pulseThreshold,
 *     pulseSoft, waveAmp, speed, nearFade, snowfallBase, sizeMul [len, wid]
 *   { reset: true } restores every knob ever tuned to its SHIPPED value: the
 *     value recorded just before the knob's first write (at tune() time, or
 *     lazily the first time a provider re-apply / the field build carried it),
 *     else `snowTuneShippedValue(key)` for a knob that never reached a material
 *     or the field. It writes the resident materials and the live field, drops
 *     every override, and returns `{ terrain: null, spindrift: null,
 *     restored: { terrain, spindrift } }` (the bags it wrote).
 * Returns the live override bags. Never allocates per frame (the bags are
 * built here, once per call).
 */
export function tuneTerrainSnow(bag) {
  const mats = _terrainMaterials();
  if (bag && bag.reset === true) {
    const terrain = _resetBag(_tuneOrig.terrain, _terrainTune);
    const spindrift = _resetBag(_tuneOrig.spindrift, _spindriftTune);
    if (mats) applySnowTerrainTuning(mats, terrain);
    _writeSpindrift(_snow && _snow.field ? _snow.field : null, spindrift);
    _terrainTune = null;
    _spindriftTune = null;
    _stats.tunes += 1;
    return { terrain: null, spindrift: null, restored: { terrain, spindrift } };
  }
  if (bag && typeof bag === "object") {
    _stats.tunes += 1;
    let terr = null;
    let sp = null;
    for (const key in bag) {
      if (SNOW_TERRAIN_TUNE_KEYS[key]) {
        (terr || (terr = {}))[key] = bag[key];
      } else if (SPINDRIFT_TUNE_KEYS[key] || key === "sizeMul") {
        (sp || (sp = {}))[key] = bag[key];
      }
    }
    if (terr) {
      _terrainTune = { ...(_terrainTune || {}), ...terr };
      _applyTerrainTune(mats);
    }
    if (sp) {
      _spindriftTune = { ...(_spindriftTune || {}), ...sp };
      _applySpindriftTune();
    }
  }
  return { terrain: _terrainTune, spindrift: _spindriftTune };
}

const _stats = {
  inits: 0,
  spindriftBuilds: 0,
  tunes: 0,
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
        _applySpindriftTune();
      }
      const p = frameCtx.playerPos;
      const mats = _terrainMaterials();
      if (_terrainTune) _applyTerrainTune(mats);
      // The terrain's light + snow exposure, so ribbons match the ground.
      _snow.field.syncLighting(mats);
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
        if (_terrainTune) _applyTerrainTune(materials);
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
        + "NOT enabled — only an EXPLICIT ?terrainTrail=off can reach this now "
        + "(prints otherwise imply the map). Nothing will be drawn.",
      );
    } else {
      const fade = terrainTrailRecoverySec();
      if (Number.isFinite(fade) && fade < SNOW_SHORT_FADE_WARN_SEC) {
        // eslint-disable-next-line no-console
        console.warn(
          `[terrainSnowPrints] the shared trail recovery is ${fade}s — an EXPLICIT `
          + `?terrainTrailFade beats snow's ${SNOW_RECOMMENDED_FADE_SEC}s claim, and prints `
          + `will visibly melt. Drop the flag (or set ?terrainTrailFade=${SNOW_RECOMMENDED_FADE_SEC}). `
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
    // WHERE the live fade came from: "family" ⇒ this module's own claim won,
    // "url" ⇒ an explicit ?terrainTrailFade beat it, "preset" ⇒ the tier is longer.
    trailFadeSource: terrainTrailFadeSource(),
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
    tune: { terrain: _terrainTune, spindrift: _spindriftTune },
    counters: { ..._stats },
  };
}

function terrainSnowSurface() {
  return {
    stats: terrainSnowStats,
    get field() { return _snow ? _snow.field : null; },
    get uniforms() { return _snow && _snow.field ? _snow.field.uniforms : null; },
    /** Live knobs — see `tuneTerrainSnow`. e.g. `tune({ exposure: 1 })` = A/B. */
    tune: tuneTerrainSnow,
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
  _terrainTune = null;
  _spindriftTune = null;
  _tuneOrig = { terrain: {}, spindrift: {} };
  for (const k of Object.keys(_stats)) _stats[k] = 0;
}
