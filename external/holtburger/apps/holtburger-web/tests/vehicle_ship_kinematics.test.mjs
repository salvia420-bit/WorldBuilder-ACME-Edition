// tests/vehicle_ship_kinematics.test.mjs — Container Ship Hydrodynamics & Autonomous Captain Suite (B1)
// Covers: ship_kinematics.js (3+3 wave-locked hydrodynamics, EOT, rudder, bow/stern thrusters,
//         fender contact, grounding guard, manual mooring, autonomous Berth 1 & Berth 2 docking,
//         dual-ship deconfliction, departure, and ISO 9711 shipboard cargo stowage).

import assert from "node:assert/strict";

import {
  PORT_ORIGIN,
  PORT_SITE,
  QUAY_SPECS,
  BERTH_SPECS,
  SHIP_SPECS,
  buildPortLayout,
  waterSwellLattice,
} from "../scene3d/vehicle/port_specs.js";

import {
  SHIP_SIM_DT,
  SHIP_MODE,
  CAPTAIN_STATE,
  eotNotchToThrottle,
  throttleToEotNotch,
  createShipState,
  computeBerthAlignment,
  stepShipHydrodynamics,
  commandShipGoToBerth,
  commandShipDepart,
  signalCargoOpsComplete,
  tryManualMoorToggle,
  stepAutonomousCaptain,
  computeMooringLines,
  createShipCargoStore,
} from "../scene3d/vehicle/ship_kinematics.js";

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

console.log("=== vehicle_ship_kinematics.test.mjs ===");

// 1. EOT & Longitudinal Propulsion + Rudder Turning
check("7-notch EOT accelerates ahead/astern and rudder turns vessel cleanly", () => {
  near(eotNotchToThrottle(3), 1.0, 1e-6);
  near(eotNotchToThrottle(0), 0.0, 1e-6);
  near(eotNotchToThrottle(-3), -1.0, 1e-6);
  assert.equal(throttleToEotNotch(0.65), 2);

  const ship = createShipState({ x: 44980, y: 48200, heading: 0.0, mode: SHIP_MODE.MANUAL });
  for (let i = 0; i < 900; i++) {
    stepShipHydrodynamics(ship, { throttle: 1.0, targetRudderRad: 0.0, bowThruster: 0.0, sternThruster: 0.0 }, SHIP_SIM_DT);
  }
  assert.ok(ship.surgeU > 5.2 && ship.surgeU <= SHIP_SPECS.maxSpeedMps + 0.01, `ahead speed near service speed (got ${ship.surgeU.toFixed(2)} m/s)`);
  assert.ok(ship.y > 48300, "vessel traveled North");
  assert.ok(ship.sogKnots > 10.0, "SOG in knots computed");

  // Starboard rudder turns heading clockwise (+dHeading)
  const hBefore = ship.heading;
  for (let i = 0; i < 300; i++) {
    stepShipHydrodynamics(ship, { throttle: 0.8, targetRudderRad: 0.45, bowThruster: 0.0, sternThruster: 0.0 }, SHIP_SIM_DT);
  }
  assert.ok(ship.yawRateR > 0.02, `starboard rudder yields clockwise yaw rate (got ${ship.yawRateR.toFixed(4)})`);
  assert.ok(ship.heading !== hBefore, "heading changed under rudder");

  // Full Astern slows and reverses
  for (let i = 0; i < 1200; i++) {
    stepShipHydrodynamics(ship, { throttle: -1.0, targetRudderRad: 0.0, bowThruster: 0.0, sternThruster: 0.0 }, SHIP_SIM_DT);
  }
  assert.ok(ship.surgeU < -1.5, `full astern reverses ship (got ${ship.surgeU.toFixed(2)} m/s)`);
});

