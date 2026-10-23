// scripts/perf-worker/grass-gpu-run.eval.js — the RUNNING read for the ?terrainGrassGpu A/B
// (apps/holtburger-web/docs/2026-10-23-grass-gpu-placement.md; queue item
// docs/reengineering/queue-1070/batch-GG-grass-gpu-2026-10-23.json). Page-side. Written
// 2026-10-23, NOT yet run anywhere (the laptop runs no live client sessions; 1070 = owner-run).
//
// WHY. The CPU grass path costs most while the player RUNS: every frame scrolls the ring
// windows and re-scatters the slots that wrap (findings-round2: ~2.75 ms/frame grass fast
// run). hbbench's orbit moves only the camera, so it never shows that cost. This file runs
// the player on a fixed path and reads frame intervals plus the grass stats, so both arms
// (terrainGrassGpu=off / =on) are compared on the same ground.
//
// FORMAT. The BODY of an async function, like structure-p0.eval.js: hbsess.mjs wraps it as
// `(async () => { <file> })()` and prints the return value as JSON. Options come from
// window.__grassGpuRunOpts (set it with a one-line `hbsess.mjs eval` first, or edit the
// defaults). Modes:
//   "run"   (default) — @teleloc to the start facing SOUTH, wait for the landing and the
//           portal tunnel, settle, hold still standMs (rAF intervals), then AutoRun for runMs
//           (rAF intervals, long tasks, pose start/end), AutoRun off, grass stats at each step.
//   "start" — the same @teleloc + settle, then AutoRun ON and return at once (so
//           `hbsess.mjs profile 10 <out>.cpuprofile` can record the run);
//   "stop"  — AutoRun OFF and the current grass stats.
// The path: Holtburg's settle point (hbsess's HOLT pose, 0xA9B40001 96 96 80), heading south
// (quaternion w=0 x=0 y=0 z=1: a 180 degree yaw from AC's north-facing identity), ~10 m/s.

const W = typeof window !== "undefined" ? window : globalThis;
const DEFAULTS = {
  mode: "run",
  start: { cell: "0xA9B40001", x: 96, y: 96, z: 80, q: [0, 0, 0, 1] },
  telelocWaitMs: 20000,
  tunnelWaitMs: 15000,
  settleMs: 20000,
  standMs: 10000,
  runMs: 20000,
};
const OPTS = Object.assign({}, DEFAULTS, W.__grassGpuRunOpts || {});

const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms | 0)));
const errors = [];
const note = (where, e) => { errors.push(`${where}: ${String((e && e.message) || e).slice(0, 300)}`); };
const call = (where, f) => { try { return f(); } catch (e) { note(where, e); return null; } };

function plain(v) {
  try {
    return JSON.parse(JSON.stringify(v, (_k, x) => {
      if (typeof x === "function") return undefined;
      if (ArrayBuffer.isView(x)) return { typedArray: x.constructor.name, length: x.length };
      if (x && typeof x === "object" && (x.isObject3D || x.isMaterial || x.isTexture || x.isBufferGeometry)) return `[three ${x.type || "object"}]`;
      return x;
    }));
  } catch (e) {
    return { plainError: String((e && e.message) || e) };
  }
}

function frameStats(dts) {
  if (!dts.length) return null;
  const s = [...dts].sort((a, b) => a - b);
  const q = (p) => +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2);
  const sum = dts.reduce((a, b) => a + b, 0);
  return { frames: dts.length, fps: +(dts.length / (sum / 1000)).toFixed(1), p50: q(0.5), p95: q(0.95), p99: q(0.99),
    max: +s[s.length - 1].toFixed(1), mean: +(sum / dts.length).toFixed(2) };
}

/** rAF intervals for ms milliseconds, plus long tasks (>50 ms main-thread blocks). */
function sampleFrames(ms) {
  return new Promise((resolve) => {
    const dts = [];
    let longTasks = 0, longMs = 0, obs = null;
    try {
      obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) { longTasks += 1; longMs += e.duration; } });
      obs.observe({ entryTypes: ["longtask"] });
    } catch (_) { obs = null; }
    const raf = W.requestAnimationFrame.bind(W);
    const t0 = now();
    let last = null;
    const tick = (ts) => {
      if (last !== null) dts.push(ts - last);
      last = ts;
      if (now() - t0 >= ms) {
        try { obs && obs.disconnect(); } catch (_) { /* gone */ }
        resolve({ ...frameStats(dts), longTasks: obs ? longTasks : null, longTaskMs: obs ? Math.round(longMs) : null });
        return;
      }
      raf(tick);
    };
    raf(tick);
  });
}

