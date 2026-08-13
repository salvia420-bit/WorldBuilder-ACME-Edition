import { castPrecheckMode, preCheckSpell } from "./ac_cast_precheck.js";
import { castWouldBeSilentlyRejected } from "./ac_combat_mode_intent.js";

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
  // WS14 — optional client pre-cast checks (?castPrecheck, default-OFF). Retail
  // gated COMPONENTS client-side before the send (acclient.c:404710); mana was
  // server-only, so the mana arm (=on) is a deliberate non-retail add. Fail-open
  // (missing data → allow the send): only a POSITIVELY-determined miss blocks.
  // When OFF (default) this is a no-op and behaviour is byte-identical.
  try {
    const pc = castPrecheckMode();
    if (pc !== "off") {
      const fail = preCheckSpell(sid, pc);
      if (fail) {
        const bus = (typeof window !== "undefined") ? window.__pluginClient?.events : null;
        // clientActionRejected → rejection_feedback.js renders the retail
        // string on the shared toast surface (same as the server-reject path).
        try { bus?.emit?.("clientActionRejected", { message: fail }); } catch (_) {}
        try { bus?.emit?.("spellCastRejected", { spellId: sid, casterGuid: (window.getLocalPlayerGuid?.() ?? 0) >>> 0, reason: fail }); } catch (_) {}
        return false; // do NOT send — send stays authoritative only when the flag is off
      }
    }
  } catch (_) { /* a precheck fault never blocks the cast — fail-open */ }
  // C8 (2026-08-13) — DO NOT SEND A CAST ACE WILL SILENTLY EAT.
  // `Player_Magic.cs:83-94` (targeted) and `:275-283` (untargeted) reject a
  // cast made out of Magic mode with a bare `SendUseDoneEvent()` — WeenieError
  // `None`, no text, no motion, only a server-side WARN. The laptop's
  // ACE_Log.txt is full of exactly that (`CombatMode mismatch NonCombat`). The
  // melee/missile lanes have had a visible client-side gate for this since
  // F11-5 (`scene3d/picking.js` `fireAttackOnSelectedTarget` — "You are not in
  // melee or missile combat mode."); the cast lane did not, and the hotbar
  // (`plugins/hotbar.js:739/754`) will happily fire a spell in Peace mode, so
  // the action vanished with NO feedback whatsoever.
  //
  // The predicate is fail-OPEN and mirrors BOTH arms of ACE's check, including
  // the `LastCombatMode` escape hatch — see `ac_combat_mode_intent.js`. It
  // never CHANGES combat mode: retail never touches `SetCombatMode` on the
  // cast path (ledger A5/DEC-2), so auto-switching here would be a non-retail
  // invention.
  try {
    if (castWouldBeSilentlyRejected()) {
      const bus = (typeof window !== "undefined") ? window.__pluginClient?.events : null;
      const message = "You are not in magic combat mode.";
      try { bus?.emit?.("clientActionRejected", { message }); } catch (_) {}
      try {
        bus?.emit?.("spellCastRejected", {
          spellId: sid,
          casterGuid: (window.getLocalPlayerGuid?.() ?? 0) >>> 0,
          reason: message,
        });
      } catch (_) {}
      return false;
    }
  } catch (_) { /* a faulting gate never blocks the cast — fail-open */ }
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
