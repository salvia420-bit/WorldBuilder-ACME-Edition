// tests/escape_action.test.mjs — combat-magic-4 (2026-10-13): the in-world
// Escape (ui/escape_action.js), retail ClientUISystem::OnAction case 0x27
// (acclient.c:402170-402224).
//
//   - The decomp order, after WebAC tests/verify-decomp-escape-key-action.ts
//     (AGPL-3.0) cases 1, 2, 3a-3c and 4a-4c, plus holtburger's 3c (no
//     options toggle: nothing happens).
//   - The RepeatAttackInProgress (:407523) and AbortAutomaticAttack (:407958)
//     gates, wired to the real combat-magic-2 repeat state.
//   - The central Escape-consumed signal: the real InputFunnel on a small
//     simulated DOM event path (window → document → body → panel, capture,
//     target and bubble phases, per-target listener cloning, stopPropagation)
//     with a fake MutationObserver. An Escape a panel used (preventDefault,
//     stopPropagation, a DOM change, the explicit mark) does nothing in-world.
//   - A deselect through the action sets the willingly-lost mark, so a real
//     EntityManager in melee does not auto-target (tests/auto_target.test.mjs
//     harness).
//
// Run from apps/holtburger-web/:  node tests/escape_action.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.__playEffectVfxBound = true;
globalThis.window.__spellShapePreviewBound = true;

const {
  escapeAction, ESCAPE_OUTCOME, ACTION_INTERRUPTED_TEXT, escapeActionEnabled,
  repeatAttackInProgress, automaticAttackLive, isStandingStill, heldMovementKey,
  jumpChargePending, cancelJumpCharge, isInWorldEscape, markEscapeConsumed,
  escapeConsumedReason, createEscapeConsumedGate, installEscapeAction, ESCAPE_RAW_PRIORITY,
} = await import("../ui/escape_action.js");
const { InputFunnel } = await import("../ui/input-funnel.js");
const { createAttackRepeatState } = await import("../ui/attack_repeat_state.js");
const { CHAT_CATEGORY_TRANSIENT } = await import("../ui/spew_box.js");

// ── the pure order (WebAC verify-decomp-escape-key-action.ts) ─────────────
function deps(over = {}) {
  const calls = [];
  const d = {
    jumpCharging: () => false,
    cancelJumpCharge: () => { calls.push("cancelJump"); },
    hasUiFocus: () => false,
    relinquishUiFocus: () => { calls.push("relinquish"); },
    isStandingStill: () => true,
    repeatAttackInProgress: () => false,
    abortAutomaticAttack: () => { calls.push("abort"); },
    targetModePending: () => false,
    clearTargetMode: () => { calls.push("clearTargetMode"); },
    selectedId: () => 0,
    toggleGameplayOptions: () => { calls.push("toggleOptions"); },
    deselectWillingly: () => { calls.push("deselect"); },
    stopCompletely: () => { calls.push("stop"); },
    notice: (t) => { calls.push(`notice:${t}`); },
    ...over,
  };
  return { d, calls };
}

test("1. a jump charge is cancelled and nothing else happens", () => {
  const { d, calls } = deps({ jumpCharging: () => true, hasUiFocus: () => true, selectedId: () => 5 });
  assert.equal(escapeAction(d), ESCAPE_OUTCOME.CANCEL_JUMP);
  assert.deepEqual(calls, ["cancelJump"]);
});

test("2. a focused UI element gives up focus and nothing else happens", () => {
  const { d, calls } = deps({ hasUiFocus: () => true, selectedId: () => 5 });
  assert.equal(escapeAction(d), ESCAPE_OUTCOME.RELINQUISH_FOCUS);
  assert.deepEqual(calls, ["relinquish"]);
});

test("3a. standing with nothing selected toggles the options page (when wired) — no deselect", () => {
  const { d, calls } = deps();
  assert.equal(escapeAction(d), ESCAPE_OUTCOME.TOGGLE_OPTIONS);
  assert.deepEqual(calls, ["toggleOptions"]);
});

