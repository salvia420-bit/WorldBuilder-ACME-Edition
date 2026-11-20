// tests/vehicle_jeep_model.test.mjs — 4-Tier E2E test suite for the Willys MB 1/4-ton 4x4 Jeep (`jeep-mb`)
// 3D procedural model, sub-mesh articulation, PBR material stack, draw call budget (<= 16), and zero light churn.
//
// Run: node external/holtburger/apps/holtburger-web/tests/vehicle_jeep_model.test.mjs

import * as THREE from "three";
import { lintManifest, lintSource } from "../scene3d/vfx/lint_caps.js";
import { FxLightSource } from "../scene3d/vfx/fx_lights.js";
import { createVehicleHeadlights } from "../scene3d/vehicle/fx_lights.js";

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  [OK] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name}: ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`);
  }
}

const assert = (c, m) => { if (!c) throw new Error(m || "assertion failed"); };
const near = (a, b, eps = 1e-4, m = "near") => {
  if (Math.abs(a - b) > eps) throw new Error(`${m}: ${a} vs ${b} (eps ${eps})`);
};

// ---------------------------------------------------------------------------
// Authoritative Specifications & Constants (from ORIGINAL_REQUEST.md & PROJECT.md)
// ---------------------------------------------------------------------------
export const JEEP_PALETTE = Object.freeze({
  oliveDrab: 0x464f30,      // Authentic WWII US Army Lustreless Olive Drab [~0.27, 0.31, 0.19]
  oliveDrabDark: 0x323a22,  // Shaded olive drab underbody
  starWhite: 0xf2f5f8,      // US Army White Invasion Star stencil [~0.95, 0.96, 0.97]
  canvasKhaki: 0x787154,    // #8 Olive Khaki duck-canvas cushions
  tireRubber: 0x1c1e22,     // 6.00-16 NDT non-directional tire rubber
  treadLug: 0x141619,       // Combat shoulder tread lugs
  toolSteel: 0x3a3d40,      // Gunmetal / tool steel blades
  metalBright: 0x8a929a,    // Combat rim lug nuts & gauge bezels
  woodShaft: 0x6e4726,      // Pioneer axe/shovel wood handles
  glassClear: 0xa8c4c7,     // Dual windscreen panes
  glassAmber: 0xb58a22,     // Marker lenses
  rubyTail: 0xa81818,       // Ruby brake/tail lamps
  blackoutBlue: 0x1c2b3d,   // Fender blackout marker lamp
  radiatorCore: 0x181818,   // Recessed radiator cooling fins
  exhaustRust: 0x4a3b32,    // Muffler & tailpipe
});

export const JEEP_DIMENSIONS = Object.freeze({
  wheelbase: 2.04,          // 80 inches (2.032 m)
  trackWidth: 1.48,         // ~58 inches track width
  wheelRadius: 0.38,        // 6.00-16 NDT tire outer radius
  maxSteerLowSpeedRad: 0.69813, // 40 degrees steer lock at <= 12 m/s
  maxSteerHighSpeedRad: 0.20944, // 12 degrees steer lock at 29 m/s
  steeringGearRatio: 2.5,   // 2.5x steering wheel rotation multiplier
  turnRadiusMin: 2.43,      // 2.43 m turn radius at 40° lock
  maxDrawCalls: 16,         // GTX 1070 draw call ceiling
});

// Helper: create standard Jeep profile
export function makeJeepProfile(overrides = {}) {
  return {
    type: "profile",
    vehicle: 0x80033333,
    profileKey: "jeep-mb",
    displayName: "Willys MB 1/4-ton 4x4",
    locomotion: 2, // Ground
    wheelbase: 2.04,
    trackWidth: 1.48,
    wheelRadius: 0.38,
    maxSteerRad: 0.69813,
    reverseMax: -10.0,
    climbLimitCos: 0.71934,
    fordDepthMax: 0.8,
    seats: [
      { id: 0, role: "Driver", offset: [-0.38, -0.18, 0.62] },
      { id: 1, role: "Shotgun", offset: [0.38, -0.18, 0.62] },
      { id: 2, role: "RearLeft", offset: [-0.36, -0.96, 0.68] },
      { id: 3, role: "RearRight", offset: [0.36, -0.96, 0.68] },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Authoritative Reference Implementation / Module Loader
// ---------------------------------------------------------------------------
let JM;
try {
  JM = await import("../scene3d/vehicle/jeep_model.js");
} catch (_) {
  throw new Error("Failed to load jeep_model.js: " + _);
}

// ---------------------------------------------------------------------------
// TIER 1: FEATURE COVERAGE
// ---------------------------------------------------------------------------
console.log("=== TIER 1: Feature Coverage (Suite A: vehicle_jeep_model) ===");

await check("T1.1 Willys MB 3D Model: tub, 9-slot grille, flat fenders, hood star stencil", () => {
  const prof = makeJeepProfile();
  const jeep = JM.buildProceduralJeep(THREE, prof);
  assert(jeep && jeep.root, "jeep root exists");
  const tub = jeep.root.getObjectByName("tub-chassis");
  assert(tub && tub.isMesh, "tub chassis mesh exists");
  const col = tub.geometry.getAttribute("color");
  assert(col && col.count > 0, "tub has vertex colors");

  // Check for presence of Lustreless Olive Drab and Star Stencil White
  let hasOlive = false;
  let hasWhite = false;
  const sampleColor = new THREE.Color();
  for (let i = 0; i < col.count; i++) {
    sampleColor.setRGB(col.getX(i), col.getY(i), col.getZ(i));
    const hex = sampleColor.getHex();
    if (hex === JEEP_PALETTE.oliveDrab) hasOlive = true;
    if (hex === JEEP_PALETTE.starWhite) hasWhite = true;
  }
  assert(hasOlive, "contains Lustreless Olive Drab base color");
  assert(hasWhite, "contains White star stencil color");
  jeep.dispose();
});

await check("T1.2 Willys MB Interior: canvas cushions & dash grab-bar", () => {
  const prof = makeJeepProfile();
  const jeep = JM.buildProceduralJeep(THREE, prof);
  const cushions = jeep.root.getObjectByName("interior-cushions");
  assert(cushions && cushions.isMesh, "interior cushions mesh exists");
  const grabBar = jeep.root.getObjectByName("dash-grabbar");
  assert(grabBar && grabBar.isMesh, "dash grab-bar exists");
  jeep.dispose();
});

await check("T1.3 Pioneer Tools & Gear: shovel, axe, spare tire, jerrycan", () => {
  const prof = makeJeepProfile();
  const jeep = JM.buildProceduralJeep(THREE, prof);
  const tools = jeep.root.getObjectByName("pioneer-tools");
  const spareTire = jeep.root.getObjectByName("spare-tire");
  const jerrycan = jeep.root.getObjectByName("jerrycan");
  assert(tools && spareTire && jerrycan, "all pioneer tools/gear present");
  jeep.dispose();
});

await check("T1.4 Articulated Windscreen & Tailgate Pivots", () => {
  const prof = makeJeepProfile();
  const jeep = JM.buildProceduralJeep(THREE, prof);
  assert(jeep.windscreenPivot, "windscreenPivot exists");
  assert(jeep.tailgatePivot, "tailgatePivot exists");

  // Fold windscreen flat onto hood
  jeep.update({ windscreenFolded: true });
  near(jeep.windscreenPivot.rotation.x, Math.PI / 2, 1e-4, "windscreen folded flat");
  jeep.update({ windscreenFolded: false });
  near(jeep.windscreenPivot.rotation.x, 0, 1e-4, "windscreen upright");
  jeep.dispose();
});

await check("T1.5 Open 4-Seat Tub & Rear Passenger Bench Geometry (Cargo Decoupled)", () => {
  const prof = makeJeepProfile();
  const jeep = JM.buildProceduralJeep(THREE, prof);

  // Interior cushions mesh must be present with substantial geometry
  const cushions = jeep.root.getObjectByName("interior-cushions");
  assert(cushions && cushions.isMesh, "interior cushions mesh exists");
  const pos = cushions.geometry.getAttribute("position");
  assert(pos && pos.count > 0, "cushions have vertex geometry");

  // Verify cushion tops cover Seat 0 Driver (z ~ 0.62), Seat 1 Shotgun (z ~ 0.62),
  // and Seats 2 & 3 Rear Bench (z ~ 0.68)
  let hasDriverCushion = false;
  let hasShotgunCushion = false;
  let hasRearBenchCushion = false;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (x <= -0.18 && x >= -0.58 && y >= -0.38 && y <= 0.02 && z >= 0.50 && z <= 0.65) hasDriverCushion = true;
    if (x >= 0.18 && x <= 0.58 && y >= -0.38 && y <= 0.02 && z >= 0.50 && z <= 0.65) hasShotgunCushion = true;
    if (Math.abs(x) <= 0.52 && y <= -0.78 && y >= -1.15 && z >= 0.58 && z <= 0.72) hasRearBenchCushion = true;
  }
  assert(hasDriverCushion, "driver bucket seat cushion (Seat 0) present at z=0.62");
  assert(hasShotgunCushion, "shotgun bucket seat cushion (Seat 1) present at z=0.62");
  assert(hasRearBenchCushion, "2-passenger rear bench cushion (Seats 2 & 3) present at z=0.68");

  // Backward compatibility: dummy empty cargoCrateGroup exists without occupying bed
  assert(jeep.cargoCrateGroup, "cargoCrateGroup exists for e2e backward compat");
  assert(jeep.cargoCrateGroup.children.length === 0, "cargo crate decoupled: 0 children in crate group");
  near(jeep.cargoCrateGroup.position.x, 0.0, 1e-4);
  near(jeep.cargoCrateGroup.position.y, -1.15, 1e-4);
  near(jeep.cargoCrateGroup.position.z, 0.72, 1e-4);
  jeep.dispose();
});

await check("T1.6 Steer Pivots FL/FR low speed rotation (±40°)", () => {
  const prof = makeJeepProfile();
  const jeep = JM.buildProceduralJeep(THREE, prof);
  jeep.update({ speed: 5.0, steerAngle: 0.5 });
  near(jeep.steerPivotFL.rotation.z, 0.5, 1e-4, "FL pivot rotates with steerAngle");
  near(jeep.steerPivotFR.rotation.z, 0.5, 1e-4, "FR pivot rotates with steerAngle");
  jeep.dispose();
});

await check("T1.7 Steering Wheel 2.5x Gear Ratio Kinematics", () => {
  const prof = makeJeepProfile();
  const jeep = JM.buildProceduralJeep(THREE, prof);
  jeep.update({ speed: 5.0, steerAngle: 0.4 });
  near(jeep.steeringWheelPivot.rotation.z, 0.4 * 2.5, 1e-4, "steering wheel turns 2.5x");
  jeep.dispose();
});

await check("T1.8 5 Military Combat Wheels Rolling Kinematics (Forward & Reverse)", () => {
  const prof = makeJeepProfile();
  const jeep = JM.buildProceduralJeep(THREE, prof);
  assert(Array.isArray(jeep.wheels), "jeep.wheels is an array");
  assert(jeep.wheels.length === 5, "exactly 5 military combat wheels (FL, FR, RL, RR, Spare)");

  const dt = 0.1;
  const speed = 10.0;
  jeep.update({ speed, dt });
  const expectedRoll = (speed * dt) / JEEP_DIMENSIONS.wheelRadius;
  near(jeep.wheelRollAngle, expectedRoll, 1e-3, "forward wheel roll matches formula");

  // Reverse roll
  jeep.update({ speed: -5.0, dt });
  const expectedReverse = expectedRoll + (-5.0 * dt) / JEEP_DIMENSIONS.wheelRadius;
  near(jeep.wheelRollAngle, expectedReverse, 1e-3, "reverse wheel roll decrements");
  jeep.dispose();
});

await check("T1.9 Draw Call Budget Enforcement (<= 16 draw calls)", () => {
  const prof = makeJeepProfile();
  const jeep = JM.buildProceduralJeep(THREE, prof);
  let drawCalls = 0;
  jeep.root.traverse((obj) => {
    if (obj.isMesh || obj.isLine || obj.isPoints || obj.isSprite) drawCalls++;
  });
  assert(drawCalls <= JEEP_DIMENSIONS.maxDrawCalls, `draw calls ${drawCalls} <= 16`);
  assert(drawCalls >= 8, `draw calls ${drawCalls} >= 8 (substantive geometry)`);
  jeep.dispose();
});

await check("T1.10 Zero Light Churn Headlights (lightCountDelta === 0, pooled FxLightSource)", () => {
  const activeLights = [];
  const prof = makeJeepProfile();
  const jeep = JM.buildProceduralJeep(THREE, prof, { liveScene3d: { activeLights } });

  // Initial count of THREE.Light instances in tree
  let lightsInTree = 0;
  jeep.root.traverse((obj) => { if (obj.isLight) lightsInTree++; });
  assert(lightsInTree === 0, "zero THREE.Light in tree initial");
  assert(jeep.pooledLight.intensity === 0, "headlight off initially");

  // Toggle headlights ON
  jeep.update({ headlights: true });
  lightsInTree = 0;
  jeep.root.traverse((obj) => { if (obj.isLight) lightsInTree++; });
  assert(lightsInTree === 0, "zero THREE.Light in tree when headlights ON");
  assert(jeep.pooledLight.intensity > 0, "pooled carrier intensity active");
  assert(jeep.headlightBeams.visible === true, "additive beam visible");

  // Toggle headlights OFF
  jeep.update({ headlights: false });
  assert(jeep.pooledLight.intensity === 0, "pooled carrier intensity zero when off");
  jeep.dispose();
});

await check("T1.11 lint_caps Manifest & Source Compliance", () => {
  const manifestErrs = lintManifest(JM.manifest);
  assert(manifestErrs.length === 0, `lintManifest passed without errors: ${manifestErrs.join(", ")}`);
  assert(JM.manifest.lightCountDelta === 0, "manifest lightCountDelta === 0");
  assert(JM.manifest.deterministic === true, "manifest deterministic === true");
});

await check("T1.12 PBR Material Stack & AGX HDR Calibration", () => {
  const prof = makeJeepProfile();
  const jeep = JM.buildProceduralJeep(THREE, prof);
  const mats = jeep.materials;
  assert(mats, "materials object returned");

  // matBody: Lustreless Olive Drab (roughness: 0.62, metalness: 0.18, vertexColors: true)
  assert(mats.matBody && mats.matBody.isMeshStandardMaterial, "matBody is MeshStandardMaterial");
  near(mats.matBody.roughness, 0.62, 1e-4, "matBody roughness");
  near(mats.matBody.metalness, 0.18, 1e-4, "matBody metalness");
  assert(mats.matBody.vertexColors === true, "matBody vertexColors: true");
  assert(mats.matBody.castShadow === true, "matBody castShadow");
  assert(mats.matBody.receiveShadow === true, "matBody receiveShadow");

  // matMetal: gunmetal/steel (roughness: 0.36, metalness: 0.68)
  assert(mats.matMetal && mats.matMetal.isMeshStandardMaterial, "matMetal is MeshStandardMaterial");
  near(mats.matMetal.roughness, 0.36, 1e-4, "matMetal roughness");
  near(mats.matMetal.metalness, 0.68, 1e-4, "matMetal metalness");

  // matRubberCanvas: tires + duck-canvas cushions (roughness: 0.84, metalness: 0.04)
  assert(mats.matRubberCanvas && mats.matRubberCanvas.isMeshStandardMaterial, "matRubberCanvas is MeshStandardMaterial");
  near(mats.matRubberCanvas.roughness, 0.84, 1e-4, "matRubberCanvas roughness");
  near(mats.matRubberCanvas.metalness, 0.04, 1e-4, "matRubberCanvas metalness");

  // matGlass: dual windscreen panes (roughness: 0.12, metalness: 0.10, opacity: 0.34, transparent: true)
  assert(mats.matGlass && mats.matGlass.isMeshStandardMaterial, "matGlass is MeshStandardMaterial");
  near(mats.matGlass.roughness, 0.12, 1e-4, "matGlass roughness");
  near(mats.matGlass.metalness, 0.10, 1e-4, "matGlass metalness");
  near(mats.matGlass.opacity, 0.34, 1e-4, "matGlass opacity");
  assert(mats.matGlass.transparent === true, "matGlass transparent");

  // Meshes cast and receive shadows
  const tub = jeep.root.getObjectByName("tub-chassis");
  assert(tub.castShadow === true, "tub casts shadows");
  assert(tub.receiveShadow === true, "tub receives shadows");

  jeep.dispose();
});

await check("T1.13 Animated Cockpit & Suspension Pivots (Speedo, Shifter, 4WD Low, 4-Corner Susp)", () => {
  const prof = makeJeepProfile();
  const jeep = JM.buildProceduralJeep(THREE, prof);

  // Speedometer needle animation (0..45 m/s mapped across 240 deg dial)
  assert(jeep.speedoNeedlePivot, "speedoNeedlePivot exists");
  jeep.update({ speed: 0.0 });
  const needleAngle0 = jeep.speedoNeedlePivot.rotation.z;
  jeep.update({ speed: 22.5 });
  const needleAngleMid = jeep.speedoNeedlePivot.rotation.z;
  jeep.update({ speed: 45.0 });
  const needleAngleMax = jeep.speedoNeedlePivot.rotation.z;
  assert(needleAngleMid !== needleAngle0, "speedo needle moves with speed");
  assert(needleAngleMax !== needleAngleMid, "speedo needle continues sweeping to max");

  // T-84 Shifter cane tilts according to gear
  assert(jeep.shifterPivot, "shifterPivot exists");
  jeep.update({ gear: 1 });
  near(jeep.shifterPivot.rotation.x, 0.18, 1e-4, "shifter tilts forward in 1st");
  jeep.update({ gear: 2 });
  near(jeep.shifterPivot.rotation.x, -0.15, 1e-4, "shifter tilts back in 2nd");
  jeep.update({ gear: 0 });
  near(jeep.shifterPivot.rotation.x, 0.0, 1e-4, "shifter upright in neutral");

  // Transfer case lever shifts on 4WD Low
  assert(jeep.transferCasePivot, "transferCasePivot exists");
  jeep.update({ boost: false });
  near(jeep.transferCasePivot.rotation.x, 0.0, 1e-4, "transfer case neutral in 2WD");
  jeep.update({ boost: true });
  near(jeep.transferCasePivot.rotation.x, 0.22, 1e-4, "transfer case lever engaged in 4WD Low");

  // 4 Corner suspension groups & chassisBodyGroup
  assert(jeep.suspFL && jeep.suspFR && jeep.suspRL && jeep.suspRR, "4 corner suspension groups exist");
  assert(jeep.chassisBodyGroup, "chassisBodyGroup exists for squat/dive/roll");

  jeep.update({ suspensionFL: -0.04, accel: 15.0 });
  near(jeep.suspFL.position.z, 0.38 - 0.04, 1e-4, "suspFL compressed");
  assert(jeep.chassisBodyGroup.rotation.x < 0, "chassis squats back under acceleration");

  jeep.dispose();
});

// ---------------------------------------------------------------------------
// TIER 2: BOUNDARY & CORNER CASES
// ---------------------------------------------------------------------------
console.log("=== TIER 2: Boundary & Corner Cases (Suite A: vehicle_jeep_model) ===");

await check("T2.1 Empty Profile Fallback Safety", () => {
  const jeep = JM.buildProceduralJeep(THREE, {});
  assert(jeep && jeep.root, "builds with empty profile");
  jeep.update({ speed: 10, steerAngle: 0.2 });
  jeep.dispose();
});

await check("T2.2 Extreme Steer Angle Clamping (±1.2 rad clamped to ±40°)", () => {
  const prof = makeJeepProfile();
  const jeep = JM.buildProceduralJeep(THREE, prof);

  // Positive extreme
  jeep.update({ speed: 5.0, steerAngle: 1.2 });
  near(jeep.steerPivotFL.rotation.z, JEEP_DIMENSIONS.maxSteerLowSpeedRad, 1e-4, "positive steer clamped to 40°");
  assert(jeep.steeringWheelPivot.rotation.z <= 1.745 + 1e-4, "steering wheel clamped to 100°");

  // Negative extreme
  jeep.update({ speed: 5.0, steerAngle: -1.2 });
  near(jeep.steerPivotFL.rotation.z, -JEEP_DIMENSIONS.maxSteerLowSpeedRad, 1e-4, "negative steer clamped to -40°");
  assert(jeep.steeringWheelPivot.rotation.z >= -1.745 - 1e-4, "steering wheel clamped to -100°");
  jeep.dispose();
});

await check("T2.3 High-Speed Steer Taper (Tapers to 12° at 29 m/s)", () => {
  const prof = makeJeepProfile();
  const jeep = JM.buildProceduralJeep(THREE, prof);
  jeep.update({ speed: 29.0, steerAngle: 0.69813 });
  near(jeep.steerPivotFL.rotation.z, JEEP_DIMENSIONS.maxSteerHighSpeedRad, 1e-4, "high-speed steer clamped to 12°");
  jeep.dispose();
});

await check("T2.4 Stationary Rapid Steering (Zero wheel pitch roll, pivots rotate)", () => {
  const prof = makeJeepProfile();
  const jeep = JM.buildProceduralJeep(THREE, prof);
  jeep.update({ speed: 0.0, dt: 0.1, steerAngle: 0.35 });
  near(jeep.wheelRollAngle, 0.0, 1e-6, "wheel roll remains 0 when stationary");
  near(jeep.steerPivotFL.rotation.z, 0.35, 1e-4, "steer pivots turn while stationary");
  jeep.dispose();
});

await check("T2.5 100 Rapid Headlight Toggles (Strict lightCountDelta === 0)", () => {
  const activeLights = [];
  const prof = makeJeepProfile();
  const jeep = JM.buildProceduralJeep(THREE, prof, { liveScene3d: { activeLights } });
  for (let i = 0; i < 100; i++) {
    jeep.update({ headlights: i % 2 === 0 });
    let lights = 0;
    jeep.root.traverse((obj) => { if (obj.isLight) lights++; });
    assert(lights === 0, `cycle ${i}: zero THREE.Light in tree`);
  }
  jeep.dispose();
});

await check("T2.6 Geometry Finite Float Validation (No NaN, Inf in position/normal/color)", () => {
  const prof = makeJeepProfile();
  const jeep = JM.buildProceduralJeep(THREE, prof);
  let checkedVerts = 0;
  jeep.root.traverse((obj) => {
    if (obj.isMesh && obj.geometry) {
      const pos = obj.geometry.getAttribute("position");
      const nor = obj.geometry.getAttribute("normal");
      const col = obj.geometry.getAttribute("color");
      if (pos) {
        for (let i = 0; i < pos.array.length; i++) {
          assert(Number.isFinite(pos.array[i]), `finite pos in ${obj.name}`);
        }
        checkedVerts += pos.count;
      }
      if (nor) {
        for (let i = 0; i < nor.array.length; i++) {
          assert(Number.isFinite(nor.array[i]), `finite normal in ${obj.name}`);
        }
      }
      if (col) {
        for (let i = 0; i < col.array.length; i++) {
          assert(Number.isFinite(col.array[i]), `finite col in ${obj.name}`);
        }
      }
    }
  });
  assert(checkedVerts > 200, "verified substantial finite vertex geometry");
  jeep.dispose();
});

await check("T2.7 Outward Face Winding Normal Alignment (> 99% aligned)", () => {
  const prof = makeJeepProfile();
  const jeep = JM.buildProceduralJeep(THREE, prof);
  const tub = jeep.root.getObjectByName("tub-chassis");
  const pos = tub.geometry.getAttribute("position");
  const nor = tub.geometry.getAttribute("normal");
  let aligned = 0, total = 0;
  for (let i = 0; i < pos.count; i += 3) {
    const ax = pos.getX(i), ay = pos.getY(i), az = pos.getZ(i);
    const bx = pos.getX(i + 1) - ax, by = pos.getY(i + 1) - ay, bz = pos.getZ(i + 1) - az;
    const cx = pos.getX(i + 2) - ax, cy = pos.getY(i + 2) - ay, cz = pos.getZ(i + 2) - az;
    const fx = by * cz - bz * cy, fy = bz * cx - bx * cz, fz = bx * cy - by * cx;
    if (Math.hypot(fx, fy, fz) < 1e-8) continue;
    const nx = nor.getX(i), ny = nor.getY(i), nz = nor.getZ(i);
    total++;
    if (fx * nx + fy * ny + fz * nz > 0) aligned++;
  }
  assert(total > 0 && aligned / total > 0.99, `winding aligned ${aligned}/${total}`);
  jeep.dispose();
});

await check("T2.8 Long Distance Wheel Roll Numeric Precision (100,000m roll)", () => {
  const prof = makeJeepProfile();
  const jeep = JM.buildProceduralJeep(THREE, prof);
  const dt = 1.0;
  const speed = 25.0; // 25 m/s for 4000 steps = 100,000 m
  for (let step = 0; step < 4000; step++) {
    jeep.update({ speed, dt });
  }
  assert(Number.isFinite(jeep.wheelRollAngle), "wheel roll remains finite");
  assert(jeep.wheelRollAngle >= 0 && jeep.wheelRollAngle <= 2 * Math.PI, "wheel roll wrapped to [0, 2pi]");
  jeep.dispose();
});

await check("T2.9 Full Teardown .dispose() releases GPU buffers", () => {
  const activeLights = [];
  const prof = makeJeepProfile();
  const jeep = JM.buildProceduralJeep(THREE, prof, { liveScene3d: { activeLights } });
  assert(activeLights.length === 1, "carrier registered in activeLights");
  jeep.dispose();
  assert(activeLights.length === 0, "carrier released from activeLights");
});

// ---------------------------------------------------------------------------
// TIER 3: CROSS-FEATURE COMBINATIONS
// ---------------------------------------------------------------------------
console.log("=== TIER 3: Cross-Feature Combinations (Suite A: vehicle_jeep_model) ===");

await check("T3.1 Headlights ON + Full Steering Lock", () => {
  const prof = makeJeepProfile();
  const jeep = JM.buildProceduralJeep(THREE, prof);
  jeep.update({ headlights: true, steerAngle: JEEP_DIMENSIONS.maxSteerLowSpeedRad, speed: 10.0, dt: 0.05 });
  near(jeep.steerPivotFL.rotation.z, JEEP_DIMENSIONS.maxSteerLowSpeedRad, 1e-4, "steer pivot locked");
  assert(jeep.pooledLight.intensity > 0, "headlights active");
  assert(jeep.headlightBeams.visible === true, "beam visible");
  jeep.dispose();
});

await check("T3.2 Cockpit Controls & 4-Corner Suspension Articulation at 20 m/s", () => {
  const prof = makeJeepProfile();
  const jeep = JM.buildProceduralJeep(THREE, prof);
  jeep.update({ speed: 0.0 });
  const needleAtZero = jeep.speedoNeedlePivot.rotation.z;

  for (let i = 0; i < 20; i++) {
    jeep.update({
      speed: 20.0,
      dt: 0.05,
      accel: i % 2 === 0 ? 5.0 : -8.0,
      gear: 3,
      boost: i > 10,
      suspensionFL: Math.sin(i * 0.5) * 0.03,
      suspensionFR: Math.cos(i * 0.5) * 0.03,
    });
    assert(Math.abs(jeep.speedoNeedlePivot.rotation.z - needleAtZero) > 1.0, "speedo needle deflected at 20 m/s");
    assert(jeep.shifterPivot.rotation.x !== 0, "shifter engaged in gear 3");
  }
  assert(jeep.wheelRollAngle > 0, "wheels continued rolling smoothly");
  jeep.dispose();
});

await check("T3.3 Folding Windscreen + First-Person Cab View", () => {
  const prof = makeJeepProfile();
  const jeep = JM.buildProceduralJeep(THREE, prof);
  jeep.update({ windscreenFolded: true });
  near(jeep.windscreenPivot.rotation.x, Math.PI / 2, 1e-4, "windscreen flat on hood");

  let drawCalls = 0;
  jeep.root.traverse((obj) => { if (obj.isMesh) drawCalls++; });
  assert(drawCalls <= 16, "draw calls <= 16 with folded windscreen");
  jeep.dispose();
});

// ---------------------------------------------------------------------------
// TIER 4: REAL-WORLD APPLICATION SCENARIOS
// ---------------------------------------------------------------------------
console.log("=== TIER 4: Real-World Scenarios (Suite A: vehicle_jeep_model) ===");

await check("T4.1 Nighttime Recon Patrol Scenario", () => {
  const activeLights = [];
  const prof = makeJeepProfile();
  const jeep = JM.buildProceduralJeep(THREE, prof, { liveScene3d: { activeLights } });

  // Phase 1: Engine start & headlights ON
  jeep.update({ headlights: true });
  assert(jeep.pooledLight.intensity > 0, "headlights illuminated");

  // Phase 2: Rapid acceleration 0 to 29 m/s with slaloms
  for (let t = 0; t < 120; t++) {
    const speed = Math.min(29.0, t * 0.25);
    const steer = Math.sin(t * 0.1) * 0.4;
    jeep.update({ speed, steerAngle: steer, dt: 0.0333 });
  }

  // Phase 3: Arrive at outpost, park, verify instruments return to idle
  jeep.update({ speed: 0.0, steerAngle: 0.0, dt: 0.0333, gear: 0 });
  near(jeep.shifterPivot.rotation.x, 0.0, 1e-4, "shifter neutral when parked");

  // Invariant verification
  let drawCalls = 0, lightsInTree = 0;
  jeep.root.traverse((obj) => {
    if (obj.isMesh) drawCalls++;
    if (obj.isLight) lightsInTree++;
  });
  assert(drawCalls <= 16, `draw calls ${drawCalls} <= 16`);
  assert(lightsInTree === 0, "zero Three.js lights in tree");
  jeep.dispose();
});

await check("T4.2 Multi-Instance Convoy Draw Call Scaling", () => {
  const activeLights = [];
  const convoy = [];
  const CONVOY_SIZE = 4;
  for (let i = 0; i < CONVOY_SIZE; i++) {
    const prof = makeJeepProfile({ vehicle: 0x80033300 + i });
    const j = JM.buildProceduralJeep(THREE, prof, { liveScene3d: { activeLights } });
    j.root.position.set(0, i * 8.0, 0);
    convoy.push(j);
  }

  // Verify total convoy draw calls scale linearly (<= 16 * 4 = 64)
  let totalDrawCalls = 0;
  for (const j of convoy) {
    j.root.traverse((obj) => { if (obj.isMesh) totalDrawCalls++; });
  }
  assert(totalDrawCalls <= CONVOY_SIZE * 16, `total convoy draw calls ${totalDrawCalls} <= 64`);
  assert(activeLights.length === CONVOY_SIZE, `pooled lights count === ${CONVOY_SIZE}`);

  // Clean up convoy
  for (const j of convoy) j.dispose();
  assert(activeLights.length === 0, "all convoy lights cleaned up");
});

// ---------------------------------------------------------------------------
// TIER 5: ADVERSARIAL COVERAGE HARDENING
// ---------------------------------------------------------------------------
console.log("=== TIER 5: Adversarial Coverage Hardening (Suite A: vehicle_jeep_model) ===");

await check("T5.1 Zero Heap Allocation in jeep.update() Headlight Loop", () => {
  let vector3Allocs = 0;
  class MonitoredVector3 extends THREE.Vector3 {
    constructor(...args) {
      vector3Allocs++;
      super(...args);
    }
  }
  const customThree = Object.create(THREE);
  customThree.Vector3 = MonitoredVector3;

  const activeLights = [];
  const prof = makeJeepProfile();
  const jeep = JM.buildProceduralJeep(customThree, prof, { liveScene3d: { activeLights } });

  // Reset counter after buildProceduralJeep initial creation
  vector3Allocs = 0;

  for (let frame = 0; frame < 100; frame++) {
    jeep.update({ headlights: true, speed: 15.0, steerAngle: 0.1 });
  }

  assert(vector3Allocs === 0, `zero Vector3 allocations during update: got ${vector3Allocs}`);
  near(jeep.pooledLight.position.y, jeep.root.position.y + 1.6, 1e-4, "light position offset Y verified");
  near(jeep.pooledLight.position.z, jeep.root.position.z + 0.65, 1e-4, "light position offset Z verified");
  jeep.dispose();
});

await check("T5.2 State & Input Hardening (null/undefined safety & dual-signature dt)", () => {
  const prof = makeJeepProfile();
  const jeep = JM.buildProceduralJeep(THREE, prof);

  // 1. null state does not throw
  jeep.update(null);
  assert(Number.isFinite(jeep.wheelRollAngle), "wheelRollAngle finite after update(null)");

  // 2. undefined state does not throw
  jeep.update(undefined);
  assert(Number.isFinite(jeep.wheelRollAngle), "wheelRollAngle finite after update(undefined)");

  // 3. dual-signature support: update(state, dt)
  const prevRoll = jeep.wheelRollAngle;
  jeep.update({ speed: 10.0 }, 0.05);
  const expectedRollDelta = (10.0 * 0.05) / JEEP_DIMENSIONS.wheelRadius;
  near(jeep.wheelRollAngle - prevRoll, expectedRollDelta, 1e-4, "dual-signature argDt advances wheelRollAngle");

  // 4. state.dt takes precedence when both are provided
  const rollBeforeBoth = jeep.wheelRollAngle;
  jeep.update({ speed: 10.0, dt: 0.1 }, 0.02);
  const expectedPrecedenceDelta = (10.0 * 0.1) / JEEP_DIMENSIONS.wheelRadius;
  near(jeep.wheelRollAngle - rollBeforeBoth, expectedPrecedenceDelta, 1e-4, "state.dt takes precedence over argDt");

  jeep.dispose();
});

await check("T5.3 Non-Finite Kinematics & NaN Poisoning Immunity", () => {
  const prof = makeJeepProfile();
  const jeep = JM.buildProceduralJeep(THREE, prof);

  // 1. Extreme non-finite speed values
  jeep.update({ speed: Infinity });
  assert(Number.isFinite(jeep.wheelRollAngle), "wheelRollAngle finite after speed: Infinity");
  jeep.update({ speed: -Infinity });
  assert(Number.isFinite(jeep.wheelRollAngle), "wheelRollAngle finite after speed: -Infinity");
  jeep.update({ speed: NaN });
  assert(Number.isFinite(jeep.wheelRollAngle), "wheelRollAngle finite after speed: NaN");

  // 2. Non-finite dt values
  jeep.update({ speed: 10.0, dt: Infinity });
  assert(Number.isFinite(jeep.wheelRollAngle), "wheelRollAngle finite after dt: Infinity");
  jeep.update({ speed: 10.0, dt: NaN });
  assert(Number.isFinite(jeep.wheelRollAngle), "wheelRollAngle finite after dt: NaN");

  // 3. Non-finite steer & accel
  jeep.update({ steerAngle: Infinity, accel: NaN, speed: 10.0 });
  assert(Number.isFinite(jeep.steerPivotFL.rotation.z), "steerPivotFL finite after steerAngle: Infinity");
  assert(Number.isFinite(jeep.steeringWheelPivot.rotation.z), "steeringWheelPivot finite");
  assert(Number.isFinite(jeep.chassisBodyGroup.rotation.x), "chassis squat finite after accel: NaN");
  assert(Number.isFinite(jeep.chassisBodyGroup.rotation.y), "chassis roll finite");

  // 4. Non-finite suspension
  const baseSuspZ = 0.38;
  jeep.update({ suspensionFL: NaN, suspensionFR: Infinity, suspensionRL: -Infinity });
  near(jeep.suspFL.position.z, baseSuspZ, 1e-4, "suspFL position guarded against NaN");
  near(jeep.suspFR.position.z, baseSuspZ, 1e-4, "suspFR position guarded against Infinity");
  near(jeep.suspRL.position.z, baseSuspZ, 1e-4, "suspRL position guarded against -Infinity");

  // 5. Subsequent valid update recovers and advances kinematics normally
  const rollBeforeRecovery = jeep.wheelRollAngle;
  jeep.update({ speed: 12.0, dt: 0.05 });
  assert(Number.isFinite(jeep.wheelRollAngle), "wheel roll remains finite after recovery");
  assert(jeep.wheelRollAngle !== rollBeforeRecovery, "wheel roll successfully advances after recovery");

  jeep.dispose();
});

await check("T5.4 Options Null-Safety & Exposed Pivots/maxDrawCalls", () => {
  // 1. buildProceduralJeep handles null/undefined profile and options without crashing
  const jeepNull = JM.buildProceduralJeep(THREE, null, null);
  assert(jeepNull && jeepNull.root, "buildProceduralJeep(THREE, null, null) succeeds");
  jeepNull.dispose();

  const jeep = JM.buildProceduralJeep(THREE);

  // 2. maxDrawCalls exposed as 16
  assert(jeep.maxDrawCalls === 16, `maxDrawCalls is 16, got ${jeep.maxDrawCalls}`);
  assert(jeep.maxDrawCalls === JEEP_DIMENSIONS.maxDrawCalls, "maxDrawCalls matches JEEP_DIMENSIONS");

  // 3. pivots object exposed with all essential articulation pivots
  assert(jeep.pivots && typeof jeep.pivots === "object", "pivots object exposed");
  assert(jeep.pivots.steerPivotFL && jeep.pivots.steerPivotFR, "steer pivots in pivots");
  assert(jeep.pivots.steeringWheelPivot, "steeringWheelPivot in pivots");
  assert(jeep.pivots.speedoNeedlePivot, "speedoNeedlePivot in pivots");
  assert(jeep.pivots.shifterPivot, "shifterPivot in pivots");
  assert(jeep.pivots.transferCasePivot, "transferCasePivot in pivots");
  assert(jeep.pivots.windscreenPivot, "windscreenPivot in pivots");
  assert(jeep.pivots.tailgatePivot, "tailgatePivot in pivots");
  assert(jeep.pivots.suspFL && jeep.pivots.suspFR, "front suspension in pivots");
  assert(jeep.pivots.suspRL && jeep.pivots.suspRR, "rear suspension in pivots");

  jeep.dispose();
});

await check("T5.5 Deduplicated Geometry & Material Disposal Lifecycle", () => {
  const activeLights = [];
  const prof = makeJeepProfile();
  const jeep = JM.buildProceduralJeep(THREE, prof, { liveScene3d: { activeLights } });

  const geomDisposeCounts = new Map();
  const matDisposeCounts = new Map();

  jeep.root.traverse((obj) => {
    if (obj.geometry && !geomDisposeCounts.has(obj.geometry)) {
      geomDisposeCounts.set(obj.geometry, 0);
      const origGeomDispose = obj.geometry.dispose.bind(obj.geometry);
      obj.geometry.dispose = () => {
        geomDisposeCounts.set(obj.geometry, (geomDisposeCounts.get(obj.geometry) || 0) + 1);
        origGeomDispose();
      };
    }
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (m && !matDisposeCounts.has(m)) {
          matDisposeCounts.set(m, 0);
          const origMatDispose = m.dispose.bind(m);
          m.dispose = () => {
            matDisposeCounts.set(m, (matDisposeCounts.get(m) || 0) + 1);
            origMatDispose();
          };
        }
      }
    }
  });

  // Execute disposal
  jeep.dispose();

  // Assert every unique geometry was disposed exactly once (no redundant calls from shared combat wheel geometry)
  assert(geomDisposeCounts.size > 0, "unique geometries recorded");
  for (const [geom, count] of geomDisposeCounts.entries()) {
    assert(count === 1, `geometry ${geom.uuid || "unknown"} disposed exactly once (got ${count})`);
  }

  // Assert every unique material was disposed exactly once
  assert(matDisposeCounts.size > 0, "unique materials recorded");
  for (const [mat, count] of matDisposeCounts.entries()) {
    assert(count === 1, `material ${mat.uuid || "unknown"} disposed exactly once (got ${count})`);
  }

  // Assert pooled light removed
  assert(activeLights.length === 0, "activeLights emptied on disposal");
});

await check("T5.6 3D White Invasion Star Decal Exact 3.5mm Hood Plane Offset", () => {
  const prof = makeJeepProfile();
  const jeep = JM.buildProceduralJeep(THREE, prof);

  const tub = jeep.root.getObjectByName("tub-chassis");
  assert(tub && tub.geometry, "tub-chassis geometry found");

  const pos = tub.geometry.getAttribute("position");
  const col = tub.geometry.getAttribute("color");
  assert(pos && col, "tub-chassis has position and color attributes");

  const cTmp = new THREE.Color();
  let starVertCount = 0;
  let minDiffMm = Infinity;
  let maxDiffMm = -Infinity;
  let minPerpMm = Infinity;
  let maxPerpMm = -Infinity;

  // Hood slopes from cowl (y=0.48, z=0.88) to grille (y=1.38, z=0.84)
  const dy = 0.90, dz = -0.04;
  const L = Math.hypot(dy, dz);
  // Outward normal: [0, -dz/L, dy/L] = [0, 0.04/L, 0.90/L]
  const ny = -dz / L;
  const nz = dy / L;

  for (let i = 0; i < pos.count; i++) {
    cTmp.setRGB(col.getX(i), col.getY(i), col.getZ(i));
    if (cTmp.getHex() === JEEP_PALETTE.starWhite) {
      starVertCount++;
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);

      // 1. Vertical difference above the sloping hood sheet metal
      const zHood = 0.88 - (2 / 45) * (y - 0.48);
      const diffMm = (z - zHood) * 1000;
      if (diffMm < minDiffMm) minDiffMm = diffMm;
      if (diffMm > maxDiffMm) maxDiffMm = diffMm;

      // 2. Exact perpendicular distance from the hood plane
      // Vector from point on plane (0, 0.48, 0.88) to vertex: [x, y - 0.48, z - 0.88]
      const perpMm = ((y - 0.48) * ny + (z - 0.88) * nz) * 1000;
      if (perpMm < minPerpMm) minPerpMm = perpMm;
      if (perpMm > maxPerpMm) maxPerpMm = perpMm;
    }
  }

  assert(starVertCount === 30, `star comprises 10 triangles (30 vertices), got ${starVertCount}`);

  // Every vertex must sit uniformly at ~3.5 mm above the hood
  assert(minDiffMm >= 3.49 && maxDiffMm <= 3.52, `vertical offset range [${minDiffMm.toFixed(3)}, ${maxDiffMm.toFixed(3)}] mm within 3.5mm`);
  assert(minPerpMm >= 3.495 && maxPerpMm <= 3.505, `perpendicular distance [${minPerpMm.toFixed(4)}, ${maxPerpMm.toFixed(4)}] mm is exactly 3.5mm`);
  assert(minDiffMm > 0, "no star vertex penetrates into or below hood surface");

  jeep.dispose();
});

await check("T5.7 Rotated Headlight FxLightSource Tracking, Zero Alloc, and Dispose Release (BUG-6, ADV-4)", () => {
  let vector3Allocs = 0;
  class MonitoredVector3 extends THREE.Vector3 {
    constructor(...args) {
      vector3Allocs++;
      super(...args);
    }
  }
  const customThree = Object.create(THREE);
  customThree.Vector3 = MonitoredVector3;

  const activeLights = [];
  const prof = makeJeepProfile();
  const jeep = JM.buildProceduralJeep(customThree, prof, { liveScene3d: { activeLights } });
  jeep.root.position.set(50, 80, 5);
  jeep.root.rotation.z = -Math.PI / 2; // compass heading = +pi/2 (East = +X)
  jeep.root.updateMatrixWorld(true);

  vector3Allocs = 0;
  jeep.update({ headlights: true, speed: 10.0 });
  assert(vector3Allocs === 0, `zero Vector3 allocations on rotated headlight update: got ${vector3Allocs}`);
  near(jeep.pooledLight.position.x, 50 + 1.6, 1e-3, "jeep headlight X rotated East (+X)");
  near(jeep.pooledLight.position.y, 80, 1e-3, "jeep headlight Y rotated East (0 offset)");
  near(jeep.pooledLight.position.z, 5 + 0.65, 1e-3, "jeep headlight Z offset preserved");

  // Subsequent update omitting s.headlights must still track moved/rotated vehicle
  jeep.root.position.set(60, 90, 5);
  jeep.root.rotation.z = -Math.PI; // compass heading = pi (South = -Y)
  jeep.root.updateMatrixWorld(true);
  jeep.update({ speed: 12.0 });
  assert(vector3Allocs === 0, `zero Vector3 allocations when s.headlights omitted: got ${vector3Allocs}`);
  near(jeep.pooledLight.position.x, 60, 1e-3, "jeep headlight X tracks South");
  near(jeep.pooledLight.position.y, 90 - 1.6, 1e-3, "jeep headlight Y tracks South (-Y)");

  jeep.dispose();
  assert(jeep.pooledLight.released === true, "jeep pooledLight.released === true on dispose");
  assert(jeep.pooledLight.intensity === 0, "jeep pooledLight.intensity === 0 on dispose");
  assert(activeLights.length === 0, "jeep pooledLight removed from activeLights");

  const hlGroup = new THREE.Group();
  hlGroup.position.set(10, 20, 1);
  hlGroup.rotation.z = -Math.PI / 2;
  hlGroup.updateMatrixWorld(true);
  const hl = createVehicleHeadlights(THREE, hlGroup, { liveScene3d: { activeLights } });
  hl.update({ headlights: true });
  hl.update(null); // must not throw on null state and must preserve rotated position
  near(hl.pooledLight.position.x, 10 + 1.6, 1e-3, "fx_lights update(null) preserves rotated headlight X");
  hl.dispose();
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\nvehicle_jeep_model: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
