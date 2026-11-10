// tests/vehicle_airframe_model.test.mjs — targeted unit tests for the procedural Grumman F6F-5/F6F-6 Hellcat
// 3D airframe model (`scene3d/vehicle/airframe.js`) and world-space aerodynamic VFX (`scene3d/vehicle/aero_fx.js`).
//
// Run: node tests/vehicle_airframe_model.test.mjs

import * as THREE from "three";
import * as FM from "../scene3d/vehicle/flight_model.js";
import * as AF from "../scene3d/vehicle/airframe.js";
import * as AERO from "../scene3d/vehicle/aero_fx.js";
import * as W from "../scene3d/vehicle/weapons.js";

let passed = 0, failed = 0;
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
const near = (a, b, eps, m) => assert(Math.abs(a - b) <= eps, `${m || "near"}: ${a} vs ${b} (eps ${eps})`);

const DEG = Math.PI / 180;

function makeFullHellcatProfile(partCount = 257) {
  const weapons = [], weaponExt = [];
  for (const gx of [-3.05, -2.75, -2.45, 2.45, 2.75, 3.05]) {
    weapons.push({ kind: 1, roundsPerSecond: 5, spread: 1.2 * DEG, range: 140, damage: 9, magazine: 400, muzzle: [gx, 2.0, 2.29] });
    weaponExt.push({ muzzleVelocity: 120, convergence: 110, massKg: 0, dragTerminal: 0, spellId: 0 });
  }
  for (const [rx, rz] of [[-5.75, 2.26], [-5.10, 2.19], [-4.45, 2.11], [4.45, 2.11], [5.10, 2.19], [5.75, 2.26]]) {
    weapons.push({ kind: 2, roundsPerSecond: 3.3, spread: 0, range: 600, damage: 0, magazine: 1, muzzle: [rx, 1.30, rz] });
    weaponExt.push({ muzzleVelocity: 60, convergence: 0, massKg: 0, dragTerminal: 0, spellId: 4451 });
  }
  weapons.push({ kind: 3, muzzle: [0, 0.35, 1.30], lb: 2000 });
  weaponExt.push({ massKg: 907, dragTerminal: 300 });
  weapons.push({ kind: 3, muzzle: [-1.68, 0.42, 1.52], lb: 1000 });
  weaponExt.push({ massKg: 454, dragTerminal: 270 });
  weapons.push({ kind: 3, muzzle: [1.68, 0.42, 1.52], lb: 1000 });
  weaponExt.push({ massKg: 454, dragTerminal: 270 });

  const parts = Array.from({ length: partCount }, (_, i) => ({
    did: 0x02001888 + (i % 7),
    offset: [0, i === 2 ? 1.20 : 0, 2.0],
    rotation: [1, 0, 0, 0],
    scale: 1,
  }));
  const partRoles = parts.map((_, i) => (i === 1 ? 1 : i === 2 ? 2 : i === 3 ? 3 : 0));
  return {
    type: "profile",
    vehicle: 0x80022222,
    profileKey: "hellcat",
    displayName: "Grumman F6F-5 Hellcat",
    standInSetup: 0x020016f1,
    seats: [{ offset: [0, -0.4, 2.34] }],
    weapons,
    weaponExt,
    parts,
    partRoles,
  };
}

// ----------------------------------------------------------------------------- M1: Mode Selection
console.log("M1 vehicleModelMode & shouldUseProceduralHellcat");
await check("auto / procedural / retail selection rules preserve 7-part retail tests and upgrade 257-part Hellcats", () => {
  assert(AF.vehicleModelMode("") === "auto", "default auto");
  assert(AF.vehicleModelMode("?vehicleModel=auto") === "auto", "explicit auto");
  assert(AF.vehicleModelMode("?vehicleModel=procedural") === "procedural", "procedural");
  assert(AF.vehicleModelMode("?vehicleModel=RETAIL") === "retail", "case-insensitive retail");
  assert(AF.vehicleModelMode("?vehicleModel=bogus") === "auto", "unknown falls back to auto");

  const smallDemo = makeFullHellcatProfile(7);
  smallDemo.profileKey = "hellcat-demo";
  const full257 = makeFullHellcatProfile(257);
  const nonHellcat = { ...full257, profileKey: "zephyr-glider" };

  // auto mode: 7-part synthetic demo stays on retail decoder, 257-part in-world Hellcat gets procedural F6F
  assert(AF.shouldUseProceduralHellcat(smallDemo, "") === false, "7-part demo uses retail in auto");
  assert(AF.shouldUseProceduralHellcat(full257, "") === true, "257-part Hellcat uses procedural in auto");
  assert(AF.shouldUseProceduralHellcat(nonHellcat, "") === false, "non-Hellcat stays retail in auto");

  // procedural mode: any Hellcat profile uses procedural, non-Hellcat does not
  assert(AF.shouldUseProceduralHellcat(smallDemo, "?vehicleModel=procedural") === true, "7-part Hellcat forced procedural");
  assert(AF.shouldUseProceduralHellcat(full257, "?vehicleModel=procedural") === true, "257-part Hellcat procedural");
  assert(AF.shouldUseProceduralHellcat(nonHellcat, "?vehicleModel=procedural") === false, "non-Hellcat not procedural");

  // retail mode: never procedural
  assert(AF.shouldUseProceduralHellcat(full257, "?vehicleModel=retail") === false, "257-part forced retail");
  assert(AF.shouldUseProceduralHellcat(smallDemo, "?vehicleModel=retail") === false, "7-part forced retail");
});

