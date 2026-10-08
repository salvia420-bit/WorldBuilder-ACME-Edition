// Headless table tests for the pure hook-timing helpers the playhead drain
// ships (`scene3d/hook_windows.js`, imported by entities.js and animation.js).
// No THREE / no wasm / no browser. The real-EntityManager drain is pinned in
// tests/unified_hook_drain.test.mjs.
//
// Retail oracle: CSequence::update_internal (acclient.c:340659-340776) — a
// frame's hooks fire when the playhead LEAVES it, never a segment's last
// frame going forward (or its first going backward), frame 0 every loop.
// OpenAC pins the same in CSequenceUpdateTests (Forward_SingleTick, the
// exact-boundary landing, LinkToCycle, Reverse_DescendingHooks).
//
// Run from `apps/holtburger-web/`:
//   node test_hook_windows.mjs

import {
  unifiedHookTime,
  isSegmentFirstFrame,
  isSegmentLastFrame,
  retimeHooksToFrameExit,
  drainHookWindows,
  framesCrossedBackward,
  hookFiresInDirection,
} from "./scene3d/hook_windows.js";

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed += 1;
  else failed += 1;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Frame times exactly as the bake emits them (f32 per-frame START times).
function frameTimes(...segs) {
  const out = [];
  let t = 0;
  for (const [n, fps] of segs) for (let i = 0; i < n; i += 1) { out.push(t); t += 1 / fps; }
  return Float32Array.from(out);
}
// One Both hook per frame, stamped like the bake (`time_in_clip_s = ft[f]`).
const hookPerFrame = (ft) => Array.from(ft, (t, f) => ({ time: t, id: f, direction: 0 }));
// The drain windows for one call, plus the hook ids they cover.
function drain(timeline, last, curT, dur, wrapped = false, wrapCursor = -1) {
  const windows = [];
  const cursor = drainHookWindows(last, curT, dur, wrapped, wrapCursor, (lo, hi) => windows.push([lo, hi]));
  const fired = [];
  for (const [lo, hi] of windows) for (const h of timeline) if (h.time > lo && h.time <= hi) fired.push(h.id);
  return { windows, cursor, fired };
}

console.log("hook_windows.js — playhead hook timing helpers");

// === unifiedHookTime: the drain clock ======================================
{
  const ft = Float32Array.from([0, 0.1, 0.25]);
  check("clock = the frame's start time from frameTimes", unifiedHookTime(2, ft, 10) === ft[2]);
  check("clock falls back to gf / framerate past the table", unifiedHookTime(3, ft, 10) === 0.3);
  check("clock without frameTimes = gf / framerate", unifiedHookTime(4, undefined, 30) === 4 / 30);
  check("clock with no framerate = 0", unifiedHookTime(4, null, 0) === 0);
}

// === segment helpers (one node when the descriptor has no table) ===========
{
  const ss = [0, 2], sc = [2, 4];
  check("segment first/last frames: [2][4]",
    isSegmentFirstFrame(0, ss, sc) && isSegmentFirstFrame(2, ss, sc) && !isSegmentFirstFrame(3, ss, sc) &&
    isSegmentLastFrame(1, ss, sc, 6) && isSegmentLastFrame(5, ss, sc, 6) && !isSegmentLastFrame(2, ss, sc, 6));
  check("no segment table = one segment over the bake",
    isSegmentFirstFrame(0, [], []) && !isSegmentFirstFrame(1, undefined, undefined) &&
    isSegmentLastFrame(4, [], [], 5) && !isSegmentLastFrame(3, [], [], 5));
}

// === retime: 5 frames @30, a hook on every frame ===========================
{
  const ft = frameTimes([5, 30]);
  const { timeline, byFrame } = retimeHooksToFrameExit(hookPerFrame(ft), ft, [0], [5], 5, 30);
  check("f0..f3 stay on the forward timeline, f4 (high frame) is dropped",
    same(timeline.map((h) => h.id), [0, 1, 2, 3]), JSON.stringify(timeline.map((h) => h.id)));
  check("each hook is keyed to the NEXT frame's start (its exit)",
    timeline.every((h) => h.time === ft[h.frame + 1]));
  check("frameTime keeps the original stamp (event payloads)",
    timeline.every((h) => h.frameTime === ft[h.id]));
  check("byFrame indexes every hook, the dropped high frame included",
    [0, 1, 2, 3, 4].every((f) => byFrame.get(f)?.[0]?.id === f));

  // Retail Forward_SingleTick: 1/30 s from frame 0 fires only f0.
  check("a 1/30 s tick (lands on frame 1) fires only f0",
    same(drain(timeline, -1, unifiedHookTime(1, ft, 30), 5 / 30).fired, [0]));
  // Retail exact-boundary landing: arriving on frame 4.0 fires f3, and f4
  // never fires however long the clamped one-shot is held.
  const toF4 = drain(timeline, ft[3], unifiedHookTime(4, ft, 30), 5 / 30);
  check("landing on frame 4 fires f3", same(toF4.fired, [3]), JSON.stringify(toF4.fired));
  check("a one-shot clamped on its last frame never fires it",
    same(drain(timeline, toF4.cursor, unifiedHookTime(4, ft, 30), 5 / 30).fired, []));
  check("entering a frame fires nothing for it (frame 2 entered from 1)",
    same(drain(timeline, ft[1], ft[2], 5 / 30).fired, [1]));
}

