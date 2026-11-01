// carry-census.eval.js — REAL-render draw census (SwiftShader, --render session) for the hb-carry experiment.
// Draw-call counts are structural: the same URL, pose and dist give the same counts on any GPU
// (scripts/perf-worker/laptop-structure-probe.mjs). Frame TIMES here mean nothing.
//
// window.__carryRun = { mode: "bench" | "drone", ... }
//  bench: the 1070 bench view — 70 m orbit at 22° elevation around Holtburg 0xA9B40001 (96, 96, 80) — at `azList`,
//         `frames` rendered frames each (drone stowed, camera parked by __cam.orbit).
//  drone: deploy / climb the real drone to each `aglList` altitude (heading `headingDeg`, gimbal `pitchDeg`),
//         settle, then `frames` rendered frames; also `moveFrames` frames while the drone flies at `moveKmh`.
// Per frame: renderer.info calls / triangles (autoReset off, diffed), __batchedRuns.frame() when present, and the
// CPU frustum census of carry-flight.eval.js from the same camera (calibration: real calls ÷ census draws).
const R = Object.assign({ mode: "drone", azList: [0, 90, 180, 270], aglList: [50, 100, 150], pitchDeg: -25, headingDeg: 111,
  frames: 4, moveFrames: 4, moveKmh: 400, settleQuietSec: 12, settleMaxSec: 150, label: "census" }, window.__carryRun || {});
