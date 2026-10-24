// laptop-structure-probe.mjs — the LAPTOP structural twin of the GPU-resident statics P0
// arms 1 and 3 (apps/holtburger-web/docs/HANDOFF-gpu-resident-statics-2026-10-22.md §7 P0).
// NOT a timing arm. Written 2026-10-22 as P0 preparation; first runs the same day (the dated
// notes below are what they taught).
//
// RUN IT ONLY UNDER capped-build (~/CLAUDE.md: a headless Chrome on a real world is a heavy
// job — one at a time, inside the 3.5 GB cgroup, with >= 2.5 GB available). It refuses to
// start outside the `builds` cgroup (--allow-uncapped exists for a machine without that
// cgroup — never this laptop) and takes the shared heavy-job lock
// (apps/holtburger-web/harness/lib/heavy_lock.mjs) before it launches anything:
//
//   capped-build node scripts/perf-worker/laptop-structure-probe.mjs --town both --label bare
//   capped-build node scripts/perf-worker/laptop-structure-probe.mjs --town holtburg --label pools \
//     --flags 'packSource=on&geomBundles=on&texCompressedOnly=on&slotGrid=on&frameWork=on&drawPools=on'
//
// WHY A LAPTOP TWIN. The laptop renders with SwiftShader, so its timings mean nothing
// (walls row 101). But the counts P0 needs first are STRUCTURAL — how many multidraw ranges
// three asks for and how many reach the driver per frame, which buckets sort, which keep
// per-instance culling, how many distinct ranges an atlas bucket holds — and those are the
// same for the same URL, pose and dist on any GPU. Reading them here costs no 1070 session,
// settles handoff F4 (sorted vs unsorted slots) and sizes F2 (atlas range repeats) before
// the owner's run, and tells arm 3 (the drawPools chain) whether it even boots on HEAD.
//
// WHAT IT DOES. One headless Chromium (/usr/bin/chromium, SwiftShader — the
// harness/glsl_smoke/batched_runs_smoke.mjs launch), ONE context, ONE page:
//   1. index.html with the boot contract the perf-worker drivers use (autoLogin, autoSpawn,
//      agent=1, nosw=1, camDebug=on, adaptiveRes=off) plus renderDiag=on and the quality
//      preset (ultra by default, as P0), then the arm's --flags; targetFps=0 last
//      (lib/bench-url.mjs). Never wireframe / nullRender / renderOnDemand: the first swaps
//      every material (other buckets), the other two skip or starve the renders being
//      counted — --flags refuses them.
//   2. Boot gate on window.__bootStateHistory through moving-bench's classifyBoot (never the
//      shared scalar: ready / in-world share it, and SwiftShader's 90 s scene-ready watchdog
//      latches `error` on a healthy session), relogin through __runAutonomousLogin on a
//      pre-in-world error, then wait for window.liveScene3d (it lands ~35 s after in-world),
//      a pose, and more than 100 meshes.
//   3. Evaluate scripts/perf-worker/structure-p0.eval.js — the SAME page-side read the 1070
//      arms run through `hbsess.mjs eval` — with laptop options: @teleloc to each town,
//      settle (terrain + static node / instance counts quiet), park the fixed orbit, hold a
//      few frames, census. --path adds the fixed @teleloc path (a lite census per stop).
//      One page.evaluate PER TOWN, --out rewritten after each (2026-10-23), so a renderer
//      crash or the hard timeout in the second town keeps the first town's census.
//   4. Write --out, close the browser, exit: 0 ok · 1 failed (boot, eval, hard timeout) ·
//      2 refused (not capped, bad flags, serve.py down) · 3 finished but a town did not
//      settle or errored, or a census was held while the portal tunnel ran.
//   --timeout-min defaults to the worst case the eval options allow (hardTimeoutMin).
//
// Account: a bot (default agentp10, password = account name). agentp07..10 are Developer
// accounts (accessLevel 4, read from ace_auth 2026-10-22), which @teleloc needs; tailnet1 is
// the owner's own account and is never a default here.

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, openSync, readSync, closeSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// 2026-10-20: every URL pins ?targetFps=0 (lib/bench-url.mjs says why).
import { uncappedBenchUrl } from "./lib/bench-url.mjs";
import { acquireHeavyLock } from "../../apps/holtburger-web/harness/lib/heavy_lock.mjs";
import { classifyBoot, formatBootHistory } from "../../apps/holtburger-web/harness/moving-bench.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const APP_DIR = join(REPO, "apps", "holtburger-web");
export const EVAL_FILE = join(HERE, "structure-p0.eval.js");
const PLAYWRIGHT_CORE = process.env.PLAYWRIGHT_CORE || "/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core";
const ACE_LOG = "/home/wbterminal/ace-server/Source/ACE.Server/bin/Release/net10.0/ACE_Log.txt";

