# Interacting Layers Analysis — Holtburger Web Client

Working doc. We edit this in place as we resolve things and as we learn more.

## Headlines

1. **One wall-clock source for visual-effect time** (was three). Main loop stamps `scene3d.frameTime = { tsMs, tsSec, dt }` each rAF (`dt` capped at 100ms); terrain water reads `tsSec`, cloud overlay receives `dt` as a parameter threaded through the render call. AC game time stays a separate axis by design — `Date.now()` + 11.34× compression in `atmosphere_sky.js` for sun/moon/stars; that's the world clock and predominates for game-time decisions.
2. **The "minimap" is the C-key camera cycle.** Press C: follow → topDown (first "minimap") → orbit (second "minimap") → follow (`camera.js:1291-1302`). The orbit view used to work but currently sits in a broken state tied to clouds; fix path lives in memory.

## Frame anatomy at clouds=on + ultra

The per-frame sequence (`loop.js:221-385`, then `index.js` render branch):

```
rAF → dt (bounded)
  ├─ tickCellVisibility3D ─┐ flips SkyDome._lastIsIndoor — 3 subsystems
  │                        │ read this same frame to choose render path
  ├─ tickTerrainUTime ─────── pushes scene3d.frameTime.tsSec (shared)
  ├─ tickLightingForCellState ┐
  │   └─ updateCsm + refresh   ─ CSM frustum fit on 3 cascades
  ├─ skyLightingController.tick → sun dir #1 (DirectionalLight)
  ├─ atmosphereLights.tick     → sun dir #2 (SunDirectionalLight)
  ├─ atmosphereSky.tick        → sun dir #3 (SkyMaterial)
  ├─ skyDome.tick
  ├─ cameraSwitcher.tick       → predicted player pos
  ├─ entityManager.tick        → N AnimationMixers
  ├─ drainEntityEvents3D
  ├─ applyLocalPlayerPoseFromIntegrator
  └─ nameplateLayer.tick

Render (atmosphere path — now the only composer path; SSAO removed 2026-05-18):
  preFrameSkySync → cloudOverlay.preRender → atmospherePipeline.render
                                              (Sky→World→AerialPerspective+LensFlare+ToneMapping+Dithering)
  → cloudOverlay.renderOverlay (samples effect.cloudsBuffer + shared depth)
  → cloud_volume.tick           → sun dir #4 (CloudsEffect)
```

Sun-direction is now centralised in `scene3d/sun_direction.js` — `sunDirFromHeadingPitch(headingDeg, pitchDeg, outVec)` for unit-vec consumers (clouds, atmosphere lights, sky/stars material) and `sunPositionFromHeadingPitch(headingDeg, pitchDeg, distance) → [x,y,z]` for the directional-light position consumer. The cloud overlay's `setSceneDepthTexture()` must be re-called after any composer rebuild, or the depth-discard test reads stale handles — but the 2026-05-18 sentinel fix (see Resolved) makes the failure mode "visible without occlusion" instead of "invisible", which breaks the historic fix-break loop.

## Cross-cutting hazards

**ECEF / `correctAltitude=false` is load-bearing across 4 files / 6 init points.** atmosphere_pipeline, cloud_volume, atmosphere_sky (×2: Sky + Stars), atmosphere_lights (×2: Sun + Probe). Two of them use defensive `if ("correctAltitude" in ...)` ternaries — silent misconfig risk if a takram update changes the property name.

**Camera height patch lands one frame late.** takram computes cameraHeight via WGS-84 ellipsoid (~18km wrong); `cloud_overlay.js:379-383` overrides the uniform *after* the composer has already rendered. Teleports / vertical jumps see a frame of wrong altitude → momentary cloud-altitude pop.

**weather_state.js is a ghost module.** It compiles, has `updateFromPosition()` and `updateFromDayGroup()`, has 20 DayGroup profiles, has `_applyWeatherToCloudLayers()` ready to go — but nothing in the tick loop calls them. Activation is manual via `window.__applyCloudWeather()`. Given the memory note that you're a weather fan, this is probably the single most-misaligned piece between intent and current state.

