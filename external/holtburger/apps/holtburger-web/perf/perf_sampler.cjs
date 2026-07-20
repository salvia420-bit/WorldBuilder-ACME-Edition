// perf_sampler.cjs — the in-page performance collector for the explorer perf loop.
//
// Exports SAMPLER_FN: a function that INSTALLS an in-page collector. The driver
// injects it with `page.evaluate(SAMPLER_FN, opts)` (playwright serializes the
// function + arg and runs it in the page). It must therefore be entirely
// self-contained — no closures over driver state, no imports.
//
// The collector emits one `[perfsample] {json}` console line every ~emitMs. The
// driver taps `page.on("console")` and timestamps on ARRIVAL. This split is
// load-bearing: a CDP driver must NEVER time anything by evaluate() round-trips
// — evaluate responses starve for tens of seconds on a busy renderer, while
// console events stream fine (retraction in RESULTS-navatlas-soak-15-pickup).
//
// Data sources (all guarded — a missing field nulls that one field, never the
// whole sample):
//   frame time   — rAF delta ring, percentiles computed at emit
//   draw / tri   — liveScene3d.renderer.info.render, autoReset=false, cumulative
//                  diff ÷ frames (autoReset defaults TRUE → per-frame zeroing)
//   heap         — performance.memory.usedJSHeapSize (Chrome-only)
//   streaming    — liveScene3d.terrainBakedLbs.size (stalls = cold-load cost)
//   bin key      — __bot.host.TryGetPlayerPose().objCellId >>> 16 (landblock word)
//
// liveScene3d is a one-time snapshot set ~35s after in-world; poll not-null.

/** Installed in the page. Runs until window.__perfSampler.stop(). */
function SAMPLER_FN(opts) {
  var emitMs = (opts && opts.emitMs) || 10000;
  if (window.__perfSampler) return "already-installed";

  var dts = [];            // frame times (ms) since last emit
  var lastFrame = 0;       // performance.now() of previous rAF
  var frames = 0;          // frames since last emit
  var prevCalls = null;    // renderer.info cumulative baseline
  var prevTris = null;
  var infoArmed = false;   // set autoReset=false exactly once
  var running = true;

  function pct(sorted, p) {
    if (!sorted.length) return null;
    var i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
    return sorted[i];
  }

  function renderer() {
    var s = window.liveScene3d;
    return s && s.renderer ? s.renderer : null;
  }

  function armInfo() {
    if (infoArmed) return;
    var r = renderer();
    if (r && r.info) { try { r.info.autoReset = false; infoArmed = true; } catch (e) {} }
  }

  function tick(now) {
    if (!running) return;
    if (lastFrame) { var dt = now - lastFrame; if (dt > 0 && dt < 2000) dts.push(dt); frames++; }
    lastFrame = now;
    armInfo();
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  function readLb() {
    try {
      var pose = window.__bot && window.__bot.host && window.__bot.host.TryGetPlayerPose
        ? window.__bot.host.TryGetPlayerPose() : null;
      if (!pose) return null;
      var cell = pose.objCellId >>> 0;
      return "0x" + ((cell >>> 16) >>> 0).toString(16).padStart(4, "0");
    } catch (e) { return null; }
  }

  function emit() {
    if (!running) return;
    var n = frames, ft = dts.slice(0).sort(function (a, b) { return a - b; });
    var sample = {
      t: Math.round(typeof performance !== "undefined" ? performance.now() : 0),
      lb: readLb(),
      frames: n,
      fps: ft.length ? Math.round((1000 / (ft.reduce(function (a, b) { return a + b; }, 0) / ft.length)) * 10) / 10 : null,
      dt: ft.length ? { p50: pct(ft, 50), p95: pct(ft, 95), p99: pct(ft, 99), worst: ft[ft.length - 1] } : null,
      draw: null, tri: null, heapMB: null, baked: null,
    };

    var r = renderer();
    if (r && r.info && r.info.render) {
      var c = r.info.render.calls, tri = r.info.render.triangles;
      if (prevCalls != null && n > 0) {
        sample.draw = Math.round((c - prevCalls) / n);
        sample.tri = Math.round((tri - prevTris) / n);
      }
      prevCalls = c; prevTris = tri;
    }
    try { if (performance.memory) sample.heapMB = Math.round(performance.memory.usedJSHeapSize / 1e5) / 10; } catch (e) {}
    try {
      var s = window.liveScene3d;
      if (s && s.terrainBakedLbs && typeof s.terrainBakedLbs.size === "number") sample.baked = s.terrainBakedLbs.size;
    } catch (e) {}

    // Round frame-time fields for a compact, diff-friendly line.
    if (sample.dt) for (var k in sample.dt) if (sample.dt[k] != null) sample.dt[k] = Math.round(sample.dt[k] * 10) / 10;

    console.log("[perfsample] " + JSON.stringify(sample));
    dts.length = 0; frames = 0;
  }

  var timer = setInterval(emit, emitMs);
  window.__perfSampler = {
    stop: function () { running = false; clearInterval(timer); return "stopped"; },
    emitNow: emit,
    opts: { emitMs: emitMs },
  };
  return "installed";
}

module.exports = { SAMPLER_FN };
