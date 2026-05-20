# Chorizite Porting Plan — `emit-dynamic-site` / `holtburger-web`

**Status:** Rev 3 (2026-05-19). First brick LAID DOWN: WB.Terminal absorption (§12) + browser skeleton (§13) shipped. Strategic shift recorded in §12 ("data comes from WB.Terminal").

**Goal:** Catalog every Chorizite GitHub repo, classify each by porting value to our browser AC client (`apps/holtburger-web` + supporting Rust crates), prescribe target landing locations, and surface honest gaps in our investigation so future agents/sessions can pick this up without re-doing the survey.

**Audience:** Future agents and humans expanding the browser client. Read §1 for context, §2 for the high-level tier table, §3–§5 for the actionable port checklists, §10 for the honest coverage caveats.

---

## 0. TL;DR

- **23 Chorizite repos surveyed**, ~3,000+ source files visible.
- **Critical reframe #1:** Most of Chorizite is **not directly portable**. It's a C# plugin ecosystem that runs inside the **retail `acclient.exe` process** via DLL injection (`Chorizite.Injector`), with bindings (`ACBindings`) that are literal hardcoded memory offsets into the running game (e.g. `0x0051AEA0`). You cannot drop that into a Rust + WASM + Three.js browser client.
- **Critical reframe #2 (added after first revision):** **The primary behavioral oracle is NOT ACBindings — it is the local `~/ac-headers/` directory**, which contains the full Hex-Rays decompiled source of retail `acclient.exe` (`acclient.c`, 938k lines, 1,078 C++ classes with real method bodies) plus a second independent Binary Ninja decompilation (`acclient_2013.bndb_pseudo_c.txt`, 1.4M lines) plus the PDB symbol dump (`acclient.txt`, 1.5M lines, build path `d:\ac1_sep13\output\`) plus the struct header catalog (`acclient.h`, 1.7 MB). When implementing any retail behavior, grep `acclient.c` FIRST. See §4-Alt and [[reference_ac_re_artifacts]].
- **What IS portable / valuable (revised tier list):**
  - **Tier 1 — direct port:** `ACPlugin/API/*` — the high-level WorldObject hierarchy + event taxonomy. Maps cleanly onto our `plugins/api.js` + JS types + Rust `holtburger-world`. Highest ROI item in the whole survey.
  - **Tier 2 — primary behavioral reference:** **local `~/ac-headers/acclient.{c,h,txt}` + `acclient_2013.bndb_pseudo_c.txt`** (NOT a chorizite repo — local files). The decompiled retail source itself. See §4-Alt.
  - **Tier 3 — secondary reference + symbol navigator:** `ACBindings/Generated/*.cs` — 1,899 LLM-narrated C# struct catalogs. Useful for two things: (a) the folder organization (`Generated/Game/Combat/`, `Generated/Game/Spells/`, etc.) is a more legible index than 938k-line C, and (b) the XML doc-comments are a "what does this do in one sentence" entry point before reading the real body. **Demoted from primary** because we have the actual source.
  - **Tier 4 — parity validation:** `Chorizite.Common/Enums/*` (cross-check enum integer values against ours), `DatReaderWriter.Tests/DBObjs/*` (fixture-based parser assertions we can port as test inputs), `Chorizite.ACProtocol/Enums/*.generated.cs` (opcode parity).
  - **Tier 5 — architectural inspiration:** `RmlUiPlugin/Lib/RmlUi/VDom/*` (reactive UI patterns for our plugin shell), `Chorizite.Core/Plugins/*` (plugin manifest + lifecycle model).
  - **Tier 6 — known but skip:** Injector (C++ DLL inject), LuaPlugin (we use Deno), RmlUi.Net + LauncherPlugin + PluginManagerUIPlugin (we have DOM + our own bar), TaffySharp (browser CSS), VSCode + MSBuildTasks + plugin-index + chorizite.github.io + .github + github-workflows + CoreTestPlugin (meta/infra).
  - **Tier 7 — tooling to remember:** `ida-scripts` (Python IDA + Diaphora pipeline for regenerating ACBindings; could be adapted to emit **Rust** type catalogs from our local decomp).
- **First-three-bricks recommendation** (§7): (1) port `ACPlugin` event taxonomy into `plugins/api.js`, (2) port `ACPlugin/API/WorldObjects/*` class hierarchy as JS types (and partially Rust types) and wire to existing entity stream, (3) cross-check `Chorizite.Common/Enums/*` against `holtburger-common::properties` and gap-fill.

---

## 1. Context & Scope

### 1.1 What we have (the target)

The `emit-dynamic-site` project — the browser-loadable AC client at `apps/holtburger-web/` — is, today:

- **Rust + WASM** core: `src/lib.rs` exposes a `SessionHandle` over `holtburger-protocol` + `holtburger-session` + `holtburger-world` (workspace crates at `external/holtburger/crates/`), driving a live ACE server handshake from a browser tab.
- **Three.js r184 + EffectComposer + Bruneton atmosphere** renderer in `scene3d/` (loop, picking, entities, statics, buildings, terrain, sky, particles, audio, lighting, materials, env-cells).
- **Plugin/UI layer** in `plugins/` (`api.js`, `combat-bar.js`, `spellbook.js`, `vitals-hud.js`, `stance-toggle.js`) + `ui/bar.js` shell.
- **Phase status (per memory):** Sky-K.6 + Visual-fidelity wave 6 + Combat Phase K.1 + UI Shell + Plugin bar all shipped. World ring at 13×13 LBs. Foundations mostly proven; the next year's worth of work is wiring **gameplay systems** (vendors, loot, fellowship UI, allegiance, buff/debuff tracking, spell validation, vitals math, motion-table-driven swing pose, etc.) onto those foundations.

### 1.2 What Chorizite is (the source)

Chorizite is a **C# plugin manager that injects .NET into the running retail `acclient.exe`**. Architecture (from `Chorizite/Chorizite.Core/`, `Chorizite.Injector/`, and the `ACBindings`/`ACPlugin` pair):

```
   Native acclient.exe (retail)
        │
        ├─ Chorizite.Injector (C++ DLL)
        │       │ loads .NET runtime in-process
        │       ▼
        │  Chorizite.Core (C#) — plugin host, IPluginManager, IClientBackend, IInputManager
        │       │
        │       ▼
        │  Chorizite.ACBindings (C#) — 1,899 structs at hardcoded offsets into the running game
        │       │
        │       ▼
        │  ACPlugin (C#) — high-level Game/World/Character/WorldObject API
        │       │
        │       ▼
        │  RmlUiPlugin (C#) + LuaPlugin (C#) + LauncherPlugin + user plugins
```

The execution model is "live retail client + injected managed plugins." **Our model is "we ARE the client, written from scratch in Rust + browser."** That mismatch is the central thing to internalize before reading the rest of this doc — it dictates which repos are gold and which are inapplicable.

### 1.3 Why some are still gold

Even with the architecture mismatch, three categories are valuable:

1. **High-level APIs** are language-agnostic. `ACPlugin.WorldObject` + its 24-subclass hierarchy + event taxonomy describes "what's the right shape for a client-side world API" — a problem we are also solving and have done partly. Their solution is mature and the shape ports cleanly.
2. **Bindings doc-comments are a navigation aid over our local decomp.** `ACBindings/Generated/*.cs` contains LLM-generated XML doc-comments narrating what each native method does (e.g. *"Calculates the vertical jump velocity using the motion state's jump extent, clamping it to a sensible range and delegating final determination to the associated weenie object"*) — even though the method body itself is just `((delegate* unmanaged[Thiscall]<…>)0x005286B0)(ref this)` calling into the running acclient.exe. That one-sentence summary is useful to triage which methods to read, but the **actual algorithm** comes from `~/ac-headers/acclient.c` where the Hex-Rays-decompiled body of that same method lives at line 343343 with the real numeric constants (0.0002 threshold, 1.0 clamp, 10.0 default, vtable[12] dispatch). See §4-Alt.
3. **Enums & format definitions** are authoritative. Chorizite's enums and DAT format definitions came from the same upstream (acclient PDB + the AC community), so they cross-validate ours.

---

## 2. Master Repo Table (all 23, tier + verdict)

