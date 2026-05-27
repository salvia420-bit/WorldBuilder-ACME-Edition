# Wave D.1 — gmInventoryUI completeness audit

**Date:** 2026-05-27
**Source of truth:** `external/chorizite/ACBindings/Generated/UI/Elements/gmInventoryUI.cs` (220 lines, LLM-narrated Hex-Rays over retail acclient.exe), plus its three sub-component classes:
- `external/chorizite/ACBindings/Generated/UI/Elements/gmPaperDollUI.cs` (420 lines)
- `external/chorizite/ACBindings/Generated/UI/Elements/gmBackpackUI.cs` (181 lines)
- `external/chorizite/ACBindings/Generated/UI/Elements/gm3DItemsUI.cs` (140 lines)

**Our impl under audit:**
- `external/holtburger/apps/holtburger-web/plugins/inventory.js` (1,352 lines — primary panel)
- `external/holtburger/apps/holtburger-web/index.html` (lines 789-809 DOM, lines 6795-6852 `renderInventoryPanel`)
- `external/holtburger/apps/holtburger-web/plugins/container-panel.js` (370 lines — sibling: chests/corpses)
- `external/holtburger/apps/holtburger-web/plugins/status-indicators.js` (364 lines — owns the burden indicator now)
- `external/holtburger/apps/holtburger-web/ui/ac_paperdoll_viewport.js` (PaperdollViewport class — 3D rig backing)
- `external/holtburger/apps/holtburger-web/plugins/main-panel.js` (500 lines — container shell)
- `external/holtburger/apps/holtburger-web/plugins/examine-target.js` (722 lines — referenced via main-panel pushView)
- `external/holtburger/apps/holtburger-web/src/lib.rs` (wasm exports — `playerInventory`, `wieldFromPack`, `dropItem`, `getContainerContents`)

**Reading-guide compliance:** per `external/holtburger/docs/chorizite-reading-guide-summary-2026-05-27.md` §3 anti-pattern #1, no `0x00XXXXXX` offset constants from acclient.exe are ported. Doc-comments are used as triage only (anti-pattern #2). The `Generated/UI/` framework itself is skip-tier (anti-pattern #5); this audit treats the `gm*UI` classes as a record of *what data each retail screen displayed*, not as code to port.

---

## §1. Fields table

The C# `gmInventoryUI` struct itself declares only 4 child pointers (the panel is mainly an orchestrator composing its three sub-panels + a title). For completeness, this table also walks every `UIElement_*` / `UIElement_*Slot` / `UIElement` field declared in the three sub-component classes that the panel directly composes: `gmPaperDollUI`, `gmBackpackUI`, `gm3DItemsUI`. Per the reading-guide §6 row "Inventory", our `inventory.js` covers the same composite surface (paperdoll + backpack + items grid) in one DOM panel, so the audit scope is the union of these four classes.

Rendered column: Y = present in current UI; N = absent; Partial = surface exists but missing semantics or visual fidelity.

### 1a. `gmInventoryUI` — orchestrator (4 fields, all object pointers, not direct UI atoms)

| Field | gmInventoryUI line | Doc-comment one-liner (truncated) | Rendered? | Our file:line | Notes |
|---|---|---|---|---|---|
| `m_paperDollUI`     | 100 | sub-component pointer (paper-doll view) | Y       | `plugins/inventory.js:700-799` (DOM build) + `ui/ac_paperdoll_viewport.js:118` (3D rig load) | Wave 14 wired PaperdollViewport behind the slot grid |
| `m_backpackUI`      | 101 | sub-component pointer (backpack list / load meter) | Partial | `plugins/inventory.js:818-848` (bag column) + `index.html:6795-6852` (`renderInventoryPanel`) + `plugins/status-indicators.js:91` (burden indicator extracted) | Items grid filtered by selected bag tab works; **load meter is in status-indicators.js, not in this panel** — see §1c row `m_burdenMeter/Text`, intentional split per Wave 13 |
| `m_3DItemsUI`       | 102 | sub-component pointer (3-D items panel) | N       | — | We have NO floating "Contents of <container>" 3-D items pane. `plugins/container-panel.js` handles ground containers but as a flat icon grid, not a 3D physics viewport. Retail's `gm3DItemsUI` shows the contents of the currently-targeted container as a separate floating window with a title `"Contents of Backpack"` (`gm3DItemsUI.cs:134`) and embeds a 3D viewport like gmPaperDollUI does. |
| `m_titleText`       | 103 | sub-component pointer (window title text) | Y       | `plugins/main-panel.js` (`nameFor(_ctx)` in `inventory.js:682-686` returns `"Inventory of <name>"`) | Title is owned by main-panel shared shell. Mirrors retail's `RecvNotice_PlayerDescReceived` → set title to player name (`gmInventoryUI.cs:212-216`) and `RecvNotice_NewParentContainer` → set title to container name (`gmInventoryUI.cs:218-223`). The latter is unwired — see §3 issue. |