test("3a (holtburger). with no options toggle wired, nothing happens", () => {
  const { d, calls } = deps({ toggleGameplayOptions: undefined });
  assert.equal(escapeAction(d), ESCAPE_OUTCOME.NONE);
  assert.deepEqual(calls, []);
});

test("3b. standing with a selection deselects (willingly) and does not touch the options", () => {
  const { d, calls } = deps({ selectedId: () => 0x80000001 });
  assert.equal(escapeAction(d), ESCAPE_OUTCOME.DESELECT);
  assert.deepEqual(calls, ["deselect"]);
});

test("3c. a pending target mode (use-on-target) only clears the target mode", () => {
  const { d, calls } = deps({ targetModePending: () => true, selectedId: () => 7 });
  assert.equal(escapeAction(d), ESCAPE_OUTCOME.CLEAR_TARGET_MODE);
  assert.deepEqual(calls, ["clearTargetMode"]);
});

test("4a. moving: stop completely and say 'Action interrupted'; the selection stays", () => {
  const { d, calls } = deps({ isStandingStill: () => false, selectedId: () => 5, targetModePending: () => true });
  assert.equal(escapeAction(d), ESCAPE_OUTCOME.STOP);
  assert.deepEqual(calls, ["stop", `notice:${ACTION_INTERRUPTED_TEXT}`]);
});

test("4b. standing but repeat-attacking: stop and abort the automatic attack, no notice", () => {
  const { d, calls } = deps({ repeatAttackInProgress: () => true, selectedId: () => 5 });
  assert.equal(escapeAction(d), ESCAPE_OUTCOME.STOP);
  assert.deepEqual(calls, ["stop", "abort"]);
});

test("4c. moving and repeat-attacking: stop, notice, abort", () => {
  const { d, calls } = deps({ isStandingStill: () => false, repeatAttackInProgress: () => true });
  assert.equal(escapeAction(d), ESCAPE_OUTCOME.STOP);
  assert.deepEqual(calls, ["stop", `notice:${ACTION_INTERRUPTED_TEXT}`, "abort"]);
});

test("the notice is the retail 0x1A line, 'Action interrupted'", () => {
  assert.equal(ACTION_INTERRUPTED_TEXT, "Action interrupted");
  assert.equal(CHAT_CATEGORY_TRANSIENT, 9);
});

test("escapeActionEnabled: default on; off / 0 / false disable", () => {
  assert.equal(escapeActionEnabled(""), true);
  assert.equal(escapeActionEnabled("?escapeAction=on"), true);
  for (const v of ["off", "0", "false", "OFF"]) {
    assert.equal(escapeActionEnabled(`?escapeAction=${v}`), false, v);
  }
});

// ── the gates ─────────────────────────────────────────────────────────────
test("RepeatAttackInProgress needs Repeat Attacks and a swing in flight or a building bar", () => {
  assert.equal(repeatAttackInProgress({ autoRepeat: false, attackInProgress: true, building: true }), false);
  assert.equal(repeatAttackInProgress({ autoRepeat: true }), false);
  assert.equal(repeatAttackInProgress({ autoRepeat: true, attackInProgress: true }), true);
  assert.equal(repeatAttackInProgress({ autoRepeat: true, building: true }), true);
});

test("AbortAutomaticAttack's gate: pending / building / in progress / repeating", () => {
  assert.equal(automaticAttackLive({}), false);
  for (const k of ["responsePending", "building", "attackInProgress", "repeatAttacking"]) {
    assert.equal(automaticAttackLive({ [k]: true }), true, k);
  }
});

test("isStandingStill: on the ground, no movement key, no autorun, no server MoveTo / TurnTo", () => {
  assert.equal(isStandingStill({}), true);
  assert.equal(isStandingStill({ onGround: false }), false);
  assert.equal(isStandingStill({ movementKeyHeld: true }), false);
  assert.equal(isStandingStill({ autoRun: true }), false);
  assert.equal(isStandingStill({ autonomousMotion: (1 << 31) | 2 }), false);
});

