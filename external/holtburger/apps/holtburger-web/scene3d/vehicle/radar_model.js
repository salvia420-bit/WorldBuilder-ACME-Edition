// scene3d/vehicle/radar_model.js — Procedural Mobile Air-Search Radar (AN/TPS-1 / SCR-602)
// Implements Feature 37: <= 8 draw calls, 15 RPM rotating articulated parabolic truss dish, CRT scope glow,
// C2S 0x0909 VehicleCargo deploy/pack state machine, 3D terrain LOS with Earth sagitta drop,
// 20-mile range / 1,550m AGL envelope, Monarch/Guild IFF engine, S2C 0x090A telemetry packing.
// Upgraded with shared GeomAcc linear-color/AO builder and unified ISO 6780 1.100 × 1.100 m pallet.

import * as THREE_DEFAULT from "three";
import {
  GeomAcc,
  cShade,
  makeLinearPalette,
  makeDeployablePbrMaterial,
  PALLET_SPECS,
  buildPallet,
} from "./deployable_models.js";

export const RADAR_SPECS = Object.freeze({
  maxRangeM: 32187.0,          // 20 statute miles
  maxCeilingAglM: 1550.0,       // 1,550 m AGL
  minFloorAglM: 8.0,            // 8 m AGL (filters ground clutter)
  dishRpm: 15.0,                // 15 RPM = 0.5*PI rad/s (90 deg/s)
  dishPeriodSec: 4.0,           // 4.0 seconds per revolution
  mastHeightM: 3.1,             // 3.1 m antenna feedhorn elevation
  targetBeaconHeightM: 1.2,     // Target transponder / airframe optical center
  earthRadiusM: 6371000.0,      // Planetary radius for sagitta curvature drop
  maxDrawCalls: 8,              // GTX 1070 draw call ceiling for deployed radar
  deployMaxDistTailgateM: 3.8,  // Maximum on-foot distance to vehicle tailgate
  deployMaxVehicleSpeed: 0.25,  // Maximum vehicle speed to deploy/pack (m/s)
});

export const IFF_STANDING = Object.freeze({
  Unknown: 0,
  Friendly: 1,  // Green
  Neutral: 2,   // Amber
  Hostile: 3,   // Red
});

// C2S 0x0909 VehicleCargo Validator & State Machine
export function handleVehicleCargoAction(action, state = {}) {
  const isDeploy = action === 1;
  const isPack = action === 2;
  if (!isDeploy && !isPack) return { success: false, reason: "invalid_action" };

  const { vehicle, player, cargoLoaded, deployedStation } =
    state && typeof state === "object" ? state : {};
  if (
    !vehicle ||
    !player ||
    !Array.isArray(vehicle.pos) ||
    vehicle.pos.length < 3 ||
    !Array.isArray(player.pos) ||
    player.pos.length < 3
  ) {
    return { success: false, reason: "invalid_state" };
  }

  // Requirement 1: Player must be on-foot outside vehicle
  if (player.isSeated) {
    return { success: false, reason: "player_seated" };
  }

  // Requirement 2: Vehicle must be stopped (|v| <= 0.25 m/s)
  if (!Number.isFinite(vehicle.speed) || Math.abs(vehicle.speed) > RADAR_SPECS.deployMaxVehicleSpeed) {
    return { success: false, reason: "vehicle_moving" };
  }

  if (isDeploy) {
    if (!cargoLoaded) return { success: false, reason: "no_cargo_loaded" };
    if (
      !Number.isFinite(vehicle.heading) ||
      !Number.isFinite(vehicle.pos[0]) ||
      !Number.isFinite(vehicle.pos[1]) ||
      !Number.isFinite(vehicle.pos[2]) ||
      !Number.isFinite(player.pos[0]) ||
      !Number.isFinite(player.pos[1]) ||
      !Number.isFinite(player.pos[2])
    ) {
      return { success: false, reason: "invalid_state" };
    }

    // Distance to tailgate (approx vehicle.pos - forward * 1.6m)
    const tailgatePos = [
      vehicle.pos[0] - Math.sin(vehicle.heading) * 1.6,
      vehicle.pos[1] - Math.cos(vehicle.heading) * 1.6,
      vehicle.pos[2],
    ];
    const distToTailgate = Math.hypot(
      player.pos[0] - tailgatePos[0],
      player.pos[1] - tailgatePos[1],
      player.pos[2] - tailgatePos[2],
    );
    if (!Number.isFinite(distToTailgate) || distToTailgate > RADAR_SPECS.deployMaxDistTailgateM) {
      return { success: false, reason: "too_far_from_tailgate" };
    }

    const stationGuid = 0x80099001;
    const stationPos = [...tailgatePos];
    return {
      success: true,
      action: "deploy",
      stationGuid,
      stationPos,
      cargoLoaded: false,
      eventKind: 13, // CargoDeployed
    };
  }

  if (isPack) {
    if (cargoLoaded || !deployedStation) return { success: false, reason: "no_station_deployed" };
    if (
      !Array.isArray(deployedStation.pos) ||
      deployedStation.pos.length < 3 ||
      !Number.isFinite(deployedStation.pos[0]) ||
      !Number.isFinite(deployedStation.pos[1]) ||
      !Number.isFinite(deployedStation.pos[2]) ||
      !Number.isFinite(player.pos[0]) ||
      !Number.isFinite(player.pos[1]) ||
      !Number.isFinite(player.pos[2])
    ) {
      return { success: false, reason: "invalid_state" };
    }

    const distToStation = Math.hypot(
      player.pos[0] - deployedStation.pos[0],
      player.pos[1] - deployedStation.pos[1],
      player.pos[2] - deployedStation.pos[2],
    );
    if (!Number.isFinite(distToStation) || distToStation > RADAR_SPECS.deployMaxDistTailgateM) {
      return { success: false, reason: "too_far_from_station" };
    }

    return {
      success: true,
      action: "pack",
      cargoLoaded: true,
      eventKind: 14, // CargoPacked
    };
  }
}