export const TOWN_CHOICES = { holtburg: ["holtburg"], linvak: ["linvak"], both: ["holtburg", "linvak"] };
/** The 1070 test Chrome's page size (see the newContext call). */
export const VIEWPORT = { width: 1280, height: 633 };

// The base query, in the order the URL gets it. --flags may repeat a key only with the
// same value; anything else would leave the page reading the FIRST copy (URLSearchParams).
// The portal tunnel stays ON (2026-10-22). On SwiftShader the post-@teleloc tunnel outlives
// any settle wait, and while it owns the frame the world submission is skipped — the first
// run's census counted the tunnel (27 building ranges; chunk buckets never reached
// onBeforeRender). `?portalSpace=off` fixed that but made every streaming frame a full world
// render, and the renderer + GPU process then crossed earlyoom on 8 GB. So the world streams
// under the tunnel and the eval ends it right before the census (endTunnelBeforeCensus).
const BASE_KEYS = ["autoLogin", "account", "password", "autoSpawn", "agent", "nosw", "camDebug", "adaptiveRes", "renderDiag", "quality"];
// wireframe swaps every material (other buckets, other counts); nullRender skips render();
// renderOnDemand renders only on request — the probe counts what a normal frame draws.
export const REFUSED_FLAGS = ["wireframe", "nullRender", "renderOnDemand"];

/** The arm's --flags string, checked: base keys only with the base value (dropped), the
 *  refused keys never. Kept byte for byte otherwise (no re-encoding). */
export function normalizeFlags(flags, base) {
  const raw = String(flags || "").replace(/^[?&]+/, "");
  if (!raw) return "";
  const keep = [];
  for (const seg of raw.split("&")) {
    if (!seg) continue;
    const eq = seg.indexOf("=");
    const key = decodeURIComponent(eq < 0 ? seg : seg.slice(0, eq));
    const val = eq < 0 ? "" : decodeURIComponent(seg.slice(eq + 1));
    if (REFUSED_FLAGS.includes(key)) throw new Error(`--flags: ${key} changes what is drawn or skips the render — not a structural arm`);
    if (key in base) {
      if (String(base[key]) !== val) throw new Error(`--flags: ${key}=${val} conflicts with the probe's ${key}=${base[key]} (use --quality / --account)`);
      continue;
    }
    keep.push(seg);
  }
  return keep.join("&");
}

/** index.html URL for one arm, BEFORE uncappedBenchUrl (which the goto site applies). */
export function buildProbeUrl({ base = "http://127.0.0.1:8765", quality = "ultra", account = "agentp10", password, flags = "" } = {}) {
  const q = { autoLogin: "1", account, password: password ?? account, autoSpawn: "first", agent: "1", nosw: "1",
    camDebug: "on", adaptiveRes: "off", renderDiag: "on", quality };
  const head = BASE_KEYS.map((k) => `${k}=${encodeURIComponent(q[k])}`).join("&");
  const arm = normalizeFlags(flags, q);
  return `${String(base).replace(/\/+$/, "")}/apps/holtburger-web/index.html?${head}${arm ? "&" + arm : ""}`;
}

