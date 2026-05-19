# Entity-Completeness Method (typed classification)

Companion to [`world-completeness-method.md`](world-completeness-method.md) (placements) and [`event-completeness-method.md`](event-completeness-method.md) (sounds + particles). This doc covers the third axis: **typed entity classification** — answering "what *kind* of WorldObject is this?" without inventing the answer on the client.

Status: **brief, pending execution.** Written 2026-05-19 in response to a conflict surfaced by the `WorldObjectManager` wire-in (commit `4849864`). If this method captures the architecture and the phase plan looks right, mark it verified; I'll start E.A. If anything looks wrong — especially the fallback discipline or the validator's tolerance — flag it before code starts.

## The conflict that motivated this doc

The `WorldObjectManager` (commit `c7f9fbd`, wired in `4849864`) consumes `pollEntityUpdates()` kind=1 spawn payloads and dispatches them into typed JS classes (Vendor, NPC, Door, MeleeWeapon, etc.) for plugin authors. Today the wasm `EntityUpdate` surface only exposes `itemType`, stripping `objectClass + behavior` that ACE actually ships in `PublicWeenieDesc.Header`. So the JS-side dispatch falls back to a hand-coded ItemType-only heuristic in `plugins/world-objects/get_object_class.js`. All creatures collapse to the generic `Creature` class; Vendor/NPC/Monster discrimination is lost.

That fallback is a **client-side classification of an entity the server already classified**. It's the structural analog of computing scenery from a noise function on the client — the thing `world-completeness-method.md` explicitly rejects as "Procedural-on-client is the bug. Explicit-everywhere is the fix."

This doc defines the contract that resolves the conflict: the renderer's typed class for any entity must trace to authoritative wire (or DAT-baked) data, never to client-side invention.

## The contract

For any entity `e` spawned at any time:

```
typed_class(e) ≡ {
    server_explicit_class(e)        when PublicWeenieDesc.Header.ObjectClass is non-zero
  ∪ dat_baked_class(e)              when ObjectClass is zero AND the Weenie defines ObjectClass deterministically
  ∪ WorldObject                     otherwise (the explicit-unknown sentinel; logged + validator-counted)
}
```

There is **no fourth source**. There is **no heuristic dispatch path** that fires silently. The current `get_object_class.js` heuristic dispatch is **explicitly removed** from the normal flow and either deleted or demoted to a debugger-only utility (see §5).

This mirrors the world-completeness contract's three-source rule plus its "no procedural fallback" disciplinary. The renderer/plugin author can rely on `wo.constructor.name === 'Vendor'` matching what the server thinks `wo` is, or get an explicit `WorldObject` they know is unclassified.

## The two classification sources

### C1 — Wire-explicit (server-authoritative `PublicWeenieDesc.Header`)

ACE wire frame: every `CreateObject` / `Item_CreateObject` packet carries a `PublicWeenieDesc` bundle. The bundle's `Header` bitfield contains `ObjectClass` (an enum value matching `Chorizite.Common.Enums.ObjectClass`) and `Behavior` (an `ObjectDescriptionFlag` bitfield). For 99% of entities ACE sends, `ObjectClass` is non-zero.

Source: `~/ace-server/Source/ACE.Server/Network/Structure/PublicWeenieDesc.cs` (the server-side packer) + `~/ac-headers/acclient.c` `PublicWeenieDesc` (the client-side unpacker).

Our parser: `holtburger_protocol::messages::object::PublicWeenieDesc` — the fields are parsed today, just not surfaced to JS. Phase E.B's job is to add the wasm getter.

Deterministic given: the server's published Weenie definition for the entity's `wcid`. Two clients connecting to the same ACE world database see identical `ObjectClass` values for the same `wcid`.

### C2 — DAT-baked (Weenie definition classification)

When the wire payload arrives with `ObjectClass = 0` (which ACE permits for some categories of in-DAT scenery), the Weenie's static definition in `client_portal.dat` (`weenie:*`) carries enough information to derive the class deterministically. The derivation is the same algorithm ACE itself uses server-side to populate `ObjectClass` when it pre-classifies Weenies for spawning.

Algorithm: the same logic in ACE's `~/ace-server/Source/ACE.Server/Factories/WeenieClassFactory.cs` (or equivalent — needs E.A confirmation) that maps `(WeenieType, BehaviorFlags, ItemType)` → `ObjectClass`.

Our path: WB.Terminal commands generate a per-Weenie `ObjectClass` JSON catalog from the DAT, similar to how `world-object-taxonomy.json` is generated today. The renderer consumes it as a lookup table keyed by `wcid`. Idempotent + version-controlled — same DAT release → same catalog → same dispatch.

Deterministic given: the DAT release (provable via the existing `bake-source.sha256` mechanism).

### Why no third source

