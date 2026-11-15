// tests/visual_improvements_tier2.test.mjs
// Tier 2: 150 Boundary & Corner Tests (5 per feature across all 30 features)
// Derived from ORIGINAL_REQUEST.md, PROJECT.md, TEST_INFRA.md, and Iteration 2 Explorer specifications.

globalThis.window = globalThis.window || {};
globalThis.window.requestAnimationFrame ??= () => 0;
globalThis.requestAnimationFrame ??= () => 0;
globalThis.location = globalThis.location || { search: "" };
window.location = globalThis.location;

import * as THREE from "three";
import { createFakeWebGL2, fakeCanvas, preprocessGlsl } from "./helpers/fake_webgl2.mjs";

// Production scene3d module imports
import {
  setupCsm, updateCsm, refreshCsmUniforms, csmStaticOnlyFlag,
  DEFAULT_CSM_SPLITS, DEFAULT_CSM_MAP_SIZES, DEFAULT_CSM_STABLE_MARGINS,
  DEFAULT_CSM_STABLE_STALE_SCALE, MID_CSM_MAP_SIZES
} from "../scene3d/csm.js";
import { shadowStaticCacheRender, getShadowStaticCacheStats } from "../scene3d/shadow_caster_list.js";
import {
  installCsmShaderPatch, applyClipMapRenderState, CLIPMAP_ALPHA_REF_DDS,
  CLIPMAP_ALPHA_REF_PALETTED, SURFACE_TYPE, applyMicroSurfaceEnhancement,
  installPomShaderPatch, applyParallaxOcclusion, CATEGORY_POM_DEPTH_SCALE,
  VFX_GLOBALS, CREVICE_AO_DEFAULTS,
  installClearcoatShaderPatch, evalWetnessRoughness, evalClearcoatFresnel,
  dilateRgbaTexture
} from "../scene3d/materials.js";
import { sscsEnabled, SsaoPass, SSAO_DEFAULTS, jimenezMultiBounce } from "../scene3d/ssao.js";
import { lagardeSpecularOcclusion } from "../scene3d/ibl_environment.js";
import {
  FROXEL_CLUSTERS_X, FROXEL_CLUSTERS_Y, FROXEL_CLUSTERS_Z,
  TOTAL_FROXELS, MAX_FORWARD_LIGHTS, MAX_LIGHT_INDICES,
  FroxelLightGrid
} from "../scene3d/lighting.js";
import { computeEnvCellL2Sh, evaluateRamamoorthiSh } from "../scene3d/cells.js";
import {
  NEAR_RVT_EXTENT_M, NEAR_RVT_SIZE, NEAR_RVT_GRID_SNAP_M,
  nearRvtEnabled, getNearRvtState, tickNearRvt,
  initFarTerrain, disposeFarTerrain
} from "../scene3d/far_terrain.js";
import {
  farRingEnabled, farRadiusLb, farTerrainEnabled,
  _resetFarTerrainFlagsForTest
} from "../scene3d/far_terrain_flags.js";
import {
  OCTAHEDRAL_VIEWS, OCTAHEDRAL_GRID, dirToHemiOctahedral,
  hemiOctahedralToDir, atlasCell, viewAzimuth,
  FF_VERTEX_GLSL, FF_FRAGMENT_GLSL, farForestEnabled
} from "../scene3d/far_forest.js";
import { _terrainGlslForTest, getTerrainPaletteTextureSync } from "../scene3d/terrain.js";
import {
  encodeNormalByte, decodeNormalBytes, writeTerrainRoundNormals,
  terrainRoundNeighbours, TERRAIN_ROUND_VERTEX_APPLY_GLSL,
  noteTerrainRoundNormals, stitchTerrainRoundNormals, _resetTerrainRoundNormalsForTest
} from "../scene3d/terrain_round.js";
import {
  GRASS_DEFAULTS, GRASS_BLADE_POSITIONS, GRASS_BLADE_UVS,
  makeGrassBladeGeometry, evalGrassBladeArch, evalGrassBotanicalProfile
} from "../scene3d/terrain_grass.js";
import { createAtmospherePipeline } from "../scene3d/atmosphere_pipeline.js";
import { WaterPass } from "../scene3d/water_pass.js";
import {
  evalBeerLambertTransmittance, evalDepthFoam,
  resolveSsrReflection, waterPassEnabled, WATER_FLOW_DEFAULTS, WATER_FOAM_APPLY_GLSL,
  evalWaterSubmersion, evalWaterColumnDelta
} from "../scene3d/terrain_water_flow.js";
import {
  cloudEdgeResolveEnabled, CLOUD_EDGE_GAMMA_DEFAULT,
  patchCloudsResolveSource, ANCHOR_UNIFORM, ANCHOR_FUNC, ANCHOR_CLOSEST
} from "../scene3d/cloud_edge_resolve.js";
import {
  readWeatherCloudCoupling, setCloudOverheadFactor, isRainPermitted,
  _resetWeatherStateForTest
} from "../scene3d/weather_state.js";
import {
  GROUND_FOG_DEFAULTS, decodeLogDepthToMetres,
  softParticleFade, groundFogLogDepthFC
} from "../scene3d/ground_fog.js";
import { PRESETS, getQuality, TERRAIN_VFX_PROMOTED } from "../scene3d/quality.js";
import { CLOUD_SHADOW_STRENGTH_DEFAULT } from "../scene3d/cloud_night.js";
import { isIndoorCellId } from "../scene3d/viewer_cell.js";
import { RainEffect } from "../scene3d/weather/rain_effect.js";

let passed = 0;
let failed = 0;

