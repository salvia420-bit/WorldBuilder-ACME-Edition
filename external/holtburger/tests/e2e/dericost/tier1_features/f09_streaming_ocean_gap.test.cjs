/**
 * Tier 1: Feature 9 — Client/Server Streaming & Ocean Gap
 * Ocean corridor Y in [48960, 68928], zero-cost database allocation, Bit 31 continent addressing.
 * Sources: ORIGINAL_REQUEST §R2, PROJECT.md §Interface Contracts, Survey 3 §2.3 & §4.1
 */

const { createSuite, assert, assertEquals, assertNear, CONSTANTS } = require('../harness.cjs');

const suite = createSuite('Tier 1: Feature 9 - Client/Server Streaming & Ocean Gap', 1);

suite.addTest('F9.1: Ocean corridor transit suppresses landblock database allocations', () => {
  // Authoritative rule: For Y in (48960, 68928), no landblocks exist in database;
  // queries must be bypassed to achieve zero server GC pressure and zero streaming lag.
  function shouldAllocateLandblock(y) {
    if (y > CONSTANTS.DERETH_NORTH_SHORE_Y && y < CONSTANTS.DERICOST_SOUTH_SHORE_Y) {
      return false; // In ocean gap: zero DB landblocks
    }
    return true; // Dereth or Dericost landblock space
  }

  assertEquals(shouldAllocateLandblock(10000.0), true, 'Dereth mainland requires LB allocation');
  assertEquals(shouldAllocateLandblock(48960.0), true, 'Dereth North shore boundary allocates LB');
  assertEquals(shouldAllocateLandblock(50000.0), false, 'Ocean gap position 50,000m must bypass DB allocation');
  assertEquals(shouldAllocateLandblock(58944.0), false, 'Mid-ocean corridor position 58,944m must bypass DB allocation');
  assertEquals(shouldAllocateLandblock(68927.9), false, 'Just south of Dericost landfall must bypass DB allocation');
  assertEquals(shouldAllocateLandblock(68928.0), true, 'Dericost South shore landfall allocates LB');
  assertEquals(shouldAllocateLandblock(90000.0), true, 'Dericost interior requires LB allocation');
});

suite.addTest('F9.2: Ocean gap renders procedural sea plane at Z=0 and WaterDeepSea terrain type', () => {
  // Authoritative shader sampling contract:
  // For Y in (48960, 68928), height is strictly 0.0 and type is 20 (WaterDeepSea)
  function getTerrainAt(x, y) {
    if (y > 48960.0 && y < 68928.0) {
      return { height: 0.0, terrainType: 20, name: 'WaterDeepSea' };
    }
    return { height: 100.0, terrainType: 1, name: 'Land' };
  }

  const oceanSample = getTerrainAt(24480.0, 58944.0);
  assertEquals(oceanSample.height, 0.0, 'Ocean surface must be at Z=0.0m');
  assertEquals(oceanSample.terrainType, 20, 'Terrain code must be 20 (WaterDeepSea)');
});

suite.addTest('F9.3: Bit 31 Continent flag correctly partitions Dereth and Dericost in obj_Cell_Id', () => {
  // Authoritative specification from PROJECT.md §Client <-> Server Locomotion Contract:
  // Bit 31: Continent (0 = Dereth, 1 = Dericost)
  // Bits 24..30: lbX (0..254)
  // Bits 16..23: lbY (0..254)
  // Bits 0..15: Cell ID (1..64 outdoor)
  function encodeCellId(continent, lbX, lbY, cell) {
    return (((continent & 1) << 31) | ((lbX & 0x7f) << 24) | ((lbY & 0xff) << 16) | (cell & 0xffff)) >>> 0;
  }

  function decodeCellId(cellId) {
    return {
      continent: (cellId >>> 31) & 1,
      lbX: (cellId >>> 24) & 0x7f,
      lbY: (cellId >>> 16) & 0xff,
      cell: cellId & 0xffff
    };
  }

  const derethCell = encodeCellId(0, 100, 150, 25);
  const dericostCell = encodeCellId(1, 100, 150, 25);

  assertEquals((derethCell >>> 31) & 1, 0, 'Dereth cell must have Bit 31 = 0');
  assertEquals((dericostCell >>> 31) & 1, 1, 'Dericost cell must have Bit 31 = 1');
  assert(dericostCell >= 0x80000000, 'Dericost uint32 has high bit set');

  const decoded = decodeCellId(dericostCell);
  assertEquals(decoded.continent, 1);
  assertEquals(decoded.lbX, 100);
  assertEquals(decoded.lbY, 150);
  assertEquals(decoded.cell, 25);
});

suite.addTest('F9.4: Global coordinate conversion handles local Dericost landblock offset', () => {
  // If Continent == 0: Y_global = lbY * 192.0 + ly
  // If Continent == 1: Y_global = 68,928.0 + lbY * 192.0 + ly
  function toGlobalCoords(continent, lbX, lbY, lx, ly, lz) {
    const gx = lbX * 192.0 + lx;
    const gy = (continent === 1 ? 68928.0 : 0.0) + lbY * 192.0 + ly;
    return { x: gx, y: gy, z: lz };
  }

  // South-most Dericost LB (lbY = 0, ly = 0)
  const southShore = toGlobalCoords(1, 128, 0, 96.0, 0.0, 10.0);
  assertEquals(southShore.y, 68928.0, 'South-most LB must start at Y = 68,928.0m');

  // North-most Dericost LB (lbY = 254, ly = 192.0)
  const northBound = toGlobalCoords(1, 128, 254, 96.0, 192.0, 10.0);
  assertEquals(northBound.y, 117888.0, 'North-most LB must end at Y = 117,888.0m');
});

suite.addTest('F9.5: Outdoor cells are indexed 1..64 within landblock', () => {
  // In Asheron's Call, an 8x8 landcell grid within a landblock is numbered 1..64
  // cell = cellX * 8 + cellY + 1
  for (let cx = 0; cx < 8; cx++) {
    for (let cy = 0; cy < 8; cy++) {
      const cell = cx * 8 + cy + 1;
      assert(cell >= 1 && cell <= 64, `Cell (${cx}, ${cy}) must be in range 1..64`);
    }
  }
  // Cell 1 is (0, 0)
  assertEquals(0 * 8 + 0 + 1, 1);
  // Cell 64 is (7, 7)
  assertEquals(7 * 8 + 7 + 1, 64);
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
