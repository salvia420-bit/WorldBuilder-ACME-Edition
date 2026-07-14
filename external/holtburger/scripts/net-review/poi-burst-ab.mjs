// poi-burst-ab.mjs (#20 A/B) — deterministic telepoi-jump upload-burst stressor.
// Each @telepoi evicts the old ring and re-streams a new town = a worst-case
// geometry/texture UPLOAD burst (the +100..+417 geoms/frame the task12
// attribution flagged). Same POI sequence every run → PAIRED arms, unlike the
// nondeterministic held-W corridor walk (which gets stuck headless).
//
// Usage: node poi-burst-ab.mjs <outJson> [dwellS]
//   env WALK_QUERY="uploadThrottle=on" (etc.) for the B arm.
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pw = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");

const CDP_URL = "http://127.0.0.1:9333";
const ACCOUNT = "tailnet1";
const OUT = process.argv[2] || "/mnt/wbterminal2/tmp/poi-burst.json";
const DWELL_S = Number(process.argv[3] || "14");
// Deterministic outdoor-town sequence (dense statics/buildings). Round-trips
// so each arm re-streams the SAME towns in the SAME order.
const POIS = ["Cragstone", "Rithwic", "Holtburg", "Arwic", "Eastham", "Cragstone", "Rithwic", "Holtburg"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await pw.chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  const page = await ctx.newPage();
  const q = new URLSearchParams({ renderer: "3d", autoLogin: "1", account: ACCOUNT, password: ACCOUNT, autoSpawn: "first", nosw: "1" });
  if (process.env.WALK_QUERY) for (const [k, v] of new URLSearchParams(process.env.WALK_QUERY)) q.set(k, v);
  console.error(`[poi-ab] query: ${q}`);
  await page.goto(`http://127.0.0.1:8765/apps/holtburger-web/index.html?${q}`, { timeout: 60000 });

  let inWorld = false;
  for (let i = 0; i < 240; i++) {
    const bs = await page.evaluate(() => window.__bootState).catch(() => null);
    if (bs === "in-world" || bs === "ready") { inWorld = true; break; }
    if (bs === "error") break;
    await sleep(1000);
  }
  if (!inWorld) { console.error("[poi-ab] NOT in-world; abort"); try { await page.close(); } catch (_) {} process.exit(3); }

  const gpu = await page.evaluate(() => { try { const c = document.createElement("canvas"); const gl = c.getContext("webgl2") || c.getContext("webgl"); const ext = gl.getExtension("WEBGL_debug_renderer_info"); return gl.getParameter(ext.UNMASKED_RENDERER_WEBGL); } catch (e) { return "ERR"; } }).catch(() => "ERR");
  console.error(`[poi-ab] UNMASKED_RENDERER = ${gpu}`);

  // Per-frame big-frame attribution (identical to walk-entgrowth).
  await page.evaluate(() => {
    if (window.__reapProbe) return;
    window.__reapProbe = { maxFrameMs: 0, longtasks: 0, bigFrames: [] };
    const info = () => { try { const rr = window.liveScene3d && window.liveScene3d.renderer; if (!rr || !rr.info) return { p: 0, g: 0, t: 0 }; return { p: Array.isArray(rr.info.programs) ? rr.info.programs.length : 0, g: rr.info.memory ? rr.info.memory.geometries : 0, t: rr.info.memory ? rr.info.memory.textures : 0 }; } catch (_) { return { p: 0, g: 0, t: 0 }; } };
    let last = performance.now(); let prev = info();
    const loop = () => { const now = performance.now(); const dt = now - last; last = now; if (dt > window.__reapProbe.maxFrameMs) window.__reapProbe.maxFrameMs = dt; if (dt > 250) { const cur = info(); if (window.__reapProbe.bigFrames.length < 400) window.__reapProbe.bigFrames.push({ dt: +dt.toFixed(0), dP: cur.p - prev.p, dG: cur.g - prev.g, dT: cur.t - prev.t }); prev = cur; } else prev = info(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    try { const po = new PerformanceObserver((l) => { window.__reapProbe.longtasks += l.getEntries().length; }); po.observe({ entryTypes: ["longtask"] }); } catch (_) {}
  }).catch(() => {});

  for (let i = 0; i < 90; i++) { if (await page.evaluate(() => !!(window.liveScene3d && window.liveScene3d.scene)).catch(() => false)) break; await sleep(1000); }

  const chat = (c) => page.evaluate((cmd) => { try { window.__sessionHandle.sendChat(cmd); } catch (_) {} }, c).catch(() => {});
  const sample = () => page.evaluate(() => {
    const ls = window.liveScene3d; const out = { t: Date.now() };
    try { const rr = ls && ls.renderer; if (rr && rr.info && rr.info.memory) { out.riGeoms = rr.info.memory.geometries; out.riTex = rr.info.memory.textures; } } catch (_) {}
    out.terr = ls && ls.terrainBakedLbs ? ls.terrainBakedLbs.size : null;
    try { const rp = window.__reapProbe; if (rp) { out.maxFrameMs = +rp.maxFrameMs.toFixed(1); out.lt = rp.longtasks; rp.maxFrameMs = 0; rp.longtasks = 0; } } catch (_) {}
    out.heapMB = performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null;
    try { const p = window.__sessionHandle.getLocalPlayerPose(); if (p) { out.lb = p.landblockId >>> 0; if (p.free) p.free(); } } catch (_) {}
    return out;
  }).catch(() => null);

  const samples = [];
  const visited = [];
  for (const poi of POIS) {
    console.error(`[poi-ab] @telepoi ${poi}`);
    await chat(`@telepoi ${poi}`);
    // Sample across the dwell so the burst frames land in bigFrames.
    const dwellStart = Date.now();
    let poiLb = null;
    while (Date.now() - dwellStart < DWELL_S * 1000) {
      await sleep(2000);
      const s = await sample();
      if (s) { s.poi = poi; samples.push(s); poiLb = s.lb; }
    }
    visited.push({ poi, lb: poiLb });
  }

  const bigFrames = await page.evaluate(() => (window.__reapProbe && window.__reapProbe.bigFrames) || []).catch(() => []);
  const throttleStats = await page.evaluate(() => { try { return window.__uploadThrottleStats ? window.__uploadThrottleStats() : null; } catch (_) { return null; } }).catch(() => null);
  console.error(`[poi-ab] uploadThrottle: ${JSON.stringify(throttleStats)}`);

  const result = { generatedAtMs: Date.now(), gpu: String(gpu), pois: POIS, dwellS: DWELL_S, visited, throttleStats, bigFrames, samples };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  const distinctLbs = new Set(visited.map((v) => v.lb).filter((x) => x != null)).size;
  console.error(`[poi-ab] wrote ${OUT}: pois=${POIS.length} distinctLbsLanded=${distinctLbs} bigFrames=${bigFrames.length}`);
  try { await page.close(); } catch (_) {}
  process.exit(0);
})().catch((e) => { console.error("[poi-ab] FATAL", e); process.exit(1); });
