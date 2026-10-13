// ui/escape_action.js — combat-magic-4 (2026-10-13): the in-world Escape key.
//
// RETAIL: plain Escape is input action 0x27 (Shift+Escape is a different
// keymap entry). ClientUISystem::OnAction case 0x27 (acclient.c:402170-402224)
// does, in this order:
//   1. A jump charge is pending (ClientCombatSystem::GetJumpPowerLevel > 0,
//      :408081, i.e. jump_pending): the command interpreter's FinishJump, and
//      nothing else.
//   2. A UI element holds keyboard focus (UIElementManager::m_focusElement):
//      it gives up focus, and nothing else.
//   3. Standing still (CommandInterpreter::IsStandingStill :717637 →
//      CMotionInterp::is_standing_still: Contact + OnWalkable, forward
//      command Ready, no sidestep, no turn) and no repeat attack
//      (ClientCombatSystem::RepeatAttackInProgress :407523):
//        a. a target mode is up → SetTargetMode(0);
//        b. else something is selected → targetWillinglyLost = 1 and
//           SetSelectedObject(0), so no auto-target follows;
//        c. else DoVisibilityToggleAction(0x1000001B), the options page.
//   4. Otherwise: StopCompletely (:717535); "Action interrupted" at text
//      type 0x1A when the player was NOT standing still; AbortAutomaticAttack
//      (:407958) when a repeat attack is in progress.
// The decomp names the field tested in 3a `attemptOpenVendorID`. OnAction's
// `this` is the IInputActionCallback sub-object 8 bytes into ClientUISystem
// (3a calls SetTargetMode on `this - 8`), so the field really read is the one
// 8 bytes further on: `targetMode` (acclient.h ClientUISystem). Here that is
// the use-on-target cursor, `window.__useTargeting` (app/hud_panels.js).
// The port follows WebAC packages/renderer/src/controllers/EscapeAction.ts
// (AGPL-3.0) for its shape; the order is re-derived from the decomp above.
//
// HOLTBURGER: about 25 panels and popovers already close on Escape, each with
// its own listener (container / corpse / salvage / modal / radial capture
// handlers, the map, commerce, social, fellowship, allegiance, vitae and
// spellbook window listeners, examine-floaty, the spell-research overlay…).
// That is the analog of step 2, and a text field with focus never reaches the
// gameplay funnel at all. So the in-world action may run only when NONE of
// those handlers used the key. `createEscapeConsumedGate` is that central
// "Escape consumed" signal, and needs no change in any panel:
//   - Its keydown hook is the LAST raw subscriber of the input funnel (a
//     document capture listener), so it runs before every element handler
//     and every bubble-phase panel listener.
//   - It opens a short session: a MutationObserver over the document, plus a
//     one-shot bubble-phase listener on `window`, which is the last stop of
//     the event path. A listener added during dispatch still runs there,
//     because each target's listener list is cloned when that target is
//     reached.
//   - At that stop the Escape counts as consumed when it was
//     preventDefault()ed, carries `markEscapeConsumed`, or the DOM changed
//     during the dispatch (a panel hid, closed or removed itself). If a
//     handler stopped propagation the window stop never comes, and a 0 ms
//     timer ends the session as consumed.
//   - Mutations made before the session opened (window-capture listeners
//     such as the hover tooltip hiding) do not count.
// Step 3c (the options page toggle) is not ported: with nothing selected,
// Escape does nothing.
//
// `?escapeAction=off` (or 0 / false) removes the in-world action;
// scene3d/picking.js then keeps its old Escape arm (cancel use-targeting).
//
// No DOM access at import time — unit-testable under plain node.

import { movementKeyOf } from "./movement_keys.js";
import { CHAT_CATEGORY_TRANSIENT } from "./spew_box.js";
import { isTextEntryTarget } from "./input-funnel.js";

