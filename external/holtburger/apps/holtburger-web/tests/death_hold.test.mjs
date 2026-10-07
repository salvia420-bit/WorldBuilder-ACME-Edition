// tests/death_hold.test.mjs — bug 6 (2026-10-07): a ragdolled creature's rig
// outlives its server delete until the corpse claims it (bounded), so the
// lootable corpse keeps the ragdoll's final pose instead of the authored one.
//
// ACE timeline (Creature_Death.cs:121-134): Dead → link length (drudge
// 1.333 s, hollow minion 3.0 s) → CreateCorpse + Destroy. The client's hold
// clock is the same link length, so at the delete `remaining` ≈ 0.
//
// Run from apps/holtburger-web/:  node tests/death_hold.test.mjs

import assert from "node:assert/strict";
import {
  shouldDeferDeathRemove,
  deathHoldVerdict,
  DEATH_CLAIM_WAIT_LIVE_MS,
  DEATH_CLAIM_WAIT_SETTLED_MS,
} from "../scene3d/death_hold.js";

let passed = 0, failed = 0;
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.message}`); }
};

check("drudge: delete lands as the 1.333 s link ends (remaining ≈ 0) with a live ragdoll → held", () => {
  assert.equal(shouldDeferDeathRemove({ remainingMs: -5, ragdoll: true, ragdollArming: false, removePending: false }), true);
  // the pre-fix gate (remaining > 0 only) removed it here
});
check("delete before the ragdoll finished arming → held", () => {
  assert.equal(shouldDeferDeathRemove({ remainingMs: -40, ragdoll: false, ragdollArming: true, removePending: false }), true);
});
check("no ragdoll and the collapse already ended → removed now (unchanged)", () => {
  assert.equal(shouldDeferDeathRemove({ remainingMs: -1, ragdoll: false, ragdollArming: false, removePending: false }), false);
});
check("collapse still playing, no ragdoll → deferred to its end (unchanged)", () => {
  assert.equal(shouldDeferDeathRemove({ remainingMs: 800, ragdoll: false, ragdollArming: false, removePending: false }), true);
  assert.equal(deathHoldVerdict({ claimed: false, ragdoll: false, ragdollArming: false, ragdollDone: false, waitedMs: 800 }), "remove");
});
check("a second delete for an already-held rig is not re-armed", () => {
  assert.equal(shouldDeferDeathRemove({ remainingMs: 0, ragdoll: true, ragdollArming: false, removePending: true }), false);
});
check("the corpse claims the rig → its reveal owns the removal", () => {
  assert.equal(deathHoldVerdict({ claimed: true, ragdoll: true, ragdollArming: false, ragdollDone: false, waitedMs: 50 }), "yield");
});
check("unclaimed live ragdoll keeps waiting up to the live cap, then is removed", () => {
  const s = { claimed: false, ragdoll: true, ragdollArming: false, ragdollDone: false };
  assert.equal(deathHoldVerdict({ ...s, waitedMs: 300 }), "keep");
  assert.equal(deathHoldVerdict({ ...s, waitedMs: DEATH_CLAIM_WAIT_LIVE_MS - 1 }), "keep");
  assert.equal(deathHoldVerdict({ ...s, waitedMs: DEATH_CLAIM_WAIT_LIVE_MS }), "remove");
});
check("unclaimed settled ragdoll waits the shorter cap (NoCorpse kills don't linger)", () => {
  const s = { claimed: false, ragdoll: true, ragdollArming: false, ragdollDone: true };
  assert.equal(deathHoldVerdict({ ...s, waitedMs: DEATH_CLAIM_WAIT_SETTLED_MS - 1 }), "keep");
  assert.equal(deathHoldVerdict({ ...s, waitedMs: DEATH_CLAIM_WAIT_SETTLED_MS }), "remove");
});
check("simulated drudge kill: corpse commits 600 ms after the delete → claimed, not removed", () => {
  // poll every 150 ms from the delete; the corpse claims at t=600
  let removedAt = null, yieldedAt = null;
  for (let t = 0; t <= 10000; t += 150) {
    const v = deathHoldVerdict({ claimed: t >= 600, ragdoll: true, ragdollArming: false, ragdollDone: t > 2600, waitedMs: t });
    if (v === "yield") { yieldedAt = t; break; }
    if (v === "remove") { removedAt = t; break; }
  }
  assert.equal(removedAt, null, "removed before the claim");
  assert.ok(yieldedAt !== null && yieldedAt >= 600);
});

console.log(`\ndeath_hold: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
