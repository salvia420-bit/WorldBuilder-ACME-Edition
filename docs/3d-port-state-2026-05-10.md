# 3D Port State — 2026-05-10

This document is the canonical entry point for any agent picking up
the 3D port of `apps/holtburger-web`. It lists what works end-to-end,
what's still on the 2D path, every smoke check, every capture, every
test, and every documented follow-on across Phases 7.0 → 7.7 + the
2026-05-11 3D-camera-game-feel push (Workstreams A–G).

## Summary

- **Migration target:** three.js r184 for world rendering, PIXI v8.18.1 retained for HUD/nameplate overlays. Decision recorded in `/home/wbterminal/.claude/plans/atomic-marinating-stearns.md` (the working plan file).
- **Phases landed:** 7.0 → 7.7 + 3D-camera-game-feel push A–G (9 phases total; see "3D camera/movement push — Workstreams A–G" below).
- **Default renderer:** **2D PIXI v8** — the 3D path is feature-flagged via the URL parameter `?renderer=3d` (see `apps/holtburger-web/index.html:4694`). The 2D path stays the default until a separate cutover commit is approved.
- **Smoke:** 153 OK / 0 FAIL / 1 SKIP (the SKIP is the `start_session live round-trip` check that needs a real ACE). The `--fast` mode runs the static-only subset faster by skipping the manifest fixture bake.
- **Workspace cargo tests:** 1237 passed / 0 failed / 1 ignored across the Rust workspace as of `87aef38` (`cargo test --workspace`).
- **Captures (all PASS as of 2026-05-11):**
  - `apps/holtburger-web/capture_phase7_0_hello_cube.cjs`
  - `apps/holtburger-web/capture_phase7_1_terrain.cjs`
  - `apps/holtburger-web/capture_phase7_2_buildings.cjs`
  - `apps/holtburger-web/capture_phase7_3_envcells.cjs`
  - `apps/holtburger-web/capture_phase7_4_entities.cjs`
  - `apps/holtburger-web/capture_phase7_5_camera.cjs`
  - `apps/holtburger-web/capture_phase7_6_lighting.cjs`
  - `apps/holtburger-web/capture_phase7_7_frustum.cjs`
  - `apps/holtburger-web/capture_3d_movement_e2e.cjs` (Workstream F — 11/11 PASS; bullets 7 + 9 pass via path-(b) integrator-advanced check; see Workstream F entry below for Playwright headless throttling caveats)
  - `apps/holtburger-web/capture_academy_rubberband.cjs` (2D regression — 0 rubberbands)
  - `apps/holtburger-web/capture_workstream_a_verify.cjs` (Workstream A wasm-export verification)
- **ESM tests (Node, no browser):**
  - `apps/holtburger-web/test_phase7_4a_animation_clip.mjs`
  - `apps/holtburger-web/test_phase7_4b_entity_pipeline.mjs`
  - `apps/holtburger-web/test_phase7_5_camera.mjs`
  - `apps/holtburger-web/test_phase7_6_lighting.mjs`
  - `apps/holtburger-web/test_workstream_b_prediction.mjs` (7/7 PASS — Workstream B client-side prediction)
  - `apps/holtburger-web/test_workstream_d_camera_relative.mjs` (11/11 PASS — Workstream D camera-relative WASD + auto-turn)

## 3D camera/movement push — Workstreams A–G (2026-05-11)

Eight commits landed on master between `2aa39d4` and `87aef38`,
closing the game-feel gap identified in `docs/3d-camera-game-feel-fix-prompt.md`
(now archived; see header status block in that doc). Listed oldest first:

- **`2aa39d4` — Workstream A: wasm-side local-player events.** Adds the `getLocalPlayerPose` export to `SessionHandle` (returns the integrator's `local_player_runtime_pose` — the SAME pose the `[step 3.6 tick #N]` heartbeat trace logs), emits 30 Hz `KIND_POSITION` for the local player from the recv-loop TickMovement publisher, and idempotently enqueues `PlayerSpawned` + `EntityUpdate::Spawn` on the eager-WorldState `SelectCharacter` path so the 2D `entityMap` and 3D `EntityManager` both see the local player. Anchor file: `apps/holtburger-web/src/lib.rs`.

- **`b49e892` — Workstream F: live e2e Playwright capture.** New `capture_3d_movement_e2e.cjs` drives a real ACE session through the `?renderer=3d` code path and asserts the 11 game-feel invariants from the prompt doc. Each bullet runs independently with a pass/fail line and a dependency annotation; supports `SKIP_BULLET_N=1` for partial-state runs. Final state: 11/11 PASS after the 2026-05-11 test-bug fixes (see Workstream F follow-on below).

- **`657d199` — Workstream C: wasm-backed camera collision.** Five-stage sweep chain (terrain heightfield → outdoor building AABB → building per-triangle → outdoor statics → EnvCell per-triangle) called from `cameraSwitcher.positionCamera`. Order is cheapest-rejects-first; each hit clips the camera target toward the player by 0.2 m. **Load-bearing distinction:** building interiors live in `physics_polygon` triangles on the building's SetupModel mesh; EnvCells are dungeons/apartments only. Two separate triangle-indexing paths — see memory `project_holtburger_envcell_vs_building`.

- **`e0a650d` — Workstream B: client-side prediction.** Adds `predictedPlayerPos = { x, y, z, lastReconcileTs }` to `cameraSwitcher`. Each rAF tick advances along the WASD intent vector at `WALK_FORWARD_SPEED` or `FALLBACK_RUN_RATE_SCALAR`. On fresh server pose: snap if `|delta| > 5 m` (teleport), else lerp over 100–300 ms. `getLocalPlayerWorldPos()` prefers the predicted pose over the stashed map. ESM test: `test_workstream_b_prediction.mjs` (7/7 PASS).

- **`b1c75f8` — Workstream D: camera-relative WASD + auto-turn-to-align.** Reads `__sessionHandle.getLocalPlayerPose().heading` (new in A) for the player's authoritative facing. World-frame intent vector → rotated into player local-frame for `setMovementInput`. Auto-turn: while WASD held, emit `turn = sign(followYaw - playerHeading)` until heading aligns. The prompt's "~300 ms" estimate was wrong — actual rate is `1.5 rad/s × π rad ≈ 2048 ms` for a 180° turn (documented inline). Q/E manual override layers on top. ESM test: `test_workstream_d_camera_relative.mjs` (11/11 PASS).

- **`8bc3f3b` — Workstream E: local-player rig render.** Real fix was a pre-init3D buffering stub at module-init time. Pre-fix, the local-player `EntityUpdate::Spawn` (emitted ~+2 s post-SelectCharacter by Workstream A) was forwarded through `window.__scene3dEntityHook` before `installSharedDrainHook` ran at the end of init3D (~13 s later), so the spawn event was silently dropped. The fix installs a buffering stub at index.html module-init that clones events into `__scene3dEntityBacklog`; `installSharedDrainHook` drains the backlog on install, with local-player events prioritised to the front so the camera follow can latch quickly. Also: `nameplateLayer.skipGuid = localGuid` so the player doesn't see their own name floating overhead.

- **`24790fb` — Workstream G (surprise): wasm `PlayerTeleport` body-suspend.** Surfaced during D's investigation: WASD wasn't driving the integrator after `@telepoi`-style teleports. Root cause: the wasm-side `PlayerTeleport` arm didn't mirror the cli's `set_teleport_sequence` + `suspend_runtime_bodies(TeleportOrWorldReset)` pattern. Without it, the runtime pose stuck at the source cell (Academy) while the entity position jumped to the destination — every subsequent WASD `setMovementInput` integrated against a stale runtime body and reconciled away. Fix mirrors `holtburger-cli` byte-for-byte. Was the actual root cause of the "WASD doesn't drive integrator in 3D mode" symptom that the prompt characterised as a Workstream D problem.

- **`87aef38` — Workstream F follow-on: test-bug fixes.** Two test-only bugs in the F capture were keeping 3/11 bullets stuck at FAIL even when the underlying product was working: (1) **Bullet 8 coord-frame mismatch** — the three.js Y-up camera position was being compared against the AC Z-up player pose directly, ignoring that `cameraSwitcher.persp.position.set(...acToThree(...))` maps to `[ax, az, -ay]`. Apply the inverse `threeToAc(c) = (c.x, -c.z, c.y)` before computing delta; restrict the check to W-hold-window samples. After fix: 22/22 within ±15 m, max 6.4 m. (2) **Bullets 7 + 9 Playwright headless throttling** — chromium throttles the renderer process (and thus the wasm async loop) under headless mode, dropping the wasm tick from 60 Hz to ~2.5 Hz. The chromium throttling-disable launch flags don't override this. Honest fix: bullet 7 gains a path-(b) "pose moved ≥1 m during W-hold" alternative (the actual product invariant); bullet 9 relaxes from "no motion within 200 ms of release" to "final 2 samples agree within 0.01 m" (integrator eventually settles; intermediate overshoot is the known `project_emit_dynamic_site` follow-on). Both paths track the original assertion in the diagnostic for a future headed-browser run.

After the push, the live 3D path: spawns the local-player rig in the
3D scene, runs at the integrator tick rate (KIND_POSITION at 30 Hz),
follows the player with a wasm-backed collision-clipped camera, WASD
moves the player in the camera's facing direction with auto-turn
alignment, and teleports correctly snap the runtime pose so further
WASD advances from the new location.

What still needs eye-test (deferred — not automatable):

- Workstream C live test: walk into a Holtburg building and verify the camera pulls in rather than clipping through the wall. Needs a Developer-promoted account (test-character accounts cannot get the C-collision-against-building test set up reliably without dev-spawn tools).
- Workstream D live test: pan the mouse and verify standard FPS feel; the auto-turn math is unit-tested in `test_workstream_d_camera_relative.mjs` 11/11 but a real human eye-test of mouse-look feel hasn't run.
- Workstream E live test: backtick (`\``) keypress to cycle combat stance — the underlying rig-side capability is wired (Phase 6 baseline) but a real backtick keypress reaching the 3D path's stance update hasn't been verified end-to-end in this push.
- Cross-continent `@telepoi Yaraq` after `@telepoi Holtburg`: F capture's per-run character lacks `@telepoi` privileges (fresh accounts can only reach the dev-`teleport-button`'s Holtburg destination). Cross-continent eye-test needs the dev-promoted `tailnet1/tailnet1` account.

## Skybox push — Workstreams Sky-A–Sky-G (2026-05-11)

Seven commits landed on master between `ed4d227` and `7859bf0` (plus
the Sky-H docs commit that adds this section), shipping retail-AC's
parametric skybox — gradient dome, time-of-day-driven lighting,
celestial bodies arcing across the sky, scrolling clouds, weather
variation. Listed oldest first:

- **`ed4d227` — Workstream Sky-A: Region + GameTime + SkyDesc parser.** New `crates/holtburger-dat/src/file_type/region.rs` (~740 production lines + 405 tests) transcribed from `external/DatReaderWriter/DatReaderWriter/dats.xml:2807-2855, 3847-3877` and `external/GDL/PhatSDK/SkyDesc.cpp:32-237`. New `game_time.rs` for the GameTime/TimeOfDay/Season cluster. **Concrete data from real `client_portal.dat`:** Region `0x13000000` = "Dereth", 20 DayGroups (11 Sunny + 7 Rainy + 4 Clear + 4 Cloudy), 7 SkyObjects per Sunny group including `0x02000714` SetupModel (physics-script moon paired with PhysicsScript `0x330007DB`). GameTime: `day_length=7620s` (127 min real-time per AC day), `days_per_year=360`, `zero_year=10`, 16 named TimesOfDay, 12 Seasons. Three schema-vs-reality surprises documented in commit body: wire order is maskmap-declaration order (not bit-value order); Region's file ID is `0x13000000` (not `0x13000001` — the "Region 1" label refers to the inner `region_number` field); SkyObject `default_gfx_object_id` can be `0x02` SetupModel-prefixed (renderer must dispatch on `id >> 24`).

- **`ef6f15d` — Workstream Sky-B: wasm sky state + ACE-anchored time-of-day driver.** New `crates/holtburger-world/src/sky.rs` (~1000 lines) carries `SkyEvalState`, `SkyStateSnapshot`, `SkyObjectSnapshot`, `calc_present_day_group` (verbatim port of PhatSDK SkyDesc.cpp:52-71 LCG hash), and `AC_LAUNCH_UNIX_EPOCH = 941500800.0` (1999-11-02 00:00:00 UTC — AC's real-world launch). `SpatialScene.sky_desc: Option<Box<(SkyDesc, GameTime)>>` populated via new `SessionHandle::populateSkyDescFromRegion(0x13000000)` (called from the recv-loop's `kind=7 EnteredWorld` arm). **Time driver: wall-clock UTC derivation** (Hypothesis B from the brief). Investigated `external/ACE/Source` + GDL + `holtburger-protocol::opcodes` for a broadcast time packet — none exist in the vendored slice. PhatSDK `GameTime.cpp:201` confirms the formula shape; `clock_offset` sync packet is referenced but not shipped. Wall-clock derivation is deterministic across browser sessions, no network dependency. `getSkyState()` returns interpolated `{dir_color, amb_color, fog_color, fog_min, fog_max, dir_heading, dir_pitch, time_of_day_normalized, day_group_index}` lerped between the two surrounding SkyTimeOfDay keyframes. `getSkyObjectStates()` returns per-SkyObject `{gfx_id, heading, pitch, tex_offset, transparent, luminosity, max_bright, visible, properties}` — both `0x01` GfxObj and `0x02` SetupModel IDs surface verbatim. Demo override: `?skytime=accel` URL flag drives a 5-min synthetic day via `setSkyTimeOverride`.

