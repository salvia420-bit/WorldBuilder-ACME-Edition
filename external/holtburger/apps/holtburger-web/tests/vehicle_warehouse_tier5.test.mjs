// tests/vehicle_warehouse_tier5.test.mjs — Tier 5 White-Box Adversarial Hardening & Regression Suite
//
// Integrated from m4_p2_challenger_1/tier5_adversarial.mjs.
// Usage:
//   node tests/vehicle_warehouse_tier5.test.mjs             # Runs Part A + Part B
//   node tests/vehicle_warehouse_tier5.test.mjs --part=a    # Runs only Part A
//   node tests/vehicle_warehouse_tier5.test.mjs --part=b    # Runs only Part B

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = existsSync(join(HERE, "../scene3d/vehicle/warehouse_manager.js"))
  ? join(HERE, "..")
  : "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web";

const imp = (rel) => import(pathToFileURL(join(APP_ROOT, rel)).href);

const THREE = await imp("node_modules/three/build/three.module.js");
const WS = await imp("scene3d/vehicle/warehouse_specs.js");
const WK = await imp("scene3d/vehicle/warehouse_kinematics.js");
const { buildRackRow } = await imp("scene3d/vehicle/warehouse_rack_model.js");
const { buildAgfForklift } = await imp("scene3d/vehicle/agf_forklift_model.js");
const { buildAmrUnderride } = await imp("scene3d/vehicle/amr_underride_model.js");
const {
  buildTransferStandGroup,
  buildChargingDockGroup,
} = await imp("scene3d/vehicle/warehouse_infra_model.js");
const { createWarehouseManager } = await imp("scene3d/vehicle/warehouse_manager.js");
const { createLogisticsAudio } = await imp("scene3d/vehicle/audio.js");
const { ISO_CONTAINER_SPECS, CONTAINER_WCID } = await imp("scene3d/vehicle/container_models.js");

const [ox, oy] = WS.NE_FLATLAND_SITE.origin;
const AGF_HULL_CORNERS = [
  [-0.57, -1.93], [0.57, -1.93],
  [-0.57, 0.15], [0.57, 0.15],
  [-0.34, 1.30], [0.34, 1.30],
];

function makeDefaultContainers(extra = []) {
  const map = new Map();
  for (const d of [
    { guid: 38145, kind: 11, pos: [ox - 40, oy + 32.5, 0], slots: [{ slotIndex: 18, palletSize: 2, cargoWcid: 4000014 }, { slotIndex: 19, palletSize: 2, cargoWcid: 4000011 }] },
    { guid: 38146, kind: 12, pos: [ox - 24, oy + 32.5, 0], slots: [] },
    { guid: 38147, kind: 10, pos: [ox - 8, oy + 29.43, 0], slots: [] },
    ...extra,
  ]) {
    map.set(d.guid, {
      guid: d.guid,
      wcid: d.kind === 10 ? 4000020 : d.kind === 11 ? 4000021 : 4000022,
      kind: d.kind,
      heading: d.heading ?? 0,
      rawPos: [...d.pos],
      currentDoorProgress: d.doorProgress ?? 1.0,
      mountedOnTrailerGuid: d.mountedOnTrailerGuid ?? 0,
      slots: d.slots ? [...d.slots] : [],
      model: { root: { position: { x: d.pos[0], y: d.pos[1], z: d.pos[2] ?? 0 } }, syncSlots() {} },
    });
  }
  return map;
}

function makeRig(shExtra = {}) {
  return {
    live: { worldRoot: new THREE.Group(), csmState: null },
    sh: { vehicleContainerAction() {}, ...shExtra },
  };
}

function getObbs(mgr, containersMap) {
  const list = [];
  for (const r of mgr.racks.values()) {
    const b = r.worldBounds;
    if (b) list.push({ id: r.id, cx: (b.minX + b.maxX) * 0.5, cy: (b.minY + b.maxY) * 0.5, h: 0, hw: (b.maxX - b.minX) * 0.5, hl: (b.maxY - b.minY) * 0.5 });
  }
  for (const st of mgr.stands.values()) {
    list.push({ id: st.id, cx: st.pos[0], cy: st.pos[1], h: st.heading, hw: WS.STAND_SPECS.outerWidthM * 0.5, hl: WS.STAND_SPECS.outerDepthM * 0.5 });
  }
  for (const lt of mgr.liftTables.values()) {
    list.push({ id: lt.id, cx: lt.x, cy: lt.y, h: 0, hw: WS.LIFT_TABLE_SPECS.outerWidthM * 0.5, hl: WS.LIFT_TABLE_SPECS.outerDepthM * 0.5 });
  }
  for (const c of mgr.chargers.values()) {
    list.push({ id: c.id, cx: c.pos[0], cy: c.pos[1], h: c.heading || 0, hw: WS.CHARGER_SPECS.widthM * 0.5, hl: WS.CHARGER_SPECS.depthM * 0.5 });
  }
  for (const ce of containersMap.values()) {
    const p = ce.rawPos;
    list.push({ id: `C_${ce.guid}`, cx: p[0], cy: p[1], h: ce.heading || 0, hw: 1.219, hl: ce.kind === 10 ? 3.029 : 6.096 });
  }
  return list;
}

function satObbHit(cx, cy, h, hw, hl, ob) {
  const aU = [Math.cos(h), -Math.sin(h)];
  const aV = [Math.sin(h), Math.cos(h)];
  const bU = [Math.cos(ob.h), -Math.sin(ob.h)];
  const bV = [Math.sin(ob.h), Math.cos(ob.h)];
  const dx = ob.cx - cx;
  const dy = ob.cy - cy;
  for (const [nx, ny] of [aU, aV, bU, bV]) {
    const dist = Math.abs(dx * nx + dy * ny);
    const rA = hw * Math.abs(aU[0] * nx + aU[1] * ny) + hl * Math.abs(aV[0] * nx + aV[1] * ny);
    const rB = ob.hw * Math.abs(bU[0] * nx + bU[1] * ny) + ob.hl * Math.abs(bV[0] * nx + bV[1] * ny);
    if (dist >= rA + rB - 1e-4) return false;
  }
  return true;
}

function checkAgfHits(agf, obbs) {
  let cornerHits = 0;
  let satHits = 0;
  for (const [lx, ly] of AGF_HULL_CORNERS) {
    const [wx, wy] = WS.localToWorld2D(lx, ly, agf.x, agf.y, agf.heading);
    for (const b of obbs) {
      const dx = wx - b.cx;
      const dy = wy - b.cy;
      const c = Math.cos(b.h);
      const s = Math.sin(b.h);
      const bx = dx * c - dy * s;
      const by = dx * s + dy * c;
      if (Math.abs(bx) < b.hw - 1e-4 && Math.abs(by) < b.hl - 1e-4) cornerHits++;
    }
  }
  const [chX, chY] = WS.localToWorld2D(0, -0.89, agf.x, agf.y, agf.heading);
  const [fkX, fkY] = WS.localToWorld2D(0, 0.725, agf.x, agf.y, agf.heading);
  for (const b of obbs) {
    if (satObbHit(chX, chY, agf.heading, 0.57, 1.04, b) || satObbHit(fkX, fkY, agf.heading, 0.34, 0.575, b)) {
      satHits++;
    }
  }
  return { cornerHits, satHits };
}

async function stepUntilSettled(stepFn, promise, maxSteps = 8000) {
  let done = false;
  let err = null;
  let val;
  Promise.resolve(promise).then(
    (v) => { done = true; val = v; },
    (e) => { done = true; err = e; },
  );
  for (let i = 0; i < maxSteps; i++) {
    stepFn(i);
    await Promise.resolve();
    if (done) {
      if (err) throw err;
      return { steps: i + 1, value: val };
    }
  }
  throw new Error(`Promise did not settle within ${maxSteps} steps`);
}

const partFlag = process.argv.find((a) => a.startsWith("--part="))?.split("=")[1]?.toLowerCase() || "all";
const queue = [];
function test(part, name, fn) {
  if (partFlag === "all" || partFlag === part.toLowerCase()) {
    queue.push({ part, name, fn });
  }
}

// ===========================================================================
// PART A — Tier 5 Coverage Hardening
// ===========================================================================

test("A", "T5-A01 (T2-F7-01 hardening): agf.root Box3.min.z >= -0.005 on forkHeightM=-1.0 & rearSteerPivot ±82 deg clamp", () => {
  const agf = buildAgfForklift(THREE);
  try {
    agf.update({ forkHeightM: -1.0, sideShiftM: -0.5, mastTiltRad: 0, steerAngleRad: -3.0 });
    agf.root.updateMatrixWorld(true);
    const bLow = new THREE.Box3().setFromObject(agf.root);
    assert.ok(bLow.min.z >= -0.005, `agf.root Box3.min.z=${bLow.min.z} < -0.005`);
    assert.ok(Math.abs(agf.steerAngleRad + WS.AGF_SPECS.maxSteerRad) < 1e-5, "negative steerAngleRad clamped to -82 deg");
    assert.ok(Math.abs(agf.rearSteerPivot.rotation.z + WS.AGF_SPECS.maxSteerRad) < 1e-5, "rearSteerPivot.rotation.z clamped to -82 deg");

    agf.update({ steerAngleRad: +3.0 });
    agf.root.updateMatrixWorld(true);
    assert.ok(Math.abs(agf.steerAngleRad - WS.AGF_SPECS.maxSteerRad) < 1e-5, "positive steerAngleRad clamped to +82 deg");
    assert.ok(Math.abs(agf.rearSteerPivot.rotation.z - WS.AGF_SPECS.maxSteerRad) < 1e-5, "rearSteerPivot.rotation.z clamped to +82 deg");
  } finally {
    agf.dispose();
  }
});

test("A", "T5-A02 (T3-02 hardening): outer-mast mesh & agf.root Box3.max.z < doorH at freelift 1.700m with carriedWcid=0", () => {
  const doorH = ISO_CONTAINER_SPECS[CONTAINER_WCID.IsoContainer40].door.height;
  const agf = buildAgfForklift(THREE);
  try {
    for (const h of [0.045, 1.700]) {
      agf.update({ forkHeightM: h, mastTiltRad: 0, carriedWcid: 0 });
      agf.root.updateMatrixWorld(true);
      const outerMesh = agf.root.getObjectByName("agf-mast-outer-mesh");
      assert.ok(outerMesh, "agf-mast-outer-mesh present");
      const outerBox = new THREE.Box3().setFromObject(outerMesh);
      const rootBox = new THREE.Box3().setFromObject(agf.root);
      assert.ok(outerBox.max.z < doorH, `outer mast max.z=${outerBox.max.z} >= doorH=${doorH}`);
      assert.ok(rootBox.max.z < doorH, `root max.z=${rootBox.max.z} >= doorH=${doorH}`);
    }
  } finally {
    agf.dispose();
  }
});

test("A", "T5-A03 (warehouse_kinematics): pre-raised roofStrikeBlocked clamp, direct control, reverse='auto', dt<=0, grid edge cases, LiftTable partial & 45-deg AMR", () => {
  const preRaised = WK.stepAgfKinematics(
    { x: 100, y: 198, heading: 0, forkHeightM: 2.5 },
    { targetForkHeightM: 2.5, sideShiftM: 1.0, mastTiltRad: -1.0 },
    1 / 60,
    { container: { x: 100, y: 200, heading: 0, wcid: 4000021, kind: 11 } }
  );
  assert.equal(preRaised.insideContainer, true);
  assert.equal(preRaised.roofStrikeBlocked, true);
  assert.ok(preRaised.forkHeightM <= WS.AGF_SPECS.containerMaxForkHeightM + 1e-9);

  const direct = WK.stepAgfKinematics({ x: 0, y: 0, heading: 0 }, { steer: 2.0, throttle: 2.0 }, 1 / 60);
  assert.ok(direct.speed > 0 && direct.steerAngleRad > 0);
  const frozen = WK.stepAgfKinematics({ x: 5, y: 6, heading: 0 }, { speed: 1.0 }, -0.5);
  assert.equal(frozen.x, 5);
  assert.equal(frozen.y, 6);
  const autoRev = WK.stepAgfKinematics({ x: 0, y: 0, heading: 0 }, { targetPose: { x: 0, y: -2, reverse: "auto" } }, 1 / 60);
  assert.ok(autoRev.speed < 0, "reverse='auto' reverses when target behind");

  const grid = new WK.SpatialReservationGrid({ cellSizeM: 1.0, stopDistM: 0.8, slowDistM: 2.2 });
  assert.equal(grid.claim("", 0, 0).ok, false);
  assert.equal(grid.claim("a", NaN, 0).ok, false);
  assert.equal(grid.release("missing"), 0);
  assert.equal(grid.claim("a", 0, 0, 0.5).ok, true);
  assert.equal(grid.claim("b", 0, -2.1, 0.5).ok, true);
  assert.equal(grid.queryProximity("a", 0, 0, 0, { directional: true }).yieldLevel, "clear");
  assert.equal(grid.queryProximity("a", 0, 0, 0, { directional: false }).yieldLevel, "slow");

  const ltPart = WK.stepLiftTable({ x: 0, y: 0, heading: 0, heightM: 0 }, { targetHeightM: 0.20 }, 2.0, {});
  assert.ok(Math.abs(ltPart.heightM - 0.20) < 1e-6);
  const lt45 = WK.stepLiftTable({ x: 0, y: 0, heading: 0, heightM: 0.38 }, "lower", 0.5, {
    amr: { x: 0.85, y: 0.85, heading: Math.PI * 0.25 },
  });
  assert.equal(lt45.interlockBlocked, true);
  assert.equal(lt45.interlockReason, "amr_underride_occupied");

  const amrTt = WK.stepAmrKinematics({ x: 0, y: 0, heading: 0, turntableYawRad: 0 }, { targetTurntableYawRad: 1.5, charging: true }, 0.1);
  assert.ok(Math.abs(amrTt.turntableYawRad - 0.24) < 1e-6);
  assert.equal(amrTt.statusMode, "charging");
});

test("A", "T5-A04 (models): RangeError on bad rack coords, empty unload/LOD, invalid stand/charger IDs", () => {
  const rack = buildRackRow(THREE, { bayCount: 2, doubleSided: false });
  try {
    assert.throws(() => rack.loadSlot(5, 0, 0, 0, 4000010), RangeError);
    assert.throws(() => rack.loadSlot(0, 9, 0, 0, 4000010), RangeError);
    assert.throws(() => rack.loadSlot(0, 0, 0, 3, 4000010), RangeError);
    assert.equal(rack.unloadSlot(0, 0, 0, 0), false);
    assert.equal(rack.setCargoLodDistance(200), false);
  } finally {
    rack.dispose();
  }
  const docks = buildChargingDockGroup(THREE, [{ id: "CH1", localPos: [0, 0, 0], pos: [0, 0, 0], heading: 0 }], { useLocalPos: true });
  assert.equal(docks.setDockState("NOPE", "charging"), false);
  docks.dispose();
  const stands = buildTransferStandGroup(THREE, [{ id: "S1", localPos: [0, 0, 0], pos: [0, 0, 0], heading: 0 }], { useLocalPos: true });
  assert.equal(stands.setSlotCargo("NOPE", 4000010), null);
  stands.dispose();
});

test("A", "T5-A05 (manager error paths & lifecycle): invalid tasks, closed/trailer/LIFO containers, clearHub, re-buildHub, dispose, stopScenarios, bayCount=4", async () => {
  const rig = makeRig();
  const cMap = makeDefaultContainers([
    { guid: 99001, kind: 11, pos: [ox + 20, oy + 32.5, 0], doorProgress: 0.0, slots: [{ slotIndex: 19, palletSize: 2, cargoWcid: 4000010 }] },
    { guid: 99002, kind: 11, pos: [ox + 30, oy + 32.5, 0], doorProgress: 1.0, mountedOnTrailerGuid: 0x77000001, slots: [{ slotIndex: 19, palletSize: 2, cargoWcid: 4000010 }] },
    { guid: 99003, kind: 11, pos: [ox + 40, oy + 32.5, 1.32], doorProgress: 1.0, slots: [{ slotIndex: 19, palletSize: 2, cargoWcid: 4000010 }] },
  ]);
  const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
  mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin, bayCount: 4 });
  assert.equal(mgr.racks.get("R1").bayCount, 4);

  const agf = mgr.spawnAgf("agf-err", { pos: [ox, oy + 18, 0], heading: 0 });
  const amr = mgr.spawnAmr("amr-err", { pos: [ox, oy - 29, 0], heading: 0 });

  const expectRej = async (p, rx, lbl = "") => {
    let err = null;
    const caught = p.catch((e) => { err = e; });
    mgr.tick(1 / 60);
    await Promise.race([caught, new Promise((_, rej) => setTimeout(() => rej(new Error(`expectRej timed out: ${lbl || rx}`)), 500))]);
    assert.ok(err && rx.test(err.message), `expected ${rx}, got ${err?.message}`);
  };

  await expectRej(agf.enqueue({}), /Invalid AGF task/);
  await expectRej(agf.enqueue({ type: "fly" }), /Unknown AGF task/);
  await expectRej(agf.enqueue({ type: "driveTo", waypoints: [] }), /non-empty waypoints/);
  await expectRej(agf.enqueue({ type: "pickFromRack", rackId: "R99", bay: 0, tier: 0, side: 0, slotInBay: 0 }), /Unknown rackId/);
  await expectRej(agf.enqueue({ type: "placeInRack", rackId: "R1", bay: 9, tier: 0, side: 0, slotInBay: 0 }), /Invalid rack coordinates/);
  await expectRej(agf.enqueue({ type: "placeInRack", rackId: "R1", bay: 0, tier: 0, side: 0, slotInBay: 0 }), /not carrying cargo/);
  await expectRej(agf.enqueue({ type: "pickFromRack", rackId: "R1", bay: 0, tier: 0, side: 0, slotInBay: 0 }), /is empty/);
  await expectRej(agf.enqueue({ type: "pickFromContainer", containerGuid: 12345, slotIndex: 19 }), /not found/);
  await expectRej(agf.enqueue({ type: "pickFromContainer", containerGuid: 99001, slotIndex: 19 }), /doors are closed/);
  await expectRej(agf.enqueue({ type: "pickFromContainer", containerGuid: 99002, slotIndex: 19 }), /trailer-mounted/);
  await expectRej(agf.enqueue({ type: "pickFromContainer", containerGuid: 99003, slotIndex: 19 }), /trailer-mounted/);
  await expectRej(agf.enqueue({ type: "pickFromContainer", containerGuid: 38145, slotIndex: 0 }), /unreachable for unload/);
  await expectRej(agf.enqueue({ type: "placeOnStand", standId: "S99" }), /Unknown standId/);
  await expectRej(agf.enqueue({ type: "pickFromStand", standId: "S1" }), /is empty/);
  await expectRej(agf.enqueue({ type: "pickGroundDeployable", deployableGuid: 88888 }), /not found/);
  await expectRej(agf.enqueue({ type: "dropToGround", pos: null }), /valid pos/);
  await expectRej(agf.enqueue({ type: "dropToGround", pos: [ox, oy, 0] }), /not carrying cargo/);

  await expectRej(amr.enqueue(null), /Invalid AMR task/);
  await expectRej(amr.enqueue({ type: "teleport" }), /Unknown AMR task/);
  await expectRej(amr.enqueue({ type: "driveTo", waypoints: [] }), /non-empty waypoints/);
  await expectRej(amr.enqueue({ type: "pickFromStand", standId: "S99" }), /Unknown standId/);
  await expectRej(amr.enqueue({ type: "pickFromStand", standId: "S1" }), /is empty/);
  await expectRej(amr.enqueue({ type: "pickFromStand", standId: "L1" }), /is empty|not raised/);
  await expectRej(amr.enqueue({ type: "dockCharge", chargerId: "CH99" }), /Unknown chargerId/);

  const pend = agf.enqueue({ type: "driveTo", waypoints: [[ox + 10, oy + 18]] }).catch((e) => e.message);
  mgr.clearHub();
  assert.match(await pend, /removed/);
  assert.equal(mgr.stats.built, false);
  assert.equal(mgr.stats.reservation.agentCount, 0);

  mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
  assert.equal(mgr.stats.built, true);

  let scErr = null;
  await mgr.runScenario("nonexistent").catch((e) => { scErr = e.message; });
  assert.match(scErr || "", /Unknown scenario/);

  const scP = mgr.runScenario("full-intermodal-loop");
  for (let i = 0; i < 20; i++) mgr.tick(1 / 60);
  mgr.stopScenarios();
  const scRes = await scP;
  assert.equal(scRes.stopped, true);

  mgr.dispose();
  mgr.dispose();
  assert.equal(mgr.stats.disposed, true);
  assert.equal(mgr.buildHub(), null);
  assert.equal(mgr.spawnAgf("x"), null);
  assert.equal(mgr.spawnAmr("y"), null);
});

test("A", "T5-A06 (LiftTable interlocks & Jack bridges): autoMode blocked while jack on deck, raises on clear, raised LiftTable rejects jack pick/drop", async () => {
  const rig = makeRig();
  const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: new Map(), deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
  mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
  try {
    const l1 = mgr.liftTables.get("L1");
    l1.setAutoMode(true);
    const jPose = { id: "pj", x: l1.x, y: l1.y - 0.25, heading: 0, carriedWcid: 4000014, carriedPalletSize: 2, loaded: true };
    mgr.updatePlayerJackPose(jPose);
    assert.equal(mgr.tryJackDrop(jPose, null), true);
    for (let i = 0; i < 60; i++) mgr.tick(1 / 60);
    assert.equal(l1.heightM, 0.0, "L1 must remain lowered while player jack is on deck");
    assert.equal(mgr.getState().liftTables.L1.interlockBlocked, true);

    mgr.updatePlayerJackPose(null);
    for (let i = 0; i < 200; i++) mgr.tick(1 / 60);
    assert.ok(l1.heightM >= WS.LIFT_TABLE_SPECS.raisedZ - 0.005, "L1 must auto-raise once jack clears deck");

    const jEmpty = { x: l1.x, y: l1.y - 0.25, heading: 0, carriedWcid: 0 };
    assert.equal(mgr.tryJackPick(jEmpty, null), false, "raised LiftTable must reject jack pick");
  } finally {
    mgr.dispose();
  }
});

test("A", "T5-A07 (audio): safetyChime 0.25 s cooldown, maxOneShots=14 polyphony cap & stop() node cleanup", () => {
  let tSec = 1.0;
  const makeNode = () => ({
    gain: { value: 1, setValueAtTime() {}, setTargetAtTime() {}, exponentialRampToValueAtTime() {} },
    frequency: { value: 440, setValueAtTime() {}, setTargetAtTime() {} },
    Q: { value: 1 },
    positionX: { value: 0 }, positionY: { value: 0 }, positionZ: { value: 0 },
    connect() {}, disconnect() {}, start() {}, stop() {},
    getChannelData: () => new Float32Array(128),
  });
  const ctx = {
    state: "running",
    currentTime: 1.0,
    destination: {},
    createGain: makeNode, createOscillator: makeNode, createBiquadFilter: makeNode,
    createBuffer: makeNode, createBufferSource: makeNode, createPanner: makeNode,
  };
  const au = createLogisticsAudio({ bus: { ctx, node: ctx.destination }, clock: () => tSec, search: "?vehicles=on&vehicleAudio=on" });
  assert.equal(au.safetyChime({ pos: [0, 0, 0] }), true);
  assert.equal(au.safetyChime({ pos: [0, 0, 0] }), false, "chime within 0.25s cooldown suppressed");
  for (let i = 0; i < 20; i++) {
    tSec += 0.30;
    au.safetyChime({ pos: [0, 0, 0] });
  }
  assert.equal(au.stats.activeOneShots, 14, "polyphony capped at maxOneShots=14");
  au.stop();
  assert.equal(au.stats.totalNodes, 0);
  au.dispose();
});

test("A", "T5-A08 (warehouse-hub-stage.js contract & Test 48 clean start check)", () => {
  const stageSrc = readFileSync(join(APP_ROOT, "harness/warehouse-hub-stage.js"), "utf8");
  assert.match(stageSrc, /@tele 93\.60N 84\.80E/);
  assert.match(stageSrc, /setSkyTimeOverride\(0\.5\)/);
  assert.match(stageSrc, /terrainHeightAt/);
  assert.match(stageSrc, /\[id\^=hb-\]/);
  assert.match(stageSrc, /window\.__cam\.orbit/);
  assert.match(stageSrc, /window\.__vehicles\.warehouse/);
  assert.equal(/\b_entityMap\b|\brawSet\b/.test(stageSrc), false, "stage script must use public APIs");
  for (let s = 1; s <= 6; s++) {
    assert.match(stageSrc, new RegExp(`runShot${s}\\b`), `shot ${s} present`);
  }

  const rig = makeRig();
  const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: makeDefaultContainers(), deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
  mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
  const obbs = getObbs(mgr, new Map());
  const hitClean = obbs.some((b) => satObbHit(ox - 10.0, oy + 2.0, 0, 0.39, 0.52, b));
  assert.equal(hitClean, false, "clean AMR start [ox-10, oy+2.0] has 0 t=0 SAT OBB hits");
  mgr.dispose();
});

// ===========================================================================
// PART B — Tier 5 Hardening Checks (Tight-Clearance, Headroom, Races)
// ===========================================================================

