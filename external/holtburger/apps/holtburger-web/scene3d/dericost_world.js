// scene3d/dericost_world.js — 3D environmental scenery (unique flora, trees, ferns, rocks)
// and 41-town architectural building + door framework renderer for the continent of Dericost.
//
// Streams per-landblock JSONL records from:
//   - ../../dist/dericost/scenery/0xXXXX.scenery.jsonl
//   - ../../dist/dericost/buildings/0xXXXX.buildings.jsonl
// when the camera or aircraft is over Dericost (AC y >= 67,500 m).
//
// Every flora model (0x02100001..0x0210001D) uses GPU instanced vertex wind sway
// (deformation.windSwayGpu, MECH-B) and tree crowns apply 0.65 radial canopy normal
// softening (canopy_soften.js).

import * as THREE from "three";
import { softenCanopyNormals, canopySoftenStrength } from "./canopy_soften.js";
import { isTreeDid } from "./tree_wind.js";
import { windSwayGpu } from "./vfx/components/windSwayGpu.js";
import { worldGroundHeight, loadWorldData, DERICOST_Y_MIN, DERICOST_Y_MAX } from "./world_terrain.js";

const VFX_GLOBALS = { uTime: { value: 0 } };

const LB_M = 192.0;
const STREAM_RADIUS_LBS = 3; // 7x7 landblocks around camera (1.34 km x 1.34 km)
const MAX_CONCURRENT_FETCHES = 8;

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

// Scenery & Flora model descriptors ( distinguishes building 0x0110xxxx from rock 0x0110xxxx by context )
const SCENERY_SPECS = {
  // Rung 1: Monoliths & Obelisks
  "0x01100002": { kind: "obsidian_spire", r: 2.0, h: 18.0 },
  "0x01100012": { kind: "obsidian_spire", r: 1.25, h: 10.0 },
  "0x01100015": { kind: "imperial_obelisk", r: 1.5, h: 16.0 },
  // Rung 2: Rocks
  "0x01100001": { kind: "basalt_column", r: 1.2, h: 8.0 },
  "0x01100011": { kind: "basalt_cluster", r: 3.5, h: 14.0 },
  "0x01100003": { kind: "granite_crag", r: 2.5, h: 3.2 },
  "0x01100004": { kind: "sandstone_rib", r: 2.8, h: 6.5 },
  "0x01100014": { kind: "desert_hoodoo", r: 1.8, h: 9.0 },
  "0x01100018": { kind: "sulfur_geyser", r: 1.8, h: 2.2 },
  "0x01100019": { kind: "petrified_timber", r: 1.0, h: 1.8 },
  // Rung 3: Boulders & Runestones
  "0x01100005": { kind: "runic_stone", r: 0.9, h: 3.5 },
  "0x01100013": { kind: "granite_boulder", r: 2.2, h: 4.4 },
  // Rung 4: Clutter & Vents
  "0x01100006": { kind: "scree_patch", r: 1.0, h: 0.35 },
  "0x01100017": { kind: "sulfur_geyser", r: 1.5, h: 1.2 },
  "0x0110001B": { kind: "sulfur_crust", r: 1.0, h: 0.25 },
  "0x0110001C": { kind: "bone_shards", r: 0.8, h: 0.35 },
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
  "0x02100012": { kind: "lichen_mat", r: 1.2, h: 0.35, sway: false, soften: false },
  "0x02100013": { kind: "obsidian_thornbush", r: 1.2, h: 1.6, sway: true, soften: false },
  "0x02100014": { kind: "rift_moss", r: 1.4, h: 2.5, sway: true, soften: true },
  "0x02100016": { kind: "deadwood_snag", r: 1.5, h: 7.0, sway: false, soften: false },
  "0x02100017": { kind: "alpine_thistle", r: 0.8, h: 0.9, sway: true, soften: false },
  "0x02100019": { kind: "spore_mushroom", r: 1.2, h: 3.6, sway: false, soften: true },
  "0x0210001A": { kind: "mire_pitcher", r: 0.8, h: 1.1, sway: true, soften: false },
  "0x0210001B": { kind: "joshua_yucca", r: 1.2, h: 4.5, sway: true, soften: false },
  "0x0210001C": { kind: "red_scrub", r: 1.0, h: 0.8, sway: true, soften: false },
  "0x0210001D": { kind: "cordgrass", r: 1.1, h: 1.6, sway: true, soften: false },
};

