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
//      2026-10-20: the runtime cap's timeline gate (createSoftCapGate,
//      scheduleNext → softCapTick), lifted the same way and driven on a
//      simulated vsync clock: the cap on 60-240 Hz, the vsync lock on whole
//      numbers of refreshes, stalls, cap changes, the refresh-period estimate.
//   3. the 1070 bench / probe drivers (scripts/perf-worker, coldboot): every
//      index.html URL passes through lib/bench-url.mjs (?targetFps=0), since
//      connectOverCDP's focus emulation defeats the never-focused exemption.
//   4. scene3d/adaptive_render_scale.js: a capped loop does not make the
//      controller lower the resolution (it times its own rAF chain).
//
// Run from apps/holtburger-web/:  node tests/frame_cap.test.mjs

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

// 2026-10-24 — owner: "its supposed to be 30 fps offscreen limit". The 1070 test
// Chrome sits at --window-position=-32000,-32000 and CDP focus emulation reads
// it FOCUSED, so it ran at the focused rate (or uncapped, never focused).
await check("windowOffscreen: beyond -10000 on either axis (off-screen launch / minimized) — else on-screen", () => {
  assert.equal(FC.windowOffscreen({ screenX: -32000, screenY: -32000 }), true);
  assert.equal(FC.windowOffscreen({ screenX: 0, screenY: -32000 }), true);
  assert.equal(FC.windowOffscreen({ screenX: -1920, screenY: 0 }), false, "a monitor left of the primary is on-screen");
  assert.equal(FC.windowOffscreen({ screenX: 100, screenY: 50 }), false);
  assert.equal(FC.windowOffscreen({}), false, "no screenX/screenY (node) = on-screen");
  assert.equal(FC.windowOffscreen(null), false);
});