test("heldMovementKey reads the funnel's held-key ledger by physical key", () => {
  const f = { _held: new Map([["Escape", { key: "Escape" }]]) };
  assert.equal(heldMovementKey(f), false);
  f._held.set("KeyW", { key: "z" }); // AZERTY: physical W types z
  assert.equal(heldMovementKey(f), true);
  assert.equal(heldMovementKey(null), false);
});

test("isInWorldEscape: plain fresh Escape only", () => {
  assert.equal(isInWorldEscape({ key: "Escape" }), true);
  assert.equal(isInWorldEscape({ key: "Escape", repeat: true }), false);
  assert.equal(isInWorldEscape({ key: "Escape", shiftKey: true }), false, "Shift+Escape is another retail action");
  assert.equal(isInWorldEscape({ key: "Escape", ctrlKey: true }), false);
  assert.equal(isInWorldEscape({ key: "w" }), false);
});

// ── jump charge (step 1) ──────────────────────────────────────────────────
function jumpDoc() {
  const classes = new Set(["hb-jc-active", "hb-jc-full"]);
  const fill = { style: { width: "62%" } };
  const bar = {
    classList: { remove: (...c) => c.forEach((x) => classes.delete(x)) },
    querySelector: (s) => (s === ".hb-jc-fill" ? fill : null),
  };
  return { classes, fill, doc: { getElementById: (id) => (id === "hb-jump-charge" ? bar : null) } };
}

test("jumpChargePending: the wasm clock level (a refused press arms nothing), or the legacy timestamp", () => {
  assert.equal(jumpChargePending({}, {}), false);
  assert.equal(jumpChargePending({ __jumpKeydownTs: 123 }, {}), true);
  assert.equal(jumpChargePending({ __jumpChargeActive: true }, { jumpChargeLevel: () => 0.4 }), true);
  assert.equal(jumpChargePending({ __jumpChargeActive: true }, { jumpChargeLevel: () => 0 }), false);
  assert.equal(jumpChargePending({ __jumpChargeActive: true }, {}), true, "stale pkg/: trust the marker");
});

test("cancelJumpCharge aborts the wasm charge, drops the legacy clock and hides the bar", () => {
  const calls = [];
  const h = { jumpChargeAbort: () => calls.push("abort"), jumpChargeCancel: () => calls.push("cancel") };
  const { classes, fill, doc } = jumpDoc();
  const win = { __jumpChargeActive: true, __jumpKeydownTs: 5 };
  assert.equal(cancelJumpCharge(win, h, doc), true);
  assert.deepEqual(calls, ["abort", "cancel"]);
  assert.equal(win.__jumpChargeActive, false);
  assert.equal(win.__jumpKeydownTs, null);
  assert.equal(classes.size, 0);
  assert.equal(fill.style.width, "0%");
});

// ── the wired action (installEscapeAction.runOnce) ────────────────────────
function wiredWorld(over = {}) {
  const log = [];
  const win = {
    location: { search: "" },
    __combatBarState: { autoRepeat: true, attackInProgress: false, powerLevel: 1 },
    __appendChatLine: (text, cat) => log.push(["chat", text, cat]),
    __useTargeting: null,
    addEventListener() {},
    removeEventListener() {},
    ...over.win,
  };
  let selected = over.selected ?? 0x80000a01;
  const em = {
    getSelectedTarget: () => selected,
    deselectTarget: () => { log.push(["deselect", selected]); selected = 0; },
  };
  const handle = {
    getLocalPlayerPose: () => ({ isOnGround: over.onGround ?? true, free() { log.push(["poseFree"]); } }),
    localAutonomousMotion: () => over.autonomousMotion ?? 0,
    setAutoRun: (on) => log.push(["setAutoRun", on]),
    ...over.handle,
  };
  const cancels = [];
  const rs = over.repeatState === null ? null : createAttackRepeatState({
    autoRepeat: () => !!win.__combatBarState.autoRepeat,
    getSlider: () => 1,
  });
  const charge = over.charge ?? null;
  const ea = installEscapeAction({
    funnel: over.funnel ?? null,
    sessionHandle: handle,
    getEntityManager: () => em,
    stopMovement: () => log.push(["stopMovement"]),
    getRepeatState: () => rs,
    sendCancelAttack: () => { cancels.push(1); return over.cancelThrottled !== true; },
    getAttackCharge: () => charge,
    win,
    doc: null,
  });
  return { ea, win, em, handle, rs, log, cancels, sel: () => selected };
}

