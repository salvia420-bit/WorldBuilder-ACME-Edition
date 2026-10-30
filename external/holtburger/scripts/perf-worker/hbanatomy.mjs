// hbanatomy.mjs — harness v2 frame anatomy of ONE arm on the 1070 (round 3 R3-0 / R3-1, 2026-10-30).
//
//   node hbanatomy.mjs --arms <arms.json | queue.json> [--item ID] --arm NAME [--rep N] --port 8766 \
//        --out DIR [--uncapped] [--phases trace,passes,glcensus,census,programs,loaf] [--compat v1]
//   node hbanatomy.mjs ... --arm NAME --phases gauge --gauge-scripts a.js,b.js
//        a SEPARATE boot with ?vfxGauge=on&renderDiag=on appended, evaluating each script (the body of an
//        async fn, e.g. /mnt/wbterminal1/tmp/fps-agent/anatomy.js and gpucensus2.js)
//   node hbanatomy.mjs --arms <queue.json> --item ID --arm NAME [--rep N] --port 8766 --uncapped \
//        --eval FILE.js [--opts JSON] [--trace OUT.trace.json] --out OUT.json
//        boot the arm on a fresh profile under the full §4 protocol (lib/hb_boot.mjs bootArm, the same
//        pins and asserts as every hbanatomy run), park on the orbit pose, then run one page script
//        (structure-ceiling.eval.js, layer-mip-probe.eval.js), optionally under a browser-wide trace
//        (the M1a-CEILING / M1a-LAYERMIP recipes)
//   node hbanatomy.mjs --attach --eval FILE.js [--opts JSON] [--trace OUT.trace.json] [--no-box-samples]
//        [--inner W,H] [--daygroup N|none] [--port P] [--no-pins] --out OUT.json
//        the same script on a session another tool booted (hbsess.mjs, the laptop tab check). The
//        DayGroup is applied first (sticky), the window sized to --inner, and every pin read back and
//        checked (lib/hb_boot.mjs applySessionPins -> `session.problems` in OUT.json)
//
// A fresh profile per run, booted and pinned exactly as hbbench.mjs boots an arm (lib/hb_boot.mjs bootArm
// over planArm: skytime=13, DayGroup 0, renderScale=1, adaptiveRes=off, targetFps=0, gpuGovernor=off once
// documented, the arm's INNER window, arm.spot / readyWhen / gate; the run-JSON asserts carry the URL-pin,
// DayGroup, skytime, window, wasm and adapter checks), parked on the Holtburg orbit, then (plan §3 R3-0):
//   trace     10 s still + 10 s orbit under a Chrome trace (toplevel, gpu, gpu.angle, devtools.timeline
//             categories, blink.user_timing marks per 5 s window); read with gpu_thread_split.py,
//             timeline_split.py and `hbreport.py trace-split --marks hbAnat:` (main busy + CrGpuMain
//             WEBGL / RASTER / PRESENT per present, GC per window); the in-page probe counts info.calls,
//             ranges and renderJs for the calibration; JS heap at each window edge;
//   passes    whole-pass GPU timer queries around each composer pass and each direct-path render,
//             never nested (lib/hb_page.mjs pageInstallPassTimers), 5 s still + 5 s orbit;
//   glcensus  60-frame GL-command census (real D3D draws = plain draws + multi-draw ranges);
//   census    one row per owner (entity part-surfaces, particle buckets, cell statics, cell surfaces,
//             occlusion proxies, pools ...) with < 300 / 300-600 / >= 600 m buckets, 60 frames;
//   programs  renderer.info.programs cache keys (hbreport.py program-diff between arms);
//   loaf      loaf-stalls.eval.js (20 s still + 20 s orbit LoAF window);
// and the dated 1070 µs-per-draw calibration: renderJs ms / info.calls (CPU) and CrGpuMain WEBGL ms per
// present / real D3D draws (GPU process). Box samples before and after every phase (rule V).
// Output: <OUT>/<arm>-r<rep>/anatomy.json (+ trace.json, trace-split.json, *.txt). Never on the laptop:
// the orchestrator / owner runs it against the 1070 (1070 rules: off-screen, muted, fresh profile, one tab).
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { planArm, detectGovernorFlag } from "./hbbench.mjs";
import { HARNESS_V2, loadArms, summarizeProbeSegment, parseWindow } from "./lib/hb_v2.mjs";
import { CDP, killBench, boxSample as boxSampleSsh, armKillOnSignal } from "./lib/hb_box.mjs";
import { attach } from "./lib/hb_session.mjs";
import { bootArm, applySessionPins, dayGroupPin } from "./lib/hb_boot.mjs";
import {
  pageInstallProbe, pageInstallPassTimers, pageOwnerCensus, pageGlCensus, pageProgramKeys, pageServerState, pageMarkedWindows,
} from "./lib/hb_page.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// --no-box-samples (o.noBox): never ssh to the 1070 for a sample (the orchestrator's laptop tab check).
const sampler = (o) => (label) => (o.noBox ? Promise.resolve({ label, at: new Date().toISOString(), skipped: "--no-box-samples" }) : boxSampleSsh(label));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const TRACE_CATEGORIES = ["toplevel", "gpu", "gpu.angle", "devtools.timeline", "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame", "blink.user_timing", "v8.execute"];
export const DEFAULT_PHASES = ["trace", "passes", "glcensus", "census", "programs", "loaf"];

