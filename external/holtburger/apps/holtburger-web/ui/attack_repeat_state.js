// ui/attack_repeat_state.js — retail auto-repeat attack lifecycle
// (combat-magic-2, 2026-10-13).
//
// Retail `ClientCombatSystem` (acclient.c) keeps three flags beside the power
// bar. holtburger only had one lockout bool
// (`__combatBarState.attackInProgress`), which every AttackDone cleared:
//
//   repeatAttacking   — `ExecuteAttack` (:408626) sets it when Repeat Attacks
//                       is on. `HandleAttackDoneEvent` (:409200) ends it on a
//                       non-zero AttackDone (ACE's end-of-chain
//                       ActionCancelled 0x36) or when the option is off.
//   attackServerResponsePending — set by `ExecuteAttack` and by the server's
//                       CombatCommenceAttack (`HandleCommenceAttackEvent`
//                       :407863); cleared by AttackDone.
//   attackWhenResponseReceived — `EndAttackRequest` (:408952) QUEUES a release
//                       made while a reply is pending. AttackDone replays it
//                       (:409264).
//
// The hooks (scene3d/picking.js):
//   - A selection change to another object while repeating sends
//     CancelAttack and ends the repeat (`RecvNotice_SelectionChanged`
//     :408741). ACE never lets a new TargetedMeleeAttack pre-empt a running
//     loop (Player_Melee.cs "already in melee loop?" returns after queueing
//     the power). Without the cancel, the loop keeps hitting the old target.
//   - AttackDone(None) while repeating, with no key held, re-sends once at the
//     selector when it moved more than 0.01 (`fabs(requested - UI) >
//     0.0099999998`). ACE's AttackQueue.Fetch takes the newest power.
//   - A jump the client accepts while repeating sends CancelAttack
//     (`CommenceJump` :408033-408067).
//   - A press while a reply is pending is queued instead of dropped, and
//     replays after AttackDone. On a target switch mid-swing, ACE only flags
//     AttackCancelled; a request for the new target sent right behind it is
//     queued, ignored and then wiped by OnAttackDone. So that request must
//     wait for the cancelled loop's AttackDone.
//
// ACE answers every CancelAttack sent while a chain is live with
// AttackDone(ActionCancelled). It comes at once between swings, or at the end
// of the swing when one is under way (Player_Melee.cs
// HandleActionCancelAttack / OnAttackDone). The player may send the next
// attack before that reply arrives, for example a press on the new target
// between swings. In that case the reply belongs to the cancelled chain, so
// it must not end the new one. That is the same stale-end expectation the
// rynth combat loop keeps for its own cancels (rynth/combat_loop.js
// _expectStaleEnd).
//
// Only the USER fire path calls `noteSend`. The rynth bot's wasm attack calls
// never set repeatAttacking, so bot-driven selection changes cancel nothing.
// `?attackRepeatState=off` restores the old lockout-only behaviour.

import { POWER_EPSILON } from "./attack_power_bar.js";

// Ack-loss safety: a reply that never comes must not hold presses forever.
// Longer than the combat-bar lockout's own timeout (≤ ~2.8 s after a
// commence), so the lockout has always cleared by the time this fires.
export const PENDING_SAFETY_MS = 4000;
// How long a sent CancelAttack's ActionCancelled is expected: at most one
// swing.
export const STALE_END_TTL_MS = 3500;

const isOff = (v) => v === "off" || v === "0" || v === "false";

/** `?attackRepeatState=off` / `0` / `false` → the old lockout-only path. */
export function attackRepeatStateEnabled(search) {
  try {
    const v = new URLSearchParams(search ?? globalThis.location?.search ?? "").get("attackRepeatState");
    return !isOff(v);
  } catch (_) { return true; }
}

/**
 * `HandleAttackDoneEvent`'s `etype != 0` test on the kind=19 payload. The
 * wasm side sends the WeenieError name: "None" between repeat swings, and
 * "ActionCancelled" (or a refusal code) at the end of a chain.
 */
export function attackDoneIsError(error) {
  if (error == null) return false;
  if (typeof error === "number") return error !== 0;
  const s = String(error);
  return s !== "" && s !== "None" && s !== "0";
}

/** The combat-bar meter after an AttackDone: a chain end empties it, and a
 *  repeat AttackDone(None) shows it ready. */