**No landblock unload exists.** Teleport from Holtburg to anywhere else and the 13×13 ring (169 LBs of geometry, materials, AABBs, audio buffers) stays resident. `cellContainers3d`, `staticsBakedLbs`, `buildingsBakedLbs` grow monotonically across the session. A long-play tour across continents is a memory time bomb.

**Quality switch is init-only.** `getQuality()` reads `?quality=…` once at boot and stores on `liveScene3d.quality`. Subsystems bind flags at construction (materials, atmosphere composer, CSM). Changing preset at runtime leaves a Frankenstein scene; users have to reload.

**requestIdleCallback shim is a load-bearing hack.** `_ric_shim.js` rewrites `window.requestIdleCallback` to a microtask-driven version, because takram's Bruneton bake uses idle-time progress and was hanging on a busy rAF loop. Snapshotted at module-load time, intentionally non-cancellable. Anyone calling `cancelIdleCallback()` silently fails. This is hidden infrastructure with no test gate.

## State machines with quiet failure modes

**Armed spell.** Auto-disarms on death (HP=0) and zone change (`landblockChanged` event). The first known-LB capture after login also fires the event, so reloading the page with stale localStorage state clears immediately. Spell forget via the spellbook does NOT yet clear a matching armed spell — separate follow-on if it ever comes up.

**Selection ring.** Created on click, removed only on next click. If you cancel a charge (movement key, stance flip, timeout), the red torus remains on the target — visually implies "still locked on" when the charge state machine has died.

**Charge attack rAF.** 10s safety timeout, stance check, ABORT_KEYS (WASD/QE/Shift) all in place. Cancellation is solid. One subtle thing: stance callbacks (`isInMagicStance`, etc.) are closures captured at `setupClickPicking()` init — a plugin hot-reload that re-passes callbacks without re-calling setup keeps the old closures alive.

**vitals-hud polls for `window.__pluginClient` every 500ms** (vitals-hud.js:141-172). First `playerStatsUpdated` after login can fire before the subscriber wires up.

## Cloud + shadow interaction

Two render paths handle clouds and depth differently:
- **Atmosphere path** (your active path): cloud overlay samples `effect.cloudsBuffer` directly (not `composer.outputBuffer`). If anything reorders the EffectPass (AerialPerspective → LensFlare → ToneMapping → Dithering), clouds will read pre-tone-mapped HDR instead of final sRGB.
- **Direct path** (no composer): cloud overlay has no depth texture wired at all — clouds paint unconditionally over geometry.

CSM shadow rendering is implicit (three.js inserts it during `renderer.render()` because `shadowMap.enabled=true`). The cloud overlay's depth-discard test reads *scene* depth, not shadow-camera depth, which is correct — but there's no test exercising clouds + CSM-shadowed terrain together.

## What to triage

Low-effort, high-value:
1. Fix the orbit (C-key second-minimap) view — currently tied to a clouds state issue; fix path lives in memory.

Medium-effort, structural:
2. Wire `weather_state.updateFromPosition()` into the main tick loop — close the ghost module.
3. Add `unloadLandblock(lbX, lbY)` on streaming exit — the only real memory bomb.
4. Quality preset hot-swap or guard against runtime change (lock the URL param, force reload on change).

Investigative / unknown-cost:
5. Add a depth-texture wiring assertion at construction; today a 1×1 stale default fails silently.
6. Decide whether the direct render path is still reachable in practice — if not, delete it and remove the cloud-paint-over-geometry footgun.

## Resolved

