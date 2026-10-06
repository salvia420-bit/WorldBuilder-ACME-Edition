// hbsess.mjs — persistent probe session on the 1070 (exploration, not timing).
//   node hbsess.mjs boot [--quality mid] [--flags 'a=b'] [--window 1280,720]
//   node hbsess.mjs eval <file.js>      file = body of an async fn; `return` value printed as JSON
//   node hbsess.mjs orbit               park the camera on the Holtburg orbit pose (stored in window.__hbOrbit)
//   node hbsess.mjs profile <sec> [out] CDP CPU profile while orbiting
//   node hbsess.mjs kill
// Never closes the browser on eval/profile (CDP disconnect only).
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";


import { statSync, openSync, readSync, closeSync } from "node:fs";
const ACE_LOG = "/home/wbterminal/ace-server/Source/ACE.Server/bin/Release/net10.0/ACE_Log.txt";
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
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const BOX = "young@100.127.215.75";
const CDP = "http://127.0.0.1:9333";
const APP = "http://127.0.0.1:8765/apps/holtburger-web/index.html";
const HOLT = ["0xA9B40001", 96, 96, 80];
const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ssh = (c) => execFileSync("ssh", ["-o", "BatchMode=yes", BOX, c], { encoding: "utf8", timeout: 60000 });
const killBench = () => { try { ssh("powershell -NoProfile -ExecutionPolicy Bypass -File D:\\Temp\\hbbench\\hbbench-kill.ps1"); } catch (_) {} };

async function page() {
  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0];
  const pg = ctx.pages().find((p) => p.url().includes("holtburger-web")) || ctx.pages()[0];
  return { browser, ctx, pg };
}

if (cmd === "kill") { killBench(); process.exit(0); }

