// scene3d/dericost_world.js — 3D environmental scenery (unique flora, trees, ferns, rocks,
// monoliths, ruin cairns, glacial crystals) and 41-town architectural building, plaza + door
// framework renderer for the continent of Dericost.
//
// Streams per-landblock JSONL records from:
//   - ../../dist/dericost/index.json (zero-404 manifest of buildings/scenery/spawns/pois/towns)
//   - ../../dist/dericost/scenery/0xXXXX.scenery.jsonl
//   - ../../dist/dericost/buildings/0xXXXX.buildings.jsonl
// when the camera or aircraft is over Dericost (AC y >= 67,000 m).
//
// Surface & culling architecture:
//   - 256^2 procedural PBR texture sets (albedo + Sobel normalMap + roughnessMap + height/shimmer map)
//   - Instanced textureGrad Parallax Occlusion Mapping (4-6 steps + 2-tap sun crevice self-shadow,
//     fading 8m -> 22m) using fragment-stage instance-transformed TBN + shared VFX_GLOBALS.uTime shimmer
//   - Sway-matched customDepthMaterial + castShadow/receiveShadow on architectural & botanical casters
//   - Exact per-InstancedMesh boundingSphere + per-LB union-sphere camera frustum culling
//   - Time-sliced LB mesh construction (1-2 LBs/frame, nearest-to-player first)
//   - Full GPU geometry/material/texture disposal upon returning to Dereth (AC y < 67,000 m)

import * as THREE from "three";
import { softenCanopyNormals, canopySoftenStrength } from "./canopy_soften.js";
import { windSwayGpu } from "./vfx/components/windSwayGpu.js";
import { VFX_GLOBALS } from "./materials.js";
import {
  worldGroundHeight,
  loadWorldData,
  extractDericostLandblockData,
  DERICOST_Y_MIN,
  DERICOST_Y_MAX,
} from "./world_terrain.js";
import { terrainVfxNoteLandblockMesh, terrainVfxLandblockGone, lbKeyFromXY } from "./terrain_vfx.js";
import { initTerrainSwamp } from "./terrain_swamp.js";
import { initTerrainDirt } from "./terrain_dirt.js";
import { readParticleEnv } from "./vfx/particle_env.js";

const LB_M = 192.0;
const STREAM_RADIUS_LBS = 3; // 7x7 landblocks around camera (1.34 km x 1.34 km)
const MAX_CONCURRENT_FETCHES = 8;
const MAX_BUILD_BUDGET_PER_FRAME = 2; // 1 heavy town LB or up to 2 wilderness LBs per frame
const PROC_TEX_SIZE = 256;
const EARTH_BOTTOM_RADIUS = 6360000;

// Blueprint specs for all 18 Dericost building archetypes
const BUILDING_SPECS = {
  "0x01100001": { name: "Undead_Oligarch_Necrotic_Palace", style: "oligarch_palace", w: 42, d: 36, h: 24, portalY: -18, portalZ: 0, pw: 2.2, ph: 2.8 },
  "0x01100002": { name: "Basalt_Crypt_Manor", style: "oligarch_manor", w: 28, d: 24, h: 16, portalY: -12, portalZ: 0, pw: 1.6, ph: 2.4 },
  "0x01100003": { name: "Spire_of_the_Filinuvekta", style: "oligarch_spire", w: 18, d: 18, h: 38, portalY: -9, portalZ: 0, pw: 1.6, ph: 2.4 },
  "0x01100004": { name: "Gelidite_Mausoleum_Hall", style: "oligarch_manor", w: 32, d: 22, h: 14, portalY: -11, portalZ: 0, pw: 1.8, ph: 2.6 },
  "0x01100010": { name: "Ashatiri_Noble_Guildhall", style: "ashatiri_guild", w: 32, d: 26, h: 15, portalY: -13, portalZ: 0, pw: 1.6, ph: 2.4 },
  "0x01100011": { name: "Serf_Artisan_Longhouse", style: "ashatiri_longhouse", w: 24, d: 16, h: 11, portalY: -8, portalZ: 0, pw: 1.5, ph: 2.3 },
  "0x01100012": { name: "Stilted_Fen_Manor", style: "marsh_stilted", w: 26, d: 18, h: 13, portalY: -9, portalZ: 3, pw: 1.5, ph: 2.3 },
  "0x01100013": { name: "Iron_Quarry_Masters_Hall", style: "ashatiri_guild", w: 30, d: 24, h: 14, portalY: -12, portalZ: 0, pw: 1.8, ph: 2.5 },
  "0x01100020": { name: "Sand_King_Adobe_Citadel", style: "desert_citadel", w: 38, d: 38, h: 18, portalY: -19, portalZ: 0, pw: 2.0, ph: 2.6 },
  "0x01100021": { name: "Nomadic_Caravanserai", style: "desert_caravanserai", w: 34, d: 30, h: 12, portalY: -15, portalZ: 0, pw: 2.2, ph: 2.6 },
  "0x01100022": { name: "Mu_Miyah_Sun_Temple", style: "desert_ziggurat", w: 28, d: 24, h: 15, portalY: -12, portalZ: 0, pw: 1.8, ph: 2.6 },
  "0x01100023": { name: "Desert_Dune_Bastion", style: "desert_citadel", w: 26, d: 22, h: 16, portalY: -11, portalZ: 0, pw: 1.6, ph: 2.4 },
  "0x01100030": { name: "Imperial_Praetorium_Town_Hall", style: "civic_praetorium", w: 30, d: 26, h: 14, portalY: -13, portalZ: 0, pw: 2.2, ph: 2.6 },
  "0x01100031": { name: "Garrison_Barracks_and_Armory", style: "civic_garrison", w: 28, d: 20, h: 12, portalY: -10, portalZ: 0, pw: 1.8, ph: 2.5 },
  "0x01100032": { name: "Temple_of_the_Ice_Throne_Altar", style: "oligarch_palace", w: 32, d: 22, h: 16, portalY: -11, portalZ: 0, pw: 2.0, ph: 2.6 },
  "0x01100033": { name: "Provincial_Tavern_Frost_Flagon", style: "ashatiri_guild", w: 26, d: 22, h: 12, portalY: -11, portalZ: 0, pw: 1.6, ph: 2.4 },
  "0x01100034": { name: "Covered_Market_Pavilion", style: "civic_pavilion", w: 24, d: 20, h: 10, portalY: -10, portalZ: 0, pw: 2.2, ph: 2.6 },
  "0x01100035": { name: "Municipal_Watchtower", style: "civic_watchtower", w: 16, d: 16, h: 28, portalY: -8, portalZ: 0, pw: 1.5, ph: 2.3 },
};

// Scenery & Flora model descriptors (distinguishes building 0x0110xxxx from rock 0x0110xxxx by context)
const SCENERY_SPECS = {
  // Rung 1: Monoliths & Obelisks
  "0x01100002": { kind: "obsidian_spire", r: 2.0, h: 18.0 },
  "0x01100012": { kind: "obsidian_spire", r: 1.25, h: 10.0 },
  "0x01100015": { kind: "imperial_obelisk", r: 1.5, h: 16.0 },
  // Rung 2: Rocks & Crystals
  "0x01100001": { kind: "basalt_column", r: 1.2, h: 8.0 },
  "0x01100011": { kind: "basalt_cluster", r: 3.5, h: 14.0 },
  "0x01100003": { kind: "granite_crag", r: 2.5, h: 3.2 },
  "0x01100004": { kind: "sandstone_rib", r: 2.8, h: 6.5 },
  "0x01100014": { kind: "desert_hoodoo", r: 1.8, h: 9.0 },
  "0x01100018": { kind: "sulfur_geyser", r: 1.8, h: 2.2 },
  "0x01100019": { kind: "petrified_timber", r: 1.0, h: 1.8 },
  "0x0110001D": { kind: "ice_crystal_cluster", r: 1.4, h: 3.6 },
  // Rung 3: Boulders & Runestones
  "0x01100005": { kind: "runic_stone", r: 0.9, h: 3.5 },
  "0x01100013": { kind: "granite_boulder", r: 2.2, h: 4.4 },
  // Rung 4: Clutter, Ruin Cairns & Vents
  "0x01100006": { kind: "scree_patch", r: 1.0, h: 0.35, noCastShadow: true },
  "0x01100017": { kind: "sulfur_geyser", r: 1.5, h: 1.2 },
  "0x0110001B": { kind: "sulfur_crust", r: 1.0, h: 0.25, noCastShadow: true },
  "0x0110001C": { kind: "bone_shards", r: 1.35, h: 2.2 },
  // Rung 2: Tall Trees
  "0x02100001": { kind: "ironwood_pine", r: 3.8, h: 24.5, sway: true, soften: true },
  "0x02100002": { kind: "ash_cedar", r: 4.2, h: 17.0, sway: true, soften: true },
  "0x02100005": { kind: "desert_ironwood", r: 3.2, h: 9.5, sway: true, soften: true },
  "0x02100008": { kind: "mountain_cypress", r: 2.4, h: 16.5, sway: true, soften: true },
  "0x02100009": { kind: "maritime_pine", r: 3.4, h: 13.0, sway: true, soften: true },
  // Rung 4: Ferns
  "0x02100003": { kind: "ghost_fern", r: 1.4, h: 1.6, sway: true, soften: false },
  "0x02100004": { kind: "sulfur_fern", r: 1.7, h: 2.1, sway: true, soften: false },
  "0x02100010": { kind: "salt_fern", r: 1.1, h: 1.2, sway: true, soften: false },
  "0x02100015": { kind: "creeping_fern", r: 1.2, h: 1.4, sway: true, soften: false },
  "0x02100018": { kind: "ghost_cane", r: 1.3, h: 2.4, sway: true, soften: false },
  // Rung 4: Understory & Specialized Flora
  "0x02100006": { kind: "blood_cactus", r: 0.9, h: 4.8, sway: true, soften: false },
  "0x02100007": { kind: "bog_willow", r: 3.8, h: 10.5, sway: true, soften: true },
  "0x02100011": { kind: "frost_shrub", r: 1.1, h: 1.3, sway: true, soften: false },
  "0x02100012": { kind: "lichen_mat", r: 1.2, h: 0.35, sway: false, soften: false, noCastShadow: true },
  "0x02100013": { kind: "obsidian_thornbush", r: 1.2, h: 1.6, sway: true, soften: false },
  "0x02100014": { kind: "rift_moss", r: 1.4, h: 2.5, sway: true, soften: true },
  "0x02100016": { kind: "deadwood_snag", r: 1.8, h: 8.5, sway: false, soften: false },
  "0x02100017": { kind: "alpine_thistle", r: 0.8, h: 0.9, sway: true, soften: false },
  "0x02100019": { kind: "spore_mushroom", r: 1.2, h: 3.6, sway: false, soften: true },
  "0x0210001A": { kind: "mire_pitcher", r: 0.8, h: 1.1, sway: true, soften: false },
  "0x0210001B": { kind: "joshua_yucca", r: 1.2, h: 4.5, sway: true, soften: false },
  "0x0210001C": { kind: "red_scrub", r: 1.0, h: 0.8, sway: true, soften: false, noCastShadow: true },
  "0x0210001D": { kind: "cordgrass", r: 1.1, h: 1.6, sway: true, soften: false },
};