// ----------------------------------------------------------------------------- M2: Procedural Geometry, Palette & Draw Calls
console.log("M2 procedural F6F-5/F6F-6 Hellcat geometry, USN tricolor palette & draw-call budget");
await check("non-empty vertex-colored buffers, USN tricolor + yellow tips, <= 24 total meshes, zero lights, full ordnance", () => {
  const worldRoot = new THREE.Group();
  const prof = makeFullHellcatProfile(257);
  const tpl = AF.buildProceduralHellcatTemplate(THREE, prof, { worldRoot });
  assert(tpl.procedural === true, "procedural template flag");
  near(tpl.pivotY, 1.20, 1e-6, "main wheel ground contact Y = 1.20");
  near(tpl.hub[0], 0, 1e-6, "hub x");
  near(tpl.hub[1], 3.84, 1e-6, "hub y");
  near(tpl.hub[2], 2.68, 1e-6, "hub z");
  assert(tpl.meshCount <= 24, `expected <= 24 template meshes, got ${tpl.meshCount}`);

  // Verify position, normal, color attributes contain finite values and span authentic F6F dimensions
  let totalVerts = 0;
  for (const b of tpl.buckets) {
    for (const m of b.meshes) {
      const g = m.geometry;
      const pos = g.getAttribute("position");
      const nor = g.getAttribute("normal");
      const col = g.getAttribute("color");
      assert(pos && pos.count > 0, `${b.key} has positions`);
      assert(nor && nor.count === pos.count, `${b.key} has normals`);
      if (b.key !== "prop" || m !== b.meshes[1]) {
        assert(col && col.count === pos.count, `${b.key} has vertex colors`);
      }
      for (let i = 0; i < pos.array.length; i++) assert(Number.isFinite(pos.array[i]), `${b.key} finite pos`);
      for (let i = 0; i < nor.array.length; i++) assert(Number.isFinite(nor.array[i]), `${b.key} finite normal`);
      // Verify triangle winding agrees with vertex normals (no inside-out lofted surfaces!)
      if (m.cast) {
        let aligned = 0, checked = 0;
        for (let t = 0; t < pos.count; t += 3) {
          const ax = pos.array[t * 3], ay = pos.array[t * 3 + 1], az = pos.array[t * 3 + 2];
          const bx = pos.array[t * 3 + 3] - ax, by = pos.array[t * 3 + 4] - ay, bz = pos.array[t * 3 + 5] - az;
          const cx = pos.array[t * 3 + 6] - ax, cy = pos.array[t * 3 + 7] - ay, cz = pos.array[t * 3 + 8] - az;
          const fx = by * cz - bz * cy, fy = bz * cx - bx * cz, fz = bx * cy - by * cx;
          if (Math.hypot(fx, fy, fz) < 1e-8) continue;
          const nx = nor.array[t * 3], ny = nor.array[t * 3 + 1], nz = nor.array[t * 3 + 2];
          checked++;
          if (fx * nx + fy * ny + fz * nz > 0) aligned++;
        }
        assert(checked > 0 && aligned / checked > 0.99, `${b.key} winding aligned (${aligned}/${checked})`);
      }
      totalVerts += pos.count;
    }
  }
  assert(totalVerts > 1500, `rich procedural Hellcat geometry (${totalVerts} vertices)`);

  // Check wingspan (~13.1 m -> ±6.55 m) and fuselage length (-6.4..+3.72 m) on static airframe
  const staticBox = tpl.geometries.static.boundingBox;
  near(staticBox.max.x - staticBox.min.x, 13.10, 0.25, "wingspan ~13.1 m");
  assert(staticBox.min.y < -6.2 && staticBox.max.y > 3.65, `fuselage length [${staticBox.min.y}, ${staticBox.max.y}]`);

  // Check USN WWII Tricolor Camouflage presence in static vertex colors + Insignia Yellow in prop blades
  const cSea = new THREE.Color(AF.HELLCAT_PALETTE.seaBlue);
  const cInter = new THREE.Color(AF.HELLCAT_PALETTE.intermediateBlue);
  const cWhite = new THREE.Color(AF.HELLCAT_PALETTE.insigniaWhite);
  const cStar = new THREE.Color(AF.HELLCAT_PALETTE.starWhite);
  const cYellow = new THREE.Color(AF.HELLCAT_PALETTE.propYellow);
  const closeColor = (arr, stride, target, tol = 0.06) => {
    for (let i = 0; i < arr.length; i += stride) {
      if (Math.hypot(arr[i] - target.r, arr[i + 1] - target.g, arr[i + 2] - target.b) < tol) return true;
    }
    return false;
  };
  const sCol = tpl.geometries.static.getAttribute("color").array;
  assert(closeColor(sCol, 3, cSea), "Non-Specular Sea Blue (#1b2d42) present");
  assert(closeColor(sCol, 3, cInter), "Intermediate Blue (#4c6885) present");
  assert(closeColor(sCol, 3, cWhite), "Insignia White (#e6e9ec) present");
  assert(closeColor(sCol, 3, cStar, 0.03), "USN Star-and-Bars white appliqué present");
  const pCol = tpl.geometries.propSolid.getAttribute("color").array;
  assert(closeColor(pCol, 3, cYellow, 0.03), "Hamilton Standard Insignia Yellow (#f6c324) prop tips present");

  for (const g of tpl.ownedGeometries) g.dispose();
  for (const m of tpl.ownedMaterials) m.dispose();
  for (const tx of tpl.ownedTextures) tx.dispose();

  // Instantiate through createAirframes and verify scene graph hierarchy, ordnance & releaseBomb compatibility
  const afs = AF.createAirframes({ liveScene3d: { worldRoot }, THREE });
  const inst = afs.ensure({ guid: 0x80022222, profile: prof });
  assert(inst && inst.procedural, "procedural instance created immediately");
  assert(inst.groups.gear && inst.groups.canopy && inst.groups.prop && inst.groups.windscreen, "required subgroups");
  for (const k of ["aileronL", "aileronR", "elevator", "rudder", "flaps", "tailhook"]) {
    assert(inst.surfaces[k] && inst.surfaces[k].isObject3D, `surface ${k}`);
  }

  let meshDrawCalls = 0, lightCount = 0;
  inst.root.traverse((obj) => {
    if (obj.isMesh || obj.isSprite || obj.isPoints || obj.isLine) meshDrawCalls++;
    if (obj.isLight) lightCount++;
  });
  assert(lightCount === 0, `zero PointLight/SpotLight allowed, found ${lightCount}`);
  assert(meshDrawCalls <= 24, `total draw calls ${meshDrawCalls} <= 24 (vs 94 retail)`);
  const nonOrdnanceDrawCalls = meshDrawCalls - inst.ordnance.size;
  assert(nonOrdnanceDrawCalls < 22, `airframe draw calls ${nonOrdnanceDrawCalls} < 22`);

  // Verify all 6 rocket stations (6..11) and 3 bomb stations (12..14) exist and hand valid meshes to weapons.js
  assert(inst.ordnance.size === 9, `9 ordnance stations, got ${inst.ordnance.size}`);
  for (let w = 6; w <= 14; w++) {
    const meshes = afs.ordnanceMeshes(0x80022222, w);
    assert(meshes.length === 1 && meshes[0].isMesh && meshes[0].geometry.getAttribute("position").count > 20, `station ${w} mesh`);
  }
  const wfx = W.createWeaponsFx({ liveScene3d: { worldRoot }, THREE, ground: () => 0 });
  const cl = FM.toCellLocal(1000, 1000, 120);
  wfx.releaseBomb(
    { vehicle: 0x80022222, aux: 12, value: 2000, cell: cl.cell, x: cl.x, y: cl.y, z: cl.z, vel: [0, 85, -1.5] },
    { meshes: afs.ordnanceMeshes(0x80022222, 12), muzzle: prof.weapons[12].muzzle, terminal: 300 }
  );
  assert(wfx.stats().liveBombs === 1, "weapons.js releaseBomb accepts procedural AN-M66 bomb mesh");
  wfx.dispose();
  afs.dispose();
  assert(worldRoot.children.length === 0, "cleanly removed from worldRoot on dispose");
});

