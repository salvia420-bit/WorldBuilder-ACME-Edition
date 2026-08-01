// scene3d/terrain_rock.js — ROCK / BARREN terrain VFX (Wave 4A).
//
// Design plan: `docs/2026-07-31-terrain-vfx-plan.md` §3.3. Terrain codes 0
// (`BarrenRock`), 13 (`SedimentaryRock`), 14 (`SemiBarrenRock`) and 30
// (`olthoi`) = `FAM_ROCK` — DERIVED from `terrain_families.js`, never hardcoded
// here (plan §8 risk 12: family membership is a property of the CODE, and
// retail shares one RenderSurface across codes that land in three different
// families — plan §2.7.2).
//
// THE LOOK (plan §3.3): stillness with weight. Hard, dry ground: scattered
// pebbles and rubble as REAL GEOMETRY so barren ground is not a painted plane,
// with wind-lifted grit skittering over it.
//
// THREE EFFECTS, TWO OWNED HERE:
//   1. PEBBLE / RUBBLE SCATTER — here. Camera-scoped, on the shared
//      `terrain_scatter.js` pool (placement, residency, family gating,
//      amortisation), with an OPAQUE LIT material — the one scatter field in
//      this programme that is not an additive veil, so it carries real fragment
//      cost and a real day/night response. Three shapes chosen by hash, biased
//      per terrain code: 13/14 shed flatter SHALE PLATES, 30 (`olthoi`) throws
//      angular CHITINOUS SHARDS with a faint sickly emissive (a fragment term,
//      never a light — §5.2).
//   2. GRIT STREAMERS — here. Plan §3.3 item 2: "the §3.2 streamer module at
//      1/5 density, greyer, shorter life. A parameter block, not a new module."
//      It is a parameter block — of the SAND streamer maths, COPIED rather than
//      imported, which is the established groove: `terrain_snow.js` copied the
//      same maths for spindrift rather than widening `terrain_sand.js`'s
//      hardcoded `families: [FAM_SAND]`. Editing a landed family's module to
//      serve this one would be a cross-family drive-by; `gritAdvect` below is
//      byte-for-byte the same expression as `streamerAdvect`/`spindriftAdvect`
//      and the node suite asserts that agreement.
//   3. FOOTFALL DUST PUFFS — plan §3.3 item 3 says "shared with §3.7", and it
//      IS shared: the mechanism landed in wave 3B and is owned end-to-end by
//      `terrain_dirt.js` (the `entities.js::_fireHook` seam, the single
//      `scene3d.onTerrainFootfall` facade property, the puff ring buffer).
//      ⚠ It does not fire on rock TODAY: `terrain_dirt.js::puffForGround` gates
//      on `familyForCode(code) !== FAM_DIRT` and its suite locks that ("no puff
//      on a water/ice code"). Making dry rock puff is therefore a DIRT-SIDE
//      change (a FAM_ROCK branch + a puff-colour row), not a second ring buffer
//      here — two families cannot both own `onTerrainFootfall` without a
//      fan-out this wave has no mandate to build. Deliberately deferred to the
//      wave-4B promotion pass; recorded here so it is not lost.
//
// INJECTED THREE (the `terrain_vfx.js` / `terrain_sand.js` / `terrain_snow.js`
// idiom). This module imports no three: `initTerrainRock({THREE, scene3d, ...})`
// takes it, and every GPU object is optional — with no THREE the fields still
// run their full CPU bookkeeping. That is what keeps `test_terrain_rock.mjs` a
// pure-node test and what makes `?nullRender=1` free.
//
// LIGHTING — the one thing no earlier family needed. Every previous scatter
// field is ADDITIVE, so it needs no light term at all. Pebbles are opaque and
// lit, and an opaque rock that ignores the sun glows at midnight. The inputs
// come from `skyLightingController._lastState` — the once-per-frame cached
// snapshot plan §2.3 names as THE read path ("never call `getSkyState()`
// yourself"); the heading/pitch→vector conversion and the
// `LSCAPE_LIGHT_MINIMUM` ambient floor are the same ones
// `loop.js::tickTerrainSunDir` applies to the ground the pebbles sit on, and so
// is the 15 s `LScape::UseTime` light-tick quantisation — the visible stepping
// of landscape brightness IS the retail look, and pebbles that brightened
// smoothly while the ground under them stepped would read as a bug.
// **No light is created and no light count changes** (§5.2): this is a vertex
// term in one ShaderMaterial.
//
// INVARIANTS (plan §5). A HOST module, not a registered VFX component: it is
// not swept by `vfx/lint_caps.js`. It obeys the firewall anyway — it reads
// static terrain, a server-derived player position, the shared clock, the
// shared wind and the shared sky snapshot, and writes only its own buffers and
// uniforms. It adds no light (§5.2), never sets `.visible` (§5.3), varies no
// program cache key (§5.4 — one material per field, no per-instance key), uses
// no `Math.random` (§5.5), binds the clock BY REFERENCE (§5.6) and sets
// `castShadow = false` (§5.7 — added geometry is paid a second time by the
// shadow depth pass, and pebbles are exactly the "added geometry" that rule is
// about).
//
// FLAGS (plan §2.4, all STRICT `=== "on"` opt-ins that ship OFF):
//   ?terrainRock            family master (also `?terrainVfx=off`, `?visual=off`
//                                          and `?wireframe=1` kill everything)
//   ?terrainRockPebbles     ?terrainRockGrit
//   ?terrainRockPebbleCount ?terrainRockGritCount ?terrainRockRadius
//   ?terrainRockDensity     0..2 multiplier on BOTH counts (URL-only)

import {
  FAM_ROCK,
  TERRAIN_CODE_COUNT,
  familyForCode,
} from "./terrain_families.js";
import { createScatterPool, SCATTER_FADE_GLSL } from "./terrain_scatter.js";
import {
  registerTerrainVfx,
  unregisterTerrainVfx,
  lbKeyFromXY,
  wireframeActive,
} from "./terrain_vfx.js";
import {
  terrainRockEnabled,
  terrainRockPebblesEnabled,
  terrainRockGritEnabled,
  terrainRockPebbleCount,
  terrainRockGritCount,
  terrainRockRadiusM,
  terrainRockDensity,
} from "./vfx_flags.js";

export const METERS_PER_LANDBLOCK = 192;
export const VERTEX_GRID = 9;
export const VERTEX_SPACING_M = 24;

/** Provider ids — also the `VFX_EFFECT_FLAGS` router rows. */
export const PEBBLE_PROVIDER_ID = "terrain.rockPebbles";
export const GRIT_PROVIDER_ID = "terrain.rockGrit";

// ---------------------------------------------------------------------------
// Retail light-tick constants. Same values and same reasons as
// `loop.js::tickTerrainSunDir` (Dereth's Region DAT carries
// skyInfo.lightTickSize = 15 s; `LSCAPE_LIGHT_MINIMUM` floors AMBIENT only,
// acclient.c:40344). Duplicated rather than imported because `loop.js` keeps
// them module-private and this module must stay THREE-free and import-light.
// ---------------------------------------------------------------------------
export const ROCK_LIGHT_TICK_SEC = 15.0;
export const ROCK_AMBIENT_MINIMUM = 0.2;

// ---------------------------------------------------------------------------
// Pure helpers + the per-code sub-variant table. No THREE, no window. The
// directly-tested surface.
// ---------------------------------------------------------------------------

