// scene3d/terrain_grass.js — §3.1 GRASS, the flagship terrain-VFX family
// (Wave 1A; plan `docs/2026-07-31-terrain-vfx-plan.md` §3.1).
//
// THE LOOK. Real blades protruding from the ground, dense near the player,
// thinning into the existing detail texture at range; bending as one under the
// same wind that moves the trees; crushed flat where the player walks and
// springing back over a few seconds. Six terrain codes, five sub-variants:
// LushGrass (3) tall + saturated, Grassland (1) medium, PatchyGrassland (9)
// sparse with bare gaps, forestfloor (21) short with a leaf-litter tint, and
// Moss/DarkMoss (28/29) very short and near-mat.
//
// WHAT THIS MODULE OWNS: the LOOK (blade geometry, the per-instance attribute
// schema, the material and its vertex/fragment injection) and the GATING (the
// four `?flag` readers, the quality tier, the sub-variant table). Placement,
// residency and amortisation belong to `terrain_scatter.js`; the landblock
// lifecycle belongs to `terrain_vfx.js`; the stomp render target belongs to
// `trail_map.js`. This module allocates none of those and rewrites none of them.
//
// CAMERA SCOPE, NOT LANDBLOCK (plan §2.2). The resident ring is 13x13 LBs
// (~1.15 km across); per-LB grass is not affordable. One fixed-size instanced
// pool is re-centred on the player every frame, so grass is immune to
// evict/park/rebake by construction. The only lifecycle interaction is
// `oracle.sample()` returning null for an unbaked landblock — those blades stay
// degenerate (zero-area) and the pool retries them on the next lap.
//
// THE 24 m CODE-SNAP PROBLEM (plan §8 risk 2 — "the highest-risk visual unknown
// in the plan; Wave 1A must prototype it before blade art"). The oracle snaps
// the terrain code to the NEAREST of the 81 vertices, i.e. a 24 m quantisation,
// while the ground shader bilinearly blends the four CELL-CORNER textures. A
// blade placed on the nearest-vertex code alone would draw hard 24 m square
// patches of grass over a smoothly blended ground. So placement picks its code
// by a HASH-DITHERED draw over the four `cornerCodes` weighted by the same
// bilinear weights the shader uses (`_ditherCornerCode`): statistically it IS
// the shader's blend, and it feathers in BOTH directions — grass thins out over
// the last few metres before a dirt boundary and a few blades stray onto the
// dirt side, exactly like a real edge. It is deterministic (the pool's per-cell
// hash stream), so park/unpark/teleport reproduce it exactly.
//
// WIND. The SAME gust function as `vfx/components/windSwayGpu.js` — a primary
// sine plus a decorrelated 3.7x flutter band, at the same default frequency and
// off the same clock (`scene3d.frameTime.tsSec`, which is also what
// `tickVfxOscillators` writes into `VFX_GLOBALS.uTime`) — so trees and grass
// gust TOGETHER rather than to two unrelated rhythms. Amplitude is CUBIC in
// height along the blade, so the base stays planted and only the top third
// really moves.
//   ⚠ DIVERGENCE from windSwayGpu, deliberately: its `uWindDir2` is documented
//   as OBJECT-space, which for statics is a feature (each placement bakes a yaw
//   into its instance matrix, so a stand of trees leans in varied directions
//   instead of like a row of flags). Grass instances share ONE object frame —
//   the pool writes only a translation into the instance matrix and the per-blade
//   yaw is our own `aRot` attribute, applied inside the snippet — so an
//   object-space direction here IS a world-space direction, trivially correct,
//   and the whole field leans downwind as one. Same uniform semantics, opposite
//   consequence; noted rather than "fixed".
//
// STOMP. `trail_map.js` (wave 0B) is the shared R8 ping-pong target; this module
// only STAMPS it (the player's ground position each frame) and READS it in the
// vertex shader. Gated by its own `?terrainGrassStomp` so the trail RT can be
// bisected independently of the blades. Bending down is proportional to the
// trail value; the lateral splay direction is the NEGATIVE GRADIENT of the trail
// map (two extra taps), i.e. away from whatever stamped it — which is correct
// for creature stamps too, unlike "away from the map centre".
//   The trail map clears itself on a teleport (`trail_map.js::update` detects a
//   jump > one landblock and calls `clear("teleport")`), and the scatter pool
//   re-scatters itself in full on the same rule. Neither is duplicated here.
//
// INVARIANTS (plan §5). A HOST module, not a registered `vfx/registry.js`
// component, so `vfx/lint_caps.js` does not sweep it — it obeys the firewall
// anyway and its test runs `lintSource` over this file to prove it. It reads
// terrain (static/derived), a server-derived player position and the frame
// clock; it writes only its own buffers and its own material's uniforms. It adds
// NO light (§5.2 — glow is emissive, never a PointLight), never varies a program
// cache key per instance (§5.4 — per-blade variety rides `vVfxHash`, derived
// procedurally from the instance matrix, plus our own instanced attributes),
// uses no `Math.random` (§5.5), and sets `castShadow = false` (§5.7 — three's
// shadow map swaps the MATERIAL, not the geometry, so added geometry is paid in
// full a second time by the depth pass; that is also why `gfxSubdivLevel` is 0
// on every tier). It does not touch the terrain fragment shader — 1B owns that
// this wave.
//
// DEGRADE LEVER = BLADE COUNT, NOT RENDER SCALE (plan §3.1). Grass is
// vertex-bound, not fill-bound, so 25 % render scale buys it nothing;
// `adaptive_render_scale.js` must keep owning resolution and must never drive
// the blade count. The lever is the quality tier (`terrainGrassBlades`), with
// `?terrainGrassDensity` as the continuous A/B knob on top of it.
//
// INJECTED THREE (the `trail_map.js` / `terrain_scatter.js` idiom). This module
// imports no three — `initTerrainGrass({THREE, ...})` takes it — which is what
// keeps `test_terrain_grass_shader.mjs` a pure-ESM test and lets
// `test_terrain_grass_scatter.mjs` inject a spy namespace.
//
// FLAGS (all §2.4-strict; ship OFF, plan §5.9)
//   ?terrainGrass=on         master, EXACT-match opt-in
//   ?terrainGrassDensity=N   0..2, default 1.0 (multiplies the tier blade count)
//   ?terrainGrassRadius=N    metres, default 48 (URL > preset > fallback)
//   ?terrainGrassStomp=on    the trail-map read, bisectable on its own
//   ?terrainGrassBlades=N    the tier count itself (quality.js INT_FLAGS)
//   ?grassOffRoad=off        2026-10-07 escape; DEFAULT-ON (see OFF-ROAD below)
//   ?terrainGrassReach=N     2026-10-12; DEFAULT 5, 1 (or off) = the old single
//                            field (see GRASS LOD below)
//   ?terrainGrassNearShare=f 0.05..0.95, default 0.34 — budget kept by ring 0
//
// OFF-ROAD (2026-10-07, owner, Holtburg: "see the grass on the road. can we make
// it so its not on the road"). A retail road is 2 bits on the vertex word, not a
// terrain code — the road vertex keeps its Grassland/LushGrass code — so the
// corner-code dither planted blades straight across every cobbled lane. The
// oracle now reports `roadEdgeM` (signed metres to the edge of the road the
// ground shader paints, modelled on retail's own road-mask decomposition and
// calibrated against the masks in portal.dat), and the pool's `offRoad` gate
// rejects every blade on the road and thins them linearly over a 1.5 m verge.
// Same deterministic per-cell hash as the rest of placement, so park/teleport
// reproduce it exactly.
//
// GRASS LOD (2026-10-12, owner on the 1070: the player stood in dense grass
// while the hills they were looking at had none — "less dense grass around the
// player and reassign it to further ahead of them, maybe up to 5x further ...
// same budget on the grass"). The SAME blade count is now split over nested
// rings, each a scatter pool of its own: ring k reaches twice as far as ring
// k-1, the outermost reaches `terrainGrassReach` x the radius (ultra: 40 m ->
// 200 m), ring 0 keeps `nearShare` of the budget and the outer rings split the
// rest equally. Equal counts over 4x the area per ring is a 1/d^2 density fall-
// off — what keeps the blade count per screen pixel roughly constant on a slope
// facing the camera, which is exactly the hill case. Two rings meet in a
// CROSS-DISSOLVE band ([lodBlend x W, W] of the inner ring): the inner ring
// thins to nothing across it while the next one thins in, each blade against
// its own `aRank`, so density blends linearly and no ring edge is visible.
// Outer-ring blades are wider (and slightly taller) so a sparser ring still
// reads as grass instead of sub-pixel slivers — `uGrassLodScale`, live-tunable
// through `window.__terrainGrass.setLod()`. Every ring shares ONE program (one
// onBeforeCompile source, per-ring uniform bags).

