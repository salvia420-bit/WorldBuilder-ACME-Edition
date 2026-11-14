// scene3d/terrain_shore.js — Ocean Coastline (Starfish & Seashells) and River
// Shore (Flow-Aligned Washed-Ashore Driftwood Logs) Scatter (Item 6A).
//
// Built on `terrain_scatter.js` (`createScatterPool`) and `terrain_oracle.js`
// (`oceanShoreAt` / `riverShoreAt`). Three camera-scoped opaque lit
// `InstancedMesh` pools with `instanceColor` bound directly to the pool's
// `aTint` buffer (zero duplicate buffers, zero per-frame allocations,
// `castShadow = false`, no lights added, no `.visible` writes, no `Math.random`).

import {
  FAM_GRASS,
  FAM_SAND,
  FAM_ROCK,
  FAM_SNOWICE,
  FAM_SWAMP,
  FAM_DIRT,
  FAM_OBSIDIAN,
  FAM_ASH,
} from "./terrain_families.js";
import { createScatterPool, SCATTER_FADE_GLSL } from "./terrain_scatter.js";
import { oceanShoreAt, riverShoreAt } from "./terrain_oracle.js";
import { waterFlowTable } from "./terrain_water_flow.js";
import { rustScatterPlanner } from "./rust/terrain_fx.js";
import {
  RETAIL_LIGHT_TICK_SEC,
  createRetailLightTick,
  retailLightTick,
  lightTickResetEnabled,
} from "./retail_light_tick.js";
import {
  registerTerrainVfx,
  unregisterTerrainVfx,
  lbKeyFromXY,
  wireframeActive,
} from "./terrain_vfx.js";
import {
  terrainVfxEnabled,
  grassOffRoadEnabled,
} from "./vfx_flags.js";
import { visualEnabled } from "./vfx_catalog.js";
import { withLogDepth } from "./shader_logdepth.js";

export const SHORE_STARFISH_PROVIDER_ID = "terrain.shoreStarfish";
export const SHORE_SHELL_PROVIDER_ID = "terrain.shoreShells";
export const SHORE_DRIFTWOOD_PROVIDER_ID = "terrain.shoreDriftwood";

export const SHORE_LIGHT_TICK_SEC = RETAIL_LIGHT_TICK_SEC;
export const SHORE_AMBIENT_MINIMUM = 0.2;

/** Non-water families eligible to carry shoreline scatter. */
export const SHORE_ACCEPTED_FAMILIES = Object.freeze([
  FAM_SAND,
  FAM_GRASS,
  FAM_DIRT,
  FAM_ROCK,
  FAM_SWAMP,
  FAM_SNOWICE,
  FAM_OBSIDIAN,
  FAM_ASH,
]);

/** Ocean starfish instance palette (linear RGB): warm coral, ochre, crimson-orange, sandy-tan. */
export const STARFISH_PALETTE = Object.freeze([
  Object.freeze([0.64, 0.23, 0.15]), // warm coral
  Object.freeze([0.59, 0.37, 0.13]), // golden ochre
  Object.freeze([0.56, 0.15, 0.09]), // crimson-orange
  Object.freeze([0.53, 0.43, 0.30]), // sandy-tan
]);

/** Ocean seashell instance palette (linear RGB): pearlescent ivory, bleached cream, rose-shell, warm tan. */
export const SEASHELL_PALETTE = Object.freeze([
  Object.freeze([0.75, 0.72, 0.67]), // pearlescent ivory
  Object.freeze([0.79, 0.75, 0.65]), // bleached cream
  Object.freeze([0.68, 0.50, 0.47]), // rose-shell
  Object.freeze([0.58, 0.46, 0.33]), // warm tan
]);

/** River driftwood instance palette (linear RGB), modulating the wet-bark -> bleached-silver vertex gradient. */
export const DRIFTWOOD_PALETTE = Object.freeze([
  Object.freeze([0.66, 0.64, 0.60]), // sun-bleached silver-grey
  Object.freeze([0.58, 0.54, 0.48]), // weathered river ash
  Object.freeze([0.54, 0.45, 0.36]), // damp driftwood tan
  Object.freeze([0.49, 0.40, 0.33]), // aged cedar-taupe
]);

export const SHORE_TUNING = Object.freeze({
  radiusM: 56,
  fadeFraction: 0.22,
  sliceSize: 384,
  scanBudget: 1536,
  jitter: 0.88,
  starfishCount: 1600,
  starfishScaleMinM: 0.14,
  starfishScaleMaxM: 0.25,
  starfishSinkM: 0.004,
  starfishMaxTiltRad: 0.10,
  shellCount: 2500,
  shellScaleMinM: 0.08,
  shellScaleMaxM: 0.16,
  shellSinkM: 0.003,
  shellMaxTiltRad: 0.16,
  driftwoodCount: 1600,
  driftwoodLengthMinM: 0.85,
  driftwoodLengthMaxM: 2.15,
  driftwoodDiamMinM: 0.105,
  driftwoodDiamMaxM: 0.225,
  driftwoodSinkM: 0.035,
  driftwoodMaxYawJitterRad: (25 * Math.PI) / 180,
  driftwoodMaxTiltRad: 0.08,
  shoreExposure: 0.80,
});

export const SHORE_SCHEMA = Object.freeze([
  { name: "aOffset", itemSize: 3 },
  { name: "aScale", itemSize: 3 },
  { name: "aNormal", itemSize: 3 },
  { name: "aTint", itemSize: 3 },
  { name: "aShore", itemSize: 3 }, // (yaw, tilt, wetSheen)
]);

// ---------------------------------------------------------------------------
// Deterministic spatial noise & basis helpers (pure JS, no THREE, no Math.random)
// ---------------------------------------------------------------------------

