// tests/vehicle_sidelifter_kinematics.test.mjs — Deterministic ISO 3874 Sidelifter Kinematics Unit Tests
//
// Run: node external/holtburger/apps/holtburger-web/tests/vehicle_sidelifter_kinematics.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as SK from "../scene3d/vehicle/sidelifter_kinematics.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_PATH = join(HERE, "../scene3d/vehicle/sidelifter_kinematics.js");

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

function near(a, b, eps = 1e-9, msg = "near") {
  if (!Number.isFinite(a) || Math.abs(a - b) > eps) {
    throw new Error(`${msg}: expected ${b} ± ${eps}, got ${a}`);
  }
}

console.log("=== vehicle_sidelifter_kinematics.test.mjs ===");

check("zero external, DOM, or Three.js imports", () => {
  const src = readFileSync(SRC_PATH, "utf8");
  assert.equal(/^\s*import\s+/m.test(src), false, "must have zero import statements");
  assert.equal(/\b(THREE|document|window)\b/.test(src), false, "must not reference THREE/document/window");
});

check("ISO 3874 constants, phase enum 0..10, and phase durations", () => {
  assert.equal(SK.SIDELIFTER_OUTREACH_X, 3.85);
  assert.equal(SK.OUTRIGGER_REACH_X, 3.60);
  assert.equal(SK.HOIST_CLEARANCE_Z, 0.45);
  assert.equal(SK.SWING_ARC_CROWN_Z, 0.25);
  assert.equal(SK.MAX_SLOPE_COS, 0.9945);
  assert.equal(SK.CHASSIS_DECK_Z, 1.32);
  assert.equal(SK.CRANE_SPAN_Y_20FT, 2.9265);
  assert.equal(SK.CRANE_SPAN_Y_40FT, 5.9925);

  assert.equal(Object.isFrozen(SK.SIDELIFT_PHASE), true);
  assert.equal(Object.isFrozen(SK.SIDELIFT_PHASE_NAMES), true);
  assert.equal(Object.isFrozen(SK.SIDELIFT_PHASE_DURATIONS), true);
  assert.equal(SK.SIDELIFT_PHASE_NAMES.length, 11);
  for (let i = 0; i <= 10; i++) {
    const name = SK.SIDELIFT_PHASE_NAMES[i];
    assert.equal(SK.SIDELIFT_PHASE[name], i);
  }
  assert.equal(SK.getPhaseDuration(SK.SIDELIFT_PHASE.Idle), 0.0);
  assert.equal(SK.getPhaseDuration(SK.SIDELIFT_PHASE.OutriggersPlanted), 0.0);
  assert.equal(SK.getPhaseDuration(SK.SIDELIFT_PHASE.OutriggersDeploying), 2.2);
  assert.equal(SK.getPhaseDuration(SK.SIDELIFT_PHASE.Swinging), 3.0);
  assert.equal(SK.getPhaseDuration("Hoisting"), 1.8);
  assert.equal(SK.getPhaseDuration(99), 0.0);
});

check("computeCraneSpanY handles 20ft, 40ft, 40HC, WCIDs, strings, objects, and default", () => {
  assert.equal(SK.computeCraneSpanY(10), 2.9265);
  assert.equal(SK.computeCraneSpanY(4000020), 2.9265);
  assert.equal(SK.computeCraneSpanY("20ft"), 2.9265);
  assert.equal(SK.computeCraneSpanY("22G1"), 2.9265);
  assert.equal(SK.computeCraneSpanY({ kind: 10 }), 2.9265);

  assert.equal(SK.computeCraneSpanY(11), 5.9925);
  assert.equal(SK.computeCraneSpanY(12), 5.9925);
  assert.equal(SK.computeCraneSpanY(4000021), 5.9925);
  assert.equal(SK.computeCraneSpanY(4000022), 5.9925);
  assert.equal(SK.computeCraneSpanY("40ft"), 5.9925);
  assert.equal(SK.computeCraneSpanY("40HC"), 5.9925);
  assert.equal(SK.computeCraneSpanY(null), 5.9925);
  assert.equal(SK.computeCraneSpanY(undefined), 5.9925);
});

