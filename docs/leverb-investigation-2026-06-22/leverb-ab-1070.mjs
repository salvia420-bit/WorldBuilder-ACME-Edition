// leverb-ab-1070.mjs — GTX 1070 headless. A/B the Lever B fixes on the cold
// pvsRingRadius=10 fill: baseline vs Fix#1 (no-double-copy) vs Fix#2 (frame-budget
// bakes) vs both. Metric = worst-frame + long-frame counts (smoothness, Fix#2) and
// LB-bake throughput (Fix#1). Fresh browser per arm (cold), 45s session-release gap.
//
//   node C:\Temp\leverb-ab-1070.mjs
// Artifacts: C:\Temp\leverb-ab-report.json, C:\Temp\leverb-ab-<arm>.png

import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";

const EXE = "C:\\Users\\<user>\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe";
const OUT = "C:\\Temp";
const APP = "http://127.0.0.1:18765/apps/holtburger-web/index.html";
const COMMON = {
  renderer: "3d", quality: "high", pvsRingRadius: "10", clouds: "off",
  autoLogin: "1", account: "<test-account>", password: "<test-account>", autoSpawn: "first",
  renderDiag: "on", nosw: "1",
  server_host: "127.0.0.1", server_port: "9000", bridge_url: "ws://<server-ip>:8080/",
};
const ARMS = [
  { key: "baseline", extra: {} },
  { key: "fix1",     extra: { terrainNoDoubleCopy: "on" } },
  { key: "fix2",     extra: { pvsStreamStartsPerTick: "2" } },
  { key: "both",     extra: { terrainNoDoubleCopy: "on", pvsStreamStartsPerTick: "2" } },
];

const PRELOGIN_GAP_MS = 45000;
const LOGIN_POLL_MS = 180000;
const MEASURE_MS = 95000;   // capture the cold fill
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const pctile = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))].toFixed(1); };

const report = { ts: new Date().toISOString(), host: "GTX1070", scene: "quality=high pvsRingRadius=10 clouds=off", arms: [] };

async function runArm(arm) {
  const url = `${APP}?${new URLSearchParams({ ...COMMON, ...arm.extra }).toString()}`;
  const out = { key: arm.key, flags: arm.extra };
  log("=".repeat(64)); log(`ARM ${arm.key}  ${JSON.stringify(arm.extra)}`);
  log(`  pre-login gap ${PRELOGIN_GAP_MS / 1000}s ...`); await sleep(PRELOGIN_GAP_MS);
  const browser = await chromium.launch({ headless: true, executablePath: EXE, args: ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--use-gl=angle", "--disable-dev-shm-usage"] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const page = await ctx.newPage();
    const cons = [];
    page.on("console", m => { if (cons.length < 120) cons.push(`${m.type()}: ${m.text()}`.slice(0, 160)); });
    page.on("pageerror", e => cons.push("pageerror: " + e.message.slice(0, 160)));
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // confirm the flags actually parsed (look for the console echo)
    let t0 = Date.now(), inWorld = false, last = null, reloaded = false;
    while (Date.now() - t0 < LOGIN_POLL_MS) {
      const s = await page.evaluate(() => { const h = window.__sessionHandle; let c = 0, p = 0; try { c = h?.getCurrentCellId?.() >>> 0; } catch (e) {} try { p = h?.getLocalPlayerPose?.() ? 1 : 0; } catch (e) {} return { boot: window.__bootState || "none", c, p }; }).catch(() => ({ boot: "evalerr" }));
      if (s.boot !== last) { log(`  boot=${s.boot} cell=0x${(s.c || 0).toString(16)}`); last = s.boot; }
      if (s.boot === "in-world" && s.p && s.c) { inWorld = true; break; }
      if (!reloaded && s.boot === "error" && Date.now() - t0 < 55000) { log("  early error → reload"); await sleep(22000); try { await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }); } catch (e) {} reloaded = true; last = null; t0 = Date.now(); continue; }
      await sleep(2000);
    }
    out.inWorld = inWorld;
    if (!inWorld) { out.fail = "no in-world"; out.consoleTail = cons.slice(-20); return out; }

    // rAF dt probe + LB-baked counter, capture the fill
    await page.evaluate(() => { window.__perf = { f: [], last: null }; const l = () => { const n = performance.now(); if (window.__perf.last != null) window.__perf.f.push(n - window.__perf.last); window.__perf.last = n; requestAnimationFrame(l); }; requestAnimationFrame(l); });
    const baked0 = await page.evaluate(() => window.liveScene3d?.terrainBakedLbs?.size ?? 0).catch(() => 0);
    log(`  measure ${MEASURE_MS / 1000}s fill (baked0=${baked0}) ...`);
    await sleep(MEASURE_MS);
    const baked1 = await page.evaluate(() => window.liveScene3d?.terrainBakedLbs?.size ?? 0).catch(() => 0);
    const frames = await page.evaluate(() => window.__perf?.f ?? []).catch(() => []);
    // flag echo from console
    out.flagEcho = cons.filter(c => /terrainNoDoubleCopy|pvsStream/i.test(c)).slice(-4);
    out.errors = cons.filter(c => /pageerror|error:/i.test(c)).slice(-6);

    const dts = frames.filter(d => d > 0 && d < 30000);
    out.lbBaked = { start: baked0, end: baked1, delta: baked1 - baked0, perSec: +((baked1 - baked0) / (MEASURE_MS / 1000)).toFixed(2) };
    out.fps = dts.length ? +(1000 / (dts.reduce((a, b) => a + b, 0) / dts.length)).toFixed(1) : null;
    out.frameMs = { p50: pctile(dts, 50), p95: pctile(dts, 95), p99: pctile(dts, 99), worst: dts.length ? +Math.max(...dts).toFixed(0) : null };
    out.stalls = { gt33: dts.filter(d => d > 33).length, gt100: dts.filter(d => d > 100).length, gt250: dts.filter(d => d > 250).length, gt1000: dts.filter(d => d > 1000).length, total: dts.length };
    try { await page.screenshot({ path: `${OUT}\\leverb-ab-${arm.key}.png` }); } catch (e) {}
    log(`  >>> ${arm.key}: fps ${out.fps} p50 ${out.frameMs.p50} worst ${out.frameMs.worst}ms | stalls >100ms=${out.stalls.gt100} >250=${out.stalls.gt250} >1s=${out.stalls.gt1000} /${out.stalls.total} | LB ${out.lbBaked.delta} (${out.lbBaked.perSec}/s) | echo ${JSON.stringify(out.flagEcho)}`);
  } catch (e) {
    out.fatal = String(e?.message || e); log("  FATAL", out.fatal);
  } finally {
    try { await browser.close(); } catch (_) {}
  }
  return out;
}

