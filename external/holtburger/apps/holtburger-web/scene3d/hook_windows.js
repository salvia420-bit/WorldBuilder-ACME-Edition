// Pure hook-timing helpers for the playhead's animation-hook drain
// (`entities.js`: `_drainUnifiedHooks`, the reverse-gait branch of the tick,
// `_installUnifiedLoco`, `_fireHook`'s direction gate) and for the hook
// timeline the animation cache snapshots (`animation.js`). No THREE / no wasm
// / no browser, so `test_hook_windows.mjs` table-tests the shipped math.
//
// Retail (`CSequence::update_internal`, acclient.c:340659-340776; ACE
// Sequence.cs update_internal; OpenAC CSequence.cs UpdateInternal):
//   - a frame's hooks fire when the playhead LEAVES it: the forward loop runs
//     `execute_hooks(get_part_frame(v), 1)` for each v with
//     floor(frame_number) > v (:340713-340726);
//   - a node's high_frame never fires going forward (frame_number is clamped
//     to it BEFORE that loop, :340710), and its low_frame never fires going
//     backward (the mirrored loop, :340733-340759, `execute_hooks(.., -1)`);
//   - a wrap restarts the node at get_starting_frame and spends the leftover
//     quantum (:340776), so frame 0 fires again on every loop;
//   - only crossing fires. execute_hooks has no other call site, so nothing
//     that repositions the playhead (a phase carry, a seek) fires a hook.
// `execute_hooks` gates on direction: Both (0) always, otherwise only a hook
// whose direction matches the playback direction (:339694-339696).

/**
 * The drain's playhead clock: seconds-into-clip of global frame `gf`'s START.
 * The bake's per-frame `frameTimes` when present, else uniform `gf/framerate`.
 */
export function unifiedHookTime(gf, frameTimes, framerate) {
  return (frameTimes && gf < frameTimes.length) ? frameTimes[gf] : (framerate > 0 ? gf / framerate : 0);
}

// Index of the AnimData segment (one retail AnimSequenceNode) holding global
// frame `f`, or -1 when the descriptor carries no segment table — then the
// whole bake is one node (motion_sequence.rs `build_impl` single-node path).
function segmentIndex(f, segStarts, segCounts) {
  if (!segStarts || !segCounts || !segStarts.length || segStarts.length !== segCounts.length) return -1;
  for (let i = segStarts.length - 1; i >= 0; i -= 1) {
    if ((segCounts[i] >>> 0) > 0 && f >= (segStarts[i] >>> 0)) return i;
  }
  return -1;
}

/** True when `f` is its segment's first frame (retail low_frame). */
export function isSegmentFirstFrame(f, segStarts, segCounts) {
  const i = segmentIndex(f, segStarts, segCounts);
  return f === (i < 0 ? 0 : segStarts[i] >>> 0);
}

/** True when `f` is its segment's last frame (retail high_frame). */
export function isSegmentLastFrame(f, segStarts, segCounts, numFrames) {
  const i = segmentIndex(f, segStarts, segCounts);
  return f === (i < 0 ? numFrames - 1 : (segStarts[i] >>> 0) + (segCounts[i] >>> 0) - 1);
}

/**
 * Re-key a bake's hook list from frame-ENTRY time to frame-EXIT time.
 *
 * The wasm bake stamps each hook with its frame's START time (lib.rs hook
 * flatten, `time_in_clip_s: frame_time`), and the drain fires
 * `(lastHookTime, unifiedHookTime(gf)]`, so frame f used to fire as soon as
 * the playhead entered it. Moving each hook to `frameTimes[f + 1]` makes the
 * same drain fire it once `gf >= f + 1`, i.e. when floor(frame_number) > f.
 * A hook on its segment's last frame never fires going forward, so it is left
 * out of the forward timeline (the 1-frame hold segments included).
 *
 * @param {Array<{time:number}>} hooks  the bake's hooks, sorted by `time`.
 * @returns {{ timeline: object[], byFrame: Map<number, object[]> }}
 *   `timeline`: the forward drain list, still sorted by `time` (the re-key is
 *   monotonic). Entries are copies carrying `frame` (global frame) and
 *   `frameTime` (the original time-in-clip, for event payloads).
 *   `byFrame`: every hook, segment-last frames included, keyed by global
 *   frame — reverse playback walks frames, not times.
 */