### 1b. `gmPaperDollUI` — paper-doll equipment slots (35 fields, of which 24 are body slots)

| Field | gmPaperDollUI line | Doc-comment one-liner (truncated) | Rendered? | Our file:line | Notes |
|---|---|---|---|---|---|
| `m_neckSlot`          | 101 | jewelry slot — neck | Y       | `plugins/inventory.js:162` PAPERDOLL_SLOTS[0] equipMask=0x8000 | "Necklace" hint |
| `m_leftWristSlot`     | 102 | jewelry slot — left wrist (bracelet) | Y       | `plugins/inventory.js:182` equipMask=0x00010000 | side=LEFT |
| `m_leftRingSlot`      | 103 | jewelry slot — left ring | Y       | `plugins/inventory.js:187` equipMask=0x00040000 | side=LEFT |
| `m_rightWristSlot`    | 104 | jewelry slot — right wrist (bracelet) | Y       | `plugins/inventory.js:181` equipMask=0x00020000 | side=RIGHT |
| `m_rightRingSlot`     | 105 | jewelry slot — right ring | Y       | `plugins/inventory.js:186` equipMask=0x00080000 | side=RIGHT |
| `m_weaponReadySlot`   | 106 | held-weapon slot (main hand ready) | Y       | `plugins/inventory.js:198` equipMask=0x00100000 | Wave 16 added |
| `m_ammoReadySlot`     | 107 | quiver/ammo ready slot | Y       | `plugins/inventory.js:200` equipMask=0x00800000 | Wave 16 added |
| `m_shieldReadySlot`   | 108 | shield off-hand ready slot | Y       | `plugins/inventory.js:197` equipMask=0x00200000 | Wave 16 dedupe-fix |
| `m_clothesPantsSlot`  | 109 | underwear — pants | Y       | `plugins/inventory.js:185` equipMask=0x00000040 | "Pants" |
| `m_clothesShirtSlot`  | 110 | underwear — shirt | Y       | `plugins/inventory.js:177` equipMask=0x00000002 | "Shirt" |
| `m_trinketOneSlot`    | 111 | trinket / society sigil (level 30+) | Y       | `plugins/inventory.js:163` equipMask=0x04000000 | always-visible; retail dims until unlocked but we don't gate |
| `m_cloakSlot`         | 112 | back slot — cloak | Y       | `plugins/inventory.js:173` equipMask=0x08000000 | |
| `m_sigilOneSlot`      | 113 | aetheria sigil 1 (Blue) — gated on AetheriaBits 0x1 | Partial | `plugins/inventory.js:168` equipMask=0x10000000 | Rendered as ungated dim slot; retail's `UpdateAetheria` (`gmPaperDollUI.cs:217-222`) hides until PSetIntStat 0x142 bit 0x1. Our PAPERDOLL_SLOTS comment acknowledges this. |
| `m_sigilTwoSlot`      | 114 | aetheria sigil 2 (Yellow) | Partial | `plugins/inventory.js:169` equipMask=0x20000000 | as above, bit 0x2 |
| `m_sigilThreeSlot`    | 115 | aetheria sigil 3 (Red) | Partial | `plugins/inventory.js:170` equipMask=0x40000000 | as above, bit 0x4 |
| `m_headSlot`          | 116 | head armor slot | Y       | `plugins/inventory.js:172` equipMask=0x00000001 | |
| `m_chestSlot`         | 117 | chest armor slot | Y       | `plugins/inventory.js:176` equipMask=0x00000200 | |
| `m_abdomenSlot`       | 118 | abdomen armor slot | Y       | `plugins/inventory.js:180` equipMask=0x00000400 | |
| `m_upperArmSlot`      | 119 | upper-arm armor slot | Y       | `plugins/inventory.js:175` equipMask=0x00000800 | |
| `m_lowerArmSlot`      | 120 | lower-arm armor slot | Y       | `plugins/inventory.js:179` equipMask=0x00001000 | |
| `m_handSlot`          | 121 | hand-armor (glove) slot | Y       | `plugins/inventory.js:189` equipMask=0x00000020 | "Gloves" |
| `m_upperLegSlot`      | 122 | upper-leg armor slot | Y       | `plugins/inventory.js:184` equipMask=0x00002000 | |
| `m_lowerLegSlot`      | 123 | lower-leg armor slot | Y       | `plugins/inventory.js:190` equipMask=0x00004000 | |
| `m_footSlot`          | 124 | foot armor slot | Y       | `plugins/inventory.js:199` equipMask=0x00000100 | "Boots" |
| `m_pInventoryObject`  | 125 | CPhysicsObj rendering the character model | Y       | `ui/ac_paperdoll_viewport.js:118` `loadPlayer(setupId, mtableId, paletteId, subPalettes)` | Wave 14 PaperdollViewport; loaded from local-player meta (`inventory.js:1144-1162`) |
| `m_pPaperDoll`        | 126 | UIElement_Viewport hosting the 3D physics obj | Y       | `plugins/inventory.js:711-717` `viewportWrap` element | |
| `m_didAnimation`      | 127 | DID of the per-heritage idle animation | Partial | `ui/ac_paperdoll_viewport.js` | PaperdollViewport loads mtableId but doesn't pick a per-heritage animation; retail uses `UpdateForRace` (`gmPaperDollUI.cs:226-232`) to swap animation for certain heritages. Not exposed via current API. |
| `m_dragIcon`          | 128 | the drag-icon UIElement (shown attached to cursor during drag) | Partial | (HTML5 drag image; `inventory.js:752-761` uses `ev.dataTransfer.setData` only) | We rely on browser-default drag image; no custom dragged-item sprite rendered as the cursor pickup. Visually distinct from retail's "PrepareDragIcon" path (`gmPaperDollUI.cs:290-295`). |
| `m_paperDollDragMask` | 129 | overlay element showing the "valid drop here" highlight | Partial | `inventory.js:328-330` `.hb-inv-doll-slot.drag-target` CSS class only colors the target slot | retail draws an outline overlay on the **paperdoll body region** when an auto-wearable item is dragged over. We only highlight the matched slot box, not the body silhouette. See `HandlePaperDollDragOver` (`gmPaperDollUI.cs:184-190`). |
| `m_paperDollDragOverlay` | 130 | second drag-overlay layer (accept/reject visual) | N       | — | Closely related to `m_paperDollDragMask`; the C# code uses two layers to render `AcceptDragObject`'s "no, this slot rejects" feedback. Our impl has neither layer. |
| `m_sigilOneItem`      | 131 | per-aetheria-slot icon ref shown when sigil is equipped | Y       | `inventory.js:730-743` per-slot `icon` element (shared with all body slots) | covered by generic slot-icon rendering; semantics fine |
| `m_sigilTwoItem`      | 132 | (as above, sigil 2) | Y       | as above | |
| `m_sigilThreeItem`    | 133 | (as above, sigil 3) | Y       | as above | |
| `m_SlotCheckbox`      | 134 | **the "Slots" toggle checkbox button on the paperdoll** — this is the field the absorption plan calls `m_burdenButton` based on its visual position next to the burden meter | N       | — | **High-impact missing UI control.** Per the doc-comment ordering immediately after the 3 drag-overlay fields, this is a button-style toggle on the paperdoll. Retail wiki ("Inventory Panel" page) describes a "Slots" button that toggles between paperdoll view and a flat slot-list view of equipped items. The plan's "m_burdenButton" label was a guess from `User-Interface-10.webp` (which is **missing from `external/holtburger/docs/`** — the absorption plan references it but the file does not exist locally). |
| `m_clickMap`          | 135 | RenderSurface holding the per-pixel slot click map | Partial | `inventory.js` uses one DOM element per slot at hand-tuned (x,y); the click map is implicit in DOM hit-testing | Retail uses a paletted bitmap (`GetPaperDollItemUnderMouse @ acclient.c:0x004A4C90`) to translate cursor position → slot identifier. We replaced this with absolute-positioned DOM children, which is functionally equivalent for clicks but doesn't have pixel-perfect hit regions for irregular slot shapes (e.g., the cloak slot is roughly rectangular in retail but has a tighter mask). Functionally Y, visually Partial. |
| `m_cFlipCount`        | 136 | counter for the BeginPartSelectionLighting animation | N       | — | Powers the "wink" effect — when you click a body-slot, retail flashes the matching 3D-rig body part briefly. See `BeginPartSelectionLighting` + `UpdatePartSelectionLighting` + `ApplyPartSelectionLighting` (`gmPaperDollUI.cs:208-215, 260-264, 336-341`). Not in PaperdollViewport. |
| `m_timeNextFlip`      | 137 | timer for the same effect | N       | — | as above |
| `m_selectionMask`     | 138 | bitmask of body slots currently being lit | N       | — | as above; also referenced by `GetSelectionMaskFromObject` (`gmPaperDollUI.cs:328-334`) for hovered-item highlight |

