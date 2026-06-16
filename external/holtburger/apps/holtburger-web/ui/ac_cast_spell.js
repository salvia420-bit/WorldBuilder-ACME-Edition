// Spell-cast dispatcher (Rec #13, 2026-06-16). Tries the plugin-client
// path first (window.__pluginClient.player.castSpell) and falls back to
// the wasm SessionHandle's castUntargetedSpell / castTargetedSpell when
// the plugin-client wiring isn't present — covers dev/preview sessions
// and any plugin-context where ctx.client is null but the session has
// been established (post-login but pre-plugin-wire).
//
// Returns true when a dispatch was issued, false when neither path is
// available (e.g. pre-login). Callers should treat false as "no-op,
// surface a user-facing message" rather than retrying — the failure is
// terminal until the session handle exists.

export function castSpellViaHandle(spellId, targetGuid) {
  const sid = (spellId >>> 0) || 0;
  if (!sid) return false;
  const tgt = (targetGuid == null) ? null : ((targetGuid >>> 0) || 0);
  try {
    const client = (typeof window !== "undefined") ? window.__pluginClient : null;
    if (typeof client?.player?.castSpell === "function") {
      client.player.castSpell(sid, tgt);
      return true;
    }
  } catch (e) {
    console.warn(`[cast-spell] client.player.castSpell failed, falling back:`, e);
  }
  try {
    const handle = (typeof window !== "undefined") ? window.__sessionHandle : null;
    if (!handle) return false;
    if (tgt == null && typeof handle.castUntargetedSpell === "function") {
      handle.castUntargetedSpell(sid);
      return true;
    }
    if (tgt != null && typeof handle.castTargetedSpell === "function") {
      handle.castTargetedSpell(tgt, sid);
      return true;
    }
  } catch (e) {
    console.warn(`[cast-spell] sessionHandle cast failed:`, e);
  }
  return false;
}
