// scene3d/motion/handback.js — a finished one-shot hands the rig back to the
// locomotion cycle the way retail's sequence list does (csequence-4,
// 2026-10-08, `?cycleRestartAfterAction`).
//
// Retail never resumes a cycle where it was interrupted. An action rebuilds
// the list as [action link, base cycle]: `CMotionTable::GetObjectSequence`
// runs `remove_cyclic_anims` then `add_motion(link)` and `add_motion(cycle)`
// (acclient.c:337842-337856; the hop variant :337895-337901). When the link
// node runs out, `advance_to_next_animation` enters the NEW cycle node at
// `get_starting_frame` (:340567) and `update_internal` keeps going in the same
// update with the leftover `quantum = time_left` (:340776). The link's last
// frame is authored to meet the cycle's first, so the hand-off is seamless.
//
// Our cycle (`inst._unifiedLoco`) is frozen, not removed, while a one-shot owns
// the playhead, so on completion it is restarted here and given the leftover.
// Pure: no THREE, no wasm (the `seq` is the wasm MotionSequence or the node
// harness fake), so tests/unified_handback.test.mjs drives it directly.

/**
 * The part of this tick's advance a one-shot did not use, in wall seconds.
 * @param {number} t0        clip time before the advance (phase * total).
 * @param {number} scaledDt  the advance applied (dt * speed).
 * @param {number} total     clip duration.
 * @param {number} speed     the one-shot's framerate multiplier.
 */
export function oneShotSpill(t0, scaledDt, total, speed) {
  return speed > 0 && total > 0 ? Math.max(0, t0 + scaledDt - total) / speed : 0;
}

/**
 * Restart the cycle record `lo` at its first frame and spend `spillWall`
 * seconds of it at `gaitScale`. A held record (door/chest state) is left
 * alone. A backward gait (scale <= 0) only restarts: its negative step is the
 * tick's own reverse branch. Returns whether the cycle was restarted.
 */
export function handBackToCycle(lo, spillWall, gaitScale) {
  if (!lo || lo.hold || !lo.seq) return false;
  lo.seq.reset();
  lo.lastHookTime = -1;
  const step = spillWall * gaitScale;
  if (step > 0) lo.seq.advance(step);
  return true;
}
