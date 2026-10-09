// coldboot.mjs — one first-visit cold boot on the 1070: fresh Chrome profile (empty HTTP cache, no SW),
// page served through the laptop relay (relay.mjs, counts/throttles every byte incl. the game socket),
// the real public front (proxy.cjs: bundled shell, /wsbridge). Records a 1 s timeline of boot states +
// scene progress, JPG frames at milestones, and a summary JSON.
//   node coldboot.mjs --label NAME --port 7090 --relay-log bytes.tsv [--max-min 20] [--tele holt] [--flags 'a=b']
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, statSync, openSync, readSync, closeSync, existsSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const LABEL = opt("--label", "cold"), PORT = +opt("--port", 7090), RELAY_LOG = opt("--relay-log", "bytes.tsv");
const MAX_MS = +opt("--max-min", 20) * 60000, FLAGS = opt("--flags", ""), TELE = opt("--tele", "");
const SETTLE_MS = +opt("--settle-s", 25) * 1000;
const HOSTNAME = opt("--host", "127.0.0.1");
const OUT = `${process.env.COLDBOOT_OUT || "/mnt/wbterminal1/tmp/claude-scratch/perf/coldboot"}/${LABEL}`;
mkdirSync(OUT, { recursive: true });
const BOX = "young@100.127.215.75", CDP = "http://127.0.0.1:9333";
const ACE_LOG = "/home/wbterminal/ace-server/Source/ACE.Server/bin/Release/net10.0/ACE_Log.txt";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ssh = (c) => execFileSync("ssh", ["-o", "BatchMode=yes", BOX, c], { encoding: "utf8", timeout: 60000 });
const killBench = () => { try { ssh("powershell -NoProfile -ExecutionPolicy Bypass -File D:\\Temp\\hbbench\\hbbench-kill.ps1"); } catch (_) {} };
function aceLogTail(bytes = 262144) {
  const size = statSync(ACE_LOG).size, fd = openSync(ACE_LOG, "r");
  const buf = Buffer.alloc(Math.min(bytes, size)); readSync(fd, buf, 0, buf.length, size - buf.length); closeSync(fd);
  return buf.toString("utf8");
}
async function waitAccountFree(maxMs = 150000) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    const ev = aceLogTail().split("\n").filter((l) => /\[(LOGIN|LOGOUT)\] Account tailnet1 /.test(l));
    const last = ev[ev.length - 1];
    if (!last || /\[LOGOUT\]/.test(last)) return true;
    await sleep(2000);
  }
  return false;
}
// relay log: rows "t_ms down up open total" relative to the relay start; we align on wall clock
function relayRows() {
  try { return readFileSync(RELAY_LOG, "utf8").trim().split("\n").slice(1).map((l) => l.split("\t").map(Number)); } catch (_) { return []; }
}

const log = (...x) => console.log(new Date().toISOString().slice(11, 19), ...x);
killBench();
log("account free:", await waitAccountFree());
const prof = `hbb-cold-${LABEL}-${Date.now()}`;
ssh(`echo ${prof}> D:\\Temp\\hbbench\\profile.txt`);
ssh(`echo 1280,720> D:\\Temp\\hbbench\\winsize.txt`);
ssh('schtasks /create /tn hbprobe /tr "D:\\Temp\\hbbench\\hbprobe-launch.bat" /sc once /st 00:00 /it /f >nul 2>nul & schtasks /run /tn hbprobe >nul');
for (let i = 0; i < 40; i++) { try { if ((await fetch(`${CDP}/json/version`)).ok) break; } catch (_) {} await sleep(1000); }
const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0];
const pg = ctx.pages()[0];
const cdp = await ctx.newCDPSession(pg);
await cdp.send("Page.enable");
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "try{performance.setResourceTimingBufferSize(1000000)}catch(e){}; window.__coldErr=[]; addEventListener('error',e=>{try{window.__coldErr.push(String(e.message).slice(0,200))}catch(_){}});" });
const base = `http://${HOSTNAME}:${PORT}/apps/holtburger-web/index.html`;
const url = `${base}?autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first&bridge_url=ws://${HOSTNAME}:${PORT}/wsbridge&server_host=127.0.0.1&server_port=9000${FLAGS ? "&" + FLAGS : ""}`;
const consoleErrors = [];
pg.on("console", (m) => { if (m.type() === "error" && consoleErrors.length < 200) consoleErrors.push(m.text().slice(0, 300)); });
const tNav = Date.now();
log("goto", url.replace(/password=[^&]+/, "password=***"));
await pg.goto(url, { waitUntil: "commit", timeout: 120000 });
const gpu = await pg.evaluate(() => { try { const gl = document.createElement("canvas").getContext("webgl2"); const e = gl.getExtension("WEBGL_debug_renderer_info"); return gl.getParameter(e.UNMASKED_RENDERER_WEBGL); } catch (e) { return String(e); } }).catch((e) => String(e));
log("gpu", gpu);
await pg.evaluate(async () => { try { window.__benchWake = await navigator.wakeLock.request("screen"); } catch (_) {} }).catch(() => {});

