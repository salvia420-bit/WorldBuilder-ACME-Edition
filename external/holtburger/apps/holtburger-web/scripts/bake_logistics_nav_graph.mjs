#!/usr/bin/env node
/**
 * Deterministic offline baker for `logistics_nav_graph.json` (F14).
 *
 * Reads:
 *   - external/holtburger/dist/world/{world_meta.json,world_height.u8,world_types.u8}
 *   - external/holtburger/dist/world/{dericost_meta.json,dericost_height.u8,dericost_types.u8}
 *   - external/holtburger/dist/dericost/towns/dericost_towns_index.json
 *   - Canonical 101-town table aligned 1:1 with ACE TownRegistry.cs (60 Dereth + 41 Dericost)
 *
 * Strictly excludes Item 2 (Landlocked Inner Sea / Port Yaraq <-> Port Direlands-East / 0x7A63 / 0x4866).
 * Deterministic offline pipeline (no RNG); output is 100% identical across repeated runs.
 *
 * Writes:
 *   - external/holtburger/apps/holtburger-web/data/logistics_nav_graph.json
 *   - external/holtburger/dist/world/logistics_nav_graph.json (when writable)
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");
const EXT_HOLTBURGER_ROOT = path.resolve(APP_ROOT, "..", "..");
const WORLD_DIST_DIR = path.join(EXT_HOLTBURGER_ROOT, "dist", "world");
const DERICOST_TOWNS_INDEX_PATH = path.join(EXT_HOLTBURGER_ROOT, "dist", "dericost", "towns", "dericost_towns_index.json");

const PRIMARY_OUT_PATH = path.join(APP_ROOT, "data", "logistics_nav_graph.json");
const MIRROR_OUT_PATH = path.join(WORLD_DIST_DIR, "logistics_nav_graph.json");

const GRID_W = 2041;
const GRID_H = 2041;
const GRID_TOTAL = GRID_W * GRID_H;
const CELL_SIZE_M = 24.0;
const DERICOST_Y_OFFSET = 68928.0;
const MAX_BRIDGE_GAP_M = 96.0;
const MAX_ROAD_EDGE_GRADE_DEG = 44.0;
const MAX_STD_SPUR_GRADE_DEG = 25.0;
const MAX_4WD_SPUR_GRADE_DEG = 40.0;

// Strictly 11 canonical Outer Ocean ports (Item 2 Inner Sea ports excluded).
export const OUTER_OCEAN_PORTS = Object.freeze([
  { portId: 1, id: "port_ne_marine_terminal", name: "NE Marine Terminal", lb: "0xEAF9", landblockId: 0xEAF9, continent: "Dereth", continentId: 0, x: 44960, y: 47880 },
  { portId: 2, id: "port_dericost_landing", name: "Dericost Landing", lb: "0x600D8001", landblockId: 0x600D8001, continent: "Dericost", continentId: 1, x: 18552, y: 71496 },
  { portId: 3, id: "port_eastham", name: "Port Eastham", lb: "0xD097", landblockId: 0xD097, continent: "Dereth", continentId: 0, x: 39984, y: 29016 },
  { portId: 4, id: "port_hebian_to", name: "Port Hebian-To", lb: "0xE94F", landblockId: 0xE94F, continent: "Dereth", continentId: 0, x: 44760, y: 15312 },
  { portId: 5, id: "port_north_watch", name: "Port North-Watch", lb: "0x64EC", landblockId: 0x64EC, continent: "Dereth", continentId: 0, x: 19320, y: 45432 },
  { portId: 6, id: "port_direlands_south", name: "Port Direlands-South", lb: "0x1A13", landblockId: 0x1A13, continent: "Dereth", continentId: 0, x: 5160, y: 3648 },
  { portId: 7, id: "port_sanamar", name: "Port Sanamar", lb: "0x34D8", landblockId: 0x34D8, continent: "Dereth", continentId: 0, x: 10008, y: 41568 },
  { portId: 8, id: "port_bluespire", name: "Port Bluespire", lb: "0x21AF", landblockId: 0x21AF, continent: "Dereth", continentId: 0, x: 6456, y: 33768 },
  { portId: 9, id: "port_kryst", name: "Port Kryst", lb: "0xE61D", landblockId: 0xE61D, continent: "Dereth", continentId: 0, x: 44208, y: 5592 },
  { portId: 10, id: "port_vissidal", name: "Port Vissidal", lb: "0xD0E3", landblockId: 0xD0E3, continent: "Dereth", continentId: 0, x: 40056, y: 43704 },
  { portId: 11, id: "port_singularity_caul", name: "Port Singularity Caul", lb: "0x0610", landblockId: 0x0610, continent: "Dereth", continentId: 0, x: 1152, y: 3192 },
]);

// Canonical 60 Dereth towns (aligned 1:1 with TownRegistry.cs lines 60..119).
// TownId 59 preserves anchorLandblock "0xB9730001" while spatial snapping uses (35676.6, 21712.5, 22.0).
const DERETH_TOWNS = Object.freeze([
  [1, "Holtburg", "0xA9B40001", 32532.0, 34567.1, 94.0, 38, 3],
  [2, "Sanamar", "0x33D90001", 9851.1, 41764.3, 52.0, 34, 3],
  [3, "Hebian-To", "0xE64E0001", 44298.3, 15137.9, 20.0, 31, 3],
  [4, "Zaikhal", "0x80900001", 24640.9, 27703.7, 124.0, 29, 3],
  [5, "Shoushi", "0xDA550001", 41940.8, 16419.0, 20.0, 27, 3],
  [6, "Cragstone", "0xBB9F0001", 36073.4, 30696.3, 54.0, 26, 3],
  [7, "Yaraq", "0x7D640001", 24031.9, 19304.6, 11.9, 25, 3],
  [8, "Glenden Wood", "0xA0A40001", 30816.3, 31607.8, 60.0, 24, 3],
  [9, "Arwic", "0xC6A90001", 38062.8, 32452.2, 42.0, 22, 3],
  [10, "Rithwic", "0xC98C0001", 38705.7, 27070.3, 22.0, 21, 2],
  [11, "Qalaba'r", "0x97220001", 29160.4, 6552.6, 102.0, 19, 2],
  [12, "Eastham", "0xCE940001", 39703.1, 28528.6, 17.4, 18, 2],
  [13, "Samsur", "0x977B0001", 29017.8, 23689.9, 0.0, 18, 2],
  [14, "Yanshi", "0xB46F0001", 34635.2, 21436.1, 34.7, 18, 2],
  [15, "Lytelthorpe", "0xC0800001", 36875.7, 24731.6, 33.0, 17, 2],
  [16, "Al-Arqas", "0x8F580001", 27639.9, 16956.2, 9.3, 16, 2],
  [17, "Baishi", "0xCE410001", 39564.6, 12632.8, 55.1, 16, 2],
  [18, "Nanto", "0xE63E0001", 44257.0, 11941.7, 74.5, 16, 2],
  [19, "Candeth Keep", "0x2B120001", 8387.3, 3499.5, 52.4, 15, 2],
  [20, "Khayyaban", "0x9F440001", 30618.0, 13080.6, 31.9, 15, 2],
  [21, "Lin", "0xDC3C0001", 42299.7, 11530.8, 19.0, 15, 2],
  [22, "Sawato", "0xC95B0001", 38606.8, 17472.3, 12.0, 15, 2],
  [23, "Uziz", "0xA2600001", 31286.9, 18519.9, 20.0, 15, 2],
  [24, "Ayan Baqur", "0x11330001", 3352.1, 9958.2, 64.8, 14, 2],
  [25, "Dryreach", "0xDA750001", 41988.0, 22524.0, 18.0, 14, 2],
  [26, "Tufa", "0x876C0001", 25922.0, 20922.9, 18.0, 14, 2],
  [27, "Mayoi", "0xE6320001", 44267.4, 9610.8, 29.9, 13, 2],
  [28, "Al-Jalima", "0x85880001", 25656.4, 26207.5, 90.0, 12, 2],
  [29, "Xarabydun", "0x934B0001", 28332.3, 14406.1, 18.1, 12, 2],
  [30, "Kara", "0xBA170001", 35893.2, 4419.2, 167.7, 11, 2],
  [31, "Stonehold", "0x64D50001", 19230.0, 40946.0, 78.0, 11, 2],
  [32, "Wai Jhou", "0x3F310001", 12152.3, 9576.1, 2.9, 11, 2],
  [33, "Kryst", "0xE8220001", 44676.7, 6565.9, 20.1, 9, 1],
  [34, "Silyun", "0x26EC0001", 7471.9, 45422.3, 80.0, 9, 1],
  [35, "Eastwatch", "0x49F00001", 14086.0, 46150.0, 170.0, 8, 1],
  [36, "Fort Tethana", "0x26810001", 7373.7, 24876.1, 240.0, 8, 1],
  [37, "Plateau Village", "0x49B70001", 14116.1, 35156.8, 238.6, 8, 1],
  [38, "Westwatch", "0x23DA0001", 6860.9, 41942.0, 2.0, 8, 1],
  [39, "Ahurenga", "0x0FB90001", 2923.0, 35528.6, 0.0, 7, 1],
  [40, "Bluespire", "0x21B00001", 6384.2, 33957.9, 0.0, 7, 1],
  [41, "Timaru", "0x1DB60001", 5639.4, 35078.3, 90.0, 7, 1],
  [42, "Linvak Tukal", "0xA21E0001", 31187.0, 5798.0, 560.4, 6, 1],
  [43, "Oolutanga's Refuge", "0xF6820001", 47377.7, 25009.9, 58.0, 6, 1],
  [44, "Redspire", "0x17B20001", 4548.6, 34201.8, 44.0, 6, 1],
  [45, "Greenspire", "0x2BB50001", 8435.0, 34838.6, 0.0, 5, 1],
  [46, "MacNiall's Freehold", "0xF2240001", 46545.8, 6945.0, 0.0, 5, 1],
  [47, "Merwart Village", "0xC9E30001", 38651.5, 43642.9, 14.1, 5, 1],
  [48, "Neydisa Castle", "0x95D60001", 28754.9, 41159.3, 99.8, 5, 1],
  [49, "West Outpost", "0x5A9C0001", 17303.5, 30029.1, 6.0, 5, 1],
  [50, "Bandit Castle", "0xBDD00001", 36304.9, 40056.5, 115.1, 4, 1],
  [51, "Beach Fort", "0x42DE0001", 12697.0, 42708.5, 0.0, 4, 1],
  [52, "Crater Lake Village", "0x90D00001", 27707.0, 40042.7, 285.8, 4, 1],
  [53, "Fiun Outpost", "0x38F70001", 10843.0, 47478.0, -0.1, 4, 1],
  [54, "Yanshi South Outpost", "0xB6650001", 35085.7, 19535.1, 14.5, 4, 1],
  [55, "Highlands Trading Post", "0x7ACA0001", 23475.5, 38811.1, 200.0, 3, 1],
  [56, "Nanto South Camp", "0xE3370001", 43738.1, 10694.2, 104.0, 3, 1],
  [57, "Neydisa South Camp", "0x8CDD0001", 26988.2, 42587.1, 70.7, 3, 1],
  [58, "Sanamar West Outpost", "0x3ED50001", 12082.0, 40990.8, 1.0, 3, 1],
  [59, "Yanshi North Outpost", "0xB9730001", 35676.6, 21712.5, 22.0, 3, 1],
  [60, "Tou-Tou", "0xF5590001", 47192.6, 17168.8, 20.0, 0, 1],
]);

// Canonical 41 Dericost names & anchorLandblocks for 1:1 cross-check against dericost_towns_index.json.
const DERICOST_TOWN_ORDER = Object.freeze([
  ["Vasmora", "0x2CB28001"],
  ["Frore", "0x3FE78001"],
  ["Frisirth", "0x52C08001"],
  ["Minesh", "0x65DA8001"],
  ["Kelnir", "0x78CD8001"],
  ["Gelid-Keep", "0x8BCD8001"],
  ["Coldwatch", "0x9EDA8001"],
  ["Boreal-Spires", "0xB1C08001"],
  ["Saliane", "0xC4E78001"],
  ["Glacier-Reach", "0xD7B28001"],
  ["Antaoc", "0x1A6B8001"],
  ["Hirschi", "0x259C8001"],
  ["Nehane", "0x307B8001"],
  ["Stone-Cleft", "0x3B8B8001"],
  ["Iron-Garrison", "0x468B8001"],
  ["Grymar's Stand", "0x517B8001"],
  ["Cynreft", "0x5C9C8001"],
  ["High-Quarry", "0x676B8001"],
  ["Cannthalo", "0x766B8001"],
  ["Zemal Foothills", "0x859C8001"],
  ["Tresimaen", "0x937B8001"],
  ["Hendrel's Gate", "0xA28B8001"],
  ["Obsidian-Bluff", "0xB08B8001"],
  ["Ash-Haven", "0xBE7B8001"],
  ["Sulfur-Springs", "0xCD9C8001"],
  ["Orisis-Deep", "0xDB6B8001"],
  ["Daralet", "0x1A2D8001"],
  ["Fen-Gate", "0x2B518001"],
  ["Mhoire-Crosse", "0x3B3F8001"],
  ["Bog-Haven", "0x4B3F8001"],
  ["Weeping-Creek", "0x5C518001"],
  ["Mire-Watch", "0x6C2D8001"],
  ["Shakrassekor", "0x922D8001"],
  ["Berkesh", "0xA2518001"],
  ["Ayn Tayan", "0xB33F8001"],
  ["Harebach Crose", "0xC33F8001"],
  ["Sand-Bastion", "0xD4518001"],
  ["Pines-Foot", "0xE42D8001"],
  ["Nesortania", "0x680B8001"],
  ["Galleys-Anchorage", "0x82138001"],
  ["South-Haven", "0x9C1C8001"],
]);

function round2(n) {
  return Math.round(n * 100) / 100;
}

function clampGrid(v) {
  return v < 0 ? 0 : v >= GRID_W ? GRID_W - 1 : v;
}

function worldToGrid(x, y, continentId) {
  const c = continentId === 1 ? 1 : 0;
  const localY = c === 1 ? y - DERICOST_Y_OFFSET : y;
  return {
    c,
    ix: clampGrid(Math.round(x / CELL_SIZE_M)),
    iy: clampGrid(Math.round(localY / CELL_SIZE_M)),
  };
}

function gridToWorld(c, ix, iy, heightTable, hBuf) {
  const idx = iy * GRID_W + ix;
  return {
    x: ix * CELL_SIZE_M,
    y: (c === 1 ? DERICOST_Y_OFFSET : 0.0) + iy * CELL_SIZE_M,
    z: heightTable[hBuf[idx]],
  };
}

function calcGradeDeg(ax, ay, az, bx, by, bz) {
  const dist2d = Math.hypot(bx - ax, by - ay);
  if (dist2d <= 1e-6) return 0.0;
  return (Math.atan2(Math.abs(bz - az), dist2d) * 180.0) / Math.PI;
}

class MinHeap {
  constructor() {
    this.keys = [];
    this.vals = [];
  }
  get size() {
    return this.keys.length;
  }
  push(key, priority) {
    this.keys.push(key);
    this.vals.push(priority);
    let i = this.keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.vals[p] <= this.vals[i]) break;
      [this.keys[p], this.keys[i]] = [this.keys[i], this.keys[p]];
      [this.vals[p], this.vals[i]] = [this.vals[i], this.vals[p]];
      i = p;
    }
  }
  pop() {
    const topKey = this.keys[0];
    const lastKey = this.keys.pop();
    const lastVal = this.vals.pop();
    if (this.keys.length > 0) {
      this.keys[0] = lastKey;
      this.vals[0] = lastVal;
      let i = 0;
      const n = this.keys.length;
      while (true) {
        let best = i;
        const l = i * 2 + 1;
        const r = l + 1;
        if (l < n && this.vals[l] < this.vals[best]) best = l;
        if (r < n && this.vals[r] < this.vals[best]) best = r;
        if (best === i) break;
        [this.keys[i], this.keys[best]] = [this.keys[best], this.keys[i]];
        [this.vals[i], this.vals[best]] = [this.vals[best], this.vals[i]];
        i = best;
      }
    }
    return topKey;
  }
}

function buildCanonicalTowns() {
  const dericostIndex = JSON.parse(readFileSync(DERICOST_TOWNS_INDEX_PATH, "utf8"));
  assert.equal(dericostIndex.towns.length, 41, "Expected 41 towns in dericost_towns_index.json");

  const towns = [];
  for (const [townId, name, anchorLandblock, x, y, z, baseVendorCount, tier] of DERETH_TOWNS) {
    towns.push({
      townId,
      id: townId,
      name,
      continent: "Dereth",
      continentId: 0,
      tier,
      province: "Dereth",
      anchorLandblock,
      anchorLandblockId: parseInt(anchorLandblock, 16) >>> 0,
      x,
      y,
      z,
      baseVendorCount,
      nodeId: `town_${townId}`,
    });
  }

  for (let i = 0; i < 41; i++) {
    const dt = dericostIndex.towns[i];
    const [expectedName, expectedCell] = DERICOST_TOWN_ORDER[i];
    assert.equal(dt.name, expectedName, `Dericost town #${i} mismatch: ${dt.name} vs ${expectedName}`);
    assert.equal(dt.serverCellId, expectedCell, `Dericost cell #${i} mismatch: ${dt.serverCellId} vs ${expectedCell}`);
    const townId = 61 + i;
    towns.push({
      townId,
      id: townId,
      name: dt.name,
      continent: "Dericost",
      continentId: 1,
      tier: 1,
      province: dt.province,
      anchorLandblock: dt.serverCellId,
      anchorLandblockId: parseInt(dt.serverCellId, 16) >>> 0,
      x: dt.x,
      y: dt.y,
      z: dt.z,
      baseVendorCount: dt.npcCount,
      nodeId: `town_${townId}`,
    });
  }

  assert.equal(towns.length, 101);
  return towns;
}

function floodFillOuterOcean(wt, dt) {
  const seaComp = new Uint8Array(GRID_TOTAL * 2);
  const queue = new Int32Array(GRID_TOTAL * 2);
  let head = 0;
  let tail = 0;

  // Seed at NE Marine Terminal (c=0, ix=1873, iy=1995)
  const seed = 1995 * GRID_W + 1873;
  assert.equal(wt[seed] & 0x1F, 20, "NE Marine Terminal seed must be WaterDeepSea (20)");
  seaComp[seed] = 1;
  queue[tail++] = seed;

  while (head < tail) {
    const cur = queue[head++];
    const c = cur >= GRID_TOTAL ? 1 : 0;
    const local = cur - c * GRID_TOTAL;
    const iy = (local / GRID_W) | 0;
    const ix = local - iy * GRID_W;
    const tBuf = c === 0 ? wt : dt;

    if (ix > 0) {
      const n = cur - 1;
      if (!seaComp[n] && (tBuf[local - 1] & 0x1F) === 20) {
        seaComp[n] = 1;
        queue[tail++] = n;
      }
    }
    if (ix + 1 < GRID_W) {
      const n = cur + 1;
      if (!seaComp[n] && (tBuf[local + 1] & 0x1F) === 20) {
        seaComp[n] = 1;
        queue[tail++] = n;
      }
    }
    if (iy > 0) {
      const n = cur - GRID_W;
      if (!seaComp[n] && (tBuf[local - GRID_W] & 0x1F) === 20) {
        seaComp[n] = 1;
        queue[tail++] = n;
      }
    } else if (c === 1) {
      // Northern Sea Corridor stitch: (c=1, ix, iy=0) <-> (c=0, ix, iy=2040)
      const nLocal = 2040 * GRID_W + ix;
      if (!seaComp[nLocal] && (wt[nLocal] & 0x1F) === 20) {
        seaComp[nLocal] = 1;
        queue[tail++] = nLocal;
      }
    }
    if (iy + 1 < GRID_H) {
      const n = cur + GRID_W;
      if (!seaComp[n] && (tBuf[local + GRID_W] & 0x1F) === 20) {
        seaComp[n] = 1;
        queue[tail++] = n;
      }
    } else if (c === 0) {
      // Northern Sea Corridor stitch: (c=0, ix, iy=2040) <-> (c=1, ix, iy=0)
      const nLocal = ix;
      const n = GRID_TOTAL + nLocal;
      if (!seaComp[n] && (dt[nLocal] & 0x1F) === 20) {
        seaComp[n] = 1;
        queue[tail++] = n;
      }
    }
  }

  return { seaComp, outerOceanCells: tail };
}

function findNearestSeaBerth(c, ix0, iy0, seaComp, tBuf, maxRadiusCells = 15) {
  let best = null;
  const minY = Math.max(0, iy0 - maxRadiusCells);
  const maxY = Math.min(GRID_H - 1, iy0 + maxRadiusCells);
  const minX = Math.max(0, ix0 - maxRadiusCells);
  const maxX = Math.min(GRID_W - 1, ix0 + maxRadiusCells);
  const offset = c * GRID_TOTAL;

  for (let iy = minY; iy <= maxY; iy++) {
    for (let ix = minX; ix <= maxX; ix++) {
      const local = iy * GRID_W + ix;
      if (seaComp[offset + local] !== 1) continue;
      const d = Math.hypot((ix - ix0) * CELL_SIZE_M, (iy - iy0) * CELL_SIZE_M);
      if (
        !best
        || d < best.distM - 1e-9
        || (Math.abs(d - best.distM) <= 1e-9 && (iy < best.iy || (iy === best.iy && ix < best.ix)))
      ) {
        best = {
          c,
          ix,
          iy,
          local,
          distM: d,
          terrainCode: tBuf[local],
        };
      }
    }
  }
  return best;
}

function extractRoadNetwork(c, tBuf, hBuf, heightTable) {
  const verts = [];
  const vertMap = new Int32Array(GRID_TOTAL).fill(-1);

  for (let iy = 0; iy < GRID_H; iy++) {
    for (let ix = 0; ix < GRID_W; ix++) {
      const local = iy * GRID_W + ix;
      const b = tBuf[local];
      if ((b & 0x60) !== 0) {
        const vi = verts.length;
        vertMap[local] = vi;
        verts.push({
          vi,
          c,
          ix,
          iy,
          local,
          x: ix * CELL_SIZE_M,
          y: (c === 1 ? DERICOST_Y_OFFSET : 0.0) + iy * CELL_SIZE_M,
          z: heightTable[hBuf[local]],
          terrainCode: b,
          roadBits: (b >> 5) & 0x3,
        });
      }
    }
  }

  const parent = new Int32Array(verts.length);
  for (let i = 0; i < verts.length; i++) parent[i] = i;
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      parent[ra] = rb;
      return true;
    }
    return false;
  };

  const rawEdges = [];
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = a.ix + dx;
        const ny = a.iy + dy;
        if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) continue;
        const j = vertMap[ny * GRID_W + nx];
        if (j <= i) continue;
        const b = verts[j];
        const lengthM = Math.hypot(b.x - a.x, b.y - a.y);
        const gradeDeg = calcGradeDeg(a.x, a.y, a.z, b.x, b.y, b.z);
        if (gradeDeg <= MAX_ROAD_EDGE_GRADE_DEG) {
          rawEdges.push({ a: i, b: j, lengthM, gradeDeg, isBridge: false });
          union(i, j);
        }
      }
    }
  }

  // Bridge gaps (34 m < d <= 96 m) between disconnected 8-neighbor components with grade <= 44 deg.
  const bridgeCandidates = [];
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist2d = Math.hypot(dx * CELL_SIZE_M, dy * CELL_SIZE_M);
        if (dist2d <= 34.0 || dist2d > MAX_BRIDGE_GAP_M) continue;
        const nx = a.ix + dx;
        const ny = a.iy + dy;
        if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) continue;
        const j = vertMap[ny * GRID_W + nx];
        if (j <= i) continue;
        const b = verts[j];
        const gradeDeg = calcGradeDeg(a.x, a.y, a.z, b.x, b.y, b.z);
        if (gradeDeg <= MAX_ROAD_EDGE_GRADE_DEG) {
          bridgeCandidates.push({ a: i, b: j, lengthM: dist2d, gradeDeg, isBridge: true });
        }
      }
    }
  }
  bridgeCandidates.sort((u, v) => u.lengthM - v.lengthM || u.a - v.a || u.b - v.b);

  let bridgeCount = 0;
  for (const e of bridgeCandidates) {
    if (union(e.a, e.b)) {
      rawEdges.push(e);
      bridgeCount++;
    }
  }

  const compRoot = new Int32Array(verts.length);
  const compSizes = new Map();
  for (let i = 0; i < verts.length; i++) {
    const r = find(i);
    compRoot[i] = r;
    compSizes.set(r, (compSizes.get(r) || 0) + 1);
  }

  return { verts, vertMap, rawEdges, compRoot, compSizes, bridgeCount };
}

/**
 * 8-neighbor terrain A* on a single continent grid (terr !== 20).
 * Seeds from all valid nearby grid vertices within radiusCells whose grade from (originX, originY, originZ) <= maxGradeDeg.
 * Allows shallow water (terr 18/19) with 4x ford cost penalty.
 * Prefers road cells ((b & 0x60) !== 0) with 0.6x cost multiplier.
 */