// 2. Bow & Stern Lateral Thrusters (Pure Crabbing & Zero-Speed Counter-Pivot)
check("bow & stern thrusters execute pure lateral crabbing AND zero-speed pivot", () => {
  // Facing East (+PI/2): starboard (+X ship) points SOUTH (-Y world) directly toward quay wall!
  const shipCrab = createShipState({ x: 44880, y: 48150, heading: Math.PI * 0.5, mode: SHIP_MODE.MANUAL });
  const y0 = shipCrab.y;
  for (let i = 0; i < 300; i++) {
    stepShipHydrodynamics(shipCrab, { throttle: 0.0, targetRudderRad: 0.0, bowThruster: 1.0, sternThruster: 1.0 }, SHIP_SIM_DT);
  }
  assert.ok(shipCrab.y < y0 - 8.0, `starboard lateral thrusters crabbed South toward quay (dY=${(shipCrab.y - y0).toFixed(2)}m)`);
  assert.ok(Math.abs(shipCrab.heading - Math.PI * 0.5) < 0.12, "heading stayed nearly parallel during balanced crab");

  // Counter-pivot: bow starboard (+1), stern port (-1) -> clockwise rotation in place
  const shipPivot = createShipState({ x: 44880, y: 48150, heading: 0.0, mode: SHIP_MODE.MANUAL });
  for (let i = 0; i < 300; i++) {
    stepShipHydrodynamics(shipPivot, { throttle: 0.0, targetRudderRad: 0.0, bowThruster: 1.0, sternThruster: -1.0 }, SHIP_SIM_DT);
  }
  assert.ok(shipPivot.yawRateR > 0.04, `counter-thrusters spin vessel in place (yawRate=${shipPivot.yawRateR.toFixed(4)})`);
  assert.ok(Math.hypot(shipPivot.x - 44880, shipPivot.y - 48150) < 3.0, "minimal translation during pure pivot");
});

// 3. Wave-Locked 3-DOF Seakeeping (Heave, Pitch, Roll)
check("heave/pitch/roll stay phase-locked to terrain.js waterSwellLattice and damp when moored", () => {
  const freeShip = createShipState({ x: 44980, y: 48200, heading: 0.0, mode: SHIP_MODE.MANUAL });
  let maxAbsZ = 0, maxAbsPitch = 0, maxAbsRoll = 0;
  for (let i = 0; i < 450; i++) {
    stepShipHydrodynamics(freeShip, { throttle: 0, targetRudderRad: 0, bowThruster: 0, sternThruster: 0 }, SHIP_SIM_DT);
    maxAbsZ = Math.max(maxAbsZ, Math.abs(freeShip.z));
    maxAbsPitch = Math.max(maxAbsPitch, Math.abs(freeShip.pitch));
    maxAbsRoll = Math.max(maxAbsRoll, Math.abs(freeShip.roll));
  }
  assert.ok(maxAbsZ > 0.05 && maxAbsZ <= 0.30, `realistic wave heave (maxZ=${maxAbsZ.toFixed(3)}m)`);
  assert.ok(maxAbsPitch > 0.0005 && maxAbsRoll > 0.0005, "non-zero wave pitch & roll");

  const mooredShip = createShipState({ spawnAtBerth: "B1", moored: true });
  let mooredMaxZ = 0;
  for (let i = 0; i < 450; i++) {
    stepShipHydrodynamics(mooredShip, { throttle: 0, targetRudderRad: 0, bowThruster: 0, sternThruster: 0 }, SHIP_SIM_DT);
    mooredMaxZ = Math.max(mooredMaxZ, Math.abs(mooredShip.z));
  }
  assert.ok(mooredMaxZ < maxAbsZ * 0.65, `moored heave damped vs open sea (${mooredMaxZ.toFixed(3)} < ${maxAbsZ.toFixed(3)})`);
  // Ensure wave elevation formula matches waterSwellLattice scale
  assert.ok(Math.abs(waterSwellLattice(44980, 48200, freeShip.timeSec)) <= 0.2501);
});

// 4. Quay Fender Contact & Grounding Protection
check("quay fenders stop hull penetration and grounding guard prevents sailing onto dry land", () => {
  // Drive straight south into Berth 1 quay wall
  const ship = createShipState({ x: 44880, y: 47910, heading: Math.PI * 0.5, mode: SHIP_MODE.MANUAL });
  for (let i = 0; i < 900; i++) {
    stepShipHydrodynamics(ship, { throttle: 0.0, targetRudderRad: 0.0, bowThruster: 1.0, sternThruster: 1.0 }, SHIP_SIM_DT);
  }
  const minAllowedCenterY = PORT_ORIGIN[1] + QUAY_SPECS.fenderDepthM + SHIP_SPECS.halfBeamM - 0.1;
  assert.ok(ship.y >= minAllowedCenterY, `hull stopped at fenders (y=${ship.y.toFixed(2)} >= ${minAllowedCenterY.toFixed(2)})`);
  assert.equal(ship.fenderContact, true, "fenderContact flagged on quay touch");

  // Dry land oracle stops ship outside quay
  const landShip = createShipState({ x: 44600, y: 47900, heading: Math.PI, mode: SHIP_MODE.MANUAL });
  const envDry = { waterCodeAt: (_x, y) => (y < 47860 ? 10 : 20) };
  for (let i = 0; i < 600; i++) {
    stepShipHydrodynamics(landShip, { throttle: 1.0, targetRudderRad: 0.0, bowThruster: 0.0, sternThruster: 0.0 }, SHIP_SIM_DT, envDry);
  }
  assert.ok(landShip.y >= 47840, `grounding guard prevented driving onto dry land (y=${landShip.y.toFixed(1)})`);
});