// Parabolic curve helper: y(x) relative to dish focal curve
function dishCurveY(x) {
  return -0.16 + (x * x) * 0.24;
}

// Deployed Radar 3D Model Constructor (<= 8 draw calls, mounted atop Standard Unified Pallet)
export function buildDeployedRadar(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const root = new t.Group();
  root.name = "deployed-radar-station";

  // Unified ISO 6780 Pallet (1.100 × 1.100 × 0.145 m, <= 2 draw calls)
  const pallet = buildPallet(t, "standard", options);
  root.add(pallet.root);

  const P = makeLinearPalette(t, {
    tripodSteel: 0x4d5638,
    collarDark: 0x2b3024,
    cabinetOlive: 0x3b442b,
    louverDark: 0x22271b,
    mastGray: 0x6f786a,
    coaxBlack: 0x1e2224,
    bezelDark: 0x181c1a,
    dishRib: 0x7b8568,
    dishMesh: 0x5c644c,
    feedHorn: 0xc28a38,
  });

  const deckZ = PALLET_SPECS.standard.height; // 0.145 m

  // 1. Sculpted 3-leg tubular steel tripod + Stage 1 outer lattice mast + olive-drab transceiver cabinet (1 draw call)
  const baseAcc = new GeomAcc();
  const legAngles = [Math.PI * 0.5, Math.PI * 0.5 + (2 * Math.PI) / 3, Math.PI * 0.5 + (4 * Math.PI) / 3];
  for (const ang of legAngles) {
    const bx = Math.cos(ang) * 0.44;
    const by = Math.sin(ang) * 0.44;
    const tx = Math.cos(ang) * 0.10;
    const ty = Math.sin(ang) * 0.10;
    // Leveling foot collar on pallet deck
    baseAcc.cylinder(bx, by, deckZ + 0.025, 0.055, 0.05, 10, P.collarDark, "z");
    // Tubular tripod leg
    baseAcc.tube([bx, by, deckZ + 0.04], [tx, ty, 0.88], 0.032, 0.026, 8, P.tripodSteel);
    // Diagonal gusset strut bracing leg to mast sleeve
    baseAcc.tube([bx * 0.62, by * 0.62, deckZ + 0.30], [tx * 0.85, ty * 0.85, 0.56], 0.016, 0.016, 6, P.collarDark);
  }
  // Stage 1 outer mast collar & lattice sleeve (z = 0.145..1.42)
  baseAcc.cylinder(0, 0, 0.78, 0.088, 1.27, 10, P.tripodSteel, "z");
  baseAcc.cylinder(0, 0, 1.40, 0.105, 0.06, 10, P.collarDark, "z");

  // Olive-drab transceiver/generator cabinet (strictly within ±0.43 m in X/Y -> zero overhang!)
  baseAcc.bevelBox(0, 0.19, deckZ + 0.22, 0.28, 0.22, 0.22, 0.025, P.cabinetOlive, cShade(P.cabinetOlive, 0.82));
  // Side cooling louvers
  for (const sx of [-0.285, 0.285]) {
    for (let lz = deckZ + 0.10; lz <= deckZ + 0.34; lz += 0.06) {
      baseAcc.box(sx, 0.19, lz, 0.008, 0.14, 0.014, P.louverDark);
    }
  }
  // Coaxial feed conduit from cabinet up into mast
  baseAcc.tube([0.16, 0.08, deckZ + 0.44], [0.06, 0.0, 0.90], 0.018, 0.018, 8, P.coaxBlack);
  // Recessed CRT scope bezel on +Y front face (y = +0.415 <= 0.550 m)
  baseAcc.bevelBox(0, 0.412, deckZ + 0.24, 0.125, 0.014, 0.095, 0.012, P.bezelDark);

  const matSteel = makeDeployablePbrMaterial(t, { roughness: 0.54, metalness: 0.44, csmState: options.csmState });
  const tripodCabinetMesh = new t.Mesh(baseAcc.toBufferGeometry(t), matSteel);
  tripodCabinetMesh.name = "radar-tripod-cabinet";
  tripodCabinetMesh.castShadow = true;
  tripodCabinetMesh.receiveShadow = true;
  root.add(tripodCabinetMesh);

  // 2. CRT phosphor-green scope window (AdditiveBlending, depthWrite: false, ZERO THREE.Light churn)
  const matCrtGlow = new t.MeshBasicMaterial({
    color: 0x33ff66,
    transparent: true,
    opacity: 0.85,
    blending: t.AdditiveBlending,
    depthWrite: false,
  });
  const crtWindow = new t.Mesh(new t.BoxGeometry(0.20, 0.012, 0.14), matCrtGlow);
  crtWindow.name = "crt-phosphor-scope";
  crtWindow.position.set(0, 0.424, deckZ + 0.24);
  root.add(crtWindow);

  // 3. Stage 2 telescoping mast tube + collar (slides vertically — no scale distortion!)
  const mastAcc = new GeomAcc();
  mastAcc.cylinder(0, 0, 0, 0.064, 1.16, 10, P.mastGray, "z");
  mastAcc.cylinder(0, 0, 0.56, 0.084, 0.06, 10, P.collarDark, "z");
  const mastMesh = new t.Mesh(mastAcc.toBufferGeometry(t), matSteel);
  mastMesh.name = "radar-mast";
  mastMesh.position.set(0, 0, 1.82);
  mastMesh.castShadow = true;
  mastMesh.receiveShadow = true;
  root.add(mastMesh);

  // 4. Rotating articulated parabolic mesh-truss reflector dish (3 meshes inside dishPivot)
  const dishPivot = new t.Group();
  dishPivot.name = "dishPivot";
  dishPivot.position.set(0, 0, RADAR_SPECS.mastHeightM);

  const matDish = makeDeployablePbrMaterial(t, { roughness: 0.42, metalness: 0.55, csmState: options.csmState });

  // Helper to build parabolic truss reflector ribs & perforated lattice bars over [x0, x1]
  function addParabolicSection(acc, x0, x1, steps, includeBackSpine = false) {
    const zLevels = [-0.36, -0.18, 0.0, 0.18, 0.36];
    for (let s = 0; s < steps; s++) {
      const xa = x0 + ((x1 - x0) * s) / steps;
      const xb = x0 + ((x1 - x0) * (s + 1)) / steps;
      const ya = dishCurveY(xa);
      const yb = dishCurveY(xb);
      for (let zi = 0; zi < zLevels.length; zi++) {
        const z = zLevels[zi];
        const r = (zi === 0 || zi === zLevels.length - 1) ? 0.018 : 0.010;
        const col = (zi === 0 || zi === zLevels.length - 1) ? P.dishRib : P.dishMesh;
        acc.tube([xa, ya, z], [xb, yb, z], r, r, 6, col);
      }
      // Vertical reflector mesh struts
      const xm = (xa + xb) * 0.5;
      const ym = dishCurveY(xm);
      acc.tube([xm, ym, -0.36], [xm, ym, 0.36], 0.008, 0.008, 6, P.dishMesh);
    }
    // End boundary vertical rib
    for (const xe of [x0, x1]) {
      const ye = dishCurveY(xe);
      acc.tube([xe, ye, -0.36], [xe, ye, 0.36], 0.018, 0.018, 6, P.dishRib);
    }
    if (includeBackSpine) {
      acc.bevelBox(0, -0.20, 0, 0.16, 0.04, 0.32, 0.012, P.tripodSteel);
    }
  }

  // 4a. Center spine + Stage 3 upper rotary shaft + central feedhorn boom (1 draw call)
  const centerAcc = new GeomAcc();
  // Stage 3 upper rotary shaft extending below dishPivot
  centerAcc.cylinder(0, 0, -0.41, 0.045, 0.82, 10, P.mastGray, "z");
  centerAcc.cylinder(0, 0, 0.0, 0.080, 0.08, 10, P.collarDark, "z");
  addParabolicSection(centerAcc, -0.35, 0.35, 6, true);
  // Central feedhorn boom, upper brace, twin mast-clearing lower A-frame struts & horn cone
  centerAcc.tube([0, -0.16, 0.0], [0, 0.32, 0.0], 0.020, 0.014, 8, P.tripodSteel);
  centerAcc.tube([0, -0.14, 0.32], [0, 0.28, 0.02], 0.010, 0.010, 6, P.collarDark);
  const lowerBraceY = dishCurveY(0.25);
  centerAcc.tube([-0.25, lowerBraceY, -0.34], [-0.015, 0.28, -0.02], 0.010, 0.010, 6, P.collarDark);
  centerAcc.tube([0.25, lowerBraceY, -0.34], [0.015, 0.28, -0.02], 0.010, 0.010, 6, P.collarDark);
  centerAcc.cone(0, 0.28, 0.0, 0.025, 0.065, 0.09, 10, P.feedHorn, "y");

  const dishCenterMesh = new t.Mesh(centerAcc.toBufferGeometry(t), matDish);
  dishCenterMesh.name = "parabolic-dish-reflector";
  dishCenterMesh.castShadow = true;
  dishCenterMesh.receiveShadow = true;
  dishPivot.add(dishCenterMesh);

  // 4b. Left articulated wing (x ∈ [-0.85, -0.35] deployed; folds +Y inside |x|,|y| <= 0.44 m stowed)
  const leftWingPivot = new t.Group();
  leftWingPivot.name = "dish-left-wing-pivot";
  leftWingPivot.position.set(-0.35, dishCurveY(-0.35), 0);
  const leftAcc = new GeomAcc();
  const dyLeft = dishCurveY(-0.35);
  // Build relative to pivot (-0.35, dyLeft, 0)
  (function buildLeftWing() {
    const steps = 4;
    const zLevels = [-0.36, -0.18, 0.0, 0.18, 0.36];
    for (let s = 0; s < steps; s++) {
      const xa = -0.35 - (0.50 * s) / steps;
      const xb = -0.35 - (0.50 * (s + 1)) / steps;
      const ya = dishCurveY(xa) - dyLeft;
      const yb = dishCurveY(xb) - dyLeft;
      for (let zi = 0; zi < zLevels.length; zi++) {
        const z = zLevels[zi];
        const r = (zi === 0 || zi === zLevels.length - 1) ? 0.018 : 0.010;
        const col = (zi === 0 || zi === zLevels.length - 1) ? P.dishRib : P.dishMesh;
        leftAcc.tube([xa + 0.35, ya, z], [xb + 0.35, yb, z], r, r, 6, col);
      }
      const xm = (xa + xb) * 0.5;
      const ym = dishCurveY(xm) - dyLeft;
      leftAcc.tube([xm + 0.35, ym, -0.36], [xm + 0.35, ym, 0.36], 0.008, 0.008, 6, P.dishMesh);
    }
    leftAcc.tube([-0.50, dishCurveY(-0.85) - dyLeft, -0.36], [-0.50, dishCurveY(-0.85) - dyLeft, 0.36], 0.018, 0.018, 6, P.dishRib);
  })();
  const dishLeftMesh = new t.Mesh(leftAcc.toBufferGeometry(t), matDish);
  dishLeftMesh.name = "parabolic-dish-left-wing";
  dishLeftMesh.castShadow = true;
  dishLeftMesh.receiveShadow = true;
  leftWingPivot.add(dishLeftMesh);
  dishPivot.add(leftWingPivot);

  // 4c. Right articulated wing (x ∈ [+0.35, +0.85] deployed; folds +Y inside |x|,|y| <= 0.44 m stowed)
  const rightWingPivot = new t.Group();
  rightWingPivot.name = "dish-right-wing-pivot";
  rightWingPivot.position.set(0.35, dishCurveY(0.35), 0);
  const rightAcc = new GeomAcc();
  const dyRight = dishCurveY(0.35);
  (function buildRightWing() {
    const steps = 4;
    const zLevels = [-0.36, -0.18, 0.0, 0.18, 0.36];
    for (let s = 0; s < steps; s++) {
      const xa = 0.35 + (0.50 * s) / steps;
      const xb = 0.35 + (0.50 * (s + 1)) / steps;
      const ya = dishCurveY(xa) - dyRight;
      const yb = dishCurveY(xb) - dyRight;
      for (let zi = 0; zi < zLevels.length; zi++) {
        const z = zLevels[zi];
        const r = (zi === 0 || zi === zLevels.length - 1) ? 0.018 : 0.010;
        const col = (zi === 0 || zi === zLevels.length - 1) ? P.dishRib : P.dishMesh;
        rightAcc.tube([xa - 0.35, ya, z], [xb - 0.35, yb, z], r, r, 6, col);
      }
      const xm = (xa + xb) * 0.5;
      const ym = dishCurveY(xm) - dyRight;
      rightAcc.tube([xm - 0.35, ym, -0.36], [xm - 0.35, ym, 0.36], 0.008, 0.008, 6, P.dishMesh);
    }
    rightAcc.tube([0.50, dishCurveY(0.85) - dyRight, -0.36], [0.50, dishCurveY(0.85) - dyRight, 0.36], 0.018, 0.018, 6, P.dishRib);
  })();
  const dishRightMesh = new t.Mesh(rightAcc.toBufferGeometry(t), matDish);
  dishRightMesh.name = "parabolic-dish-right-wing";
  dishRightMesh.castShadow = true;
  dishRightMesh.receiveShadow = true;
  rightWingPivot.add(dishRightMesh);
  dishPivot.add(rightWingPivot);

  root.add(dishPivot);

  let currentAzimuth = 0;
  let isStowed = false;

  function setStowed(stowed) {
    isStowed = Boolean(stowed);
    pallet.setStowed(isStowed);
    if (isStowed) {
      // Collapse 3-stage telescoping mast & fold both dish wings ±82° inward inside <= 0.52 m, H <= 2.00 m
      mastMesh.position.set(0, 0, 0.86);
      dishPivot.position.set(0, 0, 1.56);
      dishPivot.rotation.z = 0;
      currentAzimuth = 0;
      leftWingPivot.rotation.z = -1.43;
      rightWingPivot.rotation.z = 1.43;
      matCrtGlow.color.setHex(0xffaa22);
      matCrtGlow.opacity = 0.25;
    } else {
      mastMesh.position.set(0, 0, 1.82);
      dishPivot.position.set(0, 0, RADAR_SPECS.mastHeightM);
      leftWingPivot.rotation.z = 0;
      rightWingPivot.rotation.z = 0;
      matCrtGlow.color.setHex(0x33ff66);
      matCrtGlow.opacity = 0.85;
    }
  }
  setStowed(Boolean(options.stowed));

  return {
    root,
    dishPivot,
    leftWingPivot,
    rightWingPivot,
    crtWindow,
    pallet,
    wcid: 4000002,
    palletSize: "full",
    get currentAzimuth() {
      return currentAzimuth;
    },
    get stowed() {
      return isStowed;
    },
    setStowed,
    setDeployed(deployed) {
      setStowed(!deployed);
    },
    update(simTimeSec = 0) {
      let tSec = simTimeSec;
      if (simTimeSec && typeof simTimeSec === "object") {
        if (simTimeSec.stowed !== undefined) setStowed(simTimeSec.stowed);
        tSec = simTimeSec.simTimeSec ?? 0;
      }
      if (isStowed) return;
      // 15 RPM deterministic from simTimeSec: (simTimeSec * 15 * 2 * PI / 60) % (2 * PI)
      const safeTime = Number.isFinite(tSec) ? tSec : 0;
      const omega = (RADAR_SPECS.dishRpm * 2 * Math.PI) / 60.0; // 0.5 * PI rad/s
      currentAzimuth = (safeTime * omega) % (2 * Math.PI);
      if (currentAzimuth < 0) currentAzimuth += 2 * Math.PI;
      if (Math.abs(currentAzimuth - 2 * Math.PI) < 1e-4) currentAzimuth = 0;
      dishPivot.rotation.z = currentAzimuth;
    },
    dispose() {
      pallet.dispose();
      const skip = new Set([pallet.mesh, pallet.levelingJacks]);
      const geoms = new Set();
      const mats = new Set();
      root.traverse((obj) => {
        if (skip.has(obj)) return;
        if (obj.geometry && !geoms.has(obj.geometry)) {
          obj.geometry.dispose();
          geoms.add(obj.geometry);
        }
        if (obj.material) {
          const list = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const m of list) {
            if (m && !mats.has(m)) {
              m.dispose();
              mats.add(m);
            }
          }
        }
      });
    },
  };
}

