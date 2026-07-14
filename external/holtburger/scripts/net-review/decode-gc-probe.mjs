// decode-gc-probe.mjs (#21) — attribute the worst no-p/g/t-change stall frames.
// Captures console for the bake-worker main-thread-fallback tell, runs a few
// telepoi re-streams (each forces a bulk evict + re-bake), and correlates the
// biggest no-upload (dG=0,dP=0) frames with texture DISPOSAL (dT<0 = bulk evict)
// vs any decode markers. Answers: GC/bulk-evict, synchronous wasm decode, or
// bake-worker main-thread fallback?
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pw = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const CDP_URL = "http://127.0.0.1:9333";
const ACCOUNT = "tailnet1";
const OUT = process.argv[2] || "/mnt/wbterminal2/tmp/decode-gc.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POIS = ["Cragstone", "Holtburg", "Rithwic", "Cragstone", "Arwic"];

(async () => {
  const browser = await pw.chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  const page = await ctx.newPage();
  const console_hits = { fallback: 0, worker: 0, decode: 0, samples: [] };
  page.on("console", (m) => {
    const t = m.text();
    if (/main-thread fallback/i.test(t)) { console_hits.fallback++; if (console_hits.samples.length < 20) console_hits.samples.push(t.slice(0, 160)); }
    if (/bake_worker/i.test(t) && console_hits.samples.length < 20) console_hits.samples.push(t.slice(0, 160));
    if (/bake_worker/i.test(t)) console_hits.worker++;
    if (/decode|triangulat/i.test(t)) console_hits.decode++;
  });
  const q = new URLSearchParams({ renderer: "3d", autoLogin: "1", account: ACCOUNT, password: ACCOUNT, autoSpawn: "first", nosw: "1" });
  await page.goto(`http://127.0.0.1:8765/apps/holtburger-web/index.html?${q}`, { timeout: 60000 });
  let inWorld = false;
  for (let i = 0; i < 240; i++) { const bs = await page.evaluate(() => window.__bootState).catch(() => null); if (bs === "in-world" || bs === "ready") { inWorld = true; break; } if (bs === "error") break; await sleep(1000); }
  if (!inWorld) { console.error("[decode-gc] NOT in-world; abort"); try { await page.close(); } catch (_) {} process.exit(3); }

  // bigFrame observer + bake-worker state read.
  await page.evaluate(() => {
    window.__reapProbe = { bigFrames: [] };
    const info = () => { try { const rr = window.liveScene3d?.renderer; if (!rr?.info) return { p: 0, g: 0, t: 0 }; return { p: Array.isArray(rr.info.programs) ? rr.info.programs.length : 0, g: rr.info.memory?.geometries || 0, t: rr.info.memory?.textures || 0 }; } catch (_) { return { p: 0, g: 0, t: 0 }; } };
    let last = performance.now(); let prev = info();
    const loop = () => { const now = performance.now(); const dt = now - last; last = now; if (dt > 250) { const cur = info(); if (window.__reapProbe.bigFrames.length < 300) window.__reapProbe.bigFrames.push({ dt: +dt.toFixed(0), dP: cur.p - prev.p, dG: cur.g - prev.g, dT: cur.t - prev.t }); prev = cur; } else prev = info(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }).catch(() => {});
  for (let i = 0; i < 60; i++) { if (await page.evaluate(() => !!window.liveScene3d?.scene).catch(() => false)) break; await sleep(1000); }

  const chat = (c) => page.evaluate((cmd) => { try { window.__sessionHandle.sendChat(cmd); } catch (_) {} }, c).catch(() => {});
  // Probe whether a bake worker is configured/active (best-effort; shape varies).
  const workerState = await page.evaluate(() => {
    const out = { hasBakeWorkerClient: false, bakeWorkerStats: null };
    try { out.bakeWorkerStats = window.__diag?.bakeWorkerStats ?? null; } catch (_) {}
    try { out.hasBakeWorkerClient = typeof window.getBakeWorkerClient === "function" || !!window.__bakeWorkerClient; } catch (_) {}
    return out;
  }).catch(() => null);

  for (const poi of POIS) { console.error(`[decode-gc] @telepoi ${poi}`); await chat(`@telepoi ${poi}`); await sleep(12000); }

  const bigFrames = await page.evaluate(() => window.__reapProbe?.bigFrames || []).catch(() => []);
  // Classify the no-upload frames.
  const noUpload = bigFrames.filter((f) => f.dG === 0 && f.dP === 0);
  const evictGc = noUpload.filter((f) => f.dT < 0); // texture disposal → bulk evict
  const pureNoChange = noUpload.filter((f) => f.dT === 0);
  const result = {
    generatedAtMs: Date.now(), console_hits, workerState,
    bigFramesTotal: bigFrames.length,
    noUploadFrames: noUpload.length,
    evictGcFrames: evictGc.length, evictGcWorstMs: Math.max(0, ...evictGc.map((f) => f.dt)),
    pureNoChangeFrames: pureNoChange.length, pureNoChangeWorstMs: Math.max(0, ...pureNoChange.map((f) => f.dt)),
    worstNoUpload: noUpload.sort((a, b) => b.dt - a.dt).slice(0, 6),
    bigFrames,
  };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.error(`[decode-gc] fallback-tells=${console_hits.fallback} worker-msgs=${console_hits.worker} | noUpload=${noUpload.length} evictGc=${evictGc.length} (worst ${result.evictGcWorstMs}ms) pureNoChange=${pureNoChange.length} (worst ${result.pureNoChangeWorstMs}ms)`);
  console.error(`[decode-gc] workerState: ${JSON.stringify(workerState)}`);
  try { await page.close(); } catch (_) {}
  process.exit(0);
})().catch((e) => { console.error("[decode-gc] FATAL", e); process.exit(1); });
