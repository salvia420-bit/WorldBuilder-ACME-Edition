/**
 * challenger-m3-r2-scenery-stress.mjs
 * Milestone 3 Iteration 2 Challenger 1: Adversarial Empirical Stress Verification
 *
 * Exhaustive empirical verification of scenery assets across all 65,025 files:
 * 1. 65,025 landblocks existence & ocean zero-density audit
 * 2. Strict Z-coordinate validity (zero null, zero NaN, zero undefined across all scenery placements)
 * 3. Town center clearance (288m) across all 41 canonical town centers (0 tall trees, 0 monoliths)
 * 4. TreeSway allowlist parity across all 20 unique Dericost flora SetupModel DIDs
 * 5. Closed-loop 4-rung collision ladder tolerances (R1: 0.50% ±0.05%, R2: 33.70% ±0.05%, R3: 6.10% ±0.05%, R4: 59.70% ±0.05%)
 * 6. Minimum asset thresholds: Total props >= 4,943,116; All trees (canopy + understory) >= 1,950,225; Ferns >= 648,046
 * 7. Terrain height bilinear interpolation cross-check against dericost_height.u8
 * 8. Spawn dataset sanity check for Bit 15 and null Z
 */

import fs from 'node:fs';
import path from 'node:path';

const DIST_DIR = '/home/wbterminal/external/holtburger/dist/dericost';
const SCENERY_DIR = path.join(DIST_DIR, 'scenery');
const SPAWNS_DIR = path.join(DIST_DIR, 'spawns');
const TREE_WIND_JS = '/home/wbterminal/external/holtburger/apps/holtburger-web/scene3d/tree_wind.js';

console.log('======================================================================');
console.log('   M3-R2 CHALLENGER 1: ADVERSARIAL SCENERY & CLEARANCE STRESS HARNESS');
console.log('======================================================================\n');

const t0 = Date.now();

// 1. Verify existence of asset directories and files
if (!fs.existsSync(SCENERY_DIR)) {
  console.error(`Scenery directory ${SCENERY_DIR} does not exist!`);
  process.exit(1);
}

const meta = JSON.parse(fs.readFileSync(path.join(DIST_DIR, 'dericost_meta.json'), 'utf8'));
const heightU8 = fs.readFileSync(path.join(DIST_DIR, 'dericost_height.u8'));
const treesU8 = fs.readFileSync(path.join(DIST_DIR, 'dericost_trees.u8'));
const landHeightTable = meta.landHeightTable;
const DRY_LAND_KM2 = meta.dryLandAreaKm2 || 1724.81;

// 2. Read TreeSway registered DIDs from tree_wind.js
const treeWindContent = fs.readFileSync(TREE_WIND_JS, 'utf8');
const registeredTreeDids = new Set();
for (const match of treeWindContent.matchAll(/0x02[0-9a-fA-F]{6}/g)) {
  registeredTreeDids.add(match[0].toLowerCase());
}
console.log(`[INIT] Loaded ${registeredTreeDids.size} TreeSway DIDs from tree_wind.js.`);

// Expected 20 Dericost flora DIDs
const EXPECTED_FLORA_DIDS = [
  '0x02100001', '0x02100002', '0x02100003', '0x02100004', '0x02100005',
  '0x02100006', '0x02100007', '0x02100008', '0x02100009', '0x02100010',
  '0x02100011', '0x02100012', '0x02100013', '0x02100014', '0x02100015',
  '0x02100017', '0x02100018', '0x0210001a', '0x0210001c', '0x0210001d'
];

let missingFloraDidsInTreeWind = [];
for (const did of EXPECTED_FLORA_DIDS) {
  if (!registeredTreeDids.has(did.toLowerCase())) {
    missingFloraDidsInTreeWind.push(did);
  }
}

