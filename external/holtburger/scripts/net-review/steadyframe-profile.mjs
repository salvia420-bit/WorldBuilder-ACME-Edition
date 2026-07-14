// steadyframe-profile.mjs — L2 (HANDOFF-perf-next-fps-levers): profile ONE settled
// in-town frame's phase breakdown on the 1070's real GPU. Connects to the off-screen
// CDP Chrome, autologins, @telepoi into a dense town, waits for streaming to go
// QUIESCENT (terrainBakedLbs stable + no big frames), then captures a CDP CPU profile
// over PROFILE_S seconds of steady frames and aggregates JS self-time by phase
// function. Also dumps window.__diag.vfxGauge (T_cpu whole-tick + T_gpu timer query)
// and renderer.info so the GPU side of the frame is on the record too.
//
// Measurement-only: touches NO product code (the per-frame tick is a delicate ordered
// function; a sampling profiler attributes ms to named phases without editing it).
//
// Usage: node steadyframe-profile.mjs [outJson] [profileS]
//   POI=Holtburg node steadyframe-profile.mjs   # override dense-town target
import fs from "node:fs";

const CDP_URL = "http://127.0.0.1:9333";
const SERVE = "http://127.0.0.1:8765/apps/holtburger-web/index.html";
const ACCOUNT = "tailnet1";
const OUT = process.argv[2] || "/mnt/wbterminal2/tmp/steadyframe-profile.json";
const PROFILE_S = Number(process.argv[3] || "5");
const POI = process.env.POI || "Cragstone";
const SAMPLE_INTERVAL_US = 200; // 5 kHz — sub-ms phase attribution over ~25k samples

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
  // vfxGauge + renderDiag on so the GPU/draw side is measured alongside the CPU profile.
  const q = new URLSearchParams({
    renderer: "3d", autoLogin: "1", account: ACCOUNT, password: ACCOUNT,
    autoSpawn: "first", nosw: "1", vfxGauge: "on", renderDiag: "on",
  });
  console.error(`[sf] query: ${q}`);
  await page.goto(`${SERVE}?${q}`, { timeout: 60000 });

  let inWorld = false;
  for (let i = 0; i < 240; i++) {
    const bs = await page.evaluate(() => window.__bootState).catch(() => null);
    if (bs === "in-world" || bs === "ready") { inWorld = true; break; }
    if (bs === "error") break;
    await sleep(1000);
  }
  if (!inWorld) { console.error("[sf] NOT in-world; abort"); try { await page.close(); } catch (_) {} process.exit(3); }

  const gpu = await page.evaluate(() => {
    try { const c = document.createElement("canvas"); const gl = c.getContext("webgl2") || c.getContext("webgl");
      const ext = gl.getExtension("WEBGL_debug_renderer_info"); return gl.getParameter(ext.UNMASKED_RENDERER_WEBGL); }
    catch (e) { return "ERR:" + e; }
  }).catch(() => "ERR");
  console.error(`[sf] UNMASKED_RENDERER = ${gpu}`);
  const realGpu = /NVIDIA|GTX|Direct3D/i.test(String(gpu));
  if (!realGpu) console.error("[sf] ⚠ NOT a real GPU — frame timing is meaningless on SwiftShader. Continuing for counts only.");

  // frame-gap observer: worst frame + longtasks since last reset → the quiescence gate.
  await page.evaluate(() => {
    if (window.__sfProbe) return;
    window.__sfProbe = { maxFrameMs: 0, frames: 0, longtasks: 0 };
    let last = performance.now();
    const loop = () => {
      const now = performance.now(); const dt = now - last; last = now;
      window.__sfProbe.frames++;
      if (dt > window.__sfProbe.maxFrameMs) window.__sfProbe.maxFrameMs = dt;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    try { const po = new PerformanceObserver((l) => { window.__sfProbe.longtasks += l.getEntries().length; });
      po.observe({ entryTypes: ["longtask"] }); } catch (_) {}
  }).catch(() => {});

  for (let i = 0; i < 90; i++) {
    if (await page.evaluate(() => !!(window.liveScene3d && window.liveScene3d.scene)).catch(() => false)) break;
    await sleep(1000);
  }

  const chat = (c) => page.evaluate((cmd) => { try { window.__sessionHandle.sendChat(cmd); } catch (_) {} }, c).catch(() => {});

  const sampleFn = () => {
    const ls = window.liveScene3d; const out = { t: Date.now() };
    try { const eg = ls && ls.entitiesGroup;
      if (eg && eg.children) { let roots = 0, meshes = 0;
        for (const er of eg.children) { roots++; er.traverse((o) => { if (o.isMesh || o.isInstancedMesh) meshes++; }); }
        out.entRoots = roots; out.entMeshes = meshes; } } catch (_) {}
    try { const rr = ls && ls.renderer;
      if (rr && rr.info) { out.riGeoms = rr.info.memory?.geometries; out.riTex = rr.info.memory?.textures;
        out.riCalls = rr.info.render?.calls; out.riTris = rr.info.render?.triangles;
        out.riPrograms = Array.isArray(rr.info.programs) ? rr.info.programs.length : null; } } catch (_) {}
    out.terr = ls && ls.terrainBakedLbs ? ls.terrainBakedLbs.size : null;
    out.heapMB = performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null;
    try { const p = window.__sessionHandle.getLocalPlayerPose(); if (p) { out.lb = p.landblockId >>> 0; out.px = p.x; out.py = p.y; out.pz = p.z; if (p.free) p.free(); } } catch (_) {}
    return out;
  };

  // ── Teleport into a dense town and settle. ─────────────────────────────────
  console.error(`[sf] @telepoi ${POI}`);
  await chat(`@telepoi ${POI}`);
  await sleep(4000);
  // settle: terrainBakedLbs stable 3× AND no big frame in the last 2s.
  let last = -1, stable = 0;
  for (let i = 0; i < 30; i++) {
    await sleep(1500);
    const t = await page.evaluate(() => window.liveScene3d?.terrainBakedLbs?.size ?? 0).catch(() => 0);
    if (t > 0 && t === last) { if (++stable >= 3) break; } else stable = 0;
    last = t;
  }
  // quiescence confirm: reset the frame-gap probe, wait 2s, require maxFrameMs modest.
  await page.evaluate(() => { if (window.__sfProbe) { window.__sfProbe.maxFrameMs = 0; window.__sfProbe.longtasks = 0; } });
  await sleep(2000);
  const preQuiesce = await page.evaluate(() => ({ ...window.__sfProbe })).catch(() => ({}));
  const base = await page.evaluate(sampleFn);
  console.error(`[sf] settled: lb=0x${(base.lb || 0).toString(16)} terr=${base.terr} entRoots=${base.entRoots} riCalls=${base.riCalls} maxFrameMs(2s)=${preQuiesce.maxFrameMs?.toFixed?.(1)}`);
  if (base.entRoots != null && base.entRoots < 8)
    console.error(`[sf] ⚠ only ${base.entRoots} entity roots — town may be sparse; consider POID override.`);

  // ── Capture the CPU profile over steady frames. ────────────────────────────
  const client = await ctx.newCDPSession(page);
  await client.send("Profiler.enable");
  await client.send("Profiler.setSamplingInterval", { interval: SAMPLE_INTERVAL_US });
  console.error(`[sf] profiling ${PROFILE_S}s of steady frames @ ${SAMPLE_INTERVAL_US}us…`);
  await page.evaluate(() => { if (window.__sfProbe) { window.__sfProbe.maxFrameMs = 0; window.__sfProbe.frames = 0; window.__sfProbe.longtasks = 0; } });
  await client.send("Profiler.start");
  await sleep(PROFILE_S * 1000);
  const { profile } = await client.send("Profiler.stop");
  const postProbe = await page.evaluate(() => ({ ...window.__sfProbe })).catch(() => ({}));

  // vfxGauge (T_cpu whole-tick + T_gpu) + renderDiag + final counts.
  const diag = await page.evaluate(() => {
    const d = window.__diag || {};
    const pick = (o) => { try { return JSON.parse(JSON.stringify(o)); } catch (_) { return null; } };
    return { vfxGauge: pick(d.vfxGauge), render: pick(d.render) };
  }).catch(() => ({}));
  const post = await page.evaluate(sampleFn).catch(() => null);

  // ── Aggregate self-time by function (hitCount × interval). ─────────────────
  const nodes = profile.nodes || [];
  const agg = new Map(); // key → { fn, url, line, hits }
  let totalHits = 0;
  for (const n of nodes) {
    const hc = n.hitCount || 0; if (!hc) continue;
    totalHits += hc;
    const cf = n.callFrame || {};
    let fn = cf.functionName || "(anonymous)";
    let url = cf.url || "";
    if (url === "" && fn === "(anonymous)") fn = "(program)"; // GC/VM/native root
    const shortUrl = url.replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "");
    const key = `${fn}@@${shortUrl}:${cf.lineNumber ?? -1}`;
    const e = agg.get(key) || { fn, url: shortUrl, line: cf.lineNumber ?? -1, hits: 0 };
    e.hits += hc; agg.set(key, e);
  }
  const usPerHit = SAMPLE_INTERVAL_US;
  const durationMs = (profile.endTime - profile.startTime) / 1000;
  const rows = [...agg.values()]
    .map((e) => ({ fn: e.fn, loc: `${e.url}:${e.line}`, selfMs: +(e.hits * usPerHit / 1000).toFixed(1), pct: +(100 * e.hits / totalHits).toFixed(1) }))
    .sort((a, b) => b.selfMs - a.selfMs);
  const top = rows.slice(0, 40);

  // Bucket by url class for a coarse render-vs-sim split.
  const buckets = {};
  for (const e of agg.values()) {
    let b = "other";
    if (/three\.module|three\.core|WebGLRenderer/i.test(e.url)) b = "three-render";
    else if (/loop\.js/.test(e.url)) b = "loop-tick";
    else if (/entities\.js/.test(e.url)) b = "entities";
    else if (/statics|static_atlas|buildings/.test(e.url)) b = "statics";
    else if (/nameplate|hud|overlay/i.test(e.url)) b = "nameplate-hud";
    else if (/particle/i.test(e.url)) b = "particles";
    else if (/holtburger_web|wasm/.test(e.url)) b = "wasm";
    else if (e.url === "" ) b = "native/gc/vm";
    buckets[b] = (buckets[b] || 0) + e.hits;
  }
  const bucketRows = Object.entries(buckets)
    .map(([k, hits]) => ({ bucket: k, selfMs: +(hits * usPerHit / 1000).toFixed(1), pct: +(100 * hits / totalHits).toFixed(1) }))
    .sort((a, b) => b.selfMs - a.selfMs);

  const framesInProfile = postProbe.frames || 0;
  const result = {
    generatedAtMs: Date.now(), gpu: String(gpu), realGpu, poi: POI,
    settledLb: base.lb ? "0x" + base.lb.toString(16) : null,
    terr: base.terr, entRoots: base.entRoots, entMeshes: base.entMeshes,
    riCalls: base.riCalls, riTris: base.riTris, riGeoms: base.riGeoms, riTex: base.riTex, riPrograms: base.riPrograms,
    heapMB: base.heapMB,
    postProfileCounts: post ? { riCalls: post.riCalls, riTris: post.riTris, entRoots: post.entRoots, terr: post.terr, heapMB: post.heapMB } : null,
    profileS: PROFILE_S, sampleIntervalUs: SAMPLE_INTERVAL_US, profileDurationMs: +durationMs.toFixed(0),
    framesInProfile, avgFrameMs: framesInProfile ? +(durationMs / framesInProfile).toFixed(2) : null,
    maxFrameMsInProfile: +(postProbe.maxFrameMs || 0).toFixed(1), longtasksInProfile: postProbe.longtasks || 0,
    quiesce2s: { maxFrameMs: +(preQuiesce.maxFrameMs || 0).toFixed(1), longtasks: preQuiesce.longtasks || 0 },
    vfxGauge: diag.vfxGauge, renderDiag: diag.render,
    totalSamples: totalHits,
    bucketsBySelfMs: bucketRows,
    topFunctionsBySelfMs: top,
  };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  // Also dump a compact human table to stderr.
  console.error(`\n[sf] === settled ${POI} (${result.settledLb}) — ${framesInProfile} frames over ${result.profileDurationMs}ms, avg ${result.avgFrameMs}ms/frame, worst ${result.maxFrameMsInProfile}ms ===`);
  console.error(`[sf] riCalls=${base.riCalls} riTris=${base.riTris} entRoots=${base.entRoots} heap=${base.heapMB}MB  vfxGauge=${JSON.stringify(diag.vfxGauge)}`);
  console.error(`[sf] --- self-time by bucket ---`);
  for (const b of bucketRows) console.error(`[sf]   ${String(b.selfMs).padStart(7)}ms ${String(b.pct).padStart(5)}%  ${b.bucket}`);
  console.error(`[sf] --- top 20 functions by self-time ---`);
  for (const r of top.slice(0, 20)) console.error(`[sf]   ${String(r.selfMs).padStart(7)}ms ${String(r.pct).padStart(5)}%  ${r.fn}  (${r.loc})`);
  console.error(`[sf] wrote ${OUT}`);
  try { await client.detach(); } catch (_) {}
  try { await page.close(); } catch (_) {} // close OUR page, NOT the browser
  process.exit(0);
})().catch((e) => { console.error("[sf] FATAL", e); process.exit(1); });
