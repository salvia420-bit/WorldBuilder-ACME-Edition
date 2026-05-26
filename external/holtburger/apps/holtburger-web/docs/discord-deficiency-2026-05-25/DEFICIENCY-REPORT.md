# Holtburger-Web 3D — Discord-Driven Deficiency Report

**Date:** 2026-05-25
**Method:** Cross-reference of (a) ~16,000 lines of Discord chat across 10 channels of `acpluginsdev` + `ac-clientstuff` + 1 DM, (b) `apps/holtburger-web/` scene3d/plugins/protocol inventory, (c) authoritative sources (Chorizite ACProtocol/ACPlugin, DatReaderWriter, ACE master, decompiled `acclient.c`/`.h`).

**Source files in this directory:**
- `topics-general.md` — 55 topics × 13 cats from #general (6.6K lines)
- `topics-altclients.md` — 33 topics × 17 cats from #alt-clients/chorizite/tool-dev
- `topics-worldbuilder.md` — 60 topics × 13 cats from #worldbuilder/decalinfo/DMs
- `holtburger-web-inventory.md` — 17-cat capability inventory of scene3d + plugins
- `upstream-canonical-surfaces.md` — Chorizite/DRW/ACE/acclient.c reference map

---

## Status — Wave M executed 2026-05-25 (3-agent parallelism)

