# Chorizite READING_GUIDE consolidation — 2026-05-27

**Wave A deliverable** per [`chorizite-absorption-plan-2026-05-27.md`](chorizite-absorption-plan-2026-05-27.md) §Wave A.

**Sources consolidated** (all under `external/chorizite/<repo>/READING_GUIDE.md`):

| Repo | Tier | LoC | One-line |
|---|---|---|---|
| `Chorizite.ACProtocol` | 4 — wire parity | 263 | XML-driven C# generator emitting 600+ message classes from `protocol.xml` (8,562 lines, all timestamped 2017-09-13 by zegeger). |
| `ACPlugin` | 1 — direct port target | 240 | The high-level `Game → World → WorldObject` API our `plugins/api.js` mirrors. 63 .cs / 4,808 LOC; ~3,400 in scope. |
| `Chorizite.Common` | 4 — enum parity | 203 | 63 game-data enum files + 2 tiny event utilities. The C# analog of `holtburger-common`. |
| `ACBindings` | 3 — symbol navigator (NOT portable) | 235 | 1,838 .cs Hex-Rays-narrated structs over retail `acclient.exe`; offsets are hardcoded VA's. Use as table of contents over `~/ac-headers/acclient.c`. |
| `Chorizite` | 5 — host architecture | 214 | Plugin host that injects into `acclient.exe`. Inspiration for our manifest schema + lifecycle hooks. |
| `RmlUiPlugin` | 5 — VDom inspiration (skip) | 200 | MobX-style VDom layer on top of RmlUi. Porting plan §9 #10: "don't introduce a VDom because Chorizite has one." |
| `DatReaderWriter.Extensions` | 4 — DAT-author helpers (mostly skip) | 163 | Write-side conveniences. Only the AC string-hash + the 46 well-known DAT IDs are worth porting. |

**Exit gate (per Wave A spec):** subsequent waves reference this doc instead of grep-spelunking the 7 READING_GUIDEs from scratch.