// Earth Curvature Sagitta Drop: z = s*(D - s) / (2 * R_E)
export function computeEarthSagittaDrop(s, D) {
  if (!Number.isFinite(s) || !Number.isFinite(D)) return 0.0;
  if (D <= 0 || s <= 0 || s >= D) return 0.0;
  return (s * (D - s)) / (2.0 * RADAR_SPECS.earthRadiusM);
}

// 3D Terrain Line-of-Sight with Curvature Drop Raymarch
export function checkRadarLos(radarPos, targetPos, terrainOracle) {
  if (!Array.isArray(radarPos) || !Array.isArray(targetPos)) return false;
  if (
    radarPos.length < 3 || targetPos.length < 3 ||
    !Number.isFinite(radarPos[0]) || !Number.isFinite(radarPos[1]) || !Number.isFinite(radarPos[2]) ||
    !Number.isFinite(targetPos[0]) || !Number.isFinite(targetPos[1]) || !Number.isFinite(targetPos[2])
  ) {
    return false;
  }
  const dx = targetPos[0] - radarPos[0];
  const dy = targetPos[1] - radarPos[1];
  const D = Math.hypot(dx, dy);
  if (!Number.isFinite(D)) return false;
  if (D < 1e-4) return true; // Zero-distance target directly overhead

  const z0 = radarPos[2] + RADAR_SPECS.mastHeightM;
  const z1 = targetPos[2] + RADAR_SPECS.targetBeaconHeightM;

  // Sample along ray in 250m steps
  const stepM = 250.0;
  const steps = Math.ceil(D / stepM);

  for (let i = 1; i < steps; i++) {
    const s = (i / steps) * D;
    const frac = s / D;
    const sx = radarPos[0] + dx * frac;
    const sy = radarPos[1] + dy * frac;

    const sagitta = computeEarthSagittaDrop(s, D);
    const rayZ = z0 + frac * (z1 - z0) - sagitta;

    const terrainZ = terrainOracle ? terrainOracle(sx, sy) : 0.0;
    if (!Number.isFinite(terrainZ) || terrainZ > rayZ) {
      return false; // Occluded by terrain or invalid terrain height
    }
  }
  return true;
}

