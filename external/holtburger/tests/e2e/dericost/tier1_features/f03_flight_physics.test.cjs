/**
 * Tier 1: Feature 3 — Hellcat Flight Speed & Travel Time
 * Verified flight speeds (v_cruise = 83 m/s, v_max = 111 m/s, v_min = 30 m/s) and ~4-minute flight.
 * Sources: ORIGINAL_REQUEST §R2, PROJECT.md §Feature 3, VehicleProfile.cs, flight_model.js
 */

const { createSuite, assert, assertEquals, assertNear, assertInRange, CONSTANTS } = require('../harness.cjs');

const suite = createSuite('Tier 1: Feature 3 - Hellcat Flight Speed & Travel Time', 1);

suite.addTest('F3.1: Hellcat velocity parameters match authoritative VehicleProfile.cs', () => {
  // Authoritative values from VehicleProfile.HellcatDemo() lines 95-97:
  // VMin = 30f, VCruise = 83f, VMax = 111f, Accel = 8f, Decel = 12f
  assertEquals(CONSTANTS.HELLCAT_V_MIN, 30.0, 'VMin must be 30.0 m/s (108 km/h)');
  assertEquals(CONSTANTS.HELLCAT_V_CRUISE, 83.0, 'VCruise must be 83.0 m/s (~300 km/h)');
  assertEquals(CONSTANTS.HELLCAT_V_MAX, 111.0, 'VMax must be 111.0 m/s (~400 km/h with boost)');
  assertEquals(CONSTANTS.HELLCAT_ACCEL, 8.0, 'Acceleration must be 8.0 m/s2');
  assertEquals(CONSTANTS.HELLCAT_DECEL, 12.0, 'Deceleration must be 12.0 m/s2');
});

suite.addTest('F3.2: 30 Hz fixed-step integration acceleration curve from standstill to cruise', () => {
  // Authoritative simulation step: 30 Hz (DT = 1/30 s)
  const dt = CONSTANTS.HELLCAT_DT;
  let speed = 0.0;
  let time = 0.0;
  let distance = 0.0;

  // Accelerate at 8.0 m/s2 up to VCruise (83.0 m/s)
  while (speed < CONSTANTS.HELLCAT_V_CRUISE) {
    speed = Math.min(CONSTANTS.HELLCAT_V_CRUISE, speed + CONSTANTS.HELLCAT_ACCEL * dt);
    distance += speed * dt;
    time += dt;
  }

  // Exact continuous formula: t = 83 / 8 = 10.375 s, distance = 0.5 * 8 * 10.375^2 = 430.56 m
  assertNear(time, 10.375, dt * 1.5, 'Acceleration time from 0 to 83 m/s must be ~10.38 seconds');
  assertNear(distance, 430.56, 15.0, 'Acceleration distance must be ~430.56 meters');
});

suite.addTest('F3.3: 4-minute cruising flight covers nominal ~19.92 km', () => {
  // Authoritative derivation: 240 seconds * 83.0 m/s = 19,920.0 meters
  const cruiseDistance = CONSTANTS.NOMINAL_FLIGHT_SECONDS * CONSTANTS.HELLCAT_V_CRUISE;
  assertEquals(cruiseDistance, 19920.0, '240s at 83 m/s must equal 19,920.0 meters');
  assertNear(cruiseDistance / 1000.0, 19.92, 1e-4, 'In kilometers: 19.92 km');
});

suite.addTest('F3.4: 104-landblock ocean gap produces 240.58s transit time at cruise', () => {
  // Authoritative derivation: 104 LBs * 192.0 m = 19,968.0 m.
  // Transit time = 19,968.0 / 83.0 = 240.5783 seconds (~4 minutes 0.6 seconds)
  const gapMeters = CONSTANTS.OCEAN_GAP_LBS * CONSTANTS.LB_SIZE;
  assertEquals(gapMeters, 19968.0, '104 landblocks must equal exactly 19,968.0 meters');

  const transitSeconds = gapMeters / CONSTANTS.HELLCAT_V_CRUISE;
  assertNear(transitSeconds, 240.5783, 1e-3, 'Transit duration must be ~240.58 seconds');

  const transitMinutes = transitSeconds / 60.0;
  assertNear(transitMinutes, 4.0096, 0.02, 'Transit duration in minutes must be ~4.01 min');
});

suite.addTest('F3.5: Hellcat flight envelope limits adhere to VehicleProfile parameters', () => {
  // Authoritative parameters from VehicleProfile.cs lines 101-103:
  // ClimbMax = 20f, SinkMax = 25f, FloorAgl = 30f, CeilingAgl = 450f
  assertEquals(CONSTANTS.HELLCAT_CLIMB_MAX, 20.0, 'Climb rate max 20 m/s');
  assertEquals(CONSTANTS.HELLCAT_SINK_MAX, 25.0, 'Sink rate max 25 m/s');
  assertEquals(CONSTANTS.HELLCAT_FLOOR_AGL, 30.0, 'Floor AGL 30 m');
  assertEquals(CONSTANTS.HELLCAT_CEILING_AGL, 450.0, 'Ceiling AGL 450 m default');
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
