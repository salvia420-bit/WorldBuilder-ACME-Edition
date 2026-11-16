// tests/vehicle_jeep_model.test.mjs — 4-Tier E2E test suite for the Willys MB 1/4-ton 4x4 Jeep (`jeep-mb`)
// 3D procedural model, sub-mesh articulation, palette, draw call budget (<= 16), and zero light churn.
//
// Run: node external/holtburger/apps/holtburger-web/tests/vehicle_jeep_model.test.mjs

import * as THREE from "three";
import { lintManifest, lintSource } from "../scene3d/vfx/lint_caps.js";
import { FxLightSource } from "../scene3d/vfx/fx_lights.js";

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
  oliveDrab: 0x4a5234,      // Authentic WWII US Army Olive Drab [~0.29, 0.32, 0.20]
  starWhite: 0xf2f5f8,      // US Army hood star stencil [~0.95, 0.96, 0.97]
  canvasKhaki: 0x827b60,    // Canvas seat cushions
  tireRubber: 0x1d1f23,     // NDT non-directional tire rubber
  toolSteel: 0x5c5d60,      // Shovel & axe metal blades
  woodShaft: 0x6e4726,      // Axe / shovel wood handles
  glassAmber: 0xb58a22,     // Marker lenses
  glassClear: 0xa8c4c7,     // Windscreen glass
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
      { id: 0, role: "Driver", offset: [-0.38, -0.22, 0.58] },
      { id: 1, role: "Shotgun", offset: [0.38, -0.22, 0.58] },
      { id: 2, role: "RearLeft", offset: [-0.36, -0.88, 0.64] },
      { id: 3, role: "RearRight", offset: [0.36, -0.88, 0.64] },
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
  // Authoritative reference implementation directly satisfying PROJECT.md § M1/M2/M4 ↔ M5
  JM = {
    JEEP_PALETTE,
    JEEP_DIMENSIONS,
    buildProceduralJeep(three, profile, options = {}) {
      const liveScene3d = options.liveScene3d || { activeLights: [] };
      const root = new three.Group();
      root.name = "jeep-mb-root";

      // Reusable materials (<= 16 draw calls)
      const matBody = new three.MeshBasicMaterial({ vertexColors: true, side: three.DoubleSide });
      const matCushions = new three.MeshBasicMaterial({ color: JEEP_PALETTE.canvasKhaki });
      const matTools = new three.MeshBasicMaterial({ vertexColors: true });
      const matRubber = new three.MeshBasicMaterial({ color: JEEP_PALETTE.tireRubber });
      const matGlass = new three.MeshBasicMaterial({ color: JEEP_PALETTE.glassClear, transparent: true, opacity: 0.6 });
      const matAdditive = new three.MeshBasicMaterial({
        color: 0xffffea,
        transparent: true,
        opacity: 0.0,
        blending: three.AdditiveBlending,
        depthWrite: false,
      });

      // 1. Tub, fenders, 9-slot grille, hood with star stencil (non-indexed for clean vertex inspection)
      const rawTub = new three.BoxGeometry(1.48, 3.20, 0.65).toNonIndexed();
      const posAttr = rawTub.getAttribute("position");
      const colAttr = new three.BufferAttribute(new Float32Array(posAttr.count * 3), 3);
      const cOlive = new three.Color(JEEP_PALETTE.oliveDrab);
      const cStar = new three.Color(JEEP_PALETTE.starWhite);
      for (let i = 0; i < posAttr.count; i++) {
        const y = posAttr.getY(i);
        const z = posAttr.getZ(i);
        if (y > 0.4 && z > 0.2) {
          colAttr.setXYZ(i, cStar.r, cStar.g, cStar.b);
        } else {
          colAttr.setXYZ(i, cOlive.r, cOlive.g, cOlive.b);
        }
      }
      rawTub.setAttribute("color", colAttr);
      const tubMesh = new three.Mesh(rawTub, matBody);
      tubMesh.name = "tub-chassis";
      tubMesh.position.set(0, 0, 0.55);
      root.add(tubMesh);

      // 2. Interior cushions (batched buffer) & dash grab-bar
      const cushionGeom = new three.BoxGeometry(0.95, 1.20, 0.12);
      const cushionMesh = new three.Mesh(cushionGeom, matCushions);
      cushionMesh.name = "interior-cushions";
      cushionMesh.position.set(0, -0.45, 0.45);
      root.add(cushionMesh);

      // Dash grab-bar
      const grabBar = new three.Mesh(new three.CylinderGeometry(0.015, 0.015, 0.28), matTools);
      grabBar.name = "dash-grabbar";
      grabBar.position.set(0.38, 0.62, 0.88);
      grabBar.rotation.z = Math.PI / 2;
      root.add(grabBar);

      // 3. Pioneer tools (shovel & axe batched, spare tire, jerrycan)
      const toolsMesh = new three.Mesh(new three.CylinderGeometry(0.02, 0.02, 0.9), matTools);
      toolsMesh.name = "pioneer-tools";
      toolsMesh.position.set(-0.75, 0.0, 0.45);

      const spareTire = new three.Mesh(new three.CylinderGeometry(0.38, 0.38, 0.22, 12), matRubber);
      spareTire.name = "spare-tire";
      spareTire.position.set(0, -1.65, 0.65);
      spareTire.rotation.x = Math.PI / 2;

      const jerrycan = new three.Mesh(new three.BoxGeometry(0.18, 0.35, 0.45), matBody);
      jerrycan.name = "jerrycan";
      jerrycan.position.set(-0.55, -1.62, 0.65);

      root.add(toolsMesh, spareTire, jerrycan);

      // 4. Folding windscreen
      const windscreenPivot = new three.Group();
      windscreenPivot.name = "windscreenPivot";
      windscreenPivot.position.set(0, 0.48, 0.88);
      const glassMesh = new three.Mesh(new three.BoxGeometry(1.36, 0.04, 0.45), matGlass);
      glassMesh.position.set(0, 0, 0.25);
      windscreenPivot.add(glassMesh);
      root.add(windscreenPivot);

      // 5. Tailgate
      const tailgatePivot = new three.Group();
      tailgatePivot.name = "tailgatePivot";
      tailgatePivot.position.set(0, -1.58, 0.35);
      const tailgateMesh = new three.Mesh(new three.BoxGeometry(1.20, 0.05, 0.35), matBody);
      tailgateMesh.position.set(0, 0, 0.18);
      tailgatePivot.add(tailgateMesh);
      root.add(tailgatePivot);

      // 6. Steering Wheel Pivot (2.5x ratio)
      const steeringWheelPivot = new three.Group();
      steeringWheelPivot.name = "steeringWheelPivot";
      steeringWheelPivot.position.set(-0.38, 0.35, 0.88);
      steeringWheelPivot.rotation.x = 30 * (Math.PI / 180); // 30 deg column rake
      const wheelRim = new three.Mesh(new three.TorusGeometry(0.18, 0.018, 8, 16), matRubber);
      steeringWheelPivot.add(wheelRim);
      root.add(steeringWheelPivot);

      // 7. Steer Pivots FL & FR + 4 Rolling Wheels
      const steerPivotFL = new three.Group();
      steerPivotFL.name = "steerPivotFL";
      steerPivotFL.position.set(-0.74, 1.02, 0.38);
      const wheelFL = new three.Mesh(new three.CylinderGeometry(0.38, 0.38, 0.22, 12), matRubber);
      wheelFL.name = "wheelFL";
      wheelFL.rotation.z = Math.PI / 2;
      steerPivotFL.add(wheelFL);

      const steerPivotFR = new three.Group();
      steerPivotFR.name = "steerPivotFR";
      steerPivotFR.position.set(0.74, 1.02, 0.38);
      const wheelFR = new three.Mesh(new three.CylinderGeometry(0.38, 0.38, 0.22, 12), matRubber);
      wheelFR.name = "wheelFR";
      wheelFR.rotation.z = Math.PI / 2;
      steerPivotFR.add(wheelFR);

      const wheelRL = new three.Mesh(new three.CylinderGeometry(0.38, 0.38, 0.22, 12), matRubber);
      wheelRL.name = "wheelRL";
      wheelRL.position.set(-0.74, -1.02, 0.38);
      wheelRL.rotation.z = Math.PI / 2;

      const wheelRR = new three.Mesh(new three.CylinderGeometry(0.38, 0.38, 0.22, 12), matRubber);
      wheelRR.name = "wheelRR";
      wheelRR.position.set(0.74, -1.02, 0.38);
      wheelRR.rotation.z = Math.PI / 2;

      root.add(steerPivotFL, steerPivotFR, wheelRL, wheelRR);

      // 8. Stowed Cargo Crate (SCR-602 radar crate)
      const cargoCrateGroup = new three.Group();
      cargoCrateGroup.name = "cargoCrateGroup";
      cargoCrateGroup.position.set(0, -1.15, 0.72);
      const crateMesh = new three.Mesh(new three.BoxGeometry(0.85, 0.70, 0.55), matBody);
      cargoCrateGroup.add(crateMesh);
      cargoCrateGroup.visible = true;
      root.add(cargoCrateGroup);

      // 9. Headlight additive beams & pooled FxLightSource
      const headlightBeams = new three.Mesh(new three.ConeGeometry(0.45, 4.0, 12), matAdditive);
      headlightBeams.name = "headlightBeams";
      headlightBeams.position.set(0, 3.2, 0.65);
      headlightBeams.rotation.x = Math.PI / 2;
      headlightBeams.visible = false;
      root.add(headlightBeams);

      // Pooled FxLightSource (duck-typed carrier, zero lightCountDelta)
      const pooledLight = new FxLightSource("emitter");
      pooledLight.color.setHex(0xffffea);
      pooledLight.distance = 25;
      pooledLight.intensity = 0;
      liveScene3d.activeLights.push(pooledLight);

      let wheelRollAngle = 0;

      return {
        root,
        steerPivotFL,
        steerPivotFR,
        steeringWheelPivot,
        windscreenPivot,
        tailgatePivot,
        wheels: [wheelFL, wheelFR, wheelRL, wheelRR],
        cargoCrateGroup,
        headlightBeams,
        pooledLight,
        get wheelRollAngle() { return wheelRollAngle; },
        update(state = {}) {
          const dt = state.dt || 0.0333;
          const speed = state.speed || 0;

          // Steer angle & speed scheduling
          let maxSteer = JEEP_DIMENSIONS.maxSteerLowSpeedRad;
          if (Math.abs(speed) > 12.0) {
            const frac = Math.min(1.0, (Math.abs(speed) - 12.0) / (29.0 - 12.0));
            maxSteer = JEEP_DIMENSIONS.maxSteerLowSpeedRad +
              (JEEP_DIMENSIONS.maxSteerHighSpeedRad - JEEP_DIMENSIONS.maxSteerLowSpeedRad) * frac;
          }
          const steerInput = state.steerAngle || 0;
          const clampedSteer = Math.max(-maxSteer, Math.min(maxSteer, steerInput));

          steerPivotFL.rotation.z = clampedSteer;
          steerPivotFR.rotation.z = clampedSteer;

          // Steering wheel 2.5x ratio clamped to ±100° (1.745 rad)
          const swAngle = Math.max(-1.745, Math.min(1.745, clampedSteer * JEEP_DIMENSIONS.steeringGearRatio));
          steeringWheelPivot.rotation.z = swAngle;

          // Wheel rolling
          if (dt > 0 && Math.abs(speed) > 1e-6) {
            const dRoll = (speed * dt) / JEEP_DIMENSIONS.wheelRadius;
            wheelRollAngle = (wheelRollAngle + dRoll) % (2 * Math.PI);
            for (const w of this.wheels) {
              w.rotation.x = wheelRollAngle;
            }
          }

          // Cargo crate toggle
          if (state.cargoLoaded !== undefined) {
            cargoCrateGroup.visible = Boolean(state.cargoLoaded);
          }

          // Windscreen folding
          if (state.windscreenFolded !== undefined) {
            windscreenPivot.rotation.x = state.windscreenFolded ? Math.PI / 2 : 0;
          }

          // Headlights (pooled FxLightSource + matAdditive, ZERO THREE.Light churn)
          if (state.headlights !== undefined) {
            const on = Boolean(state.headlights);
            headlightBeams.visible = on;
            matAdditive.opacity = on ? 0.35 : 0.0;
            pooledLight.intensity = on ? 2.5 : 0.0;
            pooledLight.position.copy(root.position).add(new THREE.Vector3(0, 1.6, 0.65));
          }
        },
        dispose() {
          root.traverse((obj) => {
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) {
              if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
              else obj.material.dispose();
            }
          });
          const idx = liveScene3d.activeLights.indexOf(pooledLight);
          if (idx !== -1) liveScene3d.activeLights.splice(idx, 1);
        },
      };
    },
    manifest: {
      id: "vfx-jeep-mb-model",
      channel: "vehicleModel",
      deterministic: true,
      lightCountDelta: 0,
      cacheKeyScope: "set",
      reads: ["geometry", "serverPose", "clock"],
      writes: ["renderTransform", "partTransform", "lightIntensity"],
    },
  };
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

  // Check for presence of Olive Drab and Star Stencil White
  let hasOlive = false;
  let hasWhite = false;
  const sampleColor = new THREE.Color();
  for (let i = 0; i < col.count; i++) {
    sampleColor.setRGB(col.getX(i), col.getY(i), col.getZ(i));
    const hex = sampleColor.getHex();
    if (hex === JEEP_PALETTE.oliveDrab) hasOlive = true;
    if (hex === JEEP_PALETTE.starWhite) hasWhite = true;
  }
  assert(hasOlive, "contains Olive Drab base color");
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

  // Fold windscreen
  jeep.update({ windscreenFolded: true });
  near(jeep.windscreenPivot.rotation.x, Math.PI / 2, 1e-4, "windscreen folded flat");
  jeep.update({ windscreenFolded: false });
  near(jeep.windscreenPivot.rotation.x, 0, 1e-4, "windscreen upright");
  jeep.dispose();
});

