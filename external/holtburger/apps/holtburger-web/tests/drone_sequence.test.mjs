// tests/drone_sequence.test.mjs
//
// WHY: scene3d/drone/sequence.js is the ONE place that decides what a Drone Deploy
// cycle does and, above all, what every exit undoes: the camera, the input lock,
// the held ReadState (never a Ready on a death or a combat stance), the props on
// the rig, the hidden wielded items, the rotors and the hum. A wrong row here is a
// stuck input gate, a corpse that stands up, a camera left in the goggles or a
// launcher stuck at "busy". This suite EXECUTES the real pure module through
// scripted tick streams (a small fake of the gestures' clip jobs feeds
// beatEvent / beatDone exactly as gestures.poll() does) and pins:
//   Q1  exports, frozen tables, the derived SEQUENCE_DEFAULTS relations, NO_ACTIONS identity;
//   Q2  T1, the prep (waits for `rig`, never `rigKnown`; dt > 0; the timeout keeps a known
//       humanoid's beats, an unknown rig takes the no-hands flow);
//   Q3  every deploy beat's entry / event / end actions (T2–T4), clip-ended and timer-ended,
//       every duration and event time at speed 1 and 1.5, the quick deploy;
//   Q4  the lift-off sub-events T5–T7 (each once, at cut*Sec ÷ speed; the own on the path
//       midpoint) and T8 by time, autopilotDone and anyInput (never before the own);
//   Q5  the SPEC §4.4 totals table (deploy at both speeds, humanoid and no-hands; stow);
//   Q6  skip (T9) from the prep, every beat and the lift-off before / after the own;
//   Q7  pilot view both ways (T10/T11), recall / recallInstant (T12–T15), the RTH cancel by a
//       FRESH stick input only (T16 `armed`; look / gimbal never cancel), T17, T20, T21;
//   Q8  the full and quick stow (T24/T25), the no-hands stow, the noDrone stow + settle (T26/T27);
//   Q9  battery RTH once (T18), the forced landing (T19, also from pilotView), crashes (T22/T23)
//       from every crash state, T28, T29;
//   Q10 every abort signal from every state against an oracle written from the SPEC §4.6
//       text (soft vs hard lists, ignored once unlocked, the second-abort upgrade), the
//       priority order, `death` / `combat` → no Ready, `hidden` never aborts;
//   Q11 idempotent requests, state() JSON-safe and fresh, deterministic replays, reset().
//
// Flag: `?drone`, DEFAULT ON since 2026-10-25 (`=off` disables it) — nothing under scene3d/drone/ loads with `?drone=off`.
// Run from apps/holtburger-web/: node tests/drone_sequence.test.mjs

import assert from "node:assert/strict";

const SQ = await import("../scene3d/drone/sequence.js");
const { createSequence, NO_ACTIONS, BEAT_SEC, BEAT_EVENT_SEC, SEQUENCE_DEFAULTS, HARD_ABORT_REASONS, ABORT_REASONS } = SQ;

let passed = 0;
let failed = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  [PASS] ${name}`);
    } catch (e) {
      failed += 1;
      const msg = e && e.message ? String(e.message).split("\n")[0] : String(e);
      const at = e && e.stack ? (e.stack.split("\n").find((l) => l.includes("drone_sequence.test")) || "").trim() : "";
      console.log(`  [FAIL] ${name} — ${msg}${at ? ` (${at})` : ""}`);
    }
  });
}

const near = (a, b, eps, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${b} ± ${eps}, got ${a}`);

// ---------------------------------------------------------------------------
// expected actions, written from the SPEC §4.3 table (independent of the module)
// ---------------------------------------------------------------------------

const A = {
  state: (state, prev) => ({ type: "state", state, prev }),
  inputLock: () => ({ type: "inputLock" }),
  inputRestore: () => ({ type: "inputRestore" }),
  phase: (phase) => ({ type: "controlsPhase", phase }),
  hide: (on) => ({ type: "hideWielded", on }),
  clip: (name, speed) => ({ type: "clip", name, speed }),
  stopClip: () => ({ type: "stopClip" }),
  readState: () => ({ type: "motion", cmd: "ReadState", speed: 1 }),
  ready: () => ({ type: "motion", cmd: "Ready", speed: 1 }),
  attach: (prop, anchor) => ({ type: "attach", prop, anchor }),
  detach: (prop, to) => ({ type: "detach", prop, to }),
  place: () => ({ type: "place", prop: "drone" }),
  fade: () => ({ type: "fadeOut", prop: "drone", delaySec: 5, durationSec: 1 }),
  own: () => ({ type: "cameraOwn" }),
  release: (framePilot) => ({ type: "cameraRelease", framePilot }),
  auto: (plan, speed = 1) => ({ type: "autopilot", plan, speed }),
  rotors: (level, rampSec) => ({ type: "rotors", level, rampSec }),
  osd: (mode, durationSec) => (durationSec === undefined ? { type: "osd", mode } : { type: "osd", mode, durationSec }),
  audio: (level, rampSec) => ({ type: "audio", level, rampSec }),
  broadcast: () => ({ type: "broadcastPose" }),
};

/** Gesture clip timing (gestures GESTURE_CLIPS frames / eventAtFrame, 30 fps). */
const CLIPS = { pack: { frames: 43, ev: 18 }, place: { frames: 50, ev: 18 }, goggles: { frames: 42, ev: 14 } };

function blankInput() {
  return {
    dt: 0, now: 0, request: null, arg: null, rig: null, rigKnown: null, beatEvent: false, beatDone: false,
    input: { sticksActive: false, anyInput: false },
    signals: { damage: false, death: false, portal: false, stanceCombat: false, pilotMovedM: 0, sessionChanged: false, filmBusy: false, contextLost: false, hidden: false },
    craft: { landed: false, aglM: 0, distHomeM: 0, distTouchdownM: null, impactSpeed: 0, autopilotDone: false, gone: false },
    battery: { level: 1, warn: false, rth: false, empty: false },
    crashMps: 7,
  };
}

/**
 * Drives a real sequence like scene3d/drone/index.js does: one reused tick input, request
 * ticks with dt = 0, frame ticks with a fake gestures driver (clip jobs report their event /
 * end on the poll that crosses eventAtFrame / frames ÷ 30 ÷ speed; timer beats get nothing).
 */
class Driver {
  constructor({ opts, rig = "humanoid", rigKnown, readyAt = 0, clipEvents = true, dt = 1 / 60 } = {}) {
    this.seq = createSequence(opts);
    this.i = blankInput();
    this.t = 0;
    this.rig = rig;
    this.rigKnown = rigKnown === undefined ? rig : rigKnown;
    this.readyAt = readyAt;
    this.clipEvents = clipEvents;
    this.dt = dt;
    this.job = null;
    this.deployT = null;
    this.stream = [];
    // per-frame levels the test sets
    this.sticks = { sticksActive: false, anyInput: false };
    this.signals = {};
    this.craft = {};
    this.battery = {};
    this.crashMps = 7;
  }

  st() {
    return this.seq.state();
  }

  _tick(dt, request, arg) {
    const i = this.i;
    this.t += dt;
    i.dt = dt;
    i.now = this.t;
    i.request = request;
    i.arg = arg;
    i.beatEvent = false;
    i.beatDone = false;
    if (dt > 0 && this.job && this.clipEvents) {
      const j = this.job;
      j.t += dt;
      if (!j.ev && j.t >= j.evAt) {
        j.ev = true;
        i.beatEvent = true;
      }
      if (j.t >= j.doneAt) {
        if (!j.ev) i.beatEvent = true;
        i.beatDone = true;
        this.job = null;
      }
    }
    const resolved = this.deployT !== null && this.t - this.deployT >= this.readyAt;
    i.rig = resolved ? this.rig : null;
    i.rigKnown = this.deployT !== null ? this.rigKnown : null;
    Object.assign(i.input, { sticksActive: false, anyInput: false }, this.sticks);
    Object.assign(i.signals, blankInput().signals, this.signals);
    Object.assign(i.craft, blankInput().craft, this.craft);
    Object.assign(i.battery, blankInput().battery, this.battery);
    i.crashMps = this.crashMps;
    const a = this.seq.tick(i);
    if (a.length) this.stream.push({ t: this.t, a });
    for (const x of a) {
      if (x.type === "clip") {
        const c = CLIPS[x.name];
        this.job = { t: 0, ev: false, evAt: c.ev / 30 / x.speed, doneAt: c.frames / 30 / x.speed };
      } else if (x.type === "stopClip") this.job = null;
    }
    return a;
  }

  req(name, arg = null) {
    if (name === "deploy" && this.deployT === null) this.deployT = this.t;
    return this._tick(0, name, arg);
  }