test("wired, standing, idle: Escape deselects; nothing is sent", () => {
  const w = wiredWorld();
  assert.equal(w.ea.runOnce(), ESCAPE_OUTCOME.DESELECT);
  assert.equal(w.sel(), 0);
  assert.equal(w.cancels.length, 0);
  assert.ok(w.log.some((e) => e[0] === "poseFree"), "the wasm pose box is freed");
  assert.equal(w.win.__escapeAction.last.outcome, ESCAPE_OUTCOME.DESELECT);
});

test("wired, standing, a use-on-target pending: only the target mode clears", () => {
  let cancelled = 0;
  const w = wiredWorld({ win: { __useTargeting: { pending: { itemGuid: 9 }, cancel() { cancelled += 1; this.pending = null; } } } });
  assert.equal(w.ea.runOnce(), ESCAPE_OUTCOME.CLEAR_TARGET_MODE);
  assert.equal(cancelled, 1);
  assert.notEqual(w.sel(), 0, "the selection stays");
});

test("wired, moving (airborne): stop + the 0x1A 'Action interrupted' line; the selection and the target mode stay", () => {
  let cancelled = 0;
  const w = wiredWorld({
    onGround: false,
    win: { __autoRunOn: true, __useTargeting: { pending: { itemGuid: 9 }, cancel() { cancelled += 1; } } },
  });
  assert.equal(w.ea.runOnce(), ESCAPE_OUTCOME.STOP);
  assert.deepEqual(w.log.filter((e) => e[0] === "chat"), [["chat", "Action interrupted", CHAT_CATEGORY_TRANSIENT]]);
  assert.ok(w.log.some((e) => e[0] === "stopMovement"), "the client move ends");
  assert.ok(w.log.some((e) => e[0] === "setAutoRun" && e[1] === false), "autorun ends (SetAutoRun(0, 0))");
  assert.equal(w.win.__autoRunOn, false);
  assert.notEqual(w.sel(), 0);
  assert.equal(cancelled, 0);
});

test("wired, a server MoveTo running counts as moving", () => {
  const w = wiredWorld({ autonomousMotion: ((1 << 31) | 2) >>> 0 });
  assert.equal(w.ea.runOnce(), ESCAPE_OUTCOME.STOP);
});

test("wired, standing and repeat-attacking: CancelAttack, the repeat ends, no notice, the selection stays", () => {
  const w = wiredWorld();
  w.rs.noteSend({ selected: 0x80000a01, target: 0x80000a01 });
  w.win.__combatBarState.attackInProgress = true;
  assert.equal(w.rs.repeatAttacking, true);
  assert.equal(w.ea.runOnce(), ESCAPE_OUTCOME.STOP);
  assert.equal(w.cancels.length, 1);
  assert.equal(w.rs.repeatAttacking, false);
  assert.equal(w.log.filter((e) => e[0] === "chat").length, 0);
  assert.notEqual(w.sel(), 0);
  // The cancel's ActionCancelled is expected: it does not end a newer chain.
  w.rs.noteSend({ selected: 0x80000a01, target: 0x80000a01 });
  assert.equal(w.rs.onAttackDone("ActionCancelled").stale, true);
});

test("wired, a throttled CancelAttack still ends the repeat (repeatAttacking = 0)", () => {
  const w = wiredWorld({ cancelThrottled: true });
  w.rs.noteSend({ selected: 1, target: 1 });
  w.win.__combatBarState.attackInProgress = true;
  w.ea.runOnce();
  assert.equal(w.cancels.length, 1);
  assert.equal(w.rs.repeatAttacking, false);
});

