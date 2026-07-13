// WS08 (2026-07-12) — classify a spell-cast WeenieError code for the client
// cast-state machine. Import-free so it unit-tests under node without three.js.
//
// Retail truth: ClientUISystem::Handle_Item__UseDone (acclient.c:401924) does
// `m_cBusy--` UNCONDITIONALLY on every UseDone (:401931) — a non-zero error only
// adds a failure toast (`if (etype)` :401934). Our wasm splits UseDone(error) to
// ClientEvent kind=13 (src/lib.rs UseDone->kind=13 arm) and only kind=14 clears
// the F8-4 busy window, so the JS layer must re-apply "any cast reject frees the
// cast" for the error case. Codes: ACE.Entity/Enum/WeenieError.cs (verified
// 2026-07-12; all 12 name->hex mappings re-confirmed in the WS08 verdict).
//
// A terminal reject means: cancel the optimistic local cast prediction (stop the
// windup / suppress the false success glow) AND free the busy window so a
// CORRECTED recast isn't eaten. The index.html handler additionally gates this on
// a local cast actually being in flight, so non-cast reuse of a shared code
// (e.g. MissileOutOfRange 0x0550 on a far door) can't cut a phantom cast.
const CAST_TERMINAL_REJECTS = new Set([
  0x000f, // BadCast                     (DoCastSpell null-state, Player_Magic.cs:709)
  0x03fc, // MagicInvalidSpellType       (VerifySpell,            :131/400)
  0x0400, // YouDontHaveAllTheComponents (ValidateSpell,          :406)
  0x0401, // YouDontHaveEnoughManaToCast (CalculateManaUsage,     :583)
  0x0407, // YourSpellCannotBeCastOutside(VerifySpellRange,       :521)
  0x0408, // YourSpellCannotBeCastInside (VerifySpellRange,       :513)
  0x042c, // TargetNotAcquired           (GetTargetCategory null, :139/177/201 — the
          //                              PRE-windup shape reaches us as UseDone(error);
          //                              the POST-windup one arrives as WeenieError->kind=2
          //                              then UseDone(None)->kind=14, harmlessly cleared)
  0x0498, // YouHaveMovedTooFar          (VerifyCastRadius). NOTE: dead in our vanilla
          //                              ACE — its only ref (Player_Magic.cs:876) is
          //                              commented out; moved-too-far actually fizzles via
          //                              FailCast->UseDone(YourSpellFizzled 0x0402), caught
          //                              by the fizzle branch. Kept for forward-compat /
          //                              other server builds; harmless (never sent here).
  0x04eb, // YouCantDoThatWhileInTheAir  (IsJumping,              :107/298)
  0x0550, // MissileOutOfRange           (spell range, VerifySpellRange, :504)
]);

// Deliberately EXCLUDED:
//   0x0402 YourSpellFizzled — handled by the ?castFizzle block (cancel at cast-
//          gesture end; the fizzle's trailing UseDone(None)->kind=14 clears busy).
//          Note fizzle has TWO delivery shapes: the skill-roll fail arrives as
//          WeenieError 0x028A(0x0402)->kind=13, and the windup-radius-disruption
//          FailCast (Player_Magic.cs:1321) as UseDone(0x0402)->kind=13; both carry
//          errCode 0x0402 so the existing `if (errCode === 0x0402)` branch owns them.
//   0x001D YoureTooBusy — the PREVIOUS cast is still in flight (VerifyBusy short-
//          circuits before per-cast checks); cancelling would kill the live cast.
export function isTerminalCastReject(code) {
  return CAST_TERMINAL_REJECTS.has(code >>> 0);
}

// WS08b (2026-07-13) — pure decision for the index.html kind=13 reject handler:
// should a terminal cast-reject cancel the local optimistic cast prediction?
//
// Round-4c defect: a GENUINE terminal reject (TargetNotAcquired 0x042C, via a
// removed target) reached the client mid-windup, but `cancelCastSequence` never
// fired — the handler gated on `nowMs < inst._castBusyUntilMs`, and that busy
// window is sized from the gesture's JSON `durationS` ESTIMATE (~600 ms), which
// is SHORTER than the actual on-screen windup (the diag showed the cast gesture
// at 482 ms and natural completion at 1224 ms). The reject landed at +874 ms —
// after the busy-window estimate expired but WHILE the windup was still visibly
// running — so `nowMs < busyUntilMs` was false and the windup ran to completion
// (chainsCancelled=0), flashing the false success glow the flag exists to
// suppress.
//
// Fix: gate on a DURABLE in-flight signal — `chainActive`, which entities.js
// holds true for the whole chain (commit → natural end / cancel / clearCastBusy)
// and does NOT expire with the estimate. The busy-window check is kept only as
// an OR-fallback (belt-and-suspenders) so the handler still works if a future
// path sets the window but not the flag. The "in-flight required" gate is what
// keeps a door/melee reuse of a shared code (e.g. 0x0550 MissileOutOfRange) from
// cutting a phantom cast.
//
// @param {object} p
// @param {boolean} p.flagOn        `?castRejectClears=on` (strict opt-in; DEFAULT-OFF)
// @param {number}  p.code          the WeenieError code from UseFailed (kind=13)
// @param {boolean} p.chainActive   inst._castChainActive — a local cast chain is live
// @param {number}  p.busyUntilMs   inst._castBusyUntilMs (0 when unset/cleared)
// @param {number}  p.nowMs         performance.now()
// @returns {boolean} true iff cancelCastSequence(lg,"reject") should fire.
export function shouldClearCastOnReject({ flagOn, code, chainActive, busyUntilMs, nowMs }) {
  if (!flagOn) return false;                       // strict default-OFF opt-in
  if (!isTerminalCastReject(code)) return false;   // not a terminal cast reject (e.g. fizzle 0x0402)
  if (chainActive) return true;                    // durable in-flight signal (the fix)
  // Fallback: the busy window is still open (works even if chainActive was
  // never set by an older/alternate cast path).
  return !!(busyUntilMs && Number.isFinite(nowMs) && nowMs < busyUntilMs);
}
