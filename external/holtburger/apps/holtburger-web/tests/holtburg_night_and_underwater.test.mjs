// Comprehensive regression test suite for WS-5:
//   - Item 5: Holtburg Night Lighting Anomalies & Test-Area Edge Cases (Fixes 5.1–5.6)
//   - Item 12: Monsters That Spawn On Water Appear Underwater (Fixes 12A–12B)

import assert from "node:assert/strict";
import * as THREE from "three";

import {
  setupSceneLighting,
  tickLightingForCellState,
  attachSetupModelLights,
  buildLightForSetupLight,
  SUPPRESSED_SETUP_LIGHT_MODELS,
  RECENTERED_HEARTH_SETUP_IDS,
  HEARTH_ENCLOSED_MAX_RANGE_M,
  OUTDOOR_SEEN_OUTSIDE_BLEED_MAX_M,
  isEnclosedInBuildingFootprint,
  isIndoorCellDrawn,
} from "../scene3d/lighting.js";

import {
  bindEmitterFxLight,
  releaseFxLight,
  tickFxLights,
  feedTerrainFxLights,
  TERRAIN_FX_LIGHT_UNIFORMS,
  HEARTH_SETUP_IDS,
  HEARTH_EMITTER_ID,
} from "../scene3d/vfx/fx_lights.js";

import {
  SUPPRESSED_RETAIL_SPAWN_WCIDS,
  MAD_COW_WCID,
  shouldSuppressRetailTestSpawn,
  applyWaterSpawnSubmersion,
  bakeLandblockSpawns,
} from "../scene3d/spawns.js";

import {
  EntityManager,
  SUPPRESSED_ADMIN_WEENIE_WCIDS,
  shouldSuppressAdminOrPlaceholderWeenie,
  isNoDrawOrUiHiddenWeenie,
  _groundClampZ,
} from "../scene3d/entities.js";

import { WeenieContactShadows } from "../scene3d/weenie_contact_shadows.js";

import {
  WATER_TERRAIN_CODES,
  isWaterTerrainCode,
  waterSubmersionAt,
  isWaterSubmergibleCreature,
  computeSubmergedCreatureZ,
  syncEntityWaterSubmersion,
  unregisterSubmergedEntity,
  createUnderwaterSubmersionRenderer,
  MAX_UNDERWATER_RENDER_DIST_M,
  RETAIL_WATER_FLOOR_ENTIRE_M,
  RETAIL_WATER_FLOOR_PARTIAL_M,
  FOREGROUND_OCCLUSION_BIAS_M,
  MAX_TRANSMISSION_ALPHA,
} from "../scene3d/underwater_submersion.js";

