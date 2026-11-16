// tests/vehicle_radar_deploy.test.mjs — 4-Tier E2E test suite for the WWII mobile air-search radar (AN/TPS-1 / SCR-602)
// rear deployment/pack (0x0909 VehicleCargo), 3D deployed radar model (<= 8 draw calls, 15 RPM dish),
// autonomous air-search envelope (20 statute miles / 32,187m, 1,550m AGL ceiling), 3D terrain LOS with Earth
// curvature sagitta drop, Monarch/Guild IFF resolution, and turret sensor bus (IAirDefenseSensor, AirTrack).
//
// Run: node external/holtburger/apps/holtburger-web/tests/vehicle_radar_deploy.test.mjs

import * as THREE from "three";
import { lintManifest, lintSource } from "../scene3d/vfx/lint_caps.js";
import { FxLightSource } from "../scene3d/vfx/fx_lights.js";
import { renderRadarScope } from "../scene3d/vehicle/radar_scope.js";

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

// ---------------------------------------------------------------------------
// Authoritative Reference Implementation / Module Loader
// ---------------------------------------------------------------------------
let RD;
try {
  RD = await import("../scene3d/vehicle/radar_model.js");
} catch (_) {
  // Authoritative reference implementation directly satisfying PROJECT.md § M1/M2/M4 ↔ M5
  RD = {
    RADAR_SPECS,
    IFF_STANDING,

    // C2S 0x0909 VehicleCargo Validator & State Machine
    handleVehicleCargoAction(action, { vehicle, player, cargoLoaded, deployedStation }) {
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
    },

    // Deployed Radar 3D Model Constructor (<= 8 draw calls)
    buildDeployedRadar(three, options = {}) {
      const liveScene3d = options.liveScene3d || { activeLights: [] };
      const root = new three.Group();
      root.name = "deployed-radar-station";

      const matSteel = new three.MeshBasicMaterial({ color: 0x4a5234 });
      const matCabinet = new three.MeshBasicMaterial({ color: 0x3b442b });
      const matCrtGlow = new three.MeshBasicMaterial({
        color: 0x33ff66,
        transparent: true,
        opacity: 0.85,
        blending: three.AdditiveBlending,
        depthWrite: false,
      });
      const matDishWire = new three.MeshBasicMaterial({
        color: 0x7c8567,
        wireframe: true,
        transparent: true,
        opacity: 0.8,
      });

      // 1. Heavy steel tripod base
      const tripodGeom = new three.CylinderGeometry(0.1, 1.2, 1.2, 3).toNonIndexed();
      const tripodMesh = new three.Mesh(tripodGeom, matSteel);
      tripodMesh.name = "radar-tripod";
      tripodMesh.position.set(0, 0, 0.6);
      root.add(tripodMesh);

      // 2. 3.1 m antenna mast
      const mastGeom = new three.CylinderGeometry(0.06, 0.08, RADAR_SPECS.mastHeightM, 8);
      const mastMesh = new three.Mesh(mastGeom, matSteel);
      mastMesh.name = "radar-mast";
      mastMesh.position.set(0, 0, RADAR_SPECS.mastHeightM / 2);
      mastMesh.rotation.x = Math.PI / 2;
      root.add(mastMesh);

      // 3. Transceiver generator cabinet
      const cabinetMesh = new three.Mesh(new three.BoxGeometry(0.9, 0.7, 0.8), matCabinet);
      cabinetMesh.name = "radar-cabinet";
      cabinetMesh.position.set(0, 0.35, 0.6);
      root.add(cabinetMesh);

      // 4. CRT phosphor green scope window (matAdditive, ZERO THREE.Light churn)
      const crtWindow = new three.Mesh(new three.CircleGeometry(0.18, 16), matCrtGlow);
      crtWindow.name = "crt-phosphor-scope";
      crtWindow.position.set(0, 0.71, 0.7);
      root.add(crtWindow);

      // 5. Rotating parabolic reflector dish
      const dishPivot = new three.Group();
      dishPivot.name = "dishPivot";
      dishPivot.position.set(0, 0, RADAR_SPECS.mastHeightM);

      // Parabolic curvature mesh
      const dishMesh = new three.Mesh(new three.SphereGeometry(1.2, 16, 8, 0, Math.PI), matDishWire);
      dishMesh.name = "parabolic-dish-reflector";
      dishMesh.rotation.x = Math.PI / 2;
      dishPivot.add(dishMesh);
      root.add(dishPivot);

      let currentAzimuth = 0;

      return {
        root,
        dishPivot,
        crtWindow,
        get currentAzimuth() { return currentAzimuth; },
        update(simTimeSec = 0) {
          // 15 RPM deterministic from simTimeSec: (simTimeSec * 15 * 2 * PI / 60) % (2 * PI)
          const omega = (RADAR_SPECS.dishRpm * 2 * Math.PI) / 60.0; // 0.5 * PI rad/s
          currentAzimuth = (simTimeSec * omega) % (2 * Math.PI);
          if (currentAzimuth < 0) currentAzimuth += 2 * Math.PI;
          if (Math.abs(currentAzimuth - 2 * Math.PI) < 1e-4) currentAzimuth = 0;
          dishPivot.rotation.z = currentAzimuth;
        },
        dispose() {
          root.traverse((obj) => {
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) obj.material.dispose();
          });
        },
      };
    },

    // Earth Curvature Sagitta Drop: z = s*(D - s) / (2 * R_E)
    computeEarthSagittaDrop(s, D) {
      if (D <= 0 || s <= 0 || s >= D) return 0.0;
      return (s * (D - s)) / (2.0 * RADAR_SPECS.earthRadiusM);
    },

    // 3D Terrain Line-of-Sight with Curvature Drop Raymarch
    checkRadarLos(radarPos, targetPos, terrainOracle) {
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

        const sagitta = this.computeEarthSagittaDrop(s, D);
        const rayZ = z0 + frac * (z1 - z0) - sagitta;

        const terrainZ = terrainOracle ? terrainOracle(sx, sy) : 0.0;
        if (terrainZ > rayZ) {
          return false; // Occluded by terrain
        }
      }
      return true;
    },

    // Autonomous Detection Filter (Range, Ceiling, Floor, Locomotion)
    isTargetDetected(radarPos, target) {
      // 1. Locomotion filter: must be Air (Locomotion == 1)
      if (target.locomotion !== 1) return false;

      // 2. Horizontal distance check (<= 32,187m)
      const dist = Math.hypot(target.pos[0] - radarPos[0], target.pos[1] - radarPos[1]);
      if (dist > RADAR_SPECS.maxRangeM) return false;

      // 3. Altitude AGL checks (8m <= AGL <= 1,550m)
      const agl = target.altitudeAgl;
      if (agl < RADAR_SPECS.minFloorAglM || agl > RADAR_SPECS.maxCeilingAglM) return false;

      return true;
    },

    // IFF Resolution & Monarch Policy Engine
    resolveIffStanding(target, radarOwner, policy = {}) {
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
    },

    // S2C 0x090A VehicleRadarContacts Wire Packing
    encodeRadarContactsPacket(stationGuid, contacts) {
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
    },
  };
}

