// ui/portal_busy.js — streaming-teleport-5 (2026-10-08 round 3): the
// portal-space combat-mode refusal.
//
// RETAIL (acclient.c):
//   CPlayerSystem::SetTeleportInProgress (:395704) raises the UI busy count
//   (ClientUISystem::IncrementBusyCount) for the whole portal sequence —
//   gmSmartBoxUI::UseTime sets it on TAS_TUNNEL (:262424) and clears it after
//   the world fade-in (:262571). The busy count only picks the cursor:
//   ClientUISystem::UpdateCursorState (:401743) is the one reader of m_cBusy.
//   ClientCombatSystem::SetCombatMode (0x56BE30, :408787) is the one gameplay
//   reader of teleportInProgress: it refuses any player-requested stance
//   change with "You can't enter combat mode while in portal space" (text
//   type 0x1A, :408840-408845).
//
// OURS: scene3d/portal_space.js publishes `globalThis.__isPortalSpaceActive`
// (true from the tunnel through the world fade-in). This module turns it into
// the combat-mode refusal (index.html key, plugins/api.js, combat-bar,
// target-bar). Uses, casts and drags in the tunnel go to the server, as in
// retail, and ACE refuses them with YoureTooBusy (2026-10-08 resume: the
// round-3 drops of uses / casts / window.__isBusy were removed — retail has
// no such gate).
//
// `?portalBusy=off` (or 0 / false) disables the refusal. No imports.

export const PORTAL_COMBAT_REFUSAL = "You can't enter combat mode while in portal space";
/** holtburger chat category for retail text type 0x1A (transient). */
const CHAT_CATEGORY_TRANSIENT = 9;

let _flag = null;
/** `?portalBusy` — DEFAULT-ON. */
export function portalBusyEnabled(search) {
  if (typeof search === "string") {
    const v = new URLSearchParams(search).get("portalBusy")?.toLowerCase();
    return !(v === "off" || v === "0" || v === "false");
  }
  if (_flag === null) {
    try { _flag = portalBusyEnabled(globalThis.location?.search ?? ""); } catch (_) { _flag = true; }
  }
  return _flag;
}

/** True while the portal tunnel runs (TUNNEL … WORLD_FADEIN). */
export function portalSpaceActive() {
  try { return globalThis.__isPortalSpaceActive?.() === true; } catch (_) { return false; }
}

/** The gate every caller uses: enabled AND in portal space. */
export function portalSpaceBusy() {
  return portalBusyEnabled() && portalSpaceActive();
}

/**
 * ClientCombatSystem::SetCombatMode's portal-space refusal. Returns true when
 * the change was refused (and the retail line printed); false = go ahead.
 */
export function refuseCombatModeInPortalSpace() {
  if (!portalSpaceBusy()) return false;
  try { globalThis.__appendChatLine?.(PORTAL_COMBAT_REFUSAL, CHAT_CATEGORY_TRANSIENT); } catch (_) {}
  return true;
}

/** Test hook: re-read the flag. */
export function _resetPortalBusyForTests() {
  _flag = null;
}

if (typeof globalThis !== "undefined") {
  // index.html's inline key handler cannot import; it calls this.
  globalThis.__refuseCombatModeInPortalSpace = refuseCombatModeInPortalSpace;
  globalThis.__portalSpaceBusy = portalSpaceBusy;
}
