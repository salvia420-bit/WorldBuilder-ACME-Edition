# holtburger-web URL flags reference

Every `?key=value` query flag the web client reads, grouped by purpose. Flags are
appended to the app URL, e.g. `…/apps/holtburger-web/?renderer=3d&clouds=on`.

Line numbers are approximate (code drifts); grep the named file for the flag key
if a line has moved. Compiled from a full sweep of `index.html`, `scene3d/**`,
and `plugins/**` on 2026-06-08.

Central parsing locations:

- **`index.html`** ~7590 — `bootParams = new URLSearchParams(location.search)`; all login/automation params + the `agent`/`hud`/`autoLogin` CSS gates at ~555.
- **`scene3d/quality.js`** ~156–169 — quality preset + per-feature override parser (`parseOverrides`).
- **`scene3d/index.js`** — main renderer init; many `new URLSearchParams(location.search)` reads.
- **`scene3d/entities.js`** — entity/movement feature gates.
- **`scene3d/weather/manager.js`** ~30–61 — `parseUrlOverrides()` for weather flags.

Boolean-flag convention (quality.js): `on` / `true` / `1` / `yes` → true; `off` /
`false` / `0` / `no` → false. Integers via `parseInt(v,10)`, floats via `parseFloat`.

---

## Remote playtest — quick start (VERIFIED 2026-06-08)

The combined cloudflared quick-tunnel exposes both HTTP and the WebSocket bridge
on one origin (`proxy.cjs:7080` → serve.py:8765 `/*` + wsbridge:8080 `/wsbridge`).

```
https://<tunnel-host>/apps/holtburger-web/?renderer=3d&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first&bridge_url=wss%3A%2F%2F<tunnel-host>%2Fwsbridge&server_host=127.0.0.1&server_port=9000
```

- `<tunnel-host>` = the `*.trycloudflare.com` host of the cloudflared tunnel
  pointed at `:7080`. Find it with:
  `grep -aoE 'https://[a-z0-9-]+\.trycloudflare\.com' /proc/<cloudflared-pid>/fd/1`
- `tailnet1` / `tailnet1` is the standing automation account (teleport/Developer privs).
- Add `&kickDance=1` if a prior session is still in-world (does connect→kick→reconnect).
- Quick-tunnel hosts are **ephemeral** — they rotate whenever cloudflared restarts
  (it has no respawn guard, unlike serve.py/proxy.cjs). Re-grep for the new host.

### ⚠ GOTCHA: `bridge_url` is mandatory for remote, and easy to drop