export function retimeHooksToFrameExit(hooks, frameTimes, segStarts, segCounts, numFrames, framerate) {
  const timeline = [];
  const byFrame = new Map();
  const n = numFrames >>> 0;
  if (!hooks || !hooks.length || n === 0) return { timeline, byFrame };
  const ft = frameTimes && frameTimes.length === n ? frameTimes : null;
  const fr = framerate > 0 ? framerate : 30;
  const start = (f) => (ft ? ft[f] : f / fr);
  let f = 0;
  for (const h of hooks) {
    const t = +h.time || 0;
    if (t < start(f)) f = 0; // out-of-order input: rescan from the top
    // The frame the hook was stamped on: the last one starting at or before
    // its time (an exact match for bake stamps — both are the same f32).
    while (f + 1 < n && start(f + 1) <= t + 1e-6) f += 1;
    const last = isSegmentLastFrame(f, segStarts, segCounts, n);
    const rec = { ...h, frame: f, frameTime: t, time: last ? t : start(f + 1) };
    let list = byFrame.get(f);
    if (!list) byFrame.set(f, (list = []));
    list.push(rec);
    if (!last) timeline.push(rec);
  }
  return { timeline, byFrame };
}

/**
 * Fire the hook windows one forward drain owes; returns the new cursor.
 * `fire(lowExclusive, highInclusive)` is called once per window, in order.
 *
 * `lastHookTime` is the clock the previous drain reached and `curT` the
 * current one. A clock that went BACKWARDS, or a step the caller knows ran a
 * full loop (`wrapped`), is a wrap: the prior loop's tail `(last, duration]`
 * fires, then the new loop's head `(wrapCursor, curT]`. A `wrapCursor` of -1
 * covers every hook (all times are >= 0); 0 is the legacy value
 * (`?hookFrameExit=off`), which skipped a hook stamped at t=0 on every loop
 * after the first.
 */
export function drainHookWindows(lastHookTime, curT, duration, wrapped, wrapCursor, fire) {
  let cursor = lastHookTime;
  if (curT < cursor || wrapped) {
    if (duration > cursor) fire(cursor, duration);
    cursor = wrapCursor;
  }
  if (curT > cursor) {
    fire(cursor, curT);
    cursor = curT;
  }
  return cursor;
}

/**
 * The frames a backward step LEFT, in firing order: each frame from `prevGf`
 * down to `gf + 1`, skipping every segment's first frame (retail's low_frame
 * never fires backward). `wrapped`: the step ran below frame 0 and re-entered
 * the cycle from its end, so the walk continues from the last frame.
 */
export function framesCrossedBackward(prevGf, gf, wrapped, segStarts, segCounts, numFrames) {
  const out = [];
  const n = numFrames >>> 0;
  if (n === 0) return out;
  const walk = (from, downTo) => {
    for (let f = from; f > downTo; f -= 1) {
      if (!isSegmentFirstFrame(f, segStarts, segCounts)) out.push(f);
    }
  };
  if (wrapped) {
    walk(Math.min(prevGf, n - 1), -1);
    walk(n - 1, gf);
  } else {
    walk(prevGf, gf);
  }
  return out;
}

/**
 * Retail `execute_hooks`' direction gate for playback direction `dir`
 * (+1 forward, -1 backward). Written as "not the opposite direction" so a
 * hook with no direction (PhysicsScript-sourced: `undefined`) and the UNKNOWN
 * -2 sentinel keep firing either way, as they always have.
 */
export function hookFiresInDirection(hook, dir) {
  return (hook.direction | 0) !== (dir < 0 ? 1 : -1);
}
