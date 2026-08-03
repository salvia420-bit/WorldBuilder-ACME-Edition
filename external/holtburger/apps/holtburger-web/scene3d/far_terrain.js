// scene3d/far_terrain.js — the FAR COMPOSITE RING (FCR).
//
// ===========================================================================
// WHAT THIS IS
// ===========================================================================
// Landblocks beyond the monolith's streaming ring get their ALBEDO baked once
// into a small render target — by rendering them through the EXISTING terrain
// material with a top-down orthographic camera parked 1000 m up — and are then
// drawn as merged 4x4-LB patches with a ~40-line shader that samples that one
// texture and applies the SAME lighting tail the monolith uses
// (scene3d/terrain_shared_glsl.js).
//
// Three properties do all the work:
//
//  1. Every feature that still matters past ~260 m is albedo-space; every
//     view-dependent feature is dead by ~60 m. So an albedo bake loses nothing
//     that is visible where it is used.
//  2. The bake camera at 1000 m makes every distance ramp in the 2,100-line
//     monolith resolve to its FAR value for free (vViewDepth ~= 1000), because
//     `vViewDepth = -mvPos.z`. Detail texture off, POM not entered, macro at
//     full strength, sparkle fades to 0, trail-map UV out of range. No
//     per-feature surgery, and any ramp added in future inherits it.
//  3. Bake albedo only, light live. Nothing that moves (sun, CSM, cloud shadow,
//     IBL, night ramp, the 15 s retail light tick) can invalidate a tile.
//     Invalidation collapses to one global epoch counter bumped by flag flips.
//
// ===========================================================================
// WHAT THIS DELIBERATELY IS NOT
// ===========================================================================
//   * It does NOT touch terrain_batch.js. Far patches are this module's own
//     merged meshes with their own 1-sampler material. TB_SLOT_CAPACITY = 256
//     bounds only the NEAR monolith ring (121 slots at R_near=5).
//   * It does NOT fetch statics, buildings, scenery, spawns or cells for far
//     landblocks, does NOT enter the terrain LRU, and does NOT create a per-LB
//     ShaderMaterial. Those systems stay HARD-CAPPED at today's radius 5, which
//     is already 2.5x retail (retail destroyed scenery/buildings at ring >= 2,
//     ~384 m). A far LB costs ~2 KB of network and one 128^2 ortho draw, once.
//     `?farDiag` (default on) asserts this rather than trusting the convention:
//     the existing radius plumbing fires terrain + statics + buildings from ONE
//     site (cells.js:1861-1900), so the natural way to "extend the ring" is
//     exactly the way that drags 42-58 ms of statics along with it.
//   * Far patches are OPAQUE with depthWrite: true. A transparent far ring
//     writes no depth, so every depth-keyed consumer (the takram
//     AerialPerspectiveEffect, ground-fog soft particles, anything reading
//     sceneDepthTexture) would classify the whole far ring as SKY — the same
//     class of defect as the dead 833 m horizon-dissolve guard this wave is
//     correcting. The near/far overlap is resolved by `discard`, not blending.
//
// ===========================================================================
// FLAGS (all in scene3d/far_terrain_flags.js, all documented in
// docs/url-flags.md)
//   ?farTerrain=off   master escape for the whole wave
//   ?terrainFog=off   S1 only — retail range fog in the terrain shader
//   ?farRing=on       S2/S3 — this module's ring (ships DEFAULT-OFF)
//   ?farRadius=N      Chebyshev radius in LBs (default 8 = 1536 m)
//   ?farTexels=N      composite texels per LB edge (default 128)
//   ?farBakeBudget=N  patch bakes per frame (default 1; measured 1.2 ms GPU)
//   ?farDiag=off      drop the radius-policy assertions
// ===========================================================================

import * as THREE from "three";
import {
  cellSwToNeCut,
  triangleGradInCell,
  METERS_PER_LANDBLOCK,
} from "./terrain_oracle.js";
import {
  TERRAIN_SHARED_TAIL_GLSL,
  glslFingerprint,
} from "./terrain_shared_glsl.js";
import {
  farTerrainEnabled,
  farRingEnabled,
  farRadiusLb,
  farTexelsPerLb,
  farBakeBudgetPerFrame,
  farFetchInFlightMax,
  farDiagEnabled,
  terrainFogEnabled,
  farFogFrac,
  farDepthBias,
} from "./far_terrain_flags.js";

/** Landblocks per patch edge. 4x4 = 768 m, world-anchored on `lbX >> 2`. */
const PATCH_LB = 4;
const CONTROL_SPACING_M = 24.0;
const VERT_GRID = 9;

// ---------------------------------------------------------------------------
// Module state. Module-local (like static_atlas / terrain_batch) so it is
// immune to the liveScene3d / scene3dForBuilders dual-facade footgun.
// ---------------------------------------------------------------------------
let _state = null;
let _disabled = false;      // sticky: a hard failure falls back to "no far ring"
const _warned = new Set();

function _warnOnce(reason, detail) {
  if (_warned.has(reason)) return;
  _warned.add(reason);
  // eslint-disable-next-line no-console
  console.warn(`[far_terrain] ${reason}`, detail ?? "");
}

// ===========================================================================
// Radius policy — the effective radii everything else keys off
// ===========================================================================

/**
 * The NEAR ring's EFFECTIVE Chebyshev radius, in landblocks.
 *
 * ⚠ This is NOT `pvsRingRadius`. The geometry governor
 * (`landblock_lru.js` MAX_LIVE_GEOM = 8000, farthest-first parking) has been
 * measured taking resident LBs from 200 to 35 — an effective radius of ~3 — on
 * a long tour. Publishing the NOMINAL radius into the far shader's discard
 * threshold would carve a two-LB annulus where the near ring no longer exists
 * and the far ring is discarded: a hole, i.e. exactly the failure the
 * no-inner-hole design exists to prevent. So the threshold tracks reality.
 *
 * Derived from the count of rows actually contributing to the terrain
 * multidraw (a filled square of N LBs has radius (sqrt(N) - 1) / 2), with the
 * LRU resident count and finally `pvsRingRadius` as fallbacks.
 */
/**
 * Floor for the effective radius, in landblocks. 3 LB = 576 m, which is retail
 * quality-1's whole landscape draw distance — a sane worst case. Without it the
 * first seconds of a boot (the fixed 3x3 core, 9 LBs => r = 1) would clamp the
 * fog to 163 m and the player would log in inside pea soup.
 */
const EFFECTIVE_R_FLOOR = 3;
/** Per-call decay when the ring shrinks. ~10 Hz tick => ~2 s to give up 1 LB. */
const EFFECTIVE_R_DECAY = 0.05;
let _smoothedNearR = NaN;

export function nearRingEffectiveRadiusLb(scene3d, { floor = true } = {}) {
  const nominal = Number.isFinite(scene3d?.pvsRingRadius) ? scene3d.pvsRingRadius : 5;
  let count = NaN;
  try {
    const s = typeof window !== "undefined" ? window.__terrainBatch?.stats?.() : null;
    if (s && Number.isFinite(s.visibleRows) && s.visibleRows > 0) count = s.visibleRows;
  } catch (_) { /* batch off or not yet created */ }
  if (!Number.isFinite(count)) {
    const resident = scene3d?.landblockLru?.entries?.size;
    if (Number.isFinite(resident) && resident > 0) count = resident;
  }
  if (!Number.isFinite(count)) {
    const baked = scene3d?.terrainBakedLbs?.size;
    if (Number.isFinite(baked) && baked > 0) count = baked;
  }
  let raw;
  if (!Number.isFinite(count) || count <= 0) {
    raw = nominal;
  } else {
    // A filled square of N landblocks has Chebyshev radius (sqrt(N) - 1) / 2.
    // Never claim MORE than the nominal ring (the count can briefly overshoot
    // while a re-centre is in flight).
    raw = Math.min(nominal, (Math.sqrt(count) - 1) / 2);
  }
  // ASYMMETRIC smoothing: open instantly (more terrain appeared, stop fogging
  // it), close slowly. A transient park storm or a mid-teleport frame must not
  // slam the fog shut and back open — that reads as a flash, and it is exactly
  // the kind of frame-to-frame instability that makes an A/B incomparable.
  if (!Number.isFinite(_smoothedNearR) || raw >= _smoothedNearR) _smoothedNearR = raw;
  else _smoothedNearR = Math.max(raw, _smoothedNearR - EFFECTIVE_R_DECAY);
  // ⚠ The FLOOR is for the FOG CLAMP only. The far ring's discard threshold
  // must track reality with NO floor: if the near ring really has collapsed to
  // 2 LBs, discarding far fragments out to 3 would carve exactly the hole the
  // no-inner-hole design exists to prevent. Callers that mean "where does the
  // near ring actually end" pass { floor: false }.
  return floor ? Math.max(EFFECTIVE_R_FLOOR, _smoothedNearR) : _smoothedNearR;
}

