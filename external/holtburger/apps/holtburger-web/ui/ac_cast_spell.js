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

// Task C step 5 (2026-07-01) — self-target promotion for SelfTargeted
// spells. ACE's UNTARGETED handler (0x0048) threads `target = null`
// all the way into `DoSpellEffects` (Player_Magic.cs
// CreatePlayerSpell(uint) → SetCastParams(..., target: null) →
// WorldObject_Magic.cs DoSpellEffects's `target != null` gate), so a
// self-buff cast untargeted lands its ENCHANTMENT (HandleCastSpell
// retargets to `this` for IsSelfTargeted) but never broadcasts its
// TargetEffect PlayScript — the buff glow silently vanishes. Casting
// the same spell TARGETED at our own guid takes ACE's
// `TargetCategory.Self` path where target is non-null end-to-end and
// the 0xF755 script broadcasts (live-verified 2026-07-01: scriptId 6
// resolved on the caster with formulaScale speed). Retail did the
// same — self-casts went out targeted at the player's own object.
//
// Returns the local player guid when `spellId` is flagged
// SelfTargeted and the guid is known, else null (genuinely
// untargeted spells — dispels, recalls without the flag — keep the
// 0x0048 opcode). getSpellRecord returns a serde-wasm-bindgen Map;
// accept a plain object defensively for older bundles.
export function selfTargetGuidFor(spellId) {
  try {
    const handle = (typeof window !== "undefined") ? window.__sessionHandle : null;
    const rec = handle?.getSpellRecord?.(spellId >>> 0);
    if (!rec) return null;
    const flags = (rec instanceof Map) ? rec.get("flags") : rec.flags;
    const selfTargeted =
      (flags instanceof Map) ? flags.get("selfTargeted") : flags?.selfTargeted;
    if (selfTargeted !== true) return null;
    const g = (window.getLocalPlayerGuid?.() ?? 0) >>> 0;
    return g || null;
  } catch (_) {
    return null;
  }
}

export function castSpellViaHandle(spellId, targetGuid) {
  const sid = (spellId >>> 0) || 0;
  if (!sid) return false;
  const tgt = (targetGuid == null) ? null : ((targetGuid >>> 0) || 0);
  try {
    const client = (typeof window !== "undefined") ? window.__pluginClient : null;
    if (typeof client?.player?.castSpell === "function") {
      // client.player.castSpell performs the same self-target
      // promotion internally (plugins/api.js) — pass tgt through.
      client.player.castSpell(sid, tgt);
      return true;
    }
  } catch (e) {
    console.warn(`[cast-spell] client.player.castSpell failed, falling back:`, e);
  }
  try {
    const handle = (typeof window !== "undefined") ? window.__sessionHandle : null;
    if (!handle) return false;
    const resolvedTgt = tgt == null ? selfTargetGuidFor(sid) : tgt;
    if (resolvedTgt == null && typeof handle.castUntargetedSpell === "function") {
      handle.castUntargetedSpell(sid);
      return true;
    }
    if (resolvedTgt != null && typeof handle.castTargetedSpell === "function") {
      handle.castTargetedSpell(resolvedTgt, sid);
      return true;
    }
  } catch (e) {
    console.warn(`[cast-spell] sessionHandle cast failed:`, e);
  }
  return false;
}