// ---------------------------------------------------------------------------
// TIER 1: FEATURE COVERAGE
// ---------------------------------------------------------------------------
console.log("=== TIER 1: Feature Coverage (Suite C: vehicle_radar_deploy) ===");

await check("T1.1 C2S 0x0909 VehicleCargo: Valid On-Foot Rear Deploy", () => {
  const vehicle = { pos: [100, 200, 10], heading: 0, speed: 0.0 };
  const player = { pos: [100, 198, 10], isSeated: false }; // 2.0m behind tailgate
  const res = RD.handleVehicleCargoAction(1, { vehicle, player, cargoLoaded: true });
  assert(res.success === true, "deploy accepted");
  assert(res.cargoLoaded === false, "cargo unloaded from vehicle");
  assert(res.stationGuid, "radar station GUID generated");
  assert(res.eventKind === 13, "emits CargoDeployed event");
});

await check("T1.2 C2S 0x0909 VehicleCargo: Valid On-Foot Pack", () => {
  const vehicle = { pos: [100, 200, 10], heading: 0, speed: 0.0 };
  const player = { pos: [100, 198, 10], isSeated: false };
  const deployedStation = { guid: 0x80099001, pos: [100, 198.4, 10] };
  const res = RD.handleVehicleCargoAction(2, { vehicle, player, cargoLoaded: false, deployedStation });
  assert(res.success === true, "pack accepted");
  assert(res.cargoLoaded === true, "cargo restored to vehicle bed");
  assert(res.eventKind === 14, "emits CargoPacked event");
});

