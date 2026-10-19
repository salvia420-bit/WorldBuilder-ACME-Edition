// tests/frame_cap.test.mjs — the runtime frame-rate cap (2026-10-19; VTank
// EnableFPSLimit / TargetFPSFocused / TargetFPSBackground).
//
//   1. scene3d/frame_cap.js: the ?targetFps parse, the focus rule
//      (visible && document.hasFocus()), the policy → fps mapping, and the
//      driver on a fake window / document: focus / blur / visibility switch
//      the rate at once, the URL pin is never overridden (said once), a setter
//      that appears later or is replaced is (re)applied, dispose releases.
//   2. scene3d/index.js: `window.__setFrameCap` / `__frameCapState`, LIFTED
//      FROM THE SHIPPED SOURCE and run in a scope (the tests/film_hooks.test.mjs
//      technique): the clamp, the URL / renderOnDemand refusals, and the
//      dt-recovery threshold staying exact for every rate it can set.
//   3. scene3d/adaptive_render_scale.js: a capped loop does not make the
//      controller lower the resolution (it times its own rAF chain).
//
// Run from apps/holtburger-web/:  node tests/frame_cap.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FC = await import("../scene3d/frame_cap.js");
const { AdaptiveRenderScaleController } = await import("../scene3d/adaptive_render_scale.js");

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 5).join("\n       ") : e}`);
  }
}
const near = (a, b, eps, msg) => assert.ok(Number.isFinite(a) && Math.abs(a - b) <= eps, `${msg || "near"}: ${a} vs ${b} (±${eps})`);

/** A minimal event target. */
function target(extra = {}) {
  const l = new Map();
  return {
    ...extra,
    addEventListener(t, f) {
      if (!l.has(t)) l.set(t, new Set());
      l.get(t).add(f);
    },
    removeEventListener(t, f) {
      l.get(t)?.delete(f);
    },
    fire(t) {
      for (const f of [...(l.get(t) || [])]) f({ type: t });
    },
    count: (t) => (l.get(t) ? l.get(t).size : 0),
  };
}
function page({ search = "", focused = true, hidden = false, setter = true } = {}) {
  const calls = [];
  const doc = target({ hidden, hasFocus: () => focused });
  const win = target({ location: { search }, document: doc });
  const s = {
    win,
    doc,
    calls,
    setFocus(v) {
      focused = v;
    },
    setHidden(v) {
      doc.hidden = v;
    },
    installSetter() {
      win.__setFrameCap = (fps) => {
        calls.push(fps);
        return true;
      };
      return win.__setFrameCap;
    },
  };
  if (setter) s.installSetter();
  return s;
}
const POLICY = { enabled: true, focusedFps: 60, backgroundFps: 30 };

console.log("— scene3d/frame_cap.js");

await check("urlFrameCapFps: the scene3d/index.js parse (N > 0, capped at 240)", () => {
  assert.equal(FC.urlFrameCapFps("?targetFps=30"), 30);
  assert.equal(FC.urlFrameCapFps("?a=1&targetFps=12.5"), 12.5);
  assert.equal(FC.urlFrameCapFps("?targetFps=999"), 240);
  for (const s of ["", "?targetFps=0", "?targetFps=-5", "?targetFps=abc", "?targetfps=30", null, undefined]) assert.equal(FC.urlFrameCapFps(s), 0, String(s));
});

await check("documentFocused / frameCapFor: visible && hasFocus(); disabled or a bad rate = uncapped", () => {
  assert.equal(FC.documentFocused(null), true);
  assert.equal(FC.documentFocused({ hidden: false, hasFocus: () => true }), true);
  assert.equal(FC.documentFocused({ hidden: false, hasFocus: () => false }), false);
  assert.equal(FC.documentFocused({ hidden: true, hasFocus: () => true }), false, "hidden = background");
  assert.equal(FC.documentFocused({ hidden: false }), true, "no hasFocus()");
  assert.equal(FC.documentFocused({ hasFocus: () => { throw new Error("x"); } }), true);
  assert.equal(FC.frameCapFor(POLICY, true), 60);
  assert.equal(FC.frameCapFor(POLICY, false), 30);
  assert.equal(FC.frameCapFor({ ...POLICY, enabled: false }, true), 0);
  assert.equal(FC.frameCapFor({ ...POLICY, focusedFps: NaN }, true), 0);
  assert.equal(FC.frameCapFor({ ...POLICY, backgroundFps: 0 }, false), 0);
  assert.equal(FC.frameCapFor(null, true), 0);
});

await check("driver: focused rate, background on blur / hidden, back on focus — one setter call per change", () => {
  const p = page();
  const d = FC.createFrameCapDriver({ win: p.win, doc: p.doc });
  assert.deepEqual(p.calls, [], "no policy: nothing touched");
  d.setPolicy(POLICY);
  assert.deepEqual(p.calls, [60]);
  d.setPolicy({ ...POLICY });
  assert.deepEqual(p.calls, [60], "same cap: no second call");
  p.setFocus(false);
  p.win.fire("blur");
  assert.deepEqual(p.calls, [60, 30]);
  assert.equal(d.status().focused, false);
  p.setFocus(true);
  p.win.fire("focus");
  assert.deepEqual(p.calls, [60, 30, 60]);
  p.setHidden(true);
  p.doc.fire("visibilitychange");
  assert.deepEqual(p.calls, [60, 30, 60, 30], "a hidden tab counts as background");
  p.setHidden(false);
  p.doc.fire("visibilitychange");
  assert.deepEqual(p.calls.at(-1), 60);
  p.setHidden(true);
  p.win.fire("focus");
  assert.deepEqual(p.calls.at(-1), 30, "focus while hidden is not focused");
  p.setHidden(false);
  p.win.fire("focus");
  d.setPolicy({ ...POLICY, focusedFps: 144 });
  assert.deepEqual(p.calls.at(-1), 144, "a rate edit applies at once");
  d.setPolicy({ ...POLICY, enabled: false });
  assert.deepEqual(p.calls.at(-1), 0, "limit off: uncapped");
  d.setPolicy(POLICY);
  d.setPolicy(null);
  assert.deepEqual(p.calls.at(-1), 0, "no policy (logged out): the cap is released");
  const n = p.calls.length;
  d.setPolicy(null);
  assert.equal(p.calls.length, n, "nothing to release twice");
  d.dispose();
});

await check("driver: the setter appears with the scene (refresh applies it) or is replaced (re-applied); dispose releases + unhooks", () => {
  const p = page({ setter: false });
  const d = FC.createFrameCapDriver({ win: p.win, doc: p.doc });
  d.setPolicy(POLICY);
  assert.equal(d.status().applied, false, "no 3D loop yet");
  p.installSetter();
  d.refresh();
  assert.deepEqual(p.calls, [60]);
  d.refresh();
  assert.deepEqual(p.calls, [60], "refresh is idempotent");
  p.installSetter(); // a scene re-init installs a new closure (uncapped again)
  d.refresh();
  assert.deepEqual(p.calls, [60, 60], "re-applied to the new loop");
  assert.equal(p.win.count("blur"), 1);
  d.dispose();
  assert.deepEqual(p.calls.at(-1), 0, "released");
  assert.equal(p.win.count("blur") + p.win.count("focus") + p.doc.count("visibilitychange"), 0, "listeners removed");
  d.setPolicy(POLICY);
  assert.deepEqual(p.calls.at(-1), 0, "inert after dispose");
  // a driver that never capped releases nothing
  const q = page();
  const d2 = FC.createFrameCapDriver({ win: q.win, doc: q.doc });
  d2.dispose();
  assert.deepEqual(q.calls, []);
});

await check("driver: ?targetFps pins the page — never calls the setter; onPinned once, only when a cap would apply", () => {
  const p = page({ search: "?targetFps=10" });
  const pinned = [];
  const d = FC.createFrameCapDriver({ win: p.win, doc: p.doc, onPinned: (fps) => pinned.push(fps) });
  d.setPolicy({ ...POLICY, enabled: false });
  assert.deepEqual(pinned, [], "limit off: nothing to say");
  d.setPolicy(POLICY);
  p.win.fire("blur");
  d.setPolicy({ ...POLICY, focusedFps: 90 });
  d.refresh();
  assert.deepEqual(p.calls, [], "the URL cap is never overridden");
  assert.deepEqual(pinned, [10], "said once");
  assert.equal(d.status().pinned, true);
  d.dispose();
  assert.deepEqual(p.calls, []);
});

await check("driver: ?targetFps=0 pins the page uncapped, and an automation-driven page (navigator.webdriver) is never capped", () => {
  assert.equal(FC.urlNamesFrameCap("?targetFps=0"), true);
  assert.equal(FC.urlNamesFrameCap("?agent=1"), false);
  const zero = page({ search: "?targetFps=0" });
  const said = [];
  const d0 = FC.createFrameCapDriver({ win: zero.win, doc: zero.doc, onPinned: (fps, why) => said.push([fps, why]) });
  d0.setPolicy(POLICY);
  zero.win.fire("blur");
  assert.deepEqual(zero.calls, [], "?targetFps=0: the policy never caps it");
  assert.deepEqual(said, [[0, "url"]]);
  d0.dispose();
  const bot = page();
  bot.win.navigator = { webdriver: true };
  const why = [];
  const d1 = FC.createFrameCapDriver({ win: bot.win, doc: bot.doc, onPinned: (_fps, w) => why.push(w) });
  d1.setPolicy(POLICY);
  bot.win.fire("blur");
  d1.refresh();
  assert.deepEqual(bot.calls, [], "a headless / CDP page measures uncapped");
  assert.deepEqual(why, ["automation"], "said once");
  assert.equal(d1.status().automated, true);
  assert.equal(d1.status().pinned, true);
  d1.dispose();
});

await check("driver: a window nobody has focused yet (an off-screen bench / rig Chrome) runs uncapped until a person focuses it", () => {
  const bench = page({ focused: false });
  const d = FC.createFrameCapDriver({ win: bench.win, doc: bench.doc });
  d.setPolicy(POLICY);
  d.refresh();
  assert.ok(bench.calls.every((fps) => fps === 0), `never focused: uncapped, not even the background cap (${bench.calls})`);
  assert.equal(d.status().fps, 0);
  assert.equal(d.status().everFocused, false);
  bench.setFocus(true);
  bench.win.fire("focus");
  assert.deepEqual(bench.calls.at(-1), POLICY.focusedFps, "the first focus starts the cap");
  bench.setFocus(false);
  bench.win.fire("blur");
  assert.deepEqual(bench.calls.at(-1), POLICY.backgroundFps, "then focus / blur switch it as usual");
  assert.equal(d.status().everFocused, true);
  d.dispose();
});

console.log("\n— scene3d/index.js: __setFrameCap (lifted from the shipped source)");

const INDEX_SRC = readFileSync(path.join(APP, "scene3d", "index.js"), "utf8");
/** The balanced `{…}` block whose head starts at `anchor` (strings/comments skipped). */
function liftBlock(src, anchor, from = 0) {
  const start = src.indexOf(anchor, from);
  if (start < 0) throw new Error(`anchor drifted: ${anchor}`);
  let i = src.indexOf("{", start + anchor.length - 1);
  let depth = 0;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); continue; }
    if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i) + 1; continue; }
    if (c === '"' || c === "'" || c === "`") {
      for (i += 1; i < src.length && src[i] !== c; i += 1) if (src[i] === "\\") i += 1;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced block at: ${anchor}`);
}
function runLifted(code, scope, ret) {
  // eslint-disable-next-line no-new-func
  return new Function("__scope", `with (__scope) {\n${code}\n${ret ? `return ${ret};` : ""}\n}`)(scope);
}
const lift = (re) => {
  const m = re.exec(INDEX_SRC);
  if (!m) throw new Error(`anchor drifted: ${re}`);
  return m[0];
};
const CAP_MIN = lift(/const FRAME_CAP_MIN_FPS = [^;]+;/);
// the `if (typeof window …) {` block right after that const installs the setter
const SETTER = liftBlock(INDEX_SRC, 'if (typeof window !== "undefined") {', INDEX_SRC.indexOf(CAP_MIN));
if (!SETTER.includes("window.__setFrameCap = (fps) =>")) throw new Error("anchor drifted: the __setFrameCap block");
function capScope({ targetFps = 0, renderOnDemand = false } = {}) {
  const warns = [];
  const s = {
    targetFps,
    renderOnDemand,
    _frameIntervalMs: targetFps > 0 ? 1000 / targetFps : 0,
    _frameCapSoft: false,
    window: {},
    console: { warn: (...a) => warns.push(a.join(" ")), log() {} },
    warns,
  };
  runLifted(`${CAP_MIN}\n${SETTER}`, s);
  return s;
}

await check("the loop's interval is a `let` the setter re-paces; scheduleNext / the frame-work slot read it per frame", () => {
  assert.match(INDEX_SRC, /\n {2}let _frameIntervalMs = targetFps > 0 \? 1000 \/ targetFps : 0;/);
  assert.match(INDEX_SRC, /const _ivl = portalSpaceFrameIntervalMs\(_frameIntervalMs\);/);
  assert.match(INDEX_SRC, /targetPeriodMs: _frameIntervalMs > 0 \? _frameIntervalMs : 1000 \/ 60,/);
});

await check("__setFrameCap(fps): 1000/fps ms, 0 = bare rAF, clamped to [4, 240]; bad input refused with one warn", () => {
  const s = capScope();
  const set = s.window.__setFrameCap;
  assert.equal(set(60), true);
  near(s._frameIntervalMs, 1000 / 60, 1e-12, "60 fps");
  assert.deepEqual(s.window.__frameCapState(), { fps: 60, intervalMs: 1000 / 60, urlFps: 0, renderOnDemand: false, soft: true });
  assert.equal(set(30), true);
  near(s._frameIntervalMs, 1000 / 30, 1e-12, "30 fps");
  assert.equal(set(0), true);
  assert.equal(s._frameIntervalMs, 0, "uncapped");
  assert.equal(s.window.__frameCapState().fps, 0);
  assert.equal(set(1000), true);
  near(s._frameIntervalMs, 1000 / 240, 1e-12, "capped at 240");
  assert.equal(set(1), true);
  near(s._frameIntervalMs, 250, 1e-12, "floored at 4 fps");
  assert.equal(set(-1), false);
  assert.equal(set("abc"), false);
  near(s._frameIntervalMs, 250, 1e-12, "a refused value changes nothing");
  assert.equal(s.warns.length, 2);
  assert.equal(set("45"), true, "a numeric string");
  near(s._frameIntervalMs, 1000 / 45, 1e-12);
});

await check("a runtime cap paces softly: a 60 fps cap on a 60 Hz screen renders every refresh (the exact pacer halves it); the URL cap keeps the exact pacer", () => {
  const PACER = [lift(/export function pacerDelayMs\([\s\S]*?\n}\n/), lift(/export const SOFT_CAP_WAKE_EARLY_MS = [^;]+;/), lift(/export function softCapDelayMs\([\s\S]*?\n}\n/)]
    .join("\n").replace(/export /g, "");
  const P = runLifted(PACER, {}, "{ pacerDelayMs, softCapDelayMs, SOFT_CAP_WAKE_EARLY_MS }");
  assert.equal(P.SOFT_CAP_WAKE_EARLY_MS, 4);
  near(P.softCapDelayMs(1000 / 60, 0, 8), 1000 / 60 - 8 - 4, 1e-9, "wakes 4 ms early");
  assert.equal(P.softCapDelayMs(1000 / 60, 0, 14), 0, "late work: rAF at once");
  assert.equal(P.softCapDelayMs(1000 / 60, null, 5), 0, "no baseline yet");
  assert.match(INDEX_SRC, /const delay = _frameCapSoft \? softCapDelayMs\(_ivl, lastFrameTs, now\) : pacerDelayMs\(_ivl, lastFrameTs, now\);/);
  // One second on a vsync clock: a frame starts at a refresh, works `work` ms,
  // sleeps the pacer's delay (+ timer slop), and its rAF runs at the first
  // refresh after the wake-up.
  const fpsOver = (delayFn, hz, capFps, work = 6, slop = 1) => {
    const vs = 1000 / hz;
    let t = 0;
    let frames = 0;
    while (t < 1000) {
      frames += 1;
      const wake = t + work + delayFn(1000 / capFps, t, t + work) + slop;
      t = Math.ceil((wake + 1e-9) / vs) * vs;
    }
    return frames;
  };
  assert.ok(fpsOver(P.pacerDelayMs, 60, 60) <= 31, "the exact pacer: 60 fps cap on 60 Hz → ~30 fps (the bug a URL cap never hits in tooling)");
  assert.ok(fpsOver(P.softCapDelayMs, 60, 60) >= 59, "soft: 60 on 60 Hz → 60");
  const bg = fpsOver(P.softCapDelayMs, 60, 30);
  assert.ok(bg >= 29 && bg <= 31, `soft: 30 on 60 Hz → 30 (${bg})`);
  const fast = fpsOver(P.softCapDelayMs, 144, 60);
  assert.ok(fast >= 55 && fast <= 73, `soft: 60 on 144 Hz → about 60, at most one refresh fast (${fast})`);
});

await check("?targetFps wins and ?renderOnDemand has no pace: the setter refuses, the interval stays", () => {
  const u = capScope({ targetFps: 10 });
  assert.equal(u.window.__setFrameCap(60), false);
  assert.equal(u._frameIntervalMs, 100);
  assert.deepEqual(u.window.__frameCapState(), { fps: 10, intervalMs: 100, urlFps: 10, renderOnDemand: false, soft: false }, "the URL cap keeps the exact pacer");
  const r = capScope({ renderOnDemand: true });
  assert.equal(r.window.__setFrameCap(60), false);
  assert.equal(r._frameIntervalMs, 0);
  assert.equal(r.window.__frameCapState().renderOnDemand, true);
});

await check("the dt-recovery threshold (a const derived once) is exact for every cap the setter can set", () => {
  const consts = [lift(/const DT_RECOVERY_RAW_THRESHOLD_S = [^;]+;/), lift(/const _dtRecoveryThresholdS = renderOnDemand[\s\S]*?;\n/)].join("\n");
  const threshold = (ivl, renderOnDemand = false) => runLifted(consts, { _frameIntervalMs: ivl, renderOnDemand }, "_dtRecoveryThresholdS");
  const atBoot = threshold(0); // no ?targetFps: the only case the setter is live
  assert.equal(atBoot, 0.5);
  const s = capScope();
  for (const fps of [1, 4, 5, 10, 30, 60, 144, 240, 500]) {
    s.window.__setFrameCap(fps);
    assert.equal(threshold(s._frameIntervalMs), atBoot, `${fps} fps → ${s._frameIntervalMs} ms`);
  }
  assert.equal(threshold(250, true), Infinity, "renderOnDemand unchanged");
});

console.log("\n— the adaptive render-scale controller under a cap");

/** Drive the controller as production does: its OWN rAF chain at the display
 *  rate. A capped render loop renders on every `everyN`-th frame; `workMs` is
 *  the main-thread time of a rendered frame (a frame that overruns vsync
 *  delays the next rAF), `gpu` the fence verdict read on a rendered frame. */
function drive({ seconds = 30, refreshMs = 1000 / 60, everyN = 1, workMs = 10, gpu = false, probe = true, scale0 = 0.7 }) {
  let t = 0;
  let scale = scale0;
  let unread = null;
  const changes = [];
  const c = new AdaptiveRenderScaleController({
    getScale: () => scale,
    applyScale: (s) => {
      changes.push([scale < s ? "up" : "down", s]);
      scale = s;
    },
    now: () => t,
    settle: true,
    gpuProbe: probe ? { sample: () => { const v = unread; unread = null; return v; } } : null,
  });
  let frame = 0;
  while (t < seconds * 1000) {
    c.recordFrame();
    const rendered = frame % everyN === 0;
    if (rendered && probe) unread = gpu; // scheduleNext → frameEnd() after the frame's submission
    const busy = rendered ? workMs : 1;
    t += Math.max(refreshMs, Math.ceil(busy / refreshMs) * refreshMs);
    frame += 1;
  }
  return { scale, changes };
}

await check("a capped loop never lowers the scale: 30 fps on 60 Hz, 10 fps, with and without a GPU fence", () => {
  for (const [everyN, label] of [[2, "30 fps"], [6, "10 fps"], [12, "5 fps"]]) {
    for (const probe of [true, false]) {
      const r = drive({ everyN, workMs: 25, gpu: false, probe });
      assert.equal(r.changes.filter(([d]) => d === "down").length, 0, `${label}, probe ${probe}: ${JSON.stringify(r.changes)}`);
      assert.ok(r.scale >= 0.7, `${label}, probe ${probe}: scale ${r.scale}`);
    }
  }
});

await check("…while a GPU that cannot keep up still lowers it (the same drive, uncapped, fence behind)", () => {
  const r = drive({ everyN: 1, workMs: 70, gpu: true, probe: true });
  assert.ok(r.changes.some(([d]) => d === "down"), JSON.stringify(r.changes));
  assert.ok(r.scale < 0.7);
});

console.log(`\nframe_cap: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
