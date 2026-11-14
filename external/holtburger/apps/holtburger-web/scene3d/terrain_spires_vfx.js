// scene3d/terrain_spires_vfx.js — Grounded world-space Shadow Spire & Obsidian
// Spire atmospheric replacement VFX (Item 7C).
//
// Replaces the removed obnoxious full-screen / 60%-viewport screen-space UV
// warps around Dereth's Shadow Spire craters and Obsidian Spire fields with two
// subtle, ominous, GPU-instanced world-space layers hugging the crater floor:
//   1. Creeping dark-violet Shadow Miasma tendrils hugging ground contours.
//   2. Slow-rising obsidian void-shard wisps / motes drifting up and dissolving.
//
// SITE DETECTION:
//   - Resident Spire Setups in `scene3d.staticsGroup` or `portal_registry`:
//     `0x020007E8`..`0x020007ED`, `0x02001681`, `0x02001582`, `0x020015B9`
//   - Known Shadow Spire / Obsidian Spire landblocks (via `terrain_vfx.js`
//     ready/park/unpark/gone lifecycle + `terrainGroup` backfill):
//     `0x472C`, `0x482C`, `0x462E`, `0xF55A`, `0xF75C`, `0x0B0C`, `0xBB9B`
//
// INVARIANTS:
//   - Zero screen-space UV distortion (`fxDistort` untouched).
//   - Zero `PointLight`s (§5.2), single shared `ShaderMaterial` per instanced
//     layer (§5.4), zero `Math.random` (§5.5), `castShadow = false` (§5.7).
//   - Optional injected `THREE`: full CPU detection, deterministic instance
//     generation, and stats run in pure Node with or without `THREE`.
//   - Logarithmic & reversed-Z depth compatible via `withLogDepth`.

import { withLogDepth } from "./shader_logdepth.js";
import { registerTerrainVfx, unregisterTerrainVfx, lbKeyFromXY } from "./terrain_vfx.js";
import { terrainSpiresEnabled } from "./vfx_flags.js";
import { staticPortalAnchors } from "./vfx/portal_registry.js";

export const SPIRES_PROVIDER_ID = "terrain.spires";
export const METERS_PER_LANDBLOCK = 192;

/** Retail Shadow Spire, Obsidian Spire, and Shadow Rift Setup DIDs. */
export const SPIRE_SETUP_IDS = Object.freeze([
  0x020007e8,
  0x020007e9,
  0x020007ea,
  0x020007eb,
  0x020007ec,
  0x020007ed,
  0x02001681,
  0x02001582,
  0x020015b9,
]);

const SPIRE_SETUP_SET = new Set(SPIRE_SETUP_IDS);

/** Known Shadow Spire & Obsidian Spire crater landblocks (16-bit 0xXXYY). */
export const SPIRE_LANDBLOCKS = Object.freeze([
  0x472c, // Obsidian Spires main crater
  0x482c, // Obsidian Spires east rim
  0x462e, // Obsidian Rim / Spire approaches
  0xf55a, // Tou-Tou Shadow Spire peninsula
  0xf75c, // Eastern Shadow Spire crater
  0x0b0c, // Singularity / SW Spire crater
  0xbb9b, // Cragstone / central Shadow Spire crater
]);

const SPIRE_LANDBLOCK_SET = new Set(SPIRE_LANDBLOCKS);

export const SPIRE_ENGAGE_M = 650;
export const MAX_ACTIVE_SPIRE_SITES = 8;

export const SPIRES_QUALITY_TIERS = Object.freeze({
  low: Object.freeze({ miasmaPerSite: 16, wispsPerSite: 20 }),
  mid: Object.freeze({ miasmaPerSite: 28, wispsPerSite: 36 }),
  high: Object.freeze({ miasmaPerSite: 42, wispsPerSite: 56 }),
  ultra: Object.freeze({ miasmaPerSite: 56, wispsPerSite: 76 }),
});

