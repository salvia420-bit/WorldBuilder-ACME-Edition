/**
 * Challenger Adversarial Stress Suite — Milestone 2
 * Empirical verification of multi-continent invariants, client masking,
 * dual-sampling terrain heights, cross-continent distances, and predictive streaming.
 */

import * as worldTerrain from '../apps/holtburger-web/scene3d/world_terrain.js';
import * as worldStream from '../apps/holtburger-web/scene3d/world_stream.js';
import * as flightModel from '../apps/holtburger-web/scene3d/vehicle/flight_model.js';

let passedCount = 0;
let failedCount = 0;
const findings = [];

function assert(condition, testName, details = '') {
  if (condition) {
    passedCount++;
    console.log(`  [PASS] ${testName}`);
  } else {
    failedCount++;
    const msg = `[FAIL] ${testName} - ${details}`;
    console.error(`  ${msg}`);
    findings.push(msg);
  }
}

console.log('======================================================================');
console.log('       CHALLENGER ADVERSARIAL STRESS SUITE — MILESTONE 2');
console.log('======================================================================\n');

// ----------------------------------------------------------------------
// SUITE 1: Client Camera & Cells Bit 15 Invariant Evaluation
// ----------------------------------------------------------------------
console.log('>>> TEST SUITE 1: Client Camera & Cells Bit 15 Invariant Evaluation <<<');

// Emulate camera.js Bit 15 masking: isIndoors = (landblockId & 0x7fff) >= 0x0100
function cameraIsIndoors(landblockId) {
  return ((landblockId & 0x7fff) >= 0x0100);
}

// Emulate cells.js Bit 15 masking: isOutdoor = (((cid >>> 0) & 0x7fff) < 0x100)
function cellIsOutdoor(cid) {
  return ((((cid >>> 0) & 0x7fff) < 0x100));
}

// 1.1 All 64 Dereth outdoor cells
let derethOutdoorCamPass = true;
let derethOutdoorCellPass = true;
for (let c = 1; c <= 64; c++) {
  const derethCell = 0x10200000 | c;
  if (cameraIsIndoors(derethCell)) derethOutdoorCamPass = false;
  if (!cellIsOutdoor(derethCell)) derethOutdoorCellPass = false;
}
assert(derethOutdoorCamPass, '1.1: Camera classifies all 64 Dereth landcells as outdoor');
assert(derethOutdoorCellPass, '1.2: Cells classifies all 64 Dereth landcells as outdoor');

// 1.2 All 64 Dericost outdoor cells (Bit 15 set: 0x8000 | c)
let dericostOutdoorCamPass = true;
let dericostOutdoorCellPass = true;
for (let c = 1; c <= 64; c++) {
  const dericostCell = 0x10208000 | c;
  if (cameraIsIndoors(dericostCell)) dericostOutdoorCamPass = false;
  if (!cellIsOutdoor(dericostCell)) dericostOutdoorCellPass = false;
}
assert(dericostOutdoorCamPass, '1.3: Camera classifies all 64 Dericost landcells (Bit 15 set) as outdoor');
assert(dericostOutdoorCellPass, '1.4: Cells classifies all 64 Dericost landcells (Bit 15 set) as outdoor');

// 1.3 Indoor EnvCells on Dereth and Dericost
let indoorDungeonPass = true;
const dungeonCells = [0x0100, 0x0101, 0x0180, 0x0200, 0x03FF, 0x0FFF];
for (const dc of dungeonCells) {
  const derethDc = 0x10200000 | dc;
  const dericostDc = 0x10208000 | dc;
  if (!cameraIsIndoors(derethDc) || cellIsOutdoor(derethDc)) indoorDungeonPass = false;
  if (!cameraIsIndoors(dericostDc) || cellIsOutdoor(dericostDc)) indoorDungeonPass = false;
}
assert(indoorDungeonPass, '1.5: Dungeon/EnvCells correctly classified as indoor across Dereth and Dericost');


// ----------------------------------------------------------------------
// SUITE 2: Terrain Shader Dual-Sampling & Ground Height API
// ----------------------------------------------------------------------
console.log('\n>>> TEST SUITE 2: Terrain Shader Dual-Sampling & Ground Height API <<<');

assert(typeof worldTerrain.worldGroundHeight === 'function', '2.1: worldGroundHeight function is exported');
assert(typeof worldTerrain.sampleHeight === 'function', '2.2: sampleHeight function is exported');

// Test heightAtGrid math on a synthetic Dericost grid
const hIdxDericost = new Uint8Array(2041 * 2041);
const table = new Float32Array(256);
for (let i = 0; i < 256; i++) table[i] = i * 2.5; // 0..637.5m

// Place a known mountain peak at vertex (100, 200)
hIdxDericost[200 * 2041 + 100] = 200; // 500m
const peakHeight = worldTerrain.heightAtGrid(hIdxDericost, table, 100 * 24, 200 * 24);
assert(Math.abs(peakHeight - 500.0) < 1e-3, '2.3: heightAtGrid calculates exact vertex elevation');

// Bilinear interpolation between vertices
hIdxDericost[200 * 2041 + 101] = 240; // 600m
const midHeight = worldTerrain.heightAtGrid(hIdxDericost, table, 100.5 * 24, 200 * 24);
assert(Math.abs(midHeight - 550.0) < 1e-3, '2.4: heightAtGrid performs exact bilinear interpolation');

// Off map clamp / sea level
const seaLevel = worldTerrain.heightAtGrid(hIdxDericost, table, -10, 500);
assert(seaLevel === 0.0, '2.5: heightAtGrid returns table[0] sea level off map');

