// scene3d/vehicle/agf_forklift_model.js — Container-Capable 3-Stage Autonomous Guided Forklift (`WCID 4000041`).
//
// Millimeter-locked to AGF_SPECS & computeMastStages():
//   - Overall width 1.140 m (< 2.340 m container door), collapsed mast 2.160 m (< 2.280 m door),
//     overhead sensor canopy 2.120 m, 3-stage freelift mast reaching 7.250 m
//   - Twin beveled forks: 0.120 x 0.045 x 1.150 m at x = ±0.2625 m (0.645 m blade outer span,
//     0.685 m backrest spread), side-shift ±0.100 m, mast tilt -3 deg / +5 deg
//   - Rear-steer axle ±82 deg (1.43117 rad), spinning 360 deg LiDAR, safety scanner visors,
//     E-stops, status LED strips/strobe, and floor blue-spot chevron
//
// Strict GPU budget: 10 draw calls unloaded (<= 10), 0 THREE.Light instances,
// AGX HDR PBR MeshStandardMaterial + 3-cascade CSM shader patching, Z-up AC coordinates (+Y forward, +X right).

import * as THREE_DEFAULT from "three";
import { installCsmShaderPatch } from "../materials.js";
import {
  GeomAcc,
  makeLinearPalette,
  cShade,
  makeDeployablePbrMaterial,
  makeLampsMaterial,
  buildDeployable,
  buildPallet,
} from "./deployable_models.js";
import { buildDeployedRadar } from "./radar_model.js";
import { AGF_SPECS } from "./warehouse_specs.js";
import { computeMastStages } from "./warehouse_kinematics.js";

export const manifest = Object.freeze({
  id: "vfx-agf-forklift-model",
  channel: "vehicleModel",
  deterministic: true,
  lightCountDelta: 0,
  cacheKeyScope: "set",
  reads: Object.freeze(["geometry", "serverPose", "clock"]),
  writes: Object.freeze(["renderTransform", "partTransform", "materialUniform"]),
});

const DECK_UNDERSIDE_Z = 0.123;

const STATUS_COLORS = Object.freeze({
  idle: 0xffa010,
  transit: 0x22ee66,
  docking: 0x22d8ff,
  lifting: 0xffb018,
  blocked: 0xff2820,
});

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function mountStowedCargo(t, wcid, csmState) {
  if (wcid === 4000002) {
    return buildDeployedRadar(t, { stowed: true, csmState });
  }
  if (wcid >= 4000010 && wcid <= 4000017) {
    return buildDeployable(t, wcid, { stowed: true, csmState });
  }
  return buildPallet(t, "standard", { stowed: true, csmState });
}

