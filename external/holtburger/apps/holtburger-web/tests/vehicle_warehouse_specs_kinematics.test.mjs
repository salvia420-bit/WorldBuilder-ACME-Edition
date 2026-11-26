// tests/vehicle_warehouse_specs_kinematics.test.mjs — Deterministic Warehouse Specs & Kinematics Unit Tests
//
// Run: node external/holtburger/apps/holtburger-web/tests/vehicle_warehouse_specs_kinematics.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as WS from "../scene3d/vehicle/warehouse_specs.js";
import * as WK from "../scene3d/vehicle/warehouse_kinematics.js";
import * as CL from "../scene3d/vehicle/container_logistics.js";
import { ISO_CONTAINER_SPECS } from "../scene3d/vehicle/container_models.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SPECS_PATH = join(HERE, "../scene3d/vehicle/warehouse_specs.js");
const KIN_PATH = join(HERE, "../scene3d/vehicle/warehouse_kinematics.js");

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [OK] ${name}`);
  } catch (e) {
    failed++;
    console.log(
      `  [FAIL] ${name}: ${e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e}`
    );
  }
}

function near(a, b, eps = 1e-6, msg = "near") {
  if (!Number.isFinite(a) || Math.abs(a - b) > eps) {
    throw new Error(`${msg}: expected ${b} +/- ${eps}, got ${a}`);
  }
}

function bfsReachable(nodes, edges, startId, mode = null) {
  const allowedNodes = new Set();
  for (const n of nodes) {
    if (!mode || n.allowedModes.includes(mode)) {
      allowedNodes.add(n.id);
    }
  }
  const adj = new Map();
  for (const id of allowedNodes) adj.set(id, []);
  for (const e of edges) {
    if (!allowedNodes.has(e.from) || !allowedNodes.has(e.to)) continue;
    if (mode && !e.allowedModes.includes(mode)) continue;
    adj.get(e.from).push(e.to);
    adj.get(e.to).push(e.from);
  }
  const visited = new Set();
  if (!allowedNodes.has(startId)) return { visited, allowedNodes };
  const q = [startId];
  visited.add(startId);
  while (q.length > 0) {
    const cur = q.shift();
    for (const nxt of adj.get(cur)) {
      if (!visited.has(nxt)) {
        visited.add(nxt);
        q.push(nxt);
      }
    }
  }
  return { visited, allowedNodes };
}

console.log("=== vehicle_warehouse_specs_kinematics.test.mjs ===");

check("import isolation: warehouse_specs (0 imports) & warehouse_kinematics (only specs + container_logistics)", () => {
  const specsSrc = readFileSync(SPECS_PATH, "utf8");
  const specsCode = specsSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.equal(/^\s*import\s+/m.test(specsCode), false, "warehouse_specs.js must have 0 imports");
  assert.equal(/\b(THREE|window|document)\b/.test(specsCode), false, "warehouse_specs.js must not reference DOM/Three");

  const kinSrc = readFileSync(KIN_PATH, "utf8");
  const kinCode = kinSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.equal(/\b(THREE|window|document)\b/.test(kinCode), false, "warehouse_kinematics.js must not reference DOM/Three");

  const importMatches = Array.from(kinCode.matchAll(/import\s+[\s\S]*?\s+from\s+["']([^"']+)["']/g)).map(
    (m) => m[1]
  );
  assert.deepEqual(
    importMatches.sort(),
    ["./container_logistics.js", "./warehouse_specs.js"],
    "warehouse_kinematics.js may import only ./warehouse_specs.js and ./container_logistics.js"
  );
});

check("reserved WCIDs (4000040-45) and DeployableKinds (17-22) have zero collisions", () => {
  const existingWcids = new Set([
    4000002,
    4000010, 4000011, 4000012, 4000013, 4000014, 4000015, 4000016, 4000017,
    4000020, 4000021, 4000022,
    4000030, 4000031, 4000032,
    4000035,
  ]);
  const newWcids = Object.values(WS.WAREHOUSE_WCID);
  assert.equal(newWcids.length, 6);
  assert.equal(new Set(newWcids).size, 6);
  for (const w of newWcids) {
    assert.ok(w >= 4000040 && w <= 4000045, `WCID ${w} out of 4000040..4000045`);
    assert.equal(existingWcids.has(w), false, `WCID collision on ${w}`);
  }

  const newKinds = Object.values(WS.WAREHOUSE_DEPLOYABLE_KIND);
  assert.equal(newKinds.length, 6);
  assert.equal(new Set(newKinds).size, 6);
  for (const k of newKinds) {
    assert.ok(k >= 17 && k <= 22, `DeployableKind ${k} out of 17..22`);
  }
});

check("NE Flatland site coordinates and BodyEdge bounds", () => {
  const s = WS.NE_FLATLAND_SITE;
  assert.equal(s.landblock, 0xe9f4);
  assert.deepEqual(Array.from(s.origin), [44832.0, 46944.0, 0.0]);
  assert.equal(s.teleCmd, "@tele 93.60N 84.80E");
  near(s.groundZ, 0.0, 1e-9);
  near(s.apronVisualZ, 0.004, 1e-9);
  assert.ok(s.worldMinX >= s.bodyEdgeMin && s.worldMaxX <= s.bodyEdgeMax);
  assert.ok(s.worldMinY >= s.bodyEdgeMin && s.worldMaxY <= s.bodyEdgeMax);
  near(s.worldMaxX - s.worldMinX, s.slabWidthM, 1e-6);
  near(s.worldMaxY - s.worldMinY, s.slabDepthM, 1e-6);
});

check("millimeter-locked dimensional interlocks & container_models parity", () => {
  // Container envelope parity with container_models.js & container_logistics.js
  for (const wcid of [4000020, 4000021, 4000022]) {
    const env = WS.CONTAINER_ENVELOPE_SPECS[wcid];
    const mod = ISO_CONTAINER_SPECS[wcid];
    const log = CL.CONTAINER_INTERIOR_SPECS[wcid];
    near(env.extW, mod.external.width, 1e-6);
    near(env.extL, mod.external.length, 1e-6);
    near(env.extH, mod.external.height, 1e-6);
    near(env.intW, mod.internal.width, 1e-6);
    near(env.intL, mod.internal.length, 1e-6);
    near(env.doorW, mod.door.width, 1e-6);
    near(env.doorH, mod.door.height, 1e-6);
    near(env.floorZ, log.floorZ, 1e-6);
  }

  // AGF clears container door and fits pallet tunnels
  const agf = WS.AGF_SPECS;
  const pal = WS.PALLET_ENVELOPE_SPECS;
  assert.ok(agf.collapsedMastHeightM < WS.CONTAINER_ENVELOPE_SPECS[4000021].doorH, "AGF mast clears 40ft door");
  assert.ok(agf.canopyHeightM < WS.CONTAINER_ENVELOPE_SPECS[4000021].doorH, "AGF canopy clears 40ft door");
  assert.ok(agf.overallWidthM < WS.CONTAINER_ENVELOPE_SPECS[4000021].doorW, "AGF width clears door");
  const bladeInner = agf.forkCenterX - agf.forkWidthM * 0.5;
  const bladeOuter = agf.forkCenterX + agf.forkWidthM * 0.5;
  assert.ok(bladeInner > pal.tunnelMinX && bladeOuter < pal.tunnelMaxX, "AGF fork blades fit pallet tunnel X");
  assert.ok(agf.forkThicknessM < pal.tunnelHeight, "AGF fork thickness fits pallet tunnel H");
  assert.ok(agf.forkMaxZ >= WS.RACK_SPECS.tierZ[3] + pal.deckUndersideZ + 0.05, "AGF reaches L3 beam lift-off");

  // AMR fits Transfer Stand & Lift Table tunnel and lifts clear above rails
  const amr = WS.AMR_SPECS;
  const st = WS.STAND_SPECS;
  const lt = WS.LIFT_TABLE_SPECS;
  assert.ok(amr.widthM < st.tunnelWidthM && amr.widthM < lt.tunnelWidthM, "AMR clears stand/lift tunnel width");
  assert.ok(amr.loweredHeightM < st.tunnelHeightM && amr.loweredHeightM < lt.tunnelHeightM, "AMR lowered clears tunnel H");
  assert.ok(amr.raisedHeightM > st.railHeightM && amr.raisedHeightM > lt.raisedZ, "AMR raised lifts pallet off rails");
  near(lt.railWidthM, 0.130, 1e-6);
  near(lt.loweredZ, 0.000, 1e-6);
  near(lt.raisedZ, st.railHeightM, 1e-6);

  // Rack clears 2.05 m stowed deployable + lift margin
  assert.ok(WS.RACK_SPECS.clearTierHeightM >= pal.stowedMaxHeightM + WS.RACK_SPECS.liftTravelM);
});

check("computeRackSlotLocalPose, computeRackRowBounds & buildDefaultHubLayout integrity", () => {
  assert.throws(() => WS.computeRackSlotLocalPose(-1, 0, 0), RangeError);
  assert.throws(() => WS.computeRackSlotLocalPose(0, 4, 0), RangeError);
  assert.throws(() => WS.computeRackSlotLocalPose(0, 0, 2), RangeError);

  const pSingle = WS.computeRackSlotLocalPose(0, 3, 0, WS.RACK_SPECS, { doubleSided: false });
  near(pSingle.x, 0.800, 1e-6);
  near(pSingle.y, 0.000, 1e-6);
  near(pSingle.z, 7.050, 1e-6);
  near(pSingle.approachY, -2.000, 1e-6);
  near(pSingle.approachHeading, 0.0, 1e-6);

  const pDoubleN = WS.computeRackSlotLocalPose(2, 1, 1, WS.RACK_SPECS, { doubleSided: true, side: 1 });
  near(pDoubleN.y, +0.650, 1e-6);
  near(pDoubleN.z, 2.350, 1e-6);
  near(pDoubleN.approachY, +2.650, 1e-6);
  near(pDoubleN.approachHeading, Math.PI, 1e-6);

  const bSingle = WS.computeRackRowBounds(8, false);
  near(bSingle.width, 22.500, 1e-6);
  near(bSingle.depth, 1.100, 1e-6);
  const bDouble = WS.computeRackRowBounds(8, true);
  near(bDouble.width, 22.500, 1e-6);
  near(bDouble.depth, 2.400, 1e-6);

  const hub = WS.buildDefaultHubLayout(WS.NE_FLATLAND_SITE.origin, { includeRackRowSlots: true });
  near(hub.slabBounds.width, 120.0, 1e-6);
  near(hub.slabBounds.depth, 90.0, 1e-6);
  assert.equal(hub.dropPads.length, 3);
  assert.equal(hub.stagingBays.length, 12);
  assert.equal(hub.liftTables.length, 2);
  assert.equal(hub.rackRows.length, 4);
  assert.equal(hub.totalRackSlots, 384);
  assert.equal(hub.stands.length, 18);
  assert.equal(hub.chargers.length, 8);

  // Pairwise 2D footprint non-overlap across all static hub structures
  const boxes = [];
  for (const p of hub.dropPads) {
    const env = WS.CONTAINER_ENVELOPE_SPECS[p.wcid];
    boxes.push({
      id: p.id,
      minX: p.pos[0] - env.extW * 0.5,
      maxX: p.pos[0] + env.extW * 0.5,
      minY: p.pos[1] - env.extL * 0.5,
      maxY: p.pos[1] + env.extL * 0.5,
    });
  }
  for (const sb of hub.stagingBays) {
    boxes.push({
      id: sb.id,
      minX: sb.pos[0] - sb.width * 0.5,
      maxX: sb.pos[0] + sb.width * 0.5,
      minY: sb.pos[1] - sb.depth * 0.5,
      maxY: sb.pos[1] + sb.depth * 0.5,
    });
  }
  for (const lt of hub.liftTables) {
    boxes.push({
      id: lt.id,
      minX: lt.pos[0] - WS.LIFT_TABLE_SPECS.outerWidthM * 0.5,
      maxX: lt.pos[0] + WS.LIFT_TABLE_SPECS.outerWidthM * 0.5,
      minY: lt.pos[1] - WS.LIFT_TABLE_SPECS.outerDepthM * 0.5,
      maxY: lt.pos[1] + WS.LIFT_TABLE_SPECS.outerDepthM * 0.5,
    });
  }
  for (const rr of hub.rackRows) {
    boxes.push({ id: rr.id, ...rr.bounds });
  }
  for (const st of hub.stands) {
    const rot = Math.abs(Math.sin(st.heading)) > 0.5;
    const hw = (rot ? WS.STAND_SPECS.outerDepthM : WS.STAND_SPECS.outerWidthM) * 0.5;
    const hd = (rot ? WS.STAND_SPECS.outerWidthM : WS.STAND_SPECS.outerDepthM) * 0.5;
    boxes.push({
      id: st.id,
      minX: st.pos[0] - hw,
      maxX: st.pos[0] + hw,
      minY: st.pos[1] - hd,
      maxY: st.pos[1] + hd,
    });
  }
  for (const ch of hub.chargers) {
    boxes.push({
      id: ch.id,
      minX: ch.pos[0] - WS.CHARGER_SPECS.widthM * 0.5,
      maxX: ch.pos[0] + WS.CHARGER_SPECS.widthM * 0.5,
      minY: ch.pos[1] - WS.CHARGER_SPECS.depthM * 0.5,
      maxY: ch.pos[1] + WS.CHARGER_SPECS.depthM * 0.5,
    });
  }

  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i];
    assert.ok(
      a.minX >= hub.slabBounds.minX &&
        a.maxX <= hub.slabBounds.maxX &&
        a.minY >= hub.slabBounds.minY &&
        a.maxY <= hub.slabBounds.maxY,
      `${a.id} inside slabBounds`
    );
    for (let j = i + 1; j < boxes.length; j++) {
      const b = boxes[j];
      const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
      const oy = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
      assert.ok(ox <= 1e-6 || oy <= 1e-6, `Footprint overlap between ${a.id} and ${b.id}`);
    }
  }

  // BFS graph reachability: combined, AGF-only, and AMR-only
  const allBfs = bfsReachable(hub.graph.nodes, hub.graph.edges, "cross_n45", null);
  assert.equal(allBfs.visited.size, allBfs.allowedNodes.size, "Combined waypoint graph must be 100% connected");

  const agfBfs = bfsReachable(hub.graph.nodes, hub.graph.edges, "pad_C1_approach", "agf");
  assert.equal(agfBfs.visited.size, agfBfs.allowedNodes.size, "AGF subgraph must be 100% connected");
  assert.ok(agfBfs.visited.has("S1_agf") && agfBfs.visited.has("S18_agf") && agfBfs.visited.has("L1_north"));

  const amrBfs = bfsReachable(hub.graph.nodes, hub.graph.edges, "L1_south", "amr");
  assert.equal(amrBfs.visited.size, amrBfs.allowedNodes.size, "AMR subgraph must be 100% connected");
  assert.ok(amrBfs.visited.has("S1_amr") && amrBfs.visited.has("S18_amr") && amrBfs.visited.has("CH8_dock"));

  const jackBfs = bfsReachable(hub.graph.nodes, hub.graph.edges, "L1_north", "jack");
  assert.equal(jackBfs.visited.size, jackBfs.allowedNodes.size, "Pallet Jack subgraph must be 100% connected");

  // Exact Euclidean edge lengths & Zone B AGF spine clearance from Lift Tables L1/L2
  const nodeById = new Map(hub.graph.nodes.map((n) => [n.id, n]));
  for (const e of hub.graph.edges) {
    const na = nodeById.get(e.from);
    const nb = nodeById.get(e.to);
    near(e.lengthM, Math.hypot(nb.x - na.x, nb.y - na.y), 1e-12, `edge length ${e.id}`);
  }
  const spineEdge = hub.graph.edges.find((e) => e.id === "E_zoneB_n10_zoneB_s_buf");
  assert.ok(spineEdge, "E_zoneB_n10_zoneB_s_buf must exist");
  const nB10 = nodeById.get("zoneB_n10");
  const nBSBuf = nodeById.get("zoneB_s_buf");
  near(nB10.localPos[0], -43.5, 1e-9);
  near(nBSBuf.localPos[0], -43.5, 1e-9);
  const agfHalfW = WS.AGF_SPECS.overallWidthM * 0.5;
  const spineMinX = Math.min(nB10.x, nBSBuf.x) - agfHalfW;
  const spineMaxX = Math.max(nB10.x, nBSBuf.x) + agfHalfW;
  const spineMinY = Math.min(nB10.y, nBSBuf.y);
  const spineMaxY = Math.max(nB10.y, nBSBuf.y);
  for (const lt of hub.liftTables) {
    const ltMinX = lt.pos[0] - WS.LIFT_TABLE_SPECS.outerWidthM * 0.5;
    const ltMaxX = lt.pos[0] + WS.LIFT_TABLE_SPECS.outerWidthM * 0.5;
    const ltMinY = lt.pos[1] - WS.LIFT_TABLE_SPECS.outerDepthM * 0.5;
    const ltMaxY = lt.pos[1] + WS.LIFT_TABLE_SPECS.outerDepthM * 0.5;
    const ovX = Math.min(spineMaxX, ltMaxX) - Math.max(spineMinX, ltMinX);
    const ovY = Math.min(spineMaxY, ltMaxY) - Math.max(spineMinY, ltMinY);
    assert.ok(ovX <= 0.0 || ovY <= 0.0, `Zone B AGF spine overlaps ${lt.id} (ovX=${ovX}, ovY=${ovY})`);
  }
});

check("computeMastStages freelift continuity, telescopic stages, and clamping", () => {
  const low = WK.computeMastStages(0.045);
  near(low.outerH, 2.160, 1e-6);
  near(low.stage2Offset, 0.0, 1e-6);
  near(low.stage3Offset, 0.0, 1e-6);
  near(low.carriageOffset, 0.0, 1e-6);
  assert.equal(low.freeliftActive, true);

  const midFree = WK.computeMastStages(1.700);
  near(midFree.outerH, 2.160, 1e-6);
  near(midFree.stage2Offset, 0.0, 1e-6);
  near(midFree.stage3Offset, 0.0, 1e-6);
  near(midFree.carriageOffset, 1.655, 1e-6);
  assert.equal(midFree.freeliftActive, true);

  const midTele = WK.computeMastStages(4.475);
  near(midTele.stage2Offset, 1.3875, 1e-6);
  near(midTele.stage3Offset, 2.775, 1e-6);
  near(midTele.carriageOffset, 4.430, 1e-6);
  assert.equal(midTele.freeliftActive, false);

  const top = WK.computeMastStages(7.250);
  near(top.stage2Offset, 2.775, 1e-6);
  near(top.stage3Offset, 5.550, 1e-6);
  near(top.carriageOffset, 7.205, 1e-6);
  assert.equal(top.freeliftActive, false);

  assert.deepEqual(WK.computeMastStages(-5), low);
  assert.deepEqual(WK.computeMastStages(99), top);
  assert.deepEqual(WK.computeMastStages(NaN), low);
});

check("stepAgfKinematics speed caps, steer clamp, forward & reverse convergence", () => {
  // Direct speed caps & steer clamp
  let empty = { x: 0, y: 0, heading: 0, speed: 0, forkHeightM: 0.045 };
  for (let i = 0; i < 120; i++) {
    empty = WK.stepAgfKinematics(empty, { speed: 10.0, steerAngleRad: 5.0 }, 1 / 60);
  }
  near(empty.speed, WS.AGF_SPECS.vMaxEmptyMps, 1e-6, "empty max speed 3.2");
  near(empty.steerAngleRad, WS.AGF_SPECS.maxSteerRad, 1e-6, "max steer clamp");

  let loaded = { x: 0, y: 0, heading: 0, speed: 0, forkHeightM: 0.045, carriedWcid: 4000010, loaded: true };
  for (let i = 0; i < 120; i++) {
    loaded = WK.stepAgfKinematics(loaded, { speed: 10.0 }, 1 / 60);
  }
  near(loaded.speed, WS.AGF_SPECS.vMaxLoadedMps, 1e-6, "loaded max speed 2.2");

  // Tip-over cap (> 0.50 m forks -> <= 0.6 m/s)
  let highFork = { x: 0, y: 0, heading: 0, speed: 3.0, forkHeightM: 0.80 };
  highFork = WK.stepAgfKinematics(highFork, { speed: 3.0 }, 1 / 60);
  assert.equal(highFork.tipOverSpeedCapped, true);
  assert.ok(Math.abs(highFork.speed) <= WS.AGF_SPECS.vTipOverCappedMps + 1e-9);

  // Forward multi-waypoint convergence to exact pose
  let agf = { x: 0, y: 0, heading: 0, forkHeightM: 0.10 };
  const targetFwd = { x: 2.0, y: 8.0, heading: 0.25 };
  const waypoints = [{ x: 1.0, y: 4.0 }, targetFwd];
  for (let i = 0; i < 600 && !agf.arrived; i++) {
    agf = WK.stepAgfKinematics(agf, { waypoints }, 1 / 60);
  }
  assert.equal(agf.arrived, true, "forward AGF should arrive");
  assert.equal(agf.poseAligned, true, "forward AGF should align heading");
  assert.ok(Math.hypot(agf.x - targetFwd.x, agf.y - targetFwd.y) <= WS.AGF_SPECS.dockPosTolM);
  assert.ok(Math.abs(WK.wrapPi(agf.heading - targetFwd.heading)) <= WS.AGF_SPECS.dockYawTolRad);

  // Reverse-docking convergence
  let rev = { x: 0.4, y: 5.0, heading: 0.1, forkHeightM: 0.10 };
  const targetRev = { x: 0.0, y: 0.0, heading: 0.0, reverse: true, docking: true };
  for (let i = 0; i < 900 && !rev.arrived; i++) {
    rev = WK.stepAgfKinematics(rev, { targetPose: targetRev }, 1 / 60);
  }
  assert.equal(rev.arrived, true, "reverse-docking AGF should arrive");
  assert.ok(Math.hypot(rev.x - targetRev.x, rev.y - targetRev.y) <= WS.AGF_SPECS.dockPosTolM);
  assert.ok(Math.abs(WK.wrapPi(rev.heading - targetRev.heading)) <= WS.AGF_SPECS.dockYawTolRad);
});

check("stepAgfKinematics roof-strike interlock & container LIFO enforcement", () => {
  const container = { x: 100.0, y: 200.0, heading: 0.0, wcid: 4000021, kind: 11 };

  // Inside container: commanding forkHeight 3.5 m is blocked at 1.700 m
  let agfIn = { x: 100.0, y: 198.0, heading: 0.0, forkHeightM: 1.50 };
  for (let i = 0; i < 60; i++) {
    agfIn = WK.stepAgfKinematics(
      agfIn,
      { targetForkHeightM: 3.50, speed: 3.0 },
      1 / 60,
      { container }
    );
  }
  assert.equal(agfIn.insideContainer, true);
  assert.equal(agfIn.roofStrikeBlocked, true);
  assert.ok(agfIn.forkHeightM <= WS.AGF_SPECS.containerMaxForkHeightM + 1e-9);
  assert.ok(agfIn.speed <= WS.AGF_SPECS.vContainerMps + 1e-9);

  // Outside container: rises cleanly above 1.700 m (2.0 m / 0.65 m/s = 3.08 s -> 240 ticks)
  let agfOut = { x: 100.0, y: 185.0, heading: 0.0, forkHeightM: 1.50 };
  for (let i = 0; i < 240; i++) {
    agfOut = WK.stepAgfKinematics(agfOut, { targetForkHeightM: 3.50 }, 1 / 60, { container });
  }
  assert.equal(agfOut.insideContainer, false);
  assert.equal(agfOut.roofStrikeBlocked, false);
  near(agfOut.forkHeightM, 3.50, 1e-4);

  // LIFO check: full 40ft container blocks slot 0 unload, permits slot 19 unload
  const occ40 = CL.CONTAINER_SLOTS_40.map((s) => ({
    slotIndex: s.slotIndex,
    palletSize: 2,
    cargoWcid: 4000010,
  }));
  const blockedRes = WK.stepAgfKinematics(
    { x: 100.0, y: 193.0, heading: 0.0, speed: 1.0 },
    {
      speed: 1.0,
      containerOp: { containerKind: 4000021, occupiedSlots: occ40, slotIndex: 0, op: "unload" },
    },
    1 / 60
  );
  assert.equal(blockedRes.lifoBlocked, true);
  assert.equal(blockedRes.speed, 0.0);
  assert.equal(blockedRes.statusMode, "blocked");

  const openRes = WK.stepAgfKinematics(
    { x: 100.0, y: 193.0, heading: 0.0, speed: 0.5 },
    {
      speed: 0.5,
      containerOp: { containerKind: 4000021, occupiedSlots: occ40, slotIndex: 19, op: "unload" },
    },
    1 / 60
  );
  assert.equal(openRes.lifoBlocked, false);
  assert.ok(openRes.speed > 0.0);
});

check("stepAmrKinematics zero-turn pivot, keepCargoHeading turntable & lift-lock", () => {
  // Zero-turn in-place 90 deg rotation (speed stays 0 while pivoting)
  let amr = { x: 0, y: 0, heading: 0.0, liftHeightM: 0.260, turntableYawRad: 0.0, heldCargoHeading: 0.0 };
  const targetEast = { x: 4.0, y: 0.0, heading: Math.PI * 0.5 };
  for (let i = 0; i < 40; i++) {
    amr = WK.stepAmrKinematics(amr, { targetPose: targetEast, keepCargoHeading: true, heldCargoHeading: 0.0 }, 1 / 60);
    if (Math.abs(WK.wrapPi(Math.PI * 0.5 - amr.heading)) > 0.26) {
      near(amr.speed, 0.0, 1e-6, "AMR zero-turn keeps speed === 0 during pivot");
      assert.ok(amr.wheelSpinL > amr.wheelSpinR, "CW turn requires L wheel faster than R wheel");
    }
    near(WK.wrapHeading(amr.heading + amr.turntableYawRad), 0.0, 1e-9, "keepCargoHeading world lock");
  }

  for (let i = 0; i < 600 && !amr.arrived; i++) {
    amr = WK.stepAmrKinematics(amr, { targetPose: targetEast, keepCargoHeading: true, heldCargoHeading: 0.0 }, 1 / 60);
    near(WK.wrapHeading(amr.heading + amr.turntableYawRad), 0.0, 1e-9, "turntable stays locked during drive");
  }
  assert.equal(amr.arrived, true, "AMR arrived at East target");
  assert.ok(Math.hypot(amr.x - targetEast.x, amr.y - targetEast.y) <= WS.AMR_SPECS.dockPosTolM);
  assert.ok(Math.abs(WK.wrapPi(amr.heading - targetEast.heading)) <= WS.AMR_SPECS.dockYawTolRad);

  // Scissor lift stroke forces speed === 0 and omega === 0
  let lifting = { x: 0, y: 0, heading: 0, speed: 1.2, omega: 0.8, liftHeightM: 0.260 };
  for (let i = 0; i < 90; i++) {
    lifting = WK.stepAmrKinematics(lifting, { targetLiftHeightM: 0.450, speed: 1.5, omega: 1.0 }, 1 / 60);
    if (lifting.isLifting) {
      near(lifting.speed, 0.0, 1e-9, "speed locked during AMR lift");
      near(lifting.omega, 0.0, 1e-9, "omega locked during AMR lift");
      assert.equal(lifting.statusMode, "lifting");
    }
  }
  near(lifting.liftHeightM, 0.450, 1e-6);

  // Loaded speed limit
  let loaded = { x: 0, y: 0, heading: 0, liftHeightM: 0.450, carriedWcid: 4000012, loaded: true };
  for (let i = 0; i < 120; i++) {
    loaded = WK.stepAmrKinematics(loaded, { speed: 5.0 }, 1 / 60);
  }
  near(loaded.speed, WS.AMR_SPECS.vMaxLoadedMps, 1e-6);
});

check("stepLiftTable stroke & AMR-underride / Pallet-Jack-on-deck interlocks", () => {
  let lt = { x: 10.0, y: 20.0, heading: 0.0, heightM: 0.000 };

  // Blocked raise when pallet jack overlaps deck
  const blockedRaise = WK.stepLiftTable(lt, "raise", 0.5, {
    palletJack: { x: 10.0, y: 19.8, heading: 0.0 },
  });
  assert.equal(blockedRaise.interlockBlocked, true);
  assert.equal(blockedRaise.interlockReason, "pallet_jack_on_deck");
  assert.equal(blockedRaise.moving, false);
  near(blockedRaise.heightM, 0.0, 1e-9);

  // Clear jack -> raises to 0.380 m
  for (let i = 0; i < 180; i++) {
    lt = WK.stepLiftTable(lt, "raise", 1 / 60, {
      palletJack: { x: 10.0, y: 17.5, heading: 0.0 },
    });
  }
  assert.equal(lt.interlockBlocked, false);
  near(lt.heightM, WS.LIFT_TABLE_SPECS.raisedZ, 1e-5);

  // Blocked lower when AMR occupies underride footprint
  const blockedLower = WK.stepLiftTable(lt, "lower", 0.5, {
    amr: { x: 10.0, y: 20.0, heading: 0.0 },
  });
  assert.equal(blockedLower.interlockBlocked, true);
  assert.equal(blockedLower.interlockReason, "amr_underride_occupied");
  assert.equal(blockedLower.moving, false);
  near(blockedLower.heightM, WS.LIFT_TABLE_SPECS.raisedZ, 1e-5);

  // Clear AMR -> lowers back to 0.000 m
  for (let i = 0; i < 180; i++) {
    lt = WK.stepLiftTable(lt, "lower", 1 / 60, {
      amr: { x: 10.0, y: 15.0, heading: 0.0 },
    });
  }
  assert.equal(lt.interlockBlocked, false);
  near(lt.heightM, 0.0, 1e-6);
});

check("SpatialReservationGrid claims, proximity yield & 300-tick multi-agent simulation", () => {
  const grid = new WK.SpatialReservationGrid({
    cellSizeM: 1.0,
    stopDistM: 0.8,
    slowDistM: 2.2,
    defaultRadiusM: 0.65,
  });

  const c1 = grid.claim("agf1", 0.0, 0.0, 0.62);
  assert.equal(c1.ok, true);
  assert.equal(c1.conflict, false);

  // Overlapping claim rejected without clobbering agf1
  const c2Bad = grid.claim("amr1", 0.4, 0.2, 0.56);
  assert.equal(c2Bad.ok, false);
  assert.equal(c2Bad.conflict, true);
  assert.equal(c2Bad.blockedBy, "agf1");

  // Non-overlapping claim succeeds & proximity thresholds match 0.8 / 2.2 m
  const c2Slow = grid.claim("amr1", 0.0, 1.8, 0.56);
  assert.equal(c2Slow.ok, true);
  const qSlow = grid.queryProximity("agf1", 0.0, 0.0, 0.0, { directional: true });
  assert.equal(qSlow.yieldLevel, "slow");
  assert.equal(qSlow.slow, true);
  assert.equal(qSlow.stop, false);

  // Overlapping cell claim stays rejected while proximity <= 0.8 m triggers stop
  const c2Overlap = grid.claim("amr1", 0.0, 0.7, 0.56);
  assert.equal(c2Overlap.ok, false);
  const qStop = grid.queryProximity("agf1", 0.0, 1.05, 0.0, { directional: true });
  assert.equal(qStop.yieldLevel, "stop");
  assert.equal(qStop.stop, true);

  grid.release("amr1");
  const qClear = grid.queryProximity("agf1", 0.0, 0.0, 0.0);
  assert.equal(qClear.yieldLevel, "clear");
  grid.clear();
  assert.equal(grid.getStats().agentCount, 0);

  // 300-tick multi-agent corridor yield test (2 AGFs + 2 AMRs with physical hull stopDistM = 1.35 m)
  const simGrid = new WK.SpatialReservationGrid({
    cellSizeM: 0.5,
    stopDistM: 1.35,
    slowDistM: 2.6,
    defaultRadiusM: 0.62,
  });
  let agents = [
    { kind: "agf", radius: WS.AGF_SPECS.hullRadiusM, state: { agentId: "agfA", x: 0.0, y: 0.0, heading: 0.0 }, target: { x: 0.0, y: 12.0 } },
    { kind: "agf", radius: WS.AGF_SPECS.hullRadiusM, state: { agentId: "agfB", x: 0.0, y: 10.0, heading: Math.PI }, target: { x: 0.0, y: -2.0 } },
    { kind: "amr", radius: WS.AMR_SPECS.hullRadiusM, state: { agentId: "amrA", x: -4.0, y: 5.0, heading: Math.PI * 0.5 }, target: { x: 6.0, y: 5.0 } },
    { kind: "amr", radius: WS.AMR_SPECS.hullRadiusM, state: { agentId: "amrB", x: 4.0, y: 5.0, heading: 1.5 * Math.PI }, target: { x: -6.0, y: 5.0 } },
  ];
  for (const a of agents) {
    assert.equal(simGrid.claim(a.state.agentId, a.state.x, a.state.y, a.radius).ok, true);
  }
  for (let tick = 0; tick < 300; tick++) {
    for (const a of agents) {
      const nextState =
        a.kind === "agf"
          ? WK.stepAgfKinematics(a.state, { targetPose: a.target }, 1 / 60, { grid: simGrid })
          : WK.stepAmrKinematics(a.state, { targetPose: a.target }, 1 / 60, { grid: simGrid });
      assert.ok(Number.isFinite(nextState.x) && Number.isFinite(nextState.y));
      const claimed = simGrid.claim(a.state.agentId, {
        x: nextState.x,
        y: nextState.y,
        heading: nextState.heading,
        radius: a.radius,
      });
      if (claimed.ok) {
        a.state = nextState;
      } else {
        a.state = { ...a.state, speed: 0.0 };
      }
    }
    for (let i = 0; i < agents.length; i++) {
      for (let j = i + 1; j < agents.length; j++) {
        const d = Math.hypot(
          agents[i].state.x - agents[j].state.x,
          agents[i].state.y - agents[j].state.y
        );
        const minHullDist = agents[i].radius + agents[j].radius;
        assert.ok(d >= minHullDist - 0.05, `Multi-agent hull overlap at tick ${tick}: d=${d}`);
      }
    }
  }
});

check("regression: AGF reverse pure-pursuit converges when target starts ahead (loc.y > 0) across headings & mixed waypoints", () => {
  // Exact ahead cases: loc.x === 0 and loc.x !== 0 with loc.y > 0
  for (const target of [
    { x: 0.0, y: 6.0, heading: Math.PI, reverse: true },
    { x: 1.0, y: 6.0, heading: Math.PI, reverse: true },
    { x: -1.5, y: 6.0, heading: 0.5, reverse: true },
  ]) {
    let s = { x: 0.0, y: 0.0, heading: 0.0, forkHeightM: 0.045 };
    for (let i = 0; i < 1500 && !s.arrived; i++) {
      s = WK.stepAgfKinematics(s, { targetPose: target }, 1 / 60);
    }
    assert.equal(s.arrived, true, `AGF reverse target ahead (${target.x},${target.y}) must converge`);
    assert.ok(Math.hypot(s.x - target.x, s.y - target.y) <= WS.AGF_SPECS.dockPosTolM);
    assert.ok(Math.abs(WK.wrapPi(s.heading - target.heading)) <= WS.AGF_SPECS.dockYawTolRad);
  }

  // Sweep 16 initial headings -pi..+pi
  const targetSweep = { x: 10.0, y: 10.0, heading: 0.7, reverse: true };
  for (let k = 0; k < 16; k++) {
    const h0 = -Math.PI + (2 * Math.PI * k) / 16;
    let s = { x: 6.0, y: 10.0, heading: h0, forkHeightM: 0.045 };
    for (let i = 0; i < 1800 && !s.arrived; i++) {
      s = WK.stepAgfKinematics(s, { targetPose: targetSweep }, 1 / 60);
    }
    assert.equal(s.arrived, true, `AGF reverse sweep h0=${h0.toFixed(3)} must arrive`);
    assert.ok(Math.hypot(s.x - targetSweep.x, s.y - targetSweep.y) <= WS.AGF_SPECS.dockPosTolM);
    assert.ok(Math.abs(WK.wrapPi(s.heading - targetSweep.heading)) <= WS.AGF_SPECS.dockYawTolRad);
  }

  // Mixed forward-then-reverse waypoint chain
  let mixed = { x: 0.0, y: 0.0, heading: 0.0, forkHeightM: 0.045 };
  const chain = [
    { x: 0.0, y: 5.0 },
    { x: 2.0, y: 5.0 },
    { x: 2.0, y: 2.0, heading: 0.0, reverse: true },
  ];
  for (let i = 0; i < 2000 && !mixed.arrived; i++) {
    mixed = WK.stepAgfKinematics(mixed, { waypoints: chain }, 1 / 60);
  }
  assert.equal(mixed.arrived, true, "mixed forward-then-reverse waypoint chain must arrive");
  assert.ok(Math.hypot(mixed.x - 2.0, mixed.y - 2.0) <= WS.AGF_SPECS.dockPosTolM);
  assert.ok(Math.abs(WK.wrapPi(mixed.heading - 0.0)) <= WS.AGF_SPECS.dockYawTolRad);
});

check("regression: reversing AGF directional proximity yields for obstacle behind", () => {
  const grid = new WK.SpatialReservationGrid({ cellSizeM: 0.2, stopDistM: 1.35, slowDistM: 2.6 });
  assert.equal(grid.claim("agf_rev", { x: 0.0, y: 0.0, heading: 0.0, radius: 0.40 }).ok, true);
  assert.equal(grid.claim("obs_behind", { x: 0.0, y: -1.0, heading: 0.0, radius: 0.40 }).ok, true);

  // Guided reverse targetPose
  const guided = WK.stepAgfKinematics(
    { agentId: "agf_rev", x: 0.0, y: 0.0, heading: 0.0 },
    { targetPose: { x: 0.0, y: -5.0, reverse: true } },
    1 / 60,
    { grid }
  );
  assert.equal(guided.yieldStopped, true, "reversing AGF must yield-stop for obstacle 1.0m behind");
  assert.equal(guided.speed, 0.0);

  // Direct reverse speed command
  const direct = WK.stepAgfKinematics(
    { agentId: "agf_rev", x: 0.0, y: 0.0, heading: 0.0, speed: -0.5 },
    { speed: -1.5 },
    1 / 60,
    { grid }
  );
  assert.equal(direct.yieldStopped, true, "direct reverse AGF must yield-stop for obstacle 1.0m behind");
  assert.equal(direct.speed, 0.0);
});

check("regression: isAgfInsideContainer detects rear-overhang (-1.930 m) container entry", () => {
  const ch = 1.23;
  const cx = 100.0;
  const cy = 200.0;
  const container = { x: cx, y: cy, heading: ch, wcid: 4000021, kind: 11 };
  // Place AGF outside door (local y = -6.5) facing away so rear overhang (-1.93m) reaches -4.57m inside container
  const agfPos = WK.localToWorld2D(0.0, -6.5, cx, cy, ch);
  const res = WK.stepAgfKinematics(
    { x: agfPos.x, y: agfPos.y, heading: WK.wrapHeading(ch + Math.PI), forkHeightM: 1.50 },
    { targetForkHeightM: 3.50 },
    1 / 60,
    { container }
  );
  assert.equal(res.insideContainer, true, "rear counterweight inside container must trigger insideContainer");
  assert.equal(res.roofStrikeBlocked, true, "rear-overhang container entry must block mast > 1.700 m");
  assert.ok(res.forkHeightM <= WS.AGF_SPECS.containerMaxForkHeightM + 1e-9);

  // Axis-aligned container.bounds rear-overhang check
  const resBounds = WK.stepAgfKinematics(
    { x: 0.0, y: -6.5, heading: Math.PI, forkHeightM: 1.50 },
    { targetForkHeightM: 3.50 },
    1 / 60,
    { container: { bounds: { minX: -1.2, maxX: 1.2, minY: -6.0, maxY: 6.0 } } }
  );
  assert.equal(resBounds.insideContainer, true);
  assert.equal(resBounds.roofStrikeBlocked, true);
});

check("regression: stepLiftTable sanitizes non-finite pose & checks Pallet Jack rear steer-pivot (-0.52 m)", () => {
  const badState = { x: NaN, y: -Infinity, heading: NaN, heightM: NaN };
  for (const [cmd, ctx] of [
    ["raise", {}],
    ["raise", { palletJackOnDeck: true }],
    ["lower", { amrUnderneath: true }],
  ]) {
    const out = WK.stepLiftTable(
      cmd === "lower" ? { ...badState, heightM: 0.38 } : badState,
      cmd,
      NaN,
      ctx
    );
    assert.ok(Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.heading),
      `stepLiftTable must return finite x/y/heading for cmd=${cmd}`);
    assert.ok(Number.isFinite(out.heightM));
  }

  // Rear steer-pivot (-0.52 m) on deck across multiple lift table headings
  for (const th of [0.0, Math.PI * 0.25, Math.PI * 0.5, Math.PI, -2.1]) {
    const tx = 10.0;
    const ty = 20.0;
    // Jack center at local y = -1.12 facing away (heading = th + PI) puts rear steer-pivot at local y = -0.60 (inside halfL = 0.65)
    const jackPos = WK.localToWorld2D(0.0, -1.12, tx, ty, th);
    const blocked = WK.stepLiftTable(
      { x: tx, y: ty, heading: th, heightM: 0.0 },
      "raise",
      0.5,
      { palletJack: { x: jackPos.x, y: jackPos.y, heading: WK.wrapHeading(th + Math.PI) } }
    );
    assert.equal(blocked.interlockBlocked, true, `steer-pivot on deck must block raise at th=${th}`);
    assert.equal(blocked.interlockReason, "pallet_jack_on_deck");
  }
});

check("regression: SpatialReservationGrid.claim with replace: false deduplicates cell keys", () => {
  const grid = new WK.SpatialReservationGrid({ cellSizeM: 1.0 });
  for (let i = 0; i < 10; i++) {
    const r = grid.claim("a", { x: 0.0, y: 0.0, radius: 0.5, replace: false });
    assert.equal(r.ok, true);
  }
  const keys = grid._agentCells.get("a");
  assert.ok(Array.isArray(keys));
  assert.equal(keys.length, new Set(keys).size, "repeated replace:false claims must not accumulate duplicate keys");
  assert.equal(keys.length, 4);
  assert.equal(grid.release("a"), 4);
});

console.log(`=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  process.exit(1);
}
