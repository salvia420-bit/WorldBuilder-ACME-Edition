// scene3d/drone/sequence.js — the Drone Deploy state machine (SPEC scene3d/drone/SPEC.md §3.10, §4).
//
// WHY: a deploy → fly → stow cycle is a long chain of beats (pack, place, goggles,
// tablet up, lift-off, the goggle cut, flight, return, landing, the stow in
// reverse) that every abort signal (damage, death, portal space, a combat stance,
// a session change, a film take, WebGL context loss, ...) can cut at any point.
// Each exit must undo exactly what the cycle did so far — the camera, the input
// lock, the held ReadState, the props on the rig, the hidden wielded items, the
// rotors and the hum — and nothing more (a corpse must never be stood up by a
// Ready; a combat stance must not be re-posed). That bookkeeping lives here, in
// ONE pure module: `tick(input)` advances the beat clock by the frame's dt, checks
// the guards in a fixed order — (1) the request, (2) abort signals, (3) crash,
// (4) battery, (5) the state's own rules / beat clock — and returns plain action
// objects that the page driver (scene3d/drone/index.js) executes in order. One
// transition per tick, except that a beat ending applies the next beat's entry
// actions in the same tick. The module never touches the page, so every row of
// SPEC §4.5 / §4.6 is unit-testable (tests/drone_sequence.test.mjs).
//
// Flag: `?drone`, DEFAULT ON since 2026-10-25 (`=off` disables it) — nothing under
// scene3d/drone/ loads with `?drone=off` (plugins/drone-hud.js mounts the launcher only without it).
//
// Pure module: no window, document, three, wasm, clocks or Math.random. `now`
// comes in with every tick and only stamps `since` / `lastAbort.at`; every clock
// is Σdt. Deterministic: the same input stream gives deep-equal action streams
// and states.

/** Sequence states (SPEC §4.1). */
export const SEQUENCE_STATES = Object.freeze(["idle", "deploying", "flying", "pilotView", "returning", "landing", "stowing", "aborting", "crashed"]);

/** Tick requests (SPEC §4.2); API calls, control actions and DOM events send them with dt = 0. */
export const REQUESTS = Object.freeze(["deploy", "skip", "recall", "recallInstant", "pilotView", "abort"]);

/** Action types the sequence emits (SPEC §4.3). */
export const ACTION_TYPES = Object.freeze(["state", "inputLock", "inputRestore", "controlsPhase", "hideWielded", "clip",
  "stopClip", "motion", "attach", "detach", "place", "fadeOut", "cameraOwn", "cameraRelease", "autopilot", "rotors", "osd",
  "audio", "broadcastPose"]);

/** Every abort reason (SPEC §4.6). */
export const ABORT_REASONS = Object.freeze(["damage", "death", "portal", "combat", "pilotMoved", "session", "film",
  "contextLost", "user", "dispose", "rigLost", "error"]);

/** Reasons that remove everything at once (no landing, no fade): SPEC §4.6 HARD actions. */
export const HARD_ABORT_REASONS = Object.freeze(["session", "contextLost", "portal", "pilotMoved", "film", "dispose", "rigLost", "error"]);

/**
 * Beat durations at speed 1 (SPEC §4.4): retail frame counts / 30 fps. The clip beats
 * (pack, place, goggles) and the lift-off divide by the cycle speed; tabletDown, spawn
 * and powerDown never do. `tabletUp` is no beat since 2026-10-25: it is the ReadState link,
 * which plays during the first 22/30 s of the lift-off, so the drone takes off as soon as
 * the goggles are on (the own at cutBlackSec ÷ speed still comes after the tablet is up).
 */
export const BEAT_SEC = Object.freeze({
  pack: 43 / 30,
  place: 50 / 30,
  goggles: 42 / 30,
  tabletUp: 22 / 30,
  tabletDown: 22 / 30,
  spawn: 22 / 30,
  powerDown: 0.6,
  liftoff: 2.2,
  crashStatic: 1.0,
});

/** Clip beat event times at speed 1 (SPEC §4.4): the gestures' `eventAtFrame` / 30. */
export const BEAT_EVENT_SEC = Object.freeze({ pack: 18 / 30, place: 18 / 30, goggles: 14 / 30 });

/**
 * Sequence tuning (SPEC §3.10). cutBlackSec = BEAT_SEC.liftoff / 2 (the camera own lands
 * on the lift-off path midpoint, DV-31); cutStartSec / cutEndSec = cutBlackSec ∓ 0.175 (the
 * 0.35 s boot wipe); settleTimeoutSec = fadeDelaySec + fadeDurationSec + 2 (T29). All at
 * speed 1; the lift-off sub-events divide by the beat speed like the beat itself.
 * recallGraceSec: a recall from the goggles stays in them this long (a fresh stick input
 * cancels it, T16), then the view cuts to the pilot and the drone comes down over home (T30).
 */
export const SEQUENCE_DEFAULTS = Object.freeze({
  quickSpeed: 1.5,
  slackSec: 0.05,
  prepTimeoutSec: 1.0,
  crashStaticSec: 1.0,
  recallGraceSec: 3,
  landingReleaseM: 5,
  homeToleranceM: 1.5,
  pilotMovedAbortM: 2,
  fadeDelaySec: 5,
  fadeDurationSec: 1,
  cutStartSec: 0.925,
  cutBlackSec: 1.1,
  cutEndSec: 1.275,
  settleTimeoutSec: 8,
});