await check("driver: an OFF-SCREEN window runs at the background rate though it reads focused (CDP), and even if never focused", () => {
  const p = page();
  p.win.screenX = -32000; p.win.screenY = -32000;
  const d = FC.createFrameCapDriver({ win: p.win, doc: p.doc });
  d.setPolicy(POLICY);
  assert.deepEqual(p.calls, [30], "focused + off-screen = 30, not 60");
  assert.equal(d.status().offscreen, true);
  p.win.fire("focus");
  assert.deepEqual(p.calls, [30], "a focus event does not lift it");
  p.win.screenX = 200; p.win.screenY = 100; // moved onto a monitor
  d.refresh();
  assert.deepEqual(p.calls, [30, 60], "back on-screen: the focus rule again");
  p.win.screenX = -32000; p.win.screenY = -32000; // minimized
  d.refresh();
  assert.deepEqual(p.calls.at(-1), 30);
  d.dispose();
  const q = page({ focused: false });
  q.win.screenX = -32000; q.win.screenY = -32000;
  const d2 = FC.createFrameCapDriver({ win: q.win, doc: q.doc });
  d2.setPolicy(POLICY);
  assert.deepEqual(q.calls, [30], "never focused but off-screen: still the background rate, not uncapped");
  d2.dispose();
  const r = page({ search: "?targetFps=0" });
  r.win.screenX = -32000;
  const d3 = FC.createFrameCapDriver({ win: r.win, doc: r.doc });
  d3.setPolicy(POLICY);
  assert.deepEqual(r.calls, [], "?targetFps=0 (a timing bench) still wins");
  d3.dispose();
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

// The runtime cap's timeline gate (2026-10-20, improvement hunt recent-rynth-diff-3),
// lifted from the shipped source like the setter above.
const GATE_SRC = [lift(/export function pacerDelayMs\([\s\S]*?\n}\n/), lift(/export const SOFT_CAP_LOCK_TOLERANCE = [^;]+;/), liftBlock(INDEX_SRC, "export function createSoftCapGate() {")]
  .join("\n").replace(/export /g, "");
const G = runLifted(GATE_SRC, {}, "{ pacerDelayMs, createSoftCapGate, SOFT_CAP_LOCK_TOLERANCE }");
/** A display refreshing at `hz` drives the gate as softCapTick does: a callback at every vsync the
 *  loop asked for; a rendered frame works `work` ms and its rAF lands on the first vsync after
 *  that, a skipped one re-arms at once (the next vsync). rAF timestamps carry ±`jitter` ms.
 *  Measured after a 2 s warm-up. */
function vsyncRun({ hz, cap, seconds = 30, work = 6, jitter = 0, seed = 1, workFn = null, capAt = null, gate = G.createSoftCapGate() }) {
  const P = 1000 / hz;
  let rnd = seed >>> 0;
  const rand = () => ((rnd = (Math.imul(rnd, 1664525) + 1013904223) >>> 0) / 4294967296);
  const renders = [];
  for (let k = 0; k * P < seconds * 1000;) {
    const t = k * P;
    const ts = t + (jitter ? (rand() * 2 - 1) * jitter : 0);
    if (gate.shouldRender(ts, 1000 / (capAt ? capAt(t) : cap))) {
      renders.push(k);
      const w = workFn ? workFn(renders.length, rand, t) : work;
      k = Math.max(k + 1, Math.ceil((t + w) / P - 1e-9));
    } else {
      k += 1;
    }
  }
  const warm = renders.filter((k) => k * P >= 2000);
  const gaps = new Map();
  for (let i = 1; i < warm.length; i += 1) gaps.set(warm[i] - warm[i - 1], (gaps.get(warm[i] - warm[i - 1]) || 0) + 1);
  const fps = (warm.length - 1) / (((warm.at(-1) - warm[0]) * P) / 1000);
  return { fps, gaps: Object.fromEntries([...gaps].sort((a, b) => a[0] - b[0])), renders, gate };
}
const HZ = [60, 75, 100, 120, 144, 165, 240];

await check("the 10-19 soft sleep (the bug, kept here as the reference): a 60 cap missed on 75 / 100 / 144 / 165 Hz; the exact pacer halves a cap at the display's rate", () => {
  // softCapDelayMs as it shipped 2026-10-19, in the model the old check used (work 6 ms, timer slop 1 ms).
  const softCapDelayMs1019 = (ivl, last, now) => Math.max(0, G.pacerDelayMs(ivl, last, now) - 4);
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
  assert.ok(fpsOver(G.pacerDelayMs, 60, 60) <= 31, "the exact pacer: 60 fps cap on 60 Hz → ~30 fps (the bug a URL cap never hits in tooling)");
  const old = Object.fromEntries([75, 100, 144, 165].map((hz) => [hz, fpsOver(softCapDelayMs1019, hz, 60)]));
  for (const [hz, f] of Object.entries(old)) assert.ok(Math.abs(f - 60) >= 5, `the 10-19 sleep, 60 cap on ${hz} Hz: ${f} fps`);
  assert.deepEqual(old, { 75: 38, 100: 50, 144: 72, 165: 55 }, "37.5 / 50 / 72 / 55 fps (frame counts in 1 s)");
  for (const hz of [75, 100, 144, 165]) near(vsyncRun({ hz, cap: 60 }).fps, 60, 0.05, `the gate, 60 cap on ${hz} Hz`);
});

await check("the gate: a 60 or 30 cap is the cap on 60 / 75 / 100 / 120 / 144 / 165 / 240 Hz, gaps only ⌊hz/cap⌋ or ⌈hz/cap⌉ refreshes", () => {
  for (const cap of [60, 30]) {
    for (const hz of HZ) {
      for (const jitter of [0, 0.5]) {
        const r = vsyncRun({ hz, cap, jitter, seed: hz + cap });
        near(r.fps, cap, 0.05, `${cap} cap on ${hz} Hz, rAF jitter ±${jitter} ms (gaps ${JSON.stringify(r.gaps)})`);
        const allowed = new Set([Math.floor(hz / cap), Math.ceil(hz / cap)]);
        for (const g of Object.keys(r.gaps)) assert.ok(allowed.has(+g), `${cap} on ${hz} Hz ±${jitter}: a ${g}-refresh gap (${JSON.stringify(r.gaps)})`);
      }
    }
  }
});

await check("the gate on a whole number of refreshes locks to the vsync: 60 / 30 on 60 / 120 / 240 Hz and on 59.94 / 60.02 / 119.98 / 120.05 Hz screens — every gap exactly n refreshes", () => {
  for (const cap of [60, 30]) {
    for (const hz of [60, 120, 240, 59.94, 60.02, 119.98, 120.05, 239.76]) {
      const n = Math.round(hz / cap);
      for (const jitter of [0, 0.5]) {
        const r = vsyncRun({ hz, cap, jitter, seed: 7 });
        assert.deepEqual(Object.keys(r.gaps), [String(n)], `${cap} cap on ${hz} Hz ±${jitter} ms: ${JSON.stringify(r.gaps)} (a bare timeline beats against the screen)`);
        near(r.fps, hz / n, 0.01, `${cap} on ${hz} Hz runs the screen's rate / ${n}`);
        assert.equal(r.gate.state().lockN, n);
      }
    }
  }
  assert.equal(G.SOFT_CAP_LOCK_TOLERANCE, 0.02);
  assert.equal(vsyncRun({ hz: 144, cap: 60 }).gate.state().lockN, 0, "2.4 refreshes: on the timeline");
});

await check("the gate under load: frames that take longer than the cap's gaps run as fast as the work allows; a stall carries at most one interval of catch-up (none when locked)", () => {
  near(vsyncRun({ hz: 60, cap: 60, work: 12 }).fps, 60, 0.01, "60 Hz, 12 ms frames");
  near(vsyncRun({ hz: 60, cap: 60, work: 20 }).fps, 30, 0.01, "60 Hz, 20 ms frames: two refreshes each");
  near(vsyncRun({ hz: 144, cap: 60, work: 10 }).fps, 60, 0.05, "144 Hz, 10 ms frames");
  near(vsyncRun({ hz: 120, cap: 30, work: 10 }).fps, 30, 0.01, "120 Hz, 10 ms frames, 30 cap");
  // one 80 ms stall at t = 5 s
  const stall = (hz, cap) => vsyncRun({ hz, cap, seconds: 16, workFn: (_i, _r, t) => (t >= 5000 && t < 5000 + 1000 / hz ? 80 : 6) });
  for (const [hz, cap] of [[144, 60], [165, 60], [100, 60], [75, 60], [120, 60], [60, 30], [240, 60]]) {
    const r = stall(hz, cap);
    const P = 1000 / hz;
    const I = 1000 / cap;
    const at = r.renders.findIndex((k) => k * P >= 5000); // the stall frame
    const back = r.renders[at + 1] * P; // the first frame after it
    const inWindow = r.renders.filter((k) => k * P >= back && k * P < back + 5 * I).length;
    if (Number.isInteger(hz / cap)) {
      const gaps = r.renders.slice(at + 1, at + 12).map((k, i, a) => (i ? k - a[i - 1] : hz / cap)).slice(1);
      assert.ok(gaps.every((g) => g === hz / cap), `${cap} on ${hz} Hz (locked) after an 80 ms stall: gaps ${gaps}, no catch-up`);
    } else {
      // the timeline lags the late frame by at most one interval: over the cap's 5 frames, that
      // frame, one interval of debt and one for the window's alignment — never the 80 ms stall's 4-5
      assert.ok(inWindow <= 8, `${cap} on ${hz} Hz after an 80 ms stall: ${inWindow} frames in the next 5 intervals`);
    }
    near((r.renders.filter((k) => k * P >= 6000).length - 1) / ((r.renders.at(-1) - r.renders.find((k) => k * P >= 6000)) * P / 1000), cap, 0.1, `${cap} on ${hz} Hz: back on the cap a second later`);
  }
});

await check("the gate: a cap change keeps the phase and applies at the next refresh; a 250 ms gap starts a new timeline; a bad interval renders", () => {
  const r = vsyncRun({ hz: 120, cap: 60, seconds: 6, capAt: (t) => (t < 3000 ? 60 : 30) });
  const gapsAfter = r.renders.filter((k) => (k * 1000) / 120 >= 3000).map((k, i, a) => (i ? k - a[i - 1] : 4));
  assert.ok(gapsAfter.length > 80 && gapsAfter.every((g) => g === 4), `60 → 30 on 120 Hz: every 4th refresh from the switch on (${gapsAfter.length} frames)`);
  const t2 = vsyncRun({ hz: 144, cap: 60, seconds: 10, capAt: (t) => (t < 5000 ? 60 : 30) });
  const after = t2.renders.filter((k) => (k * 1000) / 144 >= 5000);
  near((after.length - 1) / ((after.at(-1) - after[0]) / 144), 30, 0.1, "60 → 30 on 144 Hz: 30 fps after");
  const P = 1000 / 144;
  const I = 1000 / 60;
  const g = G.createSoftCapGate();
  let t = 0;
  for (; t < 1000; t += P) g.shouldRender(t, I);
  t += 300;
  assert.equal(g.shouldRender(t, I), true, "back after 300 ms (a hidden tab): render at once");
  near(g.state().due, t + I, 1e-9, "…on a new timeline: the next frame one interval on");
  assert.equal(g.shouldRender(t + P, I), false, "no catch-up frame on the next refresh");
  assert.equal(g.shouldRender(NaN, I), true);
  assert.equal(g.shouldRender(t + 2 * P, 0), true);
});

await check("the gate's refresh period: a first multi-refresh sample re-seeds down, a lone short (jitter) delta does not, a slower screen re-seeds up", () => {
  const P = 1000 / 144;
  const r = vsyncRun({ hz: 144, cap: 60, seconds: 3, workFn: (i) => (i === 1 ? 10 : 6) });
  near(r.gate.state().periodMs, P, 0.01, "first delta two refreshes (a 10 ms first frame), then one");
  const g = G.createSoftCapGate();
  let t = 0;
  for (let i = 0; i < 40; i += 1) { g.shouldRender(t, 1000 / 60); t += P; }
  g.shouldRender(t - P * 0.6, 1000 / 60); // a lone short delta
  t += P * 0.4;
  for (let i = 0; i < 20; i += 1) { g.shouldRender(t, 1000 / 60); t += P; }
  near(g.state().periodMs, P, 0.2, "a lone short delta is jitter");
  const P60 = 1000 / 60;
  for (let i = 0; i < 40; i += 1) { g.shouldRender(t, 1000 / 60); t += P60; }
  near(g.state().periodMs, P60, 0.01, "moved to a 60 Hz screen: 32 long deltas in a row re-seed it");
  assert.equal(g.state().lockN, 1, "…and a 60 cap now locks to every refresh");
});

await check("scheduleNext: a runtime cap re-arms through softCapTick every refresh; the URL cap keeps the exact sleep", () => {
  assert.match(INDEX_SRC, /if \(_frameCapSoft\) \{\n\s*_schedRafId = requestAnimationFrame\(softCapTick\);\n\s*return;\n\s*\}/);
  assert.match(INDEX_SRC, /const delay = pacerDelayMs\(_ivl, lastFrameTs, now\);/);
  assert.match(INDEX_SRC, /\n {2}const _softCapGate = createSoftCapGate\(\);\n/);
  assert.doesNotMatch(INDEX_SRC, /softCapDelayMs\(/, "the 10-19 sleep is gone");
  const SCHEDULE = liftBlock(INDEX_SRC, "function scheduleNext() {");
  const scope = (soft) => {
    const s = {
      adaptiveGpuProbe: null, renderOnDemand: false, liveScene3dRef: {}, portalSpaceFrameIntervalMs: (x) => x,
      _frameIntervalMs: 1000 / 60, _frameCapSoft: soft, pacerDelayMs: () => 9, lastFrameTs: 0, performance: { now: () => 5 },
      _schedTimeoutId: null, _schedRafId: null, tick() {}, softCapTick() {}, rafs: [], timeouts: [],
    };
    s.requestAnimationFrame = (f) => { s.rafs.push(f); return 7; };
    s.setTimeout = (f, ms) => { s.timeouts.push(ms); return 3; };
    return s;
  };
  const soft = scope(true);
  runLifted(SCHEDULE, soft, "scheduleNext")();
  assert.deepEqual([soft.rafs.length, soft.rafs[0] === soft.softCapTick, soft.timeouts.length, soft._schedRafId], [1, true, 0, 7]);
  const url = scope(false);
  runLifted(SCHEDULE, url, "scheduleNext")();
  assert.deepEqual([url.rafs.length, url.timeouts], [0, [9]], "?targetFps: the exact pacer's sleep");
});

await check("softCapTick: a skipped refresh re-arms itself and does no frame work; a let-through one runs tick(ts); a released cap renders at once; stopped → nothing", () => {
  const TICK = liftBlock(INDEX_SRC, "function softCapTick(nowTs) {");
  const scope = ({ soft = true, verdict = false, running = true } = {}) => {
    const s = {
      running, _frameCapSoft: soft, _frameIntervalMs: 1000 / 60, portalSpaceFrameIntervalMs: (x) => Math.max(x, s.portal || 0),
      performance: { now: () => 1 }, _schedRafId: 99, asked: [], ticks: [], rafs: [],
      _softCapGate: { shouldRender: (ts, ivl) => { s.asked.push([ts, ivl]); return verdict; } },
    };
    s.tick = (ts) => s.ticks.push(ts);
    s.requestAnimationFrame = (f) => { s.rafs.push(f); return 11; };
    return s;
  };
  const skip = scope();
  const fn = runLifted(TICK, skip, "softCapTick");
  fn(100);
  assert.deepEqual([skip.asked, skip.ticks, skip.rafs.length, skip.rafs[0] === fn, skip._schedRafId], [[[100, 1000 / 60]], [], 1, true, 11]);
  const go = scope({ verdict: true });
  runLifted(TICK, go, "softCapTick")(116);
  assert.deepEqual([go.ticks, go.rafs.length, go._schedRafId], [[116], 0, null]);
  const portal = scope({ verdict: true });
  portal.portal = 1000 / 30;
  runLifted(TICK, portal, "softCapTick")(5);
  assert.deepEqual(portal.asked, [[5, 1000 / 30]], "the portal tunnel's pace reaches the gate");
  const released = scope({ soft: false });
  runLifted(TICK, released, "softCapTick")(200);
  assert.deepEqual([released.asked.length, released.ticks], [0, [200]], "no cap: render now, no gate");
  const stopped = scope({ running: false, verdict: true });
  runLifted(TICK, stopped, "softCapTick")(300);
  assert.deepEqual([stopped.asked.length, stopped.ticks.length, stopped.rafs.length, stopped._schedRafId], [0, 0, 0, null]);
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

console.log("\n— the 1070 bench / probe drivers pin ?targetFps=0 (scripts/perf-worker)");

// 2026-10-20 (improvement hunt recent-rynth-diff-1): connectOverCDP's focus emulation makes
// document.hasFocus() true on the bench Chrome, so the "never focused" exemption above never
// applies there; every driver URL goes through lib/bench-url.mjs instead.
const PERF = path.resolve(APP, "..", "..", "scripts", "perf-worker");
const { uncappedBenchUrl } = await import(pathToFileURL(path.join(PERF, "lib", "bench-url.mjs")).href);

await check("uncappedBenchUrl: appends targetFps=0 unless the query names targetFps; the rest byte for byte", () => {
  const base = "http://100.116.47.66:7093/apps/holtburger-web/index.html";
  const q = "?autoLogin=1&nosw=1&bridge_url=ws://100.116.47.66:7093/wsbridge&quality=mid";
  assert.equal(uncappedBenchUrl(base + q), `${base}${q}&targetFps=0`, "no re-encoding of bridge_url");
  assert.equal(uncappedBenchUrl(`${base}${q}&targetFps=60`), `${base}${q}&targetFps=60`, "an arm benching a cap keeps it");
  assert.equal(uncappedBenchUrl(`${base}?targetFps=0&nosw=1`), `${base}?targetFps=0&nosw=1`);
  assert.equal(uncappedBenchUrl(base), `${base}?targetFps=0`);
  assert.equal(uncappedBenchUrl(`${base}?`), `${base}?targetFps=0`);
  assert.equal(uncappedBenchUrl(`${base}?a=1&`), `${base}?a=1&targetFps=0`);
  assert.equal(uncappedBenchUrl(`${base}?a=1#x`), `${base}?a=1&targetFps=0#x`);
  assert.equal(uncappedBenchUrl(`${base}?targetfps=30`), `${base}?targetfps=30&targetFps=0`, "the page reads targetFps case-sensitively");
});

await check("a bench URL never gets the policy's cap — even focused (focus emulation), with the 60 / 30 policy set", () => {
  const url = new URL(uncappedBenchUrl("http://127.0.0.1:8765/apps/holtburger-web/index.html?autoLogin=1&nosw=1&quality=mid"));
  assert.equal(FC.urlNamesFrameCap(url.search), true);
  assert.equal(FC.urlFrameCapFps(url.search), 0, "an uncapped pin, not a pace");
  const p = page({ search: url.search, focused: true });
  const said = [];
  const d = FC.createFrameCapDriver({ win: p.win, doc: p.doc, onPinned: (fps, why) => said.push([fps, why]) });
  d.setPolicy(POLICY);
  p.win.fire("focus");
  p.setFocus(false);
  p.win.fire("blur");
  d.refresh();
  assert.deepEqual(p.calls, [], "the loop stays bare rAF");
  assert.deepEqual(said, [[0, "url"]]);
  d.dispose();
  // the same page without the pin: focus emulation → capped at 60 at once (the trap)
  const trap = page({ search: "?autoLogin=1&nosw=1", focused: true });
  const d2 = FC.createFrameCapDriver({ win: trap.win, doc: trap.doc });
  d2.setPolicy(POLICY);
  assert.deepEqual(trap.calls, [60]);
  d2.dispose();
});

await check("every perf-worker / coldboot driver that loads index.html passes its URL through uncappedBenchUrl", () => {
  const files = [
    ...readdirSync(PERF).filter((n) => /\.(mjs|cjs)$/.test(n)),
    ...readdirSync(path.join(PERF, "coldboot")).filter((n) => n.endsWith(".mjs")).map((n) => `coldboot/${n}`),
  ];
  const builders = [];
  for (const rel of files) {
    const src = readFileSync(path.join(PERF, rel), "utf8");
    if (!/holtburger-web\/index\.html/.test(src)) continue;
    builders.push(rel);
    const imp = /import\(?[^;\n]*?["'](\.{1,2}\/lib\/bench-url\.mjs)["']/.exec(src) || /path\.join\(__dirname, "lib", "bench-url\.mjs"\)/.exec(src);
    assert.ok(imp, `${rel}: imports lib/bench-url.mjs`);
    if (imp[1]) assert.ok(existsSync(path.resolve(PERF, path.dirname(rel), imp[1])), `${rel}: ${imp[1]} resolves`);
    assert.doesNotMatch(src, /\.goto\(\s*[`"']/, `${rel}: no goto() of a bare URL literal`);
    const names = [...src.matchAll(/\.goto\(\s*([A-Za-z_$][\w$]*)\s*,/g)].map((m) => m[1]);
    assert.ok(names.length > 0, `${rel}: a goto()`);
    for (const n of new Set(names)) {
      assert.match(src, new RegExp(`(?:const|let)\\s+${n}\\s*=\\s*uncappedBenchUrl\\(`), `${rel}: goto(${n}) — ${n} is built by uncappedBenchUrl`);
    }
  }
  for (const want of ["flag-bench.mjs", "hbbench.mjs", "hbprobe.mjs", "hbsess.mjs", "biome-eyetest.mjs", "tour-lbs.mjs", "walk-west-driver.mjs",
    "indoor-outdoor-fps.cjs", "coldboot/academy.mjs", "coldboot/coldboot.mjs", "coldboot/sess.mjs"]) {
    assert.ok(builders.includes(want), `${want} found among the URL builders (${builders})`);
  }
  const poi = readFileSync(path.join(PERF, "poi-battery.mjs"), "utf8");
  assert.match(poi, /launchAndEnter\(\{ query: \{[^}]*targetFps: "0"/, "poi-battery: the harness boot query pins targetFps=0");
  const trace = readFileSync(path.join(PERF, "gputrace.mjs"), "utf8");
  assert.match(trace, /window\.__frameCapState\?\.\(\)/, "gputrace (attaches to a booted page): reports the loop's cap");
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
