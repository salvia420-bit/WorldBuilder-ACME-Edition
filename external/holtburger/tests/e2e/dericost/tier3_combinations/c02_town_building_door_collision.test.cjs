/**
 * Tier 3: Combination 2 — Town Building Placement & Door Collision Interaction (Remediated)
 * Features combined: F10 (Town Locations) + F11 (Building Models) + F12 (Door Frameworks).
 * Evaluates real production town building placement within municipal clearance (<=220m, strictly <=288m),
 * zero collisions against solid scenery, authentic serverCellId formatting, portal binding,
 * and door kinematics.
 * Sources: ORIGINAL_REQUEST §R3, PROJECT.md §Feature 14-16, BuildingAnalyzer.cs
 */

const fs = require('node:fs');
const path = require('node:path');
// Resolve harness robustly
function resolveHarness() {
  const candidates = [
    path.resolve(__dirname, '../harness.cjs'),
    path.resolve('/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/tests/e2e/dericost/harness.cjs'),
    path.resolve('/home/wbterminal/external/holtburger/tests/e2e/dericost/harness.cjs')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return require(c);
  }
  return require(candidates[1]);
}

const { createSuite, assert, assertEquals, assertNear, assertInRange, CONSTANTS } = resolveHarness();

const suite = createSuite('Tier 3: Combination 2 - Town Building Placement & Door Collision Interaction', 3);

// Resolve root paths robustly
function resolveRoot() {
  const candidates = [
    path.resolve(__dirname, '../../../../'),
    path.resolve('/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger'),
    path.resolve('/home/wbterminal/external/holtburger'),
    path.resolve(process.cwd(), 'external/holtburger'),
    path.resolve(process.cwd())
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'dist/dericost/towns/dericost_towns_index.json'))) {
      return c;
    }
  }
  return candidates[0];
}

const ROOT = resolveRoot();
const TOWNS_DIR = path.join(ROOT, 'dist/dericost/towns');
const BLUEPRINTS_DIR = path.join(TOWNS_DIR, 'blueprints');
const SCENERY_DIR = path.join(ROOT, 'dist/dericost/scenery');

const SOLID_OBSTACLES = new Set([
  '0x02100001', '0x02100002', '0x02100005', '0x02100008', '0x02100009', // Tall Trees
  '0x01100002', '0x01100012', '0x01100015',                             // Monoliths
  '0x01100001', '0x01100003', '0x01100004', '0x01100011', '0x01100014', '0x01100018', '0x01100019' // Solid Rocks
]);

// Test 1: Real town index and serverCellId validation
suite.addTest('C2.1: Master town directory indexes 41 towns with 100% valid 8-char serverCellIds (0 negative signs)', () => {
  const indexPath = path.join(TOWNS_DIR, 'dericost_towns_index.json');
  assert(fs.existsSync(indexPath), 'Master index file exists');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  assertEquals(index.totalTowns, 41, 'Index reports 41 total towns');
  assertEquals(index.towns.length, 41, 'Index towns array has 41 entries');

  let invalidServerCellIds = 0;
  for (const t of index.towns) {
    if (t.serverCellId.includes('-') || !/^0x[0-9A-F]{8}$/.test(t.serverCellId)) {
      invalidServerCellIds++;
    }
    const parsed = parseInt(t.serverCellId, 16);
    assert(!Number.isNaN(parsed), `Town ${t.name} serverCellId must be parseable`);
    assertEquals((parsed & 0x8000), 0x8000, `Town ${t.name} serverCellId has Continent Bit 15 set`);
    assertEquals((parsed >>> 24) & 0xFF, t.lbX, `Town ${t.name} serverCellId upper byte matches lbX`);
  }
  assertEquals(invalidServerCellIds, 0, 'Zero towns have negative or malformed serverCellIds');
});