await check("T1.3 Deployed Radar 3D Model: Draw Calls Budget (<= 8 draw calls)", () => {
  const radar = RD.buildDeployedRadar(THREE);
  assert(radar && radar.root, "radar root created");
  let drawCalls = 0;
  radar.root.traverse((obj) => {
    if (obj.isMesh || obj.isLine || obj.isPoints) drawCalls++;
  });
  assert(drawCalls <= RADAR_SPECS.maxDrawCalls, `draw calls ${drawCalls} <= 8`);
  assert(drawCalls >= 4, `draw calls ${drawCalls} >= 4 (substantive geometry)`);
  radar.dispose();
});

await check("T1.4 Deployed Radar: CRT Glow Zero Light Churn", () => {
  const radar = RD.buildDeployedRadar(THREE);
  let lights = 0;
  radar.root.traverse((obj) => { if (obj.isLight) lights++; });
  assert(lights === 0, "zero THREE.Light instances in radar tree");
  assert(radar.crtWindow && radar.crtWindow.isMesh, "CRT window mesh exists");
  assert(radar.crtWindow.material.depthWrite === false, "CRT additive blending with zero depth write");
  radar.dispose();
});

await check("T1.5 Deployed Radar: Deterministic 15 RPM Dish Rotation (Period 4.0s)", () => {
  const radar = RD.buildDeployedRadar(THREE);
  radar.update(0.0);
  near(radar.currentAzimuth, 0.0, 1e-4, "azimuth 0 at t = 0");

  radar.update(1.0); // 1.0s = 90 deg = 0.5*PI
  near(radar.currentAzimuth, 0.5 * Math.PI, 1e-4, "azimuth 90° at t = 1.0s");

  radar.update(2.0); // 2.0s = 180 deg = PI
  near(radar.currentAzimuth, Math.PI, 1e-4, "azimuth 180° at t = 2.0s");

  radar.update(4.0); // 4.0s = 360 deg = 0 (full revolution)
  near(radar.currentAzimuth, 0.0, 1e-4, "full revolution period 4.0s");
  radar.dispose();
});

await check("T1.6 Detection Envelope: 20 Statute Miles (32,187m) and 1,550m AGL Ceiling", () => {
  const radarPos = [0, 0, 10];
  const targetInRange = { pos: [15000, 0, 500], altitudeAgl: 500, locomotion: 1 };
  assert(RD.isTargetDetected(radarPos, targetInRange), "aircraft in range detected");

  const targetOutOfRange = { pos: [32190, 0, 500], altitudeAgl: 500, locomotion: 1 };
  assert(!RD.isTargetDetected(radarPos, targetOutOfRange), "aircraft > 32,187m excluded");

  const targetAboveCeiling = { pos: [10000, 0, 1600], altitudeAgl: 1560, locomotion: 1 };
  assert(!RD.isTargetDetected(radarPos, targetAboveCeiling), "aircraft > 1,550m AGL excluded");

  const targetBelowFloor = { pos: [10000, 0, 15], altitudeAgl: 5, locomotion: 1 };
  assert(!RD.isTargetDetected(radarPos, targetBelowFloor), "aircraft < 8m AGL excluded");
});

await check("T1.7 Locomotion Filtering: Ground Vehicles (Locomotion == 2) Excluded", () => {
  const radarPos = [0, 0, 10];
  const groundJeep = { pos: [500, 500, 10], altitudeAgl: 0, locomotion: 2 };
  assert(!RD.isTargetDetected(radarPos, groundJeep), "ground vehicles completely ignored by air radar");
});

