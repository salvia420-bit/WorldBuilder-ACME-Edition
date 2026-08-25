// cloud-ab-1070.mjs — RUNS ON THE GTX 1070 (<user>@<gpu-box>). Headless, REAL GPU via ANGLE/D3D11.
//
// Steady-state cloud-cost A/B: holds scene quality at `mid` (the tier the 1070
// auto-resolves to — it is NOT on the GPU_HIGH allowlist), teleports to OUTDOOR
// Holtburg (clouds are skipped indoors), freezes the camera, then measures
// steady-state FPS + GPU for each cloud config in a FRESH browser per arm:
//
//   off      clouds omitted            (true baseline: overlay never constructed)
//   high     clouds=on                 (current default — resolutionScale 1, high preset)
//   medium   clouds=on cloudQuality=medium
//   low      clouds=on cloudQuality=low
//   halfres  clouds=on + runtime resolutionScale 0.5 (high preset, half-res raymarch)
//
// App via laptop reverse tunnel 127.0.0.1:18765 -> serve.py:8765; wsbridge over
// tailscale ws://<server-ip>:8080. Fresh browser per arm = no GPU state leak;
// we measure the STEADY-STATE window AFTER warm-up, so cold shader compile is
// excluded by design.
//
//   node C:\Temp\cloud-ab-1070.mjs
//
// Artifacts on the 1070:
//   C:\Temp\cloud-ab-report.json
//   C:\Temp\cloud-ab-<arm>.png   (one per arm)

import { chromium } from "playwright-core";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const EXE = "C:\\Users\\<user>\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe";
const OUT = "C:\\Temp";
const APP = "http://127.0.0.1:18765/apps/holtburger-web/index.html";
const COMMON = {
  renderer: "3d", quality: "mid",
  autoLogin: "1", account: "<test-account>", password: "<test-account>", autoSpawn: "first",
  renderDiag: "on",
  server_host: "127.0.0.1", server_port: "9000", bridge_url: "ws://<server-ip>:8080/",
};
const ARMS = [
  { key: "off",     label: "clouds OFF (baseline, mid)",          extra: {} },
  { key: "high",    label: "clouds ON - high (current default)",  extra: { clouds: "on" } },
  { key: "medium",  label: "clouds ON - medium preset",           extra: { clouds: "on", cloudQuality: "medium" } },
  { key: "low",     label: "clouds ON - low preset",              extra: { clouds: "on", cloudQuality: "low" } },
  { key: "halfres", label: "clouds ON - high @ resScale 0.5",     extra: { clouds: "on" }, resScale: 0.5 },
];

// arm filter + session-release gap (re-run path): node cloud-ab-1070.mjs --arms=high,low
const ARM_FILTER = (process.argv.find(a => a.startsWith("--arms=")) || "").slice(7).split(",").map(s => s.trim()).filter(Boolean);
const PRELOGIN_GAP_MS = 25000;  // let ACE release the prior session for the SAME account before re-login

const LOGIN_POLL_MS = 180000;
const TELE_POLL_MS  = 70000;
const SETTLE_MS     = 32000;   // let terrain + cloud noise bake plateau after going outdoors
const WARM_MS       = 12000;   // discard warm-up frames
const MEASURE_MS    = 28000;   // steady-state measurement window
const VIEWPORT = { width: 1600, height: 900 };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const pctile = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))].toFixed(1); };
const rng = a => a.length ? { min: +Math.min(...a).toFixed(1), max: +Math.max(...a).toFixed(1), avg: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) } : null;

function nvidiaSmi() {
  const r = spawnSync("nvidia-smi", ["--query-gpu=utilization.gpu,memory.used,temperature.gpu,power.draw", "--format=csv,noheader,nounits"], { encoding: "utf8", timeout: 12000 });
  const line = (r.stdout || "").trim().split("\n")[0] || "";
  const [util, memU, temp, pw] = line.split(",").map(s => parseFloat(s));
  return { util, memUsedMB: memU, tempC: temp, watts: pw };
}