import { registerTerrainVfx, wireframeActive } from "./terrain_vfx.js";
import { SSAO_GRASS_MARKER } from "./ssao_marker.js";
// 2026-10-08 — no blades inside building interiors (owner: "grass poking
// through the building interior cells").
import { createInteriorMask, grassIndoorCullEnabled } from "./grass_interior_mask.js";
import { FAM_GRASS, familyForCode } from "./terrain_families.js";
import { createScatterPool, SCATTER_FADE_GLSL, scatterHash01 } from "./terrain_scatter.js";
import { ensureVfxHashVarying, VFX_HASH_ASSIGN_VERTEX } from "./vfx/per_instance.js";
import { treeWindStrength, treeWindDir } from "./tree_wind.js";
import {
  terrainGrassEnabled,
  terrainGrassBladeCount,
  terrainGrassDensity,
  terrainGrassRadiusM,
  terrainGrassStompEnabled,
  grassOffRoadEnabled,
  terrainGrassReach,
  terrainGrassNearShare,
} from "./vfx_flags.js";

// ---------------------------------------------------------------------------
// Tuning constants + the sub-variant table.
// ---------------------------------------------------------------------------

export const GRASS_DEFAULTS = Object.freeze({
  bladeCount: 60025,      // 245² — the `high` tier; every count rounds up square
  radiusM: 48,
  sliceSize: 512,         // plan §3.1: a frame re-scatters at most this many
  // 2026-10-07: 0.2 -> 0.35 with the tighter (40 m at ultra) radius — on a
  // slope seen from above the field ended in a visible line (owner at Holtburg).
  fadeFraction: 0.35,     // blades fade to zero scale over the last 35% of R
  seed: 0x6c455f01,
  heightOffsetM: -0.02,   // bury the base 2 cm so no blade floats on a slope
  // Wind. freq/flutter/the 3.7x band are windSwayGpu's numbers VERBATIM so the
  // two effects gust together; only the amplitude differs (a blade bends far
  // more of its own height than a tree trunk shears).
  windAmp: 0.42,          // metres of tip travel per metre of blade, at peak
  windFreqHz: 0.15,
  windFlutter: 0.3,
  windWave: 0.06,         // radians of phase per metre downwind — rolling gusts
  bowAmount: 0.12,        // static forward bow, fraction of blade height
  lean: 0.35,             // how far a blade leans downhill with the ground normal
  aoBase: 0.55,           // base-of-blade darkening (a free contact shadow)
  stompBend: 0.88,        // fraction of height removed at full stomp
  stompSplay: 0.55,       // lateral splay away from the stamp, x blade height
  stampRadiusM: 0.75,     // the player's footprint blob
  stampStrength: 1,
  // 2026-10-07 — off-road verge: blades thin from none at the painted road's
  // edge to full density 1.5 m out (covers the retail masks' soft fringe, see
  // terrain_oracle.js ROAD_PAINT).
  roadVergeM: 1.5,
  // 2026-10-12 — GRASS LOD (see the header). `reach` / `nearShare` are the
  // flag fallbacks; the rest is the look of the rings, live-tunable with
  // `window.__terrainGrass.setLod({...})`.
  reach: 5,
  nearShare: 0.34,
  lodBlend: 0.6,          // a ring cross-dissolves into the next over [0.6 W, W]
  lodSoft: 0.25,          // per-blade shrink width inside a dissolve (no pop)
  // Tuned live on the 1070 (ultra, Holtburg's SE hill): 0.75 / 0.15 left the
  // far slope a faint stipple; 1.0 / 0.6 read as tall grass at the crest.
  lodWidthExp: 1.0,       // ring width x (cell_k / cell_0) ^ this
  lodHeightGain: 0.35,    // ring height x (1 + this * k)
  farSliceSize: 256,      // re-scatter slice of every ring but the first
  // Round-robin scan per frame (unbaked retries / invalidations; the edge-first
  // drain is separate). Four pools at the pool default (2048) cost 0.46 ms a
  // frame standing on the 1070 vs 0.14 ms for the single field; these keep the
  // total near the old 2048 with laps no longer than its 58 frames.
  nearScanBudget: 1024,
  farScanBudget: 512,
});

/**
 * Per-code sub-variant table (plan §3.1). Keyed by TERRAIN CODE — never by name
 * and never by texture (plan §8 risk 12 / §2.7.2: retail SHARES one RenderSurface
 * across PatchyGrassland (9) and Moss (28), which are different sub-variants
 * here, and across codes in different families entirely).
 *
 *   h      blade height in metres (before jitter)
 *   w      blade width in metres
 *   tint   linear-ish RGB multiplier on the material's diffuse
 *   keep   probability a candidate blade survives (per-blade thinning)
 *   bare   fraction of ~8-cell clumps that are bare ground (patchiness)
 *   mat    0 = tall and springy, 1 = near-mat; drives wind stiffness in-shader
 */
export const GRASS_VARIANTS = Object.freeze({
  // 2026-10-07 look pass (1070, Holtburg noon): blades lit by the same sun as
  // the ground read as pale near-white hairs — the old tints (Grassland
  // 0.40/0.54/0.24) were ~2.5x brighter and far greyer than the displayed
  // ground (measured 0.15/0.18/0.01 linear through the Neutral curve). Tints
  // now sit on the ground's own hue, a touch greener, and every blade is ~1.6x
  // wider so a field reads as grass rather than scattered wires.
  // Grassland — the medium reference blade.
  1: Object.freeze({ h: 0.34, w: 0.050, tint: [0.15, 0.24, 0.035], keep: 0.88, bare: 0.0, mat: 0.35 }),
  // LushGrass — tall and saturated.
  3: Object.freeze({ h: 0.54, w: 0.055, tint: [0.11, 0.26, 0.030], keep: 1.0, bare: 0.0, mat: 0.0 }),
  // PatchyGrassland — sparse, with real bare gaps rather than uniform thinning.
  9: Object.freeze({ h: 0.26, w: 0.045, tint: [0.19, 0.21, 0.040], keep: 0.55, bare: 0.35, mat: 0.5 }),
  // forestfloor — short, leaf-litter tint (browner, less saturated).
  21: Object.freeze({ h: 0.16, w: 0.050, tint: [0.17, 0.16, 0.060], keep: 0.72, bare: 0.12, mat: 0.7 }),
  // Moss — very short, near-mat, wide.
  28: Object.freeze({ h: 0.075, w: 0.060, tint: [0.09, 0.19, 0.050], keep: 1.0, bare: 0.0, mat: 1.0 }),
  // DarkMoss — the same mat, darker and cooler.
  29: Object.freeze({ h: 0.065, w: 0.060, tint: [0.06, 0.13, 0.050], keep: 1.0, bare: 0.0, mat: 1.0 }),
});

/** The codes this family plants on, ascending. Derived from the table. */
export const GRASS_CODES = Object.freeze(
  Object.keys(GRASS_VARIANTS).map((k) => k | 0).sort((a, b) => a - b),
);

// ---------------------------------------------------------------------------
// Blade geometry — authored ONCE, in UNIT space.
//
// A 5-vertex strip: two base corners, two mid corners, one tip. Height runs
// 0..1 along +Z (AC up: inside `worldRoot` the object frame IS AC space) and
// width -0.5..0.5 along X, so the per-instance `aScale = (heightM, widthM)`
// scales it directly. Three triangles (a strip of N vertices is N-2 triangles;
// the plan's "4 tris" over-counts, so this is strictly UNDER its vertex budget).
//
// Normals are (0, 0, 1) — UP, not the blade's facing direction. That is
// deliberate: it lights a blade like the ground it grows out of, so a field
// reads as one surface instead of a shimmering mess of half-black blades, and it
// means the yaw/wind/stomp transforms need no normal rotation at all (a real
// per-blade normal would cost a mat3 per vertex for a worse image).
// ---------------------------------------------------------------------------

