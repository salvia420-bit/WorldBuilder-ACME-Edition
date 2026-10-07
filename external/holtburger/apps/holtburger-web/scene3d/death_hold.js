// scene3d/death_hold.js — how long a dead creature's rig outlives its server
// delete (bug 6, 2026-10-07). Pure; used by loop.js `_armRemove`.
//
// ACE kills a creature in one chain (Creature_Death.cs:121-134): Dead motion,
// wait `deathAnimLength` (the Ready→Dead LINK length — 1.333 s for a drudge,
// 3.0 s for a hollow minion), then `CreateCorpse(); Destroy();`. The corpse's
// CreateObject goes out at once (EnterWorld → NotifyPlayers) while the delete
// is queued as an action, so the client sees: Dead → (link length) → corpse
// create → creature delete. The corpse spawn is async and time-sliced; it
// claims the dying rig (entities.js `_tryCorpseDeathHandoff`) only when it
// commits, and copies the RAGDOLL pose onto the corpse at reveal.
//
// The old hold only deferred the delete while the authored link was still
// playing (`remaining > 0`). The delete lands at ~link length, so remaining
// was ≈ 0 and the ragdolling creature was removed before the corpse could
// claim it — the corpse then came up in the authored pose ("snaps back").
// Creatures whose corpse spawns fast (no palette, no treasure: hollow
// minions) won the race; palette-keyed, armed drudges lost it.
//
// Now: a ragdolled (or arming) creature waits for the claim regardless of the
// authored clock, bounded so a NoCorpse kill or a lost corpse cannot leak.

export const DEATH_CLAIM_WAIT_LIVE_MS = 9000;   // ragdoll still falling
export const DEATH_CLAIM_WAIT_SETTLED_MS = 4000; // ragdoll at rest
export const DEATH_CLAIM_POLL_MS = 150;

/**
 * At delete time: defer the removal at all?
 * @param {{remainingMs:number, ragdoll:boolean, ragdollArming:boolean, removePending:boolean}} s
 */
export function shouldDeferDeathRemove(s) {
  if (s.removePending) return false;
  return s.remainingMs > 0 || !!s.ragdoll || !!s.ragdollArming;
}

/**
 * At each deferred fire: "yield" (a corpse claimed the rig — its reveal owns
 * the removal), "keep" (poll again), or "remove".
 * @param {{claimed:boolean, ragdoll:boolean, ragdollArming:boolean, ragdollDone:boolean, waitedMs:number}} s
 */
export function deathHoldVerdict(s) {
  if (s.claimed) return "yield";
  if (s.ragdoll || s.ragdollArming) {
    const live = s.ragdollArming || (s.ragdoll && !s.ragdollDone);
    const cap = live ? DEATH_CLAIM_WAIT_LIVE_MS : DEATH_CLAIM_WAIT_SETTLED_MS;
    if (s.waitedMs < cap) return "keep";
  }
  return "remove";
}
