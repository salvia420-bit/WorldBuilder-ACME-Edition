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
5. **6 new DAT type readers** (`CSpellBase`, `CEnchantmentRegistry`, `CAllegianceProfile`, `VendorProfile`, `CContractTracker`, `CEmoteTable`) replace JSON catalogs with byte-correct retail data. See §1 row "Wave F". **F.1 DONE (2026-05-27)** — `CSpellBase` with component decryption + `getSpellRecord` wasm export + JS spellbook merge Proxy; parity 6,266 spells / 43,455 components / 0 errors against retail DAT.

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
- **PR 3 — DONE.** Existing 31-subclass skeleton's hierarchy verified correct (Foci→Container; Door/Portal/Lifestone/Bindstone/Corpse→Static; Armor/Clothing/Jewelry/MeleeWeapon/MissileWeapon/Wand→Equippable→Item). 4 stub subclasses filled out: `item.js` 15→219 LOC (IsStackable/Attuned/Bonded, SpellId(s), EnchantmentIds, ParentContainer read-through, IsOwnedByMe, Burden, Workmanship, UIEffects, UpdateSpells with Layer=0x8000 split), `container.js` 26→159 (`Items`/`Containers` read-through filters + ContainerType), `equippable.js` 33→101 (Wielder getter + `setWielded`), `creature.js` 15→197 (RadarColor/Behavior, Equipment, Stance, CombatMode, Level + canonical 17-stance→mode Map mirroring `Creature.cs:47-66`). `world_object.js` +52 LOC for the read-through plumbing (`setWorld`, `_allWeenies`, `_lookupWeenie`). 86 new hierarchy tests in `tests/world_objects_typed_hierarchy.test.cjs`; baseline 178 → **264/264 passing**. Read-through pattern chosen for `container.items`/`containers` (not maintained-list) to avoid consistency bugs the upstream C# is prone to. **Handoff doc correction noted:** `SetWielded` actually lives at `Character.cs:757-762`, not `Equippable.cs:9-17` (the latter only has the `Wielder` getter); we relocate cleanly to Equippable per JS port intent (mutation is on the equippable).
- **PR 4 — DONE.** `character.js` 15-line stub → **1,065 LOC** full port of `Character.cs`. Extends Container. 8 attr / 3 vital / N skill dicts + vitae + allEnchantments + sharedCooldowns + 7 events. Calls Wave C.2 wasm exports (`computeAttributeCurrent`, `computeVitalMax`, `computeSkillCurrent`, `level8AuraSelfSpells`, `vitaeSpellId`, `spellSetIds`) with defensive fallback. All 6 critical semantics preserved: Vitae 1.0=none ✓, UpdateVital even/odd parity ✓, enchantment tiebreak (Power desc → Level8AuraSelfSpells → set-spells beat non-set, by SpellId desc; within non-set by StartTime desc — mirrors Wave C's Rust segregation) ✓, cooldown discriminator (`type & 0x1000000`) ✓, PrivateUpdate* routing distinct from World public path ✓, SharedCooldown sign-extend `(layeredId << 20) >> 20` ✓. WorldState `setLocalPlayerGuid(guid)` + retro-upgrade branch in `dispatchItemCreateObject` covers both spawn-then-set and set-then-spawn races. **NEW kind=33 `PortalSpaceEntered`** emitted from PlayerTeleport recv arm (+30 LOC in `lib.rs`). 14 `PrivateUpdate*`/`PrivateRemove*` handlers + 8 Magic_*Enchantment* via snapshot diff + Login_PlayerDescription + Combat_HandlePlayerDeath + PortalSpace enter/exit. Matrix doc Character subtotal: 3 Y / 4 Partial / 33 N → **30 Y / 6 Partial / 0 N**. **Aggregate matrix: 14 Y / 26 Partial / 42 N → 41 Y / 28 Partial / 9 N** (+27 Y across PR 3+4). 56 new tests in `tests/character.test.cjs`. All baselines green; `cargo test -p holtburger-web --lib` 57/0; `cargo test -p holtburger-core --lib` 248/0; `cargo check --target wasm32-unknown-unknown -p holtburger-web` PASS; `validate_wire_conformance.cjs` 31/31.
- **Wave F.1 — DONE.** `CSpellBase` byte-correct retail spell record absorption. The existing `SpellTable` parser at `crates/holtburger-dat/src/file_type/spell_table.rs` (Wave C/C.2 baseline) already had the 26-field SpellBase layout; Wave F.1 closed the gap by porting **`SpellBase.GetStringHash` + `DecryptComponents`** (`Types/SpellBase.cs:120-174`) into `crates/holtburger-dat/src/utils.rs` (+96 LOC) so the encrypted `raw_components` array surfaces as plaintext `SpellComponentTable` IDs (1..198). Without decryption the JS spellbook was reading scrambled u32 garbage instead of scarab+talisman IDs. **NEW wasm export** `SessionHandle::getSpellRecord(spell_id) → JsValue` (+220 LOC in `apps/holtburger-web/src/lib.rs`) returns the structured record (camelCase, school/category/flags broken out as enums + 17-bit SpellFlags decoded). **JS consumer wired**: `plugins/spellbook.js::makeHybridCatalog` (+105 LOC) is a `Proxy` that prefers wasm records when WorldBootstrap is loaded, falls back to `data/spells-catalog.json` pre-login. JSON's name-parsed `level` field overrides wasm's `roughLevel` heuristic (which returns highest-scarab tier, not the spell's intended I-VIII suffix). **Parity validation against retail `client_portal.dat`**: 6,266 spells parsed, 43,455 components decrypted with **ZERO** out-of-range errors; 7/7 known-spell catalog cross-checks PASS (id 1-7 against LSD-derived JSON). 8 new spell_table tests + 12 new `tests/spellbook_wasm_record.test.cjs` JS-side merge contract tests. All baselines green (200 + 279 + 57 + 12). `serde-wasm-bindgen 0.6` added as a dep for `JsValue` serialization. Wave F.1 stretch items (`SpellComponentTable` wasm export, `SpellCategoryDB`, `Spell` wire-wrapper) deferred to F.2.
- **Wave F.2 — DONE.** Buffs / debuffs / cooldowns HUD chain completed. Closes the PR 4 handoff gap (§4 PR 4 row): the wasm `playerEnchantments()` snapshot now carries the full `StatMod` tuple (`stat_mod_type` / `stat_mod_key` / `stat_mod_value`) + `has_spell_set_id` + `spell_set_id` + 3 degrade fields, so PR 4's cooldown discriminator (`Character.cs:619`, `type & 0x1000000`) routes REAL wire data — not just synthetic test payloads. **Rust changes:** `PlayerEnchantment` / `PlayerEnchantmentJs` extended with 8 new fields (+95 LOC in `apps/holtburger-web/src/lib.rs`); `publish_player_enchantments_snapshot` no longer drops the tuple (was the load-bearing gap PR 4 documented); factored converter `player_enchantment_from_wire` lifted to `cfg(any(target_arch="wasm32", test))` for native parity probes. **JS changes:** `plugins/buffs-hud.js` rewritten (396 → 644 LOC) — 3-row layout (buffs / debuffs / cooldowns), classification by `EnchantmentTypeFlags` bits (not name-keyword heuristic), `formatStatMod` producing "+10 STR" / "x1.25 STR" labels, Wave-F.1 icon path via `wasm.getSpellRecord(spellId).iconId`, PR-4 tiebreak via `character.getActiveEnchantments()` when available (snapshot fallback when not), `client.world.addEventListener('enchantmentAdded'|'Removed'|'Changed')` integration. Manifest version 0.2.0 → 0.3.0. **Tests:** 6 new native parity probes (`tests_player_enchantment_snapshot_shape`) covering cooldown-bit pass-through + sign preservation + spell-set round-trip + all-fields coverage. 34 new JS tests (`tests/buffs_hud.test.cjs`) covering classification (8 cases), stat-mod formatting (7 cases), normalization (3 cases), snapshot ingestion (6 cases including the Wave F.2 cooldown-route fix), Character integration (3 cases), time format (4 cases), manifest, and the wasm wire shape contract. **Validation:** `cargo test -p holtburger-web --lib` 57 → 63 (+6); `cargo test -p holtburger-world --lib` 279/0; `cargo test -p holtburger-protocol --lib` 286/0; `cargo check --target wasm32-unknown-unknown -p holtburger-web` PASS; `node validate_wire_conformance.cjs` 31/31 (no parser touched). **Unblocked next:** Wave F.3 candidates — `CAllegianceProfile` + `AllegianceHierarchy` (F8 allegiance panel), `VendorProfile` (vendor stock completeness), `CContractTracker` (F7 contracts panel).
- **Wave F.3 — DONE.** Allegiance: 2 commented-out S2C opcodes wired full-vertical — `0x027A AllegianceLoginNotification → kind=40 ALLEGIANCE_PRESENCE` (per-member login state delta + system-tab chat-line emit) and `0x027C AllegianceInfoResponse → kind=41 ALLEGIANCE_INFO` (full hierarchy reply). `crates/holtburger-protocol/src/messages/allegiance/events.rs` (+332 LOC) factored `AllegianceHierarchyBody` out of pre-existing `AllegianceUpdateEventData` so the new InfoResponse handler shares the body parser; `crates/holtburger-protocol/src/messages/game_event.rs` (+28 LOC) registers the 2 new variants + dispatch + pack arms. `apps/holtburger-web/src/lib.rs` (+~250 LOC) — opcode_for_game_event arms, kind constants, `latest_allegiance_info` Rc field, `SessionHandle.lastAllegianceInfoResponse()` getter, `AllegianceInfoSnapshotJs` build helper. `plugins/allegiance-panel.js` (+44 LOC) adds `subscribeAllegiancePresence()` flipping the cached `loggedIn` flag + system chat-line. **F8 hotkey already wired pre-F.3.** 15 new tests in `tests/allegiance_panel.test.cjs`. **AllegianceOfficerLevel enum** added to `holtburger-common::character` (was MISSING workspace-wide per handoff §5.3). 4 new round-trip tests in events.rs. Cross-coordination: added 2 mechanical `GameEvent::SendClientContractTracker[Table]` opcode_for_game_event arms in lib.rs to keep matches exhaustive against F.5's mid-flight variant additions (no parallel-conflict).
- **Wave F.4 — DONE.** VendorProfile typed shape: `crates/holtburger-protocol/src/messages/trade/profile.rs` (NEW 750 LOC) with full 9-field VendorProfile + retail `ShopSystem::BuyPrice`/`SellPrice` formulas (`acclient.c:719870-719913`), `VendorItem` per-item shape, `AcceptabilityCode` for sell-side rejection (8 codes), 19 new unit tests. `apps/holtburger-web/src/lib.rs` (+155 LOC) — `VendorState` field extension, `SessionHandle.getCurrentVendorProfile(guid)` wasm export, recv-loop persistence in `kind=12 VENDOR_OPENED` arm (previously triggered but carried no items). `plugins/vendor-ui.js` (+170 LOC, 0.4.0 → 0.5.0) — `enrichWithProfile` merge of Wave 7 stock + F.4 profile, JS-side `shopBuyPrice` helper (`shopSellPrice` removed as unused — drag-to-sell sell-price is a Wave F stretch). 17 new tests in `tests/vendor_profile.test.cjs`. Promissory-note 1.0/1.15 special-case + u32::MAX no-cap sentinel + 8 acceptability rejection codes covered. **NEW wasm export** plus the existing Wave 7 buy/sell primitive stays intact.
- **Wave F.5 — DONE.** Contracts: 3 commented-out opcodes wired — `S2C SendClientContractTracker = 0x0315` (single-tracker delta) + `S2C SendClientContractTrackerTable = 0x0314` (full-table replace) → `kind=34 CONTRACTS_UPDATED`; `C2S GameAction AbandonContract = 0x0316`. `crates/holtburger-protocol/src/messages/contracts/{mod,events,actions}.rs` NEW (434 LOC) — 28-byte CContractTracker wire payload per `acclient.c:0x0059A180`, `PackableHashTable<u32, ContractTracker>` for table replace, single-tracker event appends 2 i32 bools (delete_contract + set_as_display_contract). `apps/holtburger-web/src/lib.rs` (+~450 LOC split between mid-file inserts and end-of-file appends) — opcode arms, `latest_contracts` field, `SessionHandle.getContractsTracker()` + `abandonContract(id)`, kind=34 dispatch. `plugins/contracts-panel.js` rewritten to consume real data (HH:MM:SS countdown for repeatable cooldowns, stage label, Abandon button wires the GameAction); **F7 hotkey was pre-wired**. 16 new `tests/contracts_panel.test.cjs`. 10 new tests in protocol crate. Map-waypoint + Redo buttons left as stubs (no ACE wire support). Contract NAMES come from `Contract #N` placeholders until a future `CContractTable` DAT parser lands.
- **Wave F.6 — DONE.** Emote: `CEmoteTable` confirmed **wire-only** (inline member of `CACQualities`), NOT a DAT file — corrects the absorption plan §Wave F #6 hypothesis. `crates/holtburger-common/src/properties/emote.rs` (NEW, 450 LOC) ports `EmoteCategory` (39 variants) + `EmoteType` (122 variants) — both were MISSING workspace-wide per handoff §5.3. `crates/holtburger-protocol/src/messages/emote_table.rs` (NEW, 1,459 LOC) — `EmoteTable { emotes: BTreeMap<EmoteCategory, Vec<EmoteSet>> }` → `EmoteSet{category, probability, class_id?, style?, substyle?, quest?, vendor_type?, min/max_health?, emotes: Vec<EmoteRecord>}` → 27-variant `EmoteRecord` sum type covering all 122 EmoteType discriminants. `apps/holtburger-web/src/lib.rs` (+180 LOC at file end) — `SessionHandle.getEmoteTaxonomy()` + `getSoulEmoteSupportedTypes()`. `plugins/emote-panel.js` NEW (532 LOC) — categorized 122-type picker with filter/visibility toggles + dispatch routing (Motion → soul-emote slash hint; Say → /me hint; server-only → info note). Wave 9.5's existing soul-emote broadcast intact. 24 new `tests/emote_table.test.cjs` + 6 new emote_table round-trip tests + 4 enum tests in -common. Retail portal.dat parity = N/A (wire-only). 33 wire-variant round-trip cases lock the read-order contract.
- **Wave F status (after F.3-F.6 parallel batch):** Wave F is **COMPLETE** end-to-end. All 6 readers/integrations shipped. Aggregate workspace tests: **1,295 PASS / 0 FAIL** (excluding unrelated pre-existing `holtburger-cli tell_command` failure — flagged since Wave C). Pre-existing `holtburger-tools::dat_shard::compute_boot_keep_set_includes_essentials_and_spawn_cells` stale-test fixed at the same time (count grew 27→28 when DEFAULT_KEYMAP_ID was added on 2026-05-24 per `project_retail_keymap_discovery_2026-05-24.md`; test asserted 27 instead of being updated to 28).
- **PR 8 — DONE (parallel batch 2026-05-27).** JS-plugin manifest schema + loader shipped. `plugins/schemas/plugin-manifest.json` (NEW, 112 LOC, JSON Schema 2020-12). `plugins/loader.js` (NEW, 713 LOC) with all 6 §5 features: `validateManifest` (non-throwing, multi-error), `resolveDependencies` (npm-style ranges + `?` optional suffix + cycle detection), 5-stage lifecycle hooks (`onBeforeLoad`/`onLoad`/`onBeforeUnload`/`onUnload`/`onRequestReload`), `applyDevManifest` (sidecar override), `createEatableBus` (`ev.eat()` semantics), `fetchManifestIndex` (browser helper). **29 per-plugin manifests** co-located as `<id>.manifest.json` next to each `<id>.js` (chose flat-file convention to avoid moving 29 files / breaking imports). `plugins/index.json` is the discovery surface (browsers can't dir-walk). 89/0 tests in `tests/plugin_loader.test.cjs`. **Deferred:** index.html migration (loader is in tree but not yet wired); hotkey enforcement (manifests declare them; runtime keymap still owns binding); live-reload (intentional per Chorizite §7 aside — JS modules unloadable). **New upstream Chorizite bug discovered** — see §2 row 12.
- **Wave G — DONE (parallel batch 2026-05-27).** Remaining workspace-MISSING enum gap-fill. **8 enums ported** (+1 bonus `PropertyPosition` from §5.3's "MISSING from -common" subset): `ClientAction` (294 variants), `RootElementId` (9), `FriendsUpdateType` (bitflags, 4), `CoverageMask` (bitflags, 15), `ContainerProperties` (3), `PropertyAttribute2nd` (7 with `is_max()/is_current()` helpers preserving Character.cs:721 even/odd parity gotcha), `SpellCategory` (729 retail variants with 2 documented gaps at 622 and 700..=703), `PropertyPosition` (27). 2 new modules: `properties/ui.rs` (NEW, 444 LOC) + `properties/position.rs` (NEW, 186 LOC). `cargo test -p holtburger-common --lib`: 44 → **55/0** (+11). Notable findings: `RootElementId::LogOut` shares discriminant `0x10000026` with `ClientAction::LOGOUT` (intentional — action triggers element); `ContainerProperties::Container = 0x01` distinct from `ItemType::CONTAINER = 0x200` (orthogonal taxonomies); retail casing-quirks preserved verbatim in `SpellCategory` ("Transfertocaster", "lessor" not "lesser", etc.).
- **DRW.Ext IDs PR — DONE (parallel batch 2026-05-27).** 46 well-known DAT IDs ported from `DatReaderWriter.Extensions/DBObjs/{EnumIDMap,EnumMapper,StringTable}Extensions.cs`. `crates/holtburger-dat/src/well_known_ids.rs` (NEW, 460 LOC) with 3 sub-modules: `enum_id_map` (21 constants, `0x25000001..=0x25000015`), `enum_mapper` (11, `0x22000005..=0x22000043`), `string_table` (14 — 13 in `0x23xxxxxx` + 1 outlier `LANGUAGE = 0x41000000`). 10 new tests. `cargo test -p holtburger-dat --lib`: 202 → **212/0** (+10). Notable: handoff's "13 entries at 0x23xxxxxx" was off-by-one (the LANGUAGE outlier brings StringTable to 14). Cross-module collisions documented: `CHARACTER_TITLE` exists in both `enum_mapper` (`0x22000041`, id-name map) AND `string_table` (`0x2300000E`, title strings). `utils.rs` left untouched (Wave F.1 already added `string_hash` + `spellbase_string_hash` there).
- **Wave F follow-on cluster — DONE (parallel batch 2026-05-27).** All 4 follow-on items shipped: (1) `getSpellComponentRecord(id)` wasm export — on-demand thread-local cache (NOT WorldBootstrap-coupled to avoid Wave G's surface); (2) `getSpellCategoryName(id)` + `SpellCategoryDB` module (NEW, 838 LOC, 729 enum entries — sources from ACE.Entity.Enum.SpellCategory because Chorizite's `ACBindings/.../SpellCategoryDB.cs` is just a vtable scaffold); (3) `requestAllegianceInfo(target_name)` C2S — uncommented opcode `0x027B AllegianceInfoRequest` + added `↻` refresh button to allegiance-panel; (4) `CContractTable` DAT parser (NEW, `crates/holtburger-dat/src/file_type/contract_table.rs`, 404 LOC) + `getContractRecord(id)` wasm export — contracts-panel now shows real names ("Jailbreak: Ardent Leader") instead of `Contract #N`, plus NPC + landblock id in the detail block. 4 new wasm exports + 2 new tests in contracts_panel + 6 new protocol tests + 5 new dat tests. `cargo test -p holtburger-protocol --lib`: 325 → **331/0**; `cargo test -p holtburger-dat --lib`: 212 → **217/0**. Spellbook right-click detail popover now shows `Category: <name> (#<id>)`. SpellLevelCache (Wave F.1 roughLevel accuracy) explicitly out-of-scope, still deferred. **New gotcha discovered** — see §3 row about `read_pstring` 0xFFFF escape.

**Session aggregate (after 2026-05-27 parallel batch 2):** **1,314 workspace tests PASS / 0 FAIL** (across 15 Rust crates, excluding pre-existing CLI failure). 32 PASS / 0 FAIL / 4 SKIP wire conformance. 12 JS suites all green. ~9,200 LOC added across this batch (PR 8 ~1,900 + Wave G ~1,840 + DRW.Ext IDs ~460 + Wave F follow-ons ~2,500 + handoff doc). New Chorizite upstream bug catalogued (handoff §2 row 12).

- **Polish A — DONE (parallel batch 3, 2026-05-27).** `index.html` loader-driven migration. PR 8's `loadPlugins()` + `fetchManifestIndex()` now build the 16-slot `barSlots` array via the new `buildBarSlotsViaLoader()` helper (+287/-94 LOC in `index.html`). Loader's `loaded` Map → adapter → mountBar-shape preserves exact id-order and mount/activate composition. **Hybrid migration** — 31 static `import * as <id>Plugin` lines kept (load-bearing for non-bar uses like `mainPanelPlugin.registerView`, `inventoryPlugin.view`, `compass-hud` side-effect import); the bar-slot construction itself is now loader-driven. Edge cases: `examine-target.js` file→manifest id `examine-target-watcher` divergence resolved via `PLUGIN_MODULES`/`BAR_SLOT_ORDER` table; `combat-bar.mount()` preserved-not-wired via `BAR_SLOT_EXPORT_OVERRIDES` (existing literal only attached `activate`, mount() registers armed-spell cleanup that never fired pre-Polish-A — flagged as follow-up); `stance-toggle` + `emote-panel` suppressed from bar surface via `BAR_SLOT_SUPPRESS`. 89/0 plugin_loader tests preserved.
- **Polish B — DONE (parallel batch 3, 2026-05-27).** Manifest-driven hotkey resolution in `ui/keymap.js` (+244 LOC). New public API: `parseHotkeyString` (canonicalises `"Shift+Ctrl+F5"` → `"Ctrl+Shift+F5"`), `buildManifestBindings(manifests[])` (aggregates `{id, hotkeys[]}` into `{map, labels, duplicates}` with duplicate detection), `setManifestBindings(map)`, `matchHotkeyEvent(KeyboardEvent)` → `{pluginId, hotkeyId, label, keyString}|null`. **10/29 manifests now declare hotkeys** — pre-existing 6 (allegiance F8, combat-bar F4 aspirational, contracts-panel F7, emote-panel Shift+F2 orphaned, inventory "I" orphaned, spellbook F5) + 4 added (map-panel F3, journal-panel F6, fellowship-panel F9, house-panel Shift+F6). 38/0 new tests in `tests/keymap_manifest.test.cjs`. Module is a **resolver** not a dispatcher — no window keydown listener added (dispatch lives in index.html). Findings: F-key dispatch actually lives in `index.html:1443-1476` (not `ui/keymap.js` as initially assumed); 3 orphaned hotkey declarations (emote-panel Shift+F2, combat-bar F4, inventory "I") need follow-up; plugin-id ↔ view-name divergence (e.g. `allegiance-panel` → view `"allegiance"`) requires a translation convention.
- **Polish A→B bridge — DONE (manual integration 2026-05-27).** Wired `setManifestBindings(buildManifestBindings(loaded).map)` after Polish A's `loadPlugins()` resolves; prepended `matchHotkeyEvent(ev)` to the index.html keydown listener with a plugin-id → view-name derivation (`com.holtburger.<x>-panel?` → `"<x>"`); legacy `FKEY_VIEWS` / `FKEY_SHIFT_TOGGLES` kept as fallback for unmanifested plugins (character F1, options F10, spell-research Shift+F4). Manifest hotkeys are now LIVE — opening allegiance via F8 goes through Polish B's resolver instead of the inline table. 38/0 keymap tests + 89/0 plugin_loader tests + all JS regression suites green post-bridge.
- **Polish C — DONE (parallel batch 3, 2026-05-27).** Promoted `read_pstring_char` from `crates/holtburger-dat/src/file_type/contract_table.rs` to `crates/holtburger-dat/src/utils.rs:130-166` (Option A: promote, not Option B: fix-in-place — existing `read_pstring` has 5 callers with their own `align_boundary` follow-ups; changing it would risk silent cursor shifts). Existing `read_pstring` doc-comment now lists the 5 verified-safe callers + flags 5 other parsers (`game_time.rs`, `region.rs`, `chat_pose_table.rs`, `skill_table.rs`, `weenie.rs`) that read `PStringBase<char>`-annotated fields with `read_pstring` + `align_boundary` and are technically incomplete on the 0xFFFF length escape (safe today only because retail strings are <65,534 bytes). 6 new tests (217 → **223/0**) covering: short string, empty, 0xFFFF u16→u32 length escape, 4-byte align-pad cursor advance (all 4 mod-4 cases), trailing-NUL stripping per `acclient.c:296547-296550`. Future cleanup wave should migrate the 5 flagged callers to `read_pstring_char` for correctness-by-construction.

- **PR 7 — DONE (parallel batch 4, 2026-05-27).** `build.rs` over `protocol.xml`: emits a tier-1 codegen layer alongside hand-written parsers. `crates/holtburger-protocol/build.rs` (NEW, 840 LOC) parses the 8,562-line `protocol.xml` via `roxmltree 0.20` (build-dep only — runtime crate untouched), emits `$OUT_DIR/messages_generated.rs` (Cargo convention, never committed). `lib.rs` adds `pub mod generated { include!() }`. Output: 23,292 lines / 1.2 MB containing 127 enums + 43 datatype structs + 83 simple S2C messages + 145 GameActions + 73 GameEvents + an `OPCODE_INDEX` slice of 301 `(kind, name, opcode)` tuples. **Coverage:** ~95% of types are foundation-tier; the ~35 conditional-encoded types (`<switch>`/`<mask>`/`<vector length="FieldName">`) are explicitly deferred to **PR 7.2** with 124 `// SKIPPED` notes + per-case reasons in the generated output. **Reconciliation:** disjoint namespaces — hand-written `messages::login::EnterWorld` stays source of truth; generated layer is `generated::C2S_Login_SendEnterWorld` (section prefixes `C2S_`/`S2C_`/`Action_`/`Event_` disambiguate cross-section name collisions like `Login_LogOffCharacter` in both `<c2s>` AND `<s2c>`). 6 new generated-parity tests at `tests/generated_parity.rs`: asserts OPCODE_INDEX ≥ 280, ≥25 opcodes overlap with hand-written `GameOpcode`, ≥50 distinct codegen sections. Validation: `cargo build` PASS; `cargo test -p holtburger-protocol --lib`: 331/0 (baseline preserved); `cargo test --test generated_parity`: 6/0; `cargo check --target wasm32-unknown-unknown`: PASS. **PR 7.2 backlog** (priority order): `<vector length="FieldName">` (12 sites — unblocks PackableList/HashTable + ACBaseQualities); `<maskmap>` (22 sites — unblocks WeenieHeaderFlag); `<switch>` (18 sites incl. TurbineChat nested); `<subfield>` (6 sites); `<table>` Dictionary<K,V> (4 sites); `<align>` padding; `<if condition>`. **New gotchas:** see §2 row 14 + §3 fictional `<datatypes>` note + field-name-shadows-fn-param sanitizer notes.

- **Wave D.2 — DONE (parallel batch 4, 2026-05-27).** `gmCharacterCreationUI` 3-page wizard shipped fully DAT-driven. `apps/holtburger-web/plugins/character-creation.js` (NEW, 1,064 LOC) — full state machine (`NotStarted`/`Heritage`/`Skills`/`Summary`/`Submitting`/`Success`/`Failed`) + 3 wizard pages: heritage+gender+template+name (page 1), per-skill credit allocation with running budget (page 2), read-only summary + submit (page 3). State transitions exported as pure helpers for headless tests. **DAT-driven** — `SessionHandle.getCharacterGenCatalog()` + `getSkillCostsForHeritage(h, s)` wasm exports surface the parsed `CharGen` (0x0E000002) DAT + heritage skill cost overrides. Wire integration via existing `0xF656 CharacterCreate` C2S + `0xF643 CharGenVerificationResponse` S2C (kinds 5/6). New `SessionHandle.sendCharGenResult(payload)` wasm export validates client-side via `CharacterGenBuilder::build_request` (mirrors every ACE-side invariant) before dispatch. 44/44 new tests in `tests/character_creation.test.cjs` covering: 10 state-machine cases, 9 name-validation cases, 7 credit-budget math cases, 5 payload-shape cases, 5 template-seeding cases, 6 default-picker cases, 3 appearance cases. `apps/holtburger-web/src/lib.rs` +418 LOC (3 new wasm exports at file end), `index.html` +67 LOC (kind=5/6 event-bus fan-out for the wizard's plugin client + "New Character" launcher), `plugins/api.js` +30 LOC (`client.characters` namespace: `getCatalog`/`skillCostsFor`/`createCharacter`). 29 → 30 manifests in `plugins/index.json`. **Deferred:** per-skin/hair swatch pickers (v1 ships Randomize Appearance only); manual attribute point spending (templates handle the spread); start-area dropdown (auto-picks heritage's first primary). Legacy `#create-form` kept side-by-side for agent-driven smoke tests. **New gotchas:** `serde camelCase` JS payload contract — keys MUST be camelCase or `into_wire()` errors with missing-field; `expectedSkillSlots` dense-array invariant (skills with id ≥ slot count silently dropped); `characterSlot` SHOULD be omitted from payload for wasm auto-assign.

**Absorption-plan status: end-to-end COMPLETE.** All originally-deferred items (PR 7, Wave D.2) shipped. PR 7.2 (conditional encoding) remains as a documented backlog for future codegen-coverage growth.

---

## Post-absorption backlog (per [`post-absorption-backlog-plan-2026-05-27.md`](post-absorption-backlog-plan-2026-05-27.md))

- **Wave J1.A — DONE (parallel batch 5, 2026-05-27).** 3 orphan hotkey declarations resolved + `combat-bar.mount()` refactored to module-load IIFE. `emote-panel.js` deleted `window.__toggleEmotePanel` global (manifest-hotkey path is canonical now); `combat-bar.manifest.json` dropped F4 (bar is always visible); `inventory.manifest.json` "I" replaced with F4 (de-facto open-inventory binding). `combat-bar.js` `mount()` body moved into `installAutoDisarmHooks()` module-load IIFE — auto-disarm subscriptions now actually fire (was broken-on-purpose pre-J1.A via Polish A's `BAR_SLOT_EXPORT_OVERRIDES`). Incidental cleanup: deleted dead `toggle()` function + `buildPanel()` body in emote-panel.js (~75 LOC dead-code removal); deleted unused `unsubLb`/`unsubStats` assignments in combat-bar.js.

- **Wave J1.B — DONE (parallel batch 5, 2026-05-27).** Legacy FKEY tables retired. 3 new manifests for previously-unmanifested plugins: `character-info.manifest.json` (F1), `options-panel.manifest.json` (F10), `spell-research-panel.manifest.json` (Shift+F4) — all `iconHidden: true` panel/overlay slots. `inventory.manifest.json` got F4 (replacing J1.A's removed "I"); `spellbook.manifest.json` got F2 as `toggle-alt` (preserves retail F2+F5 dual-binding). `index.html` `FKEY_VIEWS` + `FKEY_SHIFT_TOGGLES` tables deleted (~30 LOC); replaced with `PLUGIN_HOTKEY_DISPATCH` lookup that handles 2 id↔view-name divergence cases (`character-info → "character"`, `spell-research-panel → window.__toggleSpellResearchPanel?.()`). `plugins/index.json` 30→33 manifests. `tests/plugin_loader.test.cjs` 90→93 PASS; `tests/keymap_manifest.test.cjs` 38→41 PASS.

- **Wave J1.C — DONE (parallel batch 5, 2026-05-27, integrated by main thread after agent flagged blocker).** Static plugin import audit + deletion. Agent's audit found that Polish A's `PLUGIN_MODULES` lookup at index.html:1181-1215 *also* references each static import (separate from the bar-slot region the prompt forbade), so it correctly STOPPED + reported the audit table. Main thread applied Option A (extend scope to include PLUGIN_MODULES): **31 → 11 static imports retained** (kept those with non-bar uses: 9 `.view`/`registerView` exports + `mainPanel` host + `compass-hud` side-effect import); **27 → 9 PLUGIN_MODULES entries** retained (those that have non-bar consumers). 18 bar-slot-only plugins now resolve via the loader's dynamic `modulePath` path (the loader's `fetchManifestIndex` already returns `modulePath` for each entry). Net ~50 LOC removed from index.html.

- **Wave J2 — DONE (parallel batch 5, 2026-05-27).** `read_pstring_char` migration (handoff §2 row 13 closed). **9 production call sites + 1 test-fixture mirror** migrated (5 prompted + 5 bonus discoveries). Per-file: `game_time.rs` (4 sites), `region.rs` (3 sites — `align_boundary` import kept for 5 non-string callsites), `chat_pose_table.rs` (1 site collapsed via `parse_pstring_aligned` helper), `skill_table.rs` (1 site + structural cleanup — deleted orphaned `parse_align` + `_align1`/`_align2` struct fields), `weenie.rs` (1 site + safer error semantics — `read_pstring_char` propagates errors instead of swallowing via `let _ = align_boundary(...)`). **Bonus 0xFFFF stress test** added at `weenie.rs:127-210`: synth-constructs a Weenie blob with a 65,536-byte `PropertyString::Name` value (smallest length forcing the escape), verifies post-string DID/IID buckets decode correctly. `utils.rs::read_pstring` doc-comment simplified (verified-safe callers list dropped — zero callers remain outside the `utils.rs` test module; function retained for future non-default `size_of_length` callers). `cargo test -p holtburger-dat --lib`: 223 → **224/0** (+1 stress test).

**Post-absorption code-quality status (after parallel batch 5):** 1,378 workspace tests PASS / 0 FAIL across 16 crates. All 15 JS test suites green. 32/0/4 SKIP wire conformance. ~50 LOC dead code removed; 5 incomplete primitives closed (correctness-by-construction); no longer-valid-once-conditions-trigger bugs in the `read_pstring` family. Handoff §2 row 13 marked **CLOSED** as a follow-up status; rows 14+ still open.

**Remaining post-absorption backlog (per the plan doc):** Wave J3 (codegen coverage — PR 7.2 sub-PRs A-E), Wave J4 (feature polish — SpellLevelCache, char-creation pickers, attribute spending), Wave J5 (pre-existing test failures — `tell_command`, `soa_aos_parity`, the Wave F.4 wire-conformance SKIP).

- **Wave J5.A — DONE (parallel batch 6, 2026-05-27).** `tell_command_dispatches_tell_client_command` was test-drift from commit `fd7deb25` ("retail-strict comma /tell parser" — May 25 2026) which switched the production parser from space-separator to comma-separator per `acclient.c:417984 DoTell`, but the unit test was never updated. Test now feeds `/tell Bestie, hi there` (comma-required) with a doc-comment citing the commit. Added a new regression-guard test `tell_command_without_comma_warns_and_does_not_dispatch` covering the warning path. **Bonus catch:** the workspace was running with `--exclude holtburger-cli` since Wave C, masking a Wave J2 compile regression — `holtburger-cli/src/pages/game/panels/dashboard/tabs/character/render.rs:701-703` still referenced deleted `_align1`/`_align2` fields from a `SkillBase` test fixture (those fields were dropped in commit `563afacc` when J2's `skill_table.rs` migration deleted the parse_align helper). Fix shipped same surface. `cargo test -p holtburger-cli --lib`: **359 passed / 0 failed** (was -compile-error masked as "1 failed"); `cargo test --workspace --lib` now PASS without any `--exclude` — first time this session.

- **Wave J5.B — DONE (parallel batch 6, 2026-05-27).** `soa_aos_parity` env-file guarded via `HOLTBURGER_DIST_V2_MANIFEST` env override (falls back to `/mnt/wbterminal1/holtburger-dist-v2`). Three `process.exit(2)` FAIL branches replaced with a single `SKIP` block that prints `SKIP: holtburger-dist-v2 not present at <DIR>`, lists missing files, hints at the env-override + dat-shard pipeline, exits 0. The test's 507-hash sha256 comparison against ~4.7GB of baked dist data is preserved — only the missing-fixture path is graceful now. Wave F.4 wire-conformance SKIP fixture comment tightened to lead with `PERMANENT SKIP per J5.B 2026-05-27` and trail with explicit "do not investigate further without confirming upstream Chorizite movement first" — the upstream Write/Read bool asymmetry is out of our control. Wire conformance counts unchanged: `Checked: 36 / Pass: 32 / Fail: 0 / Skipped: 4`. **New convention:** `HOLTBURGER_DIST_V2_MANIFEST` env override is the template for any future test that needs the v2 bake. **New §3 gotcha candidate:** the Chorizite bool encoding asymmetry now has TWO permanent-SKIP fixtures (F.3 + F.4); if a third surfaces, consider a §2 row dedicated to "Chorizite bool encoding asymmetry — entire family of fixtures stuck on this."

**Post-J5 code-quality status:** `cargo test --workspace --lib` (NO `--exclude` needed for the first time this session) → **1,737 PASS / 0 FAIL** across 17 crates. All 15 JS suites green; `soa_aos_parity` exits 0 with clear SKIP in dev. Wire conformance 32/0/4 SKIP. **Lesson learned:** `--exclude <crate>` masks BOTH test failures AND compile errors — verification should run `cargo build --workspace` or `cargo test --workspace --lib --no-run` to catch compilation regressions independent of test status.

**Remaining backlog:** Wave J3 (codegen coverage), Wave J4 (feature polish).

- **Wave J3 — DONE end-to-end (sequential A→B→C→D→E, 2026-05-27).** PR 7.2 codegen coverage growth. Final coverage **97.4%** (3 templated-meta SKIPs out of 471 candidates; effectively ≥98% if those are excluded from the denominator — they have no struct shape, they're inlined at every use-site). 5 sub-waves shipped in 5 commits (`cdcf92d4` → `2e61e6ac` → `e9c842a6` → `cadc8344` → final). build.rs grew from PR 7's 840 LOC to **4,173 LOC** end-state. Generated artifact grew from 23,292 to **~25,000 lines**. SKIPPED notes 128 → **3** (-125 net). Newly-emitted: 40+ types including the renderer-critical ACBaseQualities/ACQualities (primary J3 goal), ItemProfile, PublicWeenieDesc, EmoteTable, EnchantmentRegistry, PhysicsDesc, AllegianceData, AllegianceHierarchy/Profile, AttributeCache, RestrictionDB, ObjDesc, Body, RawMotionState/InterpretedMotionState, PositionPack, the TurbineChat nested-switch family, plus 14 switch-discriminated-union enums. generated_parity tests 6 → **57** (+51 round-trip + chain-unblock tests). 1,737/0 workspace lib tests preserved across all 5 sub-waves.
  - **J3.A — DONE.** `<align>` + `<subfield>` foundation. EmitStep enum + recursive-descent C# expression translator (parse_or→xor→and→shift→addsub→muldiv→cast_or_unary→atom). Key finding: `<subfield value=...>` uses C# expressions (`parent & MASK`, `(uint)1 << ((int)PackedSize >> 24)`), NOT structured `lowBit/bitCount`. 18 align + 10 subfield sites.
  - **J3.B — DONE.** `<vector length="FieldName">` length-prefixed arrays + SiblingLookup infrastructure. 12 sites; honest unblocked = 1 (BlobFragments) but foundation reused by C/D/E for cascade-unblocks.
  - **J3.C — DONE.** `<maskmap>` bitfield-driven optional fields + xor polarity inversion + flag-enum→numeric-repr downgrade. 24 maskmap blocks / 190 mask children. 16 byte-identical PositionPack fixtures (exceeded ≥10 spec). 4 newly-emitted types.
  - **J3.D — DONE.** `<switch>` discriminated unions + `<table>` Dictionary<K,V>. Biggest single SKIP-delta (-23 net). TurbineChat nested-switch full round-trip live. Enum-based codegen with case-scoped names for nested-switch C2S/S2C collisions. 10 structs + 14 switch enums.
  - **J3.E — DONE.** Templated types (PackableList<T>, PackableHashTable<K,V>, PHashTable<K,V>) per-site-inlined (not Rust generics — matches Chorizite C# SourceGen approach). 96 use-sites total (66+28+2). `<if condition>` (actually `<if test>` in the schema) with 6 sites. 24 cascade-unblocks confirmed including the renderer-critical ACBaseQualities/ACQualities. New gotchas: bool/float reps registration, capital-`String` vs lowercase-`string` aliasing, maskmap-gated fields as later-maskmap parents (Option-aware), `Vec<(K,V)>` not BTreeMap for struct-keyed tables.

**Pre-existing failure surfaced (NOT J3):** `tests/opcode_parity.rs::opcode_parity_categorization_gate` fails on master (`BookModifyPageResponse 0x00B5` not in Chorizite; not allowlisted). Integration test, not exercised by `cargo test --workspace --lib`. Candidate for J5-style allowlist-update follow-on (small, isolated).

**Now-unblocked UI work** (post PR 1-4):
- Vitals HUD: `client.character.maxVital(1)` returns exact Endurance+enchantment+vitae-folded value (was approximated).
- Buffs/debuffs HUD: **SHIPPED Wave F.2** — `plugins/buffs-hud.js` v0.3.0 renders 3-row strip (buffs/debuffs/cooldowns) with statMod labels ("+10 STR" / "x1.25 STR"), Wave-F.1 icons, PR-4 tiebreak via `client.character.getActiveEnchantments()`, `client.world.addEventListener('enchantmentAdded'|'enchantmentRemoved'|'enchantmentsChanged', …)`. The wasm `playerEnchantments()` snapshot was extended to carry the full StatMod tuple so the cooldown discriminator (`Character.cs:619`) routes REAL wire data — not just synthetic payloads.
- Charge-attack power scaling: `client.character.currentSkill(skillType, formula)` instead of approximation.
- Loading-screen overlay: `client.world.addEventListener('portalSpaceEntered', …)` (kind=33).
- /assess UI: per-entity `objectAppraised` event (kind=32).
- Selection-ring HP overlay: `client.world.selected` + `playerStatsUpdated`.
- Symmetric chest/corpse close animations: `containerClosed` (kind=31).
- Container `items`/`containers` getters live: vendor sub-pack views, paperdoll backpack viewer, container-open chest UIs.
- Wave D.1 follow-on title swap can now resolve `parentContainer.name` directly.

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
| 10 | **Chorizite `Write`/`Read` bool asymmetry.** `BinaryWriter.Write(bool)` emits 1 byte (C# default), but `BinaryReaderExtensions.ReadBool()` consumes 4 bytes as a `u32`. Retail wire is 4-byte-bool (`acclient.c:702448`) so Read is correct, but synth-pack tests round-trip-fail. Same family: `WritePackableHashTable.Write(value.Count)` emits `i32` (4 bytes) but `Read` consumes `i16+i16` (2+2 bytes). **Discovered during Wave F.3+F.5 (2026-05-27).** | `Chorizite.ACProtocol/.../BinaryReaderExtensions.cs` + `BinaryWriterExtensions.cs` | Our Rust unpackers mirror the wire-correct 4-byte-bool. WB.Terminal wire-conformance synth-pack fixtures that touch any `bool` field are SKIPped with this reason cited (validate_wire_conformance.cjs 4-SKIP set). File upstream PR if/when convenient. |
| 11 | **`EmoteType.Invalid_VendorEmoteType = 0x00`** is a duplicate-discriminant alias of `Invalid_EmoteType = 0x00`. Rust enums forbid this; we collapse to one variant. **Discovered during Wave F.6 (2026-05-27).** | `Chorizite.Common/Enums/EmoteType.cs` | Minor — collapse the alias in any Rust port; flag if a future codegen pipeline tries to map both. |
| 12 | **`PluginManifest.Validate(out errors)` is inverted at `PluginManifest.cs:137`.** The `IsNullOrWhiteSpace` check only tries `new Version(...)` when the string IS whitespace, making the version validation a no-op on real values. **Discovered during PR 8 (2026-05-27).** | `Chorizite.Core/Plugins/PluginManifest.cs:137` | Our `validateManifest` in `plugins/loader.js` does the obvious right thing: validates a present version, accepts absence as a separate missing-required error. File upstream PR. |
| 13 | **`holtburger-dat::utils::read_pstring` is incomplete for `PStringBase<char>`.** Doesn't handle the `0xFFFF u16 → u32-extended length escape` (`acclient.c:296531`) NOR the 4-byte align-pad after the string (`acclient.c:296564-296566`). **Discovered during Wave F follow-on `CContractTable` port (2026-05-27).** | `crates/holtburger-dat/src/utils.rs::read_pstring` | Promoted to `utils.rs` as `read_pstring_char` via Polish C (2026-05-27); 5 pre-existing callers in `game_time.rs`/`region.rs`/`chat_pose_table.rs`/`skill_table.rs`/`weenie.rs` still use `read_pstring + align_boundary` (safe today because retail strings are <65,534 bytes; future cleanup wave should migrate). |
| 14 | **`EnchantmentMask` has 4 duplicate discriminants all = `0x03912021`.** `Multiplicative`/`Additive`/`Vitae`/`Cooldown` all share the same value. Clearly an upstream Chorizite typo. **Discovered during PR 7 codegen (2026-05-27).** | `Chorizite.ACProtocol/.../EnchantmentMask.cs` | Rust enums forbid duplicate discriminants; PR 7's codegen sanitizer collapses to one variant with `pub const` aliases for the others. File upstream PR. (Also: 2 other enums have duplicates that ARE intentional aliases — `GameMessageGroup.Observer = Group = 0x08`, `PortalBitmask.Undef = NotPassable = 0x00`.) |
| 15 | **Rust reserved-keyword sanitizer beyond `r#` prefix.** `AttributeId::Self = 0x06` — `Self` is reserved AND can't be raw-identifier-escaped (`r#Self` is also forbidden). Same applies to `self`/`super`/`crate`. **Discovered during PR 7 codegen (2026-05-27).** | `Chorizite.Common/Enums/AttributeId.cs` | PR 7's `sanitize_rust_keyword()` falls back to `_v` suffix for these (e.g. `Self_v`). Handoff §5.3 §6 idiom-mapping should note this beyond the generic raw-identifier guidance. |

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