/**
 * Radius of the OUTERMOST drawn terrain, in landblocks — what the fog-before-
 * edge invariant clamps against. The far ring when it is live, otherwise the
 * near ring's effective radius.
 */
export function farTerrainEffectiveRadiusLb(scene3d) {
  if (!farTerrainEnabled()) return NaN;      // wave off → no clamp at all
  if (farRingEnabled() && !_disabled) return farRadiusLb();
  return nearRingEffectiveRadiusLb(scene3d);
}

// ===========================================================================
// Retail per-vertex light normals, computed on the JS side from heights alone
// ===========================================================================
//
// The monolith's DEFAULT-ON retail Gouraud term (?terrainGouraud) multiplies
// the ALBEDO by min(1, sunColor * max(0, N . sunVec) + ambColor * ambLevel),
// and it tracks the sun. So it must NOT be baked — the bake forces
// uAcGouraudEnabled to 0 and the far shader re-applies it live. That needs the
// same per-vertex `acLightNormal` the near ring uses.
//
// The near ring gets that attribute from `fetch_subdivided_landblock`. The far
// ring must stay heights-only (2 KB/LB, 2.1 s for the whole R=12 ring), so this
// is a direct JS port of `crates/holtburger-dat/src/terrain_subdiv.rs::
// retail_land_normals` — itself verbatim `CLandBlockStruct::calc_lighting`
// (acclient.c:353713): the sum of the UNIT plane normals of every adjacent
// triangle, block-local (no neighbour strips), normalised. It is a pure
// function of the 9x9 heights + the landblock id (which picks each cell's
// split diagonal), so no extra bytes cross the wire.
//
/**
 * @param {Float32Array|number[]} heights 81 entries, `idx = vx * 9 + vy`
 * @param {number} lbX landblock X byte
 * @param {number} lbY landblock Y byte
 * @returns {Float32Array} 81 * 3 unit normals in AC space (z up)
 */
export function retailLandNormals(heights, lbX, lbY) {
  const lbXInt = (lbX & 0xff) * 8;
  const lbYInt = (lbY & 0xff) * 8;
  const acc = new Float32Array(VERT_GRID * VERT_GRID * 3);
  const h = (x, y) => heights[x * VERT_GRID + y];

  const addFace = (gx, gy, corners) => {
    const nx = -gx / CONTROL_SPACING_M;
    const ny = -gy / CONTROL_SPACING_M;
    const mag = Math.sqrt(nx * nx + ny * ny + 1.0);
    const fx = nx / mag;
    const fy = ny / mag;
    const fz = 1.0 / mag;
    for (let i = 0; i < 3; i += 1) {
      const o = (corners[i * 2] * VERT_GRID + corners[i * 2 + 1]) * 3;
      acc[o] += fx;
      acc[o + 1] += fy;
      acc[o + 2] += fz;
    }
  };

  for (let cu = 0; cu < 8; cu += 1) {
    for (let cv = 0; cv < 8; cv += 1) {
      const z00 = h(cu, cv);
      const z10 = h(cu + 1, cv);
      const z01 = h(cu, cv + 1);
      const z11 = h(cu + 1, cv + 1);
      const cut = cellSwToNeCut(lbXInt + cu, lbYInt + cv);
      if (cut) {
        let g = triangleGradInCell(z00, z10, z01, z11, 0.75, 0.25, true);
        addFace(g[0], g[1], [cu, cv, cu + 1, cv, cu + 1, cv + 1]);
        g = triangleGradInCell(z00, z10, z01, z11, 0.25, 0.75, true);
        addFace(g[0], g[1], [cu, cv, cu + 1, cv + 1, cu, cv + 1]);
      } else {
        let g = triangleGradInCell(z00, z10, z01, z11, 0.25, 0.25, false);
        addFace(g[0], g[1], [cu, cv, cu + 1, cv, cu, cv + 1]);
        g = triangleGradInCell(z00, z10, z01, z11, 0.75, 0.75, false);
        addFace(g[0], g[1], [cu + 1, cv + 1, cu, cv + 1, cu + 1, cv]);
      }
    }
  }

  const out = new Float32Array(VERT_GRID * VERT_GRID * 3);
  for (let i = 0; i < VERT_GRID * VERT_GRID; i += 1) {
    const o = i * 3;
    const x = acc[o];
    const y = acc[o + 1];
    const z = acc[o + 2];
    const mag = Math.sqrt(x * x + y * y + z * z);
    if (mag < 0.00019999999) {
      out[o] = 0; out[o + 1] = 0; out[o + 2] = 1;
    } else {
      out[o] = x / mag; out[o + 1] = y / mag; out[o + 2] = z / mag;
    }
  }
  return out;
}

// ===========================================================================
// The far-patch shader — 1 sampler, ~30 instructions
// ===========================================================================

export const FAR_VERTEX_GLSL = /* glsl */ `
precision highp float;

// Patch-local AC position: xy in [0, PATCH_M], z = terrain height (metres).
// The patch Mesh carries the world offset, exactly like the per-LB terrain
// meshes do, so the position attribute stays small and the UV is trivial.
in vec3 acNormal;       // geometry normal (AC z-up) — FU-2 slope relief
in vec3 acLightNormal;  // retail calc_lighting normal — Gouraud term

uniform vec2 uPatchOriginXy;  // AC world xy of the patch's SW corner
uniform float uPatchSizeM;    // 768 at PATCH_LB = 4

out vec2 vTileUv;
out vec3 vAcNormal;
out vec3 vAcLightNormal;
out vec2 vWorldXy;
out float vViewDepth;

#if defined( USE_LOGARITHMIC_DEPTH_BUFFER ) || defined( USE_LOGDEPTHBUF )
out float vFragDepth;
out float vIsPerspective;
#endif

void main() {
  // The composite is a contiguous PATCH_LB x PATCH_LB image of this patch's
  // ground, so the UV is just the normalised patch-local position. Adjacent
  // landblocks share texels across their tile boundary, which is what lets mips
  // and aniso work across the whole patch instead of per LB.
  vTileUv = position.xy / uPatchSizeM;
  vAcNormal = acNormal;
  vAcLightNormal = acLightNormal;
  vWorldXy = uPatchOriginXy + position.xy;

  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
  vViewDepth = -mvPos.z;
  gl_Position = projectionMatrix * mvPos;
#if defined( USE_LOGARITHMIC_DEPTH_BUFFER ) || defined( USE_LOGDEPTHBUF )
  vFragDepth = 1.0 + gl_Position.w;
  vIsPerspective = float( projectionMatrix[2][3] == -1.0 );
#endif
}
`;

