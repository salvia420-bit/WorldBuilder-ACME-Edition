// scene3d/input.js — single JS InputController (A14-I1).
//
// Survey item: docs/2026-06-11-unification-survey/agents/A14-input-to-motion.md
// §3 row 1 (SPLIT-BRAIN, 5 sites) + §4 Stage I1.
//
// Retail funnels ALL player movement input through ONE owner chain
// (`CInputManager` → `ACCmdInterp::OnAction` → `ACCmdInterp::SetMotion` →
// `CommandInterpreter::MovePlayer`, acclient.c:435951 / 717800). Ours runs
// TWO independent keystate trackers (index.html:8530 `keyState` and
// camera.js:328 `this.keys`) plus several dispatcher families all calling
// the same wasm `setMovementInput` boundary, each deduping against its OWN
// `lastInputSig` so cross-site stomps aren't detected and the orbit-mode
// suppression exists on only one path.
//
// Stage I1 collapses the keyboard→axes→`setMovementInput` funnel to ONE
// owner (this module, the `ACCmdInterp` analog) WITHOUT moving the synthetic
// movers (picking.js charge/turn-to-face — that is Stage I2, out of scope).
//
// Behavior contract:
//   - The flag `?inputFunnel=on` (default OFF) is the ONLY thing that routes
//     either legacy site through this controller. With it OFF, both legacy
//     `setMovementInput` call sites (index.html rAF block + camera.js
//     `_dispatchMovement`) run exactly as before — byte-identical default
//     behavior, no extra dispatch.
//   - With it ON, the controller owns the SINGLE `setMovementInput` call:
//     both legacy sites stop calling `setMovementInput` directly and instead
//     ask the controller to dispatch, deduped against ONE shared signature so
//     a second site cannot stomp the first with an identical-or-stale axis.
//   - The controller does NOT own keystate capture (that stays in the two
//     listener sets for now — moving them is a follow-on inside this stage's
//     scope but kept minimal here), nor jump (jump keydown/keyup stay in
//     index.html unchanged).
//
// Policy seams (who contributes what), matching the report's §4 mapping:
//   - camera.js contributes a `movementPolicy(rawAxes)` — orbit-suppress
//     (returns null → park on Ready) / topDown world-fixed / follow
//     passthrough. Injected via `setMovementPolicy`. Absent (e.g. 2D path)
//     means passthrough.
//   - index.html contributes the `inputGate()` — `enteredWorld && !typing`.
//     Injected via `setInputGate`. Absent means allow (the wasm side rejects
//     pre-EnteredWorld anyway).
//
// This module has NO three.js / DOM dependency so it is unit-testable under
// plain `node`.

/** Sign-clamp with the same dead-zone as camera.js `clampSign`. */
export function clampSign(v) {
  if (v > 1e-3) return 1;
  if (v < -1e-3) return -1;
  return 0;
}

/** Read `?inputFunnel=on` once (defensive — never throw at import time). */
export function readInputFunnelFlag(search) {
  try {
    const s =
      typeof search === "string"
        ? search
        : typeof window !== "undefined" && window.location
        ? window.location.search
        : "";
    return new URLSearchParams(s).get("inputFunnel")?.toLowerCase() === "on";
  } catch (_) {
    return false;
  }
}

/**
 * The single movement-input funnel.
 *
 * One keystate-derived axis snapshot in, at most one `setMovementInput`
 * call out per change, deduped against a single shared signature.
 */
export class InputController {
  constructor() {
    // Single shared dispatch signature (the cross-site stomp guard the
    // per-site `lastInputSig` copies could never provide).
    this.lastSig = null;
    // Injected policy/gate (see module header). Null = passthrough / allow.
    this._policy = null;
    this._gate = null;
    // Telemetry for the headless asserts + dev console.
    this.dispatchCount = 0;
    // True when the LAST resolve suppressed motion (orbit). Lets the caller
    // park the rig on Ready exactly once on the transition into suppression.
    this.suppressed = false;
  }