/** --key value / --key=value / --switch. */
export function parseArgs(argv) {
  const get = (k, d) => {
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === k) return i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[i + 1] : true;
      if (argv[i].startsWith(k + "=")) return argv[i].slice(k.length + 1);
    }
    return d;
  };
  const town = String(get("--town", "both"));
  if (!TOWN_CHOICES[town]) throw new Error(`--town must be holtburg | linvak | both (got ${town})`);
  const num = (k, d) => { const v = Number(get(k, d)); if (!Number.isFinite(v) || v < 0) throw new Error(`${k} must be a number`); return v; };
  const label = String(get("--label", "probe")).replace(/[^A-Za-z0-9_.-]+/g, "_");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDefault = existsSync("/mnt/wbterminal1/tmp/claude-scratch/perf")
    ? `/mnt/wbterminal1/tmp/claude-scratch/perf/structure-${label}-${stamp}.json`
    : join(process.env.TMPDIR || "/tmp", `structure-${label}-${stamp}.json`);
  // 2026-10-23 (review): a bare `--eval` resolved to ./true and failed only after the boot.
  const evalArg = get("--eval", null);
  let evalFile = null;
  if (evalArg !== null) {
    if (evalArg === true || !String(evalArg)) throw new Error("--eval needs a file path");
    evalFile = resolve(String(evalArg));
    let ok = false;
    try { ok = statSync(evalFile).isFile(); } catch (_) { ok = false; }
    if (!ok) throw new Error(`--eval: ${evalFile} is not a readable file`);
  }
  const a = {
    base: String(get("--base", "http://127.0.0.1:8765")),
    flags: String(get("--flags", "") === true ? "" : get("--flags", "")),
    towns: TOWN_CHOICES[town],
    town,
    quality: String(get("--quality", "ultra")),
    account: String(get("--account", "agentp10")),
    password: get("--password", null),
    out: String(get("--out", outDefault)),
    label,
    path: get("--path", false) === true,
    detail: get("--detail", false) === true,
    quietSec: num("--quiet-sec", 20),
    settleMaxSec: num("--settle-max-sec", 420),
    holdFrames: num("--hold-frames", 6),
    bootTimeoutSec: num("--boot-timeout-sec", 360),
    timeoutMin: null,
    loginRetries: num("--login-retries", 2),
    allowUncapped: get("--allow-uncapped", false) === true,
    evalFile,
  };
  // 2026-10-23 (review): a fixed 30 min sat below the worst case the options allow (~50 min
  // for both towns, no path) and cut slow but healthy runs. An explicit value still wins.
  a.timeoutMin = get("--timeout-min", null) === null ? hardTimeoutMin(a) : num("--timeout-min", 0);
  return a;
}

// Fixed @teleloc stops per town (structure-p0.eval.js TOWNS; the node test pins it).
export const PATH_STOPS = 4;
/** The longest a run may take under its own options: boot (goto 90 s + the boot gate,
 *  extended 60 s per relogin, + 9 s before each) plus, per town, every bounded wait the eval
 *  makes (teleloc + tunnel wait + post-teleport sleep + settle cap + three frame-capped waits:
 *  endTunnel, the hold, the 2 frames after it; per path stop teleloc + tunnel + dwell +
 *  path-settle cap + endTunnel + the lite hold). Minutes, rounded up, + 5 of margin. */
export function hardTimeoutMin(a) {
  const o = laptopEvalOpts(a);
  const town = o.telelocWaitMs + o.tunnelWaitMs + o.postTeleMs + o.settle.maxMs + 3 * o.holdMaxMs;
  const stop = o.telelocWaitMs + o.tunnelWaitMs + o.dwellMs + o.pathSettle.maxMs + 2 * o.holdMaxMs;
  const bootMs = 90000 + a.bootTimeoutSec * 1000 + a.loginRetries * 69000;
  const ms = bootMs + o.towns.length * (town + (o.path ? PATH_STOPS * stop : 0));
  return Math.ceil(ms / 60000) + 5;
}

/** One page.evaluate per town, `save()` after each: a crash or the hard timeout during a
 *  later town keeps every finished one in `result` (2026-10-23 review; the single evaluate
 *  lost them all). `evaluateTown(key)` runs the read with towns = [key]; a throw propagates. */
export async function evalTownByTown(towns, evaluateTown, result, save) {
  for (const key of towns) {
    const r = await evaluateTown(key);
    if (result.schema === undefined && r && typeof r === "object") {
      Object.assign(result, { schema: r.schema, startedAt: r.startedAt, opts: { ...(r.opts || {}), towns }, env: r.env });
    }
    result.towns[key] = r && r.towns && r.towns[key] ? r.towns[key] : { key, error: "the eval returned no row for this town", raw: r ?? null };
    for (const e of (r && r.errors) || []) result.errors.push(`${key}: ${e}`);
    result.endedAt = (r && r.endedAt) || new Date().toISOString();
    save();
  }
  return result;
}

