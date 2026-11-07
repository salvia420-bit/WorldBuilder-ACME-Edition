/**
 * Tier 1: Feature 11 — Distinct Building 3D Models & Textures
 * Standalone building model validation per BuildingAnalyzer.cs.
 * CellCount >= 4, PortalCount >= 2, TotalStatics >= 14, AvgPerLandblock < 1.35.
 * Sources: ORIGINAL_REQUEST §R3, PROJECT.md §Feature 15, BuildingAnalyzer.cs
 */

const { createSuite, assert, assertEquals, assertInRange, CONSTANTS } = require('../harness.cjs');

const suite = createSuite('Tier 1: Feature 11 - Distinct Building 3D Models & Textures', 1);

// Structural fragment piece IDs from BuildingAnalyzer.cs line 25-32
const KNOWN_STRUCTURAL_PIECES = new Set([
  0x01002289, // villa fragment piece
  0x01001EE9, 0x01001EEA, 0x01001EEB, 0x01001EEC, 0x01001EED, 0x01001EEE, 0x01001EEF, 0x01001EF0,
  0x01001EF1, 0x01001EF2, 0x01001EF3, 0x01001EF4,
  0x01001F0A, 0x01001F0B, 0x01001F11, 0x01001F15, 0x01001F1A, 0x01001F1C, 0x01001F1D, 0x01001F20, 0x01001F29,
  0x01001FB3
]);

// Validator logic replicating BuildingAnalyzer.cs
function validateBuildingProfile(profile) {
  const reasons = [];

  if (KNOWN_STRUCTURAL_PIECES.has(profile.modelId)) {
    reasons.push('Model is in KnownStructuralPieceModelIds');
  }
  if (profile.cellCount < CONSTANTS.MIN_BUILDING_CELLS) {
    reasons.push(`CellCount (${profile.cellCount}) < ${CONSTANTS.MIN_BUILDING_CELLS}`);
  }
  if (profile.portalCount < CONSTANTS.MIN_BUILDING_PORTALS) {
    reasons.push(`PortalCount (${profile.portalCount}) < ${CONSTANTS.MIN_BUILDING_PORTALS}`);
  }
  if (profile.totalStatics < CONSTANTS.MIN_BUILDING_STATICS) {
    reasons.push(`TotalStatics (${profile.totalStatics}) < ${CONSTANTS.MIN_BUILDING_STATICS}`);
  }
  const avgPerLB = profile.uniqueLandblocks > 0 ? profile.occurrenceCount / profile.uniqueLandblocks : 0;
  if (avgPerLB >= CONSTANTS.MAX_PAIRED_HALF_RATIO || profile.maxPerLandblock >= 3) {
    reasons.push(`IsPairedHalf: avgPerLB=${avgPerLB.toFixed(2)} >= 1.35 or maxPerLB=${profile.maxPerLandblock} >= 3`);
  }

  return {
    isSuitable: reasons.length === 0,
    reasons
  };
}

suite.addTest('F11.1: Complete standalone building satisfies minimum 4 EnvCell requirement', () => {
  const completeGuildhall = {
    modelId: 0x01100010,
    numLeaves: 12,
    cellCount: 6,
    portalCount: 4,
    totalStatics: 28,
    occurrenceCount: 5,
    uniqueLandblocks: 5,
    maxPerLandblock: 1
  };

  const result = validateBuildingProfile(completeGuildhall);
  assertEquals(result.isSuitable, true, 'Valid guildhall must be accepted');
  assert(completeGuildhall.cellCount >= 4, 'CellCount must be >= 4');

  const smallShed = { ...completeGuildhall, cellCount: 2 };
  const failResult = validateBuildingProfile(smallShed);
  assertEquals(failResult.isSuitable, false, 'Building with only 2 cells must be rejected');
  assert(failResult.reasons.some(r => r.includes('CellCount')), 'Reason includes CellCount');
});

suite.addTest('F11.2: Building satisfies minimum 2 portal transitions requirement', () => {
  const completeHouse = {
    modelId: 0x01100011,
    numLeaves: 8,
    cellCount: 4,
    portalCount: 2,
    totalStatics: 16,
    occurrenceCount: 10,
    uniqueLandblocks: 10,
    maxPerLandblock: 1
  };

  const result = validateBuildingProfile(completeHouse);
  assertEquals(result.isSuitable, true, 'House with 2 portals accepted');

  const deadEndRoom = { ...completeHouse, portalCount: 1 };
  const failResult = validateBuildingProfile(deadEndRoom);
  assertEquals(failResult.isSuitable, false, 'Building with only 1 portal rejected');
});

suite.addTest('F11.3: Building satisfies minimum 14 interior furnishings requirement', () => {
  const furnishedManor = {
    modelId: 0x01100012,
    numLeaves: 16,
    cellCount: 5,
    portalCount: 3,
    totalStatics: 22,
    occurrenceCount: 3,
    uniqueLandblocks: 3,
    maxPerLandblock: 1
  };

  const result = validateBuildingProfile(furnishedManor);
  assertEquals(result.isSuitable, true, 'Manor with 22 statics accepted');

  const emptyShell = { ...furnishedManor, totalStatics: 8 };
  const failResult = validateBuildingProfile(emptyShell);
  assertEquals(failResult.isSuitable, false, 'Empty shell with only 8 statics rejected');
});

suite.addTest('F11.4: Multi-piece / paired-half building fragments are rejected', () => {
  // Mirrored villa halves occur multiple times per landblock (avg >= 1.35)
  const pairedHalf = {
    modelId: 0x01100013,
    numLeaves: 10,
    cellCount: 4,
    portalCount: 2,
    totalStatics: 18,
    occurrenceCount: 8,
    uniqueLandblocks: 4, // 8 / 4 = 2.0 avg per LB
    maxPerLandblock: 2
  };

  const result = validateBuildingProfile(pairedHalf);
  assertEquals(result.isSuitable, false, 'Paired half with avg 2.0 per LB must be rejected');
  assert(result.reasons.some(r => r.includes('IsPairedHalf')), 'Reason identifies paired half');
});

suite.addTest('F11.5: Known structural piece IDs from BuildingAnalyzer are rejected outright', () => {
  for (const pieceId of [0x01002289, 0x01001EE9, 0x01001FB3]) {
    const fragment = {
      modelId: pieceId,
      numLeaves: 20,
      cellCount: 8,
      portalCount: 4,
      totalStatics: 30,
      occurrenceCount: 1,
      uniqueLandblocks: 1,
      maxPerLandblock: 1
    };
    const result = validateBuildingProfile(fragment);
    assertEquals(result.isSuitable, false, `Known fragment 0x${pieceId.toString(16)} must be rejected`);
    assert(result.reasons.some(r => r.includes('KnownStructuralPieceModelIds')));
  }
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
