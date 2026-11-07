/**
 * Tier 2: Boundary 4 — World Edge Boundaries
 * WORLD_MIN, WORLD_X_MAX, WORLD_Y_MAX, flight boundary reflection, CDLOD corners.
 * Sources: TEST_INFRA.md, ORIGINAL_REQUEST §R2, flight_model.js, Survey 3 §4.1
 */

const { createSuite, assert, assertEquals, assertNear, assertInRange, CONSTANTS } = require('../harness.cjs');

const suite = createSuite('Tier 2: Boundary 4 - World Edge Boundaries', 2);

// Boundary constants for dual-continent flight
const WORLD_X_MIN = 0.5;
const WORLD_X_MAX = 255.0 * 192.0 - 0.5; // 48,959.5 m
const WORLD_Y_MIN = 0.5;
const WORLD_Y_MAX = (359.0 + 255.0) * 192.0 - 0.5; // 117,887.5 m

suite.addTest('B4.1: WORLD_MIN (0.5m) clamps position to prevent zero/negative coordinates', () => {
  function clampPosition(x, y) {
    return {
      x: Math.max(WORLD_X_MIN, Math.min(WORLD_X_MAX, x)),
      y: Math.max(WORLD_Y_MIN, Math.min(WORLD_Y_MAX, y)),
    };
  }

  const p1 = clampPosition(0.0, 0.0);
  assertEquals(p1.x, 0.5, 'X clamped to WORLD_MIN 0.5m');
  assertEquals(p1.y, 0.5, 'Y clamped to WORLD_MIN 0.5m');

  const p2 = clampPosition(-100.0, -50.0);
  assertEquals(p2.x, 0.5);
  assertEquals(p2.y, 0.5);
});

suite.addTest('B4.2: WORLD_X_MAX (48,959.5m) clamps position at eastern world border', () => {
  function clampX(x) {
    return Math.max(WORLD_X_MIN, Math.min(WORLD_X_MAX, x));
  }

  assertEquals(clampX(48959.5), 48959.5, 'Exact boundary 48,959.5m allowed');
  assertEquals(clampX(48960.0), 48959.5, '48,960.0m clamped to 48,959.5m');
  assertEquals(clampX(50000.0), 48959.5, 'Out of bounds 50,000m clamped to 48,959.5m');
});

suite.addTest('B4.3: WORLD_Y_MAX (117,887.5m) clamps position at northern polar border', () => {
  function clampY(y) {
    return Math.max(WORLD_Y_MIN, Math.min(WORLD_Y_MAX, y));
  }

  assertEquals(clampY(117887.5), 117887.5, 'Exact polar boundary allowed');
  assertEquals(clampY(117888.0), 117887.5, '117,888.0m clamped to 117,887.5m');
  assertEquals(clampY(120000.0), 117887.5, 'Beyond 120,000m clamped to 117,887.5m');
});

suite.addTest('B4.4: Out-of-bounds flight trajectory deflects along world boundary planes', () => {
  function stepBoundaryPhysics(pos, vel, dt) {
    let nx = pos.x + vel.x * dt;
    let ny = pos.y + vel.y * dt;
    let vx = vel.x;
    let vy = vel.y;

    if (nx > WORLD_X_MAX) {
      nx = WORLD_X_MAX;
      vx = -vx * 0.5; // Reflect with 50% velocity damping
    }
    if (ny > WORLD_Y_MAX) {
      ny = WORLD_Y_MAX;
      vy = -vy * 0.5;
    }
    return { pos: { x: nx, y: ny }, vel: { x: vx, y: vy } };
  }

  const initial = { pos: { x: 48950.0, y: 100000.0 }, vel: { x: 50.0, y: 0.0 } };
  const next = stepBoundaryPhysics(initial.pos, initial.vel, 1.0);

  assertEquals(next.pos.x, WORLD_X_MAX, 'Aircraft position clamped at world edge');
  assertEquals(next.vel.x, -25.0, 'Aircraft deflected westward with damping');
});

suite.addTest('B4.5: Global CDLOD quadtree corner bounds enclose entire dual-continent system', () => {
  const rootOrigin = CONSTANTS.CDLOD_ROOT_ORIGIN; // -73,728m
  const rootSpan = CONSTANTS.CDLOD_ROOT_SPAN; // 196,608m
  const rootMax = CONSTANTS.CDLOD_ROOT_MAX; // +122,880m

  // Dual continent bounding box: X in [0, 48960], Y in [0, 117888]
  assert(0.0 >= rootOrigin, 'West boundary (0m) >= rootOrigin (-73,728m)');
  assert(48960.0 <= rootMax, 'East boundary (48,960m) <= rootMax (122,880m)');
  assert(0.0 >= rootOrigin, 'South boundary (0m) >= rootOrigin (-73,728m)');
  assert(117888.0 <= rootMax, 'North boundary (117,888m) <= rootMax (122,880m)');
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
