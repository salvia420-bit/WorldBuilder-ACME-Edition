# Holtburger-Web 3D Render — Debugging Surfaces Inventory

Compiled 2026-05-28. Sources: `apps/holtburger-web/src/`, `apps/holtburger-web/scene3d/`, `apps/holtburger-web/plugins/`, `apps/holtburger-web/index.html`. File paths in this doc are relative to `apps/holtburger-web/` unless noted.

A "debugging surface" here means anything a developer can flip, observe, or query at runtime to diagnose the 3D renderer — URL params, key bindings, localStorage flags, `window.*` globals, log prefixes, dev-server endpoints, stats overlays, smoke/regression scripts, and shader feature toggles.

---

## 1. URL query parameters

### Core render control (`scene3d/index.js`)
| Param | Type | Effect |
|---|---|---|
| `debug=1` | bool | Mounts top-right dev HUD (`plugins/debug-overlay.js`) |
| `wireframe=1` | bool | Wireframe mode; skips atmosphere/clouds/skydome/CSM |
| `diag=1` | bool | Enables diagnostic layer (`__diag.*`) |
| `renderOnDemand=1` | bool | Disable rAF loop; advance via `window.__renderOnce()` |
| `targetFps=<n>` | int | Pace rAF at fixed FPS |
| `netDrainHz=<n>` | int | Network packet drain rate |
| `nullRender=1` | bool | Skip `renderer.render()` (measure perf without draw) |
| `renderScale=<f>` | float (0, 2] | Render-target resolution scale |
| `textureScale=<n>` | int | Downscale loaded textures |
| `atlasTilePx=<n>` | int | Terrain atlas tile size |
| `shadows=<mode>` | str | Shadow config override |
| `eventLog=on\|off` | str | Event-stream logging |
| `eagerDungeons=1` | bool | Pre-load dungeon LBs |
| `ringRadius=<m>` | int | PVS ring load radius |
| `staticsRadius=<m>` | int | Statics load radius |
| `buildingsRadius=<m>` | int | Buildings load radius |
| `lbCap=<n>` | int | Landblock LRU cache cap |
| `lbLruDebug=1` | bool | LRU eviction logging |
| `agentic=low\|high` | str | Agent-mode quality tier |
| `preloadIcons=1` | bool | Preload all UI icons at boot |
| `animCacheMax=<n>` | int | Animation cache cap |

### Quality / visual fidelity (`scene3d/quality.js`)
| Param | Effect |
|---|---|
| `quality=low\|mid\|high\|ultra` | Preset bundle |
| `antialias=on\|off` | MSAA override |
| `normalMaps=on\|off` | Procedural normals |
| `detailFlag=on\|off` | Terrain detail maps |
| `terrainDetailNormal=on\|off` | Terrain detail-normal overlay |
| `forceDetail=on` | Force detail despite quality |
| `triplanar=on\|off` | Triplanar mapping |
| `triplanarSlopeThresholdPct=<n>` | Blend threshold |
| `hero=on\|off` | Hero/high-detail player+NPC models |
| `pom=on\|off` | Parallax occlusion mapping |
| `pomStepsPrimary=<n>` | POM ray steps |
| `pomStepsSelfShadow=<n>` | POM self-shadow steps |
| `forcePom=on` | Force POM despite quality |
| `csm=on\|off` | Cascaded shadow maps |
| `bloom=on\|off` | Bloom |
| `vignette=on\|off` | Vignette |
| `lensFlare=on\|off` | Lens flare (off by default — see memory entry [Stutter fixes 2026-05-21]) |
| `lightShafts=on\|off` | God rays |
| `subdivLevel=<n>` | Terrain/mesh subdivision (1, 2, 4, 8) |

### Sky / atmosphere (`scene3d/atmosphere_sky.js`, `scene3d/ac_moons.js`)
| Param | Effect |
|---|---|
| `sunSize=<rad>` | Sun disk angular radius |
| `moonSize=<rad>` | Moon disk angular radius |
| `moonSpeed=<n>` | Moon rotation speed |

