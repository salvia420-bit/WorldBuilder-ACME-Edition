// hbbench.mjs — interleaved fresh-profile 1070 bench against a FROZEN snapshot server.
//   node hbbench.mjs --arms arms.json --reps 2 --port 8766 --out DIR
// arms.json: [{name, quality, flags}]. Per run: boot -> Holtburg -> settle -> FIRST TURN (12 s
// third-person 360 sweep) -> orbit warm-up -> STILL 20 s + MOVING 20 s (orbit) -> cold teleport tour
// (poi:Shoushi 35 s, back 35 s).
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const BOX = "young@100.127.215.75", CDP = "http://127.0.0.1:9333";
const ACE_LOG = "/home/wbterminal/ace-server/Source/ACE.Server/bin/Release/net10.0/ACE_Log.txt";
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ARMS = JSON.parse(readFileSync(opt("--arms"), "utf8"));
const REPS = +opt("--reps", 2), PORT = opt("--port", "8766");
const TOUR = opt("--tour", "poi:Shoushi"), HOLD = +opt("--hold", 35000);
const OUT = opt("--out", `/mnt/wbterminal1/tmp/claude-scratch/perf/hbbench-${Date.now()}`);
mkdirSync(OUT, { recursive: true });
const APP = `http://127.0.0.1:${PORT}/apps/holtburger-web/index.html`;
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ssh = (c) => execFileSync("ssh", ["-o", "BatchMode=yes", BOX, c], { encoding: "utf8", timeout: 60000 });
const killBench = () => { try { ssh("powershell -NoProfile -ExecutionPolicy Bypass -File D:\\Temp\\hbbench\\hbbench-kill.ps1"); } catch (_) {} };
function aceTail(bytes = 262144) { const size = statSync(ACE_LOG).size, fd = openSync(ACE_LOG, "r"); const b = Buffer.alloc(Math.min(bytes, size)); readSync(fd, b, 0, b.length, size - b.length); closeSync(fd); return b.toString("utf8"); }
async function waitAccountFree(maxMs = 150000) { const end = Date.now() + maxMs; while (Date.now() < end) { const ev = aceTail().split("\n").filter((l) => /\[(LOGIN|LOGOUT)\] Account tailnet1 /.test(l)); const last = ev[ev.length - 1]; if (!last || /\[LOGOUT\]/.test(last)) return true; await sleep(2000); } return false; }

const FRAMES = async ({ ms, orbit }) => {
  const d = []; let last = null; const tS = performance.now();
  await new Promise((res) => { const f = (now) => { if (last !== null) d.push(now - last); last = now; if (orbit) window.__cam.orbit(orbit.x, orbit.y, orbit.z, orbit.dist, orbit.az + (now - tS) / 1000 * orbit.degPerSec, orbit.el); if (now - tS >= ms) return res(); requestAnimationFrame(f); }; requestAnimationFrame(f); });
  return d;
};
function stats(d) {
  if (!d || !d.length) return null;
  const s = [...d].sort((a, b) => a - b), n = s.length, sum = d.reduce((a, b) => a + b, 0);
  const q = (p) => +s[Math.min(n - 1, Math.floor(p * n))].toFixed(1);
  const lowOf = (f) => { const w = s.slice(Math.floor(n * (1 - f))); return +(1000 / (w.reduce((a, b) => a + b, 0) / w.length)).toFixed(1); };
  return { n, fps: +(n / (sum / 1000)).toFixed(1), p50: q(0.5), p95: q(0.95), p99: q(0.99), max: +s[n - 1].toFixed(0), low1: lowOf(0.01), low01: lowOf(0.001),
    h50: d.filter((x) => x > 50).length, h100: d.filter((x) => x > 100).length, h250: d.filter((x) => x > 250).length,
    jankMs: Math.round(d.filter((x) => x > 50).reduce((a, x) => a + x - 33.3, 0)) };
}