  /** camera.js injects orbit-suppress / topDown / follow mapping here. */
  setMovementPolicy(fn) {
    this._policy = typeof fn === "function" ? fn : null;
  }

  /** index.html injects `() => enteredWorld && !isTypingInForm()` here. */
  setInputGate(fn) {
    this._gate = typeof fn === "function" ? fn : null;
  }

  /**
   * Resolve the raw keystate-derived tristate axes through the camera policy.
   *
   * @param {{forward:number,strafe:number,turn:number,run:boolean}} raw
   * @returns {null|{forward:number,strafe:number,turn:number,run:boolean}}
   *   null = motion suppressed (orbit free-look). Otherwise the
   *   policy-mapped, sign-clamped player-local axes.
   */
  resolveAxes(raw) {
    let axes = raw;
    if (this._policy) {
      // Policy may transform (topDown world-fixed) or suppress (orbit→null).
      axes = this._policy(raw);
    }
    if (!axes) {
      this.suppressed = true;
      return null;
    }
    this.suppressed = false;
    return {
      forward: clampSign(axes.forward),
      strafe: clampSign(axes.strafe),
      turn: clampSign(axes.turn),
      run: !!axes.run,
    };
  }

  /** `forward,strafe,turn,run` — the dedup key (matches the legacy format). */
  static signature(axes) {
    if (!axes) return "suppressed";
    return `${axes.forward},${axes.strafe},${axes.turn},${axes.run}`;
  }

  /**
   * The ONE `setMovementInput` boundary. Resolves `raw` through the policy,
   * applies the gate, and — only if the resolved signature changed — calls
   * `handle.setMovementInput(...)` exactly once.
   *
   * @returns {{dispatched:boolean, suppressed:boolean,
   *   axes:(null|object), sig:string}}
   *   `dispatched` is true iff `setMovementInput` was actually called this
   *   time (signature changed AND not suppressed AND gate allowed).
   */
  dispatch(handle, raw) {
    const axes = this.resolveAxes(raw);
    const sig = InputController.signature(axes);
    const sigChanged = sig !== this.lastSig;
    // Always advance the shared signature so a later site with the SAME axes
    // is recognised as a no-op (cross-site stomp detection). We advance even
    // when suppressed/gated so the next genuine change re-fires.
    this.lastSig = sig;

    if (axes === null) {
      // Orbit suppression — the caller parks the rig on Ready; no wasm call.
      return { dispatched: false, suppressed: true, axes: null, sig };
    }
    const gateOk = this._gate ? !!this._gate() : true;
    if (!sigChanged || !gateOk) {
      return { dispatched: false, suppressed: false, axes, sig };
    }
    if (handle && typeof handle.setMovementInput === "function") {
      try {
        handle.setMovementInput(axes.forward, axes.strafe, axes.turn, axes.run);
        this.dispatchCount += 1;
        return { dispatched: true, suppressed: false, axes, sig };
      } catch (e) {
        // Wasm rejects pre-EnteredWorld; the next change retries. Roll the
        // signature back so the retry is recognised as a change.
        this.lastSig = null;
        return { dispatched: false, suppressed: false, axes, sig, error: e };
      }
    }
    return { dispatched: false, suppressed: false, axes, sig };
  }
}

// Shared singleton — both legacy sites talk to the SAME controller when the
// flag is on, so the dedup signature is genuinely shared (the whole point of
// the funnel). Lazily exposed on `window` for cross-bundle access (index.html
// is a separate script context from the scene3d ES modules).
let _shared = null;
export function getInputController() {
  if (_shared) return _shared;
  _shared = new InputController();
  if (typeof window !== "undefined") {
    window.__inputController = _shared;
    window.__inputFunnelOn = readInputFunnelFlag();
  }
  return _shared;
}
