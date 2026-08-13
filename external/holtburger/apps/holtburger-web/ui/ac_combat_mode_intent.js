// ac_combat_mode_intent.js — a client-side mirror of ACE's `LastCombatMode`
// (2026-08-13, ledger C8 / DEC-2).
//
// WHY THIS EXISTS. ACE rejects a combat action whose combat mode does not
// match, IDENTICALLY in all three lanes, and the rejection is SILENT — a bare
// `UseDone` with WeenieError `None`, no text, no motion, only a server-side
// WARN:
//   Magic   `Player_Magic.cs:83-94`   HandleActionCastTargetedSpell
//   Magic   `Player_Magic.cs:275-283` HandleActionMagicCastUnTargetedSpell
//   Melee   `Player_Melee.cs:55-66`   HandleActionTargetedMeleeAttack
//   Missile `Player_Missile.cs:44-52` HandleActionTargetedMissileAttack
// The laptop's ACE_Log.txt carries real instances of both the magic and the
// melee form. Melee/missile are already gated client-side with visible
// feedback (`scene3d/picking.js` `fireAttackOnSelectedTarget` — "You are not
// in melee or missile combat mode."); the CAST path had no such gate, so a
// spell fired from the hotbar while in Peace mode vanished with no feedback
// at all.
//
// WHY NOT JUST READ `combatMode()`. ACE's check has a SECOND arm:
//
//     if (CombatMode != CombatMode.Magic) {
//         log.Warn(…);
//         if (LastCombatMode == CombatMode.Magic) CombatMode = CombatMode.Magic;
//         else { SendUseDoneEvent(); return; }
//     }
//
// `LastCombatMode` is stamped at REQUEST time — `Player_Combat.cs:762`
// `LastCombatMode = newCombatMode;` runs in `HandleActionChangeCombatMode`
// BEFORE `HandleActionChangeCombatMode_Inner`, which may itself be deferred
// behind `NextUseTime` on an ActionChain. So there is a real window in which
// the server will HAPPILY accept a cast that `CombatMode` says should fail:
// exactly the "toggle to Magic, then immediately cast" pattern (the fastcast
// muscle memory in the owner's §H notes). Our `combatMode()` getter is fed by
// `PropertyInt::CombatMode` pushes, i.e. it tracks ACE's *confirmed*
// `CombatMode` and is stale for that whole window.
//
// A client gate that only read `combatMode()` would therefore EAT casts the
// server would have accepted — trading a silent no-op for a worse one. This
// module mirrors the other arm: every place the client ASKS for a combat-mode
// change stamps its intent here, and the gate stays open whenever the intent
// says Magic (or is simply unknown).
//
// DEC-2 COMPLIANCE. This never CHANGES combat mode. Retail never switches
// combat mode as part of casting (`acclient.c` — no `ClientCombatSystem::
// SetCombatMode` call site anywhere on the cast path), so auto-switching would
// be a non-retail invention. This only decides whether to SEND, and what to
// tell the player.

/** Retail combat-mode bit values (`acclient.h` eCombatMode / ACE `CombatMode`). */
export const COMBAT_MODE_NON_COMBAT = 1;
export const COMBAT_MODE_MELEE = 2;
export const COMBAT_MODE_MISSILE = 4;
export const COMBAT_MODE_MAGIC = 8;

/** `MotionStance::Magic` low-16 — the stance that pairs with Magic mode. */
export const MAGIC_STANCE_LOW = 0x49;

// `null` = never requested / requested via an untyped toggle whose resulting
// mode we cannot know. Both read as "unknown", which is fail-OPEN.
let _lastRequestedMode = null;

/**
 * Stamp the client's intent, mirroring ACE `Player_Combat.cs:762`.
 * Call this at every site that sends a combat-mode change.
 *
 * @param {number|null} mode one of the COMBAT_MODE_* values, or `null` when
 *   the request was an untyped `toggleCombatMode()` whose outcome the server
 *   picks (`get_suggested_combat_mode`) — recorded as "unknown", fail-open.
 */
export function noteCombatModeRequest(mode) {
  const m = Number.isFinite(mode) ? (mode >>> 0) : null;
  _lastRequestedMode = m || null;
}

/** The last mode the client asked for, or `null` if unknown. */
export function lastRequestedCombatMode() {
  return _lastRequestedMode;
}

/**
 * TRUE only when we can positively determine that a cast would be silently
 * eaten by `Player_Magic.cs:83-94`. Every uncertainty resolves to FALSE
 * (= send it anyway) — the send stays authoritative, exactly the fail-open
 * discipline `castPrecheckMode()` already uses for components/mana.
 *
 * Blocks iff ALL of:
 *   • the server-confirmed combat mode is known and is NOT Magic, AND
 *   • the server-confirmed stance is known and is NOT the Magic stance
 *     (a confirmed Magic stance means ACE's own `CurrentStyle` is Magic —
 *     never contradict it), AND
 *   • the client's own last combat-mode REQUEST is known and was not Magic
 *     (ACE's `LastCombatMode` escape hatch — see the header). An unknown
 *     request (never toggled, or an untyped `toggleCombatMode()`) is
 *     fail-open: a pending Magic request that `combatMode()` has not caught
 *     up with must never cost the player a cast.
 */
export function castWouldBeSilentlyRejected(opts = {}) {
  const w = (typeof window !== "undefined") ? window : {};
  const handle = opts.handle ?? w.__sessionHandle ?? null;

  let mode = null;
  try {
    if (typeof handle?.combatMode === "function") mode = handle.combatMode() >>> 0;
  } catch (_) { return false; } // a throwing getter is not evidence
  if (!Number.isFinite(mode) || mode === 0) return false;
  if (mode === COMBAT_MODE_MAGIC) return false;

  let stance = null;
  try {
    const f = opts.getStanceLow ?? w.__getCurrentStanceLow;
    if (typeof f === "function") stance = f() >>> 0;
  } catch (_) { return false; }
  // Stance 0 / unknown = no confirmed UpdateMotion yet → no evidence.
  if (!Number.isFinite(stance) || stance === 0) return false;
  if (stance === MAGIC_STANCE_LOW) return false;

  // ACE's LastCombatMode arm.
  if (_lastRequestedMode === null) return false;
  if (_lastRequestedMode === COMBAT_MODE_MAGIC) return false;

  return true;
}

/** Test seam — reset the intent mirror. */
export function __resetCombatModeIntent() {
  _lastRequestedMode = null;
}
