// confirm_reflex.js — WP-14 A1-4: a DARK, flag-off server-confirmation reflex.
//
// AC's server raises modal confirmation dialogs (CharacterConfirmationRequest,
// GameEvent 0x0274) — swear allegiance, alter a skill/attribute, fellowship
// invite, crafting chance-of-success, a generic yes/no. Left unanswered they
// auto-DECLINE after a server timeout. This reflex polls the pending queue
// (TryGetPendingConfirmations) and answers each per a conservative ALLOW-LIST
// of auto-yes confirm types (SendConfirmationResponse, sub-opcode 0x0275).
//
// Policy (operator, binding): AUTO-YES only for allow-listed types; everything
// else is actively DECLINED. We NEVER blindly accept a dialog whose acceptance
// is itself a surprising/irreversible act — allegiance oaths, permanent
// skill/attribute/augmentation changes, fellowship joins, and the catch-all
// YesNo are all excluded. The one default auto-yes is CraftInteraction: that
// dialog is raised by the bot's OWN craft action (its "chance of success"
// prompt), so declining would cancel work the bot chose; auto-yes just lets a
// bot-initiated craft proceed. The allow-list is fully overridable and can be
// emptied (decline-everything) for maximum caution.
//
// Survival invariants:
//   * FLAG-OFF ⇒ NO-OP. Default {enabled:false}: step() does not even poll the
//     host (~0 tokens) and returns {acted:false,reason:"disabled"}.
//   * NEVER THROWS. All host access is guarded; errors degrade to a safe
//     {acted:false,...}.
//   * NOT registered into the live kernel yet (deferred).
//
// BOUNDARY vs rynth/buff_loop.js's B8 (review 02 suspicion, checked and
// re-verified here: NO overlap, NO double-confirm) — the two mechanisms
// answer two DIFFERENT server questions over two DISJOINT host APIs:
//   - buff_loop's B8 confirms that a SELF-BUFF SPELL LANDED, by re-reading
//     the player's own enchantment registry ~600ms after casting (no
//     TryGetPendingConfirmations/SendConfirmationResponse call anywhere in
//     buff_loop.js — verified by grep against the live tree).
//   - This module answers actual server MODAL DIALOGS (Character-
//     ConfirmationRequest, GameEvent 0x0274) via TryGetPendingConfirmations/
//     SendConfirmationResponse (sub-opcode 0x0275) — allegiance, skill/
//     attribute/augmentation changes, fellowship invites, craft
//     chance-of-success, generic yes/no. Casting a buff raises NO such
//     dialog, so there is nothing here for this reflex to answer or race
//     against B8 over.
// Scope going forward: this module's job is confirmation DIALOGS ONLY. It
// must never grow a second, competing "did my buff land" check — that stays
// buff_loop's exclusive job (B8). If a future confirm type is ever found to
// correlate with a buff/spell outcome, that is a signal the boundary above
// has drifted and needs re-verifying before adding it to the allow-list.

// holtburger-common character::ConfirmationType (wire enum 0..=7). These are
// enum-derived constants, not content ids.
export const ConfirmationType = Object.freeze({
  Undefined: 0x00,
  SwearAllegiance: 0x01,
  AlterSkill: 0x02,
  AlterAttribute: 0x03,
  Fellowship: 0x04,
  CraftInteraction: 0x05,
  Augmentation: 0x06,
  YesNo: 0x07,
});

// Conservative default allow-list: ONLY the bot's own crafting CoS dialog.
// (Excludes every social/permanent/unknown type by design — see header.)
export const DEFAULT_AUTO_YES = Object.freeze([ConfirmationType.CraftInteraction]);

export class ConfirmReflex {
  constructor(host, opts = {}) {
    this.host = host;
    this.enabled = opts.enabled ?? false; // dark by default
    // Auto-yes allow-list (Set of confirmType numbers). May be empty.
    const list = opts.autoYes != null ? opts.autoYes : DEFAULT_AUTO_YES;
    this.autoYes = new Set(Array.from(list, (n) => n | 0));
    // Non-allow-listed dialogs: decline them (default, per WP) so the queue is
    // cleared promptly. Set false to leave unknowns alone (they auto-decline
    // server-side / defer to the LLM `confirm` verb).
    this.declineUnknown = opts.declineUnknown ?? true;
    this.now = opts.now || (() => Date.now());
    this.log = opts.log || (() => {});
    this.accepted = 0;
    this.declined = 0;
  }

  /**
   * Poll and answer pending confirmations. NEVER throws.
   * @returns {{acted:boolean, reason?:string, responses?:Array}}
   *   responses: [{ confirmType, context, accepted }]
   */
  step() {
    try {
      if (!this.enabled) return { acted: false, reason: "disabled" };
      const h = this.host;
      if (typeof h?.TryGetPendingConfirmations !== "function" ||
          typeof h?.SendConfirmationResponse !== "function")
        return { acted: false, reason: "unavailable" };

      const list = h.TryGetPendingConfirmations();
      if (!Array.isArray(list) || !list.length) return { acted: false, reason: "none-pending" };

      const responses = [];
      for (const c of list) {
        try {
          const ct = (c?.confirmType ?? c?.confirmationType) | 0;
          const ctx = (c?.context ?? 0) | 0;
          const yes = this.autoYes.has(ct);
          if (!yes && !this.declineUnknown) continue; // leave it for auto-timeout/LLM
          const ok = h.SendConfirmationResponse(ct, ctx, yes);
          if (!ok) continue; // send failed — leave it pending, no throw
          if (yes) this.accepted += 1; else this.declined += 1;
          responses.push({ confirmType: ct, context: ctx, accepted: yes });
          this.log(`confirm ${yes ? "ACCEPT" : "DECLINE"} type=${ct} "${String(c?.text || "").slice(0, 80)}"`);
        } catch { /* one bad dialog must not drop the rest */ }
      }
      if (!responses.length) return { acted: false, reason: "no-actionable" };
      return { acted: true, responses };
    } catch (e) {
      return { acted: false, reason: "error", error: String((e && e.message) || e) };
    }
  }

  get status() {
    return { enabled: this.enabled, autoYes: Array.from(this.autoYes), accepted: this.accepted, declined: this.declined };
  }
}

export default ConfirmReflex;
