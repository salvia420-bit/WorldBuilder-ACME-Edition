// motion_queue.js — J5 (PARITY-D, 2026-08-13). Retail's `pending_animations`.
//
// WHY THIS FILE EXISTS
// Retail's animation authority is a SINGLE playhead (`CSequence`,
// acclient.h:30747-30759 — one `anim_list`, one `frame_number`, one
// `curr_anim`). Motions do NOT get their own players; they are APPENDED to
// that one sequence, and the manager keeps a parallel bookkeeping list so it
// knows which appended frames belong to which motion:
//
//   struct MotionTableManager::AnimNode : DLListData { unsigned motion;
//                                                      unsigned num_anims; }
//                                                    (acclient.h:57614-57618)
//   DLList<MotionTableManager::AnimNode> pending_animations;  (acclient.h:31103)
//
// Three manager methods own it, all re-read directly from
// `/home/wbterminal/ac-headers/acclient.c` on 2026-08-13:
//
//  * `add_to_queue(motion, num_anims, seq)` (:330149-330170) — `operator new(0x10)`
//    a node {prev, next, motion, num_anims}, `DLListBase::InsertAfter(..., tail_)`
//    (append), then ALWAYS `remove_redundant_links(seq)`.
//  * `AnimationDone(success)` (:329873-329938) — `++animation_counter`; then while
//    the HEAD node's `num_anims <= animation_counter`: if `motion & 0x10000000`
//    `MotionState::remove_action_head`; `CPhysicsObj::MotionDone(motion, success)`;
//    `animation_counter -= num_anims`; pop+delete head. A `num_anims == 0` node
//    therefore completes IMMEDIATELY (no-op motions retire without playing).
//  * `remove_redundant_links(seq)` (:330079-330147) — the collapse, below.
//  * `truncate_animation_list(node, seq)` (:329842-329871) — sums `num_anims`
//    from the TAIL back down to (and EXCLUDING) `node`, zeroing each as it goes,
//    then `CSequence::remove_link_animations(seq, total)`. i.e. everything queued
//    AFTER `node` — INCLUDING the newly added tail — is retracted, and `node`
//    keeps playing. That is the "same-motion backward walk" of ledger J2.
//
// remove_redundant_links, transcribed (v2 = tail, skipping `num_anims == 0`
// nodes; `m` = that node's motion; `v5` walks backward):
//
//   if ((m & 0x40000000) && !(m & 0x20000000))          // MODIFIER-class
//        stop at the first earlier node with the SAME motion AND num_anims != 0;
//        ABORT the walk on any node that has anims and matches 0xB0000000.
//   else if (m & 0x80000000)                            // signed < 0, ACTION-class
//        stop at the first earlier node with the SAME motion (num_anims ignored);
//        ABORT on any node that has anims and matches 0x70000000.
//   found -> truncate_animation_list(thatNode)
//
// WHAT THIS MODULE IS AND IS NOT
// This is the retail STRUCTURE, not a second player: `_unifiedSeq` remains the
// one playhead and the queue only says what plays after it. There is
// deliberately NO parallel advance loop — a queue that raced the playhead would
// be worse than the gap it closes (owner directive, brief for PARITY-D).
//
// KNOWN DEVIATION (explicit, not an oversight): retail's truncate can retract
// frames from a sequence that is ALREADY PLAYING (`remove_link_animations`
// splices nodes out of the live `anim_list`). We only retract PENDING entries;
// when the collapse target is the in-flight head, we drop the newcomer and let
// the head run, which is the same observable outcome for the case J2/J3 care
// about (a re-issued motion is invisible) but is NOT the same for a mid-link
// retraction. Recorded as a deviation in PARITY-LEDGER (J5).

export const MOTION_ACTION_BIT = 0x10000000;

/** A pending_animations entry. `payload` carries our playable record. */
function node(motion, numAnims, payload) {
  return { motion: motion >>> 0, numAnims: numAnims >>> 0, payload: payload ?? null };
}

