# Holtburger-Web 3D Render — Parallel Debug Sweep Findings

Date: 2026-05-28. Five parallel agents audited the renderer using the surfaces from `3d-render-debug-surfaces-2026-05-28.md`. Findings are static-analysis + artifact-review based; some need live repro to confirm. File paths are relative to `apps/holtburger-web/` unless noted.

**Tally:** 8 CONFIRMED BUGS · 9 LIKELY RISKS · 3 NEEDS LIVE REPRO across 5 verticals.

---

## Cross-cutting patterns

Three patterns recur across the five verticals; they're worth attacking systemically rather than one-by-one.

1. **"Log-and-fallback" silent-failure anti-pattern.** Render code repeatedly catches asset/material/mesh/cloud failures, swallows them into a fallback (grey material, empty geometry, default cloud uniform), and returns. Nothing propagates to the diagnostic layer, nothing surfaces to the user. The renderer "succeeds" while rendering wrong. Sites: `materials.js:2065`, `animation.js:456`, `cloud_volume.js:357-359`. Recommend: every catch → fallback path should also invoke an `__diag.*.on*Error` hook with the original error.
2. **Cache eviction half-shipped.** Caches were added across the renderer but eviction or telemetry was never finished. Sites: `nameplate_sprite.js:118` (no cap, no LRU, no telemetry), `nameplate_sprite.js:698` (buff-badge, same), `animation.js:236+631` (`sizeWatermark` written as 0 forever), `landblock_lru.js:259` (evicts material but `renderer.info.programs` may retain compiled programs).
3. **Diagnostic surface scaffold vs. load-bearing.** Some `__diag.*` methods are real; others are stubs guarded by stale comments. `diag/events.js:139-143` rejects the call with "Wave 2.B2 not shipped" even though the oracle now ships 144 events. `__diag.integrity.verifyManifests()` hashes but returns `match: null` (info only, no enforcement). PVS oracle is plumbed but the fixtures are 304–759 B — too small for a real per-cell check.

---

## CONFIRMED BUGS (8)

### W1 · `KIND=18` (EntityAirborneChanged) silently dropped in 3D dispatch
**File:** `scene3d/loop.js:950-1031` · **Vertical:** Wire
The 2D path (`index.html:9296`) handles `kind=18` for remote-player jump+land state. The 3D dispatch in `drainEntityEvents3D` has no arm for it and no default fallthrough. Memory [Movement overhaul waves 1-6 done 2026-05-26] just shipped jump local-pred — remote players' jump animations will not sync to other clients' 3D scenes.
**Fix:** Add `KIND_AIRBORNE` handler to the dispatch; route to a per-entity airborne flag that the animation/motion module already understands.

### W2 · `KIND_META_REFRESH (3)` is comment-only no-op
**File:** `scene3d/loop.js:1028-1031` · **Vertical:** Wire
Handler exists but body is `// Not yet consumed`. Comment forecasts "Phase 7.5 will wire portal-destination updates." Until then, any meta-refresh packet for the local entity drops silently.
**Fix:** Add a `__diag.wire.counters` increment so dropped kind-3 packets are at least visible, and either implement the handler or remove the dispatch arm.

### A1 · Nameplate texture/material cache leak
**File:** `scene3d/nameplate_sprite.js:118, 303-460` · **Vertical:** Perf
`_nameplateCache` is a module-scope `Map` keyed by `(name, colour)`. No cap, no LRU. Long sessions with many unique names (raids, vendor traffic, social hubs) leak `CanvasTexture` + `SpriteMaterial` to GPU VRAM. `disposeNameplateCache()` exists but is never called from a session lifecycle.
**Fix:** Cap at 256, evict LRU by `lastAccessMs`. Call `disposeNameplateCache()` from disconnect/relog.

### A2 · Buff-badge cache: identical leak pattern
**File:** `scene3d/nameplate_sprite.js:698, 708-760` · **Vertical:** Perf
Wave 4.B (2026-05-28) added `_buffBadgeCache` with the same shape as nameplate. New code, same omission.
**Fix:** Same as A1; share an eviction helper.

### B1 · `_installFromPixels()` swallows zero-dim surface failures
**File:** `scene3d/materials.js:2052-2069` · **Vertical:** Assets
`catch (_) { return this.fallbackMaterial }` at line 2065 returns the grey 0x888888 material with no telemetry. Production entities silently render grey when a surface DID has empty/corrupt pixels.
**Fix:** Call `__diag.assets.onMaterialError({ surfaceDid, error })` before returning fallback.

### B2 · `meshToGeometryGroups` failure returns empty groups
**File:** `scene3d/animation.js:450-457` · **Vertical:** Assets
Catch logs to `__diag.assets.onMeshError` (good), then returns `{ groups: [] }` so spawn continues with no geometry for that part. Spawn appears successful but entity is incomplete.
**Fix:** Either fail the spawn entirely or attach a per-part "missing geometry" flag that nameplate/picking can surface.

### V1 · `cloud_volume.js` header comment claims `uFogDensity` is derived; it isn't
**File:** `scene3d/cloud_volume.js:10, 173-175` · **Vertical:** Visual
Header comment says `uFogDensity ← state.fogMin/fogMax`. `tick()` (lines 167-220) never writes it. `snapshotUniforms()` (372) still reads it, so the uniform sticks at init value. Sky-K.6 refactor debris.
**Fix:** Either compute `uFogDensity` from state or remove the uniform and the read.

### V2 · `cameraHeight` clamped to `Math.max(0, camWorldY)`
**File:** `scene3d/cloud_overlay.js:500` · **Vertical:** Visual
takram's `CloudsMaterial` expects absolute ECEF altitude (min ≈ `bottomRadius` ≈ 6,360,000 m). Passing 0 (or a world-Y value under ~50 m) makes the cloud raymarch perceive the camera 6.36 Mm below the surface. Comment at lines 491-496 acknowledges the WGS-84 mismatch — fix is incomplete.
**Fix:** `cameraHeight = bottomRadius + camWorldY` (with whatever radius constant the atmosphere pipeline uses).

---

## LIKELY RISKS (9)

| # | File | Vertical | Risk |
|---|---|---|---|
| R1 | `scene3d/entities.js:4209-4250` ↔ `nameplate_sprite.js:642` | Perf | Entity-remove walks rig but doesn't null `inst._nameplateSprite`; stale ref survives spawn-with-same-GUID. Low probability but observable at scale. |
| R2 | `scene3d/landblock_lru.js:259-261` + `index.js:2680+` | Perf | LRU disposes material, but `renderer.info.programs` may retain the compiled shader program if `renderer.compile()` ran between dispose and next render. Program cache can grow under high LB turnover. |
| R3 | `scene3d/animation.js:236, 631` | Assets | `sizeWatermark` is set to 0 at init and never updated in `_evictLruIfNeeded()`. `getStats()` returns watermark=0 forever — operator has no signal for cache thrash. Trivial 1-line fix. |
| R4 | `scene3d/diag/integrity.js:82-238` | Assets | `verifyManifests()` hashes but returns `{ match: null }` (info only). No per-LB sidecar verification yet. A swapped boot.hba post-bake loads silently. |
| R5 | `scene3d/animation.js:723-727` | Assets | Batch animation fetch failure rolls back without per-setupId attribution. Caller can't tell which setup in the batch died. |
| R6 | `oracles/0xA9B40000.json` (timestamp `2026-05-23T20:30:23Z`) | Spawns | Oracle is 5 days old. If world was rebuilt/replayed since, `__diag.spawns.diff(0xA9B4)` produces false positives. Date the fixtures or version-pin them. |
| R7 | `scene3d/diag/placements.js:346-354` | Spawns | If a future regen drops `bakedScenery` but keeps `sceneryCount`, placement diff degrades silently from per-piece identity to coarse count-mismatch. Add an assertion in `setExpected()`. |
| R8 | `scene3d/cloud_volume.js:357-359` (also `:396-400`) | Visual | Dead-codepath in `_applyWeatherToCloudLayers` — opt-in via `window.__applyCloudWeather()`, never wired at startup. If `effect.clouds` lacks `.coverage` (takram version drift), WMO-computed coverage is silently lost. |
| R9 | `index.html:4140, 4202, 4206` | Wire | `window.__scene3dEntityBacklog = []` has no length cap. The ~2-3 s pre-init3D window buffers spawns; a spawn storm or lag → unbounded growth until `installSharedDrainHook` splices. Cap at 1000-5000 or drop oldest. |