async function main() {
  log("Lever B A/B — GTX 1070 (quality=high pvsRingRadius=10)");
  for (const arm of ARMS) { report.arms.push(await runArm(arm)); writeFileSync(`${OUT}\\leverb-ab-report.json`, JSON.stringify(report, null, 2)); }
  log("=".repeat(72));
  log("LEVER B A/B SUMMARY (cold r10 fill, high)");
  log("arm       fps   p50   worst   >100  >250  >1s   LB/s   total");
  for (const a of report.arms) {
    if (!a.frameMs) { log(`  ${a.key}: ${a.fail || a.fatal}`); continue; }
    log(`  ${a.key.padEnd(8)} ${String(a.fps).padEnd(5)} ${String(a.frameMs.p50).padEnd(5)} ${String(a.frameMs.worst).padEnd(7)} ${String(a.stalls.gt100).padEnd(5)} ${String(a.stalls.gt250).padEnd(5)} ${String(a.stalls.gt1000).padEnd(5)} ${String(a.lbBaked.perSec).padEnd(6)} ${a.stalls.total}`);
  }
  const b = report.arms.find(a => a.key === "baseline");
  if (b && b.frameMs) { log("-- vs baseline --"); for (const a of report.arms) { if (a.key === "baseline" || !a.frameMs) continue; log(`  ${a.key.padEnd(8)} worst ${b.frameMs.worst}→${a.frameMs.worst}ms  >100 ${b.stalls.gt100}→${a.stalls.gt100}  >1s ${b.stalls.gt1000}→${a.stalls.gt1000}  LB/s ${b.lbBaked.perSec}→${a.lbBaked.perSec}`); } }
  writeFileSync(`${OUT}\\leverb-ab-report.json`, JSON.stringify(report, null, 2));
  log("DONE");
}
main().catch(e => { log("TOP FATAL", e?.stack?.slice(0, 300) || e); try { writeFileSync(`${OUT}\\leverb-ab-report.json`, JSON.stringify(report, null, 2)); } catch (_) {} }).finally(() => process.exit(0));