/** The retail 0x1A line (ClientUISystem::OnAction :402216). */
export const ACTION_INTERRUPTED_TEXT = "Action interrupted";

/** The funnel raw priority: below every other raw subscriber. */
export const ESCAPE_RAW_PRIORITY = -1000;

/** Per-event mark a panel may set when it used the Escape. */
export const ESCAPE_CONSUMED_MARK = "__hbEscapeConsumed";

export const ESCAPE_OUTCOME = Object.freeze({
  CANCEL_JUMP: "cancel-jump",
  RELINQUISH_FOCUS: "relinquish-focus",
  CLEAR_TARGET_MODE: "clear-target-mode",
  DESELECT: "deselect",
  TOGGLE_OPTIONS: "toggle-gameplay-options",
  NONE: "none",
  STOP: "stop",
});

const isOff = (v) => v === "off" || v === "0" || v === "false";

/** `?escapeAction=off` / `0` / `false` → no in-world Escape. Default on. */
export function escapeActionEnabled(search) {
  try {
    const v = new URLSearchParams(search ?? globalThis.location?.search ?? "").get("escapeAction");
    return !isOff(v == null ? v : String(v).toLowerCase());
  } catch (_) {
    return true;
  }
}

/**
 * ClientUISystem::OnAction case 0x27, in decomp order. Every dependency is
 * optional; a missing query reads false (IsStandingStill reads true, as
 * retail's does with no player).
 *
 * @param {object} d
 * @param {() => boolean} [d.jumpCharging]          GetJumpPowerLevel > 0
 * @param {() => void}    [d.cancelJumpCharge]      cmdinterp FinishJump
 * @param {() => boolean} [d.hasUiFocus]            m_focusElement
 * @param {() => void}    [d.relinquishUiFocus]
 * @param {() => boolean} [d.isStandingStill]       CommandInterpreter::IsStandingStill
 * @param {() => boolean} [d.repeatAttackInProgress] ClientCombatSystem::RepeatAttackInProgress
 * @param {() => void}    [d.abortAutomaticAttack]  ClientCombatSystem::AbortAutomaticAttack
 * @param {() => boolean} [d.targetModePending]     ClientUISystem::targetMode != 0
 * @param {() => void}    [d.clearTargetMode]       SetTargetMode(0)
 * @param {() => number}  [d.selectedId]            ACCWeenieObject::selectedID
 * @param {() => void}    [d.deselectWillingly]     targetWillinglyLost = 1; SetSelectedObject(0)
 * @param {() => void}    [d.toggleGameplayOptions] DoVisibilityToggleAction(0x1000001B) (absent → no-op)
 * @param {() => void}    [d.stopCompletely]        CommandInterpreter::StopCompletely
 * @param {(text:string) => void} [d.notice]        AddTextToScroll(text, 0x1A)
 * @returns {string} an ESCAPE_OUTCOME value
 */
export function escapeAction(d = {}) {
  const ask = (fn) => (typeof fn === "function" ? fn() : undefined);
  if (ask(d.jumpCharging)) {
    ask(d.cancelJumpCharge);
    return ESCAPE_OUTCOME.CANCEL_JUMP;
  }
  if (ask(d.hasUiFocus)) {
    ask(d.relinquishUiFocus);
    return ESCAPE_OUTCOME.RELINQUISH_FOCUS;
  }
  const standing = typeof d.isStandingStill === "function" ? !!d.isStandingStill() : true;
  if (standing && !ask(d.repeatAttackInProgress)) {
    if (ask(d.targetModePending)) {
      ask(d.clearTargetMode);
      return ESCAPE_OUTCOME.CLEAR_TARGET_MODE;
    }
    if (((Number(ask(d.selectedId)) >>> 0) || 0) !== 0) {
      ask(d.deselectWillingly);
      return ESCAPE_OUTCOME.DESELECT;
    }
    if (typeof d.toggleGameplayOptions === "function") {
      d.toggleGameplayOptions();
      return ESCAPE_OUTCOME.TOGGLE_OPTIONS;
    }
    return ESCAPE_OUTCOME.NONE;
  }
  ask(d.stopCompletely);
  if (!standing && typeof d.notice === "function") d.notice(ACTION_INTERRUPTED_TEXT);
  if (ask(d.repeatAttackInProgress)) ask(d.abortAutomaticAttack);
  return ESCAPE_OUTCOME.STOP;
}

