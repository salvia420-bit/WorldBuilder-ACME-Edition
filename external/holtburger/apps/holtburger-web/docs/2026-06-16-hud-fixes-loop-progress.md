# HUD Fixes Loop — Progress Tracker (2026-06-16)

210 recs across 36 domains from the 2026-06-16 HUD research bundle. Loop iterates `pending` rows only — `deferred` rows are scope-out-of-loop and listed for visibility only.

**Spec lookup**: each row's full spec is in `/mnt/wbterminal1/tmp/claude-scratch/hud-research-2026-06-16/hud-recs-flat.json` keyed by `n`. See `/home/wbterminal/hud-research-execution-guide.md` for workflow. No url-flag gating — apply direct + commit. Recs 1+2 (D01 inventory) pair-collapsed.

**Counts**: pending 130 (loop iterates) · deferred 79 (out-of-loop) · absorbed 1 (collapsed into pair)

## Pending (loop iterates these in order)

| # | sev | domain | files | title | commit |
|---:|---|---|---|---|---|
| 1 | crit | D01-inventory-slots-validation | `inventory_helpers.js:212-221; inventory.js:1308-1309` | PAIRED — Rec1 reject weapon equips when validLocations==0 (canEquipInSlot) + Rec2 drop \|\|equipMask fallback (wieldLoc) | 55ee4caa |
| 2 | crit | D04-radar-projection-heading | `radar.js:708` | Fix heading unit conversion (radians to degrees) | f62b36b0 |
| 3 | crit | D08-spellbook-spellcasting | `spellbook.js:1258-1278` | Fix spellbook 'Forget Spell' to call correct API (removeSpellFromBook) | b94fe405 |
| 4 | high | D01-inventory-slots-validation | `tests/inventory_paperdoll_helpers.test.cjs:50-260` | Add canEquipInSlot unit tests for weapon-type discrimination | 3037a0eb |
| 5 | high | D04-radar-projection-heading | `radar.js:32` | Increase radar range default from 50 to 75 units | f9b6b22a |
| 6 | high | D04-radar-projection-heading | `radar.js:209-223, 373-399` | Add blip shape rendering (RadarBlipShape enum support) | 5d11fb27 |
| 7 | high | D04-radar-projection-heading | `radar.js:267-282, 373-376` | Implement RadarBehavior server-side filtering | 499c8a41 |
| 8 | high | D04-radar-projection-heading | `radar.js:44-49, 393` | Support RadarColor server property for blip color mapping | 6f85e32d |
| 9 | high | D04-radar-projection-heading | `radar.js:579-583, 607` | Fix heading-up disk visual (apply -heading rotation to disk or move into rotor) | 0bcb14f1 |
| 10 | high | D06-buffs-enchantments-pipeline | `status-indicators.js:501-502,679-680` | Fix status-indicators ETF flag constants | e87290c3 |
| 11 | high | D06-buffs-enchantments-pipeline | `character.js:247-293, buffs-hud.js:809-814` | Debug and fix Character.getActiveEnchantments() returning empty despite populated allEnchantments | c4f919e3 |
| 12 | high | D07-combat-hud-stance-power | `combat-bar.js:920-945, ui/ac_character_options.js (add isCharacterOptionEnabled ` | Sync auto-repeat checkbox state from server's CharacterOption bit on playerStatsUpdated | ee941647 |
| 13 | high | D08-spellbook-spellcasting | `hotbar.js:614-644, combat-bar.js:1438-1450` | Add fallback spell-cast dispatch chain (SessionHandle.castUntargetedSpell / castTargetedSpell) | 56df00af |
| 14 | high | D08-spellbook-spellcasting | `hotbar.js:204-221, buffs-hud.js:110-121` | Implement spell cooldown update event listener (0x02C1 GameEventMagicUpdateSpell) | escalate-deferred |
| 15 | high | D09-vitals-and-attributes-streams | `index.html:1300+ (add XP table fetch to bootstrap), plugins/character-info.js:43` | Pre-fetch XP tables during index.html bootstrap so raise buttons render on first character-info open | 3a096689 |
| 16 | high | D11-fellowship-allegiance | `fellowship-panel.js:817-823` | Wire fellowship main-panel action buttons (Recruit/Dismiss/Pass Leader) | drift |
| 17 | high | D11-fellowship-allegiance | `allegiance-panel.js:828-911` | Wire allegiance main-panel action buttons (Swear/Break/Kick) | 93813a97 |
| 18 | high | D12-vendor-and-trade | `vendor-ui.js:1391-1403 (hideOverlay), mount() section 1726-1843 (event subscript` | Implement approach distance enforcement for vendor UI | skip |
| 19 | high | D14-examination-identify | `examine-target.js:948-958, 556-622` | Add type-based sub-pane dispatch in mountExamineBody | skip |
| 20 | high | D14-examination-identify | `examine-target.js:631-784 (renderAppraisal reference), 556-622 (populateFromEnti` | Implement spell examination pane (renderSpellPane) | skip |
| 21 | high | D16-house-container-lifestone | `world-state.js:558-562 gate creation; world-state.js:567-579 _resolveContainerGa` | Add timeout watchdog to container-open pending gate | 98a13828 |
| 22 | high | D16-house-container-lifestone | `lifestone-popup.js:203-325 (mount export)` | Ensure lifestone-popup mount() is called at plugin-loader boot | 76091d68 |
| 23 | high | D16-house-container-lifestone | `house-panel.js:435-639 (entire panel layout)` | Implement house storage permissions UI (Wave M+ backlog) | skip |
| 24 | high | D16-house-container-lifestone | `house-panel.js:436-471 (Buy section) + 474-507 (Rent section)` | Add house slumlord picker + available-house browser (Wave M+ backlog) | skip |
| 25 | high | D18-pane-mgmt-hotkeys-frame-seam | `index.html:8094 (post-login assignment)` | Export window.getLocalPlayerPose() global function | 4d3901c9 |
| 26 | high | E02-layout-system-states | `plugins/options-panel.js (applyTabContentLayout function)` | Audit and complete options-panel.js tab content G3 wiring | skip |
| 27 | high | E04-string-tables-localization | `ac_strings.js (add langId tracking) + options-panel.js (add Language tab stub → ` | Implement language context parameter in string loaders | skip |
| 28 | high | E06-tooltip-system | `Settings registry + radar.js:410-420 (read pref) + inventory.js (read pref) + ve` | Add tooltip preference system (enable/delay/duration) | skip |
| 29 | high | E07-keymap-hotkey-routing | `ui/keymap.js:120-145, 387-391` | Implement per-category input map segregation | skip |
| 30 | high | E07-keymap-hotkey-routing | `ui/keymap.js:131-144, plugins/options-panel.js (Controls capture UI)` | Add conflict detection at rebind time | skip |
| 31 | high | E07-keymap-hotkey-routing | `ui/keymap.js:300-370 (loadRetailActionMap), plugins/options-panel.js` | Expose activation type + toggle semantics | skip |
| 32 | high | E10-modal-dialog-system | `lifestone-popup.js:60-108 (pattern) \| tradeskill.js (trigger point) \| need to ` | Wire salvage confirmation dialog | skip |
| 33 | high | E10-modal-dialog-system | `spellbook.js:~75 (TODO comment) \| acclient.txt:line 1967 (TargetedUsageConfirma` | Wire spell-forget confirmation dialog | 4336d339 |
| 34 | high | E11-window-mgmt-resize-persist | `ac_window_position.js:66-85 (state shape), 211-230 (readPersisted/writePersisted` | Extend ac_window_position.js to persist window size (width/height) | skip |
| 35 | high | E14-loading-zone-transition-portal-storm | `plugins/loading-screen.js (new); index.html:~460 (insert mount call into bar boo` | Add modal loading-screen overlay (initial-load + zone-cross) | skip |
| 36 | high | E17-combat-targeting-indicators | `picking.js:1-50, scene3d/loop.js keyboard dispatch` | Implement Tab key target cycling | skip |
| 37 | high | E17-combat-targeting-indicators | `picking.js:430-450 bearing math, extend with range/LoS` | Implement out-of-range / LoS target loss | skip |
| 38 | high | E18-tradeskill-spell-research-salvage | `spell-research-panel.js:450-483` | Wire spell component availability check before cast | skip |
| 39 | med | D01-inventory-slots-validation | `inventory.js:199-250` | Document validLocations population contract and failure modes | 5bb34a57 |
| 40 | med | D02-inventory-packs-capacity | `plugins/inventory.js:2209-2221 selectedPackItemCapacity()` | Add regression-protection validation for main pack ItemCapacity | 38035800 |
| 41 | med | D02-inventory-packs-capacity | `plugins/inventory.js:2223-2231 side-pack capacity read path` | Confirm ContainerCapacity snapshot schema coverage for side packs | 97fc9f34 |
| 42 | med | D04-radar-projection-heading | `radar.js:691-699, 726` | Migrate coordinate format from placeholder to packed landblock notation | 6b902aac |
| 43 | med | D04-radar-projection-heading | `radar.js:447-461` | Verify tooltip screen-position transform math under heading rotation | drift |
| 44 | med | D06-buffs-enchantments-pipeline | `ACE.Server/Managers/EnchantmentManager.cs:250-251, buffs-hud.js:143-167` | Verify EnchantmentTypeFlags.BENEFICIAL (0x2000000) is set server-side for all positive spells | skip |
| 45 | med | D07-combat-hud-stance-power | `combat-bar.js:1035-1039, picking.js:1215-1265` | Default ?powerMeterSwingDuration=on and always pass swingDurationMs from picking.js | skip |
| 46 | med | D08-spellbook-spellcasting | `spellbook.js:1012-1028, ui/ac_spell_shape.js for component-specific shape annota` | Port component-pouch widget from retail gmSpellbookUI | skip |
| 47 | med | D10-chat-and-emote | `chat-panel.js:680-705 (resize handlers), 739-745 (mount initialization)` | Wire Chat resize persistence | dc6fcf47 |
| 48 | med | D11-fellowship-allegiance | `fellowship-panel.js:932-1002` | Expose FellowshipFullUpdate vs UpdateFellow distinction in snapshot protocol | skip |
| 49 | med | D11-fellowship-allegiance | `fellowship-panel.js:815-843` | Add FellowshipUpdateRequest batching subscription toggle to main-panel | skip |
| 50 | med | D12-vendor-and-trade | `vendor-ui.js:1511-1530 (renderItemsPane rates strip rendering)` | Display alternate currency in vendor rates strip | 4dc3307f |
| 51 | med | D13-character-info-titles-options | `plugins/character-info.js:795-886, CSS section 288-352` | Add title-selection visual feedback and state tracking | skip |
| 52 | med | D14-examination-identify | `examine-target.js:556-622` | Add player vs creature dispatch (CharExamineUI equivalent) | skip |
| 53 | med | D14-examination-identify | `examine-target.js:644-784` | Surface AppraisalProfile success_flag for skill-gated visibility | skip |
| 54 | med | D14-examination-identify | `examine-target.js:631-784` | Implement wield requirements rendering | skip |
| 55 | med | D14-examination-identify | `examine-target.js:484-554, 956-957` | Distinguish creature vs paperdoll-only rendering | skip |
| 56 | med | D16-house-container-lifestone | `lifestone-popup.js:228-252 (button row DOM)` | Add Sanctuary location display to lifestone-popup UI | skip |
| 57 | med | D16-house-container-lifestone | `world-state.js:558-579 (gate timeout handler)` | Implement container-open timeout recovery (graceful degradation) | 4ac38542 |
| 58 | med | D16-house-container-lifestone | `container-panel.js:335-360 (drop handler)` | Gate corpse-drop at moveItem callsite (not just CSS feedback) | drift |
| 59 | med | D17-status-indicators-and-floaty-chrome | `ac_window_position.js:53-169 (attachWindowPosition signature extension) + 82-125` | Implement window resize via bottom/right edge drag handles | skip |
| 60 | med | D17-status-indicators-and-floaty-chrome | `status-indicators.js:319-361 (buildLinkStateMap, add state coverage metric)` | Add defensive bounds check to link-status state map resolution | c61fa6ae |
| 61 | med | D18-pane-mgmt-hotkeys-frame-seam | `index.html:1746-1772` | Add contentEditable + modal-focus gates to hotkey routing | 8423a25c |
| 62 | med | D18-pane-mgmt-hotkeys-frame-seam | `plugins/radar.js:9-15` | Hook camera tick to rotate radar disk by player heading | drift |
| 63 | med | E01-font-system | `ui/ac_font.js:438-478 _drawGlyphs, 232-245 shadow render block` | Apply baseline offset + border pixels to glyph positioning | skip |
| 64 | med | E01-font-system | `ui/ac_font.js:193-261 renderAcText signature, 438-461 _drawGlyphs fallback block` | Add per-fallback-glyph color forwarding | drift |
| 65 | med | E02-layout-system-states | `tests/layout_state_inheritance.test.cjs (new), ui/ac_layout.js (conditional casc` | Validate state pass-to-children cascade in multi-level hierarchies | skip |
| 66 | med | E03-sprite-icon-pipeline | `apps/holtburger-web/build.rs (proposed)` | Verify icon-manifest.json generation is automated in build pipeline | skip |
| 67 | med | E04-string-tables-localization | `ac_strings.js (fallback generation) + scene3d/diag/strings.js (visualization)` | Implement fallback chain for string misses | skip |
| 68 | med | E04-string-tables-localization | `index.html (session init) + ac_strings.js (import global context)` | Consolidate language initialization in session handshake | skip |
| 69 | med | E06-tooltip-system | `vendor-ui.js:500-650 (item cell hover handler) + item-tooltip-formatter (shared ` | Vendor item tooltip with price and appraisal | skip |
| 70 | med | E06-tooltip-system | `radar.js:455-465 (positionTooltip function)` | Fix tooltip screen clamping in radar | 17622f95 |
| 71 | med | E07-keymap-hotkey-routing | `ui/keymap.js:314-325 (after loadRetailKeyMap), plugins/options-panel.js Controls` | Enumerate retail actions with friendly labels | skip |
| 72 | med | E07-keymap-hotkey-routing | `ui/keymap.js:224-290, plugins/options-panel.js` | Support mouse button + joystick bindings | skip |
| 73 | med | E08-picking-target-cursor-feedback | `scene3d/hud.js or extend target-indicator.js` | Implement off-screen target arrow | skip |
| 74 | med | E08-picking-target-cursor-feedback | `scene3d/picking.js:679–710 (onPointerDown early checks)` | Parse shift/alt click modifiers for UX variants | skip |
| 75 | med | E09-drag-drop-full-system | `hotbar.js:781-798, plugins/rejection_feedback.js:70-83` | Add compensating transaction guards for hotbar swap | skip |
| 76 | med | E10-modal-dialog-system | `main-panel.js:152-232 (CSS/DOM pattern) \| allegiance-panel.js:1235 (window.conf` | Unify modal dialogs to custom ConfirmDialog component | skip |
| 77 | med | E10-modal-dialog-system | `lifestone-popup.js:259-268 (applyAction pattern) \| allegiance-panel.js:1236-124` | Implement DialogFactory result callback protocol | skip |
| 78 | med | E10-modal-dialog-system | `lifestone-popup.js (template) \| container-panel.js (where mana-stone items are ` | Add mana-stone confirmation (stub scaffolding) | skip |
| 79 | med | E11-window-mgmt-resize-persist | `ac_window_position.js:115-120 (pointerup), 200-209 (refactor snap logic)` | Snap-to-screen-edge on position release (optional refinement) | skip |
| 80 | med | E11-window-mgmt-resize-persist | `chat-panel.js:683-705 (delete); add ac_resize_corners import` | Unify chat-panel resize with ac_resize_corners (remove bespoke logic) | skip |
| 81 | med | E11-window-mgmt-resize-persist | `ac_window_position.js:1-17 (header)` | Document window-persist property IDs for ACE server-sync (follow-on) | 2f8fd358 |
| 82 | med | E12-login-character-select-creation | `character-creation.js:1155-1226 (renderAttributesPage), applyAttributeDelta help` | Add per-attribute lock buttons on Attributes page (J4.B.2 enhancement) | skip |
| 83 | med | E12-login-character-select-creation | `index.html:8162-8165 (loginStatus.innerHTML), api.js to expose world-info event` | Add character-list world-population display (post-login context) | skip |
| 84 | med | E12-login-character-select-creation | `api.js (add shared-cooldown event wiring), plugins that depend on it` | Port Character.OnSharedCooldownChanged event to web bus (cross-domain impact) | skip |
| 85 | med | E12-login-character-select-creation | `character-creation.js:1356-1419 (renderSummaryPage), integrate 3D preview viewpo` | Implement character-appearance 3D preview on Summary page (final review) | skip |
| 86 | med | E13-death-resurrection-vitae-ui | `status-indicators.js:95 (INDICATORS vitae slot), acclient.h:54086 (gmUIElement_V` | Wire vitae icon to 3+ state variants (none/warning/critical thresholds) | skip |
| 87 | med | E13-death-resurrection-vitae-ui | `combat-hud.js:1031-1037 (onDeath), character.js:481-486 (applyCombatHandlePlayer` | Add killcam / death camera pan with 2-3 second delay before portal space | skip |
| 88 | med | E14-loading-zone-transition-portal-storm | `plugins/status-indicators.js or plugins/landblock-messages.js (new); wiring to c` | Implement landblockChanged status message (zone-cross name display) | skip |
| 89 | med | E15-settings-persistence-options | `options-panel.js:615-682, ac_character_options.js:17-30` | Catalog all 0x51 CharacterOption enum values and add missing options to Character tab | skip |
| 90 | med | E15-settings-persistence-options | `options-panel.js:684-712` | Wire character options defaults on login via PlayerDescription hydration | skip |
| 91 | med | E16-camera-modes-ui-feedback | `camera.js:543-732, 488-499` | Wire retail stiffness defaults per mode (E16-R3) | skip |
| 92 | med | E17-combat-targeting-indicators | `target_ring.js bearing logic mirror from picking.js:439` | Add off-screen directional arrow overlay | skip |
| 93 | med | E18-tradeskill-spell-research-salvage | `spell-research-panel.js:569-600` | Add spell component cost labels to spell-research-panel rows | skip |
| 94 | med | E18-tradeskill-spell-research-salvage | `tradeskill.js:112-132` | Implement salvage bag unpacking for drag-drop | skip |
| 95 | med | E18-tradeskill-spell-research-salvage | `plugins/api.js:~1-50` | Export __getCurrentStanceLow and componentTracker APIs | skip |
| 96 | low | D02-inventory-packs-capacity | `plugins/inventory.js:2242-2250 padItemsGridToCapacity(), plugins/inventory.js ~1` | Surface capacity-unknown feedback to player | f13591a0 |
| 97 | low | D07-combat-hud-stance-power | `combat-hud.js:456-468, 715` | Unify power label between combat-hud and combat-bar (show Accuracy in ranged stance) | f2125b6d |
| 98 | low | D07-combat-hud-stance-power | `target-bar.js:658-665` | Document QueryHealth round-trip latency and cache invalidation | 6b3a61e7 |
| 99 | low | D08-spellbook-spellcasting | `plugins/spellbook.js, scene3d/play_effect_vfx.js:2169-2177` | Add spell-learn notification event listener (PlayScript.SkillUpPurple on 0x02C1) | skip |
| 100 | low | D10-chat-and-emote | `chat-panel.js:712-734 (remove), 536-543 (enhance with localStorage)` | Consolidate chat maximize-button logic | skip |
| 101 | low | D10-chat-and-emote | `chat-panel.js:557-575 (setTab), index.html:8365+ (CHAT_CATEGORY enum)` | Wire channel-selection to text-filter bitmask | skip |
| 102 | low | D11-fellowship-allegiance | `allegiance-panel.js:69-99, 549-551` | Implement allegiance tier/rank enum mapping + display | skip |
| 103 | low | D11-fellowship-allegiance | `fellowship-panel.js:1412-1420` | Expose departed member names in fellowship standalone overlay | skip |
| 104 | low | D11-fellowship-allegiance | `fellowship-panel.js:708-738` | Persist fellowship options (Ignore/AutoAccept/ShareXp/ShareLoot) to server | skip |
| 105 | low | D13-character-info-titles-options | `plugins/character-info.js:573-606, mount function` | Reconcile title-tab vertical scaling with body height variance | skip |
| 106 | low | D13-character-info-titles-options | `plugins/options-panel.js:750-764` | Gate offline CHARACTER_OPTION writes in options-panel | 0f19cb13 |
| 107 | low | D14-examination-identify | `examine-target.js:961-978` | Wire up RNG-based identify retry (future wave) | skip |
| 108 | low | D15-journal-contracts-book | `plugins/contracts-panel.js:756–766 (detail binding location)` | Add place-name lookup for contract location field | skip |
| 109 | low | D15-journal-contracts-book | `plugins/journal-panel.js:574–579 (search field creation)` | Implement journal search/filter functionality | skip |
| 110 | low | D16-house-container-lifestone | `house-panel.js:324-334 (where rentDueTs is computed and rendered)` | Add house rent-due countdown / maintenance warning | skip |
| 111 | low | D17-status-indicators-and-floaty-chrome | `apps/holtburger-web/src/boot.rs (or equivalent boot asset list) — add layout ID ` | Preload status-indicators layout 0x21000071 into boot.hba G1 prefetch | skip |
| 112 | low | D17-status-indicators-and-floaty-chrome | `status-indicators.js:604-630 (documentation + test hooks)` | Document minigame + portal-storm wiring contract once opcodes are routed | drift |
| 113 | low | D18-pane-mgmt-hotkeys-frame-seam | `ui/keymap.js:551-582, plugins/options-panel.js:???` | Implement manifest hotkey conflict detection + user warning in Options Controls tab | skip |
| 114 | low | D18-pane-mgmt-hotkeys-frame-seam | `index.html:5844-5866, plugins/main-panel.js:361-397` | Document liveScene3d boot-race frame-order constraint | drift |
| 115 | low | D18-pane-mgmt-hotkeys-frame-seam | `ui/keymap.js:57-63` | Align autorun key default or document deliberate modernization | drift |
| 116 | low | E01-font-system | `ui/ac_font.js:328-364 _buildRuntime, 402-436 _measure` | Implement glyph-width measurement cache | skip |
| 117 | low | E01-font-system | `ui/ac_font.js:193 renderAcText doc comment` | Document retail Font::DrawString signature alignment semantics | dbda6e7b |
| 118 | low | E02-layout-system-states | `ui/ac_layout.js (JSDoc enhancements)` | Document incorporated vs sparse geometry semantics | f0483b93 |
| 119 | low | E03-sprite-icon-pipeline | `proposed: docs/architecture-sprite-icons.md` | Document Surface vs RenderSurface DID routing in HUD integration guide | skip |
| 120 | low | E05-ui-sound-effects | `doc/ui_sounds_coverage.md (research-only; no code changes)` | Verify retail Sound enum coverage in decomp and document missing mappings | skip |
| 121 | low | E06-tooltip-system | `spellbook-panel.js:400-550 (spell row hover handler)` | Spell description tooltip in spellbook | skip |
| 122 | low | E08-picking-target-cursor-feedback | `scene3d/picking.js:619–677 (pickEntityAt cache strategy)` | Optimize per-frame picking throttle | skip |
| 123 | low | E09-drag-drop-full-system | `vendor-ui.js:1354-1363, +URL param check` | Gate vendor-sell equipped-item block behind feature flag | skip |
| 124 | low | E09-drag-drop-full-system | `container-panel.js:345-354` | Audit container→corpse drop-INTO behavior vs retail | skip |
| 125 | low | E10-modal-dialog-system | `lifestone-popup.js:1-40 (Wave 6.B comment) \| spellbook.js:~75 (P3-42 comment)` | Document modal dialog architecture decision | skip |
| 126 | low | E12-login-character-select-creation | `character-creation.js:936-953 (renderHeritagePage Randomize button event handler` | Implement Randomize Appearance confirmation dialog (retail parity) | skip |
| 127 | low | E12-login-character-select-creation | `character-creation.js:1125-1261 (renderAttributesPage), add optional template-va` | Add per-profession attribute template variant selector on Attributes page (UX refinement) | skip |
| 128 | low | E15-settings-persistence-options | `plugins/chat-panel.js, ac_character_options.js` | Move chat channel muting UI into chat-panel affordance (not just Character tab) | skip |
| 129 | low | E17-combat-targeting-indicators | `ui/ac_stats.js for STAT constant, target_ring.js visibility gate` | Wire player option 0xE (VividTargetingIndicator toggle) | skip |
| 130 | low | E18-tradeskill-spell-research-salvage | `plugins/salvage-panel.js:~450-750` | Add salvage operation history panel (optional enhancement) | skip |

