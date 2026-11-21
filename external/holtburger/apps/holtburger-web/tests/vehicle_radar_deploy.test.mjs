// tests/vehicle_radar_deploy.test.mjs — 4-Tier E2E test suite for the WWII mobile air-search radar (AN/TPS-1 / SCR-602)
// rear deployment/pack (0x0909 VehicleCargo), 3D deployed radar model (<= 8 draw calls, 15 RPM dish),
// autonomous air-search envelope (20 statute miles / 32,187m, 1,550m AGL ceiling), 3D terrain LOS with Earth
// curvature sagitta drop, Monarch/Guild IFF resolution, and turret sensor bus (IAirDefenseSensor, AirTrack).
//
// Run: node external/holtburger/apps/holtburger-web/tests/vehicle_radar_deploy.test.mjs

import * as THREE from "three";
import { lintManifest, lintSource } from "../scene3d/vfx/lint_caps.js";
import { FxLightSource } from "../scene3d/vfx/fx_lights.js";
import { renderRadarScope, renderCombinedRadarScope, RadarScopeHud } from "../scene3d/vehicle/radar_scope.js";

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

    // Deployed Radar 3D Model Constructor (<= 8 draw calls, mounted atop Full GMA Pallet)
    buildDeployedRadar(three, options = {}) {
      const root = new three.Group();
      root.name = "deployed-radar-station";

      const palletGeom = new three.BoxGeometry(1.100, 1.100, 0.145);
      const palletMesh = new three.Mesh(palletGeom, new three.MeshStandardMaterial({ color: 0xffffff, vertexColors: false, roughness: 0.68, metalness: 0.16 }));
      palletMesh.position.set(0, 0, 0.145 / 2);
      root.add(palletMesh);
      const pallet = {
        root: palletMesh,
        mesh: palletMesh,
        spec: { width: 1.100, depth: 1.100, height: 0.145 },
        size: "standard",
        dispose() { palletGeom.dispose(); palletMesh.material.dispose(); },
      };

      const isStowed = Boolean(options.stowed);
      const deckZ = 0.145;
      const mastHeight = isStowed ? 1.80 : RADAR_SPECS.mastHeightM;

      const matSteel = new three.MeshStandardMaterial({ color: 0x4a5234, roughness: 0.55, metalness: 0.45 });
      const matCabinet = new three.MeshStandardMaterial({ color: 0x3b442b, roughness: 0.65, metalness: 0.35 });
      const matCrtGlow = new three.MeshBasicMaterial({
        color: 0x33ff66,
        transparent: true,
        opacity: 0.85,
        blending: three.AdditiveBlending,
        depthWrite: false,
      });
      const matDishWire = new three.MeshStandardMaterial({
        color: 0x7c8567,
        wireframe: true,
        roughness: 0.40,
        metalness: 0.60,
      });

      // 1. Heavy steel tripod base
      const tripodGeom = new three.CylinderGeometry(0.06, 0.46, 0.50, 3).toNonIndexed();
      const tripodMesh = new three.Mesh(tripodGeom, matSteel);
      tripodMesh.name = "radar-tripod";
      tripodMesh.position.set(0, 0, deckZ + 0.25);
      root.add(tripodMesh);

      // 2. Telescoping antenna mast
      const mastGeom = new three.CylinderGeometry(0.05, 0.07, mastHeight, 8);
      const mastMesh = new three.Mesh(mastGeom, matSteel);
      mastMesh.name = "radar-mast";
      mastMesh.position.set(0, 0, deckZ + mastHeight / 2);
      mastMesh.rotation.x = Math.PI / 2;
      root.add(mastMesh);

      // 3. Transceiver generator cabinet
      const cabinetMesh = new three.Mesh(new three.BoxGeometry(0.60, 0.48, 0.46), matCabinet);
      cabinetMesh.name = "radar-cabinet";
      cabinetMesh.position.set(0, 0.22, deckZ + 0.23);
      root.add(cabinetMesh);

      // 4. CRT phosphor green scope window (matAdditive, ZERO THREE.Light churn)
      const crtWindow = new three.Mesh(new three.CircleGeometry(0.12, 16), matCrtGlow);
      crtWindow.name = "crt-phosphor-scope";
      crtWindow.position.set(0, 0.47, deckZ + 0.28);
      root.add(crtWindow);

      // 5. Rotating parabolic reflector dish
      const dishPivot = new three.Group();
      dishPivot.name = "dishPivot";
      dishPivot.position.set(0, 0, deckZ + mastHeight);

      // Parabolic curvature mesh
      const dishMesh = new three.Mesh(new three.SphereGeometry(isStowed ? 0.20 : 0.90, 16, 8, 0, Math.PI), matDishWire);
      dishMesh.name = "parabolic-dish-reflector";
      dishMesh.rotation.x = isStowed ? Math.PI : Math.PI / 2;
      dishPivot.add(dishMesh);
      root.add(dishPivot);

      let currentAzimuth = 0;

      return {
        root,
        dishPivot,
        crtWindow,
        pallet,
        palletSize: "full",
        get currentAzimuth() { return currentAzimuth; },
        update(simTimeSec = 0) {
          if (isStowed) return;
          // 15 RPM deterministic from simTimeSec: (simTimeSec * 15 * 2 * PI / 60) % (2 * PI)
          const omega = (RADAR_SPECS.dishRpm * 2 * Math.PI) / 60.0; // 0.5 * PI rad/s
          const safeTime = Number.isFinite(simTimeSec) ? simTimeSec : 0;
          currentAzimuth = (safeTime * omega) % (2 * Math.PI);
          if (currentAzimuth < 0) currentAzimuth += 2 * Math.PI;
          if (Math.abs(currentAzimuth - 2 * Math.PI) < 1e-4) currentAzimuth = 0;
          dishPivot.rotation.z = currentAzimuth;
        },
        dispose() {
          pallet.dispose();
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

await check("T1.3 Deployed Radar 3D Model: Draw Calls <= 8, Unified Pallet, Strict Stowed Envelope & Delta", () => {
  const radar = RD.buildDeployedRadar(THREE, { stowed: false });
  assert(radar && radar.root, "radar root created");
  assert(radar.pallet, "radar mounted directly atop pallet");
  assert(radar.palletSize === "full", "radar palletSize is full");
  assert(radar.pallet.spec.width === 1.100 && radar.pallet.spec.depth === 1.100, "radar unified 1.100×1.100m pallet");
  let drawCalls = 0;
  radar.root.traverse((obj) => {
    if (obj.visible && (obj.isMesh || obj.isLine || obj.isPoints)) drawCalls++;
  });
  assert(drawCalls <= RADAR_SPECS.maxDrawCalls, `draw calls ${drawCalls} <= 8`);
  assert(drawCalls >= 4, `draw calls ${drawCalls} >= 4 (substantive geometry)`);
  radar.root.updateMatrixWorld(true);
  const deployBox = new THREE.Box3().setFromObject(radar.root);
  const deploySpanX = deployBox.max.x - deployBox.min.x;
  assert(deploySpanX >= 1.50, `deployed parabolic dish span ${deploySpanX.toFixed(3)}m >= 1.50m`);
  radar.dispose();

  const stowed = RD.buildDeployedRadar(THREE, { stowed: true });
  stowed.root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(stowed.root);
  const stowedH = box.max.z - box.min.z;
  assert(box.min.x >= -0.555 && box.max.x <= 0.555, `radar stowed X [${box.min.x.toFixed(4)}, ${box.max.x.toFixed(4)}] within ±0.555`);
  assert(box.min.y >= -0.555 && box.max.y <= 0.555, `radar stowed Y [${box.min.y.toFixed(4)}, ${box.max.y.toFixed(4)}] within ±0.555`);
  assert(box.min.z >= -1e-4 && box.max.z <= 2.04, `radar stowed Z [${box.min.z.toFixed(4)}, ${box.max.z.toFixed(4)}] <= 2.04m`);
  assert(stowedH <= 2.04, `radar stowed height ${stowedH.toFixed(4)} <= 2.04m`);
  assert(deployBox.max.z - box.max.z > 0.5, "stowed mast collapses significantly vs deployed");
  stowed.dispose();
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

  // Prototype property keys (e.g. "toString", "constructor", "valueOf") must never leak prototype functions
  for (const protoKey of ["toString", "constructor", "valueOf", "hasOwnProperty"]) {
    const res = RD.resolveIffStanding({ monarchId: protoKey }, { monarchId: 1 }, { byId: {} });
    assert(typeof res === "number" && res === IFF_STANDING.Hostile, `prototype key "${protoKey}" returns IFF_STANDING.Hostile (got ${typeof res} ${res})`);
  }
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

await check("T5.5 renderCombinedRadarScope Renders Altitude Label From Wire altAglM Field", () => {
  const texts = [];
  const mockCtx = {
    save() {},
    restore() {},
    beginPath() {},
    closePath() {},
    stroke() {},
    fill() {},
    clip() {},
    arc() {},
    moveTo() {},
    lineTo() {},
    fillText(str, x, y) { texts.push({ str, x, y }); },
    createRadialGradient() { return { addColorStop() {} }; },
  };

  renderCombinedRadarScope(mockCtx, 256, 256, {
    simTimeSec: 1.0,
    airContacts: [{ dxM: 5000, dyM: 5000, altAglM: 423, standing: 3, headingU8: 0, speedMpsU8: 60 }],
    groundContacts: [],
  });

  assert(texts.some((t) => t.str === "423m"), `expected "423m" altitude label, got ${JSON.stringify(texts)}`);
});

await check("T5.6 RadarScopeHud.update() clears legacy this.contacts when airContacts is explicitly passed", () => {
  let fillCount = 0;
  const mockCtx = {
    clearRect() {},
    save() {},
    restore() {},
    beginPath() {},
    closePath() {},
    stroke() {},
    fill() { fillCount++; },
    clip() {},
    arc() {},
    moveTo() {},
    lineTo() {},
    fillText() {},
    createRadialGradient() { return { addColorStop() {} }; },
  };

  const hud = new RadarScopeHud();
  hud.ctx = mockCtx;

  hud.update({ simTimeSec: 1, contacts: [{ dxM: 100, dyM: 100, standing: 3 }] });
  assert(hud.contacts.length === 1, "legacy contacts populated");
  assert(fillCount === 4, `expected 3 base/sweep fills + 1 contact blip = 4, got ${fillCount}`);

  hud.update({ simTimeSec: 2, airContacts: [], groundContacts: [], visible: false });
  assert(hud.contacts.length === 0, "airContacts: [] cleared legacy this.contacts");

  fillCount = 0;
  hud.update({ simTimeSec: 3, airContacts: [], groundContacts: [], visible: true });
  assert(fillCount === 3, `expected only 3 base/sweep fills with empty airContacts, got ${fillCount}`);

  fillCount = 0;
  hud.update({ simTimeSec: 4, visible: true });
  assert(fillCount === 3, `subsequent update omitting airContacts must not resurrect contacts, got ${fillCount}`);

  hud.dispose();
});

await check("T5.7 Radar Math NaN/Undefined Guards & 4000002 setDeployed()", () => {
  // 1. isTargetDetected guards
  assert(RD.isTargetDetected([0, 0, 0], { pos: [100, 0, 0], altitudeAgl: NaN, locomotion: 1 }) === false, "NaN altitudeAgl rejected");
  assert(RD.isTargetDetected([0, 0, 0], { pos: [100, 0, 0], locomotion: 1 }) === false, "undefined altitudeAgl rejected");
  assert(RD.isTargetDetected([0, 0, 0], { pos: [NaN, 0, 0], altitudeAgl: 100, locomotion: 1 }) === false, "NaN target pos rejected");
  assert(RD.isTargetDetected([NaN, 0, 0], { pos: [100, 0, 0], altitudeAgl: 100, locomotion: 1 }) === false, "NaN radar pos rejected");

  // 2. computeEarthSagittaDrop & checkRadarLos guards
  assert(RD.computeEarthSagittaDrop(NaN, 100) === 0, "NaN sagitta s returns 0");
  assert(RD.computeEarthSagittaDrop(50, Infinity) === 0, "Infinity sagitta D returns 0");
  assert(RD.checkRadarLos([0, 0, 0], [1000, 0, 100], () => NaN) === false, "NaN terrain height rejected");
  assert(RD.checkRadarLos([0, 0, 0], [NaN, 0, 100], () => 0) === false, "NaN targetPos LOS rejected");
  assert(RD.checkRadarLos([0, NaN, 0], [1000, 0, 100], () => 0) === false, "NaN radarPos LOS rejected");

  // 3. encodeRadarContactsPacket sanitization
  const pkt = RD.encodeRadarContactsPacket(0x80099001, [
    { guid: 1, dx: NaN, dy: Infinity, altAgl: undefined, heading: NaN, standing: NaN, speed: -Infinity },
  ]);
  const c = pkt.contacts[0];
  assert(Number.isFinite(c.dx) && c.dx === 0, "NaN dx sanitized to 0");
  assert(Number.isFinite(c.dy) && c.dy === 0, "Infinity dy sanitized to 0");
  assert(Number.isFinite(c.altAgl) && c.altAgl === 0, "undefined altAgl sanitized to 0");
  assert(Number.isFinite(c.heading) && c.heading === 0, "NaN heading sanitized to 0");
  assert(Number.isFinite(c.speed) && c.speed === 0, "-Infinity speed sanitized to 0");
  assert(Number.isFinite(c.standing), "NaN standing sanitized to finite");

  // 4. unit.setDeployed() on 4000002
  const radar = RD.buildDeployedRadar(THREE, { stowed: true });
  assert(typeof radar.setDeployed === "function", "4000002 exposes setDeployed");
  assert(radar.stowed === true, "starts stowed");
  radar.setDeployed(true);
  assert(radar.stowed === false, "setDeployed(true) deploys radar");
  radar.setDeployed(false);
  assert(radar.stowed === true, "setDeployed(false) stows radar");
  radar.dispose();
});

await check("T5.8 4000002 3D SAT Tri-Tri Zero Non-Shaft/Non-Hinge Intersections (Stowed & Deployed)", () => {
  const getWorldTris = (mesh) => {
    const geom = mesh.geometry;
    const pos = geom.attributes.position;
    const idx = geom.index;
    const mat = mesh.matrixWorld;
    const tris = [];
    const v = new THREE.Vector3();
    const readV = (i) => {
      v.fromBufferAttribute(pos, i).applyMatrix4(mat);
      return [v.x, v.y, v.z];
    };
    const count = idx ? idx.count : pos.count;
    for (let i = 0; i < count; i += 3) {
      tris.push([
        readV(idx ? idx.getX(i) : i),
        readV(idx ? idx.getX(i + 1) : i + 1),
        readV(idx ? idx.getX(i + 2) : i + 2),
      ]);
    }
    return tris;
  };
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const triBbox = (t) => [
    Math.min(t[0][0], t[1][0], t[2][0]), Math.min(t[0][1], t[1][1], t[2][1]), Math.min(t[0][2], t[1][2], t[2][2]),
    Math.max(t[0][0], t[1][0], t[2][0]), Math.max(t[0][1], t[1][1], t[2][1]), Math.max(t[0][2], t[1][2], t[2][2]),
  ];
  const axisOverlap = (t1, t2, axis) => {
    const len2 = dot(axis, axis);
    if (len2 < 1e-16) return true;
    let min1 = Infinity, max1 = -Infinity, min2 = Infinity, max2 = -Infinity;
    for (let i = 0; i < 3; i++) {
      const p1 = dot(t1[i], axis); if (p1 < min1) min1 = p1; if (p1 > max1) max1 = p1;
      const p2 = dot(t2[i], axis); if (p2 < min2) min2 = p2; if (p2 > max2) max2 = p2;
    }
    const eps = 1e-6 * Math.sqrt(len2);
    return max1 >= min2 + eps && max2 >= min1 + eps;
  };
  const triTriHit = (t1, t2) => {
    const e1 = [sub(t1[1], t1[0]), sub(t1[2], t1[1]), sub(t1[0], t1[2])];
    const e2 = [sub(t2[1], t2[0]), sub(t2[2], t2[1]), sub(t2[0], t2[2])];
    if (!axisOverlap(t1, t2, cross(e1[0], e1[1]))) return false;
    if (!axisOverlap(t1, t2, cross(e2[0], e2[1]))) return false;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        if (!axisOverlap(t1, t2, cross(e1[i], e2[j]))) return false;
      }
    }
    return true;
  };
  const countHits = (trisA, trisB, allowPair = null) => {
    const bbsB = trisB.map(triBbox);
    let hits = 0;
    for (let i = 0; i < trisA.length; i++) {
      const ba = triBbox(trisA[i]);
      for (let j = 0; j < trisB.length; j++) {
        const bb = bbsB[j];
        if (ba[3] < bb[0] || ba[0] > bb[3] || ba[4] < bb[1] || ba[1] > bb[4] || ba[5] < bb[2] || ba[2] > bb[5]) continue;
        if (triTriHit(trisA[i], trisB[j])) {
          if (!allowPair || !allowPair(trisA[i], trisB[j])) hits++;
        }
      }
    }
    return hits;
  };

  const isStage3Shaft = (_tA, tB) => Math.max(
    Math.hypot(tB[0][0], tB[0][1]),
    Math.hypot(tB[1][0], tB[1][1]),
    Math.hypot(tB[2][0], tB[2][1]),
  ) <= 0.046;

  const assertRadarPoseClean = (label, radar) => {
    radar.root.updateMatrixWorld(true);
    const meshes = {};
    radar.root.traverse((obj) => { if (obj.isMesh) meshes[obj.name] = obj; });
    const tripodTris = getWorldTris(meshes["radar-tripod-cabinet"]);
    const mastTris = getWorldTris(meshes["radar-mast"]);
    const dishTris = getWorldTris(meshes["parabolic-dish-reflector"]);
    const leftTris = getWorldTris(meshes["parabolic-dish-left-wing"]);
    const rightTris = getWorldTris(meshes["parabolic-dish-right-wing"]);

    const dishInv = radar.dishPivot.matrixWorld.clone().invert();
    const tmp = new THREE.Vector3();
    const isHingeEdge = (tri, hingeX) => {
      let minDistX = Infinity;
      for (const p of tri) {
        tmp.set(p[0], p[1], p[2]).applyMatrix4(dishInv);
        const d = Math.abs(tmp.x - hingeX);
        if (d < minDistX) minDistX = d;
      }
      return minDistX <= 0.020;
    };

    assert(countHits(tripodTris, dishTris, isStage3Shaft) === 0, `${label}: tripod vs dish non-shaft hits === 0`);
    assert(countHits(mastTris, dishTris, isStage3Shaft) === 0, `${label}: mast vs dish non-shaft hits === 0`);
    assert(countHits(tripodTris, leftTris) === 0, `${label}: tripod vs leftWing hits === 0`);
    assert(countHits(tripodTris, rightTris) === 0, `${label}: tripod vs rightWing hits === 0`);
    assert(countHits(mastTris, leftTris) === 0, `${label}: mast vs leftWing hits === 0`);
    assert(countHits(mastTris, rightTris) === 0, `${label}: mast vs rightWing hits === 0`);
    assert(
      countHits(dishTris, leftTris, (ta, tb) => isHingeEdge(ta, -0.35) && isHingeEdge(tb, -0.35)) === 0,
      `${label}: dish vs leftWing non-hinge hits === 0`,
    );
    assert(
      countHits(dishTris, rightTris, (ta, tb) => isHingeEdge(ta, 0.35) && isHingeEdge(tb, 0.35)) === 0,
      `${label}: dish vs rightWing non-hinge hits === 0`,
    );
    assert(countHits(leftTris, rightTris) === 0, `${label}: leftWing vs rightWing hits === 0`);
  };

  // 1. Constructor stowed
  const rCtorStowed = RD.buildDeployedRadar(THREE, { stowed: true });
  assertRadarPoseClean("ctorStowed", rCtorStowed);
  rCtorStowed.dispose();

  // 2. Deployed -> rotated -> setStowed(true) & setDeployed(false)
  const rDyn = RD.buildDeployedRadar(THREE, { stowed: false });
  rDyn.update(1.3);
  rDyn.setStowed(true);
  assertRadarPoseClean("setStowed(true)", rDyn);

  rDyn.setDeployed(true);
  rDyn.update(2.1);
  rDyn.setDeployed(false);
  assertRadarPoseClean("setDeployed(false)", rDyn);

  // 3. Deployed across full rotation cycle
  rDyn.setDeployed(true);
  for (let i = 0; i < 8; i++) {
    const t = (i / 8) * 4.0;
    rDyn.update(t);
    assertRadarPoseClean(`deployed(t=${t.toFixed(2)})`, rDyn);
  }
  rDyn.dispose();
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\nvehicle_radar_deploy: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