/** CLI options (pure). */
export function parseArgs(argv) {
  const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const phases = String(opt("--phases", DEFAULT_PHASES.join(","))).split(",").map((s) => s.trim()).filter(Boolean);
  for (const p of phases) if (![...DEFAULT_PHASES, "gauge"].includes(p)) throw new Error(`unknown phase ${p}`);
  const inner = opt("--inner", null);
  const dayGroup = opt("--daygroup", null);
  if (dayGroup !== null) dayGroupPin(dayGroup); // throws on a bad value before anything runs
  return {
    attach: argv.includes("--attach"), evalFile: opt("--eval", null), opts: opt("--opts", null), trace: opt("--trace", null),
    arms: opt("--arms", null), item: opt("--item", null), arm: opt("--arm", null), rep: +opt("--rep", 1), port: opt("--port", "8766"),
    out: opt("--out", `/mnt/wbterminal1/tmp/claude-scratch/perf/hbanatomy-${Date.now()}`), uncapped: argv.includes("--uncapped"),
    compat: opt("--compat", null), phases, gaugeScripts: String(opt("--gauge-scripts", "")).split(",").filter(Boolean),
    traceMs: +opt("--trace-ms", 10000), loafSec: +opt("--loaf-sec", 20), window: opt("--window", null), skytime: opt("--skytime", null),
    categories: opt("--categories", TRACE_CATEGORIES.join(",")).split(","),
    noBox: argv.includes("--no-box-samples"),
    inner: inner ? parseWindow(inner) : null, dayGroup, noPins: argv.includes("--no-pins"), pinPort: opt("--port", null),
  };
}

/** The page-script wrapper `hbsess.mjs eval` uses, with optional options injected first (pure). */
export function wrapEval(src, opts) {
  const pre = opts ? `window.__hbEvalOpts = ${JSON.stringify(typeof opts === "string" ? JSON.parse(opts) : opts)};\n` : "";
  return `(async () => { ${pre}${src}\n })()`;
}

/** Calibration from the trace phase (pure): µs per info.call of renderJs, µs of CrGpuMain WEBGL per real draw. */
export function calibration({ probeStill, split, gl }) {
  const wins = (split && split.windows ? split.windows : []).filter((w) => /:still:w\d+$/.test(w.window) && w.spanMs >= 1000);
  const webgl = wins.length ? wins.map((w) => w.webglPerPresent).sort((a, b) => a - b)[wins.length >> 1] : null;
  const calls = probeStill && probeStill.calls ? probeStill.calls.mean : null;
  const real = gl && gl.realDrawsPerFrame ? gl.realDrawsPerFrame : probeStill && probeStill.realDraws ? probeStill.realDraws.mean : null;
  const rj = probeStill && probeStill.renderJs ? probeStill.renderJs.mean : null;
  return {
    date: new Date().toISOString().slice(0, 10),
    renderJsMsPerFrame: rj, infoCallsPerFrame: calls, realDrawsPerFrame: real, webglMsPerPresent: webgl,
    usPerCallRenderJs: rj && calls ? +((rj * 1000) / calls).toFixed(2) : null,
    usPerRealDrawWebgl: webgl && real ? +((webgl * 1000) / real).toFixed(2) : null,
    note: "renderJs = sum of top-level renderer.render() per frame; real draws = plain draws + multi-draw ranges (ANGLE issues one D3D draw per range, plan §0 rule 5)",
  };
}