check("clamp01 & smoothstep boundary clamping and monotonicity", () => {
  assert.equal(SK.clamp01(-1), 0);
  assert.equal(SK.clamp01(NaN), 0);
  assert.equal(SK.clamp01(-Infinity), 0);
  assert.equal(SK.clamp01(Infinity), 1);
  assert.equal(SK.clamp01(2.5), 1);
  assert.equal(SK.clamp01(0.25), 0.25);

  assert.equal(SK.smoothstep(-0.5), 0);
  assert.equal(SK.smoothstep(0), 0);
  assert.equal(SK.smoothstep(0.5), 0.5);
  assert.equal(SK.smoothstep(1), 1);
  assert.equal(SK.smoothstep(1.5), 1);
  let prev = 0;
  for (let i = 1; i <= 20; i++) {
    const v = SK.smoothstep(i / 20);
    assert.ok(v >= prev);
    prev = v;
  }
});

check("phase boundary C0 continuity (< 1e-12) across 0->10 for offload/load and side +/-1", () => {
  for (const direction of ["offload", "load"]) {
    for (const side of [1, -1]) {
      for (const groundZ of [-0.5, 0.0, 1.5]) {
        for (let ph = 0; ph < 10; ph++) {
          const endOfCurr = SK.evaluateContainerLocalPose(ph, 1.0, side, direction, 1.32, groundZ, 0.25);
          const startOfNext = SK.evaluateContainerLocalPose(ph + 1, 0.0, side, direction, 1.32, groundZ, 0.25);
          near(endOfCurr.x, startOfNext.x, 1e-12, `${direction} side=${side} gnd=${groundZ} ph=${ph}->${ph + 1} x`);
          near(endOfCurr.y, startOfNext.y, 1e-12, `${direction} side=${side} gnd=${groundZ} ph=${ph}->${ph + 1} y`);
          near(endOfCurr.z, startOfNext.z, 1e-12, `${direction} side=${side} gnd=${groundZ} ph=${ph}->${ph + 1} z`);
          near(endOfCurr.craneBoomAngle, startOfNext.craneBoomAngle, 1e-12, `boom ${ph}->${ph + 1}`);
          near(endOfCurr.craneJibAngle, startOfNext.craneJibAngle, 1e-12, `jib ${ph}->${ph + 1}`);
          near(endOfCurr.chainLen, startOfNext.chainLen, 1e-12, `chain ${ph}->${ph + 1}`);
        }
      }
    }
  }
});

check("level-lift invariant, hoist clearance, swing crown peak, and exact touchdown", () => {
  for (const direction of ["offload", "load"]) {
    for (const side of [1, -1]) {
      const deckZ = 1.32;
      const groundZ = -0.35;
      const hoistFloor = Math.max(deckZ, groundZ) + SK.HOIST_CLEARANCE_Z;

      const start = SK.evaluateContainerLocalPose(SK.SIDELIFT_PHASE.Idle, 0, side, direction, deckZ, groundZ, 0.0);
      near(start.x, direction === "load" ? side * 3.85 : 0.0, 1e-12);
      near(start.z, direction === "load" ? groundZ : deckZ, 1e-12);

      const swingMid = SK.evaluateContainerLocalPose(SK.SIDELIFT_PHASE.Swinging, 0.5, side, direction, deckZ, groundZ, 0.0);
      near(swingMid.x, side * 3.85 * 0.5, 1e-12);
      near(swingMid.z, hoistFloor + SK.SWING_ARC_CROWN_Z, 1e-12);
      assert.equal(swingMid.roll, 0.0);

      for (let i = 0; i <= 10; i++) {
        const sw = SK.evaluateContainerLocalPose(SK.SIDELIFT_PHASE.Swinging, i / 10, side, direction, deckZ, groundZ);
        assert.equal(sw.roll, 0.0);
        assert.ok(sw.z >= hoistFloor - 1e-12);
      }

      const end = SK.evaluateContainerLocalPose(SK.SIDELIFT_PHASE.OutriggersRetracting, 1.0, side, direction, deckZ, groundZ, 0.0);
      near(end.x, direction === "offload" ? side * 3.85 : 0.0, 1e-12);
      near(end.z, direction === "offload" ? groundZ : deckZ, 1e-12);
      near(end.craneBoomAngle, 0.0, 1e-12);
      near(end.craneJibAngle, 0.0, 1e-12);
      near(end.chainLen, 0.0, 1e-12);
    }
  }
});