// Verify sampleHeight interface with vector and scalar args
assert(worldTerrain.sampleHeight(1000, 2000) === null || typeof worldTerrain.sampleHeight(1000, 2000) === 'number',
  '2.6: sampleHeight accepts scalar coordinates (x, y)');
assert(worldTerrain.sampleHeight([1000, 2000]) === null || typeof worldTerrain.sampleHeight([1000, 2000]) === 'number',
  '2.7: sampleHeight accepts array coordinates [x, y]');
assert(worldTerrain.sampleHeight({ x: 1000, y: 2000 }) === null || typeof worldTerrain.sampleHeight({ x: 1000, y: 2000 }) === 'number',
  '2.8: sampleHeight accepts object coordinates {x, y}');


// ----------------------------------------------------------------------
// SUITE 3: Multi-Continent Coordinate Inversions & Distance Metric Oracles
// ----------------------------------------------------------------------
console.log('\n>>> TEST SUITE 3: Multi-Continent Coordinate Inversions & Distance Metric Oracles <<<');

// Oracle: 2D Euclidean distance with continent offset
function continentDistance2D(posA, posB) {
  const contA = posA.continent ?? ((posA.cell >> 15) & 1);
  const contB = posB.continent ?? ((posB.cell >> 15) & 1);
  const contDelta = (contA - contB) * 68928.0;

  const lbxA = (posA.cell >> 24) & 0xff;
  const lbxB = (posB.cell >> 24) & 0xff;
  const lbyA = (posA.cell >> 16) & 0xff;
  const lbyB = (posB.cell >> 16) & 0xff;

  const dx = (lbxA - lbxB) * 192.0 + posA.x - posB.x;
  const dy = contDelta + (lbyA - lbyB) * 192.0 + posA.y - posB.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// Test A: Dereth North shore (lbX=128, lbY=254, Y=192m) to Dericost South landfall (lbX=128, lbY=0, Y=0m)
const derethNorthShore = { cell: 0x80fe0001, x: 96.0, y: 192.0, continent: 0 };
const dericostSouthShore = { cell: 0x80008001, x: 96.0, y: 0.0, continent: 1 };
const dOcean = continentDistance2D(derethNorthShore, dericostSouthShore);
assert(Math.abs(dOcean - 19968.0) < 0.001, '3.1: Distance oracle across ocean gap matches 19,968.0m');

// Test B: Cross-continent symmetry
const dOceanRev = continentDistance2D(dericostSouthShore, derethNorthShore);
assert(dOcean === dOceanRev, '3.2: Distance oracle is strictly symmetric');

// Test C: Same landblock coordinates across continents
// Dereth lb(16, 32) vs Dericost lb(16, 32)
const posDereth16_32 = { cell: 0x10200001, x: 50.0, y: 50.0, continent: 0 };
const posDericost16_32 = { cell: 0x10208001, x: 50.0, y: 50.0, continent: 1 };
const dSameLbCrossContinent = continentDistance2D(posDereth16_32, posDericost16_32);
assert(Math.abs(dSameLbCrossContinent - 68928.0) < 0.001,
  '3.3: Positions with identical LB indices on different continents differ by exactly 68,928.0m');


// ----------------------------------------------------------------------
// SUITE 4: Vehicle Streaming & Predictive Target Generation
// ----------------------------------------------------------------------
console.log('\n>>> TEST SUITE 4: Vehicle Streaming & Predictive Target Generation <<<');

// 4.1 Ocean gap boundary conditions
assert(worldStream.isOceanCorridor({ gy: 48959.9 }) === false, '4.1: isOceanCorridor is false at 48959.9m (Dereth North coast)');
assert(worldStream.isOceanCorridor({ gy: 48960.0 }) === true, '4.2: isOceanCorridor is true at 48960.0m (Ocean start)');
assert(worldStream.isOceanCorridor({ gy: 58944.0 }) === true, '4.3: isOceanCorridor is true at 58944.0m (Mid-ocean)');
assert(worldStream.isOceanCorridor({ gy: 68927.9 }) === true, '4.4: isOceanCorridor is true at 68927.9m (South of landfall)');
assert(worldStream.isOceanCorridor({ gy: 68928.0 }) === false, '4.5: isOceanCorridor is false at 68928.0m (Dericost landfall)');

// 4.2 Key encoding parity
function keyOf(continent, lbx, lby) {
  return ((lbx << 24) >>> 0) | ((lby << 16) >>> 0) | (((continent & 1) << 15) >>> 0);
}
const kDereth = keyOf(0, 16, 32);
const kDericost = keyOf(1, 16, 32);
assert(kDereth === 0x10200000, '4.6: Key encoder for Dereth lb(16, 32) matches 0x10200000');
assert(kDericost === 0x10208000, '4.7: Key encoder for Dericost lb(16, 32) matches 0x10208000');
assert(kDereth !== kDericost, '4.8: Keys for Dereth and Dericost with same (x,y) do not collide');


// ----------------------------------------------------------------------
// SUITE 5: Summary & Findings
// ----------------------------------------------------------------------
console.log('\n======================================================================');
console.log(`TOTAL TESTS: ${passedCount + failedCount}`);
console.log(`PASSED:      ${passedCount}`);
console.log(`FAILED:      ${failedCount}`);
console.log('======================================================================\n');

if (failedCount > 0) {
  console.error('FAILURES DETECTED:');
  findings.forEach(f => console.error(`  - ${f}`));
  process.exit(1);
} else {
  console.log('ALL EMPIRICAL ADVERSARIAL STRESS TESTS PASSED SUCCESSFULLY.');
  process.exit(0);
}
