// scene3d/terrain_waterfalls.js — Site-driven long-range 3D waterfall curtains,
// Marae Lassel reservoir cascade sheets, frothy lip crests, billowing plunge
// mist plumes, and turbulent plunge-pool foam boil rings (Item 4B).
//
// Reads `data/water_flow_sites.json` (31 catalogued Dereth sites; 22 active
// drops >= 1.0 m including Nanto Blue Ghost Falls `0xE43D` 50 m dry-cliff gap,
// Cragstone Falls `0xB6A3` 26 m, Marae Lassel River Fall `0x1DB4` 28 m, Marae
// Lassel's three zero-anchor 28 m reservoir cascades `0x1CBC`, `0x1FBC`,
// `0x1FBF`, Marae Spring `0x24BC`, Behind the Waterfall `0xEA74` 50 m,
// Cataracts of Sabella `0x22E6` 30 m, Ithaenc `0xF419` 100 m, `0xD5DA` 104 m,
// `0xEC13` 160 m, and `0xED0E` 234 m).
//
// COORDINATE FRAME: AC world metres (+X east, +Y north, +Z up), attached to
// `terrainGroup.parent` (`worldRoot`), sibling of `terrainGroup` & `staticsGroup`.
//
// INVARIANTS:
//   - Injected optional `THREE`: full CPU geometry, site loading, range culling,
//     and stats run in pure Node with or without `THREE`.
//   - Zero `PointLight`s (§5.2), single shared `ShaderMaterial` per pass (§5.4),
//     zero `Math.random` (§5.5 — deterministic integer hash), `castShadow=false`.
//   - Logarithmic & reversed-Z depth compatible via `withLogDepth`.
//   - Marae Lassel East Fork dam (`0x1FBC`) lip height strictly `< 82.000 m`.

import { withLogDepth } from "./shader_logdepth.js";
import { registerTerrainVfx, unregisterTerrainVfx } from "./terrain_vfx.js";
import { terrainWaterfallsEnabled } from "./vfx_flags.js";

export const WATERFALLS_PROVIDER_ID = "terrain.waterfalls";
export const DEFAULT_WATERFALL_SITES_URL = "data/water_flow_sites.json";

/** Long-range engagement radius (solves the 384 m static-script cliff dropout). */
export const WATERFALL_ENGAGE_M = 1800;
/** Hysteresis release radius (1.10x engage so boundary hover never thrashes). */
export const WATERFALL_DROP_M = 1980;
/** Minimum vertical drop in metres to synthesize a 3D waterfall assembly. */
export const MIN_WATERFALL_DROP_M = 1.0;
/** Locked Marae Lassel dam deck clearance ceiling (test_terrain_water_flow.mjs). */
export const MARAE_DAM_CLEARANCE_MAX_Z = 81.65;

export const WATERFALL_QUALITY_TIERS = Object.freeze({
  low: Object.freeze({
    cols: 8,
    rows: 10,
    secondaryVeil: false,
    mistPlumesBase: 4,
    mistPlumesMax: 6,
    boilSegments: 16,
  }),
  mid: Object.freeze({
    cols: 12,
    rows: 14,
    secondaryVeil: true,
    mistPlumesBase: 6,
    mistPlumesMax: 9,
    boilSegments: 22,
  }),
  high: Object.freeze({
    cols: 16,
    rows: 20,
    secondaryVeil: true,
    mistPlumesBase: 8,
    mistPlumesMax: 12,
    boilSegments: 28,
  }),
  ultra: Object.freeze({
    cols: 20,
    rows: 24,
    secondaryVeil: true,
    mistPlumesBase: 10,
    mistPlumesMax: 14,
    boilSegments: 32,
  }),
});