/**
 * RepeatAttackInProgress (:407523): the Repeat Attacks option is on, and a
 * swing is in flight (attackInProgress) or the combat power bar is building
 * (powerBarMode == PBM_COMBAT).
 */
export function repeatAttackInProgress({ autoRepeat, attackInProgress, building } = {}) {
  return !!autoRepeat && (!!attackInProgress || !!building);
}

/**
 * AbortAutomaticAttack's own gate (:407958): CancelAttack goes out only when
 * a reply is pending, a request is building, a swing is in flight or the
 * repeat is running.
 */
export function automaticAttackLive({ responsePending, building, attackInProgress, repeatAttacking } = {}) {
  return !!(responsePending || building || attackInProgress || repeatAttacking);
}

/**
 * CMotionInterp::is_standing_still from what the page can see: on the
 * ground, no movement key held, no autorun, and no server TurnTo / MoveTo
 * running on the local player (`localAutonomousMotion() != 0`).
 */
export function isStandingStill({ onGround = true, movementKeyHeld = false, autoRun = false, autonomousMotion = 0 } = {}) {
  if (onGround === false) return false;
  if (movementKeyHeld || autoRun) return false;
  return ((Number(autonomousMotion) >>> 0) || 0) === 0;
}

/** True when the input funnel's held-key ledger holds a movement key
 *  (W/A/S/D/Q/E by physical key, ui/movement_keys.js). */
export function heldMovementKey(funnel, keyOf = movementKeyOf) {
  const held = funnel?._held;
  if (!held || typeof held.forEach !== "function") return false;
  let any = false;
  try {
    held.forEach((v, code) => {
      if (!any && keyOf({ code, key: v?.key ?? "" })) any = true;
    });
  } catch (_) {
    return false;
  }
  return any;
}

/**
 * GetJumpPowerLevel > 0 (jump_pending). index.html marks a held Space with
 * `__jumpChargeActive` (cmdInterp / jumpParity lanes; the charge clock is
 * wasm-side, so a press refused while airborne arms nothing and reads level
 * 0) or `__jumpKeydownTs` (the legacy JS clock).
 */
export function jumpChargePending(win, handle) {
  if (!win) return false;
  if (win.__jumpKeydownTs != null) return true;
  if (win.__jumpChargeActive !== true) return false;
  if (typeof handle?.jumpChargeLevel === "function") {
    try {
      return Number(handle.jumpChargeLevel()) > 0;
    } catch (_) {
      return true;
    }
  }
  return true;
}

/**
 * FinishJump: drop the charge without jumping, the way index.html's blur arm
 * does (`jumpChargeAbort` for the wasm clock, `jumpChargeCancel` for the
 * legacy standstill root). The Space release that follows then has nothing
 * to release. index.html's `jumpChargeUi` stops its own frame loop once
 * neither marker is set; the bar is hidden here at once.
 * @returns {boolean} whether a charge marker was set
 */
export function cancelJumpCharge(win, handle, doc) {
  let cancelled = false;
  if (win?.__jumpChargeActive === true) {
    win.__jumpChargeActive = false;
    try { if (typeof handle?.jumpChargeAbort === "function") handle.jumpChargeAbort(); } catch (_) {}
    cancelled = true;
  }
  if (win && win.__jumpKeydownTs != null) {
    win.__jumpKeydownTs = null;
    try { if (typeof handle?.jumpChargeCancel === "function") handle.jumpChargeCancel(); } catch (_) {}
    cancelled = true;
  }
  try {
    const bar = doc?.getElementById?.("hb-jump-charge");
    if (bar) {
      bar.classList?.remove?.("hb-jc-active", "hb-jc-full");
      const fill = bar.querySelector?.(".hb-jc-fill");
      if (fill?.style) fill.style.width = "0%";
    }
  } catch (_) { /* cosmetic */ }
  return cancelled;
}

