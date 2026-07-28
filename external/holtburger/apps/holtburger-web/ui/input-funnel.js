// ui/input-funnel.js — the ONE gameplay keyboard funnel (P-unification, 2026-07-28).
//
// WHY
// ---
// Before this module the client had ~20 independent `keydown` listeners, each
// with its OWN gate:
//
//   index.html:6985   movement keystate      gate: enteredWorld && !isTypingInForm()
//   camera.js:2492    movement keystate #2   gate: !isTypingInForm()
//   camera.js:2543    camera mode toggle     gate: !isTypingInForm()
//   picking.js:1419   attack/charge abort    gate: ev.target tag
//   picking.js:1427   cancel use-on-target   gate: (none)
//   combat-bar.js:779 MagicCombat map        gate: ev.target tag + MAGIC STANCE ONLY
//   spellbook.js:1610 forget-spell           gate: panel mounted + row selected
//   hotbar.js:1047    quickslots             gate: ev.target tag + magic-digit yield
//   …plus every per-panel Escape/Enter handler
//
// Independent gates mean PARTIAL breakage is structural: WASD can work while
// Delete is dead, and nothing in the system notices. That is exactly the live
// symptom this module exists to make impossible. The user's requirement,
// verbatim: "I'd like streamlining here — this ain't it if some keys will
// break. If they break they should all break."
//
// WHAT
// ----
// ONE document-level capture listener. ONE gate. Every gameplay key — movement
// keystate, the MagicCombat map, hotbar quickslots, spellbook actions, target
// cycling, camera keys — is dispatched from inside it, so they share fate:
// poison the funnel and they all die; unpoison and they all live.
//
// Retail precedent: `CInputManager` → `ACCmdInterp::OnAction` is a single
// owner chain (acclient.c:435951 / 717800). `scene3d/input.js`
// (`?inputFunnel`, A14-I1) already collapsed the movement→`setMovementInput`
// AXIS boundary to one owner; this module is the LISTENER half of the same
// idea — one keyboard event owner feeding both the raw keystate consumers and
// the rebindable ACTION registry.
//
// DISPATCH ORDER (per keydown)
//   1. fault-injection seam (see `poison`) — proves shared fate.
//   2. text-entry deference: a focused/targeted INPUT / TEXTAREA / SELECT /
//      contentEditable owns the key. A DETACHED activeElement is ignored
//      (the evtGuard rule, d9a4fd63 — a torn-down panel input must not keep
//      eating keys).
//   3. the ONE gate — index.html injects `() => enteredWorld && !isTypingInForm()`,
//      the same condition the movement dispatcher has always enforced.
//   4. RAW subscribers, all of them, in priority order. These are the
//      keystate-shaped consumers (movement keydown/keyup, camera keys, the
//      attack-abort watcher) that cannot be expressed as a single action.
//   5. ACTIONS, first match wins, in priority order. Each action is resolved
//      through `ui/keymap.js` — user rebinds from Options → Controls included.
//
// Keyup is dispatched to raw-up subscribers WITHOUT the gate (a release must
// always clear keystate, even if the gate closed mid-press — the long-standing
// index.html rule) but WITH the fault seam, so shared fate is honest.
//
// SCOPE — what deliberately does NOT come here
//   Purely-local widget UX: Enter in a form, Escape closing the modal that owns
//   focus, the Options→Controls rebind capture, the F-key panel hotkeys (they
//   must work outside the in-world gate). Those are not gameplay input and a
//   dead funnel legitimately leaves them alive.
//
// FLAG: `?inputFunnelV2=off` restores every legacy listener, byte-identical.
//
// No DOM / three.js dependency at import time — unit-testable under plain node.

import { resolveLocalBinding, matchesBinding } from "./keymap.js";

/** Read `?inputFunnelV2` (DEFAULT-ON — `!== "off"`). Never throws. */
export function readInputFunnelV2Flag(search) {
  try {
    const s =
      typeof search === "string"
        ? search
        : typeof window !== "undefined" && window.location
        ? window.location.search
        : "";
    const v = new URLSearchParams(s).get("inputFunnelV2");
    if (v == null) return true;
    const lc = v.toLowerCase();
    return !(lc === "off" || lc === "0" || lc === "false");
  } catch (_) {
    return true;
  }
}

let _v2 = null;
/** Cached flag accessor (parse once per page load). */
export function inputFunnelV2On() {
  if (_v2 === null) _v2 = readInputFunnelV2Flag();
  return _v2;
}
/** Test seam. */
export function _resetInputFunnelV2ForTest() {
  _v2 = null;
}

/**
 * True when a genuine text-entry context owns this keystroke.
 *
 * Checks BOTH `ev.target` (what the per-site handlers used) and
 * `document.activeElement` (what index.html's `isTypingInForm` used) — the
 * union, so the funnel defers at least as often as every listener it replaces.
 * A detached `activeElement` is ignored (evtGuard rule): a torn-down panel
 * input can never receive the key, so it must not eat it.
 */