### Clouds (`scene3d/cloud_volume.js`, `scene3d/index.js`)
| Param | Effect |
|---|---|
| `clouds=<mode>` | Cloud rendering mode (e.g. `on`) |
| `cloudsBuffer=<size>` | Cloud RT buffer size |
| `cloudCoverage=<pct>` | Coverage 0–1 |
| `cloudQuality=<preset>` | Cloud quality tier |
| `cloudShadow=off` | Disable cloud shadows |
| `cloudShadowRes=<px>` | Cloud shadow map resolution |
| `cloudShadowStrength=<f>` | Cloud shadow multiplier |

### Weather (`scene3d/weather/manager.js`)
| Param | Effect |
|---|---|
| `lightning=<mode>` | Lightning mode |
| `rain=<mode>` | Rain mode |
| `thunderDid=<hex>` | Override thunder sound DID |

### Entities, picking, spawns
| Param | File | Effect |
|---|---|---|
| `spawnTrace=1` | `scene3d/entities.js` | Spawn lifecycle tracing |
| `clothingHotSwap=1` | `scene3d/entities.js` | Hot-swap clothing updates |
| `cellBugParity=retail` | `scene3d/cells.js` | Retail cell-bug parity |
| `envcellFusion=1` | `scene3d/cells.js` | EnvCell fusion |
| `profileStatics=1` | `scene3d/statics.js` | Statics-loading profiler |
| `spawns=<mode>` | `scene3d/spawns.js` | Spawn visualization |
| `particleSortObjects=false` | `scene3d/index.js` | Disable particle sort |

### Materials
| Param | File | Effect |
|---|---|---|
| `generic-rough=<f>` | `scene3d/materials.js` | Generic roughness |
| `stone-grain=<f>` | `scene3d/materials.js` | Stone grain texture |
| `ac-text=<mode>` | `scene3d/index.js` | AC text rendering |

### HUD / nameplate / compass
| Param | File | Effect |
|---|---|---|
| `hud=none` | `scene3d/index.js`, `scene3d/nameplate_sprite.js` | Disable nameplates/HUD |
| `nameplateRange=<m>` | `scene3d/nameplate_sprite.js` | Nameplate cull distance |
| `nameplateMax=<n>` | `scene3d/nameplate_sprite.js` | Max nameplates |
| `compass=off` | `plugins/compass-hud.js` | Disable compass HUD |
| `compassRadar=off` | `plugins/compass-hud.js` | Disable radar |
| `radarHostileOnly=1` | `plugins/compass-hud.js` | Hostile-only radar |

---

## 2. Console log prefixes

Bucket-and-grep targets for `/console?n=500` output. Memory entry [Read holtburger console before instrumenting] notes the bus is bucketed by these prefixes.

**Scene3D / render path:** `[scene3d]` `[phase6/]` `[sky/]` `[ric_shim/]` `[motion-link/]` `[phase7.*]` `[wire-agent]` `[wire-fill]` `[render-cadence]` `[render-scale]` `[adapter]` `[net-drain]` `[fire-attack]` `[picking]` `[play-effect-vfx]` `[weather/fx]` `[task-d/ambient]` `[sky-c]` `[sky-d]` `[sky-i-b]` `[terrain-sun]` `[ac-moons]` `[clouds-d]` `[cohere-b]` `[give]` `[visfid-p33]` `[task-13]` `[wave15]` `[wave1e]` `[diag]`

**Plugins (UI side, often visible in render flow):** `[book-panel]` `[buffs-hud]` `[bus]` `[character-creation]` `[char-info]` `[chat-panel]` `[combat-bar]` `[combat-hud]` `[container-panel]` `[dye-preview]` `[examine]` `[house-panel]` `[lifestone-popup]` `[loader]` `[main-panel]` `[paperdoll]` `[radial-menu]` `[research/cast]` `[sneak-hud]` `[spellbook]` `[spell-research]` `[stance-toggle]` `[target-bar]` `[trade-panel]` `[tradeskill]` `[train-skills]` `[vendor-ui]` `[wom]`

---

## 3. `window.*` globals (devtools console)