// Autonomous Detection Filter (Range, Ceiling, Floor, Locomotion)
export function isTargetDetected(radarPos, target) {
  if (!Array.isArray(radarPos) || radarPos.length < 2 || !target || !Array.isArray(target.pos) || target.pos.length < 2) {
    return false;
  }
  if (
    !Number.isFinite(radarPos[0]) || !Number.isFinite(radarPos[1]) ||
    (radarPos.length >= 3 && !Number.isFinite(radarPos[2])) ||
    !Number.isFinite(target.pos[0]) || !Number.isFinite(target.pos[1]) ||
    (target.pos.length >= 3 && !Number.isFinite(target.pos[2]))
  ) {
    return false;
  }

  // 1. Locomotion filter: must be Air (Locomotion == 1)
  if (target.locomotion !== 1) return false;

  // 2. Horizontal distance check (<= 32,187m)
  const dist = Math.hypot(target.pos[0] - radarPos[0], target.pos[1] - radarPos[1]);
  if (!Number.isFinite(dist) || dist > RADAR_SPECS.maxRangeM) return false;

  // 3. Altitude AGL checks (8m <= AGL <= 1,550m)
  const agl = target.altitudeAgl;
  if (!Number.isFinite(agl) || agl < RADAR_SPECS.minFloorAglM || agl > RADAR_SPECS.maxCeilingAglM) return false;

  return true;
}