export const FAR_FRAGMENT_GLSL = /* glsl */ `
precision highp float;
precision highp sampler2D;

in vec2 vTileUv;
in vec3 vAcNormal;
in vec3 vAcLightNormal;
in vec2 vWorldXy;
in float vViewDepth;

out vec4 fragColor;

#if defined( USE_LOGARITHMIC_DEPTH_BUFFER ) || defined( USE_LOGDEPTHBUF )
uniform float logDepthBufFC;
in float vFragDepth;
in float vIsPerspective;
#endif

// THE one sampler. The monolith runs 16 (the WebGL2 guaranteed minimum) on
// these same pixels today.
uniform sampler2D uComposite;

// Live lighting — pushed every tick from the SAME per-LB terrain material the
// near ring's tickers drive, so far and near cannot drift apart.
uniform vec3 uSunDir;
uniform float uAcGouraudEnabled;
uniform vec3 uAcSunVec;
uniform vec3 uAcSunColor;
uniform vec3 uAcAmbColor;
uniform float uAcAmbLevel;
uniform float uDetailNormalEnabled;
uniform float uSlopeShadingEnabled;

// Near-ring handoff. uPlayerLbXy is the player's integer landblock; uNearFadeLb
// is the near ring's EFFECTIVE radius (governor-aware) + a half-LB so the
// boundary lands exactly on the near ring's outer edge.
uniform vec2 uPlayerLbXy;
uniform float uNearFadeLb;

// Depth push, in log-depth units, applied to the far ring so the near ring wins
// the ~10 m handoff overlap deterministically.
//
// ⚠ WHY NOT polygonOffset: this shader WRITES gl_FragDepth (the hand-rolled
// log-depth chunk), and an explicit gl_FragDepth write overrides polygon offset
// entirely. A material-level polygonOffset here would be silently inert — the
// exact shape of bug this wave is elsewhere correcting.
uniform float uFarDepthBias;

${TERRAIN_SHARED_TAIL_GLSL}

void main() {
  // --- near-ring handoff --------------------------------------------------
  // The near ring is OPAQUE and fully covers d < uNearFadeLb, so a discarded
  // far fragment there costs nothing and is never seen. discard (not alpha
  // blending) keeps the far ring in the opaque pass writing real depth: every
  // depth-keyed consumer downstream must see far terrain as WORLD, not sky.
  vec2 lbPos = vWorldXy / 192.0;
  vec2 dv = abs(lbPos - (uPlayerLbXy + vec2(0.5)));
  float dLb = max(dv.x, dv.y);
  if (dLb < uNearFadeLb) discard;

  // --- albedo -------------------------------------------------------------
  vec3 albedo = texture(uComposite, vTileUv).rgb;

  // --- live lighting, through the SHARED tail ------------------------------
  vec3 sunDir = normalize(uSunDir);
  bool acGouraud = uAcGouraudEnabled > 0.5;
  if (acGouraud) {
    albedo = terrainAcGouraud(albedo, vAcLightNormal, uAcSunVec,
                              uAcSunColor, uAcAmbColor, uAcAmbLevel);
  }
  // The monolith's detail-normal NdotL uses the RNM result, whose tangent BASE
  // is the flat (0,0,1) regardless of geometry — and past ~50 m the detail
  // array has mipped to that flat base anyway. So the far equivalent is the
  // flat normal, which is what the near path is evaluating at the seam.
  float ndotl = 1.0;
  if (uDetailNormalEnabled > 0.5 && !acGouraud) {
    ndotl = terrainSunNdotl(vec3(0.0, 0.0, 1.0), sunDir);
  }
  if (uSlopeShadingEnabled > 0.5 && !acGouraud) {
    ndotl *= terrainSunNdotl(normalize(vAcNormal), sunDir);
  }
  // cloudShadow and csmShadow are structurally 1.0 out here: the cloud-shadow
  // matrix covers cascade 0 (~10% of view distance) and csmShadowFactor returns
  // 1.0 for viewDepth > uCsmFar (~300 m). Passing the literals keeps the shared
  // expression identical while spending no sampler on a term that cannot fire.
  vec3 lit = terrainApplyLight(albedo, ndotl, 1.0, 1.0);

  fragColor = vec4(terrainApplyFog(lit, vViewDepth), 1.0);

#if defined( USE_LOGARITHMIC_DEPTH_BUFFER ) || defined( USE_LOGDEPTHBUF )
  float farDepth = vIsPerspective == 0.0
    ? gl_FragCoord.z
    : log2(vFragDepth) * logDepthBufFC * 0.5;
  gl_FragDepth = clamp(farDepth + uFarDepthBias, 0.0, 1.0);
#endif
}
`;

// ===========================================================================
// Geometry
// ===========================================================================

/**
 * Merge up to PATCH_LB^2 landblock heightfields into ONE patch geometry.
 *
 * Each LB contributes its raw 9x9 / 128-triangle grid — the SAME vertices the
 * monolith would draw, because `pickSubdivLevelForLb` already returns
 * subdivLevel 1 for every LB at Chebyshev distance >= 2. So the far surface is
 * vertex-identical to the near surface at the seam: no geometry LOD transition,
 * no pop, no crack, and no T-junction stitching code to maintain.
 *
 * (Retail DID have a real terrain LOD pyramid — LScape::get_block_orient gives
 * 24/48/96/192 m tiers with TransAdjust edge stitching — but that was a 1999
 * hardware concession that throws away the mountain silhouette, which is THE
 * far-field read in Dereth. 625 far LBs at subdiv 1 is ~80 k triangles through
 * a 1-sampler shader; measured terrain cost at 441 full-fat LBs was 9-11 ms
 * standalone, so this rounds to zero.)
 *
 * @param {Map<number, object>} lbData lbKey -> { positions, indices, acNormals, acLightNormals }
 * @param {number} px patch X (lbX >> 2)
 * @param {number} py patch Y (lbY >> 2)
 */
function buildPatchGeometry(lbData, px, py) {
  const entries = [];
  for (let dx = 0; dx < PATCH_LB; dx += 1) {
    for (let dy = 0; dy < PATCH_LB; dy += 1) {
      const lbX = px * PATCH_LB + dx;
      const lbY = py * PATCH_LB + dy;
      if (lbX > 0xff || lbY > 0xff) continue;
      const key = (((lbX & 0xff) << 24) | ((lbY & 0xff) << 16)) >>> 0;
      const d = lbData.get(key);
      if (!d) continue;
      entries.push({ d, dx, dy });
    }
  }
  if (entries.length === 0) return null;

  const vertsPerLb = VERT_GRID * VERT_GRID;
  const totalVerts = entries.length * vertsPerLb;
  const pos = new Float32Array(totalVerts * 3);
  const nrm = new Float32Array(totalVerts * 3);
  const lnrm = new Float32Array(totalVerts * 3);
  let idxCount = 0;
  for (const e of entries) idxCount += e.d.indices.length;
  const idx = new Uint32Array(idxCount);

  let vBase = 0;
  let iBase = 0;
  for (const e of entries) {
    const ox = e.dx * METERS_PER_LANDBLOCK;
    const oy = e.dy * METERS_PER_LANDBLOCK;
    const src = e.d.positions;
    for (let i = 0; i < vertsPerLb; i += 1) {
      pos[(vBase + i) * 3 + 0] = src[i * 3 + 0] + ox;
      pos[(vBase + i) * 3 + 1] = src[i * 3 + 1] + oy;
      pos[(vBase + i) * 3 + 2] = src[i * 3 + 2];
    }
    nrm.set(e.d.acNormals, vBase * 3);
    lnrm.set(e.d.acLightNormals, vBase * 3);
    const si = e.d.indices;
    for (let i = 0; i < si.length; i += 1) idx[iBase + i] = si[i] + vBase;
    vBase += vertsPerLb;
    iBase += si.length;
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(pos, 3, false));
  geom.setAttribute("acNormal", new THREE.BufferAttribute(nrm, 3, false));
  geom.setAttribute("acLightNormal", new THREE.BufferAttribute(lnrm, 3, false));
  geom.setIndex(new THREE.BufferAttribute(idx, 1));
  geom.computeBoundingSphere();
  return geom;
}

/**
 * Smooth per-vertex geometry normals for one LB's 9x9 grid, from heights only.
 * Central differences on the control grid — the seam-continuous shading normal,
 * matching what `computeVertexNormals()` produces for the near ring's mesh
 * closely enough that the FU-2 slope relief reads the same across the seam.
 */
function gridNormals(heights) {
  const out = new Float32Array(VERT_GRID * VERT_GRID * 3);
  const h = (x, y) => heights[Math.min(8, Math.max(0, x)) * VERT_GRID
                              + Math.min(8, Math.max(0, y))];
  for (let x = 0; x < VERT_GRID; x += 1) {
    for (let y = 0; y < VERT_GRID; y += 1) {
      const dzdx = (h(x + 1, y) - h(x - 1, y))
        / ((Math.min(8, x + 1) - Math.max(0, x - 1)) * CONTROL_SPACING_M);
      const dzdy = (h(x, y + 1) - h(x, y - 1))
        / ((Math.min(8, y + 1) - Math.max(0, y - 1)) * CONTROL_SPACING_M);
      const nx = -dzdx;
      const ny = -dzdy;
      const mag = Math.sqrt(nx * nx + ny * ny + 1.0);
      const o = (x * VERT_GRID + y) * 3;
      out[o] = nx / mag;
      out[o + 1] = ny / mag;
      out[o + 2] = 1.0 / mag;
    }
  }
  return out;
}

// ===========================================================================
// Bake
// ===========================================================================

/**
 * Build (once) the scratch bake rig: a clone of a live per-LB terrain material
 * with `uBakeAlbedo = 1`, plus a rotated root that reproduces the terrain
 * group's AC-Z-up -> three-Y-up world matrix.
 *
 * ⚠ THE TRAP (measured on the 1070): reparenting an LB mesh into a bare scratch
 * Scene silently drops that world matrix and the bake comes out ENTIRELY BLACK
 * with no error and no warning. The shader's world-space noise (splatMacro,
 * terrainMacro), the sand/ice fields and the triplanar frame all read
 * `vWorldPos`, which is `modelMatrix * position` — i.e. it INCLUDES the group
 * rotation. So the bake rig carries the same matrix, and the ortho camera lives
 * inside it in AC coordinates.
 */