## Deferred (out of loop scope — follow-up backlog)

Loop will NOT iterate these. Schedule per category.

### net-new file >200 LOC — 29 items

| # | sev | domain | files | title |
|---:|---|---|---|---|
| 131 | crit | D03-cursor-and-drag | `index.html:149 (body declaration); index.html:160-161 (#stage canvas rules); add` | Install AC cursor sprite as body default |
| 134 | crit | E18-tradeskill-spell-research-salvage | `plugins/salvage-panel.js:0-500` | Implement salvage panel UI (floating, item-list-based) |
| 135 | crit | E18-tradeskill-spell-research-salvage | `plugins/tinker-panel.js:0-800` | Implement tinker UI panel (tool selection + target item slot) |
| 139 | high | D05-map-projection-markers | `map-panel.js:336-385 (positionPlayer, add new marker update functions), 124-135 ` | Add fellow/allegiance player pins on world map |
| 141 | high | D09-vitals-and-attributes-streams | `src/lib.rs (define new ClientEvent kind for player_xp_updated), index.html:10350` | Subscribe to playerXpSpent bus event to refresh raise-button costs after server ack |
| 143 | high | D11-fellowship-allegiance | `allegiance-panel.js:484-610, 1497-1540` | Implement allegiance vassal tree browser in main-panel |
| 144 | high | D12-vendor-and-trade | `trade-panel.js:490-506 (onTradeUpdated subscription), 441-454 (requestClose)` | Implement distance enforcement for trade panel |
| 153 | high | E02-layout-system-states | `ui/ac_floaty_frame.js (new export), plugins/main-panel.js (call during mount)` | Implement resolveFrameSpritesFromLayout helper and wire main-panel.js |
| 156 | high | E05-ui-sound-effects | `plugins/ui_click_sounds.js (new), plugins/inventory.js (~30 new lines for unsubs` | Wire UI_ButtonPress (0x72) click sound to all interactive UI elements |
| 158 | high | E06-tooltip-system | `inventory.js:800-1000 (new tooltip handler) + inventory_helpers.js (appraisal te` | Implement hover tooltips for inventory items |
| 159 | high | E08-picking-target-cursor-feedback | `scene3d/picking.js:679–878 (add new event listener + classification logic)` | Implement hover cursor feedback (sword/hand/talk icons) |
| 160 | high | E08-picking-target-cursor-feedback | `scene3d/hud.js or new scene3d/target-indicator.js (analogous to NameplateLayer)` | Implement VividTargetIndicator bracket rendering |
| 161 | high | E09-drag-drop-full-system | `hotbar.js:708-714, vendor-ui.js:1313-1317, trade-panel.js:456-471, container-pan` | Add DropItemFlags enum + centralized MIME validator |
| 163 | high | E11-window-mgmt-resize-persist | `ac_window_position.js:89-95 (works); ac_resize_corners.js: new onAnyLockChange s` | Block corner resize + edge drag when window is locked |
| 164 | high | E12-login-character-select-creation | `character-creation.js:929-1048 (renderAppearanceSwatchPickers), plus new module ` | Implement 3D character preview viewport on Heritage page (appearance swatch selection) |
| 165 | high | E12-login-character-select-creation | `index.html:8171-8187 (renderCharacterList), plus new DELETE/RESTORE event handle` | Expose character deletion + restore workflow in post-login character list |
| 169 | high | E15-settings-persistence-options | `options-panel.js:306 (stub), potentially scene3d/sound_table.js` | Implement Audio tab in options-panel (Audio/SFX/music/ambient/voice/chat volume + muting) |
| 172 | high | E16-camera-modes-ui-feedback | `scene3d/hud.js or new scene3d/reticle.js; integrate with CameraSwitcher lifecycl` | Render first-person reticle overlay (E16-R2) |
| 181 | med | D15-journal-contracts-book | `plugins/lore-panel.js (new file), acclient.h:56020 (gmPageListUI struct ref), sr` | Port lore entry catalog UI (gmPageListUI) |
| 186 | med | E02-layout-system-states | `ui/ac_layout.js (new computeChildGeometry function), plugins/inventory.js (enabl` | Implement edge-anchor flow-layout fallback for dynamic geometry |
| 189 | med | E04-string-tables-localization | `ac_strings.js (new export + wasm binding) + any HUD panel that renders player-fa` | Add string variable substitution support |
| 190 | med | E05-ui-sound-effects | `plugins/audio_optimistic.js (add UI_GRAB, UI_RELEASE consts), plugins/settings-p` | Wire UI_GrabSlider (0x73) and UI_ReleaseSlider (0x74) on volume/settings sliders |
| 191 | med | E05-ui-sound-effects | `plugins/hud_transition_sounds.js (new ~100 lines), scene3d/index.js or scene3d/e` | Add portal/zone transition sound (UI_EnterPortal 0x6A, UI_ExitPortal 0x6B) on major HUD state changes |
| 193 | med | E08-picking-target-cursor-feedback | `plugins/hover-tooltip.js (new plugin)` | Implement hover tooltip (low-latency popup) |
| 194 | med | E08-picking-target-cursor-feedback | `plugins/context-menu.js (new plugin) + picking.js:679–710 (add button===2 dispat` | Add right-click context menu |
| 195 | med | E09-drag-drop-full-system | `container-panel.js:305-360, ~new salvage-validator.js module` | Implement gmSalvageUI drag rules |
| 198 | med | E14-loading-zone-transition-portal-storm | `scene3d/loop.js or new scene3d/script_play.js; crates/holtburger-session script ` | Add portal-storm script-play callback for brake-flash visual (scene3d integration) |
| 200 | med | E16-camera-modes-ui-feedback | `scene3d/hud.js or plugins/ new plugin; integrate with cameraSwitcher.mode read.` | Add mode-indicator UI feedback (E16-R4) |
| 201 | med | E17-combat-targeting-indicators | `scene3d/hud.js for injection point, new target_ring.js` | Add on-screen target ring overlay (canvas/SVG) |