| Repo | Tier | Verdict | Target file/dir | Notes |
|---|---|---|---|---|
| `ACPlugin` | **1 — Direct port** | Port the API model + event taxonomy | `plugins/api.js` (events), `plugins/world-objects/*.js` (classes), partial mirror in `holtburger-world::entity` | The single highest-value port. See §3. |
| **(local) `~/ac-headers/`** | **2 — PRIMARY behavioral reference** | Grep `acclient.c` for method bodies. Use `acclient.h` for struct layout. Cross-validate against `acclient_2013.bndb_pseudo_c.txt` (Binary Ninja decomp). Use `acclient.txt` (PDB dump) for module/symbol lookup. | (read-only reference) | NOT a chorizite repo. 938k-line Hex-Rays decomp + 1.4M-line Binary Ninja decomp + 1.5M-line PDB dump + 1.7 MB struct headers. See §4-Alt. |
| `ACBindings` | **3 — Symbol navigator + secondary reference** | Use `Generated/` folder organization as a more legible index than 938k lines of C. Read the LLM doc-comments for a one-sentence intent, then grep `acclient.c` for the real body. Do NOT port. | (read-only reference) | 1,899 files. Index in §4. |
| `Chorizite.Common` | **4 — Parity check** | Cross-check enum int values & names | `holtburger-common/src/properties/`, `holtburger-common/src/stats/` | Gap-fill list in §5. |
| `Chorizite.ACProtocol` | **4 — Parity check** | Opcode + message enum parity check | `holtburger-protocol/src/opcodes.rs`, `messages/` | We have our own, but cross-checking against the XML-defined opcodes catches drift. |
| `DatReaderWriter` | **4 — Parity check + fixture source** | Borrow test fixtures; cross-check XML defs | `holtburger-dat/tests/fixtures/` | DBObjs tests are golden for our DAT parsers. |
| `DatReaderWriter.Extensions` | **4 — Parity check** | Cross-check helper logic | `holtburger-dat/src/utils/` | StringHash, RenderSurface, EnumIDMap helpers. |
| `Chorizite` (core) | **5 — Architectural inspiration** | Adopt the plugin manifest schema; mirror lifecycle | `plugins/*/manifest.json`, `ui/bar.js`, future `plugins/loader.js` | We already have a partial parallel; align where cheap. |
| `RmlUiPlugin` | **5 — Architectural inspiration** | Read the VirtualDom / ReactiveHelpers patterns | future `plugins/reactive.js` if/when needed | Browser DOM beats RmlUI for our case; only useful as a design reference. |
| `RmlUi.Net` | 6 — Skip | Native C++ bindings; not applicable | — | We have DOM. |
| `LauncherPlugin` | 6 — Skip | Windows launcher app | — | Out of scope; we launch from a URL. |
| `PluginManagerUIPlugin` | 6 — Skip | RmlUi + Lua plugin manager UI | — | If we build one, build it in HTML/JS. |
| `LuaPlugin` | 6 — Skip | XLua scripting | — | We use Deno via `holtburger-scripting`. |
| `Chorizite.Injector` | 6 — Skip | C++ DLL injection into acclient.exe | — | We are the client. |
| `TaffySharp` | 6 — Skip | C# bindings to Rust `taffy` (flexbox/grid layout) | — | Browser CSS handles layout. |
| `WorldBuilder` | 6 — Skip from porting (already a separate consumer) | The desktop WB editor; consumes the same Chorizite nuget packs we do at `WorldBuilder.Browser/Linux/Mac/Windows/Terminal` | — | Our `WorldBuilder.Terminal` uses the same shared C# stack. Cross-link only. |
| `Chorizite.VSCode` | 6 — Skip | VSCode extension for Lua plugin authoring | — | Not applicable. |
| `Chorizite.Plugins.MSBuildTasks` | 6 — Skip | MSBuild tasks for C# plugin authors | — | Not applicable. |
| `plugin-index` | 6 — Skip | Static index of plugins | — | If we ever distribute, build our own. |
| `CoreTestPlugin` | 6 — Skip | Test plugin for Chorizite core | — | Not applicable. |
| `chorizite.github.io` | 6 — Skip | Vue marketing site | — | — |
| `.github` | 6 — Skip | Org config | — | — |
| `github-workflows` | 6 — Skip | Shared CI workflows | — | — |
| `ida-scripts` | **7 — Future tooling** | Document; do not run today | future: adapt to emit Rust type catalogs from our local `acclient.c` | See §6. |

---

## 3. Tier 1 — `ACPlugin` Detailed Port Checklist

### 3.1 Why this is the highest-ROI port

`ACPlugin` is the **public API layer** that Chorizite plugin authors actually program against. It abstracts away the acclient memory access and exposes a clean event-driven model: `Game`, `World`, `Character` (extends `Container`), and a 24-subclass `WorldObject` hierarchy with strongly-typed property accessors and `WeakEvent<T>`-style event subscriptions.

Our current `plugins/api.js` (`createClient(sessionHandle)`) is solving the same problem, less maturely. ACPlugin's structure is a good north star.

### 3.2 File-by-file port plan

| ACPlugin source | Action | Target | Strategy | Confidence | Notes |
|---|---|---|---|---|---|
| `API/Game.cs` | Port shape | `plugins/api.js` `client.game` + `holtburger-core` mirror | Mirror props (`ServerName`, `AccountName`, `MaxAllowedCharacters`, `State`, `Characters`, `Character`, `World`, `Actions`) + events (`OnStateChanged`, `OnCharactersChanged`, `OnWorldInfo`) | High | We already have most; align names. |
| `API/World.cs` | Port shape + dispatch table | `plugins/api.js` `client.world` + new `plugins/world-state.js` | Per-event subscription table: every `_net.S2C.On*` becomes one `sessionHandle.poll_events()` kind. List in §3.4. | High | Their handler list is a definitive coverage map of S2C event types. |
| `API/WorldObject.cs` (base) | Port shape | `plugins/world-objects/world_object.js` | JS class with typed property dicts (IntValues / FloatValues / BoolValues / StringValues / InstanceValues / DataValues / PositionValues). Add `.value(PropertyInt.X, default)` helpers. | High | The 8-typed-dict pattern is good; mirror exactly. |
| `API/WorldObjects/Container.cs` | Port | `plugins/world-objects/container.js` | Tracks contents, supports add/remove. Wraps current `playerInventory()` data. | High | — |
| `API/WorldObjects/Character.cs` (extends Container) | Port — partial we already have | `plugins/world-objects/character.js` | Skills/Attributes/Vitals dicts + Vitae + Enchantments + SharedCooldowns + heritage. Several events (OnVitaeChanged, OnVitalChanged, OnEnchantmentChanged, OnSharedCooldownChanged). | High | The vitae cap (1.0=no vitae, 0.95=5% vitae) and the `Level8AuraSelfSpells` precedence set are useful behavior notes. |
| `API/WorldObjects/Creature.cs` | Port | `plugins/world-objects/creature.js` | — | High | — |
| `API/WorldObjects/Monster.cs` | Port | `plugins/world-objects/monster.js` | — | High | Subclass of Creature. |
| `API/WorldObjects/NPC.cs` | Port | `plugins/world-objects/npc.js` | — | High | Subclass of Creature. |
| `API/WorldObjects/Player.cs` | Port | `plugins/world-objects/player.js` | — | High | Subclass of Creature. |
| `API/WorldObjects/Vendor.cs` | **Shipped** (vendor-ui v0.2.0, commit 6eeaf8c) | `plugins/world-objects/vendor.js` + `plugins/vendor-ui.js` | Wired to `kind=12 VendorOpened` + `VendorStateJs` cache. Buy + sell + icons + AC-aesthetic. See §14. | Medium | — |
| `API/WorldObjects/Door.cs` | Port | `plugins/world-objects/door.js` | Wire to existing hinge-frame tree (per memory: 2026-05-13 door work in progress). | Medium | We have static placement; dynamic open/close state still partly stubbed. |
| `API/WorldObjects/Item.cs` (and the 14 subclasses: Armor, Bindstone, Clothing, Corpse, Equippable, Foci, Food, Gem, Jewelry, Key, Lifestone, ManaStone, MeleeWeapon, MissileWeapon, Portal, Scroll, SpellComponent, Static, TradeNote, Ust, Wand) | Port | `plugins/world-objects/items/*.js` | Mostly thin subclasses that gate certain property accessors. | High | The class taxonomy itself is the value; the implementations are small. |
| `API/WorldObjectManager.cs` | Port | `plugins/world-object-manager.js` | Owns the `Map<guid, WorldObject>`, dispatches creation, hands out typed objects via `GetObjectClass(itemType, behavior, header)`. | High | Important: this is where the typed-class dispatch logic lives. We currently do flat entities; the typed dispatch is a significant upgrade. |
| `API/Actions.cs` | Port | `plugins/api.js` `client.actions` (already partial) | C2S action dispatch surface (login, equip, drop, etc.). | High | Cross-reference against our existing wasm methods (attack, missileAttack, castTargetedSpell, useObject, jump, sendChat, toggleCombatMode, etc.). Identify gaps. |
| `API/Enchantment.cs` | Port | `plugins/world-objects/enchantment.js` + Rust mirror in `holtburger-world::magic` | Stat-modifier representation. We already have additive/multiplier folding (per memory); adopt their layered-spell-id keyed dict. | High | — |
| `API/SharedCooldown.cs` | Port | `plugins/world-objects/shared-cooldown.js` | Per-cooldown-id timers; integrate with spell-bar. | High | — |
| `API/SkillFormula.cs` | Port | `holtburger-world/src/player/skill_formula.rs` + JS mirror | `(Attribute1 + Attribute2) / Divisor` formula from portal.dat. Direct math; trivial to port. | High | Their note: `HasAttribute2 == Attribute2 == 0` looks like a bug (should be `!= 0`)? Verify before adopting. |
| `API/SkillInfo.cs`, `API/AttributeInfo.cs`, `API/VitalInfo.cs` | Port | `plugins/world-objects/stat-types.js` | Per-stat info bundles (current/base/training/exp/etc.). Mirror their field shape. | High | — |
| `API/CharacterIdentity.cs` | Port | already have `CharacterSummary` | Cross-check field set | High | — |
| `API/ClientState.cs` (enum) | Port | already have | Cross-check states (Initial / GameStarted / CharacterSelect / EnteringGame / InGame / LoggingOut) | High | — |
| `API/PatchProgress.cs` | Skip | — | Retail patch flow not applicable to browser | High | We patch via HBA over HTTP. |
| `API/AddRemoveEventType.cs` | Port | inline as JS enum | Useful for the property-change events | High | — |
| `API/*EventArgs.cs` (12 files) | Port | `plugins/api.js` event payload shapes | Each becomes the object passed into `events.on(name, payload)` | High | Names: ContainerOpened, ContainerClosed, Death, EnchantmentsChanged, GameStateChanged, ObjectCreated, ObjectReleased, ScreenChanged (skip), SharedCooldownsChanged, VitaeChanged, VitalChanged, WorldObjectSelected. |
| `Lib/DragDropManager.cs` | Skip-or-reference | — | Drag-drop is RmlUi-bound; we did our own (per memory: combat Phase H drag-drop into spell bar). | High | Useful as inspiration only. |
| `Lib/Screens/*.cs` | Skip | — | RmlUi-bound screen management; not applicable. | High | — |
| `assets/panels/*.rml` + `*.lua` | Skip | — | RmlUi/Lua UI. We have HTML/JS. | High | — |
| `manifest.json` | Adopt schema | `plugins/*/manifest.json` (new) | Adopt the manifest format (id/name/author/entryfile/version/description/dependencies/environments) for our JS plugins. | Medium | We don't have plugin manifests today; this is a small structural win. |

### 3.3 Suggested folder structure for the JS port

```
plugins/
  api.js                       (already exists — refactor to event-taxonomy from §3.4)
  world-object-manager.js      (NEW — owns the typed-class dispatch)
  world-objects/
    world_object.js            (base class)
    container.js
    character.js
    creature.js  monster.js  npc.js  player.js
    door.js  portal.js  lifestone.js  bindstone.js  vendor.js  static.js
    items/
      item.js
      armor.js  clothing.js  jewelry.js  foci.js  gem.js
      food.js  key.js  manastone.js  scroll.js
      spell_component.js  trade_note.js  ust.js
      melee_weapon.js  missile_weapon.js  wand.js  equippable.js
    enchantment.js  shared_cooldown.js  skill_info.js  attribute_info.js  vital_info.js
  vendor-ui.js                 (NEW — listens to OnContainerOpened/Closed for vendor)
  buffs-debuffs-hud.js         (NEW — listens to OnEnchantmentChanged)
```