  frame(dt = this.dt) {
    return this._tick(dt, null, null);
  }

  /** Frames until pred(state) holds (throws after maxSec). Returns the actions of the last frame. */
  until(pred, maxSec = 40, dt = this.dt) {
    const end = this.t + maxSec;
    let a = NO_ACTIONS;
    while (!pred(this.st(), a)) {
      if (this.t > end) throw new Error(`until: not reached within ${maxSec} s (state ${JSON.stringify(this.st())})`);
      a = this.frame(dt);
    }
    return a;
  }

  /** The time of the first stream entry (after t0) holding an action that matches. */
  timeOf(match, t0 = -Infinity) {
    for (const e of this.stream) if (e.t > t0 && e.a.some(match)) return e.t;
    return null;
  }
}

const is = (type, extra = {}) => (a) => a.type === type && Object.entries(extra).every(([k, v]) => a[k] === v);

/** Drive to flying (humanoid unless rig given), returns the driver. */
function toFlying(o = {}) {
  const d = new Driver(o);
  d.req("deploy", { quick: o.quick === true });
  d.until((s) => s.state === "flying");
  return d;
}

// ---------------------------------------------------------------------------
// Q1 exports
// ---------------------------------------------------------------------------

check("Q1 tables: frozen, exact names, BEAT_SEC / BEAT_EVENT_SEC, SEQUENCE_DEFAULTS relations", () => {
  assert.deepEqual([...SQ.SEQUENCE_STATES], ["idle", "deploying", "flying", "pilotView", "returning", "landing", "stowing", "aborting", "crashed"]);
  assert.deepEqual([...SQ.REQUESTS], ["deploy", "skip", "recall", "recallInstant", "pilotView", "abort"]);
  assert.deepEqual([...SQ.ACTION_TYPES], ["state", "inputLock", "inputRestore", "controlsPhase", "hideWielded", "clip",
    "stopClip", "motion", "attach", "detach", "place", "fadeOut", "cameraOwn", "cameraRelease", "autopilot", "rotors", "osd",
    "audio", "broadcastPose"]);
  assert.deepEqual([...ABORT_REASONS], ["damage", "death", "portal", "combat", "pilotMoved", "session", "film", "contextLost", "user", "dispose", "rigLost", "error"]);
  assert.deepEqual([...HARD_ABORT_REASONS], ["session", "contextLost", "portal", "pilotMoved", "film", "dispose", "rigLost", "error"]);
  for (const t of [SQ.SEQUENCE_STATES, SQ.REQUESTS, SQ.ACTION_TYPES, ABORT_REASONS, HARD_ABORT_REASONS, BEAT_SEC, BEAT_EVENT_SEC, SEQUENCE_DEFAULTS, NO_ACTIONS]) {
    assert.ok(Object.isFrozen(t));
  }
  assert.equal(NO_ACTIONS.length, 0);
  assert.deepEqual({ ...BEAT_SEC }, { pack: 43 / 30, place: 50 / 30, goggles: 42 / 30, tabletUp: 22 / 30, tabletDown: 22 / 30, spawn: 22 / 30, powerDown: 0.6, liftoff: 2.2, crashStatic: 1.0 });
  assert.deepEqual({ ...BEAT_EVENT_SEC }, { pack: 18 / 30, place: 18 / 30, goggles: 14 / 30 });
  assert.deepEqual({ ...SEQUENCE_DEFAULTS }, { quickSpeed: 1.5, slackSec: 0.05, prepTimeoutSec: 1.0, crashStaticSec: 1.0, landingReleaseM: 5,
    homeToleranceM: 1.5, pilotMovedAbortM: 2, fadeDelaySec: 5, fadeDurationSec: 1, cutStartSec: 0.925, cutBlackSec: 1.1, cutEndSec: 1.275, settleTimeoutSec: 8 });
  const D = SEQUENCE_DEFAULTS;
  near(D.cutBlackSec, BEAT_SEC.liftoff / 2, 1e-12, "own on the lift-off path midpoint");
  near(D.cutStartSec, D.cutBlackSec - 0.175, 1e-12);
  near(D.cutEndSec, D.cutBlackSec + 0.175, 1e-12);
  near(D.settleTimeoutSec, D.fadeDelaySec + D.fadeDurationSec + 2, 1e-12);
});

check("Q1 NO_ACTIONS identity when nothing happens (idle, mid-beat, flying)", () => {
  const s = createSequence();
  const i = blankInput();
  i.dt = 1 / 60;
  assert.equal(s.tick(i), NO_ACTIONS);
  i.request = "recall";
  assert.equal(s.tick(i), NO_ACTIONS, "a request that does not apply");
  assert.equal(s.tick(null), NO_ACTIONS, "a non-object input never throws");
  const d = new Driver();
  d.req("deploy");
  d.frame(); // → pack
  assert.equal(d.frame(), NO_ACTIONS, "mid-beat");
  const f = toFlying();
  assert.equal(f.frame(), NO_ACTIONS, "flying, no input");
});

// ---------------------------------------------------------------------------
// Q2 T1 + the prep
// ---------------------------------------------------------------------------

check("Q2 T1 deploy: state, inputLock, controlsPhase(deploy), hideWielded(true); quick → speed 1.5", () => {
  const d = new Driver();
  assert.deepEqual(d.req("deploy", { quick: false }), [A.state("deploying", "idle"), A.inputLock(), A.phase("deploy"), A.hide(true)]);
  const s = d.st();
  assert.equal(s.state, "deploying");
  assert.equal(s.beat, "prep");
  assert.equal(s.beatIndex, 0);
  assert.equal(s.locked, true);
  assert.equal(s.wieldedHidden, true);
  assert.equal(s.quick, false);
  assert.equal(s.speed, 1);
  assert.equal(s.drone, "none");
  const q = new Driver();
  q.req("deploy", { quick: true });
  assert.equal(q.st().quick, true);
  assert.equal(q.st().speed, 1.5);
  // arg without quick / null arg → not quick
  const n = new Driver();
  n.req("deploy", null);
  assert.equal(n.st().quick, false);
});

check("Q2 the prep waits for `rig` (gestures.ready resolved), not `rigKnown`, and only on a frame (dt > 0)", () => {
  const d = new Driver({ rig: "humanoid", rigKnown: "humanoid", readyAt: 0.5 });
  d.req("deploy");
  // A request tick with dt = 0 never ends the prep.
  d.rigKnown = "humanoid";
  assert.equal(d.req("skip").length, 0, "skip in prep: no actions");
  assert.equal(d.st().pendingSkip, true);
  const d2 = new Driver({ readyAt: 0.5 });
  d2.req("deploy");
  for (let k = 0; k < 29; k += 1) assert.equal(d2.frame(), NO_ACTIONS, `frame ${k}: still waiting for ready() (rigKnown is already 'humanoid')`);
  assert.equal(d2.st().beat, "prep");
  const a = d2.until((s) => s.beat !== "prep");
  assert.deepEqual(a, [A.clip("pack", 1)]);
  near(d2.t, 0.5, 1 / 60 + 1e-9, "ends on the first frame after ready() resolved");
  // Resolved already at deploy: the deploy tick itself (dt = 0) keeps the prep; the first frame ends it.
  const d3 = new Driver({ readyAt: 0 });
  d3.req("deploy");
  assert.equal(d3.st().beat, "prep");
  assert.equal(d3.req("recall").length, 0);
  assert.equal(d3.st().beat, "prep", "a dt = 0 tick never ends the prep");
  assert.deepEqual(d3.frame(), [A.clip("pack", 1)]);
  assert.equal(d3.st().rig, "humanoid");
});

check("Q2 prep timeout (1.0 s): rigKnown 'humanoid' keeps the humanoid beats; rigKnown null → no-hands (spawn)", () => {
  const h = new Driver({ rig: "humanoid", rigKnown: "humanoid", readyAt: Infinity });
  h.req("deploy");
  const a = h.until((s) => s.beat !== "prep", 2);
  assert.deepEqual(a, [A.clip("pack", 1)]);
  near(h.t, 1.0, 1 / 60 + 1e-9);
  assert.equal(h.st().rig, "humanoid");
  const n = new Driver({ rig: "humanoid", rigKnown: null, readyAt: Infinity });
  n.req("deploy");
  const b = n.until((s) => s.beat !== "prep", 2);
  assert.deepEqual(b, [A.place(), A.rotors(1, 22 / 30), A.audio(1, 22 / 30)]);
  assert.equal(n.st().beat, "spawn");
  assert.equal(n.st().beatIndex, 4);
  assert.equal(n.st().rig, "no-hands");
  // A resolved no-hands rig takes the spawn beat at once; an unknown kind string reads as no-hands.
  const o = new Driver({ rig: "no-hands" });
  o.req("deploy");
  assert.deepEqual(o.frame(), [A.place(), A.rotors(1, 22 / 30), A.audio(1, 22 / 30)]);
  const u = new Driver({ rig: "olthoi?" });
  u.req("deploy");
  u.frame();
  assert.equal(u.st().rig, "no-hands");
});

