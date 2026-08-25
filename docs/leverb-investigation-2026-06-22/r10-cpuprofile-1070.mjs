// r10-cpuprofile-1070.mjs — GTX 1070 headless. CPU-profiles the ?pvsRingRadius=10
// cold terrain fill and buckets self-time by subsystem to confirm Lever B's
// cost split (atlas build vs wasm decode/subdivide vs bakes vs shader/gl).
//
//   node C:\Temp\r10-cpuprofile-1070.mjs
// Artifacts: C:\Temp\r10-fill.cpuprofile, C:\Temp\r10-fill-buckets.json

import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";

const EXE = "C:\\Users\\<user>\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe";
const OUT = "C:\\Temp";
const APP = "http://127.0.0.1:18765/apps/holtburger-web/index.html";
const Q = new URLSearchParams({
  renderer: "3d", quality: "high", pvsRingRadius: "10", clouds: "off",
  autoLogin: "1", account: "<test-account>", password: "<test-account>", autoSpawn: "first",
  renderDiag: "on", nosw: "1",
  server_host: "127.0.0.1", server_port: "9000", bridge_url: "ws://<server-ip>:8080/",
});
const URL = `${APP}?${Q.toString()}`;
const PROFILE_MS = 140000;   // capture the whole r10 fill to plateau
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

// Bucket a V8 .cpuprofile by self-time (hitCount per node).
function bucketProfile(profile) {
  const byFn = new Map();         // functionName -> self hits
  const buckets = { wasm: 0, atlas: 0, wasmDecodeJs: 0, bake: 0, mesh_geom: 0, shaderGl: 0, gc: 0, idle: 0, other: 0 };
  let total = 0;
  for (const n of profile.nodes) {
    const h = n.hitCount || 0;
    total += h;
    const cf = n.callFrame || {};
    const fn = cf.functionName || "(anonymous)";
    const url = cf.url || "";
    byFn.set(fn, (byFn.get(fn) || 0) + h);
    const isWasm = url.startsWith("wasm://") || fn.startsWith("wasm-function") || fn.startsWith("wasm-to-js");
    const f = fn.toLowerCase();
    if (fn === "(idle)" || fn === "(program)") buckets.idle += h;          // (program)=native/GL driver mostly
    else if (isWasm) buckets.wasm += h;
    else if (/buildterrainatlas|atlas/.test(f)) buckets.atlas += h;
    else if (/subdividedlandblockmeshtogeometry|fetch_subdivided|decodesurface|surfacefrom/.test(f)) buckets.wasmDecodeJs += h;
    else if (/bake/.test(f)) buckets.bake += h;
    else if (/togeometry|buildgeometry|mergegeometr|computevertexnormals|setattribute|buffergeometry/.test(f)) buckets.mesh_geom += h;
    else if (/compileshader|linkprogram|getprogramparameter|useprogram|createprogram/.test(f)) buckets.shaderGl += h;
    else if (/gc|garbage|scavenge|markcompact/.test(f)) buckets.gc += h;
    else buckets.other += h;
  }
  const pct = (h) => total ? +(100 * h / total).toFixed(1) : 0;
  const top = [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([fn, h]) => ({ fn: fn.slice(0, 60), pct: pct(h), hits: h }));
  const bucketPct = {}; for (const k in buckets) bucketPct[k] = pct(buckets[k]);
  return { totalSamples: total, bucketPct, top };
}