function findTerrainSpurAStar(c, originX, originY, originZ, goalMatcher, heuristicTarget, tBuf, hBuf, heightTable, maxGradeDeg, radiusCells = 3) {
  const g0 = worldToGrid(originX, originY, c);
  const gScore = new Float64Array(GRID_TOTAL).fill(Infinity);
  const cameFrom = new Int32Array(GRID_TOTAL).fill(-1);
  const closed = new Uint8Array(GRID_TOTAL);
  const heap = new MinHeap();

  let seeded = 0;
  for (let dy = -radiusCells; dy <= radiusCells; dy++) {
    for (let dx = -radiusCells; dx <= radiusCells; dx++) {
      const sx = g0.ix + dx;
      const sy = g0.iy + dy;
      if (sx < 0 || sx >= GRID_W || sy < 0 || sy >= GRID_H) continue;
      const sLocal = sy * GRID_W + sx;
      const sb = tBuf[sLocal];
      const sTerr = sb & 0x1F;
      if (sTerr === 20) continue;
      const wx = sx * CELL_SIZE_M;
      const wy = (c === 1 ? DERICOST_Y_OFFSET : 0.0) + sy * CELL_SIZE_M;
      const wz = heightTable[hBuf[sLocal]];
      const dist0 = Math.hypot(wx - originX, wy - originY);
      const grade0 = calcGradeDeg(originX, originY, originZ, wx, wy, wz);
      if (grade0 > maxGradeDeg) continue;

      let costMul = 1.0;
      if ((sb & 0x60) !== 0) costMul = 0.6;
      else if (sTerr === 18 || sTerr === 19) costMul = 4.0;
      costMul += grade0 * 0.02;
      const initG = dist0 * costMul;
      if (initG < gScore[sLocal]) {
        gScore[sLocal] = initG;
        const h = Math.hypot((heuristicTarget.ix - sx) * CELL_SIZE_M, (heuristicTarget.iy - sy) * CELL_SIZE_M) * 0.6;
        heap.push(sLocal, initG + h);
        seeded++;
      }
    }
  }
  if (seeded === 0) return null;

  const dxTable = [-1, 0, 1, -1, 1, -1, 0, 1];
  const dyTable = [-1, -1, -1, 0, 0, 1, 1, 1];

  while (heap.size > 0) {
    const cur = heap.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;

    if (goalMatcher(cur)) {
      const path = [];
      let k = cur;
      while (k !== -1) {
        const ky = (k / GRID_W) | 0;
        const kx = k - ky * GRID_W;
        const terr = tBuf[k] & 0x1F;
        path.push({
          c,
          ix: kx,
          iy: ky,
          local: k,
          x: kx * CELL_SIZE_M,
          y: (c === 1 ? DERICOST_Y_OFFSET : 0.0) + ky * CELL_SIZE_M,
          z: heightTable[hBuf[k]],
          terrainCode: tBuf[k],
          isFord: terr === 18 || terr === 19,
        });
        k = cameFrom[k];
      }
      path.reverse();
      return path;
    }

    const iy = (cur / GRID_W) | 0;
    const ix = cur - iy * GRID_W;
    const cz = heightTable[hBuf[cur]];
    const curG = gScore[cur];

    for (let dir = 0; dir < 8; dir++) {
      const nx = ix + dxTable[dir];
      const ny = iy + dyTable[dir];
      if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) continue;
      const ni = ny * GRID_W + nx;
      if (closed[ni]) continue;

      const b = tBuf[ni];
      const terr = b & 0x1F;
      if (terr === 20) continue;

      const stepM = dxTable[dir] !== 0 && dyTable[dir] !== 0 ? CELL_SIZE_M * Math.SQRT2 : CELL_SIZE_M;
      const nz = heightTable[hBuf[ni]];
      const gradeDeg = (Math.atan2(Math.abs(nz - cz), stepM) * 180.0) / Math.PI;
      if (gradeDeg > maxGradeDeg) continue;

      let costMul = 1.0;
      if ((b & 0x60) !== 0) costMul = 0.6;
      else if (terr === 18 || terr === 19) costMul = 4.0;
      costMul += gradeDeg * 0.02;

      const candG = curG + stepM * costMul;
      if (candG < gScore[ni]) {
        gScore[ni] = candG;
        cameFrom[ni] = cur;
        const h = Math.hypot((heuristicTarget.ix - nx) * CELL_SIZE_M, (heuristicTarget.iy - ny) * CELL_SIZE_M) * 0.6;
        heap.push(ni, candG + h);
      }
    }
  }

  return null;
}

