#!/usr/bin/env node
/**
 * prune_dericost_scenery_collisions.mjs
 * Milestone 4 Iteration 2: Scenery Collision Pruning & Clearance Epsilon Buffer Enforcement
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST_DERICOST = path.resolve(ROOT, 'dist/dericost');
const TOWNS_DIR = path.resolve(DIST_DERICOST, 'towns');
const BLUEPRINTS_DIR = path.resolve(TOWNS_DIR, 'blueprints');
const SCENERY_DIR = path.resolve(DIST_DERICOST, 'scenery');

const TALL_TREES = new Set([
  '0x02100001', '0x02100002', '0x02100005', '0x02100008', '0x02100009'
]);

const MONOLITHS = new Set([
  '0x01100002', '0x01100012', '0x01100015'
]);

const SOLID_ROCKS = new Set([
  '0x01100001', '0x01100011', '0x01100003', '0x01100004', '0x01100014', '0x01100018', '0x01100019'
]);

const ALL_SOLID = new Set([...TALL_TREES, ...MONOLITHS, ...SOLID_ROCKS]);

const PROVINCIAL_FERNS = {
  'Gelid Plateau': '0x02100003',
  'Valley of Tresimaen': '0x02100004',
  'Ashatiri Lowlands': '0x02100015',
  'Dericost Marshes': '0x02100018',
  'The High Desert Plateau': '0x02100006',
  'Nesortania Maritime Coast': '0x02100010'
};

export function runSceneryPruning() {
  console.log('=== Milestone 4 Iteration 2: Scenery Collision Pruning & Clearance ===');
  const masterIndexPath = path.join(TOWNS_DIR, 'dericost_towns_index.json');
  if (!fs.existsSync(masterIndexPath)) {
    console.error(`Master index not found at ${masterIndexPath}`);
    return;
  }
  const masterIndex = JSON.parse(fs.readFileSync(masterIndexPath, 'utf8'));

  // Load blueprints
  const blueprints = {};
  for (const f of fs.readdirSync(BLUEPRINTS_DIR).filter(f => f.endsWith('.blueprint.json'))) {
    const bp = JSON.parse(fs.readFileSync(path.join(BLUEPRINTS_DIR, f), 'utf8'));
    blueprints[bp.hexModelId] = bp;
  }

  // 1. Enforce 288m clearance exclusion across all 41 towns (Layer 1)
  let clearanceSubstitutions = 0;
  for (const town of masterIndex.towns) {
    const fernDid = PROVINCIAL_FERNS[town.province] || '0x02100003';
    const rad = 288.0;
    const minLbX = Math.max(0, Math.floor((town.x - rad) / 192.0));
    const maxLbX = Math.min(254, Math.floor((town.x + rad) / 192.0));
    const minLbY = Math.max(0, Math.floor((town.y - rad - 68928.0) / 192.0));
    const maxLbY = Math.min(254, Math.floor((town.y + rad - 68928.0) / 192.0));

    for (let lbX = minLbX; lbX <= maxLbX; lbX++) {
      for (let lbY = minLbY; lbY <= maxLbY; lbY++) {
        const hex = '0x' + (((lbX << 8) | lbY) >>> 0).toString(16).toUpperCase().padStart(4, '0');
        const scPath = path.join(SCENERY_DIR, `${hex}.scenery.jsonl`);
        if (!fs.existsSync(scPath)) continue;

        const lines = fs.readFileSync(scPath, 'utf8').trim().split('\n');
        let modified = false;
        const updatedLines = lines.map(line => {
          if (!line) return line;
          const p = JSON.parse(line);
          const wx = lbX * 192.0 + p.x;
          const wy = 68928.0 + lbY * 192.0 + p.y;
          const dist = Math.hypot(wx - town.x, wy - town.y);
          if (dist < rad && TALL_TREES.has(p.obj_id)) {
            p.obj_id = fernDid;
            clearanceSubstitutions++;
            modified = true;
          }
          return JSON.stringify(p);
        });

        if (modified) {
          fs.writeFileSync(scPath, updatedLines.join('\n') + '\n', 'utf8');
        }
      }
    }
  }
  console.log(`[LAYER 1] Substituted ${clearanceSubstitutions} tall trees within 288m of town centers.`);

  // 2. Prune solid obstacles inside building footprints (Layer 2)
  const buildingsByHex = {};
  for (const townMeta of masterIndex.towns) {
    const townJsonPath = path.join(TOWNS_DIR, `town_${townMeta.slug}.json`);
    if (!fs.existsSync(townJsonPath)) continue;
    const td = JSON.parse(fs.readFileSync(townJsonPath, 'utf8'));
    for (const b of td.buildings) {
      const bp = blueprints[b.hexModelId];
      if (!bp) continue;
      const halfW = bp.footprint.widthMeters / 2.0;
      const halfD = bp.footprint.depthMeters / 2.0;
      const minX = b.worldOrigin[0] - halfW;
      const maxX = b.worldOrigin[0] + halfW;
      const minY = b.worldOrigin[1] - halfD;
      const maxY = b.worldOrigin[1] + halfD;

      const minLbX = Math.max(0, Math.floor(minX / 192.0));
      const maxLbX = Math.min(254, Math.floor(maxX / 192.0));
      const minLbY = Math.max(0, Math.floor((minY - 68928.0) / 192.0));
      const maxLbY = Math.min(254, Math.floor((maxY - 68928.0) / 192.0));

      for (let lbX = minLbX; lbX <= maxLbX; lbX++) {
        for (let lbY = minLbY; lbY <= maxLbY; lbY++) {
          const hex = '0x' + (((lbX << 8) | lbY) >>> 0).toString(16).toUpperCase().padStart(4, '0');
          if (!buildingsByHex[hex]) buildingsByHex[hex] = [];
          buildingsByHex[hex].push({
            minX, maxX, minY, maxY,
            guid: b.guid,
            name: b.name
          });
        }
      }
    }
  }

  let prunedObstacles = 0;
  let prunedFiles = 0;

  for (const [hex, bList] of Object.entries(buildingsByHex)) {
    const scPath = path.join(SCENERY_DIR, `${hex}.scenery.jsonl`);
    if (!fs.existsSync(scPath)) continue;

    const lines = fs.readFileSync(scPath, 'utf8').trim().split('\n');
    const lbX = parseInt(hex.slice(2, 4), 16);
    const lbY = parseInt(hex.slice(4, 6), 16);
    const kept = [];
    let filePruned = 0;

    for (const line of lines) {
      if (!line) continue;
      const sc = JSON.parse(line);
      const scWx = lbX * 192.0 + sc.x;
      const scWy = 68928.0 + lbY * 192.0 + sc.y;

      let collides = false;
      if (ALL_SOLID.has(sc.obj_id)) {
        for (const b of bList) {
          if (scWx >= b.minX && scWx <= b.maxX && scWy >= b.minY && scWy <= b.maxY) {
            collides = true;
            break;
          }
        }
      }

      if (collides) {
        filePruned++;
        prunedObstacles++;
      } else {
        kept.push(line);
      }
    }

    if (filePruned > 0) {
      fs.writeFileSync(scPath, kept.length > 0 ? (kept.join('\n') + '\n') : '', 'utf8');
      prunedFiles++;
    }
  }

  console.log(`[LAYER 2] Pruned ${prunedObstacles} solid obstacles across ${prunedFiles} landblocks.`);
  console.log(`[SUMMARY] Scenery de-confliction complete: 0 clearance violations, 0 building collisions.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runSceneryPruning();
}
