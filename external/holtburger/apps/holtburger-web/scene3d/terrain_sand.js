// scene3d/terrain_sand.js — SAND / DESERT terrain VFX (Wave 1B).
//
// Design plan: `docs/2026-07-31-terrain-vfx-plan.md` §3.2. Terrain codes 10
// (`sand-yellow`), 11 (`sand-grey`) and 12 (`sand-rockStrewn`) = `FAM_SAND` —
// derived from `terrain_families.js`, never hardcoded here (plan §8 risk 12:
// family membership is a property of the CODE, and another region could name
// the same code differently).
//
// THE LOOK (plan §3.2): the surface is MOVING. Low sheets of wind-driven sand
// stream across the ground; the occasional dust devil turns; grains catch the
// sun as a fine grazing-angle sparkle.
//
// THREE EFFECTS, THREE OWNERS:
//   1. STREAMERS  — here. A camera-scoped instanced quad field built on
//      `terrain_scatter.js` (the shared pool: placement, residency, family
//      gating, amortisation). Additively blended, lying nearly flat, advected
//      along the shared wind vector, opacity pulsing on a noise field so sheets
//      form and dissolve. Fill-bound ⇒ it DOES get cheaper at 25% render scale.
//   2. DUST DEVILS — here (lifecycle) + `vfx/components/terrainDustDevil.js`
//      (the registered, lint-passing descriptor). Landblock-scoped, hash-stable,
//      synthesized through the EXISTING particle system and owned through the
//      owner registry.
//   3. GRAIN SPARKLE — in the TERRAIN FRAGMENT SHADER (`terrain.js`, search
//      `SAND SPARKLE`), gated on FAM_SAND read from `uVertexTypes` (plan trap
//      T3 — the subdiv path IGNORES the `terrainCode` geometry attribute), sited
//      after the POM `cellUv` offset and bypassed on any water-touching cell
//      (plan §2.7.3). NOT in this file; this file only owns its flag.
//   (HEAT SHIMMER is wave 2B's shared `terrainHaze` Effect — deliberately not
//   implemented and not reserved here.)
//
// INJECTED THREE (the `terrain_vfx.js` / `trail_map.js` / `terrain_scatter.js`
// idiom). This module imports no three: `initTerrainSand({THREE, scene3d, ...})`
// takes it, and every GPU object is optional — with no THREE the providers still
// run their full CPU bookkeeping. That is what keeps `test_terrain_sand.mjs` a
// pure-node test and what makes `?nullRender=1` free.
//
// INVARIANTS (plan §5). A HOST module, not a registered VFX component: it is not
// swept by `vfx/lint_caps.js` (the DESCRIPTOR next door is). It obeys the
// firewall anyway — it reads static terrain, a server-derived player position,
// the shared clock and the shared wind, and writes only its own buffers,
// uniforms and synthesized emitters. It adds no light (§5.2), varies no program
// cache key (§5.4 — one material, no per-instance key), uses no `Math.random`
// (§5.5), binds the clock BY REFERENCE (§5.6) and sets `castShadow = false`
// (§5.7 — added geometry is paid twice).
//
// FLAGS (plan §2.4, all STRICT `=== "on"` opt-ins that ship OFF):
//   ?terrainSand           family master  (also `?terrainVfx=off`, `?visual=off`
//                                          and `?wireframe=1` kill everything)
//   ?terrainSandStreamers  ?terrainSandDevils  ?terrainSandSparkle
//   ?terrainSandStreamerCount  ?terrainSandDevilCount  ?terrainSandRadius

import {
  FAM_SAND,
  TERRAIN_CODE_COUNT,
  familyForCode,
} from "./terrain_families.js";
import { createScatterPool, SCATTER_FADE_GLSL, scatterHash01 } from "./terrain_scatter.js";
import { registerTerrainVfx, unregisterTerrainVfx, lbKeyFromXY } from "./terrain_vfx.js";
import {
  terrainSandEnabled,
  terrainSandStreamersEnabled,
  terrainSandDevilsEnabled,
  terrainSandSparkleEnabled,
  terrainSandStreamerCount,
  terrainSandDevilCount,
  terrainSandRadiusM,
} from "./vfx_flags.js";
import { staticOwnerKeyForLb } from "./vfx/particle_attach.js";
import { ownerRegistry as defaultOwnerRegistry } from "./particles/owner_registry.js";
import { terrainDustDevil } from "./vfx/components/terrainDustDevil.js";

export const METERS_PER_LANDBLOCK = 192;
export const VERTEX_GRID = 9;
export const VERTEX_SPACING_M = 24;

/** Provider ids — also the `VFX_EFFECT_FLAGS` router rows. */
export const STREAMER_PROVIDER_ID = "terrain.sandStreamers";
export const DEVIL_PROVIDER_ID = "terrain.sandDevils";

