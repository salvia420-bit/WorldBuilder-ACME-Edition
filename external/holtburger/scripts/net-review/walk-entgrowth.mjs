// walk-entgrowth.mjs — Task #11a growth curve. Connects to the 1070's off-screen
// CDP Chrome, autoLogins, @teleloc to an outdoor town, then HOLDS 'w' (trusted
// page.keyboard, re-asserted each tick) for RUN_S seconds, sampling entity
// geometry + pose every SAMPLE_MS. Answers: does distinct entity BufferGeometry
// grow with continuous walking (entities not LRU-evicted) at bounded residency?
//
// Usage: node walk-entgrowth.mjs [outJson] [runS]
import fs from "node:fs";

const CDP_URL = "http://127.0.0.1:9333";
const ACCOUNT = "tailnet1";
const OUT = process.argv[2] || "/mnt/wbterminal2/tmp/walk-entgrowth.json";
const RUN_S = Number(process.argv[3] || "150");
const SAMPLE_MS = 2000;
// Cragstone clearStart from outdoor-run-plans.json — 40 m out of town on a
// validated 2110 m obstacle-free corridor, facing heading 213.8° down it.
const START = { name: "Cragstone-corridor", cellHex: "0xBB9F0036", x: 147.135, y: 134.992, z: 63.542, q: [-0.290285, 0, 0, -0.95694] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  let pw;
  try { pw = require("playwright-core"); }
  catch (_) {
    const home = process.env.HOME;
    const hits = fs.readdirSync(`${home}/.npm/_npx`).map((d) => `${home}/.npm/_npx/${d}/node_modules/playwright-core`).filter((p) => fs.existsSync(p));
    if (!hits.length) { console.error("playwright-core not found"); process.exit(2); }
    pw = require(hits[0]);
  }

  const browser = await pw.chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  const page = await ctx.newPage();
  const q = new URLSearchParams({ renderer: "3d", autoLogin: "1", account: ACCOUNT, password: ACCOUNT, autoSpawn: "first", nosw: "1" });
  if (process.env.WALK_QUERY) for (const [k, v] of new URLSearchParams(process.env.WALK_QUERY)) q.set(k, v);
  console.error(`[walk] query: ${q}`);
  console.error("[walk] goto autoLogin…");
  await page.goto(`http://127.0.0.1:8765/apps/holtburger-web/index.html?${q}`, { timeout: 60000 });

  let inWorld = false;
  for (let i = 0; i < 240; i++) {
    const bs = await page.evaluate(() => window.__bootState).catch(() => null);
    if (bs === "in-world" || bs === "ready") { inWorld = true; break; }
    if (bs === "error") break;
    await sleep(1000);
  }
  if (!inWorld) { console.error("[walk] NOT in-world; abort"); try { await page.close(); } catch (_) {} process.exit(3); }

  const gpu = await page.evaluate(() => {
    try { const c = document.createElement("canvas"); const gl = c.getContext("webgl2") || c.getContext("webgl");
      const ext = gl.getExtension("WEBGL_debug_renderer_info"); return gl.getParameter(ext.UNMASKED_RENDERER_WEBGL); }
    catch (e) { return "ERR:" + e; }
  }).catch(() => "ERR");
  console.error(`[walk] UNMASKED_RENDERER = ${gpu}`);
  const realGpu = /NVIDIA|GTX|Direct3D/i.test(String(gpu));

  // install a per-frame observer that ATTRIBUTES big frames: on any frame >250ms,
  // snapshot what jumped across it — programs (shader compile), geometries/textures
  // (GPU upload), or neither (decode/GC/streaming). This tests the #12 premise.
  await page.evaluate(() => {
    if (window.__reapProbe) return;
    window.__reapProbe = { maxFrameMs: 0, longtasks: 0, bigFrames: [] };
    const info = () => {
      try {
        const rr = window.liveScene3d && window.liveScene3d.renderer;
        if (!rr || !rr.info) return { p: 0, g: 0, t: 0 };
        return { p: Array.isArray(rr.info.programs) ? rr.info.programs.length : 0,
                 g: rr.info.memory ? rr.info.memory.geometries : 0,
                 t: rr.info.memory ? rr.info.memory.textures : 0 };
      } catch (_) { return { p: 0, g: 0, t: 0 }; }
    };
    let last = performance.now();
    let prev = info();
    const loop = () => {
      const now = performance.now();
      const dt = now - last; last = now;
      if (dt > window.__reapProbe.maxFrameMs) window.__reapProbe.maxFrameMs = dt;
      if (dt > 250) {
        const cur = info();
        if (window.__reapProbe.bigFrames.length < 200) {
          window.__reapProbe.bigFrames.push({ dt: +dt.toFixed(0), dP: cur.p - prev.p, dG: cur.g - prev.g, dT: cur.t - prev.t });
        }
        prev = cur;
      } else { prev = info(); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    try {
      const po = new PerformanceObserver((l) => { window.__reapProbe.longtasks += l.getEntries().length; });
      po.observe({ entryTypes: ["longtask"] });
    } catch (_) {}
  }).catch(() => {});

  // wait for liveScene3d (late)
  for (let i = 0; i < 90; i++) {
    if (await page.evaluate(() => !!(window.liveScene3d && window.liveScene3d.scene)).catch(() => false)) break;
    await sleep(1000);
  }

  const chat = (c) => page.evaluate((cmd) => { try { window.__sessionHandle.sendChat(cmd); } catch (_) {} }, c).catch(() => {});

  // Compact in-page sampler: entity geometry + pose + residency.
  const sampleFn = () => {
    const ls = window.liveScene3d;
    const out = { t: Date.now() };
    try {
      const eg = ls && ls.entitiesGroup;
      if (eg && eg.children) {
        const geoms = new Set(), wcids = new Set(); let roots = 0, meshes = 0;
        for (const er of eg.children) { roots++;
          const w = er.userData && er.userData.modelId != null ? (er.userData.modelId >>> 0) : 0; wcids.add(w);
          er.traverse((o) => { if (o.isMesh || o.isInstancedMesh) { meshes++; if (o.geometry) geoms.add(o.geometry.uuid); } });
        }
        out.entRoots = roots; out.entMeshes = meshes; out.entGeoms = geoms.size; out.entWcids = wcids.size;
      }
    } catch (_) {}
    try {
      const rr = ls && ls.renderer;
      if (rr && rr.info && rr.info.memory) { out.riGeoms = rr.info.memory.geometries; out.riTex = rr.info.memory.textures; }
    } catch (_) {}
    // reap-spike telemetry: worst frame + longtask count since last sample
    try {
      const rp = window.__reapProbe;
      if (rp) { out.maxFrameMs = +rp.maxFrameMs.toFixed(1); out.lt = rp.longtasks; rp.maxFrameMs = 0; rp.longtasks = 0; }
    } catch (_) {}
    out.terr = ls && ls.terrainBakedLbs ? ls.terrainBakedLbs.size : null;
    try { const st = ls && ls.landblockLru && ls.landblockLru.getStats ? ls.landblockLru.getStats() : null; if (st) { out.lru = st.resident ?? null; out.liveGeom = st.liveGeom ?? null; } } catch (_) {}
    out.heapMB = performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null;
    try { const p = window.__sessionHandle.getLocalPlayerPose(); if (p) { out.lb = p.landblockId >>> 0; out.px = p.x; out.py = p.y; out.pz = p.z; if (p.free) p.free(); } } catch (_) {}
    return out;
  };

  // Teleport to the open start and settle.
  const cmd = `@teleloc ${START.cellHex} ${START.x} ${START.y} ${START.z} ${START.q.join(" ")}`;
  console.error(`[walk] teleport → ${START.name}`);
  await chat(cmd);
  await sleep(4000);
  // settle terrain
  let last = -1, stable = 0;
  for (let i = 0; i < 25; i++) { await sleep(1500);
    const t = await page.evaluate(() => window.liveScene3d?.terrainBakedLbs?.size ?? 0).catch(() => 0);
    if (t > 0 && t === last) { if (++stable >= 3) break; } else stable = 0; last = t;
  }
  const base = await page.evaluate(sampleFn);
  console.error(`[walk] baseline: lb=0x${(base.lb||0).toString(16)} terr=${base.terr} entGeoms=${base.entGeoms} entRoots=${base.entRoots}`);

  // Focus canvas so keyboard goes to the game, then HOLD w.
  try { await page.evaluate(() => { const c = document.querySelector("canvas"); if (c) c.focus(); const el = document.activeElement; if (el && el.blur && el.tagName === "INPUT") el.blur(); }); } catch (_) {}
  const samples = [base];
  const t0 = Date.now();
  await page.keyboard.down("w");
  let prevPx = base.px, prevPy = base.py, stuckCount = 0;
  while (Date.now() - t0 < RUN_S * 1000) {
    await sleep(SAMPLE_MS);
    await page.keyboard.down("w").catch(() => {}); // re-assert each tick
    const s = await page.evaluate(sampleFn).catch(() => null);
    if (s) {
      samples.push(s);
      // nudge-on-stuck: if planar progress < 1 m over a tick, turn briefly to
      // slip past whatever we hit, then resume forward.
      if (s.px != null && prevPx != null) {
        const step = Math.hypot(s.px - prevPx, s.py - prevPy);
        if (step < 1) {
          stuckCount++;
          const turn = stuckCount % 2 ? "d" : "a";
          await page.keyboard.up("w").catch(() => {});
          await page.keyboard.down(turn).catch(() => {});
          await sleep(220);
          await page.keyboard.up(turn).catch(() => {});
          await page.keyboard.down("w").catch(() => {});
        } else stuckCount = 0;
      }
      prevPx = s.px; prevPy = s.py;
    }
  }
  await page.keyboard.up("w").catch(() => {});
  const bigFrames = await page.evaluate(() => (window.__reapProbe && window.__reapProbe.bigFrames) || []).catch(() => []);

  // distance from start (planar), and distinct LBs visited
  const lbs = new Set();
  let dist = 0;
  const s0 = samples[0];
  for (const s of samples) { if (s.lb != null) lbs.add(s.lb); }
  const last2 = samples[samples.length - 1];
  const result = {
    generatedAtMs: Date.now(), gpu: String(gpu), realGpu, start: START.name,
    runS: RUN_S, sampleMs: SAMPLE_MS, nSamples: samples.length,
    lbsVisited: lbs.size,
    entGeomsStart: s0.entGeoms, entGeomsEnd: last2.entGeoms,
    entRootsStart: s0.entRoots, entRootsEnd: last2.entRoots,
    terrStart: s0.terr, terrEnd: last2.terr,
    riGeomsStart: s0.riGeoms, riGeomsEnd: last2.riGeoms,
    heapStart: s0.heapMB, heapEnd: last2.heapMB,
    bigFrames,
    samples,
  };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.error(`[walk] wrote ${OUT}: nSamples=${samples.length} lbsVisited=${lbs.size} entGeoms ${s0.entGeoms}->${last2.entGeoms} terr ${s0.terr}->${last2.terr}`);
  try { await page.close(); } catch (_) {} // close OUR page, NOT the browser
  process.exit(0);
})().catch((e) => { console.error("[walk] FATAL", e); process.exit(1); });
