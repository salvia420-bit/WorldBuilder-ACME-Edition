() => {
  const move = window.__moveLoop;
  if (move) {
    move.abort = true;
    try { move.releaseAll && move.releaseAll(); } catch (e) {}
    if (move.stuckCheckTimer) { try { clearInterval(move.stuckCheckTimer); } catch (e) {} }
  }
  const rec = window.__perfRec;
  if (rec) {
    rec.stopped = true;
    if (rec.rafHandle) { try { cancelAnimationFrame(rec.rafHandle); } catch (e) {} }
    if (rec.poseTimer) { try { clearInterval(rec.poseTimer); } catch (e) {} }
    if (rec.longTaskObs) { try { rec.longTaskObs.disconnect(); } catch (e) {} }
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
    }
  }
  delete window.__perfRec;
  delete window.__moveLoop;
  console.log("[perf-worker] cleanup done");
  return { ok: true };
}