/** Unit blade positions, `x` = width, `z` = height. */
export const GRASS_BLADE_POSITIONS = Object.freeze([
  -0.5, 0, 0.0,
  0.5, 0, 0.0,
  -0.35, 0, 0.55,
  0.35, 0, 0.55,
  0.0, 0, 1.0,
]);
export const GRASS_BLADE_INDICES = Object.freeze([0, 1, 2, 2, 1, 3, 2, 3, 4]);
export const GRASS_BLADE_UVS = Object.freeze([0, 0, 1, 0, 0.1, 0.55, 0.9, 0.55, 0.5, 1]);

/**
 * Build the shared blade geometry.
 * @param {object} THREE injected three namespace
 * @returns {object|null} BufferGeometry, or null without a usable THREE
 */
export function makeGrassBladeGeometry(THREE) {
  if (!THREE || typeof THREE.BufferGeometry !== "function") return null;
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(GRASS_BLADE_POSITIONS);
  const nrm = new Float32Array(GRASS_BLADE_POSITIONS.length);
  for (let i = 0; i < nrm.length; i += 3) nrm[i + 2] = 1;
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(GRASS_BLADE_UVS), 2));
  g.setIndex(Array.from(GRASS_BLADE_INDICES));
  g.name = "terrain-grass-blade";
  return g;
}

// ---------------------------------------------------------------------------
// GLSL. Built as string arrays so the node test can assert on them with no GL
// context and no three. NO BACKTICKS ANYWHERE (a backtick inside GLSL would
// close the JS template it was pasted into — a house rule paid for once already).
// ---------------------------------------------------------------------------

/** Idempotency marker; also makes a shader dump readable. */
export const GRASS_MARKER = "VFX_TERRAIN_GRASS_BEGIN";
export const GRASS_END = "VFX_TERRAIN_GRASS_END";

/** The seam this patch needs. Absent ⇒ the injection is a NO-OP (byte-identical). */
export const GRASS_VERTEX_SEAM = "#include <begin_vertex>";
export const GRASS_FRAGMENT_SEAM = "#include <color_fragment>";
// The double-sided normal flip lives in this chunk (`normal *= faceDirection`).
export const GRASS_NORMAL_SEAM = "#include <normal_fragment_begin>";
// The object-space normal is set here, before the default normal transform.
export const GRASS_OBJECT_NORMAL_SEAM = "#include <beginnormal_vertex>";

/** Per-instance attributes THIS module owns (the pool owns aScale/aNormal). */
export const GRASS_ATTRIBUTES = Object.freeze([
  { name: "aScale", itemSize: 2 },        // (heightM, widthM) — POOL-owned defaults
  { name: "aNormal", itemSize: 3 },       // ground normal      — POOL-written
  { name: "aRot", itemSize: 1 },          // yaw, radians
  { name: "aTint", itemSize: 3 },         // per-blade colour
  { name: "aFamilyParam", itemSize: 1 },  // 0 = tall/springy .. 1 = near-mat
  { name: "aRank", itemSize: 1 },         // 0..1 dissolve rank (GRASS LOD)
]);

const GRASS_VERTEX_DECLS = [
  "uniform float uTime;",
  "uniform float uGrassWindAmp;",
  "uniform float uGrassWindFreq;",
  "uniform float uGrassWindFlutter;",
  "uniform float uGrassWindWave;",
  "uniform vec2 uGrassWindDir;",
  "uniform float uGrassBow;",
  "uniform float uGrassLean;",
  "uniform float uGrassAoBase;",
  "uniform float uGrassStompBend;",
  "uniform float uGrassStompSplay;",
  "uniform sampler2D uTrailMap;",
  "uniform vec2 uTrailCenter;",
  "uniform float uTrailRadius;",
  "uniform float uTrailTexel;",
  "uniform float uTrailEnabled;",
  "uniform vec4 uGrassLodBand;",
  "uniform vec2 uGrassLodScale;",
  "uniform float uGrassLodSoft;",
  "attribute vec2 aScale;",
  "attribute vec3 aNormal;",
  "attribute float aRot;",
  "attribute vec3 aTint;",
  "attribute float aFamilyParam;",
  "attribute float aRank;",
  "varying vec3 vGrassTint;",
];

const GRASS_FRAGMENT_DECLS = ["varying vec3 vGrassTint;", "uniform float uSsaoGrassMarker;"];
// The AO composite's grass marker (ssao_marker.js) is written at the very end.
export const GRASS_OUTPUT_SEAM = "#include <dithering_fragment>";

function _grassVertexSnippet() {
  return [
    "  // ---- " + GRASS_MARKER + " (terrain_grass.js, vertex) ----",
    "  {",
    "    // The instance matrix carries ONLY a translation (+ a 0/1 scale for",
    "    // degenerate instances), written by terrain_scatter.js — so its",
    "    // translation column is this blade's AC world position, and the object",
    "    // frame is the world frame (see the wind DIVERGENCE note in the header).",
    "    #ifdef USE_INSTANCING",
    "      vec2 hbWorld = instanceMatrix[3].xy;",
    "    #else",
    "      vec2 hbWorld = modelMatrix[3].xy;",
    "    #endif",
    "    // Authored blade height runs 0..1, so position.z IS the normalised",
    "    // height along the blade — no uniform, no per-model constant.",
    "    float hbH = clamp(position.z, 0.0, 1.0);",
    "    // aScale = (heightM, widthM), times the ring's (height, width) gain",
    "    // (GRASS LOD: an outer ring's blades are wider). Width also scales the",
    "    // (zero) y so a future ribbon blade needs no snippet change.",
    "    vec2 hbS = aScale * uGrassLodScale;",
    "    vec3 hbP = vec3(transformed.x * hbS.y, transformed.y * hbS.y, transformed.z * hbS.x);",
    "    // Static forward bow, per-blade via the procedural instance hash, so no",
    "    // two blades are identical even before the wind moves them.",
    "    hbP.y += uGrassBow * hbS.x * hbH * hbH * (0.5 + vVfxHash);",
    "    // Yaw. Per-blade, from our own attribute — this is what makes an",
    "    // object-space wind direction a WORLD-space one for grass.",
    "    float hbCos = cos(aRot);",
    "    float hbSin = sin(aRot);",
    "    hbP.xy = vec2(hbP.x * hbCos - hbP.y * hbSin, hbP.x * hbSin + hbP.y * hbCos);",
    "    // WIND — windSwayGpu's gust function verbatim (primary sine + a 3.7x",
    "    // flutter band at a decorrelated phase), off the same shared clock, so",
    "    // trees and grass gust together. The extra term is a spatial phase",
    "    // ramp along the wind direction: gusts ROLL across the field instead of",
    "    // pulsing in place. Amplitude is CUBIC in height so the base stays",
    "    // planted; uFamilyParam stiffens moss almost solid.",
    "    float hbPhase = vVfxHash * 6.2831853 + dot(hbWorld, uGrassWindDir) * uGrassWindWave;",
    "    float hbT = uTime * 6.2831853 * uGrassWindFreq;",
    "    float hbOsc = sin(hbT + hbPhase)",
    "                + uGrassWindFlutter * sin(hbT * 3.7 + hbPhase * 1.7 + 1.3);",
    "    float hbStiff = mix(1.0, 0.25, aFamilyParam);",
    "    hbP.xy += uGrassWindDir * (uGrassWindAmp * hbS.x * hbStiff * hbH * hbH * hbH * hbOsc);",
    "    // Lean downhill with the ground normal (its xy points downslope).",
    "    hbP.xy += aNormal.xy * (hbP.z * uGrassLean);",
    "    // STOMP — read the shared trail map at this blade's own world position.",
    "    // Two extra taps give the gradient; the blade splays along its NEGATIVE",
    "    // (downhill in trail value = away from whatever stamped it), which is",
    "    // correct for creature stamps as well as the player.",
    "    if (uTrailEnabled > 0.5) {",
    "      vec2 hbUv = (hbWorld - uTrailCenter) / (2.0 * uTrailRadius) + 0.5;",
    "      if (hbUv.x >= 0.0 && hbUv.x <= 1.0 && hbUv.y >= 0.0 && hbUv.y <= 1.0) {",
    "        float hbStomp = texture2D(uTrailMap, hbUv).r;",
    "        if (hbStomp > 0.0) {",
    "          float hbStep = uTrailTexel / max(2.0 * uTrailRadius, 1e-4);",
    "          vec2 hbGrad = vec2(",
    "            texture2D(uTrailMap, hbUv + vec2(hbStep, 0.0)).r - hbStomp,",
    "            texture2D(uTrailMap, hbUv + vec2(0.0, hbStep)).r - hbStomp);",
    "          hbP.z *= (1.0 - uGrassStompBend * hbStomp);",
    "          vec2 hbAway = hbGrad * -1.0;",
    "          float hbLen = length(hbAway);",
    "          if (hbLen > 1e-5) {",
    "            hbP.xy += (hbAway / hbLen) * (uGrassStompSplay * hbS.x * hbH * hbStomp);",
    "          }",
    "        }",
    "      }",
    "    }",
    "    // DISTANCE BLEND — shrink to nothing over the last fadeFraction of R,",
    "    // matching terrain_scatter.js::fadeFor exactly (LINEAR, same uniforms).",
    "    hbP *= hbScatterFade(hbWorld);",
    "    // GRASS LOD cross-dissolve: the ring's density ramps in over its inner",
    "    // band (x..y) and out over its outer band (z..w); a blade survives while",
    "    // its rank is under that density and shrinks over the last uGrassLodSoft",
    "    // of it, so blades thin out one by one instead of popping. A ring with",
    "    // no bands (the single-field layout) keeps every blade at full size.",
    "    float hbD = length(hbWorld - uScatterCenter.xy);",
    "    float hbKeep = min(",
    "      clamp((hbD - uGrassLodBand.x) / max(uGrassLodBand.y - uGrassLodBand.x, 1e-4), 0.0, 1.0),",
    "      clamp((uGrassLodBand.w - hbD) / max(uGrassLodBand.w - uGrassLodBand.z, 1e-4), 0.0, 1.0));",
    "    float hbSoft = max(uGrassLodSoft, 1e-4);",
    "    hbP *= clamp((hbKeep * (1.0 + hbSoft) - aRank) / hbSoft, 0.0, 1.0);",
    "    transformed = hbP;",
    "    // Per-blade colour + a free contact shadow: darken toward the base.",
    "    vGrassTint = aTint * mix(uGrassAoBase, 1.0, hbH);",
    "  }",
    "  // ---- " + GRASS_END + " ----",
  ].join("\n");
}

