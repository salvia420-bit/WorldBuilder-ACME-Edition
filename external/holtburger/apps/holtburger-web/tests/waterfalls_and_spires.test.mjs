// tests/waterfalls_and_spires.test.mjs
//
// Comprehensive unit suite for WS-4:
//   - Item 4A: Slope-aware waterfall shading (`terrain.js`, `terrain_water_flow.js`, `far_terrain.js`),
//              vertical UV de-smearing, wN/Fresnel sky-wash fix, Beer-Lambert navy suppression,
//              Marae Lassel steep `code-23` (`SeaSlime`) cascade promotion, and far-terrain foam.
//   - Item 4B: Site-driven long-range (`1,800 m`) 3D waterfall curtains, lip foam, billowing
//              plunge mist, and turbulent plunge boil (`scene3d/terrain_waterfalls.js`) across
//              `data/water_flow_sites.json` (Nanto `0xE43D`, Cragstone `0xB6A3`, Marae `0x1DB4`,
//              zero-anchor Marae cascades `0x1CBC`/`0x1FBC`/`0x1FBF` < 82.000 m, `0x24BC`,
//              `0xEA74`, `0x22E6`, `0xF419`, `0xD5DA`, `0xEC13`, `0xED0E`).
//   - Item 4C: Upgraded `water_sheet` particle family (`0x32000031`, `0x320004A2`, `0x320004A4`,
//              `0x3200063A`, `0x3200063B`) stretch `0.40` + filament shader (`particle_fx.js`).
//   - Item 7A: Volcano/Magma full-screen haze decoupled from `?terrainHaze` onto explicit
//              opt-in `?terrainVolcanoHaze=on` (default OFF on all tiers), Desert Haze untouched.
//   - Item 7B: Obnoxious Spire/Magma `fxDistort` screen warps & yellow Spire lights stripped
//              (`particle-fx-tier1.json`, `particle_fx.js`), `MAX_SCREEN_RADIUS === 0.16`
//              (`fx_distort.js`), `0x020015B9` `"dark"` (`portal_setups.js`), `world_terrain.js`
//              obsidian sheen `0.30`.
//   - Item 7C: Grounded world-space convective molten-magma drift + basalt-rim incandescence
//              (`terrain.js`) and GPU-instanced Shadow Spire dark-violet miasma + obsidian
//              void-shard wisps (`scene3d/terrain_spires_vfx.js`).

import * as THREE from "three";
import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { checkTerrainFinalColour } from "../harness/lib/terrain_final_colour.mjs";
import { PRESETS as QUALITY_PRESETS, getQuality } from "../scene3d/quality.js";
import {
  _resetVfxFlags,
  heatHazeEnabled,
  terrainVolcanoHazeEnabled,
  volcanoHazeEnabled,
  terrainWaterfallsEnabled,
  terrainSpiresEnabled,
  vfxEffectEnabled,
} from "../scene3d/vfx_flags.js";
import {
  resolveVolcanoQuality,
  initTerrainVolcano,
  terrainVolcanoStats,
  _resetTerrainVolcano,
} from "../scene3d/terrain_volcano.js";
import {
  initTerrainVfx,
  terrainVfxTick,
  _resetTerrainVfx,
  lbKeyFromXY,
} from "../scene3d/terrain_vfx.js";
import {
  WATER_FLOW_MAIN_GLSL,
  WATER_FOAM_APPLY_GLSL,
} from "../scene3d/terrain_water_flow.js";
import {
  WATERFALLS_PROVIDER_ID,
  WATERFALL_ENGAGE_M,
  WATERFALL_DROP_M,
  MARAE_DAM_CLEARANCE_MAX_Z,
  loadWaterfallSites,
  classifyWaterfallSite,
  activeWaterfallSitesNear,
  buildWaterfallCurtainData,
  buildPlungeMistData,
  buildPlungeBoilData,
  initWaterfallsVfx,
  waterfallsVfxStats,
  _resetWaterfallsVfx,
  WATERFALL_CURTAIN_VERTEX_GLSL,
  WATERFALL_CURTAIN_FRAGMENT_GLSL,
  WATERFALL_MIST_VERTEX_GLSL,
  WATERFALL_MIST_FRAGMENT_GLSL,
  WATERFALL_BOIL_VERTEX_GLSL,
  WATERFALL_BOIL_FRAGMENT_GLSL,
} from "../scene3d/terrain_waterfalls.js";
import {
  SPIRES_PROVIDER_ID,
  SPIRE_SETUP_IDS,
  SPIRE_LANDBLOCKS,
  detectResidentSpireSites,
  buildSpireMiasmaInstances,
  buildSpireWispInstances,
  initSpiresVfx,
  spiresVfxStats,
  _resetSpiresVfx,
  SPIRE_MIASMA_VERTEX_GLSL,
  SPIRE_MIASMA_FRAGMENT_GLSL,
  SPIRE_WISP_VERTEX_GLSL,
  SPIRE_WISP_FRAGMENT_GLSL,
} from "../scene3d/terrain_spires_vfx.js";
import { hasLogDepth, withLogDepth } from "../scene3d/shader_logdepth.js";
import {
  MAX_SCREEN_RADIUS,
  SPIRE_EDDY_DIDS,
  STATIC_NO_DISTORT_DIDS,
  addFxDistortSource,
  releaseFxDistortSource,
  collectFxDistortSources,
} from "../scene3d/vfx/fx_distort.js";
import {
  bindEmitterFxLight,
  releaseFxLight,
} from "../scene3d/vfx/fx_lights.js";
import { PORTAL_SETUPS } from "../scene3d/vfx/portal_setups.js";
import {
  registerStaticPortalAnchor,
  _resetStaticPortalsForTest,
} from "../scene3d/vfx/portal_registry.js";
import {
  particleFxRowFor,
  particleFxTier1,
} from "../scene3d/particles/particle_fx.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolvePath(HERE, "..");