/** The towns to flag (exit 3): not settled, errored, or a census held under the tunnel. */
export function townProblems(result) {
  const towns = Object.values((result && result.towns) || {});
  return {
    unsettledOrFailed: towns.filter((t) => t.error || !t.settle || !t.settle.quiet).map((t) => t.key),
    tunnelHeld: towns.filter((t) => Array.isArray(t.tunnelHeld) && t.tunnelHeld.length).map((t) => `${t.key}: ${t.tunnelHeld.join(", ")}`),
  };
}

/** Laptop options for the page-side read (window.__structureP0Opts). SwiftShader renders a
 *  full town at seconds per frame, so everything the 1070 does in frames is fewer, longer. */
export function laptopEvalOpts(a) {
  return {
    towns: a.towns,
    settle: { quietMs: a.quietSec * 1000, maxMs: a.settleMaxSec * 1000, pollMs: 2000 },
    postTeleMs: 15000,
    telelocWaitMs: 60000,
    // The SwiftShader tunnel outlives any wait: settle under it, end it before each census.
    tunnelWaitMs: 0,
    holdFrames: a.holdFrames,
    holdMaxMs: 240000,
    path: a.path,
    // A path stop is judged on its counts, not its frame times: settle it instead of a
    // fixed 10 s dwell, and dwell only long enough to sample a couple of frames.
    dwellMs: 5000,
    pathSettle: { quietMs: Math.min(a.quietSec * 1000, 15000), maxMs: 180000 },
    liteHoldFrames: 2,
    detail: a.detail,
    endTunnelBeforeCensus: true,
  };
}

/** Inside the `builds` cgroup (capped-build)? null = cannot tell (no /proc). */
export function inBuildsCgroup(text) {
  if (text == null) return null;
  return /(^|\n)[^\n]*:[^\n]*\/builds(\/|\n|$)/.test(String(text));
}

function aceLogTail(bytes = 262144) {
  const size = statSync(ACE_LOG).size, fd = openSync(ACE_LOG, "r");
  const buf = Buffer.alloc(Math.min(bytes, size));
  readSync(fd, buf, 0, buf.length, size - buf.length);
  closeSync(fd);
  return buf.toString("utf8");
}
/** The account is free when its latest ACE LOGIN line has a LOGOUT after it (flag-bench). */
async function waitAccountFree(account, maxMs = 120000) {
  if (!existsSync(ACE_LOG)) return "no ACE log (skipped)";
  const re = new RegExp(`\\[(LOGIN|LOGOUT)\\] Account ${account.replace(/[^A-Za-z0-9_]/g, "")} `);
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    const ev = aceLogTail().split("\n").filter((l) => re.test(l));
    const last = ev[ev.length - 1];
    if (!last || /\[LOGOUT\]/.test(last)) return "free";
    await new Promise((r) => setTimeout(r, 2000));
  }
  return "still logged in after the wait (the relogin path may have to kick it)";
}

async function serverUp(url) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    const r = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    return r.status < 500;
  } catch (_) {
    return false;
  }
}

function gitHead() {
  try { return execFileSync("git", ["-C", REPO, "rev-parse", "--short", "HEAD"], { encoding: "utf8", timeout: 5000 }).trim(); } catch (_) { return null; }
}
function wasmBytes() {
  try { return statSync(join(APP_DIR, "pkg", "holtburger_web_bg.wasm")).size; } catch (_) { return null; }
}

async function readBoot(page) {
  return page.evaluate(() => {
    let pose = false;
    try { const p = window.__sessionHandle?.getLocalPlayerPose?.(); pose = !!p; try { p?.free?.(); } catch (_) { /* released */ } } catch (_) { /* not yet */ }
    let meshes = 0;
    try { window.liveScene3d?.scene?.traverse((o) => { if (o.isMesh) meshes += 1; }); } catch (_) { /* not yet */ }
    return {
      state: window.__bootState ?? null,
      history: (window.__bootStateHistory || []).map((e) => ({ state: e.state, message: e.message || "" })),
      sceneReadyEverFired: !!window.__sceneReadyEverFired,
      inFlight: typeof window.__autoLoginInFlight === "function" ? window.__autoLoginInFlight() : false,
      live: !!window.liveScene3d, handle: !!window.__sessionHandle, pose, meshes,
    };
  }).catch(() => null);
}