// NO BACK-FACE FLIP (2026-10-07, 1070 look pass). The blade normal is the
// ground's UP on purpose (see the geometry header), but the material is
// DoubleSide and three's normal_fragment_begin multiplies the normal by
// faceDirection — so every blade seen from behind got a DOWN normal, no sun and
// no sky light, and rendered as a black spike: half of every field read as
// black thorns at Holtburg. Re-take the interpolated normal unflipped, so both
// faces light exactly like the ground they grow from.
// GROUND NORMAL (2026-10-07, Holtburg at night). The authored blade normal is
// a constant UP, but the terrain it grows from is lit with its own slope: under
// retail's night "sun" (0.9 deg above the horizon) a west-facing hill was
// bright while every blade on it, facing straight up, got almost nothing — dark
// strokes on a pale slope. Each instance already carries the ground normal it
// was planted on (aNormal, POOL-written), so light the blade with that: the
// field matches the ground under it at every sun angle. Degenerate (unwritten)
// instances keep UP.
function _grassGroundNormalSnippet() {
  return [
    "  // ---- " + GRASS_MARKER + " (terrain_grass.js, ground normal) ----",
    "  if (dot(aNormal, aNormal) > 1e-6) objectNormal = normalize(aNormal);",
    "  // ---- " + GRASS_END + " ----",
  ].join("\n");
}

function _grassMarkerSnippet() {
  return [
    "  // ---- " + GRASS_MARKER + " (terrain_grass.js, ssao marker) ----",
    "  gl_FragColor.a = mix(gl_FragColor.a, 0.0, uSsaoGrassMarker);",
    "  // ---- " + GRASS_END + " ----",
  ].join("\n");
}

function _grassNormalSnippet() {
  return [
    "  // ---- " + GRASS_MARKER + " (terrain_grass.js, normal) ----",
    "  #ifndef FLAT_SHADED",
    "    normal = normalize( vNormal );",
    "  #endif",
    "  // ---- " + GRASS_END + " ----",
  ].join("\n");
}

function _grassFragmentSnippet() {
  return [
    "  // ---- " + GRASS_MARKER + " (terrain_grass.js, fragment) ----",
    "  diffuseColor.rgb *= vGrassTint;",
    "  // ---- " + GRASS_END + " ----",
  ].join("\n");
}

/**
 * Insert one global-scope declaration exactly once. Same shape as
 * `windSwayGpu._ensureVertexDecl`: a second `uniform float uTime;` is a GLSL
 * redeclaration ERROR, and uTime is shared with the rest of the VFX suite, so
 * "declare it if it is not already there" is the only safe idiom.
 */
function _ensureDecl(src, decl, seam) {
  return src.indexOf(decl) === -1 ? src.replace(seam, decl + "\n" + seam) : src;
}

/**
 * Patch a three onBeforeCompile `shader` object with the grass vertex transform
 * and the per-blade tint.
 *
 * NO-OP (byte-identical) when the seam is absent — a non-standard material must
 * stay untouched, exactly like `resolveFragMaterial` returning null. Idempotent
 * / recompile-safe via `GRASS_MARKER`. Never touches `customProgramCacheKey`
 * (plan §5.4): per-blade variety rides `vVfxHash` (procedural, from the instance
 * matrix — zero new programs) plus our instanced attributes.
 *
 * Pure string surgery: no three import, no uniforms, so the node test needs
 * neither a GL context nor `node_modules`.
 *
 * @param {{vertexShader:string, fragmentShader:string}} shader
 * @returns {object} the same shader (for chaining)
 */
export function injectTerrainGrassShader(shader) {
  if (!shader || typeof shader.vertexShader !== "string" || typeof shader.fragmentShader !== "string") {
    return shader;
  }
  if (shader.vertexShader.indexOf(GRASS_MARKER) !== -1) return shader;   // recompile
  if (shader.vertexShader.indexOf(GRASS_VERTEX_SEAM) === -1) return shader; // inert
  if (shader.fragmentShader.indexOf(GRASS_FRAGMENT_SEAM) === -1) return shader;

  // 1) Declarations, each exactly once.
  let vs = shader.vertexShader;
  for (const decl of GRASS_VERTEX_DECLS) vs = _ensureDecl(vs, decl, "void main() {");
  // The scatter fade helper carries its own four uniforms; copied in rather
  // than re-derived so grass and sand fade identically (terrain_scatter.js).
  if (vs.indexOf("hbScatterFade") === -1) {
    vs = vs.replace("void main() {", SCATTER_FADE_GLSL + "\nvoid main() {");
  }
  shader.vertexShader = vs;

  let fs = shader.fragmentShader;
  for (const decl of GRASS_FRAGMENT_DECLS) fs = _ensureDecl(fs, decl, "void main() {");
  shader.fragmentShader = fs;

  // 2) The per-instance hash varying + its assignment (shared infra; adds no
  //    program). Components that read it declare "instanceHash" in reads[].
  ensureVfxHashVarying(shader);

  // 3) Splice. The vertex snippet goes AFTER the hash assignment so `vVfxHash`
  //    is written before it is read; anchor on the EXPORTED constant so this
  //    stays in lockstep with per_instance.js rather than on copied text.
  shader.vertexShader = shader.vertexShader.replace(
    GRASS_OBJECT_NORMAL_SEAM,
    GRASS_OBJECT_NORMAL_SEAM + "\n" + _grassGroundNormalSnippet(),
  );
  const cur = shader.vertexShader;
  if (cur.indexOf(VFX_HASH_ASSIGN_VERTEX) !== -1) {
    shader.vertexShader = cur.replace(
      VFX_HASH_ASSIGN_VERTEX,
      VFX_HASH_ASSIGN_VERTEX + "\n" + _grassVertexSnippet(),
    );
  } else {
    shader.vertexShader = cur.replace(
      GRASS_VERTEX_SEAM,
      GRASS_VERTEX_SEAM + "\n" + _grassVertexSnippet(),
    );
  }
  shader.fragmentShader = shader.fragmentShader.replace(
    GRASS_FRAGMENT_SEAM,
    GRASS_FRAGMENT_SEAM + "\n" + _grassFragmentSnippet(),
  );
  // Absent seam (a non-standard material) ⇒ replace() is a no-op, as above.
  shader.fragmentShader = shader.fragmentShader.replace(
    GRASS_NORMAL_SEAM,
    GRASS_NORMAL_SEAM + "\n" + _grassNormalSnippet(),
  );
  shader.fragmentShader = shader.fragmentShader.replace(
    GRASS_OUTPUT_SEAM,
    GRASS_OUTPUT_SEAM + "\n" + _grassMarkerSnippet(),
  );
  return shader;
}