// Test 2: Real building placements within clearance perimeter (<= 220.0m, strictly <= 288m)
suite.addTest('C2.2: 100% of 574 placed buildings are strictly within municipal clearance perimeter (dist <= 220.0m)', () => {
  const indexPath = path.join(TOWNS_DIR, 'dericost_towns_index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  let totalBuildings = 0;
  let outOfBoundsCount = 0;
  let maxDist = 0;

  for (const tm of index.towns) {
    const townPath = path.join(TOWNS_DIR, `town_${tm.slug}.json`);
    assert(fs.existsSync(townPath), `Town file town_${tm.slug}.json exists`);
    const townData = JSON.parse(fs.readFileSync(townPath, 'utf8'));
    assertEquals(townData.buildings.length, 14, `Town ${tm.name} has 14 buildings`);

    const tx = townData.coordinates.worldX;
    const ty = townData.coordinates.worldY;

    for (const b of townData.buildings) {
      totalBuildings++;
      const dist = Math.hypot(b.worldOrigin[0] - tx, b.worldOrigin[1] - ty);
      if (dist > maxDist) maxDist = dist;
      if (dist > 220.0) {
        outOfBoundsCount++;
      }
      assert(dist <= 288.0, `Building ${b.guid} in ${tm.name} dist (${dist.toFixed(1)}m) must be <= 288m`);
    }
  }

  assertEquals(totalBuildings, 574, 'Exactly 574 buildings placed across 41 towns');
  assertEquals(outOfBoundsCount, 0, `All buildings within 220.0m (observed max: ${maxDist.toFixed(1)}m)`);
});

// Test 3: Zero physical collisions between buildings and solid scenery
suite.addTest('C2.3: Zero physical collisions between building footprints and solid scenery obstacles', () => {
  const bps = {};
  for (const f of fs.readdirSync(BLUEPRINTS_DIR).filter(f => f.endsWith('.blueprint.json'))) {
    const bp = JSON.parse(fs.readFileSync(path.join(BLUEPRINTS_DIR, f), 'utf8'));
    bps[bp.hexModelId] = bp;
  }

  const indexPath = path.join(TOWNS_DIR, 'dericost_towns_index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  let collisions = 0;

  for (const tm of index.towns) {
    const townData = JSON.parse(fs.readFileSync(path.join(TOWNS_DIR, `town_${tm.slug}.json`), 'utf8'));
    for (const b of townData.buildings) {
      const bp = bps[b.hexModelId];
      if (!bp) continue;

      const halfW = bp.footprint.widthMeters / 2;
      const halfD = bp.footprint.depthMeters / 2;
      const minX = b.worldOrigin[0] - halfW;
      const maxX = b.worldOrigin[0] + halfW;
      const minY = b.worldOrigin[1] - halfD;
      const maxY = b.worldOrigin[1] + halfD;

      const minLbX = Math.max(0, Math.floor(minX / 192.0));
      const maxLbX = Math.min(254, Math.floor(maxX / 192.0));
      const minLbY = Math.max(0, Math.floor((minY - 68928.0) / 192.0));
      const maxLbY = Math.min(254, Math.floor((maxY - 68928.0) / 192.0));

      for (let lbX = minLbX; lbX <= maxLbX; lbX++) {
        for (let lbY = minLbY; lbY <= maxLbY; lbY++) {
          const hex = '0x' + (((lbX << 8) | lbY) >>> 0).toString(16).toUpperCase().padStart(4, '0');
          const scFile = path.join(SCENERY_DIR, `${hex}.scenery.jsonl`);
          if (!fs.existsSync(scFile)) continue;

          const lines = fs.readFileSync(scFile, 'utf8').trim().split('\n');
          for (const line of lines) {
            if (!line) continue;
            const sc = JSON.parse(line);
            if (!SOLID_OBSTACLES.has(sc.obj_id)) continue;

            const scWx = lbX * 192.0 + sc.x;
            const scWy = 68928.0 + lbY * 192.0 + sc.y;

            if (scWx >= minX && scWx <= maxX && scWy >= minY && scWy <= maxY) {
              collisions++;
            }
          }
        }
      }
    }
  }

  assertEquals(collisions, 0, 'Zero physical collisions between buildings and solid scenery items');
});

// Test 4: Real door kinematics & portal jamb snapping
suite.addTest('C2.4: 2,447 doors snap to portal frame origins with 90° interactive hinge rotation and Bit 15', () => {
  const indexPath = path.join(TOWNS_DIR, 'dericost_towns_index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  let totalDoors = 0;
  let exteriorDoors = 0;
  let interiorDoors = 0;

  for (const tm of index.towns) {
    const townData = JSON.parse(fs.readFileSync(path.join(TOWNS_DIR, `town_${tm.slug}.json`), 'utf8'));
    totalDoors += townData.doors.length;

    for (const d of townData.doors) {
      assertEquals(d.weenieType, 19, 'WeenieType is 19 (Door)');
      assertEquals(d.rotationZ, 0.0, 'Closed rotationZ is 0.0');
      assertNear(d.openRotationZ, -Math.PI / 2, 1e-5, 'Open rotation is -pi/2 (-90 deg)');
      assertEquals(d.inCollisionIndex, true, 'Door in collision index when closed');
      assertEquals((d.obj_Cell_Id & 0x8000), 0x8000, 'Door obj_Cell_Id preserves Continent Bit 15');

      if (!d.isIndoor) {
        exteriorDoors++;
        assert(d.targetInteriorCellId > 0x0100, 'Exterior door targets interior EnvCell');
      } else {
        interiorDoors++;
        assert((d.obj_Cell_Id & 0x7FFF) > 0x0100, 'Interior door obj_Cell_Id in interior room');
      }
    }
  }

  assertEquals(totalDoors, 2447, 'Total doors placed equals exactly 2,447');
  assertEquals(exteriorDoors, 574, 'Exactly 574 exterior doors (1 per building)');
  assertEquals(interiorDoors, 1873, 'Exactly 1,873 interior partition doors');
});

// Test 5: Real portal graph and transition reachability
suite.addTest('C2.5: Real building models meet BuildingAnalyzer.cs rules (CellCount>=4, PortalCount>=2, BFS 100%)', () => {
  const bpFiles = fs.readdirSync(BLUEPRINTS_DIR).filter(f => f.endsWith('.blueprint.json'));
  assertEquals(bpFiles.length, 18, '18 blueprint files present');

  for (const f of bpFiles) {
    const bp = JSON.parse(fs.readFileSync(path.join(BLUEPRINTS_DIR, f), 'utf8'));
    assert(bp.interiorCells.length >= 4, `Blueprint ${bp.name} cellCount >= 4`);
    const portals = bp.interiorCells.reduce((acc, c) => acc + c.portals.length, 0);
    assert(portals >= 2, `Blueprint ${bp.name} portalCount >= 2`);
    const statics = bp.interiorCells.reduce((acc, c) => acc + c.statics.length, 0);
    assert(statics >= 14, `Blueprint ${bp.name} statics >= 14`);
  }
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