function pose() {
  const h = W.__sessionHandle;
  if (!h || typeof h.getLocalPlayerPose !== "function") return null;
  let p = null;
  try {
    p = h.getLocalPlayerPose();
    if (!p) return null;
    return { lb: "0x" + ((p.landblockId >>> 0).toString(16).padStart(8, "0")), lbHi: (p.landblockId >>> 16) & 0xffff,
      x: +(+p.x).toFixed(2), y: +(+p.y).toFixed(2), z: +(+p.z).toFixed(2) };
  } catch (e) {
    note("pose", e);
    return null;
  } finally {
    try { p && p.free && p.free(); } catch (_) { /* already released */ }
  }
}

/** The grass surface as the arms see it: mode, draw counts, field / mask GPU stats. */
function grass() {
  const g = W.__terrainGrass;
  if (!g || typeof g.stats !== "function") return { present: false };
  const s = call("__terrainGrass.stats", () => g.stats());
  if (!s) return { present: true, stats: null };
  return {
    present: true,
    mode: s.mode ?? null,
    enabled: s.enabled ?? null,
    buildError: s.buildError ?? null,
    visibleBlades: s.visibleBlades ?? null,
    blades: s.blades ?? null,
    tilesDrawn: s.tilesDrawn ?? null,
    instancesDrawn: s.instancesDrawn ?? null,
    levels: Array.isArray(s.levels) ? s.levels.map((l) => ({ level: l.level, count: l.count, live: l.live ?? null,
      tilesDrawn: l.tilesDrawn ?? null, instancesDrawn: l.instancesDrawn ?? null })) : null,
    field: plain(s.field ?? null),
    indoorCull: plain(s.indoorCull ?? null),
  };
}

function setAutoRun(on) {
  const h = W.__sessionHandle;
  if (!h || typeof h.setAutoRun !== "function") { note("autorun", "window.__sessionHandle.setAutoRun missing (stale pkg/?)"); return false; }
  try {
    h.setAutoRun(on);
    W.__autoRunOn = on;   // the page's own R-key toggle reads this
    return true;
  } catch (e) {
    note("autorun", e);
    return false;
  }
}

function tunnelActive() {
  try { return typeof W.__isPortalSpaceActive === "function" ? W.__isPortalSpaceActive() === true : null; } catch (_) { return null; }
}

async function goToStart() {
  const s = OPTS.start;
  const h = W.__sessionHandle;
  if (!h || typeof h.sendChat !== "function") throw new Error("window.__sessionHandle.sendChat missing");
  const cmd = `@teleloc ${s.cell} ${s.x} ${s.y} ${s.z} ${s.q.join(" ")}`;
  const lbHi = (parseInt(s.cell, 16) >>> 16) & 0xffff;
  const t0 = now();
  h.sendChat(cmd);
  let p = null, ok = false;
  while (now() - t0 < OPTS.telelocWaitMs) {
    await sleep(250);
    p = pose();
    if (p && p.lbHi === lbHi && Math.hypot(p.x - s.x, p.y - s.y) < 8) { ok = true; break; }
  }
  const t1 = now();
  while (tunnelActive() === true && now() - t1 < OPTS.tunnelWaitMs) await sleep(100);
  const tunnelLeft = tunnelActive();
  await sleep(OPTS.settleMs);
  return { cmd, landed: p, landedOk: ok, waitMs: Math.round(t1 - t0), tunnelStillActive: tunnelLeft === true };
}

const out = {
  schema: "grass-gpu-run-v1",
  opts: OPTS,
  url: String(W.location && W.location.search || ""),
  flag: (() => { try { return new URLSearchParams(W.location.search).get("terrainGrassGpu"); } catch (_) { return null; } })(),
  errors,
};

if (OPTS.mode === "stop") {
  out.autoRunOff = setAutoRun(false);
  out.pose = pose();
  out.grass = grass();
  return out;
}

out.start = await goToStart();
out.grassSettled = grass();
if (OPTS.mode === "start") {
  out.autoRunOn = setAutoRun(true);
  out.pose = pose();
  return out;
}

out.stand = await sampleFrames(OPTS.standMs);
out.grassStand = grass();
out.runPose0 = pose();
out.autoRunOn = setAutoRun(true);
out.run = await sampleFrames(OPTS.runMs);
out.runPose1 = pose();
out.grassRun = grass();
out.autoRunOff = setAutoRun(false);
if (out.runPose0 && out.runPose1) {
  out.runMetres = +Math.hypot(out.runPose1.x - out.runPose0.x + 192 * (((out.runPose1.lbHi >> 8) & 0xff) - ((out.runPose0.lbHi >> 8) & 0xff)),
    out.runPose1.y - out.runPose0.y + 192 * ((out.runPose1.lbHi & 0xff) - (out.runPose0.lbHi & 0xff))).toFixed(1);
}
return out;