export function buildAgfForklift(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const opts = options && typeof options === "object" ? options : {};
  const csmState = opts.csmState;
  const S = AGF_SPECS;

  const pal = makeLinearPalette(t, {
    orange: opts.bodyHex ?? 0xe85a10,
    orangeDark: 0xb64208,
    charcoal: 0x262a30,
    steel: 0x454c56,
    chrome: 0xd4dae0,
    tire: 0x191b1e,
    hub: 0x5c636d,
    yellow: 0xf0b20c,
    red: 0xd62828,
    visor: 0x0c131c,
    white: 0xffffff,
    blueSpot: 0x2288ff,
  });

  const root = new t.Group();
  root.name = "agf-forklift-root";
  root.userData = { wcid: S.wcid, kind: S.kind, agfForklift: true };

  // ---- 1. Counterweight Chassis, Hazard Bumper, Scanners, E-Stops & ROPS Sensor Arch (DC 1) ----
  const chAcc = new GeomAcc(3);
  // Lower dark steel frame skirt (x in [-0.55, +0.55], y in [-1.90, +0.15], z in [0.11, 0.42])
  chAcc.bevelBox(0, -0.875, 0.265, 0.545, 1.025, 0.155, 0.08, pal.charcoal, cShade(pal.charcoal, 0.78));
  // Front axle housing & drive wheel fenders (x in [-0.570, +0.570])
  chAcc.box(0, 0.000, 0.240, 0.340, 0.140, 0.120, pal.charcoal, cShade(pal.charcoal, 0.78));
  chAcc.box(-0.460, 0.000, 0.515, 0.110, 0.240, 0.025, pal.charcoal, cShade(pal.charcoal, 0.8));
  chAcc.box(+0.460, 0.000, 0.515, 0.110, 0.240, 0.025, pal.charcoal, cShade(pal.charcoal, 0.8));

  // Main safety-orange sculpted counterweight & side cowls (y in [-1.930, +0.100])
  chAcc.bevelBox(0, -1.040, 0.660, 0.570, 0.890, 0.260, 0.16, pal.orange, pal.orangeDark);
  // Upper rear counterweight deck & cowl (y in [-1.90, -0.95], z in [0.92, 1.18])
  chAcc.bevelBox(0, -1.420, 1.050, 0.540, 0.460, 0.130, 0.14, pal.orange, pal.orangeDark);
  // Central AGV battery / electronics bay console (no operator seat — autonomous unit)
  chAcc.bevelBox(0, -0.720, 1.060, 0.420, 0.440, 0.140, 0.06, pal.charcoal, cShade(pal.charcoal, 0.82));
  // Front sloped mast-apron cowl
  chAcc.box(0, -0.060, 0.660, 0.440, 0.200, 0.240, pal.orange, pal.orangeDark);

  // Rear radiator ventilation louvers
  for (let i = 0; i < 4; i++) {
    chAcc.box(0, -1.915, 0.62 + i * 0.08, 0.34, 0.014, 0.022, pal.charcoal, pal.charcoal);
  }
  // Rear towing pin housing
  chAcc.box(0, -1.895, 0.36, 0.07, 0.032, 0.07, pal.steel, pal.charcoal);
  chAcc.cylinder(0, -1.900, 0.38, 0.016, 0.11, 8, pal.chrome, "z");

  // Rear black/yellow hazard bumper striping
  for (let i = -3; i <= 3; i++) {
    const col = Math.abs(i) % 2 === 0 ? pal.yellow : pal.charcoal;
    chAcc.box(i * 0.12, -1.912, 0.22, 0.058, 0.018, 0.045, col, cShade(col, 0.85));
  }

  // Recessed front & rear 2D safety laser scanner windows
  chAcc.box(0, +0.136, 0.24, 0.15, 0.014, 0.055, pal.visor, pal.visor);
  chAcc.box(0, -1.916, 0.34, 0.15, 0.014, 0.055, pal.visor, pal.visor);

  // Twin side E-stop mushroom buttons (recessed within ±0.570 m envelope)
  for (const sx of [-1, 1]) {
    chAcc.box(sx * 0.556, -0.82, 0.88, 0.010, 0.050, 0.050, pal.yellow, pal.yellow);
    chAcc.cylinder(sx * 0.562, -0.82, 0.88, 0.022, 0.014, 10, pal.red, "x");
  }

  // Overhead ROPS protective canopy & sensor arch (top at z = 2.055 <= 2.120 m)
  for (const sx of [-1, 1]) {
    chAcc.box(sx * 0.43, -0.32, 1.46, 0.032, 0.036, 0.56, pal.charcoal, cShade(pal.charcoal, 0.8));
    chAcc.box(sx * 0.43, -1.32, 1.56, 0.032, 0.036, 0.46, pal.charcoal, cShade(pal.charcoal, 0.8));
    chAcc.box(sx * 0.43, -0.82, 2.01, 0.036, 0.54, 0.032, pal.charcoal, cShade(pal.charcoal, 0.8));
  }
  for (let ry = -1.26; ry <= -0.38; ry += 0.22) {
    chAcc.box(0, ry, 2.025, 0.43, 0.020, 0.020, pal.steel, pal.charcoal);
  }
  chAcc.bevelBox(0, -0.58, 2.035, 0.28, 0.18, 0.020, 0.03, pal.charcoal, pal.steel);

  const chMat = makeDeployablePbrMaterial(t, { roughness: 0.46, metalness: 0.42, csmState });
  const chMesh = new t.Mesh(chAcc.toBufferGeometry(t), chMat);
  chMesh.name = "agf-chassis-mesh";
  chMesh.castShadow = true;
  chMesh.receiveShadow = true;
  root.add(chMesh);

  // ---- 2. Front Drive Wheels (DC 2) ----
  const frontAxleGroup = new t.Group();
  frontAxleGroup.name = "agf-front-axle";
  frontAxleGroup.position.set(0, S.frontAxleY, S.frontWheelRadiusM);
  root.add(frontAxleGroup);

  const fwAcc = new GeomAcc(3);
  for (const sx of [-1, 1]) {
    const wx = sx * 0.465;
    fwAcc.cylinder(wx, 0, 0, S.frontWheelRadiusM, 0.20, 18, pal.tire, "x");
    fwAcc.cylinder(wx, 0, 0, S.frontWheelRadiusM * 0.56, 0.204, 14, pal.hub, "x");
    fwAcc.cylinder(wx + sx * 0.092, 0, 0, 0.060, 0.020, 10, pal.steel, "x");
  }
  const fwMat = makeDeployablePbrMaterial(t, { roughness: 0.72, metalness: 0.18, csmState });
  const fwMesh = new t.Mesh(fwAcc.toBufferGeometry(t), fwMat);
  fwMesh.name = "agf-front-wheels-mesh";
  fwMesh.castShadow = true;
  fwMesh.receiveShadow = true;
  frontAxleGroup.add(fwMesh);

  // ---- 3. Steerable Rear Axle + Rear Wheels (DC 3) ----
  const rearSteerPivot = new t.Group();
  rearSteerPivot.name = "agf-rear-steer-pivot";
  rearSteerPivot.position.set(0, S.rearAxleY, 0);
  root.add(rearSteerPivot);

  const rearWheelSpinGroup = new t.Group();
  rearWheelSpinGroup.name = "agf-rear-wheel-spin";
  rearWheelSpinGroup.position.set(0, 0, S.rearWheelRadiusM);
  rearSteerPivot.add(rearWheelSpinGroup);

  const rwAcc = new GeomAcc(3);
  rwAcc.cylinder(0, 0, 0.09, 0.065, 0.14, 12, pal.steel, "z");
  for (const sx of [-1, 1]) {
    const wx = sx * 0.140;
    rwAcc.cylinder(wx, 0, 0, S.rearWheelRadiusM, 0.135, 16, pal.tire, "x");
    rwAcc.cylinder(wx, 0, 0, S.rearWheelRadiusM * 0.55, 0.140, 12, pal.hub, "x");
  }
  const rwMat = makeDeployablePbrMaterial(t, { roughness: 0.72, metalness: 0.18, csmState });
  const rwMesh = new t.Mesh(rwAcc.toBufferGeometry(t), rwMat);
  rwMesh.name = "agf-rear-wheels-mesh";
  rwMesh.castShadow = true;
  rwMesh.receiveShadow = true;
  rearWheelSpinGroup.add(rwMesh);

  // ---- 4. Mast Tilt Pivot + Outer Fixed 2.16 m Mast (DC 4) ----
  const mastTiltGroup = new t.Group();
  mastTiltGroup.name = "agf-mast-tilt-pivot";
  mastTiltGroup.position.set(0, 0.080, 0.100);
  root.add(mastTiltGroup);

  const mOuterAcc = new GeomAcc(3);
  for (const sx of [-1, 1]) {
    // Outer C-channels: z_local in [0.000, 2.060] -> z_root in [0.100, 2.160]
    mOuterAcc.box(sx * 0.340, 0.0, 1.030, 0.036, 0.055, 1.030, pal.charcoal, cShade(pal.charcoal, 0.8));
    // Twin outer hydraulic lift cylinder barrels
    mOuterAcc.cylinder(sx * 0.285, -0.045, 0.960, 0.028, 1.820, 10, pal.steel, "z");
  }
  // Cross ties & central freelift cylinder barrel
  for (const tz of [0.12, 1.05, 2.00]) {
    mOuterAcc.box(0, -0.02, tz, 0.32, 0.032, 0.036, pal.charcoal, cShade(pal.charcoal, 0.8));
  }
  mOuterAcc.cylinder(0, -0.035, 0.950, 0.034, 1.780, 12, pal.steel, "z");

  const mastOuterMat = makeDeployablePbrMaterial(t, { roughness: 0.45, metalness: 0.58, csmState });
  const mastOuterMesh = new t.Mesh(mOuterAcc.toBufferGeometry(t), mastOuterMat);
  mastOuterMesh.name = "agf-mast-outer-mesh";
  mastOuterMesh.castShadow = true;
  mastOuterMesh.receiveShadow = true;
  mastTiltGroup.add(mastOuterMesh);

  // ---- 5. Mast Stage 2 Intermediate Telescoping Rails + Lift Rams (DC 5) ----
  const stage2Group = new t.Group();
  stage2Group.name = "agf-mast-stage2";
  mastTiltGroup.add(stage2Group);

  const m2Acc = new GeomAcc(3);
  for (const sx of [-1, 1]) {
    m2Acc.box(sx * 0.275, 0.008, 1.030, 0.026, 0.044, 1.010, pal.steel, cShade(pal.steel, 0.82));
    // Twin chrome lift ram rods
    m2Acc.cylinder(sx * 0.285, -0.045, 1.020, 0.018, 1.800, 10, pal.chrome, "z");
  }
  m2Acc.box(0, 0.0, 1.99, 0.26, 0.028, 0.030, pal.steel, pal.charcoal);

  const mast2Mat = makeDeployablePbrMaterial(t, { roughness: 0.34, metalness: 0.72, csmState });
  const mast2Mesh = new t.Mesh(m2Acc.toBufferGeometry(t), mast2Mat);
  mast2Mesh.name = "agf-mast-stage2-mesh";
  mast2Mesh.castShadow = true;
  mast2Mesh.receiveShadow = true;
  stage2Group.add(mast2Mesh);

  // ---- 6. Mast Stage 3 Inner Telescoping Rails, Roller Chain & Freelift Ram (DC 6) ----
  const stage3Group = new t.Group();
  stage3Group.name = "agf-mast-stage3";
  mastTiltGroup.add(stage3Group);

  const m3Acc = new GeomAcc(3);
  for (const sx of [-1, 1]) {
    m3Acc.box(sx * 0.215, 0.014, 1.040, 0.022, 0.036, 1.000, pal.charcoal, cShade(pal.charcoal, 0.85));
    // Roller chain bars & top sheaves
    m3Acc.box(sx * 0.125, -0.015, 1.040, 0.010, 0.012, 0.960, pal.steel, pal.charcoal);
    m3Acc.cylinder(sx * 0.125, -0.015, 2.010, 0.036, 0.026, 12, pal.steel, "x");
  }
  m3Acc.cylinder(0, -0.035, 1.020, 0.020, 1.800, 10, pal.chrome, "z");
  m3Acc.box(0, 0.0, 2.00, 0.20, 0.026, 0.028, pal.charcoal, pal.steel);

  const mast3Mat = makeDeployablePbrMaterial(t, { roughness: 0.36, metalness: 0.68, csmState });
  const mast3Mesh = new t.Mesh(m3Acc.toBufferGeometry(t), mast3Mat);
  mast3Mesh.name = "agf-mast-stage3-mesh";
  mast3Mesh.castShadow = true;
  mast3Mesh.receiveShadow = true;
  stage3Group.add(mast3Mesh);

  // ---- 7. Side-Shifting Carriage, Load Backrest & Twin Beveled Forks + cargoMount (DC 7) ----
  const carriageGroup = new t.Group();
  carriageGroup.name = "agf-carriage";
  mastTiltGroup.add(carriageGroup);

  const sideShiftGroup = new t.Group();
  sideShiftGroup.name = "agf-side-shift";
  carriageGroup.add(sideShiftGroup);

  const forkAcc = new GeomAcc(3);
  // Carriage crossbars & load backrest guard (0.685 m spread, backrest top at z_local = 0.440)
  forkAcc.box(0, 0.044, 0.055, S.forkSpread * 0.5, 0.024, 0.045, pal.charcoal, cShade(pal.charcoal, 0.8));
  forkAcc.box(0, 0.044, 0.215, S.forkSpread * 0.5, 0.022, 0.030, pal.charcoal, cShade(pal.charcoal, 0.8));
  forkAcc.box(0, 0.044, 0.425, S.forkSpread * 0.5, 0.018, 0.015, pal.orange, pal.orangeDark);
  for (const bx of [-0.325, -0.16, 0.0, +0.16, +0.325]) {
    forkAcc.box(bx, 0.044, 0.220, 0.016, 0.018, 0.215, pal.charcoal, cShade(pal.charcoal, 0.8));
  }

  // Twin beveled forks:
  //   x = ±0.2625 m, width = 0.120 m (outer span 0.645 m),
  //   y_local in [+0.070, +1.220] -> y_root in [+0.150, +1.300] (length 1.150 m),
  //   top strictly at z_local = 0.000, bottom at z_local = -0.045 (thickness 0.045 m)
  const fkThick = S.forkThicknessM; // 0.045
  for (const sx of [-1, 1]) {
    const cx = sx * S.forkCenterX;
    // Vertical fork shank (y_local in [0.024, 0.069], z_local in [-0.045, +0.26])
    // Kept strictly behind mounted ISO 6780 pallet heel (y_local >= 0.070)
    forkAcc.box(cx, 0.0465, 0.1075, S.forkWidthM * 0.5, 0.0225, 0.1525, pal.steel, pal.charcoal);
    // Main fork blade (y_local in [0.069, 1.120], top at z = 0)
    forkAcc.box(cx, 0.5945, -fkThick * 0.5, S.forkWidthM * 0.5, 0.5255, fkThick * 0.5, pal.steel, pal.charcoal);
    // Beveled fork tip (y_local in [1.120, 1.220], tapered top/bottom keeping max Z <= 0, max Y = 1.220)
    forkAcc.loft(
      [
        {
          pts: [
            [cx - S.forkWidthM * 0.5, 1.120, -fkThick],
            [cx + S.forkWidthM * 0.5, 1.120, -fkThick],
            [cx + S.forkWidthM * 0.5, 1.120, 0.0],
            [cx - S.forkWidthM * 0.5, 1.120, 0.0],
          ],
          cols: [pal.charcoal, pal.charcoal, pal.steel, pal.steel],
        },
        {
          pts: [
            [cx - S.forkWidthM * 0.44, 1.220, -fkThick * 0.72],
            [cx + S.forkWidthM * 0.44, 1.220, -fkThick * 0.72],
            [cx + S.forkWidthM * 0.44, 1.220, -fkThick * 0.28],
            [cx - S.forkWidthM * 0.44, 1.220, -fkThick * 0.28],
          ],
          cols: [pal.charcoal, pal.charcoal, pal.steel, pal.steel],
        },
      ],
      true
    );
    // Tip face cap
    forkAcc.quad(
      [cx - S.forkWidthM * 0.44, 1.220, -fkThick * 0.72],
      [cx + S.forkWidthM * 0.44, 1.220, -fkThick * 0.72],
      [cx + S.forkWidthM * 0.44, 1.220, -fkThick * 0.28],
      [cx - S.forkWidthM * 0.44, 1.220, -fkThick * 0.28],
      pal.charcoal, pal.charcoal, pal.steel, pal.steel
    );
  }

  const forksMat = makeDeployablePbrMaterial(t, { roughness: 0.44, metalness: 0.60, csmState });
  const forksMesh = new t.Mesh(forkAcc.toBufferGeometry(t), forksMat);
  forksMesh.name = "agf-carriage-forks-mesh";
  forksMesh.castShadow = true;
  forksMesh.receiveShadow = true;
  sideShiftGroup.add(forksMesh);

  const cargoMount = new t.Group();
  cargoMount.name = "agf-cargo-mount";
  cargoMount.position.set(0, S.cargoCenterY - 0.080, 0);
  sideShiftGroup.add(cargoMount);

  // ---- 8. Spinning 360-deg Overhead LiDAR Dome (DC 8) ----
  const lidarPivot = new t.Group();
  lidarPivot.name = "agf-lidar-pivot";
  lidarPivot.position.set(0, -0.58, 2.085); // top <= 2.120 m canopyHeightM
  root.add(lidarPivot);

  const lidAcc = new GeomAcc(3);
  lidAcc.cylinder(0, 0, -0.015, 0.056, 0.020, 14, pal.steel, "z");
  lidAcc.cylinder(0, 0, +0.008, 0.054, 0.026, 16, pal.visor, "z");
  lidAcc.cylinder(0, 0, +0.028, 0.052, 0.014, 14, pal.chrome, "z");
  lidAcc.box(0, +0.050, +0.008, 0.016, 0.010, 0.012, pal.yellow, pal.yellow);

  const lidMat = makeDeployablePbrMaterial(t, { roughness: 0.28, metalness: 0.65, csmState });
  const lidMesh = new t.Mesh(lidAcc.toBufferGeometry(t), lidMat);
  lidMesh.name = "agf-lidar-mesh";
  lidMesh.castShadow = true;
  lidMesh.receiveShadow = true;
  lidarPivot.add(lidMesh);

  // ---- 9. LED Status Strips, Head/Tail Markers & Strobe Beacon (DC 9) ----
  const lampAcc = new GeomAcc(3);
  // Roof strobe beacon (top at z = 2.118 <= 2.120 m)
  lampAcc.cylinder(0, -1.26, 2.085, 0.042, 0.064, 12, pal.white, "z");
  // Side flank LED status strips (recessed within ±0.570 m)
  for (const sx of [-1, 1]) {
    lampAcc.box(sx * 0.562, -0.95, 0.88, 0.006, 0.36, 0.022, pal.white, pal.white);
  }
  // Rear corner marker lamps
  for (const sx of [-1, 1]) {
    lampAcc.box(sx * 0.42, -1.916, 0.82, 0.06, 0.010, 0.028, pal.white, pal.white);
  }

  const lampsMat = makeLampsMaterial(t, { emissiveIntensity: 0.85, roughness: 0.25 });
  lampsMat.userData.__vfxSetKey = "lamps";
  if (csmState) installCsmShaderPatch(lampsMat, csmState);
  lampsMat.castShadow = true;
  lampsMat.receiveShadow = true;
  const lampsMesh = new t.Mesh(lampAcc.toBufferGeometry(t), lampsMat);
  lampsMesh.name = "agf-lamps-mesh";
  lampsMesh.castShadow = true;
  lampsMesh.receiveShadow = true;
  root.add(lampsMesh);

  // ---- 10. Floor Blue-Spot Safety Warning Chevron (DC 10, MeshBasicMaterial, 0 lights) ----
  const spotAcc = new GeomAcc(3);
  // Placed inside [-1.930, +1.300] Y footprint so root Box3 matches AGF_SPECS exactly
  const spotY = 1.05;
  const spotZ = 0.004;
  spotAcc.tri([0, spotY + 0.18, spotZ], [-0.14, spotY - 0.12, spotZ], [0, spotY - 0.02, spotZ], pal.blueSpot);
  spotAcc.tri([0, spotY + 0.18, spotZ], [0, spotY - 0.02, spotZ], [+0.14, spotY - 0.12, spotZ], pal.blueSpot);

  const spotMat = new t.MeshBasicMaterial({
    color: 0x2288ff,
    vertexColors: true,
    transparent: true,
    opacity: 0.52,
    depthWrite: false,
    side: t.DoubleSide,
  });
  const spotMesh = new t.Mesh(spotAcc.toBufferGeometry(t), spotMat);
  spotMesh.name = "agf-blue-spot-mesh";
  spotMesh.castShadow = false;
  spotMesh.receiveShadow = false;
  root.add(spotMesh);

  // ---- Dynamic State & Cargo Mounting ----
  let forkHeightM = S.forkMinZ;
  let sideShiftM = 0.0;
  let mastTiltRad = 0.0;
  let steerAngleRad = 0.0;
  let wheelSpinRad = 0.0;
  let lidarSpinRad = 0.0;
  let carriedWcid = 0;
  let statusMode = "idle";
  let supportSurfaceZ = 0.0;
  let mountedCargo = null;

  function setCarriedWcid(nextRaw) {
    const nextWcid = Number.isFinite(nextRaw) ? (nextRaw >>> 0) : 0;
    if (nextWcid === (mountedCargo?.wcid ?? 0) && nextWcid === carriedWcid) {
      return;
    }
    if (mountedCargo) {
      if (mountedCargo.model?.root && mountedCargo.model.root.parent === cargoMount) {
        cargoMount.remove(mountedCargo.model.root);
      }
      if (typeof mountedCargo.model?.dispose === "function") {
        mountedCargo.model.dispose();
      }
      mountedCargo = null;
    }
    carriedWcid = nextWcid;
    if (nextWcid === 0) return;

    const model = mountStowedCargo(t, nextWcid, csmState);
    if (model?.root) {
      model.root.position.set(0, 0, 0);
      model.root.rotation.set(0, 0, 0);
      cargoMount.add(model.root);
    }
    mountedCargo = { wcid: nextWcid, model };
  }

  function update(state = {}) {
    const s = state && typeof state === "object" ? state : {};

    if (Number.isFinite(s.forkHeightM)) {
      forkHeightM = clamp(s.forkHeightM, S.forkMinZ, S.forkMaxZ);
    }
    if (Number.isFinite(s.sideShiftM)) {
      sideShiftM = clamp(s.sideShiftM, -S.sideShiftMaxM, S.sideShiftMaxM);
    }
    if (Number.isFinite(s.mastTiltRad)) {
      mastTiltRad = clamp(s.mastTiltRad, S.mastTiltFwdRad, S.mastTiltBackRad);
    }
    if (Number.isFinite(s.steerAngleRad)) {
      steerAngleRad = clamp(s.steerAngleRad, -S.maxSteerRad, S.maxSteerRad);
    }
    if (Number.isFinite(s.wheelSpinRad)) {
      wheelSpinRad = s.wheelSpinRad;
    }
    if (Number.isFinite(s.lidarSpinRad)) {
      lidarSpinRad = s.lidarSpinRad;
    } else if (Number.isFinite(s.dt) && s.dt > 0) {
      lidarSpinRad = (lidarSpinRad + s.dt * Math.PI * 4.0) % (Math.PI * 2.0);
    }
    if (Number.isFinite(s.supportSurfaceZ)) {
      supportSurfaceZ = s.supportSurfaceZ;
    }
    if (typeof s.statusMode === "string" && STATUS_COLORS[s.statusMode] !== undefined) {
      statusMode = s.statusMode;
    }

    const stages = computeMastStages(forkHeightM);
    mastTiltGroup.rotation.x = mastTiltRad;
    stage2Group.position.z = stages.stage2Offset;
    stage3Group.position.z = stages.stage3Offset;
    carriageGroup.position.z = forkHeightM - 0.100;
    sideShiftGroup.position.x = sideShiftM;

    // Fork-tunnel threading: keeps pallet bottom >= supportSurfaceZ while lowering,
    // and seats pallet deck underside (0.123 m) flush onto fork blade top once raised
    cargoMount.position.set(
      0,
      S.cargoCenterY - 0.080,
      Math.max(-(forkHeightM - supportSurfaceZ), -DECK_UNDERSIDE_Z)
    );

    frontAxleGroup.rotation.x = -wheelSpinRad;
    rearSteerPivot.rotation.z = steerAngleRad;
    rearWheelSpinGroup.rotation.x = -wheelSpinRad * (S.frontWheelRadiusM / S.rearWheelRadiusM);
    lidarPivot.rotation.z = -lidarSpinRad;

    lampsMat.emissive.setHex(STATUS_COLORS[statusMode] ?? STATUS_COLORS.idle);

    if (s.carriedWcid !== undefined) {
      setCarriedWcid(s.carriedWcid);
    }
  }

  update({
    forkHeightM: opts.forkHeightM ?? S.forkMinZ,
    sideShiftM: opts.sideShiftM ?? 0,
    mastTiltRad: opts.mastTiltRad ?? 0,
    steerAngleRad: opts.steerAngleRad ?? 0,
    wheelSpinRad: opts.wheelSpinRad ?? 0,
    lidarSpinRad: opts.lidarSpinRad ?? 0,
    carriedWcid: opts.carriedWcid ?? 0,
    statusMode: opts.statusMode ?? "idle",
    supportSurfaceZ: opts.supportSurfaceZ ?? 0,
  });

  function dispose() {
    setCarriedWcid(0);
    const disposedG = new Set();
    const disposedM = new Set();
    root.traverse((o) => {
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
    });
  }

  return {
    root,
    mastTiltGroup,
    stage2Group,
    stage3Group,
    carriageGroup,
    sideShiftGroup,
    cargoMount,
    rearSteerPivot,
    lidarPivot,
    lampsMat,
    spec: S,
    wcid: S.wcid,
    maxDrawCalls: S.maxDrawCalls,
    get forkHeightM() { return forkHeightM; },
    get sideShiftM() { return sideShiftM; },
    get mastTiltRad() { return mastTiltRad; },
    get steerAngleRad() { return steerAngleRad; },
    get wheelSpinRad() { return wheelSpinRad; },
    get lidarSpinRad() { return lidarSpinRad; },
    get carriedWcid() { return carriedWcid; },
    get statusMode() { return statusMode; },
    get supportSurfaceZ() { return supportSurfaceZ; },
    get mountedCargo() { return mountedCargo; },
    update,
    dispose,
  };
}