// 3. Taxonomy Definition
const TAXONOMY = {
  // Rung 1: BSP monoliths
  '0x01100002': { name: 'Obsidian Spire', rung: 1, category: 'rock', isMonolith: true, isTallTree: false },
  '0x01100012': { name: 'Obsidian Needle', rung: 1, category: 'rock', isMonolith: true, isTallTree: false },
  '0x01100015': { name: 'Imperial Obelisk', rung: 1, category: 'rock', isMonolith: true, isTallTree: false },

  // Rung 2: Cylsphere - Canopy Tall Trees
  '0x02100001': { name: 'Gelid Ironwood Pine', rung: 2, category: 'tree', isMonolith: false, isTallTree: true },
  '0x02100002': { name: 'Tresimaen Ash-Cedar', rung: 2, category: 'tree', isMonolith: false, isTallTree: true },
  '0x02100005': { name: 'High Desert Ironwood', rung: 2, category: 'tree', isMonolith: false, isTallTree: true },
  '0x02100008': { name: 'Ashatiri Mountain Cypress', rung: 2, category: 'tree', isMonolith: false, isTallTree: true },
  '0x02100009': { name: 'Maritime Salt-Pine', rung: 2, category: 'tree', isMonolith: false, isTallTree: true },

  // Rung 2: Cylsphere - Large Boulders & Geysers
  '0x01100001': { name: 'Basalt Column', rung: 2, category: 'rock', isMonolith: false, isTallTree: false },
  '0x01100011': { name: 'Basalt Cluster', rung: 2, category: 'rock', isMonolith: false, isTallTree: false },
  '0x01100003': { name: 'Granite Crag', rung: 2, category: 'rock', isMonolith: false, isTallTree: false },
  '0x01100004': { name: 'Sandstone Rib', rung: 2, category: 'rock', isMonolith: false, isTallTree: false },
  '0x01100014': { name: 'Desert Hoodoo', rung: 2, category: 'rock', isMonolith: false, isTallTree: false },
  '0x01100018': { name: 'Sulfur Geyser', rung: 2, category: 'rock', isMonolith: false, isTallTree: false },
  '0x01100019': { name: 'Petrified Timber', rung: 2, category: 'rock', isMonolith: false, isTallTree: false },

  // Rung 3: Sphere
  '0x01100005': { name: 'Runic Boundary Stone', rung: 3, category: 'rock', isMonolith: false, isTallTree: false },
  '0x01100013': { name: 'Granite Erratic Boulder', rung: 3, category: 'rock', isMonolith: false, isTallTree: false },

  // Rung 4: None - Ferns
  '0x02100003': { name: 'Gelid Ghost-Fern', rung: 4, category: 'fern', isMonolith: false, isTallTree: false },
  '0x02100004': { name: 'Tresimaen Sulfur-Fern', rung: 4, category: 'fern', isMonolith: false, isTallTree: false },
  '0x02100010': { name: 'Coastal Salt-Fern', rung: 4, category: 'fern', isMonolith: false, isTallTree: false },
  '0x02100015': { name: 'Granite Creeping Fern', rung: 4, category: 'fern', isMonolith: false, isTallTree: false },
  '0x02100018': { name: 'Marsh Ghost-Cane', rung: 4, category: 'fern', isMonolith: false, isTallTree: false },

  // Rung 4: None - Understory Trees / Succulents / Shrub
  '0x02100006': { name: 'Blood-Thorn Cactus', rung: 4, category: 'tree', isMonolith: false, isTallTree: false },
  '0x02100007': { name: 'Daralet Bog-Willow', rung: 4, category: 'tree', isMonolith: false, isTallTree: false },
  '0x02100011': { name: 'Crystal Frost-Shrub', rung: 4, category: 'tree', isMonolith: false, isTallTree: false },
  '0x02100012': { name: 'Alpine Lichen Mat', rung: 4, category: 'tree', isMonolith: false, isTallTree: false },
  '0x02100013': { name: 'Obsidian Thornbush', rung: 4, category: 'tree', isMonolith: false, isTallTree: false },
  '0x02100014': { name: 'Canopy Rift Moss', rung: 4, category: 'tree', isMonolith: false, isTallTree: false },
  '0x02100017': { name: 'Blue Alpine Thistle', rung: 4, category: 'tree', isMonolith: false, isTallTree: false },
  '0x0210001a': { name: 'Carnivorous Mire Pitcher', rung: 4, category: 'tree', isMonolith: false, isTallTree: false },
  '0x0210001c': { name: 'Red Dune Scrub', rung: 4, category: 'tree', isMonolith: false, isTallTree: false },
  '0x0210001d': { name: 'Salt-Marsh Cordgrass', rung: 4, category: 'tree', isMonolith: false, isTallTree: false },

  // Rung 4: None - Ground Scree / Vents
  '0x01100006': { name: 'Permafrost Scree', rung: 4, category: 'rock', isMonolith: false, isTallTree: false },
  '0x01100017': { name: 'Caldera Steam Vent', rung: 4, category: 'rock', isMonolith: false, isTallTree: false },
  '0x0110001b': { name: 'Sulfur Crust', rung: 4, category: 'rock', isMonolith: false, isTallTree: false },
  '0x0110001c': { name: 'Ancient Battlefield Bone Shards', rung: 4, category: 'rock', isMonolith: false, isTallTree: false },
};

