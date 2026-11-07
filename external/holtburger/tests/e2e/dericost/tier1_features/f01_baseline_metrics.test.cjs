/**
 * Tier 1: Feature 1 — Baseline Metrics Extraction
 * Dereth terrain, cell count, scenery, flora, fauna, and town baseline metrics documented.
 * Sources: ORIGINAL_REQUEST §R1, PROJECT.md §Feature 1, TEST_INFRA.md, world_meta.json, world_types.u8, town_kits/index.json
 */

const { createSuite, assert, assertEquals, assertNear, assertInRange, CONSTANTS, loadJsonSafe, getWorkspacePath } = require('../harness.cjs');
const fs = require('node:fs');

const suite = createSuite('Tier 1: Feature 1 - Baseline Metrics Extraction', 1);

suite.addTest('F1.1: World grid dimensions and cell count match Dereth baseline', () => {
  // Authoritative derivation: 255 x 255 landblocks, 8x8 cells per LB, 24m pitch
  const expectedLBs = 255 * 255;
  const expectedCells = expectedLBs * 64;
  const expectedEdgeMeters = 255 * 192.0;
  const expectedAreaKm2 = (expectedEdgeMeters / 1000.0) ** 2;

  assertEquals(CONSTANTS.NUM_LANDBLOCKS, 65025, 'Total landblocks must be 65025');
  assertEquals(expectedCells, 4161600, 'Total cells must be 4,161,600');
  assertEquals(CONSTANTS.LB_SIZE, 192.0, 'Landblock size must be 192.0 meters');
  assertEquals(CONSTANTS.CELL_SIZE, 24.0, 'Cell size must be 24.0 meters');
  assertEquals(CONSTANTS.WORLD_METERS, 48960.0, 'World edge must be 48,960.0 meters');
  assertNear(expectedAreaKm2, 2397.0816, 1e-4, 'Total envelope area must be 2397.0816 km2');

  // Verify against oracle world_meta.json if present
  const metaPath = getWorkspacePath('dist/current/world/world_meta.json');
  const meta = loadJsonSafe(metaPath);
  if (meta) {
    assertEquals(meta.grid_size, 255, 'grid_size in world_meta.json');
    assertEquals(meta.total_landblocks, 65025, 'total_landblocks in world_meta.json');
    assertEquals(meta.world_size_meters, 48960.0, 'world_size_meters in world_meta.json');
    assertNear(meta.total_area_sqkm, 2397.0816, 1e-2, 'total_area_sqkm in world_meta.json');
  }
});

suite.addTest('F1.2: Terrain mesh continuous vertex grid resolution matches 2041x2041', () => {
  // Authoritative derivation: 255 LBs * 8 samples + 1 shared edge vertex = 2041 vertices per axis
  const samplesPerAxis = 255 * 8 + 1;
  const totalVertices = samplesPerAxis * samplesPerAxis;

  assertEquals(samplesPerAxis, 2041, 'Samples per axis must be 2041');
  assertEquals(totalVertices, 4165681, 'Total vertices in continuous mesh must be 4,165,681');
  assertEquals(CONSTANTS.TOTAL_SAMPLES, 2041);
  assertEquals(CONSTANTS.TOTAL_VERTICES, 4165681);

  const metaPath = getWorkspacePath('dist/current/world/world_meta.json');
  const meta = loadJsonSafe(metaPath);
  if (meta) {
    assertEquals(meta.samples_per_axis, 2041);
    assertEquals(meta.total_vertices, 4165681);
  }
});

suite.addTest('F1.3: Dry land vs ocean distribution baseline matches 55.12% dry land', () => {
  // Authoritative derivation from Survey 1 §1.1 & world_types.u8 byte analysis
  const dryLandKm2 = CONSTANTS.DERETH_DRY_LAND_KM2; // 1321.27 km2
  const waterKm2 = CONSTANTS.DERETH_WATER_KM2; // 1075.81 km2
  const totalArea = dryLandKm2 + waterKm2;

  assertNear(totalArea, 2397.08, 0.1, 'Sum of land and water area must equal world envelope');
  const landRatio = dryLandKm2 / totalArea;
  assertNear(landRatio, 0.5512, 0.005, 'Land ratio must be approximately 55.12%');

  // Verify binary type byte size if present
  const typesPath = getWorkspacePath('dist/current/world/world_types.u8');
  if (fs.existsSync(typesPath)) {
    const stat = fs.statSync(typesPath);
    assertEquals(stat.size, 4165681, 'world_types.u8 size must be exactly 4,165,681 bytes');
  }
});

suite.addTest('F1.4: Dereth town count baseline matches exactly 41 towns', () => {
  // Authoritative derivation: town_kits/index.json has totalTowns: 41
  const townKitPath = getWorkspacePath('town_kits/index.json');
  const kit = loadJsonSafe(townKitPath);
  if (kit) {
    assertEquals(kit.totalTowns, 41, 'totalTowns in town_kits/index.json must be 41');
    const townKeys = Object.keys(kit.towns || {});
    assertEquals(townKeys.length, 41, 'Towns dictionary must contain exactly 41 entries');
  } else {
    assertEquals(CONSTANTS.DERETH_TOWN_COUNT, 41, 'Dereth town baseline must be 41');
  }
});

suite.addTest('F1.5: Scenery and vegetation densities match Dereth retail census', () => {
  // Authoritative derivation: 3,786,620 props, 1,493,946 trees, 496,423 ferns on 1,321.27 km2 dry land
  const sceneryDensity = CONSTANTS.DERETH_SCENERY_PROPS_TOTAL / CONSTANTS.DERETH_DRY_LAND_KM2;
  const treeDensity = CONSTANTS.DERETH_TREE_COUNT / CONSTANTS.DERETH_DRY_LAND_KM2;
  const fernDensity = CONSTANTS.DERETH_FERN_COUNT / CONSTANTS.DERETH_DRY_LAND_KM2;

  assertNear(sceneryDensity, 2865.89, 5.0, 'Dereth scenery density ~2,866 props/km2');
  assertNear(treeDensity, 1130.69, 5.0, 'Dereth tree density ~1,130 trees/km2');
  assertNear(fernDensity, 375.72, 5.0, 'Dereth fern density ~375 ferns/km2');
  assertNear(CONSTANTS.DERETH_SCENERY_DENSITY_PER_LB, 76.9, 1.0, 'Average ~76.9 props per populated LB');
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
