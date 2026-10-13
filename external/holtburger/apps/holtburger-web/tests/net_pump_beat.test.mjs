// tests/net_pump_beat.test.mjs — app-loop-4 (2026-10-13).
//
// In a hidden tab the only thing that re-drove the page net/movement pump
// (`window.__netFramePump` = pumpNetFrame → app/frame_pump.js tickMovement
// fallback) was the scene3d net watchdog, a MAIN-THREAD setInterval(500).
// Chrome drops hidden-page timers to ~1 wake-up per minute after ~5 min, so
// the movement tick's dt reached ~60 s and the Rust spine dropped it
// (dt > HUGE_QUANTUM 2.0 — retail CPhysicsObj::update_object skips a quantum
// over 2.0 s). The keepalive worker (not throttled) now also posts a 250 ms
// 'beat'; the watchdog pumps on it through scene3d/net_pump_gate.js with
// rynth/webhost.js's thresholds (200 ms hidden / 1000 ms visible).
//
//   G1 pumpStaleDecision: hidden 150/250, visible 900/1100, never-pumped
//   G2 pumpIfStale: no pump before __netFramePump exists; one shared gate on
//      __lastPumpMs → beat + interval back-to-back never double-pump
//   G3 thresholds equal rynth/webhost.js PUMP_STALE_MS / PUMP_STALE_VISIBLE_MS
//   W1 keepalive_worker.js (node vm, fake timers): start without beatMs posts
//      no beats; with beatMs both cadences run; floor 100; restart/stop clear
//   W2 keepalive_worker.js stays classic-worker-safe (no module syntax)
//   C1 keepalive_worker_client.js (fake Worker): start posts beatMs 250;
//      'beat' → the onKeepaliveBeat subscriber only, 'tick' → onTick only
//   C2 subscriber replace / unsubscribe / throw isolation; ?keepaliveWorker=0
//   S1 end-to-end hidden tab, 60 s, rAF stopped: worker beat → client → gate
//      pumps every 250 ms — max movement dt far under HUGE_QUANTUM
//   S2 with a 15 Hz rynth-style heartbeat on the same gate: no pump pair
//      closer than the hidden threshold (no double pump)
//   I1 scene3d/index.js wiring: the watchdog registers the beat inside the
//      ?netWatchdog block and its teardown unsubscribes it
//
// Run: node tests/net_pump_beat.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const here = new URL(".", import.meta.url);
const src = (rel) => readFileSync(new URL(rel, here), "utf8");

const gate = await import(new URL("../scene3d/net_pump_gate.js", here).href);
const { pumpStaleDecision, pumpIfStale, PUMP_STALE_HIDDEN_MS, PUMP_STALE_VISIBLE_MS } = gate;

// ── fake timers ────────────────────────────────────────────────────────────
function makeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map(); // id -> {fn, ms, due}
  return {
    get now() { return now; },
    setInterval(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, ms, due: now + ms });
      return id;
    },
    clearInterval(id) { timers.delete(id); },
    intervals() { return [...timers.values()].map((t) => t.ms).sort((a, b) => a - b); },
    /** Advance to `to`, firing every due timer in time order. */
    advance(to) {
      for (;;) {
        let best = null;
        for (const [id, t] of timers) {
          if (t.due <= to && (best === null || t.due < best.t.due)) best = { id, t };
        }
        if (!best) break;
        now = best.t.due;
        best.t.due += best.t.ms;
        best.t.fn();
      }
      now = to;
    },
  };
}

/** Load scene3d/keepalive_worker.js (a classic worker script) in a vm with a
 * stub `self` and the fake clock's timers. Returns {send, posted, clock}. */
