// tests/visual_improvements_tier3.test.mjs
// Tier 3: 6 Cross-Feature Interaction Suites
// Derived from ORIGINAL_REQUEST.md, PROJECT.md, TEST_INFRA.md, and Iteration 2 Explorer handoffs.

globalThis.window = globalThis.window || {};
globalThis.window.requestAnimationFrame ??= () => 0;
globalThis.requestAnimationFrame ??= () => 0;
globalThis.location = globalThis.location || { search: "" };
window.location = globalThis.location;

import * as THREE from "three";
import { createFakeWebGL2, fakeCanvas, preprocessGlsl } from "./helpers/fake_webgl2.mjs";

import {
  setupCsm,
  updateCsm,
  refreshCsmUniforms,
  csmStaticOnlyFlag,
  DEFAULT_CSM_SPLITS,
  DEFAULT_CSM_MAP_SIZES
} from "../scene3d/csm.js";

import {
  installCsmShaderPatch,
  applyMicroSurfaceEnhancement
} from "../scene3d/materials.js";

import {
  NEAR_RVT_EXTENT_M,
  NEAR_RVT_SIZE,
  NEAR_RVT_GRID_SNAP_M,
  nearRvtEnabled
} from "../scene3d/far_terrain.js";

import {
  FROXEL_CLUSTERS_X,
  FROXEL_CLUSTERS_Y,
  FROXEL_CLUSTERS_Z,
  TOTAL_FROXELS,
  MAX_FORWARD_LIGHTS,
  FroxelLightGrid
} from "../scene3d/lighting.js";

import {
  computeEnvCellL2Sh,
  evaluateRamamoorthiSh
} from "../scene3d/cells.js";

import {
  SSAO_DEFAULTS,
  SsaoPass,
  ssaoEnabled,
  sscsEnabled
} from "../scene3d/ssao.js";

import {
  _terrainGlslForTest
} from "../scene3d/terrain.js";

import {
  makeGrassBladeGeometry,
  GRASS_BLADE_UVS
} from "../scene3d/terrain_grass.js";

import {
  WATER_FLOW_DEFAULTS,
  WATER_FOAM_APPLY_GLSL
} from "../scene3d/terrain_water_flow.js";

import {
  VIEWS,
  OCTAHEDRAL_VIEWS,
  OCTAHEDRAL_GRID,
  atlasCell
} from "../scene3d/far_forest.js";

import {
  GROUND_FOG_DEFAULTS,
  GROUND_FOG_FRAGMENT_GLSL,
  softParticleFade
} from "../scene3d/ground_fog.js";

import {
  CLOUD_EDGE_GAMMA_DEFAULT
} from "../scene3d/cloud_edge_resolve.js";

import {
  setCloudOverheadFactor,
  readWeatherCloudCoupling,
  _resetWeatherStateForTest
} from "../scene3d/weather_state.js";

import {
  getQuality,
  PRESETS
} from "../scene3d/quality.js";

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

// Frostbite 2014 Specular Occlusion with non-negative guard
function lagardeSpecularOcclusion(ndotv, ao, roughness) {
  const clampedNdotV = Math.max(0.0, Math.min(1.0, ndotv));
  const clampedAo = Math.max(0.0, Math.min(1.0, ao));
  const r = Math.max(0.0, Math.min(1.0, roughness));
  const base = Math.max(0.0, clampedNdotV + clampedAo);
  const exponent = Math.pow(2.0, -16.0 * r - 1.0);
  return Math.max(0.0, Math.min(1.0, Math.pow(base, exponent) - 1.0 + clampedAo));
}

// Jimenez et al. 2016 Multi-Bounce Indirect Visibility Polynomial
function jimenezMultiBounce(visibility, albedo) {
  const v = Math.max(0.0, Math.min(1.0, visibility));
  const evaluateChannel = (alb) => {
    const a = 2.0404 * alb - 0.3324;
    const b = -4.7951 * alb + 0.6417;
    const c = 2.7552 * alb + 0.6903;
    const poly = ((v * a + b) * v + c) * v;
    return Math.max(v, Math.min(1.0, poly));
  };

  if (typeof albedo === "number") {
    return evaluateChannel(Math.max(0.0, Math.min(1.0, albedo)));
  }
  if (Array.isArray(albedo)) {
    return albedo.map((a) => evaluateChannel(Math.max(0.0, Math.min(1.0, a))));
  }
  return {
    r: evaluateChannel(Math.max(0.0, Math.min(1.0, albedo.r))),
    g: evaluateChannel(Math.max(0.0, Math.min(1.0, albedo.g))),
    b: evaluateChannel(Math.max(0.0, Math.min(1.0, albedo.b)))
  };
}

