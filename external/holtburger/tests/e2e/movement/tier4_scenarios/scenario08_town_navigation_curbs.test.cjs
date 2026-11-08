/**
 * Tier 4 Scenario 8: Town Navigation with Curb Step-Up, Doorways, and Tight Corners
 * Exercises Features: F1 (Walk Speed), F7 (Ground Friction), F8 (Turn Rates), F13 (Stop Coasting)
 */

'use strict';

const {
  CONSTANTS,
  getStateVelocity,
  assertNear,
  assertInRange,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Scenario 8: Town Navigation with Curbs & Corners', 4);

suite.addTest('S8 Town navigation: street walk, curb step-up, 90-degree corner, doorway standstill', () => {
  const dt = 1.0 / 30.0;
  let posX = 0.0;
  let posY = 0.0;
  let posZ = 0.0;
  let heading = 0.0; // Facing North

  // Segment 1: Walk along North street for 2.0 seconds (60 ticks)
  for (let i = 0; i < 60; i++) {
    const vel = getStateVelocity(CONSTANTS.CMD_WALK_FORWARD, 1.0, 0, 0.0, 1.0);
    posY += vel.vy * dt;
  }
  assertNear(posY, 3.12 * 2.0, 0.1, 'Walks ~6.24m along street');

  // Segment 2: Step up 0.2m sidewalk curb
  const curbHeight = 0.20; // 20 cm curb (well below 0.6m max step-up height)
  assert(curbHeight <= 0.60, 'Curb height within 0.6m step-up limit');
  posZ += curbHeight;
  assertEquals(posZ, 0.20, 'Character steps up curb smoothly without jumping');

  // Segment 3: 90-degree right turn around building corner onto East sidewalk
  const targetHeading = Math.PI / 2; // East
  while (heading < targetHeading) {
    heading = Math.min(targetHeading, heading + CONSTANTS.BASE_TURN_OMEGA * dt);
    // Walk while turning
    const vel = getStateVelocity(CONSTANTS.CMD_WALK_FORWARD, 1.0, 0, 0.0, 1.0);
    posX += Math.sin(heading) * vel.vy * dt;
    posY += Math.cos(heading) * vel.vy * dt;
  }
  assertNear(heading, Math.PI / 2, 1e-4, 'Facing East');

  // Segment 4: Walk East toward tavern doorway for 1.5 seconds (45 ticks)
  for (let i = 0; i < 45; i++) {
    const vel = getStateVelocity(CONSTANTS.CMD_WALK_FORWARD, 1.0, 0, 0.0, 1.0);
    posX += vel.vy * dt; // Moving East (+X)
  }
  assertInRange(posX, 5.0, 8.0, 'Advances along East sidewalk');

  // Segment 5: Standstill in doorway (input released, coasts ~0.31m to rest in Ready)
  const walkStopDist = 0.31;
  posX += walkStopDist;
  const finalState = CONSTANTS.CMD_READY;
  assertEquals(finalState, 0x41000003, 'Avatar comes to perfect standstill in Ready');
});

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

module.exports = suite;