/** True once `injectTerrainGrassShader` has patched both stages. */
export function hasTerrainGrassShader(shader) {
  return !!shader && typeof shader.vertexShader === "string"
    && shader.vertexShader.indexOf(GRASS_MARKER) !== -1
    && typeof shader.fragmentShader === "string"
    && shader.fragmentShader.indexOf(GRASS_MARKER) !== -1;
}

// ---------------------------------------------------------------------------
// Config resolution (URL > quality preset > fallback — plan §2.4/§5.8).
// ---------------------------------------------------------------------------

/**
 * Resolve the grass configuration. Pure apart from the injected readers, so a
 * test can drive every branch without a `window`.
 *
 * @param {object} [overrides] explicit values (tests / callers) that win over
 *   every reader.
 * @returns {{count:number, radiusM:number, stomp:boolean, density:number,
 *   blades:number, seed:number, offRoad:boolean, reach:number, nearShare:number,
 *   source:string}|null} null ⇒ disabled at this
 *   tier (the `low` contract: every effect in this plan is null on `low`).
 */
export function resolveGrassConfig(overrides = {}) {
  const blades = Number.isFinite(overrides.blades) ? overrides.blades : terrainGrassBladeCount();
  const density = Number.isFinite(overrides.density) ? overrides.density : terrainGrassDensity();
  const radiusM = Number.isFinite(overrides.radiusM) ? overrides.radiusM : terrainGrassRadiusM();
  const stomp = typeof overrides.stomp === "boolean" ? overrides.stomp : terrainGrassStompEnabled();
  // 2026-10-07 — `?grassOffRoad` (default ON); explicit boolean wins (tests).
  const offRoad = typeof overrides.offRoad === "boolean" ? overrides.offRoad : grassOffRoadEnabled();
  // 2026-10-12 — GRASS LOD (`?terrainGrassReach`, default 5; 1 = one field).
  const reach = Number.isFinite(overrides.reach) ? Math.max(1, overrides.reach) : terrainGrassReach();
  const nearShare = Number.isFinite(overrides.nearShare)
    ? Math.min(0.95, Math.max(0.05, overrides.nearShare))
    : terrainGrassNearShare();
  const count = Math.round(blades * (Number.isFinite(density) ? density : 1));
  if (!(count >= 1)) return null;
  return {
    blades,
    density,
    count,
    radiusM,
    stomp,
    offRoad,
    reach,
    nearShare,
    seed: Number.isFinite(overrides.seed) ? overrides.seed | 0 : GRASS_DEFAULTS.seed,
    source: Number.isFinite(overrides.blades) ? "explicit" : "flags",
  };
}

// ---------------------------------------------------------------------------
// GRASS LOD — the ring layout (2026-10-12; see the header).
// ---------------------------------------------------------------------------

/** Band of a ring that never dissolves (the single-field layout's ring). */
const LOD_NO_BAND = Object.freeze([-2, -1, 1e6, 2e6]);

/** The look half of the layout, defaults applied. */
export function resolveGrassLodLook(look = {}) {
  const pick = (v, d, lo, hi) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  return {
    blend: pick(look.blend, GRASS_DEFAULTS.lodBlend, 0.05, 0.95),
    soft: pick(look.soft, GRASS_DEFAULTS.lodSoft, 0.01, 1),
    widthExp: pick(look.widthExp, GRASS_DEFAULTS.lodWidthExp, 0, 2),
    heightGain: pick(look.heightGain, GRASS_DEFAULTS.lodHeightGain, 0, 2),
  };
}

/**
 * Split a resolved grass config into rings. Pure (node-tested).
 *
 * `reach <= 1` is the single field exactly as before 2026-10-12: one ring of
 * `count` blades over `radiusM`, the pool's own shrink fade, no dissolve.
 * Otherwise ring k (0..L-1) covers a square window of half-extent
 * `W_k = reach x radiusM / 2^(L-1-k)` (L = 1 + ceil(log2 reach), so W doubles
 * ring to ring and the last one reaches reach x radiusM), with a perfect-square
 * share of the budget: `nearShare` for ring 0, the rest split equally. The
 * counts are rounded DOWN, so the rings never exceed the tier's blade count.
 *
 * @returns {Array<{level:number, count:number, radiusM:number, cellSizeM:number,
 *   fadeFraction:number, sliceSize:number, scanBudget?:number, seed:number, randSalt:number,
 *   band:number[], heightMul:number, widthMul:number}>}
 */
export function grassLodLayout(cfg, look = {}) {
  const lk = resolveGrassLodLook(look);
  const R = Number.isFinite(cfg.radiusM) && cfg.radiusM > 0 ? cfg.radiusM : GRASS_DEFAULTS.radiusM;
  const reach = Number.isFinite(cfg.reach) ? cfg.reach : 1;
  const seed = Number.isFinite(cfg.seed) ? cfg.seed | 0 : GRASS_DEFAULTS.seed;
  if (!(reach > 1)) {
    const g = Math.max(1, Math.ceil(Math.sqrt(cfg.count)));
    return [{
      level: 0, count: cfg.count, radiusM: R, cellSizeM: (2 * R) / g,
      fadeFraction: GRASS_DEFAULTS.fadeFraction, sliceSize: GRASS_DEFAULTS.sliceSize,
      seed, randSalt: 0, band: LOD_NO_BAND.slice(), heightMul: 1, widthMul: 1,
    }];
  }
  const L = 1 + Math.ceil(Math.log2(reach) - 1e-9);
  const outer = R * reach;
  const share0 = Number.isFinite(cfg.nearShare) ? cfg.nearShare : GRASS_DEFAULTS.nearShare;
  const rings = [];
  for (let k = 0; k < L; k += 1) {
    const W = outer / 2 ** (L - 1 - k);
    const share = k === 0 ? share0 : (1 - share0) / (L - 1);
    const g = Math.max(1, Math.floor(Math.sqrt(share * cfg.count)));
    rings.push({
      level: k,
      count: g * g,
      radiusM: W,
      cellSizeM: (2 * W) / g,
      // The dissolve owns the rim; the pool's fade is a hard cut at W.
      fadeFraction: 0,
      sliceSize: k === 0 ? GRASS_DEFAULTS.sliceSize : GRASS_DEFAULTS.farSliceSize,
      scanBudget: k === 0 ? GRASS_DEFAULTS.nearScanBudget : GRASS_DEFAULTS.farScanBudget,
      // Ring 0 keeps the single field's seed (same blades where they overlap);
      // the others get their own jitter and rand streams.
      seed: k === 0 ? seed : (seed ^ Math.imul(k, 0x9e3779b9)) | 0,
      randSalt: k,
      band: null,
      heightMul: 1,
      widthMul: 1,
    });
  }
  applyGrassLodLook(rings, lk);
  return rings;
}

/**
 * A ring's density at distance `d` from the player, 0..1 — the CPU mirror of
 * the GLSL `hbKeep` (LINEAR ramps in over band[0..1], out over band[2..3]).
 */
export function grassLodKeep(band, d) {
  const clamp01 = (v) => (v <= 0 ? 0 : (v >= 1 ? 1 : v));
  const a = clamp01((d - band[0]) / Math.max(band[1] - band[0], 1e-4));
  const b = clamp01((band[3] - d) / Math.max(band[3] - band[2], 1e-4));
  return Math.min(a, b);
}

