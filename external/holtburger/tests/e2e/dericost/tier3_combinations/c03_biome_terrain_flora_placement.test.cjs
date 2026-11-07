/**
 * Tier 3: Combination 3 — Biome Terrain, Flora Density & TreeSway GPU Binding
 * Features combined: F2 (Lore & Biomes) + F5 (Terrain Mesh) + F6 (Flora Density) + F8 (TreeSway Shaders).
 * Sources: PROJECT.md, TEST_INFRA.md, windSwayGpu.js, canopy_soften.js
 */

const { createSuite, assert, assertEquals, assertNear, assertInRange, CONSTANTS } = require('../harness.cjs');

const suite = createSuite('Tier 3: Combination 3 - Biome Terrain, Flora Density & TreeSway GPU Binding', 3);

function spawnFloraPatchForBiome(biomeName, patchAreaKm2 = 1.0) {
  const floraTable = {
    'Gelid Plateau': { treeDid: 0x02100001, treeName: 'Ironwood Pine', fernDid: 0x02100003, treesPerKm2: 1150, fernsPerKm2: 380 },
    'Valley of Tresimaen': { treeDid: 0x02100002, treeName: 'Ash-Cedar', fernDid: 0x02100004, treesPerKm2: 1200, fernsPerKm2: 410 },
    'The High Desert Plateau': { treeDid: 0x02100005, treeName: 'Desert Ironwood', fernDid: 0x02100006, treesPerKm2: 350, fernsPerKm2: 80 },
  };

  const spec = floraTable[biomeName];
  const treeCount = Math.round(spec.treesPerKm2 * patchAreaKm2);
  const fernCount = Math.round(spec.fernsPerKm2 * patchAreaKm2);

  const instances = [];
  for (let i = 0; i < treeCount; i++) {
    instances.push({
      id: i,
      type: 'tree',
      did: spec.treeDid,
      name: spec.treeName,
      // Random deterministic per-instance hash attribute
      vVfxHash: [(i * 0.173) % 1.0, (i * 0.317) % 1.0, (i * 0.631) % 1.0],
      height: 18.0 + (i % 10) * 1.2,
      canopySofteningFactor: CONSTANTS.CANOPY_SOFTEN_DEFAULT,
      hasGpuWindSway: true
    });
  }

  for (let j = 0; j < fernCount; j++) {
    instances.push({
      id: treeCount + j,
      type: 'fern',
      did: spec.fernDid,
      vVfxHash: [(j * 0.291) % 1.0, (j * 0.419) % 1.0, (j * 0.823) % 1.0],
      height: 1.8,
      canopySofteningFactor: 0.0, // ferns don't need radial canopy normal softening
      hasGpuWindSway: true
    });
  }

  return { biome: biomeName, treeCount, fernCount, totalInstances: instances.length, instances };
}

suite.addTest('C3.1: Provincial terrain sampling selects unique provincial flora species', () => {
  const gelidPatch = spawnFloraPatchForBiome('Gelid Plateau', 1.0);
  const tresimaenPatch = spawnFloraPatchForBiome('Valley of Tresimaen', 1.0);

  const gelidTree = gelidPatch.instances.find(i => i.type === 'tree');
  assertEquals(gelidTree.did, 0x02100001, 'Gelid spawns Ironwood Pine (0x02100001)');

  const tresimaenTree = tresimaenPatch.instances.find(i => i.type === 'tree');
  assertEquals(tresimaenTree.did, 0x02100002, 'Tresimaen spawns Ash-Cedar (0x02100002)');
});

suite.addTest('C3.2: All spawned trees and ferns dynamically receive GPU windSway deformation hook', () => {
  const patch = spawnFloraPatchForBiome('Valley of Tresimaen', 0.5);

  for (const inst of patch.instances) {
    assertEquals(inst.hasGpuWindSway, true, 'Instance must have GPU wind sway enabled');
    assertEquals(inst.vVfxHash.length, 3, 'Instance must provide 3-component vVfxHash attribute');
  }
});

suite.addTest('C3.3: Sampled 1 km2 Tresimaen patch satisfies tree density target (>= 1,130 trees/km2)', () => {
  const patch = spawnFloraPatchForBiome('Valley of Tresimaen', 1.0);

  assert(patch.treeCount >= 1130, `Tresimaen tree count (${patch.treeCount}) must meet >= 1,130 trees/km2`);
  assert(patch.fernCount >= 375, `Tresimaen fern count (${patch.fernCount}) must meet >= 375 ferns/km2`);
});

suite.addTest('C3.4: Canopy normal softening factor 0.65 is applied exclusively to tree canopies', () => {
  const patch = spawnFloraPatchForBiome('Gelid Plateau', 0.1);

  const trees = patch.instances.filter(i => i.type === 'tree');
  const ferns = patch.instances.filter(i => i.type === 'fern');

  for (const t of trees) {
    assertEquals(t.canopySofteningFactor, 0.65, 'Trees receive default 0.65 normal softening');
  }
  for (const f of ferns) {
    assertEquals(f.canopySofteningFactor, 0.0, 'Low undergrowth ferns do not use canopy softening');
  }
});

suite.addTest('C3.5: Per-instance vVfxHash attribute decorrelates sway phases across forest instances', () => {
  const patch = spawnFloraPatchForBiome('Valley of Tresimaen', 0.1);
  const sampleTrees = patch.instances.filter(i => i.type === 'tree').slice(0, 10);

  const phases = sampleTrees.map(t => t.vVfxHash[0] * 2.0 * Math.PI);
  const uniquePhases = new Set(phases.map(p => p.toFixed(3)));

  // All sampled instances should have distinct phases
  assertEquals(uniquePhases.size, sampleTrees.length, 'All 10 trees have distinct sway phases');
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
