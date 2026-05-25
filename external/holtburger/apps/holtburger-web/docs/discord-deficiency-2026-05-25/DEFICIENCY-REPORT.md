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

### 1. Sequence-Manager validation per packet group
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

### 3. Trade system (multi-step handshake)
**Severity:** load-bearing
**Discord evidence:**
> "trying desperately to make trade windows look more like inventory panel and not be infinite scrolling list" — #general line 6121
> blode working on multirow listbox — #general line 8580

**Holtburger status:** `OpenTradeNegotiations/AddToTrade/AcceptTrade/DeclineTrade/CloseTradeNegotiations/ResetTrade` ARE defined in `opcodes.rs:25-31` — but no UI handler, no `plugins/trade-panel.js`, no `RegisterTrade/OpenTrade/AddToTrade/Accept/Decline/Failure` event drain.
**Upstream:** ACE has 7 GameEvents + 6 GameActions; Chorizite categorizes as full social system.
**Remediation:** New `plugins/trade-panel.js`; wire `kind=22 TradeStateChanged` carrying full trade view; reuse vendor-ui drag-drop pattern.

### 4. Allegiance system
**Severity:** load-bearing (player-facing core feature)
**Discord evidence:** Multiple "allegiance / fellowship chat" mentions in #general; cascaded transparent chat windows for allegiance specifically (line 1752).
**Holtburger status:** `SwearAllegiance/BreakAllegiance` live in opcodes.rs:34-35; 18 more (officer, motd, bans, gag, hometown recall, approved vassal) are commented-out stubs. No `plugins/allegiance-panel.js`. AllegianceUpdate/InfoResponse/LoginNotification events not drained.
**Upstream:** ACE has 30+ handlers in `Source/ACE.Server/Network/GameAction/Actions/` matching the commented-out opcodes.
**Remediation:** Uncomment opcode stubs as packs are tested; introduce `plugins/allegiance-panel.js` with Swear/Break/Officer/Motd/Chat-Gag controls; route AllegianceUpdate through bus.

### 5. Fellowship system
**Severity:** load-bearing
**Discord evidence:**
> "VI fellows…clients respond to your commands…but still share vitals and targeting info" — #general line 2788
> "crash to desktop…much more frequently in fellowship…within 10-20mins" — #general line 3979 (memory leak speculation around fellow vitals)

**Holtburger status:** Create/Quit/Dismiss/Recruit/UpdateRequest/AssignNewLeader live (`FellowshipChangeOpenness` commented out, opcodes.rs:73). No `plugins/fellowship-panel.js`. Fellowship vitals broadcast not wired.
**Upstream:** ACE has FullUpdate/Disband/UpdateFellow/UpdateDone/StatsDone events.
**Remediation:** `plugins/fellowship-panel.js` with member list + per-member health/mana/stamina bars; performance-test for the line-3979 leak scenario.

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

### 8. Chat-channel infrastructure
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