/** The three pebble silhouettes (plan §3.3: "3 pebble shapes chosen by hash").
 *
 *  ⚠ HOW "THREE MESHES" IS SPENT AS ONE DRAW CALL. The plan words this as "a
 *  different instance mesh (3 pebble shapes chosen by hash)". Three geometries
 *  means either three `InstancedMesh`es (three draw calls, and — because the
 *  scatter pool's slot grid is a pure function of the world cell — three pools
 *  each burning 2/3 of their slots on degenerate instances) or a merged
 *  geometry the vertex shader collapses. Neither is worth it: the shapes here
 *  are ONE faceted octahedron under three PROPORTION profiles plus a per-shape
 *  TILT off the ground plane, which is what actually separates a flat shale
 *  plate lying flush from an angular shard jutting out of the dirt. One
 *  geometry, one draw call, no wasted slots, and the hash still chooses.
 *
 *  `scale` is the (along, across, up) half-extent multiplier applied to the
 *  variant's `sizeM`; `jitter` is the per-instance ±fraction on each axis;
 *  `tilt` is the maximum lean away from the ground normal, in radians. */
export const PEBBLE_SHAPE_ROUND = 0;
export const PEBBLE_SHAPE_PLATE = 1;
export const PEBBLE_SHAPE_SHARD = 2;
export const PEBBLE_SHAPE_COUNT = 3;
export const PEBBLE_SHAPE_PROFILES = Object.freeze([
  // A rounded cobble: near-equant, sitting low.
  Object.freeze({ name: "round", scale: [1.0, 0.88, 0.72], jitter: 0.32, tilt: 0.18 }),
  // A shale plate: wide, thin, lying almost flush with the ground.
  Object.freeze({ name: "plate", scale: [1.5, 1.15, 0.24], jitter: 0.28, tilt: 0.1 }),
  // A shard: narrow, tall, leaning hard out of the surface.
  Object.freeze({ name: "shard", scale: [0.6, 0.48, 1.45], jitter: 0.42, tilt: 0.55 }),
]);

/**
 * The per-code sub-variant table (plan §1.3: "sub-variants that matter to a
 * family's tuning are a per-code parameter table INSIDE the family module, not
 * a separate family"). Keyed by TERRAIN CODE — never by name and never by
 * texture (plan §2.7.2 / §8 risk 12).
 *
 *   density  keep-probability for a pebble on this code, 0..1. It biases
 *            WITHIN the pool rather than resizing it, so the tier keeps owning
 *            the instance count (§5.8) and a rejected pebble costs one vertex
 *            invocation (the pool writes it degenerate).
 *   sizeM    base half-extent, metres, before the shape profile and the jitter.
 *   shape    the [round, plate, shard] weights the hash draws against. 13/14
 *            shed flatter SHALE PLATES; 30 throws angular SHARDS (plan §3.3).
 *   tint     linear RGB albedo.
 *   emissive 0..1 — the faint sickly glow, `olthoi` only.
 *   grit     relative grit-streamer weight on this code.
 *   olthoi   true ⇒ this code gets the chitin treatment. Derived from, not
 *            duplicated by, `olthoiTerrainCodes()`.
 */
export const ROCK_VARIANTS = Object.freeze({
  // BarrenRock — the reference: bare stone, plenty of loose cobble.
  0: Object.freeze({
    density: 1.0, sizeM: 0.19, shape: [0.6, 0.2, 0.2],
    tint: [0.56, 0.53, 0.5], emissive: 0, grit: 1.0, olthoi: false,
  }),
  // SedimentaryRock — bedded stone, so it sheds PLATES above all.
  13: Object.freeze({
    density: 0.85, sizeM: 0.22, shape: [0.25, 0.65, 0.1],
    tint: [0.6, 0.55, 0.46], emissive: 0, grit: 1.15, olthoi: false,
  }),
  // SemiBarrenRock — the same beds, partly covered, so fewer of everything.
  14: Object.freeze({
    density: 0.7, sizeM: 0.2, shape: [0.35, 0.55, 0.1],
    tint: [0.52, 0.51, 0.46], emissive: 0, grit: 0.8, olthoi: false,
  }),
  // olthoi — chitinous shards over a sour, dark ground; the only emissive row.
  30: Object.freeze({
    density: 0.6, sizeM: 0.26, shape: [0.1, 0.15, 0.75],
    tint: [0.35, 0.39, 0.28], emissive: 1, grit: 0.55, olthoi: true,
  }),
});

/** The sickly olthoi glow, linear RGB. Dim on purpose: it is a FRAGMENT term
 *  added to an opaque surface, so it reads as luminescent chitin rather than as
 *  a light source — and it never becomes one (§5.2). */
export const OLTHOI_EMISSIVE_COLOUR = Object.freeze([0.24, 0.72, 0.33]);

/** The terrain codes that are FAM_ROCK, DERIVED from the family LUT. */
export function rockTerrainCodes() {
  const out = [];
  for (let c = 0; c < TERRAIN_CODE_COUNT; c += 1) {
    if (familyForCode(c) === FAM_ROCK) out.push(c);
  }
  return out;
}

/** The same set as a GPU bitmask (the `computeCodeBitmask` convention). */
export function rockCodeBitmask() {
  let mask = 0;
  for (const c of rockTerrainCodes()) mask |= (1 << c);
  return mask >>> 0;
}

/**
 * The OLTHOI codes: the FAM_ROCK members whose sub-variant row says
 * `olthoi: true` — i.e. 30 alone. Derived rather than written out, so the
 * family LUT stays the single source of truth for membership and this table
 * stays the single source of truth for which member is olthoi (the
 * `iceTerrainCodes()` precedent).
 */
export function olthoiTerrainCodes() {
  return rockTerrainCodes().filter((c) => ROCK_VARIANTS[c] && ROCK_VARIANTS[c].olthoi === true);
}

/** The olthoi set as a GPU bitmask. A STRICT SUBSET of `rockCodeBitmask()`. */
export function olthoiCodeBitmask() {
  let mask = 0;
  for (const c of olthoiTerrainCodes()) mask |= (1 << c);
  return mask >>> 0;
}

/** Tuning that is NOT worth a URL flag. */
export const ROCK_TUNING = Object.freeze({
  // --- pebbles ------------------------------------------------------------
  // Sink: pebbles are pushed DOWN into the ground by this fraction of their
  // vertical half-extent, so they read as embedded rather than as dropped.
  pebbleSinkFraction: 0.35,
  // Per-instance albedo brightness spread, ±fraction.
  pebbleTintJitter: 0.18,
  // The olthoi glow breathes on a long, slow cycle so a shard field shimmers
  // rather than strobes. Hz.
  emissivePulseHz: 0.09,
  // The last fraction of the radius over which a pebble shrinks to nothing.
  // Opaque geometry cannot alpha-fade without paying a transparent pass, so
  // the distance blend is a SHRINK (the grass rule, plan §3.1).
  pebbleFadeFraction: 0.22,
  // --- grit streamers (the §3.2 maths at rock parameters) -----------------
  // Shorter and finer than a sand streak: this is grit skittering, not a sheet
  // in suspension.
  streakLengthM: 1.4,
  streakWidthM: 0.14,
  streakLengthJitter: 0.6,
  // Hugs the ground harder than sand (0.05..0.4).
  liftMinM: 0.02,
  liftMaxM: 0.18,
  // Advection. A touch faster than sand over a SHORTER recycle span — "shorter
  // life" (plan §3.3 item 2) expressed in the only place a recycling streak has
  // a life: the span it crosses before it wraps.
  advectSpeed: 3.6,
  advectSpanM: 14,
  // The pulse field: grit comes in skittering trains, tighter than sand sheets.
  pulseFreq: 0.13,
  pulseScrollHz: 0.09,
  pulseThreshold: 0.5,
  // Colour + opacity: GREYER than sand (plan §3.3) and dimmer — additive over
  // the whole near field, so both cost and blow-out risk are fill-bound.
  colour: [0.62, 0.6, 0.57],
  opacity: 0.12,
});

/**
 * Resolve the live ROCK quality tier. `null` ⇒ the whole family is disabled at
 * this tier (plan §5.8: "`low` is null/disabled for every effect here without
 * exception"). Pure in `flags`.
 *
 * @param {object|null} flags `liveScene3d.quality.flags`-shaped bag.
 * @returns {{pebbleCount:number, gritCount:number, radiusM:number}|null}
 */