function py(args) {
  const r = spawnSync("python3", ["-I", ...args], { encoding: "utf8", timeout: 600000, maxBuffer: 64 << 20 });
  return { code: r.status, out: (r.stdout || "").slice(0, 200000), err: (r.stderr || "").slice(0, 4000) };
}

async function traced(c, path, categories, fn) {
  if (c.browser && !c.browser.isRaw && typeof c.browser.startTracing === "function") {
    await c.browser.startTracing(c.pg, { path, categories });
    try { return await fn(); } finally { await c.browser.stopTracing(); }
  }
  const { rawTrace } = await import("./lib/cdp_raw.mjs");
  return rawTrace(CDP, path, categories, fn);
}

/**
 * The anatomy of one arm (fresh profile through lib/hb_boot.mjs bootArm). `deps` = {bootArm, killBench,
 * boxSample, traced, py, sleep, write, mkdir} for the suite. The box Chrome is killed in a `finally` that
 * neither a bootArm throw (launched, never returned) nor a failed anatomy.json write can skip.
 */
export async function runArm(o, deps = {}) {
  const d = { bootArm, killBench, boxSample: sampler(o), traced, py, sleep, write: (p, t) => writeFileSync(p, t), mkdir: (p) => mkdirSync(p, { recursive: true }), ...deps };
  const boxSample = d.boxSample;
  const ARMS = loadArms(JSON.parse(readFileSync(o.arms, "utf8")), o.item);
  const arm = ARMS.find((a) => a.name === o.arm);
  if (!arm) throw new Error(`no arm ${o.arm} (have ${ARMS.map((a) => a.name).join(", ")})`);
  const dir = join(o.out, `${arm.name}-r${o.rep}${o.phases.includes("gauge") && o.phases.length === 1 ? "-gauge" : ""}`);
  d.mkdir(dir);
  const res = { schema: "hbanatomy-v1", harness: HARNESS_V2, arm: arm.name, rep: o.rep, flags: arm.flags || "", quality: arm.quality, phases: o.phases,
    startedAt: new Date().toISOString(), box: [], errors: [] };
  let c = null;
  try {
    const gaugeOnly = o.phases.length === 1 && o.phases[0] === "gauge";
    const b = await d.bootArm(arm, o, gaugeOnly ? "vfxGauge=on&renderDiag=on" : null, res, { boxSample });
    c = b.c;
    const pg = c.pg;
    if (o.phases.includes("trace")) {
      res.box.push(await boxSample("pre-trace"));
      await pg.evaluate(pageInstallProbe, {});
      const tracePath = join(dir, "trace.json");
      const t = await d.traced(c, tracePath, o.categories, async () => {
        await pg.evaluate(() => window.__hbProbe.begin("still"));
        const still = await pg.evaluate(pageMarkedWindows, { ms: o.traceMs, windowMs: 5000, orbit: false, prefix: "hbAnat:still" });
        const ps = await pg.evaluate(() => window.__hbProbe.end());
        await pg.evaluate(() => window.__hbProbe.begin("orbit"));
        const orb = await pg.evaluate(pageMarkedWindows, { ms: o.traceMs, windowMs: 5000, orbit: true, prefix: "hbAnat:orbit" });
        const po = await pg.evaluate(() => window.__hbProbe.end());
        return { still, orbit: orb, probeStill: summarizeProbeSegment(ps), probeOrbit: summarizeProbeSegment(po) };
      });
      await pg.evaluate(() => window.__hbProbe ? window.__hbProbe.uninstall() : null);
      await pg.evaluate((o2) => window.__cam.orbit(o2.x, o2.y, o2.z, o2.dist, o2.az, o2.el), b.orbit);
      res.trace = { file: tracePath, ...t };
      const splitPath = join(dir, "trace-split.json");
      const s = d.py([join(HERE, "hbreport.py"), "trace-split", tracePath, "--marks", "hbAnat:", "--json", splitPath]);
      res.trace.split = existsSync(splitPath) ? JSON.parse(readFileSync(splitPath, "utf8")) : { error: s.err };
      const g = d.py([join(HERE, "gpu_thread_split.py"), tracePath]);
      d.write(join(dir, "gpu_thread_split.txt"), g.out + g.err);
      const tl = d.py([join(HERE, "timeline_split.py"), tracePath, "--frames", String((t.still.frames || 0) + (t.orbit.frames || 0))]);
      d.write(join(dir, "timeline_split.txt"), tl.out + tl.err);
      res.box.push(await boxSample("post-trace"));
    }
    if (o.phases.includes("passes")) {
      res.passesInstall = await pg.evaluate(pageInstallPassTimers, {});
      await pg.evaluate(() => window.__hbPassTimers.begin());
      await pg.evaluate(pageMarkedWindows, { ms: 5000, windowMs: 5000, orbit: false, prefix: "hbPass:still" });
      await pg.evaluate(pageMarkedWindows, { ms: 5000, windowMs: 5000, orbit: true, prefix: "hbPass:orbit" });
      res.passes = await pg.evaluate(() => window.__hbPassTimers.end());
      await pg.evaluate(() => window.__hbPassTimers.uninstall());
      await pg.evaluate((o2) => window.__cam.orbit(o2.x, o2.y, o2.z, o2.dist, o2.az, o2.el), b.orbit);
      await d.sleep(1000);
    }
    if (o.phases.includes("glcensus")) res.glCensus = await pg.evaluate(pageGlCensus, { frames: 60 });
    if (o.phases.includes("census")) res.ownerCensus = await pg.evaluate(pageOwnerCensus, { frames: 60, near: 300, far: 600 });
    if (o.phases.includes("programs")) res.programKeys = await pg.evaluate(pageProgramKeys);
    if (o.phases.includes("loaf")) {
      res.box.push(await boxSample("pre-loaf"));
      const src = readFileSync(join(HERE, "loaf-stalls.eval.js"), "utf8");
      res.loaf = await pg.evaluate(wrapEval(`window.__loafSec = ${o.loafSec};\n${src}`));
      res.box.push(await boxSample("post-loaf"));
    }
    if (o.phases.includes("gauge")) {
      res.gauge = {};
      for (const f of o.gaugeScripts) {
        if (!existsSync(f)) { res.gauge[f] = { error: "missing" }; continue; }
        res.gauge[f] = await pg.evaluate(wrapEval(readFileSync(f, "utf8"))).catch((e) => ({ error: String(e?.message ?? e).slice(0, 300) }));
      }
    }
    res.calibration = calibration({ probeStill: res.trace && res.trace.probeStill, split: res.trace && res.trace.split, gl: res.glCensus });
    res.serverState.end = await pg.evaluate(pageServerState).catch(() => null);
  } catch (e) { res.error = String(e?.message ?? e); }
  finally {
    try {
      res.endedAt = new Date().toISOString();
      d.write(join(dir, "anatomy.json"), JSON.stringify(res, null, 1));
    } finally {
      // always: bootArm may have launched and thrown (c is null then), or the write failed
      try { if (c && c.browser) await c.browser.close(); } catch (_) {}
      d.killBench();
    }
  }
  console.log(`${res.error ? "ERROR " + res.error : "ok"} -> ${join(dir, "anatomy.json")}`);
  if (res.calibration) console.log("calibration", JSON.stringify(res.calibration));
  return res;
}

