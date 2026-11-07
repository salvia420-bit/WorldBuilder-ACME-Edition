// scene3d/world_terrain.js — the WORLD TIER (T2): all of Dereth, and ocean to the horizon, for flight
// (`?worldTier`, docs/flight-experience-2026-11-01 Phase 4).
//
// WHY. The near ring (≈ 1 km) and the far composite ring (≈ 1.5 km) are the whole drawn world, and the range
// fog closes before their edge. From an aircraft at 80 m the world ends in white fog 1.5 km away; from 4.5 km up
// every ground pixel is farther than that, so the ground is pure fog. Neither ring can scale (per-landblock
// fetches, a 1.3 MiB render target per far patch). The world tier is a separate, tiny, fully resident
// representation of the WHOLE map:
//   * DATA — two 2041² vertex grids baked once from the base DATs (`holtburger-dat` example
//     `bake_world_terrain`: the LandHeightTable index and the terrain type + road of every terrain vertex) plus a
//     255² per-landblock tall-tree density (lane B's retail scenery census), served as the `dist/world/` layer
//     (~8.5 MB). Loaded lazily, the first time the tier is wanted.
//   * GEOMETRY — CDLOD: a quadtree from 768 m leaves (32 × 24 m cells = exactly the terrain vertex grid) up to a
//     196 km root centred on the map (the ocean beyond the edge is part of it, at sea level), selected per frame
//     by 3D distance, drawn as ONE instanced 33×33 grid; vertices morph to the parent grid before a level
//     boundary, so there are no pops and no cracks, and altitude coarsens the ground below for free.
//   * SHADING — the near ring's OWN terrain atlas (`uAtlas`, one layer per terrain code, the same per-code
//     tiling) sampled per cell corner and blended like the monolith, through the SAME lighting / fog tail
//     (terrain_shared_glsl.js) as both rings: mips give real texture detail at 1-3 km and the true mean colour
//     at 30 km. Plus what reads from the air: a sun glint on water, and a canopy tint where retail places
//     forests.
//   * HANDOFF — the tier draws only where the near ring does not: per landblock through the presence field
//     (lb_presence.js: G = near ring drawn), keeping a 10 m band under a near landblock only along the edges
//     where the near ring ends (LB_HANDOFF_GLSL, `?lbBand`), and a larger depth push than the far ring's.
//     ⚠ The push does not beat the near ring's 1 cm retail lowering below ~470 m of camera height (it is
//     relative: 2.1e-5 of the distance), so wherever this tier overlaps the near ring it WINS — the reason the
//     band is kept off the near ring's interior edges. ⚠ There is no "far patch drawn" channel (the field is
//     RG): the tier still draws under the far ring's patches (the far ring wins where the surfaces coincide;
//     this tier's alternating cell diagonal pokes through where it is higher — 7.8 % of the cells near
//     Holtburg, 1-11 m).
//
// RULES IT KEEPS: one program, no per-instance program key, no light-count change, opaque + depthWrite (every
// depth consumer — aerial perspective, cloud march, soft particles — must see it as WORLD, not sky), never
// touches statics / buildings / the LRU / per-landblock materials (the far ring's radius-policy rule).
// `?worldTier` absent: nothing is created, fetched or compiled.

import * as THREE from "three";
import { TERRAIN_SHARED_TAIL_GLSL } from "./terrain_shared_glsl.js";
import { radialFogTerrainGlsl } from "./radial_fog.js";
import { REVERSED_BIAS_NOMINAL_FAR } from "./shader_logdepth.js";
import { lbFadeUniforms, lbFadeOn, lbBandDefines, LB_HANDOFF_GLSL } from "./lb_presence.js";
import { rlogSetWorldTierProbe } from "./residency_log.js";
import { flightViewFlag } from "./flight_view_flag.js";
import { withLogDepth } from "./shader_logdepth.js";

export const WORLD_VERTS = 2041;              // 255 landblocks × 8 cells + 1
export const CELL_M = 24;
export const WORLD_M = (WORLD_VERTS - 1) * CELL_M; // 48,960 m
export const DERETH_Y_MAX = 48960.0;
export const OCEAN_Y_MIN = 48960.0;
export const OCEAN_Y_MAX = 68928.0;
export const DERICOST_Y_MIN = 68928.0;
export const DERICOST_Y_MAX = 117888.0;
const GRID = 32;                              // quads per node edge
const LEAF_M = GRID * CELL_M;                 // 768 m
const LEVELS = 9;                             // 768 m … 196,608 m
const ROOT_M = LEAF_M * (1 << (LEVELS - 1));  // 196,608 m
const ROOT_ORIGIN = -96 * LEAF_M;             // −73,728 m: the root grid aligns to 768 m and covers the map + ocean
const MAX_NODES = 2048;
const WATER_MIN = 16, WATER_MAX = 20;         // AC terrain codes 16..20 are water

/** `?worldTier` — DEV opt-in until the 1070 eye test: on / 1 / true / yes → ON. */
export function worldTierEnabled(search) {
  try {
    const s = search !== undefined ? search : (globalThis.location?.search || "");
    const ps = new URLSearchParams(s);
    const v = (ps.get("worldTier") || "").trim().toLowerCase();
    if (v === "on" || v === "1" || v === "true" || v === "yes") return true;
    if (v === "off" || v === "0" || v === "false" || v === "no") return false;
    // ?flightView (altitude_policy.js, default ON) drives the tier: it implies it
    return flightViewFlag(s);
  } catch (_) {
    return false;
  }
}

/** `?worldTierRange0=M` — the level-0 LOD range in metres (default 1,536 = 2 leaves). */
function range0M() {
  try {
    const v = Number(new URLSearchParams(globalThis.location?.search || "").get("worldTierRange0"));
    if (Number.isFinite(v) && v >= 800 && v <= 6000) return v;
  } catch (_) { /* default */ }
  return 1536;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested: tests/world_terrain.test.mjs)
// ---------------------------------------------------------------------------

/** LOD range of a level (metres): a level-k node is drawn only where the camera is farther than R(k−1). */
export function levelRange(level, r0 = 1536) { return r0 * Math.pow(2, level); }

/**
 * CDLOD selection over the fixed root. `cam` = AC metres {x, y, z}; `visible(x0, y0, size)` an optional frustum
 * test. Returns [{x0, y0, size, level}] (finest first is not required). A node is refined when the camera is
 * within the range of the level below it (3D distance to the node's AABB, heights in [hMin, hMax]).
 */
export function selectNodes(cam, { r0 = 1536, hMin = 0, hMax = 700, visible = null, max = MAX_NODES } = {}) {
  const out = [];
  const stack = [[ROOT_ORIGIN, ROOT_ORIGIN, ROOT_M, LEVELS - 1]];
  while (stack.length && out.length < max) {
    const [x0, y0, size, level] = stack.pop();
    if (visible && !visible(x0, y0, size)) continue;
    const dx = Math.max(x0 - cam.x, 0, cam.x - (x0 + size));
    const dy = Math.max(y0 - cam.y, 0, cam.y - (y0 + size));
    const dz = Math.max(hMin - cam.z, 0, cam.z - hMax);
    const d = Math.hypot(dx, dy, dz);
    if (level === 0 || d > levelRange(level - 1, r0)) {
      out.push({ x0, y0, size, level });
      continue;
    }
    const h = size / 2;
    stack.push([x0, y0, h, level - 1], [x0 + h, y0, h, level - 1], [x0, y0 + h, h, level - 1], [x0 + h, y0 + h, h, level - 1]);
  }
  return out;
}

