// A5-P1a (2026-06-12, W3+ S5, `?hookDrain=on`) — pure hook-window planner
// for the animation-hook executor (`entities.js _tickAnimationHooks`).
// No THREE / no wasm / no browser (the `script_manager.js` testability
// pattern) so `test_hook_windows.mjs` can table-test it headlessly.
//
// Retail mirror: `CSequence::update_internal` clamps the frame counter at
// `high_frame` on segment exhaustion and fires EVERY crossed frame's hooks
// in the same update before queueing the anim-done hook
// (acclient.c:340697-340727 → :340764-340774) — a LoopOnce clip that
// crosses its end between two rAFs must still fire its trailing hooks in
// `(lastTime, clipDuration]` exactly once. The legacy executor's
// `!action.isRunning()` skip drops them (survey divergence A5 §3 row 3).

/**
 * Plan the hook-fire windows for one action this tick.
 *
 * @param {object} args
 * @param {number} args.lastTime      seconds-into-clip the executor last
 *                                    advanced past (`actionLastHookTime`).
 * @param {number} args.currentTime   the action's current time-in-clip.
 * @param {number} args.clipDuration  clip duration in seconds.
 * @param {boolean} args.isRunning    `action.isRunning()`.
 * @param {boolean} args.isLoopOnce   the action plays LoopOnce (one-shot
 *                                    overlay; never wraps).
 * @returns {{ windows: Array<[number, number]>, drainedTo: number|null,
 *             finished: boolean }}
 *   `windows`: `[lowExclusive, highInclusive]` pairs to fire, in order.
 *   `drainedTo`: when non-null, write it into `actionLastHookTime` INSTEAD
 *   of `currentTime` (the finish-drain marker — `lastTime >= clipDuration`
 *   means "already drained"; `_tryPlayLink`'s reset to 0 on every play()
 *   re-arms replays).
 *   `finished`: true exactly when this call detected a LoopOnce completion
 *   (the finish-drain tick) — the caller queues its `animDone` record
 *   AFTER the trailing-hook windows (retail order, acclient.c:340725 →
 *   :340764-340774).
 */
export function planHookWindows({ lastTime, currentTime, clipDuration, isRunning, isLoopOnce }) {
  const none = { windows: [], drainedTo: null, finished: false };
  if (!(clipDuration > 0)) return none;
  if (!Number.isFinite(lastTime)) lastTime = 0;
  if (!Number.isFinite(currentTime)) currentTime = 0;

  if (isRunning) {
    if (currentTime >= lastTime) {
      // Common case: monotonic advance within one loop pass.
      return { windows: [[lastTime, currentTime]], drainedTo: null, finished: false };
    }
    // Wrap-around: a LoopRepeat cycle wrapped past clip end. Fire
    // (lastTime, clipDuration] then (-Inf, currentTime]. LoopOnce
    // overlays don't wrap, so this fires for locomotion only.
    return {
      windows: [
        [lastTime, clipDuration],
        [-Infinity, currentTime],
      ],
      drainedTo: null,
      finished: false,
    };
  }

  // Not running.
  if (isLoopOnce && lastTime < clipDuration) {
    // The finish-drain: the LoopOnce crossed its end between two rAFs
    // (three.js stops advancing `.time` once finished). Fire the trailing
    // hooks in (lastTime, clipDuration] exactly once and mark the action
    // drained (retail clamp-at-high_frame, acclient.c:340697-340727).
    return {
      windows: [[lastTime, clipDuration]],
      drainedTo: clipDuration,
      finished: true,
    };
  }
  // Already drained (lastTime >= clipDuration), or a stopped non-LoopOnce
  // action (legacy semantics: nothing to fire).
  return none;
}