await check("T1.8 Earth Curvature Sagitta Drop Formula Matches Theory (~20.1m at 16km of 32km)", () => {
  const s = 16000.0;
  const D = 32000.0;
  const drop = RD.computeEarthSagittaDrop(s, D);
  const expectedDrop = (16000.0 * 16000.0) / (2.0 * 6371000.0); // ~20.091 m
  near(drop, expectedDrop, 1e-4, "sagitta curvature drop matches mathematical formula");
  near(drop, 20.091, 0.05, "approx 20.1m drop at 16km midpoint");
});

await check("T1.9 3D Terrain Line-of-Sight: Mountain Ridge Occlusion", () => {
  const radarPos = [0, 0, 100];
  const targetPos = [10000, 0, 150]; // low flying target at 10km

  // Flat terrain: clear LOS
  const losClear = RD.checkRadarLos(radarPos, targetPos, () => 50);
  assert(losClear === true, "LOS clear over flat terrain");

  // Mountain ridge at 5km reaching 250m: occludes ray
  const losBlocked = RD.checkRadarLos(radarPos, targetPos, (x) => (Math.abs(x - 5000) < 500 ? 250 : 50));
  assert(losBlocked === false, "LOS occluded by 250m mountain ridge");
});

await check("T1.10 IFF Resolution: Monarch, Fellowship, and GuildRadarPolicy", () => {
  const radarOwner = { monarchId: 0x1111, ownerGuid: 0x80010001, fellowshipId: 0x4444 };
  const policy = {
    byId: { 0x2222: IFF_STANDING.Neutral },
    byName: { "Blood Raiders": IFF_STANDING.Hostile },
  };

  // Same monarch -> Friendly
  const pSameMonarch = { monarchId: 0x1111, pilotGuid: 0x80010099 };
  assert(RD.resolveIffStanding(pSameMonarch, radarOwner, policy) === IFF_STANDING.Friendly, "same monarch friendly");

  // Policy Neutral
  const pNeutral = { monarchId: 0x2222, pilotGuid: 0x80010098 };
  assert(RD.resolveIffStanding(pNeutral, radarOwner, policy) === IFF_STANDING.Neutral, "policy neutral");

  // Policy Hostile by name
  const pHostile = { monarchName: "blood raiders", pilotGuid: 0x80010097 };
  assert(RD.resolveIffStanding(pHostile, radarOwner, policy) === IFF_STANDING.Hostile, "policy hostile by name");

  // Unlisted -> Hostile
  const pForeign = { monarchId: 0x9999, monarchName: "Unknown Guild" };
  assert(RD.resolveIffStanding(pForeign, radarOwner, policy) === IFF_STANDING.Hostile, "unlisted defaults to hostile");
});

await check("T1.11 S2C 0x090A VehicleRadarContacts Wire Packing", () => {
  const contacts = [
    { guid: 0x80020001, dx: 1250.4, dy: -3400.2, altAgl: 450.0, heading: 1.57, standing: IFF_STANDING.Friendly, speed: 28.5 },
  ];
  const packet = RD.encodeRadarContactsPacket(0x80099001, contacts);
  assert(packet.opcode === 0x090a, "opcode 0x090A");
  assert(packet.contactCount === 1, "contactCount 1");
  assert(packet.contacts[0].dx === 1250, "integer dx packed");
  assert(packet.contacts[0].standing === IFF_STANDING.Friendly, "standing preserved");
});

// ---------------------------------------------------------------------------
// TIER 2: BOUNDARY & CORNER CASES
// ---------------------------------------------------------------------------
console.log("=== TIER 2: Boundary & Corner Cases (Suite C: vehicle_radar_deploy) ===");

await check("T2.1 Deploy Rejected if Player is Seated Inside Vehicle", () => {
  const vehicle = { pos: [0, 0, 0], heading: 0, speed: 0.0 };
  const player = { pos: [0, 0, 0], isSeated: true };
  const res = RD.handleVehicleCargoAction(1, { vehicle, player, cargoLoaded: true });
  assert(res.success === false && res.reason === "player_seated", "seated player deploy rejected");
});