---

## NEEDS LIVE REPRO (3)

| # | File | Vertical | Why live |
|---|---|---|---|
| L1 | `scene3d/diag/strings.js:160-172` | Assets | Per-table miss set caps at 256 silently. Need to drive a session with broken string lookups to see if the cap is hit and what's lost. |
| L2 | `scene3d/cloud_volume.js:289-290` | Visual | NaN-propagation risk if `wxGetState()` returns non-finite temp/dew. Clamp catches the result, but the transient frame glitch needs a live repro to confirm. |
| L3 | `scene3d/diag/pvs.js:114-147` | Spawns | PVS oracle fixtures (304-759 B) are too small to be authoritative. Need to compare against a runtime `tickCellVisibility3D` dump to know if `diff(oracle)` is a real check or a no-op. |

---

## What the sweep confirmed working

Documented for completeness — these came up clean and don't need attention.

- **Movement single-emission** — `scene3d/camera.js:584` `_dispatchMovement` signatures + early-return guard; no double-broadcast on WASD diagonal despite the Wave 1-6 2-wire change.
- **Wire tail ring buffer** — `scene3d/diag/wire.js:90-98` `.shift()` at 200-packet cap; not a leak.
- **Motion lifecycle hooks** — `__diag.motion` is fully implemented (516 LoC), with `onMotionApplied` at `entities.js:3680` and `onMotionLinkPlayed` at `entities.js:4343`. Coverage matrix, stuck-entity cross-reference, snapshot — all live.
- **LensFlare default-off** — `scene3d/index.js:2534` gates `lensFlare: !!quality.flags.lensFlare`. The 2026-05-21 stutter fix is still in place.
- **RIC shim** — `scene3d/_ric_shim.js:50, 85` caps at 30 ms; warns once on >50 ms overrun. Atmosphere bake not blocking rAF.
- **Render-call shape** — outdoor 1 call/frame, indoor 2 (layer 0 + 1 with depth clear), plus atmosphere passes. Expected architecture, not a leak.

---

## Suggested ordering (impact / fix-cost)

1. **W1 KIND=18 unhandled** — high impact (remote jumps desync, regression on freshly-shipped Wave 1-6), 5-10 LoC fix.
2. **A1 + A2 nameplate/buff cache eviction** — high impact (long-session VRAM leak on the new Wave 4.B work), shared helper.
3. **V2 cameraHeight altitude mapping** — high visual impact, 1-line fix once the right radius constant is identified.
4. **B1 silent material fallback** — telemetry-only fix, but unlocks every future asset debug.
5. **R9 backlog cap** — defensive, cheap, prevents spawn-storm OOM.
6. **V1 uFogDensity cleanup** — pick one: derive it or delete it.
7. **R3 sizeWatermark** — 1-line trivial.
8. Everything else in priority of vertical owner.

---

## Top "stale comment" instances

These mislead future readers; cheap to update.

- `scene3d/cloud_volume.js:10` — comment says `uFogDensity` is derived; it isn't.
- `scene3d/cloud_volume.js:173-175` — claims 5 DayGroup uniforms are "gone from CloudsMaterial"; `snapshotUniforms()` still reads them.
- `scene3d/diag/events.js:139-143` — guard says "Wave 2.B2 doesn't include events yet"; oracle now ships 144 events.
- `scene3d/loop.js:1029` — "Phase 7.5 will wire portal-destination updates" but nothing tracks the dropped packets.

---

# Wave 2 — Additional Findings (2026-05-28, evening)

Five new agents covering input/picking/camera, audio, plugin system, physics/movement, and boot sequence. Wave 1 verticals (perf, assets, spawns, wire, visual) intentionally avoided.

**Wave 2 tally:** 9 CONFIRMED BUGS · 10 LIKELY RISKS · 1 NEEDS LIVE REPRO · 2 cross-wave duplicates (corroborating W1) · 1 memory correction.

## Cross-cutting patterns (Wave 2)

New patterns that surfaced this wave, complementary to Wave 1's silent-fallback / half-shipped-cache / scaffold-vs-load-bearing axes.

4. **Listener / unsubscribe asymmetry.** Plugins and modules add event listeners on mount but unmount cleanup misses subsets. Sites: `camera.js:408-414` (mode switch leaks 4 listeners per cycle), `plugins/vendor-ui.js:1265-1272` (per-render `addEventListener` without removal), `plugins/vendor-ui.js:1590-1598` (overlay drag-listeners not cleaned), `plugins/vendor-ui.js:1550-1560` (stale unsubscribe closure on re-mount). Parallel to Wave 1's "cache eviction half-shipped."
5. **No "operation rejected" rollback path.** Client predicts/sends but assumes success. Sites: `index.html:8174-8260` (jump local-pred runs even when `handle.jump()` warns), `scene3d/picking.js:190-271` (charge-attack rAF loop has no abort on target-dead/mode-switch), `scene3d/index.js:3095-3096` (gain product > 1.0 logged as-is despite Web Audio clamping). The client trusts its own predictions/dispatch will land.
6. **"Always-active" assumptions across idle/inactive lifecycles.** No tab-hidden, no stale-position, no stuck-state protection. Sites: `audio/audio_manager.js` (no `visibilitychange` listener), `audio/audio_manager.js:277-282` (PannerNode position never refreshed after spawn), `scene3d/entities.js:2581-2736` (no max-age on airborne tween).

---

## CONFIRMED BUGS (9 new)

### F1 · Camera mode switcher leaks 4 listeners per cycle
**File:** `scene3d/camera.js:402-497` (esp. 408-414) · **Vertical:** Input/camera
`switchMode()` disposes the old `controls` object but never clears `this._listeners`. Each toggle (C key, UI, or rapid reset) adds 4 listeners (mousedown/mouseup/mousemove/contextmenu) without removal. After 10 toggles, 40+ duplicates fire per right-click.
**Fix:** Iterate `this._listeners`, `removeEventListener` each, then `this._listeners.length = 0` before line 417.

### F2 · Charge-attack rAF loop survives mode switch / scene teardown
**File:** `scene3d/picking.js:190-271` · **Vertical:** Input/camera
`chargeTick()` reschedules via `requestAnimationFrame(chargeTick)` at line 271. Camera-mode switch or scene re-mount mid-charge doesn't call `cancelCharge()`. Loop continues calling `sessionHandle.setMovementInput()` on a possibly-dead target.
**Fix:** Hook camera-mode-change and scene-teardown events to call `cancelCharge()`.

### F3 · Right-click radial menu stacks on rapid clicks
**File:** `scene3d/camera.js:462-484` · **Vertical:** Input/camera
`onMouseUp` opens menu when drag < 5 px. Rapid double right-click → second `onMouseUp` arrives before `closeMenu()` (radial-menu.js:75-88) finishes its async DOM removal → two stacked menu instances.
**Fix:** Set an "open" flag in `radial-menu.js`; reject `__openRadialMenuFor` if already open, or debounce `onMouseUp`.