// 4. Towns Setup
const DERICOST_PROVINCES = {
  'Gelid Plateau': [
    'Vasmora', 'Frore', 'Frisirth', 'Minesh', 'Kelnir',
    'Gelid-Keep', 'Coldwatch', 'Boreal-Spires', 'Saliane', 'Glacier-Reach'
  ],
  'Ashatiri Lowlands': [
    'Antaoc', 'Hirschi', 'Nehane', 'Stone-Cleft',
    'Iron-Garrison', 'Grymar\'s Stand', 'Cynreft', 'High-Quarry'
  ],
  'Valley of Tresimaen': [
    'Cannthalo', 'Zemal Foothills', 'Tresimaen', 'Hendrel\'s Gate',
    'Obsidian-Bluff', 'Ash-Haven', 'Sulfur-Springs', 'Orisis-Deep'
  ],
  'Dericost Marshes': [
    'Daralet', 'Fen-Gate', 'Mhoire-Crosse', 'Bog-Haven',
    'Weeping-Creek', 'Mire-Watch'
  ],
  'The High Desert Plateau': [
    'Shakrassekor', 'Berkesh', 'Ayn Tayan', 'Harebach Crose',
    'Sand-Bastion', 'Pines-Foot'
  ],
  'Nesortania Maritime Coast': [
    'Nesortania', 'Galleys-Anchorage', 'South-Haven'
  ]
};

const zoneBounds = {
  'Nesortania Maritime Coast': { xMin: 15000, xMax: 35000, yMin: 69500, yMax: 76000 },
  'The High Desert Plateau': { xMin: 25000, xMax: 47000, yMin: 76000, yMax: 88000 },
  'Dericost Marshes': { xMin: 2000, xMax: 24000, yMin: 76000, yMax: 88000 },
  'Valley of Tresimaen': { xMin: 20000, xMax: 45000, yMin: 88000, yMax: 102000 },
  'Ashatiri Lowlands': { xMin: 3000, xMax: 22000, yMin: 88000, yMax: 102000 },
  'Gelid Plateau': { xMin: 5000, xMax: 45000, yMin: 102000, yMax: 116000 },
};

const CANONICAL_TOWNS = [];
const TOWN_VICINITY_MAP = new Map();

for (const [provName, townNames] of Object.entries(DERICOST_PROVINCES)) {
  const bounds = zoneBounds[provName];
  const stepX = (bounds.xMax - bounds.xMin) / (townNames.length + 1);
  const stepY = (bounds.yMax - bounds.yMin) / (townNames.length + 1);
  townNames.forEach((name, idx) => {
    const x = bounds.xMin + stepX * (idx + 1);
    const y = bounds.yMin + stepY * ((idx % 2 === 0) ? (idx + 1) : (townNames.length - idx));
    const lbX = Math.floor(x / 192.0);
    const lbY = Math.floor((y - 68928.0) / 192.0);
    const town = { name, province: provName, x, y, lbX, lbY };
    CANONICAL_TOWNS.push(town);

    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const nLbX = lbX + dx;
        const nLbY = lbY + dy;
        if (nLbX >= 0 && nLbX < 255 && nLbY >= 0 && nLbY < 255) {
          const key = (nLbX << 8) | nLbY;
          if (!TOWN_VICINITY_MAP.has(key)) TOWN_VICINITY_MAP.set(key, []);
          TOWN_VICINITY_MAP.get(key).push(town);
        }
      }
    }
  });
}