### 3.4 Event taxonomy (S2C handler list — direct from ACPlugin's World.cs)

Use this as the **canonical kind=N event reference** for our `poll_events()` drain. Items in **bold** are not yet covered by our wasm export per the local-surface audit; they're the gap-fill backlog.

- `Item_CreateObject` → `kind=10 ObjectCreated` (we have)
- `Item_DeleteObject` → `kind=? ObjectReleased` (verify in our code; rename if needed)
- `Item_ObjDescEvent` → **kind=? ObjDescChanged** (likely needed for clothing/equipment re-render)
- `Item_ParentEvent` → **kind=? ParentChanged** (equip slot / container moves)
- `Item_ServerSaysContainId` → **kind=? ServerContainsId**
- `Item_ServerSaysMoveItem` → **kind=? ServerMovedItem**
- `Item_ServerSaysRemove` → **kind=? ServerRemovedItem**
- `Inventory_PickupEvent` → **kind=? PickupEvent**
- `Item_OnViewContents` → `kind=12 ContainerOpened` (we have for vendor; verify for general containers)
- `Item_StopViewingObjectContents` → **kind=? ContainerClosed**
- `Login_PlayerDescription` → handshake-time; we cover via spawn handshake
- `Item_SetAppraiseInfo` → **kind=? AppraiseInfoSet**
- `Item_SetState` → **kind=? ItemStateChanged**
- `Item_UpdateObject` → **kind=? ItemUpdated**
- `Item_UpdateStackSize` → **kind=? StackSizeChanged**
- `Item_WearItem` → **kind=? ItemWorn**
- `Item_QueryItemManaResponse` → **kind=? ItemManaResponse**
- `Qualities_*Event` (24 variants for add/remove/update of Bool/DataId/Float/InstanceId/Int/Int64/Position/String + 6 Attribute/Vital/Skill variants) → **kind=8 PlayerStatsUpdated** is too coarse; we likely need fine-grained qualities events

**Backlog signal:** the count of **bold** items above is the rough size of the JS-facing event surface still to expose through `SessionHandle.poll_events()`. Each one is a wasm-side `holtburger_protocol` message we already parse but probably don't surface as a `ClientEvent` kind yet.

### 3.5 Where Rust mirrors are useful

Most of `ACPlugin` lives well as JS — it's UI-adjacent. But a few should also live in Rust so the wasm side can use them (and so the TUI client at `apps/holtburger-cli` benefits too):

- `WorldObject` typed-class dispatch (`GetObjectClass`) → `holtburger-world/src/entity/object_class.rs`
- `SkillFormula` math → `holtburger-world/src/player/skill_formula.rs`
- Enchantment + SharedCooldown structures → `holtburger-world/src/magic/{enchantment,shared_cooldown}.rs` (mostly there per memory; cross-reference)
- WorldObject typed subclasses as Rust enum variants → `holtburger-world/src/entity/typed.rs` (so the TUI can render different glyphs for door/portal/npc/monster/item without re-deriving from `ItemType`)

---

## 4-Alt. Tier 2 — Local Decompiled Retail Client (PRIMARY behavioral reference)

> **THIS IS THE ORIGINAL OVERSIGHT.** The first draft of this plan treated ACBindings as the canonical retail-behavior reference. That was wrong — we have the actual Hex-Rays decompiled source on disk. ACBindings is now demoted to a navigation aid (§4.5). See [[reference_ac_re_artifacts]] for the underlying memory entry.

### 4.1 What's actually on the drive

`/home/wbterminal/ac-headers/` contains four files representing two independent reverse-engineering passes plus the original symbol metadata:

| File | Size | Lines | Source | Use for |
|---|---|---|---|---|
| `acclient.c` | 31 MB | 938,010 | Hex-Rays decompiler v2007–2014 over retail `acclient.exe` (VS C++ build) | **Primary algorithm reference.** Real function bodies. 1,078 unique C++ classes. |
| `acclient.h` | 1.7 MB | — | Same Hex-Rays pass | **Struct + enum reference.** 348 enums + ~6,936 structs (per existing memory). |
| `acclient.txt` | 79 MB | 1,483,342 | Microsoft `cvdump` over retail `acclient.pdb` | **Symbol → OBJ-file map.** Original build path `d:\ac1_sep13\output\` is visible. Useful for "which compile unit did this method live in" archaeology. |
| `acclient_2013.bndb_pseudo_c.txt` | 63 MB | 1,437,645 | Binary Ninja pseudo-C export over `acclient_2013.bndb` database | **Cross-decompiler validation.** Different decompiler = different rendering of the same machine code; if Hex-Rays and Binary Ninja agree on a function's structure, you can trust it. If they disagree, the disagreement itself is informative. |

### 4.2 Top 30 classes by function count (from `acclient.c`)

```
2384 UIElement              1049 CPhysicsObj            424 ClientObjMaintSystem
1271 StringInfo              947 UIElement_Text         401 ClientUISystem
1163 Archive                 765 BaseProperty           359 Render
 752 UIRegion                701 ACCWeenieObject        352 CharGenState
 688 CPlayerSystem           656 PlayerModule           330 SmartBuffer
 655 _STL                    620 PFileNode              326 CPartArray
 538 ClientCommunicationSystem                          324 Frame
 532 Proto_UI                460 RenderDeviceD3D        318 OrderHdr
 455 UIElement_ListBox       443 UIElement_ItemList     309 UIElementManager
 440 ClientSystem            430 DBObj                  276 PixelFormatDesc
 270 AppraisalProfile
```

The big subsystems we'll keep colliding with are immediately visible: `UIElement*` (the retail UI tree we don't need but its event taxonomy informs HUD design), `CPhysicsObj` (physics — the one we DO need), `ACCWeenieObject` + `PlayerModule` + `CPlayerSystem` (player/world objects), `Archive` (DAT serialization), `ClientCommunicationSystem` (networking — what to compare against `holtburger-session`), `ClientObjMaintSystem` (the object-lifecycle authority — directly maps to our `WorldObjectManager` in §3.2).

### 4.3 Canonical reading workflow

For any retail behavior you're about to implement in Rust:

```bash
# 1. Find the method (forward decls live in a separate band from the bodies)
grep -nE "ClassName::method_name" /home/wbterminal/ac-headers/acclient.c

# 2. Read the body — bodies are sorted by address, headed by:
#    //----- (HEXADDR) --------------------------------------------------------
# Use Read on acclient.c with offset = the second hit's line number.

# 3. Look up the struct layout (members + their types):
grep -nE "struct __cppobj? ClassName\b" /home/wbterminal/ac-headers/acclient.h

# 4. Optional: cross-validate by grepping the Binary Ninja pseudo-C:
grep -nE "ClassName::method_name" /home/wbterminal/ac-headers/acclient_2013.bndb_pseudo_c.txt

