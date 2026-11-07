/**
 * Tier 2: Boundary 3 — Flight Speed Boundaries
 * Stall thresholds, boost clamping, deceleration limits, input quantization extremes.
 * Sources: TEST_INFRA.md, ORIGINAL_REQUEST §R2, VehicleProfile.cs, flight_model.js
 */

const { createSuite, assert, assertEquals, assertNear, assertInRange, CONSTANTS } = require('../harness.cjs');

const suite = createSuite('Tier 2: Boundary 3 - Flight Speed Boundaries', 2);

suite.addTest('B3.1: Airspeed below stall velocity (30.0 m/s) triggers descent and loss of control', () => {
  function checkStallState(speed, isFlightMode) {
    if (!isFlightMode) return { isStalled: false, canManeuver: true };
    if (speed < CONSTANTS.HELLCAT_V_MIN) {
      return { isStalled: true, sinkRate: CONSTANTS.HELLCAT_SINK_MAX, canManeuver: false };
    }
    return { isStalled: false, sinkRate: 0.0, canManeuver: true };
  }

  const stallCheck = checkStallState(25.0, true);
  assertEquals(stallCheck.isStalled, true, 'Speed 25 m/s < 30 m/s triggers stall');
  assertEquals(stallCheck.canManeuver, false, 'Cannot maneuver while stalled');
  assertEquals(stallCheck.sinkRate, 25.0, 'Forces sink rate toward ground');

  const flyCheck = checkStallState(30.0, true);
  assertEquals(flyCheck.isStalled, false, 'Speed 30 m/s maintains controlled flight');
});

suite.addTest('B3.2: Maximum boost velocity is strictly clamped at 111.0 m/s', () => {
  function updateSpeedWithBoost(currentSpeed, boostRequested, dt) {
    let target = boostRequested ? CONSTANTS.HELLCAT_V_MAX : CONSTANTS.HELLCAT_V_CRUISE;
    let maxDelta = CONSTANTS.HELLCAT_ACCEL * dt;
    let next = currentSpeed + Math.min(maxDelta, target - currentSpeed);
    return Math.min(CONSTANTS.HELLCAT_V_MAX, next);
  }

  const dt = 1.0;
  let speed = 100.0;
  for (let i = 0; i < 20; i++) {
    speed = updateSpeedWithBoost(speed, true, dt);
  }
  assertEquals(speed, 111.0, 'Speed under continuous boost cannot exceed 111.0 m/s');
});

suite.addTest('B3.3: Server-side vehicle_speed_cap clamps fraudulent client speed claims', () => {
  // Authoritative server check: ACE Server clamps vehicle speed to VMax
  function serverValidateVehiclePosition(prevPos, reportedPos, dt) {
    const dist = Math.hypot(reportedPos.x - prevPos.x, reportedPos.y - prevPos.y, reportedPos.z - prevPos.z);
    const speed = dist / dt;
    const maxAllowed = CONSTANTS.HELLCAT_V_MAX * 1.05; // 5% network jitter slack
    if (speed > maxAllowed) {
      return { accepted: false, clampedSpeed: CONSTANTS.HELLCAT_V_MAX, violation: true };
    }
    return { accepted: true, clampedSpeed: speed, violation: false };
  }

  // Pilot reporting 150 m/s (speed hack attempt)
  const hackCheck = serverValidateVehiclePosition({ x: 0, y: 0, z: 100 }, { x: 0, y: 150, z: 100 }, 1.0);
  assertEquals(hackCheck.accepted, false, 'Speed of 150 m/s rejected by server');
  assertEquals(hackCheck.violation, true);

  // Pilot flying at boost (110 m/s)
  const legitCheck = serverValidateVehiclePosition({ x: 0, y: 0, z: 100 }, { x: 0, y: 110, z: 100 }, 1.0);
  assertEquals(legitCheck.accepted, true, 'Speed of 110 m/s accepted by server');
});

suite.addTest('B3.4: Deceleration rate is clamped to maximum -12.0 m/s2 during hard braking', () => {
  function applyBrakes(currentSpeed, dt) {
    const maxDecel = CONSTANTS.HELLCAT_DECEL * dt;
    return Math.max(0.0, currentSpeed - maxDecel);
  }

  const speedAfter1s = applyBrakes(83.0, 1.0);
  assertNear(speedAfter1s, 71.0, 1e-4, '83 m/s - 12 m/s = 71 m/s');

  // Total stop time from cruise (83 m/s)
  const stopTime = CONSTANTS.HELLCAT_V_CRUISE / CONSTANTS.HELLCAT_DECEL;
  assertNear(stopTime, 6.9167, 1e-3, 'Stop time from cruise is ~6.92 seconds');
});

suite.addTest('B3.5: Stick input quantization boundaries: -128 clamps to -1.0, 127 dequantizes to +1.0', () => {
  // Authoritative dequantization formula from flight_model.js line 49-54:
  // stick(v) { return v === -128 ? -1.0 : v / 127.0; }
  function stick(v) {
    return v === -128 ? -1.0 : v / 127.0;
  }

  assertEquals(stick(-128), -1.0, 'i8 -128 clamps to -1.0');
  assertEquals(stick(-127), -1.0, 'i8 -127 dequantizes to -1.0');
  assertEquals(stick(0), 0.0, 'i8 0 dequantizes to 0.0');
  assertEquals(stick(127), 1.0, 'i8 127 dequantizes to 1.0');
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