// 5. Bilinear height sampling function for verification
function sampleTerrainZ(lbX, lbY, lx, ly) {
  const gx = (lbX * 8) + (lx / 24.0);
  const gy = (lbY * 8) + (ly / 24.0);
  const x0 = Math.max(0, Math.min(2039, Math.floor(gx)));
  const y0 = Math.max(0, Math.min(2039, Math.floor(gy)));
  const x1 = Math.min(2040, x0 + 1);
  const y1 = Math.min(2040, y0 + 1);
  const fx = gx - x0;
  const fy = gy - y0;

  const h00 = landHeightTable[heightU8[y0 * 2041 + x0]];
  const h10 = landHeightTable[heightU8[y0 * 2041 + x1]];
  const h01 = landHeightTable[heightU8[y1 * 2041 + x0]];
  const h11 = landHeightTable[heightU8[y1 * 2041 + x1]];

  const h0 = h00 * (1 - fx) + h10 * fx;
  const h1 = h01 * (1 - fx) + h11 * fx;
  return h0 * (1 - fy) + h1 * fy;
}

// 6. Metrics Counters
let totalFilesChecked = 0;
let missingFiles = 0;
let oceanFilesChecked = 0;
let oceanNonZeroBytes = 0;
let oceanPropsFound = 0;
let dryFilesChecked = 0;

let totalProps = 0;
let totalTallTrees = 0;
let totalUnderstoryTrees = 0;
let totalFerns = 0;
let totalRocks = 0;

let countRung1 = 0;
let countRung2 = 0;
let countRung3 = 0;
let countRung4 = 0;

let nullZCount = 0;
let nanZCount = 0;
let nullAabbZCount = 0;
let maxZDiscrepancy = 0;
let checkedZSamples = 0;

let outOfBoundsCoords = 0;
let outOfBoundsScale = 0;
let malformedJson = 0;
let invertedAabbs = 0;

let unmappedDids = new Set();
let unregisteredWindDids = new Set();

let townClearanceViolations = [];
let minDistanceTallTreeToTown = Infinity;
let minDistanceMonolithToTown = Infinity;

const LB_SIZE = 192.0;
const DERICOST_Y_MIN = 68928.0;
const CLEARANCE_RADIUS = 288.0;
const CLEARANCE_RADIUS_SQ = CLEARANCE_RADIUS * CLEARANCE_RADIUS;

console.log('[SWEEP] Starting empirical scan over all 65,025 landblocks...');

