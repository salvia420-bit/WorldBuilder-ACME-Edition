// carry-runner.mjs — headless driver for the drone-carries-the-player experiment (hb-carry copy, 2026-10-31).
//
// ONE heavy job: run it as
//   capped-build node carry-runner.mjs --plan plan.json --out result.json [--render] [--account agentp10]
// It refuses outside the `builds` cgroup and takes the shared heavy-job lock (harness/lib/heavy_lock.mjs).
//
// One headless Chromium (SwiftShader), one page on the hb-carry serve (:8766) with the owner's play preset
// as in the 1070 drone eye test E7 (quality=high, csm=off, renderScale=1, adaptiveRes=off) + the experiment
// flags (droneCarry, droneDebug, droneAudio=off, camDebug, portalSpace=off). Default is ?nullRender=1 (the sim,
// streaming and net run; no GPU submission) — --render drops it for the real-render draw census.
// Boot (laptop-structure-probe's gate), @cloak on, then per plan step: teleport to the step's start (if any),
// settle, evaluate the page script (carry-flight.eval.js or carry-census.eval.js) with the step as
// window.__carryRun, abort the drone, wait for idle; ACE log lines and ACE / Chromium CPU per step.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, statSync, openSync, readSync, closeSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HB = "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web";
const ACE_LOG = "/home/wbterminal/ace-server/Source/ACE.Server/bin/Release/net10.0/ACE_Log.txt";
const PLAYWRIGHT_CORE = process.env.PLAYWRIGHT_CORE || join(HB, "node_modules/playwright-core");
const { acquireHeavyLock } = await import(join(HB, "harness/lib/heavy_lock.mjs"));
const { classifyBoot, formatBootHistory } = await import(join(HB, "harness/moving-bench.mjs"));

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);
const planFile = opt("--plan", null);
if (!planFile) { console.error("--plan <file.json> required"); process.exit(2); }
const plan = JSON.parse(readFileSync(planFile, "utf8"));
const outFile = opt("--out", join(HERE, `carry-${Date.now()}.json`));
const account = opt("--account", plan.account || "agentp10");
const base = opt("--base", "http://127.0.0.1:8766");
const render = has("--render") || plan.render === true;
const [vw, vh] = String(opt("--viewport", plan.viewport || "1920x1080")).split("x").map(Number);
const t0 = Date.now();
const log = (...m) => console.log(`[carry ${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cg = ""; try { cg = readFileSync("/proc/self/cgroup", "utf8"); } catch (_) { /* */ }
if (!/\/builds(\/|\n|$)/.test(cg) && !has("--allow-uncapped")) { console.error("REFUSED: run inside capped-build (headless Chrome on a real world is a heavy job)"); process.exit(2); }

// The 1070 drone eye test (E7, 2026-10-24: FPV flying 96 fps) ran exactly these play flags.
const PRESET = "quality=high&csm=off&renderScale=1&adaptiveRes=off";
const EXP = "droneCarry=on&droneDebug=on&droneAudio=off&camDebug=on&portalSpace=off" + (plan.carryKmh ? `&droneCarryKmh=${plan.carryKmh}` : "") + (plan.carryAccel ? `&droneCarryAccel=${plan.carryAccel}` : "");
const url = `${base}/apps/holtburger-web/index.html?autoLogin=1&account=${account}&password=${encodeURIComponent(plan.password || account)}&autoSpawn=first&agent=1&nosw=1&${PRESET}&${EXP}${render ? "" : "&nullRender=1"}${plan.extraFlags ? "&" + plan.extraFlags : ""}&targetFps=0`;

const res = { schema: "hb-carry-v1", plan, account, render, viewport: [vw, vh], url: url.replace(/password=[^&]*/, "password=***"), startedAt: new Date().toISOString(), steps: [], errors: [] };
const save = () => { try { writeFileSync(outFile, JSON.stringify(res, null, 1)); } catch (e) { console.error("save failed", e); } };

function aceLogSize() { try { return statSync(ACE_LOG).size; } catch (_) { return 0; } }
function aceLogSince(off) {
  try {
    const size = statSync(ACE_LOG).size; if (size <= off) return [];
    const fd = openSync(ACE_LOG, "r"), n = Math.min(size - off, 4 << 20), buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, size - n); closeSync(fd);
    return buf.toString("utf8").split("\n").filter((l) => /WARN|ERROR|MOVEMENT|Exception|speed|Speed/.test(l) && !/PropertyManager|EventManager/.test(l)).slice(0, 60).map((l) => l.slice(0, 300));
  } catch (_) { return []; }
}
const acePid = (() => { for (const p of readdirSync("/proc")) { if (!/^\d+$/.test(p)) continue; try { const c = readFileSync(`/proc/${p}/cmdline`, "utf8"); if (c.includes("ACE.Server.dll")) return +p; } catch (_) { /* */ } } return null; })();
const cpuTicks = (pid) => { try { const f = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" "); return +f[11] + +f[12]; } catch (_) { return null; } };
const rssMB = (pid) => { try { const m = readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/); return m ? Math.round(+m[1] / 1024) : null; } catch (_) { return null; } };
const chromeTicks = () => { let t = 0, rss = 0; for (const p of readdirSync("/proc")) { if (!/^\d+$/.test(p)) continue; try { const c = readFileSync(`/proc/${p}/cmdline`, "utf8"); if (!c.includes("chromium")) continue; t += cpuTicks(+p) || 0; rss += rssMB(+p) || 0; } catch (_) { /* gone */ } } return { t, rss }; };
const gpuTicks = () => { for (const p of readdirSync("/proc")) { if (!/^\d+$/.test(p)) continue; try { const c = readFileSync(`/proc/${p}/cmdline`, "utf8"); if (c.includes("chromium") && c.includes("--type=gpu-process")) return cpuTicks(+p); } catch (_) { /* */ } } return null; };
const memAvailMB = () => { try { return Math.round(+readFileSync("/proc/meminfo", "utf8").match(/MemAvailable:\s+(\d+)/)[1] / 1024); } catch (_) { return null; } };
function waitAccountFree(maxMs = 150000) {
  const re = new RegExp(`\\[(LOGIN|LOGOUT)\\] Account ${account} `);
  const end = Date.now() + maxMs;
  return (async () => {
    while (Date.now() < end) {
      let last = "";
      try { const size = statSync(ACE_LOG).size, n = Math.min(size, 1 << 20), fd = openSync(ACE_LOG, "r"), b = Buffer.alloc(n); readSync(fd, b, 0, n, size - n); closeSync(fd); last = b.toString("utf8").split("\n").filter((l) => re.test(l)).pop() || ""; } catch (_) { /* */ }
      if (!last || /\[LOGOUT\]/.test(last)) return "free";
      await sleep(2000);
    }
    return "still logged in";
  })();
}

const heavy = await acquireHeavyLock({ label: `carry-runner ${plan.name || ""}` });
res.heavyLock = { waitedMs: heavy.waitedMs };
res.accountWait = await waitAccountFree();
log(`account ${account}: ${res.accountWait}; memAvail ${memAvailMB()} MB; ACE pid ${acePid}`);

const require = createRequire(import.meta.url);
const { chromium } = require(PLAYWRIGHT_CORE);
let browser = null, code = 1;
const consoleErrors = [], pageErrors = [];
const hard = setTimeout(() => { res.errors.push("hard timeout"); save(); try { browser?.close(); } catch (_) { /* */ } setTimeout(() => process.exit(1), 4000).unref(); }, (plan.timeoutMin || 90) * 60000);
hard.unref();
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM || "/usr/bin/chromium", headless: true,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--mute-audio",
      "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
      "--disable-features=CalculateNativeWinOcclusion", "--js-flags=--max-old-space-size=2048 --expose-gc", ...(plan.chromeArgs || [])],
  });
  res.browserVersion = browser.version();
  const ctxB = await browser.newContext({ viewport: { width: vw, height: vh } });
  if (plan.initScript) await ctxB.addInitScript({ path: resolve(HERE, plan.initScript) });
  const page = await ctxB.newPage();
  page.on("console", (m) => { const t = m.text(); if (m.type() === "error" && consoleErrors.length < 400) consoleErrors.push(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${t.slice(0, 300)}`); if (/\[drone|\[carry/.test(t)) log(t.slice(0, 200)); });
  page.on("pageerror", (e) => { if (pageErrors.length < 100) pageErrors.push(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${String(e?.message ?? e).slice(0, 300)}`); });
  let crashErr = null; page.on("crash", () => { crashErr = new Error("PAGE CRASH (renderer died — OOM? see /var/log/earlyoom.log)"); pageErrors.push("PAGE CRASH"); });
  log(`goto ${res.url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  const bootT = Date.now(); let attempt = 0, snap = null;
  for (;;) {
    if (crashErr) throw crashErr;
    snap = await page.evaluate(() => {
      let pose = false, meshes = 0;
      try { const p = window.__sessionHandle?.getLocalPlayerPose?.(); pose = !!p; try { p?.free?.(); } catch (_) { /* */ } } catch (_) { /* */ }
      try { window.liveScene3d?.scene?.traverse((o) => { if (o.isMesh) meshes += 1; }); } catch (_) { /* */ }
      return { state: window.__bootState ?? null, history: (window.__bootStateHistory || []).map((e) => ({ state: e.state, message: e.message || "" })),
        sceneReadyEverFired: !!window.__sceneReadyEverFired, inFlight: typeof window.__autoLoginInFlight === "function" ? window.__autoLoginInFlight() : false,
        live: !!window.liveScene3d, handle: !!window.__sessionHandle, pose, meshes };
    }).catch(() => null);
    const d = classifyBoot(snap, { attempt, maxAttempts: 2 });
    if (d.action === "fatal") throw new Error(`boot failed: ${d.reason}\n${formatBootHistory(snap)}`);
    if (d.action === "relogin") { attempt++; log(`boot error (${d.reason}) — relogin ${attempt}`); await sleep(9000); await page.evaluate(() => { window.__runAutonomousLogin?.({ autoSpawn: "first", maxRetries: 1 }); }).catch(() => {}); continue; }
    if (d.action === "go" && snap.live && snap.handle && snap.pose && snap.meshes > 100) break;
    if (Date.now() - bootT > 420000) throw new Error(`boot timeout (${d.reason}; live=${snap?.live} pose=${snap?.pose} meshes=${snap?.meshes})\n${formatBootHistory(snap)}`);
    await sleep(2000);
  }
  res.boot = { ms: Date.now() - bootT, relogins: attempt, meshes: snap.meshes };
  log(`booted in ${(res.boot.ms / 1000).toFixed(0)} s (${snap.meshes} meshes)`);
  const hud = await page.evaluate(async () => { try { return await window.__droneHud?.load?.(); } catch (e) { return { ok: false, err: String(e) }; } });
  res.droneLoad = hud;
  log("drone module", JSON.stringify(hud));
  const chat = (s) => page.evaluate((m) => { try { window.__sessionHandle.sendChat(m); return true; } catch (e) { return String(e); } }, s);
  for (const c of plan.setupChat || ["@cloak on"]) { await chat(c); await sleep(1500); }
  const evalSrc = (f) => readFileSync(resolve(HERE, f), "utf8");
  const pose = () => page.evaluate(() => { try { const p = window.__sessionHandle.getLocalPlayerPose(); const r = { lb: "0x" + (p.landblockId >>> 0).toString(16), x: p.x, y: p.y, z: p.z }; p.free?.(); return r; } catch (e) { return null; } });
  const settle = async (maxSec, quietSec) => {
    const tS = Date.now(); let lastSig = "", quietSince = Date.now();
    while (Date.now() - tS < maxSec * 1000) {
      const sig = await page.evaluate(() => { const L = window.liveScene3d; let n = 0; try { L.scene.traverse((o) => { if (o.isMesh) n++; }); } catch (_) { /* */ } return `${L?.terrainBakedLbs?.size ?? 0}/${Math.round(n / 50)}`; }).catch(() => "");
      if (sig !== lastSig) { lastSig = sig; quietSince = Date.now(); }
      if (Date.now() - quietSince > quietSec * 1000) return { sec: Math.round((Date.now() - tS) / 1000), sig, quiet: true };
      await sleep(2000);
    }
    return { sec: maxSec, sig: lastSig, quiet: false };
  };
  for (const step of plan.steps) {
    if (crashErr) throw crashErr;
    const ma = memAvailMB();
    if (ma != null && ma < (plan.minMemAvailMB || 900)) { log(`MemAvailable ${ma} MB < ${plan.minMemAvailMB || 900} MB — stopping the session before ${step.label}`); res.errors.push(`stopped for memory before ${step.label} (${ma} MB)`); break; }
    const rec = { name: step.label, step, t: Math.round((Date.now() - t0) / 1000) };
    res.steps.push(rec);
    log(`--- step ${step.label}`);
    try {
      if (step.teleloc) {
        await page.evaluate(() => { try { const D = window.__drone; if (D && D.status().state !== "idle") (D.debug ? D.debug.trigger("pilotMoved") : D.abort("user")); } catch (_) { /* */ } });
        await sleep(2500);
        await chat(`@teleloc ${step.teleloc}`);
        await sleep(6000);
        rec.arrive = await pose();
        rec.settle = await settle(step.settleMaxSec ?? 150, step.quietSec ?? 15);
        log(`at ${JSON.stringify(rec.arrive)} settle ${JSON.stringify(rec.settle)}`);
      }
      const logOff = aceLogSize(), aceC0 = cpuTicks(acePid), ch0 = chromeTicks(), gp0 = gpuTicks(), tStep = Date.now();
      rec.heapBeforeMB = await page.evaluate(() => { try { window.gc?.(); window.gc?.(); } catch (_) { /* */ } return performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null; }).catch(() => null);
      await page.evaluate((r) => { window.__carryRun = r; }, step);
      rec.result = await page.evaluate(`(async () => { ${evalSrc(step.eval || "carry-flight.eval.js")}\n })()`);
      const wall = (Date.now() - tStep) / 1000, aceC1 = cpuTicks(acePid);
      rec.ace = { cpuPct: aceC0 != null && aceC1 != null ? +((((aceC1 - aceC0) / 100) / wall) * 100).toFixed(1) : null, rssMB: rssMB(acePid), log: aceLogSince(logOff) };
      rec.memAvailMB = memAvailMB();
      const ch1 = chromeTicks(), gp1 = gpuTicks();
      rec.chrome = { cpuPct: +((((ch1.t - ch0.t) / 100) / wall) * 100).toFixed(1), gpuProcCpuPct: gp0 != null && gp1 != null ? +((((gp1 - gp0) / 100) / wall) * 100).toFixed(1) : null, rssMB: ch1.rss };
      try { rec.cgroupMB = Math.round(+readFileSync("/sys/fs/cgroup/dev/builds/memory.current", "utf8") / 1048576); } catch (_) { /* */ }
      const s = rec.result?.summary;
      log(`${step.label}: ${rec.result?.fatal ?? ""} ${JSON.stringify(s ?? rec.result?.errors ?? null).slice(0, 900)}`);
      log(`ACE cpu ${rec.ace.cpuPct}% rss ${rec.ace.rssMB} MB, log lines ${rec.ace.log.length}; memAvail ${rec.memAvailMB} MB; chrome cpu ${rec.chrome.cpuPct}% (gpu-proc ${rec.chrome.gpuProcCpuPct}%) rss ${rec.chrome.rssMB} MB; cgroup ${rec.cgroupMB} MB`);
      if (step.abortAfter !== false) {
        await page.evaluate(() => { try { const D = window.__drone; if (D && D.status().state !== "idle") (D.debug ? D.debug.trigger("pilotMoved") : D.abort("user")); } catch (_) { /* */ } });
        const tA = Date.now();
        while (Date.now() - tA < 30000) { const s2 = await page.evaluate(() => window.__drone?.status?.().state).catch(() => null); if (s2 === "idle") break; await sleep(1000); }
      }
    } catch (e) {
      rec.error = String(e?.stack ?? e).slice(0, 800);
      log(`step error: ${rec.error.split("\n")[0]}`);
    }
    save();
  }
  code = 0;
} catch (e) {
  res.errors.push(String(e?.stack ?? e).slice(0, 1500));
  log("ERROR", String(e?.message ?? e).split("\n")[0]);
} finally {
  clearTimeout(hard);
  res.consoleErrors = consoleErrors; res.pageErrors = pageErrors; res.endedAt = new Date().toISOString();
  save();
  try { if (browser) await browser.close(); } catch (_) { /* */ }
  log(`out ${outFile} (exit ${code})`);
}
process.exit(code);