// ----------------------------------------------------------------------------- M3: Dynamic Articulation & FX in pose()
console.log("M3 dynamic animations in afs.pose(...)");
await check("prop blur, sliding canopy, twist-and-turn gear, control surfaces, flaps, tailhook & WEP exhaust", () => {
  const worldRoot = new THREE.Group();
  const prof = makeFullHellcatProfile(257);
  const afs = AF.createAirframes({ liveScene3d: { worldRoot }, THREE });
  const inst = afs.ensure({ guid: 0x80033333, profile: prof });
  const q = FM.orientation(0, 0, 0);

  // 1. PARKED idle: tail down 11°, canopy slid open (-0.72 m), gear down, prop blur 0, exhaust hidden
  for (let i = 0; i < 60; i++) {
    afs.pose(inst, { x: 500, y: 600, z: 0, heading: 0, pitch: 0, bank: 0, speed: 0, mode: FM.MODE.PARKED }, {
      q, dt: 1 / 30, throttle: 0, agl: 0, missileMask: 63, bombMask: 7,
    });
  }
  near(inst.body.rotation.x, AF.GEAR_PITCH, 1e-3, "parked 11° nose-up stance");
  near(inst.groups.canopy.position.y, -0.72, 1e-3, "canopy slid aft open on carrier deck");
  near(inst.gearDeploy, 1, 1e-3, "gear fully deployed");
  assert(inst.groups.gear.visible === true, "gear visible when parked");
  near(inst.propBlurOpacity, 0, 1e-3, "prop blur disc hidden at parked idle");
  assert(inst.exhaust.visible === false && inst.exhaust.scale === 0, "exhaust flames hidden at parked idle");

  // 2. TAKEOFF: flaps deploy toward 34°, canopy slides closed, cruise exhaust ignites
  for (let i = 0; i < 75; i++) {
    afs.pose(inst, { x: 500, y: 650, z: 12, heading: 0, pitch: 0.08, bank: 0, speed: 38, mode: FM.MODE.TAKEOFF }, {
      q, dt: 1 / 30, throttle: 0.65, agl: 12,
    });
  }
  near(inst.groups.canopy.position.y, 0, 2e-3, "canopy closed for takeoff");
  near(inst.surfaces.flaps.rotation.x, 34 * DEG, 0.02, "flaps deployed 34° in takeoff");
  near(inst.surfaces.tailhook.rotation.x, 0, 1e-3, "tailhook stowed in takeoff");
  const cruiseExhaustScale = inst.exhaust.scale;
  assert(inst.exhaust.visible && cruiseExhaustScale > 0.3, `cruise exhaust visible (${cruiseExhaustScale})`);

  // 3. FLIGHT + WEP + stick deflections: gear twists 90° & folds 90° aft then hides, prop blur ~0.40, exhaust roars
  const propA0 = inst.propAngle;
  afs.pose(inst, { x: 500, y: 800, z: 250, heading: 0, pitch: 0.1, bank: 0.2, speed: 110, mode: FM.MODE.FLIGHT }, {
    q, dt: 0.25, throttle: 1, boost: true, roll: 0.8, pitch: 0.7, yaw: -0.6,
  });
  // Mid-retraction check: gearDeploy between 0 and 1, folding aft (-x) & twisting (±z)
  assert(inst.gearDeploy > 0.1 && inst.gearDeploy < 0.9, `mid-retraction gearDeploy ${inst.gearDeploy}`);
  assert(inst.gearParts.left.rotation.x < -0.1 && inst.gearParts.left.rotation.z > 0.1, "left gear folding aft & twisting");
  assert(inst.gearParts.right.rotation.x < -0.1 && inst.gearParts.right.rotation.z < -0.1, "right gear folding aft & opposite twist");

  for (let i = 0; i < 120; i++) {
    afs.pose(inst, { x: 500, y: 900 + i, z: 250, heading: 0, pitch: 0.1, bank: 0.2, speed: 115, mode: FM.MODE.FLIGHT }, {
      q, dt: 1 / 30, throttle: 1, boost: true, roll: 1.0, pitch: 1.0, yaw: -1.0, cockpit: true, hideWindscreen: true,
    });
  }
  near(inst.gearDeploy, 0, 2e-3, "gear fully retracted in flight");
  near(inst.gearParts.left.rotation.x, -Math.PI / 2, 0.01, "main gear folded 90° aft");
  near(inst.gearParts.left.rotation.z, Math.PI / 2, 0.01, "left gear twisted +90°");
  near(inst.gearParts.right.rotation.z, -Math.PI / 2, 0.01, "right gear twisted -90°");
  assert(inst.groups.gear.visible === false, "gear group hidden once retracted");
  assert(inst.propAngle !== propA0, "propeller rotated");
  near(inst.propBlurOpacity, 0.40, 0.01, "prop blur disc reaches 0.40 opacity at full speed/WEP");
  assert(inst.propParts.solid.material.opacity < 0.45, "solid prop blades faded at high speed to prevent strobing");
  assert(!inst.groups.canopy.visible, "canopy hidden in cockpit view");
  assert(!inst.groups.windscreen.visible, "windscreen hidden when hideWindscreen is set");

  // Differential ailerons (±20°), elevator (-22°), rudder (-25°), flaps retracted
  near(inst.surfaces.aileronL.rotation.x, 20 * DEG, 0.02, "left aileron +20°");
  near(inst.surfaces.aileronR.rotation.x, -20 * DEG, 0.02, "right aileron -20°");
  near(inst.surfaces.elevator.rotation.x, -22 * DEG, 0.02, "elevator -22°");
  near(inst.surfaces.rudder.rotation.z, -25 * DEG, 0.02, "rudder -25°");
  near(inst.surfaces.flaps.rotation.x, 0, 0.02, "flaps retracted in cruise flight");
  assert(inst.exhaust.boost && inst.exhaust.scale > cruiseExhaustScale * 1.4, `WEP exhaust larger than cruise (${inst.exhaust.scale} vs ${cruiseExhaustScale})`);

  // 4. LANDING: flaps 34° + carrier arrestor tailhook 30° + windscreen visible in normal cockpit view
  for (let i = 0; i < 90; i++) {
    afs.pose(inst, { x: 500, y: 1200, z: 30, heading: 0, pitch: 0, bank: 0, speed: 42, mode: FM.MODE.LANDING }, {
      q, dt: 1 / 30, throttle: 0.3, agl: 30, cockpit: true, hideWindscreen: false,
    });
  }
  assert(inst.groups.windscreen.visible === true, "windscreen + Mk 8 sight visible in cockpit view");
  near(inst.surfaces.flaps.rotation.x, 34 * DEG, 0.02, "flaps 34° in landing");
  near(inst.surfaces.tailhook.rotation.x, 30 * DEG, 0.02, "arrestor tailhook 30° in landing");
  assert(inst.groups.gear.visible && inst.gearDeploy > 0.99, "landing gear re-extended for carrier landing");

  // 5. Observer rate inference (no stick inputs passed -> ailerons & elevator deflect from bank/pitch rates)
  let bAng = 0, pAng = 0;
  for (let i = 0; i < 20; i++) {
    bAng += 0.03;
    pAng += 0.02;
    afs.pose(inst, { x: 500, y: 1300 + i * 2, z: 200, heading: 0, pitch: pAng, bank: bAng, speed: 90, mode: FM.MODE.FLIGHT }, {
      q, dt: 1 / 30,
    });
  }
  assert(inst.surfaces.aileronL.rotation.x > 0.05 && inst.surfaces.aileronR.rotation.x < -0.05, "observer roll inferred onto ailerons");
  assert(inst.surfaces.elevator.rotation.x < -0.05, "observer pitch inferred onto elevator");

  afs.dispose();
});