// === retime: link [2] + cycle [4] (OpenAC LinkToCycle) =====================
{
  const ft = frameTimes([2, 30], [4, 15]);
  const { timeline, byFrame } = retimeHooksToFrameExit(hookPerFrame(ft), ft, [0, 2], [2, 4], 6, 0);
  check("link1 and cyc3 (each segment's last frame) are dropped",
    same(timeline.map((h) => h.id), [0, 2, 3, 4]), JSON.stringify(timeline.map((h) => h.id)));
  check("both stay in byFrame for reverse play", byFrame.has(1) && byFrame.has(5));
  check("non-uniform f32 stamps map exactly (cycle frame 2 → exits at ft[5])",
    timeline.find((h) => h.id === 4).time === ft[5]);
}

// === retime: a 1-frame hold segment never fires; no frameTimes fallback =====
{
  const ft = frameTimes([1, 30], [3, 30]);
  const { timeline } = retimeHooksToFrameExit(hookPerFrame(ft), ft, [0, 1], [1, 3], 4, 30);
  check("a 1-frame segment is its own last frame (dropped)",
    same(timeline.map((h) => h.id), [1, 2]));
  const hooks = [0, 1, 2].map((f) => ({ time: f / 10, id: f }));
  const r = retimeHooksToFrameExit(hooks, undefined, undefined, undefined, 3, 10);
  check("no frameTimes: uniform 1/framerate, exit = (f+1)/fr",
    same(r.timeline.map((h) => [h.id, h.time]), [[0, 0.1], [1, 0.2]]), JSON.stringify(r.timeline.map((h) => [h.id, h.time])));
  check("empty / missing hooks → empty timeline",
    retimeHooksToFrameExit([], ft, [], [], 4, 30).timeline.length === 0 &&
    retimeHooksToFrameExit(null, ft, [], [], 4, 30).byFrame.size === 0);
}

// === drainHookWindows ======================================================
{
  let r = drain([], 0.1, 0.3, 0.4);
  check("monotonic advance: one (last, cur] window", same(r.windows, [[0.1, 0.3]]) && r.cursor === 0.3);
  r = drain([], 0.3, 0.0, 0.4);
  check("wrap onto frame 0: tail (last, dur] then (-1, cur] — t=0 is covered",
    same(r.windows, [[0.3, 0.4], [-1, 0]]) && r.cursor === 0, JSON.stringify(r));
  r = drain([], 0.3, 0.1, 0.4);
  check("wrap past frame 0: tail then (-1, cur]", same(r.windows, [[0.3, 0.4], [-1, 0.1]]));
  r = drain([{ time: 0, id: "f0" }], 0.3, 0.1, 0.4, false, 0);
  check("legacy cursor 0 (`?hookFrameExit=off`) skips a t=0 hook after a wrap",
    same(r.windows, [[0.3, 0.4], [0, 0.1]]) && r.fired.length === 0);
  r = drain([], 0.1, 0.2, 0.4, true);
  check("a step of a full loop wraps even though cur >= last",
    same(r.windows, [[0.1, 0.4], [-1, 0.2]]));
  r = drain([], 0.4, 0.1, 0.4);
  check("tail window skipped when last already reached the end", same(r.windows, [[-1, 0.1]]));
  r = drain([], 0.25, 0.25, 0.4);
  check("no frame crossed → no window, cursor unchanged", r.windows.length === 0 && r.cursor === 0.25);
  r = drain([{ time: 0, id: "f0" }], -1, 0, 0.4);
  check("a fresh record (cursor -1) reaches t=0", same(r.fired, ["f0"]));
}

// === a cycle with a frame-0 hook fires it every loop ========================
{
  // 4 frames @10fps; drive the floor-frame clock over three loops at 60 Hz.
  const ft = frameTimes([4, 10]);
  const { timeline } = retimeHooksToFrameExit([{ time: 0, id: "f0" }], ft, [0], [4], 4, 10);
  let cursor = -1;
  let t = 0;
  const fired = [];
  for (let i = 0; i < 72; i += 1) { // 1.2 s = 3 loops
    t = (t + 1 / 60) % 0.4;
    const gf = Math.min(3, Math.floor(t * 10 + 1e-9));
    cursor = drainHookWindows(cursor, unifiedHookTime(gf, ft, 10), 0.4, false, -1, (lo, hi) => {
      for (const h of timeline) if (h.time > lo && h.time <= hi) fired.push(h.id);
    });
  }
  check("frame-0 hook fires once per loop over 3 loops", fired.length === 3, `fired=${fired.length}`);
}

// === framesCrossedBackward ================================================
{
  check("3 → 1 leaves frames 3 and 2", same(framesCrossedBackward(3, 1, false, [0], [5], 5), [3, 2]));
  check("1 → wrap → 3 leaves 1, skips frame 0 (low), then 4",
    same(framesCrossedBackward(1, 3, true, [0], [5], 5), [1, 4]));
  check("[2][4]: 5 → 1 skips the cycle's first frame (2)",
    same(framesCrossedBackward(5, 1, false, [0, 2], [2, 4], 6), [5, 4, 3]));
  check("no movement → nothing", framesCrossedBackward(2, 2, false, [0], [5], 5).length === 0);
  check("a fresh record backing off frame 0 wraps to the top",
    same(framesCrossedBackward(0, 3, true, [], [], 5), [4]));
}

// === hookFiresInDirection (retail execute_hooks gate) ======================
{
  const d = (direction) => ({ direction });
  check("forward: Both + Forward fire, Backward does not",
    hookFiresInDirection(d(0), 1) && hookFiresInDirection(d(1), 1) && !hookFiresInDirection(d(-1), 1));
  check("backward: Both + Backward fire, Forward does not",
    hookFiresInDirection(d(0), -1) && hookFiresInDirection(d(-1), -1) && !hookFiresInDirection(d(1), -1));
  check("untagged / UNKNOWN -2 hooks fire either way",
    [1, -1].every((dir) => hookFiresInDirection({}, dir) && hookFiresInDirection(d(-2), dir)));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