// ---------------------------------------------------------------------------
// Q3 deploy beats
// ---------------------------------------------------------------------------

check("Q3 humanoid deploy (clip-ended beats): every entry / event / end action in order (T2–T4), then the lift-off and T8", () => {
  const d = new Driver({ dt: 1 / 240 });
  d.req("deploy");
  d.until((s) => s.state === "flying");
  const got = d.stream.map((e) => e.a);
  assert.deepEqual(got, [
    [A.state("deploying", "idle"), A.inputLock(), A.phase("deploy"), A.hide(true)],
    [A.clip("pack", 1)],
    [A.attach("drone", "rightHand")],
    [A.clip("place", 1)],
    [A.detach("drone", "world")],
    [A.clip("goggles", 1)],
    [A.attach("goggles", "head")],
    [A.attach("tablet", "leftHand"), A.readState(), A.broadcast(), A.rotors(1, 22 / 30), A.audio(1, 22 / 30)],
    [A.auto("liftoff", 1)],
    [A.osd("boot", 0.35)],
    [A.own(), A.phase("fly")],
    [A.osd("fpv")],
    [A.state("flying", "deploying"), A.auto(null)],
  ]);
  const s = d.st();
  assert.equal(s.fpv, true);
  assert.equal(s.drone, "air");
  assert.equal(s.tablet, true);
  assert.equal(s.goggles, true);
  assert.equal(s.held, true);
  assert.equal(s.beat, null);
  assert.equal(s.clipActive, false);
});

check("Q3 beat clock: clip events on beatEvent, ends on beatDone; timer fallback at eventSec + slack / dur + slack (speed 1 and 1.5)", () => {
  const dt = 1 / 600;
  const tol = dt + 1e-9;
  for (const quick of [false, true]) {
    const s = quick ? 1.5 : 1;
    for (const clipEvents of [true, false]) {
      const d = new Driver({ dt, clipEvents });
      d.req("deploy", { quick });
      d.until((st) => st.beat === "liftoff");
      const slack = clipEvents ? 0 : 0.05;
      // Beat boundaries from the stream.
      const tEnter = (name) => d.timeOf(is("clip", { name }));
      const beats = quick ? ["place", "goggles"] : ["pack", "place", "goggles"];
      if (!quick) assert.equal(d.timeOf(is("clip", { name: "pack" })) !== null, true);
      else assert.equal(d.timeOf(is("clip", { name: "pack" })), null, "quick: no pack beat");
      for (let k = 0; k < beats.length; k += 1) {
        const name = beats[k];
        const t0 = tEnter(name);
        const evTime = name === "pack" ? d.timeOf(is("attach", { prop: "drone" }), t0) : name === "place" ? d.timeOf(is("detach", { prop: "drone", to: "world" }), t0)
          : d.timeOf(is("attach", { prop: "goggles" }), t0);
        near(evTime - t0, BEAT_EVENT_SEC[name] / s + slack, tol, `${name} event (quick ${quick}, clipEvents ${clipEvents})`);
        const next = k + 1 < beats.length ? tEnter(beats[k + 1]) : d.timeOf(is("attach", { prop: "tablet" }), t0);
        near(next - t0, BEAT_SEC[name] / s + slack, tol, `${name} end`);
      }
      // tabletUp is a timer beat at speed 1 even in a quick deploy (22/30 + slack).
      const tUp = d.timeOf(is("attach", { prop: "tablet" }));
      const tLift = d.timeOf(is("autopilot", { plan: "liftoff" }));
      near(tLift - tUp, BEAT_SEC.tabletUp + 0.05, tol, "tabletUp");
      assert.deepEqual(d.stream.find((e) => e.a.some(is("autopilot", { plan: "liftoff" }))).a, [A.auto("liftoff", s)]);
    }
  }
});

check("Q3 quick deploy: no pack; the drone appears in the hand at the place entry; clips at 1.5; motions at speed 1", () => {
  const d = new Driver({ dt: 1 / 240 });
  d.req("deploy", { quick: true });
  d.until((s) => s.state === "flying");
  const got = d.stream.map((e) => e.a);
  assert.deepEqual(got, [
    [A.state("deploying", "idle"), A.inputLock(), A.phase("deploy"), A.hide(true)],
    [A.attach("drone", "rightHand"), A.clip("place", 1.5)],
    [A.detach("drone", "world")],
    [A.clip("goggles", 1.5)],
    [A.attach("goggles", "head")],
    [A.attach("tablet", "leftHand"), A.readState(), A.broadcast(), A.rotors(1, 22 / 30), A.audio(1, 22 / 30)],
    [A.auto("liftoff", 1.5)],
    [A.osd("boot", 0.35 / 1.5)],
    [A.own(), A.phase("fly")],
    [A.osd("fpv")],
    [A.state("flying", "deploying"), A.auto(null)],
  ]);
});

// ---------------------------------------------------------------------------
// Q4 lift-off sub-events and T8
// ---------------------------------------------------------------------------

check("Q4 lift-off sub-events: boot / own / fpv once each at cut*Sec ÷ speed; T8 at 2.2 ÷ speed", () => {
  const D = SEQUENCE_DEFAULTS;
  const dt = 1 / 1000;
  for (const quick of [false, true]) {
    const s = quick ? 1.5 : 1;
    const d = new Driver({ dt, rig: "no-hands" });
    d.req("deploy", { quick });
    d.until((st) => st.state === "flying");
    const t0 = d.timeOf(is("autopilot", { plan: "liftoff" }));
    const tb = d.timeOf(is("osd", { mode: "boot" }));
    const to = d.timeOf(is("cameraOwn"));
    const tf = d.timeOf(is("osd", { mode: "fpv" }));
    const t8 = d.timeOf(is("state", { state: "flying" }));
    near(tb - t0, D.cutStartSec / s, dt + 1e-9, "boot");
    near(to - t0, D.cutBlackSec / s, dt + 1e-9, "own");
    near(tf - t0, D.cutEndSec / s, dt + 1e-9, "fpv");
    near(t8 - t0, BEAT_SEC.liftoff / s, dt + 1e-9, "T8 by time");
    for (const m of [is("osd", { mode: "boot" }), is("cameraOwn"), is("osd", { mode: "fpv" }), is("state", { state: "flying" })]) {
      assert.equal(d.stream.filter((e) => e.a.some(m)).length, 1, "each sub-event fires once");
    }
    const boot = d.stream.find((e) => e.a.some(is("osd", { mode: "boot" }))).a;
    assert.deepEqual(boot, [A.osd("boot", 0.35 / s)]);
  }
});

check("Q4 T8 by autopilotDone and by anyInput — never before the own; a pending osd(fpv) is completed by T8", () => {
  // autopilotDone right after the own (before cutEnd): T8 folds the pending osd(fpv) in.
  const d = new Driver({ rig: "no-hands", dt: 1 / 600 });
  d.req("deploy");
  d.until((s) => s.cutFired.own);
  d.craft.autopilotDone = true;
  assert.deepEqual(d.frame(), [A.state("flying", "deploying"), A.osd("fpv"), A.auto(null)]);
  // anyInput from the start of the lift-off: no T8 until the own, then the next frame.
  const e = new Driver({ rig: "no-hands", dt: 1 / 600 });
  e.req("deploy");
  e.until((s) => s.beat === "liftoff");
  e.sticks = { sticksActive: false, anyInput: true };
  e.craft.autopilotDone = true;
  const a = e.until((s) => s.cutFired.own);
  assert.deepEqual(a, [A.own(), A.phase("fly")]);
  assert.equal(e.st().state, "deploying", "nothing before the own");
  assert.deepEqual(e.frame(), [A.state("flying", "deploying"), A.osd("fpv"), A.auto(null)]);
  // anyInput after cutEnd: plain T8.
  const f = new Driver({ rig: "no-hands", dt: 1 / 600 });
  f.req("deploy");
  f.until((s) => s.cutFired.fpv);
  f.sticks = { sticksActive: true, anyInput: true };
  assert.deepEqual(f.frame(), [A.state("flying", "deploying"), A.auto(null)]);
});

// ---------------------------------------------------------------------------
// Q5 the totals table
// ---------------------------------------------------------------------------