/** (Re)write the look of a layout in place: dissolve bands and blade gains. */
export function applyGrassLodLook(rings, look) {
  const lk = resolveGrassLodLook(look);
  if (rings.length === 1 && rings[0].fadeFraction > 0) return rings;   // single field
  const cell0 = rings[0].cellSizeM;
  for (let k = 0; k < rings.length; k += 1) {
    const r = rings[k];
    const prevW = k > 0 ? rings[k - 1].radiusM : 0;
    r.band = [
      k === 0 ? -2 : lk.blend * prevW, k === 0 ? -1 : prevW,
      lk.blend * r.radiusM, r.radiusM,
    ];
    r.widthMul = (r.cellSizeM / cell0) ** lk.widthExp;
    r.heightMul = 1 + lk.heightGain * k;
  }
  return rings;
}

// ---------------------------------------------------------------------------
// Placement — the `fill` callback. THE per-blade art decision.
// ---------------------------------------------------------------------------

/**
 * Hash-dithered corner-code pick (plan §8 risk 2/3). The oracle's `code` is a
 * NEAREST-VERTEX snap on a 24 m grid; the ground shader bilinearly blends the
 * four CELL-CORNER layers and `texMerge` keys off the nearest-CORNER code. A
 * stochastic draw over the corners with the bilinear weights agrees with the
 * rendered ground in expectation, so blade coverage dissolves across a terrain
 * boundary instead of drawing 24 m squares.
 *
 * @param {object} ctx the pool's fill context (reused — never retained)
 * @returns {number} a terrain code 0..31
 */
export function ditherCornerCode(ctx) {
  const corners = ctx.cornerCodes;
  if (!corners || corners.length !== 4) return ctx.code;
  // Cell-local fractions. Cells are 24 m and every landblock origin is a
  // multiple of 192 = 8 * 24, so the global fraction IS the cell fraction.
  const fx = ctx.x / 24 - Math.floor(ctx.x / 24);
  const fy = ctx.y / 24 - Math.floor(ctx.y / 24);
  const wSW = (1 - fx) * (1 - fy);
  const wSE = fx * (1 - fy);
  const wNW = (1 - fx) * fy;
  let r = ctx.rand(5);
  if (r < wSW) return corners[0];
  r -= wSW;
  if (r < wSE) return corners[1];
  r -= wSE;
  if (r < wNW) return corners[2];
  return corners[3];
}

/** Bare-patch clump size, metres (PatchyGrassland / forestfloor gaps). */
const GRASS_CLUMP_M = 2;

/**
 * Build the per-blade `fill` callback for a given seed. Deterministic: every
 * value is a pure function of the WORLD CELL and the seed (plan §5.5), so
 * park/unpark, teleport-and-return and a rebake all reproduce the same field.
 */
export function makeGrassFill(seed) {
  return function grassFill(ctx) {
    const code = ditherCornerCode(ctx);
    if (familyForCode(code) !== FAM_GRASS) { ctx.live = false; return; }
    const v = GRASS_VARIANTS[code];
    if (!v) { ctx.live = false; return; }

    // Bare patches first: a coarse 2 m clump hash, so PatchyGrassland gets
    // real gaps rather than uniformly-thinner grass. World metres, not pool
    // cells (2026-10-12): every GRASS LOD ring must agree on where the gaps are.
    if (v.bare > 0
      && scatterHash01(Math.floor(ctx.x / GRASS_CLUMP_M), Math.floor(ctx.y / GRASS_CLUMP_M), 9, seed) < v.bare) {
      ctx.live = false;
      return;
    }
    if (v.keep < 1 && ctx.rand(4) > v.keep) { ctx.live = false; return; }

    const h = v.h * (0.7 + 0.6 * ctx.rand(1));
    const w = v.w * (0.85 + 0.3 * ctx.rand(2));
    // Colour: one shared value/saturation jitter per blade (a per-channel jitter
    // reads as noise, not as grass).
    const shade = 0.82 + 0.36 * ctx.rand(3);
    const warm = 0.94 + 0.12 * ctx.rand(6);
    ctx.set("aScale", h, w);
    ctx.set("aRot", ctx.rand(0) * 6.283185307179586);
    ctx.set("aTint", v.tint[0] * shade * warm, v.tint[1] * shade, v.tint[2] * shade * (2 - warm));
    ctx.set("aFamilyParam", v.mat);
    ctx.set("aRank", ctx.rand(7));
  };
}

// ---------------------------------------------------------------------------
// The provider.
// ---------------------------------------------------------------------------

/**
 * Create the grass provider (a `terrain_vfx.js` `scope: "camera"` provider).
 * The GPU objects are built LAZILY on the first update that has a player
 * position, so a registered-but-never-ticked provider (wireframe, `?terrainVfx=off`,
 * a headless logic run) allocates nothing.
 *
 * @param {object} opts
 * @param {object} [opts.THREE]   injected three namespace. Omit ⇒ CPU-only pool
 *   (the node-test and `?nullRender=1` path).
 * @param {object} [opts.parent]  Object3D to hang the grass group off; must have
 *   terrainGroup's transform (worldRoot). Resolved from `scene3d` if omitted.
 * @param {object} [opts.scene3d] the live facade (for the parent fallback).
 * @param {object} [opts.config]  explicit `resolveGrassConfig` overrides.
 * @param {object} [opts.material] a material to use instead of the built-in one.
 */
