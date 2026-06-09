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
| `terrainMod` | `on`/`off` | **on** | Terrain colour modulation (Ice/Road; dead-in-retail). (default-ON 2026-06-09, opt-out =off, pending 1070 eye-test) | scene3d/index.js:2084 |
| `terrainModSatHue` | float | default | Terrain mod saturation/hue shift. | scene3d/index.js:2103 |
| `terrainPalette` / `terrainDetailTex` / `texMerge` | string | default | Terrain texture/palette/merge overrides. (`terrainDetailTex`, `texMerge` default-ON 2026-06-09, opt-out =off, pending 1070 eye-test) | scene3d/index.js:2120–2156 |
| `textureScale` | float | 1.0 | Global texture downscale. | scene3d/index.js:458 |
| `atlasTilePx` | int | 512/platform | Material atlas tile size. | scene3d/index.js:467 |
| `wireframe` | `1` | off | Wireframe rendering. | scene3d/index.js:277; entities.js:10 |
| `lightClamp` / `flatDiffuse` | float | default | Debug shading overrides. (`lightClamp` default-ON 2026-06-09, opt-out =off, pending 1070 eye-test) | scene3d/materials.js:988–1006 |
| `particleSortObjects` | `off` to disable | on | Particle sort by scene objects vs camera. | scene3d/particles/particle_manager.js:40 |

---

## 3. Gameplay / movement / entity flags

| Flag | Values | Default | Effect | Where |
|---|---|---|---|---|
| `velScale` | `off` to disable | **on** (since 2026-06-05) | Velocity-scaled locomotion cycle (anti-ice-skating). | scene3d/entities.js:337 |
| `deadReckon` | `off` to disable | on | Remote-entity motion smoothing / dead-reckoning. | scene3d/entities.js:55 |
| `headingSnap` | `on` | off | Instant heading vs eased rotation (legacy). | scene3d/entities.js:74 |
| `headingEaseK` | float >0 | conservative | Heading ease-in damping rate. | scene3d/entities.js:86 |
| `cycleOmega` | `on`/`off` | **on** | Apply cycle-authored angular velocity (spinners). (default-ON 2026-06-09, opt-out =off, pending 1070 eye-test) | scene3d/entities.js:358 |
| `mtClassFallback` | `on` | off | Stage-1 generic class-mask motion-dispatch fallback — surfaces unmatched MT-modeled commands on the forward path (no-op if the MT lacks the clip). | scene3d/entities.js |
| `idleFidget` | `on` | off | Autonomous client-side idle-fidget/idle-variation cycling so standing entities are not frozen in one Ready idle. | scene3d/entities.js |
| `forceMotionLocal` | `on` | off | Apply server-forced NON-locomotion motions (sit/sleep/paralysis/forced emote) to the local player instead of skipping them. | scene3d/loop.js |
| `dynLod` | `on` | off | Dynamic entity LOD despawn/respawn with distance. | scene3d/entities.js:376 |
| `sortCenter` | `on` | off | Transparency sort via AC authored sort-centers. | scene3d/entities.js:113 |
| `maxTickDist` | float | ~2000 | Max distance for entity anim/AI ticking. | scene3d/entities.js:795 |
| `entitySmoothStride` | int | default | Entity frame-blend stride. | scene3d/entities.js:820 |
| `gaitHz` | float >0 | ~1.0 | Locomotion cycle playback frequency. | scene3d/entities.js:846 |
| `entityLights` | `on` | off | Entity-attached dynamic lights (SetLight hook 25). | scene3d/entities.js:35 |
| `multiAction` | `on` | off | Allow concurrent combat actions. | scene3d/loop.js:99 |
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
| `USE_DIRECT_GROUND_VELOCITY` | off | **NEW.** Retail direct-set of the grounded planar velocity (no friction/accel-cap ramp) — removes the ~11.7 m/s steady-state ceiling so high-Run chars reach 18 m/s, and kills the ice-skating ramp + stop-skid + anim foot-slide. | **F1-1** |
| `USE_TERRAIN_WALKABLE_GATE` | off | **NEW.** Refuse to walk up outdoor terrain steeper than `FloorZ` (~48.4°): an uphill step onto a non-walkable face reverts to the slice-entry XY + skips the up-snap (can't run up cliffs). Uses `WorldState::terrain_normal_at`. | **F4-2** |
| `USE_RAMP_FLOOR_SNAP_FIX` | **on** | Indoor up-snap only to a real per-poly floor; the cell AABB `min.z` is a last-resort lower bound, never an up-snap target (no ramp floor-pop). | — |
| `USE_PHYSICS_BSP` | off | Faithful physics-BSP narrow-phase indoor wall test after the flat-tri clamp (`?bspCollide` equivalent). | — |
| `USE_STATIC_BSP` | off | Per-static physics-BSP push-out after the coarse-AABB sweep (B4 Tier-2). | — |
| `USE_LOCAL_ENVCELL_ENTRY` | **on** | Client-side EnvCell entry from terrain (kill-switch restores the server-only transition). | — |
| `USE_OUTDOOR_WALL_NORMALS` | off | Surface outdoor building wall normals so the refused-step-up slide + seam-skid fire outdoors too. | — |

> Two flags introduced in the 2026-06-09 movement bughunt — `USE_DIRECT_GROUND_VELOCITY` (F1-1) and `USE_TERRAIN_WALKABLE_GATE` (F4-2) — are default-off pending the 1070 gait eye-test; flip both `true` and rebuild to validate, then default them on if they read correctly.

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
