() => {
  const rec = window.__perfRec;
  const move = window.__moveLoop;

  if (move) {
    move.abort = true;
    try { move.releaseAll && move.releaseAll(); } catch (e) {}
  }
  if (rec) {
    rec.stopped = true;
    if (rec.rafHandle) { try { cancelAnimationFrame(rec.rafHandle); } catch (e) {} rec.rafHandle = null; }
    if (rec.poseTimer) { try { clearInterval(rec.poseTimer); } catch (e) {} rec.poseTimer = null; }
    if (rec.longTaskObs) { try { rec.longTaskObs.disconnect(); } catch (e) {} rec.longTaskObs = null; }
    const r = window.liveScene3d && window.liveScene3d.renderer;
    if (r && rec.prevAutoReset !== null && rec.prevAutoReset !== undefined) {
      try { r.info.autoReset = rec.prevAutoReset; } catch (e) {}
    }
    if (rec.consoleOrig) {
      try {
        console.log = rec.consoleOrig.log;
        console.warn = rec.consoleOrig.warn;
        console.error = rec.consoleOrig.error;
      } catch (e) {}
      rec.consoleOrig = null;
    }
  }
  if (!rec) return { error: "no-recorder" };

  const frames = rec.frames;
  const dts = frames.map((f) => f.dt);
  const sortedDts = dts.slice().sort((a, b) => a - b);
  const N = sortedDts.length;
  const pct = (q) => N === 0 ? null : +sortedDts[Math.min(N - 1, Math.floor(q * N))].toFixed(2);
  const sum = sortedDts.reduce((a, b) => a + b, 0);
  const totalMs = frames.length ? frames[frames.length - 1].t : 0;
  const avgFps = sum > 0 ? +(N * 1000 / sum).toFixed(2) : null;

  const THRESHOLDS = [50, 100, 250, 500, 1000];
  const hitchCounts = {};
  const hitchTimeMs = {};
  for (const th of THRESHOLDS) {
    hitchCounts[">=" + th + "ms"] = 0;
    hitchTimeMs[">=" + th + "ms"] = 0;
  }
  for (const dt of dts) {
    for (const th of THRESHOLDS) {
      if (dt >= th) {
        hitchCounts[">=" + th + "ms"]++;
        hitchTimeMs[">=" + th + "ms"] += dt;
      }
    }
  }
  for (const k of Object.keys(hitchTimeMs)) {
    hitchTimeMs[k] = +hitchTimeMs[k].toFixed(0);
  }

  // 1-second visible-fps buckets
  const secondsBuckets = [];
  let secIdx = 0, secCount = 0;
  for (const f of frames) {
    const s = Math.floor(f.t / 1000);
    while (secIdx < s) { secondsBuckets.push(secCount); secCount = 0; secIdx++; }
    secCount++;
  }
  secondsBuckets.push(secCount);

  // Long-task summary (Firefox-only, may be missing)
  const lt = rec.longTaskEntries || [];
  const longTaskMaxMs = lt.reduce((m, e) => Math.max(m, e.dur), 0);
  const longTaskSumMs = lt.reduce((s, e) => s + e.dur, 0);

  // Path length from poses
  const poses = rec.poseSnaps;
  let pathLen = 0;
  for (let i = 1; i < poses.length; i++) {
    const dx = poses[i].x - poses[i - 1].x;
    const dy = poses[i].y - poses[i - 1].y;
    pathLen += Math.hypot(dx, dy);
  }
  const poseStart = poses[0] || null;
  const poseEnd = poses[poses.length - 1] || null;

  const rs = rec.rendererSnaps;
  const rsFirst = rs[0] || null;
  const rsLast = rs[rs.length - 1] || null;

  return {
    ok: true,
    durationMs: +totalMs.toFixed(0),
    frameCount: N,
    avgFps,
    frameTimeMs: {
      p50: pct(0.5),
      p95: pct(0.95),
      p99: pct(0.99),
      max: N ? +sortedDts[N - 1].toFixed(2) : null,
    },
    hitchCounts,
    hitchTimeMs,
    secondsBuckets,
    longTask: {
      count: lt.length,
      maxMs: +longTaskMaxMs.toFixed(2),
      sumMs: +longTaskSumMs.toFixed(2),
    },
    pose: {
      start: poseStart,
      end: poseEnd,
      pathLengthM: +pathLen.toFixed(2),
      snapCount: poses.length,
    },
    renderer: { start: rsFirst, end: rsLast },
    movement: move ? {
      patternVersion: move.patternVersion,
      events: move.events,
      done: !!move.done,
      aborted: !!move.abort && !move.done,
    } : null,
  };
}