function ensureBakeRig(scene3d) {
  const st = _state;
  if (st.bake) return st.bake;
  const src = Array.isArray(scene3d.terrainMaterials)
    ? scene3d.terrainMaterials.find((m) => m && m.uniforms && m.uniforms.uBakeAlbedo)
    : null;
  if (!src) return null; // near ring has not baked a material yet — try next tick

  const mat = src.clone();
  mat.name = "far-terrain-bake";
  // Albedo only. `clone()` deep-copies the uniform objects (textures stay by
  // reference), so writing these cannot disturb the live near-ring material.
  mat.uniforms.uBakeAlbedo.value = 1.0;
  // The retail Gouraud term multiplies the albedo and TRACKS THE SUN, so it
  // must not be frozen into the composite. The far shader re-applies it live.
  if (mat.uniforms.uAcGouraudEnabled) mat.uniforms.uAcGouraudEnabled.value = 0.0;
  // Wet-mud is a field-wide tone shift with no distance fade, so unlike every
  // other albedo term it would NOT resolve to its far value under the 1000 m
  // bake camera — it would freeze whatever wetness happened to be live. The
  // `?terrainDirt` family ships OFF on all four tiers, so today this is a
  // no-op; forcing it dry means a future promotion cannot silently bake a wet
  // look into the whole far world. (Known gap, and the only one: if the family
  // is ever promoted, the far ring stays dry until a wetness uniform is added
  // to the far shader.)
  if (mat.uniforms.uMudWetEnabled) mat.uniforms.uMudWetEnabled.value = 0.0;
  if (mat.uniforms.uMudWetness) mat.uniforms.uMudWetness.value = 0.0;
  mat.fog = false;          // fog is applied live by the far shader
  mat.side = THREE.FrontSide;

  const root = new THREE.Group();
  root.name = "far-terrain-bake-root";
  root.matrixAutoUpdate = false;
  root.matrix.copy(scene3d.terrainGroup.matrixWorld);
  root.matrixWorld.copy(root.matrix);

  const bakeScene = new THREE.Scene();
  bakeScene.fog = null;      // keeps USE_FOG undefined in the bake program
  bakeScene.add(root);

  // Ortho, 192 x 192 m, parked 1000 m up in AC space looking straight down.
  // vIsPerspective folds to 0 under an ortho projection, so the hand-rolled
  // log-depth chunk resolves to gl_FragDepth = gl_FragCoord.z — correct by
  // construction, nothing to change.
  const cam = new THREE.OrthographicCamera(
    -METERS_PER_LANDBLOCK / 2, METERS_PER_LANDBLOCK / 2,
    METERS_PER_LANDBLOCK / 2, -METERS_PER_LANDBLOCK / 2,
    1, 2200,
  );
  cam.up.set(0, 1, 0);       // AC north
  root.add(cam);

  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
  mesh.frustumCulled = false;
  root.add(mesh);

  st.bake = { scene: bakeScene, root, cam, mesh, mat };
  return st.bake;
}

/** Per-LB scratch data textures — two total, rewritten per bake, never pooled. */
function ensureScratchTextures() {
  const st = _state;
  if (st.vtTex) return;
  const vtBytes = new Uint8Array(9 * 9 * 4);
  st.vtTex = new THREE.DataTexture(vtBytes, 9, 9, THREE.RGBAFormat, THREE.UnsignedByteType);
  st.vtTex.magFilter = THREE.NearestFilter;
  st.vtTex.minFilter = THREE.NearestFilter;
  st.vtTex.generateMipmaps = false;
  st.vtTex.colorSpace = THREE.NoColorSpace;
  const mergeBytes = new Uint8Array(48 * 8 * 4);
  st.mergeTex = new THREE.DataTexture(mergeBytes, 48, 8, THREE.RGBAFormat, THREE.UnsignedByteType);
  st.mergeTex.magFilter = THREE.NearestFilter;
  st.mergeTex.minFilter = THREE.NearestFilter;
  st.mergeTex.generateMipmaps = false;
  st.mergeTex.colorSpace = THREE.NoColorSpace;
}

/** Rewrite the 9x9 vertex-types scratch texture for one LB. */
function writeVertexTypes(terrainCodes, roadCodes) {
  const bytes = _state.vtTex.image.data;
  for (let row = 0; row < 9; row += 1) {
    for (let col = 0; col < 9; col += 1) {
      const dst = (row * 9 + col) * 4;
      const src = col * 9 + row; // column-major source, matches adapter.js
      bytes[dst + 0] = terrainCodes[src];
      bytes[dst + 1] = roadCodes ? roadCodes[src] * 64 : 0;
      bytes[dst + 2] = 0;
      bytes[dst + 3] = 255;
    }
  }
  _state.vtTex.needsUpdate = true;
}

/**
 * Bake one patch: PATCH_LB^2 ortho draws into tiles of one 2D render target.
 *
 * Measured on a GTX 1070 through the real 151-uniform material: 0.073 ms GPU
 * per LB at 128^2 (0.112 at 256^2), i.e. ~1.2 ms per 16-LB patch. That is why
 * the budget is ONE patch per frame, not the two the design assumed.
 *
 * ⚠ DRAW-CALL CENSUS NOTE. This issues up to PATCH_LB^2 extra
 * `renderer.render()` calls per frame, off-screen. With the default
 * `renderer.info.autoReset = true` they are wiped by the real frame's own reset
 * and invisible. A census harness that sets `autoReset = false` (the documented
 * method) WILL see them — subtract `__farTerrainState().ring.stats.lbBakes`,
 * or census a frame after the ring has finished filling (patchesReady === 0).
 */