check("Q5 SPEC §4.4 totals from the end of the prep (clip beats end on beatDone; each timer beat adds 0.05 s)", () => {
  const dt = 1 / 600;
  const rows = [
    { rig: "humanoid", quick: false, gestures: 5.233, boot: 6.158, own: 6.333, control: 7.433 },
    { rig: "humanoid", quick: true, gestures: 2.778, boot: 3.394, own: 3.511, control: 4.244 },
    { rig: "no-hands", quick: false, gestures: 0.733, boot: 1.658, own: 1.833, control: 2.933 },
    { rig: "no-hands", quick: true, gestures: 0.733, boot: 1.350, own: 1.467, control: 2.200 },
  ];
  for (const r of rows) {
    const d = new Driver({ rig: r.rig, dt });
    d.req("deploy", { quick: r.quick });
    d.until((s) => s.state === "flying");
    const tPrep = d.stream[1].t; // the prep end (first beat entry)
    const slack = 0.05; // tabletUp / spawn are timer beats
    const tol = 6 * dt + 0.0006;
    near(d.timeOf(is("autopilot", { plan: "liftoff" })) - tPrep - slack, r.gestures, tol, `${r.rig} quick=${r.quick} gestures`);
    near(d.timeOf(is("osd", { mode: "boot" })) - tPrep - slack, r.boot, tol, "boot wipe");
    near(d.timeOf(is("cameraOwn")) - tPrep - slack, r.own, tol, "cameraOwn");
    near(d.timeOf(is("state", { state: "flying" })) - tPrep - slack, r.control, tol, "control by time");
  }
  // Stow from touchdown: full 5.233 s, quick 2.778 s (+ the tabletDown timer slack).
  for (const [quick, total] of [[false, 5.233], [true, 2.778]]) {
    const d = toFlying({ quick, dt });
    d.req("recallInstant");
    d.craft = { distTouchdownM: 2 };
    d.frame();
    d.craft = { landed: true, distTouchdownM: 0, distHomeM: 0 };
    d.frame();
    const tTouch = d.t;
    d.craft = {};
    d.until((s) => s.state === "idle");
    near(d.t - tTouch - 0.05, total, 5 * dt + 0.0006, `stow quick=${quick}`);
  }
});

// ---------------------------------------------------------------------------
// Q6 skip
// ---------------------------------------------------------------------------

check("Q6 skip from the prep: pendingSkip, then the prep ends into the skip list (humanoid and no-hands)", () => {
  const d = new Driver({ readyAt: 0.3 });
  d.req("deploy");
  assert.equal(d.req("skip"), NO_ACTIONS);
  const a = d.until((s) => s.beat !== "prep");
  assert.deepEqual(a, [A.attach("goggles", "head"), A.attach("tablet", "leftHand"), A.place(), A.readState(), A.broadcast(),
    A.rotors(1, 0.3), A.audio(1, 0.3), A.auto("liftoff", 1)]);
  assert.equal(d.st().beat, "liftoff");
  assert.equal(d.st().beatElapsed, 0);
  assert.equal(d.st().pendingSkip, false);
  const n = new Driver({ rig: "no-hands" });
  n.req("deploy", { quick: true });
  n.req("skip");
  assert.deepEqual(n.frame(), [A.place(), A.rotors(1, 0.3), A.audio(1, 0.3), A.auto("liftoff", 1.5)]);
});

check("Q6 skip from every beat: stopClip only while a clip runs, place only off the ground, ReadState only when not held", () => {
  const SKIP_TAIL = [A.rotors(1, 0.3), A.audio(1, 0.3), A.auto("liftoff", 1)];
  const props = [A.attach("goggles", "head"), A.attach("tablet", "leftHand")];
  const cases = [
    { name: "pack before its event", reach: (s) => s.beat === "pack", expect: [A.stopClip(), ...props, A.place(), A.readState(), A.broadcast(), ...SKIP_TAIL] },
    { name: "pack after its event (drone in the hand)", reach: (s) => s.beat === "pack" && s.drone === "hand", expect: [A.stopClip(), ...props, A.place(), A.readState(), A.broadcast(), ...SKIP_TAIL] },
    { name: "place before its event (drone in the hand)", reach: (s) => s.beat === "place" && s.drone === "hand", expect: [A.stopClip(), ...props, A.place(), A.readState(), A.broadcast(), ...SKIP_TAIL] },
    { name: "place after its event (drone on the ground)", reach: (s) => s.beat === "place" && s.drone === "ground", expect: [A.stopClip(), ...props, A.readState(), A.broadcast(), ...SKIP_TAIL] },
    { name: "goggles", reach: (s) => s.beat === "goggles", expect: [A.stopClip(), ...props, A.readState(), A.broadcast(), ...SKIP_TAIL] },
    { name: "tabletUp (held)", reach: (s) => s.beat === "tabletUp", expect: [...props, ...SKIP_TAIL] },
  ];
  for (const c of cases) {
    const d = new Driver();
    d.req("deploy");
    d.until(c.reach);
    assert.deepEqual(d.req("skip"), c.expect, c.name);
    const s = d.st();
    assert.equal(s.beat, "liftoff");
    assert.equal(s.drone, "air");
    assert.equal(s.clipActive, false);
    assert.equal(s.held, true);
    assert.equal(s.tablet && s.goggles, true);
  }
  const n = new Driver({ rig: "no-hands" });
  n.req("deploy");
  n.until((s) => s.beat === "spawn");
  assert.deepEqual(n.req("skip"), SKIP_TAIL, "spawn: the drone is already on the ground");
});

check("Q6 skip in the lift-off: before the own the cut starts now (beatElapsed raised to cutStart); after the own → T8", () => {
  const D = SEQUENCE_DEFAULTS;
  const d = new Driver({ rig: "no-hands", dt: 1 / 600 });
  d.req("deploy");
  d.until((s) => s.beat === "liftoff");
  d.frame();
  assert.equal(d.req("skip"), NO_ACTIONS);
  near(d.st().beatElapsed, D.cutStartSec, 1e-12);
  assert.deepEqual(d.frame(), [A.osd("boot", 0.35)], "the boot wipe on the next frame");
  const tSkip = d.t;
  d.until((s) => s.cutFired.own);
  near(d.t - tSkip, D.cutBlackSec - D.cutStartSec, 2 / 600, "own 0.175 s later");
  // Between boot and own: no change.
  const b = new Driver({ rig: "no-hands", dt: 1 / 600 });
  b.req("deploy");
  b.until((s) => s.cutFired.boot);
  const e0 = b.st().beatElapsed;
  assert.equal(b.req("skip"), NO_ACTIONS);
  assert.equal(b.st().beatElapsed, e0);
  // After the own, before cutEnd: T8 now with the pending osd(fpv).
  const c = new Driver({ rig: "no-hands", dt: 1 / 600 });
  c.req("deploy");
  c.until((s) => s.cutFired.own);
  assert.deepEqual(c.req("skip"), [A.state("flying", "deploying"), A.osd("fpv"), A.auto(null)]);
  // After cutEnd: plain T8.
  const e = new Driver({ rig: "no-hands", dt: 1 / 600 });
  e.req("deploy");
  e.until((s) => s.cutFired.fpv);
  assert.deepEqual(e.req("skip"), [A.state("flying", "deploying"), A.auto(null)]);
  // skip outside deploying is ignored.
  assert.equal(e.req("skip"), NO_ACTIONS);
});

// ---------------------------------------------------------------------------
// Q7 pilot view, recall, RTH cancel, landing
// ---------------------------------------------------------------------------

check("Q7 pilot view both ways (T10 / T11)", () => {
  const d = toFlying();
  assert.deepEqual(d.req("pilotView"), [A.state("pilotView", "flying"), A.auto("hold"), A.release(true), A.phase("pilot"), A.osd("pilot")]);
  assert.equal(d.st().fpv, false);
  assert.deepEqual(d.req("pilotView"), [A.state("flying", "pilotView"), A.own(), A.phase("fly"), A.osd("fpv"), A.auto(null)]);
  assert.equal(d.st().fpv, true);
});

check("Q7 recall (T12), recallInstant from flying (T13), from pilotView (T14), in returning (T15)", () => {
  const a = toFlying();
  assert.deepEqual(a.req("recall"), [A.state("returning", "flying"), A.auto("rth")]);
  assert.deepEqual(a.st().rth, { reason: "user", fpv: true, cancellable: true, armed: false });
  // An ignored request tick still runs the state's own rules (guards run every tick): no stick → armed.
  assert.equal(a.req("recall"), NO_ACTIONS, "recall in returning is ignored");
  assert.equal(a.st().rth.armed, true);
  assert.deepEqual(a.req("recallInstant"), [A.release(false), A.phase("stow"), A.osd("off")], "T15");
  assert.equal(a.st().state, "returning");
  assert.deepEqual(a.st().rth, { reason: "user", fpv: false, cancellable: false, armed: true });
  assert.equal(a.req("recallInstant"), NO_ACTIONS, "third person already: ignored");
  const b = toFlying();
  assert.deepEqual(b.req("recallInstant"), [A.state("returning", "flying"), A.release(false), A.phase("stow"), A.osd("off"), A.auto("rth")]);
  assert.deepEqual(b.st().rth, { reason: "user", fpv: false, cancellable: false, armed: false });
  for (const r of ["recall", "recallInstant"]) {
    const c = toFlying();
    c.req("pilotView");
    assert.deepEqual(c.req(r), [A.state("returning", "pilotView"), A.phase("stow"), A.osd("off"), A.auto("rth")], `T14 ${r}`);
    assert.equal(c.st().fpv, false);
    assert.equal(c.st().rth.cancellable, false);
  }
});