/** Fresh queue state. `list[0]`, once started, is the in-flight motion. */
export function createMotionQueue() {
  return { list: [], counter: 0, started: false };
}

/**
 * `MotionTableManager::add_to_queue` — append, then collapse.
 * Returns the array of payloads that were RETRACTED (callers free them);
 * the newcomer's own payload appears there when it collapsed onto an
 * earlier occurrence of the same motion.
 */
export function addToQueue(q, motion, numAnims, payload) {
  q.list.push(node(motion, numAnims, payload));
  return removeRedundantLinks(q);
}

/** `MotionTableManager::remove_redundant_links`. Returns retracted payloads. */
export function removeRedundantLinks(q) {
  // v2 = tail_, skipping trailing nodes with num_anims == 0 (`while
  // (!v2[1].dllist_prev) v2 = v2->dllist_prev`); empty list -> nothing.
  let ti = q.list.length - 1;
  while (ti >= 0 && q.list[ti].numAnims === 0) ti -= 1;
  if (ti < 0) return [];
  const m = q.list[ti].motion >>> 0;

  let stopAt = -1;
  if ((m & 0x40000000) !== 0 && (m & 0x20000000) === 0) {
    for (let i = ti - 1; i >= 0; i -= 1) {
      const n = q.list[i];
      if (n.motion === m && n.numAnims !== 0) { stopAt = i; break; }
      if (n.numAnims !== 0 && (n.motion & 0xb0000000) !== 0) return [];
    }
  } else if ((m & 0x80000000) !== 0) {
    for (let i = ti - 1; i >= 0; i -= 1) {
      const n = q.list[i];
      if (n.motion === m) { stopAt = i; break; }
      if (n.numAnims !== 0 && (n.motion & 0x70000000) !== 0) return [];
    }
  } else {
    return [];
  }
  if (stopAt < 0) return [];
  return truncateAnimationList(q, stopAt);
}

/**
 * `MotionTableManager::truncate_animation_list` — retract everything after
 * `keepIndex`. Retail zeroes each node's `num_anims` and asks the SEQUENCE to
 * drop that many frames; we drop the pending entries outright (see the
 * deviation note at the top of this file) and never touch the in-flight head.
 */
export function truncateAnimationList(q, keepIndex) {
  const retracted = [];
  // The in-flight head (index 0 once started) is not ours to splice.
  const firstRemovable = q.started ? 1 : 0;
  for (let i = q.list.length - 1; i > keepIndex && i >= firstRemovable; i -= 1) {
    const n = q.list[i];
    // Retail zeroes `num_anims` and LEAVES the node in the list — it still
    // retires through AnimationDone and still fires its MotionDone. Only the
    // FRAMES are retracted, so a node that contributed none is untouched.
    if (n.numAnims !== 0) {
      if (n.payload != null) retracted.push(n.payload);
      n.numAnims = 0;
      n.payload = null;
    }
  }
  return retracted;
}

/**
 * `MotionTableManager::AnimationDone(success)` — one playhead finished one
 * animation. Retires every head node whose `num_anims` the counter covers
 * (so `num_anims == 0` no-ops retire without ever playing) and reports them
 * so the caller can run its MotionDone equivalent.
 */
export function animationDone(q) {
  const completed = [];
  if (q.list.length === 0) return completed;
  q.counter += 1;
  while (q.list.length > 0 && q.list[0].numAnims <= q.counter) {
    const head = q.list.shift();
    q.counter -= head.numAnims;
    completed.push(head);
  }
  if (q.list.length === 0) q.counter = 0; // retail: `if (counter && !head) counter = 0`
  q.started = false;
  return completed;
}

/** The motion that should be on the playhead now, or null. */
export function headMotion(q) {
  return q.list.length > 0 ? q.list[0] : null;
}

/** Convenience: retail calls `AnimationDone` once per finished ANIMATION, and
 *  our one playhead retires a whole multi-segment link in one tick. */
export function animationsDone(q, n) {
  const completed = [];
  for (let i = 0; i < Math.max(1, n | 0); i += 1) completed.push(...animationDone(q));
  return completed;
}
