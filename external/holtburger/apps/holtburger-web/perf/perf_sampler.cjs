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
  var prevCalls = null;    // renderer.info cumulative baseline (context only)
  var prevTris = null;
  var prevPosted = null;   // bake-queue cumulative baselines (ranking axis)
  var prevDecodeMs = null;
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

  function readPose() {
    // Returns { lb: "0xWORD", pos: { lb: objCellId, x, y, z } } — pos is a full
    // route-leg / bot.goto target, so rank can pick a representative waypoint.
    try {
      var p = window.__bot && window.__bot.host && window.__bot.host.TryGetPlayerPose
        ? window.__bot.host.TryGetPlayerPose() : null;
      if (!p) return { lb: null, pos: null };
      var cell = p.objCellId >>> 0;
      return {
        lb: "0x" + ((cell >>> 16) >>> 0).toString(16).padStart(4, "0"),
        pos: { lb: cell, x: p.x, y: p.y, z: p.z },
      };
    } catch (e) { return { lb: null, pos: null }; }
  }

  // Re-aimed 2026-07-19: the lever is CPU decode/bake/RESIDENCY, not draws/fps
  // (docs/rynth-integration/perf-loop-reaim-2026-07-19.md). The ranking fields
  // are `bake` (decode volume + queue starvation, per-window deltas) and
  // `wasmMB` (main+worker linear-memory — the RSS-growth axis; JS heap stays
  // flat so performance.memory is the WRONG memory). frame-time/draw kept as
  // context only — NOT the ranking axis.
  function readBakeDelta() {
    try {
      var bs = window.__diag && window.__diag.bakeWorkerStats ? window.__diag.bakeWorkerStats() : null;
      if (!bs) return null;
      var posted = bs.queue ? (bs.queue.posted || 0) : 0;
      var decodeMs = 0;
      if (bs.byType) for (var t in bs.byType) decodeMs += bs.byType[t].totalMs || 0;
      var maxQ = 0;
      if (bs.queue && bs.queue.byLane) bs.queue.byLane.forEach(function (l) { if (l.maxQueueMs > maxQ) maxQ = l.maxQueueMs; });
      var out = {
        posted: posted, queuedNow: bs.queue ? bs.queue.queuedNow : null, maxQueueMs: maxQ,
        dPosted: prevPosted == null ? null : posted - prevPosted,       // bakes this window = decode volume
        dDecodeMs: prevDecodeMs == null ? null : decodeMs - prevDecodeMs, // main-thread decode ms this window
      };
      prevPosted = posted; prevDecodeMs = decodeMs;
      return out;
    } catch (e) { return null; }
  }
  function readWasmMB() {
    // __diag.datDecode() is async → {main:{wasmMemoryBytes}, worker:{...}}.
    try {
      if (!window.__diag || typeof window.__diag.datDecode !== "function") return Promise.resolve(null);
      return Promise.race([
        window.__diag.datDecode().then(function (r) {
          var mb = function (b) { return typeof b === "number" && isFinite(b) ? Math.round(b / 104857.6) / 10 : null; };
          return { main: mb(r && r.main && r.main.wasmMemoryBytes), worker: mb(r && r.worker && r.worker.wasmMemoryBytes) };
        }),
        new Promise(function (res) { setTimeout(function () { res(null); }, 1500); }),
      ]).catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }

  async function emit() {
    if (!running) return;
    var n = frames, ft = dts.slice(0).sort(function (a, b) { return a - b; });
    var rp = readPose();
    var sample = {
      t: Math.round(typeof performance !== "undefined" ? performance.now() : 0),
      lb: rp.lb,
      pos: rp.pos,
      frames: n,
      bake: readBakeDelta(),               // RANKING AXIS: decode volume + starvation
      wasmMB: await readWasmMB(),           // RANKING AXIS: residency growth (main+worker)
      fps: ft.length ? Math.round((1000 / (ft.reduce(function (a, b) { return a + b; }, 0) / ft.length)) * 10) / 10 : null,
      dt: ft.length ? { p50: pct(ft, 50), p95: pct(ft, 95), p99: pct(ft, 99), worst: ft[ft.length - 1] } : null,
      draw: null, tri: null, baked: null,   // CONTEXT ONLY — not ranked (draws ruled out)
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
    try {
      var s = window.liveScene3d;
      if (s && s.terrainBakedLbs && typeof s.terrainBakedLbs.size === "number") sample.baked = s.terrainBakedLbs.size;
    } catch (e) {}

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
