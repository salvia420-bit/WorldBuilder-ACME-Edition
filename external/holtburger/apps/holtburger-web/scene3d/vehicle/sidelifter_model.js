// scene3d/vehicle/sidelifter_model.js — ISO 3874 / ISO 1161 Self-Loading Sidelifter Semi-Trailer (`WCID 4000032`).
// Extends the 40-ft gooseneck skeletal container chassis (CHASSIS_DECK_Z = 1.32 m, CHASSIS_KINGPIN_Z = 0.96 m,
// kingpinY = 5.35 m) with twin sliding hydraulic crane carriages, telescoping ground outriggers,
// ISO 1161 corner-casting spreader lugs/chains, and an under-chassis lockable pallet-jack rack.
//
// Strict GPU budget: <= 14 draw calls (14 actual via InstancedMesh), 0 THREE.Light instances,
// AGX HDR PBR MeshStandardMaterial + 3-cascade CSM shader patching, Z-up AC coordinates (+Y front, +X right).

import * as THREE_DEFAULT from "three";
import { installCsmShaderPatch } from "../materials.js";
import {
  CHASSIS_DECK_Z,
  CHASSIS_KINGPIN_Z,
  TRAILER_SPECS,
  TWISTLOCK_STATE,
} from "./trailer_models.js";

export const SIDELIFTER_WCID = 4000032;

export const SIDELIFT_PHASE = Object.freeze({
  Idle: 0,
  OutriggersDeploying: 1,
  OutriggersPlanted: 2,
  CranesPositioning: 3,
  CranesLatched: 4,
  Hoisting: 5,
  Swinging: 6,
  Lowering: 7,
  Releasing: 8,
  CranesStowing: 9,
  OutriggersRetracting: 10,
});

export const SIDELIFTER_SPECS = Object.freeze({
  wcid: SIDELIFTER_WCID,
  kind: "40ft",
  deployableKind: 15,
  maxDrawCalls: 14,
  length: TRAILER_SPECS["40ft"].length,
  containerLength: TRAILER_SPECS["40ft"].containerLength,
  castingSpan: TRAILER_SPECS["40ft"].castingSpan,
  kingpinY: TRAILER_SPECS["40ft"].kingpinY,
  kingpinZ: CHASSIS_KINGPIN_Z,
  deckZ: CHASSIS_DECK_Z,
  landingGearY: TRAILER_SPECS["40ft"].landingGearY,
  bogieY: TRAILER_SPECS["40ft"].bogieY,
  effectiveWheelbase: TRAILER_SPECS["40ft"].effectiveWheelbase,
  wheelRadius: TRAILER_SPECS["40ft"].wheelRadius,
  craneSpan20: 2.9265,
  craneSpan40: 5.9925,
  craneSlideMinY: 2.5,
  craneSlideMaxY: 6.2,
  outriggerFrontY: 3.10,
  outriggerRearY: -2.95,
  outriggerReachX: 3.60,
  rackOffset: Object.freeze([-0.95, -1.6, 0.55]),
});

export const manifest = Object.freeze({
  id: "vfx-sidelifter-model",
  channel: "vehicleModel",
  deterministic: true,
  lightCountDelta: 0,
  cacheKeyScope: "set",
  reads: Object.freeze(["geometry", "serverPose", "clock"]),
  writes: Object.freeze(["renderTransform", "partTransform", "materialUniform"]),
});

// --- geometry & material helpers -------------------------------------------------------------------------------

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v) {
  return Number.isFinite(v) ? clamp(v, 0, 1) : 0;
}

function smoothstep(t) {
  const u = clamp01(t);
  return u * u * (3 - 2 * u);
}

function shade(t, raw, hex, { rx = 0, ry = 0, rz = 0, x = 0, y = 0, z = 0 } = {}) {
  const g = raw.index ? raw.toNonIndexed() : raw.clone();
  raw.dispose();
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  if (x || y || z) g.translate(x, y, z);
  for (const n of Object.keys(g.attributes)) {
    if (n !== "position" && n !== "normal") g.deleteAttribute(n);
  }
  g.computeVertexNormals();
  const n = g.getAttribute("position").count;
  const c = new Float32Array(n * 3);
  const col = new t.Color(hex);
  for (let i = 0; i < n; i++) {
    c[i * 3] = col.r;
    c[i * 3 + 1] = col.g;
    c[i * 3 + 2] = col.b;
  }
  g.setAttribute("color", new t.BufferAttribute(c, 3));
  return g;
}

function merge(t, parts) {
  let total = 0;
  for (const p of parts) total += p.getAttribute("position").count;
  const P = new Float32Array(total * 3);
  const N = new Float32Array(total * 3);
  const C = new Float32Array(total * 3);
  let o = 0;
  for (const p of parts) {
    const pa = p.getAttribute("position").array;
    P.set(pa, o);
    N.set(p.getAttribute("normal").array, o);
    C.set(p.getAttribute("color").array, o);
    o += pa.length;
    p.dispose();
  }
  const g = new t.BufferGeometry();
  g.setAttribute("position", new t.BufferAttribute(P, 3));
  g.setAttribute("normal", new t.BufferAttribute(N, 3));
  g.setAttribute("color", new t.BufferAttribute(C, 3));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

const box = (t, dx, dy, dz, hex, x, y, z, rot) =>
  shade(t, new t.BoxGeometry(dx, dy, dz), hex, { x, y, z, ...(rot || {}) });

const cylX = (t, r, len, hex, x, y, z, seg = 20) =>
  shade(t, new t.CylinderGeometry(r, r, len, seg), hex, { rz: Math.PI / 2, x, y, z });

const cylZ = (t, r, len, hex, x, y, z, seg = 12) =>
  shade(t, new t.CylinderGeometry(r, r, len, seg), hex, { rx: Math.PI / 2, x, y, z });

function mat(t, opts, csmState) {
  const m = new t.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, ...opts });
  if (csmState) installCsmShaderPatch(m, csmState);
  return m;
}