/** A plain, fresh Escape press: no modifier (Shift+Escape is another retail
 *  action), not OS autorepeat. */
export function isInWorldEscape(ev) {
  if (!ev || ev.key !== "Escape") return false;
  if (ev.repeat) return false;
  if (ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey) return false;
  return true;
}

/** A panel that used the Escape without preventDefault() may mark it. */
export function markEscapeConsumed(ev) {
  try {
    if (ev && typeof ev === "object") ev[ESCAPE_CONSUMED_MARK] = true;
  } catch (_) {}
  return ev;
}

/**
 * Why this Escape is not the in-world action's, or null when nobody used it.
 * @param {object} ev
 * @param {{mutated?: boolean}} [o] the DOM changed during the dispatch
 */
export function escapeConsumedReason(ev, { mutated = false } = {}) {
  if (!ev) return "no-event";
  if (ev.defaultPrevented) return "defaultPrevented";
  if (ev[ESCAPE_CONSUMED_MARK] === true) return "marked";
  if (mutated) return "dom";
  return null;
}

/**
 * The central Escape-consumed signal (see the header).
 *
 * @param {object} deps
 * @param {(ev:object) => void} deps.onUnconsumed      the in-world action
 * @param {(ev:object, why:string) => void} [deps.onConsumed]
 * @param {object} [deps.win]                          window (the end of the event path)
 * @param {object} [deps.root]                         the node watched for mutations (document)
 * @param {Function|null} [deps.MutationObserver]      default globalThis.MutationObserver
 * @param {(fn:Function, ms:number) => any} [deps.setTimer]
 * @param {(id:any) => void} [deps.clearTimer]
 */
export function createEscapeConsumedGate(deps = {}) {
  const win = "win" in deps ? deps.win : (typeof window !== "undefined" ? window : null);
  const root = "root" in deps ? deps.root : (typeof document !== "undefined" ? document : null);
  const MO = "MutationObserver" in deps ? deps.MutationObserver : globalThis.MutationObserver;
  const setTimer = typeof deps.setTimer === "function" ? deps.setTimer : (fn, ms) => setTimeout(fn, ms);
  const clearTimer = typeof deps.clearTimer === "function" ? deps.clearTimer : (id) => clearTimeout(id);
  const stats = { seen: 0, consumed: 0, acted: 0, lastWhy: null };
  let session = null;

  function consumed(ev, why) {
    stats.consumed += 1;
    stats.lastWhy = why;
    try { deps.onConsumed?.(ev, why); } catch (_) {}
  }

  function settle(s, forced) {
    if (session !== s) return;
    session = null;
    try { win?.removeEventListener?.("keydown", s.onBubble, false); } catch (_) {}
    if (s.timer != null) {
      try { clearTimer(s.timer); } catch (_) {}
    }
    if (s.observer) {
      // Records the observer callback already took (it can run between two
      // listeners of a trusted event) set `mutated`; the rest are still
      // queued.
      try { if (s.observer.takeRecords().length > 0) s.mutated = true; } catch (_) {}
      try { s.observer.disconnect(); } catch (_) {}
    }
    const why = forced || escapeConsumedReason(s.ev, { mutated: s.mutated });
    if (why) {
      consumed(s.ev, why);
      return;
    }
    stats.acted += 1;
    stats.lastWhy = null;
    try {
      deps.onUnconsumed?.(s.ev);
    } catch (e) {
      console.warn(`[escapeAction] in-world action threw: ${e?.message ?? e}`);
    }
  }

  return {
    stats,
    get pending() { return session != null; },
    /** Bind as the funnel's last raw subscriber. @returns {boolean} a session opened */
    onKeyDown(ev) {
      if (!isInWorldEscape(ev)) return false;
      if (session) settle(session, "superseded");
      stats.seen += 1;
      const pre = escapeConsumedReason(ev);
      if (pre) {
        consumed(ev, pre);
        return false;
      }
      // Without the window stop there is no "after every panel" moment, and
      // acting now would run ahead of the panels.
      if (!win || typeof win.addEventListener !== "function") return false;
      const s = { ev, mutated: false, observer: null, timer: null, onBubble: null };
      if (typeof MO === "function" && root) {
        try {
          s.observer = new MO((records) => {
            if (records && records.length > 0) s.mutated = true;
          });
          s.observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
        } catch (_) {
          s.observer = null;
        }
      }
      s.onBubble = (e) => {
        if (e === ev) settle(s, null);
      };
      session = s;
      win.addEventListener("keydown", s.onBubble, false);
      s.timer = setTimer(() => settle(s, "propagation"), 0);
      return true;
    },
    dispose() {
      if (session) settle(session, "disposed");
    },
  };
}