/** Deterministic [0, 1) integer hash — zero Math.random. */
export function spireHash01(seed, idx) {
  let h = ((seed | 0) ^ Math.imul((idx | 0) + 1, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

export function resolveSpiresQuality(quality) {
  const name = typeof quality === "string"
    ? quality
    : (quality && typeof quality.preset === "string" ? quality.preset
      : (quality && typeof quality.name === "string" ? quality.name : "high"));
  if (name === "low") return SPIRES_QUALITY_TIERS.low;
  if (name === "mid") return SPIRES_QUALITY_TIERS.mid;
  if (name === "ultra") return SPIRES_QUALITY_TIERS.ultra;
  return SPIRES_QUALITY_TIERS.high;
}

/** Convert 32-bit `lbKey` (`0xXXYY0000`) or 16-bit `0xXXYY` to 16-bit `0xXXYY`. */
export function lbCode16Of(keyOrCode) {
  const u = keyOrCode >>> 0;
  return u > 0xffff ? ((u >>> 16) & 0xffff) : (u & 0xffff);
}

export function isSpireSetupId(modelId) {
  return SPIRE_SETUP_SET.has(modelId >>> 0);
}

export function isSpireLandblock(lbKeyOrCode) {
  return SPIRE_LANDBLOCK_SET.has(lbCode16Of(lbKeyOrCode));
}

function _estimateCraterFloorFromLb(lbX, lbY, heights, oracle) {
  const cx = lbX * METERS_PER_LANDBLOCK + 96;
  const cy = lbY * METERS_PER_LANDBLOCK + 96;
  // Find lowest basin point inside the central 5x5 vertices of the 9x9 grid if available.
  if (heights && heights.length >= 81) {
    let bestZ = Infinity;
    let bestX = cx;
    let bestY = cy;
    for (let vy = 2; vy <= 6; vy += 1) {
      for (let vx = 2; vx <= 6; vx += 1) {
        const z = Number(heights[vy * 9 + vx]);
        if (Number.isFinite(z) && z < bestZ) {
          bestZ = z;
          bestX = lbX * METERS_PER_LANDBLOCK + vx * 24;
          bestY = lbY * METERS_PER_LANDBLOCK + vy * 24;
        }
      }
    }
    if (Number.isFinite(bestZ)) return { x: bestX, y: bestY, z: bestZ };
  }
  if (oracle && typeof oracle.heightAt === "function") {
    const oz = oracle.heightAt(cx, cy);
    if (Number.isFinite(oz)) return { x: cx, y: cy, z: oz };
  }
  return { x: cx, y: cy, z: 0 };
}

function _sampleGroundZ(x, y, fallbackZ, oracle) {
  if (oracle && typeof oracle.heightAt === "function") {
    try {
      const hz = oracle.heightAt(x, y);
      if (Number.isFinite(hz)) return hz;
    } catch (_) {}
  }
  return fallbackZ;
}

/**
 * Detect resident Shadow Spire & Obsidian Spire sites from:
 *   1. `staticPortalAnchors()` (`0x02001582`, `0x020015B9`)
 *   2. `scene3d.staticsGroup` children carrying `SPIRE_SETUP_IDS` (plain Mesh
 *      or InstancedMesh)
 *   3. Resident landblocks matching `SPIRE_LANDBLOCKS`
 *   4. Optional explicit `extraSites` (test / showcase seam)
 *
 * Deduplicates nearby detections within `mergeRadiusM` (18 m) so multi-surface
 * Spire setups and overlapping LB anchors collapse to one clean crater site.
 */
export function detectResidentSpireSites(opts = {}) {
  const scene3d = opts.scene3d || null;
  const oracle = opts.oracle || null;
  const residentLbs = opts.residentLbs || null;
  const mergeRadiusM = Number.isFinite(opts.mergeRadiusM) ? opts.mergeRadiusM : 18.0;

  const raw = [];

  // 1. Static portal registry anchors (Shadow Rifts 0x02001582 / 0x020015B9).
  const portalMap = opts.portalAnchors || staticPortalAnchors();
  if (portalMap && typeof portalMap.entries === "function") {
    for (const [anchor, sid] of portalMap.entries()) {
      const setupId = sid >>> 0;
      if (!SPIRE_SETUP_SET.has(setupId)) continue;
      if (!anchor || (anchor.parent === null && !opts.allowDetachedAnchors)) continue;
      const pos = anchor.position;
      if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
        raw.push({
          x: pos.x,
          y: pos.y,
          z: Number.isFinite(pos.z) ? pos.z : 0,
          setupId,
          lbCode: lbCode16Of(lbKeyFromXY(Math.floor(pos.x / 192), Math.floor(pos.y / 192))),
          source: "portal-registry",
          priority: 3,
          radiusM: 32,
        });
      }
    }
  }

  // 2. Resident staticsGroup nodes (Mesh, LOD, carrier, or InstancedMesh).
  const statKids = scene3d?.staticsGroup?.children;
  if (Array.isArray(statKids)) {
    for (const node of statKids) {
      if (!node || node.visible === false) continue;
      const mid = (node.userData?.modelId ?? node.userData?.setupId ?? 0) >>> 0;
      if (!SPIRE_SETUP_SET.has(mid)) continue;
      const isRift = mid === 0x02001582 || mid === 0x020015b9;
      const radiusM = isRift ? 30 : 42;

      if (node.isInstancedMesh && node.instanceMatrix?.array) {
        const arr = node.instanceMatrix.array;
        const n = Math.min(
          Number.isFinite(node.count) ? node.count : (node.userData?.instanceCount || 0),
          Math.floor(arr.length / 16),
        );
        for (let i = 0; i < n; i += 1) {
          const ix = arr[i * 16 + 12];
          const iy = arr[i * 16 + 13];
          const iz = arr[i * 16 + 14];
          if (!Number.isFinite(ix) || !Number.isFinite(iy)) continue;
          raw.push({
            x: ix,
            y: iy,
            z: _sampleGroundZ(ix, iy, Number.isFinite(iz) ? iz : 0, oracle),
            setupId: mid,
            lbCode: lbCode16Of(lbKeyFromXY(Math.floor(ix / 192), Math.floor(iy / 192))),
            source: "statics-instanced",
            priority: 3,
            radiusM,
          });
        }
      } else if (node.position && Number.isFinite(node.position.x) && Number.isFinite(node.position.y)) {
        const px = node.position.x;
        const py = node.position.y;
        const pz = Number.isFinite(node.position.z) ? node.position.z : 0;
        raw.push({
          x: px,
          y: py,
          z: _sampleGroundZ(px, py, pz, oracle),
          setupId: mid,
          lbCode: lbCode16Of(lbKeyFromXY(Math.floor(px / 192), Math.floor(py / 192))),
          source: "statics-mesh",
          priority: 3,
          radiusM,
        });
      }
    }
  }

  // 3. Known Shadow Spire / Obsidian Spire landblocks when resident & unparked.
  if (residentLbs && typeof residentLbs.values === "function") {
    for (const rec of residentLbs.values()) {
      if (!rec || rec.parked) continue;
      const code16 = lbCode16Of(rec.lbKey ?? ((rec.lbX << 8) | rec.lbY));
      if (!SPIRE_LANDBLOCK_SET.has(code16)) continue;
      const floor = _estimateCraterFloorFromLb(rec.lbX, rec.lbY, rec.heights, oracle);
      raw.push({
        x: floor.x,
        y: floor.y,
        z: floor.z,
        setupId: 0,
        lbCode: code16,
        source: "landblock",
        priority: 1,
        radiusM: 46,
      });
    }
  }

  // Also check terrainGroup children if residentLbs has not backfilled yet.
  const terrKids = scene3d?.terrainGroup?.children;
  if (Array.isArray(terrKids)) {
    for (const c of terrKids) {
      const ud = c?.userData;
      if (!ud || !Number.isFinite(ud.lbX) || !Number.isFinite(ud.lbY)) continue;
      const code16 = (((ud.lbX & 0xff) << 8) | (ud.lbY & 0xff)) & 0xffff;
      if (!SPIRE_LANDBLOCK_SET.has(code16)) continue;
      const floor = _estimateCraterFloorFromLb(ud.lbX | 0, ud.lbY | 0, ud.terrainHeights || null, oracle);
      raw.push({
        x: floor.x,
        y: floor.y,
        z: floor.z,
        setupId: 0,
        lbCode: code16,
        source: "terrain-group",
        priority: 1,
        radiusM: 46,
      });
    }
  }

  // 4. Optional explicit sites.
  if (Array.isArray(opts.extraSites)) {
    for (const s of opts.extraSites) {
      if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
      raw.push({
        x: s.x,
        y: s.y,
        z: _sampleGroundZ(s.x, s.y, Number.isFinite(s.z) ? s.z : 0, oracle),
        setupId: (s.setupId >>> 0) || 0,
        lbCode: s.lbCode ? lbCode16Of(s.lbCode) : lbCode16Of(lbKeyFromXY(Math.floor(s.x / 192), Math.floor(s.y / 192))),
        source: s.source || "explicit",
        priority: 4,
        radiusM: Number.isFinite(s.radiusM) ? s.radiusM : 40,
      });
    }
  }

  // Sort higher-priority setup anchors ahead of coarse LB-center fallbacks,
  // then deduplicate within mergeRadiusM (or same Spire LB if setup found inside it).
  raw.sort((a, b) => (b.priority - a.priority) || (a.lbCode - b.lbCode) || (a.x - b.x));

  const merged = [];
  for (const cand of raw) {
    let dup = false;
    for (const existing of merged) {
      const d = Math.hypot(cand.x - existing.x, cand.y - existing.y);
      if (d <= mergeRadiusM || (cand.priority === 1 && existing.priority >= 3 && cand.lbCode === existing.lbCode)) {
        dup = true;
        break;
      }
    }
    if (!dup) {
      const key = `${cand.lbCode.toString(16)}:${Math.round(cand.x)}:${Math.round(cand.y)}`;
      merged.push({ ...cand, key });
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Deterministic instance builders (pure Float32Arrays — zero THREE required).
// ---------------------------------------------------------------------------

function _writeMat4TranslationScaleYaw(out16, offset, x, y, z, sx, sy, sz, yawRad) {
  const c = Math.cos(yawRad);
  const s = Math.sin(yawRad);
  // Column-major 4x4 in AC space (rotation about +Z up, scaled by sx, sy, sz).
  out16[offset] = c * sx;
  out16[offset + 1] = s * sx;
  out16[offset + 2] = 0;
  out16[offset + 3] = 0;

  out16[offset + 4] = -s * sy;
  out16[offset + 5] = c * sy;
  out16[offset + 6] = 0;
  out16[offset + 7] = 0;

  out16[offset + 8] = 0;
  out16[offset + 9] = 0;
  out16[offset + 10] = sz;
  out16[offset + 11] = 0;

  out16[offset + 12] = x;
  out16[offset + 13] = y;
  out16[offset + 14] = z;
  out16[offset + 15] = 1;
}

/**
 * Build deterministic GPU-instanced creeping dark-violet Shadow Miasma banks
 * hugging the crater floor around each active Spire site.
 */
export function buildSpireMiasmaInstances(sites, qualityCfg = SPIRES_QUALITY_TIERS.high, oracle = null) {
  const perSite = Math.max(4, qualityCfg?.miasmaPerSite || 42);
  const cappedSites = Array.isArray(sites) ? sites.slice(0, MAX_ACTIVE_SPIRE_SITES) : [];
  const total = cappedSites.length * perSite;
  const matrices = new Float32Array(total * 16);
  // aSpireMeta: (phase01, radialNorm, spinDir, opacityWeight)
  const meta = new Float32Array(total * 4);

  let cursor = 0;
  for (let sIdx = 0; sIdx < cappedSites.length; sIdx += 1) {
    const site = cappedSites[sIdx];
    const seed = ((Math.round(site.x) * 73856093) ^ (Math.round(site.y) * 19349663) ^ (site.lbCode * 83492791)) | 0;
    const maxR = site.radiusM || 40;

    for (let i = 0; i < perSite; i += 1) {
      const h0 = spireHash01(seed, i * 4);
      const h1 = spireHash01(seed, i * 4 + 1);
      const h2 = spireHash01(seed, i * 4 + 2);
      const h3 = spireHash01(seed, i * 4 + 3);

      // Concentrate creeping miasma denser near the Spire base / crater bowl.
      const rNorm = Math.pow((i + 0.5) / perSite, 0.72) * (0.85 + 0.25 * h0);
      const r = 2.5 + rNorm * maxR;
      const theta = i * 2.39996323 + h1 * 1.25; // golden-angle spiral distribution

      const ix = site.x + Math.cos(theta) * r;
      const iy = site.y + Math.sin(theta) * r;
      const gz = _sampleGroundZ(ix, iy, site.z, oracle);
      const liftZ = 0.16 + 0.55 * h2;

      const patchScaleXY = (6.5 + 8.5 * h0) * (0.78 + 0.35 * (1.0 - Math.min(1, rNorm)));
      const yaw = theta + Math.PI * 0.5 + (h3 - 0.5) * 0.65;

      _writeMat4TranslationScaleYaw(
        matrices,
        cursor * 16,
        ix,
        iy,
        gz + liftZ,
        patchScaleXY,
        patchScaleXY * 0.62,
        1.0,
        yaw,
      );

      meta[cursor * 4] = h1;
      meta[cursor * 4 + 1] = Math.min(1.0, rNorm);
      meta[cursor * 4 + 2] = (i & 1) === 0 ? 1.0 : -1.0;
      meta[cursor * 4 + 3] = (0.58 + 0.42 * h3) * (1.0 - 0.38 * Math.min(1.0, rNorm));
      cursor += 1;
    }
  }

  return { count: total, matrices, meta };
}

/**
 * Build deterministic GPU-instanced slow-rising obsidian void-shard wisps
 * drifting up from the Spire crater floor.
 */
export function buildSpireWispInstances(sites, qualityCfg = SPIRES_QUALITY_TIERS.high, oracle = null) {
  const perSite = Math.max(6, qualityCfg?.wispsPerSite || 56);
  const cappedSites = Array.isArray(sites) ? sites.slice(0, MAX_ACTIVE_SPIRE_SITES) : [];
  const total = cappedSites.length * perSite;
  const matrices = new Float32Array(total * 16);
  // aSpireMeta: (phase01, riseHeightM, speedHz, tintMix)
  const meta = new Float32Array(total * 4);

  let cursor = 0;
  for (let sIdx = 0; sIdx < cappedSites.length; sIdx += 1) {
    const site = cappedSites[sIdx];
    const seed = ((Math.round(site.x) * 49979693) ^ (Math.round(site.y) * 86028121) ^ 0x517e5) | 0;
    const maxR = (site.radiusM || 40) * 0.88;

    for (let i = 0; i < perSite; i += 1) {
      const h0 = spireHash01(seed, i * 4);
      const h1 = spireHash01(seed, i * 4 + 1);
      const h2 = spireHash01(seed, i * 4 + 2);
      const h3 = spireHash01(seed, i * 4 + 3);

      const rNorm = Math.pow(h0, 0.68);
      const r = 1.8 + rNorm * maxR;
      const theta = i * 2.39996323 + h1 * 6.2831853;

      const ix = site.x + Math.cos(theta) * r;
      const iy = site.y + Math.sin(theta) * r;
      const gz = _sampleGroundZ(ix, iy, site.z, oracle);

      const wispW = 0.42 + 0.58 * h2;
      const wispH = 1.65 + 2.45 * h3 * (1.0 - 0.25 * rNorm);

      _writeMat4TranslationScaleYaw(
        matrices,
        cursor * 16,
        ix,
        iy,
        gz + 0.12,
        wispW,
        wispH,
        1.0,
        0.0,
      );

      meta[cursor * 4] = h1;
      meta[cursor * 4 + 1] = 2.6 + 3.8 * h2 * (1.0 - 0.3 * rNorm);
      meta[cursor * 4 + 2] = 0.09 + 0.08 * h3;
      meta[cursor * 4 + 3] = h0;
      cursor += 1;
    }
  }

  return { count: total, matrices, meta };
}

// ---------------------------------------------------------------------------
// GLSL shaders (ASCII-only, no backticks; zero screen UV reads; log-depth safe).
// ---------------------------------------------------------------------------

const SPIRE_GLSL_NOISE = `
float spHash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float spNoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(spHash21(i), spHash21(i + vec2(1.0, 0.0)), u.x),
    mix(spHash21(i + vec2(0.0, 1.0)), spHash21(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float spFbm(vec2 p) {
  float v = 0.56 * spNoise2(p);
  v += 0.29 * spNoise2(p * 2.17 + vec2(5.2, -3.4));
  v += 0.15 * spNoise2(p * 4.41 - vec2(2.8, 7.9));
  return v;
}
`;

export const SPIRE_MIASMA_VERTEX_GLSL = `
precision highp float;

attribute vec4 aSpireMeta; // (phase01, radialNorm, spinDir, opacityWeight)

uniform float uTime;

varying vec2 vUv;
varying vec4 vMeta;
varying float vViewDist;

void main() {
  // Subtle slow ground-hugging heave so miasma tendrils creep over basalt rock.
  float heave = sin(uTime * 0.65 + aSpireMeta.x * 6.2831853 + position.x * 2.2) * 0.12;
  vec3 localPos = vec3(position.x, position.y, position.z + heave);
  vec4 acWorld = instanceMatrix * vec4(localPos, 1.0);
  vec4 viewPos = modelViewMatrix * acWorld;

  vUv = uv;
  vMeta = aSpireMeta;
  vViewDist = -viewPos.z;
  gl_Position = projectionMatrix * viewPos;
}
`;

export const SPIRE_MIASMA_FRAGMENT_GLSL = `
precision highp float;

uniform float uTime;
uniform float uMaxRangeM;

varying vec2 vUv;
varying vec4 vMeta;
varying float vViewDist;

${SPIRE_GLSL_NOISE}

void main() {
  float rangeFade = 1.0 - smoothstep(uMaxRangeM * 0.78, uMaxRangeM, vViewDist);
  float nearFade = smoothstep(1.8, 5.5, vViewDist);
  if (rangeFade * nearFade <= 0.002) discard;

  vec2 p = vUv * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 >= 1.0) discard;

  float phase = vMeta.x;
  float spin = vMeta.z;
  float r = sqrt(r2);
  float ang = atan(p.y, p.x) + spin * (uTime * 0.14 - r * 1.35);

  vec2 swirlUv = vec2(cos(ang), sin(ang)) * (r * 2.3) + vec2(phase * 7.1, -uTime * 0.11);
  float tendrilA = spFbm(swirlUv * 1.45);
  float tendrilB = spFbm(swirlUv * 2.85 - vec2(uTime * 0.16, phase * 3.9));
  float tendrils = clamp(0.58 * tendrilA + 0.42 * tendrilB, 0.0, 1.0);

  float softDisc = pow(max(0.0, 1.0 - r2), 1.55);
  float mask = softDisc * smoothstep(0.24, 0.78, tendrils);
  float alpha = mask * vMeta.w * 0.56 * rangeFade * nearFade;
  if (alpha <= 0.004) discard;

  // Deep obsidian-void shadow core with dark-violet & faint shadow-amethyst rim.
  vec3 voidBlack = vec3(0.024, 0.008, 0.042);
  vec3 darkViolet = vec3(0.20, 0.045, 0.34);
  vec3 riftAmethyst = vec3(0.36, 0.08, 0.48);
  float rim = smoothstep(0.46, 0.82, tendrils) * (1.0 - 0.45 * vMeta.y);
  vec3 col = mix(voidBlack, darkViolet, smoothstep(0.25, 0.72, tendrils));
  col = mix(col, riftAmethyst, rim * 0.45);

  gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.68));
}
`;

export const SPIRE_WISP_VERTEX_GLSL = `
precision highp float;

attribute vec4 aSpireMeta; // (phase01, riseHeightM, speedHz, tintMix)

uniform float uTime;

varying vec2 vUv;
varying float vLife;
varying float vTint;
varying float vViewDist;

void main() {
  float phase = aSpireMeta.x;
  float riseMax = aSpireMeta.y;
  float speedHz = aSpireMeta.z;

  float cycle = fract(uTime * speedHz + phase);
  float lifeEnv = smoothstep(0.0, 0.18, cycle) * smoothstep(1.0, 0.46, cycle);

  // Extract anchor & (width, height) from instanceMatrix columns.
  vec3 anchorAc = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float wispW = length(instanceMatrix[0].xyz);
  float wispH = length(instanceMatrix[1].xyz);

  // Slow helical void-drift around vertical axis as the shard/wisp rises.
  float swirlAng = cycle * 4.2 + phase * 6.2831853;
  float driftR = 0.28 * sin(3.14159265 * cycle);
  anchorAc.x += cos(swirlAng) * driftR;
  anchorAc.y += sin(swirlAng) * driftR;
  anchorAc.z += cycle * riseMax;

  // Cylindrical billboard in AC view space (+Z up).
  vec4 anchorView = modelViewMatrix * vec4(anchorAc, 1.0);
  vec3 upView = normalize((modelViewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
  vec3 rightView = cross(upView, vec3(0.0, 0.0, 1.0));
  float rl = length(rightView);
  rightView = (rl > 1e-4) ? (rightView / rl) : vec3(1.0, 0.0, 0.0);

  float stretch = 0.75 + 0.45 * sin(3.14159265 * cycle);
  vec3 viewPos = anchorView.xyz
    + rightView * (position.x * wispW * (1.0 - 0.25 * cycle))
    + upView * (position.y * wispH * stretch);

  vUv = uv;
  vLife = lifeEnv;
  vTint = aSpireMeta.w;
  vViewDist = -viewPos.z;
  gl_Position = projectionMatrix * vec4(viewPos, 1.0);
}
`;

export const SPIRE_WISP_FRAGMENT_GLSL = `
precision highp float;

uniform float uTime;
uniform float uMaxRangeM;

varying vec2 vUv;
varying float vLife;
varying float vTint;
varying float vViewDist;

${SPIRE_GLSL_NOISE}

void main() {
  float rangeFade = 1.0 - smoothstep(uMaxRangeM * 0.72, uMaxRangeM * 0.96, vViewDist);
  float nearFade = smoothstep(1.4, 4.2, vViewDist);
  if (rangeFade * nearFade * vLife <= 0.002) discard;

  // Tapered obsidian void-shard / flame-wisp silhouette: sharp at tip & tail.
  float xAbs = abs(vUv.x * 2.0 - 1.0);
  float taper = sin(3.14159265 * clamp(vUv.y, 0.0, 1.0));
  float shardWidth = max(0.08, taper * (1.0 - 0.35 * vUv.y));

  float fbm = spFbm(vec2(vUv.x * 3.0 + vTint * 5.3, vUv.y * 2.6 - uTime * 0.65));
  float edge = 1.0 - smoothstep(shardWidth * 0.25, shardWidth * (0.85 + 0.30 * fbm), xAbs);
  float alpha = edge * taper * vLife * (0.52 + 0.48 * fbm) * 0.72 * rangeFade * nearFade;
  if (alpha <= 0.004) discard;

  // Obsidian-black core framed by glowing dark-violet / shadow-crimson wisp rim.
  float coreMask = 1.0 - smoothstep(0.0, shardWidth * 0.42, xAbs);
  vec3 obsidianCore = vec3(0.018, 0.006, 0.032);
  vec3 violetEdge = mix(vec3(0.28, 0.06, 0.48), vec3(0.38, 0.05, 0.30), vTint * 0.45);
  vec3 col = mix(violetEdge, obsidianCore, coreMask * 0.78);

  gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.78));
}
`;

// ---------------------------------------------------------------------------
// Runtime state & GPU InstancedMesh pool.
// ---------------------------------------------------------------------------

let _spires = null;
const _stats = {
  inits: 0,
  ticks: 0,
  rebuilds: 0,
  lbReady: 0,
  lbParked: 0,
  lbUnparked: 0,
  lbGone: 0,
};

function _buildMiasmaGeometry(THREE) {
  // Curved ground-hugging quad in AC local XY (+Z slight crown at center).
  const geom = new THREE.BufferGeometry();
  const pos = new Float32Array([
    -0.5, -0.5, 0.0,
     0.5, -0.5, 0.0,
     0.5,  0.5, 0.0,
    -0.5,  0.5, 0.0,
     0.0,  0.0, 0.18,
  ]);
  const uv = new Float32Array([
    0.0, 0.0,
    1.0, 0.0,
    1.0, 1.0,
    0.0, 1.0,
    0.5, 0.5,
  ]);
  geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geom.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geom.setIndex([
    0, 1, 4,
    1, 2, 4,
    2, 3, 4,
    3, 0, 4,
  ]);
  geom.name = "spire-miasma-patch";
  return geom;
}

function _buildWispGeometry(THREE) {
  // Bottom-anchored unit vertical ribbon expanded in view space by VS.
  const geom = new THREE.BufferGeometry();
  const pos = new Float32Array([
    -0.5, 0.0, 0.0,
     0.5, 0.0, 0.0,
     0.5, 1.0, 0.0,
    -0.5, 1.0, 0.0,
  ]);
  const uv = new Float32Array([
    0.0, 0.0,
    1.0, 0.0,
    1.0, 1.0,
    0.0, 1.0,
  ]);
  geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geom.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geom.setIndex([0, 1, 2, 0, 2, 3]);
  geom.name = "spire-void-wisp";
  return geom;
}

function _createGpuPools(THREE, uniforms, parent) {
  if (!THREE || typeof THREE.InstancedMesh !== "function") return null;

  const maxMiasma = MAX_ACTIVE_SPIRE_SITES * SPIRES_QUALITY_TIERS.ultra.miasmaPerSite;
  const maxWisps = MAX_ACTIVE_SPIRE_SITES * SPIRES_QUALITY_TIERS.ultra.wispsPerSite;

  const rootGroup = new THREE.Group();
  rootGroup.name = "terrain-spires-vfx-root";

  const miasmaGeom = _buildMiasmaGeometry(THREE);
  const miasmaMetaAttr = new THREE.InstancedBufferAttribute(new Float32Array(maxMiasma * 4), 4);
  miasmaGeom.setAttribute("aSpireMeta", miasmaMetaAttr);
  const miasmaMat = new THREE.ShaderMaterial(withLogDepth({
    uniforms,
    vertexShader: SPIRE_MIASMA_VERTEX_GLSL,
    fragmentShader: SPIRE_MIASMA_FRAGMENT_GLSL,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  }));
  miasmaMat.name = "spire-miasma-material";
  const miasmaMesh = new THREE.InstancedMesh(miasmaGeom, miasmaMat, maxMiasma);
  miasmaMesh.name = "spire-miasma-instanced";
  miasmaMesh.count = 0;
  miasmaMesh.castShadow = false;
  miasmaMesh.receiveShadow = false;
  miasmaMesh.frustumCulled = false;
  miasmaMesh.renderOrder = 2;
  rootGroup.add(miasmaMesh);

  const wispGeom = _buildWispGeometry(THREE);
  const wispMetaAttr = new THREE.InstancedBufferAttribute(new Float32Array(maxWisps * 4), 4);
  wispGeom.setAttribute("aSpireMeta", wispMetaAttr);
  const wispMat = new THREE.ShaderMaterial(withLogDepth({
    uniforms,
    vertexShader: SPIRE_WISP_VERTEX_GLSL,
    fragmentShader: SPIRE_WISP_FRAGMENT_GLSL,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  }));
  wispMat.name = "spire-wisp-material";
  const wispMesh = new THREE.InstancedMesh(wispGeom, wispMat, maxWisps);
  wispMesh.name = "spire-wisp-instanced";
  wispMesh.count = 0;
  wispMesh.castShadow = false;
  wispMesh.receiveShadow = false;
  wispMesh.frustumCulled = false;
  wispMesh.renderOrder = 3;
  rootGroup.add(wispMesh);

  if (parent && typeof parent.add === "function") parent.add(rootGroup);

  return {
    rootGroup,
    miasmaGeom,
    miasmaMat,
    miasmaMesh,
    miasmaMetaAttr,
    wispGeom,
    wispMat,
    wispMesh,
    wispMetaAttr,
  };
}

function _readEyeAc(frameCtx, scene3d, out) {
  const cam = frameCtx?.camera || scene3d?.camera || scene3d?.cameraSwitcher?.activeCamera || null;
  const cp = cam?.position;
  if (cp && Number.isFinite(cp.x) && Number.isFinite(cp.z)) {
    out.x = cp.x;
    out.y = -cp.z;
    out.z = Number.isFinite(cp.y) ? cp.y : 0;
    return true;
  }
  if (frameCtx?.hasPlayer && frameCtx.playerPos && Number.isFinite(frameCtx.playerPos.x)) {
    out.x = frameCtx.playerPos.x;
    out.y = frameCtx.playerPos.y;
    out.z = Number.isFinite(frameCtx.playerPos.z) ? frameCtx.playerPos.z : 0;
    return true;
  }
  return false;
}

function _rebuildInstancesIfNeeded(state, oracle) {
  const allSites = detectResidentSpireSites({
    scene3d: state.scene3d,
    residentLbs: state.residentLbs,
    oracle,
    extraSites: state.extraSites,
  });

  // Filter to sites within SPIRE_ENGAGE_M if eye position is known.
  let nearSites = allSites;
  if (Number.isFinite(state.eyeAc.x) && Number.isFinite(state.eyeAc.y)) {
    const limit = state.engageM * 1.08;
    nearSites = allSites
      .map((s) => ({ s, d: Math.hypot(s.x - state.eyeAc.x, s.y - state.eyeAc.y) }))
      .filter((x) => x.d <= limit)
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_ACTIVE_SPIRE_SITES)
      .map((x) => x.s);
  } else {
    nearSites = allSites.slice(0, MAX_ACTIVE_SPIRE_SITES);
  }

  const qCfg = resolveSpiresQuality(state.quality);
  const sig = `${qCfg.miasmaPerSite}:${qCfg.wispsPerSite}|` + nearSites.map((s) => s.key).join(",");
  if (sig === state.activeSignature && !state.dirty) return;

  state.dirty = false;
  state.activeSignature = sig;
  state.detectedSites = allSites;
  state.activeSites = nearSites;

  const miasma = buildSpireMiasmaInstances(nearSites, qCfg, oracle);
  const wisps = buildSpireWispInstances(nearSites, qCfg, oracle);
  state.lastMiasmaCount = miasma.count;
  state.lastWispCount = wisps.count;
  _stats.rebuilds += 1;

  if (state.gpu) {
    const { miasmaMesh, miasmaMetaAttr, wispMesh, wispMetaAttr } = state.gpu;
    miasmaMesh.count = miasma.count;
    if (miasma.count > 0) {
      miasmaMesh.instanceMatrix.array.set(miasma.matrices);
      miasmaMesh.instanceMatrix.needsUpdate = true;
      miasmaMetaAttr.array.set(miasma.meta);
      miasmaMetaAttr.needsUpdate = true;
    }
    miasmaMesh.visible = miasma.count > 0;

    wispMesh.count = wisps.count;
    if (wisps.count > 0) {
      wispMesh.instanceMatrix.array.set(wisps.matrices);
      wispMesh.instanceMatrix.needsUpdate = true;
      wispMetaAttr.array.set(wisps.meta);
      wispMetaAttr.needsUpdate = true;
    }
    wispMesh.visible = wisps.count > 0;
  }
}

function _tickSpires(dt, frameCtx) {
  if (!_spires) return;
  _stats.ticks += 1;

  const scene3d = frameCtx?.scene3d || _spires.scene3d;
  if (frameCtx?.quality) _spires.quality = frameCtx.quality;
  else if (scene3d?.quality) _spires.quality = scene3d.quality;

  if (_spires.gpu?.rootGroup && !_spires.gpu.rootGroup.parent) {
    const parent = _spires.parent || scene3d?.terrainGroup?.parent || scene3d?.staticsGroup || null;
    if (parent && typeof parent.add === "function") parent.add(_spires.gpu.rootGroup);
  }

  const tSec = Number.isFinite(frameCtx?.tSec)
    ? frameCtx.tSec
    : (_spires.uniforms.uTime.value + (Number.isFinite(dt) ? dt : 0));
  _spires.uniforms.uTime.value = tSec;
  _spires.uniforms.uMaxRangeM.value = _spires.engageM;

  _readEyeAc(frameCtx, scene3d, _spires.eyeAc);

  // Detect staticsGroup or portal_registry additions cheaply without polling every mesh every frame:
  // re-scan when child counts change, when player moves >= 32 m, or when LB lifecycle marked dirty.
  const statCount = scene3d?.staticsGroup?.children?.length || 0;
  const portalCount = staticPortalAnchors().size;
  const movedM = Number.isFinite(_spires.lastScanEye.x)
    ? Math.hypot(_spires.eyeAc.x - _spires.lastScanEye.x, _spires.eyeAc.y - _spires.lastScanEye.y)
    : Infinity;

  if (
    _spires.dirty ||
    statCount !== _spires.lastStaticsChildCount ||
    portalCount !== _spires.lastPortalCount ||
    movedM >= 32.0
  ) {
    _spires.lastStaticsChildCount = statCount;
    _spires.lastPortalCount = portalCount;
    _spires.lastScanEye.x = _spires.eyeAc.x;
    _spires.lastScanEye.y = _spires.eyeAc.y;
    const oracle = frameCtx?.oracle || _spires.getOracle();
    _rebuildInstancesIfNeeded(_spires, oracle);
  }
}

/**
 * Initialise the grounded world-space Shadow Spires VFX provider (`terrain.spires`).
 *
 * @param {object} [opts]
 * @param {object} [opts.THREE]       injected Three.js namespace (optional in Node tests)
 * @param {object} [opts.scene3d]     live scene3d facade
 * @param {object} [opts.parent]      AC-space parent group (defaults to `terrainGroup.parent`)
 * @param {Array}  [opts.extraSites]  optional explicit Spire sites
 * @param {Function} [opts.getOracle] optional terrain oracle getter
 */
export function initSpiresVfx(opts = {}) {
  const quality = opts.quality || opts.scene3d?.quality || null;
  if (!opts.force && !terrainSpiresEnabled(quality)) return null;

  disposeSpiresVfx();

  const THREE = opts.THREE || null;
  const scene3d = opts.scene3d || null;
  const parent = opts.parent || scene3d?.terrainGroup?.parent || scene3d?.staticsGroup || null;
  const uniforms = {
    uTime: { value: 0 },
    uMaxRangeM: { value: Number.isFinite(opts.engageM) ? opts.engageM : SPIRE_ENGAGE_M },
  };
  const gpu = _createGpuPools(THREE, uniforms, parent);

  const state = {
    THREE,
    scene3d,
    parent,
    quality,
    engageM: uniforms.uMaxRangeM.value,
    uniforms,
    gpu,
    residentLbs: new Map(),
    extraSites: Array.isArray(opts.extraSites) ? opts.extraSites.slice() : [],
    detectedSites: [],
    activeSites: [],
    activeSignature: "",
    lastMiasmaCount: 0,
    lastWispCount: 0,
    lastStaticsChildCount: -1,
    lastPortalCount: -1,
    eyeAc: { x: NaN, y: NaN, z: 0 },
    lastScanEye: { x: NaN, y: NaN },
    dirty: true,
    getOracle: typeof opts.getOracle === "function"
      ? opts.getOracle
      : () => {
        try {
          return typeof window !== "undefined" && window.__terrainVfx
            ? window.__terrainVfx.oracle
            : null;
        } catch (_) { return null; }
      },
    providerHandle: null,
  };
  _spires = state;
  _stats.inits += 1;

  state.providerHandle = registerTerrainVfx({
    id: SPIRES_PROVIDER_ID,
    scope: "landblock",
    families: null, // All LBs inspected so Spire craters on obsidian, ash, dirt or sand all match.
    enabled: () => opts.force ? true : terrainSpiresEnabled(_spires?.quality || _spires?.scene3d?.quality),
    onLandblockReady(ctx) {
      if (!_spires || !ctx) return;
      const code16 = lbCode16Of(ctx.lbKey);
      if (SPIRE_LANDBLOCK_SET.has(code16)) {
        _spires.residentLbs.set(ctx.lbKey >>> 0, {
          lbKey: ctx.lbKey >>> 0,
          lbX: ctx.lbX | 0,
          lbY: ctx.lbY | 0,
          heights: ctx.heights || null,
          parked: false,
        });
        _spires.dirty = true;
        _stats.lbReady += 1;
      }
    },
    onLandblockPark(ctx) {
      if (!_spires || !ctx) return;
      const rec = _spires.residentLbs.get(ctx.lbKey >>> 0);
      if (rec) {
        rec.parked = true;
        _spires.dirty = true;
        _stats.lbParked += 1;
      }
    },
    onLandblockUnpark(ctx) {
      if (!_spires || !ctx) return;
      const rec = _spires.residentLbs.get(ctx.lbKey >>> 0);
      if (rec) {
        rec.parked = false;
        _spires.dirty = true;
        _stats.lbUnparked += 1;
      }
    },
    onLandblockGone(ctx) {
      if (!_spires || !ctx) return;
      if (_spires.residentLbs.delete(ctx.lbKey >>> 0)) {
        _spires.dirty = true;
        _stats.lbGone += 1;
      }
    },
    update: _tickSpires,
  });

  const surface = {
    id: SPIRES_PROVIDER_ID,
    stats: spiresVfxStats,
    tick: (dt, frameCtx) => _tickSpires(dt, frameCtx),
    dispose: disposeSpiresVfx,
    get rootGroup() { return state.gpu?.rootGroup || null; },
  };
  try {
    if (typeof window !== "undefined") window.__terrainSpires = surface;
  } catch (_) {}
  return surface;
}

export function spiresVfxStats() {
  const q = _spires?.quality || _spires?.scene3d?.quality || null;
  return {
    enabled: terrainSpiresEnabled(q),
    inited: !!_spires,
    detectedSiteCount: _spires ? _spires.detectedSites.length : 0,
    activeSiteCount: _spires ? _spires.activeSites.length : 0,
    activeSites: _spires ? _spires.activeSites.map((s) => ({
      key: s.key,
      x: s.x,
      y: s.y,
      z: s.z,
      setupId: s.setupId,
      lbCode: `0x${s.lbCode.toString(16).toUpperCase().padStart(4, "0")}`,
      source: s.source,
    })) : [],
    miasmaInstances: _spires ? _spires.lastMiasmaCount : 0,
    wispInstances: _spires ? _spires.lastWispCount : 0,
    screenDistortCount: 0,
    lightCount: 0,
    counters: { ..._stats },
  };
}

export function disposeSpiresVfx() {
  if (!_spires) return;
  const st = _spires;
  _spires = null;
  try { unregisterTerrainVfx(SPIRES_PROVIDER_ID); } catch (_) {}
  if (st.gpu) {
    if (st.gpu.rootGroup?.parent) {
      try { st.gpu.rootGroup.parent.remove(st.gpu.rootGroup); } catch (_) {}
    }
    for (const d of [st.gpu.miasmaGeom, st.gpu.miasmaMat, st.gpu.wispGeom, st.gpu.wispMat]) {
      if (d && typeof d.dispose === "function") {
        try { d.dispose(); } catch (_) {}
      }
    }
  }
}

export function _resetSpiresVfx() {
  disposeSpiresVfx();
  for (const k of Object.keys(_stats)) _stats[k] = 0;
}
