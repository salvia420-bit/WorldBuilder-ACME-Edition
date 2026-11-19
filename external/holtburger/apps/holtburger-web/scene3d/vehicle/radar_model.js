// scene3d/vehicle/radar_model.js — Procedural Mobile Air-Search Radar (AN/TPS-1 / SCR-602)
// Implements Feature 37: <= 8 draw calls, 5 sub-meshes, 15 RPM rotating dish, CRT scope glow,
// C2S 0x0909 VehicleCargo deploy/pack state machine, 3D terrain LOS with Earth sagitta drop,
// 20-mile range / 1,550m AGL envelope, Monarch/Guild IFF engine, S2C 0x090A telemetry packing.

import * as THREE_DEFAULT from "three";
import { buildPallet } from "./deployable_models.js";
import { installCsmShaderPatch } from "../materials.js";

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
export function handleVehicleCargoAction(action, { vehicle, player, cargoLoaded, deployedStation }) {
  const isDeploy = action === 1;
  const isPack = action === 2;
  if (!isDeploy && !isPack) return { success: false, reason: "invalid_action" };

  // Requirement 1: Player must be on-foot outside vehicle
  if (player.isSeated) {
    return { success: false, reason: "player_seated" };
  }

  // Requirement 2: Vehicle must be stopped (|v| <= 0.25 m/s)
  if (Math.abs(vehicle.speed) > RADAR_SPECS.deployMaxVehicleSpeed) {
    return { success: false, reason: "vehicle_moving" };
  }

  if (isDeploy) {
    if (!cargoLoaded) return { success: false, reason: "no_cargo_loaded" };

    // Distance to tailgate (approx vehicle.pos - forward * 1.6m)
    const tailgatePos = [
      vehicle.pos[0] - Math.sin(vehicle.heading) * 1.6,
      vehicle.pos[1] - Math.cos(vehicle.heading) * 1.6,
      vehicle.pos[2],
    ];
    const distToTailgate = Math.hypot(
      player.pos[0] - tailgatePos[0],
      player.pos[1] - tailgatePos[1],
      player.pos[2] - tailgatePos[2]
    );
    if (distToTailgate > RADAR_SPECS.deployMaxDistTailgateM) {
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

    const distToStation = Math.hypot(
      player.pos[0] - deployedStation.pos[0],
      player.pos[1] - deployedStation.pos[1],
      player.pos[2] - deployedStation.pos[2]
    );
    if (distToStation > RADAR_SPECS.deployMaxDistTailgateM) {
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

// Deployed Radar 3D Model Constructor (<= 8 draw calls, mounted atop Full GMA Pallet)
export function buildDeployedRadar(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const root = new t.Group();
  root.name = "deployed-radar-station";

  // Mount directly atop a Full GMA Pallet (1.2192 × 1.0160 × 0.1397 m)
  const pallet = buildPallet(t, "full", options);
  root.add(pallet.root);

  const deckZ = 0.1397; // Full GMA pallet top deck elevation
  // Telescoping mast: stowed collapses to <= 2.10 m (1.80 m, total height <= 2.04 m); deployed 3.10 m
  const fullMastH = RADAR_SPECS.mastHeightM;

  const matSteel = new t.MeshStandardMaterial({
    color: 0x4a5234,
    roughness: 0.55,
    metalness: 0.45,
  });
  matSteel.castShadow = true;
  matSteel.receiveShadow = true;

  const matCabinet = new t.MeshStandardMaterial({
    color: 0x3b442b,
    roughness: 0.65,
    metalness: 0.35,
  });
  matCabinet.castShadow = true;
  matCabinet.receiveShadow = true;

  const matDishWire = new t.MeshStandardMaterial({
    color: 0x7c8567,
    wireframe: true,
    roughness: 0.40,
    metalness: 0.60,
  });
  matDishWire.castShadow = true;
  matDishWire.receiveShadow = true;

  if (options.csmState) {
    installCsmShaderPatch(matSteel, options.csmState);
    installCsmShaderPatch(matCabinet, options.csmState);
    installCsmShaderPatch(matDishWire, options.csmState);
  }

  const matCrtGlow = new t.MeshBasicMaterial({
    color: 0x33ff66,
    transparent: true,
    opacity: 0.85,
    blending: t.AdditiveBlending,
    depthWrite: false,
  });

  // 1. Heavy steel tripod base (radius r = 0.46 m fits within Full GMA pallet r <= 0.48 m)
  const tripodGeom = new t.CylinderGeometry(0.06, 0.46, 0.50, 3).toNonIndexed();
  const tripodMesh = new t.Mesh(tripodGeom, matSteel);
  tripodMesh.name = "radar-tripod";
  tripodMesh.position.set(0, 0, deckZ + 0.25);
  tripodMesh.castShadow = true;
  tripodMesh.receiveShadow = true;
  root.add(tripodMesh);

  // 2. Telescoping antenna mast (cylinder axis is local +Y, rotated +PI/2 around X to point along +Z)
  const mastGeom = new t.CylinderGeometry(0.05, 0.07, fullMastH, 8);
  const mastMesh = new t.Mesh(mastGeom, matSteel);
  mastMesh.name = "radar-mast";
  mastMesh.position.set(0, 0, deckZ + fullMastH / 2);
  mastMesh.rotation.x = Math.PI / 2;
  mastMesh.castShadow = true;
  mastMesh.receiveShadow = true;
  root.add(mastMesh);

  // 3. Transceiver generator cabinet
  const cabinetMesh = new t.Mesh(new t.BoxGeometry(0.60, 0.48, 0.46), matCabinet);
  cabinetMesh.name = "radar-cabinet";
  cabinetMesh.position.set(0, 0.22, deckZ + 0.23);
  cabinetMesh.castShadow = true;
  cabinetMesh.receiveShadow = true;
  root.add(cabinetMesh);

  // 4. CRT phosphor green scope window (matAdditive, ZERO THREE.Light churn)
  const crtWindow = new t.Mesh(new t.CircleGeometry(0.12, 16), matCrtGlow);
  crtWindow.name = "crt-phosphor-scope";
  crtWindow.position.set(0, 0.47, deckZ + 0.28);
  root.add(crtWindow);

  // 5. Rotating parabolic reflector dish
  const dishPivot = new t.Group();
  dishPivot.name = "dishPivot";
  dishPivot.position.set(0, 0, deckZ + fullMastH);

  const dishMesh = new t.Mesh(new t.SphereGeometry(0.90, 16, 8, 0, Math.PI), matDishWire);
  dishMesh.name = "parabolic-dish-reflector";
  dishMesh.rotation.x = Math.PI / 2;
  dishMesh.castShadow = true;
  dishMesh.receiveShadow = true;
  dishPivot.add(dishMesh);
  root.add(dishPivot);

  let currentAzimuth = 0;
  let isStowed = false;

  function setStowed(stowed) {
    isStowed = Boolean(stowed);
    const mastH = isStowed ? 1.80 : fullMastH;
    mastMesh.scale.set(1, mastH / fullMastH, 1);
    mastMesh.position.set(0, 0, deckZ + mastH / 2);
    dishPivot.position.set(0, 0, deckZ + mastH);
    if (isStowed) {
      dishPivot.rotation.z = 0;
      currentAzimuth = 0;
      dishMesh.scale.setScalar(0.20 / 0.90);
      dishMesh.rotation.x = Math.PI;
      matCrtGlow.color.setHex(0xffaa22);
      matCrtGlow.opacity = 0.25;
    } else {
      dishMesh.scale.setScalar(1);
      dishMesh.rotation.x = Math.PI / 2;
      matCrtGlow.color.setHex(0x33ff66);
      matCrtGlow.opacity = 0.85;
    }
  }
  setStowed(Boolean(options.stowed));

  return {
    root,
    dishPivot,
    crtWindow,
    pallet,
    wcid: 4000002,
    palletSize: "full",
    get currentAzimuth() { return currentAzimuth; },
    get stowed() { return isStowed; },
    setStowed,
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
      const geoms = new Set();
      const mats = new Set();
      root.traverse((obj) => {
        if (obj === pallet.mesh) return;
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
  if (D <= 0 || s <= 0 || s >= D) return 0.0;
  return (s * (D - s)) / (2.0 * RADAR_SPECS.earthRadiusM);
}

// 3D Terrain Line-of-Sight with Curvature Drop Raymarch
export function checkRadarLos(radarPos, targetPos, terrainOracle) {
  const dx = targetPos[0] - radarPos[0];
  const dy = targetPos[1] - radarPos[1];
  const D = Math.hypot(dx, dy);
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
    if (terrainZ > rayZ) {
      return false; // Occluded by terrain
    }
  }
  return true;
}

// Autonomous Detection Filter (Range, Ceiling, Floor, Locomotion)
export function isTargetDetected(radarPos, target) {
  // 1. Locomotion filter: must be Air (Locomotion == 1)
  if (target.locomotion !== 1) return false;

  // 2. Horizontal distance check (<= 32,187m)
  const dist = Math.hypot(target.pos[0] - radarPos[0], target.pos[1] - radarPos[1]);
  if (dist > RADAR_SPECS.maxRangeM) return false;

  // 3. Altitude AGL checks (8m <= AGL <= 1,550m)
  const agl = target.altitudeAgl;
  if (agl < RADAR_SPECS.minFloorAglM || agl > RADAR_SPECS.maxCeilingAglM) return false;

  return true;
}

// IFF Resolution & Monarch Policy Engine
export function resolveIffStanding(target, radarOwner, policy = {}) {
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
  if (target.monarchId && policy.byId && policy.byId[target.monarchId] !== undefined) {
    return policy.byId[target.monarchId];
  }

  // Check GuildRadarPolicy by MonarchName (case-insensitive)
  if (target.monarchName && policy.byName) {
    const targetNameLower = target.monarchName.toLowerCase();
    for (const [name, standing] of Object.entries(policy.byName)) {
      if (name.toLowerCase() === targetNameLower) return standing;
    }
  }

  // Default for unlisted foreign contacts -> Hostile
  return IFF_STANDING.Hostile;
}

// S2C 0x090A VehicleRadarContacts Wire Packing
export function encodeRadarContactsPacket(stationGuid, contacts) {
  return {
    opcode: 0x090a,
    stationGuid,
    contactCount: contacts.length,
    contacts: contacts.map((c) => ({
      guid: c.guid,
      dx: Math.round(c.dx),
      dy: Math.round(c.dy),
      altAgl: Math.round(c.altAgl),
      heading: Math.round(((c.heading % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)) * (255 / (2 * Math.PI))),
      standing: c.standing,
      speed: Math.round(c.speed),
    })),
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
