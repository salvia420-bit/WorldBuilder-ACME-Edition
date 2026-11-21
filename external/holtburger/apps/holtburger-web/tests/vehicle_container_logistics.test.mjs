// tests/vehicle_container_logistics.test.mjs — Deterministic Pinwheel LIFO & Fork Alignment Unit Tests
//
// Run: node external/holtburger/apps/holtburger-web/tests/vehicle_container_logistics.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as CL from "../scene3d/vehicle/container_logistics.js";
import {
  CONTAINER_SLOTS_20 as MODEL_SLOTS_20,
  CONTAINER_SLOTS_40 as MODEL_SLOTS_40,
  PINWHEEL_SLOTS_20 as MODEL_PW_20,
  PINWHEEL_SLOTS_40 as MODEL_PW_40,
  GMA_PALLET_SPECS as MODEL_GMA,
} from "../scene3d/vehicle/container_models.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_PATH = join(HERE, "../scene3d/vehicle/container_logistics.js");

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [OK] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name}: ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`);
  }
}

function near(a, b, eps = 1e-6, msg = "near") {
  if (!Number.isFinite(a) || Math.abs(a - b) > eps) {
    throw new Error(`${msg}: expected ${b} ± ${eps}, got ${a}`);
  }
}

console.log("=== vehicle_container_logistics.test.mjs ===");

check("zero external, DOM, Three.js, or container_models.js imports", () => {
  const src = readFileSync(SRC_PATH, "utf8");
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.equal(/^\s*import\s+/m.test(src), false, "must have zero import statements");
  assert.equal(/\b(THREE|document|window|container_models)\b/.test(codeOnly), false);
});

check("2-wide container slot & unified pallet parity with container_models.js", () => {
  assert.equal(CL.CONTAINER_SLOTS_20.length, 10);
  assert.equal(CL.CONTAINER_SLOTS_40.length, 20);
  assert.equal(CL.PINWHEEL_SLOTS_20, CL.CONTAINER_SLOTS_20);
  assert.equal(CL.PINWHEEL_SLOTS_40, CL.CONTAINER_SLOTS_40);
  assert.equal(MODEL_PW_20, MODEL_SLOTS_20);
  assert.equal(MODEL_PW_40, MODEL_SLOTS_40);

  assert.equal(CL.CONTAINER_SLOTS_20.length, MODEL_SLOTS_20.length);
  for (let i = 0; i < MODEL_SLOTS_20.length; i++) {
    assert.deepEqual(CL.CONTAINER_SLOTS_20[i], MODEL_SLOTS_20[i]);
  }
  assert.equal(CL.CONTAINER_SLOTS_40.length, MODEL_SLOTS_40.length);
  for (let i = 0; i < MODEL_SLOTS_40.length; i++) {
    assert.deepEqual(CL.CONTAINER_SLOTS_40[i], MODEL_SLOTS_40[i]);
  }
  assert.deepEqual(CL.GMA_PALLET_SPECS.full, MODEL_GMA.full);
  assert.deepEqual(CL.GMA_PALLET_SPECS.standard, MODEL_GMA.standard);
  assert.deepEqual(CL.PALLET_SPECS.standard, { width: 1.100, depth: 1.100, height: 0.145 });
  assert.equal(CL.HALF_PALLET_WCIDS.size, 0);
  assert.equal(Object.isFrozen(CL.HALF_PALLET_WCIDS), true);
});

check("2-wide grid non-overlap and interior margin invariants (5.1 cm walls, 5.0 cm center aisle, 3.85 cm rib clearance)", () => {
  const ribHalfW = 1.1635; // 1.176 - 0.0125 corrugation rib intrusion
  for (const [kind, slots, expectedLen] of [
    ["20ft", CL.CONTAINER_SLOTS_20, 10],
    ["40ft", CL.CONTAINER_SLOTS_40, 20],
    ["40HC", CL.CONTAINER_SLOTS_40, 20],
  ]) {
    const spec = CL.resolveContainerLogisticsSpec(kind);
    assert.equal(slots.length, expectedLen);
    assert.equal(spec.interior.maxFull, expectedLen);

    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      const expectedColX = i % 2 === 0 ? -0.575 : +0.575;
      assert.equal(s.slotIndex, i);
      near(s.x, expectedColX, 1e-6, `${kind} slot ${i} X`);
      near(s.dx, 1.100, 1e-6);
      near(s.dy, 1.100, 1e-6);
      assert.equal(s.orient, "Y");

      // Wall clearance = 1.176 - (0.575 + 0.550) = 0.051 m (5.1 cm); rib clearance = 0.0385 m (3.85 cm)
      near(spec.interior.halfW - (Math.abs(s.x) + s.dx * 0.5), 0.051, 1e-4, `${kind} wall clearance`);
      assert.ok(Math.abs(s.x) + s.dx * 0.5 <= ribHalfW - 0.038, `${kind} rib clearance >= 3.8 cm`);
      assert.ok(Math.abs(s.y) + s.dy * 0.5 <= spec.interior.halfL - 0.07, `${kind} end wall clearance`);

      for (let j = i + 1; j < slots.length; j++) {
        const t = slots[j];
        const ox = Math.min(s.x + s.dx * 0.5, t.x + t.dx * 0.5) - Math.max(s.x - s.dx * 0.5, t.x - t.dx * 0.5);
        const oy = Math.min(s.y + s.dy * 0.5, t.y + t.dy * 0.5) - Math.max(s.y - s.dy * 0.5, t.y - t.dy * 0.5);
        assert.ok(ox <= 1e-6 || oy <= 1e-6, `${kind} overlap ${i} vs ${j}`);
      }
    }

    // Center aisle = (+0.575 - 0.550) - (-0.575 + 0.550) = 0.050 m (5.0 cm)
    const leftEdge = slots[0].x + slots[0].dx * 0.5;
    const rightEdge = slots[1].x - slots[1].dx * 0.5;
    near(rightEdge - leftEdge, 0.050, 1e-6, `${kind} center aisle 5.0 cm`);
  }
});

check("20ft unified LIFO peel unloads 100% from 10 slots down to 0", () => {
  const occupied = CL.CONTAINER_SLOTS_20.map((s) => ({
    slotIndex: s.slotIndex,
    palletSize: 2,
    subSlot: 0,
    cargoWcid: 4000010,
  }));

  const initial = CL.computeReachableUnloadSlots(10, occupied);
  assert.deepEqual(
    initial.reachable.map((r) => r.slotIndex).sort((a, b) => a - b),
    [8, 9]
  );
  assert.equal(initial.blocked.length, 8);
  assert.equal(CL.isSlotReachableForUnload(10, occupied, 0).reachable, false);
  assert.ok(CL.isSlotReachableForUnload(10, occupied, 0).blockedBySlotIndex !== null);

  // Unload slot 9 only -> right-lane slot 7 opens while left-lane slot 6 stays blocked by slot 8
  const without9 = occupied.filter((o) => o.slotIndex !== 9);
  assert.equal(CL.isSlotReachableForUnload(10, without9, 7).reachable, true);
  assert.equal(CL.isSlotReachableForUnload(10, without9, 6).reachable, false);
  assert.equal(CL.isSlotReachableForUnload(10, without9, 6).blockedBySlotIndex, 8);

  const remaining = [...occupied];
  const order = [];
  while (remaining.length > 0) {
    const res = CL.computeReachableUnloadSlots("20ft", remaining);
    assert.ok(res.reachable.length > 0, `deadlock with ${remaining.length} remaining`);
    const pick = res.reachable[0];
    order.push(pick.slotIndex);
    const idx = remaining.findIndex((r) => r.slotIndex === pick.slotIndex);
    remaining.splice(idx, 1);
  }
  assert.equal(order.length, 10);
});

check("40ft/40HC unified LIFO peel unloads 100% from 20 slots down to 0", () => {
  const occupied = CL.CONTAINER_SLOTS_40.map((s) => ({
    SlotIndex: s.slotIndex,
    PalletSize: "Full",
    SubSlot: 0,
    CargoWcid: 4000011,
  }));

  const initial = CL.computeReachableUnloadSlots("40HC", occupied);
  assert.deepEqual(
    initial.reachable.map((r) => r.slotIndex).sort((a, b) => a - b),
    [18, 19]
  );

  const remaining = [...occupied];
  const order = [];
  while (remaining.length > 0) {
    const res = CL.computeReachableUnloadSlots(4000022, remaining);
    assert.ok(res.reachable.length > 0, `40ft deadlock with ${remaining.length} remaining`);
    const pick = res.reachable[0];
    order.push(pick.slotIndex);
    const idx = remaining.findIndex((r) => r.slotIndex === pick.slotIndex);
    remaining.splice(idx, 1);
  }
  assert.equal(order.length, 20);
});

check("independent Left/Right lane LIFO peel & load (100% unload & load with zero deadlock)", () => {
  for (const [kind, slots] of [
    ["20ft", CL.CONTAINER_SLOTS_20],
    ["40ft", CL.CONTAINER_SLOTS_40],
  ]) {
    // Fill entire Right lane (odd indices) while Left lane (even indices) starts empty
    const rightLaneOcc = slots
      .filter((s) => s.slotIndex % 2 === 1)
      .map((s) => ({ slotIndex: s.slotIndex, palletSize: 2, subSlot: 0, cargoWcid: 4000013 }));

    // Clear lane width = 1.176 - (-0.025) = 1.201 m >= max(1.100, 0.685) => Left lane loads back-to-front with 0 deadlock!
    const allOcc = [...rightLaneOcc];
    const leftCount = slots.length / 2;
    for (let step = 0; step < leftCount; step++) {
      const load = CL.computeReachableLoadSlots(kind, allOcc, "standard");
      assert.ok(load.reachable.length > 0, `${kind} left lane load deadlock at step ${step}`);
      assert.equal(load.reachable[0].slotIndex, step * 2, `${kind} deepest left slot ${step * 2} loaded first`);
      allOcc.push({ slotIndex: load.reachable[0].slotIndex, palletSize: 2, subSlot: 0, cargoWcid: 4000015 });
    }
    assert.equal(allOcc.length, slots.length);

    // Now unload ONLY the Left lane shallowest-first while Right lane remains 100% full
    const leftLane = allOcc.filter((s) => s.slotIndex % 2 === 0);
    const keepRight = [...rightLaneOcc];
    for (let step = leftCount - 1; step >= 0; step--) {
      const targetIdx = step * 2;
      const checkUnload = CL.isSlotReachableForUnload(kind, [...keepRight, ...leftLane], targetIdx, 0);
      assert.equal(checkUnload.reachable, true, `${kind} left slot ${targetIdx} reachable with full right lane`);
      const pos = leftLane.findIndex((s) => s.slotIndex === targetIdx);
      leftLane.splice(pos, 1);
    }
    assert.equal(leftLane.length, 0);

    // And unload Right lane independently from front to back
    while (keepRight.length > 0) {
      const res = CL.computeReachableUnloadSlots(kind, keepRight);
      assert.ok(res.reachable.length > 0, `${kind} right lane unload deadlock`);
      const pick = res.reachable[0];
      const pos = keepRight.findIndex((s) => s.slotIndex === pick.slotIndex);
      keepRight.splice(pos, 1);
    }
  }
});

check("computeReachableLoadSlots sorts deepest-first (+Y -> -Y) and fills 100% without self-blocking", () => {
  for (const [kind, expectedFull] of [
    ["20ft", 10],
    ["40ft", 20],
    ["40HC", 20],
  ]) {
    const occFull = [];
    let prevY = Infinity;
    const init = CL.computeReachableLoadSlots(kind, occFull, "full");
    assert.equal(init.reachable.length, expectedFull);
    for (const item of init.reachable) {
      assert.ok(item.y <= prevY + 1e-9, "initial load slots must be sorted +Y -> -Y");
      assert.equal(item.subSlot, 0);
      prevY = item.y;
    }
    while (occFull.length < expectedFull) {
      const res = CL.computeReachableLoadSlots(kind, occFull, "full");
      assert.ok(res.reachable.length > 0, `load deadlock at ${occFull.length}/${expectedFull}`);
      const pick = res.reachable[0];
      occFull.push({ slotIndex: pick.slotIndex, subSlot: 0, palletSize: 2, cargoWcid: 4000010 });
    }

    // Legacy "half" palletSize rejected for loading
    const halfLoad = CL.computeReachableLoadSlots(kind, [], "half");
    assert.equal(halfLoad.reachable.length, 0);
    assert.equal(halfLoad.all.length, 0);
  }
});

check("findNearestForkEngageTarget handles 4-way GMA, directional container bay, and boundary limits", () => {
  const deg = (d) => (d * Math.PI) / 180.0;
  const targets = [
    { id: "gma1", x: 10.2, y: 20.0, heading: 0.0, fourWay: true },
    { id: "blocked", x: 10.0, y: 20.0, heading: 0.0, reachable: false },
  ];

  // 4-way cardinal engagement: 90 deg + 27 deg passes
  const m90 = CL.findNearestForkEngageTarget({ x: 10.0, y: 20.0, heading: deg(90 + 27) }, targets);
  assert.ok(m90 && m90.target.id === "gma1");
  assert.equal(m90.canEngage, true);

  // 180 deg - 27 deg passes
  const m180 = CL.findNearestForkEngageTarget({ x: 10.0, y: 20.0, heading: deg(180 - 27) }, targets);
  assert.ok(m180 && m180.target.id === "gma1");

  // 45 deg is outside ±28 deg of every cardinal axis -> null
  const m45 = CL.findNearestForkEngageTarget({ x: 10.0, y: 20.0, heading: deg(45) }, targets);
  assert.equal(m45, null);

  // Beyond 0.55m -> null
  const far = CL.findNearestForkEngageTarget({ x: 9.64, y: 20.0, heading: 0.0 }, targets);
  assert.equal(far, null);

  // Directional container bay (fourWay: false): 90 deg rejected, 20 deg accepted
  const bayTargets = [{ id: "bay18", x: -0.575, y: -5.310, heading: 0.0, fourWay: false }];
  assert.equal(CL.findNearestForkEngageTarget({ x: -0.55, y: -5.30, heading: deg(90) }, bayTargets), null);
  const bayOk = CL.findNearestForkEngageTarget({ x: -0.55, y: -5.30, heading: deg(20) }, bayTargets);
  assert.ok(bayOk && bayOk.target.id === "bay18");

  // Non-finite inputs safe
  assert.equal(CL.findNearestForkEngageTarget({ x: NaN, y: 0, heading: 0 }, targets), null);
  assert.equal(CL.findNearestForkEngageTarget(null, targets), null);
});

check("isSlotReachableForLoad and isSlotReachableForUnload validate slotIndex, subSlot, palletSize, and legacy normalization", () => {
  const legacyHalfOcc = [{ slotIndex: 0, subSlot: 0, palletSize: 1, cargoWcid: 4000013 }];
  const fullOcc = [{ slotIndex: 0, subSlot: 0, palletSize: "full", cargoWcid: 4000010 }];

  // Legacy palletSize===1 in occupiedSlots gracefully normalizes to unified full slot 0
  assert.equal(CL.isSlotReachableForUnload(10, legacyHalfOcc, 0, 0).reachable, true);
  assert.equal(CL.isSlotReachableForLoad(10, legacyHalfOcc, 0, 0, "full").reason, "slot_occupied");
  assert.equal(CL.isSlotReachableForLoad(10, [], 0, 0, "standard").reachable, true);
  assert.equal(CL.isSlotReachableForLoad(10, [], 0, 0, 2).reachable, true);

  // NaN / negative / OOB / fractional slotIndex must return invalid_slot without throwing
  assert.equal(CL.isSlotReachableForLoad(10, [], NaN, 0, "full").reason, "invalid_slot");
  assert.equal(CL.isSlotReachableForLoad(10, [], -1, 0, "full").reason, "invalid_slot");
  assert.equal(CL.isSlotReachableForLoad(10, [], 10, 0, "full").reason, "invalid_slot");
  assert.equal(CL.isSlotReachableForLoad(11, [], 20, 0, "full").reason, "invalid_slot");
  assert.equal(CL.isSlotReachableForLoad(10, [], 0.5, 0, "full").reason, "invalid_slot");
  assert.equal(CL.isSlotReachableForLoad(10, [], 1.5, 0, "full").reason, "invalid_slot");
  assert.equal(CL.isSlotReachableForUnload(10, legacyHalfOcc, NaN, 0).reason, "invalid_slot");
  assert.equal(CL.isSlotReachableForUnload(10, legacyHalfOcc, -1, 0).reason, "invalid_slot");
  assert.equal(CL.isSlotReachableForUnload(10, legacyHalfOcc, 99, 0).reason, "invalid_slot");
  assert.equal(CL.isSlotReachableForUnload(10, legacyHalfOcc, 0.5, 0).reason, "invalid_slot");
  assert.equal(CL.isSlotReachableForUnload(10, legacyHalfOcc, 1.5, 0).reason, "invalid_slot");

  // Any subSlot !== 0, fractional, or non-finite subSlot -> invalid_subslot
  assert.equal(CL.isSlotReachableForLoad(10, [], 0, NaN, "full").reason, "invalid_subslot");
  assert.equal(CL.isSlotReachableForLoad(10, [], 0, -1, "full").reason, "invalid_subslot");
  assert.equal(CL.isSlotReachableForLoad(10, [], 0, 1, "full").reason, "invalid_subslot");
  assert.equal(CL.isSlotReachableForLoad(10, [], 0, 2, "full").reason, "invalid_subslot");
  assert.equal(CL.isSlotReachableForLoad(10, [], 0, 0.5, "full").reason, "invalid_subslot");
  assert.equal(CL.isSlotReachableForLoad(10, [], 0, -0.5, "full").reason, "invalid_subslot");
  assert.equal(CL.isSlotReachableForUnload(10, legacyHalfOcc, 0, 1).reason, "invalid_subslot");
  assert.equal(CL.isSlotReachableForUnload(10, legacyHalfOcc, 0, 2).reason, "invalid_subslot");
  assert.equal(CL.isSlotReachableForUnload(10, legacyHalfOcc, 0, 255).reason, "invalid_subslot");
  assert.equal(CL.isSlotReachableForUnload(10, legacyHalfOcc, 0, 0.5).reason, "invalid_subslot");
  assert.equal(CL.isSlotReachableForUnload(10, fullOcc, 0, 1).reason, "invalid_subslot");
  assert.equal(CL.isSlotReachableForUnload(10, fullOcc, 0, 0.25).reason, "invalid_subslot");

  // Explicit "half" / 1 / unknown palletSize -> invalid_pallet_size
  assert.equal(CL.isSlotReachableForLoad(10, [], 0, 0, "half").reason, "invalid_pallet_size");
  assert.equal(CL.isSlotReachableForLoad(10, [], 0, 0, 1).reason, "invalid_pallet_size");
  assert.equal(CL.isSlotReachableForLoad(10, [], 0, 0, "quarter").reason, "invalid_pallet_size");
  assert.equal(CL.isSlotReachableForLoad(10, [], 0, 0, 99).reason, "invalid_pallet_size");
});

console.log(`=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  process.exit(1);
}