test("B", "T5-B01 (localSlotFallback): THREE:null uses ${side}:${bay}:${tier}:${slotInBay} key parity", async () => {
  const rig = makeRig();
  const mgr = createWarehouseManager({ THREE: null, liveScene3d: null, containers: makeDefaultContainers(), deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
  mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
  try {
    const r1 = mgr.racks.get("R1");
    r1.loadSlot(1, 2, 0, 0, 4000012);
    assert.equal(r1.loadedSlots.has("0:1:2:0"), true, `expected key 0:1:2:0, got ${[...r1.loadedSlots.keys()]}`);
    const agf = mgr.spawnAgf("agf-fb", { pos: [ox - 10, oy + 3, 0], heading: 0 });
    await stepUntilSettled(() => mgr.tick(1 / 60), agf.enqueue({ type: "pickFromRack", rackId: "R1", bay: 1, tier: 2, side: 0, slotInBay: 0 }), 4000);
    assert.equal(agf.carriedWcid, 4000012);
  } finally {
    mgr.dispose();
  }
});

test("B", "T5-B02 (tight-clearance AGF): 5 tight-clearance AGF cases (tight_092_112/16/28, corner_S1/S4) settle empty & loaded at 1/60 & 1/30 with 0 hits", async () => {
  const cases = [
    ["tight_092_112", [ox - 10.597, oy + 1.808, 0], 1.600, [ox - 5.943, oy - 36.929]],
    ["tight_092_16",  [ox - 15.275, oy + 6.580, 0], -1.970, [ox + 11.383, oy - 38.029]],
    ["tight_092_28",  [ox - 25.883, oy + 27.957, 0], -0.054, [ox - 12.214, oy - 25.092]],
    ["corner_S1",     [ox + 12.872, oy + 3.301, 0], 3.083, [ox + 10.860, oy + 1.130]],
    ["corner_S4",     [ox + 15.128, oy - 3.301, 0], -0.058, [ox + 17.140, oy - 1.130]],
  ];
  const errs = [];
  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 8000 : 4000;
    for (const carriedWcid of [0, 4000012]) {
      for (const [label, sPos, sH, tPos] of cases) {
        const cMap = makeDefaultContainers();
        const rig = makeRig();
        const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
        mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
        const obbs = getObbs(mgr, cMap);
        try {
          const agf = mgr.spawnAgf(`agf-${label}`, { pos: sPos, heading: sH, carriedWcid });
          let hits = 0;
          await stepUntilSettled(() => {
            mgr.tick(dt);
            const h = checkAgfHits(agf, obbs);
            hits += h.cornerHits + h.satHits;
          }, agf.enqueue({ type: "driveTo", waypoints: [tPos] }), maxSteps);
          assert.equal(hits, 0, `${label} dt=${dt} wcid=${carriedWcid} hits=${hits}`);
          assert.ok(Math.hypot(agf.x - tPos[0], agf.y - tPos[1]) <= 0.15, `${label} pose err`);
        } catch (e) {
          errs.push(`${label}(dt=${dt.toFixed(4)},w=${carriedWcid}): ${e?.message || e}`);
        } finally {
          mgr.dispose();
        }
      }
    }
  }
  assert.equal(errs.length, 0, `${errs.length} failed: ${errs.join(" | ")}`);
});

test("B", "T5-B03 (initMs headroom): tight_136 & tight_092_112 initMs < 1200 ms", async () => {
  for (const [label, sPos, sH, tPos] of [
    ["tight_136", [ox + 3.362, oy - 22.650, 0], -2.171, [ox - 23.340, oy + 39.520]],
    ["tight_092_112", [ox - 10.597, oy + 1.808, 0], 1.600, [ox - 5.943, oy - 36.929]],
  ]) {
    const rig = makeRig();
    const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: makeDefaultContainers(), deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
    mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
    try {
      const agf = mgr.spawnAgf(label, { pos: sPos, heading: sH });
      const p = agf.enqueue({ type: "driveTo", waypoints: [tPos] });
      const t0 = performance.now();
      mgr.tick(1 / 60);
      const initMs = performance.now() - t0;
      await stepUntilSettled(() => mgr.tick(1 / 60), p, 8000);
      assert.ok(initMs < 1200, `${label} initMs=${initMs.toFixed(1)} ms >= 1200 ms`);
    } finally {
      mgr.dispose();
    }
  }
});

test("B", "T5-B04 (AMR <0.56 m docking & unheaded multi-wp): L1 0.48 m parallel, L1 0.53 m perp, & R1_S 0.44 m unheaded docking=true settle with 0 hits", async () => {
  const cMap = makeDefaultContainers();
  const rig = makeRig();
  const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
  mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
  const obbs = getObbs(mgr, cMap);
  const errs = [];
  try {
    try {
      const amrA = mgr.spawnAmr("amr-dock-l1", { pos: [ox - 46.0, oy - 16.5, 0], heading: 0 });
      let hitsA = 0;
      await stepUntilSettled(() => {
        mgr.tick(1 / 60);
        for (const b of obbs) if (satObbHit(amrA.x, amrA.y, amrA.heading, 0.39, 0.52, b)) hitsA++;
      }, amrA.enqueue({ type: "driveTo", waypoints: [{ x: ox - 46.0, y: oy - 15.13, heading: Math.PI * 0.5, docking: true }] }), 1500);
      assert.equal(hitsA, 0);
      assert.ok(Math.hypot(amrA.x - (ox - 46.0), amrA.y - (oy - 15.13)) <= 0.15);
    } catch (e) {
      errs.push(`L1_0.48_docking: ${e?.message || e}`);
    }
    try {
      const amrA2 = mgr.spawnAmr("amr-dock-l1", { pos: [ox - 46.0, oy - 16.5, 0], heading: 0 });
      let hitsA2 = 0;
      await stepUntilSettled(() => {
        mgr.tick(1 / 60);
        for (const b of obbs) if (satObbHit(amrA2.x, amrA2.y, amrA2.heading, 0.39, 0.52, b)) hitsA2++;
      }, amrA2.enqueue({ type: "driveTo", waypoints: [{ x: ox - 46.0, y: oy - 15.18, heading: 0, docking: true }] }), 1500);
      assert.equal(hitsA2, 0);
      assert.ok(Math.hypot(amrA2.x - (ox - 46.0), amrA2.y - (oy - 15.18)) <= 0.15);
    } catch (e) {
      errs.push(`L1_0.53_docking: ${e?.message || e}`);
    }
    try {
      const amrB = mgr.spawnAmr("amr-multi-dock", { pos: [ox - 10.0, oy + 2.5, 0], heading: Math.PI * 0.5 });
      let hitsB = 0;
      await stepUntilSettled(() => {
        mgr.tick(1 / 60);
        for (const b of obbs) if (satObbHit(amrB.x, amrB.y, amrB.heading, 0.39, 0.52, b)) hitsB++;
      }, amrB.enqueue({ type: "driveTo", waypoints: [{ x: ox - 10.0, y: oy + 3.5 }, { x: ox - 10.0, y: oy + 4.36, docking: true }] }), 1500);
      assert.equal(hitsB, 0);
      assert.ok(Math.hypot(amrB.x - (ox - 10.0), amrB.y - (oy + 4.36)) <= 0.15);
    } catch (e) {
      errs.push(`R1_S_0.44_unheaded_docking: ${e?.message || e}`);
    }
    assert.equal(errs.length, 0, `${errs.length}/3 failed: ${errs.join(" | ")}`);
  } finally {
    mgr.dispose();
  }
});

test("B", "T5-B05 (serverDispatch race): mid-route door closure rejects without premature vehicleContainerAction dispatch", async () => {
  const actions = [];
  const rig = makeRig({
    vehicleContainerAction: (guid, act, slot, sub, wcid) => actions.push({ guid, act, slot, sub, wcid }),
  });
  const cMap = makeDefaultContainers();
  const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
  mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
  try {
    const agf = mgr.spawnAgf("agf-srv-race", { pos: [ox - 40, oy + 20, 0], heading: 0 });
    const p = agf.enqueue({ type: "pickFromContainer", containerGuid: 38145, slotIndex: 19, serverDispatch: true });
    mgr.tick(1 / 60);
    cMap.get(38145).currentDoorProgress = 0.0;
    let err = null;
    await stepUntilSettled(() => mgr.tick(1 / 60), p.catch((e) => { err = e.message; }), 2000);
    assert.match(err || "", /unavailable/);
    assert.equal(actions.length, 0, `expected 0 vehicleContainerAction calls on aborted pick, got ${actions.length}`);
  } finally {
    mgr.dispose();
  }
});

test("B", "T5-B06 (challenger_2 12 AGF pairs + S10_N_E->S10_S_E): empty & 4000012 loaded across dt=1/60 & 1/30 with 0 hits", async () => {
  const cases = [
    ["R1_N_E->S10_S_E", [-5.000, +6.480], 1.571, [-7.500, -25.150], [0, 4000012]],
    ["fuzz_20261123_22", [+23.030, +0.613], -1.131, [-16.446, -1.916], [0, 4000012]],
    ["SEED_tight_0.58_0.92_56", [+2.863, -23.433], -0.243, [+12.042, -24.656], [0, 4000012]],
    ["SEED_tight_0.58_0.92_81", [-7.184, -22.787], -1.472, [+7.263, +5.760], [4000012]],
    ["SEED_tight_0.58_0.92_99", [-11.304, -25.218], -1.483, [+15.217, -3.120], [4000012]],
    ["SEED_tight_0.58_0.92_148", [+6.219, -23.411], -2.668, [+13.703, -6.391], [0, 4000012]],
    ["SEED_tight_0.58_0.92_156", [+3.052, -3.908], -1.508, [+2.437, -39.343], [0, 4000012]],
    ["SEED_tight_0.58_1.20_119", [+6.472, -39.106], 1.198, [+12.960, +5.491], [0, 4000012]],
    ["SEED_tight_0.58_1.20_110", [-9.809, +31.493], 0.188, [-4.895, -22.567], [0, 4000012]],
    ["sharp_36", [+4.801, -38.850], 2.581, [+12.705, +2.947], [0, 4000012]],
    ["sharp_37", [+2.642, -22.913], -1.691, [+3.213, -38.897], [0, 4000012]],
    ["sharp_95", [-16.513, +4.135], -0.250, [+15.311, -2.878], [0, 4000012]],
    ["S10_N_E->S10_S_E", [-7.500, -22.850], Math.PI * 0.5, [-7.500, -25.150], [0, 4000012]],
  ];
  const errs = [];
  for (const [label, sOff, h, tOff, wcids] of cases) {
    for (const wcid of wcids) {
      for (const dt of [1 / 60, 1 / 30]) {
        const cMap = makeDefaultContainers();
        const rig = makeRig();
        const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
        mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
        const obbs = getObbs(mgr, cMap);
        const agf = mgr.spawnAgf(`t5b06-${label}`, { pos: [ox + sOff[0], oy + sOff[1], 0], heading: h, carriedWcid: wcid });
        let cornerHits = 0;
        let satHits = 0;
        try {
          const maxSteps = dt < 0.025 ? 10000 : 5000;
          await stepUntilSettled(() => {
            mgr.tick(dt);
            const r = checkAgfHits(agf, obbs);
            cornerHits += r.cornerHits;
            satHits += r.satHits;
          }, agf.enqueue({ type: "driveTo", waypoints: [[ox + tOff[0], oy + tOff[1]]] }), maxSteps);
          assert.equal(cornerHits, 0, `${label} w=${wcid} dt=${dt}: cornerHits=${cornerHits}`);
          assert.equal(satHits, 0, `${label} w=${wcid} dt=${dt}: satHits=${satHits}`);
          const dEnd = Math.hypot(agf.x - (ox + tOff[0]), agf.y - (oy + tOff[1]));
          assert.ok(dEnd <= 0.15, `${label} w=${wcid} dt=${dt}: dEnd=${dEnd.toFixed(3)}`);
        } catch (e) {
          errs.push(`${label} w=${wcid} dt=${dt.toFixed(4)}: ${e?.message || e}`);
        } finally {
          mgr.dispose();
        }
      }
    }
  }
  assert.equal(errs.length, 0, `${errs.length} AGF case(s) failed: ${errs.join(" | ")}`);
});

test("B", "T5-B07 (challenger_2 3 AMR docking=true bugs): 0.40 m C1..C3 + rotated 45 deg, R1_S_0.44_par_start_skew, & L1_E/L2_E 0.56 m unheaded multi-wp across dt=1/60 & 1/30 with 0 hits", async () => {
  const AMR_CORNERS = [[-0.39, -0.52], [0.39, -0.52], [-0.39, 0.52], [0.39, 0.52]];
  const checkAmrHits = (amr, obbs) => {
    let hits = 0;
    for (const [lx, ly] of AMR_CORNERS) {
      const [wx, wy] = WS.localToWorld2D(lx, ly, amr.x, amr.y, amr.heading);
      for (const b of obbs) {
        const dx = wx - b.cx;
        const dy = wy - b.cy;
        const c = Math.cos(b.h);
        const s = Math.sin(b.h);
        if (Math.abs(dx * c - dy * s) < b.hw - 1e-4 && Math.abs(dx * s + dy * c) < b.hl - 1e-4) hits++;
      }
    }
    for (const b of obbs) if (satObbHit(amr.x, amr.y, amr.heading, 0.39, 0.52, b)) hits++;
    return hits;
  };
  const amrCases = [
    ["C1_W_0.40_headed", [ox - 44.5, oy + 32.5, 0], Math.PI * 0.5, [{ x: ox - 41.619, y: oy + 32.5, heading: 0, docking: true }], []],
    ["C1_W_0.40_unheaded", [ox - 44.5, oy + 32.5, 0], Math.PI * 0.5, [{ x: ox - 41.619, y: oy + 32.5, docking: true }], []],
    ["C2_E_0.42_headed", [ox - 19.0, oy + 32.5, 0], -Math.PI * 0.5, [{ x: ox - 22.361, y: oy + 32.5, heading: Math.PI, docking: true }], []],
    ["C3_W_0.43_unheaded", [ox - 13.0, oy + 29.43, 0], Math.PI * 0.5, [{ x: ox - 9.649, y: oy + 29.43, docking: true }], []],
    ["rotCtr45_0.40_headed", [ox + 26.0, oy + 26.0, 0], 0, [{ x: ox + 30 + Math.cos(Math.PI / 4) * (-1.619), y: oy + 30 + Math.sin(Math.PI / 4) * 1.619, heading: Math.PI / 4, docking: true }], [{ guid: 99010, kind: 10, pos: [ox + 30, oy + 30, 0], heading: Math.PI / 4 }]],
    ["rotCtr45_0.40_unheaded", [ox + 26.0, oy + 26.0, 0], 0, [{ x: ox + 30 + Math.cos(Math.PI / 4) * (-1.619), y: oy + 30 + Math.sin(Math.PI / 4) * 1.619, docking: true }], [{ guid: 99010, kind: 10, pos: [ox + 30, oy + 30, 0], heading: Math.PI / 4 }]],
    ["R1_S_0.44_par_start_skew", [ox - 12.0, oy + 4.36, 0], 0.1, [{ x: ox - 10.0, y: oy + 4.36, heading: Math.PI * 0.5, docking: true }], []],
    ["L1_E_0.56_unheaded_dock", [ox - 42.5, oy - 15.5, 0], 0, [{ x: ox - 44.0, y: oy - 14.0 }, { x: ox - 44.77, y: oy - 14.0, docking: true }], []],
    ["L2_E_0.56_unheaded_dock", [ox - 34.5, oy - 15.5, 0], 0, [{ x: ox - 36.0, y: oy - 14.0 }, { x: ox - 36.77, y: oy - 14.0, docking: true }], []],
  ];
  const errs = [];
  for (const dt of [1 / 60, 1 / 30]) {
    for (const [label, sPos, sH, wps, extra] of amrCases) {
      const cMap = makeDefaultContainers(extra);
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      const amr = mgr.spawnAmr(`t5b07-${label}`, { pos: sPos, heading: sH });
      let hits = 0;
      const last = wps[wps.length - 1];
      try {
        await stepUntilSettled(() => {
          mgr.tick(dt);
          hits += checkAmrHits(amr, obbs);
        }, amr.enqueue({ type: "driveTo", waypoints: wps }), dt < 0.025 ? 2400 : 1200);
        assert.equal(hits, 0, `${label} dt=${dt}: hits=${hits}`);
        const dEnd = Math.hypot(amr.x - last.x, amr.y - last.y);
        assert.ok(dEnd <= 0.15, `${label} dt=${dt}: dEnd=${dEnd.toFixed(3)}`);
      } catch (e) {
        errs.push(`${label} dt=${dt.toFixed(4)}: ${e?.message || e}`);
      } finally {
        mgr.dispose();
      }
    }
  }
  assert.equal(errs.length, 0, `${errs.length} AMR case(s) failed: ${errs.join(" | ")}`);
});

test("B", "T5-B08 (challenger_3 9 AGF cases): empty 0 & 4000012 loaded across dt=1/60 & 1/30 with 0 hits", async () => {
  const cases = [
    ["worker2_sharp_78", [-36.440, -15.460], 3.000, [15.320, -39.360]],
    ["worker2_sharp_156", [7.140, -7.910], -0.140, [-15.630, -36.880]],
    ["SEED_tight_0.58_0.92_112", [-7.178, -1.893], 1.390, [-12.728, -38.114]],
    ["SEED_tight_0.58_0.92_18", [-16.540, -22.774], -1.999, [7.255, 0.374]],
    ["SEED_tight_0.58_1.20_143", [-16.579, -22.277], 1.988, [15.322, 1.873]],
    ["SHARP_CORNER_124", [-36.579, -13.830], -0.007, [9.242, -24.032]],
    ["fuzz_20261124_2", [15.649, -1.725], -0.004, [-13.545, -20.975]],
    ["fuzz_20261124_2_pert", [15.649, -1.725], -0.0035, [-13.545, -20.975]],
    ["fuzz_20261128_90", [-22.690, 22.267], -2.525, [4.781, -25.150]],
    ["S10_N_E->S10_S_S", [-7.500, -22.850], Math.PI * 0.5, [-7.500, -25.350]],
    ["S10_N_W->S10_S_S", [-7.500, -22.850], -Math.PI * 0.5, [-7.500, -25.350]],
  ];
  const errs = [];
  for (const [label, sOff, h, tOff] of cases) {
    for (const wcid of [0, 4000012]) {
      for (const dt of [1 / 60, 1 / 30]) {
        const cMap = makeDefaultContainers();
        const rig = makeRig();
        const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
        mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
        const obbs = getObbs(mgr, cMap);
        const agf = mgr.spawnAgf(`t5b08-${label}`, { pos: [ox + sOff[0], oy + sOff[1], 0], heading: h, carriedWcid: wcid });
        let cornerHits = 0;
        let satHits = 0;
        try {
          const maxSteps = dt < 0.025 ? 8000 : 4000;
          await stepUntilSettled(() => {
            mgr.tick(dt);
            const r = checkAgfHits(agf, obbs);
            cornerHits += r.cornerHits;
            satHits += r.satHits;
          }, agf.enqueue({ type: "driveTo", waypoints: [[ox + tOff[0], oy + tOff[1]]] }), maxSteps);
          assert.equal(cornerHits, 0, `${label} w=${wcid} dt=${dt}: cornerHits=${cornerHits}`);
          assert.equal(satHits, 0, `${label} w=${wcid} dt=${dt}: satHits=${satHits}`);
          const dEnd = Math.hypot(agf.x - (ox + tOff[0]), agf.y - (oy + tOff[1]));
          assert.ok(dEnd <= 0.15, `${label} w=${wcid} dt=${dt}: dEnd=${dEnd.toFixed(3)}`);
        } catch (e) {
          errs.push(`${label} w=${wcid} dt=${dt.toFixed(4)}: ${e?.message || e}`);
        } finally {
          mgr.dispose();
        }
      }
    }
  }
  assert.equal(errs.length, 0, `${errs.length} AGF case(s) failed: ${errs.join(" | ")}`);
});

test("B", "T5-B09 (challenger_3 WB_* AMR docking=true yaw-skew 0.05..0.25 rad): rack, container & charger across dt=1/60 & 1/30 with 0 hits", async () => {
  const AMR_CORNERS = [[-0.39, -0.52], [0.39, -0.52], [-0.39, 0.52], [0.39, 0.52]];
  const checkAmrHits = (amr, obbs) => {
    let hits = 0;
    for (const [lx, ly] of AMR_CORNERS) {
      const [wx, wy] = WS.localToWorld2D(lx, ly, amr.x, amr.y, amr.heading);
      for (const b of obbs) {
        const dx = wx - b.cx;
        const dy = wy - b.cy;
        const c = Math.cos(b.h);
        const s = Math.sin(b.h);
        if (Math.abs(dx * c - dy * s) < b.hw - 1e-4 && Math.abs(dx * s + dy * c) < b.hl - 1e-4) hits++;
      }
    }
    for (const b of obbs) if (satObbHit(amr.x, amr.y, amr.heading, 0.39, 0.52, b)) hits++;
    return hits;
  };
  const amrCases = [
    ["WB_R1_S_0.50_sk0.15", [ox - 2.0 * Math.sin(Math.PI / 2 - 0.15), oy + 4.30 - 2.0 * Math.cos(Math.PI / 2 - 0.15), 0], Math.PI / 2 - 0.15, [{ x: ox, y: oy + 4.30, heading: Math.PI / 2, docking: true }], true],
    ["WB_R1_S_0.48_sk0.12", [ox - 2.0 * Math.sin(Math.PI / 2 - 0.12), oy + 4.32 - 2.0 * Math.cos(Math.PI / 2 - 0.12), 0], Math.PI / 2 - 0.12, [{ x: ox, y: oy + 4.32, heading: Math.PI / 2, docking: true }], true],
    ["WB_R6_S_0.52_sk0.18", [ox - 2.0 * Math.sin(Math.PI / 2 - 0.18), oy - 13.72 - 2.0 * Math.cos(Math.PI / 2 - 0.18), 0], Math.PI / 2 - 0.18, [{ x: ox, y: oy - 13.72, heading: Math.PI / 2, docking: true }], true],
    ["WB_C1_W_0.54_sk+0.20", [ox - 41.759 - 2.0 * Math.sin(0.20), oy + 32.5 - 2.0 * Math.cos(0.20), 0], 0.20, [{ x: ox - 41.759, y: oy + 32.5, heading: 0, docking: true }], true],
    ["WB_C1_W_0.54_sk-0.20_overlapPushout", [ox - 41.759 - 2.0 * Math.sin(-0.20), oy + 32.5 - 2.0 * Math.cos(-0.20), 0], -0.20, [{ x: ox - 41.759, y: oy + 32.5, heading: 0, docking: true }], false],
    ["WB_CH1_N_0.50_sk0.15", [ox - 16.5 - 2.0 * Math.sin(Math.PI / 2 - 0.15), oy - 36.875 - 2.0 * Math.cos(Math.PI / 2 - 0.15), 0], Math.PI / 2 - 0.15, [{ x: ox - 16.5, y: oy - 36.875, heading: Math.PI / 2, docking: true }], true],
  ];
  const errs = [];
  for (const dt of [1 / 60, 1 / 30]) {
    for (const [label, sPos, sH, wps, requireClearStart] of amrCases) {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      const amr = mgr.spawnAmr(`t5b09-${label}`, { pos: sPos, heading: sH });
      let hits = 0;
      const last = wps[wps.length - 1];
      try {
        const t0Hits = checkAmrHits(amr, obbs);
        if (requireClearStart) {
          assert.equal(t0Hits, 0, `${label} dt=${dt}: expected t0Hits=0, got ${t0Hits}`);
        }
        await stepUntilSettled(() => {
          mgr.tick(dt);
          hits += checkAmrHits(amr, obbs);
        }, amr.enqueue({ type: "driveTo", waypoints: wps }), dt < 0.025 ? 4000 : 2000);
        assert.equal(hits, 0, `${label} dt=${dt}: hits=${hits}`);
        const dEnd = Math.hypot(amr.x - last.x, amr.y - last.y);
        assert.ok(dEnd <= 0.15, `${label} dt=${dt}: dEnd=${dEnd.toFixed(3)}`);
      } catch (e) {
        errs.push(`${label} dt=${dt.toFixed(4)}: ${e?.message || e}`);
      } finally {
        mgr.dispose();
      }
    }
  }
  assert.equal(errs.length, 0, `${errs.length} WB AMR case(s) failed: ${errs.join(" | ")}`);
});

test("B", "T5-B10 (challenger_4 Bug 1 stand/liftTable post-retract clearance): S1..S18 & L1..L2 placeOnStand + pickFromStand resolve with >= 0.04m fork-tip clearance & 0-hit chained driveTo/placeOnStand/dropToGround", async () => {
  const standIds = [...Array.from({ length: 18 }, (_, i) => `S${i + 1}`), "L1", "L2"];
  const errs = [];
  for (const sid of standIds) {
    const cMap = makeDefaultContainers();
    const rig = makeRig();
    const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
    mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
    const obbs = getObbs(mgr, cMap);
    const tgt = mgr.stands.get(sid) || mgr.liftTables.get(sid);
    const app = tgt.agfApproachPos;
    const ah = Math.atan2(tgt.pos[0] - app[0], tgt.pos[1] - app[1]);
    const [fx, fy] = WS.headingForward(ah);
    const tgtObb = obbs.find((b) => b.id === sid);
    const checkForkTipClear = (agf) => {
      const [tipX, tipY] = WS.localToWorld2D(0, WS.AGF_SPECS.forkTipY, agf.x, agf.y, agf.heading);
      const dx = tipX - tgtObb.cx;
      const dy = tipY - tgtObb.cy;
      const c = Math.cos(tgtObb.h);
      const s = Math.sin(tgtObb.h);
      const lx = Math.abs(dx * c - dy * s);
      const ly = Math.abs(dx * s + dy * c);
      return Math.hypot(Math.max(0, lx - tgtObb.hw), Math.max(0, ly - tgtObb.hl));
    };
    const agf = mgr.spawnAgf(`t5b10-${sid}`, { pos: [app[0] - fx * 1.2, app[1] - fy * 1.2, 0], heading: ah, carriedWcid: 4000012 });
    try {
      await stepUntilSettled(() => mgr.tick(1 / 60), agf.enqueue({ type: "placeOnStand", standId: sid }), 4000);
      const placeHits = checkAgfHits(agf, obbs);
      assert.equal(placeHits.cornerHits + placeHits.satHits, 0, `${sid} post-place hits=${JSON.stringify(placeHits)}`);
      const placeTipClear = checkForkTipClear(agf);
      assert.ok(placeTipClear >= 0.04, `${sid} post-place fork-tip clearance=${placeTipClear.toFixed(4)} < 0.04`);

      await stepUntilSettled(() => mgr.tick(1 / 60), agf.enqueue({ type: "pickFromStand", standId: sid }), 4000);
      const pickHits = checkAgfHits(agf, obbs);
      assert.equal(pickHits.cornerHits + pickHits.satHits, 0, `${sid} post-pick hits=${JSON.stringify(pickHits)}`);
      const pickTipClear = checkForkTipClear(agf);
      assert.ok(pickTipClear >= 0.04, `${sid} post-pick fork-tip clearance=${pickTipClear.toFixed(4)} < 0.04`);

      let chainHits = 0;
      await stepUntilSettled(() => {
        mgr.tick(1 / 60);
        const r = checkAgfHits(agf, obbs);
        chainHits += r.cornerHits + r.satHits;
      }, agf.enqueue({ type: "driveTo", waypoints: [[app[0] - fx * 3.0, app[1] - fy * 3.0]] }), 4000);
      assert.equal(chainHits, 0, `${sid} chained driveTo hits=${chainHits}`);

      await stepUntilSettled(() => mgr.tick(1 / 60), agf.enqueue({ type: "placeOnStand", standId: sid }), 4000);
      await stepUntilSettled(() => mgr.tick(1 / 60), agf.enqueue({ type: "pickFromStand", standId: sid }), 4000);
      const pick2Hits = checkAgfHits(agf, obbs);
      assert.equal(pick2Hits.cornerHits + pick2Hits.satHits, 0, `${sid} post-pick2 hits=${JSON.stringify(pick2Hits)}`);
      assert.ok(checkForkTipClear(agf) >= 0.04, `${sid} post-pick2 fork-tip clearance < 0.04`);

      let dropHits = 0;
      await stepUntilSettled(() => {
        mgr.tick(1 / 60);
        const r = checkAgfHits(agf, obbs);
        dropHits += r.cornerHits + r.satHits;
      }, agf.enqueue({ type: "dropToGround", pos: [app[0] - fx * 3.5, app[1] - fy * 3.5, 0] }), 4000);
      assert.equal(dropHits, 0, `${sid} chained dropToGround hits=${dropHits}`);

      if (sid === "S1" || sid === "S18" || sid === "L1") {
        const nextSid = sid === "S1" ? "S2" : "L2";
        const nonTargetObbs = obbs.filter((b) => b.id !== nextSid);
        tgt.setCargoWcid(4000012);
        await stepUntilSettled(() => mgr.tick(1 / 60), agf.enqueue({ type: "pickFromStand", standId: sid }), 4000);
        assert.equal(checkAgfHits(agf, obbs).cornerHits + checkAgfHits(agf, obbs).satHits, 0, `${sid} pre-chain pick hits`);
        let transHits = 0;
        await stepUntilSettled(() => {
          mgr.tick(1 / 60);
          const r = checkAgfHits(agf, nonTargetObbs);
          transHits += r.cornerHits + r.satHits;
        }, agf.enqueue({ type: "placeOnStand", standId: nextSid }), 8000);
        assert.equal(transHits, 0, `${sid}->${nextSid} chained placeOnStand nonTarget hits=${transHits}`);
        assert.equal(checkAgfHits(agf, obbs).cornerHits + checkAgfHits(agf, obbs).satHits, 0, `${sid}->${nextSid} post-place hits`);
      }
    } catch (e) {
      errs.push(`${sid}: ${e?.message || e}`);
    } finally {
      mgr.dispose();
    }
  }
  assert.equal(errs.length, 0, `${errs.length}/20 stand/liftTable failed: ${errs.join(" | ")}`);
});

test("B", "T5-B11 (challenger_4 Bug 2 4 AGF unreachable pairs): S10_S_E->S1_E, seed_092 s101_22 & s101_51, seed_120 s202_69 at 0 & 4000012 across dt=1/60 & 1/30 with 0 hits & 0 drift", async () => {
  const cases = [
    ["r1_r6_s10_S10_S_E->S1_E", [-7.500, -25.150], 1.571, [15.190, 4.200]],
    ["seed_092_s101_22", [-16.607, -11.154], 2.933, [-4.712, -37.863]],
    ["seed_092_s101_51", [-40.072, 25.647], 1.682, [15.203, -9.891]],
    ["seed_120_s202_69", [7.524, 5.078], -2.847, [9.793, -36.837]],
  ];
  const errs = [];
  for (const [label, sOff, h, tOff] of cases) {
    for (const wcid of [0, 4000012]) {
      for (const dt of [1 / 60, 1 / 30]) {
        const cMap = makeDefaultContainers();
        const rig = makeRig();
        const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
        mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
        const obbs = getObbs(mgr, cMap);
        const agf = mgr.spawnAgf(`t5b11-${label}`, { pos: [ox + sOff[0], oy + sOff[1], 0], heading: h, carriedWcid: wcid });
        let cornerHits = 0;
        let satHits = 0;
        try {
          const t0 = checkAgfHits(agf, obbs);
          assert.equal(t0.cornerHits + t0.satHits, 0, `${label} t=0 hits`);
          const maxSteps = dt < 0.025 ? 8000 : 4000;
          await stepUntilSettled(() => {
            mgr.tick(dt);
            const r = checkAgfHits(agf, obbs);
            cornerHits += r.cornerHits;
            satHits += r.satHits;
          }, agf.enqueue({ type: "driveTo", waypoints: [[ox + tOff[0], oy + tOff[1]]] }), maxSteps);
          assert.equal(cornerHits, 0, `${label} w=${wcid} dt=${dt}: cornerHits=${cornerHits}`);
          assert.equal(satHits, 0, `${label} w=${wcid} dt=${dt}: satHits=${satHits}`);
          const dEnd = Math.hypot(agf.x - (ox + tOff[0]), agf.y - (oy + tOff[1]));
          assert.ok(dEnd <= 0.15, `${label} w=${wcid} dt=${dt}: dEnd=${dEnd.toFixed(3)}`);
          const endX = agf.x;
          const endY = agf.y;
          for (let i = 0; i < 60; i++) mgr.tick(dt);
          assert.ok(Math.hypot(agf.x - endX, agf.y - endY) <= 1e-4, `${label} w=${wcid} dt=${dt}: idle drift`);
        } catch (e) {
          errs.push(`${label} w=${wcid} dt=${dt.toFixed(4)}: ${e?.message || e}`);
        } finally {
          mgr.dispose();
        }
      }
    }
  }
  assert.equal(errs.length, 0, `${errs.length}/16 AGF case(s) failed: ${errs.join(" | ")}`);
});

test("B", "T5-B12 (challenger_4 Bug 3 AMR docking=true Zone C stand-gap stall): 3 amrFuzz_* cases settle < 8000 ticks across dt=1/60 & 1/30 with 0 hits", async () => {
  const AMR_CORNERS = [[-0.39, -0.52], [0.39, -0.52], [-0.39, 0.52], [0.39, 0.52]];
  const checkAmrHits = (amr, obbs) => {
    let hits = 0;
    for (const [lx, ly] of AMR_CORNERS) {
      const [wx, wy] = WS.localToWorld2D(lx, ly, amr.x, amr.y, amr.heading);
      for (const b of obbs) {
        const dx = wx - b.cx;
        const dy = wy - b.cy;
        const c = Math.cos(b.h);
        const s = Math.sin(b.h);
        if (Math.abs(dx * c - dy * s) < b.hw - 1e-4 && Math.abs(dx * s + dy * c) < b.hl - 1e-4) hits++;
      }
    }
    for (const b of obbs) if (satObbHit(amr.x, amr.y, amr.heading, 0.39, 0.52, b)) hits++;
    return hits;
  };
  const amrCases = [
    ["amrFuzz_20261121_16", [ox + 20.517, oy - 3.878, 0], 2.124, [{ x: ox - 9.930, y: oy + 32.288, docking: true }]],
    ["amrFuzz_20261201_46", [ox - 16.676, oy + 38.690, 0], 0.496, [{ x: ox + 20.029, y: oy - 15.163, docking: true }]],
    ["amrFuzz_20261204_45", [ox + 17.523, oy - 7.534, 0], 2.260, [{ x: ox - 39.287, y: oy - 27.501, docking: true }]],
  ];
  const errs = [];
  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 8000 : 4000;
    for (const [label, sPos, sH, wps] of amrCases) {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      const amr = mgr.spawnAmr(`t5b12-${label}`, { pos: sPos, heading: sH });
      let hits = 0;
      const last = wps[wps.length - 1];
      try {
        assert.equal(checkAmrHits(amr, obbs), 0, `${label} t=0 hits`);
        const res = await stepUntilSettled(() => {
          mgr.tick(dt);
          hits += checkAmrHits(amr, obbs);
        }, amr.enqueue({ type: "driveTo", waypoints: wps }), maxSteps);
        assert.ok(res.steps < maxSteps, `${label} dt=${dt}: steps=${res.steps}`);
        assert.equal(hits, 0, `${label} dt=${dt}: hits=${hits}`);
        const dEnd = Math.hypot(amr.x - last.x, amr.y - last.y);
        assert.ok(dEnd <= 0.15, `${label} dt=${dt}: dEnd=${dEnd.toFixed(3)}`);
      } catch (e) {
        errs.push(`${label} dt=${dt.toFixed(4)}: ${e?.message || e}`);
      } finally {
        mgr.dispose();
      }
    }
  }
  assert.equal(errs.length, 0, `${errs.length}/6 AMR case(s) failed: ${errs.join(" | ")}`);
});

test("B", "T5-B13 (challenger_5 multi-waypoint driveTo solid-obstacle routing): 4 AMR + 1 3-wp AMR & 3 AGF + 1 3-wp AGF (0 & 4000012) across dt=1/60 & 1/30 with 0 hits & 0 drift", async () => {
  const AMR_CORNERS = [[-0.39, -0.52], [0.39, -0.52], [-0.39, 0.52], [0.39, 0.52]];
  const checkAmrHits = (amr, obbs) => {
    let hits = 0;
    for (const [lx, ly] of AMR_CORNERS) {
      const [wx, wy] = WS.localToWorld2D(lx, ly, amr.x, amr.y, amr.heading);
      for (const b of obbs) {
        const dx = wx - b.cx;
        const dy = wy - b.cy;
        const c = Math.cos(b.h);
        const s = Math.sin(b.h);
        if (Math.abs(dx * c - dy * s) < b.hw - 1e-4 && Math.abs(dx * s + dy * c) < b.hl - 1e-4) hits++;
      }
    }
    for (const b of obbs) if (satObbHit(amr.x, amr.y, amr.heading, 0.39, 0.52, b)) hits++;
    return hits;
  };
  const amrCases = [
    ["amr_2wp_S1_S2_dock", [ox + 10, oy + 3, 0], Math.PI * 0.5, [{ x: ox + 20, y: oy + 3 }, { x: ox + 10, y: oy - 3, docking: true }]],
    ["amr_2wp_S1_S2_nodock", [ox + 10, oy + 3, 0], Math.PI * 0.5, [{ x: ox + 20, y: oy + 3 }, { x: ox + 10, y: oy - 3 }]],
    ["amr_2wp_S3_S4", [ox + 10, oy - 3, 0], Math.PI * 0.5, [{ x: ox + 20, y: oy - 3 }, { x: ox + 20, y: oy - 12 }]],
    ["amr_2wp_S5_S6", [ox + 10, oy - 9, 0], Math.PI * 0.5, [{ x: ox + 20, y: oy - 9 }, { x: ox + 10, y: oy - 15 }]],
    ["amr_3wp_zoneC_chain", [ox + 10, oy + 3, 0], Math.PI * 0.5, [{ x: ox + 20, y: oy + 3 }, { x: ox + 20, y: oy - 9 }, { x: ox + 10, y: oy - 9 }]],
  ];
  const agfCases = [
    ["agf_2wp_thru_R1", [ox - 10, oy + 12, 0], Math.PI, [[ox - 10, oy - 2], [ox - 10, oy - 16]]],
    ["agf_2wp_thru_C1", [ox - 40, oy + 22, 0], 0, [[ox - 40, oy + 42], [ox - 30, oy + 42]]],
    ["agf_2wp_thru_S1", [ox + 10, oy + 4.2, 0], Math.PI * 0.5, [[ox + 20, oy + 4.2], [ox + 20, oy - 6]]],
    ["agf_3wp_chain", [ox - 10, oy + 12, 0], Math.PI, [[ox - 10, oy - 2], [ox + 20, oy + 4.2], [ox - 40, oy + 42]]],
  ];
  const errs = [];
  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 8000 : 4000;
    for (const [label, sPos, sH, wps] of amrCases) {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      const amr = mgr.spawnAmr(`t5b13-${label}`, { pos: sPos, heading: sH });
      let hits = 0;
      const last = wps[wps.length - 1];
      try {
        assert.equal(checkAmrHits(amr, obbs), 0, `${label} t=0 hits`);
        await stepUntilSettled(() => {
          mgr.tick(dt);
          hits += checkAmrHits(amr, obbs);
        }, amr.enqueue({ type: "driveTo", waypoints: wps }), maxSteps);
        assert.equal(hits, 0, `${label} dt=${dt}: hits=${hits}`);
        const dEnd = Math.hypot(amr.x - last.x, amr.y - last.y);
        assert.ok(dEnd <= 0.15, `${label} dt=${dt}: dEnd=${dEnd.toFixed(3)}`);
        const ex = amr.x;
        const ey = amr.y;
        for (let i = 0; i < 60; i++) mgr.tick(dt);
        assert.ok(Math.hypot(amr.x - ex, amr.y - ey) <= 1e-4, `${label} dt=${dt}: idle drift`);
      } catch (e) {
        errs.push(`${label} dt=${dt.toFixed(4)}: ${e?.message || e}`);
      } finally {
        mgr.dispose();
      }
    }
    for (const wcid of [0, 4000012]) {
      for (const [label, sPos, sH, wps] of agfCases) {
        const cMap = makeDefaultContainers();
        const rig = makeRig();
        const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
        mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
        const obbs = getObbs(mgr, cMap);
        const agf = mgr.spawnAgf(`t5b13-${label}`, { pos: sPos, heading: sH, carriedWcid: wcid });
        let cornerHits = 0;
        let satHits = 0;
        const last = wps[wps.length - 1];
        try {
          assert.equal(checkAgfHits(agf, obbs).cornerHits + checkAgfHits(agf, obbs).satHits, 0, `${label} w=${wcid} t=0 hits`);
          await stepUntilSettled(() => {
            mgr.tick(dt);
            const r = checkAgfHits(agf, obbs);
            cornerHits += r.cornerHits;
            satHits += r.satHits;
          }, agf.enqueue({ type: "driveTo", waypoints: wps }), maxSteps);
          assert.equal(cornerHits, 0, `${label} w=${wcid} dt=${dt}: cornerHits=${cornerHits}`);
          assert.equal(satHits, 0, `${label} w=${wcid} dt=${dt}: satHits=${satHits}`);
          const dEnd = Math.hypot(agf.x - last[0], agf.y - last[1]);
          assert.ok(dEnd <= 0.15, `${label} w=${wcid} dt=${dt}: dEnd=${dEnd.toFixed(3)}`);
          const ex = agf.x;
          const ey = agf.y;
          for (let i = 0; i < 60; i++) mgr.tick(dt);
          assert.ok(Math.hypot(agf.x - ex, agf.y - ey) <= 1e-4, `${label} w=${wcid} dt=${dt}: idle drift`);
        } catch (e) {
          errs.push(`${label} w=${wcid} dt=${dt.toFixed(4)}: ${e?.message || e}`);
        } finally {
          mgr.dispose();
        }
      }
    }
  }
  assert.equal(errs.length, 0, `${errs.length} multi-wp case(s) failed: ${errs.join(" | ")}`);
});

