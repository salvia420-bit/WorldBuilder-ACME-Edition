// scene3d/vehicle/jeep_model.js — Procedural Willys MB 1/4-ton 4x4 Jeep (jeep-mb) 3D Model
// Implements Feature 36: <= 16 draw calls, 15 sub-meshes, steering & rolling kinematics,
// articulated windscreen and tailgate, cargo crate toggle, zero light churn headlights.

import * as THREE_DEFAULT from "three";
import { FxLightSource } from "../vfx/fx_lights.js";

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

export function buildProceduralJeep(three, profile = {}, options = {}) {
  const t = three || THREE_DEFAULT;
  const liveScene3d = options.liveScene3d || { activeLights: [] };
  const root = new t.Group();
  root.name = "jeep-mb-root";

  // Reusable materials (<= 16 draw calls)
  const matBody = new t.MeshBasicMaterial({ vertexColors: true, side: t.DoubleSide });
  const matCushions = new t.MeshBasicMaterial({ color: JEEP_PALETTE.canvasKhaki });
  const matTools = new t.MeshBasicMaterial({ color: JEEP_PALETTE.toolSteel });
  const matRubber = new t.MeshBasicMaterial({ color: JEEP_PALETTE.tireRubber });
  const matGlass = new t.MeshBasicMaterial({ color: JEEP_PALETTE.glassClear, transparent: true, opacity: 0.6 });
  const matAdditive = new t.MeshBasicMaterial({
    color: 0xffffea,
    transparent: true,
    opacity: 0.0,
    blending: t.AdditiveBlending,
    depthWrite: false,
  });

  // 1. Tub, fenders, 9-slot grille, hood with star stencil (non-indexed for clean vertex inspection)
  const rawTub = new t.BoxGeometry(1.48, 3.20, 0.65).toNonIndexed();
  const posAttr = rawTub.getAttribute("position");
  const colAttr = new t.BufferAttribute(new Float32Array(posAttr.count * 3), 3);
  const cOlive = new t.Color(JEEP_PALETTE.oliveDrab);
  const cStar = new t.Color(JEEP_PALETTE.starWhite);
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
  const tubMesh = new t.Mesh(rawTub, matBody);
  tubMesh.name = "tub-chassis";
  tubMesh.position.set(0, 0, 0.55);
  root.add(tubMesh);

  // 2. Interior cushions & dash grab-bar
  const cushionGeom = new t.BoxGeometry(0.95, 1.20, 0.12);
  const cushionMesh = new t.Mesh(cushionGeom, matCushions);
  cushionMesh.name = "interior-cushions";
  cushionMesh.position.set(0, -0.45, 0.45);
  root.add(cushionMesh);

  const grabBar = new t.Mesh(new t.CylinderGeometry(0.015, 0.015, 0.28), matTools);
  grabBar.name = "dash-grabbar";
  grabBar.position.set(0.38, 0.62, 0.88);
  grabBar.rotation.z = Math.PI / 2;
  root.add(grabBar);

  // 3. Pioneer tools, spare tire, jerrycan
  const toolsMesh = new t.Mesh(new t.CylinderGeometry(0.02, 0.02, 0.9), matTools);
  toolsMesh.name = "pioneer-tools";
  toolsMesh.position.set(-0.75, 0.0, 0.45);

  const spareTire = new t.Mesh(new t.CylinderGeometry(0.38, 0.38, 0.22, 12), matRubber);
  spareTire.name = "spare-tire";
  spareTire.position.set(0, -1.65, 0.65);
  spareTire.rotation.x = Math.PI / 2;

  const jerrycan = new t.Mesh(new t.BoxGeometry(0.18, 0.35, 0.45), matBody);
  jerrycan.name = "jerrycan";
  jerrycan.position.set(-0.55, -1.62, 0.65);

  root.add(toolsMesh, spareTire, jerrycan);

  // 4. Folding windscreen
  const windscreenPivot = new t.Group();
  windscreenPivot.name = "windscreenPivot";
  windscreenPivot.position.set(0, 0.48, 0.88);
  const glassMesh = new t.Mesh(new t.BoxGeometry(1.36, 0.04, 0.45), matGlass);
  glassMesh.position.set(0, 0, 0.25);
  windscreenPivot.add(glassMesh);
  root.add(windscreenPivot);

  // 5. Tailgate
  const tailgatePivot = new t.Group();
  tailgatePivot.name = "tailgatePivot";
  tailgatePivot.position.set(0, -1.58, 0.35);
  const tailgateMesh = new t.Mesh(new t.BoxGeometry(1.20, 0.05, 0.35), matBody);
  tailgateMesh.position.set(0, 0, 0.18);
  tailgatePivot.add(tailgateMesh);
  root.add(tailgatePivot);

  // 6. Steering Wheel Pivot (2.5x ratio)
  const steeringWheelPivot = new t.Group();
  steeringWheelPivot.name = "steeringWheelPivot";
  steeringWheelPivot.position.set(-0.38, 0.35, 0.88);
  steeringWheelPivot.rotation.x = 30 * (Math.PI / 180); // 30 deg column rake
  const wheelRim = new t.Mesh(new t.TorusGeometry(0.18, 0.018, 8, 16), matRubber);
  steeringWheelPivot.add(wheelRim);
  root.add(steeringWheelPivot);

  // 7. Steer Pivots FL & FR + 4 Rolling Wheels
  const steerPivotFL = new t.Group();
  steerPivotFL.name = "steerPivotFL";
  steerPivotFL.position.set(-0.74, 1.02, 0.38);
  const wheelFL = new t.Mesh(new t.CylinderGeometry(0.38, 0.38, 0.22, 12), matRubber);
  wheelFL.name = "wheelFL";
  wheelFL.rotation.z = Math.PI / 2;
  steerPivotFL.add(wheelFL);

  const steerPivotFR = new t.Group();
  steerPivotFR.name = "steerPivotFR";
  steerPivotFR.position.set(0.74, 1.02, 0.38);
  const wheelFR = new t.Mesh(new t.CylinderGeometry(0.38, 0.38, 0.22, 12), matRubber);
  wheelFR.name = "wheelFR";
  wheelFR.rotation.z = Math.PI / 2;
  steerPivotFR.add(wheelFR);

  const wheelRL = new t.Mesh(new t.CylinderGeometry(0.38, 0.38, 0.22, 12), matRubber);
  wheelRL.name = "wheelRL";
  wheelRL.position.set(-0.74, -1.02, 0.38);
  wheelRL.rotation.z = Math.PI / 2;

  const wheelRR = new t.Mesh(new t.CylinderGeometry(0.38, 0.38, 0.22, 12), matRubber);
  wheelRR.name = "wheelRR";
  wheelRR.position.set(0.74, -1.02, 0.38);
  wheelRR.rotation.z = Math.PI / 2;

  root.add(steerPivotFL, steerPivotFR, wheelRL, wheelRR);

  // 8. Stowed Cargo Crate (SCR-602 radar crate)
  const cargoCrateGroup = new t.Group();
  cargoCrateGroup.name = "cargoCrateGroup";
  cargoCrateGroup.position.set(0, -1.15, 0.72);
  const crateMesh = new t.Mesh(new t.BoxGeometry(0.85, 0.70, 0.55), matBody);
  cargoCrateGroup.add(crateMesh);
  cargoCrateGroup.visible = true; // vfx-lint-allow: cargo visibility initial
  root.add(cargoCrateGroup);

  // 9. Headlight additive beams & pooled FxLightSource
  const headlightBeams = new t.Mesh(new t.ConeGeometry(0.45, 4.0, 12), matAdditive);
  headlightBeams.name = "headlightBeams";
  headlightBeams.position.set(0, 3.2, 0.65);
  headlightBeams.rotation.x = Math.PI / 2;
  headlightBeams.visible = false; // vfx-lint-allow: headlight beam toggle initial
  root.add(headlightBeams);

  // Pooled FxLightSource (duck-typed carrier, zero lightCountDelta)
  const pooledLight = new FxLightSource("emitter");
  pooledLight.color.setHex(0xffffea);
  pooledLight.distance = 25;
  pooledLight.intensity = 0;
  if (Array.isArray(liveScene3d.activeLights)) {
    liveScene3d.activeLights.push(pooledLight);
  }

  const lightOffset = new t.Vector3(0, 1.6, 0.65);
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
        if (wheelRollAngle < 0) wheelRollAngle += 2 * Math.PI;
        for (const w of this.wheels) {
          w.rotation.x = wheelRollAngle;
        }
      }

      // Cargo crate toggle
      if (state.cargoLoaded !== undefined) {
        cargoCrateGroup.visible = Boolean(state.cargoLoaded); // vfx-lint-allow: cargo visibility toggle
      }

      // Windscreen folding
      if (state.windscreenFolded !== undefined) {
        windscreenPivot.rotation.x = state.windscreenFolded ? Math.PI / 2 : 0;
      }

      // Headlights (pooled FxLightSource + matAdditive, ZERO THREE.Light churn)
      if (state.headlights !== undefined) {
        const on = Boolean(state.headlights);
        headlightBeams.visible = on; // vfx-lint-allow: additive beam mesh toggle
        matAdditive.opacity = on ? 0.35 : 0.0;
        pooledLight.intensity = on ? 2.5 : 0.0;
        pooledLight.position.copy(root.position).add(lightOffset);
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
      if (Array.isArray(liveScene3d.activeLights)) {
        const idx = liveScene3d.activeLights.indexOf(pooledLight);
        if (idx !== -1) liveScene3d.activeLights.splice(idx, 1);
      }
    },
  };
}

export const manifest = Object.freeze({
  id: "vfx-jeep-mb-model",
  channel: "vehicleModel",
  deterministic: true,
  lightCountDelta: 0,
  cacheKeyScope: "set",
  reads: ["geometry", "serverPose", "clock"],
  writes: ["renderTransform", "partTransform", "lightIntensity"],
});