/** Deterministic [0, 1) hash from integer seed + index — zero Math.random. */
export function waterfallHash01(seed, idx) {
  let h = ((seed | 0) ^ Math.imul((idx | 0) + 1, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

export function resolveWaterfallQuality(quality) {
  const name = typeof quality === "string"
    ? quality
    : (quality && typeof quality.preset === "string" ? quality.preset
      : (quality && typeof quality.name === "string" ? quality.name : "high"));
  if (name === "low") return WATERFALL_QUALITY_TIERS.low;
  if (name === "mid") return WATERFALL_QUALITY_TIERS.mid;
  if (name === "ultra") return WATERFALL_QUALITY_TIERS.ultra;
  return WATERFALL_QUALITY_TIERS.high;
}

/**
 * Classify and derive physical curtain metrics for one `water_flow_sites.json`
 * entry without mutating the source record.
 */
export function classifyWaterfallSite(site) {
  if (!site || !Array.isArray(site.lip) || !Array.isArray(site.foot)) return null;
  const rawDrop = Number(site.drop) || Math.max(0, (Number(site.lip[2]) || 0) - (Number(site.foot[2]) || 0));
  if (!(rawDrop >= MIN_WATERFALL_DROP_M)) return null;

  const lipX = Number(site.lip[0]) || 0;
  const lipY = Number(site.lip[1]) || 0;
  const rawLipZ = Number(site.lip[2]) || 0;
  const footX = Number(site.foot[0]) || 0;
  const footY = Number(site.foot[1]) || 0;
  const footZ = Number(site.foot[2]) || 0;

  const dx = footX - lipX;
  const dy = footY - lipY;
  const horizSpanM = Math.hypot(dx, dy);

  let fx = Array.isArray(site.dir) ? Number(site.dir[0]) || 0 : 0;
  let fy = Array.isArray(site.dir) ? Number(site.dir[1]) || 0 : 0;
  if (horizSpanM > 0.5) {
    fx = dx / horizSpanM;
    fy = dy / horizSpanM;
  }
  const fl = Math.hypot(fx, fy);
  if (fl > 1e-4) {
    fx /= fl;
    fy /= fl;
  } else {
    fx = 0;
    fy = -1;
  }
  const acrossX = -fy;
  const acrossY = fx;

  const kinds = Array.isArray(site.kind) ? site.kind : [];
  const lb = String(site.lb || "").toUpperCase();
  const anchors = Math.max(0, Number(site.anchors) || 0);
  const steps = Math.max(0, Number(site.steps) || 0);

  const isMaraeCascade = lb === "0X1CBC" || lb === "0X1FBC" || lb === "0X1FBF"
    || (anchors === 0 && kinds.includes("spill") && lipX >= 5000 && lipX <= 6600 && lipY >= 35800 && lipY <= 37200);

  let archetype = "cataract";
  if (isMaraeCascade) archetype = "marae-cascade";
  else if (rawDrop <= 3.0) archetype = "spring";
  else if (kinds.includes("land-cliff gap")) archetype = "cliff-gap";
  else if (kinds.includes("spill") && anchors === 0) archetype = "spill";

  // Keep Marae Lassel dam deck clearance (< 82.000 m at 0x1FBC) 100% intact.
  let upperZ = rawLipZ + 0.06;
  if (isMaraeCascade) {
    upperZ = Math.min(rawLipZ - 0.35, lb === "0X1FBC" ? MARAE_DAM_CLEARANCE_MAX_Z : rawLipZ - 0.25);
  }
  const lowerZ = Math.min(footZ, upperZ - MIN_WATERFALL_DROP_M * 0.8);
  const dropM = Math.max(MIN_WATERFALL_DROP_M * 0.8, upperZ - lowerZ);

  // Derive natural curtain width from step span, static anchor density, and drop.
  const stepWidth = steps > 0 ? Math.sqrt(steps) * (isMaraeCascade ? 3.8 : 4.6) : 0;
  const anchorWidth = anchors > 0 ? Math.sqrt(anchors) * 3.9 : 0;
  const dropBaseWidth = Math.min(22, Math.max(4.5, dropM * 0.34));
  const rawWidth = Math.max(dropBaseWidth, stepWidth, anchorWidth);
  const widthM = rawDrop <= 3.0
    ? Math.min(8.0, Math.max(3.6, rawWidth * 0.55))
    : Math.min(62.0, Math.max(7.5, rawWidth));

  // Distinguish steep free-falling cliff curtains from sloped cascade chutes.
  // For `anchors > 0` waterfalls with a long `land-cliff gap` chord (e.g. Nanto
  // 0xE43D where the baked upper-pond -> lower-pool chord spans 161 m), anchor
  // the free-fall curtain lip at the steep cliff brow just upstream of `foot`
  // rather than stretching a mid-air ramp across the upstream valley.
  let curtainLipX = lipX;
  let curtainLipY = lipY;
  let curtainHorizSpanM = horizSpanM;
  if (anchors > 0 && !isMaraeCascade && horizSpanM > Math.max(30.0, dropM * 0.90)) {
    curtainHorizSpanM = Math.min(22.0, Math.max(10.0, dropM * 0.36));
    curtainLipX = footX - fx * curtainHorizSpanM;
    curtainLipY = footY - fy * curtainHorizSpanM;
  }
  const isChute = curtainHorizSpanM > Math.max(38.0, dropM * 1.45);
  const midX = 0.5 * (lipX + footX);
  const midY = 0.5 * (lipY + footY);
  const midZ = 0.5 * (upperZ + lowerZ);

  return {
    id: Number.isFinite(site.id) ? (site.id | 0) : 0,
    lb,
    name: site.name || null,
    map: site.map || "",
    archetype,
    isMaraeCascade,
    isChute,
    anchors,
    steps,
    kinds,
    lip: [lipX, lipY, upperZ],
    curtainLip: [curtainLipX, curtainLipY, upperZ],
    rawLipZ,
    foot: [footX, footY, lowerZ],
    mid: [midX, midY, midZ],
    dropM,
    horizSpanM,
    curtainHorizSpanM,
    widthM,
    flowDir: [fx, fy],
    acrossDir: [acrossX, acrossY],
  };
}

/**
 * Load and classify waterfall sites from `sites` array/payload, `fetch`, or
 * Node `fs/promises` fallback when running headless tests without a base URL.
 */
export async function loadWaterfallSites(opts = {}) {
  let payload = opts.sites || null;
  const url = opts.url || DEFAULT_WATERFALL_SITES_URL;
  if (!payload) {
    const fetchFn = opts.fetchImpl || (typeof fetch === "function" ? fetch : null);
    let fetched = false;
    if (fetchFn) {
      try {
        const res = await fetchFn(url);
        if (res && res.ok) {
          payload = await res.json();
          fetched = true;
        }
      } catch (_) {
        fetched = false;
      }
    }
    if (!fetched && typeof process !== "undefined" && process.versions?.node) {
      const fsMod = await import("node:fs/promises");
      const pathMod = await import("node:path");
      const fileUrlMod = await import("node:url");
      const here = pathMod.dirname(fileUrlMod.fileURLToPath(import.meta.url));
      const resolved = pathMod.isAbsolute(url) ? url : pathMod.resolve(here, "..", url);
      const txt = await fsMod.readFile(resolved, "utf8");
      payload = JSON.parse(txt);
    }
  }
  const rawList = Array.isArray(payload)
    ? payload
    : (payload && Array.isArray(payload.sites) ? payload.sites : []);
  const classified = [];
  for (const s of rawList) {
    const info = classifyWaterfallSite(s);
    if (info) classified.push(info);
  }
  return {
    catalogCount: rawList.length,
    sites: classified,
  };
}

/** Minimum 3D distance from an AC-space eye/player point to lip, mid, or foot. */
export function distanceToWaterfallSiteM(siteInfo, eyeAc) {
  if (!siteInfo || !eyeAc) return Infinity;
  const ex = Number(eyeAc.x) || 0;
  const ey = Number(eyeAc.y) || 0;
  const ez = Number.isFinite(eyeAc.z) ? eyeAc.z : siteInfo.mid[2];
  const dLip = Math.hypot(ex - siteInfo.lip[0], ey - siteInfo.lip[1], (ez - siteInfo.lip[2]) * 0.5);
  const dMid = Math.hypot(ex - siteInfo.mid[0], ey - siteInfo.mid[1], (ez - siteInfo.mid[2]) * 0.5);
  const dFoot = Math.hypot(ex - siteInfo.foot[0], ey - siteInfo.foot[1], (ez - siteInfo.foot[2]) * 0.5);
  return Math.min(dLip, dMid, dFoot);
}

/**
 * Filter classified waterfall sites within `engageM` (default 1,800 m) with
 * `dropM` hysteresis (default 1,980 m) for already-active site ids.
 */
export function activeWaterfallSitesNear(sites, eyeAc, activeIds = null, opts = {}) {
  if (!Array.isArray(sites) || !eyeAc || !Number.isFinite(eyeAc.x) || !Number.isFinite(eyeAc.y)) {
    return [];
  }
  const engageM = Number.isFinite(opts.engageM) ? opts.engageM : WATERFALL_ENGAGE_M;
  const dropM = Number.isFinite(opts.dropM) ? opts.dropM : Math.max(engageM, WATERFALL_DROP_M);
  const out = [];
  for (const s of sites) {
    const wasActive = activeIds ? activeIds.has(s.id) : false;
    const limit = wasActive ? dropM : engageM;
    const distM = distanceToWaterfallSiteM(s, eyeAc);
    if (distM <= limit) out.push({ site: s, distM });
  }
  out.sort((a, b) => a.distM - b.distM);
  return out;
}

// ---------------------------------------------------------------------------
// Deterministic geometry builders (pure Float32Array / Uint16Array — no THREE).
// ---------------------------------------------------------------------------

function _evalCurtainRibbonPoint(site, u, v, layerIdx, outPos) {
  const s = u * 2.0 - 1.0; // [-1, +1] across lip
  const seed = ((site.id + 1) * 7919 + layerIdx * 104729) | 0;

  // Natural amphitheatre bow + subtle rock-lip undulation across columns.
  const colIdx = Math.round(u * 32);
  const lipJitter = (waterfallHash01(seed, colIdx) - 0.5) * Math.min(1.6, site.widthM * 0.045);
  const arcBow = (1.0 - s * s) * Math.min(site.widthM * 0.13, 5.5) + lipJitter * (1.0 - 0.5 * v);

  // Curtain widens slightly toward the plunge pool as air entrains into spray.
  const flare = 1.0 + (site.isChute ? 0.08 : 0.15) * v * v;
  const halfW = 0.5 * site.widthM * flare;
  const lateral = s * halfW;

  // Parabolic ballistic profile from upper_z lip to lower_z plunge pool.
  const cLip = Array.isArray(site.curtainLip) ? site.curtainLip : site.lip;
  const cSpanM = Number.isFinite(site.curtainHorizSpanM) ? site.curtainHorizSpanM : site.horizSpanM;
  let fwd;
  let z;
  const veilOutward = layerIdx > 0 ? Math.sin(Math.PI * Math.min(1, v * 1.05)) * Math.min(1.8, 0.45 + site.dropM * 0.022) : 0.0;
  if (site.isChute) {
    // Stepped / sloped chute (e.g., Marae reservoir cascades):
    // bridge lip -> foot cleanly above the cliff chord with gentle gravity bow.
    fwd = cSpanM * v + arcBow * (1.0 - 0.35 * v) + 1.15 + veilOutward;
    const chuteLift = Math.sin(Math.PI * v) * Math.min(3.4, site.dropM * 0.085) + 0.55;
    z = cLip[2] - site.dropM * (0.58 * v + 0.42 * v * v) + chuteLift * (1.0 - Math.pow(1.0 - Math.min(1, v * 4.0), 2.0));
  } else {
    // Steep free-fall cataract (Cragstone, Nanto, Marae River, Sabella, Behind the Waterfall):
    // horizontal launch velocity over crest + quadratic gravity drop.
    const crestThrow = Math.min(5.8, Math.max(1.35, site.dropM * 0.13));
    fwd = cSpanM * Math.pow(v, 0.64) + crestThrow * Math.sin(Math.PI * Math.pow(v, 0.72)) + arcBow * (1.0 - 0.4 * v) + 0.85 + veilOutward;
    z = cLip[2] - site.dropM * (0.26 * v + 0.74 * v * v);
  }

  // Strictly preserve Marae Lassel < 82.000 m dam deck clearance invariant (f32-safe).
  if (site.isMaraeCascade && site.lb === "0X1FBC" && z > MARAE_DAM_CLEARANCE_MAX_Z - 0.01) {
    z = MARAE_DAM_CLEARANCE_MAX_Z - 0.01;
  }

  outPos[0] = cLip[0] + site.flowDir[0] * fwd + site.acrossDir[0] * lateral;
  outPos[1] = cLip[1] + site.flowDir[1] * fwd + site.acrossDir[1] * lateral;
  outPos[2] = z;
  return outPos;
}

/**
 * Build curved parabolic 3D waterfall curtain vertex arrays bridging `upper_z`
 * (`lip[2]`) to `lower_z` (`foot[2]`), plus optional outer spray veil layer.
 */
export function buildWaterfallCurtainData(site, qualityCfg = WATERFALL_QUALITY_TIERS.high) {
  const cols = Math.max(4, qualityCfg?.cols || 16);
  const rows = Math.max(4, qualityCfg?.rows || 20);
  const layers = qualityCfg?.secondaryVeil ? 2 : 1;

  const vertsPerLayer = (cols + 1) * (rows + 1);
  const quadsPerLayer = cols * rows;
  const totalVerts = vertsPerLayer * layers;
  const totalIndices = quadsPerLayer * 6 * layers;

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const dropMeta = new Float32Array(totalVerts * 4);
  const indices = new Uint16Array(totalIndices);

  const p0 = [0, 0, 0];
  const pU = [0, 0, 0];
  const pV = [0, 0, 0];
  const phaseSeed = waterfallHash01(site.id * 31337 + 17, 1);
  const speedScale = Math.min(2.4, Math.max(0.75, Math.sqrt(site.dropM / 18.0)));

  let vCursor = 0;
  let iCursor = 0;

  for (let layer = 0; layer < layers; layer += 1) {
    const baseVertex = layer * vertsPerLayer;
    const du = 1.0 / cols;
    const dv = 1.0 / rows;
    for (let r = 0; r <= rows; r += 1) {
      const v = r / rows;
      for (let c = 0; c <= cols; c += 1) {
        const u = c / cols;
        _evalCurtainRibbonPoint(site, u, v, layer, p0);
        _evalCurtainRibbonPoint(site, Math.min(1, u + du * 0.5), v, layer, pU);
        _evalCurtainRibbonPoint(site, u, Math.min(1, v + dv * 0.5), layer, pV);

        // Tangent across (tu) x tangent down (tv) -> outward AC normal.
        const tux = pU[0] - p0[0];
        const tuy = pU[1] - p0[1];
        const tuz = pU[2] - p0[2];
        const tvx = pV[0] - p0[0];
        const tvy = pV[1] - p0[1];
        const tvz = pV[2] - p0[2];

        let nx = tuy * tvz - tuz * tvy;
        let ny = tuz * tvx - tux * tvz;
        let nz = tux * tvy - tuy * tvx;
        if (nx * site.flowDir[0] + ny * site.flowDir[1] < 0) {
          nx = -nx;
          ny = -ny;
          nz = -nz;
        }
        const nl = Math.hypot(nx, ny, nz);
        if (nl > 1e-5) {
          nx /= nl;
          ny /= nl;
          nz /= nl;
        } else {
          nx = site.flowDir[0];
          ny = site.flowDir[1];
          nz = 0.25;
        }

        positions[vCursor * 3] = p0[0];
        positions[vCursor * 3 + 1] = p0[1];
        positions[vCursor * 3 + 2] = p0[2];

        normals[vCursor * 3] = nx;
        normals[vCursor * 3 + 1] = ny;
        normals[vCursor * 3 + 2] = nz;

        uvs[vCursor * 2] = u;
        uvs[vCursor * 2 + 1] = v;

        const baseLayerAlpha = layer === 0 ? 0.90 : 0.42;
        const signedLayerAlpha = (site.anchors > 0 && !site.isMaraeCascade)
          ? -baseLayerAlpha
          : baseLayerAlpha;
        dropMeta[vCursor * 4] = site.dropM;
        dropMeta[vCursor * 4 + 1] = speedScale * (layer === 0 ? 1.0 : 1.32);
        dropMeta[vCursor * 4 + 2] = phaseSeed + layer * 0.37;
        dropMeta[vCursor * 4 + 3] = signedLayerAlpha;

        vCursor += 1;
      }
    }

    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const i00 = baseVertex + r * (cols + 1) + c;
        const i10 = i00 + 1;
        const i01 = i00 + (cols + 1);
        const i11 = i01 + 1;
        indices[iCursor++] = i00;
        indices[iCursor++] = i01;
        indices[iCursor++] = i10;
        indices[iCursor++] = i10;
        indices[iCursor++] = i01;
        indices[iCursor++] = i11;
      }
    }
  }

  // Impact line centre at v = 1 on primary ribbon for mist & boil alignment.
  const impactCenter = [0, 0, 0];
  _evalCurtainRibbonPoint(site, 0.5, 1.0, 0, impactCenter);

  return {
    positions,
    normals,
    uvs,
    dropMeta,
    indices,
    vertexCount: totalVerts,
    triangleCount: totalIndices / 3,
    impactCenter,
  };
}

/**
 * Build billowing plunge-pool rising mist plume quads anchored around the
 * curtain's `lower_z` impact zone (cylindrical-billboarded in vertex shader).
 */
export function buildPlungeMistData(site, qualityCfg = WATERFALL_QUALITY_TIERS.high, impactCenter = null) {
  const baseCount = qualityCfg?.mistPlumesBase || 8;
  const maxCount = qualityCfg?.mistPlumesMax || 12;
  const extra = Math.floor(Math.min(1, site.dropM / 80.0) * (maxCount - baseCount));
  const plumeCount = Math.max(3, Math.min(maxCount, baseCount + extra));

  const cx = impactCenter ? impactCenter[0] : site.foot[0];
  const cy = impactCenter ? impactCenter[1] : site.foot[1];
  const cz = site.foot[2];

  const plumeBaseH = Math.min(30.0, Math.max(4.5, 3.8 + site.dropM * 0.28));
  const plumeBaseW = Math.min(34.0, Math.max(6.0, site.widthM * 0.48 + site.dropM * 0.12));

  const positions = new Float32Array(plumeCount * 4 * 3);
  const uvs = new Float32Array(plumeCount * 4 * 2);
  // aPlumeMeta: (widthM, heightM, phase01, opacityWeight)
  const plumeMeta = new Float32Array(plumeCount * 4 * 4);
  const indices = new Uint16Array(plumeCount * 6);

  const cornerUvs = [
    [-0.5, 0.0, 0.0, 0.0],
    [0.5, 0.0, 1.0, 0.0],
    [0.5, 1.0, 1.0, 1.0],
    [-0.5, 1.0, 0.0, 1.0],
  ];

  for (let i = 0; i < plumeCount; i += 1) {
    const h0 = waterfallHash01(site.id * 9137 + 5, i * 3);
    const h1 = waterfallHash01(site.id * 9137 + 5, i * 3 + 1);
    const h2 = waterfallHash01(site.id * 9137 + 5, i * 3 + 2);

    const acrossT = plumeCount > 1 ? (i / (plumeCount - 1)) * 2.0 - 1.0 : 0.0;
    const acrossOff = acrossT * site.widthM * 0.44 + (h0 - 0.5) * 3.2;
    const fwdOff = (h1 - 0.25) * Math.min(12.0, 3.5 + site.dropM * 0.10);

    const ax = cx + site.acrossDir[0] * acrossOff + site.flowDir[0] * fwdOff;
    const ay = cy + site.acrossDir[1] * acrossOff + site.flowDir[1] * fwdOff;
    const az = cz - 0.35;

    const w = plumeBaseW * (0.76 + 0.48 * h0);
    const h = plumeBaseH * (0.72 + 0.52 * h1) * (1.0 - 0.22 * Math.abs(acrossT));
    const opacityW = (0.55 + 0.38 * h2) * Math.min(1.0, 0.45 + site.dropM / 28.0);

    for (let k = 0; k < 4; k += 1) {
      const vi = i * 4 + k;
      // Anchor stored in position; corner local offset packed into uv -> expanded in VS.
      positions[vi * 3] = ax;
      positions[vi * 3 + 1] = ay;
      positions[vi * 3 + 2] = az;

      uvs[vi * 2] = cornerUvs[k][2];
      uvs[vi * 2 + 1] = cornerUvs[k][3];

      plumeMeta[vi * 4] = w;
      plumeMeta[vi * 4 + 1] = h;
      plumeMeta[vi * 4 + 2] = h2;
      plumeMeta[vi * 4 + 3] = opacityW;
    }

    const b = i * 4;
    const ic = i * 6;
    indices[ic] = b;
    indices[ic + 1] = b + 1;
    indices[ic + 2] = b + 2;
    indices[ic + 3] = b;
    indices[ic + 4] = b + 2;
    indices[ic + 5] = b + 3;
  }

  return {
    positions,
    uvs,
    plumeMeta,
    indices,
    plumeCount,
    vertexCount: plumeCount * 4,
    triangleCount: plumeCount * 2,
  };
}

/**
 * Build turbulent expanding surface foam boil disc at `lower_z + 0.08 m`
 * oriented along the curtain's across/flow axes.
 */
export function buildPlungeBoilData(site, qualityCfg = WATERFALL_QUALITY_TIERS.high, impactCenter = null) {
  const segs = Math.max(12, qualityCfg?.boilSegments || 28);
  const cx = impactCenter ? impactCenter[0] : site.foot[0];
  const cy = impactCenter ? impactCenter[1] : site.foot[1];
  const cz = site.foot[2] + 0.08;

  const rx = Math.min(38.0, Math.max(4.5, site.widthM * 0.62 + 2.5));
  const ry = Math.min(28.0, Math.max(4.0, 3.8 + site.dropM * 0.22));

  // Center + inner ring + outer ring so radial UV interpolation is smooth.
  const rings = 2;
  const vertexCount = 1 + rings * segs;
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const boilMeta = new Float32Array(vertexCount * 2);
  const indices = new Uint16Array(segs * 3 + segs * 6);

  const seed = waterfallHash01(site.id * 4253 + 9, 0);
  // Shift center slightly downstream of impact line where plunge boil wells up.
  const fwdShift = Math.min(4.2, 1.0 + site.dropM * 0.05);
  const ox = cx + site.flowDir[0] * fwdShift;
  const oy = cy + site.flowDir[1] * fwdShift;

  positions[0] = ox;
  positions[1] = oy;
  positions[2] = cz;
  uvs[0] = 0.5;
  uvs[1] = 0.5;
  boilMeta[0] = seed;
  boilMeta[1] = Math.min(1.0, 0.55 + site.dropM / 30.0);

  for (let ring = 1; ring <= rings; ring += 1) {
    const rFrac = ring / rings;
    for (let s = 0; s < segs; s += 1) {
      const ang = (s / segs) * Math.PI * 2.0;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const lx = ca * rx * rFrac;
      const ly = sa * ry * rFrac;
      const vi = 1 + (ring - 1) * segs + s;
      positions[vi * 3] = ox + site.acrossDir[0] * lx + site.flowDir[0] * ly;
      positions[vi * 3 + 1] = oy + site.acrossDir[1] * lx + site.flowDir[1] * ly;
      positions[vi * 3 + 2] = cz;
      uvs[vi * 2] = 0.5 + 0.5 * ca * rFrac;
      uvs[vi * 2 + 1] = 0.5 + 0.5 * sa * rFrac;
      boilMeta[vi * 2] = seed;
      boilMeta[vi * 2 + 1] = Math.min(1.0, 0.55 + site.dropM / 30.0);
    }
  }

  let ic = 0;
  for (let s = 0; s < segs; s += 1) {
    const n = (s + 1) % segs;
    indices[ic++] = 0;
    indices[ic++] = 1 + s;
    indices[ic++] = 1 + n;
  }
  for (let s = 0; s < segs; s += 1) {
    const n = (s + 1) % segs;
    const i0 = 1 + s;
    const i1 = 1 + n;
    const o0 = 1 + segs + s;
    const o1 = 1 + segs + n;
    indices[ic++] = i0;
    indices[ic++] = o0;
    indices[ic++] = i1;
    indices[ic++] = i1;
    indices[ic++] = o0;
    indices[ic++] = o1;
  }

  return {
    positions,
    uvs,
    boilMeta,
    indices,
    vertexCount,
    triangleCount: indices.length / 3,
  };
}

// ---------------------------------------------------------------------------
// GLSL shaders (ASCII-only, no backticks; wrapped with `withLogDepth`).
// ---------------------------------------------------------------------------

const GLSL_NOISE_HELPERS = `
float wfHash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float wfNoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = wfHash21(i);
  float b = wfHash21(i + vec2(1.0, 0.0));
  float c = wfHash21(i + vec2(0.0, 1.0));
  float d = wfHash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float wfFbm(vec2 p) {
  float v = 0.55 * wfNoise2(p);
  v += 0.30 * wfNoise2(p * 2.13 + vec2(7.3, -4.1));
  v += 0.15 * wfNoise2(p * 4.37 - vec2(3.7, 9.2));
  return v;
}
`;

export const WATERFALL_CURTAIN_VERTEX_GLSL = `
precision highp float;

attribute vec4 aDropMeta; // (dropM, speedScale, phaseSeed, layerAlpha)

uniform float uTime;

varying vec2 vUv;
varying vec3 vAcNormal;
varying vec3 vAcPos;
varying float vViewDist;
varying vec4 vDropMeta;

void main() {
  float u = uv.x;
  float v = uv.y;
  float speed = aDropMeta.y;
  float seed = aDropMeta.z;

  // Hydrodynamic wave billow along curtain normal (pinned to 0 at v=0 lip).
  float env = sin(3.14159265 * clamp(v, 0.0, 1.0)) * smoothstep(0.0, 0.14, v);
  float waveA = sin((v * 9.0 - uTime * 3.1 * speed) + u * 8.0 + seed * 6.28318);
  float waveB = sin((v * 17.0 - uTime * 4.7 * speed) - u * 13.0 + seed * 12.566);
  float disp = env * (0.22 * waveA + 0.11 * waveB) * clamp(aDropMeta.x / 26.0, 0.35, 1.6);

  vec3 displaced = position + normal * disp;
  vec4 viewPos = modelViewMatrix * vec4(displaced, 1.0);

  vUv = uv;
  vAcNormal = normalize(normal);
  vAcPos = displaced;
  vViewDist = -viewPos.z;
  vDropMeta = aDropMeta;

  gl_Position = projectionMatrix * viewPos;
}
`;

export const WATERFALL_CURTAIN_FRAGMENT_GLSL = `
precision highp float;

uniform float uTime;
uniform float uMaxRangeM;
uniform vec3 uSunDir;       // AC space (+Z up)
uniform vec3 uSunColor;
uniform vec3 uAmbientColor;

varying vec2 vUv;
varying vec3 vAcNormal;
varying vec3 vAcPos;
varying float vViewDist;
varying vec4 vDropMeta;

${GLSL_NOISE_HELPERS}

void main() {
  float u = vUv.x;
  float v = vUv.y;
  float dropM = max(vDropMeta.x, 1.5);
  float speed = vDropMeta.y;
  float seed = vDropMeta.z;
  float hasStaticAnchors = vDropMeta.w < 0.0 ? 1.0 : 0.0;
  float layerAlpha = abs(vDropMeta.w);

  // Distance & near-camera safety fades.
  float rangeFade = 1.0 - smoothstep(uMaxRangeM * 0.84, uMaxRangeM, vViewDist);
  float nearFade = smoothstep(1.5, 5.5, vViewDist);
  if (rangeFade * nearFade <= 0.002) discard;

  // Gravity-accelerating vertical coordinate: filaments elongate as velocity
  // grows toward the plunge pool (v -> 1).
  float dropTiles = clamp(dropM * 0.16, 1.4, 14.0);
  float gravV = (v - 0.33 * v * v) * dropTiles;

  // Dual-speed scrolling striated water threads + fine turbulent spray lace.
  vec2 uvSlow = vec2(u * 11.5 + seed * 5.1, gravV * 1.15 - uTime * (1.55 * speed));
  vec2 uvFast = vec2(u * 21.0 - seed * 3.7, gravV * 0.85 - uTime * (2.38 * speed));
  float warp = (wfNoise2(vec2(u * 6.0 + seed, gravV * 0.6 - uTime * 0.9 * speed)) - 0.5) * 0.16;

  float threadSlow = wfFbm(uvSlow + vec2(warp * 4.0, 0.0));
  float threadFast = wfFbm(uvFast - vec2(warp * 6.5, 0.0));
  float striations = clamp(0.56 * threadSlow + 0.44 * threadFast, 0.0, 1.0);
  float coreJet = smoothstep(0.32, 0.78, striations);

  // Frothy aerated white crest rolling over the lip + churned impact spray.
  float lipCrest = smoothstep(0.22, 0.03, v) * (0.60 + 0.40 * threadFast);
  float footSpray = smoothstep(0.72, 1.0, v) * (0.55 + 0.45 * threadSlow);
  float foamWeight = clamp(coreJet * 0.76 + lipCrest * 0.72 + footSpray * 0.58, 0.0, 1.0);

  // Organic lateral tendril breakup + rock-notched feathered lip & plunge transitions
  // so curtains NEVER show a straight horizontal or vertical rectangle edge.
  float edgeWarp = (striations - 0.45) * 0.15;
  float sideFeather = smoothstep(0.0, 0.25, u + edgeWarp) * smoothstep(1.0, 0.75, u - edgeWarp);
  float topFeather = smoothstep(0.0, 0.16 + 0.09 * threadSlow, v);
  float botFeather = smoothstep(1.0, 0.80 - 0.06 * threadFast, v);

  // On anchor-backed sites, smoothly act as a cohesive translucent hydro-veil up close
  // (< 320 m where retail water_sheet spouts are active) and ramp to 100% at long range.
  float anchorVeil = mix(1.0, mix(0.38, 1.0, smoothstep(130.0, 340.0, vViewDist)), hasStaticAnchors);

  // Aerated turquoise-cyan water body + crisp whitewater foam threads,
  // HDR bloom-safe calibrated to live diurnal sun + ambient lighting.
  vec3 sunDirN = normalize(uSunDir + vec3(0.0, 0.0, 1e-4));
  vec3 nAc = normalize(vAcNormal + vec3((threadFast - 0.5) * 0.35, (threadSlow - 0.5) * 0.35, 0.22));
  float ndl = max(dot(nAc, sunDirN), 0.0) * 0.65 + 0.35;
  float dayLift = smoothstep(-0.08, 0.22, sunDirN.z);
  vec3 envLight = clamp(uAmbientColor + uSunColor * (ndl * (0.35 + 0.65 * dayLift)), vec3(0.05, 0.07, 0.11), vec3(0.84));

  vec3 aquaBody = vec3(0.24, 0.54, 0.66);
  vec3 foamWhite = vec3(0.88, 0.95, 0.99);
  vec3 baseCol = mix(aquaBody, foamWhite, foamWeight);

  // Sun / moon forward scatter & specular sheen on falling water droplets (bloom-safe < 0.90).
  float spec = pow(max(dot(nAc, normalize(sunDirN + vec3(0.0, 0.0, 0.55))), 0.0), 18.0);
  vec3 litCol = min(baseCol * envLight + uSunColor * (spec * 0.24 * (0.25 + 0.75 * foamWeight) * dayLift), vec3(0.88));

  float alpha = sideFeather * topFeather * botFeather
              * (0.26 + 0.60 * foamWeight)
              * layerAlpha * anchorVeil * rangeFade * nearFade;
  if (alpha <= 0.004) discard;

  gl_FragColor = vec4(litCol, clamp(alpha, 0.0, 0.88));
}
`;

export const WATERFALL_MIST_VERTEX_GLSL = `
precision highp float;

attribute vec4 aPlumeMeta; // (widthM, heightM, phase01, opacityWeight)

uniform float uTime;

varying vec2 vUv;
varying float vAlpha;
varying float vPhase;
varying float vViewDist;

void main() {
  // Cylindrical billboard in AC space (+Z up -> view space).
  vec4 anchorView = modelViewMatrix * vec4(position, 1.0);
  vec3 upView = normalize((modelViewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
  vec3 rightView = cross(upView, vec3(0.0, 0.0, 1.0));
  float rl = length(rightView);
  rightView = (rl > 1e-4) ? (rightView / rl) : vec3(1.0, 0.0, 0.0);

  float cycle = fract(uTime * 0.085 + aPlumeMeta.z);
  float riseM = cycle * aPlumeMeta.y * 0.42;
  float expand = 0.82 + 0.46 * cycle;
  float lifeEnv = smoothstep(0.0, 0.22, cycle) * smoothstep(1.0, 0.48, cycle);

  float quadX = (uv.x - 0.5) * aPlumeMeta.x * expand;
  float quadY = uv.y * aPlumeMeta.y * (0.85 + 0.30 * cycle) + riseM;

  vec3 viewPos = anchorView.xyz + rightView * quadX + upView * quadY;
  vUv = uv;
  vPhase = aPlumeMeta.z;
  vAlpha = aPlumeMeta.w * (0.48 + 0.52 * lifeEnv);
  vViewDist = -viewPos.z;

  gl_Position = projectionMatrix * vec4(viewPos, 1.0);
}
`;

export const WATERFALL_MIST_FRAGMENT_GLSL = `
precision highp float;

uniform float uTime;
uniform float uMaxRangeM;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbientColor;

varying vec2 vUv;
varying float vAlpha;
varying float vPhase;
varying float vViewDist;

${GLSL_NOISE_HELPERS}

void main() {
  float rangeFade = 1.0 - smoothstep(uMaxRangeM * 0.80, uMaxRangeM, vViewDist);
  float nearFade = smoothstep(2.5, 9.0, vViewDist);
  if (rangeFade * nearFade <= 0.002) discard;

  vec2 c = vUv * 2.0 - 1.0;
  float radial = max(0.0, 1.0 - dot(c * vec2(1.0, 0.92), c * vec2(1.0, 0.92)));
  float vertSoft = smoothstep(0.0, 0.22, vUv.y) * pow(max(0.0, 1.0 - vUv.y), 1.15);

  vec2 billowUv = vec2(vUv.x * 2.6 + vPhase * 4.3, vUv.y * 2.2 - uTime * 0.22);
  float billow = wfFbm(billowUv);
  float density = pow(radial, 1.45) * vertSoft * smoothstep(0.22, 0.78, billow);

  float dayLift = smoothstep(-0.08, 0.25, normalize(uSunDir + vec3(0.0, 0.0, 1e-4)).z);
  vec3 mistLight = clamp(uAmbientColor * 1.05 + uSunColor * (0.38 * dayLift), vec3(0.05, 0.07, 0.11), vec3(0.78));
  vec3 mistCol = vec3(0.84, 0.92, 0.97) * mistLight;

  float a = density * vAlpha * 0.42 * rangeFade * nearFade;
  if (a <= 0.003) discard;
  gl_FragColor = vec4(mistCol, clamp(a, 0.0, 0.50));
}
`;

export const WATERFALL_BOIL_VERTEX_GLSL = `
precision highp float;

attribute vec2 aBoilMeta; // (seed, intensity)

varying vec2 vUv;
varying vec2 vBoilMeta;
varying float vViewDist;

void main() {
  vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
  vUv = uv;
  vBoilMeta = aBoilMeta;
  vViewDist = -viewPos.z;
  gl_Position = projectionMatrix * viewPos;
}
`;

export const WATERFALL_BOIL_FRAGMENT_GLSL = `
precision highp float;

uniform float uTime;
uniform float uMaxRangeM;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbientColor;

varying vec2 vUv;
varying vec2 vBoilMeta;
varying float vViewDist;

${GLSL_NOISE_HELPERS}

void main() {
  float rangeFade = 1.0 - smoothstep(uMaxRangeM * 0.75, uMaxRangeM * 0.96, vViewDist);
  float nearFade = smoothstep(0.8, 3.0, vViewDist);
  if (rangeFade * nearFade <= 0.002) discard;

  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r >= 1.0) discard;

  float seed = vBoilMeta.x;
  float intensity = vBoilMeta.y;
  float ang = atan(p.y, p.x);

  // Outward-expanding concentric boil rings + turbulent lacy whitewater foam.
  float warp = wfFbm(p * 3.4 + vec2(seed * 6.1, -uTime * 0.32)) - 0.5;
  float rr = clamp(r + warp * 0.16, 0.0, 1.0);
  float ringA = pow(0.5 + 0.5 * sin(rr * 22.0 - uTime * 3.4 + seed * 6.28), 3.0);
  float ringB = pow(0.5 + 0.5 * sin(rr * 35.0 - uTime * 4.6 + ang * 2.0), 4.0);
  float lace = wfFbm(p * 5.8 - vec2(p.x, p.y) * (uTime * 0.45) + seed * 3.3);

  float impactCore = smoothstep(0.52, 0.05, rr) * (0.55 + 0.45 * lace);
  float rings = (0.62 * ringA + 0.45 * ringB) * smoothstep(0.28, 0.74, lace) * (1.0 - smoothstep(0.55, 0.98, rr));
  float radialFade = 1.0 - smoothstep(0.68, 1.0, r);

  float foam = clamp((impactCore * 0.88 + rings * 0.76) * radialFade * intensity, 0.0, 1.0);
  if (foam <= 0.005) discard;

  float dayLift = smoothstep(-0.08, 0.25, normalize(uSunDir + vec3(0.0, 0.0, 1e-4)).z);
  vec3 lightCol = clamp(uAmbientColor * 1.08 + uSunColor * (0.42 * dayLift), vec3(0.06, 0.08, 0.12), vec3(0.82));
  vec3 foamCol = mix(vec3(0.48, 0.78, 0.86), vec3(0.90, 0.97, 0.99), foam) * lightCol;

  gl_FragColor = vec4(foamCol, clamp(foam * 0.78 * rangeFade * nearFade, 0.0, 0.82));
}
`;

// ---------------------------------------------------------------------------
// Runtime state & Terrain-VFX provider integration.
// ---------------------------------------------------------------------------

let _wf = null;
const _stats = {
  inits: 0,
  loads: 0,
  ticks: 0,
  builds: 0,
  releases: 0,
};

function _createSharedUniforms(THREE) {
  const mkV3 = (x, y, z) => (THREE && THREE.Vector3 ? new THREE.Vector3(x, y, z) : { x, y, z, set(nx, ny, nz) { this.x = nx; this.y = ny; this.z = nz; } });
  return {
    uTime: { value: 0 },
    uMaxRangeM: { value: WATERFALL_ENGAGE_M },
    uSunDir: { value: mkV3(0.35, -0.45, 0.82) },
    uSunColor: { value: mkV3(1.0, 0.96, 0.88) },
    uAmbientColor: { value: mkV3(0.38, 0.44, 0.52) },
  };
}

function _buildSharedMaterials(THREE, uniforms) {
  if (!THREE || typeof THREE.ShaderMaterial !== "function") return null;
  const curtainMat = new THREE.ShaderMaterial(withLogDepth({
    uniforms,
    vertexShader: WATERFALL_CURTAIN_VERTEX_GLSL,
    fragmentShader: WATERFALL_CURTAIN_FRAGMENT_GLSL,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  }));
  curtainMat.name = "waterfall-curtain-material";

  const mistMat = new THREE.ShaderMaterial(withLogDepth({
    uniforms,
    vertexShader: WATERFALL_MIST_VERTEX_GLSL,
    fragmentShader: WATERFALL_MIST_FRAGMENT_GLSL,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  }));
  mistMat.name = "waterfall-mist-material";

  const boilMat = new THREE.ShaderMaterial(withLogDepth({
    uniforms,
    vertexShader: WATERFALL_BOIL_VERTEX_GLSL,
    fragmentShader: WATERFALL_BOIL_FRAGMENT_GLSL,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  }));
  boilMat.name = "waterfall-boil-material";

  return { curtainMat, mistMat, boilMat };
}

function _buildSiteAssembly(state, site) {
  const qCfg = resolveWaterfallQuality(state.quality);
  const curtainData = buildWaterfallCurtainData(site, qCfg);
  const mistData = buildPlungeMistData(site, qCfg, curtainData.impactCenter);
  const boilData = buildPlungeBoilData(site, qCfg, curtainData.impactCenter);

  let group = null;
  const THREE = state.THREE;
  if (THREE && state.materials) {
    group = new THREE.Group();
    group.name = `waterfall-site-${site.id}-${site.lb}`;
    group.userData = { waterfallSiteId: site.id, lb: site.lb, archetype: site.archetype };

    // 1. Parabolic 3D waterfall curtain mesh
    const cGeom = new THREE.BufferGeometry();
    cGeom.setAttribute("position", new THREE.BufferAttribute(curtainData.positions, 3));
    cGeom.setAttribute("normal", new THREE.BufferAttribute(curtainData.normals, 3));
    cGeom.setAttribute("uv", new THREE.BufferAttribute(curtainData.uvs, 2));
    cGeom.setAttribute("aDropMeta", new THREE.BufferAttribute(curtainData.dropMeta, 4));
    cGeom.setIndex(new THREE.BufferAttribute(curtainData.indices, 1));
    cGeom.computeBoundingSphere();
    const curtainMesh = new THREE.Mesh(cGeom, state.materials.curtainMat);
    curtainMesh.name = `waterfall-curtain-${site.id}`;
    curtainMesh.castShadow = false;
    curtainMesh.receiveShadow = false;
    curtainMesh.renderOrder = 3;
    group.add(curtainMesh);

    // 2. Plunge-pool surface foam boil ring mesh
    const bGeom = new THREE.BufferGeometry();
    bGeom.setAttribute("position", new THREE.BufferAttribute(boilData.positions, 3));
    bGeom.setAttribute("uv", new THREE.BufferAttribute(boilData.uvs, 2));
    bGeom.setAttribute("aBoilMeta", new THREE.BufferAttribute(boilData.boilMeta, 2));
    bGeom.setIndex(new THREE.BufferAttribute(boilData.indices, 1));
    bGeom.computeBoundingSphere();
    const boilMesh = new THREE.Mesh(bGeom, state.materials.boilMat);
    boilMesh.name = `waterfall-boil-${site.id}`;
    boilMesh.castShadow = false;
    boilMesh.receiveShadow = false;
    boilMesh.renderOrder = 2;
    group.add(boilMesh);

    // 3. Billowing plunge-pool rising mist plumes
    const mGeom = new THREE.BufferGeometry();
    mGeom.setAttribute("position", new THREE.BufferAttribute(mistData.positions, 3));
    mGeom.setAttribute("uv", new THREE.BufferAttribute(mistData.uvs, 2));
    mGeom.setAttribute("aPlumeMeta", new THREE.BufferAttribute(mistData.plumeMeta, 4));
    mGeom.setIndex(new THREE.BufferAttribute(mistData.indices, 1));
    // Generous bounding sphere for shader-billboarded mist plumes.
    mGeom.computeBoundingSphere();
    if (mGeom.boundingSphere) mGeom.boundingSphere.radius += 40;
    const mistMesh = new THREE.Mesh(mGeom, state.materials.mistMat);
    mistMesh.name = `waterfall-mist-${site.id}`;
    mistMesh.castShadow = false;
    mistMesh.receiveShadow = false;
    mistMesh.frustumCulled = false;
    mistMesh.renderOrder = 4;
    group.add(mistMesh);

    if (state.rootGroup) state.rootGroup.add(group);
  }

  _stats.builds += 1;
  return {
    site,
    curtainData,
    mistData,
    boilData,
    group,
  };
}

function _disposeSiteAssembly(state, rec) {
  if (!rec) return;
  if (rec.group) {
    if (rec.group.parent) {
      try { rec.group.parent.remove(rec.group); } catch (_) {}
    }
    const kids = rec.group.children ? rec.group.children.slice() : [];
    for (const k of kids) {
      if (k && k.geometry && typeof k.geometry.dispose === "function") {
        try { k.geometry.dispose(); } catch (_) {}
      }
    }
  }
  _stats.releases += 1;
}

function _readEyeAc(frameCtx, scene3d, out) {
  // Prefer camera AC position for long-range scenic/drone/film views (up to
  // 1,800 m), falling back to frameCtx.playerPos.
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

const STATIC_WATERFALL_MODEL_IDS = new Set([
  0x020003c5,
  0x020003e4,
  0x02000859,
  0x0200085a,
  0x02000b4e,
]);

const WATERFALL_EMITTER_INFO_IDS = new Set([
  0x32000031,
  0x320004a2,
  0x320004a3,
  0x320004a4,
  0x3200063a,
  0x3200063b,
]);

function _syncLightingUniforms(state, scene3d) {
  const u = state.uniforms;
  if (!u || !scene3d) return;
  try {
    // Prefer SkyLightingController._lastState (retail-matched, HDR bloom-safe
    // like terrain_shore.js & terrain_rock.js) so Bruneton solar illuminance
    // never blows out the waterfall curtain into pure white under HDR bloom.
    const sky = scene3d.skyLightingController?._lastState || null;
    if (sky && Number.isFinite(sky.dirHeading) && Number.isFinite(sky.dirPitch)) {
      const DEG = Math.PI / 180;
      const cp = Math.cos(sky.dirPitch * DEG);
      u.uSunDir.value.set(
        cp * Math.sin(sky.dirHeading * DEG),
        cp * Math.cos(sky.dirHeading * DEG),
        Math.sin(sky.dirPitch * DEG),
      );
      const db = Number.isFinite(+sky.dirBright) ? Math.max(0, Math.min(1.2, +sky.dirBright)) : 0.7;
      const dc = (sky.dirColorArgb >>> 0);
      const sunScale = 0.44 * db;
      u.uSunColor.value.set(
        (((dc >>> 16) & 0xff) / 255) * sunScale,
        (((dc >>> 8) & 0xff) / 255) * sunScale,
        ((dc & 0xff) / 255) * sunScale,
      );
      const ab = Number.isFinite(+sky.ambBright) ? Math.max(0.10, Math.min(1.0, +sky.ambBright)) : 0.42;
      const ac = (sky.ambColorArgb >>> 0);
      const ambScale = 0.42 * ab;
      u.uAmbientColor.value.set(
        (((ac >>> 16) & 0xff) / 255) * ambScale,
        (((ac >>> 8) & 0xff) / 255) * ambScale,
        ((ac & 0xff) / 255) * ambScale,
      );
      return;
    }

    const exp = Number.isFinite(scene3d.renderer?.toneMappingExposure) && scene3d.renderer.toneMappingExposure > 0
      ? Math.min(1.0, 0.45 / Math.max(0.5, scene3d.renderer.toneMappingExposure))
      : 0.42;
    if (scene3d.sunLight?.position) {
      const p = scene3d.sunLight.position;
      const len = Math.hypot(p.x, p.y, p.z) || 1;
      u.uSunDir.value.set(p.x / len, -p.z / len, p.y / len);
    }
    if (scene3d.sunLight?.color) {
      const c = scene3d.sunLight.color;
      u.uSunColor.value.set(c.r * exp, c.g * exp, c.b * exp);
    }
    if (scene3d.ambientLight?.color) {
      const a = scene3d.ambientLight.color;
      u.uAmbientColor.value.set(a.r * 0.34, a.g * 0.34, a.b * 0.34);
    }
  } catch (_) { /* fail-soft */ }
}

/**
 * When resident static waterfall anchors (`0x020003c5` / `0x020003e4` / `0x02000859` /
 * `0x0200085a` / `0x02000b4e`) stream into `scene3d.staticsGroup` near an active
 * `anchors > 0` waterfall site, snap the curtain's lip XY/Z and lateral width to
 * the exact authored spout cluster once so close-range curtains align to the
 * real cliff waterfall (e.g. Nanto Blue Ghost Falls & Cragstone Falls).
 */
function _tryRefineSiteWithResidentStatics(state, scene3d, rec) {
  if (!rec || rec.anchorRefined || !(rec.site.anchors > 0) || rec.site.isMaraeCascade) return;

  const midX = rec.site.mid[0];
  const midY = rec.site.mid[1];
  const found = [];

  // 1. Check live static waterfall particle emitters (works with ?anchorOffGraph=on).
  const pTable = scene3d?._staticParticleManager?.particleTable;
  if (pTable && typeof pTable.values === "function") {
    for (const em of pTable.values()) {
      const eid = (em?.emitterInfo?.id ?? em?.info?.id ?? 0) >>> 0;
      if (!WATERFALL_EMITTER_INFO_IDS.has(eid)) continue;
      let anchor = em.parent;
      while (anchor && !anchor.userData?.isStaticScriptAnchor && anchor.parent) {
        anchor = anchor.parent;
      }
      const pos = anchor?.position || em?.parent?.position;
      if (!pos) continue;
      const ax = pos.x;
      const ay = pos.y;
      const az = pos.z;
      if (Number.isFinite(ax) && Number.isFinite(ay) && Math.hypot(ax - midX, ay - midY) <= 220) {
        found.push([ax, ay, Number.isFinite(az) ? az : rec.site.lip[2]]);
      }
    }
  }

  // 2. Fallback: walk staticsGroup nodes when modelId/setupId is tagged directly.
  const sg = scene3d?.staticsGroup;
  if (found.length === 0 && sg && Array.isArray(sg.children) && sg.children.length > 0) {
    const stack = sg.children.slice();
    while (stack.length > 0) {
      const obj = stack.pop();
      if (!obj) continue;
      const mid = (obj.userData?.modelId ?? obj.userData?.setupId ?? 0) >>> 0;
      if (STATIC_WATERFALL_MODEL_IDS.has(mid) && obj.position) {
        const ax = obj.position.x;
        const ay = obj.position.y;
        const az = obj.position.z;
        if (Number.isFinite(ax) && Number.isFinite(ay) && Math.hypot(ax - midX, ay - midY) <= 210) {
          found.push([ax, ay, Number.isFinite(az) ? az : rec.site.lip[2]]);
        }
      }
      if (Array.isArray(obj.children) && obj.children.length > 0 && stack.length < 4096) {
        for (let i = 0; i < obj.children.length; i += 1) stack.push(obj.children[i]);
      }
    }
  }

  if (found.length === 0) return;
  rec.anchorRefined = true;

  // Sort descending by Z so top quartile defines the true cliff crest!
  found.sort((a, b) => b[2] - a[2]);
  const topN = Math.max(1, Math.ceil(found.length * 0.45));
  let cx = 0;
  let cy = 0;
  let maxZ = -Infinity;
  for (let i = 0; i < topN; i += 1) {
    cx += found[i][0];
    cy += found[i][1];
    if (found[i][2] > maxZ) maxZ = found[i][2];
  }
  cx /= topN;
  cy /= topN;

  const axDir = rec.site.acrossDir[0];
  const ayDir = rec.site.acrossDir[1];
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (let i = 0; i < found.length; i += 1) {
    const lat = (found[i][0] - cx) * axDir + (found[i][1] - cy) * ayDir;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  const latMid = 0.5 * (minLat + maxLat);
  const refinedLipX = cx + axDir * latMid;
  const refinedLipY = cy + ayDir * latMid;
  const refinedLipZ = Math.max(rec.site.foot[2] + 2.0, Number.isFinite(maxZ) ? maxZ : rec.site.lip[2]);
  const refinedDropM = Math.max(MIN_WATERFALL_DROP_M, refinedLipZ - rec.site.foot[2]);
  const spanWidth = Math.max(rec.site.widthM, (maxLat - minLat) + 11.0);
  const refinedWidthM = Math.min(66.0, Math.max(8.5, spanWidth));
  const refinedSpanM = Math.min(20.0, Math.max(8.5, refinedDropM * 0.34));

  const refinedSite = {
    ...rec.site,
    curtainLip: [refinedLipX, refinedLipY, refinedLipZ],
    foot: [
      refinedLipX + rec.site.flowDir[0] * refinedSpanM,
      refinedLipY + rec.site.flowDir[1] * refinedSpanM,
      rec.site.foot[2],
    ],
    dropM: refinedDropM,
    curtainHorizSpanM: refinedSpanM,
    isChute: false,
    widthM: refinedWidthM,
  };

  const rebuilt = _buildSiteAssembly(state, refinedSite);
  rebuilt.anchorRefined = true;
  _disposeSiteAssembly(state, rec);
  state.active.set(rec.site.id, rebuilt);
}

function _tickWaterfalls(dt, frameCtx) {
  if (!_wf) return;
  _stats.ticks += 1;

  const scene3d = frameCtx?.scene3d || _wf.scene3d;
  if (frameCtx?.quality) _wf.quality = frameCtx.quality;
  else if (scene3d?.quality) _wf.quality = scene3d.quality;

  // Lazy re-parent if worldRoot attached after initWaterfallsVfx.
  if (_wf.rootGroup && !_wf.rootGroup.parent) {
    const parent = _wf.parent || scene3d?.terrainGroup?.parent || scene3d?.staticsGroup || null;
    if (parent && typeof parent.add === "function") {
      parent.add(_wf.rootGroup);
    }
  }

  const tSec = Number.isFinite(frameCtx?.tSec)
    ? frameCtx.tSec
    : (_wf.uniforms.uTime.value + (Number.isFinite(dt) ? dt : 0));
  _wf.uniforms.uTime.value = tSec;
  _wf.uniforms.uMaxRangeM.value = _wf.engageM;
  _syncLightingUniforms(_wf, scene3d);

  if (!_wf.sitesLoaded || _wf.sites.length === 0) return;
  if (!_readEyeAc(frameCtx, scene3d, _wf.eyeAc)) return;

  const near = activeWaterfallSitesNear(_wf.sites, _wf.eyeAc, _wf.active, {
    engageM: _wf.engageM,
    dropM: _wf.dropM,
  });

  const keepIds = new Set();
  for (const item of near) {
    keepIds.add(item.site.id);
    if (!_wf.active.has(item.site.id)) {
      _wf.active.set(item.site.id, _buildSiteAssembly(_wf, item.site));
    }
    if (item.distM <= 420 && (_stats.ticks % 30) === 1) {
      _tryRefineSiteWithResidentStatics(_wf, scene3d, _wf.active.get(item.site.id));
    }
  }

  for (const [id, rec] of _wf.active.entries()) {
    if (!keepIds.has(id)) {
      _disposeSiteAssembly(_wf, rec);
      _wf.active.delete(id);
    }
  }
}

/**
 * Initialise the long-range 3D waterfalls provider (`terrain.waterfalls`).
 *
 * @param {object} [opts]
 * @param {object} [opts.THREE]      injected Three.js namespace (optional in Node tests)
 * @param {object} [opts.scene3d]    live scene3d facade
 * @param {object} [opts.parent]     AC-space parent group (defaults to `terrainGroup.parent`)
 * @param {Array|object} [opts.sites] optional preloaded `water_flow_sites.json`
 * @param {string} [opts.url]        override URL for `water_flow_sites.json`
 * @param {Function} [opts.fetchImpl] optional fetch implementation
 * @param {number} [opts.engageM]    override engage distance (default 1800 m)
 * @param {number} [opts.dropM]      override hysteresis release distance (default 1980 m)
 */
export function initWaterfallsVfx(opts = {}) {
  const quality = opts.quality || opts.scene3d?.quality || null;
  if (!opts.force && !terrainWaterfallsEnabled(quality)) return null;

  disposeWaterfallsVfx();

  const epoch = (_wf?.epoch || 0) + 1;
  const THREE = opts.THREE || null;
  const scene3d = opts.scene3d || null;
  const parent = opts.parent || scene3d?.terrainGroup?.parent || scene3d?.staticsGroup || null;
  const uniforms = _createSharedUniforms(THREE);
  const materials = _buildSharedMaterials(THREE, uniforms);

  let rootGroup = null;
  if (THREE && typeof THREE.Group === "function") {
    rootGroup = new THREE.Group();
    rootGroup.name = "terrain-waterfalls-root";
    if (parent && typeof parent.add === "function") parent.add(rootGroup);
  }

  const state = {
    epoch,
    THREE,
    scene3d,
    parent,
    quality,
    engageM: Number.isFinite(opts.engageM) ? opts.engageM : WATERFALL_ENGAGE_M,
    dropM: Number.isFinite(opts.dropM) ? opts.dropM : WATERFALL_DROP_M,
    uniforms,
    materials,
    rootGroup,
    catalogCount: 0,
    sites: [],
    sitesLoaded: false,
    loadError: null,
    active: new Map(),
    eyeAc: { x: NaN, y: NaN, z: 0 },
    providerHandle: null,
    readyPromise: null,
  };
  _wf = state;
  _stats.inits += 1;

  state.providerHandle = registerTerrainVfx({
    id: WATERFALLS_PROVIDER_ID,
    scope: "camera",
    enabled: () => opts.force ? true : terrainWaterfallsEnabled(_wf?.quality || _wf?.scene3d?.quality),
    update: _tickWaterfalls,
  });

  state.readyPromise = loadWaterfallSites({
    sites: opts.sites,
    url: opts.url,
    fetchImpl: opts.fetchImpl,
  }).then((res) => {
    if (_wf !== state) return state;
    state.catalogCount = res.catalogCount;
    state.sites = res.sites;
    state.sitesLoaded = true;
    _stats.loads += 1;
    return state;
  }).catch((err) => {
    if (_wf === state) state.loadError = String(err?.message || err);
    return state;
  });

  const surface = {
    id: WATERFALLS_PROVIDER_ID,
    ready: state.readyPromise,
    stats: waterfallsVfxStats,
    tick: (dt, frameCtx) => _tickWaterfalls(dt, frameCtx),
    dispose: disposeWaterfallsVfx,
    get rootGroup() { return state.rootGroup; },
    get activeIds() { return [...state.active.keys()]; },
  };
  try {
    if (typeof window !== "undefined") window.__terrainWaterfalls = surface;
  } catch (_) {}
  return surface;
}

export function waterfallsVfxStats() {
  const q = _wf?.quality || _wf?.scene3d?.quality || null;
  return {
    enabled: terrainWaterfallsEnabled(q),
    inited: !!_wf,
    sitesLoaded: !!_wf?.sitesLoaded,
    catalogCount: _wf ? _wf.catalogCount : 0,
    waterfallSiteCount: _wf ? _wf.sites.length : 0,
    activeCount: _wf ? _wf.active.size : 0,
    activeSites: _wf ? [..._wf.active.values()].map((r) => ({
      id: r.site.id,
      lb: r.site.lb,
      name: r.site.name,
      archetype: r.site.archetype,
      dropM: r.site.dropM,
      widthM: r.site.widthM,
    })) : [],
    engageM: _wf ? _wf.engageM : WATERFALL_ENGAGE_M,
    dropM: _wf ? _wf.dropM : WATERFALL_DROP_M,
    loadError: _wf ? _wf.loadError : null,
    counters: { ..._stats },
  };
}

export function disposeWaterfallsVfx() {
  if (!_wf) return;
  const st = _wf;
  _wf = null;
  try { unregisterTerrainVfx(WATERFALLS_PROVIDER_ID); } catch (_) {}
  for (const rec of st.active.values()) {
    _disposeSiteAssembly(st, rec);
  }
  st.active.clear();
  if (st.rootGroup && st.rootGroup.parent) {
    try { st.rootGroup.parent.remove(st.rootGroup); } catch (_) {}
  }
  if (st.materials) {
    for (const m of Object.values(st.materials)) {
      if (m && typeof m.dispose === "function") {
        try { m.dispose(); } catch (_) {}
      }
    }
  }
}

export function _resetWaterfallsVfx() {
  disposeWaterfallsVfx();
  for (const k of Object.keys(_stats)) _stats[k] = 0;
}