test("B", "T5-B14 (challenger_6 Bug 1 multi-waypoint propagation, curPt reject, & intermediate docking routing): AGF & AMR across dt=1/60 & 1/30 with 0 hits & clean rejection", async () => {
  const AMR_CORNERS = [[-0.39, -0.52], [0.39, -0.52], [-0.39, 0.52], [0.39, 0.52]];
  const checkAmrHits = (amr, obbs) => {
    let hits = 0;
    for (const [lx, ly] of AMR_CORNERS) {
      const [wx, wy] = WS.localToWorld2D(lx, ly, amr.x, amr.y, amr.heading);
      for (const b of obbs) {
        const dx = wx - b.cx;
        const dy = wy - b.cy;
        const c = Math.cos(b.h);
        const s = Math.sin(b.h);
        if (Math.abs(dx * c - dy * s) < b.hw - 1e-4 && Math.abs(dx * s + dy * c) < b.hl - 1e-4) hits++;
      }
    }
    for (const b of obbs) if (satObbHit(amr.x, amr.y, amr.heading, 0.39, 0.52, b)) hits++;
    return hits;
  };
  const errs = [];
  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 12000 : 6000;
    // Unreachable 1-wp & 2-wp must reject cleanly without curPt short false-success or silent unrouted fallback
    for (const [label, sPos, wps] of [
      ["agf_unreach_1wp", [ox - 21, oy + 12, 0], [[ox - 10, oy + 5.35]]],
      ["agf_unreach_2wp", [ox - 21, oy + 12, 0], [[ox - 10, oy + 12], [ox - 10, oy + 5.35]]],
    ]) {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const agf = mgr.spawnAgf(`t5b14-${label}`, { pos: sPos, heading: Math.PI });
      try {
        let rejErr = null;
        await assert.rejects(async () => {
          await stepUntilSettled(() => mgr.tick(dt), agf.enqueue({ type: "driveTo", waypoints: wps }).catch((e) => { rejErr = e; throw e; }), 300);
        }, /AGF route unreachable/);
        assert.ok(rejErr && /AGF route unreachable/.test(rejErr.message), `${label} rejected with AGF route unreachable`);
      } catch (e) {
        errs.push(`${label} dt=${dt.toFixed(4)}: ${e?.message || e}`);
      } finally {
        mgr.dispose();
      }
    }
    // AGF non-duplicate 2-wp CH7 & intermediate docking: true (through R1)
    for (const wcid of [0, 4000012]) {
      for (const [label, sPos, sH, wps] of [
        ["agf_nondup_2wp_CH7", [ox - 41.663, oy + 42.0, 0], Math.PI, [[ox - 41.663, oy + 39.233], [ox + 11.291, oy - 37.758]]],
        ["agf_interm_dock_R1", [ox - 10, oy + 12, 0], Math.PI, [{ x: ox - 10, y: oy - 2, docking: true }, { x: ox - 10, y: oy - 16 }]],
      ]) {
        const cMap = makeDefaultContainers();
        const rig = makeRig();
        const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
        mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
        const obbs = getObbs(mgr, cMap);
        const agf = mgr.spawnAgf(`t5b14-${label}`, { pos: sPos, heading: sH, carriedWcid: wcid });
        let hits = 0;
        const last = wps[wps.length - 1];
        const lx = Array.isArray(last) ? last[0] : last.x;
        const ly = Array.isArray(last) ? last[1] : last.y;
        try {
          const initR = checkAgfHits(agf, obbs);
          assert.equal(initR.cornerHits + initR.satHits, 0, `${label} w=${wcid} t=0 hits`);
          await stepUntilSettled(() => {
            mgr.tick(dt);
            const r = checkAgfHits(agf, obbs);
            hits += r.cornerHits + r.satHits;
          }, agf.enqueue({ type: "driveTo", waypoints: wps }), maxSteps);
          assert.equal(hits, 0, `${label} w=${wcid} dt=${dt}: hits=${hits}`);
          const dEnd = Math.hypot(agf.x - lx, agf.y - ly);
          assert.ok(dEnd <= 0.15, `${label} w=${wcid} dt=${dt}: dEnd=${dEnd.toFixed(3)}`);
          const ex = agf.x;
          const ey = agf.y;
          for (let i = 0; i < 60; i++) mgr.tick(dt);
          assert.ok(Math.hypot(agf.x - ex, agf.y - ey) <= 1e-4, `${label} w=${wcid} dt=${dt}: idle drift`);
        } catch (e) {
          errs.push(`${label} w=${wcid} dt=${dt.toFixed(4)}: ${e?.message || e}`);
        } finally {
          mgr.dispose();
        }
      }
    }
    // AMR intermediate docking: true near S1/S2 & Zone C gap
    for (const [label, sPos, sH, wps] of [
      ["amr_interm_dock_S1", [ox + 10, oy + 3, 0], Math.PI * 0.5, [{ x: ox + 14.0, y: oy + 3.12, heading: Math.PI * 0.5, docking: true }, { x: ox + 20, y: oy - 3 }]],
      ["amr_interm_dock_S1_skew", [ox + 10, oy + 0, 0], 0, [{ x: ox + 14.0, y: oy + 3.12, heading: Math.PI * 0.5, docking: true }, { x: ox + 20, y: oy - 3 }]],
      ["amr_zoneC_13081", [ox + 10, oy + 3, 0], Math.PI * 0.5, [{ x: ox + 13.081, y: oy + 3.0, docking: true }, { x: ox + 20, y: oy + 3 }]],
    ]) {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      const amr = mgr.spawnAmr(`t5b14-${label}`, { pos: sPos, heading: sH });
      let hits = 0;
      const last = wps[wps.length - 1];
      try {
        assert.equal(checkAmrHits(amr, obbs), 0, `${label} t=0 hits`);
        await stepUntilSettled(() => {
          mgr.tick(dt);
          hits += checkAmrHits(amr, obbs);
        }, amr.enqueue({ type: "driveTo", waypoints: wps }), dt < 0.025 ? 8000 : 4000);
        assert.equal(hits, 0, `${label} dt=${dt}: hits=${hits}`);
        const dEnd = Math.hypot(amr.x - last.x, amr.y - last.y);
        assert.ok(dEnd <= 0.15, `${label} dt=${dt}: dEnd=${dEnd.toFixed(3)}`);
        const ex = amr.x;
        const ey = amr.y;
        for (let i = 0; i < 60; i++) mgr.tick(dt);
        assert.ok(Math.hypot(amr.x - ex, amr.y - ey) <= 1e-4, `${label} dt=${dt}: idle drift`);
      } catch (e) {
        errs.push(`${label} dt=${dt.toFixed(4)}: ${e?.message || e}`);
      } finally {
        mgr.dispose();
      }
    }
  }
  assert.equal(errs.length, 0, `${errs.length} Bug 1 case(s) failed: ${errs.join(" | ")}`);
});

test("B", "T5-B15 (challenger_6 Bug 2 tight & open-apron AGF routes): tight_20261125_36, 20261166_39, 20861211_47, 20761125_26 across dt=1/60 & 1/30", async () => {
  const cases = [
    ["36_pi", [-41.663, 39.233], Math.PI, [11.291, -37.758], false],
    ["36_5pi4", [-41.663, 39.233], 5 * Math.PI / 4, [11.291, -37.758], false],
    ["36_3pi2", [-41.663, 39.233], 3 * Math.PI / 2, [11.291, -37.758], false],
    ["39_0", [-0.49, 35.12], 0, [7.39, -8.71], false],
    ["39_pi", [-0.49, 35.12], Math.PI, [7.39, -8.71], false],
    ["47_clear_negpi2", [-15.74, -2.34], -Math.PI * 0.5, [-8.18, -25.37], false],
    ["47_start_0", [-15.74, -2.34], 0, [-8.18, -25.37], true],
    ["26_clear_pi", [15.27, -1.91], Math.PI, [1.54, -36.87], false],
    ["26_start_pi2", [15.27, -1.91], Math.PI * 0.5, [1.54, -36.87], true],
  ];
  const errs = [];
  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 12000 : 6000;
    for (const wcid of [0, 4000012]) {
      for (const [label, sOff, sH, tOff, allowStartOverlap] of cases) {
        const cMap = makeDefaultContainers();
        const rig = makeRig();
        const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
        mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
        const obbs = getObbs(mgr, cMap);
        const agf = mgr.spawnAgf(`t5b15-${label}`, { pos: [ox + sOff[0], oy + sOff[1], 0], heading: sH, carriedWcid: wcid });
        const startHitObs = new Set();
        if (allowStartOverlap) {
          const [chX, chY] = WS.localToWorld2D(0, -0.89, agf.x, agf.y, agf.heading);
          const [fkX, fkY] = WS.localToWorld2D(0, 0.725, agf.x, agf.y, agf.heading);
          for (const b of obbs) {
            if (satObbHit(chX, chY, agf.heading, 0.57, 1.04, b) || satObbHit(fkX, fkY, agf.heading, 0.34, 0.575, b)) {
              startHitObs.add(b);
            }
          }
        }
        const evalObbs = allowStartOverlap ? obbs.filter((b) => !startHitObs.has(b)) : obbs;
        let hits = 0;
        let settled = false;
        let err = null;
        let steps = 0;
        const p = agf.enqueue({ type: "driveTo", waypoints: [[ox + tOff[0], oy + tOff[1]]] }).then(
          () => { settled = true; },
          (e) => { settled = true; err = e; },
        );
        try {
          const initR = checkAgfHits(agf, evalObbs);
          assert.equal(initR.cornerHits + initR.satHits, 0, `${label} w=${wcid} t=0 non-start hits`);
          const t0 = performance.now();
          mgr.tick(dt);
          const initMs = performance.now() - t0;
          hits += (() => { const r = checkAgfHits(agf, evalObbs); return r.cornerHits + r.satHits; })();
          assert.ok(initMs < 2500, `${label} w=${wcid} dt=${dt}: initMs=${initMs.toFixed(1)} >= 2500`);
          while (!settled && steps < maxSteps) {
            mgr.tick(dt);
            const r = checkAgfHits(agf, evalObbs);
            hits += r.cornerHits + r.satHits;
            steps++;
            await Promise.resolve();
          }
          await Promise.resolve();
          if (err) throw err;
          assert.ok(settled, `${label} w=${wcid} dt=${dt}: timed out`);
          assert.equal(hits, 0, `${label} w=${wcid} dt=${dt}: hits=${hits}`);
          const dEnd = Math.hypot(agf.x - (ox + tOff[0]), agf.y - (oy + tOff[1]));
          assert.ok(dEnd <= 0.15, `${label} w=${wcid} dt=${dt}: dEnd=${dEnd.toFixed(3)}`);
        } catch (e) {
          errs.push(`${label} w=${wcid} dt=${dt.toFixed(4)}: ${e?.message || e}`);
        } finally {
          void p;
          mgr.dispose();
        }
      }
    }
  }
  assert.equal(errs.length, 0, `${errs.length} Bug 2 case(s) failed: ${errs.join(" | ")}`);
});

test("B", "T5-B16 (challenger_6 Bug 3 placeInRack occupied-slot guard): rejects occupied slot synchronously/on init, preserves cargo, allows empty slot", async () => {
  const cMap = makeDefaultContainers();
  const rig = makeRig();
  const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
  mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
  try {
    const r1 = mgr.racks.get("R1");
    assert.ok(r1, "R1 present");
    r1.loadSlot(0, 0, 0, 0, 4000010);
    const agf = mgr.spawnAgf("t5b16-agf", { pos: [ox - 10, oy + 3, 0], heading: 0, carriedWcid: 4000012 });
    const startX = agf.x;
    const startY = agf.y;
    let err = null;
    const p = agf.enqueue({ type: "placeInRack", rackId: "R1", bay: 0, tier: 0, side: 0, slotInBay: 0 }).catch((e) => { err = e; });
    mgr.tick(1 / 60);
    await p;
    assert.ok(err && /occupied/i.test(err.message), `Expected occupied-slot rejection, got: ${err?.message}`);
    assert.equal(r1.loadedSlots.get("0:0:0:0")?.wcid, 4000010, "Original cargo 4000010 preserved in occupied slot");
    assert.equal(agf.carriedWcid, 4000012, "AGF retained carried cargo 4000012 after rejection");
    assert.ok(Math.hypot(agf.x - startX, agf.y - startY) < 0.05, "AGF did not drive toward occupied rack slot");

    // Empty slot 0:0:0:1 still works normally
    const res = await stepUntilSettled(
      () => mgr.tick(1 / 60),
      agf.enqueue({ type: "placeInRack", rackId: "R1", bay: 0, tier: 0, side: 0, slotInBay: 1 }),
      6000,
    );
    assert.ok(res.steps < 6000, "placeInRack into empty slot settled");
    assert.equal(r1.loadedSlots.get("0:0:0:1")?.wcid, 4000012, "Empty slot loaded with 4000012");
    assert.equal(agf.carriedWcid, 0, "AGF unloaded after placing into empty slot");
  } finally {
    mgr.dispose();
  }
});

test("B", "T5-B17 (challenger_7 Bugs 1-4 + Caveat 3): non-driveTo AGF route-failure & same-tick placeInRack reservation, 2-wp reverse->forward, AMR intermediate close-dock, & strict stand obstacle enforcement", async () => {
  const AMR_CORNERS = [[-0.39, -0.52], [0.39, -0.52], [-0.39, 0.52], [0.39, 0.52]];
  const checkAmrHits = (amr, obbs) => {
    let hits = 0;
    for (const [lx, ly] of AMR_CORNERS) {
      const [wx, wy] = WS.localToWorld2D(lx, ly, amr.x, amr.y, amr.heading);
      for (const b of obbs) {
        const dx = wx - b.cx;
        const dy = wy - b.cy;
        const c = Math.cos(b.h);
        const s = Math.sin(b.h);
        if (Math.abs(dx * c - dy * s) < b.hw - 1e-4 && Math.abs(dx * s + dy * c) < b.hl - 1e-4) hits++;
      }
    }
    for (const b of obbs) if (satObbHit(amr.x, amr.y, amr.heading, 0.39, 0.52, b)) hits++;
    return hits;
  };
  const errs = [];
  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 12000 : 6000;
    // Bug 1 & Bug 4: non-driveTo AGF tasks + non-docking driveTo inside stand AABB reject cleanly with 0 hits
    {
      const cMap = makeDefaultContainers();
      const deployables = new Map([[9901, { guid: 9901, wcid: 4000012, rawPos: [ox - 10, oy + 5.5, 0] }]]);
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables, palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      try {
        for (const [label, sPos, sH, wcid, task, rx] of [
          ["dropToGround_R1", [ox - 10, oy + 12, 0], Math.PI, 4000012, { type: "dropToGround", pos: [ox - 10, oy + 5.5, 0], heading: 0 }, /AGF route unreachable/],
          ["pickGroundDeployable_R1", [ox - 10, oy + 12, 0], Math.PI, 0, { type: "pickGroundDeployable", deployableGuid: 9901 }, /AGF route unreachable/],
          ["trapped_placeOnStand_S1", [ox - 10, oy + 5.5, 0], 0, 4000012, { type: "placeOnStand", standId: "S1" }, /AGF route unreachable/],
          ["trapped_placeInRack_R6", [ox - 10, oy + 5.5, 0], 0, 4000012, { type: "placeInRack", rackId: "R6", bay: 0, tier: 0, side: 0, slotInBay: 0 }, /AGF route unreachable/],
          ["driveTo_inside_S9", [ox - 10, oy - 18.5, 0], Math.PI, 0, { type: "driveTo", waypoints: [[ox - 10, oy - 24]] }, /AGF route unreachable/],
          ["driveTo_inside_S15", [ox + 8, oy - 18.5, 0], Math.PI, 0, { type: "driveTo", waypoints: [[ox + 8, oy - 24]] }, /AGF route unreachable/],
        ]) {
          const agf = mgr.spawnAgf(`t5b17-${label}`, { pos: sPos, heading: sH, carriedWcid: wcid });
          const startClear = checkAgfHits(agf, obbs);
          let rejErr = null;
          let moveHits = 0;
          await assert.rejects(async () => {
            await stepUntilSettled(() => {
              mgr.tick(dt);
              if (startClear.cornerHits + startClear.satHits === 0) {
                const r = checkAgfHits(agf, obbs);
                moveHits += r.cornerHits + r.satHits;
              }
            }, agf.enqueue(task).catch((e) => { rejErr = e; throw e; }), 300);
          }, rx);
          assert.ok(rejErr && rx.test(rejErr.message), `${label} dt=${dt.toFixed(4)} expected ${rx}`);
          assert.equal(moveHits, 0, `${label} dt=${dt.toFixed(4)} had ${moveHits} hits`);
        }

        // Caveat 3: same-tick concurrent placeInRack into empty slot rejects second AGF
        const r1 = mgr.racks.get("R1");
        const a1 = mgr.spawnAgf("t5b17-conc-1", { pos: [ox - 14.55, oy + 3, 0], heading: 0, carriedWcid: 4000012 });
        const a2 = mgr.spawnAgf("t5b17-conc-2", { pos: [ox - 11.55, oy + 3, 0], heading: 0, carriedWcid: 4000013 });
        let r2Err = null;
        const p1 = a1.enqueue({ type: "placeInRack", rackId: "R1", bay: 0, tier: 0, side: 0, slotInBay: 0 });
        const p2 = a2.enqueue({ type: "placeInRack", rackId: "R1", bay: 0, tier: 0, side: 0, slotInBay: 0 }).catch((e) => { r2Err = e; });
        mgr.tick(dt);
        await p2;
        assert.ok(r2Err && /occupied/i.test(r2Err.message), `Concurrent same-tick placeInRack expected occupied rejection, got ${r2Err?.message}`);
        assert.equal(a2.carriedWcid, 4000013, "Second AGF retained cargo");
        await stepUntilSettled(() => mgr.tick(dt), p1, 3000);
        assert.equal(r1.loadedSlots.get("0:0:0:0")?.wcid, 4000012, "First AGF placed 4000012 cleanly");
      } catch (e) {
        errs.push(`bug1_4 dt=${dt.toFixed(4)}: ${e?.message || e}`);
      } finally {
        mgr.dispose();
      }
    }

    // Bug 2: AGF 2-wp [reverse, forward] clears S1 with 0 hits & 0 drift across w=0 & 4000012
    for (const wcid of [0, 4000012]) {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      const agf = mgr.spawnAgf("t5b17-bug2", { pos: [ox - 10, oy + 12, 0], heading: Math.PI, carriedWcid: wcid });
      let hits = 0;
      try {
        const initR = checkAgfHits(agf, obbs);
        assert.equal(initR.cornerHits + initR.satHits, 0, `bug2 w=${wcid} t=0 hits`);
        await stepUntilSettled(() => {
          mgr.tick(dt);
          const r = checkAgfHits(agf, obbs);
          hits += r.cornerHits + r.satHits;
        }, agf.enqueue({ type: "driveTo", waypoints: [{ x: ox - 10, y: oy + 15, reverse: true }, [ox + 11.291, oy - 37.758]] }), maxSteps);
        assert.equal(hits, 0, `bug2 w=${wcid} dt=${dt.toFixed(4)}: hits=${hits}`);
        const dEnd = Math.hypot(agf.x - (ox + 11.291), agf.y - (oy - 37.758));
        assert.ok(dEnd <= 0.15, `bug2 w=${wcid} dt=${dt.toFixed(4)}: dEnd=${dEnd.toFixed(3)}`);
        const ex = agf.x;
        const ey = agf.y;
        for (let i = 0; i < 60; i++) mgr.tick(dt);
        assert.ok(Math.hypot(agf.x - ex, agf.y - ey) <= 1e-4, `bug2 w=${wcid} dt=${dt.toFixed(4)}: idle drift`);
      } catch (e) {
        errs.push(`bug2 w=${wcid} dt=${dt.toFixed(4)}: ${e?.message || e}`);
      } finally {
        mgr.dispose();
      }
    }

    // Bug 3: AMR intermediate docking: true close-start [13.0, 3.12] -> {14.0, 3.12, docking:true} -> [20, -3]
    {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      const amr = mgr.spawnAmr("t5b17-bug3", { pos: [ox + 13.0, oy + 3.12, 0], heading: Math.PI * 0.5 });
      let hits = 0;
      try {
        assert.equal(checkAmrHits(amr, obbs), 0, "bug3 t=0 hits");
        await stepUntilSettled(() => {
          mgr.tick(dt);
          hits += checkAmrHits(amr, obbs);
        }, amr.enqueue({ type: "driveTo", waypoints: [{ x: ox + 14.0, y: oy + 3.12, heading: Math.PI * 0.5, docking: true }, [ox + 20, oy - 3]] }), dt < 0.025 ? 8000 : 4000);
        assert.equal(hits, 0, `bug3 dt=${dt.toFixed(4)}: hits=${hits}`);
        const dEnd = Math.hypot(amr.x - (ox + 20), amr.y - (oy - 3));
        assert.ok(dEnd <= 0.15, `bug3 dt=${dt.toFixed(4)}: dEnd=${dEnd.toFixed(3)}`);
        const ex = amr.x;
        const ey = amr.y;
        for (let i = 0; i < 60; i++) mgr.tick(dt);
        assert.ok(Math.hypot(amr.x - ex, amr.y - ey) <= 1e-4, `bug3 dt=${dt.toFixed(4)}: idle drift`);
      } catch (e) {
        errs.push(`bug3 dt=${dt.toFixed(4)}: ${e?.message || e}`);
      } finally {
        mgr.dispose();
      }
    }
  }
  assert.equal(errs.length, 0, `${errs.length} T5-B17 case(s) failed: ${errs.join(" | ")}`);
});

test("B", "T5-B18 (challenger_8 Bug A & Bug B): AMR unheaded/skewed intermediate close-dock on S1 + blocked/trapped dockCharge, pickFromStand, placeOnStand, driveTo rejection", async () => {
  const AMR_CORNERS = [[-0.39, -0.52], [0.39, -0.52], [-0.39, 0.52], [0.39, 0.52]];
  const checkAmrHits = (amr, obbs) => {
    let hits = 0;
    for (const [lx, ly] of AMR_CORNERS) {
      const [wx, wy] = WS.localToWorld2D(lx, ly, amr.x, amr.y, amr.heading);
      for (const b of obbs) {
        const dx = wx - b.cx;
        const dy = wy - b.cy;
        const c = Math.cos(b.h);
        const s = Math.sin(b.h);
        if (Math.abs(dx * c - dy * s) < b.hw - 1e-4 && Math.abs(dx * s + dy * c) < b.hl - 1e-4) hits++;
      }
    }
    for (const b of obbs) if (satObbHit(amr.x, amr.y, amr.heading, 0.39, 0.52, b)) hits++;
    return hits;
  };
  const errs = [];
  const bugACases = [
    ["S1_unheaded", [ox + 13.0, oy + 3.12, 0], Math.PI * 0.5, [{ x: ox + 14.0, y: oy + 3.12, docking: true }, [ox + 20, oy - 3]]],
    ["S1_skew_0.13", [ox + 13.0, oy + 3.12, 0], Math.PI * 0.5 + 0.13, [{ x: ox + 14.0, y: oy + 3.12, heading: Math.PI * 0.5, docking: true }, [ox + 20, oy - 3]]],
    ["S1_skew_0.15", [ox + 13.0, oy + 3.12, 0], Math.PI * 0.5 + 0.15, [{ x: ox + 14.0, y: oy + 3.12, heading: Math.PI * 0.5, docking: true }, [ox + 20, oy - 3]]],
    ["S1_skew_0.25", [ox + 13.0, oy + 3.12, 0], Math.PI * 0.5 + 0.25, [{ x: ox + 14.0, y: oy + 3.12, heading: Math.PI * 0.5, docking: true }, [ox + 20, oy - 3]]],
    ["S1_skew_neg0.25", [ox + 13.0, oy + 3.12, 0], Math.PI * 0.5 - 0.25, [{ x: ox + 14.0, y: oy + 3.12, heading: Math.PI * 0.5, docking: true }, [ox + 20, oy - 3]]],
    ["S1_skew_pi4", [ox + 13.0, oy + 3.12, 0], Math.PI * 0.5 + Math.PI / 4, [{ x: ox + 14.0, y: oy + 3.12, heading: Math.PI * 0.5, docking: true }, [ox + 20, oy - 3]]],
    ["S1_unheaded_skew_0.20", [ox + 13.0, oy + 3.12, 0], Math.PI * 0.5 + 0.20, [{ x: ox + 14.0, y: oy + 3.12, docking: true }, [ox + 20, oy - 3]]],
  ];
  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 8000 : 4000;
    for (const [label, sPos, sH, wps] of bugACases) {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      const amr = mgr.spawnAmr(`t5b18-${label}`, { pos: sPos, heading: sH });
      let hits = 0;
      const last = wps[wps.length - 1];
      const lx = Array.isArray(last) ? last[0] : last.x;
      const ly = Array.isArray(last) ? last[1] : last.y;
      try {
        assert.equal(checkAmrHits(amr, obbs), 0, `${label} t=0 hits`);
        await stepUntilSettled(() => {
          mgr.tick(dt);
          hits += checkAmrHits(amr, obbs);
        }, amr.enqueue({ type: "driveTo", waypoints: wps }), maxSteps);
        assert.equal(hits, 0, `${label} dt=${dt.toFixed(4)}: hits=${hits}`);
        const dEnd = Math.hypot(amr.x - lx, amr.y - ly);
        assert.ok(dEnd <= 0.15, `${label} dt=${dt.toFixed(4)}: dEnd=${dEnd.toFixed(3)}`);
        const ex = amr.x;
        const ey = amr.y;
        for (let i = 0; i < 60; i++) mgr.tick(dt);
        assert.ok(Math.hypot(amr.x - ex, amr.y - ey) <= 1e-4, `${label} dt=${dt.toFixed(4)}: idle drift`);
      } catch (e) {
        errs.push(`${label} dt=${dt.toFixed(4)}: ${e?.message || e}`);
      } finally {
        mgr.dispose();
      }
    }

    // Bug B: blocked dockCharge/pickFromStand + trapped-in-R1 AMR rejections
    const cMapB = makeDefaultContainers([
      { guid: 0x70000077, kind: 10, heading: Math.PI * 0.5, pos: [ox - 14, oy - 34.5, 0] },
      { guid: 0x70000078, kind: 10, heading: 0, pos: [ox + 15.60, oy + 4.2, 0] },
    ]);
    const rigB = makeRig();
    const mgrB = createWarehouseManager({ THREE, liveScene3d: rigB.live, containers: cMapB, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rigB.sh });
    mgrB.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
    const obbsB = getObbs(mgrB, cMapB);
    mgrB.stands.get("S1").setCargoWcid(4000012);
    mgrB.stands.get("S2").setCargoWcid(4000013);
    try {
      for (const [label, sPos, sH, wcid, task] of [
        ["blocked_dockCharge_CH1", [ox - 14, oy - 28, 0], Math.PI, 0, { type: "dockCharge", chargerId: "CH1" }],
        ["blocked_pickFromStand_S1", [ox + 18, oy + 4.2, 0], -Math.PI * 0.5, 0, { type: "pickFromStand", standId: "S1" }],
        ["trapped_R1_pickFromStand_S1", [ox - 10, oy + 5.5, 0], 0, 0, { type: "pickFromStand", standId: "S1" }],
        ["trapped_R1_placeOnStand_S3", [ox - 10, oy + 5.5, 0], 0, 4000012, { type: "placeOnStand", standId: "S3" }],
        ["trapped_R1_dockCharge_CH1", [ox - 10, oy + 5.5, 0], 0, 0, { type: "dockCharge", chargerId: "CH1" }],
        ["trapped_R1_driveTo", [ox - 10, oy + 5.5, 0], 0, 0, { type: "driveTo", waypoints: [[ox - 20, oy + 12]] }],
      ]) {
        const amr = mgrB.spawnAmr(`t5b18-${label}`, { pos: sPos, heading: sH, carriedWcid: wcid });
        const startHits = checkAmrHits(amr, obbsB);
        let rejErr = null;
        let moveHits = 0;
        const startX = amr.x;
        const startY = amr.y;
        await assert.rejects(async () => {
          await stepUntilSettled(() => {
            mgrB.tick(dt);
            if (startHits === 0) moveHits += checkAmrHits(amr, obbsB);
          }, amr.enqueue(task).catch((e) => { rejErr = e; throw e; }), 300);
        }, /AMR route unreachable/);
        assert.ok(rejErr && /AMR route unreachable/.test(rejErr.message), `${label} dt=${dt.toFixed(4)} expected AMR route unreachable`);
        assert.equal(moveHits, 0, `${label} dt=${dt.toFixed(4)} had ${moveHits} hits`);
        if (startHits === 0) {
          assert.ok(Math.hypot(amr.x - startX, amr.y - startY) < 0.05, `${label} dt=${dt.toFixed(4)} moved before rejecting`);
        }
      }
    } catch (e) {
      errs.push(`bugB dt=${dt.toFixed(4)}: ${e?.message || e}`);
    } finally {
      mgrB.dispose();
    }
  }
  assert.equal(errs.length, 0, `${errs.length} T5-B18 case(s) failed: ${errs.join(" | ")}`);
});