### Scene/render handles
- `window.liveScene3d` — main scene; exposes `.renderer`, `.camera`, `.entityManager`, `.materialCache`, `.cameraSwitcher`, baked-LB sets, etc.
- `window.__quality` — read-only quality preset mirror
- `window.__hbWasm` / `window.__wasm` — WASM module
- `window.__sessionHandle` — network session

### Frame / render control
- `window.__renderOnce()` — advance one frame (`?renderOnDemand=1`)
- `window.__setRenderScale(scale)` — runtime render-target scale
- `window.__ricShimLastBudgetMs` — last requestIdleCallback budget
- `window.__originalRequestIdleCallback` — pre-shim original
- `window.__setBootState(msg)` — set boot status

### Network
- `window.__netDrainInterval` — active drain interval ID
- `window.__stopNetDrain()` — stop drain loop
- `window.__scene3dEntityHook(updOrArray)` — process entity updates
- `window.__scene3dEntityBacklog` — entity backlog buffer

### Atmosphere / sky
- `window.__atmosphereRuntime` — pipeline runtime
- `window.__atmospherePipeline` — pass renderer
- `window.__atmosphereLights` — lighting
- `window.__atmosphereSky` — sky dome
- `window.__eagerAtmosphere` — preloaded modules
- `window.__setSunSize(rad)` / `window.__setMoonSize(rad)`
- `window.__setExposure(v)` — tone-map exposure
- `window.__setBloomIntensity(v)` / `window.__setBloomThreshold(v)`
- `window.__setVignetteDarkness(v)` / `window.__setVignetteOffset(v)`

### Clouds
- `window.__cloudOverlay` — cloud volume
- `window.__applyCloudWeather()` — apply pending weather
- `window.__resetCloudLayers()` — reset layer state
- `window.__setCloudCoverage(v)` / `window.__setCloudQuality(p)`
- `window.__setCloudShadowEnabled(b)` / `window.__setCloudShadowStrength(m)`
- `window.__setLightShafts(b)` — god rays toggle

### Moons (decorative)
- `window.__setMoonCloudIntensity(v)` / `window.__setMoonCloudSpeed(v)`
- `window.__setMoonCityIntensity(v)` / `window.__setMoonCityPos(x, y)`
- `window.__setMoonScintIntensity(v)`

### Weather
- `window.__weatherEffects` — manager
- `window.__setWeather(profile)` / `window.__setWeatherProfile(profile)`
- `window.__getWeather()` / `window.__getWeatherProfiles()`
- `window.__clearWeatherOverride()`

### Picking / selection / camera
- `window.__pickEntityAt(x, y)` — raycast at screen coords → GUID
- `window.__fireAttackOnTarget(height?)` — fire attack on selected
- `window.__openRadialMenuFor(guid, x, y)` / `window.__closeRadialMenu()`
- `window.__showExamineFor(guid)` — examine window
- `window.__selectedEntityGuid` / `window.__lastSelectedGuid`
- `window.__lastEntityWorldPos` — `Map<guid, {x,y,z}>` updated each frame
- `window.__movementConstants` — speed constants (from `index.html`)
- `window.__predTrace3d` — toggle prediction debug log (`scene3d/camera.js`)
- `window.__wireCameraAlignBehindPlayer()` — snap camera

### Combat state
- `window.__combatBarState` — armed spells, slot layout
- `window.__getCurrentStanceLow()` / `window.__getCurrentStanceLabel()`
- `window.__classifyMotionCommandTyped(setupId, motionCommand, stance)` — decode motion enum

### Buffs / status
- `window.__buffsHudGetEntitySummary(guid)`
- `window.__buffsHudOnEntityChange(cb)`
- `window.__buffsHudGetEntityEnchantments(guid)`
- `window.__buffsHudToggle()` / `window.__buffsHudDebug`
- `window.__setStatusIndicator(key, value)`

### Audio
- `window.__soundTableCache` — `.get(did)`, `.stats()`, …
- `window.__playWave(did, x?, y?, z?)` — play sound from source
- `window.__fetchSoundTable(did)` — resolve table by DID
- `window.__synthGameMessageSound(guid, soundEnum, scale?)` — synth UI sound

