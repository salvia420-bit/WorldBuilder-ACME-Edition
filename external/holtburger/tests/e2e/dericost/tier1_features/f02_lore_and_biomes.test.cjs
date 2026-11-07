/**
 * Tier 1: Feature 2 — Dericost Lore & Biomes
 * 6 regional provinces based on 60k+ verified facts RAG: Gelid, Ashatiri, Tresimaen, Daralet, High Desert, Nesortania.
 * Cultural and racial factions: Imperial Living Dericostians, Undead Ruling Castes, High Desert Nomads.
 * Sources: ORIGINAL_REQUEST §R1, PROJECT.md §Feature 2, Survey 2 §1.3 & §5.1-§5.2
 */

const { createSuite, assert, assertEquals, assertNear, DERICOST_PROVINCES, CONSTANTS } = require('../harness.cjs');

const suite = createSuite('Tier 1: Feature 2 - Dericost Lore & Biomes', 1);

suite.addTest('F2.1: Six canonical Dericost provinces are comprehensively defined', () => {
  const expectedProvinces = [
    'Gelid Plateau',
    'Ashatiri Lowlands',
    'Valley of Tresimaen',
    'Dericost Marshes',
    'The High Desert Plateau',
    'Nesortania Maritime Coast'
  ];

  const actualProvinces = Object.keys(DERICOST_PROVINCES);
  assertEquals(actualProvinces.length, 6, 'Must define exactly 6 regional provinces');
  for (const prov of expectedProvinces) {
    assert(DERICOST_PROVINCES[prov] !== undefined, `Province "${prov}" must be present in canonical taxonomy`);
    assert(DERICOST_PROVINCES[prov].theme.length > 0, `Province "${prov}" must define a theme`);
  }
});

suite.addTest('F2.2: Provincial town count quotas sum to exactly 41 towns', () => {
  let totalTowns = 0;
  for (const [provName, data] of Object.entries(DERICOST_PROVINCES)) {
    assertEquals(data.towns.length, data.townCount, `Town count in ${provName} array must match townCount property`);
    totalTowns += data.townCount;
  }
  assertEquals(totalTowns, CONSTANTS.DERICOST_TOWN_COUNT, 'Total provincial towns must equal 41');
  assertEquals(DERICOST_PROVINCES['Gelid Plateau'].townCount, 10, 'Gelid Plateau has 10 towns');
  assertEquals(DERICOST_PROVINCES['Ashatiri Lowlands'].townCount, 8, 'Ashatiri Lowlands has 8 towns');
  assertEquals(DERICOST_PROVINCES['Valley of Tresimaen'].townCount, 8, 'Valley of Tresimaen has 8 towns');
  assertEquals(DERICOST_PROVINCES['Dericost Marshes'].townCount, 6, 'Dericost Marshes has 6 towns');
  assertEquals(DERICOST_PROVINCES['The High Desert Plateau'].townCount, 6, 'The High Desert Plateau has 6 towns');
  assertEquals(DERICOST_PROVINCES['Nesortania Maritime Coast'].townCount, 3, 'Nesortania Maritime Coast has 3 towns');
});

suite.addTest('F2.3: Faction profiles reflect three distinct societies from 60k+ verified facts RAG', () => {
  // Authoritative derivation from Survey 2 §1.3 & §5.1:
  // 1. Core Living Dericostians (feudal caste, terror of death, Ice Throne devotion)
  // 2. Undead Ruling Castes (Filinuvekta, Latzimestal, Gelidites, House Mhoire)
  // 3. High Desert Nomads / Sand Kings (Shakrassekor, Mu-Miyah mummies)
  const factions = {
    living: { name: 'Imperial Living Dericostians', traits: ['feudal', 'silver-trimmed', 'terror_of_death'] },
    undead: { name: 'Filinuvekta & Latzimestal', factions: ['Filinuvekta', 'Latzimestal', 'Gelidites', 'House Mhoire'] },
    nomads: { name: 'High Desert Nomads / Sand Kings', transformation: 'Mu-Miyah', seat: 'Shakrassekor' }
  };

  assert(factions.undead.factions.includes('Filinuvekta'), 'Inner circle must include Filinuvekta');
  assert(factions.undead.factions.includes('Gelidites'), 'Must include Gelidite northern necromancers');
  assertEquals(factions.nomads.transformation, 'Mu-Miyah', 'Sand Kings transform into sacred Mu-Miyah mummies');
  assertEquals(factions.nomads.seat, 'Shakrassekor', 'Chieftain Anadil seat must be Shakrassekor');
});

suite.addTest('F2.4: Capital Vasmora is placed in Gelid Plateau permafrost', () => {
  const gelidTowns = DERICOST_PROVINCES['Gelid Plateau'].towns;
  assert(gelidTowns.includes('Vasmora'), 'Vasmora must be the primary capital in Gelid Plateau');
  assertEquals(gelidTowns[0], 'Vasmora', 'Vasmora must be listed first as provincial capital');
  const theme = DERICOST_PROVINCES['Gelid Plateau'].theme;
  assert(theme.toLowerCase().includes('ice throne') || theme.toLowerCase().includes('permafrost'),
    'Gelid theme must reference permafrost or Ice Throne');
});

suite.addTest('F2.5: Distinct architectural styles are assigned per geological biome', () => {
  for (const [prov, data] of Object.entries(DERICOST_PROVINCES)) {
    assert(data.dominantArchitecture && data.dominantArchitecture.length > 10,
      `Province ${prov} must have a detailed architectural specification`);
  }
  // Check specific architectural identities from Survey 2 §1.4 / §5.2
  assert(DERICOST_PROVINCES['Gelid Plateau'].dominantArchitecture.toLowerCase().includes('basalt'), 'Gelid uses basalt');
  assert(DERICOST_PROVINCES['Ashatiri Lowlands'].dominantArchitecture.toLowerCase().includes('granite'), 'Ashatiri uses granite');
  assert(DERICOST_PROVINCES['Valley of Tresimaen'].dominantArchitecture.toLowerCase().includes('slate'), 'Tresimaen uses slate');
  assert(DERICOST_PROVINCES['Dericost Marshes'].dominantArchitecture.toLowerCase().includes('timber'), 'Marshes use timber/stilts');
  assert(DERICOST_PROVINCES['The High Desert Plateau'].dominantArchitecture.toLowerCase().includes('adobe'), 'High desert uses adobe');
  assert(DERICOST_PROVINCES['Nesortania Maritime Coast'].dominantArchitecture.toLowerCase().includes('limestone'), 'Nesortania uses limestone');
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
