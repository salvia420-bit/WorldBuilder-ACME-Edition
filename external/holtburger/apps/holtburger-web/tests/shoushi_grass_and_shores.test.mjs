// tests/shoushi_grass_and_shores.test.mjs — Comprehensive unit test suite for:
//   - Bug 2A: Shoushi (0xDA55) hollow L-shaped courtyard walls (0x01000E62, 0x01000E77),
//             perimeter walls (0x01000E61, 0x01000E65), THREE.LOD portal pad (0x020019E3),
//             and 300+ EnvCell ground-band + nearest-first player-centred sorting.
//   - Bug 2B: Sealed-dungeon exit (Town Network -> Shoushi) terrain ring unfreeze race
//             in world_stream.js + stationary (d === 0) post-teleport scatter healing.
//   - Item 3: Performant grass variety across large tracts of land (domain-rotated 96m/36m
//             macro meadow waves, topographic slope/sun-aspect micro-climate, ~8% tall rye/seed
//             culms, ~4% lush clover/wildflower accent tufts, per-blade posture/arch variety,
//             0 extra draw calls, 0 texture lookups).
//   - Item 6A: Ocean coastline (starfish & seashells) and river shore (flow-aligned washed-ashore
//              driftwood logs) classification + procedural instanced scatter pools.
//   - Item 6B: Palm trees & coastal flora GPU treesway (descriptor signal parsing, single-part
//              foliage-pollen & 19 explicit palm/coastal DIDs, progressive 0..30m cantilever
//              curve + radial frond-tip breeze flutter).
//
// Run from apps/holtburger-web/:
//   node tests/shoushi_grass_and_shores.test.mjs

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

import {
  analyzeGeometryFootprint,
  createInteriorMask,
  STATIC_FOOTPRINT_MAX_Z,
  BUILDING_FOOTPRINT_MAX_Z,
  HOLLOW_FOOTPRINT_FILL_MAX,
} from "../scene3d/grass_interior_mask.js";
import { createWorldStreamer } from "../scene3d/world_stream.js";
import { createScatterPool } from "../scene3d/terrain_scatter.js";
import {
  injectTerrainGrassShader,
  evalGrassMacroLush,
  evalGrassMacroHeight,
  evalGrassSeedDrift,
  evalGrassBladeArch,
  evalGrassBotanicalProfile,
} from "../scene3d/terrain_grass.js";
import {
  createTerrainOracle,
  oceanShoreAt,
  riverShoreAt,
  waterFlowAt,
  sampleWaterFlowTableAt,
  isSeaWaterCode,
  SEA_WATER_CODES,
} from "../scene3d/terrain_oracle.js";
import { parseWaterFlowTable } from "../scene3d/terrain_water_flow.js";
import { lbKeyFromXY } from "../scene3d/landblock_lru.js";
import { FAM_GRASS } from "../scene3d/terrain_families.js";
import {
  SHORE_TUNING,
  STARFISH_PALETTE,
  SEASHELL_PALETTE,
  DRIFTWOOD_PALETTE,
  SHORE_VERTEX_GLSL,
  SHORE_FRAGMENT_GLSL,
  starfishMeshData,
  seashellMeshData,
  driftwoodLogMeshData,
  buildStarfishGeometry,
  buildSeashellGeometry,
  buildDriftwoodLogGeometry,
  shoreBasis,
  createStarfishField,
  createSeashellField,
  createDriftwoodField,
  initShoreScatter,
  shoreScatterStats,
  _resetShoreScatter,
} from "../scene3d/terrain_shore.js";
import {
  initTerrainVfx,
  terrainVfxTick,
  terrainVfxStats,
  _resetTerrainVfx,
} from "../scene3d/terrain_vfx.js";
import {
  PALM_COASTAL_WIND_DIDS,
  isPalmOrCoastalWindDid,
  isTreeDid,
  _resetTreeWindFlags,
} from "../scene3d/tree_wind.js";
import {
  parseDescriptorSignals,
  parseDescriptorsJsonl,
  setVfxCatalog,
  _resetVfxCatalog,
  hasWindBend,
  windResponds,
  windRespondsGpu,
} from "../scene3d/vfx_catalog.js";
import {
  fragEntriesForDescriptor,
  fragPlanForDid,
  isFragDid,
} from "../scene3d/vfx/frag_attach.js";
import {
  windSwayGpu,
  evalWindSwayGpuVertex,
} from "../scene3d/vfx/components/windSwayGpu.js";
import { lintSource } from "../scene3d/vfx/lint_caps.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(__dirname, "..");

let passed = 0;
let failed = 0;