// --- builder ---------------------------------------------------------------------------------------------------

export function buildSidelifterTrailer(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const spec = TRAILER_SPECS["40ft"];
  const L = spec.length;
  const halfL = L / 2;
  const deckZ = CHASSIS_DECK_Z;
  const frameHex = options.frameHex ?? 0x23262a;
  const craneYellowHex = options.craneHex ?? 0xe5a00d;
  const craneDarkHex = 0x262a2f;
  const steelHex = 0x6d7176;
  const chromeHex = 0xd0d5dc;
  const rubberHex = 0x141414;
  const rimHex = 0xa7abb0;

  const root = new t.Group();
  root.name = "sidelifter-trailer-40ft-root";
  root.userData = { kind: "40ft", spec, trailer: true, isSidelifter: true, wcid: SIDELIFTER_WCID };

  // ---- 1. Frame: 40ft gooseneck chassis + crane slide rails + outrigger boxes + pallet-jack rack ----
  const F = [];
  const railX = 0.50;
  const railH = 0.28;
  const railTopZ = deckZ - 0.05;
  const railZ = railTopZ - railH / 2;
  const gooseL = 3.15;

  for (const sx of [-1, 1]) {
    F.push(box(t, 0.012, L - 0.3, railH, frameHex, sx * railX, -0.15, railZ));
    F.push(box(t, 0.14, L - 0.3, 0.018, frameHex, sx * railX, -0.15, railTopZ - 0.009));
    F.push(box(t, 0.14, L - 0.3, 0.018, frameHex, sx * railX, -0.15, railTopZ - railH + 0.009));
    // Raised gooseneck rail section for 40HC tunnel
    F.push(box(t, 0.14, gooseL, 0.12, frameHex, sx * railX, halfL - gooseL / 2, deckZ + 0.06));
    // Longitudinal heavy crane slide rails (x = +-1.20)
    F.push(box(t, 0.09, L - 0.25, 0.14, craneDarkHex, sx * 1.20, 0, deckZ - 0.12));
    F.push(box(t, 0.04, L - 0.30, 0.04, craneYellowHex, sx * 1.24, 0, deckZ - 0.04));
  }

  for (let y = -halfL + 0.9; y < halfL - 0.6; y += 1.1) {
    F.push(box(t, 2 * railX + 0.14, 0.08, 0.16, frameHex, 0, y, railZ + 0.04));
  }

  // Bolsters & twistlock housings
  const castY = spec.castingSpan.length / 2;
  const castX = spec.castingSpan.width / 2;
  const bolsterYs = [castY, -castY, 2.9295, -2.9295];
  for (const by of bolsterYs) {
    F.push(box(t, 2.44, 0.22, 0.20, frameHex, 0, by, deckZ - 0.10 + (by === castY ? 0.12 : 0)));
  }
  const lockPoints = [];
  for (const by of bolsterYs) {
    for (const sx of [-1, 1]) {
      const lz = deckZ + (by === castY ? 0.12 : 0);
      F.push(box(t, 0.16, 0.16, 0.06, steelHex, sx * castX, by, lz - 0.03));
      lockPoints.push({ x: sx * castX, y: by, z: lz });
    }
  }

  // Fixed outrigger transverse housings (clear of landing gear y=3.90, rack y=-1.6, tandem wheels)
  for (const oy of [SIDELIFTER_SPECS.outriggerFrontY, SIDELIFTER_SPECS.outriggerRearY]) {
    F.push(box(t, 2.38, 0.24, 0.22, craneYellowHex, 0, oy, 0.84));
    F.push(box(t, 2.42, 0.20, 0.18, craneDarkHex, 0, oy, 0.84));
  }

  // Kingpin plate & 2" SAE J700 kingpin
  const kpY = spec.kingpinY;
  F.push(box(t, 1.30, 1.60, 0.03, steelHex, 0, kpY, CHASSIS_KINGPIN_Z + 0.015));
  F.push(cylZ(t, 0.0254, 0.085, steelHex, 0, kpY, CHASSIS_KINGPIN_Z - 0.04));

  // Nose bumper
  F.push(box(t, 2.30, 0.10, 0.18, frameHex, 0, halfL - 0.05, deckZ - 0.09 + 0.12));

  // Landing gear fixed upper housings & crank
  const lgY = spec.landingGearY;
  for (const sx of [-1, 1]) {
    F.push(box(t, 0.13, 0.13, railZ - 0.50, frameHex, sx * 0.62, lgY, (railZ + 0.50) / 2));
    F.push(box(t, 0.08, 0.6, 0.06, frameHex, sx * 0.58, lgY + 0.3, railZ - 0.2, { rx: 0.7 }));
  }
  F.push(box(t, 1.24, 0.06, 0.06, frameHex, 0, lgY, 0.65));
  F.push(cylX(t, 0.02, 0.40, steelHex, 0.86, lgY, 0.78, 8));
  F.push(box(t, 0.03, 0.03, 0.22, steelHex, 1.06, lgY, 0.70));

  // Tandem suspension hangers & equalizers
  const axleYs = [-halfL + 1.15, -halfL + 1.15 + 1.31];
  for (const sx of [-1, 1]) {
    for (const ay of axleYs) {
      F.push(box(t, 0.08, 0.14, railZ - railH / 2 - 0.55, frameHex, sx * railX, ay + 0.55, (railZ - railH / 2 + 0.55) / 2));
      F.push(box(t, 0.08, 1.10, 0.06, steelHex, sx * railX, ay, 0.60));
    }
    F.push(box(t, 0.10, 0.10, railZ - railH / 2 - 0.55, frameHex, sx * railX, axleYs[0] - 0.55, (railZ - railH / 2 + 0.55) / 2));
  }

  // Rear ICC bumper, light bar, mudflaps
  F.push(box(t, 2.36, 0.10, 0.10, frameHex, 0, -halfL + 0.05, 0.55));
  for (const sx of [-1, 1]) {
    F.push(box(t, 0.08, 0.08, railZ - railH / 2 - 0.55, frameHex, sx * 0.85, -halfL + 0.05, (railZ - railH / 2 + 0.55) / 2));
    F.push(box(t, 0.55, 0.012, 0.55, rubberHex, sx * 0.93, axleYs[0] - 0.62, 0.38));
  }
  F.push(box(t, 2.40, 0.08, 0.14, frameHex, 0, -halfL + 0.02, deckZ - 0.20));

  // Under-chassis lockable pallet-jack rack cradle at (-0.95, -1.6, 0.55)
  const [rkX, rkY, rkZ] = SIDELIFTER_SPECS.rackOffset;
  F.push(box(t, 0.78, 1.32, 0.04, craneDarkHex, rkX, rkY, rkZ - 0.06));
  F.push(box(t, 0.05, 1.32, 0.24, craneDarkHex, rkX - 0.38, rkY, rkZ + 0.06));
  F.push(box(t, 0.05, 1.32, 0.24, craneDarkHex, rkX + 0.38, rkY, rkZ + 0.06));
  F.push(box(t, 0.06, 0.06, 0.52, frameHex, rkX - 0.25, rkY + 0.55, rkZ + 0.30));
  F.push(box(t, 0.06, 0.06, 0.52, frameHex, rkX - 0.25, rkY - 0.55, rkZ + 0.30));
  F.push(box(t, 0.80, 0.08, 0.06, craneYellowHex, rkX, rkY - 0.64, rkZ + 0.14)); // Lock bar

  const frameMat = mat(t, { roughness: 0.55, metalness: 0.45 }, options.csmState);
  const frameMesh = new t.Mesh(merge(t, F), frameMat);
  frameMesh.name = "sidelifter-frame";
  frameMesh.castShadow = true;
  frameMesh.receiveShadow = true;
  root.add(frameMesh); // Draw call 1

  // ---- 2. Landing Gear (retractable) ----
  const LG = [];
  for (const sx of [-1, 1]) {
    LG.push(box(t, 0.10, 0.10, 0.50, steelHex, sx * 0.62, lgY, 0.30));
    LG.push(box(t, 0.30, 0.36, 0.05, steelHex, sx * 0.62, lgY, 0.025));
  }
  const landingGearGroup = new t.Group();
  landingGearGroup.name = "trailer-landing-gear";
  const landingGearMesh = new t.Mesh(merge(t, LG), frameMat);
  landingGearMesh.name = "trailer-landing-gear-mesh";
  landingGearMesh.castShadow = true;
  landingGearMesh.receiveShadow = true;
  landingGearGroup.add(landingGearMesh);
  root.add(landingGearGroup); // Draw call 2

  // ---- 3. Running gear: 2 axle-centered wheel groups ----
  const tireR = spec.wheelRadius ?? 0.505;
  const tireW = 0.28;
  const gearMat = mat(t, { roughness: 0.8, metalness: 0.15 }, options.csmState);
  const wheelGroups = [];
  for (let i = 0; i < axleYs.length; i++) {
    const ay = axleYs[i];
    const wg = new t.Group();
    wg.name = `trailer-wheel-group-${i}`;
    wg.position.set(0, ay, tireR);
    const A = [cylX(t, 0.07, 2.30, steelHex, 0, 0, 0, 12)];
    for (const sx of [-1, 1]) {
      for (const dual of [0.80, 1.11]) {
        A.push(cylX(t, tireR, tireW, rubberHex, sx * dual, 0, 0, 24));
        A.push(cylX(t, 0.29, tireW + 0.01, rimHex, sx * dual, 0, 0, 16));
      }
      A.push(cylX(t, 0.12, 0.08, steelHex, sx * 1.27, 0, 0, 12));
    }
    const axleMesh = new t.Mesh(merge(t, A), gearMat);
    axleMesh.name = `trailer-axle-${i}`;
    axleMesh.castShadow = true;
    axleMesh.receiveShadow = true;
    wg.add(axleMesh);
    root.add(wg); // Draw calls 3, 4
    wheelGroups.push(wg);
  }

  // ---- 4. Lamps (brake + amber side markers) ----
  function makeLampMat(emissiveIntensity = 0.6) {
    const m = new t.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      emissive: 0xffffff,
      emissiveIntensity,
      roughness: 0.3,
    });
    m.onBeforeCompile = function lampVertexColorEmissive(s) {
      s.fragmentShader = s.fragmentShader.replace(
        "vec3 totalEmissiveRadiance = emissive;",
        "vec3 totalEmissiveRadiance = emissive * vColor.rgb;",
      );
    };
    if (options.csmState) installCsmShaderPatch(m, options.csmState);
    return m;
  }

  const brakeParts = [];
  const markerParts = [];
  for (const sx of [-1, 1]) {
    brakeParts.push(box(t, 0.18, 0.03, 0.08, 0xff2a1a, sx * 0.95, -halfL - 0.025, deckZ - 0.20));
    for (const y of [halfL - 0.3, 0, -halfL + 0.4]) {
      markerParts.push(box(t, 0.02, 0.07, 0.04, 0xffa000, sx * 1.155, y, deckZ - 0.12));
    }
  }
  const brakeLampMat = makeLampMat(0.6);
  const markerLampMat = makeLampMat(0.6);
  const brakeLampMesh = new t.Mesh(merge(t, brakeParts), brakeLampMat);
  brakeLampMesh.name = "trailer-brake-lamps";
  brakeLampMesh.castShadow = true;
  brakeLampMesh.receiveShadow = true;
  const markerLampMesh = new t.Mesh(merge(t, markerParts), markerLampMat);
  markerLampMesh.name = "trailer-marker-lamps";
  markerLampMesh.castShadow = true;
  markerLampMesh.receiveShadow = true;
  root.add(brakeLampMesh, markerLampMesh); // Draw calls 5, 6

  // ---- 5. Twistlocks (1 InstancedMesh, count = 8, driven by 8 twistlockPivots) ----
  const twistlockPivots = [];
  const lockMat = mat(t, { roughness: 0.4, metalness: 0.7 }, options.csmState);
  const lockGeom = merge(t, [
    box(t, 0.06, 0.11, 0.035, 0xd8b028, 0, 0, 0.0175),
    shade(t, new t.CylinderGeometry(0.02, 0.035, 0.05, 8), 0xd8b028, { rx: Math.PI / 2, z: 0.055 }),
  ]);
  for (const p of lockPoints) {
    const piv = new t.Group();
    piv.position.set(p.x, p.y, p.z);
    root.add(piv);
    twistlockPivots.push(piv);
  }
  const twistlockInstancedMesh = new t.InstancedMesh(lockGeom, lockMat, lockPoints.length);
  twistlockInstancedMesh.name = "sidelifter-twistlocks-instanced";
  twistlockInstancedMesh.castShadow = true;
  twistlockInstancedMesh.receiveShadow = true;
  twistlockInstancedMesh.frustumCulled = false;
  root.add(twistlockInstancedMesh); // Draw call 7

  // ---- 6. Telescoping Outriggers (2 InstancedMeshes, count = 2 each) ----
  // Horizontal telescoping lateral beam + outer vertical jack housing slide ONLY in X at fixed z = 0.84 m.
  // Vertical hydraulic ram + pivoting ground footpad translate in X with the beam tip and telescope in Z
  // so when retracted (outriggerProgress = 0) the assembly stays tucked below z = 1.05 m (< CHASSIS_DECK_Z = 1.32 m
  // and clear of the 20ft crane carriage at z >= 1.07 m), and when planted (outriggerProgress = 1) sits at z = 0.0.
  const craneMat = mat(t, { roughness: 0.45, metalness: 0.55 }, options.csmState);
  const outriggerBeamGeom = merge(t, [
    box(t, 2.39, 0.14, 0.14, craneYellowHex, -1.195, 0, 0),    // Telescoping lateral beam (z = 0.84 +- 0.07)
    box(t, 0.20, 0.20, 0.52, craneYellowHex, 0, 0, -0.10),        // Outer vertical jack housing (z_world = 0.48..1.00)
    box(t, 0.22, 0.22, 0.03, craneDarkHex, 0, 0, 0.165),          // Top jack housing cap (z_world = 0.99..1.02)
  ]);
  const outriggerGeom = merge(t, [
    box(t, 0.36, 0.36, 0.05, craneDarkHex, 0, 0, 0.025),          // Pivoting ground footpad (z_local = 0.00..0.05)
    box(t, 0.14, 0.14, 0.54, chromeHex, 0, 0, 0.32),              // Hydraulic jack ram (z_local = 0.05..0.59)
  ]);
  const frontOutriggerBeamGroup = new t.Group();
  frontOutriggerBeamGroup.name = "sidelifter-outrigger-beam-front";
  const rearOutriggerBeamGroup = new t.Group();
  rearOutriggerBeamGroup.name = "sidelifter-outrigger-beam-rear";
  const frontOutriggerGroup = new t.Group();
  frontOutriggerGroup.name = "sidelifter-outrigger-front";
  const rearOutriggerGroup = new t.Group();
  rearOutriggerGroup.name = "sidelifter-outrigger-rear";
  root.add(frontOutriggerBeamGroup, rearOutriggerBeamGroup, frontOutriggerGroup, rearOutriggerGroup);

  const outriggerBeamInstancedMesh = new t.InstancedMesh(outriggerBeamGeom, craneMat, 2);
  outriggerBeamInstancedMesh.name = "sidelifter-outrigger-beams-instanced";
  outriggerBeamInstancedMesh.castShadow = true;
  outriggerBeamInstancedMesh.receiveShadow = true;
  outriggerBeamInstancedMesh.frustumCulled = false;

  const outriggerInstancedMesh = new t.InstancedMesh(outriggerGeom, craneMat, 2);
  outriggerInstancedMesh.name = "sidelifter-outriggers-instanced";
  outriggerInstancedMesh.castShadow = true;
  outriggerInstancedMesh.receiveShadow = true;
  outriggerInstancedMesh.frustumCulled = false;
  root.add(outriggerBeamInstancedMesh, outriggerInstancedMesh); // Draw calls 8, 9

  // ---- 7. Twin Sliding Crane Modules (4 InstancedMeshes, count = 2 each) ----
  // Hierarchy per module: craneGroup -> boomPivot -> jibPivot -> spreaderPivot
  const carriageGeom = merge(t, [
    box(t, 0.28, 0.62, 0.30, craneDarkHex, 0, 0, -0.10),         // Slide carriage saddle
    box(t, 0.26, 0.46, 0.34, craneYellowHex, 0, 0, 0.16),        // Slewing turret pedestal
    cylX(t, 0.07, 0.28, chromeHex, 0, 0, 0.25, 10),              // Boom hinge pin
  ]);
  const boomGeom = merge(t, [
    box(t, 0.22, 0.24, 1.85, craneYellowHex, 0, 0, 0.925),       // Primary boom (0..1.85 m)
    cylZ(t, 0.055, 1.05, craneDarkHex, 0.14, 0, 0.52, 10),       // Hydraulic lift cylinder barrel
    cylZ(t, 0.032, 0.95, chromeHex, 0.14, 0, 1.10, 10),          // Chrome piston rod
    box(t, 0.24, 0.26, 0.14, craneDarkHex, 0, 0, 1.85),          // Jib clevis head
  ]);
  const jibGeom = merge(t, [
    box(t, 0.16, 0.18, 1.55, craneYellowHex, 0, 0, 0.775),       // Folding secondary jib (0..1.55 m)
    cylZ(t, 0.04, 0.85, craneDarkHex, -0.11, 0, 0.42, 8),        // Jib ram barrel
    cylZ(t, 0.024, 0.75, chromeHex, -0.11, 0, 0.92, 8),          // Jib chrome rod
    box(t, 0.18, 0.20, 0.12, craneDarkHex, 0, 0, 1.55),          // Spreader shackle head
  ]);
  const spreaderGeom = merge(t, [
    box(t, 0.18, 0.40, 0.10, craneYellowHex, 0, 0, -0.08),       // Spreader equalizer bar
    cylZ(t, 0.016, 0.62, chromeHex, -0.05, -0.14, -0.42, 6),     // Lifting chain A
    cylZ(t, 0.016, 0.62, chromeHex, 0.05, +0.14, -0.42, 6),      // Lifting chain B
    box(t, 0.14, 0.16, 0.09, 0xd8b028, 0, 0, -0.74),             // ISO 1161 corner-casting lug
  ]);

  function makeCraneRig(name, yPos) {
    const grp = new t.Group();
    grp.name = name;
    grp.position.set(1.24, yPos, deckZ);

    const boomPivot = new t.Group();
    boomPivot.name = `${name}-boom-pivot`;
    boomPivot.position.set(0, 0, 0.25);

    const jibPivot = new t.Group();
    jibPivot.name = `${name}-jib-pivot`;
    jibPivot.position.set(0, 0, 1.85);

    const spreaderPivot = new t.Group();
    spreaderPivot.name = `${name}-spreader-pivot`;
    spreaderPivot.position.set(0, 0, 1.55);

    jibPivot.add(spreaderPivot);
    boomPivot.add(jibPivot);
    grp.add(boomPivot);
    root.add(grp);
    return { grp, boomPivot, jibPivot, spreaderPivot };
  }

  const frontRig = makeCraneRig("sidelifter-crane-front", SIDELIFTER_SPECS.craneSpan40);
  const rearRig = makeCraneRig("sidelifter-crane-rear", -SIDELIFTER_SPECS.craneSpan40);
  const frontCraneGroup = frontRig.grp;
  const rearCraneGroup = rearRig.grp;

  const craneCarriageInstancedMesh = new t.InstancedMesh(carriageGeom, craneMat, 2);
  craneCarriageInstancedMesh.name = "sidelifter-crane-carriages-instanced";
  const craneBoomInstancedMesh = new t.InstancedMesh(boomGeom, craneMat, 2);
  craneBoomInstancedMesh.name = "sidelifter-crane-booms-instanced";
  const craneJibInstancedMesh = new t.InstancedMesh(jibGeom, craneMat, 2);
  craneJibInstancedMesh.name = "sidelifter-crane-jibs-instanced";
  const craneSpreaderInstancedMesh = new t.InstancedMesh(spreaderGeom, craneMat, 2);
  craneSpreaderInstancedMesh.name = "sidelifter-crane-spreaders-instanced";

  for (const im of [
    craneCarriageInstancedMesh,
    craneBoomInstancedMesh,
    craneJibInstancedMesh,
    craneSpreaderInstancedMesh,
  ]) {
    im.castShadow = true;
    im.receiveShadow = true;
    im.frustumCulled = false;
    root.add(im); // Draw calls 10, 11, 12, 13
  }

  // ---- 8. Under-Chassis Stowed Pallet Jack Silhouette (Draw call 14) ----
  const palletJackRackGroup = new t.Group();
  palletJackRackGroup.name = "sidelifter-pallet-jack-rack";
  palletJackRackGroup.position.set(rkX, rkY, rkZ);
  root.add(palletJackRackGroup);

  const stowedPalletJackMesh = new t.Mesh(
    merge(t, [
      box(t, 0.14, 1.05, 0.05, craneYellowHex, -0.24, 0.05, 0.02), // Left fork
      box(t, 0.14, 1.05, 0.05, craneYellowHex, +0.24, 0.05, 0.02), // Right fork
      box(t, 0.64, 0.14, 0.18, craneYellowHex, 0, -0.45, 0.10),    // Pump apron
      box(t, 0.12, 0.12, 0.24, craneDarkHex, 0, -0.46, 0.26),      // Pump cylinder
      box(t, 0.05, 0.05, 0.62, craneDarkHex, 0, -0.48, 0.56),      // Folded tiller stem
      box(t, 0.22, 0.05, 0.06, 0xd62828, 0, -0.48, 0.86),          // Tiller grip
    ]),
    craneMat,
  );
  stowedPalletJackMesh.name = "sidelifter-stowed-pallet-jack";
  stowedPalletJackMesh.castShadow = true;
  stowedPalletJackMesh.receiveShadow = true;
  palletJackRackGroup.add(stowedPalletJackMesh);

  // ---- 9. Container Mount ----
  const containerMount = new t.Group();
  containerMount.name = "trailer-container-mount";
  containerMount.position.set(0, 0, deckZ);
  root.add(containerMount);

  // Reusable scratch Matrix4 objects (zero per-frame allocations)
  const _mCarriage = new t.Matrix4();
  const _mBoom = new t.Matrix4();
  const _mJib = new t.Matrix4();
  const _mSpreader = new t.Matrix4();

  // ---- State & Kinematics Synchronization ----
  let twistlockState = TWISTLOCK_STATE.Unlocked;
  function setTwistlockState(s) {
    twistlockState = s ? TWISTLOCK_STATE.Locked : TWISTLOCK_STATE.Unlocked;
    for (let i = 0; i < twistlockPivots.length; i++) {
      const piv = twistlockPivots[i];
      piv.rotation.z = twistlockState ? Math.PI / 2 : 0;
      piv.updateMatrix();
      twistlockInstancedMesh.setMatrixAt(i, piv.matrix);
    }
    twistlockInstancedMesh.instanceMatrix.needsUpdate = true;
  }

  let landingGearRetracted = false;
  function setLandingGearRetracted(retracted) {
    landingGearRetracted = Boolean(retracted);
    landingGearGroup.position.z = landingGearRetracted ? 0.45 : 0.0;
  }

  let brakeLights = false;
  function setBrakeLights(on) {
    brakeLights = Boolean(on);
    brakeLampMat.emissiveIntensity = brakeLights ? 2.4 : 0.6;
  }

  let wheelRollAngle = 0;
  function setWheelRollAngle(angle) {
    if (!Number.isFinite(angle)) return;
    wheelRollAngle = angle;
    for (const wg of wheelGroups) wg.rotation.x = wheelRollAngle;
  }

  let sideliftPhase = SIDELIFT_PHASE.Idle;
  let sideliftSide = 1;
  let outriggerProgress = 0;
  let sideliftProgress = 0;
  let craneSpanY = SIDELIFTER_SPECS.craneSpan40;
  let craneCenterY = 0;
  let hasStowedPalletJack = true;
  let mounted = null;

  function syncOutriggersAndCranes(overrides = {}) {
    const side = sideliftSide < 0 ? -1 : 1;
    const outProg = clamp01(outriggerProgress);
    const xExt = clamp01(outProg / 0.65);
    const zDrop = clamp01((outProg - 0.35) / 0.65);
    const retractedX = 1.18;
    const footX = side * (retractedX + xExt * (SIDELIFTER_SPECS.outriggerReachX - retractedX));
    const footZ = (1 - zDrop) * 0.42;
    const outYaw = side < 0 ? Math.PI : 0;

    frontOutriggerBeamGroup.position.set(footX, SIDELIFTER_SPECS.outriggerFrontY, 0.84);
    frontOutriggerBeamGroup.rotation.set(0, 0, outYaw);
    frontOutriggerBeamGroup.updateMatrix();
    outriggerBeamInstancedMesh.setMatrixAt(0, frontOutriggerBeamGroup.matrix);

    rearOutriggerBeamGroup.position.set(footX, SIDELIFTER_SPECS.outriggerRearY, 0.84);
    rearOutriggerBeamGroup.rotation.set(0, 0, outYaw);
    rearOutriggerBeamGroup.updateMatrix();
    outriggerBeamInstancedMesh.setMatrixAt(1, rearOutriggerBeamGroup.matrix);
    outriggerBeamInstancedMesh.instanceMatrix.needsUpdate = true;

    frontOutriggerGroup.position.set(footX, SIDELIFTER_SPECS.outriggerFrontY, footZ);
    frontOutriggerGroup.rotation.set(0, 0, outYaw);
    frontOutriggerGroup.updateMatrix();
    outriggerInstancedMesh.setMatrixAt(0, frontOutriggerGroup.matrix);

    rearOutriggerGroup.position.set(footX, SIDELIFTER_SPECS.outriggerRearY, footZ);
    rearOutriggerGroup.rotation.set(0, 0, outYaw);
    rearOutriggerGroup.updateMatrix();
    outriggerInstancedMesh.setMatrixAt(1, rearOutriggerGroup.matrix);
    outriggerInstancedMesh.instanceMatrix.needsUpdate = true;

    // Visual boom & jib pose across SideliftPhase 0..10 (with optional M4 kinematics overrides)
    const p = smoothstep(sideliftProgress);
    const isLoad = Boolean(overrides.isLoadDirection);
    let boomAngle = 0.08;
    let jibAngle = Math.PI - 0.12;

    switch (sideliftPhase) {
      case SIDELIFT_PHASE.CranesPositioning: {
        const targetBoom = isLoad ? 1.10 : -0.35;
        const targetJib = isLoad ? 1.35 : 1.85;
        boomAngle = 0.08 + (targetBoom - 0.08) * p;
        jibAngle = (Math.PI - 0.12) + (targetJib - (Math.PI - 0.12)) * p;
        break;
      }
      case SIDELIFT_PHASE.CranesLatched: {
        boomAngle = isLoad ? 1.10 : -0.35;
        jibAngle = isLoad ? 1.35 : 1.85;
        break;
      }
      case SIDELIFT_PHASE.Hoisting: {
        const a0 = isLoad ? 1.10 : -0.35;
        const a1 = isLoad ? 0.85 : -0.15;
        const j0 = isLoad ? 1.35 : 1.85;
        const j1 = isLoad ? 1.15 : 1.35;
        boomAngle = a0 + (a1 - a0) * p;
        jibAngle = j0 + (j1 - j0) * p;
        break;
      }
      case SIDELIFT_PHASE.Swinging: {
        const u = isLoad ? 1 - p : p;
        boomAngle = -0.15 + (0.85 - -0.15) * u;
        jibAngle = 1.35 + (1.15 - 1.35) * u;
        break;
      }
      case SIDELIFT_PHASE.Lowering: {
        const a0 = isLoad ? -0.15 : 0.85;
        const a1 = isLoad ? -0.35 : 1.10;
        const j0 = isLoad ? 1.35 : 1.15;
        const j1 = isLoad ? 1.85 : 1.35;
        boomAngle = a0 + (a1 - a0) * p;
        jibAngle = j0 + (j1 - j0) * p;
        break;
      }
      case SIDELIFT_PHASE.Releasing: {
        boomAngle = isLoad ? -0.35 : 1.10;
        jibAngle = isLoad ? 1.85 : 1.35;
        break;
      }
      case SIDELIFT_PHASE.CranesStowing: {
        const aStart = isLoad ? -0.35 : 1.10;
        const jStart = isLoad ? 1.85 : 1.35;
        boomAngle = aStart + (0.08 - aStart) * p;
        jibAngle = jStart + (Math.PI - 0.12 - jStart) * p;
        break;
      }
      default:
        break;
    }

    if (Number.isFinite(overrides.craneBoomAngle)) boomAngle = overrides.craneBoomAngle;
    if (Number.isFinite(overrides.craneJibAngle)) jibAngle = overrides.craneJibAngle;

    const maxCenterOffset = Math.max(0, SIDELIFTER_SPECS.craneSpan40 - craneSpanY);
    const effCenterY = clamp(craneCenterY, -maxCenterOffset, maxCenterOffset);
    const rigs = [
      { rig: frontRig, y: effCenterY + craneSpanY },
      { rig: rearRig, y: effCenterY - craneSpanY },
    ];
    for (let i = 0; i < rigs.length; i++) {
      const { rig, y } = rigs[i];
      rig.grp.position.set(side * 1.24, y, deckZ);
      rig.grp.rotation.set(0, 0, outYaw);
      rig.boomPivot.rotation.set(0, boomAngle, 0);
      rig.jibPivot.rotation.set(0, jibAngle, 0);
      // Keep spreader crossbar & chains hanging vertically (-Z)
      rig.spreaderPivot.rotation.set(0, -(boomAngle + jibAngle), 0);

      rig.grp.updateMatrix();
      rig.boomPivot.updateMatrix();
      rig.jibPivot.updateMatrix();
      rig.spreaderPivot.updateMatrix();

      _mCarriage.copy(rig.grp.matrix);
      _mBoom.multiplyMatrices(_mCarriage, rig.boomPivot.matrix);
      _mJib.multiplyMatrices(_mBoom, rig.jibPivot.matrix);
      _mSpreader.multiplyMatrices(_mJib, rig.spreaderPivot.matrix);

      craneCarriageInstancedMesh.setMatrixAt(i, _mCarriage);
      craneBoomInstancedMesh.setMatrixAt(i, _mBoom);
      craneJibInstancedMesh.setMatrixAt(i, _mJib);
      craneSpreaderInstancedMesh.setMatrixAt(i, _mSpreader);
    }
    craneCarriageInstancedMesh.instanceMatrix.needsUpdate = true;
    craneBoomInstancedMesh.instanceMatrix.needsUpdate = true;
    craneJibInstancedMesh.instanceMatrix.needsUpdate = true;
    craneSpreaderInstancedMesh.instanceMatrix.needsUpdate = true;
  }

  function detachContainer() {
    const prev = mounted;
    if (mounted?.root && mounted.root.parent === containerMount) {
      containerMount.remove(mounted.root);
    }
    mounted = null;
    return prev;
  }

  function update(dtOrState = 0.033, stateOrDt = {}) {
    let dt;
    let state;
    if (dtOrState !== null && typeof dtOrState === "object") {
      state = dtOrState;
      dt = Number.isFinite(state.dt) ? state.dt : (Number.isFinite(stateOrDt) ? stateOrDt : 0.033);
    } else {
      dt = Number.isFinite(dtOrState) ? dtOrState : 0.033;
      state = stateOrDt && typeof stateOrDt === "object" ? stateOrDt : {};
    }

    const lockIn = state.twistlockState !== undefined ? state.twistlockState : state.twistlockLocked;
    if (lockIn !== undefined) setTwistlockState(lockIn);
    if (state.landingGearRetracted !== undefined) setLandingGearRetracted(state.landingGearRetracted);
    const brakeInput = state.brakeLights !== undefined ? state.brakeLights : state.braking;
    if (brakeInput !== undefined) setBrakeLights(brakeInput);

    if (Number.isFinite(state.wheelRollAngle)) {
      setWheelRollAngle(state.wheelRollAngle);
    } else if (dt > 0 && Number.isFinite(state.speed) && Math.abs(state.speed) > 1e-6) {
      let next = (wheelRollAngle + (state.speed * dt) / tireR) % (2 * Math.PI);
      if (next < 0) next += 2 * Math.PI;
      setWheelRollAngle(next);
    }

    const rawPhase = state.sideliftPhase !== undefined ? state.sideliftPhase : state.SideliftPhase;
    if (Number.isFinite(rawPhase)) {
      sideliftPhase = clamp(Math.trunc(rawPhase), 0, 10);
    }
    const rawSide = state.sideliftSide !== undefined ? state.sideliftSide : state.SideliftSide;
    if (Number.isFinite(rawSide) && rawSide !== 0) {
      sideliftSide = rawSide < 0 ? -1 : 1;
    }
    const rawOut = state.outriggerProgress !== undefined ? state.outriggerProgress : state.OutriggerProgress;
    if (Number.isFinite(rawOut)) {
      outriggerProgress = clamp01(rawOut);
    } else if (rawPhase !== undefined) {
      outriggerProgress = sideliftPhase >= 2 && sideliftPhase <= 9 ? 1 : 0;
    }
    const rawProg = state.sideliftProgress !== undefined ? state.sideliftProgress : state.SideliftProgress;
    if (Number.isFinite(rawProg)) {
      sideliftProgress = clamp01(rawProg);
    }
    const rawSpan = state.craneSpanY !== undefined ? state.craneSpanY : state.CraneSpanY;
    if (Number.isFinite(rawSpan) && rawSpan > 0) {
      craneSpanY = clamp(rawSpan, SIDELIFTER_SPECS.craneSlideMinY, SIDELIFTER_SPECS.craneSlideMaxY);
    }
    const maxCenterOffset = Math.max(0, SIDELIFTER_SPECS.craneSpan40 - craneSpanY);
    const rawCenter = state.craneCenterY !== undefined ? state.craneCenterY : state.CraneCenterY;
    if (Number.isFinite(rawCenter)) {
      craneCenterY = clamp(rawCenter, -maxCenterOffset, maxCenterOffset);
    } else {
      craneCenterY = clamp(craneCenterY, -maxCenterOffset, maxCenterOffset);
    }

    const flags = state.sideliftFlags !== undefined ? state.sideliftFlags : state.SideliftFlags;
    if (state.hasStowedPalletJack !== undefined) {
      hasStowedPalletJack = Boolean(state.hasStowedPalletJack);
    } else if (Number.isFinite(flags)) {
      hasStowedPalletJack = Boolean(flags & 0x08);
    }
    stowedPalletJackMesh.visible = hasStowedPalletJack; // vfx-lint-allow: stowed pallet jack rack toggle

    const isLoadDirection =
      state.isLoadDirection !== undefined
        ? Boolean(state.isLoadDirection)
        : Number.isFinite(flags)
          ? Boolean(flags & 0x10)
          : false;

    syncOutriggersAndCranes({
      isLoadDirection,
      craneBoomAngle: state.craneBoomAngle,
      craneJibAngle: state.craneJibAngle,
    });
  }

  // Initialize all transforms & instanced matrices from options
  setTwistlockState(options.twistlockState ?? 0);
  setLandingGearRetracted(options.landingGearRetracted ?? false);
  setBrakeLights(options.brakeLights ?? false);
  update({
    hasStowedPalletJack: options.hasStowedPalletJack ?? true,
    craneSpanY: options.craneSpanY ?? SIDELIFTER_SPECS.craneSpan40,
    craneCenterY: options.craneCenterY ?? 0,
    sideliftPhase: options.sideliftPhase ?? SIDELIFT_PHASE.Idle,
    sideliftSide: options.sideliftSide ?? 1,
    outriggerProgress: options.outriggerProgress ?? 0,
    sideliftProgress: options.sideliftProgress ?? 0,
  });

  return {
    root,
    spec,
    kind: "40ft",
    isSidelifter: true,
    wcid: SIDELIFTER_WCID,
    maxDrawCalls: SIDELIFTER_SPECS.maxDrawCalls,
    kingpinY: kpY,
    kingpinZ: CHASSIS_KINGPIN_Z,
    containerMount,
    landingGearGroup,
    wheelGroups,
    twistlockPivots,
    frontCraneGroup,
    rearCraneGroup,
    frontOutriggerBeamGroup,
    rearOutriggerBeamGroup,
    frontOutriggerGroup,
    rearOutriggerGroup,
    palletJackRackGroup,
    stowedPalletJackMesh,
    materials: {
      frameMat,
      gearMat,
      lockMat,
      craneMat,
      brakeLampMat,
      markerLampMat,
    },
    get twistlockState() { return twistlockState; },
    setTwistlockState,
    get landingGearRetracted() { return landingGearRetracted; },
    setLandingGearRetracted,
    get brakeLights() { return brakeLights; },
    setBrakeLights,
    get wheelRollAngle() { return wheelRollAngle; },
    get mountedContainer() { return mounted; },
    get sideliftPhase() { return sideliftPhase; },
    get sideliftSide() { return sideliftSide; },
    get outriggerProgress() { return outriggerProgress; },
    get craneSpanY() { return craneSpanY; },
    get craneCenterY() { return craneCenterY; },
    get hasStowedPalletJack() { return hasStowedPalletJack; },
    attachContainer(model, opts) {
      const position = opts?.position ?? "auto";
      if (mounted) detachContainer();
      if (!model) return null;
      mounted = model;
      const cl = model?.spec?.external?.length ?? spec.containerLength;
      let y = 0;
      if (cl < 7 && position !== "center") {
        y = position === "front" || position === 1 ? 2.9295 : -2.9295;
      }
      model.root.position.set(0, y, 0);
      model.root.rotation.set(0, 0, 0);
      containerMount.add(model.root);
      return model;
    },
    detachContainer,
    update,
    dispose() {
      detachContainer();
      const disposedGeoms = new Set();
      const disposedMats = new Set();
      root.traverse((o) => {
        if (o.geometry && !disposedGeoms.has(o.geometry)) {
          o.geometry.dispose();
          disposedGeoms.add(o.geometry);
        }
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) {
            if (m && !disposedMats.has(m)) {
              m.dispose();
              disposedMats.add(m);
            }
          }
        }
        if (typeof o.dispose === "function" && o.isInstancedMesh) {
          o.dispose();
        }
      });
    },
  };
}
