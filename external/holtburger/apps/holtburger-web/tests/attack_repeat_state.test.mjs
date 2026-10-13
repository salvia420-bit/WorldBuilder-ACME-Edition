// tests/attack_repeat_state.test.mjs — retail auto-repeat attack lifecycle
// (ui/attack_repeat_state.js, combat-magic-2, 2026-10-13).
//
// Retail ClientCombatSystem (acclient.c): repeatAttacking (ExecuteAttack
// :408626), attackServerResponsePending (ExecuteAttack + HandleCommenceAttack
// :407863), attackWhenResponseReceived (EndAttackRequest :408952), and their
// consumers HandleAttackDoneEvent (:409200), RecvNotice_SelectionChanged
// (:408741) and CommenceJump (:408033).
// The case names follow WebAC tests/verify-attack-charge-build.ts (AGPL-3.0).
//
// The rig below stands in for scene3d/picking.js. `userFire` is fireOnce (the
// lockout / pending gate → queue, else send + noteSend). `followUp` is the
// opts.followUp branch (held while a press is queued, else send +
// noteFollowUp). `attackDone` runs the bus listeners and then the
// microtasks.
//
// Run from apps/holtburger-web/:  node tests/attack_repeat_state.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createAttackRepeatState,
  attackRepeatStateEnabled,
  attackDoneIsError,
  attackDoneMeter,
  PENDING_SAFETY_MS,
} from "../ui/attack_repeat_state.js";
import { decideRelease } from "../ui/attack_power_bar.js";

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err.message}`);
  }
}

const A = 0x80000001;
const B = 0x80000002;
const SWORD = 0x80000101; // A's wielded weapon (GetAttackTarget redirects to A)

function rig({ slider = 0.5, repeat = true, selected = A } = {}) {
  const e = {
    t: 1000,
    slider,
    repeat,
    building: false,
    lockout: false, // __combatBarState.attackInProgress
    throttled: false, // picking.js's 500 ms CancelAttack throttle
    selected,
    sends: [],
    cancels: 0,
    deferred: [],
    timers: [],
  };
  const attackTarget = (g) => (g === SWORD ? A : g);
  // picking.js fireOnce
  e.userFire = (height, power) => {
    if (e.st.shouldQueue(e.lockout)) {
      e.st.queue(height, power);
      return false;
    }
    e.sends.push({ target: attackTarget(e.selected), height, power, followUp: false });
    e.lockout = true;
    e.st.noteSend({ selected: e.selected, target: attackTarget(e.selected), height, power });
    return true;
  };
  // picking.js opts.followUp branch
  e.followUp = (height, power) => {
    if (e.st.hasQueued()) return;
    e.sends.push({ target: attackTarget(e.selected), height, power, followUp: true });
    e.st.noteFollowUp({ height, power });
  };
  e.st = createAttackRepeatState({
    autoRepeat: () => e.repeat,
    getSlider: () => e.slider,
    isBuilding: () => e.building,
    sendCancel: () => {
      if (e.throttled) return false;
      e.cancels += 1;
      return true;
    },
    resend: e.followUp,
    fire: e.userFire,
    defer: (fn) => e.deferred.push(fn),
    now: () => e.t,
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true };
      e.timers.push(t);
      return t;
    },
    clearTimer: (t) => { t.live = false; },
  });
  const flush = () => { for (const fn of e.deferred.splice(0)) fn(); };
  // The bus: the combat-bar lockout clear, then this state's listener, then
  // the microtasks.
  e.attackDone = (error = "None") => {
    e.lockout = false;
    const r = e.st.onAttackDone(error);
    flush();
    return r;
  };
  // The other listener order: the lockout is cleared AFTER this listener.
  e.attackDoneLockoutLast = (error = "None") => {
    const r = e.st.onAttackDone(error);
    e.lockout = false;
    flush();
    return r;
  };
  e.commence = () => e.st.noteCommence(); // kind=19 combatCommenceAttack
  // attack_power_bar's release: fire at the bar, then a follow-up at the
  // selector when the bar went past it.
  e.release = (height, bar) => {
    const d = decideRelease(bar, e.slider);
    if (!d.fireNow) return;
    e.userFire(height, d.power);
    if (d.followUpPower != null) e.followUp(height, d.followUpPower);
  };
  e.liveTimers = () => e.timers.filter((t) => t.live);
  e.fireTimers = () => {
    const live = e.liveTimers();
    for (const t of live) { t.live = false; t.fn(); }
  };
  return e;
}

// ── HandleAttackDoneEvent: the repeat + slider drift ──────────────────────

check("a repeat AttackDone sends nothing while the power matches the slider", () => {
  const e = rig({ slider: 0.5 });
  e.release(1, 1.0);
  // EndAttackRequest: the full bar (1.0), then the slider's 0.5 for ACE's AttackQueue.
  assert.deepEqual(e.sends.map((s) => s.power), [1, 0.5]);
  for (let i = 0; i < 3; i++) {
    e.attackDone("None");
    e.commence();
  }
  assert.equal(e.sends.length, 2, "the server swings the repeats");
  assert.equal(e.st.repeatAttacking, true);
});

check("a slider moved mid-repeat re-sends once at the new power", () => {
  const e = rig({ slider: 0.5 });
  e.release(3, 0.5);
  assert.deepEqual(e.sends, [{ target: A, height: 3, power: 0.5, followUp: false }]);
  e.slider = 0.8;
  const r = e.attackDone("None");
  assert.equal(r.resent, true);
  assert.equal(e.sends.length, 2);
  assert.deepEqual(e.sends[1], { target: A, height: 3, power: 0.8, followUp: true });
  // ExecuteAttack(..., false): no response pending after the re-send.
  assert.equal(e.st.responsePending, false);
  assert.equal(e.st.lastPower, 0.8);
  e.attackDone("None");
  assert.equal(e.sends.length, 2, "within 0.01 of the slider now");
});

check("a drift of 0.01 or less is not a re-send", () => {
  const e = rig({ slider: 0.5 });
  e.release(1, 0.5);
  e.slider = 0.509;
  e.attackDone("None");
  assert.equal(e.sends.length, 1);
  e.slider = 0.52;
  e.attackDone("None");
  assert.equal(e.sends.length, 2);
  assert.equal(e.sends[1].power, 0.52);
});

check("no drift re-send while a key is held, or without Repeat Attacks", () => {
  const e = rig({ slider: 0.5 });
  e.release(1, 0.5);
  e.slider = 0.9;
  e.building = true; // held again: attackRequestInProgress
  e.attackDone("None");
  assert.equal(e.sends.length, 1);

  const g = rig({ slider: 0.5, repeat: false });
  g.release(1, 0.5);
  assert.equal(g.st.repeatAttacking, false, "ExecuteAttack sets repeatAttacking only with the option on");
  g.slider = 0.9;
  g.attackDone("None");
  assert.equal(g.sends.length, 1);
});

check("a non-zero AttackDone (ACE ActionCancelled 0x36) ends the repeat and resets the meter", () => {
  const e = rig({ slider: 0.5 });
  e.release(1, 0.5);
  assert.equal(e.st.repeatAttacking, true);
  e.slider = 0.9; // a drift does not re-send once the chain has ended
  const r = e.attackDone("ActionCancelled");
  assert.equal(r.ended, true);
  assert.equal(r.resent, false);
  assert.equal(e.st.repeatAttacking, false);
  assert.equal(e.st.responsePending, false);
  assert.equal(e.sends.length, 1);
  assert.equal(attackDoneMeter("ActionCancelled"), "reset");
  assert.equal(attackDoneMeter("None"), "ready");
  assert.equal(attackDoneMeter(undefined), "ready");
});

check("attackDoneIsError reads the kind=19 WeenieError names (and raw codes)", () => {
  for (const ok of ["None", undefined, null, "", 0, "0"]) assert.equal(attackDoneIsError(ok), false, String(ok));
  for (const bad of ["ActionCancelled", "YoureTooBusy", "YouCantDoThatWhileInTheAir", 0x36]) {
    assert.equal(attackDoneIsError(bad), true, String(bad));
  }
});

// ── EndAttackRequest while pending: the queue ─────────────────────────────

check("a release while the server is still swinging queues the attack for AttackDone", () => {
  const e = rig({ slider: 0.3 });
  e.release(1, 0.3);
  const n = e.sends.length;
  e.release(3, 0.3);
  assert.equal(e.sends.length, n, "the press is not sent");
  assert.deepEqual(e.st.queued, { height: 3, power: 0.3 });
  e.attackDone("None");
  assert.equal(e.sends.length, n + 1, "AttackDone replays it");
  assert.deepEqual(e.sends[n], { target: A, height: 3, power: 0.3, followUp: false });
  assert.equal(e.st.queued, null);
  assert.equal(e.st.responsePending, true, "the replayed swing is pending again");
});

check("the latest queued press wins", () => {
  const e = rig({ slider: 0.3 });
  e.release(1, 0.3);
  e.release(2, 0.3);
  e.release(3, 0.4); // past the 0.3 selector: its follow-up is held as well
  e.attackDone("None");
  assert.deepEqual(e.sends.slice(1), [
    { target: A, height: 3, power: 0.4, followUp: false },
    { target: A, height: 3, power: 0.3, followUp: true },
  ]);
});

check("a charged release while pending holds its follow-up; the replay sends both", () => {
  const e = rig({ slider: 0.5 });
  e.release(2, 0.5);
  e.release(1, 1.0); // bar past the selector: fire 1.0 + follow-up 0.5, both held
  assert.equal(e.sends.length, 1);
  assert.deepEqual(e.st.queued, { height: 1, power: 1 });
  e.attackDone("None");
  assert.deepEqual(e.sends.slice(1).map((s) => [s.height, s.power, s.followUp]), [[1, 1, false], [1, 0.5, true]]);
  assert.equal(e.st.lastPower, 0.5, "the repeats run at the selector");
});

check("CommenceAttack (kind=19) raises the pending flag between repeat swings", () => {
  const e = rig({ slider: 0.5 });
  e.release(2, 0.5);
  e.attackDone("None"); // the server queued the next swing; nothing pending
  assert.equal(e.st.responsePending, false);
  e.release(1, 0.5); // between swings: sent at once
  assert.equal(e.sends.length, 2);
  e.attackDone("None");
  e.commence(); // the server's next swing
  assert.equal(e.lockout, false, "the old lockout is clear mid-swing");
  e.release(3, 0.5);
  assert.equal(e.sends.length, 2, "queued behind the commence");
  e.attackDone("None");
  assert.equal(e.sends.length, 3);
  assert.equal(e.sends[2].height, 3);
});

check("the replay runs after every AttackDone listener (any listener order)", () => {
  const e = rig({ slider: 0.5 });
  e.release(2, 0.5);
  e.release(3, 0.5);
  e.attackDoneLockoutLast("None");
  assert.equal(e.sends.length, 2, "not re-gated by a lockout another listener clears");
  assert.equal(e.sends[1].height, 3);
});

check("a replay that is refused again stays queued (no follow-up without a send)", () => {
  const e = rig({ slider: 0.5 });
  e.release(2, 0.5);
  e.release(1, 1.0);
  e.st.onAttackDone("None"); // the replay is deferred…
  e.commence(); // …and a commence in the same drain batch lands first
  for (const fn of e.deferred.splice(0)) fn();
  assert.equal(e.sends.length, 1, "nothing sent");
  assert.deepEqual(e.st.queued, { height: 1, power: 1 });
  e.attackDone("None");
  assert.deepEqual(e.sends.slice(1).map((s) => [s.power, s.followUp]), [[1, false], [0.5, true]]);
});

check("the ack-loss safety drops a stale pending reply and replays the queued press", () => {
  const e = rig({ slider: 0.5 });
  e.release(2, 0.5);
  assert.equal(e.liveTimers().length, 1);
  assert.equal(e.liveTimers()[0].ms, PENDING_SAFETY_MS);
  e.release(3, 0.5);
  e.lockout = false; // the combat-bar lockout's own (shorter) timeout fired
  e.fireTimers();
  assert.equal(e.st.responsePending, true, "the replayed press is pending");
  assert.equal(e.sends.length, 2);
  assert.equal(e.sends[1].height, 3);
  e.attackDone("None");
  assert.equal(e.liveTimers().length, 0, "AttackDone disarms the safety");
});

check("a press held only by the old lockout still gets a safety timer", () => {
  const e = rig({ slider: 0.5 });
  e.lockout = true; // e.g. a lockout left over while nothing is pending
  e.release(2, 0.5);
  assert.equal(e.sends.length, 0);
  assert.equal(e.liveTimers().length, 1);
  e.lockout = false;
  e.fireTimers();
  assert.equal(e.sends.length, 1);
});

// ── RecvNotice_SelectionChanged ───────────────────────────────────────────

check("a selection change to a different non-zero guid while repeating emits one cancel", () => {
  const e = rig({ slider: 0.5 });
  e.release(2, 0.5);
  assert.equal(e.st.selectionChanged(B), true);
  assert.equal(e.cancels, 1);
  assert.equal(e.st.repeatAttacking, false);
  assert.equal(e.st.selectionChanged(0x80000003), false, "the repeat is already over");
  assert.equal(e.cancels, 1);
});

check("a same-guid, wielder-redirect, lodRespawn or clear selection change emits none", () => {
  const e = rig({ slider: 0.5 });
  e.release(2, 0.5);
  assert.equal(e.st.selectionChanged(A), false, "same guid");
  assert.equal(e.st.selectionChanged(B, { lodRespawn: true }), false, "T9 LOD respawn");
  assert.equal(e.st.selectionChanged(0), false, "a clear is the deselect arm's job");
  assert.equal(e.cancels, 0);
  assert.equal(e.st.repeatAttacking, true);

  const w = rig({ slider: 0.5, selected: SWORD });
  w.release(2, 0.5); // the monster's weapon selected → attacks the wielder
  assert.equal(w.st.lastTarget, A);
  assert.equal(w.st.selectionChanged(A), false, "selecting the wielder itself");
  assert.equal(w.st.selectionChanged(SWORD), false, "re-selecting the weapon");
  assert.equal(w.cancels, 0);
});

check("no cancel without a live repeat or with Repeat Attacks off", () => {
  const e = rig({ slider: 0.5 });
  assert.equal(e.st.selectionChanged(B), false, "nothing sent yet");
  e.release(2, 0.5);
  e.attackDone("ActionCancelled"); // chain over
  assert.equal(e.st.selectionChanged(B), false);
  const g = rig({ slider: 0.5, repeat: false });
  g.release(2, 0.5);
  assert.equal(g.st.selectionChanged(B), false);
  assert.equal(e.cancels + g.cancels, 0);
});

check("a target switch mid-swing defers the B request until AttackDone", () => {
  const e = rig({ slider: 0.5 });
  e.release(2, 0.5); // attack A
  e.attackDone("None"); // repeat continues
  e.commence(); // ACE is mid-swing on A (Attacking: CancelAttack only flags it)
  e.selected = B;
  assert.equal(e.st.selectionChanged(B), true);
  assert.equal(e.cancels, 1);
  e.release(2, 0.5); // press on B
  assert.equal(e.sends.length, 1, "B's request is not sent behind the cancel");
  e.attackDone("ActionCancelled"); // the cancelled loop's OnAttackDone
  assert.equal(e.sends.length, 2);
  assert.deepEqual(e.sends[1], { target: B, height: 2, power: 0.5, followUp: false });
  assert.equal(e.st.repeatAttacking, true, "the new repeat is on B");
  assert.equal(e.st.lastTarget, B);
});

// ── CommenceJump ─────────────────────────────────────────────────────────

check("a jump cancels only when repeating and accepted", () => {
  const e = rig({ slider: 0.5 });
  assert.equal(e.st.jumpCommenced(true), false, "no repeat yet");
  e.release(2, 0.5);
  assert.equal(e.st.jumpCommenced(false), false, "refused jump (airborne / bad motion)");
  assert.equal(e.st.repeatAttacking, true);
  assert.equal(e.st.jumpCommenced(true), true);
  assert.equal(e.cancels, 1);
  assert.equal(e.st.repeatAttacking, false);
  assert.equal(e.st.jumpCommenced(true), false, "once");
  const g = rig({ slider: 0.5, repeat: false });
  g.release(2, 0.5);
  assert.equal(g.st.jumpCommenced(true), false, "Repeat Attacks off: no CancelAttack");
  assert.equal(e.cancels + g.cancels, 1);
});

// ── rynth: the bot never arms the repeat ─────────────────────────────────

check("bot attacks (server events only, no noteSend) never arm the repeat", () => {
  const e = rig({ slider: 0.5 });
  e.commence(); // the bot's wasm attack → ACE swings → kind=19
  e.attackDone("None");
  e.commence();
  assert.equal(e.st.repeatAttacking, false);
  assert.equal(e.st.selectionChanged(B), false, "SelectObject → selectionChanged cancels nothing");
  assert.equal(e.st.jumpCommenced(true), false);
  e.slider = 0.1;
  e.attackDone("None");
  assert.equal(e.sends.length, 0, "no drift re-send on the bot's loop");
  assert.equal(e.cancels, 0);
});

check("endRepeat / noteCancelSent / reset end the repeat; reset drops the queue", () => {
  const e = rig({ slider: 0.5 });
  e.release(2, 0.5);
  assert.equal(e.st.endRepeat(), true, "a chain was live");
  assert.equal(e.st.repeatAttacking, false);
  e.release(3, 0.5);
  assert.ok(e.st.queued);
  e.st.reset();
  assert.equal(e.st.queued, null);
  assert.equal(e.st.responsePending, false);
  assert.equal(e.liveTimers().length, 0);
  assert.equal(e.st.endRepeat(), false, "nothing live after reset");
  const g = rig({ slider: 0.5 });
  g.release(2, 0.5);
  g.st.noteCancelSent(); // a movement key's CancelAttack
  assert.equal(g.st.repeatAttacking, false);
});

// ── The reply to our own CancelAttack ────────────────────────────────────

check("a target switch between swings: the cancel's ActionCancelled does not end the repeat on B", () => {
  const e = rig({ slider: 0.5 });
  e.release(2, 0.5); // attack A
  e.attackDone("None"); // between swings: nothing pending
  e.selected = B;
  e.st.selectionChanged(B); // CancelAttack → ACE OnAttackDone (reply in flight)
  e.release(2, 0.5); // B is sent at once
  assert.equal(e.sends.length, 2);
  assert.equal(e.sends[1].target, B);
  e.t += 50;
  const r = e.attackDone("ActionCancelled"); // A's chain end, after B went out
  assert.equal(r.stale, true);
  assert.equal(e.st.repeatAttacking, true, "the repeat on B survives");
  assert.equal(e.st.responsePending, true, "B's reply is still pending");
  e.attackDone("None"); // B's first swing
  e.st.selectionChanged(0x80000003); // a second switch still cancels
  assert.equal(e.cancels, 2);
  e.attackDone("ActionCancelled"); // no attack sent since: a normal chain end
  assert.equal(e.st.responsePending, false);
});

check("the stale reply is expected once, within the window, and only after a live chain", () => {
  const e = rig({ slider: 0.5 });
  e.release(2, 0.5);
  e.attackDone("None");
  e.selected = B;
  e.st.selectionChanged(B);
  e.release(2, 0.5);
  e.t += 4000; // past STALE_END_TTL_MS: treated as B's chain end
  const r = e.attackDone("ActionCancelled");
  assert.equal(r.stale, false);
  assert.equal(e.st.repeatAttacking, false);

  const g = rig({ slider: 0.5 });
  g.st.noteCancelSent(); // walking in a combat stance: nothing live, ACE answers nothing
  g.release(2, 0.5);
  const r2 = g.attackDone("ActionCancelled"); // the attack's own refusal
  assert.equal(r2.stale, false);
  assert.equal(g.st.responsePending, false, "presses are not held behind it");

  const h = rig({ slider: 0.5 });
  h.release(2, 0.5);
  h.attackDone("None");
  h.throttled = true; // the cancel did not go out: no reply is coming
  h.selected = B;
  h.st.selectionChanged(B);
  h.release(2, 0.5);
  assert.equal(h.attackDone("ActionCancelled").stale, false);
});

check("a jump's cancel reply does not swallow the refusal of an attack sent in the air", () => {
  const e = rig({ slider: 0.5 });
  e.release(2, 0.5);
  e.attackDone("None");
  e.st.jumpCommenced(true); // CancelAttack
  e.release(2, 0.5); // ACE: YouCantDoThatWhileInTheAir + OnAttackDone
  assert.equal(e.attackDone("ActionCancelled").stale, true, "the cancel's reply");
  assert.equal(e.st.responsePending, true);
  const r = e.attackDone("ActionCancelled"); // the refusal's chain end
  assert.equal(r.stale, false);
  assert.equal(e.st.responsePending, false);
  assert.equal(e.st.repeatAttacking, false);
});

check("?attackRepeatState: default on; off / 0 / false disable", () => {
  assert.equal(attackRepeatStateEnabled(""), true);
  assert.equal(attackRepeatStateEnabled("?attackRepeatState=on"), true);
  for (const v of ["off", "0", "false"]) assert.equal(attackRepeatStateEnabled(`?attackRepeatState=${v}`), false, v);
});

// ── Wiring (scene3d/picking.js and plugins/combat-bar.js need a DOM and three.js) ─

check("picking.js wires the state into the fire gate, the follow-up, selection, jump and the bus", () => {
  const src = readFileSync(new URL("../scene3d/picking.js", import.meta.url), "utf8");
  const fire = src.slice(src.indexOf("function fireAttackOnSelectedTarget("));
  const followUp = fire.slice(fire.indexOf("if (opts?.followUp) {"), fire.indexOf("const fireOnce"));
  assert.ok(followUp.indexOf("if (attackRepeat?.hasQueued()) return;") > 0, "a queued press holds its follow-up");
  assert.ok(followUp.includes("attackRepeat?.noteFollowUp({ height: safeHeight, power: slider })"));
  const once = fire.slice(fire.indexOf("const fireOnce"), fire.indexOf("const inMelee"));
  const gate = once.indexOf("attackRepeat.shouldQueue(liveCb?.attackInProgress)");
  assert.ok(gate > 0 && gate < once.indexOf("cmd();"), "the queue gate precedes the send");
  assert.ok(once.indexOf("attackRepeat.queue(safeHeight, slider)") > gate);
  assert.ok(once.indexOf("attackRepeat?.noteSend(") > once.indexOf("cmd();"), "noteSend after the send");
  const sel = src.slice(src.indexOf("onSelectionCleared = (ev) => {"));
  assert.ok(sel.indexOf("attackRepeat.selectionChanged(d.guid >>> 0, { lodRespawn: !!d.lodRespawn })") > 0);
  assert.ok(sel.indexOf("attackRepeat.selectionChanged(") < sel.indexOf("if (((d.guid >>> 0) || 0) !== 0) return;"));
  const clear = sel.slice(sel.indexOf("if (d.lodRespawn) return;"), sel.indexOf('bus.on("selectionChanged"'));
  assert.ok(clear.indexOf("attackRepeat.endRepeat()") > 0, "a real deselect ends the repeat (after the LOD guard)");
  assert.ok(clear.indexOf("attackRepeat?.noteCancelSent(repeatLive)") > clear.indexOf("sessionHandle.cancelAttack();"), "its sent cancel expects a reply");
  const move = src.slice(src.indexOf("function onKeyDownAbortCharge(ev) {"), src.indexOf("function onKeyDownCancelUseTarget("));
  assert.ok(move.indexOf("attackRepeat?.noteCancelSent()") > move.indexOf("sessionHandle.cancelAttack();"), "the movement cancel too");
  assert.ok(sel.includes('bus.on("attackDone", onRepeatAttackDone)'));
  assert.ok(sel.includes('bus.on("combatCommenceAttack", onRepeatCommence)'));
  assert.ok(sel.includes('bus.off("attackDone", onRepeatAttackDone)'), "torn down on destroy");
  assert.ok(/if \(attackRepeatStateEnabled\(\)\) \{\s*attackRepeat = createAttackRepeatState\(/.test(sel), "?attackRepeatState=off leaves it null");
  const key = src.slice(src.indexOf("function onKeyDownAbortCharge(ev) {"));
  const space = key.indexOf('if (ev.key === " " && attackRepeat && !ev.repeat)');
  assert.ok(space > 0 && space < key.indexOf("const mk = movementKeyOf(ev);"), "the Space arm runs first");
  assert.ok(key.indexOf("attackRepeat.jumpCommenced(accepted)") > space);
  assert.ok(key.slice(space, key.indexOf("attackRepeat.jumpCommenced(accepted)")).includes("sessionHandle.canJumpNow()"));
});

check("combat-bar.js resets the meter on a chain-ending AttackDone (its inlined test matches)", () => {
  const src = readFileSync(new URL("../plugins/combat-bar.js", import.meta.url), "utf8");
  // combat-bar.js inlines the two helpers: spliced plugin tests pin its imports.
  const i = src.indexOf("const chainEnded = (error) =>");
  assert.ok(i > 0, "chainEnded present");
  const expr = src.slice(i + "const chainEnded = ".length, src.indexOf(";\n", i));
  const chainEnded = new Function(`return (${expr});`)();
  for (const v of ["None", "ActionCancelled", "YoureTooBusy", "", "0", 0, 0x36, undefined, null]) {
    assert.equal(chainEnded(v), attackDoneIsError(v), `chainEnded(${String(v)})`);
    assert.equal(chainEnded(v) ? "reset" : "ready", attackDoneMeter(v));
  }
  const j = src.indexOf("const repeatStateOn = (() => {");
  const iife = src.slice(j + "const repeatStateOn = ".length, src.indexOf("})();", j) + "})()".length);
  for (const search of ["", "?attackRepeatState=off", "?attackRepeatState=0", "?attackRepeatState=false", "?attackRepeatState=on"]) {
    const got = new Function("window", `return ${iife};`)({ location: { search } });
    assert.equal(got, attackRepeatStateEnabled(search), `repeatStateOn for "${search}"`);
  }
  const done = src.slice(src.indexOf("const onDone = (ev) => {"));
  assert.ok(done.indexOf("if (repeatStateOn && chainEnded(ev?.detail?.error)) {") > 0);
  assert.ok(done.indexOf('meterFill.style.width = "0%"') < done.indexOf('meterFill.style.width = "100%"'));
});

check("rynth never touches the repeat state (the bot's attacks stay wasm-direct)", () => {
  const webhost = readFileSync(new URL("../rynth/webhost.js", import.meta.url), "utf8");
  const loop = readFileSync(new URL("../rynth/combat_loop.js", import.meta.url), "utf8");
  for (const s of [webhost, loop]) {
    assert.equal(s.includes("attack_repeat_state"), false);
    assert.equal(s.includes("__fireAttackOnTarget"), false);
  }
});

console.log(`\nattack_repeat_state: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