test("wired, Repeat Attacks off: a swing in flight is not a repeat attack — Escape deselects", () => {
  const w = wiredWorld();
  w.win.__combatBarState.autoRepeat = false;
  w.win.__combatBarState.attackInProgress = true;
  assert.equal(w.ea.runOnce(), ESCAPE_OUTCOME.DESELECT);
  assert.equal(w.cancels.length, 0);
});

test("wired, a combat build in progress: the build is cancelled unsent (HidePowerBar) and CancelAttack goes out", () => {
  const charge = { building: true, cancelled: 0, cancel() { this.cancelled += 1; this.building = false; } };
  const w = wiredWorld({ charge });
  assert.equal(w.ea.runOnce(), ESCAPE_OUTCOME.STOP);
  assert.equal(charge.cancelled, 1);
  assert.equal(w.cancels.length, 1);
});

test("wired, a jump charge: only the charge is cancelled", () => {
  const calls = [];
  const w = wiredWorld({
    win: { __jumpChargeActive: true },
    handle: { jumpChargeLevel: () => 0.3, jumpChargeAbort: () => calls.push("abort") },
  });
  assert.equal(w.ea.runOnce(), ESCAPE_OUTCOME.CANCEL_JUMP);
  assert.deepEqual(calls, ["abort"]);
  assert.notEqual(w.sel(), 0);
});

// ── the central Escape-consumed signal on a simulated event path ──────────
class FakeNode {
  constructor(name, parentNode = null) {
    this.name = name;
    this.parentNode = parentNode;
    this._l = [];
  }
  addEventListener(type, fn, opt) {
    const capture = opt === true || !!opt?.capture;
    if (this._l.some((l) => l.type === type && l.fn === fn && l.capture === capture)) return;
    this._l.push({ type, fn, capture, removed: false });
  }
  removeEventListener(type, fn, opt) {
    const capture = opt === true || !!opt?.capture;
    const i = this._l.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture);
    if (i >= 0) {
      this._l[i].removed = true;
      this._l.splice(i, 1);
    }
  }
}

// DOM dispatch: capture from the root down, target, bubble back up. Each
// node's listener list is cloned when that node is reached (so a listener
// added to window during the capture phase runs in its bubble phase).
// MutationObserver records are delivered between listeners when
// `deliverBetween` is set (a trusted event's microtask checkpoint).
function dispatch(ev, target, dom) {
  const path = [];
  for (let n = target; n; n = n.parentNode) path.push(n);
  ev.target = target;
  const invoke = (node, phase) => {
    for (const l of node._l.slice()) {
      if (l.removed || l.type !== ev.type) continue;
      if (phase === "capture" && !l.capture) continue;
      if (phase === "bubble" && l.capture) continue;
      l.fn(ev);
      if (dom?.deliverBetween) dom.deliver();
      if (ev._stopImm) return;
    }
  };
  for (let i = path.length - 1; i >= 1; i--) {
    invoke(path[i], "capture");
    if (ev._stop) return;
  }
  invoke(path[0], "target");
  if (ev._stop || !ev.bubbles) return;
  for (let i = 1; i < path.length; i++) {
    invoke(path[i], "bubble");
    if (ev._stop) return;
  }
}

function keyEvent(key, extra = {}) {
  return {
    type: "keydown", key, code: key === "Escape" ? "Escape" : (extra.code ?? ""),
    repeat: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    bubbles: true, defaultPrevented: false, _stop: false, _stopImm: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this._stop = true; },
    stopImmediatePropagation() { this._stop = true; this._stopImm = true; },
    ...extra,
  };
}