/**
 * Wire the in-world Escape (scene3d/picking.js calls this).
 *
 * @param {object} o
 * @param {object|null} [o.funnel]           the input funnel; null → a document capture listener (`?inputFunnelV2=off`)
 * @param {object} [o.sessionHandle]
 * @param {() => object|null} [o.getEntityManager]
 * @param {() => void} [o.stopMovement]      picking.js cancelClientMove (stick + pursuit)
 * @param {() => object|null} [o.getRepeatState]  combat-magic-2's attack repeat state
 * @param {() => boolean} [o.sendCancelAttack]    throttled CancelAttack; true when sent
 * @param {() => object|null} [o.getAttackCharge] ui/attack_power_bar.js controller
 * @param {object} [o.win]
 * @param {object} [o.doc]
 * @returns {{uninstall: () => void, gate: object, runOnce: (ev?:object) => string}}
 */
export function installEscapeAction(o = {}) {
  const win = o.win ?? (typeof window !== "undefined" ? window : null);
  const doc = o.doc ?? (typeof document !== "undefined" ? document : null);
  const funnel = o.funnel ?? null;
  const safe = (fn) => { try { return fn?.() ?? null; } catch (_) { return null; } };
  const handle = () => o.sessionHandle ?? win?.__sessionHandle ?? null;
  const combatBar = () => win?.__combatBarState ?? null;
  const repeatState = () => safe(o.getRepeatState);
  const charge = () => safe(o.getAttackCharge);
  const em = () => safe(o.getEntityManager);

  const localStandingStill = () => {
    const h = handle();
    let onGround = true;
    try {
      const pose = typeof h?.getLocalPlayerPose === "function" ? h.getLocalPlayerPose() : null;
      if (pose) {
        if (pose.isOnGround === false) onGround = false;
        try { if (typeof pose.free === "function") pose.free(); } catch (_) {}
      }
    } catch (_) { /* no pose yet: standing */ }
    let autonomousMotion = 0;
    try {
      if (typeof h?.localAutonomousMotion === "function") autonomousMotion = h.localAutonomousMotion() >>> 0;
    } catch (_) {}
    return isStandingStill({
      onGround,
      movementKeyHeld: heldMovementKey(funnel),
      autoRun: win?.__autoRunOn === true,
      autonomousMotion,
    });
  };

  const deps = {
    jumpCharging: () => jumpChargePending(win, handle()),
    cancelJumpCharge: () => cancelJumpCharge(win, handle(), doc),
    // Step 2: a focused text field never reaches the funnel, and a panel
    // that closed on this Escape stopped it at the consumed gate.
    isStandingStill: localStandingStill,
    repeatAttackInProgress: () => {
      const cb = combatBar();
      return repeatAttackInProgress({
        autoRepeat: cb?.autoRepeat,
        attackInProgress: !!cb?.attackInProgress || !!repeatState()?.responsePending,
        building: !!charge()?.building,
      });
    },
    abortAutomaticAttack: () => {
      const rs = repeatState();
      const ch = charge();
      const building = !!ch?.building;
      if (!automaticAttackLive({
        responsePending: rs?.responsePending,
        building,
        attackInProgress: combatBar()?.attackInProgress,
        repeatAttacking: rs?.repeatAttacking,
      })) return false;
      const wasLive = !!(rs && (rs.repeatAttacking || rs.responsePending));
      let sent = false;
      try { sent = !!o.sendCancelAttack?.(); } catch (_) { sent = false; }
      // repeatAttacking = 0 whether or not the throttle let the cancel out.
      if (rs) {
        try { if (sent) rs.noteCancelSent(wasLive); else rs.endRepeat(); } catch (_) {}
      }
      // HidePowerBar: a build in progress ends without a swing.
      if (building) {
        try { ch.cancel(); } catch (_) {}
      }
      return sent;
    },
    targetModePending: () => !!win?.__useTargeting?.pending,
    clearTargetMode: () => { try { win.__useTargeting.cancel(); } catch (_) {} },
    selectedId: () => {
      try { return (em()?.getSelectedTarget?.() ?? 0) >>> 0; } catch (_) { return 0; }
    },
    deselectWillingly: () => { try { em()?.deselectTarget?.(); } catch (_) {} },
    // CommandInterpreter::StopCompletely is SetAutoRun(0, 0) + the physics
    // stop (which cancels a MoveTo) + the movement event. The page can end
    // the client move (sticky hold, client pursuit) and autorun. Held keys
    // and a server-driven MoveTo need the interpreter's own StopCompletely,
    // which has no export yet.
    stopCompletely: () => {
      try { o.stopMovement?.(); } catch (_) {}
      if (win?.__autoRunOn === true) {
        win.__autoRunOn = false;
        const h = handle();
        try { if (typeof h?.setAutoRun === "function") h.setAutoRun(false); } catch (_) {}
      }
    },
    notice: (text) => {
      try { win?.__appendChatLine?.(text, CHAT_CATEGORY_TRANSIENT); } catch (_) {}
    },
  };

  const diag = { enabled: true, last: null, stats: null };
  const runOnce = () => {
    const outcome = escapeAction(deps);
    diag.last = { outcome, at: Date.now() };
    return outcome;
  };
  const gate = createEscapeConsumedGate({
    win,
    root: doc,
    MutationObserver: "MutationObserver" in o ? o.MutationObserver : globalThis.MutationObserver,
    setTimer: o.setTimer,
    clearTimer: o.clearTimer,
    onUnconsumed: () => { runOnce(); },
    onConsumed: (_ev, why) => { diag.last = { outcome: "consumed", why, at: Date.now() }; },
  });
  diag.stats = gate.stats;

  let unbind = null;
  if (funnel && typeof funnel.bindRaw === "function") {
    unbind = funnel.bindRaw("escape.inWorld", (ev) => { gate.onKeyDown(ev); }, {
      priority: ESCAPE_RAW_PRIORITY,
    });
  } else if (doc && typeof doc.addEventListener === "function") {
    const legacy = (ev) => {
      if (isTextEntryTarget(ev)) return;
      gate.onKeyDown(ev);
    };
    doc.addEventListener("keydown", legacy, true);
    unbind = () => doc.removeEventListener("keydown", legacy, true);
  }
  try { if (win) win.__escapeAction = diag; } catch (_) {}

  return {
    gate,
    runOnce,
    uninstall() {
      try { unbind?.(); } catch (_) {}
      unbind = null;
      gate.dispose();
      diag.enabled = false;
    },
  };
}