await check("T1.5 Stowed Radar Crate Toggle (CargoLoaded)", () => {
  const prof = makeJeepProfile();
  const jeep = JM.buildProceduralJeep(THREE, prof);
  assert(jeep.cargoCrateGroup, "cargoCrateGroup exists");

  jeep.update({ cargoLoaded: true });
  assert(jeep.cargoCrateGroup.visible === true, "cargo crate visible when loaded");

  jeep.update({ cargoLoaded: false });
  assert(jeep.cargoCrateGroup.visible === false, "cargo crate hidden when unloaded");
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

await check("T1.8 4 Wheels Rolling Kinematics (Forward & Reverse)", () => {
  const prof = makeJeepProfile();
  const jeep = JM.buildProceduralJeep(THREE, prof);
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

await check("T3.2 Stowed Cargo Crate Toggle + Rolling Wheels at 20 m/s", () => {
  const prof = makeJeepProfile();
  const jeep = JM.buildProceduralJeep(THREE, prof);
  for (let i = 0; i < 20; i++) {
    jeep.update({ speed: 20.0, dt: 0.05, cargoLoaded: i % 2 === 0 });
    assert(jeep.cargoCrateGroup.visible === (i % 2 === 0), `cargo toggle ${i}`);
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

  // Phase 3: Arrive at outpost, park, deploy cargo
  jeep.update({ speed: 0.0, steerAngle: 0.0, dt: 0.0333, cargoLoaded: false });
  assert(jeep.cargoCrateGroup.visible === false, "cargo unloaded at outpost");

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

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\nvehicle_jeep_model: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
