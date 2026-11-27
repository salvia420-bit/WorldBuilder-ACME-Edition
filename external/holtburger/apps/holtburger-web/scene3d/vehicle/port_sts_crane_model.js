// scene3d/vehicle/port_sts_crane_model.js — Articulated Ship-to-Shore (STS) Panamax/Feeder Gantry Crane.
//
// Dimensions locked to STS_CRANE_SPECS & port_kinematics.js:
//   - Rail gauge: 20.0 m (landside y = -10.0, waterside y = +10.0), root at [x, quayY - 14.5, 2.0]
//   - Portal clearance: 14.0 m (4 under-portal truck lanes pass clear), lift height: 26.0 m
//   - Hinged waterside boom: 0 deg operational <-> 80 deg stowed, 28.0 m outreach (+38 m local Y) / 16.0 m backreach (-26 m)
//   - Travelling trolley + glazed operator cab, 4-wire hoist reeving, telescoping 20ft/40ft ISO spreader
//     with corner flippers & rotating 0 <-> PI/2 twistlocks, emissive warning beacons.
//
// Strict GPU budget: <= 14 draw calls (12 DC unloaded, 13 DC carrying container),
// 0 dynamic THREE.Light instances (lightCountDelta === 0), AGX HDR PBR + 3-cascade CSM patching.

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
  STS_CRANE_SPECS,
  resolvePortContainerSpec,
} from "./port_specs.js";
import {
  buildCompactIsoContainer,
  resolvePortLiveryHex,
} from "./port_yard_crane_model.js";

export const manifest = Object.freeze({
  id: "vfx-port-sts-crane-model",
  channel: "vehicleModel",
  deterministic: true,
  lightCountDelta: 0,
  cacheKeyScope: "set",
  reads: Object.freeze(["geometry", "serverPose", "clock"]),
  writes: Object.freeze(["renderTransform", "partTransform", "materialUniform"]),
});

const HALF_PI = Math.PI * 0.5;
const TROLLEY_MIN_Y = -(STS_CRANE_SPECS.railGaugeM * 0.5 + STS_CRANE_SPECS.backreachM); // -26.0
const TROLLEY_MAX_Y = +(STS_CRANE_SPECS.railGaugeM * 0.5 + STS_CRANE_SPECS.outreachM);  // +38.0

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

function buildTwistlockPinGeom(t, pal) {
  const acc = new GeomAcc(3);
  acc.cylinder(0, 0, 0.04, 0.050, 0.08, 8, pal.steelMid, "z");
  acc.box(0, 0, -0.055, 0.098, 0.054, 0.045, pal.yellow, cShade(pal.yellow, 0.82));
  return acc.toBufferGeometry(t);
}

