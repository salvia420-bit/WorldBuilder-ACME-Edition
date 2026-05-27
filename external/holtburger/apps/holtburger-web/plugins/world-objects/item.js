/**
 * Item — extends WorldObject.
 *
 * 1:1 port of `external/chorizite/ACPlugin/API/WorldObjects/Item.cs` (vendored
 * HEAD 1341660). Adds the typed Item surface that PR 1's WorldObject base
 * couldn't carry (since Statics/Doors/Portals don't have stack/burden/spell
 * semantics). Per handoff §3 hierarchy gotchas:
 *   - Item extends WorldObject directly
 *   - Container extends Item (so it inherits all Item semantics)
 *   - Door/Portal/Lifestone/Bindstone/Corpse/Static do NOT extend Item
 *
 * Citations of `Item.cs:LLL` are file:line into
 * `external/chorizite/ACPlugin/API/WorldObjects/Item.cs`.
 */

import { WorldObject } from './world_object.js';

// PropertyInt / PropertyInstanceId / PropertyDataId keys used here.
// Sourced from `crates/holtburger-common/src/properties/property_keys/`.
// Mirroring the same constants WorldObject inlines so PR-3 doesn't import
// a giant header but stays drift-locked.
const PROP_INT_MAX_STACK_SIZE         = 11;       // Item.cs:15
const PROP_INT_ATTUNED                = 114;      // Item.cs:20  PropertyInt.Attuned
const PROP_INT_BONDED                 = 33;       // Item.cs:25  PropertyInt.Bonded
const PROP_INT_ENCUMBRANCE_VAL        = 5;        // Item.cs:58  PropertyInt.EncumbranceVal
const PROP_INT_ITEM_WORKMANSHIP       = 105;      // Item.cs:64  PropertyInt.ItemWorkmanship

const PROP_INSTANCE_CONTAINER         = 2;        // Item.cs:46  PropertyInstanceId.Container

const PROP_DATA_ICON_OVERLAY_SECONDARY = 51;      // Item.cs:52  PropertyDataId.IconOverlaySecondary

// LayeredSpellId.Layer discriminator for "active enchantment" (vs cast-on
// spell). Source: `Item.cs:80` (`spellId.Layer == 0x8000`).
const LAYER_ENCHANTMENT = 0x8000;

export class Item extends WorldObject {
  constructor(...args) {
    super(...args);

    /**
     * The id of the spell this item casts, if any. Single uint (NOT a layered
     * spell id — that's `spellIds`). Mirrors `Item.cs:30`. Defaults to 0
     * (no cast-on spell).
     * @type {number}
     */
    this.spellId = 0;

    /**
     * Cast-on spells. Filled by `updateSpells()` after an Item_SetAppraiseInfo
     * arrives. Mirrors `Item.cs:35`. Each entry is `{id, layer}` (matching
     * `Chorizite.ACProtocol.Types.LayeredSpellId`).
     * @type {Array<{id: number, layer: number}>}
     */
    this.spellIds = [];

    /**
     * Active enchantments on this item (layer 0x8000 entries). Mirrors
     * `Item.cs:40`. Same shape as `spellIds`.
     * @type {Array<{id: number, layer: number}>}
     */
    this.enchantmentIds = [];
  }

  /**
   * True if this item is stackable. Mirrors `Item.cs:15`:
   *   `Value(PropertyInt.MaxStackSize, 1) != 1`
   * Note the default is `1` not `0` — MaxStackSize unset means "no stack".
   */
  get isStackable() {
    return this.intValue(PROP_INT_MAX_STACK_SIZE, 1) !== 1;
  }

  /**
   * True if this item is attuned (can't be dropped / given to others).
   * Mirrors `Item.cs:20`: `Value(PropertyInt.Attuned) != 0`.
   */
  get isAttuned() {
    return this.intValue(PROP_INT_ATTUNED, 0) !== 0;
  }

  /**
   * True if this item is bonded (not dropped on death).
   * Mirrors `Item.cs:25`: `Value(PropertyInt.Bonded) != 0`.
   */
  get isBonded() {
    return this.intValue(PROP_INT_BONDED, 0) !== 0;
  }

  /**
   * Burden — `PropertyInt.EncumbranceVal`. Mirrors `Item.cs:58`.
   * Returns 0 when unset.
   */
  get burden() {
    return this.intValue(PROP_INT_ENCUMBRANCE_VAL, 0);
  }

  /**
   * Workmanship — `PropertyInt.ItemWorkmanship`. Mirrors `Item.cs:64`.
   * Returns 0 when unset.
   */
  get itemWorkmanship() {
    return this.intValue(PROP_INT_ITEM_WORKMANSHIP, 0);
  }