import { createFakeWebGL2, fakeCanvas } from "./helpers/fake_webgl2.mjs";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  [FAIL] ${name}`);
    console.error(err);
  }
}

function makeFakeBundle(lights) {
  return {
    partCount: lights.length,
    takeLights() {
      return lights.map((l) => ({
        partIndex: l.partIndex ?? 0,
        x: l.x ?? 0,
        y: l.y ?? 0,
        z: l.z ?? 0,
        colorR: l.colorR ?? 1.0,
        colorG: l.colorG ?? 0.6,
        colorB: l.colorB ?? 0.2,
        intensity: l.intensity ?? 40,
        falloff: l.falloff ?? 12,
        coneAngle: l.coneAngle ?? 0,
        free() {},
      }));
    },
    free() {},
  };
}

function makeWaterOracle({
  lbKey = 0xa9b40000,
  surfaceZ = 60.0,
  codesByCell = {},
  defaultCode = 2,
} = {}) {
  const terrainCodes = new Uint8Array(81);
  terrainCodes.fill(defaultCode);
  const heights = new Float32Array(81);
  heights.fill(surfaceZ);
  for (const [k, cornerCodes] of Object.entries(codesByCell)) {
    const [cx, cy] = k.split(",").map(Number);
    // cornerCodes = [sw, se, nw, ne]
    terrainCodes[cx * 9 + cy] = cornerCodes[0];
    terrainCodes[(cx + 1) * 9 + cy] = cornerCodes[1];
    terrainCodes[cx * 9 + (cy + 1)] = cornerCodes[2];
    terrainCodes[(cx + 1) * 9 + (cy + 1)] = cornerCodes[3];
  }
  const map = new Map([[lbKey >>> 0, { terrainCodes, heights }]]);
  return {
    _waterTerrainByLb: map,
    _terrainOracle: {
      heightAt: () => surfaceZ,
    },
    terrainHeightAt: () => surfaceZ,
  };
}

console.log("\n=== Item 5: Holtburg Night Lighting & Test-Area Edge Cases ===");

// ---------------------------------------------------------------------------
// Fix 5.1 — Suppress Retail Invisible Point-Light Test Marker (0x02000364)
// ---------------------------------------------------------------------------
await test("Fix 5.1: suppresses Setup 0x02000364 invisible test-light marker across all placement streams", async () => {
  assert.ok(SUPPRESSED_SETUP_LIGHT_MODELS.has(0x02000364));
  const rawDummy = buildLightForSetupLight(
    { x: 0, y: 0, z: 0, colorR: 1, colorG: 1, colorB: 1, intensity: 50, falloff: 15, coneAngle: 0 },
    0x02000364,
  );
  assert.equal(rawDummy, null, "buildLightForSetupLight must return null for 0x02000364");

  const worldRoot = new THREE.Group();
  worldRoot.rotation.x = -Math.PI / 2;
  const staticsGroup = new THREE.Group();
  const buildingsGroup = new THREE.Group();
  const cellsGroup = new THREE.Group();
  worldRoot.add(staticsGroup, buildingsGroup, cellsGroup);

  const dummyStatic = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  dummyStatic.userData = { modelId: 0x02000364, landblockId: 0xa9b40001 };
  staticsGroup.add(dummyStatic);

  const realStatic = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  realStatic.userData = { modelId: 0x02000401, landblockId: 0xa9b40001 };
  staticsGroup.add(realStatic);

  const dummyEntityRoot = new THREE.Group();
  const dummyEntity = {
    guid: 0x70000001,
    root: dummyEntityRoot,
    parts: [new THREE.Group()],
    meta: { modelId: 0x02000364, landblockId: 0xa9b40001 },
  };
  dummyEntityRoot.add(dummyEntity.parts[0]);

  const scene3d = {
    staticsGroup,
    buildingsGroup,
    cellsGroup,
    activeLights: [],
    entityManager: { entityMap: new Map([[dummyEntity.guid, dummyEntity]]) },
  };

  let fetchedDummy = false;
  const wasmExports = {
    async fetchSetupModelLights(sid) {
      if ((sid >>> 0) === 0x02000364) fetchedDummy = true;
      return makeFakeBundle([{ partIndex: 0, x: 0, y: 0, z: 2.51, falloff: 15, intensity: 60 }]);
    },
  };

  const summary = await attachSetupModelLights(scene3d, wasmExports);
  assert.equal(fetchedDummy, false, "0x02000364 should be skipped before wasm fetch");
  assert.equal(summary.lightCount, 1, "only the real lantern static should attach a light");
  assert.equal(scene3d.activeLights.length, 1);
  assert.equal(scene3d.activeLights[0].userData.__setupId, 0x02000401);
});

// ---------------------------------------------------------------------------
// Fix 5.2 — Recenter Displaced (-2, -2, +2) Hearth/Campfire LightInfos,
//           Clamp Enclosed Cottage Hearths, and Dedupe Double-Lights
// ---------------------------------------------------------------------------
await test("Fix 5.2: recenters (-2, -2, +2) hearth LightInfo XY to (0, 0), clamps cottage chimney range, keeps outdoor campfire full range", async () => {
  for (const sid of [0x020005d8, 0x020005d9, 0x02000706]) {
    assert.ok(RECENTERED_HEARTH_SETUP_IDS.has(sid));
    assert.ok(HEARTH_SETUP_IDS.has(sid));
  }

  const scene = new THREE.Scene();
  const worldRoot = new THREE.Group();
  scene.add(worldRoot);
  const buildingsGroup = new THREE.Group();
  const staticsGroup = new THREE.Group();
  worldRoot.add(buildingsGroup, staticsGroup);

  // Cottage building spanning [0..12] in X, [0..8] in Y, [0..12] in Z (world space)
  const cottage = new THREE.Group();
  cottage.userData = {
    modelId: 0x02000111,
    landblockId: 0xa9b40001,
    worldBounds: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(12, 8, 12)),
  };
  const cottagePart = new THREE.Group();
  cottagePart.name = "part-0";
  cottagePart.userData = { partIndex: 0 };
  cottage.add(cottagePart);
  buildingsGroup.add(cottage);

  // Placement 1: Enclosed cottage chimney hearth at (6, 1, 6) inside cottage bounds
  const chimneyHearth = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  chimneyHearth.position.set(6, 1, 6);
  chimneyHearth.userData = { modelId: 0x020005d8, landblockId: 0xa9b40001 };
  staticsGroup.add(chimneyHearth);

  // Placement 2: Open-air campfire sharing 0x020005d8 at (50, 1, 50) far outside cottage
  const outdoorCampfire = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  outdoorCampfire.position.set(50, 1, 50);
  outdoorCampfire.userData = { modelId: 0x020005d8, landblockId: 0xa9b40001 };
  staticsGroup.add(outdoorCampfire);
  scene.updateMatrixWorld(true);

  assert.equal(isEnclosedInBuildingFootprint({ buildingsGroup }, chimneyHearth, null), true);
  assert.equal(isEnclosedInBuildingFootprint({ buildingsGroup }, outdoorCampfire, null), false);

  const scene3d = {
    scene,
    buildingsGroup,
    staticsGroup,
    cellsGroup: new THREE.Group(),
    activeLights: [],
  };

  const wasmExports = {
    async fetchSetupModelLights(sid) {
      if ((sid >>> 0) === 0x020005d8) {
        return makeFakeBundle([{ partIndex: 0, x: -2.0, y: -2.0, z: 2.0, falloff: 12.0, intensity: 45 }]);
      }
      return { partCount: 0, free() {} };
    },
  };

  await attachSetupModelLights(scene3d, wasmExports);
  assert.equal(scene3d.activeLights.length, 2, "both hearth placements receive recentered lights");
  const [lChimney, lCampfire] = scene3d.activeLights;

  // Both must have horizontal XY recentered from (-2, -2) -> (0, 0) while preserving z = 2.0
  assert.equal(lChimney.position.x, 0);
  assert.equal(lChimney.position.y, 0);
  assert.equal(lChimney.position.z, 2.0);
  assert.equal(lChimney.userData.hearthRecentered, true);
  assert.deepEqual(lChimney.userData.rawSetupLightOrigin, { x: -2, y: -2, z: 2 });

  assert.equal(lCampfire.position.x, 0);
  assert.equal(lCampfire.position.y, 0);
  assert.equal(lCampfire.position.z, 2.0);

  // Enclosed cottage hearth range clamped <= 5.5 m; open-air campfire keeps full 12 * 1.3 = 15.6 m
  assert.ok(lChimney.distance <= HEARTH_ENCLOSED_MAX_RANGE_M + 1e-5);
  assert.equal(lChimney.userData.hearthEnclosedClamped, true);
  assert.ok(Math.abs(lCampfire.distance - 15.6) < 1e-3, `expected outdoor campfire ~15.6m, got ${lCampfire.distance}`);
});

await test("Fix 5.2: fx_lights dedupes hearth emitter 0x3200002F against recentered hearth Setup LightInfo", () => {
  const scene = new THREE.Scene();
  const hearthStaticLight = new THREE.PointLight(0xff8833, 40, 5.5, 2);
  hearthStaticLight.position.set(10, 2.0, 10);
  hearthStaticLight.userData = { fromSetupModelLight: true, __setupId: 0x020005d8, hearthRecentered: true };
  scene.add(hearthStaticLight);
  scene.updateMatrixWorld(true);

  const duplicateEmitter = { numParticles: 6, info: { id: HEARTH_EMITTER_ID } };
  const standaloneCampfireEmitter = { numParticles: 6, info: { id: HEARTH_EMITTER_ID } };

  const dupSrc = bindEmitterFxLight({
    emitter: duplicateEmitter,
    // Flame script anchor at (10, 0.0, 10) is 2.0 m below recentered LightInfo (10, 2.0, 10) -> > 1.2 m generic dedupe, but within 3.5 m hearth dedupe!
    resolvePosition: (out) => {
      out.set(10, 0.0, 10);
      return true;
    },
    intensity: 30,
    range: 9,
    color: [1.0, 0.55, 0.2],
    anchorSetupId: 0x020005d8,
    emitterDid: HEARTH_EMITTER_ID,
  });

  const standaloneSrc = bindEmitterFxLight({
    emitter: standaloneCampfireEmitter,
    resolvePosition: (out) => {
      out.set(22, 1.5, 12);
      return true;
    },
    intensity: 30,
    range: 9,
    color: [1.0, 0.55, 0.2],
    emitterDid: HEARTH_EMITTER_ID,
  });

  const scene3d = {
    scene,
    camera: { position: new THREE.Vector3(12, 2, 12) },
    activeLights: [hearthStaticLight],
  };

  try {
    tickFxLights(scene3d, 10000);
    assert.equal(dupSrc.suppressed, true, "hearth emitter paired with Setup LightInfo must be suppressed");
    assert.equal(standaloneSrc.suppressed, false, "standalone campfire emitter must light normally");
    assert.ok(standaloneSrc.intensity > 0);
    assert.equal(scene3d.activeLights.length, 2, "1 static hearth light + 1 standalone fx_light");
  } finally {
    releaseFxLight(dupSrc);
    releaseFxLight(standaloneSrc);
    tickFxLights(scene3d, 20000);
  }
});

// ---------------------------------------------------------------------------
// Fix 5.3 & 5.4 — Stop Underground & Closed-Room Entities From Bleeding Outdoors
// ---------------------------------------------------------------------------
await test("Fix 5.3 & 5.4: indoor/underground portals stamp __cellId, stay out of outdoor light pool, and never feed TERRAIN_FX_LIGHT_UNIFORMS", async () => {
  const scene = new THREE.Scene();
  const lighting = setupSceneLighting(scene);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.set(100, 68, -100);

  // Underground Mannikin Foundry Portal in cell 0xA9B40176 at z = 63.12 m beneath z = 66.0 m grass
  const undergroundPortalRoot = new THREE.Group();
  undergroundPortalRoot.position.set(100, 63.12, -100);
  const undergroundPortalPart = new THREE.Group();
  undergroundPortalRoot.add(undergroundPortalPart);
  const undergroundPortalInst = {
    guid: 0x70000176,
    root: undergroundPortalRoot,
    parts: [undergroundPortalPart],
    _spawnCellId: 0xa9b40176,
    _wireCellId: 0xa9b40176,
    _stateVisible: true,
    _culledByCell: true,
    meta: { modelId: 0x02000499, landblockId: 0xa9b40176, name: "Mannikin Foundry Portal" },
  };

  // Outdoor town lamp entity in cell 0xA9B40012 at z = 66.5 m on 66.0 m grass
  const outdoorLampRoot = new THREE.Group();
  outdoorLampRoot.position.set(102, 66.5, -100);
  const outdoorLampPart = new THREE.Group();
  outdoorLampRoot.add(outdoorLampPart);
  const outdoorLampInst = {
    guid: 0x70000012,
    root: outdoorLampRoot,
    parts: [outdoorLampPart],
    _spawnCellId: 0xa9b40012,
    _stateVisible: true,
    _culledByCell: false,
    meta: { modelId: 0x02000499, landblockId: 0xa9b40012, name: "Town Street Lamp" },
  };

  const cellContainer176 = new THREE.Group();
  cellContainer176.visible = false; // underground room not drawn outdoors!
  scene.add(undergroundPortalRoot, outdoorLampRoot, cellContainer176);
  scene.updateMatrixWorld(true);

  const scene3d = {
    scene,
    camera,
    lighting,
    activeLights: [],
    cellContainers3d: new Map([[0xa9b40176, cellContainer176]]),
    entityManager: {
      entityMap: new Map([
        [undergroundPortalInst.guid, undergroundPortalInst],
        [outdoorLampInst.guid, outdoorLampInst],
      ]),
    },
    _terrainOracle: {
      // Three-space (x=100, z=-100) -> AC (wx=100, wy=100) => grass height 66.0 m
      heightAt: () => 66.0,
    },
  };

  await attachSetupModelLights(scene3d, {
    async fetchSetupModelLights() {
      return makeFakeBundle([{ partIndex: 0, x: 0, y: 0, z: 0, colorR: 1.0, colorG: 0.0, colorB: 1.0, falloff: 14, intensity: 50 }]);
    },
  });

  assert.equal(scene3d.activeLights.length, 2);
  const portalLight = scene3d.activeLights.find((l) => l.userData.__ownerGuid === undergroundPortalInst.guid);
  const outdoorLight = scene3d.activeLights.find((l) => l.userData.__ownerGuid === outdoorLampInst.guid);

  assert.equal(portalLight.userData.__cellId, 0xa9b40176, "indoor entity light must stamp __cellId");
  assert.equal(outdoorLight.userData.__cellId, undefined, "outdoor entity light must leave __cellId undefined");

  // Simulate player standing outdoors in Holtburg town square (0xA9B40012)
  const outdoorSession = {
    isCurrentCellIndoor: () => false,
    isCurrentCellSeenOutside: () => false,
    currentCellId: () => 0xa9b40012,
    getRenderSet: () => new Uint32Array([0xa9b40176]), // even if unclipped PVS lists 0x0176!
  };

  tickLightingForCellState(scene3d, outdoorSession);
  assert.equal(
    lighting.lightPool.selPoint.includes(portalLight),
    false,
    "underground portal light must NOT enter outdoor light pool",
  );
  assert.equal(
    lighting.lightPool.selPoint.includes(outdoorLight),
    true,
    "outdoor street lamp MUST enter outdoor light pool",
  );

  // Also verify feedTerrainFxLights rejects BOTH indoor (__cellId >= 0x0100) AND underground (y < terrainZ - 0.5) lights
  const indoorFxEmitter = { numParticles: 8, _emitterCellHidden: false };
  const undergroundUnstampedFxEmitter = { numParticles: 8, _emitterCellHidden: false };
  const aboveGroundOutdoorFxEmitter = { numParticles: 8, _emitterCellHidden: false };

  const indoorFxSrc = bindEmitterFxLight({
    emitter: indoorFxEmitter,
    resolvePosition: (out) => {
      out.set(100, 63.12, -104); // indoor cell 0xA9B40176 AND underground y=63.12 < 66.0-0.5
      return true;
    },
    intensity: 40,
    range: 12,
    color: [1, 0, 1],
    cellId: 0xa9b40176,
    ownerInst: undergroundPortalInst,
  });
  const undergroundUnstampedFxSrc = bindEmitterFxLight({
    emitter: undergroundUnstampedFxEmitter,
    resolvePosition: (out) => {
      out.set(105, 63.12, -100); // unstamped, but underground y=63.12 < 66.0-0.5
      return true;
    },
    intensity: 40,
    range: 12,
    color: [1, 0, 1],
  });
  const aboveGroundOutdoorFxSrc = bindEmitterFxLight({
    emitter: aboveGroundOutdoorFxEmitter,
    resolvePosition: (out) => {
      out.set(108, 67.2, -100); // outdoor AND above-ground y=67.2 >= 66.0-0.5
      return true;
    },
    intensity: 35,
    range: 10,
    color: [0.25, 0.8, 1.0],
  });

  assert.equal(indoorFxSrc.userData.__cellId, 0xa9b40176);
  assert.equal(undergroundUnstampedFxSrc.userData.__cellId, undefined);
  assert.equal(aboveGroundOutdoorFxSrc.userData.__cellId, undefined);

  try {
    // Temporarily open cell 0xA9B40176 so indoor lights enter the pool, then verify feedTerrainFxLights STILL rejects them!
    cellContainer176.visible = true;
    undergroundPortalInst._culledByCell = false;
    tickFxLights(scene3d, 30000);
    const indoorSession = {
      isCurrentCellIndoor: () => true,
      isCurrentCellSeenOutside: () => true,
      currentCellId: () => 0xa9b40176,
      getRenderSet: () => new Uint32Array([0xa9b40176]),
    };
    tickLightingForCellState(scene3d, indoorSession);

    const fedCount = feedTerrainFxLights(scene3d, 1.0, false);
    assert.equal(
      fedCount,
      2,
      "ONLY the 2 above-ground outdoor lights (street lamp + outdoor FX) may feed TERRAIN_FX_LIGHT_UNIFORMS",
    );
    const posArr = TERRAIN_FX_LIGHT_UNIFORMS.uFxLightPos.value;
    for (let i = 0; i < fedCount; i += 1) {
      const y = posArr[i * 4 + 1];
      assert.ok(y >= 65.5, `terrain-fed light slot ${i} must not be underground (got y=${y})`);
    }

    // Now hide cell 0xA9B40176 / mark _emitterCellHidden and verify tickFxLights drops indoorFxSrc to 0 intensity
    cellContainer176.visible = false;
    indoorFxEmitter._emitterCellHidden = true;
    tickFxLights(scene3d, 40000);
    assert.equal(indoorFxSrc.intensity, 0, "hidden EnvCell fx_light must drop to 0 intensity");
  } finally {
    releaseFxLight(indoorFxSrc);
    releaseFxLight(undergroundUnstampedFxSrc);
    releaseFxLight(aboveGroundOutdoorFxSrc);
    tickFxLights(scene3d, 50000);
    lighting.dispose();
  }
});

// ---------------------------------------------------------------------------
// Fix 5.5 — Gate EnvCell Indoor Lights by Drawn Portal Visibility + Outdoor
//           SeenOutside Bleed Radius Cap (<= 8 m)
// ---------------------------------------------------------------------------
await test("Fix 5.5: gates EnvCell lights by drawn cellContainer.visible and caps outdoor SeenOutside bleed to <= 8 m", () => {
  const scene = new THREE.Scene();
  const lighting = setupSceneLighting(scene);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.set(0, 2, 0);

  // Chandelier 1 in occluded back room 0xA9B40166 (in unclipped PVS, but container.visible === false)
  const occludedChandelier = new THREE.PointLight(0xffaa55, 60, 30, 2);
  occludedChandelier.position.set(4, 3, 0);
  occludedChandelier.visible = false;
  occludedChandelier.userData = { __cellId: 0xa9b40166 };
  scene.add(occludedChandelier);

  // Chandelier 2 in open-doorway foyer 0xA9B40101 (container.visible === true, 30 m authored cutoff)
  const foyerChandelier = new THREE.PointLight(0xffaa55, 60, 30, 2);
  foyerChandelier.position.set(5, 3, 0);
  foyerChandelier.visible = false;
  foyerChandelier.userData = { __cellId: 0xa9b40101 };
  scene.add(foyerChandelier);

  const containerBackRoom = new THREE.Group();
  containerBackRoom.visible = false;
  const containerFoyer = new THREE.Group();
  containerFoyer.visible = true;
  scene.add(containerBackRoom, containerFoyer);
  scene.updateMatrixWorld(true);

  const scene3d = {
    scene,
    camera,
    lighting,
    activeLights: [occludedChandelier, foyerChandelier],
    cellContainers3d: new Map([
      [0xa9b40166, containerBackRoom],
      [0xa9b40101, containerFoyer],
    ]),
  };

  assert.equal(isIndoorCellDrawn(scene3d, 0xa9b40166), false);
  assert.equal(isIndoorCellDrawn(scene3d, 0xa9b40101), true);

  // Case A: Player is OUTDOORS (cell 0xA9B40005), looking toward open cottage doorway
  const outdoorSession = {
    isCurrentCellIndoor: () => false,
    isCurrentCellSeenOutside: () => false,
    currentCellId: () => 0xa9b40005,
    getRenderSet: () => new Uint32Array([0xa9b40166, 0xa9b40101]),
  };
  tickLightingForCellState(scene3d, outdoorSession);

  assert.equal(
    lighting.lightPool.selPoint.includes(occludedChandelier),
    false,
    "occluded back-room chandelier must be blocked even when in unclipped getRenderSet",
  );
  const foyerIdxOutdoor = lighting.lightPool.selPoint.indexOf(foyerChandelier);
  assert.ok(foyerIdxOutdoor >= 0, "visible foyer chandelier is admitted");
  const outdoorSlotDist = lighting.lightPool.point[foyerIdxOutdoor].distance;
  assert.ok(
    outdoorSlotDist <= OUTDOOR_SEEN_OUTSIDE_BLEED_MAX_M + 1e-5,
    `when player is outdoors, indoor doorway bleed distance (${outdoorSlotDist}) must be capped <= ${OUTDOOR_SEEN_OUTSIDE_BLEED_MAX_M}m`,
  );

  // Case B: Player steps INSIDE the SeenOutside foyer (cell 0xA9B40101 >= 0x0100)
  const indoorFoyerSession = {
    isCurrentCellIndoor: () => true,
    isCurrentCellSeenOutside: () => true,
    currentCellId: () => 0xa9b40101,
    getRenderSet: () => new Uint32Array([0xa9b40166, 0xa9b40101]),
  };
  tickLightingForCellState(scene3d, indoorFoyerSession);

  assert.equal(
    lighting.lightPool.selPoint.includes(occludedChandelier),
    false,
    "back room remains blocked while its portal container is not visible",
  );
  const foyerIdxIndoor = lighting.lightPool.selPoint.indexOf(foyerChandelier);
  assert.ok(foyerIdxIndoor >= 0);
  const indoorSlotDist = lighting.lightPool.point[foyerIdxIndoor].distance;
  assert.ok(
    Math.abs(indoorSlotDist - 30) < 1e-3,
    `once player is indoors, foyer chandelier must restore full 30m reach (got ${indoorSlotDist})`,
  );

  // Case C: Portal into back room opens (containerBackRoom.visible = true)
  containerBackRoom.visible = true;
  tickLightingForCellState(scene3d, indoorFoyerSession);
  assert.equal(lighting.lightPool.selPoint.includes(foyerChandelier), true);
  assert.equal(
    lighting.lightPool.selPoint.includes(occludedChandelier),
    true,
    "opening portal admits back-room chandelier immediately",
  );

  lighting.dispose();
});

// ---------------------------------------------------------------------------
// Fix 5.6 — Filter Leftover Retail Test / Live-Event / Luminous Placeholder Spawns
// ---------------------------------------------------------------------------
await test("Fix 5.6: suppresses retail admin/event/placeholder spawns in spawns.js and entities.js while keeping ground cattle intact", async () => {
  for (const wcid of [3666, 23631, 19457, 8359, 32205, 39748]) {
    assert.ok(SUPPRESSED_RETAIL_SPAWN_WCIDS.has(wcid), `spawns.js must suppress WCID ${wcid}`);
    assert.ok(SUPPRESSED_ADMIN_WEENIE_WCIDS.has(wcid), `entities.js must suppress WCID ${wcid}`);
  }

  const scene3d = {
    _terrainOracle: { heightAt: () => 65.0 },
    terrainHeightAt: () => 65.0,
  };

  let freedCount = 0;
  const mkRec = (wcid, name, z, extra = {}) => ({
    landblockId: 0xa9b40000,
    cell: 1,
    wcid,
    name,
    category: "Creature",
    weenieType: 10,
    x: 50,
    y: 50,
    z,
    free() {
      freedCount += 1;
    },
    ...extra,
  });

  const records = [
    mkRec(3666, "Place Holder Object", 65.0),
    mkRec(99999, "Place Holder Object", 65.0), // matched by name even with custom WCID
    mkRec(23631, "April 2003 Raining Mad Cows Gen", 65.0),
    mkRec(MAD_COW_WCID, "Mad Cow", 125.0),     // dz = +60 m in sky -> SUPPRESS!
    mkRec(MAD_COW_WCID, "Mad Cow", 65.0),      // dz = 0 m on pasture grass -> KEEP!
    mkRec(19457, "Fireworks Generator", 65.0),
    mkRec(8359, "Anniversary Effect", 65.0),
    mkRec(32205, "Pumpkin Buffer", 65.0),
    mkRec(39748, "Exploration Marker", 65.0),
    mkRec(7, "Holtburg Guard", 65.0),          // normal NPC -> KEEP!
  ];

  const wcidMap = new Map([
    [MAD_COW_WCID, 0x02000100],
    [7, 0x02000001],
  ]);
  const baked = bakeLandblockSpawns(records, wcidMap, scene3d);
  assert.equal(freedCount, records.length, "every wasm spawn record handle must be freed");
  assert.equal(baked.suppressedCount, 8, "all 8 test/event/sky-cow/placeholder records must be suppressed");
  assert.equal(baked.pendingDispatches.length, 2, "only ground Mad Cow and Holtburg Guard remain");
  assert.deepEqual(
    baked.pendingDispatches.map((d) => d.upd.name),
    ["Mad Cow", "Holtburg Guard"],
  );

  // Verify EntityManager suppression & NoDraw/UiHidden predicates
  assert.equal(shouldSuppressAdminOrPlaceholderWeenie({ wcid: 32205, name: "Pumpkin Buffer" }, scene3d), true);
  assert.equal(
    shouldSuppressAdminOrPlaceholderWeenie(
      { wcid: MAD_COW_WCID, name: "Mad Cow", landblockId: 0xa9b40001, x: 10, y: 10, z: 110 },
      scene3d,
    ),
    true,
  );
  assert.equal(
    shouldSuppressAdminOrPlaceholderWeenie(
      { wcid: MAD_COW_WCID, name: "Mad Cow", landblockId: 0xa9b40001, x: 10, y: 10, z: 65.2 },
      scene3d,
    ),
    false,
  );
  assert.equal(isNoDrawOrUiHiddenWeenie({ noDraw: true }), true);
  assert.equal(isNoDrawOrUiHiddenWeenie({ uiHidden: true }), true);
  assert.equal(isNoDrawOrUiHiddenWeenie({ physicsState: 0x20 }, false), true);
  assert.equal(isNoDrawOrUiHiddenWeenie({ physicsState: 0x20 }, true), false, "projectiles manage their own NoDraw lifecycle");
});

console.log("\n=== Item 12: Underwater Monster Spawns & Submersion Rendering ===");

// ---------------------------------------------------------------------------
// Fix 12A — Water Terrain Classification, Vertical Z Submersion & Contact Shadows
// ---------------------------------------------------------------------------
await test("Fix 12A: waterSubmersionAt classifies EntirelyWater (16..20), PartiallyWater, dry land, and FauxWater (22/23)", () => {
  for (const c of [16, 17, 18, 19, 20]) {
    assert.ok(WATER_TERRAIN_CODES.includes(c));
    assert.equal(isWaterTerrainCode(c), true);
  }
  assert.equal(isWaterTerrainCode(22), false, "FauxWater (22) is solid in retail and must NOT submerge");
  assert.equal(isWaterTerrainCode(23), false, "FauxWater (23) is solid in retail and must NOT submerge");

  const lbX = 0xa9;
  const lbY = 0xb4;
  const baseWx = lbX * 192;
  const baseWy = lbY * 192;
  const s3d = makeWaterOracle({
    lbKey: 0xa9b40000,
    surfaceZ: 48.0,
    codesByCell: {
      "1,1": [17, 18, 19, 20], // EntirelyWater
      "3,3": [2, 2, 2, 16],    // PartiallyWater (only NE corner wet)
      "5,5": [22, 23, 22, 23], // FauxWater
    },
  });

  const entire = waterSubmersionAt(s3d, baseWx + 36, baseWy + 36);
  assert.ok(entire);
  assert.equal(entire.waterType, "EntirelyWater");
  assert.equal(entire.overWater, true);
  assert.equal(entire.waterZ, 48.0);
  assert.equal(entire.submergeM, RETAIL_WATER_FLOOR_ENTIRE_M);

  const partialWet = waterSubmersionAt(s3d, baseWx + 3 * 24 + 21, baseWy + 3 * 24 + 21);
  assert.ok(partialWet);
  assert.equal(partialWet.waterType, "PartiallyWater");
  assert.equal(partialWet.overWater, true);
  assert.ok(partialWet.submergeM >= RETAIL_WATER_FLOOR_PARTIAL_M);

  const partialDry = waterSubmersionAt(s3d, baseWx + 3 * 24 + 2, baseWy + 3 * 24 + 2);
  assert.ok(partialDry);
  assert.equal(partialDry.waterType, "PartiallyWater");
  assert.equal(partialDry.overWater, false, "dry shore corner of PartiallyWater must stay dry");

  const faux = waterSubmersionAt(s3d, baseWx + 5 * 24 + 12, baseWy + 5 * 24 + 12);
  assert.equal(faux, null, "FauxWater (22/23) has 0 wet corners and returns null");
});

await test("Fix 12A: _groundClampZ & bakeLandblockSpawns keep -0.895m monsters submerged and sink surface water spawns underwater", () => {
  const lbX = 0xa9;
  const lbY = 0xb4;
  const wxWater = lbX * 192 + 36;
  const wyWater = lbY * 192 + 36;
  const wxDry = lbX * 192 + 12;
  const wyDry = lbY * 192 + 12;

  const s3d = makeWaterOracle({
    lbKey: 0xa9b40000,
    surfaceZ: 50.0,
    codesByCell: {
      "1,1": [16, 17, 18, 19], // cell (1,1) EntirelyWater
    },
  });

  const niffisMeta = { name: "Glissnal Niffis", itemType: 0x10, __category: "Creature" };
  const tallMonsterInst = {
    meta: { name: "Shallows Lurker", itemType: 0x10 },
    _partDims: [0.6, 1.8], // 1.8 m tall -> sinks deeper so body sits underwater
  };
  const wispMeta = { name: "Water Wisp", itemType: 0x10, __category: "Creature" };

  // 1. Retail -0.895 m floor spawn MUST NOT be lifted up to 50.0 m!
  const zRetailSubmerged = _groundClampZ(wxWater, wyWater, 50.0 - 0.895, 10, s3d, null, niffisMeta);
  assert.ok(zRetailSubmerged <= 50.0 - 0.895 + 1e-4, `expected <= 49.105, got ${zRetailSubmerged}`);

  // 2. Surface water spawn (z = 50.0, dz = 0.0) sinks underwater (<= 50.0 - 0.90 = 49.10)
  const zSurfaceNiffis = _groundClampZ(wxWater, wyWater, 50.0, 10, s3d, null, niffisMeta);
  assert.ok(zSurfaceNiffis <= 50.0 - 0.90 + 1e-4, `expected surface Niffis to sink <= 49.10, got ${zSurfaceNiffis}`);

  // 3. Tall 1.8 m creature sinks by min(1.8 * 0.85, 1.8) = 1.53 m so its body sits underwater
  const zTall = _groundClampZ(wxWater, wyWater, 50.0, 10, s3d, tallMonsterInst, tallMonsterInst.meta);
  assert.ok(Math.abs(zTall - (50.0 - 1.53)) < 0.02, `expected ~48.47, got ${zTall}`);

  // 4. Flying creature (Wisp) over water is NOT sunk underwater
  assert.equal(isWaterSubmergibleCreature(wispMeta), false);
  const zWisp = _groundClampZ(wxWater, wyWater, 50.5, 10, s3d, null, wispMeta);
  assert.equal(zWisp, 50.5);

  // 5. Dry land still lifts buried entities up to terrainZ (50.0)
  const zDryBuried = _groundClampZ(wxDry, wyDry, 49.2, 1, s3d, null, niffisMeta);
  assert.equal(zDryBuried, 50.0);

  // 6. spawns.js bakeLandblockSpawns sinks outdoor water creature spawns automatically
  const baked = bakeLandblockSpawns(
    [
      {
        landblockId: 0xa9b40000,
        cell: 10,
        wcid: 7777,
        name: "Glissnal Niffis",
        category: "Creature",
        weenieType: 10,
        x: 36,
        y: 36,
        z: 50.0,
        free() {},
      },
    ],
    new Map([[7777, 0x02000333]]),
    s3d,
  );
  assert.equal(baked.submergedCount, 1);
  assert.equal(baked.pendingDispatches[0].upd.__waterSubmerged, true);
  assert.ok(baked.pendingDispatches[0].upd.z <= 49.10 + 1e-4);
});

await test("Fix 12A: EntityManager pose updates maintain submersion on water, unregister ashore/remove, and WeenieContactShadows skips water", () => {
  const lbX = 0xa9;
  const lbY = 0xb4;
  const wxWater = lbX * 192 + 36;
  const wyWater = lbY * 192 + 36;
  const wxDry = lbX * 192 + 12;
  const wyDry = lbY * 192 + 12;

  const s3d = makeWaterOracle({
    lbKey: 0xa9b40000,
    surfaceZ: 50.0,
    codesByCell: { "1,1": [17, 17, 17, 17] },
  });
  s3d.worldRoot = new THREE.Group();
  s3d.entitiesGroup = new THREE.Group();
  s3d.worldRoot.add(s3d.entitiesGroup);

  const em = new EntityManager(s3d, {});
  const root = new THREE.Group();
  const part = new THREE.Group();
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1.2, 1),
    new THREE.MeshStandardMaterial({ color: 0x44aa88 }),
  );
  part.add(mesh);
  root.add(part);

  const guid = 0x80001234;
  const inst = {
    guid,
    root,
    parts: [part],
    _outdoorCellIdx: 10,
    _stateVisible: true,
    meta: { guid, name: "Reed Shark", itemType: 0x10, landblockId: 0xa9b4000a },
    setPose(x, y, z) {
      root.position.set(x, y, z);
    },
    dispose() {},
  };
  em.entityMap.set(guid, inst);

  // Server sends surface Z = 50.0 on water -> setPose sinks & registers in _submergedWaterEntities / _submergedWaterMeshes
  em.setPose(guid, wxWater, wyWater, 50.0, 1, 0, 0, 0);
  assert.ok(root.position.z <= 49.10 + 1e-4, `setPose on water must keep Reed Shark underwater, got ${root.position.z}`);
  assert.equal(inst._isWaterSubmerged, true);
  assert.equal(s3d._submergedWaterEntities.has(guid), true);
  assert.equal(s3d._submergedWaterMeshes.has(mesh), true);

  // Contact shadows: skipped for submerged Reed Shark on water, drawn for dry-land creature!
  const dryRoot = new THREE.Group();
  dryRoot.position.set(wxDry, wyDry, 50.0);
  const dryGuid = 0x80005678;
  const dryInst = {
    guid: dryGuid,
    root: dryRoot,
    parts: [new THREE.Group()],
    _outdoorCellIdx: 1,
    _stateVisible: true,
    meta: { guid: dryGuid, name: "Banderling Scout", itemType: 0x10, landblockId: 0xa9b40001 },
    dispose() {},
  };
  em.entityMap.set(dryGuid, dryInst);

  const shadows = new WeenieContactShadows(s3d);
  const drawnShadows = shadows.update(em, {
    camera: { position: new THREE.Vector3(wxWater, 55, -wyWater) },
  });
  assert.equal(drawnShadows, 1, "only dry-land creature casts a contact shadow; water monster must cast 0");
  shadows.dispose();

  // Creature chases player onto dry shore -> automatically unregisters from underwater submersion pass!
  em.setPose(guid, wxDry, wyDry, 50.0, 1, 0, 0, 0);
  assert.equal(inst._isWaterSubmerged, false);
  assert.equal(s3d._submergedWaterEntities.size, 0);
  assert.equal(s3d._submergedWaterMeshes.size, 0);

  // Re-submerge and verify remove(guid) cleans up registry
  em.setPose(guid, wxWater, wyWater, 50.0, 1, 0, 0, 0);
  assert.equal(s3d._submergedWaterEntities.size, 1);
  em.remove(guid);
  assert.equal(s3d._submergedWaterEntities.size, 0);
  assert.equal(s3d._submergedWaterMeshes.size, 0);
  em.dispose();
});

// ---------------------------------------------------------------------------
// Fix 12B — Underwater Submersion Renderer (Early-Out, Prepass + EqualDepth,
//           Foreground Occlusion, Beer-Lambert, Caustics, Fresnel <= 0.78)
// ---------------------------------------------------------------------------
await test("Fix 12B: UnderwaterSubmersionRenderer 0-draw early-out + WebGL2 two-pass self-occluding aquatic composite", () => {
  const gl = createFakeWebGL2({ maxTextures: 16 });
  const canvas = fakeCanvas(gl, 640, 360);
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl });
  renderer.setSize(640, 360, false);

  const scene = new THREE.Scene();
  const worldRoot = new THREE.Group();
  worldRoot.rotation.x = -Math.PI / 2;
  scene.add(worldRoot);

  const camera = new THREE.PerspectiveCamera(60, 640 / 360, 0.1, 1000);
  // Camera at THREE (100, 56, -100) looking down at water surface Y = 50 (AC wx=100, wy=100, z=50)
  camera.position.set(100, 56, -100);
  camera.lookAt(100, 48.8, -106);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();

  const scene3d = {
    scene,
    worldRoot,
    camera,
    renderer,
    _terrainOracle: { heightAt: () => 50.0 },
  };

  const submersion = createUnderwaterSubmersionRenderer({ renderer, scene3d });
  const outputRt = new THREE.WebGLRenderTarget(640, 360);
  const stableDepthTex = new THREE.DepthTexture(640, 360);

  // 1. Empty registry -> 0.000 ms fast early-out, 0 GL draw calls!
  gl.__fake.reset();
  const drawsEmpty = submersion.render(renderer, outputRt, stableDepthTex, camera, 1.5);
  assert.equal(drawsEmpty, 0);
  assert.equal(submersion.stats().drawCalls, 0);
  assert.equal((gl.__fake.counts.drawElements || 0) + (gl.__fake.counts.drawArrays || 0), 0);

  // 2. Register a multi-part submerged monster (2 limb meshes) underwater at AC (100, 106, 48.8) -> THREE (100, 48.8, -106)
  const monsterRoot = new THREE.Group();
  monsterRoot.position.set(100, 106, 48.8);
  const limbA = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 1.2, 1.2),
    new THREE.MeshStandardMaterial({ color: 0x66aa99 }),
  );
  const limbB = new THREE.Mesh(
    new THREE.BoxGeometry(0.8, 0.8, 1.4),
    new THREE.MeshStandardMaterial({ color: 0x448877 }),
  );
  limbB.position.set(0.3, 0.2, 0.4);
  monsterRoot.add(limbA, limbB);
  worldRoot.add(monsterRoot);
  scene.updateMatrixWorld(true);

  const monsterInst = {
    guid: 0x80009999,
    root: monsterRoot,
    parts: [monsterRoot],
    _stateVisible: true,
    meta: { guid: 0x80009999, name: "Deep Shallows Lurker", itemType: 0x10 },
  };
  const wInfo = { overWater: true, waterType: "EntirelyWater", waterZ: 50.0, submergeM: 0.9 };
  syncEntityWaterSubmersion(scene3d, monsterInst, 100, 106, 48.8, wInfo);
  assert.equal(scene3d._submergedWaterEntities.size, 1);
  assert.equal(scene3d._submergedWaterMeshes.size, 2);

  // Far-away check (> 180 m): move camera 300 m away -> still 0 draw calls!
  camera.position.set(500, 56, -500);
  camera.lookAt(500, 48.8, -506);
  camera.updateMatrixWorld(true);
  gl.__fake.reset();
  assert.equal(
    submersion.render({
      renderer,
      camera,
      outputBuffer: outputRt,
      depthTexture: stableDepthTex,
      timeSec: 2.0,
    }),
    0,
  );
  assert.equal(submersion.stats().drawCalls, 0);
  assert.equal(MAX_UNDERWATER_RENDER_DIST_M, 180.0);

  // Move camera back in range (~8.6 m away) -> executes 2-pass self-occluding render + 1 composite triangle!
  camera.position.set(100, 56, -100);
  camera.lookAt(100, 48.8, -106);
  camera.updateMatrixWorld(true);
  gl.__fake.reset();
  const drawsActive = submersion.render(renderer, outputRt, stableDepthTex, camera, 3.25);
  // 2 limb meshes × 2 passes (depth prepass + EqualDepth color) + 1 fullscreen composite = 5 draw calls
  assert.equal(drawsActive, 5);
  assert.equal(submersion.stats().visibleEntities, 1);
  assert.equal(submersion.stats().drawCalls, 5);

  // Verify shader contracts on the compiled materials
  const preMat = submersion._materials.depthPrepassMaterial;
  const colMat = submersion._materials.aquaticColorMaterial;
  const cmpMat = submersion._materials.compositeMaterial;

  assert.equal(preMat.colorWrite, false, "Pass 1 depth prepass must mask color writes");
  assert.equal(preMat.depthWrite, true);
  assert.equal(colMat.depthFunc, THREE.EqualDepth, "Pass 2 aquatic color pass must use EqualDepth to eliminate limb alpha-stacking");
  assert.equal(colMat.depthWrite, false);
  assert.equal(cmpMat.blending, THREE.CustomBlending);
  assert.equal(cmpMat.blendSrc, THREE.SrcAlphaFactor);
  assert.equal(cmpMat.blendDst, THREE.OneMinusSrcAlphaFactor);

  // Verify GLSL equations required by Fix 12B
  assert.match(colMat.fragmentShader, /vWorldPos\.y >= uWaterSurfaceY - 0\.01/);
  assert.match(colMat.fragmentShader, /sceneLinearDepth < expectedWaterDepth - 0\.45/);
  assert.match(colMat.fragmentShader, /uReversedZActive/);
  assert.match(colMat.fragmentShader, /uLogDepthActive/);
  assert.match(colMat.fragmentShader, /exp\(-vec3\(0\.55,\s*0\.22,\s*0\.16\)\s*\*\s*submergeDepth\)/);
  assert.match(colMat.fragmentShader, /dualWaveCaustics/);
  assert.match(colMat.fragmentShader, /clamp\(transmissionAlpha,\s*0\.0,\s*0\.78\)/);
  assert.equal(FOREGROUND_OCCLUSION_BIAS_M, 0.45);
  assert.equal(MAX_TRANSMISSION_ALPHA, 0.78);

  // Also verify composer Pass adapter API
  const pass = submersion.createPass(camera);
  assert.equal(pass.needsSwap, false);
  assert.equal(pass.needsDepthTexture, true);
  pass.setDepthTexture(stableDepthTex, 0);
  pass.render(renderer, outputRt, null, 0.016);

  unregisterSubmergedEntity(scene3d, monsterInst.guid, monsterInst);
  submersion.dispose();
  outputRt.dispose();
  stableDepthTex.dispose();
  renderer.dispose();
});

console.log(`\n[holtburg_night_and_underwater] ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