// IFF Resolution & Monarch Policy Engine
export function resolveIffStanding(target, radarOwner, policy = {}) {
  if (!target || typeof target !== "object" || !radarOwner || typeof radarOwner !== "object") {
    return IFF_STANDING.Unknown;
  }
  const safePolicy = policy && typeof policy === "object" ? policy : {};

  // Same monarch -> Friendly
  if (target.monarchId && target.monarchId === radarOwner.monarchId) {
    return IFF_STANDING.Friendly;
  }
  // Same pilot GUID -> Friendly
  if (target.pilotGuid && target.pilotGuid === radarOwner.ownerGuid) {
    return IFF_STANDING.Friendly;
  }
  // Same fellowship -> Friendly
  if (target.fellowshipId && target.fellowshipId === radarOwner.fellowshipId) {
    return IFF_STANDING.Friendly;
  }

  // Check GuildRadarPolicy by MonarchId
  if (target.monarchId && safePolicy.byId && typeof safePolicy.byId === "object") {
    const key = String(target.monarchId);
    if (Object.hasOwn(safePolicy.byId, key)) {
      const standing = safePolicy.byId[key];
      if (Number.isInteger(standing) && standing >= IFF_STANDING.Unknown && standing <= IFF_STANDING.Hostile) {
        return standing;
      }
    }
  }

  // Check GuildRadarPolicy by MonarchName (case-insensitive)
  if (typeof target.monarchName === "string" && target.monarchName && safePolicy.byName && typeof safePolicy.byName === "object") {
    const targetNameLower = target.monarchName.toLowerCase();
    for (const [name, standing] of Object.entries(safePolicy.byName)) {
      if (
        typeof name === "string" &&
        name.toLowerCase() === targetNameLower &&
        Number.isInteger(standing) &&
        standing >= IFF_STANDING.Unknown &&
        standing <= IFF_STANDING.Hostile
      ) {
        return standing;
      }
    }
  }

  // Default for unlisted foreign contacts -> Hostile
  return IFF_STANDING.Hostile;
}