export function attackDoneMeter(error) {
  return attackDoneIsError(error) ? "reset" : "ready";
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * @param {object} deps
 * @param {() => boolean} deps.autoRepeat        PlayerModule::AutoRepeatAttack
 * @param {() => number}  deps.getSlider         m_rUIRequestedPower, 0..1
 * @param {() => boolean} [deps.isBuilding]      attackRequestInProgress (a key held / charge building)
 * @param {() => boolean} [deps.sendCancel]      CM_Combat::Event_CancelAttack; true when it went out (the caller throttles)
 * @param {(height:number, power:number) => void} [deps.resend]
 *        re-send at `power` on the current target, without a turn, prediction or lockout (picking.js's followUp path)
 * @param {(height:number, power:number) => void} [deps.fire]
 *        the normal user fire path (a queued press replays through it)
 * @param {(fn:Function) => void} [deps.defer]   run the replay after the AttackDone listeners (default: inline)
 * @param {(fn:Function, ms:number) => any} [deps.setTimer]
 * @param {(id:any) => void} [deps.clearTimer]
 * @param {() => number} [deps.now]              ms clock (the stale-end window)
 * @param {number} [deps.pendingSafetyMs]
 */
export function createAttackRepeatState(deps = {}) {
  const autoRepeat = () => { try { return !!deps.autoRepeat?.(); } catch (_) { return false; } };
  const getSlider = () => { try { return clamp01(deps.getSlider?.() ?? 1); } catch (_) { return 1; } };
  const isBuilding = () => { try { return !!deps.isBuilding?.(); } catch (_) { return false; } };
  const sendCancel = () => { try { return !!deps.sendCancel?.(); } catch (_) { return false; } };
  const resend = (h, p) => { try { deps.resend?.(h, p); } catch (_) { /* best effort */ } };
  const fire = (h, p) => { try { deps.fire?.(h, p); } catch (_) { /* best effort */ } };
  const defer = typeof deps.defer === "function" ? deps.defer : (fn) => fn();
  const now = typeof deps.now === "function"
    ? deps.now
    : () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
  const safetyMs = Number(deps.pendingSafetyMs) > 0 ? Number(deps.pendingSafetyMs) : PENDING_SAFETY_MS;

  const st = {
    repeatAttacking: false,
    responsePending: false,
    lastSelected: 0,
    lastTarget: 0,
    lastHeight: 2,
    lastPower: 1,
    queued: null, // { height, power } — attackWhenResponseReceived
    sends: 0,
    staleEnd: null, // { at, sends } — a sent CancelAttack's reply still due
  };
  let timer = null;

  // A CancelAttack went out while a chain was live: its ActionCancelled is due.
  const expectStaleEnd = () => { st.staleEnd = { at: now(), sends: st.sends }; };

  const disarm = () => {
    if (timer != null && typeof deps.clearTimer === "function") {
      try { deps.clearTimer(timer); } catch (_) {}
    }
    timer = null;
  };
  const arm = () => {
    disarm();
    if (typeof deps.setTimer !== "function") return;
    timer = deps.setTimer(() => {
      timer = null;
      api.expire();
    }, safetyMs);
  };

  // `HandleAttackDoneEvent` :409264-409269 — StartAttackRequest +
  // EndAttackRequest(height, queued power). Once that swing is sent, a power
  // past the selector is followed by a second request at the selector
  // (EndAttackRequest's second ExecuteAttack), which ACE's AttackQueue gives
  // to the repeats.
  const replay = (q) => {
    const before = st.sends;
    fire(q.height, q.power);
    if (st.sends === before) return false; // refused or queued again
    const slider = getSlider();
    if (q.power - slider > POWER_EPSILON) resend(q.height, slider);
    return true;
  };

  const api = {
    get repeatAttacking() { return st.repeatAttacking; },
    get responsePending() { return st.responsePending; },
    get queued() { return st.queued ? { ...st.queued } : null; },
    get lastTarget() { return st.lastTarget; },
    get lastPower() { return st.lastPower; },

    /** The user path sent TargetedMelee/MissileAttack (`ExecuteAttack(h, 1)`). */
    noteSend({ selected = 0, target = 0, height = 2, power = 1 } = {}) {
      st.lastSelected = selected >>> 0;
      st.lastTarget = target >>> 0;
      st.lastHeight = height;
      st.lastPower = clamp01(power);
      st.sends += 1;
      if (autoRepeat()) st.repeatAttacking = true;
      st.responsePending = true;
      arm();
    },
    /** A follow-up or drift re-send: `requestedAttackPower = power`. The
     *  pending flag is left as it is (EndAttackRequest's second send keeps
     *  it; HandleAttackDoneEvent's `ExecuteAttack(h, 0)` leaves it clear). */
    noteFollowUp({ height = st.lastHeight, power = st.lastPower } = {}) {
      st.lastHeight = height;
      st.lastPower = clamp01(power);
      if (autoRepeat()) st.repeatAttacking = true;
    },
    /** CombatCommenceAttack — the server is swinging, so a reply is pending. */
    noteCommence() {
      st.responsePending = true;
      arm();
    },
    /** True when a press must wait for AttackDone. `lockout` is the old
     *  `attackInProgress` bool, which still gates as before. */
    shouldQueue(lockout) {
      return !!lockout || st.responsePending;
    },
    /** `EndAttackRequest` while pending → attackWhenResponseReceived. The
     *  latest press wins. */
    queue(height, power) {
      st.queued = { height, power: clamp01(power) };
      if (timer == null) arm();
    },
    hasQueued() { return st.queued != null; },

    /**
     * `HandleAttackDoneEvent` (:409200).
     * @returns {{ended:boolean, stale:boolean, resent:boolean, replaying:boolean}}
     *   `ended` = a non-zero AttackDone (the chain is over: the meter resets).
     *   `stale` = the ActionCancelled of our own CancelAttack, arriving after
     *   the next attack was sent; that new attack's state is left alone.
     */
    onAttackDone(error) {
      const isErr = attackDoneIsError(error);
      if (isErr && st.staleEnd) {
        const s = st.staleEnd;
        st.staleEnd = null;
        if (now() - s.at <= STALE_END_TTL_MS && st.sends > s.sends) {
          return { ended: false, stale: true, resent: false, replaying: false };
        }
      }
      disarm();
      st.responsePending = false;
      // Pop the queue first. Otherwise the drift re-send below would look
      // like the follow-up of a queued press (which picking.js holds back).
      const q = st.queued;
      st.queued = null;
      if (isErr && st.repeatAttacking) st.repeatAttacking = false;
      let resent = false;
      if (!isBuilding() && autoRepeat() && st.repeatAttacking) {
        const slider = getSlider();
        if (Math.abs(st.lastPower - slider) > POWER_EPSILON) {
          st.lastPower = slider;
          resend(st.lastHeight, slider);
          resent = true;
        }
      }
      if (!autoRepeat() || !st.repeatAttacking) st.repeatAttacking = false;
      if (q) defer(() => replay(q));
      return { ended: isErr, stale: false, resent, replaying: !!q };
    },

    /**
     * `RecvNotice_SelectionChanged` (:408741) for a non-zero selection.
     * Another object selected while repeating → CancelAttack and the repeat
     * ends. The same target (or its wielded weapon's redirect), or a
     * same-guid T9 LOD respawn, cancels nothing.
     * @returns {boolean} true when a cancel was due.
     */
    selectionChanged(guid, { lodRespawn = false } = {}) {
      const g = (guid >>> 0) || 0;
      if (g === 0 || lodRespawn) return false;
      if (!st.repeatAttacking || !autoRepeat()) return false;
      if (g === st.lastSelected || g === st.lastTarget) return false;
      st.repeatAttacking = false;
      if (sendCancel()) expectStaleEnd();
      return true;
    },

    /** `CommenceJump` (:408033): a jump `charge_jump` accepts, with Repeat
     *  Attacks on, sends CancelAttack and ends the repeat. Gated here on a
     *  live repeat. ACE's CancelAttack also cancels a server MoveTo. */
    jumpCommenced(accepted) {
      if (!accepted || !st.repeatAttacking || !autoRepeat()) return false;
      st.repeatAttacking = false;
      if (sendCancel()) expectStaleEnd();
      return true;
    },

    /** The repeat ends without a CancelAttack from here (a deselect, before
     *  its throttled cancel). @returns {boolean} whether a chain was live. */
    endRepeat() {
      const live = st.repeatAttacking || st.responsePending;
      st.repeatAttacking = false;
      return live;
    },

    /** Another path sent CancelAttack (a deselect, a movement key). The reply
     *  is only expected when a chain was live: with nothing running, ACE
     *  answers nothing. */
    noteCancelSent(wasLive = st.repeatAttacking || st.responsePending) {
      st.repeatAttacking = false;
      if (wasLive) expectStaleEnd();
    },

    /** Ack-loss safety: the reply never came. Drop the pending flag and
     *  replay any queued press. */
    expire() {
      timer = null;
      const q = st.queued;
      if (!st.responsePending && !q) return false;
      st.responsePending = false;
      st.queued = null;
      if (q) replay(q);
      return true;
    },

    reset() {
      disarm();
      st.repeatAttacking = false;
      st.responsePending = false;
      st.queued = null;
      st.staleEnd = null;
    },
  };
  return api;
}