function fakeDom() {
  const dom = {
    observers: new Set(),
    deliverBetween: false,
    mutate(what) { for (const o of dom.observers) o._records.push({ type: "attributes", what }); },
    deliver() {
      for (const o of [...dom.observers]) {
        if (o._records.length > 0) o._cb(o._records.splice(0), o);
      }
    },
  };
  class FakeMO {
    constructor(cb) { this._cb = cb; this._records = []; }
    observe() { dom.observers.add(this); }
    takeRecords() { return this._records.splice(0); }
    disconnect() { dom.observers.delete(this); this._records = []; }
  }
  const timers = [];
  const win = new FakeNode("window");
  win.location = { search: "" };
  const doc = new FakeNode("document", win);
  doc.getElementById = () => null;
  const body = new FakeNode("body", doc);
  const panel = new FakeNode("panel", body);
  return {
    dom, FakeMO, win, doc, body, panel, timers,
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: (id) => { timers[id - 1] = null; },
    flush() { for (let i = 0; i < timers.length; i++) { const f = timers[i]; timers[i] = null; f?.(); } },
  };
}

// The real funnel installed on the fake document, plus the gate as its last
// raw subscriber. `before` registers listeners ahead of the funnel (a capture
// handler a panel installed at boot).
function gateWorld({ before, mo = true } = {}) {
  const env = fakeDom();
  const acted = [];
  const consumed = [];
  before?.(env);
  const funnel = new InputFunnel();
  funnel.install(env.doc);
  // Another raw subscriber that does not care about Escape (movement keystate).
  funnel.bindRaw("test.other", () => {}, { priority: 100 });
  const gate = createEscapeConsumedGate({
    win: env.win,
    root: env.doc,
    MutationObserver: mo ? env.FakeMO : null,
    setTimer: env.setTimer,
    clearTimer: env.clearTimer,
    onUnconsumed: (ev) => acted.push(ev.key),
    onConsumed: (_ev, why) => consumed.push(why),
  });
  funnel.bindRaw("escape.inWorld", (ev) => gate.onKeyDown(ev), { priority: ESCAPE_RAW_PRIORITY });
  return { ...env, funnel, gate, acted, consumed };
}

test("consumed gate: an Escape nobody used acts once, after every panel listener", () => {
  const g = gateWorld();
  const order = [];
  g.doc.addEventListener("keydown", () => order.push(`document-bubble acted=${g.acted.length}`));
  g.win.addEventListener("keydown", () => order.push(`window-bubble acted=${g.acted.length}`));
  dispatch(keyEvent("Escape"), g.body, g.dom);
  assert.deepEqual(g.acted, ["Escape"], "acted during the dispatch, at the window stop");
  assert.deepEqual(order, ["document-bubble acted=0", "window-bubble acted=0"]);
  assert.equal(g.gate.pending, false);
  g.flush();
  assert.deepEqual(g.acted, ["Escape"], "the timer does not act a second time");
  assert.equal(g.gate.stats.acted, 1);
});

test("consumed gate: a panel's preventDefault (commerce / tradeskill shape) → nothing in-world", () => {
  const g = gateWorld();
  g.doc.addEventListener("keydown", (ev) => { if (ev.key === "Escape") ev.preventDefault(); });
  dispatch(keyEvent("Escape"), g.body, g.dom);
  g.flush();
  assert.deepEqual(g.acted, []);
  assert.deepEqual(g.consumed, ["defaultPrevented"]);
});

test("consumed gate: a capture handler ahead of the funnel (container / modal shape) → nothing in-world", () => {
  const g = gateWorld({
    before: (env) => env.doc.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      env.dom.mutate("panel hidden");
    }, true),
  });
  dispatch(keyEvent("Escape"), g.body, g.dom);
  g.flush();
  assert.deepEqual(g.acted, []);
  assert.deepEqual(g.consumed, ["defaultPrevented"], "seen at the funnel: no session opens");
  assert.equal(g.gate.pending, false);
});

test("consumed gate: stopPropagation in the bubble phase (examine-floaty shape) → nothing in-world", () => {
  const g = gateWorld();
  g.doc.addEventListener("keydown", (ev) => { if (ev.key === "Escape") ev.stopPropagation(); });
  dispatch(keyEvent("Escape"), g.body, g.dom);
  assert.equal(g.gate.pending, true, "the window stop never came");
  g.flush();
  assert.deepEqual(g.acted, []);
  assert.deepEqual(g.consumed, ["propagation"]);
  assert.equal(g.gate.pending, false);
});

