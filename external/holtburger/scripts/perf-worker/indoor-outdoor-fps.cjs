#!/usr/bin/env node
// indoor-outdoor-fps.cjs — 1070 (MODE2i CDP :9333) FPS protocol for the
// 2026-08-01 draw-distance task: settled FPS inside the Holtburg meeting hall
// vs a pinned outdoor Holtburg pose, per URL arm (e.g. pvsRingRadius sweeps).
//
// Prereqs (laptop side):
//   ssh -fN -L 9333:127.0.0.1:9333 -R 7080:127.0.0.1:8765 -R 8080:127.0.0.1:8080 young@100.127.215.75
//   box chrome via schtasks + C:\Temp\launch-wls.bat (muted, off-screen, CDP 9333)
// Usage:
//   node indoor-outdoor-fps.cjs --label ring5                 # bare defaults
//   node indoor-outdoor-fps.cjs --label ring3 --extra "pvsRingRadius=3"
// Output: one JSON line per phase + a final summary JSON on stdout.
//
// Notes bound to memory/runbook rules: ?nosw=1 mandatory; wait
// __bootState==='ready' (NOT 'in-world') before __sessionHandle/__set* use;
// first @tele of a session can be silently swallowed → re-send once if the
// landblock didn't change; accounts single-login (25s gap).

const path = require("path");
const fs = require("fs");

function resolvePlaywright() {
  const roots = [
    ...(() => { try { return fs.readdirSync(path.join(process.env.HOME, ".npm/_npx")).map(d => path.join(process.env.HOME, ".npm/_npx", d, "node_modules/playwright-core")); } catch { return []; } })(),
    path.join(process.env.HOME, "node_modules/playwright-core"),
  ];
  for (const r of roots) { try { return require(r); } catch { /* next */ } }
  throw new Error("playwright-core not found under ~/.npm/_npx/*/node_modules — npx playwright-core once, or npm i playwright-core");
}

const args = process.argv.slice(2);
function argOf(name, dflt) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; }
const LABEL = argOf("--label", "arm");
const EXTRA = argOf("--extra", "");
const ACCOUNT = argOf("--account", "smoketest1");
const CDP = argOf("--cdp", "http://127.0.0.1:9333");
const APP = argOf("--app", "http://127.0.0.1:7080/apps/holtburger-web/index.html");
const MEASURE_SEC = Number(argOf("--measure-sec", "15"));
const INDOOR = argOf("--indoor", "0xA9B40127 54.14 136.12 66.005"); // Holtburg meeting-hall cell (Ealdred)
const OUTDOOR_POI = argOf("--outdoor-poi", "Holtburg");
const SETTLE_TIMEOUT_S = Number(argOf("--settle-timeout", "300"));

function log(o) { console.log(JSON.stringify({ t: new Date().toISOString(), label: LABEL, ...o })); }

(async () => {
  const { chromium } = resolvePlaywright();
  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  const page = await ctx.newPage();
  page.setDefaultTimeout(120000);

  const q = [
    "nosw=1", "autoLogin=1", `account=${ACCOUNT}`, `password=${ACCOUNT}`,
    "autoSpawn=first", "renderer=3d",
  ].concat(EXTRA ? [EXTRA] : []).join("&");
  const url = `${APP}?${q}`;
  log({ phase: "goto", url });
  await page.goto(url, { waitUntil: "domcontentloaded" });

  // Real-GPU assertion — refuse to measure SwiftShader.
  const gpu = await page.evaluate(() => {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") || c.getContext("webgl");
    const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "no-gl";
  });
  log({ phase: "gpu", gpu });
  if (!/1070/.test(String(gpu))) throw new Error(`not the 1070 GPU: ${gpu}`);

  // Boot to 'ready' (helpers attach AFTER 'in-world').
  await page.waitForFunction(() => window.__bootState === "ready", null, { timeout: 300000, polling: 2000 });
  log({ phase: "ready" });
  await page.waitForTimeout(30000); // first-tele-swallowed guard: give the session time

  async function chat(cmd) { await page.evaluate((c) => window.__sessionHandle.sendChat(c), cmd); }
  async function lbId() { return page.evaluate(() => window.__diag?.pose?.().landblockId ?? window.__sessionHandle?.pose?.().landblockId ?? null); }

  async function teleport(cmd) {
    const before = await lbId();
    await chat(cmd);
    await page.waitForTimeout(8000);
    if ((await lbId()) === before) { log({ phase: "tele-resend", cmd }); await chat(cmd); await page.waitForTimeout(8000); }
    log({ phase: "teleported", cmd, lb: await lbId() });
  }

  // Settle: LRU + bake quiescent — resident/parked stable and no rAF-frame
  // spikes for 3 consecutive 10 s windows (or SETTLE_TIMEOUT_S cap).
  async function settle(tag) {
    const t0 = Date.now();
    let last = "", stable = 0;
    while ((Date.now() - t0) / 1000 < SETTLE_TIMEOUT_S && stable < 3) {
      await page.waitForTimeout(10000);
      const snap = await page.evaluate(() => {
        const s = window.__landblockLru?.getStats?.() ?? {};
        return JSON.stringify({ r: s.resident, p: s.parked, b: s.parkedBytes });
      });
      stable = snap === last ? stable + 1 : 0;
      last = snap;
      log({ phase: "settling", tag, snap, stable });
    }
    log({ phase: "settled", tag, sec: Math.round((Date.now() - t0) / 1000) });
  }

  // FPS: rAF count over MEASURE_SEC + frame-time percentiles.
  async function fps(tag) {
    const r = await page.evaluate(async (sec) => {
      const times = [];
      let prev = performance.now();
      await new Promise((done) => {
        const t0 = performance.now();
        function tick(t) { times.push(t - prev); prev = t; (t - t0) / 1000 >= sec ? done() : requestAnimationFrame(tick); }
        requestAnimationFrame(tick);
      });
      times.shift();
      const sorted = [...times].sort((a, b) => a - b);
      const pc = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
      return { frames: times.length, fps: times.length / sec, p50: pc(0.5), p95: pc(0.95), p99: pc(0.99), worst: sorted[sorted.length - 1] };
    }, MEASURE_SEC);
    const info = await page.evaluate(() => {
      const ls = window.liveScene3d; const ri = ls?.renderer?.info;
      return ri ? { calls: ri.render.calls, tris: ri.render.triangles, geoms: ri.memory.geometries, tex: ri.memory.textures } : null;
    });
    log({ phase: "fps", tag, ...r, rendererInfo: info });
    return r;
  }

  await teleport(`@teleloc ${INDOOR}`);
  await settle("indoor");
  const indoor = await fps("indoor");

  await teleport(`@telepoi ${OUTDOOR_POI}`);
  await settle("outdoor");
  const outdoor = await fps("outdoor");

  log({ phase: "summary", extra: EXTRA, indoorFps: indoor.fps, outdoorFps: outdoor.fps, ratio: outdoor.fps / indoor.fps });
  await page.close(); // page only — NEVER browser.close() (shared interactive-session chrome)
  process.exit(0);
})().catch((e) => { log({ phase: "error", error: String(e) }); process.exit(1); });