World-completeness has three sources because placements have three orthogonal channels (DAT-explicit, DAT-baked-from-algorithm, ACE-runtime-pushed). Classification has two because:
- "DAT-explicit" classification and "DAT-baked" classification collapse into one (the Weenie definition IS the explicit classification; there's no separate algorithmic-bake step). Both go through C2.
- The runtime-pushed channel is C1.

A third channel — "client-side heuristic" — is what we're explicitly rejecting. The fallback that exists today is moved to the explicit-unknown sentinel `WorldObject` (the base class), with appropriate logging so the validator can count + flag it.

## The fallback discipline

When neither C1 nor C2 produces a class, we instantiate the base `WorldObject` and:

1. **Log it.** `[wom] no authoritative class for guid=0x… wcid=0x… itemType=… objectClass=0 — instantiating WorldObject (sentinel)`.
2. **Tag it.** The instance carries `wo.classificationSource = 'unknown'` (vs `'wire'` or `'dat-baked'` for the authoritative paths).
3. **Validator counts it.** The Phase E.D validator reports `N entities of K total had no authoritative class — manifest is incomplete`.

This is structurally identical to how world-completeness handles "renderer drew a placement that isn't in the manifest" — the validator flags it as a bug, not a feature. Over time, every fallback case should be either:
- Fixed by surfacing more wire data (extending C1), OR
- Fixed by adding the entry to the DAT-baked catalog (extending C2)

**The current `get_object_class.js` heuristic dispatch table is REMOVED from the normal flow.** It may survive as a `plugins/world-objects/debug_classify.js` debugger utility for ad-hoc testing, BUT it is never invoked by `WorldObjectManager.onObjectCreated()` in the normal path. The presence of the heuristic in the dispatch is the bug; its absence is the contract.

## How this resolves the current WorldObjectManager conflict

Concrete steps (Phase E.B / E.C below):

1. **`apps/holtburger-web/src/lib.rs`** — extend the wasm-bindgen `EntityUpdate` struct with `pub fn object_class(&self) -> u32` and `pub fn behavior(&self) -> u32` (or `behaviour` — match retail spelling). The parser side already has these from `PublicWeenieDesc`; this is pure surfacing.
2. **`apps/holtburger-web/index.html`** drainEvents kind=1 dispatch — pass `objectClass: upd.objectClass, behavior: upd.behavior` into `wom.onObjectCreated()`.
3. **`plugins/world-objects/world_object_manager.js`** — the dispatch already prefers `objectClass` when set (line 71-74); no logic change needed once the wire is surfaced.
4. **`plugins/world-objects/get_object_class.js`** — delete the heuristic dispatch (move to a separate `debug_classify.js` if we want to keep it for ad-hoc debugging). The `WorldObjectManager` calls `resolveClassName({objectClassName})` only; if it's null, it returns the `WorldObject` sentinel.
5. **`plugins/world-objects/world_object.js`** — add `this.classificationSource = source` field, populated by the manager.

Cost: ~50 LOC of Rust + ~30 LOC of JS + delete ~80 LOC of obsolete heuristic. Net negative LOC, much stronger contract.

For C2 (the DAT-baked catalog) — that's a Phase E follow-on, not blocking the wire-side fix. Catalogue lands once the manifest schema is agreed.

## Determinism contract for classification

Two clients running the same DAT against the same ACE world DB must produce **identical classification logs** for the same entity GUIDs over the same observation window. No tolerance — classification is a discrete enum, not a continuous quantity.

Drift detection: the validator (E.D) periodically replays a known set of spawns through both implementations (live runtime + offline manifest) and asserts every classification matches.

## Base DATs only — same rule as placements + events

The DAT-baked classification catalog (C2) **must** be generated from canonical retail DATs. Same `bake-source.sha256` mechanism as placements. Same pre-flight rejection of modder-allocated IDs (`0x__FFxxxx`) and sibling `custom_textures/` / `iter-*/` / `*.wbproj` markers.

A consumer renderer verifies the catalog's sha256 against its own DAT contents before honouring the classifications.

## The validator (Phase E.D)

`apps/holtburger-web/validate_entity_classification.cjs` (planned). For a target session it:

1. Builds the expected manifest from `wcid → ObjectClass` lookups against C1 (wire) + C2 (DAT-baked catalog).
2. Walks the live `WorldObjectManager.objects` map (or replays a captured event log) and emits one `(guid, wcid, instanceClass, classificationSource)` record per entity.
3. Matches by `wcid → ObjectClass`. Reports:
   - Drift: `instanceClass !== manifestClass` for some entity (renderer chose wrong class).
   - Unknown: `classificationSource === 'unknown'` (no manifest entry — manifest is incomplete OR wire payload was missing fields).
   - Spurious: instance exists but no `wcid` known to the manifest (renderer instantiated something the manifest doesn't cover).

The validator IS the source of truth. If it finds drift, the renderer is wrong (or the manifest is incomplete) — don't change the validator.

### A note on the WorldObjectManager's role

The manager is NOT a renderer. The existing PIXI / scene3d render path stays intact. The manager is the **typed-API layer** for plugin authors. Validator-enforced classification is what lets plugin code rely on `if (wo instanceof Vendor)` without worrying that two different code paths classify the same entity differently.

## Phase plan (mirrors A-E for placements + F.A-F.E for events)

| Phase | What | Estimated effort |
|---|---|---|
| **E.A** Investigate | Inventory `PublicWeenieDesc.Header.ObjectClass` usage in ACE source; sample wire payloads for representative wcids (NPC, Vendor, Monster, Portal, Door, Lifestone, Static, MeleeWeapon, Container); identify any entity where ACE sends `ObjectClass = 0` and the DAT-baked path must take over; confirm Weenie→ObjectClass derivation algorithm | hours, read-only |
| **E.B** Surface | Extend wasm `EntityUpdate` with `object_class()` + `behavior()` getters; pass through in index.html drainEvents kind=1 dispatch; delete `get_object_class.js` heuristic dispatch from the normal path | ~80 LOC net negative |
| **E.C** Wire | `WorldObjectManager` dispatch path becomes strict: only C1 + C2 + `WorldObject` sentinel. Each instance carries `classificationSource` field | trivial |
| **E.D** Validate | `validate_entity_classification.cjs` — Playwright capture that walks a known route (e.g. Holtburg square → Lin the Vendor → academy entrance → an interior NPC), captures `wom.objects`, asserts every classification matches manifest; reports `unknown` count | 1-2 days |
| **E.E** Stage + verify | Generate `wcid → ObjectClass` catalog from ACE DB (Phase C2); stage under `data/chorizite/wcid-classification.json`; CI gate the validator | 1 day |

## Scope limits — what's NOT covered

- **Per-entity behavior** (Vendor.openContainer(), Door.isOpen) — that's plugin-author surface, not classification. Once classification is correct, behaviors live in the typed subclasses.
- **Entity equipment / appearance** (ObjDesc / PhysicsDesc bundles) — handled by the existing render path. Classification of the entity itself is orthogonal.
- **Wcid catalog completeness** — if a wcid isn't in the catalog, the entity gets `WorldObject` + a log. We don't pretend completeness; we measure it.
- **Combat / magic resolution** — the typed class doesn't drive damage / cast resolution. Those are server-authoritative via separate wire messages.

## Provenance + dependencies on shipped work

Already exists (foundation for this method):
- `holtburger_protocol::messages::object::PublicWeenieDesc` — the parser; ObjectClass + Behavior fields parsed today but not surfaced
- `apps/holtburger-web/plugins/world-objects/` — the typed-class skeleton (commit `c7f9fbd`)
- `apps/holtburger-web/index.html` drainEvents kind=1 path — the wire-in (commit `4849864`)
- `external/chorizite/Chorizite.Common/Enums/ObjectClass.cs` — the canonical enum (Phase E.B's data source for the wasm getter's return type)
- `apps/holtburger-web/data/chorizite/chorizite-common-enums.json` — already contains the ObjectClass enum table (Phase E.C consumes this for dispatch)
- `WorldBuilder.Terminal/CommandEngine.Chorizite.cs` — Phase E.E will add `chorizite-dump-wcid-classification` here

Pending (this method's work):
- E.B: wasm getter for ObjectClass + Behavior (~30 LOC Rust)
- E.C: dispatch tightening + heuristic removal (~30 LOC JS, net negative)
- E.D: validator (~500 LOC Playwright)
- E.E: classification catalog command + CI hook (~150 LOC + glue)

## Why this is one method, not three

You could imagine splitting "wire classification" (E.B/E.C) from "DAT-baked catalog" (E.E) from "validator" (E.D) into three separate methods. The reason they're one: they're three facets of the same contract — every typed-class instance is server-authoritative or DAT-baked or explicit-unknown. Splitting the contract into pieces invites the gap that motivated this doc to begin with (one side trusts the wire, the other side heuristically guesses, drift goes silent).

## Cross-references

- [`world-completeness-method.md`](world-completeness-method.md) — placements (the parent contract; this doc mirrors its structure + discipline)
- [`event-completeness-method.md`](event-completeness-method.md) — events (the sibling contract)
- [`../external/holtburger/apps/holtburger-web/CHORIZITE_PORTING_PLAN.md`](../external/holtburger/apps/holtburger-web/CHORIZITE_PORTING_PLAN.md) §3 + §12 + §13 — the WorldObject typed-class layer this method classifies
- [`../external/holtburger/apps/holtburger-web/plugins/world-objects/README.md`](../external/holtburger/apps/holtburger-web/plugins/world-objects/README.md) — the runtime that consumes the classification

## Sign-off line

If this method accurately captures the contract and the phase plan looks right, mark it verified; I'll start E.A (read-only investigation of `PublicWeenieDesc.Header` wire-side coverage). If anything looks wrong — especially the **fallback discipline** (is `WorldObject` sentinel + log the right escape valve, or should we be stricter and throw?), the **two-sources-only** decision (do you want a third source like a hand-curated override table?), or the **`get_object_class.js` removal** (is the heuristic worth keeping as a fallback rather than removing?) — flag before code starts.
