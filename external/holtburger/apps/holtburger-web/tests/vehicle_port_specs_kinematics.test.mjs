// tests/vehicle_port_specs_kinematics.test.mjs — Pure Specs & Terminal Kinematics Suite (B1)
// Covers: port_specs.js, port_kinematics.js (ISO 9711, Site A, Quay/Ramp, STS/RMG/RTG, Shuttles, Yard Store).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PORT_WCID,
  PORT_DEPLOYABLE_KIND,
  PORT_GUID_BASE,
  PORT_ORIGIN,
  WAREHOUSE_PORT_ORIGIN,
  PORT_SITE,
  WAREHOUSE_DROP_PADS,
  ISO_CONTAINERS,
  PORT_CONTAINER_LIVERIES,
  PORT_LIVERY_KEYS,
  resolvePortContainerSpec,
  formatIso6346Bic,
  quayRampZ,
  quayRampPitch,
  waterSwellAt,
  waterSwellLattice,
  quayWallSdf,
  estimateChartDepthM,
  QUAY_SPECS,
  SHIP_SPECS,
  BERTH_SPECS,
  STS_CRANE_SPECS,
  YARD_CRANE_SPECS,
  YARD_BLOCK_SPECS,
  formatBrtCode,
  parseBrtCode,
  isOddBay,
  isEvenBay,
  yardOddPairForEvenBay,
  yardEvenBayForOddBay,
  validateYardPlacement,
  computeYardSlotWorldPose,
  validateShipPlacement,
  computeShipSlotLocalPose,
  buildPortLayout,
} from "../scene3d/vehicle/port_specs.js";

import {
  STS_PHASE,
  STS_TROLLEY_MIN_Y,
  STS_TROLLEY_MAX_Y,
  STS_TROLLEY_PARK_MAX_Y,
  createStsCraneState,
  worldYToStsTrolleyY,
  enforceStsRailAntiCollision,
  stepStsCrane,
  stepStsTransferCycle,
  YARD_CRANE_PHASE,
  createYardCraneState,
  enforceYardCraneSeparation,
  stepYardCrane,
  stepYardTransferCycle,
  findRoadPath,
  PortReservationGrid,
  createShuttleState,
  stepShuttle,
  createYardStackStore,
} from "../scene3d/vehicle/port_kinematics.js";