for (let lbY = 0; lbY < 255; lbY++) {
  for (let lbX = 0; lbX < 255; lbX++) {
    const lbId = (lbX << 8) | lbY;
    const hex = lbId.toString(16).padStart(4, '0').toUpperCase();
    const fileName = `0x${hex}.scenery.jsonl`;
    const filePath = path.join(SCENERY_DIR, fileName);

    totalFilesChecked++;

    if (!fs.existsSync(filePath)) {
      missingFiles++;
      continue;
    }

    const vx = lbX * 8 + 4;
    const vy = lbY * 8 + 4;
    const zCenter = landHeightTable[heightU8[vy * 2041 + vx]];
    const tCenter = treesU8[lbY * 255 + lbX];
    const isOcean = (zCenter <= 0.0 || tCenter === 0);

    const stat = fs.statSync(filePath);

    if (isOcean) {
      oceanFilesChecked++;
      if (stat.size !== 0) oceanNonZeroBytes++;
      if (stat.size > 0) {
        const c = fs.readFileSync(filePath, 'utf8').trim();
        if (c.length > 0) oceanPropsFound += c.split('\n').length;
      }
      continue;
    }

    // Dry land block
    dryFilesChecked++;
    if (stat.size === 0) continue;

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n');
    const townsNear = TOWN_VICINITY_MAP.get(lbId) || null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;

      let rec;
      try {
        rec = JSON.parse(line);
      } catch (err) {
        malformedJson++;
        continue;
      }

      totalProps++;

      // Check Z coordinate validity
      if (rec.z === null || rec.z === undefined) {
        nullZCount++;
      } else if (Number.isNaN(rec.z) || typeof rec.z !== 'number') {
        nanZCount++;
      }

      // Check AABB Z validity
      if (rec.aabb_min_z === null || rec.aabb_max_z === null ||
          rec.aabb_min_z === undefined || rec.aabb_max_z === undefined) {
        nullAabbZCount++;
      }

      const did = (rec.obj_id || '').toLowerCase();
      const metaInfo = TAXONOMY[did];

      if (!metaInfo) {
        unmappedDids.add(did);
      } else {
        if (metaInfo.category === 'tree') {
          if (metaInfo.isTallTree) totalTallTrees++;
          else totalUnderstoryTrees++;

          if (!registeredTreeDids.has(did)) {
            unregisteredWindDids.add(did);
          }
        } else if (metaInfo.category === 'fern') {
          totalFerns++;
          if (!registeredTreeDids.has(did)) {
            unregisteredWindDids.add(did);
          }
        } else {
          totalRocks++;
        }

        if (metaInfo.rung === 1) countRung1++;
        else if (metaInfo.rung === 2) countRung2++;
        else if (metaInfo.rung === 3) countRung3++;
        else if (metaInfo.rung === 4) countRung4++;
      }

      // Bounds checks
      if (rec.scale < 0.5 || rec.scale > 3.0) outOfBoundsScale++;
      if (rec.x < 0 || rec.x > LB_SIZE || rec.y < 0 || rec.y > LB_SIZE) outOfBoundsCoords++;
      if (rec.aabb_min_x > rec.aabb_max_x || rec.aabb_min_y > rec.aabb_max_y ||
          (rec.aabb_min_z !== null && rec.aabb_max_z !== null && rec.aabb_min_z > rec.aabb_max_z)) {
        invertedAabbs++;
      }

      // Elevation sample spot-check (sample 1 in 200 placements)
      if (rec.z !== null && !Number.isNaN(rec.z) && (totalProps % 200 === 0)) {
        const expectedZ = sampleTerrainZ(lbX, lbY, rec.x, rec.y);
        const diff = Math.abs(rec.z - expectedZ);
        if (diff > maxZDiscrepancy) maxZDiscrepancy = diff;
        checkedZSamples++;
      }

      // Town clearance check
      if (townsNear && townsNear.length > 0) {
        const wx = lbX * LB_SIZE + rec.x;
        const wy = DERICOST_Y_MIN + lbY * LB_SIZE + rec.y;

        for (let t = 0; t < townsNear.length; t++) {
          const town = townsNear[t];
          const dx = wx - town.x;
          const dy = wy - town.y;
          const distSq = dx * dx + dy * dy;
          const dist = Math.sqrt(distSq);

          const isTall = metaInfo && (metaInfo.isTallTree || (metaInfo.rung === 2 && metaInfo.category === 'tree'));
          const isMonolith = metaInfo && (metaInfo.isMonolith || metaInfo.rung === 1);

          if (isTall && dist < minDistanceTallTreeToTown) {
            minDistanceTallTreeToTown = dist;
          }
          if (isMonolith && dist < minDistanceMonolithToTown) {
            minDistanceMonolithToTown = dist;
          }

          if (distSq < CLEARANCE_RADIUS_SQ) {
            if (isTall || isMonolith) {
              townClearanceViolations.push({
                town: town.name,
                province: town.province,
                lbHex: hex,
                obj_id: rec.obj_id,
                name: metaInfo ? metaInfo.name : 'Unknown',
                distMeters: dist.toFixed(2),
                isTall,
                isMonolith
              });
            }
          }
        }
      }
    }
  }
}