export function resolveRockQuality(flags) {
  const num = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);
  const pebbleCount = Math.max(0, Math.round(num(flags?.terrainRockPebbleCount, 0)));
  const gritCount = Math.max(0, Math.round(num(flags?.terrainRockGritCount, 0)));
  const radiusM = Math.min(512, Math.max(8, num(flags?.terrainRockRadius, 56)));
  if (pebbleCount === 0 && gritCount === 0) return null;
  return { pebbleCount, gritCount, radiusM };
}

/**
 * The shared wind vector in AC ground coordinates (+X east, +Y north).
 *
 * `VFX_GLOBALS.uWindDir` is a `Vector2` holding the THREE-space ground wind
 * `(x, z)` (`vfx/weather_inputs.js::writeWindVector`), and three `z` is AC `-y`
 * — so the conversion is `(w.x, -w.y)`. It is bound BY REFERENCE and written
 * once per frame by `loop.js::tickVfxWeatherInputs`; never snapshot it.
 *
 * With no globals (node, or a boot that has not built the VFX uniforms) this
 * falls back to `tree_wind.js`'s prevailing 135° (SE) at unit strength, so the
 * effect is still deterministic and still moves.
 *
 * ⚠ FOURTH COPY (sand, snow, dirt, rock). Deliberate, and noted: consolidating
 * it is a cross-family refactor of three landed modules, which the wave-3
 * handoff §3 already books as a cleanup candidate.
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
 * Grit advection — the offset (metres, AC frame) of one streak from its
 * scattered anchor at time `tSec`.
 *
 * THE CONTRACT (plan §3.2 tests, inherited by §3.3 item 2): a PURE function of
 * (wind, clock, hash). No player state, no frame history, no `Math.random`. The
 * GLSL in `ROCK_GRIT_VERTEX_GLSL` computes exactly this expression, and it is
 * the same expression as `terrain_sand.js::streamerAdvect` and
 * `terrain_snow.js::spindriftAdvect` — only the parameters differ, which is
 * what "a parameter block, not a new module" means once the module boundary is
 * a family rather than an effect.
 *
 * @param {number} windX AC east component
 * @param {number} windY AC north component
 * @param {number} tSec  the shared clock (`scene3d.frameTime.tsSec`)
 * @param {number} phase01 per-instance hash, [0,1)
 * @param {number} spanM recycle distance
 * @param {number} speed metres/second per unit wind magnitude
 * @param {{x:number,y:number,s:number}} [out]
 */
