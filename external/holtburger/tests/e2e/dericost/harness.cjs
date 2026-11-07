/**
 * external/holtburger/tests/e2e/dericost/harness.cjs
 * Shared test harness and authoritative constants for Dericost E2E test suite.
 */

const fs = require('node:fs');
const path = require('node:path');

// Authoritative constants derived from PROJECT.md, TEST_INFRA.md, ORIGINAL_REQUEST.md, and surveys
const CONSTANTS = {
  // Grid & World
  GRID_SIZE: 255,
  CELL_SIZE: 24.0,
  LB_SIZE: 192.0, // 8 * 24.0
  NUM_LANDBLOCKS: 65025, // 255 * 255
  TOTAL_SAMPLES: 2041, // 255 * 8 + 1
  TOTAL_VERTICES: 4165681, // 2041 * 2041
  WORLD_METERS: 48960.0, // 255 * 192.0
  TOTAL_WORLD_AREA_KM2: 2397.0816,

  // Dereth Baselines (from world_meta.json, world_types.u8, retail census)
  DERETH_DRY_LAND_KM2: 1321.27,
  DERETH_DRY_LAND_RATIO: 0.5512,
  DERETH_WATER_KM2: 1075.81,
  DERETH_ELEVATION_MIN: 0.0,
  DERETH_ELEVATION_MAX: 670.0,
  DERETH_TOWN_COUNT: 41,
  DERETH_SCENERY_PROPS_TOTAL: 3786620,
  DERETH_SCENERY_DENSITY_DRY_LAND: 2865.89, // props / km2
  DERETH_SCENERY_DENSITY_PER_LB: 76.9,
  DERETH_TREE_COUNT: 1493946,
  DERETH_TREE_DENSITY: 1130.69, // trees / km2
  DERETH_FERN_COUNT: 496423,
  DERETH_FERN_DENSITY: 375.72, // ferns / km2
  DERETH_CREATURE_SPAWNS: 76855,
  DERETH_GENERATORS: 201291,
  DERETH_ROAD_VERTICES: 7906,
  DERETH_ROAD_KM: 189.74,

  // Ocean Gap & Dericost Coordinate Space
  DERETH_NORTH_SHORE_Y: 48960.0,
  OCEAN_GAP_LBS: 104,
  OCEAN_GAP_METERS: 19968.0, // 104 * 192.0
  DERICOST_SOUTH_SHORE_Y: 68928.0, // 48960.0 + 19968.0
  DERICOST_NORTH_BOUND_Y: 117888.0, // 68928.0 + 48960.0
  DERICOST_WEST_X: 0.0,
  DERICOST_EAST_X: 48960.0,
  DERICOST_TOTAL_AREA_KM2: 2397.0816,
  DERICOST_MIN_DRY_LAND_KM2: 1321.3,
  DERICOST_TOWN_COUNT: 41,

  // Global CDLOD Quadtree Envelope
  CDLOD_ROOT_ORIGIN: -73728.0,
  CDLOD_LEVELS: 9,
  CDLOD_ROOT_SPAN: 196608.0,
  CDLOD_ROOT_MAX: 122880.0, // -73728.0 + 196608.0

  // Hellcat Locomotion & Physics (VehicleProfile.cs / flight_model.js)
  HELLCAT_V_MIN: 30.0, // m/s (108 km/h)
  HELLCAT_V_CRUISE: 83.0, // m/s (298.8 km/h)
  HELLCAT_V_MAX: 111.0, // m/s (399.6 km/h)
  HELLCAT_ACCEL: 8.0, // m/s2
  HELLCAT_DECEL: 12.0, // m/s2
  HELLCAT_SIM_HZ: 30, // 30 Hz fixed step
  HELLCAT_DT: 1.0 / 30.0,
  HELLCAT_CLIMB_MAX: 20.0,
  HELLCAT_SINK_MAX: 25.0,
  HELLCAT_FLOOR_AGL: 30.0,
  HELLCAT_CEILING_AGL: 450.0,
  NOMINAL_FLIGHT_SECONDS: 240.0, // 4 minutes
  OCEAN_FLIGHT_TIME_CRUISE: 240.5783, // 19968.0 / 83.0

  // Shaders & VFX
  CANOPY_SOFTEN_DEFAULT: 0.65,
  TREESWAY_BASE_AMP: 0.03,
  TREESWAY_FREQ_HZ: 0.15,
  TREESWAY_FLUTTER: 0.3,

  // Architecture & Buildings (BuildingAnalyzer.cs)
  MIN_BUILDING_CELLS: 4,
  MIN_BUILDING_PORTALS: 2,
  MIN_BUILDING_STATICS: 14,
  MAX_PAIRED_HALF_RATIO: 1.35,
  DOOR_ROTATION_RAD: Math.PI / 2, // 90 degrees

  // 1070 Visual Regression
  CANONICAL_VIEW_COUNT: 10,
  QUALITY_PRESETS: ['low', 'mid', 'high', 'ultra'],
};

