// Pure helpers for the inventory window — split out of inventory.js so
// they can be unit-tested in Node without pulling the three.js /
// DOM-bound transitive imports. The DOM-side refresh wrappers in
// inventory.js (refreshAetheriaGating / refreshBurdenText /
// refreshPanelTitle / refreshSlotsView) delegate here for the actual
// decision logic.
//
// All four helpers are direct ports of retail behaviours catalogued
// in the Wave D.1 gmInventoryUI completeness audit
// (docs/wave-d1-inventory-audit-2026-05-27.md):
//
//   - aetheriaSlotIsLocked   gmPaperDollUI::UpdateAetheria
//                            (ACBindings gmPaperDollUI.cs:217-222)
//   - formatBurdenText       gmBackpackUI::SetLoadLevel
//                            (ACBindings gmBackpackUI.cs:151-156)
//                            numeric-label leg
//   - computeInventoryTitle  gmInventoryUI::RecvNotice_NewParentContainer
//                            (ACBindings gmInventoryUI.cs:218-223)
//   - parseSlotsViewChecked  gmPaperDollUI::m_SlotCheckbox state
//                            (ACBindings gmPaperDollUI.cs:134, retail
//                            wiring at acclient.c:221636,221667,221698)

/**
 * Compute the AetheriaBitfield-based gating decision for a single
 * sigil slot. Bit set in PropertyInt::AetheriaBitfield (322) →
 * unlocked → visible. ACE AetheriaBitfield: Blue=0x1, Yellow=0x2,
 * Red=0x4. Per ACE Player_Properties.cs:1273 the property is REMOVED
 * when value is zero, so an absent property cleanly maps to 0 — no
 * sigils unlocked.
 *
 * @param {number} aetheriaBits  PropertyInt 322 value (u32). Pass 0
 *                               pre-quest / pre-spawn.
 * @param {number} slotBit       One of Blue=0x1, Yellow=0x2, Red=0x4.
 * @returns {boolean} true = locked (hide slot); false = unlocked.
 */
export function aetheriaSlotIsLocked(aetheriaBits, slotBit) {
  const b = (aetheriaBits | 0) >>> 0;
  const m = (slotBit | 0) >>> 0;
  if (m === 0) return false;   // not an aetheria slot; never locked
  return (b & m) === 0;
}

/**
 * Format a burden float (encumbrance / capacity per ACE
 * EncumbranceSystem.GetBurden, 0.0..N) as a percent string.
 *
 * @param {number} burden  0.0..N float. NaN / negative / 0 / Infinity → "—".
 * @returns {{ text: string, over: boolean }} where `over` is true at
 *          or above capacity (>=1.0) so the caller can apply a red
 *          color cue.
 */
export function formatBurdenText(burden) {
  if (!Number.isFinite(burden) || burden <= 0) {
    return { text: "—", over: false };
  }
  // burden is `encumbrance / capacity` so multiply by 100 for a
  // human-readable percentage. Math.round uses half-away-from-zero in
  // JS (unlike C# Math.Round's banker's rounding) — matches retail's
  // text representation (e.g. "85%" not "85.3%").
  const pct = Math.round(burden * 100);
  const over = burden >= 1.0;
  return { text: `${pct}%`, over };
}

/**
 * Compute the inventory panel title for the current container
 * selection. Main pack → "Inventory of <player>"; side pack →
 * "Contents of <pack name>".
 *
 * @param {number} selectedContainerId  Currently selected pack guid (0
 *                                      = main pack).
 * @param {Array<{containerId:number,name:string}|null>} bagSlots  Bag
 *                                      tab slot table; entries are null
 *                                      for empty pack slots.
 * @param {string|null} playerName       Player display name (used in
 *                                      the main-pack title); empty
 *                                      falls back to "Inventory".
 * @returns {string}
 */
export function computeInventoryTitle(selectedContainerId, bagSlots, playerName) {
  if (selectedContainerId !== 0) {
    const slot = bagSlots.find((s) => s && s.containerId === selectedContainerId);
    const packName = slot?.name || "Pack";
    return `Contents of ${packName}`;
  }
  const name = (playerName || "").trim();
  return name ? `Inventory of ${name}` : "Inventory";
}

/**
 * Parse a persisted m_SlotCheckbox state value to a boolean. The
 * retail default (per `acclient.c:221667` —
 * `SetAttribute_Bool(m_SlotCheckbox, 0xE, 0)` at PostInit) is
 * **unchecked** (paperdoll view); we mirror that by treating
 * missing/malformed values as `false`. Only the literal string `"1"`
 * (what we write on toggle-on) flips us into Slots view, so a
 * tampered/garbage localStorage entry can't accidentally hide the
 * paperdoll on next mount.
 *
 * Reading-guide compliance: doc-comments are triage (anti-pattern #2),
 * but the SetAttribute_Bool default-zero call at the constructor's
 * tail is verbatim from acclient.c, not the C# doc-comment — so the
 * unchecked default is spec-grade.
 *
 * @param {string|null|undefined} raw  Value from localStorage.
 * @returns {boolean} true = Slots view (flat list); false = Paperdoll view.
 */
export function parseSlotsViewChecked(raw) {
  return raw === "1";
}