const W = window, L = W.liveScene3d, h = W.__sessionHandle, D = W.__drone, r = L.renderer;
const THREE = await import("three").catch(() => null);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const DEG = Math.PI / 180;
const out = { label: R.label, run: R, errors: [], views: [] };
const nextFrame = () => new Promise((res) => requestAnimationFrame(() => res()));
const frustum = new THREE.Frustum(), pm = new THREE.Matrix4(), dirV = new THREE.Vector3();
const camPitchDeg = () => { L.camera.getWorldDirection(dirV); return Math.asin(clamp(dirV.y, -1, 1)) / DEG; };
const census = () => {
  const cam = L.camera; cam.updateMatrixWorld(true);
  pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse); frustum.setFromProjectionMatrix(pm);
  let draws = 0, inst = 0, batched = 0, mesh = 0;
  const visit = (o) => {
    if (o.visible === false) return;
    if ((!o.layers || o.layers.test(cam.layers)) && (o.isMesh || o.isLine || o.isPoints || o.isSprite)) {
      let inView = true;
      if (o.frustumCulled !== false) { try { inView = o.isSprite ? frustum.intersectsSprite(o) : frustum.intersectsObject(o); } catch (_) { inView = true; } }
      if (inView) {
        if (o.isBatchedMesh) { batched++; draws++; } else if (o.isInstancedMesh) { if (o.count > 0) { inst++; draws++; } }
        else if (o.isMesh) { mesh++; if (Array.isArray(o.material)) { const gr = o.geometry?.groups; draws += gr && gr.length ? gr.length : 1; } else if (o.material?.visible !== false) draws++; }
        else draws++;
      }
    }
    for (const c of o.children) visit(c);
  };
  visit(L.scene);
  return { draws, inst, batched, mesh };
};
const settle = async () => {
  const t0 = performance.now(); let sig = "", quiet = performance.now();
  while (performance.now() - t0 < R.settleMaxSec * 1000) {
    let n = 0; L.scene.traverse((o) => { if (o.isMesh) n++; });
    const s = `${L.terrainBakedLbs?.size ?? 0}/${Math.round(n / 40)}`;
    if (s !== sig) { sig = s; quiet = performance.now(); }
    if (performance.now() - quiet > R.settleQuietSec * 1000) return { sec: Math.round((performance.now() - t0) / 1000), sig, quiet: true };
    await sleep(1500);
  }
  return { sec: R.settleMaxSec, sig, quiet: false };
};
const measure = async (n, label, extra) => {
  const prev = r.info.autoReset; r.info.autoReset = false; r.info.reset();
  const rows = [];
  for (let i = 0; i < n; i++) {
    const c0 = r.info.render.calls, t0 = r.info.render.triangles, w0 = performance.now();
    if (extra?.before) extra.before(i);
    await nextFrame(); await nextFrame();
    const c = r.info.render.calls - c0, t = r.info.render.triangles - t0;
    let br = null; try { br = W.__batchedRuns?.frame?.() ?? null; } catch (_) { br = null; }
    rows.push({ calls: c / 2, tris: Math.round(t / 2), ms: Math.round((performance.now() - w0) / 2), census: census().draws, br: br ? { batchedCalls: br.batchedCalls, subDraws: br.subDraws, issued: br.issued } : null });
  }
  r.info.autoReset = prev;
  const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
  const v = { label, calls: med(rows.map((x) => x.calls)), tris: med(rows.map((x) => x.tris)), census: med(rows.map((x) => x.census)),
    msPerFrame: med(rows.map((x) => x.ms)), programs: r.info.programs?.length ?? null, geometries: r.info.memory?.geometries ?? null,
    textures: r.info.memory?.textures ?? null, rows };
  v.ratio = v.census ? +(v.calls / v.census).toFixed(2) : null;
  out.views.push(v);
  console.log(`[carry] census ${label}: calls ${v.calls} tris ${v.tris} census ${v.census} (${v.msPerFrame} ms/frame)`);
  return v;
};
try {
  if (R.mode === "benchNull") {
    // CPU calibration: the 1070 bench view under ?nullRender=1 (1070 M1a: 71.8-72.0 fps "still"). Frame interval
    // here / 13.9 ms = how much slower this laptop runs the same non-render frame.
    try { if (D && D.status().state !== "idle") (D.debug ? D.debug.trigger("pilotMoved") : D.abort("user")); } catch (_) { /* */ }
    await sleep(3000);
    const X = 169 * 192 + 96, Y = 180 * 192 + 96, Z = 80;
    W.__cam.orbit(X, Y, Z, 70, 0, 22);
    out.settle = await settle();
    const gaps = []; let last = 0, on = true;
    const lt = { n: 0, ms: 0, max: 0 };
    let po = null; try { po = new PerformanceObserver((l) => { for (const e of l.getEntries()) { lt.n++; lt.ms += e.duration; lt.max = Math.max(lt.max, e.duration); } }); po.observe({ type: "longtask" }); } catch (_) { po = null; }
    const k = (t) => { if (!on) return; if (last) gaps.push(t - last); last = t; requestAnimationFrame(k); };
    requestAnimationFrame(k);
    const t0 = performance.now(); let az = 0;
    while (performance.now() - t0 < (R.seconds || 20) * 1000) { if (R.orbitDegPerSec) { az += R.orbitDegPerSec * 0.1; W.__cam.orbit(X, Y, Z, 70, az, 22); } await sleep(100); }
    on = false; try { po?.disconnect(); } catch (_) { /* */ }
    gaps.sort((a, b) => a - b);
    const q = (f) => +gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * f))].toFixed(2);
    out.views.push({ label: `benchNull${R.orbitDegPerSec ? "-moving" : ""}`, frames: gaps.length, p50: q(0.5), p95: q(0.95), max: q(0.999), meanMs: +(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(2), longTasks: lt });
    W.__cam.release();
  } else if (R.mode === "carryCam") {
    // The drone's FPV pose without the drone's frame-driven deploy (SwiftShader renders ~7 s/frame here): the player is
    // carried (debugDragPose) 3 m under the eye, the render camera sits at the eye with the drone's FOV / gimbal pitch.
    if (typeof h.debugDragPose !== "function") throw new Error("debugDragPose missing");
    if (W.__bootState === "error" && W.liveScene3d && (W.getLocalPlayerGuid?.() ?? 0) !== 0) { W.__bootState = "in-world"; out.bootStateFixed = true; }
    try { if (D && D.status().state !== "idle") (D.debug ? D.debug.trigger("pilotMoved") : D.abort("user")); } catch (_) { /* */ }
    const p0 = W.__cam.world();
    const X = p0.x, Y = p0.y, gz = h.terrainHeightAt(X, Y) ?? p0.z;
    const hd = R.headingDeg * DEG, pt = R.pitchDeg * DEG;
    const lbx = Math.floor(X / 192), lby = Math.floor(Y / 192), lx = X - lbx * 192, ly = Y - lby * 192;
    const cell = ((lbx << 24) | (lby << 16) | (Math.min(7, Math.floor(lx / 24)) * 8 + Math.min(7, Math.floor(ly / 24)) + 1)) >>> 0;
    W.__cam.fov(R.fovDeg || 75);
    let carryZ = gz;
    const carry = setInterval(() => { try { h.debugDragPose(cell, lx, ly, carryZ); } catch (_) { /* */ } }, 200);
    try {
      for (const agl of R.aglList) {
        const ez = gz + agl;
        carryZ = ez - 3;
        W.__cam.set(X, Y, ez, X + Math.sin(hd) * Math.cos(pt) * 100, Y + Math.cos(hd) * Math.cos(pt) * 100, ez + Math.sin(pt) * 100);
        const st = await settle();
        const v = await measure(R.frames, `carrycam-agl${agl}`);
        Object.assign(v, { agl, settle: st, eye: [+X.toFixed(1), +Y.toFixed(1), +ez.toFixed(1)], camPitch: +camPitchDeg().toFixed(1) });
      }
    } finally { clearInterval(carry); W.__cam.release(); }
  } else if (R.mode === "bench") {
    try { D?.abort?.("user"); } catch (_) { /* */ }
    await sleep(3000);
    const X = 169 * 192 + 96, Y = 180 * 192 + 96, Z = 80;
    W.__cam.orbit(X, Y, Z, 70, 0, 22);
    out.settle = await settle();
    for (const az of R.azList) { W.__cam.orbit(X, Y, Z, 70, az, 22); await nextFrame(); await measure(R.frames, `bench-az${az}`); }
    W.__cam.release();
  } else {
    // SwiftShader boots past the 90 s scene-ready watchdog, which latches __bootState = 'error' on a healthy
    // in-world session (memory: measurement trap (c)); the drone's deploy gate reads that scalar. Harness-only fix.
    if (W.__bootState === "error" && W.liveScene3d && h && (W.getLocalPlayerGuid?.() ?? 0) !== 0) { W.__bootState = "in-world"; out.bootStateFixed = true; }
    if (D.status().state !== "flying") {
      D.setSettings({ batteryMin: 0, mode: "cine", crash: false });
      const dep = D.deploy({ quick: true }); out.deploy = dep;
      const t0 = performance.now();
      while (D.status().state !== "flying") { if (performance.now() - t0 > 120000) throw new Error("not flying: " + D.status().state); await sleep(500); }
    }
    const hold = async (agl, untilMs) => {
      const t0 = performance.now();
      for (;;) {
        const c = D.status().craft; const gz = h.terrainHeightAt(c.pos[0], c.pos[1]);
        const err = gz == null ? 0 : gz + agl - c.pos[2];
        const hd = c.hprDeg.h, herr = ((R.headingDeg - hd + 540) % 360) - 180;
        const pe = R.pitchDeg - camPitchDeg();
        D.debug.setSticks({ throttle: clamp(err / 15, -1, 1), yaw: clamp(herr / 30, -1, 1), gimbal: clamp(pe / 10, -1, 1) }, 400);
        if (Math.abs(err) < 2 && Math.abs(herr) < 2 && Math.abs(pe) < 2 && performance.now() - t0 > 1500) return true;
        if (performance.now() - t0 > untilMs) return false;
        await sleep(150);
      }
    };
    for (const agl of R.aglList) {
      const ok = await hold(agl, 90000);
      const st = await settle();
      await hold(agl, 15000);
      const c = D.status().craft;
      const v = await measure(R.frames, `drone-agl${agl}`, { before: () => D.debug.setSticks({}, 400) });
      Object.assign(v, { held: ok, settle: st, agl: c.aglM, pos: c.pos, hdg: c.hprDeg.h, camPitch: +camPitchDeg().toFixed(1) });
      if (R.moveFrames > 0) {
        const vmax = (D.carry().cfg.kmh || 760) / 3.6;
        const mv = await measure(R.moveFrames, `drone-agl${agl}-moving${R.moveKmh}`, { before: () => D.debug.setSticks({ pitch: clamp(R.moveKmh / 3.6 / vmax, 0, 1), boost: true }, 2000) });
        mv.speed = D.status().craft.speed;
        D.debug.setSticks({}, 100);
      }
    }
  }
} catch (e) { out.errors.push(String(e?.stack ?? e).slice(0, 600)); }
out.summary = out.views.map((v) => ({ label: v.label, calls: v.calls, tris: v.tris, census: v.census, ratio: v.ratio, ms: v.msPerFrame, agl: v.agl ?? null }));
return out;