  /**
   * Icon effect bitfield (border highlights, magic glow, etc.).
   * Mirrors `Item.cs:52`: `(UiEffects)Value(PropertyDataId.IconOverlaySecondary)`.
   * Stored as a raw uint; downstream code casts to the `UiEffects` enum.
   * Returns 0 when unset.
   */
  get uiEffects() {
    return this.dataValue(PROP_DATA_ICON_OVERLAY_SECONDARY, 0);
  }

  /**
   * The parent container, if any. Read-through lookup-on-read (NOT a
   * maintained map — re-resolves every access). Mirrors `Item.cs:46`:
   *   `World.Get(Value(PropertyInstanceId.Container)) as Container`
   *
   * Returns null when:
   *   - PropertyInstanceId.Container isn't set (item is at ground/world)
   *   - the container guid isn't in scope (forward reference not yet resolved)
   *   - the looked-up weenie isn't actually a Container subclass
   *
   * @returns {object|null} Container subclass instance, or null
   */
  get parentContainer() {
    const containerGuid = this.instanceValue(PROP_INSTANCE_CONTAINER, 0);
    if (!containerGuid) return null;
    const wo = this._lookupWeenie(containerGuid);
    if (!wo) return null;
    // Type-check: only return if it's actually a Container (or a subclass).
    // The C# `as Container` returns null on a class-cast mismatch; we mirror.
    // Static-import would create a cycle; we duck-type instead (Container has
    // a `containerType` field added in container.js).
    return Item._isContainer(wo) ? wo : null;
  }

  /**
   * Whether this item lives inside the local player's inventory (main
   * pack OR one of the equipped side packs). Mirrors `Item.cs:70`:
   *   `ParentContainer?.Id == Character.Id ||
   *    ParentContainer?.ParentContainer?.Id == Character.Id`
   *
   * Reads the local-character id from any of (in order; first nonzero wins):
   *   1. `_world.character.id`        — PR 4 typed Character instance
   *   2. `_world._localPlayerGuid`    — PR 4 raw GUID set before character lands
   *   3. `_world.localCharacterId`    — generic injection point for tests / future flows
   *   4. `_world.client?.player?.character?.id` — defensive client.player path
   *
   * Returns false when none of those resolve to a nonzero GUID.
   */
  get isOwnedByMe() {
    const w = this._world;
    if (!w) return false;
    // Manual ladder (NOT `??`) because `_localPlayerGuid=0` is the "unset"
    // sentinel and we need to skip 0 explicitly to fall through to
    // `localCharacterId`. `0 ?? x` returns 0, not x.
    let localId = (w.character?.id) >>> 0;
    if (!localId) localId = (w._localPlayerGuid ?? 0) >>> 0;
    if (!localId) localId = (w.localCharacterId ?? 0) >>> 0;
    if (!localId) localId = (w.client?.player?.character?.id ?? 0) >>> 0;
    if (!localId) return false;
    const parent = this.parentContainer;
    if (!parent) return false;
    if (parent.id === localId) return true;
    const grandparent = parent.parentContainer;
    return grandparent?.id === localId;
  }

  /**
   * Split a flat list of layered spell ids into the cast-on (`spellIds`) and
   * enchantment (`enchantmentIds`) buckets, by `Layer == 0x8000`. Mirrors
   * `Item.cs:72-87` `UpdateSpells(List<LayeredSpellId> spellBook)`.
   *
   * Idempotent: clears both buckets before re-fanning. Pass null/undefined
   * to no-op (matches C#'s `if (spellBook == null) return`).
   *
   * Caller is the appraisal-folding path in `world-state.js`
   * (`dispatchSetAppraiseInfo`), which receives the layered spell book
   * from the `Item_SetAppraiseInfo` payload (`spellBook` field).
   *
   * @param {Array<{id?: number, Id?: number, layer?: number, Layer?: number}>|null} spellBook
   */
  updateSpells(spellBook) {
    if (!Array.isArray(spellBook)) return;
    this.spellIds.length = 0;
    this.enchantmentIds.length = 0;
    for (const raw of spellBook) {
      const id = (raw.id ?? raw.Id ?? 0) >>> 0;
      const layer = (raw.layer ?? raw.Layer ?? 0) >>> 0;
      const entry = { id, layer };
      if (layer === LAYER_ENCHANTMENT) {
        this.enchantmentIds.push(entry);
      } else {
        this.spellIds.push(entry);
      }
    }
  }

  /**
   * Duck-type test for Container-ness without importing Container (which
   * would create a circular import cycle Item → Container → Item).
   * Container subclass instances expose a `containerType` instance field
   * (added via the Container ctor per `Container.cs:26`) AND an `items`
   * getter on their prototype.
   *
   * `Static`/`Door`/`Portal`/`Lifestone`/`Bindstone`/`Corpse` extend
   * `WorldObject` directly (handoff §3) so they have neither — they
   * correctly fail this duck-type check.
   *
   * @param {*} wo
   * @returns {boolean}
   */
  static _isContainer(wo) {
    if (!wo) return false;
    return 'containerType' in wo && 'items' in wo;
  }
}