### Plugin / panel control
- `window.__pluginClient` — plugin API client
- `window.__mainPanel` — `.pushView`, `.setTitle`, `.showView`, …
- `window.__wom` — world object model (GUID → type)
- `window.__isInventoryItem(guid)` — inventory test
- `window.__openTradePanel()` / `window.__closeTradePanel()`
- `window.__openSpellResearchPanel()` / `window.__closeSpellResearchPanel()` / `window.__toggleSpellResearchPanel()`
- `window.__openAllegiancePanel()` / `window.__closeAllegiancePanel()`
- `window.__openFellowshipPanel()` / `window.__closeFellowshipPanel()`
- `window.__openSocialPanel()` / `window.__closeSocialPanel()`
- `window.__openHousePanel()` / `window.__toggleHousePanel()` / `window.__closeHousePanel()`
- `window.__openContainerFor(guid)` / `window.__closeContainerPanel()`
- `window.__openBookFor(guid)`
- `window.__toggleEmotePanel()` — emote wheel (deprecated J1.A)

### HUD visibility
- `window.__debugOverlay` — `.setVisible(b)`, `.unmount()` (debug HUD)
- `window.__debugNameplates` — nameplate debug toggle
- `window.__compassHud` — `.setVisible`, `.setRadarVisible`, `.setRadarHostileOnly`, `.unmount`

### Plugin-level debug objects
- `window.__vendorBarDebug()` — open vendor debug panel
- `window.__vendorPluginDebug` — vendor object
- `window.__examineTargetDebug` — examine target info
- `window.__sneakHudDebug` — sneak HUD object
- `window.__combatHudDebug` — combat HUD object
- `window.__hbFellowshipDebug` — fellowship object
- `window.__acKeybindings` — active keymap

### Landblock / culling
- `window.__landblockLru` — LRU manager (resident, evicted, current LB)

---

## 4. `window.__diag` — diagnostic layer (`scene3d/diag.js`)

Enabled by `?diag=1`. Namespaced slices:

### `__diag.spawns` — entity spawn lifecycle
- `.attempted`, `.succeeded`, `.failed[]`, `.pending` (Map)
- `.byLandblock` (Map<lbId, counters>), `.byWcid` (Map<wcid, records>)
- `.localPlayer` — `{attempted, succeeded}`
- `.diff(lbId)` → `{missing, extra, misplaced, ok, summary}`
- `.summary()`, `.runAll(lbId)`
- `.setExpected(data)`, `.loadExpected(url)`
- `.bakes` — read-through to terrain/buildings/statics/envcell baked state

### `__diag.placements`
- `.diff(lbId)` — placement conformance (buildings, doors, scenery)

### `__diag.entityTypes`
- `.coverageByLb(lbId)` — entity type completeness

### `__diag.wire` — packet counters
- `.counters` `{event:kind, entity:kind → count}`
- `.tail` — last 200 packets, chronological
- `.byKind(kind)` — filter
- `.summary()` `{total, byKind, byCategory, windowMs}`
- `.reset()`

### `__diag.events` — event-stream completeness
- `.diff(lbId)`

### `__diag.physics`
- `.onFrame()` — physics tick hook

### `__diag.motion` — motion lifecycle (setupIds, commands, stances)

### `__diag.pvs` — PVS validation

### `__diag.assets` — load errors
- `.materialErrors[]`, `.animationErrors[]`, `.meshErrors[]`
- `.onMaterialError(meta)`, `.onAnimationError(meta)`, `.onMeshError(meta)`

### `__diag.integrity`
- `.verifyManifests()`, `.verifyBinaries()`

### `__diag.fonts` — font load tracking

### `__diag.strings` — string-table loads + lookup misses
- `.onTableLoaded(meta)`, `.onLookupMiss(meta)`

### `__diag.input` — keybind events + localStorage failures
- `.onRebind(meta)`, `.onRetailKeyMapLoaded(meta)`, `.onStorageError(meta)`

### `__diag.combat` — aim level + motion-command enums
- `.onAimLevel({scope, motion})`

### `__diag.palettes` — palette load success/failure

### `__diag.lod` — LOD band hits/misses
- `.onBandHit(meta)`, `.onBandMiss(meta)`

