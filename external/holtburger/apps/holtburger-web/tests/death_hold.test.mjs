// tests/death_hold.test.mjs — bug 6 (2026-10-07): a ragdolled creature's rig
// outlives its server delete until the corpse claims it (bounded), so the
// lootable corpse keeps the ragdoll's final pose instead of the authored one.
//
// ACE timeline (Creature_Death.cs:121-134): Dead → link length (drudge
// 1.333 s, hollow minion 3.0 s) → CreateCorpse + Destroy. The client's hold
// clock is the same link length, so at the delete `remaining` ≈ 0.
//
// Round 2 (2026-10-08, A2-death): the pure rules around the hold — the local
// server revive (death-2), the re-select guard (death-3) and the corpse-claim
// local exclusion (death-4). Their EntityManager wiring is in
// tests/death_selection.test.mjs.
//
// Run from apps/holtburger-web/:  node tests/death_hold.test.mjs

import assert from "node:assert/strict";
import {
  shouldDeferDeathRemove,
  deathHoldVerdict,
  DEATH_CLAIM_WAIT_LIVE_MS,
  DEATH_CLAIM_WAIT_SETTLED_MS,
  serverReviveLocalCmd,
  shouldReselectAfterRemoval,
  isCorpseHandoffCandidate,
  READY_FULL,
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

// ── Round 2 (2026-10-08, A2-death) ─────────────────────────────────────────
// death-2: ACE's resurrect `Motion(NonCombat)` omits the Ready forward command,
// so it reaches loop.js `_armMotion` as motionCmd 0 (non-autonomous).
check("death-2: the server's Ready (wire cmd 0) for the death-held local rig → explicit Ready", () => {
  const s = { isLocal: true, isAuto: false, motionCmd: 0, deathHeld: true };
  assert.equal(READY_FULL, 0x41000003);
  assert.equal(serverReviveLocalCmd(s), READY_FULL);
  assert.equal(serverReviveLocalCmd({ ...s, motionCmd: 0x0003 }), READY_FULL);
  assert.equal(serverReviveLocalCmd({ ...s, motionCmd: 0x41000003 }), READY_FULL);
});
check("death-2: no revive when not death-held, autonomous (B9 echo), remote, or not Ready", () => {
  const s = { isLocal: true, isAuto: false, motionCmd: 0, deathHeld: true };
  assert.equal(serverReviveLocalCmd({ ...s, deathHeld: false }), 0, "alive: the predictor skip stays");
  assert.equal(serverReviveLocalCmd({ ...s, isAuto: true }), 0, "autonomous echo stays skipped");
  assert.equal(serverReviveLocalCmd({ ...s, isLocal: false }), 0, "remote rigs use setMotion as before");
  assert.equal(serverReviveLocalCmd({ ...s, motionCmd: 0x45000005 }), 0, "WalkForward is not translated");
  assert.equal(serverReviveLocalCmd({ ...s, motionCmd: 0x41000004 }), 0, "a stray Stop is not a revive");
  assert.equal(serverReviveLocalCmd({ ...s, motionCmd: 0x40000011 }), 0, "Dead itself");
});
// death-3: retail drops the selection at the server delete.
check("death-3: a delete-deferred or corpse-claimed rig is not re-selected; a LOD respawn is", () => {
  assert.equal(shouldReselectAfterRemoval({ _removePending: true }), false);
  assert.equal(shouldReselectAfterRemoval({ _corpseHandoffGuid: 0x123 }), false);
  assert.equal(shouldReselectAfterRemoval({}), true);
  assert.equal(shouldReselectAfterRemoval(undefined), false);
});
// death-4: the corpse claim never takes the local player.
check("death-4: the local player is never a corpse-handoff candidate", () => {
  const s = { hasDeathAt: true, claimed: false, isLocal: false, inWindow: true, d2: 0, maxD2: 16 };
  assert.equal(isCorpseHandoffCandidate(s), true, "a dying creature under the corpse");
  assert.equal(isCorpseHandoffCandidate({ ...s, isLocal: true }), false, "the local player at d=0");
  assert.equal(isCorpseHandoffCandidate({ ...s, claimed: true }), false);
  assert.equal(isCorpseHandoffCandidate({ ...s, d2: 16 }), false, "d2 >= maxD2");
  assert.equal(isCorpseHandoffCandidate({ ...s, inWindow: false }), false);
  assert.equal(isCorpseHandoffCandidate({ ...s, hasDeathAt: false }), false);
});

console.log(`\ndeath_hold: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
