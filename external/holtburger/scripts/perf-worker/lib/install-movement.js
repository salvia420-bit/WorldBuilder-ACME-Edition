() => {
  if (window.__moveLoop && !window.__moveLoop.done) {
    return { error: "already-running" };
  }
  try {
    const el = document.activeElement;
    if (el && el !== document.body && typeof el.blur === "function") el.blur();
  } catch (e) {}

  const fireKey = (key, type) => {
    document.dispatchEvent(new KeyboardEvent(type, {
      key, bubbles: true, cancelable: true,
    }));
  };

  // 2026-05-21 — pattern-v4: cardinal traversal. Long forward runs
  // (W alone, NO Shift — Shift is the WALK modifier in AC's retail-
  // convention input handling at index.html:7891, NOT sprint) with
  // 90° turns between legs so the character actually enters new
  // landblocks. v3 only covered ~118m in 120s because it held Shift
  // (= 1m/s walk). Each Holtburg LB is 192m wide; with full run-speed
  // legs of ~30s the character covers 200m+ per leg and crosses
  // multiple LB boundaries north → east → south → west, triggering
  // EnvCell bakes, PVS streams, and shader/texture uploads for each
  // new LB. ~125s total.
  const PATTERN_VERSION = "movement-pattern-v4";
  const LEG_MS = 30000;        // ~30s forward at run-speed per leg
  const TURN_MS = 1500;        // ~1.5s yaw to approximate 90°
  const pattern = [
    { keys: ["w"],      dur: LEG_MS,  label: "run-leg-1-north" },
    { keys: ["w", "e"], dur: TURN_MS, label: "turn-right-1" },
    { keys: ["w"],      dur: LEG_MS,  label: "run-leg-2-east" },
    { keys: ["w", "e"], dur: TURN_MS, label: "turn-right-2" },
    { keys: ["w"],      dur: LEG_MS,  label: "run-leg-3-south" },
    { keys: ["w", "e"], dur: TURN_MS, label: "turn-right-3" },
    { keys: ["w"],      dur: LEG_MS,  label: "run-leg-4-west" },
  ];
  const totalMs = pattern.reduce((a, b) => a + b.dur, 0);

  const held = new Set();
  const setHeld = (next) => {
    for (const k of Array.from(held)) {
      if (!next.has(k)) { fireKey(k, "keyup"); held.delete(k); }
    }
    for (const k of next) {
      if (!held.has(k)) { fireKey(k, "keydown"); held.add(k); }
    }
  };
  const releaseAll = () => {
    for (const k of Array.from(held)) {
      fireKey(k, "keyup");
      held.delete(k);
    }
  };

  const loop = {
    started: performance.now(),
    patternVersion: PATTERN_VERSION,
    totalMs,
    events: [],
    held,
    done: false,
    abort: false,
    releaseAll,
    stuckTeleports: 0,
  };
  window.__moveLoop = loop;

  // Stuck-detection + recovery: every 8s, sample player pose. If the
  // character moved <8m in the prior 8s window despite the segment
  // having a 'w' key (i.e., supposed to be running forward), they're
  // wedged on terrain / inside a portal / in a dungeon they fell into.
  // Recover by firing `@telepoi Holtburg` to teleport back to the test
  // anchor, then resume the movement pattern. Keep a counter so the
  // post-run summary can report how often this fired.
  const STUCK_CHECK_MS = 8000;
  const STUCK_MIN_PROGRESS_M = 8;
  let lastStuckCheckPose = null;
  const stuckCheckTimer = setInterval(() => {
    if (loop.done || loop.abort) return;
    try {
      const handle = window.liveScene3d && window.liveScene3d.sessionHandle;
      const p = handle && typeof handle.getLocalPlayerPose === "function"
        ? handle.getLocalPlayerPose()
        : null;
      if (!p || typeof p.x !== "number") return;
      if (lastStuckCheckPose) {
        const dx = p.x - lastStuckCheckPose.x;
        const dy = p.y - lastStuckCheckPose.y;
        const moved = Math.hypot(dx, dy);
        const wantsForward = held.has("w");
        if (wantsForward && moved < STUCK_MIN_PROGRESS_M) {
          console.log(`[move-loop] stuck: moved ${moved.toFixed(1)}m in ${STUCK_CHECK_MS}ms with W held — teleporting back to Holtburg`);
          loop.stuckTeleports += 1;
          try { handle.sendChat("@telepoi Holtburg"); } catch (_) {}
          // Skip the next pose-check window so the teleport's pose
          // settle doesn't immediately re-trigger.
          lastStuckCheckPose = null;
          return;
        }
      }
      lastStuckCheckPose = { x: p.x, y: p.y };
    } catch (_) {}
  }, STUCK_CHECK_MS);
  loop.stuckCheckTimer = stuckCheckTimer;

  let idx = 0;
  const step = () => {
    if (loop.abort) { releaseAll(); loop.done = true; clearInterval(stuckCheckTimer); return; }
    if (idx >= pattern.length) {
      releaseAll();
      loop.done = true;
      clearInterval(stuckCheckTimer);
      loop.finishedAt = performance.now();
      console.log(`[move-loop] done (stuckTeleports=${loop.stuckTeleports})`);
      return;
    }
    const seg = pattern[idx++];
    setHeld(new Set(seg.keys));
    loop.events.push({
      t: +(performance.now() - loop.started).toFixed(2),
      label: seg.label,
      keys: seg.keys.slice(),
    });
    setTimeout(step, seg.dur);
  };
  loop.kicker = setTimeout(step, 0);

  console.log("[move-loop] started: " + pattern.length + " segs, " + totalMs + " ms");
  return { ok: true, totalMs, patternVersion: PATTERN_VERSION, segments: pattern.length };
}