test("consumed gate: a window listener that only hides its panel (social / fellowship shape) → nothing in-world", () => {
  const g = gateWorld();
  let open = true;
  g.win.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || !open) return;
    open = false;
    g.dom.mutate("win.hidden = true");
  });
  dispatch(keyEvent("Escape"), g.body, g.dom);
  g.flush();
  assert.deepEqual(g.acted, []);
  assert.deepEqual(g.consumed, ["dom"]);
  // Closed now: the next Escape is the in-world one.
  dispatch(keyEvent("Escape"), g.body, g.dom);
  g.flush();
  assert.deepEqual(g.acted, ["Escape"]);
});

test("consumed gate: a mutation the observer callback already took (delivered between listeners) still counts", () => {
  const g = gateWorld();
  g.dom.deliverBetween = true;
  g.doc.addEventListener("keydown", () => g.dom.mutate("dataset.open = 0"));
  dispatch(keyEvent("Escape"), g.body, g.dom);
  g.flush();
  assert.deepEqual(g.acted, []);
  assert.deepEqual(g.consumed, ["dom"]);
});

test("consumed gate: a focused panel's own target-phase handler (spell-research shape) → nothing in-world", () => {
  const g = gateWorld();
  g.panel.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { ev.preventDefault(); g.dom.mutate("closed"); } });
  dispatch(keyEvent("Escape"), g.panel, g.dom);
  g.flush();
  assert.deepEqual(g.acted, []);
});

test("consumed gate: the explicit mark", () => {
  const g = gateWorld();
  g.doc.addEventListener("keydown", (ev) => markEscapeConsumed(ev));
  dispatch(keyEvent("Escape"), g.body, g.dom);
  g.flush();
  assert.deepEqual(g.consumed, ["marked"]);
  assert.deepEqual(g.acted, []);
  assert.equal(escapeConsumedReason({}), null);
});

test("consumed gate: a window-capture change before the funnel (hover tooltip hiding) does not count", () => {
  const g = gateWorld({
    before: (env) => env.win.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") env.dom.mutate("tooltip display none");
    }, true),
  });
  dispatch(keyEvent("Escape"), g.body, g.dom);
  g.flush();
  assert.deepEqual(g.acted, ["Escape"]);
});

test("consumed gate: Shift+Escape, an autorepeat and other keys open no session", () => {
  const g = gateWorld();
  dispatch(keyEvent("Escape", { shiftKey: true }), g.body, g.dom);
  dispatch(keyEvent("Escape", { repeat: true }), g.body, g.dom);
  dispatch(keyEvent("w", { code: "KeyW" }), g.body, g.dom);
  g.flush();
  assert.deepEqual(g.acted, []);
  assert.equal(g.gate.stats.seen, 0);
});

test("consumed gate: no MutationObserver → preventDefault / propagation still gate it", () => {
  const g = gateWorld({ mo: false });
  dispatch(keyEvent("Escape"), g.body, g.dom);
  assert.deepEqual(g.acted, ["Escape"]);
  g.doc.addEventListener("keydown", (ev) => ev.preventDefault());
  dispatch(keyEvent("Escape"), g.body, g.dom);
  g.flush();
  assert.deepEqual(g.acted, ["Escape"]);
});

test("consumed gate: a closed funnel gate (not in world) never reaches the gate", () => {
  const g = gateWorld();
  g.funnel.setGate(() => false);
  dispatch(keyEvent("Escape"), g.body, g.dom);
  g.flush();
  assert.deepEqual(g.acted, []);
  assert.equal(g.gate.stats.seen, 0);
});