// S2C 0x090A VehicleRadarContacts Wire Packing
export function encodeRadarContactsPacket(stationGuid, contacts) {
  const list = Array.isArray(contacts) ? contacts : [];
  return {
    opcode: 0x090a,
    stationGuid,
    contactCount: list.length,
    contacts: list.map((c) => {
      const hRaw = Number.isFinite(c?.heading) ? c.heading : 0;
      return {
        guid: c?.guid ?? 0,
        dx: Number.isFinite(c?.dx) ? Math.round(c.dx) : 0,
        dy: Number.isFinite(c?.dy) ? Math.round(c.dy) : 0,
        altAgl: Number.isFinite(c?.altAgl) ? Math.round(c.altAgl) : 0,
        heading: Math.round(((hRaw % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)) * (255 / (2 * Math.PI))),
        standing: Number.isFinite(c?.standing) ? c.standing : IFF_STANDING.Unknown,
        speed: Number.isFinite(c?.speed) ? Math.round(c.speed) : 0,
      };
    }),
  };
}

export const manifest = Object.freeze({
  id: "vfx-radar-model",
  channel: "radarModel",
  deterministic: true,
  lightCountDelta: 0,
  cacheKeyScope: "set",
  reads: ["geometry", "serverPose", "clock"],
  writes: ["renderTransform", "partTransform"],
});