function loadWorker() {
  const clock = makeClock();
  const posted = [];
  const self = { postMessage: (m) => posted.push(m), onmessage: null };
  const ctx = vm.createContext({
    self,
    setInterval: (fn, ms) => clock.setInterval(fn, ms),
    clearInterval: (id) => clock.clearInterval(id),
    Number,
    Math,
  });
  vm.runInContext(src("../scene3d/keepalive_worker.js"), ctx, { filename: "keepalive_worker.js" });
  assert.equal(typeof self.onmessage, "function", "worker installs self.onmessage");
  return { send: (data) => self.onmessage({ data }), posted, clock };
}

const count = (arr, type) => arr.filter((m) => m && m.type === type).length;

// ── G: the gate ────────────────────────────────────────────────────────────

test("G1 pumpStaleDecision — hidden 200 ms / visible 1000 ms / never pumped", () => {
  const now = 100_000;
  assert.equal(pumpStaleDecision({ now, last: now - 150, hidden: true }), false, "hidden, 150 ms → no pump");
  assert.equal(pumpStaleDecision({ now, last: now - 250, hidden: true }), true, "hidden, 250 ms → pump");
  assert.equal(pumpStaleDecision({ now, last: now - 900, hidden: false }), false, "visible, 900 ms → no pump");
  assert.equal(pumpStaleDecision({ now, last: now - 1100, hidden: false }), true, "visible, 1100 ms → pump");
  assert.equal(pumpStaleDecision({ now, last: undefined, hidden: false }), true, "never pumped → pump");
  assert.equal(pumpStaleDecision({ now, last: undefined, hidden: true }), true, "never pumped (hidden) → pump");
  assert.equal(pumpStaleDecision({ now, last: NaN }), true, "junk heartbeat → pump");
  // Boundary keeps the original watchdog's `now - last <= STALE_MS` = quiet.
  assert.equal(pumpStaleDecision({ now, last: now - 1000 }), false, "exactly 1000 ms visible → quiet (watchdog parity)");
  // A visible-but-slow page (SwiftShader / ?targetFps=4, ~250 ms frames) is
  // never pumped between its own frames.
  assert.equal(pumpStaleDecision({ now, last: now - 260, hidden: false }), false);
  // Explicit thresholds override the defaults.
  assert.equal(pumpStaleDecision({ now, last: now - 300, hidden: true, staleHiddenMs: 1000 }), false);
});

test("G2 pumpIfStale — no pump before the pump exists; one gate, no double pump", () => {
  const win = {};
  assert.equal(pumpIfStale(win, { now: 5000, hidden: true }), false, "no __netFramePump → no-op");
  assert.equal(pumpIfStale(null, { now: 5000 }), false, "no window → no-op");

  let clockNow = 10_000;
  let pumps = 0;
  win.__netFramePump = () => { pumps++; win.__lastPumpMs = clockNow; };
  win.__lastPumpMs = clockNow - 5000; // rAF stopped 5 s ago
  // Worker beat (hidden-aware) fires first …
  assert.equal(pumpIfStale(win, { now: clockNow, hidden: true }), true);
  // … then the 500 ms interval in the same turn: the pump re-stamped the
  // heartbeat, so it skips.
  assert.equal(pumpIfStale(win, { now: clockNow, hidden: false }), false);
  // A healthy rAF stamps every frame → the gate is a no-op.
  clockNow += 16;
  win.__lastPumpMs = clockNow;
  assert.equal(pumpIfStale(win, { now: clockNow + 16, hidden: true }), false);
  assert.equal(pumps, 1);
});

test("G3 thresholds equal rynth/webhost.js PUMP_STALE_MS / PUMP_STALE_VISIBLE_MS", () => {
  const w = src("../rynth/webhost.js");
  const hid = /const PUMP_STALE_MS = (\d+);/.exec(w);
  const vis = /const PUMP_STALE_VISIBLE_MS = (\d+);/.exec(w);
  assert.ok(hid && vis, "rynth/webhost.js still declares both thresholds");
  assert.equal(PUMP_STALE_HIDDEN_MS, Number(hid[1]));
  assert.equal(PUMP_STALE_VISIBLE_MS, Number(vis[1]));
  assert.equal(PUMP_STALE_HIDDEN_MS, 200);
  assert.equal(PUMP_STALE_VISIBLE_MS, 1000);
});