async function runOne(arm, rep) {
  const res = { arm: arm.name, rep, flags: arm.flags, quality: arm.quality };
  res.accountFree = await waitAccountFree();
  killBench();
  ssh(`echo hbb-bench-${arm.name}-${rep}-${Date.now()}> D:\\Temp\\hbbench\\profile.txt`);
  ssh("echo 1280,720> D:\\Temp\\hbbench\\winsize.txt");
  ssh('schtasks /create /tn hbprobe /tr "D:\\Temp\\hbbench\\hbprobe-launch.bat" /sc once /st 00:00 /it /f >nul 2>nul & schtasks /run /tn hbprobe >nul');
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${CDP}/json/version`)).ok) break; } catch (_) {} await sleep(1000); }
  const browser = await chromium.connectOverCDP(CDP);
  const errors = [];
  try {
    const ctx = browser.contexts()[0]; const pg = ctx.pages()[0] || (await ctx.newPage());
    pg.on("pageerror", (e) => errors.push(String(e?.message ?? e).slice(0, 200)));
    pg.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
    const url = `${APP}?autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first&nosw=1&camDebug=on&adaptiveRes=off&quality=${arm.quality || "mid"}${arm.flags ? "&" + arm.flags : ""}`;
    await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    res.gpu = await pg.evaluate(() => { const gl = document.createElement("canvas").getContext("webgl2"); const e = gl.getExtension("WEBGL_debug_renderer_info"); return gl.getParameter(e.UNMASKED_RENDERER_WEBGL); });
    if (!/1070/.test(res.gpu)) throw new Error("not on 1070");
    await pg.evaluate(async () => { try { window.__benchWake = await navigator.wakeLock.request("screen"); } catch (_) {} });
    const bootT = Date.now(); let ok = false;
    for (let i = 0; i < 150 && !ok; i++) { ok = await pg.evaluate(() => !!window.liveScene3d && !!window.__sessionHandle && (window.__bootStateHistory || []).some((s) => (s.state || s) === "ready")).catch(() => false); if (!ok) await sleep(1000); }
    res.bootMs = Date.now() - bootT;
    if (!ok) throw new Error("boot never ready");
    await sleep(5000);
    await pg.evaluate(() => window.__sessionHandle.sendChat("@teleloc 0xA9B40001 96 96 80"));
    await sleep(8000);
    let last = null, since = Date.now(); const ts = Date.now();
    while (Date.now() - ts < 150000) { const cur = await pg.evaluate(() => `${window.__landblockLru?.entries?.size}|${window.liveScene3d?.renderer?.info?.memory?.geometries}`).catch(() => null); if (cur !== last) { last = cur; since = Date.now(); } else if (Date.now() - since >= 12000) break; await sleep(1000); }
    // FIRST TURN: the first third-person 360-degree sweep after the world settles (cold views:
    // first-sight programs, uploads). --no-first-turn skips it.
    if (!argv.includes("--no-first-turn")) {
      res.firstTurn = stats(await pg.evaluate(async (ms) => {
        try { window.__cam.release(); } catch (_) {}
        const d = []; let last = null; const t0 = performance.now();
        await new Promise((res) => { const f = (now) => { if (last !== null) d.push(now - last); last = now; window.__cam.player(8, ((now - t0) / ms) * 360, 12, 1.5); if (now - t0 >= ms) return res(); requestAnimationFrame(f); }; requestAnimationFrame(f); });
        return d;
      }, 12000));
      await sleep(2000);
    }
    const pose = await pg.evaluate(() => window.__cam.world());
    const orbit = { x: pose.x, y: pose.y, z: pose.z + 1.5, dist: 70, az: 45, el: 22, degPerSec: 12 };
    await pg.evaluate(FRAMES, { ms: 25000, orbit });
    await pg.evaluate((o) => window.__cam.orbit(o.x, o.y, o.z, o.dist, o.az, o.el), orbit);
    await sleep(3000);
    res.still = stats(await pg.evaluate(FRAMES, { ms: 20000, orbit: null }));
    res.moving = stats(await pg.evaluate(FRAMES, { ms: 20000, orbit }));
    res.draws = await pg.evaluate(async () => { const r = window.liveScene3d.renderer, p = r.info.autoReset; r.info.autoReset = false; r.info.reset(); let f = 0; await new Promise((res) => { const t = performance.now(); const k = (n) => { f++; if (n - t > 2000) return res(); requestAnimationFrame(k); }; requestAnimationFrame(k); }); const c = r.info.render.calls; r.info.autoReset = p; return Math.round(c / f); });
    // cold teleport tour, camera following the player
    await pg.evaluate(() => { try { window.__cam.release(); } catch (_) {} window.__hbF = []; window.__hbRec = true; const f = (n) => { if (!window.__hbRec) return; window.__hbF.push(n); requestAnimationFrame(f); }; requestAnimationFrame(f); });
    const go = TOUR.startsWith("poi:") ? `@telepoi ${TOUR.slice(4)}` : `@teleloc ${TOUR.split(",").join(" ")}`;
    await pg.evaluate((c) => window.__sessionHandle.sendChat(c), go);
    await sleep(HOLD);
    await pg.evaluate(() => window.__sessionHandle.sendChat("@teleloc 0xA9B40001 96 96 80"));
    await sleep(HOLD);
    const fr = await pg.evaluate(() => { window.__hbRec = false; return window.__hbF; });
    res.tour = stats(fr.slice(1).map((t, i) => t - fr[i]));
    res.extra = await pg.evaluate(() => ({ asyncLink: window.__asyncLink ? { ...window.__asyncLink.stats } : null, occ: window.__occlusionCull?.stats ?? null, programs: window.liveScene3d.renderer.info.programs.length }));
  } catch (e) { res.error = String(e?.message ?? e); }
  finally {
    res.errors = errors.slice(0, 30);
    writeFileSync(join(OUT, `${arm.name}-r${rep}.json`), JSON.stringify(res, null, 1));
    try { await browser.close(); } catch (_) {}
    killBench();
  }
  return res;
}
const all = [];
for (let rep = 1; rep <= REPS; rep++) {
  const order = ARMS.map((_, i) => ARMS[(i + rep - 1) % ARMS.length]);
  for (const arm of order) {
    log(`run ${arm.name} r${rep}`);
    const r = await runOne(arm, rep);
    all.push(r);
    const f = (x) => x ? `${x.fps}fps p99 ${x.p99} low1 ${x.low1}` : "-";
    log(`  ${r.error ? "ERROR " + r.error : "ok"} | firstTurn ${r.firstTurn ? `${r.firstTurn.fps}fps jank ${r.firstTurn.jankMs} h100 ${r.firstTurn.h100} max ${r.firstTurn.max}` : "-"} | still ${f(r.still)} | moving ${f(r.moving)} | draws ${r.draws} | tour ${r.tour ? `fps ${r.tour.fps} jank ${r.tour.jankMs} h100 ${r.tour.h100} h250 ${r.tour.h250} max ${r.tour.max} low1 ${r.tour.low1} low01 ${r.tour.low01}` : "-"} | errs ${r.errors.length}`);
    writeFileSync(join(OUT, "summary.json"), JSON.stringify(all, null, 1));
  }
}
log("out", OUT);
process.exit(0);