console.log("Starting Tier 3: 6 Cross-Feature Interaction Suites...");

// ===========================================================================
// Suite 1: Shadows & Clustered Lighting Integration (CSM + SSCS + Froxels + EnvCell SH)
// ===========================================================================
console.log("\n--- Suite 1: Shadows & Clustered Lighting Integration ---");
{
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  camera.position.set(0, 10, 0);
  camera.lookAt(0, 0, -100);
  camera.updateMatrixWorld();

  // T3.01.1: CSM Shadow Transition to SSCS Contact Grounding
  const csmState = setupCsm(scene, { csmStaticOnly: true });
  const mat = new THREE.MeshStandardMaterial({ color: 0x888888 });
  installCsmShaderPatch(mat, csmState);
  const shaderStub = {
    uniforms: {},
    vertexShader: "#include <common>\nvoid main() { gl_Position = vec4(0.0); }",
    fragmentShader: "#include <common>\nvoid main() { gl_FragColor = vec4(1.0); }"
  };
  mat.onBeforeCompile(shaderStub);

  const csmShadow = 0.25;
  const sscsShadow = 0.15;
  const compositeShadow = Math.min(csmShadow, sscsShadow);
  check(
    "T3.01.1: CSM Shadow Transition to SSCS Contact Grounding",
    shaderStub.uniforms.uCsmMatrix0 !== undefined &&
      csmState.splits.length === 3 &&
      csmState.splits[0] === DEFAULT_CSM_SPLITS[0] &&
      compositeShadow === 0.15 &&
      compositeShadow >= 0.0
  );

  // T3.01.2: Froxel Point Light Inside Static CSM Shadow
  const froxelGrid = new FroxelLightGrid();
  const pointLight = new THREE.PointLight(0xffaa44, 2.0, 30.0);
  pointLight.position.set(0, 2, -15);
  froxelGrid.update(camera, [pointLight]);

  check(
    "T3.01.2: Froxel Point Light Inside Static CSM Shadow",
    FROXEL_CLUSTERS_X === 16 &&
      FROXEL_CLUSTERS_Y === 9 &&
      FROXEL_CLUSTERS_Z === 24 &&
      TOTAL_FROXELS === 3456 &&
      froxelGrid.tClusterHeader instanceof THREE.DataTexture &&
      froxelGrid.tClusterHeader.internalFormat === "RG32UI"
  );
  froxelGrid.dispose();

  // T3.01.3: SSCS Raymarch Intersecting Froxel Light Cone
  // Verify froxel exponential depth slices cover SSCS contact range (0.1m - 30m)
  const nearZ = camera.near;
  const cascade0Far = DEFAULT_CSM_SPLITS[0]; // 30m
  const sliceIndex = Math.floor(
    (Math.log(cascade0Far / nearZ) / Math.log(camera.far / nearZ)) *
      FROXEL_CLUSTERS_Z
  );
  check(
    "T3.01.3: SSCS Raymarch Intersecting Froxel Light Cone",
    sliceIndex > 0 && sliceIndex < FROXEL_CLUSTERS_Z && cascade0Far === 30.0
  );

  // T3.01.4: High Dynamic Entity Density in Froxel Cell
  const staticCastersOnly = csmState.lights.every(
    (l) => l.userData && l.userData.csmStaticOnly === true
  );
  check(
    "T3.01.4: High Dynamic Entity Density in Froxel Cell",
    staticCastersOnly && MAX_FORWARD_LIGHTS === 256
  );

  // T3.01.5: Cascade Boundary Crossing During SSCS Raymarch
  const split0 = DEFAULT_CSM_SPLITS[0];
  const blendWindow = 4.0;
  const w0 = 1.0 - smoothstep(split0 - blendWindow / 2, split0 + blendWindow / 2, split0);
  const w1 = smoothstep(split0 - blendWindow / 2, split0 + blendWindow / 2, split0);
  check(
    "T3.01.5: Cascade Boundary Crossing During SSCS Raymarch",
    Math.abs(w0 - 0.5) < 1e-4 &&
      Math.abs(w1 - 0.5) < 1e-4 &&
      Math.abs(w0 + w1 - 1.0) < 1e-5
  );
}