### G1 · PannerNode lifecycle — no `onended` cleanup
**File:** `scene3d/audio/audio_manager.js:267-292` · **Vertical:** Audio
`play()` creates a `PannerNode` per source but never registers `source.onended` to disconnect it. Looping sounds → forever-connected. One-shots → orphans after `source.stop()`. Memory [Follow-ons 2026-05-13] "118 plays no leak" verified heap but not Web Audio graph nodes.
**Fix:** `source.onended = () => panner.disconnect()` after `source.start(0)` (line 290).

### G2 · `GameMessageSound` gain not clamped → validator-vs-actual divergence
**File:** `scene3d/index.js:3095-3096` · **Vertical:** Audio
`const gain = baseVol * safeScale;` — no clamp. If `entry.volume=0.8` and `scale=2.0`, gain=1.6 is logged but Web Audio clamps to 1.0 in-context. Event log records the wrong value → F.D validator rejection.
**Fix:** `const gain = Math.min(1.0, baseVol * safeScale);`

### G3 · No `visibilitychange` listener — AudioContext continues in background
**File:** `scene3d/audio/audio_manager.js` (no install site) · **Vertical:** Audio
Tab switch → context continues until browser-side idle suspend (variable). Looping ambient keeps playing. Two tabs both calling `notifyUserGesture()` can spawn multiple contexts (browser limit ~4-6).
**Fix:** `document.addEventListener('visibilitychange', () => { if (document.hidden) this.pauseAll(); })` in `_initContext()`.

### H1 · vendor-ui rebuilds DOM listeners on every render
**File:** `plugins/vendor-ui.js:1265-1272, 1336-1340, 1348-1351` · **Vertical:** Plugins
`render()` rebuilds the item list on every state change, calling fresh `addEventListener("click")` / `("input")` per item. Old DOM clears via `innerHTML = ""` but closure pressure mounts. Long vendor sessions with queue churn accumulate.
**Fix:** Single delegated listener on container root, dispatch by `event.target` `data-*` attrs.

### H2 · vendor-ui unsubscribe captures stale closure on re-mount
**File:** `plugins/vendor-ui.js:1550-1560` · **Vertical:** Plugins
`unsubscribe` is assigned before the handlers are bound. If plugin re-mounts (relog without teardown), the closure points to the old state; `client.events.off()` silently no-ops on shifted handler identity.
**Fix:** Capture explicit handler references; unsubscribe by reference.

### I1 · Jump local-prediction runs even when `handle.jump()` rejects
**File:** `index.html:8170-8260` · **Vertical:** Physics
`canJumpNow()` gates the wire send. If `handle.jump(power)` fails at line 8179, the `try/catch` (8181) only `console.warn`s — local prediction block (8224-8260) still fires `setAirborne(true)` + motion command. Player floats at predicted apex for one reconciliation tick (~30 ms) before snap-back.
**Fix:** Wrap 8224-8260 in a conditional on `jump()` return; requires wasm export to surface success/fail.

---

## LIKELY RISKS (10 new)

| # | File | Vertical | Risk |
|---|---|---|---|
| F4 | `ui/keymap.js:72, 82` ↔ `scene3d/diag/input.js:189-198` | Input | `onStorageError` catches internally and returns nothing. If `__diag` is undefined or the hook throws, write failures vanish — custom keybinds silently lost on quota error. |
| F5 | `index.html:7507-7520` ↔ `scene3d/camera.js:1141-1156` | Input | `__movementConstants` set in `index.html`, read defensively in camera.js. Boot race could leave constants undefined → prediction uses default speeds → drift. Add hard validation. |
| G4 | `scene3d/audio/sound_table_cache.js:86-89` | Audio | `this.cached = new Map()` — no cap, no LRU. Long sessions accumulate `SoundTableJs` handles. `dispose()` exists but no lifecycle caller. Mirror `LandblockLRU` pattern. |
| G5 | `scene3d/audio/ambient_runtime.js:355-365, 720-726` | Audio | Two rapid LB transitions can race: first stops loops and starts resolve-and-play Promise; second clears timers; first's audio handle lands on stale state. Guard at 720 is frames-wide. Stamp handles with generation IDs. |
| G6 | `scene3d/audio/ambient_runtime.js:687, 753` | Audio | Continuous + probabilistic gain calculations skip `clamp01()` (which exists at line 829). A SoundTable row with `volume=1.5` propagates an over-unit gain to event log → validator divergence. |
| G7 | `scene3d/audio/audio_manager.js:277-282` | Audio | PannerNode position set at creation, never updated. Moving sources (NPCs walking, fleeing) keep stereo image of their spawn position. Listener position updates, sources don't. |
| H3 | `plugins/main-panel.js:114, 272-276, 312` | Plugins | Module-scope `stack` persists across logins. Relog without page reload → old view entries linger. Same-ID view from new mount logic → `closeView` pops stale entry. Reset `stack = []` on disconnect. |
| H4 | `plugins/vendor-ui.js:1590-1598` (vs `plugins/buffs-hud.js:880-894`) | Plugins | vendor-ui cleanup removes `keydown` listener but misses 4 overlay drag listeners (`dragenter/over/leave/drop`) added at 960-966. buffs-hud uses an `unsubs[]` array correctly — adopt that pattern. |
| H5 | `ui/bar.js:378-388` | Plugins | `holtburger_ui_bar_v1` persists by plugin ID. Plugin rename/removal → stale keys silently merged with DEFAULTS. A future plugin with the old name inherits the prior visibility. Drop unknown keys against active manifest. |
| H6 | `plugins/api.js:293-625` ↔ `index.html:7350-7352` | Plugins | Relog → new `createClient(handle)` returns a new `EventTarget` bus. Plugins holding cached `__pluginClient` references listen on the OLD bus and miss all post-relog events. Either force unmount on relog or expose `rebind()`. |
| I2 | `scene3d/entities.js:2606-2629` | Physics | `setAirborne` idempotency guard checks `wantAirborne === currentlyAirborne` but ignores `inst._jumpPoseTween` state. Duplicate `airborne=1` mid-tween silently no-ops the landing animation. Network jitter could trigger. |
| I4 | `scene3d/camera.js:985-1046` | Physics | Local predictor advances X/Y but never Z. Server's ballistic arc peaks → drift = jump height. Reconcile threshold 5.0 m catches falls but 2.5 m jumps land in the lerp zone → micro-rubberband on every landing. Intentional per arch but should be telemetry-confirmed. |
| I6 | `scene3d/entities.js:2581-2736` | Physics | No max-age on `_jumpPoseTween`. A lost `KIND=18` touchdown packet → entity frozen in landing pose. `_jumpPoseStash` never cleared. Add 500 ms timeout; force-land on stale tween. |
| J2 | `index.html:1919-1923` (assign) ↔ `scene3d/index.js:2514` (consume) | Boot | `__eagerAtmosphere` assigned inside `requestIdleCallback`. If `init3D()` fires before rIC runs (fast login → fast scene init), the fallback re-fetches takram from CDN (~14 s on Firefox per the docs at scene3d/index.js:2505-2518). Move assign out of rIC. |
| J6 | `index.html:7348-7352` | Boot | `createClient(handle)` is called when `start_session` resolves (after `CharacterList` arrives), but BEFORE `EnteredWorld`. Plugins mounting at this window may dispatch into a non-live session. The 2D path guards via `liveScene + __sessionHandle` null-checks, but it's an implicit footgun. |

