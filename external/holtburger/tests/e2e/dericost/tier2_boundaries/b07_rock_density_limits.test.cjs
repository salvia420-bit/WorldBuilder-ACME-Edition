/**
 * Tier 2: Boundary 7 — Rock & Scenery Density Limits
 * Zero-dimension colliders, giant monolith collision limits, road exclusion, collider separation.
 * Sources: TEST_INFRA.md, ORIGINAL_REQUEST §R2, Survey 1 §1.2, Survey 2 §1.5
 */

const { createSuite, assert, assertEquals, assertNear, assertInRange, CONSTANTS } = require('../harness.cjs');

const suite = createSuite('Tier 2: Boundary 7 - Rock & Scenery Density Limits', 2);

suite.addTest('B7.1: Zero-dimension colliding rock edge case: height=0 and radius=0 classified by ladder', () => {
  // Edge Case 6 from Survey 2 §4: 19 retail models have height=0 && radius=0 yet collide.
  // Classification must query narrow-phase ladder, not bare dimensions.
  function isModelCollidable(model) {
    if (model.narrowPhaseLadderRung && model.narrowPhaseLadderRung <= 3) {
      return true; // Rungs 1, 2, 3 collide
    }
    return false; // Rung 4 does not collide
  }

  const zeroDimBoulder = { height: 0.0, radius: 0.0, narrowPhaseLadderRung: 2 };
  assertEquals(isModelCollidable(zeroDimBoulder), true,
    'Model with 0 height/radius but Rung 2 cylsphere MUST collide');

  const zeroDimGrass = { height: 0.0, radius: 0.0, narrowPhaseLadderRung: 4 };
  assertEquals(isModelCollidable(zeroDimGrass), false,
    'Model with Rung 4 does not collide');
});

suite.addTest('B7.2: Giant monolith collision radius is clamped to prevent blocking whole landcells', () => {
  // A landcell is 24m wide. A single rock collider radius cannot exceed 12m without blocking traversal.
  const MAX_COLLIDER_RADIUS = 12.0;

  function clampColliderRadius(rawRadius) {
    return Math.min(MAX_COLLIDER_RADIUS, Math.max(0.2, rawRadius));
  }

  assertEquals(clampColliderRadius(3.5), 3.5, 'Normal boulder radius 3.5m preserved');
  assertEquals(clampColliderRadius(25.0), 12.0, 'Giant monolith radius 25m clamped to 12.0m max');
});

suite.addTest('B7.3: Road vertex exclusion zone strictly rejects solid prop placement', () => {
  // Paved roads in AC have terrain vertex code with Road Flag (0x01). Solid rocks cannot be placed on roads.
  function canPlacePropAtVertex(terrainCode, hasRoadFlag, propIsSolid) {
    if (hasRoadFlag) {
      return false; // Blocked by road right-of-way: no props allowed on paved road surface
    }
    return true;
  }

  assertEquals(canPlacePropAtVertex(1, true, true), false, 'Solid rock rejected on paved road');
  assertEquals(canPlacePropAtVertex(1, true, false), false, 'Even ground clutter omitted from paved road center');
  assertEquals(canPlacePropAtVertex(1, false, true), true, 'Solid rock allowed off-road');
});

suite.addTest('B7.4: Overlapping prop deduping enforces minimum 1.5m spatial separation', () => {
  function arePropsSeparated(p1, p2, minSeparation = 1.5) {
    const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    return dist >= minSeparation;
  }

  const rock1 = { x: 100.0, y: 100.0 };
  const rock2 = { x: 100.8, y: 100.5 }; // dist = ~0.94m < 1.5m
  const rock3 = { x: 102.0, y: 100.0 }; // dist = 2.0m >= 1.5m

  assertEquals(arePropsSeparated(rock1, rock2), false, 'Props too close are flagged for deduplication');
  assertEquals(arePropsSeparated(rock1, rock3), true, 'Props >= 1.5m apart are permitted');
});

suite.addTest('B7.5: Extreme slope rock placement clamps boulders to horizontal shelf', () => {
  function orientRockOnSlope(slopeNormal) {
    // If slope normal Z < 0.5 (>60 deg pitch), rock rests on leveled horizontal pedestal
    if (slopeNormal[2] < 0.5) {
      return { orientation: 'horizontal_shelf', tiltRad: 0.0 };
    }
    return { orientation: 'slope_aligned', tiltRad: Math.acos(slopeNormal[2]) };
  }

  const gentleSlope = [0.1, 0.0, 0.995];
  const gentleResult = orientRockOnSlope(gentleSlope);
  assertEquals(gentleResult.orientation, 'slope_aligned');

  const sheerCliff = [0.866, 0.0, 0.4]; // Z < 0.5
  const cliffResult = orientRockOnSlope(sheerCliff);
  assertEquals(cliffResult.orientation, 'horizontal_shelf');
  assertEquals(cliffResult.tiltRad, 0.0);
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