async function main() {
  const t0 = Date.now();
  const log = (...m) => console.log(`[structure-probe ${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...m);
  let a;
  try { a = parseArgs(process.argv.slice(2)); } catch (e) { console.error(String(e.message || e)); return 2; }

  let cg = null;
  try { cg = readFileSync("/proc/self/cgroup", "utf8"); } catch (_) { /* not Linux */ }
  const capped = inBuildsCgroup(cg);
  if (capped === false && !a.allowUncapped) {
    console.error("[structure-probe] REFUSED: not inside the capped-build cgroup. A headless Chrome on a real world is a heavy job (~/CLAUDE.md):\n"
      + "  capped-build node scripts/perf-worker/laptop-structure-probe.mjs ...");
    return 2;
  }

  let urlArm;
  try { urlArm = buildProbeUrl(a); } catch (e) { console.error(String(e.message || e)); return 2; }
  const url = uncappedBenchUrl(urlArm);
  const res = { schema: "hb-structure-probe-v1", label: a.label, args: { ...a, password: a.password ? "(set)" : "(= account)" },
    url: url.replace(/password=[^&]*/, "password=***"), gitHead: gitHead(), wasmBytes: wasmBytes(), cgroupCapped: capped,
    startedAt: new Date().toISOString(), note: "STRUCTURAL counts only (SwiftShader); frame times in this file are not evidence." };
  const write = () => {
    try { mkdirSync(dirname(a.out), { recursive: true }); writeFileSync(a.out, JSON.stringify(res, null, 1)); } catch (e) { console.error("write failed:", e); }
  };

  if (!(await serverUp(urlArm.split("?")[0]))) {
    console.error(`[structure-probe] REFUSED: ${a.base} does not answer — start serve.py (external/holtburger/scripts/serve.py --check) first.`);
    return 2;
  }

  // One heavy job per machine, and only with >= 2.5 GB available (held until exit).
  const heavy = await acquireHeavyLock({ label: `laptop-structure-probe ${a.label}` });
  res.heavyLock = { dir: heavy.dir, bypassed: heavy.bypassed, waitedMs: heavy.waitedMs };
  res.accountWait = await waitAccountFree(a.account);
  log(`account ${a.account}: ${res.accountWait}`);

  const require = createRequire(import.meta.url);
  const { chromium } = require(PLAYWRIGHT_CORE);
  let browser = null;
  let code = 1;
  let timedOut = false;
  const consoleErrors = [], pageErrors = [];
  const hard = setTimeout(() => {
    timedOut = true;
    res.error = `hard timeout after ${a.timeoutMin} min`;
    log(res.error);
    write();
    try { browser && browser.close().catch(() => {}); } catch (_) { /* closing anyway */ }
    setTimeout(() => process.exit(1), 5000).unref();
  }, a.timeoutMin * 60000);
  hard.unref();
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM || "/usr/bin/chromium",
      headless: true,
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--mute-audio",
        "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion"],
    });
    res.browserVersion = browser.version();
    // The 1070 arms run in a --window-size=1280,720 Chrome window (box/hbprobe-launch.bat, not
    // --app/--kiosk), whose tab strip and toolbar leave a 1280x633 page; agent mode's canvas
    // is that page (docs/PERF-LOG-1070-2026-10-06.md, gpu_thread_split.py). 2026-10-23
    // (review): it was 1280x720 here — aspect 1.78 vs 2.02, a narrower frustum, fewer
    // visible instances. Same page size, same aspect, same frustum; env.viewport records it.
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    page.on("console", (m) => {
      const text = m.text();
      if (text.startsWith("[structure-p0]")) log(text);
      if (m.type() === "error" && consoleErrors.length < 300) consoleErrors.push(text.slice(0, 300));
    });
    page.on("pageerror", (e) => { if (pageErrors.length < 100) pageErrors.push(String(e?.message ?? e).slice(0, 300)); });
    // A crashed renderer (2026-10-22: earlyoom SIGTERMs a 1.7 GB SwiftShader renderer) never
    // settles a pending page.evaluate — reject at once instead of riding out --timeout-min.
    // 2026-10-23 (review): the boot loop checks `crashErr` too — readBoot turns a dead page
    // into null, which classifyBoot reads as "wait", so a crash during the initial stream
    // polled to the boot timeout holding the heavy lock.
    let crashed, crashErr = null;
    const crash = new Promise((_, rej) => { crashed = rej; });
    crash.catch(() => {});
    page.on("crash", () => {
      pageErrors.push("PAGE CRASH");
      crashErr = new Error("renderer crashed (PAGE CRASH) — likely OOM; see /var/log/earlyoom.log");
      crashed(crashErr);
    });

    log(`goto ${res.url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });

    // Boot gate: classifyBoot over the history, then the scene itself.
    const bootT = Date.now();
    let attempt = 0, snap = null, why = "";
    for (;;) {
      if (timedOut) throw new Error("hard timeout during boot");
      if (crashErr) throw crashErr;
      snap = await readBoot(page);
      const d = classifyBoot(snap, { attempt, maxAttempts: a.loginRetries });
      if (d.action === "fatal") throw new Error(`boot failed: ${d.reason}\n${formatBootHistory(snap)}`);
      if (d.action === "relogin") {
        attempt += 1;
        log(`boot error (${d.reason}) — relogin ${attempt}/${a.loginRetries} in 9 s`);
        await new Promise((r) => setTimeout(r, 9000));
        const fired = await page.evaluate((o) => {
          if (typeof window.__runAutonomousLogin !== "function") return false;
          window.__runAutonomousLogin(o);
          return true;
        }, { autoSpawn: "first", maxRetries: 1 }).catch(() => false);
        if (!fired) throw new Error(`boot failed and window.__runAutonomousLogin is absent\n${formatBootHistory(snap)}`);
        continue;
      }
      // "go" from the history; the scene must be there too. SwiftShader can latch the
      // scene-ready watchdog's `error` on a fine session — enough meshes means it is fine.
      if (d.action === "go" && snap.live && snap.handle && snap.pose && snap.meshes > 100) break;
      why = d.action === "go" ? `in-world; waiting for liveScene3d=${snap.live} pose=${snap.pose} meshes=${snap.meshes}` : d.reason;
      if (Date.now() - bootT > a.bootTimeoutSec * 1000 + attempt * 60000) {
        throw new Error(`boot timeout after ${((Date.now() - bootT) / 1000).toFixed(0)} s (${why})\n${formatBootHistory(snap)}`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    res.boot = { ms: Date.now() - bootT, relogins: attempt, history: snap.history, meshes: snap.meshes };
    log(`booted in ${(res.boot.ms / 1000).toFixed(0)} s (${snap.meshes} meshes)`);

    // The page-side read, exactly as hbsess.mjs eval runs it on the 1070, once per town
    // (evalTownByTown). --eval swaps in another page-side body (one-off diagnostics); same
    // options object, also evaluated once per town.
    const src = readFileSync(a.evalFile || EVAL_FILE, "utf8");
    const opts = laptopEvalOpts(a);
    res.result = { towns: {}, errors: [] };
    await evalTownByTown(a.towns, (key) => Promise.race([(async () => {
      await page.evaluate((o) => { window.__structureP0Opts = o; }, { ...opts, towns: [key] });
      return page.evaluate(`(async () => { ${src}\n })()`);
    })(), crash]), res.result, write);
    const towns = Object.values(res.result.towns);
    const probs = townProblems(res.result);
    res.unsettledOrFailed = probs.unsettledOrFailed;
    res.tunnelHeld = probs.tunnelHeld;
    for (const t of towns) {
      const s = t.census?.summary;
      if (s) log(`${t.name}: subDraws ${s.subDrawsPerFrame} issued ${s.issuedPerFrame} calls ${s.renderInfoCallsPerFrame} | F4 unsorted share ${s.f4?.unsortedShare} | F2 atlas repeat ${s.f2?.repeatFactor}`);
    }
    if (probs.tunnelHeld.length) log(`census held under the portal tunnel (reject): ${probs.tunnelHeld.join("; ")}`);
    code = probs.unsettledOrFailed.length || probs.tunnelHeld.length ? 3 : 0;
  } catch (e) {
    res.error = (timedOut ? `hard timeout after ${a.timeoutMin} min; then: ` : "") + String(e?.stack ?? e);
    log("ERROR", String(e?.message ?? e).split("\n")[0]);
    code = 1;
  } finally {
    clearTimeout(hard);
    res.consoleErrors = consoleErrors;
    res.pageErrors = pageErrors;
    res.endedAt = new Date().toISOString();
    write();
    // One tab, closed with its browser. The lock releases on exit (heavy_lock 'exit' hook).
    try { if (browser) await browser.close(); } catch (_) { /* already gone */ }
    log(`out ${a.out} (exit ${code})`);
  }
  return code;
}

// Importable for tests: only a direct run launches anything.
const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
