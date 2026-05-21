() => {
  if (window.__perfRec) return { error: "already-installed" };
  const r0 = window.liveScene3d && window.liveScene3d.renderer;
  const sc = window.liveScene3d && window.liveScene3d.scene;

  // Three.js info.autoReset zeros .calls/.triangles before each render(),
  // so reading them async between renders only shows the LAST pass (e.g. 1
  // for the final blit). Flip autoReset off and take per-window deltas
  // ourselves. Restore on cleanup.
  const prevAutoReset = r0 ? r0.info.autoReset : null;
  if (r0) r0.info.autoReset = false;

  const rec = {
    started: performance.now(),
    lastT: performance.now(),
    primed: false,
    frames: [],
    rendererSnaps: [],
    poseSnaps: [],
    longTaskEntries: [],
    rafHandle: null,
    poseTimer: null,
    longTaskObs: null,
    stopped: false,
    prevAutoReset,
    _lastSnapAt: 0,
    _lastSnapCalls: r0 ? r0.info.render.calls : 0,
    _lastSnapTris: r0 ? r0.info.render.triangles : 0,
    _lastSnapFrames: 0,
  };
  window.__perfRec = rec;

  const countMeshes = () => {
    if (!sc) return 0;
    let n = 0;
    sc.traverse((o) => { if (o.isMesh) n++; });
    return n;
  };

  const snapRenderer = (now) => {
    const r = window.liveScene3d && window.liveScene3d.renderer;
    if (!r) return;
    const ri = r.info;
    const elapsedMs = now - rec._lastSnapAt;
    const dCalls = ri.render.calls - rec._lastSnapCalls;
    const dTris  = ri.render.triangles - rec._lastSnapTris;
    const dFrames = rec.frames.length - rec._lastSnapFrames;
    rec.rendererSnaps.push({
      t: +(now - rec.started).toFixed(2),
      windowMs: +elapsedMs.toFixed(0),
      callsPerFrame: dFrames > 0 ? +(dCalls / dFrames).toFixed(1) : null,
      trianglesPerFrame: dFrames > 0 ? +(dTris / dFrames).toFixed(0) : null,
      cumCalls: ri.render.calls,
      cumTriangles: ri.render.triangles,
      geometries: ri.memory.geometries,
      textures: ri.memory.textures,
      programs: (ri.programs && ri.programs.length) || 0,
      meshes: countMeshes(),
    });
    rec._lastSnapAt = now;
    rec._lastSnapCalls = ri.render.calls;
    rec._lastSnapTris = ri.render.triangles;
    rec._lastSnapFrames = rec.frames.length;
  };

  const tick = (now) => {
    if (rec.stopped) return;
    if (!rec.primed) {
      rec.lastT = now;
      rec._lastSnapAt = now;
      rec.primed = true;
    } else {
      const dt = now - rec.lastT;
      rec.lastT = now;
      rec.frames.push({ t: +(now - rec.started).toFixed(2), dt: +dt.toFixed(2) });
      if (now - rec._lastSnapAt >= 500) snapRenderer(now);
    }
    rec.rafHandle = requestAnimationFrame(tick);
  };
  rec.rafHandle = requestAnimationFrame(tick);
  // Force a first snapshot so we have a baseline immediately.
  snapRenderer(rec.started);

  rec.poseTimer = setTimeout(() => {
    rec.poseTimer = setInterval(() => {
      const handle = window.liveScene3d && window.liveScene3d.sessionHandle;
      if (handle && typeof handle.getLocalPlayerPose === "function") {
        try {
          const p = handle.getLocalPlayerPose();
          if (p && typeof p.x === "number") {
            rec.poseSnaps.push({
              t: +(performance.now() - rec.started).toFixed(2),
              x: +p.x.toFixed(3),
              y: +p.y.toFixed(3),
              z: typeof p.z === "number" ? +p.z.toFixed(3) : null,
              heading: typeof p.heading === "number" ? +p.heading.toFixed(3) : null,
            });
          }
        } catch (e) { /* swallow */ }
      }
    }, 500);
  }, 250);

  // Hook console so we can correlate hitches with log lines emitted in the
  // same 60s window. /console?n=500 caps at 500 entries and the holtburger
  // app easily emits more than that — we'd lose the early window's lines
  // by the time the run ends. Store rec-relative ts here.
  rec.consoleLog = [];
  const wrap = (lvl, orig) => function (...args) {
    try {
      const s = args.map((a) => {
        if (typeof a === "string") return a;
        try { return JSON.stringify(a); } catch (e) { return String(a); }
      }).join(" ");
      rec.consoleLog.push({
        t: +(performance.now() - rec.started).toFixed(2),
        lvl,
        text: s.length > 400 ? s.slice(0, 400) + "…" : s,
      });
    } catch (e) { /* swallow */ }
    return orig.apply(this, args);
  };
  rec.consoleOrig = {
    log:  console.log,
    warn: console.warn,
    error: console.error,
  };
  console.log = wrap("log", rec.consoleOrig.log);
  console.warn = wrap("warn", rec.consoleOrig.warn);
  console.error = wrap("error", rec.consoleOrig.error);

  if (typeof PerformanceObserver !== "undefined") {
    try {
      rec.longTaskObs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          rec.longTaskEntries.push({
            t: +(e.startTime - rec.started).toFixed(2),
            dur: +e.duration.toFixed(2),
            name: e.name,
          });
        }
      });
      rec.longTaskObs.observe({ entryTypes: ["longtask"] });
    } catch (e) { rec.longTaskObs = null; }
  }

  console.log("[perf-rec] installed");
  return { ok: true, t: rec.started, longtaskSupported: !!rec.longTaskObs };
}
