// leverc-ab-1070.mjs — GTX 1070 headless. A/B the global logarithmicDepthBuffer
// (Lever C). logDepth exports gl_FragDepth on ~63/72 programs → disables early-Z/Hi-Z
// (per-pixel fill cost on every lit pixel + the ortho shadow pass). Question: does
// turning it OFF measurably cut GPU work / raise fps on the 1070, or is the scene
// CPU-bound (so early-Z buys ~0)? KEY METRIC = GPU power(W) + util at the same view:
// if logDepth=off lowers GPU work, the fill-rate cost is real (latent win); if fps +
// GPU work are unchanged, Lever C is a no-win like Lever B.
//
//   node C:\Temp\leverc-ab-1070.mjs
// Artifacts: C:\Temp\leverc-ab-report.json, C:\Temp\leverc-ab-<arm>.png

import { chromium } from "playwright-core";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const EXE = "C:\\Users\\<user>\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe";
const OUT = "C:\\Temp";
const APP = "http://127.0.0.1:18765/apps/holtburger-web/index.html";
const COMMON = {
  renderer: "3d", quality: "high", clouds: "off",
  autoLogin: "1", account: "<test-account>", password: "<test-account>", autoSpawn: "first",
  renderDiag: "on", nosw: "1",
  server_host: "127.0.0.1", server_port: "9000", bridge_url: "ws://<server-ip>:8080/",
};
// Run logdepth-off FIRST and -on twice (bracketing) to expose run-to-run drift in the
// GPU-power proxy — if off sits between two on runs, there's no real saving.
const ARMS = [
  { key: "on-1",  extra: {} },
  { key: "off",   extra: { logDepth: "off" } },
  { key: "on-2",  extra: {} },
];

const PRELOGIN_GAP_MS = 45000, LOGIN_POLL_MS = 180000, SETTLE_MS = 55000, WARM_MS = 10000, MEASURE_MS = 32000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const pctile = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))].toFixed(1); };
const rng = a => a.length ? { min: +Math.min(...a).toFixed(1), max: +Math.max(...a).toFixed(1), avg: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) } : null;
function nvsmi() { const r = spawnSync("nvidia-smi", ["--query-gpu=utilization.gpu,power.draw,temperature.gpu,clocks.sm", "--format=csv,noheader,nounits"], { encoding: "utf8", timeout: 12000 }); const [u, p, t, c] = ((r.stdout || "").trim().split("\n")[0] || "").split(",").map(s => parseFloat(s)); return { util: u, watts: p, tempC: t, smClock: c }; }

const report = { ts: new Date().toISOString(), host: "GTX1070", scene: "quality=high outdoor Holtburg, warm steady-state", arms: [] };

