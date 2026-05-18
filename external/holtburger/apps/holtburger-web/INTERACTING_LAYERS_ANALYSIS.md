# Interacting Layers Analysis — Holtburger Web Client

Working doc. We edit this in place as we resolve things and as we learn more.

## Headlines

1. **Three independent time sources tick this scene.** Main loop's `dt` is bounded (≤100ms), terrain water uses raw `performance.now() * 0.001`, and the cloud overlay runs its own `THREE.Clock.getDelta()`. When the frame stalls (CSM frustum spike, async entity spawn, GC pause), the world freezes but terrain water and cloud noise/jitter keep advancing at wall-clock. Imperceptible at 60Hz, ugly under load.
2. **The "minimap" is the C-key camera cycle.** Press C: follow → topDown (first "minimap") → orbit (second "minimap") → follow (`camera.js:1291-1302`). The orbit view used to work but currently sits in a broken state tied to clouds; fix path lives in memory.

## Frame anatomy at clouds=on + ultra

The per-frame sequence (`loop.js:221-385`, then `index.js` render branch):

```
rAF → dt (bounded)
  ├─ tickCellVisibility3D ─┐ flips SkyDome._lastIsIndoor — 3 subsystems
  │                        │ read this same frame to choose render path
  ├─ tickTerrainUTime ─────── pushes performance.now()*0.001 (own clock)
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

Note sun-direction is computed **four** times, identical formula each. And there's a real ordering invariant nobody guards: `setSceneDepthTexture()` must be re-called after any composer rebuild, or the cloud overlay's depth-discard test reads garbage and clouds paint over geometry.

## Cross-cutting hazards

**ECEF / `correctAltitude=false` is load-bearing across 4 files / 6 init points.** atmosphere_pipeline, cloud_volume, atmosphere_sky (×2: Sky + Stars), atmosphere_lights (×2: Sun + Probe). Two of them use defensive `if ("correctAltitude" in ...)` ternaries — silent misconfig risk if a takram update changes the property name.

**Camera height patch lands one frame late.** takram computes cameraHeight via WGS-84 ellipsoid (~18km wrong); `cloud_overlay.js:379-383` overrides the uniform *after* the composer has already rendered. Teleports / vertical jumps see a frame of wrong altitude → momentary cloud-altitude pop.

**weather_state.js is a ghost module.** It compiles, has `updateFromPosition()` and `updateFromDayGroup()`, has 20 DayGroup profiles, has `_applyWeatherToCloudLayers()` ready to go — but nothing in the tick loop calls them. Activation is manual via `window.__applyCloudWeather()`. Given the memory note that you're a weather fan, this is probably the single most-misaligned piece between intent and current state.

**No landblock unload exists.** Teleport from Holtburg to anywhere else and the 13×13 ring (169 LBs of geometry, materials, AABBs, audio buffers) stays resident. `cellContainers3d`, `staticsBakedLbs`, `buildingsBakedLbs` grow monotonically across the session. A long-play tour across continents is a memory time bomb.

**Quality switch is init-only.** `getQuality()` reads `?quality=…` once at boot and stores on `liveScene3d.quality`. Subsystems bind flags at construction (materials, atmosphere composer, CSM). Changing preset at runtime leaves a Frankenstein scene; users have to reload.

**requestIdleCallback shim is a load-bearing hack.** `_ric_shim.js` rewrites `window.requestIdleCallback` to a microtask-driven version, because takram's Bruneton bake uses idle-time progress and was hanging on a busy rAF loop. Snapshotted at module-load time, intentionally non-cancellable. Anyone calling `cancelIdleCallback()` silently fails. This is hidden infrastructure with no test gate.

## State machines with quiet failure modes

**Armed spell.** Persisted in localStorage. Survives death, zone change, logout. If you forget the spell in between, `castTargetedSpell(guid, spellId)` rejects silently on the wasm side; UI still shows "armed."

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
1. Disarm spell on death / zone exit — UI lies are corrosive.
2. Centralize sun-direction computation in one utility used by all 4 consumers.
3. Fix the orbit (C-key second-minimap) view — currently tied to a clouds state issue; fix path lives in memory.

Medium-effort, structural:
4. Wire `weather_state.updateFromPosition()` into the main tick loop — close the ghost module.
5. Add `unloadLandblock(lbX, lbY)` on streaming exit — the only real memory bomb.
6. Quality preset hot-swap or guard against runtime change (lock the URL param, force reload on change).

Investigative / unknown-cost:
7. Unify the three time sources, or document explicitly why they differ.
8. Add a depth-texture wiring assertion at construction; today a 1×1 stale default fails silently.
9. Decide whether the direct render path is still reachable in practice — if not, delete it and remove the cloud-paint-over-geometry footgun.

## Resolved

- **2026-05-18 — SSAO removed entirely.** Deleted `scene3d/postprocess.js`, `test_visfid_p32_ssao.mjs`, `capture_visfid_p32_ssao.cjs`. Stripped `ssao` flag from `quality.js` and `test_quality_preset.mjs` (32/32 pass). Removed SSAO import, auto-disable branches, forward-decl, resize hooks, render-path branch, cloud-overlay warning, and pipeline construction from `index.js`. Comment cleanup in `atmosphere_pipeline.js` and `sky_dome.js`. Closes the "ultra+clouds silently loses SSAO" hazard by removing both sides of the conflict — atmosphere path is now the canonical composer path.

## Disproved findings

- **2026-05-18 — "Clicks bleed through plugin panels" was wrong.** The original analysis claimed clicks on `.hb-panel` could fire canvas-side attacks. Investigation showed: `picking.js:243` attaches `pointerdown` to the canvas element (not document); `camera.js:449-450` attaches mousedown to the canvas; `.hb-panel` defaults to `pointer-events: auto`. DOM event flow guarantees panel clicks never reach the canvas listener. The agent had inverted the meaning of CSS defaults. No fix needed; no behavior change.