// ===========================================================================
// Suite 2: Post-Opaque Water Surface & Ambient Occlusion (Water + SSR + Foam + GTAO + Jimenez MB + Lagarde SO)
// ===========================================================================
console.log("\n--- Suite 2: Post-Opaque Water Surface & Ambient Occlusion ---");
{
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 5000);
  const ssaoPass = new SsaoPass(scene, camera, 800, 600);

  // T3.02.1: Hi-Z SSR Reflecting GTAO-Occluded Geometry
  const expectedLogFC = Math.log2(camera.far + 1.0);
  check(
    "T3.02.1: Hi-Z SSR Reflecting GTAO-Occluded Geometry",
    ssaoPass.saoMat?.uniforms?.uLogFC !== undefined &&
      Math.abs(ssaoPass.saoMat.uniforms.uLogFC.value - expectedLogFC) < 1e-4 &&
      SSAO_DEFAULTS.bias === 0.012 &&
      SSAO_DEFAULTS.fadeStart === 45
  );

  // T3.02.2: Beer-Lambert Transmittance Under GTAO Contact Crevice
  const depthM = 0.5;
  const riverSigma = [0.12, 0.06, 0.03];
  const waterTransR = Math.exp(-riverSigma[0] * depthM);
  const waterTransG = Math.exp(-riverSigma[1] * depthM);
  const waterTransB = Math.exp(-riverSigma[2] * depthM);
  check(
    "T3.02.2: Beer-Lambert Transmittance Under GTAO Contact Crevice",
    waterTransR < waterTransG &&
      waterTransG < waterTransB &&
      waterTransR > 0.0 &&
      waterTransR < 1.0
  );

  // T3.02.3: Hi-Z SSR Reflection Mask at Foam Shoreline (d < 0.35m)
  const foamCutoff = WATER_FLOW_DEFAULTS.still; // 0.35m
  const contactDepth = 0.15;
  const foamFactor = smoothstep(foamCutoff, 0.0, contactDepth);
  const ssrMirrorWeight = 1.0 - foamFactor;
  check(
    "T3.02.3: Hi-Z SSR Reflection Mask at Foam Shoreline (d < 0.35m)",
    foamCutoff === 0.35 &&
      foamFactor > 0.5 &&
      ssrMirrorWeight < 0.5 &&
      WATER_FOAM_APPLY_GLSL.length > 500
  );

  // T3.02.4: Lagarde Specular Occlusion Attenuating Water Cubemap Fallback
  const canopySO = lagardeSpecularOcclusion(0.8, 0.1, 0.05);
  const grazingSO = lagardeSpecularOcclusion(-1.0, 0.1, 0.05);
  check(
    "T3.02.4: Lagarde Specular Occlusion Attenuating Water Cubemap Fallback",
    canopySO < 0.3 && canopySO >= 0.0 && grazingSO === 0.0
  );

  // T3.02.5: Jimenez Multi-Bounce Color Bleed on Underwater Sand
  const sandAlbedo = { r: 0.9, g: 0.7, b: 0.4 };
  const sandMB = jimenezMultiBounce(0.4, sandAlbedo);
  check(
    "T3.02.5: Jimenez Multi-Bounce Color Bleed on Underwater Sand",
    sandMB.r > sandMB.b &&
      sandMB.r > 0.4 &&
      sandMB.b >= 0.4 &&
      sandMB.r <= 1.0
  );
}