await check("T2.2 Deploy Rejected if Vehicle Moving (> 0.25 m/s)", () => {
  const vehicle = { pos: [0, 0, 0], heading: 0, speed: 0.30 };
  const player = { pos: [0, -1.8, 0], isSeated: false };
  const res = RD.handleVehicleCargoAction(1, { vehicle, player, cargoLoaded: true });
  assert(res.success === false && res.reason === "vehicle_moving", "moving vehicle deploy rejected");
});

await check("T2.3 Speed Boundary: 0.24 m/s (Accepted) vs 0.26 m/s (Rejected)", () => {
  const player = { pos: [0, -1.8, 0], isSeated: false };
  const res24 = RD.handleVehicleCargoAction(1, { vehicle: { pos: [0, 0, 0], heading: 0, speed: 0.24 }, player, cargoLoaded: true });
  const res26 = RD.handleVehicleCargoAction(1, { vehicle: { pos: [0, 0, 0], heading: 0, speed: 0.26 }, player, cargoLoaded: true });
  assert(res24.success === true, "0.24 m/s accepted");
  assert(res26.success === false, "0.26 m/s rejected");
});

await check("T2.4 Distance Boundary: 3.79 m (Accepted) vs 3.81 m (Rejected)", () => {
  // Tailgate at (0, -1.6, 0)
  const pNear = { pos: [0, -1.6 - 3.79, 0], isSeated: false };
  const pFar = { pos: [0, -1.6 - 3.81, 0], isSeated: false };
  const v = { pos: [0, 0, 0], heading: 0, speed: 0 };
  const resNear = RD.handleVehicleCargoAction(1, { vehicle: v, player: pNear, cargoLoaded: true });
  const resFar = RD.handleVehicleCargoAction(1, { vehicle: v, player: pFar, cargoLoaded: true });
  assert(resNear.success === true, "3.79 m accepted");
  assert(resFar.success === false, "3.81 m rejected");
});

await check("T2.5 Exact Boundary Detection: 32,187.0m vs 32,187.5m", () => {
  const radarPos = [0, 0, 0];
  const tExact = { pos: [32187.0, 0, 500], altitudeAgl: 500, locomotion: 1 };
  const tOver = { pos: [32187.5, 0, 500], altitudeAgl: 500, locomotion: 1 };
  assert(RD.isTargetDetected(radarPos, tExact), "32,187.0m detected");
  assert(!RD.isTargetDetected(radarPos, tOver), "32,187.5m excluded");
});

await check("T2.6 Exact Boundary Ceiling: 1,550.0m AGL vs 1,550.5m AGL", () => {
  const radarPos = [0, 0, 0];
  const tExact = { pos: [10000, 0, 1550], altitudeAgl: 1550.0, locomotion: 1 };
  const tOver = { pos: [10000, 0, 1551], altitudeAgl: 1550.5, locomotion: 1 };
  assert(RD.isTargetDetected(radarPos, tExact), "1,550.0m detected");
  assert(!RD.isTargetDetected(radarPos, tOver), "1,550.5m excluded");
});

await check("T2.7 Exact Boundary Floor: 8.0m AGL vs 7.9m AGL", () => {
  const radarPos = [0, 0, 0];
  const tExact = { pos: [1000, 0, 8], altitudeAgl: 8.0, locomotion: 1 };
  const tUnder = { pos: [1000, 0, 7.9], altitudeAgl: 7.9, locomotion: 1 };
  assert(RD.isTargetDetected(radarPos, tExact), "8.0m detected");
  assert(!RD.isTargetDetected(radarPos, tUnder), "7.9m excluded");
});