// Deterministic hash for procedural textures & geometry perturbation
function hash2(x, y, seed = 1) {
  let h = Math.imul(x ^ seed, 374761393) + Math.imul(y ^ (seed * 17), 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function hash32(x) {
  let h = Math.imul((x | 0) ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

// Fast 256x256 periodic value-noise table for fast 256^2 multi-octave procedural bakes
let _noiseLut = null;
function getNoiseLut() {
  if (_noiseLut) return _noiseLut;
  const lut = new Float32Array(256 * 256);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      lut[(y << 8) | x] = hash2(x, y, 1337);
    }
  }
  _noiseLut = lut;
  return lut;
}

function fbm2(u, v, scale, octaves, seed) {
  const lut = getNoiseLut();
  let val = 0.0;
  let amp = 0.5;
  let freq = Math.max(1, Math.round(scale));
  let norm = 0.0;
  for (let o = 0; o < octaves; o++) {
    const p = Math.min(256, Math.max(1, freq));
    const ox = ((seed * 37 + o * 59) & 255);
    const oy = ((seed * 73 + o * 97) & 255);
    const gx = u * p;
    const gy = v * p;
    const ix = Math.floor(gx);
    const iy = Math.floor(gy);
    const fx = gx - ix;
    const fy = gy - iy;
    const sx = fx * fx * (3.0 - 2.0 * fx);
    const sy = fy * fy * (3.0 - 2.0 * fy);
    const x0 = (((ix % p) + p) % p + ox) & 255;
    const x1 = ((((ix + 1) % p) + p) % p + ox) & 255;
    const y0 = (((iy % p) + p) % p + oy) & 255;
    const y1 = ((((iy + 1) % p) + p) % p + oy) & 255;
    const n00 = lut[(y0 << 8) | x0];
    const n10 = lut[(y0 << 8) | x1];
    const n01 = lut[(y1 << 8) | x0];
    const n11 = lut[(y1 << 8) | x1];
    const nx0 = n00 + (n10 - n00) * sx;
    const nx1 = n01 + (n11 - n01) * sx;
    val += (nx0 + (nx1 - nx0) * sy) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return val / (norm || 1.0);
}

function _smoothstep(a, b, x) {
  const t = Math.max(0.0, Math.min(1.0, (x - a) / (b - a)));
  return t * t * (3.0 - 2.0 * t);
}

function _clampByte(v) {
  return v <= 0 ? 0 : (v >= 255 ? 255 : Math.round(v));
}

function _pomFeatureEnabled() {
  try {
    if (typeof window !== "undefined" && window.location) {
      const sp = new URLSearchParams(window.location.search || "");
      const p = (sp.get("pom") || "").trim().toLowerCase();
      if (p === "off" || p === "0" || p === "false" || p === "no") return false;
      const m = (sp.get("material") || "").trim().toLowerCase();
      if (m === "off" || m === "0" || m === "false" || m === "no") return false;
    }
  } catch (_) { /* default ON */ }
  return true;
}

function _makeDataTex256(data, name, srgb = false) {
  const tex = new THREE.DataTexture(data, PROC_TEX_SIZE, PROC_TEX_SIZE, THREE.RGBAFormat);
  tex.name = name;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// Generates matched 256^2 Albedo + Sobel Normal + Roughness + Height/Shimmer DataTextures
function makeProceduralPbrSet(kind, texList, { withHeight = true, normalStrength = 2.8 } = {}) {
  const size = PROC_TEX_SIZE;
  const totalPx = size * size;
  const albedoData = new Uint8Array(totalPx * 4);
  const roughData = new Uint8Array(totalPx * 4);
  const normalData = new Uint8Array(totalPx * 4);
  const heightField = new Float32Array(totalPx);
  const shimmerField = new Float32Array(totalPx);

  const seedA = kind.length * 97 + kind.charCodeAt(0) * 13;
  const seedB = kind.charCodeAt(kind.length - 1) * 53 + 211;

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const pIdx = y * size + x;
      const n = fbm2(u, v, 8, 4, seedA);
      const detail = fbm2(u, v, 32, 3, seedB);
      const pit = Math.max(0.0, 0.36 - detail) * 2.2;

      let r = 128;
      let g = 128;
      let b = 128;
      let h = 0.85;
      let rough = 0.82;
      let shimmer = 0.0;

      if (kind === "basalt_block") {
        // Cyclopean dark volcanic ashlar blocks with bevelled mortar & frost crevices
        const row = Math.floor(v * 8.0);
        const by = v * 8.0 - row;
        const colFreq = (row % 3 === 0) ? 3.0 : 4.0;
        const bx = ((u * colFreq) + (row & 1) * 0.47 + ((row * 3) & 1) * 0.19) % 1.0;
        const blockHash = hash2(Math.floor(u * colFreq + (row & 1) * 0.47), row, 41);
        const edgeDist = Math.min(by, 1.0 - by, bx * 1.25, (1.0 - bx) * 1.25);
        const bevel = _smoothstep(0.025, 0.115, edgeDist);
        const frostInJoint = (1.0 - bevel) * _smoothstep(0.45, 0.82, n);
        h = bevel * (0.86 + (blockHash - 0.5) * 0.10 + (n - 0.5) * 0.08 - pit * 0.18) + (1.0 - bevel) * (0.08 + detail * 0.10);
        const cavity = 0.52 + 0.48 * bevel;
        const base = (36 + blockHash * 14 + n * 30 + (detail - 0.5) * 20 - pit * 16) * cavity;
        r = base * 0.90 + frostInJoint * 82;
        g = base * 0.96 + frostInJoint * 98;
        b = base * 1.10 + 6 + frostInJoint * 120;
        rough = bevel > 0.4 ? (0.76 + detail * 0.16 - blockHash * 0.06) : (0.90 - frostInJoint * 0.35);
      } else if (kind === "obsidian_facet") {
        // Frost-veined volcanic obsidian with conchoidal facets & shimmering rime veins
        const facetU = u * 5.0 + (n - 0.5) * 0.65;
        const facetV = v * 5.0 + (detail - 0.5) * 0.45;
        const ridge = Math.abs(((facetU + facetV * 0.6) % 1.0 + 1.0) % 1.0 - 0.5) * 2.0;
        const veinWave = Math.abs(Math.sin((u * 6.0 + v * 2.0 + n * 2.4) * Math.PI));
        const vein = Math.pow(veinWave, 14.0);
        const frostVein = Math.pow(Math.abs(Math.cos((v * 5.0 - u * 3.0 + n * 1.9) * Math.PI)), 18.0);
        h = Math.max(0.05, Math.min(1.0, 0.72 + ridge * 0.22 - vein * 0.38 - frostVein * 0.25 + (detail - 0.5) * 0.06));
        const base = 18 + n * 20 + ridge * 14;
        r = base + vein * 42 + frostVein * 95;
        g = base + vein * 68 + frostVein * 128;
        b = base + 12 + vein * 105 + frostVein * 155;
        rough = 0.20 + (1.0 - ridge) * 0.14 + frostVein * 0.24;
        shimmer = Math.min(1.0, vein * 0.75 + frostVein * 0.85);
      } else if (kind === "granite_ashlar") {
        // Weathered sub-arctic granite ashlar with chipped bevels & lichen crevice accents
        const row = Math.floor(v * 6.0);
        const by = v * 6.0 - row;
        const bx = ((u * 3.0) + (row & 1) * 0.5) % 1.0;
        const bHash = hash2(Math.floor(u * 3.0), row, 73);
        const edgeDist = Math.min(by, 1.0 - by, bx * 1.3, (1.0 - bx) * 1.3) - (detail - 0.5) * 0.025;
        const bevel = _smoothstep(0.03, 0.13, edgeDist);
        const lichen = (1.0 - bevel) * _smoothstep(0.52, 0.84, n);
        h = bevel * (0.85 + (bHash - 0.5) * 0.10 + (detail - 0.5) * 0.12 - pit * 0.16) + (1.0 - bevel) * 0.10;
        const cavity = 0.48 + 0.52 * bevel;
        const base = (80 + bHash * 16 + n * 44 + (detail - 0.5) * 28) * cavity;
        r = base * 0.95 - lichen * 12;
        g = base * 0.95 + lichen * 24;
        b = base * 0.92 + lichen * 8;
        rough = 0.80 + detail * 0.14;
      } else if (kind === "ironwood_bark") {
        // Ancient fissured ironwood timber & vertical adze-hewn grain
        const streak = fbm2(u * 5.0, v * 0.75, 8, 4, 701);
        const groove = Math.pow(Math.sin((u * 14.0 + streak * 2.2) * Math.PI), 2.0);
        const frost = Math.max(0.0, (1.0 - groove) * (n - 0.62)) * 1.8;
        h = 0.28 + groove * 0.64 + (detail - 0.5) * 0.10;
        const base = 36 + streak * 36 + groove * 18 + (detail - 0.5) * 16;
        r = base * 1.12 + frost * 65;
        g = base * 0.88 + frost * 74;
        b = base * 0.75 + frost * 86;
        rough = 0.86 + (1.0 - groove) * 0.10;
      } else if (kind === "slate_roof") {
        // Scalloped overlapping volcanic slate roof tiles with frost-dusted lower lips
        const row = Math.floor(v * 10.0);
        const sy = v * 10.0 - row;
        const sx = ((u * 8.0) + (row & 1) * 0.5) % 1.0;
        const tHash = hash2(Math.floor(u * 8.0), row, 109);
        const curveLip = sy - Math.sin(sx * Math.PI) * 0.08;
        const overlapStep = _smoothstep(0.04, 0.14, curveLip);
        const sideSeam = _smoothstep(0.02, 0.075, Math.min(sx, 1.0 - sx));
        const tileMask = overlapStep * sideSeam;
        const frostLip = (1.0 - _smoothstep(0.08, 0.24, sy)) * tileMask * _smoothstep(0.45, 0.8, n);
        h = tileMask * (0.58 + 0.36 * (1.0 - sy) + (tHash - 0.5) * 0.08) + (1.0 - tileMask) * 0.12;
        const edge = 0.54 + 0.46 * tileMask;
        const base = (44 + tHash * 14 + n * 28 + (detail - 0.5) * 14) * edge;
        r = base * 0.90 + frostLip * 78;
        g = base * 0.96 + frostLip * 90;
        b = base * 1.09 + frostLip * 106;
        rough = 0.66 + detail * 0.16 - frostLip * 0.18;
      } else if (kind === "adobe_wall") {
        // Weathered Mu-Miyah sandstone ashlar & wind-carved desert strata
        const row = Math.floor(v * 7.0);
        const by = v * 7.0 - row;
        const bx = ((u * 3.5) + (row & 1) * 0.5) % 1.0;
        const edgeDist = Math.min(by, 1.0 - by, bx * 1.4, (1.0 - bx) * 1.4);
        const bevel = _smoothstep(0.02, 0.09, edgeDist);
        const strata = Math.sin((v * 16.0 + n * 1.8) * Math.PI) * 0.12;
        h = bevel * (0.82 + strata * 0.5 - pit * 0.22 + (detail - 0.5) * 0.10) + (1.0 - bevel) * 0.22;
        const cavity = 0.62 + 0.38 * bevel;
        const base = (162 + (n - 0.5) * 40 + strata * 34 + (detail - 0.5) * 20) * cavity;
        r = base * 1.12;
        g = base * 0.87;
        b = base * 0.61;
        rough = 0.86 + detail * 0.10;
      } else if (kind === "limestone_wall") {
        // Dressed ivory-slate imperial limestone ashlar with fine mortar bevels
        const row = Math.floor(v * 8.0);
        const by = v * 8.0 - row;
        const bx = ((u * 4.0) + (row & 1) * 0.5) % 1.0;
        const bHash = hash2(Math.floor(u * 4.0), row, 151);
        const edgeDist = Math.min(by, 1.0 - by, bx * 1.3, (1.0 - bx) * 1.3);
        const bevel = _smoothstep(0.02, 0.085, edgeDist);
        h = bevel * (0.88 + (bHash - 0.5) * 0.06 - pit * 0.12 + (detail - 0.5) * 0.06) + (1.0 - bevel) * 0.16;
        const cavity = 0.60 + 0.40 * bevel;
        const base = (146 + bHash * 14 + (n - 0.5) * 34 + (detail - 0.5) * 16) * cavity;
        r = base * 1.01;
        g = base * 0.99;
        b = base * 0.94;
        rough = 0.78 + detail * 0.12;
      } else if (kind === "rune_monolith") {
        // Rune-carved Dericost monolith stone with glowing Gelidite geometric glyphs
        const panelX = Math.min(u, 1.0 - u);
        const border = _smoothstep(0.05, 0.11, panelX);
        const cellY = (v * 6.0) % 1.0;
        const cx = Math.abs(u - 0.5);
        const cy = Math.abs(cellY - 0.5);
        const diamond = Math.abs(cx * 1.5 + cy - 0.34);
        const spine = Math.abs(u - 0.5);
        const crossBar = Math.abs(cellY - 0.5);
        const glyphDist = Math.min(
          diamond,
          (cy < 0.36 ? spine : 1.0),
          (cx < 0.24 ? crossBar : 1.0)
        );
        const carved = (1.0 - _smoothstep(0.018, 0.052, glyphDist)) * border;
        h = Math.max(0.04, 0.88 * border + 0.42 * (1.0 - border) - carved * 0.72 - pit * 0.10 + (detail - 0.5) * 0.06);
        const stone = 30 + n * 26 + (detail - 0.5) * 14;
        r = stone * (1.0 - carved * 0.5) + carved * 64;
        g = stone * (1.0 - carved * 0.5) + carved * 188;
        b = (stone + 8) * (1.0 - carved * 0.5) + carved * 238;
        rough = carved > 0.3 ? 0.32 : (0.58 + detail * 0.18);
        shimmer = carved;
      } else if (kind === "icy_cobble_plaza") {
        // Interlocking plaza cobblestones with specular blue-white rime ice packed in joints
        const row = Math.floor(v * 10.0);
        const cy = v * 10.0 - row;
        const cx = ((u * 10.0) + (row & 1) * 0.5) % 1.0;
        const cHash = hash2(Math.floor(u * 10.0), row, 313);
        const jitterX = (cHash - 0.5) * 0.14;
        const distCenter = Math.hypot((cx - 0.5 + jitterX) * 1.08, (cy - 0.5) * 1.08);
        const cobble = 1.0 - _smoothstep(0.32, 0.48, distCenter);
        h = cobble * (0.55 + 0.38 * (1.0 - distCenter * 1.4) + (cHash - 0.5) * 0.08 - pit * 0.10) + (1.0 - cobble) * 0.22;
        const stone = 56 + cHash * 26 + n * 28 + (detail - 0.5) * 16;
        const iceJoint = 1.0 - cobble;
        r = stone * cobble + iceJoint * (128 + n * 35);
        g = stone * 1.02 * cobble + iceJoint * (162 + n * 38);
        b = (stone * 1.08 + 5) * cobble + iceJoint * (198 + n * 42);
        rough = cobble > 0.45 ? (0.64 + detail * 0.18) : 0.22;
        shimmer = iceJoint * 0.35;
      } else if (kind === "glacial_ice") {
        // Faceted sub-arctic blue-white glacial crystal
        const frac1 = Math.abs(Math.sin((u * 5.0 + v * 3.0 + n * 2.1) * Math.PI));
        const frac2 = Math.abs(Math.cos((u * 3.0 - v * 6.0 + detail * 1.4) * Math.PI));
        const crack = Math.pow(Math.min(frac1, frac2), 6.0);
        h = 0.68 + frac1 * 0.22 - crack * 0.35;
        r = 135 + n * 52 + crack * 55;
        g = 192 + n * 44 + crack * 48;
        b = 228 + n * 25 + crack * 26;
        rough = 0.18 + (1.0 - frac1) * 0.18;
        shimmer = 0.45 + crack * 0.55;
      } else if (kind === "weathered_bone_ruin") {
        // Bleached ossuary bone & frost-stone cairn blocks
        const row = Math.floor(v * 7.0);
        const by = v * 7.0 - row;
        const bx = ((u * 5.0) + (row & 1) * 0.45) % 1.0;
        const edge = _smoothstep(0.04, 0.15, Math.min(by, 1.0 - by, bx, 1.0 - bx));
        h = edge * (0.82 - pit * 0.24 + (n - 0.5) * 0.12) + (1.0 - edge) * 0.08;
        const base = (132 + n * 48 + (detail - 0.5) * 24) * (0.42 + 0.58 * edge);
        r = base * 1.04;
        g = base * 0.99;
        b = base * 0.90;
        rough = 0.84 + detail * 0.12;
      } else if (kind === "runic_door") {
        // Heavy iron-bound portal door with carved planks, rivets & glowing Gelidite rune ring
        const plankSeam = _smoothstep(0.03, 0.11, Math.abs(Math.sin(u * 6.0 * Math.PI)));
        const band = (Math.abs(v - 0.22) < 0.048 || Math.abs(v - 0.78) < 0.048 || u < 0.075 || u > 0.925);
        const rad = Math.hypot(u - 0.5, (v - 0.5) * 1.38);
        const runeRing = (rad > 0.135 && rad < 0.205) || (rad < 0.19 && Math.abs(u - 0.5) < 0.018);
        if (runeRing) {
          h = 0.18;
          r = 82; g = 195; b = 242;
          rough = 0.28;
          shimmer = 1.0;
        } else if (band) {
          h = 0.94 + (detail - 0.5) * 0.05;
          const m = 42 + detail * 28;
          r = m; g = m + 5; b = m + 12;
          rough = 0.44 + detail * 0.14;
        } else {
          h = 0.30 + plankSeam * 0.52 + (detail - 0.5) * 0.08;
          const w = (54 + n * 32) * (0.50 + 0.50 * plankSeam);
          r = w * 1.15; g = w * 0.85; b = w * 0.65;
          rough = 0.82 + (1.0 - plankSeam) * 0.10;
        }
      } else if (kind === "frost_needles") {
        const needle = Math.abs(Math.sin((u * 18.0 + (v - 0.5) * 6.0 + n * 2.0) * Math.PI));
        const frost = Math.max(0.0, (detail + n * 0.5) - 0.74) * 3.0;
        h = 0.35 + needle * 0.55;
        r = Math.min(245, 32 + n * 34 + needle * 14 + frost * 168);
        g = Math.min(250, 66 + n * 46 + needle * 20 + frost * 165);
        b = Math.min(255, 74 + n * 52 + needle * 22 + frost * 176);
        rough = 0.74 - frost * 0.20;
      } else if (kind === "cedar_foliage") {
        const frond = Math.abs(Math.sin((u * 14.0 + n * 2.5) * Math.PI));
        h = 0.38 + frond * 0.52;
        r = 22 + n * 24 + detail * 12;
        g = 44 + n * 38 + detail * 16;
        b = 32 + n * 24 + detail * 12;
        rough = 0.84;
      } else if (kind === "willow_foliage") {
        const strand = Math.abs(Math.sin((u * 16.0 + n * 1.8) * Math.PI));
        h = 0.36 + strand * 0.54;
        r = 32 + n * 30 + detail * 14;
        g = 54 + n * 38 + detail * 18;
        b = 34 + n * 24 + detail * 12;
        rough = 0.84;
      } else if (kind === "ghost_fern") {
        const vein = Math.exp(-Math.pow((u - 0.5) * 6.0, 2.0));
        const pinna = Math.abs(Math.sin(v * 20.0 * Math.PI));
        h = 0.35 + vein * 0.45 + pinna * 0.20;
        r = 118 + n * 62 + vein * 46;
        g = 156 + n * 64 + vein * 48;
        b = 172 + n * 66 + vein * 50;
        rough = 0.62;
      } else if (kind === "sulfur_fern") {
        const vein = Math.exp(-Math.pow((u - 0.5) * 6.0, 2.0));
        const pinna = Math.abs(Math.sin(v * 18.0 * Math.PI));
        h = 0.35 + vein * 0.45 + pinna * 0.20;
        r = 58 + n * 42 + vein * 26;
        g = 82 + n * 48 + vein * 30;
        b = 46 + n * 30 + vein * 18;
        rough = 0.78;
      } else if (kind === "desert_flora") {
        const rib = Math.abs(Math.sin(u * 12.0 * Math.PI));
        const thorn = detail > 0.83 ? 72 : 0;
        h = 0.35 + rib * 0.55;
        r = 70 + n * 48 + thorn;
        g = 92 + n * 46 - thorn * 0.3;
        b = 46 + n * 28 - thorn * 0.3;
        rough = 0.84;
      }

      heightField[pIdx] = Math.max(0.0, Math.min(1.0, h));
      shimmerField[pIdx] = Math.max(0.0, Math.min(1.0, shimmer));

      const i4 = pIdx * 4;
      albedoData[i4] = _clampByte(r);
      albedoData[i4 + 1] = _clampByte(g);
      albedoData[i4 + 2] = _clampByte(b);
      albedoData[i4 + 3] = 255;

      const rb = _clampByte(rough * 255.0);
      roughData[i4] = rb;
      roughData[i4 + 1] = rb;
      roughData[i4 + 2] = rb;
      roughData[i4 + 3] = 255;
    }
  }

  // Periodic 3x3 Sobel filter over 256^2 heightField -> tangent-space normalMap
  const mask = size - 1;
  for (let y = 0; y < size; y++) {
    const ym = (y - 1) & mask;
    const yp = (y + 1) & mask;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1) & mask;
      const xp = (x + 1) & mask;
      const tl = heightField[ym * size + xm];
      const tc = heightField[ym * size + x];
      const tr = heightField[ym * size + xp];
      const ml = heightField[y * size + xm];
      const mr = heightField[y * size + xp];
      const bl = heightField[yp * size + xm];
      const bc = heightField[yp * size + x];
      const br = heightField[yp * size + xp];

      const dX = ((tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl)) * normalStrength;
      const dY = ((bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr)) * normalStrength;
      let nx = -dX;
      let ny = -dY;
      let nz = 1.0;
      const invLen = 1.0 / (Math.hypot(nx, ny, nz) || 1.0);
      nx *= invLen;
      ny *= invLen;
      nz *= invLen;

      const i4 = (y * size + x) * 4;
      normalData[i4] = _clampByte((nx * 0.5 + 0.5) * 255.0);
      normalData[i4 + 1] = _clampByte((ny * 0.5 + 0.5) * 255.0);
      normalData[i4 + 2] = _clampByte((nz * 0.5 + 0.5) * 255.0);
      normalData[i4 + 3] = 255;
    }
  }

  const map = _makeDataTex256(albedoData, `dericost-${kind}-albedo`, true);
  const normalMap = _makeDataTex256(normalData, `dericost-${kind}-normal`, false);
  const roughnessMap = _makeDataTex256(roughData, `dericost-${kind}-rough`, false);
  texList.push(map, normalMap, roughnessMap);

  let heightMap = null;
  if (withHeight) {
    const heightData = new Uint8Array(totalPx * 4);
    for (let i = 0; i < totalPx; i++) {
      const i4 = i * 4;
      heightData[i4] = _clampByte(heightField[i] * 255.0);
      heightData[i4 + 1] = _clampByte(shimmerField[i] * 255.0);
      heightData[i4 + 2] = 0;
      heightData[i4 + 3] = 255;
    }
    heightMap = _makeDataTex256(heightData, `dericost-${kind}-height`, false);
    texList.push(heightMap);
  }

  return { map, normalMap, roughnessMap, heightMap };
}

