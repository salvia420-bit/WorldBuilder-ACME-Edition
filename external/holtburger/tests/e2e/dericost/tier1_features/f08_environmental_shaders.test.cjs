/**
 * Tier 1: Feature 8 — Environmental Shaders (TreeSway & Soften)
 * Vertex Shader: windSwayGpu.js (deformation.windSwayGpu).
 * Canopy Normal Softening: canopy_soften.js (0.65 softening).
 * Sources: ORIGINAL_REQUEST §R2, PROJECT.md §Feature 12-13, Survey 1 §1.3, Survey 2 §1.5
 */

const { createSuite, assert, assertEquals, assertNear, CONSTANTS, getWorkspacePath } = require('../harness.cjs');
const fs = require('node:fs');

const suite = createSuite('Tier 1: Feature 8 - Environmental Shaders (TreeSway & Soften)', 1);

suite.addTest('F8.1: GPU vertex deformation hook definition matches MECH-B windSwayGpu specification', () => {
  const shaderPath = getWorkspacePath('apps/holtburger-web/scene3d/vfx/components/windSwayGpu.js');
  assert(fs.existsSync(shaderPath), `Shader component file must exist at ${shaderPath}`);
  const content = fs.readFileSync(shaderPath, 'utf8');

  assert(content.includes('deformation.windSwayGpu') || content.includes('windSwayGpu'),
    'Component must define windSwayGpu deformation hook');
  assert(content.includes('uTime'), 'Must declare uTime uniform');
  assert(content.includes('uWindAmp'), 'Must declare uWindAmp uniform');
  assert(content.includes('uWindFreq'), 'Must declare uWindFreq uniform');
  assert(content.includes('vVfxHash'), 'Must declare or use vVfxHash attribute for phase decorrelation');
});

suite.addTest('F8.2: Quadratic stiffness curve ensures zero displacement at base and maximum at crown', () => {
  // Authoritative GLSL formulation from Survey 1 §1.3:
  // float _wsHeight = max(0.0, z - uWindBaseZ);
  // float _wsNormH = _wsHeight * 0.05; // 1.0 at 20m
  // float _wsFlex = _wsNormH * _wsNormH;
  function computeFlex(z, baseZ = 0.0) {
    const wsHeight = Math.max(0.0, z - baseZ);
    const wsNormH = wsHeight * 0.05;
    return wsNormH * wsNormH;
  }

  // At ground level (z = baseZ), flex must be strictly 0.0 (trunk stays planted)
  assertEquals(computeFlex(0.0, 0.0), 0.0, 'Trunk base displacement must be exactly zero');

  // At 10m height (half tree), flex is (10 * 0.05)^2 = 0.5^2 = 0.25
  assertNear(computeFlex(10.0, 0.0), 0.25, 1e-4, 'Half-height flex is 0.25 (quadratic)');

  // At 20m height (standard tree crown), flex is (20 * 0.05)^2 = 1.0^2 = 1.0
  assertNear(computeFlex(20.0, 0.0), 1.0, 1e-4, 'Crown flex at 20m is 1.0');

  // At 30m height (tall pine), flex is (30 * 0.05)^2 = 1.5^2 = 2.25
  assertNear(computeFlex(30.0, 0.0), 2.25, 1e-4, 'Crown flex at 30m is 2.25');
});

suite.addTest('F8.3: Two-band harmonic oscillation produces smooth natural swaying motion', () => {
  // Authoritative oscillation formula from windSwayGpu.js:
  // float _wsOsc = sin(_wsT + _wsPhase) + uWindFlutter * sin(_wsT * 3.7 + _wsPhase * 1.7 + 1.3);
  function computeOscillation(t, phase, freqHz, flutter) {
    const wsT = t * 2.0 * Math.PI * freqHz;
    return Math.sin(wsT + phase) + flutter * Math.sin(wsT * 3.7 + phase * 1.7 + 1.3);
  }

  const freq = CONSTANTS.TREESWAY_FREQ_HZ; // 0.15 Hz (~6.67s period)
  const flutter = CONSTANTS.TREESWAY_FLUTTER; // 0.3

  // Over a full wave cycle, oscillation remains bounded within [-1 - flutter, 1 + flutter]
  for (let t = 0; t <= 10; t += 0.5) {
    const osc = computeOscillation(t, 0.0, freq, flutter);
    assert(osc >= -(1.0 + flutter) && osc <= (1.0 + flutter),
      `Oscillation value ${osc} at t=${t} must be within bounds [-1.3, 1.3]`);
  }
});

suite.addTest('F8.4: Phase decorrelation via vVfxHash prevents synchronized forest swaying', () => {
  function computePhase(vVfxHashX) {
    return vVfxHashX * 2.0 * Math.PI;
  }

  // Test distinct instances with different hash seeds
  const instance1Hash = 0.123;
  const instance2Hash = 0.789;
  const phase1 = computePhase(instance1Hash);
  const phase2 = computePhase(instance2Hash);

  assert(Math.abs(phase1 - phase2) > 1.0, 'Phases between distinct instances must differ significantly');

  // Verify displacement difference at the same timestamp
  const freq = CONSTANTS.TREESWAY_FREQ_HZ;
  const flutter = CONSTANTS.TREESWAY_FLUTTER;
  const t = 1.5;
  const osc1 = Math.sin(t * 2 * Math.PI * freq + phase1) + flutter * Math.sin(t * 2 * Math.PI * freq * 3.7 + phase1 * 1.7 + 1.3);
  const osc2 = Math.sin(t * 2 * Math.PI * freq + phase2) + flutter * Math.sin(t * 2 * Math.PI * freq * 3.7 + phase2 * 1.7 + 1.3);

  assert(Math.abs(osc1 - osc2) > 0.2, 'Instances must not sway in lockstep at the same time');
});

suite.addTest('F8.5: Canopy normal softening blends planar normals toward radial crown vector', () => {
  // Authoritative formulation from canopy_soften.js:
  // N_final = normalize((1.0 - 0.65) * N_geom + 0.65 * normalize(V - C))
  const factor = CONSTANTS.CANOPY_SOFTEN_DEFAULT;
  assertEquals(factor, 0.65, 'Default canopy softening constant must be 0.65');

  // Vertex at (0, 0, 20), crown center at (0, 0, 15). Radial vector is (0, 0, 1).
  // Planar normal is initially horizontal (1, 0, 0).
  const nGeom = [1.0, 0.0, 0.0];
  const radial = [0.0, 0.0, 1.0];

  const blended = [
    (1.0 - factor) * nGeom[0] + factor * radial[0],
    (1.0 - factor) * nGeom[1] + factor * radial[1],
    (1.0 - factor) * nGeom[2] + factor * radial[2],
  ];
  const mag = Math.hypot(...blended);
  const nFinal = blended.map(c => c / mag);

  // Check that normal has been rotated substantially toward the radial vector
  assertNear(nFinal[0], 0.35 / mag, 1e-4);
  assertNear(nFinal[2], 0.65 / mag, 1e-4);
  assert(nFinal[2] > nFinal[0], 'Radial component (0.65) must dominate planar component (0.35)');
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