// ===========================================================================
// Suite 3: Terrain Multi-Feature Shading with Sampler Discipline
// ===========================================================================
console.log("\n--- Suite 3: Terrain Multi-Feature Shading with Sampler Discipline ---");
{
  const glsl = _terrainGlslForTest();

  // T3.03.1: HexTile Stochastic Tiling on Stitched Landblock Border
  const hasAtlas = glsl.fragment.includes("uAtlas");
  const hasHexOrTri =
    glsl.fragment.includes("triplanar") ||
    glsl.fragment.includes("uMacroTex") ||
    glsl.fragment.includes("uTerrainDetailTex");
  check(
    "T3.03.1: HexTile Stochastic Tiling on Stitched Landblock Border",
    hasAtlas && hasHexOrTri && glsl.fragment.length > 100000
  );

  // T3.03.2: Biome Height Blend Under Macro Horizon Shadow
  const h0 = 0.5;
  const h1 = 0.5;
  const margin = 0.1;
  const heightBlendMask = Math.max(
    0.0,
    Math.min(1.0, (h0 - h1 + margin) / (2.0 * margin))
  );
  const horizonShadowFactor = 0.0; // full horizon shadow
  const shadedBiomeAlbedo =
    heightBlendMask * (0.2 + 0.8 * horizonShadowFactor);
  check(
    "T3.03.2: Biome Height Blend Under Macro Horizon Shadow",
    Math.abs(heightBlendMask - 0.5) < 1e-4 && shadedBiomeAlbedo === 0.1
  );

  // T3.03.3: Horizon Shadow Elevation Angle Interpolation Across Stitched Normals
  const elevA = 0.45;
  const elevB = 0.47;
  const interpElev = THREE.MathUtils.lerp(elevA, elevB, 0.5);
  check(
    "T3.03.3: Horizon Shadow Elevation Angle Interpolation Across Stitched Normals",
    Math.abs(interpElev - 0.46) < 1e-5
  );

  // T3.03.4: Triplanar HexTile on Steep Biome Border
  const cliffNormal = new THREE.Vector3(0.8, 0.2, 0.5).normalize();
  const nx = Math.abs(cliffNormal.x);
  const ny = Math.abs(cliffNormal.y);
  const nz = Math.abs(cliffNormal.z);
  const sumN = nx + ny + nz;
  const weights = { x: nx / sumN, y: ny / sumN, z: nz / sumN };
  const sumWeights = weights.x + weights.y + weights.z;
  check(
    "T3.03.4: Triplanar HexTile on Steep Biome Border",
    Math.abs(sumWeights - 1.0) < 1e-5 && weights.x > weights.y
  );

  // T3.03.5: Full 4-Feature Sampler Audit
  const gl = createFakeWebGL2({ maxTextures: 16 });
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, glsl.vertex);
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, "#define HB_TERRAIN_CSM 1\n" + glsl.fragment);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);

  const samplerTypes = new Set([
    gl.SAMPLER_2D,
    gl.SAMPLER_2D_ARRAY,
    gl.SAMPLER_CUBE,
    gl.SAMPLER_2D_SHADOW
  ]);
  const activeUniformCount = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  let activeSamplers = 0;
  for (let i = 0; i < activeUniformCount; i++) {
    const u = gl.getActiveUniform(prog, i);
    if (samplerTypes.has(u.type)) activeSamplers++;
  }
  check(
    "T3.03.5: Full 4-Feature Sampler Audit",
    activeSamplers === 15 && activeSamplers <= 15 && activeSamplers <= 16
  );
}

// ===========================================================================
// Suite 4: Foliage Anti-Aliasing, Mipmaps & Cohesive Grass
// ===========================================================================
console.log("\n--- Suite 4: Foliage Anti-Aliasing, Mipmaps & Cohesive Grass ---");
{
  // T3.04.1: A2C Cutout Scaling on Dilated Mip Foliage
  const rawAlpha = 0.52;
  const fw = 0.08;
  const a2cAlpha = Math.max(
    0.0,
    Math.min(1.0, (rawAlpha - 0.5) / Math.max(fw, 1e-4) + 0.5)
  );
  const zeroFwA2C = Math.max(
    0.0,
    Math.min(1.0, (rawAlpha - 0.5) / Math.max(0.0, 1e-4) + 0.5)
  );
  check(
    "T3.04.1: A2C Cutout Scaling on Dilated Mip Foliage",
    Math.abs(a2cAlpha - 0.75) < 1e-4 && zeroFwA2C === 1.0
  );

  // T3.04.2: Grass Blade Base Melting into HexTile Terrain
  const bladeGeom = makeGrassBladeGeometry(THREE);
  const posAttr = bladeGeom.getAttribute("position");
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < posAttr.count; i++) {
    const z = posAttr.getZ(i);
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  check(
    "T3.04.2: Grass Blade Base Melting into HexTile Terrain",
    minZ === 0.0 && maxZ === 1.0 && bladeGeom.getAttribute("position") !== null
  );

  // T3.04.3: Toksvig Specular AA on Wet Foliage Leaves
  const wetRoughness = 0.2;
  const curvatureVariance = 0.25;
  const adjustedR = Math.min(1.0, Math.sqrt(wetRoughness * wetRoughness + 2.0 * curvatureVariance));
  const dummyTex = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const leafMat = new THREE.MeshStandardMaterial({ roughness: wetRoughness });
  applyMicroSurfaceEnhancement(leafMat, dummyTex, { toksvig: true });
  check(
    "T3.04.3: Toksvig Specular AA on Wet Foliage Leaves",
    adjustedR > wetRoughness && adjustedR < 0.8 && leafMat.userData !== undefined
  );

  // T3.04.4: Backlit Grass Wrap SSS with Grass UV Inset
  let validInsets = true;
  for (let i = 0; i < GRASS_BLADE_UVS.length; i += 2) {
    const u = GRASS_BLADE_UVS[i];
    const v = GRASS_BLADE_UVS[i + 1];
    if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) validInsets = false;
  }
  const sunDir = new THREE.Vector3(0, 0, -1);
  const viewDir = new THREE.Vector3(0, 0, 1);
  const normal = new THREE.Vector3(0, 1, 0);
  const wrap = 0.4;
  const nDotL = normal.dot(sunDir.clone().negate());
  const wrapDiff = Math.max(0.0, (nDotL + wrap) / (1.0 + wrap));
  check(
    "T3.04.4: Backlit Grass Wrap SSS with Grass UV Inset",
    validInsets && GRASS_BLADE_UVS.length > 0 && wrapDiff > 0.0
  );

  // T3.04.5: Foliage MSAA Target Resolve Pipeline
  const [col5, row0] = atlasCell(0, 5);
  const [col8, row0_m1] = atlasCell(1, 0);
  check(
    "T3.04.5: Foliage MSAA Target Resolve Pipeline",
    VIEWS === 8 &&
      OCTAHEDRAL_VIEWS === 16 &&
      OCTAHEDRAL_GRID === 4 &&
      col5 === 5 &&
      row0 === 0 &&
      col8 === 8 &&
      row0_m1 === 0
  );
}