export function isTextEntryTarget(ev) {
  const eats = (el) => {
    if (!el || typeof el !== "object") return false;
    const tag = (el.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    return el.isContentEditable === true;
  };
  if (eats(ev?.target)) return true;
  try {
    if (typeof document === "undefined") return false;
    const el = document.activeElement;
    if (!el) return false;
    // Detached (panel torn down mid-focus) — cannot receive keys, ignore.
    if (el.isConnected === false) return false;
    return eats(el);
  } catch (_) {
    return false;
  }
}

/**
 * The single gameplay keyboard funnel.
 *
 * Registration APIs (also surfaced on the P6.1 facade as `client.input`):
 *   - `bindAction(labelHash, defaultBinding, handler, opts)` — rebindable,
 *     resolved through the ONE keymap; first match wins.
 *   - `bindRaw(name, handler, opts)` — every gated keydown (keystate shapes).
 *   - `bindRawUp(name, handler, opts)` — every keyup (ungated).
 * All three return an `unbind()` closure.
 */
export class InputFunnel {
  constructor() {
    this._gate = null;
    /** @type {null|"throw"|"gate"} fault-injection seam — see `poison`. */
    this._fault = null;
    /** @type {Array<object>} */
    this.actions = [];
    /** @type {Array<object>} */
    this.raws = [];
    /** @type {Array<object>} */
    this.rawUps = [];
    this.installed = false;
    this._seq = 0;
    // Reachability counters (`__diag.input()` / `window.__inputFunnelStats`).
    this.stats = {
      keydowns: 0,
      keyups: 0,
      deferredTyping: 0,
      gateClosed: 0,
      rawRuns: 0,
      dispatched: 0,
      unmatched: 0,
      handlerErrors: 0,
      faults: 0,
    };
    this.lastDispatch = null;
  }

  /** index.html injects `() => enteredWorld && !isTypingInForm()`. */
  setGate(fn) {
    this._gate = typeof fn === "function" ? fn : null;
    return this;
  }

  /** The ONE gate. Absent gate = allow (pre-injection boot window). */
  gateOpen() {
    if (this._fault === "gate") return false;
    if (!this._gate) return true;
    try {
      return !!this._gate();
    } catch (_) {
      // A throwing gate is a closed gate — never let it kill dispatch itself.
      return false;
    }
  }

  /**
   * Register a rebindable action.
   *
   * @param {string} labelHash `ui/keymap.js` LOCAL_ACTION_IDS entry ("0xFF0000xx").
   * @param {string|object} defaultBinding KeyboardEvent.code, or a
   *   `{code, ctrl, shift, alt, meta}` shape for modifier defaults.
   * @param {(ev: KeyboardEvent) => void} handler
   * @param {{when?: () => boolean, priority?: number, source?: string}} [opts]
   *   `when` is the action's own scope predicate (e.g. magic stance, panel
   *   mounted). It narrows WHICH action wins — it is NOT a second gate: a
   *   dead funnel still kills the action.
   * @returns {() => void} unbind
   */
  bindAction(labelHash, defaultBinding, handler, opts = {}) {
    if (typeof handler !== "function") return () => {};
    const entry = {
      labelHash,
      defaultBinding,
      handler,
      when: typeof opts.when === "function" ? opts.when : null,
      priority: opts.priority | 0,
      source: opts.source || "?",
      seq: this._seq++,
      count: 0,
    };
    this.actions.push(entry);
    this._sort(this.actions);
    return () => {
      const i = this.actions.indexOf(entry);
      if (i >= 0) this.actions.splice(i, 1);
    };
  }

  /** Register a raw gated-keydown subscriber (keystate shapes). */
  bindRaw(name, handler, opts = {}) {
    return this._bindRawTo(this.raws, name, handler, opts);
  }

  /** Register a raw keyup subscriber (ungated — releases always clear). */
  bindRawUp(name, handler, opts = {}) {
    return this._bindRawTo(this.rawUps, name, handler, opts);
  }

  _bindRawTo(list, name, handler, opts) {
    if (typeof handler !== "function") return () => {};
    const entry = {
      name: name || "?",
      handler,
      priority: opts.priority | 0,
      seq: this._seq++,
      count: 0,
    };
    list.push(entry);
    this._sort(list);
    return () => {
      const i = list.indexOf(entry);
      if (i >= 0) list.splice(i, 1);
    };
  }

  _sort(list) {
    list.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
  }

  _run(entry, ev, label) {
    try {
      entry.handler(ev);
      return true;
    } catch (e) {
      this.stats.handlerErrors += 1;
      // One misbehaving consumer must not kill the rest of the funnel — the
      // evtGuard per-event-isolation rule applied to input.
      console.warn(`[inputFunnel] ${label} handler threw:`, e);
      return false;
    }
  }

  /**
   * The ONE keydown entry point.
   * @returns {boolean} true iff an action matched and ran.
   */
  handleKeyDown(ev) {
    this.stats.keydowns += 1;
    // (1) Fault-injection seam — the shared-fate proof. See `poison`.
    if (this._fault === "throw") {
      this.stats.faults += 1;
      throw new Error("[inputFunnel] fault-injected dispatch failure");
    }
    // (2) Text entry owns the key.
    if (isTextEntryTarget(ev)) {
      this.stats.deferredTyping += 1;
      return false;
    }
    // (3) The ONE gate.
    if (!this.gateOpen()) {
      this.stats.gateClosed += 1;
      return false;
    }
    // (4) Raw subscribers — all of them.
    for (const r of this.raws.slice()) {
      r.count += 1;
      this.stats.rawRuns += 1;
      this._run(r, ev, `raw:${r.name}`);
    }
    // (5) Actions — first match wins, resolved through the ONE keymap.
    for (const a of this.actions.slice()) {
      if (a.when) {
        let ok = false;
        try {
          ok = !!a.when();
        } catch (_) {
          ok = false;
        }
        if (!ok) continue;
      }
      let binding = null;
      try {
        binding = resolveLocalBinding(a.labelHash, a.defaultBinding);
      } catch (_) {
        continue;
      }
      if (!binding || !binding.code) continue;
      if (!matchesBinding(ev, binding)) continue;
      a.count += 1;
      this.stats.dispatched += 1;
      this.lastDispatch = {
        labelHash: a.labelHash,
        source: a.source,
        code: ev.code,
        at: Date.now(),
      };
      this._run(a, ev, `action:${a.source}:${a.labelHash}`);
      try {
        ev.preventDefault();
      } catch (_) {}
      return true;
    }
    this.stats.unmatched += 1;
    return false;
  }

  /** The ONE keyup entry point (ungated — a release must always clear). */
  handleKeyUp(ev) {
    this.stats.keyups += 1;
    if (this._fault === "throw") {
      this.stats.faults += 1;
      throw new Error("[inputFunnel] fault-injected dispatch failure");
    }
    for (const r of this.rawUps.slice()) {
      r.count += 1;
      this._run(r, ev, `rawUp:${r.name}`);
    }
  }

  /** Install the ONE document-level capture listener pair. Idempotent. */
  install(doc) {
    const d = doc ?? (typeof document !== "undefined" ? document : null);
    if (!d || this.installed) return this;
    this.installed = true;
    this._onDown = (ev) => this.handleKeyDown(ev);
    this._onUp = (ev) => this.handleKeyUp(ev);
    d.addEventListener("keydown", this._onDown, true);
    d.addEventListener("keyup", this._onUp, true);
    return this;
  }

  /**
   * Fault injection (agent-O method) — the user's acceptance criterion.
   *
   *   `poison("throw")` — the funnel throws before any dispatch. WASD, Delete
   *     and the spellbook keys all die together.
   *   `poison("gate")`  — the ONE gate is forced closed. Same shared death,
   *     via the gate rather than an exception.
   *   `unpoison()`      — all of them live again.
   *
   * If the keys could die INDEPENDENTLY, this switch could not exist.
   */
  poison(mode = "throw") {
    this._fault = mode === "gate" ? "gate" : "throw";
    return this._fault;
  }
  unpoison() {
    this._fault = null;
    return true;
  }

  /** `__diag.input()` payload. */
  snapshot() {
    return {
      v2: inputFunnelV2On(),
      installed: this.installed,
      gate: { injected: !!this._gate, open: this.gateOpen() },
      fault: this._fault,
      actions: this.actions.length,
      raws: this.raws.length,
      rawUps: this.rawUps.length,
      lastDispatch: this.lastDispatch,
      stats: { ...this.stats },
      perAction: this.actions
        .filter((a) => a.count > 0)
        .map((a) => ({
          labelHash: a.labelHash,
          source: a.source,
          count: a.count,
        }))
        .sort((a, b) => b.count - a.count),
      perRaw: this.raws.map((r) => ({ name: r.name, count: r.count })),
    };
  }
}

let _shared = null;
/** The process-wide funnel singleton (also `window.__inputFunnel`). */
export function getInputFunnel() {
  if (_shared) return _shared;
  _shared = new InputFunnel();
  if (typeof window !== "undefined") {
    window.__inputFunnel = _shared;
    window.__inputFunnelStats = _shared.stats;
  }
  return _shared;
}

/** Test seam — drop the singleton. */
export function _resetInputFunnelForTest() {
  _shared = null;
}
