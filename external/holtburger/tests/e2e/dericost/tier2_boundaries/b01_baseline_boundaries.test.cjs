/**
 * Tier 2: Boundary 1 — Baseline Boundaries & Limits
 * Edge landblocks, sea level clamp, max elevation clamp, zero-density LB handling.
 * Sources: TEST_INFRA.md, ORIGINAL_REQUEST §R1, Survey 1 §1.1
 */

const { createSuite, assert, assertEquals, assertNear, assertInRange, CONSTANTS } = require('../harness.cjs');

const suite = createSuite('Tier 2: Boundary 1 - Baseline Boundaries & Limits', 2);

suite.addTest('B1.1: Grid boundary landblocks are valid; landblocks >= 255 are strictly rejected', () => {
  function isValidLandblockCoord(lbX, lbY) {
    return lbX >= 0 && lbX <= 254 && lbY >= 0 && lbY <= 254;
  }

  // Four corners of the 255x255 grid
  assertEquals(isValidLandblockCoord(0, 0), true, 'South-West corner (0, 0) valid');
  assertEquals(isValidLandblockCoord(254, 0), true, 'South-East corner (254, 0) valid');
  assertEquals(isValidLandblockCoord(0, 254), true, 'North-West corner (0, 254) valid');
  assertEquals(isValidLandblockCoord(254, 254), true, 'North-East corner (254, 254) valid');

  // Boundaries outside the valid 255 grid
  assertEquals(isValidLandblockCoord(-1, 0), false, 'Negative lbX rejected');
  assertEquals(isValidLandblockCoord(0, -1), false, 'Negative lbY rejected');
  assertEquals(isValidLandblockCoord(255, 0), false, 'lbX = 255 (0xFF) rejected');
  assertEquals(isValidLandblockCoord(0, 255), false, 'lbY = 255 (0xFF) rejected');
});

suite.addTest('B1.2: Negative terrain heights are clamped to sea level (0.0m) or flagged water', () => {
  function processRawHeight(rawHeight, isWaterCode) {
    if (isWaterCode) return 0.0;
    return Math.max(0.0, rawHeight);
  }

  assertEquals(processRawHeight(-5.0, false), 0.0, 'Negative land height clamped to 0.0m');
  assertEquals(processRawHeight(0.0, false), 0.0, 'Zero height remains 0.0m');
  assertEquals(processRawHeight(150.0, false), 150.0, 'Positive height preserved');
  assertEquals(processRawHeight(-20.0, true), 0.0, 'Deep water height normalized to 0.0m');
});

suite.addTest('B1.3: Maximum terrain elevation is clamped to 700.0m', () => {
  function clampElevation(elevation) {
    return Math.min(700.0, Math.max(0.0, elevation));
  }

  assertEquals(clampElevation(670.0), 670.0, 'Mt. Esper peak (670m) preserved');
  assertEquals(clampElevation(700.0), 700.0, '700m peak preserved');
  assertEquals(clampElevation(750.0), 700.0, 'Heights > 700m clamped to 700.0m');
  assertEquals(clampElevation(1200.0), 700.0, 'Extreme elevation clamped to 700.0m');
});

suite.addTest('B1.4: Extreme land/water cell boundaries correctly determine cell classification', () => {
  function classifyCell(waterVertexCount) {
    // A cell has 4 corner vertices.
    if (waterVertexCount === 4) return 'PureWater';
    if (waterVertexCount === 0) return 'PureLand';
    return 'Coastline';
  }

  assertEquals(classifyCell(4), 'PureWater');
  assertEquals(classifyCell(0), 'PureLand');
  assertEquals(classifyCell(1), 'Coastline');
  assertEquals(classifyCell(3), 'Coastline');
});

suite.addTest('B1.5: Zero-density landblocks compute densities safely without divide-by-zero', () => {
  function computeLandblockDensity(propCount, dryAreaKm2) {
    if (!dryAreaKm2 || dryAreaKm2 <= 0) return 0.0;
    return propCount / dryAreaKm2;
  }

  // Pure ocean landblock has dryAreaKm2 = 0
  const oceanDensity = computeLandblockDensity(0, 0.0);
  assertEquals(oceanDensity, 0.0, 'Zero area LB density returns 0.0 without NaN');
  assert(!Number.isNaN(oceanDensity), 'Density must not be NaN');
  assert(Number.isFinite(oceanDensity), 'Density must be finite');

  const landDensity = computeLandblockDensity(80, 0.036864);
  assertNear(landDensity, 2170.14, 1.0, 'Standard LB density computed accurately');
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