function findNearestVertexInSet(c, ix, iy, verts, predicate) {
  let best = null;
  let bestD2 = Infinity;
  for (let i = 0; i < verts.length; i++) {
    if (!predicate(verts[i])) continue;
    const dx = verts[i].ix - ix;
    const dy = verts[i].iy - iy;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = verts[i];
    }
  }
  return best;
}

/**
 * Find a reachable coastal landing shore cell (terr !== 20, 4-adjacent to seaComp === 0)
 * from (sx, sy) at <= 25 deg, picking the cell closest to target (tx, ty).
 */
function findIslandCoastalLanding(c, sx, sy, tx, ty, seaComp, tBuf, hBuf, heightTable) {
  const visited = new Uint8Array(GRID_TOTAL);
  const queue = new Int32Array(GRID_TOTAL);
  let head = 0;
  let tail = 0;
  const start = sy * GRID_W + sx;
  visited[start] = 1;
  queue[tail++] = start;

  let bestShore = null;
  let bestBerth = null;
  let bestDist = Infinity;

  const dx8 = [-1, 0, 1, -1, 1, -1, 0, 1];
  const dy8 = [-1, -1, -1, 0, 0, 1, 1, 1];
  const dx4 = [-1, 1, 0, 0];
  const dy4 = [0, 0, -1, 1];

  while (head < tail) {
    const cur = queue[head++];
    const iy = (cur / GRID_W) | 0;
    const ix = cur - iy * GRID_W;
    const cz = heightTable[hBuf[cur]];

    // Check 4-neighbor outer ocean adjacency
    for (let k = 0; k < 4; k++) {
      const bx = ix + dx4[k];
      const by = iy + dy4[k];
      if (bx < 0 || bx >= GRID_W || by < 0 || by >= GRID_H) continue;
      const bLocal = by * GRID_W + bx;
      if (seaComp[c * GRID_TOTAL + bLocal] === 1) {
        const d = Math.hypot((ix - tx) * CELL_SIZE_M, (iy - ty) * CELL_SIZE_M);
        if (
          d < bestDist - 1e-9
          || (Math.abs(d - bestDist) <= 1e-9 && (!bestShore || iy < bestShore.iy || (iy === bestShore.iy && ix < bestShore.ix)))
        ) {
          bestDist = d;
          bestShore = { c, ix, iy, local: cur, x: ix * CELL_SIZE_M, y: (c === 1 ? DERICOST_Y_OFFSET : 0) + iy * CELL_SIZE_M, z: cz, terrainCode: tBuf[cur] };
          bestBerth = { c, ix: bx, iy: by, local: bLocal, terrainCode: tBuf[bLocal] };
        }
        break;
      }
    }

    for (let dir = 0; dir < 8; dir++) {
      const nx = ix + dx8[dir];
      const ny = iy + dy8[dir];
      if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) continue;
      const ni = ny * GRID_W + nx;
      if (visited[ni]) continue;
      const terr = tBuf[ni] & 0x1F;
      if (terr === 20) continue;
      const stepM = dx8[dir] !== 0 && dy8[dir] !== 0 ? CELL_SIZE_M * Math.SQRT2 : CELL_SIZE_M;
      const gradeDeg = (Math.atan2(Math.abs(heightTable[hBuf[ni]] - cz), stepM) * 180.0) / Math.PI;
      if (gradeDeg > MAX_STD_SPUR_GRADE_DEG) continue;
      visited[ni] = 1;
      queue[tail++] = ni;
    }
  }

  return { shore: bestShore, berth: bestBerth };
}

