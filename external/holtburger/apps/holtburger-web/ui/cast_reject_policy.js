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