async function runArm(arm) {
  const url = `${APP}?${new URLSearchParams({ ...COMMON, ...arm.extra }).toString()}`;
  const out = { key: arm.key, flags: arm.extra };
  log("=".repeat(60)); log(`ARM ${arm.key} ${JSON.stringify(arm.extra)}`);
  log(`  gap ${PRELOGIN_GAP_MS / 1000}s ...`); await sleep(PRELOGIN_GAP_MS);
  const browser = await chromium.launch({ headless: true, executablePath: EXE, args: ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--use-gl=angle", "--disable-dev-shm-usage"] });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
    const cons = []; page.on("console", m => { if (cons.length < 80) cons.push(m.text().slice(0, 140)); });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    // confirm the capability actually flipped
    let t0 = Date.now(), iw = false, last = null, reloaded = false;
    while (Date.now() - t0 < LOGIN_POLL_MS) {
      const s = await page.evaluate(() => { const h = window.__sessionHandle; let c = 0, p = 0; try { c = h?.getCurrentCellId?.() >>> 0; } catch (e) {} try { p = h?.getLocalPlayerPose?.() ? 1 : 0; } catch (e) {} return { boot: window.__bootState || "none", c, p }; }).catch(() => ({ boot: "evalerr" }));
      if (s.boot !== last) { log(`  boot=${s.boot} cell=0x${(s.c || 0).toString(16)}`); last = s.boot; }
      if (s.boot === "in-world" && s.p && s.c) { iw = true; break; }
      if (!reloaded && s.boot === "error" && Date.now() - t0 < 55000) { log("  early error → reload"); await sleep(22000); try { await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }); } catch (e) {} reloaded = true; last = null; t0 = Date.now(); continue; }
      await sleep(2000);
    }
    out.inWorld = iw; if (!iw) { out.fail = "no in-world"; return out; }
    // verify the renderer capability
    out.logDepthActive = await page.evaluate(() => { try { return !!window.liveScene3d?.renderer?.capabilities?.logarithmicDepthBuffer; } catch (e) { return null; } }).catch(() => null);
    await page.evaluate(() => { try { window.__sessionHandle?.sendChat?.("@telepoi Holtburg"); } catch (e) {} });
    const tt = Date.now(); while (Date.now() - tt < 70000) { const c = await page.evaluate(() => { try { return window.__sessionHandle?.getCurrentCellId?.() >>> 0; } catch (e) { return 0; } }).catch(() => 0); if (c && (c & 0xffff) < 0x100) break; await sleep(2000); }
    log(`  logDepthActive=${out.logDepthActive}; settle ${SETTLE_MS / 1000}s ...`); await sleep(SETTLE_MS);
    await page.evaluate(() => { try { const cs = window.liveScene3d?.cameraSwitcher; if (cs && typeof cs.tick === "function") cs.tick = () => {}; } catch (e) {} });
    await page.evaluate(() => { window.__perf = { f: [], last: null }; const l = () => { const n = performance.now(); if (window.__perf.last != null) window.__perf.f.push(n - window.__perf.last); window.__perf.last = n; requestAnimationFrame(l); }; requestAnimationFrame(l); });
    await sleep(WARM_MS);
    await page.evaluate(() => { window.__perf.f = []; });
    log(`  measure ${MEASURE_MS / 1000}s ...`);
    const gpu = []; const end = Date.now() + MEASURE_MS; while (Date.now() < end) { gpu.push(nvsmi()); await sleep(2000); }
    const frames = await page.evaluate(() => window.__perf?.f ?? []).catch(() => []);
    const dts = frames.filter(d => d > 0 && d < 8000);
    out.fps = dts.length ? +(1000 / (dts.reduce((a, b) => a + b, 0) / dts.length)).toFixed(1) : null;
    out.frameMs = { p50: pctile(dts, 50), p95: pctile(dts, 95), worst: dts.length ? +Math.max(...dts).toFixed(0) : null };
    out.gpuUtil = rng(gpu.map(g => g.util).filter(Number.isFinite));
    out.gpuWatts = rng(gpu.map(g => g.watts).filter(Number.isFinite));
    out.gpuTempC = rng(gpu.map(g => g.tempC).filter(Number.isFinite));
    out.smClock = rng(gpu.map(g => g.smClock).filter(Number.isFinite));
    try { await page.screenshot({ path: `${OUT}\\leverc-ab-${arm.key}.png` }); } catch (e) {}
    log(`  >>> ${arm.key}: fps ${out.fps} p50 ${out.frameMs.p50} | GPU util ${JSON.stringify(out.gpuUtil)} watts ${JSON.stringify(out.gpuWatts)} smClk ${JSON.stringify(out.smClock)} logDepth=${out.logDepthActive}`);
  } catch (e) { out.fatal = String(e?.message || e); log("  FATAL", out.fatal); }
  finally { try { await browser.close(); } catch (_) {} }
  return out;
}

async function main() {
  log("Lever C A/B — GTX 1070 (logarithmicDepthBuffer on/off, quality=high warm)");
  for (const arm of ARMS) { report.arms.push(await runArm(arm)); writeFileSync(`${OUT}\\leverc-ab-report.json`, JSON.stringify(report, null, 2)); }
  log("=".repeat(64)); log("LEVER C A/B SUMMARY (warm outdoor, quality=high)");
  log("arm     fps    p50   gpuUtil(avg)  gpuW(avg)  smClk(avg)  logDepth");
  for (const a of report.arms) { if (!a.frameMs) { log(`  ${a.key}: ${a.fail || a.fatal}`); continue; } log(`  ${a.key.padEnd(6)} ${String(a.fps).padEnd(6)} ${String(a.frameMs.p50).padEnd(5)} ${String(a.gpuUtil?.avg).padEnd(13)} ${String(a.gpuWatts?.avg).padEnd(10)} ${String(a.smClock?.avg).padEnd(11)} ${a.logDepthActive}`); }
  const on = report.arms.filter(a => a.key.startsWith("on") && a.gpuWatts).map(a => a.gpuWatts.avg);
  const off = report.arms.find(a => a.key === "off");
  if (on.length && off?.gpuWatts) { const onAvg = on.reduce((x, y) => x + y, 0) / on.length; log(`-- power proxy: logDepth ON avg ${onAvg.toFixed(1)}W vs OFF ${off.gpuWatts.avg}W (Δ ${(onAvg - off.gpuWatts.avg).toFixed(1)}W); fps ON~${report.arms.filter(a=>a.key.startsWith("on")).map(a=>a.fps).join("/")} OFF ${off.fps}`); }
  writeFileSync(`${OUT}\\leverc-ab-report.json`, JSON.stringify(report, null, 2)); log("DONE");
}
main().catch(e => { log("TOP FATAL", e?.stack?.slice(0, 300) || e); try { writeFileSync(`${OUT}\\leverc-ab-report.json`, JSON.stringify(report, null, 2)); } catch (_) {} }).finally(() => process.exit(0));
