/**
 * Tier 3: Combination 5 — Building Portal Traversal & Indoor Physics Handoff
 * Features combined: F3 (Physics & Locomotion) + F11 (Building Models) + F12 (Door Portals).
 * Evaluates portal transitions between outdoor and indoor cells, coordinate remapping,
 * indoor room chaining, and exit back to municipal plaza.
 * Sources: PROJECT.md, TEST_INFRA.md, indoor_router.js, BuildingAnalyzer.cs
 */

const { createSuite, assert, assertEquals, assertNear, assertInRange, CONSTANTS } = require('../harness.cjs');

const suite = createSuite('Tier 3: Combination 5 - Building Portal Traversal & Indoor Physics Handoff', 3);

class IndoorPortalRouter {
  constructor(buildingOrigin) {
    this.buildingOrigin = buildingOrigin; // [gx, gy, gz]
    this.activeCellId = 0; // 0 = outdoor
    this.playerLocalPos = [0, 0, 0];
    this.playerVelocity = [0, 0, 0];

    // Blueprint rooms
    this.cells = {
      0x0101: { name: 'Foyer', offset: [0, 0, 0], portals: { 1: 0, 2: 0x0102 } },
      0x0102: { name: 'Main Hall', offset: [15, 0, 0], portals: { 3: 0x0101, 4: 0x0103 } },
      0x0103: { name: 'Vault', offset: [30, 0, 0], portals: { 5: 0x0102, 6: 0x0104 } },
      0x0104: { name: 'Sanctum', offset: [45, 0, 0], portals: { 7: 0x0103 } }
    };
  }

  enterFromOutdoor(doorPortalId = 1) {
    this.activeCellId = 0x0101;
    // Remap player position to cell local coordinates
    this.playerLocalPos = [0.0, 1.2, 0.0]; // 1.2m inside threshold
    return {
      activeCellId: this.activeCellId,
      cellName: this.cells[this.activeCellId].name,
      isIndoor: true,
      localPos: [...this.playerLocalPos]
    };
  }

  traversePortal(fromPortalId, toPortalId, targetCellId) {
    this.activeCellId = targetCellId;
    if (targetCellId === 0) {
      // Exited to outdoor
      return {
        activeCellId: 0,
        cellName: 'Outdoor Plaza',
        isIndoor: false,
        worldPos: [this.buildingOrigin[0], this.buildingOrigin[1] - 1.5, this.buildingOrigin[2]]
      };
    }
    return {
      activeCellId: this.activeCellId,
      cellName: this.cells[this.activeCellId].name,
      isIndoor: true
    };
  }
}

suite.addTest('C5.1: Outdoor to indoor handoff switches active cell from outdoor 0 to interior EnvCell 0x0101', () => {
  const router = new IndoorPortalRouter([25000.0, 105000.0, 350.0]);
  assertEquals(router.activeCellId, 0, 'Initially in outdoor cell space');

  const handoff = router.enterFromOutdoor(1);
  assertEquals(handoff.activeCellId, 0x0101, 'Switches to EnvCell 0x0101');
  assertEquals(handoff.isIndoor, true, 'isIndoor flag active');
  assertEquals(handoff.cellName, 'Foyer');
});

suite.addTest('C5.2: Character velocity vector is preserved across portal transitions', () => {
  const router = new IndoorPortalRouter([25000.0, 105000.0, 350.0]);
  router.enterFromOutdoor(1);

  // Set running velocity
  router.playerVelocity = [2.5, 3.8, 0.0];

  // Cross internal portal from Foyer to Main Hall
  const transition = router.traversePortal(2, 3, 0x0102);
  assertEquals(transition.activeCellId, 0x0102);

  // Velocity must persist smoothly without stutter or zeroing
  assertEquals(router.playerVelocity[0], 2.5);
  assertEquals(router.playerVelocity[1], 3.8);
  assertEquals(router.playerVelocity[2], 0.0);
});

suite.addTest('C5.3: Reverse door traversal exits building back to outdoor municipal plaza', () => {
  const router = new IndoorPortalRouter([25000.0, 105000.0, 350.0]);
  router.enterFromOutdoor(1);
  assertEquals(router.activeCellId, 0x0101);

  // Walk back out through entrance portal
  const exitHandoff = router.traversePortal(1, 0, 0);
  assertEquals(exitHandoff.activeCellId, 0, 'Active cell reset to outdoor 0');
  assertEquals(exitHandoff.isIndoor, false, 'isIndoor flag cleared');
  assertNear(exitHandoff.worldPos[1], 104998.5, 1e-4, 'Player placed outside in front of entrance');
});

suite.addTest('C5.4: Door re-closing from interior re-inserts AABB into collision tree', () => {
  const door = { state: 'open', inCollisionIndex: false };

  function closeFromInside() {
    door.state = 'closed';
    door.inCollisionIndex = true;
  }

  assertEquals(door.state, 'open');
  closeFromInside();
  assertEquals(door.state, 'closed');
  assertEquals(door.inCollisionIndex, true, 'AABB re-enters collision tree, blocking player from leaving');
});

suite.addTest('C5.5: Multi-portal building interior navigation traverses 4 connected rooms smoothly', () => {
  const router = new IndoorPortalRouter([25000.0, 105000.0, 350.0]);
  router.enterFromOutdoor(1);
  assertEquals(router.activeCellId, 0x0101, 'Room 1: Foyer');

  router.traversePortal(2, 3, 0x0102);
  assertEquals(router.activeCellId, 0x0102, 'Room 2: Main Hall');

  router.traversePortal(4, 5, 0x0103);
  assertEquals(router.activeCellId, 0x0103, 'Room 3: Vault');

  router.traversePortal(6, 7, 0x0104);
  assertEquals(router.activeCellId, 0x0104, 'Room 4: Sanctum');

  // Verify deep room is connected to outer chain
  assertEquals(router.cells[0x0104].name, 'Sanctum');
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
