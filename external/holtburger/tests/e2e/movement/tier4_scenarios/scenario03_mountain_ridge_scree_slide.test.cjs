/**
 * Tier 4 Scenario 3: Traversing Mountain Ridge & Steep Scree
 * Exercises Features: F11 (Walkable Slope Threshold), F12 (Steep Slope Sliding & Sledding Glide)
 */

'use strict';

const {
  CONSTANTS,
  isWalkableSlope,
  calcSlopeSlideAcceleration,
  calcFriction,
  assertNear,
  assertInRange,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Scenario 3: Mountain Ridge & Scree Slide Descent', 4);

suite.addTest('S3 Ridge ascent, steep scree transition, high-speed sledding glide, and basin stop', () => {
  const dt = 1.0 / 30.0;

  // Phase 1: Ascent up moderate slope (30 degrees, Nz = 0.8660)
  const ridgeSlopeRad = 30.0 * (Math.PI / 180.0);
  const ridgeNormal = { x: 0, y: Math.sin(ridgeSlopeRad), z: Math.cos(ridgeSlopeRad) };
  assertEquals(isWalkableSlope(ridgeNormal), true, '30-degree ridge slope is walkable');

  // Player walks up ridge for 3.0 seconds (90 ticks) at 3.12 m/s
  let posAscentY = 0.0;
  for (let i = 0; i < 90; i++) {
    posAscentY += CONSTANTS.WALK_ANIM_SPEED * dt;
  }
  assertNear(posAscentY, 3.12 * 3.0, 0.1, 'Walks ~9.36m up ridge');

  // Phase 2: Crest ridge onto steep scree (55 degrees, Nz = 0.5736 < 0.664174)
  const screeSlopeRad = 55.0 * (Math.PI / 180.0);
  const screeNormal = { x: 0, y: Math.sin(screeSlopeRad), z: Math.cos(screeSlopeRad) };
  assertEquals(isWalkableSlope(screeNormal), false, '55-degree scree is non-walkable');

  // Slide begins: OnWalkable lost, slide acceleration pulls downhill along gradient (+Y descent)
  const slideAccel = calcSlopeSlideAcceleration(screeNormal, CONSTANTS.GRAVITY);
  assert(slideAccel.ay > 0, 'Tangential acceleration acts downhill');
  assert(slideAccel.az < 0, 'Acts downward');

  let slideVy = 0.0;
  let slideVz = 0.0;
  let slideSpeed = 0.0;
  let reachedSleddingThreshold = false;

  // Slide accelerates downhill for 60 ticks (2.0 seconds)
  for (let i = 0; i < 60; i++) {
    slideVy += slideAccel.ay * dt;
    slideVz += slideAccel.az * dt;
    slideSpeed = Math.sqrt(slideVy * slideVy + slideVz * slideVz);

    // Apply sledding friction if active
    if (slideSpeed >= CONSTANTS.SLEDDING_SPEED_THRESHOLD) {
      reachedSleddingThreshold = true;
      const v = calcFriction({ x: 0, y: slideVy, z: slideVz }, screeNormal, dt, true, 0.95);
      slideVy = v.y;
      slideVz = v.z;
    }
  }

  assert(reachedSleddingThreshold, 'Slide accelerated past 2.5 m/s entering low-friction sledding glide');
  assertInRange(slideSpeed, 6.0, 15.0, 'Attained high-speed mountain slide');

  // Phase 3: Transition onto flat valley basin (Nz = 1.0)
  const flatNormal = { x: 0, y: 0, z: 1.0 };
  assertEquals(isWalkableSlope(flatNormal), true, 'Basin floor is walkable');

  // Friction reverts to normal (0.95) and arrests slide
  let basinVy = slideSpeed;
  let basinTicks = 0;
  while (basinVy > 0 && basinTicks < 60) {
    basinTicks++;
    const v = calcFriction({ x: 0, y: basinVy, z: 0 }, flatNormal, dt, true, 0.95);
    basinVy = v.y;
  }

  assertEquals(basinVy, 0.0, 'Sledding slide safely halts to 0 m/s on flat basin floor');
  assert(basinTicks < 30, 'Halts rapidly within 1 second on flat ground');
});

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

module.exports = suite;