/**
 * Douglas-Peucker polyline simplification with strict max-grade and max-segment-length guards.
 */
function simplifyChain(points, dpTolM, maxSegLenM, maxGradeDeg, checkLineOfSightFn = null) {
  if (points.length <= 2) return points;

  function perpDist(pt, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len <= 1e-6) return Math.hypot(pt.x - a.x, pt.y - a.y);
    return Math.abs(dx * (a.y - pt.y) - (a.x - pt.x) * dy) / len;
  }

  function canMerge(i0, i1) {
    const a = points[i0];
    const b = points[i1];
    if (a.c !== b.c) return false;
    const len2d = Math.hypot(b.x - a.x, b.y - a.y);
    if (len2d > maxSegLenM) return false;
    const g = calcGradeDeg(a.x, a.y, a.z, b.x, b.y, b.z);
    if (g > maxGradeDeg) return false;
    if (checkLineOfSightFn && !checkLineOfSightFn(a, b)) return false;
    for (let k = i0 + 1; k < i1; k++) {
      if (perpDist(points[k], a, b) > dpTolM) return false;
    }
    return true;
  }

  const kept = [points[0]];
  let anchor = 0;
  while (anchor < points.length - 1) {
    let far = anchor + 1;
    // Exponential + binary search or linear scan (chains are short, linear from far-end or greedy step is fast & deterministic)
    for (let cand = points.length - 1; cand > anchor + 1; cand--) {
      if (canMerge(anchor, cand)) {
        far = cand;
        break;
      }
    }
    kept.push(points[far]);
    anchor = far;
  }
  return kept;
}

/**
 * Simplify a road network by extracting chains between pinned/junction/bridge vertices
 * and applying simplifyChain while preserving topology and grade limits.
 */
function simplifyRoadGraph(c, roadNet, pinnedSet) {
  const { verts, rawEdges } = roadNet;
  const adj = Array.from({ length: verts.length }, () => []);
  for (let ei = 0; ei < rawEdges.length; ei++) {
    const e = rawEdges[ei];
    adj[e.a].push({ to: e.b, ei, e });
    adj[e.b].push({ to: e.a, ei, e });
  }

  const isAnchor = new Uint8Array(verts.length);
  for (let i = 0; i < verts.length; i++) {
    if (adj[i].length !== 2 || pinnedSet.has(i)) {
      isAnchor[i] = 1;
    } else {
      const [n0, n1] = adj[i];
      if (n0.e.isBridge || n1.e.isBridge) {
        isAnchor[i] = 1;
      } else if (verts[i].roadBits !== verts[n0.to].roadBits || verts[i].roadBits !== verts[n1.to].roadBits) {
        isAnchor[i] = 1;
      }
    }
  }

  const visitedEdge = new Uint8Array(rawEdges.length);
  const keptVertSet = new Set();
  const simplifiedEdges = [];

  function emitChain(chainVerts, isBridge, maxChainGrade) {
    if (chainVerts.length === 2) {
      const a = chainVerts[0];
      const b = chainVerts[1];
      keptVertSet.add(a.vi);
      keptVertSet.add(b.vi);
      simplifiedEdges.push({
        a: a.vi,
        b: b.vi,
        lengthM: round2(Math.hypot(b.x - a.x, b.y - a.y)),
        gradeDeg: round2(calcGradeDeg(a.x, a.y, a.z, b.x, b.y, b.z)),
        isBridge,
      });
      return;
    }
    const gradeLimit = Math.min(MAX_ROAD_EDGE_GRADE_DEG, Math.max(MAX_STD_SPUR_GRADE_DEG, maxChainGrade));
    const reduced = simplifyChain(chainVerts, 10.0, 240.0, gradeLimit);
    for (let k = 0; k < reduced.length - 1; k++) {
      const a = reduced[k];
      const b = reduced[k + 1];
      keptVertSet.add(a.vi);
      keptVertSet.add(b.vi);
      simplifiedEdges.push({
        a: a.vi,
        b: b.vi,
        lengthM: round2(Math.hypot(b.x - a.x, b.y - a.y)),
        gradeDeg: round2(calcGradeDeg(a.x, a.y, a.z, b.x, b.y, b.z)),
        isBridge: false,
      });
    }
  }

  // 1. Walk chains starting from every anchor vertex
  for (let i = 0; i < verts.length; i++) {
    if (!isAnchor[i]) continue;
    for (const step of adj[i]) {
      if (visitedEdge[step.ei]) continue;
      if (step.e.isBridge) {
        visitedEdge[step.ei] = 1;
        emitChain([verts[i], verts[step.to]], true, step.e.gradeDeg);
        continue;
      }
      const chain = [verts[i]];
      let prev = i;
      let cur = step.to;
      visitedEdge[step.ei] = 1;
      let maxGrade = step.e.gradeDeg;

      while (!isAnchor[cur]) {
        chain.push(verts[cur]);
        const nextStep = adj[cur].find((s) => s.to !== prev && !visitedEdge[s.ei]);
        if (!nextStep) break;
        visitedEdge[nextStep.ei] = 1;
        if (nextStep.e.gradeDeg > maxGrade) maxGrade = nextStep.e.gradeDeg;
        prev = cur;
        cur = nextStep.to;
      }
      chain.push(verts[cur]);
      emitChain(chain, false, maxGrade);
    }
  }

  // 2. Walk pure degree-2 closed loops (no anchors on the cycle)
  for (let i = 0; i < verts.length; i++) {
    for (const step of adj[i]) {
      if (visitedEdge[step.ei]) continue;
      const chain = [verts[i]];
      let prev = i;
      let cur = step.to;
      visitedEdge[step.ei] = 1;
      let maxGrade = step.e.gradeDeg;

      while (cur !== i) {
        chain.push(verts[cur]);
        const nextStep = adj[cur].find((s) => s.to !== prev && !visitedEdge[s.ei]);
        if (!nextStep) break;
        visitedEdge[nextStep.ei] = 1;
        if (nextStep.e.gradeDeg > maxGrade) maxGrade = nextStep.e.gradeDeg;
        prev = cur;
        cur = nextStep.to;
      }
      chain.push(verts[cur]);
      // Break loop cleanly at mid-point anchor if needed
      if (chain.length >= 4) {
        const mid = chain.length >> 1;
        emitChain(chain.slice(0, mid + 1), false, maxGrade);
        emitChain(chain.slice(mid), false, maxGrade);
      } else {
        emitChain(chain, false, maxGrade);
      }
    }
  }

  const keptVerts = Array.from(keptVertSet).sort((a, b) => a - b);
  return { keptVerts, simplifiedEdges };
}

/**
 * 8-neighbor A* on Outer Ocean seaComp === 1, stitching across Northern Sea Corridor seam.
 */
