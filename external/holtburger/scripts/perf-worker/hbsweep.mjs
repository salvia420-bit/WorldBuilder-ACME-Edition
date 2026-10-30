// hbsweep.mjs — in-session ABAB sweeps of live toggles that do not reload the page (round 3 R3-0, 2026-10-30).
//
//   node hbsweep.mjs --boot --arms <queue.json> --item M1a-SWEEP --arm SW --port 8766 --uncapped \
//        [--pose orbit|street|still] [--win 8] [--reps 3] [--settle 1.5] [--knobs ...] --out FILE.json
//        boots the arm on a fresh profile under the full §4 protocol (lib/hb_boot.mjs bootArm: the B0
//        port, skytime=13, DayGroup 0, renderScale=1, adaptiveRes=off, targetFps=0, the INNER window,
//        the run-JSON asserts), sweeps, closes it (the M1a-SWEEP recipe);
//   node hbsweep.mjs [--inner W,H] [--daygroup N|none] [--port P] [--no-pins] [--no-box-samples] ... --out FILE.json
//        attaches to a session another tool booted (hbsess.mjs, the laptop tab check): applies the DayGroup
//        (sticky), sizes the window to --inner, reads back and checks every pin (`session.problems`);
//        with --pose orbit and no window.__hbOrbit it sets the orbit from the player pose (`orbit.source`).
//
// Plan §3 R3-0: "in-session ABAB sweeps, 8 s windows x3, of live toggles that do not relink programs
// (__setRenderScale 1 / 0.5 / 0.25, cloud resolution and quality, layered haze, light shafts, SSAO)".
// Per knob: a warm-up pass over every value (2 s each, discarded: first-use compiles and target
// allocations happen there), then `--reps` rounds, the value order reversed every other round
// (A B C, C B A, A B C), each window the SAME camera path (the orbit arc from window.__hbOrbit's start
// azimuth, a 360 deg street sweep, or parked), recorded by lib/hb_page.mjs's probe (fps, p50 / p95,
// renderJs, info.calls). A window in which programs or async links appeared is flagged `relinked`
// (cloud quality and light shafts are takram defines and may relink: such a window is not a price).
// Every knob is put back to the value it had before the sweep, whatever happens. Box samples
// before and after the sweep (rule V). Attaches like hbsess.mjs (Playwright, then raw CDP). An orbit
// window never silently becomes a still one: pageSweep refuses `pose orbit` without window.__hbOrbit.
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CDP, boxSample as boxSampleSsh, killBench, armKillOnSignal } from "./lib/hb_box.mjs";
import { attach } from "./lib/hb_session.mjs";
import { pageInstallProbe, pageSweep, pageEnsureOrbit } from "./lib/hb_page.mjs";
import { HARNESS_V2, V2_DEFAULTS, median, loadArms, parseWindow } from "./lib/hb_v2.mjs";
import { bootArm, applySessionPins, dayGroupPin } from "./lib/hb_boot.mjs";
import { detectGovernorFlag } from "./hbbench.mjs";

export const KNOBS = ["renderScale", "cloudRes", "cloudQuality", "haze", "shafts", "ssao"];

/** CLI options (pure). */
export function parseArgs(argv) {
  const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const knobs = String(opt("--knobs", KNOBS.join(","))).split(",").map((s) => s.trim()).filter(Boolean);
  for (const k of knobs) if (!KNOBS.includes(k)) throw new Error(`unknown knob ${k} (have ${KNOBS.join(", ")})`);
  const pose = opt("--pose", "orbit");
  if (!["orbit", "street", "still"].includes(pose)) throw new Error(`--pose orbit|street|still (got ${pose})`);
  const boot = argv.includes("--boot");
  if (boot && !(opt("--arms", null) && opt("--arm", null))) throw new Error("--boot needs --arms FILE [--item ID] --arm NAME");
  const dayGroup = opt("--daygroup", null);
  if (dayGroup !== null) dayGroupPin(dayGroup); // throws on a bad value before anything runs
  const inner = opt("--inner", null);
  return { knobs, pose, winMs: +opt("--win", 8) * 1000, reps: +opt("--reps", 3), settleMs: +opt("--settle", 1.5) * 1000, warmMs: +opt("--warm", 2) * 1000,
    noBox: argv.includes("--no-box-samples"), boot, arms: opt("--arms", null), item: opt("--item", null), arm: opt("--arm", null), rep: +opt("--rep", 1),
    port: opt("--port", boot ? "8766" : null), uncapped: argv.includes("--uncapped"), dayGroup, inner: inner ? parseWindow(inner) : null, noPins: argv.includes("--no-pins"),
    out: opt("--out", `/mnt/wbterminal1/tmp/claude-scratch/perf/hbsweep-${Date.now()}.json`) };
}

