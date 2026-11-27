// scene3d/vehicle/port_shuttle_model.js — Autonomous Port Terminal Tractor ("Yard Dog")
// + Articulated Skeletal 40ft/20ft Container Chassis (deckZ = 1.32 m).
//
// Dimensions locked to SHUTTLE_SPECS & port_kinematics.js:
//   - Overall length 15.20 m (y in [-7.60, +7.60]), width 2.55 m, wheelbase 3.80 m, wheelRadius 0.51 m
//   - Articulated fifth-wheel pivot (y = +3.35, z = 0.96 m), steering front wheels, rolling drive & tandem axles
//   - Skeletal container chassis with twistlock bolsters at exact deckZ = 1.32 m (40ft & 20ft positions)
//   - Emissive headlights, rear tail/brake lamps, side markers & roof amber hazard beacon (0 dynamic lights)
//   - Optional carried ISO 20ft/40ft/40HC container visual mounted cleanly on deckZ = 1.32 m
//   - `root.rotation.order = "ZYX"` so AC compass heading (-heading) & ramp pitch (+pitch) compose accurately!
//
// Strict GPU budget: <= 10 draw calls (8 DC unloaded, 9 DC loaded), 0 dynamic THREE.Light instances,
// AGX HDR PBR MeshStandardMaterial + 3-cascade CSM shader patching.

import * as THREE_DEFAULT from "three";
import { installCsmShaderPatch } from "../materials.js";
import {
  GeomAcc,
  makeLinearPalette,
  cShade,
  makeDeployablePbrMaterial,
  makeLampsMaterial,
} from "./deployable_models.js";
import {
  SHUTTLE_SPECS,
  resolvePortContainerSpec,
} from "./port_specs.js";
import {
  buildCompactIsoContainer,
  resolvePortLiveryHex,
} from "./port_yard_crane_model.js";

export const manifest = Object.freeze({
  id: "vfx-port-shuttle-model",
  channel: "vehicleModel",
  deterministic: true,
  lightCountDelta: 0,
  cacheKeyScope: "set",
  reads: Object.freeze(["geometry", "serverPose", "clock"]),
  writes: Object.freeze(["renderTransform", "partTransform", "materialUniform"]),
});

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function disposeObjectTree(root, extras = []) {
  const disposedG = new Set();
  const disposedM = new Set();
  const visit = (o) => {
    if (!o) return;
    if (o.geometry && !disposedG.has(o.geometry)) {
      disposedG.add(o.geometry);
      o.geometry.dispose();
    }
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (m && !disposedM.has(m)) {
          disposedM.add(m);
          m.dispose();
        }
      }
    }
    if (o.isInstancedMesh && typeof o.dispose === "function") {
      o.dispose();
    }
  };
  if (root) root.traverse(visit);
  for (const ex of extras) visit(ex);
}

function addHeavyWheel(acc, cx, sideSign, r, pal) {
  const hw = 0.145;
  acc.cylinder(cx, 0, 0, r, hw * 2.0, 20, pal.rubber, "x", true, true, cShade(pal.rubber, 0.80));
  acc.cylinder(cx, 0, 0, r * 0.56, hw * 2.04, 14, pal.rimSilver, "x", true, true, cShade(pal.rimSilver, 0.85));
  acc.cylinder(cx + sideSign * (hw - 0.01), 0, 0, 0.10, 0.06, 10, pal.steelDark, "x");
}

function buildSteerWheelGeom(t, sideSign, r, pal) {
  const acc = new GeomAcc(3);
  addHeavyWheel(acc, 0, sideSign, r, pal);
  return acc.toBufferGeometry(t);
}

function buildDualAxleGeom(t, r, pal) {
  const acc = new GeomAcc(3);
  acc.cylinder(0, 0, 0, 0.075, 2.34, 12, pal.steelDark, "x");
  addHeavyWheel(acc, -0.80, -1, r, pal);
  addHeavyWheel(acc, -1.12, -1, r, pal);
  addHeavyWheel(acc, +0.80, +1, r, pal);
  addHeavyWheel(acc, +1.12, +1, r, pal);
  return acc.toBufferGeometry(t);
}