// ── W: the worker script ───────────────────────────────────────────────────

test("W1 keepalive_worker.js — beat only when asked; both cadences; floor; stop", () => {
  const w = loadWorker();
  // start WITHOUT beatMs → keepalive tick only.
  w.send({ type: "start", intervalMs: 2000 });
  assert.deepEqual(w.clock.intervals(), [2000]);
  w.clock.advance(10_000);
  assert.equal(count(w.posted, "tick"), 5);
  assert.equal(count(w.posted, "beat"), 0, "no beatMs → no beats");

  // restart WITH beatMs 250 → the 2 s tick is untouched, a 250 ms beat added.
  w.posted.length = 0;
  w.send({ type: "start", intervalMs: 2000, beatMs: 250 });
  assert.deepEqual(w.clock.intervals(), [250, 2000], "old tick replaced, beat added");
  w.clock.advance(w.clock.now + 2000);
  assert.equal(count(w.posted, "tick"), 1);
  assert.equal(count(w.posted, "beat"), 8);

  // floor: a bad beatMs can't spin the worker.
  w.send({ type: "start", intervalMs: 2000, beatMs: 10 });
  assert.deepEqual(w.clock.intervals(), [100, 2000], "beatMs floored at 100");
  // 0 / junk = no beat; a restart without beatMs clears the old beat timer.
  w.send({ type: "start", intervalMs: 2000, beatMs: 0 });
  assert.deepEqual(w.clock.intervals(), [2000]);
  w.send({ type: "start", intervalMs: 2000, beatMs: "junk" });
  assert.deepEqual(w.clock.intervals(), [2000]);
  w.send({ type: "start", intervalMs: 2000, beatMs: 250 });
  w.send({ type: "start", intervalMs: 2000 });
  assert.deepEqual(w.clock.intervals(), [2000], "restart without beatMs drops the beat");

  // stop clears both.
  w.send({ type: "start", intervalMs: 2000, beatMs: 250 });
  w.send({ type: "stop" });
  assert.deepEqual(w.clock.intervals(), []);
  w.posted.length = 0;
  w.clock.advance(w.clock.now + 5000);
  assert.equal(w.posted.length, 0, "nothing posted after stop");
});