test("B", "T5-B19 (challenger_9 Bugs 1-4): AMR charger departure pullout (0 teleport/0 hits), AMR/AGF mid-route liftTable height races, & AMR sealed-enclosure unreachable rejection across dt=1/60 & 1/30", async () => {
  const AMR_CORNERS = [[-0.39, -0.52], [0.39, -0.52], [-0.39, 0.52], [0.39, 0.52]];
  const checkAmrHits = (amr, obbs) => {
    let hits = 0;
    for (const [lx, ly] of AMR_CORNERS) {
      const [wx, wy] = WS.localToWorld2D(lx, ly, amr.x, amr.y, amr.heading);
      for (const b of obbs) {
        const dx = wx - b.cx;
        const dy = wy - b.cy;
        const c = Math.cos(b.h);
        const s = Math.sin(b.h);
        if (Math.abs(dx * c - dy * s) < b.hw - 1e-4 && Math.abs(dx * s + dy * c) < b.hl - 1e-4) hits++;
      }
    }
    for (const b of obbs) if (satObbHit(amr.x, amr.y, amr.heading, 0.39, 0.52, b)) hits++;
    return hits;
  };

  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 6000 : 3000;
    const jumpLim = 2.0 * dt + 0.02;

    // Bug 1: dockCharge("CH1") -> driveTo([ox-14, oy-30]), pickFromStand("S1"), dockCharge("CH2"), driveTo([ox-10, oy-37.38]) & driveTo([ox-10, oy-36.80])
    {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      const ch1Obb = obbs.filter((b) => b.id === "CH1");
      const ch2Obb = obbs.filter((b) => b.id === "CH2");
      const nonCh1Obbs = obbs.filter((b) => b.id !== "CH1");
      const nonChObbs = obbs.filter((b) => b.id !== "CH1" && b.id !== "CH2");
      try {
        // 1a. dockCharge("CH1") -> driveTo([ox-14, oy-30])
        const amrA = mgr.spawnAmr("t5b19-1a", { pos: [ox - 14, oy - 31, 0], heading: Math.PI });
        await stepUntilSettled(() => mgr.tick(dt), amrA.enqueue({ type: "dockCharge", chargerId: "CH1" }), maxSteps);
        let maxJumpA = 0, hitsA = 0, px = amrA.x, py = amrA.y;
        await stepUntilSettled(() => {
          mgr.tick(dt);
          maxJumpA = Math.max(maxJumpA, Math.hypot(amrA.x - px, amrA.y - py));
          px = amrA.x; py = amrA.y;
          hitsA += checkAmrHits(amrA, nonCh1Obbs);
          if (amrA.y > oy - 37.0) hitsA += checkAmrHits(amrA, ch1Obb);
        }, amrA.enqueue({ type: "driveTo", waypoints: [[ox - 14, oy - 30]] }), maxSteps);
        assert.ok(maxJumpA <= jumpLim, `1a dt=${dt} maxJump=${maxJumpA.toFixed(4)} > ${jumpLim.toFixed(4)}`);
        assert.equal(hitsA, 0, `1a dt=${dt} hits=${hitsA}`);

        // 1b. dockCharge("CH1") -> pickFromStand("S1")
        mgr.stands.get("S1").setCargoWcid(4000012);
        const amrB = mgr.spawnAmr("t5b19-1b", { pos: [ox - 14, oy - 31, 0], heading: Math.PI });
        await stepUntilSettled(() => mgr.tick(dt), amrB.enqueue({ type: "dockCharge", chargerId: "CH1" }), maxSteps);
        let maxJumpB = 0, hitsB = 0; px = amrB.x; py = amrB.y;
        await stepUntilSettled(() => {
          mgr.tick(dt);
          maxJumpB = Math.max(maxJumpB, Math.hypot(amrB.x - px, amrB.y - py));
          px = amrB.x; py = amrB.y;
          if (amrB.y > oy - 37.0) hitsB += checkAmrHits(amrB, ch1Obb);
        }, amrB.enqueue({ type: "pickFromStand", standId: "S1" }), maxSteps);
        assert.ok(maxJumpB <= jumpLim, `1b dt=${dt} maxJump=${maxJumpB.toFixed(4)} > ${jumpLim.toFixed(4)}`);
        assert.equal(hitsB, 0, `1b dt=${dt} ch1Hits=${hitsB}`);
        assert.equal(amrB.carriedWcid, 4000012);

        // 1c. dockCharge("CH1") -> dockCharge("CH2") -> driveTo([ox-10, oy-36.80])
        const amrC = mgr.spawnAmr("t5b19-1c", { pos: [ox - 14, oy - 31, 0], heading: Math.PI });
        await stepUntilSettled(() => mgr.tick(dt), amrC.enqueue({ type: "dockCharge", chargerId: "CH1" }), maxSteps);
        let maxJumpC = 0, hitsC = 0; px = amrC.x; py = amrC.y;
        await stepUntilSettled(() => {
          mgr.tick(dt);
          maxJumpC = Math.max(maxJumpC, Math.hypot(amrC.x - px, amrC.y - py));
          px = amrC.x; py = amrC.y;
          if (amrC.y > oy - 37.0) hitsC += checkAmrHits(amrC, ch1Obb);
          hitsC += checkAmrHits(amrC, nonChObbs);
        }, amrC.enqueue({ type: "dockCharge", chargerId: "CH2" }), maxSteps);
        assert.ok(maxJumpC <= jumpLim, `1c dt=${dt} maxJump=${maxJumpC.toFixed(4)} > ${jumpLim.toFixed(4)}`);
        assert.equal(hitsC, 0, `1c dt=${dt} hits=${hitsC}`);

        // Depart CH2 cleanly to [ox-10, oy-36.80]
        let maxJumpC2 = 0, hitsC2 = 0; px = amrC.x; py = amrC.y;
        await stepUntilSettled(() => {
          mgr.tick(dt);
          maxJumpC2 = Math.max(maxJumpC2, Math.hypot(amrC.x - px, amrC.y - py));
          px = amrC.x; py = amrC.y;
          if (amrC.y > oy - 37.0) hitsC2 += checkAmrHits(amrC, ch2Obb);
          hitsC2 += checkAmrHits(amrC, nonChObbs);
        }, amrC.enqueue({ type: "driveTo", waypoints: [[ox - 10, oy - 36.80]] }), maxSteps);
        assert.ok(maxJumpC2 <= jumpLim, `1c-dep dt=${dt} maxJump=${maxJumpC2.toFixed(4)} > ${jumpLim.toFixed(4)}`);
        assert.equal(hitsC2, 0, `1c-dep dt=${dt} hits=${hitsC2}`);

        // 1d. dockCharge("CH1") -> driveTo([ox-10, oy-37.38]) rejects cleanly without hanging or teleporting
        const amrD = mgr.spawnAmr("t5b19-1d", { pos: [ox - 14, oy - 31, 0], heading: Math.PI });
        await stepUntilSettled(() => mgr.tick(dt), amrD.enqueue({ type: "dockCharge", chargerId: "CH1" }), maxSteps);
        let err1d = null, maxJumpD = 0; px = amrD.x; py = amrD.y;
        await assert.rejects(async () => {
          await stepUntilSettled(() => {
            mgr.tick(dt);
            maxJumpD = Math.max(maxJumpD, Math.hypot(amrD.x - px, amrD.y - py));
            px = amrD.x; py = amrD.y;
          }, amrD.enqueue({ type: "driveTo", waypoints: [[ox - 10, oy - 37.38]] }).catch((e) => { err1d = e; throw e; }), 300);
        }, /AMR route unreachable/);
        assert.ok(err1d && /AMR route unreachable/.test(err1d.message));
        assert.ok(maxJumpD <= jumpLim, `1d dt=${dt} maxJump=${maxJumpD.toFixed(4)}`);
      } finally {
        mgr.dispose();
      }
    }

    // Bug 2: AMR pickFromStand("L1") & placeOnStand("L1") with lt1.lower() mid-route
    {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const lt1 = mgr.liftTables.get("L1");
      lt1.setAutoMode(false);
      try {
        await stepUntilSettled(() => mgr.tick(dt), lt1.raise(), 1000);
        lt1.setCargoWcid(4000014);
        const amrPick = mgr.spawnAmr("t5b19-b2p", { pos: [ox - 20, oy - 29, 0], heading: -Math.PI * 0.5 });
        let errPick = null;
        await assert.rejects(async () => {
          await stepUntilSettled((i) => {
            mgr.tick(dt);
            if (i === (dt < 0.025 ? 60 : 30)) void lt1.lower().catch(() => {});
          }, amrPick.enqueue({ type: "pickFromStand", standId: "L1" }).catch((e) => { errPick = e; throw e; }), maxSteps);
        }, /not raised/i);
        assert.ok(errPick && /not raised/i.test(errPick.message));
        assert.equal(amrPick.carriedWcid, 0);
        assert.equal(lt1.carriedWcid, 4000014);

        lt1.setCargoWcid(0);
        await stepUntilSettled(() => mgr.tick(dt), lt1.raise(), 1000);
        const amrPlace = mgr.spawnAmr("t5b19-b2pl", { pos: [ox - 20, oy - 29, 0], heading: -Math.PI * 0.5, carriedWcid: 4000012 });
        let errPlace = null;
        await assert.rejects(async () => {
          await stepUntilSettled((i) => {
            mgr.tick(dt);
            if (i === (dt < 0.025 ? 60 : 30)) void lt1.lower().catch(() => {});
          }, amrPlace.enqueue({ type: "placeOnStand", standId: "L1" }).catch((e) => { errPlace = e; throw e; }), maxSteps);
        }, /not raised/i);
        assert.ok(errPlace && /not raised/i.test(errPlace.message));
        assert.equal(amrPlace.carriedWcid, 4000012);
        assert.equal(lt1.carriedWcid, 0);
      } finally {
        mgr.dispose();
      }
    }

    // Bug 3: AGF placeOnStand("L1") & pickFromStand("L1") with lt1.raise() mid-route
    {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const lt1 = mgr.liftTables.get("L1");
      lt1.setAutoMode(false);
      try {
        const agf = mgr.spawnAgf("t5b19-b3", { pos: [ox - 20, oy + 20, 0], heading: Math.PI, carriedWcid: 4000012 });
        let dropForkZ = null;
        await stepUntilSettled((i) => {
          mgr.tick(dt);
          if (i === (dt < 0.025 ? 30 : 15)) void lt1.raise().catch(() => {});
          if (lt1.carriedWcid === 4000012 && dropForkZ === null) dropForkZ = agf.forkHeightM;
        }, agf.enqueue({ type: "placeOnStand", standId: "L1" }), maxSteps);
        assert.ok(dropForkZ !== null && dropForkZ >= 0.380, `Bug3 place dropForkZ=${dropForkZ} < 0.380`);
        assert.equal(lt1.carriedWcid, 4000012);

        await stepUntilSettled(() => mgr.tick(dt), agf.enqueue({ type: "driveTo", waypoints: [[ox - 40, oy + 20]] }), maxSteps);
        await stepUntilSettled(() => mgr.tick(dt), lt1.lower(), 1000);
        let pickForkZ = null;
        await stepUntilSettled((i) => {
          mgr.tick(dt);
          if (i === (dt < 0.025 ? 30 : 15)) void lt1.raise().catch(() => {});
          if (agf.carriedWcid === 4000012 && pickForkZ === null) pickForkZ = agf.forkHeightM;
        }, agf.enqueue({ type: "pickFromStand", standId: "L1" }), maxSteps);
        assert.ok(pickForkZ !== null && pickForkZ >= 0.380, `Bug3 pick pickForkZ=${pickForkZ} < 0.380`);
        assert.equal(agf.carriedWcid, 4000012);
      } finally {
        mgr.dispose();
      }
    }

    // Bug 4: AMR driveTo into sealed 4-container enclosure rejects /AMR route unreachable/ cleanly without hanging
    {
      for (const extra of [
        [
          { guid: 99021, kind: 11, pos: [ox + 25, oy - 30, 0], heading: 0 },
          { guid: 99022, kind: 11, pos: [ox + 28, oy - 30, 0], heading: 0 },
          { guid: 99023, kind: 11, pos: [ox + 26.5, oy - 23.5, 0], heading: Math.PI * 0.5 },
          { guid: 99024, kind: 11, pos: [ox + 26.5, oy - 36.5, 0], heading: Math.PI * 0.5 },
        ],
        [
          { guid: 99031, kind: 11, pos: [ox + 23.5, oy - 30, 0], heading: 0 },
          { guid: 99032, kind: 11, pos: [ox + 29.5, oy - 30, 0], heading: 0 },
          { guid: 99033, kind: 11, pos: [ox + 26.5, oy - 23.5, 0], heading: Math.PI * 0.5 },
          { guid: 99034, kind: 11, pos: [ox + 26.5, oy - 36.5, 0], heading: Math.PI * 0.5 },
        ],
      ]) {
        const cMap = makeDefaultContainers(extra);
        const rig = makeRig();
        const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
        mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
        try {
          const amr = mgr.spawnAmr("t5b19-b4", { pos: [ox + 15, oy - 30, 0], heading: Math.PI * 0.5 });
          let err4 = null;
          await assert.rejects(async () => {
            await stepUntilSettled(() => mgr.tick(dt), amr.enqueue({ type: "driveTo", waypoints: [[ox + 26.5, oy - 30]] }).catch((e) => { err4 = e; throw e; }), 300);
          }, /AMR route unreachable/);
          assert.ok(err4 && /AMR route unreachable/.test(err4.message));
        } finally {
          mgr.dispose();
        }
      }
    }
  }
});

test("B", "T5-B20 (challenger_10 Bugs A-C): LiftTable autoMode AGF clearance interlock (L1/L2), AGF pickFromRack empty-slot rejection & reservation, & TIGHT_0.58_1.2_20261221_9 open-south charger rescue across dt=1/60 & 1/30", async () => {
  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 8000 : 4000;

    // Bug A: L1/L2 autoMode=true holds while AGF fork tips are inside footprint, then raises/lowers cleanly after retract
    for (const lid of ["L1", "L2"]) {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const lt = mgr.liftTables.get(lid);
      lt.setAutoMode(true);
      try {
        const agf = mgr.spawnAgf(`t5b20-a-${lid}`, {
          pos: [lt.agfApproachPos[0] - 4, lt.agfApproachPos[1] + 6, 0],
          heading: Math.PI,
          carriedWcid: 4000012,
        });
        let maxHInside = 0;
        let sawInside = false;
        await stepUntilSettled(() => {
          mgr.tick(dt);
          const tipX = agf.x + Math.sin(agf.heading) * WS.AGF_SPECS.forkTipY;
          const tipY = agf.y + Math.cos(agf.heading) * WS.AGF_SPECS.forkTipY;
          if (Math.abs(tipX - lt.x) < 0.67 && Math.abs(tipY - lt.y) < 0.65) {
            sawInside = true;
            maxHInside = Math.max(maxHInside, lt.heightM);
          }
        }, agf.enqueue({ type: "placeOnStand", standId: lid }), maxSteps);
        assert.ok(sawInside, `BugA ${lid} dt=${dt}: AGF fork tips never entered footprint`);
        assert.ok(maxHInside <= 0.02, `BugA ${lid} dt=${dt}: lt raised to ${maxHInside.toFixed(4)} while AGF forks inside`);
        assert.equal(lt.carriedWcid, 4000012);
        for (let i = 0; i < (dt < 0.025 ? 400 : 200); i++) mgr.tick(dt);
        assert.ok(lt.heightM >= 0.380 - 0.005, `BugA ${lid} dt=${dt}: lt failed to auto-raise after retract (${lt.heightM.toFixed(4)})`);

        // Also verify pickFromStand with autoMode=true holds at >= 0.365 while AGF inside, then lowers cleanly after retract
        let minHInside = 1.0;
        let sawInsidePick = false;
        await stepUntilSettled(() => {
          mgr.tick(dt);
          const tipX = agf.x + Math.sin(agf.heading) * WS.AGF_SPECS.forkTipY;
          const tipY = agf.y + Math.cos(agf.heading) * WS.AGF_SPECS.forkTipY;
          if (Math.abs(tipX - lt.x) < 0.67 && Math.abs(tipY - lt.y) < 0.65) {
            sawInsidePick = true;
            minHInside = Math.min(minHInside, lt.heightM);
          }
        }, agf.enqueue({ type: "pickFromStand", standId: lid }), maxSteps);
        assert.ok(sawInsidePick, `BugA pick ${lid} dt=${dt}: AGF fork tips never entered footprint`);
        assert.ok(minHInside >= 0.365, `BugA pick ${lid} dt=${dt}: lt lowered to ${minHInside.toFixed(4)} while AGF forks inside`);
        assert.equal(agf.carriedWcid, 4000012);
        for (let i = 0; i < (dt < 0.025 ? 400 : 200); i++) mgr.tick(dt);
        assert.ok(lt.heightM <= 0.02, `BugA pick ${lid} dt=${dt}: lt failed to auto-lower after retract (${lt.heightM.toFixed(4)})`);
      } finally {
        mgr.dispose();
      }
    }

    // Bug B: pickFromRack mid-route empty-slot rejection + same-tick concurrent reservation
    {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      try {
        const r1 = mgr.racks.get("R1");
        r1.loadSlot(0, 1, 0, 0, 4000012);
        const agf = mgr.spawnAgf("t5b20-b1", { pos: [ox - 14, oy + 12, 0], heading: Math.PI });
        let rejErr = null;
        await assert.rejects(async () => {
          await stepUntilSettled((i) => {
            mgr.tick(dt);
            if (i === 30) r1.unloadSlot(0, 1, 0, 0);
          }, agf.enqueue({ type: "pickFromRack", rackId: "R1", bay: 0, tier: 1, side: 0, slotInBay: 0 }).catch((e) => { rejErr = e; throw e; }), maxSteps);
        }, /became empty/i);
        assert.ok(rejErr && /became empty/i.test(rejErr.message), `BugB dt=${dt}: expected /became empty/i, got ${rejErr?.message}`);
        assert.equal(agf.carriedWcid, 0, `BugB dt=${dt}: AGF carriedWcid must remain 0`);
        const endHit = checkAgfHits(agf, obbs);
        assert.equal(endHit.cornerHits + endHit.satHits, 0, `BugB dt=${dt}: expected 0 hits after abort_retract`);
      } finally {
        mgr.dispose();
      }
    }
    {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      try {
        const r1 = mgr.racks.get("R1");
        // Same-tick concurrent pickFromRack reservation
        r1.loadSlot(0, 0, 0, 1, 4000013);
        const a1 = mgr.spawnAgf("t5b20-conc-1", { pos: [ox - 14.55, oy + 3, 0], heading: 0 });
        const a2 = mgr.spawnAgf("t5b20-conc-2", { pos: [ox - 11.55, oy + 3, 0], heading: 0 });
        let r2Err = null;
        const p1 = a1.enqueue({ type: "pickFromRack", rackId: "R1", bay: 0, tier: 0, side: 0, slotInBay: 1 });
        const p2 = a2.enqueue({ type: "pickFromRack", rackId: "R1", bay: 0, tier: 0, side: 0, slotInBay: 1 }).catch((e) => { r2Err = e; });
        mgr.tick(dt);
        await p2;
        assert.ok(r2Err && /reserved/i.test(r2Err.message), `BugB conc dt=${dt}: expected reserved rejection, got ${r2Err?.message}`);
        assert.equal(a2.carriedWcid, 0);
        await stepUntilSettled(() => mgr.tick(dt), p1, maxSteps);
        assert.equal(a1.carriedWcid, 4000013, `BugB conc dt=${dt}: first AGF picked 4000013`);
      } finally {
        mgr.dispose();
      }
    }

    // Bug C: TIGHT_0.58_1.2_20261221_9 open-south charger rescue across wcid = 0 & 4000012 + CH2..CH8 h=1.85 & CH6 h=1.80,1.90
    {
      const chExtraCases = [];
      for (const [cid, chX] of [["CH2", -10], ["CH3", -6], ["CH4", -2], ["CH5", 2], ["CH6", 6], ["CH7", 10], ["CH8", 14]]) {
        chExtraCases.push([`${cid}_1.85`, chX, 1.85]);
      }
      chExtraCases.push(["CH6_1.80", 6, 1.80], ["CH6_1.90", 6, 1.90], ["CH6_1.962", 6, 1.962]);
      for (const [label, chX, hVal] of chExtraCases) {
        for (const wcid of [0, 4000012]) {
          const cMap = makeDefaultContainers();
          const rig = makeRig();
          const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
          mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
          const obbs = getObbs(mgr, cMap);
          try {
            const agf = mgr.spawnAgf(`t5b20-c-${label}-${wcid}`, { pos: [ox + chX - 1.092, oy - 38.924, 0], heading: hVal, carriedWcid: wcid });
            const t0 = checkAgfHits(agf, obbs);
            assert.equal(t0.cornerHits + t0.satHits, 0, `BugC ${label} w=${wcid} dt=${dt}: t=0 hits`);
            let hits = 0;
            await stepUntilSettled(() => {
              mgr.tick(dt);
              const h = checkAgfHits(agf, obbs);
              hits += h.cornerHits + h.satHits;
            }, agf.enqueue({ type: "driveTo", waypoints: [[ox - 5.662, oy + 6.745]] }), dt < 0.025 ? 12000 : 6000);
            assert.equal(hits, 0, `BugC ${label} w=${wcid} dt=${dt}: hits=${hits}`);
            const dEnd = Math.hypot(agf.x - (ox - 5.662), agf.y - (oy + 6.745));
            assert.ok(dEnd <= 0.15, `BugC ${label} w=${wcid} dt=${dt}: dEnd=${dEnd.toFixed(3)}`);
            const ex = agf.x, ey = agf.y;
            for (let i = 0; i < 60; i++) mgr.tick(dt);
            assert.ok(Math.hypot(agf.x - ex, agf.y - ey) <= 1e-4, `BugC ${label} w=${wcid} dt=${dt}: idle drift`);
          } finally {
            mgr.dispose();
          }
        }
      }
    }
  }
});

test("B", "T5-B21 (challenger_11 Bugs 1-3): Sibling AGF mid-insert abort_retract (placeInRack, placeOnStand/pickFromStand S1/L1, pickFromContainer/loadIntoContainer C3) + concurrent stand reservation, AMR mid-enter stand abort_exit & reservation, & 20261239 #15 tight stand-gap rescue across dt=1/60 & 1/30", async () => {
  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 8000 : 4000;
    const jumpLim = 3.5 * dt + 0.05;

    // Bug 1a: placeInRack mid-insert occupied -> abort_retract cleanly
    {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      try {
        const r1 = mgr.racks.get("R1");
        const agf = mgr.spawnAgf("t5b21-pir", { pos: [ox - 14, oy + 12, 0], heading: Math.PI, carriedWcid: 4000012 });
        let mutated = false, rejErr = null, maxJump = 0;
        let px = agf.x, py = agf.y;
        await assert.rejects(async () => {
          await stepUntilSettled(() => {
            mgr.tick(dt);
            maxJump = Math.max(maxJump, Math.hypot(agf.x - px, agf.y - py));
            px = agf.x; py = agf.y;
            if (!mutated && agf.forkHeightM > 1.2 && agf.y < oy + 10.5) {
              mutated = true;
              r1.loadSlot(0, 1, 0, 0, 4000013);
            }
          }, agf.enqueue({ type: "placeInRack", rackId: "R1", bay: 0, tier: 1, side: 0, slotInBay: 0 }).catch((e) => { rejErr = e; throw e; }), maxSteps);
        }, /occupied/i);
        assert.ok(rejErr && /occupied/i.test(rejErr.message), `placeInRack dt=${dt}: ${rejErr?.message}`);
        assert.ok(maxJump <= jumpLim, `placeInRack dt=${dt}: maxJump=${maxJump.toFixed(4)} > ${jumpLim.toFixed(4)}`);
        const postHit = checkAgfHits(agf, obbs);
        assert.equal(postHit.cornerHits + postHit.satHits, 0, `placeInRack dt=${dt}: postHits=${postHit.cornerHits + postHit.satHits}`);
        assert.equal(agf.carriedWcid, 4000012);
      } finally {
        mgr.dispose();
      }
    }

    // Bug 1b: placeOnStand & pickFromStand on S1 & L1 mid-insert -> abort_retract cleanly
    for (const sid of ["S1", "L1"]) {
      for (const op of ["placeOnStand", "pickFromStand"]) {
        const cMap = makeDefaultContainers();
        const rig = makeRig();
        const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
        mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
        const obbs = getObbs(mgr, cMap);
        try {
          const target = mgr.stands.get(sid) || mgr.liftTables.get(sid);
          if (op === "pickFromStand") target.setCargoWcid(4000015);
          const agf = mgr.spawnAgf(`t5b21-${op}-${sid}`, {
            pos: [target.agfApproachPos[0] - 4, target.agfApproachPos[1] + 6, 0],
            heading: Math.PI,
            carriedWcid: op === "placeOnStand" ? 4000012 : 0,
          });
          let mutated = false, rejErr = null, maxJump = 0;
          let px = agf.x, py = agf.y;
          const rx = op === "placeOnStand" ? /occupied/i : /empty/i;
          await assert.rejects(async () => {
            await stepUntilSettled(() => {
              mgr.tick(dt);
              maxJump = Math.max(maxJump, Math.hypot(agf.x - px, agf.y - py));
              px = agf.x; py = agf.y;
              if (!mutated && Math.hypot(agf.x - target.pos[0], agf.y - target.pos[1]) < 1.05) {
                mutated = true;
                target.setCargoWcid(op === "placeOnStand" ? 4000015 : 0);
              }
            }, agf.enqueue({ type: op, standId: sid }).catch((e) => { rejErr = e; throw e; }), maxSteps);
          }, rx);
          assert.ok(rejErr && rx.test(rejErr.message), `${op} ${sid} dt=${dt}: ${rejErr?.message}`);
          assert.ok(maxJump <= jumpLim, `${op} ${sid} dt=${dt}: maxJump=${maxJump.toFixed(4)} > ${jumpLim.toFixed(4)}`);
          const postHit = checkAgfHits(agf, obbs);
          assert.equal(postHit.cornerHits + postHit.satHits, 0, `${op} ${sid} dt=${dt}: postHits=${postHit.cornerHits + postHit.satHits}`);
          assert.equal(agf.carriedWcid, op === "placeOnStand" ? 4000012 : 0);
        } finally {
          mgr.dispose();
        }
      }
    }

    // Bug 1c: pickFromContainer & loadIntoContainer on C3 mid-enter -> abort_retract cleanly
    for (const op of ["pickFromContainer", "loadIntoContainer"]) {
      const cMap = makeDefaultContainers();
      const c3 = cMap.get(38147);
      c3.slots = op === "pickFromContainer" ? [{ slotIndex: 8, palletSize: "full", cargoWcid: 4000012 }] : [];
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      try {
        const agf = mgr.spawnAgf(`t5b21-${op}-c3`, { pos: [ox - 8, oy + 20, 0], heading: 0, carriedWcid: op === "loadIntoContainer" ? 4000012 : 0 });
        let mutated = false, rejErr = null, maxJump = 0;
        let px = agf.x, py = agf.y;
        const rx = op === "pickFromContainer" ? /slot_empty/i : /slot_occupied/i;
        await assert.rejects(async () => {
          await stepUntilSettled(() => {
            mgr.tick(dt);
            maxJump = Math.max(maxJump, Math.hypot(agf.x - px, agf.y - py));
            px = agf.x; py = agf.y;
            if (!mutated && agf.y > oy + 26.2) {
              mutated = true;
              c3.slots = op === "pickFromContainer" ? [] : [{ slotIndex: 8, palletSize: "full", cargoWcid: 4000015 }];
            }
          }, agf.enqueue({ type: op, containerGuid: 38147, slotIndex: 8 }).catch((e) => { rejErr = e; throw e; }), maxSteps);
        }, rx);
        assert.ok(rejErr && rx.test(rejErr.message), `${op} C3 dt=${dt}: ${rejErr?.message}`);
        assert.ok(maxJump <= jumpLim, `${op} C3 dt=${dt}: maxJump=${maxJump.toFixed(4)} > ${jumpLim.toFixed(4)}`);
        const postHit = checkAgfHits(agf, obbs);
        assert.equal(postHit.cornerHits + postHit.satHits, 0, `${op} C3 dt=${dt}: postHits=${postHit.cornerHits + postHit.satHits}`);
        assert.equal(agf.carriedWcid, op === "loadIntoContainer" ? 4000012 : 0);
      } finally {
        mgr.dispose();
      }
    }

    // Bug 1d + Bug 2: AGF & AMR concurrent stand reservation + AMR mid-enter S1 abort_exit
    {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      try {
        const s1 = mgr.stands.get("S1");
        s1.setCargoWcid(4000012);
        const a1 = mgr.spawnAgf("t5b21-agf-r1", { pos: [s1.agfApproachPos[0] - 2, s1.agfApproachPos[1] + 5, 0], heading: Math.PI });
        const a2 = mgr.spawnAgf("t5b21-agf-r2", { pos: [s1.agfApproachPos[0] + 2, s1.agfApproachPos[1] + 5, 0], heading: Math.PI });
        let agfResErr = null;
        const pA1 = a1.enqueue({ type: "pickFromStand", standId: "S1" });
        const pA2 = a2.enqueue({ type: "pickFromStand", standId: "S1" }).catch((e) => { agfResErr = e; });
        mgr.tick(dt);
        await pA2;
        assert.ok(agfResErr && /reserved/i.test(agfResErr.message), `AGF concurrent stand dt=${dt}: ${agfResErr?.message}`);
        await stepUntilSettled(() => mgr.tick(dt), pA1, maxSteps);
        assert.equal(a1.carriedWcid, 4000012);

        // AMR concurrent reservation
        s1.setCargoWcid(4000013);
        const m1 = mgr.spawnAmr("t5b21-amr-r1", { pos: [s1.amrApproachPos[0], s1.amrApproachPos[1] - 2.0, 0], heading: 0 });
        const m2 = mgr.spawnAmr("t5b21-amr-r2", { pos: [s1.amrApproachPos[0] + 2.0, s1.amrApproachPos[1] - 2.0, 0], heading: 0 });
        let amrResErr = null;
        const pM1 = m1.enqueue({ type: "pickFromStand", standId: "S1" });
        const pM2 = m2.enqueue({ type: "pickFromStand", standId: "S1" }).catch((e) => { amrResErr = e; });
        mgr.tick(dt);
        await pM2;
        assert.ok(amrResErr && /reserved/i.test(amrResErr.message), `AMR concurrent stand dt=${dt}: ${amrResErr?.message}`);
        await stepUntilSettled(() => mgr.tick(dt), pM1, maxSteps);
        assert.equal(m1.carriedWcid, 4000013);
      } finally {
        mgr.dispose();
      }
    }

    // Bug 2: AMR mid-enter S1 abort_exit for placeOnStand & pickFromStand
    for (const op of ["placeOnStand", "pickFromStand"]) {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      try {
        const s1 = mgr.stands.get("S1");
        if (op === "pickFromStand") s1.setCargoWcid(4000013);
        const amr = mgr.spawnAmr(`t5b21-amr-${op}`, {
          pos: [s1.amrApproachPos[0], s1.amrApproachPos[1] - 2.0, 0],
          heading: 0,
          carriedWcid: op === "placeOnStand" ? 4000014 : 0,
        });
        let mutated = false, rejErr = null;
        const rx = op === "placeOnStand" ? /occupied/i : /empty/i;
        await assert.rejects(async () => {
          await stepUntilSettled(() => {
            mgr.tick(dt);
            if (!mutated && Math.hypot(amr.x - s1.pos[0], amr.y - s1.pos[1]) < 0.25) {
              mutated = true;
              s1.setCargoWcid(op === "placeOnStand" ? 4000015 : 0);
            }
          }, amr.enqueue({ type: op, standId: "S1" }).catch((e) => { rejErr = e; throw e; }), maxSteps);
        }, rx);
        assert.ok(rejErr && rx.test(rejErr.message), `AMR ${op} dt=${dt}: ${rejErr?.message}`);
        assert.ok(Math.hypot(amr.x - s1.pos[0], amr.y - s1.pos[1]) >= 1.4, `AMR ${op} dt=${dt} backed out to exitPose`);
      } finally {
        mgr.dispose();
      }
    }

    // Bug 3: unseen seed 20261239 #15 tight stand-gap rescue across wcid = 0 & 4000012
    for (const wcid of [0, 4000012]) {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      try {
        const agf = mgr.spawnAgf(`t5b21-b3-${wcid}`, { pos: [ox + 14.701, oy - 24.995, 0], heading: 3.478, carriedWcid: wcid });
        const t0 = checkAgfHits(agf, obbs);
        assert.equal(t0.cornerHits + t0.satHits, 0, `Bug3 w=${wcid} dt=${dt}: t=0 hits`);
        let hits = 0;
        await stepUntilSettled(() => {
          mgr.tick(dt);
          const h = checkAgfHits(agf, obbs);
          hits += h.cornerHits + h.satHits;
        }, agf.enqueue({ type: "driveTo", waypoints: [[ox + 15.359, oy + 21.825]] }), dt < 0.025 ? 12000 : 6000);
        assert.equal(hits, 0, `Bug3 w=${wcid} dt=${dt}: hits=${hits}`);
        const dEnd = Math.hypot(agf.x - (ox + 15.359), agf.y - (oy + 21.825));
        assert.ok(dEnd <= 0.15, `Bug3 w=${wcid} dt=${dt}: dEnd=${dEnd.toFixed(3)}`);
      } finally {
        mgr.dispose();
      }
    }
  }
});