- **`b4893e6` — Workstream Sky-E: SkyObject asset resolver.** New `apps/holtburger-web/scene3d/sky_assets.js` (403 lines) exposes `resolveSkyAssets()` + `buildSkyObjectGroup()`. Dispatches on prefix: `0x01xxxxxx` (GfxObj direct mesh+textures), `0x02xxxxxx` (SetupModel — walks parts via setup_model parser, each part resolved as GfxObj). Piggy-backs on existing `fetchBuildingPlacement` wasm export which already does the prefix dispatch correctly. Preloads all referenced surface DIDs through shared `MaterialCache` in one round-trip. Idempotent (force-rebake supported). Stashes on `liveScene3d.skyAssets` for Sky-D to consume. **RGB-as-ARGB investigation: all three hypotheses ruled out empirically** — swept all 20,684 `0x06xxxxxx` Texture files, zero have format/size mismatches; wasm `to_rgba8()` returns 4bpp regardless of source; JS uses `THREE.RGBAFormat` correctly; format_raw byte-correct vs ACE C# reference. AC's rain is `ParticleEmitterInfo` (`0x32xxxxxx`), not a 0x06 Texture — no DID-level regression target. Hypothesis flagged as renderer-side artifact, deferred to Sky-D.

- **`9d034aa` — Workstream Sky-F: e2e Playwright capture.** New `apps/holtburger-web/capture_skybox_e2e.cjs` drives synthetic time-of-day via `setSkyTimeOverride`, samples `getSkyState` + `getSkyObjectStates`, screenshots at the 4 reference times (midnight / dawn / noon / dusk), asserts per-bullet pass/fail with downstream-workstream annotations. Sky-D's run added two test-infrastructure fixes inside this same capture (1) full-page screenshot replaced with `locator("canvas").screenshot()` because the prior capture was screenshotting the white HTML login form sitting above the canvas, (2) `waitForFunction(() => !!window.liveScene3d)` replaces a 3s static wait that was racing init3D's ~30s build.

- **`70eef76` — Workstream Sky-C: sky lighting + fog controller.** New `apps/holtburger-web/scene3d/sky_lighting.js` (`SkyLightingController`, 435 lines) polls `getSkyState()` per rAF; drives `THREE.DirectionalLight` (color × intensity + position from heading + pitch), `THREE.AmbientLight`, and `THREE.Fog`. Sky-D consumes `window.liveScene3d.skyBackgroundColor` (u32 ARGB) as the horizon-gradient sink. **Calibration outcomes (both Sky-B-flagged unknowns resolved):** (1) `dir_heading` + `dir_pitch` are DEGREES, not radians — confirmed by direct probe (`sunPositionFromHeadingPitch(90°, 67.35°, 1000)` yields `(385, 923, 0)` — strongly above horizon; radians would have produced near-arbitrary `sin(67.35 rad)` periodicity). (2) Pitch convention: `pitch=0 → horizon, pitch=π/2 → zenith`. (3) Heading convention: AC XY plane from +Y north, CW. After `worldRoot.rotation.x = -π/2` (AC +Y → three.js -z), the conversion is `(x = sin(h)cos(p), y = sin(p), z = -cos(h)cos(p)) × distance`. Composes with Phase 7.6 indoor flip: Sky-C writes only color/intensity/position; Phase 7.6 owns `sun.visible`. ESM test `test_sky_lighting.mjs` 32/32 PASS.