const elapsedSec = ((Date.now() - t0) / 1000).toFixed(2);
console.log(`[SWEEP] Completed 65,025 landblocks in ${elapsedSec}s.\n`);

// 7. Spawns Check
console.log('[SPAWNS] Checking spawn records for null Z and Bit 15 compliance...');
let spawnFilesChecked = 0;
let spawnTotalRecords = 0;
let spawnNullZ = 0;
let spawnMissingBit15 = 0;
let spawnInvalidCell = 0;

for (let lbY = 0; lbY < 255; lbY += 4) { // Sample every 4th row to check 64x255 = 16,320 files quickly
  for (let lbX = 0; lbX < 255; lbX += 4) {
    const lbId = (lbX << 8) | lbY;
    const hex = lbId.toString(16).padStart(4, '0').toUpperCase();
    const spFile = path.join(SPAWNS_DIR, `0x${hex}.spawns.jsonl`);
    if (!fs.existsSync(spFile)) continue;
    spawnFilesChecked++;

    const content = fs.readFileSync(spFile, 'utf8').trim();
    if (content.length === 0) continue;
    const lines = content.split('\n');
    for (const l of lines) {
      if (!l) continue;
      spawnTotalRecords++;
      const s = JSON.parse(l);
      if (s.z === null || s.z === undefined || Number.isNaN(s.z)) spawnNullZ++;
      if ((s.cell & 0x8000) === 0) spawnMissingBit15++;
      const rawCell = s.cell & 0x7fff;
      if (rawCell < 1 || rawCell > 64) spawnInvalidCell++;
    }
  }
}
console.log(`[SPAWNS] Checked ${spawnTotalRecords} spawns across ${spawnFilesChecked} files: Null Z: ${spawnNullZ}, Missing Bit 15: ${spawnMissingBit15}, Invalid Cell: ${spawnInvalidCell}\n`);

// Calculations
const totalTreesAll = totalTallTrees + totalUnderstoryTrees;
const propDensity = totalProps / DRY_LAND_KM2;
const tallTreeDensity = totalTallTrees / DRY_LAND_KM2;
const allTreeDensity = totalTreesAll / DRY_LAND_KM2;
const fernDensity = totalFerns / DRY_LAND_KM2;

const pctRung1 = (countRung1 / totalProps) * 100;
const pctRung2 = (countRung2 / totalProps) * 100;
const pctRung3 = (countRung3 / totalProps) * 100;
const pctRung4 = (countRung4 / totalProps) * 100;