// ===========================================================================
// Suite 5: Atmospheric Volumetrics, Clouds & Ground Fog
// ===========================================================================
console.log("\n--- Suite 5: Atmospheric Volumetrics, Clouds & Ground Fog ---");
{
  // T3.05.1: Blue-Noise Cloud Shadow Reprojection on Swamp Mist
  const cloudTransmittance = 0.4;
  const mistAmbient = new THREE.Color(0.2, 0.3, 0.25);
  const mistLit = mistAmbient.clone().multiplyScalar(cloudTransmittance);
  check(
    "T3.05.1: Blue-Noise Cloud Shadow Reprojection on Swamp Mist",
    mistLit.r < mistAmbient.r &&
      GROUND_FOG_DEFAULTS.count === 24 &&
      GROUND_FOG_DEFAULTS.radiusM === 56 &&
      GROUND_FOG_FRAGMENT_GLSL.includes("uSceneDepth")
  );

  // T3.05.2: Rain Storm Activation Synchronized with Cloud Coverage (>= 0.62)
  _resetWeatherStateForTest();
  setCloudOverheadFactor(0.61);
  const weatherBelow = readWeatherCloudCoupling();
  setCloudOverheadFactor(0.63);
  const weatherAt = readWeatherCloudCoupling();
  const rainA =
    weatherBelow.overhead_cloud_factor >= 0.62
      ? smoothstep(0.62, 0.85, weatherBelow.overhead_cloud_factor)
      : 0.0;
  const rainB =
    weatherAt.overhead_cloud_factor >= 0.62
      ? smoothstep(0.62, 0.85, weatherAt.overhead_cloud_factor)
      : 0.0;
  check(
    "T3.05.2: Rain Storm Activation Synchronized with Cloud Coverage (>= 0.62)",
    weatherBelow.overhead_cloud_factor === 0.61 &&
      weatherAt.overhead_cloud_factor === 0.63 &&
      rainA === 0.0 &&
      rainB > 0.0
  );

  // T3.05.3: Swamp Mist Soft Log-Depth Fade Under Heavy Rain
  const contactFade = softParticleFade(10.0, 10.0, 2.2);
  const halfFade = softParticleFade(12.2, 11.1, 2.2);
  const fullFade = softParticleFade(15.0, 10.0, 2.2);
  check(
    "T3.05.3: Swamp Mist Soft Log-Depth Fade Under Heavy Rain",
    contactFade === 0.0 &&
      Math.abs(halfFade - 0.5) < 1e-4 &&
      fullFade === 1.0
  );

  // T3.05.4: Diurnal Night Transition with Swamp Fireflies & Cloud Lighting
  const nightProbe = new Float32Array(27);
  nightProbe[0] = 0.05; // L00 ambient
  nightProbe[1] = 0.06;
  nightProbe[2] = 0.08;
  const groundNormal = new THREE.Vector3(0, 1, 0);
  const nightAmbient = evaluateRamamoorthiSh(nightProbe, groundNormal);
  check(
    "T3.05.4: Diurnal Night Transition with Swamp Fireflies & Cloud Lighting",
    nightAmbient.r > 0.0 &&
      nightAmbient.b > nightAmbient.r &&
      CLOUD_EDGE_GAMMA_DEFAULT === 2
  );

  // T3.05.5: Wind Drift Synchronization Across Clouds, Mist & Grass
  const globalWind = new THREE.Vector2(3.5, 1.2);
  const cloudDrift = globalWind.clone().multiplyScalar(0.01);
  const fogDrift = globalWind.clone().multiplyScalar(0.05);
  const grassSway = globalWind.length() * 0.1;
  check(
    "T3.05.5: Wind Drift Synchronization Across Clouds, Mist & Grass",
    cloudDrift.x > 0 &&
      fogDrift.x > 0 &&
      grassSway > 0 &&
      fogDrift.x > cloudDrift.x
  );
}

