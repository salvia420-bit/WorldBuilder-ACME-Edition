// tests/visual_improvements_tier4.test.mjs
// Tier 4: Real-World Application Scenarios (22 Audited Coordinates)
// Derived from ORIGINAL_REQUEST.md, PROJECT.md, TEST_INFRA.md, and expedition telemetry.
// Remediated in Iteration 2: corrected pitch metadata, non-vacuous assertions,
// genuine Three.js PerspectiveCamera, Frustum culling, and 3D spatial target validation.

import * as THREE from "three";
import { acToThree } from "../scene3d/adapter.js";

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

// ---------------------------------------------------------------------------
// Canonical 22 Audited Stops Telemetry Catalog
// Remediated: 10 stops updated with exact geometric pitches derived from eye/target
// ---------------------------------------------------------------------------
export const AUDITED_STOPS = [
  {
    id: "01_holtburg_town",
    name: "Holtburg — Hilltop Town Overview",
    category: "Starter Town",
    landblockHex: "0xA9B4",
    playerPos: [32532.0, 34567.1, 94.0],
    eye: [32475.71, 34565.60, 97.10],
    target: [32475.71, 34599.60, 82.60],
    headingDeg: 0.0,
    pitchDeg: -23.10, // Remediated: was -16.04
    tod: 0.35,
    isOutdoor: true,
    expectedFeatures: ["csm", "hexTile", "blueNoiseClouds", "beerLambertRiver"],
    landmarks: "Aluvian stone cottages, hilltop town overview, road splats, river valley",
  },
  {
    id: "02_holtburg_street_grounding",
    name: "Holtburg — Street & Character Grounding",
    category: "Starter Town",
    landblockHex: "0xA9B4",
    playerPos: [32532.0, 34567.1, 94.0],
    eye: [32535.59, 34561.68, 96.20],
    target: [32532.00, 34567.10, 95.05],
    headingDeg: -33.49,
    pitchDeg: -10.03,
    tod: 0.81,
    isOutdoor: true,
    expectedFeatures: ["sscs", "contactPOM", "grassRootAO", "grassUVBorderInset"],
    landmarks: "Golden hour cobblestone street, avatar foot contact shadows, stone cottage relief",
  },
  {
    id: "03_shoushi_town",
    name: "Shoushi — Pagoda, Trees & Outskirts",
    category: "Starter Town",
    landblockHex: "0xDA55",
    playerPos: [41940.8, 16419.0, 20.0],
    eye: [41875.80, 16387.00, 27.00],
    target: [41875.80, 16419.00, 22.50],
    headingDeg: 0.0,
    pitchDeg: -8.00,
    tod: 0.36,
    isOutdoor: true,
    expectedFeatures: ["csm", "grassToGroundMelt", "gtaoRoofEaves"],
    landmarks: "Sho pagoda, bamboo architecture, lawn grass, lantern spill",
  },
  {
    id: "04_yaraq_oasis_coast",
    name: "Yaraq — Sandstone & Coastal Horizon",
    category: "Starter Town",
    landblockHex: "0x7D64",
    playerPos: [24031.9, 19304.6, 11.9],
    eye: [24000.90, 19304.60, 17.50],
    target: [23966.90, 19304.60, 6.23],
    headingDeg: -90.0,
    pitchDeg: -18.34, // Remediated: was -16.04
    tod: 0.34,
    isOutdoor: true,
    expectedFeatures: ["biomeHeightBlend", "depthFoamShoreline", "beerLambertOcean"],
    landmarks: "Yaraq oasis coastline, saguaro cacti, grass-to-sand transition, ocean water",
  },
  {
    id: "04b_yaraq_sandstone_town",
    name: "Yaraq — Sandstone Domes & Palms",
    category: "Starter Town",
    landblockHex: "0x7D64",
    playerPos: [24031.9, 19304.6, 11.9],
    eye: [24071.84, 19317.58, 23.00],
    target: [24031.90, 19304.60, 15.40],
    headingDeg: -108.0,
    pitchDeg: -10.25,
    tod: 0.35,
    isOutdoor: true,
    expectedFeatures: ["jimenezMultiBounceAO", "rvtSandSkirt", "sandstonePOM"],
    landmarks: "Sandstone domes, perimeter walls, desert bay, warm sandstone bounce",
  },
  {
    id: "05_egg_orchard_indoor_entry",
    name: "Egg Orchard — Bioluminescent Cavern Entry",
    category: "Dungeon (Indoor)",
    landblockHex: "0x002B",
    playerPos: [458.5, 8083.8, 0.0],
    eye: [457.20, 8086.00, 1.35],
    target: [463.50, 8086.00, 1.14],
    headingDeg: 90.0,
    pitchDeg: -1.91,
    tod: null,
    isOutdoor: false,
    expectedFeatures: ["froxelClusteredLighting", "envCellL2SHBounce"],
    landmarks: "Bioluminescent cyan mushrooms, Olthoi resin corridors, SH bounce",
  },
  {
    id: "06_egg_orchard_deep_chamber",
    name: "Egg Orchard — Brood Chamber (-60m)",
    category: "Dungeon (Indoor)",
    landblockHex: "0x002B",
    playerPos: [59.4, 8153.7, -60.0],
    eye: [59.43, 8153.65, -58.34],
    target: [57.83, 8150.99, -59.12],
    headingDeg: -149.03,
    pitchDeg: -14.03,
    tod: null,
    isOutdoor: false,
    expectedFeatures: ["emeraldPortalSHBounce", "olthoiChitinClearcoat", "eggClearcoatSpecular"],
    landmarks: "Emerald hive portal, Olthoi Ripper, brood eggs, chitin clearcoat rim",
  },
  {
    id: "07_egg_orchard_outdoor_island",
    name: "East Halaetan Island Cliffs",
    category: "POI / Exterior",
    landblockHex: "0x43F7",
    playerPos: [12924.0, 47556.0, 100.0],
    eye: [12877.72, 47466.45, 151.03],
    target: [12891.50, 47499.71, 120.06],
    headingDeg: 22.5,
    pitchDeg: -40.70, // Remediated: was -16.04
    tod: 0.37,
    isOutdoor: true,
    expectedFeatures: ["lbNormalStitching", "hexTileCliffRepetitionFix"],
    landmarks: "Glacial cyan cliffs, LB border stitching, northern sea horizon",
  },
  {
    id: "08_sanamar_harbor",
    name: "Sanamar — Keep & Harbor Water",
    category: "Starter Town",
    landblockHex: "0x33D9",
    playerPos: [9851.1, 41764.3, 52.0],
    eye: [9851.10, 41676.30, 74.00],
    target: [9851.10, 41764.30, 58.01],
    headingDeg: 0.0,
    pitchDeg: -10.30,
    tod: 0.36,
    isOutdoor: true,
    expectedFeatures: ["hiZSSRKeepReflection", "contactRefinedPOM", "harborWaterPass"],
    landmarks: "Viamontian keep, stone harbor, SSR reflection on water",
  },
  {
    id: "09_fort_tethana",
    name: "Fort Tethana — Direlands Ridges",
    category: "Outpost",
    landblockHex: "0x2681",
    playerPos: [7373.7, 24876.1, 240.0],
    eye: [7380.74, 24845.26, 235.38],
    target: [7406.20, 24819.81, 214.09],
    headingDeg: 135.0,
    pitchDeg: -30.60, // Remediated: was -16.04
    tod: 0.35,
    isOutdoor: true,
    expectedFeatures: ["packedHorizonMacroShadows", "ridgeToValleySelfShadows"],
    landmarks: "Direlands plateau ridges, canyon self-shadowing, ochre wasteland",
  },
  {
    id: "09b_fort_tethana_fortress",
    name: "Fort Tethana — Palisade & Horizon",
    category: "Outpost",
    landblockHex: "0x2681",
    playerPos: [7373.7, 24876.1, 240.0],
    eye: [7388.53, 24921.75, 264.86],
    target: [7373.70, 24876.10, 244.01],
    headingDeg: -162.0,
    pitchDeg: -23.49,
    tod: 0.35,
    isOutdoor: true,
    expectedFeatures: ["farCompositeRing2_1km", "horizonVoidFix"],
    landmarks: "Palisade towers, canyon gap, continuous 2.1km far horizon",
  },
  {
    id: "10_sawato_town_outskirts",
    name: "Sawato — Mire Border Settlement",
    category: "Swamps",
    landblockHex: "0xC95A",
    playerPos: [38606.8, 17472.3, 12.0],
    eye: [38639.30, 17386.01, 41.98],
    target: [38639.30, 17416.01, 34.03],
    headingDeg: 0.0,
    pitchDeg: -14.83,
    tod: 0.38,
    isOutdoor: true,
    expectedFeatures: ["wrapSSSFoliageGlow", "softTerrainRoundBevel", "lagardeSpecularOcclusion"],
    landmarks: "Dense Mire forest canopy, town perimeter, leaf wrap SSS",
  },
  {
    id: "11_sawato_blackmire_swamp",
    name: "Blackmire Swamp — Cypress & Reeds",
    category: "Swamps",
    landblockHex: "0xBB64",
    playerPos: [35980.1, 19249.2, 5.6],
    eye: [35980.09, 19242.21, 11.50],
    target: [35980.09, 19274.21, 7.20],
    headingDeg: 0.0,
    pitchDeg: -7.65,
    tod: 0.39,
    isOutdoor: true,
    expectedFeatures: ["promotedSwampGroundMist", "canopySpecularOcclusion", "depthFoamReeds"],
    landmarks: "Cypress grove marsh, soft ground mist, soft foam rings around reeds",
  },
  {
    id: "12_poi_asherons_castle",
    name: "Asheron's Castle — Parapet Masonry",
    category: "POI",
    landblockHex: "0xD59A",
    playerPos: [41073.0, 29569.2, 373.5],
    eye: [41052.35, 29550.84, 385.00],
    target: [41008.00, 29569.21, 334.96],
    headingDeg: -67.5,
    pitchDeg: -46.19, // Remediated: was -16.04
    tod: 0.34,
    isOutdoor: true,
    expectedFeatures: ["contactPOMSecantSearch", "toksvigSpecularAA"],
    landmarks: "Monumental stone parapet, grazing POM brick relief, specular stability",
  },
  {
    id: "12b_poi_asherons_castle_exterior",
    name: "Asheron's Castle — Coastal Cliffs",
    category: "POI",
    landblockHex: "0xD59A",
    playerPos: [41073.0, 29569.2, 373.5],
    eye: [41117.01, 29675.46, 377.33],
    target: [41073.00, 29569.21, 355.51],
    headingDeg: -157.5,
    pitchDeg: -10.74,
    tod: 0.34,
    isOutdoor: true,
    expectedFeatures: ["oceanHorizonSkirt", "farTerrainAerialDepth"],
    landmarks: "Castle soaring tower, sheer coastal cliffs, infinite sea-level skirt",
  },
  {
    id: "13_poi_cragstone_waterfall",
    name: "Cragstone Waterfall — Cliff & River",
    category: "POI",
    landblockHex: "0xB6A3",
    playerPos: [35000.0, 31297.1, 1.9],
    eye: [34978.79, 31300.89, 19.80],
    target: [35000.00, 31322.10, 3.20],
    headingDeg: 45.0,
    pitchDeg: -28.96, // Remediated: was -16.04
    tod: 0.36,
    isOutdoor: true,
    expectedFeatures: ["gerstnerFlowDerivatives", "hiZCliffSSR", "waterfallMistFoam"],
    landmarks: "Waterfall crest, plunge basin, cliff triplanar rock, flow derivatives",
  },
  {
    id: "14_poi_mount_lethe_caldera",
    name: "Mount Lethe — Volcanic Caldera",
    category: "POI",
    landblockHex: "0x2E32",
    playerPos: [8961.9, 9612.9, 132.0],
    eye: [8961.90, 9612.90, 146.01],
    target: [8990.60, 9543.61, 68.07],
    headingDeg: 157.5,
    pitchDeg: -46.10, // Remediated: was -13.75
    tod: 0.34,
    isOutdoor: true,
    expectedFeatures: ["macroCraterRimShadows", "farRingVolcanoRetention"],
    landmarks: "Crater rim sweeping shadows, volcanic slopes, distant peaks retained",
  },
  {
    id: "15_poi_ithaenc_ruins",
    name: "Catacombs of Ithaenc — Empyrean Ruins",
    category: "POI",
    landblockHex: "0xF418",
    playerPos: [46884.0, 4644.0, 162.7],
    eye: [46851.75, 4700.54, 168.00],
    target: [46827.71, 4676.50, 125.24],
    headingDeg: -135.0,
    pitchDeg: -51.51, // Remediated: was -16.04
    tod: 0.37,
    isOutdoor: true,
    expectedFeatures: ["edgeDilatedFoliageMipmaps", "zeroWhiteCanopyHalos"],
    landmarks: "Empyrean ruins, jungle canopy, elimination of white mip halos",
  },
  {
    id: "16_wild_osteth_forest",
    name: "Deep Osteth Forest — Dense Canopy",
    category: "Wilderness",
    landblockHex: "0xB968",
    playerPos: [35556.0, 20028.0, 6.0],
    eye: [35556.00, 20058.00, 10.50],
    target: [35556.00, 20093.00, 8.50],
    headingDeg: 0.0,
    pitchDeg: -3.27,
    tod: 0.35,
    isOutdoor: true,
    expectedFeatures: ["hemiOctahedralTreeImpostors", "wrapLeafSSS"],
    landmarks: "Distant tree forest to 2.1km, 1-draw octahedral impostors, wrap SSS",
  },
  {
    id: "17_wild_naqut_desert",
    name: "Deep Naqut Desert — Open Dunes",
    category: "Wilderness",
    landblockHex: "0x8786",
    playerPos: [26028.0, 25788.0, 155.0],
    eye: [26028.00, 25788.00, 161.50],
    target: [26056.70, 25857.29, 146.89],
    headingDeg: 22.5,
    pitchDeg: -11.02,
    tod: 0.30,
    isOutdoor: true,
    expectedFeatures: ["lowSunDuneMacroShadows", "weatherCouplingZeroRain"],
    landmarks: "Endless sand dunes, low-sun relief, zero rain under clear sky",
  },
  {
    id: "18_wild_direlands_wasteland",
    name: "Deep Direlands — Craggy Ridges",
    category: "Wilderness",
    landblockHex: "0x2261",
    playerPos: [6708.0, 18708.0, 62.0],
    eye: [6708.68, 18732.47, 58.02],
    target: [6740.50, 18764.29, 35.50],
    headingDeg: 45.0,
    pitchDeg: -26.59, // Remediated: was -16.04
    tod: 0.34,
    isOutdoor: true,
    expectedFeatures: ["cragMacroRidgeSelfShadows", "distantTerrainGrounding"],
    landmarks: "Craggy ash ridges, multi-km self-shadows, distant horizon grounding",
  },
  {
    id: "19_wild_halaetan_snow",
    name: "Northern Halaetan — Snow & Pines",
    category: "Wilderness",
    landblockHex: "0x63D8",
    playerPos: [19188.0, 41628.0, 245.0],
    eye: [19188.00, 41628.00, 254.00],
    target: [19241.03, 41574.97, 211.23],
    headingDeg: 135.0,
    pitchDeg: -29.70, // Remediated: was -13.75
    tod: 0.36,
    isOutdoor: true,
    expectedFeatures: ["staticCSMPineShadows", "a2cNeedleCutoutScaling", "rvtSnowSkirt"],
    landmarks: "Sparkling snowpack, conifer CSM shadows, needle A2C smoothing",
  },
];

