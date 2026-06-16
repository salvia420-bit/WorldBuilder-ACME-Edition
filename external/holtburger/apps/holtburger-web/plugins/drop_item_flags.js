// Centralized drop-target MIME validator. Mirrors the retail decomp
// `OnItemListDragOver` pattern (acclient_2013.bndb_pseudo_c.txt:174274)
// where each drop target advertises a bitfield of acceptable item
// classes and the dispatcher matches the dragged item's class against
// that bitfield to decide whether to accept the drop.
//
// On the web side, each MIME corresponds to one item class. The
// validator below maps target-flag bits to acceptable MIME strings
// and returns a structured {ok, reason} for the caller to drive the
// drag-over highlight + drop handler short-circuit. Callers stay
// declarative — `validateDragMimeForTarget(dt.types, FLAGS.CONTAINER)`
// instead of three open-coded `types.includes(...)` calls per file.
//
// Adding a new MIME class:
//   1. Append a flag bit to DropItemFlags
//   2. Map the MIME(s) under that flag in MIME_FOR_FLAG
//   3. Targets opt in by OR-ing the flag into their argument
//
// References:
//   - acclient_2013.bndb_pseudo_c.txt:174274 OnItemListDragOver
//   - plugins/inventory.js:1170 application/x-hb-inv-guid (item drag source)
//   - plugins/spellbook.js application/x-hb-spell-id (spell drag source)
//   - plugins/hotbar.js application/x-hb-hotbar-slot (slot-swap source)

/**
 * Bitfield enumeration of drop-target classes. Targets pass an OR-ed
 * combination to validateDragMimeForTarget — e.g. a slot that accepts
 * BOTH inventory items AND spell bindings passes
 * `DropItemFlags.SHORTCUT` (which already covers both).
 */
export const DropItemFlags = Object.freeze({
  NONE:      0x00,
  CONTAINER: 0x01,  // inventory items (drops INTO a pack / corpse / chest)
  VENDOR:    0x02,  // sell stage on vendor overlay
  SHORTCUT:  0x04,  // hotbar slot — items, spells, or slot-swap
  SALVAGE:   0x08,  // salvage panel item queue (reuses inv MIME)
  TRADE:     0x10,  // trade-panel "my side" grid (separate flag so a
                    // future contract-trade-only flow can opt out of it)
});

const INV_MIME       = "application/x-hb-inv-guid";
const INV_TEXT_MIME  = "text/x-hb-item-guid";
const SPELL_MIME     = "application/x-hb-spell-id";
const HOTBAR_MIME    = "application/x-hb-hotbar-slot";

// Per-flag MIME acceptance table. An entry's value is the list of
// MIME strings that satisfy that flag. validateDragMimeForTarget
// iterates the set bits and accepts the first MIME hit.
const MIME_FOR_FLAG = {
  [DropItemFlags.CONTAINER]: [INV_MIME, INV_TEXT_MIME],
  [DropItemFlags.VENDOR]:    [INV_MIME, INV_TEXT_MIME],
  [DropItemFlags.SHORTCUT]:  [SPELL_MIME, INV_MIME, HOTBAR_MIME],
  [DropItemFlags.SALVAGE]:   [INV_MIME, INV_TEXT_MIME],
  [DropItemFlags.TRADE]:     [INV_MIME, INV_TEXT_MIME],
};

/**
 * Validate that a DataTransfer's MIME list satisfies the target's
 * flag bitfield. Returns `{ok, reason, matchedMime}`:
 *   - ok=true / matchedMime=<string> when the drop is accepted
 *   - ok=false / reason=<string> when no MIME matches the flags
 *
 * `types` may be the raw DataTransferItemList (DataTransfer.types) or
 * an array of strings. Both shapes are supported because Firefox /
 * Chromium expose subtly different ergonomics.
 *
 * @param {Iterable<string>} types — dt.types or a string[] copy
 * @param {number} targetFlags — OR of DropItemFlags bits
 * @returns {{ok: boolean, reason: string, matchedMime: string|null}}
 */
export function validateDragMimeForTarget(types, targetFlags) {
  const flags = (targetFlags >>> 0) || 0;
  if (!flags) {
    return { ok: false, reason: "target accepts no MIMEs", matchedMime: null };
  }
  if (!types) {
    return { ok: false, reason: "no DataTransfer", matchedMime: null };
  }
  const set = new Set(Array.from(types));
  if (set.size === 0) {
    return { ok: false, reason: "empty type list", matchedMime: null };
  }
  // Walk every active flag and accept on the first matching MIME.
  for (const key of Object.keys(MIME_FOR_FLAG)) {
    const bit = Number(key);
    if (!bit || (flags & bit) === 0) continue;
    for (const mime of MIME_FOR_FLAG[bit]) {
      if (set.has(mime)) {
        return { ok: true, reason: "", matchedMime: mime };
      }
    }
  }
  return { ok: false, reason: "no matching MIME for target flags", matchedMime: null };
}

/**
 * Convenience shorthand for callers that only need a boolean — same
 * predicate as `validateDragMimeForTarget(...).ok`.
 */
export function isDropAccepted(types, targetFlags) {
  return validateDragMimeForTarget(types, targetFlags).ok;
}
