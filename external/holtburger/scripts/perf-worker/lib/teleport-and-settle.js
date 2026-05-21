async () => {
  const handle = window.__sessionHandle;
  if (!handle || typeof handle.sendChat !== "function") {
    return { error: "no-session-handle" };
  }
  if (typeof handle.getLocalPlayerPose !== "function") {
    return { error: "no-pose-fn" };
  }
  const before = handle.getLocalPlayerPose();
  if (!before) return { error: "no-pose-before" };

  try {
    handle.sendChat("@telepoi Holtburg");
  } catch (e) {
    return { error: "sendChat-failed", detail: String((e && e.message) || e) };
  }

  const start = performance.now();
  const TIMEOUT_MS = 18000;
  const STABLE_MS = 1500;
  const MOVE_MIN_M = 20;

  let lastPose = before;
  let stableSince = null;

  while (performance.now() - start < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 500));
    const p = handle.getLocalPlayerPose();
    if (!p || typeof p.x !== "number") continue;

    const dx = p.x - before.x, dy = p.y - before.y;
    const moved = Math.hypot(dx, dy);

    if (moved < MOVE_MIN_M) {
      // Either teleport hasn't landed yet (waiting for ACE) or we were
      // already at Holtburg (idempotent). After a couple of seconds with
      // no movement, treat as already-there.
      if (performance.now() - start > 4000) {
        return {
          ok: true,
          alreadyAtHoltburg: true,
          moved: +moved.toFixed(1),
          elapsedMs: +(performance.now() - start).toFixed(0),
          before: { x: +before.x.toFixed(2), y: +before.y.toFixed(2), z: +before.z.toFixed(2) },
          after:  { x: +p.x.toFixed(2),      y: +p.y.toFixed(2),      z: +p.z.toFixed(2) },
        };
      }
      continue;
    }

    const drift = Math.hypot(p.x - lastPose.x, p.y - lastPose.y);
    lastPose = p;
    if (drift < 0.5) {
      if (stableSince === null) stableSince = performance.now();
      else if (performance.now() - stableSince >= STABLE_MS) {
        return {
          ok: true,
          alreadyAtHoltburg: false,
          moved: +moved.toFixed(1),
          elapsedMs: +(performance.now() - start).toFixed(0),
          before: { x: +before.x.toFixed(2), y: +before.y.toFixed(2), z: +before.z.toFixed(2) },
          after:  { x: +p.x.toFixed(2),      y: +p.y.toFixed(2),      z: +p.z.toFixed(2) },
        };
      }
    } else {
      stableSince = null;
    }
  }

  return {
    error: "teleport-timeout",
    elapsedMs: +(performance.now() - start).toFixed(0),
    lastPose: { x: +lastPose.x.toFixed(2), y: +lastPose.y.toFixed(2), z: +lastPose.z.toFixed(2) },
  };
}
