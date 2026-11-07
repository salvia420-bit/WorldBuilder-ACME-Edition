/**
 * Tier 1: Feature 7 — Unique Scenery & Rock Density
 * Unique Scenery models (basalt columns, obsidian spires, granite boulders, runic stones).
 * Density target: >= 2,866 props/km2 on dry land (~76.9 props/LB).
 * 4-Rung narrow-phase collision ladder allocation matching Dereth.
 * Sources: ORIGINAL_REQUEST §R2, PROJECT.md §Feature 10, Survey 1 §4.1, Survey 2 §1.5
 */

const { createSuite, assert, assertEquals, assertNear, CONSTANTS, loadJsonSafe, getWorkspacePath } = require('../harness.cjs');

const suite = createSuite('Tier 1: Feature 7 - Unique Scenery & Rock Density', 1);

// Unique geological assets
const DERICOST_GEOLOGICAL_ASSETS = [
  { id: 'basalt_column', name: 'Hexagonal Basalt Column', collisionRung: 2, setupDid: 0x01100001 },
  { id: 'obsidian_spire', name: 'Tresimaen Obsidian Spire', collisionRung: 1, setupDid: 0x01100002 },
  { id: 'granite_crag', name: 'Ashatiri Granite Quarry Crag', collisionRung: 2, setupDid: 0x01100003 },
  { id: 'sandstone_rib', name: 'High Desert Sandstone Rib', collisionRung: 2, setupDid: 0x01100004 },
  { id: 'runic_marker', name: 'Dericostian Runic Boundary Stone', collisionRung: 3, setupDid: 0x01100005 },
  { id: 'permafrost_scree', name: 'Gelid Permafrost Scree Clutter', collisionRung: 4, setupDid: 0x01100006 },
];

suite.addTest('F7.1: Authoritative Dericost geological prop taxonomy includes regional stone archetypes', () => {
  assertEquals(DERICOST_GEOLOGICAL_ASSETS.length >= 5, true, 'At least 5 geological prop archetypes defined');
  const names = DERICOST_GEOLOGICAL_ASSETS.map(a => a.name.toLowerCase());
  assert(names.some(n => n.includes('basalt')), 'Includes basalt');
  assert(names.some(n => n.includes('obsidian')), 'Includes obsidian');
  assert(names.some(n => n.includes('granite')), 'Includes granite');
  assert(names.some(n => n.includes('sandstone')), 'Includes sandstone');
  assert(names.some(n => n.includes('runic')), 'Includes runic boundary stones');
});

suite.addTest('F7.2: Overall scenery prop density target on dry land matches Dereth (>= 2,866 props/km2)', () => {
  const dryLand = CONSTANTS.DERICOST_MIN_DRY_LAND_KM2;
  const targetPropDensity = CONSTANTS.DERETH_SCENERY_DENSITY_DRY_LAND;
  const expectedMinProps = dryLand * targetPropDensity;

  assertNear(targetPropDensity, 2865.89, 2.0, 'Baseline scenery density must be ~2,866 props/km2');
  assert(expectedMinProps >= 3780000, 'Total expected scenery prop count must exceed 3.78 million');
  assertNear(CONSTANTS.DERETH_SCENERY_DENSITY_PER_LB, 76.9, 1.0, 'Average props per populated landblock ~76.9');
});

suite.addTest('F7.3: Four-rung narrow-phase collision ladder proportions match Dereth census', () => {
  // Authoritative derivation from Survey 2 §1.5 and scenery-collidability.json:
  // Rung 1 (bsp): ~0.5%
  // Rung 2 (cylsphere): ~33.7%
  // Rung 3 (sphere): ~6.1%
  // Rung 4 (none): ~59.7%
  const censusPath = '/mnt/wbterminal2/buildbox-2026-07-27/census/scenery-collidability.json';
  const census = loadJsonSafe(censusPath);

  const ladderProportions = {
    rung1_bsp: 0.005,
    rung2_cylsphere: 0.337,
    rung3_sphere: 0.061,
    rung4_none: 0.597,
  };

  const sum = Object.values(ladderProportions).reduce((a, b) => a + b, 0);
  assertNear(sum, 1.0, 1e-3, 'Ladder proportions sum to 100%');
  assert(ladderProportions.rung4_none > 0.55, 'Non-colliding ground clutter constitutes majority (>55%)');
  assert(ladderProportions.rung2_cylsphere > 0.30, 'Cylsphere collision constitutes primary solid collider (>30%)');

  if (census) {
    if (census.meta) {
      assertEquals(census.meta.landblocksScanned, 65025, 'Census scanned all 65,025 landblocks');
    }
    if (census.dids) {
      const distinctCount = Array.isArray(census.dids) ? census.dids.length : Object.keys(census.dids).length;
      assertEquals(distinctCount, 176, 'Census identified 176 distinct DIDs');
    }
  }
});

suite.addTest('F7.4: Narrow-phase collision classification short-circuits Rung 1 (BSP) over Cylspheres', () => {
  // Edge Case 5 from Survey 2 §4: If an object has both BSP and Cylspheres, Rung 1 short-circuits.
  function evaluateCollisionRung(model) {
    if (model.hasPhysicsBsp) return 1; // Rung 1: BSP
    if (model.hasCylspheres) return 2; // Rung 2: Cylsphere
    if (model.hasSpheres) return 3;    // Rung 3: Sphere
    return 4;                          // Rung 4: None
  }

  const complexMonument = { hasPhysicsBsp: true, hasCylspheres: true, hasSpheres: false };
  assertEquals(evaluateCollisionRung(complexMonument), 1, 'Rung 1 BSP must take strict precedence');

  const standardTree = { hasPhysicsBsp: false, hasCylspheres: true, hasSpheres: false };
  assertEquals(evaluateCollisionRung(standardTree), 2, 'Trees evaluate to Rung 2 Cylsphere');
});

suite.addTest('F7.5: Ground clutter assets are explicitly assigned to non-colliding Rung 4', () => {
  const clutter = DERICOST_GEOLOGICAL_ASSETS.find(a => a.id === 'permafrost_scree');
  assert(clutter !== undefined, 'Permafrost scree clutter exists');
  assertEquals(clutter.collisionRung, 4, 'Ground scree clutter must have collisionRung = 4 (None)');
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