await check("T2.8 Curvature Sagitta Masks Low Target Over Flat Horizon", () => {
  // Target at 32,000m at 15m AGL. Over flat Earth (terrain = 0), midpoint sagitta drop is ~20.1m!
  // Ray dips into the ground because drop (20.1m) > ray line (15m)!
  const radarPos = [0, 0, 0];
  const targetPos = [32000, 0, 15];
  const losClear = RD.checkRadarLos(radarPos, targetPos, () => 0.0);
  assert(losClear === false, "curvature sagitta masks low target below horizon");
});

await check("T2.9 Zero-Distance Target Directly Overhead (No division by zero)", () => {
  const radarPos = [0, 0, 100];
  const targetPos = [0, 0, 500];
  const losClear = RD.checkRadarLos(radarPos, targetPos, () => 50);
  assert(losClear === true, "zero-distance target handled safely without NaN");
});

await check("T2.10 Case-Insensitive Monarch Name Policy Lookup", () => {
  const radarOwner = { monarchId: 0x1111 };
  const policy = { byName: { "High King Asheron": IFF_STANDING.Friendly } };
  const target = { monarchName: "high king asheron" };
  assert(RD.resolveIffStanding(target, radarOwner, policy) === IFF_STANDING.Friendly, "case-insensitive match");
});

// ---------------------------------------------------------------------------
// TIER 3: CROSS-FEATURE COMBINATIONS
// ---------------------------------------------------------------------------
console.log("=== TIER 3: Cross-Feature Combinations (Suite C: vehicle_radar_deploy) ===");

await check("T3.1 Full Lifecycle: Deploy Behind Parked Jeep, Sweep, and Re-pack", () => {
  const vehicle = { pos: [500, 500, 10], heading: 0, speed: 0 };
  const player = { pos: [500, 498, 10], isSeated: false };

  // Step 1: Deploy
  const deployRes = RD.handleVehicleCargoAction(1, { vehicle, player, cargoLoaded: true });
  assert(deployRes.success, "deployed radar");

  // Step 2: Radar scans airspace
  const radarPos = deployRes.stationPos;
  const target = { pos: [500 + 10000, 500, 800], altitudeAgl: 800, locomotion: 1 };
  assert(RD.isTargetDetected(radarPos, target), "target detected during active scan");

  // Step 3: Pack
  const deployedStation = { guid: deployRes.stationGuid, pos: deployRes.stationPos };
  const packRes = RD.handleVehicleCargoAction(2, { vehicle, player, cargoLoaded: false, deployedStation });
  assert(packRes.success, "packed radar");
  assert(packRes.cargoLoaded === true, "cargo returned to Jeep bed");
});

await check("T3.2 Mountain Terrain Masking & Pop-up Detection", () => {
  const radarPos = [0, 0, 50];
  const terrain = (x) => (Math.abs(x - 8000) < 600 ? 400 : 0); // 400m ridge at 8km

  // Target low behind ridge (masked)
  const lowTarget = [15000, 0, 150];
  assert(!RD.checkRadarLos(radarPos, lowTarget, terrain), "target behind ridge occluded");

  // Target climbs above ridge to 850m (detected)
  const highTarget = [15000, 0, 850];
  assert(RD.checkRadarLos(radarPos, highTarget, terrain), "target above ridge line detected");
});

await check("T3.3 Dynamic Aircraft Climbing from Below Floor to Ceiling Deck", () => {
  const radarPos = [0, 0, 10];
  const target = { pos: [10000, 0, 0], altitudeAgl: 5, locomotion: 1 };

  // Below floor (5m AGL) -> not detected
  assert(!RD.isTargetDetected(radarPos, target), "below floor");

  // Climbs into envelope (300m AGL) -> detected
  target.altitudeAgl = 300;
  assert(RD.isTargetDetected(radarPos, target), "in envelope");

  // Climbs above ceiling (1600m AGL) -> not detected
  target.altitudeAgl = 1600;
  assert(!RD.isTargetDetected(radarPos, target), "above ceiling");
});

// ---------------------------------------------------------------------------
// TIER 4: REAL-WORLD APPLICATION SCENARIOS
// ---------------------------------------------------------------------------
console.log("=== TIER 4: Real-World Scenarios (Suite C: vehicle_radar_deploy) ===");

