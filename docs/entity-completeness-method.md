# Entity-Completeness Method (typed classification)

Companion to [`world-completeness-method.md`](world-completeness-method.md) (placements) and [`event-completeness-method.md`](event-completeness-method.md) (sounds + particles). This doc covers the third axis: **typed entity classification** — answering "what *kind* of WorldObject is this?" without inventing the answer on the client.

Status: **brief, pending execution.** Written 2026-05-19 in response to a conflict surfaced by the `WorldObjectManager` wire-in (commit `4849864`). Revised the same day after reading the actual wire format — see §1.5 below for what changed.

If this method captures the architecture and the phase plan looks right, mark it verified; I'll start E.B. If anything looks wrong — especially the **algorithm-as-source** framing or the **fallback discipline** — flag it before code starts.

## The conflict that motivated this doc

The `WorldObjectManager` (commit `c7f9fbd`, wired in `4849864`) consumes `pollEntityUpdates()` kind=1 spawn payloads and dispatches them into typed JS classes (Vendor, NPC, Door, MeleeWeapon, etc.) for plugin authors. Today the wasm `EntityUpdate` surface only exposes `itemType`, stripping the other two classification inputs that ACE actually ships in `PublicWeenieDescription`. So the JS-side dispatch falls back to a hand-coded ItemType-only heuristic in `plugins/world-objects/get_object_class.js`. All creatures collapse to the generic `Creature` class; Vendor/NPC/Player/Monster/Door/Lifestone/Corpse discrimination is lost.

That heuristic is **client-side classification using a simplified subset of the canonical algorithm**, not a faithful port of what every other AC client implementation does. It's the structural analog of computing scenery from a noise function on the client when there's a canonical, deterministic algorithm available — the thing `world-completeness-method.md` rejects as "Procedural-on-client is the bug. Explicit-everywhere is the fix."

This doc defines the contract that resolves the conflict: typed classification is a **canonical, deterministic algorithm** taking authoritative wire inputs and producing the same output every other AC client produces.

## 1.5. What changed in revision 2 (2026-05-19, same day)

The first draft of this doc was wrong on a structural point. I claimed `PublicWeenieDescription.Header.ObjectClass` is "a field on the wire" and Phase E.B was "surfacing it." Reading the actual parser (`crates/holtburger-protocol/src/messages/object/messages/description.rs:PublicWeenieDescription`) and ACPlugin's classifier (`external/chorizite/ACPlugin/API/WorldObject.cs:344-411`) revealed:

- The wire carries **three discrete inputs**: `item_type` (`ItemType` bitfield), `obj_desc_flags` (`ObjectDescriptionFlag` bitfield), `weenie_flags` (`WeenieHeaderFlag` bitfield).
- `ObjectClass` itself is **NOT on the wire**. It's computed client-side by `WorldObject.GetObjectClass(itemType, objDescFlags, createFlags)` — a 67-line deterministic algorithm.
- ACPlugin caches it in `_objectClass` (lazily computed). Retail acclient.exe computes it the same way per its own internal classifier (which ACPlugin's algorithm mirrors).

This is structurally **identical** to world-completeness's scenery bake — there is NO scenery field "on the wire" either; ACE computes scenery placements server-side via `Scenery.Load()`, which we port deterministically into Rust as our bake. The "source" is `algorithm + inputs`, not "a value on the wire." Same pattern here: source = `GetObjectClass + (item_type, obj_desc_flags, weenie_flags)`.

The contract below is restated under this correct framing.

## The contract

For any entity `e` spawned at any time:

```
typed_class(e) ≡ {
    canonical_classify(item_type(e), obj_desc_flags(e), weenie_flags(e))
      where canonical_classify ≡ ACPlugin.WorldObject.GetObjectClass
      (a faithful 1:1 port; same inputs → same output as ACPlugin / retail acclient.exe)
  ∪ WorldObject sentinel
      when canonical_classify returns ObjectClass.Unknown
      (logged + validator-counted; not a silent fallback)
}
```

**One source of truth**: the canonical classifier + its three wire inputs. **No heuristic dispatch.** The simplified `get_object_class.js` heuristic that's in the tree today is **deleted from the normal flow** — replaced by a faithful port of `ACPlugin.WorldObject.GetObjectClass`. Either the canonical algorithm returns a known `ObjectClass`, or we instantiate the `WorldObject` sentinel and log it.

Determinism: same wire inputs → same `ObjectClass` → same JS class on every client running this codebase. Two clients running against the same ACE server see identical typed classes for the same entity GUIDs.

## The classifier algorithm (the load-bearing piece)

Source: `external/chorizite/ACPlugin/API/WorldObject.cs:344-411`. Verbatim shape:

```text
GetObjectClass(itemType, objDescFlags, createFlags) -> ObjectClass {
  // PASS 1 — ItemType bitfield (first-match cascade)
  if itemType has MeleeWeapon       -> MeleeWeapon
  else if Armor                     -> Armor
  else if Clothing                  -> Clothing
  else if Jewelry                   -> Jewelry
  else if Creature                  -> Monster   // refined in PASS 3
  else if Food                      -> Food
  else if Money                     -> Money
  ... (26 cases total) ...

  // PASS 2 — ObjectDescriptionFlag bitfield (overrides PASS 1 where set)
  if objDescFlags has Player        -> Player
  else if Vendor                    -> Vendor
  else if Door                      -> Door
  else if Corpse                    -> Corpse
  else if LifeStone                 -> Lifestone
  ... (12 cases total) ...

  // PASS 3 — special cases
  if Unknown && itemType.Writable && objDescFlags.Book:
    if Inscribable                  -> Journal
    elif Stuck                      -> Sign
    else                            -> Book

  if itemType.Writable && createFlags.Spell -> Scroll

  if class == Monster:
    if !objDescFlags.Attackable     -> Npc        // NPC discrimination!
    if objDescFlags.IncludesSecondHeader -> Npc   // same

  if class in (Misc, Unknown):
    if objDescFlags.Stuck           -> Static

  return class
}
```

Critical points:
- **Monster→NPC discrimination** happens via `!Attackable` flag in PASS 3 — that's how we get NPC vs Monster distinction.
- **Vendor discrimination** happens via `objDescFlags.Vendor` in PASS 2 — wire-explicit.
- **Door / Lifestone / Corpse / Foci / Bindstone** all come from PASS 2 obj-desc flags.
- **Scroll vs Book vs Journal** requires both `itemType.Writable` AND specific obj-desc / weenie flags.

A faithful port of this algorithm is the entirety of the entity-completeness contract.

## Why "algorithm-as-source" is consistent with world-completeness

World-completeness §3.2 lists "DAT baked" as one of its three sources. The full description: *"Computed by a deterministic Rust port of `~/ace-server/Source/ACE.Server/Entity/Scenery.cs` (198 LoC). Inputs: the LB's `CellLandblock.terrain[81]` 16-bit terrain words + canonical Region's TerrainInfo + SceneInfo + Scene files. Output: a Vec of `{obj_id, x, y, z, qw, qx, qy, qz, scale, ...}` per LB."*

The "source" there is the algorithm + inputs, not a stored value. Same shape here: the source is `GetObjectClass + (item_type, obj_desc_flags, weenie_flags)`, not a stored `ObjectClass` field. Determinism comes from the algorithm being a faithful 1:1 port + the inputs being canonical wire data.

The C# `GetObjectClass` IS the canonical source the same way `ACE.Server.Entity.Scenery.Load` IS the canonical source for placements. ACPlugin's port matches retail acclient.exe; ours matches ACPlugin via cross-test (same inputs → same output, asserted byte-by-byte across a representative payload set).

## The fallback discipline

The classifier returns `ObjectClass.Unknown` for entities none of its 26+12+5 rules match. When that happens, we instantiate the base `WorldObject` class and:

1. **Log it.** `[wom] canonical classifier returned Unknown for guid=0x… wcid=0x… itemType=0x… objDescFlags=0x… weenieFlags=0x… — instantiating WorldObject (sentinel)`.
2. **Tag it.** The instance carries `wo.classificationSource = 'unknown'` (vs `'canonical'` for the normal path).
3. **Validator counts it.** The Phase E.D validator reports `N entities of K total returned Unknown — canonical classifier coverage incomplete`.

Returning Unknown is not a sin — it just means the entity's input combination wasn't in the 43 rules. Over time, each Unknown either:
- Reveals a rule we missed when porting the C# algorithm (fix the port; coverage grows), OR
- Reveals a wire payload combination ACPlugin itself doesn't handle (matches their gap; document)

Either way, the path is to extend coverage of the canonical algorithm, never to add a side-channel heuristic. The 80-LOC `get_object_class.js` heuristic in the tree today is deleted entirely; nothing replaces it.

## How this resolves the current WorldObjectManager conflict

Concrete steps (Phase E.B/E.C below):

1. **`apps/holtburger-web/src/lib.rs`** — extend the wasm-bindgen `EntityUpdate` struct with two getters:
   - `pub fn obj_desc_flags(&self) -> u32` (renamed from the conventional `behavior` to match the C# `ObjectDescriptionFlag` type)
   - `pub fn weenie_flags(&self) -> u32` (the `WeenieHeaderFlag` bitfield)
   The parser side already extracts these from `PublicWeenieDescription`; this is pure surfacing.
2. **`apps/holtburger-web/index.html`** drainEvents kind=1 dispatch — pass `objDescFlags: upd.objDescFlags, weenieFlags: upd.weenieFlags` into `wom.onObjectCreated()` alongside the existing `itemType`.
3. **`plugins/world-objects/get_object_class.js`** — REPLACE entirely with a faithful port of `ACPlugin.WorldObject.GetObjectClass(itemType, objDescFlags, createFlags)`. ~70 LOC, mirrors the C# line-for-line. Comments cite the C# source line numbers so the port is auditable.
4. **`plugins/world-objects/object_description_flags.js`** + **`weenie_header_flags.js`** (new) — JS bitflag constants for the `ObjectDescriptionFlag` + `WeenieHeaderFlag` enums (the inputs the classifier consumes). Sourced from `Chorizite.Common/Enums/`.
5. **`plugins/world-objects/world_object.js`** — add `this.classificationSource = source` field.
6. **`plugins/world-objects/world_object_manager.js`** — replace the current `resolveClassName({objectClassName})` call with `canonicalClassify(itemType, objDescFlags, weenieFlags)`; instantiate `WorldObject` sentinel when result is `Unknown`.

Cost: ~70 LOC JS classifier (replacing the existing 80 LOC heuristic — net negative) + ~30 LOC Rust wasm getters + ~20 LOC of new bit-flag constants.

## Determinism contract

Two clients running the same codebase against the same wire payload must produce **identical** `ObjectClass` outputs from `canonicalClassify`. The classifier is a pure function of three bitfields; no time, no random, no environment.

Cross-validation: Phase E.D runs a Node-side test that drives a representative payload set (one entry per ObjectClass value, sourced from real wire captures) through BOTH the C# `ACPlugin.WorldObject.GetObjectClass` (via dotnet test runner) AND our JS port (via `node`). Asserts byte-by-byte identity. If they ever diverge, our port is wrong — fix the port, don't change the test.

## Base DATs only — same rule as placements + events

Wire payloads depend on the ACE server's loaded Weenies, which depend on the DAT release. Same `bake-source.sha256` discipline as the placement bake applies indirectly: a Coldeve / Drake / GDLE server loading non-retail Weenies sends different `(item_type, obj_desc_flags, weenie_flags)` tuples for the same `wcid`. The classifier still produces a valid `ObjectClass`; the *manifest* the validator checks against in Phase E.D should know what server build it's checking.

## The validator (Phase E.D)

`apps/holtburger-web/validate_entity_classification.cjs` (planned). Two checks, neither tolerance-based (this is a discrete enum, not a continuous quantity):

1. **Cross-port parity check.** Pipes a representative payload set through both C# `ACPlugin.WorldObject.GetObjectClass` and JS `canonicalClassify`. Asserts byte-by-byte identity. Detects any drift in our port.

2. **Coverage check.** Walks `WorldObjectManager.objects` over a known route (e.g. Holtburg square → Lin the Vendor → academy entrance → an interior NPC) and counts:
   - `wo.classificationSource === 'canonical'` instances by class.
   - `wo.classificationSource === 'unknown'` instances by `(wcid, item_type, obj_desc_flags, weenie_flags)`.

   Unknown count > 0 means the canonical algorithm's coverage has gaps. Each unknown tuple becomes a follow-on to extend the port.

The validator IS the source of truth. If parity fails, the renderer's port is wrong — don't change the validator.

## Phase plan (mirrors A-E for placements + F.A-F.E for events)

| Phase | What | Status |
|---|---|---|
| **E.A** Investigate | Confirm parser populates obj_desc_flags + weenie_flags in EntityUpdate construction sites; verify ObjectDescriptionFlag + WeenieHeaderFlag enum tables in Chorizite.Common; sample wire payloads | ✓ done (in §1.5) |
| **E.B** Surface | Wasm getters for obj_desc_flags + weenie_flags; index.html pass-through; faithful port of GetObjectClass in JS (replaces get_object_class.js); bitflag constant files | ✓ shipped (commit `509abef`) |
| **E.C** Wire | WorldObjectManager dispatch uses canonicalClassify; WorldObject sentinel + classificationSource tag | ✓ shipped (commit `509abef`) |
| **E.D** Validate (synthetic) | validate_entity_classification.cjs — 56-case branch-coverage validator over canonicalClassify; reports class distribution + coverage gap if any of 42 ObjectClass values goes untested | ✓ shipped — 56/56 pass, 42/42 ObjectClass values exercised |
| **E.E** Cross-port | `chorizite-classify` WB.Terminal command (1:1 C# port of same algorithm); `scripts/cross_port_parity.cjs` pipes 48 cases through both ports, asserts byte-identical output | ✓ shipped — 48/48 parity |
| **E.F** Validate (live capture) | `capture_entity_classifications.cjs` — Playwright/CDP capture against live ACE; spawns into Holtburg, drains the ObjectCreate burst, captures `window.__wom.snapshot()`, asserts class distribution + Unknown count ≤ tolerance | ✓ shipped (script ready); awaiting operator run against live ACE |

CI hook for the three validators (E.D synthetic, E.E cross-port, E.F live) is not yet automated. E.D and E.E run without external dependencies and can be wired into any pre-commit / CI workflow today (`node validate_entity_classification.cjs` + `node scripts/cross_port_parity.cjs`). E.F requires the holtburger-web dev server + a live ACE; suited to a periodic / nightly job rather than per-commit.

### E.F probe scenario (operator-driven, deterministic)

The capture script's default scenario:
1. Boot `index.html?renderer=3d` against a live local ACE (env-overridable: account, password, bridge URL, server IP/port).
2. Login → create test character if needed → spawn into Holtburg (the character creation default).
3. `/godly` to prevent fall damage during drain.
4. Wait `ECF_ENTITY_DRAIN_MS` (default 60 s) for the ObjectCreate burst to plateau, sampling `window.__wom.count()` every 5 s.
5. Call `window.__wom.snapshot()` and persist to `/mnt/wbterminal1/holtburger-captures/entity-class-<ts>.json`.
6. Assert `total ≥ ECF_MIN_SPAWNS` (default 5) AND `unknownCount ≤ ECF_MAX_UNKNOWN_TOL` (default 0).
7. Print class distribution + sample-by-class to stdout; full JSON snapshot to disk; screenshot to disk.

The script exits 0 on PASS, 1 on coverage/Unknown failure, 2 on infra error.

### Operator run recipe

```bash
# Pre-reqs (existing capture infrastructure):
#   - Live ACE on 100.116.47.66:9000
#   - holtburger-wsbridge on ws://127.0.0.1:8080/
#   - python3 -m http.server 8765 from external/holtburger/
#   - Manifest + shards baked under dist/

cd external/holtburger/apps/holtburger-web
NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
  node capture_entity_classifications.cjs
# → /mnt/wbterminal1/holtburger-captures/entity-class-<ts>.json
```

Tightening over time: as `unknownCount` consistently drops to 0 on a populated zone, the `ECF_MAX_UNKNOWN_TOL` default can stay at 0 (the strictest interpretation of the contract). Any future Unknown is a coverage gap in `canonical_classify.js` — port the missing branch from `ACPlugin/API/WorldObject.cs`.

## Scope limits — what's NOT covered

- **Per-entity behavior** (Vendor.openContainer(), Door.isOpen) — that's plugin-author surface, not classification. Once classification is correct, behaviors live in the typed subclasses.
- **Entity equipment / appearance** (ObjDesc / PhysicsDesc bundles) — handled by the existing render path. Classification of the entity itself is orthogonal.
- **Coverage perfection** — if the canonical algorithm returns Unknown for some real wire payload, we acknowledge it and extend the port. We don't pretend completeness; we measure it via Unknown count.
- **Combat / magic resolution** — the typed class doesn't drive damage / cast resolution. Those are server-authoritative via separate wire messages.
- **Vendor-vs-NPC discrimination via wcid table** — explicitly REJECTED as a side-channel heuristic that drifts from wire data. The canonical algorithm produces Vendor when `objDescFlags.Vendor` is set; if ACE sends an entity without that flag, we get NPC and that matches retail.

## Provenance + dependencies on shipped work

Already exists (foundation for this method):
- `holtburger_protocol::messages::object::PublicWeenieDescription` (`crates/holtburger-protocol/src/messages/object/messages/description.rs`) — parses `item_type`, `obj_desc_flags`, `weenie_flags`; fields populated, not yet surfaced to wasm
- `apps/holtburger-web/plugins/world-objects/` — the typed-class skeleton (commit `c7f9fbd`)
- `apps/holtburger-web/index.html` drainEvents kind=1 path — the wire-in (commit `4849864`)
- `external/chorizite/ACPlugin/API/WorldObject.cs:344-411` — the canonical algorithm we port
- `external/chorizite/Chorizite.Common/Enums/{ObjectDescriptionFlag,WeenieHeaderFlag,ItemType,ObjectClass}.cs` — the input + output enum tables
- `WorldBuilder.Terminal/CommandEngine.Chorizite.cs::ChoriziteDumpEnumValues` — generates the JSON enum tables (currently dumps 9 enums; needs ObjectDescriptionFlag + WeenieHeaderFlag added)

Pending (this method's work):
- E.B: wasm getters + JS canonical port (~120 LOC net)
- E.C: dispatch tightening (~30 LOC)
- E.D: cross-port parity validator (~500 LOC Playwright + dotnet runner)
- E.E: CI hook + WB.Terminal classifier command (~150 LOC)

## Why this method is one piece, not three

You could imagine splitting "canonical port" (E.B/E.C) from "cross-port validator" (E.D) from "CI staging" (E.E) into three separate methods. Reason they're one: they're three facets of the same contract — every typed-class instance traces to the canonical algorithm's deterministic output. Splitting the contract into pieces invites the failure mode that motivated this doc to begin with (one side trusts the wire, the other side heuristically guesses, drift goes silent).

## Cross-references

- [`world-completeness-method.md`](world-completeness-method.md) — placements (the parent contract; this doc mirrors its structure + discipline)
- [`event-completeness-method.md`](event-completeness-method.md) — events (the sibling contract)
- [`../external/holtburger/apps/holtburger-web/CHORIZITE_PORTING_PLAN.md`](../external/holtburger/apps/holtburger-web/CHORIZITE_PORTING_PLAN.md) §3 + §12 + §13 — the WorldObject typed-class layer this method classifies
- [`../external/holtburger/apps/holtburger-web/plugins/world-objects/README.md`](../external/holtburger/apps/holtburger-web/plugins/world-objects/README.md) — the runtime that consumes the classification
- [`../external/chorizite/ACPlugin/API/WorldObject.cs`](../external/chorizite/ACPlugin/API/WorldObject.cs) lines 344-411 — the canonical algorithm we port

## Sign-off

This is revision 2 (2026-05-19) with E.B-through-E.E shipped. The first revision was wrong on a structural point (claimed `ObjectClass` is on the wire); see §1.5.

**Implementation status (rev 3 update, same day):** Phases E.A through E.E all done. The contract is live and validator-enforced. Three sign-off questions resolved during implementation:

1. **Fallback discipline:** Chose `WorldObject` sentinel + info log + future-validator count. Renderer does NOT throw — degrades gracefully so a malformed wire payload doesn't kill the session.
2. **Algorithm source:** Chose ACPlugin's `GetObjectClass`. Future regression-against-retail (the acclient.exe hex-decomp) could be a Phase E.F enhancement if drift is suspected.
3. **`get_object_class.js` deletion:** Chose throwing stub (errors on import with a migration message). Anyone trying to use the old API gets immediate feedback rather than silent drift.

The single outstanding item is the CI hook (run validator + cross-port on every relevant commit). That's a settings.json / pre-commit hook concern, not a code change in the algorithm itself. Tracked as a follow-on; documented in §E.E.