function findSeaLaneAStar(start, goal, seaComp) {
  const TOTAL2 = GRID_TOTAL * 2;
  const gScore = new Float64Array(TOTAL2).fill(Infinity);
  const cameFrom = new Int32Array(TOTAL2).fill(-1);
  const closed = new Uint8Array(TOTAL2);
  const heap = new MinHeap();

  const startKey = start.c * GRID_TOTAL + start.iy * GRID_W + start.ix;
  const goalKey = goal.c * GRID_TOTAL + goal.iy * GRID_W + goal.ix;
  const goalGx = goal.ix * CELL_SIZE_M;
  const goalGy = (goal.c === 1 ? DERICOST_Y_OFFSET : 0.0) + goal.iy * CELL_SIZE_M;

  gScore[startKey] = 0.0;
  const sx = start.ix * CELL_SIZE_M;
  const sy = (start.c === 1 ? DERICOST_Y_OFFSET : 0.0) + start.iy * CELL_SIZE_M;
  heap.push(startKey, Math.hypot(goalGx - sx, goalGy - sy));

  const dx8 = [-1, 0, 1, -1, 1, -1, 0, 1];
  const dy8 = [-1, -1, -1, 0, 0, 1, 1, 1];

  while (heap.size > 0) {
    const cur = heap.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;

    if (cur === goalKey) {
      const path = [];
      let k = cur;
      while (k !== -1) {
        const kc = k >= GRID_TOTAL ? 1 : 0;
        const local = k - kc * GRID_TOTAL;
        const kiy = (local / GRID_W) | 0;
        const kix = local - kiy * GRID_W;
        path.push({
          c: kc,
          ix: kix,
          iy: kiy,
          x: kix * CELL_SIZE_M,
          y: (kc === 1 ? DERICOST_Y_OFFSET : 0.0) + kiy * CELL_SIZE_M,
          z: 0.0,
        });
        k = cameFrom[k];
      }
      path.reverse();
      return path;
    }

    const c = cur >= GRID_TOTAL ? 1 : 0;
    const local = cur - c * GRID_TOTAL;
    const iy = (local / GRID_W) | 0;
    const ix = local - iy * GRID_W;
    const curG = gScore[cur];

    // 8-neighbor steps within same continent
    for (let dir = 0; dir < 8; dir++) {
      const nx = ix + dx8[dir];
      const ny = iy + dy8[dir];
      if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) continue;
      const nKey = c * GRID_TOTAL + ny * GRID_W + nx;
      if (closed[nKey] || seaComp[nKey] !== 1) continue;
      const stepM = dx8[dir] !== 0 && dy8[dir] !== 0 ? CELL_SIZE_M * Math.SQRT2 : CELL_SIZE_M;
      const candG = curG + stepM;
      if (candG < gScore[nKey]) {
        gScore[nKey] = candG;
        cameFrom[nKey] = cur;
        const gx = nx * CELL_SIZE_M;
        const gy = (c === 1 ? DERICOST_Y_OFFSET : 0.0) + ny * CELL_SIZE_M;
        heap.push(nKey, candG + Math.hypot(goalGx - gx, goalGy - gy));
      }
    }

    // Northern Sea Corridor seam crossing (19,968 m across Y in [48960, 68928])
    // Allow direct straight crossing (jx=ix) and optimal diagonal crossings when corridor boundary is open water.
    if (c === 0 && iy === GRID_H - 1) {
      const seamDy = DERICOST_Y_OFFSET - (GRID_H - 1) * CELL_SIZE_M;
      const targets = new Set([ix]);
      if (goal.c === 1) {
        targets.add(goal.ix);
        const totalDy = Math.max(seamDy, goalGy - (GRID_H - 1) * CELL_SIZE_M);
        targets.add(clampGrid(Math.round(ix + (goal.ix - ix) * (seamDy / totalDy))));
      }
      for (const jx of targets) {
        const nKey = GRID_TOTAL + jx;
        if (closed[nKey] || seaComp[nKey] !== 1) continue;
        // Verify open water along both seam edges if diagonal
        let clear = true;
        const lo = Math.min(ix, jx);
        const hi = Math.max(ix, jx);
        for (let kx = lo; kx <= hi; kx++) {
          if (seaComp[(GRID_H - 1) * GRID_W + kx] !== 1 || seaComp[GRID_TOTAL + kx] !== 1) {
            clear = false;
            break;
          }
        }
        if (!clear) continue;
        const seamDist = Math.hypot((jx - ix) * CELL_SIZE_M, seamDy);
        const candG = curG + seamDist;
        if (candG < gScore[nKey]) {
          gScore[nKey] = candG;
          cameFrom[nKey] = cur;
          heap.push(nKey, candG + Math.hypot(goalGx - jx * CELL_SIZE_M, goalGy - DERICOST_Y_OFFSET));
        }
      }
    } else if (c === 1 && iy === 0) {
      const seamDy = DERICOST_Y_OFFSET - (GRID_H - 1) * CELL_SIZE_M;
      const targets = new Set([ix]);
      if (goal.c === 0) {
        targets.add(goal.ix);
        const totalDy = Math.max(seamDy, DERICOST_Y_OFFSET - goalGy);
        targets.add(clampGrid(Math.round(ix + (goal.ix - ix) * (seamDy / totalDy))));
      }
      for (const jx of targets) {
        const nKey = (GRID_H - 1) * GRID_W + jx;
        if (closed[nKey] || seaComp[nKey] !== 1) continue;
        let clear = true;
        const lo = Math.min(ix, jx);
        const hi = Math.max(ix, jx);
        for (let kx = lo; kx <= hi; kx++) {
          if (seaComp[(GRID_H - 1) * GRID_W + kx] !== 1 || seaComp[GRID_TOTAL + kx] !== 1) {
            clear = false;
            break;
          }
        }
        if (!clear) continue;
        const seamDist = Math.hypot((jx - ix) * CELL_SIZE_M, seamDy);
        const candG = curG + seamDist;
        if (candG < gScore[nKey]) {
          gScore[nKey] = candG;
          cameFrom[nKey] = cur;
          heap.push(nKey, candG + Math.hypot(goalGx - jx * CELL_SIZE_M, goalGy - (GRID_H - 1) * CELL_SIZE_M));
        }
      }
    }
  }

  return null;
}

function isSeaSegmentClear(a, b, seaComp) {
  if (a.c !== b.c) return false;
  const steps = Math.max(Math.abs(b.ix - a.ix), Math.abs(b.iy - a.iy)) * 2;
  if (steps === 0) return true;
  const offset = a.c * GRID_TOTAL;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const gx = a.ix + (b.ix - a.ix) * t;
    const gy = a.iy + (b.iy - a.iy) * t;
    const ix0 = Math.floor(gx);
    const iy0 = Math.floor(gy);
    const ix1 = Math.ceil(gx);
    const iy1 = Math.ceil(gy);
    if (seaComp[offset + iy0 * GRID_W + ix0] !== 1) return false;
    if (seaComp[offset + iy1 * GRID_W + ix1] !== 1) return false;
  }
  return true;
}

function simplifySeaPolyline(rawPath, seaComp) {
  // Split at seam crossings so seam waypoints stay explicit
  const runs = [];
  let curRun = [rawPath[0]];
  for (let i = 1; i < rawPath.length; i++) {
    if (rawPath[i].c !== rawPath[i - 1].c) {
      runs.push(curRun);
      curRun = [rawPath[i]];
    } else {
      curRun.push(rawPath[i]);
    }
  }
  runs.push(curRun);

  const simplifiedRuns = runs.map((run) =>
    simplifyChain(run, 48.0, 6000.0, 1.0, (a, b) => isSeaSegmentClear(a, b, seaComp))
  );
  return simplifiedRuns.flat();
}

function dijkstraPath(adj, nodeById, startId, goalId) {
  const dist = new Map([[startId, 0.0]]);
  const prev = new Map();
  const heap = new MinHeap();
  heap.push(startId, 0.0);

  while (heap.size > 0) {
    const cur = heap.pop();
    if (cur === goalId) {
      const nodeIds = [];
      let k = cur;
      while (k) {
        nodeIds.push(k);
        k = prev.get(k);
      }
      nodeIds.reverse();
      return { totalLengthM: round2(dist.get(goalId)), nodeIds };
    }
    const d = dist.get(cur);
    for (const edge of adj.get(cur) || []) {
      const nd = d + edge.lengthM;
      if (nd < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, nd);
        prev.set(edge.to, cur);
        heap.push(edge.to, nd);
      }
    }
  }
  return null;
}