/** Pick --arm from --arms (an arms file or a queue item). */
function pickArm(o) {
  if (!o.arms || !o.arm) throw new Error("--arms FILE and --arm NAME are required (or --attach)");
  const ARMS = loadArms(JSON.parse(readFileSync(o.arms, "utf8")), o.item);
  const arm = ARMS.find((a) => a.name === o.arm);
  if (!arm) throw new Error(`no arm ${o.arm} (have ${ARMS.map((a) => a.name).join(", ")})`);
  return arm;
}

/**
 * One page script on a session: booted here under the §4 protocol (--arms/--arm), or attached
 * (--attach) with the session pins applied and checked first. Box samples honour o.noBox (never the
 * module-level --no-box-samples switch main() sets). `deps` = {attach, bootArm, applySessionPins,
 * traced, killBench, boxSample, write} for the suite.
 */
export async function runEval(o, deps = {}) {
  const d = { attach, bootArm, applySessionPins, traced, killBench, boxSample: sampler(o), write: (p, t) => { mkdirSync(dirname(resolve(p)), { recursive: true }); writeFileSync(p, t); }, ...deps };
  if (!o.evalFile) throw new Error("--eval FILE is required");
  const src = readFileSync(o.evalFile, "utf8");
  const out = { schema: "hbanatomy-eval-v1", harness: HARNESS_V2, eval: o.evalFile, opts: o.opts ? JSON.parse(o.opts) : null, trace: o.trace,
    mode: o.attach ? "attach" : "boot", at: new Date().toISOString(), box: [], errors: [] };
  let c = null, booted = false;
  try {
    if (o.attach) {
      c = await d.attach(CDP);
      out.session = o.noPins ? { skipped: "--no-pins" } : await d.applySessionPins(c, { dayGroup: o.dayGroup, inner: o.inner, port: o.pinPort, governorFlag: !!o.governorFlag });
      if (out.session.problems && out.session.problems.length) console.log(`session pins: ${out.session.problems.join("; ")}`);
    } else {
      const arm = pickArm(o);
      Object.assign(out, { arm: arm.name, rep: o.rep, flags: arm.flags || "", quality: arm.quality, startedAt: new Date().toISOString() });
      o.profileTag = "eval";
      const b = await d.bootArm(arm, o, null, out, { boxSample: d.boxSample });
      c = b.c; booted = true;
    }
    const run = () => c.pg.evaluate(wrapEval(src, o.opts));
    out.box.push(await d.boxSample("pre-eval"));
    out.result = o.trace ? await d.traced(c, o.trace, o.categories, run) : await run();
    out.box.push(await d.boxSample("post-eval"));
    if (booted) out.serverState.end = await c.pg.evaluate(pageServerState).catch(() => null);
  } catch (e) { out.error = String(e?.message ?? e); }
  finally {
    try {
      out.endedAt = new Date().toISOString();
      d.write(o.out, JSON.stringify(out, null, 1));
      console.log(`${out.error ? "ERROR " + out.error + " " : ""}-> ${o.out}`);
    } finally {
      if (!o.attach) {
        // Boot mode: kill whether or not bootArm returned. A bootArm that launched the test Chrome and
        // then threw (gate false, boot never ready, not on the 1070, a settle error) returns no
        // session, so a `booted` test here left it logged in, in world, on the person's 1070.
        try { if (c && c.browser) await c.browser.close(); } catch (_) { /* gone */ }
        d.killBench();
      } else if (c && c.browser && c.browser.isRaw) {
        // Never close an attached session's browser (hbsess.mjs rule: CDP disconnect only). A raw
        // session closes its own socket; a Playwright connection just ends with the process.
        try { await c.browser.close(); } catch (_) { /* gone */ }
      }
    }
  }
  return out;
}

async function main(argv) {
  const o = parseArgs(argv);
  o.governorFlag = detectGovernorFlag();
  if (o.attach && !o.evalFile) throw new Error("--attach needs --eval FILE");
  if (!o.attach && !(o.arms && o.arm)) throw new Error("--arms FILE and --arm NAME are required (or --attach --eval FILE)");
  // Every mode but --attach launches the test Chrome on the box: Ctrl-C kills it before exiting.
  if (!o.attach) armKillOnSignal();
  if (o.evalFile) return runEval(o);
  return runArm(o);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) main(process.argv.slice(2)).then(() => process.exit(0), (e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