function bakePatch(scene3d, renderer, patch) {
  const rig = ensureBakeRig(scene3d);
  if (!rig) return false;
  ensureScratchTextures();

  const texels = _state.texels;
  if (!patch.rt) {
    patch.rt = new THREE.WebGLRenderTarget(texels * PATCH_LB, texels * PATCH_LB, {
      depthBuffer: true,
      stencilBuffer: false,
      // Mips + aniso at CONSTRUCTION. three allocates immutable storage, so
      // mip levels CANNOT be retrofitted onto a render target created without
      // them (verified on the 1070: a manual gl.generateMipmap on a 1-level
      // allocation returns glErr 0 and still samples zero). Undersampled far
      // shading is what crawls — this is the ?maskMips lesson at a larger
      // scale, and it is unfixable after the fact.
      //
      // ⚠ S5 NOTE (array-RT consolidation): three regenerates mips inside
      // `WebGLRenderer.render()` via `updateRenderTargetMipmap`, i.e. once per
      // TILE render — 16 times per patch here. On a 512^2 2D target that is
      // fractions of a millisecond and correctness is free. On a
      // WebGLArrayRenderTarget it is a FULL-ARRAY regeneration per layer render
      // (measured: 128^2 x 256 layers = 513 ms vs 18 ms with mips off), so S5
      // MUST use the deferred pattern: allocate WITH generateMipmaps true, set
      // `texture.generateMipmaps = false` for the fill loop, restore it and
      // regenerate once. Allocating without mips and retrofitting does not work
      // — three allocates immutable 1-level storage and the manual
      // gl.generateMipmap returns glErr 0 while still sampling zero.
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      colorSpace: THREE.NoColorSpace,
    });
    patch.rt.texture.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy?.() ?? 1);
    patch.rt.texture.name = `far-composite-${patch.px}-${patch.py}`;
  }

  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  const prevScissorTest = renderer.getScissorTest();
  renderer.autoClear = false;
  // NOTE deliberately NOT touched here: `renderer.toneMapping` and
  // `renderer.outputColorSpace` are both part of three's PROGRAM CACHE KEY, so
  // flipping them around the bake would fork a second program for every
  // material that renders afterwards. The atmosphere path already pins
  // toneMapping to NoToneMapping (the composer's ToneMappingEffect does it), and
  // outputColorSpace applies to the CANVAS only — a render into a target uses
  // that target's own texture colour space, which is NoColorSpace here because
  // the composite is albedo, not display radiance.
  renderer.setRenderTarget(patch.rt);
  if (!patch.rtCleared) {
    // Clear the WHOLE target once. Tiles for absent / off-map landblocks are
    // never covered by patch geometry so they are never sampled directly — but
    // mip generation averages them into levels that ARE sampled near a tile
    // edge, so leaving them as uninitialised garbage would bleed noise into the
    // far field at distance. Cheap, once per patch.
    patch.rtCleared = true;
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, patch.rt.width, patch.rt.height);
    renderer.clear(true, true, false);
  }
  renderer.setScissorTest(true);

  const rig2 = rig;
  const mat = rig2.mat;
  let baked = 0;
  for (let dx = 0; dx < PATCH_LB; dx += 1) {
    for (let dy = 0; dy < PATCH_LB; dy += 1) {
      const lbX = patch.px * PATCH_LB + dx;
      const lbY = patch.py * PATCH_LB + dy;
      if (lbX > 0xff || lbY > 0xff) continue;
      const key = (((lbX & 0xff) << 24) | ((lbY & 0xff) << 16)) >>> 0;
      const d = patch.lbData.get(key);
      if (!d) continue;

      writeVertexTypes(d.terrainCodes, d.roadCodes);
      mat.uniforms.uVertexTypes.value = _state.vtTex;
      if (mat.uniforms.uMergeData) {
        if (d.mergeData && mat.uniforms.uTexMergeEnabled) {
          _state.mergeTex.image.data.set(d.mergeData);
          _state.mergeTex.needsUpdate = true;
          mat.uniforms.uMergeData.value = _state.mergeTex;
          mat.uniforms.uTexMergeEnabled.value = _state.texMergeEnabled ? 1.0 : 0.0;
        } else if (mat.uniforms.uTexMergeEnabled) {
          mat.uniforms.uTexMergeEnabled.value = 0.0;
        }
      }
      if (mat.uniforms.uLbOriginXy) {
        mat.uniforms.uLbOriginXy.value.set(
          lbX * METERS_PER_LANDBLOCK,
          lbY * METERS_PER_LANDBLOCK,
        );
      }

      rig2.mesh.geometry = d.geom;
      rig2.mesh.position.set(lbX * METERS_PER_LANDBLOCK, lbY * METERS_PER_LANDBLOCK, 0);
      // ⚠ Do NOT use camera.lookAt() here. Object3D.lookAt() treats its
      // argument as a WORLD-space point but reads the camera's own position
      // from matrixWorld — inside the rotated bake root those are two different
      // frames and the camera ends up pointing at the horizon. It is also
      // unnecessary: a three camera with identity rotation already looks down
      // its own -Z with +Y up, and inside this root that IS "straight down in
      // AC with north up". Identity is exactly the bake orientation.
      rig2.cam.position.set(
        lbX * METERS_PER_LANDBLOCK + METERS_PER_LANDBLOCK / 2,
        lbY * METERS_PER_LANDBLOCK + METERS_PER_LANDBLOCK / 2,
        1000,
      );
      rig2.cam.quaternion.identity();
      rig2.root.updateMatrixWorld(true);
      rig2.cam.updateMatrixWorld(true);
      rig2.cam.updateProjectionMatrix();

      const vx = dx * texels;
      const vy = dy * texels;
      renderer.setViewport(vx, vy, texels, texels);
      renderer.setScissor(vx, vy, texels, texels);
      renderer.clear(true, true, false);
      renderer.render(rig2.scene, rig2.cam);
      baked += 1;
    }
  }

  renderer.setScissorTest(prevScissorTest);
  renderer.setRenderTarget(prevTarget);
  renderer.autoClear = prevAutoClear;
  const size = renderer.getSize(new THREE.Vector2());
  renderer.setViewport(0, 0, size.x, size.y);
  renderer.setScissor(0, 0, size.x, size.y);

  _state.stats.lbBakes += baked;
  _state.stats.patchBakes += 1;
  return baked > 0;
}

// ===========================================================================
// Far material + patch meshes
// ===========================================================================

function ensureFarMaterial(scene3d) {
  const st = _state;
  if (st.material) return st.material;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uComposite: { value: null },
      uPatchOriginXy: { value: new THREE.Vector2(0, 0) },
      uPatchSizeM: { value: PATCH_LB * METERS_PER_LANDBLOCK },
      uSunDir: { value: new THREE.Vector3(-0.4, -0.3, 1.0).normalize() },
      uAcGouraudEnabled: { value: 0.0 },
      uAcSunVec: { value: new THREE.Vector3(0, 0, 0) },
      uAcSunColor: { value: new THREE.Color(1, 1, 1) },
      uAcAmbColor: { value: new THREE.Color(1, 1, 1) },
      uAcAmbLevel: { value: 0.2 },
      uDetailNormalEnabled: { value: 0.0 },
      uSlopeShadingEnabled: { value: 0.0 },
      uPlayerLbXy: { value: new THREE.Vector2(0, 0) },
      uNearFadeLb: { value: 5.5 },
      uFarDepthBias: { value: farDepthBias() },
      fogColor: { value: new THREE.Color(0xc3c8dc) },
      fogNear: { value: 150 },
      fogFar: { value: 2400 },
      fogDensity: { value: 0.00025 },
    },
    vertexShader: FAR_VERTEX_GLSL,
    fragmentShader: FAR_FRAGMENT_GLSL,
    glslVersion: THREE.GLSL3,
    side: THREE.FrontSide,
    // OPAQUE, depth-writing. See the module header: a transparent far ring
    // makes every sceneDepthTexture consumer read far terrain as sky.
    transparent: false,
    depthWrite: true,
    depthTest: true,
    // NOT polygonOffset — this shader writes gl_FragDepth, which overrides it.
    // The handoff overlap is biased in the shader instead (uFarDepthBias).
    fog: terrainFogEnabled(),
  });
  mat.name = "far-terrain";
  st.material = mat;
  return mat;
}

/** Each patch gets its own material instance (one uniform differs: uComposite). */
function makePatchMaterial(scene3d, patch) {
  const base = ensureFarMaterial(scene3d);
  const mat = base.clone();
  mat.name = `far-terrain-${patch.px}-${patch.py}`;
  mat.uniforms.uComposite.value = patch.rt.texture;
  mat.uniforms.uPatchOriginXy.value.set(
    patch.px * PATCH_LB * METERS_PER_LANDBLOCK,
    patch.py * PATCH_LB * METERS_PER_LANDBLOCK,
  );
  mat.fog = base.fog;
  _state.patchMaterials.add(mat);
  return mat;
}

// ===========================================================================
// Streaming
// ===========================================================================

function playerLb(scene3d) {
  const key = scene3d?.currentLandblockKey
    ?? scene3d?.playerLbKey
    ?? scene3d?.lastPlayerLbKey;
  if (Number.isFinite(key)) {
    return { x: (key >>> 24) & 0xff, y: (key >>> 16) & 0xff };
  }
  try {
    const p = scene3d?.entityManager?.getLocalPlayerWorldPos?.();
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      return {
        x: Math.floor(p.x / METERS_PER_LANDBLOCK) & 0xff,
        y: Math.floor(p.y / METERS_PER_LANDBLOCK) & 0xff,
      };
    }
  } catch (_) { /* pre-spawn */ }
  return null;
}

/**
 * True while the NEAR ring still has fetch/bake work in flight. NEAR ALWAYS
 * WINS — the far ring must never be the reason the ground under the player is
 * late.
 *
 * With one escape: a client that is continuously streaming (a long tour, a busy
 * town) can keep `inFlight` non-empty indefinitely, and a strict yield would
 * mean the far ring never fills at all — the feature would look implemented and
 * do nothing, which is the failure mode this whole wave keeps finding. So after
 * FAR_STARVATION_MS with no far fetch admitted, exactly one is let through per
 * tick. The far lane is non-urgent and capped at 2 in flight, so even the
 * starved path cannot crowd the near ring.
 */
const FAR_STARVATION_MS = 10000;
function nearRingBusy(scene3d) {
  let busy = false;
  try {
    const inFlight = scene3d?._streamGuardState?.inFlight;
    if (inFlight && inFlight.size > 0) busy = true;
  } catch (_) { /* guard not wired */ }
  if (!busy) return false;
  const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
  const last = _state?.lastFarFetchMs ?? 0;
  if (last > 0 && now - last > FAR_STARVATION_MS) {
    if (_state) _state.starvationAdmits = (_state.starvationAdmits ?? 0) + 1;
    return false;
  }
  if (last === 0 && _state) {
    // Seed the clock on the first busy tick so the escape is measured from
    // "the far ring started wanting to stream", not from page load.
    _state.lastFarFetchMs = now;
  }
  return true;
}

/**
 * `?farDiag` — the radius policy, ENFORCED rather than assumed.
 *
 * The existing plumbing fires terrain + statics + buildings from ONE site
 * (cells.js:1861-1900), so the natural way to implement "extend the ring" drags
 * 42-58 ms of statics and 415-613 draw calls along with it. This records every
 * LB the far path ever touched; the probe surface cross-checks it against the
 * statics/buildings/LRU baked sets, and a violation is a loud console error.
 */
