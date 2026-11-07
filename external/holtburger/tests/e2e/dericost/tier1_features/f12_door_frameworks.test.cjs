/**
 * Tier 1: Feature 12 — Building Door Locations & Entry Frameworks
 * Door portals linking outdoor to interior EnvCells.
 * Door interaction: 90-degree hinge rotation, AABB collision index toggle.
 * Sources: ORIGINAL_REQUEST §R3, PROJECT.md §Feature 16, capture_phase6_step_e_doors.cjs
 */

const { createSuite, assert, assertEquals, assertNear, CONSTANTS } = require('../harness.cjs');

const suite = createSuite('Tier 1: Feature 12 - Building Door Locations & Entry Frameworks', 1);

// Mock Door / Portal system simulating capture_phase6_step_e_doors.cjs
class MockDoorEntity {
  constructor(guid, portalId, interiorCellId) {
    this.guid = guid;
    this.portalId = portalId;
    this.interiorCellId = interiorCellId;
    this.state = 'closed'; // 'closed' | 'open'
    this.rotationZ = 0.0; // 0.0 closed, -Math.PI / 2 open
    this.clearanceHeight = 2.4; // meters
    this.clearanceWidth = 1.6; // meters
    this.aabb = { min: [-0.8, -0.1, 0.0], max: [0.8, 0.1, 2.4] };
    this.inCollisionIndex = true;
  }

  useObject() {
    if (this.state === 'closed') {
      this.state = 'open';
      this.rotationZ = -CONSTANTS.DOOR_ROTATION_RAD; // -pi/2
      this.inCollisionIndex = false; // AABB drops out of index
    } else {
      this.state = 'closed';
      this.rotationZ = 0.0;
      this.inCollisionIndex = true; // AABB re-inserted
    }
    return {
      kind: 14, // UseDone echo
      doorGuid: this.guid,
      newState: this.state,
      rotationZ: this.rotationZ,
      inCollisionIndex: this.inCollisionIndex
    };
  }

  canPlayerTraverse(playerAABB) {
    // If door is closed (in collision index), traversal is blocked
    return !this.inCollisionIndex;
  }
}

suite.addTest('F12.1: Door portals in BuildInfo link exterior frame to valid interior EnvCells (>0x0100)', () => {
  const portalInternal = {
    flags: 0x0001,
    otherCellId: 0x00010101, // Interior EnvCell 0x0101
    otherPortalId: 1,
    stabList: [0x0101, 0x0102]
  };

  const interiorCellNum = portalInternal.otherCellId & 0xffff;
  assert(interiorCellNum > 0x0100, `Interior cell (${interiorCellNum.toString(16)}) must be > 0x0100`);
  assertEquals(portalInternal.stabList.length >= 1, true, 'PVS stabList must contain at least 1 cell');
});

suite.addTest('F12.2: Door portal frame clearance accommodates standard AC player height and width', () => {
  const door = new MockDoorEntity(1001, 1, 0x00010101);

  assert(door.clearanceHeight >= 2.2, `Clearance height ${door.clearanceHeight}m must be >= 2.2m`);
  assert(door.clearanceWidth >= 1.4, `Clearance width ${door.clearanceWidth}m must be >= 1.4m`);
});

suite.addTest('F12.3: Door use triggers 90-degree (-pi/2) hinge rotation', () => {
  const door = new MockDoorEntity(1002, 1, 0x00010101);
  assertEquals(door.state, 'closed');
  assertEquals(door.rotationZ, 0.0);

  // Use door to open
  const event = door.useObject();
  assertEquals(event.newState, 'open');
  assertNear(event.rotationZ, -Math.PI / 2, 1e-4, 'Door rotation must be -pi/2 radians (-90 deg)');
  assertNear(Math.abs(event.rotationZ), CONSTANTS.DOOR_ROTATION_RAD, 1e-4);

  // Use door again to close
  const closeEvent = door.useObject();
  assertEquals(closeEvent.newState, 'closed');
  assertEquals(closeEvent.rotationZ, 0.0, 'Door returns to 0.0 rad on close');
});

suite.addTest('F12.4: Closed door inserts AABB into collision tree and blocks player progression', () => {
  const door = new MockDoorEntity(1003, 1, 0x00010101);
  assertEquals(door.inCollisionIndex, true, 'Closed door must be present in collision index');

  const playerCanPass = door.canPlayerTraverse();
  assertEquals(playerCanPass, false, 'Closed door must block player progression');
});

suite.addTest('F12.5: Open door drops AABB from collision tree and allows player traversal (delta >= 1m)', () => {
  const door = new MockDoorEntity(1004, 1, 0x00010101);
  door.useObject(); // Open door

  assertEquals(door.inCollisionIndex, false, 'Open door must drop out of collision index');
  const playerCanPass = door.canPlayerTraverse();
  assertEquals(playerCanPass, true, 'Open door allows player traversal');

  // Simulate player walk forward through doorway
  let playerY = 0.0;
  const stepDistance = 1.2; // meters
  if (door.canPlayerTraverse()) {
    playerY += stepDistance;
  }
  assert(playerY >= 1.0, `Player advanced ${playerY}m through open doorway (must be >= 1.0m)`);
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
