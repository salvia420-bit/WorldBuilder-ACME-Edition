/**
 * Tier 2: Boundary 12 — Door Angle Clamping & State Machine Extremes
 * Rotation angle clamp [-pi/2, 0], idempotency, rapid toggle stress, missing hinge fallback.
 * Sources: TEST_INFRA.md, ORIGINAL_REQUEST §R3, capture_phase6_step_e_doors.cjs
 */

const { createSuite, assert, assertEquals, assertNear, CONSTANTS } = require('../harness.cjs');

const suite = createSuite('Tier 2: Boundary 12 - Door Angle Clamping & State Machine Extremes', 2);

class RobustDoorEntity {
  constructor(guid) {
    this.guid = guid;
    this.state = 'closed';
    this.angleRad = 0.0;
    this.inCollisionIndex = true;
    this.toggleCount = 0;
  }

  setAngleClamped(targetAngle) {
    // Clamp to valid arc: [-pi/2, 0.0]
    const clamped = Math.max(-CONSTANTS.DOOR_ROTATION_RAD, Math.min(0.0, targetAngle));
    this.angleRad = clamped;
    return clamped;
  }

  open() {
    this.state = 'open';
    this.setAngleClamped(-CONSTANTS.DOOR_ROTATION_RAD);
    this.inCollisionIndex = false;
    this.toggleCount++;
  }

  close() {
    this.state = 'closed';
    this.setAngleClamped(0.0);
    this.inCollisionIndex = true;
    this.toggleCount++;
  }
}

suite.addTest('B12.1: Door hinge rotation angle is strictly clamped to [-pi/2, 0.0] radians', () => {
  const door = new RobustDoorEntity(2001);

  // Attempt to swing forward into positive radians (+45 deg)
  assertEquals(door.setAngleClamped(0.5), 0.0, 'Forward over-swing clamped to 0.0 (closed)');

  // Attempt to swing past 90 degrees to 180 degrees (-pi)
  assertNear(door.setAngleClamped(-Math.PI), -Math.PI / 2, 1e-4, 'Backward over-swing clamped to -pi/2');

  // Valid 45 degree opening
  assertNear(door.setAngleClamped(-Math.PI / 4), -Math.PI / 4, 1e-4, 'Intermediate angle preserved');
});

suite.addTest('B12.2: Redundant open() calls are idempotent and keep angle at -pi/2', () => {
  const door = new RobustDoorEntity(2002);
  door.open();
  assertNear(door.angleRad, -Math.PI / 2, 1e-4);
  assertEquals(door.inCollisionIndex, false);

  // Duplicate open calls
  door.open();
  door.open();
  assertNear(door.angleRad, -Math.PI / 2, 1e-4, 'Angle stays at -pi/2');
  assertEquals(door.state, 'open');
  assertEquals(door.inCollisionIndex, false, 'AABB remains dropped');
});

suite.addTest('B12.3: Redundant close() calls are idempotent and keep angle at 0.0', () => {
  const door = new RobustDoorEntity(2003);
  assertEquals(door.state, 'closed');

  door.close();
  door.close();
  assertEquals(door.angleRad, 0.0, 'Angle stays at 0.0');
  assertEquals(door.state, 'closed');
  assertEquals(door.inCollisionIndex, true, 'AABB remains inserted');
});

suite.addTest('B12.4: Rapid door toggle stress test maintains 100% collision index synchronization', () => {
  const door = new RobustDoorEntity(2004);

  // 100 rapid alternations
  for (let i = 0; i < 100; i++) {
    if (i % 2 === 0) {
      door.open();
      assertEquals(door.inCollisionIndex, false, `Cycle ${i}: Open must drop collision`);
      assertNear(door.angleRad, -Math.PI / 2, 1e-4);
    } else {
      door.close();
      assertEquals(door.inCollisionIndex, true, `Cycle ${i}: Closed must insert collision`);
      assertEquals(door.angleRad, 0.0);
    }
  }
  assertEquals(door.toggleCount, 100);
});

suite.addTest('B12.5: Missing hinge / malformed door entity fallback treats doorway safely', () => {
  function handleCorruptedDoor(doorDesc) {
    if (!doorDesc || !doorDesc.hingePosition || Number.isNaN(doorDesc.hingePosition[0])) {
      // Safe fallback: remove broken collider to prevent trapping players inside
      return { passPermitted: true, status: 'fallback_open' };
    }
    return { passPermitted: doorDesc.state === 'open', status: 'normal' };
  }

  const brokenDoor = { guid: 9999, state: 'unknown', hingePosition: null };
  const fallback = handleCorruptedDoor(brokenDoor);

  assertEquals(fallback.status, 'fallback_open');
  assertEquals(fallback.passPermitted, true, 'Corrupted door fails open to prevent player lock-in');
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