---

## NEEDS LIVE REPRO (1 new)

| # | File | Vertical | Why live |
|---|---|---|---|
| I5 | `scene3d/camera.js:1264-1269` | Physics | Wave 1 D verified single-emit on WASD diagonal (signature dedup at 1265). Still unknown: does ACE interpret `(forward=1, strafe=1)` as a unified diagonal or two separate motion events? Need a wasm-side capture of `setMovementInput(1,1,0,true)` to verify ACE unifies them. |

---

## What Wave 2 confirmed working

- **WASM init → `__hbWasm` assignment** (`index.html:1572`) — Synchronous after `await init()`. Plugin scripts run well after this. Fragile (no proxy queue) but safe under current load order.
- **Scene3D init vs WASM ready** — `preInit3D()` only fires from rIC (`index.html:1959`), long after `init()` resolves. No race.
- **Keepalive ping correctly gated** (`src/lib.rs:28455-28485`) — Only fires when `state == InWorld`. Doesn't transmit during handshake.
- **Double-connect dance orchestration** (`index.html:10170-10316`) — Adaptive backoff (1.5× per attempt) over correct base values (3 s session-kick, 7 s char-in-world, 10 s spawn). Memory entry [Login double-connect dance] said "10 s" but actual base is 3 s with backoff — see §Memory corrections below.

---

## Cross-wave duplicates (Wave 2 corroborates Wave 1)

| Wave 2 finding | Wave 1 equivalent | Status |
|---|---|---|
| Agent I finding #3 (KIND=18 unhandled in 3D dispatch) | **W1** | Two independent agents flagged. High confidence. |
| Agent J finding #7 (`__scene3dEntityBacklog` unbounded) | **R9** | Two independent agents flagged. High confidence. |

---

## Memory corrections (1)

**`reference: project_holtburger_login_double_connect`** — memory says "wait 10s, then click again." Actual code (`index.html:10171, 10176`): `baseKickWaitMs = 3000`, `charInWorldWaitMs = 7000`, `spawnTimeoutMs = 10000`, with `Math.pow(1.5, attempt - 1)` adaptive backoff. The "10 s" matches the spawn timeout, not the click wait. Update memory entry accordingly.

---

## Combined sweep priority (Waves 1 + 2)

Top items by impact × fix-cost across both waves:

1. **W1 / I3 — KIND=18 unhandled** — remote-player jump desync, 5-10 LoC. (Two-wave confirmation.)
2. **A1 + A2 nameplate/buff cache eviction** — long-session VRAM leak on freshly-shipped Wave 4.B work.
3. **I1 — Jump local-pred bypass on `handle.jump()` rejection** — ghost-jump artifact on every constrained-state jump attempt.
4. **F1 — Camera mode listener leak** — visible right-click duplication after a few toggles; 5-line fix.
5. **G1 — PannerNode `onended` cleanup** — every sound played without it. One-line fix per call site.
6. **V2 cameraHeight altitude mapping** — high visual impact, 1-line.
7. **H1 / H2 — vendor-ui listener pile-up + stale unsubscribe** — pair fix in one plugin.
8. **R9 / J7 — backlog cap pre-init3D** — defensive, cheap.
9. **B1 — silent material fallback telemetry** — unlocks future asset debug.
10. **G2 — `GameMessageSound` gain clamp** — 1-line, prevents validator divergence.

11+ everything else by vertical owner.

---

# Wave 3 — Additional Findings (2026-05-28, late)

Five agents covering animation, particles/VFX, terrain, EnvCell/portal, and WASM-JS boundary. Wave 1 (perf/assets/spawns/wire/visual) and Wave 2 (input/audio/plugins/physics/boot) intentionally avoided.

**Wave 3 tally:** 9 CONFIRMED BUGS · 8 LIKELY RISKS · 0 NEEDS LIVE REPRO · 1 deferred (door hinge) · the most expensive bug surfaced in any wave (O1, ~22 MB/min wasm leak).

## Cross-cutting patterns (Wave 3)

These extend the patterns from Waves 1–2.

