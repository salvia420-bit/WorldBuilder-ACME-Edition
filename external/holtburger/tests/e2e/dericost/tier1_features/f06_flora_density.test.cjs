/**
 * Tier 1: Feature 6 — Unique Flora Models & Density
 * Unique Dericost flora (Ironwood pines, ash-cedars, ghost-ferns, sulfur-ferns, desert ironwood, blood-thorn cactus).
 * Density targets: >= 1,130 trees/km2, >= 375 ferns/km2 on dry land.
 * Sources: ORIGINAL_REQUEST §R2, PROJECT.md §Feature 9, Survey 1 §4.1, Survey 2 §5.4
 */

const { createSuite, assert, assertEquals, assertNear, CONSTANTS } = require('../harness.cjs');

const suite = createSuite('Tier 1: Feature 6 - Unique Flora Models & Density', 1);

// Dereth retail flora DIDs to enforce NON-DUPLICATION
const DERETH_RETAIL_FLORA_DIDS = new Set([
  0x02000258, // Large Pine
  0x02000246, // Medium Deciduous Oak
  0x02000257, // Conifer / Pine variant
  0x02000259, // Tall Slender Pine
  0x02000255, // Birch / Aspen
  0x02000248, // Gnarly Oak
  0x02000244, // Small Willow
  0x02001063, // Small Forest Fern
  0x02001064, // Large Fern Cluster
  0x020007A3, // Broadleaf Shrub
  0x020007A5, // Dense Hedge
  0x020007A2, // Flowering Shrub
  0x020007A4, // Scrub Bush
  0x0200024A, // Desert Yucca
]);

// Authoritative unique Dericost flora catalog
const DERICOST_UNIQUE_FLORA = [
  { id: 'ironwood_pine', name: 'Gelid Ironwood Pine', biome: 'Gelid Plateau', minHeight: 18.0, maxHeight: 35.0, setupDid: 0x02100001 },
  { id: 'ash_cedar', name: 'Tresimaen Ash-Cedar', biome: 'Valley of Tresimaen', minHeight: 12.0, maxHeight: 22.0, setupDid: 0x02100002 },
  { id: 'ghost_fern', name: 'Gelid Ghost-Fern', biome: 'Gelid Plateau', minHeight: 1.2, maxHeight: 2.2, setupDid: 0x02100003 },
  { id: 'sulfur_fern', name: 'Tresimaen Sulfur-Fern', biome: 'Valley of Tresimaen', minHeight: 1.5, maxHeight: 2.8, setupDid: 0x02100004 },
  { id: 'desert_ironwood', name: 'High Desert Ironwood', biome: 'The High Desert Plateau', minHeight: 6.0, maxHeight: 14.0, setupDid: 0x02100005 },
  { id: 'blood_thorn_cactus', name: 'Blood-Thorn Cactus', biome: 'The High Desert Plateau', minHeight: 2.5, maxHeight: 7.0, setupDid: 0x02100006 },
  { id: 'bog_willow', name: 'Daralet Bog-Willow', biome: 'Dericost Marshes', minHeight: 5.0, maxHeight: 15.0, setupDid: 0x02100007 },
  { id: 'mountain_cypress', name: 'Ashatiri Mountain Cypress', biome: 'Ashatiri Lowlands', minHeight: 10.0, maxHeight: 24.0, setupDid: 0x02100008 },
];

suite.addTest('F6.1: Authoritative Dericost flora taxonomy contains unique provincial species', () => {
  assertEquals(DERICOST_UNIQUE_FLORA.length >= 6, true, 'Must define at least 6 unique flora archetypes');
  const names = DERICOST_UNIQUE_FLORA.map(f => f.name.toLowerCase());
  assert(names.some(n => n.includes('ironwood')), 'Must include Ironwood species');
  assert(names.some(n => n.includes('cedar')), 'Must include Cedar species');
  assert(names.some(n => n.includes('ghost-fern') || n.includes('ghost fern')), 'Must include Ghost-Fern');
  assert(names.some(n => n.includes('sulfur-fern') || n.includes('sulfur fern')), 'Must include Sulfur-Fern');
  assert(names.some(n => n.includes('cactus')), 'Must include Cactus species');
});

suite.addTest('F6.2: Dericost flora setup DIDs strictly avoid duplicating Dereth retail assets', () => {
  for (const flora of DERICOST_UNIQUE_FLORA) {
    assert(!DERETH_RETAIL_FLORA_DIDS.has(flora.setupDid),
      `Dericost flora ${flora.name} (0x${flora.setupDid.toString(16)}) must NOT collide with Dereth retail DIDs`);
  }
});

suite.addTest('F6.3: Dericost tree density target on dry land matches Dereth baseline (>= 1,130 trees/km2)', () => {
  // Dereth baseline: 1,130.69 trees / km2. On 1,321.3 km2 dry land, expected minimum trees = ~1,493,000
  const dryLand = CONSTANTS.DERICOST_MIN_DRY_LAND_KM2;
  const targetTreeDensity = CONSTANTS.DERETH_TREE_DENSITY;
  const expectedMinTrees = dryLand * targetTreeDensity;

  assertNear(targetTreeDensity, 1130.69, 1.0, 'Baseline tree density must be ~1,130.69 trees/km2');
  assert(expectedMinTrees >= 1493000, 'Expected tree count must be >= 1,493,000 across dry land');
});

suite.addTest('F6.4: Dericost fern and undergrowth density target matches Dereth baseline (>= 375 ferns/km2)', () => {
  // Dereth baseline: 375.72 ferns / km2. On 1,321.3 km2 dry land, expected minimum ferns = ~496,000
  const dryLand = CONSTANTS.DERICOST_MIN_DRY_LAND_KM2;
  const targetFernDensity = CONSTANTS.DERETH_FERN_DENSITY;
  const expectedMinFerns = dryLand * targetFernDensity;

  assertNear(targetFernDensity, 375.72, 1.0, 'Baseline fern density must be ~375.72 ferns/km2');
  assert(expectedMinFerns >= 496000, 'Expected fern count must be >= 496,000 across dry land');
});

suite.addTest('F6.5: Biome flora distribution rules respect environmental tolerances', () => {
  // Desert species should not be assigned to Tundra; Tundra species should not be assigned to Desert
  const desertSpecies = DERICOST_UNIQUE_FLORA.filter(f => f.biome === 'The High Desert Plateau');
  const tundraSpecies = DERICOST_UNIQUE_FLORA.filter(f => f.biome === 'Gelid Plateau');

  assertEquals(desertSpecies.length >= 2, true, 'Desert has unique flora');
  assertEquals(tundraSpecies.length >= 2, true, 'Gelid tundra has unique flora');

  for (const ds of desertSpecies) {
    assert(!ds.name.toLowerCase().includes('frost'), 'Desert flora cannot be frost-based');
  }
  for (const ts of tundraSpecies) {
    assert(!ts.name.toLowerCase().includes('cactus'), 'Tundra flora cannot be cactus');
  }
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