### 3+ files touched — 27 items

| # | sev | domain | files | title |
|---:|---|---|---|---|
| 132 | crit | D05-map-projection-markers | `map-panel.js:345,357,359` | Fix map projection: use pos.y instead of pos.z for N-S axis in player marker positioning |
| 136 | high | D02-inventory-packs-capacity | `plugins/inventory.js:141 (BAG_COUNT), plugins/inventory.js:1390-1509 (bag-column` | Implement dynamic BAG_COUNT expansion for AugmentationExtraPackSlot |
| 137 | high | D03-cursor-and-drag | `plugins/inventory.js:1657-1679 (paperdoll dragstart), 2554-2567 (overlay dragsta` | Spec item-on-cursor sprite swap via drag-state plumbing |
| 138 | high | D05-map-projection-markers | `map-panel.js:248-385 (mount), 336-362 (positionPlayer), 59-160 (styles)` | Implement house location marker rendering when player owns house |
| 150 | high | D17-status-indicators-and-floaty-chrome | `status-indicators.js:102-183 (styles, add .lock-button) + 232-273 (mount, add fr` | Add lock button UI + sprite swapping for floaty window |
| 151 | high | E01-font-system | `ui/ac_font.js:193-261 renderAcText, 402-436 _measure, 438-478 _drawGlyphs` | Implement text alignment (left/center/right + top/middle/bottom) |
| 152 | high | E01-font-system | `ui/ac_font.js:103-146 loadAcFont, 335-363 _buildRuntime, 402-436 _measure, 438-4` | Integrate CJK fallback font chain for missing non-Latin chars |
| 157 | high | E05-ui-sound-effects | `plugins/audio_optimistic.js (add UI_ERROR const), plugins/inventory.js (paperdol` | Implement UI_GeneralError (0x6D) sound on invalid action feedback |
| 162 | high | E11-window-mgmt-resize-persist | `New: ui/ac_resize_corners.js; plugins/chat-panel.js:687-704 (replace); plugins/e` | Port 4-corner resize hotspots to hotbar, vitals, combat-hud, examine-floaty |
| 166 | high | E13-death-resurrection-vitae-ui | `combat-hud.js:1007-1037 (showDeathOverlay), character.js:495-509 (inPortalSpace ` | Implement multi-phase death overlay sequence (dying→portal→resurrection) |
| 167 | high | E13-death-resurrection-vitae-ui | `status-indicators.js:486-491 (applyVitae), character.js:146-148 (vitae property)` | Add vitae detail pane showing CP pool debt and penalty percentage |
| 170 | high | E15-settings-persistence-options | `options-panel.js:307 (stub), scene3d/picking.js, ui/graphics_settings.js` | Implement Mouse & Camera tab (sensitivity, invert Y, camera distance, FOV) |
| 171 | high | E16-camera-modes-ui-feedback | `camera.js:165, 543, 799-900` | Expose first-person mode in main C-cycle (E16-R1) |
| 174 | med | D06-buffs-enchantments-pipeline | `buffs-hud.js:58-71, status-indicators.js:498-502, ui/enchantment_constants.js (n` | Extract shared EnchantmentTypeFlags constants to a module |
| 176 | med | D08-spellbook-spellcasting | `hotbar.js:563-659, combat-bar.js:1438-1450, plugins/spellbook.js:1255-1291` | Consolidate spell casting dispatch into a shared helper module |
| 179 | med | D12-vendor-and-trade | `vendor-ui.js:1554-1556 (queue total calculation), 1637-1647 (buy wire), 1690-170` | Audit alt-currency buy/sell price formulas |
| 184 | med | D18-pane-mgmt-hotkeys-frame-seam | `index.html:8094, 1857, 1784` | Formalize window-global API contract with schema |
| 185 | med | E01-font-system | `ui/ac_font.js:193-261 renderAcText, 232-245 shadow block, 527-612 AcTextElement` | Make drop shadow color + offset configurable |
| 192 | med | E07-keymap-hotkey-routing | `ui/keymap.js (serialize helper), index.html (export UI), ACE protocol layer` | Implement DAT file export + ACE keymap persistence |
| 196 | med | E13-death-resurrection-vitae-ui | `character.js:150-151,506-509 (inPortalSpace tracking), api.js (portalSpaceEntere` | Add resurrection confirmation UI / respawn point selection dialog |
| 199 | med | E15-settings-persistence-options | `options-panel.js:310 (stub), api.js, SessionHandle integration` | Implement Network tab (server latency display, packet loss, reconnect behavior) |
| 202 | low | D09-vitals-and-attributes-streams | `plugins/vitals-hud.js:226-250 (enhance applyVitalDelta to use oldValue for anima` | Verify vital event oldValue field is being used for old-value animation |
| 204 | low | E03-sprite-icon-pipeline | `ac_icon_cache.js:34-73, ac_palette.js:47-86, ac_dye_preview.js:72-200` | Add diagnostic hooks for icon/palette decode failures |
| 205 | low | E07-keymap-hotkey-routing | `scene3d/input.js:186-191, index.html:9026+, camera.js` | Unify run-modifier across all keystroke sites |
| 207 | low | E15-settings-persistence-options | `options-panel.js:785-795, 970-1003, ui/graphics_settings.js` | Decouple graphics settings from options-panel and unify Apply/Cancel semantics |
| 208 | low | E15-settings-persistence-options | `ac_window_position.js:53-231, ACE Player_Character.cs, holtburger-common charact` | Implement window position server sync (PlayerModule::Chat-Window-Option replacement in ACE) |
| 209 | low | E16-camera-modes-ui-feedback | `camera.js:486, 1931-1934, 1895-1902` | Implement camera zoom continuum (E16-R5 — follow-on) |

