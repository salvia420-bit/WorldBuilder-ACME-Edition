// scene3d/death_hold.js — how long a dead creature's rig outlives its server
// delete (bug 6, 2026-10-07). Pure; used by loop.js `_armRemove` /
// `_armMotion` and entities.js (round-2 helpers at the bottom).
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

// ── Round 2 (2026-10-08): state around the death hold ─────────────────────

/** Full Ready (0x41000003): the motion that stands a dead player back up. */
export const READY_FULL = 0x41000003;

/**
 * death-2 — the command to force onto the LOCAL player's death-held rig for a
 * server UpdateMotion, or 0. Retail `CPhysics::SetObjectMovement`
 * (acclient.c:311149-311193) unpacks every NON-autonomous movement for the
 * player, so the server's resurrect Ready replaces Dead and the player stands
 * up at the lifestone. ACE sends it as `Motion(NonCombat)` (Player_Death.cs
 * ThreadSafeTeleportOnDeath → SetCombatMode), whose Ready forward command is
 * omitted on the wire, so it arrives as motionCmd 0 — which the predictor skip
 * (loop.js `isLocalGaitLocomotionCmd`) and the death-hold guard (entities.js
 * CQ-06: only Ready/Walk/Run revive) both drop. Only Ready / absent is
 * translated: an autonomous echo (B9) and every other locomotion command keep
 * their old path.
 * @param {{isLocal:boolean, isAuto:boolean, motionCmd:number, deathHeld:boolean}} s
 */
export function serverReviveLocalCmd(s) {
  if (!s.isLocal || s.isAuto || !s.deathHeld) return 0;
  const low = (s.motionCmd >>> 0) & 0xffff;
  return low === 0 || low === 0x0003 ? READY_FULL : 0;
}

/**
 * death-3 — `_tickSelectionRules`: may a despawn-cleared selection be
 * re-selected because its guid is still mapped? Yes for a dynamic-LOD /
 * re-create respawn; no for a rig that outlives its server delete only
 * visually (a death-held `_removePending` rig, or one a corpse claimed) —
 * retail `ACCWeenieObject::Remove` (acclient.c:438580-438606) drops the
 * selection at the delete and lets auto-target run.
 */
export function shouldReselectAfterRemoval(inst) {
  return !!inst && !inst._removePending && !inst._corpseHandoffGuid;
}

/**
 * death-4 — may this dying rig be claimed by a fresh corpse
 * (entities.js `_tryCorpseDeathHandoff`)? Never the LOCAL player: retail
 * never deletes the player object on death (it is teleported), and the claim
 * ends in `remove()` of a rig the wasm never re-spawns.
 * @param {{hasDeathAt:boolean, claimed:boolean, isLocal:boolean, inWindow:boolean, d2:number, maxD2:number}} s
 */
export function isCorpseHandoffCandidate(s) {
  if (!s.hasDeathAt || s.claimed || s.isLocal) return false;
  return !!s.inWindow && s.d2 < s.maxD2;
}

// ── Round 3 (2026-10-11): the corpse is lootable from the moment it exists ──
// Owner report: "the ragdoll takes too long … the user is waiting to loot the
// corpse" (shreths). Between the claim and the reveal the lootable corpse is
// HIDDEN (`_hiddenForHandoff`, so the ragdoll's final pose can land on it) and
// the body on screen is the dying creature's rig, whose guid the server has
// already deleted (or is about to). Retail has no such split — the corpse is
// the object you see — so for picking and selection the claimed rig stands in
// for its corpse (`?handoffLoot`, EntityManager `pickGuidFor` /
// `_selectionStateVisible`).

/**
 * handoff-1 — the guid a pick on a rig reports. A rig a corpse has claimed is
 * the on-screen body of that corpse: the claim guid while the corpse is mapped
 * (its own hidden rig has nothing drawn to hit), else nothing. A rig whose
 * server delete already landed and that no corpse claimed (`_removePending`)
 * is a deleted object, not pickable either: retail takes an object out of the
 * world at its delete — `ACCWeenieObject::Remove` (acclient.c:438580) moves it
 * to position state 3 (`beingRemoved`, :438596) and drops it as the selection
 * (death-3) — so nothing of it is left to click. Anything else is itself.
 * @param {{guid:number, claimGuid:number, claimMapped:boolean, removePending:boolean}} s
 * @returns {number} the guid to report; 0 = not pickable
 */
export function handoffPickGuid(s) {
  const claim = (s.claimGuid >>> 0) || 0;
  if (claim) return s.claimMapped ? claim : 0;
  if (s.removePending) return 0;
  return (s.guid >>> 0) || 0;
}

/**
 * handoff-2 — is a corpse that is hidden for the handoff DRAWN for selection
 * (the SelectNext "drawn" gate, target_cycle.js `cycleCandidateOk`, and the
 * range-exit `inView`)? Yes while the rig that claimed it (`proxyClaimGuid` is
 * that rig's `_corpseHandoffGuid`) is state-visible: the corpse is on screen,
 * in the claimed rig's parts.
 * @param {{guid:number, hiddenForHandoff:boolean, proxyClaimGuid:number, proxyVisible:boolean}} s
 */
export function handoffDrawnViaProxy(s) {
  const g = (s.guid >>> 0) || 0;
  if (!g || !s.hiddenForHandoff) return false;
  return ((s.proxyClaimGuid >>> 0) || 0) === g && !!s.proxyVisible;
}

/** finishReveal poll period, and the longest it waits past the authored clock
 *  (was 8 polls × 500 ms: up to half a second between "at rest" and reveal;
 *  `?ragdollRest=off` keeps that). */
export const DEATH_REVEAL_POLL_MS = 100;
export const DEATH_REVEAL_MAX_WAIT_MS = 4000;

/**
 * handoff-3 — at each finishReveal poll: "wait" while the claimed rig's ragdoll
 * may still move (live, or still arming), bounded by DEATH_REVEAL_MAX_WAIT_MS
 * — a rig out of tick range never steps its sim — else "reveal".
 * @param {{ragdollLive:boolean, waitedMs:number}} s
 */
export function revealVerdict(s) {
  return s.ragdollLive && s.waitedMs < DEATH_REVEAL_MAX_WAIT_MS ? "wait" : "reveal";
}