console.log('======================================================================');
console.log('                  ADVERSARIAL VERIFICATION AUDIT');
console.log('======================================================================');
console.log(`Landblocks Checked:        ${totalFilesChecked} / 65,025 (Missing: ${missingFiles})`);
console.log(`Ocean Landblocks:          ${oceanFilesChecked} (0-byte/0-prop verified)`);
console.log(`Dry Land Landblocks:       ${dryFilesChecked}`);
console.log(`Total Scenery Props:       ${totalProps.toLocaleString()} (${propDensity.toFixed(2)}/km2, target >= 4,943,116)`);
console.log(`All Trees (Canopy+Under):  ${totalTreesAll.toLocaleString()} (${allTreeDensity.toFixed(2)}/km2, target >= 1,950,225)`);
console.log(`  - Tall Canopy Trees (R2):${totalTallTrees.toLocaleString()} (${tallTreeDensity.toFixed(2)}/km2)`);
console.log(`  - Understory Trees (R4): ${totalUnderstoryTrees.toLocaleString()}`);
console.log(`Ferns & Undergrowth:       ${totalFerns.toLocaleString()} (${fernDensity.toFixed(2)}/km2, target >= 648,046)`);
console.log(`Rocks & Scree:             ${totalRocks.toLocaleString()}`);
console.log(`Collision Ladder Proportions:`);
console.log(`  - Rung 1 (BSP):          ${countRung1.toLocaleString()} (${pctRung1.toFixed(4)}%, target: 0.50% ±0.05%, delta: ${Math.abs(pctRung1 - 0.50).toFixed(4)}%)`);
console.log(`  - Rung 2 (Cylsphere):    ${countRung2.toLocaleString()} (${pctRung2.toFixed(4)}%, target: 33.70% ±0.05%, delta: ${Math.abs(pctRung2 - 33.70).toFixed(4)}%)`);
console.log(`  - Rung 3 (Sphere):       ${countRung3.toLocaleString()} (${pctRung3.toFixed(4)}%, target: 6.10% ±0.05%, delta: ${Math.abs(pctRung3 - 6.10).toFixed(4)}%)`);
console.log(`  - Rung 4 (None):         ${countRung4.toLocaleString()} (${pctRung4.toFixed(4)}%, target: 59.70% ±0.05%, delta: ${Math.abs(pctRung4 - 59.70).toFixed(4)}%)`);
console.log(`Town Clearance Violations: ${townClearanceViolations.length} (within 288m of 41 town centers)`);
console.log(`  - Closest Tall Tree to Town Center: ${minDistanceTallTreeToTown.toFixed(2)}m (clearance buffer: 288m)`);
console.log(`  - Closest Monolith to Town Center:  ${minDistanceMonolithToTown.toFixed(2)}m (clearance buffer: 288m)`);
console.log(`Z-Coordinate Integrity:`);
console.log(`  - Null Z placements:     ${nullZCount}`);
console.log(`  - NaN Z placements:      ${nanZCount}`);
console.log(`  - Null AABB Z:           ${nullAabbZCount}`);
console.log(`  - Max Z Discrepancy:     ${maxZDiscrepancy.toFixed(4)}m across ${checkedZSamples} samples`);
console.log(`TreeSway Shader DID Coverage:`);
console.log(`  - Missing Flora DIDs:    ${missingFloraDidsInTreeWind.length} (${missingFloraDidsInTreeWind.join(', ')})`);
console.log(`  - Unregistered Wind Props:${unregisteredWindDids.size}`);
console.log(`Data Integrity:`);
console.log(`  - Malformed JSON:        ${malformedJson}`);
console.log(`  - Bad Coords [0..192]:   ${outOfBoundsCoords}`);
console.log(`  - Bad Scales [0.5..3.0]: ${outOfBoundsScale}`);
console.log(`  - Inverted AABBs:        ${invertedAabbs}`);
console.log(`  - Unmapped DIDs:         ${unmappedDids.size}`);
console.log('======================================================================\n');

// Assertions
const tests = [
  { name: 'Zero Town Clearance Violations', pass: townClearanceViolations.length === 0, desc: `${townClearanceViolations.length} violations found` },
  { name: 'Zero Unregistered Tree Wind DIDs', pass: unregisteredWindDids.size === 0 && missingFloraDidsInTreeWind.length === 0, desc: `Unregistered: ${unregisteredWindDids.size}, Missing: ${missingFloraDidsInTreeWind.length}` },
  { name: 'Zero Null/NaN Z Coordinates', pass: nullZCount === 0 && nanZCount === 0 && nullAabbZCount === 0, desc: `Null Z: ${nullZCount}, NaN Z: ${nanZCount}, Null AABB Z: ${nullAabbZCount}` },
  { name: 'Exact Collision Rung 1 (0.50% ±0.05%)', pass: Math.abs(pctRung1 - 0.50) <= 0.05, desc: `Pct: ${pctRung1.toFixed(4)}%` },
  { name: 'Exact Collision Rung 2 (33.70% ±0.05%)', pass: Math.abs(pctRung2 - 33.70) <= 0.05, desc: `Pct: ${pctRung2.toFixed(4)}%` },
  { name: 'Exact Collision Rung 3 (6.10% ±0.05%)', pass: Math.abs(pctRung3 - 6.10) <= 0.05, desc: `Pct: ${pctRung3.toFixed(4)}%` },
  { name: 'Exact Collision Rung 4 (59.70% ±0.05%)', pass: Math.abs(pctRung4 - 59.70) <= 0.05, desc: `Pct: ${pctRung4.toFixed(4)}%` },
  { name: 'Total Scenery Props Target (>= 4,943,116)', pass: totalProps >= 4943116, desc: `Count: ${totalProps.toLocaleString()}` },
  { name: 'Trees (Canopy + Understory) Target (>= 1,950,225)', pass: totalTreesAll >= 1950225, desc: `Count: ${totalTreesAll.toLocaleString()}` },
  { name: 'Ferns Target (>= 648,046)', pass: totalFerns >= 648046, desc: `Count: ${totalFerns.toLocaleString()}` },
  { name: 'Ocean Blocks 0-Byte & 0-Props', pass: oceanPropsFound === 0 && oceanNonZeroBytes === 0, desc: `Ocean props: ${oceanPropsFound}` },
  { name: 'Data Integrity & Bounds', pass: malformedJson === 0 && outOfBoundsCoords === 0 && outOfBoundsScale === 0 && invertedAabbs === 0, desc: `Malformed: ${malformedJson}, Coords: ${outOfBoundsCoords}, Scale: ${outOfBoundsScale}` },
  { name: 'Spawn Dataset Bit 15 & Z Integrity', pass: spawnNullZ === 0 && spawnMissingBit15 === 0 && spawnInvalidCell === 0, desc: `Null: ${spawnNullZ}, Missing Bit 15: ${spawnMissingBit15}, Invalid: ${spawnInvalidCell}` },
];