check("Q7 T16: only a FRESH stick input cancels a cancellable RTH (held through the recall → no; look / gimbal → never)", () => {
  // A stick held through the recall never cancels; released, then pressed → cancel.
  const d = toFlying();
  d.sticks = { sticksActive: true, anyInput: true };
  d.req("recall");
  for (let k = 0; k < 30; k += 1) assert.equal(d.frame(), NO_ACTIONS, "held stick: no cancel");
  assert.equal(d.st().rth.armed, false);
  d.sticks = { sticksActive: false, anyInput: false };
  assert.equal(d.frame(), NO_ACTIONS);
  assert.equal(d.st().rth.armed, true, "armed on the first released tick (no action)");
  d.sticks = { sticksActive: true, anyInput: true };
  assert.deepEqual(d.frame(), [A.state("flying", "returning"), A.auto(null)]);
  assert.equal(d.st().rth, null);
  // Look / gimbal input (anyInput without sticksActive) never cancels.
  const e = toFlying();
  e.req("recall");
  e.sticks = { sticksActive: false, anyInput: true };
  for (let k = 0; k < 60; k += 1) assert.equal(e.frame(), NO_ACTIONS);
  assert.equal(e.st().state, "returning");
  // Not cancellable (third person) → sticks do nothing.
  const f = toFlying();
  f.req("recallInstant");
  f.frame();
  f.sticks = { sticksActive: true, anyInput: true };
  for (let k = 0; k < 10; k += 1) assert.equal(f.frame(), NO_ACTIONS);
});

check("Q7 T17 (≤ 5 m before touchdown), T20 (forced landing in the goggles), T21 full / noDrone, T21 with fpv in one tick", () => {
  const a = toFlying();
  a.req("recall");
  a.craft = { distTouchdownM: 5.01 };
  assert.equal(a.frame(), NO_ACTIONS);
  a.craft = { distTouchdownM: null };
  assert.equal(a.frame(), NO_ACTIONS);
  a.craft = { distTouchdownM: 5 };
  assert.deepEqual(a.frame(), [A.state("landing", "returning"), A.release(false), A.phase("stow"), A.osd("off")]);
  a.craft = { landed: true, distTouchdownM: 0, distHomeM: 1.5 };
  assert.deepEqual(a.frame(), [A.state("stowing", "landing"), A.rotors(0, 0.6), A.audio(0, 0.6), A.ready()], "T21 full at home");
  assert.equal(a.st().stowKind, "full");
  assert.equal(a.st().drone, "ground");
  assert.equal(a.st().beat, "tabletDown");
  const b = toFlying();
  b.req("recallInstant");
  b.craft = { distTouchdownM: 4.9 };
  assert.deepEqual(b.frame(), [A.state("landing", "returning")], "third person: no release");
  b.craft = { landed: true, distHomeM: 1.6 };
  assert.deepEqual(b.frame(), [A.state("stowing", "landing"), A.rotors(0, 0.6), A.audio(0, 0.6), A.fade(), A.ready()], "T21 noDrone (away from home)");
  assert.equal(b.st().stowKind, "noDrone");
  assert.equal(b.st().drone, "fading");
  // Forced landing in the goggles: T20 at ≤ 5 m.
  const c = toFlying();
  c.battery = { empty: true };
  c.frame();
  c.battery = {};
  c.craft = { distTouchdownM: 6 };
  assert.equal(c.frame(), NO_ACTIONS);
  c.craft = { distTouchdownM: 5 };
  assert.deepEqual(c.frame(), [A.release(false), A.phase("stow"), A.osd("off")], "T20");
  assert.equal(c.st().fpv, false);
  // landed and ≤ 5 m first seen in the same tick (fpv): T21 carries T20's release before the stow.
  const e = toFlying();
  e.battery = { empty: true };
  e.frame();
  e.battery = {};
  e.craft = { landed: true, distTouchdownM: 0, distHomeM: 0 };
  assert.deepEqual(e.frame(), [A.state("stowing", "landing"), A.release(false), A.phase("stow"), A.osd("off"),
    A.rotors(0, 0.6), A.audio(0, 0.6), A.fade(), A.ready()], "forced landing → noDrone even at home");
});

// ---------------------------------------------------------------------------
// Q8 stows
// ---------------------------------------------------------------------------

/** Land a flying driver at home (third person) and return the T21 actions. */
function landAtHome(d, distHomeM = 0) {
  d.req("recallInstant");
  d.craft = { distTouchdownM: 1 };
  d.frame();
  d.craft = { landed: true, distTouchdownM: 0, distHomeM };
  const a = d.frame();
  d.craft = {};
  return a;
}

check("Q8 full stow (T24 → T25): tabletDown, gogglesOff, pickUp, packAway, then idle; quick: no packAway", () => {
  const d = toFlying({ dt: 1 / 240 });
  landAtHome(d);
  const from = d.stream.length - 1;
  d.until((s) => s.state === "idle");
  assert.deepEqual(d.stream.slice(from).map((e) => e.a), [
    [A.state("stowing", "landing"), A.rotors(0, 0.6), A.audio(0, 0.6), A.ready()],
    [A.detach("tablet", "remove"), A.clip("goggles", 1)],
    [A.detach("goggles", "remove")],
    [A.clip("place", 1)],
    [A.attach("drone", "rightHand")],
    [A.clip("pack", 1)],
    [A.detach("drone", "remove")],
    [A.state("idle", "stowing"), A.hide(false), A.inputRestore()],
  ]);
  const s = d.st();
  assert.equal(s.state, "idle");
  assert.equal(s.locked, false);
  assert.equal(s.drone, "none");
  assert.equal(s.beat, null);
  const q = toFlying({ quick: true, dt: 1 / 240 });
  landAtHome(q);
  const f2 = q.stream.length - 1;
  q.until((s2) => s2.state === "idle");
  assert.deepEqual(q.stream.slice(f2).map((e) => e.a), [
    [A.state("stowing", "landing"), A.rotors(0, 0.6), A.audio(0, 0.6), A.ready()],
    [A.detach("tablet", "remove"), A.clip("goggles", 1.5)],
    [A.detach("goggles", "remove")],
    [A.clip("place", 1.5)],
    [A.attach("drone", "rightHand")],
    [A.detach("drone", "remove"), A.state("idle", "stowing"), A.hide(false), A.inputRestore()],
  ]);
});

check("Q8 stow beats on the timer path: tabletDown 22/30, gogglesOff / pickUp / packAway at their clip times + slack", () => {
  const dt = 1 / 600;
  for (const quick of [false, true]) {
    const s = quick ? 1.5 : 1;
    const d = toFlying({ quick, dt, clipEvents: false });
    landAtHome(d);
    const t0 = d.t;
    d.until((st) => st.state === "idle");
    const tTab = d.timeOf(is("detach", { prop: "tablet" }), t0 - 1e-9);
    near(tTab - t0, BEAT_SEC.tabletDown + 0.05, dt + 1e-9, "tabletDown");
    const tGogEv = d.timeOf(is("detach", { prop: "goggles" }), t0);
    near(tGogEv - tTab, BEAT_EVENT_SEC.goggles / s + 0.05, dt + 1e-9, "gogglesOff event");
    const tPick = d.timeOf(is("clip", { name: "place" }), t0);
    near(tPick - tTab, BEAT_SEC.goggles / s + 0.05, dt + 1e-9, "gogglesOff end");
    const tPickEv = d.timeOf(is("attach", { prop: "drone" }), t0);
    near(tPickEv - tPick, BEAT_EVENT_SEC.place / s + 0.05, dt + 1e-9, "pickUp event");
    if (!quick) {
      const tPack = d.timeOf(is("clip", { name: "pack" }), t0);
      near(tPack - tPick, BEAT_SEC.place / s + 0.05, dt + 1e-9, "pickUp end");
      const tRem = d.timeOf(is("detach", { prop: "drone", to: "remove" }), t0);
      near(tRem - tPack, BEAT_EVENT_SEC.pack / s + 0.05, dt + 1e-9, "packAway event");
      near(d.t - tPack, BEAT_SEC.pack / s + 0.05, dt + 1e-9, "packAway end");
    } else {
      near(d.t - tPick, BEAT_SEC.place / s + 0.05, dt + 1e-9, "quick pickUp end");
    }
  }
});

