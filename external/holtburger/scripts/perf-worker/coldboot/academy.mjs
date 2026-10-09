// acad-time.mjs — fresh-profile boot of the academy character; poll the EnvCell build every 2 s.
//   node acad-time.mjs --label X [--flags 'a=b'] [--max-s 360] [--relay-log run4.tsv] [--profile]
//   --profile: main-thread CPU profile from navigation to the end → acad-<label>.cpuprofile
//   --linkmap: time every blocking program query per GL program (a synchronous driver link shows up
//              as the first getProgramParameter/getActiveUniform on it) → sum.linkmap, named via
//              renderer.info.programs
//   --fetchmap: per /shards/ request on the page, when fetch() was called and when its body reached
//              JS (arrayBuffer resolved) → `fetchmap` in acad-<label>.json, to set against the
//              network's own responseEnd (resource timing): the gap is main-thread delay
//   --longtasks: every main-thread task over 50 ms ([startMs, durationMs], page clock) → `longtasks`
//              (with --profile, the profile records the page clock at its start: pageMsAtStart)
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { statSync, openSync, readSync, closeSync, readFileSync, writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const BOX = "young@100.127.215.75", CDP = "http://127.0.0.1:9333", PORT = +opt("--port", 7093), HOST = opt("--host", "100.116.47.66");
const LABEL = opt("--label", "acad"), MAXS = +opt("--max-s", 360), RLOG = opt("--relay-log", "run4.tsv");
const ACE_LOG = "/home/wbterminal/ace-server/Source/ACE.Server/bin/Release/net10.0/ACE_Log.txt";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ssh = (c) => execFileSync("ssh", ["-o", "BatchMode=yes", BOX, c], { encoding: "utf8", timeout: 60000 });
function aceTail(n = 262144) { const s = statSync(ACE_LOG).size, fd = openSync(ACE_LOG, "r"); const b = Buffer.alloc(Math.min(n, s)); readSync(fd, b, 0, b.length, s - b.length); closeSync(fd); return b.toString("utf8"); }
async function waitFree(maxMs = 150000) { const end = Date.now() + maxMs; while (Date.now() < end) { const ev = aceTail().split("\n").filter((l) => /\[(LOGIN|LOGOUT)\] Account tailnet1 /.test(l)); const last = ev[ev.length - 1]; if (!last || /\[LOGOUT\]/.test(last)) return true; await sleep(2000); } return false; }
function relayDown(sinceMs) { let d = 0; for (const l of readFileSync(RLOG, "utf8").split("\n")) { const f = l.split("\t"); if (+f[0] >= sinceMs) d += +f[1] || 0; } return d; }
// End any live test session cleanly first (disconnect), then kill only the test Chrome.
try { const b = await chromium.connectOverCDP(CDP, { timeout: 8000 }); for (const p of b.contexts()[0].pages()) await p.evaluate(() => { try { window.__sessionHandle?.disconnect?.(); } catch (_) {} }).catch(() => {}); await sleep(1500); } catch (_) {}
try { ssh("powershell -NoProfile -ExecutionPolicy Bypass -File D:\\Temp\\hbbench\\hbbench-kill.ps1"); } catch (_) {}
console.log("account free:", await waitFree());
ssh(`echo hbb-${LABEL}-${Date.now()}> D:\\Temp\\hbbench\\profile.txt`);
ssh(`echo 1280,720> D:\\Temp\\hbbench\\winsize.txt`);
ssh('schtasks /create /tn hbprobe /tr "D:\\Temp\\hbbench\\hbprobe-launch.bat" /sc once /st 00:00 /it /f >nul 2>nul & schtasks /run /tn hbprobe >nul');
for (let i = 0; i < 40; i++) { try { if ((await fetch(`${CDP}/json/version`)).ok) break; } catch (_) {} await sleep(1000); }
const browser = await chromium.connectOverCDP(CDP);
const pg = browser.contexts()[0].pages()[0];
const flags = opt("--flags", "");
const url = `http://${HOST}:${PORT}/apps/holtburger-web/index.html?autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first&nosw=1&bridge_url=ws://${HOST}:${PORT}/wsbridge&server_host=127.0.0.1&server_port=9000${flags ? "&" + flags : ""}`;
await pg.addInitScript(() => { try { performance.setResourceTimingBufferSize(200000); } catch (_) {} });
if (a.includes("--longtasks")) await pg.addInitScript(() => {
  const lt = []; window.__longTasks = lt;
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) lt.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: "longtask", buffered: true }); } catch (_) {}
});
if (a.includes("--fetchmap")) await pg.addInitScript(() => {
  const recs = new Map(); window.__fetchMap = recs; const of = globalThis.fetch;
  globalThis.fetch = function (input, init) {
    const u = typeof input === "string" ? input : input?.url || String(input);
    const p = of.call(this, input, init);
    if (u.includes("/shards/")) { const r = { c: performance.now() }; recs.set(u.slice(u.indexOf("/shards/")), r); p.then(() => { r.h = performance.now(); }, () => {}); }
    return p;
  };
  const oab = Response.prototype.arrayBuffer;
  Response.prototype.arrayBuffer = function () {
    const url = String(this.url); const r = recs.get(url.slice(url.indexOf("/shards/"))); const p = oab.call(this);
    if (r) p.then(() => { r.b = performance.now(); }, () => {});
    return p;
  };
});
if (a.includes("--linkmap")) await pg.addInitScript(() => {
  const m = new WeakMap(), all = []; window.__linkMap = { all, m };
  for (const C of [globalThis.WebGL2RenderingContext, globalThis.WebGLRenderingContext]) {
    if (!C) continue;
    for (const fn of ["getProgramParameter", "getActiveUniform", "getActiveAttrib", "getUniformLocation", "getAttribLocation", "getProgramInfoLog"]) {
      const o = C.prototype[fn]; if (typeof o !== "function") continue;
      C.prototype[fn] = function (prog, ...rest) {
        const t0 = performance.now(); const r = o.call(this, prog, ...rest); const dt = performance.now() - t0;
        if (prog && typeof prog === "object") { let e = m.get(prog); if (!e) { e = { first: t0, ms: 0, worst: 0, calls: 0, prog }; m.set(prog, e); all.push(e); } e.ms += dt; e.calls++; if (dt > e.worst) e.worst = dt; }
        return r;
      };
    }
  }
});
const logs = [], workers = [];
pg.on("console", (m) => { const tx = m.text(); if (/envcells|placements fetched|bake_worker|materialCache|fetchEnvCells|surface/i.test(tx)) logs.push({ t: Date.now() - t0, tx: tx.slice(0, 240) }); });
pg.on("worker", (w) => { workers.push({ w, url: w.url(), t: Date.now() - t0 }); w.evaluate(() => { try { performance.setResourceTimingBufferSize(200000); } catch (_) {} }).catch(() => {}); });
const PROF = a.includes("--profile");
let cdp = null, profPageMs = null;
const t0 = Date.now();
await pg.goto(url, { waitUntil: "commit", timeout: 120000 });
if (PROF) { // after commit: a cross-origin navigation can swap the renderer
  cdp = await pg.context().newCDPSession(pg);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
  await cdp.send("Profiler.start");
  profPageMs = await pg.evaluate(() => performance.now()).catch(() => null);
}
const rows = [];
let doneAt = null;
for (let i = 0; Date.now() - t0 < MAXS * 1000; i++) {
  const r = await pg.evaluate(() => {
    const s = window.liveScene3d, h = window.__sessionHandle;
    const hist = (window.__bootStateHistory || []).map((x) => x.state);
    let cell = null; try { const p = h?.getLocalPlayerPose?.(); cell = p ? (p.landblockId >>> 0).toString(16) : null; p?.free?.(); } catch (_) {}
    let bw = null; try { const st = window.__diag?.bakeWorkerStats?.(); if (st) bw = { q: st.queue?.queuedNow, inf: st.queue?.inFlightPosted, posted: st.queue?.posted, fb: st.fallbacks?.total, by: Object.fromEntries(Object.entries(st.byType || {}).map(([k, v]) => [k, v.count + "/" + v.maxMs])) }; } catch (_) {}
    const asArr = (v) => v instanceof Set ? Array.from(v).map((x) => (typeof x === "number" ? (x >>> 0).toString(16) : String(x))) : null;
    return {
      st: hist[hist.length - 1] || null, cell,
      kids: s?.cellsGroup?.children?.length ?? null,
      envIn: asArr(s?.envCellBuildInFlight), envLoaded: asArr(s?.envCellLoadedLbs),
      pf: s?.materialCache?.pendingFetches?.size ?? null, mats: s?.materialCache?.materials?.size ?? null,
      terr: s?.terrainBakedLbs?.size ?? null, bw,
      shell: document.querySelector('script[src*="shell/"]') ? "bundled" : "unbundled",
    };
  }).catch((e) => ({ err: String(e).slice(0, 80) }));
  r.t = Math.round((Date.now() - t0) / 100) / 10;
  r.downMB = Math.round(relayDown(t0) / 1e5) / 10;
  rows.push(r);
  const key = JSON.stringify({ ...r, t: 0, downMB: 0 });
  if (rows.length === 1 || key !== rows[rows.length - 2]._k) console.log(JSON.stringify(r));
  r._k = key;
  if (r.kids > 0 && r.pf === 0 && Array.isArray(r.envIn) && r.envIn.length === 0 && r.cell && /^8602/.test(r.cell)) { if (doneAt == null) doneAt = r.t; if (r.t - doneAt >= 6) break; }
  await sleep(2000);
}
let linkmap = null;
if (a.includes("--linkmap")) linkmap = await pg.evaluate(() => {
  const L = window.__linkMap; if (!L) return null;
  const progs = window.liveScene3d?.renderer?.info?.programs || [];
  const name = new Map(progs.map((p) => [p.program, `${p.name || "?"} | ${String(p.cacheKey || "").slice(0, 90)}`]));
  const t0 = performance.timeOrigin;
  return L.all.filter((e) => e.ms > 2).sort((x, y) => y.ms - x.ms).map((e) => ({ at: Math.round(e.first) / 1000, ms: Math.round(e.ms), worst: Math.round(e.worst), calls: e.calls, name: name.get(e.prog) || "(unnamed/disposed)" }));
}).catch((e) => ({ err: String(e).slice(0, 120) }));
const longtasks = a.includes("--longtasks") ? await pg.evaluate(() => window.__longTasks || []).catch(() => null) : null;
let fetchmap = null;
if (a.includes("--fetchmap")) fetchmap = await pg.evaluate(() => Array.from(window.__fetchMap || [], ([u, r]) => [u, Math.round(r.c), r.h == null ? null : Math.round(r.h), r.b == null ? null : Math.round(r.b)])).catch(() => null);
const first = (f) => rows.find(f)?.t ?? null;
const sum = {
  label: LABEL, flags, shell: rows[rows.length - 1]?.shell,
  inWorld: first((r) => r.st === "in-world" || r.st === "ready"),
  ready: first((r) => r.st === "ready"),
  envInFlight: first((r) => r.envIn && r.envIn.length > 0),
  firstCellMesh: first((r) => r.kids > 0),
  texturesDone: first((r) => r.kids > 0 && r.pf === 0),
  final: rows[rows.length - 1],
  linkmap,
};
const res = async (ctx) => ctx.evaluate(() => ({ origin: performance.timeOrigin, now: performance.now(), e: performance.getEntriesByType("resource").map((x) => [x.name.replace(/^https?:\/\/[^/]+/, ""), Math.round(x.startTime), Math.round(x.responseEnd), x.transferSize, x.encodedBodySize, x.initiatorType]) })).catch((e) => ({ err: String(e).slice(0, 100) }));
const net = { page: await res(pg), workers: [] };
for (const w of workers) net.workers.push({ url: w.url, t: w.t, r: await res(w.w) });
if (cdp) { const { profile } = await cdp.send("Profiler.stop"); profile.wallT0 = t0; profile.pageMsAtStart = profPageMs; writeFileSync(`acad-${LABEL}.cpuprofile`, JSON.stringify(profile)); }
writeFileSync(`acad-${LABEL}.json`, JSON.stringify({ t0, sum, rows, logs, net, fetchmap, longtasks }, null, 0));
console.log("SUMMARY", JSON.stringify(sum));
process.exit(0);