/** The shared frozen empty action list `tick` returns when nothing happens. */
export const NO_ACTIONS = Object.freeze([]);

/** Float tolerance on beat-clock comparisons (Σdt drifts by ulps). */
const EPS = 1e-9;
/** Boot wipe length at speed 1 (s): cutEndSec − cutStartSec. */
const BOOT_WIPE_SEC = 0.35;
/** Rotor / hum ramp of a skip (s). */
const SKIP_RAMP_SEC = 0.3;
/** States in which a crash can happen (T22; deploying only during the lift-off with the drone up). */
const CRASH_STATES = Object.freeze(["flying", "pilotView", "returning", "landing"]);

/**
 * Beat table (SPEC §4.4). `clip` = the gesture clip the beat plays (its end may come from
 * `beatDone`), `dur` / `eventSec` at speed 1, `scaled` = divided by the cycle speed.
 * settle / static are timed by their own rules (T27/T29, T23).
 */
const BEATS = Object.freeze({
  prep: Object.freeze({ index: 0, clip: null, dur: null, eventSec: null, scaled: false }),
  pack: Object.freeze({ index: 1, clip: "pack", dur: BEAT_SEC.pack, eventSec: BEAT_EVENT_SEC.pack, scaled: true }),
  place: Object.freeze({ index: 2, clip: "place", dur: BEAT_SEC.place, eventSec: BEAT_EVENT_SEC.place, scaled: true }),
  goggles: Object.freeze({ index: 3, clip: "goggles", dur: BEAT_SEC.goggles, eventSec: BEAT_EVENT_SEC.goggles, scaled: true }),
  spawn: Object.freeze({ index: 4, clip: null, dur: BEAT_SEC.spawn, eventSec: null, scaled: false }),
  liftoff: Object.freeze({ index: 5, clip: null, dur: BEAT_SEC.liftoff, eventSec: null, scaled: true }),
  tabletDown: Object.freeze({ index: 1, clip: null, dur: BEAT_SEC.tabletDown, eventSec: null, scaled: false }),
  gogglesOff: Object.freeze({ index: 2, clip: "goggles", dur: BEAT_SEC.goggles, eventSec: BEAT_EVENT_SEC.goggles, scaled: true }),
  pickUp: Object.freeze({ index: 3, clip: "place", dur: BEAT_SEC.place, eventSec: BEAT_EVENT_SEC.place, scaled: true }),
  packAway: Object.freeze({ index: 4, clip: "pack", dur: BEAT_SEC.pack, eventSec: BEAT_EVENT_SEC.pack, scaled: true }),
  powerDown: Object.freeze({ index: 1, clip: null, dur: BEAT_SEC.powerDown, eventSec: null, scaled: false }),
  settle: Object.freeze({ index: null, clip: null, dur: null, eventSec: null, scaled: false }),
  static: Object.freeze({ index: null, clip: null, dur: null, eventSec: null, scaled: false }),
});

// ---------------------------------------------------------------------------
// action constructors (fresh plain objects, allocated on transitions only)
// ---------------------------------------------------------------------------

const A = {
  state: (state, prev) => ({ type: "state", state, prev }),
  inputLock: () => ({ type: "inputLock" }),
  inputRestore: () => ({ type: "inputRestore" }),
  controlsPhase: (phase) => ({ type: "controlsPhase", phase }),
  hideWielded: (on) => ({ type: "hideWielded", on }),
  clip: (name, speed) => ({ type: "clip", name, speed }),
  stopClip: () => ({ type: "stopClip" }),
  motion: (cmd) => ({ type: "motion", cmd, speed: 1 }), // motions always at speed 1 (DV-12)
  attach: (prop, anchor) => ({ type: "attach", prop, anchor }),
  detach: (prop, to) => ({ type: "detach", prop, to }),
  place: () => ({ type: "place", prop: "drone" }),
  fadeOut: (delaySec, durationSec) => ({ type: "fadeOut", prop: "drone", delaySec, durationSec }),
  cameraOwn: () => ({ type: "cameraOwn" }),
  cameraRelease: (framePilot) => ({ type: "cameraRelease", framePilot }),
  autopilot: (plan, speed) => ({ type: "autopilot", plan, speed }),
  // The drone comes down over home; `cut` = the view has just cut away from the goggles.
  approach: (cut) => ({ type: "autopilot", plan: "approach", speed: 1, cut }),
  rotors: (level, rampSec) => ({ type: "rotors", level, rampSec }),
  osd: (mode, durationSec) => (durationSec === undefined ? { type: "osd", mode } : { type: "osd", mode, durationSec }),
  audio: (level, rampSec) => ({ type: "audio", level, rampSec }),
  broadcastPose: () => ({ type: "broadcastPose" }),
};