test("B", "T5-B22 (challenger_12 Bugs 1-3 + reviewer_11 rack abort + challenger_13 idle-on-dock & container-delete): Container unavailability/deletion across C1/C2/C3, idle-on-dock charger reservation/departure, concurrent reservations, & 20261242_k1 across dt=1/60 & 1/30", async () => {
  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 8000 : 4000;
    const jumpLim = 3.5 * dt + 0.05;

    // Bug 1: Container "route" && kin.arrived unavailability -> abort_retract cleanly (24/24 matrix)
    const cSpecs = [
      { guid: 38145, label: "C1", halfExtL: 6.096, slotIndex: 18 },
      { guid: 38146, label: "C2", halfExtL: 6.096, slotIndex: 18 },
      { guid: 38147, label: "C3", halfExtL: 3.029, slotIndex: 8 },
    ];
    for (const cs of cSpecs) {
      for (const op of ["pickFromContainer", "loadIntoContainer"]) {
        for (const mutKind of ["doorClose", "trailerMount"]) {
          const cMap = makeDefaultContainers();
          const ce = cMap.get(cs.guid);
          ce.slots = op === "pickFromContainer"
            ? [{ slotIndex: cs.slotIndex, palletSize: "full", cargoWcid: 4000012 }]
            : [];
          const rig = makeRig();
          const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
          mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
          const obbs = getObbs(mgr, cMap);
          try {
            const agf = mgr.spawnAgf(`t5b22-${cs.label}-${op}-${mutKind}`, {
              pos: [ce.rawPos[0], oy + 20, 0],
              heading: 0,
              carriedWcid: op === "loadIntoContainer" ? 4000012 : 0,
            });
            let mutated = false, rejErr = null, maxJump = 0;
            let px = agf.x, py = agf.y;
            await assert.rejects(async () => {
              await stepUntilSettled(() => {
                mgr.tick(dt);
                maxJump = Math.max(maxJump, Math.hypot(agf.x - px, agf.y - py));
                px = agf.x; py = agf.y;
                if (!mutated && agf.y > ce.rawPos[1] - cs.halfExtL - 1.5) {
                  mutated = true;
                  if (mutKind === "doorClose") ce.currentDoorProgress = 0;
                  else ce.mountedOnTrailerGuid = 999;
                }
              }, agf.enqueue({ type: op, containerGuid: cs.guid, slotIndex: cs.slotIndex }).catch((e) => { rejErr = e; throw e; }), maxSteps);
            }, /unavailable/i);
            assert.ok(mutated, `${cs.label} ${op} ${mutKind} dt=${dt}: mutation triggered`);
            assert.ok(rejErr && /unavailable/i.test(rejErr.message), `${cs.label} ${op} ${mutKind} dt=${dt}: ${rejErr?.message}`);
            assert.ok(maxJump <= jumpLim, `${cs.label} ${op} ${mutKind} dt=${dt}: maxJump=${maxJump.toFixed(4)}`);
            const postHit = checkAgfHits(agf, obbs);
            assert.equal(postHit.cornerHits + postHit.satHits, 0, `${cs.label} ${op} ${mutKind} dt=${dt}: postHits=${postHit.cornerHits + postHit.satHits}`);
            assert.equal(agf.carriedWcid, op === "loadIntoContainer" ? 4000012 : 0);
          } finally {
            mgr.dispose();
          }
        }
      }
    }

    // Reviewer 11 minor check: placeInRack abort_retract cleanly restores transit forkHeightM
    {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      try {
        const r1 = mgr.racks.get("R1");
        const agf = mgr.spawnAgf("t5b22-rack-fork", { pos: [ox - 14, oy + 12, 0], heading: Math.PI, carriedWcid: 4000012 });
        let mutated = false;
        await assert.rejects(async () => {
          await stepUntilSettled(() => {
            mgr.tick(dt);
            if (!mutated && agf.forkHeightM > 1.2 && agf.y < oy + 10.5) {
              mutated = true;
              r1.loadSlot(0, 1, 0, 0, 4000013);
            }
          }, agf.enqueue({ type: "placeInRack", rackId: "R1", bay: 0, tier: 1, side: 0, slotInBay: 0 }), maxSteps);
        }, /occupied/i);
        assert.ok(agf.forkHeightM <= 0.30, `rack abort_retract forkHeightM=${agf.forkHeightM.toFixed(3)} restored to transit`);
      } finally {
        mgr.dispose();
      }
    }

    // Bug 2a: Concurrent container reservations (same slot & distinct slots on same container)
    for (const [op1, op2, s1, s2] of [
      ["pickFromContainer", "pickFromContainer", 8, 8],
      ["pickFromContainer", "loadIntoContainer", 8, 7],
      ["loadIntoContainer", "loadIntoContainer", 8, 7],
    ]) {
      const cMap = makeDefaultContainers();
      const c3 = cMap.get(38147);
      c3.slots = op1 === "pickFromContainer" ? [{ slotIndex: 8, palletSize: "full", cargoWcid: 4000012 }] : [];
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      try {
        const a1 = mgr.spawnAgf("t5b22-c-a1", { pos: [ox - 8, oy + 20, 0], heading: 0, carriedWcid: op1 === "loadIntoContainer" ? 4000012 : 0 });
        const a2 = mgr.spawnAgf("t5b22-c-a2", { pos: [ox - 12, oy + 20, 0], heading: 0, carriedWcid: op2 === "loadIntoContainer" ? 4000013 : 0 });
        let r2Err = null;
        const p1 = a1.enqueue({ type: op1, containerGuid: 38147, slotIndex: s1 });
        const p2 = a2.enqueue({ type: op2, containerGuid: 38147, slotIndex: s2 }).catch((e) => { r2Err = e; });
        mgr.tick(dt);
        await p2;
        assert.ok(r2Err && /reserved/i.test(r2Err.message), `Container conc ${op1}/${op2} dt=${dt}: ${r2Err?.message}`);
        await stepUntilSettled(() => mgr.tick(dt), p1, maxSteps);
        assert.equal(a1.carriedWcid, op1 === "pickFromContainer" ? 4000012 : 0);
      } finally {
        mgr.dispose();
      }
    }

    // Bug 2b: Concurrent charger reservations (both in-flight and already-docked)
    {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      try {
        const m1 = mgr.spawnAmr("t5b22-ch-m1", { pos: [ox - 14, oy - 32, 0], heading: 0 });
        const m2 = mgr.spawnAmr("t5b22-ch-m2", { pos: [ox - 10, oy - 32, 0], heading: 0 });
        let r2Err = null;
        const p1 = m1.enqueue({ type: "dockCharge", chargerId: "CH1" });
        const p2 = m2.enqueue({ type: "dockCharge", chargerId: "CH1" }).catch((e) => { r2Err = e; });
        mgr.tick(dt);
        await p2;
        assert.ok(r2Err && /reserved/i.test(r2Err.message), `Charger inflight conc dt=${dt}: ${r2Err?.message}`);
        await stepUntilSettled(() => mgr.tick(dt), p1, maxSteps);
        assert.equal(m1.statusMode, "charging");
        assert.equal(mgr.chargers.get("CH1").mode, "charging");

        let r3Err = null;
        const p3 = m2.enqueue({ type: "dockCharge", chargerId: "CH1" }).catch((e) => { r3Err = e; });
        mgr.tick(dt);
        await p3;
        assert.ok(r3Err && /reserved/i.test(r3Err.message), `Charger docked conc dt=${dt}: ${r3Err?.message}`);
      } finally {
        mgr.dispose();
      }
    }

    // Bug 2c: Concurrent ground deployable reservations
    {
      const cMap = makeDefaultContainers();
      const dMap = new Map();
      const dGuid = 0x88000001;
      dMap.set(dGuid, {
        guid: dGuid,
        wcid: 4000012,
        rawPos: [ox - 30, oy + 10, 0],
        model: { root: { position: { x: ox - 30, y: oy + 10, z: 0 } } },
      });
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: dMap, palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      try {
        const a1 = mgr.spawnAgf("t5b22-gd-a1", { pos: [ox - 30, oy + 5, 0], heading: 0 });
        const a2 = mgr.spawnAgf("t5b22-gd-a2", { pos: [ox - 27, oy + 5, 0], heading: 0 });
        let r2Err = null;
        const p1 = a1.enqueue({ type: "pickGroundDeployable", deployableGuid: dGuid });
        const p2 = a2.enqueue({ type: "pickGroundDeployable", deployableGuid: dGuid }).catch((e) => { r2Err = e; });
        mgr.tick(dt);
        await p2;
        assert.ok(r2Err && /reserved/i.test(r2Err.message), `Ground deployable conc dt=${dt}: ${r2Err?.message}`);
        await stepUntilSettled(() => mgr.tick(dt), p1, maxSteps);
        assert.equal(a1.carriedWcid, 4000012);
      } finally {
        mgr.dispose();
      }
    }

    // Bug 3: Unseen tight seed 20261242_k1 (67.3 mm clear of C3) straight-reverse rescue across wcid = 0 & 4000012
    for (const wcid of [0, 4000012]) {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      try {
        const agf = mgr.spawnAgf(`t5b22-k1-${wcid}`, { pos: [ox - 8.1155, oy + 25.7252, 0], heading: 4.9717, carriedWcid: wcid });
        const t0 = checkAgfHits(agf, obbs);
        assert.equal(t0.cornerHits + t0.satHits, 0, `20261242_k1 w=${wcid} dt=${dt}: t=0 hits`);
        let hits = 0;
        await stepUntilSettled(() => {
          mgr.tick(dt);
          const h = checkAgfHits(agf, obbs);
          hits += h.cornerHits + h.satHits;
        }, agf.enqueue({ type: "driveTo", waypoints: [[ox - 32.8136, oy - 30.4816]] }), dt < 0.025 ? 12000 : 6000);
        assert.equal(hits, 0, `20261242_k1 w=${wcid} dt=${dt}: hits=${hits}`);
        const dEnd = Math.hypot(agf.x - (ox - 32.8136), agf.y - (oy - 30.4816));
        assert.ok(dEnd <= 0.15, `20261242_k1 w=${wcid} dt=${dt}: dEnd=${dEnd.toFixed(3)}`);
      } finally {
        mgr.dispose();
      }
    }

    // Challenger 13 Bug 1: Idle-on-dock AMR at CH1 stays un-pushed, reserves CH1, departs cleanly on driveTo, and allows subsequent dockCharge
    {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      try {
        const ch1 = mgr.chargers.get("CH1");
        const m1 = mgr.spawnAmr("t5b22-idle-dock", { pos: [...ch1.dockPos], heading: 0 });
        for (let i = 0; i < 10; i++) mgr.tick(dt);
        const drift = Math.hypot(m1.x - ch1.dockPos[0], m1.y - ch1.dockPos[1]);
        assert.ok(drift <= 1e-6, `Idle-on-dock drift=${drift.toFixed(4)} at dt=${dt}`);

        const m2 = mgr.spawnAmr("t5b22-idle-dock-contender", { pos: [ox - 10, oy - 32, 0], heading: 0 });
        let resErr = null;
        const pRej = m2.enqueue({ type: "dockCharge", chargerId: "CH1" }).catch((e) => { resErr = e; });
        mgr.tick(dt);
        await pRej;
        assert.ok(resErr && /reserved/i.test(resErr.message), `Idle-on-dock CH1 reservation dt=${dt}: ${resErr?.message}`);

        let maxJump = 0;
        let px = m1.x;
        let py = m1.y;
        await stepUntilSettled(() => {
          mgr.tick(dt);
          maxJump = Math.max(maxJump, Math.hypot(m1.x - px, m1.y - py));
          px = m1.x;
          py = m1.y;
        }, m1.enqueue({ type: "driveTo", waypoints: [[ox - 10, oy - 34]] }), maxSteps);
        assert.ok(maxJump <= jumpLim, `Idle-on-dock departure maxJump=${maxJump.toFixed(4)} at dt=${dt}`);

        await stepUntilSettled(() => mgr.tick(dt), m2.enqueue({ type: "dockCharge", chargerId: "CH1" }), maxSteps);
        assert.equal(m2.statusMode, "charging");
      } finally {
        mgr.dispose();
      }
    }

    // Challenger 13 Bug 2: Container deletion during "lower_enter" & "enter" across 12/12 C1/C2/C3 x pickFromContainer/loadIntoContainer x dt=1/60,1/30
    for (const delPhase of ["lower_enter", "enter"]) {
      for (const cs of cSpecs) {
        for (const op of ["pickFromContainer", "loadIntoContainer"]) {
          const cMap = makeDefaultContainers();
          const ce = cMap.get(cs.guid);
          const origSlots = op === "pickFromContainer"
            ? [{ slotIndex: cs.slotIndex, palletSize: "full", cargoWcid: 4000012 }]
            : [];
          ce.slots = origSlots.map((s) => ({ ...s }));
          const rig = makeRig();
          const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
          mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
          try {
            const agf = mgr.spawnAgf(`t5b22-del-${delPhase}-${cs.label}-${op}`, {
              pos: [ce.rawPos[0], oy + 20, 0],
              heading: 0,
              carriedWcid: op === "loadIntoContainer" ? 4000012 : 0,
            });
            let deleted = false;
            let rejErr = null;
            await assert.rejects(async () => {
              await stepUntilSettled(() => {
                mgr.tick(dt);
                if (!deleted) {
                  if (delPhase === "lower_enter" && agf.y > ce.rawPos[1] - cs.halfExtL - 0.85 && agf.y < ce.rawPos[1] - cs.halfExtL - 0.3) {
                    deleted = true;
                    cMap.delete(cs.guid);
                  } else if (delPhase === "enter" && agf.y > ce.rawPos[1] - cs.halfExtL - 0.2) {
                    deleted = true;
                    cMap.delete(cs.guid);
                  }
                }
              }, agf.enqueue({ type: op, containerGuid: cs.guid, slotIndex: cs.slotIndex }).catch((e) => { rejErr = e; throw e; }), maxSteps);
            }, /unavailable/i);
            assert.ok(deleted, `${delPhase} ${cs.label} ${op} dt=${dt}: deletion triggered`);
            assert.ok(rejErr && /unavailable/i.test(rejErr.message), `${delPhase} ${cs.label} ${op} dt=${dt}: ${rejErr?.message}`);
            assert.equal(agf.carriedWcid, op === "loadIntoContainer" ? 4000012 : 0, `${delPhase} ${cs.label} ${op} dt=${dt}: carriedWcid preserved`);
            assert.deepEqual(ce.slots, origSlots, `${delPhase} ${cs.label} ${op} dt=${dt}: orphaned slots preserved`);
            const postObbs = getObbs(mgr, cMap);
            let fHits = 0;
            await stepUntilSettled(() => {
              mgr.tick(dt);
              const h = checkAgfHits(agf, postObbs);
              fHits += h.cornerHits + h.satHits;
            }, agf.enqueue({ type: "driveTo", waypoints: [[ox - 24, oy + 14]] }), maxSteps);
            assert.equal(fHits, 0, `${delPhase} ${cs.label} ${op} dt=${dt}: follow-up driveTo hits=${fHits}`);
          } finally {
            mgr.dispose();
          }
        }
      }
    }
  }
});

test("B", "T5-B23 (challenger_14 Bugs 1-3): UNSEEN_AGFM_20261269_4 open-space multi-wp S6 SAT-OBB clearance, idle AMR >0.25m charger blocking (CH1..CH8), & idle AMR stand/liftTable blocking (S7/L1)", async () => {
  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 6000 : 3000;

    // Bug 1: UNSEEN_AGFM_20261269_4 open-space multi-waypoint driveTo clears S6(chassis) across wcid=0, 4000012
    for (const wcid of [0, 4000012]) {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      try {
        const agf = mgr.spawnAgf(`t5b23-agfm-${wcid}`, { pos: [ox + 29.0383, oy - 19.17, 0], heading: 2.0252, carriedWcid: wcid });
        const t0 = checkAgfHits(agf, obbs);
        assert.equal(t0.cornerHits + t0.satHits, 0, `UNSEEN_AGFM_20261269_4 w=${wcid} dt=${dt}: t=0 hits`);
        let hits = 0;
        await stepUntilSettled(() => {
          mgr.tick(dt);
          const h = checkAgfHits(agf, obbs);
          hits += h.cornerHits + h.satHits;
        }, agf.enqueue({
          type: "driveTo",
          waypoints: [[ox + 27.596, oy - 14.9623], [ox + 16.3141, oy - 8.6953]],
        }), maxSteps);
        assert.equal(hits, 0, `UNSEEN_AGFM_20261269_4 w=${wcid} dt=${dt}: hits=${hits}`);
        const dEnd = Math.hypot(agf.x - (ox + 16.3141), agf.y - (oy - 8.6953));
        assert.ok(dEnd <= 0.15, `UNSEEN_AGFM_20261269_4 w=${wcid} dt=${dt}: dEnd=${dEnd.toFixed(3)}`);
        const ex = agf.x;
        const ey = agf.y;
        for (let i = 0; i < 60; i++) mgr.tick(dt);
        assert.ok(Math.hypot(agf.x - ex, agf.y - ey) <= 1e-4, `UNSEEN_AGFM_20261269_4 w=${wcid} dt=${dt}: idle drift`);
      } finally {
        mgr.dispose();
      }
    }

    // Bug 2: Idle AMR outside 0.25 m of ch.dockPos across CH1..CH8 rejects dockCharge cleanly instead of hanging
    for (let ci = 1; ci <= 8; ci++) {
      const chId = `CH${ci}`;
      const offsets = ci <= 2
        ? [[0.26, 0], [0, 0.26], [0, -0.26], [0, 0.39], [0, 0.80]]
        : [[0.26, 0], [0, 0.80]];
      for (const off of offsets) {
        const cMap = makeDefaultContainers();
        const rig = makeRig();
        const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
        mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
        try {
          const ch = mgr.chargers.get(chId);
          mgr.spawnAmr(`t5b23-ch-blk-${chId}`, { pos: [ch.dockPos[0] + off[0], ch.dockPos[1] + off[1], 0], heading: 0 });
          const m2 = mgr.spawnAmr(`t5b23-ch-req-${chId}`, { pos: [ox - 10, oy - 32, 0], heading: 0 });
          let rejErr = null;
          await assert.rejects(async () => {
            await stepUntilSettled(() => mgr.tick(dt), m2.enqueue({ type: "dockCharge", chargerId: chId }).catch((e) => { rejErr = e; throw e; }), 300);
          }, /reserved|blocked/i);
          assert.ok(rejErr && /reserved|blocked/i.test(rejErr.message), `${chId} off=${off} dt=${dt}: ${rejErr?.message}`);
        } finally {
          mgr.dispose();
        }
      }
    }
    // Sibling charger CH2 remains usable when CH1 is blocked by idle AMR at +0.26 m
    {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      try {
        const ch1 = mgr.chargers.get("CH1");
        mgr.spawnAmr("t5b23-ch1-idle", { pos: [ch1.dockPos[0] + 0.26, ch1.dockPos[1], 0], heading: 0 });
        const m2 = mgr.spawnAmr("t5b23-ch2-ok", { pos: [ox - 10, oy - 32, 0], heading: 0 });
        await stepUntilSettled(() => mgr.tick(dt), m2.enqueue({ type: "dockCharge", chargerId: "CH2" }), maxSteps);
        assert.equal(m2.statusMode, "charging");
      } finally {
        mgr.dispose();
      }
    }

    // Bug 3: Idle AMR parked under/at Stand S7 or LiftTable L1 rejects pickFromStand/placeOnStand cleanly instead of hanging
    for (const id of ["S7", "L1"]) {
      for (const mode of ["pickFromStand", "placeOnStand"]) {
        for (const loc of ["under", "approach"]) {
          const cMap = makeDefaultContainers();
          const rig = makeRig();
          const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
          mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
          try {
            const target = mgr.stands.get(id) || mgr.liftTables.get(id);
            if (mgr.liftTables.has(id)) {
              target.setAutoMode(false);
              target.setHeightImmediate(WS.LIFT_TABLE_SPECS.raisedZ);
            }
            if (mode === "pickFromStand") target.setCargoWcid(4000012);
            const m1Pos = loc === "under" ? [...target.pos] : [...target.amrApproachPos];
            mgr.spawnAmr(`t5b23-st-blk-${id}`, { pos: m1Pos, heading: 0 });
            const m2 = mgr.spawnAmr(`t5b23-st-req-${id}`, { pos: [ox + 20, oy - 29, 0], heading: 0, carriedWcid: mode === "placeOnStand" ? 4000013 : 0 });
            let rejErr = null;
            await assert.rejects(async () => {
              await stepUntilSettled(() => mgr.tick(dt), m2.enqueue({ type: mode, standId: id }).catch((e) => { rejErr = e; throw e; }), 300);
            }, /reserved|blocked/i);
            assert.ok(rejErr && /reserved|blocked/i.test(rejErr.message), `${id} ${mode} ${loc} dt=${dt}: ${rejErr?.message}`);
          } finally {
            mgr.dispose();
          }
        }
      }
    }
    // Adjacent stand S2 remains usable when S1 has idle AMR, and AGF->AMR handoff on S7 still succeeds
    {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      try {
        const s1 = mgr.stands.get("S1");
        const s2 = mgr.stands.get("S2");
        s2.setCargoWcid(4000012);
        mgr.spawnAmr("t5b23-s1-idle", { pos: [...s1.pos], heading: Math.PI * 0.5 });
        const m2 = mgr.spawnAmr("t5b23-s2-ok", { pos: [ox + 20, oy - 29, 0], heading: 0 });
        await stepUntilSettled(() => mgr.tick(dt), m2.enqueue({ type: "pickFromStand", standId: "S2" }), maxSteps);
        assert.equal(m2.carriedWcid, 4000012);

        const agf = mgr.spawnAgf("t5b23-s7-agf", { pos: [ox - 16.5, oy - 16, 0], heading: Math.PI, carriedWcid: 4000014 });
        const amr = mgr.spawnAmr("t5b23-s7-amr", { pos: [ox - 16.5, oy - 29, 0], heading: 0 });
        await stepUntilSettled(() => mgr.tick(dt), agf.enqueue({ type: "placeOnStand", standId: "S7" }), maxSteps);
        await stepUntilSettled(() => mgr.tick(dt), amr.enqueue({ type: "pickFromStand", standId: "S7" }), maxSteps);
        assert.equal(amr.carriedWcid, 4000014);
      } finally {
        mgr.dispose();
      }
    }
  }
});


test("B", "T5-B24 (reviewer_14 F1/F2 & challenger_15 Bugs 1-2): 4WP/3WP_GAP<=0.30m coalescing + unreachable throw, cross-vehicle/active-driveTo/AGF blocking, open-lane non-blocking, & full charger pad", async () => {
  const AMR_CORNERS = [[-0.39, -0.52], [0.39, -0.52], [-0.39, 0.52], [0.39, 0.52]];
  const checkAmrHits = (amr, obbs) => {
    let hits = 0;
    for (const [lx, ly] of AMR_CORNERS) {
      const [wx, wy] = WS.localToWorld2D(lx, ly, amr.x, amr.y, amr.heading);
      for (const b of obbs) {
        const dx = wx - b.cx;
        const dy = wy - b.cy;
        const c = Math.cos(b.h);
        const s = Math.sin(b.h);
        if (Math.abs(dx * c - dy * s) < b.hw - 1e-4 && Math.abs(dx * s + dy * c) < b.hl - 1e-4) hits++;
      }
    }
    for (const b of obbs) if (satObbHit(amr.x, amr.y, amr.heading, 0.39, 0.52, b)) hits++;
    return hits;
  };

  // 1. Reviewer 14 Finding 1 & 2: DIAG_4WP & 3WP_GAP (0.05..2.0) across dt=1/60,1/30 & wcid=0,4000012 + unreachable throw
  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 6000 : 3000;
    for (const wcid of [0, 4000012]) {
      const wpSets = [
        ["DIAG_4WP", [[ox + 27.596, oy - 14.9623], [ox + 27.50, oy - 14.80], [ox + 16.3141, oy - 8.6953], [ox + 16.3141, oy - 12.60]]],
        ...[0.05, 0.18, 0.35, 0.60, 1.0, 2.0].map((g) => [
          `3WP_GAP_${g}`,
          [[ox + 27.596, oy - 14.9623], [ox + 27.596 - g * 0.5, oy - 14.9623 + g * 0.866], [ox + 16.3141, oy - 8.6953]],
        ]),
      ];
      for (const [label, wps] of wpSets) {
        const cMap = makeDefaultContainers();
        const rig = makeRig();
        const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
        mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
        const obbs = getObbs(mgr, cMap);
        try {
          const agf = mgr.spawnAgf(`t5b24-${label}-${wcid}`, { pos: [ox + 29.0383, oy - 19.17, 0], heading: 2.0252, carriedWcid: wcid });
          let hits = 0;
          await stepUntilSettled(() => {
            mgr.tick(dt);
            const h = checkAgfHits(agf, obbs);
            hits += h.cornerHits + h.satHits;
          }, agf.enqueue({ type: "driveTo", waypoints: wps }), maxSteps);
          assert.equal(hits, 0, `${label} w=${wcid} dt=${dt}: hits=${hits}`);
          const last = wps[wps.length - 1];
          assert.ok(Math.hypot(agf.x - last[0], agf.y - last[1]) <= 0.15, `${label} w=${wcid} dt=${dt}: arrival`);
        } finally {
          mgr.dispose();
        }
      }
    }
    // Colliding multi-wp route whose endpoint sits inside rack R1 must throw AGF route unreachable
    {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      try {
        const r1 = mgr.racks.get("R1");
        const rcx = (r1.worldBounds.minX + r1.worldBounds.maxX) * 0.5;
        const rcy = (r1.worldBounds.minY + r1.worldBounds.maxY) * 0.5;
        const agf = mgr.spawnAgf("t5b24-unreach", { pos: [ox - 18, oy + 18, 0], heading: 0 });
        await assert.rejects(async () => {
          await stepUntilSettled(() => mgr.tick(dt), agf.enqueue({ type: "driveTo", waypoints: [[ox - 18, oy + 14], [rcx, rcy]] }), 300);
        }, /AGF route unreachable/i);
      } finally {
        mgr.dispose();
      }
    }
  }

  // 2. Challenger 15 Bug 1: 12 cross-vehicle, active-driveTo, & AGF-task blocking cases reject cleanly
  const blockCases = [
    ["C1a_AGF_at_S7_amrApp", (mgr) => {
      const s7 = mgr.stands.get("S7");
      s7.setCargoWcid(4000012);
      mgr.spawnAgf("t5b24-blk", { pos: [...s7.amrApproachPos], heading: 0 });
      const m2 = mgr.spawnAmr("t5b24-req", { pos: [ox + 20, oy - 29, 0], heading: 0 });
      return m2.enqueue({ type: "pickFromStand", standId: "S7" });
    }],
    ["C1b_AGF_at_CH1_dock", (mgr) => {
      const ch1 = mgr.chargers.get("CH1");
      mgr.spawnAgf("t5b24-blk", { pos: [...ch1.dockPos], heading: 0 });
      const m2 = mgr.spawnAmr("t5b24-req", { pos: [ox - 10, oy - 32, 0], heading: 0 });
      return m2.enqueue({ type: "dockCharge", chargerId: "CH1" });
    }],
    ["C2_AMR_at_S7_placeOnStand", (mgr) => {
      const s7 = mgr.stands.get("S7");
      mgr.spawnAmr("t5b24-blk", { pos: [...s7.pos], heading: 0 });
      const a1 = mgr.spawnAgf("t5b24-req", { pos: [ox - 16.5, oy - 16, 0], heading: Math.PI, carriedWcid: 4000012 });
      return a1.enqueue({ type: "placeOnStand", standId: "S7" });
    }],
    ["C3_active_AMR_driveTo_S7_app", (mgr) => {
      const s7 = mgr.stands.get("S7");
      s7.setCargoWcid(4000012);
      const m1 = mgr.spawnAmr("t5b24-blk", { pos: [ox - 10, oy - 28, 0], heading: 0 });
      m1.enqueue({ type: "driveTo", waypoints: [[...s7.amrApproachPos]], speedLimit: 0.3 }).catch(() => {});
      for (let i = 0; i < 60; i++) mgr.tick(1 / 60);
      const m2 = mgr.spawnAmr("t5b24-req", { pos: [ox + 20, oy - 29, 0], heading: 0 });
      return m2.enqueue({ type: "pickFromStand", standId: "S7" });
    }],
    ["AGF_placeInRack_idle_AGF", (mgr) => {
      const r1 = mgr.racks.get("R1");
      const lp = WS.computeRackSlotLocalPose(2, 0, 0, WS.RACK_SPECS, { side: 0, doubleSided: r1.doubleSided });
      const [ax, ay] = WS.localToWorld2D(lp.approachX, lp.approachY, r1.pos[0], r1.pos[1], r1.heading);
      mgr.spawnAgf("t5b24-blk", { pos: [ax, ay, 0], heading: 0 });
      const a1 = mgr.spawnAgf("t5b24-req", { pos: [ox - 18, oy + 3, 0], heading: Math.PI * 0.5, carriedWcid: 4000012 });
      return a1.enqueue({ type: "placeInRack", rackId: "R1", bay: 2, tier: 0, side: 0, slotInBay: 0 });
    }],
    ["AGF_placeInRack_idle_AMR", (mgr) => {
      const r1 = mgr.racks.get("R1");
      const lp = WS.computeRackSlotLocalPose(2, 0, 0, WS.RACK_SPECS, { side: 0, doubleSided: r1.doubleSided });
      const [ax, ay] = WS.localToWorld2D(lp.approachX, lp.approachY, r1.pos[0], r1.pos[1], r1.heading);
      mgr.spawnAmr("t5b24-blk", { pos: [ax, ay, 0], heading: 0 });
      const a1 = mgr.spawnAgf("t5b24-req", { pos: [ox - 18, oy + 3, 0], heading: Math.PI * 0.5, carriedWcid: 4000012 });
      return a1.enqueue({ type: "placeInRack", rackId: "R1", bay: 2, tier: 0, side: 0, slotInBay: 0 });
    }],
    ["AGF_placeInRack_active_driveTo_AGF", (mgr) => {
      const r1 = mgr.racks.get("R1");
      const lp = WS.computeRackSlotLocalPose(2, 0, 0, WS.RACK_SPECS, { side: 0, doubleSided: r1.doubleSided });
      const [ax, ay] = WS.localToWorld2D(lp.approachX, lp.approachY, r1.pos[0], r1.pos[1], r1.heading);
      const aBlk = mgr.spawnAgf("t5b24-blk", { pos: [ox - 18, oy + 3, 0], heading: Math.PI * 0.5 });
      aBlk.enqueue({ type: "driveTo", waypoints: [[ax, ay]] }).catch(() => {});
      for (let i = 0; i < 10; i++) mgr.tick(1 / 60);
      const a1 = mgr.spawnAgf("t5b24-req", { pos: [ox + 8, oy + 3, 0], heading: -Math.PI * 0.5, carriedWcid: 4000012 });
      return a1.enqueue({ type: "placeInRack", rackId: "R1", bay: 2, tier: 0, side: 0, slotInBay: 0 });
    }],
    ["AGF_placeOnStand_idle_AGF", (mgr) => {
      const s7 = mgr.stands.get("S7");
      mgr.spawnAgf("t5b24-blk", { pos: [...s7.agfApproachPos], heading: Math.PI });
      const a1 = mgr.spawnAgf("t5b24-req", { pos: [ox - 16.5, oy - 16, 0], heading: Math.PI, carriedWcid: 4000012 });
      return a1.enqueue({ type: "placeOnStand", standId: "S7" });
    }],
    ["AGF_pickFromStand_idle_AMR", (mgr) => {
      const s7 = mgr.stands.get("S7");
      s7.setCargoWcid(4000012);
      mgr.spawnAmr("t5b24-blk", { pos: [...s7.pos], heading: 0 });
      const a1 = mgr.spawnAgf("t5b24-req", { pos: [ox - 16.5, oy - 16, 0], heading: Math.PI });
      return a1.enqueue({ type: "pickFromStand", standId: "S7" });
    }],
    ["AGF_pickFromContainer_idle_AGF", (mgr, cMap) => {
      const c3 = cMap.get(38147);
      c3.slots = [{ slotIndex: 8, palletSize: "full", cargoWcid: 4000012 }];
      mgr.spawnAgf("t5b24-blk", { pos: [c3.rawPos[0], c3.rawPos[1] - 3.8, 0], heading: 0 });
      const a1 = mgr.spawnAgf("t5b24-req", { pos: [ox - 12, oy + 20, 0], heading: 0 });
      return a1.enqueue({ type: "pickFromContainer", containerGuid: 38147, slotIndex: 8 });
    }],
    ["AGF_pickFromContainer_idle_AMR", (mgr, cMap) => {
      const c3 = cMap.get(38147);
      c3.slots = [{ slotIndex: 8, palletSize: "full", cargoWcid: 4000012 }];
      mgr.spawnAmr("t5b24-blk", { pos: [c3.rawPos[0], c3.rawPos[1] - 3.8, 0], heading: 0 });
      const a1 = mgr.spawnAgf("t5b24-req", { pos: [ox - 12, oy + 20, 0], heading: 0 });
      return a1.enqueue({ type: "pickFromContainer", containerGuid: 38147, slotIndex: 8 });
    }],
    ["AGF_pickGroundDeployable_idle_AGF", (mgr, _cMap, dMap) => {
      const dg = 0x88000010;
      dMap.set(dg, { guid: dg, wcid: 4000012, rawPos: [ox - 30, oy + 10, 0], model: { root: { position: { x: ox - 30, y: oy + 10, z: 0 } } } });
      mgr.spawnAgf("t5b24-blk", { pos: [ox - 30, oy + 8.2, 0], heading: 0 });
      const a1 = mgr.spawnAgf("t5b24-req", { pos: [ox - 26, oy + 5, 0], heading: 0 });
      return a1.enqueue({ type: "pickGroundDeployable", deployableGuid: dg });
    }],
    ["AGF_dropToGround_idle_AMR", (mgr) => {
      mgr.spawnAmr("t5b24-blk", { pos: [ox - 30, oy + 10, 0], heading: 0 });
      const a1 = mgr.spawnAgf("t5b24-req", { pos: [ox - 26, oy + 5, 0], heading: 0, carriedWcid: 4000012 });
      return a1.enqueue({ type: "dropToGround", pos: [ox - 30, oy + 10, 0], heading: 0 });
    }],
  ];
  for (const [label, fn] of blockCases) {
    const cMap = makeDefaultContainers();
    const dMap = new Map();
    const rig = makeRig();
    const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: dMap, palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
    mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
    try {
      await assert.rejects(async () => {
        await stepUntilSettled(() => mgr.tick(1 / 60), fn(mgr, cMap, dMap), 300);
      }, /blocked|reserved/i, `${label} expected /blocked|reserved/`);
    } finally {
      mgr.dispose();
    }
  }

  // Same-tick m1.driveTo(away) + m2.dockCharge("CH1") in both spawn orders
  for (const order of ["m1_first", "m2_first"]) {
    const cMap = makeDefaultContainers();
    const rig = makeRig();
    const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
    mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
    try {
      const ch1 = mgr.chargers.get("CH1");
      const m1 = order === "m1_first" ? mgr.spawnAmr("t5b24-m1", { pos: [...ch1.dockPos], heading: 0 }) : null;
      const m2 = mgr.spawnAmr("t5b24-m2", { pos: [ox - 10, oy - 32, 0], heading: 0 });
      const m1b = m1 || mgr.spawnAmr("t5b24-m1", { pos: [...ch1.dockPos], heading: 0 });
      await stepUntilSettled(() => mgr.tick(1 / 60), m1b.enqueue({ type: "dockCharge", chargerId: "CH1" }), 6000);
      const p1 = m1b.enqueue({ type: "driveTo", waypoints: [[ox - 8, oy - 32]] });
      const p2 = m2.enqueue({ type: "dockCharge", chargerId: "CH1" });
      await stepUntilSettled(() => mgr.tick(1 / 60), Promise.all([p1, p2]), 6000);
      assert.equal(m2.statusMode, "charging", `${order}: m2 charging`);
    } finally {
      mgr.dispose();
    }
  }

  // 3. Challenger 15 Bug 2: Open-lane non-blocking & 0.26..0.42 m charger pad zero-pushout/departure
  for (const [label, targetId, setup] of [
    ["CH1_north_of_app_1.25", "CH1", (mgr) => {
      const ch1 = mgr.chargers.get("CH1");
      const m1 = mgr.spawnAmr("t5b24-idle", { pos: [ch1.approachPos[0], ch1.approachPos[1] + 1.25, 0], heading: 0 });
      const m2 = mgr.spawnAmr("t5b24-req", { pos: [ox - 10, oy - 32, 0], heading: 0 });
      return [m1, m2, m2.enqueue({ type: "dockCharge", chargerId: "CH1" }), () => m2.statusMode === "charging"];
    }],
    ["S1_east_of_app_1.25", "S1", (mgr) => {
      const s1 = mgr.stands.get("S1");
      s1.setCargoWcid(4000012);
      const m1 = mgr.spawnAmr("t5b24-idle", { pos: [s1.amrApproachPos[0] + 1.25, s1.amrApproachPos[1], 0], heading: 0 });
      const m2 = mgr.spawnAmr("t5b24-req", { pos: [ox + 20, oy - 29, 0], heading: 0 });
      return [m1, m2, m2.enqueue({ type: "pickFromStand", standId: "S1" }), () => m2.carriedWcid === 4000012];
    }],
    ["S1_between_S1_S2_1.20", "S1", (mgr) => {
      const s1 = mgr.stands.get("S1");
      s1.setCargoWcid(4000012);
      const m1 = mgr.spawnAmr("t5b24-idle", { pos: [s1.pos[0], s1.pos[1] - 1.20, 0], heading: 0 });
      const m2 = mgr.spawnAmr("t5b24-req", { pos: [ox + 20, oy - 29, 0], heading: 0 });
      return [m1, m2, m2.enqueue({ type: "pickFromStand", standId: "S1" }), () => m2.carriedWcid === 4000012];
    }],
  ]) {
    const cMap = makeDefaultContainers();
    const rig = makeRig();
    const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
    mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
    const obbs = getObbs(mgr, cMap).filter((b) => b.id !== targetId);
    try {
      const [m1, m2, p, ok] = setup(mgr);
      const ix = m1.x;
      const iy = m1.y;
      let hits = 0;
      await stepUntilSettled(() => {
        mgr.tick(1 / 60);
        hits += checkAmrHits(m2, obbs);
        if (satObbHit(m2.x, m2.y, m2.heading, 0.39, 0.52, { cx: m1.x, cy: m1.y, h: m1.heading, hw: 0.39, hl: 0.52 })) hits++;
      }, p, 6000);
      assert.ok(ok(), `${label}: task completed`);
      assert.equal(hits, 0, `${label}: hits=${hits}`);
      assert.ok(Math.hypot(m1.x - ix, m1.y - iy) <= 1e-4, `${label}: m1 unmoved`);
    } finally {
      mgr.dispose();
    }
  }

  for (const off of [[0.26, 0], [0.42, 0], [-0.42, 0], [0, 0.26]]) {
    for (const op of ["dockCharge", "pickFromStand", "placeOnStand", "driveTo"]) {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      try {
        const ch1 = mgr.chargers.get("CH1");
        const s1 = mgr.stands.get("S1");
        if (op === "pickFromStand") s1.setCargoWcid(4000012);
        const m1 = mgr.spawnAmr("t5b24-pad", {
          pos: [ch1.dockPos[0] + off[0], ch1.dockPos[1] + off[1], 0],
          heading: 0,
          carriedWcid: op === "placeOnStand" ? 4000013 : 0,
        });
        for (let i = 0; i < 10; i++) mgr.tick(1 / 60);
        const drift = Math.hypot(m1.x - (ch1.dockPos[0] + off[0]), m1.y - (ch1.dockPos[1] + off[1]));
        assert.ok(drift <= 1e-6, `CH1 pad off=${off} zero-pushout drift=${drift}`);

        const m2 = mgr.spawnAmr("t5b24-pad-blk", { pos: [ox - 10, oy - 32, 0], heading: 0 });
        await assert.rejects(async () => {
          await stepUntilSettled(() => mgr.tick(1 / 60), m2.enqueue({ type: "dockCharge", chargerId: "CH1" }), 300);
        }, /reserved|blocked/i);

        const task = op === "dockCharge" ? { type: "dockCharge", chargerId: "CH2" }
          : op === "pickFromStand" ? { type: "pickFromStand", standId: "S1" }
          : op === "placeOnStand" ? { type: "placeOnStand", standId: "S1" }
          : { type: "driveTo", waypoints: [[ox - 10, oy - 34]] };
        await stepUntilSettled(() => mgr.tick(1 / 60), m1.enqueue(task), 6000);
        if (op === "dockCharge") assert.equal(m1.statusMode, "charging");
        else if (op === "pickFromStand") assert.equal(m1.carriedWcid, 4000012);
        else if (op === "placeOnStand") assert.equal(s1.carriedWcid, 4000013);
      } finally {
        mgr.dispose();
      }
    }
  }
});


