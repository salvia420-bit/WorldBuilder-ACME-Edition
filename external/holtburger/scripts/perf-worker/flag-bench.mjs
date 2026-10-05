// flag-bench.mjs — interleaved multi-arm frame-time A/B on the 1070 (real GPU).
//
// Each RUN launches a fresh-profile Chrome in the box's interactive session
// (schtasks /it -> box/hbbench-launch.bat; off-screen, muted), drives it over
// the CDP tunnel from the laptop, and measures one fixed scenario:
//
//   boot -> @teleloc Holtburg -> settle -> fixed ?camDebug orbit pose:
//     STILL  30 s  camera parked
//     MOVING 30 s  camera orbiting the same point at 12 deg/s
//     TOUR   ~55 s camera released, teleport 3 LB east and back (streaming hitches)
//
// Arms are interleaved (rep-major, arm order rotated each rep) so slow drift
// over the session lands on every arm equally — the 2026-08-06 lesson (boots
// drift; a warm shader cache flatters the second arm, hence fresh profiles).
//
// Pre-flight (see memory fleet-runbooks "MODE2i" + "THREE FORWARDS"):
//   ssh -o ExitOnForwardFailure=yes -fN -L 9333:127.0.0.1:9333 \
//       -R 8765:127.0.0.1:8765 -R 8080:127.0.0.1:8080 young@100.127.215.75
//   box/hbbench-{launch.bat,kill.ps1} copied to D:\Temp\hbbench\
//
// Usage: node flag-bench.mjs <arms.json> [--reps 3] [--out DIR] [--only a,b]
//   arms.json: [{ "name": "base", "quality": "mid", "flags": "" }, ...]
// Output: DIR/<arm>-r<rep>/{result.json,still.png,tour.png}, DIR/summary.json

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ||
  "/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");

