// hbprobe.mjs — single-boot ATTRIBUTION probe on the 1070 (not a timing arm).
// Reuses flag-bench's launch/kill/account discipline. Per run:
//   boot -> @teleloc Holtburg -> settle -> orbit warm-up -> settle ->
//   STILL 15s + MOVING 15s (frame stats, uninstrumented) ->
//   CENSUS 4s moving (renderBufferDirect wrapper: draws + CPU ms per category) ->
//   CPU PROFILE 10s moving (CDP Profiler, self + inclusive by function) ->
//   framePhase p0..p4 (if ?framePhase=on in flags) + scene census + GPU util.
// Usage: node hbprobe.mjs --label NAME [--quality mid] [--flags 'a=b&c=d'] [--out DIR]
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");

const BOX = "young@100.127.215.75";
const CDP = "http://127.0.0.1:9333";
const ACE_LOG = "/home/wbterminal/ace-server/Source/ACE.Server/bin/Release/net10.0/ACE_Log.txt";
const APP = "http://127.0.0.1:8765/apps/holtburger-web/index.html";
const HOLT = ["0xA9B40001", 96, 96, 80];

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const LABEL = opt("--label", "probe");
const QUALITY = opt("--quality", "mid");
const FLAGS = opt("--flags", "framePhase=on");
const WIN = opt("--window", "1280,720");
const NO_PROFILE = argv.includes("--no-profile");
const OUT = opt("--out", `/mnt/wbterminal1/tmp/claude-scratch/perf/hbprobe-${LABEL}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(OUT, { recursive: true });

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ssh = (cmd) => execFileSync("ssh", ["-o", "BatchMode=yes", BOX, cmd], { encoding: "utf8", timeout: 60000 });

function killBench() {
  try { ssh("powershell -NoProfile -ExecutionPolicy Bypass -File D:\\Temp\\hbbench\\hbbench-kill.ps1"); } catch (_) {}
}
async function launch(profile) {
  killBench();
  ssh(`echo ${profile}> D:\\Temp\\hbbench\\profile.txt`);
  ssh(`echo ${WIN}> D:\\Temp\\hbbench\\winsize.txt`);
  ssh('schtasks /create /tn hbprobe /tr "D:\\Temp\\hbbench\\hbprobe-launch.bat" /sc once /st 00:00 /it /f >nul & schtasks /run /tn hbprobe >nul');
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${CDP}/json/version`); if (r.ok) return; } catch (_) {}
    await sleep(1000);
  }
  throw new Error("CDP :9333 never came up");
}
function aceLogTail(bytes = 65536) {
  const size = statSync(ACE_LOG).size;
  const fd = openSync(ACE_LOG, "r");
  const buf = Buffer.alloc(Math.min(bytes, size));
  readSync(fd, buf, 0, buf.length, size - buf.length);
  closeSync(fd);
  return buf.toString("utf8");
}
async function waitAccountFree(maxMs = 120000) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    const ev = aceLogTail(262144).split("\n").filter((l) => /\[(LOGIN|LOGOUT)\] Account tailnet1 /.test(l));
    const last = ev[ev.length - 1];
    if (!last || /\[LOGOUT\]/.test(last)) return true;
    await sleep(2000);
  }
  return false;
}
async function waitAceLogout(sinceMs, maxMs = 90000) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    const lines = aceLogTail().split("\n").filter((l) => /\[LOGOUT\] Account tailnet1 exited/.test(l));
    const last = lines[lines.length - 1];
    if (last) { const ts = Date.parse(last.slice(0, 19).replace(" ", "T")); if (ts >= sinceMs - 2000) return true; }
    await sleep(2000);
  }
  return false;
}
// GPU util sampler on the box: self-terminating powershell loop.
function gpuSampler(seconds) {
  const n = Math.ceil(seconds * 2);
  const ps = `for($i=0;$i -lt ${n};$i++){nvidia-smi --query-gpu=utilization.gpu,clocks.gr,memory.used,power.draw --format=csv,noheader,nounits; Start-Sleep -Milliseconds 500}`;
  const p = spawn("ssh", ["-o", "BatchMode=yes", BOX, `powershell -NoProfile -Command "${ps}"`]);
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  return new Promise((res) => p.on("close", () => {
    const rows = out.trim().split(/\r?\n/).map((l) => l.split(",").map((x) => +x.trim())).filter((r) => r.length >= 4 && !isNaN(r[0]));
    const col = (i) => rows.map((r) => r[i]);
    const avg = (a) => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : null;
    res({ n: rows.length, utilAvg: avg(col(0)), utilMax: Math.max(...col(0)), clockAvg: avg(col(1)), memMB: avg(col(2)), powerW: avg(col(3)) });
  }));
}