/** CPU height (metres) at AC (x, y): bilinear over the vertex grid; off-map = sea level (table[0]). */
export function heightAtGrid(hIdx, table, x, y) {
  if (!hIdx || !table) return null;
  const gx = x / CELL_M, gy = y / CELL_M;
  if (gx < 0 || gy < 0 || gx > WORLD_VERTS - 1 || gy > WORLD_VERTS - 1) return table[0] ?? 0;
  const ix = Math.min(WORLD_VERTS - 2, Math.floor(gx)), iy = Math.min(WORLD_VERTS - 2, Math.floor(gy));
  const fx = gx - ix, fy = gy - iy;
  const h = (cx, cy) => table[hIdx[cy * WORLD_VERTS + cx]] ?? 0;
  const a = h(ix, iy), b = h(ix + 1, iy), c = h(ix, iy + 1), d = h(ix + 1, iy + 1);
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------
export const WORLD_VERTEX_GLSL = /* glsl */ `
precision highp float;
precision highp int;
precision highp usampler2D;

in vec4 aNode;                      // (x0, y0, size, level) of this instance's node, AC metres
uniform usampler2D uHeightIdx;      // R8UI 2041x2041: LandHeightTable index per terrain vertex
uniform usampler2D uHeightIdxDericost; // R8UI 2041x2041: LandHeightTable index per terrain vertex (Dericost)
uniform float uHeightTable[256];
uniform vec3 uCamAc;                // camera, AC metres
uniform float uRange0;              // LOD range of level 0, metres

out vec2 vWorldXy;
out float vWorldZ;
out vec3 vAcNormal;
out float vViewDepth;
out float vMorph;

#if defined( USE_LOGARITHMIC_DEPTH_BUFFER ) || defined( USE_LOGDEPTHBUF )
out float vFragDepth;
out float vIsPerspective;
#endif
#ifdef USE_REVERSED_DEPTH_BUFFER
uniform float uWorldDepthBias;
#endif

float hbVertH(ivec2 v) {
  if (v.x < 0 || v.y < 0 || v.x > 2040 || v.y > 2040) return uHeightTable[0];
  return uHeightTable[int(texelFetch(uHeightIdx, v, 0).r)];
}
float hbVertHDericost(ivec2 v) {
  if (v.x < 0 || v.y < 0 || v.x > 2040 || v.y > 2040) return uHeightTable[0];
  return uHeightTable[int(texelFetch(uHeightIdxDericost, v, 0).r)];
}
// bilinear over the vertex grid (exact at vertices; morphing vertices sit between two)
float hbHeightAt(vec2 xy) {
  if (xy.x < 0.0 || xy.x > 48960.0) return uHeightTable[0];
  if (xy.y >= 0.0 && xy.y <= 48960.0) {
    vec2 g = xy / 24.0;
    vec2 gf = floor(g);
    ivec2 i = ivec2(gf);
    vec2 f = g - gf;
    float a = hbVertH(i), b = hbVertH(i + ivec2(1, 0)), c = hbVertH(i + ivec2(0, 1)), d = hbVertH(i + ivec2(1, 1));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  // Ocean transit corridor (48960 < xy.y < 68928): sea level 0.0 m (uHeightTable[0])
  if (xy.y > 48960.0 && xy.y < 68928.0) return uHeightTable[0];
  // Dericost continent (68928 <= xy.y <= 117888)
  if (xy.y >= 68928.0 && xy.y <= 117888.0) {
    vec2 g = vec2(xy.x, xy.y - 68928.0) / 24.0;
    vec2 gf = floor(g);
    ivec2 i = ivec2(gf);
    vec2 f = g - gf;
    float a = hbVertHDericost(i), b = hbVertHDericost(i + ivec2(1, 0)), c = hbVertHDericost(i + ivec2(0, 1)), d = hbVertHDericost(i + ivec2(1, 1));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  return uHeightTable[0];
}

float sampleHeight(vec2 worldPos) {
  return hbHeightAt(worldPos);
}

void main() {
  float quad = aNode.z / 32.0;
  vec2 gridPos = position.xy;                          // 0..32
  vec2 xy = aNode.xy + gridPos * quad;
  // CDLOD morph: past 3/4 of this level's range, odd vertices slide onto the parent grid
  float range = uRange0 * exp2(aNode.w);
  float h0 = hbHeightAt(xy);
  float d = distance(uCamAc, vec3(xy, h0));
  float morph = clamp((d - 0.75 * range) / (0.25 * range), 0.0, 1.0);
  vec2 odd = fract(gridPos * 0.5) * 2.0;
  xy -= odd * quad * morph;
  float h = hbHeightAt(xy);
  // normal from the node's own vertex spacing (so a coarse level is lit by its coarse surface)
  float e = max(quad, 24.0);
  float hx = hbHeightAt(xy + vec2(e, 0.0)) - hbHeightAt(xy - vec2(e, 0.0));
  float hy = hbHeightAt(xy + vec2(0.0, e)) - hbHeightAt(xy - vec2(0.0, e));
  vAcNormal = normalize(vec3(-hx, -hy, 2.0 * e));
  vWorldXy = xy;
  vWorldZ = h;
  vMorph = morph;
  vec4 mvPos = modelViewMatrix * vec4(xy, h, 1.0);
  vViewDepth = -mvPos.z;
  gl_Position = projectionMatrix * mvPos;
#if defined( USE_LOGARITHMIC_DEPTH_BUFFER ) || defined( USE_LOGDEPTHBUF )
  vFragDepth = 1.0 + gl_Position.w;
  vIsPerspective = float( projectionMatrix[2][3] == -1.0 );
#endif
#ifdef USE_REVERSED_DEPTH_BUFFER
  // pushed farther than the far ring (far_terrain.js uses the same twin), so an overlap shows the finer tier
  gl_Position.z *= exp2(-uWorldDepthBias * ${Math.log2(REVERSED_BIAS_NOMINAL_FAR + 1).toFixed(6)});
#endif
}
`;

export const WORLD_FRAGMENT_GLSL = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
precision highp usampler2D;

in vec2 vWorldXy;
in float vWorldZ;
in vec3 vAcNormal;
in float vViewDepth;
in float vMorph;

out vec4 fragColor;

#if defined( USE_LOGARITHMIC_DEPTH_BUFFER ) || defined( USE_LOGDEPTHBUF )
uniform float logDepthBufFC;
uniform float uWorldDepthBias;
in float vFragDepth;
in float vIsPerspective;
#endif

uniform usampler2D uTypes;          // R8UI 2041x2041: code (bits 0-4) | road (5-6) | no-record (7)
uniform usampler2D uTypesDericost;  // R8UI 2041x2041: Dericost terrain types
uniform sampler2DArray uAtlas;      // the near ring's terrain atlas (one layer per code 0..32)
uniform int uBaseTexTiling[33];     // the near ring's per-code tiling (texture repeats per cell)
uniform sampler2D uTrees;           // R8 255x255: tall-tree density per landblock (0..255)
uniform sampler2D uTreesDericost;   // R8 255x255: Dericost tall-tree density per landblock
uniform vec3 uCamAc;
uniform vec3 uSunDir;
uniform float uAcGouraudEnabled;
uniform vec3 uAcSunVec;
uniform vec3 uAcSunColor;
uniform vec4 uPaintLight;
uniform vec3 uAcAmbColor;
uniform float uAcAmbLevel;
uniform float uSlopeShadingEnabled;
uniform float uWaterGlint;          // 0..1
uniform float uCanopy;              // 0..1 strength of the forest tint
uniform float uTime;
uniform float uCloudShadowEnabled;
uniform sampler2DArray uCloudShadowMap;
uniform mat4 uCloudShadowMatrix0;
uniform float uCloudShadowStrength;
#ifdef HB_WORLD_PRESENCE
uniform highp sampler2D hbLbPresence;  // lb_presence.js: G = near ring drawn
uniform vec2 hbLbPresenceOrigin;
${LB_HANDOFF_GLSL}
#endif

${TERRAIN_SHARED_TAIL_GLSL}

uint hbType(ivec2 v) {
  if (v.x < 0 || v.x > 2040) return 20u | 128u;
  if (v.y >= 0 && v.y <= 2040) {
    return texelFetch(uTypes, v, 0).r;
  }
  // Ocean transit corridor: 2040 < v.y < 2872 (48960m to 68928m)
  if (v.y < 2872) {
    return 20u | 128u;
  }
  // Dericost continent: 2872 <= v.y <= 4912 (68928m to 117888m)
  if (v.y <= 4912) {
    return texelFetch(uTypesDericost, ivec2(v.x, v.y - 2872), 0).r;
  }
  return 20u | 128u;
}

vec3 hbAtlas(uint t, vec2 cellUv, vec2 gx, vec2 gy) {
  int code = int(t & 31u);
  float tiling = float(uBaseTexTiling[clamp(code, 0, 32)]);
  return textureGrad(uAtlas, vec3(fract(cellUv * tiling), float(code)), gx * tiling, gy * tiling).rgb;
}

vec3 hbCellHash3(vec2 cell, uint salt) {
  uvec3 v = uvec3(ivec2(floor(cell)), int(salt)) * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return vec3(v) * (1.0 / 4294967295.0);
}

float hbValueNoise2D(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453);
  float b = fract(sin(dot(i + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
  float c = fract(sin(dot(i + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
  float d = fract(sin(dot(i + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) - 0.5;
}

void main() {
#if defined( USE_LOGARITHMIC_DEPTH_BUFFER ) || defined( USE_LOGDEPTHBUF )
  // the log-buffer twin of the vertex stage's reversed-Z push: the near rings win ties in the hand-off band
  gl_FragDepth = min(1.0, gl_FragDepth + 2.0e-6);
#endif
#ifdef HB_WORLD_PRESENCE
  // per landblock: the near ring draws here (a 10 m band stays under it only where it ends: lb_presence.js)
  if (vWorldXy.y <= 48960.0) {
    if (hbNearCovers(vWorldXy / 192.0)) discard;
  }
#endif
  vec2 cell = vWorldXy / 24.0;
  vec2 c0 = floor(cell);
  vec2 f = cell - c0;
  ivec2 i0 = ivec2(c0);
  uint t00 = hbType(i0), t10 = hbType(i0 + ivec2(1, 0)), t01 = hbType(i0 + ivec2(0, 1)), t11 = hbType(i0 + ivec2(1, 1));
  vec2 gx = dFdx(cell), gy = dFdy(cell);
  vec3 a00 = hbAtlas(t00, f, gx, gy), a10 = hbAtlas(t10, f, gx, gy), a01 = hbAtlas(t01, f, gx, gy), a11 = hbAtlas(t11, f, gx, gy);
  vec3 albedo = mix(mix(a00, a10, f.x), mix(a01, a11, f.x), f.y);
  // roads: blend toward the road layer (code 32) by the corners that carry one
  float r00 = float((t00 >> 5u) & 3u) > 0.0 ? 1.0 : 0.0, r10 = float((t10 >> 5u) & 3u) > 0.0 ? 1.0 : 0.0;
  float r01 = float((t01 >> 5u) & 3u) > 0.0 ? 1.0 : 0.0, r11 = float((t11 >> 5u) & 3u) > 0.0 ? 1.0 : 0.0;
  float road = mix(mix(r00, r10, f.x), mix(r01, r11, f.x), f.y);
  // (a road crosses a cell diagonally through two corners, so the bilinear ridge peaks at 0.5: a low threshold
  // keeps it a continuous line instead of a row of dots at each road vertex)
  if (road > 0.0) albedo = mix(albedo, hbAtlas(32u, f, gx, gy), smoothstep(0.12, 0.45, road));
  // water weight (codes 16..20, and the ocean beyond the records)
  float w00 = float((t00 & 31u) >= 16u && (t00 & 31u) <= 20u), w10 = float((t10 & 31u) >= 16u && (t10 & 31u) <= 20u);
  float w01 = float((t01 & 31u) >= 16u && (t01 & 31u) <= 20u), w11 = float((t11 & 31u) >= 16u && (t11 & 31u) <= 20u);
  float water = mix(mix(w00, w10, f.x), mix(w01, w11, f.x), f.y);
  // canopy: retail forests read as a darker, greener ground from the air (per-landblock density, bilinear)
  float trees = 0.0;
  if (vWorldXy.y <= 48960.0) {
    trees = texture(uTrees, (vWorldXy / 192.0) / 255.0).r;
  } else if (vWorldXy.y >= 68928.0 && vWorldXy.y <= 117888.0) {
    vec2 dericostLb = vec2(vWorldXy.x, vWorldXy.y - 68928.0) / 192.0;
    trees = texture(uTreesDericost, dericostLb / 255.0).r;
    // Close-up micro-detail for ground-level Dericost rendering
    float dMicro1 = fract(sin(dot(floor(vWorldXy * 1.5), vec2(12.9898, 78.233))) * 43758.5453);
    float dMicro2 = fract(sin(dot(floor(vWorldXy * 0.25), vec2(39.346, 11.135))) * 24634.6345);
    float detailFade = 1.0 - smoothstep(40.0, 450.0, vViewDepth);
    albedo *= mix(1.0, 0.86 + 0.18 * dMicro1 + 0.10 * dMicro2, detailFade * (1.0 - water));
  }
  float canopy = uCanopy * smoothstep(0.08, 0.55, trees) * (1.0 - water);
  albedo = mix(albedo, albedo * vec3(0.42, 0.55, 0.36), canopy * 0.85);

  vec3 n = normalize(vAcNormal);
  vec3 sunDir = normalize(uSunDir);
  vec2 dWorldDx = dFdx(vWorldXy);
  vec2 dWorldDy = dFdy(vWorldXy);
  float wFoot = max(length(dWorldDx), length(dWorldDy));
  vec3 iblSpec = vec3(0.0);
  vec3 sandSparkle = vec3(0.0);
  float powderW = 0.0;
  if (vWorldXy.y >= 68928.0 && vWorldXy.y <= 117888.0 && water < 0.5) {
    uint c00 = t00 & 31u, c10 = t10 & 31u, c01 = t01 & 31u, c11 = t11 & 31u;
    float s00 = float(c00 >= 10u && c00 <= 12u), s10 = float(c10 >= 10u && c10 <= 12u);
    float s01 = float(c01 >= 10u && c01 <= 12u), s11 = float(c11 >= 10u && c11 <= 12u);
    float sandW = mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);

    float sn00 = float(c00 == 2u || c00 == 15u || c00 == 27u), sn10 = float(c10 == 2u || c10 == 15u || c10 == 27u);
    float sn01 = float(c01 == 2u || c01 == 15u || c01 == 27u), sn11 = float(c11 == 2u || c11 == 15u || c11 == 27u);
    float snowW = mix(mix(sn00, sn10, f.x), mix(sn01, sn11, f.x), f.y);

    float ic00 = float(c00 == 2u || c00 == 27u), ic10 = float(c10 == 2u || c10 == 27u);
    float ic01 = float(c01 == 2u || c01 == 27u), ic11 = float(c11 == 2u || c11 == 27u);
    float iceW = mix(mix(ic00, ic10, f.x), mix(ic01, ic11, f.x), f.y);
    powderW = clamp(snowW - iceW, 0.0, 1.0);

    float v00 = float(c00 == 25u), v10 = float(c10 == 25u);
    float v01 = float(c01 == 25u), v11 = float(c11 == 25u);
    float volcW = mix(mix(v00, v10, f.x), mix(v01, v11, f.x), f.y);

    float ob00 = float(c00 == 6u), ob10 = float(c10 == 6u);
    float ob01 = float(c01 == 6u), ob11 = float(c11 == 6u);
    float obsidianW = mix(mix(ob00, ob10, f.x), mix(ob01, ob11, f.x), f.y);

    float cl00 = float(c00 == 4u || c00 == 24u), cl10 = float(c10 == 4u || c10 == 24u);
    float cl01 = float(c01 == 4u || c01 == 24u), cl11 = float(c11 == 4u || c11 == 24u);
    float clayW = mix(mix(cl00, cl10, f.x), mix(cl01, cl11, f.x), f.y);

    // Sub-cell dune ripple & rock facet normal perturbation
    float rippleFade = 1.0 - smoothstep(120.0, 900.0, vViewDepth);
    float ripPhase = (vWorldXy.x * 0.82 + vWorldXy.y * 0.57) * 0.35 + sin(vWorldXy.x * 0.08 - vWorldXy.y * 0.06) * 1.5;
    vec2 microGrad = vec2(cos(ripPhase) * 0.28, sin(ripPhase) * 0.20) * rippleFade;
    n = normalize(vec3(n.xy - microGrad * 0.22, n.z));

    // Geological cliff stratification & exposed rock on slopes
    float slopeSteep = clamp(1.0 - n.z, 0.0, 1.0);
    float cliffWeight = smoothstep(0.035, 0.22, slopeSteep);
    uint cliffCode = (vWorldXy.y < 88000.0 && vWorldXy.x >= 24000.0) ? 13u : 0u;
    vec3 cliffTex = hbAtlas(cliffCode, f, gx, gy);
    float strata = 0.72 + 0.22 * sin(vWorldZ * 0.45 + vWorldXy.x * 0.012) + 0.14 * cos(vWorldZ * 1.45 - vWorldXy.y * 0.015);
    albedo = mix(albedo, mix(albedo, cliffTex, 0.55) * strata, cliffWeight);

    // Crisp 3D directional sun-slope relief contrast (warm sunlit windward slopes vs cool shaded leeward slip-faces)
    float slopeLight = dot(n, sunDir) - sunDir.z;
    vec3 slopeTint = slopeLight >= 0.0
      ? mix(vec3(1.0), vec3(1.26, 1.15, 0.94), clamp(slopeLight * 2.4, 0.0, 1.0))
      : mix(vec3(1.0), vec3(0.44, 0.51, 0.68), clamp(-slopeLight * 2.6, 0.0, 1.0));
    float gullyAo = 1.0 - 0.26 * smoothstep(0.06, 0.35, slopeSteep);
    albedo *= slopeTint * gullyAo;

    vec3 viewAc = normalize(vec3(vWorldXy.x, vWorldXy.y, vWorldZ) - uCamAc);
    float sunGate = smoothstep(0.05, 0.25, sunDir.z) * min(length(uAcSunVec) * 1.25, 1.0);

    // 1. LAVA CRACK GLOW (FAM_VOLCANO code 25)
    if (volcW > 0.0) {
      float crackFade = 1.0 - smoothstep(140.0, 420.0, vViewDepth);
      float crackHeat = smoothstep(0.03, 0.20, albedo.r - max(0.55 * albedo.g, albedo.b));
      float crackW = crackHeat * volcW * crackFade;
      if (crackW > 0.001) {
        float crackPhase = 6.2831853 * hbValueNoise2D(vWorldXy * 0.05) + uTime * 0.8;
        float crackPulse = 1.0 - 0.35 * (0.5 + 0.5 * sin(crackPhase));
        iblSpec += albedo * vec3(2.4, 0.65, 0.12) * (1.8 * crackW * crackPulse);
      }
    }

    // 2. SNOW CRYSTAL SPARKLE (FAM_SNOWICE codes 2, 15, 27)
    if (snowW > 0.0) {
      float snowFade = (1.0 - smoothstep(45.0, 140.0, vViewDepth)) * sunGate;
      float snowFoot = wFoot * 12.0;
      snowFade *= 1.0 - smoothstep(0.35, 0.85, snowFoot);
      if (snowFade > 0.001) {
        vec2 crystalXy = vWorldXy * 12.0;
        vec2 ccell = floor(crystalXy);
        vec3 ch = hbCellHash3(ccell, 3u);
        vec3 crystalN = normalize(vec3((ch.x - 0.5) * 2.4, (ch.y - 0.5) * 2.4, 0.45 + ch.z * 1.1));
        vec3 snowHalfAc = normalize(sunDir - viewAc);
        float snowLobe = pow(clamp(dot(crystalN, snowHalfAc), 0.0, 1.0), 90.0);
        vec2 snowC = vec2(0.25) + 0.5 * hbCellHash3(ccell, 4u).xy;
        float snowRad = max(0.22, 0.75 * max(snowFoot, 0.001));
        float snowCore = 1.0 - smoothstep(snowRad * 0.45, snowRad, length(fract(crystalXy) - snowC));
        float snowPhase = uTime * 1.1 + ch.x * 6.2831853 + ch.y * 23.0;
        float snowTwinkle = 0.3 + 0.7 * (0.5 + 0.5 * sin(snowPhase));
        iblSpec += uAcSunColor * (2.6 * snowW * snowFade * snowLobe * snowTwinkle * snowCore);
      }
    }

    // 3. ICE MATERIAL TREATMENT (codes 2, 27)
    if (iceW > 0.0) {
      vec2 iuv = vWorldXy * 1.7;
      float ih0 = hbValueNoise2D(iuv);
      float ihx = hbValueNoise2D(iuv + vec2(0.6, 0.0));
      float ihy = hbValueNoise2D(iuv + vec2(0.0, 0.6));
      vec3 iceN = normalize(vec3((ih0 - ihx) * 0.5, (ih0 - ihy) * 0.5, 1.0));
      vec3 iceHalfAc = normalize(sunDir - viewAc);
      float iceLobe = pow(clamp(dot(iceN, iceHalfAc), 0.0, 1.0), 160.0);
      float iceFres = 0.04 + 0.96 * pow(1.0 - clamp(dot(-viewAc, iceN), 0.0, 1.0), 5.0);
      vec3 iceSky = uAcAmbColor * max(uAcAmbLevel, 0.35) * vec3(0.78, 0.90, 1.12);
      iblSpec += (uAcSunColor * (iceLobe * 0.85 * sunGate) + iceSky * iceFres * 0.55) * iceW;
    }

    // 4. OBSIDIAN GLASS SHEEN + FACET GLINTS (FAM_OBSIDIAN code 6)
    if (obsidianW > 0.0) {
      float obsA = hbValueNoise2D(vWorldXy * 0.071) + 0.5;
      float obsB = hbValueNoise2D(vWorldXy * 0.31 + vec2(17.3, 4.1)) + 0.5;
      float obsC = hbValueNoise2D(vWorldXy * 0.31 + vec2(2.9, 33.7)) + 0.5;
      float obsGlassy = 0.45 + 0.55 * smoothstep(0.3, 0.72, obsA);
      vec3 obsN = normalize(n + vec3((obsB - 0.5) * 0.3, (obsC - 0.5) * 0.3, 0.0));
      float obsCos = clamp(dot(-viewAc, obsN), 0.0, 1.0);
      float obsFres = min(0.045 + 0.955 * pow(1.0 - obsCos, 5.0), 0.6);
      float obsSheenFade = 1.0 - 0.6 * smoothstep(80.0, 260.0, vViewDepth);
      iblSpec += (uAcAmbColor * max(uAcAmbLevel, 0.35)) * vec3(0.45, 0.26, 0.62)
               * (0.95 * obsFres * obsGlassy * obsSheenFade * obsidianW);
      float obsFade = (1.0 - smoothstep(40.0, 130.0, vViewDepth)) * sunGate;
      float obsFoot = wFoot * 8.0;
      obsFade *= 1.0 - smoothstep(0.4, 0.9, obsFoot);
      if (obsFade > 0.001) {
        vec2 facetXy = vWorldXy * 8.0;
        vec2 fcell = floor(facetXy);
        vec3 fh = hbCellHash3(fcell, 5u);
        if (hbCellHash3(fcell, 6u).x < 0.28) {
          vec3 facetN = normalize(n * (0.6 + 0.8 * fh.z) + vec3((fh.x - 0.5) * 2.0, (fh.y - 0.5) * 2.0, 0.0));
          vec3 obsHalf = normalize(sunDir - viewAc);
          float obsLobe = pow(clamp(dot(facetN, obsHalf), 0.0, 1.0), 110.0);
          vec2 obsCtr = vec2(0.25) + 0.5 * hbCellHash3(fcell, 7u).xy;
          float obsRad = max(0.22, 0.75 * max(obsFoot, 0.001));
          float obsCore = 1.0 - smoothstep(obsRad * 0.45, obsRad, length(fract(facetXy) - obsCtr));
          iblSpec += uAcSunColor * (2.4 * obsidianW * obsFade * obsLobe * obsCore);
        }
      }
    }

    // 5. WET MUD & MARSH CLAY SHEEN (FAM_SWAMP code 4, FAM_DIRT code 24)
    if (clayW > 0.0) {
      float mudWetUp = smoothstep(0.05, 0.6, n.z);
      float mudWetAmt = 0.65 * mudWetUp * clayW * (1.0 - smoothstep(80.0, 320.0, vViewDepth));
      albedo *= mix(vec3(1.0), vec3(0.62, 0.58, 0.54), mudWetAmt);
      vec2 muv = vWorldXy * 2.6;
      float mh0 = hbValueNoise2D(muv);
      float mhx = hbValueNoise2D(muv + vec2(0.55, 0.0));
      float mhy = hbValueNoise2D(muv + vec2(0.0, 0.55));
      vec3 mudN = normalize(vec3((mh0 - mhx) * 0.35, (mh0 - mhy) * 0.35, 1.0));
      vec3 mudHalfAc = normalize(sunDir - viewAc);
      float mudLobe = pow(clamp(dot(mudN, mudHalfAc), 0.0, 1.0), 95.0);
      float mudFres = 0.04 + 0.96 * pow(1.0 - clamp(dot(-viewAc, mudN), 0.0, 1.0), 5.0);
      iblSpec += (uAcSunColor * (mudLobe * 0.55 * sunGate) + uAcAmbColor * uAcAmbLevel * mudFres * 0.35) * mudWetAmt;
    }

    // 6. SAND GRAIN SPARKLE (FAM_SAND codes 10, 11, 12)
    if (sandW > 0.0) {
      float sparkFade = 1.0 - smoothstep(35.0, 110.0, vViewDepth);
      if (sparkFade > 0.001) {
        float graze = 1.0 - clamp(dot(n, -viewAc), 0.0, 1.0);
        graze = 0.35 + 0.65 * graze * graze;
        vec2 grainXy = vWorldXy * 16.0;
        vec2 gcell = floor(grainXy);
        vec3 gh = hbCellHash3(gcell, 1u);
        float gpp = max(wFoot * 16.0, 0.001);
        float cellsPerPx = max(gpp, 1.0);
        if (gh.z < min(1.0, 0.18 * cellsPerPx)) {
          vec3 grainN = normalize(n + vec3((gh.x - 0.5) * 2.2, (gh.y - 0.5) * 2.2, 0.0));
          vec3 halfAc = normalize(sunDir - viewAc);
          float lobe = pow(clamp(dot(grainN, halfAc), 0.0, 1.0), 80.0);
          vec2 gpt = vec2(hbCellHash3(gcell, 2u).x, gh.x) * 0.5 + 0.25;
          float gRad = max(0.22, 0.75 * gpp);
          float gDot = 1.0 - smoothstep(gRad * 0.45, gRad, length(fract(grainXy) - gpt));
          float phase = uTime * 1.7 + gh.x * 6.2831853 + gh.y * 17.0;
          float twinkle = 0.5 + 0.5 * sin(phase);
          twinkle = 0.25 + 0.75 * twinkle * twinkle;
          sandSparkle = uAcSunColor * (2.8 * sandW * graze * sunGate * sparkFade * lobe * twinkle * gDot / cellsPerPx);
        }
      }
    }
  }
  bool acGouraud = uAcGouraudEnabled > 0.5 && dot(uAcSunVec, uAcSunVec) > 1.0e-4;
  if (acGouraud) {
    albedo = terrainAcGouraud(albedo, n, uAcSunVec, uAcSunColor, uAcAmbColor, uAcAmbLevel);
  }
  if (powderW > 0.0) {
    vec3 snowRef = min(vec3(1.0), uAcSunColor * max(uAcSunVec.z, 0.0) + uAcAmbColor * uAcAmbLevel);
    float snowDay = dot(snowRef, vec3(0.2126, 0.7152, 0.0722));
    float snowExpo = mix(1.0, 0.65, smoothstep(0.25, 0.6, snowDay));
    albedo *= mix(1.0, snowExpo, powderW);
  }
  albedo = terrainPaintLight(albedo, n, sunDir, vViewDepth, uPaintLight);
  float ndotl = 1.0;
  if (uSlopeShadingEnabled > 0.5 && !acGouraud) ndotl = terrainSunNdotl(n, sunDir);
  float cloudShadow = 1.0;
  if (uCloudShadowEnabled > 0.5) {
    vec3 worldPos3 = vec3(vWorldXy.x, vWorldZ, -vWorldXy.y);
    vec4 csClip = uCloudShadowMatrix0 * vec4(worldPos3, 1.0);
    vec2 csUv = (csClip.xy / csClip.w) * 0.5 + 0.5;
    vec2 csEdge = smoothstep(vec2(0.0), vec2(0.08), csUv)
                * smoothstep(vec2(0.0), vec2(0.08), vec2(1.0) - csUv);
    float csInBounds = csEdge.x * csEdge.y;
    if (csInBounds > 0.001) {
      vec4 bsm = texture(uCloudShadowMap, vec3(csUv, 0.0));
      float opticalDepth = bsm.b + bsm.a;
      float shadowTrans = max(exp(-opticalDepth * uCloudShadowStrength), 0.25);
      cloudShadow = mix(1.0, shadowTrans, csInBounds);
    }
  }
  vec3 lit = terrainApplyLight(albedo, ndotl, cloudShadow, 1.0);
  lit += iblSpec + sandSparkle * cloudShadow;
  // water seen from the air: Fresnel (little reflection looking straight down, more toward the horizon), a sky
  // sheen from the fog colour (the horizon radiance) and a tight sun glint that is strongest at grazing angles
  if (water > 0.0 && uWaterGlint > 0.0) {
    vec3 hbP = vec3(vWorldXy, 0.0);
    vec3 v = normalize(uCamAc - hbP);
    float fres = 0.02 + 0.98 * pow(1.0 - clamp(v.z, 0.0, 1.0), 5.0);
#ifdef USE_FOG
    lit = mix(lit, fogColor * 0.92, water * fres * 0.65);
#endif
    vec3 r = reflect(-sunDir, vec3(0.0, 0.0, 1.0));
    float s = max(dot(r, v), 0.0);
    float glint = (0.08 * pow(s, 64.0) + 2.2 * pow(s, 900.0)) * (0.15 + fres);
    lit += water * uWaterGlint * glint * uAcSunColor * max(sunDir.z, 0.0);
  }
  fragColor = vec4(terrainApplyFog(lit, vViewDepth), 1.0);
#if defined( USE_LOGARITHMIC_DEPTH_BUFFER ) || defined( USE_LOGDEPTHBUF )
  float hbDepth = vIsPerspective == 0.0 ? gl_FragCoord.z : log2(vFragDepth) * logDepthBufFC * 0.5;
  gl_FragDepth = clamp(hbDepth + uWorldDepthBias, 0.0, 1.0);
#endif
}
`;

const WORLD_LIVE_GLSL = radialFogTerrainGlsl(WORLD_VERTEX_GLSL, WORLD_FRAGMENT_GLSL);

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
let _st = null;
let _loadPromise = null;
const _diag = { enabled: false, loaded: false, loadMs: null, error: null, nodes: 0, levels: null, active: false, frames: 0, culled: 0 };

const WORLD_BASE_URL = "../../dist/world/";

async function _fetchBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** Load the baked grids once (lazy). Resolves to the data record or throws. */
export function loadWorldData(base = WORLD_BASE_URL) {
  if (_loadPromise) return _loadPromise;
  const t0 = (typeof performance !== "undefined") ? performance.now() : Date.now();
  _loadPromise = (async () => {
    const meta = await (await fetch(`${base}world_meta.json`)).json();
    const [hIdx, types, trees, dericostPack] = await Promise.all([
      _fetchBytes(`${base}world_height.u8`),
      _fetchBytes(`${base}world_types.u8`),
      _fetchBytes(`${base}world_trees.u8`).catch(() => new Uint8Array(255 * 255)),
      Promise.all([
        _fetchBytes(`${base}dericost_height.u8`).catch(() => _fetchBytes(`../../dist/dericost/dericost_height.u8`)).catch(() => null),
        _fetchBytes(`${base}dericost_types.u8`).catch(() => _fetchBytes(`../../dist/dericost/dericost_types.u8`)).catch(() => null),
        _fetchBytes(`${base}dericost_trees.u8`).catch(() => _fetchBytes(`../../dist/dericost/dericost_trees.u8`)).catch(() => null),
      ]),
    ]);
    const [hIdxDericost, typesDericost, treesDericost] = dericostPack;
    if (hIdx.length !== WORLD_VERTS * WORLD_VERTS || types.length !== WORLD_VERTS * WORLD_VERTS) {
      throw new Error(`world grids: unexpected sizes ${hIdx.length} / ${types.length}`);
    }
    const table = new Float32Array(256);
    (meta.landHeightTable || []).forEach((v, i) => { if (i < 256) table[i] = v; });
    _diag.loaded = true;
    _diag.loadMs = Math.round(((typeof performance !== "undefined") ? performance.now() : Date.now()) - t0);
    return {
      meta, hIdx, types, trees, table,
      hIdxDericost: hIdxDericost || new Uint8Array(WORLD_VERTS * WORLD_VERTS),
      typesDericost: typesDericost || new Uint8Array(WORLD_VERTS * WORLD_VERTS),
      treesDericost: treesDericost || new Uint8Array(255 * 255),
    };
  })();
  _loadPromise.catch((e) => { _diag.error = String(e?.message ?? e); });
  return _loadPromise;
}

/** CPU ground height under any AC point once the grids are loaded (null before). */
export function worldGroundHeight(x, y) {
  const d = _st?.data;
  if (!d) return null;
  if (x < 0.0 || x > 48960.0 || y < 0.0 || y > DERICOST_Y_MAX) {
    return d.table[0] ?? 0;
  }
  if (y <= DERETH_Y_MAX) {
    return heightAtGrid(d.hIdx, d.table, x, y);
  }
  if (y >= DERICOST_Y_MIN && y <= DERICOST_Y_MAX && d.hIdxDericost) {
    return heightAtGrid(d.hIdxDericost, d.table, x, y - DERICOST_Y_MIN);
  }
  // Ocean transit corridor (48960 < y < 68928) and unbaked Dericost return sea level
  return d.table[0] ?? 0;
}

/** Sample height at any global AC coordinates (array [x, y], object {x, y}, or separate (x, y)). */
export function sampleHeight(worldPos, yCoord) {
  if (typeof worldPos === "number" && typeof yCoord === "number") {
    return worldGroundHeight(worldPos, yCoord);
  }
  const x = Array.isArray(worldPos) ? worldPos[0] : (worldPos?.x ?? 0);
  const y = Array.isArray(worldPos) ? worldPos[1] : (worldPos?.y ?? 0);
  return worldGroundHeight(x, y);
}

/**
 * Extract the 9x9 column-major `codes`, `roads`, and `heights` arrays for a Dericost landblock
 * `(lbX, dLbY)` (`lbX = 0..254`, `dLbY = 0..254`, global `lbY = 359 + dLbY`) so `terrain_vfx.js`
 * and `terrain_oracle.js` can drive all terrain VFX providers on Dericost.
 */
export function extractDericostLandblockData(lbX, dLbY) {
  const d = _st?.data;
  if (!d || !d.hIdxDericost || !d.typesDericost || !d.table) return null;
  if (lbX < 0 || lbX > 254 || dLbY < 0 || dLbY > 254) return null;
  const codes = new Uint8Array(81);
  const roads = new Uint8Array(81);
  const heights = new Float32Array(81);
  for (let col = 0; col <= 8; col += 1) {
    const cx = lbX * 8 + col;
    for (let row = 0; row <= 8; row += 1) {
      const cy = dLbY * 8 + row;
      const gIdx = cy * WORLD_VERTS + cx;
      const t = d.typesDericost[gIdx] ?? 0;
      const idx = col * 9 + row;
      codes[idx] = t & 0x1f;
      roads[idx] = (t >> 5) & 0x3;
      heights[idx] = d.table[d.hIdxDericost[gIdx]] ?? 0;
    }
  }
  return { lbX, lbY: 359 + dLbY, codes, roads, heights };
}

function _makeGridGeometry() {
  const g = new THREE.InstancedBufferGeometry();
  const verts = (GRID + 1) * (GRID + 1);
  const pos = new Float32Array(verts * 3);
  let p = 0;
  for (let y = 0; y <= GRID; y += 1) for (let x = 0; x <= GRID; x += 1) { pos[p++] = x; pos[p++] = y; pos[p++] = 0; }
  const idx = [];
  for (let y = 0; y < GRID; y += 1) {
    for (let x = 0; x < GRID; x += 1) {
      const a = y * (GRID + 1) + x, b = a + 1, c = a + (GRID + 1), d = c + 1;
      // alternate the diagonal per quad so a regular grid does not bias the silhouette one way
      if ((x + y) & 1) idx.push(a, b, d, a, d, c); else idx.push(a, b, c, b, d, c);
    }
  }
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  const nodeAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_NODES * 4), 4);
  nodeAttr.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute("aNode", nodeAttr);
  g.instanceCount = 0;
  // never frustum-culled as a whole (per-node culling happens in the selection)
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(WORLD_M / 2, WORLD_M / 2, 0), ROOT_M * 2);
  return g;
}

function _makeMaterial(scene3d, data) {
  const hTex = new THREE.DataTexture(data.hIdx, WORLD_VERTS, WORLD_VERTS, THREE.RedIntegerFormat, THREE.UnsignedByteType);
  hTex.internalFormat = "R8UI";
  const tTex = new THREE.DataTexture(data.types, WORLD_VERTS, WORLD_VERTS, THREE.RedIntegerFormat, THREE.UnsignedByteType);
  tTex.internalFormat = "R8UI";
  const hDericostTex = new THREE.DataTexture(data.hIdxDericost || new Uint8Array(WORLD_VERTS * WORLD_VERTS), WORLD_VERTS, WORLD_VERTS, THREE.RedIntegerFormat, THREE.UnsignedByteType);
  hDericostTex.internalFormat = "R8UI";
  const tDericostTex = new THREE.DataTexture(data.typesDericost || new Uint8Array(WORLD_VERTS * WORLD_VERTS), WORLD_VERTS, WORLD_VERTS, THREE.RedIntegerFormat, THREE.UnsignedByteType);
  tDericostTex.internalFormat = "R8UI";
  for (const t of [hTex, tTex, hDericostTex, tDericostTex]) {
    t.minFilter = THREE.NearestFilter; t.magFilter = THREE.NearestFilter;
    t.generateMipmaps = false; t.flipY = false; t.unpackAlignment = 1; t.needsUpdate = true;
  }
  const treeTex = new THREE.DataTexture(data.trees, 255, 255, THREE.RedFormat, THREE.UnsignedByteType);
  treeTex.minFilter = THREE.LinearFilter; treeTex.magFilter = THREE.LinearFilter;
  treeTex.generateMipmaps = false; treeTex.flipY = false; treeTex.unpackAlignment = 1; treeTex.needsUpdate = true;
  const treeDericostTex = new THREE.DataTexture(data.treesDericost || new Uint8Array(255 * 255), 255, 255, THREE.RedFormat, THREE.UnsignedByteType);
  treeDericostTex.minFilter = THREE.LinearFilter; treeDericostTex.magFilter = THREE.LinearFilter;
  treeDericostTex.generateMipmaps = false; treeDericostTex.flipY = false; treeDericostTex.unpackAlignment = 1; treeDericostTex.needsUpdate = true;
  const src = Array.isArray(scene3d?.terrainMaterials)
    ? scene3d.terrainMaterials.find((m) => m && m.uniforms && m.uniforms.uAtlas && m.uniforms.uBaseTexTiling)
    : null;
  const tiling = src?.uniforms?.uBaseTexTiling?.value ?? new Array(33).fill(1);
  const dummyShadowArr = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1);
  dummyShadowArr.format = THREE.RGBAFormat;
  dummyShadowArr.type = THREE.UnsignedByteType;
  dummyShadowArr.needsUpdate = true;
  const mat = new THREE.ShaderMaterial(withLogDepth({
    uniforms: {
      uHeightIdx: { value: hTex },
      uHeightIdxDericost: { value: hDericostTex },
      uHeightTable: { value: Array.from(data.table) },
      uTypes: { value: tTex },
      uTypesDericost: { value: tDericostTex },
      uAtlas: { value: src?.uniforms?.uAtlas?.value ?? null },
      uBaseTexTiling: { value: tiling },
      uTrees: { value: treeTex },
      uTreesDericost: { value: treeDericostTex },
      uCamAc: { value: new THREE.Vector3() },
      uRange0: { value: range0M() },
      uSunDir: { value: new THREE.Vector3(-0.4, -0.3, 1.0).normalize() },
      uAcGouraudEnabled: { value: 0.0 },
      uAcSunVec: { value: new THREE.Vector3(0, 0, 0) },
      uAcSunColor: { value: new THREE.Color(1, 1, 1) },
      uPaintLight: { value: new THREE.Vector4(0, 60, 300, 0) },
      uAcAmbColor: { value: new THREE.Color(1, 1, 1) },
      uAcAmbLevel: { value: 0.2 },
      uSlopeShadingEnabled: { value: 1.0 },
      uWaterGlint: { value: 1.0 },
      uCanopy: { value: 1.0 },
      uTime: { value: 0.0 },
      uCloudShadowEnabled: { value: 0.0 },
      uCloudShadowMap: { value: dummyShadowArr },
      uCloudShadowMatrix0: { value: new THREE.Matrix4() },
      uCloudShadowStrength: { value: 2.0 },
      uWorldDepthBias: { value: 2.5e-6 },
      fogColor: { value: new THREE.Color(0xc3c8dc) },
      fogNear: { value: 150 },
      fogFar: { value: 2400 },
      fogDensity: { value: 0.00025 },
    },
    vertexShader: WORLD_LIVE_GLSL.vertex,
    fragmentShader: WORLD_LIVE_GLSL.fragment,
    glslVersion: THREE.GLSL3,
    side: THREE.FrontSide,
    transparent: false,
    depthWrite: true,
    depthTest: true,
    fog: true,
  }));
  if (lbFadeOn()) {
    const pu = lbFadeUniforms(THREE);
    if (pu) {
      mat.defines = { ...(mat.defines || {}), HB_WORLD_PRESENCE: "", ...lbBandDefines() };
      mat.uniforms.hbLbPresence = pu.hbLbPresence;
      mat.uniforms.hbLbPresenceOrigin = pu.hbLbPresenceOrigin;
    }
  }
  mat.name = "world-terrain";
  return { mat, hTex, tTex, treeTex, hDericostTex, tDericostTex, treeDericostTex };
}

/** Create the tier (lazy data). Safe to call more than once; a no-op without `?worldTier`. */
export function initWorldTerrain(scene3d, { parent = null } = {}) {
  if (!worldTierEnabled()) return null;
  _diag.enabled = true;
  if (_st) return _st;
  const group = new THREE.Group();
  group.name = "world-terrain";
  group.userData.__punchPhase = 0;
  (parent ?? scene3d.terrainGroup?.parent ?? scene3d.terrainGroup).add(group);
  _st = { group, mesh: null, data: null, mats: null, geo: null, wanted: false, frustum: new THREE.Frustum(), m4: new THREE.Matrix4(), box: new THREE.Box3() };
  if (typeof window !== "undefined") window.__worldTerrain = () => worldTerrainDiag();
  // ?residencyLog: wherever the tier is drawing, every landblock has ground (it discards only under the rings)
  rlogSetWorldTierProbe(() => !!(_st && _st.mesh && _st.mesh.visible));
  return _st;
}

/** Ask for the tier (first call starts the download); `false` hides it again. */
export function setWorldTierWanted(scene3d, wanted) {
  const st = _st || initWorldTerrain(scene3d);
  if (!st) return;
  st.wanted = !!wanted;
  if (st.wanted && !st.data && !st.loading) {
    st.loading = true;
    loadWorldData().then((data) => { st.data = data; }).catch((e) => {
      // eslint-disable-next-line no-console
      console.warn("[world_terrain] world grids unavailable (dist/world/ missing?) — the tier stays off:", e?.message ?? e);
    });
  }
}

/** Copy the live lighting uniforms from a near-ring terrain material (the far ring does the same). */
function _copyLighting(scene3d, u) {
  const tsSec = scene3d?.frameTime?.tsSec;
  if (Number.isFinite(tsSec) && u.uTime) {
    u.uTime.value = tsSec % 3600;
  } else if (u.uTime && typeof performance !== "undefined") {
    u.uTime.value = (performance.now() * 0.001) % 3600;
  }
  const vol = scene3d?.cloudOverlay?.volume;
  const cp = vol?.effect?.cloudsPass;
  const shadowTex = cp?.shadowBuffer;
  const shadowMats = vol?.material?.uniforms?.shadowMatrices?.value;
  if (shadowTex && shadowMats && shadowMats[0] && !scene3d?.__cloudShadowDisabled) {
    u.uCloudShadowEnabled.value = 1.0;
    u.uCloudShadowMap.value = shadowTex;
    u.uCloudShadowMatrix0.value.copy(shadowMats[0]);
    if (Number.isFinite(scene3d.__cloudShadowStrength)) {
      u.uCloudShadowStrength.value = scene3d.__cloudShadowStrength;
    }
  } else if (scene3d?.__cloudShadowDisabled) {
    u.uCloudShadowEnabled.value = 0.0;
  }
  const src = Array.isArray(scene3d?.terrainMaterials)
    ? scene3d.terrainMaterials.find((m) => m && m.uniforms && m.uniforms.uSunDir)
    : null;
  if (!src) return;
  const s = src.uniforms;
  if (s.uSunDir && s.uSunDir.value.lengthSq() > 1e-4) u.uSunDir.value.copy(s.uSunDir.value);
  const hasLiveGouraud = s.uAcSunVec && s.uAcSunVec.value && s.uAcSunVec.value.lengthSq() > 1e-4;
  if (hasLiveGouraud) {
    if (s.uAcGouraudEnabled) u.uAcGouraudEnabled.value = s.uAcGouraudEnabled.value;
    u.uAcSunVec.value.copy(s.uAcSunVec.value);
    if (s.uAcSunColor) u.uAcSunColor.value.copy(s.uAcSunColor.value);
    if (s.uAcAmbColor) u.uAcAmbColor.value.copy(s.uAcAmbColor.value);
    if (s.uAcAmbLevel) u.uAcAmbLevel.value = s.uAcAmbLevel.value;
  }
  if (s.uPaintLight && u.uPaintLight && s.uPaintLight.value.x > 0) u.uPaintLight.value.copy(s.uPaintLight.value);
  if (s.uTerrainSlopeShadingEnabled) u.uSlopeShadingEnabled.value = s.uTerrainSlopeShadingEnabled.value;
  if (!u.uAtlas.value && s.uAtlas) u.uAtlas.value = s.uAtlas.value;
  if (s.uBaseTexTiling) u.uBaseTexTiling.value = s.uBaseTexTiling.value;
}

/** The tier's mesh + material (hidden until wanted); the program links off the frame. */
function _buildMesh(st, scene3d, camera) {
  st.mats = _makeMaterial(scene3d, st.data);
  st.geo = _makeGridGeometry();
  st.mesh = new THREE.Mesh(st.geo, st.mats.mat);
  st.mesh.name = "world-terrain-nodes";
  st.mesh.frustumCulled = false;
  st.mesh.matrixAutoUpdate = false;
  st.mesh.visible = false;
  st.group.add(st.mesh);
  // link the program off the frame (compileAsync / KHR_parallel_shader_compile; three's compile() walks hidden
  // meshes too); drawn only once linked — a first-draw link is 0.5-1.7 s of FXC on the 1070
  st.compiled = false;
  try {
    const r = scene3d?.renderer;
    if (r && typeof r.compileAsync === "function") {
      Promise.resolve(r.compileAsync(st.mesh, camera, scene3d.scene)).then(() => { st.compiled = true; }, () => { st.compiled = true; });
    } else st.compiled = true;
  } catch (_) { st.compiled = true; }
}

/**
 * Idle prefetch (altitude_policy.js `?flightPrewarm`): load the grids, then build the mesh and link its program
 * while the tier is NOT wanted (it stays hidden), so a take-off only has to open the view. Arm K (1070, cold
 * caches): the take-off loaded 8 MB, linked the tier and the far forest and started 64 impostor bakes at once —
 * a 3 s frame starved the server of inputs past its 2.5 s and the predictor took a 34 m correction.
 */
export function prefetchWorldTier(scene3d, camera) {
  const st = _st || initWorldTerrain(scene3d);
  if (!st) return;
  if (!st.data) {
    if (!st.loading) {
      st.loading = true;
      loadWorldData().then((data) => { st.data = data; }).catch((e) => {
        // eslint-disable-next-line no-console
        console.warn("[world_terrain] prefetch: world grids unavailable — the tier stays off:", e?.message ?? e);
      });
    }
    return;
  }
  if (!st.mesh && camera) _buildMesh(st, scene3d, camera);
}

/**
 * Per-frame: select nodes for `camera` (three world), upload the instance list, refresh uniforms. Hidden while
 * not wanted or before the data arrived.
 */
export function tickWorldTerrain(scene3d, camera) {
  const st = _st;
  if (!st) return;
  _diag.active = !!(st.wanted && st.data && st.compiled !== false);
  if (!st.wanted || !st.data || !camera) {
    if (st.mesh) st.mesh.visible = false;
    return;
  }
  if (!st.mesh) _buildMesh(st, scene3d, camera);
  st.mesh.visible = st.compiled !== false;
  _diag.frames += 1;
  const u = st.mats.mat.uniforms;
  // camera in AC metres: three world (x, y, z) = AC (x, z, −y)
  const cp = camera.getWorldPosition ? camera.getWorldPosition(st._cp || (st._cp = new THREE.Vector3())) : camera.position;
  const cam = st._cam || (st._cam = { x: 0, y: 0, z: 0 });
  cam.x = cp.x; cam.y = -cp.z; cam.z = cp.y;
  u.uCamAc.value.set(cam.x, cam.y, cam.z);
  _copyLighting(scene3d, u);
  // frustum in three world; a node box is AC (x0..x0+s, y0..y0+s, 0..700) → world (x, h, −y)
  camera.updateMatrixWorld?.();
  st.m4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  st.frustum.setFromProjectionMatrix(st.m4);
  const box = st.box;
  let culled = 0;
  const visible = (x0, y0, s) => {
    box.min.set(x0, -50, -(y0 + s));
    box.max.set(x0 + s, 800, -y0);
    const ok = st.frustum.intersectsBox(box);
    if (!ok) culled += 1;
    return ok;
  };
  const nodes = selectNodes(cam, { r0: u.uRange0.value, visible });
  const attr = st.geo.getAttribute("aNode");
  const a = attr.array;
  const levels = st._levels || (st._levels = new Array(LEVELS).fill(0));
  levels.fill(0);
  let n = 0;
  for (const nd of nodes) {
    if (n >= MAX_NODES) break;
    a[n * 4] = nd.x0; a[n * 4 + 1] = nd.y0; a[n * 4 + 2] = nd.size; a[n * 4 + 3] = nd.level;
    levels[nd.level] += 1;
    n += 1;
  }
  attr.needsUpdate = true;
  attr.clearUpdateRanges?.();
  attr.addUpdateRange?.(0, n * 4);
  st.geo.instanceCount = n;
  _diag.nodes = n;
  _diag.levels = levels.slice();
  _diag.culled = culled;
}

export function worldTerrainDiag() {
  return { ..._diag, wanted: !!_st?.wanted, hasMesh: !!_st?.mesh, program: _st?.mats?.mat?.name ?? null };
}

/** Teardown (context loss / tests). */
export function disposeWorldTerrain() {
  const st = _st;
  if (!st) return;
  try {
    st.group.parent?.remove(st.group);
    st.geo?.dispose();
    st.mats?.mat?.dispose();
    st.mats?.hTex?.dispose(); st.mats?.tTex?.dispose(); st.mats?.treeTex?.dispose();
  } catch (_) { /* best effort */ }
  _st = null;
}
