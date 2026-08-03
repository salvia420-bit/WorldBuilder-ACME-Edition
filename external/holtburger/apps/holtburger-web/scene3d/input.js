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
//   - The flag `?inputFunnel` (DEFAULT-ON — `!== "off"` reader; `=off`
//     disables) is the ONLY thing that routes
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

// ---------------------------------------------------------------------
// A14-I3 (?retailRunKeys=on) — hold-key/options run parity.
//
// Survey: docs/2026-06-11-unification-survey/agents/A14-input-to-motion.md
// §4 Stage I3 (+ §3 rows 5/8); W5-REMAINDER row A14-I3.
//
// Retail computes the effective run gait as Shift XOR the persisted
// "Toggle Run" character option: `CommandInterpreter::SetHoldRun`
// derives `(hold_run == 0) != (GetToggleRunOption() == 0)` — i.e.
// run = shiftHeld XOR optionOn (acclient.c:716978 / 0x6B3370 body).
// The option is retail's CharacterOption `RunAsDefaultMovement`
// (0x0A) — already surfaced by plugins/options-panel.js ("Run as
// default movement", Movement & Camera section) and persisted both
// server-side (ACE CharacterOptions1) and in the panel's localStorage
// cache. Ours hardcodes run-by-default (`run = !shift`) — equivalent
// to the option permanently ON with no way to flip it.
//
// `resolveRunModifier` is the ONE helper all four run-computation
// sites consult (index.html prediction + dispatch blocks, camera.js
// _advancePrediction + computeMovementFromKeys):
//   - flag OFF (`?retailRunKeys=off`): legacy `!shiftHeld`, byte-identical.
//     (This line used to say "OFF (default)". It is not: the reader below is
//     the `!== "off"` idiom, so an ABSENT param reads ON, and
//     docs/url-flags.md:779 lists the flag as default **on**. The XOR branch
//     ships on every session. Comment corrected — no behaviour touched.
//     Note the reader's `catch` arm returns false, i.e. the OPPOSITE polarity
//     to its success path; left as-is deliberately, since a URLSearchParams
//     throw means there is no location to read a preference from.)
//   - flag ON: `shiftHeld XOR toggleRunOption` — with the option ON
//     (its fallback default) this is IDENTICAL to legacy; flipping
//     the option in Options → Character gives retail walk-by-default.
//
// The autorun half (toggle key → wasm `setAutoRun`, retail
// `ToggleAutoRun`/`ApplyCurrentMovement` auto_run branch,
// acclient.c:717657/:717027-717064) lives in index.html's keydown
// handler + the wasm MovementSystem; this module only owns the flag
// parse + the option read.
// ---------------------------------------------------------------------

/** CharacterOption index — `RunAsDefaultMovement` (retail ToggleRun),
 *  `crates/holtburger-common/src/character.rs:128`. */
export const RUN_AS_DEFAULT_MOVEMENT_OPTION = 0x0a;

// options-panel.js localStorage cache shape (LS_CHAR_OPTIONS_KEY).
const LS_CHAR_OPTIONS_KEY = "holtburger_character_options_v1";

let _retailRunKeysOn = null;

/** Read `?retailRunKeys` (DEFAULT-ON — `!== "off"`; cached; defensive — never throw). */
export function readRetailRunKeysFlag(search) {
  try {
    const s =
      typeof search === "string"
        ? search
        : typeof window !== "undefined" && window.location
        ? window.location.search
        : "";
    return new URLSearchParams(s).get("retailRunKeys")?.toLowerCase() !== "off";
  } catch (_) {
    return false;
  }
}

/** Cached module-level flag accessor (parse once per page load). */
export function retailRunKeysOn() {
  if (_retailRunKeysOn === null) _retailRunKeysOn = readRetailRunKeysFlag();
  return _retailRunKeysOn;
}

/** Test seam — reset the cached flag (and the LS-cache TTL below). */
export function _resetRetailRunKeysForTest() {
  _retailRunKeysOn = null;
  _lsOptionCache = undefined;
  _lsOptionCacheAt = 0;
}

// TTL cache for the localStorage fallback so the per-rAF run
// computation doesn't JSON-parse localStorage at 60 Hz.
let _lsOptionCache; // undefined = not cached; null = absent; bool = value
let _lsOptionCacheAt = 0;
const LS_OPTION_TTL_MS = 500;