function _ensureFragUniform(fragmentShader, decl) {
  return fragmentShader.indexOf(decl) === -1
    ? fragmentShader.replace("#include <common>", `#include <common>\n${decl}`)
    : fragmentShader;
}

// Injects Instanced textureGrad POM (4-6 steps + 2-tap sun crevice self-shadow, fading 8m -> 22m)
// and optional VFX_GLOBALS.uTime mystical rune/frost/brazier shimmer into MeshStandardMaterial.
function applyDericostSurfaceShader(mat, pbrSet, opts = {}) {
  const pomOn = !!pbrSet?.heightMap && opts.pom !== false && _pomFeatureEnabled();
  const pomDepth = opts.pomDepth ?? 0.058;
  const pomSteps = opts.pomSteps ?? 6;
  const pomLodNear = opts.pomLodNear ?? 8.0;
  const pomLodFar = opts.pomLodFar ?? 22.0;
  const pomShadowSteps = opts.pomShadowSteps ?? 2;
  const pomShadowDarkness = opts.pomShadowDarkness ?? 0.52;
  const shimmerStrength = opts.shimmerStrength ?? 0.0;
  const shimmerColor = new THREE.Color(opts.shimmerColor ?? 0x38bdf8);
  const swayOn = !!opts.sway;

  mat.userData = {
    ...(mat.userData || {}),
    pomEnabled: pomOn,
    pomGrad: pomOn,
    hasWindSway: swayOn,
    pomUniforms: pomOn ? {
      steps: pomSteps,
      depth: pomDepth,
      lodNear: pomLodNear,
      lodFar: pomLodFar,
      shadowSteps: pomShadowSteps,
      shadowDarkness: pomShadowDarkness,
    } : null,
  };

  if (!pomOn && !swayOn && shimmerStrength <= 0.0) return mat;

  mat.onBeforeCompile = (shader) => {
    if (swayOn) {
      windSwayGpu.declareUniforms(shader, opts.swayCfg || null, VFX_GLOBALS);
      windSwayGpu.inject(shader);
    }

    if (pomOn || shimmerStrength > 0.0) {
      shader.uniforms.uTime = VFX_GLOBALS.uTime;
    }

    if (shimmerStrength > 0.0) {
      shader.uniforms.uDericostShimmerStrength = { value: shimmerStrength };
      shader.uniforms.uDericostShimmerColor = { value: shimmerColor };
      shader.fragmentShader = _ensureFragUniform(shader.fragmentShader, "uniform float uTime;");
      shader.fragmentShader = _ensureFragUniform(shader.fragmentShader, "uniform float uDericostShimmerStrength;");
      shader.fragmentShader = _ensureFragUniform(shader.fragmentShader, "uniform vec3 uDericostShimmerColor;");
    }

    if (pomOn) {
      shader.uniforms.uPomMap = { value: pbrSet.heightMap };
      shader.uniforms.uPomSteps = { value: pomSteps };
      shader.uniforms.uPomDepth = { value: pomDepth };
      shader.uniforms.uPomLodNear = { value: pomLodNear };
      shader.uniforms.uPomLodFar = { value: pomLodFar };
      shader.uniforms.uPomShadowSteps = { value: pomShadowSteps };
      shader.uniforms.uPomShadowDarkness = { value: pomShadowDarkness };

      shader.fragmentShader = _ensureFragUniform(shader.fragmentShader, "uniform float uTime;");
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <common>",
        `#include <common>
uniform sampler2D uPomMap;
uniform int uPomSteps;
uniform float uPomDepth;
uniform float uPomLodNear;
uniform float uPomLodFar;
uniform int uPomShadowSteps;
uniform float uPomShadowDarkness;
mat3 _pomTbnG;
float _pomLodG = 0.0;
float _pomHitDepthG = 0.0;
float _pomShimmerMaskG = 0.0;
vec2 _pomUvG = vec2(0.0);
vec2 _pomGx = vec2(0.0);
vec2 _pomGy = vec2(0.0);

vec2 _dericostPomMarch(vec2 baseUv, vec3 vTanDir, float depthScale, int steps) {
  float pz = max(abs(vTanDir.z), 0.16);
  vec2 uvStep = (vTanDir.xy / pz) * (depthScale / float(steps));
  float maxStep = (0.065 * depthScale) / float(steps);
  uvStep = clamp(uvStep, vec2(-maxStep), vec2(maxStep));
  float layerStep = 1.0 / float(steps);
  vec2 curUv = baseUv;
  float curLayer = 0.0;
  float curDepth = 1.0 - textureGrad(uPomMap, curUv, _pomGx, _pomGy).r;
  for (int i = 0; i < 8; i++) {
    if (i >= steps) break;
    if (curLayer >= curDepth) break;
    curUv -= uvStep;
    curLayer += layerStep;
    curDepth = 1.0 - textureGrad(uPomMap, curUv, _pomGx, _pomGy).r;
  }
  vec2 prevUv = curUv + uvStep;
  float afterD = curDepth - curLayer;
  float beforeD = (1.0 - textureGrad(uPomMap, prevUv, _pomGx, _pomGy).r) - (curLayer - layerStep);
  float den = afterD - beforeD;
  float w = den < -1e-6 ? clamp(afterD / den, 0.0, 1.0) : 0.0;
  return mix(curUv, prevUv, w);
}

float _dericostPomSelfShadow(vec2 hitUv, float hitDepth, vec3 lTan, float depthScale, int sSteps) {
  if (lTan.z <= 0.02 || hitDepth <= 0.015) return 1.0;
  vec2 uvStep = (lTan.xy / max(abs(lTan.z), 0.14)) * (depthScale / float(sSteps));
  float layerStep = hitDepth / float(sSteps);
  vec2 curUv = hitUv + uvStep;
  float curDepth = hitDepth - layerStep;
  float occ = 1.0;
  for (int i = 0; i < 4; i++) {
    if (i >= sSteps) break;
    if (curDepth <= 0.0) break;
    float h = 1.0 - textureGrad(uPomMap, curUv, _pomGx, _pomGy).r;
    if (h < curDepth) {
      occ = min(occ, uPomShadowDarkness);
    }
    curUv += uvStep;
    curDepth -= layerStep;
  }
  return occ;
}`
      );

      // Primary 4-6 step textureGrad POM raymarch + map sample (uses instanceMatrix-transformed vViewPosition & vNormal)
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <map_fragment>",
        `vec2 _pomBaseUv = vMapUv;
vec2 _pomUv = _pomBaseUv;
_pomGx = dFdx(vMapUv);
_pomGy = dFdy(vMapUv);
float _pomFace = gl_FrontFacing ? 1.0 : -1.0;
#ifdef FLAT_SHADED
vec3 _pomGeomN = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
#else
vec3 _pomGeomN = normalize(vNormal);
#ifdef DOUBLE_SIDED
_pomGeomN *= _pomFace;
#endif
#endif
_pomTbnG = getTangentFrame(-vViewPosition, _pomGeomN, vMapUv);
#if defined( DOUBLE_SIDED ) && ! defined( FLAT_SHADED )
_pomTbnG[0] *= _pomFace;
_pomTbnG[1] *= _pomFace;
#endif
float _pomDist = length(vViewPosition);
float _pomLod = 1.0 - smoothstep(uPomLodNear, uPomLodFar, _pomDist);
if (_pomLod > 0.001) {
  vec3 _pomTanDir = normalize(transpose(_pomTbnG) * normalize(vViewPosition));
  float _pomGrazeW = smoothstep(0.14, 0.42, abs(_pomTanDir.z));
  if (_pomGrazeW > 0.001) {
    float _pomAmt = _pomLod * _pomGrazeW;
    int _pomEffSteps = (_pomDist > mix(uPomLodNear, uPomLodFar, 0.38)) ? max(4, uPomSteps - 2) : uPomSteps;
    vec2 _marchedUv = _dericostPomMarch(_pomBaseUv, _pomTanDir, uPomDepth, _pomEffSteps);
    _pomUv = mix(_pomBaseUv, _marchedUv, _pomAmt);
    _pomLodG = _pomAmt;
  }
}
_pomUvG = _pomUv;
vec4 _pomSample = textureGrad(uPomMap, _pomUvG, _pomGx, _pomGy);
_pomHitDepthG = 1.0 - _pomSample.r;
_pomShimmerMaskG = _pomSample.g;
#ifdef USE_MAP
vec4 sampledDiffuseColor = textureGrad(map, _pomUvG, _pomGx, _pomGy);
diffuseColor *= sampledDiffuseColor;
#endif`
      );

      // Align roughnessMap & normalMap to the POM-displaced UV via textureGrad
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <roughnessmap_fragment>",
        `float roughnessFactor = roughness;
#ifdef USE_ROUGHNESSMAP
  vec4 texelRoughness = textureGrad(roughnessMap, _pomUvG, _pomGx, _pomGy);
  roughnessFactor *= texelRoughness.g;
#endif`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <normal_fragment_maps>",
        `#ifdef USE_NORMALMAP_TANGENTSPACE
  vec3 mapN = textureGrad(normalMap, _pomUvG, _pomGx, _pomGy).xyz * 2.0 - 1.0;
  mapN.xy *= normalScale;
  normal = normalize(tbn * mapN);
#else
  #include <normal_fragment_maps>
#endif`
      );

      // 2-tap sun crevice self-shadow + subtle micro-cavity AO before outgoingLight & fog
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <lights_fragment_end>",
        `#include <lights_fragment_end>
if (_pomLodG > 0.001) {
  float _cavityAo = 1.0 - (_pomHitDepthG * 0.24 * _pomLodG);
  reflectedLight.indirectDiffuse *= _cavityAo;
  #if NUM_DIR_LIGHTS > 0
  vec3 _pomLightTan = normalize(transpose(_pomTbnG) * directionalLights[0].direction);
  float _pomSh = _dericostPomSelfShadow(_pomUvG, _pomHitDepthG, _pomLightTan, uPomDepth, uPomShadowSteps);
  float _shMix = mix(1.0, _pomSh, _pomLodG);
  reflectedLight.directDiffuse *= _shMix;
  reflectedLight.directSpecular *= _shMix;
  #endif
}`
      );
    }

    // Exposure-calibrated mystical rune/frost/brazier shimmer driven by shared VFX_GLOBALS.uTime
    if (shimmerStrength > 0.0) {
      const maskExpr = pomOn ? "_pomShimmerMaskG" : "1.0";
      const uvExpr = pomOn ? "_pomUvG" : "vec2(0.5, 0.5)";
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
{
  vec2 _shUv = ${uvExpr};
  float _wave = 0.58 + 0.42 * sin(uTime * 1.85 + _shUv.y * 6.2831853 + _shUv.x * 3.1415926);
  float _spark = 0.85 + 0.15 * sin(uTime * 4.3 - _shUv.x * 9.42477);
  totalEmissiveRadiance += uDericostShimmerColor * (uDericostShimmerStrength * ${maskExpr} * _wave * _spark);
}`
      );
    }

    mat.userData.pomShaderUniforms = shader.uniforms;
  };

  const cacheTag = `dericost-v2-${opts.key || "std"}-pom${pomOn ? 1 : 0}-sway${swayOn ? 1 : 0}-sh${shimmerStrength > 0 ? 1 : 0}`;
  mat.customProgramCacheKey = () => cacheTag;
  return mat;
}

// Geometry builder helper (accumulates triangles in AC Z-up coordinates)
class MeshBuilder {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.uv = [];
  }

  addTri(ax, ay, az, bx, by, bz, cx, cy, cz, u0 = 0, v0 = 0, u1 = 1, v1 = 0, u2 = 0.5, v2 = 1) {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    this.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    this.nor.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    this.uv.push(u0, v0, u1, v1, u2, v2);
  }

  addQuad(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, uScale = 1, vScale = 1) {
    this.addTri(ax, ay, az, bx, by, bz, cx, cy, cz, 0, 0, uScale, 0, uScale, vScale);
    this.addTri(ax, ay, az, cx, cy, cz, dx, dy, dz, 0, 0, uScale, vScale, 0, vScale);
  }

  // Axis-aligned box [x0..x1, y0..y1, z0..z1] in AC Z-up
  addBox(x0, y0, z0, x1, y1, z1, texScale = 0.25, skipBottom = true) {
    const dx = Math.max(0.2, (x1 - x0) * texScale);
    const dy = Math.max(0.2, (y1 - y0) * texScale);
    const dz = Math.max(0.2, (z1 - z0) * texScale);
    // South (-Y)
    this.addQuad(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1, dx, dz);
    // North (+Y)
    this.addQuad(x1, y1, z0, x0, y1, z0, x0, y1, z1, x1, y1, z1, dx, dz);
    // West (-X)
    this.addQuad(x0, y1, z0, x0, y0, z0, x0, y0, z1, x0, y1, z1, dy, dz);
    // East (+X)
    this.addQuad(x1, y0, z0, x1, y1, z0, x1, y1, z1, x1, y0, z1, dy, dz);
    // Top (+Z)
    this.addQuad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, dx, dy);
    if (!skipBottom) {
      this.addQuad(x0, y1, z0, x1, y1, z0, x1, y0, z0, x0, y0, z0, dx, dy);
    }
  }

  // Tapered cylinder / prism along Z from z0 (radius r0) to z1 (radius r1)
  addTaperedCylinder(cx, cy, z0, z1, r0, r1, segs = 7, capTop = true, twist = 0, jitter = 0, seed = 1) {
    const h = z1 - z0;
    const vScale = Math.max(0.5, h * 0.25);
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2;
      const a1 = ((i + 1) / segs) * Math.PI * 2;
      const j0 = 1 + (hash2(i, 0, seed) - 0.5) * jitter;
      const j1 = 1 + (hash2((i + 1) % segs, 0, seed) - 0.5) * jitter;
      const jt0 = 1 + (hash2(i, 1, seed) - 0.5) * jitter;
      const jt1 = 1 + (hash2((i + 1) % segs, 1, seed) - 0.5) * jitter;

      const x00 = cx + Math.cos(a0) * r0 * j0;
      const y00 = cy + Math.sin(a0) * r0 * j0;
      const x10 = cx + Math.cos(a1) * r0 * j1;
      const y10 = cy + Math.sin(a1) * r0 * j1;

      const x01 = cx + Math.cos(a0 + twist) * r1 * jt0;
      const y01 = cy + Math.sin(a0 + twist) * r1 * jt0;
      const x11 = cx + Math.cos(a1 + twist) * r1 * jt1;
      const y11 = cy + Math.sin(a1 + twist) * r1 * jt1;

      if (r1 > 0.02) {
        this.addQuad(x00, y00, z0, x10, y10, z0, x11, y11, z1, x01, y01, z1, 1, vScale);
        if (capTop) {
          this.addTri(cx, cy, z1 + r1 * 0.15, x01, y01, z1, x11, y11, z1, 0.5, 0.5, 0, 0, 1, 0);
        }
      } else {
        this.addTri(x00, y00, z0, x10, y10, z0, cx, cy, z1, 0, 0, 1, 0, 0.5, vScale);
      }
    }
  }

  // Slanted limb / prism from (x0,y0,z0) to (x1,y1,z1) for gnarled deadwood snags & crystal clusters
  addSlantedLimb(x0, y0, z0, x1, y1, z1, r0, r1, segs = 5) {
    const h = Math.hypot(x1 - x0, y1 - y0, z1 - z0) || 1;
    const vScale = Math.max(0.4, h * 0.28);
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2;
      const a1 = ((i + 1) / segs) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0);
      const c1 = Math.cos(a1), s1 = Math.sin(a1);
      if (r1 > 0.02) {
        this.addQuad(
          x0 + c0 * r0, y0 + s0 * r0, z0,
          x0 + c1 * r0, y0 + s1 * r0, z0,
          x1 + c1 * r1, y1 + s1 * r1, z1,
          x1 + c0 * r1, y1 + s0 * r1, z1,
          1, vScale
        );
      } else {
        this.addTri(
          x0 + c0 * r0, y0 + s0 * r0, z0,
          x0 + c1 * r0, y0 + s1 * r0, z0,
          x1, y1, z1,
          0, 0, 1, 0, 0.5, vScale
        );
      }
    }
  }

  // Pitched gable roof along X or Y
  addGableRoof(x0, y0, x1, y1, zBase, zPeak, overhang = 0.8) {
    const rx0 = x0 - overhang, rx1 = x1 + overhang;
    const ry0 = y0 - overhang, ry1 = y1 + overhang;
    const ym = (y0 + y1) * 0.5;
    const uScale = Math.max(1, (rx1 - rx0) * 0.25);
    const vScale = Math.max(1, Math.hypot(ym - ry0, zPeak - zBase) * 0.25);
    // South slope
    this.addQuad(rx0, ry0, zBase, rx1, ry0, zBase, rx1, ym, zPeak, rx0, ym, zPeak, uScale, vScale);
    // North slope
    this.addQuad(rx1, ry1, zBase, rx0, ry1, zBase, rx0, ym, zPeak, rx1, ym, zPeak, uScale, vScale);
    // West & East gable triangles
    this.addTri(x0, y1, zBase, x0, y0, zBase, x0, ym, zPeak, 0, 0, 1, 0, 0.5, 1);
    this.addTri(x1, y0, zBase, x1, y1, zBase, x1, ym, zPeak, 0, 0, 1, 0, 0.5, 1);
  }

  // Arching fern frond from origin (0,0,z0) along azimuth `az`
  addFernFrond(az, length, width, archHeight, dropTip, segs = 4) {
    const ca = Math.cos(az), sa = Math.sin(az);
    const nx = -sa, ny = ca;
    for (let s = 0; s < segs; s++) {
      const t0 = s / segs;
      const t1 = (s + 1) / segs;
      const r0 = t0 * length;
      const r1 = t1 * length;
      const z0 = 0.1 + Math.sin(t0 * Math.PI * 0.82) * archHeight - t0 * t0 * dropTip;
      const z1 = 0.1 + Math.sin(t1 * Math.PI * 0.82) * archHeight - t1 * t1 * dropTip;
      const w0 = width * Math.sin(Math.max(0.12, t0) * Math.PI * 0.92);
      const w1 = width * Math.sin(Math.max(0.05, t1) * Math.PI * 0.92);

      const x0L = ca * r0 - nx * w0 * 0.5, y0L = sa * r0 - ny * w0 * 0.5;
      const x0R = ca * r0 + nx * w0 * 0.5, y0R = sa * r0 + ny * w0 * 0.5;
      const x1L = ca * r1 - nx * w1 * 0.5, y1L = sa * r1 - ny * w1 * 0.5;
      const x1R = ca * r1 + nx * w1 * 0.5, y1R = sa * r1 + ny * w1 * 0.5;

      this.addQuad(x0L, y0L, z0, x0R, y0R, z0, x1R, y1R, z1, x1L, y1L, z1, 1, 1);
    }
  }

  toGeometry({ soften = false } = {}) {
    const posArr = new Float32Array(this.pos);
    const norArr = new Float32Array(this.nor);
    const uvArr = new Float32Array(this.uv);
    if (soften) {
      softenCanopyNormals(posArr, norArr, canopySoftenStrength());
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(norArr, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uvArr, 2));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

// Build 256^2 PBR + Instanced POM material library with GPU TreeSway & sway-matched shadow depth materials
function createMaterials(st) {
  const texList = st.textures || (st.textures = []);
  const depthMats = st.depthMats || (st.depthMats = new Map());

  const pbr = {
    basalt: makeProceduralPbrSet("basalt_block", texList, { withHeight: true, normalStrength: 3.4 }),
    obsidian: makeProceduralPbrSet("obsidian_facet", texList, { withHeight: true, normalStrength: 2.8 }),
    granite: makeProceduralPbrSet("granite_ashlar", texList, { withHeight: true, normalStrength: 3.2 }),
    bark: makeProceduralPbrSet("ironwood_bark", texList, { withHeight: true, normalStrength: 2.9 }),
    slate: makeProceduralPbrSet("slate_roof", texList, { withHeight: true, normalStrength: 3.1 }),
    adobe: makeProceduralPbrSet("adobe_wall", texList, { withHeight: true, normalStrength: 2.7 }),
    limestone: makeProceduralPbrSet("limestone_wall", texList, { withHeight: true, normalStrength: 3.0 }),
    runicMonolith: makeProceduralPbrSet("rune_monolith", texList, { withHeight: true, normalStrength: 3.5 }),
    icyCobble: makeProceduralPbrSet("icy_cobble_plaza", texList, { withHeight: true, normalStrength: 3.2 }),
    iceCrystal: makeProceduralPbrSet("glacial_ice", texList, { withHeight: true, normalStrength: 2.4 }),
    boneCairn: makeProceduralPbrSet("weathered_bone_ruin", texList, { withHeight: true, normalStrength: 3.1 }),
    runicDoor: makeProceduralPbrSet("runic_door", texList, { withHeight: true, normalStrength: 3.2 }),
    frostNeedles: makeProceduralPbrSet("frost_needles", texList, { withHeight: false, normalStrength: 2.0 }),
    cedarFoliage: makeProceduralPbrSet("cedar_foliage", texList, { withHeight: false, normalStrength: 2.0 }),
    willowFoliage: makeProceduralPbrSet("willow_foliage", texList, { withHeight: false, normalStrength: 2.0 }),
    ghostFern: makeProceduralPbrSet("ghost_fern", texList, { withHeight: false, normalStrength: 1.8 }),
    sulfurFern: makeProceduralPbrSet("sulfur_fern", texList, { withHeight: false, normalStrength: 1.8 }),
    desertFlora: makeProceduralPbrSet("desert_flora", texList, { withHeight: false, normalStrength: 2.1 }),
  };

  function makePbrMat(set, opts = {}) {
    const mat = new THREE.MeshStandardMaterial({
      map: set.map,
      normalMap: set.normalMap,
      normalScale: new THREE.Vector2(opts.normalScale ?? 1.0, opts.normalScale ?? 1.0),
      roughnessMap: set.roughnessMap,
      roughness: opts.roughness ?? 0.92,
      metalness: opts.metalness ?? 0.05,
      side: opts.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
      emissive: opts.emissive ? new THREE.Color(opts.emissive) : new THREE.Color(0x000000),
      emissiveIntensity: opts.emissiveIntensity ?? 0.0,
    });
    applyDericostSurfaceShader(mat, set, opts);
    if (opts.sway) {
      const dKey = opts.doubleSided ? "sway-double" : "sway-front";
      let dMat = depthMats.get(dKey);
      if (!dMat) {
        dMat = new THREE.MeshDepthMaterial({
          side: opts.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
        });
        dMat.name = `dericost-${dKey}-depth`;
        dMat.onBeforeCompile = (shader) => {
          windSwayGpu.declareUniforms(shader, null, VFX_GLOBALS);
          windSwayGpu.inject(shader);
        };
        dMat.customProgramCacheKey = () => `dericost-depth-${dKey}`;
        depthMats.set(dKey, dMat);
      }
      mat.userData.customDepthMaterial = dMat;
    }
    return mat;
  }

  // Exposure-calibrated mystical brazier / lantern materials bound to shared VFX_GLOBALS.uTime
  const soulfire = new THREE.MeshStandardMaterial({
    color: 0x4fd8ff,
    emissive: 0x1688c8,
    emissiveIntensity: 0.48,
    roughness: 0.25,
    metalness: 0.05,
  });
  applyDericostSurfaceShader(soulfire, null, {
    key: "soulfire",
    pom: false,
    shimmerStrength: 0.14,
    shimmerColor: 0x38bdf8,
  });

  const hearthfire = new THREE.MeshStandardMaterial({
    color: 0xffa63b,
    emissive: 0xc84e0e,
    emissiveIntensity: 0.44,
    roughness: 0.30,
    metalness: 0.05,
  });
  applyDericostSurfaceShader(hearthfire, null, {
    key: "hearthfire",
    pom: false,
    shimmerStrength: 0.13,
    shimmerColor: 0xfb923c,
  });

  return {
    basalt: makePbrMat(pbr.basalt, { key: "basalt", roughness: 0.95, metalness: 0.12, pomDepth: 0.062 }),
    obsidian: makePbrMat(pbr.obsidian, {
      key: "obsidian",
      roughness: 0.85,
      metalness: 0.32,
      pomDepth: 0.044,
      shimmerStrength: 0.05,
      shimmerColor: 0x67e8f9,
    }),
    granite: makePbrMat(pbr.granite, { key: "granite", roughness: 0.96, metalness: 0.05, pomDepth: 0.060 }),
    bark: makePbrMat(pbr.bark, { key: "bark", roughness: 0.98, metalness: 0.02, pomDepth: 0.052 }),
    barkSway: makePbrMat(pbr.bark, { key: "bark-sway", roughness: 0.98, metalness: 0.02, pom: false, sway: true }),
    slate: makePbrMat(pbr.slate, { key: "slate", roughness: 0.92, metalness: 0.10, pomDepth: 0.054 }),
    adobe: makePbrMat(pbr.adobe, { key: "adobe", roughness: 0.96, metalness: 0.02, pomDepth: 0.056 }),
    limestone: makePbrMat(pbr.limestone, { key: "limestone", roughness: 0.94, metalness: 0.05, pomDepth: 0.055 }),
    runicMonolith: makePbrMat(pbr.runicMonolith, {
      key: "monolith",
      roughness: 0.90,
      metalness: 0.18,
      pomDepth: 0.064,
      emissive: 0x061a26,
      emissiveIntensity: 0.18,
      shimmerStrength: 0.16,
      shimmerColor: 0x38bdf8,
    }),
    icyCobble: makePbrMat(pbr.icyCobble, {
      key: "cobble",
      roughness: 0.92,
      metalness: 0.10,
      pomDepth: 0.058,
      shimmerStrength: 0.03,
      shimmerColor: 0xbae6fd,
    }),
    iceCrystal: makePbrMat(pbr.iceCrystal, {
      key: "ice",
      roughness: 0.72,
      metalness: 0.18,
      pomDepth: 0.045,
      emissive: 0x0b2a3d,
      emissiveIntensity: 0.16,
      shimmerStrength: 0.09,
      shimmerColor: 0x7dd3fc,
    }),
    boneCairn: makePbrMat(pbr.boneCairn, { key: "bone", roughness: 0.96, metalness: 0.03, pomDepth: 0.058 }),
    frostNeedles: makePbrMat(pbr.frostNeedles, { key: "frost", roughness: 0.88, doubleSided: true, pom: false, sway: true }),
    cedarFoliage: makePbrMat(pbr.cedarFoliage, { key: "cedar", roughness: 0.90, doubleSided: true, pom: false, sway: true }),
    willowFoliage: makePbrMat(pbr.willowFoliage, { key: "willow", roughness: 0.92, doubleSided: true, pom: false, sway: true }),
    ghostFern: makePbrMat(pbr.ghostFern, {
      key: "gfern",
      roughness: 0.80,
      doubleSided: true,
      pom: false,
      sway: true,
      emissive: 0x102632,
      emissiveIntensity: 0.14,
    }),
    sulfurFern: makePbrMat(pbr.sulfurFern, {
      key: "sfern",
      roughness: 0.84,
      doubleSided: true,
      pom: false,
      sway: true,
      emissive: 0x1e2806,
      emissiveIntensity: 0.12,
    }),
    desertFlora: makePbrMat(pbr.desertFlora, { key: "dflora", roughness: 0.92, doubleSided: true, pom: false, sway: true }),
    runicDoor: makePbrMat(pbr.runicDoor, {
      key: "rdoor",
      roughness: 0.88,
      metalness: 0.35,
      pomDepth: 0.052,
      emissive: 0x071d2b,
      emissiveIntensity: 0.18,
      shimmerStrength: 0.15,
      shimmerColor: 0x38bdf8,
    }),
    soulfire,
    hearthfire,
  };
}

// Build template mesh parts [{ geometry, material, castShadow }] for each scenery DID
function buildSceneryTemplate(did, mats) {
  const spec = SCENERY_SPECS[did] || { kind: "granite_crag", r: 2.0, h: 3.0 };
  const k = spec.kind;
  const h = spec.h;
  const r = spec.r;
  const castShadow = !spec.noCastShadow;

  if (k === "ironwood_pine" || k === "mountain_cypress" || k === "maritime_pine") {
    const trunk = new MeshBuilder();
    trunk.addTaperedCylinder(0, 0, -0.5, h * 0.75, r * 0.16, r * 0.04, 7, false, 0.15, 0.12, 11);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      trunk.addTaperedCylinder(Math.cos(a) * r * 0.12, Math.sin(a) * r * 0.12, -0.4, h * 0.12, r * 0.1, 0.02, 5, false);
    }

    const crown = new MeshBuilder();
    const tiers = k === "mountain_cypress" ? 6 : 5;
    for (let t = 0; t < tiers; t++) {
      const frac = t / tiers;
      const z0 = h * (0.22 + frac * 0.58);
      const z1 = z0 + h * (0.32 - frac * 0.12);
      const rad = r * (1.05 - frac * (k === "mountain_cypress" ? 0.55 : 0.65));
      crown.addTaperedCylinder(0, 0, z0, z1, rad, rad * 0.08, 8, true, t * 0.4, 0.22, 100 + t);
    }
    const folMat = k === "ironwood_pine" ? mats.frostNeedles : mats.cedarFoliage;
    return [
      { geometry: trunk.toGeometry(), material: mats.barkSway, castShadow: true },
      { geometry: crown.toGeometry({ soften: true }), material: folMat, castShadow: true },
    ];
  }

  if (k === "ash_cedar" || k === "desert_ironwood" || k === "bog_willow") {
    const trunk = new MeshBuilder();
    trunk.addTaperedCylinder(0, 0, -0.5, h * 0.55, r * 0.2, r * 0.08, 7, false, 0.25, 0.18, 23);
    for (let b = 0; b < 3; b++) {
      const a = (b / 3) * Math.PI * 2 + 0.4;
      const bx = Math.cos(a) * r * 0.35;
      const by = Math.sin(a) * r * 0.35;
      trunk.addTaperedCylinder(bx * 0.4, by * 0.4, h * 0.32, h * 0.68, r * 0.09, r * 0.03, 5, false);
    }

    const crown = new MeshBuilder();
    const lobes = 5;
    for (let i = 0; i < lobes; i++) {
      const a = (i / lobes) * Math.PI * 2;
      const d = (i === 0) ? 0 : r * 0.42;
      const lx = Math.cos(a) * d;
      const ly = Math.sin(a) * d;
      const lz0 = h * (i === 0 ? 0.48 : 0.38);
      const lz1 = h * (i === 0 ? 1.0 : 0.86);
      const lr = r * (i === 0 ? 0.78 : 0.62);
      crown.addTaperedCylinder(lx, ly, lz0, (lz0 + lz1) * 0.5, lr * 0.65, lr, 8, false, i * 0.3, 0.2, 200 + i);
      crown.addTaperedCylinder(lx, ly, (lz0 + lz1) * 0.5, lz1, lr, lr * 0.2, 8, true, i * 0.3, 0.2, 220 + i);
    }
    const folMat = k === "bog_willow" ? mats.willowFoliage : (k === "desert_ironwood" ? mats.desertFlora : mats.cedarFoliage);
    return [
      { geometry: trunk.toGeometry(), material: mats.barkSway, castShadow: true },
      { geometry: crown.toGeometry({ soften: true }), material: folMat, castShadow: true },
    ];
  }

  if (k === "deadwood_snag" || k === "petrified_timber") {
    // Gnarled, wind-twisted dead pine snag with skeletal bare branches
    const tb = new MeshBuilder();
    tb.addTaperedCylinder(0, 0, -0.6, h * 0.52, r * 0.24, r * 0.14, 6, false, 0.42, 0.22, 901);
    tb.addSlantedLimb(0, 0, h * 0.48, r * 0.28, -r * 0.12, h, r * 0.14, 0.02, 5);
    if (k === "deadwood_snag") {
      tb.addSlantedLimb(0, 0, h * 0.36, -r * 0.78, r * 0.34, h * 0.68, r * 0.09, 0.015, 5);
      tb.addSlantedLimb(0, 0, h * 0.52, r * 0.72, r * 0.45, h * 0.82, r * 0.08, 0.015, 5);
      tb.addSlantedLimb(0, 0, h * 0.62, -r * 0.45, -r * 0.66, h * 0.88, r * 0.07, 0.015, 4);
    }
    return [{ geometry: tb.toGeometry(), material: mats.bark, castShadow: true }];
  }

  if (k === "ghost_fern" || k === "sulfur_fern" || k === "salt_fern" || k === "creeping_fern" || k === "ghost_cane" || k === "cordgrass") {
    const fb = new MeshBuilder();
    const fronds = k === "ghost_cane" ? 12 : 9;
    for (let i = 0; i < fronds; i++) {
      const az = (i / fronds) * Math.PI * 2 + (i % 2) * 0.18;
      const ring = (i % 2 === 0) ? 1.0 : 0.72;
      fb.addFernFrond(az, r * 1.35 * ring, r * 0.42, h * (0.85 * ring), h * 0.28, 4);
    }
    const mat = (k === "ghost_fern" || k === "ghost_cane") ? mats.ghostFern : mats.sulfurFern;
    return [{ geometry: fb.toGeometry(), material: mat, castShadow: false }];
  }

  if (k === "blood_cactus" || k === "joshua_yucca") {
    const cb = new MeshBuilder();
    cb.addTaperedCylinder(0, 0, -0.2, h, r * 0.38, r * 0.26, 8, true, 0, 0.08, 301);
    cb.addTaperedCylinder(r * 0.48, 0, h * 0.38, h * 0.78, r * 0.24, r * 0.18, 6, true, 0, 0.08, 302);
    cb.addTaperedCylinder(-r * 0.44, 0, h * 0.48, h * 0.85, r * 0.22, r * 0.16, 6, true, 0, 0.08, 303);
    return [{ geometry: cb.toGeometry(), material: mats.desertFlora, castShadow: true }];
  }

  if (k === "frost_shrub" || k === "obsidian_thornbush" || k === "rift_moss" || k === "alpine_thistle" || k === "mire_pitcher" || k === "red_scrub" || k === "lichen_mat") {
    const sb = new MeshBuilder();
    for (let i = 0; i < 7; i++) {
      const az = (i / 7) * Math.PI * 2;
      sb.addFernFrond(az, r * 1.15, r * 0.48, h * 0.9, h * 0.18, 3);
    }
    const mat = (k === "frost_shrub" || k === "lichen_mat" || k === "alpine_thistle")
      ? mats.frostNeedles
      : (k === "red_scrub" ? mats.desertFlora : mats.willowFoliage);
    return [{ geometry: sb.toGeometry({ soften: !!spec.soften }), material: mat, castShadow: false }];
  }

  if (k === "spore_mushroom") {
    const stipe = new MeshBuilder();
    stipe.addTaperedCylinder(0, 0, -0.2, h * 0.78, r * 0.28, r * 0.18, 7, false);
    const cap = new MeshBuilder();
    cap.addTaperedCylinder(0, 0, h * 0.68, h, r * 1.1, r * 0.15, 9, true);
    return [
      { geometry: stipe.toGeometry(), material: mats.limestone, castShadow: true },
      { geometry: cap.toGeometry({ soften: true }), material: mats.ghostFern, castShadow: true },
    ];
  }

  if (k === "obsidian_spire") {
    const mb = new MeshBuilder();
    mb.addTaperedCylinder(0, 0, -1.0, h, r * 0.85, r * 0.06, 6, true, 0.2, 0.25, 401);
    mb.addTaperedCylinder(r * 0.45, r * 0.2, -0.8, h * 0.58, r * 0.48, r * 0.05, 6, true, -0.15, 0.2, 402);
    mb.addTaperedCylinder(-r * 0.4, -r * 0.25, -0.8, h * 0.46, r * 0.42, r * 0.05, 6, true, 0.1, 0.2, 403);
    return [{ geometry: mb.toGeometry(), material: mats.obsidian, castShadow: true }];
  }

  if (k === "imperial_obelisk" || k === "runic_stone") {
    const mb = new MeshBuilder();
    mb.addBox(-r * 0.85, -r * 0.85, -1.0, r * 0.85, r * 0.85, h * 0.14, 0.3);
    mb.addTaperedCylinder(0, 0, h * 0.12, h * 0.86, r * 0.55, r * 0.34, 4, false, Math.PI * 0.25, 0.0, 501);
    mb.addTaperedCylinder(0, 0, h * 0.86, h, r * 0.34, 0.01, 4, false, Math.PI * 0.25, 0.0, 502);
    return [{ geometry: mb.toGeometry(), material: mats.runicMonolith, castShadow: true }];
  }

  if (k === "ice_crystal_cluster") {
    const ib = new MeshBuilder();
    ib.addTaperedCylinder(0, 0, -0.5, h, r * 0.34, 0.02, 6, false, 0.1, 0.06, 610);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.35;
      const tx = Math.cos(a) * r * 0.72;
      const ty = Math.sin(a) * r * 0.72;
      ib.addSlantedLimb(tx * 0.22, ty * 0.22, -0.35, tx, ty, h * (0.55 + (i % 2) * 0.18), r * 0.24, 0.02, 6);
    }
    return [{ geometry: ib.toGeometry(), material: mats.iceCrystal, castShadow: true }];
  }

  if (k === "bone_shards") {
    // Stacked ossuary bone & frost-stone ruin cairn
    const cb = new MeshBuilder();
    cb.addTaperedCylinder(0, 0, -0.4, h * 0.42, r * 0.92, r * 0.68, 7, true, 0.15, 0.22, 650);
    cb.addTaperedCylinder(r * 0.08, -r * 0.05, h * 0.38, h * 0.74, r * 0.56, r * 0.38, 6, true, -0.2, 0.2, 651);
    cb.addSlantedLimb(-r * 0.45, 0, -0.2, -r * 0.12, 0, h, r * 0.16, 0.03, 5);
    cb.addSlantedLimb(r * 0.42, r * 0.2, -0.2, r * 0.10, r * 0.05, h * 0.88, r * 0.14, 0.03, 5);
    return [{ geometry: cb.toGeometry(), material: mats.boneCairn, castShadow: true }];
  }

  if (k === "basalt_column" || k === "basalt_cluster") {
    const mb = new MeshBuilder();
    const cols = k === "basalt_cluster" ? 6 : 3;
    for (let c = 0; c < cols; c++) {
      const a = (c / cols) * Math.PI * 2;
      const d = c === 0 ? 0 : r * 0.42;
      const ch = h * (c === 0 ? 1.0 : 0.45 + 0.45 * ((c * 37) % 5) / 4);
      const cr = r * (k === "basalt_cluster" ? 0.32 : 0.48);
      mb.addTaperedCylinder(Math.cos(a) * d, Math.sin(a) * d, -1.0, ch, cr, cr * 0.94, 6, true, 0, 0.05, 600 + c);
    }
    return [{ geometry: mb.toGeometry(), material: mats.basalt, castShadow: true }];
  }

  if (k === "desert_hoodoo" || k === "sandstone_rib") {
    const mb = new MeshBuilder();
    mb.addTaperedCylinder(0, 0, -1.0, h * 0.45, r * 0.95, r * 0.62, 7, false, 0.1, 0.22, 701);
    mb.addTaperedCylinder(0, 0, h * 0.42, h * 0.78, r * 0.58, r * 0.82, 7, false, -0.1, 0.22, 702);
    mb.addTaperedCylinder(0, 0, h * 0.75, h, r * 0.84, r * 0.35, 7, true, 0.15, 0.22, 703);
    return [{ geometry: mb.toGeometry(), material: mats.adobe, castShadow: true }];
  }

  // Default: granite_crag / boulder / sulfur_geyser / scree
  const mb = new MeshBuilder();
  mb.addTaperedCylinder(0, 0, -0.6, h * 0.65, r, r * 0.72, 7, false, 0.2, 0.32, 801);
  mb.addTaperedCylinder(0, 0, h * 0.62, h, r * 0.72, r * 0.18, 7, true, -0.2, 0.32, 802);
  return [{ geometry: mb.toGeometry(), material: mats.granite, castShadow }];
}

// Build architectural 3D meshes [{ geometry, material, castShadow }] for each of the 18 building blueprints
function buildBuildingTemplate(did, mats) {
  const spec = BUILDING_SPECS[did];
  if (!spec) return [];
  const { style, w, d, h, portalY, portalZ, pw, ph } = spec;
  const hw = w * 0.5;
  const hd = d * 0.5;

  const wallB = new MeshBuilder();
  const trimB = new MeshBuilder();
  const roofB = new MeshBuilder();
  const plazaB = new MeshBuilder();
  const glowB = new MeshBuilder();

  let wallMat = mats.basalt;
  let trimMat = mats.obsidian;
  let roofMat = mats.slate;
  let plazaMat = mats.icyCobble;
  let glowMat = mats.soulfire;

  if (style.startsWith("ashatiri") || style === "marsh_stilted") {
    wallMat = mats.granite;
    trimMat = mats.bark;
    roofMat = mats.slate;
    plazaMat = mats.icyCobble;
    glowMat = mats.hearthfire;
  } else if (style.startsWith("desert")) {
    wallMat = mats.adobe;
    trimMat = mats.granite;
    roofMat = mats.adobe;
    plazaMat = mats.adobe;
    glowMat = mats.hearthfire;
  } else if (style.startsWith("civic")) {
    wallMat = mats.limestone;
    trimMat = mats.basalt;
    roofMat = mats.slate;
    plazaMat = mats.icyCobble;
    glowMat = mats.soulfire;
  }

  // 1. Foundation plinth + icy cobble plaza apron
  if (style === "marsh_stilted") {
    for (let ix = -hw + 2; ix <= hw - 2; ix += 6) {
      for (let iy = -hd + 2; iy <= hd - 2; iy += 5.5) {
        trimB.addTaperedCylinder(ix, iy, -6.5, 3.1, 0.45, 0.38, 6, false);
      }
    }
    trimB.addBox(-hw - 0.8, -hd - 0.8, 2.6, hw + 0.8, hd + 0.8, 3.1, 0.25, false);
    for (let st = 0; st < 8; st++) {
      const sz = (st / 8) * 3.0;
      const sy0 = -hd - 5.2 + st * 0.6;
      trimB.addBox(-pw * 1.1, sy0, -4.5, pw * 1.1, sy0 + 0.65, sz + 0.35, 0.3);
    }
  } else {
    plazaB.addBox(-hw - 3.6, -hd - 5.0, -5.5, hw + 3.6, hd + 3.6, 0.16, 0.28);
    wallB.addBox(-hw - 0.9, -hd - 0.9, -7.5, hw + 0.9, hd + 0.9, 0.45, 0.2);
    trimB.addBox(-pw * 1.35, portalY - 2.2, -4.5, pw * 1.35, portalY + 0.2, 0.28, 0.3);
    trimB.addBox(-pw * 1.15, portalY - 1.4, 0.28, pw * 1.15, portalY + 0.2, 0.50, 0.3);
  }

  const baseZ = portalZ;
  const wallTopZ = baseZ + h * 0.68;

  // 2. Main building body with framed portal recess at (0, portalY, baseZ)
  wallB.addBox(-hw, -hd, baseZ, -pw * 0.55, hd, wallTopZ, 0.18);
  wallB.addBox(pw * 0.55, -hd, baseZ, hw, hd, wallTopZ, 0.18);
  wallB.addBox(-pw * 0.55, -hd + 1.4, baseZ, pw * 0.55, hd, wallTopZ, 0.18);
  wallB.addBox(-pw * 0.55, -hd, baseZ + ph, pw * 0.55, -hd + 1.4, wallTopZ, 0.18);

  // Portal stone jambs, lintel & pediment around the doorway
  trimB.addBox(-pw * 0.55 - 0.55, portalY - 0.55, baseZ, -pw * 0.55 - 0.02, portalY - 0.02, baseZ + ph + 0.8, 0.3);
  trimB.addBox(pw * 0.55 + 0.02, portalY - 0.55, baseZ, pw * 0.55 + 0.55, portalY - 0.02, baseZ + ph + 0.8, 0.3);
  trimB.addBox(-pw * 0.55 - 0.85, portalY - 0.7, baseZ + ph, pw * 0.55 + 0.85, portalY - 0.02, baseZ + ph + 1.1, 0.3);

  // Flanking entrance braziers with glowing soulfire / hearthfire
  for (const side of [-1, 1]) {
    const bx = side * (pw * 0.55 + 1.8);
    const by = portalY - 1.1;
    trimB.addTaperedCylinder(bx, by, baseZ - 0.5, baseZ + 1.35, 0.42, 0.55, 6, true);
    glowB.addTaperedCylinder(bx, by, baseZ + 1.3, baseZ + 2.1, 0.38, 0.05, 6, true);
  }

  // Perimeter pilasters / buttresses along X and Y walls
  const corniceBotZ = wallTopZ - 0.35;
  const corniceTopZ = wallTopZ + 0.35;
  const roofBaseZ = wallTopZ + 0.38;
  const numPilastersX = Math.max(3, Math.round(w / 7));
  for (let i = 0; i <= numPilastersX; i++) {
    const px = -hw + (i / numPilastersX) * w;
    if (Math.abs(px) > pw * 0.9) {
      trimB.addBox(px - 0.45, -hd - 0.45, baseZ, px + 0.45, -hd - 0.02, corniceBotZ, 0.25);
    }
    trimB.addBox(px - 0.45, hd + 0.02, baseZ, px + 0.45, hd + 0.45, corniceBotZ, 0.25);
  }
  const numPilastersY = Math.max(3, Math.round(d / 7));
  for (let i = 1; i < numPilastersY; i++) {
    const py = -hd + (i / numPilastersY) * d;
    trimB.addBox(-hw - 0.45, py - 0.45, baseZ, -hw - 0.02, py + 0.45, corniceBotZ, 0.25);
    trimB.addBox(hw + 0.02, py - 0.45, baseZ, hw + 0.45, py + 0.45, corniceBotZ, 0.25);
  }

  // Cornice band at wallTopZ
  trimB.addBox(-hw - 0.65, -hd - 0.65, corniceBotZ, hw + 0.65, hd + 0.65, corniceTopZ, 0.25);

  // 3. Archetype-specific upper rooflines, towers, spires & domes
  if (style === "oligarch_palace" || style === "oligarch_spire") {
    const tier1Z = baseZ + h * 0.85;
    wallB.addBox(-hw * 0.55, -hd * 0.55, corniceTopZ, hw * 0.55, hd * 0.55, tier1Z, 0.2);
    trimB.addTaperedCylinder(0, 0, tier1Z - 0.2, baseZ + h * 1.18, Math.min(hw, hd) * 0.42, 0.25, 8, true);
    glowB.addTaperedCylinder(0, 0, baseZ + h * 1.15, baseZ + h * 1.25, 0.65, 0.08, 6, true);
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const cx = sx * (hw - 1.5);
        const cy = sy * (hd - 1.5);
        wallB.addTaperedCylinder(cx, cy, corniceTopZ, wallTopZ + 3.5, 2.4, 2.0, 6, true);
        trimB.addTaperedCylinder(cx, cy, wallTopZ + 3.2, baseZ + h * 0.98, 2.1, 0.12, 6, true);
      }
    }
  } else if (style === "oligarch_manor") {
    roofB.addGableRoof(-hw, -hd, hw, hd, roofBaseZ, baseZ + h, 0.9);
    for (const sx of [-1, 1]) {
      trimB.addTaperedCylinder(sx * (hw - 1.2), -hd + 1.2, corniceTopZ, baseZ + h * 1.05, 1.6, 0.15, 6, true);
    }
  } else if (style === "ashatiri_guild" || style === "ashatiri_longhouse" || style === "marsh_stilted") {
    roofB.addGableRoof(-hw, -hd, hw, hd, roofBaseZ, baseZ + h, 1.1);
    wallB.addBox(hw * 0.45, -2.0, roofBaseZ, hw * 0.45 + 2.2, 2.0, baseZ + h + 2.4, 0.25);
  } else if (style === "desert_citadel" || style === "desert_caravanserai" || style === "desert_ziggurat") {
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        wallB.addTaperedCylinder(sx * hw, sy * hd, baseZ, baseZ + h * 0.92, 3.2, 2.5, 8, true);
        trimB.addTaperedCylinder(sx * hw, sy * hd, baseZ + h * 0.9, baseZ + h * 1.06, 2.4, 0.2, 8, true);
      }
    }
    if (style === "desert_ziggurat" || style === "desert_citadel") {
      wallB.addBox(-hw * 0.62, -hd * 0.62, corniceTopZ, hw * 0.62, hd * 0.62, baseZ + h * 0.86, 0.2);
      trimB.addTaperedCylinder(0, 0, baseZ + h * 0.84, baseZ + h * 1.08, Math.min(hw, hd) * 0.45, 0.4, 8, true);
    }
  } else if (style === "civic_watchtower") {
    const towerTop = baseZ + h * 0.88;
    wallB.addBox(-hw * 0.82, -hd * 0.82, corniceTopZ, hw * 0.82, hd * 0.82, towerTop, 0.18);
    trimB.addBox(-hw * 0.95, -hd * 0.95, towerTop - 0.6, hw * 0.95, hd * 0.95, towerTop + 1.2, 0.25);
    roofB.addTaperedCylinder(0, 0, towerTop + 1.22, baseZ + h * 1.08, hw * 0.85, 0.15, 8, true);
    glowB.addTaperedCylinder(0, 0, towerTop + 0.8, towerTop + 2.2, 1.2, 0.3, 6, true);
  } else {
    roofB.addGableRoof(-hw, -hd, hw, hd, roofBaseZ, baseZ + h, 1.0);
    for (let cx = -hw + 3; cx <= hw - 3; cx += 4.5) {
      if (Math.abs(cx) > pw * 0.75) {
        trimB.addTaperedCylinder(cx, -hd - 1.4, baseZ, corniceBotZ, 0.48, 0.42, 8, false);
      }
    }
    trimB.addBox(-hw - 0.4, -hd - 2.0, corniceBotZ, hw + 0.4, -hd - 0.66, corniceTopZ, 0.25);
  }

  const out = [
    { geometry: wallB.toGeometry(), material: wallMat, castShadow: true },
    { geometry: trimB.toGeometry(), material: trimMat, castShadow: true },
  ];
  if (roofB.pos.length > 0) {
    out.push({ geometry: roofB.toGeometry(), material: roofMat, castShadow: true });
  }
  if (plazaB.pos.length > 0) {
    out.push({ geometry: plazaB.toGeometry(), material: plazaMat, castShadow: false });
  }
  if (glowB.pos.length > 0) {
    out.push({ geometry: glowB.toGeometry(), material: glowMat, castShadow: false });
  }
  return out;
}

// Build 3D Door mesh template
function buildDoorTemplate(mats) {
  const db = new MeshBuilder();
  db.addBox(-1.0, -0.18, 0.0, -0.03, 0.18, 2.55, 0.5, false);
  db.addBox(0.03, -0.18, 0.0, 1.0, 0.18, 2.55, 0.5, false);
  return [{ geometry: db.toGeometry(), material: mats.runicDoor, castShadow: true }];
}

let _state = null;

function ensureDericostAssets(st) {
  if (!st.textures) st.textures = [];
  if (!st.depthMats) st.depthMats = new Map();
  if (!st.sceneryTemplates) st.sceneryTemplates = new Map();
  if (!st.buildingTemplates) st.buildingTemplates = new Map();
  if (!st.mats) st.mats = createMaterials(st);
  if (!st.doorTemplate) st.doorTemplate = buildDoorTemplate(st.mats);
}

// Disposes all shared GPU template geometries, PBR/depth materials, and 256^2 DataTextures
function disposeDericostGpuAssets(st) {
  if (!st) return;
  if (st.sceneryTemplates) {
    for (const parts of st.sceneryTemplates.values()) {
      for (const p of parts) p.geometry?.dispose?.();
    }
    st.sceneryTemplates.clear();
  }
  if (st.buildingTemplates) {
    for (const parts of st.buildingTemplates.values()) {
      for (const p of parts) p.geometry?.dispose?.();
    }
    st.buildingTemplates.clear();
  }
  if (st.doorTemplate) {
    for (const p of st.doorTemplate) p.geometry?.dispose?.();
    st.doorTemplate = null;
  }
  if (st.mats) {
    for (const m of Object.values(st.mats)) m?.dispose?.();
    st.mats = null;
  }
  if (st.depthMats) {
    for (const dm of st.depthMats.values()) dm?.dispose?.();
    st.depthMats.clear();
  }
  if (st.textures) {
    for (const t of st.textures) t?.dispose?.();
    st.textures.length = 0;
  }
  if (st.fallbackSkyDome) {
    st.fallbackSkyDome.parent?.remove(st.fallbackSkyDome);
    st.fallbackSkyDome.geometry?.dispose?.();
    st.fallbackSkyDome.material?.dispose?.();
    st.fallbackSkyDome = null;
  }
}

// Decode base64 bitset into Uint8Array in both Browser and Node.js
function _decodeBase64Bits(b64) {
  if (!b64 || typeof b64 !== "string") return null;
  try {
    if (typeof atob === "function") {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    if (typeof Buffer !== "undefined") {
      return new Uint8Array(Buffer.from(b64, "base64"));
    }
  } catch (_) { /* ignore */ }
  return null;
}

function _normHex4(v) {
  return String(v || "").replace(/^0x/i, "").toUpperCase().padStart(4, "0");
}

function loadDericostAssetIndex(st) {
  if (st.assetIndex) return Promise.resolve(st.assetIndex);
  if (st.assetIndexPromise) return st.assetIndexPromise;

  st.assetIndexPromise = (async () => {
    try {
      if (typeof fetch !== "function") {
        st.assetIndex = { loaded: false, fallbackDirectFetch: true };
        return st.assetIndex;
      }
      const r = await fetch("../../dist/dericost/index.json");
      if (!r || !r.ok) {
        st.assetIndex = { loaded: false, fallbackDirectFetch: true };
        return st.assetIndex;
      }
      const j = await r.json();
      if (!j || typeof j !== "object" || (!Array.isArray(j.buildings) && !Array.isArray(j.scenery))) {
        st.assetIndex = { loaded: false, fallbackDirectFetch: true };
        return st.assetIndex;
      }

      const bldArr = Array.isArray(j.nonEmptyBuildings) ? j.nonEmptyBuildings : (j.buildings || []);
      const buildingsSet = new Set(bldArr.map(_normHex4));
      const allBuildingsSet = new Set((j.buildings || []).map(_normHex4));
      const sceneryBits = _decodeBase64Bits(j.nonEmptySceneryBits);
      const scenerySet = sceneryBits ? null : new Set((j.scenery || []).map(_normHex4));
      const spawnsBits = _decodeBase64Bits(j.nonEmptySpawnsBits);
      const spawnsSet = spawnsBits ? null : new Set((j.spawns || []).map(_normHex4));

      st.assetIndex = {
        loaded: true,
        fallbackDirectFetch: false,
        buildingsSet,
        allBuildingsSet,
        sceneryBits,
        scenerySet,
        spawnsBits,
        spawnsSet,
        counts: {
          buildings: allBuildingsSet.size,
          nonEmptyBuildings: buildingsSet.size,
          scenery: Array.isArray(j.scenery) ? j.scenery.length : 0,
          spawns: Array.isArray(j.spawns) ? j.spawns.length : 0,
          pois: Array.isArray(j.pois) ? j.pois.length : 0,
          towns: Array.isArray(j.towns) ? j.towns.length : 0,
        },
      };
      return st.assetIndex;
    } catch (_) {
      st.assetIndex = { loaded: false, fallbackDirectFetch: true };
      return st.assetIndex;
    }
  })();

  return st.assetIndexPromise;
}

function indexHasBuildings(idx, hex4) {
  if (!idx || idx.fallbackDirectFetch) return true;
  return idx.buildingsSet.has(hex4);
}

function indexHasScenery(idx, hex4) {
  if (!idx || idx.fallbackDirectFetch) return true;
  if (idx.sceneryBits) {
    const id = parseInt(hex4, 16) & 0xffff;
    return (idx.sceneryBits[id >> 3] & (1 << (id & 7))) !== 0;
  }
  return idx.scenerySet ? idx.scenerySet.has(hex4) : true;
}

export function indexHasSpawns(idx, hex4) {
  if (!idx || idx.fallbackDirectFetch) return true;
  const h = _normHex4(hex4);
  if (idx.spawnsBits) {
    const id = parseInt(h, 16) & 0xffff;
    return (idx.spawnsBits[id >> 3] & (1 << (id & 7))) !== 0;
  }
  return idx.spawnsSet ? idx.spawnsSet.has(h) : true;
}

export function initDericostWorld(scene3d, { parent = null } = {}) {
  if (_state) return _state;
  const root = new THREE.Group();
  root.name = "dericost-world-props";
  root.visible = false;
  (parent ?? scene3d.terrainGroup?.parent ?? scene3d.scene).add(root);

  _state = {
    root,
    mats: null,
    textures: [],
    depthMats: new Map(),
    sceneryTemplates: new Map(),
    buildingTemplates: new Map(),
    doorTemplate: null,
    fallbackSkyDome: null,
    assetIndex: null,
    assetIndexPromise: null,
    lbGroups: new Map(), // lbHex -> { lbX, lbY, status, group }
    vfxNoted: new Map(), // lbHex -> { lbX, lbY, dLbY }
    vfxSwampDirtInited: false,
    fetchQueue: [],
    buildQueue: [],
    activeFetches: 0,
    visibleLandblocks: 0,
    culledLandblocks: 0,
    lastCenterKey: null,
    lastError: null,
    _lightsEcefAnchored: false,
    _lastEcefY: 0,
    _lastEcefZ: 0,
    _frustum: new THREE.Frustum(),
    _projScreenMatrix: new THREE.Matrix4(),
    _worldSphere: new THREE.Sphere(),
  };

  if (typeof window !== "undefined") {
    window.__dericostWorld = () => ({
      loadedLandblocks: _state.lbGroups.size,
      vfxNotedLandblocks: _state.vfxNoted.size,
      builtLandblocks: _state.root.children.length,
      visibleLandblocks: _state.visibleLandblocks,
      culledLandblocks: _state.culledLandblocks,
      activeFetches: _state.activeFetches,
      queuedFetches: _state.fetchQueue.length,
      queuedBuilds: _state.buildQueue.length,
      indexLoaded: !!_state.assetIndex?.loaded,
      indexCounts: _state.assetIndex?.counts || null,
      lastCenterKey: _state.lastCenterKey,
      lastError: _state.lastError,
    });
  }
  return _state;
}

function getSceneryTemplate(st, did) {
  let tpl = st.sceneryTemplates.get(did);
  if (!tpl) {
    tpl = buildSceneryTemplate(did, st.mats);
    st.sceneryTemplates.set(did, tpl);
  }
  return tpl;
}

function getBuildingTemplate(st, did) {
  let tpl = st.buildingTemplates.get(did);
  if (!tpl) {
    tpl = buildBuildingTemplate(did, st.mats);
    st.buildingTemplates.set(did, tpl);
  }
  return tpl;
}

async function fetchJsonl(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const txt = (await r.text()).trim();
    if (!txt) return [];
    const out = [];
    for (const line of txt.split("\n")) {
      const s = line.trim();
      if (!s || s[0] !== "{") continue;
      try { out.push(JSON.parse(s)); } catch (_) {}
    }
    return out;
  } catch (_) {
    return [];
  }
}

// Deterministically populates Dericost provinces & empty wilderness/perimeter LBs from LB hash + terrain height/type
export function augmentProvinceFlora(lbX, lbY, sceneryRecs, buildingRecs) {
  const baseRecs = Array.isArray(sceneryRecs) ? sceneryRecs : [];
  const wy0 = DERICOST_Y_MIN + lbY * LB_M;
  const wx0 = lbX * LB_M;
  const lbData = extractDericostLandblockData(lbX, lbY);

  let treeDid = "0x02100001"; // Frost-rimed Gelid Ironwood Conifer
  let secTreeDid = "0x02100016"; // Dead twisted pine snag
  let fernDid = "0x02100003"; // Gelid Ghost-Fern
  let shrubDid = "0x02100011"; // Frost Shrub
  let rockDid = "0x01100002"; // Obsidian Monolith Spire
  let cairnDid = "0x0110001C"; // Bone/Ruin Cairn
  let crystalDid = "0x0110001D"; // Glacial Ice Crystals

  if (wy0 >= 98000) {
    treeDid = "0x02100001";
    secTreeDid = "0x02100016";
    fernDid = "0x02100003";
    shrubDid = "0x02100011";
    rockDid = "0x01100015"; // Rune-carved Imperial Obelisk
    cairnDid = "0x0110001C";
    crystalDid = "0x0110001D";
  } else if (wy0 >= 88000 && wx0 >= 21000) {
    treeDid = "0x02100002"; // Tresimaen Ash-Cedar
    secTreeDid = "0x02100001"; // Frost-rimed Conifer
    fernDid = "0x02100004"; // Tresimaen Sulfur-Fern
    shrubDid = "0x02100003";
    rockDid = "0x01100002"; // Obsidian Monolith
    cairnDid = "0x0110001C";
    crystalDid = "0x01100005"; // Runic Standing Stone
  } else if (wy0 >= 88000 && wx0 < 21000) {
    treeDid = "0x02100008"; // Ashatiri Mountain Cypress
    secTreeDid = "0x02100016"; // Dead twisted pine
    fernDid = "0x02100015"; // Ashatiri Creeping Fern
    shrubDid = "0x02100011";
    rockDid = "0x01100005"; // Runic Standing Stone
    cairnDid = "0x0110001C";
    crystalDid = "0x0110001D";
  } else if (wy0 >= 75500 && wx0 < 23000) {
    treeDid = "0x02100007"; // Daralet Bog-Willow
    secTreeDid = "0x02100019"; // Giant Spore-Mushroom
    fernDid = "0x02100018"; // Marsh Ghost-Cane
    shrubDid = "0x02100016"; // Bog deadwood snag
    rockDid = "0x01100005";
    cairnDid = "0x0110001C";
    crystalDid = "0x01100002";
  } else if (wy0 >= 75500 && wx0 >= 23000) {
    treeDid = "0x02100005"; // High Desert Ironwood
    secTreeDid = "0x02100006"; // Blood-Thorn Cactus
    fernDid = "0x0210001B"; // Desert Joshua-Yucca
    shrubDid = "0x0210001C"; // Red Scrub
    rockDid = "0x01100014"; // Desert Hoodoo
    cairnDid = "0x0110001C";
    crystalDid = "0x01100002";
  } else {
    treeDid = "0x02100009"; // Nesortania Maritime Pine
    secTreeDid = "0x02100008";
    fernDid = "0x02100010"; // Coastal Salt-Fern
    shrubDid = "0x02100016"; // Wind-twisted coastal snag
    rockDid = "0x01100003";
    cairnDid = "0x0110001C";
    crystalDid = "0x01100005";
  }

  const bldgs = (buildingRecs || []).filter((b) => b && b.is_building);
  const avoidsBuilding = (lx, ly, pad) => {
    for (const b of bldgs) {
      if (Math.abs(lx - Number(b.x)) < pad && Math.abs(ly - Number(b.y)) < pad) return true;
    }
    return false;
  };
  const out = baseRecs.filter((r) => !avoidsBuilding(Number(r.x), Number(r.y), 18));

  const fallbackZ = Number(baseRecs[0]?.z ?? bldgs[0]?.z) || 50;
  const slotCount = baseRecs.length === 0 ? 52 : 38;
  const baseSeed = ((lbX * 73856093) ^ (lbY * 19349663)) >>> 0;

  for (let i = 0; i < slotCount; i++) {
    const h1 = hash32(baseSeed + i * 31 + 1);
    const h2 = hash32(baseSeed + i * 31 + 2);
    const h3 = hash32(baseSeed + i * 31 + 3);
    const lx = 8 + (h1 % 1760) * 0.1;
    const ly = 8 + (h2 % 1760) * 0.1;

    // Sample terrain height & terrain water code to reject ocean/riverbeds while populating dry wilderness
    const gh = worldGroundHeight(wx0 + lx, wy0 + ly);
    if (gh !== null && Number.isFinite(gh) && gh <= 0.65) continue;
    let terrainCode = -1;
    if (lbData && lbData.codes) {
      const cx = Math.min(8, Math.max(0, Math.floor(lx / 24)));
      const cy = Math.min(8, Math.max(0, Math.floor(ly / 24)));
      terrainCode = lbData.codes[cy * 9 + cx] ?? -1;
      if (terrainCode >= 16 && terrainCode <= 20) continue; // open water / sea
    }

    const isTreeSlot = i < 22;
    const isSnagOrCrystalSlot = i >= 22 && i < 32;
    const isMonolithOrCairnSlot = i >= slotCount - 6;
    const pad = (isTreeSlot || isMonolithOrCairnSlot) ? 24 : 16;
    if (avoidsBuilding(lx, ly, pad)) continue;

    const elevZ = (gh !== null && Number.isFinite(gh)) ? gh : fallbackZ;
    const highAlpine = elevZ >= 220;

    let did = fernDid;
    let sc = 0.85 + ((h3 & 0xff) / 255) * 0.55;
    if (isTreeSlot) {
      if (highAlpine && (i % 2 === 0)) {
        did = (i % 4 === 0) ? "0x02100016" : "0x02100001";
      } else if (i % 5 === 0) {
        did = "0x02100016"; // Dead twisted pine
      } else {
        did = (i % 3 === 0) ? secTreeDid : treeDid;
      }
      sc = 0.82 + ((h3 & 0xff) / 255) * 0.48;
    } else if (isSnagOrCrystalSlot) {
      did = (highAlpine || (i & 1) === 0) ? crystalDid : shrubDid;
      sc = 0.80 + ((h3 & 0xff) / 255) * 0.50;
    } else if (isMonolithOrCairnSlot) {
      did = (i & 1) === 0 ? rockDid : cairnDid;
      sc = 0.85 + ((h3 & 0xff) / 255) * 0.45;
    }

    const yaw = (((h3 >>> 8) & 0xffff) / 65535) * Math.PI * 2;
    out.push({
      obj_id: did,
      x: lx,
      y: ly,
      z: elevZ,
      qw: Math.cos(yaw * 0.5),
      qx: 0,
      qy: 0,
      qz: Math.sin(yaw * 0.5),
      scale: sc,
    });
  }
  return out;
}

// Reusable scratch buffers for fast, exact zero-allocation InstancedMesh & LB union bounding spheres
let _instSphereBuf = new Float32Array(256 * 4);
const _geomCenterTmp = new THREE.Vector3();

function _ensureInstSphereBuf(count) {
  if (_instSphereBuf.length < count * 4) {
    _instSphereBuf = new Float32Array(Math.max(count * 4, _instSphereBuf.length * 2));
  }
  return _instSphereBuf;
}

function _finalizeInstancedBounds(im, count, sphereBuf, unionBox) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const k = i * 4;
    const cx = sphereBuf[k];
    const cy = sphereBuf[k + 1];
    const cz = sphereBuf[k + 2];
    const r = sphereBuf[k + 3];
    if (cx - r < minX) minX = cx - r;
    if (cy - r < minY) minY = cy - r;
    if (cz - r < minZ) minZ = cz - r;
    if (cx + r > maxX) maxX = cx + r;
    if (cy + r > maxY) maxY = cy + r;
    if (cz + r > maxZ) maxZ = cz + r;
  }
  if (!Number.isFinite(minX)) {
    im.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0);
    return;
  }
  const mx = 0.5 * (minX + maxX);
  const my = 0.5 * (minY + maxY);
  const mz = 0.5 * (minZ + maxZ);
  let maxR = 0;
  for (let i = 0; i < count; i++) {
    const k = i * 4;
    const d = Math.hypot(sphereBuf[k] - mx, sphereBuf[k + 1] - my, sphereBuf[k + 2] - mz) + sphereBuf[k + 3];
    if (d > maxR) maxR = d;
  }
  im.boundingSphere = new THREE.Sphere(new THREE.Vector3(mx, my, mz), maxR);

  if (minX < unionBox.minX) unionBox.minX = minX;
  if (minY < unionBox.minY) unionBox.minY = minY;
  if (minZ < unionBox.minZ) unionBox.minZ = minZ;
  if (maxX > unionBox.maxX) unionBox.maxX = maxX;
  if (maxY > unionBox.maxY) unionBox.maxY = maxY;
  if (maxZ > unionBox.maxZ) unionBox.maxZ = maxZ;
}

function buildLandblockGroup(st, lbX, lbY, rawSceneryRecs, buildingRecs) {
  ensureDericostAssets(st);
  const group = new THREE.Group();
  const hex = (((lbX << 8) | lbY) >>> 0).toString(16).toUpperCase().padStart(4, "0");
  group.name = `dericost-lb-0x${hex}`;
  const wx0 = lbX * LB_M;
  const wy0 = DERICOST_Y_MIN + lbY * LB_M;
  const sceneryRecs = augmentProvinceFlora(lbX, lbY, rawSceneryRecs, buildingRecs);

  const unionBox = {
    minX: Infinity, minY: Infinity, minZ: Infinity,
    maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
  };

  // 1. Group scenery records by obj_id and build InstancedMeshes
  const byDid = new Map();
  for (const rec of (sceneryRecs || [])) {
    const did = String(rec.obj_id || "");
    if (!did) continue;
    let arr = byDid.get(did);
    if (!arr) { arr = []; byDid.set(did, arr); }
    arr.push(rec);
  }

  const dummyMat = new THREE.Matrix4();
  const posV = new THREE.Vector3();
  const quatQ = new THREE.Quaternion();
  const scaleV = new THREE.Vector3();
  const shadowCasters = [];

  for (const [did, recs] of byDid.entries()) {
    const parts = getSceneryTemplate(st, did);
    const count = recs.length;
    if (!count || !parts.length) continue;
    const sBuf = _ensureInstSphereBuf(count);

    for (let p = 0; p < parts.length; p++) {
      const { geometry, material, castShadow } = parts[p];
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      const gs = geometry.boundingSphere;

      const im = new THREE.InstancedMesh(geometry, material, count);
      im.frustumCulled = true;
      im.castShadow = false;
      if (castShadow !== false) shadowCasters.push(im);
      im.receiveShadow = true;
      if (material?.userData?.customDepthMaterial) {
        im.customDepthMaterial = material.userData.customDepthMaterial;
      }
      im.matrixAutoUpdate = false;

      for (let i = 0; i < count; i++) {
        const r = recs[i];
        const wx = wx0 + (Number(r.x) || 0);
        const wy = wy0 + (Number(r.y) || 0);
        const gh = worldGroundHeight(wx, wy);
        const wz = Number.isFinite(gh) && gh > 0.05 ? gh : (Number(r.z) || 0);
        const sc = Math.max(0.5, Math.min(3.0, Number(r.scale) || 1.0));
        posV.set(wx, wy, wz);
        quatQ.set(Number(r.qx) || 0, Number(r.qy) || 0, Number(r.qz) || 0, Number(r.qw) ?? 1);
        scaleV.set(sc, sc, sc);
        dummyMat.compose(posV, quatQ, scaleV);
        im.setMatrixAt(i, dummyMat);

        _geomCenterTmp.copy(gs.center).multiplyScalar(sc).applyQuaternion(quatQ).add(posV);
        const k = i * 4;
        sBuf[k] = _geomCenterTmp.x;
        sBuf[k + 1] = _geomCenterTmp.y;
        sBuf[k + 2] = _geomCenterTmp.z;
        sBuf[k + 3] = gs.radius * sc;
      }
      im.instanceMatrix.needsUpdate = true;
      im.updateMatrix();
      _finalizeInstancedBounds(im, count, sBuf, unionBox);
      group.add(im);
    }
  }

  // 2. Batch and freeze town buildings & doors
  const bldgsByDid = new Map();
  const doors = [];
  for (const rec of (buildingRecs || [])) {
    if (rec.is_building) {
      const did = String(rec.obj_id || "");
      if (!did) continue;
      let arr = bldgsByDid.get(did);
      if (!arr) { arr = []; bldgsByDid.set(did, arr); }
      arr.push(rec);
    } else if (rec.is_door) {
      doors.push(rec);
    }
  }

  for (const [did, recs] of bldgsByDid.entries()) {
    const parts = getBuildingTemplate(st, did);
    const count = recs.length;
    if (!count || !parts.length) continue;
    const sBuf = _ensureInstSphereBuf(count);

    for (let p = 0; p < parts.length; p++) {
      const { geometry, material, castShadow } = parts[p];
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      const gs = geometry.boundingSphere;

      const im = new THREE.InstancedMesh(geometry, material, count);
      im.frustumCulled = true;
      im.castShadow = false;
      if (castShadow !== false) shadowCasters.push(im);
      im.receiveShadow = true;
      im.matrixAutoUpdate = false;

      for (let i = 0; i < count; i++) {
        const r = recs[i];
        const wx = wx0 + (Number(r.x) || 0);
        const wy = wy0 + (Number(r.y) || 0);
        const gh = worldGroundHeight(wx, wy);
        const baseGroundZ = Number.isFinite(gh) && gh > 0.05 ? gh : (Number(r.z) || 0);
        posV.set(wx, wy, baseGroundZ);
        quatQ.set(Number(r.qx) || 0, Number(r.qy) || 0, Number(r.qz) || 0, Number(r.qw) ?? 1);
        scaleV.set(1, 1, 1);
        dummyMat.compose(posV, quatQ, scaleV);
        im.setMatrixAt(i, dummyMat);

        _geomCenterTmp.copy(gs.center).applyQuaternion(quatQ).add(posV);
        const k = i * 4;
        sBuf[k] = _geomCenterTmp.x;
        sBuf[k + 1] = _geomCenterTmp.y;
        sBuf[k + 2] = _geomCenterTmp.z;
        sBuf[k + 3] = gs.radius;
      }
      im.instanceMatrix.needsUpdate = true;
      im.updateMatrix();
      _finalizeInstancedBounds(im, count, sBuf, unionBox);
      group.add(im);
    }
  }

  // Batch town doors using InstancedMesh
  if (doors.length > 0 && st.doorTemplate?.length) {
    const count = doors.length;
    const sBuf = _ensureInstSphereBuf(count);
    for (const { geometry, material, castShadow } of st.doorTemplate) {
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      const gs = geometry.boundingSphere;

      const im = new THREE.InstancedMesh(geometry, material, count);
      im.frustumCulled = true;
      im.castShadow = false;
      if (castShadow !== false) shadowCasters.push(im);
      im.receiveShadow = true;
      im.matrixAutoUpdate = false;

      for (let i = 0; i < count; i++) {
        const rec = doors[i];
        const wx = wx0 + (Number(rec.x) || 0);
        const wy = wy0 + (Number(rec.y) || 0);
        const gh = worldGroundHeight(wx, wy);
        const baseGroundZ = Number.isFinite(gh) && gh > 0.05 ? gh : (Number(rec.z) || 0);
        const zOffset = (Number(rec.z) || 0) > baseGroundZ + 1.5 ? 3.0 : 0.0;
        posV.set(wx, wy, baseGroundZ + zOffset);
        quatQ.set(Number(rec.qx) || 0, Number(rec.qy) || 0, Number(rec.qz) || 0, Number(rec.qw) ?? 1);
        scaleV.set(1, 1, 1);
        dummyMat.compose(posV, quatQ, scaleV);
        im.setMatrixAt(i, dummyMat);

        _geomCenterTmp.copy(gs.center).applyQuaternion(quatQ).add(posV);
        const k = i * 4;
        sBuf[k] = _geomCenterTmp.x;
        sBuf[k + 1] = _geomCenterTmp.y;
        sBuf[k + 2] = _geomCenterTmp.z;
        sBuf[k + 3] = gs.radius;
      }
      im.instanceMatrix.needsUpdate = true;
      im.updateMatrix();
      _finalizeInstancedBounds(im, count, sBuf, unionBox);
      group.add(im);
    }
  }

  // Compute exact union bounding sphere over all InstancedMeshes in this LB (in st.root AC Z-up space)
  if (Number.isFinite(unionBox.minX) && group.children.length > 0) {
    const ux = 0.5 * (unionBox.minX + unionBox.maxX);
    const uy = 0.5 * (unionBox.minY + unionBox.maxY);
    const uz = 0.5 * (unionBox.minZ + unionBox.maxZ);
    let uRad = 0;
    for (let i = 0; i < group.children.length; i++) {
      const bs = group.children[i].boundingSphere;
      if (!bs) continue;
      const d = Math.hypot(bs.center.x - ux, bs.center.y - uy, bs.center.z - uz) + bs.radius;
      if (d > uRad) uRad = d;
    }
    group.userData.localUnionSphere = new THREE.Sphere(new THREE.Vector3(ux, uy, uz), uRad);
  } else {
    group.userData.localUnionSphere = new THREE.Sphere(
      new THREE.Vector3(wx0 + LB_M * 0.5, wy0 + LB_M * 0.5, 60),
      LB_M * 0.75
    );
  }

  group.userData.shadowCasters = shadowCasters;
  group.userData.lastNearShadow = false;
  group.matrixAutoUpdate = false;
  group.updateMatrix();
  return group;
}

function disposeLandblockGroup(st, grp) {
  if (!grp) return;
  if (st?.root) st.root.remove(grp);
  grp.traverse((obj) => {
    if (obj.isInstancedMesh && typeof obj.dispose === "function") {
      obj.dispose();
    }
  });
}

function pumpFetchQueue(st) {
  while (st.activeFetches < MAX_CONCURRENT_FETCHES && st.fetchQueue.length > 0) {
    const job = st.fetchQueue.shift();
    const entry = st.lbGroups.get(job.hex);
    if (!entry || entry.status !== "queued") continue;
    entry.status = "loading";
    st.activeFetches += 1;

    loadDericostAssetIndex(st)
      .then((idx) => {
        const curCheck = st.lbGroups.get(job.hex);
        if (!curCheck || curCheck.status === "evicted") return null;
        const pWorld = loadWorldData().catch(() => null);
        const pScenery = indexHasScenery(idx, job.hex)
          ? fetchJsonl(`../../dist/dericost/scenery/0x${job.hex}.scenery.jsonl`)
          : Promise.resolve([]);
        const pBuildings = indexHasBuildings(idx, job.hex)
          ? fetchJsonl(`../../dist/dericost/buildings/0x${job.hex}.buildings.jsonl`)
          : Promise.resolve([]);
        return Promise.all([pWorld, pScenery, pBuildings]);
      })
      .then((res) => {
        if (!res) return;
        const [, sceneryRecs, buildingRecs] = res;
        const cur = st.lbGroups.get(job.hex);
        if (!cur || cur.status === "evicted") return;
        cur.status = "fetched";
        st.buildQueue.push({
          hex: job.hex,
          lbX: job.lbX,
          lbY: job.lbY,
          sceneryRecs,
          buildingRecs,
        });
      })
      .catch((err) => {
        st.lastError = String(err?.message || err);
      })
      .finally(() => {
        st.activeFetches = Math.max(0, st.activeFetches - 1);
        pumpFetchQueue(st);
      });
  }
}

// Time-slice landblock InstancedMesh construction (1 heavy town LB or up to 2 wilderness LBs per frame, nearest first)
function drainBuildQueue(st, ax, ay) {
  if (!st.buildQueue || st.buildQueue.length === 0) return;
  if (st.buildQueue.length > 1) {
    st.buildQueue.sort((a, b) => {
      const dax = (a.lbX + 0.5) * LB_M - ax;
      const day = (DERICOST_Y_MIN + (a.lbY + 0.5) * LB_M) - ay;
      const dbx = (b.lbX + 0.5) * LB_M - ax;
      const dby = (DERICOST_Y_MIN + (b.lbY + 0.5) * LB_M) - ay;
      return (dax * dax + day * day) - (dbx * dbx + dby * dby);
    });
  }

  let budget = MAX_BUILD_BUDGET_PER_FRAME;
  while (budget > 0 && st.buildQueue.length > 0) {
    const item = st.buildQueue.shift();
    const cur = st.lbGroups.get(item.hex);
    if (!cur || cur.status === "evicted") continue;
    const grp = buildLandblockGroup(st, item.lbX, item.lbY, item.sceneryRecs, item.buildingRecs);
    cur.group = grp;
    cur.status = "ready";
    st.root.add(grp);
    const cost = (item.buildingRecs && item.buildingRecs.length > 0) ? 2 : 1;
    budget -= cost;
  }
}

const _cullCamPosTmp = new THREE.Vector3();
const DERICOST_SHADOW_RADIUS_SQ = 260 * 260;

// Per-frame Union-Sphere camera frustum culling + CSM shadow distance gating across resident Dericost landblocks
function cullDericostLandblocks(st, camera) {
  if (!camera || !camera.projectionMatrix || !camera.matrixWorldInverse) return;
  if (camera.updateMatrixWorld) camera.updateMatrixWorld();
  if (st.root.parent && st.root.parent.updateMatrixWorld) {
    st.root.updateMatrixWorld();
  }

  st._projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  st._frustum.setFromProjectionMatrix(st._projScreenMatrix);
  const cp = camera.getWorldPosition ? camera.getWorldPosition(_cullCamPosTmp) : camera.position;

  let visCount = 0;
  let cullCount = 0;
  const rootWorldMat = st.root.matrixWorld;
  const ws = st._worldSphere;

  for (const [, entry] of st.lbGroups.entries()) {
    const grp = entry.group;
    if (!grp) continue;
    const localSphere = grp.userData?.localUnionSphere;
    if (!localSphere) {
      grp.visible = true;
      visCount++;
      continue;
    }
    ws.copy(localSphere).applyMatrix4(rootWorldMat);
    const inView = st._frustum.intersectsSphere(ws);
    if (grp.visible !== inView) grp.visible = inView;
    const nearShadow = inView && !!cp && ws.center.distanceToSquared(cp) <= DERICOST_SHADOW_RADIUS_SQ;
    if (grp.userData.lastNearShadow !== nearShadow) {
      grp.userData.lastNearShadow = nearShadow;
      const casters = grp.userData.shadowCasters;
      if (casters) {
        for (let i = 0; i < casters.length; i++) casters[i].castShadow = nearShadow;
      }
    }
    if (inView) visCount++;
    else cullCount++;
  }
  st.visibleLandblocks = visCount;
  st.culledLandblocks = cullCount;
}

function _dericostEcefAnchor(z3) {
  if (!(z3 < -36000)) return { anchorY: 0, anchorZ: 0 };
  const acY = -z3;
  const anchorZ = z3 + 36000;
  const tContinent = _smoothstep(64000, 74000, acY);
  const tNorth = _smoothstep(75000, 106000, acY);
  const anchorY = tContinent * (140 + 180 * tNorth);
  return { anchorY, anchorZ };
}

function _ensureFallbackPolarDome(st) {
  if (st.fallbackSkyDome) return st.fallbackSkyDome;
  const geo = new THREE.SphereGeometry(4200, 24, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    uniforms: {
      uZenithColor: { value: new THREE.Color(0x0b1d3a) },
      uMidColor: { value: new THREE.Color(0x284b74) },
      uHorizonColor: { value: new THREE.Color(0x6b8cae) },
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uZenithColor;
      uniform vec3 uMidColor;
      uniform vec3 uHorizonColor;
      varying vec3 vDir;
      void main() {
        float h = clamp(vDir.y, -0.15, 1.0);
        float tLow = smoothstep(-0.08, 0.22, h);
        float tHigh = smoothstep(0.18, 0.85, h);
        vec3 col = mix(uHorizonColor, uMidColor, tLow);
        col = mix(col, uZenithColor, tHigh);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const dome = new THREE.Mesh(geo, mat);
  dome.name = "dericost-fallback-polar-sky";
  dome.frustumCulled = false;
  dome.renderOrder = -1000;
  st.fallbackSkyDome = dome;
  return dome;
}

// Fixes Dericost outdoor sky/lighting/fog when continent bit-15 (0x8000) cells trigger false indoor detection
function syncDericostAtmosphereAndFog(st, scene3d, cp, ax, ay, az) {
  if (!scene3d) return;

  // Check whether the player is genuinely inside an enclosed dungeon/interior cell ((cellId & 0x7FFF) >= 0x0100)
  // vs standing outdoors on Dericost where landblock cells carry bit 15 (0x8001..0x8040).
  const sh = scene3d.sessionHandle ?? globalThis.window?.__sessionHandle ?? null;
  let rawCellId = 0;
  try { rawCellId = (sh?.getCurrentCellId?.() >>> 0) || 0; } catch (_) { rawCellId = 0; }
  const trulyIndoor = rawCellId !== 0 && (rawCellId & 0x7fff) >= 0x0100;
  if (trulyIndoor) return;

  // 1. Unblock outdoor sky pass, cloud overlay, horizon dissolve, and world layer mask
  scene3d._currentCellIndoor = false;
  if (scene3d.skyDome) {
    scene3d.skyDome._lastIsIndoor = false;
    scene3d.skyDome._lastSkyBlocked = false;
  }
  scene3d.atmospherePipeline?.setIndoorLandscapeSkip?.(false);
  scene3d.atmospherePipeline?.setIndoorSplitArmed?.(false);
  scene3d.atmosphereSky?.syncWorldECEF?.(cp.x, cp.z, cp.y);

  // 2. Anchor SunDirectionalLight + SkyLightProbe ECEF frame to Dericost & unmute outdoor sunlight
  const lights = scene3d.atmosphereLights;
  if (lights?.sun && lights?.skyProbe) {
    const { anchorY: rawAnchorY, anchorZ } = _dericostEcefAnchor(cp.z);
    const anchorY = Number.isFinite(cp.y) ? Math.min(rawAnchorY, Math.max(0, cp.y - 50)) : rawAnchorY;
    const ecefY = EARTH_BOTTOM_RADIUS - anchorY;
    const ecefZ = -anchorZ;
    const ecefShifted = Math.abs(ecefY - st._lastEcefY) > 15 || Math.abs(ecefZ - st._lastEcefZ) > 40;
    if (ecefShifted || !st._lightsEcefAnchored) {
      lights.sun.worldToECEFMatrix?.makeTranslation(0, ecefY, ecefZ);
      lights.skyProbe.worldToECEFMatrix?.makeTranslation(0, ecefY, ecefZ);
      st._lastEcefY = ecefY;
      st._lastEcefZ = ecefZ;
      st._lightsEcefAnchored = true;
    }
    lights.sun.visible = true;
    if (lights._indoorMute || scene3d._poolSunIndoor || ecefShifted) {
      lights._indoorMute = false;
      scene3d._poolSunIndoor = false;
      const skyState = lights._lastState
        ?? scene3d.skyLightingController?._lastState
        ?? { dirHeading: 135, dirPitch: 26, dirBright: 0.85, dirColorArgb: 0xffdce8f8, ambBright: 0.44 };
      try { lights.tick(skyState, cp); } catch (_) { /* fail-soft */ }
    }
  } else if (scene3d.skyLightingController?.sunLight) {
    scene3d.skyLightingController.sunLight.visible = true;
  }

  // 3. Calibrate outdoor Dericost distance fog band + exposure-matched polar/twilight horizon radiance
  const fog = scene3d.scene?.fog;
  const hasAtmosphereSky = !!scene3d.atmosphereSky?.skyMesh;
  const skyState = scene3d.atmosphereLights?._lastState ?? scene3d.skyLightingController?._lastState ?? null;
  const pitchDeg = Number.isFinite(scene3d.atmosphereSky?._artPitchDeg)
    ? scene3d.atmosphereSky._artPitchDeg
    : (Number.isFinite(skyState?.dirPitch) ? skyState.dirPitch : 24.0);
  const sunAlt = Math.sin((pitchDeg * Math.PI) / 180.0);
  const dayT = _smoothstep(-0.08, 0.18, sunAlt);
  const twilightT = Math.max(0.0, 1.0 - Math.abs(sunAlt - 0.02) * 7.0);

  if (fog) {
    if (typeof fog.near === "number" && typeof fog.far === "number") {
      const gh = worldGroundHeight(ax, ay);
      const agl = Math.max(0, az - (Number.isFinite(gh) ? gh : 80));
      const minNear = 650 + Math.min(1800, agl * 2.4);
      const minFar = 4600 + Math.min(32000, agl * 12.0);
      if (fog.far < minFar) fog.far = minFar;
      if (fog.near < minNear && minNear < fog.far * 0.7) fog.near = minNear;
    }

    if (fog.color) {
      if (hasAtmosphereSky) {
        // fog.color is pre-exposure linear scene radiance; divide display-linear polar horizon target by exposure
        // whenever loop.js fell back to unscaled authored-hex (which blows out to white under exposure ~5.0).
        const exposure = Math.max(1.0, Number(scene3d.renderer?.toneMappingExposure) || 5.0);
        const probe = globalThis.window?.__farFogSkyProbe;
        const dispR = 0.012 + dayT * 0.235 + twilightT * 0.095;
        const dispG = 0.022 + dayT * 0.325 + twilightT * 0.055;
        const dispB = 0.048 + dayT * 0.475 + twilightT * 0.085;
        let radR = dispR / exposure;
        let radG = dispG / exposure;
        let radB = dispB / exposure;
        if (probe && Number.isFinite(probe.r) && Number.isFinite(probe.g) && Number.isFinite(probe.b) && (probe.r + probe.g + probe.b) > 1e-5) {
          radR = probe.r * 0.72 + radR * 0.28;
          radG = probe.g * 0.72 + radG * 0.28;
          radB = probe.b * 0.72 + radB * 0.28;
        }
        fog.color.setRGB(radR, radG, radB);
        if (scene3d.__farFogApplied) {
          scene3d.__farFogApplied.near = fog.near;
          scene3d.__farFogApplied.far = fog.far;
          scene3d.__farFogApplied.colorLinear = [radR, radG, radB];
          scene3d.__farFogApplied.colorSource = "dericost-polar-radiance";
        }
      } else if (scene3d.renderer) {
        // Non-atmosphere fallback (?atmosphere=off): smooth polar twilight dome + matched LDR fog color
        const dome = _ensureFallbackPolarDome(st);
        if (dome.parent !== scene3d.scene) scene3d.scene.add(dome);
        dome.position.copy(cp);
        const hr = 0.06 + dayT * 0.34 + twilightT * 0.12;
        const hg = 0.10 + dayT * 0.44 + twilightT * 0.08;
        const hb = 0.18 + dayT * 0.56 + twilightT * 0.10;
        dome.material.uniforms.uHorizonColor.value.setRGB(hr, hg, hb);
        dome.material.uniforms.uMidColor.value.setRGB(hr * 0.48, hg * 0.56, hb * 0.74);
        dome.material.uniforms.uZenithColor.value.setRGB(hr * 0.16, hg * 0.24, hb * 0.42);
        fog.color.setRGB(hr, hg, hb);
      }
    }
  }
}

function restoreDerethAtmosphereState(st, scene3d) {
  if (st._lightsEcefAnchored) {
    const lights = scene3d?.atmosphereLights;
    lights?.sun?.worldToECEFMatrix?.makeTranslation(0, EARTH_BOTTOM_RADIUS, 0);
    lights?.skyProbe?.worldToECEFMatrix?.makeTranslation(0, EARTH_BOTTOM_RADIUS, 0);
    st._lightsEcefAnchored = false;
    st._lastEcefY = 0;
    st._lastEcefZ = 0;
  }
  if (st.fallbackSkyDome) {
    st.fallbackSkyDome.parent?.remove(st.fallbackSkyDome);
  }
}

function evictAllDericostResources(st, scene3d, disposeSharedAssets = false) {
  for (const [, entry] of st.lbGroups.entries()) {
    entry.status = "evicted";
    if (entry.group) {
      disposeLandblockGroup(st, entry.group);
      entry.group = null;
    }
  }
  st.lbGroups.clear();
  st.fetchQueue.length = 0;
  st.buildQueue.length = 0;
  st.visibleLandblocks = 0;
  st.culledLandblocks = 0;
  st.lastCenterKey = null;

  if (st.vfxNoted.size > 0) {
    for (const [, v] of st.vfxNoted.entries()) {
      try { terrainVfxLandblockGone(lbKeyFromXY(v.lbX, v.lbY), "evict"); } catch (_) {}
    }
    st.vfxNoted.clear();
  }
  globalThis.__hbDericostVfxActive = false;
  restoreDerethAtmosphereState(st, scene3d);
  if (disposeSharedAssets) {
    disposeDericostGpuAssets(st);
  }
}

export function tickDericostWorld(scene3d, camera, nowMs = 0) {
  const st = _state || initDericostWorld(scene3d);
  if (!st || !camera) return;

  const cp = (!camera.parent || camera.parent.isScene)
    ? camera.position
    : (camera.getWorldPosition ? camera.getWorldPosition(st._cp || (st._cp = new THREE.Vector3())) : camera.position);
  const ax = cp.x;
  const ay = -cp.z;
  const az = cp.y;

  // Outside Dericost bounds or above 2,800m altitude
  if (ay < 67000.0 || ay > DERICOST_Y_MAX + 2000.0 || az > 2800.0) {
    // Strictly hide props whenever out of Dericost range or when no resident LBs exist
    if (st.root.visible) st.root.visible = false;

    if (ay < 67000.0) {
      // Returned to Dereth / southern ocean -> evict all LBs and release Dericost GPU textures/geometries/materials
      if (st.lbGroups.size > 0 || st.root.children.length > 0 || st.mats || st.textures.length > 0 || st._lightsEcefAnchored) {
        evictAllDericostResources(st, scene3d, true);
      }
    } else if (ay <= DERICOST_Y_MAX + 4000.0) {
      // High-altitude overflight over Dericost: keep sky/fog synced without drawing ground props
      syncDericostAtmosphereAndFog(st, scene3d, cp, ax, ay, az);
    }
    return;
  }

  // Advance shared VFX master clock if loop.js hasn't ticked it (e.g. standalone/free-cam sessions)
  if (VFX_GLOBALS && VFX_GLOBALS.uTime && nowMs > 0) {
    VFX_GLOBALS.uTime.value = (nowMs * 0.001) % 3600;
  }

  // Sync Dericost outdoor sky, sun/probe ECEF lighting & exposure-matched polar horizon fog every frame
  syncDericostAtmosphereAndFog(st, scene3d, cp, ax, ay, az);

  // Kick off one-time index.json load & drain 1-2 queued landblock builds per frame
  loadDericostAssetIndex(st);
  drainBuildQueue(st, ax, ay);

  // Ghost-visibility guard: require BOTH in-range Dericost pose AND active built resident LBs
  const hasActiveResidentLbs = st.root.children.length > 0 && st.lbGroups.size > 0;
  if (st.root.visible !== hasActiveResidentLbs) {
    st.root.visible = hasActiveResidentLbs;
  }

  if (hasActiveResidentLbs) {
    cullDericostLandblocks(st, camera);
  } else {
    st.visibleLandblocks = 0;
    st.culledLandblocks = 0;
  }

  globalThis.__hbDericostVfxActive = true;
  if (!st.vfxSwampDirtInited) {
    st.vfxSwampDirtInited = true;
    try {
      const parent = scene3d?.terrainGroup?.parent || st.root.parent;
      if (typeof window !== "undefined" && !window.__terrainDirt) {
        const dirt = initTerrainDirt({ THREE, scene3d, parent, globals: VFX_GLOBALS, readEnv: readParticleEnv });
        if (dirt) window.__terrainDirt = dirt;
      }
      if (typeof window !== "undefined" && !window.__terrainSwamp) {
        const swamp = initTerrainSwamp({ THREE, scene3d, parent, readEnv: readParticleEnv });
        if (swamp) window.__terrainSwamp = swamp;
      }
    } catch (_) { /* fail-soft */ }
  }

  const centerLbX = Math.max(0, Math.min(254, Math.floor(ax / LB_M)));
  const centerLbY = Math.max(0, Math.min(254, Math.floor((ay - DERICOST_Y_MIN) / LB_M)));
  const centerKey = `${centerLbX}_${centerLbY}`;
  if (centerKey === st.lastCenterKey && st.fetchQueue.length === 0 && st.vfxNoted.size >= 25) return;
  st.lastCenterKey = centerKey;

  const candidates = [];
  for (let dy = -STREAM_RADIUS_LBS; dy <= STREAM_RADIUS_LBS; dy++) {
    for (let dx = -STREAM_RADIUS_LBS; dx <= STREAM_RADIUS_LBS; dx++) {
      const lbX = centerLbX + dx;
      const lbY = centerLbY + dy;
      if (lbX < 0 || lbX > 254 || lbY < 0 || lbY > 254) continue;
      const hex = (((lbX << 8) | lbY) >>> 0).toString(16).toUpperCase().padStart(4, "0");
      candidates.push({ lbX, lbY, hex, dist2: dx * dx + dy * dy });
      if (!st.vfxNoted.has(hex)) {
        const lbData = extractDericostLandblockData(lbX, lbY);
        if (lbData) {
          try {
            terrainVfxNoteLandblockMesh(scene3d, {
              userData: {
                lbX,
                lbY: lbData.lbY,
                terrainCodes: lbData.codes,
                heights: lbData.heights,
                roadCodes: lbData.roads,
              },
            });
            st.vfxNoted.set(hex, { lbX, lbY: lbData.lbY, dLbY: lbY });
          } catch (_) { /* fail-soft */ }
        }
      }
    }
  }
  candidates.sort((a, b) => a.dist2 - b.dist2);

  // Evict distant landblocks beyond STREAM_RADIUS_LBS + 2
  for (const [hex, entry] of st.lbGroups.entries()) {
    const d2 = (entry.lbX - centerLbX) ** 2 + (entry.lbY - centerLbY) ** 2;
    if (d2 > (STREAM_RADIUS_LBS + 2) ** 2) {
      entry.status = "evicted";
      if (entry.group) {
        disposeLandblockGroup(st, entry.group);
        entry.group = null;
      }
      st.lbGroups.delete(hex);
    }
  }
  for (const [hex, vfxEntry] of st.vfxNoted.entries()) {
    const d2 = (vfxEntry.lbX - centerLbX) ** 2 + ((vfxEntry.dLbY ?? (vfxEntry.lbY - 359)) - centerLbY) ** 2;
    if (d2 > (STREAM_RADIUS_LBS + 2) ** 2) {
      try { terrainVfxLandblockGone(lbKeyFromXY(vfxEntry.lbX, vfxEntry.lbY), "evict"); } catch (_) {}
      st.vfxNoted.delete(hex);
    }
  }

  for (const c of candidates) {
    if (!st.lbGroups.has(c.hex)) {
      st.lbGroups.set(c.hex, { lbX: c.lbX, lbY: c.lbY, status: "queued", group: null });
      st.fetchQueue.push(c);
    }
  }
  pumpFetchQueue(st);

  // Update root visibility after any distant-LB eviction
  const stillHasActive = st.root.children.length > 0 && st.lbGroups.size > 0;
  if (st.root.visible !== stillHasActive) {
    st.root.visible = stillHasActive;
  }
}

export { buildLandblockGroup, disposeLandblockGroup };

export function __resetDericostWorldForTest() {
  if (_state) {
    for (const [, entry] of _state.lbGroups.entries()) {
      if (entry.group) disposeLandblockGroup(_state, entry.group);
    }
    _state.lbGroups.clear();
    disposeDericostGpuAssets(_state);
    try { _state.root.clear(); } catch (_) {}
    _state = null;
  }
}