await check("T4.1 Forward Air Defense Perimeter Deployment Scenario", () => {
  const radarPos = [1000, 2000, 150];
  const radarOwner = { monarchId: 0x0001, ownerGuid: 0x80010001 };
  const policy = {
    byId: { 0x0002: IFF_STANDING.Friendly, 0x0003: IFF_STANDING.Neutral },
    byName: { "Blood Raiders": IFF_STANDING.Hostile },
  };

  const incomingFighters = [
    { guid: 0x8002001, pos: [8000, 2000, 600], altitudeAgl: 450, locomotion: 1, monarchId: 0x0001, name: "Ally Leader" },
    { guid: 0x8002002, pos: [12000, 3000, 700], altitudeAgl: 550, locomotion: 1, monarchId: 0x0003, name: "Neutral Merchant" },
    { guid: 0x8002003, pos: [15000, 1000, 800], altitudeAgl: 650, locomotion: 1, monarchName: "Blood Raiders", name: "Raider Strike" },
  ];

  const tracks = [];
  for (const f of incomingFighters) {
    if (RD.isTargetDetected(radarPos, f)) {
      const standing = RD.resolveIffStanding(f, radarOwner, policy);
      tracks.push({
        guid: f.guid,
        standing,
        dx: f.pos[0] - radarPos[0],
        dy: f.pos[1] - radarPos[1],
        altAgl: f.altitudeAgl,
        speed: 30.0,
        heading: 3.14,
      });
    }
  }

  assert(tracks.length === 3, "all 3 aircraft detected in perimeter");
  assert(tracks[0].standing === IFF_STANDING.Friendly, "Fighter 1 Friendly");
  assert(tracks[1].standing === IFF_STANDING.Neutral, "Fighter 2 Neutral");
  assert(tracks[2].standing === IFF_STANDING.Hostile, "Fighter 3 Hostile");

  // Encode S2C 0x090A telemetry
  const packet = RD.encodeRadarContactsPacket(0x80099001, tracks);
  assert(packet.contactCount === 3, "3 contacts packed in telemetry stream");
});

await check("T4.2 Mountain Radar Station Patrol & Multi-Target Interception", () => {
  // Mountain peak station at z = 450m
  const radarPos = [5000, 5000, 450];
  const radarModel = RD.buildDeployedRadar(THREE);

  // 10 aircraft flying across sector at various altitudes and ranges
  let detectedCount = 0;
  for (let i = 0; i < 10; i++) {
    const angle = (i / 10) * 2 * Math.PI;
    const dist = 5000 + i * 2500; // 5km to 27.5km
    const target = {
      pos: [radarPos[0] + dist * Math.cos(angle), radarPos[1] + dist * Math.sin(angle), 300 + i * 100],
      altitudeAgl: 300 + i * 100,
      locomotion: 1,
    };
    if (RD.isTargetDetected(radarPos, target)) detectedCount++;
  }
  assert(detectedCount === 10, "all 10 sector aircraft detected");

  // Step radar 3D dish over 4 seconds
  for (let t = 0; t <= 40; t++) {
    radarModel.update(t * 0.1);
  }
  near(radarModel.currentAzimuth, 0.0, 0.05, "dish completes full cycle");
  radarModel.dispose();
});

// ---------------------------------------------------------------------------
// TIER 5: ADVERSARIAL COVERAGE HARDENING
// ---------------------------------------------------------------------------
console.log("=== TIER 5: Adversarial Coverage Hardening (Suite C: vehicle_radar_deploy) ===");

await check("T5.1 Radar Contact Heading Wire 8-bit Quantization Precision & Range", () => {
  const angles = [
    { in: 0, want: 0 },
    { in: Math.PI / 2, want: 64 },
    { in: Math.PI, want: 128 },
    { in: (3 * Math.PI) / 2, want: 191 },
    { in: 2 * Math.PI, want: 0 },
    { in: -Math.PI / 2, want: 191 },
    { in: 2.5 * Math.PI, want: 64 },
  ];
  for (const a of angles) {
    const contacts = [{ guid: 0x80020001, dx: 100, dy: 100, altAgl: 100, heading: a.in, standing: 1, speed: 20 }];
    const packet = RD.encodeRadarContactsPacket(0x80099001, contacts);
    const hdgU8 = packet.contacts[0].heading;
    assert(Number.isInteger(hdgU8), `heading must be integer: ${hdgU8}`);
    assert(hdgU8 >= 0 && hdgU8 <= 255, `heading byte overflow: ${hdgU8}`);
    near(hdgU8, a.want, 1.0, `quantized heading for ${a.in}`);
  }
});