# 5. Optional: find which OBJ file (compile unit) it came from:
grep -A 50 "method_name" /home/wbterminal/ac-headers/acclient.txt
```

**Worked example — `CMotionInterp::get_jump_v_z` (the function that started this revision):**

- Hits at lines 7088 (forward decl), 343343 (body).
- Body at `acclient.c:343343-343363` reveals:
  - Reads `this->jump_extent` directly off the struct.
  - Branches on `extent < 0.0002` → `return 0.0`.
  - Clamps `extent` to ≤ 1.0.
  - If `weenie_obj` is null → returns `10.0` (default).
  - Calls `weenie_obj->vfptr[12]` (a virtual method) with `extent` — succeeded → returns extent; failed → returns 0.0.
- Struct layout at `acclient.h:31407` confirms `CMotionInterp` has fields including `jump_extent` (float), `current_speed_factor`, `interpreted_state`, `pending_motions`, etc.
- **Result:** we now have the algorithm AND the struct layout. No need to guess from doc-comments.

Compare with the original §4.1's workflow (ACBindings doc-comments only) — that gave us *"Calculates the vertical jump velocity… clamping it to a sensible range and delegating final determination to the associated weenie object"*, which is approximately what the function does, but loses the **specific numeric constants** (0.0002 threshold, 1.0 clamp, 10.0 default) and the **specific vtable slot** (12). Those constants are exactly what we need to faithfully reimplement.

### 4.4 Where this changes prior decisions in this doc

- §3.5 "Where Rust mirrors are useful" — still correct, but now: when porting each item there, **grep `acclient.c` first** to see if the retail client already has the algorithm we want (or part of it).
- §7 PR 3 — once enums are parity-checked, the next natural follow-on is a `holtburger-world::motion` audit driven by reading `CMotionInterp::*` bodies in `acclient.c`. The ~70-LOC swing-pose follow-on (per memory) becomes much smaller and safer once it's grounded in the actual retail decomp.
- The whole §4 (now §4.5 below) becomes a *symbol-index over `acclient.c`*, not the primary reference.
- §10 (coverage honesty) — this section needs to acknowledge that the original ACBindings-as-oracle framing was wrong. Done in §10.2 below.

---

## 4.5 Tier 3 — `ACBindings` as Symbol Navigator (Demoted from Tier 2)

**Do not port these files.** Their method bodies are `((delegate* unmanaged[Thiscall]<…>)0xHEXADDR)(ref this, args)` indirect calls into the running retail `acclient.exe` at hardcoded addresses. Useless outside the injected-process model.

**What's still useful:** ACBindings' file/folder structure is a more legible index over the same retail surface than 938k lines of C. And the LLM-generated XML doc-comments serve as a quick "what is this method for, in one sentence" before you commit to reading the real Hex-Rays body. So ACBindings becomes the **navigation layer** for §4-Alt:

1. Browse `ACBindings/Generated/Game/Combat/` to find the method name you want (e.g. `AttackManager.NewAttack`).
2. Read the LLM doc-comment: *"Creates a new AttackInfo object with an ID derived from the manager's current_attack counter…"*. Confirm it's the right method.
3. Grep `acclient.c` for `AttackManager::NewAttack` → read the real body.

That's the workflow. The doc-comments are a search ranker, not a source of truth.

### 4.5.1 High-value navigation index (mapping our future work → which ACBindings file to browse for the symbol name)

| Area we'll need to implement | ACBindings file (for symbol name) | Then grep `acclient.c` for |
|---|---|---|
| Motion-table-driven swing pose | `Generated/CMotionInterp.cs`, `Generated/Dats/DBObjs/CMotionTable.cs` | `CMotionInterp::*`, `CMotionTable::*` |
| Combat orchestration (mode/repeat/charge) | `Generated/Game/Systems/ClientCombatSystem.cs` | `ClientCombatSystem::*` (275 hits in acclient.c — substantial body) |
| Attack execution & info plumbing | `Generated/Game/Combat/AttackManager.cs`, `Generated/Game/Combat/{AttackInfo,AttackHook,AttackCone}.cs` | `AttackManager::*`, `AttackInfo::*`, etc. |
| Spell casting flow | `Generated/Game/Spells/gmSpellcastingUI.cs`, `gmSpellbookUI.cs`, `Generated/Game/Systems/ClientMagicSystem.cs` | `ClientMagicSystem::*`, `gmSpellcastingUI::*` |
| Spell components | `Generated/Game/Spells/{SpellComponentCategory,SpellComponentRegion,SpellComponentType}.cs`, `Generated/Dats/DBObjs/SpellComponentTable.cs` | `CSpellComponentTable::*` |
| Spell metadata | `Generated/Game/Spells/{SpellBanks,SpellCategoryDB,SpellIndex,SpellType}.cs`, `Generated/Dats/DBObjs/CSpellTable.cs` | `CSpellTable::*` |
| Particle runtime | `Generated/Dats/Types/AnimHooks/{Create,CreateBlocking,Destroy,Stop}ParticleHook.cs`, `Generated/Dats/DBObjs/ParticleEmitterInfo.cs` | `ParticleEmitterInfo::*`, `CreateParticleHook::*`, etc. |
| Sound table runtime | `Generated/Dats/Types/AnimHooks/{Sound,SoundTable,SoundTweaked}Hook.cs`, `Generated/Dats/DBObjs/CSoundTable.cs`, `Generated/CDirSound.cs`, `Generated/Dats/Types/{CSoundDesc,AmbientSoundDesc}.cs` | `CSoundTable::*`, `CDirSound::*` |
| Physics scripts | `Generated/Dats/DBObjs/{PhysicsScript,PhysicsScriptTable}.cs` | `PhysicsScript::*`, `PhysicsScriptTable::*` |
| GfxObj / SetupModel renderer | `Generated/Dats/DBObjs/{CGfxObj,CSetup,RenderSurface,RenderTexture,RenderMesh,RenderMaterial,GfxObjDegradeInfo}.cs` | `CGfxObj::*`, `CSetup::*` |
| Char-gen | `Generated/Game/CharGen/Skill_CG.cs`, `Generated/{AttributeQualityBlob}.cs`, `Generated/Dats/DBObjs/Attribute2ndTable.cs` | `CharGenState::*` (352 hits — big), `Attribute2ndTable::*` |
| Combat maneuvers (animation) | `Generated/Dats/DBObjs/CombatManeuverTable.cs` | `CombatManeuverTable::*` |
| Skill table | `Generated/Dats/DBObjs/SkillTable.cs` | `CSkillTable::*` |
| Appraisal decorations | `Generated/{AppraisalLongDescDecorations,AttunedStatusEnum,BondedStatusEnum}.cs` | `AppraisalProfile::*` (270 hits) |
| Cell / portal / building geometry | `Generated/{CBldPortal,CBuildingObj,CCellPortal,CCellStruct,BlockListEntry,BlockListLoader}.cs` | `CBuildingObj::*`, `CCellStruct::*` |
| Collision primitives | `Generated/{CCylSphere,BBox,Box2D,BoundingType}.cs` | `CCylSphere::*`, `BBox::*` |
| Object lifecycle (live world objects) | (no single ACBindings file; look in `Generated/Game/Systems/`) | `ClientObjMaintSystem::*` (424 hits) |
| Networking — client side | (no ACBindings; look in `Chorizite.ACProtocol/`) | `ClientCommunicationSystem::*` (538 hits) |
| Player module behaviour | (no ACBindings; look in `Generated/Game/`) | `PlayerModule::*` (656 hits), `CPlayerSystem::*` (688 hits) |

**Note on the last three rows:** these are major subsystems where ACBindings' coverage is thin or non-existent but `acclient.c` has hundreds of methods. **Don't let ACBindings' lack of coverage on something fool you into thinking the retail code is thin** — go straight to `acclient.c`.

### 4.6 What ACBindings still wins at

- **Topical browsing.** Folders like `Generated/Game/Combat/`, `Generated/Game/Spells/`, `Generated/Dats/Types/AnimHooks/` are nicer than groveling through 1,078 unsorted C++ classes.
- **One-sentence intent.** The XML doc-comments let you triage 50 method names down to 5 to actually read.
- **Type clarity.** C# enum types vs raw `unsigned int` parameters in decomp output — easier to figure out what an argument means.

### 4.7 Order of precedence (revised)

The previous draft cited memory's `feedback_three_source_cross_reference.md` for the precedence:

- ~~ACE > ACBindings doc-comments > acclient.h~~ (old)
- **ACE server source > local `acclient.c` body > `acclient.h` struct layout > Binary Ninja cross-decomp > ACBindings doc-comments + folder index** (new)

ACE is still on top — it's the active server implementation, runs the rules the server actually enforces, and has had years of community fix-up. But everything below ACE is now grounded in our local decompilation.

---

## 5. Tier 4 — Parity / Cross-Check Checklist

### 5.1 `Chorizite.Common/Enums/*` — 59 enums to cross-check

For each of the 59 enum files in `Chorizite.Common/Enums/`, do a 5-minute parity check vs our equivalent in `holtburger-common`:

| Chorizite enum | Our location | Action |
|---|---|---|
| AttackHeight, AttackType, CombatMode, DamageType, MagicSchool, AmmoType | `holtburger-common/src/properties/` (verify) | Confirm int values match |
| AttributeId, SkillId, VitalId, CurVitalId, PropertyAttribute2nd | `holtburger-common/src/stats/` | Confirm names + values |
| PropertyBool, PropertyDataId, PropertyFloat, PropertyInstanceId, PropertyInt, PropertyInt64, PropertyPosition, PropertyString, ContainerProperties | `holtburger-common/src/properties/` | These are the master property tables. Authoritative. |
| MotionCommand, MotionStance, PlayScript | `holtburger-common/src/properties/motion.rs` (verify) | Confirm. |
| HeritageGroup, Gender, CharacterOptions1, CharacterOptions2 | `holtburger-common/src/character/` (verify) | Confirm. |
| ObjectClass, ItemType, MaterialType, CoverageMask, EquipMask, ParentLocation, Placement | per-subsystem | Confirm — these gate the WorldObject typed-class dispatch in §3. |
| HookType, EnchantmentTypeFlags, SpellCategory, SpellComponentType, SpellFlags, SpellType, SpellBookFilterOptions | `holtburger-common/src/properties/`, `holtburger-world/src/magic/` | Confirm. |
| PhysicsState, PhysicsDescriptionFlag | `holtburger-common/src/properties/physics.rs` (verify) | Critical for the kind=17 visibility gate (per memory: entity collision + physics-state draw-gate). |
| DatFileType | `holtburger-dat/src/file_type/` | Cross-check with our 0x01–0x78 table (per memory `reference_ac_dat_file_types.md`). |
| ImbuedEffectType, ClientAction, FriendsUpdateType, EmoteCategory, EmoteType, RadarBehavior, RadarColor, RootElementId, UiEffects, PortalBitmask, PlayerKillerStatus, AllegianceOfficerLevel, CreatureType, SkillAdvancementClass, SummoningMastery, Sound | per-subsystem; some may be gaps | For each: grep for the name in `holtburger-common`. If not found → gap. |

**Action item:** spawn one agent per ~20 enums to do this parity check; surface gaps as TODOs. This is mechanical work.

### 5.2 `Chorizite.ACProtocol/Enums/*.generated.cs` — opcode + message parity

`Chorizite.ACProtocol` source-generates protocol types from XML defs. Useful for:
- **Opcode coverage check.** Each `Enums/*MessageType.generated.cs` enumerates the message universe. Cross-check vs `holtburger-protocol::opcodes`.
- **C2S / S2C handler enumeration.** `C2SMessageHandler.generated.cs` enumerates client→server, similar S2C file enumerates the other direction. The unique handler names there map 1:1 to the events listed in §3.4.

**Action item:** spawn an agent to diff the message-type enums against `holtburger-protocol/src/opcodes.rs`; flag missing opcodes.

### 5.3 `DatReaderWriter.Tests/DBObjs/*` — fixture goldens

The DatReaderWriter test suite has one file per DAT format (44+ formats) — each loads a real fixture and asserts on parsed field values. These are **gold** for verifying our `holtburger-dat` parsers.

| DatReaderWriter test | Our parser | Action |
|---|---|---|
| `MotionTableTests.cs` | `holtburger-dat/src/dbobj/motion_table.rs` | Pull fixture path + assertion list; replicate as Rust integration test |
| `CombatTableTests.cs` | (likely a gap — we have movement but combat-maneuver table TBD) | Identify gap |
| `ParticleEmitterTests.cs` | `holtburger-dat/.../particle_emitter.rs` | Verify (per memory: schema vector vs scalar fix for GfxObjId) |
| `PhysicsScriptTests.cs`, `PhysicsScriptTableTests.cs` | `holtburger-dat/.../physics_script.rs` | Verify |
| `SetupTests.cs`, `GfxObjTests.cs`, `GfxObjDegradeInfoTests.cs` | `holtburger-dat/.../{setup_model, gfx_obj}.rs` | Verify |
| `SkillTableTests.cs`, `SpellTableTests.cs`, `SpellComponentTableTests.cs` | per-area | Verify |
| `SoundTableTests.cs` | `holtburger-dat/.../sound_table.rs` (per memory: parser + AmbientRuntime exist) | Verify |
| `LandBlockTests.cs`, `LandBlockInfoTests.cs`, `EnvCellTests.cs`, `EnvironmentTests.cs` | `holtburger-dat/.../landblock.rs`, `env_cell.rs` | Verify (per memory: cells + env-cell wiring shipped 2026-05-12) |
| `ChatPoseTableTests.cs`, `MaterialInstanceTests.cs`, `MaterialModifierTests.cs`, `RenderMaterialTests.cs`, `RenderTextureTests.cs`, `RenderSurfaceTests.cs`, `PalSetTests.cs`, `RegionTests.cs`, `LayoutDescTests.cs`, `ObjectHierarchyTests.cs`, `ContractTableTests.cs`, `LanguageInfoTests.cs`, `LanguageStringTests.cs`, `EnumIDMapTests.cs`, `EnumMapperTests.cs`, `FontTests.cs`, `BadDataTableTests.cs`, `NameFilterTableTests.cs`, `QualityFilterTests.cs`, `ActionMapTests.cs`, `AnimationTests.cs`, `CharGenTests.cs`, `ClothingTableTests.cs`, `DBPropertiesTests.cs`, `ExperienceTableTests.cs`, `MasterInputMapTests.cs`, `MasterPropertyTests.cs` | per-area | Audit; many are likely partial in our impl |

**Action item:** run one agent per ~5 test files to audit parity, producing per-format pass/fail/gap report.

### 5.4 `DatReaderWriter.Extensions`

Small helper layer. Notable files: `StringHashExtensions.cs`, `RenderSurfaceExtensions.cs`, `StringTableExtensions.cs`, `EnumIDMapExtensions.cs`, `EnumMapperExtensions.cs`, `DatEasyWriter.*.cs`. Most likely useful as inspiration only — check if their hash function differs from ours (32-bit AC hash we already implement via `holtburger_protocol::crypto::Hash32`).

---

## 6. Tier 6 — `ida-scripts` (Future Tooling)

This isn't a port; it's a tool to remember.

**What it is:** Python scripts for IDA Pro 8.2 + Diaphora that port PDB-equipped client symbols (Microsoft acclient.exe binary + PDB) to the EOR (End Of Retail) client (no PDB). Outputs a symbol-renamed IDA database + type info; **this is the upstream pipeline that generates ACBindings**.

**Files:**
- `export-pdb-data.py` — run on the PDB build; dumps to sqlite
- `import-pdb-data.py` — run on the EOR build; renames symbols + imports types
- `data/yonneh.map` — name-bound symbol map (pre-existing reference data)
- `data/acclient.idc-pdb-types.zip` — type info from PDB

**Why future-relevant:**
- If we ever want to **regenerate ACBindings against a different client variant** (e.g. ToD vs current EOR), this is the recipe.
- More speculatively, with modification, this could be the basis of a script that emits **Rust** bindings (with offset-anchored doc-comments) instead of C# ones. That would give us a `~/ac-bindings-rs/` reference catalog mirroring ACBindings but in our language, callable as a behavioral oracle from within the Rust crates.

**Action item today:** none. Document and move on. A future RE/data-archaeology session should pick this up.

---

## 7. First Bricks (Recommended Next 3 PRs)

Per the user's "Rome was not built in a day but it was started with the first brick" framing, here is a concrete on-ramp:

### PR 1 — Adopt ACPlugin event taxonomy in `plugins/api.js`

- Add the §3.4 event-name enum to `plugins/api.js` as the canonical event list.
- For each event we already emit, rename if needed to match ACPlugin's naming (e.g. our `kind=10 ObjectCreated` should match their `OnWeenieCreated`; pick one and rename consistently).
- For each event we **don't** yet emit, add a TODO with the ACPlugin source method name and the underlying S2C opcode we'd dispatch from.
- Net result: a single authoritative event list + a coverage backlog.

**Cost:** ~150–300 LOC + comments; no wasm-side change.

### PR 2 — Port `WorldObject` + 24-subclass hierarchy as JS classes

- Create `plugins/world-objects/world_object.js` with the 8-typed-dict pattern from `ACPlugin/API/WorldObject.cs` (IntValues, FloatValues, BoolValues, StringValues, InstanceValues, DataValues, PositionValues, plus the `.value(prop, default)` accessor pattern).
- Create the 24 subclasses (Container, Character, Creature, Player, NPC, Monster, Vendor, Door, Portal, Lifestone, Bindstone, Static, and 13 item types) as thin extensions.
- Create `plugins/world-object-manager.js` that owns `Map<guid, WorldObject>` and dispatches typed-class creation via a port of `GetObjectClass(itemType, behavior, header)` (reference: `ACPlugin/API/WorldObject.cs` body — read for the dispatch table).
- Wire `world-object-manager` to subscribe to the kind=10/etc. events from `api.js` and populate its map.
- Vitals-hud, combat-bar, etc. continue working unchanged (the manager is additive).

**Cost:** ~600–1000 LOC of mostly-mechanical JS. No wasm change.

### PR 3 — Cross-check `Chorizite.Common/Enums` against `holtburger-common`

- Spawn 3 Explore agents in parallel (each covering ~20 enums) to compare integer values + member names.
- Emit a gap-fill PR adding any missing enum variants to our crate.

**Cost:** Mostly investigation; small additive PR.

These three PRs together stay grounded ("Rome's first bricks"), each is reviewable in isolation, and they unblock 80% of the higher-effort follow-ons (vendor UI, buff/debuff HUD, identify panel, etc. — all of which want the typed `WorldObject` hierarchy).

---

## 8. Follow-on Wave (PRs 4–10ish)

Once the foundation from PRs 1–3 is in:

| PR | Subject | Source | Target | Hard? |
|---|---|---|---|---|
| 4 | ~~Vendor UI~~ **SHIPPED 2026-05-19** (commit 6eeaf8c — see §14) | `ACPlugin/API/WorldObjects/Vendor.cs` + `OnContainerOpened/Closed` event handlers | `plugins/vendor-ui.js` v0.2.0 + `VendorStateJs` wasm cache + `buyFromVendor`/`sellToVendor` | Done |
| 5 | Buff/debuff HUD | `ACPlugin/API/Enchantment.cs` + `OnEnchantmentChanged` | `plugins/buffs-debuffs-hud.js` | Medium — backing data exists per memory; just needs the JS view |
| 6 | Identify/appraisal panel | `ACPlugin/API/WorldObject.cs` HasAppraisalData + memory's `identify.rs` (already in `holtburger-world`) | `plugins/identify-panel.js` + Right-click → Examine wiring | Medium |
| 7 | Skill / attribute / training panel | `ACPlugin/API/SkillFormula.cs` + `SkillInfo.cs` + `AttributeInfo.cs` | `plugins/character-panel.js` | Medium |
| 8 | Motion-table-driven swing pose | `~/ac-headers/acclient.c` `CMotionInterp::*` bodies + ACE motion-table source (use ACBindings `Generated/CMotionInterp.cs` as folder index) | wasm-side motion classifier + `scene3d/entities.js` setSwingPoseFromMotion | Hard — needs wasm export shape + JS-side filter; per memory ~70 LOC of seam wiring exists |
| 9 | Particle runtime (replace JS placeholders with real runtime) | `~/ac-headers/acclient.c` `ParticleEmitterInfo::*` + AnimHook walkers + memory's `project_holtburger_sky_j_done_2026-05-12.md` (we have parser + JS runtime) | extend `scene3d/particles/particle_manager.js` to consume entity AnimHook events | Medium-Hard |
| 10 | Sound table runtime | `ACBindings/Dats/Types/AnimHooks/SoundHook.cs` etc. + memory's `project_holtburger_ambient_sounds_done_2026-05-12.md` (we have parser + AmbientRuntime + hooks) | wire `scene3d/audio/sound_table_cache.js` (currently infra-only) | Medium |
| 11 | Allegiance / fellowship UI | `ACPlugin` (no specific class yet, but messages exist in `Chorizite.ACProtocol`) | `plugins/social-panel.js` | Medium |
| 12+ | Right-click radial menus, drag-drop refinements, container UI, equipment paper-doll, … | various | various | Varies |

---

## 9. Anti-Goals (Things to NOT Port)

Documenting these so future sessions don't waste time:

1. **Don't port any C# code that calls into `delegate* unmanaged[Thiscall]<…>` addresses.** That's all of `ACBindings` execution-side; it's process-injection code.
2. **Don't port `Chorizite.Injector`.** We're the client.
3. **Don't port RmlUi anything.** Browser DOM is strictly more capable for our use case.
4. **Don't port `LuaPlugin`.** We have Deno-based scripting in `holtburger-scripting`.
5. **Don't port `TaffySharp`.** CSS handles layout.
6. **Don't port `LauncherPlugin`.** Browser URL is the launcher.
7. **Don't port plugin manifest schema verbatim if it forces .NET/RmlUi assumptions.** Adopt the **idea** (id/name/author/entry/version/dependencies/environments JSON) but keep our environments enum (browser/tui/cli) instead of theirs (Client/Launcher).
8. **Don't bulk-port `ACBindings/Generated/*.cs`.** Read on demand.
9. **Don't port `WorldBuilder` (the editor).** It's a peer consumer, not a dependency. Our `WorldBuilder.Terminal` already uses the same chorizite NuGet packs (per memory `reference_worldbuilder_terminal.md` — used as our AC data oracle).
10. **Don't introduce a virtual-DOM library "because Chorizite uses one."** Their VDOM is a workaround for RmlUi not having React; we don't have that constraint.

---

## 10. Coverage Honesty (Read Me Before Acting)

This section flags every place this audit went shallow. Future agents working from this plan should treat the items below as "verify before acting on it."

### 10.0 The biggest miss in the first draft

The original first draft of this plan **treated `Chorizite.ACBindings` as the canonical retail-behavior reference**, and built §4 around using its LLM-generated XML doc-comments as the source of truth for "what does this retail method do." That was wrong. The local `~/ac-headers/acclient.c` (938k lines of actual Hex-Rays decompiled C source from retail `acclient.exe`) was already on disk — I extrapolated from the existing memory entry that only mentioned `acclient.h` and missed the `.c` file with the actual method bodies.

This revision (§4-Alt, with §4.5 demoting ACBindings to a navigation aid) corrects that. The lesson for future agents: when planning to port retail AC behavior, **`ls ~/ac-headers/` before anything else**.

### 10.1 Survey breadth vs depth

- **23 repos enumerated; ~6 deeply sampled.** Chorizite.Core, ACBindings, ACPlugin, Chorizite.Common, DatReaderWriter, ida-scripts. The rest got tree-listing + one-line README only.
- **ACBindings: 1,899 files; ~6 read in detail.** ClientCombatSystem, AttackManager, CMotionInterp, plus the doc-comments on get_jump_v_z / motion_allows_jump / jump_charge_is_allowed. The §4.5.1 file-name → use-case index is **inferred from file names + the consistent style of the 6 read**, not from reading each file. Trust the index for navigation, verify before quoting.
- **`~/ac-headers/acclient.c` (the actual primary reference): 938k lines; ~3 function bodies actually read** (`CMotionInterp::get_jump_v_z`, partially `CMotionInterp::InqStyle`, `CPhysicsObj::on_ground`). The 1,078-class catalog + top-30 counts in §4.2 are mechanically grep-derived, not curated. When picking up a specific subsystem, expect to spend a session reading dozens to hundreds of related methods. Treat my counts as orientation, not a substitute for reading.
- **ACPlugin: ~70 files; ~6 read in detail.** Game, World, Character, WorldObject (base), SkillFormula, manifest.json. The 24-WorldObject subclasses + 12 EventArgs + Actions.cs + WorldObjectManager.cs were **enumerated from the file tree but not read line-by-line.** Their existence is confirmed; their field-by-field shape is not.
- **Chorizite.Core: ~12 files enumerated; 0 read in detail.** The architectural inspiration claim in §2 is based on the file-name pattern (IPluginManager / IClientBackend / AssemblyPluginLoader / PluginManifest), not the actual implementation. Before adopting the manifest schema in PR 1, read at least `PluginManifest.cs` and `AssemblyPluginManifest.cs`.
- **DatReaderWriter.Tests: enumerated; 0 read.** The §5.3 table assumes each `*Tests.cs` follows the "load fixture, assert on fields" pattern. Spot-check one before committing to the parity-validation strategy.
- **Local 3D-renderer surface:** the Explore-agent report covered the major files but explicitly flagged **[partial coverage]** on dynamic render-state updates, audio/particle DAT structures, and wasm export contracts. Read those agent caveats before assuming PR 9/10 are well-scoped.
- **Local wasm/JS bridge:** the second Explore-agent report covered the 28 SessionHandle methods + 25 free functions + 35 exported types, but the §3.4 event-rename / kind-numbering proposal is based on JS-side grep patterns, not exhaustive wasm-side reading. Before renaming events in PR 1, read `holtburger-web/src/lib.rs` ClientEvent definitions directly.
- **Local Rust crates:** the third Explore-agent report enumerated the 8 crates' public modules and listed 14 TODO subsystems, but the placement suggestions (e.g. "vitals math → `holtburger-world/src/player/vitals.rs`") assume the crate boundaries; verify each landing path against `crates/holtburger-world/src/lib.rs` `pub mod` declarations before writing.
- **Binary Ninja cross-decomp (`acclient_2013.bndb_pseudo_c.txt`): 0 lines read in detail.** The "use it as cross-validation" recommendation in §4.1 is sound in principle but unproven in practice. Spot-check on the first non-trivial implementation to confirm the two decomps line up structurally.
- **`acclient.txt` (PDB symbol dump): scanned for section headers only.** Modules / Publics / Types / Mismatch sections exist. Specific symbol-to-OBJ-file lookups not yet exercised.

### 10.2 Where I made judgment calls (and might be wrong)

- **SkillFormula.cs `HasAttribute2` looks buggy** (returns true when Attribute2 == 0, opposite of what the docstring says). Flagged in §3.2 — verify before adopting. May just be a typo in their codebase that we can ignore.
- **The "Tier 6 — Skip" list** assumes browser/DOM is strictly better for our case. If we ever target a desktop/native build (per memory: TUI client exists, "future 3D client" is on roadmap), RmlUi.Net + TaffySharp + LauncherPlugin become re-evaluation candidates.
- **The first-3-bricks ordering** is opinionated. If the immediate gameplay need is e.g. vendor UI, jump straight to PR 4 instead of PR 1-2-3; just be aware the cost is doing things twice (once ad-hoc, once with the typed hierarchy).
- **`Chorizite.Core` plugin model adoption (PR 1 manifest schema):** marked Tier 5 inspiration, but if we adopt the manifest JSON shape it borders on Tier 4 (parity). Pick a side and don't fragment.
- **Don't trust `ACBindings` doc-comments for any subsystem before reading the actual `acclient.c` body.** Per memory `feedback_three_source_cross_reference.md` (revised by §4.7 above): **ACE server > local `acclient.c` body > `acclient.h` struct > Binary Ninja cross-decomp > ACBindings doc-comments + folder index.** ACBindings is a navigation aid, not an oracle.

### 10.3 What this plan does NOT cover

- **ACE server source cross-reference.** This plan focuses on Chorizite + retail decomp. For each gameplay system we port, the ACE server source is still the top of the precedence stack and should be consulted (see memory).
- **`acclient.h` exhaustive overlap with ACBindings.** Both describe retail struct layouts. ACBindings adds LLM doc-comments but is otherwise redundant with `acclient.h`. The plan doesn't enumerate the overlap; assume `acclient.h` is more reliable (it came from the same Hex-Rays pass as `acclient.c`).
- **Performance / sizing.** None of the porting estimates account for wasm-size, bundle-size, or runtime cost. Trust them as relative effort signals only.
- **Licensing.** Chorizite is MIT (verified for `Chorizite/Chorizite` core; assumed for others — verify before redistributing). The `~/ac-headers/` files are derived from retail `acclient.exe` and `acclient.pdb` — same legal status as the existing ACE / WB / ACBindings ecosystem; treat them as in-house reference, not redistributable.
- **The `external/holtburger` git remote.** This is an upstream-tracked subtree. The canonical sync log + vendor manifest lives at [`../../VENDORED.md`](../../VENDORED.md) (i.e. `external/holtburger/VENDORED.md` from repo root). Modifications to `external/holtburger/apps/holtburger-web/plugins/` may have upstream-sync implications. **Confirm the sync policy before opening a PR.** This doc lives there too — moving it is fine if upstream sync is fragile.

---

## 11. How a Future Agent Should Use This Doc

If you are picking this up:

1. Read §0 (TL;DR) and §1 (context). 5 minutes.
2. Skim §2 (master table) for the verdict on whichever repo you're investigating. 2 minutes.
3. If working on the Tier 1 port: §3 is the checklist; §7 is the on-ramp.
4. If implementing a specific subsystem (combat, magic, motion, particles, sound): §4.2 tells you which ACBindings file is the behavioral oracle for it.
5. If doing parity work (enums, opcodes, DAT formats): §5 is the playbook.
6. Before acting on any specific claim in §2–§7, re-check §10 for the coverage caveat on that area.
7. **Update this doc as you go.** Each PR that ports something should add a "✓ Ported in PR #N" annotation next to the relevant row, plus a memory entry per the repo's memory conventions. Don't let this doc rot — the value evaporates if it's not kept current.

---

## Appendix A — Quick Repo Reference (clone URLs, default branches, sizes)

| Repo | URL | Default branch | Source files (visible at survey time) |
|---|---|---|---|
| ACBindings | https://github.com/Chorizite/ACBindings | master | 1,899 generated .cs files |
| ACPlugin | https://github.com/Chorizite/ACPlugin | (verify) | ~70 .cs files + RML/Lua assets |
| Chorizite (core) | https://github.com/Chorizite/Chorizite | (verify) | ~50+ .cs across Core/Launcher/NativeClientBootstrapper/DocGen/Tests |
| Chorizite.Common | https://github.com/Chorizite/Chorizite.Common | (verify) | 59 enums + utility files |
| Chorizite.ACProtocol | https://github.com/Chorizite/Chorizite.ACProtocol | (verify) | Source-generator + many generated enums + handlers |
| DatReaderWriter | https://github.com/Chorizite/DatReaderWriter | (verify) | Source-generator + DBObjs + 44+ test fixtures |
| DatReaderWriter.Extensions | https://github.com/Chorizite/DatReaderWriter.Extensions | (verify) | ~14 helper extensions |
| Chorizite.Injector | https://github.com/Chorizite/Chorizite.Injector | (verify) | C++ DLL injection |
| RmlUi.Net | https://github.com/Chorizite/RmlUi.Net | (verify) | C# + C++ native bindings |
| RmlUiPlugin | https://github.com/Chorizite/RmlUiPlugin | (verify) | VDOM + reactive helpers + assets |
| LauncherPlugin | https://github.com/Chorizite/LauncherPlugin | (verify) | Launcher UI + update checker |
| LuaPlugin | https://github.com/Chorizite/LuaPlugin | (verify) | XLua bindings |
| PluginManagerUIPlugin | https://github.com/Chorizite/PluginManagerUIPlugin | (verify) | RML+Lua plugin manager UI |
| TaffySharp | https://github.com/Chorizite/TaffySharp | (verify) | Rust taffy → C# bindings |
| ida-scripts | https://github.com/Chorizite/ida-scripts | (verify) | Python IDA scripts |
| WorldBuilder | https://github.com/Chorizite/WorldBuilder | (verify) | C# editor (we consume same packs in our WB.* projects) |
| Chorizite.VSCode | https://github.com/Chorizite/Chorizite.VSCode | (verify) | TS VSCode extension |
| Chorizite.Plugins.MSBuildTasks | https://github.com/Chorizite/Chorizite.Plugins.MSBuildTasks | (verify) | MSBuild tasks |
| plugin-index | https://github.com/Chorizite/plugin-index | (verify) | Plugin metadata |
| CoreTestPlugin | https://github.com/Chorizite/CoreTestPlugin | (verify) | Test plugin |
| chorizite.github.io | https://github.com/Chorizite/chorizite.github.io | (verify) | Vue website |
| .github | https://github.com/Chorizite/.github | (verify) | Org meta |
| github-workflows | https://github.com/Chorizite/github-workflows | (verify) | Shared CI |

Default branches marked "(verify)" weren't confirmed in this pass; ACBindings was confirmed `master`. Use `gh api repos/Chorizite/<name> --jq .default_branch` if needed.

## Appendix B — Already-Vendored Chorizite Code in This Repo

**Source vendored 2026-05-19 to `external/chorizite/` per manifest at [`external/chorizite/VENDORED.md`](../../../chorizite/VENDORED.md):**

| Repo | Path | Tier |
|---|---|---|
| ACPlugin | `external/chorizite/ACPlugin/` | 1 — direct port |
| ACBindings | `external/chorizite/ACBindings/` | 3 — symbol nav |
| Chorizite.Common | `external/chorizite/Chorizite.Common/` | 4 — parity |
| Chorizite.ACProtocol | `external/chorizite/Chorizite.ACProtocol/` | 4 — parity |
| DatReaderWriter | `external/DatReaderWriter/` (already at top level) | 4 — parity + fixtures |
| DatReaderWriter.Extensions | `external/chorizite/DatReaderWriter.Extensions/` | 4 — parity |
| Chorizite (core) | `external/chorizite/Chorizite/` | 5 — plugin model |
| RmlUiPlugin | `external/chorizite/RmlUiPlugin/` | 5 — VDom inspiration |

Vendored via `git clone --depth 1`. `.git` dirs preserved for provenance — `git remote -v` + `git rev-parse HEAD` inside any subdir resolves the upstream URL + commit.

**NuGet-only (compiled artifacts, no source):** `~/.nuget/packages/chorizite.{core,datreaderwriter,acprotocol,common}/` — consumed by our WB.* C# builds. The vendored `external/chorizite/*` supersedes these for source-level inspection.

**Other reference (not chorizite org):**

- `/home/wbterminal/WorldBuilder-ACME-Edition/Chorizite.OpenGLSDLBackend/` — A locally-modified rendering backend (consumes Chorizite.Core 0.0.17, Silk.NET.OpenGL, NAudio, SixLabors.ImageSharp). Useful as a reference for how Chorizite expects renderers to plug in, but not directly applicable to a browser build.

Our `WorldBuilder.Terminal` (per memory `reference_worldbuilder_terminal.md`) consumes the chorizite NuGet packs and is therefore an in-house, real-runtime cross-reference for what those packs expose. When in doubt about a Chorizite API, point `WorldBuilder.Terminal` at it before reading docs.

## Appendix C — Local Retail Decompilation (Primary Behavioral Reference)

Not Chorizite, but the **single most important resource** for any retail-behavior porting work. Lives at `/home/wbterminal/ac-headers/`:

| File | Size | Lines | What it is |
|---|---|---|---|
| `acclient.c` | 31 MB | 938,010 | Hex-Rays decompiled C source of retail `acclient.exe`. **1,078 C++ classes.** Actual method bodies with real numeric constants, branches, and vtable dispatches. |
| `acclient.h` | 1.7 MB | — | Struct + enum reference from the same decomp pass. 348 enums + ~6,936 structs (per memory `reference_ac_re_artifacts.md`). |
| `acclient.txt` | 79 MB | 1,483,342 | Microsoft `cvdump` over retail `acclient.pdb`. Module table, public symbols, type info, build path `d:\ac1_sep13\output\`. Useful for OBJ-file archaeology. |
| `acclient_2013.bndb_pseudo_c.txt` | 63 MB | 1,437,645 | Independent Binary Ninja pseudo-C export over `acclient_2013.bndb`. Use as cross-decompiler validation when Hex-Rays output is unclear or suspect. |

Top subsystems by method-count in `acclient.c` (grep + sort): UIElement (2384), StringInfo (1271), Archive (1163), CPhysicsObj (1049), UIElement_Text (947), BaseProperty (765), UIRegion (752), ACCWeenieObject (701), CPlayerSystem (688), PlayerModule (656), \_STL (655), PFileNode (620), ClientCommunicationSystem (538), Proto_UI (532), RenderDeviceD3D (460), UIElement_ListBox (455), UIElement_ItemList (443), ClientSystem (440), DBObj (430), ClientObjMaintSystem (424), ClientUISystem (401), Render (359), CharGenState (352), SmartBuffer (330), CPartArray (326), Frame (324), OrderHdr (318), UIElementManager (309), PixelFormatDesc (276), AppraisalProfile (270).

**Read §4-Alt for the workflow.** Treat as in-house reference; not redistributable.

---

## 12. WB.Terminal as the C# absorption layer (added rev 3, 2026-05-19)

### 12.1 The strategic shift

The first 11 sections of this plan assumed all chorizite porting flows toward `holtburger-web` (Rust + JS). After the parallel reading-guide pass, a user instinct landed: **`WorldBuilder.Terminal` is the natural absorption layer for chorizite C#, not holtburger-web.**

The reasons are concrete:
- WB.Terminal is already C# (.NET 8) and already imports `Chorizite.DatReaderWriter` as a NuGet (`csproj:18`).
- WB.Terminal has 147 JSON-stdin commands (see `~/.claude/skills/worldbuilder-terminal/skill.md`) and is the "AC data oracle" per memory `reference_worldbuilder_terminal.md`.
- A C# command consuming chorizite NuGets is ~10× smaller than the Rust equivalent (no parser to write, no symbol table to transcribe).
- Two of our last three deep-dives (motion-table audit + monster validation) would have been ~30 LOC of C# in WB.Terminal vs the ~600 LOC of Rust tests we actually wrote.

**But** — not all chorizite porting collapses to WB.Terminal. Two contexts to keep separate:

| Concern | Right home | Why |
|---|---|---|
| Inspection / probing / parity validation | WB.Terminal (C# + chorizite NuGet) | Tool work; runs on operator command |
| Data preprocessing (catalogs, taxonomies, dump→JSON) | WB.Terminal | Run once, emit JSON, browser consumes |
| Per-frame runtime (motion, collision, animation, particles) | holtburger-web (Rust + wasm + JS) | Must run every frame in a browser tab |
| Wire protocol in live session | holtburger-web (Rust + wasm) | UDP packets in the browser — must be wasm |
| UI structure (plugins, HUD, panels) | holtburger-web (JS + DOM) | Browser-bound |

### 12.2 What landed (this PR pass)

**WB.Terminal absorption:**
- `WorldBuilder.Terminal.csproj` — added `ProjectReference` to `external/chorizite/Chorizite.Common/Chorizite.Common.csproj` + `System.Text.Encoding.CodePages` NuGet (needed for Windows-1252 in AC string hash).
- New `CommandEngine.Chorizite.cs` (~200 LOC) with three engine methods:
  - `ChoriziteDumpEnumValues(enumName?)` — reflects over `Chorizite.Common.Enums`, dumps int → name JSON for any (or all) enums.
  - `ChoriziteDumpWorldObjectTaxonomy(sourceRoot?)` — file-system parses `external/chorizite/ACPlugin/API/WorldObjects/*.cs`, extracts class hierarchy + ItemType/ObjectClass tags.
  - `ChoriziteHashString(input)` — AC string-key hash (per `DatReaderWriter.Extensions/StringHashExtensions.cs`). NOT the same as `Hash32` packet checksum.
- Three JSON dispatch entries in `JsonCommandProcessor.cs:300-302` + handlers.
- Verified by smoke test: `WalkForward → 0x0085473E`, `NonCombat → 0x0A59B42C`, AttackHeight enum dump correct (High=1, Medium=2, Low=3), taxonomy returns 31 classes with full inheritance chains.

**Generated data files** (committed at `apps/holtburger-web/data/chorizite/`):
- `world-object-taxonomy.json` — 31 classes with name/baseClass/relativePath/itemTypeTags/objectClassTags. Generated via `chorizite-dump-world-object-taxonomy`.
- `chorizite-common-enums.json` — 9 enums (AttackHeight, AttackType, ItemType, ObjectClass, SpellType, SpellFlags, DamageType, MagicSchool, CombatMode). Generated via `chorizite-dump-enum-values`. Expand by adding more enum names to the regen script in the data dir's README.

### 12.3 Revised port plan per repo

Updated tier assessments now that WB.Terminal is in the picture:

| Repo | Original tier | Revised home | First action |
|---|---|---|---|
| ACPlugin | Tier 1 (port to JS) | **Split:** taxonomy → WB.Terminal cmd → JSON → JS skeleton (§13). Behaviors → JS plugins/world-objects/*.js over time. | Done (this PR). |
| ACBindings | Tier 3 (navigation only) | Unchanged — applies to both contexts | N/A. Stays a read-only ref. |
| Chorizite.Common | Tier 4 (parity) | **WB.Terminal** as source of truth; Rust transcription via `build.rs` consuming the JSON dump. | Add a `build.rs` to `holtburger-common` reading the JSON, gap-fill the 18 missing enums identified in the reading guide. |
| Chorizite.ACProtocol | Tier 4 (opcode parity) | **WB.Terminal** can validate via NuGet pack/unpack as oracle for Rust pack/unpack tests | Add `chorizite-pack-message` / `chorizite-unpack-message` commands. Use as goldens in `holtburger-protocol/tests/`. |
| DatReaderWriter | Tier 4 | Already in WB.Terminal via NuGet. Parser parity already validated. | None. |
| DatReaderWriter.Extensions | Tier 4 | **WB.Terminal** has it as ProjectReference. AC string hash NOW available in WB.Terminal. Rust port still needed for runtime (`holtburger-dat::utils`). | `chorizite-hash-string` exposed; port to Rust as small follow-on (~30 LOC). |
| Chorizite (core) | Tier 5 (inspiration) | Unchanged — informs our plugin model design, no execution involvement | N/A. |
| RmlUiPlugin | Tier 5 (VDom inspiration) | Unchanged — "maybe later" per its reading guide | N/A. |

### 12.4 New commands to add to WB.Terminal (planned, not in this PR)

Following the §12.2 pattern, the next round of WB.Terminal absorption candidates:

| Command | Source | Purpose |
|---|---|---|
| `chorizite-pack-message <typename> <fields>` | Chorizite.ACProtocol | Validate our `holtburger-protocol` pack output |
| `chorizite-unpack-message <bytes>` | Chorizite.ACProtocol | Same, reverse direction |
| `chorizite-list-motion-table-swings <mtableId>` | Chorizite.DatReaderWriter | Replaces our Rust `motion_table_inspect.rs` probe |
| `chorizite-walk-anim-hooks <animId>` | Chorizite.DatReaderWriter | Decode anim hooks (sound/particle triggers) |
| `chorizite-dump-spell-table` | Chorizite.DatReaderWriter | Emit spell catalog JSON for holtburger-web spellbook plugin |
| `chorizite-dump-spell-component-table` | Chorizite.DatReaderWriter | Emit component catalog JSON |
| `chorizite-dump-skill-table` | Chorizite.DatReaderWriter | Emit skill catalog JSON |

Each is ~30-50 LOC of C# in `CommandEngine.Chorizite.cs` + a dispatcher entry. They're additive — implement when a feature needs them.

### 12.5 Coverage honesty (revised)

§10's "what this plan does NOT cover" list still stands. Additions:
- The current WB.Terminal absorption only adds `Chorizite.Common` as a ProjectReference. `Chorizite.ACProtocol` and `ACPlugin` are vendored at `external/chorizite/` but NOT yet referenced from WB.Terminal (their dep graphs include RmlUi.Net + Lua + Autofac which would bloat WB.Terminal). When a `chorizite-pack-message` command is needed, the right move is a sub-project that takes a slim subset of ACProtocol, not pulling in the full ACPlugin.
- The browser-side skeleton consumes JSON data files generated by WB.Terminal; the JSON is **committed into the repo**. If WB.Terminal's chorizite refs version-bump, the JSON needs regeneration. A `make` target or CI hook to regenerate-and-diff is a future improvement.

---

## 13. Browser skeleton: `plugins/world-objects/` (added rev 3, 2026-05-19)

### 13.1 What landed

Per §12's split: the browser side gets the *shape* (typed-class hierarchy + accessor pattern), not the *implementation*. Sitting at `apps/holtburger-web/plugins/world-objects/`:

| File | Purpose |
|---|---|
| `README.md` | Self-contained context, regen recipe, wire-in instructions for follow-on PR. |
| `taxonomy.js` | Loads `data/chorizite/world-object-taxonomy.json`. Exposes `inheritanceChain`, `allDescendantsOf`, etc. |
| `enums.js` | Loads `data/chorizite/chorizite-common-enums.json`. Exposes `nameOf(enum, value)`, `valueOf(enum, name)`, `flagsOf(enum, mask)`. |
| `world_object.js` | Base class with 8 typed-property dicts (Int/Int64/Bool/Float/String/Instance/Data/Position) per `ACPlugin/API/WorldObject.cs`. |
| `get_object_class.js` | Port of `WorldObject.GetObjectClass` dispatch. **Fixes the Lifestone-missing bug** the reading guide identified. |
| `world_object_manager.js` | Owns `Map<guid, WorldObject>`. Dispatches via `resolveClassName` → typed constructor. Event-emits `created` / `deleted`. |
| `armor.js`, `bindstone.js`, `character.js`, `clothing.js`, `container.js`, `corpse.js`, `creature.js`, `door.js`, `equippable.js`, `foci.js`, `food.js`, `gem.js`, `item.js`, `jewelry.js`, `key.js`, `lifestone.js`, `mana_stone.js`, `melee_weapon.js`, `missile_weapon.js`, `monster.js`, `npc.js`, `player.js`, `portal.js`, `scroll.js`, `spell_component.js`, `static.js`, `trade_note.js`, `ust.js`, `vendor.js`, `wand.js` | 30 stub subclasses. Each is a 4-line `extends`. Behaviors get added incrementally in follow-on PRs. |

**Total:** ~700 LOC of JS + 30 stub files + 2 JSON data files.

### 13.2 Integration smoke test results

Test driver (in `node --experimental-vm-modules`) loaded the taxonomy + enums, drove 16 synthetic `ObjectCreated` events through `WorldObjectManager.onObjectCreated`, asserted on the returned constructor identity:

- **15 of 16 dispatches correct** (Vendor, NPC, Door, Lifestone, Portal, Bindstone, MeleeWeapon, MissileWeapon, Armor, Clothing, Jewelry, Food, Gem, Key, generic WorldObject).
- The 16th (Scroll) revealed that `ItemType.Writable` alone isn't enough — ACE wire data also sends `ObjectClass.Scroll` to disambiguate Scrolls from Journals/Books. The dispatch correctly returned `Item` (generic) given ItemType-only, and correctly returned `Scroll` when `ObjectClass.Scroll` was set. Test expectation was wrong; dispatch is correct.
- `byClass('Creature')` returns `[Vendor, NPC]` (transitive descendants) — the typed-class taxonomy works for filtering.
- `byClass('Equippable')` returns `[MeleeWeapon, MissileWeapon, Armor, Clothing, Jewelry]` — correct subclass tree.

One bug found and fixed during the smoke test: `WorldObjectManager.onObjectCreated` was resolving `objectClass=0` to `'Unknown'` (which is a known enum member at value 0), short-circuiting before the ItemType fallback. Fix: only resolve objectClassName when the value is truthy. See `world_object_manager.js:71-74`.

### 13.3 Not yet wired — explicit follow-on

The skeleton is standalone. It does NOT yet connect to `plugins/api.js` event stream. Wiring follow-on:

```js
import { WorldObjectManager } from "./world-objects/world_object_manager.js";

const wom = new WorldObjectManager();
await wom.load("./data/chorizite/world-object-taxonomy.json",
               "./data/chorizite/chorizite-common-enums.json");

const client = createClient(sessionHandle);
client.events.on("kind:10", (e) => wom.onObjectCreated(e.detail));     // ObjectCreated
client.events.on("kind:?",  (e) => wom.onObjectDeleted(e.detail));     // need kind for delete
// + property-update wiring per §3.4 event taxonomy
```

Acceptance test for the wiring PR: log in, walk to a vendor in Holtburg academy, `console.log(wom.get(vendorGuid).constructor.name)` should print `"Vendor"` (not `"WorldObject"`).

---

## 14. Vendor UI (shipped 2026-05-19 — commits e86f23d + 6eeaf8c)

### 14.1 What landed

PR-4 of §8 ("Vendor UI") jumped the queue ahead of the typed-class wiring follow-on (§13.3) — usefulness-first. The shipped plugin uses `kind=12 VendorOpened` and the `VendorStateJs` wasm cache directly. When the WorldObjectManager wiring lands, `wom.get(vendorGuid)` will be a `Vendor` instance and the existing UI keeps working unchanged.

**Commit e86f23d (v0.1.0) — vendor state cache + read-only panel**
- Wasm: `VendorState { vendorGuid, vendorName, buyMultiplier, sellMultiplier, alternateCurrency*, items: Vec<VendorItem> }` populated by the `ApproachVendor` recv arm. Stored in `latest_vendor_state: Rc<RefCell<HashMap<u32, VendorState>>>` threaded through the recv loop.
- `SessionHandle.getVendorState(vendor_guid) -> VendorStateJs` getter (per-access clone).
- `VendorItemJs` exposes `{ itemGuid, wcid, name, value, stackSize, itemType, iconId }`.
- `plugins/vendor-ui.js` listens for `vendorOpened` / `kind:12` / `VendorOpened` on the plugin event bus, fetches via `handle.getVendorState`, renders a read-only `hb-panel`.

**Commit 6eeaf8c (v0.2.0) — buy + sell + icons + AC-aesthetic**
- **Icons** — `window.__hbWasm.fetch_surface_pixels(iconId)` exposes the existing surface decoder (DAT type 0x06 = RenderSurface). Plugin renders each `iconId` to a 32×32 `<img>` via offscreen canvas; `itemType→emoji` fallback for `iconId=0` or fetch failure. Cache keyed by `iconId`.
- **Buy** — `SessionHandle.buyFromVendor(vendor_guid, item_wcid, amount)` → `SessionCommand::BuyFromVendor` → `GameAction::Buy` (opcode 0x005F) with single `ItemProfileActionData { amount, object_guid: Guid(wcid) }`. Click a row to buy `currentQty` (toolbar input default 1). Shift-click buys `item.stackSize`.
- **Sell** — `SessionHandle.sellToVendor(vendor_guid, item_guid, amount)` → `GameAction::Sell` (opcode 0x0060). Inventory `<li>` nodes get `draggable="true"` (equipped items excluded; ACE rejects sells of equipped items). `dragstart` writes `text/x-hb-item-guid` to the dataTransfer. Vendor panel accepts drops on a styled "Drop inventory items here to sell" zone.
- **Visual polish** — dark parchment gradient + #8a7544 gold accent border, brass-gradient header, slide-in animation, two-line item rows (name + itemType label), pixelated icon rendering, Toast notifications (success-green + error-red), Escape to close.

### 14.2 Wire-layer reuse

All of the protocol primitives already existed in `crates/holtburger-protocol/src/messages/trade/actions.rs`:

```rust
pub struct ItemProfileActionData { pub amount: i32, pub object_guid: Guid }
pub struct BuyActionData  { pub vendor_guid: Guid, pub items: Vec<ItemProfileActionData> }
pub struct SellActionData { pub vendor_guid: Guid, pub items: Vec<ItemProfileActionData> }
```

…and `crates/holtburger-core/src/client/commands.rs` already had `ClientCommand::Buy` / `::Sell` arms wired through `send_game_action(GameAction::Buy(...))` with `BusyOperationKind::Buy/Sell` throttling. The wasm side just needed the SessionCommand → GameAction bridge (lib.rs:17805–17889).

The `object_guid` field semantics differ by direction: **Buy** carries the vendor item's **wcid** (ACE looks it up against the vendor's stock list); **Sell** carries the player's **item GUID**. Documented in the `SessionCommand` doc comments.

### 14.3 Debug helper

`window.__vendorUiDebug()` pops the panel with a 7-item synthetic stock + 1.55/0.9 multipliers — useful for CSS tweaking without a live ACE. Pass a state object to override.

### 14.4 Follow-ons

- **Inventory-icon parity** — apply the same `iconId → <img>` rendering to inventory `<li>` rows so equipped/pack items look consistent with the vendor window. Same `fetchIconDataUrl` helper is reusable.
- **Multi-select buy** — `BuyActionData.items: Vec<...>` already supports N-at-a-time; the wasm export currently sends a single-item vec. UI would need shift+click multi-select then a "Buy selected" button.
- **Stack split on sell** — drop a stack item → prompt for sell quantity rather than selling the whole stack. ACE handles split server-side if the wire carries `amount < stackSize`.
- **Close-vendor wire** — ACE's `Item_StopViewingObjectContents` (no opcode in our protocol crate yet) when the panel closes. Currently a client-only hide; revisits will re-pop.

---

*End of plan. Last updated 2026-05-19 (revision 4: vendor-ui v0.2.0 shipped — §14. Owner: open. Status: PRs 1+4 shipped; ready for PR 2 (WorldObjectManager wiring into api.js event stream) and PR 5+ (buff/debuff HUD).*