// 5. Manual Mooring Toggle
check("tryManualMoorToggle enforces berth envelope and toggles mooring cleanly", () => {
  const ship = createShipState({ x: 44880, y: 47940, heading: Math.PI * 0.5, mode: SHIP_MODE.MANUAL });
  const failRes = tryManualMoorToggle(ship, PORT_ORIGIN);
  assert.equal(failRes.ok, false, "refuses mooring 50 m offshore");

  // Move inside Berth 1 envelope
  ship.y = PORT_ORIGIN[1] + 9.2;
  ship.surgeU = 0.1;
  ship.swayV = 0.0;
  const okRes = tryManualMoorToggle(ship, PORT_ORIGIN);
  assert.equal(okRes.ok, true, "accepts mooring inside Berth 1 envelope");
  assert.equal(ship.moored, true);
  assert.equal(ship.mooredBerthId, "B1");

  const lines = computeMooringLines(ship, buildPortLayout(PORT_ORIGIN));
  assert.equal(lines.length, 6, "6 hawser mooring lines attached to bollards");

  const unmoorRes = tryManualMoorToggle(ship, PORT_ORIGIN);
  assert.equal(unmoorRes.ok, true);
  assert.equal(ship.moored, false);
});

// 6. Full Autonomous Captain — Offshore -> Berth 1 -> Cargo Ops -> Departure
check("autonomous captain navigates from WP_SEA, aligns, crabs onto Berth 1, moors, and departs", () => {
  const ship = createShipState({ id: "SHIP-B1", x: 44980, y: 48240, heading: Math.PI });
  commandShipGoToBerth(ship, "B1");
  assert.equal(ship.captainState, CAPTAIN_STATE.UNDERWAY_TRANSIT);

  const visited = new Set([ship.captainState]);
  for (let i = 0; i < 12000; i++) {
    stepAutonomousCaptain(ship, SHIP_SIM_DT);
    visited.add(ship.captainState);
    if (ship.captainState === CAPTAIN_STATE.CARGO_OPS) break;
  }

  assert.equal(ship.captainState, CAPTAIN_STATE.CARGO_OPS, `reached CARGO_OPS (state=${ship.captainState}, pos=[${ship.x.toFixed(1)},${ship.y.toFixed(1)}])`);
  assert.equal(ship.moored, true);
  assert.equal(ship.mooredBerthId, "B1");
  assert.ok(visited.has(CAPTAIN_STATE.APPROACH_STAGING), "visited APPROACH_STAGING");
  assert.ok(visited.has(CAPTAIN_STATE.FINAL_BERTHING), "visited FINAL_BERTHING");
  assert.ok(visited.has(CAPTAIN_STATE.MOORING), "visited MOORING");

  const al = computeBerthAlignment(ship, "B1", PORT_ORIGIN);
  assert.ok(Math.abs(al.lateralErrM) <= 1.0, `B1 lateral error <= 1m (got ${al.lateralErrM.toFixed(2)})`);
  assert.ok(Math.abs(al.longErrM) <= 1.5, `B1 longitudinal error <= 1.5m (got ${al.longErrM.toFixed(2)})`);
  assert.ok(Math.abs(al.headingErrDeg) <= 3.0, `B1 heading error <= 3 deg (got ${al.headingErrDeg.toFixed(2)})`);

  // Signal cargo complete -> unmoor & depart West channel
  signalCargoOpsComplete(ship);
  for (let i = 0; i < 9000; i++) {
    stepAutonomousCaptain(ship, SHIP_SIM_DT);
    if (ship.captainState === CAPTAIN_STATE.IDLE) break;
  }
  assert.equal(ship.moored, false, "unmoored on departure");
  assert.ok(ship.y > PORT_ORIGIN[1] + 150.0, `departed safely offshore (y=${ship.y.toFixed(1)})`);
});