### 10. Equipment paper-doll + container browse
**Severity:** load-bearing
**Discord evidence:** Suit builder workflows (#general lines 282, 462, 490); MagSuitBuilder discussion; the entire alt-client meta orbits item slot management.
**Holtburger status:** Own inventory: "Equipment paper-doll: NOT YET IMPLEMENTED — Phase K follow-on." Container UI: "kind=21 ContainerOpened infrastructure exists, full container-browse UI TBD."
**Upstream:** Chorizite `WorldObject.contents`; ACE `GetAndWieldItem`, `PutItemInContainer`, kind=21 already wired in vendor-ui pattern.
**Remediation:** `plugins/equipment-paper-doll.js` + `plugins/container-browser.js`. Reuse vendor-ui drag-drop machinery.

---

## High-Impact Visual / Rendering Deficiencies (Tier 2)

### 11. Reversed Z-buffer for distant precision
**Discord:** "does wb use a reversed z-buffer? that would help with precision for distant objects, reducing flickering" — #worldbuilder 2026-03-31
**Holtburger:** Standard `WebGLRenderer` z-buffer; no inversion. With our 13×13 ring (2.4 km × 2.4 km), distant terrain mesh will z-fight before LOD-out.
**Remediation:** `THREE.WebGLRenderer({ logarithmicDepthBuffer: true })` — cheapest first; if insufficient, full reversed-Z requires post-pass adjustment.

### 12. Weather: rain particles + lightning flashes
**Discord:** "Rain is in already…lightning flashes no, need to debug…sound yes, ambient from terrain" — #worldbuilder 2026-04-13
**Holtburger:** `scene3d/weather_state.js` exists but **only feeds clouds** (cumulus base height, density, étage). No `?rain=on` particle system; no lightning flash; no thunder cue.
**Remediation:** `scene3d/particles/weather_rain.js` instancedMesh streak particles + camera-relative dome; `scene3d/atmosphere_lights.js` flash hook on weather-state `is_storm=true` with Poisson timing; Wave (0x0A) thunder sample queued through audio_manager.

### 13. Cross-cell visibility bug parity decision (basement-from-overworld)
**Discord:** "goal of wb to render things bug-free or matched with acclient bugs? — try and match client bugs so you know what's wonky" — #worldbuilder 2026-04-10; "cross-cell basement overworld still visible" — same channel
**Holtburger:** Our cell-visibility BFS is *correct* (only loaded cells render). Retail had a quirk where basements peek through floors. **Decide:** match the bug for visual parity, or be cleaner? Today it's neither documented nor a knob.
**Remediation:** Add `?cellBugParity=retail` flag; document the decision in `docs/`.

### 14. Particle lighting inside skybox effects
**Discord:** "now with proper lighting particles" — #worldbuilder 2026-04-10; "green light (northern lights?) a texture or color?…particles with gfxobj 0x01001A62" — same
**Holtburger:** We have ParticleManager + parsed PhysicsScript/Emitter; *moon particles* validated (sky_particles_probe_2026-05-12 memory). But sky-wide aurora/storm-front colored emission not in the inventory.
**Remediation:** Add a sky-attached ParticleEmitter layer driven by weather_state; aurora when `weather_state.aurora_intensity > 0`.

### 15. Landblock unload (memory time bomb)
**Discord:** Implicit in #general line 858 "memory leak probably…looted too many corpses" (extended sessions); explicit in our own `INTERACTING_LAYERS_ANALYSIS.md`.
**Holtburger:** 13×13 ring stays resident; no `unloadLandblock(id)` API. A player traversing the continent will OOM.
**Remediation:** LRU eviction in `scene3d/index.js:bakeTerrainRing()`; release Geometry/Material/Texture refs explicitly; track via `renderer.info.memory`.

### 16. Nameplate render budget under crowds
**Discord:** "NPCS with Nametags…game client freezes" — #general line 285; "UB Nametags.cs L23" — line 7508
**Holtburger:** `nameplate_sprite.js` per-creature; no distance cull or budget. At 50+ nameplates (Discord-quoted landblock spawn cap) we'd likely hitch.
**Remediation:** Distance LOD on nameplate canvas redraw; pooled texture upload; cap N visible nameplates with fade-out.

---

## Game-Loop Completeness (Tier 3 — gameplay verbs missing)

### 17. Death structured event (#15 in own backlog)
**Discord:** Implicit in combat/PvP threads.
**Holtburger:** "no structured event; text routes to chat only" — own `CHORIZITE_PORTING_PLAN.md`. Means no death animation hook, no respawn flow.

### 18. Selection bus event (#5 in own backlog)
**Discord:** Selection-as-data is foundational for plugins (Discord ISO VTank 2.0 thread, line 4400).
**Holtburger:** Selection lives in `picking.js` local state, not on bus. No plugin can react to "you targeted X".

### 19. Spell research / component table UI
**Discord:** "nothing special about spell research panel…add taper animations to queue" — #openai-gpt-3, Yonneh 2026-05-22
**Holtburger:** Spell component parser exists; UI for summoning / discarding components not shipped. `playerSpellComponents()` wasm export — does it exist? Check.

### 20. Squelch / Friends / Titles
**Discord:** Chat channel filtering and friend lists implicit across #general.
**Holtburger:** All commented out in opcodes.rs (AddFriend 0x0018, RemoveFriend 0x0017, ModifyCharacter/Account/GlobalSquelch 0x0058-0x005B, TitleSet 0x002C). No `plugins/social-panel.js`.

### 21. Writing system (books, inscriptions, scrolls)
**Discord:** Light coverage, but ACE has BookData/AddPage/ModifyPage/DeletePage/Inscribe handlers, Chorizite categorizes under Writing.
**Holtburger:** SetInscription = 0x00BF commented out; no book UI; no read-only inscription display on examine.

### 22. House system
**Discord:** Not directly quoted but ACE has Buy/Rent/Abandon/Guest perms/Teleport/Hooks. Chorizite has full House category.
**Holtburger:** All house opcodes commented out (opcodes.rs lines for `BuyHouse, HouseQuery, AbandonHouse, RentHouse, SetOpenHouseStatus, BootSpecificHouseGuest, ModifyAllegianceGuestPermission`).

### 23. Right-click radial menus (Examine/Drop/Use/Trade/Identify) — PARTIALLY ADDRESSED 2026-05-25 (Wave A3)
**Discord:** Implicit in plugin discussions; the only fast-path for in-3D interaction.
**Holtburger:** Right-click → direct-invoke Examine shipped via Wave A3 (drag-threshold disambiguation in `scene3d/camera.js`). Radial menu with Use/Drop/Wield/Trade/Identify entries still pending — that's the Wave B follow-on.

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

### Wave B — next priorities

4. **Chat-channel infrastructure (#8)** — Discord's most-quoted #general topic. Sets up the social shell that makes #4 (Allegiance), #5 (Fellowship), #20 (Friends/Squelch/Titles) cheap follow-ons.
5. **Sequence-manager validation (#1)** — silent failure mode today; gmriggs flagged property reverts. Per-group seq gating on `pollEntityUpdates()` drain.
6. **Right-click radial menu finish (#23)** — Wave A3 shipped the direct-invoke Examine MVP; promote to Use/Drop/Wield/Trade with retail context-menu styling.

**Discord-evidence theme to internalize:** the community measures alt-clients by *what verbs you can do*, not by render quality. Holtburger is graphically the strongest project discussed in the corpus, but a player who can't trade, can't appraise, can't fellowship, and can't see their own buffs will judge it harshly.