check("Q8 no-hands stows: full → powerDown 0.6 s → finish; noDrone → T26 + settle → T27 when gone", () => {
  const d = toFlying({ rig: "no-hands", dt: 1 / 600 });
  assert.deepEqual(landAtHome(d), [A.state("stowing", "landing"), A.rotors(0, 0.6), A.audio(0, 0.6)]);
  assert.equal(d.st().beat, "powerDown");
  assert.equal(d.st().beatIndex, 1);
  const t0 = d.t;
  const a = d.until((s) => s.state === "idle");
  assert.deepEqual(a, [A.detach("drone", "remove"), A.state("idle", "stowing"), A.hide(false), A.inputRestore()]);
  near(d.t - t0, 0.6 + 0.05, 1 / 600 + 1e-9);
  const n = toFlying({ rig: "no-hands" });
  assert.deepEqual(landAtHome(n, 3), [A.state("stowing", "landing"), A.rotors(0, 0.6), A.audio(0, 0.6), A.fade(), A.hide(false), A.inputRestore()]);
  assert.equal(n.st().beat, "settle");
  assert.equal(n.st().locked, false);
  for (let k = 0; k < 30; k += 1) assert.equal(n.frame(), NO_ACTIONS);
  n.craft = { gone: true };
  assert.deepEqual(n.frame(), [A.state("idle", "stowing")], "T27");
});

check("Q8 humanoid noDrone stow: tabletDown, gogglesOff, then T26 (hideWielded(false), inputRestore) + settle until gone", () => {
  const d = toFlying({ dt: 1 / 240 });
  landAtHome(d, 4);
  const from = d.stream.length - 1;
  d.until((s) => s.beat === "settle");
  assert.deepEqual(d.stream.slice(from).map((e) => e.a), [
    [A.state("stowing", "landing"), A.rotors(0, 0.6), A.audio(0, 0.6), A.fade(), A.ready()],
    [A.detach("tablet", "remove"), A.clip("goggles", 1)],
    [A.detach("goggles", "remove")],
    [A.hide(false), A.inputRestore()],
  ]);
  assert.equal(d.st().state, "stowing");
  assert.equal(d.st().locked, false);
  d.craft = { gone: true };
  assert.deepEqual(d.frame(), [A.state("idle", "stowing")]);
});

// ---------------------------------------------------------------------------
// Q9 battery, crash, T28, T29
// ---------------------------------------------------------------------------

check("Q9 battery RTH once (T18) from flying and pilotView; empty → forced landing (T19) from flying / pilotView / returning", () => {
  const a = toFlying();
  a.battery = { rth: true, warn: true };
  assert.deepEqual(a.frame(), [A.state("returning", "flying"), A.auto("rth")]);
  assert.deepEqual(a.st().rth, { reason: "battery", fpv: true, cancellable: true, armed: false });
  assert.equal(a.st().batteryRthUsed, true);
  a.battery = { warn: true };
  a.frame();
  a.sticks = { sticksActive: true, anyInput: true };
  a.frame(); // cancel (armed by the released frame before)
  assert.equal(a.st().state, "flying");
  a.sticks = {};
  a.battery = { rth: true, warn: true };
  assert.equal(a.frame(), NO_ACTIONS, "the battery RTH fires once per cycle");
  a.battery = { empty: true, rth: true };
  assert.deepEqual(a.frame(), [A.state("landing", "flying"), A.auto("landHere")], "empty wins over rth");
  assert.equal(a.st().forcedLanding, true);
  const b = toFlying();
  b.req("pilotView");
  b.battery = { rth: true };
  assert.deepEqual(b.frame(), [A.state("returning", "pilotView"), A.auto("rth"), A.phase("stow"), A.osd("off")]);
  assert.deepEqual(b.st().rth, { reason: "battery", fpv: false, cancellable: false, armed: false });
  b.battery = { empty: true };
  assert.deepEqual(b.frame(), [A.state("landing", "returning"), A.auto("landHere")], "T19 from returning");
  const c = toFlying();
  c.req("pilotView");
  c.battery = { empty: true };
  assert.deepEqual(c.frame(), [A.state("landing", "pilotView"), A.auto("landHere"), A.phase("stow"), A.osd("off")], "T19 from pilotView");
  // Battery edges outside flying / pilotView / returning do nothing.
  const e = new Driver();
  e.req("deploy");
  e.battery = { rth: true, empty: true };
  e.until((s) => s.beat === "liftoff");
  assert.equal(e.st().state, "deploying");
});

check("Q9 crash (T22) from flying / pilotView / returning / landing / the lift-off; T23 after 1 s; settle until gone", () => {
  const crashFrom = (prep) => {
    const d = prep();
    const prev = d.st().state;
    const fpv = d.st().fpv;
    d.craft = { impactSpeed: 7.5 };
    const a = d.frame();
    d.craft = {};
    assert.deepEqual(a, [A.state("crashed", prev), A.auto("crash"), A.rotors(0, 0.2), A.audio(0, 0.3), A.osd(fpv ? "crash" : "off"), A.fade()], `T22 from ${prev}`);
    assert.equal(d.st().drone, "fading");
    assert.equal(d.st().beat, "static");
    return d;
  };
  const f = crashFrom(() => toFlying({ dt: 1 / 600 }));
  const t0 = f.t;
  const t23 = f.until((s) => s.state === "stowing");
  near(f.t - t0, 1.0, 1 / 600 + 1e-9, "1 s of static");
  assert.deepEqual(t23, [A.state("stowing", "crashed"), A.release(false), A.phase("stow"), A.osd("off"), A.ready()]);
  assert.equal(f.st().stowKind, "noDrone");
  f.until((s) => s.beat === "settle");
  assert.equal(f.st().locked, false);
  f.craft = { gone: true };
  assert.deepEqual(f.frame(), [A.state("idle", "stowing")]);
  const p = crashFrom(() => {
    const d = toFlying();
    d.req("pilotView");
    return d;
  });
  assert.deepEqual(p.until((s) => s.state === "stowing"), [A.state("stowing", "crashed"), A.phase("stow"), A.osd("off"), A.ready()], "T23 after a pilot-view crash");
  crashFrom(() => {
    const d = toFlying();
    d.req("recall");
    return d;
  });
  crashFrom(() => {
    const d = toFlying();
    d.req("recallInstant");
    d.craft = { distTouchdownM: 3 };
    d.frame();
    return d;
  });
  const l = crashFrom(() => {
    const d = new Driver();
    d.req("deploy");
    d.until((s) => s.beat === "liftoff");
    return d;
  });
  assert.equal(l.st().rig, "humanoid");
  // No-hands crash → T23 goes straight to T26 + settle.
  const n = crashFrom(() => toFlying({ rig: "no-hands" }));
  assert.deepEqual(n.until((s) => s.state === "stowing"), [A.state("stowing", "crashed"), A.release(false), A.phase("stow"), A.osd("off"), A.hide(false), A.inputRestore()]);
  // Not a crash: impact == crashMps, crashes off, the drone on the ground in the deploy.
  const g = toFlying();
  g.craft = { impactSpeed: 7 };
  assert.equal(g.frame(), NO_ACTIONS, "strictly greater than crashMps");
  g.crashMps = 0;
  g.craft = { impactSpeed: 99 };
  assert.equal(g.frame(), NO_ACTIONS, "crashMps 0 = crashes off");
  const t = new Driver();
  t.req("deploy");
  t.until((s) => s.beat === "tabletUp");
  t.craft = { impactSpeed: 99 };
  assert.ok(!t.frame().some(is("state", { state: "crashed" })), "no crash while the drone sits on the ground in the deploy");
});