// Deterministic hash for procedural textures & geometry perturbation
function hash2(x, y, seed = 1) {
  let h = Math.imul(x ^ seed, 374761393) + Math.imul(y ^ (seed * 17), 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function fbm2(u, v, scale, octaves, seed) {
  let val = 0;
  let amp = 0.5;
  let freq = scale;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const gx = u * freq;
    const gy = v * freq;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const p = Math.round(freq);
    const n00 = hash2(((x0 % p) + p) % p, ((y0 % p) + p) % p, seed + o * 31);
    const n10 = hash2((((x0 + 1) % p) + p) % p, ((y0 % p) + p) % p, seed + o * 31);
    const n01 = hash2(((x0 % p) + p) % p, (((y0 + 1) % p) + p) % p, seed + o * 31);
    const n11 = hash2((((x0 + 1) % p) + p) % p, (((y0 + 1) % p) + p) % p, seed + o * 31);
    const nx0 = n00 + (n10 - n00) * sx;
    const nx1 = n01 + (n11 - n01) * sx;
    val += (nx0 + (nx1 - nx0) * sy) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return val / norm;
}

function makeProceduralTexture(kind) {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const n = fbm2(u, v, 8, 4, kind.length * 97);
      const detail = fbm2(u, v, 24, 2, kind.charCodeAt(0) * 53);
      let r = 128, g = 128, b = 128;

      if (kind === "basalt_block") {
        // Dark volcanic basalt ashlar blocks with cold mineral mortar
        const row = Math.floor(v * 8);
        const by = (v * 8) - row;
        const bx = ((u * 4) + (row & 1) * 0.5) % 1.0;
        const mortar = (by < 0.07 || bx < 0.05) ? 0.65 : 1.0;
        const base = 36 + n * 34 + (detail - 0.5) * 18;
        r = base * 0.92 * mortar;
        g = base * 0.96 * mortar;
        b = (base * 1.08 + 6) * mortar;
      } else if (kind === "obsidian_facet") {
        // Glossy black-violet obsidian with crystalline veins
        const vein = Math.pow(Math.abs(Math.sin((u * 6 + n * 2.5) * Math.PI)), 12);
        const base = 22 + n * 24;
        r = base + vein * 45;
        g = base + vein * 65;
        b = base + 12 + vein * 95;
      } else if (kind === "granite_ashlar") {
        // Cyclopean grey-brown granite blocks
        const row = Math.floor(v * 6);
        const by = (v * 6) - row;
        const bx = ((u * 3) + (row & 1) * 0.5) % 1.0;
        const mortar = (by < 0.08 || bx < 0.06) ? 0.58 : 1.0;
        const base = 82 + n * 48 + (detail - 0.5) * 26;
        r = base * 0.96 * mortar;
        g = base * 0.95 * mortar;
        b = base * 0.92 * mortar;
      } else if (kind === "ironwood_bark") {
        // Vertical dark ironwood bark ridges
        const streak = fbm2(u * 4, v * 0.5, 8, 3, 701);
        const base = 42 + streak * 38 + (detail - 0.5) * 16;
        r = base * 1.12;
        g = base * 0.88;
        b = base * 0.76;
      } else if (kind === "slate_roof") {
        // Scalloped volcanic roof shingles
        const row = Math.floor(v * 10);
        const sy = (v * 10) - row;
        const sx = ((u * 8) + (row & 1) * 0.5) % 1.0;
        const edge = (sy < 0.12 || sx < 0.06) ? 0.62 : (0.85 + 0.15 * sy);
        const base = 48 + n * 30;
        r = base * 0.90 * edge;
        g = base * 0.96 * edge;
        b = (base * 1.08) * edge;
      } else if (kind === "adobe_wall") {
        // Warm golden-terracotta sun-baked adobe & sandstone strata
        const strata = Math.sin((v * 12 + n * 1.5) * Math.PI) * 0.12;
        const base = 168 + (n - 0.5) * 42 + strata * 30 + (detail - 0.5) * 18;
        r = base * 1.12;
        g = base * 0.88;
        b = base * 0.62;
      } else if (kind === "limestone_wall") {
        // Dressed ivory-grey maritime limestone ashlar
        const row = Math.floor(v * 8);
        const by = (v * 8) - row;
        const bx = ((u * 4) + (row & 1) * 0.5) % 1.0;
        const mortar = (by < 0.06 || bx < 0.05) ? 0.72 : 1.0;
        const base = 156 + (n - 0.5) * 38 + (detail - 0.5) * 16;
        r = base * 1.02 * mortar;
        g = base * 0.99 * mortar;
        b = base * 0.92 * mortar;
      } else if (kind === "frost_needles") {
        // Deep boreal pine needles with silver-white frost tips
        const frost = Math.max(0, (detail + n * 0.5) - 0.78) * 3.2;
        r = Math.min(245, 34 + n * 35 + frost * 170);
        g = Math.min(250, 68 + n * 48 + frost * 165);
        b = Math.min(255, 76 + n * 52 + frost * 175);
      } else if (kind === "cedar_foliage") {
        // Rich dark emerald & olive-green Dericost cedar/cypress foliage
        r = 32 + n * 38 + detail * 16;
        g = 66 + n * 56 + detail * 24;
        b = 34 + n * 32 + detail * 12;
      } else if (kind === "willow_foliage") {
        // Mossy bog-willow & marsh canopy
        r = 46 + n * 44 + detail * 18;
        g = 78 + n * 52 + detail * 22;
        b = 40 + n * 30 + detail * 12;
      } else if (kind === "ghost_fern") {
        // Translucent pale ice-silver & cyan ghost-fern frond
        const vein = Math.exp(-Math.pow((u - 0.5) * 6, 2)) * 45;
        r = 120 + n * 65 + vein;
        g = 158 + n * 65 + vein;
        b = 172 + n * 68 + vein;
      } else if (kind === "sulfur_fern") {
        // Vibrant chartreuse-gold & emerald sulfur-fern frond
        const vein = Math.exp(-Math.pow((u - 0.5) * 6, 2)) * 50;
        r = 112 + n * 75 + vein;
        g = 152 + n * 72 + vein * 0.9;
        b = 34 + n * 36;
      } else if (kind === "desert_flora") {
        // Olive-sage desert ironwood / blood-thorn cactus
        const thorn = detail > 0.82 ? 75 : 0;
        r = 72 + n * 48 + thorn;
        g = 94 + n * 46 - thorn * 0.3;
        b = 48 + n * 28 - thorn * 0.3;
      } else if (kind === "runic_door") {
        // Heavy iron-bound door with carved vertical planks & runic studs
        const plank = Math.abs(Math.sin(u * 6 * Math.PI)) < 0.08 ? 0.55 : 1.0;
        const band = (Math.abs(v - 0.22) < 0.05 || Math.abs(v - 0.78) < 0.05 || u < 0.08 || u > 0.92);
        const rune = (Math.hypot(u - 0.5, (v - 0.5) * 1.4) > 0.14 && Math.hypot(u - 0.5, (v - 0.5) * 1.4) < 0.21);
        if (rune) {
          r = 95; g = 185; b = 225;
        } else if (band) {
          const m = 44 + detail * 28;
          r = m; g = m + 4; b = m + 10;
        } else {
          const w = (58 + n * 32) * plank;
          r = w * 1.15; g = w * 0.85; b = w * 0.65;
        }
      }

      const idx = (y * size + x) * 4;
      data[idx] = Math.max(0, Math.min(255, Math.round(r)));
      data[idx + 1] = Math.max(0, Math.min(255, Math.round(g)));
      data[idx + 2] = Math.max(0, Math.min(255, Math.round(b)));
      data[idx + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
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

// Build material library with optional GPU TreeSway vertex injection
function createMaterials() {
  const tex = {
    basalt: makeProceduralTexture("basalt_block"),
    obsidian: makeProceduralTexture("obsidian_facet"),
    granite: makeProceduralTexture("granite_ashlar"),
    bark: makeProceduralTexture("ironwood_bark"),
    slate: makeProceduralTexture("slate_roof"),
    adobe: makeProceduralTexture("adobe_wall"),
    limestone: makeProceduralTexture("limestone_wall"),
    frostNeedles: makeProceduralTexture("frost_needles"),
    cedarFoliage: makeProceduralTexture("cedar_foliage"),
    willowFoliage: makeProceduralTexture("willow_foliage"),
    ghostFern: makeProceduralTexture("ghost_fern"),
    sulfurFern: makeProceduralTexture("sulfur_fern"),
    desertFlora: makeProceduralTexture("desert_flora"),
    runicDoor: makeProceduralTexture("runic_door"),
  };

  function makeSwayMat(map, opts = {}) {
    const mat = new THREE.MeshStandardMaterial({
      map,
      roughness: opts.roughness ?? 0.85,
      metalness: opts.metalness ?? 0.05,
      side: opts.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
      emissive: opts.emissive ? new THREE.Color(opts.emissive) : new THREE.Color(0x000000),
      emissiveIntensity: opts.emissiveIntensity ?? 0.0,
    });
    if (opts.sway) {
      mat.onBeforeCompile = (shader) => {
        windSwayGpu.declareUniforms(shader, opts.swayCfg || null, VFX_GLOBALS);
        windSwayGpu.inject(shader);
      };
      mat.customProgramCacheKey = () => `dericost-sway-${opts.key || "default"}`;
    }
    return mat;
  }

  return {
    basalt: makeSwayMat(tex.basalt, { roughness: 0.82, metalness: 0.12 }),
    obsidian: makeSwayMat(tex.obsidian, { roughness: 0.32, metalness: 0.35 }),
    granite: makeSwayMat(tex.granite, { roughness: 0.88, metalness: 0.05 }),
    bark: makeSwayMat(tex.bark, { roughness: 0.92, metalness: 0.02 }),
    barkSway: makeSwayMat(tex.bark, { roughness: 0.92, metalness: 0.02, sway: true, key: "bark" }),
    slate: makeSwayMat(tex.slate, { roughness: 0.75, metalness: 0.1 }),
    adobe: makeSwayMat(tex.adobe, { roughness: 0.92, metalness: 0.02 }),
    limestone: makeSwayMat(tex.limestone, { roughness: 0.84, metalness: 0.05 }),
    frostNeedles: makeSwayMat(tex.frostNeedles, { roughness: 0.78, doubleSided: true, sway: true, key: "frost" }),
    cedarFoliage: makeSwayMat(tex.cedarFoliage, { roughness: 0.82, doubleSided: true, sway: true, key: "cedar" }),
    willowFoliage: makeSwayMat(tex.willowFoliage, { roughness: 0.84, doubleSided: true, sway: true, key: "willow" }),
    ghostFern: makeSwayMat(tex.ghostFern, {
      roughness: 0.65,
      doubleSided: true,
      sway: true,
      key: "gfern",
      emissive: 0x1a3848,
      emissiveIntensity: 0.25,
    }),
    sulfurFern: makeSwayMat(tex.sulfurFern, {
      roughness: 0.72,
      doubleSided: true,
      sway: true,
      key: "sfern",
      emissive: 0x2e3b08,
      emissiveIntensity: 0.22,
    }),
    desertFlora: makeSwayMat(tex.desertFlora, { roughness: 0.86, doubleSided: true, sway: true, key: "dflora" }),
    runicDoor: makeSwayMat(tex.runicDoor, {
      roughness: 0.55,
      metalness: 0.4,
      emissive: 0x0b2838,
      emissiveIntensity: 0.35,
    }),
    soulfire: new THREE.MeshStandardMaterial({
      color: 0x55e6ff,
      emissive: 0x22b8ff,
      emissiveIntensity: 1.35,
      roughness: 0.2,
    }),
    hearthfire: new THREE.MeshStandardMaterial({
      color: 0xffaa33,
      emissive: 0xff6611,
      emissiveIntensity: 1.25,
      roughness: 0.3,
    }),
  };
}

// Build template mesh parts [{ geometry, material }] for each scenery DID
function buildSceneryTemplate(did, mats) {
  const spec = SCENERY_SPECS[did] || { kind: "granite_crag", r: 2.0, h: 3.0 };
  const k = spec.kind;
  const h = spec.h;
  const r = spec.r;

  if (k === "ironwood_pine" || k === "mountain_cypress" || k === "maritime_pine") {
    const trunk = new MeshBuilder();
    trunk.addTaperedCylinder(0, 0, -0.5, h * 0.75, r * 0.16, r * 0.04, 7, false, 0.15, 0.12, 11);
    // Root flares
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
      { geometry: trunk.toGeometry(), material: mats.barkSway },
      { geometry: crown.toGeometry({ soften: true }), material: folMat },
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
      { geometry: trunk.toGeometry(), material: mats.barkSway },
      { geometry: crown.toGeometry({ soften: true }), material: folMat },
    ];
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
    return [{ geometry: fb.toGeometry(), material: mat }];
  }

  if (k === "blood_cactus" || k === "joshua_yucca") {
    const cb = new MeshBuilder();
    cb.addTaperedCylinder(0, 0, -0.2, h, r * 0.38, r * 0.26, 8, true, 0, 0.08, 301);
    cb.addTaperedCylinder(r * 0.48, 0, h * 0.38, h * 0.78, r * 0.24, r * 0.18, 6, true, 0, 0.08, 302);
    cb.addTaperedCylinder(-r * 0.44, 0, h * 0.48, h * 0.85, r * 0.22, r * 0.16, 6, true, 0, 0.08, 303);
    return [{ geometry: cb.toGeometry(), material: mats.desertFlora }];
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
    return [{ geometry: sb.toGeometry({ soften: !!spec.soften }), material: mat }];
  }

  if (k === "spore_mushroom") {
    const stipe = new MeshBuilder();
    stipe.addTaperedCylinder(0, 0, -0.2, h * 0.78, r * 0.28, r * 0.18, 7, false);
    const cap = new MeshBuilder();
    cap.addTaperedCylinder(0, 0, h * 0.68, h, r * 1.1, r * 0.15, 9, true);
    return [
      { geometry: stipe.toGeometry(), material: mats.limestone },
      { geometry: cap.toGeometry({ soften: true }), material: mats.ghostFern },
    ];
  }

  if (k === "obsidian_spire") {
    const mb = new MeshBuilder();
    mb.addTaperedCylinder(0, 0, -1.0, h, r * 0.85, r * 0.06, 6, true, 0.2, 0.25, 401);
    mb.addTaperedCylinder(r * 0.45, r * 0.2, -0.8, h * 0.58, r * 0.48, r * 0.05, 6, true, -0.15, 0.2, 402);
    mb.addTaperedCylinder(-r * 0.4, -r * 0.25, -0.8, h * 0.46, r * 0.42, r * 0.05, 6, true, 0.1, 0.2, 403);
    return [{ geometry: mb.toGeometry(), material: mats.obsidian }];
  }

  if (k === "imperial_obelisk" || k === "runic_stone") {
    const mb = new MeshBuilder();
    mb.addBox(-r * 0.85, -r * 0.85, -1.0, r * 0.85, r * 0.85, h * 0.14, 0.3);
    mb.addTaperedCylinder(0, 0, h * 0.12, h * 0.86, r * 0.55, r * 0.34, 4, false, Math.PI * 0.25, 0.0, 501);
    mb.addTaperedCylinder(0, 0, h * 0.86, h, r * 0.34, 0.01, 4, false, Math.PI * 0.25, 0.0, 502);
    return [{ geometry: mb.toGeometry(), material: k === "imperial_obelisk" ? mats.obsidian : mats.basalt }];
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
    return [{ geometry: mb.toGeometry(), material: mats.basalt }];
  }

  if (k === "desert_hoodoo" || k === "sandstone_rib") {
    const mb = new MeshBuilder();
    mb.addTaperedCylinder(0, 0, -1.0, h * 0.45, r * 0.95, r * 0.62, 7, false, 0.1, 0.22, 701);
    mb.addTaperedCylinder(0, 0, h * 0.42, h * 0.78, r * 0.58, r * 0.82, 7, false, -0.1, 0.22, 702);
    mb.addTaperedCylinder(0, 0, h * 0.75, h, r * 0.84, r * 0.35, 7, true, 0.15, 0.22, 703);
    return [{ geometry: mb.toGeometry(), material: mats.adobe }];
  }

  // Default: granite_crag / boulder / sulfur_geyser / scree
  const mb = new MeshBuilder();
  mb.addTaperedCylinder(0, 0, -0.6, h * 0.65, r, r * 0.72, 7, false, 0.2, 0.32, 801);
  mb.addTaperedCylinder(0, 0, h * 0.62, h, r * 0.72, r * 0.18, 7, true, -0.2, 0.32, 802);
  return [{ geometry: mb.toGeometry(), material: mats.granite }];
}

// Build architectural 3D meshes [{ geometry, material }] for each of the 18 building blueprints
function buildBuildingTemplate(did, mats) {
  const spec = BUILDING_SPECS[did];
  if (!spec) return [];
  const { style, w, d, h, portalY, portalZ, pw, ph } = spec;
  const hw = w * 0.5;
  const hd = d * 0.5;

  const wallB = new MeshBuilder();
  const trimB = new MeshBuilder();
  const roofB = new MeshBuilder();
  const glowB = new MeshBuilder();

  let wallMat = mats.basalt;
  let trimMat = mats.obsidian;
  let roofMat = mats.slate;
  let glowMat = mats.soulfire;

  if (style.startsWith("ashatiri") || style === "marsh_stilted") {
    wallMat = mats.granite;
    trimMat = mats.bark;
    roofMat = mats.slate;
    glowMat = mats.hearthfire;
  } else if (style.startsWith("desert")) {
    wallMat = mats.adobe;
    trimMat = mats.granite;
    roofMat = mats.adobe;
    glowMat = mats.hearthfire;
  } else if (style.startsWith("civic")) {
    wallMat = mats.limestone;
    trimMat = mats.basalt;
    roofMat = mats.slate;
    glowMat = mats.soulfire;
  }

  // 1. Foundation plinth (extends 7.5m below ground so hillside/dune terrain never shows a gap)
  if (style === "marsh_stilted") {
    // Stilted Fen-Manor: heavy ironwood pilings supporting a raised platform at z = 3.0m
    for (let ix = -hw + 2; ix <= hw - 2; ix += 6) {
      for (let iy = -hd + 2; iy <= hd - 2; iy += 5.5) {
        trimB.addTaperedCylinder(ix, iy, -6.5, 3.1, 0.45, 0.38, 6, false);
      }
    }
    trimB.addBox(-hw - 0.8, -hd - 0.8, 2.6, hw + 0.8, hd + 0.8, 3.1, 0.25, false);
    // Stair ramp leading up to the elevated entrance portal at y = -hd
    for (let st = 0; st < 8; st++) {
      const sz = (st / 8) * 3.0;
      const sy0 = -hd - 5.2 + st * 0.6;
      trimB.addBox(-pw * 1.1, sy0, -4.5, pw * 1.1, sy0 + 0.65, sz + 0.35, 0.3);
    }
  } else {
    wallB.addBox(-hw - 0.9, -hd - 0.9, -7.5, hw + 0.9, hd + 0.9, 0.45, 0.2);
    // Entrance steps in front of portal
    trimB.addBox(-pw * 1.35, portalY - 2.2, -4.5, pw * 1.35, portalY + 0.2, 0.25, 0.3);
    trimB.addBox(-pw * 1.15, portalY - 1.4, 0.25, pw * 1.15, portalY + 0.2, 0.48, 0.3);
  }

  const baseZ = portalZ;
  const wallTopZ = baseZ + h * 0.68;

  // 2. Main building body with framed portal recess at (0, portalY, baseZ)
  // Left & Right front wall wings around portal opening
  wallB.addBox(-hw, -hd, baseZ, -pw * 0.55, hd, wallTopZ, 0.18);
  wallB.addBox(pw * 0.55, -hd, baseZ, hw, hd, wallTopZ, 0.18);
  // Center hall behind portal and lintel above portal (partitioned with zero overlap)
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

  // Perimeter pilasters / buttresses along X and Y walls (stopping at cornice base)
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
    // Central stepped necrotic tower + 4 corner obsidian spires
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
    // Stone chimney & ridge dormer
    wallB.addBox(hw * 0.45, -2.0, roofBaseZ, hw * 0.45 + 2.2, 2.0, baseZ + h + 2.4, 0.25);
  } else if (style === "desert_citadel" || style === "desert_caravanserai" || style === "desert_ziggurat") {
    // Battered corner towers + crenellated parapet + central solar dome/ziggurat
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
    // Tall fortified watchtower with overhanging machicolated crown and beacon
    const towerTop = baseZ + h * 0.88;
    wallB.addBox(-hw * 0.82, -hd * 0.82, corniceTopZ, hw * 0.82, hd * 0.82, towerTop, 0.18);
    trimB.addBox(-hw * 0.95, -hd * 0.95, towerTop - 0.6, hw * 0.95, hd * 0.95, towerTop + 1.2, 0.25);
    roofB.addTaperedCylinder(0, 0, towerTop + 1.22, baseZ + h * 1.08, hw * 0.85, 0.15, 8, true);
    glowB.addTaperedCylinder(0, 0, towerTop + 0.8, towerTop + 2.2, 1.2, 0.3, 6, true);
  } else {
    // Civic Praetorium / Garrison / Pavilion
    roofB.addGableRoof(-hw, -hd, hw, hd, roofBaseZ, baseZ + h, 1.0);
    // Front colonnade columns
    for (let cx = -hw + 3; cx <= hw - 3; cx += 4.5) {
      if (Math.abs(cx) > pw * 0.75) {
        trimB.addTaperedCylinder(cx, -hd - 1.4, baseZ, corniceBotZ, 0.48, 0.42, 8, false);
      }
    }
    trimB.addBox(-hw - 0.4, -hd - 2.0, corniceBotZ, hw + 0.4, -hd - 0.66, corniceTopZ, 0.25);
  }

  return [
    { geometry: wallB.toGeometry(), material: wallMat },
    { geometry: trimB.toGeometry(), material: trimMat },
    { geometry: roofB.toGeometry(), material: roofMat },
    { geometry: glowB.toGeometry(), material: glowMat },
  ];
}

// Build 3D Door mesh template
function buildDoorTemplate(mats) {
  const db = new MeshBuilder();
  // Double-leaf recessed runic door panel (width 2.0m, height 2.6m, thickness 0.28m)
  db.addBox(-1.0, -0.18, 0.0, -0.03, 0.18, 2.55, 0.5, false);
  db.addBox(0.03, -0.18, 0.0, 1.0, 0.18, 2.55, 0.5, false);
  return [{ geometry: db.toGeometry(), material: mats.runicDoor }];
}

let _state = null;

export function initDericostWorld(scene3d, { parent = null } = {}) {
  if (_state) return _state;
  const root = new THREE.Group();
  root.name = "dericost-world-props";
  (parent ?? scene3d.terrainGroup?.parent ?? scene3d.scene).add(root);

  // Dedicated Dericost directional sun + sky hemisphere fill (in AC Z-up space under worldRoot)
  const sunLight = new THREE.DirectionalLight(0xfff4e0, 2.2);
  sunLight.position.set(-4000, -3000, 8000);
  sunLight.target.position.set(0, 0, 0);
  root.add(sunLight);
  root.add(sunLight.target);

  const hemiLight = new THREE.HemisphereLight(0xdce8ff, 0x4a5244, 1.15);
  hemiLight.position.set(0, 0, 1000);
  root.add(hemiLight);

  const mats = createMaterials();
  const sceneryTemplates = new Map();
  const buildingTemplates = new Map();
  const doorTemplate = buildDoorTemplate(mats);

  _state = {
    root,
    mats,
    sceneryTemplates,
    buildingTemplates,
    doorTemplate,
    lbGroups: new Map(), // lbHex -> { status, group, lastTouchMs }
    fetchQueue: [],
    activeFetches: 0,
    lastCenterKey: null,
    lastError: null,
  };

  if (typeof window !== "undefined") {
    window.__dericostWorld = () => ({
      loadedLandblocks: _state.lbGroups.size,
      builtLandblocks: Math.max(0, _state.root.children.length - 3),
      activeFetches: _state.activeFetches,
      queuedFetches: _state.fetchQueue.length,
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

function hash32(x) {
  let h = Math.imul((x | 0) ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function augmentProvinceFlora(lbX, lbY, sceneryRecs, buildingRecs) {
  if (!sceneryRecs || sceneryRecs.length === 0) return sceneryRecs;
  const wy0 = DERICOST_Y_MIN + lbY * LB_M;
  const wx0 = lbX * LB_M;

  let treeDid = "0x02100001"; // Gelid Ironwood Pine
  let secTreeDid = "0x02100008"; // Ashatiri Mountain Cypress
  let fernDid = "0x02100003"; // Gelid Ghost-Fern
  let rockDid = "0x01100001"; // Basalt Column

  if (wy0 >= 100000) {
    treeDid = "0x02100001";
    secTreeDid = "0x02100016";
    fernDid = "0x02100003";
    rockDid = "0x01100015"; // Imperial Obelisk
  } else if (wy0 >= 88000 && wx0 >= 21000) {
    treeDid = "0x02100002"; // Tresimaen Ash-Cedar
    secTreeDid = "0x02100001";
    fernDid = "0x02100004"; // Tresimaen Sulfur-Fern
    rockDid = "0x01100002"; // Obsidian Spire
  } else if (wy0 >= 88000 && wx0 < 21000) {
    treeDid = "0x02100008"; // Ashatiri Mountain Cypress
    secTreeDid = "0x02100002";
    fernDid = "0x02100015"; // Ashatiri Creeping Fern
    rockDid = "0x01100005"; // Runic Standing Stone
  } else if (wy0 >= 75500 && wx0 < 23000) {
    treeDid = "0x02100007"; // Daralet Bog-Willow
    secTreeDid = "0x02100019"; // Giant Spore-Mushroom
    fernDid = "0x02100018"; // Marsh Ghost-Cane
    rockDid = "0x01100005";
  } else if (wy0 >= 75500 && wx0 >= 23000) {
    treeDid = "0x02100005"; // High Desert Ironwood
    secTreeDid = "0x02100006"; // Blood-Thorn Cactus
    fernDid = "0x0210001B"; // Desert Joshua-Yucca
    rockDid = "0x01100014"; // Desert Hoodoo
  } else {
    treeDid = "0x02100009"; // Nesortania Maritime Pine
    secTreeDid = "0x02100008";
    fernDid = "0x02100010"; // Coastal Salt-Fern
    rockDid = "0x01100003";
  }

  const bldgs = (buildingRecs || []).filter((b) => b && b.is_building);
  const avoidsBuilding = (lx, ly, pad) => {
    for (const b of bldgs) {
      if (Math.abs(lx - Number(b.x)) < pad && Math.abs(ly - Number(b.y)) < pad) return true;
    }
    return false;
  };
  const out = sceneryRecs.filter((r) => !avoidsBuilding(Number(r.x), Number(r.y), 18));

  const baseSeed = ((lbX * 73856093) ^ (lbY * 19349663)) >>> 0;
  for (let i = 0; i < 44; i++) {
    const h1 = hash32(baseSeed + i * 31 + 1);
    const h2 = hash32(baseSeed + i * 31 + 2);
    const h3 = hash32(baseSeed + i * 31 + 3);
    const lx = 10 + (h1 % 1720) * 0.1;
    const ly = 10 + (h2 % 1720) * 0.1;
    const isTreeSlot = i < 22;
    const isMonolithSlot = i >= 40;
    const pad = isTreeSlot || isMonolithSlot ? 24 : 16;
    if (avoidsBuilding(lx, ly, pad)) continue;

    let did = fernDid;
    let sc = 0.85 + ((h3 & 0xff) / 255) * 0.55;
    if (isTreeSlot) {
      did = (i % 3 === 0) ? secTreeDid : treeDid;
      sc = 0.82 + ((h3 & 0xff) / 255) * 0.48;
    } else if (isMonolithSlot) {
      did = rockDid;
      sc = 0.85 + ((h3 & 0xff) / 255) * 0.45;
    }
    const yaw = (((h3 >>> 8) & 0xffff) / 65535) * Math.PI * 2;
    out.push({
      obj_id: did,
      x: lx,
      y: ly,
      z: Number(sceneryRecs[0]?.z) || 50,
      qw: Math.cos(yaw * 0.5),
      qx: 0,
      qy: 0,
      qz: Math.sin(yaw * 0.5),
      scale: sc,
    });
  }
  return out;
}

function buildLandblockGroup(st, lbX, lbY, rawSceneryRecs, buildingRecs) {
  const group = new THREE.Group();
  const hex = (((lbX << 8) | lbY) >>> 0).toString(16).toUpperCase().padStart(4, "0");
  group.name = `dericost-lb-0x${hex}`;
  const wx0 = lbX * LB_M;
  const wy0 = DERICOST_Y_MIN + lbY * LB_M;
  const sceneryRecs = augmentProvinceFlora(lbX, lbY, rawSceneryRecs, buildingRecs);

  // 1. Group scenery records by obj_id and build InstancedMeshes
  const byDid = new Map();
  for (const rec of sceneryRecs) {
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

  for (const [did, recs] of byDid.entries()) {
    const parts = getSceneryTemplate(st, did);
    const count = recs.length;
    if (!count || !parts.length) continue;

    for (let p = 0; p < parts.length; p++) {
      const { geometry, material } = parts[p];
      const im = new THREE.InstancedMesh(geometry, material, count);
      im.frustumCulled = false;
      im.castShadow = false;
      im.receiveShadow = false;

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
      }
      im.instanceMatrix.needsUpdate = true;
      group.add(im);
    }
  }

  // 2. Build town buildings & doors
  for (const rec of buildingRecs) {
    const wx = wx0 + (Number(rec.x) || 0);
    const wy = wy0 + (Number(rec.y) || 0);
    const gh = worldGroundHeight(wx, wy);
    const baseGroundZ = Number.isFinite(gh) && gh > 0.05 ? gh : (Number(rec.z) || 0);

    if (rec.is_building) {
      const did = String(rec.obj_id || "");
      const parts = getBuildingTemplate(st, did);
      if (!parts.length) continue;
      const bGroup = new THREE.Group();
      bGroup.position.set(wx, wy, baseGroundZ);
      bGroup.quaternion.set(Number(rec.qx) || 0, Number(rec.qy) || 0, Number(rec.qz) || 0, Number(rec.qw) ?? 1);
      for (const { geometry, material } of parts) {
        const m = new THREE.Mesh(geometry, material);
        m.castShadow = false;
        m.receiveShadow = false;
        bGroup.add(m);
      }
      group.add(bGroup);
    } else if (rec.is_door) {
      const dGroup = new THREE.Group();
      // Preserve elevated door offset (e.g. +3m on Stilted_Fen_Manor)
      const zOffset = (Number(rec.z) || 0) > baseGroundZ + 1.5 ? 3.0 : 0.0;
      dGroup.position.set(wx, wy, baseGroundZ + zOffset);
      dGroup.quaternion.set(Number(rec.qx) || 0, Number(rec.qy) || 0, Number(rec.qz) || 0, Number(rec.qw) ?? 1);
      for (const { geometry, material } of st.doorTemplate) {
        const m = new THREE.Mesh(geometry, material);
        m.castShadow = false;
        m.receiveShadow = false;
        dGroup.add(m);
      }
      group.add(dGroup);
    }
  }

  return group;
}

function pumpFetchQueue(st) {
  while (st.activeFetches < MAX_CONCURRENT_FETCHES && st.fetchQueue.length > 0) {
    const job = st.fetchQueue.shift();
    const entry = st.lbGroups.get(job.hex);
    if (!entry || entry.status !== "queued") continue;
    entry.status = "loading";
    st.activeFetches += 1;

    Promise.all([
      loadWorldData().catch(() => null),
      fetchJsonl(`../../dist/dericost/scenery/0x${job.hex}.scenery.jsonl`),
      fetchJsonl(`../../dist/dericost/buildings/0x${job.hex}.buildings.jsonl`),
    ]).then(([, sceneryRecs, buildingRecs]) => {
      const cur = st.lbGroups.get(job.hex);
      if (!cur || cur.status === "evicted") return;
      const grp = buildLandblockGroup(st, job.lbX, job.lbY, sceneryRecs, buildingRecs);
      cur.group = grp;
      cur.status = "ready";
      st.root.add(grp);
    }).catch((err) => {
      st.lastError = String(err?.message || err);
    }).finally(() => {
      st.activeFetches = Math.max(0, st.activeFetches - 1);
      pumpFetchQueue(st);
    });
  }
}

export function tickDericostWorld(scene3d, camera, nowMs = 0) {
  const st = _state || initDericostWorld(scene3d);
  if (!st || !camera) return;

  // Advance shared VFX wind clock so TreeSway animates even when Dereth oscillators are idle
  if (VFX_GLOBALS && VFX_GLOBALS.uTime && nowMs > 0) {
    VFX_GLOBALS.uTime.value = (nowMs * 0.001) % 3600;
  }

  const cp = camera.getWorldPosition ? camera.getWorldPosition(st._cp || (st._cp = new THREE.Vector3())) : camera.position;
  const ax = cp.x;
  const ay = -cp.z;
  const az = cp.y;

  // Only stream Dericost props when camera is near or over Dericost (Y >= 67,000 m) and below 2,800 m altitude
  if (ay < 67000.0 || ay > DERICOST_Y_MAX + 2000.0 || az > 2800.0) {
    st.root.visible = ay >= 67000.0;
    return;
  }
  st.root.visible = true;

  const centerLbX = Math.max(0, Math.min(254, Math.floor(ax / LB_M)));
  const centerLbY = Math.max(0, Math.min(254, Math.floor((ay - DERICOST_Y_MIN) / LB_M)));
  const centerKey = `${centerLbX}_${centerLbY}`;
  if (centerKey === st.lastCenterKey && st.fetchQueue.length === 0) return;
  st.lastCenterKey = centerKey;

  const wanted = new Set();
  const candidates = [];
  for (let dy = -STREAM_RADIUS_LBS; dy <= STREAM_RADIUS_LBS; dy++) {
    for (let dx = -STREAM_RADIUS_LBS; dx <= STREAM_RADIUS_LBS; dx++) {
      const lbX = centerLbX + dx;
      const lbY = centerLbY + dy;
      if (lbX < 0 || lbX > 254 || lbY < 0 || lbY > 254) continue;
      const hex = (((lbX << 8) | lbY) >>> 0).toString(16).toUpperCase().padStart(4, "0");
      wanted.add(hex);
      candidates.push({ lbX, lbY, hex, dist2: dx * dx + dy * dy });
    }
  }
  candidates.sort((a, b) => a.dist2 - b.dist2);

  // Evict distant landblocks beyond STREAM_RADIUS_LBS + 2
  for (const [hex, entry] of st.lbGroups.entries()) {
    const d2 = (entry.lbX - centerLbX) ** 2 + (entry.lbY - centerLbY) ** 2;
    if (d2 > (STREAM_RADIUS_LBS + 2) ** 2) {
      entry.status = "evicted";
      if (entry.group) st.root.remove(entry.group);
      st.lbGroups.delete(hex);
    }
  }

  for (const c of candidates) {
    if (!st.lbGroups.has(c.hex)) {
      st.lbGroups.set(c.hex, { lbX: c.lbX, lbY: c.lbY, status: "queued", group: null });
      st.fetchQueue.push(c);
    }
  }
  pumpFetchQueue(st);
}