/** ABAB value order per round (pure): odd rounds as given, even rounds reversed. */
export function sweepOrder(values, reps) {
  const out = [];
  for (let r = 1; r <= reps; r++) out.push(r % 2 === 1 ? [...values] : [...values].reverse());
  return out;
}

/** Per value: medians over the measured windows, relink flags, deltas vs the first value (pure). */
export function summarizeKnob(rows, values) {
  const by = values.map((v) => {
    const ws = rows.filter((w) => String(w.value) === String(v) && !w.error);
    return {
      value: v, windows: ws.length, fps: median(ws.map((w) => w.fps)), p50: median(ws.map((w) => w.p50)), p95: median(ws.map((w) => w.p95)),
      renderJsP50: median(ws.map((w) => w.renderJsP50)), calls: median(ws.map((w) => w.calls)),
      fpsSpread: ws.length ? +(Math.max(...ws.map((w) => w.fps)) - Math.min(...ws.map((w) => w.fps))).toFixed(1) : null,
      relinked: ws.some((w) => w.relinked),
    };
  });
  const base = by[0];
  for (const b of by) {
    b.dFps = base && b.fps != null && base.fps != null ? +(b.fps - base.fps).toFixed(1) : null;
    b.dP50 = base && b.p50 != null && base.p50 != null ? +(b.p50 - base.p50).toFixed(2) : null;
  }
  return by;
}

/**
 * The sweep. `deps` = {attach, bootArm, applySessionPins, boxSample, killBench, write} for the suite.
 * --boot: a fresh §4-protocol session of `--arm`, closed at the end; else the running session, pinned.
 */
