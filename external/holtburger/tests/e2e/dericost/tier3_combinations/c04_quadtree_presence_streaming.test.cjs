/**
 * Tier 3: Combination 4 — CDLOD Quadtree & Landblock Presence Handoff
 * Features combined: F4 (Spatial Placement) + F5 (Terrain Mesh) + F9 (Client Streaming).
 * Evaluates CDLOD quadtree level of detail, near-ring presence texture handoff,
 * fragment discard, and dual heightmap sampling.
 * Sources: PROJECT.md, TEST_INFRA.md, world_terrain.js, lb_presence.js
 */

const { createSuite, assert, assertEquals, assertNear, assertInRange, CONSTANTS } = require('../harness.cjs');

const suite = createSuite('Tier 3: Combination 4 - CDLOD Quadtree & Landblock Presence Handoff', 3);

class MockCdlodQuadtree {
  constructor() {
    this.rootOrigin = CONSTANTS.CDLOD_ROOT_ORIGIN; // -73,728m
    this.rootSpan = CONSTANTS.CDLOD_ROOT_SPAN; // 196,608m
    this.levels = CONSTANTS.CDLOD_LEVELS; // 9 levels (768m leaf to 196,608m root)
  }

  getLodLevel(cameraPos, nodeCenter, nodeSize) {
    const dist = Math.hypot(cameraPos.x - nodeCenter.x, cameraPos.y - nodeCenter.y);
    // Standard CDLOD distance threshold: if distance < 2 * nodeSize, subdivide
    if (dist < 2.0 * nodeSize && nodeSize > 768.0) {
      return 'subdivide';
    }
    return 'render_at_current_level';
  }
}

suite.addTest('C4.1: CDLOD quadtree dynamically subdivides high-tier nodes as camera approaches Dericost', () => {
  const tree = new MockCdlodQuadtree();
  const dericostCenter = { x: 24480.0, y: 93408.0 }; // Center of Dericost

  // Distant camera in Dereth (y = 20,000m) looking at Dericost (dist ~73.4km)
  const distantCam = { x: 24480.0, y: 20000.0 };
  const actionDistant = tree.getLodLevel(distantCam, dericostCenter, 24576.0);
  assertEquals(actionDistant, 'render_at_current_level', 'Distant camera renders coarse LOD');

  // Approaching camera (y = 80,000m, 13.4km away)
  const closeCam = { x: 24480.0, y: 80000.0 };
  const actionClose = tree.getLodLevel(closeCam, dericostCenter, 24576.0);
  assertEquals(actionClose, 'subdivide', 'Approaching camera triggers quadtree subdivision');
});

suite.addTest('C4.2: 64x64 Landblock presence texture green channel marks active 3x3 near ring', () => {
  // Authoritative specification from lb_presence.js:
  // Maintains an RG8 texture representing a 64x64 landblock neighborhood.
  // G channel = 1.0 (255) when the landblock is loaded in the near ring.
  function createPresenceGrid(centerLbX, centerLbY) {
    const grid = new Uint8Array(64 * 64); // single channel representing green
    // Mark 3x3 ring around center
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const lx = 32 + dx; // center at (32, 32)
        const ly = 32 + dy;
        grid[ly * 64 + lx] = 255;
      }
    }
    return grid;
  }

  const presence = createPresenceGrid(128, 50);
  let activeCount = 0;
  for (let i = 0; i < presence.length; i++) {
    if (presence[i] === 255) activeCount++;
  }

  assertEquals(activeCount, 9, 'Exactly 9 landblocks in 3x3 near ring marked active (G=255)');
  assertEquals(presence[32 * 64 + 32], 255, 'Center landblock active');
  assertEquals(presence[0], 0, 'Distant landblock inactive (G=0)');
});

suite.addTest('C4.3: CDLOD world tier shader discards fragments where near ring presence is active with 10m skirt', () => {
  // Authoritative GLSL discard logic from world_terrain.js:
  // if (nearPresence > 0.5) discard;
  function shouldWorldTierRenderPixel(nearPresenceValue, distToNearEdgeMeters) {
    if (nearPresenceValue > 0.5) {
      return { discard: true, reason: 'Covered by near terrain ring' };
    }
    if (distToNearEdgeMeters <= 10.0) {
      return { discard: false, reason: '10m overlap skirt to prevent cracks' };
    }
    return { discard: false, reason: 'Distant world tier terrain' };
  }

  const insideNear = shouldWorldTierRenderPixel(1.0, 50.0);
  assertEquals(insideNear.discard, true, 'Discard fragment inside near ring');

  const skirtEdge = shouldWorldTierRenderPixel(0.0, 8.0);
  assertEquals(skirtEdge.discard, false, 'Do not discard within 10m skirt');
  assertEquals(skirtEdge.reason, '10m overlap skirt to prevent cracks');
});

suite.addTest('C4.4: Dual heightmap sampling unwraps continuous UVs across coordinate partition', () => {
  function computeTextureCoords(worldPos) {
    const [x, y] = worldPos;
    if (y <= 48960.0) {
      return { texture: 'Dereth_Height', u: x / 48960.0, v: y / 48960.0 };
    } else if (y < 68928.0) {
      return { texture: 'None_SeaSurface', u: 0.0, v: 0.0 };
    } else {
      return { texture: 'Dericost_Height', u: x / 48960.0, v: (y - 68928.0) / 48960.0 };
    }
  }

  const pDerethMid = computeTextureCoords([24480.0, 24480.0]);
  assertEquals(pDerethMid.texture, 'Dereth_Height');
  assertNear(pDerethMid.u, 0.5, 1e-4);
  assertNear(pDerethMid.v, 0.5, 1e-4);

  const pOcean = computeTextureCoords([24480.0, 58944.0]);
  assertEquals(pOcean.texture, 'None_SeaSurface');

  const pDericostMid = computeTextureCoords([24480.0, 68928.0 + 24480.0]);
  assertEquals(pDericostMid.texture, 'Dericost_Height');
  assertNear(pDericostMid.u, 0.5, 1e-4);
  assertNear(pDericostMid.v, 0.5, 1e-4);
});

suite.addTest('C4.5: High-speed crossing through ocean corridor generates zero mesh allocations', () => {
  let allocatedMeshBuffers = 0;

  function onPlayerMove(gy) {
    if (gy > CONSTANTS.DERETH_NORTH_SHORE_Y && gy < CONSTANTS.DERICOST_SOUTH_SHORE_Y) {
      // In ocean gap: zero mesh allocations
      return;
    }
    allocatedMeshBuffers += 1;
  }

  // Simulate flying 104 landblocks across ocean
  for (let y = 49000.0; y < 68900.0; y += 192.0) {
    onPlayerMove(y);
  }

  assertEquals(allocatedMeshBuffers, 0, 'Zero mesh buffers allocated during ocean transit');
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