export function createTerrainGrassProvider(opts = {}) {
  const THREE = opts.THREE || null;
  const cfg = resolveGrassConfig(opts.config || {});
  const seed = cfg ? cfg.seed : GRASS_DEFAULTS.seed;
  // 2026-10-12 — GRASS LOD: one scatter pool (+ geometry, material, uniform
  // bag) per ring; ring 0 is what `_pool` / `stats().pool` always meant.
  let lodLook = resolveGrassLodLook(opts.lodLook || {});
  const layout = cfg ? grassLodLayout(cfg, lodLook) : [];
  /** @type {Array<{ring:object, pool:object, geometry:object, material:object, uniforms:object}>} */
  let rings = [];

  let group = null;
  let built = false;
  let buildError = null;
  let lastCtx = null;
  let stamps = 0;
  let trailBound = false;
  // `?grassIndoorCull` (default on): EnvCell boxes the pool's exclude test reads.
  const indoorMask = grassIndoorCullEnabled(opts.search) ? createInteriorMask() : null;

  // Uniform bag — one `{value}` object per uniform, bound BY REFERENCE into the
  // compiling shader (plan §5.6) so the per-frame writes below reach the GPU
  // with no material rebuild and no recompile.
  const uniforms = {
    uTime: { value: 0 },
    uGrassWindAmp: { value: GRASS_DEFAULTS.windAmp },
    uGrassWindFreq: { value: GRASS_DEFAULTS.windFreqHz },
    uGrassWindFlutter: { value: GRASS_DEFAULTS.windFlutter },
    uGrassWindWave: { value: GRASS_DEFAULTS.windWave },
    // Plain {x,y} is a valid vec2 uniform (three's setValueV2f reads v.x/v.y),
    // which keeps this module three-free — the windSwayGpu/tipFlex idiom.
    uGrassWindDir: { value: { x: 0, y: 0 } },
    uGrassBow: { value: GRASS_DEFAULTS.bowAmount },
    uGrassLean: { value: GRASS_DEFAULTS.lean },
    uGrassAoBase: { value: GRASS_DEFAULTS.aoBase },
    uGrassStompBend: { value: GRASS_DEFAULTS.stompBend },
    uGrassStompSplay: { value: GRASS_DEFAULTS.stompSplay },
    uTrailMap: { value: null },
    uTrailCenter: { value: { x: 0, y: 0 } },
    uTrailRadius: { value: 48 },
    uTrailTexel: { value: 0.375 },
    uTrailEnabled: { value: 0 },
    // Shared by reference with the AO composite (ssao_marker.js): 1 while it
    // exists, so the grass is marked only when something restores the alpha.
    uSsaoGrassMarker: SSAO_GRASS_MARKER,
    // GRASS LOD — PER RING (each ring's bag gets its own objects in build());
    // these are the single-field values: no dissolve, unit blade gains.
    uGrassLodBand: { value: { x: LOD_NO_BAND[0], y: LOD_NO_BAND[1], z: LOD_NO_BAND[2], w: LOD_NO_BAND[3] } },
    uGrassLodScale: { value: { x: 1, y: 1 } },
    uGrassLodSoft: { value: GRASS_DEFAULTS.lodSoft },
  };
  // Uniforms each ring owns (everything else is shared by reference).
  const RING_UNIFORMS = ["uGrassLodBand", "uGrassLodScale", "uGrassLodSoft"];

  function writeRingLook(r) {
    const u = r.uniforms;
    const b = r.ring.band;
    u.uGrassLodBand.value.x = b[0];
    u.uGrassLodBand.value.y = b[1];
    u.uGrassLodBand.value.z = b[2];
    u.uGrassLodBand.value.w = b[3];
    u.uGrassLodScale.value.x = r.ring.heightMul;
    u.uGrassLodScale.value.y = r.ring.widthMul;
    u.uGrassLodSoft.value = lodLook.soft;
  }

  // Wind frame, resolved once: the SAME flags the trees read
  // (`?treeWindStrength` / `?treeWindDir`, default 135 deg = SE), so a URL that
  // turns the wind up turns it up for both.
  {
    const dirRad = treeWindDir() * Math.PI / 180;
    uniforms.uGrassWindDir.value.x = Math.cos(dirRad);
    uniforms.uGrassWindDir.value.y = Math.sin(dirRad);
    uniforms.uGrassWindAmp.value = GRASS_DEFAULTS.windAmp * treeWindStrength();
  }

  // One material per ring, all with the SAME onBeforeCompile source — three's
  // default program cache key — so the rings share one program (plan §5.4)
  // while each binds its own uniform bag.
  function buildMaterial(bag) {
    if (opts.material) return opts.material;
    if (!THREE || typeof THREE.MeshLambertMaterial !== "function") return null;
    const m = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide !== undefined ? THREE.DoubleSide : undefined,
      // Blades are opaque geometry; no alpha test, no blending, no sorting cost.
      transparent: false,
      fog: true,
    });
    m.name = "terrain-grass";
    m.onBeforeCompile = (shader) => {
      shader.uniforms = shader.uniforms || {};
      for (const key of Object.keys(bag)) shader.uniforms[key] = bag[key];
      injectTerrainGrassShader(shader);
    };
    return m;
  }

  function build(ctx) {
    built = true;
    if (!cfg) return;
    try {
      const parent = opts.parent
        || ctx?.scene3d?.terrainGroup?.parent
        || opts.scene3d?.terrainGroup?.parent
        || null;
      if (THREE && typeof THREE.Group === "function") {
        group = new THREE.Group();
        group.name = "terrainGrass";
        group.castShadow = false;
        group.receiveShadow = false;
        if (parent && typeof parent.add === "function") parent.add(group);
      }
      for (const ring of layout) {
        // Shared {value} objects by reference; the ring-owned ones fresh.
        const bag = { ...uniforms };
        bag.uGrassLodBand = { value: { x: 0, y: 0, z: 0, w: 0 } };
        bag.uGrassLodScale = { value: { x: 1, y: 1 } };
        bag.uGrassLodSoft = { value: lodLook.soft };
        // The pool publishes its distance-blend uniforms INTO the bag.
        for (const key of ["uScatterCenter", "uScatterRadius", "uScatterFadeStart", "uScatterShape"]) delete bag[key];
        const geometry = makeGrassBladeGeometry(THREE);
        const material = buildMaterial(bag);
        const pool = createScatterPool({
          THREE,
          geometry,
          material,
          parent: group,
          uniforms: bag,
          // LIVE getter — `terrain_vfx.js` documents `ctx.oracle` as a getter that
          // must never be stashed (it is loaded on demand and can arrive after the
          // first tick).
          oracle: () => (lastCtx ? lastCtx.oracle : null),
          count: ring.count,
          radiusM: ring.radiusM,
          sliceSize: ring.sliceSize,
          // undefined (the single field) = the pool default, as before.
          scanBudget: ring.scanBudget,
          fadeFraction: ring.fadeFraction,
          // 2026-10-08 — place the whole square window, fade as a disc: see
          // terrain_scatter.js fadeShape (blades entering at the leading edge are
          // ready before they fade in, instead of spawning in front of a runner).
          shape: "square",
          fadeShape: "disc",
          seed: ring.seed,
          randSalt: ring.randSalt,
          heightOffsetM: GRASS_DEFAULTS.heightOffsetM,
          // NO family gate on the pool: the dithered corner draw in `fill` is what
          // decides, and a nearest-vertex family gate would clip exactly the
          // boundary blades the dither exists to keep (plan §8 risk 2).
          attributes: GRASS_ATTRIBUTES.map((a) => ({ ...a })),
          // 2026-10-07 — no blades on the painted road, a soft verge beside it
          // (see OFF-ROAD in the header). Decided in the pool, BEFORE `fill`, so
          // the dithered corner-code draw never even runs on the road.
          offRoad: cfg.offRoad === true,
          offRoadVergeM: GRASS_DEFAULTS.roadVergeM,
          // 2026-10-08 — and none inside a building (grass_interior_mask.js).
          exclude: indoorMask ? (x, y, z) => indoorMask.contains(x, y, z) : undefined,
          // The BASE seed for every ring: bare patches must agree across rings.
          fill: makeGrassFill(seed),
          name: layout.length > 1 ? `terrain-grass-ring${ring.level}` : "terrain-grass",
        });
        const r = { ring, pool, geometry, material, uniforms: bag };
        writeRingLook(r);
        rings.push(r);
      }
      // Ring 0's distance-blend uniforms also live in the shared bag, as they
      // always did (`window.__terrainGrass.uniforms.uScatterCenter`).
      for (const key of Object.keys(rings[0].pool.uniforms)) {
        if (RING_UNIFORMS.indexOf(key) === -1) uniforms[key] = rings[0].pool.uniforms[key];
      }
    } catch (e) {
      buildError = e;
      for (const r of rings) { try { r.pool.dispose(); } catch (_) {} }
      rings = [];
    }
  }

  function bindTrail(trail) {
    if (!trail || !trail.uniforms) {
      uniforms.uTrailEnabled.value = 0;
      return;
    }
    const tu = trail.uniforms;
    // Copy the VALUES (not the objects): the trail ping-pongs its target every
    // frame and swaps `uTrailMap.value` in place, and the map itself may be
    // constructed after this material compiled. Four scalar writes per frame is
    // cheaper than re-binding and immune to both.
    uniforms.uTrailMap.value = tu.uTrailMap ? tu.uTrailMap.value : null;
    if (tu.uTrailCenter && tu.uTrailCenter.value) {
      uniforms.uTrailCenter.value.x = tu.uTrailCenter.value.x;
      uniforms.uTrailCenter.value.y = tu.uTrailCenter.value.y;
    }
    if (tu.uTrailRadius) uniforms.uTrailRadius.value = tu.uTrailRadius.value;
    if (tu.uTrailTexel) uniforms.uTrailTexel.value = tu.uTrailTexel.value;
    uniforms.uTrailEnabled.value = uniforms.uTrailMap.value ? 1 : 0;
    trailBound = true;
  }

  const provider = {
    id: "terrain.grass",
    scope: "camera",
    families: [FAM_GRASS],
    enabled: terrainGrassEnabled,

    /** null ⇒ disabled at this tier (`low` — plan §5.8). */
    quality() {
      return cfg;
    },

    update(dt, ctx) {
      lastCtx = ctx;
      if (!cfg) return;
      if (!built) build(ctx);
      if (!rings.length) return;
      if (!ctx || ctx.hasPlayer !== true) return;
      // The loaded interior cells changed (a building's interior baked or was
      // evicted). 2026-10-08: re-examine only the blades near the boxes that
      // changed — clipped to the pool window, one merged region — not the whole
      // pool: cells stream in and out constantly while running through a town,
      // and a full invalidate() stalled the ground ahead of the player.
      if (indoorMask && indoorMask.sync(ctx.scene3d || opts.scene3d || null)) {
        const changed = typeof indoorMask.lastChanged === "function" ? indoorMask.lastChanged() : null;
        for (const { pool } of rings) {
        if (!changed) {
          pool.invalidate();
        } else if (changed.length) {
          const r = pool.radiusM, pp = ctx.playerPos;
          const wx0 = pp.x - r, wy0 = pp.y - r, wx1 = pp.x + r, wy1 = pp.y + r;
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const b of changed) {
            if (b[2] < wx0 || b[0] > wx1 || b[3] < wy0 || b[1] > wy1) continue;
            if (b[0] < x0) x0 = b[0]; if (b[1] < y0) y0 = b[1];
            if (b[2] > x1) x1 = b[2]; if (b[3] > y1) y1 = b[3];
          }
          if (x1 >= x0) pool.invalidateRegion(Math.max(x0, wx0), Math.max(y0, wy0), Math.min(x1, wx1), Math.min(y1, wy1));
        }
        }
      }

      // The single time source (plan §2.3) — the same `frameTime.tsSec` that
      // `tickVfxOscillators` writes into VFX_GLOBALS.uTime, so the tree sway and
      // the grass sway share a phase.
      uniforms.uTime.value = ctx.tSec;

      const p = ctx.playerPos;
      if (cfg.stomp) {
        const trail = ctx.trail;
        if (trail) {
          // Stamp the player's ground position. The spine has already ticked the
          // map this frame, so this stamp lands next frame — one frame of
          // latency on a 4 s recovery, which is not a visible thing.
          if (typeof trail.stamp === "function"
            && trail.stamp(p.x, p.y, GRASS_DEFAULTS.stampRadiusM, GRASS_DEFAULTS.stampStrength)) {
            stamps += 1;
          }
          bindTrail(trail);
        } else if (uniforms.uTrailEnabled.value !== 0) {
          uniforms.uTrailEnabled.value = 0;
        }
      }

      // Placement, residency, teleport re-scatter and buffer uploads: all the
      // pool's job (plan §3.1 "Placement (CPU, amortised)"), once per ring.
      for (let k = 0; k < rings.length; k += 1) rings[k].pool.update(dt, p.x, p.y, p.z);
    },

    dispose() {
      for (const r of rings) {
        try { r.pool.dispose(); } catch (_) { /* fail-soft */ }
        if (r.geometry) { try { r.geometry.dispose(); } catch (_) {} }
        if (r.material && r.material !== opts.material) { try { r.material.dispose(); } catch (_) {} }
      }
      rings = [];
      if (group && group.parent) { try { group.parent.remove(group); } catch (_) {} }
      group = null;
      built = false;
      lastCtx = null;
    },

    /**
     * 2026-10-12 — retune the GRASS LOD look live (no rebuild, no recompile):
     * `{ blend, soft, widthExp, heightGain }`, any subset. Counts and ring radii
     * are fixed at build (`?terrainGrassReach` / `?terrainGrassNearShare`).
     * Returns the look now in force.
     */
    setLodLook(look = {}) {
      lodLook = resolveGrassLodLook({ ...lodLook, ...look });
      applyGrassLodLook(layout, lodLook);
      for (const r of rings) writeRingLook(r);
      return { ...lodLook };
    },

    /** Diagnostics — `window.__terrainGrass.stats()`. */
    stats() {
      const pool = rings.length ? rings[0].pool : null;
      const ps = pool ? pool.stats() : null;
      let live = 0, total = 0, roadRejects = 0, excludeRejects = 0;
      const levels = rings.map((r) => {
        const st = r.pool.stats();
        live += st.live;
        total += st.count;
        roadRejects += st.roadRejects;
        excludeRejects += st.excludeRejects;
        return {
          level: r.ring.level, radiusM: st.radiusM, cellSizeM: +st.cellSizeM.toFixed(4),
          count: st.count, live: st.live, band: r.ring.band.slice(),
          heightMul: +r.ring.heightMul.toFixed(3), widthMul: +r.ring.widthMul.toFixed(3),
          edgePending: st.edgePending, rescatters: st.rescatters,
        };
      });
      return {
        id: provider.id,
        enabled: terrainGrassEnabled(),
        built,
        config: cfg,
        // THE live-check field (plan §3.1): non-zero means blades actually
        // landed on grass terrain in front of the player.
        visibleBlades: live,
        blades: total,
        // 2026-10-07 — the live gate (setOffRoad may have flipped it) and how
        // many blade placements the road has refused so far.
        offRoad: ps ? ps.offRoad : !!(cfg && cfg.offRoad),
        roadRejects,
        // 2026-10-08 — blades refused inside building interiors, and the mask.
        indoorRejects: excludeRejects,
        indoorCull: indoorMask ? indoorMask.stats() : null,
        degenerate: total - live,
        // Ring 0's radius (what it always reported); the reach is the last ring's.
        radiusM: ps ? ps.radiusM : (layout.length ? layout[0].radiusM : 0),
        // 2026-10-12 — GRASS LOD: the ring layout and the live look.
        reachM: layout.length ? layout[layout.length - 1].radiusM : 0,
        lodLook: { ...lodLook },
        levels,
        stomp: !!(cfg && cfg.stomp),
        trailBound,
        stamps,
        windAmp: uniforms.uGrassWindAmp.value,
        windDirDeg: treeWindDir(),
        hasMesh: rings.length > 0 && rings.every((r) => !!r.pool.mesh),
        buildError: buildError ? String(buildError.message || buildError) : null,
        pool: ps,
      };
    },

    // Test seams. Read-only by convention.
    _uniforms: uniforms,
    get _pool() { return rings.length ? rings[0].pool : null; },
    get _pools() { return rings.map((r) => r.pool); },
    get _material() { return rings.length ? rings[0].material : null; },
    get _materials() { return rings.map((r) => r.material); },
    get _ringUniforms() { return rings.map((r) => r.uniforms); },
    get _layout() { return layout; },
    get _group() { return group; },
  };
  return provider;
}