test("W2 keepalive_worker.js stays classic-worker-safe (no module syntax)", () => {
  const code = src("../scene3d/keepalive_worker.js").replace(/\/\/.*$/gm, "");
  assert.ok(!/(^|[;{}\n])\s*(import|export)[\s({"']/.test(code));
});

// ── C: the main-thread client ──────────────────────────────────────────────

class FakeWorker {
  static instances = [];
  constructor(url) {
    this.url = String(url);
    this.posted = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    FakeWorker.instances.push(this);
  }
  postMessage(m) { this.posted.push(m); }
  terminate() { this.terminated = true; }
}

const savedLog = console.log;
globalThis.Worker = FakeWorker;
globalThis.location = { search: "" };
const client = await import(new URL("../scene3d/keepalive_worker_client.js", here).href);
const { startKeepaliveWorker, stopKeepaliveWorker, onKeepaliveBeat, KEEPALIVE_BEAT_MS } = client;

function quiet(fn) {
  console.log = () => {};
  try { return fn(); } finally { console.log = savedLog; }
}

test("C1 client — start posts beatMs 250; beat → subscriber, tick → onTick", () => {
  FakeWorker.instances.length = 0;
  let ticks = 0;
  let beats = 0;
  const off = onKeepaliveBeat(() => { beats++; });
  assert.equal(quiet(() => startKeepaliveWorker(() => { ticks++; })), true);
  assert.equal(FakeWorker.instances.length, 1);
  const w = FakeWorker.instances[0];
  assert.match(w.url, /scene3d\/keepalive_worker\.js$/);
  assert.equal(KEEPALIVE_BEAT_MS, 250);
  assert.deepEqual(w.posted[0], { type: "start", intervalMs: 2000, beatMs: 250 });
  assert.equal(quiet(() => startKeepaliveWorker(() => {})), false, "once per page");

  w.onmessage({ data: { type: "beat" } });
  assert.equal(beats, 1);
  assert.equal(ticks, 0, "a beat is not a keepalive");
  w.onmessage({ data: { type: "tick" } });
  assert.equal(ticks, 1);
  assert.equal(beats, 1, "a tick is not a beat");
  w.onmessage({ data: null });
  w.onmessage(null);
  assert.equal(ticks + beats, 2, "junk messages ignored");

  off();
  quiet(() => stopKeepaliveWorker());
  assert.equal(w.terminated, true);
  assert.deepEqual(w.posted.at(-1), { type: "stop" });
});

test("C2 client — single subscriber, stale unsubscribe, throw isolation, escape hatch", () => {
  FakeWorker.instances.length = 0;
  let ticks = 0;
  quiet(() => startKeepaliveWorker(() => { ticks++; }, 2000, 0));
  const w = FakeWorker.instances[0];
  assert.deepEqual(w.posted[0], { type: "start", intervalMs: 2000, beatMs: 0 }, "caller may opt out of the beat");

  // No subscriber → a beat is a no-op.
  w.onmessage({ data: { type: "beat" } });

  const hits = [];
  const offA = onKeepaliveBeat(() => hits.push("a"));
  const offB = onKeepaliveBeat(() => hits.push("b")); // replaces A
  w.onmessage({ data: { type: "beat" } });
  assert.deepEqual(hits, ["b"]);
  offA(); // stale — must not clear B
  w.onmessage({ data: { type: "beat" } });
  assert.deepEqual(hits, ["b", "b"]);
  offB();
  w.onmessage({ data: { type: "beat" } });
  assert.deepEqual(hits, ["b", "b"], "unsubscribed");

  // A throwing subscriber never breaks the worker's onmessage (or ticks).
  const offT = onKeepaliveBeat(() => { throw new Error("pump died"); });
  assert.doesNotThrow(() => w.onmessage({ data: { type: "beat" } }));
  w.onmessage({ data: { type: "tick" } });
  assert.equal(ticks, 1);
  offT();
  quiet(() => stopKeepaliveWorker());

  // ?keepaliveWorker=0 → no worker, hence no beat (the 500 ms interval stays).
  FakeWorker.instances.length = 0;
  globalThis.location = { search: "?keepaliveWorker=0" };
  assert.equal(quiet(() => startKeepaliveWorker(() => {})), false);
  assert.equal(FakeWorker.instances.length, 0);
  globalThis.location = { search: "" };
});

// ── S: end-to-end hidden tab ───────────────────────────────────────────────

/** Wire the vm worker's posts into the client's FakeWorker.onmessage, the
 * subscriber into the gate, and run `ms` of fake time with rAF stopped. */
function runHiddenTab({ ms, extraHeartbeatMs = 0 }) {
  FakeWorker.instances.length = 0;
  const wk = loadWorker();
  quiet(() => startKeepaliveWorker(() => {}));
  const fw = FakeWorker.instances[0];
  // Bridge: worker → main thread, and the client's start message → worker.
  wk.posted.push = (m) => { fw.onmessage({ data: m }); return 0; };
  wk.send(fw.posted[0]);

  const win = {};
  const pumpTimes = [];
  win.__netFramePump = () => { pumpTimes.push(wk.clock.now); win.__lastPumpMs = wk.clock.now; };
  win.__lastPumpMs = 0; // the last rAF frame, then the tab was hidden
  const off = onKeepaliveBeat(() => pumpIfStale(win, { now: wk.clock.now, hidden: true }));
  if (extraHeartbeatMs > 0) {
    // rynth/webhost.js _pumpIfStale shape: `now - last < 200` → skip.
    wk.clock.setInterval(() => {
      if (wk.clock.now - win.__lastPumpMs < PUMP_STALE_HIDDEN_MS) return;
      win.__netFramePump();
    }, extraHeartbeatMs);
  }
  wk.clock.advance(ms);
  off();
  quiet(() => stopKeepaliveWorker());
  const gaps = pumpTimes.slice(1).map((t, i) => t - pumpTimes[i]);
  return { pumpTimes, gaps };
}

test("S1 hidden tab, rAF stopped 60 s: worker beat keeps the movement dt tiny", () => {
  const { pumpTimes, gaps } = runHiddenTab({ ms: 60_000 });
  const HUGE_QUANTUM_MS = 2000; // crates/holtburger-core movement/common.rs
  assert.ok(pumpTimes.length >= 230, `~4 Hz pump (${pumpTimes.length} pumps in 60 s)`);
  assert.ok(pumpTimes[0] <= 250, "first pump within one beat of going stale");
  const maxGap = Math.max(...gaps);
  assert.ok(maxGap <= 250, `max dt ${maxGap} ms`);
  assert.ok(maxGap < HUGE_QUANTUM_MS / 4, "far under HUGE_QUANTUM");
});

test("S2 beat + a 15 Hz rynth-style heartbeat on one gate never double-pump", () => {
  const { pumpTimes, gaps } = runHiddenTab({ ms: 30_000, extraHeartbeatMs: 67 });
  assert.ok(pumpTimes.length > 100);
  const minGap = Math.min(...gaps);
  assert.ok(minGap >= PUMP_STALE_HIDDEN_MS, `no pump pair closer than the gate (min ${minGap} ms)`);
  // Combined rate stays ~4-5 Hz (not the sum of both heartbeats).
  assert.ok(pumpTimes.length <= Math.ceil(30_000 / PUMP_STALE_HIDDEN_MS), `rate ${pumpTimes.length}/30 s`);
});

// ── I: the scene3d watchdog wiring (source pins) ───────────────────────────

test("I1 scene3d/index.js — beat registered inside the ?netWatchdog block; teardown unsubscribes", () => {
  const s = src("../scene3d/index.js");
  assert.match(s, /import \{ onKeepaliveBeat \} from "\.\/keepalive_worker_client\.js";/);
  assert.match(s, /from "\.\/net_pump_gate\.js";/);
  const start = s.indexOf("const netWatchdogOn = (() => {");
  const end = s.indexOf("window.__stopNetWatchdog = () => {", start);
  assert.ok(start > 0 && end > start, "watchdog block found");
  const block = s.slice(start, end); // up to (not incl.) __stopNetWatchdog
  // The interval keeps its 500 ms cadence (visible 1 s gate) …
  assert.match(block, /setInterval\(\(\) => netPumpIfStale\(false\), 500\)/);
  // … and the beat runs the SAME body, hidden-aware.
  assert.match(block, /onKeepaliveBeat\(\(\) => netPumpIfStale\(true\)\)/);
  assert.match(block, /pumpIfStale\(window, \{ now, hidden \}\)/);
  assert.match(block, /fromBeat && typeof document !== "undefined" && document\.hidden === true/);
  // Gated by ?netWatchdog (registration sits after the netWatchdogOn check).
  assert.ok(block.indexOf("netWatchdogOn &&") < block.indexOf("onKeepaliveBeat("));
  // Teardown (beforeunload + __stopNetWatchdog) drops the beat too.
  const stopFn = s.slice(end, s.indexOf("};", end));
  assert.match(stopFn, /offNetWatchdogBeat\(\)/);
  assert.equal((block.match(/offNetWatchdogBeat\(\);/g) || []).length, 1, "beforeunload unsubscribes");
});