import { buildDefaultHubLayout, WAREHOUSE_WCID } from "../scene3d/vehicle/warehouse_specs.js";
import { computeIso6346CheckDigit } from "../scene3d/vehicle/container_models.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const VEHICLE_DIR = join(HERE, "..", "scene3d", "vehicle");

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [OK] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name}: ${e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e}`);
  }
}

function near(a, b, eps = 1e-4, msg = "near") {
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) > eps) {
    throw new Error(`${msg}: expected ${b} ± ${eps}, got ${a}`);
  }
}

console.log("=== vehicle_port_specs_kinematics.test.mjs ===");

// 1. Purity & ID non-collision
check("zero external imports in port_specs.js and port_specs-only import in kinematics", () => {
  const specsSrc = readFileSync(join(VEHICLE_DIR, "port_specs.js"), "utf8");
  assert.equal(/^\s*import\s+/m.test(specsSrc), false, "port_specs.js must have 0 imports");

  for (const fn of ["port_kinematics.js", "ship_kinematics.js"]) {
    const src = readFileSync(join(VEHICLE_DIR, fn), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    assert.deepEqual(imports, ["./port_specs.js"], `${fn} must import ONLY ./port_specs.js`);
  }
});

check("PORT_WCID, DeployableKind, and GUID ranges do not collide with existing allocations", () => {
  const whWcids = new Set(Object.values(WAREHOUSE_WCID));
  for (const wcid of Object.values(PORT_WCID)) {
    assert.ok(wcid >= 4000050 && wcid <= 4000069, `WCID ${wcid} in clean 4000050..4000069 block`);
    assert.equal(whWcids.has(wcid), false, `WCID ${wcid} does not collide with warehouse`);
  }
  for (const k of Object.values(PORT_DEPLOYABLE_KIND)) {
    assert.ok(k >= 23, `DeployableKind ${k} >= 23`);
  }
  assert.ok(PORT_GUID_BASE.entities >= 0x79000000);
  assert.ok(PORT_GUID_BASE.handoffContainers > PORT_GUID_BASE.entities);
});

// 2. Site A & Warehouse Seam Parity
check("Site A connects flush to untouched Automated Warehouse at z=0 with exact C1/C2/C3 pad parity", () => {
  const layout = buildPortLayout(PORT_ORIGIN);
  const whLayout = buildDefaultHubLayout(WAREHOUSE_PORT_ORIGIN);

  near(whLayout.slabBounds.maxY, layout.bounds.minY, 1e-6, "warehouse North edge flush with terminal South edge");
  near(whLayout.origin[2], 0.0, 1e-6, "warehouse z=0 invariant for isContainerTrailerMounted");

  for (const pad of whLayout.dropPads) {
    const portPad = WAREHOUSE_DROP_PADS[pad.id];
    assert.ok(portPad, `pad ${pad.id} mirrored`);
    near(portPad.pos[0], pad.pos[0], 1e-6, `${pad.id} X`);
    near(portPad.pos[1], pad.pos[1], 1e-6, `${pad.id} Y`);
    near(portPad.pos[2], pad.pos[2], 1e-6, `${pad.id} Z`);
    near(portPad.heading, pad.heading, 1e-6, `${pad.id} heading`);
  }
});

check("quayRampZ & quayRampPitch are continuous and within 5° sidelifter/semi slope limit", () => {
  near(quayRampZ(PORT_SITE.yardMinY), 0.0, 1e-6, "yard floor z");
  near(quayRampZ(PORT_SITE.rampMinY), 0.0, 1e-6, "ramp foot z");
  near(quayRampZ(0.5 * (PORT_SITE.rampMinY + PORT_SITE.rampMaxY)), 1.0, 1e-6, "ramp mid z");
  near(quayRampZ(PORT_SITE.rampMaxY), 2.0, 1e-6, "ramp top z");
  near(quayRampZ(PORT_SITE.quayY), 2.0, 1e-6, "quay coping z");
  near(quayRampZ(PORT_SITE.quayY + 10.0), 0.0, 1e-6, "water z");

  const pitchNorth = quayRampPitch(47822.0, 0.0);
  const pitchSouth = quayRampPitch(47822.0, Math.PI);
  const pitchEast = quayRampPitch(47822.0, Math.PI * 0.5);
  assert.ok(pitchNorth > 0.07 && pitchNorth < 0.09, "Northbound ramp pitch ~4.76 deg");
  near(pitchSouth, -pitchNorth, 1e-6, "Southbound pitch opposite");
  near(pitchEast, 0.0, 1e-6, "Eastbound pitch zero");
  assert.ok(Math.cos(pitchNorth) > 0.9945, "Slope satisfies sidelifter MAX_SLOPE_COS");
});

check("waterSwellAt & waterSwellLattice match terrain.js envelope and continuity", () => {
  for (let i = 0; i < 40; i++) {
    const x = 44800 + i * 11.3;
    const y = 47900 + i * 7.7;
    const t = i * 0.6;
    const sw = waterSwellAt(x, y, t);
    const sl = waterSwellLattice(x, y, t);
    assert.ok(Math.abs(sw) <= 0.250001, `waterSwellAt bounded <= 0.25 m (got ${sw})`);
    assert.ok(Math.abs(sl) <= 0.250001, `waterSwellLattice bounded <= 0.25 m (got ${sl})`);
  }
  // Exact match on 24 m lattice vertices
  near(waterSwellLattice(44880, 47904, 1.5), waterSwellAt(44880, 47904, 1.5), 1e-9, "exact on 24m grid");
  // Hold tank-top strictly above max wave crest
  assert.ok(SHIP_SPECS.holdTankTopZ > PORT_SITE.waterMaxSwellM + 0.15, "ship hold floor safely above max swell");
});

check("quayWallSdf & estimateChartDepthM classify land vs berth pocket vs fairway", () => {
  assert.ok(quayWallSdf(44960, 47860) < 0, "inside quay is negative SDF");
  near(estimateChartDepthM(44960, 47860, 10), 0.0, 1e-6, "dry land depth = 0");
  assert.ok(quayWallSdf(44880, 47888.55) > 8.0, "Berth 1 center is positive SDF");
  const berthD = estimateChartDepthM(44880, 47888.55, 20);
  const farD = estimateChartDepthM(44880, 48320.0, 20);
  assert.ok(berthD >= 13.5 && berthD <= 15.0, `berth depth ~14 m (got ${berthD})`);
  near(farD, 25.0, 0.2, "fairway depth ~25 m");
  near(estimateChartDepthM(44880, 48320.0, 10), 0.0, 1e-6, "non-water terrain code returns 0 depth");
});

check("ISO 6346 BIC formatting matches container_models.js check digit algorithm", () => {
  assert.equal(PORT_LIVERY_KEYS.length, 6);
  for (const k of PORT_LIVERY_KEYS) assert.ok(PORT_CONTAINER_LIVERIES[k].hex > 0);
  for (const serial of [100001, 234567, 500042, 999999]) {
    const bic = formatIso6346Bic(serial, "HLTB", "U");
    const m = /^([A-Z]{3}) ([A-Z]) (\d{6})-(\d)$/.exec(bic);
    assert.ok(m, `BIC format valid: ${bic}`);
    const expectedDigit = computeIso6346CheckDigit(m[1], m[2], m[3]);
    assert.equal(Number(m[4]), expectedDigit, `mod-11 check digit matches container_models.js for ${bic}`);
  }
});

// 3. ISO 9711 Yard & Ship Addressing / Structural Stacking Rules
check("ISO 9711 BRT format/parse and Yard structural stacking rules", () => {
  assert.equal(formatBrtCode(4, 2, 82), "040282");
  const p = parseBrtCode("040282");
  assert.deepEqual({ bay: p.bay, row: p.row, tier: p.tier }, { bay: 4, row: 2, tier: 82 });
  assert.equal(isOddBay(3), true);
  assert.equal(isEvenBay(4), true);
  assert.deepEqual(yardOddPairForEvenBay(2), [1, 3]);
  assert.deepEqual(yardOddPairForEvenBay(4), [5, 7]);
  assert.equal(yardEvenBayForOddBay(5), 4);
  assert.equal(yardEvenBayForOddBay(7), 4);

  const store = createYardStackStore(PORT_ORIGIN);
  // Reject wrong parity
  assert.equal(store.place("A1", 2, 1, 1, { wcid: 4000020 }).ok, false, "20ft rejected in even bay");
  assert.equal(store.place("A1", 1, 1, 1, { wcid: 4000021 }).ok, false, "40ft rejected in odd bay");
  // Reject floating tier 2
  assert.equal(store.place("A1", 2, 1, 2, { wcid: 4000021 }).ok, false, "floating tier 2 rejected");

  // Place 40HC at tier 1, then 40ft at tier 2 -> exact cumulative Z = 0.004 + 2.896
  const r1 = store.place("A1", 2, 1, 1, { wcid: 4000022 });
  assert.equal(r1.ok, true);
  // 20ft cannot occupy sub-bay 1 on same tier as 40ft in bay 2
  assert.equal(store.place("A1", 1, 1, 1, { wcid: 4000020 }).ok, false, "20ft blocked by 40ft in bay 2");
  // 20ft cannot sit on top of a 40ft (no central corner castings on 40ft)
  assert.equal(store.place("A1", 1, 1, 2, { wcid: 4000020 }).ok, false, "20ft-on-40ft rejected");
  // 40ft CAN sit on top of 40HC
  const r2 = store.place("A1", 2, 1, 2, { wcid: 4000021 });
  assert.equal(r2.ok, true);
  near(r2.entry.z, PORT_SITE.yardVisualZ + ISO_CONTAINERS[4000022].extH, 1e-6, "exact 40HC stack height");
  // Top-clear removal interlock: cannot pull tier 1 while tier 2 sits above
  assert.equal(store.remove("A1", 2, 1, 1).ok, false, "blocked removal under tier 2");
  assert.equal(store.remove("A1", 2, 1, 2).ok, true, "tier 2 removable");
  assert.equal(store.remove("A1", 2, 1, 1).ok, true, "tier 1 removable after clearing tier 2");

  // Dual-20ft base supporting 40ft on tier 2
  assert.equal(store.place("A1", 5, 2, 1, { wcid: 4000020 }).ok, true);
  assert.equal(store.place("A1", 4, 2, 2, { wcid: 4000021 }).ok, false, "single-20ft cannot support 40ft");
  assert.equal(store.place("A1", 7, 2, 1, { wcid: 4000020 }).ok, true);
  assert.equal(store.place("A1", 4, 2, 2, { wcid: 4000021 }).ok, true, "dual-20ft supports 40ft on tier 2");
  assert.equal(store.remove("A1", 5, 2, 1).ok, false, "cannot pull 20ft base under 40ft tier 2");

  // findFreeSlot works
  const free40 = store.findFreeSlot("B1", "40ft");
  assert.ok(free40 && free40.tier === 1 && isEvenBay(free40.bay));
});

check("ISO 9711 ship bay/row/tier validation & pose geometry", () => {
  assert.equal(validateShipPlacement(4, 0, 82, "40ft").ok, false, "row 00 invalid on 4-row ship");
  assert.equal(validateShipPlacement(4, 2, 50, "40ft").ok, false, "invalid tier 50 rejected");
  assert.equal(validateShipPlacement(4, 2, 2, "40ft").ok, true, "hold tier 02 valid");
  assert.equal(validateShipPlacement(5, 1, 82, "20ft").ok, true, "odd bay 05 20ft deck valid");

  const holdPose = computeShipSlotLocalPose(4, 2, 2, "40ft");
  near(holdPose.z, SHIP_SPECS.holdTankTopZ, 1e-6, "hold tier 02 z");
  near(holdPose.x, -1.30, 1e-6, "port inner row 02 x");
  const deckPose = computeShipSlotLocalPose(4, 3, 82, "40hc");
  near(deckPose.z, SHIP_SPECS.hatchDeckZ, 1e-6, "deck tier 82 z");
  near(deckPose.x, +3.90, 1e-6, "starboard outer row 03 x");
});

// 4. STS Gantry Crane Kinematics & Shared-Rail Anti-Collision
check("STS crane stowage interlocks, rail anti-collision (>=26m), and full transfer cycle", () => {
  const sts1 = createStsCraneState({ id: "STS-1", localX: -80, origin: PORT_ORIGIN, boomStowed: true });
  // While boom is stowed, trolley cannot enter waterside outreach
  for (let i = 0; i < 120; i++) stepStsCrane(sts1, { targetTrolleyY: 30.0 }, 1 / 30);
  assert.ok(sts1.trolleyY <= STS_TROLLEY_PARK_MAX_Y + 0.05, "stowed boom blocks waterside trolley travel");

  // Full autonomous transfer cycle (ship Bay 04 -> quay lane) auto-deploys boom, telescopes to 20ft, locks, moves, unlocks!
  const job = {
    pickPos: [PORT_ORIGIN[0] - 80, PORT_ORIGIN[1] + 9.85, 9.5],
    placePos: [PORT_ORIGIN[0] - 80, PORT_ORIGIN[1] - 13.0, 4.5],
    container: { wcid: 4000020, sizeFt: 20 },
  };
  let picked = false;
  let placed = false;
  let done = false;
  for (let i = 0; i < 3600; i++) {
    const r = stepStsTransferCycle(sts1, job, 1 / 30);
    if (r.pickedEvent) picked = true;
    if (r.placedEvent) placed = true;
    if (r.done) { done = true; break; }
  }
  assert.equal(picked, true, "STS locked and picked container");
  assert.equal(placed, true, "STS unlocked and placed container");
  assert.equal(done, true, "STS cycle completed cleanly");
  near(sts1.spreaderLen, STS_CRANE_SPECS.spreaderLen20M, 0.05, "spreader telescoped to 20ft");
  assert.equal(sts1.carriedContainer, null, "container released");
  near(sts1.boomAngle, 0.0, 0.01, "boom deployed horizontal");

  // Shared-rail anti-collision: drive STS-1 and STS-2 straight at each other
  const stsA = createStsCraneState({ id: "STS-1", localX: -20, origin: PORT_ORIGIN });
  const stsB = createStsCraneState({ id: "STS-2", localX: +20, origin: PORT_ORIGIN });
  stsA.targetX = PORT_ORIGIN[0] + 100;
  stsB.targetX = PORT_ORIGIN[0] - 100;
  for (let i = 0; i < 900; i++) {
    enforceStsRailAntiCollision([stsA, stsB]);
    stepStsCrane(stsA, null, 1 / 30);
    stepStsCrane(stsB, null, 1 / 30);
    enforceStsRailAntiCollision([stsA, stsB]);
  }
  assert.ok(stsB.x - stsA.x >= STS_CRANE_SPECS.minCraneSeparationM - 1e-4, `rail gap >= 26m (got ${(stsB.x - stsA.x).toFixed(2)})`);
});

// 5. Yard Crane (RMG / RTG) Kinematics
check("RMG transfer cycle, dual-RMG separation, and RTG 90° bogie steering interlock", () => {
  const rmg1 = createYardCraneState({ id: "RMG-1", type: "RMG", x: PORT_ORIGIN[0] - 90, y: PORT_ORIGIN[1] - 99, minX: PORT_ORIGIN[0] - 168, maxX: PORT_ORIGIN[0] + 164 });
  const rmg2 = createYardCraneState({ id: "RMG-2", type: "RMG", x: PORT_ORIGIN[0] - 50, y: PORT_ORIGIN[1] - 99, minX: PORT_ORIGIN[0] - 168, maxX: PORT_ORIGIN[0] + 164 });
  rmg1.targetX = PORT_ORIGIN[0] + 50;
  rmg2.targetX = PORT_ORIGIN[0] - 120;
  for (let i = 0; i < 600; i++) {
    enforceYardCraneSeparation([rmg1, rmg2]);
    stepYardCrane(rmg1, null, 1 / 30);
    stepYardCrane(rmg2, null, 1 / 30);
    enforceYardCraneSeparation([rmg1, rmg2]);
  }
  assert.ok(rmg2.x - rmg1.x >= YARD_CRANE_SPECS.minCraneSeparationM - 1e-4, "RMG rail separation enforced");

  // Full yard transfer cycle
  const job = {
    pickPos: [PORT_ORIGIN[0] - 95, PORT_ORIGIN[1] - 88.5, 3.9],
    placePos: [PORT_ORIGIN[0] - 80, PORT_ORIGIN[1] - 110.0, 2.6],
    container: { wcid: 4000021, sizeFt: 40 },
  };
  let picked = false, placed = false, done = false;
  for (let i = 0; i < 1800; i++) {
    const r = stepYardTransferCycle(rmg1, job, 1 / 30);
    if (r.pickedEvent) picked = true;
    if (r.placedEvent) placed = true;
    if (r.done) { done = true; break; }
  }
  assert.ok(picked && placed && done, "RMG transfer cycle completed");

  // RTG 90° steering bogie interlock before moving in Y
  const rtg = createYardCraneState({ id: "RTG-1", type: "RTG", x: PORT_ORIGIN[0] - 90, y: PORT_ORIGIN[1] - 157 });
  const startY = rtg.y;
  stepYardCrane(rtg, { targetY: startY + 5.0 }, 0.2);
  assert.ok(rtg.wheelSteerRad > 0.1, "RTG begins steering wheels toward 90 deg");
  near(rtg.y, startY, 1e-6, "RTG waits for 90 deg wheel alignment before crabbing Y");
  for (let i = 0; i < 300; i++) stepYardCrane(rtg, { targetY: startY + 5.0 }, 1 / 30);
  near(rtg.y, startY + 5.0, 0.05, "RTG completed lateral Y crab");
  for (let i = 0; i < 120; i++) stepYardCrane(rtg, { targetX: rtg.x + 10.0 }, 1 / 30);
  near(rtg.wheelSteerRad, 0.0, 0.05, "RTG straightened wheels for X travel");
});

// 6. Terminal Tractor Shuttle Routing, Ramp Pitch & Reservation Grid
check("Terminal shuttle routes from Quay Berth 1 down ramp to Warehouse Drop Pad C1 cleanly", () => {
  const layout = buildPortLayout(PORT_ORIGIN);
  const path = findRoadPath(layout.graph, "quay_lane_b1", "wh_pad_C1");
  assert.ok(path.length >= 6, `A* found path quay -> warehouse C1 (${path.length} nodes)`);
  assert.equal(path[0].id, "quay_lane_b1");
  assert.equal(path[path.length - 1].id, "wh_pad_C1");

  const shuttle = createShuttleState({ id: "TT-1", x: path[0].x, y: path[0].y, heading: Math.PI * 0.5, origin: PORT_ORIGIN });
  near(shuttle.z, 2.0, 1e-4, "starts on quay deck z=2.0m");

  let sawRampPitch = false;
  let wpIdx = 0;
  let arrived = false;
  for (let i = 0; i < 6000; i++) {
    const r = stepShuttle(shuttle, path, 1 / 30, { waypointIndex: wpIdx, origin: PORT_ORIGIN, finalHeading: 0.0 });
    wpIdx = r.waypointIndex;
    if (Math.abs(shuttle.pitch) > 0.04) sawRampPitch = true;
    if (r.arrived) { arrived = true; break; }
  }
  assert.equal(arrived, true, "shuttle arrived at Warehouse Drop Pad C1");
  assert.equal(sawRampPitch, true, "shuttle experienced smooth ramp pitch descending from quay");
  near(shuttle.z, 0.0, 1e-4, "arrived at warehouse floor z=0.0m");
  near(shuttle.x, WAREHOUSE_DROP_PADS.C1.pos[0], 0.65, "aligned with C1 X");
  near(shuttle.y, WAREHOUSE_DROP_PADS.C1.pos[1], 0.65, "aligned with C1 Y");
});

check("PortReservationGrid yields trailing shuttle before collision", () => {
  const grid = new PortReservationGrid({ stopDistM: 18.0, slowDistM: 28.0 });
  grid.updateAgent("TT-1", 44900, 47750, Math.PI * 0.5, 0.0);
  assert.equal(grid.speedFactorFor("TT-2", 44885, 47750, Math.PI * 0.5), 0.0, "stops within 15 m behind TT-1");
  const midF = grid.speedFactorFor("TT-2", 44877, 47750, Math.PI * 0.5);
  assert.ok(midF > 0.0 && midF < 1.0, `slows in buffer zone (factor=${midF.toFixed(2)})`);
  assert.equal(grid.speedFactorFor("TT-2", 44850, 47750, Math.PI * 0.5), 1.0, "full speed when >28 m clear");
});

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