test("B", "T5-B25 (challenger_16 Bugs 1-2): AMR SAT-OBB chassis/pallet separation (CH1_east_1.25, S1_S2_gap_1.2_h0.64, term_drive_1.15..1.22), R1 same-bay multi-tier/slot & place+pick reservation, concurrent dropToGround, & slow-undock dockCharge", async () => {
  const checkAmrPairSatHits = (m1, m2) => {
    let chassisHits = 0;
    let palletHits = 0;
    if (satObbHit(m1.x, m1.y, m1.heading, 0.39, 0.52, { cx: m2.x, cy: m2.y, h: m2.heading, hw: 0.39, hl: 0.52 })) {
      chassisHits++;
    }
    if (m1.carriedWcid && m2.carriedWcid) {
      const h1 = m1.heading + (m1.turntableYawRad || 0);
      const h2 = m2.heading + (m2.turntableYawRad || 0);
      if (satObbHit(m1.x, m1.y, h1, 0.55, 0.55, { cx: m2.x, cy: m2.y, h: h2, hw: 0.55, hl: 0.55 })) {
        palletHits++;
      }
    }
    return { chassisHits, palletHits };
  };

  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 6000 : 3000;

    // Bug 1a: CH1_east_1.25_dy0_h0.00 (empty & loaded) settles cleanly with 0 SAT-OBB chassis & pallet hits
    for (const loaded of [false, true]) {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      try {
        const ch1 = mgr.chargers.get("CH1");
        const m1 = mgr.spawnAmr("t5b25-ch1-idle", {
          pos: [ch1.approachPos[0] + 1.25, ch1.approachPos[1], 0],
          heading: 0,
          carriedWcid: loaded ? 4000012 : 0,
        });
        const m2 = mgr.spawnAmr("t5b25-ch1-req", {
          pos: [ox - 10, oy - 32, 0],
          heading: 0,
          carriedWcid: loaded ? 4000013 : 0,
        });
        let chassisHits = 0;
        let palletHits = 0;
        await stepUntilSettled(() => {
          mgr.tick(dt);
          const h = checkAmrPairSatHits(m1, m2);
          chassisHits += h.chassisHits;
          palletHits += h.palletHits;
        }, m2.enqueue({ type: "dockCharge", chargerId: "CH1" }), maxSteps);
        assert.equal(chassisHits, 0, `CH1_east_1.25 loaded=${loaded} dt=${dt}: chassisHits=${chassisHits}`);
        assert.equal(palletHits, 0, `CH1_east_1.25 loaded=${loaded} dt=${dt}: palletHits=${palletHits}`);
        assert.equal(m2.statusMode, "charging", `CH1_east_1.25 loaded=${loaded} dt=${dt}: charging`);
      } finally {
        mgr.dispose();
      }
    }

    // Bug 1b: S1_S2_gap_1.2_h0.64 (empty settles cleanly with reverse stand exit; loaded rejects cleanly)
    for (const loaded of [false, true]) {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      try {
        const s1 = mgr.stands.get("S1");
        s1.setCargoWcid(4000012);
        const m1 = mgr.spawnAmr("t5b25-s1-idle", {
          pos: [s1.pos[0], s1.pos[1] - 1.20, 0],
          heading: 0.6435,
          carriedWcid: loaded ? 4000013 : 0,
        });
        const m2 = mgr.spawnAmr("t5b25-s1-req", { pos: [ox + 20, oy - 29, 0], heading: 0 });
        let chassisHits = 0;
        let palletHits = 0;
        if (!loaded) {
          await stepUntilSettled(() => {
            mgr.tick(dt);
            const h = checkAmrPairSatHits(m1, m2);
            chassisHits += h.chassisHits;
            palletHits += h.palletHits;
          }, m2.enqueue({ type: "pickFromStand", standId: "S1" }), maxSteps);
          assert.equal(m2.carriedWcid, 4000012, `S1_S2_gap_1.2_h0.64 empty dt=${dt}: picked`);
        } else {
          await assert.rejects(async () => {
            await stepUntilSettled(() => {
              mgr.tick(dt);
              const h = checkAmrPairSatHits(m1, m2);
              chassisHits += h.chassisHits;
              palletHits += h.palletHits;
            }, m2.enqueue({ type: "pickFromStand", standId: "S1" }), 300);
          }, /reserved|blocked/i);
        }
        assert.equal(chassisHits, 0, `S1_S2_gap_1.2_h0.64 loaded=${loaded} dt=${dt}: chassisHits=${chassisHits}`);
        assert.equal(palletHits, 0, `S1_S2_gap_1.2_h0.64 loaded=${loaded} dt=${dt}: palletHits=${palletHits}`);
      } finally {
        mgr.dispose();
      }
    }

    // Bug 1c: term_drive_1.22_0_h0.64, term_drive_1.15_0_h0.64, term_drive_1.17_0.2_h0.79
    for (const [label, dx, dy, h1, h2, expectReject] of [
      ["term_drive_1.22_0_h0.64", 1.22, 0, 0.6435, -0.6435, true],
      ["term_drive_1.15_0_h0.64", 1.15, 0, 0.6435, -0.6435, true],
      ["term_drive_1.17_0.2_h0.79_opp", 1.17, 0.2, 0.79, -0.79, false],
      ["term_drive_1.17_0.2_h0.79_unheaded", 1.17, 0.2, 0.79, undefined, false],
      ["term_drive_1.17_0.2_h0.79_same", 1.17, 0.2, 0.79, 0.79, true],
    ]) {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      try {
        const bx = ox - 18;
        const by = oy - 32;
        const m1 = mgr.spawnAmr("t5b25-td-idle", { pos: [bx + dx, by + dy, 0], heading: h1 });
        const m2 = mgr.spawnAmr("t5b25-td-req", { pos: [bx, by - 3.0, 0], heading: 0 });
        let chassisHits = 0;
        const p = m2.enqueue({
          type: "driveTo",
          waypoints: [{ x: bx, y: by, ...(h2 !== undefined ? { heading: h2 } : {}), docking: true }],
        });
        if (expectReject) {
          await assert.rejects(async () => {
            await stepUntilSettled(() => {
              mgr.tick(dt);
              chassisHits += checkAmrPairSatHits(m1, m2).chassisHits;
            }, p, 300);
          }, /blocked|unreachable/i);
        } else {
          await stepUntilSettled(() => {
            mgr.tick(dt);
            chassisHits += checkAmrPairSatHits(m1, m2).chassisHits;
          }, p, maxSteps);
          assert.ok(Math.hypot(m2.x - bx, m2.y - by) <= 0.05, `${label} dt=${dt}: arrived`);
        }
        assert.equal(chassisHits, 0, `${label} dt=${dt}: chassisHits=${chassisHits}`);
      } finally {
        mgr.dispose();
      }
    }

    // Bug 2a: R1 same-bay multi-tier, multi-slot, and placeInRack+pickFromRack concurrent reservations
    for (const [label, op2, tier2, slot2] of [
      ["R1_same_bay_diff_tier", "placeInRack", 1, 0],
      ["R1_same_bay_diff_slot", "placeInRack", 0, 1],
      ["R1_same_bay_place_pick", "pickFromRack", 1, 0],
    ]) {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      try {
        if (op2 === "pickFromRack") mgr.racks.get("R1").loadSlot(2, 1, 0, 0, 4000014);
        const a1 = mgr.spawnAgf("t5b25-r1-a1", { pos: [ox - 18, oy + 3, 0], heading: Math.PI * 0.5, carriedWcid: 4000012 });
        const a2 = mgr.spawnAgf("t5b25-r1-a2", { pos: [ox + 8, oy + 3, 0], heading: -Math.PI * 0.5, carriedWcid: op2 === "placeInRack" ? 4000013 : 0 });
        let r2Err = null;
        const p1 = a1.enqueue({ type: "placeInRack", rackId: "R1", bay: 2, tier: 0, side: 0, slotInBay: 0 });
        const p2 = a2.enqueue({ type: op2, rackId: "R1", bay: 2, tier: tier2, side: 0, slotInBay: slot2 }).catch((e) => { r2Err = e; });
        mgr.tick(dt);
        await p2;
        assert.ok(r2Err && /reserved|blocked/i.test(r2Err.message), `${label} dt=${dt}: ${r2Err?.message}`);
        await stepUntilSettled(() => mgr.tick(dt), p1, maxSteps);
        assert.equal(a1.carriedWcid, 0, `${label} dt=${dt}: a1 placed`);
      } finally {
        mgr.dispose();
      }
    }

    // Bug 2b: Concurrent dropToGround at same coordinates rejects second AGF cleanly while first completes
    {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      try {
        const a1 = mgr.spawnAgf("t5b25-dg-a1", { pos: [ox - 30, oy + 4, 0], heading: 0, carriedWcid: 4000012 });
        const a2 = mgr.spawnAgf("t5b25-dg-a2", { pos: [ox - 26, oy + 4, 0], heading: 0, carriedWcid: 4000013 });
        let r2Err = null;
        const p1 = a1.enqueue({ type: "dropToGround", pos: [ox - 30, oy + 10, 0], heading: 0 });
        const p2 = a2.enqueue({ type: "dropToGround", pos: [ox - 30, oy + 10, 0], heading: 0 }).catch((e) => { r2Err = e; });
        mgr.tick(dt);
        await p2;
        assert.ok(r2Err && /reserved|blocked/i.test(r2Err.message), `dropToGround conc dt=${dt}: ${r2Err?.message}`);
        await stepUntilSettled(() => mgr.tick(dt), p1, maxSteps);
        assert.equal(a1.carriedWcid, 0, `dropToGround conc dt=${dt}: a1 dropped`);
      } finally {
        mgr.dispose();
      }
    }

    // Bug 2c: CH1_m1_depart_slow_0.05_m2_dockCharge rejects cleanly in both spawn orders with 0 hangs & 0 hits
    for (const order of ["m1_first", "m2_first"]) {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      try {
        const ch1 = mgr.chargers.get("CH1");
        const m1a = order === "m1_first" ? mgr.spawnAmr("t5b25-slow-m1", { pos: [...ch1.dockPos], heading: 0 }) : null;
        const m2 = mgr.spawnAmr("t5b25-slow-m2", { pos: [ox - 10, oy - 32, 0], heading: 0 });
        const m1 = m1a || mgr.spawnAmr("t5b25-slow-m1", { pos: [...ch1.dockPos], heading: 0 });
        await stepUntilSettled(() => mgr.tick(dt), m1.enqueue({ type: "dockCharge", chargerId: "CH1" }), maxSteps);
        let m2Err = null;
        let hits = 0;
        m1.enqueue({ type: "driveTo", waypoints: [[ox - 8, oy - 32]], speedLimit: 0.05 }).catch(() => {});
        const p2 = m2.enqueue({ type: "dockCharge", chargerId: "CH1" }).catch((e) => { m2Err = e; });
        for (let i = 0; i < 60; i++) {
          mgr.tick(dt);
          hits += checkAmrPairSatHits(m1, m2).chassisHits;
        }
        await p2;
        assert.ok(m2Err && /reserved|blocked/i.test(m2Err.message), `CH1_slow_undock ${order} dt=${dt}: ${m2Err?.message}`);
        assert.equal(hits, 0, `CH1_slow_undock ${order} dt=${dt}: hits=${hits}`);
      } finally {
        mgr.dispose();
      }
    }
  }
});


test("B", "T5-B26 (challenger_17 Bugs 1-4): CH1_east_1.25 dockCharge across all h1 angles, AGF-vs-AMR close-pass & rotation SAT-OBB, precision-capture stand-rail counterweight (20261300 S9_R & 20261283 S6_L), & 20261271 L2 close-dock rejection across dt=1/60,1/30 & wcid=0,4000012", async () => {
  const amrHw = WS.AMR_SPECS.widthM * 0.5;
  const amrHl = WS.AMR_SPECS.lengthM * 0.5;
  const agfChY = (WS.AGF_SPECS.rearOverhangY + WS.AGF_SPECS.frontChassisY) * 0.5;
  const agfChHw = WS.AGF_SPECS.overallWidthM * 0.5;
  const agfChHl = WS.AGF_SPECS.chassisLengthM * 0.5;
  const agfFkY = (WS.AGF_SPECS.frontChassisY + WS.AGF_SPECS.forkTipY) * 0.5;
  const agfFkHl = WS.AGF_SPECS.forkLengthM * 0.5;
  const checkAgfAmrSat = (agf, amr) => {
    const [chX, chY] = WS.localToWorld2D(0, agfChY, agf.x, agf.y, agf.heading);
    const [fkX, fkY] = WS.localToWorld2D(0, agfFkY, agf.x, agf.y, agf.heading);
    const agfObbs = [
      { cx: chX, cy: chY, h: agf.heading, hw: agfChHw, hl: agfChHl },
      { cx: fkX, cy: fkY, h: agf.heading, hw: 0.34, hl: agfFkHl },
    ];
    if (agf.carriedWcid) {
      const [pX, pY] = WS.localToWorld2D(0, WS.AGF_SPECS.cargoCenterY, agf.x, agf.y, agf.heading);
      agfObbs.push({ cx: pX, cy: pY, h: agf.heading, hw: 0.55, hl: 0.55 });
    }
    const amrObbs = [{ cx: amr.x, cy: amr.y, h: amr.heading, hw: amrHw, hl: amrHl }];
    if (amr.carriedWcid) {
      amrObbs.push({ cx: amr.x, cy: amr.y, h: amr.heading, hw: 0.55, hl: 0.55 });
    }
    for (const ao of agfObbs) {
      for (const mo of amrObbs) {
        if (satObbHit(ao.cx, ao.cy, ao.h, ao.hw, ao.hl, mo)) return true;
      }
    }
    return false;
  };
  const checkAmrStaticHit = (amr, obbs) => {
    for (const b of obbs) {
      if (satObbHit(amr.x, amr.y, amr.heading, amrHw, amrHl, b)) return true;
      if (amr.carriedWcid && satObbHit(amr.x, amr.y, amr.heading, 0.55, 0.55, b)) return true;
    }
    return false;
  };
  const checkAmrPairSat = (m1, m2) => {
    const o1 = [{ cx: m1.x, cy: m1.y, h: m1.heading, hw: amrHw, hl: amrHl }];
    if (m1.carriedWcid) o1.push({ cx: m1.x, cy: m1.y, h: m1.heading, hw: 0.55, hl: 0.55 });
    const o2 = [{ cx: m2.x, cy: m2.y, h: m2.heading, hw: amrHw, hl: amrHl }];
    if (m2.carriedWcid) o2.push({ cx: m2.x, cy: m2.y, h: m2.heading, hw: 0.55, hl: 0.55 });
    for (const a of o1) for (const b of o2) if (satObbHit(a.cx, a.cy, a.h, a.hw, a.hl, b)) return true;
    return false;
  };

  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 8000 : 4000;

    // Bug 1: CH1_east_1.25 empty AMR dockCharge("CH1") across all h1 angles
    for (const h1 of [0, 0.35, 0.6435, Math.PI / 4, 1.05, Math.PI / 2, Math.PI]) {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const ch1 = mgr.chargers.get("CH1");
      const obbs = getObbs(mgr, cMap).filter((b) => b.id !== "CH1");
      try {
        const m1 = mgr.spawnAmr("t5b26-m1", { pos: [ch1.approachPos[0] + 1.25, ch1.approachPos[1], 0], heading: h1 });
        const m2 = mgr.spawnAmr("t5b26-m2", { pos: [ox + 20, oy - 29, 0], heading: 0 });
        let satHits = 0;
        let staticHits = 0;
        await stepUntilSettled(() => {
          mgr.tick(dt);
          if (checkAmrPairSat(m1, m2)) satHits++;
          if (checkAmrStaticHit(m2, obbs)) staticHits++;
        }, m2.enqueue({ type: "dockCharge", chargerId: "CH1" }), maxSteps);
        assert.equal(m2.statusMode, "charging", `Bug1 h1=${h1} dt=${dt}: expected charging, got ${m2.statusMode}`);
        assert.equal(satHits, 0, `Bug1 h1=${h1} dt=${dt}: SAT-OBB hits=${satHits}`);
        assert.equal(staticHits, 0, `Bug1 h1=${h1} dt=${dt}: static hits=${staticHits}`);
      } finally {
        mgr.dispose();
      }
    }

    // Bug 2: AGF vs AMR close-pass & rotation SAT-OBB across wcid=0 & 4000012
    for (const wcid of [0, 4000012]) {
      for (const [label, agfStart, agfH, agfDst, amrPos] of [
        ["agf_pass_amr", [ox - 6, oy - 32, 0], Math.PI / 2, [ox + 6, oy - 32], [ox + 0.15, oy - 33.38, 0]],
        ["agf_rot_near_amr", [ox, oy - 32, 0], 0, [ox, oy - 36], [ox + 1.55, oy - 32, 0]],
      ]) {
        const cMap = makeDefaultContainers();
        const rig = makeRig();
        const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
        mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
        const obbs = getObbs(mgr, cMap);
        try {
          const agf = mgr.spawnAgf(`t5b26-${label}-${wcid}`, { pos: agfStart, heading: agfH, carriedWcid: wcid });
          const amr = mgr.spawnAmr(`t5b26-${label}-amr-${wcid}`, { pos: amrPos, heading: 0 });
          let mixedHits = 0;
          let staticHits = 0;
          await stepUntilSettled(() => {
            mgr.tick(dt);
            if (checkAgfAmrSat(agf, amr)) mixedHits++;
            const h = checkAgfHits(agf, obbs);
            staticHits += h.cornerHits + h.satHits;
          }, agf.enqueue({ type: "driveTo", waypoints: [agfDst] }), maxSteps);
          assert.equal(mixedHits, 0, `Bug2 ${label} w=${wcid} dt=${dt}: AGF-AMR SAT hits=${mixedHits}`);
          assert.equal(staticHits, 0, `Bug2 ${label} w=${wcid} dt=${dt}: static hits=${staticHits}`);
        } finally {
          mgr.dispose();
        }
      }
    }

    // Bug 3: precision-capture stand-rail counterweight collisions (seed 20261300 S9_R & 20261283 S6_L)
    for (const wcid of [0, 4000012]) {
      for (const [label, start, h, dst] of [
        ["seed20261300_S9_R", [44849.45888148155, 46969.41847641766, 0], 5.552480169211894, { x: 44821.90179282706, y: 46917.449109345675, heading: 3.1444731802495762, docking: true }],
        ["seed20261283_S6_L", [44862.771, 46953.181, 0], 1.716, { x: 44844.218, y: 46933.289, heading: 0.6325, docking: true }],
      ]) {
        const cMap = makeDefaultContainers();
        const rig = makeRig();
        const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
        mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
        const obbs = getObbs(mgr, cMap);
        try {
          const agf = mgr.spawnAgf(`t5b26-${label}-${wcid}`, { pos: start, heading: h, carriedWcid: wcid });
          let hits = 0;
          const t0 = performance.now();
          const p = agf.enqueue({ type: "driveTo", waypoints: [dst] });
          const initMs = performance.now() - t0;
          assert.ok(initMs < 1200, `Bug3 ${label} w=${wcid} dt=${dt}: initMs=${initMs.toFixed(1)} >= 1200`);
          await stepUntilSettled(() => {
            mgr.tick(dt);
            const ah = checkAgfHits(agf, obbs);
            hits += ah.cornerHits + ah.satHits;
          }, p, maxSteps);
          assert.equal(hits, 0, `Bug3 ${label} w=${wcid} dt=${dt}: hits=${hits}`);
          const dPos = Math.hypot(agf.x - dst.x, agf.y - dst.y);
          assert.ok(dPos <= 0.12, `Bug3 ${label} w=${wcid} dt=${dt}: dPos=${dPos.toFixed(4)}`);
        } finally {
          mgr.dispose();
        }
      }
    }

    // Bug 4: seed 20261271 amr1 unreachable L2-penetrating explicit-heading docking target rejects cleanly + valid L2 close-dock control
    {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      try {
        const badAmr = mgr.spawnAmr("t5b26-20261271", { pos: [44865.821576658636, 46967.88346533477, 0], heading: 1.5929932047553883 });
        let rejErr = null;
        await assert.rejects(async () => {
          await stepUntilSettled(() => mgr.tick(dt), badAmr.enqueue({
            type: "driveTo",
            waypoints: [{ x: 44795.097491709515, y: 46930.080139532685, heading: 1.386777974057587, docking: true }],
          }).catch((e) => { rejErr = e; throw e; }), 60);
        }, /unreachable/i);
        assert.ok(rejErr && /unreachable/i.test(rejErr.message), `Bug4 dt=${dt}: ${rejErr?.message}`);

        // Valid L2 close-dock control
        const lt2 = mgr.liftTables.get("L2");
        const dstX = lt2.pos[0] + WS.LIFT_TABLE_SPECS.outerWidthM * 0.5 + 0.52;
        const okAmr = mgr.spawnAmr("t5b26-l2-ctrl", { pos: [ox - 34, oy - 18, 0], heading: 0 });
        let ctrlHits = 0;
        await stepUntilSettled(() => {
          mgr.tick(dt);
          if (checkAmrStaticHit(okAmr, obbs)) ctrlHits++;
        }, okAmr.enqueue({ type: "driveTo", waypoints: [{ x: dstX, y: lt2.pos[1], heading: 0, docking: true }] }), maxSteps);
        assert.equal(ctrlHits, 0, `Bug4 ctrl dt=${dt}: hits=${ctrlHits}`);
        assert.ok(Math.hypot(okAmr.x - dstX, okAmr.y - lt2.pos[1]) <= 0.05);
      } finally {
        mgr.dispose();
      }
    }
  }
});


test("B", "T5-B27 (challenger_18 Bugs 1-2 & dockCharge carry lift): AGF-vs-AGF SAT-OBB separation, AGF reversing near front AMR, carried dockCharge lift height, & 50-seed multi-agent sweep", async () => {
  const getAgfObbs = (a) => {
    const s = Math.sin(a.heading);
    const c = Math.cos(a.heading);
    const out = [
      { cx: a.x - 0.89 * s, cy: a.y - 0.89 * c, h: a.heading, hw: 0.57, hl: 1.04 },
      { cx: a.x + 0.725 * s, cy: a.y + 0.725 * c, h: a.heading, hw: 0.34, hl: 0.575 },
    ];
    if (a.carriedWcid) {
      out.push({ cx: a.x + WS.AGF_SPECS.cargoCenterY * s, cy: a.y + WS.AGF_SPECS.cargoCenterY * c, h: a.heading, hw: 0.55, hl: 0.55 });
    }
    return out;
  };
  const getAmrObbs = (m) => {
    const out = [{ cx: m.x, cy: m.y, h: m.heading, hw: 0.39, hl: 0.52 }];
    if (m.carriedWcid) {
      out.push({ cx: m.x, cy: m.y, h: m.heading + (m.turntableYawRad || 0), hw: 0.55, hl: 0.55 });
    }
    return out;
  };
  const countPairSatHits = (obbsA, obbsB) => {
    let hits = 0;
    for (const a of obbsA) {
      for (const b of obbsB) {
        if (satObbHit(a.cx, a.cy, a.h, a.hw, a.hl, b)) hits++;
      }
    }
    return hits;
  };

  // 1. Bug 1: Deterministic AGF-vs-AGF SAT-OBB pairs (empty rotation, 90-deg crossing, 1.6m/1.35m passing, head-on)
  // Note: agf_rot_near_agf_empty_clear spawns a2 at ox - 1.95 (instead of ox - 1.5) so fork tips reach
  // ox - 1.95 + 1.30 = ox - 0.65, giving clean 0.08 m clearance vs a1's +/-0.57 m chassis at t=0.
  const agfPairs = [
    ["agf_rot_near_agf_empty_clear", [ox, oy - 32, 0], 0, 0, [[ox + 4, oy - 32]], [ox - 1.95, oy - 33.4, 0], Math.PI / 2, 0, null],
    ["agf_rot_near_agf_empty_0.25", [ox, oy - 32, 0], 0, 0, [[ox + 4, oy - 32]], [ox - 2.10, oy - 33.4, 0], Math.PI / 2, 0, null],
    ["agf_cross_90_loaded", [ox - 6, oy - 32, 0], Math.PI / 2, 4000012, [[ox + 6, oy - 32]], [ox, oy - 38, 0], 0, 4000013, [[ox, oy - 26]]],
    ["agf_pass_1.6m_loaded", [ox - 8, oy - 32, 0], Math.PI / 2, 4000012, [[ox + 8, oy - 32]], [ox + 8, oy - 30.4, 0], -Math.PI / 2, 4000013, [[ox - 8, oy - 30.4]]],
    ["agf_pass_1.35m_loaded", [ox - 8, oy - 32, 0], Math.PI / 2, 4000012, [[ox + 8, oy - 32]], [ox + 8, oy - 30.65, 0], -Math.PI / 2, 4000013, [[ox - 8, oy - 30.65]]],
    ["agf_headon_loaded", [ox - 8, oy - 32, 0], Math.PI / 2, 4000012, [[ox + 8, oy - 32]], [ox + 8, oy - 32, 0], -Math.PI / 2, 4000013, [[ox - 8, oy - 32]]],
  ];
  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 4000 : 2000;
    for (const [label, p1, h1, w1, wp1, p2, h2, w2, wp2] of agfPairs) {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      try {
        const a1 = mgr.spawnAgf(`t5b27-a1-${label}`, { pos: p1, heading: h1, carriedWcid: w1 });
        const a2 = mgr.spawnAgf(`t5b27-a2-${label}`, { pos: p2, heading: h2, carriedWcid: w2 });
        let hits = 0;
        const tasks = [a1.enqueue({ type: "driveTo", waypoints: wp1 })];
        if (wp2) tasks.push(a2.enqueue({ type: "driveTo", waypoints: wp2 }));
        await stepUntilSettled(() => {
          mgr.tick(dt);
          hits += countPairSatHits(getAgfObbs(a1), getAgfObbs(a2));
        }, Promise.all(tasks), maxSteps);
        assert.equal(hits, 0, `${label} dt=${dt}: AGF-AGF SAT hits=${hits}`);
      } finally {
        mgr.dispose();
      }
    }

    // 2. Bug 2: AGF reversing away from front AMR (0.16 m clear) settles cleanly; reversing toward rear AMR stops safely
    {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      try {
        const agf = mgr.spawnAgf("t5b27-rev-agf", { pos: [ox, oy - 32, 0], heading: 0, carriedWcid: 4000012 });
        const amr = mgr.spawnAmr("t5b27-front-amr", { pos: [ox, oy - 30.02, 0], heading: 0, carriedWcid: 4000013 });
        let hits = 0;
        await stepUntilSettled(() => {
          mgr.tick(dt);
          hits += countPairSatHits(getAgfObbs(agf), getAmrObbs(amr));
        }, agf.enqueue({ type: "driveTo", waypoints: [{ x: ox + 2.5, y: oy - 37, reverse: true }] }), maxSteps);
        assert.equal(hits, 0, `rev_with_amr_0.16m_in_front dt=${dt}: SAT hits=${hits}`);
        assert.ok(Math.hypot(agf.x - (ox + 2.5), agf.y - (oy - 37)) <= 0.15, `rev_with_amr_0.16m_in_front dt=${dt}: arrived`);
      } finally {
        mgr.dispose();
      }
    }
    {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      try {
        const agf = mgr.spawnAgf("t5b27-rev-safe", { pos: [ox, oy - 32, 0], heading: 0, carriedWcid: 4000012 });
        const amr = mgr.spawnAmr("t5b27-rear-amr", { pos: [ox, oy - 35.5, 0], heading: 0, carriedWcid: 4000013 });
        let hits = 0;
        const p = agf.enqueue({ type: "driveTo", waypoints: [{ x: ox + 0.5, y: oy - 37, reverse: true }] });
        p.catch(() => {});
        const rearSteps = dt < 0.025 ? 2000 : 1000;
        for (let k = 0; k < rearSteps; k++) {
          mgr.tick(dt);
          hits += countPairSatHits(getAgfObbs(agf), getAmrObbs(amr));
        }
        assert.equal(hits, 0, `rev_rear_amr_safety dt=${dt}: SAT hits=${hits}`);
        assert.equal(agf.statusMode, "blocked", `rev_rear_amr_safety dt=${dt}: stopped blocked`);
      } finally {
        mgr.dispose();
      }
    }
  }

  // 3. Minor observation: dockCharge preserves raised lift height when carrying cargo across CH1..CH8
  for (const chId of ["CH1", "CH4", "CH8"]) {
    const cMap = makeDefaultContainers();
    const rig = makeRig();
    const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
    mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
    try {
      const ch = mgr.chargers.get(chId);
      const amr = mgr.spawnAmr(`t5b27-chg-${chId}`, {
        pos: [ch.approachPos[0], ch.approachPos[1] + 1.8, 0],
        heading: Math.PI,
        carriedWcid: 4000012,
        liftHeightM: WS.AMR_SPECS.raisedHeightM,
      });
      await stepUntilSettled(() => mgr.tick(1 / 60), amr.enqueue({ type: "dockCharge", chargerId: chId }), 2400);
      assert.equal(amr.statusMode, "charging", `${chId}: charging`);
      assert.ok(amr.liftHeightM >= WS.AMR_SPECS.raisedHeightM - 1e-4, `${chId}: carried cargo stays raised (${amr.liftHeightM})`);
    } finally {
      mgr.dispose();
    }
  }

  // 4. Unseen 50-seed multi-agent sweep (20261261..20261310 x dt=1/60, 1/30) -> 0 SAT-OBB hits & 0 hangs
  const mulberry32 = (a) => () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let totalSatHits = 0;
  let totalHangs = 0;
  for (let seed = 20261261; seed <= 20261310; seed++) {
    for (const dt of [1 / 60, 1 / 30]) {
      const rng = mulberry32(seed);
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      try {
        const spawned = [];
        const trySpawn = (isAgf, idx) => {
          for (let k = 0; k < 40; k++) {
            const x = ox - 45 + rng() * 68;
            const y = oy - 38 + rng() * 72;
            const h = (rng() - 0.5) * 2 * Math.PI;
            const rad = isAgf ? 1.85 : 1.05;
            if (obbs.some((b) => Math.hypot(x - b.cx, y - b.cy) < Math.max(b.hw, b.hl) + rad + 0.5)) continue;
            if (spawned.some((s) => Math.hypot(x - s.x, y - s.y) < s.rad + rad + 0.5)) continue;
            let tx = ox - 45 + rng() * 68;
            let ty = oy - 38 + rng() * 72;
            for (let t = 0; t < 20; t++) {
              if (!obbs.some((b) => Math.hypot(tx - b.cx, ty - b.cy) < Math.max(b.hw, b.hl) + rad + 0.5)) break;
              tx = ox - 45 + rng() * 68;
              ty = oy - 38 + rng() * 72;
            }
            const id = `t5b27-${seed}-${isAgf ? "a" : "m"}${idx}`;
            const v = isAgf
              ? mgr.spawnAgf(id, { pos: [x, y, 0], heading: h, carriedWcid: rng() < 0.5 ? 4000012 : 0 })
              : mgr.spawnAmr(id, { pos: [x, y, 0], heading: h, carriedWcid: rng() < 0.5 ? 4000013 : 0 });
            spawned.push({ x, y, rad, v, tx, ty, isAgf });
            break;
          }
        };
        for (let i = 0; i < 3; i++) trySpawn(true, i);
        for (let i = 0; i < 2; i++) trySpawn(false, i);
        let active = spawned.length;
        for (const s of spawned) {
          s.v.enqueue({ type: "driveTo", waypoints: [[s.tx, s.ty]] }).then(
            () => { active--; },
            (e) => {
              if (!/unreachable/i.test(e?.message || "")) throw e;
              active--;
            },
          );
        }
        const maxS = Math.round(120 / dt);
        const agfs = spawned.filter((s) => s.isAgf).map((s) => s.v);
        const amrs = spawned.filter((s) => !s.isAgf).map((s) => s.v);
        for (let step = 0; step < maxS && active > 0; step++) {
          mgr.tick(dt);
          for (let i = 0; i < agfs.length; i++) {
            const oa = getAgfObbs(agfs[i]);
            for (let j = i + 1; j < agfs.length; j++) {
              totalSatHits += countPairSatHits(oa, getAgfObbs(agfs[j]));
            }
            for (let j = 0; j < amrs.length; j++) {
              totalSatHits += countPairSatHits(oa, getAmrObbs(amrs[j]));
            }
          }
          for (let i = 0; i < amrs.length; i++) {
            const om = getAmrObbs(amrs[i]);
            for (let j = i + 1; j < amrs.length; j++) {
              totalSatHits += countPairSatHits(om, getAmrObbs(amrs[j]));
            }
          }
          if (step % 20 === 19) await Promise.resolve();
        }
        await Promise.resolve();
        if (active > 0) totalHangs++;
      } finally {
        mgr.dispose();
      }
    }
  }
  assert.equal(totalSatHits, 0, `50-seed sweep totalSatHits=${totalSatHits}`);
  assert.equal(totalHangs, 0, `50-seed sweep totalHangs=${totalHangs}`);
});