const BOX = "young@100.127.215.75";
const CDP = "http://127.0.0.1:9333";
const ACE_LOG = "/home/wbterminal/ace-server/Source/ACE.Server/bin/Release/net10.0/ACE_Log.txt";
const APP = "http://127.0.0.1:8765/apps/holtburger-web/index.html";
const HOLT = ["0xA9B40001", 96, 96, 80];
const EAST = ["0xACB40001", 96, 96, 120];

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const arms = JSON.parse(readFileSync(argv[0], "utf8"));
const REPS = +opt("--reps", 3);
const only = opt("--only", null)?.split(",");
const OUT = opt("--out", `/mnt/wbterminal1/tmp/claude-scratch/perf/flagbench-${new Date().toISOString().replace(/[:.]/g, "-")}`);
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
  ssh('schtasks /create /tn hbbench /tr "D:\\Temp\\hbbench\\hbbench-launch.bat" /sc once /st 00:00 /it /f >nul & schtasks /run /tn hbbench >nul');
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${CDP}/json/version`); if (r.ok) return; } catch (_) {}
    await sleep(1000);
  }
  throw new Error("CDP :9333 never came up (tunnel down or Chrome failed to launch)");
}

// ACE drops the old session on its own clock; a login inside that window is
// "Account In Use". Wait for the LOGOUT line written after `sinceMs`.
function aceLogTail(bytes = 65536) {
  const size = statSync(ACE_LOG).size;
  const fd = openSync(ACE_LOG, "r");
  const buf = Buffer.alloc(Math.min(bytes, size));
  readSync(fd, buf, 0, buf.length, size - buf.length);
  closeSync(fd);
  return buf.toString("utf8");
}
async function waitAceLogout(sinceMs, maxMs = 90000) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    const lines = aceLogTail().split("\n").filter((l) => /\[LOGOUT\] Account tailnet1 exited/.test(l));
    const last = lines[lines.length - 1];
    if (last) {
      const ts = Date.parse(last.slice(0, 19).replace(" ", "T"));
      if (ts >= sinceMs - 2000) return true;
    }
    await sleep(2000);
  }
  return false;
}

// The account is free when its most recent LOGIN line has a LOGOUT after it.
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

// ---- page-side helpers -------------------------------------------------------
const RECORD = async ({ ms, orbit }) => {
  const r = window.liveScene3d.renderer;
  const prevAuto = r.info.autoReset;
  r.info.autoReset = false;
  const c0 = r.info.render.calls, tr0 = r.info.render.triangles;
  const dts = [];
  let last = null, az = orbit ? orbit.az : 0;
  const tStart = performance.now();
  let longTasks = 0, longTaskMs = 0;
  let obs = null;
  try {
    obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) { longTasks++; longTaskMs += e.duration; } });
    obs.observe({ entryTypes: ["longtask"] });
  } catch (_) {}
  await new Promise((resolve) => {
    const tick = (now) => {
      if (last !== null) dts.push(now - last);
      last = now;
      if (orbit) {
        az = orbit.az + ((now - tStart) / 1000) * orbit.degPerSec;
        window.__cam.orbit(orbit.x, orbit.y, orbit.z, orbit.dist, az, orbit.el);
      }
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
  return {
    frames: dts.length, fps: +(dts.length / (sum / 1000)).toFixed(1),
    p50: q(0.5), p95: q(0.95), p99: q(0.99), max: +(s[s.length - 1] || 0).toFixed(1),
    mean: +(sum / Math.max(1, dts.length)).toFixed(2),
    hitch50: dts.filter((d) => d > 50).length, hitch100: dts.filter((d) => d > 100).length,
    drawsPerFrame: +(calls / Math.max(1, dts.length)).toFixed(0),
    ktrisPerFrame: +(tris / Math.max(1, dts.length) / 1000).toFixed(0),
    longTasks, longTaskMs: Math.round(longTaskMs),
  };
};

const SNAPSHOT = () => {
  const s = window.liveScene3d, r = s?.renderer;
  const out = {
    geometries: r?.info?.memory?.geometries, textures: r?.info?.memory?.textures,
    programs: r?.info?.programs?.length,
    resident: window.__landblockLru?.entries?.size, parked: window.__landblockLru?.parkPool?.size,
  };
  try { out.geomCache = typeof window.__staticGeomCache === "function" ? window.__staticGeomCache() : null; } catch (_) {}
  try { out.heapMB = Math.round(performance.memory.usedJSHeapSize / 1048576); } catch (_) {}
  return out;
};

// Streaming quiescence: resident LB count AND live geometry count unchanged
// for `quietMs`. A fixed sleep measured loading, not frames (dry run: 81->108
// resident during the "still" window, 16 s of long tasks per 30 s).
async function settle(page, quietMs = 12000, maxMs = 150000) {
  const t = Date.now();
  let last = null, since = Date.now();
  while (Date.now() - t < maxMs) {
    const cur = await page.evaluate(() => `${window.__landblockLru?.entries?.size}|${window.liveScene3d?.renderer?.info?.memory?.geometries}`).catch(() => null);
    if (cur !== last) { last = cur; since = Date.now(); }
    else if (Date.now() - since >= quietMs) return { ms: Date.now() - t, quiet: true, state: cur };
    await sleep(1000);
  }
  return { ms: Date.now() - t, quiet: false, state: last };
}

// Static-batch walk counters (cumulative); diffed per window by the analysis.
const BATCH = async () => {
  try {
    const X = await import("/apps/holtburger-web/scene3d/static_batch_x.js");
    const st = X.getStatBatchXStats();
    const { walk, memo, buckets, instances, parkHidden, unparkShown } = st;
    return { walk, memo, buckets, instances, parkHidden, unparkShown };
  } catch (e) { return { error: String(e?.message ?? e) }; }
};

async function runOne(arm, rep) {
  const tag = `${arm.name}-r${rep}`;
  const dir = join(OUT, tag);
  mkdirSync(dir, { recursive: true });
  const runT0 = Date.now();
  const res = { arm: arm.name, rep, quality: arm.quality, flags: arm.flags, startedAt: new Date().toISOString() };
  const url = `${APP}?autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first&nosw=1&camDebug=on` +
    `&adaptiveRes=off&quality=${arm.quality}${arm.flags ? "&" + arm.flags : ""}`;
  res.url = url;
  res.accountFreeWait = await waitAccountFree() ? "ok" : "timeout";
  await launch(`hbb-${tag}-${Date.now()}`);
  const browser = await chromium.connectOverCDP(CDP);
  const errors = [];
  let page;
  try {
    const ctx = browser.contexts()[0];
    page = ctx.pages()[0] || (await ctx.newPage());
    page.on("pageerror", (e) => errors.push("pageerror: " + String(e?.message ?? e).slice(0, 300)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
    page.on("crash", () => { errors.push(`PAGE CRASH at ${Date.now() - runT0} ms`); res.crashed = true; });
    page.on("close", () => { if (!res.closedAt) res.closedAt = Date.now() - runT0; });
    browser.on("disconnected", () => { if (!res.disconnectedAt) res.disconnectedAt = Date.now() - runT0; });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    res.gpu = await page.evaluate(() => {
      const gl = document.createElement("canvas").getContext("webgl2");
      const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown";
    });
    if (!/1070/.test(res.gpu)) throw new Error(`not on the 1070 GPU: ${res.gpu}`);
    // Keep the box's display awake. With the display off (owner idle) Chrome
    // gets no vsync and drops rAF to 1 Hz — the 2026-10-05 A1 sortProgram run
    // measured "1008 ms" frames. Released when the bench Chrome is killed.
    res.wakeLock = await page.evaluate(async () => {
      try { window.__benchWake = await navigator.wakeLock.request("screen"); return "held"; }
      catch (e) { return "failed: " + String(e?.message ?? e); }
    });
    const bootT = Date.now();
    let ok = false;
    for (let i = 0; i < 150; i++) {
      ok = await page.evaluate(() => !!window.liveScene3d && !!window.__sessionHandle &&
        ((window.__bootStateHistory || []).some((s) => (s.state || s) === "ready") || window.__bootState === "ready")).catch(() => false);
      if (ok) break;
      await sleep(1000);
    }
    res.bootMs = Date.now() - bootT;
    if (!ok) {
      res.bootHistory = await page.evaluate(() => window.__bootStateHistory).catch(() => null);
      throw new Error("boot never reached ready");
    }
    const tele = (c) => page.evaluate((cmd) => window.__sessionHandle.sendChat(cmd), `@teleloc ${c.join(" ")}`);
    await sleep(5000);
    await tele(HOLT);
    await sleep(8000);
    res.settle1 = await settle(page);
    const pose = await page.evaluate(() => window.__cam.world());
    const lb = await page.evaluate(() => { const p = window.__sessionHandle.getLocalPlayerPose(); const v = p.landblockId >>> 0; try { p.free?.(); } catch (_) {} return v.toString(16); });
    res.lb = lb;
    if (!lb.startsWith("a9b4")) errors.push(`warn: not in Holtburg after teleport (lb ${lb})`);
    const target = { x: pose.x, y: pose.y, z: pose.z + 1.5 };
    const orbit = { ...target, dist: 70, az: 45, el: 22, degPerSec: 12 };
    await page.evaluate((o) => window.__cam.orbit(o.x, o.y, o.z, o.dist, o.az, o.el), orbit);
    // Warm-up revolution (unrecorded): compiles every program the orbit will
    // show and streams what it reveals, so the measured windows are steady.
    await page.evaluate(RECORD, { ms: 30000, orbit: { ...orbit, degPerSec: 12 } });
    await page.evaluate((o) => window.__cam.orbit(o.x, o.y, o.z, o.dist, o.az, o.el), orbit);
    res.settle2 = await settle(page, 8000, 60000);
    writeFileSync(join(dir, "still.png"), await page.screenshot({ timeout: 30000 }));
    res.batch0 = await page.evaluate(BATCH);
    res.still = await page.evaluate(RECORD, { ms: 30000, orbit: null });
    res.batch1 = await page.evaluate(BATCH);
    res.moving = await page.evaluate(RECORD, { ms: 30000, orbit });
    res.batch2 = await page.evaluate(BATCH);
    for (const k of ["still", "moving"]) {
      if (res[k]?.p50 >= 900) throw new Error(`throttled: ${k} p50 ${res[k].p50} ms (display off / page hidden?)`);
    }
    if (arm.probeSort) {
      await page.evaluate((o) => window.__cam.orbit(o.x, o.y, o.z, o.dist, o.az, o.el), orbit);
      res.sortProbe = {};
      for (const on of [false, true, false, true]) {
        await page.evaluate((v) => window.__drawSort.set(v), on);
        await sleep(1000);
        const p = await page.evaluate(() => window.__drawSort.probe(120));
        (res.sortProbe[on ? "on" : "off"] ||= []).push(p);
      }
    }
    res.snapHolt = await page.evaluate(SNAPSHOT);
    // TOUR: streaming out and back with the camera following the player.
    if (arm.tour === false) { res.snapEnd = res.snapHolt; return res; }
    await page.evaluate(() => window.__cam.release());
    const tourP = page.evaluate(RECORD, { ms: 55000, orbit: null });
    await tele(EAST);
    await sleep(25000);
    await tele(HOLT);
    res.tour = await tourP;
    writeFileSync(join(dir, "tour.png"), await page.screenshot({ timeout: 30000 }));
    res.snapEnd = await page.evaluate(SNAPSHOT);
  } catch (e) {
    res.error = String(e?.message ?? e);
  } finally {
    res.errors = errors;
    writeFileSync(join(dir, "result.json"), JSON.stringify(res, null, 1));
    try { await browser.close(); } catch (_) {} // CDP disconnect only
    const killedAt = Date.now();
    killBench();
    res.aceLogout = await waitAceLogout(killedAt);
  }
  return res;
}

// ---- main ---------------------------------------------------------------------
const list = only ? arms.filter((a) => only.includes(a.name)) : arms;
const missingDir = opt("--missing", null);
const isDone = (arm, rep) => {
  if (!missingDir) return false;
  try { return !JSON.parse(readFileSync(join(missingDir, `${arm.name}-r${rep}`, "result.json"), "utf8")).error; } catch (_) { return false; }
};
const results = [];
killBench();
for (let rep = 1; rep <= REPS; rep++) {
  const order = list.map((_, i) => list[(i + rep - 1) % list.length]);
  for (const arm of order) {
    if (isDone(arm, rep)) continue;
    log(`run ${arm.name} rep ${rep}`);
    let r = await runOne(arm, rep);
    if (r.error && /boot never|CDP|closed|throttled/.test(r.error)) { log(`  retry after: ${r.error}`); await sleep(15000); r = await runOne(arm, rep); }
    results.push(r);
    const f = (x) => x ? `p50 ${x.p50} p95 ${x.p95} fps ${x.fps} draws ${x.drawsPerFrame}` : "-";
    log(`  ${r.error ? "ERROR " + r.error : "ok"} | still ${f(r.still)} | moving ${f(r.moving)} | tour h50 ${r.tour?.hitch50 ?? "-"} max ${r.tour?.max ?? "-"} | errs ${r.errors.length}`);
    writeFileSync(join(OUT, "summary.json"), JSON.stringify(results, null, 1));
  }
}
const med = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
console.log("\narm                 n  still p50/p95   moving p50/p95  draws  tour h50/h100/max  errs");
for (const arm of list) {
  const rs = results.filter((r) => r.arm === arm.name && !r.error);
  const m = (k, f) => med(rs.map((r) => r[k]?.[f]));
  console.log(`${arm.name.padEnd(18)} ${String(rs.length).padStart(2)}  ${m("still", "p50")}/${m("still", "p95")}`.padEnd(38) +
    `${m("moving", "p50")}/${m("moving", "p95")}`.padEnd(16) + `${m("still", "drawsPerFrame")}`.padEnd(7) +
    `${m("tour", "hitch50")}/${m("tour", "hitch100")}/${m("tour", "max")}`.padEnd(19) +
    `${rs.reduce((a, r) => a + r.errors.length, 0)}`);
}
log("out:", OUT);
process.exit(0);