check("checkOutriggerSlope & isSlopeWithinLimit enforce ISO 3874 <= 6 deg", () => {
  assert.equal(SK.isSlopeWithinLimit(1.0), true);
  assert.equal(SK.isSlopeWithinLimit(0.9945), true);
  assert.equal(SK.isSlopeWithinLimit(0.99449), false);
  assert.equal(SK.isSlopeWithinLimit(NaN), false);

  // Flat ground
  const flat = SK.checkOutriggerSlope([10, 10, 10, 10]);
  assert.equal(flat.ok, true);
  near(flat.cosTheta, 1.0, 1e-12);

  // 5.9 deg cross-slope (tan(5.9 deg) * 2.44) -> passes
  const dz59 = Math.tan((5.9 * Math.PI) / 180) * 2.44;
  const pass59 = SK.checkOutriggerSlope([10, 10 + dz59, 10, 10 + dz59]);
  assert.equal(pass59.ok, true);

  // 6.0 deg cross-slope -> passes (cos(6.0) = 0.9945219 >= 0.9945)
  const dz60 = Math.tan((6.0 * Math.PI) / 180) * 2.44;
  const pass60 = SK.checkOutriggerSlope([10, 10 + dz60, 10, 10 + dz60]);
  assert.equal(pass60.ok, true);

  // 6.1 deg cross-slope -> fails
  const dz61 = Math.tan((6.1 * Math.PI) / 180) * 2.44;
  const fail61 = SK.checkOutriggerSlope([10, 10 + dz61, 10, 10 + dz61]);
  assert.equal(fail61.ok, false);

  // Single-corner drop -> edge slope fails even if average plane looks gentle
  const singleDrop = SK.checkOutriggerSlope([10, 10, 10, 10 - 0.35], 2.44, 11.985);
  assert.equal(singleDrop.ok, false);

  // Normal-array inputs
  assert.equal(SK.checkOutriggerSlope([[0, 0, 1], [0.05, 0, 1]]).ok, true);
  assert.equal(SK.checkOutriggerSlope([[0, 0, 1], [0.2, 0, 1]]).ok, false);
  assert.equal(SK.checkOutriggerSlope([[0, 0, 0]]).ok, false);
  assert.equal(SK.checkOutriggerSlope([[0, 0, -1]]).ok, false);
  assert.equal(SK.checkOutriggerSlope([]).ok, false);
});

check("hostile / non-finite inputs never produce NaN", () => {
  for (const ph of [NaN, Infinity, -Infinity, null, undefined, -5, 999]) {
    for (const p of [NaN, Infinity, -Infinity, null, undefined, -10, 10]) {
      const pose = SK.evaluateContainerLocalPose(ph, p, null, null, NaN, Infinity, undefined);
      for (const k of Object.keys(pose)) {
        assert.equal(Number.isFinite(pose[k]), true, `${k} must be finite`);
      }
    }
  }
  assert.equal(SK.checkOutriggerSlope(null).ok, false);
  assert.equal(SK.checkOutriggerSlope([1, 1, 1, NaN]).ok, false);
});

console.log(`=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  process.exit(1);
}