const sample = () => pg.evaluate(() => {
  const s = window.liveScene3d, r = s?.renderer;
  const res = performance.getEntriesByType("resource");
  let tb = 0; for (const e of res) tb += e.transferSize || 0;
  const h = window.__bootStateHistory || [];
  return {
    state: window.__bootState, nStates: h.length,
    terr: s?.terrainBakedLbs?.size ?? null, lru: window.__landblockLru?.entries?.size ?? null,
    geo: r?.info?.memory?.geometries ?? null, tex: r?.info?.memory?.textures ?? null, prog: r?.info?.programs?.length ?? null,
    nres: res.length, resMB: +(tb / 1048576).toFixed(2), heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(0) : null,
    bw: (() => { try { return window.__bandwidthTier?.()?.tier ?? null; } catch (_) { return null; } })(),
  };
}).catch((e) => ({ err: String(e).slice(0, 120) }));

async function snap(name) {
  const dataUrl = await pg.evaluate(async () => {
    const r = window.liveScene3d?.renderer; if (!r) return "no-renderer";
    const orig = r.render, cv = r.domElement; let last = null;
    r.render = function (...x) { const ret = orig.apply(this, x); if (r.getRenderTarget() === null) { try { last = cv.toDataURL("image/jpeg", 0.8); } catch (e) { last = String(e); } } return ret; };
    await new Promise((res) => { let n = 0; const f = () => (++n >= 3 || last) ? res() : requestAnimationFrame(f); requestAnimationFrame(f); setTimeout(res, 4000); });
    r.render = orig; return last;
  }).catch((e) => String(e));
  if (dataUrl && dataUrl.startsWith("data:")) { writeFileSync(`${OUT}/${name}.jpg`, Buffer.from(dataUrl.split(",")[1], "base64")); return true; }
  log("snap", name, "failed:", String(dataUrl).slice(0, 120)); return false;
}