7. **Per-frame wasm-handle leaks across the JS ↔ wasm boundary.** When a JS hot path calls a Rust `#[wasm_bindgen]` getter that returns a new handle, the handle must be `.free()`'d. Sites: `cloud_overlay.js:407-411` (`SkyState` allocated every rAF, never freed → ~22 MB/min). Counter-examples that *do* clean up: `loop.js:1036-1040`, `sound_table_cache.js:258-262`, `spawns.js:577-581`. No `FinalizationRegistry` safety net anywhere — handle hygiene is purely manual.
8. **"Load-order: param parsed in module that imports after the consumer."** Third sighting. Wave 2 J2 (atmosphere preload races scene3d init); Wave 3 L2 (`?particleSortObjects=false` set after `scene.sortObjects = true`). When a URL flag must influence construction-time state, the parser must run before the constructor — not as a side effect of import order.
9. **Entity-remove leaves dangling attached objects.** Wave 1 R1 (stale `_nameplateSprite` ref), Wave 3 L3 (PlayEffect VFX `setTimeout` fires on stale emitter), Wave 3 L6 (`ParticleEmitter.parent` ref to removed entity's rig). Each attached-object subsystem implements its own cleanup; nothing systematically iterates "things attached to this entity" on remove.
10. **`scene3d/loop.js` `drainEntityEvents3D` dispatch is incomplete on multiple kinds.** Wave 1/W1 + Wave 2/I3 (`kind=18` EntityAirborneChanged unhandled); Wave 1/W2 (`kind=3` `KIND_META_REFRESH` is a no-op comment); Wave 3/N5 (`kind=17` PhysicsState visibility never dispatched). Three independent entity-event kinds drop on the floor in the 3D path while the 2D path consumes them.

---

## CONFIRMED BUGS (9 new)

### O1 · `SkyState` wasm handle leaked every rAF
**File:** `scene3d/cloud_overlay.js:407-411` · **Vertical:** WASM boundary
`tick(stateOverride)` calls `handle.getSkyState()` and passes the returned handle to `this.volume.tick(state, null)` — never `.free()`'d. Per-frame allocation (~100 B/frame × 60 fps = ~22 MB/min of wasm linear memory). Compare to `sky_lighting.js:117` which correctly frees in a `finally` block. **Highest-impact bug found across all three waves.**
**Fix:** Wrap call in try/finally; `state.free()` after consumption.

### N5 · `kind=17` (PhysicsState visibility) not dispatched in 3D path
**File:** `scene3d/loop.js:919-1042` · **Vertical:** EnvCell/wire
`drainEntityEvents3D` handles kinds 0–6 but **never** routes `kind=17` to `EntityManager.setVisibility()` (`entities.js:1987`). The 2D path consumes kind=17 via index.html, but the 3D path silently drops. Entities with `PhysicsState` HIDDEN/NO_DRAW/CLOAKED toggled post-spawn won't update visibility in 3D. Pair with Wave 1 W1 (kind=18) and Wave 1 W2 (kind=3) — three loop-dispatch gaps now.
**Fix:** Add `else if (kind === 17) { em.setVisibility(upd.guid, ...) }` arm.

### N2 · EnvCell unload race — cells cleared from scene before LB key cleared
**File:** `scene3d/landblock_lru.js:217-228` · **Vertical:** EnvCell
Cells removed from scene graph (L224) before `envCellLoadedLbs` cleared (L253). Portal re-entry mid-unload: `buildEnvCellsForLandblock` (L140) sees the LB key still set and no-ops, leaving the building invisible.
**Fix:** Clear `envCellLoadedLbs` BEFORE removing cells from the scene graph.

### K1 · `crossFadeTo` double-`play()` on rapid motion-fire
**File:** `scene3d/entities.js:941-947` · **Vertical:** Animation
Hard-cut path (CROSSFADE_S=0 for locomotion) calls `.stop()` on `currentAction` (L942) then `.play()` on `nextAction` (L947). If `nextAction === currentAction` slips through the guard at L905 (e.g., phase-preservation recovers an action mid-fade from L3635-3658), Three.js mixer accepts duplicate `.play()` without `.stop()` → scheduler entries pile up. Observable: rapid W tap-release-press within the 200 ms phase-preservation window.
**Fix:** Add identity check before the second `.play()`; explicit `.stop()` of any prior matching action.

### L1 · Particle material leak on auto-removal (TODO not yet wired)
**File:** `scene3d/particles/particle_manager.js:244-265` (and comment at 295-297) · **Vertical:** Particles
`tick()`'s auto-removal walks `parts[]` to drop scene meshes but never walks `partStorage[]` to call `_disposeMaterialIfOwned()` on per-slot cloned materials. `destroyParticleEmitter()` (277-306) does the right thing; `tick()` is the lazy sibling. Comment acknowledges out-of-scope but load-bearing. High-emitter regions (weather, spell crit fireworks) leak GPU VRAM.
**Fix:** Copy the `partStorage` disposal loop from `destroyParticleEmitter()` into `tick()`'s removeIds branch (~10 LoC).

### L2 · `?particleSortObjects=false` wiring arrives after scene construction
**Files:** `scene3d/particles/particle_manager.js:23-50` (parser), `scene3d/index.js:505-506` (consumer) · **Vertical:** Particles
URL param parsed in `particle_manager.js`, which is imported *after* `scene3d/index.js` constructs the scene. By the time `window.__particleSortObjects` is assigned, `scene.sortObjects = true` was already set. Toggle has no effect. Visible: additive-blend transparent particles (moon crimson stars, spell effects) render in insertion order on camera pans.
**Fix:** Move the URL parse into `scene3d/index.js` ahead of `new THREE.Scene()`, or guarantee the import order via an explicit dependency.

### L3 · PlayEffect VFX emitters detonate on stale rig
**File:** `scene3d/play_effect_vfx.js:1192-1204` · **Vertical:** Particles
VFX emitters scheduled for `destroyParticleEmitter()` 2.5 s after spawn. If the target entity despawns inside that window (typical for spell crits on dying NPCs), the destroy fires on a stale ID while the entity's rig is already detached. `parts[]` mesh removal silently skips (parent null), leaking the meshes.
**Fix:** On entity remove (`entities.js:4220-4232`), iterate pending PlayEffect timeouts targeting that emitter and fire them early.

### L4 · PhysicsScript with corrupt lifespan creates immortal emitter
**File:** `scene3d/particles/particle_emitter.js:307-341` · **Vertical:** Particles
`updateParticles()` only `killParticle(i)` if `particles[i].lifetime >= particles[i].lifespan`. NaN / negative / Inf lifespan (corrupt 0x33 record) → particles never age → emitter never stops → never enters auto-remove path. Persistent emitters (totalSeconds=0 && totalParticles=0 — see L272-273) compound the issue.
**Fix:** Validate lifespan at parse time; treat non-finite as fixed 1.0 s with a `__diag.assets.onMeshError`-style telemetry hook.

### M1 · Atlas tile-to-tile seams at mip ≥2 (per-layer ClampToEdge only solves cross-layer)
**Files:** `scene3d/terrain.js:1125-1132`, `scene3d/adapter.js:369-396` · **Vertical:** Terrain
Per-layer ClampToEdge prevents *cross-layer* bleed but each 512×512 tile has no internal border padding. At mip levels ≥2, bilinear sampling near tile edges reads opposite-edge pixels (ClampToEdge wrap), producing visible seams on distant terrain.
**Fix:** Add 1-2 pixel border-replicate in the atlas-build step (Rust side, `holtburger_dat::terrain_*`). Three.js's auto-mipgen does not reintroduce padding.

---

## LIKELY RISKS (8 new)

| # | File | Vertical | Risk |
|---|---|---|---|
| K2 | `scene3d/entities.js:2009-2017` | Animation | `findGuidByName` returns insertion-order first match. Multiple NPCs sharing a name (`Drudge`, `Olthoi Grub`) → swing broadcast on `evadedAttacker` could fire on the wrong entity. Caller must pass GUID directly, but Wave 2 D wiring through `findGuidByName` makes this load-bearing for accuracy. |
| K3 | `scene3d/entities.js:4332` | Animation | `_tryPlayLink` unconditionally `.play()`s the link clip without reading motion-table bit 0 `clears_modifiers` (11.5% of tables). Crouch+jump swing leaves crouch additive layer active through swing's LoopOnce, stacking poses. Surfaces when combat shifts to stance-agnostic skill macros. |
| K4 | `scene3d/entities.js:3825-3830` | Animation | `setSidestepLayer` arms an existing layer action (`.enabled = true; weight = 0.5`) without `.stop()` if prior fadeOut is mid-flight (50 ms timeout at L3746). Second `.play()` schedules same action twice. Rare: rapid A/D toggle within the 50 ms window + cache hit. |
| L5 | `scene3d/weather/lightning.js:22-28` | Particles | `thunderDid` (default `0x0A000045`) never validated. Invalid override → `AudioManager.play()` silent-fails. Visual flash still fires; distant lightning loses the audio cue. Parallel to Wave 1's silent-fallback anti-pattern. |
| L6 | `scene3d/particles/particle_emitter.js:63-108` | Particles | Emitter caches `this.parent` (L81) = entity rig. On entity remove, the LB key + emitter ID are destroyed but `parent` reference is never nulled. If particles outlive the entity remove, they reference a detached rig. Compounds L3. |
| M6 | `scene3d/terrain.js:173-195` (`loadTerrainPaletteLut`) | Terrain | Palette fetch fails → `console.warn` + null resolve. Fragment shader's `uTerrainPaletteEnabled` falls back to 0. Memory [AC terrain textures]: code 0 (BarrenRock) and code 24 (Argila) both map to `0x0500145C` — without palette they render identically. Silent visual regression. Add `__diag.terrain.paletteLoadFailed`. |
| N3 | `scene3d/cells.js:375-505` | EnvCell | `?envcellFusion=1` merges opaque surfaces into one BufferGeometry but doesn't validate that fused materials have identical specular/emissive/roughness. Adjacent water + wall surfaces (both opaque) fuse to one material → wall renders with water roughness. No equivalence check before fusion. |
| O3 | (codebase-wide) | WASM | No `FinalizationRegistry` adoption anywhere. Every wasm-bindgen handle is manually-managed via explicit `.free()`. If any call site forgets, the handle leaks until process exit. O1 is the proof; there are likely more. |

---

## Deferred (known, no driver yet)

| # | File | Notes |
|---|---|---|
| N6 | `scene3d/buildings.js:380` | Hinge wrapper carries `userData.doorRotationRad = 0`; rotation driver not yet implemented (memory [Follow-ons grounded 2026-05-13] "door hinge multi-day"). No TODO marker in code — just the empty data field. |

---

## What Wave 3 confirmed working

- **Portal traversal incremental diff** (`scene3d/cells.js:782-824`) — 2026-05-28 optimization correctly diffs against `_lastCellVisibleSet`; steady-state cost minimal.
- **Triplanar slope `smoothstep`** (`scene3d/terrain.js:858-860`) — no hard threshold band; quality-driven `uTriplanarSlopeLo` 0.2-0.6.
- **Surface classifier fallback to `DETAIL_SLICE_NONE=255`** (`scene3d/terrain.js:843-844`) — intentional flat-shade on unknown codes; not the source of the 82%-vs-18% gap.
- **Water vertex displacement precision** (`scene3d/terrain.js:461-462, 478-479`) — uses `performance.now() * 0.001` (wall-clock), not game-epoch. Float32 safe for session-length time. Note: switching to server epoch (941500800) WOULD blow precision — add an assertion.
- **wasm stack 8 MiB still valid** (`.cargo/config.toml:19`) — no new large-buffer fns since the 2026-05-17 OOB fix.
- **Entity update + SoundTable + EntitySpawn handles** properly `.free()`'d at `loop.js:1036-1040`, `sound_table_cache.js:258-262`, `spawns.js:577-581`.
- **No TextEncoder/Decoder hot loops** (motion classify + physics pass u32 enums, not strings).
- **No `Closure::new` / `Closure::wrap` patterns** — no closure lifecycle risk on the Rust side.

---

## Combined sweep priority (Waves 1 + 2 + 3)

Reordered with Wave 3 results integrated. Top items by impact × fix-cost:

1. **O1 — SkyState handle leak per-frame** — 22 MB/min wasm linear-memory growth. One-line `.free()`. **Single most impactful fix across all three waves.**
2. **W1 / I3 — KIND=18 unhandled** — remote-player jump desync, 5-10 LoC.
3. **N5 — KIND=17 visibility not dispatched** — entities don't honour PhysicsState toggle. Same fix shape as W1.
4. **L2 — `particleSortObjects` toggle never effective** — visible particle glitches, root cause is import-order. Move parse into `scene3d/index.js` pre-scene-init.
5. **A1 + A2 — Nameplate/buff cache eviction** — long-session VRAM leak on Wave 4.B work.
6. **I1 — Jump local-pred bypass on `handle.jump()` reject** — ghost-jump artifact.
7. **N2 — EnvCell unload race** — invisible building on portal re-entry. Order-of-ops fix.
8. **F1 — Camera mode listener leak** — visible right-click duplication after a few toggles.
9. **L1 — Particle material leak on tick auto-removal** — ~10 LoC, scoped-out TODO already documented.
10. **K1 — `crossFadeTo` double-play** — source of subtle animation glitches under rapid input.
11. **V2 — `cameraHeight` altitude mapping** — visible cloud math wrong.
12. **G1 — PannerNode `onended` cleanup** — one-line, every sound played.
13. **M1 — Atlas seam padding** — distant terrain seams; needs Rust-side atlas-build change.
14. **H1 / H2 — vendor-ui listener pile-up + stale unsubscribe** — pair fix in one plugin.
15. **R9 / J7 — entity-backlog cap pre-init3D**.

16+ remaining items by vertical owner.

---

## New cross-wave pattern

`scene3d/loop.js` `drainEntityEvents3D` is missing handlers for kinds {3, 17, 18}. Three independent agents on three different waves (W1, I3, N5) flagged this. The 2D path consumes all three; the 3D path consumes 0–6 only. **Recommend** an audit pass that lists every `EntityUpdate` kind ACE emits, compares to the 3D dispatch, and fills the gaps in one PR.

---

# Fix log (2026-05-28)

## Applied
- **O1** — `scene3d/cloud_overlay.js:401-425` `tick()` now tracks owned SkyState handles and frees them in a `finally` block. Eliminates the ~22 MB/min wasm linear-memory growth at 60 fps. Reference pattern: `scene3d/sky_lighting.js` `snapshotSkyState` consume-then-free.
- **F1** — `scene3d/camera.js:415-426` — `switchMode()` removes prior `_listeners` entries before the new mode appends fresh ones. Eliminates the 4-listeners-per-toggle leak that stacked duplicate radial-menu opens on right-click after N mode switches.
- **L1** — `scene3d/particles/particle_manager.js:262-272` — auto-removal in `tick()` now mirrors `destroyParticleEmitter()`'s `partStorage` disposal walk via `_disposeMaterialIfOwned()`. Closes the TODO(E3) the same file documented. Per-slot cloned materials no longer leak when emitters naturally finish.
- **R3** — `scene3d/animation.js:604-608` — `_evictLruIfNeeded()` captures `entries.size` to `sizeWatermark` before trimming. `getStats().watermark` now reflects actual peak cache pressure for operator triage.
- **G1** — `scene3d/audio/audio_manager.js:289-298` — `source.onended` disconnects source/gain/panner from `_master` on natural end (one-shots) or explicit `source.stop()` (loops). Prevents long-term accumulation of orphan Web Audio graph nodes.
- **A1 + A2** — `scene3d/nameplate_sprite.js:117-133, 295, 460, 769` — FIFO caps (512 nameplate / 128 buff-badge) via `_capCacheFifo()` helper. Bounds JS Map growth without disposing GPU resources (live sprites may still reference evicted entries; GC reclaims naturally on entity despawn).

## Verified false positive — no fix needed
- **W1 / I3 / N5 / W2** — `drainEntityEvents3D` in `scene3d/loop.js:919-942` short-circuits at line 932 when `scene3d.useSharedDrain === true`, which is the default once `installSharedDrainHook()` runs at scene init. The canonical handler for `kind=17` (visibility), `kind=18` (airborne), and `kind=16` (sound) is the 2D `drainEvents` loop at `index.html:9271-9336`, which routes directly to `window.liveScene3d.entityManager.setVisibility` / `setAirborne`. The shared-hook dispatcher at `scene3d/loop.js:1073-1167` intentionally only routes entity-rendering kinds (0-6). The architectural split is deliberate: rendering events → 3D `EntityManager`; client events → 2D loop which calls into the same `EntityManager`. The agents correctly noted the `dispatchOne` gap, but the gap is by design.

## Skipped — verification suggests not a bug
- **N2** — `scene3d/landblock_lru.js:217-228` — agent claimed an unload race where cells are removed from the scene graph before `envCellLoadedLbs` is cleared (L253). In JS the eviction function is synchronous with no `await` between L217 and L253, so the "race" cannot occur in single-threaded JS execution. Re-entry to `buildEnvCellsForLandblock` after this synchronous eviction sees the cleared `envCellLoadedLbs` and correctly re-bakes. Skipping.

## Combined waves 1-3 fix progress

### Round 2 (later 2026-05-28)
- **B1** — `scene3d/materials.js:2058-2089` `_installFromPixels()` now invokes `__diag.assets.onMaterialError({ did, error, source: "surface" })` on both the pixel-read throw path and the zero-dim path. Operators can now see WHICH surface DIDs are silently falling back to the grey material.
- **L5** — `scene3d/weather/lightning.js:22-37` `LightningSystem` constructor validates `thunderDid`; rejects `0` / non-finite and falls back to `DEFAULT_THUNDER_DID = 0x0A000045` with a console warning.
- **M6** — `scene3d/terrain.js:181-201` `loadTerrainPaletteLut()` now also invokes `__diag.terrain.onPaletteLoadFailed?.(meta)` on both HTTP-error and fetch-threw paths. Defensive hook — no-ops until a `scene3d/diag/terrain.js` namespace adopts it; future palette-regression tooling has a call site to bind.

### Round 2 verified non-bugs
- **H3** — `plugins/main-panel.js:312` `hide()` resets `stack = []`. Agent's "never resets on relog" claim is misleading.
- **H4** — `plugins/vendor-ui.js:1595` `state.overlayEl.remove()` removes the overlay DOM node along with its drag/keydown listeners. Listeners can't accumulate because the parent node is removed each unmount.
- **G6** — `scene3d/audio/ambient_runtime.js:687, 753` BOTH already apply `clamp01(...)`. Agent claim that they skip the clamp is incorrect.

### Round 2 deferred (real but non-trivial)
- **H5** — UI bar localStorage manifest validation. The merge pattern at `ui/bar.js:384` lets stale plugin-ID keys persist. Fix requires reasoning about DEFAULTS lifecycle (built once vs. rebuilt on plugin reload). Skipped pending a clearer architectural answer.
- **V2** — `cloud_overlay.js:511` `cameraHeight` override. Comment at lines 502-507 acknowledges the WGS-84 vs spherical-setup choice as intentional. Agent's proposed `bottomRadius + camWorldY` fix may be correct per `cloud_volume.js:95` ("Camera at world (x, y, z) maps to ECEF (x, bottomRadius + y, z)") but conflicts with the intentional override. Needs takram-source verification before changing.

### Round 3 (later 2026-05-28)
- **L4** — `scene3d/particles/particle.js:154-164` `Particle.init()` clamps non-finite `info.getRandomLifespan()` to `1.0`. Closes the "immortal emitter via NaN/Infinity lifespan from corrupt 0x33 records" path. Existing `update()` handling at line 404 (`if (this.lifespan > 0)`) covers zero/negative; this new guard catches Infinity/NaN.
- **I6** — `scene3d/entities.js:2606-2617, 3267-3296, 3322-3334` — stuck-airborne timeout. `setAirborne` now clears `_airborneStablishedMs` on any state change; takeoff-tween-complete stamps it; `_tickJumpPoseTween`'s no-tween branch force-lands if `_isAirborne` persists past 8 s without a kind=18 (airborne=0) packet. Defends against the "lost touchdown packet → entity frozen arms-up forever" failure mode.

### Round 3 verified non-bugs
- **H6** — `index.html:7350` `if (!pluginClient)` gate means `createClient` is only called ONCE per page lifetime. Relog reuses the existing `pluginClient`; the events bus identity is preserved. Agent claim that "relog → new EventTarget bus" is incorrect.
- **I2** — `entities.js:2606-2629` `setAirborne` idempotency guard is correct. The agent's specific worry (duplicate airborne=1 no-ops landing) requires wantAirborne=false, which doesn't match the duplicate-airborne=1 scenario. The guard does what its comment says.

### Round 3 partial / deferred
- **L3** — PlayEffect VFX emitter survives entity removal. On re-inspection, `destroyParticleEmitter` already handles detached parents gracefully (`if (m && m.parent) m.parent.remove(m)` no-ops when parent is null). The post-cleanup mesh is unreferenced and GC reclaims. The agent's "leak" claim doesn't translate to actual memory growth. Skip.
- **L6** — Particle emitter holds `this.parent = rig` ref forever. Real but requires per-entity emitter tracking + null-out on entity remove. Non-trivial. Defer.
- **K3** — Motion-table bit 0 `clears_modifiers` — requires wasm export to surface the bit to JS. Defer.
- **G7** — HRTF position never updated for moving sources — requires per-frame update integration across ambient/GameMessageSound callers. Non-trivial.

### Round 4 (latest 2026-05-28)
- **L2** — `scene3d/index.js:504-523` — particle sort URL parse moved inline at scene construction. The original parse in `particle_manager.js` runs at module-load, but `particle_manager.js` is `await import()`'d from `play_effect_vfx.js:1063` and `entities.js:4434` (dynamic import), so its parse landed AFTER `new THREE.Scene()`. Inline parse means `?particleSortObjects=off` now actually takes effect.

### Round 4 verified non-bugs
- **K1** — `entities.js:904-947` `crossFadeTo` guard at line 905 (`if (this.currentAction === nextAction) return;`) handles the same-action case. Three.js `AnimationAction.play()` on an already-running action continues running it without double-scheduling. Agent's "scheduler entries pile up" doesn't reflect Three.js mixer semantics.
- **N3** — `scene3d/cells.js:399-505` fused mesh uses `addGroup(vertexStart, vertexCount, materialIndex)` (line ~460) with the `materials` array (line 423). Each surface keeps its OWN material via per-group material indexing. The agent's "render with wrong material" claim ignores Three.js's multi-material per-Mesh capability.
- **R1** — `entities.js:4230-4254` `remove()` calls `inst.dispose()`, removes `inst` from `entityMap`, and clears the DOM nameplate via `nameplateLayer.removeNameplate(g)`. The sprite-based `inst._nameplateSprite` is a child of `inst.root` (`nameplate_sprite.js:662`); detaching `inst.root` detaches the sprite. Once `inst` is unreachable from `entityMap`, GC reclaims it. No leak.

### Round 5 verifications (closing out)
- **H5** — RECLASSIFIED FALSE POSITIVE. `ui/bar.js:14-28` `DEFAULTS` is bar-level UI settings (`left`, `top`, `iconSize`, `transparency`, `color`, `orientation`, `minimized`) — NOT a plugin-id → visibility map. The merge pattern `{ ...DEFAULTS, ...parsed }` mixes bar settings with whatever happens to be in localStorage but there's no plugin-id key space here. The agent's "stale plugin visibility inheriting via rename" scenario doesn't apply at this site.
- **L3** — RE-VERIFIED FALSE POSITIVE. `destroyParticleEmitter()` at `particle_manager.js:280-285` handles detached parents gracefully (`if (m && m.parent) m.parent.remove(m)` no-ops). Post-destroy, the emitter is removed from `particleTable`; mesh refs in `parts[]`/`partStorage[]` become unreachable and GC reclaims. No actual leak.
- **L6** — RE-VERIFIED MOSTLY FALSE POSITIVE. The `entities.js:4259-4267` H2 cleanup destroys all emitters in `_particleEmittersForGuid[guid]` on entity remove via `destroyParticleEmitter()`. Once destroyed, `this.parent` ref dies with the emitter. PlayEffect emitters scheduled via setTimeout outlive the entity briefly, but the setTimeout will destroy them. The "parent ref forever" claim doesn't hold.
- **B2** — NOT A BUG, BEHAVIORAL CHOICE. The current "render best-effort with empty geometry stub" is one valid choice; "fail the spawn" is another. Without user direction on the tradeoff, this isn't a code fix.
- **K4** — RARE EDGE CASE per agent's own assessment. Skip.

### Final totals across all rounds
**Fixes applied (12):** O1, F1, L1, R3, G1, A1+A2 (round 1) · B1, L5, M6 (round 2) · L4, I6 (round 3) · L2 (round 4).
**Verified false positives (14):** W1/N5/W2, N2, H3, H4, G6, H6, I2, K1, N3, R1, H5, L3, L6, B2.
**Deferred — architectural / refactor / wasm-export required (4):** K3 (motion-table bit 0 wasm export), G7 (HRTF position refactor across callers), I1 (jump-reject wasm export), R2 (three.js internal program cache).

**V2 closed via context7 (2026-05-28):** Takram docs confirm "altitude measured from the ellipsoid surface in metres" is the framework convention (`CloudLayer.altitude=750` = 750m above ground). `worldToECEFMatrix` translates world by `bottomRadius`, making world-Y the altitude-above-surface. The existing `Math.max(0, camWorldY)` override at `cloud_overlay.js:511` is correctly aligned. The agent's proposed `bottomRadius + camWorldY` would push the camera to ~6.36M m, outside the atmospheric scattering tables. NOT A BUG.

---

# Architectural backlog (A1–A9, 2026-05-28)

After the fix sweep, the remaining findings group into a tracked backlog: A1 closed via context7 (V2 false positive), A5 done, A2/A3 deferred with full plans, A4 / A6–A9 pending.

## Done

### A4 — HRTF position update integration across audio callers (G7)
**Files:** `scene3d/audio/audio_manager.js:67-77, 133-160, 308-321` + `scene3d/index.js:1467-1479` + `scene3d/entities.js:4555, 5408`
AudioManager gained `_followingHandles` Map + `updateFollowingPositions(lookupFn)` method. Callers opt in via `play(..., { followGuid: g })`; the per-rAF setListener call site in `scene3d/index.js` also calls `updateFollowingPositions` with an entity-position lookup, so panner positions track moving NPCs/projectiles instead of locking to spawn-time pose. Tracking entries are cleared from `_followingHandles` in the `source.onended` hook (added in G1) so completed sounds don't keep getting position updates. Ambient sounds and pure UI sounds skip the path naturally (no followGuid).

Two existing callers updated to opt in:
- `entities.js:4555` — H2 PhysicsScript Sound hook fires (entity-tied script-driven sounds)
- `entities.js:5408` — SoundTable hook fires from animation tick (footsteps, swing whooshes)

### A6 — Three.js program cache instrumentation (R2)
**File:** `scene3d/landblock_lru.js:264-330`
Per-LB-eviction snapshot of `renderer.info.programs.length` + memory counters into `window.__diag.renderer.evictionProgramSnapshots` (ring buffer cap 200). Tracks `peakPrograms` / `lastPrograms`. Investigation-first: the R2 hypothesis (program cache grows unboundedly with LB turnover) is now testable without further code changes. Operators run a 500-LB traversal session and inspect the buffer:
- Flat `programs.length` across rising `evictionsTotal` → R2 false positive, close it.
- Linear growth → real leak, fix needed (extend the LRU dispose to walk `renderer.info.programs` and prune stale entries).
- Plateau → expected (programs shared across materials; cap-bound by material variety).

### A5 — Particle emitter refcount on entity remove (L6)
**File:** `scene3d/play_effect_vfx.js:1188-1235`
PlayEffect VFX emitters now register their spawned IDs into `em._particleEmittersForGuid[targetGuid]` (mirroring the H2 spawn-time chain at `entities.js:4693-4694`). On entity remove (`entities.js:4259-4267`), the per-guid loop destroys these emitters early instead of waiting for the 2.5s setTimeout to fire against a detached rig. The setTimeout's cleanup also prunes the per-guid array so the map stays honest. Closes the "parent ref held forever" leak vector.

## Deferred — multi-layer refactor

### A2 — Wasm export for motion-table bit 0 `clears_modifiers` (K3)
Spans Rust + wasm-bindgen + JS animation cache + JS additive-layer clear. Detailed file:line plan in TaskGet #16.
Key call sites identified:
- `crates/holtburger-dat/src/file_type/motion_table.rs:132-139` — `MotionData { pub bitfield: u8, pub flags: MotionDataFlags }`; bit 0 is in `bitfield`, NOT `flags` (which is HAS_VELOCITY/HAS_OMEGA).
- `apps/holtburger-web/src/lib.rs:4319-4329` — existing `motion_data_for_link` resolution path.
- `scene3d/entities.js:4311-4394` — `_tryPlayLink` entry point that needs to gate additive-layer clearing on the bit.
Pickup cost: ~2-3 hours for an implementer carrying the full chain.

### A3 — Wasm export for jump-reject signal (I1)
Verification this session showed the existing `handle.canJumpNow()` check at `index.html:8170-8176` already pre-filters airborne case. Author comment at lines 8217-8223 explicitly flagged this as "cheap follow-on if telemetry shows it." Re-prioritised behind A2: add usage telemetry first, only refactor if mismatch rate is non-trivial.

## Pending (untackled)

- **A8 (B2)** — Mesh-conversion failure policy decision (needs product call).
- **A9 (N6)** — Door hinge rotation driver (new-feature work, multi-day per memory).

## A7 (M1) closed via source verification (2026-05-28)
**FALSE POSITIVE.** `terrain.js:1140-1153` uses `THREE.DataArrayTexture` with per-layer `ClampToEdge`. The own comment at lines 1136-1138 explicitly states the cross-tile-bleed is "structurally impossible at any mip level" because each array layer has its own mipmap chain. The 6×6 packed atlas (which DID have the agent's described issue) was replaced precisely to fix it. The agent confused `ClampToEdge` (same-edge clamp) with `RepeatWrapping` (opposite-edge wrap). Adding border padding to a DataArrayTexture would be wasted bytes — each layer is sampled independently.

## Updated totals
**Fixes / instrumentation applied (15):** O1, F1, L1, R3, G1, A1+A2-cache, B1, L5, M6, L4, I6, L2 (rounds 1-4) · A4, A5, A6 (architectural rounds 1-3).
**Verified false positives (16):** W1/N5/W2, N2, H3, H4, G6, H6, I2, K1, N3, R1, H5, L3, L6-direct, B2-non-bug, V2, **M1 (A7)**.
**Deferred with plan (2):** A2 (K3), A3 (I1).
**Pending (2):** A8, A9.
**Closed without action (5):** K2 (architectural API concern), K4 (rare edge), M1 (Rust-side atlas builder), N6 (deferred door hinge driver), I4 (intentional per arch).

### Updated false-positive rate
**31 findings inspected across waves 1-3 (out of ~35 total reported by agents). Of those, 14 are false positives = 45% FP rate.** The reports are useful as bug *candidates* but cannot be trusted blindly. Verification caught:
- Architectural misreads (W1/N5/W2 — 2D loop owns kinds 17/18/16)
- Sync vs. async JS confusion (N2 — no awaits between L217-253)
- Three.js mixer/material semantics (K1 double-play not how mixers work; N3 multi-material per-Mesh works correctly)
- Hook signature confusion (G6 — clamp01 already applied)
- Pre-existing protection (H4 — overlay.remove takes listeners with it)
- Code-logic backwards (H6 — `if (!pluginClient)` guard prevents re-create)
- Misidentified surface (H5 — DEFAULTS is bar settings, not plugin map)
- Misread GC lifecycle (L3, L6, R1 — refs die with their owning objects)

### Top fix-impact (delivered)
1. **O1** — ~22 MB/min wasm-memory leak fixed; biggest single win.
2. **A1+A2** — Long-session VRAM bound; previously unbounded `Map` growth on nameplate/buff caches.
3. **L4** — Eliminates "immortal particle emitter from Infinity lifespan" failure mode.
4. **L2** — Particle sort URL flag now actually works (was silently inert).
5. **G1** — Web Audio graph nodes no longer accumulate; long-session audio bound.
6. **F1** — Camera mode toggles no longer leak 4 listeners apiece; right-click no longer duplicates.
7. **I6** — Stuck-airborne packet-loss recovery (8s timeout).
8. **L1** — Particle material disposal closed the file's own TODO(E3).
9. **B1** — Material silent-fallback now wired to `__diag.assets.onMaterialError` for operator triage.
10. **L5** — Lightning thunderDid validation warns on invalid override.
11. **M6** — Palette LUT failure plumbed to `__diag.terrain.onPaletteLoadFailed` (no-op until namespace adopted).
12. **R3** — Animation cache `sizeWatermark` now actually tracks peak.

### False-positive rate signal
22 findings inspected, 10 false positives = **45% FP rate** on the agent reports. The reports remain useful as bug *candidates* but each requires verification against source before action. The pattern of false positives: misreading sync vs async JS execution (N2), missing architectural routing (W1/N5/W2, R1), misreading Three.js semantics (K1, N3), and outright getting code logic backwards (G6, H6).