// ---- page-side ----------------------------------------------------------------
const RECORD = async ({ ms, orbit }) => {
  const r = window.liveScene3d.renderer;
  const prevAuto = r.info.autoReset;
  r.info.autoReset = false;
  const c0 = r.info.render.calls, tr0 = r.info.render.triangles;
  const fp0 = window.__framePhase ? { ...window.__framePhase } : null;
  const dts = [];
  let last = null;
  const tStart = performance.now();
  let longTasks = 0, longTaskMs = 0, obs = null;
  try {
    obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) { longTasks++; longTaskMs += e.duration; } });
    obs.observe({ entryTypes: ["longtask"] });
  } catch (_) {}
  await new Promise((resolve) => {
    const tick = (now) => {
      if (last !== null) dts.push(now - last);
      last = now;
      if (orbit) window.__cam.orbit(orbit.x, orbit.y, orbit.z, orbit.dist, orbit.az + ((now - tStart) / 1000) * orbit.degPerSec, orbit.el);
      if (now - tStart >= ms) return resolve();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  try { obs?.disconnect(); } catch (_) {}
  const calls = r.info.render.calls - c0, tris = r.info.render.triangles - tr0;
  r.info.autoReset = prevAuto;
  const s = [...dts].sort((a, b) => a - b);
  const q = (p) => s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2) : null;
  const sum = dts.reduce((a, b) => a + b, 0);
  // 1% low = mean of the worst 1% frame times, as fps
  const worst = s.slice(Math.floor(s.length * 0.99));
  const low1 = worst.length ? +(1000 / (worst.reduce((a, b) => a + b, 0) / worst.length)).toFixed(1) : null;
  let phase = null;
  if (fp0 && window.__framePhase) {
    const f1 = window.__framePhase, nf = Math.max(1, f1.frames - fp0.frames);
    phase = {}; for (const k of ["p0", "p1", "p2", "p3", "p4"]) phase[k] = +((f1[k + "Ms"] - fp0[k + "Ms"]) / nf).toFixed(2);
  }
  return {
    frames: dts.length, fps: +(dts.length / (sum / 1000)).toFixed(1),
    p50: q(0.5), p95: q(0.95), p99: q(0.99), max: +(s[s.length - 1] || 0).toFixed(1), low1,
    mean: +(sum / Math.max(1, dts.length)).toFixed(2),
    hitch33: dts.filter((d) => d > 33.4).length, hitch50: dts.filter((d) => d > 50).length, hitch100: dts.filter((d) => d > 100).length,
    drawsPerFrame: +(calls / Math.max(1, dts.length)).toFixed(0),
    ktrisPerFrame: +(tris / Math.max(1, dts.length) / 1000).toFixed(0),
    longTasks, longTaskMs: Math.round(longTaskMs), phase,
  };
};

const CENSUS = async ({ ms, orbit }) => {
  const r = window.liveScene3d.renderer;
  const orig = r.renderBufferDirect;
  const cats = new Map();
  const nameOf = (o) => {
    let n = o, d = 0;
    while (n && !n.name && d < 5) { n = n.parent; d++; }
    const raw = (n && n.name) || "(anon)";
    return (d ? "^" + d + ":" : "") + raw.replace(/0x[0-9a-f]+/gi, "#").replace(/[0-9a-f]{6,}/gi, "#").replace(/\d+/g, "#");
  };
  let frames = 0, wrapMs = 0;
  r.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
    const rt = r.getRenderTarget();
    const pass = (camera?.isOrthographicCamera ? "ortho" : "persp") + ":" + (rt ? `${rt.width}x${rt.height}` : "screen");
    const key = pass + "|" + (object.isInstancedMesh ? "Inst" : object.isBatchedMesh ? "Batch" : object.isPoints ? "Pts" : object.isSprite ? "Sprite" : object.isLine ? "Line" : "Mesh") +
      "|" + nameOf(object) + "|" + (material?.type || "?");
    const a = performance.now();
    const ret = orig.call(this, camera, scene, geometry, material, object, group);
    const dt = performance.now() - a;
    let c = cats.get(key); if (!c) { c = { n: 0, ms: 0, inst: 0, objs: new Set() }; cats.set(key, c); }
    c.n++; c.ms += dt; c.objs.add(object.id);
    if (object.isInstancedMesh) c.inst += object.count;
    return ret;
  };
  const tStart = performance.now();
  await new Promise((resolve) => {
    const tick = (now) => {
      frames++;
      if (orbit) window.__cam.orbit(orbit.x, orbit.y, orbit.z, orbit.dist, orbit.az + ((now - tStart) / 1000) * orbit.degPerSec, orbit.el);
      if (now - tStart >= ms) return resolve();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  r.renderBufferDirect = orig;
  const rows = [...cats.entries()].map(([k, c]) => ({ k, perFrame: +(c.n / frames).toFixed(1), msPerFrame: +(c.ms / frames).toFixed(3), uniqObjs: c.objs.size, instPerFrame: Math.round(c.inst / frames) }))
    .sort((a, b) => b.msPerFrame - a.msPerFrame);
  const tot = rows.reduce((a, b) => ({ d: a.d + b.perFrame, m: a.m + b.msPerFrame }), { d: 0, m: 0 });
  return { frames, totalDrawsPerFrame: +tot.d.toFixed(0), totalSubmitMsPerFrame: +tot.m.toFixed(2), rows };
};

const SCENE = () => {
  const s = window.liveScene3d, r = s?.renderer, scene = s?.scene;
  const out = { geometries: r?.info?.memory?.geometries, textures: r?.info?.memory?.textures, programs: r?.info?.programs?.length,
    resident: window.__landblockLru?.entries?.size, parked: window.__landblockLru?.parkPool?.size, quality: window.__quality?.preset ?? window.__quality };
  try { out.heapMB = Math.round(performance.memory.usedJSHeapSize / 1048576); } catch (_) {}
  if (scene) {
    const t = {}; let nodes = 0, visMesh = 0, lights = 0;
    scene.traverse((o) => { nodes++; if (o.isLight) lights++; if (o.isMesh || o.isPoints || o.isLine || o.isSprite) { const k = (o.isInstancedMesh ? "Inst" : o.isBatchedMesh ? "Batch" : o.type); t[k] = (t[k] || 0) + 1; if (o.visible) visMesh++; } });
    out.sceneNodes = nodes; out.renderables = t; out.visibleRenderablesFlag = visMesh; out.lights = lights;
  }
  out.canvas = r ? { w: r.domElement.width, h: r.domElement.height, pr: r.getPixelRatio() } : null;
  return out;
};

function aggProfile(profile) {
  const nodes = new Map(); for (const n of profile.nodes) nodes.set(n.id, n);
  const parent = new Map(); for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const keyOf = (n) => { const cf = n.callFrame; const u = (cf.url || "").replace(/^.*\/apps\/holtburger-web\//, "").replace(/^https:\/\/cdn.jsdelivr.net\/npm\//, ""); return `${cf.functionName || "(anon)"} ${u}:${cf.lineNumber + 1}`; };
  const self = new Map(), incl = new Map();
  let total = 0;
  const { samples, timeDeltas } = profile;
  for (let i = 0; i < samples.length; i++) {
    const dt = (timeDeltas[i + 1] ?? timeDeltas[i]) / 1000; // ms
    total += dt;
    let id = samples[i];
    const n0 = nodes.get(id); const k0 = keyOf(n0);
    self.set(k0, (self.get(k0) || 0) + dt);
    const seen = new Set();
    while (id != null) { const n = nodes.get(id); const k = keyOf(n); if (!seen.has(k)) { seen.add(k); incl.set(k, (incl.get(k) || 0) + dt); } id = parent.get(id); }
  }
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ fn: k, ms: +v.toFixed(1), pct: +(100 * v / total).toFixed(1) }));
  return { totalMs: +total.toFixed(0), self: top(self, 60), incl: top(incl, 80) };
}

// ---- main -----------------------------------------------------------------------
const res = { label: LABEL, quality: QUALITY, flags: FLAGS, startedAt: new Date().toISOString() };
const url = `${APP}?autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first&nosw=1&camDebug=on&adaptiveRes=off&quality=${QUALITY}${FLAGS ? "&" + FLAGS : ""}`;
res.url = url;
res.accountFree = await waitAccountFree();
await launch(`hbb-probe-${LABEL}-${Date.now()}`);
const browser = await chromium.connectOverCDP(CDP);
const errors = [];
try {
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e?.message ?? e).slice(0, 300)));
  page.on("console", (m) => { if (m.type() === "error" || /fallback|\[perf|warn/i.test(m.text())) errors.push(m.type() + ": " + m.text().slice(0, 300)); });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  res.gpu = await page.evaluate(() => { const gl = document.createElement("canvas").getContext("webgl2"); const e = gl && gl.getExtension("WEBGL_debug_renderer_info"); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : "?"; });
  if (!/1070/.test(res.gpu)) throw new Error("not on 1070: " + res.gpu);
  res.wakeLock = await page.evaluate(async () => { try { window.__benchWake = await navigator.wakeLock.request("screen"); return "held"; } catch (e) { return "failed " + e; } });
  const bootT = Date.now();
  let ok = false;
  for (let i = 0; i < 150 && !ok; i++) {
    ok = await page.evaluate(() => !!window.liveScene3d && !!window.__sessionHandle && ((window.__bootStateHistory || []).some((s) => (s.state || s) === "ready") || window.__bootState === "ready")).catch(() => false);
    if (!ok) await sleep(1000);
  }
  res.bootMs = Date.now() - bootT;
  if (!ok) throw new Error("boot never ready");
  log("booted", res.bootMs);
  await sleep(5000);
  await page.evaluate((c) => window.__sessionHandle.sendChat(c), `@teleloc ${HOLT.join(" ")}`);
  await sleep(8000);
  const settle = async (quietMs = 12000, maxMs = 150000) => {
    const t = Date.now(); let last = null, since = Date.now();
    while (Date.now() - t < maxMs) {
      const cur = await page.evaluate(() => `${window.__landblockLru?.entries?.size}|${window.liveScene3d?.renderer?.info?.memory?.geometries}`).catch(() => null);
      if (cur !== last) { last = cur; since = Date.now(); } else if (Date.now() - since >= quietMs) return { ms: Date.now() - t, quiet: true, state: cur };
      await sleep(1000);
    }
    return { ms: Date.now() - t, quiet: false, state: last };
  };
  res.settle1 = await settle();
  log("settled", JSON.stringify(res.settle1));
  const pose = await page.evaluate(() => window.__cam.world());
  const orbit = { x: pose.x, y: pose.y, z: pose.z + 1.5, dist: 70, az: 45, el: 22, degPerSec: 12 };
  await page.evaluate((o) => window.__cam.orbit(o.x, o.y, o.z, o.dist, o.az, o.el), orbit);
  await page.evaluate(RECORD, { ms: 30000, orbit });
  await page.evaluate((o) => window.__cam.orbit(o.x, o.y, o.z, o.dist, o.az, o.el), orbit);
  res.settle2 = await settle(8000, 60000);
  writeFileSync(join(OUT, "still.png"), await page.screenshot({ timeout: 30000 }));
  res.scene = await page.evaluate(SCENE);
  log("scene", JSON.stringify(res.scene));
  const g1 = gpuSampler(14);
  res.still = await page.evaluate(RECORD, { ms: 15000, orbit: null });
  res.gpuStill = await g1;
  log("still", JSON.stringify(res.still), JSON.stringify(res.gpuStill));
  const g2 = gpuSampler(14);
  res.moving = await page.evaluate(RECORD, { ms: 15000, orbit });
  res.gpuMoving = await g2;
  log("moving", JSON.stringify(res.moving), JSON.stringify(res.gpuMoving));
  res.census = await page.evaluate(CENSUS, { ms: 4000, orbit });
  log("census draws/frame", res.census.totalDrawsPerFrame, "submit ms/frame", res.census.totalSubmitMsPerFrame);
  if (!NO_PROFILE) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 250 });
    await cdp.send("Profiler.start");
    const rec = await page.evaluate(RECORD, { ms: 10000, orbit });
    const { profile } = await cdp.send("Profiler.stop");
    res.profileWindow = rec;
    writeFileSync(join(OUT, "cpu.cpuprofile"), JSON.stringify(profile));
    res.profile = aggProfile(profile);
    log("profile total ms", res.profile.totalMs);
  }
  res.sceneEnd = await page.evaluate(SCENE);
} catch (e) {
  res.error = String(e?.stack ?? e);
  log("ERROR", res.error);
} finally {
  res.errors = errors.slice(0, 200);
  writeFileSync(join(OUT, "result.json"), JSON.stringify(res, null, 1));
  try { await browser.close(); } catch (_) {}
  const killedAt = Date.now();
  killBench();
  res.aceLogout = await waitAceLogout(killedAt);
  log("out", OUT);
  process.exit(0);
}