// 7. Autonomous Captain — Dual-Ship Simultaneous Berthing at Berth 1 & Berth 2
check("dual ships autonomously dock simultaneously at Berth 1 & Berth 2 without collision", () => {
  const s1 = createShipState({ id: "SHIP-1", x: 44840, y: 48120, heading: Math.PI });
  const s2 = createShipState({ id: "SHIP-2", x: 45120, y: 48150, heading: Math.PI });
  commandShipGoToBerth(s1, "B1");
  commandShipGoToBerth(s2, "B2");

  let minSep = Infinity;
  for (let i = 0; i < 12000; i++) {
    stepAutonomousCaptain(s1, SHIP_SIM_DT, { otherShips: [s2] });
    stepAutonomousCaptain(s2, SHIP_SIM_DT, { otherShips: [s1] });
    const d = Math.hypot(s1.x - s2.x, s1.y - s2.y);
    if (d < minSep) minSep = d;
    if (s1.captainState === CAPTAIN_STATE.CARGO_OPS && s2.captainState === CAPTAIN_STATE.CARGO_OPS) break;
  }

  assert.equal(s1.mooredBerthId, "B1", "Ship 1 moored at Berth 1");
  assert.equal(s2.mooredBerthId, "B2", "Ship 2 moored at Berth 2");
  assert.ok(minSep > 120.0, `dual ships maintained safe separation (minSep=${minSep.toFixed(1)}m)`);
  near(s1.x, BERTH_SPECS.B1.center[0], 1.5, "Ship 1 at B1 X");
  near(s2.x, BERTH_SPECS.B2.center[0], 1.5, "Ship 2 at B2 X");
});

// 8. Shipboard ISO 9711 Cargo Stowage Store & Hold/Deck Interlocks
check("shipboard ISO 9711 cargo store enforces hold/deck interlocks & computes trim/list", () => {
  const cargo = createShipCargoStore();
  // Load hold tier 02 and deck tiers 82 & 84 in Bay 04
  assert.equal(cargo.load(4, 1, 2, { wcid: 4000021 }).ok, true, "load hold tier 02");
  assert.equal(cargo.load(4, 1, 82, { wcid: 4000021 }).ok, true, "load deck tier 82");
  assert.equal(cargo.load(4, 1, 84, { wcid: 4000022 }).ok, true, "load deck tier 84");
  assert.equal(cargo.count(), 3);

  // Cannot unload hold while deck cargo sits atop hatch bay 04
  assert.equal(cargo.unload(4, 1, 2).ok, false, "hold blocked by deck cargo over hatch");
  // Cannot unload tier 82 while tier 84 sits above
  assert.equal(cargo.unload(4, 1, 82).ok, false, "tier 82 blocked by tier 84");

  const next = cargo.findNextDischargeable(4);
  assert.equal(next.tier, 84, "findNextDischargeable picks highest deck tier first");

  // Unload top-down: 84 -> 82 -> hold 02
  assert.equal(cargo.unload(4, 1, 84).ok, true);
  assert.equal(cargo.unload(4, 1, 82).ok, true);
  assert.equal(cargo.unload(4, 1, 2).ok, true, "hold tier 02 unlocked once deck cleared");
  assert.equal(cargo.count(), 0);

  // Asymmetric starboard cargo induces subtle positive list
  cargo.load(2, 3, 82, { wcid: 4000021, weightTonnes: 28 });
  cargo.load(4, 3, 82, { wcid: 4000021, weightTonnes: 28 });
  const stab = cargo.computeStabilitySummary();
  assert.equal(stab.count, 2);
  assert.ok(stab.cargoListRad > 0.003 && stab.cargoListRad <= 0.025, `subtle starboard list (${stab.cargoListRad.toFixed(4)} rad)`);

  const freeSlot = cargo.findFreeDeckSlot("20ft");
  assert.ok(freeSlot && freeSlot.tier === 82, "findFreeDeckSlot locates free odd 20ft slot");
});

// 9. Berth-to-Berth Autonomous Shift (B1 -> B2) & Port-Side-To Berthing
check("autonomous captain shifts seamlessly from Berth 1 to Berth 2 and supports port-side-to berthing", () => {
  const ship = createShipState({ id: "SHIP-SHIFT", spawnAtBerth: "B1", moored: true });
  commandShipGoToBerth(ship, "B2", { side: "port" });
  assert.equal(ship.captainState, CAPTAIN_STATE.UNMOORING);

  for (let i = 0; i < 14000; i++) {
    stepAutonomousCaptain(ship, SHIP_SIM_DT);
    if (ship.captainState === CAPTAIN_STATE.CARGO_OPS && ship.mooredBerthId === "B2") break;
  }
  assert.equal(ship.moored, true, "moored at Berth 2 after shift");
  assert.equal(ship.mooredBerthId, "B2");
  assert.equal(ship.mooringSide, "port", "berthed port-side-to facing West");
  near(ship.x, BERTH_SPECS.B2.center[0], 1.5, "aligned at B2 X");
  const lines = computeMooringLines(ship, buildPortLayout(PORT_ORIGIN));
  assert.equal(lines.length, 6, "6 port-side hawser lines attached to B2 bollards");
});

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