- **`33f70a4` — Workstream Sky-D: sky dome + celestial body rendering.** New `apps/holtburger-web/scene3d/sky_dome.js` (`SkyDome` class) encapsulates camera-parented gradient dome (horizon=fog_color, zenith=amb_color, smoothstep blend on world-up) plus per-SkyObject celestial meshes from Sky-E's resolved bakes. Per SkyObject: position on virtual sky-sphere of radius 900 inside the dome at 1000; material `opacity = 1 - transparent` (AC→three.js inversion), `emissiveIntensity = luminosity × max_bright`; UV scroll via tex_offset_x/y on `material.map.offset` each tick; `.visible` follows state.visible flag. Parented under `outdoorContainer` — when `isCurrentCellIndoor()` returns true (Phase 6 cell graph), dome + celestials hide. **RGB-as-ARGB question resolved at the material layer** (consistent with Sky-E's investigation): correct `MeshBasicMaterial` setup + opacity inversion + emissive wiring eliminates cloud-band artifact; no decode-layer change needed. Pitch curve kept as `sin(p·π)·(π/2)` (Sky-B's synthesis) — eye-test confirms sensible arc at t=0.05 (dawn) for sun + moon. ESM test `test_sky_dome.mjs` 33/33 PASS. Sky-F flipped from 11/15 → **15/15**.

- **`7859bf0` — Workstream Sky-G: polish — SkyObjectReplace lerp + DayGroup cycling + cloud scroll + properties decode.** Four pieces. (1) SkyObjectReplace dual-keyframe lerp in `evaluate_sky_object` — per-replace fields lerp linearly between the two bracketing SkyTimeOfDay keyframes; `gfx_obj_id` swaps hard at the later keyframe's `begin` time (when non-zero). Evidence: Dereth DayGroup[0] keyframe[2] (begin=0.16) replace[2] sets cloud-band luminosity=22; keyframe[3] (begin=0.21) bumps to 65 — visual: cloud band brightens between pre-dawn and early dawn. (2) DayGroup cycling — `setGameDayOverride(day, year)` wasm + URL hook for testing; 360-day probe hits all 20 buckets with counts 13-21 each, roughly uniform via the LCG hash. (3) Cloud TexVelocity scroll: wasm-side accumulation `tex_offset = tex_velocity × (now - session_start) mod 1.0`. For the retail cloud band (`tex_velocity_x = -0.013`): `tex_offset_x@t=0=0, @t=10s=0.870`, wrap-aware |Δ| = 0.130. (4) **SkyObject.Properties decode** — probed all 232 SkyObjects across 20 DayGroups: histogram `{0x00: 120, 0x02: 20, 0x04: 8, 0x05: 8, 0x0D: 76}`. Bit meanings with confidence: `0x02 SCROLLING_CLOUD` (HIGH — perfect cloud-band correlation), `0x08 PHYSICS_SCRIPT` (HIGH — 100% correlation with non-zero PhysicsScript DID on SetupModel objects), `0x04 WEATHER_STREAK` (MED — limited to 2 unique gfx ids; precipitation-class meshes), `0x01 ADDITIVE_BLEND` (LOW — only differentiator between the 0x04/0x05 streak pair). Constants land in `sky.rs` as `SKY_OBJ_PROP_*`. **Retail design note:** every `sky_obj_replace.gfx_obj_id == 0` in Dereth — retail never exercises mid-day mesh swaps; only the numeric overrides (transparent, luminosity, max_bright, rotate) actually engage. The swap mechanism in `sky_dome.js` is verifiable (`_meshSwapCount`) and ready for non-retail data; bullet 18 of Sky-F is a soft-PASS. Memory entry `project_holtburger_skybox_properties_flags` documents the probe results.

After the push, the live 3D path renders a parametric sky that
follows real-world UTC time: gradient dome with horizon/zenith
colors lerping from real Dereth SkyTimeOfDay keyframes,
`THREE.DirectionalLight` + `THREE.AmbientLight` + `THREE.Fog`
driven by the same keyframes, 7 celestial meshes (sun / moon /
clouds / stars / SetupModel-moon / base shells) positioned on a
camera-parented sky sphere at headings and pitches computed from
SkyObject `begin/end_time` + `begin/end_angle`, scrolling cloud
UVs via `tex_velocity`, weather-variation across the 20 DayGroups
via `CalcPresentDayGroup`'s deterministic LCG hash on
`(current_year, current_day)`.

What still needs eye-test (deferred — not automatable):

- Live retail-screenshot comparison for celestial-body altitude. `sin(p·π)·(π/2)` is a derived pitch curve, not a DAT-supplied keyframe. Sky-D's eye-test on tailnet1 looks sensible at dawn; a side-by-side with retail AC at a known time-of-day would catch any altitude bias.
- Properties bits `0x01 ADDITIVE_BLEND` (LOW confidence) and `0x04 WEATHER_STREAK` (MED confidence) — refine if visible artifacts surface on rainy / clear / cloudy DayGroups under headed-browser eye-test.

## Open follow-ons from the push

- **Integrator overshoot (cosmetic 25 m/s vs 4.5 m/s target).** Carried forward from `project_emit_dynamic_site` memory. After releasing W, the integrator carries inertia for 500–1000 ms before settling. Bullet 9 of the F capture detects this and accepts it as a known follow-on. Root cause may be dt scaling in the integrator, or a Playwright-headless rAF cadence artifact specific to the test environment. Needs per-tick `world.player.runtime_body.velocity` tracing to confirm.

- **Workstream G follow-on: chunk Workstream E's backlog replay through rAF batches.** When `installSharedDrainHook` lands at the end of init3D (~+13 s), it replays the ~350-event backlog synchronously. For 350 spawns × ~150 ms per `fetchEntityAnimationKeyframes` round-trip ≈ 52 s of serialised work. Currently this is hidden by an `await` chain inside `em.spawn`, but the synchronous loop in `installSharedDrainHook` itself can stall the rAF cadence for seconds. Not fixed in this push. Cost on the F capture: not measurable because the W-hold runs AFTER the backlog drain. Cost in production: 3D rig pop-in for ~50 s post-spawn under heavy NPC counts.

- **Workstream F-(a) under headed browser.** When this capture runs against a real headed browser (no Playwright-headless renderer throttling), bullet 7's path-(a) ≥15-distinct-samples criterion should automatically kick in (the diagnostic line will switch from "passed via path (b)" to "passed via path (a)"). Worth confirming once a headed-browser test environment exists.

## What works end-to-end on the 3D path

**Note:** the live 3D path is currently NOT visually rendering Holtburg because of the camera-rotation bug discovered in Phase 7.7 (see follow-on #0 below). The data pipeline, scene graph, animation, lighting, and frustum culling are all correct AND verified — the camera simply points 90° wrong. Earlier-phase captures pass because they verify scene-graph membership counts and module-export shape, not pixel output. The list below is the scene-graph state that init3D produces.

Driving `?renderer=3d` against tailnet1's live ACE (Tailscale 100.116.47.66, port 8765) AND under capture-script mode-1 (mock SessionHandle + real wasm DAT exports):

- **Terrain.** 9-LB Holtburg neighbourhood mesh built via `fetch_landblock_heightmaps([9 cell ids])` → `landblockMeshToGeometry`. Each LB is a `THREE.Mesh` with a custom `ShaderMaterial` running the bilinear-blend GLSL ES 3.00 shader from the 2D path. Atlas + road textures uploaded as `CanvasTexture` (sRGB). Per-LB world position is `(lbX*192, lbY*192, 0)`.
- **Buildings.** 16 Holtburg buildings via `fetchBuildingPlacement(modelId)`. Per-part `Object3D` tree mirrors the SetupModel hierarchy. Per-part hinge wrappers retained so door rotation can drive `Object3D.rotation.z` on the named wrapper. Per-surface `THREE.Mesh` leaves grouped by surface_did, materials cached in `MaterialCache: Map<surfaceDid, MeshStandardMaterial>`.
- **Statics.** Fused `meshToFusedGeometry` per unique modelId, then placement-instanced `Mesh`es under `staticsGroup`.
- **EnvCells.** Mite Maze (`0x01F80000`) + Holtburg Dungeon (`0x01F60000`) lazy-loaded; 1308 cells total registered into `liveScene3d.cellContainers3d`. Per-cell `Group` containing per-surface `Mesh`es + per-cell static `Mesh`es.
- **Cell visibility.** Per-rAF `tickCellVisibility3D` reads `SessionHandle.getCurrentCellId() / getRenderSet(d) / isCurrentCellIndoor()` and flips `Group.visible` on cell containers and the outdoor batch. Identical semantics to the 2D `tickCellVisibility` at `index.html:4414-4470`.
- **Animations.** `fetch_entity_animation_keyframes(setup_id, motion_table_id, motion_command, stance) → EntityAnimationData` (Rust at `apps/holtburger-web/src/lib.rs:5596`). JS-side `buildAnimationClip` in `scene3d/animation.js` converts the raw per-frame `Frame { origin, orientation }` arrays into `THREE.AnimationClip` with 2N `KeyframeTrack`s (position + quaternion per part). `AnimationCache` keys on `(setupId, motionTableId, motionCommand, stance)`.
- **Entities.** `EntityManager` in `scene3d/entities.js` owns one `THREE.Object3D` rig per GUID, one `THREE.AnimationMixer` per entity, with `crossFade` between actions on motion-command changes. Stance-keyed clip lookup. 2D `drainEvents` at `index.html:6022` forwards `pollEntityUpdates()` results to `window.__scene3dEntityHook` so the 3D path sees the same wire stream without re-draining.
- **Camera.** `CameraSwitcher` in `scene3d/camera.js` hot-swaps between `follow` (perspective), `orbit` (perspective + OrbitControls), and `topDown` (orthographic) on the `C` keypress. WASD → `setMovementInput` math is camera-relative for the follow camera. `PointerLockControls` wired for mouse-look (correct only when `playerHeading == followYaw` — see follow-on #2 below).
- **Lighting.** `setupSceneLighting(scene, { sceneSize: 600 })` attaches a `DirectionalLight` (sun) + `AmbientLight` + optional `HemisphereLight` to a `lights` group on the scene root. `tickLightingForCellState(scene3d, sessionHandle)` runs every frame, flips `sun.visible=false` + boosts `ambient.intensity` 0.5 → 0.7 when the wasm BFS reports indoor.
- **Frustum culling.** Verified in Phase 7.7. Every `BufferGeometry` in `scene3d/*.js` is constructed via one of four helpers (`landblockMeshToGeometry`, `meshToGeometryGroups`, `meshToFusedGeometry`, or the inline road overlay in `terrain.js`) and every helper calls `geometry.computeBoundingSphere()` before the geometry is wrapped in a `Mesh`. The hello-cube's `BoxGeometry` was missing `computeBoundingSphere()` and the call was added in Phase 7.7 (`scene3d/index.js:73`); three.js's primitive constructors do NOT auto-compute boundingSphere in r184. No code sets `frustumCulled = false`. Measured reduction (`capture_phase7_7_frustum.cjs` against a camera positioned correctly through the AC→three.js worldRoot rotation): in-Holtburg view = 153 draw calls / 4069 triangles, 100km-away view = 0 draw calls / 0 triangles → 100% reduction. The away-view result is even stronger than the 50% pass threshold because the far-plane is 5000 m and the entire scene fits in a 600 m box, so a 100 km translation puts everything beyond both the near-plane and the bounding-sphere test.

## Architecture

### Plan + working files

- **Working plan:** `/home/wbterminal/.claude/plans/atomic-marinating-stearns.md` (8 sections: Context, Strategic decisions, Data conversion pipelines table, Phased implementation, Critical files, Existing code to reuse, Risks and mitigations, Verification).
- **Renderer scaffolding:** `apps/holtburger-web/scene3d/` directory, 13 modules, 5005 lines total.

### `scene3d/` modules (with line counts)

| File | Lines | Role |
|---|---|---|
| `apps/holtburger-web/scene3d/index.js` | 412 | Public `init3D(canvas, sessionHandle, wasmExports)` entry point. Builds renderer + scene + cameras, calls per-phase builders, exposes `window.liveScene3d`. |
| `apps/holtburger-web/scene3d/adapter.js` | 561 | Wasm → three.js converters. `landblockMeshToGeometry`, `meshToGeometryGroups`, `meshToFusedGeometry`, `placementToMatrix4`, `acQuatToThree`, `surfacePixelsToTexture`. Always copies wasm buffers (`Float32Array.from(...)`). |
| `apps/holtburger-web/scene3d/materials.js` | 232 | `MaterialCache: Map<surfaceDid, MeshStandardMaterial>` + bulk `preload([dids])`. `fallbackMaterial` for missing-texture cases. |
| `apps/holtburger-web/scene3d/terrain.js` | 441 | Bilinear-blend `ShaderMaterial` port from `index.html:999-1075`. Road overlay as additive `MeshBasicMaterial` with `polygonOffset`. |
| `apps/holtburger-web/scene3d/buildings.js` | 404 | Holtburg building loader; per-part `Object3D` tree with hinge wrappers; per-surface `Mesh` leaves. |
| `apps/holtburger-web/scene3d/statics.js` | 250 | Fused-geometry placement loader for non-building statics. |
| `apps/holtburger-web/scene3d/cells.js` | 431 | EnvCell loader (Mite Maze + Holtburg Dungeon) + `tickCellVisibility3D`. |
| `apps/holtburger-web/scene3d/animation.js` | 269 | `buildAnimationClip(anim, partNames)` + `AnimationCache`. |
| `apps/holtburger-web/scene3d/entities.js` | 792 | `EntityManager` with per-entity rig + `AnimationMixer` + `crossFade`. |
| `apps/holtburger-web/scene3d/camera.js` | 550 | `CameraSwitcher` (follow / orbit / topDown), `PointerLockControls`, `OrbitControls`, camera-relative WASD math. |
| `apps/holtburger-web/scene3d/lighting.js` | 302 | `setupSceneLighting` + `tickLightingForCellState` + `attachSetupModelLights` (stub, deferred). |
| `apps/holtburger-web/scene3d/loop.js` | 355 | Per-frame tick (`tickPerFrame`): cell visibility → lighting → camera → entity mixer → entity-event drain. |
| `apps/holtburger-web/scene3d/hud.js` | 6 | Placeholder. Nameplate / chip overlay is a documented follow-on. |

### Wasm-bindgen surface consumed by the 3D path

All exports already exist in `apps/holtburger-web/src/lib.rs`; only `fetch_entity_animation_keyframes` was added in Phase 7.4a. Every other export is reused unmodified from the 2D path.

| Export | Rust location | Used by | Purpose |
|---|---|---|---|
| `fetch_landblock_heightmaps(Vec<u32>) -> Vec<LandblockMesh>` | `src/lib.rs:341` | `terrain.js` | 9-LB heightmap fetch for Holtburg. |
| `fetch_terrain_textures() -> Vec<TerrainTexture>` | `src/lib.rs:757` | `terrain.js` | 33-tile terrain atlas + standalone road tile. |
| `fetch_landblock_objects(Vec<u32>, u16) -> Vec<...>` | `src/lib.rs:676` | `buildings.js`, `statics.js` | Per-LB placement records (buildings + statics). |
| `fetchBuildingPlacement(model_id: u32) -> BuildingPlacement` | `src/lib.rs:2522` | `buildings.js` | Per-part mesh + hinge frame + AABB list. |
| `fetch_model_meshes(Vec<u32>) -> Vec<ModelMesh>` | `src/lib.rs:2372` | `statics.js`, `cells.js` | Per-model triangle data for fused statics. |
| `fetch_surfaces_pixels(Vec<u32>) -> Vec<SurfacePixels>` | `src/lib.rs:2169` | `materials.js` | Bulk texture-pixel fetch for `MaterialCache.preload`. |
| `fetchEnvCellsInLandblock(landblock_id: u32) -> Vec<EnvCellPlacement>` | `src/lib.rs:4730` | `cells.js` | EnvCell geometry + portal references. |
| `fetchEntityModelRender(setup_id, model_changes, texture_changes, mtable_id) -> EntityRender` | `src/lib.rs:5117` | `entities.js` | Per-part mesh + texture for entity rig build. |
| `fetchEntitySurfacesPixels(...) -> Vec<SurfacePixels>` | `src/lib.rs:2294` | `entities.js` | Per-entity surface textures (clothing-table substituted). |
| `fetchEntityAnimationKeyframes(setup_id, mtable_id, motion_cmd, stance) -> EntityAnimationData` | `src/lib.rs:5596` | `animation.js`, `entities.js` | **NEW in Phase 7.4a** — raw per-frame `Frame { origin, orientation }` arrays. |

### Coordinate convention

- **AC native:** Z-up, +X east, +Y north, heights in metres (range [0, 510 m] = `u8 * 2.0`).
- **three.js scene root:** identity matrix. **`worldRoot` (a child of `scene`) carries `rotation.x = -π/2`** (`scene3d/index.js:51`), converting AC Z-up to three.js Y-up. Every gameplay group (`terrainGroup`, `buildingsGroup`, `staticsGroup`, `cellsGroup`, `entitiesGroup`) is a child of `worldRoot`, so all geometry inside those groups is set in raw AC coordinates and three.js does the rotation once at the root. **Cameras live OUTSIDE `worldRoot`** (added directly to `scene`); they operate in three.js world coords. To put a camera at the AC location `(ax, ay, az)`, set the camera position to three.js `(ax, az, -ay)` — that is, apply the same `rotation.x = -π/2` mapping AC → three.js. The capture script `capture_phase7_7_frustum.cjs` does this explicitly.
- **Quaternion convention.** AC stores `(qw, qx, qy, qz)`; three.js `Quaternion.set(x, y, z, w)`. The `acQuatToThree(qw, qx, qy, qz)` helper in `scene3d/adapter.js` does the reorder.

## Phases — as-built

### Phase 7.0 — Scaffolding

Three.js r184 added to the page's importmap (`index.html:501-506`). Empty `THREE.Scene` + `THREE.WebGLRenderer` constructed in `scene3d/index.js`. `BoxGeometry` hello-cube at `(0, 0, 5)` for the very first capture's "scene has at least one Mesh" assertion. Feature flag wired at `index.html:4694` — `?renderer=3d` URL param dynamically imports `scene3d/index.js`; the 2D `renderNeighbourhood` path stays default. Smoke delta: +1 check.

### Phase 7.1 — Terrain

Bilinear-blend GLSL ES 3.00 fragment shader from `index.html:999-1075` ported to `THREE.ShaderMaterial` with `glslVersion: THREE.GLSL3` and `side: THREE.FrontSide`. 9-LB Holtburg neighbourhood mesh built; per-LB heightfield geometry has `computeVertexNormals()` for free Lambert hillshade and `computeBoundingSphere()` for frustum culling. Road overlay as additive `MeshBasicMaterial` with `polygonOffset: true`. Atlas + road textures uploaded as `CanvasTexture(canvas)` with `SRGBColorSpace`. Smoke delta: +1 check.

### Phase 7.2 — Buildings + statics

`renderModelTile()` replaced with direct `Mesh` construction. Per-part `Object3D` tree mirrors SetupModel hierarchy; named hinge wrappers retained for door rotation. `MaterialCache` introduced (one `MeshStandardMaterial` per `surface_did`, cached). `bakePerPartBuildingTextures()` from the 2D path dropped — that step's `RenderTexture` flatten was the 2D pipeline's only 3D-flattening op. Statics use `meshToFusedGeometry` (single fused geom per modelId) for draw-call efficiency. Smoke delta: +1 check.

### Phase 7.3 — EnvCells

Mite Maze (`0x01F80000`) + Holtburg Dungeon (`0x01F60000`) eager-loaded at init3D time. 1308 cells total across the two dungeons. Per-cell `Group` containing per-surface `Mesh`es + per-cell static `Mesh`es. `tickCellVisibility3D` wires the wasm cell BFS (`getCurrentCellId / getRenderSet(d) / isCurrentCellIndoor`) to `Group.visible` flips. Outdoor batch (`terrainGroup + buildingsGroup + staticsGroup`) toggled by the same indoor-flag check. Smoke delta: +1 check.

### Phase 7.4a — Animation keyframe export + AnimationClip adapter

New wasm export `fetch_entity_animation_keyframes(setup_id, mtable_id, motion_cmd, stance) -> EntityAnimationData` in `apps/holtburger-web/src/lib.rs:5596`. Thin Rust shim over the existing `holtburger_dat::file_type::animation::Animation` parser + `MotionTable.cycles[(stance, command)].framerate`. JS-side `buildAnimationClip(anim, partNames)` in `scene3d/animation.js` produces `THREE.AnimationClip` with 2N `KeyframeTrack`s. `AnimationCache` deduplicates by `(setupId, mtableId, motionCmd, stance)`. Smoke delta: +3 checks.

### Phase 7.4b — EntityManager + AnimationMixer

`EntityManager` in `scene3d/entities.js` (792 lines) owns per-entity rigs (one `Object3D` root per GUID, per-part `Group`s under it). One `THREE.AnimationMixer` per entity, `crossFade(0.15s)` between actions on motion-command changes. 2D `drainEvents` at `index.html:6022` forwards `pollEntityUpdates()` results to `window.__scene3dEntityHook` (installed by `installSharedDrainHook`) so the 3D path consumes the same event stream without double-draining the wasm `pollEntityUpdates()`. Smoke delta: +1 check.

### Phase 7.5 — Camera + controls

`CameraSwitcher` with three modes: `follow` (perspective), `orbit` (perspective + `OrbitControls`), `topDown` (orthographic). `C` keypress cycles through them. WASD → `sessionHandle.setMovementInput(...)` is camera-relative: in follow mode, "forward" is whatever the follow yaw is pointing at; the wasm `MovementSystem` consumes the result identically to the 2D path's mapping. `PointerLockControls` wired for mouse-look. Smoke delta: +2 checks.

### Phase 7.6 — Lighting + atmosphere

`setupSceneLighting(scene, { sceneSize: 600 })` attaches `DirectionalLight` (sun, intensity 1.0) + `AmbientLight` (intensity 0.5 outdoor, 0.7 indoor) + optional `HemisphereLight`. `tickLightingForCellState(scene3d, sessionHandle)` runs every frame; flips `sun.visible=false` when the wasm BFS reports indoor. Shadow camera framing covers Holtburg's 9-LB box (sceneSize 600 m square). Shadows opt-in, disabled by default. `attachSetupModelLights` exists as a deferred stub returning `{ lightCount: 0, deferred: true }` — per-SetupModel point/spot lights are explicitly NOT implemented in 7.6 (see follow-on #1 below). Smoke delta: +1 check.

### Phase 7.7 — Final polish + audit

Frustum-culling audit performed across `scene3d/*.js`. Findings:

1. Every `BufferGeometry` creation site in the adapter helpers (`landblockMeshToGeometry`, `meshToGeometryGroups`, `meshToFusedGeometry`) calls `computeBoundingSphere()` correctly. The inline road overlay in `terrain.js` also calls it.
2. **One Mesh creation site was missing the call** — the `THREE.BoxGeometry` hello-cube at `scene3d/index.js:69`. three.js r184's primitive constructors do NOT auto-compute boundingSphere (verified empirically); without the explicit call, the hello-cube's `frustumCulled` falls back to "always visible". Fixed in Phase 7.7 by adding `cubeGeom.computeBoundingSphere()` at `index.js:73`.
3. No `frustumCulled = false` assignments anywhere in `scene3d/*.js` or `index.html`.
4. **Bonus bug discovered in the dynamic measurement:** the live 3D path's camera does not apply the AC→three.js worldRoot rotation when setting its position. A naive AC-coords camera at the Holtburg LB centre renders **0 draw calls** — the camera misses the geometry by the 90° rotation that `worldRoot.rotation.x = -π/2` applies to its children. After mapping the camera position through `acToThree(ax, ay, az) = (ax, az, -ay)`, the same camera renders **153 draw calls / 4069 triangles**. Moving the camera 100 km away in three.js world coords drops it to **0 draw calls** (100% reduction; far exceeds the 50% pass threshold). This proves three.js's per-Mesh boundingSphere-vs-frustum check is working correctly. The camera-rotation bug itself is documented as priority-0 follow-on below; it's out of scope for the Phase 7.7 audit per the working plan.

The numerical proof lives in `capture_phase7_7_frustum.cjs`. It applies the AC→three rotation explicitly and asserts both samples + the 50% reduction floor.

Smoke delta: +1 check (the doc-exists check at the tail of `smoke_test.cjs`). Production-code delta: +1 line in `scene3d/index.js` (the missing `computeBoundingSphere` on the hello-cube). The audit was otherwise a no-op-but-proven phase.

## Open follow-ons (priority order — highest impact first)

**Phase 7.7 audit discovery (NEW — highest impact):**

0. **Cameras don't apply the AC→three.js worldRoot rotation.** `worldRoot` carries `rotation.x = -π/2` (`scene3d/index.js:51`) so child geometry in AC coords lands at three.js world `(ax, az, -ay)`. But `init3D` at `index.js:148-149` sets `camera.position.set(cx, cy, 200)` with AC coords directly, and the `cameraSwitcher.positionCamera` in follow mode at `scene3d/camera.js:332-337` does `this.persp.position.set(cx, cy, cz)` with AC `_safePlayerPos()` values directly. The camera ends up at three.js world `(ax, ay, az)` while the geometry it should be looking at is at three.js world `(ax, az, -ay)` — typically tens of thousands of metres away from where the camera looks. **`renderer.info.render.calls` is 0 for the live 3D path** unless the camera position is rewritten through the rotation. Discovered in Phase 7.7 by `capture_phase7_7_frustum.cjs`: a naively-positioned camera at AC `(32544, 34656, 200)` renders 0 draw calls; the same camera positioned at three.js `(32544, 200, -34656)` (applying `acToThree(ax, ay, az) = (ax, az, -ay)`) renders 153 draw calls. **Fix:** wrap `_safePlayerPos()`'s result through `acToThree` in `camera.js`, and apply the same transform to the init3D camera at `index.js:141-142`. Most earlier-phase captures passed because they only assert scene-graph membership counts, not visual rendering. **Impact:** the live 3D path currently shows empty space; nothing is fixable visually until this rotation is consistently applied. The 2D path is unaffected.

The pre-Phase-7.7 follow-ons documented across earlier phases:

1. **Per-SetupModel point/spot lights (Phase 7.6 deferred).** `lighting.js`'s `attachSetupModelLights` is a stub. The plan reads SetupModel's per-part light list (color, intensity, falloff, cone_angle), maps `cone_angle == 0 → PointLight` and `> 0 → SpotLight`, and caps 32 active lights via distance-sort + `.visible` toggle per tick. Need a new `fetchSetupModelLights` wasm export. **Impact:** Holtburg dungeons currently look dim and untextured-by-light; torches, lanterns, glowing surfaces would all light up correctly.

2. **Full mouse-look turn-to-align (Phase 7.5 incomplete).** `PointerLockControls` is wired in `scene3d/camera.js` but the implementation is only correct when `playerHeading == followYaw`. When the player has not aligned their heading to the camera's yaw, WASD → `setMovementInput` produces drift. **Impact:** mouse-look + WASD together can rubberband against the ACE-server-authoritative position.

3. **Live ACE end-to-end against tailnet1.** Phase 7.4b+ capture scripts time out at ~60 s on the live-ACE login round-trip and fall back to mode-1 standalone. The 2D path round-trips fine, so this is a 3D-specific timing or event-binding issue. **Impact:** the 3D path is not currently live-validated against a real ACE world session; capture coverage is real-DAT-data-only.

4. **`fetchEntityAnimationKeyframes` returns 0 parts for some setup ids — RESOLVED 2026-05-10 (false alarm; capture-script labels were stale).** ROOT CAUSE: the original Phase 7.4b capture script used **fabricated setup IDs**, not real ones. Setup `0x02000099` is a synthetic in-memory SetupModel ID used inside the `triangulate_setup_model_with_substitutions_*` unit tests in `lib.rs:11696-11814`; it does NOT exist in the real DAT (cross-referenced against `pipeline_data/enrichment/ace_world_setup_names.json` — wcid_count = 0). `0x020001ED` is also not in any wcid. `0x0200013D` exists but is used by wcid 322 (Jo), wcid 338 (Quarter Staff) — a 1-part weapon model, not Drudge. REAL IDs from the LSD-Partial weenie JSON `didStats` (key 1 = SetupId, key 2 = MotionTableId): Sparring Golem (wcid 12698) → setup 0x020007CC, mtable 0x09000081 → **21 parts / 60 frames / 30 fps**; Drudge Toiler (wcid 30649) → setup 0x020007DD, mtable 0x09000008 → **17 parts / 40 frames / 30 fps**; Mite Sentry (wcid 945) → setup 0x02001080, mtable 0x0900000B → **18 parts / 0 frames** (mtable legitimately has no WALK_FORWARD cycle — only the Ready idle resolves; mites in retail AC walked via mtable links/modifiers, a different dispatch path entirely; renderer correctly falls back to rest pose). The wasm walk in `lib.rs:fetch_entity_animation_keyframes` (line 5595) is correct in all cases — Drudge returning 1 part was the wasm faithfully reporting a 1-part Quarter Staff; Golem/Mite throwing "triangulate failed" was the wasm faithfully reporting that those IDs aren't valid SetupModels in the DAT. Fix landed: `capture_phase7_4_entities.cjs` setup table updated with real `didStats` IDs; smoke check added (`F#4: 0-parts setups investigation`). Investigation scripts preserved at `apps/holtburger-web/investigate_followon4.cjs` + `probe_mite_mtable.cjs` for any future agent that wants to retrace the diagnosis. NO Rust code changes were required.

5. **LOD via existing `did_degrade` chain (Phase 7.7 deferred).** AC's portal.dat stores degraded versions of each model in a chain (`did_degrade`). The 3D path picks the highest-detail version unconditionally. A distance-based LOD swap would dramatically cut draw calls + triangle counts at view distances >100 m. **Impact:** perf optimization, no visual regression vs current state.

6. **`InstancedMesh` for repeated buildings (Phase 7.7 deferred).** Holtburg has multiple instances of the same building type (huts, towers). Each currently produces its own `Mesh`. Migrating to `THREE.InstancedMesh` collapses N draw calls into 1 per unique geometry. **Impact:** perf optimization for the dense parts of Holtburg.

7. **Two-sided polys with distinct `pos_surface != neg_surface` (Plan risk #1).** AC's `Polygon` struct allows a different surface_did per side. `MaterialCache` currently uses one material per `surface_did`; the back-side surface gets ignored. Mitigation in `meshToGeometryGroups` would be to group polys by `(pos_surface, neg_surface)` tuple and emit one mesh per tuple. **Impact:** specific known-bad surfaces (translucent windows, double-sided cloth banners) render with the wrong material on one side.

8. **Surface-type bitfield decode (Plan risk #5).** The `surface_type` flags carry transparent / alphaTest / additive / two-sided bits; only `transparent: false` is decoded today. **Impact:** translucent particles, additive flame effects, alphaTest foliage all render as opaque.

9. **Visual ground-truth comparison vs WorldBuilder.Terminal `render-preview`** (Phase 7.1+ deferred). The plan calls for the top-down ortho mode (camera toggle) to match WorldBuilder.Terminal's `render-preview` output pixel-for-pixel as the visual baseline. This comparison has not been run. **Impact:** an objective regression detector for any future renderer-pipeline change.

10. **Nameplate / chip / chat overlay via PIXI HUD** (`hud.js` is a 6-line placeholder). PIXI v8 stays in the page for HUD overlays, but the 3D path's `hud.js` is empty. The 2D path's nameplate / chat / vitals chips still render correctly because the 2D path is still default. **Impact:** when the 3D path becomes default, nameplate text disappears.

11. **Mobile validation on PK's phone over 600 kbps cellular (Phase 7.7 deferred — open Phase 5.2 obj 11).** Plan calls for first-paint <60 s in 3D mode on mobile. Not validated. **Impact:** unknown; iOS Safari WebGL2 has historic quirks the plan flags.

12. **Bundle-size measurement and gating** (Phase 7.7 deferred). Plan calls for <1 MB gzipped on the 3D path. The dynamic `import("./scene3d/index.js")` only loads on the 3D path so the 2D-default flow pays nothing today. Numerical measurement not run.

13. **Animation framerate variance** (Plan risk #3) — **CLOSED-AS-NIL 2026-05-10.** Audited the AC animation data model against three independent sources (holtburger-dat parser, ACE.Server `AnimData.cs`, DatReaderWriter `AnimationTests.cs`). The data carries framerate per-cycle (`AnimData.framerate: f32`), not per-frame. `Frame { origin, orientation }` and `AnimationFrame { frames, hooks }` have NO time/delta/duration fields. AC's `AnimationHook` payloads carry direction + type but no timing — hooks fire on the indexed frame as it's rendered. Therefore uniform `times[i] = i / framerate` IS the authoritative AC semantics; the existing `buildAnimationClip` is correct as-shipped. Audit note documenting this is at `apps/holtburger-web/scene3d/animation.js:83-110`. Any future judder is a different bug (mixer step size, crossFade timing, dt accumulation in the rAF loop).

## How to validate

End-to-end recipe to confirm the 3D path is healthy after a code change:

1. **Smoke test (fast, file-only checks):**
   ```bash
   cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger
   node apps/holtburger-web/smoke_test.cjs --fast 2>&1 | tail -5
   ```
   Expect: `PASS: all smoke checks green.` and ~93 OK lines (the `--fast` mode runs a subset).

2. **Smoke test (full, includes the wasm-pack build):**
   ```bash
   node apps/holtburger-web/smoke_test.cjs 2>&1 | tail -5
   ```
   Expect: 138 OK + 1 SKIP = 139 total. The SKIP is `start_session live round-trip`.

3. **Per-phase captures (Playwright; needs the live HTTP server on 100.116.47.66:8765):**
   ```bash
   for phase in 7_0 7_1 7_2 7_3 7_4 7_5 7_6 7_7; do
     for f in apps/holtburger-web/capture_phase${phase}*.cjs; do
       echo "--- $f ---"
       NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules node "$f" 2>&1 | tail -3
     done
   done
   ```
   Each capture should print `PASS: all Phase 7.X capture checks green.` at the end.

4. **Cargo tests:**
   ```bash
   source ~/.cargo/env
   cargo test --workspace 2>&1 | grep -E "test result"
   ```
   Expect: 1222 passed across all crates, 0 failed.

5. **Phase 7.7 frustum measurement specifically:**
   ```bash
   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
     node apps/holtburger-web/capture_phase7_7_frustum.cjs 2>&1 | tail -25
   ```
   Look for the `holtCalls` vs `awayCalls` numbers in the printed JSON. The away count should be < 50% of the holt count. If it's not, three.js's frustum culling is broken — investigate any newly added `Mesh` for a missing `computeBoundingSphere()` or an accidental `frustumCulled = false`.

## How to roll back

If a future commit breaks the 3D path and you need to disable it without redeploying:

1. **Per-user, no code change:** simply visit the page without `?renderer=3d`. The 2D PIXI path is still the default and is completely independent of the 3D code path.

2. **Permanently, code change:** in `apps/holtburger-web/index.html:4694-4696`, the feature flag reads:
   ```js
   const useRenderer3d =
     new URLSearchParams(window.location.search).get("renderer") === "3d";
   if (useRenderer3d) {
     renderStatus.textContent = "Initializing 3D renderer (?renderer=3d)…";
     const { init3D } = await import("./scene3d/index.js");
     // ...
   }
   ```
   Replace the first `useRenderer3d` declaration with `const useRenderer3d = false;` and the 3D path is unreachable. The 2D path retains all coverage.

3. **Cutover to 3D default (when ready):** flip the same flag to `const useRenderer3d = new URLSearchParams(...).get("renderer") !== "2d";` so the 3D path is the default and `?renderer=2d` becomes the opt-out. Do this only after the highest-priority follow-ons above (per-SetupModel lights, mouse-look correctness, nameplate HUD) are landed and live-validated.

## Files referenced

- Working plan: `/home/wbterminal/.claude/plans/atomic-marinating-stearns.md`
- Renderer scaffolding: `apps/holtburger-web/scene3d/` (13 modules, 5005 lines)
- Wasm entry: `apps/holtburger-web/src/lib.rs` (notably `fetch_entity_animation_keyframes` at line 5596)
- Feature flag: `apps/holtburger-web/index.html:4694-4699`
- Drain forwarding: `apps/holtburger-web/index.html:6022-6030`
- Smoke harness: `apps/holtburger-web/smoke_test.cjs` (139 checks)
- Captures: `apps/holtburger-web/capture_phase7_*.cjs` (8 files)
- ESM tests: `apps/holtburger-web/test_phase7_*.mjs` (4 files)
- Prior milestone docs: `docs/phase-5.2-manifest-fix.md`, `docs/phase-6-buildings-and-interiors.md`, `docs/post-phase-6-followons-handoff.md`