function hash21(ix, iy) {
  let h = (Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise2D(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash21(ix, iy);
  const b = hash21(ix + 1, iy);
  const c = hash21(ix, iy + 1);
  const d = hash21(ix + 1, iy + 1);
  return (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uy;
}

/** Deterministic tide-wrack clumping field in [0, 1] (~9 m + ~3.4 m scales). */
export function wrackClumpValue(wx, wy) {
  const n0 = valueNoise2D(wx * 0.11, wy * 0.11);
  const n1 = valueNoise2D(wx * 0.29 + 17.3, wy * 0.29 - 9.1);
  return n0 * 0.65 + n1 * 0.35;
}

/**
 * Orthonormal shore-hugging basis matching `SHORE_VERTEX_GLSL`.
 * `yaw = 0` aligns `ex` horizontally with `+X` (east) and `yaw = PI/2` with `+Y`
 * (north), projected cleanly into the tangent plane of ground normal `(nx, ny, nz)`.
 * Therefore `yaw = Math.atan2(ty, tx)` aligns the mesh's `+X` long axis directly
 * along shoreline/river-flow tangent `(tx, ty)`.
 */
export function shoreBasis(nx, ny, nz, yaw, tilt, out) {
  const o = out || {
    ex: { x: 1, y: 0, z: 0 },
    ey: { x: 0, y: 1, z: 0 },
    up: { x: 0, y: 0, z: 1 },
  };
  let ux = Number.isFinite(nx) ? nx : 0;
  let uy = Number.isFinite(ny) ? ny : 0;
  let uz = Number.isFinite(nz) ? nz : 1;
  const nl = Math.hypot(ux, uy, uz);
  if (nl > 1e-6) {
    ux /= nl; uy /= nl; uz /= nl;
  } else {
    ux = 0; uy = 0; uz = 1;
  }

  const cy = Math.cos(yaw || 0);
  const sy = Math.sin(yaw || 0);
  // Project horizontal heading h = (cy, sy, 0) onto the ground tangent plane.
  const hDotUp = cy * ux + sy * uy;
  let ex = cy - ux * hDotUp;
  let ey = sy - uy * hDotUp;
  let ez = -uz * hDotUp;
  const el = Math.hypot(ex, ey, ez);
  if (el > 1e-6) {
    ex /= el; ey /= el; ez /= el;
  } else {
    ex = 1; ey = 0; ez = 0;
  }
  // eyVec = cross(up, ex)
  const bx = uy * ez - uz * ey;
  const by = uz * ex - ux * ez;
  const bz = ux * ey - uy * ex;

  const tRad = Number.isFinite(tilt) ? tilt : 0;
  const ct = Math.cos(tRad);
  const st = Math.sin(tRad);
  o.up.x = ux * ct + ex * st;
  o.up.y = uy * ct + ey * st;
  o.up.z = uz * ct + ez * st;
  o.ex.x = ex * ct - ux * st;
  o.ex.y = ey * ct - uy * st;
  o.ex.z = ez * ct - uz * st;
  o.ey.x = bx;
  o.ey.y = by;
  o.ey.z = bz;
  return o;
}

/** Convert `skyLightingController._lastState` to AC-frame sun + ambient terms. */
export function shoreSunFromSkyState(state, out) {
  const o = out || {
    ok: false, x: 0, y: 0, z: 1,
    sun: [1, 1, 1], amb: [1, 1, 1], ambLevel: SHORE_AMBIENT_MINIMUM,
  };
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
  o.ambLevel = Math.max(SHORE_AMBIENT_MINIMUM, Number.isFinite(ab) ? ab : 0);
  o.ok = true;
  return o;
}

// ---------------------------------------------------------------------------
// Opaque lit GLSL (ASCII only, no backticks, no double underscores)
// ---------------------------------------------------------------------------

export const SHORE_VERTEX_GLSL = `
precision highp float;

attribute vec3 color;
attribute vec3 aOffset;
attribute vec3 aScale;
attribute vec3 aNormal;
attribute vec3 aTint;
attribute vec3 aShore;

uniform vec3  uSunDir;
uniform vec3  uSunColour;
uniform vec3  uAmbColour;
uniform float uAmbLevel;
uniform float uShoreExposure;

const float INV_PI = 0.318309886;

varying vec3 vLight;
varying vec3 vAlbedo;

${SCATTER_FADE_GLSL}

void main() {
  vec3 up = aNormal;
  float nl = length(up);
  up = nl > 1e-6 ? up / nl : vec3(0.0, 0.0, 1.0);

  float cy = cos(aShore.x);
  float sy = sin(aShore.x);
  vec3 hDir = vec3(cy, sy, 0.0);
  vec3 exProj = hDir - up * dot(hDir, up);
  float el = length(exProj);
  vec3 ex = el > 1e-6 ? exProj / el : vec3(1.0, 0.0, 0.0);
  vec3 ey = cross(up, ex);

  float ct = cos(aShore.y);
  float st = sin(aShore.y);
  vec3 up2 = up * ct + ex * st;
  vec3 ex2 = ex * ct - up * st;

  vec3 anchor = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float fade = hbScatterFade(anchor.xy);
  vec3 s = aScale * fade;

  vec3 local = ex2 * (position.x * s.x) + ey * (position.y * s.y) + up2 * (position.z * s.z);
  vec4 placed = instanceMatrix * vec4(local, 1.0);

  vec3 inv = 1.0 / max(s, vec3(1e-4));
  vec3 nAc = normalize(ex2 * (normal.x * inv.x) + ey * (normal.y * inv.y) + up2 * (normal.z * inv.z));
  float ndl = clamp(dot(nAc, uSunDir), 0.0, 1.0);
  float upDot = dot(nAc, up);
  float baseAo = smoothstep(-0.32, 0.24, position.z);
  float faceAo = mix(0.36, 0.96, smoothstep(-0.25, 0.80, upDot)) * mix(0.62, 1.0, baseAo);
  float sunAo = smoothstep(-0.10, 0.45, upDot) * mix(0.68, 1.0, baseAo);
  // Subtle damp-shore sky sheen on wet shells / starfish dorsal ridges.
  float wetLift = aShore.z * max(0.0, upDot) * 0.14;
  vec3 ambIrr = uAmbColour * uAmbLevel;
  vLight = (ambIrr * (faceAo + wetLift) + uSunColour * (ndl * sunAo + wetLift * ndl)) * (INV_PI * uShoreExposure);
  vAlbedo = color * aTint;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(placed.xyz, 1.0);
}
`;

export const SHORE_FRAGMENT_GLSL = `
precision highp float;

varying vec3 vLight;
varying vec3 vAlbedo;

void main() {
  gl_FragColor = vec4(vAlbedo * vLight, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Low-poly procedural mesh builders (pure arrays + optional THREE wrapper)
// ---------------------------------------------------------------------------

function emitFlatTri(outPos, outNrm, outCol, cursor, a, b, c, ca, cb, cc) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;

  const vs = [a, b, c];
  const cs = [ca, cb, cc];
  let w = cursor;
  for (let k = 0; k < 3; k += 1) {
    const v = vs[k];
    const col = cs[k];
    outPos[w] = v[0]; outPos[w + 1] = v[1]; outPos[w + 2] = v[2];
    outNrm[w] = nx;   outNrm[w + 1] = ny;   outNrm[w + 2] = nz;
    outCol[w] = col[0]; outCol[w + 1] = col[1]; outCol[w + 2] = col[2];
    w += 3;
  }
  return w;
}

function wrapBufferGeometry(THREE, data, name) {
  if (!THREE) return null;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
  geom.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
  geom.setAttribute("color", new THREE.BufferAttribute(data.colors, 3));
  geom.name = name;
  return geom;
}

/**
 * 5-armed sea star mesh data: 20 triangles (arched central disc + 5 tapered arms
 * hugging the beach normal, unit diameter 1.0).
 */
export function starfishMeshData() {
  const triCount = 20;
  const positions = new Float32Array(triCount * 9);
  const normals = new Float32Array(triCount * 9);
  const colors = new Float32Array(triCount * 9);

  const apex = [0, 0, 0.165];
  const colApex = [1.10, 1.05, 0.98];
  const colSpine = [1.06, 1.01, 0.95];
  const colValley = [0.76, 0.70, 0.66];
  const colTip = [0.92, 0.86, 0.80];

  const valleys = [];
  const spines = [];
  const tips = [];
  for (let k = 0; k < 5; k += 1) {
    const aArm = (k * 2 * Math.PI) / 5;
    const aVal = ((k + 0.5) * 2 * Math.PI) / 5;
    const twist = (k % 2 === 0 ? 0.045 : -0.035);
    spines.push([0.255 * Math.cos(aArm), 0.255 * Math.sin(aArm), 0.112]);
    valleys.push([0.155 * Math.cos(aVal), 0.155 * Math.sin(aVal), 0.036]);
    tips.push([0.50 * Math.cos(aArm + twist), 0.50 * Math.sin(aArm + twist), 0.004]);
  }

  let w = 0;
  for (let k = 0; k < 5; k += 1) {
    const vPrev = valleys[(k + 4) % 5];
    const vNext = valleys[k];
    const m = spines[k];
    const t = tips[k];
    w = emitFlatTri(positions, normals, colors, w, apex, vPrev, m, colApex, colValley, colSpine);
    w = emitFlatTri(positions, normals, colors, w, apex, m, vNext, colApex, colSpine, colValley);
    w = emitFlatTri(positions, normals, colors, w, m, vPrev, t, colSpine, colValley, colTip);
    w = emitFlatTri(positions, normals, colors, w, vNext, m, t, colValley, colSpine, colTip);
  }
  return { positions, normals, colors, triCount };
}

export function buildStarfishGeometry(THREE) {
  return wrapBufferGeometry(THREE, starfishMeshData(), "shore-starfish");
}

/**
 * Pleated radial scallop-fan seashell mesh data: 16 triangles (hinge umbo +
 * 2 auricle ears + vaulted radial ribs & corrugated outer margin, unit span ~0.92).
 */
export function seashellMeshData() {
  const triCount = 16;
  const positions = new Float32Array(triCount * 9);
  const normals = new Float32Array(triCount * 9);
  const colors = new Float32Array(triCount * 9);

  const umbo = [-0.44, 0.0, 0.025];
  const earL = [-0.38, -0.22, 0.010];
  const earR = [-0.38, 0.22, 0.010];
  const colUmbo = [0.88, 0.84, 0.80];
  const colEar = [0.82, 0.78, 0.74];
  const colRidge = [1.08, 1.06, 1.02];
  const colFlute = [0.85, 0.81, 0.78];

  const arch = [];
  const archCols = [];
  for (let i = 0; i < 5; i += 1) {
    const t = i / 4;
    const ang = (-62 + t * 124) * (Math.PI / 180);
    const dome = Math.cos((t - 0.5) * Math.PI * 0.9);
    const rib = (i % 2 === 0) ? 0.028 : -0.012;
    arch.push([-0.44 + 0.45 * Math.cos(ang), 0.45 * Math.sin(ang), 0.09 + 0.11 * dome + rib]);
    archCols.push((i % 2 === 0) ? colRidge : colFlute);
  }

  const rim = [];
  const rimCols = [];
  for (let i = 0; i < 6; i += 1) {
    const t = i / 5;
    const ang = (-66 + t * 132) * (Math.PI / 180);
    const r = 0.90 + (i % 2 === 0 ? 0.035 : -0.015);
    const z = (i % 2 === 0) ? 0.068 : 0.010;
    rim.push([-0.44 + r * Math.cos(ang), r * Math.sin(ang), z]);
    rimCols.push((i % 2 === 0) ? colRidge : colFlute);
  }

  let w = 0;
  // Hinge auricle ears + basal hinge lip (3 tris)
  w = emitFlatTri(positions, normals, colors, w, umbo, earL, arch[0], colUmbo, colEar, archCols[0]);
  w = emitFlatTri(positions, normals, colors, w, umbo, arch[4], earR, colUmbo, archCols[4], colEar);
  w = emitFlatTri(positions, normals, colors, w, umbo, earR, earL, colUmbo, colEar, colEar);
  // Upper umbo vault fan (4 tris)
  for (let i = 0; i < 4; i += 1) {
    w = emitFlatTri(positions, normals, colors, w, umbo, arch[i], arch[i + 1], colUmbo, archCols[i], archCols[i + 1]);
  }
  // Corrugated pleated radial margin (9 tris -> 3 + 4 + 9 = 16 tris total)
  for (let i = 0; i < 4; i += 1) {
    w = emitFlatTri(positions, normals, colors, w, arch[i], rim[i], rim[i + 1], archCols[i], rimCols[i], rimCols[i + 1]);
    w = emitFlatTri(positions, normals, colors, w, arch[i], rim[i + 1], arch[i + 1], archCols[i], rimCols[i + 1], archCols[i + 1]);
  }
  w = emitFlatTri(positions, normals, colors, w, arch[4], rim[4], rim[5], archCols[4], rimCols[4], rimCols[5]);

  return { positions, normals, colors, triCount };
}

export function buildSeashellGeometry(THREE) {
  return wrapBufferGeometry(THREE, seashellMeshData(), "shore-seashell");
}

function driftwoodColorForZ(z) {
  // Wet dark-bark underside (z <= -0.25) -> sun-bleached silver-grey crown (z >= +0.35).
  const t = Math.max(0, Math.min(1, (z + 0.30) / 0.68));
  const r = 0.24 + (0.94 - 0.24) * t;
  const g = 0.18 + (0.91 - 0.18) * t;
  const b = 0.13 + (0.86 - 0.13) * t;
  return [r, g, b];
}

/**
 * Weathered river driftwood log / forked branch mesh data: 24 triangles
 * (5-sided tapered bark trunk + splintered broken root & tip cones + 4-tri
 * forked side branch stub; unit length x in [-0.50, +0.50], wet dark-bark base
 * to sun-bleached silver-grey top vertex color gradient).
 */
export function driftwoodLogMeshData() {
  const triCount = 24;
  const positions = new Float32Array(triCount * 9);
  const normals = new Float32Array(triCount * 9);
  const colors = new Float32Array(triCount * 9);

  // Pentagonal cross-section angles: top crown ridge at +Z (90 deg), two upper
  // flanks, and two wet embedded lower flanks.
  const ring0 = [];
  const ring1 = [];
  const col0 = [];
  const col1 = [];
  const xJit0 = [-0.43, -0.45, -0.41, -0.44, -0.42];
  const xJit1 = [0.42, 0.40, 0.44, 0.43, 0.41];
  for (let k = 0; k < 5; k += 1) {
    const theta = Math.PI * 0.5 + (k * 2 * Math.PI) / 5;
    const cy = Math.cos(theta);
    const sz = Math.sin(theta);
    const p0 = [xJit0[k], cy * 0.50 - 0.02, sz * 0.48];
    const p1 = [xJit1[k], cy * 0.36 + 0.03, sz * 0.35];
    ring0.push(p0);
    ring1.push(p1);
    col0.push(driftwoodColorForZ(p0[2]));
    col1.push(driftwoodColorForZ(p1[2]));
  }
  const rootTip = [-0.50, -0.03, -0.05];
  const rootCol = driftwoodColorForZ(rootTip[2]);
  const crownTip = [0.50, 0.05, 0.02];
  const crownCol = driftwoodColorForZ(crownTip[2]);

  let w = 0;
  // 1. Trunk bark facets (5 quads = 10 tris, outward normals around +X axis).
  for (let k = 0; k < 5; k += 1) {
    const kn = (k + 1) % 5;
    w = emitFlatTri(positions, normals, colors, w, ring0[k], ring0[kn], ring1[kn], col0[k], col0[kn], col1[kn]);
    w = emitFlatTri(positions, normals, colors, w, ring0[k], ring1[kn], ring1[k], col0[k], col1[kn], col1[k]);
  }
  // 2. Splintered broken root cone (5 tris).
  for (let k = 0; k < 5; k += 1) {
    const kn = (k + 1) % 5;
    w = emitFlatTri(positions, normals, colors, w, rootTip, ring0[kn], ring0[k], rootCol, col0[kn], col0[k]);
  }
  // 3. Splintered broken distal tip cone (5 tris).
  for (let k = 0; k < 5; k += 1) {
    const kn = (k + 1) % 5;
    w = emitFlatTri(positions, normals, colors, w, ring1[k], ring1[kn], crownTip, col1[k], col1[kn], crownCol);
  }
  // 4. Angled side branch stub jutting forward-and-outward (4 tris -> 24 tris total).
  const b0 = [0.02, 0.22, 0.28];
  const b1 = [0.16, 0.26, 0.12];
  const b2 = [0.07, 0.38, 0.08];
  const bTip = [0.29, 1.05, 0.62];
  const cb0 = driftwoodColorForZ(b0[2]);
  const cb1 = driftwoodColorForZ(b1[2]);
  const cb2 = driftwoodColorForZ(b2[2]);
  const cbT = driftwoodColorForZ(0.42);
  w = emitFlatTri(positions, normals, colors, w, b0, b2, bTip, cb0, cb2, cbT);
  w = emitFlatTri(positions, normals, colors, w, b2, b1, bTip, cb2, cb1, cbT);
  w = emitFlatTri(positions, normals, colors, w, b1, b0, bTip, cb1, cb0, cbT);
  w = emitFlatTri(positions, normals, colors, w, b0, b1, b2, cb0, cb1, cb2);

  return { positions, normals, colors, triCount };
}

export function buildDriftwoodLogGeometry(THREE) {
  return wrapBufferGeometry(THREE, driftwoodLogMeshData(), "shore-driftwood-log");
}

// ---------------------------------------------------------------------------
// Shared material & lighting driver for opaque lit shore pools
// ---------------------------------------------------------------------------

function makeShoreUniforms(THREE, globals) {
  const vec3 = (x, y, z) => (THREE ? new THREE.Vector3(x, y, z) : { x, y, z, set(nx, ny, nz) { this.x = nx; this.y = ny; this.z = nz; } });
  return {
    uTime: globals && globals.uTime ? globals.uTime : { value: 0 },
    uSunDir: { value: vec3(0.35, 0.45, 0.82) },
    uSunColour: { value: vec3(0.95, 0.90, 0.80) },
    uAmbColour: { value: vec3(0.55, 0.62, 0.72) },
    uAmbLevel: { value: 0.42 },
    uShoreExposure: { value: SHORE_TUNING.shoreExposure },
  };
}

function buildShoreMaterial(THREE, uniforms, name) {
  if (!THREE) return null;
  const mat = new THREE.ShaderMaterial(withLogDepth({
    name,
    uniforms,
    vertexShader: SHORE_VERTEX_GLSL,
    fragmentShader: SHORE_FRAGMENT_GLSL,
    transparent: false,
    depthWrite: true,
    depthTest: true,
  }));
  return mat;
}

function attachInstanceColorAlias(pool, geometry) {
  if (pool && pool.mesh && geometry && typeof geometry.getAttribute === "function") {
    const tintAttr = geometry.getAttribute("aTint");
    if (tintAttr) {
      pool.mesh.instanceColor = tintAttr;
    }
    pool.mesh.castShadow = false;
    pool.mesh.receiveShadow = false;
  }
}

function createLightSync(uniforms, lightTick, readStateTick) {
  let _lightT = 0;
  const privTick = lightTick && typeof lightTick.sync === "function"
    ? lightTick
    : createRetailLightTick({ periodSec: SHORE_LIGHT_TICK_SEC, now: () => _lightT });
  const sunScratch = {
    ok: false, x: 0, y: 0, z: 1,
    sun: [1, 1, 1], amb: [1, 1, 1], ambLevel: SHORE_AMBIENT_MINIMUM,
  };
  let lastEpoch = null;
  let lightCommits = 0;

  return {
    sync(tSec, skyState) {
      _lightT = Number.isFinite(tSec) ? tSec : 0;
      const stamp = typeof readStateTick === "function" ? readStateTick() : undefined;
      const epoch = privTick.sync(stamp);
      if (epoch !== lastEpoch && skyState) {
        const s = shoreSunFromSkyState(skyState, sunScratch);
        if (s.ok) {
          uniforms.uSunDir.value.set(s.x, s.y, s.z);
          uniforms.uSunColour.value.set(s.sun[0], s.sun[1], s.sun[2]);
          uniforms.uAmbColour.value.set(s.amb[0], s.amb[1], s.amb[2]);
          uniforms.uAmbLevel.value = s.ambLevel;
          lastEpoch = epoch;
          lightCommits += 1;
        }
      }
    },
    get commits() {
      return lightCommits;
    },
  };
}

function writePaletteColor(arr, base, palette, rPick, rJitter) {
  const idx = Math.min(palette.length - 1, Math.floor(rPick * palette.length));
  const c = palette[idx];
  const j = 0.92 + rJitter * 0.16;
  arr[base] = c[0] * j;
  arr[base + 1] = c[1] * j;
  arr[base + 2] = c[2] * j;
}

// ---------------------------------------------------------------------------
// Individual pool constructors (pure-Node testable with or without THREE)
// ---------------------------------------------------------------------------

export function createStarfishField(opts = {}) {
  const THREE = opts.THREE || null;
  const getOracle = typeof opts.oracle === "function" ? opts.oracle : () => opts.oracle || null;
  const uniforms = makeShoreUniforms(THREE, opts.globals);
  const geometry = buildStarfishGeometry(THREE);
  const material = buildShoreMaterial(THREE, uniforms, "terrain-shore-starfish");
  const shoreScratch = {};
  const light = createLightSync(uniforms, opts.lightTick, opts.readStateTick);

  const pool = createScatterPool({
    THREE,
    geometry,
    material,
    parent: opts.parent || null,
    oracle: getOracle,
    uniforms,
    count: opts.count ?? SHORE_TUNING.starfishCount,
    radiusM: opts.radiusM ?? SHORE_TUNING.radiusM,
    sliceSize: opts.sliceSize ?? SHORE_TUNING.sliceSize,
    scanBudget: opts.scanBudget ?? SHORE_TUNING.scanBudget,
    fadeFraction: opts.fadeFraction ?? SHORE_TUNING.fadeFraction,
    jitter: opts.jitter ?? SHORE_TUNING.jitter,
    shape: "square",
    fadeShape: "disc",
    seed: (opts.seed ?? 0x57a2f154) | 0,
    randSalt: 11,
    families: SHORE_ACCEPTED_FAMILIES,
    offRoad: opts.offRoad ?? true,
    exclude: opts.exclude || null,
    attributes: SHORE_SCHEMA,
    name: "terrain-shore-starfish",
    writeInstanceMatrix: true,
    frustumCulled: false,
    scanPlanner: rustScatterPlanner(),
    accept(_sample, ctx) {
      const orc = getOracle();
      const hit = oceanShoreAt(orc, ctx.x, ctx.y, shoreScratch);
      if (!hit) return false;
      // Clump along tide-wrack bands so starfish gather in natural coastal clusters.
      const clump = wrackClumpValue(ctx.x, ctx.y);
      const keepProb = 0.18 + 0.56 * hit.wrack + 0.34 * Math.max(0, clump - 0.38);
      return ctx.rand(0) < keepProb;
    },
    fill(ctx) {
      const scaleMin = SHORE_TUNING.starfishScaleMinM;
      const scaleMax = SHORE_TUNING.starfishScaleMaxM;
      const d = scaleMin + ctx.rand(1) * (scaleMax - scaleMin);
      const aspect = 0.92 + ctx.rand(2) * 0.16;
      const arch = 0.85 + ctx.rand(3) * 0.35;
      const sBase = ctx.offsets.aScale;
      const sArr = ctx.arrays.aScale;
      sArr[sBase] = d;
      sArr[sBase + 1] = d * aspect;
      sArr[sBase + 2] = d * arch;

      writePaletteColor(ctx.arrays.aTint, ctx.offsets.aTint, STARFISH_PALETTE, ctx.rand(4), ctx.rand(5));

      const shBase = ctx.offsets.aShore;
      const shArr = ctx.arrays.aShore;
      shArr[shBase] = ctx.rand(6) * Math.PI * 2;
      shArr[shBase + 1] = (ctx.rand(7) - 0.5) * 2 * SHORE_TUNING.starfishMaxTiltRad;
      shArr[shBase + 2] = 0.65;
      ctx.z -= SHORE_TUNING.starfishSinkM;
    },
  });
  attachInstanceColorAlias(pool, geometry);

  return {
    pool,
    geometry,
    material,
    uniforms,
    update(dt, tSec, px, py, pz, skyState) {
      light.sync(tSec, skyState);
      return pool.update(dt, px, py, pz);
    },
    stats() {
      return { ...pool.stats(), lightCommits: light.commits };
    },
    dispose() {
      pool.dispose();
      if (geometry) { try { geometry.dispose(); } catch (_) {} }
      if (material) { try { material.dispose(); } catch (_) {} }
    },
  };
}

export function createSeashellField(opts = {}) {
  const THREE = opts.THREE || null;
  const getOracle = typeof opts.oracle === "function" ? opts.oracle : () => opts.oracle || null;
  const uniforms = makeShoreUniforms(THREE, opts.globals);
  const geometry = buildSeashellGeometry(THREE);
  const material = buildShoreMaterial(THREE, uniforms, "terrain-shore-shells");
  const shoreScratch = {};
  const light = createLightSync(uniforms, opts.lightTick, opts.readStateTick);

  const pool = createScatterPool({
    THREE,
    geometry,
    material,
    parent: opts.parent || null,
    oracle: getOracle,
    uniforms,
    count: opts.count ?? SHORE_TUNING.shellCount,
    radiusM: opts.radiusM ?? SHORE_TUNING.radiusM,
    sliceSize: opts.sliceSize ?? SHORE_TUNING.sliceSize,
    scanBudget: opts.scanBudget ?? SHORE_TUNING.scanBudget,
    fadeFraction: opts.fadeFraction ?? SHORE_TUNING.fadeFraction,
    jitter: opts.jitter ?? 0.90,
    shape: "square",
    fadeShape: "disc",
    seed: (opts.seed ?? 0x54e11c0a) | 0,
    randSalt: 23,
    families: SHORE_ACCEPTED_FAMILIES,
    offRoad: opts.offRoad ?? true,
    exclude: opts.exclude || null,
    attributes: SHORE_SCHEMA,
    name: "terrain-shore-shells",
    writeInstanceMatrix: true,
    frustumCulled: false,
    scanPlanner: rustScatterPlanner(),
    accept(_sample, ctx) {
      const orc = getOracle();
      const hit = oceanShoreAt(orc, ctx.x, ctx.y, shoreScratch);
      if (!hit) return false;
      // Higher density along the high-tide swash line.
      const clump = wrackClumpValue(ctx.x * 1.35 + 41.0, ctx.y * 1.35 - 19.0);
      const keepProb = 0.24 + 0.62 * hit.swash + 0.22 * clump;
      return ctx.rand(0) < keepProb;
    },
    fill(ctx) {
      const scaleMin = SHORE_TUNING.shellScaleMinM;
      const scaleMax = SHORE_TUNING.shellScaleMaxM;
      const d = scaleMin + ctx.rand(1) * (scaleMax - scaleMin);
      const elongate = 0.85 + ctx.rand(2) * 0.36; // fan scallop vs slightly elongated conch proportion
      const dome = 0.85 + ctx.rand(3) * 0.45;
      const sBase = ctx.offsets.aScale;
      const sArr = ctx.arrays.aScale;
      sArr[sBase] = d * elongate;
      sArr[sBase + 1] = d;
      sArr[sBase + 2] = d * dome;

      writePaletteColor(ctx.arrays.aTint, ctx.offsets.aTint, SEASHELL_PALETTE, ctx.rand(4), ctx.rand(5));

      const shBase = ctx.offsets.aShore;
      const shArr = ctx.arrays.aShore;
      shArr[shBase] = ctx.rand(6) * Math.PI * 2;
      shArr[shBase + 1] = (ctx.rand(7) - 0.5) * 2 * SHORE_TUNING.shellMaxTiltRad;
      shArr[shBase + 2] = 0.90;
      ctx.z -= SHORE_TUNING.shellSinkM;
    },
  });
  attachInstanceColorAlias(pool, geometry);

  return {
    pool,
    geometry,
    material,
    uniforms,
    update(dt, tSec, px, py, pz, skyState) {
      light.sync(tSec, skyState);
      return pool.update(dt, px, py, pz);
    },
    stats() {
      return { ...pool.stats(), lightCommits: light.commits };
    },
    dispose() {
      pool.dispose();
      if (geometry) { try { geometry.dispose(); } catch (_) {} }
      if (material) { try { material.dispose(); } catch (_) {} }
    },
  };
}

export function createDriftwoodField(opts = {}) {
  const THREE = opts.THREE || null;
  const getOracle = typeof opts.oracle === "function" ? opts.oracle : () => opts.oracle || null;
  const uniforms = makeShoreUniforms(THREE, opts.globals);
  const geometry = buildDriftwoodLogGeometry(THREE);
  const material = buildShoreMaterial(THREE, uniforms, "terrain-shore-driftwood");
  const shoreScratch = {};
  const light = createLightSync(uniforms, opts.lightTick, opts.readStateTick);

  const pool = createScatterPool({
    THREE,
    geometry,
    material,
    parent: opts.parent || null,
    oracle: getOracle,
    uniforms,
    count: opts.count ?? SHORE_TUNING.driftwoodCount,
    radiusM: opts.radiusM ?? SHORE_TUNING.radiusM,
    sliceSize: opts.sliceSize ?? SHORE_TUNING.sliceSize,
    scanBudget: opts.scanBudget ?? SHORE_TUNING.scanBudget,
    fadeFraction: opts.fadeFraction ?? SHORE_TUNING.fadeFraction,
    jitter: opts.jitter ?? 0.85,
    shape: "square",
    fadeShape: "disc",
    seed: (opts.seed ?? 0xd21f7b00) | 0,
    randSalt: 37,
    families: SHORE_ACCEPTED_FAMILIES,
    offRoad: opts.offRoad ?? true,
    exclude: opts.exclude || null,
    attributes: SHORE_SCHEMA,
    name: "terrain-shore-driftwood",
    writeInstanceMatrix: true,
    frustumCulled: false,
    scanPlanner: rustScatterPlanner(),
    accept(_sample, ctx) {
      const orc = getOracle();
      const hit = riverShoreAt(orc, ctx.x, ctx.y, shoreScratch);
      if (!hit) return false;
      // Driftwood strands preferentially near the lower-to-mid bank (0.04..0.75 m above water).
      const bankBias = Math.max(0.25, 1.0 - Math.max(0, hit.bankHeight - 0.35) * 0.75);
      const barClump = wrackClumpValue(ctx.x * 0.65 - 12.0, ctx.y * 0.65 + 31.0);
      const keepProb = (0.28 + 0.44 * barClump) * bankBias;
      return ctx.rand(0) < keepProb;
    },
    fill(ctx) {
      const orc = getOracle();
      const hit = riverShoreAt(orc, ctx.x, ctx.y, shoreScratch);
      const tx = hit ? hit.tx : 1.0;
      const ty = hit ? hit.ty : 0.0;

      const lenMin = SHORE_TUNING.driftwoodLengthMinM;
      const lenMax = SHORE_TUNING.driftwoodLengthMaxM;
      const lengthM = lenMin + ctx.rand(1) * (lenMax - lenMin);
      const diamMin = SHORE_TUNING.driftwoodDiamMinM;
      const diamMax = SHORE_TUNING.driftwoodDiamMaxM;
      const diamM = (diamMin + ctx.rand(2) * (diamMax - diamMin)) * (0.85 + 0.25 * ctx.rand(1));

      const sBase = ctx.offsets.aScale;
      const sArr = ctx.arrays.aScale;
      sArr[sBase] = lengthM;
      sArr[sBase + 1] = diamM;
      sArr[sBase + 2] = diamM * 0.92;

      writePaletteColor(ctx.arrays.aTint, ctx.offsets.aTint, DRIFTWOOD_PALETTE, ctx.rand(3), ctx.rand(4));

      // Align log along river flow / shoreline tangent (tx, ty) +- 25 deg.
      const baseYaw = Math.atan2(ty, tx);
      const yawJitter = (ctx.rand(5) - 0.5) * 2 * SHORE_TUNING.driftwoodMaxYawJitterRad;
      const shBase = ctx.offsets.aShore;
      const shArr = ctx.arrays.aShore;
      shArr[shBase] = baseYaw + yawJitter;
      shArr[shBase + 1] = (ctx.rand(6) - 0.5) * 2 * SHORE_TUNING.driftwoodMaxTiltRad;
      shArr[shBase + 2] = 0.22;

      // Half-bury log in wet bank mud/sand (sinkM = 0.035 m).
      ctx.z -= SHORE_TUNING.driftwoodSinkM;
    },
  });
  attachInstanceColorAlias(pool, geometry);

  return {
    pool,
    geometry,
    material,
    uniforms,
    update(dt, tSec, px, py, pz, skyState) {
      light.sync(tSec, skyState);
      return pool.update(dt, px, py, pz);
    },
    stats() {
      return { ...pool.stats(), lightCommits: light.commits };
    },
    dispose() {
      pool.dispose();
      if (geometry) { try { geometry.dispose(); } catch (_) {} }
      if (material) { try { material.dispose(); } catch (_) {} }
    },
  };
}

// ---------------------------------------------------------------------------
// Spine provider registration (`initShoreScatter` / `dispose`)
// ---------------------------------------------------------------------------

let _shore = null;

const _stats = {
  inits: 0,
  starfishBuilds: 0,
  shellBuilds: 0,
  driftwoodBuilds: 0,
  noSkyState: 0,
};

function _skyState() {
  if (!_shore) return null;
  try {
    if (typeof _shore.readSkyState === "function") return _shore.readSkyState() || null;
    const s = _shore.scene3d?.skyLightingController?._lastState;
    if (s) return s;
    if (typeof window !== "undefined") {
      return window.liveScene3d?.skyLightingController?._lastState || null;
    }
  } catch (_) { /* fail-soft */ }
  return null;
}

function _skyStateTick() {
  if (!_shore || typeof _shore.readSkyState === "function") return undefined;
  try {
    const c = _shore.scene3d?.skyLightingController;
    if (c && c._lastState) return c._tickCount;
    if (typeof window !== "undefined") {
      return window.liveScene3d?.skyLightingController?._tickCount;
    }
  } catch (_) { /* fail-soft */ }
  return undefined;
}

function resolveDensityMultiplier(qualityFlags, explicitDensity) {
  if (Number.isFinite(explicitDensity)) return Math.max(0, explicitDensity);
  const preset = qualityFlags && typeof qualityFlags.preset === "string"
    ? qualityFlags.preset.toLowerCase()
    : null;
  if (preset === "low") return 0;
  if (preset === "mid") return 0.6;
  if (preset === "ultra") return 1.35;
  return 1.0;
}

function _makeShoreProvider(id, fieldKey, buildCounterKey, baseCount, factoryFn) {
  let lastOracleVersion = -1;
  let lastHadFlowTable = false;
  return {
    id,
    families: SHORE_ACCEPTED_FAMILIES,
    scope: "camera",
    enabled() {
      return !!_shore && visualEnabled() && terrainVfxEnabled();
    },
    quality(flags) {
      const mul = resolveDensityMultiplier(flags, _shore ? _shore.density : undefined);
      const count = Math.round(baseCount * mul);
      return count > 0 ? { count, radiusM: _shore ? _shore.radiusM : SHORE_TUNING.radiusM } : null;
    },
    update(dt, frameCtx) {
      if (!_shore || !frameCtx || !frameCtx.hasPlayer) return;
      const orc = frameCtx.oracle || _shore.oracleRef();
      const curVer = orc && typeof orc.version === "function" ? orc.version() : -1;
      const hasFlow = !!waterFlowTable();
      if (!_shore[fieldKey]) {
        const mul = resolveDensityMultiplier(frameCtx.quality, _shore.density);
        const count = Math.round(baseCount * mul);
        if (count <= 0) return;
        _shore[fieldKey] = factoryFn({
          THREE: _shore.THREE,
          parent: _shore.parent,
          globals: _shore.globals,
          oracle: () => (frameCtx && frameCtx.oracle ? frameCtx.oracle : (_shore ? _shore.oracleRef() : null)),
          count,
          radiusM: _shore.radiusM,
          seed: _shore.seed,
          offRoad: grassOffRoadEnabled(),
          exclude: _shore.exclude,
          lightTick: _shore.sharedLightTick ? retailLightTick : null,
          readStateTick: _skyStateTick,
        });
        lastOracleVersion = curVer;
        lastHadFlowTable = hasFlow;
        _stats[buildCounterKey] += 1;
      } else if (curVer !== lastOracleVersion || (hasFlow && !lastHadFlowTable)) {
        lastOracleVersion = curVer;
        lastHadFlowTable = hasFlow;
        // Neighbor landblock or water_flow.bin arrived: re-mark cells unresolved so shoreline 4x4 checks heal cleanly.
        try { _shore[fieldKey].pool?.invalidate?.(); } catch (_) {}
      }
      const sky = _skyState();
      if (!sky) _stats.noSkyState += 1;
      const p = frameCtx.playerPos;
      _shore[fieldKey].update(dt, frameCtx.tSec, p.x, p.y, p.z, sky);
    },
    dispose() {
      lastOracleVersion = -1;
      lastHadFlowTable = false;
      if (_shore && _shore[fieldKey]) {
        _shore[fieldKey].dispose();
        _shore[fieldKey] = null;
      }
    },
  };
}

export function shoreScatterStats() {
  return {
    enabled: !!_shore && visualEnabled() && terrainVfxEnabled(),
    inited: !!_shore,
    visibleStarfish: _shore && _shore.starfish ? _shore.starfish.pool.stats().live : 0,
    visibleShells: _shore && _shore.shells ? _shore.shells.pool.stats().live : 0,
    visibleDriftwood: _shore && _shore.driftwood ? _shore.driftwood.pool.stats().live : 0,
    starfishField: _shore && _shore.starfish ? _shore.starfish.stats() : null,
    shellField: _shore && _shore.shells ? _shore.shells.stats() : null,
    driftwoodField: _shore && _shore.driftwood ? _shore.driftwood.stats() : null,
    counters: { ..._stats },
  };
}

export function disposeShoreScatter() {
  if (_shore) {
    for (const h of _shore.registered) {
      try { unregisterTerrainVfx(h.id); } catch (_) {}
    }
    if (_shore.starfish) { try { _shore.starfish.dispose(); } catch (_) {} }
    if (_shore.shells) { try { _shore.shells.dispose(); } catch (_) {} }
    if (_shore.driftwood) { try { _shore.driftwood.dispose(); } catch (_) {} }
  }
  _shore = null;
}

export function _resetShoreScatter() {
  disposeShoreScatter();
  for (const k of Object.keys(_stats)) _stats[k] = 0;
}

/**
 * Initialize and register the 3 shoreline scatter pools (`terrain.shoreStarfish`,
 * `terrain.shoreShells`, `terrain.shoreDriftwood`) with `terrain_vfx.js`.
 *
 * Call from `scene3d/index.js` right beside `initTerrainRock(...)`.
 */
export function initShoreScatter(opts = {}) {
  if (opts.enabled === false) return null;
  if (wireframeActive(opts.search)) return null;
  if (!visualEnabled() || !terrainVfxEnabled()) return null;

  if (_shore) disposeShoreScatter();

  const scene3d = opts.scene3d || null;
  _shore = {
    THREE: opts.THREE || null,
    scene3d,
    parent: opts.parent || scene3d?.terrainGroup?.parent || null,
    globals: opts.globals || null,
    readSkyState: typeof opts.readSkyState === "function" ? opts.readSkyState : null,
    sharedLightTick: lightTickResetEnabled(opts.search),
    seed: Number.isFinite(opts.seed) ? opts.seed | 0 : 0x5a02e106,
    density: Number.isFinite(opts.density) ? Math.max(0, opts.density) : undefined,
    radiusM: Number.isFinite(opts.radiusM) ? Math.max(8, opts.radiusM) : SHORE_TUNING.radiusM,
    exclude: typeof opts.exclude === "function" ? opts.exclude : null,
    starfish: null,
    shells: null,
    driftwood: null,
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

  _shore.registered.push(
    registerTerrainVfx(_makeShoreProvider(
      SHORE_STARFISH_PROVIDER_ID, "starfish", "starfishBuilds",
      opts.starfishCount ?? SHORE_TUNING.starfishCount, createStarfishField,
    )),
    registerTerrainVfx(_makeShoreProvider(
      SHORE_SHELL_PROVIDER_ID, "shells", "shellBuilds",
      opts.shellCount ?? SHORE_TUNING.shellCount, createSeashellField,
    )),
    registerTerrainVfx(_makeShoreProvider(
      SHORE_DRIFTWOOD_PROVIDER_ID, "driftwood", "driftwoodBuilds",
      opts.driftwoodCount ?? SHORE_TUNING.driftwoodCount, createDriftwoodField,
    )),
  );

  return {
    stats: shoreScatterStats,
    get starfish() { return _shore ? _shore.starfish : null; },
    get shells() { return _shore ? _shore.shells : null; },
    get driftwood() { return _shore ? _shore.driftwood : null; },
    lbKeyFromXY,
    dispose: disposeShoreScatter,
  };
}

export const initTerrainShore = initShoreScatter;