check("Q9 T28 (soft abort in the air: rotors stop at touchdown, once) and T29 (settle timeout without craft.gone)", () => {
  const d = toFlying({ dt: 1 / 60 });
  d.signals = { damage: true };
  d.frame();
  d.signals = {};
  assert.equal(d.st().state, "aborting");
  assert.equal(d.st().drone, "air");
  d.craft = { landed: true };
  assert.deepEqual(d.frame(), [A.rotors(0, 0.6)]);
  assert.equal(d.st().drone, "ground");
  assert.equal(d.frame(), NO_ACTIONS, "once");
  d.craft = { gone: true };
  assert.deepEqual(d.frame(), [A.state("idle", "aborting")], "T27 from aborting");
  // T29: neither gone nor landed for 8 s.
  const e = toFlying({ dt: 1 / 60 });
  e.signals = { damage: true };
  e.frame();
  e.signals = {};
  const t0 = e.t;
  const a = e.until((s) => s.state === "idle", 10);
  assert.deepEqual(a, [A.state("idle", "aborting"), A.detach("drone", "remove")]);
  near(e.t - t0, 8, 1 / 60 + 1e-9);
  const n = toFlying({ rig: "no-hands", dt: 1 / 60 });
  landAtHome(n, 9);
  const t1 = n.t;
  assert.deepEqual(n.until((s) => s.state === "idle", 10), [A.state("idle", "stowing"), A.detach("drone", "remove")]);
  near(n.t - t1, 8, 1 / 60 + 1e-9, "T29 from the noDrone settle");
});

// ---------------------------------------------------------------------------
// Q10 the abort matrix
// ---------------------------------------------------------------------------

/** The SPEC §4.6 oracle: expected actions (null = ignored) for an abort by reason from a state snapshot. */
function oracle(st, reason, viaRequest) {
  const hard = HARD_ABORT_REASONS.includes(reason);
  if (st.state === "idle") return null;
  if (!viaRequest && !st.locked && ["pilotMoved", "death", "damage", "combat"].includes(reason)) return null;
  const settle = st.state === "aborting" || (st.state === "stowing" && st.beat === "settle");
  if (settle) return hard || viaRequest ? [A.state("idle", st.state), A.detach("drone", "remove")] : null;
  const kind = st.state === "stowing" ? (!hard && st.drone === "fading" ? "soft" : "hard") : hard ? "hard" : "soft";
  const out = [];
  if (kind === "soft") {
    const direct = st.drone === "none" || st.drone === "hand";
    out.push(A.state(direct ? "idle" : "aborting", st.state));
    if (st.clipActive) out.push(A.stopClip());
    if (st.fpv) out.push(A.release(false));
    out.push(A.osd("off"));
    if (st.locked) out.push(A.inputRestore());
    if (st.held && reason !== "death" && reason !== "combat") out.push(A.ready());
    if (st.tablet) out.push(A.detach("tablet", "remove"));
    if (st.goggles) out.push(A.detach("goggles", "remove"));
    if (st.wieldedHidden) out.push(A.hide(false));
    out.push(A.audio(0, 0.3));
    if (st.drone === "hand") out.push(A.detach("drone", "remove"));
    else if (st.drone === "ground") out.push(A.rotors(0, 0.6), A.fade());
    else if (st.drone === "air") out.push(A.auto("landHere"), A.fade());
    return out;
  }
  out.push(A.state("idle", st.state));
  if (st.clipActive) out.push(A.stopClip());
  if (st.fpv) out.push(A.release(false));
  out.push(A.osd("off"));
  if (st.locked) out.push(A.inputRestore());
  if (st.held && reason !== "death") out.push(A.ready());
  out.push(A.detach("tablet", "remove"), A.detach("goggles", "remove"));
  if (st.wieldedHidden) out.push(A.hide(false));
  out.push(A.audio(0, 0), A.rotors(0, 0), A.auto(null));
  if (st.drone !== "none") out.push(A.detach("drone", "remove"));
  return out;
}

/** Scenario builders: every state (and sub-state) an abort can meet. */
const SCENARIOS = {
  idle: () => new Driver(),
  "deploying/prep": () => {
    const d = new Driver({ readyAt: Infinity, rigKnown: null });
    d.req("deploy");
    return d;
  },
  "deploying/pack (drone none)": () => {
    const d = new Driver();
    d.req("deploy");
    d.frame();
    return d;
  },
  "deploying/pack (drone in hand)": () => {
    const d = new Driver();
    d.req("deploy");
    d.until((s) => s.drone === "hand");
    return d;
  },
  "deploying/place (drone on the ground)": () => {
    const d = new Driver();
    d.req("deploy");
    d.until((s) => s.beat === "place" && s.drone === "ground");
    return d;
  },
  "deploying/goggles (goggles on)": () => {
    const d = new Driver();
    d.req("deploy");
    d.until((s) => s.goggles);
    return d;
  },
  "deploying/tabletUp": () => {
    const d = new Driver();
    d.req("deploy");
    d.until((s) => s.beat === "tabletUp");
    return d;
  },
  "deploying/spawn (no-hands)": () => {
    const d = new Driver({ rig: "no-hands" });
    d.req("deploy");
    d.until((s) => s.beat === "spawn");
    return d;
  },
  "deploying/liftoff (before the own)": () => {
    const d = new Driver();
    d.req("deploy");
    d.until((s) => s.beat === "liftoff");
    return d;
  },
  "deploying/liftoff (owned)": () => {
    const d = new Driver();
    d.req("deploy");
    d.until((s) => s.cutFired.own);
    return d;
  },
  flying: () => toFlying(),
  "flying (no-hands)": () => toFlying({ rig: "no-hands" }),
  pilotView: () => {
    const d = toFlying();
    d.req("pilotView");
    return d;
  },
  "returning (fpv)": () => {
    const d = toFlying();
    d.req("recall");
    d.frame();
    return d;
  },
  "returning (third)": () => {
    const d = toFlying();
    d.req("recallInstant");
    return d;
  },
  "landing (fpv, forced)": () => {
    const d = toFlying();
    d.battery = { empty: true };
    d.frame();
    d.battery = {};
    return d;
  },
  "landing (third)": () => {
    const d = toFlying();
    d.req("recallInstant");
    d.craft = { distTouchdownM: 3 };
    d.frame();
    d.craft = {};
    return d;
  },
  crashed: () => {
    const d = toFlying();
    d.craft = { impactSpeed: 20 };
    d.frame();
    d.craft = {};
    return d;
  },
  "stowing (full, tabletDown)": () => {
    const d = toFlying();
    landAtHome(d);
    return d;
  },
  "stowing (full, pickUp: drone in hand)": () => {
    const d = toFlying();
    landAtHome(d);
    d.until((s) => s.beat === "pickUp" && s.drone === "hand");
    return d;
  },
  "stowing (noDrone, locked, fading)": () => {
    const d = toFlying();
    landAtHome(d, 3);
    return d;
  },
  "stowing/settle (unlocked)": () => {
    const d = toFlying();
    landAtHome(d, 3);
    d.until((s) => s.beat === "settle");
    return d;
  },
  "aborting (air)": () => {
    const d = toFlying();
    d.signals = { damage: true };
    d.frame();
    d.signals = {};
    return d;
  },
  "aborting (ground → fading)": () => {
    const d = new Driver();
    d.req("deploy");
    d.until((s) => s.beat === "tabletUp");
    d.signals = { damage: true };
    d.frame();
    d.signals = {};
    return d;
  },
};

/** Signal name → [signals patch, reason]. */
const SIGNALS = {
  damage: [{ damage: true }, "damage"],
  death: [{ death: true }, "death"],
  portal: [{ portal: true }, "portal"],
  combat: [{ stanceCombat: true }, "combat"],
  pilotMoved: [{ pilotMovedM: 2.5 }, "pilotMoved"],
  session: [{ sessionChanged: true }, "session"],
  film: [{ filmBusy: true }, "film"],
  contextLost: [{ contextLost: true }, "contextLost"],
};

check("Q10 every abort signal from every state matches the SPEC §4.6 oracle (soft / hard lists, unlocked ignores)", () => {
  let cases = 0;
  for (const [sname, build] of Object.entries(SCENARIOS)) {
    for (const [sig, [patch, reason]] of Object.entries(SIGNALS)) {
      const d = build();
      const st = d.st();
      d.signals = patch;
      const a = d.frame();
      const want = oracle(st, reason, false);
      if (want === null) {
        assert.equal(a, NO_ACTIONS, `${sname} × ${sig}: ignored (got ${JSON.stringify(a)})`);
        assert.equal(d.st().state, st.state, `${sname} × ${sig}: state kept`);
        assert.deepEqual(d.st().lastAbort, st.lastAbort, `${sname} × ${sig}: no abort recorded`);
      } else {
        assert.deepEqual(a, want, `${sname} × ${sig}`);
        const after = d.st();
        assert.equal(after.state, want[0].state, `${sname} × ${sig}: lands in ${want[0].state}`);
        assert.deepEqual(after.lastAbort, { reason, from: st.state, at: d.t }, `${sname} × ${sig}: lastAbort`);
        if (after.state === "aborting") {
          assert.equal(after.beat, "settle");
          assert.equal(after.locked, false);
          assert.equal(after.fpv, false);
        }
        if (after.state === "idle") assert.equal(after.drone, "none");
      }
      cases += 1;
    }
  }
  assert.equal(cases, Object.keys(SCENARIOS).length * Object.keys(SIGNALS).length);
  assert.ok(Object.keys(SCENARIOS).length >= 24, "every state and sub-state an abort can meet");
});