// ---------------------------------------------------------------------------
// Registration.
// ---------------------------------------------------------------------------

let _handle = null;

/**
 * Gate + register the grass provider. Called once from `scene3d/index.js` right
 * after the terrain-VFX spine is constructed.
 *
 * Returns null — registering NOTHING — when the flag is off or wireframe is
 * active, so a bare-default boot never registers a provider, never triggers the
 * spine's on-demand oracle import and is byte-identical (plan §6 item 3).
 *
 * @returns {object|null} `window.__terrainGrass`
 */
export function initTerrainGrass(opts = {}) {
  if (_handle) return _handle;
  if (terrainGrassEnabled() !== true) return null;
  if (wireframeActive(opts.search)) return null;   // plan §8 risk 8

  const provider = createTerrainGrassProvider(opts);
  if (provider.quality() === null) {
    // The `low` tier ships `terrainGrassBlades: 0`, i.e. disabled (plan §5.8),
    // and `?terrainGrassDensity=0` does the same. Say so ONCE: "I turned the
    // flag on and nothing happened" is exactly the silence gfx_relief.js:137
    // argues against, and the fix is a one-line URL.
    // eslint-disable-next-line no-console
    console.warn(
      "[terrainGrass] ?terrainGrass=on but the resolved blade count is 0 "
      + "(quality=low ships terrainGrassBlades: 0, and terrainGrassDensity=0 also disables). "
      + "Raise it with ?terrainGrassBlades=N or use ?quality=mid or higher.",
    );
    return null;
  }
  const reg = registerTerrainVfx(provider);
  _handle = {
    provider,
    stats: () => provider.stats(),
    get pool() { return provider._pool; },
    get uniforms() { return provider._uniforms; },
    /** 2026-10-07 — live A/B of `?grassOffRoad` without a reload; the field
     *  converges over the next amortised laps. Returns the new state (or null
     *  before the pool exists). */
    setOffRoad: (on) => {
      const pools = provider._pools;
      if (!pools.length) return null;
      let state = null;
      for (const pool of pools) state = pool.setOffRoad(on === true);
      return state;
    },
    /** 2026-10-12 — GRASS LOD look, live: `{ blend, soft, widthExp, heightGain }`. */
    setLod: (look) => provider.setLodLook(look),
    unregister: () => { reg.unregister(); _handle = null; },
  };
  try {
    if (typeof window !== "undefined") window.__terrainGrass = _handle;
  } catch (_) { /* fail-soft */ }
  return _handle;
}

/** The handle, or null when grass never registered. */
export function terrainGrassHandle() { return _handle; }

/** Test seam — drop the registration so a suite can re-init. */
export function _resetTerrainGrass() {
  if (_handle) { try { _handle.unregister(); } catch (_) {} }
  _handle = null;
}