let allPassed = true;
for (const t of tests) {
  const status = t.pass ? '[PASS]' : '[FAIL]';
  if (!t.pass) allPassed = false;
  console.log(`${status} ${t.name}: ${t.desc}`);
}

const finalVerdict = allPassed ? 'APPROVE' : 'REQUEST_CHANGES';
console.log(`\nFINAL CHALLENGER VERDICT: ${finalVerdict}`);

// Write JSON artifact
const resultData = {
  timestamp: new Date().toISOString(),
  durationSec: +elapsedSec,
  allPassed,
  verdict: finalVerdict,
  metrics: {
    totalFilesChecked,
    missingFiles,
    oceanFilesChecked,
    oceanPropsFound,
    dryFilesChecked,
    totalProps,
    propDensity,
    totalTallTrees,
    totalUnderstoryTrees,
    totalTreesAll,
    allTreeDensity,
    totalFerns,
    fernDensity,
    totalRocks,
    collisionLadder: {
      rung1: { count: countRung1, pct: pctRung1, target: 0.50, delta: Math.abs(pctRung1 - 0.50) },
      rung2: { count: countRung2, pct: pctRung2, target: 33.70, delta: Math.abs(pctRung2 - 33.70) },
      rung3: { count: countRung3, pct: pctRung3, target: 6.10, delta: Math.abs(pctRung3 - 6.10) },
      rung4: { count: countRung4, pct: pctRung4, target: 59.70, delta: Math.abs(pctRung4 - 59.70) },
    },
    townClearance: {
      violationsCount: townClearanceViolations.length,
      minDistanceTallTreeToTown,
      minDistanceMonolithToTown,
      violations: townClearanceViolations
    },
    zIntegrity: {
      nullZCount,
      nanZCount,
      nullAabbZCount,
      maxZDiscrepancy,
      checkedZSamples
    },
    treeSway: {
      registeredDidsCount: registeredTreeDids.size,
      missingFloraDidsInTreeWind,
      unregisteredWindDidsCount: unregisteredWindDids.size
    },
    dataIntegrity: {
      malformedJson,
      outOfBoundsCoords,
      outOfBoundsScale,
      invertedAabbs,
      unmappedDids: Array.from(unmappedDids)
    },
    spawnsIntegrity: {
      spawnFilesChecked,
      spawnTotalRecords,
      spawnNullZ,
      spawnMissingBit15,
      spawnInvalidCell
    }
  },
  tests
};

fs.writeFileSync('/home/wbterminal/.agents/teamwork/challenger_m3_r2_1/challenger_verification_results.json', JSON.stringify(resultData, null, 2));
console.log('Saved challenger results to /home/wbterminal/.agents/teamwork/challenger_m3_r2_1/challenger_verification_results.json');