check("Q10 abort requests from every state (user → soft, dispose / rigLost / error → hard; a second abort in a settle upgrades)", () => {
  for (const [sname, build] of Object.entries(SCENARIOS)) {
    for (const reason of ["user", "dispose", "rigLost", "error", "bogus"]) {
      const d = build();
      const st = d.st();
      const r = reason === "bogus" ? "user" : reason;
      const a = d.req("abort", { reason });
      const want = oracle(st, r, true);
      if (want === null) assert.equal(a, NO_ACTIONS, `${sname} × abort(${reason}) ignored`);
      else {
        assert.deepEqual(a, want, `${sname} × abort(${reason})`);
        assert.equal(d.st().lastAbort.reason, r);
      }
    }
  }
  // An abort request without arg → user.
  const d = toFlying();
  d.req("abort");
  assert.equal(d.st().lastAbort.reason, "user");
  assert.equal(d.st().state, "aborting");
});

check("Q10 priority order: session > contextLost > portal > film > pilotMoved > death > damage > combat", () => {
  const order = [
    [{ sessionChanged: true, contextLost: true, portal: true, filmBusy: true, pilotMovedM: 9, death: true, damage: true, stanceCombat: true }, "session"],
    [{ contextLost: true, portal: true, filmBusy: true, pilotMovedM: 9, death: true, damage: true, stanceCombat: true }, "contextLost"],
    [{ portal: true, filmBusy: true, pilotMovedM: 9, death: true, damage: true, stanceCombat: true }, "portal"],
    [{ filmBusy: true, pilotMovedM: 9, death: true, damage: true, stanceCombat: true }, "film"],
    [{ pilotMovedM: 9, death: true, damage: true, stanceCombat: true }, "pilotMoved"],
    [{ death: true, damage: true, stanceCombat: true }, "death"],
    [{ damage: true, stanceCombat: true }, "damage"],
    [{ stanceCombat: true }, "combat"],
  ];
  for (const [patch, reason] of order) {
    const d = toFlying();
    d.signals = patch;
    d.frame();
    assert.equal(d.st().lastAbort.reason, reason, JSON.stringify(patch));
  }
  // pilotMovedM must exceed 2 m.
  const e = toFlying();
  e.signals = { pilotMovedM: 2 };
  assert.equal(e.frame(), NO_ACTIONS);
  // The request comes first: a recall request in the same tick as damage wins this tick; the abort follows.
  const f = toFlying();
  f.signals = { damage: true };
  assert.deepEqual(f.req("recall"), [A.state("returning", "flying"), A.auto("rth")]);
  assert.equal(f.frame()[0].state, "aborting");
});

check("Q10 death and combat never issue Ready; damage / user do; a hard abort issues Ready (not on death)", () => {
  for (const [patch, ready] of [[{ death: true }, false], [{ stanceCombat: true }, false], [{ damage: true }, true]]) {
    const d = toFlying();
    d.signals = patch;
    const a = d.frame();
    assert.equal(a.some(is("motion", { cmd: "Ready" })), ready, JSON.stringify(patch));
    assert.equal(a.some(is("inputRestore")), true);
  }
  const u = toFlying();
  assert.equal(u.req("abort", { reason: "user" }).some(is("motion", { cmd: "Ready" })), true);
  const h = toFlying();
  h.signals = { sessionChanged: true };
  assert.equal(h.frame().some(is("motion", { cmd: "Ready" })), true, "hard: Ready while held");
  // After a death abort the held ReadState stays recorded but the input is unlocked: no second abort, no watchdog.
  const z = toFlying();
  z.signals = { death: true };
  z.frame();
  assert.equal(z.st().held, true);
  assert.equal(z.st().locked, false);
  assert.equal(z.frame(), NO_ACTIONS, "death level while unlocked: ignored");
});

check("Q10 hidden never aborts (any state)", () => {
  for (const [sname, build] of Object.entries(SCENARIOS)) {
    const d = build();
    const st = d.st();
    d.signals = { hidden: true };
    const a = d.frame();
    assert.ok(!a.some((x) => x.type === "inputRestore" || (x.type === "state" && x.state === "aborting")), `${sname}: ${JSON.stringify(a)}`);
    assert.deepEqual(d.st().lastAbort, st.lastAbort, `${sname}: no abort recorded`);
  }
});

// ---------------------------------------------------------------------------
// Q11 idempotence, JSON safety, determinism, reset
// ---------------------------------------------------------------------------

check("Q11 deploy / recall idempotent; requests outside their states are ignored", () => {
  const d = new Driver();
  d.req("deploy");
  assert.equal(d.req("deploy"), NO_ACTIONS, "deploy while deploying");
  d.until((s) => s.state === "flying");
  assert.equal(d.req("deploy"), NO_ACTIONS, "deploy while flying");
  d.req("recall");
  assert.equal(d.req("recall"), NO_ACTIONS, "recall while returning");
  d.craft = { distTouchdownM: 2 };
  d.frame();
  assert.equal(d.st().state, "landing");
  assert.equal(d.req("recall"), NO_ACTIONS, "recall while landing");
  assert.equal(d.req("recallInstant"), NO_ACTIONS, "recallInstant while landing");
  assert.equal(d.req("pilotView"), NO_ACTIONS, "pilotView while landing");
  d.craft = { landed: true, distHomeM: 0 };
  d.frame();
  assert.equal(d.st().state, "stowing");
  assert.equal(d.req("recall"), NO_ACTIONS, "recall while stowing");
  assert.equal(d.req("skip"), NO_ACTIONS, "skip while stowing");
  assert.equal(d.req("nonsense"), NO_ACTIONS, "unknown request");
});

check("Q11 state(): JSON-safe, fresh copy, the §4.1 keys", () => {
  const d = toFlying();
  d.req("recall");
  const s = d.st();
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  assert.deepEqual(Object.keys(s).sort(), ["state", "beat", "beatIndex", "beatElapsed", "since", "quick", "speed", "rig", "pendingSkip", "fpv", "locked",
    "drone", "tablet", "goggles", "wieldedHidden", "held", "clipActive", "rth", "forcedLanding", "batteryRthUsed", "stowKind", "cutFired",
    "eventFired", "lastAbort"].sort());
  s.rth.armed = "mutated";
  s.cutFired.own = "mutated";
  assert.equal(d.st().rth.armed, false);
  assert.equal(d.st().cutFired.own, true);
  near(d.st().since, d.t, 1e-12, "since = the tick's now");
});

check("Q11 deterministic: the same scripted input stream replays to deep-equal actions and states", () => {
  const script = (d) => {
    d.req("deploy", { quick: false });
    d.until((s) => s.state === "flying");
    for (let k = 0; k < 120; k += 1) {
      d.sticks = k % 40 < 20 ? { sticksActive: true, anyInput: true } : {};
      d.frame();
    }
    d.req("pilotView");
    d.frame();
    d.req("pilotView");
    d.battery = { rth: true };
    d.frame();
    d.battery = {};
    for (let k = 0; k < 10; k += 1) d.frame();
    d.craft = { distTouchdownM: 4 };
    d.frame();
    d.craft = { landed: true, distHomeM: 0.4 };
    d.frame();
    d.craft = {};
    d.until((s) => s.state === "idle");
  };
  const a = new Driver();
  const b = new Driver();
  script(a);
  script(b);
  assert.deepEqual(a.stream, b.stream);
  assert.deepEqual(a.st(), b.st());
  assert.ok(a.stream.length > 20);
});

check("Q11 reset(): back to idle without actions; lastAbort cleared; options override the defaults", () => {
  const d = toFlying();
  d.signals = { damage: true };
  d.frame();
  d.seq.reset();
  const s = d.st();
  assert.equal(s.state, "idle");
  assert.equal(s.lastAbort, null);
  assert.equal(s.locked, false);
  assert.equal(s.drone, "none");
  d.signals = {};
  assert.equal(d.frame(), NO_ACTIONS);
  const q = new Driver({ opts: { quickSpeed: 2, slackSec: 0, bogus: 1, prepTimeoutSec: -1 } });
  q.req("deploy", { quick: true });
  assert.equal(q.st().speed, 2);
  const late = new Driver({ opts: { prepTimeoutSec: 0.5 }, readyAt: Infinity, rigKnown: null });
  late.req("deploy");
  late.until((st) => st.beat !== "prep", 1);
  near(late.t, 0.5, 1 / 60 + 1e-9, "opts.prepTimeoutSec applies; negative values are ignored");
});

// ---------------------------------------------------------------------------

for (const run of pending) await run();
console.log(`drone_sequence: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