// ----------------------------------------------------------------------------- M4: World-Space Aerodynamic VFX (`aero_fx.js`)
console.log("M4 createAeroFx wingtip vortices, startup/WEP smoke, propwash/spray & cleanup");
await check("high-G wingtip vortices, startup & WEP smoke pool, low-AGL propwash & sea spray, forgetVehicle & dispose", () => {
  const worldRoot = new THREE.Group();
  const aero = AERO.createAeroFx({ liveScene3d: { worldRoot }, THREE, ground: () => 0 });
  aero.warm();

  let lightCount = 0;
  worldRoot.traverse((o) => { if (o.isLight) lightCount++; });
  assert(lightCount === 0, "zero lights in aero_fx");

  const GUID = 0x80044444;
  const qLevel = FM.orientation(0, 0, 0);

  // 1. Level 1-G flight: no wingtip vortices emitted
  for (let i = 0; i < 10; i++) {
    aero.updateVehicle(GUID, { x: 1000, y: 1000 + i * 2, z: 300, bank: 0, speed: 95, mode: FM.MODE.FLIGHT }, qLevel, {
      dt: 1 / 60, throttle: 0.7, gLoad: 1.0, agl: 300,
    });
    aero.tick(1 / 60);
  }
  assert(aero.stats().activeVortexSegments === 0, "no vortices in 1G cruise");

  // 2. High-G banked turn (speed > 46, gLoad > 1.55): twin wingtip condensation ribbons emit and then fade over 0.45 s
  const qBank = FM.orientation(0.3, 0.05, 62 * DEG); // 1 / cos(62°) ≈ 2.13 G
  for (let i = 0; i < 12; i++) {
    aero.updateVehicle(GUID, { x: 1000 + i * 1.4, y: 1040 + i * 1.6, z: 300, bank: 62 * DEG, speed: 92, mode: FM.MODE.FLIGHT }, qBank, {
      dt: 1 / 60, throttle: 0.9, agl: 300,
    });
    aero.tick(1 / 60);
  }
  const stVortex = aero.stats();
  assert(stVortex.activeVortexSegments >= 10 && stVortex.emittedVortex >= 20, `twin vortices active: ${JSON.stringify(stVortex)}`);

  // Roll wings-level and advance > 0.45 s -> vortices fade smoothly to 0
  for (let i = 0; i < 35; i++) aero.tick(0.02);
  assert(aero.stats().activeVortexSegments === 0, "wingtip vortices faded out after 0.45 s");

  // 3. Startup cough (PARKED -> TAKEOFF), WEP soot wisps (boost: true), low-AGL terrain dust & ocean spray
  const GUID2 = 0x80055555;
  aero.updateVehicle(GUID2, { x: 200, y: 200, z: 0, speed: 0, mode: FM.MODE.PARKED }, qLevel, { dt: 1 / 30, throttle: 0, agl: 0 });
  for (let i = 0; i < 12; i++) {
    aero.updateVehicle(GUID2, { x: 200, y: 200 + i, z: 4, speed: 15, mode: FM.MODE.TAKEOFF }, qLevel, {
      dt: 1 / 30, throttle: 0.85, boost: true, agl: 4, inOcean: false,
    });
    aero.tick(1 / 30);
  }
  const stGround = aero.stats();
  assert(stGround.emittedSmoke > 0 && stGround.emittedWep > 0, `startup + WEP smoke emitted: ${JSON.stringify(stGround)}`);
  assert(stGround.activeSmoke <= AERO.AERO_FX.maxSmokeSprites, `smoke pool bounded <= 40 (${stGround.activeSmoke})`);
  assert(stGround.emittedPropwash > 0 && stGround.activePropwash > 0, "low-AGL terrain dust emitted");

  // Low-altitude ocean skim -> white sea-spray mist
  for (let i = 0; i < 8; i++) {
    aero.updateVehicle(GUID2, { x: 200, y: 50000 + i * 3, z: 8, speed: 88, mode: FM.MODE.FLIGHT }, qLevel, {
      dt: 1 / 30, throttle: 0.9, agl: 8, inOcean: true,
    });
    aero.tick(1 / 30);
  }
  assert(aero.stats().emittedSpray > 0, "ocean sea-spray mist emitted");

  // forgetVehicle removes vehicle tracking cleanly
  aero.updateVehicle(GUID, { x: 1200, y: 1200, z: 300, bank: 65 * DEG, speed: 95, mode: FM.MODE.FLIGHT }, qBank, { dt: 1 / 60, gLoad: 2.5 });
  aero.updateVehicle(GUID, { x: 1202, y: 1202, z: 300, bank: 65 * DEG, speed: 95, mode: FM.MODE.FLIGHT }, qBank, { dt: 1 / 60, gLoad: 2.5 });
  assert(aero.stats().activeVortexSegments > 0, "vortex re-emitted before forget");
  assert(aero.forgetVehicle(GUID) === true, "forgetVehicle returns true");
  assert(aero.stats().activeVortexSegments === 0, "forgetVehicle clears vehicle vortices immediately");

  aero.dispose();
  assert(worldRoot.children.length === 0, "aero_fx root removed on dispose");
});

console.log(`\nvehicle_airframe_model: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