function assertRadiusPolicy(scene3d) {
  if (!farDiagEnabled() || !_state) return;
  const st = _state;
  const plb = playerLb(scene3d);
  if (!plb) return;
  // ⚠ THE FAR RING HAS NO INNER HOLE — it is baked and drawn across the whole
  // radius INCLUDING under the player (that is what saves you when the geometry
  // governor collapses the near ring), and a per-fragment discard hides it
  // inside. So `farLbKeys` legitimately contains landblocks the near ring also
  // owns, and a naive set-intersection test would fire on every single boot.
  // The real invariant is about DISTANCE: a landblock currently BEYOND the near
  // ring must have no statics, no buildings, no LRU entry and no per-LB terrain
  // material. `+1` of hysteresis absorbs the frame or two after an LB crossing.
  const nominal = Number.isFinite(scene3d?.pvsRingRadius) ? scene3d.pvsRingRadius : 5;
  const gate = nominal + 1;
  const beyond = [];
  for (const key of st.farLbKeys) {
    const lbX = (key >>> 24) & 0xff;
    const lbY = (key >>> 16) & 0xff;
    if (Math.max(Math.abs(lbX - plb.x), Math.abs(lbY - plb.y)) > gate) beyond.push(key);
  }
  st.farOnlyLbCount = beyond.length;
  const violations = [];
  const check = (setName, set) => {
    if (!(set instanceof Set)) return;
    for (const key of beyond) {
      if (set.has(key)) violations.push({ set: setName, lbKey: key >>> 0 });
      if (violations.length > 8) return;
    }
  };
  check("staticsBakedLbs", scene3d.staticsBakedLbs);
  check("buildingsBakedLbs", scene3d.buildingsBakedLbs);
  check("terrainBakedLbs", scene3d.terrainBakedLbs);
  try {
    const lru = scene3d.landblockLru?.entries;
    if (lru && typeof lru.has === "function") {
      for (const key of beyond) {
        if (lru.has(key)) violations.push({ set: "landblockLru", lbKey: key >>> 0 });
        if (violations.length > 8) break;
      }
    }
  } catch (_) { /* no lru */ }
  st.policyViolations = violations;
  if (violations.length > 0 && !st.policyWarned) {
    st.policyWarned = true;
    // eslint-disable-next-line no-console
    console.error(
      "[far_terrain] RADIUS POLICY VIOLATION — a far-ring landblock reached a "
      + "near-ring system (statics / buildings / terrain LRU). The far path must "
      + "call fetch_landblock_heightmaps and nothing else.",
      violations,
    );
  }
}

// ===========================================================================
// Public API
// ===========================================================================

/**
 * Install the far-terrain group + probe surface. Safe to call more than once.
 * A hard no-op (no allocation, no group, no probe mutation beyond a disabled
 * report) when `?farTerrain=off` or `?farRing` is not on.
 */
export function initFarTerrain(scene3d, { parent, renderer } = {}) {
  if (typeof window !== "undefined" && !window.__farTerrainState) {
    // The probe is installed even when the ring is off, so the validator can
    // read the fog stage's numbers with a single entry point.
    window.__farTerrainState = () => farTerrainState(window.liveScene3d ?? scene3d);
  }
  if (!farRingEnabled() || _disabled) return null;
  if (_state) return _state;
  if (!scene3d?.terrainGroup) {
    _warnOnce("initFarTerrain: scene3d.terrainGroup missing — far ring disabled");
    _disabled = true;
    return null;
  }
  const group = new THREE.Group();
  group.name = "far-terrain";
  // SIBLING of terrainGroup under worldRoot: identical AC transform, and the
  // terrain LRU's `terrainGroup.children` park/evict scans, the LOD-rebake
  // dispose walker and cullTerrainGroup never see far patches.
  (parent ?? scene3d.terrainGroup.parent ?? scene3d.terrainGroup).add(group);

  _state = {
    group,
    renderer: renderer ?? scene3d.renderer ?? null,
    radius: farRadiusLb(),
    texels: farTexelsPerLb(),
    texMergeEnabled: scene3d?.terrainOpts?.texMergeEnabled !== false,
    patches: new Map(),      // patchKey -> patch record
    farLbKeys: new Set(),    // every LB the far path has ever fetched
    patchMaterials: new Set(),
    material: null,
    bake: null,
    vtTex: null,
    mergeTex: null,
    fetchInFlight: 0,
    lastFarFetchMs: 0,
    starvationAdmits: 0,
    epoch: 0,
    policyViolations: [],
    farOnlyLbCount: 0,
    policyWarned: false,
    stats: {
      patchBakes: 0, lbBakes: 0, fetches: 0, fetchedLbs: 0,
      fetchErrors: 0, patchesDisposed: 0,
    },
  };
  // eslint-disable-next-line no-console
  console.log(
    `[far_terrain] far composite ring ON — R_far=${_state.radius} `
    + `(${_state.radius * 192} m), ${_state.texels}^2 texels/LB, `
    + `${PATCH_LB}x${PATCH_LB}-LB patches`,
  );
  return _state;
}

const _patchKey = (px, py) => (((px & 0xff) << 8) | (py & 0xff)) >>> 0;

/**
 * Per-frame driver. Cheap early-out when the ring is off.
 *
 * Order of business, all budgeted:
 *   1. publish the live lighting + fog + near-fade uniforms,
 *   2. retire patches that left the ring,
 *   3. issue at most `farFetchInFlightMax` heightmap batches, nearest-first and
 *      then camera-forward-first (at R_far=12 about three quarters of the ring
 *      is behind you and worthless),
 *   4. bake at most `farBakeBudget` patches (default 1 = ~1.2 ms GPU).
 */
export function tickFarTerrain(scene3d, sessionHandle, renderer) {
  if (!_state || _disabled) return;
  const st = _state;
  const r = renderer ?? st.renderer ?? scene3d?.renderer;
  if (r && !st.renderer) st.renderer = r;

  publishFarUniforms(scene3d);

  const plb = playerLb(scene3d);
  if (!plb) return;

  // --- 2. retirement ------------------------------------------------------
  const keepR = st.radius + PATCH_LB; // hysteresis: one patch of slack
  for (const [key, patch] of st.patches) {
    const d = patchChebyshevLb(patch, plb);
    if (d > keepR) {
      disposePatch(patch);
      st.patches.delete(key);
      st.stats.patchesDisposed += 1;
    }
  }

  // --- enumerate wanted patches, nearest-first then camera-forward ---------
  const wanted = [];
  const p0 = Math.floor((plb.x - st.radius) / PATCH_LB);
  const p1 = Math.floor((plb.x + st.radius) / PATCH_LB);
  const q0 = Math.floor((plb.y - st.radius) / PATCH_LB);
  const q1 = Math.floor((plb.y + st.radius) / PATCH_LB);
  const fwd = cameraForwardAc(scene3d);
  for (let px = p0; px <= p1; px += 1) {
    for (let py = q0; py <= q1; py += 1) {
      if (px < 0 || py < 0 || px * PATCH_LB > 0xff || py * PATCH_LB > 0xff) continue;
      const key = _patchKey(px, py);
      let patch = st.patches.get(key);
      if (!patch) {
        patch = {
          px, py, key,
          state: "idle",       // idle -> fetching -> ready -> baked
          lbData: new Map(),
          rt: null, mesh: null, geom: null, mat: null,
          epoch: st.epoch,
        };
        st.patches.set(key, patch);
      }
      const d = patchChebyshevLb(patch, plb);
      if (d > st.radius + PATCH_LB) continue;
      // Camera-forward bias: a patch behind you is worth nothing at a parked
      // overlook and it is half the ring.
      const cx = (px * PATCH_LB + PATCH_LB / 2) - (plb.x + 0.5);
      const cy = (py * PATCH_LB + PATCH_LB / 2) - (plb.y + 0.5);
      const len = Math.hypot(cx, cy) || 1;
      const behind = fwd ? (1 - (cx / len * fwd.x + cy / len * fwd.y)) : 0;
      wanted.push({ patch, sort: d + behind * 1.5 });
    }
  }
  wanted.sort((a, b) => a.sort - b.sort);

  // --- 3. fetch -----------------------------------------------------------
  // HARD RULE: never issue a far fetch while the near ring has work in flight.
  if (!nearRingBusy(scene3d) && sessionHandle) {
    for (const { patch } of wanted) {
      if (st.fetchInFlight >= farFetchInFlightMax()) break;
      if (patch.state !== "idle") continue;
      startPatchFetch(scene3d, sessionHandle, patch);
    }
  }

  // --- 4. bake ------------------------------------------------------------
  if (r) {
    let budget = farBakeBudgetPerFrame();
    for (const { patch } of wanted) {
      if (budget <= 0) break;
      if (patch.state !== "ready") continue;
      if (bakePatch(scene3d, r, patch)) {
        finishPatch(scene3d, patch);
        budget -= 1;
      } else {
        break; // bake rig not available yet
      }
    }
  }

  assertRadiusPolicy(scene3d);
}

