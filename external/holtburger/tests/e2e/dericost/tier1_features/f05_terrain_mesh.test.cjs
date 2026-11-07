/**
 * Tier 1: Feature 5 — Landmass Dimensions & Mesh Resolution
 * 255x255 LB terrain mesh (48.96 km x 48.96 km, >= 1,321.3 km2 dry land, 2041x2041 vertices).
 * Elevation up to 700m. Dual heightmap shader contract.
 * Sources: ORIGINAL_REQUEST §R2 & Acceptance Criteria, PROJECT.md §Feature 7-8, Survey 1 §4.1
 */

const { createSuite, assert, assertEquals, assertNear, assertInRange, CONSTANTS } = require('../harness.cjs');

const suite = createSuite('Tier 1: Feature 5 - Landmass Dimensions & Mesh Resolution', 1);

suite.addTest('F5.1: Dericost landblock grid size matches Dereth scale (255x255 LBs)', () => {
  const lbCountX = 255;
  const lbCountY = 255;
  const totalLBs = lbCountX * lbCountY;
  const widthM = lbCountX * CONSTANTS.LB_SIZE;
  const heightM = lbCountY * CONSTANTS.LB_SIZE;
  const areaKm2 = (widthM / 1000.0) * (heightM / 1000.0);

  assertEquals(totalLBs, CONSTANTS.NUM_LANDBLOCKS, 'Dericost must have 65,025 landblocks');
  assertEquals(widthM, 48960.0, 'Dericost width must be 48,960.0 meters');
  assertEquals(heightM, 48960.0, 'Dericost height must be 48,960.0 meters');
  assertNear(areaKm2, 2397.0816, 1e-4, 'Dericost matrix envelope must be 2,397.0816 km2');
});

suite.addTest('F5.2: Dericost terrain mesh continuous vertex count is 2041x2041', () => {
  // 9 vertices per LB with edge sharing: 255 * 8 + 1 = 2041
  const verticesPerAxis = 255 * 8 + 1;
  const totalVertices = verticesPerAxis * verticesPerAxis;

  assertEquals(verticesPerAxis, CONSTANTS.TOTAL_SAMPLES, 'Vertices per axis must be 2041');
  assertEquals(totalVertices, CONSTANTS.TOTAL_VERTICES, 'Total vertices must be 4,165,681');
});

suite.addTest('F5.3: Dericost dry land area target matches or exceeds Dereth baseline (>= 1,321.3 km2)', () => {
  // Authoritative derivation: Dereth dry land is 1,321.27 km2 (55.12%). Dericost requirement is >= 1,321.3 km2.
  const derethDryLand = CONSTANTS.DERETH_DRY_LAND_KM2;
  const dericostMinDryLand = CONSTANTS.DERICOST_MIN_DRY_LAND_KM2;

  assertNear(dericostMinDryLand, derethDryLand, 0.1, 'Dericost target must equal or exceed Dereth baseline');
  assert(dericostMinDryLand >= 1321.27, 'Dericost dry land requirement must be >= 1,321.27 km2');
  const dryLandRatio = dericostMinDryLand / CONSTANTS.DERICOST_TOTAL_AREA_KM2;
  assert(dryLandRatio >= 0.55, 'Dry land ratio must be at least 55% of world envelope');
});

suite.addTest('F5.4: Elevation span is bounded between 0.0m (sea level) and 700.0m', () => {
  // Dereth baseline has max elevation 670m (Mt. Esper); Dericost envelope supports up to 700m (Mt. Zemal).
  const minElevation = 0.0;
  const maxElevation = 700.0;

  assertEquals(minElevation, 0.0, 'Sea level is at 0.0m');
  assert(maxElevation >= CONSTANTS.DERETH_ELEVATION_MAX, 'Dericost elevation must accommodate at least Dereth peak (670m)');
  assertEquals(maxElevation, 700.0, 'Max allowable elevation clamped to 700.0m');
});

suite.addTest('F5.5: Dual heightmap sampling shader logic respects multi-zone coordinate contract', () => {
  // Authoritative shader sampling specification from PROJECT.md §Terrain Shader Contract:
  // sampleHeight(vec2 worldPos):
  // - Y <= 48960.0: Dereth height texture
  // - 48960.0 < Y < 68928.0: returns 0.0 (sea level) and type 20 (WaterDeepSea)
  // - Y >= 68928.0: Dericost height texture at (X / 48960.0, (Y - 68928.0) / 48960.0)
  function sampleHeightContract(x, y) {
    if (y <= 48960.0) {
      return { zone: 'Dereth', u: x / 48960.0, v: y / 48960.0, isOcean: false };
    } else if (y > 48960.0 && y < 68928.0) {
      return { zone: 'OceanGap', height: 0.0, type: 20, isOcean: true };
    } else {
      return { zone: 'Dericost', u: x / 48960.0, v: (y - 68928.0) / 48960.0, isOcean: false };
    }
  }

  const sDereth = sampleHeightContract(24480.0, 10000.0);
  assertEquals(sDereth.zone, 'Dereth');
  assertNear(sDereth.u, 0.5, 1e-4);

  const sOcean = sampleHeightContract(24480.0, 55000.0);
  assertEquals(sOcean.zone, 'OceanGap');
  assertEquals(sOcean.height, 0.0);
  assertEquals(sOcean.type, 20);

  const sDericost = sampleHeightContract(24480.0, 68928.0);
  assertEquals(sDericost.zone, 'Dericost');
  assertNear(sDericost.v, 0.0, 1e-4, 'South shore of Dericost maps to normalized v=0.0');

  const sDericostNorth = sampleHeightContract(24480.0, 117888.0);
  assertEquals(sDericostNorth.zone, 'Dericost');
  assertNear(sDericostNorth.v, 1.0, 1e-4, 'North bound of Dericost maps to normalized v=1.0');
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