const timeline = [];
const marks = {};
let readyAt = null, stableSince = null, lastKey = null, settledAt = null;
const snapsAt = [10000, 30000, 60000, 120000, 180000, 300000];
const snapped = new Set();
while (Date.now() - tNav < MAX_MS) {
  const t = Date.now() - tNav;
  const s = await sample();
  // relay bytes in the last SETTLE window (wall-aligned)
  const rows = relayRows();
  const recent = rows.filter((r) => r[0] > Date.now() - SETTLE_MS).reduce((acc, r) => acc + r[1], 0);
  const totalDown = rows.filter((r) => r[0] >= tNav).reduce((acc, r) => acc + r[1], 0);
  s.t = t; s.relayDownMB = +(totalDown / 1048576).toFixed(2); s.recentKB = Math.round(recent / 1024);
  timeline.push(s);
  if (s.state && !marks[s.state]) { marks[s.state] = t; log(`state ${s.state} @ ${(t / 1000).toFixed(1)}s`, JSON.stringify(s)); }
  if (s.terr > 0 && marks.terrain1 == null) { marks.terrain1 = t; log(`first terrain LB @ ${(t / 1000).toFixed(1)}s`); }
  if (s.lru > 0 && marks.statics1 == null) { marks.statics1 = t; log(`first statics LB @ ${(t / 1000).toFixed(1)}s`); }
  const isReady = s.state === "ready" || (await pg.evaluate(() => !!window.__sceneReadyEverFired).catch(() => false));
  if (isReady && readyAt == null) { readyAt = t; marks.readyLatched = t; await snap("at-ready"); }
  if (readyAt != null) {
    for (const d of snapsAt) if (!snapped.has(d) && t - readyAt >= d) { snapped.add(d); await snap(`ready+${d / 1000}s`); log(`t=${(t / 1000).toFixed(0)}s`, JSON.stringify(s)); }
    const key = `${s.terr}|${s.lru}|${s.geo}|${s.tex}`;
    if (key !== lastKey) { lastKey = key; stableSince = t; }
    if (t - stableSince >= SETTLE_MS && recent < 150 * 1024 && t - readyAt > 20000) { settledAt = stableSince; log(`SETTLED (stable since ${(stableSince / 1000).toFixed(1)}s)`, JSON.stringify(s)); break; }
  }
  if (s.state === "error") { log("boot error", JSON.stringify(await pg.evaluate(() => window.__bootStateHistory).catch(() => null))); }
  await sleep(1000);
}
await snap("settled");
const hist = await pg.evaluate(() => (window.__bootStateHistory || []).map((h) => ({ state: h.state, msg: String(h.message || "").slice(0, 80), ts: h.ts }))).catch(() => []);
const navStartWall = await pg.evaluate(() => performance.timeOrigin).catch(() => tNav);
const resSummary = await pg.evaluate(() => {
  const byExt = {}; let n = 0, tb = 0, decoded = 0;
  for (const e of performance.getEntriesByType("resource")) {
    n++; tb += e.transferSize || 0; decoded += e.decodedBodySize || 0;
    let p = ""; try { p = new URL(e.name).pathname; } catch (_) {}
    const k = p.includes("/dist/shards/") ? "shards" : p.includes("/dist/") ? "dist-other" : p.includes("/pkg/") ? "wasm-pkg" : p.includes("/scene3d/assets/") ? "scene3d-assets" : (p.match(/\.(\w+)$/) || [, "other"])[1];
    const b = (byExt[k] ||= { n: 0, MB: 0 }); b.n++; b.MB += (e.transferSize || 0) / 1048576;
  }
  for (const k in byExt) byExt[k].MB = +byExt[k].MB.toFixed(2);
  return { n, transferMB: +(tb / 1048576).toFixed(2), decodedMB: +(decoded / 1048576).toFixed(2), byExt };
}).catch((e) => String(e));
const pose = await pg.evaluate(() => { try { return window.getLocalPlayerPose?.() ?? null; } catch (_) { return null; } }).catch(() => null);
const coldErr = await pg.evaluate(() => window.__coldErr || []).catch(() => []);
const summary = {
  label: LABEL, url: url.replace(/password=[^&]+/, "password=***"), gpu, profile: prof, navStartWall, tNav,
  marks: Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, +(v / 1000).toFixed(1)])),
  settledAtS: settledAt != null ? +(settledAt / 1000).toFixed(1) : null,
  states: hist.map((h) => ({ ...h, tS: +((h.ts - navStartWall) / 1000).toFixed(1) })),
  resources: resSummary, relayDownMB: timeline.at(-1)?.relayDownMB, last: timeline.at(-1), pose,
  consoleErrors: consoleErrors.slice(0, 40), nConsoleErrors: consoleErrors.length, pageErrors: coldErr.slice(0, 20),
};
writeFileSync(`${OUT}/timeline.json`, JSON.stringify(timeline));
writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 1));
log("summary", JSON.stringify({ marks: summary.marks, settledAtS: summary.settledAtS, relayDownMB: summary.relayDownMB, res: resSummary.n, errs: consoleErrors.length }));
if (TELE) {
  const cmd = TELE === "holt" ? "@teleloc 0xA9B40019 82.7 8.8 94" : TELE;
  log("tele:", cmd);
  await pg.evaluate((c) => window.__sessionHandle?.sendChat(c), cmd).catch(() => {});
  await sleep(45000);
  await snap("after-tele");
}
log("done ->", OUT);
process.exit(0);