// ---------------------------------------------------------------------------
// Pure helpers — no THREE, no window. The directly-tested surface.
// ---------------------------------------------------------------------------

/** The terrain codes that are FAM_SAND, DERIVED from the family LUT. */
export function sandTerrainCodes() {
  const out = [];
  for (let c = 0; c < TERRAIN_CODE_COUNT; c += 1) {
    if (familyForCode(c) === FAM_SAND) out.push(c);
  }
  return out;
}

/** The same set as a GPU bitmask (the `computeCodeBitmask` convention). */
export function sandCodeBitmask() {
  let mask = 0;
  for (const c of sandTerrainCodes()) mask |= (1 << c);
  return mask >>> 0;
}

/** Tuning that is NOT worth a URL flag. */
export const SAND_TUNING = Object.freeze({
  // Streamer geometry, metres. A streak is long and thin and lies nearly flat.
  streakLengthM: 2.6,
  streakWidthM: 0.22,
  streakLengthJitter: 0.7,      // ±70% per instance
  // Lift above the ground (plan §3.2: "z = height + 0.05..0.4").
  liftMinM: 0.05,
  liftMaxM: 0.4,
  // Advection: metres/second per unit of wind magnitude, and the distance a
  // streak travels before it recycles (must exceed the streak length by a lot
  // or the recycle reads as a blink).
  advectSpeed: 3.2,
  advectSpanM: 26,
  // The pulse field: sheets form and dissolve rather than blowing uniformly.
  pulseFreq: 0.055,             // cycles per metre (≈18 m sheets)
  pulseScrollHz: 0.06,
  pulseThreshold: 0.42,
  // Colour is deliberately warm-neutral and DIM: this is an additive pass over
  // the whole near field, so its cost and its blow-out risk are both fill-bound.
  colour: [0.86, 0.76, 0.58],
  opacity: 0.16,
  // Devils.
  devilColumnRadiusM: 1.7,
  devilJitterM: 9,              // in-cell placement jitter (cell is 24 m)
});

/**
 * Resolve the live SAND quality tier. `null` ⇒ the whole family is disabled at
 * this tier (plan §5.8: "`low` is null/disabled for every effect here without
 * exception"). Pure in `flags`.
 *
 * @param {object|null} flags `liveScene3d.quality.flags`-shaped bag.
 * @returns {{streamerCount:number, devilCount:number, sparkle:boolean,
 *   radiusM:number}|null}
 */
export function resolveSandQuality(flags) {
  const num = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);
  const streamerCount = Math.max(0, Math.round(num(flags?.terrainSandStreamerCount, 0)));
  const devilCount = Math.max(0, Math.round(num(flags?.terrainSandDevilCount, 0)));
  const sparkle = flags?.terrainSandSparkle === true;
  const radiusM = Math.min(512, Math.max(8, num(flags?.terrainSandRadius, 64)));
  if (streamerCount === 0 && devilCount === 0 && !sparkle) return null;
  return { streamerCount, devilCount, sparkle, radiusM };
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
 * Streamer advection — the offset (metres, AC frame) of one streak from its
 * scattered anchor at time `tSec`.
 *
 * THE CONTRACT (plan §3.2 tests): a PURE function of (wind, clock, hash). No
 * player state, no frame history, no `Math.random`. The GLSL in
 * `SAND_STREAMER_VERTEX_GLSL` computes exactly this expression, so the JS is
 * both the test oracle and the readable spec.
 *
 * The streak slides along the wind and RECYCLES every `spanM` metres, phased by
 * its own hash so the field never pulses in lockstep. Wind MAGNITUDE scales the
 * speed (gusts blow harder), wind DIRECTION steers.
 *
 * @param {number} windX AC east component
 * @param {number} windY AC north component
 * @param {number} tSec  the shared clock (`scene3d.frameTime.tsSec`)
 * @param {number} phase01 per-instance hash, [0,1)
 * @param {number} spanM recycle distance
 * @param {number} speed metres/second per unit wind magnitude
 * @param {{x:number,y:number,s:number}} [out]
 */