### 1c. `gmBackpackUI` — bag-tab column + items list + load meter (4 fields)

| Field | gmBackpackUI line | Doc-comment one-liner (truncated) | Rendered? | Our file:line | Notes |
|---|---|---|---|---|---|
| `m_burdenText`     | 101 | text label showing current carry weight (e.g. "120 / 300") | Partial | `plugins/status-indicators.js` shows the burden **indicator icon** but the **numeric percentage label** is in a tooltip, not always-visible text on the inventory window | Wave 13 audit moved burden indicator to status-indicators; the corresponding numeric label here is missing. See §3 issue. |
| `m_burdenMeter`    | 102 | UIElement_Meter — the 0–100% load bar | Partial | `plugins/status-indicators.js:91` ICON_DID 0x06007498 — single icon, not a multi-state bar | `SetLoadLevel` (`gmBackpackUI.cs:151-156`) clamps to 0–1 and rebuilds the meter visual at percent granularity. status-indicators only swaps icons across 5 states (per its own header docs), no analog bar. |
| `m_topContainer`   | 103 | UIElement_ItemList — items grid for the currently-selected container | Y       | `plugins/inventory.js:857-859` + `rebuildItemsGrid` at L1118-1132 | filtered by `selectedPackContainerId` (Wave 13.2) |
| `m_containerList`  | 104 | UIElement_ItemList — the bag-tab column (1 main + 7 side packs) | Y       | `plugins/inventory.js:818-848` `bagCol` + `renderBagTabs` at L1081-1112 | BAG_COUNT=8 (Mule Aug 9th deferred) |

