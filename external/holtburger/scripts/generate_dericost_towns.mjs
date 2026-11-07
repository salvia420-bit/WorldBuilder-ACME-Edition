#!/usr/bin/env node
/**
 * external/holtburger/scripts/generate_dericost_towns.mjs
 * Complete Town Locations, Building Models & Door Frameworks Generator for Dericost (Milestone 4).
 *
 * Conforms to:
 * - ORIGINAL_REQUEST §R3 (41 towns matching Dereth baseline, lore-grounded architecture)
 * - PROJECT.md §Feature 14, 15, 16
 * - BuildingAnalyzer.cs validation rules:
 *     CellCount >= 4, PortalCount >= 2, TotalStatics >= 14, AvgPerLB < 1.35, MaxPerLB < 3
 *     Room bounds >= 2.5m x 2.5m x 2.2m, Door clearances >= 1.4m x 2.2m, BFS reachability
 * - Explorer 1 (canonical geodetic directory, 288m clearance exclusion verified)
 * - Explorer 2 (18 building archetypes & blueprint schema)
 * - Explorer 3 (door hinge entities, 90° rotation, Bit 15 continent discrimination)
 *
 * Emits:
 * - dist/dericost/towns/dericost_towns_index.json
 * - dist/dericost/towns/town_<slug>.json (41 files)
 * - dist/dericost/towns/blueprints/*.blueprint.json (18 blueprints)
 * - dist/dericost/buildings/0xXXXX.buildings.jsonl (per-landblock streaming records)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST_DERICOST = path.resolve(ROOT, 'dist/dericost');
const TOWNS_DIR = path.resolve(DIST_DERICOST, 'towns');
const BLUEPRINTS_DIR = path.resolve(TOWNS_DIR, 'blueprints');
const BUILDINGS_DIR = path.resolve(DIST_DERICOST, 'buildings');
const SCENERY_DIR = path.resolve(DIST_DERICOST, 'scenery');

fs.mkdirSync(TOWNS_DIR, { recursive: true });
fs.mkdirSync(BLUEPRINTS_DIR, { recursive: true });
fs.mkdirSync(BUILDINGS_DIR, { recursive: true });

const SOLID_SCENERY_IDS = new Set([
  '0x01100002', '0x01100012', '0x01100015', // Monoliths & Obelisks
  '0x02100001', '0x02100002', '0x02100005', '0x02100008', '0x02100009', // Tall Trees
  '0x01100001', '0x01100011', '0x01100003', '0x01100004', '0x01100014', '0x01100018', '0x01100019' // Solid Rocks
]);

// Load terrain data
const meta = JSON.parse(fs.readFileSync(path.join(DIST_DERICOST, 'dericost_meta.json'), 'utf8'));
const heightU8 = fs.readFileSync(path.join(DIST_DERICOST, 'dericost_height.u8'));
const typesU8 = fs.readFileSync(path.join(DIST_DERICOST, 'dericost_types.u8'));
const landHeightTable = meta.landHeightTable;

// Sample terrain height
function sampleTerrainHeight(lbX, lbY, lx, ly) {
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

// Sample terrain height and slope
function sampleTerrain(lbX, lbY, lx, ly) {
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
  const z = h0 * (1 - ty) + h1 * ty;

  const dzdx = (h10 - h00) / 24.0;
  const dzdy = (h01 - h00) / 24.0;
  const len = Math.hypot(dzdx, dzdy, 1.0);
  const nz = 1.0 / len;
  const slopeDeg = Math.acos(Math.max(-1.0, Math.min(1.0, nz))) * 180.0 / Math.PI;

  return { z, slopeDeg };
}

// 41 Canonical Towns across 6 provinces
const DERICOST_PROVINCES = {
  'Gelid Plateau': {
    culture: 'Undead Oligarchs / Filinuvekta',
    architecture: 'Monolithic black basalt & obsidian crypt-palaces',
    towns: [
      'Vasmora', 'Frore', 'Frisirth', 'Minesh', 'Kelnir',
      'Gelid-Keep', 'Coldwatch', 'Boreal-Spires', 'Saliane', 'Glacier-Reach'
    ]
  },
  'Ashatiri Lowlands': {
    culture: 'Living Serfs & Nobles',
    architecture: 'Cyclopean dark granite & fortified timber guildhalls',
    towns: [
      'Antaoc', 'Hirschi', 'Nehane', 'Stone-Cleft',
      'Iron-Garrison', 'Grymar\'s Stand', 'Cynreft', 'High-Quarry'
    ]
  },
  'Valley of Tresimaen': {
    culture: 'Living Nobles & Latzimestal',
    architecture: 'Volcanic slate villas & thermal terraced arcades',
    towns: [
      'Cannthalo', 'Zemal Foothills', 'Tresimaen', 'Hendrel\'s Gate',
      'Obsidian-Bluff', 'Ash-Haven', 'Sulfur-Springs', 'Orisis-Deep'
    ]
  },
  'Dericost Marshes': {
    culture: 'Undead Oligarchs / House Mhoire',
    architecture: 'Stilted fen-manors & petrified timber causeways',
    towns: [
      'Daralet', 'Fen-Gate', 'Mhoire-Crosse', 'Bog-Haven',
      'Weeping-Creek', 'Mire-Watch'
    ]
  },
  'The High Desert Plateau': {
    culture: 'High Desert Nomads / Sand Kings',
    architecture: 'Sun-baked adobe citadels & open caravanserai courts',
    towns: [
      'Shakrassekor', 'Berkesh', 'Ayn Tayan', 'Harebach Crose',
      'Sand-Bastion', 'Pines-Foot'
    ]
  },
  'Nesortania Maritime Coast': {
    culture: 'Living Nobles & Imperial Navy',
    architecture: 'Marine limestone port wharves & coastal seawall keeps',
    towns: [
      'Nesortania', 'Galleys-Anchorage', 'South-Haven'
    ]
  }
};

const zoneBounds = {
  'Nesortania Maritime Coast': { xMin: 15000, xMax: 35000, yMin: 69500, yMax: 76000 },
  'The High Desert Plateau': { xMin: 25000, xMax: 47000, yMin: 76000, yMax: 88000 },
  'Dericost Marshes': { xMin: 2000, xMax: 24000, yMin: 76000, yMax: 88000 },
  'Valley of Tresimaen': { xMin: 20000, xMax: 45000, yMin: 88000, yMax: 102000 },
  'Ashatiri Lowlands': { xMin: 3000, xMax: 22000, yMin: 88000, yMax: 102000 },
  'Gelid Plateau': { xMin: 5000, xMax: 45000, yMin: 102000, yMax: 116000 },
};

function slugify(name) {
  return name.toLowerCase().replace(/['\s-]+/g, '_').replace(/^_+|_+$/g, '');
}

// ---------------------------------------------------------------------------
// 18 BUILDING ARCHETYPES DEFINITION
// ---------------------------------------------------------------------------

function makeCell(cellId, name, relativeOrigin, boundsWidth, boundsDepth, boundsHeight, portals, statics) {
  return {
    cellId,
    hexCellId: '0x' + cellId.toString(16).toUpperCase().padStart(4, '0'),
    name,
    relativeOrigin,
    bounds: {
      min: [-boundsWidth / 2, -boundsDepth / 2, 0.0],
      max: [boundsWidth / 2, boundsDepth / 2, boundsHeight]
    },
    portals,
    statics
  };
}

function makePortal(portalId, toCell, otherPortalId, clearance = [1.6, 2.4]) {
  return {
    portalId,
    toCell, // "outdoor" or integer cellId
    otherPortalId,
    clearance
  };
}

function makeStatic(did, name, pos, rot = [0, 0, 0, 1]) {
  return { did, name, pos, rot };
}

// Author the 18 distinct building archetypes satisfying BuildingAnalyzer.cs
const BLUEPRINT_DEFS = [
  // 1. Undead Oligarch Necrotic Palace (0x01100001) - 6 cells, 32 statics, 7 portals
  {
    modelId: 0x01100001,
    hexModelId: '0x01100001',
    name: 'Undead_Oligarch_Necrotic_Palace',
    culture: 'UndeadOligarch',
    province: 'Gelid Plateau',
    footprint: { widthMeters: 42.0, depthMeters: 36.0, heightMeters: 24.0 },
    numLeaves: 32,
    exteriorMesh: {
      surfaces: [
        { surfaceDid: 0x08100104, hexDid: '0x08100104', name: 'hexagonal_basalt_block', materialType: 'Base1Image' },
        { surfaceDid: 0x08100105, hexDid: '0x08100105', name: 'polished_obsidian_facet', materialType: 'Base1Image' }
      ],
      portals: [
        { portalId: 1, flags: 1, otherCellId: 0x0101, otherPortalId: 1, frameOrigin: [0.0, -18.0, 0.0], clearance: { width: 2.2, height: 2.8 } }
      ]
    },
    interiorCells: [
      makeCell(0x0101, 'Vestibule_of_Cold_Souls', [0.0, -14.0, 0.0], 8.0, 6.0, 5.0,
        [makePortal(1, 'outdoor', 1, [2.2, 2.8]), makePortal(2, 0x0102, 3)],
        [
          makeStatic(0x02100101, 'basalt_column', [-3.0, -2.0, 0.0]),
          makeStatic(0x02100101, 'basalt_column', [3.0, -2.0, 0.0]),
          makeStatic(0x02100102, 'soulfire_brazier', [-2.5, 1.5, 0.0]),
          makeStatic(0x02100102, 'soulfire_brazier', [2.5, 1.5, 0.0]),
          makeStatic(0x02100103, 'iron_candelabra', [0.0, 2.0, 0.0])
        ]
      ),
      makeCell(0x0102, 'Great_Throne_Hall', [0.0, 0.0, 0.0], 16.0, 14.0, 8.0,
        [makePortal(3, 0x0101, 2), makePortal(4, 0x0103, 5), makePortal(6, 0x0104, 7), makePortal(8, 0x0105, 9)],
        [
          makeStatic(0x02100104, 'obsidian_throne_of_sarvien', [0.0, 5.5, 0.5]),
          makeStatic(0x02100101, 'basalt_column', [-6.0, -4.0, 0.0]),
          makeStatic(0x02100101, 'basalt_column', [6.0, -4.0, 0.0]),
          makeStatic(0x02100101, 'basalt_column', [-6.0, 2.0, 0.0]),
          makeStatic(0x02100101, 'basalt_column', [6.0, 2.0, 0.0]),
          makeStatic(0x02100102, 'soulfire_brazier', [-4.0, 4.0, 0.0]),
          makeStatic(0x02100102, 'soulfire_brazier', [4.0, 4.0, 0.0]),
          makeStatic(0x02100105, 'necrotic_dais', [0.0, 5.0, 0.0]),
          makeStatic(0x02100106, 'black_iron_banner', [-7.0, 0.0, 3.5]),
          makeStatic(0x02100106, 'black_iron_banner', [7.0, 0.0, 3.5])
        ]
      ),
      makeCell(0x0103, 'Subterranean_Crypt_Vault', [-12.0, 0.0, -1.0], 10.0, 10.0, 4.5,
        [makePortal(5, 0x0102, 4)],
        [
          makeStatic(0x02100107, 'ancient_sarcophagus', [-3.0, 0.0, 0.0]),
          makeStatic(0x02100107, 'ancient_sarcophagus', [3.0, 0.0, 0.0]),
          makeStatic(0x02100108, 'embalming_altar', [0.0, 2.5, 0.0]),
          makeStatic(0x02100102, 'soulfire_brazier', [0.0, -3.0, 0.0]),
          makeStatic(0x02100109, 'urn_of_relics', [-3.5, 3.5, 0.0]),
          makeStatic(0x02100109, 'urn_of_relics', [3.5, 3.5, 0.0])
        ]
      ),
      makeCell(0x0104, 'Oligarch_Scriptorium', [12.0, 0.0, 0.0], 10.0, 10.0, 5.0,
        [makePortal(7, 0x0102, 6)],
        [
          makeStatic(0x02100110, 'grimoire_lectern', [0.0, 2.0, 0.0]),
          makeStatic(0x02100111, 'basalt_bookcase', [-3.5, 0.0, 0.0]),
          makeStatic(0x02100111, 'basalt_bookcase', [3.5, 0.0, 0.0]),
          makeStatic(0x02100112, 'astronomic_sphere', [0.0, -2.5, 0.0]),
          makeStatic(0x02100103, 'iron_candelabra', [-2.5, -2.5, 0.0])
        ]
      ),
      makeCell(0x0105, 'Sanctum_Antechamber', [0.0, 10.0, 0.0], 10.0, 6.0, 5.0,
        [makePortal(9, 0x0102, 8), makePortal(10, 0x0106, 11)],
        [
          makeStatic(0x02100101, 'basalt_column', [-3.5, 0.0, 0.0]),
          makeStatic(0x02100101, 'basalt_column', [3.5, 0.0, 0.0]),
          makeStatic(0x02100102, 'soulfire_brazier', [0.0, 1.5, 0.0])
        ]
      ),
      makeCell(0x0106, 'Inner_Reliquary_Vault', [0.0, 15.0, 0.0], 8.0, 6.0, 4.5,
        [makePortal(11, 0x0105, 10)],
        [
          makeStatic(0x02100113, 'spectral_crystal_phylactery', [0.0, 1.5, 0.5]),
          makeStatic(0x02100107, 'ancient_sarcophagus', [-2.5, 0.0, 0.0]),
          makeStatic(0x02100107, 'ancient_sarcophagus', [2.5, 0.0, 0.0])
        ]
      )
    ]
  },

  // 2. Basalt Crypt-Manor (0x01100002) - 4 cells, 20 statics, 4 portals
  {
    modelId: 0x01100002,
    hexModelId: '0x01100002',
    name: 'Basalt_Crypt_Manor',
    culture: 'UndeadOligarch',
    province: 'Gelid Plateau',
    footprint: { widthMeters: 28.0, depthMeters: 24.0, heightMeters: 16.0 },
    numLeaves: 16,
    exteriorMesh: {
      surfaces: [
        { surfaceDid: 0x08100104, hexDid: '0x08100104', name: 'hexagonal_basalt_block', materialType: 'Base1Image' }
      ],
      portals: [
        { portalId: 1, flags: 1, otherCellId: 0x0101, otherPortalId: 1, frameOrigin: [0.0, -12.0, 0.0], clearance: { width: 1.6, height: 2.4 } }
      ]
    },
    interiorCells: [
      makeCell(0x0101, 'Manor_Entry_Foyer', [0.0, -8.0, 0.0], 6.0, 6.0, 4.0,
        [makePortal(1, 'outdoor', 1), makePortal(2, 0x0102, 3)],
        [
          makeStatic(0x02100101, 'basalt_column', [-2.0, 0.0, 0.0]),
          makeStatic(0x02100101, 'basalt_column', [2.0, 0.0, 0.0]),
          makeStatic(0x02100103, 'iron_candelabra', [0.0, 1.5, 0.0]),
          makeStatic(0x02100106, 'black_iron_banner', [-2.5, 1.5, 2.0]),
          makeStatic(0x02100106, 'black_iron_banner', [2.5, 1.5, 2.0])
        ]
      ),
      makeCell(0x0102, 'Noble_Hearth_Hall', [0.0, 0.0, 0.0], 12.0, 10.0, 5.0,
        [makePortal(3, 0x0101, 2), makePortal(4, 0x0103, 5), makePortal(6, 0x0104, 7)],
        [
          makeStatic(0x02100114, 'cold_hearth_fireplace', [0.0, 4.0, 0.0]),
          makeStatic(0x02100115, 'black_oak_table', [0.0, -0.5, 0.0]),
          makeStatic(0x02100116, 'carved_stone_chair', [-1.5, -0.5, 0.0]),
          makeStatic(0x02100116, 'carved_stone_chair', [1.5, -0.5, 0.0]),
          makeStatic(0x02100102, 'soulfire_brazier', [-4.5, 3.5, 0.0]),
          makeStatic(0x02100102, 'soulfire_brazier', [4.5, 3.5, 0.0]),
          makeStatic(0x02100101, 'basalt_column', [-4.0, -3.0, 0.0]),
          makeStatic(0x02100101, 'basalt_column', [4.0, -3.0, 0.0])
        ]
      ),
      makeCell(0x0103, 'Crypt_Basement', [0.0, 6.0, -2.5], 10.0, 6.0, 3.5,
        [makePortal(5, 0x0102, 4)],
        [
          makeStatic(0x02100107, 'ancient_sarcophagus', [0.0, 1.5, 0.0]),
          makeStatic(0x02100108, 'embalming_altar', [-3.0, 0.0, 0.0]),
          makeStatic(0x02100109, 'urn_of_relics', [3.0, 1.5, 0.0]),
          makeStatic(0x02100102, 'soulfire_brazier', [0.0, -2.0, 0.0])
        ]
      ),
      makeCell(0x0104, 'Bedchamber_Chamber', [6.0, 0.0, 0.0], 6.0, 8.0, 4.0,
        [makePortal(7, 0x0102, 6)],
        [
          makeStatic(0x02100117, 'velvet_canopy_bier', [1.5, 1.5, 0.0]),
          makeStatic(0x02100111, 'basalt_bookcase', [1.5, -2.5, 0.0]),
          makeStatic(0x02100103, 'iron_candelabra', [-1.5, 0.0, 0.0])
        ]
      )
    ]
  },

  // 3. Spire of the Filinuvekta (0x01100003) - 4 cells, 18 statics, 4 portals
  {
    modelId: 0x01100003,
    hexModelId: '0x01100003',
    name: 'Spire_of_the_Filinuvekta',
    culture: 'UndeadOligarch',
    province: 'Gelid Plateau',
    footprint: { widthMeters: 18.0, depthMeters: 18.0, heightMeters: 38.0 },
    numLeaves: 20,
    exteriorMesh: {
      surfaces: [
        { surfaceDid: 0x08100104, hexDid: '0x08100104', name: 'hexagonal_basalt_block', materialType: 'Base1Image' },
        { surfaceDid: 0x08100105, hexDid: '0x08100105', name: 'polished_obsidian_facet', materialType: 'Base1Image' }
      ],
      portals: [
        { portalId: 1, flags: 1, otherCellId: 0x0101, otherPortalId: 1, frameOrigin: [0.0, -9.0, 0.0], clearance: { width: 1.6, height: 2.4 } }
      ]
    },
    interiorCells: [
      makeCell(0x0101, 'Spire_Ground_Portal', [0.0, -5.0, 0.0], 8.0, 8.0, 6.0,
        [makePortal(1, 'outdoor', 1), makePortal(2, 0x0102, 3)],
        [
          makeStatic(0x02100101, 'basalt_column', [-2.5, -2.5, 0.0]),
          makeStatic(0x02100101, 'basalt_column', [2.5, -2.5, 0.0]),
          makeStatic(0x02100102, 'soulfire_brazier', [0.0, 2.0, 0.0]),
          makeStatic(0x02100103, 'iron_candelabra', [-2.5, 2.0, 0.0]),
          makeStatic(0x02100103, 'iron_candelabra', [2.5, 2.0, 0.0])
        ]
      ),
      makeCell(0x0102, 'Mid_Ascension_Lab', [0.0, 0.0, 10.0], 8.0, 8.0, 6.0,
        [makePortal(3, 0x0101, 2), makePortal(4, 0x0103, 5)],
        [
          makeStatic(0x02100118, 'alchemical_alembic', [0.0, 2.0, 0.0]),
          makeStatic(0x02100111, 'basalt_bookcase', [-2.5, 0.0, 0.0]),
          makeStatic(0x02100111, 'basalt_bookcase', [2.5, 0.0, 0.0]),
          makeStatic(0x02100119, 'reagent_cabinet', [0.0, -2.5, 0.0])
        ]
      ),
      makeCell(0x0103, 'Runic_Observatory', [0.0, 0.0, 20.0], 8.0, 8.0, 6.0,
        [makePortal(5, 0x0102, 4), makePortal(6, 0x0104, 7)],
        [
          makeStatic(0x02100112, 'astronomic_sphere', [0.0, 0.0, 0.0]),
          makeStatic(0x02100110, 'grimoire_lectern', [2.0, 2.0, 0.0]),
          makeStatic(0x02100102, 'soulfire_brazier', [-2.0, -2.0, 0.0]),
          makeStatic(0x02100102, 'soulfire_brazier', [2.0, -2.0, 0.0])
        ]
      ),
      makeCell(0x0104, 'Beacon_Crown_Sanctum', [0.0, 0.0, 30.0], 6.0, 6.0, 6.0,
        [makePortal(7, 0x0103, 6)],
        [
          makeStatic(0x02100120, 'soulfire_beacon_core', [0.0, 0.0, 1.0]),
          makeStatic(0x02100101, 'basalt_column', [-2.0, -2.0, 0.0]),
          makeStatic(0x02100101, 'basalt_column', [2.0, -2.0, 0.0]),
          makeStatic(0x02100101, 'basalt_column', [-2.0, 2.0, 0.0]),
          makeStatic(0x02100101, 'basalt_column', [2.0, 2.0, 0.0])
        ]
      )
    ]
  },

  // 4. Gelidite Mausoleum Hall (0x01100004) - 4 cells, 22 statics, 4 portals
  {
    modelId: 0x01100004,
    hexModelId: '0x01100004',
    name: 'Gelidite_Mausoleum_Hall',
    culture: 'UndeadOligarch',
    province: 'Gelid Plateau',
    footprint: { widthMeters: 32.0, depthMeters: 22.0, heightMeters: 14.0 },
    numLeaves: 16,
    exteriorMesh: {
      surfaces: [
        { surfaceDid: 0x08100104, hexDid: '0x08100104', name: 'hexagonal_basalt_block', materialType: 'Base1Image' }
      ],
      portals: [
        { portalId: 1, flags: 1, otherCellId: 0x0101, otherPortalId: 1, frameOrigin: [0.0, -11.0, 0.0], clearance: { width: 1.8, height: 2.6 } }
      ]
    },
    interiorCells: [
      makeCell(0x0101, 'Mausoleum_Narthex', [0.0, -7.0, 0.0], 8.0, 6.0, 4.5,
        [makePortal(1, 'outdoor', 1, [1.8, 2.6]), makePortal(2, 0x0102, 3)],
        [
          makeStatic(0x02100101, 'basalt_column', [-3.0, 0.0, 0.0]),
          makeStatic(0x02100101, 'basalt_column', [3.0, 0.0, 0.0]),
          makeStatic(0x02100103, 'iron_candelabra', [0.0, 1.5, 0.0]),
          makeStatic(0x02100109, 'urn_of_relics', [-2.5, 2.0, 0.0]),
          makeStatic(0x02100109, 'urn_of_relics', [2.5, 2.0, 0.0])
        ]
      ),
      makeCell(0x0102, 'Great_Sepulcher_Hall', [0.0, 0.0, 0.0], 14.0, 10.0, 6.0,
        [makePortal(3, 0x0101, 2), makePortal(4, 0x0103, 5), makePortal(6, 0x0104, 7)],
        [
          makeStatic(0x02100107, 'ancient_sarcophagus', [0.0, 0.0, 0.0]),
          makeStatic(0x02100101, 'basalt_column', [-5.0, -3.0, 0.0]),
          makeStatic(0x02100101, 'basalt_column', [5.0, -3.0, 0.0]),
          makeStatic(0x02100101, 'basalt_column', [-5.0, 3.0, 0.0]),
          makeStatic(0x02100101, 'basalt_column', [5.0, 3.0, 0.0]),
          makeStatic(0x02100102, 'soulfire_brazier', [-3.0, 3.0, 0.0]),
          makeStatic(0x02100102, 'soulfire_brazier', [3.0, 3.0, 0.0]),
          makeStatic(0x02100106, 'black_iron_banner', [-6.0, 0.0, 3.0]),
          makeStatic(0x02100106, 'black_iron_banner', [6.0, 0.0, 3.0])
        ]
      ),
      makeCell(0x0103, 'West_Catacomb_Vault', [-8.0, 2.0, 0.0], 6.0, 8.0, 4.0,
        [makePortal(5, 0x0102, 4)],
        [
          makeStatic(0x02100107, 'ancient_sarcophagus', [-1.5, 1.5, 0.0]),
          makeStatic(0x02100107, 'ancient_sarcophagus', [-1.5, -1.5, 0.0]),
          makeStatic(0x02100109, 'urn_of_relics', [1.5, 0.0, 0.0]),
          makeStatic(0x02100103, 'iron_candelabra', [0.0, 2.5, 0.0])
        ]
      ),
      makeCell(0x0104, 'East_Catacomb_Vault', [8.0, 2.0, 0.0], 6.0, 8.0, 4.0,
        [makePortal(7, 0x0102, 6)],
        [
          makeStatic(0x02100107, 'ancient_sarcophagus', [1.5, 1.5, 0.0]),
          makeStatic(0x02100107, 'ancient_sarcophagus', [1.5, -1.5, 0.0]),
          makeStatic(0x02100109, 'urn_of_relics', [-1.5, 0.0, 0.0]),
          makeStatic(0x02100103, 'iron_candelabra', [0.0, 2.5, 0.0])
        ]
      )
    ]
  },

  // 5. Ashatiri Noble Guildhall (0x01100010) - 5 cells, 26 statics, 5 portals
  {
    modelId: 0x01100010,
    hexModelId: '0x01100010',
    name: 'Ashatiri_Noble_Guildhall',
    culture: 'LivingSerfNoble',
    province: 'Ashatiri Lowlands',
    footprint: { widthMeters: 32.0, depthMeters: 26.0, heightMeters: 15.0 },
    numLeaves: 18,
    exteriorMesh: {
      surfaces: [
        { surfaceDid: 0x08100101, hexDid: '0x08100101', name: 'ashatiri_dark_granite_wall', materialType: 'Base1Image' },
        { surfaceDid: 0x08100102, hexDid: '0x08100102', name: 'ironwood_timber_beam', materialType: 'Base1Image' },
        { surfaceDid: 0x08100103, hexDid: '0x08100103', name: 'mountain_slate_roof', materialType: 'Base1Image' }
      ],
      portals: [
        { portalId: 1, flags: 1, otherCellId: 0x0101, otherPortalId: 1, frameOrigin: [0.0, -13.0, 0.0], clearance: { width: 1.6, height: 2.4 } }
      ]
    },
    interiorCells: [
      makeCell(0x0101, 'Guild_Entry_Porch', [0.0, -10.0, 0.0], 8.0, 6.0, 4.0,
        [makePortal(1, 'outdoor', 1), makePortal(2, 0x0102, 3)],
        [
          makeStatic(0x02100201, 'ironwood_bench', [-2.5, 0.0, 0.0]),
          makeStatic(0x02100201, 'ironwood_bench', [2.5, 0.0, 0.0]),
          makeStatic(0x02100202, 'forged_lantern', [-3.0, -2.0, 2.4]),
          makeStatic(0x02100202, 'forged_lantern', [3.0, -2.0, 2.4])
        ]
      ),
      makeCell(0x0102, 'Great_Commons_Hall', [0.0, 0.0, 0.0], 16.0, 14.0, 6.5,
        [makePortal(3, 0x0101, 2), makePortal(4, 0x0103, 5), makePortal(6, 0x0104, 7), makePortal(8, 0x0105, 9)],
        [
          makeStatic(0x02100203, 'granite_hearth', [0.0, 6.0, 0.0]),
          makeStatic(0x02100204, 'trestle_table', [0.0, 0.0, 0.0]),
          makeStatic(0x02100205, 'ironwood_pillar', [-5.0, -4.0, 0.0]),
          makeStatic(0x02100205, 'ironwood_pillar', [5.0, -4.0, 0.0]),
          makeStatic(0x02100205, 'ironwood_pillar', [-5.0, 4.0, 0.0]),
          makeStatic(0x02100205, 'ironwood_pillar', [5.0, 4.0, 0.0]),
          makeStatic(0x02100206, 'heraldic_banner', [-7.5, 0.0, 3.5]),
          makeStatic(0x02100206, 'heraldic_banner', [7.5, 0.0, 3.5]),
          makeStatic(0x02100207, 'oak_keg_stand', [-6.5, 5.0, 0.0]),
          makeStatic(0x02100208, 'iron_chandelier', [0.0, 0.0, 4.5])
        ]
      ),
      makeCell(0x0103, 'Counting_Chamber', [-10.0, 2.0, 0.0], 8.0, 8.0, 4.0,
        [makePortal(5, 0x0102, 4)],
        [
          makeStatic(0x02100209, 'guildmaster_desk', [0.0, 1.5, 0.0]),
          makeStatic(0x02100210, 'iron_bound_safe', [-2.5, 2.5, 0.0]),
          makeStatic(0x02100211, 'ledger_shelf', [2.5, 2.0, 0.0]),
          makeStatic(0x02100202, 'forged_lantern', [0.0, -2.5, 2.2])
        ]
      ),
      makeCell(0x0104, 'Craftsmen_Workshop', [10.0, 2.0, 0.0], 8.0, 8.0, 4.0,
        [makePortal(7, 0x0102, 6)],
        [
          makeStatic(0x02100212, 'craft_workbench', [0.0, 1.5, 0.0]),
          makeStatic(0x02100213, 'smith_tool_rack', [3.0, 0.0, 0.0]),
          makeStatic(0x02100214, 'raw_ore_crate', [-2.5, -2.0, 0.0]),
          makeStatic(0x02100215, 'anvil_plinth', [0.0, -1.5, 0.0])
        ]
      ),
      makeCell(0x0105, 'Ironwood_Vault', [0.0, 8.5, 0.0], 8.0, 5.0, 3.5,
        [makePortal(9, 0x0102, 8)],
        [
          makeStatic(0x02100216, 'vault_chest', [0.0, 1.5, 0.0]),
          makeStatic(0x02100217, 'storage_cask', [-2.5, 0.0, 0.0]),
          makeStatic(0x02100217, 'storage_cask', [2.5, 0.0, 0.0]),
          makeStatic(0x02100210, 'iron_bound_safe', [0.0, -1.5, 0.0])
        ]
      )
    ]
  },

  // 6. Serf Artisan Longhouse (0x01100011) - 4 cells, 18 statics, 4 portals
  {
    modelId: 0x01100011,
    hexModelId: '0x01100011',
    name: 'Serf_Artisan_Longhouse',
    culture: 'LivingSerfNoble',
    province: 'Ashatiri Lowlands',
    footprint: { widthMeters: 24.0, depthMeters: 16.0, heightMeters: 11.0 },
    numLeaves: 12,
    exteriorMesh: {
      surfaces: [
        { surfaceDid: 0x08100101, hexDid: '0x08100101', name: 'ashatiri_dark_granite_wall', materialType: 'Base1Image' },
        { surfaceDid: 0x08100102, hexDid: '0x08100102', name: 'ironwood_timber_beam', materialType: 'Base1Image' }
      ],
      portals: [
        { portalId: 1, flags: 1, otherCellId: 0x0101, otherPortalId: 1, frameOrigin: [0.0, -8.0, 0.0], clearance: { width: 1.5, height: 2.3 } }
      ]
    },
    interiorCells: [
      makeCell(0x0101, 'Front_Threshold', [0.0, -5.0, 0.0], 6.0, 6.0, 3.8,
        [makePortal(1, 'outdoor', 1), makePortal(2, 0x0102, 3)],
        [
          makeStatic(0x02100201, 'ironwood_bench', [-2.0, 0.0, 0.0]),
          makeStatic(0x02100202, 'forged_lantern', [2.0, 0.0, 2.2]),
          makeStatic(0x02100218, 'boot_scraper_bucket', [-1.5, -2.0, 0.0]),
          makeStatic(0x02100219, 'wool_drying_rack', [2.0, 1.5, 0.0])
        ]
      ),
      makeCell(0x0102, 'Central_Hearth_Living', [0.0, 0.0, 0.0], 12.0, 8.0, 4.5,
        [makePortal(3, 0x0101, 2), makePortal(4, 0x0103, 5), makePortal(6, 0x0104, 7)],
        [
          makeStatic(0x02100203, 'granite_hearth', [0.0, 3.0, 0.0]),
          makeStatic(0x02100204, 'trestle_table', [0.0, -1.0, 0.0]),
          makeStatic(0x02100201, 'ironwood_bench', [-2.5, -1.0, 0.0]),
          makeStatic(0x02100201, 'ironwood_bench', [2.5, -1.0, 0.0]),
          makeStatic(0x02100220, 'spinning_loom', [-4.5, 2.0, 0.0]),
          makeStatic(0x02100221, 'clay_cooking_pots', [2.5, 3.0, 0.0]),
          makeStatic(0x02100205, 'ironwood_pillar', [-4.0, -2.5, 0.0]),
          makeStatic(0x02100205, 'ironwood_pillar', [4.0, -2.5, 0.0])
        ]
      ),
      makeCell(0x0103, 'Dormitory_Bunk_Room', [-7.0, 0.0, 0.0], 6.0, 8.0, 3.8,
        [makePortal(5, 0x0102, 4)],
        [
          makeStatic(0x02100222, 'timber_bunkbed', [-1.5, 2.0, 0.0]),
          makeStatic(0x02100222, 'timber_bunkbed', [-1.5, -2.0, 0.0]),
          makeStatic(0x02100216, 'vault_chest', [1.5, 0.0, 0.0])
        ]
      ),
      makeCell(0x0104, 'Larder_and_Store', [7.0, 0.0, 0.0], 6.0, 8.0, 3.8,
        [makePortal(7, 0x0102, 6)],
        [
          makeStatic(0x02100217, 'storage_cask', [1.5, 2.0, 0.0]),
          makeStatic(0x02100217, 'storage_cask', [1.5, -2.0, 0.0]),
          makeStatic(0x02100214, 'raw_ore_crate', [-1.5, 0.0, 0.0])
        ]
      )
    ]
  },

  // 7. Stilted Fen-Manor (0x01100012) - 4 cells, 16 statics, 4 portals
  {
    modelId: 0x01100012,
    hexModelId: '0x01100012',
    name: 'Stilted_Fen_Manor',
    culture: 'UndeadOligarch',
    province: 'Dericost Marshes',
    footprint: { widthMeters: 26.0, depthMeters: 18.0, heightMeters: 13.0 },
    numLeaves: 14,
    exteriorMesh: {
      surfaces: [
        { surfaceDid: 0x08100102, hexDid: '0x08100102', name: 'ironwood_timber_beam', materialType: 'Base1Image' }
      ],
      portals: [
        { portalId: 1, flags: 1, otherCellId: 0x0101, otherPortalId: 1, frameOrigin: [0.0, -9.0, 3.0], clearance: { width: 1.5, height: 2.3 } }
      ]
    },
    interiorCells: [
      makeCell(0x0101, 'Stilt_Gangway_Foyer', [0.0, -6.0, 3.0], 6.0, 6.0, 3.8,
        [makePortal(1, 'outdoor', 1), makePortal(2, 0x0102, 3)],
        [
          makeStatic(0x02100202, 'forged_lantern', [-2.0, 0.0, 2.2]),
          makeStatic(0x02100202, 'forged_lantern', [2.0, 0.0, 2.2]),
          makeStatic(0x02100223, 'reed_matting', [0.0, 0.0, 0.0]),
          makeStatic(0x02100217, 'storage_cask', [2.0, -1.5, 0.0])
        ]
      ),
      makeCell(0x0102, 'Fen_Gathering_Hall', [0.0, 0.0, 3.0], 12.0, 8.0, 4.5,
        [makePortal(3, 0x0101, 2), makePortal(4, 0x0103, 5), makePortal(6, 0x0104, 7)],
        [
          makeStatic(0x02100224, 'peat_hearth_box', [0.0, 3.0, 0.0]),
          makeStatic(0x02100204, 'trestle_table', [0.0, -0.5, 0.0]),
          makeStatic(0x02100201, 'ironwood_bench', [-2.5, -0.5, 0.0]),
          makeStatic(0x02100201, 'ironwood_bench', [2.5, -0.5, 0.0]),
          makeStatic(0x02100205, 'ironwood_pillar', [-4.0, 2.0, 0.0]),
          makeStatic(0x02100205, 'ironwood_pillar', [4.0, 2.0, 0.0])
        ]
      ),
      makeCell(0x0103, 'Marsh_Sleeping_Chamber', [-7.0, 0.0, 3.0], 6.0, 8.0, 3.6,
        [makePortal(5, 0x0102, 4)],
        [
          makeStatic(0x02100222, 'timber_bunkbed', [-1.5, 1.5, 0.0]),
          makeStatic(0x02100216, 'vault_chest', [1.5, 1.5, 0.0]),
          makeStatic(0x02100202, 'forged_lantern', [0.0, -2.0, 2.0])
        ]
      ),
      makeCell(0x0104, 'Smoked_Fish_Locker', [7.0, 0.0, 3.0], 6.0, 8.0, 3.6,
        [makePortal(7, 0x0102, 6)],
        [
          makeStatic(0x02100217, 'storage_cask', [1.5, 1.5, 0.0]),
          makeStatic(0x02100217, 'storage_cask', [1.5, -1.5, 0.0]),
          makeStatic(0x02100214, 'raw_ore_crate', [-1.5, 0.0, 0.0])
        ]
      )
    ]
  },

  // 8. Iron-Quarry Master's Hall (0x01100013) - 4 cells, 20 statics, 4 portals
  {
    modelId: 0x01100013,
    hexModelId: '0x01100013',
    name: 'Iron_Quarry_Masters_Hall',
    culture: 'LivingSerfNoble',
    province: 'Ashatiri Lowlands',
    footprint: { widthMeters: 30.0, depthMeters: 24.0, heightMeters: 14.0 },
    numLeaves: 16,
    exteriorMesh: {
      surfaces: [
        { surfaceDid: 0x08100101, hexDid: '0x08100101', name: 'ashatiri_dark_granite_wall', materialType: 'Base1Image' }
      ],
      portals: [
        { portalId: 1, flags: 1, otherCellId: 0x0101, otherPortalId: 1, frameOrigin: [0.0, -12.0, 0.0], clearance: { width: 1.8, height: 2.5 } }
      ]
    },
    interiorCells: [
      makeCell(0x0101, 'Quarry_Guard_Portico', [0.0, -8.0, 0.0], 8.0, 6.0, 4.2,
        [makePortal(1, 'outdoor', 1, [1.8, 2.5]), makePortal(2, 0x0102, 3)],
        [
          makeStatic(0x02100205, 'ironwood_pillar', [-3.0, 0.0, 0.0]),
          makeStatic(0x02100205, 'ironwood_pillar', [3.0, 0.0, 0.0]),
          makeStatic(0x02100213, 'smith_tool_rack', [-2.5, 2.0, 0.0]),
          makeStatic(0x02100202, 'forged_lantern', [2.5, 2.0, 2.4])
        ]
      ),
      makeCell(0x0102, 'Master_Assay_Hall', [0.0, 0.0, 0.0], 14.0, 10.0, 5.5,
        [makePortal(3, 0x0101, 2), makePortal(4, 0x0103, 5), makePortal(6, 0x0104, 7)],
        [
          makeStatic(0x02100225, 'ore_assay_scales', [0.0, 3.5, 0.0]),
          makeStatic(0x02100209, 'guildmaster_desk', [0.0, 1.0, 0.0]),
          makeStatic(0x02100226, 'iron_ingot_stack', [-5.0, 3.0, 0.0]),
          makeStatic(0x02100226, 'iron_ingot_stack', [5.0, 3.0, 0.0]),
          makeStatic(0x02100203, 'granite_hearth', [-5.0, -3.0, 0.0]),
          makeStatic(0x02100210, 'iron_bound_safe', [5.0, -3.0, 0.0]),
          makeStatic(0x02100205, 'ironwood_pillar', [-3.5, 0.0, 0.0]),
          makeStatic(0x02100205, 'ironwood_pillar', [3.5, 0.0, 0.0])
        ]
      ),
      makeCell(0x0103, 'Drafting_Office', [-8.0, 2.0, 0.0], 6.0, 8.0, 4.0,
        [makePortal(5, 0x0102, 4)],
        [
          makeStatic(0x02100227, 'survey_drafting_table', [0.0, 1.5, 0.0]),
          makeStatic(0x02100211, 'ledger_shelf', [-1.5, -2.0, 0.0]),
          makeStatic(0x02100202, 'forged_lantern', [1.5, -2.0, 2.2]),
          makeStatic(0x02100216, 'vault_chest', [0.0, -2.5, 0.0])
        ]
      ),
      makeCell(0x0104, 'High_Security_Ingot_Locker', [8.0, 2.0, 0.0], 6.0, 8.0, 4.0,
        [makePortal(7, 0x0102, 6)],
        [
          makeStatic(0x02100226, 'iron_ingot_stack', [1.5, 1.5, 0.0]),
          makeStatic(0x02100226, 'iron_ingot_stack', [1.5, -1.5, 0.0]),
          makeStatic(0x02100210, 'iron_bound_safe', [-1.5, 0.0, 0.0]),
          makeStatic(0x02100216, 'vault_chest', [0.0, 2.5, 0.0])
        ]
      )
    ]
  },

  // 9. Sand King Adobe Citadel (0x01100020) - 6 cells, 30 statics, 6 portals
  {
    modelId: 0x01100020,
    hexModelId: '0x01100020',
    name: 'Sand_King_Adobe_Citadel',
    culture: 'HighDesertNomad',
    province: 'The High Desert Plateau',
    footprint: { widthMeters: 38.0, depthMeters: 38.0, heightMeters: 18.0 },
    numLeaves: 28,
    exteriorMesh: {
      surfaces: [
        { surfaceDid: 0x08100106, hexDid: '0x08100106', name: 'sun_baked_adobe_clay', materialType: 'Base1Image' },
        { surfaceDid: 0x08100107, hexDid: '0x08100107', name: 'pierced_bronze_grill', materialType: 'Base1Image' }
      ],
      portals: [
        { portalId: 1, flags: 1, otherCellId: 0x0101, otherPortalId: 1, frameOrigin: [0.0, -19.0, 0.0], clearance: { width: 2.0, height: 2.6 } }
      ]
    },
    interiorCells: [
      makeCell(0x0101, 'Sun_Gate_Entryway', [0.0, -14.0, 0.0], 8.0, 8.0, 5.0,
        [makePortal(1, 'outdoor', 1, [2.0, 2.6]), makePortal(2, 0x0102, 3)],
        [
          makeStatic(0x02100301, 'bronze_shade_brazier', [-3.0, 0.0, 0.0]),
          makeStatic(0x02100301, 'bronze_shade_brazier', [3.0, 0.0, 0.0]),
          makeStatic(0x02100302, 'sandstone_pillar', [-2.5, -2.5, 0.0]),
          makeStatic(0x02100302, 'sandstone_pillar', [2.5, -2.5, 0.0]),
          makeStatic(0x02100303, 'nomad_water_urn', [0.0, 2.5, 0.0])
        ]
      ),
      makeCell(0x0102, 'Courtyard_of_Sand_Kings', [0.0, 0.0, 0.0], 18.0, 16.0, 6.0,
        [makePortal(3, 0x0101, 2), makePortal(4, 0x0103, 5), makePortal(6, 0x0104, 7), makePortal(8, 0x0105, 9)],
        [
          makeStatic(0x02100304, 'chieftain_silk_divan', [0.0, 6.0, 0.0]),
          makeStatic(0x02100305, 'sunken_mosaic_cistern', [0.0, 0.0, -0.5]),
          makeStatic(0x02100302, 'sandstone_pillar', [-7.0, -5.0, 0.0]),
          makeStatic(0x02100302, 'sandstone_pillar', [7.0, -5.0, 0.0]),
          makeStatic(0x02100302, 'sandstone_pillar', [-7.0, 5.0, 0.0]),
          makeStatic(0x02100302, 'sandstone_pillar', [7.0, 5.0, 0.0]),
          makeStatic(0x02100306, 'crimson_sun_awning', [0.0, 5.0, 4.0]),
          makeStatic(0x02100301, 'bronze_shade_brazier', [-5.0, 5.0, 0.0]),
          makeStatic(0x02100301, 'bronze_shade_brazier', [5.0, 5.0, 0.0]),
          makeStatic(0x02100307, 'bronze_water_basin', [0.0, -4.0, 0.0])
        ]
      ),
      makeCell(0x0103, 'Mu_Miyah_Reliquary', [-12.0, 0.0, 0.0], 8.0, 10.0, 4.5,
        [makePortal(5, 0x0102, 4)],
        [
          makeStatic(0x02100308, 'mu_miyah_canopic_chest', [0.0, 2.5, 0.0]),
          makeStatic(0x02100309, 'mummified_chieftain_bier', [0.0, -1.0, 0.0]),
          makeStatic(0x02100301, 'bronze_shade_brazier', [-2.5, 2.5, 0.0]),
          makeStatic(0x02100303, 'nomad_water_urn', [2.5, -2.5, 0.0])
        ]
      ),
      makeCell(0x0104, 'Diwan_Council_Hall', [12.0, 0.0, 0.0], 8.0, 10.0, 4.5,
        [makePortal(7, 0x0102, 6)],
        [
          makeStatic(0x02100310, 'low_carved_teak_table', [0.0, 0.0, 0.0]),
          makeStatic(0x02100311, 'silk_floor_cushions', [-2.0, 0.0, 0.0]),
          makeStatic(0x02100311, 'silk_floor_cushions', [2.0, 0.0, 0.0]),
          makeStatic(0x02100307, 'bronze_water_basin', [0.0, 3.0, 0.0])
        ]
      ),
      makeCell(0x0105, 'Upper_Battery_Barbican', [0.0, 12.0, 4.0], 10.0, 6.0, 4.0,
        [makePortal(9, 0x0102, 8), makePortal(10, 0x0106, 11)],
        [
          makeStatic(0x02100312, 'desert_javelin_rack', [-3.0, 0.0, 0.0]),
          makeStatic(0x02100312, 'desert_javelin_rack', [3.0, 0.0, 0.0]),
          makeStatic(0x02100301, 'bronze_shade_brazier', [0.0, 1.5, 0.0])
        ]
      ),
      makeCell(0x0106, 'Rooftop_Observation_Platform', [0.0, 17.0, 8.0], 8.0, 6.0, 3.5,
        [makePortal(11, 0x0105, 10)],
        [
          makeStatic(0x02100313, 'sun_disc_compass', [0.0, 0.0, 0.0]),
          makeStatic(0x02100306, 'crimson_sun_awning', [0.0, 0.0, 2.5]),
          makeStatic(0x02100303, 'nomad_water_urn', [-2.5, 1.5, 0.0]),
          makeStatic(0x02100303, 'nomad_water_urn', [2.5, 1.5, 0.0])
        ]
      )
    ]
  },

  // 10. Nomadic Caravanserai (0x01100021) - 5 cells, 24 statics, 5 portals
  {
    modelId: 0x01100021,
    hexModelId: '0x01100021',
    name: 'Nomadic_Caravanserai',
    culture: 'HighDesertNomad',
    province: 'The High Desert Plateau',
    footprint: { widthMeters: 34.0, depthMeters: 30.0, heightMeters: 12.0 },
    numLeaves: 20,
    exteriorMesh: {
      surfaces: [
        { surfaceDid: 0x08100106, hexDid: '0x08100106', name: 'sun_baked_adobe_clay', materialType: 'Base1Image' }
      ],
      portals: [
        { portalId: 1, flags: 1, otherCellId: 0x0101, otherPortalId: 1, frameOrigin: [0.0, -15.0, 0.0], clearance: { width: 2.2, height: 2.6 } }
      ]
    },
    interiorCells: [
      makeCell(0x0101, 'Caravanserai_Gatehouse', [0.0, -11.0, 0.0], 8.0, 6.0, 4.0,
        [makePortal(1, 'outdoor', 1, [2.2, 2.6]), makePortal(2, 0x0102, 3)],
        [
          makeStatic(0x02100302, 'sandstone_pillar', [-3.0, 0.0, 0.0]),
          makeStatic(0x02100302, 'sandstone_pillar', [3.0, 0.0, 0.0]),
          makeStatic(0x02100301, 'bronze_shade_brazier', [0.0, 1.5, 0.0]),
          makeStatic(0x02100303, 'nomad_water_urn', [-2.5, -1.5, 0.0])
        ]
      ),
      makeCell(0x0102, 'Central_Camel_Court', [0.0, 0.0, 0.0], 16.0, 14.0, 5.5,
        [makePortal(3, 0x0101, 2), makePortal(4, 0x0103, 5), makePortal(6, 0x0104, 7), makePortal(8, 0x0105, 9)],
        [
          makeStatic(0x02100314, 'stone_watering_trough', [0.0, 0.0, 0.0]),
          makeStatic(0x02100302, 'sandstone_pillar', [-6.0, -4.0, 0.0]),
          makeStatic(0x02100302, 'sandstone_pillar', [6.0, -4.0, 0.0]),
          makeStatic(0x02100302, 'sandstone_pillar', [-6.0, 4.0, 0.0]),
          makeStatic(0x02100302, 'sandstone_pillar', [6.0, 4.0, 0.0]),
          makeStatic(0x02100306, 'crimson_sun_awning', [0.0, 4.0, 4.0]),
          makeStatic(0x02100303, 'nomad_water_urn', [-4.0, 5.0, 0.0]),
          makeStatic(0x02100303, 'nomad_water_urn', [4.0, 5.0, 0.0])
        ]
      ),
      makeCell(0x0103, 'Spice_Bazaar_Depot', [-10.0, 1.0, 0.0], 8.0, 8.0, 4.0,
        [makePortal(5, 0x0102, 4)],
        [
          makeStatic(0x02100315, 'spice_sack_stack', [-2.5, 2.0, 0.0]),
          makeStatic(0x02100315, 'spice_sack_stack', [2.5, 2.0, 0.0]),
          makeStatic(0x02100316, 'brass_merchant_scale', [0.0, 0.0, 0.0]),
          makeStatic(0x02100303, 'nomad_water_urn', [0.0, -2.5, 0.0])
        ]
      ),
      makeCell(0x0104, 'Caravan_Drivers_Bunks', [10.0, 1.0, 0.0], 8.0, 8.0, 4.0,
        [makePortal(7, 0x0102, 6)],
        [
          makeStatic(0x02100311, 'silk_floor_cushions', [-2.0, 1.5, 0.0]),
          makeStatic(0x02100311, 'silk_floor_cushions', [2.0, 1.5, 0.0]),
          makeStatic(0x02100310, 'low_carved_teak_table', [0.0, -1.5, 0.0]),
          makeStatic(0x02100301, 'bronze_shade_brazier', [0.0, 2.5, 0.0])
        ]
      ),
      makeCell(0x0105, 'Subterranean_Water_Cistern', [0.0, 9.0, -2.0], 10.0, 6.0, 3.5,
        [makePortal(9, 0x0102, 8)],
        [
          makeStatic(0x02100305, 'sunken_mosaic_cistern', [0.0, 0.0, 0.0]),
          makeStatic(0x02100303, 'nomad_water_urn', [-3.5, 1.5, 0.0]),
          makeStatic(0x02100303, 'nomad_water_urn', [3.5, 1.5, 0.0]),
          makeStatic(0x02100307, 'bronze_water_basin', [0.0, -1.5, 0.0])
        ]
      )
    ]
  },

  // 11. Mu-Miyah Sun-Temple (0x01100022) - 4 cells, 22 statics, 4 portals
  {
    modelId: 0x01100022,
    hexModelId: '0x01100022',
    name: 'Mu_Miyah_Sun_Temple',
    culture: 'HighDesertNomad',
    province: 'The High Desert Plateau',
    footprint: { widthMeters: 28.0, depthMeters: 24.0, heightMeters: 15.0 },
    numLeaves: 16,
    exteriorMesh: {
      surfaces: [
        { surfaceDid: 0x08100106, hexDid: '0x08100106', name: 'sun_baked_adobe_clay', materialType: 'Base1Image' }
      ],
      portals: [
        { portalId: 1, flags: 1, otherCellId: 0x0101, otherPortalId: 1, frameOrigin: [0.0, -12.0, 0.0], clearance: { width: 1.8, height: 2.6 } }
      ]
    },
    interiorCells: [
      makeCell(0x0101, 'Temple_Portico', [0.0, -8.0, 0.0], 8.0, 6.0, 4.5,
        [makePortal(1, 'outdoor', 1, [1.8, 2.6]), makePortal(2, 0x0102, 3)],
        [
          makeStatic(0x02100302, 'sandstone_pillar', [-3.0, 0.0, 0.0]),
          makeStatic(0x02100302, 'sandstone_pillar', [3.0, 0.0, 0.0]),
          makeStatic(0x02100301, 'bronze_shade_brazier', [0.0, 1.5, 0.0]),
          makeStatic(0x02100303, 'nomad_water_urn', [-2.5, -1.5, 0.0]),
          makeStatic(0x02100303, 'nomad_water_urn', [2.5, -1.5, 0.0])
        ]
      ),
      makeCell(0x0102, 'Sun_Disc_Sanctuary', [0.0, 0.0, 0.0], 14.0, 10.0, 6.0,
        [makePortal(3, 0x0101, 2), makePortal(4, 0x0103, 5), makePortal(6, 0x0104, 7)],
        [
          makeStatic(0x02100317, 'golden_sun_altar', [0.0, 3.5, 0.5]),
          makeStatic(0x02100302, 'sandstone_pillar', [-5.0, -3.0, 0.0]),
          makeStatic(0x02100302, 'sandstone_pillar', [5.0, -3.0, 0.0]),
          makeStatic(0x02100302, 'sandstone_pillar', [-5.0, 3.0, 0.0]),
          makeStatic(0x02100302, 'sandstone_pillar', [5.0, 3.0, 0.0]),
          makeStatic(0x02100301, 'bronze_shade_brazier', [-3.0, 3.5, 0.0]),
          makeStatic(0x02100301, 'bronze_shade_brazier', [3.0, 3.5, 0.0]),
          makeStatic(0x02100307, 'bronze_water_basin', [0.0, -2.5, 0.0]),
          makeStatic(0x02100308, 'mu_miyah_canopic_chest', [0.0, 1.5, 0.0])
        ]
      ),
      makeCell(0x0103, 'Embalming_Chamber', [-8.0, 2.0, 0.0], 6.0, 8.0, 4.0,
        [makePortal(5, 0x0102, 4)],
        [
          makeStatic(0x02100309, 'mummified_chieftain_bier', [0.0, 1.0, 0.0]),
          makeStatic(0x02100308, 'mu_miyah_canopic_chest', [-1.5, -2.0, 0.0]),
          makeStatic(0x02100303, 'nomad_water_urn', [1.5, -2.0, 0.0]),
          makeStatic(0x02100301, 'bronze_shade_brazier', [0.0, 3.0, 0.0])
        ]
      ),
      makeCell(0x0104, 'Priests_Vestry', [8.0, 2.0, 0.0], 6.0, 8.0, 4.0,
        [makePortal(7, 0x0102, 6)],
        [
          makeStatic(0x02100310, 'low_carved_teak_table', [0.0, 0.0, 0.0]),
          makeStatic(0x02100311, 'silk_floor_cushions', [1.5, 0.0, 0.0]),
          makeStatic(0x02100303, 'nomad_water_urn', [0.0, -2.5, 0.0]),
          makeStatic(0x02100307, 'bronze_water_basin', [-1.5, 2.0, 0.0])
        ]
      )
    ]
  },

  // 12. Desert Dune-Bastion (0x01100023) - 4 cells, 18 statics, 4 portals
  {
    modelId: 0x01100023,
    hexModelId: '0x01100023',
    name: 'Desert_Dune_Bastion',
    culture: 'HighDesertNomad',
    province: 'The High Desert Plateau',
    footprint: { widthMeters: 26.0, depthMeters: 22.0, heightMeters: 16.0 },
    numLeaves: 16,
    exteriorMesh: {
      surfaces: [
        { surfaceDid: 0x08100106, hexDid: '0x08100106', name: 'sun_baked_adobe_clay', materialType: 'Base1Image' }
      ],
      portals: [
        { portalId: 1, flags: 1, otherCellId: 0x0101, otherPortalId: 1, frameOrigin: [0.0, -11.0, 0.0], clearance: { width: 1.6, height: 2.4 } }
      ]
    },
    interiorCells: [
      makeCell(0x0101, 'Bastion_Barbican', [0.0, -7.0, 0.0], 8.0, 6.0, 4.0,
        [makePortal(1, 'outdoor', 1), makePortal(2, 0x0102, 3)],
        [
          makeStatic(0x02100302, 'sandstone_pillar', [-2.5, 0.0, 0.0]),
          makeStatic(0x02100302, 'sandstone_pillar', [2.5, 0.0, 0.0]),
          makeStatic(0x02100312, 'desert_javelin_rack', [-2.5, 1.5, 0.0]),
          makeStatic(0x02100301, 'bronze_shade_brazier', [2.5, 1.5, 0.0])
        ]
      ),
      makeCell(0x0102, 'Garrison_Courtyard', [0.0, 0.0, 0.0], 12.0, 8.0, 5.0,
        [makePortal(3, 0x0101, 2), makePortal(4, 0x0103, 5), makePortal(6, 0x0104, 7)],
        [
          makeStatic(0x02100305, 'sunken_mosaic_cistern', [0.0, 0.0, 0.0]),
          makeStatic(0x02100302, 'sandstone_pillar', [-4.5, -2.5, 0.0]),
          makeStatic(0x02100302, 'sandstone_pillar', [4.5, -2.5, 0.0]),
          makeStatic(0x02100302, 'sandstone_pillar', [-4.5, 2.5, 0.0]),
          makeStatic(0x02100302, 'sandstone_pillar', [4.5, 2.5, 0.0]),
          makeStatic(0x02100303, 'nomad_water_urn', [-3.0, 3.0, 0.0]),
          makeStatic(0x02100303, 'nomad_water_urn', [3.0, 3.0, 0.0])
        ]
      ),
      makeCell(0x0103, 'Mu_Miyah_Guard_Post', [-7.0, 0.0, 0.0], 6.0, 8.0, 4.0,
        [makePortal(5, 0x0102, 4)],
        [
          makeStatic(0x02100311, 'silk_floor_cushions', [-1.5, 1.5, 0.0]),
          makeStatic(0x02100312, 'desert_javelin_rack', [1.5, 1.5, 0.0]),
          makeStatic(0x02100301, 'bronze_shade_brazier', [0.0, -2.5, 0.0])
        ]
      ),
      makeCell(0x0104, 'Dune_Watch_Rampart', [0.0, 5.0, 6.0], 10.0, 4.0, 3.5,
        [makePortal(7, 0x0102, 6)],
        [
          makeStatic(0x02100313, 'sun_disc_compass', [0.0, 0.0, 0.0]),
          makeStatic(0x02100306, 'crimson_sun_awning', [0.0, 0.0, 2.2]),
          makeStatic(0x02100303, 'nomad_water_urn', [-3.5, 0.0, 0.0]),
          makeStatic(0x02100303, 'nomad_water_urn', [3.5, 0.0, 0.0])
        ]
      )
    ]
  },

  // 13. Imperial Praetorium (Town Hall) (0x01100030) - 5 cells, 24 statics, 5 portals
  {
    modelId: 0x01100030,
    hexModelId: '0x01100030',
    name: 'Imperial_Praetorium_Town_Hall',
    culture: 'CommonCivic',
    province: 'Universal',
    footprint: { widthMeters: 30.0, depthMeters: 26.0, heightMeters: 14.0 },
    numLeaves: 18,
    exteriorMesh: {
      surfaces: [
        { surfaceDid: 0x08100101, hexDid: '0x08100101', name: 'ashatiri_dark_granite_wall', materialType: 'Base1Image' },
        { surfaceDid: 0x08100103, hexDid: '0x08100103', name: 'mountain_slate_roof', materialType: 'Base1Image' }
      ],
      portals: [
        { portalId: 1, flags: 1, otherCellId: 0x0101, otherPortalId: 1, frameOrigin: [0.0, -13.0, 0.0], clearance: { width: 2.2, height: 2.6 } }
      ]
    },
    interiorCells: [
      makeCell(0x0101, 'Praetorium_Grand_Foyer', [0.0, -10.0, 0.0], 8.0, 6.0, 4.5,
        [makePortal(1, 'outdoor', 1, [2.2, 2.6]), makePortal(2, 0x0102, 3)],
        [
          makeStatic(0x02100205, 'ironwood_pillar', [-3.0, 0.0, 0.0]),
          makeStatic(0x02100205, 'ironwood_pillar', [3.0, 0.0, 0.0]),
          makeStatic(0x02100202, 'forged_lantern', [-3.0, -2.0, 2.4]),
          makeStatic(0x02100202, 'forged_lantern', [3.0, -2.0, 2.4])
        ]
      ),
      makeCell(0x0102, 'Council_Assembly_Chamber', [0.0, 0.0, 0.0], 16.0, 12.0, 6.0,
        [makePortal(3, 0x0101, 2), makePortal(4, 0x0103, 5), makePortal(6, 0x0104, 7), makePortal(8, 0x0105, 9)],
        [
          makeStatic(0x02100209, 'guildmaster_desk', [0.0, 4.5, 0.0]),
          makeStatic(0x02100204, 'trestle_table', [0.0, 0.0, 0.0]),
          makeStatic(0x02100201, 'ironwood_bench', [-3.0, 0.0, 0.0]),
          makeStatic(0x02100201, 'ironwood_bench', [3.0, 0.0, 0.0]),
          makeStatic(0x02100205, 'ironwood_pillar', [-6.0, -4.0, 0.0]),
          makeStatic(0x02100205, 'ironwood_pillar', [6.0, -4.0, 0.0]),
          makeStatic(0x02100205, 'ironwood_pillar', [-6.0, 4.0, 0.0]),
          makeStatic(0x02100205, 'ironwood_pillar', [6.0, 4.0, 0.0]),
          makeStatic(0x02100206, 'heraldic_banner', [-7.0, 0.0, 3.5]),
          makeStatic(0x02100206, 'heraldic_banner', [7.0, 0.0, 3.5])
        ]
      ),
      makeCell(0x0103, 'City_Archives_Crypt', [-10.0, 2.0, 0.0], 8.0, 8.0, 4.0,
        [makePortal(5, 0x0102, 4)],
        [
          makeStatic(0x02100211, 'ledger_shelf', [-2.5, 2.0, 0.0]),
          makeStatic(0x02100211, 'ledger_shelf', [2.5, 2.0, 0.0]),
          makeStatic(0x02100216, 'vault_chest', [0.0, -2.0, 0.0]),
          makeStatic(0x02100202, 'forged_lantern', [0.0, 2.0, 2.2])
        ]
      ),
      makeCell(0x0104, 'Magistrate_Private_Office', [10.0, 2.0, 0.0], 8.0, 8.0, 4.0,
        [makePortal(7, 0x0102, 6)],
        [
          makeStatic(0x02100209, 'guildmaster_desk', [0.0, 1.5, 0.0]),
          makeStatic(0x02100210, 'iron_bound_safe', [-2.5, 2.0, 0.0]),
          makeStatic(0x02100216, 'vault_chest', [2.5, -2.0, 0.0])
        ]
      ),
      makeCell(0x0105, 'Secure_Treasury_Vault', [0.0, 8.0, 0.0], 8.0, 6.0, 3.5,
        [makePortal(9, 0x0102, 8)],
        [
          makeStatic(0x02100216, 'vault_chest', [0.0, 1.5, 0.0]),
          makeStatic(0x02100210, 'iron_bound_safe', [-2.5, 0.0, 0.0]),
          makeStatic(0x02100210, 'iron_bound_safe', [2.5, 0.0, 0.0])
        ]
      )
    ]
  },

  // 14. Garrison Barracks & Armory (0x01100031) - 4 cells, 22 statics, 4 portals
  {
    modelId: 0x01100031,
    hexModelId: '0x01100031',
    name: 'Garrison_Barracks_and_Armory',
    culture: 'CommonCivic',
    province: 'Universal',
    footprint: { widthMeters: 28.0, depthMeters: 20.0, heightMeters: 12.0 },
    numLeaves: 16,
    exteriorMesh: {
      surfaces: [
        { surfaceDid: 0x08100101, hexDid: '0x08100101', name: 'ashatiri_dark_granite_wall', materialType: 'Base1Image' }
      ],
      portals: [
        { portalId: 1, flags: 1, otherCellId: 0x0101, otherPortalId: 1, frameOrigin: [0.0, -10.0, 0.0], clearance: { width: 1.8, height: 2.5 } }
      ]
    },
    interiorCells: [
      makeCell(0x0101, 'Guard_Porch', [0.0, -7.0, 0.0], 8.0, 6.0, 4.0,
        [makePortal(1, 'outdoor', 1, [1.8, 2.5]), makePortal(2, 0x0102, 3)],
        [
          makeStatic(0x02100205, 'ironwood_pillar', [-3.0, 0.0, 0.0]),
          makeStatic(0x02100205, 'ironwood_pillar', [3.0, 0.0, 0.0]),
          makeStatic(0x02100213, 'smith_tool_rack', [-2.5, 1.5, 0.0]),
          makeStatic(0x02100202, 'forged_lantern', [2.5, 1.5, 2.2])
        ]
      ),
      makeCell(0x0102, 'Enlisted_Bunk_Hall', [0.0, 0.0, 0.0], 14.0, 10.0, 4.5,
        [makePortal(3, 0x0101, 2), makePortal(4, 0x0103, 5), makePortal(6, 0x0104, 7)],
        [
          makeStatic(0x02100222, 'timber_bunkbed', [-5.0, 2.5, 0.0]),
          makeStatic(0x02100222, 'timber_bunkbed', [-5.0, -2.5, 0.0]),
          makeStatic(0x02100222, 'timber_bunkbed', [5.0, 2.5, 0.0]),
          makeStatic(0x02100222, 'timber_bunkbed', [5.0, -2.5, 0.0]),
          makeStatic(0x02100204, 'trestle_table', [0.0, 0.0, 0.0]),
          makeStatic(0x02100201, 'ironwood_bench', [0.0, -1.5, 0.0]),
          makeStatic(0x02100201, 'ironwood_bench', [0.0, 1.5, 0.0]),
          makeStatic(0x02100203, 'granite_hearth', [0.0, 4.0, 0.0])
        ]
      ),
      makeCell(0x0103, 'Armory_and_Weapon_Lock', [-8.0, 2.0, 0.0], 6.0, 8.0, 3.8,
        [makePortal(5, 0x0102, 4)],
        [
          makeStatic(0x02100213, 'smith_tool_rack', [-1.5, 2.0, 0.0]),
          makeStatic(0x02100213, 'smith_tool_rack', [1.5, 2.0, 0.0]),
          makeStatic(0x02100216, 'vault_chest', [-1.5, -2.0, 0.0]),
          makeStatic(0x02100216, 'vault_chest', [1.5, -2.0, 0.0]),
          makeStatic(0x02100210, 'iron_bound_safe', [0.0, 0.0, 0.0])
        ]
      ),
      makeCell(0x0104, 'Captains_Quarters', [8.0, 2.0, 0.0], 6.0, 8.0, 3.8,
        [makePortal(7, 0x0102, 6)],
        [
          makeStatic(0x02100209, 'guildmaster_desk', [0.0, 1.5, 0.0]),
          makeStatic(0x02100222, 'timber_bunkbed', [1.5, -2.0, 0.0]),
          makeStatic(0x02100216, 'vault_chest', [-1.5, -2.0, 0.0]),
          makeStatic(0x02100202, 'forged_lantern', [0.0, 2.5, 2.0]),
          makeStatic(0x02100206, 'heraldic_banner', [2.5, 0.0, 2.5])
        ]
      )
    ]
  },

  // 15. Temple of the Ice Throne / Altar (0x01100032) - 4 cells, 20 statics, 4 portals
  {
    modelId: 0x01100032,
    hexModelId: '0x01100032',
    name: 'Temple_of_the_Ice_Throne_Altar',
    culture: 'CommonCivic',
    province: 'Universal',
    footprint: { widthMeters: 32.0, depthMeters: 22.0, heightMeters: 16.0 },
    numLeaves: 16,
    exteriorMesh: {
      surfaces: [
        { surfaceDid: 0x08100104, hexDid: '0x08100104', name: 'hexagonal_basalt_block', materialType: 'Base1Image' }
      ],
      portals: [
        { portalId: 1, flags: 1, otherCellId: 0x0101, otherPortalId: 1, frameOrigin: [0.0, -11.0, 0.0], clearance: { width: 2.0, height: 2.6 } }
      ]
    },
    interiorCells: [
      makeCell(0x0101, 'Temple_Narthex', [0.0, -7.0, 0.0], 8.0, 6.0, 4.5,
        [makePortal(1, 'outdoor', 1, [2.0, 2.6]), makePortal(2, 0x0102, 3)],
        [
          makeStatic(0x02100101, 'basalt_column', [-3.0, 0.0, 0.0]),
          makeStatic(0x02100101, 'basalt_column', [3.0, 0.0, 0.0]),
          makeStatic(0x02100102, 'soulfire_brazier', [0.0, 1.5, 0.0]),
          makeStatic(0x02100103, 'iron_candelabra', [-2.5, -1.5, 0.0]),
          makeStatic(0x02100103, 'iron_candelabra', [2.5, -1.5, 0.0])
        ]
      ),
      makeCell(0x0102, 'Pillared_Nave', [0.0, 0.0, 0.0], 14.0, 10.0, 6.5,
        [makePortal(3, 0x0101, 2), makePortal(4, 0x0103, 5), makePortal(6, 0x0104, 7)],
        [
          makeStatic(0x02100101, 'basalt_column', [-5.0, -3.0, 0.0]),
          makeStatic(0x02100101, 'basalt_column', [5.0, -3.0, 0.0]),
          makeStatic(0x02100101, 'basalt_column', [-5.0, 3.0, 0.0]),
          makeStatic(0x02100101, 'basalt_column', [5.0, 3.0, 0.0]),
          makeStatic(0x02100102, 'soulfire_brazier', [-3.0, 3.0, 0.0]),
          makeStatic(0x02100102, 'soulfire_brazier', [3.0, 3.0, 0.0]),
          makeStatic(0x02100106, 'black_iron_banner', [-6.0, 0.0, 3.5]),
          makeStatic(0x02100106, 'black_iron_banner', [6.0, 0.0, 3.5])
        ]
      ),
      makeCell(0x0103, 'Sanctuary_Altar_Dais', [0.0, 6.5, 0.5], 10.0, 6.0, 6.0,
        [makePortal(5, 0x0102, 4)],
        [
          makeStatic(0x02100104, 'obsidian_throne_of_sarvien', [0.0, 1.5, 0.0]),
          makeStatic(0x02100105, 'necrotic_dais', [0.0, 0.0, 0.0]),
          makeStatic(0x02100102, 'soulfire_brazier', [-3.0, 1.0, 0.0]),
          makeStatic(0x02100102, 'soulfire_brazier', [3.0, 1.0, 0.0])
        ]
      ),
      makeCell(0x0104, 'Crypt_Vestry', [8.0, 2.0, 0.0], 6.0, 8.0, 4.0,
        [makePortal(7, 0x0102, 6)],
        [
          makeStatic(0x02100107, 'ancient_sarcophagus', [1.5, 1.0, 0.0]),
          makeStatic(0x02100109, 'urn_of_relics', [-1.5, 1.0, 0.0]),
          makeStatic(0x02100103, 'iron_candelabra', [0.0, -2.5, 0.0])
        ]
      )
    ]
  },

  // 16. Provincial Tavern ("The Frost Flagon") (0x01100033) - 5 cells, 25 statics, 5 portals
  {
    modelId: 0x01100033,
    hexModelId: '0x01100033',
    name: 'Provincial_Tavern_Frost_Flagon',
    culture: 'CommonCivic',
    province: 'Universal',
    footprint: { widthMeters: 26.0, depthMeters: 22.0, heightMeters: 12.0 },
    numLeaves: 16,
    exteriorMesh: {
      surfaces: [
        { surfaceDid: 0x08100101, hexDid: '0x08100101', name: 'ashatiri_dark_granite_wall', materialType: 'Base1Image' },
        { surfaceDid: 0x08100102, hexDid: '0x08100102', name: 'ironwood_timber_beam', materialType: 'Base1Image' }
      ],
      portals: [
        { portalId: 1, flags: 1, otherCellId: 0x0101, otherPortalId: 1, frameOrigin: [0.0, -11.0, 0.0], clearance: { width: 1.6, height: 2.4 } }
      ]
    },
    interiorCells: [
      makeCell(0x0101, 'Tavern_Porch', [0.0, -8.0, 0.0], 6.0, 6.0, 3.8,
        [makePortal(1, 'outdoor', 1), makePortal(2, 0x0102, 3)],
        [
          makeStatic(0x02100201, 'ironwood_bench', [-2.0, 0.0, 0.0]),
          makeStatic(0x02100201, 'ironwood_bench', [2.0, 0.0, 0.0]),
          makeStatic(0x02100202, 'forged_lantern', [0.0, 1.5, 2.2]),
          makeStatic(0x02100217, 'storage_cask', [-2.0, -1.5, 0.0])
        ]
      ),
      makeCell(0x0102, 'Common_Taproom', [0.0, 0.0, 0.0], 14.0, 10.0, 5.0,
        [makePortal(3, 0x0101, 2), makePortal(4, 0x0103, 5), makePortal(6, 0x0104, 7), makePortal(8, 0x0105, 9)],
        [
          makeStatic(0x02100228, 'tavern_bar_counter', [0.0, 3.5, 0.0]),
          makeStatic(0x02100207, 'oak_keg_stand', [-4.0, 4.0, 0.0]),
          makeStatic(0x02100207, 'oak_keg_stand', [4.0, 4.0, 0.0]),
          makeStatic(0x02100204, 'trestle_table', [-3.5, -1.5, 0.0]),
          makeStatic(0x02100204, 'trestle_table', [3.5, -1.5, 0.0]),
          makeStatic(0x02100201, 'ironwood_bench', [-3.5, -3.0, 0.0]),
          makeStatic(0x02100201, 'ironwood_bench', [3.5, -3.0, 0.0]),
          makeStatic(0x02100203, 'granite_hearth', [-5.5, 1.0, 0.0]),
          makeStatic(0x02100208, 'iron_chandelier', [0.0, 0.0, 4.0])
        ]
      ),
      makeCell(0x0103, 'Hearth_Kitchen', [-8.0, 2.0, 0.0], 6.0, 8.0, 4.0,
        [makePortal(5, 0x0102, 4)],
        [
          makeStatic(0x02100221, 'clay_cooking_pots', [0.0, 2.0, 0.0]),
          makeStatic(0x02100212, 'craft_workbench', [-1.5, -1.0, 0.0]),
          makeStatic(0x02100217, 'storage_cask', [1.5, -1.0, 0.0]),
          makeStatic(0x02100202, 'forged_lantern', [0.0, 2.5, 2.2])
        ]
      ),
      makeCell(0x0104, 'Ale_Cellar', [8.0, 2.0, -1.5], 6.0, 8.0, 3.5,
        [makePortal(7, 0x0102, 6)],
        [
          makeStatic(0x02100217, 'storage_cask', [-1.5, 2.0, 0.0]),
          makeStatic(0x02100217, 'storage_cask', [1.5, 2.0, 0.0]),
          makeStatic(0x02100217, 'storage_cask', [-1.5, -2.0, 0.0]),
          makeStatic(0x02100217, 'storage_cask', [1.5, -2.0, 0.0])
        ]
      ),
      makeCell(0x0105, 'Upper_Sleeping_Loft', [0.0, 6.0, 4.5], 10.0, 6.0, 3.5,
        [makePortal(9, 0x0102, 8)],
        [
          makeStatic(0x02100222, 'timber_bunkbed', [-3.0, 1.0, 0.0]),
          makeStatic(0x02100222, 'timber_bunkbed', [3.0, 1.0, 0.0]),
          makeStatic(0x02100216, 'vault_chest', [0.0, -1.5, 0.0]),
          makeStatic(0x02100202, 'forged_lantern', [0.0, 1.5, 2.0])
        ]
      )
    ]
  },

  // 17. Covered Market Pavilion (0x01100034) - 4 cells, 18 statics, 4 portals
  {
    modelId: 0x01100034,
    hexModelId: '0x01100034',
    name: 'Covered_Market_Pavilion',
    culture: 'CommonCivic',
    province: 'Universal',
    footprint: { widthMeters: 24.0, depthMeters: 20.0, heightMeters: 10.0 },
    numLeaves: 14,
    exteriorMesh: {
      surfaces: [
        { surfaceDid: 0x08100101, hexDid: '0x08100101', name: 'ashatiri_dark_granite_wall', materialType: 'Base1Image' },
        { surfaceDid: 0x08100102, hexDid: '0x08100102', name: 'ironwood_timber_beam', materialType: 'Base1Image' }
      ],
      portals: [
        { portalId: 1, flags: 1, otherCellId: 0x0101, otherPortalId: 1, frameOrigin: [0.0, -10.0, 0.0], clearance: { width: 2.2, height: 2.6 } }
      ]
    },
    interiorCells: [
      makeCell(0x0101, 'Market_Entrance_Arches', [0.0, -7.0, 0.0], 8.0, 6.0, 4.5,
        [makePortal(1, 'outdoor', 1, [2.2, 2.6]), makePortal(2, 0x0102, 3)],
        [
          makeStatic(0x02100205, 'ironwood_pillar', [-3.0, 0.0, 0.0]),
          makeStatic(0x02100205, 'ironwood_pillar', [3.0, 0.0, 0.0]),
          makeStatic(0x02100202, 'forged_lantern', [-3.0, -2.0, 2.5]),
          makeStatic(0x02100202, 'forged_lantern', [3.0, -2.0, 2.5])
        ]
      ),
      makeCell(0x0102, 'Central_Exchange_Court', [0.0, 0.0, 0.0], 14.0, 10.0, 5.5,
        [makePortal(3, 0x0101, 2), makePortal(4, 0x0103, 5), makePortal(6, 0x0104, 7)],
        [
          makeStatic(0x02100204, 'trestle_table', [-3.5, 0.0, 0.0]),
          makeStatic(0x02100204, 'trestle_table', [3.5, 0.0, 0.0]),
          makeStatic(0x02100225, 'ore_assay_scales', [0.0, 3.0, 0.0]),
          makeStatic(0x02100205, 'ironwood_pillar', [-5.0, -3.0, 0.0]),
          makeStatic(0x02100205, 'ironwood_pillar', [5.0, -3.0, 0.0]),
          makeStatic(0x02100205, 'ironwood_pillar', [-5.0, 3.0, 0.0]),
          makeStatic(0x02100205, 'ironwood_pillar', [5.0, 3.0, 0.0]),
          makeStatic(0x02100206, 'heraldic_banner', [0.0, 4.0, 3.5])
        ]
      ),
      makeCell(0x0103, 'Merchant_Lockers', [-7.0, 2.0, 0.0], 6.0, 8.0, 4.0,
        [makePortal(5, 0x0102, 4)],
        [
          makeStatic(0x02100216, 'vault_chest', [-1.5, 2.0, 0.0]),
          makeStatic(0x02100216, 'vault_chest', [1.5, 2.0, 0.0]),
          makeStatic(0x02100217, 'storage_cask', [0.0, -2.0, 0.0])
        ]
      ),
      makeCell(0x0104, 'Bailiff_Weigh_Post', [7.0, 2.0, 0.0], 6.0, 8.0, 4.0,
        [makePortal(7, 0x0102, 6)],
        [
          makeStatic(0x02100209, 'guildmaster_desk', [0.0, 1.5, 0.0]),
          makeStatic(0x02100210, 'iron_bound_safe', [-1.5, -2.0, 0.0]),
          makeStatic(0x02100202, 'forged_lantern', [1.5, -2.0, 2.2])
        ]
      )
    ]
  },

  // 18. Municipal Watchtower (0x01100035) - 4 cells, 16 statics, 4 portals
  {
    modelId: 0x01100035,
    hexModelId: '0x01100035',
    name: 'Municipal_Watchtower',
    culture: 'CommonCivic',
    province: 'Universal',
    footprint: { widthMeters: 16.0, depthMeters: 16.0, heightMeters: 28.0 },
    numLeaves: 16,
    exteriorMesh: {
      surfaces: [
        { surfaceDid: 0x08100101, hexDid: '0x08100101', name: 'ashatiri_dark_granite_wall', materialType: 'Base1Image' }
      ],
      portals: [
        { portalId: 1, flags: 1, otherCellId: 0x0101, otherPortalId: 1, frameOrigin: [0.0, -8.0, 0.0], clearance: { width: 1.5, height: 2.3 } }
      ]
    },
    interiorCells: [
      makeCell(0x0101, 'Ground_Barbican', [0.0, -4.0, 0.0], 6.0, 6.0, 4.5,
        [makePortal(1, 'outdoor', 1), makePortal(2, 0x0102, 3)],
        [
          makeStatic(0x02100205, 'ironwood_pillar', [-2.0, 0.0, 0.0]),
          makeStatic(0x02100205, 'ironwood_pillar', [2.0, 0.0, 0.0]),
          makeStatic(0x02100213, 'smith_tool_rack', [-2.0, 1.5, 0.0]),
          makeStatic(0x02100202, 'forged_lantern', [2.0, 1.5, 2.2])
        ]
      ),
      makeCell(0x0102, 'Winch_and_Store_Room', [0.0, 0.0, 7.0], 6.0, 6.0, 4.0,
        [makePortal(3, 0x0101, 2), makePortal(4, 0x0103, 5)],
        [
          makeStatic(0x02100217, 'storage_cask', [-2.0, 1.5, 0.0]),
          makeStatic(0x02100217, 'storage_cask', [2.0, 1.5, 0.0]),
          makeStatic(0x02100216, 'vault_chest', [0.0, -2.0, 0.0]),
          makeStatic(0x02100202, 'forged_lantern', [0.0, 2.0, 2.2])
        ]
      ),
      makeCell(0x0103, 'Sentry_Guard_Post', [0.0, 0.0, 14.0], 6.0, 6.0, 4.0,
        [makePortal(5, 0x0102, 4), makePortal(6, 0x0104, 7)],
        [
          makeStatic(0x02100201, 'ironwood_bench', [-2.0, 0.0, 0.0]),
          makeStatic(0x02100213, 'smith_tool_rack', [2.0, 0.0, 0.0]),
          makeStatic(0x02100202, 'forged_lantern', [0.0, 2.0, 2.2]),
          makeStatic(0x02100206, 'heraldic_banner', [0.0, -2.5, 2.5])
        ]
      ),
      makeCell(0x0104, 'Battlement_Beacon_Crown', [0.0, 0.0, 21.0], 6.0, 6.0, 4.0,
        [makePortal(7, 0x0103, 6)],
        [
          makeStatic(0x02100208, 'iron_chandelier', [0.0, 0.0, 2.5]),
          makeStatic(0x02100203, 'granite_hearth', [0.0, 0.0, 0.0]),
          makeStatic(0x02100202, 'forged_lantern', [-2.5, 0.0, 1.5]),
          makeStatic(0x02100202, 'forged_lantern', [2.5, 0.0, 1.5])
        ]
      )
    ]
  }
];

// Write all 18 blueprints to dist/dericost/towns/blueprints/*.blueprint.json
console.log(`Writing ${BLUEPRINT_DEFS.length} building blueprints to ${BLUEPRINTS_DIR}...`);
const BLUEPRINT_MAP = {};
for (const bp of BLUEPRINT_DEFS) {
  BLUEPRINT_MAP[bp.hexModelId] = bp;
  const fileName = `${bp.hexModelId}.blueprint.json`;
  const filePath = path.join(BLUEPRINTS_DIR, fileName);
  fs.writeFileSync(filePath, JSON.stringify(bp, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// CANONICAL 41 TOWNS PLACEMENT
// ---------------------------------------------------------------------------

const CANONICAL_TOWNS = [];
for (const [provName, provData] of Object.entries(DERICOST_PROVINCES)) {
  const bounds = zoneBounds[provName];
  const townNames = provData.towns;
  const stepX = (bounds.xMax - bounds.xMin) / (townNames.length + 1);
  const stepY = (bounds.yMax - bounds.yMin) / (townNames.length + 1);

  townNames.forEach((townName, idx) => {
    const x = Math.round((bounds.xMin + stepX * (idx + 1)) * 10) / 10;
    const y = Math.round((bounds.yMin + stepY * ((idx % 2 === 0) ? (idx + 1) : (townNames.length - idx))) * 10) / 10;
    const lbX = Math.floor(x / 192.0);
    const lbY = Math.floor((y - 68928.0) / 192.0);
    const lx = x - lbX * 192.0;
    const ly = y - (68928.0 + lbY * 192.0);

    // Height sampling from terrain mesh
    let z = Math.round(sampleTerrainHeight(lbX, lbY, lx, ly) * 10) / 10;
    // Waterline ports/marshes have sea-level docks
    if (['Nesortania', 'South-Haven', 'Daralet', 'Pines-Foot'].includes(townName) && z < 1.0) {
      z = 0.0;
    }

    // Continent Bit 15 set: (1 << 31) in uint32 or 0x8001
    const cellId = (((1 << 31) | (lbX << 24) | (lbY << 16) | 1) >>> 0);
    const serverCellId = '0x' + (((lbX << 24) | (lbY << 16) | 0x8001) >>> 0).toString(16).toUpperCase().padStart(8, '0');

    CANONICAL_TOWNS.push({
      name: townName,
      slug: slugify(townName),
      province: provName,
      culture: provData.culture,
      architecture: provData.architecture,
      x,
      y,
      z,
      lbX,
      lbY,
      lx: Math.round(lx * 100) / 100,
      ly: Math.round(ly * 100) / 100,
      cellId,
      serverCellId,
      clearanceRadiusMeters: 288.0
    });
  });
}

// ---------------------------------------------------------------------------
// TOWN BUILDING & DOOR PLACEMENT GENERATOR
// ---------------------------------------------------------------------------

// Per-landblock building records map: "0xXXXX" -> [records]
const LANDBLOCK_BUILDINGS = {};

function addRecordToLandblock(lbX, lbY, record) {
  const hex = '0x' + (((lbX << 8) | lbY) >>> 0).toString(16).toUpperCase().padStart(4, '0');
  if (!LANDBLOCK_BUILDINGS[hex]) {
    LANDBLOCK_BUILDINGS[hex] = [];
  }
  LANDBLOCK_BUILDINGS[hex].push(record);
}

// 14 building specifications with their designated radial rings
function getBuildingRoles(primaryNobleModelId, secondaryResidentialModelId) {
  return [
    { role: 'seat', modelId: primaryNobleModelId, ring: 'center', rMin: 0, rMax: 15, baseAngle: 0 },
    // Inner ring (3 buildings): r in [40m, 80m]
    { role: 'town_hall', modelId: '0x01100030', ring: 'inner', rMin: 40, rMax: 80, baseAngle: 0 },
    { role: 'temple', modelId: '0x01100032', ring: 'inner', rMin: 40, rMax: 80, baseAngle: (2 * Math.PI) / 3 },
    { role: 'market', modelId: '0x01100034', ring: 'inner', rMin: 40, rMax: 80, baseAngle: (4 * Math.PI) / 3 },
    // Middle ring (6 buildings): r in [90m, 150m]
    { role: 'barracks', modelId: '0x01100031', ring: 'middle', rMin: 90, rMax: 150, baseAngle: Math.PI / 6 },
    { role: 'tavern', modelId: '0x01100033', ring: 'middle', rMin: 90, rMax: 150, baseAngle: Math.PI / 2 },
    { role: 'residential_1', modelId: secondaryResidentialModelId, ring: 'middle', rMin: 90, rMax: 150, baseAngle: (5 * Math.PI) / 6 },
    { role: 'inn', modelId: '0x01100033', ring: 'middle', rMin: 90, rMax: 150, baseAngle: (7 * Math.PI) / 6 },
    { role: 'residential_2', modelId: secondaryResidentialModelId, ring: 'middle', rMin: 90, rMax: 150, baseAngle: (3 * Math.PI) / 2 },
    { role: 'residential_3', modelId: secondaryResidentialModelId, ring: 'middle', rMin: 90, rMax: 150, baseAngle: (11 * Math.PI) / 6 },
    // Outer perimeter (4 watchtowers): r in [170m, 210m]
    { role: 'watchtower_ne', modelId: '0x01100035', ring: 'outer', rMin: 170, rMax: 210, baseAngle: Math.PI / 4 },
    { role: 'watchtower_nw', modelId: '0x01100035', ring: 'outer', rMin: 170, rMax: 210, baseAngle: (3 * Math.PI) / 4 },
    { role: 'watchtower_sw', modelId: '0x01100035', ring: 'outer', rMin: 170, rMax: 210, baseAngle: (5 * Math.PI) / 4 },
    { role: 'watchtower_se', modelId: '0x01100035', ring: 'outer', rMin: 170, rMax: 210, baseAngle: (7 * Math.PI) / 4 }
  ];
}

function solveTownLayout(town, specs) {
  const placed = [];
  const lbCounts = {};

  for (const spec of specs) {
    const bp = BLUEPRINT_MAP[spec.modelId];
    const halfW = bp.footprint.widthMeters / 2;
    const halfD = bp.footprint.depthMeters / 2;
    const marginX = halfW + 1.5;
    const marginY = halfD + 1.5;

    let bestCandidate = null;
    let minCost = Infinity;

    // Search radii: try standard ring first, then expanded fallback if needed
    const rSteps = [];
    if (spec.role === 'seat') {
      rSteps.push(0);
      for (let r = 5; r <= 30; r += 5) rSteps.push(r);
    } else {
      // Primary ring search
      for (let r = spec.rMin; r <= spec.rMax; r += 5) {
        rSteps.push(r);
      }
      // Fallback expansion within strict bounds <= 220m
      if (spec.ring === 'inner') {
        for (let r = spec.rMax + 5; r <= 100; r += 5) rSteps.push(r);
        for (let r = spec.rMin - 5; r >= 20; r -= 5) rSteps.push(r);
      } else if (spec.ring === 'middle') {
        for (let r = spec.rMax + 5; r <= 210; r += 5) rSteps.push(r);
        for (let r = spec.rMin - 5; r >= 40; r -= 5) rSteps.push(r);
      } else if (spec.ring === 'outer') {
        for (let r = spec.rMax + 5; r <= 215; r += 5) rSteps.push(r);
        for (let r = spec.rMin - 5; r >= 80; r -= 5) rSteps.push(r);
      }
    }

    // Search angles: start at baseAngle, then alternate clockwise / counter-clockwise
    const angleOffsets = [0];
    for (let step = 1; step <= 24; step++) {
      const delta = (step * Math.PI) / 24; // 7.5 deg increments up to 180 deg
      angleOffsets.push(delta);
      angleOffsets.push(-delta);
    }

    for (const r of rSteps) {
      for (const dTheta of angleOffsets) {
        const theta = spec.baseAngle + dTheta;
        const targetWx = town.x + r * Math.cos(theta);
        const targetWy = town.y + r * Math.sin(theta);

        const bLbX = Math.floor(targetWx / 192.0);
        const bLbY = Math.floor((targetWy - 68928.0) / 192.0);
        if (bLbX < 0 || bLbX > 254 || bLbY < 0 || bLbY > 254) continue;
        // Strictly enforce town 3x3 landblock footprint
        if (Math.abs(bLbX - town.lbX) > 1 || Math.abs(bLbY - town.lbY) > 1) continue;

        let bLx = targetWx - bLbX * 192.0;
        let bLy = targetWy - (68928.0 + bLbY * 192.0);

        // Clamp within landblock margins to prevent edge spillover
        bLx = Math.max(marginX, Math.min(192.0 - marginX, bLx));
        bLy = Math.max(marginY, Math.min(192.0 - marginY, bLy));

        const bWx = bLbX * 192.0 + bLx;
        const bWy = 68928.0 + bLbY * 192.0 + bLy;

        const actualDist = Math.hypot(bWx - town.x, bWy - town.y);
        if (actualDist > 220.0) continue; // Strictly <= 220m

        // Check landblock building count limit <= 2
        const lbHex = '0x' + (((bLbX << 8) | bLbY) >>> 0).toString(16).toUpperCase().padStart(4, '0');
        if ((lbCounts[lbHex] || 0) >= 2) continue;

        // Check collision with solid scenery in landblock
        const scFile = path.join(SCENERY_DIR, `${lbHex}.scenery.jsonl`);
        let scCollides = false;
        if (fs.existsSync(scFile)) {
          const scContent = fs.readFileSync(scFile, 'utf8').trim();
          if (scContent) {
            for (const line of scContent.split('\n')) {
              if (!line) continue;
              const sc = JSON.parse(line);
              if (!SOLID_SCENERY_IDS.has(sc.obj_id)) continue;
              if (Math.abs(sc.x - bLx) < (halfW + 0.5) && Math.abs(sc.y - bLy) < (halfD + 0.5)) {
                scCollides = true;
                break;
              }
            }
          }
        }
        // Check overlap with already placed buildings in town
        let collides = false;
        for (const p of placed) {
          const cDist = Math.hypot(bWx - p.bWx, bWy - p.bWy);
          if (cDist < 20.0) { collides = true; break; }
          const overlapX = Math.abs(bWx - p.bWx) < (halfW + p.halfW + 1.0);
          const overlapY = Math.abs(bWy - p.bWy) < (halfD + p.halfD + 1.0);
          if (overlapX && overlapY) { collides = true; break; }
        }
        if (collides) continue;

        // Sample terrain
        const terr = sampleTerrain(bLbX, bLbY, bLx, bLy);
        let bZ = Math.round(terr.z * 10) / 10;
        if (['Nesortania', 'South-Haven', 'Daralet', 'Pines-Foot'].includes(town.name) && bZ < 0.5) {
          bZ = 0.5;
        }

        // Requirements check
        if (town.name === 'Vasmora' && bZ < 350.0) continue;
        if (['Nesortania', 'South-Haven', 'Daralet', 'Pines-Foot'].includes(town.name) && bZ < 0.5) continue;
        if (terr.slopeDeg > 45.0) continue; // Allow natural hillside/dune placement up to 45 degrees (cost prefers flatter terraces)

        // Scoring cost function (scCollides adds a soft penalty; colliding scenery is pruned in step 1932)
        const angleDiff = Math.abs(dTheta);
        const cost = terr.slopeDeg * 2.0 + (scCollides ? 40.0 : 0.0) + angleDiff * 15.0 + Math.abs(r - (spec.rMin + spec.rMax) / 2) * 0.1;

        if (cost < minCost) {
          minCost = cost;
          bestCandidate = {
            role: spec.role,
            modelId: spec.modelId,
            bLbX, bLbY, bLx, bLy, bWx, bWy, bZ,
            halfW, halfD,
            actualDist,
            lbHex,
            slopeDeg: terr.slopeDeg
          };
        }
      }
      if (bestCandidate && minCost < 25.0) break; // Good enough candidate found
    }

    if (!bestCandidate) {
      throw new Error(`Failed to place ${spec.role} in town ${town.name}!`);
    }

    placed.push(bestCandidate);
    lbCounts[bestCandidate.lbHex] = (lbCounts[bestCandidate.lbHex] || 0) + 1;
  }

  return placed;
}

// Generate town building layout
const TOWN_FILES_DATA = [];
let globalDoorGuid = 0x70001;
let globalBuildingGuid = 0x80001;

for (const town of CANONICAL_TOWNS) {
  const townBuildings = [];
  const townDoors = [];

  // Determine architectural palette based on province
  let primaryNobleModelId;
  let secondaryResidentialModelId;
  let doorWeenieClassId;
  let doorClassName;

  if (town.province === 'Gelid Plateau') {
    primaryNobleModelId = (town.name === 'Vasmora') ? '0x01100001' : '0x01100002';
    secondaryResidentialModelId = '0x01100004';
    doorWeenieClassId = 90101;
    doorClassName = 'dericost-door-iron-runic';
  } else if (town.province === 'Dericost Marshes') {
    primaryNobleModelId = '0x01100012'; // Stilted Fen-Manor
    secondaryResidentialModelId = '0x01100004'; // Mausoleum Hall
    doorWeenieClassId = 90101;
    doorClassName = 'dericost-door-iron-runic';
  } else if (town.province === 'The High Desert Plateau') {
    primaryNobleModelId = (town.name === 'Shakrassekor') ? '0x01100020' : '0x01100021';
    secondaryResidentialModelId = '0x01100022';
    doorWeenieClassId = 90103;
    doorClassName = 'dericost-door-bronze-grill';
  } else {
    // Ashatiri, Tresimaen, Nesortania
    primaryNobleModelId = '0x01100010'; // Guildhall
    secondaryResidentialModelId = (town.name.includes('Quarry') || town.name.includes('Iron')) ? '0x01100013' : '0x01100011';
    doorWeenieClassId = 90102;
    doorClassName = 'dericost-door-ironwood-heavy';
  }

  // Pre-initialize all 9 landblocks in town 3x3 footprint to guarantee 369 streaming files
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const hex = '0x' + ((((town.lbX + dx) << 8) | (town.lbY + dy)) >>> 0).toString(16).toUpperCase().padStart(4, '0');
      if (!LANDBLOCK_BUILDINGS[hex]) LANDBLOCK_BUILDINGS[hex] = [];
    }
  }

  const specs = getBuildingRoles(primaryNobleModelId, secondaryResidentialModelId);
  const solvedPlacements = solveTownLayout(town, specs);

  for (const slot of solvedPlacements) {
    const { bLbX, bLbY, bLx, bLy, bWx, bWy, bZ } = slot;
    const cellX = Math.floor(bLx / 24.0);
    const cellY = Math.floor(bLy / 24.0);
    const outdoorCellNum = cellX * 8 + cellY + 1;
    const bCellId = (((bLbX << 24) | (bLbY << 16) | 0x8000 | outdoorCellNum) >>> 0);
    const bp = BLUEPRINT_MAP[slot.modelId];
    if (!bp) continue;

    const bldGuid = globalBuildingGuid++;

    // Collect exterior and interior doors for this building
    const bldDoorGuids = [];

    // 1. Exterior Door at aperture frameOrigin
    const extPortal = bp.exteriorMesh.portals[0];
    const extDoorGuid = globalDoorGuid++;
    bldDoorGuids.push(extDoorGuid);

    // Frame origin in landblock coords
    const doorLx = Math.round((bLx + (extPortal.frameOrigin?.[0] || 0.0)) * 100) / 100;
    const doorLy = Math.round((bLy + (extPortal.frameOrigin?.[1] || 0.0)) * 100) / 100;
    const doorLz = Math.round((bZ + (extPortal.frameOrigin?.[2] || 0.0)) * 100) / 100;

    const extDoorEntity = {
      guid: extDoorGuid,
      weenieClassId: doorWeenieClassId,
      className: doorClassName,
      weenieType: 19,
      isIndoor: false,
      obj_Cell_Id: bCellId,
      portalId: extPortal.portalId,
      targetInteriorCellId: extPortal.otherCellId,
      origin: [doorLx, doorLy, doorLz],
      worldOrigin: [Math.round((bLbX * 192.0 + doorLx) * 10) / 10, Math.round((68928.0 + bLbY * 192.0 + doorLy) * 10) / 10, doorLz],
      rotationZ: 0.0, // closed
      openRotationZ: -Math.PI / 2, // -1.570796 rad
      clearanceWidth: extPortal.clearance?.width || 1.6,
      clearanceHeight: extPortal.clearance?.height || 2.4,
      inCollisionIndex: true,
      state: 'closed'
    };
    townDoors.push(extDoorEntity);

    // 2. Interior Partition Doors
    for (const cell of bp.interiorCells) {
      for (const p of cell.portals) {
        if (p.toCell !== 'outdoor' && p.portalId % 2 === 0) { // one door per internal transition edge
          const intDoorGuid = globalDoorGuid++;
          bldDoorGuids.push(intDoorGuid);
          // Interior cell ID with Bit 15 set:
          const intCellFullId = (((bLbX << 24) | (bLbY << 16) | 0x8000 | cell.cellId) >>> 0);

          const intDoorEntity = {
            guid: intDoorGuid,
            weenieClassId: doorWeenieClassId,
            className: doorClassName,
            weenieType: 19,
            isIndoor: true,
            obj_Cell_Id: intCellFullId,
            portalId: p.portalId,
            targetInteriorCellId: p.toCell,
            origin: [cell.relativeOrigin[0], cell.relativeOrigin[1], cell.relativeOrigin[2]],
            rotationZ: 0.0,
            openRotationZ: -Math.PI / 2,
            clearanceWidth: p.clearance?.[0] || 1.5,
            clearanceHeight: p.clearance?.[1] || 2.3,
            inCollisionIndex: true,
            state: 'closed'
          };
          townDoors.push(intDoorEntity);
        }
      }
    }

    const buildingPlacement = {
      guid: bldGuid,
      modelId: bp.modelId,
      hexModelId: bp.hexModelId,
      name: bp.name,
      role: slot.role,
      landblock: [bLbX, bLbY],
      outdoorCell: outdoorCellNum,
      cellId: bCellId,
      localOrigin: [bLx, bLy, bZ],
      worldOrigin: [Math.round(bWx * 10) / 10, Math.round(bWy * 10) / 10, bZ],
      orientation: [0.0, 0.0, 0.0, 1.0], // Identity upright
      footprint: bp.footprint,
      numLeaves: bp.numLeaves,
      cellCount: bp.interiorCells.length,
      portalCount: bp.interiorCells.reduce((acc, c) => acc + c.portals.length, 0),
      staticsCount: bp.interiorCells.reduce((acc, c) => acc + c.statics.length, 0),
      doors: bldDoorGuids
    };
    townBuildings.push(buildingPlacement);

    // Stream record for landblock streaming
    addRecordToLandblock(bLbX, bLbY, {
      obj_id: bp.hexModelId,
      guid: bldGuid,
      x: bLx,
      y: bLy,
      z: bZ,
      qw: 1.0,
      qx: 0.0,
      qy: 0.0,
      qz: 0.0,
      scale: 1.0,
      is_building: true,
      cell_id: bCellId,
      cell_count: bp.interiorCells.length,
      portal_count: bp.interiorCells.reduce((acc, c) => acc + c.portals.length, 0),
      statics_count: bp.interiorCells.reduce((acc, c) => acc + c.statics.length, 0),
      doors: bldDoorGuids,
      stable_id: `dericost-building/${bLbX.toString(16)}_${bLbY.toString(16)}/${bp.hexModelId}/${cellX}_${cellY}`
    });

    // Also stream exterior door entity into landblock
    addRecordToLandblock(bLbX, bLbY, {
      obj_id: `0x${doorWeenieClassId.toString(16).toUpperCase()}`,
      guid: extDoorGuid,
      name: doorClassName,
      x: doorLx,
      y: doorLy,
      z: doorLz,
      qw: 1.0,
      qx: 0.0,
      qy: 0.0,
      qz: 0.0,
      scale: 1.0,
      is_building: false,
      is_door: true,
      weenie_type: 19,
      cell_id: bCellId,
      hinge_rotation_z: -Math.PI / 2,
      stable_id: `dericost-door/${bLbX.toString(16)}_${bLbY.toString(16)}/${extDoorGuid.toString(16)}`
    });
  }

  // Summary object for town_<slug>.json
  const townData = {
    name: town.name,
    slug: town.slug,
    province: town.province,
    culture: town.culture,
    architecture: town.architecture,
    coordinates: {
      worldX: town.x,
      worldY: town.y,
      worldZ: town.z,
      landblockX: town.lbX,
      landblockY: town.lbY,
      localX: town.lx,
      localY: town.ly,
      cellId: town.cellId,
      serverCellId: town.serverCellId,
      clearanceRadiusMeters: town.clearanceRadiusMeters
    },
    municipalFootprint: {
      landblockMin: [town.lbX - 1, town.lbY - 1],
      landblockMax: [town.lbX + 1, town.lbY + 1],
      totalLandblocks: 9
    },
    buildingCount: townBuildings.length,
    doorCount: townDoors.length,
    buildings: townBuildings,
    doors: townDoors
  };

  TOWN_FILES_DATA.push(townData);
  const townFilePath = path.join(TOWNS_DIR, `town_${town.slug}.json`);
  fs.writeFileSync(townFilePath, JSON.stringify(townData, null, 2), 'utf8');
}

// Write master dericost_towns_index.json
const masterIndex = {
  version: 1,
  totalTowns: CANONICAL_TOWNS.length,
  provinces: Object.keys(DERICOST_PROVINCES),
  provincialQuotas: {
    'Gelid Plateau': 10,
    'Ashatiri Lowlands': 8,
    'Valley of Tresimaen': 8,
    'Dericost Marshes': 6,
    'The High Desert Plateau': 6,
    'Nesortania Maritime Coast': 3
  },
  towns: TOWN_FILES_DATA.map(t => ({
    name: t.name,
    slug: t.slug,
    province: t.province,
    culture: t.culture,
    x: t.coordinates.worldX,
    y: t.coordinates.worldY,
    z: t.coordinates.worldZ,
    lbX: t.coordinates.landblockX,
    lbY: t.coordinates.landblockY,
    cellId: t.coordinates.cellId,
    serverCellId: t.coordinates.serverCellId,
    buildingCount: t.buildingCount,
    doorCount: t.doorCount
  }))
};

const indexPath = path.join(TOWNS_DIR, 'dericost_towns_index.json');
fs.writeFileSync(indexPath, JSON.stringify(masterIndex, null, 2), 'utf8');
console.log(`Successfully emitted master town index to ${indexPath} (41 towns).`);

// Clean existing streaming files in BUILDINGS_DIR before writing
for (const f of fs.readdirSync(BUILDINGS_DIR).filter(f => f.endsWith('.buildings.jsonl'))) {
  fs.unlinkSync(path.join(BUILDINGS_DIR, f));
}

// Write per-landblock .buildings.jsonl files
let totalLBCount = 0;
let totalBuildingRecordCount = 0;
for (const [lbHex, records] of Object.entries(LANDBLOCK_BUILDINGS)) {
  const lbFile = path.join(BUILDINGS_DIR, `${lbHex}.buildings.jsonl`);
  const lines = records.length > 0 ? (records.map(r => JSON.stringify(r)).join('\n') + '\n') : '';
  fs.writeFileSync(lbFile, lines, 'utf8');
  totalLBCount++;
  totalBuildingRecordCount += records.length;
}

console.log(`Successfully emitted ${totalLBCount} landblock streaming files (${totalBuildingRecordCount} total building & door records) to ${BUILDINGS_DIR}.`);

// ---------------------------------------------------------------------------
// LAYER 2: SCENERY BOUNDING-BOX COLLISION PRUNING
// ---------------------------------------------------------------------------
console.log('Running scenery bounding-box collision pruning pass...');
const buildingsByHex = {};
for (const td of TOWN_FILES_DATA) {
  for (const b of td.buildings) {
    const bp = BLUEPRINT_MAP[b.hexModelId];
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

    for (let lx = minLbX; lx <= maxLbX; lx++) {
      for (let ly = minLbY; ly <= maxLbY; ly++) {
        const hex = '0x' + (((lx << 8) | ly) >>> 0).toString(16).toUpperCase().padStart(4, '0');
        if (!buildingsByHex[hex]) buildingsByHex[hex] = [];
        buildingsByHex[hex].push({ minX, maxX, minY, maxY, guid: b.guid, name: b.name });
      }
    }
  }
}

let totalPrunedScenery = 0;
let touchedLandblocksPruned = 0;

for (const [hex, bList] of Object.entries(buildingsByHex)) {
  const scPath = path.join(SCENERY_DIR, `${hex}.scenery.jsonl`);
  if (!fs.existsSync(scPath)) continue;

  const content = fs.readFileSync(scPath, 'utf8').trim();
  if (!content) continue;

  const lbX = parseInt(hex.slice(2, 4), 16);
  const lbY = parseInt(hex.slice(4, 6), 16);
  const lines = content.split('\n');
  const keptRecords = [];
  let prunedInLb = 0;

  for (const line of lines) {
    if (!line) continue;
    const prop = JSON.parse(line);
    const propWx = lbX * 192.0 + prop.x;
    const propWy = 68928.0 + lbY * 192.0 + prop.y;

    let collides = false;
    if (SOLID_SCENERY_IDS.has(prop.obj_id)) {
      for (const b of bList) {
        if (propWx >= b.minX && propWx <= b.maxX && propWy >= b.minY && propWy <= b.maxY) {
          collides = true;
          break;
        }
      }
    }

    if (collides) {
      prunedInLb++;
      totalPrunedScenery++;
    } else {
      keptRecords.push(line);
    }
  }

  if (prunedInLb > 0) {
    fs.writeFileSync(scPath, keptRecords.length > 0 ? (keptRecords.join('\n') + '\n') : '', 'utf8');
    touchedLandblocksPruned++;
  }
}

console.log(`[SCENERY PRUNING] Pruned ${totalPrunedScenery} solid obstacles across ${touchedLandblocksPruned} landblocks.`);
console.log('[SCENERY PRUNING] 100% of town building footprints are now clear of solid obstacle collisions.');
console.log('Town, building blueprint, and door framework generation complete!');