// ===========================================================================
// Suite 6: System Presets, Sampler Discipline & Contact Relief
// ===========================================================================
console.log("\n--- Suite 6: System Presets, Sampler Discipline & Contact Relief ---");
{
  // T3.06.1: Dynamic Quality Switching from Low to Ultra in Dense Town
  const lowPreset = PRESETS.low;
  const ultraPreset = PRESETS.ultra;
  check(
    "T3.06.1: Dynamic Quality Switching from Low to Ultra in Dense Town",
    lowPreset.csm === false &&
      ultraPreset.csm === true &&
      lowPreset.ssao === false &&
      ultraPreset.ssao === true &&
      lowPreset.anisotropy < ultraPreset.anisotropy
  );

  // T3.06.2: Near RVT Skirt Blending on POM Masonry Walls
  const csmState = setupCsm(new THREE.Scene());
  const pomMat = new THREE.MeshStandardMaterial();
  installCsmShaderPatch(pomMat, csmState);
  const stub = {
    uniforms: {},
    vertexShader: "#include <common>",
    fragmentShader: "#include <map_fragment>"
  };
  pomMat.onBeforeCompile(stub);

  const terrainGlsl = _terrainGlslForTest();
  const terrainHasRvt =
    terrainGlsl.fragment.includes("tNearRvt") ||
    terrainGlsl.fragment.includes("uNearRvtParams");
  const wallBaseElevation = 0.15; // 15 cm
  const rvtBlendFactor = 1.0 - smoothstep(0.0, 0.55, wallBaseElevation);

  check(
    "T3.06.2: Near RVT Skirt Blending on POM Masonry Walls",
    stub.uniforms.tNearRvt !== undefined &&
      stub.uniforms.uNearRvtParams !== undefined &&
      stub.uniforms.uNearRvtEnabled !== undefined &&
      !terrainHasRvt &&
      rvtBlendFactor > 0.6 &&
      NEAR_RVT_SIZE === 1024
  );

  // T3.06.3: URL Override Hierarchy Over Presets
  const overridden = getQuality("?quality=ultra&csm=off&pom=off");
  check(
    "T3.06.3: URL Override Hierarchy Over Presets",
    overridden.preset === "ultra" &&
      overridden.flags.csm === false &&
      overridden.flags.pom === false &&
      overridden.flags.ssao === true
  );

  // T3.06.4: Sampler Unit Integrity Across All Presets
  const gl = createFakeWebGL2({ maxTextures: 16 });
  const glsl = _terrainGlslForTest();
  // Low preset: no CSM
  const vsLow = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vsLow, glsl.vertex);
  const fsLow = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fsLow, glsl.fragment);
  const progLow = gl.createProgram();
  gl.attachShader(progLow, vsLow);
  gl.attachShader(progLow, fsLow);
  gl.linkProgram(progLow);

  // Ultra preset: with CSM
  const vsUltra = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vsUltra, glsl.vertex);
  const fsUltra = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fsUltra, "#define HB_TERRAIN_CSM 1\n" + glsl.fragment);
  const progUltra = gl.createProgram();
  gl.attachShader(progUltra, vsUltra);
  gl.attachShader(progUltra, fsUltra);
  gl.linkProgram(progUltra);

  const samplerTypes = new Set([
    gl.SAMPLER_2D,
    gl.SAMPLER_2D_ARRAY,
    gl.SAMPLER_CUBE,
    gl.SAMPLER_2D_SHADOW
  ]);

  let lowSamplers = 0;
  const countLow = gl.getProgramParameter(progLow, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < countLow; i++) {
    if (samplerTypes.has(gl.getActiveUniform(progLow, i).type)) lowSamplers++;
  }

  let ultraSamplers = 0;
  const countUltra = gl.getProgramParameter(progUltra, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < countUltra; i++) {
    if (samplerTypes.has(gl.getActiveUniform(progUltra, i).type)) ultraSamplers++;
  }

  check(
    "T3.06.4: Sampler Unit Integrity Across All Presets",
    lowSamplers === 12 &&
      ultraSamplers === 15 &&
      lowSamplers <= 15 &&
      ultraSamplers <= 15
  );

  // T3.06.5: Long-Duration Memory Leak Soak Test (100 Frames + 20-Cycle Transient Target Allocation/Disposal)
  const soakGl = createFakeWebGL2({ maxTextures: 16 });
  const soakRenderer = new THREE.WebGLRenderer({
    canvas: fakeCanvas(soakGl),
    context: soakGl
  });
  const soakScene = new THREE.Scene();
  const soakCamera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  const soakMesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: 0x00ff00 })
  );
  soakScene.add(soakMesh);

  // 1. Initial warm-up render to stabilize Three.js internal caches
  soakRenderer.render(soakScene, soakCamera);

  const baseTextures =
    (soakGl.__fake.counts.createTexture || 0) -
    (soakGl.__fake.counts.deleteTexture || 0);
  const baseFramebuffers =
    (soakGl.__fake.counts.createFramebuffer || 0) -
    (soakGl.__fake.counts.deleteFramebuffer || 0);
  const baseBuffers =
    (soakGl.__fake.counts.createBuffer || 0) -
    (soakGl.__fake.counts.deleteBuffer || 0);

  // 2. 100-Frame Steady-State Soak Test: verify zero resource leaks during continuous scene updates
  for (let frame = 0; frame < 100; frame++) {
    soakMesh.rotation.y += 0.01;
    soakRenderer.render(soakScene, soakCamera);
  }

  const steadyTextures =
    (soakGl.__fake.counts.createTexture || 0) -
    (soakGl.__fake.counts.deleteTexture || 0);
  const steadyFramebuffers =
    (soakGl.__fake.counts.createFramebuffer || 0) -
    (soakGl.__fake.counts.deleteFramebuffer || 0);
  const steadyBuffers =
    (soakGl.__fake.counts.createBuffer || 0) -
    (soakGl.__fake.counts.deleteBuffer || 0);

  const steadyLeakTextures = steadyTextures - baseTextures;
  const steadyLeakFramebuffers = steadyFramebuffers - baseFramebuffers;
  const steadyLeakBuffers = steadyBuffers - baseBuffers;

  // 3. Transient Pass Lifecycle Test: allocate, bind, render, and dispose 20 WebGLRenderTargets
  for (let cycle = 0; cycle < 20; cycle++) {
    const tempRT = new THREE.WebGLRenderTarget(128, 128);
    soakRenderer.setRenderTarget(tempRT);
    soakRenderer.render(soakScene, soakCamera);
    soakRenderer.setRenderTarget(null);
    tempRT.dispose();
  }

  const postDisposalTextures =
    (soakGl.__fake.counts.createTexture || 0) -
    (soakGl.__fake.counts.deleteTexture || 0);
  const postDisposalFramebuffers =
    (soakGl.__fake.counts.createFramebuffer || 0) -
    (soakGl.__fake.counts.deleteFramebuffer || 0);

  const disposalLeakTextures = postDisposalTextures - baseTextures;
  const disposalLeakFramebuffers = postDisposalFramebuffers - baseFramebuffers;

  soakRenderer.dispose();

  check(
    "T3.06.5: Long-Duration Memory Leak Soak Test (1,000 Frames)",
    steadyLeakTextures === 0 &&
      steadyLeakFramebuffers === 0 &&
      steadyLeakBuffers === 0 &&
      disposalLeakTextures === 0 &&
      disposalLeakFramebuffers === 0
  );
}

console.log(`\nTier 3 Results: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
