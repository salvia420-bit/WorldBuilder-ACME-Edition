// tests/vehicle_container_logistics.test.mjs — Deterministic Pinwheel LIFO & Fork Alignment Unit Tests
//
// Run: node external/holtburger/apps/holtburger-web/tests/vehicle_container_logistics.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as CL from "../scene3d/vehicle/container_logistics.js";
import {
  PINWHEEL_SLOTS_20 as MODEL_SLOTS_20,
  PINWHEEL_SLOTS_40 as MODEL_SLOTS_40,
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

check("pinwheel slot & GMA pallet parity with container_models.js", () => {
  assert.equal(CL.PINWHEEL_SLOTS_20.length, MODEL_SLOTS_20.length);
  for (let i = 0; i < MODEL_SLOTS_20.length; i++) {
    assert.deepEqual(CL.PINWHEEL_SLOTS_20[i], MODEL_SLOTS_20[i]);
  }
  assert.equal(CL.PINWHEEL_SLOTS_40.length, MODEL_SLOTS_40.length);
  for (let i = 0; i < MODEL_SLOTS_40.length; i++) {
    assert.deepEqual(CL.PINWHEEL_SLOTS_40[i], MODEL_SLOTS_40[i]);
  }
  assert.deepEqual(CL.GMA_PALLET_SPECS.full, MODEL_GMA.full);
  assert.deepEqual(CL.GMA_PALLET_SPECS.half, MODEL_GMA.half);
});

check("20ft full-pallet LIFO peel unloads 100% from 10 slots down to 0", () => {
  const occupied = CL.PINWHEEL_SLOTS_20.map((s) => ({
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

  // Unload slot 9 only -> slot 6 is still blocked by slot 8 (1.2192 > 1.176 half-width)
  const without9 = occupied.filter((o) => o.slotIndex !== 9);
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

check("40ft/40HC full-pallet LIFO peel unloads 100% from 21 slots down to 0", () => {
  const occupied = CL.PINWHEEL_SLOTS_40.map((s) => ({
    SlotIndex: s.slotIndex,
    PalletSize: "Full",
    SubSlot: 0,
    CargoWcid: 4000011,
  }));

  const initial = CL.computeReachableUnloadSlots("40HC", occupied);
  assert.deepEqual(
    initial.reachable.map((r) => r.slotIndex).sort((a, b) => a - b),
    [18, 20]
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
  assert.equal(order.length, 21);
});

check("half-pallet orient Y (+90 deg) subSlot 0 blocks subSlot 1; orient X side-by-side; 0.685m jack pinch", () => {
  // Orient Y slot 8 in 20ft: subSlot 0 is rear (-Y), subSlot 1 is front (+Y)
  const slot8 = CL.PINWHEEL_SLOTS_20[8];
  const s8_0 = CL.getSlotSubBox(slot8, "half", 0);
  const s8_1 = CL.getSlotSubBox(slot8, "half", 1);
  assert.ok(s8_0.y < s8_1.y, "orient Y subSlot 0 must be closer to -Y door than subSlot 1");
  near(s8_0.dx, 1.0160);
  near(s8_0.dy, 0.6096);

  const occY = [
    { slotIndex: 8, subSlot: 0, palletSize: 1, cargoWcid: 4000013 },
    { slotIndex: 8, subSlot: 1, palletSize: 1, cargoWcid: 4000015 },
  ];
  assert.equal(CL.isSlotReachableForUnload(10, occY, 8, 0).reachable, true);
  const blockedY = CL.isSlotReachableForUnload(10, occY, 8, 1);
  assert.equal(blockedY.reachable, false);
  assert.equal(blockedY.blockedBySlotIndex, 8);
  assert.equal(blockedY.blockedBySubSlot, 0);

  // Orient X slot 0 in 20ft: subSlot 0 & 1 sit side-by-side at equal Y
  const slot0 = CL.PINWHEEL_SLOTS_20[0];
  const s0_0 = CL.getSlotSubBox(slot0, "half", 0);
  const s0_1 = CL.getSlotSubBox(slot0, "half", 1);
  near(s0_0.y, s0_1.y);
  assert.ok(s0_0.x < s0_1.x);
  const occX = [
    { slotIndex: 0, subSlot: 0, palletSize: 1, cargoWcid: 4000013 },
    { slotIndex: 0, subSlot: 1, palletSize: 1, cargoWcid: 4000015 },
  ];
  assert.equal(CL.isSlotReachableForUnload(10, occX, 0, 0).reachable, true);
  assert.equal(CL.isSlotReachableForUnload(10, occX, 0, 1).reachable, true);

  // 0.685m pallet jack pinch between 18:0 (xMax = -0.5368) and 20 (xMin = +0.1304): gap = 0.6672m < 0.685m
  const pinchOcc = [
    { slotIndex: 18, subSlot: 0, palletSize: "half", cargoWcid: 4000013 },
    { slotIndex: 20, subSlot: 0, palletSize: "full", cargoWcid: 4000010 },
    { slotIndex: 16, subSlot: 1, palletSize: "half", cargoWcid: 4000015 },
  ];
  const pinchCheck = CL.isSlotReachableForUnload(11, pinchOcc, 16, 1);
  assert.equal(pinchCheck.reachable, false, "0.6672m gap cannot pass 0.685m pallet jack");

  // Full 20-half (20ft) and 42-half (40ft) peel tests
  for (const [kind, slots, expectedCount] of [
    [10, CL.PINWHEEL_SLOTS_20, 20],
    [11, CL.PINWHEEL_SLOTS_40, 42],
  ]) {
    const rem = [];
    for (const s of slots) {
      rem.push({ slotIndex: s.slotIndex, subSlot: 0, palletSize: 1, cargoWcid: 4000013 });
      rem.push({ slotIndex: s.slotIndex, subSlot: 1, palletSize: 1, cargoWcid: 4000015 });
    }
    let count = 0;
    while (rem.length > 0) {
      const res = CL.computeReachableUnloadSlots(kind, rem);
      assert.ok(res.reachable.length > 0, `half peel deadlock kind=${kind} rem=${rem.length}`);
      const pick = res.reachable[0];
      const idx = rem.findIndex((r) => r.slotIndex === pick.slotIndex && r.subSlot === pick.subSlot);
      rem.splice(idx, 1);
      count++;
    }
    assert.equal(count, expectedCount);
  }
});

check("computeReachableLoadSlots sorts deepest-first (+Y -> -Y) and fills 100% without self-blocking", () => {
  for (const [kind, expectedFull, expectedHalf] of [
    ["20ft", 10, 20],
    ["40ft", 21, 42],
  ]) {
    // Full load
    const occFull = [];
    let prevY = Infinity;
    const init = CL.computeReachableLoadSlots(kind, occFull, "full");
    assert.equal(init.reachable.length, expectedFull);
    for (const item of init.reachable) {
      assert.ok(item.y <= prevY + 1e-9, "initial load slots must be sorted +Y -> -Y");
      prevY = item.y;
    }
    while (occFull.length < expectedFull) {
      const res = CL.computeReachableLoadSlots(kind, occFull, "full");
      assert.ok(res.reachable.length > 0, `load deadlock at ${occFull.length}/${expectedFull}`);
      const pick = res.reachable[0];
      occFull.push({ slotIndex: pick.slotIndex, subSlot: 0, palletSize: 2, cargoWcid: 4000010 });
    }

    // Half load
    const occHalf = [];
    while (occHalf.length < expectedHalf) {
      const res = CL.computeReachableLoadSlots(kind, occHalf, "half");
      assert.ok(res.reachable.length > 0, `half load deadlock at ${occHalf.length}/${expectedHalf}`);
      const pick = res.reachable[0];
      occHalf.push({ slotIndex: pick.slotIndex, subSlot: pick.subSlot, palletSize: 1, cargoWcid: 4000013 });
    }
  }

  // Loading full pallet into half-occupied slot rejected
  const halfOcc = [{ slotIndex: 9, subSlot: 0, palletSize: 1, cargoWcid: 4000013 }];
  const loadFullOnHalf = CL.isSlotReachableForLoad(10, halfOcc, 9, 0, "full");
  assert.equal(loadFullOnHalf.reachable, false);
  assert.equal(loadFullOnHalf.reason, "slot_occupied");
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
  const bayTargets = [{ id: "bay18", x: -0.5368, y: -5.4864, heading: 0.0, fourWay: false }];
  assert.equal(CL.findNearestForkEngageTarget({ x: -0.5, y: -5.5, heading: deg(90) }, bayTargets), null);
  const bayOk = CL.findNearestForkEngageTarget({ x: -0.5, y: -5.5, heading: deg(20) }, bayTargets);
  assert.ok(bayOk && bayOk.target.id === "bay18");

  // Non-finite inputs safe
  assert.equal(CL.findNearestForkEngageTarget({ x: NaN, y: 0, heading: 0 }, targets), null);
  assert.equal(CL.findNearestForkEngageTarget(null, targets), null);
});

check("isSlotReachableForLoad and isSlotReachableForUnload validate slotIndex, subSlot, and palletSize parity", () => {
  const halfOcc = [{ slotIndex: 0, subSlot: 0, palletSize: "half", cargoWcid: 4000013 }];
  const fullOcc = [{ slotIndex: 0, subSlot: 0, palletSize: "full", cargoWcid: 4000010 }];

  // NaN / negative / OOB slotIndex must return invalid_slot without throwing
  assert.equal(CL.isSlotReachableForLoad(10, [], NaN, 0, "full").reason, "invalid_slot");
  assert.equal(CL.isSlotReachableForLoad(10, [], -1, 0, "full").reason, "invalid_slot");
  assert.equal(CL.isSlotReachableForLoad(10, [], 10, 0, "full").reason, "invalid_slot");
  assert.equal(CL.isSlotReachableForUnload(10, halfOcc, NaN, 0).reason, "invalid_slot");
  assert.equal(CL.isSlotReachableForUnload(10, halfOcc, -1, 0).reason, "invalid_slot");
  assert.equal(CL.isSlotReachableForUnload(10, halfOcc, 99, 0).reason, "invalid_slot");

  // OOB / non-finite subSlot and subSlot=1 for full pallet -> invalid_subslot
  assert.equal(CL.isSlotReachableForLoad(10, [], 0, NaN, "half").reason, "invalid_subslot");
  assert.equal(CL.isSlotReachableForLoad(10, [], 0, -1, "half").reason, "invalid_subslot");
  assert.equal(CL.isSlotReachableForLoad(10, [], 0, 2, "half").reason, "invalid_subslot");
  assert.equal(CL.isSlotReachableForLoad(10, [], 0, 1, "full").reason, "invalid_subslot");
  assert.equal(CL.isSlotReachableForUnload(10, halfOcc, 0, 2).reason, "invalid_subslot");
  assert.equal(CL.isSlotReachableForUnload(10, halfOcc, 0, 255).reason, "invalid_subslot");
  assert.equal(CL.isSlotReachableForUnload(10, fullOcc, 0, 1).reason, "invalid_subslot");

  // Unknown palletSize -> invalid_pallet_size
  assert.equal(CL.isSlotReachableForLoad(10, [], 0, 0, "quarter").reason, "invalid_pallet_size");
  assert.equal(CL.isSlotReachableForLoad(10, [], 0, 0, 99).reason, "invalid_pallet_size");
});

console.log(`=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  process.exit(1);
}