function patchChebyshevLb(patch, plb) {
  const cx = patch.px * PATCH_LB + (PATCH_LB - 1) / 2;
  const cy = patch.py * PATCH_LB + (PATCH_LB - 1) / 2;
  return Math.max(Math.abs(cx - plb.x), Math.abs(cy - plb.y));
}

function cameraForwardAc(scene3d) {
  try {
    const cam = scene3d?.camera;
    if (!cam) return null;
    const v = new THREE.Vector3();
    cam.getWorldDirection(v);
    // three-space (y up) -> AC (z up): ac = (x, -z, y)
    const ax = v.x;
    const ay = -v.z;
    const len = Math.hypot(ax, ay);
    if (!(len > 1e-4)) return null;
    return { x: ax / len, y: ay / len };
  } catch (_) {
    return null;
  }
}

/**
 * Fetch one patch's 16 landblocks in ONE `fetch_landblock_heightmaps` call.
 * This is the ONLY wasm entry point the far path is permitted to touch —
 * `fetch_landblock_objects` / `_scenery` / `_spawns` are separate exports and
 * are never called. Measured on the 1070: 6.0-8.8 ms per LB cold, 0.01 ms warm,
 * and the entire d=6..12 annulus (504 LBs) in 2.14 s.
 */
function startPatchFetch(scene3d, sessionHandle, patch) {
  const st = _state;
  const wasm = scene3d?.wasmExports ?? sessionHandle;
  const fn = wasm?.fetch_landblock_heightmaps;
  if (typeof fn !== "function") {
    _warnOnce("fetch_landblock_heightmaps unavailable — far ring disabled");
    _disabled = true;
    return;
  }
  const ids = [];
  const lbs = [];
  for (let dx = 0; dx < PATCH_LB; dx += 1) {
    for (let dy = 0; dy < PATCH_LB; dy += 1) {
      const lbX = patch.px * PATCH_LB + dx;
      const lbY = patch.py * PATCH_LB + dy;
      if (lbX > 0xff || lbY > 0xff) continue;
      const key = (((lbX & 0xff) << 24) | ((lbY & 0xff) << 16)) >>> 0;
      ids.push((key | 0xffff) >>> 0);
      lbs.push({ lbX, lbY, key });
    }
  }
  if (ids.length === 0) { patch.state = "baked"; return; }

  patch.state = "fetching";
  st.fetchInFlight += 1;
  st.stats.fetches += 1;
  st.lastFarFetchMs = (typeof performance !== "undefined" ? performance.now() : Date.now());
  // `urgent = false` — the far ring rides the normal fetch lane so it can never
  // starve the player-blocking near ring.
  Promise.resolve(fn.call(wasm, new Uint32Array(ids), false))
    .then((meshes) => {
      if (!_state || _state !== st) return;
      if (!meshes) throw new Error("fetch_landblock_heightmaps returned null");
      for (let i = 0; i < lbs.length && i < meshes.length; i += 1) {
        const m = meshes[i];
        if (!m) continue;
        const { lbX, lbY, key } = lbs[i];
        try {
          const positions = Float32Array.from(m.positions);
          const rawIdx = Uint16Array.from(m.indices);
          const terrainCodes = Uint8Array.from(m.terrainCodes);
          const roadCodes = Uint8Array.from(m.roadCodes);
          const mergeRaw = m.terrainMergeData;
          const mergeData = (mergeRaw && mergeRaw.length === 48 * 8 * 4)
            ? Uint8Array.from(mergeRaw) : null;
          // F#27 winding reversal — identical to adapter.js, so FrontSide is
          // correct after the worldRoot rotation.
          const indices = new Uint16Array(rawIdx.length);
          for (let t = 0; t < rawIdx.length; t += 3) {
            indices[t] = rawIdx[t];
            indices[t + 1] = rawIdx[t + 2];
            indices[t + 2] = rawIdx[t + 1];
          }
          const heights = new Float32Array(81);
          for (let v = 0; v < 81; v += 1) heights[v] = positions[v * 3 + 2];

          // Per-LB geometry for the BAKE (LB-local, exactly the near path's).
          const geom = new THREE.BufferGeometry();
          geom.setAttribute("position", new THREE.BufferAttribute(positions, 3, false));
          geom.setAttribute("terrainCode", new THREE.BufferAttribute(terrainCodes, 1, false));
          geom.setAttribute("roadCode", new THREE.BufferAttribute(roadCodes, 1, false));
          geom.setIndex(new THREE.BufferAttribute(indices, 1));
          const acNormals = gridNormals(heights);
          geom.setAttribute("normal", new THREE.BufferAttribute(acNormals.slice(), 3, false));
          // vAcNormal / vAcLightNormal feed the monolith's slope + Gouraud
          // terms. The bake forces Gouraud off, but the attribute must exist or
          // the program's attribute bind is undefined.
          geom.setAttribute("acNormal", new THREE.BufferAttribute(acNormals.slice(), 3, false));
          const acLightNormals = retailLandNormals(heights, lbX, lbY);
          geom.setAttribute("acLightNormal",
            new THREE.BufferAttribute(acLightNormals.slice(), 3, false));
          // TerrainTex per-vertex modulation attributes, MODULATION-NEUTRAL.
          // The monolith vertex shader declares all three; a missing attribute
          // binds to the GL default of 0, and with `?terrainMod=on` that would
          // multiply the whole far world to BLACK (brightness) and desaturate it
          // (saturate) — a silent failure that only appears under a flag nobody
          // has on. `?terrainMod` is an `=== "on"` opt-in and default-OFF, so
          // 1.0 everywhere is both safe and a strict no-op today. (Reproducing
          // the real hashed per-vertex values would need
          // `scene3d.terrainModulationRanges` in the bake path; if terrainMod is
          // ever promoted, that is the change to make.)
          const ones = new Float32Array(81).fill(1);
          geom.setAttribute("vertexBrightness", new THREE.BufferAttribute(ones, 1, false));
          geom.setAttribute("vertexSaturate", new THREE.BufferAttribute(ones.slice(), 1, false));
          geom.setAttribute("vertexHue", new THREE.BufferAttribute(ones.slice(), 1, false));
          geom.computeBoundingSphere();

          patch.lbData.set(key, {
            positions, indices, terrainCodes, roadCodes, mergeData,
            heights, acNormals, acLightNormals, geom,
          });
          st.farLbKeys.add(key);
          st.stats.fetchedLbs += 1;
        } catch (e) {
          _warnOnce("per-LB decode failed", e);
        }
        if (typeof m.free === "function") { try { m.free(); } catch (_) { /* already freed */ } }
      }
      patch.state = patch.lbData.size > 0 ? "ready" : "baked";
    })
    .catch((e) => {
      st.stats.fetchErrors += 1;
      _warnOnce("far heightmap fetch failed (patch retired)", e);
      patch.state = "baked"; // never retry-storm; the fog closes the gap
    })
    .finally(() => {
      st.fetchInFlight = Math.max(0, st.fetchInFlight - 1);
    });
}

/**
 * Build the patch mesh from an already-baked composite and show it.
 *
 * A patch becomes visible ONLY here, i.e. only once every landblock it holds
 * has baked. A half-baked patch never appears; until then the pixels are sky,
 * and the fog band (clamped to 0.85 * R_far * 192) makes that indistinguishable
 * from "the world ends there".
 */
function finishPatch(scene3d, patch) {
  const st = _state;
  const geom = buildPatchGeometry(patch.lbData, patch.px, patch.py);
  if (!geom) { patch.state = "baked"; return; }
  patch.geom = geom;
  patch.mat = makePatchMaterial(scene3d, patch);
  const mesh = new THREE.Mesh(geom, patch.mat);
  mesh.name = `far-patch-${patch.px}-${patch.py}`;
  mesh.position.set(
    patch.px * PATCH_LB * METERS_PER_LANDBLOCK,
    patch.py * PATCH_LB * METERS_PER_LANDBLOCK,
    0,
  );
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = true;  // retail culls frustum-only, no distance radius
  mesh.renderOrder = -1;      // draw before the near ring: cheap early-z for it
  mesh.userData = { __farTerrainPatch: true };
  patch.mesh = mesh;
  st.group.add(mesh);
  patch.state = "baked";
  // The per-LB bake geometry has done its job; the merged patch geometry owns
  // the vertices from here.
  for (const d of patch.lbData.values()) {
    if (d.geom) { d.geom.dispose(); d.geom = null; }
  }
}