async function main() {
  log("r10 cpuprofile — GTX 1070 (quality=high pvsRingRadius=10 clouds=off)");
  log("pre-login gap 45s ...");
  await sleep(45000);
  const browser = await chromium.launch({ headless: true, executablePath: EXE, args: ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--use-gl=angle", "--disable-dev-shm-usage"] });
  const out = { ts: new Date().toISOString(), url: URL, profileMs: PROFILE_MS };
  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const page = await ctx.newPage();
    const cons = [];
    page.on("console", m => { if (cons.length < 100) cons.push(m.text().slice(0, 160)); });
    const client = await ctx.newCDPSession(page);
    await client.send("Profiler.enable");
    await client.send("Profiler.setSamplingInterval", { interval: 1000 }); // 1ms

    log(`goto ${URL}`);
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });

    // gate in-world (fast; the heavy fill follows), reload once on early error
    let t0 = Date.now(), inWorld = false, last = null, reloaded = false;
    while (Date.now() - t0 < 180000) {
      const s = await page.evaluate(() => { const h = window.__sessionHandle; let c = 0, p = 0; try { c = h?.getCurrentCellId?.() >>> 0; } catch (e) {} try { p = h?.getLocalPlayerPose?.() ? 1 : 0; } catch (e) {} return { boot: window.__bootState || "none", c, p }; }).catch(() => ({ boot: "evalerr" }));
      if (s.boot !== last) { log(`  boot=${s.boot} cell=0x${(s.c || 0).toString(16)}`); last = s.boot; }
      if (s.boot === "in-world" && s.p && s.c) { inWorld = true; out.spawnCell = "0x" + s.c.toString(16); break; }
      if (!reloaded && s.boot === "error" && Date.now() - t0 < 55000) { log("  early error → reload"); await sleep(22000); try { await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }); } catch (e) {} reloaded = true; last = null; t0 = Date.now(); continue; }
      await sleep(2000);
    }
    out.inWorld = inWorld;
    if (!inWorld) { out.fail = "no in-world"; writeFileSync(`${OUT}\\r10-fill-buckets.json`, JSON.stringify(out, null, 2)); return; }

    // rAF fps probe + start CPU profile, then let the r10 fill run to plateau
    await page.evaluate(() => { window.__perf = { f: [], last: null }; const l = () => { const n = performance.now(); if (window.__perf.last != null) window.__perf.f.push(n - window.__perf.last); window.__perf.last = n; requestAnimationFrame(l); }; requestAnimationFrame(l); });
    log(`start CPU profile, capture ${PROFILE_MS / 1000}s of the r10 fill ...`);
    await client.send("Profiler.start");
    const tBaked0 = await page.evaluate(() => window.liveScene3d?.terrainBakedLbs?.size ?? 0).catch(() => 0);
    await sleep(PROFILE_MS);
    const { profile } = await client.send("Profiler.stop");
    const tBaked1 = await page.evaluate(() => window.liveScene3d?.terrainBakedLbs?.size ?? 0).catch(() => 0);
    const frames = await page.evaluate(() => window.__perf?.f ?? []).catch(() => []);
    const dts = frames.filter(d => d > 0 && d < 20000);
    out.lbBaked = { start: tBaked0, end: tBaked1, delta: tBaked1 - tBaked0 };
    out.fps = dts.length ? +(1000 / (dts.reduce((a, b) => a + b, 0) / dts.length)).toFixed(1) : null;
    out.worstFrameMs = dts.length ? +Math.max(...dts).toFixed(0) : null;

    writeFileSync(`${OUT}\\r10-fill.cpuprofile`, JSON.stringify(profile));
    const analysis = bucketProfile(profile);
    out.analysis = analysis;
    writeFileSync(`${OUT}\\r10-fill-buckets.json`, JSON.stringify(out, null, 2));

    log(`LBs baked during window: ${out.lbBaked.delta} (=> ${(PROFILE_MS / 1000 / Math.max(1, out.lbBaked.delta)).toFixed(2)}s/LB)  fps ${out.fps}  worst ${out.worstFrameMs}ms`);
    log(`BUCKETS (self-time %): ${JSON.stringify(analysis.bucketPct)}`);
    log("TOP self-time functions:");
    for (const t of analysis.top.slice(0, 18)) log(`  ${String(t.pct).padStart(5)}%  ${t.fn}`);
  } catch (e) {
    out.fatal = String(e?.stack?.slice(0, 400) || e); log("FATAL", out.fatal);
    try { writeFileSync(`${OUT}\\r10-fill-buckets.json`, JSON.stringify(out, null, 2)); } catch (_) {}
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}
main().finally(() => process.exit(0));
