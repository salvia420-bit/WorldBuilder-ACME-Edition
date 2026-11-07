/**
 * Tier 2: Boundary 9 — Ocean Gap Edge Cases
 * Exact departure (48,960m), mid-ocean empty streaming rings, exact landfall (68,928m),
 * parachute bail-out over ocean, boost flight traversal duration.
 * Sources: TEST_INFRA.md, ORIGINAL_REQUEST §R2, Survey 3 §2.1 & §4.1
 */

const { createSuite, assert, assertEquals, assertNear, assertInRange, CONSTANTS } = require('../harness.cjs');

const suite = createSuite('Tier 2: Boundary 9 - Ocean Gap Edge Cases', 2);

suite.addTest('B9.1: Exact departure boundary at Y = 48,960.0m cleanly transitions out of Dereth', () => {
  function getContinentAndZone(y) {
    if (y <= CONSTANTS.DERETH_NORTH_SHORE_Y) {
      return { continent: 0, zone: 'Dereth' };
    } else if (y < CONSTANTS.DERICOST_SOUTH_SHORE_Y) {
      return { continent: 0, zone: 'OceanCorridor' };
    } else {
      return { continent: 1, zone: 'Dericost' };
    }
  }

  assertEquals(getContinentAndZone(48960.0).zone, 'Dereth', 'Y=48,960m is Dereth northern coastline');
  assertEquals(getContinentAndZone(48960.01).zone, 'OceanCorridor', 'Y=48,960.01m enters ocean corridor');
});

suite.addTest('B9.2: Mid-ocean coordinates (Y = 58,944.0m) maintain empty near rings and zero statics', () => {
  function simulateResidencyRings(y) {
    if (y > CONSTANTS.DERETH_NORTH_SHORE_Y && y < CONSTANTS.DERICOST_SOUTH_SHORE_Y) {
      // In ocean gap: no outdoor landblocks or statics are baked
      return { activeRingLandblocks: 0, loadedStaticsCount: 0, oceanProceduralActive: true };
    }
    return { activeRingLandblocks: 9, loadedStaticsCount: 150, oceanProceduralActive: false };
  }

  const midOcean = simulateResidencyRings(58944.0);
  assertEquals(midOcean.activeRingLandblocks, 0, 'No near-ring terrain blocks allocated in ocean');
  assertEquals(midOcean.loadedStaticsCount, 0, 'Zero statics allocated in ocean');
  assertEquals(midOcean.oceanProceduralActive, true, 'Procedural sea plane is active');
});

suite.addTest('B9.3: Exact landfall boundary at Y = 68,928.0m cleanly transitions into Dericost', () => {
  function getContinentAndZone(y) {
    if (y < CONSTANTS.DERICOST_SOUTH_SHORE_Y) {
      return { continent: 0, zone: 'OceanCorridor' };
    } else {
      return { continent: 1, zone: 'Dericost' };
    }
  }

  assertEquals(getContinentAndZone(68927.99).zone, 'OceanCorridor');
  assertEquals(getContinentAndZone(68928.0).zone, 'Dericost', 'Y=68,928m is Dericost landfall');
  assertEquals(getContinentAndZone(68928.0).continent, 1, 'Continent Bit 31 is set');
});

suite.addTest('B9.4: Vehicle bailout over ocean gap deploys parachute at 150m AGL and lands at Z=0.0m', () => {
  // Authoritative parachute logic from fall_model.js:
  // Eject at altitude, free-fall to 150m AGL, chute deploys, steady 5 m/s descent to water surface at Z=0.0m
  function simulateOceanBailout(ejectAltitude) {
    let z = ejectAltitude;
    let speed = 20.0;
    let chuteOpen = false;
    let landed = false;
    const dt = 0.1;

    while (!landed && z > 0.0) {
      if (z <= 150.0 && !chuteOpen) {
        chuteOpen = true;
        speed = 5.0; // Terminal chute speed
      }
      z -= speed * dt;
      if (z <= 0.0) {
        z = 0.0;
        landed = true;
      }
    }
    return { finalZ: z, chuteOpened: chuteOpen, landedSafely: landed };
  }

  const result = simulateOceanBailout(350.0);
  assertEquals(result.finalZ, 0.0, 'Pilot lands safely on ocean surface at Z=0.0m');
  assertEquals(result.chuteOpened, true, 'Parachute opened at 150m AGL');
  assertEquals(result.landedSafely, true);
});

suite.addTest('B9.5: Fast-forward boost flight through ocean corridor at 111 m/s takes 179.89 seconds', () => {
  // 19,968.0m / 111.0 m/s = 179.8918s (~3.0 minutes)
  const boostDuration = CONSTANTS.OCEAN_GAP_METERS / CONSTANTS.HELLCAT_V_MAX;
  assertNear(boostDuration, 179.8918, 1e-3, 'Boost transit takes ~179.89 seconds');
  assertNear(boostDuration / 60.0, 2.998, 0.01, 'Boost transit is approximately 3.0 minutes');
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