function disposePatch(patch) {
  try {
    if (patch.mesh) {
      patch.mesh.parent?.remove(patch.mesh);
      patch.mesh = null;
    }
    if (patch.geom) { patch.geom.dispose(); patch.geom = null; }
    if (patch.mat) { _state.patchMaterials.delete(patch.mat); patch.mat.dispose(); patch.mat = null; }
    if (patch.rt) { patch.rt.dispose(); patch.rt = null; }
    for (const d of patch.lbData.values()) {
      if (d.geom) { d.geom.dispose(); d.geom = null; }
    }
    patch.lbData.clear();
  } catch (e) {
    _warnOnce("disposePatch threw", e);
  }
}

/**
 * Push the live lighting + fog + handoff uniforms onto every far material.
 *
 * The lighting values are COPIED from a live per-LB terrain material rather
 * than re-derived, so the far ring is driven by exactly the tickers that drive
 * the near ring (tickTerrainSunDir, the sky-lighting snapshot, the Gouraud
 * push) with no new registration and no second source of truth.
 */
function publishFarUniforms(scene3d) {
  const st = _state;
  if (!st) return;
  const src = Array.isArray(scene3d?.terrainMaterials)
    ? scene3d.terrainMaterials.find((m) => m && m.uniforms && m.uniforms.uSunDir)
    : null;
  const plb = playerLb(scene3d);
  const nearR = nearRingEffectiveRadiusLb(scene3d, { floor: false });
  // +0.5 puts the boundary on the near ring's OUTER LB edge; the small
  // subtraction gives ~10 m of overlap so a rounding wobble cannot open a
  // one-pixel crack (polygonOffset keeps the near ring winning the depth test
  // in that band).
  const fade = Math.max(0, nearR + 0.5 - 0.05);
  st.nearFadeLb = fade;
  st.nearEffectiveR = nearR;

  const apply = (mat) => {
    const u = mat.uniforms;
    if (src) {
      const s = src.uniforms;
      if (s.uSunDir) u.uSunDir.value.copy(s.uSunDir.value);
      if (s.uAcGouraudEnabled) u.uAcGouraudEnabled.value = s.uAcGouraudEnabled.value;
      if (s.uAcSunVec) u.uAcSunVec.value.copy(s.uAcSunVec.value);
      if (s.uAcSunColor) u.uAcSunColor.value.copy(s.uAcSunColor.value);
      if (s.uAcAmbColor) u.uAcAmbColor.value.copy(s.uAcAmbColor.value);
      if (s.uAcAmbLevel) u.uAcAmbLevel.value = s.uAcAmbLevel.value;
      if (s.uDetailNormalEnabled) u.uDetailNormalEnabled.value = s.uDetailNormalEnabled.value;
      if (s.uTerrainSlopeShadingEnabled) {
        u.uSlopeShadingEnabled.value = s.uTerrainSlopeShadingEnabled.value;
      }
    }
    if (plb) u.uPlayerLbXy.value.set(plb.x, plb.y);
    u.uNearFadeLb.value = fade;
  };
  if (st.material) apply(st.material);
  for (const mat of st.patchMaterials) apply(mat);
}

/**
 * Probe surface for the validator. Always installed (even with the ring off) so
 * the fog stage is readable through one entry point.
 *
 * `window.__farTerrainState()`
 */
export function farTerrainState(scene3d) {
  const st = _state;
  let batch = null;
  try {
    batch = typeof window !== "undefined" ? window.__terrainBatch?.stats?.() ?? null : null;
  } catch (_) { /* batch off */ }
  const slotsOk = !batch
    || (batch.passthrough === 0
        && batch.slotsUsed <= batch.slotCapacity
        && batch.enabled === true);

  const out = {
    // --- flags ---
    flags: {
      farTerrain: farTerrainEnabled(),
      terrainFog: terrainFogEnabled(),
      farRing: farRingEnabled(),
      farRadius: farRadiusLb(),
      farTexels: farTexelsPerLb(),
      farFogFrac: farFogFrac(),
      farBakeBudget: farBakeBudgetPerFrame(),
      farDiag: farDiagEnabled(),
    },
    disabled: _disabled,
    // --- S0: shared-tail fingerprint (both programs carry these bytes) ---
    sharedTailFingerprint: glslFingerprint(TERRAIN_SHARED_TAIL_GLSL),
    sharedTailBytes: TERRAIN_SHARED_TAIL_GLSL.length,
    // --- S0: terrain_batch anchor-drift + slot gate ---
    terrainBatch: batch,
    slotsAssertionOk: slotsOk,
    // --- S1: the fog ACTUALLY applied this frame ---
    fog: scene3d?.__farFogApplied ?? null,
    sceneFog: (() => {
      const f = scene3d?.scene?.fog;
      if (!f) return null;
      return {
        type: f.isFogExp2 ? "FogExp2" : "Fog",
        near: f.near ?? null,
        far: f.far ?? null,
        colorHex: f.color ? f.color.getHex() : null,
      };
    })(),
    terrainMaterialFog: (() => {
      const m = scene3d?.terrainMaterials?.[0];
      return m ? { fog: m.fog === true, hasFogUniform: !!m.uniforms?.fogColor } : null;
    })(),
    nearEffectiveRadiusLb: nearRingEffectiveRadiusLb(scene3d),
    farEffectiveRadiusLb: farTerrainEffectiveRadiusLb(scene3d),
  };

  if (!st) {
    out.ring = { active: false };
    return out;
  }

  let baked = 0; let ready = 0; let fetching = 0; let idle = 0;
  for (const p of st.patches.values()) {
    if (p.state === "baked") baked += 1;
    else if (p.state === "ready") ready += 1;
    else if (p.state === "fetching") fetching += 1;
    else idle += 1;
  }
  out.ring = {
    active: true,
    radiusLb: st.radius,
    radiusM: st.radius * 192,
    texelsPerLb: st.texels,
    patchLb: PATCH_LB,
    patches: st.patches.size,
    patchesVisible: st.group.children.length,
    patchesBaked: baked,
    patchesReady: ready,
    patchesFetching: fetching,
    patchesIdle: idle,
    fetchInFlight: st.fetchInFlight,
    // How often the near-ring-always-wins rule had to be escaped because the
    // near ring never went idle. Should be 0 on a parked camera; a large number
    // on a parked camera means the stream guard is leaking in-flight entries.
    starvationAdmits: st.starvationAdmits ?? 0,
    uNearFadeLb: st.nearFadeLb ?? null,
    farLbsTouched: st.farLbKeys.size,
    // Far landblocks CURRENTLY beyond the near ring + 1 — the set the radius
    // policy is asserted over.
    farOnlyLbCount: st.farOnlyLbCount ?? null,
    epoch: st.epoch,
    stats: { ...st.stats },
    // Radius policy — MUST be an empty array.
    policyViolations: st.policyViolations,
    policyOk: st.policyViolations.length === 0,
  };
  return out;
}

/**
 * Invalidate every composite and re-bake. The ONLY events that need this are
 * dev/A-B flag flips that change the albedo the monolith produces
 * (`?terrainBc7`, the atlas tile size, `?texMerge` / `?splatMacro` / `?maskMips`,
 * the macro knobs, a region/season change). Nothing that MOVES needs it, which
 * is the entire point of baking albedo only.
 */
export function bumpFarCompositeEpoch() {
  if (!_state) return 0;
  _state.epoch += 1;
  for (const patch of _state.patches.values()) disposePatch(patch);
  _state.patches.clear();
  _state.bake = null;
  return _state.epoch;
}

/** Full teardown (context loss / test seam). */
export function disposeFarTerrain() {
  if (!_state) return;
  for (const patch of _state.patches.values()) disposePatch(patch);
  _state.patches.clear();
  try { _state.group.parent?.remove(_state.group); } catch (_) { /* detached */ }
  try { _state.vtTex?.dispose(); _state.mergeTex?.dispose(); } catch (_) { /* nothing */ }
  try { _state.material?.dispose(); } catch (_) { /* nothing */ }
  _state = null;
}
