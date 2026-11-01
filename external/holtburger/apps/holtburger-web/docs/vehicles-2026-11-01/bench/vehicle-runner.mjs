// vehicle-runner.mjs — headless vehicle bench (successor of ../../drone-deploy-2026-10-24/carry-experiment/carry-runner.mjs).
//
// ONE heavy job: run it as
//   capped-build node vehicle-runner.mjs --plan plan-m1.json --out /mnt/wbterminal1/tmp/claude-scratch/vehicles/m1.json
// It refuses outside the `builds` cgroup and takes the shared heavy-job lock (harness/lib/heavy_lock.mjs).
//
// One headless Chromium (SwiftShader), up to two pages in separate contexts on the main serve (:8765):
//   * "pilot":    agentp10 with ?vehicles=on (the capable holtburger-web client);
//   * "observer": agentp09 WITHOUT the flag (a standard, non-capable client) and ?wireframe=1 — the CLAUDE.md
//                 rule allows one real-world tab plus wireframe tabs. It never announces the vehicle capability, so
//                 the server must never send it an HBV1 message (its wasm still counts any that arrive).
// Lessons from the carry runs: ?nullRender=1&hud=none at 960×540 with --disable-gpu-compositing (else SwiftShader
// throttles rAF to ~5 fps); stop below 900 MB MemAvailable; SwiftShader's slow boot can latch __bootState='error'
// on a healthy world (the boot gate below proceeds on live + pose + meshes and resets it); kill a stuck runner by its
// node PID with SIGKILL.
// Per plan step: optional teleport (@teleloc) on a page, optional chat lines, then an eval script (this folder) run
// in that page with the step as window.__vehicleRun; ACE WARN/ERROR lines, ACE CPU / RSS and Chromium CPU per step.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, statSync, openSync, readSync, closeSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HB = "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web";
const ACE_LOG = "/home/wbterminal/ace-server/Source/ACE.Server/bin/Release/net10.0/ACE_Log.txt";
const PLAYWRIGHT_CORE = process.env.PLAYWRIGHT_CORE || join(HB, "node_modules/playwright-core");
const { acquireHeavyLock } = await import(join(HB, "harness/lib/heavy_lock.mjs"));

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);
const planFile = opt("--plan", null);
if (!planFile) { console.error("--plan <file.json> required"); process.exit(2); }
const plan = JSON.parse(readFileSync(resolve(HERE, planFile), "utf8"));
const outFile = opt("--out", join("/mnt/wbterminal1/tmp/claude-scratch/vehicles", `${plan.name || "run"}-${Date.now()}.json`));
try { mkdirSync(dirname(outFile), { recursive: true }); } catch (_) { /* exists */ }
const base = opt("--base", plan.base || "http://127.0.0.1:8765");
const [vw, vh] = String(opt("--viewport", plan.viewport || "960x540")).split("x").map(Number);
const t0 = Date.now();
const log = (...m) => console.log(`[veh ${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cg = ""; try { cg = readFileSync("/proc/self/cgroup", "utf8"); } catch (_) { /* */ }
if (!/\/builds(\/|\n|$)/.test(cg) && !has("--allow-uncapped")) { console.error("REFUSED: run inside capped-build (headless Chrome on a real world is a heavy job)"); process.exit(2); }

const PRESET = "quality=high&csm=off&renderScale=1&adaptiveRes=off";
const SESSIONS = plan.sessions || [{ role: "pilot", account: "agentp10", flags: "vehicles=on" }];
const urlFor = (s) => `${base}/apps/holtburger-web/index.html?autoLogin=1&account=${s.account}&password=${encodeURIComponent(s.password || s.account)}` +
  `&autoSpawn=first&agent=1&nosw=1&portalSpace=off&hud=none&${PRESET}&nullRender=1&targetFps=0${s.flags ? "&" + s.flags : ""}`;

const res = { schema: "hb-vehicles-bench-v1", plan, viewport: [vw, vh], startedAt: new Date().toISOString(), sessions: {}, steps: [], errors: [] };
const save = () => { try { writeFileSync(outFile, JSON.stringify(res, null, 1)); } catch (e) { console.error("save failed", e); } };

function aceLogSize() { try { return statSync(ACE_LOG).size; } catch (_) { return 0; } }
function aceLogSince(off, all = false) {
  try {
    const size = statSync(ACE_LOG).size; if (size <= off) return [];
    const fd = openSync(ACE_LOG, "r"), n = Math.min(size - off, 4 << 20), buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, size - n); closeSync(fd);
    return buf.toString("utf8").split("\n")
      .filter((l) => all ? /VEHICLE|WARN|ERROR|MOVEMENT|Exception/.test(l) : /WARN|ERROR|MOVEMENT|Exception|PERFORMANCE|\[VEHICLE\]/.test(l))
      .filter((l) => !/PropertyManager|EventManager/.test(l)).slice(0, 120).map((l) => l.slice(0, 300));
  } catch (_) { return []; }
}
// the dotnet process itself (not a launcher shell whose command line also mentions ACE.Server.dll)
const acePid = (() => { for (const p of readdirSync("/proc")) { if (!/^\d+$/.test(p)) continue; try { const a = readFileSync(`/proc/${p}/cmdline`, "utf8").split("\0"); if (/dotnet$/.test(a[0]) && a[1] === "ACE.Server.dll") return +p; } catch (_) { /* */ } } return null; })();
const cpuTicks = (pid) => { try { const f = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" "); return +f[11] + +f[12]; } catch (_) { return null; } };
const rssMB = (pid) => { try { const m = readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/); return m ? Math.round(+m[1] / 1024) : null; } catch (_) { return null; } };
const chromeTicks = () => { let t = 0, rss = 0; for (const p of readdirSync("/proc")) { if (!/^\d+$/.test(p)) continue; try { const c = readFileSync(`/proc/${p}/cmdline`, "utf8"); if (!c.includes("chromium")) continue; t += cpuTicks(+p) || 0; rss += rssMB(+p) || 0; } catch (_) { /* gone */ } } return { t, rss }; };
const memAvailMB = () => { try { return Math.round(+readFileSync("/proc/meminfo", "utf8").match(/MemAvailable:\s+(\d+)/)[1] / 1024); } catch (_) { return null; } };
async function waitAccountFree(account, maxMs = 150000) {
  const re = new RegExp(`\\[(LOGIN|LOGOUT)\\] Account ${account} `);
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    let last = "";
    try { const size = statSync(ACE_LOG).size, n = Math.min(size, 1 << 20), fd = openSync(ACE_LOG, "r"), b = Buffer.alloc(n); readSync(fd, b, 0, n, size - n); closeSync(fd); last = b.toString("utf8").split("\n").filter((l) => re.test(l)).pop() || ""; } catch (_) { /* */ }
    if (!last || /\[LOGOUT\]/.test(last)) return "free";
    await sleep(2000);
  }
  return "still logged in";
}

const heavy = await acquireHeavyLock({ label: `vehicle-runner ${plan.name || ""}` });
res.heavyLock = { waitedMs: heavy.waitedMs };
for (const s of SESSIONS) res.sessions[s.role] = { account: s.account, accountWait: await waitAccountFree(s.account) };
log(`accounts ${JSON.stringify(res.sessions)}; memAvail ${memAvailMB()} MB; ACE pid ${acePid}`);
if (memAvailMB() < (plan.minStartMemMB || 2500)) { res.errors.push(`MemAvailable ${memAvailMB()} MB < ${plan.minStartMemMB || 2500} at start`); save(); process.exit(1); }

const require = createRequire(import.meta.url);
const { chromium } = require(PLAYWRIGHT_CORE);
let browser = null, code = 1;
const pages = {};
const hard = setTimeout(() => { res.errors.push("hard timeout"); save(); try { browser?.close(); } catch (_) { /* */ } setTimeout(() => process.exit(1), 4000).unref(); }, (plan.timeoutMin || 60) * 60000);
hard.unref();

async function bootPage(s) {
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh } });
  const page = await ctx.newPage();
  const rec = { consoleErrors: [], pageErrors: [], crash: null, vlog: [] };
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" && rec.consoleErrors.length < 300) rec.consoleErrors.push(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${t.slice(0, 300)}`);
    if (/\[vehicles\]/.test(t)) { log(`(${s.role}) ${t.slice(0, 200)}`); if (rec.vlog.length < 200) rec.vlog.push(t.slice(0, 300)); }
  });
  page.on("pageerror", (e) => { if (rec.pageErrors.length < 100) rec.pageErrors.push(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${String(e?.message ?? e).slice(0, 300)}`); });
  page.on("crash", () => { rec.crash = "PAGE CRASH (renderer died — OOM? see /var/log/earlyoom.log)"; });
  const url = urlFor(s);
  log(`(${s.role}) goto ${url.replace(/password=[^&]*/, "password=***")}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  const bootT = Date.now();
  let relogins = 0;
  for (;;) {
    if (rec.crash) throw new Error(rec.crash);
    const snap = await page.evaluate(() => {
      let pose = false, meshes = 0;
      try { const p = window.__sessionHandle?.getLocalPlayerPose?.(); pose = !!p; try { p?.free?.(); } catch (_) { /* */ } } catch (_) { /* */ }
      try { window.liveScene3d?.scene?.traverse((o) => { if (o.isMesh) meshes += 1; }); } catch (_) { /* */ }
      return { state: window.__bootState ?? null, live: !!window.liveScene3d, handle: !!window.__sessionHandle, pose, meshes,
        inFlight: typeof window.__autoLoginInFlight === "function" ? window.__autoLoginInFlight() : false,
        last: (window.__bootStateHistory || []).slice(-2).map((e) => `${e.state}:${e.message || ""}`).join(" | ") };
    }).catch(() => null);
    if (snap && snap.live && snap.handle && snap.pose && snap.meshes > (s.minMeshes ?? 100)) {
      if (snap.state === "error") {
        await page.evaluate(() => { window.__bootState = "ready"; }).catch(() => {});
        rec.bootErrorLatchReset = true;
      }
      rec.boot = { ms: Date.now() - bootT, meshes: snap.meshes, relogins };
      break;
    }
    if (snap && snap.state === "error" && !snap.inFlight && !(snap.live && snap.pose) && Date.now() - bootT > 60000 && relogins < 2) {
      relogins++;
      log(`(${s.role}) boot error (${snap.last}) — relogin ${relogins}`);
      await page.evaluate(() => { window.__runAutonomousLogin?.({ autoSpawn: "first", maxRetries: 1 }); }).catch(() => {});
    }
    if (Date.now() - bootT > 420000) throw new Error(`(${s.role}) boot timeout: ${JSON.stringify(snap)}`);
    await sleep(2000);
  }
  log(`(${s.role}) booted in ${(rec.boot.ms / 1000).toFixed(0)} s (${rec.boot.meshes} meshes)`);
  pages[s.role] = { page, rec, session: s };
  res.sessions[s.role].rec = rec;
}

try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM || "/usr/bin/chromium", headless: true,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--mute-audio", "--disable-gpu-compositing",
      "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
      "--disable-features=CalculateNativeWinOcclusion", "--js-flags=--max-old-space-size=2048 --expose-gc", ...(plan.chromeArgs || [])],
  });
  res.browserVersion = browser.version();
  for (const s of SESSIONS) {
    await bootPage(s);
    const p = pages[s.role].page;
    for (const c of s.setupChat || ["@cloak on"]) { await p.evaluate((m) => { try { window.__sessionHandle.sendChat(m); } catch (_) { /* */ } }, c); await sleep(1200); }
  }
  const chat = (role, m) => pages[role].page.evaluate((x) => { try { window.__sessionHandle.sendChat(x); return true; } catch (e) { return String(e); } }, m);
  const evalSrc = (f) => readFileSync(resolve(HERE, f), "utf8");

  for (const step of plan.steps) {
    const ma = memAvailMB();
    if (ma != null && ma < (plan.minMemAvailMB || 900)) { log(`MemAvailable ${ma} MB — stopping before ${step.label}`); res.errors.push(`stopped for memory before ${step.label} (${ma} MB)`); break; }
    const role = step.page || "pilot";
    const P = pages[role];
    if (!P) { res.errors.push(`no page ${role} for ${step.label}`); continue; }
    if (P.rec.crash) throw new Error(P.rec.crash);
    const rec = { name: step.label, role, t: Math.round((Date.now() - t0) / 1000) };
    res.steps.push(rec);
    log(`--- step ${step.label} (${role})`);
    try {
      if (step.teleloc) {
        await chat(role, `@teleloc ${step.teleloc}`);
        await sleep(step.afterTeleportMs ?? 9000);
      }
      for (const c of step.chat || []) { await chat(role, c); await sleep(step.chatGapMs ?? 1500); }
      if (step.sleepMs) await sleep(step.sleepMs);
      const logOff = aceLogSize(), aceC0 = cpuTicks(acePid), ch0 = chromeTicks(), tStep = Date.now();
      if (step.eval) {
        // window.__vehiclePrev = the result of the last step that returned one (e.g. the target the setup step made)
        await P.page.evaluate(([r, prev]) => { window.__vehicleRun = r; window.__vehiclePrev = prev; }, [step, res.lastResult ?? null]);
        rec.result = await P.page.evaluate(`(async () => { ${evalSrc(step.eval)}\n })()`);
        if (rec.result && rec.result.carry) res.lastResult = rec.result.carry;
      }
      const wall = Math.max(0.001, (Date.now() - tStep) / 1000), aceC1 = cpuTicks(acePid), ch1 = chromeTicks();
      rec.ace = { cpuPct: aceC0 != null && aceC1 != null ? +((((aceC1 - aceC0) / 100) / wall) * 100).toFixed(1) : null, rssMB: rssMB(acePid), log: aceLogSince(logOff) };
      rec.chrome = { cpuPct: +((((ch1.t - ch0.t) / 100) / wall) * 100).toFixed(1), rssMB: ch1.rss };
      rec.memAvailMB = memAvailMB();
      log(`${step.label}: ${JSON.stringify(rec.result?.summary ?? rec.result ?? null).slice(0, 1200)}`);
      log(`ACE cpu ${rec.ace.cpuPct}% rss ${rec.ace.rssMB} MB, ${rec.ace.log.length} log lines; memAvail ${rec.memAvailMB} MB; chrome cpu ${rec.chrome.cpuPct}% rss ${rec.chrome.rssMB} MB`);
      for (const l of rec.ace.log.filter((x) => /WARN|ERROR|MOVEMENT|PERFORMANCE/.test(x)).slice(0, 8)) log(`  ACE: ${l.slice(0, 200)}`);
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
  res.endedAt = new Date().toISOString();
  save();
  try { if (browser) await browser.close(); } catch (_) { /* */ }
  log(`out ${outFile} (exit ${code})`);
}
process.exit(code);