if (cmd === "boot") {
  const q = opt("--quality", "mid"), flags = opt("--flags", "");
  killBench();
  console.log("account free:", await waitAccountFree());
  ssh(`echo hbb-sess-${Date.now()}> D:\\Temp\\hbbench\\profile.txt`);
  ssh(`echo ${opt("--window", "1280,720")}> D:\\Temp\\hbbench\\winsize.txt`);
  ssh('schtasks /create /tn hbprobe /tr "D:\\Temp\\hbbench\\hbprobe-launch.bat" /sc once /st 00:00 /it /f >nul 2>nul & schtasks /run /tn hbprobe >nul');
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${CDP}/json/version`)).ok) break; } catch (_) {} await sleep(1000); }
  const { pg } = await page();
  const url = `${APP}?autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first&nosw=1&camDebug=on&adaptiveRes=off&quality=${q}${flags ? "&" + flags : ""}`;
  await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  console.log("gpu", await pg.evaluate(() => { const gl = document.createElement("canvas").getContext("webgl2"); const e = gl.getExtension("WEBGL_debug_renderer_info"); return gl.getParameter(e.UNMASKED_RENDERER_WEBGL); }));
  console.log("wake", await pg.evaluate(async () => { try { window.__benchWake = await navigator.wakeLock.request("screen"); return "held"; } catch (e) { return String(e); } }));
  let ok = false;
  for (let i = 0; i < 150 && !ok; i++) { ok = await pg.evaluate(() => !!window.liveScene3d && !!window.__sessionHandle && (window.__bootStateHistory || []).some((s) => (s.state || s) === "ready")).catch(() => false); if (!ok) await sleep(1000); }
  if (!ok) { console.log("boot FAILED", JSON.stringify(await pg.evaluate(() => window.__bootStateHistory).catch(() => null))); process.exit(1); }
  await sleep(5000);
  await pg.evaluate((c) => window.__sessionHandle.sendChat(c), `@teleloc ${HOLT.join(" ")}`);
  await sleep(8000);
  let last = null, since = Date.now(); const t = Date.now();
  while (Date.now() - t < 150000) {
    const cur = await pg.evaluate(() => `${window.__landblockLru?.entries?.size}|${window.liveScene3d?.renderer?.info?.memory?.geometries}`).catch(() => null);
    if (cur !== last) { last = cur; since = Date.now(); } else if (Date.now() - since >= 12000) break;
    await sleep(1000);
  }
  const pose = await pg.evaluate(() => window.__cam.world());
  await pg.evaluate((o) => { window.__hbOrbit = o; window.__cam.orbit(o.x, o.y, o.z, o.dist, o.az, o.el); }, { x: pose.x, y: pose.y, z: pose.z + 1.5, dist: 70, az: 45, el: 22, degPerSec: 12 });
  console.log("ready; settled", last, "in", Date.now() - t, "ms");
  process.exit(0);
}

if (cmd === "orbit") {
  const { pg } = await page();
  await pg.evaluate(() => { const o = window.__hbOrbit; window.__cam.orbit(o.x, o.y, o.z, o.dist, o.az, o.el); });
  process.exit(0);
}

if (cmd === "eval") {
  const src = readFileSync(argv[1], "utf8");
  const { pg } = await page();
  const r = await pg.evaluate(`(async () => { ${src}\n })()`);
  console.log(typeof r === "string" ? r : JSON.stringify(r, null, 1));
  process.exit(0);
}

if (cmd === "profile") {
  const sec = +(argv[1] || 8), out = argv[2] || "/mnt/wbterminal1/tmp/claude-scratch/perf/sess-sess.cpuprofile";
  const { ctx, pg } = await page();
  const cdp = await ctx.newCDPSession(pg);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 250 });
  await cdp.send("Profiler.start");
  const street = argv.includes("street");
  const rec = await pg.evaluate(async ({ ms, street }) => {
    const o = window.__hbOrbit, t0 = performance.now(); let n = 0;
    await new Promise((res) => { const f = (now) => { n++; if (street) window.__cam.player(8, ((now - t0) / ms) * 360, 12, 1.5); else window.__cam.orbit(o.x, o.y, o.z, o.dist, o.az + (now - t0) / 1000 * o.degPerSec, o.el); if (now - t0 >= ms) return res(); requestAnimationFrame(f); }; requestAnimationFrame(f); });
    return { frames: n, fps: +(n / (ms / 1000)).toFixed(1) };
  }, { ms: sec * 1000, street });
  const { profile } = await cdp.send("Profiler.stop");
  writeFileSync(out, JSON.stringify(profile));
  console.log(JSON.stringify(rec), "->", out);
  process.exit(0);
}

if (cmd === "snap") {
  const out = argv[1] || "/mnt/wbterminal1/tmp/claude-scratch/perf/sess-snap.jpg";
  const { pg } = await page();
  const url = await pg.evaluate(async () => {
    const r = window.liveScene3d.renderer, orig = r.render, cv = r.domElement;
    let last = null;
    r.render = function (...a) { const ret = orig.apply(this, a); if (r.getRenderTarget() === null) { try { last = cv.toDataURL("image/jpeg", 0.85); } catch (e) { last = String(e); } } return ret; };
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    r.render = orig;
    return last;
  });
  if (!url || !url.startsWith("data:")) { console.log("snap failed", String(url).slice(0, 200)); process.exit(1); }
  writeFileSync(out, Buffer.from(url.split(",")[1], "base64"));
  console.log("->", out);
  process.exit(0);
}

if (cmd === "tourprof") {
  // CPU profile across a teleport tour + in-page frame timestamps, correlated by a marker.
  const out = argv[1] || "/mnt/wbterminal1/tmp/claude-scratch/perf/sess-tour";
  const dest = (argv[2] || "0xACB40001,96,96,120").split(",");
  const holdMs = +(argv[3] || 25000);
  const { ctx, pg } = await page();
  const cdp = await ctx.newCDPSession(pg);
  await pg.evaluate(() => {
    window.__hbFrames = []; window.__hbRec = true;
    const f = (now) => { if (!window.__hbRec) return; window.__hbFrames.push(now); requestAnimationFrame(f); };
    requestAnimationFrame(f);
    window.__hbMark = function __hbMark() { const t = performance.now(); while (performance.now() - t < 25) {} return t; };
    try { window.__cam.release(); } catch (_) {}
  });
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
  await cdp.send("Profiler.start");
  const tMark = await pg.evaluate(() => window.__hbMark());
  if (dest[0] === "street") {
    // First-ever 360 deg third-person sweep at the player (cold views).
    await pg.evaluate(async (ms) => {
      const t0 = performance.now();
      await new Promise((res) => { const f = (now) => { window.__cam.player(8, ((now - t0) / ms) * 360, 12, 1.5); if (now - t0 >= ms) return res(); requestAnimationFrame(f); }; requestAnimationFrame(f); });
    }, holdMs);
  } else {
    const goCmd = dest[0].startsWith("poi:") ? `@telepoi ${dest[0].slice(4)}` : `@teleloc ${dest.join(" ")}`;
    await pg.evaluate((c) => window.__sessionHandle.sendChat(c), goCmd);
    await sleep(holdMs);
    await pg.evaluate((c) => window.__sessionHandle.sendChat(c), "@teleloc 0xA9B40001 96 96 80");
    await sleep(holdMs);
  }
  const { profile } = await cdp.send("Profiler.stop");
  const frames = await pg.evaluate(() => { window.__hbRec = false; return window.__hbFrames; });
  writeFileSync(out + ".cpuprofile", JSON.stringify(profile));
  writeFileSync(out + ".frames.json", JSON.stringify({ tMark, frames }));
  const d = frames.slice(1).map((t, i) => t - frames[i]);
  const s = [...d].sort((a, b) => a - b);
  const extra = await pg.evaluate(() => ({ asyncLink: window.__asyncLink ? { ...window.__asyncLink.stats, pending: window.__asyncLink.pending } : null, programs: window.liveScene3d?.renderer?.info?.programs?.length }));
  console.log(JSON.stringify(extra));
  console.log(JSON.stringify({ frames: d.length, fps: +(d.length / ((frames[frames.length - 1] - frames[0]) / 1000)).toFixed(1), p50: s[s.length >> 1], p99: s[Math.floor(s.length * 0.99)], max: s[s.length - 1], over50: d.filter((x) => x > 50).length, over100: d.filter((x) => x > 100).length, over250: d.filter((x) => x > 250).length }));
  process.exit(0);
}
console.log("unknown cmd");
process.exit(2);