let passed = 0;
let failed = 0;

function check(label, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`  [OK] ${label}`);
  } else {
    failed += 1;
    console.error(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function setSearch(search) {
  globalThis.window = { location: { search } };
  _resetVfxFlags();
}

// ============================================================================
// 1. Fix 4A — Slope-Aware Terrain & Far-Terrain Waterfall Shading
// ============================================================================
console.log("\n-- 1. Fix 4A: Slope-aware terrain & far-terrain waterfall shading --");
{
  const terrainSrc = readFileSync(resolvePath(ROOT, "scene3d/terrain.js"), "utf8");
  const farSrc = readFileSync(resolvePath(ROOT, "scene3d/far_terrain.js"), "utf8");

  check(
    "terrain.js final fragColor line passes checkTerrainFinalColour byte-lock",
    checkTerrainFinalColour(terrainSrc).ok,
  );
  check(
    "terrain.js computes waterfallSlope = smoothstep(0.12, 0.45, 1.0 - clamp(waterGeomN.z, ...))",
    terrainSrc.includes("float waterfallSlope = smoothstep(0.12, 0.45, 1.0 - clamp(waterGeomN.z, 0.0, 1.0));"),
  );
  check(
    "terrain_water_flow.js projects vWorldPos.y along fallDir to eliminate vertical UV smearing",
    WATER_FLOW_MAIN_GLSL.includes("vec2 waterfallVertShift = fallDir * (vWorldPos.y * steepCascade);") &&
      WATER_FLOW_MAIN_GLSL.includes("waterOffA = flowMs * (period * ph0) + waterfallVertShift;"),
  );
  check(
    "terrain_water_flow.js adds striated vertical whitewater ribbons in WATER_FOAM_APPLY_GLSL",
    WATER_FOAM_APPLY_GLSL.includes("effFoamWaterW = clamp(waterW + slimeCascadeW, 0.0, 1.0)") &&
      WATER_FOAM_APPLY_GLSL.includes("(dot(gpFoam, fAxis) - vWorldPos.y - length(waterOffA))"),
  );
  check(
    "terrain.js blends wN toward geomN and attenuates grazing mirror Fresnel by 0.72 * waterfallSlope",
    terrainSrc.includes("wN = normalize(mix(wN, geomN, waterfallSlope));") &&
      terrainSrc.includes("fresW *= 1.0 - 0.72 * waterfallSlope;"),
  );
  check(
    "terrain.js attenuates Beer-Lambert depth darkening by (1.0 - 0.85 * waterfallSlope)",
    terrainSrc.includes("(1.0 - 0.85 * waterfallSlope)"),
  );
  check(
    "terrain.js promotes Marae Lassel steep code-23 (SeaSlime) cascades & suppresses cliff rock overwrite",
    terrainSrc.includes("slimeCascadeW") &&
      terrainSrc.includes("(1.0 - waterW) * (1.0 - slimeCascadeW)"),
  );
  check(
    "far_terrain.js renders bright whitewater foam & attenuates fresW on steep distant falls",
    farSrc.includes("farWaterfallSlope") &&
      farSrc.includes("(1.0 - 0.72 * farWaterfallSlope)") &&
      farSrc.includes("farCascade"),
  );
}

// ============================================================================
// 2. Fix 4B — Site-Driven Long-Range (1,800 m) 3D Waterfall Curtains, Mist & Boil
// ============================================================================
console.log("\n-- 2. Fix 4B: Site-driven 1,800 m 3D waterfall curtains, mist & boil --");
{
  const loaded = await loadWaterfallSites();
  check("data/water_flow_sites.json loads all 31 catalogued sites", loaded.catalogCount === 31);
  check("21 waterfall/cascade sites have drop >= 1.0 m", loaded.sites.length === 21, `got ${loaded.sites.length}`);

  const byLb = new Map();
  for (const s of loaded.sites) {
    const arr = byLb.get(s.lb) || [];
    arr.push(s);
    byLb.set(s.lb, arr);
  }

  for (const reqLb of [
    "0XE43D", // Nanto Blue Ghost Falls 50 m
    "0XB6A3", // Cragstone Falls 26 m
    "0X1DB4", // Marae Lassel main river fall 28 m
    "0X1CBC", // Marae pool cascade west 28 m (0 anchors)
    "0X1FBC", // Marae pool cascade east 28 m (0 anchors)
    "0X1FBF", // Marae pool cascade north 28 m (0 anchors)
    "0X24BC", // Marae spring 1.5 m
    "0XEA74", // Behind the Waterfall 50 m
    "0X22E6", // Cataracts of Sabella 30 m
    "0XF419", // Ithaenc Island falls 100 m
    "0XD5DA", // 104 m cliff fall
    "0XEC13", // 160 m cliff fall
    "0XED0E", // 234 m grand fall
  ]) {
    check(`site present and classified for ${reqLb}`, byLb.has(reqLb));
  }

  // Verify Marae Lassel dam deck clearance (< 82.000 m at 0x1FBC) on every vertex!
  const maraeEast = byLb.get("0X1FBC")[0];
  check("Marae 0x1FBC classified as marae-cascade", maraeEast.archetype === "marae-cascade");
  const maraeCurtain = buildWaterfallCurtainData(maraeEast);
  let maxMaraeZ = -Infinity;
  for (let i = 2; i < maraeCurtain.positions.length; i += 3) {
    if (maraeCurtain.positions[i] > maxMaraeZ) maxMaraeZ = maraeCurtain.positions[i];
  }
  check(
    `Marae 0x1FBC curtain stays strictly under 82.000 m dam deck (maxZ=${maxMaraeZ.toFixed(3)})`,
    maxMaraeZ <= MARAE_DAM_CLEARANCE_MAX_Z && maxMaraeZ < 82.0,
  );

  // Verify parabolic trajectory & geometry completeness on Cragstone (steep cataract) & Nanto (cliff gap).
  const cragstone = byLb.get("0XB6A3")[0];
  const cragCurtain = buildWaterfallCurtainData(cragstone);
  const cragMist = buildPlungeMistData(cragstone, undefined, cragCurtain.impactCenter);
  const cragBoil = buildPlungeBoilData(cragstone, undefined, cragCurtain.impactCenter);
  check("Cragstone curtain builds valid vertices + triangles", cragCurtain.vertexCount > 100 && cragCurtain.triangleCount > 150);
  check("Cragstone plunge mist builds deterministic rising plumes", cragMist.plumeCount >= 8 && cragMist.triangleCount >= 16);
  check("Cragstone plunge boil builds concentric ring disc at lower_z", cragBoil.triangleCount >= 56);

  // Check determinism: two builds produce byte-identical Float32Arrays.
  const cragCurtain2 = buildWaterfallCurtainData(cragstone);
  let maxDiff = 0;
  for (let i = 0; i < cragCurtain.positions.length; i += 1) {
    maxDiff = Math.max(maxDiff, Math.abs(cragCurtain.positions[i] - cragCurtain2.positions[i]));
  }
  check("buildWaterfallCurtainData is 100% deterministic (zero Math.random)", maxDiff === 0);

  // Verify 1,800 m engagement + 1,980 m hysteresis at Nanto Blue Ghost Falls (0xE43D).
  const nanto = byLb.get("0XE43D")[0];
  check("WATERFALL_ENGAGE_M === 1800 & WATERFALL_DROP_M === 1980", WATERFALL_ENGAGE_M === 1800 && WATERFALL_DROP_M === 1980);
  const eyeAt1650 = { x: nanto.lip[0] - 1650, y: nanto.lip[1], z: nanto.lip[2] };
  const eyeAt1900 = { x: nanto.lip[0] - 1900, y: nanto.lip[1], z: nanto.lip[2] };
  const eyeAt2100 = { x: nanto.lip[0] - 2100, y: nanto.lip[1], z: nanto.lip[2] };
  check(
    "Nanto 0xE43D engages at 1,650 m (well beyond the 384 m static script dropout)",
    activeWaterfallSitesNear(loaded.sites, eyeAt1650).some((x) => x.site.lb === "0XE43D"),
  );
  check(
    "Nanto 0xE43D does not cold-engage at 1,900 m, but stays active via 1,980 m hysteresis",
    !activeWaterfallSitesNear(loaded.sites, eyeAt1900, new Set()).some((x) => x.site.lb === "0XE43D") &&
      activeWaterfallSitesNear(loaded.sites, eyeAt1900, new Set([nanto.id])).some((x) => x.site.lb === "0XE43D"),
  );
  check(
    "Nanto 0xE43D releases cleanly past 1,980 m (at 2,100 m)",
    !activeWaterfallSitesNear(loaded.sites, eyeAt2100, new Set([nanto.id])).some((x) => x.site.lb === "0XE43D"),
  );

  // Verify GLSL shaders have zero backticks, gravity UV stretch, dual-speed threads, and log-depth support.
  for (const [name, vs, fs] of [
    ["curtain", WATERFALL_CURTAIN_VERTEX_GLSL, WATERFALL_CURTAIN_FRAGMENT_GLSL],
    ["mist", WATERFALL_MIST_VERTEX_GLSL, WATERFALL_MIST_FRAGMENT_GLSL],
    ["boil", WATERFALL_BOIL_VERTEX_GLSL, WATERFALL_BOIL_FRAGMENT_GLSL],
  ]) {
    check(`${name} GLSL contains no stray backticks`, !vs.includes("`") && !fs.includes("`"));
    const patched = withLogDepth({ vertexShader: vs, fragmentShader: fs });
    check(`${name} GLSL patches cleanly with withLogDepth`, hasLogDepth(patched.vertexShader) && hasLogDepth(patched.fragmentShader));
  }
  check(
    "curtain fragment shader has gravity-accelerating UV stretch & dual-speed striations",
    WATERFALL_CURTAIN_FRAGMENT_GLSL.includes("gravV") &&
      WATERFALL_CURTAIN_FRAGMENT_GLSL.includes("uvSlow") &&
      WATERFALL_CURTAIN_FRAGMENT_GLSL.includes("uvFast"),
  );

  // End-to-end runtime lifecycle with real THREE + terrain_vfx spine.
  setSearch("");
  _resetTerrainVfx();
  _resetWaterfallsVfx();
  const worldRoot = new THREE.Group();
  const terrainGroup = new THREE.Group();
  worldRoot.add(terrainGroup);
  // Three camera at Nanto lip + 600 m: Three (x, y=up, z=-north).
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.25, 10000);
  cam.position.set(nanto.lip[0] - 600, nanto.lip[2] + 40, -nanto.lip[1]);
  const scene3d = {
    terrainGroup,
    camera: cam,
    quality: getQuality("?quality=high"),
    frameTime: { tsSec: 12.5, dt: 0.016 },
  };
  initTerrainVfx({ THREE, scene3d });
  const wfHandle = initWaterfallsVfx({ THREE, scene3d, sites: loaded.sites });
  await wfHandle.ready;
  terrainVfxTick(0.016, scene3d, 12.5);
  const wfStats = waterfallsVfxStats();
  check(
    "initWaterfallsVfx activates Nanto 0xE43D with 3 child meshes (curtain, boil, mist) in worldRoot",
    wfStats.activeCount >= 1 &&
      wfStats.activeSites.some((s) => s.lb === "0XE43D") &&
      wfHandle.rootGroup.parent === worldRoot &&
      wfHandle.rootGroup.children[0].children.length === 3,
  );
  _resetWaterfallsVfx();
  _resetTerrainVfx();
}

// ============================================================================
// 3. Fix 4C — Waterfall Archetypes across Marae, Nanto & Cragstone
// ============================================================================
console.log("\n-- 3. Fix 4C: Waterfall archetypes & particle profile integrity --");
{
  const loaded = await loadWaterfallSites();
  const archetypes = new Set(loaded.sites.map((s) => s.archetype));
  check(
    "classifyWaterfallSite distinguishes marae-cascade, cliff-gap, cataract, spill, and spring",
    archetypes.has("marae-cascade") &&
      archetypes.has("cliff-gap") &&
      archetypes.has("cataract") &&
      archetypes.has("spill") &&
      archetypes.has("spring"),
    `got ${[...archetypes].join(",")}`,
  );
  for (const did of [0x32000031, 0x320004a2, 0x320004a4, 0x3200063a, 0x3200063b]) {
    const row = particleFxRowFor({ id: did });
    check(`waterfall emitter 0x${did.toString(16)} resolves valid particleFxRow`, row > 0);
  }
}

// ============================================================================
// 4. Fix 7A — Decouple Volcano/Magma Full-Screen Haze; Preserve Desert Haze 100%
// ============================================================================
console.log("\n-- 4. Fix 7A: Volcano/Magma haze default OFF; Desert Haze 100% intact --");
{
  setSearch("");
  for (const preset of ["low", "mid", "high", "ultra"]) {
    const q = QUALITY_PRESETS[preset];
    globalThis.window = { location: { search: "" }, liveScene3d: { quality: { preset, flags: q } } };
    _resetVfxFlags();
    check(`QUALITY_PRESETS.${preset}.terrainVolcanoHaze === false`, q.terrainVolcanoHaze === false);
    check(`terrainVolcanoHazeEnabled(${preset}) === false by default`, terrainVolcanoHazeEnabled() === false);
    check(`volcanoHazeEnabled(${preset}) === false by default`, volcanoHazeEnabled() === false);
    check(`vfxEffectEnabled('terrain.volcanoHaze') at ${preset} === false`, vfxEffectEnabled("terrain.volcanoHaze") === false);
    const vq = resolveVolcanoQuality(q);
    check(
      `resolveVolcanoQuality(${preset}) zeroes hazeStrength & hazeRadiusM`,
      preset === "low" ? vq === null : (vq.hazeStrength === 0 && vq.hazeRadiusM === 0),
    );
  }
  // Desert haze stays ON at high/ultra!
  globalThis.window = { location: { search: "" }, liveScene3d: { quality: { preset: "high", flags: QUALITY_PRESETS.high } } };
  _resetVfxFlags();
  check("Desert Haze stays ON at high/ultra", heatHazeEnabled() === true && vfxEffectEnabled("terrain.desertHaze") === true);

  // Explicit opt-in `?terrainVolcanoHaze=on` still works when requested.
  setSearch("?terrainVolcano=on&terrainVolcanoHaze=on");
  check("?terrainVolcanoHaze=on enables volcanoHaze explicitly", volcanoHazeEnabled(QUALITY_PRESETS.high) === true);
  initTerrainVolcano({ scene3d: { quality: { preset: "high", flags: QUALITY_PRESETS.high } } });
  check("initTerrainVolcano reports haze=true under ?terrainVolcanoHaze=on", terrainVolcanoStats().haze === true);
  _resetTerrainVolcano();
  setSearch("");
}

// ============================================================================
// 5. Fix 7B — Eliminate Obnoxious Spire/Magma fxDistort Warps & Garish Lights
// ============================================================================
console.log("\n-- 5. Fix 7B: Eliminate Spire/Magma fxDistort warps & clamp screen radius --");
{
  setSearch("?fxDistort=on&fxLights=on");
  const resolveDummy = (out) => { out.set(0, 0, -5); return true; };

  // Shadow Spire ground vortex eddies 0x32000490..0x32000495: suppressed in fx_distort & fx_lights!
  for (const did of SPIRE_EDDY_DIDS) {
    const hex = "0x" + did.toString(16).toUpperCase().padStart(8, "0");
    const dHandle = addFxDistortSource({
      emitterDid: did,
      kind: 2,
      strength: 0.72,
      radius: 12,
      resolvePosition: resolveDummy,
    });
    const lHandle = bindEmitterFxLight({
      emitter: { emitterInfoId: did },
      emitterDid: did,
      intensity: 40,
      range: 12,
      color: [1, 0.9, 0.2],
      resolvePosition: resolveDummy,
    });
    check(
      `${hex} suppressed from both fxDistort screen-warp and garish yellow fxLights`,
      dHandle === null && lHandle === null,
    );
  }

  // Giant static Spire/Magma landscape emitters: suppressed in fx_distort!
  for (const did of STATIC_NO_DISTORT_DIDS) {
    const hex = "0x" + did.toString(16).toUpperCase().padStart(8, "0");
    const dHandle = addFxDistortSource({
      emitterDid: did,
      kind: 1,
      strength: 0.65,
      radius: 12,
      resolvePosition: resolveDummy,
    });
    check(`${hex} suppressed from fxDistort screen-warp`, dHandle === null);
  }

  // Portal swirl 0x320003B2 remains intact.
  const portalSwirl = particleFxTier1(particleFxRowFor({ id: 0x320003b2 }));
  const pDist = addFxDistortSource({
    emitterDid: 0x320003b2,
    kind: portalSwirl.distortKind,
    strength: portalSwirl.distort,
    radius: portalSwirl.distortRadius,
    resolvePosition: resolveDummy,
  });
  check("0x320003B2 portal swirl distort remains intact", pDist !== null && portalSwirl.distort > 0 && portalSwirl.distortKind === 2);
  releaseFxDistortSource(pDist);
  setSearch("");

  // fx_distort.js MAX_SCREEN_RADIUS clamped to 0.16!
  check("fx_distort.js MAX_SCREEN_RADIUS === 0.16", MAX_SCREEN_RADIUS === 0.16);
  setSearch("?fxDistort=on");
  const testCam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  testCam.position.set(0, 0, 0);
  testCam.lookAt(0, 0, -10);
  testCam.updateMatrixWorld(true);
  testCam.updateProjectionMatrix();
  const srcHandle = addFxDistortSource({
    kind: 2,
    strength: 1.0,
    radius: 12,
    resolvePosition: (out) => { out.set(0, 0, -2); return true; },
  });
  const collected = [];
  collectFxDistortSources(testCam, collected, 1000);
  releaseFxDistortSource(srcHandle);
  setSearch("");
  check(
    "fx_distort.js clamps projected screen radius <= 0.16",
    collected.length === 1 && collected[0].r <= 0.16 + 1e-6,
  );

  // portal_setups.js 0x020015B9 Shadow Rift -> kind: "dark"
  check('portal_setups.js 0x020015B9 is kind === "dark"', PORTAL_SETUPS.get(0x020015b9)?.kind === "dark");

  // world_terrain.js obsidian sheen aligned to 0.30
  const worldTerrSrc = readFileSync(resolvePath(ROOT, "scene3d/world_terrain.js"), "utf8");
  check(
    "world_terrain.js aligns obsidian sheen to 0.30 (not 0.95)",
    worldTerrSrc.includes("0.30 * obsFres * obsGlassy * obsSheenFade * obsidianW") &&
      !worldTerrSrc.includes("0.95 * obsFres"),
  );
}

// ============================================================================
// 6. Fix 7C — Grounded World-Space Magma Convection & Shadow Spire Miasma/Wisps
// ============================================================================
console.log("\n-- 6. Fix 7C: World-space Magma convection & GPU-instanced Shadow Spires VFX --");
{
  const terrainSrc = readFileSync(resolvePath(ROOT, "scene3d/terrain.js"), "utf8");
  check(
    "terrain.js Volcano1 lava crack shader includes slow convective molten drift & basalt-rim incandescence",
    terrainSrc.includes("magmaConvA") && terrainSrc.includes("magmaSurge") && terrainSrc.includes("basaltRimW"),
  );

  check("SPIRE_SETUP_IDS covers all 9 Spire/Rift setups", SPIRE_SETUP_IDS.length === 9);
  check("SPIRE_LANDBLOCKS covers all 7 Spire landblocks", SPIRE_LANDBLOCKS.length === 7);

  // Test Spire detection from staticsGroup (InstancedMesh + singleton Mesh), portal_registry, and Spire LB!
  _resetStaticPortalsForTest();
  _resetTerrainVfx();
  _resetSpiresVfx();

  const worldRoot = new THREE.Group();
  const terrainGroup = new THREE.Group();
  const staticsGroup = new THREE.Group();
  worldRoot.add(terrainGroup);
  worldRoot.add(staticsGroup);

  // Place a Shadow Spire setup (0x020007E8) in staticsGroup at Obsidian Spires LB 0x472C.
  const spireX = 0x47 * 192 + 96;
  const spireY = 0x2c * 192 + 96;
  const spireMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  spireMesh.position.set(spireX, spireY, 42.0);
  spireMesh.userData = { modelId: 0x020007e8 };
  staticsGroup.add(spireMesh);

  // Also register a Shadow Rift portal anchor (0x020015B9) 80 m away.
  const riftAnchor = new THREE.Object3D();
  riftAnchor.position.set(spireX + 80, spireY - 40, 44.0);
  staticsGroup.add(riftAnchor);
  registerStaticPortalAnchor(riftAnchor, 0x020015b9);

  const detected = detectResidentSpireSites({ scene3d: { staticsGroup, terrainGroup } });
  check("detectResidentSpireSites detects both Shadow Spire setup and Shadow Rift anchor", detected.length === 2);

  // Verify GLSL shaders have zero screen distortion, zero backticks, and log-depth support.
  for (const [name, vs, fs] of [
    ["miasma", SPIRE_MIASMA_VERTEX_GLSL, SPIRE_MIASMA_FRAGMENT_GLSL],
    ["wisp", SPIRE_WISP_VERTEX_GLSL, SPIRE_WISP_FRAGMENT_GLSL],
  ]) {
    check(`${name} Spire GLSL has no backticks and no uSceneDepth/screen UV warp`, !vs.includes("`") && !fs.includes("`") && !fs.includes("tDiffuse"));
    const patched = withLogDepth({ vertexShader: vs, fragmentShader: fs });
    check(`${name} Spire GLSL patches cleanly with withLogDepth`, hasLogDepth(patched.vertexShader) && hasLogDepth(patched.fragmentShader));
  }

  // Test full GPU InstancedMesh lifecycle via initSpiresVfx + terrain_vfx spine + Spire LB 0xF55A residency!
  setSearch("");
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.25, 10000);
  cam.position.set(spireX + 25, 65, -spireY);
  const scene3d = {
    terrainGroup,
    staticsGroup,
    camera: cam,
    quality: getQuality("?quality=high"),
    frameTime: { tsSec: 8.0, dt: 0.016 },
  };
  initTerrainVfx({ THREE, scene3d });
  const spHandle = initSpiresVfx({ THREE, scene3d });
  terrainVfxTick(0.016, scene3d, 8.0);

  const spStats = spiresVfxStats();
  check(
    "initSpiresVfx populates GPU InstancedMeshes for creeping miasma & rising void wisps (0 lights, 0 distort)",
    spStats.activeSiteCount === 2 &&
      spStats.miasmaInstances === 2 * 42 &&
      spStats.wispInstances === 2 * 56 &&
      spStats.screenDistortCount === 0 &&
      spStats.lightCount === 0 &&
      spHandle.rootGroup.parent === worldRoot &&
      spHandle.rootGroup.children.length === 2 &&
      spHandle.rootGroup.children[0].isInstancedMesh === true &&
      spHandle.rootGroup.children[1].isInstancedMesh === true,
  );

  // Verify deterministic instance builder.
  const m1 = buildSpireMiasmaInstances(detected);
  const m2 = buildSpireMiasmaInstances(detected);
  let mDiff = 0;
  for (let i = 0; i < m1.matrices.length; i += 1) mDiff = Math.max(mDiff, Math.abs(m1.matrices[i] - m2.matrices[i]));
  check("buildSpireMiasmaInstances is 100% deterministic", mDiff === 0);

  const w1 = buildSpireWispInstances(detected);
  const w2 = buildSpireWispInstances(detected);
  let wDiff = 0;
  for (let i = 0; i < w1.matrices.length; i += 1) wDiff = Math.max(wDiff, Math.abs(w1.matrices[i] - w2.matrices[i]));
  check("buildSpireWispInstances is 100% deterministic", wDiff === 0);

  _resetSpiresVfx();
  _resetTerrainVfx();
  _resetStaticPortalsForTest();
  delete globalThis.window;
  _resetVfxFlags();
}

console.log(`\nwaterfalls & spires suite: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