export async function runSweep(o, deps = {}) {
  const d = { attach, bootArm, applySessionPins, boxSample: boxSampleSsh, killBench,
    write: (p, t) => { mkdirSync(dirname(resolve(p)), { recursive: true }); writeFileSync(p, t); }, ...deps };
  const out = { schema: "hbsweep-v1", harness: HARNESS_V2, at: new Date().toISOString(), mode: o.boot ? "boot" : "attach", pose: o.pose, winMs: o.winMs, reps: o.reps, knobs: {}, box: [] };
  const sample = (label) => (o.noBox ? Promise.resolve({ label, skipped: "--no-box-samples" }) : d.boxSample(label));
  let c = null, pg = null;
  const restore = [];
  try {
    if (o.boot) {
      const ARMS = loadArms(JSON.parse(readFileSync(o.arms, "utf8")), o.item);
      const arm = ARMS.find((a) => a.name === o.arm);
      if (!arm) throw new Error(`no arm ${o.arm} (have ${ARMS.map((a) => a.name).join(", ")})`);
      out.boot = { arm: arm.name, rep: o.rep, flags: arm.flags || "", quality: arm.quality, box: [], errors: [] };
      const b = await d.bootArm(arm, { ...o, profileTag: "sweep", governorFlag: !!o.governorFlag }, null, out.boot, { boxSample: sample });
      c = b.c;
    } else {
      c = await d.attach(CDP);
      out.session = o.noPins ? { skipped: "--no-pins" } : await d.applySessionPins(c, { dayGroup: o.dayGroup, inner: o.inner, port: o.port, governorFlag: !!o.governorFlag });
      if (out.session.problems && out.session.problems.length) console.log(`session pins: ${out.session.problems.join("; ")}`);
    }
    pg = c.pg;
    if (o.pose === "orbit") {
      out.orbit = await pg.evaluate(pageEnsureOrbit, { degPerSec: V2_DEFAULTS.orbitDegPerSec });
      if (out.orbit.error) throw new Error(`orbit pose: ${out.orbit.error}`);
    }
    out.box.push(await sample("pre-sweep"));
    out.page = await pg.evaluate(() => ({ url: location.search.replace(/password=[^&]*/, "password=***"), inner: [innerWidth, innerHeight], dpr: devicePixelRatio,
      pixelRatio: window.liveScene3d.renderer.getPixelRatio(), skyTimePin: window.__skyTimePin ?? null }));
    out.probeInstall = await pg.evaluate(pageInstallProbe, {});
    for (const knob of o.knobs) {
      const info = await pg.evaluate(pageSweep, { op: "info", knob });
      const rec = (out.knobs[knob] = { info, windows: [], warm: [] });
      if (!info.avail) { rec.skipped = "not available on this page (flag off at this tier?)"; console.log(`${knob}: skipped`); continue; }
      restore.push({ knob, value: info.current });
      const values = knob === "haze" && !(info.current > 0) ? null : info.values;
      if (!values) { rec.skipped = "haze strength is 0 on this page: nothing to toggle"; restore.pop(); continue; }
      const common = { knob, pose: o.pose, settleMs: o.settleMs, onValue: knob === "haze" ? info.current : undefined };
      for (const v of values) rec.warm.push(await pg.evaluate(pageSweep, { ...common, op: "window", value: v, ms: o.warmMs }));
      for (const [round, order] of sweepOrder(values, o.reps).entries()) {
        for (const v of order) {
          const w = await pg.evaluate(pageSweep, { ...common, op: "window", value: v, ms: o.winMs });
          w.round = round + 1;
          rec.windows.push(w);
          console.log(`${knob}=${v} r${round + 1}: ${w.error ? "ERROR " + w.error : `${w.fps} fps p50 ${w.p50} renderJs ${w.renderJsP50} calls ${w.calls}${w.relinked ? " RELINKED" : ""}`}`);
        }
      }
      rec.summary = summarizeKnob(rec.windows, values);
      await pg.evaluate(pageSweep, { op: "set", knob, value: info.current, raw: true });
      restore.pop();
    }
  } catch (e) { out.error = String(e?.message ?? e); }
  finally {
    try {
      if (pg) {
        for (const r of restore.reverse()) { try { await pg.evaluate(pageSweep, { op: "set", knob: r.knob, value: r.value, raw: true }); } catch (_) { /* page gone */ } }
        try { await pg.evaluate(() => window.__hbProbe ? window.__hbProbe.uninstall() : null); } catch (_) { /* page gone */ }
      }
      try { out.box.push(await sample("post-sweep")); } catch (e) { out.box.push({ label: "post-sweep", error: String(e?.message ?? e).slice(0, 300) }); }
      d.write(o.out, JSON.stringify(out, null, 1));
      console.log(`${out.error ? "ERROR " + out.error + " " : ""}-> ${o.out}`);
    } finally {
      // --boot: always, whether bootArm returned or launched and threw (c is null then), even when
      // the write failed; an attached session is never killed.
      if (o.boot) {
        try { if (c && c.browser) await c.browser.close(); } catch (_) { /* gone */ }
        d.killBench();
      } else if (c && c.browser && c.browser.isRaw) { try { await c.browser.close(); } catch (_) { /* socket only */ } }
    }
  }
  return out;
}

async function main(argv) {
  const o = parseArgs(argv);
  o.governorFlag = detectGovernorFlag();
  // --boot launches the test Chrome on the box: Ctrl-C kills it before exiting (attach mode never kills).
  if (o.boot) armKillOnSignal();
  const out = await runSweep(o);
  if (out.error) process.exitCode = 1;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) main(process.argv.slice(2)).then(() => process.exit(process.exitCode || 0), (e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