test("installEscapeAction binds the funnel's last raw subscriber and a held W makes Escape a stop", () => {
  const env = fakeDom();
  const funnel = new InputFunnel();
  funnel.install(env.doc);
  const log = [];
  let selected = 0x80000a01;
  const ea = installEscapeAction({
    funnel,
    sessionHandle: { getLocalPlayerPose: () => null },
    getEntityManager: () => ({ getSelectedTarget: () => selected, deselectTarget: () => { selected = 0; } }),
    stopMovement: () => log.push("stopMovement"),
    win: Object.assign(env.win, { __appendChatLine: (t) => log.push(t) }),
    doc: env.doc,
    MutationObserver: env.FakeMO,
    setTimer: env.setTimer,
    clearTimer: env.clearTimer,
  });
  assert.equal(funnel.raws[funnel.raws.length - 1].name, "escape.inWorld");
  // W held (its key-up has not come): moving.
  dispatch(keyEvent("w", { code: "KeyW" }), env.body, env.dom);
  dispatch(keyEvent("Escape"), env.body, env.dom);
  env.flush();
  assert.deepEqual(log, ["stopMovement", "Action interrupted"]);
  assert.equal(selected, 0x80000a01);
  // W released: standing — the next Escape deselects.
  funnel.handleKeyUp({ type: "keyup", key: "w", code: "KeyW" });
  dispatch(keyEvent("Escape"), env.body, env.dom);
  env.flush();
  assert.equal(selected, 0);
  ea.uninstall();
  assert.equal(funnel.raws.some((r) => r.name === "escape.inWorld"), false);
});

// ── the willingly-lost mark on a real EntityManager ───────────────────────
const THREE = await import("three");
const { EntityManager } = await import("../scene3d/entities.js");

const ME = 0x50000001;
const A = 0x80000a01; // mob @3 m
const B = 0x80000b01; // mob @10 m
const MOB = { itemType: 0x10, objDescFlags: 0x14 };

function emWorld() {
  const sh = {
    mode: 2, // Melee
    getLocalPlayerPose() { return { x: 0, y: 0, z: 0, heading: 0, landblockId: 0x00000019 }; },
    getCurrentCellId() { return 0x00000019; },
    combatMode() { return this.mode; },
    isCharacterOptionEnabled(o) { return o === 0x0d; },
    objectInstanceIdProperty() { return undefined; },
    objectIntProperty(_g, s) { return s === 133 ? 2 : undefined; },
    objectDescFlags() { return 0x18; },
  };
  globalThis.window.__sessionHandle = sh;
  globalThis.window.getLocalPlayerGuid = () => ME;
  const em = new EntityManager({ entitiesGroup: new THREE.Group(), materialCache: null }, {});
  em._autoTargetOn = true;
  em._selectionRangeExitOn = true;
  em._lastCombatMode = sh.mode;
  const add = (guid, x, meta) => {
    const root = new THREE.Group();
    root.position.set(x, 0, 0);
    em.entityMap.set(guid, {
      guid, root, parts: [], meta: { guid, ...meta },
      _stateVisible: true, _attachedParentGuid: null, _attachedChildren: null, dispose() {},
    });
  };
  add(ME, 0, { itemType: 0x10, objDescFlags: 0x18 });
  add(A, 3, MOB);
  add(B, 10, MOB);
  const tick = () => em._tickSelectionRules(em._localPlayerWorldPose());
  return { em, sh, tick };
}

test("Escape's deselect sets the willingly-lost mark: melee auto-target does not re-select", () => {
  const { em, sh, tick } = emWorld();
  // Control: a plain selection clear in melee auto-targets the closest mob.
  em._commitSelection(B);
  em._commitSelection(0);
  assert.equal(em.getSelectedTarget(), A, "the harness auto-targets");
  em._commitSelection(B);
  const ea = installEscapeAction({
    funnel: null,
    sessionHandle: sh,
    getEntityManager: () => em,
    win: { location: { search: "" }, addEventListener() {}, removeEventListener() {} },
    doc: null,
  });
  assert.equal(ea.runOnce(), ESCAPE_OUTCOME.DESELECT);
  assert.equal(em.getSelectedTarget(), 0, "no auto-target after Escape");
  tick();
  assert.equal(em.getSelectedTarget(), 0, "still empty a tick later");
  em.dispose();
});