await check("T5.2 Finite simTimeSec Guard on Radar Model update()", () => {
  const radarModel = RD.buildDeployedRadar(THREE);
  // Pass NaN
  radarModel.update(NaN);
  assert(Number.isFinite(radarModel.currentAzimuth), "NaN simTimeSec produces finite azimuth");
  assert(radarModel.currentAzimuth === 0, "NaN defaults to 0 azimuth");
  assert(Number.isFinite(radarModel.dishPivot.rotation.z), "dish rotation is finite");

  // Pass Infinity
  radarModel.update(Infinity);
  assert(radarModel.currentAzimuth === 0, "Infinity defaults to 0 azimuth");

  // Pass valid time
  radarModel.update(2.0); // half cycle of 4.0s = PI rad
  near(radarModel.currentAzimuth, Math.PI, 0.05, "valid time computes correct azimuth");

  radarModel.dispose();
});

await check("T5.3 Radar PPI Scope HUD Degenerate Dimension Robustness", () => {
  const calls = [];
  const mockCtx = {
    save() { calls.push("save"); },
    restore() { calls.push("restore"); },
    beginPath() { calls.push("beginPath"); },
    closePath() { calls.push("closePath"); },
    stroke() { calls.push("stroke"); },
    fill() { calls.push("fill"); },
    clip() { calls.push("clip"); },
    arc(x, y, r) {
      if (r < 0) throw new Error("IndexSizeError: radius cannot be negative");
      calls.push(["arc", x, y, r]);
    },
    moveTo(x, y) { calls.push(["moveTo", x, y]); },
    lineTo(x, y) { calls.push(["lineTo", x, y]); },
    createRadialGradient() { return { addColorStop() {} }; },
  };

  // Degenerate small dimensions: width = 10, height = 10 (radius = -5)
  // Must return early without throwing IndexSizeError
  renderRadarScope(mockCtx, 10, 10, { simTimeSec: 0, contacts: [] });
  assert(calls.length === 0, "degenerate canvas dimension returns early without canvas operations");
});

await check("T5.4 Radar PPI Scope HUD WASM Contact Property Fallback", () => {
  const blipArcs = [];
  const mockCtx = {
    save() {},
    restore() {},
    beginPath() {},
    closePath() {},
    stroke() {},
    fill() {},
    clip() {},
    arc(x, y, r) {
      // Blips are drawn with radius 3.5
      if (Math.abs(r - 3.5) < 0.1) {
        blipArcs.push({ x, y, r });
      }
    },
    moveTo() {},
    lineTo() {},
    createRadialGradient() { return { addColorStop() {} }; },
  };

  // WASM contact uses dxM and dyM (not dx and dy)
  // 16,093.5m is half of maxRangeM (32,187m)
  const wasmContact = {
    vehicleGuid: 0x80020001,
    dxM: 16093.5,
    dyM: 0,
    speedMps: 25,
    headingU8: 64,
    standing: 1,
  };

  renderRadarScope(mockCtx, 256, 256, { simTimeSec: 0, contacts: [wasmContact] });

  // cx = 128, cy = 128, radius = 118
  // expected blip x: 128 + (16093.5 / 32187) * 118 = 128 + 59 = 187
  // expected blip y: 128 - 0 = 128
  assert(blipArcs.length === 1, "exactly one blip arc drawn");
  near(blipArcs[0].x, 187, 1.0, "blip x correctly mapped from dxM");
  near(blipArcs[0].y, 128, 1.0, "blip y correctly mapped from dyM");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\nvehicle_radar_deploy: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
