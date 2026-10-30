// tools/webgpu_probe/run.mjs — drive the standalone WebGPU capability probe on the 1070 (round 3 R3-1;
// 2026-10-30, lane H). Orchestrator / owner only: it launches the box's test Chrome.
//
//   node apps/holtburger-web/tools/webgpu_probe/run.mjs --port 8766 --out DIR [--draws 1000] [--sec 5] [--rounds 2] [--no-trace]
//
// Fresh profile, off-screen, muted, hidden schtasks launch and kill-by-user-data-dir exactly as
// hbbench.mjs (scripts/perf-worker/lib/hb_box.mjs); 1280x720 window; uncapped (vsync off) so a mode's
// fps follows its slowest stage. Steps: list the browser's trace categories (Tracing.getCategories ->
// the Dawn / WebGPU / GPU names), open tools/webgpu_probe/index.html from the laptop server (no game
// page, no login), trace the whole run (toplevel, gpu, gpu.angle, the Dawn categories found,
// blink.user_timing), wait for window.__webgpuProbe.state, split the trace per mode window
// (`hbreport.py trace-split --marks hbGPU:` -> CrGpuMain ms per present per mode), write
// <OUT>/webgpu-probe.json. Box samples before and after (rule V).
// Kill discipline (2026-10-30, lane H3, as harness v2's launching tools): the box Chrome is killed in
// a `finally` that a failed webgpu-probe.json write cannot skip, and Ctrl-C / SIGTERM / SIGHUP kill
// it before exit (armKillOnSignal, armed in main() only, never at import). runProbe takes injectable
// deps for scripts/perf-worker/tests/hb_v2.test.mjs.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { CDP, killBench, prepareLaunch, launchChrome, boxSample, armKillOnSignal } from "../../../../scripts/perf-worker/lib/hb_box.mjs";
import { connectAtLaunch } from "../../../../scripts/perf-worker/lib/hb_session.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HBREPORT = resolve(HERE, "../../../../scripts/perf-worker/hbreport.py");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** CLI options (pure). */
export function parseArgs(argv) {
  const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  return { port: opt("--port", "8766"), out: opt("--out", `/mnt/wbterminal1/tmp/claude-scratch/perf/webgpu-probe-${Date.now()}`),
    draws: +opt("--draws", 1000), sec: +opt("--sec", 5), rounds: +opt("--rounds", 2), trace: !argv.includes("--no-trace") };
}

/** Trace category names worth recording (pure): Dawn / WebGPU / GPU ones, sorted, de-duplicated. */
export function dawnCategories(all) {
  return [...new Set((all || []).filter((c) => /dawn|webgpu|wgpu/i.test(c)))].sort();
}

/** The probe page URL (pure). */
export function probeUrl(port, o) {
  return `http://127.0.0.1:${port}/apps/holtburger-web/tools/webgpu_probe/index.html?draws=${o.draws}&sec=${o.sec}&rounds=${o.rounds}&nosw=1`;
}

/**
 * One probe run on the box. `deps` = {killBench, prepareLaunch, launchChrome, boxSample, connectAtLaunch,
 * cdp, spawnSync, mkdir, write, exists, read, sleep} for the suite. Returns the result written to
 * <OUT>/webgpu-probe.json; a failed write rejects AFTER the browser is closed and the box Chrome killed.
 */
export async function runProbe(o, deps = {}) {
  const d = { killBench, prepareLaunch, launchChrome, boxSample, connectAtLaunch, cdp: CDP, spawnSync, sleep,
    mkdir: (p) => mkdirSync(p, { recursive: true }), write: (p, t) => writeFileSync(p, t), exists: existsSync, read: (p) => readFileSync(p, "utf8"), ...deps };
  d.mkdir(o.out);
  const res = { schema: "hb-webgpu-probe-run-v1", at: new Date().toISOString(), opts: o, box: [] };
  d.killBench();
  let browser = null;
  try {
    await d.prepareLaunch({ profile: `hbb-webgpu-${Date.now()}`, windowOuter: "1280,720", uncapped: true });
    res.box.push(await d.boxSample("pre-launch"));
    if (!(await d.launchChrome(d.cdp))) throw new Error("test Chrome never answered on CDP (hbgate refused?)");
    const c = await d.connectAtLaunch(d.cdp);
    browser = c.browser;
    try {
      const s = await browser.newBrowserCDPSession();
      const { categories } = await s.send("Tracing.getCategories");
      res.traceCategories = { dawn: dawnCategories(categories), gpu: (categories || []).filter((x) => /(^|\.)gpu/i.test(x)).sort(), total: (categories || []).length };
      await s.detach();
    } catch (e) { res.traceCategories = { error: String(e?.message ?? e) }; }
    const cats = ["toplevel", "gpu", "gpu.angle", "blink.user_timing", ...((res.traceCategories && res.traceCategories.dawn) || [])];
    const tracePath = join(o.out, "trace.json");
    const run = async () => {
      await c.pg.goto(probeUrl(o.port, o), { waitUntil: "domcontentloaded", timeout: 60000 });
      const limit = Date.now() + 60000 + o.sec * 1000 * 3 * o.rounds + 30000;
      let st = null;
      while (Date.now() < limit) {
        st = await c.pg.evaluate(() => (window.__webgpuProbe ? window.__webgpuProbe.state : null)).catch(() => null);
        if (st === "done" || st === "error") break;
        await d.sleep(2000);
      }
      return c.pg.evaluate(() => (window.__webgpuProbe ? window.__webgpuProbe.result : null));
    };
    if (o.trace) {
      await browser.startTracing(c.pg, { path: tracePath, categories: cats });
      try { res.probe = await run(); } finally { await browser.stopTracing(); }
      const splitPath = join(o.out, "trace-split.json");
      const r = d.spawnSync("python3", ["-I", HBREPORT, "trace-split", tracePath, "--marks", "hbGPU:", "--json", splitPath], { encoding: "utf8", timeout: 600000 });
      res.traceSplit = d.exists(splitPath) ? JSON.parse(d.read(splitPath)) : { error: (r.stderr || "").slice(0, 2000) };
    } else res.probe = await run();
    res.box.push(await d.boxSample("post-probe"));
  } catch (e) { res.error = String(e?.message ?? e); }
  finally {
    try { d.write(join(o.out, "webgpu-probe.json"), JSON.stringify(res, null, 1)); }
    finally {
      // always, even when the write threw: the test Chrome must not stay up on the person's 1070
      try { if (browser) await browser.close(); } catch (_) { /* gone */ }
      d.killBench();
    }
  }
  return res;
}

async function main(argv) {
  const o = parseArgs(argv);
  // This tool launches the test Chrome on the box: Ctrl-C / SIGTERM / SIGHUP kill it before exiting.
  armKillOnSignal();
  const res = await runProbe(o);
  console.log(`${res.error ? "ERROR " + res.error : "ok"} -> ${join(o.out, "webgpu-probe.json")}`);
  if (res.probe && res.probe.modes) console.log(JSON.stringify(res.probe.modes));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) main(process.argv.slice(2)).then(() => process.exit(0), (e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
