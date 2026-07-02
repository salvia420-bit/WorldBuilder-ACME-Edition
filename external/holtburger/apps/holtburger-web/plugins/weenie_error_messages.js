// Wave A / PR1 (2026-06-06): WeenieError integer code -> English
// human-readable string. Consumed by PR13's inventory-action-failed
// toast handler (subscribes to kind=48 events emitted by the recv loop
// for `WorldEvent::InventoryActionFailed`). The `_` character in
// WeenieErrorWithString messages is ACE's dynamic-substitution marker
// for NPC/item names — PR13 performs the substitution at display time.
//
// Source of truth:
//   ~/ace-server/Source/ACE.Entity/Enum/WeenieError.cs
//   ~/ace-server/Source/ACE.Entity/Enum/WeenieErrorWithString.cs
//
// English-only by design. Future i18n is a wrap around lookup, not a
// refactor of this map.

export const WEENIE_ERROR_MESSAGES = Object.freeze({
  // --- WeenieError (no-substitution) ---
  0x001D: "You're too busy!",
  0x001E: "_ is too busy to accept gifts.",
  0x0029: "You cannot pick that up!",
  0x0036: "Action cancelled!",
  0x003A: "You're dead!",
  0x0426: "_ cannot be dropped — it is attuned to you.",
  0x0427: "You cannot merge different stacks.",
  0x0428: "You cannot merge enchanted items!",
  0x0453: "You can't do that — that item is being traded.",
  0x0468: "Your skill is too low to use that.",
  0x03EE: "The container is closed.",
  0x03EF: "_ is not accepting gifts right now.",
  0x03F0: "That is not a valid inventory location.",
  0x03F3: "There is already an item in that inventory slot.",
  0x03F5: "You can't pick that up while you're in combat mode.",
  0x04CE: "_ refuses your item.",
  0x0510: "You can hook a maximum number of _ items.",
  0x0514: "You can hook a maximum number of _ items until one is removed.",
  0x0515: "The hook limit for _ is no longer in effect.",
  0x054D: "_ is currently in use.",
  0x058A: "_ cowers from you.",
  0x0594: "You're unable to take that action on this contract.",
  // --- Common general-purpose codes referenced from
  // Player_Commerce.cs / Player_Use.cs that PR13's inventory toast may
  // also surface. ---
  0x0024: "You can't jump while in the air.",
  // --- Spell-cast errors (Task C, 2026-07-01). Retail client texts
  // verified verbatim against the decomp; ACE producer sites in
  // Player_Magic.cs (ValidateSpell / CalculateManaUsage /
  // VerifySpellRange / DoCastSpell_Inner). The wasm recv loop renders
  // the same strings as transient chat (`spellcast_error_text` in
  // src/lib.rs — keep the two maps in sync); these entries serve any
  // JS consumer resolving the kind:13 code directly. ---
  0x0400: "You don't have all the components for this spell.",
  0x0401: "You don't have enough Mana to cast this spell.",
  0x0402: "Your spell fizzled.",
  0x0407: "Your spell cannot be cast outside.",
  0x0408: "Your spell cannot be cast inside.",
  0x0498: "You have moved too far!",
  0x0550: "Out of range!",
  0x04EB: "You can't do that while in the air!",
  // --- WeenieErrorWithString (substitution; _ replaced at display time) ---
  // Codes unique to WeenieErrorWithString that surface in inventory
  // contexts are already covered above by entries that already use the
  // `_` substitution marker (0x001E / 0x03EF / 0x04CE / 0x0510 / 0x0514 /
  // 0x0515 / 0x054D / 0x058A). The two sources are deduped on numeric
  // value; entries listed once cover both call paths.
});

/// Look up an English string for `code`. Falls back to a synthetic
/// `"WeenieError 0x????"` if `code` is unknown so the toast still has
/// SOMETHING to display.
export function weenieErrorMessage(code) {
  const msg = WEENIE_ERROR_MESSAGES[code];
  if (typeof msg === "string") return msg;
  const hex = (code >>> 0).toString(16).toUpperCase().padStart(4, "0");
  return `WeenieError 0x${hex}`;
}