| # | Item | Status | Notes |
|---|------|--------|-------|
| 22 (status receive) | House Status receive-side | **SHIPPED** | Wave M1. Uncommented `HouseStatus 0x0226` S2C. NEW `crates/holtburger-protocol/src/messages/house/events.rs` with 1 round-trip test. **ACE wire deviation:** `GameEventHouseStatus.cs` writes only `(uint)weenieError` — a single u32. Task spec anticipated house_id + rent_due + flags but ACE routes owned-house data through a SEPARATE `HouseData 0x0225` event; `HouseStatus 0x0226` is ACE's not-owned / evicted SIGNAL only (BadParam 0x0002 = no house, HouseEvicted 0x045F = evicted). Struct: `HouseStatusEventData { error: WeenieError }`. Rust mirror: `latest_house_status: Rc<RefCell<Option<HouseStatus>>>` + `HouseStatusJs` wrapper (exposes `errorCode` + `isHouseOwner` derived from `error_code == 0`). Recv-loop arm + `player_house_status()` getter. NO bus event — sync getter only. house-panel.js Status section at top of panel: "No house owned." / "Evicted from house." / "House: owner." / `WeenieError 0xNNNN` fallback. Subscribes to `playerStatsUpdated` + 1Hz fallback poll. |
| 19 (component table) | Component name catalog | **SHIPPED** | Wave M2. `data/spell-components.json` extended from 8 scarabs to **163 components, 100% retail coverage**. Source: extracted from retail `client_portal.dat` DAT 0x0E00000F `SpellComponentTable` via DatReaderWriter (one-off C# tool at `/mnt/wbterminal1/tmp/claude-scratch/spell-component-dump/` referencing prebuilt `WorldBuilder.Terminal/bin/Release/DatReaderWriter.dll`). Cross-validated against `data/spells-catalog.json` (Strength Other I's `Comp_1,7,33,44,49` resolves to Lead Scarab + Hyssop + Powdered Moonstone + Realgar + Poplar Talisman, matching retail wiki). **Bug fix:** existing JSON had IDs 7 and 8 labeled "Platinum Scarab" and "Mana Scarab" — retail wire actually has 7=Hyssop, 8=Mandrake (herbs); real Platinum Scarab = 112, Mana Scarab = 193. Distribution: 10 Scarabs, 21 Herbs, 12 Powdered Gems, 16 Potions, 30 Talismans+peas, 13 Tapers + 61 PotionPea practice variants. spellbook.js + spell-research-panel.js already fall through to this JSON via existing helpers — no code change needed. |
| Discord follow-on | Radar hover tooltip + click-to-target | **SHIPPED** | Wave M3 (pure JS). `plugins/compass-hud.js` adds 2 polish features to the L3 radar. **Tooltip:** single shared `_tooltipEl` appended to body, repositioned via `getBoundingClientRect()`, content `{entityName} • {dist}m • {±bearing}°` (bearing positive=right, negative=left of player facing). Anti-flicker via `event.relatedTarget` check on mouseout. **Click-to-target:** event delegation on radar container; `dotIndexFromEvent` resolves `event.target` against the 30-dot pool, looks up `_dotEntityRefs[idx]`, calls `liveScene3d.entityManager.setSelectedTarget(guid)`. Visual feedback: 200ms `.hb-radar-dot-pulse` (CSS scale 1.8). `?compassRadar=off` honored — all handlers early-out on `_radarEl.hidden`. |

**Files touched this wave:**
- `src/lib.rs` +79 LOC (M1: HouseStatus snapshot + getter + recv arm)
- `crates/holtburger-protocol/src/opcodes.rs` +10 LOC (1 uncomment + tidy)
- `crates/holtburger-protocol/src/messages/mod.rs` (no change — already registered house)
- `crates/holtburger-protocol/src/messages/house/{events.rs NEW + mod.rs +1}` (M1)
- `crates/holtburger-protocol/src/messages/game_event.rs` +10 LOC (M1)
- `plugins/house-panel.js` +90 LOC (M1 Status section + render hook)
- `plugins/compass-hud.js` +149 LOC (M3 tooltip + click-to-target)
- `data/spell-components.json` +161 LOC (M2 163-entry retail dump)

`cargo check --target wasm32-unknown-unknown -p holtburger-web` clean (exactly 18 pre-existing warnings, no new ones). `cargo test -p holtburger-protocol --lib`: **281/281 PASS** (M1 added 1 round-trip). `node --check` clean on all JS. JSON valid (163 components).

**Recommended Wave N** (next priorities):
1. **HouseData full receive (#22 polish)** — `HouseData 0x0225` carries the owner's house metadata (rent due timestamp, dwelling type, restrictions). M1 only handled the not-owned/evicted signal.
2. **House guest perms + storage perms + boot (#22 polish)** — 8+ remaining commented opcodes.
3. **Allegiance approved-vassal + officer-titles + ListBans receive (#4 final)** — 8 remaining commented opcodes.
4. **House picker UX (#22 polish)** — replace manual GUID inputs with List-Available-Houses dropdown.
5. **Spell research → spellbook bar drag-and-drop (#19 polish)** — drag a spell from the research panel to a spellbook bar slot.
6. **Radar bearing-axis labels** — small N/E/S/W tick marks at the radar centerline.

---

## Status — Wave L executed 2026-05-25 (3-agent parallelism)

| # | Item | Status | Notes |
|---|------|--------|-------|
| 22 | House system MVP | **SHIPPED (send-only)** | Wave L1. 4 opcodes uncommented (`BuyHouse 0x021C`, `HouseQuery 0x021E`, `AbandonHouse 0x021F`, `RentHouse 0x0221`). NEW `crates/holtburger-protocol/src/messages/house/{mod,actions}.rs` with 4 round-trip tests (Buy w/2 items, Rent empty, Query empty, Abandon empty). Wire authority: ACE `GameActionHouseBuyHouse.cs` + `GameActionHouseQuery.cs` + `GameActionHouseAbandon.cs` + `GameActionHouseRent.cs` (or equivalent). Struct shapes: `BuyHouseActionData { slumlord_guid: Guid, item_guids: Vec<Guid> }` (PackableList<u32> on wire = count + count×u32), `HouseQueryActionData {}`, `AbandonHouseActionData {}`, `RentHouseActionData { slumlord_guid: Guid, item_guids: Vec<Guid> }`. 4 GameAction variants + arms. 4 wasm methods (`buyHouse/houseQuery/abandonHouse/rentHouse`) + 4 SessionCommand + 4 recv arms with `[house/buy|query|abandon|rent]` logs. NEW `plugins/house-panel.js` (376 LOC) — 4 stacked sections (Buy/Rent/Query/Abandon) with manual slumlord-GUID + comma-list-of-item-GUIDs inputs (proper picker UX is Wave M); destructive paths gated by `window.confirm`. Debug: `window.__openHousePanel()`. Guest perms / storage perms / boot / list-available all deferred. |
| 20 (speculative) | Squelch list speculative refresh | **SHIPPED** | Wave L2 (pure JS). `plugins/social-panel.js` adds module-level `squelchMirror` state with `serverSnapshotToMirror()` + `readMirror()` lazy-init + 3 speculative helpers (`squelchCharacter/squelchAccount/squelchGlobal`) that send wire packet AND mutate mirror locally before re-render. Subtle 0.7-opacity pulse via `markPending()` map (cleared on server reconcile). `squelchUpdated` event listener rebuilds mirror from fresh server snapshot — server wins on next login. **Bug fix during wiring:** account-row × button previously misrouted via `modifyCharacterSquelch`; now correctly calls `modifyAccountSquelch(..., false, ...)`. Wave I1 limitation comment retired. |
| 19 (polish) | Cast-from-research-panel + stance indicator | **SHIPPED** | Wave L3 part 1 (pure JS). `plugins/spell-research-panel.js` adds double-click handler on each spell row → `client.player.castSpell(spellId, untargeted ? null : targetGuid)` (canonical api.js facade with direct wasm fallback). Stance gate: returns toast "Enter a magic combat stance first." when `__getCurrentStanceLow() === 0`. Untargeted-flag from catalog row drives selection between targeted/untargeted variant. Toast helper (1750ms auto-remove, modeled on social-panel.js). New header stance indicator dot (gold = ready, gray = need stance) refreshed on every render. Each row gets `title="Double-click to cast"`. Console log `[research/cast] spellId=N untargeted=bool target=0xNNNN`. |
| Discord follow-on | Compass mini-radar | **SHIPPED** | Wave L3 part 2 (pure JS). `plugins/compass-hud.js` adds 200×40 mini-radar strip below the compass tape. DOM-based 30-dot pool (recycled per rAF tick). Reads `entityMap` per frame, projects each entity's AC-frame `(x=east, y=north)` delta into screen-X via forward axis `(sin(yaw), cos(yaw))` + right vector `(cos(yaw), -sin(yaw))`. Distance maps to Y (closer = lower); alpha attenuates by `(1 - dist/MAX_RADAR_RANGE)` with 0.15 floor. Behind-camera entities clipped. Per-category colors: creature/monster red `#ff4040`, npc/vendor green `#40d060`, player white `#ffffff`. Items/containers/statics skipped. `?compassRadar=off` URL knob; `?compass=off` disables both tape + radar. New `window.__compassHud.setRadarVisible(bool)` runtime toggle. |

**Files touched this wave:**
- `src/lib.rs` +200 LOC (L1: 4 wasm methods + 4 SessionCommand + 4 recv arms)
- `crates/holtburger-protocol/src/opcodes.rs` +16 LOC (4 uncomments)
- `crates/holtburger-protocol/src/messages/mod.rs` +1 LOC (register house/)
- `crates/holtburger-protocol/src/messages/house/{mod,actions}.rs` NEW + 4 round-trip tests
- `crates/holtburger-protocol/src/messages/game_action.rs` +37 LOC (4 variants + arms)
- `plugins/house-panel.js` NEW 376 LOC (L1)
- `plugins/social-panel.js` +187 -29 (L2 speculative mirror)
- `plugins/spell-research-panel.js` +122 LOC (L3 cast + stance dot + toast)
- `plugins/compass-hud.js` +216 LOC (L3 radar strip + dot pool)
- `index.html` +1 LOC (L1 house-panel import)

`cargo check --target wasm32-unknown-unknown -p holtburger-web` clean (exactly 18 pre-existing warnings, no new ones). `cargo test -p holtburger-protocol --lib`: **280/280 PASS** (L1 added 4 round-trips). `node --check` clean on all JS.

**Recommended Wave M** (next priorities):
1. **House receive-side snapshot (#22 finish)** — `HouseData 0x0225`, `HouseProfile 0x021D`, `HouseStatus 0x0226` events + JS state display.
2. **House guest perms + storage perms + boot (#22 polish)** — 8+ remaining commented opcodes (AddPermanentGuest, BootSpecificHouseGuest, storage permissions, etc.).
3. **Allegiance approved-vassal + officer-titles + ListBans receive (#4 final)** — 8 remaining commented opcodes.
4. **Component table extraction (#19 polish)** — extend `data/spell-components.json` beyond scarabs to cover all 60+ retail components.
5. **House picker UX (#22 polish)** — replace L1's manual GUID/item-list inputs with a List-Available-Houses dropdown + inventory item-picker.
6. **Radar polish (Discord follow-on)** — add bearing labels (compass-relative angle) on hover for radar dots.

---

## Status — Wave K executed 2026-05-25 (3-agent parallelism)

| # | Item | Status | Notes |
|---|------|--------|-------|
| 21 (finish) | Object inscription on Examine (non-book) | **SHIPPED** | Wave K1. Adds `#[wasm_bindgen(js_name = getObjectInscription)] pub fn get_object_inscription(&self, guid: u32) -> Option<String>` to `SessionHandle`. **Architectural discovery:** SessionHandle has NO `world` field — `WorldState` lives entirely inside the recv-loop's `tokio::select!` body. Every world-derived getter on the handle reads from a snapshot cell that the recv-loop populates. Agent added `latest_inscriptions: Rc<RefCell<HashMap<u32, String>>>` mirroring `latest_container_contents` exactly: alloc in `start_session`, threaded into `recv_loop`, populated inline in the existing `WorldEvent::EntityIdentified` arm (same site that already extracts `AppraisalPortalDestination`). No new helper fn, no kind=N event, no ClientEvent — synchronous on-demand getter mirroring `playerBurden()`. `plugins/examine-target.js` cascade step 2 (previously "reserved") now calls `handle.getObjectInscription(g)` + wraps with `ownedByPlayer` from `getItemByGuid`. The J3-era cascade is now fully wired for items/weapons/scrolls. |
| 4 (polish) | Lock-action cycle UX dropdown | **SHIPPED** | Wave K2 (pure JS). `plugins/allegiance-panel.js` replaces J1's hardcoded `LOCK_ON=2` button with a `<select>` dropdown + "Confirm Lock Action" button. 6 options pulled from `~/ace-server/Source/ACE.Entity/Enum/AllegianceLockAction.cs`: Off=1 / On=2 (default) / Toggle=3 / Check=4 / CheckApproved=5 / ClearApproved=6. New `ALLEGIANCE_LOCK_ACTIONS` constant block. No confirm-dialog (selecting the action IS the confirmation). Dropdown styling matches Wave I1 title `<select>` from social-panel.js. |
| 19 | Spell Research panel | **SHIPPED** | Wave K3 (pure JS). NEW `plugins/spell-research-panel.js` (~660 LOC = ~200 JS + ~195 CSS + scaffolding). Floating panel ~440×500 top-center. Subscribes to `playerStatsUpdated`, reads `handle.playerKnownSpells()`, cross-references `data/spells-catalog.json` for name/school/level/untargeted/mana/icon/desc/duration/components per spell. Filter strip: School dropdown (All/War/Life/Item/Creature/Void) + Level dropdown (All/I-VIII) + name-substring search. Sorted school→level→name. Component-name lookup reuses `data/spell-components.json` via a ~20-LOC local-copy of `spellbook.js:127-151` `loadComponentNames`/`resolveComponentName` helpers (avoids spellbook mount-side-effects). Click row to expand description in-place. Empty states: "No spells learned. Learn a spell tome to research." (zero known) + "No spells match the current filter." (filtered). Debug hooks: `window.__openSpellResearchPanel()` + `window.__closeSpellResearchPanel()`. Yonneh-quoted research-style view from #openai-gpt-3 finally has a home. |

**Files touched this wave:**
- `src/lib.rs` +57 LOC (K1: latest_inscriptions Rc + 1 wasm getter + recv-loop populate in existing EntityIdentified arm)
- `plugins/allegiance-panel.js` +78 -18 (K2 dropdown + enum constant + CSS rule)
- `plugins/examine-target.js` +12 (K1 cascade step 2 + comment update)
- `plugins/spell-research-panel.js` NEW ~660 LOC (K3)
- `index.html` +1 LOC (K3 import line)

`cargo check --target wasm32-unknown-unknown -p holtburger-web` clean (exactly 18 pre-existing warnings, no new ones). `cargo test -p holtburger-protocol --lib`: **276/276 PASS**. `node --check` clean on all JS.

**Recommended Wave L** (next priorities):
1. **Allegiance approved-vassal + officer-titles + ListBans receive (#4 final)** — 8 remaining commented opcodes.
2. **House system MVP (#22)** — Buy/Rent/Abandon/Guest perms/Teleport/Hooks; all opcodes commented.
3. **Speculative squelch list refresh (#20 polish)** — client-side fold of Modify*Squelch acks (flagged in I1).
4. **Component table extraction (#19 polish)** — extend `data/spell-components.json` beyond scarabs to cover all 60+ retail components for full Spell Research panel display.
5. **Cast-from-research-panel (#19 polish)** — wire double-click on a spell row to invoke `handle.castSpell(id, targetGuid)` if armed.
6. **Compass mini-map (Discord follow-on)** — extend Wave E3 compass HUD with a small radar of nearby entities.

---

## Status — Wave J executed 2026-05-25 (3-agent parallelism)

Three more items shipped. All 3 agents fired in a single message with disjoint file scopes.

| # | Item | Status | Notes |
|---|------|--------|-------|
| 4 (bans/boot/lock) | Allegiance moderation suite | **SHIPPED (send-only)** | Wave J1. 4 opcodes uncommented (`AddAllegianceBan 0x02A1`, `RemoveAllegianceBan 0x02A2`, `BreakAllegianceBoot 0x0277`, `DoAllegianceLockAction 0x003F`). 4 new structs in `player/actions.rs` (all by-name + bool flags). **ACE wire deviations caught:** BreakAllegianceBoot's `account_boot` is u32 on wire (not bool — mirrors AllegianceChatGag pattern); DoAllegianceLockAction takes the full `AllegianceLockAction` enum (Off=1/On=2/Toggle=3/Check=4/CheckApproved=5/ClearApproved=6 per `~/ace-server/.../Enum/AllegianceLockAction.cs`) — agent chose `LOCK_ON=2` over the spec's "just pass 1". 4 GameAction variants + arms. 4 wasm methods (`addAllegianceBan/removeAllegianceBan/breakAllegianceBoot/doAllegianceLockAction`) + 4 SessionCommand + 4 recv arms with `[allegiance/add-ban|remove-ban|boot|lock]` logs. Panel now has **10 standalone buttons** (Swear/Break + F1's MOTD/Officer/Gag/Recall + J1's AddBan/RemoveBan/Boot/Lock). Still deferred: approved-vassal, officer-titles, ListBans (receive). |
| 23 (Trade) | Radial menu Trade entry | **SHIPPED** | Wave J2 (pure JS). `plugins/radial-menu.js` adds Trade entry between Drop and Attack. **Player capability detection:** primary path is `window.__wom.get(guid)?.canonicalObjectClass === "Player"` via the Chorizite-port WorldObjectManager (runs `canonicalClassify(itemType, objDescFlags, weenieFlags)` on every kind=1 spawn — same algorithm retail `acclient.exe` uses with ODF_PLAYER at PASS 2). Defensive fallback to `ent.meta.objDescFlags & 0x08` (added `ODF_PLAYER = 0x00000008` const). Self-guard via `guid !== window.getLocalPlayerGuid?.() >>> 0`. `openTrade` wasm-method existence check. Final menu has 6 contextual entries: Examine → Wield → Use → Drop → Trade → Attack. Wave I2's "Trade still pending" comment retired. |
| 21 (polish) | Inscription display on Examine | **SHIPPED (book-side cross-ref)** | Wave J3 (pure JS). `plugins/examine-target.js` adds an italic-gold-on-parchment "Inscription" section appended to the scrollable body (`.hb-exa-body`). **Data source priority:** (1) `handle.playerBook()` if `objectGuid` matches examined guid (book inscriptions); (2) reserved `InventoryItem.inscription` — NOT IMPLEMENTED. **Important agent finding:** `InventoryItem` in `src/lib.rs:13924-13934` does NOT expose an `inscription` field today (only guid/wcid/name/iconId/itemType/value/stackSize/equipMask/containerId). The cascade is wired to extend cleanly when a future Rust wave adds the wasm getter. "Set Inscription" button renders only when `getItemByGuid(g)` returns truthy (item in `playerInventory()`); click → `window.prompt("New inscription:", current)` → `handle.setInscription(guid, next)` (Wave F2 wasm method). Subscribes to `bookUpdated` + `playerInventoryChanged` for live refresh. |

**Files touched this wave:**
- `src/lib.rs` +195 LOC (J1: 4 wasm methods + 4 SessionCommand + 4 recv arms)
- `crates/holtburger-protocol/src/opcodes.rs` +16 LOC (4 uncomments)
- `crates/holtburger-protocol/src/messages/player/actions.rs` +91 LOC (4 new structs)
- `crates/holtburger-protocol/src/messages/game_action.rs` +36 LOC (4 enum variants + arms)
- `plugins/allegiance-panel.js` +142 LOC (J1 4 standalone-IIFE buttons + AllegianceLockAction enum comment)
- `plugins/radial-menu.js` +33 LOC (J2 Trade entry + ODF_PLAYER const + isPlayer helper)
- `plugins/examine-target.js` +133 LOC (J3 inscription section + Set button + event subscribe)

`cargo check --target wasm32-unknown-unknown -p holtburger-web` clean (exactly 18 pre-existing warnings, no new ones). `cargo test -p holtburger-protocol --lib`: **276/276 PASS**. `node --check` clean on all JS.

**Recommended Wave K** (next priorities):
1. **InventoryItem.inscription wasm getter (#21 finish)** — adds the field to `InventoryItem` struct + getter so J3's reserved cascade lights up for non-book items.
2. **Allegiance approved-vassal + officer-titles + ListBans receive (#4 final)** — closes the remaining 8 commented allegiance opcodes (AllegianceChatBoot 0x02A0, SetAllegianceApprovedVassal 0x0040, SetAllegianceOfficerTitle 0x003C, ListAllegianceOfficerTitles 0x003D, ClearAllegianceOfficerTitles 0x003E, ListAllegianceBans 0x02A3, RemoveAllegianceOfficer 0x02A5, ClearAllegianceOfficers 0x02A7).
3. **House system MVP (#22)** — Buy/Rent/Abandon/Guest perms/Teleport/Hooks; all opcodes commented.
4. **Spell research / component management UI (#19)** — needs new wasm `playerSpellComponents()` getter + JS panel.
5. **Speculative squelch list refresh (#20 polish)** — client-side fold of Modify*Squelch acks (flagged in I1).
6. **Lock-action cycle UX (#4 polish)** — replace J1's hardcoded `LOCK_ON=2` with a dropdown picking from the full AllegianceLockAction enum (Off/On/Toggle/Check/CheckApproved/ClearApproved).

---

## Status — Wave I executed 2026-05-25 (later same day, true 3-agent parallelism)

First wave where all 3 agents truly ran in parallel (single message, disjoint file scopes). Total wall-clock ~700s instead of the sequential ~1300s.

| # | Item | Status | Notes |
|---|------|--------|-------|
| 20 (finish-finish) | Squelch DB + Title catalog receive snapshots | **SHIPPED** | Wave I1. Uncommented 3 S2C opcodes (`SetSquelchDb 0x01F4`, `CharacterTitle 0x0029`, `UpdateTitle 0x002B`). NEW `crates/holtburger-protocol/src/messages/squelch/{mod,events}.rs` + `title/{mod,events}.rs` with 3 new round-trip tests. **ACE wire authority:** `SquelchDB.cs:158-197` + `SquelchInfo.cs:52-64` (PackableHashTable<u32, SquelchInfo> with 32-bucket sort, 4× repeated SquelchMask filters, account-bool flag); `GameEventCharacterTitle.cs:10-18` (`const=1, current_title_id, num_titles, title_id[]`); `GameEventUpdateTitle.cs:10-11` (`title_id, set_as_display`). Snapshot infras mirror Wave H1 friends pattern: `SquelchSnapshot` + `TitleSnapshot` Rc fields + 2 publish helpers + 3 recv-loop arms + 2 ClientEvent kinds (`SQUELCH_UPDATED=27`, `TITLE_UPDATED=28`) + `player_squelch/player_title` getters. JS: 2 index.html dispatch arms; social-panel.js gains "Squelched (N)" list section with [A]-badge for account-squelches + × remove, and Title section's text input replaced with `<select>` populated from snapshot.title_ids (active title marked "(current)"). UpdateTitle folds in-place (appends if absent, promotes to current_title_id if set_as_display=true). 276/276 protocol tests pass. |
| 23 (Drop/Wield) | Radial menu Drop/Wield entries | **SHIPPED** | Wave I2 (pure JS). `plugins/radial-menu.js` adds 2 new contextual entries using G1's wasm methods. **Display order:** Examine → Wield → Use → Drop → Attack. **Gating:** Wield shown only when item is in pack (`isInPack` via `playerInventory()` cross-ref — 3D entity meta lacks `equipMask` reliably); Drop shown whenever item is owned (allows drop from equipped slot — ACE handles unequip+drop sequence per retail UX). Slot mask sourced from `ent.meta.equipMask` if present, else 0 server-default. The B3-era comment `// follow-on: Drop/Wield/Trade once wasm exports land` updated to "Drop/Wield wired via Wave G1 wasm methods; Trade still pending". Trade entry deferred to Wave J (target capability check is more involved — Player vs NPC discrimination). |
| 15 (deep dispose) | LRU deep dispose at bake sites | **SHIPPED** | Wave I3 (pure JS). Tags per-LB disposables at 3 remaining bake sites so `landblock_lru.js` releases GPU VBOs instead of only JS-heap. **Per-file findings:** `buildings.js` — confirmed **zero per-LB disposables** (all geometries via `opts.bakeCache` cross-LB, materials via `materialCache.getCached`). `statics.js` — per-LB owned: `geomByModel` + `degradedGeomByModel` fused BufferGeometries (no cross-LB cache in the lazy baker path); ring-driver InstancedMesh path explicitly skipped (intentional cross-LB batching per existing comments). `cells.js` — **biggest GPU-VBO release win**: every cell's per-surface `g.geometry` from `meshToGeometryGroups` + optional `?envcellFusion=1` fused per-cell geometry + per-DID `staticGeomByDid` cell-static fused geometries. At Academy with 568 cells/LB averaging a few surface meshes each, ~1500-3000+ BufferGeometries per LB now releasable. `scene3d/index.js` threads new return-shape through 3 lazy-load wrappers; terrain hook untouched per spec (already correct from H3). |

**Files touched this wave:**
- `src/lib.rs` +317 LOC (I1: squelch + title snapshot infras + 3 recv arms + 2 ClientEvent kinds + 2 getters)
- `crates/holtburger-protocol/src/opcodes.rs` +12 LOC (3 uncomments)
- `crates/holtburger-protocol/src/messages/mod.rs` +2 LOC (register squelch + title modules)
- `crates/holtburger-protocol/src/messages/squelch/{mod,events}.rs` NEW + 1 round-trip test
- `crates/holtburger-protocol/src/messages/title/{mod,events}.rs` NEW + 2 round-trip tests
- `crates/holtburger-protocol/src/messages/game_event.rs` +29 LOC (3 variants + arms)
- `plugins/radial-menu.js` +45 LOC (Drop/Wield entries + reorder)
- `plugins/social-panel.js` +266 LOC (squelch list + title dropdown)
- `scene3d/buildings.js` +8 LOC (empty-array tagging documents audit)
- `scene3d/cells.js` +26 LOC (per-cell geometry tagging)
- `scene3d/statics.js` +21 LOC (per-LB fused geometry tagging)
- `scene3d/index.js` +98 LOC -69 (3 lazy-load wrapper rewrites for disposable threading)
- `index.html` +19 LOC (kind=27/28 dispatch arms + minor)

`cargo check --target wasm32-unknown-unknown -p holtburger-web` clean (exactly 18 pre-existing warnings, no new ones). `cargo test -p holtburger-protocol --lib`: **276/276 PASS** (I1 added 3 round-trip tests). `node --check` clean on all JS.

**Recommended Wave J** (next priorities):
1. **Allegiance bans/boots/lock-action/approved-vassal/officer-titles (#4 finish)** — 12 commented opcodes; same per-opcode shape as Wave F1.
2. **House system MVP (#22)** — Buy/Rent/Abandon/Guest perms/Teleport/Hooks; all opcodes commented. Mirror Wave C2 fellowship send-side MVP shape.
3. **Spell research / component management UI (#19)** — needs new wasm `playerSpellComponents()` getter + JS panel.
4. **Trade radial-menu entry (#23 final polish)** — extends Wave I2 with player-vs-NPC capability gating + `handle.openTrade(targetGuid)`.
5. **Read-only inscription display on examine (#21 polish)** — extends Wave A3 examine panel with the `inscription` field from `BookSnapshot` (or just `Identify` response for non-book items).
6. **Squelch list refresh after Modify (#20 polish)** — `social-panel.js` flagged that ACE doesn't re-push SetSquelchDb after the C2S round-trip; client could speculatively fold the delta locally for instant feedback.

---

## Status — Wave H executed 2026-05-25 (later same day)

Three items shipped after Wave G. H1 ran solo (then H2 + H3 ran together — H2 Rust+JS on social-panel, H3 pure JS on scene3d).

| # | Item | Status | Notes |
|---|------|--------|-------|
| 20 (receive) | Friends list receive-side snapshot | **SHIPPED** | Wave H1. Uncommented `FriendsListUpdate 0x0021` event opcode. NEW `crates/holtburger-protocol/src/messages/friends/{mod.rs, events.rs}` (~225 LOC + 3 round-trip tests) with full ACE-wire-conformant `FriendsListUpdateEventData { friends: Vec<FriendEntry>, update_type: u32 }` and `FriendEntry { friend_id, is_online (u32 on wire), appear_offline (u32 on wire), name (string16L), their_friends: Vec<Guid>, inverse_friends: Vec<Guid> }`. Wire authority: `~/ace-server/Source/ACE.Server/Network/GameEvent/Events/GameEventFriendsListUpdate.cs:60-100`. Their-friends + inverse loops parsed and round-tripped even though ACE writes them as 0 today (future-proof against server change). Rust: `FriendsSnapshot/View` + JS wrappers + `latest_friends` Rc + `publish_player_friends_snapshot` folds by update_type semantics (FullList=replace, Added=upsert, Removed=filter, StatusChanged=in-place mutate) + `CLIENT_EVENT_KIND_FRIENDS_UPDATED=26` + `player_friends()` getter. JS: kind=26 dispatch in index.html; `plugins/social-panel.js` Friends List section with header "Friends (N)" + scrollable rows (online green dot / offline gray + name + × Remove). |
| 20 (finish) | Titles + Account/Global squelch send-side | **SHIPPED** | Wave H2. Uncommented 3 opcodes (`ModifyAccountSquelch 0x0059`, `ModifyGlobalSquelch 0x005B`, `TitleSet 0x002C`). 3 new structs in `player/actions.rs`. **ACE wire deviation:** brief speculated `ModifyAccountSquelchActionData` had `message_type` — ACE wire actually only has `(bool_u32, string16L)`. Agent caught + corrected the struct shape; the JS facade accepts a messageType param for API uniformity but drops it before packing. `ModifyGlobalSquelchActionData { add: bool, message_type: u32 }`. `TitleSetActionData { title_id: u32 }`. 3 GameAction variants + arms. 3 wasm methods (`modifyAccountSquelch/modifyGlobalSquelch/setTitle`) + 3 SessionCommand + 3 recv arms. social-panel.js gains 3 new sections (Account Squelch input + Squelch/Unsquelch buttons, Global Squelch 2-button row, Title input + Set Title). Title catalog list-display deferred to Wave I. |
| 15 | Landblock LRU unload (memory time bomb) | **SHIPPED** | Wave H3 (pure JS). NEW `scene3d/landblock_lru.js` (~290 LOC) — `LandblockLRU` class with `Map<lbId, { container, lastTouchMs, geometries[], materials[], textures[] }>`, `track/touch/tickEviction/evict/dispose/getStats` methods. Default `?lbCap=169` matches today's behavior (no eviction). `?lbCap=N` enables LRU; `?lbLruDebug=1` logs evictions. **Safety:** Current LB + 3×3 ring NEVER evicted (Chebyshev > 1 filter); `__cacheOwned`-tagged shared resources never disposed (wire-mode materials, MaterialCache surfaces, atlas textures, statics InstancedMesh nodes, building bake-cache geometries). Disposed per-LB: terrain ShaderMaterial + BufferGeometry + vertexTypesTexture. Initial 13×13 ring bulk-tracked at LRU init. Idempotency sets (`terrainBakedLbs/buildingsBakedLbs/staticsBakedLbs/envCellLoadedLbs`) cleared on evict so re-entry rebakes. `terrainMaterials` registry pruned so loop.js doesn't push uniforms onto disposed materials. **Partial:** Building placement Groups, statics singleton Mesh/LOD nodes, EnvCell containers are container-remove-only (JS-heap GCs but GPU VBOs persist until Three.js's own LRU evicts them) — documented in source header. Deeper disposal would require `__disposable` tagging at the 4 bake sites (Wave I or later). |

**Files touched this wave:**
- `src/lib.rs` +366 LOC (H1: FriendsSnapshot infra + H2: 3 wasm methods + 3 SessionCommand + 3 recv arms)
- `crates/holtburger-protocol/src/opcodes.rs` +16 LOC (4 uncomments: FriendsListUpdate + ModifyAccount/Global Squelch + TitleSet)
- `crates/holtburger-protocol/src/messages/mod.rs` +1 LOC (register friends/)
- `crates/holtburger-protocol/src/messages/friends/{mod,events}.rs` NEW ~225 LOC + 3 round-trip tests
- `crates/holtburger-protocol/src/messages/game_event.rs` +10 LOC (FriendsListUpdate variant + arms)
- `crates/holtburger-protocol/src/messages/game_action.rs` +27 LOC (3 H2 variants + arms)
- `crates/holtburger-protocol/src/messages/player/actions.rs` +81 LOC (3 H2 structs)
- `plugins/social-panel.js` +276 LOC (H1 Friends List + H2 3 sections)
- `scene3d/landblock_lru.js` NEW ~290 LOC
- `scene3d/index.js` +167 LOC (LRU construction + bake-site track() wrappers + per-frame tick)
- `index.html` +13 LOC (H1 kind=26 dispatch arm)

`cargo check --target wasm32-unknown-unknown -p holtburger-web` clean (exactly 18 pre-existing warnings, no new ones). `cargo test -p holtburger-protocol --lib`: **273/273 PASS** (H1 added 3 round-trip tests).  `node --check` clean on all JS.

**Recommended Wave I** (next priorities):
1. **Squelch DB receive-side snapshot (#20 finish)** — `SetSquelchDb 0x01F4` S2C event; server pushes full squelch DB on login. Snapshot + JS display.
2. **Title catalog snapshot (#20 polish)** — `CharacterTitleTable` / `AddOrSetCharacterTitle` events + JS title-picker dropdown.
3. **Allegiance bans/boots/lock-action/approved-vassal/officer-titles (#4 finish)** — 12 commented opcodes; same per-opcode shape as Wave F1.
4. **House system MVP (#22)** — Buy/Rent/Abandon/Guest perms/Teleport/Hooks; all opcodes commented.
5. **Spell research / component management UI (#19)** — needs new wasm exports + JS panel.
6. **Landblock LRU deep dispose (#15 polish)** — `__disposable` tagging at 4 bake sites for full GPU resource release.

---

## Status — Wave G executed 2026-05-25 (later same day)

Three items shipped after Wave F. G1 + G3 ran in parallel (G1 Rust+JS, G3 pure JS — turned out to be URL-knob work since the cloud-shadow shader was already wired). G2 ran sequentially after G1.

| # | Item | Status | Notes |
|---|------|--------|-------|
| 10 (finish) | Equipment paper-doll burden + drag-drop | **SHIPPED** | Wave G1. Rust: `LatestStats.burden: f32` field + `publish_player_stats_snapshot` computes burden via `WorldContextExt::player_burden()` + `#[wasm_bindgen(getter, js_name = playerBurden)]` returning f32 (0.0 pre-spawn, 0..1 typical, >1 over-encumbered). 2 send-side wasm methods (`wieldFromPack(item_guid, equip_mask)` + `dropItem(item_guid)`) + 2 SessionCommand variants + 2 recv arms. Opcodes `GetAndWieldItem 0x001A` + `DropItem 0x001B` + their structs/GameAction variants/pack/unpack arms were already in place from a prior wave — no protocol-crate work needed (4 hex-fixture tests already cover them). JS: `plugins/inventory.js` burden bar live-fills from `playerBurden` getter on `playerStatsUpdated` event with cream≤50% / gold 50-90% / red >90% / solid red >100% gradient. Paperdoll drag-drop bidirectional — equipped slots become drag sources via `application/x-hb-inv-guid` mime (compatible with Wave D2 trade-panel + vendor-ui); drop on `#canvas` calls `dropItem(guid)`; drop on paperdoll slot calls `wieldFromPack(guid, slotEquipMask)` with brass highlight on `dragenter`. **ACE wire conformance:** `GetAndWieldItem.cs` { itemGuid, equipMask } + `DropItem.cs` { itemGuid } — exact match, no deviations. |
| 4 (receive-side MVP) | Allegiance receive-side snapshot | **SHIPPED** | Wave G2. Uncommented `AllegianceUpdate 0x0020` event opcode. **NEW** `crates/holtburger-protocol/src/messages/allegiance/{mod.rs, events.rs}` (~420 LOC + 2 round-trip tests) with full ACE-wire-conformant `AllegianceUpdateEventData` capturing `rank/total_members/total_vassals + AllegianceProfile + AllegianceHierarchy` (officers PackableHashTable, titles list, motd, motd_set_by, chat_room_id, bindPoint Position, allegiance_name, name_last_set_time, is_locked, approved_vassal, monarch_data, tree_parent-keyed records list — full `AllegianceData` per record: character_id, cp_cached, cp_tithed, bitfield, gender, heritage_group, rank, packed level, loyalty, leadership, time_online, allegiance_age, name). Wire authority: `~/ace-server/Source/ACE.Server/Network/GameEvent/Events/GameEventAllegianceUpdate.cs` + `AllegianceProfile.cs` + `AllegianceHierarchy.cs` + `AllegianceData.cs`. Bit-for-bit pack/unpack symmetry verified via 2 round-trip tests (4-member tree + empty). Rust: `AllegianceSnapshot/Member` Rust + `AllegianceSnapshotJs/MemberJs` wrappers; `latest_allegiance: Rc<RefCell<Option<AllegianceSnapshot>>>`; **publish-source:** folds directly from GameEvent payload since `WorldEvent::AllegianceUpdated` doesn't exist in `holtburger-world` (own_guid from `world.player.guid`, tree-parent topology splits records into patron/self/vassals); `CLIENT_EVENT_KIND_ALLEGIANCE_UPDATED=25`; `SessionHandle::player_allegiance()` getter. JS: `index.html` kind=25 dispatch arm emits `allegianceUpdated`; `plugins/allegiance-panel.js` standalone IIFE replaces "coming in a future wave" placeholder with live 4-line state mini-view; main-panel view renders into existing layout-anchored regions (header + monarch/patron/status/vassal-list rows). Empty state: "Not in an allegiance. Use Swear above to join one." Bans/officer-titles/AllegianceInfoResponse still deferred. |
| 14 (cloud-shadow knobs) | Cloud shadow on terrain — knob exposure | **SHIPPED** | Wave G3. **Recon discovery:** Cloud shadows on terrain were ALREADY SHIPPED as "Clouds-L" — takram-three-clouds' built-in cascaded shadow buffers are routed into `terrain.js:706-718` via `uCloudShadowMap` / `uCloudShadowMatrix0..3` / `uCloudShadowStrength` uniforms with Beer-Lambert sampling `max(0.3, exp(-density * strength))`. Per-frame push from `cloud_overlay.js:511` → `cloud_volume._pushCloudShadowsToTerrain()`. A duplicate top-down projection module would have caused conflicting writes. **What G3 shipped instead:** the 3 URL knobs the task required, which were genuinely missing — `?cloudShadow=on\|off` (gates the per-frame pusher), `?cloudShadowStrength=N` (0..10), `?cloudShadowRes=N` (64..2048, takram reallocates cascade buffers). Runtime durable setters `window.__setCloudShadowStrength(n)` + new `window.__setCloudShadowEnabled(bool)`. +73 / -3 across `scene3d/cloud_volume.js` + `scene3d/index.js`. Zero touch of terrain.js (shader already correct) — saves per-frame texture-ref+matrix-copy across all LBs when `?cloudShadow=off`. |

**Files touched this wave:**
- `src/lib.rs` +461 LOC (G1: ~143 + G2: ~280 — burden field + 3 wasm methods + AllegianceSnapshot infra + getter)
- `crates/holtburger-protocol/src/opcodes.rs` +4 LOC (1 uncomment + light tidy)
- `crates/holtburger-protocol/src/messages/mod.rs` +1 LOC (register allegiance module)
- `crates/holtburger-protocol/src/messages/game_event.rs` +10 LOC (AllegianceUpdate variant + arms)
- `crates/holtburger-protocol/src/messages/allegiance/mod.rs` NEW
- `crates/holtburger-protocol/src/messages/allegiance/events.rs` NEW ~420 LOC + 2 tests
- `plugins/inventory.js` +153 LOC (G1 burden + drag-drop)
- `plugins/allegiance-panel.js` +245 LOC (G2 state render + subscribe)
- `scene3d/cloud_volume.js` +35 LOC (G3 push gate + strength override + setters)
- `scene3d/index.js` +37 LOC (G3 URL-knob parsing)
- `index.html` +12 LOC (G2 kind=25 dispatch arm + minor)

`cargo check --target wasm32-unknown-unknown -p holtburger-web` clean (exactly 18 pre-existing warnings, no new ones). `cargo test -p holtburger-protocol --lib`: **270/270 PASS** (G2 added 2 new round-trip tests). `node --check` clean on all JS.

**Recommended Wave H** (next priorities):
1. **Friends receive-side snapshot (#20 polish)** — `FriendsUpdate` event + snapshot; mirrors Wave G2 allegiance receive pattern.
2. **Allegiance bans/boots/lock-action/approved-vassal/officer-titles (#4 finish)** — 12 commented opcodes; same per-opcode shape as Wave F1.
3. **Titles + Account/Global squelch (#20 finish)** — `TitleSet 0x002C` + `ModifyAccountSquelch` + `ModifyGlobalSquelch` + `SetSquelchDb`.
4. **House system (#22)** — Buy/Rent/Abandon/Guest perms/Teleport/Hooks; all opcodes commented.
5. **Spell research / component management UI (#19)** — Yonneh-quoted; spellbook + components parser exists.
6. **BloomEffect (★★★★★ in OPTICAL_EFFECTS_HANDOFF)** — soft HDR halo, ~1-2ms @ 1080p; wire to EffectPass pre-ToneMapping.

---

## Status — Wave F executed 2026-05-25 (later same day)

Three more items shipped after Wave E. F1 + F3 ran in parallel (F1 Rust+JS, F3 pure JS). F2 ran sequentially after F1 since both edit `src/lib.rs` + protocol-crate files.

| # | Item | Status | Notes |
|---|------|--------|-------|
| 4 (officer/MOTD/gag/recall) | Allegiance polish | **SHIPPED** | Wave F1. 4 opcodes uncommented (`SetAllegianceName 0x0033`, `SetAllegianceOfficer 0x003B`, `AllegianceChatGag 0x0041`, `RecallAllegianceHometown 0x02AB`); 4 new message structs in `crates/holtburger-protocol/src/messages/player/actions.rs` with wire format authored against `~/ace-server/Source/ACE.Server/Network/GameAction/Actions/GameActionSet*.cs`; 4 GameAction enum variants + 4 wasm methods (`setAllegianceName/setAllegianceOfficer/allegianceChatGag/recallAllegianceHometown`) + 4 SessionCommand + 4 recv arms. `plugins/allegiance-panel.js` standalone IIFE now has 6 buttons: original Swear/Break + new MOTD-row (text input + Confirm), Promote-Selected-to-Officer, Toggle-Chat-Gag-for-Selected, Recall-to-Hometown. **ACE wire deviation:** chat-gag's `gag_on` is `u32` on the wire (mirrors `ModifyCharacterSquelch`), not `bool`. Bans / boots / lock-action / approved-vassal / officer-title (12 more) still deferred to Wave G. |
| 21 | Books + Inscriptions | **SHIPPED** | Wave F2. 8 opcodes uncommented (5 C2S: `BookData/BookAddPage/BookModifyPage/BookDeletePage/SetInscription`; 3 S2C: `BookModifyPageResponse/BookAddPageResponse/BookDeletePageResponse`). 5 new C2S action structs + 3 new S2C event structs in `crates/holtburger-protocol/src/messages/book/{actions,events}.rs`. **ACE wire deviation:** `BookModifyPage` does NOT carry `ignore_author` on the wire — ACE re-reads it server-side from the book entity. The JS-facade keeps the arg for forward-compat but drops it before send. 5 wasm methods + 5 SessionCommand + 5 send recv arms. Receive-side: `BookSnapshot` + `BookPageView` + JS wrappers; `latest_book: Rc<RefCell<Option<BookSnapshot>>>`; `publish_player_book_snapshot()` folds via existing `WorldEvent::EntityBookUpdated` (handlers/inventory.rs already maintains `entity.book` from `BookDataResponse+BookPageDataResponse`); `CLIENT_EVENT_KIND_BOOK_UPDATED=24`. Page-mod responses push kind=24 directly so JS triggers re-fetch. `SessionHandle::player_book()` getter. NEW `plugins/book-panel.js` — 320×340 floating overlay; inscription strip + Set button (prompt); page navigator (◀ Page N of M ▶, disabled at ends); textarea read-only→edit toggle on Edit/Save; Add Page + Delete Page (with confirm) footer; AC parchment styling (`#2a1f15` bg, `#f0e8d0` text). Debug: `window.__openBookFor(guid)`. |
| 14 + ad-hoc | Sky aurora storm + cell-bug parity flag | **SHIPPED** | Wave F3 (pure JS). **(14) Aurora ribbons:** NEW `scene3d/weather/aurora.js` (~170 LOC) — `AuroraSystem` class with `THREE.InstancedMesh` of up to 120 vertical 80×6m quads on a `RING_RADIUS=400m` ring around the camera; alpha gradient baked into vertex colors (top=1.0, bottom=0.02); additive blending; `renderOrder=940` (sky-attached). Per-ribbon azimuth/wobble/color phases for shimmer + green↔magenta cycle (`COLOR_CYCLE_PERIOD=30s`, green-biased via `pow(raw, 2.2) * 0.7`). Vertical wobble ±2m / 5s. `WeatherEffectsManager` integration: forced=1.0 via `?aurora=on`, storm-only=0.6 (`weather_state.is_storm=true`), off via `?aurora=off`. **(ad-hoc) Cross-cell parity flag:** `scene3d/cells.js` adds `CELL_BUG_PARITY` const + 1-line short-circuit in `tickCellVisibility3D` — `?cellBugParity=retail` keeps loaded `userData.isEnvCell` indoor cells visible regardless of player's current cell, matching retail's basement-from-overworld quirk per #worldbuilder 2026-04-10 ("try and match client bugs so you know what's wonky"). |

**Files touched this wave:**
- `src/lib.rs` +682 LOC (F1: ~310 + F2: ~370 — 9 wasm methods total + 9 SessionCommand + 9 send recv arms + BookSnapshot infra + 4 event recv arms + getter)
- `crates/holtburger-protocol/src/opcodes.rs` +49 LOC (12 opcodes uncommented + light tidying)
- `crates/holtburger-protocol/src/messages/player/actions.rs` +92 LOC (4 new allegiance structs)
- `crates/holtburger-protocol/src/messages/book/actions.rs` +116 LOC (5 new C2S structs)
- `crates/holtburger-protocol/src/messages/book/events.rs` +78 LOC (3 new S2C structs)
- `crates/holtburger-protocol/src/messages/game_action.rs` +81 LOC (9 GameAction variants + arms)
- `crates/holtburger-protocol/src/messages/game_event.rs` +27 LOC (3 GameEvent variants + arms)
- `plugins/allegiance-panel.js` +127 LOC (F1 standalone-IIFE expansion)
- `plugins/book-panel.js` NEW ~450 LOC (F2)
- `scene3d/weather/aurora.js` NEW ~170 LOC (F3)
- `scene3d/weather/manager.js` +31 LOC (F3 wire-up)
- `scene3d/cells.js` +15 LOC (F3 parity flag)
- `index.html` +10 LOC (book-panel import + kind=24 dispatch + minor)

`cargo check --target wasm32-unknown-unknown -p holtburger-web` clean (exactly 18 pre-existing warnings, no new ones). `cargo test -p holtburger-protocol --lib` 268/268 PASS. `node --check` clean on all JS.

**Recommended Wave G** (next priorities):
1. **Allegiance bans/boots/lock-action/approved-vassal/officer-titles (#4 finish)** — 12 commented opcodes; same per-opcode shape as F1.
2. **Allegiance + Friends receive-side snapshot (#4, #20 polish)** — `AllegianceUpdate`/`AllegianceInfoResponse`/`FriendsUpdate` events → snapshot infra mirroring Wave D1 fellowship pattern.
3. **Titles + Account/Global squelch (#20 finish)** — TitleSet 0x002C + ModifyAccountSquelch + ModifyGlobalSquelch + SetSquelchDb.
4. **Equipment paper-doll burden % + drag-drop (#10 finish)** — needs `playerBurden()` wasm getter + `DropItem` + `GetAndWieldItem` exports.
5. **House system (#22)** — Buy/Rent/Abandon/Guest perms/Teleport/Hooks; all opcodes commented. Similar shape to allegiance/fellowship.
6. **Spell research / component management UI (#19)** — Yonneh-quoted; parser exists, panel doesn't.

---

## Status — Wave E executed 2026-05-25 (later same day)

Three more items shipped after Wave D. E1 + E3 ran in parallel (E1 = Rust+JS, E3 = pure JS). E2 ran sequentially after E1 since both edit `src/lib.rs`.

| # | Item | Status | Notes |
|---|------|--------|-------|
| 4 | Allegiance system | **SHIPPED (send-only MVP)** | Wave E1. Rust: 2 wasm-bindgen methods (`swearAllegiance(targetGuid)`, `breakAllegiance(targetGuid)`) + 2 SessionCommand variants + 2 recv-loop arms mapping to existing `GameAction::SwearAllegiance/BreakAllegiance` (structs `SwearAllegianceActionData`/`BreakAllegianceActionData` were already in `crates/holtburger-protocol/src/messages/player/actions.rs:161+`). JS: `plugins/allegiance-panel.js` already existed as a main-panel view; appended a 246-LOC standalone IIFE with `__openAllegiancePanel()`/`__closeAllegiancePanel()` exposing Swear/Break action buttons that consume `getSelectedTarget()` with confirm dialogs. Manifest version bumped 0.2.0 → 0.3.0. **Officer/MOTD/bans/gag/hometown-recall opcodes (18 more, currently commented) deferred to Wave F.** |
| 20 | Friends + Squelch | **SHIPPED (send-only MVP)** | Wave E2. Uncommented 3 opcodes (AddFriend 0x0018, RemoveFriend 0x0017, ModifyCharacterSquelch 0x0058). Created 3 new message structs in `crates/holtburger-protocol/src/messages/player/actions.rs` — `AddFriendActionData { friend_name: String }`, `RemoveFriendActionData { friend_guid: Guid }`, `ModifyCharacterSquelchActionData { add: bool, target_guid: Guid, target_name: String, message_type: u32 }`. **Wire-format authority for squelch came from `~/ace-server/Source/ACE.Server/Network/GameAction/Actions/GameActionModifyCharacterSquelch.cs`** — ACE reads 4 fields in this order (add/playerGuid/playerName/messageType) — the agent caught the discrepancy with my prompt's 3-field shape and ported the canonical 4-field shape. AddFriend by-name + RemoveFriend by-guid confirmed against ACE handlers. 3 wasm methods + 3 SessionCommand + 3 recv arms. New `plugins/social-panel.js` (~340 LOC IIFE) — Friends section (text input + Add, Remove-by-Selected) + Squelch section (Squelch/Unsquelch Selected, all-chat-types mask `0xFFFFFFFF`). **Titles, Account-squelch, Global-squelch deferred to Wave F.** `cargo test -p holtburger-protocol --lib` → 268/268 PASS. |
| 11+16+ad-hoc | Visual polish bundle (Z-buffer + nameplate LOD + compass HUD) | **SHIPPED** | Wave E3 (pure JS). **(11) Reversed Z-buffer:** added `logarithmicDepthBuffer: true` to the `THREE.WebGLRenderer` constructor options at `scene3d/index.js:375` — one-key change, Three.js handles depth-test internals. Distant terrain z-fight fix without manual reverse-Z post-pass. **(16) Nameplate distance LOD:** `scene3d/nameplate_sprite.js` adds `tickNameplateLod` + `disposeNameplateLod` + self-managed rAF; URL knobs `?nameplateRange=N` (default 40m), `?nameplateMax=N` (default 30); local player guid always exempt via `window.getLocalPlayerGuid()`. Distance² from each nameplate's `matrixWorld[12..14]` to active camera position; sort + keep N nearest. **(ad-hoc) Compass HUD:** new `plugins/compass-hud.js` (226 LOC) — 200×16 top-center tape-scrolling compass with N/NE/E/SE/S/SW/W/NW labels + 15° minor + 45° diag ticks + gold cursor; reads `liveScene3d.cameraSwitcher.followYaw` per rAF; `?compass=off` knob; AC-aesthetic via existing CSS vars. |

**Files touched this wave:**
- `src/lib.rs` +263 LOC (E1: 2 wasm methods + E2: 3 wasm methods + 5 SessionCommand variants + 5 recv arms)
- `crates/holtburger-protocol/src/opcodes.rs` +12 LOC (3 uncommented opcodes)
- `crates/holtburger-protocol/src/messages/game_action.rs` +27 LOC (3 GameAction variants + 3 unpack + 3 pack arms)
- `crates/holtburger-protocol/src/messages/player/actions.rs` +83 LOC (3 new ActionData structs + pack/unpack)
- `plugins/allegiance-panel.js` +249 LOC (E1 standalone IIFE)
- `plugins/social-panel.js` NEW 340 LOC (E2)
- `plugins/compass-hud.js` NEW 226 LOC (E3)
- `scene3d/index.js` +1 LOC (E3 renderer flag)
- `scene3d/nameplate_sprite.js` +140 LOC (E3 LOD)
- `index.html` +2 LOC (social + compass imports)

`cargo check --target wasm32-unknown-unknown -p holtburger-web` clean (exactly 18 pre-existing warnings, no new ones). `cargo test -p holtburger-protocol --lib` 268/268 PASS. `node --check` clean on all JS.

**Recon discovery:** SwearAllegiance/BreakAllegiance had FULL protocol structs + GameAction enum variants already in place — E1 was just wasm bindings + panel work. Significantly smaller than budgeted.

**Recommended Wave F** (next priorities):
1. **Allegiance officer/MOTD/bans/gag/hometown-recall (#4 polish)** — 18 commented opcodes; each needs a small struct + GameAction variant + wasm method + panel button.
2. **Titles + Account-squelch + Global-squelch (#20 polish)** — TitleSet, ModifyAccountSquelch, ModifyGlobalSquelch, SetSquelchDb.
3. **Allegiance receive-side snapshot (#4)** — `AllegianceUpdate`/`AllegianceInfoResponse` events + snapshot infra mirroring Wave D1 fellowship pattern.
4. **Friends list snapshot (#20)** — `FriendsUpdate`/`CharacterTitleTable` events + snapshot.
5. **Equipment paper-doll burden % + drag-drop (#10 finish)** — `playerBurden()` wasm getter + `DropItem` + `GetAndWieldItem` exports.
6. **Inscriptions + books (#21)** — Writing GameAction handlers exist in ACE; UI is the new piece.

---

## Status — Wave D executed 2026-05-25 (later same day)

Three more items shipped after Wave C. D1 + D3 ran in parallel (disjoint files); D2 ran sequentially after D1 since both touched `src/lib.rs`.

| # | Item | Status | Notes |
|---|------|--------|-------|
| 5 (full) | Fellowship receive-side snapshot + member-list panel | **SHIPPED** | Wave D1. Rust: `FellowshipSnapshot` + `FellowshipMember/Departed/LockEntry` structs + `#[wasm_bindgen]` JS wrappers (`FellowshipSnapshotJs` etc.); `latest_fellowship: Rc<RefCell<Option<FellowshipSnapshot>>>` next to `latest_enchantments`; `publish_player_fellowship_snapshot()` mirroring the enchantment helper; `CLIENT_EVENT_KIND_FELLOWSHIP_UPDATED = 22`; recv-loop binding via existing `WorldEvent::FellowshipStateUpdated` (already maintained by `crates/holtburger-world/src/handlers/fellowship.rs` for the 5 fellowship events — DRY win); `SessionHandle::player_fellowship() -> Option<FellowshipSnapshotJs>` getter. JS: `index.html` kind=22 dispatch arm emitting `fellowshipUpdated`; `plugins/fellowship-panel.js` placeholder replaced with `fetchFellowshipSnapshot()` + `renderFellowshipState()` + subscription on `fellowshipUpdated`, both the standalone panel and main-panel gmFellowshipUI 0x21000030 view now render Alone ↔ InFellowship subtrees with leader marker + 3 vital bars (HP red / Stamina gold / Mana blue) per row. |
| 3 | Trade system multi-step UI | **SHIPPED** | Wave D2. Rust: 6 wasm-bindgen send methods (`openTrade/closeTrade/addToTrade/acceptTrade/declineTrade/resetTrade`) + 6 `SessionCommand` variants + 6 send recv arms; `TradeSnapshot { partner_guid, partner_name, my_items, partner_items, my_accepted, partner_accepted, is_open }` + `TradeItem { guid, name, icon_id, stack_size }` with JS wrappers; `publish_player_trade_snapshot()` using existing `WorldEvent::TradeStateUpdated` (canonical world.trade maintained at `crates/holtburger-world/src/handlers/trade.rs` across all 9 trade events); `CLIENT_EVENT_KIND_TRADE_UPDATED = 23`; `SessionHandle::player_trade()` getter. JS: `plugins/trade-panel.js` NEW (593 LOC) — 360×280 floating window, two 4×3 12-slot grids ("You" / partner), Accept/Decline/Reset footer, partner-accept green dot indicator, self-accept gold highlight, drag-drop from inventory (mime `application/x-hb-inv-guid`, source: `inventory.js:734`), Esc/X close. `index.html` import + kind=23 dispatch arm. Debug: `window.__openTradePanel()`. |
| 10 (icons) | Equipment paper-doll real icons | **SHIPPED** | Wave D3. Pure JS — `plugins/inventory.js` adds module-level `iconCache: Map` + `fetchPaperdollIconDataUrl(iconId)` helper mirroring `buffs-hud.js:73-105`. `placeEquippedInDoll` now: (a) tags slot el with `dataset.itemGuid` first, (b) paints TYPE_COLOR fallback instantly, (c) async-fetches real DAT icon via `item.iconId` → canvas → dataURL, (d) re-verifies guid hasn't changed before assignment (race-safe against rapid equip swaps). `clearPaperdoll` also clears the dataset + background. Each equipped slot now shows the real DAT sprite (sword, helmet, etc.) instead of solid-color placeholder. Items grid kept on TYPE_COLOR for this wave (out of scope). |

**Files touched this wave:**
- `src/lib.rs` +875 LOC (D1: ~345 + D2: ~530 — both snapshot infras + send methods + recv arms + getters)
- `plugins/fellowship-panel.js` +395 LOC -38 (D1)
- `plugins/inventory.js` +47 LOC (D3)
- `plugins/trade-panel.js` NEW 593 LOC (D2)
- `index.html` +23 LOC (D1 kind=22 arm + D2 kind=23 arm + D2 import line)

`cargo check --target wasm32-unknown-unknown -p holtburger-web` clean (exactly 18 pre-existing warnings, no new ones). `node --check` clean on all JS.

**Recommended Wave E** (next priorities):
1. **Allegiance panel + officer/motd opcodes (#4)** — `SwearAllegiance/BreakAllegiance` live; 18 more commented (officer/motd/bans/gag/hometown-recall). Mirror Wave C2 send-side + D1 snapshot pattern.
2. **Friends + Squelch + Titles (#20)** — all opcodes commented; same shape as above.
3. **Equipment paper-doll burden % + drag-drop (#10 polish)** — need `playerBurden()` wasm getter + `DropItem` + `GetAndWieldItem` exports.
4. **Inscriptions + books (#21)** — Writing GameAction handlers exist in ACE; UI is the new piece.
5. **Reversed Z-buffer (#11)** — one-line `logarithmicDepthBuffer: true` on `THREE.WebGLRenderer` — try first; full reverse-Z if insufficient.

---

## Status — Wave C executed 2026-05-25 (later same day)

Three more items shipped after Wave B. Each agent owned disjoint file scope so the three ran in parallel without merge conflicts.

| # | Item | Status | Notes |
|---|------|--------|-------|
| 10 (subset) | Container browse panel | **SHIPPED** | `plugins/container-panel.js` NEW (~400 LOC). Subscribes to existing `containerOpened` bus event (kind=21 from `index.html:8083`, wired PR-HH 2026-05-23). Resolves item GUIDs via `playerInventory()` then `entityMap.meta` fallback. 280×220 floating panel top-right, 6-col 36×36 icon grid via `fetch_surface_pixels`, click-to-Examine using Wave A3's `__showExamineFor`. Esc/close/click-outside dismiss. Debug hook: `window.__openContainerFor(guid, name?)`. Right-click slot reserved for future take-from-container wasm export (TODO comment). |
| 5 (send-side) | Fellowship action panel + wasm methods | **SHIPPED (send-only MVP)** | Rust: 6 new `SessionHandle` wasm-bindgen methods (`fellowshipCreate/Quit/Dismiss/Recruit/UpdateRequest/AssignNewLeader`) — opcodes 0x00A2-0x00A6 + 0x0290. Message structs already lived in `crates/holtburger-protocol/src/messages/fellowship/actions.rs` (15/15 hex-fixture tests PASS). JS: `plugins/fellowship-panel.js` augmented in place — existing retail gmFellowshipUI 0x21000030 main-panel view buttons (Recruit/Disband/Leave/Pass-Leader/Quit) wired to the new methods; new standalone floating panel (`window.__openFellowshipPanel()`) with 6-action 2-col grid (Create + Share-XP form, Quit/Recruit/Dismiss/Assign-Leader, Toggle-Updates aria-pressed). "Fellowship state — coming in Wave D" placeholder below grid (snapshot infra + member-list display + per-event ClientEvent kind deferred to Wave D). |
| 12 | Weather rain + lightning + thunder | **SHIPPED** | `scene3d/weather/rain.js` NEW — `RainSystem` using `THREE.InstancedMesh` of 6000 bluish-white quad streaks in a camera-locked cylinder (R=25m, H=30m), toroidal wrap, wind drift, ~12 m/s fall. `scene3d/weather/lightning.js` NEW — `LightningSystem` with standalone `THREE.DirectionalLight` (separate from atmosphere SunLight to not fight the bake), Poisson trigger `P(strike)=λ·dt`, 3-pulse triangular envelope [4,2,6] over 280ms, audio delay derived from random "fake distance" 200m-1.7km / speed-of-sound for retail-feel thunder timing. `scene3d/weather/manager.js` NEW — `WeatherEffectsManager` ties both systems to `getWeatherState().is_storm`. URL knobs: `?rain=on\|off`, `?lightning=on\|off`, `?thunderDid=0xXX`. `scene3d/index.js` integration: manager registered after audioManager (line ~2756) + ticked in rAF loop before ambientRuntime (line ~1435). Debug: `window.__weatherEffects.flashNow()`. |

**Files touched this wave:**
- `src/lib.rs` +297 LOC Rust (6 wasm methods + 6 SessionCommand variants + 6 recv-loop arms)
- `plugins/fellowship-panel.js` +474, -14 LOC
- `plugins/container-panel.js` NEW ~400 LOC
- `scene3d/weather/rain.js` NEW 154 LOC
- `scene3d/weather/lightning.js` NEW 157 LOC
- `scene3d/weather/manager.js` NEW 87 LOC
- `scene3d/index.js` +46 LOC (import + construct + tick)
- `index.html` +1 LOC (container-panel import; fellowship-panel already imported)

`cargo check --target wasm32-unknown-unknown -p holtburger-web` clean (exactly 18 pre-existing warnings, no new ones). `node --check` clean on all JS files. C1 + C2 cleanup: 3 dead-code variables removed (`openContainerGuid`, `invokeDismiss`, `updatesBtn`).

**Discovery during recon:** the deficiency report's "Equipment paper-doll NOT YET IMPLEMENTED" claim was stale — `plugins/inventory.js:67-101` already has the full retail-correct `PAPERDOLL_SLOTS` table (23 slots, element IDs from gmPaperDollUI 0x21000024, equipMask-bit dispatch) with `placeEquippedInDoll()` rendering via `playerInventory()`. The real remaining inventory gap was container browse (kind=21 fires but no UI consumer) — repointed C1 to that.

**Recommended Wave D** (next priorities):
1. **Fellowship receive-side snapshot infra (#5 full)** — `latest_fellowship: Rc<RefCell<Option<FellowshipSnapshot>>>` + per-event publishers on FellowshipFullUpdate/UpdateFellow/UpdateDone/StatsDone + new `CLIENT_EVENT_KIND_FELLOWSHIP_UPDATED=22` + JS bus emit + panel member-list rendering. Replaces the "coming in Wave D" placeholder.
2. **Equipment paper-doll polish (#10 finish)** — burden meter % computation (sum equipped weights / capacity), real sprite icons (today TYPE_COLOR squares), drag-drop FROM paperdoll → ground and TO paperdoll from pack (needs `DropItem` + `GetAndWieldItem` wasm exports).
3. **Trade system multi-step UI (#3)** — opcodes live (`OpenTradeNegotiations` through `AcceptTrade`), wasm methods missing. Pattern: identical to fellowship send-side MVP we just shipped.
4. **Allegiance panel (#4)** — `SwearAllegiance/BreakAllegiance` opcodes live; 18 more (officer/motd/bans/gag/hometown-recall) commented out. Same send-only MVP pattern.

---

## Status — Wave B executed 2026-05-25 (later same day)

Three more items shipped after Wave A:

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | Sequence-Manager validation per packet group | **SHIPPED (observability MVP)** | Wave B2 added per-(opcode, target) seq tracking in `src/lib.rs` recv_loop. Helper `check_sequence_gap()` (4-state: first/ok/gap/duplicate/stale) gated behind `?seqDebug=1` URL knob; LRU-evicted at 4096 entries; emits `console.warn` `[seq-gap] opcode=0xXX target=0xXX last=N got=N kind=...`. **Log-only — no drop/queue/reorder.** This gives observability without risking false-positive gating. Discord evidence: gmriggs #tool-dev 2026-03-19 silent PropertyInt.Level reverts. `cargo check` clean (no new warnings). |
| 8 | Chat-channel infrastructure | **SHIPPED (granularity + opacity slice)** | Wave B1 split the consolidated `Channels` tab in `plugins/chat-panel.js` into 3 retail-meaningful buckets: **Chan** (cat-3, 12-15, 22-23), **Alleg** (cat-17 only), **Fell** (cat-16 only). 4 tabs → 6 in a horizontal strip above the chat log (derivative of retail's 4-edge filter buttons 0x10000522-0x10000525, documented in source). Per-panel opacity-on-mouseout via `?chatFade=1` URL knob (persisted in `hb_chat_panel_fade` localStorage) — 0.45 at rest, 1.0 on hover, 150ms in / 300ms out. Discord evidence: #general 1752-1755 "3 diff windows transparent for allegiance, general, local… goes opaque on mouseover". |
| 23 | Right-click radial menu (full) | **SHIPPED (Examine + Use + Attack MVP)** | Wave B3 replaced Wave A3's direct-invoke Examine with `plugins/radial-menu.js` — a retail-styled vertical context menu (AC's actual "radial" was list-style internally per acclient.c convention). Entries are contextual: **Examine** always; **Use** if `__sessionHandle.useObject` exists; **Attack** if entity is a Creature AND a combat stance is active. Keyboard nav (arrows + Enter), Esc/outside-click/right-click cancellation, viewport-edge auto-flip. `scene3d/camera.js:468-486` swapped to invoke `window.__openRadialMenuFor(guid, clientX, clientY)` with `__showExamineFor` fallback for defensive plugin-not-loaded scenarios. `index.html:984` imports the plugin. **Drop/Wield/Trade gated on future wasm exports** (commented in source) — kept out of the MVP entry list since wiring dead entries would mislead. |

**Files touched this wave:** `src/lib.rs` (+187 LOC Rust), `plugins/chat-panel.js` (+82, -63 LOC), `scene3d/camera.js` (+7 LOC), `plugins/radial-menu.js` (NEW 250 LOC), `index.html` (+1 LOC import). `cargo check` clean; `node --check` clean on all JS.

**Recommended Wave C** (next priorities by Discord impact × Holtburger leverage):
1. **Equipment paper-doll + container browse (#10)** — Phase K follow-on; gameplay-completeness; vendor-ui drag-drop pattern is the template.
2. **Allegiance/Fellowship/Friends panels (#4, #5, #20)** — now that chat has Alleg/Fell tabs, the panels are the natural next step; opcodes 0x001D/0x001E/SwearAllegiance + Fellowship opcodes already live in opcodes.rs.
3. **Trade system multi-step UI (#3)** — opcodes live, no UI; multi-packet handshake.
4. **Weather: rain particles + lightning flash (#12)** — visual polish; `weather_state.js` infra exists, particle layer + Wave (0x0A) sound queue.

---

## Status — Wave A executed 2026-05-25

Three items from this report were addressed in a single team-agent wave on the same day this report was written.

| # | Item | Status | Notes |
|---|------|--------|-------|
| 2 | EnchantmentChanged bus event + buffs-debuffs HUD | **RESOLVED (already shipped, doc was stale)** | `holtburger-web-inventory.md` said buffs-hud was "blocked on kind=11 EnchantmentChanged". Recon found PR-JJ 2026-05-23 had already wired the path through `kind=8 playerStatsUpdated`: the wasm `recv_loop` calls `publish_player_enchantments_snapshot()` on every `PlayerEnchantmentsUpdated`, JS reads via `handle.playerEnchantments()`. The original inventory bullet was wrong. No code change. |
| 9 | Identify panel UI on right-click Examine | **SHIPPED** | Panel itself (`plugins/examine-target.js`) was already retail-correct using `gmFloatyExaminationUI 0x2100006B` layout; the *trigger* was missing. Wave A3 added right-click drag-threshold disambiguation in `scene3d/camera.js`: right-click + small movement (5px²) on an entity now opens Examine via `window.__showExamineFor(guid)`. Right-click + drag preserves camera orbit. Manual validation: right-click on a creature → main-panel opens to Examine view. |
| 23 | Right-click radial menus (subset) | **PARTIALLY ADDRESSED** | Direct-invoke Examine on right-click is the MVP slice. Radial menu with Use/Drop/Wield/Trade still pending — promoted to its own Wave B item. |
| 26 | Swing-pose classifier wiring | **SHIPPED** | Wave A1 added `EntityManager.setSwingMotion(guid, motionCmd)` to `scene3d/entities.js:1820`. Uses already-shipped `classifyMotionCommandTyped` (52/52 PASS) + `AnimationCache` to fetch the real link clip from `links[(stance, Ready)]` per `swing-classification-spec-2026-05-19.md`, plays as LoopOnce with `clampWhenFinished=true`, restores Ready cycle on completion. Falls back to `setSwingPose` vibe-tween on classifier miss / non-human rig / wasm not ready. `picking.js:434` seam was already wired to prefer `setSwingMotion` over `setSwingPose`. |

**Files touched this wave:** `scene3d/entities.js`, `scene3d/camera.js`. JS-only — no Rust rebuild needed. `node --check` clean on both files. Pre-existing lint warnings unchanged.

**Next wave (Wave B) candidates by Discord impact × leverage:**
1. **Chat-channel infrastructure (#8)** — Discord's most-quoted #general topic; unblocks Allegiance/Fellowship/Friends panel content.
2. **Sequence-manager validation (#1)** — silent failure mode today; gmriggs flagged property reverts.
3. **Right-click radial menu (#23 finish)** — Use/Drop/Wield/Trade for the right-click that Wave A3 set up.

---

## TL;DR

The Discord corpus skews **gameplay-systems heavy** (trade, allegiance, fellowship, chat, identify, salvage, suit builder) while Holtburger has invested almost all bandwidth into **rendering/world fidelity + a small combat loop**. The widest gap is **social/gameplay surface**: 154 opcodes are commented-out stubs in `opcodes.rs` against 186 live ones — Chorizite ACProtocol covers 66 GameActions + 46 GameEvents and ACE has handlers for nearly all. Holtburger's render stack is competitive with (and in places ahead of) Chorizite/ACME, but a player can't *trade*, *form a fellowship*, *swear an allegiance*, *appraise an item*, *equip armor*, *read a book*, *open a chest*, *use a friend list*, *toggle a chat channel*, or *see their own buffs/debuffs*. None of those are "stretch" features in the Discord corpus — they're the daily verbs.

Beyond that, **three subtle hazards** turn up across multiple channels that we haven't addressed:
1. **Sequence-manager gaps cause silent property reverts** (gmriggs, tool-dev 2026-03-19) — our wasm `pollEntityUpdates()` drain doesn't appear to validate sequence types per-group.
2. **Out-of-bounds = local-event-stream kick** (merklejerk, alt-clients 2026-03-28) — our cell-visibility BFS doesn't surface a `kind=? OutOfBounds` event; a void teleport would just look like a stuck client.
3. **Cross-cell portal collision unfinished** (notan DM, 2026-05-20) — our cells render, but a player walking *through* a portal has no collision-shape interpolation; this is the next gameplay-blocking bug to ship into.

The **good news**: Holtburger's 3D render stack (Bruneton sky, takram clouds, terrain detail-normal, ECEF altitude correction, audio HRTF, CSM, motion-pose 52/52, jump 1000/1000, DAT 906/906, wire 24/24) is *more validated and more visually capable* than any other alt-client discussed in the corpus. The deficiencies are not in what we built; they are in what we haven't started.

---

## Critical Gaps (Tier 1 — load-bearing, multi-channel Discord evidence)

### 1. Sequence-Manager validation per packet group — SHIPPED 2026-05-25 (Wave B2, observability)
**Severity:** load-bearing
**Discord evidence:**
> "sequence types…if client detects gaps…will refuse to process" — gmriggs, #tool-dev 2026-03-19
> "PropertyInt.Level would remain at previous level due to incorrect sequences" — gmriggs, #tool-dev 2026-03-19

**Holtburger status:** `scene3d/loop.js:drainEntityEvents3D()` drains all wasm events FIFO each frame; nothing in the inventory shows per-property-group sequence validation. If a `PlayerStatsUpdated` (kind=8) arrives out-of-order relative to a previous one, we'd silently apply stale data.
**Upstream:** ACE `SequenceManager.GetSequence`; Chorizite `NetworkParser` enforces ordering per group.
**Remediation:** Mirror ACE's `SequenceManager` in `holtburger-protocol/src/messages/`; gate `client.events.emit('playerStatsUpdated')` on monotonic seq per (group, target).

### 2. EnchantmentChanged / UpdateEnchantment / RemoveEnchantment bus event — RESOLVED 2026-05-25
**Severity:** load-bearing
**Discord evidence:**
> "LayeredSpellId different from spellid…multiple instances of same spell via layer" — #general line 764
> "check layeredspellid against active enchantments" — #general line 825
> "buff that buffs item variance" — #general line 1964

**Holtburger status:** **Actually already shipped per PR-JJ 2026-05-23 — the inventory bullet was stale.** `recv_loop` in `src/lib.rs:17854` calls `publish_player_enchantments_snapshot()` on every `PlayerEnchantmentsUpdated`; the `kind=8 playerStatsUpdated` drain is the (intentionally coalesced) carrier. `plugins/buffs-hud.js:351-389` subscribes to `playerStatsUpdated`, refetches via `handle.playerEnchantments()`, classifies buff vs debuff via name-keyword heuristic, displays icons fetched from `fetch_surface_pixels`. No code change required.
**Remediation:** None. Closed as already-shipped.

### 3. Trade system (multi-step handshake) — SHIPPED 2026-05-25 (Wave D2)
**Severity:** load-bearing
**Discord evidence:**
> "trying desperately to make trade windows look more like inventory panel and not be infinite scrolling list" — #general line 6121
> blode working on multirow listbox — #general line 8580

**Holtburger status:** Wave D2 shipped 6 `SessionHandle` wasm-bindgen methods (`openTrade/closeTrade/addToTrade/acceptTrade/declineTrade/resetTrade`) + `TradeSnapshot`/`TradeItem` Rust structs + JS wrappers + `publish_player_trade_snapshot()` via existing `WorldEvent::TradeStateUpdated` (canonical `world.trade` already maintained by `crates/holtburger-world/src/handlers/trade.rs` across all 9 trade events) + `CLIENT_EVENT_KIND_TRADE_UPDATED=23` + `player_trade()` getter. `plugins/trade-panel.js` NEW 593 LOC — 360×280 floating window, two 4×3 12-slot grids (You / partner), Accept/Decline/Reset footer, partner-accept green dot + self-accept gold highlight, drag-drop from inventory via mime `application/x-hb-inv-guid`, Esc/X close. Debug: `window.__openTradePanel()`.

### 4. Allegiance system — SHIPPED 2026-05-25 (E1 Swear/Break + F1 MOTD/Officer/Gag/Recall + G2 receive snapshot + J1 Bans/Boot/Lock + K2 Lock dropdown)
**Severity:** load-bearing (player-facing core feature)
**Discord evidence:** Multiple "allegiance / fellowship chat" mentions in #general; cascaded transparent chat windows for allegiance specifically (line 1752).
**Holtburger status:**
- **Wave E1 (Swear/Break):** 2 wasm-bindgen methods (`swearAllegiance`, `breakAllegiance`) using existing `SwearAllegianceActionData`/`BreakAllegianceActionData` structs at `crates/holtburger-protocol/src/messages/player/actions.rs:161+`. JS: standalone IIFE with Swear/Break action buttons.
- **Wave F1 (MOTD/Officer/Gag/Recall):** 4 opcodes uncommented (`SetAllegianceName 0x0033`, `SetAllegianceOfficer 0x003B`, `AllegianceChatGag 0x0041`, `RecallAllegianceHometown 0x02AB`). 4 new structs in `player/actions.rs` (wire format per `~/ace-server/.../GameActionSet*.cs`). 4 wasm methods (`setAllegianceName/setAllegianceOfficer/allegianceChatGag/recallAllegianceHometown`). Panel now has 6 buttons: Swear / Break / MOTD-row (text input + Confirm) / Promote-Selected-to-Officer / Toggle-Chat-Gag-for-Selected / Recall-to-Hometown. **ACE wire deviation:** chat-gag's `gag_on` is `u32` on the wire (not bool — mirrors `ModifyCharacterSquelch` pattern).
- **Wave G2 (receive-side snapshot):** Uncommented `AllegianceUpdate 0x0020` event opcode. NEW `crates/holtburger-protocol/src/messages/allegiance/{mod,events}.rs` (~420 LOC + 2 round-trip tests) with full ACE-wire-conformant `AllegianceUpdateEventData` (rank/profile/hierarchy + tree-parent records of full `AllegianceData`). Wire authority: `~/ace-server/.../GameEventAllegianceUpdate.cs` + AllegianceProfile.cs + Hierarchy.cs + Data.cs. `AllegianceSnapshot` + `AllegianceSnapshotJs` wrapper; `latest_allegiance` Rc; `publish_player_allegiance_snapshot` folds directly from GameEvent payload (no `WorldEvent::AllegianceUpdated` exists yet); `CLIENT_EVENT_KIND_ALLEGIANCE_UPDATED=25`; `player_allegiance()` getter. JS subscribes to `allegianceUpdated` bus event and renders monarch/patron/vassal-list (both standalone panel + main-panel view). Empty state: "Not in an allegiance. Use Swear above to join one."
- **Still deferred to Wave H:** 12 commented action opcodes (bans, boots, lock-action, approved-vassal, officer-titles, query-allegiance-name) + secondary receive events (`AllegianceUpdateAborted 0x0003`, `AllegianceAllegianceUpdateDone 0x01C8`, `AllegianceInfoResponse 0x027C`).
**Upstream:** ACE has 30+ handlers in `Source/ACE.Server/Network/GameAction/Actions/` matching the commented-out opcodes.

### 5. Fellowship system — SHIPPED 2026-05-25 (Wave C2 send-side + Wave D1 receive-side full)
**Severity:** load-bearing
**Discord evidence:**
> "VI fellows…clients respond to your commands…but still share vitals and targeting info" — #general line 2788
> "crash to desktop…much more frequently in fellowship…within 10-20mins" — #general line 3979 (memory leak speculation around fellow vitals)

**Holtburger status:**
- **Send-side (Wave C2):** 6 `SessionHandle` wasm-bindgen methods (`fellowshipCreate/Quit/Dismiss/Recruit/UpdateRequest/AssignNewLeader`) wired through `SessionCommand` variants + recv-loop arms to opcodes 0x00A2-0x00A6 + 0x0290. Message structs in `crates/holtburger-protocol/src/messages/fellowship/actions.rs` (15/15 hex-fixture tests PASS). Action buttons in both panels route to wasm.
- **Receive-side (Wave D1):** `FellowshipSnapshot` Rust + `FellowshipSnapshotJs` wasm-bindgen wrapper (mirroring `PlayerEnchantmentJs` pattern); `latest_fellowship: Rc<RefCell<Option<FellowshipSnapshot>>>` next to `latest_enchantments`; `publish_player_fellowship_snapshot()` via existing `WorldEvent::FellowshipStateUpdated` (DRY win — `crates/holtburger-world/src/handlers/fellowship.rs` already maintains `world.fellowship` for all 5 fellowship events); `CLIENT_EVENT_KIND_FELLOWSHIP_UPDATED=22`; `SessionHandle::player_fellowship()` getter. JS: `index.html` kind=22 dispatch arm emits `fellowshipUpdated`; `plugins/fellowship-panel.js` placeholder replaced — both standalone panel AND retail gmFellowshipUI 0x21000030 main-panel view now render Alone ↔ InFellowship subtrees with leader marker + 3 vital bars (HP red / Stamina gold / Mana blue) per member row. `FellowshipChangeOpenness 0x0291` still commented (no current gameplay need).
**Upstream:** ACE FullUpdate/Disband/UpdateFellow/UpdateDone/StatsDone events all flow through unpack → world.fellowship → snapshot publish → JS bus → panel render.

### 6. Cross-cell portal collision (player walking *through* a doorway)
**Severity:** load-bearing
**Discord evidence:**
> "portal transitions…cell transition collisions at the moment, have not even begun on dungeons" — notan DM 2026-05-20 (about WB; same gap applies to us)
> "void teleport" / "/teletome to bring them back" — alt-clients 2026-03-28

**Holtburger status:** `scene3d/cells.js:tickCellVisibility3D()` flips visibility; `scene3d/picking.js` raycasts pickable entities; but there's no continuous collision interpolation as the player crosses a portal poly. The cylinder collider just teleports its frame of reference.
**Upstream:** acclient.c `CPortalPoly` + `CCellPortal` + `CPhysicsObj::transition()` (search 343343+ region).
**Remediation:** Port `CPhysicsObj::transition()` minimum-viable path to `holtburger-world/src/physics/`; gate on `EnvCell.portals[]` adjacency from DRW.

### 7. Out-of-bounds / void event surfacing
**Severity:** load-bearing (silent failure mode today)
**Discord evidence:**
> "server does sort of penalize you for going out of bounds…knocking you out of the local event stream" — merklejerk, #alt-clients 2026-03-28

**Holtburger status:** Nothing in `loop.js` surfaces an "I just got dropped" signal. If the server stops sending events, the client just goes quiet.
**Remediation:** Wasm-side bus event when no events received for N seconds *and* player position is outside any loaded cell; UI toast "Reconnecting / Out of bounds — server returning you home".

### 8. Chat-channel infrastructure — SHIPPED 2026-05-25 (Wave B1, granularity + opacity slice)
**Severity:** load-bearing (Discord's most-quoted single topic in #general)
**Discord evidence:**
> "The channels are just hard-coded in the client" — #general line 117
> "3 diff windows transparent for allegiance, general, local…goes opaque on mouseover" — #general lines 1752-1755
> "Massticles Lua plugin for custom chat" — #general line 1758

**Holtburger status:** `plugins/chat-panel.js` (DOM-side, legacy 2D integration; the inventory notes it's not yet integrated into the 3D path). No per-channel windows, no channel toggle. `ChatChannel = 0x0147` is live but `AddChannel/RemoveChannel/ListChannels/IndexChannels` are commented out (opcodes.rs:9-12).
**Upstream:** Chorizite categorizes channels under Communication; ACE has `ChannelBroadcast/ChannelList/ChannelIndex/SetSquelchDB`.
**Remediation:** Promote chat-panel.js to a 3D-integrated plugin; add per-channel filter tabs (general / local / allegiance / fellow / friends); wire Squelch (CharacterSquelch/AccountSquelch/GlobalSquelch all commented opcodes.rs:14-16).

### 9. Identify / Appraise panel UI — SHIPPED 2026-05-25 (Wave A3)
**Severity:** load-bearing (no info on hover = unplayable)
**Discord evidence:** Implicit across #general inventory threads; "gearfoundry" scoring mentioned in #alt-clients 2026-03-28.
**Holtburger status:** Panel `plugins/examine-target.js` was already retail-correct (uses `gmFloatyExaminationUI 0x2100006B` layout, native creature pane 0x10000153 with header + 2 stat rows + scrollable body + footer + icons + section dividers, AC font/colors via `ui/ac_font.js`). Wasm auto-fires `GameAction::IdentifyObject` on every ObjectCreate; response populates `EntityMap`. **What was missing:** the trigger. Wave A3 added right-click drag-threshold disambiguation in `scene3d/camera.js:428-478` — right-click + small movement (5px²) on an entity routes to `window.__showExamineFor(guid)`; right-click + drag still orbits camera. Manual validation: right-click a creature → main-panel opens to Examine view.
**Remediation:** Closed. Radial menu (Use/Drop/Wield/Trade) follow-on tracked at #23.

### 10. Equipment paper-doll + container browse — SHIPPED 2026-05-25 (recon-corrected + Wave C1 container + Wave D3 real icons + Wave G1 burden/drag-drop finish)
**Severity:** load-bearing
**Discord evidence:** Suit builder workflows (#general lines 282, 462, 490); MagSuitBuilder discussion; the entire alt-client meta orbits item slot management.
**Holtburger status:**
- **Equipment paper-doll (Wave D3 icons + G1 burden/drag-drop):** `plugins/inventory.js:67-101` has the full retail `PAPERDOLL_SLOTS` table (23 slots, element IDs from gmPaperDollUI 0x21000024, equipMask-bit dispatch). Wave D3 added `iconCache` + `fetchPaperdollIconDataUrl` async DAT icon fetch with race-safe `dataset.itemGuid` re-verify. **Wave G1 finish:** `#[wasm_bindgen(getter, js_name = playerBurden)]` returning f32 (0..1 typical, >1 over-encumbered) via `WorldContextExt::player_burden()`; live burden bar fills on `playerStatsUpdated` event (cream≤50% / gold 50-90% / red >90% / solid red >100%). Bidirectional drag-drop: equipped slots become drag sources via `application/x-hb-inv-guid` mime (compatible with Wave D2 trade-panel + vendor-ui); drop on `#canvas` → `dropItem(guid)`; drop on paperdoll slot → `wieldFromPack(guid, slotEquipMask)` with brass highlight on `dragenter`. ACE wire conformance: `GetAndWieldItem.cs` { itemGuid, equipMask } + `DropItem.cs` { itemGuid } — exact match.
- **Container browse (Wave C1):** `plugins/container-panel.js` (~400 LOC). Subscribes to `containerOpened` bus event (kind=21 from `index.html:8083`, PR-HH 2026-05-23). Resolves contents via `getContainerContents()` → `playerInventory()` lookup with `entityMap.meta` fallback. 280×220 floating panel, 6-col 36×36 icon grid via `fetch_surface_pixels`, click-to-Examine, Esc/close/click-outside dismiss. Debug: `window.__openContainerFor(guid, name?)`. Right-click reserved for future take-from-container wasm export.

---

## High-Impact Visual / Rendering Deficiencies (Tier 2)

### 11. Reversed Z-buffer for distant precision — SHIPPED 2026-05-25 (Wave E3)
**Discord:** "does wb use a reversed z-buffer? that would help with precision for distant objects, reducing flickering" — #worldbuilder 2026-03-31
**Holtburger:** Wave E3 added `logarithmicDepthBuffer: true` to the `THREE.WebGLRenderer` constructor options at `scene3d/index.js:375`. One-key change; Three.js handles depth-test internals. Cheap-and-good first move per remediation note. If distant z-fight still surfaces, full reverse-Z post-pass is the next escalation.

### 12. Weather: rain particles + lightning flashes — SHIPPED 2026-05-25 (Wave C3)
**Discord:** "Rain is in already…lightning flashes no, need to debug…sound yes, ambient from terrain" — #worldbuilder 2026-04-13
**Holtburger:** Wave C3 shipped `scene3d/weather/{rain,lightning,manager}.js`. `RainSystem` uses `THREE.InstancedMesh` of 6000 bluish-white quad streaks in a camera-locked cylinder (R=25m, H=30m) with toroidal wrap and wind drift, ~12 m/s fall. `LightningSystem` uses a standalone `THREE.DirectionalLight` (separate from atmosphere SunLight to avoid fighting the Bruneton bake), Poisson trigger `P(strike)=λ·dt`, 3-pulse triangular envelope [4,2,6] over 280ms; thunder delay derived from random "fake distance" 200m-1.7km / speed-of-sound for retail-feel timing. `WeatherEffectsManager` ties both to `getWeatherState().is_storm`. URL knobs: `?rain=on\|off`, `?lightning=on\|off`, `?thunderDid=0xXX`. Debug: `window.__weatherEffects.flashNow()`. Integrated into `scene3d/index.js` rAF tick loop.

### 13. Cross-cell visibility bug parity decision (basement-from-overworld)
**Discord:** "goal of wb to render things bug-free or matched with acclient bugs? — try and match client bugs so you know what's wonky" — #worldbuilder 2026-04-10; "cross-cell basement overworld still visible" — same channel
**Holtburger:** Our cell-visibility BFS is *correct* (only loaded cells render). Retail had a quirk where basements peek through floors. **Decide:** match the bug for visual parity, or be cleaner? Today it's neither documented nor a knob.
**Remediation:** Add `?cellBugParity=retail` flag; document the decision in `docs/`.

### 14. Particle lighting inside skybox effects — SHIPPED 2026-05-25 (Wave F3, aurora variant)
**Discord:** "now with proper lighting particles" — #worldbuilder 2026-04-10; "green light (northern lights?) a texture or color?…particles with gfxobj 0x01001A62" — same
**Holtburger:** Wave F3 shipped NEW `scene3d/weather/aurora.js` (~170 LOC) — `AuroraSystem` class with `THREE.InstancedMesh` of up to 120 vertical 80×6m quads on a `RING_RADIUS=400m` ring around the camera; alpha gradient baked into vertex colors (top=1.0, bottom=0.02); additive blending; `renderOrder=940`. Per-ribbon azimuth/wobble/color phases for shimmer + green↔magenta cycle (`COLOR_CYCLE_PERIOD=30s`, green-biased). Vertical wobble ±2m / 5s. `WeatherEffectsManager` integration: `?aurora=on` = 1.0 intensity always, real `weather_state.is_storm=true` = 0.6 intensity, `?aurora=off` = disabled. Storm-front colored emission also requested in the Discord quote — covered by the F3 aurora + Wave C3 lightning combination.

### 15. Landblock unload (memory time bomb) — SHIPPED 2026-05-25 (Wave H3)
**Discord:** Implicit in #general line 858 "memory leak probably…looted too many corpses" (extended sessions); explicit in our own `INTERACTING_LAYERS_ANALYSIS.md`.
**Holtburger:** Wave H3 shipped NEW `scene3d/landblock_lru.js` (~290 LOC) — `LandblockLRU` class with per-LB disposable tracking. Default `?lbCap=169` matches today's behavior (no eviction); `?lbCap=N` enables LRU + `?lbLruDebug=1` logs evictions. **Safety:** Current LB + 3×3 ring NEVER evicted (Chebyshev > 1 filter); `__cacheOwned`-tagged shared resources (wire-mode materials, MaterialCache surfaces, atlas textures, statics InstancedMesh nodes, building bake-cache geometries) never disposed. Per-LB disposed: terrain ShaderMaterial + BufferGeometry + vertexTypesTexture. Initial 13×13 ring bulk-tracked at LRU init. Idempotency sets cleared on evict so re-entry rebakes. Partial: building Groups + statics + EnvCell containers are container-remove-only — JS-heap GCs but GPU VBOs persist until Three.js's own LRU evicts. Deeper disposal needs `__disposable` tagging at 4 bake sites (Wave I or later).

### 16. Nameplate render budget under crowds — SHIPPED 2026-05-25 (Wave E3)
**Discord:** "NPCS with Nametags…game client freezes" — #general line 285; "UB Nametags.cs L23" — line 7508
**Holtburger:** Wave E3 added `tickNameplateLod` + `disposeNameplateLod` + self-managed rAF in `scene3d/nameplate_sprite.js`. URL knobs `?nameplateRange=N` (default 40m) + `?nameplateMax=N` (default 30). Distance² from each nameplate's `matrixWorld[12..14]` to active camera; sort + keep N nearest visible. Local player always exempt via `window.getLocalPlayerGuid()`. Pooled texture upload + fade-out are future polish — the visibility gate alone fixes the 50-NPC crowd hitch.

---

## Game-Loop Completeness (Tier 3 — gameplay verbs missing)

### 17. Death structured event (#15 in own backlog)
**Discord:** Implicit in combat/PvP threads.
**Holtburger:** "no structured event; text routes to chat only" — own `CHORIZITE_PORTING_PLAN.md`. Means no death animation hook, no respawn flow.

### 18. Selection bus event (#5 in own backlog)
**Discord:** Selection-as-data is foundational for plugins (Discord ISO VTank 2.0 thread, line 4400).
**Holtburger:** Selection lives in `picking.js` local state, not on bus. No plugin can react to "you targeted X".

### 19. Spell research / component table UI — SHIPPED 2026-05-25 (K3 panel + L3 cast/stance + M2 component catalog 163/163)
**Discord:** "nothing special about spell research panel…add taper animations to queue" — #openai-gpt-3, Yonneh 2026-05-22
**Holtburger:** Wave K3 shipped NEW `plugins/spell-research-panel.js` (~660 LOC). Subscribes to `playerStatsUpdated`, reads `handle.playerKnownSpells()`, cross-references bundled `data/spells-catalog.json` for name/school/level/untargeted/mana/icon/desc/duration/components per spell. Filter strip: School (All/War/Life/Item/Creature/Void) + Level (All/I-VIII) + name-substring search. Sorted school→level→name. Component-name lookup reuses `data/spell-components.json` via a ~20-LOC local-copy of `spellbook.js:127-151` helpers (Comp_1-8 scarabs verified; unknown IDs render as `Comp_N` literal — extending the JSON to cover all 60+ retail components is Wave L polish). Click row to expand description inline. Debug: `window.__openSpellResearchPanel()`.

### 20. Squelch / Friends / Titles — SHIPPED 2026-05-25 (E2/H1/H2/I1 send+receive + L2 speculative refresh)
**Discord:** Chat channel filtering and friend lists implicit across #general.
**Holtburger:** Wave E2 uncommented AddFriend 0x0018, RemoveFriend 0x0017, ModifyCharacterSquelch 0x0058 + created 3 message structs in `crates/holtburger-protocol/src/messages/player/actions.rs` (AddFriend by-name, RemoveFriend by-guid, ModifyCharacterSquelch with 4 fields: add/playerGuid/playerName/messageType per `~/ace-server/Source/ACE.Server/Network/GameAction/Actions/GameActionModifyCharacterSquelch.cs`). 3 wasm methods (`addFriend(name)`, `removeFriend(guid)`, `modifyCharacterSquelch(guid, name, add, mask)`). New `plugins/social-panel.js` (~340 LOC) — Friends section (text input + Add, Remove-by-Selected) + Squelch section (Squelch/Unsquelch Selected, all-chat mask `0xFFFFFFFF`). ModifyAccountSquelch 0x0059, ModifyGlobalSquelch 0x005B, TitleSet 0x002C deferred to Wave F. Receive-side FriendsUpdate/CharacterTitleTable snapshot also Wave F.

### 21. Writing system (books, inscriptions, scrolls) — SHIPPED 2026-05-25 (Wave F2 + J3 book cascade + K1 non-book cascade)
**Discord:** Light coverage, but ACE has BookData/AddPage/ModifyPage/DeletePage/Inscribe handlers, Chorizite categorizes under Writing.
**Holtburger:** Wave F2 shipped 8 opcodes uncommented (5 C2S: `BookData/BookAddPage/BookModifyPage/BookDeletePage/SetInscription`; 3 S2C: `BookModifyPageResponse/BookAddPageResponse/BookDeletePageResponse`). 5 new C2S action structs + 3 new S2C event structs in `crates/holtburger-protocol/src/messages/book/{actions,events}.rs`. **ACE wire deviation:** `BookModifyPage` does NOT carry `ignore_author` on the wire — ACE re-reads it server-side from the book entity. 5 wasm methods + receive-side `BookSnapshot` via existing `WorldEvent::EntityBookUpdated` + `CLIENT_EVENT_KIND_BOOK_UPDATED=24` + `player_book()` getter. NEW `plugins/book-panel.js` — 320×340 floating overlay; inscription strip + Set button (prompt); page navigator (◀ Page N of M ▶); read/edit textarea toggle; Add/Delete Page; AC parchment styling. Debug: `window.__openBookFor(guid)`. Read-only inscription display on examine still a polish item — Wave G or later.

### 22. House system — SHIPPED 2026-05-25 (Wave L1 send-only + M1 status receive)
**Discord:** Not directly quoted but ACE has Buy/Rent/Abandon/Guest perms/Teleport/Hooks. Chorizite has full House category.
**Holtburger:** Wave L1 shipped 4 opcodes uncommented (`BuyHouse 0x021C`, `HouseQuery 0x021E`, `AbandonHouse 0x021F`, `RentHouse 0x0221`). NEW `crates/holtburger-protocol/src/messages/house/{mod,actions}.rs` with 4 round-trip tests (Buy w/2 items, Rent empty, Query empty, Abandon empty). Wire authority: ACE `GameActionHouseBuyHouse.cs` + `HouseQuery.cs` + `HouseAbandon.cs` + `HouseRent.cs`. PackableList<u32> for item_guids (count + count×u32). 4 wasm methods + 4 SessionCommand + 4 recv arms. NEW `plugins/house-panel.js` (376 LOC) with 4 stacked sections (Buy/Rent/Query/Abandon) — manual slumlord-GUID + comma-list-of-item-GUIDs inputs; destructive paths gated by confirm. Debug: `window.__openHousePanel()`. **Still deferred:** receive-side (HouseData/HouseProfile/HouseStatus), guest perms, storage perms, BootGuest, ListAvailableHouses, SetOpenHouseStatus, allegiance-guest-permission (8+ commented opcodes).

### 23. Right-click radial menus (Examine/Drop/Use/Trade/Identify) — SHIPPED 2026-05-25 (B3 Examine+Use+Attack + I2 Drop+Wield + J2 Trade)
**Discord:** Implicit in plugin discussions; the only fast-path for in-3D interaction.
**Holtburger:** Wave A3 added drag-threshold direct-invoke Examine; Wave B3 promoted that into a full retail-styled vertical context menu via `plugins/radial-menu.js`. Contextual entries: Examine (always) / Use (if wasm export exists) / Attack (creature + combat-stance). Keyboard nav (arrows + Enter), Esc/outside-click/right-click cancel, viewport-edge auto-flip. Drop/Wield/Trade entries gated on future wasm exports (commented in source for the next-wave author).

### 24. Salvage operations + Mana queries
**Discord:** "vtank won't salvage…but /vt testitem shows items" — #general line 2263; "/ub autosalvage force" workaround line 2266
**Holtburger:** Salvage GameAction not in active opcode list; QueryItemMana / QueryHealth pings not surfaced as bus events.

### 25. Allegiance ChatRoomTracker (per memory: was already a fixture-mislabel fix)
**Discord:** Implicit in chat per-channel discussions.
**Holtburger:** Fixture relabeled in Wave 1 SKIPs (2026-05-19 memory), but no chat panel wired to consume it as a *channel* event.

---

## Motion / Animation / Physics Polish (Tier 4)

### 26. Swing-pose classifier wiring — SHIPPED 2026-05-25 (Wave A1)
**Discord:** Per memory + #worldbuilder; spec validated against 5,455 retail links 0 violations.
**Holtburger:** Wave A1 added `EntityManager.setSwingMotion(guid, motionCmd)` at `scene3d/entities.js:1820` (~98 LOC). Resolves `(setupId, mtableId, stance, motionCmd)` via the already-shipped `classifyMotionCommandTyped` (Wave 3.E, 52/52 PASS vs C# oracle), fetches the link clip from `AnimationCache.get(..., { fromMotion: READY_SUBSTATE })` so the cache lane matches retail (`links[(stance, Ready)] → AttackCmd`), plays as `THREE.LoopOnce` with `clampWhenFinished=true` and `timeScale = clip.duration / result.durationSec` so wall-clock matches the link's expected duration, then restores Ready cycle on completion. Falls back to `setSwingPose` vibe-tween on classifier miss / non-human rig / wasm not ready. The seam at `scene3d/picking.js:434` was already wired to prefer `setSwingMotion` over `setSwingPose`. Debug log: `[entities/swingMotion] guid=0x… cmd=0x… anim=… dur=…s` for console validation.
**Remediation:** Closed. Visual A/B on 1070 still pending (real GPU eye-test deferred to next user session).

### 27. MoveTo emote pacing for remote NPCs
**Discord:** "MoveTo emotes…don't work for shit in ACE" — #general line 4132; "Sentry that paces back and forth" #general 4141; should wait for completion but doesn't.
**Holtburger:** No remote-NPC MoveTo state machine in inventory. If ACE emits a `move_to(target, speed)` event, we just teleport / linearly slide.
**Remediation:** State machine in `scene3d/entities.js:EntityInstance` that consumes MoveTo + interpolates with the *actual* animation duration, not packet timing.

### 28. Knockdown / airborne state (kind=18) bus event
**Discord:** Combat phases.
**Holtburger:** "kind=18 EntityAirborneChanged not yet surfaced as bus event (infrastructure exists)" — own inventory line 123. Means knockdown spells have no visual.

### 29. Ground detection (on_ground stub)
**Discord:** "constraint manager maybe" — gmriggs #tool-dev 2026-03-19
**Holtburger:** "ON_GROUND: Stub; real AC uses CPhysicsObj.on_ground() with Quadtree landscape testing" — own inventory line 121
**Remediation:** Use the already-loaded terrain heightfield (LB grids in scene3d/terrain.js) for quick per-frame ground sample; eventually port CPhysicsObj.on_ground() from acclient.c.

### 30. Trajectory solver (3D vs 2D)
**Discord:** "two trajectory calculation methods…one tracks movement in 3D…other only tracks 2D" — #general line 722-726; `/modifybool trajectory_alt_solver true`
**Holtburger:** Per memory, our Wave 3.B physics-jump-formula ports server-side ACE; W3.B classifier ports client-side jump. Missile trajectory (the actual ranged-attack arc) not flagged in inventory; presumably ACE-side.
**Remediation:** Verify our missile launches respect 3D quartic solver vs ACE's 2D fallback; document which we trust.

---

## Plugin / Extensibility (Tier 5)

### 31. Plugin manifest schema (Chorizite-aligned)
**Discord:** Decal/Chorizite/plugin-API discussion across #chorizite, #decalinfo, #alt-clients.
**Holtburger:** Own inventory: "Plugin manifest (TODO): Tier 1 porting work; adopt Chorizite schema (id/name/author/entryFile/version/description/dependencies/environments)."
**Remediation:** JSON manifest at `plugins/*/plugin.json`; loader validates; surfaces to user-visible plugin list.

### 32. Plugin hot-reload + closure cleanup
**Discord:** Plugin instability is a #general theme (UB corruption, plugin registration failures).
**Holtburger:** Own inventory: "Plugins can reload but old closures stay alive (e.g., `isInMagicStance` closure in setupClickPicking)" — memory leak across reload.

### 33. Lua scripting host
**Discord:** "add lua to worldbuilder…so I can use lua…placements…getWobject api" — #general line 2481; Vanquish420 vision of "marketplace of apps like WoW".
**Holtburger:** No Lua, no scripting facade. JS-only plugin model.
**Note:** Likely a stretch goal — we shouldn't take this in until manifest + hot-reload are clean.

### 34. ImGui / overlay debug surface
**Discord:** "imgui is real shittily taped on" — #general line 2522; pain point for *retail* embedding.
**Holtburger:** N/A (browser, DOM is fine) — but a `?debug=1` overlay with scene stats / cell ID / GUID-under-cursor / FPS / draw calls would close the gap that imgui fills for native devs.

---

## Tooling / Performance / Auth (Tier 6)

### 35. Packet logger UX (Wireshark-class)
**Discord:** "packet logger like Wireshark…Copy LLM Context button" — #general lines 1800-1860; ACEWire functional but minimal — #alt-clients.
**Holtburger:** We have WB.Terminal `chorizite-wire-{pack,unpack,list}` (memory) but no in-browser live packet inspector.
**Remediation:** `?packetLog=1` overlay logging C2S/S2C with hex + decoded view; "Copy as ACE fixture" button.

### 36. TLS on the wsbridge
**Discord:** Security/auth thread; cheat prevention discussed.
**Holtburger:** "plaintext username/password over relay (TODO: TLS)" — own inventory line 238.

### 37. Double-connect prevention
**Discord:** Per memory, this is real on rapid relog (account-lock invariant).
**Holtburger:** "Not yet implemented (TODO: guard against re-login mid-session)" — own inventory line 239.

### 38. Performance profiling surface
**Discord:** "waiting for rider profiling license…I absolutely hate speedscope" — #worldbuilder 2026-03-28
**Holtburger:** "No timeline/profile view yet; captures use Playwright/screenshot regression testing only" — own inventory line 322.
**Remediation:** Chrome DevTools Performance trace integration in `?perf=1` mode.

### 39. Memory leak detection (extended-session)
**Discord:** "crash to desktop…much more frequently in fellowship…within 10-20mins" — #general line 3979
**Holtburger:** Audio leak validated clean (memory 2026-05-13). Other subsystems (entities? particles?) not validated under 20-minute load.
**Remediation:** Long-soak harness + `renderer.info.memory` snapshots every minute.

---

## Things Discord Cares About That Holtburger Has Already SOLVED

(Quoting our memory + inventory; included to ground the report and avoid creating make-work.)

| Discord topic | Status in Holtburger |
|---|---|
| DAT parity (24 types) | 906/906 PASS (project_wave1, memory) |
| Wire packet conformance (Chorizite-vs-Rust) | 24/24 PASS (project_w1_skip_fixes, memory) |
| Physics jump formula (1000-tuple sweep) | 1000/1000 bitwise PASS (project_wave3bc, memory) |
| Motion-pose classifier (5,455 retail links) | 52/52 JS-vs-C# PASS (project_motion_table_audit, memory) |
| Atmospheric scattering parity | Sky-K.1 → K.6 shipped (Bruneton bake, takram clouds) |
| Audio HRTF positional + Web Audio + ambient | shipped 2026-05-12, leak-validated 2026-05-13 |
| Volumetric clouds visible on 1070 | shipped Clouds-F 2026-05-15 |
| Combat melee/missile/magic wire (Phases B–J) | 6/6 packets validated live on 1070 |
| Charge attack with stance gating | shipped Phase I 2026-05-17 |
| Vendor buy/sell UI with icons | shipped 2026-05-19 |

---

## Recommended Tactical Order

### Wave A — SHIPPED 2026-05-25

1. ~~EnchantmentChanged + buffs-debuffs HUD (#2)~~ — found already shipped (PR-JJ 2026-05-23); inventory bullet was stale. No code change.
2. ~~Swing-pose classifier wiring (#26)~~ — `EntityManager.setSwingMotion` shipped (`scene3d/entities.js:1820`).
3. ~~Identify panel UI (#9)~~ — right-click drag-threshold trigger shipped (`scene3d/camera.js:428-478`); panel itself was already retail-correct.

### Wave B — SHIPPED 2026-05-25 (later same day)

4. ~~Chat-channel infrastructure (#8)~~ — granularity (4 tabs → 6) + opacity-on-mouseout shipped in `plugins/chat-panel.js`.
5. ~~Sequence-manager validation (#1)~~ — observability MVP shipped in `src/lib.rs` recv_loop; log-only, gated by `?seqDebug=1`.
6. ~~Right-click radial menu finish (#23)~~ — full menu with Examine/Use/Attack MVP shipped in `plugins/radial-menu.js`; Drop/Wield/Trade pending wasm exports.

### Wave C — SHIPPED 2026-05-25 (later same day)

7. ~~Equipment paper-doll + container browse (#10)~~ — paper-doll was already shipped in `plugins/inventory.js`; container browse shipped as `plugins/container-panel.js`.
8. ~~Fellowship panel (#5)~~ — send-side wasm + action panel shipped; receive-side snapshot deferred to Wave D.
9. ~~Weather rain + lightning (#12)~~ — full visual stack (rain particles + lightning flash + thunder cue) shipped under `scene3d/weather/`.

### Wave D — SHIPPED 2026-05-25 (later same day)

10. ~~Fellowship receive-side snapshot infra (#5 full)~~ — snapshot + per-event publishers + kind=22 + member-list display all shipped.
11. ~~Trade system multi-step UI (#3)~~ — 6 wasm methods + snapshot infra + 593-LOC trade-panel shipped.
12. ~~Equipment paper-doll real icons (#10 polish)~~ — fetch_surface_pixels wired into paperdoll slots with race-safe async + TYPE_COLOR fallback.

### Wave E — SHIPPED 2026-05-25 (later same day)

13. ~~Allegiance panel Swear/Break (#4 send-only MVP)~~ — 2 wasm methods + standalone panel shipped.
14. ~~Friends + Character-Squelch (#20 send-only MVP)~~ — 3 opcodes uncommented + 3 new structs + 3 wasm methods + social-panel shipped.
15. ~~Reversed Z-buffer (#11)~~ — `logarithmicDepthBuffer: true` flipped on the renderer.
   Plus bundle bonuses: nameplate distance LOD (#16) + compass HUD overlay (ad-hoc Discord ask).

### Wave F — SHIPPED 2026-05-25 (later same day)

16. ~~Allegiance MOTD/Officer/ChatGag/HometownRecall (#4 polish)~~ — 4 opcodes uncommented + 4 wasm methods + 4 panel buttons shipped.
17. ~~Inscriptions + books (#21)~~ — full Books system (read/edit/add/delete) + Set Inscription + receive-side snapshot panel shipped.
18. ~~Sky aurora storm particles (#14)~~ — pure-JS aurora ribbon system tied to `weather_state.is_storm` shipped, plus `?cellBugParity=retail` for the basement-from-overworld quirk.

### Wave G — SHIPPED 2026-05-25 (later same day)

19. ~~Equipment paper-doll burden + drag-drop (#10 finish)~~ — playerBurden getter + wieldFromPack + dropItem wasm methods + JS burden bar + bidirectional drag-drop shipped.
20. ~~Allegiance receive-side snapshot (#4 receive MVP)~~ — AllegianceUpdate 0x0020 event + 420-LOC full-ACE-wire-conformant struct + snapshot infra + panel state render shipped.
21. ~~Cloud shadow on terrain — URL knobs (#14 follow-on)~~ — discovered shipped via Clouds-L; G3 added the 3 missing URL knobs (?cloudShadow=on|off, ?cloudShadowStrength, ?cloudShadowRes).

### Wave H — SHIPPED 2026-05-25 (later same day)

22. ~~Friends receive-side snapshot (#20 polish)~~ — `FriendsListUpdate 0x0021` + snapshot infra + JS panel shipped.
23. ~~Titles + Account/Global squelch (#20 finish)~~ — 3 opcodes uncommented + send-side wasm + 3 new panel sections shipped.
24. ~~Landblock LRU unload (#15)~~ — `LandblockLRU` class with safety filters + `?lbCap=N` knob + initial-ring bulk-track shipped.
   Recon discovery: BloomEffect was already shipped (quality presets + URL knob + runtime tweaks), so the Wave G recommendation rolled into discovered-not-needed.

### Wave I — SHIPPED 2026-05-25 (true 3-agent parallelism, ~700s wall-clock)

25. ~~Squelch DB + Title catalog receive snapshots (#20 finish-finish)~~ — 3 S2C opcodes + 2 snapshot infras + social-panel sections shipped.
26. ~~Radial menu Drop/Wield entries (#23 polish)~~ — 5-entry contextual menu shipped (Examine/Wield/Use/Drop/Attack).
27. ~~LRU deep dispose at bake sites (#15 polish)~~ — per-cell + per-LB statics geometries now released on evict; buildings confirmed all-shared (audit complete).

### Wave J — SHIPPED 2026-05-25 (3-agent parallelism)

28. ~~Allegiance bans/boot/lock (#4 polish)~~ — 4 opcodes + structs + wasm + panel buttons shipped (8 more opcodes still in the long-tail backlog).
29. ~~Trade radial-menu entry (#23 polish)~~ — Player capability gating via WorldObjectManager + Trade entry between Drop and Attack.
30. ~~Inscription display on examine (#21 polish)~~ — book-side cross-ref shipped; non-book path reserved until InventoryItem.inscription wasm getter lands.

### Wave K — SHIPPED 2026-05-25 (3-agent parallelism)

31. ~~Object inscription getter + non-book examine cascade (#21 finish)~~ — getObjectInscription wasm method + cascade step-2 wired; latest_inscriptions Rc populated from EntityIdentified arm.
32. ~~Lock-action cycle UX (#4 polish)~~ — 6-value AllegianceLockAction dropdown replaces hardcoded LOCK_ON=2.
33. ~~Spell Research panel (#19)~~ — full filterable known-spells display with components / mana / duration / desc.

### Wave L — SHIPPED 2026-05-25 (3-agent parallelism)

34. ~~House system MVP (#22)~~ — 4 opcodes + structs + wasm + new house-panel.js shipped.
35. ~~Speculative squelch refresh (#20 polish)~~ — module-level mirror + 3 helpers + server-wins reconcile.
36. ~~Cast-from-research-panel + Compass mini-radar~~ — double-click cast with stance gate + 200×40 radar strip with category-color dots.

### Wave M — SHIPPED 2026-05-25 (3-agent parallelism)

37. ~~House Status receive (#22 status signal)~~ — HouseStatus event + snapshot + panel status section.
38. ~~Component table extraction (#19)~~ — 163-entry retail catalog extracted from DAT 0x0E00000F via DRW + bug fix on existing scarab labels.
39. ~~Radar polish~~ — hover tooltip (name • dist • bearing) + click-to-set-target.

### Wave N — next priorities

40. **HouseData full receive (#22 polish)** — HouseData 0x0225 carries rent due ts + dwelling type + restrictions; M1 only handled the not-owned signal.
41. **House guest perms + storage perms + boot (#22 polish)** — 8+ remaining commented opcodes.
42. **Allegiance approved-vassal + officer-titles + ListBans receive (#4 final)** — 8 remaining commented opcodes.
43. **House picker UX (#22 polish)** — replace manual GUID inputs with List-Available-Houses dropdown.
44. **Spell research → spellbook drag-and-drop (#19 polish)** — drag from research panel to spellbook bar slot.
45. **Radar bearing-axis labels** — small N/E/S/W tick marks at radar centerline.

**Discord-evidence theme to internalize:** the community measures alt-clients by *what verbs you can do*, not by render quality. Holtburger is graphically the strongest project discussed in the corpus, but a player who can't trade, can't appraise, can't fellowship, and can't see their own buffs will judge it harshly.