The login form **defaults to `ws://127.0.0.1:8080/`** (the browser's own loopback),
which never reaches the bridge from a remote device. If you omit `bridge_url` — or
the URL gets **truncated on paste** (messaging apps love to cut at `%` or `&`) — you
get this exact failure cascade:

```
Firefox can't establish a connection to the server at ws://127.0.0.1:8080/.
start_session failed: WsTransport::connect: ws handshake failed
Uncaught Error: closure invoked recursively or after being dropped   ← wasm error-path cascade, NOT a wasm bug
```

The `closure invoked recursively` panic is the wasm's start_session error path
firing on each autoLogin retry — it disappears the moment the handshake succeeds.
Fix = load the **complete** URL including `&bridge_url=wss://<host>/wsbridge`.
(Consider auto-deriving the default bridge from `location.origin` when served over
https, so a bare URL works remotely — see "Possible hardening" at the bottom.)

---

## 1. Required / mode flags

| Flag | Values | Default | Effect | Where |
|---|---|---|---|---|
| `renderer` | `3d` vs anything | **2D** (PIXI) | `=3d` switches to the three.js pipeline. **Required** to exercise any scene3d work. | index.html:2128, 6736, 6768 |
| `quality` | `low`\|`mid`\|`high`\|`ultra` | auto-detect by GPU | Master visual preset — drives ~15 feature toggles at once. | scene3d/quality.js:323 |
| `agent` | `1` | off | Agent-mode CSS: hides login form, canvas only. (autoLogin also adds this class.) | index.html:556 |
| `hud` | `none` | HUD shown | Hides all UI overlays (HUD, bars, nameplates). | index.html:559, 2128 |
| `plugins` | `none` | all loaded | Skip plugin loading entirely. | index.html:1321 |
| `nosw` | `1` | SW on | Disable/unregister the service worker (clean test isolation). | index.html:1812 |

---

## 2. Visual / render flags

| Flag | Values | Default | Effect | Where |
|---|---|---|---|---|
| ~~`cellStaticMultiSurface`~~ ✅ **DONE — eye-test PASSED 2026-06-10, INTEGRATED always-on** (cells.js `readCellStaticMultiSurface()` returns true; JS, live on reload) | — | F14-3: render EnvCell static props (lanterns, braziers, tables, chests, beds) with ALL their surface textures via a fused multi-material mesh, instead of fusing to a single first-surface material. Visible in every interior. | scene3d/cells.js |
| ~~`nameplateOcclusion`~~ ✅ **DONE — eye-test PASSED 2026-06-10, INTEGRATED always-on** (nameplate_sprite.js `_NAMEPLATE_OCCLUSION_FLAG = true`; JS, live on reload) | — | F14-6: flip nameplate + buff-badge `depthTest` ON while the local player is INDOOR so dungeon walls occlude overhead names/badges instead of X-raying through. Outdoors stays on-top (matches the 2D path). Full per-entity PVS cell-membership cull deferred (needs per-entity objcell_id from wasm). Default-off pending 1070 eye-test. | scene3d/nameplate_sprite.js + scene3d/cells.js |
| `clouds` | `on` | off | Volumetric cloud rendering (Bruneton/takram). GPU-heavy. | scene3d/index.js:2535 |
| `cloudCoverage` | float 0–1 | 0.5 | Cloud coverage density. | scene3d/index.js:2540 |
| `cloudQuality` | `low`\|`medium`\|`high`\|`ultra` | high | Cloud raymarch resolution. | scene3d/index.js:2541 |
| `cloudShadow` | `off` | on | Cloud shadows on terrain. | scene3d/index.js:2581 |
| `cloudShadowStrength` | float 0–10 | 2.0 | Cloud shadow extinction. | scene3d/index.js:2585 |
| `cloudShadowRes` | int 64–2048 | takram default | Cloud shadow map resolution. | scene3d/index.js:2594 |
| `shadows` | `on` | per-preset | Override cascaded shadow mapping. | scene3d/index.js:483 |
| `csm` | `on`/`off` | per-preset (high+) | Cascaded shadow maps. | scene3d/quality.js |
| `normalMaps` | bool | per-preset (high+) | Procedural normal maps. | scene3d/quality.js |
| `pom` | `on`/`off` | per-preset (high+) | Parallax occlusion mapping. | scene3d/quality.js |
| `forcePom` | `on` | off | Force POM regardless of preset. | scene3d/index.js:970 |
| `pomStepsPrimary` | int | preset (16/24) | POM primary sample steps. | scene3d/quality.js |
| `pomStepsSelfShadow` | int | preset (8/12) | POM self-shadow sample steps. | scene3d/quality.js |
| `bloom` | `on`/`off` | per-preset | HDR bloom. | scene3d/quality.js |
| `antialias` | `on`/`off` | per-preset (mid+) | FXAA. | scene3d/quality.js |
| `vignette` | `on`/`off` | per-preset (high+) | Edge darkening. | scene3d/quality.js |
| `lensFlare` | `on`/`off` | **off** even at high | Lens flare (off by default; perf/stutter). | scene3d/quality.js |
| `lightShafts` | `on`/`off` | per-preset (high+) | Volumetric god rays. | scene3d/quality.js |
| `detailFlag` | `on`/`off` | per-preset (mid+) | Detail texture layers. | scene3d/quality.js |
| `forceDetail` | `on` | off | Force detail textures on. | scene3d/index.js:664 |
| `terrainDetailNormal` | `on`/`off` | per-preset (mid+) | Terrain detail normal maps. | scene3d/quality.js |
| `triplanar` | `on`/`off` | per-preset (mid+) | Triplanar blend on steep slopes. | scene3d/quality.js |
| `triplanarSlopeThresholdPct` | int 0–100 | preset (100/60/30) | Slope % threshold for triplanar. | scene3d/quality.js |
| `subdivLevel` | int | preset (1/2/4/8) | Terrain mesh subdivision. | scene3d/quality.js |
| `hero` | `on`/`off` | per-preset (high+) | Enhanced "hero" detail rendering. | scene3d/quality.js |
| `renderScale` | float 0–2 | 1.0 | Render-target resolution multiplier. | scene3d/index.js:409 |
| `maxParticlesPerEmitter` | int | preset (64–2048) | Particle budget per emitter. | scene3d/quality.js |
| `skyWeather` | `on` | off | Parametric weather SkyObject billboards. | scene3d/sky_dome.js:98 |
| `skyWeatherGain` | float | 3.5 HDR / 1.0 LDR | Weather billboard radiance boost. | scene3d/sky_dome.js:118 |
| `sunSize` | float | takram default | Sun disc size. | scene3d/atmosphere_sky.js:112 |
| `moonSize` | float | takram default | Moon disc size. | scene3d/atmosphere_sky.js:131 |
| `moonSpeed` | float | 1.0 | Moon orbital speed multiplier. | scene3d/ac_moons.js:318 |
| `skyObjLum` | float | default | Sky object luminosity scale. (default-ON 2026-06-09, opt-out =off, pending 1070 eye-test) | scene3d/atmosphere_sky.js:226 |
| `fogLerp` | float | default | Fog blend rate. | scene3d/loop.js:637 |
| `terrainSlopeShading` | `on` | off | F12-3/FU-2: slope-dependent sun shading — multiplies the terrain NdotL by a wrap-floored world-space NdotL off the per-vertex geometry normal (vAcNormal), so mountains/valley walls/cliffs get light-shade relief (most visible at dawn/dusk). FU-2: the RNM detail base now stays flat (the world normal is NOT routed through the tangent-space RNM, which produced NaN/pure-black on sloped facets); the slope term is applied as a separate world-space factor. Default-off pending 1070 eye-test vs the white/dark exposure pipeline. | scene3d/terrain.js |
| `terrainMod` | `on`/`off` | **on** | Terrain colour modulation (Ice/Road; dead-in-retail). (default-ON 2026-06-09, opt-out =off, pending 1070 eye-test) | scene3d/index.js:2084 |
| `terrainModSatHue` | float | default | Terrain mod saturation/hue shift. | scene3d/index.js:2103 |
| `terrainPalette` / `terrainDetailTex` / `texMerge` | string | default | Terrain texture/palette/merge overrides. (`terrainDetailTex`, `texMerge` default-ON 2026-06-09, opt-out =off, pending 1070 eye-test) | scene3d/index.js:2120–2156 |
| `textureScale` | float | 1.0 | Global texture downscale. | scene3d/index.js:458 |
| `atlasTilePx` | int | 512/platform | Material atlas tile size. | scene3d/index.js:467 |
| `wireframe` | `1` | off | Wireframe rendering. | scene3d/index.js:277; entities.js:10 |
| `lightClamp` / `flatDiffuse` | float | default | Debug shading overrides. (`lightClamp` default-ON 2026-06-09, opt-out =off, pending 1070 eye-test) | scene3d/materials.js:988–1006 |
| `particleSortObjects` | `off` to disable | on | Particle sort by scene objects vs camera. | scene3d/particles/particle_manager.js:40 |
| `portalSpace` | `on` \| float scale | **off** | Portal-space travel donut: flies the camera through Setup `0x02000306` (a hollow purplish ring, real DAT textures) on every teleport, with a forward+sidestep+turn swirl + iris open/close + the retail enter/exit portal whooshes. `=on` uses the default scale (0.4); a float (`=0.3`) sets the ring scale. Plays for indoor↔indoor + rapid recalls. 3D only. | scene3d/portal_space.js; index.html kind=33 |
| `portalSound` | hex Wave DID \| `off` | `0x0A000246` | Override the **enter** whoosh (one-shot, only with `portalSpace`). Default `0x0A000246` is the VERIFIED `Sound.UI_EnterPortal` wave (SoundTable `0x2000004B`; exit uses `0x0A000245`). `=off` mutes. Silent (no crash) if the id is wrong. | scene3d/portal_space.js |
| `portalSoundLoop` | hex Wave DID | none | Optional looping ambience bed for the whole transit (only with `portalSpace`), pinned to the listener. e.g. `=0x0A000316` (a real but un-table-mapped portal-adjacent wave). Off by default. | scene3d/portal_space.js |
| `surfaceUnified` | `on`/`1`/`true` | **off** | A10-M1+M2 (2026-06-11): route ALL THREE Surface (0x08) flag→material decode sites through the single `applySurfaceRenderState` (the JS analogue of retail `D3DPolyRender::SetSurface`, the SOLE funnel for every drawn surface). M1: the cache path is byte-identical (proven: 70/70 flag×float combos in `test_f7_8_surface_bitfield.mjs`); the dyed/paletted path additionally attaches the luminous `emissiveMap` so dyed luminous gear stops washing to white (A10 §3 row 2 / ROADMAP §7 item 2). M2: the entity-owned (F.41 recolour) path `_buildEntityOwnedFromPixels` now threads the render-state flags through too — a recoloured NPC/gear surface with Translucent/Additive/ClipMap/luminosity renders correctly instead of flat-opaque (A10 §3 row 3); `surfaceType===0` recolours stay a decoder no-op (byte-identical to legacy). JS-live. Off = legacy multi-path. 1070-gated: dyed-luminous eye-test (lifestone, dyed glow gear) + recoloured NPC with a translucent robe. | scene3d/materials.js `applySurfaceRenderState` / `readSurfaceUnifiedFlag` / `_buildEntityOwnedFromPixels`; entities.js `_applyPalettedSurfaceRenderState` |

---

## 3. Gameplay / movement / entity flags

| Flag | Values | Default | Effect | Where |
|---|---|---|---|---|
| `inputFunnel` | `on` | off | A14-I1 (2026-06-11 unification survey): route BOTH keyboard→movement dispatchers (the index.html rAF block + camera.js `_dispatchMovement`) through ONE shared `InputController` (`scene3d/input.js`) with a single `setMovementInput` boundary + a single dedup signature, instead of two independent keystate trackers each deduping against its own `lastInputSig`. Fixes the split-brain: orbit-mode movement suppression (camera policy) now applies at the one funnel, so the index.html dispatcher can no longer keep sending WASD while the camera path suppresses it; cross-site duplicate/stale dispatches are deduped. camera.js contributes the movement policy (orbit-suppress / topDown / follow); index.html contributes the input gate (`enteredWorld && !typing`). Jump keydown/keyup are untouched. Default OFF → both legacy paths run byte-identical (controller never consulted). Does NOT touch the picking.js synthetic-mover call sites (charge-pursuit / turn-to-face) — that is Stage I2. JS-live. Headless test: `test_a14_i1_input_controller.mjs`. | scene3d/input.js + index.html (rAF dispatch + gate) + scene3d/camera.js (`_movementPolicy` + dispatch) |
| `velScale` | `off` to disable | **on** (since 2026-06-05) | Velocity-scaled locomotion cycle (anti-ice-skating). | scene3d/entities.js:337 |
| `signedMotionSpeed` | `on` | off | F15-2: play the locomotion clip in REVERSE for a backstep (negative wire forward_speed) instead of moonwalking the forward walk. Magnitude still from the velScale getter; only flips the final timeScale direction (inert when off). Backstep facet only — the Left→Right strafe/turn reverse is a follow-on. Pending 1070 eye-test. | scene3d/entities.js |
| `fullBodyOneShot` | `on` | off | F15-1: make attack/cast/emote one-shots FULL-BODY by ramping the base locomotion cycle's weight to 0 for the overlay's duration (restored on 'finished'), instead of the ~50/50 blend that plays swings at half amplitude. Mirrors retail's remove_cyclic_anims-then-re-add. FU-3 (2026-06-11): now also covers the LOCAL player's predicted swing/cast via `setSwingMotion` (was server-echo `_tryPlayLink` only) — suppresses the base cycle and skips the legs-out crossfade when moving. Pending 1070 eye-test. | scene3d/entities.js |
| `cmtStanceMask` | `on` | off | F6-1: mask the CombatManeuverTable tree keys + lookup to low-16 so getCombatManeuver actually resolves (the tree was keyed by the full MotionStance u32 but callers pass low-16, so it missed 100% and the local melee swing was always the canned "vibe pose"). Lights up the real SlashHigh/BackhandMed/etc clips. Pending 1070 eye-test. | ui/ac_combat_maneuver.js |
| `castSpeed` | `on` | off | F8-1: pace the local cast-gesture chain at ACE CastSpeed=2.0 (clip timeScale ×2, sleeps ÷2) instead of 1×, so the windup doesn't lag the projectile/recoil by ~2×; also suppresses the matching wire echo (F6-2 dedup) so the server's 2× windup doesn't fight the prediction. Pending 1070 eye-test. | scene3d/entities.js |
| `castVfxDedup` | `on` | off | F9-3: drop a duplicate (guid, scriptId) PlayEffect within 2s (first-wins) so the local caster's CasterEffect doesn't flash twice — the synthetic emit (chain end) + the wire GameMessageScript both fire. Pending 1070 eye-test (must not swallow a legitimate rapid re-trigger). | scene3d/play_effect_vfx.js |
| `castStateMachine` | `on` | off | F8-4: minimal client cast-state machine — while a cast is in flight, a repeat cast for the same caster is ignored instead of restarting the windup animation every spam-click. Busy window sized to the chain (capped 12s, auto-expires); UseDone / fizzle clear it early. (UI-grey of spell rows + peace-mode rejection feedback are noted follow-ons.) Pending 1070 eye-test. | scene3d/entities.js + index.html |
| `castFizzle` | `on` | off | F8-2: a fizzle (WeenieError 0x0402 YourSpellFizzled) cancels the local cast-gesture chain (cancelCastSequence bumps the token + recoils to Ready), so a fizzled cast doesn't finish the windup and flash the success glow. The success-VFX token-guard (no phantom glow on a cancelled chain) ships unconditionally. Pending 1070 eye-test. | index.html + scene3d/entities.js |
| `deadReckon` | `off` to disable | on | Remote-entity motion smoothing / dead-reckoning. | scene3d/entities.js:55 |
| `headingSnap` | `on` | off | Instant heading vs eased rotation (legacy). | scene3d/entities.js:74 |
| `headingEaseK` | float >0 | conservative | Heading ease-in damping rate. | scene3d/entities.js:86 |
| `cycleOmega` | `on`/`off` | **on** | Apply cycle-authored angular velocity (spinners). (default-ON 2026-06-09, opt-out =off, pending 1070 eye-test) | scene3d/entities.js:358 |
| `mtClassFallback` | `on` | off | Stage-1 generic class-mask motion-dispatch fallback — surfaces unmatched MT-modeled commands on the forward path (no-op if the MT lacks the clip). | scene3d/entities.js |
| `idleFidget` | `on` | off | Autonomous client-side idle-fidget/idle-variation cycling so standing entities are not frozen in one Ready idle. (FU-4 2026-06-11: stance-0 at-rest NPCs/creatures now probe correctly — `_fireIdleFidget` no longer early-returns on stance 0, and `classify_motion_link_for_swing` resolves stance 0 → `default_style`; needs wasm rebuild, pending 1070 eye-test) | scene3d/entities.js + src/lib.rs |
| ~~`forceMotionLocal`~~ ✅ **DONE — eye-test PASSED 2026-06-10 (`@animation Sitting`), INTEGRATED always-on** (loop.js `FORCE_MOTION_LOCAL_ON = true`; JS, live on reload; B9 prediction preserved) | — | Apply server-forced NON-locomotion motions (sit/sleep/paralysis/forced emote) to the local player instead of skipping them. SG-B (2026-06-09) gates on the real wire `is_autonomous` bit (`EntityUpdate.isAutonomous`): play only when the server marked the motion forced (`!isAutonomous`) AND it is non-locomotion (B9 predictor preserved). **INERT until the wasm is rebuilt** — `EntityUpdate.isAutonomous` is a Rust-side getter, so the shipped `pkg/` still returns `undefined` (→ treated as not-forced) and the gate never fires; `?forceMotionLocal=on` is a no-op on the current bundle. Rebuild (`wasm-pack build` + cache-bust bump) makes it live; then pending 1070 admin-force-sit eye-test. | scene3d/loop.js + apps/holtburger-web/src/lib.rs (needs wasm rebuild) |
| `dynLod` | `on` | off | Dynamic entity LOD despawn/respawn with distance. | scene3d/entities.js:376 |
| `sortCenter` | `on` | off | Transparency sort via AC authored sort-centers. | scene3d/entities.js:113 |
| `maxTickDist` | float | ~2000 | Max distance for entity anim/AI ticking. | scene3d/entities.js:795 |
| `entitySmoothStride` | int | default | Entity frame-blend stride. | scene3d/entities.js:820 |
| `gaitHz` | float >0 | ~1.0 | Locomotion cycle playback frequency. | scene3d/entities.js:846 |
| `entityLights` | `on` | off | Entity-attached dynamic lights (SetLight hook 25). | scene3d/entities.js:35 |
| `multiAction` | `on` | off | Allow concurrent combat actions. | scene3d/loop.js:99 |
| ~~`missileFaceTarget`~~ ✅ **DONE — eye-test PASSED 2026-06-11, INTEGRATED always-on** (picking.js `MISSILE_FACE_TARGET = true`; JS, live on reload) | — | F7-3: turn the local player to face the target before a missile shot (ACE TurnToObject), so the arrow doesn't leave your back when the target is behind/beside you. Reuses chargeTick's turn-input pulse; in-range path only (the out-of-range charge already turns). Default-off, pending 1070 eye-test. | scene3d/picking.js |
| `castFaceTarget` | `on` | off | F8-5: turn the local caster to face the target before a spell cast (ACE Rotate()), so the bolt doesn't launch sideways/backwards out of a frozen wrong-facing caster. Same turn-in-place mechanism as `missileFaceTarget`. Default-off, pending 1070 eye-test. | scene3d/picking.js |
| `powerMeterSwingDuration` | `on` | off | F10-3: drive the combat-bar power/recovery meter's refill duration off the actual resolved swing-clip length (picking.js resolves it via the typed motion-link lookup and passes it on the combatCommenceAttack event detail) instead of the pure-power `600+power*1200` heuristic, which drifts from the real swing cadence at most power settings. Falls back to the heuristic when the duration isn't resolvable (MT not cached, auto-repeat re-arm). NOTE: the meter already animated on the first/single swing — picking.js's local-fire emit seeds it (the doc's "first attacks never animate" premise was stale); this only refines the duration. Default-off pending 1070 eye-test. | scene3d/picking.js + plugins/combat-bar.js |
| `melee3dRange` | `on` | off | F6-5: make the melee reach gate a 3D cylinder distance instead of a flat 2.5m horizontal circle. The old 2D check was blind to a target's Z offset, so a monster on a ledge / raised platform read as in-range and fired an in-place "phantom" swing while the server force-position-walked the player (legs not animating). On → the vertical excess (beyond ~2m of slack) folds into the distance, so an elevated target is out of range and the existing client charge engages (run cycle + steering pursues until genuinely in reach). Stop-condition + gate share the metric. Full radius subtraction (large-monster cylinder edge) deferred — needs per-entity physics radius from the DAT. Default-off pending 1070 eye-test. | scene3d/picking.js |
| ~~`spawnDoorCollision`~~ ✅ **DONE — eye-test PASSED 2026-06-10, INTEGRATED always-on** (lib.rs `spawn_door_collision_on = true`; live after the batched wasm rebuild) | — | F17-3: COLLISION twin of `spawnMotionState`. A door that spawns already-OPEN (DOOR flag + ETHEREAL) gets the live DoorStateChanged{Open} collision treatment at ObjectCreate — drop the closed-door building AABB / add the indoor cell-mesh exclusion — so DefaultOpen doors (and doors opened before you arrived) aren't an invisible wall. | apps/holtburger-web/src/lib.rs |
| ~~`skipContainedSpawn`~~ ✅ **DONE — eye-test PASSED (functional) 2026-06-10, INTEGRATED always-on** (lib.rs `skip_contained_spawn_on = true`; live after batched rebuild). ⚠ **Follow-up noted:** equip-from-pack assumes the pose but the in-HAND weapon MESH does not render — a ParentEvent/0xF749 attach gap (NOT a regression from this skip); queued for an agent. | — | F16-2: skip the 3D KIND_SPAWN for contained pack items (ObjectCreate with no `pos` and no `wielder_id` — full inventory at login, loot, vendor buys). Stops a per-item origin ghost rig from leaking at LB 0x0000 for the session; the 2D inventory UI is fed independently. | apps/holtburger-web/src/lib.rs |
| ~~`speechBubbles`~~ | — | **ALWAYS-ON** | ✅ **DONE — 1070 eye-test PASSED 2026-06-10; integrated always-on, gate removed (index.html kind=55 handler no longer checks the param).** F17-5: float a fading text bubble over the 3D speaker for near-field chat (HearSpeech/HearRangedSpeech) and emotes (EmoteText/SoulEmote). The wasm recv loop emits a kind=55 `CLIENT_EVENT_KIND_OVERHEAD_SPEECH` (sender guid + raw text + category) alongside the existing kind=2 chat-panel line. Say in white, emote in violet; bubble sits above the nameplate, holds ~4.5s then fades. | apps/holtburger-web/src/lib.rs + scene3d/speech_bubble.js + scene3d/entities.js + index.html |
| ~~`launcherVelocityTable`~~ ✅ **DONE — INTEGRATED always-on 2026-06-10 (user-accepted; not individually eye-tested — static table feeding existing aim math, misses fall back to 20.0). lib.rs gate removed; live after batched rebuild.** | — | F7-4: resolve per-weapon projectile speed (PropertyFloat 26 MaximumVelocity) from a static `wcid→MaximumVelocity` table (`data/launcher_max_velocity.json`, 493 MissileLauncher weenies extracted from LSD-Partial) instead of the 20 m/s floor. ACE never transmits PropertyFloat 26 per-instance (it's a weenie property read server-side in GetProjectileSpeed), so every launcher was predicted at 20 m/s — over-arcing the aim-elevation buckets for the 493 launchers whose real speed is 15–50 m/s (NONE are 20.0) and mispredicting long-range out-of-range/arc fallbacks. Resolved Rust-side in `resolve_launcher_max_velocity` keyed by the wielded launcher's `entity.wcid` (which IS on the wire), feeding the existing `EquippedWeaponJs/WieldedWeaponEntry.maximumVelocity` getter → picking.js needs no change. Wire value still wins if ACE ever sends it. Default OFF → 20.0 floor (byte-identical). Needs the wasm rebuild. Mostly masked until F7-2 (Class C) but corrects the arc/range math now. Default-off pending 1070 eye-test. | apps/holtburger-web/src/lib.rs + data/launcher_max_velocity.json |
| ~~`fullPlacementQuat`~~ ✅ **DONE — INTEGRATED always-on 2026-06-10 (user-accepted; tilted-prop A/B at LB 0x7D64 setup 0x020002FA was set up but user opted to integrate directly). statics.js `FULL_PLACEMENT_QUAT = true`; JS, live on reload; degrades to yaw-only on stale pkg/degenerate quat.** | — | F13-4: orient outdoor static placements from the full AC quaternion (qw/qx/qy/qz, now exported on ObjectPlacement) instead of the yaw-only rotationZ. ~0.11% of outdoor LandblockInfo stabs (48 of 42,942 — tilted props on slopes, deliberate 90° lay-downs; e.g. LB 0x7D64) carry a non-yaw orientation that the yaw-only path renders bolt upright at a garbage heading. On → placementMatrix + buildSingletonNode apply the full quat (frame-consistent: same z-up AC frame as the yaw-only setFromAxisAngle); 0-norm/missing quat (stale pkg) or non-finite falls back to rotationZ. 2D path keeps reading rotationZ. Needs the wasm rebuild (new getters; non-load-bearing so no manifest bump — graceful fallback). Default-off pending 1070 eye-test. | apps/holtburger-web/src/lib.rs + scene3d/statics.js |
| `lodRebake` | `on` | off | F12-6: re-bake a resident terrain LB's subdivision LOD when the player approaches. `pickSubdivLevelForLb` picks each LB's subdiv level from the player's LB at BAKE time and pre-F12-6 it was frozen — walking from a coarse outer-ring LB toward it never upgraded its detail, so terrain under your feet stayed coarser (24m facets) than where you logged in. On → a per-frame driver (shares the LandblockLRU current-LB read) re-points the LOD reference on an LB change, compares each resident LB's baked `userData.subdivLevel` vs what the new centre picks, and re-bakes mismatches one-per-frame (terrain-only teardown + `loadTerrainForLandblock`; buildings/statics/cells untouched). Default OFF → tick early-returns, no reconcile/opts-mutation → byte-identical. Pairs with the deferred F12-1 edge weld (1070) for a crack-free moving LOD boundary — until that lands the flag-on path may show a seam, hence default-off. Only active at subdivLevel ≥ 2 (canSubdivide). JS-only. Default-off pending 1070 eye-test. | apps/holtburger-web/scene3d/terrain.js + scene3d/index.js |
| `strictWaterCodes` | `on` | off | F12-5: restrict the animated-water terrain set to retail's SurfChar water codes (16-20). The default set also includes 22 (FauxWaterRunning) + 23 (SeaSlime), which retail's surface-characteristic table marks NOT water — so marsh/slime terrain bobs ±0.25m, scrolls, and breathes blue like open sea. The set feeds one `uWaterCodeMask` now shared by all three sites (vertex displacement, per-corner UV scroll [was a hardcoded `t>=16&&t<=23&&t!=21` range, now reads the mask — byte-identical by default], and blue tint), so the flag drops 22+23 from all three uniformly. Default-off → byte-identical render. Keep-22-scroll-only (faux running water) deferred to the 1070 eye-test (needs a 2nd mask). Needs the wasm rebuild only if not already built (JS-only shader change — no Rust). | apps/holtburger-web/scene3d/terrain.js |
| ~~`regionHeightTable`~~ ✅ **DONE — INTEGRATED always-on 2026-06-10 (safe-by-construction: no-op on stock Dereth, correct on modded; not separately eye-tested because it's a verified no-op on our data).** lib.rs gate removed (`resolve_region_land_height_table` always resolves, falls back to `byte×2`); live after batched rebuild. | — | F12-4: decode terrain vertex heights through the region's `LandHeightTable` (Region 0x13000000 `LandDefs.land_height_table`) instead of the hardcoded `byte * 2.0`, in the render mesh + subdivided-mesh + walk paths (all flow through `CellLandblock::get_height_with_table` / `build_mesh`). No-op on retail data (the retail table IS `byte * 2.0`), so flipping it on for stock Dereth is identical; the divergence only appears on a custom/modded region DAT, where the old `*2` made render + walk heights drift from the scenery bake (which already used the table) and from server physics — world-scale floating/buried geometry. Falls back to `*2` when the Region isn't cached. dat-side `decode_land_height` is now the single shared decoder (bake routed through it too). Needs the wasm rebuild. Default-off pending 1070 eye-test. | apps/holtburger-web/src/lib.rs + crates/holtburger-dat/src/landblock.rs |
| ~~`spawnHiddenState`~~ ✅ **DONE — eye-test PASSED 2026-06-10, INTEGRATED always-on** (lib.rs `spawn_hidden_state_on = true`; live after batched rebuild) | — | F16-5: honor spawn-time `PhysicsState` HIDDEN/NO_DRAW/CLOAKED at the 3D spawn. The wasm KIND_SPAWN carries no PhysicsState, so a player materializing nearby renders for the whole login-bubble window and NoDraw/Hidden server props render then pop out when the first SetState arrives. On → the ObjectCreate arm emits a kind=17 visibility:false alongside the spawn (mirrors `Entity::should_draw()` / the routed `upsert_entity_from_create` gate); since the rig builds async the event is queued in `_pendingVisibility` and applied on spawn, then ACE's later SetState (bubble pop / uncloak) reveals it via the existing path. Needs the wasm rebuild. Default-off pending 1070 eye-test. | apps/holtburger-web/src/lib.rs + scene3d/entities.js |
| `wieldHandAttach` | `on` | off | FU-1: attach the in-session-equipped weapon/ammo to the wielder's hand/quiver instead of dropping it at the wielder origin (feet). ACE sends the EQUIPPING player NO fresh ObjectCreate for their own weapon (TrackEquippedObject returns for `wielder == this`), so the wielded-item index was only populated at login-CreateObject time — the session-equipped crossbow + quarrel were absent from `entityWieldedItems`. The Rust side now also folds the ParentEvent (0xF749) + UpdateObject (0xF7DB) Wielder/CurrentWieldedLocation transitions into the wielder index (pure additive, no behavior change). On the JS side, this flag (a) widens the flushWieldedDirty held-item gate to admit MissileAmmo (0x3700000→0x3F00000) and maps it to Quiver(5)/RightHand(1) when ParentLocation is omitted, and (b) makes attachChildToParent retry the holding-location resolve with Quiver(5)→RightHand(1) for an ammo child whose ParentEvent location was 0 (instead of mounting at the wielder root). Needs the wasm rebuild (new ParentEvent/UpdateObject index folds). Default-off pending 1070 eye-test. | apps/holtburger-web/src/lib.rs + scene3d/index.js + scene3d/entities.js |
| `castAxes` | `on` | off | Debug: visualize cast projection axes. | scene3d/loop.js:158 |
| `projectileArc` | `on` | off | Debug: visualize projectile arcs. | scene3d/spell_shape_preview.js |
| `rain` / `snow` / `lightning` | `on`/`off` | weather-driven | Force weather state (overrides server). | scene3d/weather/manager.js:44–50 |
| `thunderDid` | hex/int | 0 | Thunder PhysicsScript sound DID override. | scene3d/weather/manager.js:53 |
| `nameplateRange` | float >0 | ~4000 | Max nameplate render distance. | scene3d/nameplate_sprite.js:236 |
| `nameplateMax` | int >0 | ~500 | Max simultaneous nameplates. | scene3d/nameplate_sprite.js:244 |

---

## 4. Dev / debug / perf flags

| Flag | Values | Default | Effect | Where |
|---|---|---|---|---|
| `diag` | `1` | off | Diagnostics overlay (perf/mem/frame times). | scene3d/index.js:291 |
| `debug` | `1` | off | Debug overlay + debug features. | plugins/debug-overlay.js:20 |
| `dev` | present | off | Plugin developer mode. | plugins/loader.js:717 |
| `nullRender` | `1` | off | Disable all GPU rendering (CPU profiling). | scene3d/index.js:371 |
| `renderOnDemand` | `1` | off | Render only on scene change. | scene3d/index.js:321 |
| `targetFps` | float ≤240 | 0 (uncapped) | Cap render fps. | scene3d/index.js:313 |
| `netDrainHz` | float ≤60 | 0 (realtime) | Throttle network message drain. | scene3d/index.js:351 |
| `spawnTrace` | `1` | off | Log entity spawn stage timings. | scene3d/entities.js:22 |
| `spawnDefer2dOnly` | `on` | off | A15-Q1: under `?renderer=3d` the 2D `liveScene` is PERMANENTLY null, so every KIND_SPAWN was cloned into the 2D `deferredSpawns` queue that nothing ever drains (the 3D EntityManager already handled the spawn). On → skip that 2D spawn-defer push entirely in 3D mode (pure leak fix; off = legacy unconditional push, still ring-capped). The companion ring-caps on `deferredSpawns` + `__scene3dEntityBacklog` (keep-latest-512, one-time overflow warn) are unconditional — no flag. JS-live. | index.html (drain loop + bufferingHook) |
| `unifiedClone` | `on` | off | A15-Q2: the wasm `EntityUpdate` field schema was hand-copied ~5× across the two renderer paths (`toMeta` in scene3d/loop.js; `__scene3dCloneEntityUpdate` + `cloneEntitySpawn` in index.html). On → all three defer to one shared pure-function schema (`scene3d/entity_update_clone.js#cloneEntityUpdate`), a strict superset that ALSO carries `isAutonomous` / `physicsTranslucency` / `motionSpeed` — fields the live 3D dispatcher reads but the legacy backlog clone silently dropped (replayed motions misclassified as server-FORCED; translucency/speed lost on backlog-replayed spawns). Off = legacy per-site clones. JS-live. Headless test: `test_a15_q2_entity_update_clone.mjs`. | scene3d/loop.js#toMeta + index.html (backlog/deferred-spawn clones) + scene3d/entity_update_clone.js |
| `frustumCull` | `off` to disable | **on** | Frustum culling (recent perf pass). | scene3d/culling.js:97 |
| `cullTerrain` | `on` | off | Terrain culling. | scene3d/culling.js:98 |
| `cullDist` | float | default | Culling distance override. | scene3d/culling.js:99 |
| `dynLod` (render) | see §3 | off | Distance-LOD render pass (recent perf pass). | scene3d/entities.js:376 |
| `frameBudget` | float ms | 16.67 | Per-frame async work budget. | scene3d/materials.js:1037 |
| `deferHz` | float | 60 | Deferred work scheduling rate. | scene3d/materials.js:1049 |
| `ringRadius` / `staticsRadius` / `buildingsRadius` | int | 6 | Bake/load ring radii (LB count). | scene3d/index.js:118–166 |
| `agentic` | `low` | per-GPU | Lower-LOD strategy for agent tests. | scene3d/index.js:123 |
| `lbCap` | int | small | Landblock LRU cache size. | scene3d/index.js:3218 |
| `lbLruDebug` | `1` | off | Debug LRU evictions. | scene3d/index.js:3220 |
| `animCacheMax` | int | default | Animation cache size. | scene3d/index.js:330 |
| `eagerDungeons` | `on` | off | Eager-load dungeon LBs. | scene3d/index.js:1244 |
| `preloadIcons` | `1` | off | Pre-fetch all UI icons at boot. | scene3d/index.js:3744 |
| `profileStatics` | `1` | off | Profile static-geometry baking. | scene3d/statics.js:1528 |
| `noStaticsTimeSlice` | `1` | timesliced | Disable static-bake timeslicing. | scene3d/statics.js:1296 |
| `envcellFusion` | `1` | off | EnvCell fusion optimization. | scene3d/statics.js:140 |
| `noEnvcellTimeSlice` | `1` | timesliced | Disable envcell-load timeslicing. | scene3d/statics.js:161 |
| `bakeWorker` | present | off | Use a web worker for static-mesh baking. | scene3d/bake_worker_client.js:25 |
| `shadowStaticGate` / `lightSortInterval` / `shadowMaxStale` | int | default | Shadow/light raster perf levers (recent perf pass). | scene3d/lighting.js:481–494 |
| `csmCamEps` / `csmSunEps` | float | default | CSM epsilon debug knobs. | scene3d/lighting.js:517–519 |
| `spawns` | csv DIDs | per-DAT | Override debug spawn DIDs. | scene3d/spawns.js:99 |
| `wireframe` | `1` | off | (also in §2) wireframe. | scene3d/index.js:277 |
| `retailParity` | `1` | off | Retail-parity UI (spellbook: no 7-bar tab). | plugins/spellbook.js:891 |
| `cellBugParity` | `retail` | off | Keep indoor cells visible from outdoors (retail bug). | scene3d/cells.js:54 |
| `radarHostileOnly` | `1` | off | Radar shows hostiles only. | plugins/radar.js:54 |
| `chatFade` | `1`/`0` | auto | Force chat panel fade. | plugins/chat-panel.js:500 |
| `nohealth` | `1` | on | Disable health/vitals system. | index.html:1907 |

---

## 5. Login / connection / automation flags (index.html)

| Flag | Values | Default | Effect | Where |
|---|---|---|---|---|
| `autoLogin` | `1` | off | Run the autonomous Connect+Spawn orchestrator. | index.html:556, ~7758 |
| `account` | string | localStorage/empty | Account name (URL overrides localStorage). | index.html:7598 |
| `password` | string | empty (never persisted) | Account password. | index.html:7599 |
| `autoSpawn` | `first`\|`Name`\|`0` | first | Spawn first / named char, or `0` = stop at char list. | index.html:10585 |
| `bridge_url` | ws/wss URL | `ws://127.0.0.1:8080/` | **wsbridge WebSocket URL — set to `wss://<host>/wsbridge` for remote.** | index.html:7612 |
| `server_host` | host/IP | 127.0.0.1 | ACE host (from the wsbridge's side). | index.html:7617 |
| `server_port` | int | 9000 | ACE port. | index.html:7622 |
| `kickDance` | `1`/`0` | 1 | Do (or skip) the first-Connect kick + wait. | index.html:10582 |
| `kickFirst` | `1` | off | Fire a throwaway Connect first to force ACE kick. | index.html:10625 |
| `maxRetries` | int | 3 | Auto-login retry attempts. | index.html:10597 |
| `connectTimeoutMs` | int | 5000 | Hung-Connect detection timeout. | index.html:10617 |
| `spawnTimeoutMs` | int | 10000 | Spawn timeout. | index.html:10618 |
| `kickWaitMs` | int | 3000 | Wait after kick before retry. | index.html:10619 |
| `charInWorldWaitMs` | int | 7000 | Extra wait when char still in-world (0x0D). | index.html:10624 |

`window.__runAutonomousLogin({...})` lets an agent re-trigger the orchestrator with
the same option names. Poll `window.__bootState` for progress
(`form-shown` → `char-list-ready` → in-world).

---

## 6. Compile-time movement / physics flags (Rust `const`, NOT URL-toggleable)

These are `const … : bool` gates in
`crates/holtburger-core/src/client/movement/system.rs` (top of file). They are
**not** `?query` flags — flipping one means editing the source and **rebuilding
the wasm** (`wasm-pack build …` on the buildbox), then a fresh page load. They
exist for A/B parity work; the **default-off** ones are awaiting a 1070 gait
eye-test before being flipped on. Line numbers drift — grep the const name.
(ACE/retail anchors live in each const's doc comment.)

| Const | Default | Effect | Bughunt |
|---|---|---|---|
| `USE_QUANTUM_SUBDIVIDED_INTEGRATION` | **on** | Subdivide a large frame `dt` into bounded [1/30, 0.1] s slices (2nd-order integration; no frame-hitch over-integration). | — |
| `USE_STEP_UP_DOWN` | **on** | Retail StepUp/StepDown — climb risers ≤0.6 m, follow drops ≤1.5 m down (outdoor terrain **and** indoor per-poly floor); else the legacy 0.5 m ledge heuristic. | F4-1 (indoor half) |
| `USE_EDGE_SLIDE` | **on** | Slide the blocked residual along the wall tangent when a refused step-up would otherwise stop dead (Stage-1 single-plane). | — |
| `USE_PRECIPICE_SLIDE_REENTRY` | off | Save/clear the pre-descent backup pose for a precipice-slide re-attempt. Bookkeeping only — the consumer is deferred, so flipping it on is still inert. | — |
| `USE_CLIFF_SLIDE` | off | Stage-2 seam skid (`N_new × N_last`) where two non-coplanar walls meet; else the Stage-1 single-plane slide. | — |
| `USE_AUTONOMOUS_POSITION_CHANGE_GATE` | **on** | Only emit the AutonomousPosition heartbeat on a meaningful pose change (cell / origin / heading / contact), not unconditionally. | — |
| `USE_RETAIL_GROUND_FRICTION` | off | Use retail ground-friction `0.95` vs the hand-tuned `0.5`; A/B only (interacts with the accel cap). | — |
| `USE_INTERPRETED_VELOCITY` | off | **STAGE 1 unified movement pipeline (2026-06-11)** — absorbs and retires `USE_DIRECT_GROUND_VELOCITY` (F1-1). Grounded target velocity comes from the CMotionInterp port (raw → interpreted → authored cycle base × speed_mod, run-rate input = wire Run skill exactly as ACE composes it) and is direct-set each slice (no friction/accel-cap ramp): fixes the 1-2 m run snapback, removes the ~11.7 m/s ceiling (18 m/s reachable), kills the ice-skating ramp + stop-skid. `crates/holtburger-core/src/client/movement/system.rs` + `movement/motion_interp.rs`; design `docs/2026-06-11-unified-movement-pipeline/DESIGN.md`. | **F1-1**, snapback |
| `USE_TERRAIN_WALKABLE_GATE` | off | **NEW.** Refuse to walk up outdoor terrain steeper than `FloorZ` (~48.4°): an uphill step onto a non-walkable face reverts to the slice-entry XY + skips the up-snap (can't run up cliffs). Uses `WorldState::terrain_normal_at`. | **F4-2** |
| `USE_RAMP_FLOOR_SNAP_FIX` | **on** | Indoor up-snap only to a real per-poly floor; the cell AABB `min.z` is a last-resort lower bound, never an up-snap target (no ramp floor-pop). | — |
| `USE_PHYSICS_BSP` | off | Faithful physics-BSP narrow-phase indoor wall test after the flat-tri clamp (`?bspCollide` equivalent). | — |
| `USE_STATIC_BSP` | off | Per-static physics-BSP push-out after the coarse-AABB sweep (B4 Tier-2). | — |
| `USE_LOCAL_ENVCELL_ENTRY` | **on** | Client-side EnvCell entry from terrain (kill-switch restores the server-only transition). | — |
| `USE_OUTDOOR_WALL_NORMALS` | off | Surface outdoor building wall normals so the refused-step-up slide + seam-skid fire outdoors too. | — |
| `DEFER_LOGIN_COMPLETE_AFTER_TELEPORT` | off | **NEW.** Network-sequencing (not physics), so it lives in `client/mod.rs`, not `movement/system.rs`. Defers the post-teleport `LoginComplete` (`0x00A1`) from the instant `PlayerTeleport` (`0xF751`) arrives to the first post-teleport local-player `UpdatePosition` (the destination pose). `LoginComplete` clears ACE's `Teleporting` flag (`GameActionLoginComplete` → `OnTeleportComplete`); sending it before the destination pose is applied lets ACE accept AutonomousPosition from the **source** landblock (the desync ACE flags at `Player_Tick.cs:416`). Matches retail (`acclient.c CPlayerSystem::SendLoginCompleteNotification @ 0x562E90` never sends from the teleport message). Applies to **both** recv loops (cli `messages.rs` + wasm `lib.rs`). | **F2-3** |

> Three flags introduced in the 2026-06-09 movement bughunt — `USE_INTERPRETED_VELOCITY` (F1-1 + the 2026-06-11 stage-1 snapback fix; formerly `USE_DIRECT_GROUND_VELOCITY`), `USE_TERRAIN_WALKABLE_GATE` (F4-2), and `DEFER_LOGIN_COMPLETE_AFTER_TELEPORT` (F2-3) — are default-off pending the 1070 gait/teleport eye-test; flip them `true` and rebuild to validate, then default them on if they read correctly. (F2-3 lives in `client/mod.rs`, not `movement/system.rs`.)

---

## Possible hardening (not yet implemented)

The remote-bridge failure above is a footgun: omit `bridge_url` and it silently
falls back to localhost. A robust default would be, in the `bridge_url` prefill
(index.html ~7612): when no param is given **and** the page is served over
`https:` on a non-loopback host, default the form to
`` `wss://${location.host}/wsbridge` `` (and `server_host`/`server_port` likewise
when behind the combined proxy). Then a bare remote URL "just works" and only
explicit overrides need the param. Low-risk; takes effect on next page load (the
service worker does not cache `index.html`).

---

## Bughunt-86 combat/render/mechanics loop list (2026-06-09)

The partial Fable bughunt (`~/out/movement-combat-render-bughunt-2026-06-09.raw.json`,
86 findings) had its 25 movement findings triaged in `~/out/remaining.md`; the other
57 (combat / render / mechanics / anim / crosscut) are triaged into a loop list at
**`~/out/bughunt86-combat-render-loop-items-2026-06-09.md`** — ordered CODE-only first
(13 doable with NO 1070), then MIXED (30), then VISUAL (14, 1070-gated). Cross-checked
against done work (F18-1=SG-D, F17-1=portal-space, all movement). New flags from
implementing those items get documented in the table below as they ship.

## Pending 1070 validation — self-guid `/loop` session (2026-06-09) · knock out in ONE sitting

Everything below was landed default-safe (one URL flag; the rest additive
dispatch). **Only `?forceMotionLocal=on` is an actual URL flag** — the rest have
no flag and are live behavior once their layer is loaded. Grouped so a single
wasm rebuild + one session covers them all.

**Step 0 — one-time prerequisite (makes ALL the Rust changes live):**
`export PATH="$HOME/.cargo/bin:$PATH" && capped-build wasm-pack build --target web --out-dir pkg --release` (on the buildbox; ~1m30s) → pull `pkg/` → bump the `?v=wave-…` cache-bust in `index.html` (2 spots, ~lines 947 + 1234). JS-only changes (SG-D, all the JS dispatch arms, the board/chat handlers) are already live on reload; the Rust ClientEvent EMISSIONS are inert until this rebuild.

| # | Change (commit) | Flag | How to eye/ear-test on 1070 | Pass criteria |
|---|-----------------|------|-----------------------------|---------------|
| 1 | **SG-B** server-forced motion (`766834c7`) | **`?forceMotionLocal=on`** (default off) | Admin `@motion`/force-sit (or paralysis/forced-emote) on your char | The forced pose plays on YOUR avatar; routine running still loops smoothly (NO rubber-band / B9 regression). If clean, consider default-on. |
| 2 | **SG-D** APPEARANCE/ATTACH live dispatch (`2408d261`) | none (JS live on reload) | Equip/dye an item; wield a weapon | Your in-world avatar re-skins (gear/dye) and the weapon attaches; **watch for local-rig flicker on equip** during normal play (if bad, enable `?clothingHotSwap=1`). Remote players also re-skin. |
| 3 | **SG-C1** chess board (`d39a296d`) | none | At a drudge-chess board: join + watch a game | `window.__chess` Map populates; `[chess]` console logs per event; `chessUpdate` bus event fires. |
| 4 | **SG-C2** salvage (`89d64ab3`) | none | Salvage items with an Ust | `[salvage]` console log + `salvageResult` bus event with the per-material yield. (InscriptionResponse is deprecated — won't fire; expected.) |
| 5 | **SG-C3** UI events (`83c23995`) | none | `/age <name>`; open the barber; trigger available-houses / channel list | `/age` → an age line in chat; barber/houses/channels → `[uiEvent …]` console + `uiEvent` bus event. |
| 6 | **SG-E** fellowship chat (`654599ec`) | none | Join / leave / quit / get-dismissed from a fellowship | "You left/joined the fellowship." + member join/leave notices appear in the chat log (Fellowship category). |

**No observable test (latent, land-and-forget):** SG-A1 (`62ee171e`) — `physics_script_table_did` self-seed field/index coherence; no live consumer reads the entity field today, so nothing to eye-test (correctness only).

Full per-item detail + ACE wire refs: `~/out/self-guid-loop-handoff-2026-06-09.md`.

### Also pending from the same day — motion + render audit batch (`3756fd85`)

The "surface unsurfaced motion + render behaviors" audit (commit `3756fd85`)
landed a batch of motion/render fixes the same day, each default-safe and
pending the SAME 1070 sitting. Most are JS (live on reload); the
`player/types.rs` motion-command expander is Rust (covered by the Step-0 rebuild
above). Default-OFF flags to flip ON and test:

| Flag | What it does | Eye-test | Pass criteria |
|------|--------------|----------|---------------|
| **`?idleFidget=on`** | Standing creatures/NPCs/players play random idle gestures instead of freezing in one idle loop (JS-only; uses `lookupMotionLinkForSwing` to probe the MT, so no-ops on MTs without the clip). | Stand near an NPC/creature ~6–15 s | It plays an occasional fidget (nod / shrug / scratch-head / etc.); never stacks on a real motion; no stuck pose. |
| ~~`?playEffectQueue=on`~~ ✅ **DONE — eye-test PASSED 2026-06-10, INTEGRATED always-on** (play_effect_vfx.js `PLAY_EFFECT_QUEUE_ON = true`; JS, live on reload). PlayEffect (0xF755) fresh-spawn cast/buff VFX that were dropped when the entity's cell wasn't resolved yet (cell==0) are queued + replayed on ObjectCreate. | — | The cast/buff flash now plays on the fresh entity (was silently dropped). |
| **`?mtClassFallback=on`** | Safety-net: a motion command not in the two hand-synced allow-lists still dispatches via its class-mask (so rare emotes/specials animate). | Observe creatures/NPCs with unusual one-shot motions (special attacks, social emotes) | Previously-frozen rare motions now animate; no regression on common gait. |
| ~~`?runtimeObjScale=on`~~ ✅ **DONE — eye-test PASSED 2026-06-10 (`@objscale 2.0/0.5` grows/shrinks the rig live; ACE got a new `@objscale` dev command for this). INTEGRATED always-on (entities.js `RUNTIME_OBJSCALE_ON = true`; JS, live on reload).** Apply a runtime obj_scale (grow/shrink) or TRANSLUCENCY (ghost/cloak) carried by a mid-game UpdateObject (0xF7DB) to the rig. | — | Rig re-scales / goes translucent on the grow/ghost; a subsequent equip/dye does NOT reset it (sentinel check). |
| ~~`?spawnMotionState=on`~~ ✅ **DONE — eye-test PASSED 2026-06-10, INTEGRATED always-on** (lib.rs `spawn_motion_state_on = true`; gate removed; live after the batched wasm rebuild). Seed the 3D SPAWN pose from the object's CURRENT motion state (ObjectCreate `movement_data`) instead of always Ready — so an already-open door / posed creature entering vision renders in its current pose. | (was) walk up to an ALREADY-OPEN door | The door renders OPEN on spawn (not snapped shut then opening). Also: a sitting/posed NPC spawns in its pose. |
| `?forceMotionLocal=on` | (same as row 1 of the table above — SG-B) | — | — |

Render features from the same audit were flipped **default-ON (opt-out `=off`)** —
`terrainDetailTex` / `terrainMod` / `lightClamp` / `cycleOmega` / `skyObjLum` /
`texMerge` / fog gate — so they're already live; append `&<flag>=off` to A/B them
against the prior look if anything seems off. Also always-on in `3756fd85`:
MagicRecoilMissile 0x0033 cast routing, SoundTriggered acToThree pan fix, FallDown
link routing, CMT remote-swing double-play dedup. Detail:
`~/out/holtburger-{motion-dispatch-coverage,unsurfaced-render-audit}-2026-06-09.md`
and memory `project_audit_fixes_staged_2026-06-09`.

### 2026-06-11 — wielded-item spawn pipeline (wasm + JS pair)

| Flag | What it does | Eye-test | Pass criteria |
|------|--------------|----------|---------------|
| **`?wieldedSpawn=on`** | A wielded item with no world presence finally renders in-hand. Wasm: (a) pack→wield — ParentEvent synthesizes the missing KIND_SPAWN from the cached world entity (its only ObjectCreate was culled by `skip_contained_spawn`; ACE never re-sends CreateObject to the equipping player) before the kind=7 attach; (b) login-wielded — emit the kind=7 attach from the ObjectCreate PhysicsDesc `parent_id`/`parent_loc` (ACE sends the owner no ParentEvent at login). Live-rig ledger prevents double-spawn for ground-pickup→wield / re-equip. JS: a freshly-committed rig whose own attach is parked in `_pendingAttach` spawns state-hidden so it never flashes at the wielder's feet before the async hand-mount lands. NOTE: synthesized spawns are lossy — base weapon look only (entity cache keeps Setup/MTable/STable DIDs + scale, not ObjDesc palette/texture swaps). Needs a wasm rebuild. | Log in with a weapon already wielded; also unwield to pack, then wield from pack (e.g. the Cestus repro) | Weapon mesh appears in the hand in both cases (tracks the hand through animation); no weapon ghost at LB 0 / the player's feet; drop-to-ground after wield still renders the item on the ground; no double mesh after ground-pickup→wield. |

### 2026-06-11 — projectile gravity arc (wasm + JS pair, grind-loop G-4)

| Flag | What it does | Eye-test | Pass criteria |
|------|--------------|----------|---------------|
| **`?projectileGravity=on`** | Gravity-class projectiles (arrows/bolts/thrown — ObjectCreate PhysicsState carried GRAVITY 0x400 alongside MISSILE 0x40) fly a ballistic ARC instead of constant velocity: the JS ballistic integrator applies -9.8 z″ (ACE PhysicsGlobals) to the seeded launch velocity each frame, semi-implicit Euler. War-magic bolts (no GRAVITY bit) stay flat — retail-correct. Wasm: `PROJECTILE_GRAVITY_GUIDS` thread_local populated on the MISSILE+GRAVITY ObjectCreate, read via new `SessionHandle.entityProjectileHasGravity` (manifest v2; JS soft-guards so a stale pkg/ degrades to flat flight). Needs a wasm rebuild to take effect. | Have an archer monster (e.g. Drudge Slinger) shoot you from range; also fire a bow/thrown weapon | Arrow/bolt visibly arcs (rises then falls) along the flight; war-magic bolts still fly flat; impact still lands near the target (no ground-plow mid-flight on short shots); flag off = byte-identical flat flight. |

### 2026-06-11 — TurnTo retail turn rate (JS-only, grind-loop G-5)

| Flag | What it does | Eye-test | Pass criteria |
|------|--------------|----------|---------------|
| **`?turnOmega=on`** | Rate-limits the KIND_TURN (TurnToHeading/TurnToObject) heading slerp to retail's turn rate (base 3 rad/s × the wire MoveToParameters.speed, forwarded on the KIND_TURN omega_z hint) instead of the fixed exponential K that whips a 180° emote-turn around in ~0.2 s. Applies ONLY to turn-directive targets — KIND_POSITION heading smoothing keeps its existing fixed-K feel (the cap is cleared the moment a position update re-owns the target, and on settle). Tune the base with `?turnOmegaBase=<rad/s>`. JS-only, live on reload. | Talk to / stand behind an NPC so it TurnTo-faces you (e.g. Academy NPCs); watch an idle monster turn-in-place | NPC sweeps to face you at a believable constant rate (~1 s for 180°) instead of snapping around; moving monsters' heading smoothing unchanged; flag off = byte-identical. |

### 2026-06-11 — StandingLongJump charge (wasm + JS pair, grind-loop G-7)

| Flag | What it does | Eye-test | Pass criteria |
|------|--------------|----------|---------------|
| **`?longJump=on`** | Retail StandingLongJump (F1-6). A space charge that begins from a grounded STANDSTILL sets `PlayerState.standing_long_jump_charge` via new `SessionHandle.jumpChargeBegin` (manifest v2; typeof-guarded): while held, the manual integrator is ROOTED (turn-only — DoInterpretedMotion's StandingLongJump branch) and the MoveToState contact byte carries bit 0x2 so ACE's broadcast excludes Forward/Sidestep for observers. At release the launch planar velocity comes from the interpreted INTENT (`get_leave_ground_velocity = get_state_velocity()`) — hold W at release for a full-speed forward long jump from standing. Charge drops on movement-keydown during charge / blur / refused release (`jumpChargeCancel`), jump dispatch, and touchdown/teleport (`land()`). Needs a wasm rebuild. | Stand still, hold space ~1 s, then press+hold W and release space; compare vs charging while already running | Standing charge roots you in place (can still turn); release with W held launches a full forward arc (not a vertical hop); moving jump unchanged; observers (second client) don't see a "buggy shallow arc"; flag off = byte-identical. |