test("B", "T5-B28 (Cycle 19 remediation): zero terminalOverlapBypass, 7 adversarial AGF bypass probes, AMR pad=0 pivot guard + 20261401..20261420 sweep, & ground zone pallet-OBB rejection", async () => {
  // 0. Static check: terminalOverlapBypass / terminalMovingFurther completely removed
  const mgrSrc = readFileSync(join(APP_ROOT, "scene3d/vehicle/warehouse_manager.js"), "utf8");
  assert.equal(/terminalOverlapBypass|terminalMovingFurther/.test(mgrSrc), false, "warehouse_manager.js must have 0 terminalOverlapBypass/terminalMovingFurther references");

  const getAgfObbs = (a) => {
    const s = Math.sin(a.heading);
    const c = Math.cos(a.heading);
    const out = [
      { cx: a.x - 0.89 * s, cy: a.y - 0.89 * c, h: a.heading, hw: 0.57, hl: 1.04 },
      { cx: a.x + 0.725 * s, cy: a.y + 0.725 * c, h: a.heading, hw: 0.34, hl: 0.575 },
    ];
    if (a.carriedWcid) {
      out.push({ cx: a.x + WS.AGF_SPECS.cargoCenterY * s, cy: a.y + WS.AGF_SPECS.cargoCenterY * c, h: a.heading, hw: 0.55, hl: 0.55 });
    }
    return out;
  };
  const getAmrObbs = (m) => {
    const out = [{ cx: m.x, cy: m.y, h: m.heading, hw: 0.39, hl: 0.52 }];
    if (m.carriedWcid) {
      out.push({ cx: m.x, cy: m.y, h: m.heading + (m.turntableYawRad || 0), hw: 0.55, hl: 0.55 });
    }
    return out;
  };
  const countPairSatHits = (obbsA, obbsB) => {
    let hits = 0;
    for (const a of obbsA) {
      for (const b of obbsB) {
        if (satObbHit(a.cx, a.cy, a.h, a.hw, a.hl, b)) hits++;
      }
    }
    return hits;
  };

  // 1. All 7 terminalOverlapBypass adversarial reproducers across dt = 1/60 and 1/30 -> 0 SAT-OBB hits
  const advBypassCases = [
    ["ADV_terminalOverlapBypass_probe", [ox, oy - 38, 0], 0, 4000012, [{ x: ox, y: oy - 34.0 }], [ox, oy - 32, 0], 0, 4000013],
    ["adv_terminal_bypass_1.60_loaded", [ox - 6, oy - 32, 0], Math.PI / 2, 4000012, [[ox, oy - 32]], [ox + 1.60, oy - 32, 0], -Math.PI / 2, 4000013],
    ["adv_terminal_bypass_1.60_rear", [ox - 6, oy - 32, 0], Math.PI / 2, 4000012, [[ox, oy - 32]], [ox, oy - 33.6, 0], Math.PI, 4000013],
    ["bypass_clear_start_and_end_cross", [ox - 1.6, oy - 32.0, 0], 0, 4000012, [{ x: ox + 1.6, y: oy - 32.0, heading: 0 }], [ox, oy - 32.0, 0], 0, 4000013],
    ["bypass_clear_end_side_by_side", [ox - 4.0, oy - 33.6, 0], Math.PI / 2, 4000012, [{ x: ox + 1.70, y: oy - 32.0, heading: 0 }], [ox, oy - 32.0, 0], 0, 4000013],
    ["bypass_clear_end_diag", [ox + 4.0, oy - 33.6, 0], -Math.PI / 2, 4000012, [{ x: ox - 1.8, y: oy - 32.7, heading: 0 }], [ox, oy - 32.0, 0], 0, 4000013],
    ["term_bypass_far_approach", [ox - 6.0, oy - 30.2, 0], Math.PI / 2, 4000012, [[ox + 0.1, oy - 30.2]], [ox, oy - 32, 0], Math.PI, 4000013],
  ];
  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 2400 : 1200;
    for (const [label, p1, h1, w1, wp1, p2, h2, w2] of advBypassCases) {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      try {
        const a1 = mgr.spawnAgf(`t5b28-a1-${label}`, { pos: p1, heading: h1, carriedWcid: w1 });
        const a2 = mgr.spawnAgf(`t5b28-a2-${label}`, { pos: p2, heading: h2, carriedWcid: w2 });
        assert.equal(countPairSatHits(getAgfObbs(a1), getAgfObbs(a2)), 0, `${label} dt=${dt}: t=0 clean`);
        let done = false;
        a1.enqueue({ type: "driveTo", waypoints: wp1 }).then(() => { done = true; }, () => { done = true; });
        let hits = 0;
        for (let k = 0; k < maxSteps && !done; k++) {
          mgr.tick(dt);
          hits += countPairSatHits(getAgfObbs(a1), getAgfObbs(a2));
          if (k % 20 === 19) await Promise.resolve();
        }
        assert.equal(hits, 0, `${label} dt=${dt}: AGF-AGF SAT-OBB hits=${hits}`);
      } finally {
        mgr.dispose();
      }
    }
  }

  // 2a. AMR enforceMinSeparation pad=0 penetration guard (probe_1415_exact: 1 mm clear movingAway pivot)
  for (const dt of [1 / 60, 1 / 30]) {
    const cMap = makeDefaultContainers();
    const rig = makeRig();
    const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
    mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
    try {
      const agf = mgr.spawnAgf("t5b28-1415-agf", { pos: [ox, oy - 32, 0], heading: 0, carriedWcid: 0 });
      const amr = mgr.spawnAmr("t5b28-1415-amr", { pos: [ox + 1.121, oy - 32.89, 0], heading: Math.PI / 2, carriedWcid: 4000013 });
      assert.equal(countPairSatHits(getAgfObbs(agf), getAmrObbs(amr)), 0, `probe_1415_exact dt=${dt}: t=0 clear`);
      let done = false;
      amr.enqueue({ type: "driveTo", waypoints: [[ox + 3.0, oy - 33.59]] }).then(() => { done = true; }, () => { done = true; });
      let hits = 0;
      const steps = dt < 0.025 ? 600 : 300;
      for (let k = 0; k < steps && !done; k++) {
        mgr.tick(dt);
        hits += countPairSatHits(getAgfObbs(agf), getAmrObbs(amr));
      }
      assert.equal(hits, 0, `probe_1415_exact dt=${dt}: AMR pad=0 hits=${hits}`);
    } finally {
      mgr.dispose();
    }
  }

  // 2b. 20-seed multi-agent sweep (20261401..20261420 x dt=1/60, 1/30) -> 0 SAT-OBB hits & 0 hangs
  const mulberry32 = (a) => () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let sweepHits = 0;
  let sweepHangs = 0;
  for (let seed = 20261401; seed <= 20261420; seed++) {
    for (const dt of [1 / 60, 1 / 30]) {
      const rng = mulberry32(seed);
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      try {
        const spawned = [];
        const trySpawn = (isAgf, idx) => {
          for (let k = 0; k < 40; k++) {
            const x = ox - 45 + rng() * 68;
            const y = oy - 38 + rng() * 72;
            const h = (rng() - 0.5) * 2 * Math.PI;
            const rad = isAgf ? 1.85 : 1.05;
            if (obbs.some((b) => Math.hypot(x - b.cx, y - b.cy) < Math.max(b.hw, b.hl) + rad + 0.5)) continue;
            if (spawned.some((s) => Math.hypot(x - s.x, y - s.y) < s.rad + rad + 0.5)) continue;
            let tx = ox - 45 + rng() * 68;
            let ty = oy - 38 + rng() * 72;
            for (let t = 0; t < 20; t++) {
              if (!obbs.some((b) => Math.hypot(tx - b.cx, ty - b.cy) < Math.max(b.hw, b.hl) + rad + 0.5)) break;
              tx = ox - 45 + rng() * 68;
              ty = oy - 38 + rng() * 72;
            }
            const id = `t5b28-${seed}-${isAgf ? "a" : "m"}${idx}`;
            const v = isAgf
              ? mgr.spawnAgf(id, { pos: [x, y, 0], heading: h, carriedWcid: rng() < 0.5 ? 4000012 : 0 })
              : mgr.spawnAmr(id, { pos: [x, y, 0], heading: h, carriedWcid: rng() < 0.5 ? 4000013 : 0 });
            spawned.push({ x, y, rad, v, tx, ty, isAgf });
            break;
          }
        };
        for (let i = 0; i < 3; i++) trySpawn(true, i);
        for (let i = 0; i < 2; i++) trySpawn(false, i);
        let active = spawned.length;
        for (const s of spawned) {
          s.v.enqueue({ type: "driveTo", waypoints: [[s.tx, s.ty]] }).then(
            () => { active--; },
            (e) => {
              if (!/unreachable/i.test(e?.message || "")) throw e;
              active--;
            },
          );
        }
        const maxS = Math.round(120 / dt);
        const agfs = spawned.filter((s) => s.isAgf).map((s) => s.v);
        const amrs = spawned.filter((s) => !s.isAgf).map((s) => s.v);
        for (let step = 0; step < maxS && active > 0; step++) {
          mgr.tick(dt);
          for (let i = 0; i < agfs.length; i++) {
            const oa = getAgfObbs(agfs[i]);
            for (let j = i + 1; j < agfs.length; j++) {
              sweepHits += countPairSatHits(oa, getAgfObbs(agfs[j]));
            }
            for (let j = 0; j < amrs.length; j++) {
              sweepHits += countPairSatHits(oa, getAmrObbs(amrs[j]));
            }
          }
          for (let i = 0; i < amrs.length; i++) {
            const om = getAmrObbs(amrs[i]);
            for (let j = i + 1; j < amrs.length; j++) {
              sweepHits += countPairSatHits(om, getAmrObbs(amrs[j]));
            }
          }
          if (step % 20 === 19) await Promise.resolve();
        }
        await Promise.resolve();
        if (active > 0) sweepHangs++;
      } finally {
        mgr.dispose();
      }
    }
  }
  assert.equal(sweepHits, 0, `20261401..20261420 sweepHits=${sweepHits}`);
  assert.equal(sweepHangs, 0, `20261401..20261420 sweepHangs=${sweepHangs}`);

  // 3. dropToGround & pickGroundDeployable 0.85 m AMR pallet-zone blocking rejection
  {
    const cMap = makeDefaultContainers();
    const depMap = new Map([
      [99001, { guid: 99001, wcid: 4000012, rawPos: [ox - 20, oy - 32, 0], pos: [ox - 20, oy - 32, 0] }],
    ]);
    const rig = makeRig();
    const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: depMap, palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
    mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
    try {
      const agfDrop = mgr.spawnAgf("t5b28-drop-agf", { pos: [ox - 30, oy - 32, 0], heading: 0, carriedWcid: 4000012 });
      const amrDrop = mgr.spawnAmr("t5b28-drop-amr", { pos: [ox - 10 + 0.85, oy - 32, 0], heading: 0, carriedWcid: 0 });
      assert.ok(amrDrop);
      const dropP = agfDrop.enqueue({ type: "dropToGround", pos: [ox - 10, oy - 32, 0], heading: 0 });
      mgr.tick(1 / 60);
      await assert.rejects(dropP, /is blocked/, "dropToGround must reject 0.85 m lateral AMR in pallet zone");

      const agfPick = mgr.spawnAgf("t5b28-pick-agf", { pos: [ox - 28, oy - 36, 0], heading: 0, carriedWcid: 0 });
      const amrPick = mgr.spawnAmr("t5b28-pick-amr", { pos: [ox - 20 + 0.85, oy - 32, 0], heading: 0, carriedWcid: 0 });
      assert.ok(amrPick);
      const pickP = agfPick.enqueue({ type: "pickGroundDeployable", deployableGuid: 99001 });
      mgr.tick(1 / 60);
      await assert.rejects(pickP, /is blocked/, "pickGroundDeployable must reject 0.85 m lateral AMR in pallet zone");
    } finally {
      mgr.dispose();
    }
  }
});

test("B", "T5-B29 (Cycle 20 challenger_20 livelock remediation): idle_amr_at_midE, multiWp_collinear_2m_ahead, SEED 20261318 & 20261427 S3 across dt=1/60 & 1/30", async () => {
  const getAgfObbs = (a) => {
    const s = Math.sin(a.heading);
    const c = Math.cos(a.heading);
    const out = [
      { cx: a.x - 0.89 * s, cy: a.y - 0.89 * c, h: a.heading, hw: 0.57, hl: 1.04 },
      { cx: a.x + 0.725 * s, cy: a.y + 0.725 * c, h: a.heading, hw: 0.34, hl: 0.575 },
    ];
    if (a.carriedWcid) {
      out.push({ cx: a.x + WS.AGF_SPECS.cargoCenterY * s, cy: a.y + WS.AGF_SPECS.cargoCenterY * c, h: a.heading, hw: 0.55, hl: 0.55 });
    }
    return out;
  };
  const getAmrObbs = (m) => {
    const out = [{ cx: m.x, cy: m.y, h: m.heading, hw: 0.39, hl: 0.52 }];
    if (m.carriedWcid) {
      out.push({ cx: m.x, cy: m.y, h: m.heading + (m.turntableYawRad || 0), hw: 0.55, hl: 0.55 });
    }
    return out;
  };
  const countPairSatHits = (obbsA, obbsB) => {
    let hits = 0;
    for (const a of obbsA) {
      for (const b of obbsB) {
        if (satObbHit(a.cx, a.cy, a.h, a.hw, a.hl, b)) hits++;
      }
    }
    return hits;
  };

  for (const dt of [1 / 60, 1 / 30]) {
    // 1. Bug 1: idle_amr_at_midE (maybeOrthogonalizeAgfTerminalRoute considers amrEntries)
    {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      try {
        const a1 = mgr.spawnAgf("t5b29-b1-a1", { pos: [ox, oy - 38, 0], heading: 0, carriedWcid: 4000012 });
        const a2 = mgr.spawnAgf("t5b29-b1-a2", { pos: [ox, oy - 32, 0], heading: Math.PI * 0.5, carriedWcid: 4000013 });
        const m1 = mgr.spawnAmr("t5b29-b1-m1", { pos: [ox + 1.63, oy - 34, 0], heading: 0, carriedWcid: 4000014 });
        let done = false;
        let vehHits = 0;
        let statHits = 0;
        await stepUntilSettled(() => {
          mgr.tick(dt);
          const oa1 = getAgfObbs(a1);
          vehHits += countPairSatHits(oa1, getAgfObbs(a2)) + countPairSatHits(oa1, getAmrObbs(m1));
          statHits += checkAgfHits(a1, obbs).satHits;
        }, a1.enqueue({ type: "driveTo", waypoints: [{ x: ox, y: oy - 34 }] }).then(() => { done = true; }), Math.round(60 / dt));
        assert.equal(done, true, `Bug1 idle_amr_at_midE dt=${dt}: must complete`);
        assert.equal(vehHits, 0, `Bug1 idle_amr_at_midE dt=${dt}: vehHits=${vehHits}`);
        assert.equal(statHits, 0, `Bug1 idle_amr_at_midE dt=${dt}: statHits=${statHits}`);
        assert.ok(Math.hypot(a1.x - ox, a1.y - (oy - 34)) <= 0.15, `Bug1 arrived dist=${Math.hypot(a1.x - ox, a1.y - (oy - 34))}`);
      } finally {
        mgr.dispose();
      }
    }

    // 2. Bug 2: multiWp_collinear_2m_ahead (initAgfTask orthogonalizes multi-wp terminal leg)
    {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      try {
        const a1 = mgr.spawnAgf("t5b29-b2-a1", { pos: [ox - 5, oy - 25, 0], heading: Math.PI * 0.5, carriedWcid: 4000012 });
        const a2 = mgr.spawnAgf("t5b29-b2-a2", { pos: [ox, oy - 32, 0], heading: 0, carriedWcid: 4000013 });
        let done = false;
        let vehHits = 0;
        let statHits = 0;
        let tickIdx = 0;
        const graceTicks = Math.round(2.0 / dt);
        await stepUntilSettled(() => {
          mgr.tick(dt);
          tickIdx++;
          vehHits += countPairSatHits(getAgfObbs(a1), getAgfObbs(a2));
          if (tickIdx > graceTicks) statHits += checkAgfHits(a1, obbs).satHits;
        }, a1.enqueue({ type: "driveTo", waypoints: [{ x: ox, y: oy - 25 }, { x: ox, y: oy - 30 }] }).then(() => { done = true; }), Math.round(90 / dt));
        assert.equal(done, true, `Bug2 multiWp_collinear_2m_ahead dt=${dt}: must complete`);
        assert.equal(vehHits, 0, `Bug2 multiWp_collinear_2m_ahead dt=${dt}: vehHits=${vehHits}`);
        assert.equal(statHits, 0, `Bug2 multiWp_collinear_2m_ahead dt=${dt}: statHits=${statHits}`);
        assert.ok(Math.hypot(a1.x - ox, a1.y - (oy - 30)) <= 0.15, `Bug2 arrived dist=${Math.hypot(a1.x - ox, a1.y - (oy - 30))}`);
      } finally {
        mgr.dispose();
      }
    }

    // 3. Bug 3: SEED 20261318 (applyDeadlockBreaker + docking orbit recovery)
    {
      const mulberry32 = (a) => () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const rng = mulberry32(20261318);
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      try {
        const spawned = [];
        const trySpawn = (isAgf, idx) => {
          for (let k = 0; k < 40; k++) {
            const x = ox - 45 + rng() * 68;
            const y = oy - 38 + rng() * 72;
            const h = (rng() - 0.5) * 2 * Math.PI;
            const rad = isAgf ? 1.85 : 1.05;
            if (obbs.some((b) => Math.hypot(x - b.cx, y - b.cy) < Math.max(b.hw, b.hl) + rad + 0.5)) continue;
            if (spawned.some((s) => Math.hypot(x - s.x, y - s.y) < s.rad + rad + 0.5)) continue;
            let tx = ox - 45 + rng() * 68;
            let ty = oy - 38 + rng() * 72;
            for (let t = 0; t < 20; t++) {
              if (!obbs.some((b) => Math.hypot(tx - b.cx, ty - b.cy) < Math.max(b.hw, b.hl) + rad + 0.5)) break;
              tx = ox - 45 + rng() * 68;
              ty = oy - 38 + rng() * 72;
            }
            const id = `t5b29-20261318-${isAgf ? "a" : "m"}${idx}`;
            const v = isAgf
              ? mgr.spawnAgf(id, { pos: [x, y, 0], heading: h, carriedWcid: rng() < 0.5 ? 4000012 : 0 })
              : mgr.spawnAmr(id, { pos: [x, y, 0], heading: h, carriedWcid: rng() < 0.5 ? 4000013 : 0 });
            spawned.push({ x, y, rad, v, tx, ty, isAgf });
            break;
          }
        };
        for (let i = 0; i < 3; i++) trySpawn(true, i);
        for (let i = 0; i < 2; i++) trySpawn(false, i);
        let active = spawned.length;
        for (const s of spawned) {
          s.v.enqueue({ type: "driveTo", waypoints: [[s.tx, s.ty]] }).then(
            () => { active--; },
            (e) => {
              if (!/unreachable/i.test(e?.message || "")) throw e;
              active--;
            },
          );
        }
        const agfs = spawned.filter((s) => s.isAgf).map((s) => s.v);
        const amrs = spawned.filter((s) => !s.isAgf).map((s) => s.v);
        let hits = 0;
        const maxS = Math.round(120 / dt);
        for (let step = 0; step < maxS && active > 0; step++) {
          mgr.tick(dt);
          for (let i = 0; i < agfs.length; i++) {
            const oa = getAgfObbs(agfs[i]);
            for (let j = i + 1; j < agfs.length; j++) hits += countPairSatHits(oa, getAgfObbs(agfs[j]));
            for (let j = 0; j < amrs.length; j++) hits += countPairSatHits(oa, getAmrObbs(amrs[j]));
          }
          for (let i = 0; i < amrs.length; i++) {
            const om = getAmrObbs(amrs[i]);
            for (let j = i + 1; j < amrs.length; j++) hits += countPairSatHits(om, getAmrObbs(amrs[j]));
          }
          if (step % 20 === 19) await Promise.resolve();
        }
        await Promise.resolve();
        assert.equal(active, 0, `SEED 20261318 dt=${dt}: active=${active}`);
        assert.equal(hits, 0, `SEED 20261318 dt=${dt}: SAT-OBB hits=${hits}`);
      } finally {
        mgr.dispose();
      }
    }

    // 4. Caveat check: 20261427 placeOnStand S3 settles cleanly with 0 static hits
    {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap).filter((b) => b.id !== "S3");
      try {
        const a5 = mgr.spawnAgf("t5b29-1427-a5", { pos: [ox + 5.54, oy - 14.73, 0], heading: -Math.PI * 0.5, carriedWcid: 4000012 });
        let done = false;
        let statHits = 0;
        await stepUntilSettled(() => {
          mgr.tick(dt);
          statHits += checkAgfHits(a5, obbs).satHits;
        }, a5.enqueue({ type: "placeOnStand", standId: "S3" }).then(() => { done = true; }), Math.round(60 / dt));
        assert.equal(done, true, `20261427 S3 dt=${dt}: must complete`);
        assert.equal(statHits, 0, `20261427 S3 dt=${dt}: statHits=${statHits}`);
        assert.equal(mgr.stands.get("S3").carriedWcid, 4000012, `20261427 S3 dt=${dt}: cargo placed`);
      } finally {
        mgr.dispose();
      }
    }
  }
});

test("B", "T5-B30 (Cycle 21 challenger_21 livelock remediation): orbit_aisle_A1_zero_peers, orbit_rmin_docking_true, agf_1.55/1.70 & amr_1.55, MIN_1427_M3 across dt=1/60 & 1/30", async () => {
  const getAgfObbs = (a) => {
    const s = Math.sin(a.heading);
    const c = Math.cos(a.heading);
    const out = [
      { cx: a.x - 0.89 * s, cy: a.y - 0.89 * c, h: a.heading, hw: 0.57, hl: 1.04 },
      { cx: a.x + 0.725 * s, cy: a.y + 0.725 * c, h: a.heading, hw: 0.34, hl: 0.575 },
    ];
    if (a.carriedWcid) {
      out.push({ cx: a.x + WS.AGF_SPECS.cargoCenterY * s, cy: a.y + WS.AGF_SPECS.cargoCenterY * c, h: a.heading, hw: 0.55, hl: 0.55 });
    }
    return out;
  };
  const getAmrObbs = (m) => {
    const out = [{ cx: m.x, cy: m.y, h: m.heading, hw: 0.39, hl: 0.52 }];
    if (m.carriedWcid) {
      out.push({ cx: m.x, cy: m.y, h: m.heading + (m.turntableYawRad || 0), hw: 0.55, hl: 0.55 });
    }
    return out;
  };
  const countPairSatHits = (obbsA, obbsB) => {
    let hits = 0;
    for (const a of obbsA) {
      for (const b of obbsB) {
        if (satObbHit(a.cx, a.cy, a.h, a.hw, a.hl, b)) hits++;
      }
    }
    return hits;
  };

  for (const dt of [1 / 60, 1 / 30]) {
    // 1. Bug 1: orbit_aisle_A1_zero_peers
    {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      try {
        const a1 = mgr.spawnAgf("t5b30-b1-a1", { pos: [ox - 8, oy + 3.0, 0], heading: Math.PI * 0.5, carriedWcid: 0 });
        let done = false;
        let statHits = 0;
        await stepUntilSettled(() => {
          mgr.tick(dt);
          statHits += checkAgfHits(a1, obbs).satHits;
        }, a1.enqueue({ type: "driveTo", waypoints: [{ x: ox - 7.95, y: oy + 2.75, heading: Math.PI * 0.5 }] }).then(() => { done = true; }), Math.round(45 / dt));
        assert.equal(done, true, `Bug1 orbit_aisle_A1_zero_peers dt=${dt}: must complete`);
        assert.equal(statHits, 0, `Bug1 orbit_aisle_A1_zero_peers dt=${dt}: statHits=${statHits}`);
        assert.ok(Math.hypot(a1.x - (ox - 7.95), a1.y - (oy + 2.75)) <= 0.15, `Bug1 dist=${Math.hypot(a1.x - (ox - 7.95), a1.y - (oy + 2.75))}`);
      } finally {
        mgr.dispose();
      }
    }

    // 2. Bug 2: orbit_rmin_docking_true + ORBIT_SLOW
    {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      try {
        const a1 = mgr.spawnAgf("t5b30-b2-a1", { pos: [ox + 35, oy, 0], heading: 0, carriedWcid: 4000012 });
        let done = false;
        let statHits = 0;
        await stepUntilSettled(() => {
          mgr.tick(dt);
          statHits += checkAgfHits(a1, obbs).satHits;
        }, a1.enqueue({ type: "driveTo", waypoints: [{ x: ox + 35.25, y: oy + 0.05, heading: 0, docking: true }] }).then(() => { done = true; }), Math.round(45 / dt));
        assert.equal(done, true, `Bug2 orbit_rmin_docking_true dt=${dt}: must complete`);
        assert.equal(statHits, 0, `Bug2 orbit_rmin_docking_true dt=${dt}: statHits=${statHits}`);
        assert.ok(Math.hypot(a1.x - (ox + 35.25), a1.y - (oy + 0.05)) <= 0.15, `Bug2 dist=${Math.hypot(a1.x - (ox + 35.25), a1.y - (oy + 0.05))}`);
      } finally {
        mgr.dispose();
      }
    }
    {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      try {
        const a1 = mgr.spawnAgf("t5b30-b2s-a1", { pos: [ox + 35, oy, 0], heading: 0, carriedWcid: 4000012 });
        const m1 = mgr.spawnAmr("t5b30-b2s-m1", { pos: [ox + 35.0, oy + 2.8, 0], heading: 0, carriedWcid: 0 });
        let done = false;
        let vehHits = 0;
        await stepUntilSettled(() => {
          mgr.tick(dt);
          vehHits += countPairSatHits(getAgfObbs(a1), getAmrObbs(m1));
        }, a1.enqueue({ type: "driveTo", waypoints: [{ x: ox + 35.0, y: oy + 0.65, heading: 0, docking: true }] }).then(() => { done = true; }), Math.round(45 / dt));
        assert.equal(done, true, `Bug2 ORBIT_SLOW docking=true dt=${dt}: must complete`);
        assert.equal(vehHits, 0, `Bug2 ORBIT_SLOW docking=true dt=${dt}: vehHits=${vehHits}`);
      } finally {
        mgr.dispose();
      }
    }

    // 3. Bug 3: agf_1.55 (carriedWcid 4000013 & 0), agf_1.70, and amr_1.55
    for (const cfg of [
      { label: "agf_1.55_w4000013", isAgf: true, d: 1.55, h: Math.PI * 0.5, w: 4000013 },
      { label: "agf_1.55_w0", isAgf: true, d: 1.55, h: Math.PI * 0.5, w: 0 },
      { label: "agf_1.70_w4000013", isAgf: true, d: 1.70, h: Math.PI * 0.5, w: 4000013 },
      { label: "amr_1.55_w4000014", isAgf: false, d: 1.55, h: 0, w: 4000014 },
    ]) {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      try {
        const a1 = mgr.spawnAgf("t5b30-b3-a1", { pos: [ox + 35, oy - 4, 0], heading: 0, carriedWcid: 4000012 });
        const peer = cfg.isAgf
          ? mgr.spawnAgf("t5b30-b3-peer", { pos: [ox + 35, oy + cfg.d, 0], heading: cfg.h, carriedWcid: cfg.w })
          : mgr.spawnAmr("t5b30-b3-peer", { pos: [ox + 35, oy + cfg.d, 0], heading: cfg.h, carriedWcid: cfg.w });
        let done = false;
        let vehHits = 0;
        let statHits = 0;
        await stepUntilSettled(() => {
          mgr.tick(dt);
          vehHits += countPairSatHits(getAgfObbs(a1), cfg.isAgf ? getAgfObbs(peer) : getAmrObbs(peer));
          statHits += checkAgfHits(a1, obbs).satHits;
        }, a1.enqueue({ type: "driveTo", waypoints: [{ x: ox + 35, y: oy }] }).then(() => { done = true; }), Math.round(60 / dt));
        assert.equal(done, true, `Bug3 ${cfg.label} dt=${dt}: must complete`);
        assert.equal(vehHits, 0, `Bug3 ${cfg.label} dt=${dt}: vehHits=${vehHits}`);
        assert.equal(statHits, 0, `Bug3 ${cfg.label} dt=${dt}: statHits=${statHits}`);
        assert.ok(Math.hypot(a1.x - (ox + 35), a1.y - oy) <= 0.15, `Bug3 ${cfg.label} dist=${Math.hypot(a1.x - (ox + 35), a1.y - oy)}`);
      } finally {
        mgr.dispose();
      }
    }

    // 4. Bug 4: MIN_1427_M3 (seed=20261427)
    {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap).filter((b) => b.id !== "S15");
      try {
        const a2 = mgr.spawnAgf("t5b30-b4-a2", { pos: [ox - 1.5, oy - 21.94, 0], heading: Math.PI, carriedWcid: 0 });
        const m3 = mgr.spawnAmr("t5b30-b4-m3", { pos: [ox - 0.18, oy - 19.99, 0], heading: 5.20, carriedWcid: 4000013 });
        let done = false;
        let vehHits = 0;
        let statHits = 0;
        await stepUntilSettled(() => {
          mgr.tick(dt);
          vehHits += countPairSatHits(getAgfObbs(a2), getAmrObbs(m3));
          for (const b of obbs) {
            if (satObbHit(m3.x, m3.y, m3.heading, 0.39, 0.52, b)) statHits++;
          }
        }, m3.enqueue({ type: "placeOnStand", standId: "S15" }).then(() => { done = true; }), Math.round(60 / dt));
        assert.equal(done, true, `Bug4 MIN_1427_M3 dt=${dt}: must complete`);
        assert.equal(vehHits, 0, `Bug4 MIN_1427_M3 dt=${dt}: vehHits=${vehHits}`);
        assert.equal(statHits, 0, `Bug4 MIN_1427_M3 dt=${dt}: statHits=${statHits}`);
        assert.equal(mgr.stands.get("S15").carriedWcid, 4000013, `Bug4 MIN_1427_M3 dt=${dt}: cargo placed on S15`);
      } finally {
        mgr.dispose();
      }
    }

    // Bug 4b: mixed AGF/AMR 1.218m tight-pair deadlock (a6 driveTo + m9 placeOnStand S18)
    {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      try {
        const a6 = mgr.spawnAgf("t5b30-b4b-a6", { pos: [ox - 18.525, oy - 27.967, 0], heading: 6.18, carriedWcid: 0 });
        const m9 = mgr.spawnAmr("t5b30-b4b-m9", { pos: [ox - 17.373, oy - 27.57, 0], heading: 2.84, carriedWcid: 4000013 });
        let doneA6 = false;
        let doneM9 = false;
        let vehHits = 0;
        await stepUntilSettled(() => {
          mgr.tick(dt);
          vehHits += countPairSatHits(getAgfObbs(a6), getAmrObbs(m9));
        }, Promise.all([
          a6.enqueue({ type: "driveTo", waypoints: [[ox - 17.774, oy - 25.145]] }).then(() => { doneA6 = true; }),
          m9.enqueue({ type: "placeOnStand", standId: "S18" }).then(() => { doneM9 = true; }),
        ]), Math.round(60 / dt));
        assert.equal(doneA6, true, `Bug4b 20261445 a6 dt=${dt}: must complete`);
        assert.equal(doneM9, true, `Bug4b 20261445 m9 dt=${dt}: must complete`);
        assert.equal(vehHits, 0, `Bug4b 20261445 dt=${dt}: vehHits=${vehHits}`);
        assert.equal(mgr.stands.get("S18").carriedWcid, 4000013, `Bug4b 20261445 dt=${dt}: cargo placed on S18`);
      } finally {
        mgr.dispose();
      }
    }
  }
});