export function bakeLogisticsNavGraph({ writeFiles = true } = {}) {
  const worldMeta = JSON.parse(readFileSync(path.join(WORLD_DIST_DIR, "world_meta.json"), "utf8"));
  const dericostMeta = JSON.parse(readFileSync(path.join(WORLD_DIST_DIR, "dericost_meta.json"), "utf8"));
  const wt = readFileSync(path.join(WORLD_DIST_DIR, "world_types.u8"));
  const wh = readFileSync(path.join(WORLD_DIST_DIR, "world_height.u8"));
  const dt = readFileSync(path.join(WORLD_DIST_DIR, "dericost_types.u8"));
  const dh = readFileSync(path.join(WORLD_DIST_DIR, "dericost_height.u8"));

  assert.equal(wt.length, GRID_TOTAL);
  assert.equal(wh.length, GRID_TOTAL);
  assert.equal(dt.length, GRID_TOTAL);
  assert.equal(dh.length, GRID_TOTAL);
  const heightTable = worldMeta.landHeightTable;
  assert.equal(heightTable.length, 256);
  assert.deepEqual(heightTable, dericostMeta.landHeightTable);

  const towns = buildCanonicalTowns();
  const { seaComp, outerOceanCells } = floodFillOuterOcean(wt, dt);

  // Snap 11 Outer Ocean ports to nearest seaComp === 0 berth
  const ports = OUTER_OCEAN_PORTS.map((p) => {
    const g = worldToGrid(p.x, p.y, p.continentId);
    const tBuf = g.c === 0 ? wt : dt;
    const hBuf = g.c === 0 ? wh : dh;
    const berth = findNearestSeaBerth(g.c, g.ix, g.iy, seaComp, tBuf, 15);
    assert.ok(berth, `Failed to find Outer Ocean seaComp=0 berth for ${p.name}`);
    assert.equal(berth.terrainCode & 0x1F, 20, `Berth for ${p.name} must have (b & 0x1F) == 20`);
    return {
      portId: p.portId,
      id: p.id,
      name: p.name,
      basin: "outer_ocean",
      continent: p.continent,
      continentId: p.continentId,
      lb: p.lb,
      landblockId: p.landblockId >>> 0,
      x: p.x,
      y: p.y,
      z: heightTable[hBuf[g.iy * GRID_W + g.ix]],
      seaX: berth.ix * CELL_SIZE_M,
      seaY: (berth.c === 1 ? DERICOST_Y_OFFSET : 0.0) + berth.iy * CELL_SIZE_M,
      berthDistM: round2(berth.distM),
      terrainCode: berth.terrainCode,
      nodeId: `port_${p.portId}`,
      _grid: g,
      _berth: berth,
    };
  });

  // Extract Dereth & Dericost road networks (filtering <= 44 deg and bridging <= 96 m gaps)
  const derethRoadNet = extractRoadNetwork(0, wt, wh, heightTable);
  const dericostRoadNet = extractRoadNetwork(1, dt, dh, heightTable);
  assert.equal(derethRoadNet.verts.length, 7945);
  assert.equal(dericostRoadNet.verts.length, 16643);
  assert.equal(dericostRoadNet.compSizes.size, 1, "Dericost roads must form 1 connected component");

  let derethMainRoot = -1;
  let derethMainSize = 0;
  for (const [r, sz] of derethRoadNet.compSizes.entries()) {
    if (sz > derethMainSize) {
      derethMainSize = sz;
      derethMainRoot = r;
    }
  }
  assert.equal(derethMainSize, 5986);

  // Locate island road components via known island town hubs
  const viamontiaSeed = findNearestVertexInSet(0, Math.round(9851.1 / 24), Math.round(41764.3 / 24), derethRoadNet.verts, () => true);
  const viamontiaRoot = derethRoadNet.compRoot[viamontiaSeed.vi];
  const maraeSeed = findNearestVertexInSet(0, Math.round(6384.2 / 24), Math.round(33957.9 / 24), derethRoadNet.verts, () => true);
  const maraeRoot = derethRoadNet.compRoot[maraeSeed.vi];

  // Track pinned road vertices and off-road spurs
  const pinnedDerethRoad = new Set();
  const pinnedDericostRoad = new Set();
  const spurChains = []; // { fromId, toId, points, is4wdLow, isFord, roadAttachVi, roadAttachContinent }

  const nodes = [];
  const nodeById = new Map();
  const addNode = (node) => {
    assert.ok(!nodeById.has(node.id), `Duplicate node id ${node.id}`);
    nodeById.set(node.id, node);
    nodes.push(node);
    return node;
  };

  // Add town & port primary nodes
  for (const t of towns) {
    addNode({
      id: t.nodeId,
      kind: "town",
      townId: t.townId,
      name: t.name,
      continent: t.continent,
      continentId: t.continentId,
      x: t.x,
      y: t.y,
      z: t.z,
    });
  }
  for (const p of ports) {
    addNode({
      id: p.nodeId,
      kind: "port",
      portId: p.portId,
      name: p.name,
      lb: p.lb,
      basin: "outer_ocean",
      continent: p.continent,
      continentId: p.continentId,
      x: p.x,
      y: p.y,
      z: p.z,
      terrainCode: p.terrainCode,
    });
  }

  // Coastal landings for Halaetan (Eastwatch, Fiun Outpost -> Port Sanamar) & Aerlinthe (Oolutanga's Refuge -> Port Eastham)
  const halaetanInfo = findIslandCoastalLanding(
    0,
    Math.round(14086.0 / 24),
    Math.round(46150.0 / 24),
    ports[6]._grid.ix,
    ports[6]._grid.iy,
    seaComp,
    wt,
    wh,
    heightTable
  );
  assert.ok(halaetanInfo.shore && halaetanInfo.berth, "Halaetan coastal landing must exist");
  const halaetanLandingId = "coastal_landing_halaetan";
  addNode({
    id: halaetanLandingId,
    kind: "coastal_landing",
    name: "Halaetan Coastal Landing",
    continent: "Dereth",
    continentId: 0,
    x: halaetanInfo.shore.x,
    y: halaetanInfo.shore.y,
    z: halaetanInfo.shore.z,
    terrainCode: halaetanInfo.shore.terrainCode,
  });

  const aerlintheInfo = findIslandCoastalLanding(
    0,
    Math.round(47377.7 / 24),
    Math.round(25009.9 / 24),
    ports[2]._grid.ix,
    ports[2]._grid.iy,
    seaComp,
    wt,
    wh,
    heightTable
  );
  assert.ok(aerlintheInfo.shore && aerlintheInfo.berth, "Aerlinthe coastal landing must exist");
  const aerlintheLandingId = "coastal_landing_aerlinthe";
  addNode({
    id: aerlintheLandingId,
    kind: "coastal_landing",
    name: "Aerlinthe Coastal Landing",
    continent: "Dereth",
    continentId: 0,
    x: aerlintheInfo.shore.x,
    y: aerlintheInfo.shore.y,
    z: aerlintheInfo.shore.z,
    terrainCode: aerlintheInfo.shore.terrainCode,
  });

  const VIAMONTIA_TOWNS = new Set([2, 34, 38]);
  const MARAE_TOWNS = new Set([39, 40, 41, 44, 45]);
  const VESAYEN_TOWNS = new Set([33, 46]);
  const VISSIDAL_TOWNS = new Set([47]);
  const HALAETAN_TOWNS = new Set([35, 53]);
  const AERLINTHE_TOWNS = new Set([43]);

  // Connect all 101 towns via 8-neighbor terrain A* spurs
  for (const t of towns) {
    const c = t.continentId;
    const tBuf = c === 0 ? wt : dt;
    const hBuf = c === 0 ? wh : dh;
    const g = worldToGrid(t.x, t.y, c);

    let matcher;
    let hint;
    let targetType = "road";
    let fixedGoalId = null;

    if (c === 1) {
      const targetVert = findNearestVertexInSet(1, g.ix, g.iy, dericostRoadNet.verts, () => true);
      hint = targetVert;
      matcher = (local) => dericostRoadNet.vertMap[local] >= 0;
    } else if (VIAMONTIA_TOWNS.has(t.townId)) {
      hint = findNearestVertexInSet(0, g.ix, g.iy, derethRoadNet.verts, (v) => derethRoadNet.compRoot[v.vi] === viamontiaRoot);
      matcher = (local) => {
        const vi = derethRoadNet.vertMap[local];
        return vi >= 0 && derethRoadNet.compRoot[vi] === viamontiaRoot;
      };
    } else if (MARAE_TOWNS.has(t.townId)) {
      hint = findNearestVertexInSet(0, g.ix, g.iy, derethRoadNet.verts, (v) => derethRoadNet.compRoot[v.vi] === maraeRoot);
      matcher = (local) => {
        const vi = derethRoadNet.vertMap[local];
        return vi >= 0 && derethRoadNet.compRoot[vi] === maraeRoot;
      };
    } else if (VESAYEN_TOWNS.has(t.townId)) {
      targetType = "node";
      fixedGoalId = ports[8].nodeId; // Port Kryst
      hint = ports[8]._grid;
      matcher = (local) => local === hint.iy * GRID_W + hint.ix;
    } else if (VISSIDAL_TOWNS.has(t.townId)) {
      targetType = "node";
      fixedGoalId = ports[9].nodeId; // Port Vissidal
      hint = ports[9]._grid;
      matcher = (local) => local === hint.iy * GRID_W + hint.ix;
    } else if (HALAETAN_TOWNS.has(t.townId)) {
      targetType = "node";
      fixedGoalId = halaetanLandingId;
      hint = halaetanInfo.shore;
      matcher = (local) => local === halaetanInfo.shore.local;
    } else if (AERLINTHE_TOWNS.has(t.townId)) {
      targetType = "node";
      fixedGoalId = aerlintheLandingId;
      hint = aerlintheInfo.shore;
      matcher = (local) => local === aerlintheInfo.shore.local;
    } else {
      hint = findNearestVertexInSet(0, g.ix, g.iy, derethRoadNet.verts, (v) => derethRoadNet.compRoot[v.vi] === derethMainRoot);
      matcher = (local) => {
        const vi = derethRoadNet.vertMap[local];
        return vi >= 0 && derethRoadNet.compRoot[vi] === derethMainRoot;
      };
    }

    let is4wdLow = false;
    let pathPts = findTerrainSpurAStar(c, t.x, t.y, t.z, matcher, hint, tBuf, hBuf, heightTable, MAX_STD_SPUR_GRADE_DEG, 1);
    if (!pathPts) {
      is4wdLow = true;
      pathPts = findTerrainSpurAStar(c, t.x, t.y, t.z, matcher, hint, tBuf, hBuf, heightTable, MAX_4WD_SPUR_GRADE_DEG, 1)
        || findTerrainSpurAStar(c, t.x, t.y, t.z, matcher, hint, tBuf, hBuf, heightTable, MAX_4WD_SPUR_GRADE_DEG, 3);
    }
    assert.ok(pathPts && pathPts.length >= 1, `Failed to connect town ${t.townId} (${t.name}) via A*`);

    const lastPt = pathPts[pathPts.length - 1];
    let toId = fixedGoalId;
    if (targetType === "road") {
      const roadNet = c === 0 ? derethRoadNet : dericostRoadNet;
      const vi = roadNet.vertMap[lastPt.local];
      assert.ok(vi >= 0, `Expected road vertex at spur end for ${t.name}`);
      if (c === 0) pinnedDerethRoad.add(vi);
      else pinnedDericostRoad.add(vi);
      toId = `road_${c}_${vi}`;
      t.nearestRoadNodeId = toId;
    } else {
      t.nearestRoadNodeId = fixedGoalId;
    }

    const maxSpurGrade = is4wdLow ? MAX_4WD_SPUR_GRADE_DEG : MAX_STD_SPUR_GRADE_DEG;
    const exactStart = { c, x: t.x, y: t.y, z: t.z, isFord: false };
    const snapDist = Math.hypot(pathPts[0].x - t.x, pathPts[0].y - t.y);
    const canReplaceFirst = snapDist <= 0.25 && (pathPts.length === 1 || calcGradeDeg(t.x, t.y, t.z, pathPts[1].x, pathPts[1].y, pathPts[1].z) <= maxSpurGrade);
    const fullPts = canReplaceFirst ? [{ ...pathPts[0], x: t.x, y: t.y, z: t.z }, ...pathPts.slice(1)] : [exactStart, ...pathPts];

    const simplified = fullPts.length >= 2 ? simplifyChain(fullPts, 6.0, 240.0, maxSpurGrade) : [exactStart, lastPt];
    let totalSpurLen = 0;
    for (let k = 0; k < simplified.length - 1; k++) {
      totalSpurLen += Math.hypot(simplified[k + 1].x - simplified[k].x, simplified[k + 1].y - simplified[k].y);
    }
    t.roadAttachDistM = round2(totalSpurLen);
    t.reachability = is4wdLow ? "spur_4wd_low_40deg" : "spur_25deg";

    spurChains.push({
      fromId: t.nodeId,
      toId,
      points: simplified,
      is4wdLow,
      maxGradeDeg: maxSpurGrade,
      continentId: c,
    });
  }

  // Connect overland ports (ports 2,3,4,5,6,7,8; ports 9 & 10 receive town spurs directly; ports 1 & 11 are sea-only)
  const PORT_ROAD_TARGETS = new Map([
    [2, { c: 1, comp: "dericost" }],
    [3, { c: 0, comp: derethMainRoot }],
    [4, { c: 0, comp: derethMainRoot }],
    [5, { c: 0, comp: derethMainRoot }],
    [6, { c: 0, comp: derethMainRoot }],
    [7, { c: 0, comp: viamontiaRoot }],
    [8, { c: 0, comp: maraeRoot }],
  ]);

  for (const p of ports) {
    const spec = PORT_ROAD_TARGETS.get(p.portId);
    if (!spec) {
      p.nearestRoadNodeId = p.nodeId;
      continue;
    }
    const c = spec.c;
    const tBuf = c === 0 ? wt : dt;
    const hBuf = c === 0 ? wh : dh;
    const roadNet = c === 0 ? derethRoadNet : dericostRoadNet;
    const g = p._grid;

    const hint = findNearestVertexInSet(
      c,
      g.ix,
      g.iy,
      roadNet.verts,
      (v) => (c === 1 ? true : roadNet.compRoot[v.vi] === spec.comp)
    );
    const matcher = (local) => {
      const vi = roadNet.vertMap[local];
      if (vi < 0) return false;
      return c === 1 ? true : roadNet.compRoot[vi] === spec.comp;
    };

    const pathPts = findTerrainSpurAStar(c, p.x, p.y, p.z, matcher, hint, tBuf, hBuf, heightTable, MAX_STD_SPUR_GRADE_DEG, 3);
    assert.ok(pathPts && pathPts.length >= 1, `Failed to connect port ${p.name} to road network`);

    const lastPt = pathPts[pathPts.length - 1];
    const vi = roadNet.vertMap[lastPt.local];
    if (c === 0) pinnedDerethRoad.add(vi);
    else pinnedDericostRoad.add(vi);
    const toId = `road_${c}_${vi}`;
    p.nearestRoadNodeId = toId;

    const exactStart = { c, x: p.x, y: p.y, z: p.z, isFord: false };
    const snapDist = Math.hypot(pathPts[0].x - p.x, pathPts[0].y - p.y);
    const canReplaceFirst = snapDist <= 0.25 && (pathPts.length === 1 || calcGradeDeg(p.x, p.y, p.z, pathPts[1].x, pathPts[1].y, pathPts[1].z) <= MAX_STD_SPUR_GRADE_DEG);
    const fullPts = canReplaceFirst ? [{ ...pathPts[0], x: p.x, y: p.y, z: p.z }, ...pathPts.slice(1)] : [exactStart, ...pathPts];
    const simplified = fullPts.length >= 2 ? simplifyChain(fullPts, 6.0, 240.0, MAX_STD_SPUR_GRADE_DEG) : [exactStart, lastPt];
    spurChains.push({
      fromId: p.nodeId,
      toId,
      points: simplified,
      is4wdLow: false,
      maxGradeDeg: MAX_STD_SPUR_GRADE_DEG,
      continentId: c,
    });
  }

  // Simplify Dereth & Dericost road graphs and add nodes + edges
  const edges = [];
  let edgeSeq = 0;
  const pushEdge = (e) => {
    const id = `e_${edgeSeq++}`;
    edges.push({ id, ...e });
  };

  for (const [c, roadNet, pinnedSet] of [
    [0, derethRoadNet, pinnedDerethRoad],
    [1, dericostRoadNet, pinnedDericostRoad],
  ]) {
    const { keptVerts, simplifiedEdges } = simplifyRoadGraph(c, roadNet, pinnedSet);
    for (const vi of keptVerts) {
      const v = roadNet.verts[vi];
      addNode({
        id: `road_${c}_${vi}`,
        kind: "road",
        continent: c === 0 ? "Dereth" : "Dericost",
        continentId: c,
        x: v.x,
        y: v.y,
        z: v.z,
        terrainCode: v.terrainCode,
      });
    }
    for (const se of simplifiedEdges) {
      const fromId = `road_${c}_${se.a}`;
      const toId = `road_${c}_${se.b}`;
      pushEdge({
        from: fromId,
        to: toId,
        mode: "road",
        lengthM: se.lengthM,
        distanceM: se.lengthM,
        gradeDeg: se.gradeDeg,
        maxSlopeDeg: se.gradeDeg,
        is4wdLow: false,
        isBridge: se.isBridge,
        isFord: false,
        continentId: c,
      });
    }
  }

  // Emit simplified spur chains
  let spurWpSeq = 0;
  for (const sp of spurChains) {
    const pts = sp.points;
    let prevId = sp.fromId;
    for (let k = 1; k < pts.length; k++) {
      const curPt = pts[k];
      const isLast = k === pts.length - 1;
      let curId;
      if (isLast) {
        curId = sp.toId;
      } else {
        curId = `spur_${spurWpSeq++}`;
        addNode({
          id: curId,
          kind: "spur_waypoint",
          continent: sp.continentId === 0 ? "Dereth" : "Dericost",
          continentId: sp.continentId,
          x: round2(curPt.x),
          y: round2(curPt.y),
          z: round2(curPt.z),
        });
      }
      if (prevId === curId) continue;
      const aNode = nodeById.get(prevId);
      const bNode = nodeById.get(curId);
      const lengthM = round2(Math.hypot(bNode.x - aNode.x, bNode.y - aNode.y));
      const gradeDeg = round2(calcGradeDeg(aNode.x, aNode.y, aNode.z, bNode.x, bNode.y, bNode.z));
      assert.ok(gradeDeg <= sp.maxGradeDeg + 0.05, `Spur ${sp.fromId}->${sp.toId} grade ${gradeDeg} > ${sp.maxGradeDeg}`);
      pushEdge({
        from: prevId,
        to: curId,
        mode: "spur",
        lengthM,
        distanceM: lengthM,
        gradeDeg,
        maxSlopeDeg: gradeDeg,
        is4wdLow: sp.is4wdLow || gradeDeg > MAX_STD_SPUR_GRADE_DEG,
        isBridge: false,
        isFord: Boolean(curPt.isFord || pts[k - 1].isFord),
        continentId: sp.continentId,
      });
      prevId = curId;
    }
  }

  // Build Outer Ocean Sea Lanes over seaComp === 1 (excluding Item 2)
  const SEA_LANE_PAIRS = [
    [1, 2],  // NE Marine Terminal <-> Dericost Landing (~35.43 km)
    [1, 10], // NE Marine Terminal <-> Port Vissidal
    [1, 3],  // NE Marine Terminal <-> Port Eastham
    [1, 5],  // NE Marine Terminal <-> Port North-Watch
    [2, 5],  // Dericost Landing <-> Port North-Watch
    [2, 10], // Dericost Landing <-> Port Vissidal
    [5, 7],  // Port North-Watch <-> Port Sanamar
    [7, 8],  // Port Sanamar <-> Port Bluespire
    [8, 11], // Port Bluespire <-> Port Singularity Caul
    [11, 6], // Port Singularity Caul <-> Port Direlands-South
    [6, 9],  // Port Direlands-South <-> Port Kryst
    [9, 4],  // Port Kryst <-> Port Hebian-To
    [4, 3],  // Port Hebian-To <-> Port Eastham
    [3, 10], // Port Eastham <-> Port Vissidal
  ];

  const seaLanes = [];
  let seaWpSeq = 0;

  function addSeaConnection(fromNodeId, toNodeId, startBerth, goalBerth, meta) {
    const rawPath = findSeaLaneAStar(startBerth, goalBerth, seaComp);
    assert.ok(rawPath && rawPath.length >= 2, `Sea A* failed for ${fromNodeId} <-> ${toNodeId}`);
    const simplified = simplifySeaPolyline(rawPath, seaComp);
    const fromNode = nodeById.get(fromNodeId);
    const toNode = nodeById.get(toNodeId);

    const waypoints = [[round2(fromNode.x), round2(fromNode.y), 0]];
    let prevId = fromNodeId;
    let totalLen = 0;

    for (let k = 0; k < simplified.length; k++) {
      const pt = simplified[k];
      const dPrev = Math.hypot(pt.x - nodeById.get(prevId).x, pt.y - nodeById.get(prevId).y);
      if (dPrev < 1.0) continue;
      const wpId = `sea_wp_${seaWpSeq++}`;
      addNode({
        id: wpId,
        kind: "sea_waypoint",
        basin: "outer_ocean",
        continent: pt.c === 0 ? "Dereth" : "Dericost",
        continentId: pt.c,
        x: round2(pt.x),
        y: round2(pt.y),
        z: 0,
      });
      pushEdge({
        from: prevId,
        to: wpId,
        mode: "sea",
        basin: "outer_ocean",
        lengthM: round2(dPrev),
        distanceM: round2(dPrev),
        gradeDeg: 0,
        maxSlopeDeg: 0,
        is4wdLow: false,
        isBridge: false,
        isFord: false,
      });
      waypoints.push([round2(pt.x), round2(pt.y), 0]);
      totalLen += dPrev;
      prevId = wpId;
    }

    const dEnd = Math.hypot(toNode.x - nodeById.get(prevId).x, toNode.y - nodeById.get(prevId).y);
    pushEdge({
      from: prevId,
      to: toNodeId,
      mode: "sea",
      basin: "outer_ocean",
      lengthM: round2(dEnd),
      distanceM: round2(dEnd),
      gradeDeg: 0,
      maxSlopeDeg: 0,
      is4wdLow: false,
      isBridge: false,
      isFord: false,
    });
    waypoints.push([round2(toNode.x), round2(toNode.y), 0]);
    totalLen += dEnd;

    if (meta.isPortLane) {
      seaLanes.push({
        id: `sea_${meta.fromPort.portId}_${meta.toPort.portId}`,
        from: fromNodeId,
        to: toNodeId,
        fromName: meta.fromPort.name,
        toName: meta.toPort.name,
        fromLb: meta.fromPort.lb,
        toLb: meta.toPort.lb,
        basin: "outer_ocean",
        mode: "sea",
        gradeDeg: 0,
        lengthM: round2(totalLen),
        distanceM: round2(totalLen),
        waypoints,
      });
    }
  }

  for (const [pA, pB] of SEA_LANE_PAIRS) {
    const portA = ports[pA - 1];
    const portB = ports[pB - 1];
    addSeaConnection(portA.nodeId, portB.nodeId, portA._berth, portB._berth, {
      isPortLane: true,
      fromPort: portA,
      toPort: portB,
    });
  }

  // Island coastal barge sea links (non-port coastal_landing -> nearest Outer Ocean port)
  addSeaConnection(halaetanLandingId, ports[6].nodeId, halaetanInfo.berth, ports[6]._berth, { isPortLane: false });
  addSeaConnection(aerlintheLandingId, ports[2].nodeId, aerlintheInfo.berth, ports[2]._berth, { isPortLane: false });

  // Build adjacency list to verify full reachability & compute canonical routes
  const adj = new Map();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) {
    adj.get(e.from).push({ to: e.to, lengthM: e.lengthM });
    adj.get(e.to).push({ to: e.from, lengthM: e.lengthM });
  }

  // BFS reachability from town_1 (Holtburg)
  const visitedAll = new Set(["town_1"]);
  const bfsQ = ["town_1"];
  for (let i = 0; i < bfsQ.length; i++) {
    const cur = bfsQ[i];
    for (const step of adj.get(cur) || []) {
      if (!visitedAll.has(step.to)) {
        visitedAll.add(step.to);
        bfsQ.push(step.to);
      }
    }
  }
  for (const t of towns) {
    assert.ok(visitedAll.has(t.nodeId), `Town ${t.townId} (${t.name}) is NOT reachable from Holtburg!`);
  }
  for (const p of ports) {
    assert.ok(visitedAll.has(p.nodeId), `Port ${p.name} is NOT reachable from Holtburg!`);
  }

  // Compute precomputed trunk & town-to-nearest-port routes
  const routes = [];
  const neToDericost = dijkstraPath(adj, nodeById, ports[0].nodeId, ports[1].nodeId);
  assert.ok(neToDericost, "NE Marine Terminal <-> Dericost Landing route must exist");
  routes.push({
    fromId: ports[0].nodeId,
    toId: ports[1].nodeId,
    fromName: ports[0].name,
    toName: ports[1].name,
    fromLb: ports[0].lb,
    toLb: ports[1].lb,
    mode: "sea",
    basin: "outer_ocean",
    totalLengthM: neToDericost.totalLengthM,
    nodeIds: neToDericost.nodeIds,
  });

  const holtburgToVasmora = dijkstraPath(adj, nodeById, "town_1", "town_61");
  assert.ok(holtburgToVasmora, "Holtburg <-> Vasmora intermodal route must exist");
  routes.push({
    fromId: "town_1",
    toId: "town_61",
    fromName: "Holtburg",
    toName: "Vasmora",
    mode: "intermodal",
    totalLengthM: holtburgToVasmora.totalLengthM,
    nodeIds: holtburgToVasmora.nodeIds,
  });

  // Clean internal fields from towns and ports
  const cleanTowns = towns.map((t) => ({
    townId: t.townId,
    id: t.id,
    name: t.name,
    continent: t.continent,
    continentId: t.continentId,
    tier: t.tier,
    province: t.province,
    anchorLandblock: t.anchorLandblock,
    anchorLandblockId: t.anchorLandblockId,
    x: t.x,
    y: t.y,
    z: t.z,
    baseVendorCount: t.baseVendorCount,
    nodeId: t.nodeId,
    nearestRoadNodeId: t.nearestRoadNodeId,
    roadAttachDistM: t.roadAttachDistM,
    reachability: t.reachability,
  }));

  const cleanPorts = ports.map((p) => ({
    portId: p.portId,
    id: p.id,
    name: p.name,
    basin: p.basin,
    continent: p.continent,
    continentId: p.continentId,
    lb: p.lb,
    landblockId: p.landblockId,
    x: p.x,
    y: p.y,
    z: p.z,
    seaX: p.seaX,
    seaY: p.seaY,
    berthDistM: p.berthDistM,
    terrainCode: p.terrainCode,
    nodeId: p.nodeId,
    nearestRoadNodeId: p.nearestRoadNodeId,
  }));

  let roadEdgeCount = 0;
  let spurEdgeCount = 0;
  let seaEdgeCount = 0;
  let bridgeCount = 0;
  let fordCount = 0;
  let fourWdLowCount = 0;
  let maxEdgeGradeDeg = 0;

  for (const e of edges) {
    if (e.mode === "road") roadEdgeCount++;
    else if (e.mode === "spur") spurEdgeCount++;
    else if (e.mode === "sea") seaEdgeCount++;
    if (e.isBridge) bridgeCount++;
    if (e.isFord) fordCount++;
    if (e.is4wdLow) fourWdLowCount++;
    if (e.gradeDeg > maxEdgeGradeDeg) maxEdgeGradeDeg = e.gradeDeg;
    assert.ok(e.gradeDeg <= MAX_ROAD_EDGE_GRADE_DEG, `Edge ${e.id} gradeDeg ${e.gradeDeg} > 44`);
  }

  const graph = {
    schema: "hb-logistics-nav-graph-v1",
    version: 1,
    dericostYOffset: DERICOST_Y_OFFSET,
    basins: {
      outer_ocean: {
        name: "Outer Ocean",
        terrainCode: 20,
        portCount: cleanPorts.length,
        seaCells: outerOceanCells,
      },
    },
    towns: cleanTowns,
    ports: cleanPorts,
    nodes,
    edges,
    seaLanes,
    routes,
    summary: {
      townCount: cleanTowns.length,
      derethTownCount: 60,
      dericostTownCount: 41,
      portCount: cleanPorts.length,
      derethRoadVertices: derethRoadNet.verts.length,
      dericostRoadVertices: dericostRoadNet.verts.length,
      roadVertexCount: derethRoadNet.verts.length + dericostRoadNet.verts.length,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      roadEdgeCount,
      spurEdgeCount,
      seaEdgeCount,
      bridgeCount,
      fordCount,
      fourWdLowCount,
      seaLaneCount: seaLanes.length,
      routeCount: routes.length,
      maxEdgeGradeDeg: round2(maxEdgeGradeDeg),
      maxBridgeGapM: MAX_BRIDGE_GAP_M,
      outerOceanCells,
    },
  };

  // Strict Item 2 exclusion verification on serialized JSON
  const serialized = JSON.stringify(graph);
  const lower = serialized.toLowerCase();
  for (const forbidden of ["port yaraq", "portyaraq", "direlands-east", "direlands east", "inner_sea", "innersea", "0x7a63", "0x4866"]) {
    assert.equal(lower.includes(forbidden), false, `Forbidden Item 2 token detected in output JSON: ${forbidden}`);
  }

  if (writeFiles) {
    mkdirSync(path.dirname(PRIMARY_OUT_PATH), { recursive: true });
    writeFileSync(PRIMARY_OUT_PATH, serialized, "utf8");
    let mirrored = false;
    if (existsSync(WORLD_DIST_DIR)) {
      try {
        writeFileSync(MIRROR_OUT_PATH, serialized, "utf8");
        mirrored = true;
      } catch (err) {
        console.warn(`[warn] Could not mirror to ${MIRROR_OUT_PATH}: ${err.message}`);
      }
    }
    return { graph, serialized, primaryOut: PRIMARY_OUT_PATH, mirrorOut: mirrored ? MIRROR_OUT_PATH : null };
  }

  return { graph, serialized, primaryOut: null, mirrorOut: null };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isCli) {
  const res = bakeLogisticsNavGraph({ writeFiles: true });
  const s = res.graph.summary;
  console.log(
    `Baked logistics_nav_graph.json: towns=${s.townCount} (${s.derethTownCount}+${s.dericostTownCount}), ` +
    `ports=${s.portCount}, roadVerts=${s.roadVertexCount} (${s.derethRoadVertices}+${s.dericostRoadVertices}), ` +
    `nodes=${s.nodeCount}, edges=${s.edgeCount} (road=${s.roadEdgeCount}, spur=${s.spurEdgeCount}, sea=${s.seaEdgeCount}), ` +
    `seaLanes=${s.seaLaneCount}, maxGrade=${s.maxEdgeGradeDeg} deg, bytes=${res.serialized.length}`
  );
  if (res.mirrorOut) console.log(`Mirrored identical JSON to ${res.mirrorOut}`);
}