const REPORT_PATH = `${OUT}\\cloud-ab-report.json`;
const report = { ts: new Date().toISOString(), host: "GTX1070", sceneQuality: "mid", app: APP, arms: [] };
// re-run merge: seed from an existing report so a partial re-run accumulates
if (existsSync(REPORT_PATH)) {
  try { const prev = JSON.parse(readFileSync(REPORT_PATH, "utf8")); if (Array.isArray(prev.arms)) report.arms = prev.arms; } catch (e) {}
}
function upsertArm(r) {
  const i = report.arms.findIndex(a => a.key === r.key);
  if (i >= 0) report.arms[i] = r; else report.arms.push(r);
  // keep canonical order
  const order = ARMS.map(a => a.key);
  report.arms.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
}

async function runArm(arm) {
  const q = new URLSearchParams({ ...COMMON, ...arm.extra });
  const url = `${APP}?${q.toString()}`;
  const out = { key: arm.key, label: arm.label, url };
  log("=".repeat(70));
  log(`ARM ${arm.key} — ${arm.label}`);
  log(`  pre-login gap ${PRELOGIN_GAP_MS / 1000}s (let ACE release prior ${COMMON.account} session) ...`);
  await sleep(PRELOGIN_GAP_MS);
  const browser = await chromium.launch({
    headless: true, executablePath: EXE,
    args: ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--use-gl=angle",
           "--disable-dev-shm-usage", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
  });
  const consoleBuf = [];
  try {
    const page = await (await browser.newContext({ viewport: VIEWPORT })).newPage();
    page.on("console", m => { if (consoleBuf.length < 400) consoleBuf.push(`${m.type()}: ${m.text()}`.slice(0, 240)); });
    page.on("pageerror", e => { consoleBuf.push(`pageerror: ${e.message}`.slice(0, 240)); });

    log(`goto ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // renderer string (assert real GPU)
    out.renderer = await page.evaluate(() => {
      try { const c = document.createElement("canvas"); const gl = c.getContext("webgl2") || c.getContext("webgl"); if (!gl) return "no-gl"; const d = gl.getExtension("WEBGL_debug_renderer_info"); return d ? String(gl.getParameter(d.UNMASKED_RENDERER_WEBGL)) : "no-ext"; } catch (e) { return "err:" + e.message; }
    }).catch(e => "err:" + e.message);
    log(`renderer: ${out.renderer}`);

    // gate in-world (reload once on an early connect-error transient)
    let t0 = Date.now(); let inWorld = false, last = null, reloaded = false;
    while (Date.now() - t0 < LOGIN_POLL_MS) {
      const s = await page.evaluate(() => {
        const h = window.__sessionHandle; let pose = null, cell = 0;
        try { if (h?.getLocalPlayerPose) { const p = h.getLocalPlayerPose(); if (p) pose = { x: +(+p.x).toFixed(1), y: +(+p.y).toFixed(1), z: +(+p.z).toFixed(1) }; } } catch (e) {}
        try { if (h?.getCurrentCellId) cell = h.getCurrentCellId() >>> 0; } catch (e) {}
        return { boot: window.__bootState || "none", pose, cell };
      }).catch(() => ({ boot: "evalerr" }));
      if (s.boot !== last) { log(`  boot=${s.boot} pose=${s.pose ? s.pose.x + "," + s.pose.y : "-"} cell=0x${(s.cell || 0).toString(16)}`); last = s.boot; }
      if (s.boot === "in-world" && s.pose && s.cell !== 0) { inWorld = true; out.spawnCell = "0x" + s.cell.toString(16); break; }
      // early connect-error transient (session race) → reload once, give ACE more time
      if (!reloaded && s.boot === "error" && (Date.now() - t0) < 55000) {
        log(`  boot=error early → waiting 20s + reload (session-release retry)`);
        await sleep(20000);
        try { await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }); } catch (e) {}
        reloaded = true; last = null; t0 = Date.now();
        continue;
      }
      await sleep(2500);
    }
    out.inWorld = inWorld;
    out.loginSec = +((Date.now() - t0) / 1000).toFixed(1);
    if (!inWorld) { log(`  !! did not reach in-world in ${out.loginSec}s`); out.consoleTail = consoleBuf.slice(-30); return out; }
    log(`  in-world in ${out.loginSec}s, cell ${out.spawnCell}`);

    // teleport outdoors (clouds skipped indoors). telepoi -> outdoor surface cell.
    await page.evaluate(() => { try { window.__sessionHandle?.sendChat?.("@telepoi Holtburg"); } catch (e) {} }).catch(() => {});
    const tt = Date.now(); let outdoor = false;
    while (Date.now() - tt < TELE_POLL_MS) {
      const c = await page.evaluate(() => { try { return (window.__sessionHandle?.getCurrentCellId?.() >>> 0) || 0; } catch (e) { return 0; } }).catch(() => 0);
      if (c && (c & 0xFFFF) < 0x0100) { outdoor = true; out.outdoorCell = "0x" + c.toString(16); break; }
      await sleep(2000);
    }
    out.outdoor = outdoor;
    log(outdoor ? `  outdoor cell ${out.outdoorCell}` : `  !! still indoor after telepoi (cloud cost may read low)`);

    // settle: terrain + one-time cloud noise bake
    log(`  settle ${SETTLE_MS / 1000}s ...`);
    await sleep(SETTLE_MS);

    // half-res arm: drive resolutionScale at runtime (no URL knob)
    if (arm.resScale != null) {
      const r = await page.evaluate((scale) => {
        try {
          const co = window.liveScene3d?.cloudOverlay; if (!co) return "no-overlay";
          const eff = co.volume?.effect; if (!eff) return "no-effect";
          eff.resolutionScale = scale;
          const cv = window.liveScene3d?.renderer?.domElement;
          if (cv) co.setSize(cv.width, cv.height);
          return "set " + eff.resolutionScale;
        } catch (e) { return "err:" + e.message; }
      }, arm.resScale).catch(e => "err:" + e.message);
      log(`  resScale -> ${r}`);
      await sleep(5000);
    }

    // read back the ACTUAL cloud config that this arm ran (proves what was measured)
    out.cloudConfig = await page.evaluate(() => {
      try {
        const co = window.liveScene3d?.cloudOverlay; if (!co) return { present: false };
        const eff = co.volume?.effect;
        const cl = eff?.clouds || {}, sh = eff?.shadow || {};
        return {
          present: true, frameCount: co.frameCount, lastError: co.lastError || null,
          resolutionScale: eff?.resolutionScale,
          coverage: eff?.clouds?.coverage,
          lightShafts: eff?.lightShafts, shapeDetail: eff?.shapeDetail, turbulence: eff?.turbulence,
          maxIterationCount: cl.maxIterationCount, multiScatteringOctaves: cl.multiScatteringOctaves,
          shadowCascades: sh.cascadeCount, shadowMap: sh.mapSize ? `${sh.mapSize.x}x${sh.mapSize.y}` : null,
        };
      } catch (e) { return { present: false, err: String(e.message) }; }
    }).catch(e => ({ present: false, err: String(e.message) }));
    log(`  cloudConfig: ${JSON.stringify(out.cloudConfig)}`);

    // freeze the follow camera so framing is identical across arms (player is stationary anyway)
    await page.evaluate(() => {
      try { const cs = window.liveScene3d?.cameraSwitcher; if (cs && typeof cs.tick === "function") { cs.__origTick = cs.tick; cs.tick = () => {}; } } catch (e) {}
    }).catch(() => {});

    // rAF probe + warm-up
    await page.evaluate(() => { window.__perf = { frames: [], last: null }; const l = () => { const n = performance.now(); if (window.__perf.last != null) window.__perf.frames.push(n - window.__perf.last); window.__perf.last = n; requestAnimationFrame(l); }; requestAnimationFrame(l); });
    log(`  warm ${WARM_MS / 1000}s ...`);
    await sleep(WARM_MS);

    // measure window
    await page.evaluate(() => { window.__perf.frames = []; });
    log(`  measure ${MEASURE_MS / 1000}s ...`);
    const gpu = [];
    const mEnd = Date.now() + MEASURE_MS;
    while (Date.now() < mEnd) { gpu.push(nvidiaSmi()); await sleep(3000); }
    const frames = await page.evaluate(() => window.__perf ? window.__perf.frames : []).catch(() => []);
    const dts = frames.filter(d => d > 0 && d < 8000);

    out.fps = dts.length ? +(1000 / (dts.reduce((a, b) => a + b, 0) / dts.length)).toFixed(1) : null;
    out.frameMs = { p50: pctile(dts, 50), p95: pctile(dts, 95), p99: pctile(dts, 99), worst: dts.length ? +Math.max(...dts).toFixed(1) : null };
    out.spikes = { gt33: dts.filter(d => d > 33).length, gt50: dts.filter(d => d > 50).length, total: dts.length };
    out.gpuUtilPct = rng(gpu.map(g => g.util).filter(Number.isFinite));
    out.gpuMemMB = rng(gpu.map(g => g.memUsedMB).filter(Number.isFinite));
    out.gpuTempC = rng(gpu.map(g => g.tempC).filter(Number.isFinite));
    out.gpuWatts = rng(gpu.map(g => g.watts).filter(Number.isFinite));
    // scene complexity (cumulative, reliable)
    out.scene = await page.evaluate(() => { try { const r = window.liveScene3d?.renderer; return r?.info ? { geometries: r.info.memory.geometries, textures: r.info.memory.textures, programs: r.info.programs?.length ?? null } : null; } catch (e) { return null; } }).catch(() => null);

    try { await page.screenshot({ path: `${OUT}\\cloud-ab-${arm.key}.png` }); log(`  saved cloud-ab-${arm.key}.png`); } catch (e) { log("  screenshot err:", e.message); }
    out.consoleTail = consoleBuf.slice(-15);

    log(`  >>> ${arm.key}: FPS ${out.fps}  p50 ${out.frameMs.p50}ms p95 ${out.frameMs.p95}ms worst ${out.frameMs.worst}ms  | GPU ${JSON.stringify(out.gpuUtilPct)}% ${JSON.stringify(out.gpuWatts)}W ${JSON.stringify(out.gpuTempC)}C`);
  } catch (e) {
    out.fatal = String(e && e.message || e);
    log(`  ARM FATAL: ${out.fatal}`);
    out.consoleTail = consoleBuf.slice(-30);
  } finally {
    try { await browser.close(); } catch (_) {}
    await sleep(2000); // let the GPU settle between arms
  }
  return out;
}

async function main() {
  const arms = ARM_FILTER.length ? ARMS.filter(a => ARM_FILTER.includes(a.key)) : ARMS;
  log(`cloud A/B on GTX 1070 (headless real GPU). arms: ${arms.map(a => a.key).join(", ")}`);
  for (const arm of arms) {
    const r = await runArm(arm);
    upsertArm(r);
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2)); // checkpoint after each arm
  }

  // summary table
  log("=".repeat(78));
  log("CLOUD A/B SUMMARY (GTX 1070, scene quality=mid, outdoor Holtburg, headless)");
  log("arm       fps    p50   p95   worst  >33ms  gpu%(avg/max)  watts(avg)  outdoor");
  const base = report.arms.find(a => a.key === "off");
  for (const a of report.arms) {
    const fps = a.fps ?? "-", p50 = a.frameMs?.p50 ?? "-", p95 = a.frameMs?.p95 ?? "-", worst = a.frameMs?.worst ?? "-";
    const sp = a.spikes ? `${a.spikes.gt33}/${a.spikes.total}` : "-";
    const gu = a.gpuUtilPct ? `${a.gpuUtilPct.avg}/${a.gpuUtilPct.max}` : "-";
    const gw = a.gpuWatts ? `${a.gpuWatts.avg}` : "-";
    log(`${a.key.padEnd(9)} ${String(fps).padEnd(6)} ${String(p50).padEnd(5)} ${String(p95).padEnd(5)} ${String(worst).padEnd(6)} ${sp.padEnd(6)} ${gu.padEnd(13)} ${String(gw).padEnd(10)} ${a.outdoor ? "y" : "N"}`);
  }
  if (base && base.fps) {
    log("-- deltas vs off baseline --");
    for (const a of report.arms) {
      if (a.key === "off" || !a.fps) continue;
      const dFps = +(a.fps - base.fps).toFixed(1);
      const dMs = +((1000 / a.fps) - (1000 / base.fps)).toFixed(2);
      log(`  ${a.key.padEnd(9)} dFPS ${dFps}   added ${dMs} ms/frame`);
    }
  }
  writeFileSync(`${OUT}\\cloud-ab-report.json`, JSON.stringify(report, null, 2));
  log(`report -> ${OUT}\\cloud-ab-report.json`);
  log("DONE");
}

main().catch(e => { log("TOP FATAL:", e?.stack?.slice(0, 500) || e); try { writeFileSync(`${OUT}\\cloud-ab-report.json`, JSON.stringify(report, null, 2)); } catch (_) {} }).finally(() => process.exit(0));