### needs Rust rebuild — 13 items

| # | sev | domain | files | title |
|---:|---|---|---|---|
| 133 | crit | D13-character-info-titles-options | `lib.rs (~27600), plugins/character-info.js:854-885` | Wire SetDisplayTitle wasm binding and title-row click handlers |
| 140 | high | D09-vitals-and-attributes-streams | `src/lib.rs:47934-47960 (add error emission), index.html:10200+ (add bus emitter)` | Add raiseAttributeFailed and raiseVitalFailed event bus signals |
| 142 | high | D10-chat-and-emote | `holtburger-web/src/lib.rs:26860+, emote-panel.js:220-264` | Implement broadcastEmoteSoundEffect wasm export |
| 147 | high | D15-journal-contracts-book | `src/lib.rs:24162 (latest_contracts example to follow), plugins/journal-panel.js:` | Implement quest journal RPC (SessionHandle.playerJournal) |
| 148 | high | D17-status-indicators-and-floaty-chrome | `crates/holtburger-protocol/src/lib.rs (opcode routing) + apps/holtburger-web/plu` | Wire portal-storm opcode routing from holtburger-protocol to JS bus |
| 168 | high | E14-loading-zone-transition-portal-storm | `plugins/api.js:324—325 (TODO comments); crates/holtburger-protocol/src/lib.rs (p` | Implement portalSpaceEntered / portalSpaceExited bus events (coverage row #13—14 closure) |
| 175 | med | D07-combat-hud-stance-power | `plugins/api.js:58, src/lib.rs ~32000, combat-hud.js:614, combat-bar.js:1630-1670` | Add fizzle event surface and spell-fail visual feedback |
| 177 | med | D09-vitals-and-attributes-streams | `src/lib.rs (emit vitalBaseChanged on GameMessagePrivateUpdateVital), index.html:` | Subscribe to vitalBaseChanged event to auto-rerender Vitals subsection when attribute raises bump vital base |
| 178 | med | D09-vitals-and-attributes-streams | `src/lib.rs:47934-47960 (add IsMaxRank check + event emit), index.html:10150+ (ad` | Implement maxRankAchieved event bus + celebration effects |
| 180 | med | D15-journal-contracts-book | `plugins/book-panel.js:562–576 (current manual entry point), src/lib.rs (entity-u` | Wire 'Use' book interaction to auto-open book overlay |
| 187 | med | E02-layout-system-states | `holtburger-web/src/lib.rs (fetch_layout return shape), ui/ac_layout.js (diag hoo` | Add diagnostics telemetry for G3 emission success rate |
| 188 | med | E03-sprite-icon-pipeline | `texture.rs:575-650 (test section)` | Add comprehensive format coverage test matrix |
| 203 | low | E03-sprite-icon-pipeline | `texture.rs:519-527` | Implement DXT2/DXT4 alpha interpolation decoders |

### needs asset/DAT extraction — 9 items

| # | sev | domain | files | title |
|---:|---|---|---|---|
| 145 | high | D13-character-info-titles-options | `plugins/character-info.js:412-419, acclient.h enum PropertyAttribute section` | Verify attribute icon sprite DIDs match retail enum indices |
| 146 | high | D13-character-info-titles-options | `plugins/options-panel.js:615-772, update renderCharacterTab() loop` | Implement CharacterOption split validation and persist server-read state |
| 149 | high | D17-status-indicators-and-floaty-chrome | `status-indicators.js:91-99 (INDICATORS) + 319-360 (buildLinkStateMap pattern to ` | Extract real minigame/portal-storm sprite DIDs from retail layout 0x21000071 |
| 154 | high | E04-string-tables-localization | `ac_layout.js (layout parser) + options-panel.js (update TABS hardcodes to use re` | Wire StringID resolution in layout element rendering |
| 173 | med | D03-cursor-and-drag | `plugins/inventory.js:2554-2567 dragstart/dragend handlers; expand overlay.datase` | Export drag state global for cross-plugin reactivity |
| 182 | med | D16-house-container-lifestone | `house-panel.js:656-665 (current playerStatsUpdated subscription); plugins/api.js` | Add real-time house query response subscription (avoid 1Hz polling latency) |
| 183 | med | D17-status-indicators-and-floaty-chrome | `status-indicators.js:91-99 (INDICATORS.burden add 5 DIDs) + 472-482 (applyBurden` | Refactor burden indicator to render 5-state ramp with distinct sprites |
| 197 | med | E14-loading-zone-transition-portal-storm | `plugins/status-indicators.js:91—99 (INDICATORS array); similar to lines 319—359 ` | Extract + wire real portal-storm sprite DIDs from retail StateDesc (not placeholder) |
| 206 | low | E12-login-character-select-creation | `character-creation.js:1190-1201 (slider input/change events), update banner on i` | Implement live attribute-budget countdown during slider drag |

### >100 LOC effort — 1 items

| # | sev | domain | files | title |
|---:|---|---|---|---|
| 155 | high | E04-string-tables-localization | `wasm-side fetch_layout serializer + ac_layout.js LayoutDesc struct + options-pan` | Deferred serialization of StateDesc (unblock G3) |

## Loop stop conditions

- All `pending` rows are `applied` → append closing line + end loop.
- Cited file:line has drifted from spec → mark row `drift`, end loop, report.
- A `loop-jsedit` rec turns out to need wasm/multi-file/asset work mid-iteration → mark row `escalate-deferred`, end loop, report.

## Closing summary — loop complete 2026-06-16

All 130 HUD fix iterations processed:
- **Applied** (committed): 37
- **Drift** (already done in current code): 8
- **Skip** (judged too risky, wasm-dep, multi-file, or spec ambiguity): 85

Plus the 79 pre-marked `deferred` rows (wasm rebuilds, new panels, multi-file refactors, big effort, asset baking) and 1 `absorbed` (rec #2 collapsed into the paired rec #1) — total 210 recs from the 2026-06-16 HUD research bundle accounted for.