### 1d. `gm3DItemsUI` — floating "Contents of <container>" pane (2 fields)

| Field | gm3DItemsUI line | Doc-comment one-liner (truncated) | Rendered? | Our file:line | Notes |
|---|---|---|---|---|---|
| `m_contentsText`   | 99  | UIElement_Text — title set to `"Contents of Backpack"` at PostInit | N       | — | We have no floating contents-of-X 3D pane. `container-panel.js` is the closest analog but does NOT carry a contents-of title; the container name is set via `setAcText(overlayEl._titleEl, containerName...)` (`container-panel.js:283`) which is conceptually equivalent for ground containers (chest/corpse) but not for the paperdoll-3DItemsUI panel that retail shows for opening the player's own backpack. |
| `m_itemList`       | 100 | UIElement_ItemList for the items inside the targeted container | Partial | `plugins/container-panel.js:241-276` for ground containers only; for the player's own packs, this is folded into `m_containerList` selection + `m_topContainer` (`plugins/inventory.js:1118-1132`) | functional but the retail UX is a separate floating pane (the player can have BOTH the inventory window AND the contents-of pane open simultaneously); our impl shows pack contents inline by replacing the items grid — strictly less surface area. |

### Summary

**Total fields across the four classes:** 4 (gmInventoryUI) + 35 (gmPaperDollUI) + 4 (gmBackpackUI) + 2 (gm3DItemsUI) = **45 fields**.

- **Y (rendered):** 28
- **N (missing):** 8
- **Partial:** 9

---

## §2. Methods table