function check(label, cond, detail = "") {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    // eslint-disable-next-line no-console
    console.error(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  // eslint-disable-next-line no-console
  console.log(`\n-- ${title} --`);
}

/** Build an axis-aligned box BufferGeometry spanning [x0..x1] x [y0..y1] x [z0..z1] in AC Z-up local space. */
function makeBoxBuffer(x0, x1, y0, y1, z0, z1) {
  const w = x1 - x0;
  const d = y1 - y0;
  const h = z1 - z0;
  const g = new THREE.BoxGeometry(w, d, h);
  g.translate((x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5);
  return g;
}

/** Merge an array of non-indexed or indexed BufferGeometries into one BufferGeometry. */
function mergeBoxGeometries(geoms) {
  const posList = [];
  for (const g of geoms) {
    const nonIdx = g.index ? g.toNonIndexed() : g;
    const arr = nonIdx.getAttribute("position").array;
    for (let i = 0; i < arr.length; i += 1) posList.push(arr[i]);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(new Float32Array(posList), 3));
  return out;
}

/** Standard AC worldRoot (rotates AC +Z-up into Three +Y-up: rotation.x = -PI/2). */
function makeAcWorldRoot() {
  const root = new THREE.Group();
  root.rotation.x = -Math.PI / 2;
  root.updateMatrixWorld(true);
  return root;
}

// ============================================================================
// 1. Bug 2A — Shoushi (0xDA55) Hollow L-Walls, LOD Portal Pad & 300+ EnvCells
// ============================================================================
section("Bug 2A: Shoushi L-walls (0x01000E62 / 0x01000E77), LOD portal pad & EnvCell ground sort");
{
  // Shoushi 0x01000E62 L-shaped stone courtyard corner wall:
  // Outer span 20.5m x 20.5m, wall thickness 1.0m along the south (y: 0..1.0) and west (x: 0..1.0)
  // edges, enclosing an open 19.5m x 19.5m grassy courtyard!
  const lWallGeom = mergeBoxGeometries([
    makeBoxBuffer(0.0, 20.5, 0.0, 1.0, 0.0, 3.2), // South wall arm (20.5m x 1.0m)
    makeBoxBuffer(0.0, 1.0, 1.0, 20.5, 0.0, 3.2), // West wall arm (1.0m x 19.5m)
  ]);

  const fp1 = analyzeGeometryFootprint(lWallGeom, BUILDING_FOOTPRINT_MAX_Z);
  const fp2 = analyzeGeometryFootprint(lWallGeom, BUILDING_FOOTPRINT_MAX_Z);
  check("analyzeGeometryFootprint memoizes in geometry.userData.__grassFootprintBoxes",
    fp1 === fp2 && Array.isArray(fp1) && lWallGeom.userData.__grassFootprintBoxes === fp1);
  check("Shoushi 20.5m L-wall has fillFraction < 0.55 and is classified hollow",
    fp1.fillFraction < HOLLOW_FOOTPRINT_FILL_MAX && fp1.every((b) => b.hollowArm === true),
    `fillFraction=${fp1.fillFraction.toFixed(3)}`);
  check("Shoushi L-wall decomposes into 1..4 tight wall-arm sub-boxes (never 1 giant yard box)",
    fp1.length >= 2 && fp1.length <= 4,
    `boxes=${fp1.length}`);

  // Place this L-wall right beside Shoushi's Town Network portal (41922.2, 16412.3, 20.0),
  // held out in buildingsGroup (unbatched / BC7_PENDING path).
  const worldRoot = makeAcWorldRoot();
  const buildingsGroup = new THREE.Group();
  const staticsGroup = new THREE.Group();
  worldRoot.add(buildingsGroup);
  worldRoot.add(staticsGroup);

  const lWallMesh = new THREE.Mesh(lWallGeom, new THREE.MeshBasicMaterial());
  lWallMesh.position.set(41914.0, 16404.0, 20.0);
  buildingsGroup.add(lWallMesh);

  // Also place a solid 10m x 8m shop building at (41960, 16410, 20) to verify solid buildings STILL mask interior!
  const shopGeom = makeBoxBuffer(0, 10, 0, 8, 0, 4.5);
  const shopFp = analyzeGeometryFootprint(shopGeom, BUILDING_FOOTPRINT_MAX_Z);
  check("Solid rectangular shop building has fillFraction >= 0.55 (not hollow)",
    shopFp.length === 1 && shopFp[0].hollowArm === false && shopFp.fillFraction >= 0.9);
  const shopMesh = new THREE.Mesh(shopGeom, new THREE.MeshBasicMaterial());
  shopMesh.position.set(41960.0, 16410.0, 20.0);
  buildingsGroup.add(shopMesh);

  // Place Shoushi's THREE.LOD portal pad (0x020019E3): 8.5m x 8.5m ground pad (z=0..0.35m)
  // WITH a wide 16m x 16m overhead energy/stone ring at z=2.4..5.5m AND a coarse LOD[1] proxy!
  const portalLod0Geom = mergeBoxGeometries([
    makeBoxBuffer(-4.25, 4.25, -4.25, 4.25, 0.0, 0.35),   // 8.5m ground pad (z <= 0.8m)
    makeBoxBuffer(-8.0, 8.0, -8.0, 8.0, 2.4, 5.5),         // Overhead arch/canopy (z > 0.8m -> ignored!)
  ]);
  const portalLod1ProxyGeom = makeBoxBuffer(-12.0, 12.0, -12.0, 12.0, 0.0, 5.5); // Coarse proxy -> ignored!
  const portalLod = new THREE.LOD();
  portalLod.position.set(41895.0, 16412.0, 20.0);
  portalLod.addLevel(new THREE.Mesh(portalLod0Geom, new THREE.MeshBasicMaterial()), 0);
  portalLod.addLevel(new THREE.Mesh(portalLod1ProxyGeom, new THREE.MeshBasicMaterial()), 80);
  staticsGroup.add(portalLod);

  // Place an alpha-cutout tree/bush and a thin fence in staticsGroup -> both must be skipped!
  const bushMat = new THREE.MeshBasicMaterial({ alphaTest: 0.5 });
  const bushMesh = new THREE.Mesh(makeBoxBuffer(-3, 3, -3, 3, 0, 4), bushMat);
  bushMesh.position.set(41925.0, 16415.0, 20.0);
  staticsGroup.add(bushMesh);

  const fenceMesh = new THREE.Mesh(makeBoxBuffer(0, 6.0, 0, 0.20, 0, 1.4), new THREE.MeshBasicMaterial());
  fenceMesh.position.set(41920.0, 16420.0, 20.0);
  staticsGroup.add(fenceMesh);

  worldRoot.updateMatrixWorld(true);

  const mask = createInteriorMask({ gpu: true, THREE });
  const scene3d = {
    worldRoot,
    buildingsGroup,
    staticsGroup,
    cellContainers3d: new Map(),
  };
  mask.setGpuCenter(41922.2, 16412.3, 20.0, 200);
  mask.sync(scene3d);

  // Open grassy yard inside L-wall (41922.2, 16412.3, 20.0) MUST NOT be masked!
  check("Open grassy yard inside Shoushi L-wall is NOT masked (CPU contains)",
    mask.contains(41922.2, 16412.3, 20.1) === false);
  check("Open grassy yard inside Shoushi L-wall is NOT masked (GPU mirror)",
    mask.gpuContainsMirror(41922.2, 16412.3, 20.1) === false);
  check("Deep corner of open courtyard (41930, 16418) is NOT masked",
    mask.contains(41930.0, 16418.0, 20.1) === false &&
    mask.gpuContainsMirror(41930.0, 16418.0, 20.1) === false);

  // Stone wall arms themselves ARE masked!
  check("South stone arm of L-wall (41922.0, 16404.5, 20.1) IS masked (CPU + GPU)",
    mask.contains(41922.0, 16404.5, 20.1) === true &&
    mask.gpuContainsMirror(41922.0, 16404.5, 20.1) === true);
  check("West stone arm of L-wall (41914.5, 16414.0, 20.1) IS masked (CPU + GPU)",
    mask.contains(41914.5, 16414.0, 20.1) === true &&
    mask.gpuContainsMirror(41914.5, 16414.0, 20.1) === true);

  // Solid shop interior IS masked!
  check("Solid shop interior (41965.0, 16414.0, 20.1) IS masked (CPU + GPU)",
    mask.contains(41965.0, 16414.0, 20.1) === true &&
    mask.gpuContainsMirror(41965.0, 16414.0, 20.1) === true);

  // Portal LOD pad: inside 8.5m pad IS masked, but under the 16m overhead canopy (at +6.0m from center) is NOT masked!
  const padFp = analyzeGeometryFootprint(portalLod0Geom, STATIC_FOOTPRINT_MAX_Z);
  check("Portal LOD[0] ground footprint ignores z > 0.8m overhead canopy",
    Math.abs(padFp.dx - 8.5) < 1e-3 && Math.abs(padFp.dy - 8.5) < 1e-3);
  check("Center of portal pad (41895.0, 16412.0, 20.1) IS masked",
    mask.contains(41895.0, 16412.0, 20.1) === true);
  check("Grass 6m from portal center (under 16m overhead canopy & 24m LOD[1] proxy) is NOT masked",
    mask.contains(41901.0, 16412.0, 20.1) === false &&
    mask.gpuContainsMirror(41901.0, 16412.0, 20.1) === false);

  // Foliage & fence skipped:
  check("Alpha-cutout foliage in staticsGroup does NOT mask grass",
    mask.contains(41925.0, 16415.0, 20.1) === false);
  check("Thin fence in staticsGroup does NOT mask grass",
    mask.contains(41923.0, 16420.1, 20.1) === false);

  // Now test 370+ EnvCells (exceeding Shoushi's 303 EnvCells) with upper-storey & basement rooms
  // streamed in FARTHEST-FIRST Map order, plus ground oracle at z = 20.0m!
  const cellMap = new Map();
  const roomGeom = makeBoxBuffer(-2.0, 2.0, -2.0, 2.0, 0.0, 3.0);
  function makeCellContainer(x, y, z) {
    const container = new THREE.Group();
    container.position.set(x, y, z);
    const mg = new THREE.Group();
    mg.name = "mesh-structure";
    mg.add(new THREE.Mesh(roomGeom, new THREE.MeshBasicMaterial()));
    container.add(mg);
    worldRoot.add(container);
    return container;
  }
  // Insert 280 upper-storey rooms (z = 26.5m) & basements (z = 11m) + 90 far ground rooms FIRST
  let cellIdSeq = 0xda550100;
  for (let i = 0; i < 140; i += 1) {
    cellMap.set(cellIdSeq++, makeCellContainer(41922.2 + (i % 14) * 5.0, 16412.3 + Math.floor(i / 14) * 5.0, 26.5));
    cellMap.set(cellIdSeq++, makeCellContainer(41922.2 + (i % 14) * 5.0, 16412.3 + Math.floor(i / 14) * 5.0, 11.0));
  }
  for (let i = 0; i < 90; i += 1) {
    cellMap.set(cellIdSeq++, makeCellContainer(42060.0 + (i % 10) * 6.0, 16520.0 + Math.floor(i / 10) * 6.0, 20.0));
  }
  // Insert the NEAREST ground-level Shoushi room LAST in Map order (at 41928, 16412, z=20):
  cellMap.set(cellIdSeq++, makeCellContainer(41928.0, 16412.0, 20.0));
  worldRoot.updateMatrixWorld(true);

  const flatOracle = {
    version: () => 1,
    heightAt: () => 20.0,
  };
  const townMask = createInteriorMask({ gpu: true, THREE, oracle: flatOracle });
  townMask.setGpuCenter(41922.2, 16412.3, 20.0, 200);
  townMask.sync({ worldRoot, cellContainers3d: cellMap });

  check("370+ EnvCells: nearby ground-level room inserted LAST in Map order is retained on GPU & CPU",
    townMask.contains(41928.0, 16412.0, 20.1) === true &&
    townMask.gpuContainsMirror(41928.0, 16412.0, 20.1) === true);
  check("Upper-storey (z=26.5m) & basement (z=11m) EnvCells do not mask ground grass at z=20.0m",
    townMask.contains(41922.2, 16412.3, 20.0) === false &&
    townMask.gpuContainsMirror(41922.2, 16412.3, 20.0) === false);
}

// ============================================================================
// 2. Bug 2B — Sealed-Dungeon Exit Race (world_stream.js) & Stationary Scatter Heal
// ============================================================================
section("Bug 2B: Town Network -> Shoushi sealed-dungeon exit race & stationary scatter heal");
{
  let ringLoads = 0;
  let sawUnfrozenBeforeLoad = false;
  let simulateTransientFreezeOnce = true;

  const mockScene3d = {
    _sealedEvictLbKey: 0x01230000, // Still set from Town Network / sealed dungeon!
    _fixedGridSealedFrozen: true,
    _fixedGrid: { center: { x: 1, y: 2 } },
    loadTerrainForLandblock() {},
    loadTerrainRing(_lbX, _lbY) {
      // Verify world_stream cleared _sealedEvictLbKey & _fixedGridSealedFrozen BEFORE calling loadTerrainRing!
      if (this._sealedEvictLbKey === 0 && this._fixedGridSealedFrozen === false && this._fixedGrid.center === null) {
        sawUnfrozenBeforeLoad = true;
      }
      ringLoads += 1;
      if (simulateTransientFreezeOnce) {
        // Simulate another hook re-freezing on the first call to verify retry unlatch!
        this._fixedGridSealedFrozen = true;
        simulateTransientFreezeOnce = false;
      }
    },
    loadStaticsForLandblock() { return Promise.resolve(); },
    loadBuildingsForLandblock() { return Promise.resolve(); },
    loadEnvCellsForLandblock() { return Promise.resolve(); },
  };

  const streamer = createWorldStreamer({
    getLocalPlayerGuid: () => 0x50000001,
    emitLandblockChanged: () => {},
    ensureTerrainAroundLandblock: () => {},
    ensureBuildingAabbsAroundLandblock: () => {},
    ensureCellContainersForLandblock: () => {},
    ensureLandblockObjectsForLandblock: () => {},
    getLiveScene3d: () => mockScene3d,
    terrainPrefetchedLbs: new Set(),
    buildingAabbsPopulatedLbs: new Set(),
    cellContainersPopulatedLbs: new Set(),
    objectsRenderAddedLbs: new Set(),
  });

  // Player portals from Town Network into Shoushi outdoor cell 0xDA55000E and stands still:
  const posPacket = { guid: 0x50000001, landblockId: 0xda55000e, x: 41922.2, y: 16412.3, z: 20.0 };
  streamer.onPositionUpdate(posPacket);
  check("world_stream clears _sealedEvictLbKey, _fixedGridSealedFrozen & _fixedGrid.center BEFORE loadTerrainRing",
    sawUnfrozenBeforeLoad === true);
  check("First outdoor tick invoked loadTerrainRing", ringLoads === 1);

  // Next position echo while standing completely still on the exact same landblock (0xDA55000E):
  // Because the first call simulated _fixedGridSealedFrozen = true, lastRingLb was unlatched so it retries!
  streamer.onPositionUpdate(posPacket);
  check("Unlatched lastRingLb retries loadTerrainRing on next stationary outdoor tick", ringLoads === 2);

  // Subsequent stationary tick now stays latched (no redundant ring spam once unfrozen):
  streamer.onPositionUpdate(posPacket);
  check("Once unfrozen, stationary outdoor ticks do not spam loadTerrainRing", ringLoads === 2);

  // Stationary post-teleport scatter healing (terrain_scatter.js):
  // Teleport to Shoushi (lbX=0xDA=218, lbY=0x55=85) when codes are noted WITHOUT heights yet,
  // then stream in the heightmaps while standing completely still (d === 0)!
  const shoushiOracle = createTerrainOracle();
  const grassCodes = new Uint8Array(81).fill(3);
  const grassHeights = new Float32Array(81).fill(20.0);
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      const lx = 218 + dx;
      const ly = 85 + dy;
      shoushiOracle.noteLandblock(lbKeyFromXY(lx, ly), {
        lbX: lx, lbY: ly, codes: grassCodes, heights: null,
      });
    }
  }
  const healPool = createScatterPool({
    oracle: () => shoushiOracle,
    count: 256,
    radiusM: 24,
    sliceSize: 64,
    scanBudget: 128,
    families: [FAM_GRASS],
    seed: 0xda55,
  });

  // Tick 1 at Shoushi portal before heightmap arrives (codes cached, heights === null):
  healPool.update(0.016, 41922.2, 16412.3, 20.0);
  const st0 = healPool.stats();
  check("Post-teleport before heightmap arrives: live === 0 and noHeight > 0 (all in-disc cells)",
    st0.live === 0 && st0.noHeight > 180,
    `live=${st0.live}, noHeight=${st0.noHeight}`);

  // Now stream in Shoushi landblock heightmaps (z = 20m):
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      const lx = 218 + dx;
      const ly = 85 + dy;
      shoushiOracle.noteLandblock(lbKeyFromXY(lx, ly), {
        lbX: lx, lbY: ly, codes: grassCodes, heights: grassHeights,
      });
    }
  }

  // Player stands COMPLETELY STILL (d === 0) across frames:
  for (let frame = 0; frame < 6; frame += 1) {
    healPool.update(0.016, 41922.2, 16412.3, 20.0);
  }
  const healedStats = healPool.stats();
  check("Stationary ticks (d === 0) heal 100% of unresolved in-disc cells once heightmaps arrive",
    healedStats.live === st0.noHeight && healedStats.live > 180,
    `live=${healedStats.live}, expected=${st0.noHeight}`);
  healPool.dispose();
}