export function gritAdvect(windX, windY, tSec, phase01, spanM, speed, out) {
  const o = out || { x: 0, y: 0, s: 0 };
  const span = Number.isFinite(spanM) && spanM > 0 ? spanM : ROCK_TUNING.advectSpanM;
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
 * Which of the three silhouettes does this code + hash draw?
 *
 * PURE and deterministic. The weights come from the per-code variant row, so
 * `SedimentaryRock` mostly draws plates and `olthoi` mostly draws shards while
 * every code can still draw any shape — a field of identical silhouettes reads
 * as decals, not as rubble.
 *
 * @param {number} code terrain code
 * @param {number} r01 a deterministic [0,1) draw (the pool's `ctx.rand`)
 * @returns {number} 0 round | 1 plate | 2 shard
 */
export function pebbleShapeFor(code, r01) {
  const v = ROCK_VARIANTS[code];
  const w = v ? v.shape : [1, 0, 0];
  let total = 0;
  for (let i = 0; i < PEBBLE_SHAPE_COUNT; i += 1) total += Math.max(0, w[i] || 0);
  if (!(total > 0)) return PEBBLE_SHAPE_ROUND;
  const r = (Number.isFinite(r01) ? Math.min(0.9999999, Math.max(0, r01)) : 0) * total;
  let acc = 0;
  for (let i = 0; i < PEBBLE_SHAPE_COUNT; i += 1) {
    acc += Math.max(0, w[i] || 0);
    if (r < acc) return i;
  }
  return PEBBLE_SHAPE_COUNT - 1;
}

/**
 * The (along, across, up) half-extents in metres for one pebble.
 *
 * PURE. `rSize` scales the whole pebble; `rJx/rJy/rJz` are the per-axis jitter
 * draws. Zero-alloc when `out` is supplied.
 *
 * @param {number} code terrain code
 * @param {number} shapeIdx from `pebbleShapeFor`
 * @param {number} rSize [0,1) overall size draw
 * @param {number} rJx [0,1)
 * @param {number} rJy [0,1)
 * @param {number} rJz [0,1)
 * @param {{x:number,y:number,z:number}} [out]
 */
export function pebbleDimensions(code, shapeIdx, rSize, rJx, rJy, rJz, out) {
  const o = out || { x: 0, y: 0, z: 0 };
  const v = ROCK_VARIANTS[code];
  const base = v ? v.sizeM : 0.18;
  const p = PEBBLE_SHAPE_PROFILES[shapeIdx] || PEBBLE_SHAPE_PROFILES[PEBBLE_SHAPE_ROUND];
  // Overall size: 0.6x .. 1.4x, squared so small pebbles outnumber big ones
  // (a real scree field is mostly grit-sized).
  const r = Number.isFinite(rSize) ? Math.min(1, Math.max(0, rSize)) : 0.5;
  const size = base * (0.6 + 0.8 * r * r);
  const j = p.jitter;
  o.x = size * p.scale[0] * (1 + (Math.min(1, Math.max(0, rJx)) - 0.5) * 2 * j);
  o.y = size * p.scale[1] * (1 + (Math.min(1, Math.max(0, rJy)) - 0.5) * 2 * j);
  o.z = size * p.scale[2] * (1 + (Math.min(1, Math.max(0, rJz)) - 0.5) * 2 * j);
  return o;
}

/**
 * The per-instance orthonormal basis, the CPU twin of the vertex shader's.
 *
 * THE CONTRACT plan §3.3's test names: **the instance up-axis matches
 * `oracle.sample().normal`**. With `tilt === 0` the returned `up` IS the
 * (normalised) ground normal, which is exactly what the pool writes into the
 * `aNormal` attribute; a non-zero `tilt` leans the pebble by that many radians
 * about the `ey` axis, which is how a shard juts out of the surface while a
 * plate lies flush. `groundUp` is always the untilted normal, so the lock can
 * be asserted on a tilted instance too.
 *
 * The GLSL below computes the same thing with the same reference-axis choice —
 * a different `ref` would spin every pebble and the yaw would stop meaning
 * anything.
 *
 * @param {number} nx ground normal
 * @param {number} ny
 * @param {number} nz
 * @param {number} yaw radians about the ground normal
 * @param {number} [tilt] radians of lean away from it
 * @param {object} [out] reused {ex:{}, ey:{}, up:{}, groundUp:{}}
 */
export function pebbleBasis(nx, ny, nz, yaw, tilt, out) {
  const o = out || {
    ex: { x: 0, y: 0, z: 0 },
    ey: { x: 0, y: 0, z: 0 },
    up: { x: 0, y: 0, z: 0 },
    groundUp: { x: 0, y: 0, z: 0 },
  };
  let ux = Number.isFinite(nx) ? nx : 0;
  let uy = Number.isFinite(ny) ? ny : 0;
  let uz = Number.isFinite(nz) ? nz : 1;
  const nl = Math.sqrt(ux * ux + uy * uy + uz * uz);
  if (nl > 1e-6) { ux /= nl; uy /= nl; uz /= nl; } else { ux = 0; uy = 0; uz = 1; }
  o.groundUp.x = ux; o.groundUp.y = uy; o.groundUp.z = uz;

  // Reference axis: swap when the normal is nearly +/-X so the cross never
  // degenerates. Identical branch in the GLSL.
  const refX = Math.abs(ux) > 0.9 ? 0 : 1;
  const refY = Math.abs(ux) > 0.9 ? 1 : 0;
  // t = normalize(cross(up, ref))
  let tx = uy * 0 - uz * refY;
  let ty = uz * refX - ux * 0;
  let tz = ux * refY - uy * refX;
  const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
  tx /= tl; ty /= tl; tz /= tl;
  // b = cross(up, t)
  const bx = uy * tz - uz * ty;
  const by = uz * tx - ux * tz;
  const bz = ux * ty - uy * tx;

  const cy = Math.cos(yaw || 0);
  const sy = Math.sin(yaw || 0);
  let ex = tx * cy + bx * sy;
  let ey = ty * cy + by * sy;
  let ez = tz * cy + bz * sy;
  o.ey.x = -tx * sy + bx * cy;
  o.ey.y = -ty * sy + by * cy;
  o.ey.z = -tz * sy + bz * cy;

  // Lean about ey: up rotates toward ex.
  const t2 = Number.isFinite(tilt) ? tilt : 0;
  const ct = Math.cos(t2);
  const st = Math.sin(t2);
  o.up.x = ux * ct + ex * st;
  o.up.y = uy * ct + ey * st;
  o.up.z = uz * ct + ez * st;
  o.ex.x = ex * ct - ux * st;
  o.ex.y = ey * ct - uy * st;
  o.ex.z = ez * ct - uz * st;
  return o;
}

/**
 * Convert a sky-lighting snapshot to the AC-frame sun vector + the two light
 * colours the pebble material wants.
 *
 * PURE in `state`. `state` is `skyLightingController._lastState`
 * (`sky_lighting.js:44 snapshotSkyState`) — the once-per-frame cache plan §2.3
 * names as THE read path. The conversion is `loop.js::tickTerrainSunDir`'s,
 * verbatim: heading is measured from +Y (north) clockwise, pitch above the
 * horizon, the sun COLOUR carries `dirBright` as its magnitude
 * (`SkyDesc::GetLighting`, acclient.c:301548), and `LSCAPE_LIGHT_MINIMUM`
 * floors the AMBIENT level only (acclient.c:40344) — `dirBright` is left free
 * to reach 0 at night, which is the whole point of doing this at all.
 *
 * @param {object|null} state
 * @param {object} [out] reused
 * @returns {{ok:boolean, x:number, y:number, z:number, sun:number[],
 *   amb:number[], ambLevel:number}}
 */
export function rockSunFromSkyState(state, out) {
  const o = out || { ok: false, x: 0, y: 0, z: 1, sun: [1, 1, 1], amb: [1, 1, 1], ambLevel: ROCK_AMBIENT_MINIMUM };
  const heading = state ? state.dirHeading : NaN;
  const pitch = state ? state.dirPitch : NaN;
  if (!Number.isFinite(heading) || !Number.isFinite(pitch)) {
    o.ok = false;
    return o;
  }
  const DEG = Math.PI / 180;
  const cp = Math.cos(pitch * DEG);
  o.x = cp * Math.sin(heading * DEG);
  o.y = cp * Math.cos(heading * DEG);
  o.z = Math.sin(pitch * DEG);
  const db = Number.isFinite(+state.dirBright) ? Math.max(0, +state.dirBright) : 0;
  const dc = (state.dirColorArgb >>> 0);
  o.sun[0] = (((dc >>> 16) & 0xff) / 255) * db;
  o.sun[1] = (((dc >>> 8) & 0xff) / 255) * db;
  o.sun[2] = ((dc & 0xff) / 255) * db;
  const ac = (state.ambColorArgb >>> 0);
  o.amb[0] = ((ac >>> 16) & 0xff) / 255;
  o.amb[1] = ((ac >>> 8) & 0xff) / 255;
  o.amb[2] = (ac & 0xff) / 255;
  const ab = +state.ambBright;
  o.ambLevel = Math.max(ROCK_AMBIENT_MINIMUM, Number.isFinite(ab) ? ab : 0);
  o.ok = true;
  return o;
}

// ---------------------------------------------------------------------------
// The pebble field — GLSL. Kept as exported strings so the shader test can
// assert on them without a GPU (the `terrain.js` / `terrain_sand.js`
// convention).
//
// ⚠ NO BACKTICKS anywhere in this GLSL, including comments: a stray backtick
// closes the JS template literal (this has bitten `terrain.js`, and it bit
// waves 1 and 2).
// ---------------------------------------------------------------------------

export const ROCK_PEBBLE_VERTEX_GLSL = `
precision highp float;

// Per-instance (written by terrain_scatter.js; see the schema below).
attribute vec3 aOffset;   // AC world position of the anchor (x, y, z=ground)
attribute vec3 aScale;    // (along, across, up) half-extents in metres
attribute vec3 aNormal;   // GROUND normal at the anchor, AC frame (+Z up)
attribute vec3 aTint;     // linear RGB albedo for this pebble
attribute vec3 aRock;     // (yaw, tilt, emissive)

uniform float uTime;      // the SHARED clock, bound by reference (plan 5.6)
uniform vec3  uSunDir;    // AC-frame unit vector TO the sun
uniform vec3  uSunColour; // dirColor * dirBright (0 at night, on purpose)
uniform vec3  uAmbColour;
uniform float uAmbLevel;  // floored at LSCAPE_LIGHT_MINIMUM
uniform float uPulseHz;   // olthoi emissive breath

varying vec3 vLight;
varying vec3 vTint;
varying float vEmissive;

${SCATTER_FADE_GLSL}

void main() {
  // --- the per-instance basis: the JS twin is terrain_rock.js::pebbleBasis ---
  vec3 up = aNormal;
  float nl = length(up);
  up = nl > 1e-6 ? up / nl : vec3(0.0, 0.0, 1.0);
  vec3 ref = abs(up.x) > 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t = normalize(cross(up, ref));
  vec3 b = cross(up, t);
  float cy = cos(aRock.x);
  float sy = sin(aRock.x);
  vec3 ex = t * cy + b * sy;
  vec3 ey = -t * sy + b * cy;
  // Lean about ey. A shale plate lies flush; a shard juts.
  float ct = cos(aRock.y);
  float st = sin(aRock.y);
  vec3 up2 = up * ct + ex * st;
  vec3 ex2 = ex * ct - up * st;

  // --- distance blend: a SHRINK, not an alpha ramp -------------------------
  // Pebbles are OPAQUE. Fading them with alpha would drag the whole field into
  // the transparent pass and its sorting; shrinking to zero scale costs one
  // degenerate vertex invocation, exactly like the pool own family reject.
  // The centre is the pool LIVE uniform, so the blend is exact for THIS frame
  // rather than the value baked at scatter time.
  vec3 anchor = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float fade = hbScatterFade(anchor.xy);
  vec3 s = aScale * fade;

  vec3 local = ex2 * (position.x * s.x) + ey * (position.y * s.y) + up2 * (position.z * s.z);

  // instanceMatrix carries the anchor translation AND the pool 0/1 live scale,
  // so a degenerate (wrong-family / unbaked / out-of-range / density-rejected)
  // instance collapses to a point and is zero-area for this material too.
  vec4 placed = instanceMatrix * vec4(local, 1.0);

  // --- lighting: AC Gouraud, no light object, no light-count change --------
  // Inverse-transpose of a diagonal scale in the rotated frame.
  vec3 inv = 1.0 / max(s, vec3(1e-4));
  vec3 nAc = normalize(ex2 * (normal.x * inv.x) + ey * (normal.y * inv.y) + up2 * (normal.z * inv.z));
  float ndl = clamp(dot(nAc, uSunDir), 0.0, 1.0);
  vLight = uAmbColour * uAmbLevel + uSunColour * ndl;

  vTint = aTint;
  // The breath is phased by the instance yaw so a shard field shimmers instead
  // of strobing in lockstep.
  vEmissive = aRock.z * (0.72 + 0.28 * sin(uTime * uPulseHz * 6.2831853 + aRock.x));

  gl_Position = projectionMatrix * modelViewMatrix * vec4(placed.xyz, 1.0);
}
`;

export const ROCK_PEBBLE_FRAGMENT_GLSL = `
precision highp float;

uniform vec3 uEmissiveColour;

varying vec3 vLight;
varying vec3 vTint;
varying float vEmissive;

void main() {
  // Opaque and lit. The emissive term is ADDED after the light term, so it
  // survives the night — which is the entire point of the olthoi variant.
  vec3 c = vTint * vLight + uEmissiveColour * max(vEmissive, 0.0);
  gl_FragColor = vec4(c, 1.0);
}
`;

/** The per-instance attribute schema the pool allocates for a pebble field. */
export const ROCK_PEBBLE_SCHEMA = Object.freeze([
  { name: "aOffset", itemSize: 3 },
  { name: "aScale", itemSize: 3 },
  { name: "aNormal", itemSize: 3 },
  { name: "aTint", itemSize: 3 },
  { name: "aRock", itemSize: 3 },
]);

// ---------------------------------------------------------------------------
// The grit field — GLSL. The §3.2 streamer shader at rock parameters.
// ---------------------------------------------------------------------------

export const ROCK_GRIT_VERTEX_GLSL = `
precision highp float;

// Per-instance (written by terrain_scatter.js; see the schema below).
attribute vec3 aOffset;    // AC world position of the anchor (x, y, z=ground+lift)
attribute vec2 aScale;     // (length, width) in metres
attribute vec4 aGrit;      // (phase01, speedMul, spare, opacity)

uniform float uTime;       // the SHARED clock, bound by reference (plan 5.6)
uniform vec2  uWindAc;     // AC ground wind (+X east, +Y north), live
uniform float uSpanM;      // advection recycle distance
uniform float uSpeed;      // metres/sec per unit wind magnitude
uniform float uPulseFreq;  // cycles per metre
uniform float uPulseScroll;
uniform float uPulseThreshold;

varying vec2 vQuadUv;
varying float vAlpha;

${SCATTER_FADE_GLSL}

// Cheap value noise (the terrain.js fragValueNoise2D shape, vertex-side).
float rockHash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float rockNoise2D(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = rockHash21(i);
  float b = rockHash21(i + vec2(1.0, 0.0));
  float c = rockHash21(i + vec2(0.0, 1.0));
  float d = rockHash21(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

void main() {
  // --- advection: the JS twin is terrain_rock.js::gritAdvect ---------------
  float wl = max(length(uWindAc), 1e-4);
  vec2 dir = uWindAc / wl;
  vec2 side = vec2(-dir.y, dir.x);
  float travelled = uTime * uSpeed * aGrit.y * wl + aGrit.x * uSpanM;
  float s = mod(travelled, uSpanM) - uSpanM * 0.5;
  vec2 adv = dir * s;

  // --- the quad, laid FLAT and stretched along the wind ---------------------
  vec2 local2 = adv + dir * (position.x * aScale.x) + side * (position.y * aScale.y);
  vec3 local = vec3(local2, 0.0);

  vec4 placed = instanceMatrix * vec4(local, 1.0);

  // --- the pulse field: trains of grit form and dissolve -------------------
  vec2 pulseXy = placed.xy * uPulseFreq + dir * (uTime * uPulseScroll);
  float n = rockNoise2D(pulseXy);
  float pulse = smoothstep(uPulseThreshold, 1.0, n);

  // Distance blend, identical in form to the CPU fadeFor() (LINEAR).
  float fade = hbScatterFade(placed.xy);

  vAlpha = pulse * fade * aGrit.w;
  vQuadUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(placed.xyz, 1.0);
}
`;

export const ROCK_GRIT_FRAGMENT_GLSL = `
precision highp float;

uniform vec3 uColour;
uniform float uOpacity;

varying vec2 vQuadUv;
varying float vAlpha;

void main() {
  // Soft streak, tighter across than sand: grit skitters in a narrow line.
  vec2 c = abs(vQuadUv * 2.0 - 1.0);
  float along = 1.0 - c.x;
  float across = 1.0 - c.y;
  float mask = pow(max(along, 0.0), 1.3) * pow(max(across, 0.0), 2.6);
  float a = mask * vAlpha * uOpacity;
  if (a <= 0.0) discard;
  gl_FragColor = vec4(uColour * a, a);
}
`;

/** The per-instance attribute schema the pool allocates for a grit field. */
export const ROCK_GRIT_SCHEMA = Object.freeze([
  { name: "aOffset", itemSize: 3 },
  { name: "aScale", itemSize: 2 },
  { name: "aGrit", itemSize: 4 },
]);

// ---------------------------------------------------------------------------
// Geometry builders (THREE optional).
// ---------------------------------------------------------------------------

/**
 * A faceted unit octahedron: 8 triangles, NON-indexed (24 vertices) so every
 * face carries its own normal and the pebble shades as chipped stone rather
 * than as a smooth ball. Half-extent 0.5 on each axis, so the per-instance
 * `aScale` reads directly as the pebble's full size.
 */
function _pebbleGeometry(THREE) {
  const geom = new THREE.BufferGeometry();
  const px = 0.5;
  const verts = [
    [px, 0, 0], [-px, 0, 0], [0, px, 0], [0, -px, 0], [0, 0, px], [0, 0, -px],
  ];
  const faces = [
    [0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4],
    [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5],
  ];
  const pos = new Float32Array(faces.length * 9);
  const nrm = new Float32Array(faces.length * 9);
  let w = 0;
  for (const f of faces) {
    const a = verts[f[0]];
    const b = verts[f[1]];
    const c = verts[f[2]];
    // Face normal = normalize(cross(b - a, c - a)).
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (const v of [a, b, c]) {
      pos[w] = v[0]; pos[w + 1] = v[1]; pos[w + 2] = v[2];
      nrm[w] = nx; nrm[w + 1] = ny; nrm[w + 2] = nz;
      w += 3;
    }
  }
  geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geom.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  geom.name = "rock-pebble";
  return geom;
}

/**
 * A unit quad in the XY plane (AC ground plane), centred, with uv.
 *
 * ⚠ FOURTH COPY of the ~15-line flat-quad builder (sand, snow, dirt, rock).
 * The wave-3 handoff §3 already books consolidating it as a wave-5 cleanup and
 * the owner's no-refactor rule keeps it out of this wave; adding the copy is
 * the sanctioned move, removing the other three is not.
 */
function _gritGeometry(THREE) {
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
  geom.name = "rock-grit";
  return geom;
}

// ---------------------------------------------------------------------------
// The pebble field (THREE optional).
// ---------------------------------------------------------------------------

/**
 * Create the camera-scoped pebble/rubble field.
 *
 * @param {object} opts
 * @param {object} [opts.THREE]    injected; omit for a headless CPU-only field.
 * @param {object} [opts.parent]   Object3D to hang the mesh off (AC space).
 * @param {object|Function} opts.oracle the terrain oracle, or a GETTER (use the
 *   getter form: `ctx.oracle` / `frameCtx.oracle` is LIVE and must never be
 *   stashed — wave-0 handoff §5).
 * @param {object} [opts.globals]  VFX_GLOBALS (uTime, BY REFERENCE).
 * @param {number} [opts.count]    instances (rounded up to a square).
 * @param {number} [opts.radiusM]
 * @param {number} [opts.seed]
 */
export function createPebbleField(opts = {}) {
  const THREE = opts.THREE || null;
  const count = Math.max(1, Math.round(Number.isFinite(opts.count) ? opts.count : 9000));
  const radiusM = Math.min(512, Math.max(8, Number.isFinite(opts.radiusM) ? opts.radiusM : 56));
  const seed = (Number.isFinite(opts.seed) ? opts.seed : 0x520c4bed) | 0;
  const globals = opts.globals || null;
  const tuning = { ...ROCK_TUNING, ...(opts.tuning || {}) };

  let geometry = null;
  let material = null;

  // THE UNIFORM BAG. Built FIRST and handed to BOTH the ShaderMaterial and the
  // pool (the wave-2A `opts.uniforms` in-parameter), so the pool publishes its
  // four distance-blend uniforms straight into the bag the compiled shader is
  // already holding — no placeholder-then-repoint dance.
  //
  // THE CLOCK IS BOUND BY IDENTITY (plan §5.6, the `test_vfx_glint.mjs`
  // assertion): with VFX_GLOBALS injected we ADOPT its `uTime` object rather
  // than minting a clone, so `loop.js::tickVfxOscillators` drives the olthoi
  // breath off the same object as every other VFX channel. `_ownsClock`
  // records whether we may write it.
  const _sharedTime = globals && globals.uTime && typeof globals.uTime === "object"
    ? globals.uTime
    : null;
  const _ownsClock = _sharedTime === null;
  const uniforms = {
    uTime: _sharedTime || { value: 0 },
    uSunDir: { value: null },
    uSunColour: { value: null },
    uAmbColour: { value: null },
    uAmbLevel: { value: ROCK_AMBIENT_MINIMUM },
    uPulseHz: { value: tuning.emissivePulseHz },
    uEmissiveColour: { value: null },
    // Adopted + populated by the pool below (never placeholders to re-point).
    uScatterCenter: { value: null },
    uScatterRadius: { value: radiusM },
    uScatterFadeStart: { value: radiusM * (1 - tuning.pebbleFadeFraction) },
    uScatterShape: { value: 0 },
  };

  if (THREE && typeof THREE.ShaderMaterial === "function") {
    try {
      geometry = _pebbleGeometry(THREE);
      uniforms.uSunDir.value = new THREE.Vector3(-0.4, -0.3, 1.0).normalize();
      uniforms.uSunColour.value = new THREE.Color(1, 1, 1);
      uniforms.uAmbColour.value = new THREE.Color(1, 1, 1);
      uniforms.uEmissiveColour.value = new THREE.Color(
        OLTHOI_EMISSIVE_COLOUR[0], OLTHOI_EMISSIVE_COLOUR[1], OLTHOI_EMISSIVE_COLOUR[2],
      );
      uniforms.uScatterCenter.value = new THREE.Vector3(0, 0, 0);
      material = new THREE.ShaderMaterial({
        vertexShader: ROCK_PEBBLE_VERTEX_GLSL,
        fragmentShader: ROCK_PEBBLE_FRAGMENT_GLSL,
        // The SAME objects the pool will publish into — no spread, no copy.
        uniforms,
        transparent: false,
        depthWrite: true,
        depthTest: true,
        side: THREE.FrontSide,
      });
      material.name = "terrain-rock-pebbles";
    } catch (_) {
      geometry = null;
      material = null;
    }
  }

  const dims = { x: 0, y: 0, z: 0 };

  const pool = createScatterPool({
    THREE,
    name: "terrain-rock-pebbles",
    count,
    radiusM,
    seed,
    // Salted so a pebble and a grass blade (or a sand streak) landing in the
    // SAME world cell do not draw the same numbers (wave-1 handoff §6).
    randSalt: 0x3b,
    shape: "disc",
    fadeFraction: tuning.pebbleFadeFraction,
    jitter: 1,
    families: [FAM_ROCK],
    attributes: ROCK_PEBBLE_SCHEMA.map((a) => ({ ...a })),
    uniforms,
    // PER-CODE DENSITY. The pool has already written ctx.code from the oracle
    // when `accept` runs. A rejected pebble is written degenerate (zero-area),
    // i.e. one vertex invocation and nothing else — the tier keeps owning the
    // instance count (§5.8) while barren rock still reads denser than olthoi.
    accept(sample, ctx) {
      const v = ROCK_VARIANTS[ctx.code];
      if (!v) return false;
      return ctx.rand(9) < v.density;
    },
    fill(ctx) {
      const v = ROCK_VARIANTS[ctx.code] || ROCK_VARIANTS[0];
      const shape = pebbleShapeFor(ctx.code, ctx.rand(3));
      pebbleDimensions(ctx.code, shape, ctx.rand(4), ctx.rand(5), ctx.rand(6), ctx.rand(7), dims);
      ctx.set("aScale", dims.x, dims.y, dims.z);
      // SINK. A pebble resting exactly on the surface reads as dropped; push
      // it into the ground by a fraction of its own height.
      ctx.z -= dims.z * tuning.pebbleSinkFraction;
      const yaw = ctx.rand(8) * Math.PI * 2;
      const tiltMax = (PEBBLE_SHAPE_PROFILES[shape] || PEBBLE_SHAPE_PROFILES[0]).tilt;
      const tilt = (ctx.rand(10) - 0.5) * 2 * tiltMax;
      ctx.set("aRock", yaw, tilt, v.emissive ? (0.55 + 0.45 * ctx.rand(11)) : 0);
      // Albedo: the per-code tint with a per-instance brightness spread, so a
      // scree field is not one flat colour.
      const j = 1 + (ctx.rand(12) - 0.5) * 2 * tuning.pebbleTintJitter;
      ctx.set("aTint", v.tint[0] * j, v.tint[1] * j, v.tint[2] * j);
      // NOTE: `aNormal` is written by the pool itself (the GROUND normal, plan
      // §3.3's "aligned to oracle.sample().normal") and is deliberately NOT
      // touched here — the lean lives in `aRock.y`, so the up-axis lock stays
      // assertable on a tilted pebble.
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
    mesh.name = "terrain-rock-pebbles";
    mesh.castShadow = false;      // §5.7 — added geometry is paid twice
    mesh.receiveShadow = false;
  }

  const sun = {
    ok: false, x: 0, y: 0, z: 1,
    sun: [1, 1, 1], amb: [1, 1, 1], ambLevel: ROCK_AMBIENT_MINIMUM,
  };
  const state = {
    frames: 0,
    lastRescattered: 0,
    built: !!mesh,
    lightTicks: 0,
    nextLightTick: -Infinity,
    sunOk: false,
  };

  /**
   * Refresh the light uniforms from a sky snapshot, on the RETAIL CADENCE.
   * `LScape::UseTime` (acclient.c:307257) only re-lights the landscape when the
   * light tick expires, and `loop.js::tickTerrainSunDir` quantises the ground
   * to the same 15 s. Pebbles step with the ground they sit on; a smooth push
   * here would make them disagree with it every dusk.
   */
  function _pushLight(skyState, tSec) {
    const t = Number.isFinite(tSec) ? tSec : 0;
    if (t < state.nextLightTick) return false;
    if (!rockSunFromSkyState(skyState, sun).ok) return false;
    state.nextLightTick = t + ROCK_LIGHT_TICK_SEC;
    state.lightTicks += 1;
    state.sunOk = true;
    const d = uniforms.uSunDir.value;
    if (d && typeof d.set === "function") d.set(sun.x, sun.y, sun.z);
    const sc = uniforms.uSunColour.value;
    if (sc && typeof sc.setRGB === "function") sc.setRGB(sun.sun[0], sun.sun[1], sun.sun[2]);
    const ac = uniforms.uAmbColour.value;
    if (ac && typeof ac.setRGB === "function") ac.setRGB(sun.amb[0], sun.amb[1], sun.amb[2]);
    uniforms.uAmbLevel.value = sun.ambLevel;
    return true;
  }

  return {
    pool,
    uniforms,
    /** false ⇒ `uniforms.uTime` IS `VFX_GLOBALS.uTime` (bound by identity). */
    ownsClock: _ownsClock,
    get mesh() { return mesh; },
    get material() { return material; },
    get geometry() { return geometry; },
    /** The last resolved AC sun/ambient record (diagnostics + tests). */
    get light() { return sun; },
    /** Per-frame: re-centre the pool and refresh the light on the 15 s tick. */
    update(dt, tSec, px, py, pz, skyState) {
      state.frames += 1;
      if (_ownsClock) uniforms.uTime.value = Number.isFinite(tSec) ? tSec : 0;
      _pushLight(skyState || null, tSec);
      state.lastRescattered = pool.update(dt, px, py, pz);
      return state.lastRescattered;
    },
    /** Test/diag seam: force the next `update` to re-read the sky. */
    invalidateLight() { state.nextLightTick = -Infinity; },
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
        lightTicks: state.lightTicks,
        sunResolved: state.sunOk,
        sunDir: { x: sun.x, y: sun.y, z: sun.z },
        ambLevel: sun.ambLevel,
        pool: pool.stats(),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The grit field (THREE optional). The §3.2 streamer at rock parameters.
// ---------------------------------------------------------------------------

/**
 * Create the camera-scoped grit-streamer field.
 *
 * @param {object} opts same shape as `createPebbleField`.
 */
export function createGritField(opts = {}) {
  const THREE = opts.THREE || null;
  const count = Math.max(1, Math.round(Number.isFinite(opts.count) ? opts.count : 400));
  const radiusM = Math.min(512, Math.max(8, Number.isFinite(opts.radiusM) ? opts.radiusM : 56));
  const seed = (Number.isFinite(opts.seed) ? opts.seed : 0x520c4bed) | 0;
  const globals = opts.globals || null;
  const tuning = { ...ROCK_TUNING, ...(opts.tuning || {}) };

  let geometry = null;
  let material = null;

  const _sharedTime = globals && globals.uTime && typeof globals.uTime === "object"
    ? globals.uTime
    : null;
  const _ownsClock = _sharedTime === null;
  const uniforms = {
    uTime: _sharedTime || { value: 0 },
    uWindAc: { value: null },
    uSpanM: { value: tuning.advectSpanM },
    uSpeed: { value: tuning.advectSpeed },
    uPulseFreq: { value: tuning.pulseFreq },
    uPulseScroll: { value: tuning.pulseScrollHz },
    uPulseThreshold: { value: tuning.pulseThreshold },
    uColour: { value: null },
    uOpacity: { value: tuning.opacity },
    uScatterCenter: { value: null },
    uScatterRadius: { value: radiusM },
    uScatterFadeStart: { value: radiusM * 0.75 },
    uScatterShape: { value: 0 },
  };

  const wind = { x: 0, y: 0 };
  const advect = { x: 0, y: 0, s: 0 };

  if (THREE && typeof THREE.ShaderMaterial === "function") {
    try {
      geometry = _gritGeometry(THREE);
      uniforms.uWindAc.value = new THREE.Vector2(1, 0);
      uniforms.uColour.value = new THREE.Color(
        tuning.colour[0], tuning.colour[1], tuning.colour[2],
      );
      uniforms.uScatterCenter.value = new THREE.Vector3(0, 0, 0);
      material = new THREE.ShaderMaterial({
        vertexShader: ROCK_GRIT_VERTEX_GLSL,
        fragmentShader: ROCK_GRIT_FRAGMENT_GLSL,
        uniforms,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      material.name = "terrain-rock-grit";
    } catch (_) {
      geometry = null;
      material = null;
    }
  }

  const pool = createScatterPool({
    THREE,
    name: "terrain-rock-grit",
    count,
    radiusM,
    // A DIFFERENT pool seed from the pebbles, not just a different salt: the
    // pool salts `ctx.rand` but deliberately leaves PLACEMENT a pure function
    // of (world cell, seed), so two pools sharing a seed jitter to the SAME
    // point in every cell — and a grit streak sitting exactly on every pebble
    // is a visible artefact, not a coincidence.
    seed: (seed ^ 0x47524954) | 0,
    randSalt: 0x4c,
    shape: "disc",
    fadeFraction: 0.25,
    jitter: 1,
    families: [FAM_ROCK],
    attributes: ROCK_GRIT_SCHEMA.map((a) => ({ ...a })),
    uniforms,
    fill(ctx) {
      const v = ROCK_VARIANTS[ctx.code] || ROCK_VARIANTS[0];
      // Lift: 0.02..0.18 m above the ground. Hash-stable per cell.
      const lift = tuning.liftMinM + ctx.rand(3) * (tuning.liftMaxM - tuning.liftMinM);
      ctx.z += lift;
      const lenJ = 1 + (ctx.rand(4) - 0.5) * 2 * tuning.streakLengthJitter;
      ctx.set("aScale", tuning.streakLengthM * lenJ, tuning.streakWidthM);
      ctx.set(
        "aGrit",
        ctx.rand(5),                      // advection phase
        0.8 + ctx.rand(6) * 0.7,          // per-streak speed multiplier
        ctx.rand(7),                      // spare channel (unused by v1)
        (0.5 + ctx.rand(8) * 0.5) * ctx.fade * v.grit,
      );
    },
    oracle: opts.oracle,
    geometry,
    material,
    parent: opts.parent || null,
    writeInstanceMatrix: true,
    frustumCulled: false,
  });

  let mesh = pool.mesh || null;
  if (mesh) {
    mesh.name = "terrain-rock-grit";
    mesh.castShadow = false;      // §5.7 — added geometry is paid twice
    mesh.receiveShadow = false;
    mesh.renderOrder = 3;
  }

  const state = { frames: 0, lastRescattered: 0, built: !!mesh };

  return {
    pool,
    uniforms,
    ownsClock: _ownsClock,
    get mesh() { return mesh; },
    get material() { return material; },
    get geometry() { return geometry; },
    update(dt, tSec, px, py, pz) {
      state.frames += 1;
      windAcFromGlobals(globals, wind);
      if (_ownsClock) uniforms.uTime.value = Number.isFinite(tSec) ? tSec : 0;
      const wv = uniforms.uWindAc.value;
      if (wv) { wv.x = wind.x; wv.y = wind.y; }
      state.lastRescattered = pool.update(dt, px, py, pz);
      return state.lastRescattered;
    },
    /** The CPU twin of the shader advection, for diagnostics and tests. */
    advectionOf(phase01, tSec, speedMul) {
      windAcFromGlobals(globals, wind);
      return gritAdvect(
        wind.x, wind.y,
        Number.isFinite(tSec) ? tSec : 0,
        phase01,
        uniforms.uSpanM.value,
        uniforms.uSpeed.value * (Number.isFinite(speedMul) ? speedMul : 1),
        advect,
      );
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
        wind: { x: wind.x, y: wind.y },
        pool: pool.stats(),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Module state + the two providers.
// ---------------------------------------------------------------------------

let _rock = null;       // the init record, or null

const _stats = {
  inits: 0,
  pebbleBuilds: 0,
  gritBuilds: 0,
  noSkyState: 0,
};

/** The once-per-frame cached sky snapshot (plan §2.3 — NEVER `getSkyState()`).
 *  Null is a first-class answer: the material keeps its last light values and
 *  the pebbles still render. */
function _skyState() {
  if (!_rock) return null;
  try {
    if (typeof _rock.readSkyState === "function") return _rock.readSkyState() || null;
    const s = _rock.scene3d?.skyLightingController?._lastState;
    if (s) return s;
    if (typeof window !== "undefined") {
      return window.liveScene3d?.skyLightingController?._lastState || null;
    }
  } catch (_) { /* fail-soft */ }
  return null;
}

function _pebbleProvider() {
  return {
    id: PEBBLE_PROVIDER_ID,
    families: [FAM_ROCK],
    scope: "camera",
    enabled() { return terrainRockEnabled() && terrainRockPebblesEnabled(); },
    quality(flags) {
      const q = resolveRockQuality(flags);
      return q && q.pebbleCount > 0 ? q : null;
    },
    update(dt, frameCtx) {
      if (!_rock) return;
      if (!frameCtx || !frameCtx.hasPlayer) return;
      // `frameCtx.oracle` is a LIVE getter on the spine (wave-0 handoff §5) —
      // read it every frame, never stash it. The pool holds a GETTER for the
      // same reason, so a field built before the oracle resolved comes alive.
      if (!_rock.pebbles) {
        const q = resolveRockQuality(frameCtx.quality) || {
          pebbleCount: terrainRockPebbleCount(),
          radiusM: terrainRockRadiusM(),
        };
        const tier = q.pebbleCount > 0 ? q.pebbleCount : terrainRockPebbleCount();
        const count = Math.round(tier * _rock.density);
        if (count <= 0) return;
        _rock.pebbles = createPebbleField({
          THREE: _rock.THREE,
          parent: _rock.parent,
          globals: _rock.globals,
          oracle: () => (_rock ? _rock.oracleRef() : null),
          count,
          radiusM: q.radiusM || terrainRockRadiusM(),
          seed: _rock.seed,
        });
        _stats.pebbleBuilds += 1;
      }
      const sky = _skyState();
      if (!sky) _stats.noSkyState += 1;
      const p = frameCtx.playerPos;
      _rock.pebbles.update(dt, frameCtx.tSec, p.x, p.y, p.z, sky);
    },
    dispose() {
      if (_rock && _rock.pebbles) { _rock.pebbles.dispose(); _rock.pebbles = null; }
    },
  };
}

function _gritProvider() {
  return {
    id: GRIT_PROVIDER_ID,
    families: [FAM_ROCK],
    scope: "camera",
    enabled() { return terrainRockEnabled() && terrainRockGritEnabled(); },
    quality(flags) {
      const q = resolveRockQuality(flags);
      return q && q.gritCount > 0 ? q : null;
    },
    update(dt, frameCtx) {
      if (!_rock) return;
      if (!frameCtx || !frameCtx.hasPlayer) return;
      if (!_rock.grit) {
        const q = resolveRockQuality(frameCtx.quality) || {
          gritCount: terrainRockGritCount(),
          radiusM: terrainRockRadiusM(),
        };
        const tier = q.gritCount > 0 ? q.gritCount : terrainRockGritCount();
        const count = Math.round(tier * _rock.density);
        if (count <= 0) return;
        _rock.grit = createGritField({
          THREE: _rock.THREE,
          parent: _rock.parent,
          globals: _rock.globals,
          oracle: () => (_rock ? _rock.oracleRef() : null),
          count,
          radiusM: q.radiusM || terrainRockRadiusM(),
          seed: _rock.seed,
        });
        _stats.gritBuilds += 1;
      }
      const p = frameCtx.playerPos;
      _rock.grit.update(dt, frameCtx.tSec, p.x, p.y, p.z);
    },
    dispose() {
      if (_rock && _rock.grit) { _rock.grit.dispose(); _rock.grit = null; }
    },
  };
}

/**
 * Construct + register the ROCK family. Called once from `scene3d/index.js`
 * right after `initTerrainVfx` (the spine must exist first — the providers are
 * replayed onto the already-resident ring by `registerTerrainVfx`).
 *
 * Returns `null` (registering nothing, allocating nothing) when the family
 * master is off — a bare-default boot is byte-identical.
 *
 * @param {object} opts
 * @param {object} [opts.THREE]    the three namespace (injected).
 * @param {object} opts.scene3d    the live facade.
 * @param {object} [opts.parent]   Object3D for the two meshes; defaults to
 *   `terrainGroup.parent` (worldRoot) — a SIBLING of terrainGroup with the same
 *   transform, so the fields are in AC space and the LRU's terrainGroup scans
 *   cannot take them.
 * @param {object} [opts.globals]  VFX_GLOBALS (uTime, BY REFERENCE).
 * @param {Function} [opts.readSkyState] override for the sky snapshot read
 *   (defaults to `scene3d.skyLightingController._lastState`).
 * @param {Function} [opts.getOracle] override for the terrain oracle.
 */
export function initTerrainRock(opts = {}) {
  const scene3d = opts.scene3d || null;
  if (wireframeActive(opts.search)) return null;   // plan §8 risk 8
  if (!terrainRockEnabled()) return null;          // ship-OFF master (plan §5.9)

  const pebblesOn = terrainRockPebblesEnabled();
  const gritOn = terrainRockGritEnabled();
  if (!pebblesOn && !gritOn) return null;

  const density = terrainRockDensity();

  _rock = {
    THREE: opts.THREE || null,
    scene3d,
    parent: opts.parent || scene3d?.terrainGroup?.parent || null,
    globals: opts.globals || null,
    readSkyState: typeof opts.readSkyState === "function" ? opts.readSkyState : null,
    seed: Number.isFinite(opts.seed) ? opts.seed | 0 : 0x520c4bed,
    density: Number.isFinite(density) ? density : 1,
    pebbles: null,
    grit: null,
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

  // "I turned the flag on and nothing happened" is exactly the silence
  // `gfx_relief.js:137` argues against, and at `low` the tier ships
  // `terrainRockPebbleCount: 0`. Say so once; the fix is a one-line URL.
  if (pebblesOn) {
    if (Math.round(terrainRockPebbleCount() * _rock.density) > 0) {
      _rock.registered.push(registerTerrainVfx(_pebbleProvider()));
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        "[terrainRockPebbles] ?terrainRockPebbles=on but the resolved pebble count "
        + "is 0 (quality=low ships terrainRockPebbleCount: 0, and "
        + "?terrainRockDensity=0 also disables). Raise it with "
        + "?terrainRockPebbleCount=N or use ?quality=mid or higher.",
      );
    }
  }
  if (gritOn) {
    if (Math.round(terrainRockGritCount() * _rock.density) > 0) {
      _rock.registered.push(registerTerrainVfx(_gritProvider()));
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        "[terrainRockGrit] ?terrainRockGrit=on but the resolved grit count is 0 "
        + "(quality=low ships terrainRockGritCount: 0, and ?terrainRockDensity=0 "
        + "also disables). Raise it with ?terrainRockGritCount=N or use "
        + "?quality=mid or higher.",
      );
    }
  }
  return terrainRockSurface();
}

/** Diagnostics — mirrored onto `window.__terrainRock` by `scene3d/index.js`. */
export function terrainRockStats() {
  const on = terrainRockEnabled();
  return {
    enabled: on,
    pebbles: on && terrainRockPebblesEnabled(),
    grit: on && terrainRockGritEnabled(),
    inited: !!_rock,
    density: _rock ? _rock.density : terrainRockDensity(),
    rockCodes: rockTerrainCodes(),
    rockCodeMask: rockCodeBitmask(),
    olthoiCodes: olthoiTerrainCodes(),
    olthoiCodeMask: olthoiCodeBitmask(),
    // THE live-check fields (mirroring __terrainSand.field / __terrainSnow):
    // non-zero means instances actually landed on rock.
    visiblePebbles: _rock && _rock.pebbles ? _rock.pebbles.pool.stats().live : 0,
    visibleGrit: _rock && _rock.grit ? _rock.grit.pool.stats().live : 0,
    pebbleField: _rock && _rock.pebbles ? _rock.pebbles.stats() : null,
    gritField: _rock && _rock.grit ? _rock.grit.stats() : null,
    counters: { ..._stats },
  };
}

function terrainRockSurface() {
  return {
    stats: terrainRockStats,
    get pebbles() { return _rock ? _rock.pebbles : null; },
    get grit() { return _rock ? _rock.grit : null; },
    get uniforms() { return _rock && _rock.pebbles ? _rock.pebbles.uniforms : null; },
    lbKeyFromXY,
  };
}

/** Test seam — unregister both providers and drop all state. */
export function _resetTerrainRock() {
  if (_rock) {
    for (const h of _rock.registered) {
      try { unregisterTerrainVfx(h.id); } catch (_) {}
    }
    if (_rock.pebbles) { try { _rock.pebbles.dispose(); } catch (_) {} }
    if (_rock.grit) { try { _rock.grit.dispose(); } catch (_) {} }
  }
  _rock = null;
  for (const k of Object.keys(_stats)) _stats[k] = 0;
}