function _readToggleRunOptionFromLocalStorage() {
  const now = Date.now();
  if (_lsOptionCache !== undefined && now - _lsOptionCacheAt < LS_OPTION_TTL_MS) {
    return _lsOptionCache;
  }
  _lsOptionCacheAt = now;
  _lsOptionCache = null;
  try {
    const raw =
      typeof localStorage !== "undefined"
        ? localStorage.getItem(LS_CHAR_OPTIONS_KEY)
        : null;
    if (raw) {
      const parsed = JSON.parse(raw);
      const v = parsed?.[String(RUN_AS_DEFAULT_MOVEMENT_OPTION)];
      if (typeof v === "boolean") _lsOptionCache = v;
    }
  } catch (_) {
    /* quota / privacy mode / malformed JSON — fall through to default */
  }
  return _lsOptionCache;
}

/**
 * The persisted ToggleRun option (retail `RunAsDefaultMovement`,
 * CharacterOption 0x0A). Read priority:
 *   1. wasm `isCharacterOptionEnabled(0x0A)` (server-authoritative,
 *      hydrated from PlayerDescription) — typeof-guarded, a stale pkg
 *      falls through;
 *   2. options-panel localStorage cache (last user click);
 *   3. default TRUE (run-by-default — preserves today's behavior when
 *      the option has never been touched).
 *
 * @param {object} [handle] SessionHandle; defaults to window.__sessionHandle.
 */
export function toggleRunOptionEnabled(handle) {
  const h =
    handle ??
    (typeof window !== "undefined" ? window.__sessionHandle : null);
  if (h && typeof h.isCharacterOptionEnabled === "function") {
    try {
      return !!h.isCharacterOptionEnabled(RUN_AS_DEFAULT_MOVEMENT_OPTION);
    } catch (_) {
      /* unknown index on an older bundle — fall through */
    }
  }
  const cached = _readToggleRunOptionFromLocalStorage();
  if (typeof cached === "boolean") return cached;
  return true;
}

/**
 * The single run-modifier resolution (all four run sites call this).
 *
 * @param {boolean} shiftHeld current Shift keystate
 * @param {object} [handle] SessionHandle for the option read
 * @returns {boolean} effective run flag
 */
export function resolveRunModifier(shiftHeld, handle) {
  if (!retailRunKeysOn()) return !shiftHeld; // legacy run-by-default
  // Retail SetHoldRun: run = shift XOR ToggleRun option
  // (acclient.c:716978 / 0x6B3370).
  return !!shiftHeld !== !!toggleRunOptionEnabled(handle);
}

/** Read `?inputFunnel` (DEFAULT-ON — `!== "off"`) once (defensive — never throw at import time). */
export function readInputFunnelFlag(search) {
  try {
    const s =
      typeof search === "string"
        ? search
        : typeof window !== "undefined" && window.location
        ? window.location.search
        : "";
    return new URLSearchParams(s).get("inputFunnel")?.toLowerCase() !== "off";
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
  /**
   * ⚠ RETIRED IN PRACTICE — NOT WIRED ON ANY SHIPPED PATH (2026-08-03 review).
   *
   * Both call sites exclude themselves when `?cmdInterp` is on:
   *   index.html   `if (!CMD_INTERP_ON && sig !== lastInputSig) { … }`
   *   camera.js    `if (CMD_INTERP_ON) { … } else if (this._inputFunnelOn) { … }`
   * and docs/url-flags.md lists BOTH `inputFunnel` (row 330) and `cmdInterp`
   * (row 778) as default-ON. So on the shipped default lane this method never
   * runs: `dispatchCount` below is structurally pinned at 0 and `lastSig` at
   * null, and any assertion gating on `dispatchCount > 0` can never pass.
   *
   * The funnel's job — one owner for the wasm `setMovementInput` boundary so
   * the rAF dispatcher and the camera dispatcher cannot stomp each other — is
   * now done by cmdInterp's per-edge key forwarding instead. The flag is
   * therefore dead weight on the default path and live only under
   * `?cmdInterp=off`.
   *
   * DELIBERATELY NOT CHANGED HERE: retiring `?inputFunnel` (or flipping either
   * default) is a shipped-behaviour decision for the owner, not a review fix.
   * This note exists so the next reader does not spend an afternoon wondering
   * why a default-ON module's counters are flat. See also the `?cmdInterp=off`
   * path, which is the only configuration that exercises anything below.
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