export function buildStsCrane(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const opts = options && typeof options === "object" ? options : {};
  const csmState = opts.csmState;
  const S = STS_CRANE_SPECS;

  const halfGauge = S.railGaugeM * 0.5; // 10.0 m (landside -10.0, waterside +10.0)
  const portalClearZ = S.portalClearanceM; // 14.0 m
  const boomZ = S.boomHeightAboveRailM; // 28.0 m
  const apexZ = 46.0;
  const legHalfX = 7.40; // Clear span between legs: ~13.6 m; outer width ~16.8 m (< 26 m separation)
  const trolleyRailZ = boomZ - 0.55; // 27.45 m
  const hoistTopZ = boomZ - 1.10; // 26.90 m

  const pal = makeLinearPalette(t, {
    craneRed: opts.bodyHex ?? 0xc4281e,
    craneRedDark: 0x8e1912,
    craneWhite: 0xe8edf2,
    craneWhiteDark: 0xc2cad2,
    steelDark: 0x252a30,
    steelMid: 0x525a64,
    steelBright: 0x9ca5b0,
    galv: 0x929ba5,
    yellow: 0xf2b20c,
    lampAmber: 0xffa818,
    lampRed: 0xff2820,
    lampGreen: 0x22ee66,
    lampWhite: 0xfff0cc,
  });

  const root = new t.Group();
  root.name = "port-sts-crane-root";
  root.userData = { wcid: S.wcid, kind: S.kind, stsCrane: true, maxDrawCalls: S.maxDrawCalls };

  // =========================================================================
  // DC 1: Portal Frame, Legs (20 m gauge, 14 m clearance), Backreach Girder,
  //       A-Frame Tower (z = 46 m), Machinery House & Maintenance Walkways
  // =========================================================================
  const stAcc = new GeomAcc(3);

  // Sill beams running along X at waterside (y = +10) & landside (y = -10) rails (z = 1.6..2.8 m)
  for (const sy of [-1, 1]) {
    const ry = sy * halfGauge;
    stAcc.bevelBox(0, ry, 2.15, legHalfX + 2.2, 0.72, 0.58, 0.10, pal.craneRed, pal.craneRedDark);
    // Portal legs rising from sill beam (x = +-legHalfX) to boom girder level (z = 28.0 m)
    for (const sx of [-1, 1]) {
      const lx = sx * legHalfX;
      // Lower portal leg column (z in [2.6, 15.0], vertical)
      stAcc.bevelBox(lx, ry, 8.80, 0.62, 0.68, 6.20, 0.08, pal.craneRed, pal.craneRedDark);
      // Upper tapered A-frame leg tapering inward from (lx, ry, 14.8) to (sx * 4.4, ry, 28.4)
      stAcc.tube([lx, ry, 14.6], [sx * 4.4, ry, boomZ + 0.4], 0.64, 0.50, 8, pal.craneWhite, pal.craneWhiteDark, true, true);
    }
    // Horizontal portal tie-beam above 14 m truck clearance (z in [14.2, 15.6])
    stAcc.bevelBox(0, ry, portalClearZ + 0.90, legHalfX - 0.3, 0.55, 0.65, 0.08, pal.craneRed, pal.craneRedDark);
    // Upper cross-girder under boom deck (z = 26.8..28.2)
    stAcc.bevelBox(0, ry, boomZ - 0.30, 5.2, 0.62, 0.68, 0.08, pal.craneRed, pal.craneRedDark);
    // Portal diagonal braces (strictly above 14 m clearance!)
    stAcc.tube([-legHalfX, ry, 15.0], [-4.5, ry, 21.5], 0.22, 0.20, 6, pal.craneWhiteDark, pal.craneWhiteDark);
    stAcc.tube([+legHalfX, ry, 15.0], [+4.5, ry, 21.5], 0.22, 0.20, 6, pal.craneWhiteDark, pal.craneWhiteDark);
  }

  // Side tie-beams connecting landside & waterside legs at z = 14.9 m (strictly outside truck lanes!)
  for (const sx of [-1, 1]) {
    stAcc.bevelBox(sx * legHalfX, 0, portalClearZ + 0.90, 0.55, halfGauge, 0.62, 0.08, pal.craneRed, pal.craneRedDark);
    // Diagonal side cross-braces between z = 15.0 and z = 27.6 (above truck portal)
    stAcc.tube([sx * legHalfX, -halfGauge, 15.0], [sx * 4.4, +halfGauge, boomZ], 0.26, 0.24, 6, pal.craneRed, pal.craneRedDark);
    stAcc.tube([sx * legHalfX, +halfGauge, 15.0], [sx * 4.4, -halfGauge, boomZ], 0.26, 0.24, 6, pal.craneRed, pal.craneRedDark);
  }

  // Fixed Backreach & Portal Twin Box Girders (y in [-26.4, +10.2], z in [27.4, 29.4], x = +-2.8 m)
  const backLen = halfGauge * 2.0 + S.backreachM + 0.6; // 36.6 m
  const backMidY = 0.5 * (-26.4 + 10.2); // -8.1 m
  for (const sx of [-2.85, +2.85]) {
    stAcc.bevelBox(sx, backMidY, boomZ + 0.45, 0.52, backLen * 0.5, 0.95, 0.08, pal.craneWhite, pal.craneWhiteDark);
    // Trolley running rails along inner lower flange
    stAcc.box(sx - Math.sign(sx) * 0.48, backMidY, trolleyRailZ, 0.08, backLen * 0.5 - 0.2, 0.09, pal.steelBright, pal.steelDark);
  }
  // Overhead cross struts tying twin girders along backreach
  for (let by = -25.5; by <= 9.5; by += 5.0) {
    stAcc.box(0, by, boomZ + 1.32, 3.0, 0.24, 0.22, pal.craneRed, pal.craneRedDark);
  }

  // Upper A-Frame Pylon Tower rising from boom level (z = 29.0) to apex (z = 46.0)
  for (const sx of [-1, 1]) {
    const gx = sx * 2.85;
    const ax = sx * 2.40;
    // Waterside near-vertical pylon legs (y = +10 -> y = +8.5, z = 46)
    stAcc.tube([gx, +halfGauge, boomZ + 0.8], [ax, +8.5, apexZ], 0.46, 0.36, 8, pal.craneRed, pal.craneRedDark, true, true);
    // Landside raked backstay legs (y = -10 -> y = +8.5, z = 46)
    stAcc.tube([gx, -halfGauge, boomZ + 0.8], [ax, +8.5, apexZ], 0.44, 0.34, 8, pal.craneRed, pal.craneRedDark, true, true);
    // Backreach tension tie-back rod from apex (y = +8.5, z = 46) to backreach tail (y = -24.0, z = 29.3)
    stAcc.tube([ax, +8.5, apexZ - 0.4], [gx, -24.0, boomZ + 1.3], 0.14, 0.14, 6, pal.steelMid, pal.steelDark);
  }
  // Apex cross-beam & sheave house (z = 45.2..46.8)
  stAcc.bevelBox(0, +8.5, apexZ, 3.30, 1.35, 0.85, 0.12, pal.craneWhite, pal.craneWhiteDark);
  stAcc.box(0, +8.5, 37.5, 2.75, 0.40, 0.40, pal.craneRed, pal.craneRedDark);

  // Machinery House perched atop portal girders (y in [-9.0, +4.5], z in [29.4, 34.4])
  stAcc.bevelBox(0, -2.2, 31.9, 3.85, 6.80, 2.45, 0.18, pal.craneWhite, pal.craneWhiteDark);
  stAcc.box(0, -2.2, 33.8, 3.92, 6.88, 0.45, pal.craneRed, pal.craneRedDark);
  // Machinery house ventilation louvers & service crane monorail beam
  for (const sx of [-3.88, +3.88]) {
    stAcc.box(sx, -2.2, 31.8, 0.05, 4.2, 0.95, pal.steelDark, pal.steelDark);
  }
  // Access stairway & exterior safety catwalk on west leg
  stAcc.box(-legHalfX - 0.85, -halfGauge, 8.5, 0.35, 0.85, 6.2, pal.galv, pal.steelMid);

  const structMat = makeDeployablePbrMaterial(t, { roughness: 0.44, metalness: 0.42, csmState });
  const structMesh = new t.Mesh(stAcc.toBufferGeometry(t), structMat);
  structMesh.name = "sts-portal-structure-mesh";
  structMesh.castShadow = true;
  structMesh.receiveShadow = true;
  root.add(structMesh);

  // =========================================================================
  // DC 2: Bogie Wheel Trucks on Quay Rails (4 corner multi-wheel trucks + storm clamps)
  // =========================================================================
  const bogAcc = new GeomAcc(3);
  for (const sy of [-1, 1]) {
    const ry = sy * halfGauge;
    for (const sx of [-1, 1]) {
      const bx = sx * legHalfX;
      // Primary equalizer beam + twin bogie sub-frames
      bogAcc.bevelBox(bx, ry, 1.18, 2.85, 0.56, 0.44, 0.08, pal.steelDark, cShade(pal.steelDark, 0.78));
      // 4 heavy flanged steel rail wheels per corner truck (16 rail wheels total!)
      for (const wx of [-2.10, -0.75, +0.75, +2.10]) {
        bogAcc.cylinder(bx + wx, ry, 0.42, 0.42, 0.24, 12, pal.steelBright, "y");
      }
      // Yellow/black safety rail sweepers & end bumpers
      bogAcc.box(bx + sx * 2.95, ry, 0.45, 0.14, 0.52, 0.36, pal.yellow, pal.steelDark);
    }
    // Electric motor-driven cable reel on landside sill
    if (sy < 0) {
      bogAcc.cylinder(0, ry - 0.85, 1.75, 1.15, 0.55, 14, pal.steelDark, "y");
      bogAcc.cylinder(0, ry - 0.85, 1.75, 0.78, 0.60, 12, pal.yellow, "y");
    }
  }
  const bogieMat = makeDeployablePbrMaterial(t, { roughness: 0.42, metalness: 0.65, csmState });
  const bogiesMesh = new t.Mesh(bogAcc.toBufferGeometry(t), bogieMat);
  bogiesMesh.name = "sts-bogies-mesh";
  bogiesMesh.castShadow = true;
  bogiesMesh.receiveShadow = true;
  root.add(bogiesMesh);

  // =========================================================================
  // DC 3: Hinged Waterside Boom (pivots at y = +10.0, z = 28.0; outreach = 28.0 m -> y = +38.0)
  //       boomPivot.rotation.x = +boomAngle swings +Y boom UPWARD toward +Z (0 <-> 80 deg)!
  // =========================================================================
  const boomPivot = new t.Group();
  boomPivot.name = "sts-boom-pivot";
  boomPivot.position.set(0, +halfGauge, boomZ);
  root.add(boomPivot);

  const boomAcc = new GeomAcc(3);
  const boomLen = S.outreachM + 1.2; // 29.2 m (tip past +38 m trolley limit)
  for (const sx of [-2.85, +2.85]) {
    // Tapered waterside box girder (z_local = -0.5..+1.3 -> tapers smoothly near tip)
    boomAcc.bevelBox(sx, boomLen * 0.5, 0.45, 0.48, boomLen * 0.5, 0.88, 0.08, pal.craneWhite, pal.craneWhiteDark);
    // Trolley running rail along inner lower flange (aligned with fixed backreach rail at z_local = -0.55)
    boomAcc.box(sx - Math.sign(sx) * 0.48, boomLen * 0.5, trolleyRailZ - boomZ, 0.08, boomLen * 0.5, 0.09, pal.steelBright, pal.steelDark);
  }
  // Hinge pin brackets at y_local = 0
  boomAcc.cylinder(0, 0, 0.35, 0.24, 6.8, 10, pal.steelDark, "x");
  // Transverse overhead bracing struts & tip sheave beam
  for (let by = 4.0; by <= boomLen - 1.0; by += 4.5) {
    boomAcc.box(0, by, 1.28, 2.95, 0.22, 0.20, pal.craneRed, pal.craneRedDark);
  }
  boomAcc.bevelBox(0, boomLen - 0.4, 0.45, 3.30, 0.55, 0.72, 0.08, pal.craneRed, pal.craneRedDark);
  // Safety-yellow boom-tip bumper & catwalk
  boomAcc.box(+3.48, boomLen * 0.5, 1.35, 0.30, boomLen * 0.48, 0.04, pal.galv, pal.steelMid);
  boomAcc.box(+3.76, boomLen * 0.5, 2.25, 0.03, boomLen * 0.48, 0.03, pal.yellow, pal.yellow);

  const boomMat = makeDeployablePbrMaterial(t, { roughness: 0.44, metalness: 0.42, csmState });
  const boomMesh = new t.Mesh(boomAcc.toBufferGeometry(t), boomMat);
  boomMesh.name = "sts-boom-mesh";
  boomMesh.castShadow = true;
  boomMesh.receiveShadow = true;
  boomPivot.add(boomMesh);

  // =========================================================================
  // DC 4: 4 Dynamic Forestay Suspension Cables linking A-Frame Apex to Hinged Boom (InstancedMesh)
  //       Updates dynamically as boomAngle swings 0 <-> 80 deg!
  // =========================================================================
  const stayAcc = new GeomAcc(3);
  stayAcc.cylinder(0, 0, 0.5, 0.11, 1.0, 6, pal.steelBright, "z", false, false);
  const stayMat = makeDeployablePbrMaterial(t, { roughness: 0.35, metalness: 0.78, csmState });
  const stayCablesInst = new t.InstancedMesh(stayAcc.toBufferGeometry(t), stayMat, 4);
  stayCablesInst.name = "sts-stay-cables-instanced";
  stayCablesInst.castShadow = true;
  stayCablesInst.frustumCulled = false;
  root.add(stayCablesInst);

  // =========================================================================
  // DC 5 & DC 6: Travelling Trolley + Glazed Under-Slung Operator Cab
  // =========================================================================
  const trolleyGroup = new t.Group();
  trolleyGroup.name = "sts-trolley-group";
  trolleyGroup.position.set(0, 0, trolleyRailZ);
  root.add(trolleyGroup);

  const trAcc = new GeomAcc(3);
  // Trolley wheel bogie carriage spanning between twin boom girders (x in [-2.7, +2.7])
  trAcc.bevelBox(0, 0, 0.25, 2.65, 1.75, 0.24, 0.08, pal.steelDark, cShade(pal.steelDark, 0.8));
  for (const sx of [-2.42, +2.42]) {
    for (const sy of [-1.25, +1.25]) {
      trAcc.cylinder(sx, sy, 0.05, 0.24, 0.16, 10, pal.steelBright, "x");
    }
  }
  // Under-slung panoramic glass-floor operator cab suspended beneath trolley (z_local in [-2.6, -0.3])
  trAcc.bevelBox(0, +0.25, -1.45, 1.15, 1.55, 1.05, 0.10, pal.craneWhite, pal.craneWhiteDark);
  trAcc.box(0, +0.25, -0.35, 1.20, 1.62, 0.14, pal.craneRed, pal.craneRedDark);

  const trolleyMat = makeDeployablePbrMaterial(t, { roughness: 0.46, metalness: 0.50, csmState });
  const trolleyMesh = new t.Mesh(trAcc.toBufferGeometry(t), trolleyMat);
  trolleyMesh.name = "sts-trolley-cab-mesh";
  trolleyMesh.castShadow = true;
  trolleyMesh.receiveShadow = true;
  trolleyGroup.add(trolleyMesh);

  const cabGlassAcc = new GeomAcc(3);
  const glassCol = [0.64, 0.85, 0.96];
  cabGlassAcc.box(0, +0.35, -1.65, 1.18, 1.48, 0.68, glassCol, glassCol);
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
  const cabGlassMesh = new t.Mesh(cabGlassAcc.toBufferGeometry(t), cabGlassMat);
  cabGlassMesh.name = "sts-cab-glass-mesh";
  trolleyGroup.add(cabGlassMesh);

  // =========================================================================
  // DC 7: 4-Wire Hoist Reeving (unit length 1.0 m hanging downward in -Z, scaled dynamically)
  // =========================================================================
  const wireAcc = new GeomAcc(3);
  for (const wx of [-1.75, +1.75]) {
    for (const wy of [-0.95, +0.95]) {
      wireAcc.cylinder(wx, wy, -0.50, 0.028, 1.0, 6, pal.steelBright, "z", false, false);
    }
  }
  const wireMat = makeDeployablePbrMaterial(t, { roughness: 0.35, metalness: 0.80, csmState });
  const hoistWiresMesh = new t.Mesh(wireAcc.toBufferGeometry(t), wireMat);
  hoistWiresMesh.name = "sts-hoist-wires-mesh";
  hoistWiresMesh.position.set(0, 0, hoistTopZ - trolleyRailZ);
  hoistWiresMesh.castShadow = true;
  trolleyGroup.add(hoistWiresMesh);

  // =========================================================================
  // DC 8..11: Telescoping 20ft/40ft ISO Spreader (Main + Left/Right Arms + 4 Twistlocks)
  //           Underside twistlock latch plane at spreaderGroup local z = 0.0!
  //           Oriented East-West (telescoping along crane X, width 2.438 m along crane Y)
  // =========================================================================
  const spreaderGroup = new t.Group();
  spreaderGroup.name = "sts-spreader-group";
  spreaderGroup.position.set(0, 0, S.spreaderSafeZ - S.railZ);
  root.add(spreaderGroup);

  const spMainAcc = new GeomAcc(3);
  spMainAcc.bevelBox(0, 0, 0.36, 2.65, 0.58, 0.28, 0.06, pal.yellow, cShade(pal.yellow, 0.84));
  // Heavy STS headblock with 4 wire-rope sheaves
  spMainAcc.bevelBox(0, 0, 0.88, 1.95, 1.12, 0.24, 0.06, pal.steelDark, cShade(pal.steelDark, 0.8));
  for (const sx of [-1.75, +1.75]) {
    for (const sy of [-0.95, +0.95]) {
      spMainAcc.cylinder(sx, sy, 0.96, 0.18, 0.10, 10, pal.steelBright, "x");
    }
  }
  const spMat = makeDeployablePbrMaterial(t, { roughness: 0.44, metalness: 0.48, csmState });
  const spreaderMainMesh = new t.Mesh(spMainAcc.toBufferGeometry(t), spMat);
  spreaderMainMesh.name = "sts-spreader-main-mesh";
  spreaderMainMesh.castShadow = true;
  spreaderMainMesh.receiveShadow = true;
  spreaderGroup.add(spreaderMainMesh);

  const buildArmMesh = (signX) => {
    const aAcc = new GeomAcc(3);
    aAcc.box(-signX * 1.65, 0, 0.36, 1.60, 0.38, 0.21, pal.steelDark, cShade(pal.steelDark, 0.8));
    aAcc.bevelBox(0, 0, 0.30, 0.25, 1.26, 0.28, 0.05, pal.yellow, cShade(pal.yellow, 0.84));
    // Hydraulic corner alignment flippers (2 per end-beam = 4 total)
    for (const sy of [-1, 1]) {
      aAcc.box(signX * 0.12, sy * 1.29, 0.02, 0.15, 0.045, 0.28, pal.craneRed, pal.craneRedDark);
    }
    const m = new t.Mesh(aAcc.toBufferGeometry(t), spMat);
    m.name = signX < 0 ? "sts-spreader-arm-left" : "sts-spreader-arm-right";
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };
  const leftArmMesh = buildArmMesh(-1);
  const rightArmMesh = buildArmMesh(+1);
  spreaderGroup.add(leftArmMesh, rightArmMesh);

  const tlMat = makeDeployablePbrMaterial(t, { roughness: 0.38, metalness: 0.72, csmState });
  const twistlocksInst = new t.InstancedMesh(buildTwistlockPinGeom(t, pal), tlMat, 4);
  twistlocksInst.name = "sts-twistlocks-instanced";
  twistlocksInst.castShadow = true;
  twistlocksInst.frustumCulled = false;
  spreaderGroup.add(twistlocksInst);

  const cargoMount = new t.Group();
  cargoMount.name = "sts-cargo-mount";
  spreaderGroup.add(cargoMount);

  // =========================================================================
  // DC 12: Emissive Warning Beacons, Apex Aviation Strobes & Portal Work Lamps (0 lights!)
  // =========================================================================
  const lampAcc = new GeomAcc(3);
  // 4 bogie gantry-travel amber warning beacons
  for (const sy of [-1, 1]) {
    for (const sx of [-1, 1]) {
      lampAcc.cylinder(sx * (legHalfX + 1.8), sy * halfGauge, 2.95, 0.14, 0.26, 8, pal.lampAmber, "z");
    }
    // Under-portal downward work-lamp panels (emissive only, 0 dynamic lights!)
    lampAcc.box(0, sy * halfGauge, portalClearZ + 0.22, 3.6, 0.24, 0.06, pal.lampWhite, pal.lampWhite);
  }
  // Dual red aviation obstruction beacons atop A-frame apex (z = 47.0 m)
  lampAcc.cylinder(-2.2, +8.5, apexZ + 1.15, 0.18, 0.32, 8, pal.lampRed, "z");
  lampAcc.cylinder(+2.2, +8.5, apexZ + 1.15, 0.18, 0.32, 8, pal.lampRed, "z");
  // Machinery house front status lamp strip
  lampAcc.box(0, +4.62, 32.8, 2.8, 0.08, 0.14, pal.lampGreen, pal.lampGreen);

  const lampsMat = makeLampsMaterial(t, { emissiveIntensity: 1.15, roughness: 0.25 });
  lampsMat.userData.__vfxSetKey = "lamps";
  if (csmState) installCsmShaderPatch(lampsMat, csmState);
  const beaconsMesh = new t.Mesh(lampAcc.toBufferGeometry(t), lampsMat);
  beaconsMesh.name = "sts-beacons-mesh";
  root.add(beaconsMesh);

  // =========================================================================
  // Dynamic State & Zero-Alloc Articulation Update
  // =========================================================================
  const _m = new t.Matrix4();
  const _p = new t.Vector3();
  const _p0 = new t.Vector3();
  const _p1 = new t.Vector3();
  const _dir = new t.Vector3();
  const _upZ = new t.Vector3(0, 0, 1);
  const _q = new t.Quaternion();
  const _s = new t.Vector3(1, 1, 1);
  const _e = new t.Euler(0, 0, 0, "ZYX");

  let curBoomAngle = 0.0;
  let curTrolleyY = 0.0;
  let curSpreaderZ = S.spreaderSafeZ;
  let curSpreaderLen = S.spreaderLen40M;
  let curTwistlockAngle = 0.0;
  let mountedCargoKey = null;
  let mountedCargo = null;

  function syncStayCables() {
    const cosB = Math.cos(curBoomAngle);
    const sinB = Math.sin(curBoomAngle);
    // 4 forestay cables: 2 mid-boom (y_local = 14 m), 2 outer-boom (y_local = 24.5 m)
    const anchors = [
      [-2.40, 14.0],
      [+2.40, 14.0],
      [-2.40, 24.5],
      [+2.40, 24.5],
    ];
    for (let i = 0; i < 4; i++) {
      const [ax, boomDist] = anchors[i];
      const bx = Math.sign(ax) * 2.85;
      _p0.set(ax, +8.5, apexZ - 0.25);
      // Boom anchor in crane-local coordinates after rotation.x = +curBoomAngle around (0, +10.0, 28.0)
      const byLocal = boomDist;
      const bzLocal = 1.25;
      _p1.set(
        bx,
        +halfGauge + byLocal * cosB - bzLocal * sinB,
        boomZ + byLocal * sinB + bzLocal * cosB
      );
      _dir.subVectors(_p1, _p0);
      const len = Math.max(0.2, _dir.length());
      _dir.multiplyScalar(1.0 / len);
      _q.setFromUnitVectors(_upZ, _dir);
      _s.set(1, 1, len);
      _m.compose(_p0, _q, _s);
      stayCablesInst.setMatrixAt(i, _m);
    }
    stayCablesInst.instanceMatrix.needsUpdate = true;
  }

  function syncBoomTrolleySpreader() {
    boomPivot.rotation.set(curBoomAngle, 0, 0);
    syncStayCables();

    const maxAllowedTrolley = curBoomAngle > 0.05 ? 8.0 : TROLLEY_MAX_Y;
    const effTrolleyY = clamp(curTrolleyY, TROLLEY_MIN_Y, maxAllowedTrolley);
    const localSpreaderZ = clamp(curSpreaderZ - root.position.z, 0.2, hoistTopZ - 1.20);

    trolleyGroup.position.set(0, effTrolleyY, trolleyRailZ);
    spreaderGroup.position.set(0, effTrolleyY, localSpreaderZ);

    const wireLen = Math.max(0.25, hoistTopZ - (localSpreaderZ + 0.96));
    hoistWiresMesh.scale.set(1, 1, wireLen);

    const halfLen = clamp(curSpreaderLen, S.spreaderLen20M, S.spreaderLen40M) * 0.5;
    const armX = halfLen - 0.105;
    leftArmMesh.position.set(-armX, 0, 0);
    rightArmMesh.position.set(+armX, 0, 0);

    const tlX = halfLen - 0.1035;
    const tlY = 1.1295;
    _e.set(0, 0, curTwistlockAngle);
    _q.setFromEuler(_e);
    _s.set(1, 1, 1);
    let idx = 0;
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        _p.set(sx * tlX, sy * tlY, 0.0);
        _m.compose(_p, _q, _s);
        twistlocksInst.setMatrixAt(idx++, _m);
      }
    }
    twistlocksInst.instanceMatrix.needsUpdate = true;
  }

  function syncCarriedContainer(carried) {
    if (!carried) {
      if (mountedCargo) {
        if (mountedCargo.mesh.parent === cargoMount) cargoMount.remove(mountedCargo.mesh);
        mountedCargo.dispose();
        mountedCargo = null;
        mountedCargoKey = null;
      }
      return;
    }
    const spec = resolvePortContainerSpec(carried.wcid ?? carried.kind ?? carried.containerKind ?? carried.sizeFt ?? "40ft");
    const livHex = resolvePortLiveryHex(carried.livery ?? carried.liveryId ?? carried.liveryKey ?? 0);
    const key = `${spec.wcid}:${livHex}:${carried.reefer ? 1 : 0}`;
    if (mountedCargoKey === key && mountedCargo) return;

    if (mountedCargo) {
      if (mountedCargo.mesh.parent === cargoMount) cargoMount.remove(mountedCargo.mesh);
      mountedCargo.dispose();
      mountedCargo = null;
    }
    mountedCargo = buildCompactIsoContainer(t, { wcid: spec.wcid, livery: carried.livery ?? carried.liveryId ?? 0, reefer: carried.reefer }, { csmState });
    // Orient container East-West (heading = PI/2 -> rotation.z = -PI/2) flush beneath spreader underside (z = 0)
    mountedCargo.mesh.rotation.set(0, 0, -HALF_PI);
    mountedCargo.mesh.position.set(0, 0, -spec.extH);
    cargoMount.add(mountedCargo.mesh);
    mountedCargoKey = key;
  }

  function update(state = null) {
    if (state && typeof state === "object") {
      if (Number.isFinite(state.x)) root.position.x = state.x;
      if (Number.isFinite(state.y)) root.position.y = state.y;
      if (Number.isFinite(state.z)) root.position.z = state.z;
      if (Number.isFinite(state.boomAngle)) curBoomAngle = clamp(state.boomAngle, 0.0, S.boomStowedAngleRad);
      if (Number.isFinite(state.trolleyY)) curTrolleyY = clamp(state.trolleyY, TROLLEY_MIN_Y, TROLLEY_MAX_Y);
      if (Number.isFinite(state.spreaderZ)) curSpreaderZ = clamp(state.spreaderZ, S.spreaderMinZ, S.spreaderMaxZ);
      if (Number.isFinite(state.spreaderLen)) curSpreaderLen = clamp(state.spreaderLen, S.spreaderLen20M, S.spreaderLen40M);
      if (Number.isFinite(state.twistlockAngle)) curTwistlockAngle = clamp(state.twistlockAngle, 0.0, HALF_PI);
      if (state.carriedContainer !== undefined) syncCarriedContainer(state.carriedContainer);
      if (Number.isFinite(state.timeSec) || state.active !== undefined) {
        const tSec = Number.isFinite(state.timeSec) ? state.timeSec : 0;
        lampsMat.emissiveIntensity = state.active ? (1.30 + 0.45 * Math.sin(tSec * 5.0)) : 0.95;
      }
    }
    syncBoomTrolleySpreader();
  }

  update(opts.initialState || {
    boomAngle: opts.boomStowed ? S.boomStowedAngleRad : 0.0,
    z: opts.z,
  });

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    syncCarriedContainer(null);
    disposeObjectTree(root);
  }

  return {
    root,
    wcid: S.wcid,
    kind: S.kind,
    maxDrawCalls: S.maxDrawCalls,
    structMesh,
    bogiesMesh,
    boomPivot,
    boomMesh,
    stayCablesInst,
    trolleyGroup,
    spreaderGroup,
    leftArmMesh,
    rightArmMesh,
    twistlocksInst,
    hoistWiresMesh,
    cargoMount,
    beaconsMesh,
    lampsMat,
    get boomAngle() { return curBoomAngle; },
    get trolleyY() { return curTrolleyY; },
    get spreaderZ() { return curSpreaderZ; },
    get spreaderLen() { return curSpreaderLen; },
    get twistlockAngle() { return curTwistlockAngle; },
    get mountedCargo() { return mountedCargo; },
    update,
    dispose,
  };
}