// Known province town distribution (Survey 2 §5.2)
const DERICOST_PROVINCES = {
  'Gelid Plateau': {
    theme: 'Northern Permafrost & Ice Throne',
    townCount: 10,
    dominantArchitecture: 'Monolithic black basalt & frost granite',
    towns: [
      'Vasmora', 'Frore', 'Frisirth', 'Minesh', 'Kelnir',
      'Gelid-Keep', 'Coldwatch', 'Boreal-Spires', 'Saliane', 'Glacier-Reach'
    ]
  },
  'Ashatiri Lowlands': {
    theme: 'Granite Hills & Iron Quarries',
    townCount: 8,
    dominantArchitecture: 'Heavy cyclopean granite masonry',
    towns: [
      'Antaoc', 'Hirschi', 'Nehane', 'Stone-Cleft',
      'Iron-Garrison', 'Grymar\'s Stand', 'Cynreft', 'High-Quarry'
    ]
  },
  'Valley of Tresimaen': {
    theme: 'Alpine/Volcanic Rift Valley',
    townCount: 8,
    dominantArchitecture: 'Dark slate shingles & volcanic rock walls',
    towns: [
      'Cannthalo', 'Zemal Foothills', 'Tresimaen', 'Hendrel\'s Gate',
      'Obsidian-Bluff', 'Ash-Haven', 'Sulfur-Springs', 'Orisis-Deep'
    ]
  },
  'Dericost Marshes': {
    theme: 'Low-lying Peat Bogs & Daralet Mires',
    townCount: 6,
    dominantArchitecture: 'Blackened timber stilts & sod roofs',
    towns: [
      'Daralet', 'Fen-Gate', 'Mhoire-Crosse', 'Bog-Haven',
      'Weeping-Creek', 'Mire-Watch'
    ]
  },
  'The High Desert Plateau': {
    theme: 'Arid Sandstone Mesas & Nomad Encampments',
    townCount: 6,
    dominantArchitecture: 'Adobe brick & limestone dome pavilions',
    towns: [
      'Shakrassekor', 'Berkesh', 'Ayn Tayan', 'Harebach Crose',
      'Sand-Bastion', 'Pines-Foot'
    ]
  },
  'Nesortania Maritime Coast': {
    theme: 'Southern Fjord Port & Shipyards',
    townCount: 3,
    dominantArchitecture: 'Marine limestone seawalls & timber slipways',
    towns: [
      'Nesortania', 'Galleys-Anchorage', 'South-Haven'
    ]
  }
};

// Known canonical view IDs from views.json
const CANONICAL_VIEWS = [
  'holtburg_plaza_noon',
  'holtburg_plaza_sunset',
  'academy_hilltop',
  'cottage_interior',
  'forge_closeup',
  'lifestone_closeup',
  'holtburg_cliff_south',
  'subdivided_hillside',
  'pom_cottage_wall',
  'ssao_building_corner'
];

// Test Registry for collecting tests
class TestSuite {
  constructor(name, tier) {
    this.name = name;
    this.tier = tier;
    this.tests = [];
  }

  addTest(name, fn, meta = {}) {
    this.tests.push({ name, fn, meta });
  }

  async run(runnerContext = {}) {
    const results = {
      suite: this.name,
      tier: this.tier,
      passed: 0,
      failed: 0,
      skipped: 0,
      tests: [],
      durationMs: 0
    };
    const t0 = Date.now();

    for (const test of this.tests) {
      const testResult = {
        name: test.name,
        status: 'passed',
        durationMs: 0,
        error: null,
        meta: test.meta
      };
      const testStart = Date.now();
      try {
        await test.fn();
        testResult.status = 'passed';
        results.passed++;
        if (runnerContext.verbose) {
          console.log(`    ✓ [PASS] ${test.name}`);
        }
      } catch (err) {
        testResult.status = 'failed';
        testResult.error = err.message;
        testResult.stack = err.stack;
        results.failed++;
        console.error(`    ✗ [FAIL] ${test.name}: ${err.message}`);
        if (runnerContext.verbose && err.stack) {
          console.error(`      ${err.stack.split('\n').slice(1, 4).join('\n      ')}`);
        }
      }
      testResult.durationMs = Date.now() - testStart;
      results.tests.push(testResult);
    }
    results.durationMs = Date.now() - t0;
    return results;
  }
}

// Global active registry
const registeredSuites = [];

function createSuite(name, tier) {
  const suite = new TestSuite(name, tier);
  registeredSuites.push(suite);
  return suite;
}

// Assertions
function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'Assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertNear(actual, expected, tolerance = 1e-4, message) {
  const diff = Math.abs(actual - expected);
  if (diff > tolerance) {
    throw new Error(`${message || 'Assertion near failed'}: ${actual} vs ${expected} (diff: ${diff}, tol: ${tolerance})`);
  }
}

function assertInRange(val, min, max, message) {
  if (val < min || val > max) {
    throw new Error(`${message || 'Assertion in range failed'}: ${val} not in [${min}, ${max}]`);
  }
}

function assertThrows(fn, regexOrType, message) {
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = true;
    if (regexOrType) {
      if (typeof regexOrType === 'string' && !err.message.includes(regexOrType)) {
        throw new Error(`${message || 'assertThrows failed'}: Error message "${err.message}" did not contain "${regexOrType}"`);
      } else if (regexOrType instanceof RegExp && !regexOrType.test(err.message)) {
        throw new Error(`${message || 'assertThrows failed'}: Error message "${err.message}" did not match ${regexOrType}`);
      }
    }
  }
  if (!threw) {
    throw new Error(message || 'Expected function to throw, but it did not throw');
  }
}

// Oracle file loaders
function getWorkspacePath(relPath) {
  const candidates = [
    path.resolve('/home/wbterminal/WorldBuilder-ACME-Edition', relPath),
    path.resolve('/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger', relPath),
    path.resolve('/home/wbterminal', relPath),
    path.resolve(__dirname, '../../../..', relPath),
    path.resolve(__dirname, '../../..', relPath),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

function loadJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

module.exports = {
  CONSTANTS,
  DERICOST_PROVINCES,
  CANONICAL_VIEWS,
  TestSuite,
  createSuite,
  registeredSuites,
  assert,
  assertEquals,
  assertNear,
  assertInRange,
  assertThrows,
  getWorkspacePath,
  loadJsonSafe
};