**Scope:** I quote the load-bearing findings verbatim; I do NOT re-validate them. Future agents must trust-but-verify before acting (especially the §3 gotchas and §2 upstream bugs — the READING_GUIDE authors' own coverage honesty sections note where claims are inferred vs. read).

---

## TL;DR for 3D-render improvement (the actual user goal)

The most 3D-relevant absorbed findings, ranked by impact:

1. **40 distinct new `ClientEvent` kinds** would bring `poll_events()` to S2C parity — 12 high-priority (enchantments, fellowship, assess result, target health, confirmation request). See §1 row "Wave E" + §5.1 §6.2.
2. **`WorldObject.GetObjectClass` + `UpdateWeenieDesc` byte-for-byte port** lands the typed entity layer the renderer needs to drive nameplates, selection rings, and material-specific shading. See §1 row "ACPlugin PR 1".
3. **5 missing enums (`ObjectClass`, `SpellType`, `SpellFlags`, `SpellComponentType`, `SpellBookFilterOptions`)** unblock typed wasm exports — currently we export `u32` for object class everywhere. See §1 row "Wave B".
4. **Skill/Vital/Attribute math port** lets the HUD compute exact display values (currently approximated) — directly fixes vitals-bar drift, manacost preview, charge-attack power scaling. See §1 row "Wave C".
5. **6 new DAT type readers** (`CSpellBase`, `CEnchantmentRegistry`, `CAllegianceProfile`, `VendorProfile`, `CContractTracker`, `CEmoteTable`) replace JSON catalogs with byte-correct retail data. See §1 row "Wave F".

Items 1, 2, 3 directly improve the renderer (entity dispatch, nameplate accuracy, material-specific behavior). Items 4, 5 fix HUD-side approximation.

---

## 1. PR sketch index

Every concrete PR sketch the 7 guides provide, in execution order.

| # | Source | Section | Title | LOC | Depends on |
|---|---|---|---|---|---|
| 1 | ACPlugin | §9 | Port ACPlugin event taxonomy + `WorldObject` base class into `plugins/api.js` | ~450 new + ~50 modified | — |
| 2 | Chorizite.Common | §5 | Gap-fill 5 missing enums in `holtburger-common`: `SpellBookFilterOptions`, `SpellComponentType`, `SpellFlags`, `SpellType`, `ObjectClass`, `WieldType` | ~250 Rust | — |
| 3 | DatReaderWriter.Extensions | §6 | Add AC string-hash + 46 well-known DAT ID constants to `holtburger-dat` | ~150 + tests | — |
| 4 | ACPlugin (implied) | §6 row | Port `World.cs` 40-handler S2C dispatch table | ~500 JS | PR 1 |
| 5 | ACPlugin (implied) | §6 row | Port 24-subclass `WorldObject` hierarchy | ~200 JS | PR 1 |
| 6 | ACPlugin (implied) | §6 row | Port `Character.cs` enchantment manager + skill/vital math (Wave C target) | ~500 JS + ~440 Rust | PRs 1–2 |
| 7 | Chorizite.ACProtocol | §7 | `build.rs` parsing `protocol.xml` → tier-1 generated readers (deferred to post-Combat-Phase-J) | ~300 build.rs | — |
| 8 | Chorizite | §4.1 | JS-plugin manifest schema (`id/name/version/dependencies/environments/entry/slots/hotkeys`) | ~200 + JSON Schema | — |
| 9 | Chorizite | §5 (six items) | Steal: dep resolver with `?` optional suffix; `Validate(out errors)` non-throwing; 5-stage lifecycle hooks; `manifest.dev.json` sidecar; `Eat()` semantics on input events | ~100 each | PR 8 |
| 10 | ACBindings | §4 (worked example) | Implement client-side magic enchantment tracking via `ClientMagicSystem` 8-method dispatch | TBD | PR 1 + DAT `CEnchantmentRegistry` (Wave F) |

**PR 1 is the unblocker** for nearly everything downstream. Start there.

**Shipped status (as of 2026-05-27):**

- **PR 1 — DONE.** `world_object.js` rewritten (159 → 601 LOC) with full 8-typed-dict property store + `objectClass` lazy getter + `updateObjDesc`/`updatePhysicsDesc`/`updateWeenieDesc` (the 35-flag WeenieHeaderFlag unpacker). 11 `*EventArgs` factories + `ClientState` (8 variants) + `AddRemoveEventType` added to `plugins/api.js` (261 → 482 LoC). Event-coverage matrix shipped at `docs/acplugin-event-coverage-2026-05-27.md` (5 Y / 32 Partial / 45 N across 82 handler subscriptions). 80/80 new tests pass in `tests/world_object.test.cjs`; baseline regression checks (24+36) still green. **Skeleton bug fixed:** `canonical_classify.js` had `WHF_SPELL = 0x00100000` (the actual `RadarBlipColor` bit); correct value is `0x00400000` per `Chorizite.Common/Enums/WeenieHeaderFlag.cs:31` + our own `holtburger-common::properties::object`. This had been silently misclassifying scrolls as anything-with-RadarBlipColor. Regression test added.
- **PR 2 — DONE.** `plugins/world-state.js` (862 LoC, NEW) ports the `World.cs` 40-handler dispatch table: `weenies: Map<uint32, WorldObject>`, `get`/`exists`/`count`/`all`/`byClass`, 11 dispatcher methods, extends `EventTarget` and emits 9 bus events. **Container-open child-wait race FIXED** (handoff §3 was real — pre-PR-2 fired `containerOpened` immediately on kind=21 with no child-arrival check). `bindWorldStateToClient(world, client)` exposes it as `client.world`. 2 new wasm kinds (`kind=31` `containerClosed`, `kind=32` `objectAppraised`) in `apps/holtburger-web/src/lib.rs` (+66) reusing existing `CloseGroundContainer`/`IdentifyObjectResponse` parsers. 10 handlers promoted to Y including the full 8-handler `Magic_*Enchantment*` cluster (via JS-side delta diff over PR 1's enchantment snapshot — no new wasm parsers needed because Wave C.2's `PlayerEnchantmentsUpdated` already lands the snapshot as kind=8 payload). Matrix doc: 5 Y / 32 Partial / 45 N → **14 Y / 26 Partial / 42 N**. 38/38 new tests pass; all baselines green (80 + 36 + 24 in JS; 286 protocol + 57 web in Rust); `cargo check --target wasm32-unknown-unknown --lib` PASS; `validate_wire_conformance.cjs` 31/31 PASS (no new fixtures — kind=31/32 reuse).
- **PR 3 — partly pending.** Existing 31-subclass skeleton already inherits the new base correctly (per memory `project_chorizite_porting_plan_2026-05-19.md` + PR 1 verification). Equippable `SetWielded` helper + Container `Items`/`Containers` read-through getters wire to `client.world.weenies` (PR 2 unblocked) — small.
- **PR 4 — pending.** `Character.cs` JS-side bridge: route the 24 `PrivateUpdate*` handlers through PR 2's `dispatchItemCreateObject`-spawned `Character` instance into Wave C.2 wasm math. Wave E target opcodes documented in updated matrix doc.

---

## 2. Upstream bugs flagged by the Chorizite team

For Wave C and beyond — must work around these when porting.

| # | Bug | Source | Workaround |
|---|---|---|---|
| 1 | **`SkillFormula.HasAttribute2`** is inverted: `public bool HasAttribute2 => Attribute2 == 0;` — opposite of what the name implies. | ACPlugin §8, `SkillFormula.cs:41` | **Don't port `HasAttribute2`.** Callers check `Attribute2 != 0` directly at `SkillInfo.cs:87, 119` and `VitalInfo.cs:76, 102` — they work because the bug is masked. File upstream PR. |
| 2 | **`World.CreateWorldObject` switch missing the Lifestone case.** `GetObjectClass` sets `ObjectClass.Lifestone` (`WorldObject.cs:379`) but the switch at `World.cs:622-706` has no case for it — falls to default, becomes `new Item()` or `new Static()`. | ACPlugin §8 | Add the explicit case when porting. *(ACPlugin guide §8 marks this as "based on grepping ... not run-validated" — verify before committing the workaround.)* |
| 3 | **`Chorizite.Common.DamageType` truncated at `Electric = 0x40`.** ACE and `holtburger-common` go further (`HEALTH=0x80`, `STAMINA=0x100`, `MANA=0x200`, `NETHER=0x400`, `BASE=0x10000000`, plus composites). | Chorizite.Common §5 | **We are correct, Chorizite is wrong.** Do NOT downgrade `holtburger-common::DamageType` to match. |
| 4 | **`DDD_EndDDDMessage 0xF7EB` is missing entirely** from holtburger top-level C2S enum (only 1 message — the rest of the 13-gap list is a mix of S2C gaps + commented-out skips). | Chorizite.ACProtocol §5.1 | Add to enum even if we never wire DDD (DAT-DL is "skip" per absorption plan §What NOT to port). |
| 5 | **`Actions.cs` is misleadingly named** — porting plan §3.2 row claims "C2S action dispatch surface (login/attack/cast/equip/drop/jump)". Real file has ONLY `SelectObject`/`SelectObjectId`. The full C2S surface lives elsewhere (mostly inline in `Game.cs:Login`). | ACPlugin §8 | Treat the porting-plan row as a no-op; our existing wasm methods are already richer. |
| 6 | **`Hash32 ≠ string_hash`.** The porting plan's hand-wave that `holtburger_protocol::crypto::Hash32` covers the AC string-key hash is wrong. They are entirely different algorithms (Hash32 = packet checksum; string_hash = StringTable 28-bit folding hash). | DatReaderWriter.Extensions §5 | Port the string-hash algorithm separately as a new function. See PR sketch #3. |
| 7 | **ACBindings XML doc-comments are LLM-narrated from IDA decomp** — ~90% accurate at one-line-summary but routinely omit numeric constants (thresholds/clamps/defaults), mutation/notification ordering, edge-case branches, cross-class side effects. | ACBindings §5 #2 | Use doc-comments for triage; use `~/ac-headers/acclient.c` as the spec. |
| 8 | **ACBindings struct member layouts** are NOT always bit-for-bit accurate — alignment/padding/unions not always represented. | ACBindings §5 #3 | For DBObj wire work the authoritative source is `acclient.c::<Type>::UnPack` + `external/DatReaderWriter/.../dats.xml`, not C# field order alone. |
| 9 | **`SpellComponentType` duplicate discriminants** are inconsistent: `Talisman=5u` / `TalismanPea=5u` (intentional alias OK), but `Taper=6u` while `TaperPea=7u` (NOT aliased), and `Potion=4u` while `PotionPea=7u` (aliases Taper, NOT Potion). Almost certainly a Chorizite copy-paste bug — `PotionPea` should logically be `4u` and `TaperPea` should logically be `6u`. **Discovered during Wave B port 2026-05-27.** | `Chorizite.Common/Enums/SpellComponentType.cs` | Don't trust Chorizite's `*Pea` aliases. We preserved verbatim with an inline flag-comment in `crates/holtburger-common/src/properties/combat.rs`; file upstream PR if/when convenient. |

---

## 3. Load-bearing integration gotchas (don't refactor these)

Counter-intuitive semantics that bite. Quoted verbatim from each guide.

### From ACPlugin §8

> **Container-open dispatch waits for children** (`World.cs:212-249`). Don't fire `containerOpened` until all `Item_CreateObject` for the listed children have arrived, otherwise vendor/chest UIs see empty contents. Our current `plugins/api.js` does NOT do this — known race. Fix is part of PR 2.

> **`PrivateUpdate*` vs `Update*` qualities events** (`Character.cs:191-213` vs `World.cs:109-131`). Public = broadcast; private = only sent to the object's owner. ACPlugin wires them to different objects (World vs Character). Both handlers do `AddOrUpdateValue`, but the **subscription target matters** for wasm-side gating. Don't merge.

> **`ApplyEnchantment` routes by `EnchantmentTypeFlags.Cooldown`** (`Character.cs:619`). One wire packet carries both enchantments AND cooldowns; discriminator is `StatMod.Type & EnchantmentTypeFlags.Cooldown`. If we route cooldowns differently we'll miss server-initiated item cooldowns.

> **`Vitae`: 1.0 = no vitae, 0.95 = 5% vitae** (`Character.cs:80, 138`). Counter-intuitive. `SkillInfo.cs:138-140` multiplies by it. Don't invert.

> **`SharedCooldown.Id = (layeredId.Id << 20 >> 20)`** (`SharedCooldown.cs:55`) sign-extends low 12 bits. Port exactly.

> **`UpdateVital` even/odd parity** (`Character.cs:721`): vitals come as (current, max) at adjacent IDs. Even = current, odd = max. The `(int)key % 2 == 0` check is load-bearing. Don't refactor.

> **Enchantment tiebreak** (`Character.cs:232-239`): `Power desc → Level8AuraSelfSpells → SetSpells ? SpellId : StartTime → .First()`. The AC enchantment-manager bug-fix lives here only.

> **`Foci : Container`** (`Foci.cs:8`), surprising but correct. **Door, Portal, Lifestone, Bindstone, Corpse all extend `Static`, not `Item`** (`Door.cs:12`, `Portal.cs:8`, etc.) — they have NO inventory/burden/stack semantics. **Character + Creature extend Container.** Don't put statics under `items/`.

### From DatReaderWriter.Extensions §5

> Two subtleties to capture in tests: (1) `foreach (sbyte c in str)` reinterprets each byte as **signed** — non-ASCII (≥ 0x80) contribute negative values to the shift; silent cross-language bug source. (2) The masking is `0x0FFFFFFF` (28 bits), so the result never has top 4 bits set.

### From Chorizite §3.3

> The event-args classes (`MouseDownEventArgs.cs:8` etc.) all derive from `EatableEventArgs` — handlers can call `Eat()` to consume the event and stop propagation. That last detail is important and we don't have it.

### From Chorizite.ACProtocol §4

> **Could we port the codegen pattern to a Rust proc-macro?** Not directly — T4 has access to MSBuild paths via `Host.ResolvePath`, but a Rust proc-macro can't easily reference workspace files at compile time without a `build.rs`. The right shape would be a `build.rs` that calls `quote!` after parsing `protocol.xml` with `roxmltree` or `serde_xml`.

### From Chorizite.Common §6

> **Naming convention check** for future PRs: Chorizite uses identifier suffix `Id` for primary key enums (`AttributeId`, `SkillId`, `VitalId`); our crate uses `Type` (`AttributeType`, `SkillType`, `VitalType`). Decision: **keep our `Type` convention** — it matches existing call-sites in `holtburger-core`, `holtburger-world`, and the spell/combat plugins, and renaming would break Vibe.fyi APIs.

### From ACBindings §5 (anti-patterns, condensed)

1. Do NOT port the offset constants — every `0x00XXXXXX` literal is a VA in retail `acclient.exe`.
2. Do NOT trust XML doc-comments as spec — see §2 row 7.
3. Do NOT assume struct member layouts are bit-for-bit accurate — see §2 row 8.
4. Do NOT use ACBindings without `acclient.c` (memory `reference_ac_re_artifacts`).
5. Do NOT port `Generated/UI/` — 1998-era retained-mode; no DOM/Three.js analogue.
6. Do NOT port `Net/Crypto/` — retail 3DES + Turbine CryptoHash; our `holtburger-protocol::crypto` is correct against ACE; drift breaks handshake.
7. Do NOT port `Dats/Disk/` or `Dats/Transactions/` — read-only base DATs (memory `feedback_base_dats_only_for_bake`).
8. Do NOT extend `ACBindings/` itself — read-only vendor.
9. **Anonymous `_<HEX_GUID>.cs` files** at `Generated/` root are IDA unresolved typedefs — noise, skip them.

### From RmlUiPlugin §5

> Per the porting plan §9 item 10: *"Don't introduce a virtual-DOM library 'because Chorizite uses one.' Their VDOM is a workaround for RmlUi not having React; we don't have that constraint."* That guidance is correct and load-bearing.

---

## 4. Wave-by-wave handoff (A → G)

Maps the [absorption plan](chorizite-absorption-plan-2026-05-27.md) waves to the specific READING_GUIDE sections future agents should open first.

### Wave A — DONE (this doc)

Exit gate met. Future-agent first action when picking up B-G: open this doc, then drill into the per-guide section cited below.

### Wave B — Missing enums — **DONE 2026-05-27**

**Status:** shipped. 6 enums ported (`ObjectClass`, `SpellType`, `SpellFlags`, `SpellComponentType`, `SpellBookFilterOptions`, `WieldType`); 40 tests pass in `cargo test -p holtburger-common --lib` (34 baseline + 6 new). Files: `crates/holtburger-common/src/properties/{object,inventory,combat}.rs` + re-exports in `properties.rs`. Wave B surfaced one upstream Chorizite bug — see §2 row 9 (SpellComponentType discriminants).

**Required reading (if re-validating):** `Chorizite.Common/READING_GUIDE.md` §3 (parity matrix) + §5 (first PR sketch with the 5-enum gap fill) + §6 (C# → Rust idiom mapping table).

**Key facts:**
- 63 enum files in `Chorizite.Common/Enums/`. `OK`=25, `OK*`=4 (renamed: AttributeId→AttributeType, CurVitalId→VitalType, SkillId→SkillType, VitalId→VitalType), `OK-ext`=8 (in workspace but outside `-common`), `MISSING`=18 workspace-wide.
- The 5 enums ported first: `ObjectClass` (PR 1 needs this), `SpellType`, `SpellFlags`, `SpellComponentType`, `SpellBookFilterOptions`, plus `WieldType` (17 lines, free — used `repr(u8)` because C# is `: byte`).
- Pre-flagged value-parity verifications: `AttackType` 15/15, `DamageType` (we're a superset — see §2 row 3), `EnchantmentTypeFlags` 19/19, `ImbuedEffectType` 18/18, `SkillId↔SkillType` 54/54.

### Wave C — Character / Skill / Vital / Attribute math — **DONE 2026-05-27 (Partial — Character core only)**

**Status:** Rust math layer shipped at `crates/holtburger-core/src/client/{attribute_info,vital_info,skill_formula,skill_info,character_info}.rs` (3,328 LOC total + `mod.rs` 5-line edit). `cargo test -p holtburger-core --lib` independently re-run: **248 passed / 0 failed** (80 new tests in the five new modules, including a 1000-state random-input parity probe for `AttributeInfo::current`). Workspace `cargo build --workspace --lib` PASS. All 8 handoff §3 gotchas spot-checked in the ported code (Vitae 1.0=none documented in 5 places; HasAttribute2 intentionally omitted with module docs; UpdateVital even/odd parity preserved; SharedCooldown sign-extend ported with operand-type explanation).

**Per-file LOC:**
- `attribute_info.rs` — 172 LOC (foundational)
- `skill_formula.rs` — 144 LOC (`HasAttribute2` omitted)
- `vital_info.rs` — 535 LOC
- `skill_info.rs` — 937 LOC
- `character_info.rs` — 1,540 LOC (Partial — see Wave C.2 below)

**Wave C.2 status (shipped 2026-05-27):** 15 wasm-bindgen exports in `apps/holtburger-web/src/lib.rs` make the Wave C math callable from JS. 13 free functions (compute{Attribute,Vital,Skill}{Current,Base,Max}, skillCategory, skillIsAlwaysTrained, skillRequiresAugToSpecialize, spellSetCutoff, level8AuraSelfSpells, vitaeSpellId, skillFormulaHasAttribute2) at `lib.rs:15747-16525`; 2 SessionHandle DAT methods (`spellSetIds()` reads `WorldBootstrap.spell_table.spell_sets` filtered by cutoff; `skillMinLevel(skill_type)` reads `WorldBootstrap.skill_table.skill_base_hash[type].min_level`) at `lib.rs:18181, 18220`. `wasm-pack build` PASS. 12 new native parity tests (holtburger-web 45 → 57). `cargo test -p holtburger-core --lib`: 248 passed (Wave C baseline preserved); `cargo test -p holtburger-web --lib`: 57 passed.

**Wave C.2 deferred candidates:**
1. **40+ S2C event-handler dispatch table** in `Character.cs:182-222, 376-610` + matching `Dispose` unsubscribe at `:785-827` — **DEFERRED**. PR 2 territory (JS-side `World.cs` dispatcher); blocked on PR 1 (WorldObject base class). Wave C's mutators (`update_attribute`, `apply_enchantment`, etc.) are public and ready for the dispatcher.
2. **`SetWielded` helper** at `Character.cs:757-762` — **DEFERRED**. Explicitly requires the WorldObject hierarchy from PR 1.
3. **`Math.Round` divergence** — documented inside `attribute_info.rs`; no HUD drift observed yet.
4. **`FlatContext` adapter** (mirror of test `MockChar`) — currently inline in `lib.rs`; promote to a public `ScalarCharacterContext` in `holtburger-core` if multiple wasm consumers spring up (Wave C.3 candidate).

**New finding (open question — added to §7):** `SetSpells` tiebreak at `Character.cs:237` has a LINQ projection that mixes `uint` and `double` into `Comparer<object>.Default` — at C# runtime the comparer throws if types differ, but in practice categories don't mix set-vs-non-set spells. Agent segregated into "set-spells beat non-set; within set sort by SpellId desc; within non-set sort by StartTime desc". Cross-ref against ACE `EnchantmentManager.Run()` recommended before shipping the wasm bridge.

**Required reading (if re-validating):** `ACPlugin/READING_GUIDE.md` §3 (read these 6 files first) + §4 (public surface table) + §5 (internal patterns including the 6 load-bearing semantics in §3 above) + §6 (port plan with file:line confidence).

### Wave D.1 — gmInventoryUI completeness — **DONE 2026-05-27**

**Status:** audit shipped at `docs/wave-d1-inventory-audit-2026-05-27.md` (259 lines). Scope expanded as a load-bearing finding: `gmInventoryUI.cs` itself declares only 4 fields (the panel composes 3 sub-classes). Union scope = 45 `UIElement_*` fields across `gmInventoryUI` (4) + `gmPaperDollUI` (35) + `gmBackpackUI` (4) + `gm3DItemsUI` (2). Counts: **28 Y / 8 N / 9 Partial = 17 follow-up issues** (matches the plan's 5-15 estimate).

**Top follow-up issues (high impact, full list in the audit doc §3):**
1. `m_SlotCheckbox` missing — **SHIPPED 2026-05-27** as Wave D.1 follow-on. This IS the absorption-plan's "m_burdenButton" (see correction below). Cross-validated against `acclient.c:221636,221667,221698-221728` — retail element 0x100005BE, default-unchecked, 9-slot toggle block confirmed.
2. `UpdateAetheria` gating — **SHIPPED 2026-05-27** as Wave D.1 follow-on. `refreshAetheriaGating` reads `handle.playerAetheriaBits`, toggles `.aetheria-locked` CSS class per bit.
3. `RecvNotice_NewParentContainer` — **SHIPPED 2026-05-27** as Wave D.1 follow-on. `refreshPanelTitle` swaps `"Inventory of <player>"` ↔ `"Contents of <pack>"` on bag-tab click + every rebuild pass.
4. Numeric burden label (`m_burdenText`) — **SHIPPED 2026-05-27** as Wave D.1 follow-on. `refreshBurdenText` reads `handle.playerBurden`, formats via `formatBurdenText` helper, lives on the inventory panel between paperdoll bottom and items grid.
5. `gm3DItemsUI` floating "Contents of Backpack" pane — **DEFERRED**. Significant separate-window port (~1 day): retail pops a second floating window beside the inventory window with its own 3D viewport, title, item list, drag handlers. Out of scope for the JS-only Wave D.1 follow-on. Would unblock simultaneous view of main inventory + active side pack contents; currently we replace the items grid inline (functionally fine, structurally less surface area).
6. Three explicit S2C inventory events missing (`RecvNotice_ServerSaysMoveItem` 0x004A6BC0, `ShowPendingInPlayer` 0x004A6EC0, `EndPendingInPlayer` 0x004A6E20) — **DEFERRED to Wave E**. Currently we re-snapshot via `kind=11 InventoryUpdated` on every move; these would let us avoid full re-snapshot + enable per-item toast feedback, wield animation triggering, pending overlay during slow connections. Requires wasm-side new `ClientEvent` kinds + protocol handler additions (Chorizite.ACProtocol territory), not just JS+DOM.

**Wave D.1 follow-on shipped 2026-05-27 — items 1-4 status:** all wired in `plugins/inventory.js` (+90 LOC SlotCheckbox button + slots-view CSS), `plugins/inventory_helpers.js` (`parseSlotsViewChecked` joins the existing three pure helpers), and `tests/inventory_paperdoll_helpers.test.cjs` (8 new tests; 36 total pass). Each cite ACBindings file:line + acclient.c spec-grade evidence in inline comments.

**Correction to absorption plan (Wave D.1 finding):** the plan mentions *"`m_burdenButton` (the 'Slots' toggle button we noticed in `User-Interface-10.webp`)"*. The actual ACBindings field is **`m_SlotCheckbox`** and it lives in **`gmPaperDollUI.cs:134`**, NOT in `gmInventoryUI.cs`. The cited screenshot `User-Interface-10.webp` does NOT exist in `external/holtburger/docs/`. The plan's `m_burdenButton` label was a guess from a missing screenshot. Cross-checked against `acclient.c:221636` during the follow-on implementation — the retail element ID is **0x100005BE** (`268436926`), which Wave 12 had originally mistaken for the burden indicator (per inventory.js:37-40 audit comment). Confirms the audit's hypothesis: this is a toggle button on the paperdoll, defaults unchecked (paperdoll shown), and when checked hides 9 paperdoll body elements (`acclient.c:221700-221728`).

**Required reading (if re-validating):** `ACBindings/READING_GUIDE.md` §2 row "Inventory" + §6 row "Inventory" — Wave 12+16 paperdoll work was the precedent.

### Wave D.2 — gmCharacterCreationUI (deferred ~2 days)

**Required reading:** `ACBindings/READING_GUIDE.md` §2 row "CharGen" + §3 row "Char gen".

### Wave E — Wire-format gaps (~3-5 days)

**Required reading:** `Chorizite.ACProtocol/READING_GUIDE.md` §5 (opcode parity matrix) + §6 (S2C handler enumeration → 40-event backlog with high/medium/low priority tables).

**Key facts:**
- 600+ wire messages in Chorizite vs. ~45 in holtburger.
- 13 specific gaps: 12 S2C + 1 C2S (the 1 C2S = `DDD_EndDDDMessage 0xF7EB`, see §2 row 4).
- Top-level S2C: ~55/92 active, ~25 intentional skips, ~12 honest gaps (biggest batch: `Qualities_*Remove*Event` family 0x01D1–0x01DE + 0x02B8/0x02B9).
- GameEvent inner: 99 in Chorizite, ~45 in holtburger. Largest delta. ~40 new `ClientEvent` kinds would bring us to parity; 12 are high visible value.
- **High-priority subset for the renderer** (§5.1 §6.2 table):
  - 0x02C1 `Magic_UpdateSpell` → `SPELL_LEARNED`
  - 0x01A8 `Magic_RemoveSpell` → `SPELL_REMOVED` (we currently only infer from C2S echo)
  - 0x02C2-C8, 0x0312 `Magic_Update/Remove/Dispel/Purge*Enchantment*` (8 handlers) → `ENCHANTMENT_*`
  - 0x00C9 `Item_SetAppraiseInfo` → `OBJECT_APPRAISED` (unblocks /assess UI)
  - 0x01C0 `Combat_QueryHealthResponse` → `TARGET_HEALTH_UPDATED` (selection ring shows health)
  - 0x02BE-C0, 0x00A3, 0x00A4 `Fellowship_*` → `FELLOWSHIP_*` (unblocks fellowship HUD)
  - 0x0274 `Character_ConfirmationRequest` → `CONFIRMATION_REQUEST` (needed for delete-confirmation flows)

### Wave F — DAT type readers (~1 week)

**Required reading:** `ACBindings/READING_GUIDE.md` §3 row "DAT readers" + per-type entries in §2 (Dats/DBObjs has 68 files).

**Key facts:**
- 182 wire-protocol structs in `ACBindings/Generated/Net/Types/`; we have ~12 parsers.
- 6 high-priority DAT readers (per absorption plan §Wave F):
  1. `CSpellBase` — full spell record; replaces LSD-derived JSON catalog.
  2. `CEnchantmentRegistry` — runtime buff/debuff registry; unblocks proper buff-bar.
  3. `CAllegianceProfile` + `AllegianceHierarchy` — unblocks F8 allegiance panel.
  4. `VendorProfile` — completes vendor stock display.
  5. `CContractTracker` — unblocks F7 contracts panel.
  6. `CEmoteTable` — broader emote table (Wave 9 used the narrower ChatPoseTable).
- For each: parser in `crates/holtburger-dat/src/file_type/<name>.rs` + parity test against retail portal.dat with `HOLTBURGER_PORTAL_DAT` env.

### Wave G — Optional polish

**Required reading:** `Chorizite.Common/READING_GUIDE.md` §3 (the 13 more enum gaps beyond Wave B's 5) + `Chorizite/READING_GUIDE.md` §5 (the six small ideas to steal).

---

## 5. Per-guide load-bearing findings (verbatim)

The single most important quote (or compact set of quotes) from each guide, with citations.

### 5.1 Chorizite.ACProtocol

**Architecture:** *"Everything in this repository — every enum, every per-opcode message class, every reader/writer/dispatch handler — is generated from one file: `Chorizite.ACProtocol/protocol.xml` (8,562 lines, 526 KB)."* — §1.

**Opcode coverage delta (from §5.4):** *"Chorizite emits all 99 with full `Read()` bodies; we only handle ~45. The gap matters because these are the events that drive UI state."*

**Estimate (from §6.2):** *"Roughly 40 distinct new `ClientEvent` kinds would bring us to S2C parity. About 12 of them (enchantment family, fellowship full update, assess result, query-health response, fellowship updates, confirmation request) deliver high visible value; the rest are nice-to-haves for plugin authors."*

**Port verdict (from §7):** *"We do not port Chorizite.ACProtocol's SourceGen itself."* Reason: WASM-bound Rust client doesn't want a CLR runtime dependency; hand-written `holtburger-protocol/src/messages/*.rs` is already optimized for our use cases. Future move: `build.rs` over `protocol.xml`, deferred to post-Combat-Phase-J.

### 5.2 ACPlugin

**One-line scope:** *"A C# Chorizite plugin (63 .cs files, 4,808 LOC) that wraps the retail acclient.exe network stream into a clean event-driven `Game → World → WorldObject` API with typed subclasses, vital/skill/enchantment math, and shared-cooldown tracking — the canonical north star for our `plugins/api.js` and `holtburger-world` entity layer."* — frontmatter.

**Inheritance (from §4):** *"`WorldObject ← Item ← Container ← Creature ← {NPC, Monster, Player, Vendor}`; `Character : Container`; `{Door, Portal, Lifestone, Bindstone, Corpse, Static} : WorldObject`; `Equippable, Gem, SpellComponent, Ust, Food, Key, ManaStone, Scroll, TradeNote : Item`; `{Armor, Clothing, Jewelry, MeleeWeapon, MissileWeapon, Wand} : Equippable`; `Foci : Container` (surprising)."*

**Read these 6 files first (from §3):**
1. `ACPlugin.cs:23-104` — plugin entry; `Instance`/`Net`/`ClientBackend`/`Dat` ambient singletons referenced everywhere.
2. `API/Game.cs:1-204` — top-level `client.game`; State machine on lines 117-123.
3. `API/World.cs:1-135` — **canonical list of 40+ S2C events** in the ctor handler registrations.
4. `API/WorldObject.cs:42-155, 344-408, 558-678` — 8 property dicts, `GetObjectClass` flag-bit walk, `UpdateWeenieDesc` 100-line WeenieHeaderFlag unpacker.
5. `API/WorldObjects/Character.cs:1-30, 53-110, 230-373, 613-655` — `GetActiveEnchantments` tiebreak, `Vitae` setter, `ApplyEnchantment` cooldown-vs-enchantment split.
6. `API/SkillInfo.cs:80-150` — Base/Current getters. **Algorithm we want byte-for-byte.**

### 5.3 Chorizite.Common

**Counts (from §3):** *"`OK` (in `-common`, name match): 25; `OK*` (in `-common`, renamed): 4; `OK-ext` (in workspace but not `-common`): 8; `MISSING` (workspace-wide, real gap): 18."*

**TL;DR (from end of guide):** *"The big bedrock (`Property*`, `WeenieType`, `AttackType`, `DamageType`, etc.) is present and value-correct in `holtburger-common`. The 18 workspace-wide gaps cluster around: emote/friends-list subsystems (not started), spell metadata (`SpellFlags`/`SpellType`/`SpellCategory` — should live in `-common` but currently scattered), and UI taxonomies (`RootElementId`, `UiEffects` dedicated enum). Pick the spell-metadata cluster + `ObjectClass` + `WieldType` for the first 250-LOC gap-fill PR."*

### 5.4 ACBindings

**One-line (from frontmatter):** *"A C# struct catalog over the retail Hex-Rays decomp at `~/ac-headers/acclient.c` — useful as a table of contents over a 938k-line C file, not as portable code."*

**Why it's NOT directly portable (from §1):** *"`0x0051AEA0` is an offset into the loaded image of retail `acclient.exe`. Outside an injected `acclient.exe`, every method body in this repo is a null deref. Cannot be consumed from Rust + WASM, from a separate process, or anything not running inside the retail client."*

**Usage model (from §1):** *"Use this repo to find the right symbol, then read the algorithm in `acclient.c`. Do not port the offsets."*

**Worked example (from §4):** for client-side magic enchantment tracking — *"`ClientMagicSystem.cs` (267 lines of LLM doc-comments) gave the full enchantment-subsystem entry-point list in 90 seconds. The equivalent 8 functions in `acclient.c` cold would take 30+ minutes of decomp-translation. ACBindings = navigation; `acclient.c` = spec."*

### 5.5 Chorizite

**Execution model (from §1):** *"Chorizite is a generic .NET 8 plugin host with one production binding: inject into retail `acclient.exe`. ... We are the client. We do NOT inject into anything."*

**What's worth stealing (from §5, the 6 items):**
1. Manifest schema (id/name/version/dependencies/environments/entry/description/author/icon). PR 8 above. ~200 LOC.
2. Dependency resolver with `?` optional-suffix syntax. `PluginManager.StartPlugin()` lines 178-245. ~80 LOC.
3. `Validate(out errors)` returning a list, not throwing. ~10 LOC delta. Never let one broken plugin break the rest.
4. 5-stage lifecycle events (`OnBeforeLoad / OnLoad / OnBeforeUnload / OnUnload / OnRequestReload`) + separate `Initialize()` from constructor.
5. `manifest.dev.json` sidecar for source-tree dev loading.
6. `Eat()` semantics on input events (`EatableEventArgs`). ~20 LOC. Lets the combat bar swallow LMB before the pick-target handler sees it.

**Don't model live-reload after theirs (from §7 aside):** *"`UnloadPlugins` calls `GC.Collect()` up to 50 times (line 262-265) because .NET ALC unloading is unreliable. JS modules can't be unloaded in browsers at all — moot for us, but argues 'don't model live-reload after theirs; just do full-page reload'."*

### 5.6 RmlUiPlugin (skip-tier)

**Verdict (from §5):** *"Honest assessment: maybe-later, with a strong default of 'no'. ... Per the porting plan §9 item 10: 'Don't introduce a virtual-DOM library because Chorizite uses one. Their VDOM is a workaround for RmlUi not having React; we don't have that constraint.' That guidance is correct and load-bearing."*

**Threshold heuristic (from §5):** if we ever cross 30+ UI elements OR multiple plugins reading the same state shape, *"consider a signal-style lib (Solid or Preact signals), not a VDom."*

### 5.7 DatReaderWriter.Extensions (mostly skip)

**Verdict counts (from §2):** *"✓ 0  ⚠ 6  ✗ 14. Six items have actionable parity value; the other 14 are write-side or fixture-only."*

**Most-portable item (from §3a):** the AC string-hash. See PR sketch #3. Critical because §2 row 6 confirms `Hash32 ≠ string_hash` — *"the porting plan's hand-wave that 'Hash32 covers it' is wrong."*

---

## 6. Skip list (consolidated across all 7 guides)

Per the absorption plan §What NOT to port + per each guide's own skip section:

- **Chorizite.ACProtocol** — the SourceGen T4/MSBuild pipeline (not the schema itself; we may use the XML as input via `build.rs` later).
- **ACPlugin** — `ACPlugin.cs` screen plumbing, `Lib/DragDropManager.cs`, `Lib/PluginState.cs`, `Lib/JsonSourceGenerationContext.cs`, `Lib/Screens/*` (enum values reusable; rest skip), `assets/{panels,screens}/*.rml`, `panels/indicators.lua`, `AC.csproj/.sln`.
- **Chorizite.Common** — `EatableEventArgs.cs` (port concept ad-hoc per call-site), `WeakEvent.cs` (reference only — useful if we add long-lived subscribers to short-lived UI elements and see leak signal).
- **ACBindings** — see §3 anti-patterns list. Effectively: skip every offset constant + UI framework + Net/Crypto + Dats/Disk + Dats/Transactions. Use ONLY as navigator over `acclient.c`.
- **Chorizite** — `Chorizite.Launcher` (Windows native injection), `Chorizite.NativeClientBootstrapper` (DX9/Win32 hooks + unmanaged pointers), `Chorizite.DocGen.LuaDefs` (Lua-specific), `Chorizite.Core.Lib/{Native,NativeLibraryLoader,SymbolResolver}.cs` (P/Invoke + ClrMD), `Chorizite.Core/Plugins/AssemblyLoader/*` (.NET ALC), `Chorizite.Core/Render/*` (replaced wholesale by Three.js), `Chorizite.Core/Plugins/Models/*` (plugin-index marketplace; we have none).
- **RmlUiPlugin** — the entire VDom + reactive layer (the *idea* survives in §5.5 item 6 + the threshold heuristic in §3). All `Lib/RmlUi/*Interface.cs`, `*Instancer*`, `Lib/Fonts/*`, Lua loaders.
- **DatReaderWriter.Extensions** — `DatEasyWriter`, `Defragment/Compress/CloneEmpty/CopyHeaderFrom`, `AddTitle/UpdateTitle/RemoveTitle` (we don't author DATs), `ReplaceWith/SaveToImageFile` (we don't write textures back), `PFID_CUSTOM_RAW_JPEG` (browser native decoder handles).

---

## 7. Open questions / things to verify before acting

Each READING_GUIDE has a "coverage honesty" section. Pulling the **claims marked uncertain** that future agents must validate before acting:

| Claim | Source guide / section | What to verify |
|---|---|---|
| Lifestone dispatch bug in ACPlugin `World.CreateWorldObject` | ACPlugin §8 + §10 | "based on grepping `World.cs:622-706` for an explicit case and finding none — not run-validated." Re-grep the current file before adding the workaround. |
| `_setSpells` cutoff `>= 4730u` rationale | ACPlugin §10 | Sources to a "from ACE" comment; rationale not traced. |
| `Magic_Dispel*` / `Magic_Purge*` handler wire semantics | ACPlugin §10 | "read but wire semantics not cross-checked against protocol XML." |
| Whether `plugins/api.js` already implements container-open-children-wait | ACPlugin §10 | Assumed not; not grepped. **Likely a Wave B/C pre-flight check.** |
| Whether `holtburger-world::magic::enchantment` has the Level8AuraSelfSpells precedence | ACPlugin §10 | Memory mentions additive/multiplier folding but not the spell-set tiebreak. |
| Exact set of S2C events `poll_events()` surfaces today | ACPlugin §9 first-PR deliverable | This IS the gap-fill backlog input. |
| Whether `Actions.SelectObject` sends a wire packet | ACPlugin §10 | Looks local-only at `Actions.cs:19`; if so, our 3D-picking ring already covers it. |
| `PropertyInt` variant-by-variant value parity (787 lines on Chorizite side) | Chorizite.Common §7 | Highest-value follow-on for a dedicated agent. |
| `Sound`/`PlayScript` variant tables | Chorizite.Common §7 | Presence confirmed; no value diff. Both likely PARTIAL. |
| `Gender`, `HeritageGroup`, `ParentLocation`, `Placement`, `PortalBitmask`, `PlayerKillerStatus`, `SummoningMastery`, `UiEffects` — dedicated Rust enums vs raw `u32` | Chorizite.Common §7 | Referenced in `properties/property_keys/ints.rs`; dedicated enum existence not confirmed. |
| ACBindings "§3 most-important classes" column | ACBindings §8 | Inferred from filenames + a small file sample (~15 of 1,838 files read in full). Quoting *"`ClientFellowshipSystem` has method X"* requires opening the file first. |
| String-hash byte-trace for `"A"`/`"AB"`/`"hello world"` | DatReaderWriter.Extensions §7 | Hand-derived; "re-confirm against a `dotnet script` repro before any port-PR." |
| `RenderSurfaceExtensions.ToRgba8` byte-for-byte parity vs `holtburger-dat/src/file_type/texture.rs` | DatReaderWriter.Extensions §7 | Flagged LSCAPE byte-order and 4-bit-extend as worth a parity pass; pass not done. ~2 hours. |
| `Cortex.Net` semantics deviation from MobX | RmlUiPlugin §8 | If C# port deviates meaningfully, RmlUi guide §3.5 + §4 could be wrong in detail. Low likelihood; no consequence for our porting decision. |
| `Character.cs:237` SetSpells tiebreak — mixed `uint`/`double` LINQ projection | Wave C 2026-05-27 | Agent ported as "set-spells beat non-set; within set sort by SpellId desc; within non-set sort by StartTime desc". Cross-ref against ACE `EnchantmentManager.Run()` BEFORE shipping the wasm bridge — runtime behavior on mixed bags isn't proven against retail capture. |
| C# `Math.Round` vs Rust `f32::round` banker's-rounding divergence on `.5` | Wave C 2026-05-27 | `attribute_info.rs` documents and one test accepts both rounding outcomes. Watch HUD bar fill for visible drift at attribute breakpoints. |
| `SkillAdvancementClass.Unusable` (Chorizite) vs `Inactive` (`holtburger_protocol::messages::character::types`) naming + missing `PartialOrd` | Wave C 2026-05-27 | Agent created parallel `TrainingClass` enum in `client/skill_info.rs` with `Ord` derived so the C# `>`/`>=` comparisons work; convertible at the wasm boundary. Consolidate names when WorldObject hierarchy lands. |

---

## 8. Wave A coverage honesty

**Files read in full:** all 7 READING_GUIDE.md files (1,518 lines total).

**Files I did NOT open:** the actual Chorizite source files. This doc consolidates the *guides*; the guides themselves consolidate the source. Two layers of indirection — when acting on any specific claim (especially §2 upstream bugs and §3 gotchas), open the cited file at the cited line.

**Not verified:** none of the guides' code-level claims were independently re-validated in Wave A. The exit gate (per absorption plan) was "subsequent waves reference this summary instead of grep-spelunking the READING_GUIDEs from scratch" — meeting it does NOT mean "every claim in this doc is correct," it means "this doc faithfully reflects what the 7 READING_GUIDEs say." §7 above is the explicit list of claims to re-validate before acting.

**Date conversion:** absorption plan dated 2026-05-27; this doc dated same. Today (per user-supplied currentDate) is 2026-05-27. All "today" / relative dates resolved to absolute.

---

## 9. Quick citation lookup

When acting on this doc, reach back to the original guide for full context:

| Repo | READING_GUIDE path | Sections most cited above |
|---|---|---|
| Chorizite.ACProtocol | `external/chorizite/Chorizite.ACProtocol/READING_GUIDE.md` | §3 (XML schema vocabulary), §5 (opcode parity), §6 (S2C handler enumeration), §7 (port plan) |
| ACPlugin | `external/chorizite/ACPlugin/READING_GUIDE.md` | §3 (read these 6 files first), §4 (public surface), §6 (port plan), §8 (gotchas), §9 (first PR) |
| Chorizite.Common | `external/chorizite/Chorizite.Common/READING_GUIDE.md` | §3 (parity matrix), §5 (gap-fill PR), §6 (idiom mapping) |
| ACBindings | `external/chorizite/ACBindings/READING_GUIDE.md` | §2 (folder map), §3 (subsystem reference), §4 (worked example), §5 (anti-patterns) |
| Chorizite | `external/chorizite/Chorizite/READING_GUIDE.md` | §3 (interfaces), §4 (manifest schema), §5 (6 things to steal) |
| RmlUiPlugin | `external/chorizite/RmlUiPlugin/READING_GUIDE.md` | §5 (threshold heuristic) |
| DatReaderWriter.Extensions | `external/chorizite/DatReaderWriter.Extensions/READING_GUIDE.md` | §3 (port targets), §5 (string-hash deep-dive), §6 (first PR) |

Each guide's frontmatter cites its own vendored HEAD commit — when the vendor pulls a fresher snapshot, re-validate before quoting.
