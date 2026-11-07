/**
 * Tier 2: Boundary 8 — Shader Parameter Extremes
 * Zero wind amp, negative height relative to base Z, extreme canopy heights, 0.0/1.0 softening limits.
 * Sources: TEST_INFRA.md, ORIGINAL_REQUEST §R2, windSwayGpu.js, canopy_soften.js
 */

const { createSuite, assert, assertEquals, assertNear, assertInRange, CONSTANTS } = require('../harness.cjs');

const suite = createSuite('Tier 2: Boundary 8 - Shader Parameter Extremes', 2);

function computeVertexSwayDisplacement(transformedZ, uWindBaseZ, uWindAmp, uWindFreq, uWindFlutter, uWindDir2, vVfxHashX, uTime) {
  // Verbatim GPU vertex sway math
  const wsHeight = Math.max(0.0, transformedZ - uWindBaseZ);
  const wsNormH = wsHeight * 0.05;
  const wsFlex = wsNormH * wsNormH;

  const wsPhase = vVfxHashX * 2.0 * Math.PI;
  const wsT = uTime * 2.0 * Math.PI * uWindFreq;
  const wsOsc = Math.sin(wsT + wsPhase) + uWindFlutter * Math.sin(wsT * 3.7 + wsPhase * 1.7 + 1.3);

  const dispMag = wsOsc * uWindAmp * wsFlex;
  return [uWindDir2[0] * dispMag, uWindDir2[1] * dispMag];
}

suite.addTest('B8.1: Zero wind amplitude (uWindAmp = 0.0) produces zero vertex displacement everywhere', () => {
  const disp = computeVertexSwayDisplacement(30.0, 0.0, 0.0, 0.15, 0.3, [1.0, 0.0], 0.5, 10.0);
  assertEquals(disp[0], 0.0, 'Displacement X is strictly 0.0');
  assertEquals(disp[1], 0.0, 'Displacement Y is strictly 0.0');
});

suite.addTest('B8.2: Negative height below base Z clamps to zero displacement via max(0.0, z - baseZ)', () => {
  // Tree roots or terrain vertices below ground baseZ
  const disp = computeVertexSwayDisplacement(-5.0, 0.0, 0.05, 0.15, 0.3, [1.0, 0.0], 0.5, 10.0);
  assertEquals(disp[0], 0.0, 'Root displacement X below baseZ is 0.0');
  assertEquals(disp[1], 0.0, 'Root displacement Y below baseZ is 0.0');
});

suite.addTest('B8.3: Extreme high tree height (50.0m) maintains bounded displacement', () => {
  // At 50m: wsNormH = 2.5, wsFlex = 6.25.
  // With windAmp = 0.03, max displacement is 6.25 * 0.03 * 1.3 = ~0.24m.
  const disp = computeVertexSwayDisplacement(50.0, 0.0, CONSTANTS.TREESWAY_BASE_AMP, CONSTANTS.TREESWAY_FREQ_HZ, CONSTANTS.TREESWAY_FLUTTER, [1.0, 0.0], 0.0, 1.0);
  const mag = Math.hypot(disp[0], disp[1]);

  assert(mag > 0.0, 'Displacement is active');
  assert(mag < 0.5, `50m tree sway ${mag.toFixed(3)}m remains realistic and bounded (< 0.5m)`);
});

suite.addTest('B8.4: Zero canopy soften factor (factor = 0.0) preserves exact planar geometric normals', () => {
  function softenNormals(nGeom, radialCrown, factor) {
    const blended = [
      (1.0 - factor) * nGeom[0] + factor * radialCrown[0],
      (1.0 - factor) * nGeom[1] + factor * radialCrown[1],
      (1.0 - factor) * nGeom[2] + factor * radialCrown[2],
    ];
    const len = Math.hypot(...blended);
    return blended.map(c => c / len);
  }

  const nGeom = [1.0, 0.0, 0.0];
  const radial = [0.0, 0.0, 1.0];

  const result0 = softenNormals(nGeom, radial, 0.0);
  assertEquals(result0[0], 1.0, 'Factor 0.0 preserves original X normal');
  assertEquals(result0[1], 0.0, 'Factor 0.0 preserves original Y normal');
  assertEquals(result0[2], 0.0, 'Factor 0.0 preserves original Z normal');
});

suite.addTest('B8.5: Full canopy soften factor (factor = 1.0) produces purely spherical crown normal field', () => {
  function softenNormals(nGeom, radialCrown, factor) {
    const blended = [
      (1.0 - factor) * nGeom[0] + factor * radialCrown[0],
      (1.0 - factor) * nGeom[1] + factor * radialCrown[1],
      (1.0 - factor) * nGeom[2] + factor * radialCrown[2],
    ];
    const len = Math.hypot(...blended);
    return blended.map(c => c / len);
  }

  const nGeom = [1.0, 0.0, 0.0];
  const radial = [0.0, 0.0, 1.0];

  const result1 = softenNormals(nGeom, radial, 1.0);
  assertEquals(result1[0], 0.0, 'Factor 1.0 completely overrides planar X normal');
  assertEquals(result1[1], 0.0);
  assertEquals(result1[2], 1.0, 'Factor 1.0 adopts 100% spherical crown normal');
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