export function buildPortShuttle(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const opts = options && typeof options === "object" ? options : {};
  const csmState = opts.csmState;
  const S = SHUTTLE_SPECS;

  const wheelR = S.wheelRadiusM; // 0.51 m
  const deckZ = S.deckZ; // 1.32 m
  const kingpinY = +3.10; // Fifth-wheel pivot directly over tractor drive axle
  const frontAxleY = kingpinY + S.wheelbaseM; // +6.90 m (exact 3.80 m wheelbase, tire maxY 7.41 < 7.60 bumper!)
  const chassisCenterY = -1.40; // Chassis spans [-7.60, +4.80] = 12.40 m; tractor front +7.60 -> exact 15.20 m overall!

  const pal = makeLinearPalette(t, {
    cabYellow: opts.bodyHex ?? 0xf0ad10,
    cabYellowDark: 0xc28606,
    cabWhite: 0xe6ebef,
    frameDark: 0x20242a,
    steelDark: 0x2b3138,
    steelMid: 0x5d6670,
    rimSilver: 0xb2bac2,
    chrome: 0xdbe1e8,
    rubber: 0x16181c,
    red: 0xd42820,
    blue: 0x1c68b8,
    lampHead: 0xfff4d4,
    lampAmber: 0xffa410,
    lampRuby: 0xff2218,
    lampCyan: 0x22dcff,
  });

  const root = new t.Group();
  root.name = "port-shuttle-root";
  // CRITICAL: "ZYX" ensures AC compass yaw (-heading) applies BEFORE local nose-up pitch (+pitch) on the quay ramp!
  root.rotation.order = "ZYX";
  root.userData = { wcid: S.wcid, kind: S.kind, portShuttle: true, maxDrawCalls: S.maxDrawCalls };

  // =========================================================================
  // DC 1: Terminal Tractor ("Yard Dog") Chassis, Offset High-Vis Cab, Fifth-Wheel Boom & LiDAR
  // =========================================================================
  const trAcc = new GeomAcc(3);
  // Twin tractor frame rails (y in [+2.40, +7.50], z in [0.68, 0.96])
  for (const sx of [-0.46, +0.46]) {
    trAcc.box(sx, 4.95, 0.82, 0.08, 2.55, 0.14, pal.frameDark, cShade(pal.frameDark, 0.8));
  }
  // Heavy front steel bumper (y_max = +7.59, z in [0.46, 0.88]) with black/yellow hazard bands
  trAcc.bevelBox(0, 7.44, 0.67, 1.24, 0.14, 0.21, 0.05, pal.frameDark, cShade(pal.frameDark, 0.8));
  for (let i = -3; i <= 3; i++) {
    const col = Math.abs(i) % 2 === 0 ? pal.cabYellow : pal.frameDark;
    trAcc.box(i * 0.32, 7.585, 0.67, 0.15, 0.012, 0.16, col, cShade(col, 0.85));
  }
  // Short sloped terminal tractor engine hood & black radiator grille (y in [+6.45, +7.40])
  trAcc.bevelBox(0.32, 6.92, 1.48, 0.66, 0.46, 0.44, 0.08, pal.cabYellow, pal.cabYellowDark);
  trAcc.box(0.32, 7.39, 1.48, 0.52, 0.025, 0.34, pal.frameDark, pal.frameDark);
  // Front steer-wheel fenders
  for (const sx of [-1, 1]) {
    trAcc.box(sx * 1.04, frontAxleY, 1.12, 0.22, 0.52, 0.04, pal.frameDark, pal.frameDark);
  }
  // Iconic offset high-visibility Terminal Tractor Cab (left-biased x in [-1.18, +0.48], y in [+5.12, +7.18], z in [1.05, 3.06])
  trAcc.bevelBox(-0.35, 6.15, 1.55, 0.83, 1.02, 0.50, 0.08, pal.cabYellow, pal.cabYellowDark);
  // Cab roof & structural corner pillars around panoramic glazing
  trAcc.bevelBox(-0.35, 6.15, 2.98, 0.83, 1.02, 0.08, 0.08, pal.cabWhite, cShade(pal.cabWhite, 0.86));
  for (const sx of [-1.12, +0.42]) {
    for (const sy of [5.20, 7.10]) {
      trAcc.box(sx, sy, 2.48, 0.06, 0.06, 0.44, pal.cabYellow, pal.cabYellowDark);
    }
  }
  // Right-side elevated rear work deck, access stairs, fuel tank & vertical exhaust stack
  trAcc.box(+0.86, 5.70, 1.02, 0.36, 0.92, 0.06, pal.steelMid, pal.frameDark);
  trAcc.cylinder(+0.98, 4.95, 0.62, 0.24, 1.10, 12, pal.steelMid, "y"); // saddle fuel tank
  trAcc.cylinder(+0.58, 5.20, 2.35, 0.08, 2.50, 10, pal.chrome, "z"); // vertical exhaust stack
  // Autonomous roof LiDAR sensor mast + amber beacon base
  trAcc.box(-0.35, 6.72, 3.12, 0.24, 0.22, 0.06, pal.steelDark, pal.steelDark);
  trAcc.cylinder(-0.35, 6.72, 3.24, 0.08, 0.16, 12, pal.frameDark, "z");
  // Hydraulic elevating fifth-wheel boom & JOST coupler skid plate at (0, kingpinY, 0.96)
  trAcc.bevelBox(0, kingpinY, 0.96, 0.58, 0.62, 0.08, 0.08, pal.steelMid, pal.frameDark);
  for (const sx of [-0.42, +0.42]) {
    trAcc.tube([sx, kingpinY + 1.55, 0.84], [sx, kingpinY, 0.94], 0.08, 0.08, 6, pal.frameDark, pal.frameDark);
  }
  // Coiled red/blue pneumatic glad-hand brake hoses behind cab
  trAcc.tube([-0.22, 5.10, 1.65], [-0.22, 4.72, 1.25], 0.028, 0.028, 6, pal.red, pal.red);
  trAcc.tube([+0.02, 5.10, 1.65], [+0.02, 4.72, 1.25], 0.028, 0.028, 6, pal.blue, pal.blue);

  const tractorMat = makeDeployablePbrMaterial(t, { roughness: 0.46, metalness: 0.38, csmState });
  const tractorMesh = new t.Mesh(trAcc.toBufferGeometry(t), tractorMat);
  tractorMesh.name = "shuttle-tractor-body-mesh";
  tractorMesh.castShadow = true;
  tractorMesh.receiveShadow = true;
  root.add(tractorMesh);

  // =========================================================================
  // DC 2: Glazed Panoramic Cab Windows
  // =========================================================================
  const glassAcc = new GeomAcc(3);
  const gCol = [0.64, 0.84, 0.95];
  glassAcc.box(-0.35, 6.15, 2.48, 0.81, 0.99, 0.42, gCol, gCol);
  const cabGlassMat = new t.MeshStandardMaterial({
    color: 0xaad8f2,
    vertexColors: true,
    roughness: 0.14,
    metalness: 0.68,
    transparent: true,
    opacity: 0.52,
  });
  cabGlassMat.userData.__vfxSetKey = "port-glass";
  if (csmState) installCsmShaderPatch(cabGlassMat, csmState);
  const cabGlassMesh = new t.Mesh(glassAcc.toBufferGeometry(t), cabGlassMat);
  cabGlassMesh.name = "shuttle-cab-glass-mesh";
  root.add(cabGlassMesh);

  // =========================================================================
  // DC 3, 4, 5: Steerable Front Left/Right Wheels + Tractor Drive Dual Axle
  // =========================================================================
  const wheelMat = makeDeployablePbrMaterial(t, { roughness: 0.78, metalness: 0.18, csmState });

  const frontLeftSteerPivot = new t.Group();
  frontLeftSteerPivot.name = "shuttle-front-left-steer";
  frontLeftSteerPivot.position.set(-1.06, frontAxleY, wheelR);
  root.add(frontLeftSteerPivot);
  const frontLeftWheel = new t.Mesh(buildSteerWheelGeom(t, -1, wheelR, pal), wheelMat);
  frontLeftWheel.name = "shuttle-front-left-wheel";
  frontLeftWheel.castShadow = true;
  frontLeftWheel.receiveShadow = true;
  frontLeftSteerPivot.add(frontLeftWheel);

  const frontRightSteerPivot = new t.Group();
  frontRightSteerPivot.name = "shuttle-front-right-steer";
  frontRightSteerPivot.position.set(+1.06, frontAxleY, wheelR);
  root.add(frontRightSteerPivot);
  const frontRightWheel = new t.Mesh(buildSteerWheelGeom(t, +1, wheelR, pal), wheelMat);
  frontRightWheel.name = "shuttle-front-right-wheel";
  frontRightWheel.castShadow = true;
  frontRightWheel.receiveShadow = true;
  frontRightSteerPivot.add(frontRightWheel);

  const driveAxleGroup = new t.Group();
  driveAxleGroup.name = "shuttle-drive-axle";
  driveAxleGroup.position.set(0, kingpinY, wheelR);
  root.add(driveAxleGroup);
  const driveAxleMesh = new t.Mesh(buildDualAxleGeom(t, wheelR, pal), wheelMat);
  driveAxleMesh.name = "shuttle-drive-axle-mesh";
  driveAxleMesh.castShadow = true;
  driveAxleMesh.receiveShadow = true;
  driveAxleGroup.add(driveAxleMesh);

  // =========================================================================
  // DC 6 & DC 7: Articulated Skeletal 40ft/20ft Container Chassis + Tandem Bogie Wheels
  //              Pivots at fifth-wheel (0, kingpinY, 0); bolster top strictly at deckZ = 1.32 m!
  // =========================================================================
  const trailerPivot = new t.Group();
  trailerPivot.name = "shuttle-trailer-pivot";
  trailerPivot.position.set(0, kingpinY, 0);
  root.add(trailerPivot);

  const chAcc = new GeomAcc(3);
  const chLocalCenterY = chassisCenterY - kingpinY; // -4.75 m
  const chHalfL = S.chassisLengthM * 0.5; // 6.20 m -> local Y in [-10.95, +1.45] (world [-7.60, +4.80])
  const railZ = deckZ - 0.19; // 1.13 m

  // Twin skeletal I-beam main rails + light outer side rails
  for (const sx of [-0.50, +0.50]) {
    chAcc.box(sx, chLocalCenterY, railZ, 0.06, chHalfL - 0.15, 0.14, pal.frameDark, cShade(pal.frameDark, 0.8));
    chAcc.box(sx, chLocalCenterY, deckZ - 0.06, 0.10, chHalfL - 0.15, 0.02, pal.steelDark, pal.frameDark);
  }
  for (const sx of [-1.14, +1.14]) {
    chAcc.box(sx, chLocalCenterY, deckZ - 0.14, 0.035, chHalfL - 0.45, 0.06, pal.frameDark, pal.frameDark);
    // Yellow/white DOT side conspicuity tape blocks
    for (let cy = chLocalCenterY - 5.2; cy <= chLocalCenterY + 5.2; cy += 1.6) {
      chAcc.box(sx + Math.sign(sx) * 0.038, cy, deckZ - 0.14, 0.006, 0.36, 0.035, pal.cabYellow, pal.cabYellow);
    }
  }
  // Cross-members along length
  for (let cy = chLocalCenterY - 5.4; cy <= chLocalCenterY + 5.4; cy += 1.35) {
    chAcc.box(0, cy, railZ + 0.02, 0.58, 0.05, 0.09, pal.frameDark, pal.frameDark);
  }
  // 4 Container Twistlock Bolsters (40ft ends + 20ft mid positions), top strictly at deckZ = 1.32 m!
  const bolsterLocalYs = [
    chLocalCenterY + 5.9925,
    chLocalCenterY + 2.9265,
    chLocalCenterY - 2.9265,
    chLocalCenterY - 5.9925,
  ];
  for (const by of bolsterLocalYs) {
    chAcc.box(0, by, deckZ - 0.10, 1.24, 0.11, 0.10, pal.steelDark, pal.frameDark);
    for (const sx of [-1.1295, +1.1295]) {
      chAcc.box(sx, by, deckZ - 0.025, 0.09, 0.09, 0.025, pal.cabYellow, pal.cabYellowDark);
      chAcc.cylinder(sx, by, deckZ + 0.025, 0.032, 0.05, 8, pal.cabYellow, "z");
    }
  }
  // Upper coupler kingpin plate + retracted landing gear legs
  chAcc.box(0, 0, 0.99, 0.65, 0.78, 0.025, pal.steelMid, pal.frameDark);
  for (const sx of [-0.62, +0.62]) {
    chAcc.box(sx, chLocalCenterY + 3.4, 0.78, 0.06, 0.06, 0.28, pal.steelMid, pal.frameDark);
    chAcc.box(sx, chLocalCenterY + 3.4, 0.48, 0.14, 0.16, 0.025, pal.steelDark, pal.frameDark);
  }
  // Rear ICC underride bumper & mudflaps
  const rearEndY = chLocalCenterY - chHalfL; // -10.95 m
  chAcc.box(0, rearEndY + 0.08, 0.54, 1.20, 0.06, 0.07, pal.frameDark, pal.frameDark);
  chAcc.box(0, rearEndY + 0.05, deckZ - 0.18, 1.22, 0.05, 0.08, pal.frameDark, pal.frameDark);
  for (const sx of [-0.88, +0.88]) {
    chAcc.box(sx, rearEndY + 0.08, 0.84, 0.05, 0.05, 0.28, pal.frameDark, pal.frameDark);
    chAcc.box(sx, rearEndY + 0.45, 0.36, 0.28, 0.015, 0.26, pal.rubber, pal.rubber);
  }

  const chassisMat = makeDeployablePbrMaterial(t, { roughness: 0.54, metalness: 0.48, csmState });
  const chassisMesh = new t.Mesh(chAcc.toBufferGeometry(t), chassisMat);
  chassisMesh.name = "shuttle-chassis-frame-mesh";
  chassisMesh.castShadow = true;
  chassisMesh.receiveShadow = true;
  trailerPivot.add(chassisMesh);

  // Tandem trailer dual-wheel axles rendered in 1 single InstancedMesh (count = 2)
  const tandemAxleLocalYs = [chLocalCenterY - 4.05, chLocalCenterY - 5.36]; // world -5.45 & -6.76
  const trailerBogieInst = new t.InstancedMesh(buildDualAxleGeom(t, wheelR, pal), wheelMat, 2);
  trailerBogieInst.name = "shuttle-trailer-bogie-mesh";
  trailerBogieInst.castShadow = true;
  trailerBogieInst.receiveShadow = true;
  trailerBogieInst.frustumCulled = false;
  trailerPivot.add(trailerBogieInst);

  // Cargo Mount atop chassis bolsters at exact deckZ = 1.32 m!
  const cargoMount = new t.Group();
  cargoMount.name = "shuttle-cargo-mount";
  cargoMount.position.set(0, chLocalCenterY, deckZ);
  trailerPivot.add(cargoMount);

  // =========================================================================
  // DC 8: Emissive Headlights, Rear Tail Lamps, Side Markers & Roof Amber Hazard Beacon (0 lights!)
  // =========================================================================
  const lampAcc = new GeomAcc(3);
  // Front headlights on tractor bumper (flush at y_max = +7.60)
  for (const sx of [-0.88, +0.88]) {
    lampAcc.box(sx, 7.59, 0.72, 0.14, 0.010, 0.08, pal.lampHead, pal.lampHead);
  }
  // Roof amber hazard warning beacon dome (z = 3.06..3.30) + autonomous status cyan bar
  lampAcc.cylinder(-0.35, 5.55, 3.18, 0.11, 0.22, 12, pal.lampAmber, "z");
  lampAcc.box(-0.35, 7.18, 2.98, 0.56, 0.03, 0.05, pal.lampCyan, pal.lampCyan);
  // Tractor rear work-lamp bar
  lampAcc.box(-0.35, 5.10, 2.94, 0.44, 0.03, 0.06, pal.lampHead, pal.lampHead);
  // Rear ruby brake/tail lights at chassis tail (flush at y_min = -7.60)
  for (const sx of [-0.94, +0.94]) {
    lampAcc.box(sx, chassisCenterY - chHalfL + 0.012, deckZ - 0.18, 0.16, 0.012, 0.06, pal.lampRuby, pal.lampRuby);
  }

  const lampsMat = makeLampsMaterial(t, { emissiveIntensity: 1.05, roughness: 0.24 });
  lampsMat.userData.__vfxSetKey = "lamps";
  if (csmState) installCsmShaderPatch(lampsMat, csmState);
  const lampsMesh = new t.Mesh(lampAcc.toBufferGeometry(t), lampsMat);
  lampsMesh.name = "shuttle-lamps-mesh";
  root.add(lampsMesh);

  // =========================================================================
  // Dynamic State & Zero-Alloc Articulation Update
  // =========================================================================
  const _m = new t.Matrix4();
  const _p = new t.Vector3();
  const _q = new t.Quaternion();
  const _s = new t.Vector3(1, 1, 1);
  const _e = new t.Euler(0, 0, 0, "XYZ");

  let curWheelSpin = 0.0;
  let curSteerAngle = 0.0;
  let curArticulation = 0.0;
  let curHeading = 0.0;
  let curPitch = 0.0;
  let mountedCargoKey = null;
  let mountedCargo = null;

  function syncWheelsAndChassis() {
    frontLeftSteerPivot.rotation.set(0, 0, -curSteerAngle);
    frontRightSteerPivot.rotation.set(0, 0, -curSteerAngle);
    frontLeftWheel.rotation.set(-curWheelSpin, 0, 0);
    frontRightWheel.rotation.set(-curWheelSpin, 0, 0);
    driveAxleGroup.rotation.set(-curWheelSpin, 0, 0);

    trailerPivot.rotation.set(0, 0, curArticulation);

    _e.set(-curWheelSpin, 0, 0);
    _q.setFromEuler(_e);
    for (let i = 0; i < 2; i++) {
      _p.set(0, tandemAxleLocalYs[i], wheelR);
      _m.compose(_p, _q, _s);
      trailerBogieInst.setMatrixAt(i, _m);
    }
    trailerBogieInst.instanceMatrix.needsUpdate = true;
  }

  function syncCargo(cargo) {
    if (!cargo) {
      if (mountedCargo) {
        if (mountedCargo.mesh.parent === cargoMount) cargoMount.remove(mountedCargo.mesh);
        mountedCargo.dispose();
        mountedCargo = null;
        mountedCargoKey = null;
      }
      return;
    }
    const spec = resolvePortContainerSpec(cargo.wcid ?? cargo.kind ?? cargo.containerKind ?? cargo.sizeFt ?? "40ft");
    const livHex = resolvePortLiveryHex(cargo.livery ?? cargo.liveryId ?? cargo.liveryKey ?? 0);
    const key = `${spec.wcid}:${livHex}:${cargo.reefer ? 1 : 0}`;
    if (mountedCargoKey === key && mountedCargo) return;

    if (mountedCargo) {
      if (mountedCargo.mesh.parent === cargoMount) cargoMount.remove(mountedCargo.mesh);
      mountedCargo.dispose();
      mountedCargo = null;
    }
    mountedCargo = buildCompactIsoContainer(
      t,
      { wcid: spec.wcid, livery: cargo.livery ?? cargo.liveryId ?? 0, reefer: cargo.reefer },
      { csmState }
    );
    // Container sits aligned along chassis Y (doors at -Y rear, bottom flush on deckZ = 1.32 m!)
    mountedCargo.mesh.rotation.set(0, 0, 0);
    mountedCargo.mesh.position.set(0, 0, 0);
    cargoMount.add(mountedCargo.mesh);
    mountedCargoKey = key;
  }

  function update(state = null) {
    if (state && typeof state === "object") {
      if (Number.isFinite(state.x)) root.position.x = state.x;
      if (Number.isFinite(state.y)) root.position.y = state.y;
      if (Number.isFinite(state.z)) root.position.z = state.z;
      if (Number.isFinite(state.heading)) {
        curHeading = state.heading;
        root.rotation.z = -curHeading;
      }
      if (Number.isFinite(state.pitch)) {
        curPitch = state.pitch;
        root.rotation.x = curPitch;
      }
      if (Number.isFinite(state.wheelSpin)) curWheelSpin = state.wheelSpin;
      if (Number.isFinite(state.steerAngle)) {
        curSteerAngle = clamp(state.steerAngle, -S.maxSteerRad, S.maxSteerRad);
        if (!Number.isFinite(state.articulationAngle)) {
          curArticulation = clamp(curSteerAngle * 0.22, -0.25, 0.25);
        }
      }
      if (Number.isFinite(state.articulationAngle)) {
        curArticulation = clamp(state.articulationAngle, -0.55, 0.55);
      }
      if (state.cargo !== undefined) {
        syncCargo(state.cargo);
      }
      if (Number.isFinite(state.timeSec) || Number.isFinite(state.speed)) {
        const tSec = Number.isFinite(state.timeSec) ? state.timeSec : 0;
        const moving = Number.isFinite(state.speed) && Math.abs(state.speed) > 0.1;
        lampsMat.emissiveIntensity = moving ? (1.25 + 0.55 * Math.sin(tSec * 7.5)) : 0.95;
      }
    }
    syncWheelsAndChassis();
  }

  update(opts.initialState || { cargo: opts.cargo });

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    syncCargo(null);
    disposeObjectTree(root);
  }

  return {
    root,
    wcid: S.wcid,
    kind: S.kind,
    deckZ,
    maxDrawCalls: S.maxDrawCalls,
    tractorMesh,
    cabGlassMesh,
    frontLeftSteerPivot,
    frontRightSteerPivot,
    frontLeftWheel,
    frontRightWheel,
    driveAxleGroup,
    trailerPivot,
    chassisMesh,
    trailerBogieInst,
    cargoMount,
    lampsMesh,
    lampsMat,
    get heading() { return curHeading; },
    get pitch() { return curPitch; },
    get wheelSpin() { return curWheelSpin; },
    get steerAngle() { return curSteerAngle; },
    get articulationAngle() { return curArticulation; },
    get mountedCargo() { return mountedCargo; },
    update,
    dispose,
  };
}
