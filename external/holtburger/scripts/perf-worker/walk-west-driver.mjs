// Headless walk-west perf driver for holtburger-web (laptop / SwiftShader).
// Boots the app, teleports to Holtburg, settles, walks west, sampling perf
// metrics every SAMPLE_MS into samples.jsonl + longtask hang detection.
//
// NOTE: laptop is no-GPU (SwiftShader). Absolute FPS is NOT representative of
// the real GTX-1070; but draw-call/mesh/program COUNTS, bake/evict cadence,
// PVS/LOD, wire/network, heap growth, and MAIN-THREAD longtasks (which isolate
// JS + draw-submission cost, since raster runs in the GPU process) ARE valid.
//
// Env:
//   OUT       output dir (required)
//   SETTLE_S  settle seconds (default 180)
//   WALK_S    walk-west seconds (default 300; 0 = skip walk = smoke mode)
//   QUALITY   quality preset (default low)
//   AGENTIC   agentic preset (default low)
//   TELEPORT  1 to @telepoi Holtburg before settle (default 1)
//   SAMPLE_MS sampling interval ms (default 2000)

import pw from '/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core/index.js';
import fs from 'fs';
const { chromium } = pw;

const OUT = process.env.OUT || `/mnt/wbterminal1/tmp/claude-scratch/perf/walk-west-${Date.now()}`;
const SETTLE_S = +(process.env.SETTLE_S ?? 180);
const WALK_S   = +(process.env.WALK_S   ?? 300);
const QUALITY  = process.env.QUALITY  ?? 'low';
const AGENTIC  = process.env.AGENTIC  ?? 'low';
const TELEPORT = (process.env.TELEPORT ?? '1') === '1';
const PVS = +(process.env.PVS ?? 5);
const BAKE_WORKER = process.env.BAKE_WORKER === '1';
const WIREFRAME = process.env.WIREFRAME === '1';
const MOVE_MODE = process.env.MOVE_MODE ?? 'hop';   // 'hop' = @teleloc | 'walk' = physical keyboard run
const SAMPLE_MS = +(process.env.SAMPLE_MS ?? 2000);
const CHROME = '/home/wbterminal/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome';