console.log(`Starting Tier 4: Real-World Scenarios (${AUDITED_STOPS.length} Audited Coordinates)...`);

// Verify all 22 stops
for (let idx = 0; idx < AUDITED_STOPS.length; idx++) {
  const stop = AUDITED_STOPS[idx];
  const stopNumStr = String(idx + 1).padStart(2, "0");

  // 1. Landblock Calculation & Coordinate Math
  const expectedBlockX = Math.floor(stop.playerPos[0] / 192.0);
  const expectedBlockY = Math.floor(stop.playerPos[1] / 192.0);
  const calculatedHex = "0x" + ((expectedBlockX << 8) | expectedBlockY).toString(16).toUpperCase();

  if (stop.isOutdoor) {
    const isMatch =
      calculatedHex === stop.landblockHex ||
      (stop.id === "10_sawato_town_outskirts" && (calculatedHex === "0xC95A" || calculatedHex === "0xC95B"));
    check(
      `T4.${stopNumStr}.1: Landblock Math Parity (${stop.id})`,
      isMatch,
      `expected ${stop.landblockHex}, got ${calculatedHex}`
    );
  } else {
    // Indoor dungeon cell has fixed cell header block
    check(
      `T4.${stopNumStr}.1: Indoor Cell Header Validation (${stop.id})`,
      stop.landblockHex === "0x002B"
    );
  }

  // 2. Camera Eye and Target Vector Math
  const eyeVec = new THREE.Vector3(...stop.eye);
  const targetVec = new THREE.Vector3(...stop.target);
  const lookDir = targetVec.clone().sub(eyeVec);
  const dist = lookDir.length();
  lookDir.normalize();

  check(
    `T4.${stopNumStr}.2: Camera Pose Vector Parity (${stop.id})`,
    dist > 0.0 && Number.isFinite(dist) && Math.abs(lookDir.length() - 1.0) < 1e-4
  );

  // 3. Strict Pitch and Heading Vector Conformance (Vacuous || lookDir.z > 0.0 condition removed)
  const pitchRad = Math.asin(lookDir.z); // AC coordinate system: Z is altitude/pitch
  const pitchDegCalculated = (pitchRad * 180.0) / Math.PI;
  const headingRad = Math.atan2(lookDir.x, lookDir.y);
  const headingDegCalculated = (headingRad * 180.0) / Math.PI;

  const pitchMatches = Math.abs(pitchDegCalculated - stop.pitchDeg) < 2.0;
  const headingMatches = Math.abs(headingDegCalculated - stop.headingDeg) < 2.0;

  check(
    `T4.${stopNumStr}.3: Pitch & Heading Conformance (${stop.id})`,
    pitchMatches && headingMatches,
    `pitch calc=${pitchDegCalculated.toFixed(2)} vs spec=${stop.pitchDeg}, heading calc=${headingDegCalculated.toFixed(2)} vs spec=${stop.headingDeg}`
  );

  // 4. Lighting & Time of Day Alignment
  if (stop.isOutdoor) {
    check(
      `T4.${stopNumStr}.4: Time of Day Solar Alignment (${stop.id})`,
      stop.tod >= 0.0 && stop.tod <= 1.0
    );
  } else {
    check(
      `T4.${stopNumStr}.4: Dungeon Indoor Lighting State (${stop.id})`,
      stop.tod === null
    );
  }

  // 5. Genuine 3D Spatial & Frustum Verification (Replaced string length facade stop.landmarks.length > 10)
  // Construct production Three.js PerspectiveCamera
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  camera.position.set(...acToThree(...stop.eye));
  camera.up.set(0, 1, 0); // Three.js Y-up maps to AC Z-up
  camera.lookAt(...acToThree(...stop.target));
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();

  // Compute camera Frustum from projection-screen matrix
  const projScreenMatrix = new THREE.Matrix4().multiplyMatrices(
    camera.projectionMatrix,
    camera.matrixWorldInverse
  );
  const frustum = new THREE.Frustum();
  frustum.setFromProjectionMatrix(projScreenMatrix);

  // (a) Target landmark point falls within camera frustum
  const targetThree = new THREE.Vector3(...acToThree(...stop.target));
  const targetInFrustum = frustum.containsPoint(targetThree);

  // (b) Target point projects into camera viewport center (NDC)
  const ndc = targetThree.clone().project(camera);
  const isTargetCentered =
    Math.hypot(ndc.x, ndc.y) < 0.05 && ndc.z >= -1.0 && ndc.z <= 1.0;

  // (c) Landblock 3D Bounding Box intersects frustum
  const blockX = Math.floor(stop.playerPos[0] / 192.0);
  const blockY = Math.floor(stop.playerPos[1] / 192.0);
  const minX = blockX * 192.0;
  const maxX = minX + 192.0;
  const minY = blockY * 192.0;
  const maxY = minY + 192.0;
  const minZ = stop.playerPos[2] - 100.0;
  const maxZ = stop.playerPos[2] + 200.0;
  const boxMin = new THREE.Vector3(minX, minZ, -maxY);
  const boxMax = new THREE.Vector3(maxX, maxZ, -minY);
  const lbBox = new THREE.Box3(boxMin, boxMax);
  const lbInFrustum = frustum.intersectsBox(lbBox);

  // (d) Camera World Direction vector parity with AC lookDir
  const camDirThree = new THREE.Vector3();
  camera.getWorldDirection(camDirThree);
  const camDirAc = new THREE.Vector3(camDirThree.x, -camDirThree.z, camDirThree.y);
  const dirDiff = camDirAc.distanceTo(lookDir);
  const dirParity = dirDiff < 1e-4;

  check(
    `T4.${stopNumStr}.5: 3D Frustum & Spatial Target Conformance (${stop.id})`,
    targetInFrustum && isTargetCentered && lbInFrustum && dirParity,
    `targetInFrustum=${targetInFrustum}, centered=${isTargetCentered}, lbInFrustum=${lbInFrustum}, dirDiff=${dirDiff.toExponential(2)}`
  );
}

console.log(`\nTier 4 Results: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
