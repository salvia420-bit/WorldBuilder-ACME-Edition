# Holtburger-Web 3D Render Mode Inventory

**Date:** 2026-05-25  
**Audit Scope:** Scene3D implementation status organized by Discord taxonomy categories  
**Source Base:** `/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/`

---

## RENDERING

- **Main loop & frame coordination:** `scene3d/index.js:221-385` — per-rAF tick stamping `liveScene3d.frameTime = {tsMs, tsSec, dt}` driving the render pipeline
- **Three.js r184 integration:** `scene3d/index.js` — Scene, WebGLRenderer, PerspectiveCamera, coordinate rotation (AC Z-up → Three.js Y-up via worldRoot -π/2 rotation)
- **EffectComposer pipeline:** `scene3d/atmosphere_pipeline.js` — Sky pass → World pass (`clear=false, clearDepth=true`) → Effect chain (AerialPerspective, LensFlare, ToneMapping AGX, Dithering)
- **Material cache & PBR:** `scene3d/materials.js` — Shared MeshStandardMaterial pool, texture filtering, anisotropy per quality preset, wireframe mode gate (`?wireframe=1`)
- **Quality presets:** `scene3d/quality.js` — `low/medium/high/ultra` with URL knobs `?quality=N`, `?renderScale=N` (0.25-2.0), controls bloom/godRays/cloudShadows/vignette for multi-GPU targets
- **Render scale live:** `scene3d/index.js` — `setSize()` re-fires on `window.__setRenderScale(n)`, rebuilds all RenderTargets (atmosphere pipeline, cloud overlay)
- **Direct render path:** `scene3d/index.js` + `sky_dome.renderSkyPass()` — fallback when atmosphere bake in-flight (8-43s per GPU), `?atmosphere=off` opt-out

## TERRAIN/WORLD

- **Landblock heightfield (9×9 grid, 64 quad mesh per 192m block):** `scene3d/terrain.js:bakeTerrainForLandblock()` — per-LB fetch + vertex-height upload, computes normals for Lambert lighting
- **Terrain detail normal mapping:** `scene3d/terrain.js` — 32 terrain types → 5 detail-normal slices (grass/dirt/sand/stone/snow) via DataArrayTexture, bilinear-blend shader
- **Terrain atlas (33 base layers + detail layers):** `scene3d/adapter.js:buildTerrainAtlasArrayBytes()` — layers-per-terrain-code lookup table
- **Road blending inline:** `scene3d/terrain.js` — per-vertex road flag from VertexTypes data texture, smoothstep(0.85, 0.95) fade over ~5 m band
- **World-expand ring radius:** `scene3d/index.js` — Holtburg + 13×13 (169 LBs) ring initial load, `bakeTerrainRing()`, lazy-load past the ring on movement
- **Cell visibility gates:** `scene3d/loop.js:tickCellVisibility3D()` — BFS-driven `Object3D.visible` flips per cell, toggles outdoor batch on `isCurrentCellIndoor` flip
- **Landblock unload:** NOT IMPLEMENTED — 13×13 ring stays resident; memory time bomb documented in INTERACTING_LAYERS_ANALYSIS.md

## ENTITIES/SETUPMODEL

- **Entity manager & spawning:** `scene3d/entities.js:EntityManager` — per-entity Three.js Group rig + AnimationMixer, async spawn(meta) → EntityInstance (guid-keyed map)
- **SetupModel parts → Three.js rig:** `scene3d/entities.js` — part_0..part_N Groups + per-Surface Mesh children, rigid-body animation (no skinning), part names keyed to AnimationCache.partNames
- **Creature/NPC/Player typed hierarchy:** `plugins/world-objects/` — WorldObject base + 24 subclasses (Character, Creature, Player, NPC, Monster, Vendor, Door, Static, Item, etc.) — `world_object_manager.js` dispatches creation via `canonicalClassify(itemType, flags)`
- **ObjectCreate → Entity spawn:** `scene3d/loop.js:drainEntityEvents3D()` — KIND_SPAWN (kind=1) calls `entityManager.spawn(meta)`, KIND_REMOVE (kind=2) calls dispose + unmap
- **Position updates:** `scene3d/loop.js:KIND_POSITION` — updates root.position in AC world coords, caches latest in `window.__lastEntityWorldPos[guid]`
- **Appearance changes:** `scene3d/entities.js:setAppearance()` — palette/model/texture substitutions (wasm provides Uint32Array diffs), material clones, dispose old
- **Visibility gate (PhysicsState draw):** `scene3d/loop.js:KIND_VISIBILITY` → `kind=17 EntityVisibilityChanged` bus event — physical/ethereal/portal-space state gates visibility