- **2026-05-18 — Cloud depth-discard sentinel fixed (clouds-loop break).** Constructor default for `sceneDepthThreshold` in `scene3d/cloud_overlay.js` was 0.9999, but `sceneDepthTex` defaulted to null. Until `setSceneDepthTexture(validTexture)` ran, the shader sampled an unbound texture (returns 0 in WebGL2), compared `0 < 0.9999`, and discarded every fragment — clouds were invisible. The `setSceneDepthTexture` body already treated 0.0 as the "no depth provided, render unconditionally" sentinel; only the constructor disagreed. Changed the default to 0.0 so clouds appear by default and `setSceneDepthTexture(validTexture)` later upgrades to depth-aware discard. Historic loop pattern: agent fixes clouds → over-everything → next agent restores threshold → invisible → repeat. Now the failure mode is "visible but no occlusion" rather than "invisible" — easier to notice in screenshots, less likely to invite a panic-revert. Known follow-on: topDown camera mode (C-once) renders the world via the ortho camera but the cloud raymarch still uses the persp camera reference — clouds will look spatially wrong in topDown until the cloud overlay accepts the active camera.
- **2026-05-18 — Armed-spell auto-disarm on death + zone change.** `index.html` `handlePositionUpdate` now tracks the local player's landblock and emits `landblockChanged` via the plugin facade event bus when the LB transitions (including the first-known capture, which catches the log-in case). `plugins/combat-bar.js` gained a `mount()` lifecycle hook that subscribes to `landblockChanged` (calls `clearArmedSpell`) and `playerStatsUpdated` (calls `clearArmedSpell` when HP=0). New module-scope `clearArmedSpell()` mutates state + localStorage + `window.__combatBarState` without touching DOM, so the disarm works whether or not the combat-bar panel is open. UI no longer lies about armed state after a respawn or portal.
- **2026-05-18 — Sun-direction centralised.** New `scene3d/sun_direction.js` exports `sunDirFromHeadingPitch(headingDeg, pitchDeg, outVec)` and `sunPositionFromHeadingPitch(headingDeg, pitchDeg, distance) → [x,y,z]`. Four prior sites (`sky_lighting.js`, `cloud_volume.js`, `atmosphere_lights.js`, `atmosphere_sky.js`) — three of which had named local copies, one inlined — now import from the shared module. Same formula, single source. `__internals` re-exports in `sky_lighting.js` and `cloud_volume.js` keep test imports working (they point to the imported binding by the same name).
- **2026-05-18 — Wall-clock sources fully consolidated (Phases A + B).** `scene3d/index.js` tick callback stamps `liveScene3d.frameTime = { tsMs, tsSec, dt }` each rAF. `scene3d/loop.js` `tickTerrainUTime` reads `scene3d.frameTime.tsSec`. `scene3d/cloud_overlay.js` dropped its `THREE.Clock`; `preRender(renderer, dt)` now accepts `dt` from the caller, threaded from the rAF tick via `index.js` (atmosphere path) and `sky_dome.renderSkyPass(renderer, activeCam, dt)` (direct path). Three wall-clock sources collapsed to one. Side-effect: cloud TAA dt is now capped at 100ms — friendlier for temporal stability after stalls. AC game time (`atmosphere_sky.js` → `Date.now()` + 11.34× compression) is unchanged and remains the world clock; visual-effect time vs game-time stays a clean two-axis model.
- **2026-05-18 — SSAO removed entirely.** Deleted `scene3d/postprocess.js`, `test_visfid_p32_ssao.mjs`, `capture_visfid_p32_ssao.cjs`. Stripped `ssao` flag from `quality.js` and `test_quality_preset.mjs` (32/32 pass). Removed SSAO import, auto-disable branches, forward-decl, resize hooks, render-path branch, cloud-overlay warning, and pipeline construction from `index.js`. Comment cleanup in `atmosphere_pipeline.js` and `sky_dome.js`. Closes the "ultra+clouds silently loses SSAO" hazard by removing both sides of the conflict — atmosphere path is now the canonical composer path.

## Disproved findings

- **2026-05-18 — "Clicks bleed through plugin panels" was wrong.** The original analysis claimed clicks on `.hb-panel` could fire canvas-side attacks. Investigation showed: `picking.js:243` attaches `pointerdown` to the canvas element (not document); `camera.js:449-450` attaches mousedown to the canvas; `.hb-panel` defaults to `pointer-events: auto`. DOM event flow guarantees panel clicks never reach the canvas listener. The agent had inverted the meaning of CSS defaults. No fix needed; no behavior change.
