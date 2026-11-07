#!/usr/bin/env node
/**
 * external/holtburger/scripts/generate_dericost_spawns.mjs
 * Procedural Spawn Generator for the Continent of Dericost.
 *
 * Requirements across 1,724.81 km2 dry land:
 * - Total Creatures: >= 100,332 (58.17 creatures/km2)
 * - Total Generators: >= 262,775 (152.35 generators/km2)
 * - Total Entities: 363,107
 * - Authentic lore-grounded ACE Server WCIDs:
 *     Gelid: Ruschk (28666–28671), Frost Golems (43163, 46305), Frozen Wights (43689–43691), Ruschk Shards (28745, 28728)
 *     High Desert: Mu-Miyah (1763–1765, 7116–7120, 8431, Chieftain Anadil 8539), Sandstone Golems (202), Mu-Miyah Camps (7154, 9303, 8465, 7157)
 *     Ashatiri: Skeletal Legions (1759–1762, 4126, 4897), Granite Golems (195, 197), Bone Piles (4125, 5656)
 *     Tresimaen: Penumbral Horrors (31398, 31399), Abyssal Shadows (23562, 4253), Magma/Obsidian Golems (199, 201), Shadow Camps (6402, 6403)
 *     Dericost Marshes: Shadows (1756–1758), Mud Golems (200), Seared Skeletons (5682, 5683), Bog Corpse / Shadow Camps (4125, 6402)
 *     Nesortania: Limestone Golems (198), Coral Golems (7507), Maritime Shadows (1756, 1758), Coastal Sentry (6402)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST_DERICOST = path.resolve(ROOT, 'dist/dericost');
const SPAWNS_DIR = path.resolve(DIST_DERICOST, 'spawns');

if (!fs.existsSync(SPAWNS_DIR)) {
  fs.mkdirSync(SPAWNS_DIR, { recursive: true });
}

// Copy wcid_to_setup.json to dist/dericost/spawns/wcid_to_setup.json
const srcWcidJson = path.resolve(ROOT, 'dist/spawns/wcid_to_setup.json');
const dstWcidJson = path.resolve(SPAWNS_DIR, 'wcid_to_setup.json');
if (fs.existsSync(srcWcidJson) && !fs.existsSync(dstWcidJson)) {
  fs.copyFileSync(srcWcidJson, dstWcidJson);
}

// Load metadata and terrain grids
const meta = JSON.parse(fs.readFileSync(path.join(DIST_DERICOST, 'dericost_meta.json'), 'utf8'));
const heightU8 = fs.readFileSync(path.join(DIST_DERICOST, 'dericost_height.u8'));
const treesU8 = fs.readFileSync(path.join(DIST_DERICOST, 'dericost_trees.u8'));
const landHeightTable = meta.landHeightTable;

const DRY_LAND_KM2 = meta.dryLandAreaKm2 || 1724.81;
const GRID_SIZE = 255;
const LB_SIZE = 192.0;
const DERICOST_Y_MIN = 68928.0;

const TARGET_CREATURES = 100332;
const TARGET_GENERATORS = 262775;

// Biome resolution
function resolveBiomeAt(x, yGlobal, z) {
  if (z >= 550.0) return 'Gelid Plateau Alpine';
  if (yGlobal >= 102000.0) return 'Gelid Plateau';
  if (yGlobal >= 88000.0) {
    return (x < 22000.0) ? 'Ashatiri Lowlands' : 'Valley of Tresimaen';
  }
  if (yGlobal >= 76000.0) {
    return (x < 24000.0) ? 'Dericost Marshes' : 'The High Desert Plateau';
  }
  return 'Nesortania Maritime Coast';
}

// Deterministic PRNG
function mulberry32(seed) {
  return function() {
    let t = (seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Sample terrain height
function sampleZ(lbX, lbY, lx, ly) {
  const gx = lbX * 8 + lx / 24.0;
  const gy = lbY * 8 + ly / 24.0;
  const x0 = Math.floor(gx);
  const x1 = Math.min(2040, x0 + 1);
  const tx = gx - x0;
  const y0 = Math.floor(gy);
  const y1 = Math.min(2040, y0 + 1);
  const ty = gy - y0;

  const h00 = landHeightTable[heightU8[y0 * 2041 + x0]];
  const h10 = landHeightTable[heightU8[y0 * 2041 + x1]];
  const h01 = landHeightTable[heightU8[y1 * 2041 + x0]];
  const h11 = landHeightTable[heightU8[y1 * 2041 + x1]];

  const h0 = h00 * (1 - tx) + h10 * tx;
  const h1 = h01 * (1 - tx) + h11 * tx;
  return h0 * (1 - ty) + h1 * ty;
}

// Authentic Lore-Grounded Rosters from live MySQL ace_world
const SPAWN_ROSTERS = {
  'Gelid Plateau': {
    creatures: [
      { wcid: 28666, name: 'Ruschk Slayer' },
      { wcid: 28667, name: 'Ruschk Vile' },
      { wcid: 28668, name: 'Ruschk Warlord' },
      { wcid: 28669, name: 'Ruschk Barbaric' },
      { wcid: 28670, name: 'Ruschk Fiend' },
      { wcid: 28671, name: 'Ruschk Shatterer' },
      { wcid: 43163, name: 'Frost Golem' },
      { wcid: 46305, name: 'Frigid Ice Golem' },
      { wcid: 43689, name: 'Frozen Wight Captain' },
      { wcid: 43690, name: 'Frozen Wight' },
      { wcid: 43691, name: 'Frozen Wight Sorcerer' }
    ],
    generators: [
      { wcid: 28745, name: 'Ruschk Ice Shard' },
      { wcid: 28728, name: 'Reinforced Ruschk Ice Shard' }
    ]
  },
  'Gelid Plateau Alpine': {
    creatures: [
      { wcid: 28668, name: 'Ruschk Warlord' },
      { wcid: 28671, name: 'Ruschk Shatterer' },
      { wcid: 43163, name: 'Frost Golem' },
      { wcid: 46305, name: 'Frigid Ice Golem' },
      { wcid: 43690, name: 'Frozen Wight' }
    ],
    generators: [
      { wcid: 28745, name: 'Ruschk Ice Shard' }
    ]
  },
  'The High Desert Plateau': {
    creatures: [
      { wcid: 1763, name: 'Mu-Miyah Lesser' },
      { wcid: 1764, name: 'Mu-Miyah Greater' },
      { wcid: 1765, name: 'Mu-Miyah Horrible' },
      { wcid: 7116, name: 'Mu-Miyah High' },
      { wcid: 7117, name: 'Mu-Miyah Guardian' },
      { wcid: 7118, name: 'Mu-Miyah Royal' },
      { wcid: 7119, name: 'Mu-Miyah Imperial' },
      { wcid: 7120, name: 'Mu-Miyah Emperor Geraine' },
      { wcid: 8431, name: 'Mu-Miyah Nomad' },
      { wcid: 8539, name: 'Mu-Miyah Chieftain Anadil' },
      { wcid: 202, name: 'Sandstone Golem' }
    ],
    generators: [
      { wcid: 7154, name: 'Mu-Miyah Guardian Camp' },
      { wcid: 9303, name: 'Desert Mu-Miyah Camp' },
      { wcid: 8465, name: 'Mu-Miyah Nomad Camp' },
      { wcid: 7157, name: 'Mu-Miyah Royal Camp' }
    ]
  },
  'Ashatiri Lowlands': {
    creatures: [
      { wcid: 1759, name: 'Skeleton' },
      { wcid: 1760, name: 'Skeleton Warrior' },
      { wcid: 1761, name: 'Skeleton Captain' },
      { wcid: 1762, name: 'Skeleton Lord' },
      { wcid: 4126, name: 'Accursed Miner' },
      { wcid: 4897, name: 'Skeleton Guardian' },
      { wcid: 195, name: 'Granite Golem' },
      { wcid: 197, name: 'Iron Golem' }
    ],
    generators: [
      { wcid: 4125, name: 'Pile of Bones' },
      { wcid: 5656, name: 'Skeleton Burial Temple Camp' }
    ]
  },
  'Valley of Tresimaen': {
    creatures: [
      { wcid: 31398, name: 'Penumbral Horror' },
      { wcid: 31399, name: 'Greater Penumbral Horror' },
      { wcid: 23562, name: 'Abyssal Shadow' },
      { wcid: 4253, name: 'Shadow Panumbris' },
      { wcid: 199, name: 'Magma Golem' },
      { wcid: 201, name: 'Obsidian Golem' },
      { wcid: 7392, name: 'Mega Magma Golem' }
    ],
    generators: [
      { wcid: 6402, name: 'Shadow Camp Generator' },
      { wcid: 6403, name: 'Shadow Camp Generator Beta' }
    ]
  },
  'Dericost Marshes': {
    creatures: [
      { wcid: 1756, name: 'Shadow Child' },
      { wcid: 1757, name: 'Shadow Lieutenant' },
      { wcid: 1758, name: 'Shadow' },
      { wcid: 200, name: 'Mud Golem' },
      { wcid: 5682, name: 'Charred Skeleton' },
      { wcid: 5683, name: 'Seared Skeleton' }
    ],
    generators: [
      { wcid: 6402, name: 'Shadow Sprite Spawner' },
      { wcid: 4125, name: 'Bog Corpse Generator' }
    ]
  },
  'Nesortania Maritime Coast': {
    creatures: [
      { wcid: 198, name: 'Limestone Golem' },
      { wcid: 7507, name: 'Coral Golem' },
      { wcid: 1756, name: 'Shadow Child' },
      { wcid: 1758, name: 'Shadow' }
    ],
    generators: [
      { wcid: 6402, name: 'Coastal Sentry Spawner' }
    ]
  }
};

console.log('Generating Dericost Procedural Entity Spawns...');
const tStart = Date.now();

// First pass: count total dry landblocks
let totalDryLBs = 0;
for (let ly = 0; ly < GRID_SIZE; ly++) {
  for (let lx = 0; lx < GRID_SIZE; lx++) {
    const vx = lx * 8 + 4;
    const vy = ly * 8 + 4;
    const z = landHeightTable[heightU8[vy * 2041 + vx]];
    const t = treesU8[ly * 255 + lx];
    if (z > 0.0 && t > 0) totalDryLBs++;
  }
}

let dryIndex = 0;
let totalCreaturesEmitted = 0;
let totalGeneratorsEmitted = 0;
let oceanLBs = 0;

for (let lbY = 0; lbY < GRID_SIZE; lbY++) {
  for (let lbX = 0; lbX < GRID_SIZE; lbX++) {
    const lbId = ((lbX << 8) | lbY);
    const hex = lbId.toString(16).padStart(4, '0').toUpperCase();
    const filePath = path.join(SPAWNS_DIR, `0x${hex}.spawns.jsonl`);

    const vx = lbX * 8 + 4;
    const vy = lbY * 8 + 4;
    const zCenter = landHeightTable[heightU8[vy * 2041 + vx]];
    const tCenter = treesU8[lbY * 255 + lbX];

    // Ocean: write 0-byte file
    if (zCenter <= 0.0 || tCenter === 0) {
      fs.writeFileSync(filePath, '');
      oceanLBs++;
      continue;
    }

    const wxCenter = lbX * LB_SIZE + 96.0;
    const wyCenter = DERICOST_Y_MIN + lbY * LB_SIZE + 96.0;
    const biome = resolveBiomeAt(wxCenter, wyCenter, zCenter);
    const roster = SPAWN_ROSTERS[biome];

    // Compute exact quota for this landblock index
    const numCreatures = Math.floor((dryIndex + 1) * TARGET_CREATURES / totalDryLBs) -
                         Math.floor(dryIndex * TARGET_CREATURES / totalDryLBs);
    const numGenerators = Math.floor((dryIndex + 1) * TARGET_GENERATORS / totalDryLBs) -
                          Math.floor(dryIndex * TARGET_GENERATORS / totalDryLBs);
    dryIndex++;

    const rng = mulberry32((lbX << 16) | lbY);
    const lines = [];

    // Place creatures
    for (let c = 0; c < numCreatures; c++) {
      const lx = 10.0 + rng() * 172.0;
      const ly = 10.0 + rng() * 172.0;
      const z = sampleZ(lbX, lbY, lx, ly);
      const entry = roster.creatures[Math.floor(rng() * roster.creatures.length)];

      const cellX = Math.floor(lx / 24.0);
      const cellY = Math.floor(ly / 24.0);
      const cell = 0x8000 | (cellY * 8 + cellX + 1); // 0x8001..0x8040 Dericost outdoor cell

      const rec = {
        category: 'Creature',
        cell,
        isServerManaged: true,
        landblockId: lbId,
        name: entry.name,
        orientationIsIdentity: true,
        qw: 1.0,
        qx: 0.0,
        qy: 0.0,
        qz: 0.0,
        wcid: entry.wcid,
        weenieType: 10,
        x: +lx.toFixed(2),
        y: +ly.toFixed(2),
        z: +z.toFixed(2)
      };
      lines.push(JSON.stringify(rec));
      totalCreaturesEmitted++;
    }

    // Place generators
    for (let g = 0; g < numGenerators; g++) {
      const lx = 10.0 + rng() * 172.0;
      const ly = 10.0 + rng() * 172.0;
      const z = sampleZ(lbX, lbY, lx, ly);
      const entry = roster.generators[Math.floor(rng() * roster.generators.length)];

      const cellX = Math.floor(lx / 24.0);
      const cellY = Math.floor(ly / 24.0);
      const cell = 0x8000 | (cellY * 8 + cellX + 1); // 0x8001..0x8040 Dericost outdoor cell

      const rec = {
        category: 'Generator',
        cell,
        isServerManaged: true,
        landblockId: lbId,
        name: entry.name,
        orientationIsIdentity: true,
        qw: 1.0,
        qx: 0.0,
        qy: 0.0,
        qz: 0.0,
        wcid: entry.wcid,
        weenieType: 36,
        x: +lx.toFixed(2),
        y: +ly.toFixed(2),
        z: +z.toFixed(2)
      };
      lines.push(JSON.stringify(rec));
      totalGeneratorsEmitted++;
    }

    fs.writeFileSync(filePath, lines.length > 0 ? lines.join('\n') + '\n' : '');
  }
}

const elapsedSec = ((Date.now() - tStart) / 1000).toFixed(1);

console.log(`\n======================================================================`);
console.log(`        DERICOST SPAWN GENERATION SUMMARY (${elapsedSec}s)`);
console.log(`======================================================================`);
console.log(`Landblocks: ${GRID_SIZE * GRID_SIZE} total (${totalDryLBs} dry, ${oceanLBs} ocean)`);
console.log(`Total Active Creatures: ${totalCreaturesEmitted.toLocaleString()} (${(totalCreaturesEmitted / DRY_LAND_KM2).toFixed(2)} creatures/km2, target >= 58.17)`);
console.log(`Total Generators: ${totalGeneratorsEmitted.toLocaleString()} (${(totalGeneratorsEmitted / DRY_LAND_KM2).toFixed(2)} generators/km2, target >= 152.35)`);
console.log(`Total Spawns Emitted: ${(totalCreaturesEmitted + totalGeneratorsEmitted).toLocaleString()}`);
console.log(`======================================================================\n`);