## ANIMATION/MOTION

- **Motion-table cycle maps:** `scene3d/entities.js` — stance-keyed AnimationClip lookup, caps 4 actions per setup (mirrors 2D `MAX_BAKES_PER_SETUP=4`)
- **AnimationMixer per entity:** `scene3d/entities.js:EntityManager.tick(dt)` — mixer.update(dt), AnimationAction crossFadeTo(0.2s) on motion switch, fadeIn/fadeOut on idle transitions
- **Motion command dispatch:** `scene3d/loop.js:KIND_MOTION` → wasm provides (guid, cmd, stance) — cache lookup, async clip resolution, action swap
- **STOP motion (rest pose):** Sets no clip, entity holds frame-0 geometry, silent on transition (no fade)
- **Swing pose classification:** `scene3d/entities.js:setSwingPoseFromMotion()` — stub; per memory, 70 LOC seam wiring exists for motion-table classifier (INCOMPLETE)
- **Animation cache:** `scene3d/animation.js:AnimationCache` — fetches three.js KeyFrame arrays via wasm, caches per (setupId, cmd, stance) tuple

## PARTICLES

- **ParticleEmitter runtime:** `scene3d/particles/particle_manager.js:ParticleManager` — owns Map<id, ParticleEmitter>, dispatches per-tick updates, public `addEmitter()` API
- **Particle pool & mesh:** `scene3d/particles/particle_emitter.js` — pre-allocated max-particle slots, shared geometry + per-slot cloned materials, THREE.Points or buffered mesh
- **ParticleEmitterInfo parser:** `scene3d/particles/particle_emitter_info.js` — wasm-provided structure (lifetime, spawn rate, physics flags, gradient keys, texture)
- **Physics scripts:** `scene3d/particles/` — acceleration/friction/gravity simulation per physics-script flags, time-based RNG for stochastic spawning
- **AnimHook event drain:** `scene3d/sky_dome.js` + entity AnimHook walkers (infrastructure exists per memory, P5 wiring in progress)
- **Material disposal:** `scene3d/particles/particle_manager.js:_disposeMaterialIfOwned()` — tags per-slot clones as `userData.__disposable`, skips cache-owned refs

## LIGHTING/SHADOW

- **Cascaded shadow mapping (CSM):** `scene3d/csm.js` — 3 cascades, frustum fit per cell state (indoor=off, outdoor=on), `tickLightingForCellState()` updates CSM after cell-visibility flip
- **Sun direction centralized:** `scene3d/sun_direction.js:sunDirFromHeadingPitch()` — imported by sky_lighting, cloud_volume, atmosphere_lights (×2), atmosphere_sky (×2)
- **Sky lighting controller:** `scene3d/sky_lighting.js:SkyLightingController` — DirectionalLight + CSM, ticks on `skyLightingController.tick()`, sun-off when indoors, ambient-up
- **Atmosphere lights:** `scene3d/atmosphere_lights.js:AtmosphereLights` — SunDirectionalLight + SphericalHarmonics probe for IBL, derives sun dir from atmosphere state
- **Per-SetupModel point/spot lights:** `scene3d/lighting.js:attachSetupModelLights()` — DEFERRED follow-on (per comments; infrastructure exists, per-light distance culling not yet wired)
- **SSAO:** REMOVED (2026-05-18) — conflicted with atmosphere path; atmosphere path now canonical
- **Shadow receiver gate:** Statics only if distance < SHADOW_RECEIVE_RANGE_M on mid/high/ultra presets (perf FU2)

## SKY/ATMOSPHERE