test("B", "T5-B31 (challenger_22 Bugs 1-5): amr_pallet static 3D SAT-OBB, agf_pallet/agf_forks static 3D SAT-OBB (S5/R1), aisle A1..A3 docking=true, agf_side_by_side_1.45, & MIN_1464_a5 across dt=1/60 & 1/30", async () => {
  const zOverlap = (aMin, aMax, bMin, bMax) => aMin < bMax - 1e-4 && aMax > bMin + 1e-4;
  const buildStatic3d = (mgr, containersMap) => {
    const out = [];
    for (const r of mgr.racks.values()) {
      const b = r.worldBounds;
      if (b) out.push({ id: r.id, cx: (b.minX + b.maxX) * 0.5, cy: (b.minY + b.maxY) * 0.5, h: 0, hw: (b.maxX - b.minX) * 0.5, hl: (b.maxY - b.minY) * 0.5, minZ: 0, maxZ: 7.6 });
    }
    for (const st of mgr.stands.values()) {
      out.push({ id: st.id, cx: st.pos[0], cy: st.pos[1], h: st.heading || 0, hw: WS.STAND_SPECS.outerWidthM * 0.5, hl: WS.STAND_SPECS.outerDepthM * 0.5, minZ: 0, maxZ: WS.STAND_SPECS.railHeightM });
    }
    for (const lt of mgr.liftTables.values()) {
      out.push({ id: lt.id, cx: lt.x, cy: lt.y, h: 0, hw: WS.LIFT_TABLE_SPECS.outerWidthM * 0.5, hl: WS.LIFT_TABLE_SPECS.outerDepthM * 0.5, minZ: 0, maxZ: WS.LIFT_TABLE_SPECS.raisedZ });
    }
    for (const c of mgr.chargers.values()) {
      out.push({ id: c.id, cx: c.pos[0], cy: c.pos[1], h: c.heading || 0, hw: WS.CHARGER_SPECS.widthM * 0.5, hl: WS.CHARGER_SPECS.depthM * 0.5, minZ: 0, maxZ: WS.CHARGER_SPECS.heightM });
    }
    for (const ce of containersMap.values()) {
      const p = ce.rawPos;
      out.push({ id: `C_${ce.guid}`, cx: p[0], cy: p[1], h: ce.heading || 0, hw: 1.219, hl: ce.kind === 10 ? 3.029 : 6.096, minZ: 0, maxZ: 2.896 });
    }
    return out;
  };
  const agfParts3d = (a) => {
    const s = Math.sin(a.heading), c = Math.cos(a.heading);
    const fz = a.forkHeightM ?? 0.085;
    const parts = [
      { cx: a.x - 0.89 * s, cy: a.y - 0.89 * c, h: a.heading, hw: 0.57, hl: 1.04, minZ: 0, maxZ: 2.15 },
      { cx: a.x + 0.725 * s, cy: a.y + 0.725 * c, h: a.heading, hw: 0.34, hl: 0.575, minZ: fz, maxZ: fz + 0.05 },
    ];
    if (a.carriedWcid) {
      parts.push({ cx: a.x + WS.AGF_SPECS.cargoCenterY * s, cy: a.y + WS.AGF_SPECS.cargoCenterY * c, h: a.heading, hw: 0.55, hl: 0.55, minZ: fz, maxZ: fz + 1.80 });
    }
    return parts;
  };
  const amrParts3d = (m) => {
    const lz = m.liftHeightM ?? WS.AMR_SPECS.loweredHeightM;
    const parts = [{ cx: m.x, cy: m.y, h: m.heading, hw: 0.39, hl: 0.52, minZ: 0, maxZ: 0.32 }];
    if (m.carriedWcid) {
      parts.push({ cx: m.x, cy: m.y, h: m.heading + (m.turntableYawRad || 0), hw: 0.55, hl: 0.55, minZ: lz, maxZ: lz + 1.80 });
    }
    return parts;
  };
  const countStatic3d = (parts, statics, exemptIds = null) => {
    let hits = 0;
    for (const sb of statics) {
      if (exemptIds && exemptIds.has(sb.id)) continue;
      for (const p of parts) {
        if (zOverlap(p.minZ, p.maxZ, sb.minZ, sb.maxZ) && satObbHit(p.cx, p.cy, p.h, p.hw, p.hl, sb)) hits++;
      }
    }
    return hits;
  };
  const countPair3d = (pa, pb) => {
    let hits = 0;
    for (const a of pa) for (const b of pb) {
      if (zOverlap(a.minZ, a.maxZ, b.minZ, b.maxZ) && satObbHit(a.cx, a.cy, a.h, a.hw, a.hl, b)) hits++;
    }
    return hits;
  };

  for (const dt of [1 / 60, 1 / 30]) {
    // Bug 1: amr_pallet vs R1 (20261429 / Repro3_h0_clean_t0)
    {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const statics = buildStatic3d(mgr, cMap);
      try {
        const m1 = mgr.spawnAmr("t5b31-b1-m1", { pos: [ox - 13.818, oy + 6.617, 0], heading: 0, carriedWcid: 4000013 });
        let statHits = 0, active = 1;
        await stepUntilSettled(() => {
          mgr.tick(dt);
          statHits += countStatic3d(amrParts3d(m1), statics);
        }, m1.enqueue({ type: "driveTo", waypoints: [[ox - 27.772, oy - 0.152]] }).then(() => { active = 0; }), Math.round(45 / dt));
        assert.equal(active, 0, `Bug1 dt=${dt}: active === 0`);
        assert.equal(statHits, 0, `Bug1 dt=${dt}: amr_pallet static 3D SAT hits=${statHits}`);
      } finally {
        mgr.dispose();
      }
    }

    // Bug 2a: agf_pallet vs S18 during placeOnStand S5 (UNSEEN_20261465)
    {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const statics = buildStatic3d(mgr, cMap);
      const exemptS5 = new Set(["S5"]);
      try {
        const a0 = mgr.spawnAgf("t5b31-b2a-a0", { pos: [ox - 12.181, oy - 33.767, 0], heading: 1.468, carriedWcid: 4000012 });
        let statHits = 0, active = 1;
        await stepUntilSettled(() => {
          mgr.tick(dt);
          statHits += countStatic3d(agfParts3d(a0), statics, exemptS5);
        }, a0.enqueue({ type: "placeOnStand", standId: "S5" }).then(() => { active = 0; }), Math.round(90 / dt));
        assert.equal(active, 0, `Bug2a 20261465 dt=${dt}: active === 0`);
        assert.equal(statHits, 0, `Bug2a 20261465 dt=${dt}: AGF static 3D SAT hits=${statHits}`);
        assert.equal(mgr.stands.get("S5").carriedWcid, 4000012, `Bug2a 20261465 dt=${dt}: placed on S5`);
      } finally {
        mgr.dispose();
      }
    }

    // Bug 2b: agf_forks/agf_pallet past R1 SW corner (20261457-style driveTo)
    {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const statics = buildStatic3d(mgr, cMap);
      try {
        const a1 = mgr.spawnAgf("t5b31-b2b-a1", { pos: [ox - 19.449, oy - 31.367, 0], heading: -1.91, carriedWcid: 4000012 });
        let statHits = 0, active = 1;
        await stepUntilSettled(() => {
          mgr.tick(dt);
          statHits += countStatic3d(agfParts3d(a1), statics);
        }, a1.enqueue({ type: "driveTo", waypoints: [[ox - 5.0, oy + 3.0]] }).then(() => { active = 0; }), Math.round(90 / dt));
        assert.equal(active, 0, `Bug2b 20261457 dt=${dt}: active === 0`);
        assert.equal(statHits, 0, `Bug2b 20261457 dt=${dt}: AGF static 3D SAT hits=${statHits}`);
      } finally {
        mgr.dispose();
      }
    }

    // Bug 3: aisle A1..A3 docking=true (0 & 4000012)
    for (const [an, ay] of [["A1", 3.0], ["A2", -3.0], ["A3", -9.0]]) {
      for (const wcid of [0, 4000012]) {
        const cMap = makeDefaultContainers();
        const rig = makeRig();
        const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
        mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
        const statics = buildStatic3d(mgr, cMap);
        try {
          const a = mgr.spawnAgf(`t5b31-b3-${an}-${wcid}`, { pos: [ox - 8.0, oy + ay, 0], heading: Math.PI * 0.5, carriedWcid: wcid });
          let statHits = 0, active = 1;
          await stepUntilSettled(() => {
            mgr.tick(dt);
            statHits += countStatic3d(agfParts3d(a), statics);
          }, a.enqueue({ type: "driveTo", waypoints: [{ x: ox - 7.95, y: oy + ay - 0.25, heading: Math.PI * 0.5, docking: true }] }).then(() => { active = 0; }), Math.round(45 / dt));
          assert.equal(active, 0, `Bug3 ${an} w=${wcid} dt=${dt}: active === 0`);
          assert.equal(statHits, 0, `Bug3 ${an} w=${wcid} dt=${dt}: statHits=${statHits}`);
        } finally {
          mgr.dispose();
        }
      }
    }

    // Bug 4: AGF side-by-side 1.45 m idle peer
    for (const h2 of [Math.PI * 0.5, -Math.PI * 0.5]) {
      for (const w2 of [0, 4000013]) {
        const cMap = makeDefaultContainers();
        const rig = makeRig();
        const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
        mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
        const statics = buildStatic3d(mgr, cMap);
        try {
          const a1 = mgr.spawnAgf("t5b31-b4-a1", { pos: [ox + 35, oy - 5, 0], heading: 0, carriedWcid: 4000012 });
          const a2 = mgr.spawnAgf("t5b31-b4-a2", { pos: [ox + 35, oy + 1.45, 0], heading: h2, carriedWcid: w2 });
          let vehHits = 0, statHits = 0, active = 1;
          await stepUntilSettled(() => {
            mgr.tick(dt);
            vehHits += countPair3d(agfParts3d(a1), agfParts3d(a2));
            statHits += countStatic3d(agfParts3d(a1), statics);
          }, a1.enqueue({ type: "driveTo", waypoints: [{ x: ox + 35, y: oy }] }).then(() => { active = 0; }), Math.round(60 / dt));
          assert.equal(active, 0, `Bug4 h2=${h2.toFixed(2)} w2=${w2} dt=${dt}: active === 0`);
          assert.equal(vehHits, 0, `Bug4 h2=${h2.toFixed(2)} w2=${w2} dt=${dt}: vehHits=${vehHits}`);
          assert.equal(statHits, 0, `Bug4 h2=${h2.toFixed(2)} w2=${w2} dt=${dt}: statHits=${statHits}`);
        } finally {
          mgr.dispose();
        }
      }
    }

    // Bug 5: MIN_1464_a5 (UNSEEN_20261464)
    {
      const cMap = makeDefaultContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const statics = buildStatic3d(mgr, cMap);
      const exemptR23 = new Set(["R2_3"]);
      try {
        const a5 = mgr.spawnAgf("t5b31-b5-a5", { pos: [ox - 18.71, oy - 23.73, 0], heading: 1.04, carriedWcid: 4000012 });
        const a0 = mgr.spawnAgf("t5b31-b5-a0", { pos: [ox - 23.757, oy - 26.247, 0], heading: 2.77, carriedWcid: 0 });
        let vehHits = 0, statHits = 0, active = 1;
        await stepUntilSettled(() => {
          mgr.tick(dt);
          vehHits += countPair3d(agfParts3d(a5), agfParts3d(a0));
          statHits += countStatic3d(agfParts3d(a5), statics, exemptR23);
        }, a5.enqueue({ type: "placeInRack", rackId: "R2_3", bay: 3, tier: 1, side: 1, slotInBay: 1 }).then(() => { active = 0; }), Math.round(120 / dt));
        assert.equal(active, 0, `Bug5 MIN_1464_a5 dt=${dt}: active === 0`);
        assert.equal(vehHits, 0, `Bug5 MIN_1464_a5 dt=${dt}: vehHits=${vehHits}`);
        assert.equal(statHits, 0, `Bug5 MIN_1464_a5 dt=${dt}: statHits=${statHits}`);
        assert.equal(mgr.racks.get("R2_3").loadedSlots.has("1:3:1:1"), true, `Bug5 MIN_1464_a5 dt=${dt}: slot loaded`);
      } finally {
        mgr.dispose();
      }
    }
  }
});

test("B", "T5-B32 (Cycle 22/23 findings 1-5): allowCloseDockObs removal + dst.docking, BUG1_1469, SOLO_CONTAINER, BUG2_1427, & MIN_1464_a4 across dt=1/60 & 1/30", async () => {
  const zOverlap = (aMin, aMax, bMin, bMax) => aMin < bMax - 1e-4 && aMax > bMin + 1e-4;
  const buildStatic3d = (mgr, containersMap) => {
    const out = [];
    for (const r of mgr.racks.values()) {
      const b = r.worldBounds;
      if (b) out.push({ id: r.id, cx: (b.minX + b.maxX) * 0.5, cy: (b.minY + b.maxY) * 0.5, h: 0, hw: (b.maxX - b.minX) * 0.5, hl: (b.maxY - b.minY) * 0.5, minZ: 0, maxZ: 7.6 });
    }
    for (const st of mgr.stands.values()) {
      out.push({ id: st.id, cx: st.pos[0], cy: st.pos[1], h: st.heading || 0, hw: WS.STAND_SPECS.outerWidthM * 0.5, hl: WS.STAND_SPECS.outerDepthM * 0.5, minZ: 0, maxZ: WS.STAND_SPECS.railHeightM });
    }
    for (const lt of mgr.liftTables.values()) {
      out.push({ id: lt.id, cx: lt.x, cy: lt.y, h: 0, hw: WS.LIFT_TABLE_SPECS.outerWidthM * 0.5, hl: WS.LIFT_TABLE_SPECS.outerDepthM * 0.5, minZ: 0, maxZ: WS.LIFT_TABLE_SPECS.raisedZ });
    }
    for (const c of mgr.chargers.values()) {
      out.push({ id: c.id, cx: c.pos[0], cy: c.pos[1], h: c.heading || 0, hw: WS.CHARGER_SPECS.widthM * 0.5, hl: WS.CHARGER_SPECS.depthM * 0.5, minZ: 0, maxZ: WS.CHARGER_SPECS.heightM });
    }
    for (const ce of containersMap.values()) {
      const p = ce.rawPos;
      out.push({ id: `C_${ce.guid}`, cx: p[0], cy: p[1], h: ce.heading || 0, hw: 1.219, hl: ce.kind === 10 ? 3.029 : 6.096, minZ: 0, maxZ: 2.896 });
    }
    return out;
  };
  const agfParts3d = (a) => {
    const s = Math.sin(a.heading), c = Math.cos(a.heading);
    const fz = a.forkHeightM ?? 0.085;
    const parts = [
      { cx: a.x - 0.89 * s, cy: a.y - 0.89 * c, h: a.heading, hw: 0.57, hl: 1.04, minZ: 0, maxZ: 2.15 },
      { cx: a.x + 0.725 * s, cy: a.y + 0.725 * c, h: a.heading, hw: 0.34, hl: 0.575, minZ: fz, maxZ: fz + 0.05 },
    ];
    if (a.carriedWcid) {
      parts.push({ cx: a.x + WS.AGF_SPECS.cargoCenterY * s, cy: a.y + WS.AGF_SPECS.cargoCenterY * c, h: a.heading, hw: 0.55, hl: 0.55, minZ: fz, maxZ: fz + 1.80 });
    }
    return parts;
  };
  const amrParts3d = (m) => {
    const lz = m.liftHeightM ?? WS.AMR_SPECS.loweredHeightM;
    const parts = [{ cx: m.x, cy: m.y, h: m.heading, hw: 0.39, hl: 0.52, minZ: 0, maxZ: 0.32 }];
    if (m.carriedWcid) {
      parts.push({ cx: m.x, cy: m.y, h: m.heading + (m.turntableYawRad || 0), hw: 0.55, hl: 0.55, minZ: lz, maxZ: lz + 1.80 });
    }
    return parts;
  };
  const countStatic3d = (parts, statics, exemptIds = null) => {
    let hits = 0;
    for (const sb of statics) {
      if (exemptIds && exemptIds.has(sb.id)) continue;
      for (const p of parts) {
        if (zOverlap(p.minZ, p.maxZ, sb.minZ, sb.maxZ) && satObbHit(p.cx, p.cy, p.h, p.hw, p.hl, sb)) hits++;
      }
    }
    return hits;
  };
  const countPair3d = (pa, pb) => {
    let hits = 0;
    for (const a of pa) for (const b of pb) {
      if (zOverlap(a.minZ, a.maxZ, b.minZ, b.maxZ) && satObbHit(a.cx, a.cy, a.h, a.hw, a.hl, b)) hits++;
    }
    return hits;
  };
  const makeStdContainers = () => {
    const map = new Map();
    for (const d of [
      { guid: 1, kind: 10, pos: [ox - 20, oy + 21, 0] },
      { guid: 2, kind: 11, pos: [ox - 20, oy + 12, 0] },
      { guid: 3, kind: 12, pos: [ox - 12, oy + 21, 0] },
    ]) {
      map.set(d.guid, {
        guid: d.guid,
        wcid: d.kind === 10 ? 4000020 : d.kind === 11 ? 4000021 : 4000022,
        kind: d.kind,
        heading: 0,
        rawPos: [...d.pos],
        currentDoorProgress: 1.0,
        mountedOnTrailerGuid: 0,
        slots: [],
        model: { root: { position: { x: d.pos[0], y: d.pos[1], z: 0 } }, syncSlots() {} },
      });
    }
    return map;
  };

  for (const dt of [1 / 60, 1 / 30]) {
    // Finding 1a: clearDst_180turn_A1_near_R1 & clearDst_empty_180turn_A1_near_R1 settle cleanly with 0 hits
    for (const [label, wcid] of [["clearDst_180turn_A1_near_R1", 4000012], ["clearDst_empty_180turn_A1_near_R1", 0]]) {
      const cMap = new Map();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const statics = buildStatic3d(mgr, cMap);
      try {
        const a = mgr.spawnAgf(`t5b32-${label}`, { pos: [ox - 8, oy + 3.55, 0], heading: -Math.PI * 0.5, carriedWcid: wcid });
        let done = false, rej = null, statHits = 0;
        a.enqueue({ type: "driveTo", waypoints: [{ x: ox - 7.8, y: oy + 3.55, heading: Math.PI * 0.5, docking: true }] }).then(() => { done = true; }, (e) => { rej = e?.message || String(e); done = true; });
        for (let s = 0; s < Math.round(90 / dt) && !done; s++) {
          mgr.tick(dt);
          if (s % 20 === 19) await Promise.resolve();
          statHits += countStatic3d(agfParts3d(a), statics);
        }
        await Promise.resolve();
        assert.equal(done, true, `${label} dt=${dt}: settled`);
        assert.equal(rej, null, `${label} dt=${dt}: unexpected err ${rej}`);
        assert.equal(statHits, 0, `${label} dt=${dt}: statHits=${statHits}`);
      } finally {
        mgr.dispose();
      }
    }

    // Finding 1b: AdvDock_adv_dockTrue_turn_near_R1 & AdvDock_adv_dockTrue_into_R1 reject AGF route unreachable with 0 hits
    for (const [label, pos, h, wp] of [
      ["AdvDock_adv_dockTrue_turn_near_R1", [ox - 8, oy + 3.85, 0], Math.PI * 0.5, { x: ox - 7.8, y: oy + 3.85, heading: Math.PI * 0.2, docking: true }],
      ["AdvDock_adv_dockTrue_into_R1", [ox - 8, oy + 3.5, 0], 0, { x: ox - 8, y: oy + 4.35, heading: 0, docking: true }],
    ]) {
      const cMap = new Map();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const statics = buildStatic3d(mgr, cMap);
      try {
        const a = mgr.spawnAgf(`t5b32-${label}`, { pos, heading: h, carriedWcid: 4000012 });
        let done = false, rej = null, statHits = 0;
        a.enqueue({ type: "driveTo", waypoints: [wp] }).then(() => { done = true; }, (e) => { rej = e?.message || String(e); done = true; });
        for (let s = 0; s < Math.round(30 / dt) && !done; s++) {
          mgr.tick(dt);
          if (s % 20 === 19) await Promise.resolve();
          statHits += countStatic3d(agfParts3d(a), statics);
        }
        await Promise.resolve();
        assert.equal(done, true, `${label} dt=${dt}: settled`);
        assert.match(String(rej), /unreachable/i, `${label} dt=${dt}: expected unreachable, got ${rej}`);
        assert.equal(statHits, 0, `${label} dt=${dt}: statHits=${statHits}`);
      } finally {
        mgr.dispose();
      }
    }

    // Finding 2: BUG1_1469 (m6 dockCharge CH4 + m7 driveTo, 0 3D SAT-OBB hits across both)
    {
      const cMap = makeStdContainers();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const statics = buildStatic3d(mgr, cMap);
      const exemptCh4 = new Set(["CH4"]);
      try {
        const m6 = mgr.spawnAmr("t5b32-bug1-m6", { pos: [ox - 27.476, oy + 33.898, 0], heading: 1.048, carriedWcid: 4000013 });
        const m7 = mgr.spawnAmr("t5b32-bug1-m7", { pos: [ox - 24.143, oy + 33.904, 0], heading: -2.704, carriedWcid: 4000013 });
        let d6 = false, e6 = null, d7 = false, e7 = null, statHits = 0, vehHits = 0;
        m6.enqueue({ type: "dockCharge", chargerId: "CH4" }).then(() => { d6 = true; }, (e) => { e6 = e?.message || String(e); d6 = true; });
        m7.enqueue({ type: "driveTo", waypoints: [[ox - 3.843, oy - 35.712]] }).then(() => { d7 = true; }, (e) => { e7 = e?.message || String(e); d7 = true; });
        for (let s = 0; s < Math.round(180 / dt) && !(d6 && d7); s++) {
          mgr.tick(dt);
          if (s % 20 === 19) await Promise.resolve();
          const p6 = amrParts3d(m6);
          const p7 = amrParts3d(m7);
          statHits += countStatic3d(p6, statics, exemptCh4) + countStatic3d(p7, statics);
          vehHits += countPair3d(p6, p7);
        }
        await Promise.resolve();
        assert.equal(d6 && d7, true, `BUG1_1469 dt=${dt}: d6=${d6} d7=${d7}`);
        assert.equal(e6, null, `BUG1_1469 m6 dt=${dt}: err=${e6}`);
        assert.equal(e7, null, `BUG1_1469 m7 dt=${dt}: err=${e7}`);
        assert.equal(statHits, 0, `BUG1_1469 dt=${dt}: statHits=${statHits}`);
        assert.equal(vehHits, 0, `BUG1_1469 dt=${dt}: vehHits=${vehHits}`);
      } finally {
        mgr.dispose();
      }
    }

    // Finding 3: SOLO_CONTAINER kind 11 & 12, slotIndex 0 & 2 from North sy=32
    for (const kind of [11, 12]) {
      for (const slotIndex of [0, 2]) {
        const cMap = new Map([[2, {
          guid: 2,
          wcid: kind === 11 ? 4000021 : 4000022,
          kind,
          heading: 0,
          rawPos: [ox - 20, oy + 18, 0],
          currentDoorProgress: 1.0,
          mountedOnTrailerGuid: 0,
          slots: [],
          model: { root: { position: { x: ox - 20, y: oy + 18, z: 0 } }, syncSlots() {} },
        }]]);
        const rig = makeRig();
        const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
        mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
        const statics = buildStatic3d(mgr, cMap);
        const exemptC2 = new Set(["C_2"]);
        try {
          const a = mgr.spawnAgf(`t5b32-solo-k${kind}-s${slotIndex}`, { pos: [ox - 20, oy + 32, 0], heading: -Math.PI * 0.5, carriedWcid: 4000012 });
          let done = false, err = null, statHits = 0;
          a.enqueue({ type: "loadIntoContainer", containerGuid: 2, slotIndex }).then(() => { done = true; }, (e) => { err = e?.message || String(e); done = true; });
          for (let s = 0; s < Math.round(120 / dt) && !done; s++) {
            mgr.tick(dt);
            if (s % 20 === 19) await Promise.resolve();
            const inOpenDoorway = Math.abs(a.x - (ox - 20)) + (a.carriedWcid ? 0.55 : 0.34) < 1.176 - 0.01 &&
              Math.abs(Math.sin(a.heading)) < 0.15 &&
              Math.cos(a.heading) > 0.9 &&
              a.y >= oy + 18 - 6.096 - 1.50 &&
              a.y <= oy + 18 + 6.096;
            statHits += countStatic3d(agfParts3d(a), statics, inOpenDoorway ? exemptC2 : null);
          }
          await Promise.resolve();
          assert.equal(done, true, `SOLO k=${kind} slot=${slotIndex} dt=${dt}: settled`);
          assert.equal(err, null, `SOLO k=${kind} slot=${slotIndex} dt=${dt}: err=${err}`);
          assert.equal(a.carriedWcid, 0, `SOLO k=${kind} slot=${slotIndex} dt=${dt}: carriedWcid === 0`);
          assert.equal(statHits, 0, `SOLO k=${kind} slot=${slotIndex} dt=${dt}: statHits=${statHits}`);
        } finally {
          mgr.dispose();
        }
      }
    }

    // Finding 4: BUG2_1427 (2-agent AGF West-spine driveTo livelock fix)
    {
      const cMap = new Map();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const statics = buildStatic3d(mgr, cMap);
      try {
        const a0 = mgr.spawnAgf("t5b32-bug2-a0", { pos: [ox + 21.596, oy - 29.433, 0], heading: 1.423, carriedWcid: 4000012 });
        const a1 = mgr.spawnAgf("t5b32-bug2-a1", { pos: [ox - 41.76, oy - 34.98, 0], heading: -2.42, carriedWcid: 0 });
        let d0 = false, e0 = null, d1 = false, e1 = null, vehHits = 0, statHits = 0;
        a0.enqueue({ type: "driveTo", waypoints: [{ x: ox - 35.169, y: oy + 12.301 }] }).then(() => { d0 = true; }, (e) => { e0 = e?.message || String(e); d0 = true; });
        a1.enqueue({ type: "driveTo", waypoints: [{ x: ox - 26.144, y: oy - 14.524 }] }).then(() => { d1 = true; }, (e) => { e1 = e?.message || String(e); d1 = true; });
        for (let s = 0; s < Math.round(120 / dt) && !(d0 && d1); s++) {
          mgr.tick(dt);
          if (s % 20 === 19) await Promise.resolve();
          const p0 = agfParts3d(a0);
          const p1 = agfParts3d(a1);
          vehHits += countPair3d(p0, p1);
          statHits += countStatic3d(p0, statics) + countStatic3d(p1, statics);
        }
        await Promise.resolve();
        assert.equal(d0 && d1, true, `BUG2_1427 dt=${dt}: d0=${d0} d1=${d1}`);
        assert.equal(e0, null, `BUG2_1427 a0 dt=${dt}: err=${e0}`);
        assert.equal(e1, null, `BUG2_1427 a1 dt=${dt}: err=${e1}`);
        assert.equal(vehHits, 0, `BUG2_1427 dt=${dt}: vehHits=${vehHits}`);
        assert.equal(statHits, 0, `BUG2_1427 dt=${dt}: statHits=${statHits}`);
      } finally {
        mgr.dispose();
      }
    }

    // Finding 5: MIN_1464_a4 (2-agent AGF R1 + R2_3 placeInRack livelock fix)
    {
      const cMap = new Map();
      const rig = makeRig();
      const mgr = createWarehouseManager({ THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(), palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh });
      mgr.buildHub({ origin: WS.NE_FLATLAND_SITE.origin });
      const statics = buildStatic3d(mgr, cMap);
      const exemptR1 = new Set(["R1"]);
      const exemptR23 = new Set(["R2_3"]);
      try {
        const a2 = mgr.spawnAgf("t5b32-min1464-a2", { pos: [ox + 13.787, oy + 12.142, 0], heading: 0.689, carriedWcid: 4000012 });
        const a4 = mgr.spawnAgf("t5b32-min1464-a4", { pos: [ox + 19.607, oy + 33.221, 0], heading: 3.124, carriedWcid: 4000012 });
        let d2 = false, e2 = null, d4 = false, e4 = null, vehHits = 0, statHits = 0;
        a2.enqueue({ type: "placeInRack", rackId: "R1", bay: 3, tier: 2, side: 0, slotInBay: 0, wcid: 4000012 }).then(() => { d2 = true; }, (e) => { e2 = e?.message || String(e); d2 = true; });
        a4.enqueue({ type: "placeInRack", rackId: "R2_3", bay: 2, tier: 3, side: 1, slotInBay: 1, wcid: 4000012 }).then(() => { d4 = true; }, (e) => { e4 = e?.message || String(e); d4 = true; });
        for (let s = 0; s < Math.round(180 / dt) && !(d2 && d4); s++) {
          mgr.tick(dt);
          if (s % 20 === 19) await Promise.resolve();
          const p2 = agfParts3d(a2);
          const p4 = agfParts3d(a4);
          vehHits += countPair3d(p2, p4);
          statHits += countStatic3d(p2, statics, exemptR1) + countStatic3d(p4, statics, exemptR23);
        }
        await Promise.resolve();
        assert.equal(d2 && d4, true, `MIN_1464_a4 dt=${dt}: d2=${d2} d4=${d4}`);
        assert.equal(e2, null, `MIN_1464_a4 a2 dt=${dt}: err=${e2}`);
        assert.equal(e4, null, `MIN_1464_a4 a4 dt=${dt}: err=${e4}`);
        assert.equal(vehHits, 0, `MIN_1464_a4 dt=${dt}: vehHits=${vehHits}`);
        assert.equal(statHits, 0, `MIN_1464_a4 dt=${dt}: statHits=${statHits}`);
        assert.equal(mgr.racks.get("R2_3").loadedSlots.has("1:2:3:1"), true, `MIN_1464_a4 dt=${dt}: R2_3 slot loaded`);
      } finally {
        mgr.dispose();
      }
    }
  }
});

let passedA = 0, failedA = 0, passedB = 0, failedB = 0;
for (const { part, name, fn } of queue) {
  try {
    await fn();
    if (part === "A") passedA++; else passedB++;
    console.log(`  [PASS][Part ${part}] ${name}`);
  } catch (e) {
    if (part === "A") failedA++; else failedB++;
    console.log(`  [FAIL][Part ${part}] ${name}: ${e?.message || e}`);
  }
}

console.log(`\n=== Tier 5 Summary: Part A ${passedA}/${passedA + failedA} PASS | Part B ${passedB}/${passedB + failedB} PASS (${failedB} open reproducers) ===`);
if (failedA > 0 || (partFlag !== "a" && failedB > 0)) {
  process.exit(1);
}