/** Finite number or the fallback. */
function fin(v, d) {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

/** 'humanoid' | 'no-hands' | null from a rig kind input (anything non-null but unknown = no-hands). */
function rigKind(v) {
  if (v === null || v === undefined) return null;
  return v === "humanoid" ? "humanoid" : "no-hands";
}

/**
 * Create the Drone Deploy sequence (SPEC §4). `opts` overrides SEQUENCE_DEFAULTS keys
 * (finite, ≥ 0; quickSpeed > 0); unknown keys are ignored.
 *
 * - `tick(input)` → Action[]: the §4.2 tick input (owned by the caller, never kept);
 *   NO_ACTIONS when nothing happens.
 * - `state()` → a fresh JSON-safe copy of the §4.1 model.
 * - `reset()` → back to idle without actions (dispose only; `lastAbort` cleared too).
 * - `returnCutInSec()` → seconds left of the recall grace in the goggles, NaN outside it.
 * @param {Partial<typeof SEQUENCE_DEFAULTS>} [opts]
 * @returns {{tick:(input:object)=>ReadonlyArray<object>, state:()=>object, reset:()=>void,
 *   returnCutInSec:()=>number}}
 */
export function createSequence(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  /** @type {Record<string, number>} */
  const C = { ...SEQUENCE_DEFAULTS };
  for (const k of Object.keys(SEQUENCE_DEFAULTS)) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0 && !(k === "quickSpeed" && v <= 0)) C[k] = v;
  }

  /** The §4.1 model (mutated in place; state() copies it). */
  const S = {
    state: "idle",
    beat: /** @type {string|null} */ (null),
    beatIndex: /** @type {number|null} */ (null),
    beatElapsed: 0,
    since: 0,
    quick: false,
    speed: 1,
    rig: /** @type {'humanoid'|'no-hands'|null} */ (null),
    pendingSkip: false,
    fpv: false,
    locked: false,
    drone: "none",
    tablet: false,
    goggles: false,
    wieldedHidden: false,
    held: false,
    clipActive: false,
    rth: /** @type {{reason:string, fpv:boolean, cancellable:boolean, armed:boolean, elapsedSec:number}|null} */ (null),
    forcedLanding: false,
    batteryRthUsed: false,
    stowKind: /** @type {'full'|'noDrone'|null} */ (null),
    cutFired: { boot: false, own: false, fpv: false },
    eventFired: false,
    lastAbort: /** @type {{reason:string, from:string, at:number}|null} */ (null),
  };
  let lastNow = 0;

  /** Clear every per-cycle field (idle). `lastAbort` survives. */
  function clearCycle() {
    S.beat = null;
    S.beatIndex = null;
    S.beatElapsed = 0;
    S.quick = false;
    S.speed = 1;
    S.rig = null;
    S.pendingSkip = false;
    S.fpv = false;
    S.locked = false;
    S.drone = "none";
    S.tablet = false;
    S.goggles = false;
    S.wieldedHidden = false;
    S.held = false;
    S.clipActive = false;
    S.rth = null;
    S.forcedLanding = false;
    S.batteryRthUsed = false;
    S.stowKind = null;
    S.cutFired.boot = false;
    S.cutFired.own = false;
    S.cutFired.fpv = false;
    S.eventFired = false;
  }

  /** Change state (no action; callers push the `state` action first). */
  function setState(next, now) {
    S.state = next;
    S.since = now;
  }

  /** Enter idle: state + clear the cycle. */
  function toIdle(now) {
    setState("idle", now);
    clearCycle();
  }

  /** Beat duration (s) at the cycle speed. */
  function durOf(def) {
    return def.scaled ? def.dur / S.speed : def.dur;
  }

  /** Beat event time (s) at the cycle speed. */
  function eventOf(def) {
    return def.scaled ? def.eventSec / S.speed : def.eventSec;
  }

  /** Leave whatever beat runs (no actions). */
  function clearBeat() {
    S.beat = null;
    S.beatIndex = null;
    S.beatElapsed = 0;
    S.eventFired = false;
    S.clipActive = false;
  }

  // ---- beats ----------------------------------------------------------------

  /** Start beat `name` and push its entry actions (SPEC §4.4). */
  function enterBeat(name, out) {
    const def = BEATS[name];
    S.beat = name;
    S.beatIndex = def.index;
    S.beatElapsed = 0;
    S.eventFired = false;
    S.clipActive = def.clip !== null;
    const s = S.speed;
    switch (name) {
      case "pack":
        out.push(A.clip("pack", s));
        break;
      case "place":
        if (S.drone === "none") {
          // Quick deploy: no pack beat, so the drone appears in the hand at the kneel.
          out.push(A.attach("drone", "rightHand"));
          S.drone = "hand";
        }
        out.push(A.clip("place", s));
        break;
      case "goggles":
        out.push(A.clip("goggles", s));
        // The rotors spin up while the goggles go on, so the drone lifts off when they are on.
        out.push(A.rotors(1, durOf(def)));
        out.push(A.audio(1, durOf(def)));
        break;
      case "spawn":
        out.push(A.place());
        S.drone = "ground";
        out.push(A.rotors(1, BEAT_SEC.spawn));
        out.push(A.audio(1, BEAT_SEC.spawn));
        break;
      case "liftoff":
        // The tablet comes up during the lift-off (the skip list has done it already).
        if (S.rig === "humanoid" && !S.tablet) {
          out.push(A.attach("tablet", "leftHand"));
          S.tablet = true;
        }
        if (S.rig === "humanoid" && !S.held) {
          out.push(A.motion("ReadState"));
          S.held = true;
          out.push(A.broadcastPose());
        }
        S.cutFired.boot = false;
        S.cutFired.own = false;
        S.cutFired.fpv = false;
        out.push(A.autopilot("liftoff", s));
        S.drone = "air";
        break;
      case "tabletDown":
        out.push(A.motion("Ready"));
        S.held = false;
        break;
      case "gogglesOff":
        out.push(A.clip("goggles", s));
        break;
      case "pickUp":
        out.push(A.clip("place", s));
        break;
      case "packAway":
        out.push(A.clip("pack", s));
        break;
      default:
        // prep (T1 pushes its actions), powerDown, settle, static: no entry actions.
        break;
    }
  }

  /** Push the running beat's event actions (once). */
  function fireEvent(out) {
    S.eventFired = true;
    switch (S.beat) {
      case "pack":
        out.push(A.attach("drone", "rightHand"));
        S.drone = "hand";
        break;
      case "place":
        out.push(A.detach("drone", "world"));
        S.drone = "ground";
        break;
      case "goggles":
        out.push(A.attach("goggles", "head"));
        S.goggles = true;
        break;
      case "gogglesOff":
        out.push(A.detach("goggles", "remove"));
        S.goggles = false;
        break;
      case "pickUp":
        out.push(A.attach("drone", "rightHand"));
        S.drone = "hand";
        break;
      case "packAway":
        out.push(A.detach("drone", "remove"));
        S.drone = "none";
        break;
      default:
        break;
    }
  }

  /** The skip list (T9): everything the skipped beats would have done, then the lift-off entry. */
  function skipList(out) {
    if (S.clipActive) {
      out.push(A.stopClip());
      S.clipActive = false;
    }
    const humanoid = S.rig === "humanoid";
    if (humanoid) {
      out.push(A.attach("goggles", "head"));
      S.goggles = true;
      out.push(A.attach("tablet", "leftHand"));
      S.tablet = true;
    }
    if (S.drone !== "ground") {
      out.push(A.place());
      S.drone = "ground";
    }
    if (humanoid && !S.held) {
      out.push(A.motion("ReadState"));
      S.held = true;
      // With the ReadState comes the opt-in /read, as at the lift-off entry (deviation: SPEC T9 omits it).
      out.push(A.broadcastPose());
    }
    out.push(A.rotors(1, SKIP_RAMP_SEC));
    out.push(A.audio(1, SKIP_RAMP_SEC));
    enterBeat("liftoff", out);
  }

  /** T26 actions: the player gets control back while the drone still fades (noDrone stow). */
  function t26(out) {
    out.push(A.hideWielded(false));
    S.wieldedHidden = false;
    out.push(A.inputRestore());
    S.locked = false;
  }

  /** T25: the full stow is done. */
  function finish(out, now) {
    out.push(A.state("idle", S.state));
    out.push(A.hideWielded(false));
    out.push(A.inputRestore());
    toIdle(now);
  }

  /** End the running beat (T4 / T24): pending event, end actions, next beat (or the finish). */
  function endBeat(out, now) {
    const def = BEATS[S.beat];
    if (def.eventSec !== null && !S.eventFired) fireEvent(out);
    S.clipActive = false;
    switch (S.beat) {
      case "pack":
        enterBeat("place", out);
        return;
      case "place":
        enterBeat("goggles", out);
        return;
      case "goggles":
      case "spawn":
        enterBeat("liftoff", out);
        return;
      case "tabletDown":
        out.push(A.detach("tablet", "remove"));
        S.tablet = false;
        enterBeat("gogglesOff", out);
        return;
      case "gogglesOff":
        if (S.stowKind === "full") enterBeat("pickUp", out);
        else {
          t26(out);
          enterBeat("settle", out);
        }
        return;
      case "pickUp":
        if (!S.quick) {
          enterBeat("packAway", out);
          return;
        }
        out.push(A.detach("drone", "remove"));
        S.drone = "none";
        finish(out, now);
        return;
      case "packAway":
        finish(out, now);
        return;
      case "powerDown":
        out.push(A.detach("drone", "remove"));
        S.drone = "none";
        finish(out, now);
        return;
      default:
        return;
    }
  }

  /**
   * Timed beat rules shared by the deploy and stow clip / timer beats: the end (beatDone on a
   * clip beat, or duration + slack) wins and carries a pending event; otherwise the event
   * (beatEvent on a clip beat, or eventSec + slack).
   */
  function beatRules(i, now) {
    const def = BEATS[S.beat];
    if (!def || def.dur === null) return null;
    const t = S.beatElapsed;
    const endDue = (def.clip !== null && i.beatDone === true) || t + EPS >= durOf(def) + C.slackSec;
    if (endDue) {
      const out = [];
      endBeat(out, now);
      return out;
    }
    if (def.eventSec !== null && !S.eventFired) {
      const evDue = (def.clip !== null && i.beatEvent === true) || t + EPS >= eventOf(def) + C.slackSec;
      if (evDue) {
        const out = [];
        fireEvent(out);
        return out;
      }
    }
    return null;
  }

  // ---- transitions ------------------------------------------------------------

  /** T1 idle → deploying/prep. */
  function t1(i, now) {
    const quick = !!(i.arg && typeof i.arg === "object" && i.arg.quick === true);
    clearCycle();
    S.quick = quick;
    S.speed = quick ? C.quickSpeed : 1;
    const out = [A.state("deploying", "idle"), A.inputLock(), A.controlsPhase("deploy"), A.hideWielded(true)];
    setState("deploying", now);
    S.locked = true;
    S.wieldedHidden = true;
    enterBeat("prep", out);
    return out;
  }

  /**
   * T8 deploying/liftoff → flying. When control is taken before the cutEnd sub-event (input,
   * autopilotDone or a skip in the 0.175 s after the own), the pending `osd(fpv)` comes with it
   * — otherwise the OSD would stay in its boot mode for the whole flight (beyond SPEC T8's list).
   */
  function t8(now) {
    const out = [A.state("flying", "deploying")];
    if (!S.cutFired.fpv) {
      out.push(A.osd("fpv"));
      S.cutFired.fpv = true;
    }
    out.push(A.autopilot(null, 1));
    setState("flying", now);
    clearBeat();
    return out;
  }

  /** T9 skip (deploying/any). */
  function t9(now) {
    if (S.beat === "prep") {
      S.pendingSkip = true;
      return NO_ACTIONS;
    }
    if (S.beat === "liftoff") {
      if (S.cutFired.own) return t8(now);
      const cs = C.cutStartSec / S.speed;
      if (S.beatElapsed < cs) S.beatElapsed = cs;
      return NO_ACTIONS;
    }
    const out = [];
    skipList(out);
    return out;
  }

  /** T10 flying → pilotView. */
  function t10(now) {
    const out = [A.state("pilotView", "flying"), A.autopilot("hold", 1), A.cameraRelease(true), A.controlsPhase("pilot"), A.osd("pilot")];
    setState("pilotView", now);
    S.fpv = false;
    return out;
  }

  /** T11 pilotView → flying. */
  function t11(now) {
    const out = [A.state("flying", "pilotView"), A.cameraOwn(), A.controlsPhase("fly"), A.osd("fpv"), A.autopilot(null, 1)];
    setState("flying", now);
    S.fpv = true;
    return out;
  }

  /**
   * T12 / T13 / T14: a user recall. From the goggles (T12) the drone starts home and the view
   * stays for recallGraceSec, so a recall pressed by mistake can be cancelled (T16); then T30.
   * Instant (T13) and from pilot view (T14) skip that: the drone comes down over home now.
   */
  function recall(instant, now) {
    const from = S.state;
    const out = [A.state("returning", from)];
    if (from === "flying" && !instant) {
      S.rth = { reason: "user", fpv: true, cancellable: true, armed: false, elapsedSec: 0 };
      out.push(A.autopilot("rth", 1));
    } else {
      if (from === "flying") out.push(A.cameraRelease(false)); // T13
      out.push(A.controlsPhase("stow"), A.osd("off"));
      S.fpv = false;
      S.rth = { reason: "user", fpv: false, cancellable: false, armed: false, elapsedSec: 0 };
      out.push(A.approach(from === "flying"));
    }
    setState("returning", now);
    return out;
  }

  /** T15 returning (fpv) + recallInstant, and T30 at the end of the grace: cut to third person now. */
  function cutToApproach() {
    const out = [A.cameraRelease(false), A.controlsPhase("stow"), A.osd("off"), A.approach(true)];
    S.fpv = false;
    if (S.rth) {
      S.rth.fpv = false;
      S.rth.cancellable = false;
    }
    return out;
  }

  /** T16 returning → flying (a fresh stick input cancels a cancellable RTH). */
  function t16(now) {
    const out = [A.state("flying", "returning"), A.autopilot(null, 1)];
    setState("flying", now);
    S.rth = null;
    return out;
  }

  /** Push the third-person release T17 / T20 / T21 share. */
  function releaseToThird(out) {
    out.push(A.cameraRelease(false), A.controlsPhase("stow"), A.osd("off"));
    S.fpv = false;
  }

  /** T17 returning → landing (5 m before touchdown). */
  function t17(now) {
    const out = [A.state("landing", "returning")];
    if (S.fpv) releaseToThird(out);
    setState("landing", now);
    S.rth = null;
    return out;
  }

  /** T18 battery RTH (flying: the T12 grace in the goggles; pilotView: down over home now). */
  function t18(now) {
    const from = S.state;
    const out = [A.state("returning", from), from === "flying" ? A.autopilot("rth", 1) : A.approach(false)];
    if (from === "pilotView") out.push(A.controlsPhase("stow"), A.osd("off"));
    S.rth = { reason: "battery", fpv: from === "flying", cancellable: from === "flying", armed: false, elapsedSec: 0 };
    S.batteryRthUsed = true;
    setState("returning", now);
    return out;
  }

  /** T19 empty battery → forced landing in place (flying / pilotView / returning). */
  function t19(now) {
    const from = S.state;
    const out = [A.state("landing", from), A.autopilot("landHere", 1)];
    if (from === "pilotView") out.push(A.controlsPhase("stow"), A.osd("off"));
    S.forcedLanding = true;
    S.rth = null;
    setState("landing", now);
    return out;
  }

  /** T21 landing → stowing. */
  function t21(i, now) {
    const c = i.craft || {};
    const full = !S.forcedLanding && typeof c.distHomeM === "number" && Number.isFinite(c.distHomeM) && c.distHomeM <= C.homeToleranceM + EPS;
    const out = [A.state("stowing", "landing")];
    if (S.fpv) releaseToThird(out); // T20 folded in: landed and ≤ 5 m first seen in the same tick
    out.push(A.rotors(0, 0.6), A.audio(0, 0.6));
    S.stowKind = full ? "full" : "noDrone";
    if (full) S.drone = "ground";
    else {
      out.push(A.fadeOut(C.fadeDelaySec, C.fadeDurationSec));
      S.drone = "fading";
    }
    setState("stowing", now);
    clearBeat();
    if (S.rig === "humanoid") enterBeat("tabletDown", out);
    else if (full) enterBeat("powerDown", out);
    else {
      t26(out);
      enterBeat("settle", out);
    }
    return out;
  }

  /** T22 crash. */
  function t22(now) {
    const from = S.state;
    const out = [A.state("crashed", from), A.autopilot("crash", 1), A.rotors(0, 0.2), A.audio(0, 0.3)];
    out.push(A.osd(S.fpv ? "crash" : "off"));
    out.push(A.fadeOut(C.fadeDelaySec, C.fadeDurationSec));
    S.drone = "fading";
    S.rth = null;
    setState("crashed", now);
    clearBeat();
    enterBeat("static", out);
    return out;
  }

  /** T23 crashed → stowing (noDrone). */
  function t23(now) {
    const out = [A.state("stowing", "crashed")];
    if (S.fpv) out.push(A.cameraRelease(false));
    S.fpv = false;
    out.push(A.controlsPhase("stow"), A.osd("off"));
    S.stowKind = "noDrone";
    setState("stowing", now);
    clearBeat();
    if (S.rig === "humanoid") enterBeat("tabletDown", out);
    else {
      t26(out);
      enterBeat("settle", out);
    }
    return out;
  }

  /** T27 settle → idle (the drone is gone). */
  function t27(now) {
    const out = [A.state("idle", S.state)];
    toIdle(now);
    return out;
  }

  /** T29 settle timeout → idle (the button never sticks at busy). */
  function t29(now) {
    const out = [A.state("idle", S.state), A.detach("drone", "remove")];
    toIdle(now);
    return out;
  }

  // ---- aborts (SPEC §4.6) --------------------------------------------------------

  /** SOFT actions: land in place and fade; the player gets control back now. */
  function softAbort(reason, now) {
    const from = S.state;
    S.lastAbort = { reason, from, at: now };
    const direct = S.drone === "none" || S.drone === "hand";
    const out = [A.state(direct ? "idle" : "aborting", from)];
    if (S.clipActive) {
      out.push(A.stopClip());
      S.clipActive = false;
    }
    if (S.fpv) {
      out.push(A.cameraRelease(false));
      S.fpv = false;
    }
    out.push(A.osd("off"));
    if (S.locked) {
      out.push(A.inputRestore());
      S.locked = false;
    }
    if (S.held && reason !== "death" && reason !== "combat") {
      out.push(A.motion("Ready"));
      S.held = false;
    }
    if (S.tablet) {
      out.push(A.detach("tablet", "remove"));
      S.tablet = false;
    }
    if (S.goggles) {
      out.push(A.detach("goggles", "remove"));
      S.goggles = false;
    }
    if (S.wieldedHidden) {
      out.push(A.hideWielded(false));
      S.wieldedHidden = false;
    }
    out.push(A.audio(0, 0.3));
    switch (S.drone) {
      case "hand":
        out.push(A.detach("drone", "remove"));
        S.drone = "none";
        break;
      case "ground":
        out.push(A.rotors(0, 0.6), A.fadeOut(C.fadeDelaySec, C.fadeDurationSec));
        S.drone = "fading";
        break;
      case "air":
        // Stays 'air' until T28 sees the touchdown (and stops the rotors there).
        out.push(A.autopilot("landHere", 1), A.fadeOut(C.fadeDelaySec, C.fadeDurationSec));
        break;
      default:
        break;
    }
    if (direct) {
      toIdle(now);
      return out;
    }
    setState("aborting", now);
    S.rth = null;
    S.pendingSkip = false;
    clearBeat();
    enterBeat("settle", out);
    return out;
  }

  /** HARD actions: everything goes at once. */
  function hardAbort(reason, now) {
    const from = S.state;
    S.lastAbort = { reason, from, at: now };
    const out = [A.state("idle", from)];
    if (S.clipActive) out.push(A.stopClip());
    if (S.fpv) out.push(A.cameraRelease(false));
    out.push(A.osd("off"));
    if (S.locked) out.push(A.inputRestore());
    if (S.held && reason !== "death") out.push(A.motion("Ready"));
    out.push(A.detach("tablet", "remove"), A.detach("goggles", "remove"));
    if (S.wieldedHidden) out.push(A.hideWielded(false));
    out.push(A.audio(0, 0), A.rotors(0, 0), A.autopilot(null, 1));
    if (S.drone !== "none") out.push(A.detach("drone", "remove"));
    toIdle(now);
    return out;
  }

  /** stowing/settle or aborting → idle at once (hard signal, or a second abort request). */
  function settleAbort(reason, now) {
    const from = S.state;
    S.lastAbort = { reason, from, at: now };
    const out = [A.state("idle", from), A.detach("drone", "remove")];
    toIdle(now);
    return out;
  }

  /** Apply an abort by reason from the current state (null when ignored). */
  function abortWith(reason, now, viaRequest) {
    const st = S.state;
    if (st === "idle") return null;
    const hard = HARD_ABORT_REASONS.includes(reason);
    if (st === "aborting" || (st === "stowing" && S.beat === "settle")) {
      return hard || viaRequest ? settleAbort(reason, now) : null;
    }
    if (st === "stowing") {
      if (!hard && S.drone === "fading") return softAbort(reason, now);
      return hardAbort(reason, now);
    }
    return hard ? hardAbort(reason, now) : softAbort(reason, now);
  }

  /** (2) Abort signals → reason, in priority order; the soft-ish ones only while locked. */
  function signalReason(sig) {
    if (!sig || typeof sig !== "object") return null;
    if (sig.sessionChanged === true) return "session";
    if (sig.contextLost === true) return "contextLost";
    if (sig.portal === true) return "portal";
    if (sig.filmBusy === true) return "film";
    if (!S.locked) return null; // the player has control again (abort settle, noDrone settle)
    if (typeof sig.pilotMovedM === "number" && sig.pilotMovedM > C.pilotMovedAbortM) return "pilotMoved";
    if (sig.death === true) return "death";
    if (sig.damage === true) return "damage";
    if (sig.stanceCombat === true) return "combat";
    return null;
  }

  // ---- the tick ------------------------------------------------------------------

  /** (1) The request. Returns actions (NO_ACTIONS included) when handled, null when ignored. */
  function onRequest(i, now) {
    switch (i.request) {
      case "deploy":
        return S.state === "idle" ? t1(i, now) : null;
      case "skip":
        return S.state === "deploying" ? t9(now) : null;
      case "recall":
        if (S.state === "flying") return recall(false, now);
        if (S.state === "pilotView") return recall(true, now);
        return null;
      case "recallInstant":
        if (S.state === "flying" || S.state === "pilotView") return recall(true, now);
        if (S.state === "returning" && S.fpv) return cutToApproach(); // T15
        return null;
      case "pilotView":
        if (S.state === "flying") return t10(now);
        if (S.state === "pilotView") return t11(now);
        return null;
      case "abort": {
        const r = i.arg && typeof i.arg === "object" ? i.arg.reason : undefined;
        return abortWith(ABORT_REASONS.includes(r) ? r : "user", now, true);
      }
      default:
        return null;
    }
  }

  /** deploying: prep, beats, lift-off sub-events, T8. */
  function deployRules(i, dt, now) {
    if (S.beat === "prep") {
      // Ends on a frame (dt > 0) once gestures.ready() resolved (`rig`), else at the timeout
      // with the profile kind known so far (`rigKnown`: a known humanoid keeps its beats).
      const timedOut = S.beatElapsed + EPS >= C.prepTimeoutSec;
      const resolved = rigKind(i.rig);
      let rig = null;
      if (resolved !== null && (dt > 0 || timedOut)) rig = resolved;
      else if (timedOut) rig = rigKind(i.rigKnown) ?? "no-hands";
      if (rig === null) return null;
      S.rig = rig;
      const out = [];
      if (S.pendingSkip) {
        S.pendingSkip = false;
        skipList(out);
      } else if (rig === "humanoid") enterBeat(S.quick ? "place" : "pack", out);
      else enterBeat("spawn", out);
      return out;
    }
    if (S.beat === "liftoff") {
      const t = S.beatElapsed + EPS;
      const s = S.speed;
      if (!S.cutFired.boot && t >= C.cutStartSec / s) {
        S.cutFired.boot = true;
        return [A.osd("boot", BOOT_WIPE_SEC / s)];
      }
      if (!S.cutFired.own && t >= C.cutBlackSec / s) {
        S.cutFired.own = true;
        S.fpv = true;
        return [A.cameraOwn(), A.controlsPhase("fly")];
      }
      if (S.cutFired.own && !S.cutFired.fpv && t >= C.cutEndSec / s) {
        S.cutFired.fpv = true;
        return [A.osd("fpv")];
      }
      const c = i.craft || {};
      const inp = i.input || {};
      if (S.fpv && (c.autopilotDone === true || t >= BEAT_SEC.liftoff / s || inp.anyInput === true)) return t8(now);
      return null;
    }
    return beatRules(i, now);
  }

  /** returning: arm the cancel, T16, T17, T30 (the grace in the goggles ran out). */
  function returningRules(i, dt, now) {
    const r = S.rth;
    const inp = i.input || {};
    if (r) {
      if (inp.sticksActive !== true) r.armed = true;
      else if (r.armed && S.fpv && r.cancellable) return t16(now);
    }
    const d = i.craft ? i.craft.distTouchdownM : null;
    if (typeof d === "number" && Number.isFinite(d) && d <= C.landingReleaseM) return t17(now);
    if (r && S.fpv) {
      r.elapsedSec += dt;
      if (r.elapsedSec + EPS >= C.recallGraceSec) return cutToApproach();
    }
    return null;
  }

  /** landing: T21, T20. */
  function landingRules(i, now) {
    const c = i.craft || {};
    if (c.landed === true) return t21(i, now);
    const d = c.distTouchdownM;
    if (S.fpv && typeof d === "number" && Number.isFinite(d) && d <= C.landingReleaseM) {
      const out = [];
      releaseToThird(out);
      return out;
    }
    return null;
  }

  /** stowing/settle and aborting/settle: T27, T29. */
  function settleRules(i, now) {
    if (i.craft && i.craft.gone === true) return t27(now);
    if (S.beatElapsed + EPS >= C.settleTimeoutSec) return t29(now);
    return null;
  }

  /**
   * Advance one tick (SPEC §4.2 input; §4.5 guard order).
   * @param {object} input
   * @returns {ReadonlyArray<object>}
   */
  function tick(input) {
    const i = input && typeof input === "object" ? input : {};
    const dt = typeof i.dt === "number" && Number.isFinite(i.dt) && i.dt > 0 ? i.dt : 0;
    const now = fin(i.now, lastNow);
    lastNow = now;
    if (S.state === "idle" && i.request !== "deploy") return NO_ACTIONS;
    if (S.beat !== null) S.beatElapsed += dt;

    // (1) the request
    if (i.request !== null && i.request !== undefined) {
      const r = onRequest(i, now);
      if (r !== null) return r;
    }
    // (2) abort signals
    const reason = signalReason(i.signals);
    if (reason !== null) {
      const r = abortWith(reason, now, false);
      if (r !== null) return r;
    }
    // (3) crash
    const st = S.state;
    const c = i.craft || {};
    const crashMps = fin(i.crashMps, 0);
    if (crashMps > 0 && fin(c.impactSpeed, 0) > crashMps
      && (CRASH_STATES.includes(st) || (st === "deploying" && S.beat === "liftoff" && S.drone === "air"))) {
      return t22(now);
    }
    // (4) battery
    const b = i.battery || {};
    if (b.empty === true && (st === "flying" || st === "pilotView" || st === "returning")) return t19(now);
    if (b.rth === true && !S.batteryRthUsed && (st === "flying" || st === "pilotView")) return t18(now);
    // (5) the state's own rules / beat clock
    let out = null;
    switch (st) {
      case "deploying":
        out = deployRules(i, dt, now);
        break;
      case "returning":
        out = returningRules(i, dt, now);
        break;
      case "landing":
        out = landingRules(i, now);
        break;
      case "stowing":
        out = S.beat === "settle" ? settleRules(i, now) : beatRules(i, now);
        break;
      case "crashed":
        if (S.beatElapsed + EPS >= C.crashStaticSec) out = t23(now);
        break;
      case "aborting":
        out = settleRules(i, now);
        if (out === null && S.drone === "air" && c.landed === true) {
          S.drone = "ground"; // T28: the soft abort's landing touched down
          out = [A.rotors(0, 0.6)];
        }
        break;
      default:
        break;
    }
    return out === null ? NO_ACTIONS : out;
  }

  /**
   * A fresh JSON-safe copy of the §4.1 model.
   * @returns {object}
   */
  function state() {
    return {
      state: S.state,
      beat: S.beat,
      beatIndex: S.beatIndex,
      beatElapsed: S.beatElapsed,
      since: S.since,
      quick: S.quick,
      speed: S.speed,
      rig: S.rig,
      pendingSkip: S.pendingSkip,
      fpv: S.fpv,
      locked: S.locked,
      drone: S.drone,
      tablet: S.tablet,
      goggles: S.goggles,
      wieldedHidden: S.wieldedHidden,
      held: S.held,
      clipActive: S.clipActive,
      rth: S.rth ? { reason: S.rth.reason, fpv: S.rth.fpv, cancellable: S.rth.cancellable, armed: S.rth.armed, elapsedSec: S.rth.elapsedSec } : null,
      forcedLanding: S.forcedLanding,
      batteryRthUsed: S.batteryRthUsed,
      stowKind: S.stowKind,
      cutFired: { boot: S.cutFired.boot, own: S.cutFired.own, fpv: S.cutFired.fpv },
      eventFired: S.eventFired,
      lastAbort: S.lastAbort ? { reason: S.lastAbort.reason, from: S.lastAbort.from, at: S.lastAbort.at } : null,
    };
  }

  /** Back to idle without actions (dispose only). */
  function reset() {
    S.state = "idle";
    S.since = lastNow;
    clearCycle();
    S.lastAbort = null;
  }

  /**
   * Seconds until a recall in the goggles cuts to the pilot (T30), while it can still be
   * cancelled; NaN otherwise. Allocation-free (the OSD countdown reads it at 10 Hz).
   * @returns {number}
   */
  function returnCutInSec() {
    const r = S.rth;
    if (S.state !== "returning" || r === null || !S.fpv || !r.cancellable) return NaN;
    const left = C.recallGraceSec - r.elapsedSec;
    return left > 0 ? left : 0;
  }

  return { tick, state, reset, returnCutInSec };
}