- **Bruneton takram atmosphere:** `scene3d/atmosphere_sky.js` — Sky-K.6 shipped; SkyMaterial with real-time Rayleigh/Mie scattering, precomputed textures via takram Bruneton bake (8-43s on first load)
- **RIC shim:** `scene3d/_ric_shim.js` — microtask-driven requestIdleCallback replacement; takram's bake snapshots rIC at module load, needs shim to unblock busy loop
- **AC game time (world clock):** `Date.now() + 11.34× compression` in atmosphere_sky.js — drives sun/moon/star positions independently from visual-effect time (frameTime.tsSec)
- **AC moons (billboards):** `scene3d/ac_moons.js` — custom shader, renderOrder=800 on sky scene, AC-accurate sizes/positions per game time
- **Moon angular radius bump:** `scene3d/atmosphere_sky.js` — tunable via `?moonSpeed=N` and `window.__setMoonSpeed(n)`
- **Sun angular radius:** `scene3d/atmosphere_sky.js` — `?sunSize=N`, `window.__setSunSize(n)` knobs, default 0.03
- **Stars:** `scene3d/atmosphere_sky.js` — real-time star catalog mapped to sky sphere via game time
- **Cloud overlay quad (renderOrder=999):** `scene3d/cloud_overlay.js` — attached to skyDome.skyScene, sky pass renders sky+cloud, world pass `clearDepth=true` for depth-correct occlusion
- **Volumetric clouds (takram-three-clouds):** `vendor/takram-three-clouds/` — raymarched cloud volume, per-frame raymarch into cloudsBuffer, `cloud_volume.tick()` updates weather state
- **Cloud weather integration:** `scene3d/weather_state.js:updateFromDayGroup()` — AC's 20 DayGroups → (T, Td, pressure, is_storm), remaps to WMO étage (cumulus base, mid/high density), `window.__applyCloudWeather()` opt-in
- **Cloud altitude from WGS-84:** `scene3d/cloud_overlay.js:379-383` — takram computes via ellipsoid (~18km wrong); overlay corrects uniform post-render (one-frame latency on teleport)

## AUDIO

- **Audio manager (Web Audio API):** `scene3d/audio/audio_manager.js:AudioManager` — plays Wave (0x0A) sounds at 3D world positions via PannerNode HRTF panning + inverse-square falloff
- **3D positional audio:** `scene3d/audio/audio_manager.js` — AudioBufferSourceNode → PannerNode (configured for 3D) → master GainNode; listener tracked per-frame from camera pos + quat
- **Audio buffer cache:** `fetchWave(did)` promise-deduping cache, one-shot decode via decodeAudioData, null-on-error sentinel (no retry)
- **Audio context gating:** Deferred until first user gesture (browser autoplay policy), `notifyUserGesture()` idempotent trigger site in input handlers
- **Ambient sound runtime:** `scene3d/audio/ambient_runtime.js:AmbientRuntime` — wasm-provided DAT parser output (Sound table caches), plays ambient loops per cell/landblock
- **Sound table cache (infrastructure):** `scene3d/audio/sound_table_cache.js` — exists but currently infra-only; AnimHook sound playback wiring in progress (per memory)
- **Master volume:** `setMasterGain(factor)` control, no URL knob yet (TODO)

## NETWORKING/WIRE