### `__diag.clothing` — clothing load events + errors

---

## 5. Debug HUD overlay (`plugins/debug-overlay.js`, `?debug=1`)

Top-right panel reading from `renderer.info` and live scene state:

- **FPS** (rolling 60-frame avg) & **frame ms**
- **Draw calls** — `renderer.info.render.calls`
- **Triangles** — `renderer.info.render.triangles`
- **Geometries** / **Textures** — `renderer.info.memory.*`
- **Programs** — `renderer.info.programs.length`
- **Resident LBs** / **Evicted LBs** — from `__landblockLru`
- **Current LB** — player landblock (hex)
- **Local GUID** — player GUID (hex)
- **Selected** — target GUID (hex) or "none"
- **Cursor** — entity under mouse (hex) or "none"
- **Cam pos** (x, y, z) / **Cam yaw** (deg)

Programmatic toggle: `window.__debugOverlay.setVisible(bool)`.

---

## 6. localStorage keys

| Key | Stores |
|---|---|
| `holtburger_graphics_v1` | Graphics/quality JSON |
| `holtburger_ui_bar_v1` | Plugin bar layout / visibility |
| `holtburger_keybindings_v1` | Custom keybindings |
| `holtburger_combat_bar_v1` | Armed spells, slot layout |
| `holtburger_hotbar_v1` | F1–F12 hotbar slot bindings |
| `hb-inv.slots-view.checked.v1` | Inventory slots-view toggle |
| `hb_chat_panel_fade` | Chat fade preference ("1" if enabled) |

`__diag.input.onStorageError` fires on read/write failures.

---

## 7. Renderer state inspection

Direct reads off `window.liveScene3d`:
- `.renderer.info` — Three.js render + memory + program stats
- `.entityManager.entityMap` — `Map<guid, entity>`
- `.terrainBakedLbs` / `.buildingsBakedLbs` / `.staticsBakedLbs` — `Set<lbId>`
- `.envCellLoadedLbs` — `Set<lbId>`
- `.materialCache` — material/surface cache + pending fetch counter
- `.cameraSwitcher` — active camera, follow yaw

---

## 8. Smoke / regression test files

Located in `apps/holtburger-web/` root:
- **67× `capture_*.cjs`** — Playwright/CDP capture scripts covering phase-by-phase init, sky/atmosphere, clouds, terrain, animation, entity spawning, audio heap, physics replay, LB expansion, combat, particles, shadows, normals, POM, triplanar, CSM, etc.
- **38× `test_*.mjs`** — node tests for animation clips, entity pipeline, camera, lighting, VFX, quality presets, keybindings, plugin state, audio, particles, motion, spell casting, skill training, equipment/dye, buffs, terrain palettes, combat, hotbar, examine.

---

## 9. Capture / replay tooling

- `__diag.wire.tail` — chronological packet log; `.byKind(kind)` filters
- `__lastEntityWorldPos` — frame-by-frame position map (motion-prediction replay)
- `__playWave(did, x, y, z)` — sound injection from console
- `__synthGameMessageSound(guid, soundEnum, scale)` — synth UI sound
- All `./data/*` fetches log with console prefixes — visible in DevTools Network panel

---

## 10. Gaps / things mentioned in memory but not found in scan

- **Dev server `/console?n=500`** — handler not located in `apps/holtburger-web/`; likely lives in `holtburger-server/` or the wsbridge crate. Client-side log buffer is the consumer.
- **Explicit shader "visualize normals" / "visualize cascades" modes** — no dedicated debug-shader URL flags found; visualisation is gated behind quality presets and ad-hoc console tweaks (`__setBloomIntensity`, etc.).
- **ACE log echo capture mode** — referenced in memory ([Phase K.1 PASS]) but lives in the ACE integration layer, not the web client.

---

## Notes on accuracy

Line numbers are not given per-symbol — this inventory was compiled from a directory-wide scan and identifies the defining file for each surface. Use `grep -n '<symbol>' <file>` to locate the exact line. Several plugin-side prefixes (e.g. `[research/cast]`) span multiple files; the prefix is canonical, the file path is the most likely entry point.