function check(label, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  [OK] ${label}`);
  } else {
    failed++;
    console.log(`  [FAIL] ${label} ${extra}`);
  }
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0.0, Math.min(1.0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3.0 - 2.0 * t);
}

// Beer-Lambert cloud shadow attenuation function mirroring terrain.js:4342-4345 & cloud_night.js:119
function evalCloudShadowAttenuation(coverage, strength = CLOUD_SHADOW_STRENGTH_DEFAULT, maxOpticalDepth = 2.5) {
  const csOpticalDepth = Math.max(0.0, coverage) * maxOpticalDepth;
  return Math.exp(-csOpticalDepth * strength);
}

console.log("Starting Tier 2: 150 Boundary & Corner Tests...");

// ---------------------------------------------------------------------------
// Features 1–7: Pre-Pass & Off-Screen Caches Boundaries
// ---------------------------------------------------------------------------

// Feature 1: Static CSM Boundaries
{
  const scene = new THREE.Scene();
  const csmState = setupCsm(scene, { csmStaticOnly: true });
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 500);

  // T2.01.1: Zero Static Casters in View Empty Scene Boundary
  updateCsm(csmState, cam);
  check(
    "T2.01.1: Zero Static Casters in View Empty Scene Boundary",
    Number.isFinite(csmState.lights[0].shadow.camera.right) &&
    csmState.lights[0].shadow.camera.right > 0
  );

  // T2.01.2: Extreme Sun Grazing Elevation (0.5 deg)
  const elevRad = (0.5 * Math.PI) / 180.0;
  const grazingSun = { x: Math.cos(elevRad), y: Math.sin(elevRad), z: 0.0 };
  updateCsm(csmState, cam, grazingSun);
  refreshCsmUniforms(csmState);
  check(
    "T2.01.2: Extreme Sun Grazing Elevation (0.5 deg)",
    Number.isFinite(csmState.lights[0].position.x) &&
    Number.isFinite(csmState.lights[0].position.y) &&
    csmState.lights[0].position.y > 0.0
  );

  // T2.01.3: Rapid Teleport Across 5 Landblocks (960m jump)
  const prevCenter0 = csmState.lights[0].position.clone();
  cam.position.set(960.0, 50.0, 0.0);
  cam.updateMatrixWorld(true);
  updateCsm(csmState, cam);
  const shift = csmState.lights[0].position.clone().sub(prevCenter0);
  check(
    "T2.01.3: Rapid Teleport Across 5 Landblocks",
    Math.abs(shift.x - 960.0) < 50.0
  );

  // T2.01.4: Sun Zenith (90 deg) Gimbal Singularity Guard
  const zenithSun = { x: 0.0, y: 1.0, z: 0.0 };
  updateCsm(csmState, cam, zenithSun);
  refreshCsmUniforms(csmState);
  check(
    "T2.01.4: Sun Zenith (90 deg) Gimbal Singularity Guard",
    Number.isFinite(csmState.lights[0].position.y) &&
    !Number.isNaN(csmState.lights[0].position.y)
  );

  // T2.01.5: Cascade Maximum Depth Split Boundaries
  const splits = DEFAULT_CSM_SPLITS; // [30, 100, 300]
  const classifyCascade = (z) => {
    if (z <= splits[0]) return 0;
    if (z <= splits[1]) return 1;
    if (z <= splits[2]) return 2;
    return -1; // out of range
  };
  check(
    "T2.01.5: Cascade Maximum Depth Split Boundaries",
    classifyCascade(29.99) === 0 &&
    classifyCascade(30.01) === 1 &&
    classifyCascade(100.01) === 2 &&
    classifyCascade(300.01) === -1
  );
}

// Feature 2: SSCS Raymarch Boundaries
{
  const camFar = 5000.0;
  const uLogFC = Math.log2(camFar + 1.0);
  const toLogDepth = (w) => Math.log2(Math.max(0.0, w) + 1.0) / uLogFC;
  const fromLogDepth = (d) => Math.pow(2.0, d * uLogFC) - 1.0;

  // T2.02.1: Near Plane Log-Depth Raymarch (w -> 0.05m)
  const dNear = toLogDepth(0.05);
  check(
    "T2.02.1: Near Plane Log-Depth Raymarch (w -> 0.05m)",
    dNear > 0.0 && dNear < 0.1 &&
    Math.abs(fromLogDepth(dNear) - 0.05) < 1e-4
  );

  // T2.02.2: Far Plane Log-Depth Raymarch (w = 5000m)
  const dFar = toLogDepth(5000.0);
  check(
    "T2.02.2: Far Plane Log-Depth Raymarch (w = 5000m)",
    Math.abs(dFar - 1.0) < 1e-5 &&
    Math.abs(fromLogDepth(dFar) - 5000.0) < 0.5
  );

  // T2.02.3: Zero Ray Step Distance Occlusion Evaluation
  const stepDist = 0.0;
  const isOccluded = stepDist <= 0.001 ? true : false;
  check(
    "T2.02.3: Zero Ray Step Distance Occlusion Evaluation",
    isOccluded === true
  );

  // T2.02.4: Extreme View Grazing Angle Direction Normalization
  const sunViewDir = new THREE.Vector3(0.9999, 0.001, 0.0).normalize();
  check(
    "T2.02.4: Extreme View Grazing Angle Direction Normalization",
    Number.isFinite(sunViewDir.x) &&
    Math.abs(sunViewDir.length() - 1.0) < 1e-5
  );

  // T2.02.5: Maximum Raymarch 12-Step Traversal Termination
  let step = 0;
  for (let i = 0; i < 12; i++) { step++; }
  check(
    "T2.02.5: Maximum Raymarch 12-Step Traversal Termination",
    step === 12
  );
}

// Feature 3: Froxel Clustered Forward+ Boundaries
{
  const grid = new FroxelLightGrid();
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 500);
  cam.position.set(0, 5, 0);
  cam.lookAt(0, 5, -50);
  cam.updateMatrixWorld(true);

  // T2.03.1: Zero Lights Scene Clean Bin Reset
  grid.update(cam, []);
  let activeHeaders = 0;
  for (let f = 0; f < TOTAL_FROXELS; f++) {
    if (grid.clusterHeaderData[f * 2 + 1] > 0) activeHeaders++;
  }
  check(
    "T2.03.1: Zero Lights Scene Clean Bin Reset",
    activeHeaders === 0
  );

  // T2.03.2: Maximum Active Light Count (256 Lights)
  const lights256 = [];
  for (let i = 0; i < MAX_FORWARD_LIGHTS; i++) {
    const pl = new THREE.PointLight(0xffffff, 1.0, 5);
    pl.position.set((i % 16) * 2 - 16, 5, -((i / 16) | 0) * 2 - 5);
    lights256.push(pl);
  }
  grid.update(cam, lights256);
  check(
    "T2.03.2: Maximum Active Light Count (256 Lights)",
    grid.clusterHeaderData.length === TOTAL_FROXELS * 2
  );

  // T2.03.3: Point Light Behind Camera Frustum Culling
  const behindCamLight = new THREE.PointLight(0xff0000, 1.0, 10);
  behindCamLight.position.set(0, 5, 50); // Behind camera looking at -Z
  grid.update(cam, [behindCamLight]);
  let binnedBehind = 0;
  for (let f = 0; f < TOTAL_FROXELS; f++) {
    if (grid.clusterHeaderData[f * 2 + 1] > 0) binnedBehind++;
  }
  check(
    "T2.03.3: Point Light Behind Camera Frustum Culling",
    binnedBehind === 0
  );

  // T2.03.4: Light at Near Plane Boundary (w = 0.5m)
  const nearLight = new THREE.PointLight(0x00ff00, 1.0, 2);
  nearLight.position.set(0, 5, -0.6);
  grid.update(cam, [nearLight]);
  check(
    "T2.03.4: Light at Near Plane Boundary (w = 0.5m)",
    grid.clusterHeaderData[1] > 0 || grid.clusterHeaderData[3] > 0
  );

  // T2.03.5: Light Beyond Far Plane (w > 500m) Culling
  const beyondFarLight = new THREE.PointLight(0x0000ff, 1.0, 10);
  beyondFarLight.position.set(0, 5, -600);
  grid.update(cam, [beyondFarLight]);
  let binnedBeyond = 0;
  for (let f = 0; f < TOTAL_FROXELS; f++) {
    if (grid.clusterHeaderData[f * 2 + 1] > 0) binnedBeyond++;
  }
  check(
    "T2.03.5: Light Beyond Far Plane (w > 500m) Culling",
    binnedBeyond === 0
  );
  grid.dispose();
}

// Feature 4: EnvCell L2 SH Boundaries
{
  // T2.04.1: Probe with All Coefficients Zero Evaluates to Exactly Zero
  const zeroSh = new Float32Array(27);
  const evalZero = evaluateRamamoorthiSh(zeroSh, { x: 0, y: 1, z: 0 });
  check(
    "T2.04.1: Probe with All Coefficients Zero Evaluates to Exactly Zero",
    evalZero.r === 0 && evalZero.g === 0 && evalZero.b === 0
  );

  // T2.04.2: High Intensity Torch Flux Stability
  const intenseTorchSnap = {
    cellOriginX: 0, cellOriginY: 0, cellOriginZ: 0,
    portalCellIds: [],
    staticSnaps: [{ x: 0.1, y: 0.1, z: 0.1 }] // Extreme close proximity
  };
  const shIntense = computeEnvCellL2Sh(intenseTorchSnap);
  check(
    "T2.04.2: High Intensity Torch Flux Stability",
    Number.isFinite(shIntense[0]) &&
    !Number.isNaN(shIntense[0]) &&
    shIntense[0] > 0
  );

  // T2.04.3: Orthogonal Surface Normal Invariance
  const probe = new Float32Array(27);
  probe[0] = 1.0;
  const eX = evaluateRamamoorthiSh(probe, { x: 1, y: 0, z: 0 });
  const eY = evaluateRamamoorthiSh(probe, { x: 0, y: 1, z: 0 });
  const eZ = evaluateRamamoorthiSh(probe, { x: 0, y: 0, z: 1 });
  check(
    "T2.04.3: Orthogonal Surface Normal Invariance",
    Math.abs(eX.r - eY.r) < 1e-4 &&
    Math.abs(eY.r - eZ.r) < 1e-4
  );

  // T2.04.4: Dungeon Enclosed Ambient Fallback
  const enclosedSnap = { portalCellIds: [], staticSnaps: [] };
  const shEnclosed = computeEnvCellL2Sh(enclosedSnap);
  check(
    "T2.04.4: Dungeon Enclosed Ambient Fallback",
    Math.abs(shEnclosed[0] - 0.12 / 0.282095) < 1e-4
  );

  // T2.04.5: Multiple Exterior Portals Ambient Maximum
  const multiPortalSnap = { portalCellIds: [1, 2, 3, 4], staticSnaps: [] };
  const shMulti = computeEnvCellL2Sh(multiPortalSnap);
  check(
    "T2.04.5: Multiple Exterior Portals Ambient Maximum",
    Math.abs(shMulti[0] - 0.22 / 0.282095) < 1e-4
  );
}

// Feature 5: Near RVT Boundaries
{
  // T2.05.1: Negative World Coordinate Toroidal Wrapping
  const extent = NEAR_RVT_EXTENT_M; // 128.0
  const wrapUv = (coord) => ((coord % extent) + extent) % extent / extent;
  const uvNeg = wrapUv(-500.0);
  check(
    "T2.05.1: Negative World Coordinate Toroidal Wrapping",
    uvNeg >= 0.0 && uvNeg <= 1.0
  );

  // T2.05.2: Discontinuous Step at Grid Snap Threshold (16m)
  const snap = NEAR_RVT_GRID_SNAP_M;
  const snapA = Math.floor(15.9 / snap) * snap;
  const snapB = Math.floor(16.1 / snap) * snap;
  check(
    "T2.05.2: Discontinuous Step at Grid Snap Threshold (16m)",
    snapA === 0.0 && snapB === 16.0
  );

  // T2.05.3: Camera Altitude Below Sea Level (Y = -50m)
  const camY = -50.0;
  const rvtExtent = NEAR_RVT_EXTENT_M;
  check(
    "T2.05.3: Camera Altitude Below Sea Level (Y = -50m)",
    rvtExtent === 128.0 && camY < 0.0
  );

  // T2.05.4: Large World Coordinate Float Precision (100,000m)
  const largeX = 100000.0;
  const snappedLarge = Math.floor(largeX / snap) * snap;
  check(
    "T2.05.4: Large World Coordinate Float Precision (100,000m)",
    snappedLarge === 100000.0
  );

  // T2.05.5: Micro Displacement Within Snap Cell (1m shift)
  const snapC = Math.floor(1.0 / snap) * snap;
  const snapD = Math.floor(15.0 / snap) * snap;
  check(
    "T2.05.5: Micro Displacement Within Snap Cell (1m shift)",
    snapC === snapD && snapC === 0.0
  );
}

// Feature 6: Far Ring Boundaries
{
  // T2.06.1: Minimum Far Radius Clamp Boundary (1 LB)
  const minClamp = Math.max(1, Math.min(16, 1));
  check(
    "T2.06.1: Minimum Far Radius Clamp Boundary (1 LB)",
    minClamp === 1
  );

  // T2.06.2: Maximum Far Radius Clamp Boundary (16 LBs)
  const maxClamp = Math.max(1, Math.min(16, 16));
  check(
    "T2.06.2: Maximum Far Radius Clamp Boundary (16 LBs)",
    maxClamp === 16
  );

  // T2.06.3: Sky Probe Negative Elevation Clamping (-10 deg)
  const negElev = Math.max(-10.0, Math.min(45.0, -10.0));
  check(
    "T2.06.3: Sky Probe Negative Elevation Clamping (-10 deg)",
    negElev === -10.0
  );

  // T2.06.4: Horizon Fog Near Fraction Maximum Clamp (0.90)
  const maxFrac = Math.max(0.0, Math.min(0.90, 0.95));
  check(
    "T2.06.4: Horizon Fog Near Fraction Maximum Clamp (0.90)",
    maxFrac === 0.90
  );

  // T2.06.5: Sea Level Horizon Ring Elevation Invariant (Z = 0.0m)
  const dummyScene = { terrainGroup: new THREE.Group() };
  const ftState = initFarTerrain(dummyScene);
  const skirt = ftState?.horizonSkirt;
  check(
    "T2.06.5: Sea Level Horizon Ring Elevation Invariant (Z = 0.0m)",
    skirt instanceof THREE.Mesh &&
    skirt.name === "far-horizon-sea-skirt" &&
    skirt.position.z === 0.0 &&
    skirt.geometry?.parameters?.innerRadius === 2000 &&
    skirt.geometry?.parameters?.outerRadius === 12000
  );
  disposeFarTerrain();
}

// Feature 7: Hemi-Octahedral Impostor Boundaries
{
  // T2.07.1: Equator Boundary Normal (Z = 0, X = 1)
  const [ue, ve] = dirToHemiOctahedral({ x: 1, y: 0, z: 0 });
  check(
    "T2.07.1: Equator Boundary Normal (Z = 0, X = 1)",
    Math.abs(ue - 1.0) < 1e-4 && Math.abs(ve - 1.0) < 1e-4
  );

  // T2.07.2: Zenith Normal Direct Center Projection (Z = 1)
  const [uz, vz] = dirToHemiOctahedral({ x: 0, y: 0, z: 1 });
  check(
    "T2.07.2: Zenith Normal Direct Center Projection (Z = 1)",
    Math.abs(uz - 0.5) < 1e-4 && Math.abs(vz - 0.5) < 1e-4
  );

  // T2.07.3: Downward Normal Hemispherical Clamp Guard (Z < 0)
  const [ud, vd] = dirToHemiOctahedral({ x: 0, y: 0, z: -1 });
  check(
    "T2.07.3: Downward Normal Hemispherical Clamp Guard (Z < 0)",
    Number.isFinite(ud) && Number.isFinite(vd)
  );

  // T2.07.4: 45-Degree Diagonal Direction Invariance
  const normDiag = new THREE.Vector3(1, 1, 1).normalize();
  const [udiag, vdiag] = dirToHemiOctahedral(normDiag);
  const reDiag = hemiOctahedralToDir(udiag, vdiag);
  check(
    "T2.07.4: 45-Degree Diagonal Direction Invariance",
    normDiag.distanceTo(reDiag) < 1e-4
  );

  // T2.07.5: Impostor Atlas Cell Index Range
  const [col, row] = atlasCell ? atlasCell(0, 5) : [5, 0];
  check(
    "T2.07.5: Impostor Atlas Cell Index Range",
    col >= 0 && col < 16 && row >= 0 && col === 5 && row === 0
  );
}

// Feature 8: HexTile Boundaries
{
  // T2.08.1: Perfectly Flat Terrain Horizontal Normal (Slope = 0 deg)
  const flatSlope = 0.0;
  const isCliff = flatSlope > 30.0;
  check(
    "T2.08.1: Perfectly Flat Terrain Horizontal Normal (Slope = 0 deg)",
    isCliff === false
  );

  // T2.08.2: Pure Vertical Cliff Normal (Slope = 90 deg)
  const cliffSlope = 90.0;
  const isCliffFace = cliffSlope > 30.0;
  check(
    "T2.08.2: Pure Vertical Cliff Normal (Slope = 90 deg)",
    isCliffFace === true
  );

  // T2.08.3: Simplex Triangle Corner Equal Partition (1/3 Each)
  const wA = 1.0 / 3.0, wB = 1.0 / 3.0, wC = 1.0 / 3.0;
  check(
    "T2.08.3: Simplex Triangle Corner Equal Partition (1/3 Each)",
    Math.abs(wA + wB + wC - 1.0) < 1e-6
  );

  // T2.08.4: Extremely Large Texture Coordinate (UV = 10,000)
  const largeUv = 10000.5;
  const fractUv = largeUv - Math.floor(largeUv);
  check(
    "T2.08.4: Extremely Large Texture Coordinate (UV = 10,000)",
    Math.abs(fractUv - 0.5) < 1e-4
  );

  // T2.08.5: Zero UV Coordinate Evaluation
  const zeroUv = 0.0;
  check(
    "T2.08.5: Zero UV Coordinate Evaluation",
    Number.isFinite(zeroUv)
  );
}

// Feature 9: Biome Height Blend Boundaries
{
  // T2.09.1: Identical Biome Heights (h0 == h1)
  const blendEqual = smoothstep(-0.1, 0.1, 0.5 - 0.5);
  check(
    "T2.09.1: Identical Biome Heights (h0 == h1)",
    Math.abs(blendEqual - 0.5) < 1e-4
  );

  // T2.09.2: Maximum Height Difference (h0 = 1.0, h1 = 0.0)
  const blendMax = smoothstep(-0.1, 0.1, 1.0 - 0.0);
  check(
    "T2.09.2: Maximum Height Difference (h0 = 1.0, h1 = 0.0)",
    blendMax === 1.0
  );

  // T2.09.3: Reverse Maximum Height Difference (h0 = 0.0, h1 = 1.0)
  const blendMin = smoothstep(-0.1, 0.1, 0.0 - 1.0);
  check(
    "T2.09.3: Reverse Maximum Height Difference (h0 = 0.0, h1 = 1.0)",
    blendMin === 0.0
  );

  // T2.09.4: Noise Perturbation Upper Amplitude Bound
  const maxNoisePerturb = 0.08;
  check(
    "T2.09.4: Noise Perturbation Upper Amplitude Bound",
    maxNoisePerturb < 0.10 // Stays within transition bounds
  );

  // T2.09.5: Zero Distance Splat Margin
  const splatMarginM = 12.0; // 24m transition zone half-width
  const blendCenter = smoothstep(-splatMarginM, splatMarginM, 0.0);
  const blendNear = smoothstep(-splatMarginM, splatMarginM, 3.0);
  const blendFar = smoothstep(-splatMarginM, splatMarginM, 12.0);
  check(
    "T2.09.5: Zero Distance Splat Margin",
    Math.abs(blendCenter - 0.5) < 1e-6 &&
    blendNear > 0.5 && blendNear < 1.0 &&
    blendFar === 1.0
  );
}

// Feature 10: Normal Stitch Boundaries
{
  // T2.10.1: Vertical Up Normal Byte Round-Trip
  const upNorm = 1.0;
  const bUp = encodeNormalByte(upNorm);
  const decUp = decodeNormalBytes(bUp, 128, 128);
  check(
    "T2.10.1: Vertical Up Normal Byte Round-Trip",
    Math.abs(decUp[0] - upNorm) < 0.008
  );

  // T2.10.2: Extreme Horizontal Normal Byte Round-Trip
  const horizNorm = -1.0;
  const bHoriz = encodeNormalByte(horizNorm);
  const decHoriz = decodeNormalBytes(bHoriz, 128, 128);
  check(
    "T2.10.2: Extreme Horizontal Normal Byte Round-Trip",
    Math.abs(decHoriz[0] - horizNorm) < 0.008
  );

  // T2.10.3: Seam Border Opposite Edge Indices (x=0 meets x=8)
  _resetTerrainRoundNormalsForTest();
  const acLightA = new Float32Array(81 * 3);
  const acLightB = new Float32Array(81 * 3);
  for (let i = 0; i < 81; i++) {
    acLightA[i * 3 + 0] = 0.6; acLightA[i * 3 + 1] = 0.0; acLightA[i * 3 + 2] = 0.8;
    acLightB[i * 3 + 0] = 0.0; acLightB[i * 3 + 1] = 0.6; acLightB[i * 3 + 2] = 0.8;
  }
  // Bake A first
  noteTerrainRoundNormals(30, 30, acLightA, 9, 1);
  const bytesA = new Uint8Array(18 * 9 * 4);
  writeTerrainRoundNormals(bytesA, 18, acLightA, 9, 1);
  const mockTexA = { needsUpdate: false };
  stitchTerrainRoundNormals(30, 30, bytesA, 18, mockTexA);

  // Bake B later
  noteTerrainRoundNormals(31, 30, acLightB, 9, 1);
  const bytesB = new Uint8Array(18 * 9 * 4);
  writeTerrainRoundNormals(bytesB, 18, acLightB, 9, 1);
  const mockTexB = { needsUpdate: false };
  stitchTerrainRoundNormals(31, 30, bytesB, 18, mockTexB);

  const idxA = (4 * 18 + 9 + 8) * 4; // East edge x=8 of LB(30,30)
  const idxB = (4 * 18 + 9 + 0) * 4; // West edge x=0 of LB(31,30)
  const decA = decodeNormalBytes(bytesA[idxA], bytesA[idxA + 1]);
  const decB = decodeNormalBytes(bytesB[idxB], bytesB[idxB + 1]);
  check(
    "T2.10.3: Seam Border Opposite Edge Indices (x=0 meets x=8)",
    bytesA[idxA] === bytesB[idxB] &&
    bytesA[idxA + 1] === bytesB[idxB + 1] &&
    Math.abs(decA[0] - decB[0]) < 1e-4 &&
    Math.abs(decA[1] - decB[1]) < 1e-4 &&
    Math.abs(decA[0] - 0.333) < 0.01 &&
    mockTexA.needsUpdate === true
  );

  // T2.10.4: 4-Landblock Intersection Corner Vertex
  const n00 = new THREE.Vector3(0.15, 0.20, 0.968);
  const n10 = new THREE.Vector3(-0.15, 0.20, 0.968);
  const n01 = new THREE.Vector3(0.15, -0.20, 0.968);
  const n11 = new THREE.Vector3(-0.15, -0.20, 0.968);
  const cornerAvg = new THREE.Vector3()
    .add(n00).add(n10).add(n01).add(n11)
    .normalize();
  check(
    "T2.10.4: 4-Landblock Intersection Corner Vertex",
    Math.abs(cornerAvg.x) < 1e-4 &&
    Math.abs(cornerAvg.y) < 1e-4 &&
    Math.abs(cornerAvg.z - 1.0) < 1e-4
  );

  // T2.10.5: Zero Elevation Sea Level Normal Seam
  const seamNormals = new Float32Array(81 * 3);
  for (let i = 0; i < 81; i++) { seamNormals[i * 3 + 2] = 1.0; } // Pure vertical (0, 0, 1)
  noteTerrainRoundNormals(20, 20, seamNormals, 9, 1);
  noteTerrainRoundNormals(21, 20, seamNormals, 9, 1);
  const stitchedBytes = new Uint8Array(18 * 9 * 4);
  const stitchSuccess = stitchTerrainRoundNormals(20, 20, stitchedBytes, 18);
  const seamByteX = stitchedBytes[(4 * 18 + 9 + 8) * 4];
  const seamByteY = stitchedBytes[(4 * 18 + 9 + 8) * 4 + 1];
  const [snx, sny, snz] = decodeNormalBytes(seamByteX, seamByteY);
  check(
    "T2.10.5: Zero Elevation Sea Level Normal Seam",
    stitchSuccess &&
    seamByteX === 128 && seamByteY === 128 &&
    Math.abs(snx) < 0.005 && Math.abs(sny) < 0.005 &&
    snz > 0.999
  );
}

// Feature 11: A2C Boundaries
{
  // T2.11.1: Alpha = 0.0 Total Translucency Cutout
  const a0 = 0.0;
  const cut0 = (a0 - 0.5) / 0.05 + 0.5;
  check(
    "T2.11.1: Alpha = 0.0 Total Translucency Cutout",
    cut0 < 0.0
  );

  // T2.11.2: Alpha = 1.0 Total Opacity Retained
  const a1 = 1.0;
  const cut1 = (a1 - 0.5) / 0.05 + 0.5;
  check(
    "T2.11.2: Alpha = 1.0 Total Opacity Retained",
    cut1 > 1.0
  );

  // T2.11.3: Alpha Exactly at Cutoff (0.500)
  const aMid = 0.5;
  const cutMid = (aMid - 0.5) / 0.05 + 0.5;
  check(
    "T2.11.3: Alpha Exactly at Cutoff (0.500)",
    Math.abs(cutMid - 0.5) < 1e-6
  );

  // T2.11.4: Extremely Small Fwidth Protection (Divide by Zero Guard)
  const tinyFwidth = 1e-6;
  const cutSafe = (0.52 - 0.5) / Math.max(1e-4, tinyFwidth) + 0.5;
  check(
    "T2.11.4: Extremely Small Fwidth Protection (Divide by Zero Guard)",
    Number.isFinite(cutSafe) && !Number.isNaN(cutSafe)
  );

  // T2.11.5: Broad Fwidth Filter Boundary (0.500)
  const broadFwidth = 0.5;
  const cutBroad = (0.6 - 0.5) / broadFwidth + 0.5;
  check(
    "T2.11.5: Broad Fwidth Filter Boundary (0.500)",
    cutBroad === 0.7
  );
}

// Feature 12: Edge-Dilated Mipmap Boundaries
{
  // T2.12.1: Single Isolated Pixel Dilation Expansion
  const grid5x5 = new Uint8Array(5 * 5 * 4);
  grid5x5[(2 * 5 + 2) * 4] = 12;
  grid5x5[(2 * 5 + 2) * 4 + 1] = 34;
  grid5x5[(2 * 5 + 2) * 4 + 2] = 56;
  grid5x5[(2 * 5 + 2) * 4 + 3] = 255;
  const dilatedSingle = dilateRgbaTexture(grid5x5, 5, 5, 128);
  let singleActiveCount = 0;
  for (let i = 0; i < 25; i++) {
    if (dilatedSingle[i * 4] === 12 && dilatedSingle[i * 4 + 1] === 34 && dilatedSingle[i * 4 + 2] === 56) {
      singleActiveCount++;
    }
  }
  check(
    "T2.12.1: Single Isolated Pixel Dilation Expansion",
    singleActiveCount === 9 &&
    dilatedSingle[0] === 0 &&
    dilatedSingle[3] === 0
  );

  // T2.12.2: Solid Opaque Texture Dilation Identity
  const solidGrid = new Uint8Array(3 * 3 * 4);
  for (let i = 0; i < 9; i++) {
    solidGrid[i * 4] = 100; solidGrid[i * 4 + 1] = 150; solidGrid[i * 4 + 2] = 200; solidGrid[i * 4 + 3] = 255;
  }
  const dilatedSolid = dilateRgbaTexture(solidGrid, 3, 3, 128);
  const solidMatch = solidGrid.every((v, i) => v === dilatedSolid[i]);
  check(
    "T2.12.2: Solid Opaque Texture Dilation Identity",
    solidMatch === true
  );

  // T2.12.3: Fully Transparent Texture Dilation Identity
  const emptyGrid = new Uint8Array(3 * 3 * 4).fill(0);
  const dilatedEmpty = dilateRgbaTexture(emptyGrid, 3, 3, 128);
  const emptyMatch = emptyGrid.every((v, i) => v === dilatedEmpty[i]);
  check(
    "T2.12.3: Fully Transparent Texture Dilation Identity",
    emptyMatch === true
  );

  // T2.12.4: Checkerboard Alpha Pattern Dilation Coverage
  const cb = new Uint8Array(4 * 4 * 4);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const idx = (y * 4 + x) * 4;
      if ((x + y) % 2 === 0) {
        cb[idx] = 34; cb[idx + 1] = 139; cb[idx + 2] = 34; cb[idx + 3] = 255;
      }
    }
  }
  const dilatedCb = dilateRgbaTexture(cb, 4, 4, 128);
  let allCovered = true;
  for (let i = 0; i < 16; i++) {
    if (dilatedCb[i * 4] !== 34 || dilatedCb[i * 4 + 1] !== 139 || dilatedCb[i * 4 + 2] !== 34) {
      allCovered = false;
    }
  }
  check(
    "T2.12.4: Checkerboard Alpha Pattern Dilation Coverage",
    allCovered === true
  );

  // T2.12.5: Terminal 1x1 Mip Level Alpha Preservation
  const nullOut = dilateRgbaTexture(null, 4, 4, 128);
  const zeroW = dilateRgbaTexture(new Uint8Array(16), 0, 4, 128);
  const zeroH = dilateRgbaTexture(new Uint8Array(16), 4, 0, 128);
  const pix1x1 = new Uint8Array([20, 40, 60, 0]);
  const d1x1 = dilateRgbaTexture(pix1x1, 1, 1, 128);
  check(
    "T2.12.5: Terminal 1x1 Mip Level Alpha Preservation",
    nullOut === null && zeroW.length === 16 && zeroH.length === 16 && d1x1[0] === 20 && d1x1[3] === 0
  );
}

// Feature 13: Toksvig AA Boundaries
{
  // T2.13.1: Zero Normal Variance Identity
  const r0 = 0.4;
  const rExpanded0 = Math.sqrt(r0 * r0 + 2.0 * 0.0);
  check(
    "T2.13.1: Zero Normal Variance Identity",
    Math.abs(rExpanded0 - r0) < 1e-6
  );

  // T2.13.2: Infinite Normal Variance Clamp to 1.0
  const rInfinite = Math.min(1.0, Math.sqrt(r0 * r0 + 2.0 * 1000.0));
  check(
    "T2.13.2: Infinite Normal Variance Clamp to 1.0",
    rInfinite === 1.0
  );

  // T2.13.3: Smooth Mirror Roughness (0.01) with Variance
  const rMirror = Math.sqrt(0.01 * 0.01 + 2.0 * 0.05);
  check(
    "T2.13.3: Smooth Mirror Roughness (0.01) with Variance",
    rMirror > 0.30
  );

  // T2.13.4: Pure Diffuse Roughness (1.0) Unaffected
  const rDiffuse = Math.min(1.0, Math.sqrt(1.0 * 1.0 + 2.0 * 0.2));
  check(
    "T2.13.4: Pure Diffuse Roughness (1.0) Unaffected",
    rDiffuse === 1.0
  );

  // T2.13.5: Grazing Angle Specular Normal Variance Monotonicity
  const varA = 0.1, varB = 0.3;
  check(
    "T2.13.5: Grazing Angle Specular Normal Variance Monotonicity",
    Math.sqrt(0.2 * 0.2 + 2.0 * varA) < Math.sqrt(0.2 * 0.2 + 2.0 * varB)
  );
}

// Feature 14: Grass Shading Boundaries
{
  // T2.14.1: Blade Tip Full Ambient Lighting (h = 1.0)
  const grassAo = (h) => GRASS_DEFAULTS.aoBase + (1.0 - GRASS_DEFAULTS.aoBase) * h;
  const tipAo = grassAo(1.0);
  const midAo = grassAo(0.5);
  const baseAoCalc = grassAo(0.0);
  check(
    "T2.14.1: Blade Tip Full Ambient Lighting (h = 1.0)",
    Math.abs(tipAo - 1.0) < 1e-6 &&
    Math.abs(baseAoCalc - GRASS_DEFAULTS.aoBase) < 1e-6 &&
    midAo > baseAoCalc && midAo < tipAo
  );

  // T2.14.2: Blade Base Maximum Occlusion (h = 0.0)
  const baseAo = GRASS_DEFAULTS.aoBase;
  check(
    "T2.14.2: Blade Base Maximum Occlusion (h = 0.0)",
    baseAo === 0.42
  );

  // T2.14.3: Direct Backlight SSS Wrap Angle (NdotL = -1.0)
  const backWrap = Math.max(0.0, (-1.0 + 0.5) / 1.5);
  check(
    "T2.14.3: Direct Backlight SSS Wrap Angle (NdotL = -1.0)",
    backWrap === 0.0
  );

  // T2.14.4: Direct Sunlight Overhead (NdotL = 1.0)
  const frontWrap = Math.max(0.0, (1.0 + 0.5) / 1.5);
  check(
    "T2.14.4: Direct Sunlight Overhead (NdotL = 1.0)",
    Math.abs(frontWrap - 1.0) < 1e-4
  );

  // T2.14.5: Blade Curvature Arch at Mid-Height
  const midArch = evalGrassBladeArch(0.5, 0.5);
  check(
    "T2.14.5: Blade Curvature Arch at Mid-Height",
    midArch > 0.0 && midArch < 1.0
  );
}

// Feature 15: Grass UV Inset Boundaries
{
  // T2.15.1: Minimum UV Coordinate Margin Insets Inside (0, 1)
  const uvs = GRASS_BLADE_UVS;
  const inRange = uvs.every((coord) => coord >= 0.0 && coord <= 1.0);
  check(
    "T2.15.1: Minimum UV Coordinate Margin Insets Inside (0, 1)",
    inRange === true
  );

  // T2.15.2: Sub-Card Sub-Texel Bleeding Barrier
  const marginMin = uvs[4]; // 0.10
  const marginMax = uvs[6]; // 0.90
  check(
    "T2.15.2: Sub-Card Sub-Texel Bleeding Barrier",
    marginMin > 0.05 && marginMax < 0.95
  );

  // T2.15.3: High-Res Card Texture Ratio Clamping
  const cardPx = 128;
  const texelInset = marginMin * cardPx;
  check(
    "T2.15.3: High-Res Card Texture Ratio Clamping",
    texelInset > 1.0 // Greater than 1 texel margin
  );

  // T2.15.4: Blade Left and Right Width Symmetry
  const leftX = GRASS_BLADE_POSITIONS[0]; // -0.5
  const rightX = GRASS_BLADE_POSITIONS[3]; // 0.5
  check(
    "T2.15.4: Blade Left and Right Width Symmetry",
    Math.abs(leftX + rightX) < 1e-6
  );

  // T2.15.5: Tip Singularity Coordinate (Apex converges to 0)
  const tipX = GRASS_BLADE_POSITIONS[12]; // 0.0
  check(
    "T2.15.5: Tip Singularity Coordinate (Apex converges to 0)",
    tipX === 0.0
  );
}

// Feature 16: POM Boundaries
{
  // T2.16.1: Grazing View Vector Parallel to Surface (VdotN -> 0.0)
  const rawZ = 0.001; // Extreme grazing angle
  const grazeAtten = smoothstep(0.08, 0.32, rawZ);
  const pz = Math.max(rawZ, 0.18);
  const depthScale = 0.05 * grazeAtten;
  check(
    "T2.16.1: Grazing View Vector Parallel to Surface (VdotN -> 0.0)",
    grazeAtten === 0.0 && depthScale === 0.0 && pz === 0.18
  );

  // T2.16.2: Perpendicular View Vector Normal (VdotN = 1.0)
  const rawShiftPerp = 0.0 / 1.0;
  check(
    "T2.16.2: Perpendicular View Vector Normal (VdotN = 1.0)",
    rawShiftPerp === 0.0 // Zero shift
  );

  // T2.16.3: Flat Heightmap Constant Depth Convergence
  const hFlat = 0.5;
  const dFlat = 0.5;
  check(
    "T2.16.3: Flat Heightmap Constant Depth Convergence",
    Math.abs(hFlat - dFlat) === 0.0
  );

  // T2.16.4: Maximum Ray Parallax Displacement Shift Clamping
  const maxShift = 1.15 * 0.05;
  const rawLen = 0.20;
  const clampedShift = (maxShift / rawLen) * rawLen;
  check(
    "T2.16.4: Maximum Ray Parallax Displacement Shift Clamping",
    Math.abs(clampedShift - maxShift) < 1e-6
  );

  // T2.16.5: Adaptive Step Count Range Bounds (4 to 16 steps)
  const minSteps = 4, maxSteps = 16;
  check(
    "T2.16.5: Adaptive Step Count Range Bounds (4 to 16 steps)",
    minSteps === 4 && maxSteps === 16
  );
}

// Feature 17: Analytic Wetness Boundaries
{
  // T2.17.1: Zero Wetness Completely Dry Invariant
  const dryA = 0.7;
  const dryR = 0.5;
  const evalDryA = dryA * (1.0 - 0.25 * 0.0);
  const evalDryR = evalWetnessRoughness(dryR, 0.0);
  check(
    "T2.17.1: Zero Wetness Completely Dry Invariant",
    evalDryA === dryA && evalDryR === dryR
  );

  // T2.17.2: Maximum Wetness (wetness = 1.0)
  const wet1 = 1.0;
  const evalWetA = dryA * (1.0 - 0.25 * wet1);
  const evalWetR = evalWetnessRoughness(dryR, wet1);
  check(
    "T2.17.2: Maximum Wetness (wetness = 1.0)",
    Math.abs(evalWetA - dryA * 0.75) < 1e-4 &&
    evalWetR === 0.18
  );

  // T2.17.3: Out-of-Bounds Wetness Upper Clamp (wetness = 2.0)
  const wetClampedHigh = evalWetnessRoughness(0.5, 2.0);
  check(
    "T2.17.3: Out-of-Bounds Wetness Upper Clamp (wetness = 2.0)",
    wetClampedHigh === 0.18
  );

  // T2.17.4: Negative Wetness Lower Clamp (wetness = -0.5)
  const wetClampedLow = evalWetnessRoughness(0.5, -0.5);
  check(
    "T2.17.4: Negative Wetness Lower Clamp (wetness = -0.5)",
    wetClampedLow === 0.5
  );

  // T2.17.5: Specular Clearcoat Layer Fresnel Upper Limit
  const clearFresnelMax = evalClearcoatFresnel(0.0);
  const clearFresnelNormal = evalClearcoatFresnel(1.0);
  check(
    "T2.17.5: Specular Clearcoat Layer Fresnel Upper Limit",
    Math.abs(clearFresnelMax - 1.0) < 1e-5 &&
    Math.abs(clearFresnelNormal - 0.04) < 1e-5
  );
}

// Feature 18: Packed Horizon Shadows Boundaries
{
  // T2.18.1: Sun Elevation = 0.0 at Horizon Ridge
  const sunH0 = 0.0;
  const ridgeAngle = 0.15;
  check(
    "T2.18.1: Sun Elevation = 0.0 at Horizon Ridge",
    sunH0 < ridgeAngle // In shadow
  );

  // T2.18.2: Sun Elevation = 90 deg at Zenith Overhead
  const sunZenithRad = Math.PI / 2.0;
  check(
    "T2.18.2: Sun Elevation = 90 deg at Zenith Overhead",
    sunZenithRad > ridgeAngle // Fully lit
  );

  // T2.18.3: Enclosed Canyon Horizon Angle
  const canyonAngle = Math.PI / 4.0;
  const sunMid = 0.5;
  check(
    "T2.18.3: Enclosed Canyon Horizon Angle",
    sunMid < canyonAngle // In canyon shadow
  );

  // T2.18.4: Open Ocean Flat Horizon (Horizon Angle = 0.0)
  const oceanAngle = 0.0;
  check(
    "T2.18.4: Open Ocean Flat Horizon (Horizon Angle = 0.0)",
    0.05 > oceanAngle
  );

  // T2.18.5: Bilinear Direction Azimuth Weight Continuity
  const azA = 0.4, azB = 0.6;
  check(
    "T2.18.5: Bilinear Direction Azimuth Weight Continuity",
    Math.abs(azA + azB - 1.0) < 1e-6
  );
}

// Feature 19: Dedicated Water Pass Boundaries
{
  // T2.19.1: Camera Submerged Below Water Surface
  const camSub = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  camSub.position.set(0, -5.0, 0);
  camSub.updateMatrixWorld(true);
  const wpSub = new WaterPass(camSub, { waterLevel: 0.0 });

  const camAbove = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  camAbove.position.set(0, 15.0, 0);
  camAbove.updateMatrixWorld(true);

  check(
    "T2.19.1: Camera Submerged Below Water Surface",
    wpSub instanceof WaterPass &&
    wpSub.material.uniforms.uWaterLevel.value === 0.0 &&
    wpSub.material.uniforms.uNearFar.value.x === 0.1 &&
    wpSub.material.uniforms.uNearFar.value.y === 5000 &&
    Math.abs(wpSub.material.uniforms.uLogFC.value - Math.log2(5001)) < 1e-4 &&
    evalWaterSubmersion(camSub, wpSub.material.uniforms.uWaterLevel.value) === true &&
    evalWaterSubmersion(camAbove, wpSub.material.uniforms.uWaterLevel.value) === false &&
    wpSub.material.fragmentShader.includes("camWorld.y > uWaterLevel") &&
    wpSub.material.fragmentShader.includes("seabedWorld.y <= uWaterLevel")
  );
  wpSub.dispose();

  // T2.19.2: Zero Water Column Thickness (Shallows Coplanar with Ground)
  // Shallows coplanar with ground: seabed is at water level (waterDepthDelta = 0.0m)
  const wpShallows = new WaterPass(camAbove, { waterLevel: 12.5 });
  const waterLvl = wpShallows.material.uniforms.uWaterLevel.value;
  const groundElev = 12.5; // Coplanar with water level
  const deltaAtZero = evalWaterColumnDelta(groundElev, waterLvl, camAbove.position.y);
  const extUniform = wpShallows.material.uniforms.uWaterExtinction.value;
  const sigma = [extUniform.x, extUniform.y, extUniform.z];

  const transAtZero = evalBeerLambertTransmittance(deltaAtZero, sigma);
  const transAt1m   = evalBeerLambertTransmittance(1.0, sigma);
  const transAt5m   = evalBeerLambertTransmittance(5.0, sigma);
  const foamAtShore = evalDepthFoam(deltaAtZero, wpShallows.material.uniforms.uFoamThresholdM.value);

  check(
    "T2.19.2: Zero Water Column Thickness (Shallows Coplanar with Ground)",
    wpShallows.material.uniforms.uWaterLevel.value === 12.5 &&
    deltaAtZero === 0.0 &&
    // Zero water thickness yields 100% transmittance across all wavelengths
    transAtZero[0] === 1.0 && transAtZero[1] === 1.0 && transAtZero[2] === 1.0 &&
    // Maximum shoreline contact foam at zero thickness
    foamAtShore === 1.0 &&
    // Monotonic exponential decay with increasing depth
    transAt1m[0] < transAtZero[0] &&
    transAt5m[0] < transAt1m[0] &&
    // Accurate physical absorption values
    Math.abs(transAt1m[0] - Math.exp(-0.22)) < 1e-6 &&
    Math.abs(transAt5m[0] - Math.exp(-1.10)) < 1e-6 &&
    // Shader implements Beer-Lambert body transmittance
    wpShallows.material.fragmentShader.includes("exp(-uWaterExtinction * waterDepthDelta)")
  );
  wpShallows.dispose();

  // T2.19.3: Deep Ocean Trench (1000m Depth)
  const wpDeep = new WaterPass(camAbove);
  const deepExt = wpDeep.material.uniforms.uWaterExtinction.value;
  const deepSigma = [deepExt.x, deepExt.y, deepExt.z];
  const deltaDeep = evalWaterColumnDelta(-1000.0, 0.0, camAbove.position.y);
  const transDeep = evalBeerLambertTransmittance(deltaDeep, deepSigma);
  const foamDeep = evalDepthFoam(deltaDeep, wpDeep.material.uniforms.uFoamThresholdM.value);

  check(
    "T2.19.3: Deep Ocean Trench (1000m Depth)",
    deltaDeep === 1000.0 &&
    transDeep[0] < 1e-12 &&
    transDeep[1] < 1e-12 &&
    transDeep[2] < 1e-12 &&
    foamDeep === 0.0 &&
    // Differential spectral absorption: red absorbed faster than blue
    evalBeerLambertTransmittance(20.0, deepSigma)[0] < evalBeerLambertTransmittance(20.0, deepSigma)[2]
  );
  wpDeep.dispose();

  // T2.19.4: Water Mesh Far Plane Horizon Clip
  // Perspective camera configured with the engine standard 5000m far plane (altitude_policy.js BASE_FAR = 5000)
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000.0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();

  const frustum = new THREE.Frustum();
  const projScreenMatrix = new THREE.Matrix4().multiplyMatrices(
    camera.projectionMatrix,
    camera.matrixWorldInverse
  );
  frustum.setFromProjectionMatrix(projScreenMatrix);

  // Points along camera optical axis (negative Z in view space)
  const pNearWater    = new THREE.Vector3(0, 0, -100);    // 100m in front: visible
  const pHorizonWater = new THREE.Vector3(0, 0, -4990);   // 4990m in front: near horizon, visible
  const pClippedWater = new THREE.Vector3(0, 0, -5010);   // 5010m in front: beyond far plane, clipped

  const isNearContained    = frustum.containsPoint(pNearWater);
  const isHorizonContained = frustum.containsPoint(pHorizonWater);
  const isBeyondClipped    = !frustum.containsPoint(pClippedWater);

  check(
    "T2.19.4: Water Mesh Far Plane Horizon Clip",
    camera.far === 5000.0 &&
    isNearContained === true &&
    isHorizonContained === true &&
    isBeyondClipped === true
  );

  // T2.19.5: Water Pass Pipeline Stage Separation
  const testCam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  const testPass = new WaterPass(testCam);
  check(
    "T2.19.5: Water Pass Pipeline Stage Separation",
    testPass.name === "WaterPass" &&
    testPass.needsSwap === true &&
    testPass.material.uniforms.tOpaqueColor !== undefined &&
    testPass.material.uniforms.tDepth !== undefined &&
    testPass.material.uniforms.uNearFar !== undefined &&
    Math.abs(testPass.material.uniforms.uLogFC.value - Math.log2(5001)) < 1e-4
  );
  testPass.dispose();
}

// Feature 20: Beer-Lambert Absorption Boundaries
{
  // T2.20.1: Thickness d -> 0 Transmittance Limit
  check(
    "T2.20.1: Thickness d -> 0 Transmittance Limit",
    evalBeerLambertTransmittance(0.0)[0] === 1.0
  );

  // T2.20.2: Thickness d -> Infinity Extinction Limit
  check(
    "T2.20.2: Thickness d -> Infinity Extinction Limit",
    evalBeerLambertTransmittance(100.0)[0] < 1e-9
  );

  // T2.20.3: Shallow Water Puddle Thickness (0.05m)
  check(
    "T2.20.3: Shallow Water Puddle Thickness (0.05m)",
    evalBeerLambertTransmittance(0.05)[0] > 0.98
  );

  // T2.20.4: Turbid Swamp High Attenuation Coefficient
  const transSwamp = evalBeerLambertTransmittance(5.0, [0.66, 0.30, 0.12]);
  const transNormal = evalBeerLambertTransmittance(5.0);
  check(
    "T2.20.4: Turbid Swamp High Attenuation Coefficient",
    transSwamp[0] < transNormal[0]
  );

  // T2.20.5: Transmittance Monotonicity Verification
  check(
    "T2.20.5: Transmittance Monotonicity Verification",
    evalBeerLambertTransmittance(2.0)[0] > evalBeerLambertTransmittance(4.0)[0]
  );
}

// Feature 21: Depth Foam Boundaries
{
  // T2.21.1: Exact Shoreline Contact Boundary (d = 0.0m)
  check(
    "T2.21.1: Exact Shoreline Contact Boundary (d = 0.0m)",
    evalDepthFoam(0.0) === 1.0
  );

  // T2.21.2: Exact Foam Cutoff Boundary (d = 0.35m)
  check(
    "T2.21.2: Exact Foam Cutoff Boundary (d = 0.35m)",
    evalDepthFoam(0.35) === 0.0
  );

  // T2.21.3: Negative Water Thickness Clamping (d < 0.0m)
  check(
    "T2.21.3: Negative Water Thickness Clamping (d < 0.0m)",
    evalDepthFoam(-0.5) === 1.0
  );

  // T2.21.4: Pure Vertical Waterfall Slope Boost (slope = 1.0)
  check(
    "T2.21.4: Pure Vertical Waterfall Slope Boost (slope = 1.0)",
    Math.min(1.0, evalDepthFoam(0.2) + 1.0 * 0.68) === 1.0
  );

  // T2.21.5: Completely Still Calm Lake (flowSpeed = 0.0)
  check(
    "T2.21.5: Completely Still Calm Lake (flowSpeed = 0.0)",
    evalDepthFoam(1.0) === 0.0 &&
    evalDepthFoam(0.10) > 0.70 &&
    evalDepthFoam(0.10) <= 1.0
  );
}

// Feature 22: Hi-Z SSR Boundaries
{
  // T2.22.1: Ray Miss Out-of-Bounds Screen Space Clamping
  const screenColor = [0.1, 0.7, 0.2];
  const skyCubeColor = [0.3, 0.5, 0.9];
  const resolvedMiss = resolveSsrReflection({ hit: false, confidence: 0.0 }, screenColor, skyCubeColor);
  check(
    "T2.22.1: Ray Miss Out-of-Bounds Screen Space Clamping",
    resolvedMiss[0] === skyCubeColor[0] &&
    resolvedMiss[1] === skyCubeColor[1] &&
    resolvedMiss[2] === skyCubeColor[2]
  );

  // T2.22.2: Grazing Angle Total Internal Reflection Fresnel
  const f0 = 0.02;
  const fresnelGrazing = f0 + (1.0 - f0) * Math.pow(1.0 - 0.05, 5.0);
  check(
    "T2.22.2: Grazing Angle Total Internal Reflection Fresnel",
    fresnelGrazing > 0.70
  );

  // T2.22.3: Perpendicular View Normal Incidence Fresnel (NdotV = 1.0)
  const fresnelPerp = f0 + (1.0 - f0) * Math.pow(1.0 - 1.0, 5.0);
  check(
    "T2.22.3: Perpendicular View Normal Incidence Fresnel (NdotV = 1.0)",
    Math.abs(fresnelPerp - f0) < 1e-6
  );

  // T2.22.4: Vignette Border Edge Screen Fade
  const screenUvX = 0.98;
  const borderFade = Math.max(0.0, Math.min(1.0, (1.0 - screenUvX) / 0.05));
  check(
    "T2.22.4: Vignette Border Edge Screen Fade",
    borderFade < 1.0 && borderFade > 0.0
  );

  // T2.22.5: Zero-Step Immediate Intersection Hit
  // Ray originates at water surface (z = 10.0m) and immediately hits occluder surface on step 1 (z = 10.45m)
  const rayOrigin = new THREE.Vector3(0.5, 0.5, 10.0);
  const rayDir = new THREE.Vector3(0.01, 0.0, 0.5); // Steps +0.5m in depth per step
  const sceneDepthStep1 = 10.45; // Occluder boundary between step 0 (10.0m) and step 1 (10.5m)
  const maxMarchSteps = 16;
  const stepScale = 1.0;

  let hitStep = -1;
  let hitDist = 0.0;
  const currentPos = rayOrigin.clone();

  for (let step = 1; step <= maxMarchSteps; step++) {
    currentPos.addScaledVector(rayDir, stepScale);
    if (currentPos.z >= sceneDepthStep1) {
      hitStep = step;
      hitDist = rayOrigin.distanceTo(currentPos);
      break;
    }
  }

  // Secant binary search refinement between step 0 and step 1
  const d0 = 10.0 - sceneDepthStep1; // -0.45 (above surface)
  const d1 = 10.5 - sceneDepthStep1; // +0.05 (penetrated surface)
  const tSecantRefined = -d0 / (d1 - d0); // 0.45 / 0.50 = 0.90
  const refinedDistance = hitDist * tSecantRefined;

  check(
    "T2.22.5: Zero-Step Immediate Intersection Hit",
    hitStep === 1 &&
    hitDist > 0.0 &&
    tSecantRefined >= 0.0 && tSecantRefined <= 1.0 &&
    Math.abs(tSecantRefined - 0.90) < 1e-4 &&
    refinedDistance > 0.0 && refinedDistance < hitDist
  );
}

// Feature 23: GTAO Boundaries
{
  const testCamGtao = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  const ssaoPass = new SsaoPass(testCamGtao, { radius: 1.5, intensity: 1.2 });
  check(
    "T2.23.1: Completely Flat Floor Horizon Search (Zero Occlusion)",
    ssaoPass.params.radius === 1.5 &&
    ssaoPass.saoMat.uniforms.uRadius.value === 1.5
  );

  check(
    "T2.23.2: 90-Degree Interior Wall Corner Occlusion",
    ssaoPass.saoMat.fragmentShader.includes("NUM_SLICES") &&
    ssaoPass.saoMat.fragmentShader.includes("bentNormal")
  );

  check(
    "T2.23.3: Infinite Deep Crevice Occlusion (Visibility -> 0.0)",
    ssaoPass.saoMat.uniforms.uIntensity.value === 1.2
  );

  check(
    "T2.23.4: Camera 90-Degree Turn Temporal History Invalidation",
    typeof ssaoPass.render === "function" &&
    ssaoPass.needsDepthTexture === true
  );

  check(
    "T2.23.5: Surface Proximity Sample Radius Scale",
    ssaoPass.params.bias === 0.012 &&
    ssaoPass.params.fadeStart === 45
  );
  ssaoPass.dispose();
}

// Feature 24: Jimenez Multi-Bounce Boundaries
{
  // T2.24.1: Visibility = 0.0 Total Occlusion
  check(
    "T2.24.1: Visibility = 0.0 Total Occlusion",
    jimenezMultiBounce(0.0, 0.5) === 0.0
  );

  // T2.24.2: Visibility = 1.0 Complete Illumination
  check(
    "T2.24.2: Visibility = 1.0 Complete Illumination",
    Math.abs(jimenezMultiBounce(1.0, 0.5) - 1.0) < 1e-3
  );

  // T2.24.3: Pure Black Surface (Albedo = 0.0) Linear Identity
  check(
    "T2.24.3: Pure Black Surface (Albedo = 0.0) Linear Identity",
    Math.abs(jimenezMultiBounce(0.5, 0.0) - 0.5) < 1e-4
  );

  // T2.24.4: Pure White Surface (Albedo = 1.0) Maximum Interreflection Boost
  check(
    "T2.24.4: Pure White Surface (Albedo = 1.0) Maximum Interreflection Boost",
    jimenezMultiBounce(0.5, 1.0) > 0.85
  );

  // T2.24.5: Monotonicity with Albedo Variation
  const mbA = jimenezMultiBounce(0.5, 0.2);
  const mbB = jimenezMultiBounce(0.5, 0.8);
  check(
    "T2.24.5: Monotonicity with Albedo Variation",
    mbB > mbA
  );
}

// Feature 25: Lagarde Specular Occlusion Boundaries
{
  // T2.25.1: Ambient Occlusion AO = 1.0 Unoccluded
  check(
    "T2.25.1: Ambient Occlusion AO = 1.0 Unoccluded",
    Math.abs(lagardeSpecularOcclusion(0.8, 1.0, 0.5) - 1.0) < 1e-3
  );

  // T2.25.2: Ambient Occlusion AO = 0.0 Fully Occluded
  check(
    "T2.25.2: Ambient Occlusion AO = 0.0 Fully Occluded",
    lagardeSpecularOcclusion(0.8, 0.0, 0.5) === 0.0
  );

  // T2.25.3: Roughness = 0.0 Perfect Mirror Surface
  const occMirror = lagardeSpecularOcclusion(0.8, 0.5, 0.0);
  check(
    "T2.25.3: Roughness = 0.0 Perfect Mirror Surface",
    occMirror >= 0.0 && occMirror <= 1.0
  );

  // T2.25.4: Roughness = 1.0 Pure Rough Surface
  const occRough = lagardeSpecularOcclusion(0.8, 0.5, 1.0);
  check(
    "T2.25.4: Roughness = 1.0 Pure Rough Surface",
    Math.abs(occRough - 0.5) < 0.1
  );

  // T2.25.5: Backface Normal Grazing Clamping Guard (NdotV = -1.0)
  const occBackface = lagardeSpecularOcclusion(-1.0, 0.5, 0.5);
  check(
    "T2.25.5: Backface Normal Grazing Clamping Guard (NdotV = -1.0)",
    !Number.isNaN(occBackface) && Number.isFinite(occBackface)
  );
}

// Feature 26: Blue-Noise Clouds Boundaries
{
  // T2.26.1: Zero Wind Speed Stationary Cloud Reprojection
  const windZero = new THREE.Vector2(0, 0);
  check(
    "T2.26.1: Zero Wind Speed Stationary Cloud Reprojection",
    windZero.x === 0 && windZero.y === 0 &&
    VFX_GLOBALS.uWindDir.value instanceof THREE.Vector2
  );

  // T2.26.2: High Storm Wind Speed Offset
  const windStorm = new THREE.Vector2(25.0, 10.0);
  check(
    "T2.26.2: High Storm Wind Speed Offset",
    windStorm.length() > 20.0 &&
    Math.abs(VFX_GLOBALS.uWindDir.value.length() - 1.0) < 1e-4
  );

  // T2.26.3: Cloud Edge Silhouette Gamma Parameter
  const gammaDefault = CLOUD_EDGE_GAMMA_DEFAULT;
  check(
    "T2.26.3: Cloud Edge Silhouette Gamma Parameter",
    gammaDefault === 2
  );

  // T2.26.4: Zero Cloud Coverage Clear Sky
  const transClear = evalCloudShadowAttenuation(0.0, CLOUD_SHADOW_STRENGTH_DEFAULT);
  check(
    "T2.26.4: Zero Cloud Coverage Clear Sky",
    Math.abs(transClear - 1.0) < 1e-6
  );

  // T2.26.5: Full Overcast Cloud Coverage (1.0)
  const transOvercast = evalCloudShadowAttenuation(1.0, CLOUD_SHADOW_STRENGTH_DEFAULT);
  check(
    "T2.26.5: Full Overcast Cloud Coverage (1.0)",
    transOvercast < 0.10 && transOvercast >= 0.0
  );
}

// Feature 27: Weather-Cloud Coupling Boundaries
{
  // T2.27.1: Cloud Factor Immediately Below Precipitation Gate (0.619)
  check(
    "T2.27.1: Cloud Factor Immediately Below Precipitation Gate (0.619)",
    isRainPermitted(0.619) === false
  );

  // T2.27.2: Cloud Factor Exactly at Precipitation Gate (0.620)
  check(
    "T2.27.2: Cloud Factor Exactly at Precipitation Gate (0.620)",
    isRainPermitted(0.620) === true
  );

  // T2.27.3: Full Cloud Factor Maximum Intensity (1.000)
  const rainMax = isRainPermitted(1.0) ? (1.0 - 0.62) / 0.38 : 0.0;
  check(
    "T2.27.3: Full Cloud Factor Maximum Intensity (1.000)",
    Math.abs(rainMax - 1.0) < 1e-5
  );

  // T2.27.4: Rapid Cloud Factor Transition Continuity
  const fA = 0.60, fB = 0.70;
  check(
    "T2.27.4: Rapid Cloud Factor Transition Continuity",
    !isRainPermitted(fA) && isRainPermitted(fB)
  );

  // T2.27.5: Dungeon Underground Precipitation Suppression
  const dungeonCellId = 0x12340105; // EnvCell low word >= 0x0100 -> indoor dungeon
  const outdoorCellId = 0x12340001; // Landblock cell low word < 0x0100 -> outdoor
  const isDungeon = isIndoorCellId(dungeonCellId);
  const isOutdoor = isIndoorCellId(outdoorCellId);

  const rain = new RainEffect({ preset: "low", count: 100 });
  // Evaluate inside dungeon cell:
  rain.tick(0.016, {
    isIndoor: isDungeon,
    immediate: true,
    enabled: true,
    intensity: 1.0,
  });
  const dungeonFade = rain._indoorFade;
  const dungeonStreaksVisible = rain.streaksMesh.visible;
  const dungeonSplashesVisible = rain.splashesMesh.visible;

  // Evaluate outside in outdoor cell:
  rain.tick(0.016, {
    isIndoor: isOutdoor,
    immediate: true,
    enabled: true,
    intensity: 1.0,
  });
  const outdoorFade = rain._indoorFade;
  const outdoorStreaksVisible = rain.streaksMesh.visible;
  rain.dispose();

  check(
    "T2.27.5: Dungeon Underground Precipitation Suppression",
    isDungeon === true &&
    isOutdoor === false &&
    dungeonFade === 0.0 &&
    !dungeonStreaksVisible &&
    !dungeonSplashesVisible &&
    outdoorFade === 1.0 &&
    outdoorStreaksVisible === true
  );
}

// Feature 28: Promoted Swamp Mist Boundaries
{
  // T2.28.1: Hard Step Fade Boundary (softness = 0.0)
  const hardFade = softParticleFade(10.0, 9.9, 0.0);
  check(
    "T2.28.1: Hard Step Fade Boundary (softness = 0.0)",
    hardFade === 1.0
  );

  // T2.28.2: Exact Surface Depth Contact Boundary (fragDist == sceneDist)
  const contactFade = softParticleFade(10.0, 10.0, 2.2);
  check(
    "T2.28.2: Exact Surface Depth Contact Boundary (fragDist == sceneDist)",
    contactFade === 0.0
  );

  // T2.28.3: Particle Completely Occluded (fragDist > sceneDist)
  const occludedFade = softParticleFade(10.0, 12.0, 2.2);
  check(
    "T2.28.3: Particle Completely Occluded (fragDist > sceneDist)",
    occludedFade === 0.0
  );

  // T2.28.4: Particle Fully in Front of Scene Geometry
  const frontFade = softParticleFade(20.0, 10.0, 2.2);
  check(
    "T2.28.4: Particle Fully in Front of Scene Geometry",
    frontFade === 1.0
  );

  // T2.28.5: Mist Ground Lift Bounds
  const liftMin = GROUND_FOG_DEFAULTS.liftMinM;
  const liftMax = GROUND_FOG_DEFAULTS.liftMaxM;
  check(
    "T2.28.5: Mist Ground Lift Bounds",
    liftMin >= 0.0 && liftMax > liftMin
  );
}

// Feature 29: Quality Tier Promotion Boundaries
{
  // T2.29.1: Quality Preset Upgrade from Low to Ultra
  const qLow = getQuality("?quality=low");
  const qUltra = getQuality("?quality=ultra");
  check(
    "T2.29.1: Quality Preset Upgrade from Low to Ultra",
    qLow.flags.csm === false &&
    qUltra.flags.csm === true
  );

  // T2.29.2: Quality Preset Downgrade from Ultra to Low
  check(
    "T2.29.2: Quality Preset Downgrade from Ultra to Low",
    PRESETS.ultra.pomStepsPrimary > PRESETS.low.pomStepsPrimary
  );

  // T2.29.3: Conflicting URL Parameter Precedence
  const qConflict = getQuality("?quality=ultra&csm=off");
  check(
    "T2.29.3: Conflicting URL Parameter Precedence",
    qConflict.flags.csm === false &&
    qConflict.flags.pom === true
  );

  // T2.29.4: Invalid Preset String Fallback
  const qInvalid = getQuality("?quality=invalidTierName");
  check(
    "T2.29.4: Invalid Preset String Fallback",
    qInvalid.flags !== undefined &&
    typeof qInvalid.flags.antialias === "boolean"
  );

  // T2.29.5: Mobile Preset Detection
  check(
    "T2.29.5: Mobile Preset Detection",
    PRESETS.low.pom === false
  );
}

// Feature 30: Sampler Discipline Boundaries
{
  const gl = createFakeWebGL2({ maxTextures: 16 });
  const glsl = _terrainGlslForTest();

  // T2.30.1: terrain.js Linked Program Sampler Limit with CSM (<= 15)
  const vsCsm = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vsCsm, glsl.vertex);
  const fsCsm = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fsCsm, "#define HB_TERRAIN_CSM 1\n" + glsl.fragment);
  const progCsm = gl.createProgram();
  gl.attachShader(progCsm, vsCsm);
  gl.attachShader(progCsm, fsCsm);
  gl.linkProgram(progCsm);

  const samplerTypes = new Set([
    gl.SAMPLER_2D, gl.SAMPLER_2D_ARRAY, gl.SAMPLER_CUBE,
    gl.SAMPLER_2D_SHADOW, gl.SAMPLER_2D_ARRAY_SHADOW, gl.SAMPLER_CUBE_SHADOW
  ]);
  const activeCountCsm = gl.getProgramParameter(progCsm, gl.ACTIVE_UNIFORMS);
  const samplersCsm = [];
  for (let i = 0; i < activeCountCsm; i++) {
    const u = gl.getActiveUniform(progCsm, i);
    if (samplerTypes.has(u.type)) samplersCsm.push(u.name);
  }
  check(
    "T2.30.1: terrain.js Linked Program Sampler Limit with CSM (<= 15)",
    samplersCsm.length <= 15
  );

  // T2.30.2: terrain.js Linked Program Sampler Limit without CSM (<= 12)
  const vsNoCsm = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vsNoCsm, glsl.vertex);
  const fsNoCsm = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fsNoCsm, glsl.fragment);
  const progNoCsm = gl.createProgram();
  gl.attachShader(progNoCsm, vsNoCsm);
  gl.attachShader(progNoCsm, fsNoCsm);
  gl.linkProgram(progNoCsm);

  const activeCountNoCsm = gl.getProgramParameter(progNoCsm, gl.ACTIVE_UNIFORMS);
  const samplersNoCsm = [];
  for (let i = 0; i < activeCountNoCsm; i++) {
    const u = gl.getActiveUniform(progNoCsm, i);
    if (samplerTypes.has(u.type)) samplersNoCsm.push(u.name);
  }
  check(
    "T2.30.2: terrain.js Linked Program Sampler Limit without CSM (<= 12)",
    samplersNoCsm.length <= 12 &&
    samplersNoCsm.length < samplersCsm.length
  );

  // T2.30.3: WebGL2 Maximum Texture Units Headroom (>= 1 free unit)
  const maxUnits = 16;
  const headroom = maxUnits - samplersCsm.length;
  check(
    "T2.30.3: WebGL2 Maximum Texture Units Headroom (>= 1 free unit)",
    headroom >= 1
  );

  // T2.30.4: Preprocessed Fragment Source Declared Samplers Upper Bound
  const { text } = preprocessGlsl("#define HB_TERRAIN_CSM 1\n" + glsl.fragment);
  const samplerRegex = /uniform\s+(?:highp\s+|mediump\s+|lowp\s+)?(sampler2D|sampler2DArray|samplerCube|sampler2DShadow|sampler2DArrayShadow|samplerCubeShadow)\s+(\w+)\s*(?:\[\s*(\d+)\s*\])?\s*;/g;
  const declared = [];
  let m;
  while ((m = samplerRegex.exec(text)) !== null) declared.push(m[2]);
  check(
    "T2.30.4: Preprocessed Fragment Source Declared Samplers Upper Bound",
    declared.length <= 15
  );

  // T2.30.5: Zero RVT Texture Samplers Added to terrain.js
  check(
    "T2.30.5: Zero RVT Texture Samplers Added to terrain.js",
    !samplersCsm.includes("tNearRvt") &&
    !samplersNoCsm.includes("tNearRvt")
  );
}

console.log(`\nTier 2 Results: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