- **WASM bridge (holtburger-protocol):** `/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/crates/holtburger-protocol/` — Rust message codec, C2S/S2C opcode definitions
- **Session handle:** `src/lib.rs:SessionHandle` (wasm-bindgen class) — exports `poll_events()` drain, `.jump()`, `.attack()`, `.missileAttack()`, `.castSpell()`, `.toggleCombatMode()`, etc.
- **WebSocket transport:** `crates/holtburger-transport-ws/` — async bridge to `holtburger-wsbridge` relay (localhost:9001 or configurable), sends/receives GameMessages
- **Entity event drain:** `scene3d/loop.js:drainEntityEvents3D()` — polls `sessionHandle.pollEntityUpdates()` once per frame, dispatches KIND_POSITION/SPAWN/REMOVE/MOTION/APPEARANCE
- **Chat drain:** `src/index.html` (2D path reference) — `pollChatMessages()` drained, routed to DOM chat window (3D path doesn't yet integrate)
- **Opcode coverage:** `holtburger-protocol/src/opcodes.rs` — 50+ message types defined; cross-check vs Chorizite.ACProtocol remains a gap-fill item

## PROTOCOL/OPCODES

- **ObjectCreate (kind=1):** `scene3d/loop.js:KIND_SPAWN` — spawns EntityInstance via EntityManager, wasm provides guid/wcid/position/appearance/object class
- **ObjectDelete (kind=2):** `scene3d/loop.js:KIND_REMOVE` — disposed + unmapped from entityMap
- **PositionUpdate (kind=0):** `scene3d/loop.js:KIND_POSITION` — updates root.position, caches in `__lastEntityWorldPos`
- **VelocityUpdate (kind=4):** `scene3d/loop.js:KIND_VELOCITY` — updates `entityInstance.lastVel`, used by prediction shadow (camera.js:806)
- **MotionUpdate (kind=5):** `scene3d/loop.js:KIND_MOTION` — async AnimationClip fetch + crossFade
- **AppearanceChange (kind=6):** `scene3d/entities.js:setAppearance()` — palette/model/texture substitutions
- **PlayerStatsUpdated (kind=8):** `plugins/api.js` — coalesced vitals/skills/attrs refresh, fires `client.events.emit('playerStatsUpdated')`
- **ContainerOpened (kind=12, kind=21):** `plugins/api.js` — kind=12 for vendors (PR-HH 2026-05-23), kind=21 for chests/corpses/salvage bags
- **VendorOpened:** `plugins/vendor-ui.js` — listens to kind=12 + `OnContainerOpened` event, wires buy/sell UI
- **EntityVisibilityChanged (kind=17):** PhysicsState draw-gate; gates 3D object visibility per physical/ethereal/portal-space state
- **DoorStateChanged (kind=15):** `scene3d/loop.js` — door swing state; wiring in progress per memory (2026-05-13)
- **CombatEvent (kind=19, JSON format):** `plugins/combat-hud.js` — emits "damageDealt"/"damageTaken"/"evadedTarget"/"evadedAttacker"/"attackDone" on client.events bus

## PHYSICS/MOVEMENT

- **Local player pose (animation interp):** `scene3d/index.js:applyLocalPlayerPoseFromIntegrator()` — reads quaternion/position from pose integrator, applies each frame
- **Jump command:** `plugins/api.js:player.jump(power)` → `sessionHandle.jump(power)` wasm export
- **Predicted player position:** `scene3d/camera.js:cameraSwitcher.tick()` — reads `entityManager.entityMap[localPlayerGuid].root.position`, feeds to camera follow
- **Collision cylinder / physics state:** `holtburger-world` — Rust-side physics (gaps remain; AC's CPhysicsObj is ~1000 methods per acclient.c, only basics ported)
- **Ground detection (ON_GROUND):** Stub; real AC uses CPhysicsObj.on_ground() with Quadtree landscape testing. Browser substitute: terrain height sample + epsilon (TODO)
- **Movement input:** `scene3d/camera.js` — WASD → `sessionHandle.setMovementInput(bitmask)` wasm export, camera drives the interpretation
- **Knockdown/airborne state:** `kind=18 EntityAirborneChanged` not yet surfaced as bus event (infrastructure exists)

## COMBAT

- **Attack dispatch:** `plugins/api.js:player.attack(targetGuid, height, power)` → `sessionHandle.attack()` wasm export
- **Missile attack:** `plugins/api.js:player.missileAttack(targetGuid, height, accuracy)` → `sessionHandle.missileAttack()` wasm export
- **Combat mode toggle:** `plugins/api.js:player.toggleCombatMode()` → `sessionHandle.toggleCombatMode()` wasm export
- **Attack height enum:** `plugins/api.js:AttackHeight = {HIGH:1, MEDIUM:2, LOW:3}`
- **Combat bar state:** `plugins/combat-bar.js` — localStorage-persisted (attackHeight, powerLevel, autoRepeat, chargeAttack, armedSpellId)
- **Charge attack rAF loop:** `scene3d/picking.js:setupClickPicking()` — 10s safety timeout, stance check, ABORT_KEYS (WASD/QE/Shift) in place
- **Selection ring (visual):** `scene3d/picking.js` — red torus drawn on target, remains on cancel (TODO: clear on stance flip / movement)
- **Click-pick → target:** `scene3d/picking.js` — right-drag camera, left-click auto-targets, raycast against entityMap + statics
- **Combat phases B-J:** NOT YET FULLY IMPLEMENTED — Phase I.1 (charge attack) shipped, attack/missile/magic dispatch wired, but combo logic/swing classifier/stance-driven motion classified as Phase K work (per CHORIZITE_PORTING_PLAN.md)

## MAGIC/SPELLS

- **Spell casting:** `plugins/api.js:player.castSpell(spellId, targetGuid)` → `sessionHandle.castTargetedSpell()` or `castUntargetedSpell()` wasm export
- **Spell forget:** `plugins/api.js:player.forgetSpell(spellId)` → `sessionHandle.removeSpellFromBook(spellId)` wasm export
- **Known spells fetch:** `plugins/api.js:player.knownSpells()` → `sessionHandle.playerKnownSpells()` returns list
- **Spellbook UI:** `plugins/spellbook.js` — 5-tab bar (by school), per-spell icon + name, drag-drop to combat-bar slots
- **Spell bar slots (localStorage):** `plugins/spellbook.js:SPELL_BAR_TABS` — 5 bars × 10 slots (50 total), hot-swappable
- **Armed spell state:** `plugins/combat-bar.js` — tracks armedSpellId, auto-disarms on death (HP=0) + zone change (landblockChanged event)
- **Spell components (incomplete):** `holtburger-world` — parser exists; UI for component summoning / deletion not yet shipped
- **Spell validation (client-side):** `src/lib.rs:canCreateCharacter()` validates budget via `CharacterGenCatalog` loaded from `SkillTable` (0x0E000004); casting validation on wasm side (TODO verify completeness)
- **Enchantment bus event:** NOT YET WIRED — `kind=? EnchantmentChanged` infrastructure missing; buffs-debuffs HUD blocked (per api.js coverage table)

## INVENTORY/ITEMS

- **Inventory fetch:** `plugins/api.js:player.inventory()` → `sessionHandle.playerInventory()` returns InventoryView (container tree)
- **Item container model:** `plugins/world-objects/container.js:Container` — tracks contents, add/remove operations
- **Item typed hierarchy:** `plugins/world-objects/items/` — Item base + 14 subclasses (Armor, Clothing, Jewelry, Foci, Gem, Food, Key, ManaStone, Scroll, SpellComponent, TradeNote, Ust, MeleeWeapon, MissileWeapon)
- **Inventory panel (TODO):** UI shell exists in `plugins/inventory.js` but wiring to item tree incomplete
- **Drag-drop to spell bar:** `plugins/spellbook.js` — works for spell cards; combat Phase H drag-drop (per memory) shipped in prior phase
- **Drag-drop to equipment slots:** NOT YET IMPLEMENTED — equipment paper-doll (Phase K follow-on)
- **Item appraisal (Identify panel):** `plugins/examine-target.js` + `holtburger-world:identify.rs` parser exists; UI integration incomplete
- **Vendor buy/sell:** `plugins/vendor-ui.js` — listens to kind=12 ContainerOpened, wires `buyFromVendor`/`sellToVendor` wasm exports, displays item list + AC-aesthetic icons

## NPC/AI

- **Nameplate rendering:** `scene3d/hud.js:createNameplateOverlay()` + `scene3d/nameplate_sprite.js` — Billboard-style text labels above creatures, tracks local player distance
- **Nameplate styling:** AC-aesthetic green (NPC) / red (monster) / white (player) colors, dynamic sizing per distance
- **NPC hierarchy:** `plugins/world-objects/npc.js:NPC` — subclass of Creature, no special behavior yet
- **Monster hierarchy:** `plugins/world-objects/monster.js:Monster` — subclass of Creature
- **PVS (Potentially Visible Set):** `scene3d/cells.js:tickPvsLoadExpansion()` — BFS-driven cell adjacency, lazy-loads neighboring LBs as player moves; infrastructure exists, PVS oracle TBD
- **NPC AI (combat, pathfinding):** NOT IMPLEMENTED — retail AI is hundreds of methods in acclient.c (CMonster/CNPCActor classes); browser client is single-player / server-driven
- **Named NPC list:** No special registry yet; NPCs tracked via entityMap like any entity

## UI/HUD

- **Plugin facade (createClient):** `plugins/api.js:createClient(sessionHandle)` — exposes `player` (actions), `movement`, `stats` (getters), `events` (bus), `Actions` enums
- **Event bus:** CustomEvent-based (EventTarget), subscribed via `client.events.on(name, handler)`, auto-emitted by index.html drain loop
- **Plugin bar:** `ui/bar.js` — horizontal icon bar, slot-based plugin loader, right-click panel open/close, F-key hotbar binding
- **Plugin lifecycle:** `mount(client)` / `renderFrame(dt)` / `unmount()` hooks per bundled plugin
- **Combat HUD:** `plugins/combat-hud.js` — displays damage dealt/taken in red floaters, stance indicator, target vitals preview (optional)
- **Vitals HUD:** `plugins/vitals-hud.js` — player health/mana bar (legacy DOM), polls `window.__pluginClient` every 500ms (fragile; refactor TBD)
- **Spell bar:** `plugins/spellbook.js` + `plugins/combat-bar.js` — 5 tabs × 10 slots, drag-drop, right-click cast (auto-target) or left-click to lock target (charge attack)
- **Chat panel (DOM):** `plugins/chat-panel.js` — scrolling message log, input field, `/emote` parsing, channel filtering (legacy 2D integration)
- **Map panel:** `plugins/map-panel.js` — dungeon map (TODO; landblock/cell tiles exist, Minimap is C-key camera cycle not a separate panel)
- **Target bar:** `plugins/target-bar.js` — selected creature vitals + name, distance, stance
- **Character panel:** `plugins/character-info.js` — attributes/skills/training view (template exists; vitals math wiring incomplete)
- **Status indicators:** `plugins/status-indicators.js` — buffs/debuffs visual badges (incomplete)
- **Buffs-debuffs HUD:** `plugins/buffs-hud.js` — enchantment display (incomplete; blocks on kind=11 EnchantmentChanged bus event)

## INPUT/CONTROLS

- **Right-drag camera:** `scene3d/camera.js:CameraSwitcher` — orbit controls, mouse-drag updates yaw/pitch, WASD moves player, Space/Q/E jump/slide
- **Click-pick entity:** `scene3d/picking.js:setupClickPicking()` — left-click raycast to entity, selects target (red ring drawn)
- **Charge attack (F-key holddown):** `scene3d/picking.js` — hold F to charge; release or movement/stance-flip cancels; pursues to attack range if chargeAttack=true
- **Camera cycle (C-key):** `scene3d/camera.js:1291-1302` — follow → topDown (first minimap) → orbit (broken 2026-05-18, fixed) → follow
- **Stance toggle (E-key):** `plugins/stance-toggle.js` — cycles NoStance/Bow/Crossbow/DualWield/Shield (UI buttons only; wasm export not yet wired)
- **F-key hotbar:** Plugin bar slots 1-10, `setupHotkeys()` binds F1-F10 to plugin slot activation
- **Right-click radial menus:** NOT YET IMPLEMENTED — placeholder in CHORIZITE_PORTING_PLAN.md Phase K follow-on
- **Movement input:** WASD → `setMovementInput(bitmask)` wasm export, camera interprets as strafe/forward per camera yaw

## DAT-PARSING

Covered by `holtburger-dat` crate (Rust-side, exposed to wasm); inventory focus is 3D-render-critical types:

- **0x01 GfxObj:** `scene3d/entities.js` — fetches via wasm, meshToFusedGeometry produces Three.js BufferGeometry
- **0x06 Texture:** `scene3d/adapter.js` — uploaded as DataArrayTexture for terrain atlas + detail layers
- **0x08 Setup (SetupModel):** `scene3d/entities.js:AnimationCache` — part tree + animation keyframes, surfaces as part_0..part_N rig
- **0x12 Animation:** `scene3d/animation.js:AnimationCache` — THREE.AnimationClip frames, keyed by (setupId, motionCmd, stance)
- **0x09 Wave (audio):** `scene3d/audio/audio_manager.js` — fetched on-demand, decoded to AudioBuffer
- **0x0A SoundTable:** `scene3d/audio/sound_table_cache.js` — parser output cached, AnimHook drain in progress
- **0x0E Landblock (terrain cells + heightfield + objects + scenery):** `scene3d/terrain.js`, `scene3d/statics.js`, `scene3d/buildings.js` — parsed per-LB, queued for baking
- **0x0D EnvCell (interior cells):** `scene3d/cells.js` — parsed per-cell, portal/geometry setup; wiring in progress (2026-05-13)
- **0x14 ParticleEmitterInfo:** `scene3d/particles/particle_emitter_info.js` — lifecycle, spawn rate, physics, gradient keys
- **0x31 SkillTable:** `holtburger-dat` — CharacterGen validation via `CharacterGenCatalog` loaded at login
- **0x32 SpellTable:** (gap: parsing exists, casting UI wired, spell-component table wiring incomplete)
- **0x2F RenderMaterial, RenderTexture, RenderSurface:** `scene3d/materials.js` — define texture bindings + blend modes per SetupModel surface
- **0x34 LandblockInfo:** WB.Terminal oracle (not parsed by browser; manifest-based LB metadata used instead)

## PLUGIN-API

- **Client facade:** `plugins/api.js:createClient(sessionHandle)` — single entry point, returns object with `{player, movement, stats, events, Actions, CombatMode, ...}`
- **Wasm export surface:** `SessionHandle` methods (`jump`, `attack`, `castSpell`, etc.), getters (`playerStats()`, `playerInventory()`, `playerKnownSpells()`)
- **Event bus subscription:** `client.events.on(eventName, handler)` — CustomEvent dispatched by index.html drain loop
- **Actions enum:** `attack`, `missileAttack`, `castSpell`, `toggleCombatMode`, `jump`, `useObject`, `forgetSpell`
- **Bar slot lifecycle:** `mount(client)` called once per plugin on panel open, `renderFrame(dt)` called each visible frame, `unmount()` called on panel close
- **Plugin manifest (TODO):** Tier 1 porting work; adopt Chorizite schema (id/name/author/entryFile/version/description/dependencies/environments) per CHORIZITE_PORTING_PLAN.md §3.2

## PERFORMANCE

- **FPS budget:** Target 60 Hz at render-scale 1.0 (= 16ms frame time)
- **Draw call reduction (statics):** `scene3d/statics.js` — InstancedMesh collapses N instances of same model → 1 draw call (Holtburg: ~222 placements → ~66 draw calls)
- **LOD for statics:** `scene3d/statics.js` — THREE.LOD wraps degraded geometry variants (rare for Holtburg, no degrade chain)
- **EnvCell fusion:** `scene3d/cells.js` — per-cell Object3D groups + SkyDome reuse, reduces object traversal per frame
- **Terrain detail normal bake:** ~840ms silent gap in wire-agent boot profile (DataArrayTexture upload); wire mode uses per-vertex color lookup (no 33-layer texture) for instant visual debug
- **Cloud raymarch (FPS critical):** `cloud_overlay.js` — on ultra preset, ~30-60 samples, 50% of frame budget on R9 290 at 25% scale
- **Material cache mutation:** Per-spawn palette/model/texture changes create cloned materials (no shared-cache mutation); disposed via `__disposable` flag convention
- **Particle sort gate:** `?particleSortObjects=off` URL knob to disable `scene.sortObjects` (perf E5), window.__particleSortObjects handoff to scene construction

## SECURITY/AUTH

- **Login form:** `src/index.html` — username/password input, account picker dropdown (if multiple accounts known)
- **WebSocket relay authentication:** Delegated to `holtburger-wsbridge` (external Rust server); browser sends plaintext username/password over relay (TODO: TLS), relay handles ACE handshake
- **Double-connect prevention:** Not yet implemented (TODO: guard against re-login mid-session)
- **Session token persistence:** Web storage (localStorage) for selected account name (no token caching yet)

## LOGIN/HANDSHAKE

- **Server picker:** `src/index.html` — dropdown list of ACE servers (hardcoded or from registry)
- **GLS (Global Login Server):** Not used (browser skips to portal auth directly)
- **Character select:** `src/index.html:renderCharacterList()` — wasm provides roster, click to selectCharacter(guid)
- **Portal handshake:** `src/lib.rs:start_session()` → `LoginRequest` → `CharacterList` recv loop → `selectCharacter()` → `CharacterEnterWorldRequest` → `CharacterEnterWorld` auto-chain → `PlayerCreate(guid)` + `EnteredWorld`
- **CharGen validation:** `CharacterGenCatalog` loaded from `SkillTable` (0x0E000004) at login, used to validate `createTestCharacter()` budget client-side (non-fatal if load fails)
- **Skill attribute budget:** `holtburger-core::CharacterGenBuilder::build_request()` validates on browser before dispatch (server is authoritative)

---

## Known Open Items / TODOs

### From CHORIZITE_PORTING_PLAN.md

**Event taxonomy backlog (§3.4, sorted by plugin-leverage priority):**
1. **#11 EnchantmentChanged** — missing kind=? event; buffs-debuffs HUD blocked
2. **#15 Death** — no structured event; text routes to chat only
3. **#4 ContainerClosed** — StopViewingObjectContents not surfaced
4. **#5 SelectionChanged** — selection is local picking.js state, not bus-broadcast
5. **#6 StateChanged (unified)** — spread across kinds instead of single {oldState,newState} event
6. **#8 WorldInfo** — ServerName/MaxConnections/CurrentConnections not exposed
7. **#12 SharedCooldownChanged** — shared-cooldown bus not wired
8. **#13 PortalSpaceEntered/Exited** — portal-space (loading screen) entered/exited not exposed

**Tier 3 port targets (§3.2):**
- WorldObject typed-class dispatch + 24-subclass hierarchy (PARTIALLY DONE — classes exist, dispatch wiring TBD)
- Enchantment + SharedCooldown structures (infrastructure exists, bus wiring missing)
- SkillFormula / SkillInfo / AttributeInfo / VitalInfo (math ported, UI wiring incomplete)

### From INTERACTING_LAYERS_ANALYSIS.md

**Structural hazards:**
1. **Landblock unload:** 13×13 ring stays resident; memory time bomb on continent traversal (no unloadLandblock API)
2. **Quality preset hot-swap:** Runtime change not supported; users must reload page
3. **ECEF/correctAltitude misconfig risk:** Silent failure across 4 files / 6 init points (defensive ternaries exist but fragile)
4. **Camera height patch (one-frame latency):** cloud_overlay overrides uniform after composer render (frame-delayed on teleport/jump)
5. **Weather state apply:** `_applyWeatherToCloudLayers()` not auto-called per frame (opt-in only via `window.__applyCloudWeather()`)
6. **vitals-hud fragile polling:** Polls `window.__pluginClient` every 500ms; first `playerStatsUpdated` can fire before subscriber wires

### From OPTICAL_EFFECTS_HANDOFF.md

**Priority queue for new effects:**
1. **BloomEffect** (★★★★★) — soft HDR halo, ~1-2ms @ 1080p; wire to EffectPass pre-ToneMapping
2. **GodRaysEffect** (★★★★★) — crepuscular rays, ~2-4ms @ 1080p; needs cloud occlusion in separate pass
3. **moonAngularRadius bump** (★★) — takram moon size; verify property exists, ~0ms cost
4. **Cloud shadows on terrain** (★★★★) — terrain shader samples cloud shadowBuffer, ~1-3ms total
5. **VignetteEffect** (★) — subtle frame darkening, <0.5ms; must precede ToneMapping

### Design/Arch docs (quick reference)

- `docs/dual-pane-revert-2026-05-22.md` — reverted dual-pane layout; single-pane + popout panels is canonical
- `docs/examine-architecture-2026-05-22.md` — architecture post-Phase 7 audit
- `OPTICAL_EFFECTS_HANDOFF.md` — effects queue + perf budgets per hardware target (R9 290 @ 25%, GTX 1070 @ 50-100%)
- `INTERACTING_LAYERS_ANALYSIS.md` — cross-cutting subsystem hazards (ECEF, camera patch latency, weather state, landblock unload)
- `CHORIZITE_PORTING_PLAN.md` — strategic port checklist (Tier 1-7 repos, ACPlugin event taxonomy, Rust mirrors)

### Motion/Physics (Phase K work)

- **Swing pose classifier:** 70 LOC seam wiring exists (per memory); needs motion-table lookup + stance filter
- **Motion-table-driven swing:** `CMotionInterp::*` bodies in ~/ac-headers/acclient.c (lines 7088, 343343+) define algorithm; port TBD
- **Ground detection:** Currently stub; real AC uses CPhysicsObj.on_ground() with Quadtree landscape testing

### Spell/Combat (Phase K work)

- **Spell component summoning/deletion:** Parser exists, UI not shipped
- **Combat maneuver phases B-J:** Only Phase I.1 (charge) shipped; swing classifier, combo logic, repeat detection TBD
- **Stance-driven motion:** Combat stance (NoStance/Bow/Crossbow/etc.) should gate motion-table lookups; not yet wired

### Inventory/Equipment (Phase K work)

- **Equipment paper-doll:** Item drag-drop to equipment slots not implemented
- **Item appraisal (Identify):** Parser exists; UI integration incomplete
- **Container UI (chests/corpses):** Infrastructure exists (kind=21 containerOpened), full container-browse UI TBD

### Infrastructure / Scaling (Phase K+ work)

- **Plugin hot-reload:** Plugins can reload but old closures stay alive (e.g., `isInMagicStance` closure in setupClickPicking)
- **Landblock lazy-load:** Objective 6 infrastructure exists; past-ring LBs still hard to test at scale
- **PVS oracle:** BFS cell-adjacency works; ACE server PVS table consumption TBD
- **Performance profiling:** No timeline/profile view yet; captures use Playwright/screenshot regression testing only

