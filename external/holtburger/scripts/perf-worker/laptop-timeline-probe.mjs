// laptop-timeline-probe.mjs — what the renderer main thread does OUTSIDE JavaScript.
//
// The 1070 CPU profiles (2026-10-23) put ~19% of the main thread (~3.9 ms/frame) in the
// profiler's "(program)" bucket: native work that is not JS. Their traces carry only the
// `gpu,toplevel` categories, so they cannot split it. This driver boots the client the
// way laptop-structure-probe.mjs does, waits for the world to settle, then records ONE
// Chrome trace with the devtools.timeline categories (style recalc, layout, paint,
// compositing, rAF / timer dispatch, GC) plus a V8 CPU profile over the same window.
//
// ?nullRender=1 by default: SwiftShader renders a town at seconds per frame, which would
// drown the trace in GPU-process waits (and a full SwiftShader town is what wedges Chrome
// on this 8 GB laptop). Without render() the frame loop, sim, entity / particle ticks, net
// drain and the whole DOM HUD still run, so the trace shows how much native main-thread
// work the HUD and the page cost by themselves. `--render` drops the flag (one tab, heavy).
//
// RUN ONLY UNDER capped-build (~/CLAUDE.md: a headless Chrome on a real world is a heavy
// job): capped-build node scripts/perf-worker/laptop-timeline-probe.mjs [--trace-sec 8]
//   [--settle-sec 60] [--flags 'a=b&c=d'] [--render] [--out DIR]
// Analyse: python3 -I scripts/perf-worker/timeline_split.py DIR/trace.json

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { uncappedBenchUrl } from "./lib/bench-url.mjs";
import { acquireHeavyLock } from "../../apps/holtburger-web/harness/lib/heavy_lock.mjs";
import { classifyBoot, formatBootHistory } from "../../apps/holtburger-web/harness/moving-bench.mjs";
import { buildProbeUrl, inBuildsCgroup, VIEWPORT } from "./laptop-structure-probe.mjs";

const PLAYWRIGHT_CORE = process.env.PLAYWRIGHT_CORE || "/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core";
const CATEGORIES = [
  "devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame",
  "blink", "blink.user_timing", "v8.execute", "toplevel", "loading",
].join(",");

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
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
  const log = (...m) => console.log(`[timeline-probe ${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...m);
  let cg = null;
  try { cg = readFileSync("/proc/self/cgroup", "utf8"); } catch (_) { /* not Linux */ }
  if (inBuildsCgroup(cg) === false) {
    console.error("[timeline-probe] REFUSED: not inside the capped-build cgroup (headless Chrome is a heavy job).");
    return 2;
  }
  const traceSec = Number(arg("--trace-sec", 8));
  const settleSec = Number(arg("--settle-sec", 60));
  const render = arg("--render", false) === true;
  const extra = String(arg("--flags", "") === true ? "" : arg("--flags", ""));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = String(arg("--out", existsSync("/mnt/wbterminal1/tmp/claude-scratch/perf")
    ? `/mnt/wbterminal1/tmp/claude-scratch/perf/timeline-${render ? "render" : "nullrender"}-${stamp}`
    : `/tmp/timeline-${stamp}`));
  mkdirSync(outDir, { recursive: true });
  // buildProbeUrl refuses nullRender (structural probes count draws); this probe
  // measures the page, so its flags ride after the boot contract.
  const flags = [render ? "" : "nullRender=1", extra].filter(Boolean).join("&");
  const url = uncappedBenchUrl(buildProbeUrl({ quality: "ultra" }) + (flags ? "&" + flags : ""));
  const res = { schema: "hb-timeline-probe-v1", url: url.replace(/password=[^&]*/, "password=***"), render, traceSec, settleSec, startedAt: new Date().toISOString() };
  const heavy = await acquireHeavyLock({ label: "laptop-timeline-probe" });
  res.heavyLock = { dir: heavy.dir, waitedMs: heavy.waitedMs };
  const require = createRequire(import.meta.url);
  const { chromium } = require(PLAYWRIGHT_CORE);
  let browser = null, code = 1;
  const consoleErrors = [];
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM || "/usr/bin/chromium", headless: true,
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--mute-audio",
        "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion"],
    });
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    page.on("console", (m) => { if (m.type() === "error" && consoleErrors.length < 200) consoleErrors.push(m.text().slice(0, 300)); });
    page.on("crash", () => consoleErrors.push("PAGE CRASH"));
    log(`goto ${res.url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
    const bootT = Date.now();
    let attempt = 0, snap = null;
    for (;;) {
      snap = await readBoot(page);
      const d = classifyBoot(snap, { attempt, maxAttempts: 2 });
      if (d.action === "fatal") throw new Error(`boot failed: ${d.reason}\n${formatBootHistory(snap)}`);
      if (d.action === "relogin") {
        attempt += 1;
        await new Promise((r) => setTimeout(r, 9000));
        await page.evaluate(() => window.__runAutonomousLogin?.({ autoSpawn: "first", maxRetries: 1 })).catch(() => {});
        continue;
      }
      if (d.action === "go" && snap.live && snap.handle && snap.pose && snap.meshes > 100) break;
      if (Date.now() - bootT > 420000) throw new Error(`boot timeout\n${formatBootHistory(snap)}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
    res.boot = { ms: Date.now() - bootT, meshes: snap.meshes };
    log(`booted in ${(res.boot.ms / 1000).toFixed(0)} s (${snap.meshes} meshes); settling ${settleSec} s`);
    await new Promise((r) => setTimeout(r, settleSec * 1000));
    // Frame counter over the trace window (the loop's own rAF), to turn totals into per-frame.
    await page.evaluate(() => {
      window.__tlFrames = 0;
      const f = () => { window.__tlFrames += 1; if (window.__tlOn) requestAnimationFrame(f); };
      window.__tlOn = true; requestAnimationFrame(f);
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    await browser.startTracing(page, { path: join(outDir, "trace.json"), categories: CATEGORIES.split(",") });
    await cdp.send("Profiler.start");
    const tStart = Date.now();
    await new Promise((r) => setTimeout(r, traceSec * 1000));
    const { profile } = await cdp.send("Profiler.stop");
    await browser.stopTracing();
    res.traceMs = Date.now() - tStart;
    res.frames = await page.evaluate(() => { window.__tlOn = false; return window.__tlFrames; });
    writeFileSync(join(outDir, "profile.cpuprofile"), JSON.stringify(profile));
    res.hud = await page.evaluate(() => ({
      domNodes: document.getElementsByTagName("*").length,
      animations: typeof document.getAnimations === "function" ? document.getAnimations().length : null,
    })).catch(() => null);
    log(`traced ${res.traceMs} ms, ${res.frames} frames; DOM ${res.hud?.domNodes} nodes, ${res.hud?.animations} running animations`);
    code = 0;
  } catch (e) {
    res.error = String(e?.stack ?? e);
    log("ERROR", String(e?.message ?? e).split("\n")[0]);
  } finally {
    res.consoleErrors = consoleErrors;
    res.endedAt = new Date().toISOString();
    writeFileSync(join(outDir, "run.json"), JSON.stringify(res, null, 1));
    try { if (browser) await browser.close(); } catch (_) { /* gone */ }
    log(`out ${outDir} (exit ${code})`);
  }
  return code;
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
