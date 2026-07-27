// P5.5 — headless unit test for `harness/lib/movement_gate.mjs`.
//
// The regression it exists to prevent is a real one that already happened:
// PHY-07-LIVE-RUN-2026-07-26's `collide.cjs` reported `BLOCKED (plateau)`
// against a player who had never moved, and its turn loop froze at a single
// constant heading error because heading came from the degenerate camera
// basis of LIVE-03. The gate must call both of those INVALID, not BLOCKED.
//
// Run:  node test_p5_5_movement_gate.mjs

import {
  movementGate, poseToGlobalXY, wrapPi, LANDBLOCK_M,
} from "./harness/lib/movement_gate.mjs";

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`  [PASS] ${name}`); }
  else { failed += 1; console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

// Holtburg-ish landblock ids: 0xa9b4xxxx → block x = 0xa9, block y = 0xb4.
const LB = 0xa9b40019;
const LB_WEST = 0xa8b40019; // one landblock west (block x - 1)

const pose = (lb, x, y, heading) => ({ landblockId: lb, x, y, heading });

// ---- 1. coordinate lift ----------------------------------------------------
{
  const g = poseToGlobalXY(pose(LB, 10, 20, 0));
  check("pose lifts to global XY with the 192 m landblock stride",
    g.gx === 0xa9 * LANDBLOCK_M + 10 && g.gy === 0xb4 * LANDBLOCK_M + 20,
    JSON.stringify(g));
  check("poseToGlobalXY rejects an unusable sample",
    poseToGlobalXY(null) === null &&
    poseToGlobalXY({ landblockId: LB, x: NaN, y: 3 }) === null);
  check("wrapPi folds a ±π crossing to the short way round",
    Math.abs(wrapPi(Math.PI + 0.1) - (-Math.PI + 0.1)) < 1e-9,
    String(wrapPi(Math.PI + 0.1)));
}

// ---- 2. the collide.cjs false positive ------------------------------------
{
  // Bit-identical pose repeated — the LIVE-02 wedge. Under the old rigs this
  // produced a flat distance series and a `BLOCKED (plateau)` verdict.
  const frozen = Array.from({ length: 24 }, () => pose(LB, 129.6, 95.5, 1.234));
  const r = movementGate(frozen);
  check("a frozen player is INVALID, never BLOCKED",
    r.verdict === "INVALID — player never moved" && r.valid === false, r.verdict);
  check("the frozen run reports zero path length", r.pathM === 0, String(r.pathM));
}

// ---- 3. the LIVE-03 turn-loop freeze --------------------------------------
{
  // Player translates fine, but heading is the identical value every sample —
  // the signature of heading being read off a degenerate camera basis.
  const walked = Array.from({ length: 10 }, (_, i) =>
    pose(LB, 100 + i * 2, 100, 1.234));
  const r = movementGate(walked);
  check("moving with a frozen heading is INVALID",
    r.verdict === "INVALID — heading never changed" && r.valid === false, r.verdict);
  check("...but a straight-line harness may opt out of the heading gate",
    movementGate(walked, { requireHeading: false }).valid === true);
}

// ---- 4. a genuine walk passes ---------------------------------------------
{
  const walked = Array.from({ length: 10 }, (_, i) =>
    pose(LB, 100 + i * 2, 100 + i, 1.0 + i * 0.05));
  const r = movementGate(walked);
  check("a real walk-and-turn passes the gate",
    r.verdict === "MOVED" && r.valid === true, r.verdict);
  check("path length is measured, not just endpoints",
    r.pathM > r.netDisplacementM - 1e-9 && r.pathM > 15,
    `path=${r.pathM} net=${r.netDisplacementM}`);
  check("heading turn accumulates the per-step deltas",
    Math.abs(r.headingTurnedRad - 0.45) < 1e-3, String(r.headingTurnedRad));
}

// ---- 5. a landblock crossing is not a 192 m teleport ----------------------
{
  // Walk west across the boundary: local x wraps 2 → 190 in the NEXT block
  // west, which is a 4 m step in global coords, not 188 m.
  const crossing = [
    pose(LB, 2, 100, 0.0),
    pose(LB_WEST, 190, 100, 0.1),
  ];
  const r = movementGate(crossing);
  check("a landblock crossing measures the true step",
    Math.abs(r.pathM - 4) < 1e-6, `pathM=${r.pathM}`);
  // Sanity: naive local-only differencing would have called this 188 m.
  check("...and the crossing is still a real (small) move, not a wedge",
    r.displacementOk === true);
}

// ---- 6. instrument-dead and not-in-world are distinct from "never moved" --
{
  check("no pose samples is its own verdict",
    movementGate([]).verdict === "INVALID — no pose samples");
  check("samples that cannot be lifted count as no samples",
    movementGate([{ x: 1, y: 2 }, { x: 3, y: 4 }]).verdict ===
      "INVALID — no pose samples");
  check("never entering the world short-circuits",
    movementGate([], { inWorld: false }).verdict === "NOT-IN-WORLD");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
