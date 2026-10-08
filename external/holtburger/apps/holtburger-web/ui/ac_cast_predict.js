// =============================================================================
// spellcast-4 (2026-10-08) — local cast-prediction gate (pure, no DOM/wasm)
// =============================================================================
//
// Retail tracks "busy" as a count of outstanding requests, not a time window:
// ClientMagicSystem::CastSpell always sends and then calls
// ClientUISystem::IncrementBusyCount (acclient.c:401885, m_cBusy + 1), and
// Handle_Item__UseDone (:401924) decrements once per UseDone, error or not.
// Vanilla ACE (spellcast_recoil_queue = false) answers a cast sent while another
// is in flight or recoiling with UseDone(YoureTooBusy), so a local windup for
// that second cast is a phantom: it cuts off the real chain while ACE keeps
// casting the first spell.
//
// The wasm already keeps the m_cBusy analog: SessionHandle.getBusyState()
// (+1 at castTargetedSpell / castUntargetedSpell / useObject, -1 on every
// UseDone, a 15 s self-heal). Local cast senders read it BEFORE the send
// (readBusyCount) and hand it to EntityManager.playCastSequence as
// `opts.busyBefore`; when a request was already outstanding the chain is not
// predicted and the server's own gesture echo animates any cast it accepts.

/** SessionHandle.getBusyState(), or undefined when the handle / export is
 *  missing (older pkg) or throws. Read it before sending the cast. */
export function readBusyCount(handle) {
  try {
    const n = handle?.getBusyState?.();
    return Number.isFinite(n) ? n : undefined;
  } catch (_) {
    return undefined;
  }
}

/**
 * Why a local cast chain should NOT be predicted, or null to predict it.
 *  - countOn (?castBusyCount) with a known busyBefore: suppress only when a
 *    request was already outstanding ("busyOutstanding").
 *  - otherwise (remote caster, old wasm, flag off): the F8-4 time window —
 *    a repeat inside the chain's estimated duration ("busyWindow"); with
 *    ?castBusyScope only a repeat of the same spell counts (`sameSpell`).
 */
export function castSuppressReason({ countOn, busyBefore, sameSpell, busyUntilMs, nowMs }) {
  if (countOn && Number.isFinite(busyBefore)) {
    return busyBefore > 0 ? "busyOutstanding" : null;
  }
  if (sameSpell && busyUntilMs && nowMs < busyUntilMs) return "busyWindow";
  return null;
}
