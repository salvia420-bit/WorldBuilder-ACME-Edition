/** Container — extends Item.
 *
 * 1:1 port of `external/chorizite/ACPlugin/API/WorldObjects/Container.cs`
 * (vendored HEAD 1341660). Adds the typed Container surface:
 *   - `items`: List<WorldObject> — non-container children (`Container.cs:16`)
 *   - `containers`: List<Container> — child containers including foci (`Container.cs:21`)
 *   - `containerType`: ContainerProperties — `Container.cs:26`
 *
 * Per handoff §3 hierarchy:
 *   - Container extends Item (NOT WorldObject — inherits stack/burden/spell semantics)
 *   - Creature extends Container
 *   - Foci extends Container (surprising — handoff §3 calls this out)
 *   - Character extends Container (lives in character.js, PR 4)
 *
 * The C# version exposes `Items`/`Containers` as `List<>` fields that the
 * runtime maintains via OnItem_ServerSaysContainId / OnItem_CreateObject
 * mutations. We mirror as READ-THROUGH GETTERS over the WorldState
 * weenie map (per handoff/§ACPlugin §5 internal patterns: "Container
 * parenting is read-through — `Item.ParentContainer` resolves
 * `World.Get(Value(PropertyInstanceId.Container))` at `Item.cs:46`.
 * Lookup-on-read, not maintained-on-write. Mirror exactly.").
 *
 * Note: C# `Container.cs` keeps both `Items` AND `Containers` as
 * RUNTIME-MAINTAINED lists (the World.cs dispatcher pushes into them on
 * `OnItem_ServerSaysContainId`); BUT the `parentContainer` getter on Item
 * is documented as read-through. We chose read-through for both sides
 * here because it's simpler + avoids the consistency-maintenance bugs the
 * upstream version is prone to. The wire-driven sync (kind=21 / kind=12 /
 * server-says-contain-id) drops into the typed property store (PROP_INSTANCE_CONTAINER)
 * via PR 2's dispatchers, which is the same backing data the read-through
 * getters consult.
 */
import { Item } from './item.js';

// Container child predicate — `PropertyInstanceId.Container` on the child
// weenie points at the parent container's GUID. Sourced from
// `crates/holtburger-common/src/properties/property_keys/ints.rs`.
const PROP_INSTANCE_CONTAINER  = 2;

// PR-2-era capacity properties already shipped here. Keep them for callers
// that read off the type-stub.
const PROP_ITEMS_CAPACITY      = 81;
const PROP_CONTAINERS_CAPACITY = 82;

// `ContainerProperties` enum (Chorizite.Common.Enums.ContainerProperties.cs):
//   None=0, Container=1, Foci=2
// Mirror as numeric constant so callers don't need a separate import.
export const ContainerProperties = Object.freeze({
  None: 0,
  Container: 1,
  Foci: 2,
});

export class Container extends Item {
  constructor(...args) {
    super(...args);

    /**
     * Container type — `ContainerProperties` enum. `None` (0) when neither
     * a true container nor a foci. Set by the wire dispatcher
     * (`World.cs:222-223` propagates the wire's per-child `containerType`
     * onto the child via `item._containerType`; for containers the type
     * lives on the container itself, populated post-WeenieDesc via
     * upstream classification or explicit setter).
     *
     * Mirrors `Container.cs:26` `ContainerType { get; set; }`.
     * @type {number}
     */
    this.containerType = ContainerProperties.None;
  }

  /** Open this container. */
  open() {
    return this.examine();
  }

  /** Maximum inventory slot count, or 0 if not yet known. */
  get itemsCapacity() {
    return this.intValue(PROP_ITEMS_CAPACITY, 0);
  }

  /** Maximum nested-container slot count, or 0 if not yet known. */
  get containersCapacity() {
    return this.intValue(PROP_CONTAINERS_CAPACITY, 0);
  }

  /**
   * Non-container children of this container (recursive=false; this is
   * direct children only). Mirrors `Container.cs:16`:
   *
   *   List<WorldObject> Items
   *     ↑ comment: "child items, excluding containers/equipped, not recursive"
   *
   * Read-through: filters the world's weenie map for entries whose
   * `PropertyInstanceId.Container` equals this container's GUID AND
   * which are NOT themselves containers (because those go in
   * `containers`). The split between `items` and `containers` here
   * mirrors the C# field separation.
   *
   * @returns {Array<object>}
   */
  get items() {
    const out = [];
    for (const wo of this._allWeenies()) {
      if (wo.id === this.id) continue;
      if (wo.instanceValue(PROP_INSTANCE_CONTAINER, 0) !== this.id) continue;
      if (Container._isContainer(wo)) continue;  // goes in `containers`
      out.push(wo);
    }
    return out;
  }

  /**
   * Child containers of this container, including foci. Mirrors
   * `Container.cs:21`:
   *
   *   List<Container> Containers
   *     ↑ comment: "child containers, including foci"
   *
   * Read-through: filters the world's weenie map for entries whose
   * `PropertyInstanceId.Container` equals this container's GUID AND
   * which ARE containers (per `Container._isContainer` duck-type).
   *
   * @returns {Array<Container>}
   */
  get containers() {
    const out = [];
    for (const wo of this._allWeenies()) {
      if (wo.id === this.id) continue;
      if (wo.instanceValue(PROP_INSTANCE_CONTAINER, 0) !== this.id) continue;
      if (!Container._isContainer(wo)) continue;
      out.push(wo);
    }
    return out;
  }

  /**
   * Duck-type test for "is this weenie a Container subclass". Used by
   * `items`/`containers` getters AND mirrored on `Item._isContainer` for
   * the `parentContainer` getter (Item can't import Container — cycle).
   *
   * The presence of `containerType` (set by the Container ctor to
   * ContainerProperties.None) reliably distinguishes Container instances
   * from plain Items / Statics. `Static`/`Door`/`Portal`/`Lifestone`/
   * `Bindstone`/`Corpse` extend `WorldObject` directly (handoff §3), so
   * they have no `containerType` field and correctly fail this check.
   *
   * We use the duck-type form (not `instanceof Container`) for consistency
   * with `Item._isContainer` and to be robust against multiple
   * Container-class instances if hot-reload ever loads the module twice.
   *
   * @param {*} wo
   * @returns {boolean}
   */
  static _isContainer(wo) {
    if (!wo) return false;
    return 'containerType' in wo && 'items' in wo;
  }
}