fs.mkdirSync(OUT, { recursive: true });
const jsonl = fs.createWriteStream(`${OUT}/samples.jsonl`, { flags: 'a' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(s) {
  const m = `[${new Date().toISOString()}] ${s}`;
  console.log(m);
  try { fs.appendFileSync(`${OUT}/driver.log`, m + '\n'); } catch {}
}

// In-page metric snapshot (runs in browser).
function snapshot() {
  const d = window.__diag || {};
  const sz = (x) => x == null ? null
    : (typeof x === 'number' ? x
    : (typeof x.size === 'number' ? x.size
    : (Array.isArray(x) ? x.length : null)));
  const b = d.bakes || null;
  // Draw calls/triangles: read CUMULATIVE from renderer.info with autoReset=false,
  // because three.js zeroes info.render before each render() so async reads see ~1
  // (per scripts/perf-worker/lib/install-recorder.js). Driver diffs consecutive samples.
  const ls = window.liveScene3d;
  const rr = ls && ls.renderer;
  let ri = null;
  if (rr && rr.info) {
    rr.info.autoReset = false;
    ri = { cumCalls: rr.info.render.calls, cumTris: rr.info.render.triangles,
           programs: rr.info.programs ? rr.info.programs.length : null,
           geometries: rr.info.memory ? rr.info.memory.geometries : null,
           textures: rr.info.memory ? rr.info.memory.textures : null };
  }
  // Culling triptych via scene traversal: total meshes vs. those whose full ancestor
  // .visible chain is true (not hidden by PVS/cell-visibility group toggles).
  // callsPerFrame ÷ visChain ≈ frustum-cull effectiveness (instanced meshes = 1 call/many).
  let mesh = null;
  const scene = ls && ls.scene;
  if (scene) {
    let total = 0, visChain = 0;
    scene.traverse((o) => {
      if (o.isMesh || o.isInstancedMesh || o.isBatchedMesh) {
        total++;
        let vis = o.visible; let p = o.parent;
        while (vis && p) { if (!p.visible) { vis = false; break; } p = p.parent; }
        if (vis) visChain++;
      }
    });
    mesh = { total, visChain };
  }
  let wire = null, pvsVis = null, lod = null, poseObj = null;
  try { wire = d.wire && d.wire.summary ? d.wire.summary() : null; } catch {}
  try { pvsVis = d.pvs && d.pvs.visibleCells ? d.pvs.visibleCells().size : null; } catch {}
  try { lod = d.lod && d.lod.summary ? d.lod.summary() : null; } catch {}
  try {
    const h = window.__sessionHandle;
    const p = h && h.getLocalPlayerPose ? h.getLocalPlayerPose() : null;
    if (p) {
      poseObj = { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10,
                  lb: p.landblockId, heading: p.heading, ground: p.isOnGround };
      try { p.free(); } catch {}  // wasm-owned; free to avoid leaking the linear-memory struct
    }
  } catch {}

  // drain per-interval frame deltas recorded by the rAF loop
  const f = window.__fr || { buf: [] };
  const dts = f.buf; f.buf = [];
  dts.sort((a, c) => a - c);
  const n = dts.length;
  const pct = (q) => n ? +dts[Math.min(n - 1, Math.floor(q * n))].toFixed(1) : null;
  const sum = dts.reduce((a, c) => a + c, 0);
  const frame = { n, meanMs: n ? +(sum / n).toFixed(1) : null, p50: pct(0.5), p95: pct(0.95),
                  max: n ? +dts[n - 1].toFixed(1) : null, fps: sum ? +(n * 1000 / sum).toFixed(2) : null };

  const lt = (window.__perf && window.__perf.longtasks) || [];
  return {
    t: Date.now(),
    boot: window.__bootState,
    heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
    frame,
    ri, mesh,
    bakes: b ? { terrain: sz(b.terrain), statics: sz(b.statics), buildings: sz(b.buildings),
                 envCells: sz(b.envCells), matPending: sz(b.materialsPending), counts: b.counts || null } : null,
    wire, pvsVis, lod,
    pose: poseObj,
    ltCount: lt.length,
  };
}

const consoleMsgs = [];
const pageErrors = [];
const reqFailed = [];
const samples = [];
let phase = 'boot';

(async () => {
  log(`start OUT=${OUT} SETTLE_S=${SETTLE_S} WALK_S=${WALK_S} QUALITY=${QUALITY} AGENTIC=${AGENTIC}`);
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      '--no-sandbox', '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
      '--ignore-gpu-blocklist', '--enable-webgl-draft-extensions',
      '--window-size=1280,720',
    ],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);

  page.on('console', (msg) => {
    const t = msg.type(); const txt = msg.text();
    consoleMsgs.push({ t, txt, ts: Date.now(), phase });
    if (t === 'error' || t === 'warning' || /error|fail|exception|cannot|undefined is not/i.test(txt))
      log(`CONSOLE.${t}: ${txt.slice(0, 300)}`);
  });
  page.on('pageerror', (err) => {
    pageErrors.push({ msg: String(err), ts: Date.now(), phase });
    log(`PAGEERROR: ${String(err).slice(0, 400)}`);
  });
  page.on('requestfailed', (req) => {
    reqFailed.push({ url: req.url(), err: req.failure()?.errorText, ts: Date.now(), phase });
    const u = req.url();
    if (!/favicon/.test(u)) log(`REQFAILED: ${u.slice(-90)} ${req.failure()?.errorText}`);
  });

  // Install longtask observer BEFORE any page script so we catch boot hangs too.
  await page.addInitScript(() => {
    window.__perf = { longtasks: [] };
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__perf.longtasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) });
          if (window.__perf.longtasks.length > 20000) window.__perf.longtasks.shift();
        }
      });
      po.observe({ entryTypes: ['longtask'] });
    } catch (e) {}
  });

  const url = `http://127.0.0.1:8765/apps/holtburger-web/index.html`
    + `?autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first`
    + `&renderer=3d&quality=${QUALITY}&agentic=${AGENTIC}&pvsRingRadius=${PVS}&nosw=1&renderDiag=on`
    + (BAKE_WORKER ? '&bakeWorker=1' : '')
    + (WIREFRAME ? '&wireframe=1' : '');
  log(`goto ${url}`);
  await page.goto(url, { waitUntil: 'commit', timeout: 60000 });

  // Poll boot state. On SwiftShader the app's 'scene-ready' signal times out after 90s
  // (bootState='error') even though the scene loads fine, so we also accept 'error'/'in-world'
  // once the scene actually has meshes — the 'ready' gate is unreliable on slow hardware.
  const meshCount = () => page.evaluate(() => {
    const s = window.liveScene3d && window.liveScene3d.scene; if (!s) return 0;
    let n = 0; s.traverse((o) => { if (o.isMesh || o.isInstancedMesh || o.isBatchedMesh) n++; }); return n;
  }).catch(() => 0);
  const bootDeadline = Date.now() + 240000;
  let lastState = '', inWorldSince = 0, proceed = false;
  while (Date.now() < bootDeadline) {
    const st = await page.evaluate(() => window.__bootState).catch(() => '(eval-blocked)');
    if (st !== lastState) { log(`bootState -> ${st}`); lastState = st; if ((st === 'in-world' || st === 'ready' || st === 'error') && !inWorldSince) inWorldSince = Date.now(); }
    if (st === 'ready') { proceed = true; log('boot: ready'); break; }
    if (st === 'error' || (st === 'in-world' && inWorldSince && Date.now() - inWorldSince > 20000)) {
      const mt = await meshCount();
      if (mt > 100) { log(`boot: state=${st} meshTotal=${mt} — proceeding (scene functional without 'ready')`); proceed = true; break; }
    }
    await sleep(1500);
  }
  if (!proceed) log(`WARNING: boot did not reach a usable state (last=${lastState}); continuing anyway`);

  // Install rAF frame recorder
  await page.evaluate(() => {
    if (window.__fr) return;
    window.__fr = { buf: [], last: -1 };
    const loop = (now) => {
      const f = window.__fr;
      if (f.last >= 0) { const dt = now - f.last; if (dt > 0 && dt < 60000) f.buf.push(dt); }
      f.last = now;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });

  if (TELEPORT) {
    log('teleport: @telepoi Holtburg');
    const tr = await page.evaluate(() => { try { window.__sessionHandle.sendChat('@telepoi Holtburg'); return 'ok'; } catch (e) { return String(e); } });
    log(`teleport -> ${tr}`);
    await sleep(5000);
  }

  // Continuous sampler
  let stop = false;
  const samplerDone = (async () => {
    while (!stop) {
      const s = await page.evaluate(snapshot).catch((e) => ({ t: Date.now(), evalErr: String(e).slice(0, 120) }));
      s.phase = phase;
      const line = JSON.stringify(s);
      jsonl.write(line + '\n');
      samples.push(s);
      await sleep(SAMPLE_MS);
    }
  })();

  // SETTLE
  phase = 'settle';
  log(`SETTLE ${SETTLE_S}s begin`);
  // periodic heartbeat during settle
  const settleEnd = Date.now() + SETTLE_S * 1000;
  while (Date.now() < settleEnd) {
    await sleep(Math.min(30000, Math.max(1000, settleEnd - Date.now())));
    const last = samples[samples.length - 1] || {};
    log(`settle hb: fps=${last.frame?.fps} cumCalls=${last.ri?.cumCalls} meshTot=${last.mesh?.total} vis=${last.mesh?.visChain} `
      + `progs=${last.ri?.programs} geo=${last.ri?.geometries} statics=${last.bakes?.statics} terr=${last.bakes?.terrain} bldg=${last.bakes?.buildings} heap=${last.heapMB}MB lt=${last.ltCount}`);
  }

  // PHYSICAL WALK west (MOVE_MODE=walk): held-'w' run + self-calibrating Q/E west-lock + stuck->teleport.
  // Viable at the wireframe frame rate (~5 fps) where per-frame move input no longer starves.
  if (WALK_S > 0 && MOVE_MODE === 'walk') {
    phase = 'walk';
    log(`WALK-WEST (physical) ${WALK_S}s begin`);
    await page.evaluate((walkMs) => {
      if (window.__walkCtl) { try { window.__walkCtl.stop = true; window.__walkCtl.releaseAll(); } catch {} }
      const TARGET = -Math.PI / 2; // west (pose.heading: +X east=+pi/2, -X west=-pi/2)
      const held = new Set();
      const fire = (k, t) => document.dispatchEvent(new KeyboardEvent(t, { key: k, code: 'Key' + k.toUpperCase(), bubbles: true, cancelable: true }));
      const setHeld = (k, on) => { if (on && !held.has(k)) { fire(k, 'keydown'); held.add(k); } else if (!on && held.has(k)) { fire(k, 'keyup'); held.delete(k); } };
      const releaseAll = () => { for (const k of [...held]) { fire(k, 'keyup'); held.delete(k); } };
      const angDiff = (a, t) => { let d = a - t; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
      const getPose = () => { try { const h = window.__sessionHandle; const p = h && h.getLocalPlayerPose ? h.getLocalPlayerPose() : null; if (!p) return null; const o = { x: p.x, y: p.y, lb: p.landblockId >>> 0, h: p.heading }; try { p.free(); } catch {} return o; } catch { return null; } };
      try { const el = document.activeElement; if (el && el !== document.body && el.blur) el.blur(); } catch {}
      // Simple + robust: hold 'w' (run forward) continuously; on a wedge (same landblock AND
      // <4m local move over 6s) teleport back to Holtburg to re-orient and keep going. Continuous
      // traversal + streaming is the goal — precise west steering is unreliable headless (the Q/E
      // west-lock oscillates), so we don't chase exact heading; track which landblocks we cross.
      void TARGET; void angDiff;
      const st = { started: performance.now(), stop: false, mode: 'run', lastPose: null, lastCheck: 0, stuckTeleports: 0, releaseAll };
      window.__walkCtl = st;
      setHeld('w', true);
      const tick = () => {
        if (st.stop) { releaseAll(); return; }
        const p = getPose(); if (!p) return;
        setHeld('w', true);
        const now = performance.now();
        if (now - st.lastCheck > 6000) {
          const lp = st.lastPose;
          if (lp && lp.lb === p.lb && Math.hypot(p.x - lp.x, p.y - lp.y) < 4) {
            st.stuckTeleports++;
            try { window.__sessionHandle.sendChat('@telepoi Holtburg'); } catch {}
            st.lastPose = null; st.lastCheck = now + 3000; return;
          }
          st.lastPose = { x: p.x, y: p.y, lb: p.lb }; st.lastCheck = now;
        }
      };
      st.timer = setInterval(tick, 300);
      setTimeout(() => { st.stop = true; clearInterval(st.timer); releaseAll(); }, walkMs);
    }, WALK_S * 1000);
    const walkEnd = Date.now() + WALK_S * 1000;
    const xbSeen = new Set();
    while (Date.now() < walkEnd) {
      await sleep(30000);
      const ctl = await page.evaluate(() => {
        const c = window.__walkCtl; const h = window.__sessionHandle; const p = h && h.getLocalPlayerPose ? h.getLocalPlayerPose() : null;
        const o = { mode: c ? c.mode : null, tp: c ? c.stuckTeleports : null, lb: p ? p.landblockId >>> 0 : null, x: p ? +p.x.toFixed(1) : null, y: p ? +p.y.toFixed(1) : null, hd: p ? +p.heading.toFixed(2) : null };
        try { p && p.free(); } catch {}
        return o;
      });
      if (ctl && ctl.lb != null) xbSeen.add((ctl.lb >>> 24) & 0xff);
      const last = samples[samples.length - 1] || {};
      log(`walk mode=${ctl.mode} tp=${ctl.tp} lb=0x${ctl.lb ? ctl.lb.toString(16) : '?'} xb=${ctl.lb != null ? '0x' + ((ctl.lb >>> 24) & 0xff).toString(16) : '?'} hd=${ctl.hd} xbSeen=${xbSeen.size} `
        + `| fps=${last.frame?.fps} meshTot=${last.mesh?.total} vis=${last.mesh?.visChain} heap=${last.heapMB}MB lt=${last.ltCount}`);
    }
    await page.evaluate(() => { if (window.__walkCtl) { window.__walkCtl.stop = true; try { window.__walkCtl.releaseAll(); } catch {} } });
    log(`walk end; distinct west x-bytes seen=${xbSeen.size} [${[...xbSeen].map((x) => '0x' + x.toString(16)).join(',')}]`);
  }
  // TRAVERSE WEST via @teleloc landblock hops (MOVE_MODE=hop, default). Used when physical walking
  // isn't viable (textured mode at <1 fps starves per-frame input; avatar wedges). Each hop forces a
  // cold-fill bake burst = the worst-case landblock-streaming + hang event.
  else if (WALK_S > 0) {
    phase = 'walk';
    const HOP_MS = +(process.env.HOP_MS ?? 20000);
    const nHops = Math.max(1, Math.floor((WALK_S * 1000) / HOP_MS));
    log(`HOP-WEST ${WALK_S}s begin: ${nHops} hops x ${HOP_MS}ms (@teleloc, 1 landblock west each)`);
    const base = await page.evaluate(() => {
      const h = window.__sessionHandle; const p = h && h.getLocalPlayerPose ? h.getLocalPlayerPose() : null;
      if (!p) return null;
      const o = { cell: p.landblockId >>> 0, x: p.x, y: p.y, z: p.z };
      try { p.free(); } catch {}
      return o;
    });
    log(`hop base=${JSON.stringify(base)} cellHex=0x${base ? (base.cell >>> 0).toString(16) : '?'}`);
    const xbSeen = new Set();
    for (let hop = 1; hop <= nHops && base; hop++) {
      const cell = (base.cell - hop * 0x01000000) >>> 0;   // one landblock west (x-byte -1)
      const cmd = `@teleloc 0x${cell.toString(16).toUpperCase()} ${base.x.toFixed(3)} ${base.y.toFixed(3)} ${base.z.toFixed(3)}`;
      const ltBefore = (samples[samples.length - 1] || {}).ltCount ?? 0;
      const r = await page.evaluate((c) => { try { window.__sessionHandle.sendChat(c); return 'ok'; } catch (e) { return String(e); } }, cmd);
      await sleep(HOP_MS);
      const p = await page.evaluate(() => {
        const h = window.__sessionHandle; const q = h && h.getLocalPlayerPose ? h.getLocalPlayerPose() : null;
        if (!q) return null;
        const o = { lb: q.landblockId >>> 0, x: +q.x.toFixed(1), y: +q.y.toFixed(1), z: +q.z.toFixed(1) };
        try { q.free(); } catch {}
        return o;
      });
      const xb = p ? (p.lb >>> 24) & 0xff : null;
      if (xb != null) xbSeen.add(xb);
      const last = samples[samples.length - 1] || {};
      const dLt = (last.ltCount ?? 0) - ltBefore;
      log(`hop ${hop}/${nHops} -> 0x${cell.toString(16)} ${r} | pose lb=0x${p ? (p.lb >>> 0).toString(16) : '?'} xb=${xb != null ? '0x' + xb.toString(16) : '?'} `
        + `| fps=${last.frame?.fps} cumCalls=${last.ri?.cumCalls} meshTot=${last.mesh?.total} vis=${last.mesh?.visChain} progs=${last.ri?.programs} heap=${last.heapMB}MB lt=${last.ltCount} dLt=${dLt}`);
    }
    log(`hop traversal end; distinct west x-bytes seen=${xbSeen.size} [${[...xbSeen].map((x) => '0x' + x.toString(16)).join(',')}]`);
  }

  // Stop sampler
  phase = 'post';
  stop = true;
  await samplerDone;

  // Final longtask pull
  const longtasks = await page.evaluate(() => (window.__perf ? window.__perf.longtasks.slice() : [])).catch(() => []);

  // ---- Summary ----
  const byPhase = (ph) => samples.filter((s) => s.phase === ph);
  function frameAgg(list) {
    const fps = list.map((s) => s.frame?.fps).filter((x) => x != null);
    const p95 = list.map((s) => s.frame?.p95).filter((x) => x != null);
    const mx = list.map((s) => s.frame?.max).filter((x) => x != null);
    const avg = (a) => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : null;
    return { intervals: list.length, meanFps: avg(fps),
             minIntervalFps: fps.length ? Math.min(...fps) : null,
             meanP95Ms: avg(p95), worstFrameMs: mx.length ? Math.max(...mx) : null };
  }
  function ltHist(list, lo, hi) {
    return list.filter((e) => e.dur >= lo && (hi == null || e.dur < hi)).length;
  }
  const trend = (_key, get) => {
    const vals = samples.map(get).filter((x) => x != null);
    return vals.length ? { first: vals[0], last: vals[vals.length - 1], min: Math.min(...vals), max: Math.max(...vals) } : null;
  };
  // Per-frame draw calls = Δ(cumulative renderer.info.render.calls) ÷ frames-in-interval.
  const callsPerFrame = () => {
    const out = {};
    for (const ph of ['settle', 'walk']) {
      const pr = samples.filter((s) => s.phase === ph && s.ri && s.ri.cumCalls != null && s.frame && s.frame.n > 0);
      const vals = [];
      for (let i = 1; i < pr.length; i++) {
        const dc = pr[i].ri.cumCalls - pr[i - 1].ri.cumCalls;
        if (dc >= 0) vals.push(dc / pr[i].frame.n);
      }
      out[ph] = vals.length ? { intervals: vals.length,
        mean: +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1),
        min: +Math.min(...vals).toFixed(1), max: +Math.max(...vals).toFixed(1) } : null;
    }
    return out;
  };
  const summary = {
    meta: { out: OUT, settleS: SETTLE_S, walkS: WALK_S, quality: QUALITY, agentic: AGENTIC,
            sampleMs: SAMPLE_MS, samples: samples.length, generated: new Date().toISOString() },
    frame: { settle: frameAgg(byPhase('settle')), walk: frameAgg(byPhase('walk')) },
    longtasks: {
      total: longtasks.length,
      buckets: { '50-100': ltHist(longtasks, 50, 100), '100-250': ltHist(longtasks, 100, 250),
                 '250-500': ltHist(longtasks, 250, 500), '500-1000': ltHist(longtasks, 500, 1000),
                 '1000+': ltHist(longtasks, 1000, null) },
      worst: longtasks.map((e) => e.dur).sort((a, b) => b - a).slice(0, 15),
      sumMsOver100: longtasks.filter((e) => e.dur >= 100).reduce((a, e) => a + e.dur, 0),
    },
    cumDrawCalls: trend('cumCalls', (s) => s.ri?.cumCalls),
    callsPerFrame: callsPerFrame(),
    meshTotal: trend('meshTotal', (s) => s.mesh?.total),
    meshVisibleChain: trend('meshVis', (s) => s.mesh?.visChain),
    programs: trend('programs', (s) => s.ri?.programs),
    geometries: trend('geometries', (s) => s.ri?.geometries),
    textures: trend('textures', (s) => s.ri?.textures),
    heapMB: trend('heapMB', (s) => s.heapMB),
    bakesTerrain: trend('bakesTerrain', (s) => s.bakes?.terrain),
    bakesStatics: trend('bakesStatics', (s) => s.bakes?.statics),
    bakesBuildings: trend('bakesBuildings', (s) => s.bakes?.buildings),
    wireTotalFirst: samples.find((s) => s.wire)?.wire || null,
    wireTotalLast: [...samples].reverse().find((s) => s.wire)?.wire || null,
    consoleErrors: consoleMsgs.filter((m) => m.t === 'error').length,
    consoleWarns: consoleMsgs.filter((m) => m.t === 'warning').length,
    pageErrors: pageErrors.length,
    reqFailed: reqFailed.length,
    poseStart: samples.find((s) => s.pose)?.pose || null,
    poseEnd: [...samples].reverse().find((s) => s.pose)?.pose || null,
  };
  fs.writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2));
  fs.writeFileSync(`${OUT}/console.json`, JSON.stringify(consoleMsgs, null, 0));
  fs.writeFileSync(`${OUT}/pageerrors.json`, JSON.stringify(pageErrors, null, 2));
  fs.writeFileSync(`${OUT}/reqfailed.json`, JSON.stringify(reqFailed, null, 2));
  fs.writeFileSync(`${OUT}/longtasks.json`, JSON.stringify(longtasks, null, 0));
  log(`SUMMARY: ${JSON.stringify(summary.frame)} lt=${JSON.stringify(summary.longtasks.buckets)} `
    + `cpf=${JSON.stringify(summary.callsPerFrame)} meshTot=${JSON.stringify(summary.meshTotal)} `
    + `heap=${JSON.stringify(summary.heapMB)} errs=${summary.consoleErrors} pageErrs=${summary.pageErrors}`);

  await browser.close();
  log('DONE');
  jsonl.end();
})().catch((e) => {
  log(`FATAL: ${e && e.stack ? e.stack : String(e)}`);
  try { fs.writeFileSync(`${OUT}/FATAL.txt`, String(e && e.stack ? e.stack : e)); } catch {}
  process.exit(1);
});