`InitPanel`/`PostInit` and the inventory-relevant notice handlers across the four classes. Doc-comment text is the LLM narration; trust at triage level only (reading-guide §3 #2).

### 2a. `gmInventoryUI` methods (12 handlers + constructor + Register)

| Method | gmInventoryUI line | Layout DIDs read | Wired in our code? | Our file:line |
|---|---|---|---|---|
| `_ConstructorInternal(layout, full_desc)` | 118 | reads layout passed by caller (full_desc → child elements) | Y (via main-panel.mount) | `plugins/inventory.js:690` `doMount` |
| `RecvNotice_UpdateCharacterInformation(playerDesc)` | 149 | none (forwards burden update) | Partial | wired via `kind=11 InventoryUpdated` event (`index.html:6795+8501`) + MutationObserver (`inventory.js:1195-1207`); the *burden* leg of this handler is in status-indicators.js |
| `RecvNotice_SetDisplayInventory(display)` | 156 | none | N | the `display` param is "currently unused but retained" per docstring; safe to skip |
| `RecvNotice_ItemAttributesChanged(target, attrib)` | 164 | none | N | refreshes paperdoll on bit-0 set. We rely on the broader `playerInventory()` re-poll on every kind=11 event, but don't have a fine-grained "this single item's attribs changed" path. See §3 issue. |
| `RecvNotice_ServerSaysMoveItem(itemID, oldContainer, oldWielder, oldLocation, newContainer, place, newWielder, newLocation)` | 178 | none | N | This is the server's authoritative move-confirmation. Our wasm has `wieldFromPack`/`dropItem` C2S only — the S2C confirmation arrives as the *next* `playerInventory()` snapshot via kind=11 (the snapshot-diff pattern is fine functionally; but the explicit move event is what enables wield animations + "moved to Y" toast feedback). See §3 issue. |
| `RecvNotice_EndPendingInPlayer()` | 184 | none | N | Companion to `ShowPendingInPlayer`; clears the "pending" overlay on the just-arrived item. |
| `PostInit()` | 190 | reads child element pointers from the inventory layout (per docstring "locating child elements such as the paper‑doll view, backpack pane, 3‑D items panel, and title text") | Y | `inventory.js:624-668` `applyInventoryLayout` reads INV_ELEM_PAPERDOLL_AREA (0x100001CD), INV_ELEM_BAG_COLUMN (0x100001CE), INV_ELEM_ITEMS_GRID (0x100001CF) from LayoutDesc **0x21000023** |
| `Register()` | 196 | static; no layout reads | N/A | retail UI framework registration is not portable per anti-pattern #5 |
| `RecvNotice_OpenContainedContainer(containerID)` | 203 | none (validates ownership + opens via separate 3D pane) | Partial | We open ground containers via `container-panel.js:onContainerOpened`, but the **side-pack open** (containerID is a pack the player owns) routes through bag-tab selection only — we don't pop a separate 3D pane; we replace the items grid. See §1d note. |
| `RecvNotice_ShowPendingInPlayer(itemID)` | 210 | none | N | "Pending" state — server has acknowledged the item but inventory isn't fully updated yet. We currently show items only after the kind=11 snapshot arrives in full; intermediate pending state is invisible. |
| `RecvNotice_PlayerDescReceived(playerDesc, playerModule)` | 216 | none (refreshes title + items) | Partial | title update wired via `nameFor()` (`inventory.js:682-686`); item refresh via kind=11 path; player-desc per-se isn't a separate event in our pipeline |
| `RecvNotice_NewParentContainer(newContainerID)` | 223 | none (changes title between "Backpack" and "<container name>") | N | when the player switches the active "parent container" (typically opening a side pack), retail repurposes the inventory window's title to that container's name. We keep "Inventory of <player>" always. See §3 issue. |

### 2b. `gmPaperDollUI` — selected methods (PostInit + the drag/click handlers we care about)

| Method | gmPaperDollUI line | Layout DIDs read | Wired in our code? | Our file:line |
|---|---|---|---|---|
| `PostInit()` | 380 | docstring: "locating all slot elements, registering drag handlers, updating tooltips, configuring the viewport camera and lighting, and setting up global event listeners. It also creates a click map and prepares the drag icon." | Partial | slot DOM build at `inventory.js:719-799`; viewport at `inventory.js:711-717`; drag handlers at `inventory.js:752-797`; tooltips at `inventory.js:744-747`. **Click map and drag-icon-prepare are NOT wired** (see §1b rows `m_clickMap` Partial + `m_dragIcon` Partial). |
| `_ConstructorInternal(layout, full_desc)` | 240 | reads slot child elements from LayoutDesc **0x21000037** (per Wave 16 audit comment in `inventory.js:79-86`) | Partial | We DON'T load 0x21000037 — Wave 16 audit found its `IncorporationFlags 0x1E` excludes the X bit on every slot element, so hand-tuned positions in `PAPERDOLL_SLOTS` are authoritative. The slot ElemIds + hintIconDids are cited from that layout but never read at runtime. |
| `GetLocationInfoFromElementID(elemID, *loc, *slotSide)` | 182 | none | Y (folded into `PAPERDOLL_SLOTS` data table at `inventory.js:160-201`) | per the `inventory.js` header comment, the equipMask + side mapping is derived from `acclient.c:219835-219952` |
| `HandlePaperDollDragOver(dragElement)` | 190 | none | Partial | `inventory.js:765-779` dragenter/dragover/dragleave color the matched slot via `.drag-target` CSS class. Retail also draws an overlay on the body silhouette to indicate "anywhere on the body will auto-wear" — we don't. See §1b `m_paperDollDragMask` Partial. |
| `AcceptDragObject(itemID, *loc, *slotSide)` | 200 | none | Y (via `inventory.js:780-797` drop handler → `wieldFromPack(guid, equipMask)`) | |
| `RedressCreature()` | 206 | none (refreshes 3D rig) | Y | `inventory.js:1144-1162` `refreshPaperdollViewport` |
| `UpdateAetheria(cwobj)` | 222 | none (queries AetheriaBits 0x142 0x1/0x2/0x4) | N | sigil slots are always rendered as ungated dim slots; we don't read AetheriaBits to hide them when locked. See §3 issue. |
| `UpdateForRace(heritage)` | 232 | none | Partial | PaperdollViewport.loadPlayer takes setupId/mtableId/paletteId — implicitly per-heritage — but the camera offsets that retail tweaks per-heritage (some races' cameras are zoomed differently) aren't applied. |
| `OnQualityChanged(cwobj, stype, senum)` | 281 | none (refreshes aetheria) | N | follows the AetheriaBits gating gap |
| `Register()` | 287 | static | N/A | not portable |
| `PrepareDragIcon(itemID)` | 295 | none (loads item icon → sets drag image) | N | browser-default drag image only |
| `GetUpperInvObj(locations)` | 303 | none | N | retail uses this for keyboard navigation through equipped items by bitmask; we have no keyboard nav on the paperdoll |
| `CreateClickMap()` | 309 | loads "predefined render surface from the game database" (DID) into `m_clickMap` | N | the per-pixel hit-test map; we hit-test via DOM elements |
| `GetPaperDollItemUnderMouse(x, y)` | 318 | none | Partial | DOM hover replaces this; functionally equivalent for clicks |
| `AcceptPaperDollDragObject(itemID)` | 326 | none | Y (`inventory.js:780-797` drop handler) | |
| `GetSelectionMaskFromObject(objID)` | 334 | none | N | feeds the "wink" effect at hover-time |
| `BeginPartSelectionLighting(objID)` | 341 | none | N | the body-part flash on selection (see §1b row `m_cFlipCount` / `m_timeNextFlip` / `m_selectionMask`) |
| `ListenToGlobalMessage(messageID, data_int)` | 349 | none | Partial | we use direct event subscription instead of global-message routing |
| `HandleDropRelease(rMsg)` | 356 | none | Partial | folded into HTML5 `drop` handlers per-slot |
| `RecvNotice_SetSelectedItem(oldSelectedID, selectedID)` | 364 | none | N | retail flashes the part for non-zero selection (`gmPaperDollUI.cs:358-364`); we have a `setSelected` (`inventory.js:879-889`) that toggles a CSS class but no body-part flash |
| `UpdateItemSlotTooltip(*pSlot, itemID)` | 372 | none | Partial | our tooltip is set once at slot construction (`inventory.js:744-747`) and only updates label; retail also updates "can be taken off" / "can't unwield" hint text based on item state — we don't |
| `ListenToElementMessage(rMsg)` | 388 | none (dispatches slot clicks/drags) | Partial | replaced by direct DOM listeners |
| `SetUIItemIntoLocation(itemID, location)` | 396 | none | Y (folded into `placeEquippedInDoll` at `inventory.js:1010-1042`) | |
| `ServerSaysMoveItem(...)` | 411 | none | N (no S2C delta dispatch; we re-snapshot via kind=11) | mirrors `gmInventoryUI::RecvNotice_ServerSaysMoveItem` |
| `RemakeCharacterInventory()` | 418 | none (full rebuild) | Y | `inventory.js:1164-1193` `rebuild()` |

### 2c. `gmBackpackUI` methods

| Method | gmBackpackUI line | Layout DIDs read | Wired? | Our file:line |
|---|---|---|---|---|
| `_ConstructorInternal(layout, full_desc)` | 119 | reads child elements | Y | (via inventory.js mount path) |
| `Register()` | 149 | static | N/A | |
| `SetLoadLevel(level)` | 156 | none | Partial | partial via status-indicators icon swap |
| `PostInit()` | 164 | reads burdenText, burdenMeter, topContainer, containerList element pointers | Partial | three of four wired (bag column, items grid in inventory.js; burden in status-indicators.js); burdenText label is missing |
| `RecvNotice_PlayerDescReceived(playerDesc, playerModule)` | 172 | none (initial load level) | Partial | same path as above |
| `RecvNotice_LoadChanged(newLoad)` | 179 | none | Partial | status-indicators icon state; no animated bar fill |

### 2d. `gm3DItemsUI` methods

| Method | gm3DItemsUI line | Layout DIDs read | Wired? | Our file:line |
|---|---|---|---|---|
| `Create(layout, full_desc)` | 126 | static factory | N/A | |
| `Register()` | 132 | static | N/A | |
| `PostInit()` | 138 | reads contentsText + itemList, sets title to "Contents of Backpack" | N | no equivalent panel exists; closest is `container-panel.js` for ground containers |

---

## §3. Follow-up issues

One line per N or notable-Partial row in §1/§2. Ranked by likely user-visible impact.

### High impact (user notices immediately)

> **Update 2026-05-27:** Items 1-4 below were the Wave D.1 follow-on work; all four are now wired in `plugins/inventory.js` + `plugins/inventory_helpers.js` (+ 8 new tests in `tests/inventory_paperdoll_helpers.test.cjs` — 36 total pass). Items 5-6 deferred (5 = significant separate-window port; 6 = wasm/protocol territory for Wave E). See the handoff doc's Wave D.1 row for the per-item shipped-vs-deferred matrix.

1. **`m_SlotCheckbox` (the "Slots" toggle button)** — **SHIPPED 2026-05-27.** Implemented as a 36×16 brass-trim toggle anchored at the paperdoll's top-right corner. State persists via localStorage (`hb-inv.slots-view.checked.v1`); default unchecked matches retail's `SetAttribute_Bool(..., 0)` at `acclient.c:221667`. When checked, the overlay gains `.slots-view` class; CSS hides the 3D viewport + paperdoll bg AND drops the hand-tuned anatomy positioning so equipped doll slots reflow as a flat grid; empty slots collapse. Cross-validated against `acclient.c:221636` (retail element 0x100005BE, which Wave 12 had originally mistaken for the burden indicator) and `:221698-221728` (the 9-slot toggle block). Per `gmPaperDollUI.cs:134` this is `UIElement_Button` typed; per wiki "Inventory Panel" doc it's labeled "Slots."

2. **`UpdateAetheria` gating** — **SHIPPED.** `refreshAetheriaGating` reads `handle.playerAetheriaBits` (PropertyInt 322) on every rebuild + `playerStatsUpdated` event; `aetheriaSlotIsLocked` helper drives the `.aetheria-locked` CSS class (`display:none`) per slot. Pre-quest character now shows 0/3 sigil slots (matches retail). Reference: `gmPaperDollUI.cs:217-222`.

3. **`RecvNotice_NewParentContainer` — title updates on container switch** — **SHIPPED.** `refreshPanelTitle` driven by the bag-tab click handler + every rebuild pass; `computeInventoryTitle` helper computes `"Inventory of <player>"` vs `"Contents of <pack>"` based on `selectedPackContainerId`. Updates flow through `window.__mainPanel?.setTitle?.()`. Reference: `gmInventoryUI.cs:218-223`.

4. **Numeric burden label (`m_burdenText`)** — **SHIPPED.** Always-visible text row between paperdoll bottom and items grid top (in the 28px gap). `refreshBurdenText` reads `handle.playerBurden` (float, encumbrance/capacity per ACE `EncumbranceSystem.GetBurden`); `formatBurdenText` helper handles `"<pct>%"` rendering + `.over` red-color modifier when ≥1.0. Distinct from the burden indicator icon in `status-indicators.js` (the meter-icon leg of retail's `m_burdenMeter`). Reference: `gmBackpackUI.cs:101`.

### Medium impact (improves polish, missing feature)

5. **`gm3DItemsUI` separate floating contents-of pane** — when a player opens their own side pack, retail pops a SECOND floating window beside the inventory window with title "Contents of <pack>" and the 3D items list. Our impl replaces the items grid inline, which is functionally fine but loses the "I can see my main inventory AND my side pack at the same time" UX. Reuse `container-panel.js` or extract a shared component. Reference: `gm3DItemsUI.cs:134` + `gmInventoryUI.cs:198-203` (`RecvNotice_OpenContainedContainer`). *(Medium — workflow speed for inventory mgmt.)*

6. **Body-part wink on selection (`BeginPartSelectionLighting` family)** — when the user clicks a body slot (or hovers an equippable item in the items grid), retail flashes the matching body part on the 3D rig 2-3 times. Implement via `PaperdollViewport`'s mesh-tinting API (or shader uniform). References: `gmPaperDollUI.cs:208-215, 260-264, 336-341`. *(Medium — strong "what slot is this?" visual cue.)*

7. **`RecvNotice_ServerSaysMoveItem` explicit S2C delta** — currently we snapshot-diff the whole inventory on every kind=11 event. Wiring a fine-grained move event would enable: per-item toast feedback ("Picked up Pyreal x50"), wield animation triggering on the OWN character, and pre-snapshot optimistic UI. Reference: `gmInventoryUI.cs:166-178` + `gmPaperDollUI.cs:399-411` (both classes handle the same event). *(Medium — better feedback loop; foundation for §3 items 8 and 9.)*

8. **Pending-item state (`ShowPendingInPlayer` / `EndPendingInPlayer`)** — retail shows an "incoming" overlay on items between the server's "I will give you this" and "here it is" packets. Wire a `pendingItems` set on the wasm snapshot and render with reduced opacity. Reference: `gmInventoryUI.cs:198-210`. *(Medium — important for slow connections / large stack pickups.)*

9. **Custom drag-icon (`m_dragIcon` + `PrepareDragIcon`)** — replace the HTML5 default drag image with the item's actual sprite icon (using `dataTransfer.setDragImage`). Reference: `gmPaperDollUI.cs:128, 290-295`. *(Medium — visual polish; the default chrome drag image is generic and ugly.)*

10. **Paperdoll body-silhouette drag overlay (`m_paperDollDragMask` + `m_paperDollDragOverlay`)** — when dragging an auto-wearable item, retail tints the whole body silhouette green/red to indicate "drop anywhere on me will work." We only color the single matched slot. Reference: `gmPaperDollUI.cs:129-130, 184-190`. *(Medium — discoverability for the auto-wear semantics.)*

### Low impact (deep parity / niche)

11. **`m_clickMap` per-pixel hit-test** — replace DOM-element hit testing with a paletted bitmap loaded from a DAT RenderSurface so irregular slot shapes (cloak edges, slot rounding) hit exactly like retail. References: `gmPaperDollUI.cs:135, 305-318`. *(Low — DOM hit testing is "good enough" visually.)*

12. **`UpdateForRace` per-heritage camera tweaks** — heritage-specific camera offsets/zooms in the paperdoll viewport (retail tightens the camera for shorter races). Reference: `gmPaperDollUI.cs:224-232`. *(Low — visual; PaperdollViewport already takes mtableId so the rig is correct.)*

13. **`UpdateItemSlotTooltip` dynamic tooltip text** — tooltip should change ("Can't unwield this item — combat") based on game-state, not just show slot name. Reference: `gmPaperDollUI.cs:367-372`. *(Low — informational.)*

14. **`SetDisplayInventory` (`display` param) and `ItemAttributesChanged` (bit 0)** — both have docstrings indicating limited use ("currently unused but retained for compatibility" / "bit 0 = primary update requiring refresh"). Wire only if profile data shows excessive snapshot churn. Reference: `gmInventoryUI.cs:152-164`. *(Low — perf-shaped, no user surface.)*

15. **Multiple-bit `equipMask` items** — `placeEquippedInDoll` picks the FIRST matched slot (`inventory.js:1011-1021`). Retail puts a multi-slot item (e.g. a robe covering chest+upper-arm) into ALL matched slots simultaneously, with the icon showing in each. See `SetUIItemIntoLocation` (`gmPaperDollUI.cs:391-396`) which iterates the location bitmask. *(Low — robes are the main case; rare in early game.)*

---

## §4. Coverage honesty

### What I read in full
- `gmInventoryUI.cs` (224 lines)
- `gmPaperDollUI.cs` (419 lines)
- `gmBackpackUI.cs` (181 lines)
- `gm3DItemsUI.cs` (140 lines)
- `gmUIElement_BurdenIndicator.cs` (153 lines — not formally a sub-field but the doc-comment trail led there)
- `InventoryRequest.cs` (enum, 19 lines)
- `external/holtburger/apps/holtburger-web/plugins/inventory.js` (1,352 lines — both pages)
- `index.html` (lines 6795-6852 `renderInventoryPanel`)
- Relevant slices of `container-panel.js`, `status-indicators.js`, `main-panel.js`

### What I sampled (grep + read first/last regions)
- `examine-target.js` (722 lines) — only read line 1 metadata; sample sufficient to confirm it's the popover backend
- `src/lib.rs` (~21k LoC) — grep'd for `playerInventory`, `wieldFromPack`, `dropItem`, `MoveItem`, `StackSplit`, `StackMerge`, `InventoryRequest`; read only the matched line vicinities
- `ac_paperdoll_viewport.js` — grep'd for `loadPlayer`, `UpdateForRace`, `heritage`, `clickMap`, `PrepareDragIcon`; only `loadPlayer` matched

### What I did NOT read
- `Lib/` and `assets/` subdirs of `external/chorizite/ACBindings/` — out of scope per handoff §6
- The full text of `ui/ac_paperdoll_viewport.js` — accepted the `loadPlayer(setupId, mtableId, paletteId, subPalettes)` signature on grep match; did not verify it propagates animation DID
- The wasm-side dispatch loops in `src/lib.rs` for kind=11 InventoryUpdated event — confirmed via grep that the snapshot path exists; didn't trace the per-event emission code
- `acclient.c` — per anti-pattern #4 the doc-comments need cross-checking against `~/ac-headers/acclient.c` for spec-grade accuracy. This audit treats doc-comments as triage; I have NOT cross-checked any of them against acclient.c. The `m_SlotCheckbox` field naming + the AetheriaBits address `0x142` are both repeated in `inventory.js` from the existing porting work, lending those claims some independent corroboration.

### Classification uncertainty

- **`m_SlotCheckbox` vs. `m_burdenButton` naming gap.** The absorption plan §Wave D.1 specifically calls out `m_burdenButton` as a missing UI feature visible in `User-Interface-10.webp`. The webp file is NOT present anywhere under `external/holtburger/` (only `layout-paperdoll-2026-05-24.png` is). The closest match in `gmPaperDollUI.cs:134` is `m_SlotCheckbox` (a `UIElement_Button`). I treated these as the same feature; if they're distinct, this audit will need a follow-up once the webp surfaces. Filed as §3 issue #1.

- **`m_paperDollDragMask` vs `m_paperDollDragOverlay`** (lines 129/130). Their doc-comments are nearly identical and I classified both as a single missing feature in §3 issue #10. If retail uses one for "accept" and one for "reject" feedback (the typical pattern), they're really one issue with two facets.

- **The bag-tab swap in retail uses gm3DItemsUI; ours uses inline grid swap.** Whether this is N or Partial depends on whether you count "functionally equivalent" or "structurally faithful." I called it Partial on `m_3DItemsUI` and N on `m_contentsText`; another auditor might score both the same way.

### Reading-guide claims to update

- The handoff §4 Wave D.1 row says reading-guide §2 + §6 are "already done for Wave 12+16 paperdoll; this wave is a focused diff." This was accurate — both prior waves' artifacts (the 24-slot table in PAPERDOLL_SLOTS, the deferral of layout 0x21000037 reads, the burden-indicator extraction to status-indicators.js) are tracked in inventory.js header comments and the diff was tractable.
- The handoff §3 anti-pattern #2 ("doc-comments are triage, not spec") held: the `m_SlotCheckbox` doc-comment is empty in `gmPaperDollUI.cs:134` (no `<summary>`), and the absorption plan's `m_burdenButton` label was a guess from a missing screenshot. Lesson confirmed.
- The handoff §5.4 row "ACBindings worked example" relied on reading `ClientMagicSystem.cs`'s doc-comments. I observed the same pattern here: 4 `gm*UI` files surveyed in ~10 minutes, gaps catalogued in another ~15 minutes; cold reading of `acclient.c` for the same 4 panels would have taken hours. Pattern reaffirmed.

**No contradictions found** between this audit and the prior handoff doc.