export function streamerAdvect(windX, windY, tSec, phase01, spanM, speed, out) {
  const o = out || { x: 0, y: 0, s: 0 };
  const span = Number.isFinite(spanM) && spanM > 0 ? spanM : SAND_TUNING.advectSpanM;
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
 * Hash-stable dust-devil placements for one landblock.
 *
 * PURE and deterministic in `(lbKey, codes, heights, count, seed)` — the whole
 * point (plan §5.5): park/unpark, rebake, walk away and come back, and the same
 * devil stands in the same place. Devils are placed ONLY on FAM_SAND vertices,
 * so a landblock with one sand corner gets its devil on the sand.
 *
 * `codes` and `heights` are the LB's 81-entry COLUMN-MAJOR grids
 * (`idx = vx * 9 + vy`, `terrain.js` userData / `LandblockMesh`).
 *
 * @param {{lbKey:number, lbX:number, lbY:number, codes:ArrayLike<number>,
 *   heights?:ArrayLike<number>|null, count:number, seed?:number}} opts
 * @returns {Array<{slot:number, x:number, y:number, z:number, vx:number,
 *   vy:number, code:number, seed:number}>}
 */
export function devilSlotsForLandblock(opts = {}) {
  const codes = opts.codes;
  const count = Math.max(0, Math.min(8, opts.count | 0));
  if (!codes || count === 0) return [];
  const lbKey = opts.lbKey >>> 0;
  const lbX = opts.lbX | 0;
  const lbY = opts.lbY | 0;
  const heights = opts.heights || null;
  const seed = (Number.isFinite(opts.seed) ? opts.seed : 0x5a4d1e55) | 0;

  // Every FAM_SAND vertex, in grid order (deterministic).
  const sandIdx = [];
  const n = Math.min(codes.length, VERTEX_GRID * VERTEX_GRID);
  for (let i = 0; i < n; i += 1) {
    if (familyForCode(codes[i]) === FAM_SAND) sandIdx.push(i);
  }
  if (sandIdx.length === 0) return [];

  const out = [];
  const used = new Set();
  for (let slot = 0; slot < count; slot += 1) {
    // `scatterHash01(a, b, c, seed)` is the shared FNV-1a + fmix32 avalanche.
    const pick = scatterHash01(lbKey | 0, slot, 1, seed);
    let k = Math.min(sandIdx.length - 1, Math.floor(pick * sandIdx.length));
    // Distinct vertices per LB: walk forward on a collision (still pure).
    let guard = 0;
    while (used.has(sandIdx[k]) && guard < sandIdx.length) {
      k = (k + 1) % sandIdx.length;
      guard += 1;
    }
    if (used.has(sandIdx[k])) break;   // fewer sand vertices than devils
    used.add(sandIdx[k]);
    const idx = sandIdx[k];
    const vx = (idx / VERTEX_GRID) | 0;
    const vy = idx % VERTEX_GRID;
    const jx = (scatterHash01(lbKey | 0, slot, 2, seed) - 0.5) * SAND_TUNING.devilJitterM;
    const jy = (scatterHash01(lbKey | 0, slot, 3, seed) - 0.5) * SAND_TUNING.devilJitterM;
    // Clamp inside the landblock so a devil on an edge vertex cannot drift into
    // a neighbour we know nothing about.
    const localX = Math.min(METERS_PER_LANDBLOCK, Math.max(0, vx * VERTEX_SPACING_M + jx));
    const localY = Math.min(METERS_PER_LANDBLOCK, Math.max(0, vy * VERTEX_SPACING_M + jy));
    const z = heights && Number.isFinite(heights[idx]) ? heights[idx] : 0;
    out.push({
      slot,
      vx,
      vy,
      code: codes[idx] | 0,
      x: lbX * METERS_PER_LANDBLOCK + localX,
      y: lbY * METERS_PER_LANDBLOCK + localY,
      z,
      // Per-devil deterministic seed for the emitter's own variety.
      seed: ((lbKey ^ Math.imul(slot + 1, 0x9e3779b9)) >>> 0),
    });
  }
  return out;
}

/**
 * The owner key a landblock's devils register under.
 *
 * DERIVED from `vfx/particle_attach.js::staticOwnerKeyForLb` (the single source
 * of truth for the per-LB owner key — D7) with a `:sand` scope appended.
 *
 * ⚠ WHY THE SUFFIX, given the plan says to reuse the static key verbatim. The
 * teardown API is `destroyAllForOwner(ownerKey)`, and this provider's
 * `onLandblockGone` fires for a terrain LOD REBAKE as well as for an evict
 * (`terrain_vfx.js` deliberately delivers a rebake as gone-then-ready). A
 * rebake does NOT rebuild statics — so calling `destroyAllForOwner("static:N")`
 * there would silently reap every brazier/foliage emitter in the landblock and
 * never bring them back. The suffix keeps the derivation (change the static
 * scheme and this changes with it) while making the teardown exact.
 *
 * @param {number} landblockIdOrLbKey
 */
export function sandOwnerKeyForLb(landblockIdOrLbKey) {
  return `${staticOwnerKeyForLb(landblockIdOrLbKey)}:sand`;
}

/** The scoped emitter handle for devil `slot` under its owner (never 0, so
 *  `ownerRegistry.stopEmitter` can find it at park time). */
export function devilEmitterHandle(slot) {
  return (0x5a4d0000 + ((slot | 0) & 0xff)) >>> 0;
}

// ---------------------------------------------------------------------------
// The streamer field — GLSL. Kept as exported strings so the shader test can
// assert on them without a GPU (the `terrain.js` convention).
//
// ⚠ NO BACKTICKS anywhere in this GLSL, including comments: a stray backtick
// closes the JS template literal (this has bitten `terrain.js`).
// ---------------------------------------------------------------------------

export const SAND_STREAMER_VERTEX_GLSL = `
precision highp float;

// Per-instance (written by terrain_scatter.js; see the schema below).
attribute vec3 aOffset;    // AC world position of the anchor (x, y, z=ground+lift)
attribute vec2 aScale;     // (length, width) in metres
attribute vec4 aStreak;    // (phase01, speedMul, tint, opacity)

uniform float uTime;       // the SHARED clock, bound by reference (plan §5.6)
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
float sandHash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float sandNoise2D(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = sandHash21(i);
  float b = sandHash21(i + vec2(1.0, 0.0));
  float c = sandHash21(i + vec2(0.0, 1.0));
  float d = sandHash21(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

void main() {
  // --- advection: the JS twin is terrain_sand.js::streamerAdvect ------------
  float wl = max(length(uWindAc), 1e-4);
  vec2 dir = uWindAc / wl;
  vec2 side = vec2(-dir.y, dir.x);
  float travelled = uTime * uSpeed * aStreak.y * wl + aStreak.x * uSpanM;
  float s = mod(travelled, uSpanM) - uSpanM * 0.5;
  vec2 adv = dir * s;

  // --- the quad, laid FLAT and stretched along the wind ---------------------
  // position is a unit quad in the XY plane; x runs along the streak.
  vec2 local2 = adv + dir * (position.x * aScale.x) + side * (position.y * aScale.y);
  vec3 local = vec3(local2, 0.0);

  // instanceMatrix carries the anchor translation AND the pool's 0/1 live
  // scale, so a degenerate (wrong-family / unbaked / out-of-range) instance
  // collapses to a point and is zero-area for this material too.
  vec4 placed = instanceMatrix * vec4(local, 1.0);

  // --- the pulse field: sheets form and dissolve ---------------------------
  vec2 pulseXy = placed.xy * uPulseFreq + dir * (uTime * uPulseScroll);
  float n = sandNoise2D(pulseXy);
  float pulse = smoothstep(uPulseThreshold, 1.0, n);

  // Distance blend, identical in form to the CPU fadeFor() (LINEAR).
  float fade = hbScatterFade(placed.xy);

  vAlpha = pulse * fade * aStreak.w;
  vQuadUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(placed.xyz, 1.0);
}
`;

export const SAND_STREAMER_FRAGMENT_GLSL = `
precision highp float;

uniform vec3 uColour;
uniform float uOpacity;

varying vec2 vQuadUv;
varying float vAlpha;

void main() {
  // Soft streak: a long, smooth falloff along the streak and a tight one
  // across it. Additive, so the alpha channel is cosmetic.
  vec2 c = abs(vQuadUv * 2.0 - 1.0);
  float along = 1.0 - c.x;
  float across = 1.0 - c.y;
  float mask = pow(max(along, 0.0), 1.4) * pow(max(across, 0.0), 2.0);
  float a = mask * vAlpha * uOpacity;
  if (a <= 0.0) discard;
  gl_FragColor = vec4(uColour * a, a);
}
`;

/** The per-instance attribute schema the pool allocates for a streamer field. */
export const SAND_STREAMER_SCHEMA = Object.freeze([
  { name: "aOffset", itemSize: 3 },
  { name: "aScale", itemSize: 2 },
  { name: "aStreak", itemSize: 4 },
]);

// ---------------------------------------------------------------------------
// The streamer field (THREE optional).
// ---------------------------------------------------------------------------

function _streakGeometry(THREE) {
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
  geom.name = "sand-streak";
  return geom;
}

/**
 * Create the camera-scoped sand-streamer field.
 *
 * @param {object} opts
 * @param {object} [opts.THREE]    injected; omit for a headless CPU-only field.
 * @param {object} [opts.parent]   Object3D to hang the mesh off (AC space).
 * @param {object|Function} opts.oracle  the terrain oracle, or a GETTER (use the
 *   getter form: `ctx.oracle` / `frameCtx.oracle` is LIVE and must never be
 *   stashed — handoff §5).
 * @param {object} [opts.globals]  VFX_GLOBALS (uTime + uWindDir, BY REFERENCE).
 * @param {number} [opts.count]    instances (rounded up to a square).
 * @param {number} [opts.radiusM]
 * @param {number} [opts.seed]
 */
export function createSandStreamerField(opts = {}) {
  const THREE = opts.THREE || null;
  const count = Math.max(1, Math.round(Number.isFinite(opts.count) ? opts.count : 2000));
  const radiusM = Math.min(512, Math.max(8, Number.isFinite(opts.radiusM) ? opts.radiusM : 64));
  const seed = (Number.isFinite(opts.seed) ? opts.seed : 0x5a4d5052) | 0;
  const globals = opts.globals || null;
  const tuning = { ...SAND_TUNING, ...(opts.tuning || {}) };

  let geometry = null;
  let material = null;
  const uniforms = {
    uTime: { value: 0 },
    uWindAc: { value: null },
    uSpanM: { value: tuning.advectSpanM },
    uSpeed: { value: tuning.advectSpeed },
    uPulseFreq: { value: tuning.pulseFreq },
    uPulseScroll: { value: tuning.pulseScrollHz },
    uPulseThreshold: { value: tuning.pulseThreshold },
    uColour: { value: null },
    uOpacity: { value: tuning.opacity },
  };

  const wind = { x: 0, y: 0 };
  const advect = { x: 0, y: 0, s: 0 };

  // Build the geometry + material BEFORE the pool so the pool can own the mesh
  // (that is what writes `instanceMatrix`, which this shader reads for both the
  // anchor translation and the degenerate 0-scale kill). The four scatter
  // uniforms are re-pointed at the pool's own objects immediately after
  // construction — the pool cannot exist yet to be bound here, and a
  // ShaderMaterial reads `material.uniforms` afresh on every upload, so
  // swapping the entries before the first render is exact (plan §5.6: the
  // shader must see the pool's LIVE centre, never a copy).
  if (THREE && typeof THREE.ShaderMaterial === "function") {
    try {
      geometry = _streakGeometry(THREE);
      uniforms.uWindAc.value = new THREE.Vector2(1, 0);
      uniforms.uColour.value = new THREE.Color(
        tuning.colour[0], tuning.colour[1], tuning.colour[2],
      );
      material = new THREE.ShaderMaterial({
        vertexShader: SAND_STREAMER_VERTEX_GLSL,
        fragmentShader: SAND_STREAMER_FRAGMENT_GLSL,
        uniforms: {
          ...uniforms,
          // Placeholders, replaced by reference below.
          uScatterCenter: { value: new THREE.Vector3(0, 0, 0) },
          uScatterRadius: { value: radiusM },
          uScatterFadeStart: { value: radiusM * 0.75 },
          uScatterShape: { value: 0 },
        },
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      material.name = "terrain-sand-streamers";
    } catch (_) {
      geometry = null;
      material = null;
    }
  }

  const pool = createScatterPool({
    THREE,
    name: "terrain-sand-streamers",
    count,
    radiusM,
    seed,
    shape: "disc",
    fadeFraction: 0.25,
    jitter: 1,
    families: [FAM_SAND],
    attributes: SAND_STREAMER_SCHEMA.map((a) => ({ ...a })),
    // The pool writes aOffset + aScale (1s) + the instance matrix; `fill` turns
    // those into a streak. It never allocates — `ctx` is reused per instance.
    fill(ctx) {
      // Lift: 0.05..0.4 m above the ground (plan §3.2). Hash-stable per cell.
      const lift = tuning.liftMinM + ctx.rand(3) * (tuning.liftMaxM - tuning.liftMinM);
      ctx.z += lift;
      const lenJ = 1 + (ctx.rand(4) - 0.5) * 2 * tuning.streakLengthJitter;
      ctx.set("aScale", tuning.streakLengthM * lenJ, tuning.streakWidthM);
      ctx.set(
        "aStreak",
        ctx.rand(5),                      // advection phase
        0.75 + ctx.rand(6) * 0.6,         // per-streak speed multiplier
        ctx.rand(7),                      // spare tint channel (unused by v1)
        (0.55 + ctx.rand(8) * 0.45) * ctx.fade,
      );
    },
    oracle: opts.oracle,
    geometry,
    material,
    parent: opts.parent || null,
    writeInstanceMatrix: true,   // the shader reads instanceMatrix (see the GLSL)
    frustumCulled: false,        // the window follows the player
  });

  // Re-point the four scatter uniforms at the pool's live objects (see above).
  if (material && material.uniforms) {
    material.uniforms.uScatterCenter = pool.uniforms.uScatterCenter;
    material.uniforms.uScatterRadius = pool.uniforms.uScatterRadius;
    material.uniforms.uScatterFadeStart = pool.uniforms.uScatterFadeStart;
    material.uniforms.uScatterShape = pool.uniforms.uScatterShape;
  }

  let mesh = pool.mesh || null;
  if (mesh) {
    mesh.name = "terrain-sand-streamers";
    mesh.castShadow = false;      // §5.7 — added geometry is paid twice
    mesh.receiveShadow = false;
    mesh.renderOrder = 3;
  }

  const state = { frames: 0, lastRescattered: 0, built: !!mesh };

  return {
    pool,
    uniforms,
    get mesh() { return mesh; },
    get material() { return material; },
    get geometry() { return geometry; },
    /** Per-frame: re-centre the pool and refresh the two live uniforms. */
    update(dt, tSec, px, py, pz) {
      state.frames += 1;
      windAcFromGlobals(globals, wind);
      uniforms.uTime.value = Number.isFinite(tSec) ? tSec : 0;
      const wv = uniforms.uWindAc.value;
      if (wv) { wv.x = wind.x; wv.y = wind.y; }
      state.lastRescattered = pool.update(dt, px, py, pz);
      return state.lastRescattered;
    },
    /** The CPU twin of the shader's advection, for diagnostics and tests. */
    advectionOf(phase01, tSec, speedMul) {
      windAcFromGlobals(globals, wind);
      return streamerAdvect(
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
        wind: { x: wind.x, y: wind.y },
        pool: pool.stats(),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Module state + the two providers.
// ---------------------------------------------------------------------------

let _sand = null;       // the init record, or null

const _stats = {
  inits: 0,
  streamerBuilds: 0,
  devilLandblocks: 0,
  devilsRequested: 0,
  devilsCreated: 0,
  devilCreateFailures: 0,
  parks: 0,
  unparks: 0,
  gones: 0,
  destroyAllCalls: 0,
  noManager: 0,
};

/** Landblock-scoped devil bookkeeping: lbKey → {ownerKey, slots, ids, parked}. */
const _devilLbs = new Map();

function _managerFor() {
  if (!_sand) return null;
  try {
    const m = _sand.getParticleManager ? _sand.getParticleManager() : null;
    return m && typeof m.addEmitter === "function" ? m : null;
  } catch (_) { return null; }
}

function _envSnapshot() {
  if (!_sand || typeof _sand.readEnv !== "function") return null;
  try { return _sand.readEnv(_sand.scene3d) || null; } catch (_) { return null; }
}

/** Build the emitter parent frame for one devil. AC world coordinates, exactly
 *  like `statics.js::_buildStaticParticleParent` (the static ParticleManager's
 *  scene is `staticsGroup`, which carries the same transform). */
function _devilParent(THREE, slot) {
  if (!THREE || typeof THREE.Vector3 !== "function") {
    return {
      position: { x: slot.x, y: slot.y, z: slot.z },
      quaternion: { x: 0, y: 0, z: 0, w: 1 },
    };
  }
  return {
    position: new THREE.Vector3(slot.x, slot.y, slot.z),
    quaternion: new THREE.Quaternion(),
  };
}

/**
 * Create (or replace) the emitters for one landblock's devils. Fire-and-forget:
 * `addEmitter` is async and the owner registry is EPOCH-GUARDED, so a create
 * that resolves after the landblock was evicted self-destroys.
 */
function _spawnDevils(rec) {
  const manager = _managerFor();
  if (!manager) { _stats.noManager += 1; return; }
  const env = _envSnapshot();
  const reg = _sand.ownerRegistry;
  for (const slot of rec.slots) {
    _stats.devilsRequested += 1;
    let specs = [];
    try {
      specs = terrainDustDevil.emit({
        anchor: {
          partIndex: -1,
          // The emitter is parented AT the devil, so the anchor centre is the
          // origin of that frame and the radius is the column radius.
          center: { x: 0, y: 0, z: 0 },
          radius: SAND_TUNING.devilColumnRadiusM,
        },
        env,
        seed: slot.seed,
        clock: _sand.scene3d?.frameTime?.tsSec || 0,
        config: null,
      }) || [];
    } catch (_) { specs = []; }
    if (!Array.isArray(specs) || specs.length === 0) continue;   // gated out
    const spec = specs[0];
    const info = spec.emitterInfo;
    if (!info || (info.hwGfxObjId >>> 0) === 0) continue;
    if (info.billboard === undefined) info.billboard = true;
    const req = {
      emitterInfo: info,
      parent: _devilParent(_sand.THREE, slot),
      partIndex: -1,
      parentOffset: spec.parentOffset || null,
      emitterId: devilEmitterHandle(slot.slot),
      blocking: false,
    };
    Promise.resolve()
      .then(() => reg.addEmitter(rec.ownerKey, manager, req))
      .then((id) => {
        if ((id >>> 0) !== 0) {
          rec.ids.push(id >>> 0);
          _stats.devilsCreated += 1;
        } else {
          _stats.devilCreateFailures += 1;
        }
      })
      .catch(() => { _stats.devilCreateFailures += 1; });
  }
}

function _streamerProvider() {
  return {
    id: STREAMER_PROVIDER_ID,
    families: [FAM_SAND],
    scope: "camera",
    enabled() { return terrainSandEnabled() && terrainSandStreamersEnabled(); },
    quality(flags) {
      const q = resolveSandQuality(flags);
      return q && q.streamerCount > 0 ? q : null;
    },
    update(dt, frameCtx) {
      if (!_sand) return;
      if (!frameCtx || !frameCtx.hasPlayer) return;
      // `frameCtx.oracle` is a LIVE getter on the spine (handoff §5) — read it
      // every frame, never stash it. The pool holds a GETTER for the same
      // reason, so a field built before the oracle resolved still comes alive.
      if (!_sand.field) {
        const q = resolveSandQuality(frameCtx.quality) || {
          streamerCount: terrainSandStreamerCount(),
          radiusM: terrainSandRadiusM(),
        };
        const count = q.streamerCount > 0 ? q.streamerCount : terrainSandStreamerCount();
        if (count <= 0) return;
        _sand.field = createSandStreamerField({
          THREE: _sand.THREE,
          parent: _sand.parent,
          globals: _sand.globals,
          oracle: () => (_sand ? _sand.oracleRef() : null),
          count,
          radiusM: q.radiusM || terrainSandRadiusM(),
          seed: _sand.seed,
        });
        _stats.streamerBuilds += 1;
      }
      const p = frameCtx.playerPos;
      _sand.field.update(dt, frameCtx.tSec, p.x, p.y, p.z);
    },
    dispose() {
      if (_sand && _sand.field) { _sand.field.dispose(); _sand.field = null; }
    },
  };
}

function _devilProvider() {
  return {
    id: DEVIL_PROVIDER_ID,
    families: [FAM_SAND],
    scope: "landblock",
    enabled() { return terrainSandEnabled() && terrainSandDevilsEnabled(); },
    quality(flags) {
      const q = resolveSandQuality(flags);
      return q && q.devilCount > 0 ? q : null;
    },
    onLandblockReady(ctx) {
      if (!_sand) return;
      const count = ctx?.quality?.devilCount > 0 ? ctx.quality.devilCount : terrainSandDevilCount();
      if (count <= 0) return;
      const slots = devilSlotsForLandblock({
        lbKey: ctx.lbKey,
        lbX: ctx.lbX,
        lbY: ctx.lbY,
        codes: ctx.codes,
        heights: ctx.heights,
        count,
        seed: _sand.seed,
      });
      if (slots.length === 0) return;
      // Refine z through the oracle when it is up (exact split-diagonal height
      // at the jittered point rather than the nearest vertex). Deterministic:
      // the oracle is a pure function of static terrain.
      const oracle = _sand.oracleRef();
      if (oracle && typeof oracle.heightAt === "function") {
        for (const s of slots) {
          const h = oracle.heightAt(s.x, s.y);
          if (Number.isFinite(h)) s.z = h;
        }
      }
      const rec = {
        ownerKey: sandOwnerKeyForLb(ctx.lbKey),
        slots,
        ids: [],
        parked: false,
      };
      _devilLbs.set(ctx.lbKey >>> 0, rec);
      _stats.devilLandblocks += 1;
      _spawnDevils(rec);
    },
    onLandblockPark(lbKey) {
      const rec = _devilLbs.get(lbKey >>> 0);
      if (!rec || rec.parked) return;
      rec.parked = true;
      _stats.parks += 1;
      // PARK STOPS EMISSION — it never destroys (plan §2.2.2 / §5.3), so
      // `emitterCountForOwner` is unchanged and unpark is free.
      for (const slot of rec.slots) {
        try { _sand.ownerRegistry.stopEmitter(rec.ownerKey, devilEmitterHandle(slot.slot)); } catch (_) {}
      }
    },
    onLandblockUnpark(lbKey) {
      const rec = _devilLbs.get(lbKey >>> 0);
      if (!rec || !rec.parked) return;
      rec.parked = false;
      _stats.unparks += 1;
      // Re-arm emission. Placement is hash-stable (§5.5), so the devil comes
      // back exactly where it was — this is NOT a re-scatter.
      _spawnDevils(rec);
    },
    onLandblockGone(lbKey) {
      const rec = _devilLbs.get(lbKey >>> 0);
      if (!rec) return;
      _devilLbs.delete(lbKey >>> 0);
      _stats.gones += 1;
      _stats.destroyAllCalls += 1;
      try { _sand.ownerRegistry.destroyAllForOwner(rec.ownerKey); } catch (_) {}
    },
    dispose() {
      for (const [, rec] of _devilLbs) {
        try { _sand?.ownerRegistry.destroyAllForOwner(rec.ownerKey); } catch (_) {}
      }
      _devilLbs.clear();
    },
  };
}

/**
 * Construct + register the SAND family. Called once from `scene3d/index.js`
 * right after `initTerrainVfx` (the spine must exist first — the providers are
 * replayed onto the already-resident ring by `registerTerrainVfx`).
 *
 * Returns `null` (registering nothing, allocating nothing) when the family
 * master is off — a bare-default boot is byte-identical.
 *
 * @param {object} opts
 * @param {object} [opts.THREE]    the three namespace (injected).
 * @param {object} opts.scene3d    the live facade.
 * @param {object} [opts.parent]   Object3D for the streamer mesh; defaults to
 *   `terrainGroup.parent` (worldRoot) — a SIBLING of terrainGroup with the same
 *   transform, so the field is in AC space and the LRU's terrainGroup scans
 *   cannot take it.
 * @param {object} [opts.globals]  VFX_GLOBALS (uTime/uWindDir, BY REFERENCE).
 * @param {Function} [opts.readEnv] `vfx/particle_env.js::readParticleEnv`
 *   (injected so this module stays THREE-free).
 * @param {Function} [opts.getParticleManager] defaults to the shared static
 *   ParticleManager (`scene3d._staticParticleManager`), whose scene is
 *   `staticsGroup` — the same AC frame the devil positions are in.
 * @param {object} [opts.ownerRegistry] the shared singleton by default.
 * @param {Function} [opts.getOracle] override for the terrain oracle.
 */
export function initTerrainSand(opts = {}) {
  const scene3d = opts.scene3d || null;
  if (!terrainSandEnabled()) return null;          // ship-OFF master (plan §5.9)

  const streamersOn = terrainSandStreamersEnabled();
  const devilsOn = terrainSandDevilsEnabled();
  if (!streamersOn && !devilsOn) return null;      // sparkle is terrain.js's

  _sand = {
    THREE: opts.THREE || null,
    scene3d,
    parent: opts.parent || scene3d?.terrainGroup?.parent || null,
    globals: opts.globals || null,
    readEnv: typeof opts.readEnv === "function" ? opts.readEnv : null,
    getParticleManager: typeof opts.getParticleManager === "function"
      ? opts.getParticleManager
      : () => scene3d?._staticParticleManager || null,
    ownerRegistry: opts.ownerRegistry || defaultOwnerRegistry,
    seed: Number.isFinite(opts.seed) ? opts.seed | 0 : 0x5a4d1e55,
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

  if (streamersOn) _sand.registered.push(registerTerrainVfx(_streamerProvider()));
  if (devilsOn) _sand.registered.push(registerTerrainVfx(_devilProvider()));
  return terrainSandSurface();
}

/** Diagnostics — mirrored onto `window.__terrainSand` by `scene3d/index.js`. */
export function terrainSandStats() {
  return {
    enabled: terrainSandEnabled(),
    streamers: terrainSandEnabled() && terrainSandStreamersEnabled(),
    devils: terrainSandEnabled() && terrainSandDevilsEnabled(),
    sparkle: terrainSandEnabled() && terrainSandSparkleEnabled(),
    inited: !!_sand,
    sandCodes: sandTerrainCodes(),
    sandCodeMask: sandCodeBitmask(),
    devilLandblocks: _devilLbs.size,
    devilOwners: [..._devilLbs.values()].map((r) => ({
      ownerKey: r.ownerKey,
      slots: r.slots.length,
      ids: r.ids.length,
      parked: r.parked,
      live: (() => {
        try { return _sand ? _sand.ownerRegistry.emitterCountForOwner(r.ownerKey) : 0; }
        catch (_) { return 0; }
      })(),
    })),
    field: _sand && _sand.field ? _sand.field.stats() : null,
    counters: { ..._stats },
  };
}

function terrainSandSurface() {
  return {
    stats: terrainSandStats,
    get field() { return _sand ? _sand.field : null; },
    get devils() { return [..._devilLbs.keys()]; },
    lbKeyFromXY,
  };
}

/** Test seam — unregister both providers and drop all state. */
export function _resetTerrainSand() {
  if (_sand) {
    for (const h of _sand.registered) {
      try { unregisterTerrainVfx(h.id); } catch (_) {}
    }
    if (_sand.field) { try { _sand.field.dispose(); } catch (_) {} }
  }
  _devilLbs.clear();
  _sand = null;
  for (const k of Object.keys(_stats)) _stats[k] = 0;
}