// ============================================================================
// 3. Item 3 — Performant Grass Variety Across Large Tracts of Land
// ============================================================================
section("Item 3: Domain-rotated macro meadow waves, slope/aspect micro-climate & botanical sub-species");
{
  // 1) Domain-rotated ~96m & ~36m macro waves break the 11.4m clump periodicity:
  const valsAt11mStep = [];
  for (let k = 0; k < 24; k += 1) {
    const wx = 10000 + k * 11.428571; // exact 11.4m period of old noise(xy * 0.0875)!
    const wy = 20000 + k * 5.714285;
    const lush = evalGrassMacroLush(wx, wy);
    const hMul = evalGrassMacroHeight(lush);
    check(`Macro height multiplier [${k}] stays in [0.84, 1.24]`, hMul >= 0.84 - 1e-6 && hMul <= 1.24 + 1e-6);
    valsAt11mStep.push(lush);
  }
  const minL = Math.min(...valsAt11mStep);
  const maxL = Math.max(...valsAt11mStep);
  check("Domain-rotated 96m/36m macro waves vary across 11.4m steps (no blotch lockstep)",
    maxL - minL > 0.25, `spread=${(maxL - minL).toFixed(3)}`);

  // 2) Botanical sub-species statistical distribution:
  let culmCount = 0;
  let cloverInLush = 0;
  let cloverInDryGrassland = 0;
  const N = 5000;
  for (let i = 0; i < N; i += 1) {
    const vHash = ((i * 2654435761) >>> 0) / 4294967296;
    const rotRad = (((i * 1597334677) >>> 0) / 4294967296) * Math.PI * 2;
    const seedDrift = 0.5; // mean meadow seed drift -> ~8% rye culms
    const pLush = evalGrassBotanicalProfile(vHash, rotRad, 0.25, 0.72, seedDrift);
    if (pLush.species === "rye-culm") {
      culmCount += 1;
      if (i < 20) {
        check("Rye culm heightMul in [1.45, 1.68], widthMul=0.62, swayMul=1.30",
          pLush.heightMul >= 1.45 && pLush.heightMul <= 1.68 &&
          pLush.widthMul === 0.62 && pLush.swayMul === 1.30);
      }
    } else if (pLush.species === "clover-accent") {
      cloverInLush += 1;
      if (i < 50) {
        check("Clover/wildflower tuft heightMul=0.75, widthMul=1.28",
          pLush.heightMul === 0.75 && pLush.widthMul === 1.28);
      }
    }
    const pPlain = evalGrassBotanicalProfile(vHash, rotRad, 0.50, 0.72, seedDrift);
    if (pPlain.species === "clover-accent") cloverInDryGrassland += 1;
  }
  const culmFrac = culmCount / N;
  const cloverFrac = cloverInLush / N;
  check("Tall golden seed/rye culms occur at ~8% in meadow zones",
    culmFrac >= 0.055 && culmFrac <= 0.105, `culmFrac=${(culmFrac * 100).toFixed(2)}%`);
  check("Clover/wildflower accent tufts occur (~4-7%) in lush LushGrass/Flora pockets",
    cloverFrac >= 0.025 && cloverFrac <= 0.09, `cloverFrac=${(cloverFrac * 100).toFixed(2)}%`);
  check("Clover/wildflower tufts never spawn outside LushGrass/Flora codes",
    cloverInDryGrassland === 0);

  // 3) Per-blade posture & arch variety:
  check("Per-blade arch stays 0 at root (h=0) and 1 at tip (h=1)",
    evalGrassBladeArch(0, 0.1) === 0 && Math.abs(evalGrassBladeArch(1, 0.9) - 1.0) < 1e-6);
  check("Per-blade mid-blade arch varies cleanly between stiff shoots (h3=0) and graceful arches (h3=1)",
    Math.abs(evalGrassBladeArch(0.5, 1.0) - evalGrassBladeArch(0.5, 0.0)) > 0.07);

  // 4) Shader source verification (0 texture lookups, slope/sun-aspect + macro + botanical terms):
  const dummyShader = {
    vertexShader: "void main() {\n#include <beginnormal_vertex>\n#include <begin_vertex>\n}",
    fragmentShader: "void main() {\n#include <color_fragment>\n#include <normal_fragment_begin>\n#include <dithering_fragment>\n}",
  };
  injectTerrainGrassShader(dummyShader);
  check("Grass vertex shader includes macro meadow wave & botanical sub-species",
    dummyShader.vertexShader.includes("hbGrassMacroLush") &&
    dummyShader.vertexShader.includes("hbGrassMacroHeight") &&
    dummyShader.vertexShader.includes("hbRyeProb") &&
    dummyShader.vertexShader.includes("hbCloverProb") &&
    dummyShader.vertexShader.includes("hbGrassVarietyTint"));
  check("Grass vertex shader includes topographic aNormal slope & sun-aspect micro-climate",
    dummyShader.vertexShader.includes("hbSlopeDry") &&
    dummyShader.vertexShader.includes("sunAspect") &&
    dummyShader.vertexShader.includes("drySlope") &&
    dummyShader.vertexShader.includes("coolHollow"));
  const varietyBlock = dummyShader.vertexShader.slice(
    dummyShader.vertexShader.indexOf("float hbGrassMacroLush"),
    dummyShader.vertexShader.indexOf("void main() {"),
  );
  check("Grass variety GLSL functions introduce 0 extra texture lookups (pure ALU)",
    varietyBlock.length > 500 && !/texture2D\s*\(|texelFetch\s*\(|texture\s*\(/.test(varietyBlock));
}

// ============================================================================
// 4. Item 6A — Ocean Coastline & River Shore Classification + Scatter Pools
// ============================================================================
section("Item 6A: Ocean Coastline (starfish/shells) & River Shore (flow-aligned driftwood logs)");
{
  check("SEA_WATER_CODES covers 18, 19, 20",
    SEA_WATER_CODES.length === 3 && isSeaWaterCode(18) && isSeaWaterCode(19) && isSeaWaterCode(20) && !isSeaWaterCode(16));

  // Build an ocean-coast landblock (lbX=10, lbY=20):
  // West columns (col 0..2): sea water (18/19/20) at z = -1.5m
  // Beach column (col 3): BarrenRock/Sand (code 0) at z = 0.65m (gentle beach slope)
  // Inland bluff (col 5..8): LushGrass (code 3) rising to z = 6.0m
  const coastOracle = createTerrainOracle();
  const coastCodes = new Uint8Array(81);
  const coastHeights = new Float32Array(81);
  const coastRoads = new Uint8Array(81);
  for (let col = 0; col < 9; col += 1) {
    for (let row = 0; row < 9; row += 1) {
      const idx = col * 9 + row;
      if (col <= 2) {
        coastCodes[idx] = col === 0 ? 20 : (col === 1 ? 19 : 18);
        coastHeights[idx] = -1.5;
      } else if (col === 3) {
        coastCodes[idx] = 0; // coastal sand
        coastHeights[idx] = 0.65;
      } else if (col === 4) {
        coastCodes[idx] = 2;
        coastHeights[idx] = 1.65;
      } else {
        coastCodes[idx] = 3;
        coastHeights[idx] = 6.0;
      }
      // Put a coastal road across row 7..8 to test off-road rejection:
      if (row >= 7) coastRoads[idx] = 1;
    }
  }
  coastOracle.noteLandblock(lbKeyFromXY(10, 20), {
    lbX: 10, lbY: 20, codes: coastCodes, heights: coastHeights, roads: coastRoads,
  });

  const bx = 10 * 192 + 3.15 * 24; // dry beach right beside col=2 WaterShallowSea (18)
  const by = 20 * 192 + 3.0 * 24;
  const oceanHit = oceanShoreAt(coastOracle, bx, by);
  check("oceanShoreAt classifies dry coastal beach adjacent to sea code 18",
    oceanHit !== null && oceanHit.isOceanShore === true &&
    oceanHit.height >= 0.02 && oceanHit.height <= 2.30);
  check("oceanShoreAt returns normalized shoreline tangent (north-south along N-S beach)",
    oceanHit !== null && Math.abs(Math.hypot(oceanHit.tx, oceanHit.ty) - 1.0) < 1e-4 &&
    Math.abs(oceanHit.ty) > 0.90);
  check("oceanShoreAt rejects submerged sea water",
    oceanShoreAt(coastOracle, 10 * 192 + 1.0 * 24, by) === null);
  check("oceanShoreAt rejects inland bluff > 2.30m",
    oceanShoreAt(coastOracle, 10 * 192 + 5.5 * 24, by) === null);
  check("oceanShoreAt rejects coastal road",
    oceanShoreAt(coastOracle, bx, 20 * 192 + 7.5 * 24) === null);
  check("riverShoreAt rejects ocean coastline (!isOceanShore)",
    riverShoreAt(coastOracle, bx, by) === null);

  // Build an upland river landblock (lbX=50, lbY=60) at altitude z = 42.0m!
  // River channel runs diagonally SW->NE or West->East along row 3..4 (code 16 WaterRunning at z = 42.0m),
  // with flowing current east-northeast (vx = 0.80, vy = 0.60), and banks at row 2 & row 5 at z = 42.45m!
  const flowX = 0.80;
  const flowY = 0.60;
  const riverOracle = createTerrainOracle({
    waterFlowAt: (_wx, _wy, out) => {
      const r = out || {};
      r.vx = flowX;
      r.vy = flowY;
      r.speed = 1.0;
      return r;
    },
  });
  const riverCodes = new Uint8Array(81);
  const riverHeights = new Float32Array(81);
  for (let col = 0; col < 9; col += 1) {
    for (let row = 0; row < 9; row += 1) {
      const idx = col * 9 + row;
      if (row === 3 || row === 4) {
        riverCodes[idx] = col < 6 ? 16 : 17; // Both WaterRunning (16) and flowing WaterStandingFresh (17)!
        riverHeights[idx] = 42.0;
      } else if (row === 2 || row === 5) {
        riverCodes[idx] = 4; // Dirt/muddy river bank
        riverHeights[idx] = 42.50;
      } else {
        riverCodes[idx] = 3;
        riverHeights[idx] = 46.0; // Upper terrace > 1.20m above water
      }
    }
  }
  riverOracle.noteLandblock(lbKeyFromXY(50, 60), {
    lbX: 50, lbY: 60, codes: riverCodes, heights: riverHeights,
  });

  const rx16 = 50 * 192 + 2.5 * 24;
  const ryBank = 60 * 192 + 4.85 * 24; // Dry north bank (~0.42m above 42.0m river)
  const rivHit16 = riverShoreAt(riverOracle, rx16, ryBank);
  check("riverShoreAt classifies upland riverbank (waterZ=42m) beside WaterRunning (16)",
    rivHit16 !== null && rivHit16.isRiverShore === true &&
    rivHit16.bankHeight >= 0.02 && rivHit16.bankHeight <= 1.20);
  check("riverShoreAt tangent aligns with river flow vector",
    rivHit16 !== null &&
    Math.abs(Math.hypot(rivHit16.tx, rivHit16.ty) - 1.0) < 1e-4 &&
    (rivHit16.tx * flowX + rivHit16.ty * flowY) > 0.85);

  const rx17 = 50 * 192 + 7.0 * 24; // Beside flowing WaterStandingFresh (17)
  const rivHit17 = riverShoreAt(riverOracle, rx17, ryBank);
  check("riverShoreAt classifies bank beside flowing WaterStandingFresh (17) via waterFlowAt",
    rivHit17 !== null && rivHit17.isRiverShore === true);

  // Verify still pond (code 17 with 0 flow) is NOT classified as river shore:
  const stillPondOracle = createTerrainOracle({
    waterFlowAt: () => ({ vx: 0, vy: 0, speed: 0 }),
  });
  const pondCodes = new Uint8Array(81).fill(3);
  const pondHeights = new Float32Array(81).fill(10.4);
  pondCodes[4 * 9 + 4] = 17;
  pondHeights[4 * 9 + 4] = 10.0;
  stillPondOracle.noteLandblock(lbKeyFromXY(12, 12), {
    lbX: 12, lbY: 12, codes: pondCodes, heights: pondHeights,
  });
  check("riverShoreAt rejects still WaterStandingFresh (17) pond with zero flow",
    riverShoreAt(stillPondOracle, 12 * 192 + 4.6 * 24, 12 * 192 + 4.0 * 24) === null);

  // Verify binary water_flow.bin parser + sampleWaterFlowTableAt key encoding:
  {
    // Build a 1-landblock HBWF v1 binary buffer for lb (50, 60) -> key ((50<<8)|60) = 0x323C:
    // Header: "HBWF" (4B) + version=1 (u16) + count=1 (u16) + fullScaleUnits (f32) + pad (4B),
    // followed by 1 u16 key at offset 16, padded to dataOff = 20, then 243 bytes of vertex data.
    const dataOff = 20;
    const buf = new ArrayBuffer(dataOff + 243);
    const dv = new DataView(buf);
    dv.setUint8(0, 0x48); dv.setUint8(1, 0x42); dv.setUint8(2, 0x57); dv.setUint8(3, 0x46); // "HBWF"
    dv.setUint16(4, 1, true);          // version 1
    dv.setUint16(6, 1, true);          // count = 1
    dv.setFloat32(8, 2.0, true);       // fullScaleUnits = 2.0
    dv.setUint16(16, (50 << 8) | 60, true);
    const bytes = new Uint8Array(buf, dataOff, 243);
    for (let i = 0; i < 81; i += 1) {
      bytes[i * 3] = 200;     // east > 0
      bytes[i * 3 + 1] = 160; // north > 0
      bytes[i * 3 + 2] = 255;
    }
    const parsedTbl = parseWaterFlowTable(buf);
    const sampledFlow = sampleWaterFlowTableAt(rx16, ryBank, undefined, parsedTbl);
    check("sampleWaterFlowTableAt decodes HBWF v1 ((lbX<<8)|lbY) velocity accurately",
      sampledFlow !== null && sampledFlow.vx > 1.0 && sampledFlow.vy > 0.4 && sampledFlow.speed > 1.1);

    const realFlowPath = resolve(WEB_ROOT, "../../dist/data/water_flow.bin");
    if (existsSync(realFlowPath)) {
      const realBuf = readFileSync(realFlowPath);
      const realTbl = parseWaterFlowTable(realBuf.buffer.slice(realBuf.byteOffset, realBuf.byteOffset + realBuf.byteLength));
      check("Real dist/data/water_flow.bin parses cleanly", !!realTbl && realTbl.offsets.size > 0);
    }
  }

  // Verify procedural shore geometries:
  const sfData = starfishMeshData();
  const shData = seashellMeshData();
  const dwData = driftwoodLogMeshData();
  check("Starfish mesh has 20 crisp triangles and finite attributes",
    sfData.triCount === 20 && sfData.positions.length === 180 && sfData.positions.every(Number.isFinite));
  check("Seashell mesh has 16 crisp triangles and finite attributes",
    shData.triCount === 16 && shData.positions.length === 144 && shData.positions.every(Number.isFinite));
  check("Driftwood log mesh has 24 triangles (tapered broken ends + side branch stub)",
    dwData.triCount === 24 && dwData.positions.length === 216 && dwData.positions.every(Number.isFinite));

  // Verify driftwood wet-dark-bark bottom vs sun-bleached silver-grey top vertex color gradient:
  let bottomLumSum = 0, bottomN = 0, topLumSum = 0, topN = 0, maxPosY = 0;
  for (let v = 0; v < dwData.positions.length; v += 3) {
    const py = dwData.positions[v + 1];
    const pz = dwData.positions[v + 2];
    if (py > maxPosY) maxPosY = py;
    const lum = (dwData.colors[v] + dwData.colors[v + 1] + dwData.colors[v + 2]) / 3;
    if (pz < -0.15) { bottomLumSum += lum; bottomN += 1; }
    if (pz > 0.15) { topLumSum += lum; topN += 1; }
  }
  check("Driftwood log geometry includes protruding side branch stub (+Y > 0.8)", maxPosY > 0.8);
  check("Driftwood vertex color gradient is darker on wet underside than bleached top",
    bottomN > 0 && topN > 0 && (topLumSum / topN) > (bottomLumSum / bottomN) + 0.25);

  const sfGeom = buildStarfishGeometry(THREE);
  const shGeom = buildSeashellGeometry(THREE);
  const dwGeom = buildDriftwoodLogGeometry(THREE);
  check("THREE BufferGeometries build with position, normal, color attributes",
    !!sfGeom.getAttribute("color") && !!shGeom.getAttribute("color") && !!dwGeom.getAttribute("color"));

  // Verify live THREE InstancedMesh pools on Ocean Coast vs Upland River:
  const shoreGroup = new THREE.Group();
  const sfField = createStarfishField({
    THREE, parent: shoreGroup, oracle: () => coastOracle,
    count: 400, radiusM: 32, sliceSize: 400, scanBudget: 400,
  });
  const shField = createSeashellField({
    THREE, parent: shoreGroup, oracle: () => coastOracle,
    count: 500, radiusM: 32, sliceSize: 500, scanBudget: 500,
  });
  const dwOnCoast = createDriftwoodField({
    THREE, parent: shoreGroup, oracle: () => coastOracle,
    count: 300, radiusM: 32, sliceSize: 300, scanBudget: 300,
  });

  const sky = {
    dirHeading: 120, dirPitch: 45, dirBright: 0.85, dirColorArgb: 0xfffff4e0,
    ambBright: 0.35, ambColorArgb: 0xffb8d0ff,
  };
  sfField.update(0.016, 1.0, bx, by, 0.65, sky);
  shField.update(0.016, 1.0, bx, by, 0.65, sky);
  dwOnCoast.update(0.016, 1.0, bx, by, 0.65, sky);

  check("Ocean beach spawns starfish & seashells, and 0 river driftwood logs",
    sfField.stats().live > 0 && shField.stats().live > 0 && dwOnCoast.stats().live === 0,
    `starfish=${sfField.stats().live}, shells=${shField.stats().live}, driftwoodOnCoast=${dwOnCoast.stats().live}`);
  check("InstancedMesh has instanceColor aliased to aTint (0 duplicate buffers) and castShadow === false",
    !!sfField.pool.mesh.instanceColor &&
    sfField.pool.mesh.instanceColor.array === sfField.pool.arrays.aTint &&
    sfField.pool.mesh.castShadow === false &&
    shField.pool.mesh.castShadow === false);
  check("Starfish & seashell palettes have 4 natural coastal swatches each",
    STARFISH_PALETTE.length === 4 && SEASHELL_PALETTE.length === 4 && DRIFTWOOD_PALETTE.length === 4);

  // Check starfish & shell scales are within spec bounds ([0.13..0.25m] and [0.07..0.16m]):
  let sfScaleOk = true;
  for (let i = 0; i < 400; i += 1) {
    const sx = sfField.pool.arrays.aScale[i * 3];
    if (sx > 0 && (sx < 0.13 - 1e-5 || sx > 0.25 + 1e-5)) sfScaleOk = false;
  }
  let shScaleOk = true;
  for (let i = 0; i < 500; i += 1) {
    const sy = shField.pool.arrays.aScale[i * 3 + 1];
    if (sy > 0 && (sy < 0.07 - 1e-5 || sy > 0.16 + 1e-5)) shScaleOk = false;
  }
  check("Starfish scales stay within [0.13, 0.25]m and shell scales within [0.07, 0.16]m",
    sfScaleOk && shScaleOk);

  // Now test River Driftwood Field on upland river bank (rx16, ryBank):
  const dwField = createDriftwoodField({
    THREE, parent: shoreGroup, oracle: () => riverOracle,
    count: 400, radiusM: 36, sliceSize: 400, scanBudget: 400,
  });
  const sfOnRiver = createStarfishField({
    THREE, parent: shoreGroup, oracle: () => riverOracle,
    count: 300, radiusM: 36, sliceSize: 300, scanBudget: 300,
  });
  dwField.update(0.016, 1.0, rx16, ryBank, 42.4, sky);
  sfOnRiver.update(0.016, 1.0, rx16, ryBank, 42.4, sky);

  check("Upland riverbank spawns driftwood logs and 0 ocean starfish",
    dwField.stats().live > 0 && sfOnRiver.stats().live === 0,
    `driftwood=${dwField.stats().live}, starfishOnRiver=${sfOnRiver.stats().live}`);
  check("Driftwood sinkM === 0.035m", SHORE_TUNING.driftwoodSinkM === 0.035);

  // Verify every live driftwood log has length in [0.80, 2.15]m and yaw within +-25 deg of local river tangent!
  const maxYawJitterRad = (25 * Math.PI) / 180 + 1e-4;
  const max3dHorizRad = (27.5 * Math.PI) / 180;
  let allYawsWithin25Deg = true;
  let allBasisAligned = true;
  let allLengthsInRange = true;
  let allSunkProperly = true;
  let checkedLogs = 0;
  for (let i = 0; i < 400; i += 1) {
    const lenM = dwField.pool.arrays.aScale[i * 3];
    if (lenM <= 0) continue;
    checkedLogs += 1;
    if (lenM < 0.80 - 1e-5 || lenM > 2.15 + 1e-5) allLengthsInRange = false;
    const wx = dwField.pool.arrays.aOffset[i * 3];
    const wy = dwField.pool.arrays.aOffset[i * 3 + 1];
    const wz = dwField.pool.arrays.aOffset[i * 3 + 2];
    const groundZ = riverOracle.heightAt(wx, wy);
    if (Math.abs((groundZ - wz) - 0.035) > 1e-3) allSunkProperly = false;

    const hit = riverShoreAt(riverOracle, wx, wy);
    const yaw = dwField.pool.arrays.aShore[i * 3];
    const baseYaw = Math.atan2(hit.ty, hit.tx);
    const dyaw = Math.atan2(Math.sin(yaw - baseYaw), Math.cos(yaw - baseYaw));
    if (Math.abs(dyaw) > maxYawJitterRad) allYawsWithin25Deg = false;

    const tilt = dwField.pool.arrays.aShore[i * 3 + 1];
    const nx = dwField.pool.arrays.aNormal[i * 3];
    const ny = dwField.pool.arrays.aNormal[i * 3 + 1];
    const nz = dwField.pool.arrays.aNormal[i * 3 + 2];
    const basis = shoreBasis(nx, ny, nz, yaw, tilt);
    const exHorizLen = Math.hypot(basis.ex.x, basis.ex.y) || 1;
    const cosAng = Math.abs((basis.ex.x / exHorizLen) * hit.tx + (basis.ex.y / exHorizLen) * hit.ty);
    const angErr = Math.acos(Math.min(1, cosAng));
    if (angErr > max3dHorizRad) allBasisAligned = false;
  }
  check("Every placed driftwood log has length in [0.80, 2.15]m", checkedLogs > 0 && allLengthsInRange);
  check("Every placed driftwood log is half-buried by sinkM = 0.035m", checkedLogs > 0 && allSunkProperly);
  check("Every placed driftwood log yaw is within exact +-25 deg of river flow tangent (tx, ty)",
    checkedLogs > 0 && allYawsWithin25Deg && allBasisAligned);

  sfField.dispose();
  shField.dispose();
  dwOnCoast.dispose();
  dwField.dispose();
  sfOnRiver.dispose();

  // Verify initShoreScatter / dispose lifecycle with terrain_vfx.js spine:
  _resetTerrainVfx();
  _resetShoreScatter();
  const rootG = new THREE.Group();
  const tGroup = new THREE.Group();
  rootG.add(tGroup);
  const fakeS3d = {
    terrainGroup: tGroup,
    cameraSwitcher: { _safePlayerPos: () => ({ x: bx, y: by, z: 0.65 }) },
    skyLightingController: { _lastState: sky, _tickCount: 1 },
    quality: { flags: { preset: "high" } },
  };
  initTerrainVfx({ THREE, scene3d: fakeS3d, parent: rootG });
  const shoreSurface = initShoreScatter({
    THREE, scene3d: fakeS3d, parent: rootG, getOracle: () => coastOracle,
  });
  check("initShoreScatter registers 3 camera-scoped providers on terrain_vfx",
    !!shoreSurface && terrainVfxStats().providers.length === 3);
  terrainVfxTick(0.016, fakeS3d, 10.0);
  check("terrainVfxTick drives shoreScatterStats live pools cleanly",
    shoreScatterStats().inited === true && shoreScatterStats().counters.starfishBuilds === 1);
  shoreSurface.dispose();
  check("shoreSurface.dispose() unregisters all 3 providers cleanly",
    terrainVfxStats().providers.length === 0 && shoreScatterStats().inited === false);
  _resetTerrainVfx();

  // Lint & GLSL hygiene on terrain_shore.js:
  const shoreSrc = readFileSync(resolve(WEB_ROOT, "scene3d/terrain_shore.js"), "utf8");
  const shoreViolations = lintSource(shoreSrc, "scene3d/terrain_shore.js");
  check("terrain_shore.js passes VFX firewall lintSource (0 violations)",
    shoreViolations.length === 0, JSON.stringify(shoreViolations));
  check("SHORE_VERTEX_GLSL & SHORE_FRAGMENT_GLSL are ASCII-only, no backticks, no __",
    /^[\x09\x0A\x0D\x20-\x7E]*$/.test(SHORE_VERTEX_GLSL) &&
    /^[\x09\x0A\x0D\x20-\x7E]*$/.test(SHORE_FRAGMENT_GLSL) &&
    !SHORE_VERTEX_GLSL.includes("`") && !SHORE_VERTEX_GLSL.includes("__") &&
    !SHORE_FRAGMENT_GLSL.includes("`") && !SHORE_FRAGMENT_GLSL.includes("__"));
}

// ============================================================================
// 5. Item 6B — Palm Trees & Coastal Flora GPU Treesway
// ============================================================================
section("Item 6B: Palm trees & coastal flora GPU treesway + progressive 0..30m frond flutter");
{
  _resetTreeWindFlags();
  _resetVfxCatalog();

  const expectedExplicitPalms = [
    0x02000325, 0x0200032b, 0x02001c31, 0x0200058e, 0x02001065,
    0x02000e71, 0x02000e72, 0x020007da, 0x0200032c, 0x02000247,
    0x020004b1, 0x020004b2, 0x020002d7, 0x02000251, 0x020002dc,
    0x02000a35, 0x02000ab6, 0x010036ad, 0x010036e6,
  ];
  check("PALM_COASTAL_WIND_DIDS contains all 19 explicit palm/coastal DIDs",
    PALM_COASTAL_WIND_DIDS.size === 19 &&
    expectedExplicitPalms.every((did) => isPalmOrCoastalWindDid(did)));
  check("Legacy isTreeDid is NOT polluted with single-part palm DIDs (no CPU peel regression)",
    !isTreeDid(0x02000247) && !isTreeDid(0x02001065));

  // Verify parseDescriptorSignals handles Array<{name, value, weight}> from real visual_descriptors.jsonl:
  const sig = parseDescriptorSignals([
    { name: "category", value: "Scenery", weight: 1 },
    { name: "partCount", value: "1", weight: 1 },
    { name: "maxDimension", value: "26.4", weight: 1 },
  ]);
  check("parseDescriptorSignals extracts partCount=1, maxDimension=26.4, category=Scenery from array signals",
    sig.partCount === 1 && Math.abs(sig.maxDimension - 26.4) < 1e-6 && sig.category === "Scenery");

  // Load real dist/vfx/visual_descriptors.jsonl if available (plus synthetic fallback):
  const realJsonlPath = resolve(WEB_ROOT, "../../dist/vfx/visual_descriptors.jsonl");
  let catalogMap;
  if (existsSync(realJsonlPath)) {
    catalogMap = parseDescriptorsJsonl(readFileSync(realJsonlPath, "utf8"));
    check("Real visual_descriptors.jsonl parses >1000 entries", catalogMap.size > 1000);
  } else {
    catalogMap = parseDescriptorsJsonl([
      JSON.stringify({
        didHex: "0x02000247", archetype: "foliage-pollen",
        signals: [{ name: "category", value: "Scenery" }, { name: "partCount", value: "1" }, { name: "maxDimension", value: "18.5" }],
        effects: [],
      }),
      JSON.stringify({
        didHex: "0x02001065", archetype: "creature-breath",
        signals: [{ name: "category", value: "Scenery" }, { name: "partCount", value: "1" }, { name: "maxDimension", value: "22.0" }],
        effects: [],
      }),
      JSON.stringify({
        didHex: "0x02000999", archetype: "foliage-pollen",
        signals: [{ name: "category", value: "Scenery" }, { name: "partCount", value: "1" }, { name: "maxDimension", value: "0.4" }],
        effects: [],
      }),
    ].join("\n"));
  }
  setVfxCatalog(catalogMap);

  // Single-part palm in foliage-pollen (0x02000247): legacy windResponds is false (partCount=1),
  // while windRespondsGpu & fragPlanForDid attach deformation.windSwayGpu!
  const desc0247 = catalogMap.get(0x02000247);
  check("Single-part palm 0x02000247 keeps legacy hasWindBend/windResponds false (no CPU peel)",
    hasWindBend(desc0247) === false && windResponds(desc0247) === false);
  check("Single-part palm 0x02000247 enables windRespondsGpu === true",
    windRespondsGpu(desc0247, 0x02000247) === true);

  // Every single one of the 19 explicit palm/coastal DIDs (including creature-breath 0x02001065
  // and unlisted 0x02000325, 0x010036AD, etc.) gets deformation.windSwayGpu via fragPlanForDid!
  const all19Sway = expectedExplicitPalms.every((did) => {
    const plan = fragPlanForDid(did);
    return isFragDid(did) && !!plan && Array.isArray(plan.ids) && plan.ids.includes("deformation.windSwayGpu");
  });
  check("All 19 explicit palm & coastal flora DIDs receive deformation.windSwayGpu in fragPlanForDid",
    all19Sway);

  // Tiny < 0.8m scenery prop does NOT falsely receive windSwayGpu:
  const tinyDesc = {
    did: 0x02ffff01,
    archetype: "foliage-pollen",
    signals: { category: "Scenery", partCount: 1, maxDimension: 0.45 },
    effects: [],
  };
  check("Tiny <0.8m prop is excluded from windRespondsGpu",
    windRespondsGpu(tinyDesc, 0x02ffff01) === false &&
    fragEntriesForDescriptor(tinyDesc, 0x02ffff01).length === 0);

  _resetVfxCatalog();

  // Verify windSwayGpu progressive 0..30m cantilever + radial frond-tip flutter:
  const swayParams = {
    uTime: 1.35,
    uWindAmp: 0.03,
    uWindFreq: 0.15,
    uWindBaseZ: 0.0,
    uWindFlutter: 0.3,
    uWindDir2: { x: 1.0, y: 0.0 },
  };
  const atRoot = evalWindSwayGpuVertex({ x: 2.5, y: 1.5, z: 0.0 }, swayParams, 0.25);
  check("Palm trunk root (z = 0) stays strictly planted (0 drift in XYZ)",
    atRoot.x === 2.5 && atRoot.y === 1.5 && atRoot.z === 0.0);

  const zeroWind = evalWindSwayGpuVertex({ x: 3.5, y: 1.0, z: 24.0 }, { ...swayParams, uWindAmp: 0 }, 0.25);
  check("uWindAmp = 0 produces exact rest-pose vertex (0 displacement)",
    zeroWind.x === 3.5 && zeroWind.y === 1.0 && zeroWind.z === 24.0);

  // Progressive cantilever curve increases smoothly through 2m -> 6m -> 12m -> 18m -> 24m -> 30m!
  const heights = [2, 6, 12, 18, 24, 30];
  const cantilevers = heights.map((z) => evalWindSwayGpuVertex({ x: 0, y: 0, z }, swayParams, 0.1).cantilever);
  let strictlyIncreasing = true;
  for (let i = 1; i < cantilevers.length; i += 1) {
    if (!(cantilevers[i] > cantilevers[i - 1])) strictlyIncreasing = false;
  }
  check("Progressive cantilever curve increases strictly up to 30m (27m palm crowns not frozen at 12m)",
    strictlyIncreasing && cantilevers[5] > cantilevers[2] * 1.8,
    `c12=${cantilevers[2].toFixed(2)}, c30=${cantilevers[5].toFixed(2)}`);

  // Radial frond-tip flutter above z > 2.5m:
  const trunkAt22m = evalWindSwayGpuVertex({ x: 0.1, y: 0.0, z: 22.0 }, swayParams, 0.37);
  const frondTipAt22m = evalWindSwayGpuVertex({ x: 3.8, y: 1.2, z: 22.0 }, swayParams, 0.37);
  check("Central trunk (r < 0.35m) has frondGate === 0 and zero vertical bob",
    trunkAt22m.frondGate === 0 && trunkAt22m.z === 22.0);
  check("Outer palm frond tips (r = 4m, z = 22m) get lively tangential + vertical breeze flutter",
    frondTipAt22m.frondGate > 0.9 && Math.abs(frondTipAt22m.z - 22.0) > 0.01 &&
    Math.abs(frondTipAt22m.y - 1.2) > 0.01);

  // Inject into dummy shader and verify GLSL hygiene:
  const treeShader = {
    vertexShader: "void main() {\n#include <begin_vertex>\n#include <project_vertex>\n}",
    fragmentShader: "void main() {}",
  };
  windSwayGpu.inject(treeShader);
  check("windSwayGpu injects progressive cantilever + frond-tip flutter before <project_vertex>",
    treeShader.vertexShader.includes("_wsCantilever") &&
    treeShader.vertexShader.includes("_wsFrondGate") &&
    treeShader.vertexShader.indexOf("transformed.x += _wsDisp.x;") <
      treeShader.vertexShader.indexOf("#include <project_vertex>"));
}

// eslint-disable-next-line no-console
console.log(`\nshoushi_grass_and_shores: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
