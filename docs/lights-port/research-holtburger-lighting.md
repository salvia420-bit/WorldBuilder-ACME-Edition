# holtburger-web lighting system — research for the AcmeLights port

> Explore-agent research report, 2026-08-22. Raw findings with file:line / symbol citations.

I have the material I need. Delivering the final report now.

# holtburger-web LIGHTING — complete map for a native D3D port

All paths relative to `/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web` unless noted. Rust crates at `../../crates`.

## Central files (the whole system, in priority order)

| File | Role |
|---|---|
| `scene3d/lighting.js` (2672 lines) | **THE** light-management file. Sun/ambient/hemisphere setup, the fixed light POOL, all selection algorithms, `SetupLight`→THREE conversion, shadow gate, CSM tick, release/eviction. |
| `scene3d/atmosphere_lights.js` (317) | The *real* sun: takram `SunDirectionalLight` + `SkyLightProbe`, driven by AC `SkyState` (dirBright/dirColor/ambBright). Indoor mute. |
| `scene3d/materials.js` (6426) | Shader-side light response: `?lightClamp=retail` (linear falloff + per-channel clamp + half-Lambert), the `acBakedLight` vertex-bake emissive-add, CSM sample patch, luminosity→emissive. |
| `scene3d/csm.js` (750) | 3 cascade DirectionalLights (shadow-only, intensity 0). |
| `src/vertex_bake.rs` (401) | Rust port of retail `calc_point_light` / `SetStaticLightingVertexColors` — the EnvCell static-light BAKE. |
| `src/lib.rs` ~15770–16010, ~21348–21420 | wasm bridge: `SetupLight`, `SetupModelLights`, `fetchSetupModelLights`, `collect_setup_model_lights`, `collect_landblock_bake_lights`. |
| `crates/holtburger-dat/src/file_type/setup_model.rs:29-36` | `LightInfo` DAT struct. |
| `scene3d/vfx/components/flameFlicker.js` (234) | Torch flicker (intensity-only). |
| `scene3d/sky_lighting.js`, `scene3d/night_ramp.js`, `scene3d/ibl_environment.js` | SkyState cache; night ramp (indirect-only dim); IBL env. |
| `scene3d/entities.js` ~12010–12135, ~16420–16472 | Entity SetLight (hook 25) lights. |
| `scene3d/landblock_lru.js:1767-1790`, `:2148` | Light eviction (inlined splice/detach/dispose, no import — cycle avoidance). |

---

# 1. LIGHT SOURCES

## 1.1 DAT-driven placed lights (the ONLY real light source in the client)

**DAT struct** — `crates/holtburger-dat/src/file_type/setup_model.rs:29-36`:
```rust
pub struct LightInfo {
    pub viewer_space_location: Frame, // origin xyz + orientation quat (w,x,y,z)
    pub color: u32,        // 0xAARRGGBB, alpha ignored
    pub intensity: f32,
    pub falloff: f32,
    pub cone_angle: f32,
}
```
Stored as `SetupModel.lights: HashMap<i32, LightInfo>` (`setup_model.rs:345`, read at `:443-448`). **The HashMap key IS the Setup part index the light rigidly attaches to.**

**wasm API** (module-level free functions, NOT SessionHandle methods):
- `fetchSetupModelLights(setupId: u32) -> Promise<SetupModelLights>` — `src/lib.rs:15903-15921`
- `SetupModelLights.partCount` (= light count, not part count) — `lib.rs:15880`
- `SetupModelLights.takeLights() -> Vec<SetupLight>` (one-shot drain) — `lib.rs:15885`
- `SetupLight` getters: `partIndex, x, y, z, colorR, colorG, colorB, intensity, falloff, coneAngle, qx, qy, qz, qw` — `lib.rs:15825-15857`
- Pure helper `collect_setup_model_lights` — `lib.rs:15939-16005`. Short-circuits: `(setup_id >> 24) != 0x02` → empty (raw 0x01 GfxObjs have no Setup). ARGB unpack `R=(c>>16)&0xFF /255` etc. at `lib.rs:15990-15993`. Sorted by part index for determinism (`:15984`).

The only `SessionHandle` methods the lighting tick uses: `isCurrentCellIndoor()`, `isCurrentCellSeenOutside()`, `getRenderSet(1)`, `getSkyState()` — `lighting.js:1068`, `:1088`, `:1671`, `sky_lighting.js:122`.

**Attachment to the scene graph** — `attachSetupModelLights(scene3d, wasmExports)`, `lighting.js:1966-2324`. Post-build scene-graph *pre-scan* (deliberately no wiring in buildings.js/statics.js/cells.js):

| Recorder | Source group | Part mapping | Stamp |
|---|---|---|---|
| `recordBuildingTree` `lighting.js:2033` | `scene3d.buildingsGroup` → placementGroup(`userData.modelId`) → `part-N` hinge wrappers | `userData.partIndex` | `__lbKey` |
| `recordStatics` `:2076` | `scene3d.staticsGroup`, fused mesh = part 0 | 0 | `__lbKey` |
| `recordEntities` `:2099` | `entityManager.entityMap`, `inst.parts[i]` | i | none (owned by entities.js) |
| `recordCellStatics` `:2144` | `scene3d.cellsGroup` → cellContainer → mesh with `userData.isCellStatic` | 0 | `__lbKey` + **`__cellId`** |

Idempotency via `userData.__setupLightScanned` (`:2045`). Fetch all unique setup ids in parallel (`:2194`). One light instance PER PLACEMENT: first placement reuses the source light, subsequent ones go through the template cache (`getOrBuildLightTemplate` `:2368` / `createLightFromTemplate` `:2410`) to avoid `Object3D.clone()`. Every instance is pushed into `scene3d.activeLights` (`:2282`) and forced `visible=false` in pool mode (`:2281`).

Rescan on landblock stream-in: `index.js:3623 _rescanSetupLights()`, called at `index.js:3677, 4004, 4062`. Boot attach: `index.js:2109`.

**Conversion to THREE** — `makeThreeLightForSetupLight(sl)`, `lighting.js:2496-2644`:
- `coneAngle > 0` → `THREE.SpotLight(color, intensity, distance, coneAngle, 0.3, 2.0)` (`:2587`); else `THREE.PointLight(color, intensity, distance, 2.0)` (`:2621`).
- intensity = `clamp(intensity, 0, 120)` (`:2539`) — `LIGHT_INTENSITY_CLAMP = 120` (`:1014`). Census note at `:990-1013`: **all 608 SetupModel light tables in client_portal.dat have intensity min=20, p50=100, p90=100, max=100.**
- distance = `falloff * 1.3` (`STATIC_LIGHT_FACTOR`, `:1030`, applied ONCE at `:2560`). Rust surfaces RAW falloff so no double-multiply.
- color = `new THREE.Color().setRGB(r,g,b, THREE.SRGBColorSpace)` (`:2568`) — the DAT ARGB is sRGB-authored and must be decoded.
- `decay = LIGHT_DECAY = 2.0` (`:1021`), `penumbra = SPOTLIGHT_PENUMBRA = 0.3` (`:1020`).
- position set from AC part-local `(x,y,z)` verbatim (`:2628`) — parent part Object3D is under `worldRoot` which carries the AC-Z-up→three-Y-up rotation, so no transform needed.
- `userData = { fromSetupModelLight, setupLightOrigin:{x,y,z}, coneAngle, falloff, spotTargetLocal }` (`:2629`).
- `light.layers.enable(1)` = RENDER_LAYER_INDOOR so the light survives the `?portalPunch` indoor cells-pass camera mask (`:2642`, `:2466`).
- SpotLight aim from the orientation quat: AC forward is **+Y**, target = origin + `(0,1,0)·q` (`:2609-2617`). **DORMANT on shipped data** — see 1.5.

## 1.2 Torches / lanterns in hands, wall torches, braziers, campfires

**There is no special-cased code for any of these.** They are all the same mechanism: a static/cell-static/equipped-item **SetupModel with a `LightInfo` table**, found by the generic pre-scan above.

- Wall torches / braziers / candelabra in dungeons = **EnvCell static objects** (`stab` entries), found by `recordCellStatics` (`lighting.js:2144-2180`). **NOTE the RND-04 default: these are DROPPED from the live pool** (see §4) because their photons are baked into the cell mesh vertices.
- Held torches/lanterns on creatures/players = entity rig lights via `_attachEntityLights` — **default OFF** (`?entityLights=on`).
- Outdoor building/static lamps = `recordBuildingTree` / `recordStatics`, always live.

Authored values found in code (the only concrete DAT samples in-repo):

| Source | Color (ARGB) | Intensity | Falloff | Range (×1.3) |
|---|---|---|---|---|
| Cragstone meeting-hall lamp, Setup `0x020005D9` (`src/vertex_bake.rs:337-347`) | (255, 255, 150, 80) warm amber | 100 | (test uses 4.0) | 5.2 m |
| Census of ALL 608 setup light tables (`lighting.js:993-996`) | — | min 20 / p50 100 / p90 100 / max 100 | — | — |
| All 285 lights in 4 dat-dump venues (`lib.rs:21381-21388`) | — | — | — | **cone_angle uninitialised (bit pattern 0xE6666660 ≈ -2.3e23) → every shipped Setup light is a POINT light** |

## 1.3 Entity dynamic lights (SetLight hook 25) — `?entityLights=on`, default OFF

- Flag reader: `entities.js:151-159` (`readEntityLightsFlag`, exact-match `"on"`).
- Attach at spawn: `entities.js:12035-12134 _attachEntityLights(inst, setupId)`. Same `fetchSetupModelLights` + same `buildLightForSetupLight` constructor (`lighting.js:2653`) → identical color/intensity/falloff/cone math to statics.
- Lights start OFF: `light.intensity = 0; light.visible = false`, authored value stashed on `userData.__setupIntensity` (`entities.js:12109-12116`).
- Per-preset **creation** cap `ENTITY_LIGHT_CAP_BY_PRESET` (`entities.js:825-830`): `low: 0, mid: 8, high: 16, ultra: 24`, default 8. Logged once on hit (`:12348`).
- Hook 25 handler `entities.js:16432-16471`: `hook.lightsOn` (i32 bool) → restore/zero intensity. **In pool mode it drives intensity ONLY and never touches `.visible`** (`:16441-16454`) — that was the multi-second spell-cast freeze.
- Frustum-cull guardrail: a rig owning a light is never culled (`entities.js:2660-2690`, `:2771-2774`).
- Wire decode of hook 25 payload: `setup_model.rs:115` (`SetLight (_lights_on: i32)`).

## 1.4 Portals, war-spell projectiles, spell impacts, glowing creatures (Virindi/wisps/Shadows), campfires-as-VFX

**NONE of these create a light.** A repo-wide grep for `new THREE.PointLight|SpotLight|DirectionalLight|AmbientLight|HemisphereLight|LightProbe(` over `scene3d/` returns exactly:
- `lighting.js:204, 246, 255, 868, 876, 2413, 2422, 2587, 2621`
- `atmosphere_lights.js:155` (SkyLightProbe)
- `csm.js:223`
- `pool_prewarm.js:176` (offline shader-warm scene only, never in the render scene)

All portal swirl / spell projectile / impact / creature glow is **emissive material + additive sprite + bloom**, explicitly by design:
- `vfx/components/terrainSwampAmbient.js:58` "the wisp glow is an ADDITIVE SPRITE, never a PointLight"
- `vfx/components/terrainVolcanoEmbers.js:32`, `terrainDustDevil.js:23`, `vfx_flags.js:1163` — same statement.
- Luminosity→emissive path: `materials.js:1895-1903` and `:4570-4588` — `emissiveIntensity = min(2.0, sfLuminosity)`, `emissive = white`, `emissiveMap = mat.map` under `?luminousEmissiveMap` so a colored glow keeps its hue (`entities.js:6104-6113`).
- Animation hooks 8/9 (Luminous) drive `emissiveIntensity` at runtime — `entities.js:16589-16680`.
- Breath/impact effects are colored sprites, e.g. `play_effect_vfx.js:3385-3392` (`BreatheLightning` → `0xddeeff`, 300 ms).

**Port implication:** in D3D you get these "for free" as emissive/additive geometry; do not budget hardware light slots for them. If you *want* spell lights, they'd be new — the JS side has none.

## 1.5 PhysicsScripts / ParticleEmitters / render flags driving light data

- **No.** PhysicsScripts drive particle emitters only. `fetchSetupDefaultScript` (`lib.rs:16008+`) surfaces `SetupModel.default_script` (a `0x33` PhysicsScript DID) → CreateParticle chains; it never touches lights.
- The only render flag interacting with lights is the surface `luminosity` float (emissive, not a light) and the `layers` bit (RENDER_LAYER_INDOOR = 1).
- The VFX component registry **forbids** any component changing light count: `vfx/registry.js:48` — `lightCountDelta must be 0 (never change visible light count -> relink freeze)`. Only `writes: ["lightIntensity"]` is a legal light write (`registry.js:34`).

---

# 2. LIGHT MANAGEMENT — pool, budget, selection

## 2.1 The fixed pool (the "never change light count" rule)

Rationale — `lighting.js:544-602`. three.js bakes the per-type count of **visible** lights into every lit material's program cache key (`WebGLPrograms` numPointLights/numSpotLights; a `.visible=false` light is skipped in `projectObject` and NOT counted). Any change relinks every lit material. Measured: 4 wasps casting = **30.8 s main-thread freeze, +14 relinks, programs 37→51**; with the pool, program count is perfectly flat (`lighting.js:616-621`). Cross-check: `docs/2026-08-06-object-glue-census.md:386-388`.

Retail parity cited: D3D had **8 fixed hardware light slots** (`acclient.h FFLightEnable[8]`) and `SetLightHook` only toggled a state bit — the count never changed (`acclient.c:317037`).

**Allocation** — `allocateLightPool(lightsGroup, cfg)`, `lighting.js:864-894`, called from `setupSceneLighting` **before the first render** (`:260-267`):
```js
new THREE.PointLight(0xffffff, 0, 0, 2)   // visible=true FOREVER, castShadow=false FOREVER
new THREE.SpotLight(0xffffff, 0, 0, Math.PI/6, 0, 2)
```

**Pool size** (`lighting.js:603-604`, `:613-643`):

| Knob | Default | Notes |
|---|---|---|
| `LIGHT_POOL_DEFAULT_POINT` | **16** | was 32 → 8 (shader-compile trim 2026-06-22) → 16 (torch immersion 2026-07-05). `?lightPoolSize=n`, clamp ≤128 |
| `LIGHT_POOL_DEFAULT_SPOT` | **2** | spots ~absent in shipped DAT; pure headroom. `?lightPoolSpot=n`, clamp ≤32 |
| pool enabled | **true** (always-on since 2026-06-15) | `?lightPool=off` reverts to legacy `.visible` cap |
| `LIGHT_POOL_HYSTERESIS_DEFAULT` | **0.64** | `?lightHysteresis=`, (0,1] |

Total scene light objects with defaults: **16 point + 2 spot + sun + ambient + hemisphere = 21**, plus (if CSM) 3 cascade DirectionalLights + (if atmosphere) SunDirectionalLight + SkyLightProbe. Confirmed by `docs/2026-08-06-object-glue-census.md:75`: *"21 lights (16 point + 2 spot + sun + ambient + hemi)"*, `setupLights` cost `<0.02 ms`.

Shader cost note (`lighting.js:583-602`): each lit `MeshStandardMaterial` fragment unrolls one `RE_Direct` site per pool slot. At 32/8 = 46 sites ≈ half of the ~4.4k-line surface fragment; the 1070 ANGLE/D3D11 backend linked each program synchronously → **59.6 s** of cold first-load stall. 8/2 = 16 sites cut surface link **−76 %** (4334 → 1058 ms on the heaviest program).

**Source lights are permanent `.visible=false` carriers.** They exist only to carry live world position + color + intensity. The pool slots are the only things the renderer counts.

## 2.2 Selection algorithm — two paths

### Path A: cell-scoped (`?cellLights`, **default ON**) — `lighting.js:1580-1643`, gated at `:1661-1740`

Retail basis, cited at `lighting.js:652-689`: static pool rebuilt only when the viewer's CELL ID changes (`CellManager::ChangePosition` acclient.c:146717 → `CEnvCell::flush_cells` acclient.c:349880 → `CObjCell::add_static_to_global_lights` acclient.c:346859); ranking is squared distance from the **viewer's** global position (`Render::insert_light` acclient.c:380524, insertion sort, caps **40 static / 7 dynamic**, acclient.c:45530); **camera orientation appears nowhere.**

```
capActiveLightsByDistance(scene3d, sessionHandle):
  cellMode = lightPool.enabled && cellLightsCfg.enabled
  renderSetArr = sessionHandle.getRenderSet(1)     // camera-independent portal/PVS BFS
  if renderSetArr empty -> fall through to Path B

  refreshCellLightRef():                            // scene3d._lightRefPos
      cameraSwitcher.getPlayerWorldPosition()  else camera.position  (pre-spawn only)

  key    = FNV1a(renderSetArr)                      // hashCellSet     lighting.js:778
  srcKey = FNV1a(per-light monotone __lightSeqId)   // hashLightIdentities :803
  if built && key unchanged && srcKey unchanged:
      feedSelectedIntoPool(pool); return            // NO re-selection, but re-fed EVERY frame

  // --- rebuild (selectCellScopedSources) ---
  scratch = []
  if viewerLight: scratch.push({viewerSrc, distSq: -1})   // always wins slot 0
  for light in scene3d.activeLights:
      ud = light.userData
      if ud.__cellId != null   and not renderSet.has(ud.__cellId): skip   // unseen room
      elif ud.__lbKey != null  and scene3d._poolSunIndoor === true: skip  // outdoor lamp, enclosed cell
      // unstamped (entity/dynamic) -> always a candidate
      distSq = |light.getWorldPosition() - refPos|²
      scratch.push({light, distSq})
  scratch.sort(byDistSq)
  pickSelectedSources(pool, scratch)                // first 16 points, first 2 spots
  feedSelectedIntoPool(pool)
```
**No hysteresis on this path** — selection is set-keyed so slot flicker is structurally impossible (`lighting.js:1576-1578`). Diag: `liveScene3d._cellLightsStats = {rebuilds, key, count, srcKey, scoped, candidates, built}` (`:1720-1738`).

### Path B: legacy player-distance + hysteresis — `lighting.js:1742-1876`

```
sortInterval = ?lightSortInterval || 4              // LIGHT_SORT_INTERVAL, lighting.js:420
frameCounter++
throttled = (lastSortCount === lights.length) && (frameCounter - lastSortFrame < sortInterval)
if throttled: feedSelectedIntoPool(pool); return    // still fed every frame

refPos = cameraSwitcher.getPlayerWorldPosition() ?? camera.position   // player, NOT camera:
                                                     // third-person orbit reshuffled the set
                                                     // and popped torches on view turn (2026-07-05)
for each light:
    distSq = |worldPos - refPos|²
    if light.__lightPoolSel: distSq *= hysteresis   // 0.64 -> challenger must be 0.8× closer
sort ascending
if pool: pickSelectedSources + feedSelectedIntoPool
else:    scratch[i].visible = (i < MAX_ACTIVE_LIGHTS)   // 32 — the legacy cap
```

`MAX_ACTIVE_LIGHTS = 32` (`lighting.js:406`) is **legacy-path only**; in pool mode the effective budget is `pointCount`/`spotCount`.

### Per-frame feed — `feedSelectedIntoPool(pool)`, `lighting.js:948-988`
Runs **every frame** even when selection is throttled, so a light riding a moving rig never lags. Copies world position, color, intensity, distance, decay (+ angle, penumbra, target for spots). **Unused slots get `intensity = 0`** — never removed, never hidden.

`zeroLightPool(pool)` (`:899-910`) drives all slots dark when there are no sources, and clears `__lightPoolSel` tags in the right order (a stale tag would bias every later sort forever).

### Viewer light (retail SmartBox `viewer_light`) — `?viewerLight=on`, default OFF
`ensureViewerLightSource`, `lighting.js:828-854`. **Not a THREE light** — a plain duck-typed source carrier that `feedSelectedIntoPool` consumes. White (1,1,1), `VIEWER_LIGHT_INTENSITY = 2.25` (acclient.c:765774 = 0.5×4.5), `VIEWER_LIGHT_FALLOFF = 10.0` (acclient.c:44837) → `distance = 10.0 × 1.3 = 13.0`, `decay = 2`. Carried **2 m above the player origin** (`:845`, acclient.c:144016). Injected at `distSq = -1` so it always wins slot 0 (`:1610`).

## 2.3 Distance culling / fade

- No fade in/out. Selection is a hard swap; the anti-pop mechanisms are (a) the hysteresis stick band on the legacy path and (b) the set-keyed rebuild on the cell path.
- Reach culling happens implicitly via `distance = falloff × 1.3` (three's cutoffDistance) and, in the Rust bake, explicitly via `light_reaches_aabb` (`vertex_bake.rs:390-403`).
- Eviction on landblock unload: `releaseLight(scene3d, light)` (`lighting.js:1895-1926`) — splice from `activeLights`, detach light (+ SpotLight target), dispose. `landblock_lru.js:1767-1790` inlines the identical logic (must not import lighting.js — cycle avoidance).

## 2.4 Flicker

`scene3d/vfx/components/flameFlicker.js`. `?flameFlicker`, default ON under the `?visual` master gate; requires `?lightPool=on`.

- Runs in `loop.js:2587 tickFlameFlicker(scene3d)`, **after** `tickLightingForCellState` (`loop.js:2572`) so slots are already re-fed.
- **Multiplies pool-slot `.intensity` only** (`flameFlicker.js:207`). Never `.visible`, never the array, never the count (`lightCountDelta: 0`, `:219`). Non-destructive: the slot value is re-derived from source next frame.
- Waveform (`flameFlickerMul`, `:79-87`):
  ```
  a  = phase01 * 2π
  s1 = sin(t*7.3 + a)
  s2 = sin(t*2.13 + a*1.7 + 1.3)
  n  = smoothNoise1(t*2.7 + phase01*17) * 2 - 1
  w  = 0.5*s1 + 0.28*s2 + 0.5*n           // ~[-1.28, 1.28]
  f  = 1 + 0.16*w                          // amp
  return max(f, 0.74)                      // floor
  ```
  `FLAME_DEFAULTS` (`:39-45`): `amp 0.16, floor 0.74, baseHz 7.3, subHz 2.13, noiseHz 2.7`. `?flameFlickerAmp` overrides amp (0..0.6).
- **Flame classification** (`isFlameLight`, `:98-103`): PointLight AND, in LINEAR color, `r ≥ 0.30 && r ≥ g*0.92 && r > b*1.25`. Excludes white/cool/magic-blue so portals and ice spells never flicker.
- **Phase** (`flameSourcePhase`, `:112-132`): deterministic — quantise `userData.setupLightOrigin` to a 0.25 m grid, hash with primes 73856093 / 19349663 / 83492791, `hash01` → [0,1). Cached on userData. Never `Math.random`.
- Clock: `scene3d.frameTime.tsSec`.

## 2.5 Day/night interaction with lights

**Placed lights do NOT dim by day or brighten by night — they are absolute, with no time-of-day term at all.** Stated explicitly at `night_ramp.js:40-47`:
> "Torches, braziers, hearths and luminous window surfaces are absolute HDR values with no time-of-day term at all (placed PointLights from DAT SetupLight; `emissiveIntensity = min(2, sfLuminosity)`). Implementing the night as a sun-elevation remap plus an INDIRECT-ONLY dim leaves every one of them numerically untouched, so they gain contrast against the darker frame."

Night is implemented as (`night_ramp.js`, `?nightRamp` default ON):
- Sky-only sun-pitch remap to `[-14°, 20°]` below a 20° knee (`NIGHT_RAMP_FLOOR_DEG = -14.0`, `NIGHT_RAMP_KNEE_DEG = 20.0`, `RETAIL_PITCH_FLOOR_DEG = 0.9` — Dereth's DayGroup sun never sets). One call site: `atmosphere_sky.js AtmosphereSky.tick`.
- `NIGHT_ENV_SCALE_DEFAULT = 0.30` on `environmentIntensity` + terrain `uEnvIntensity` (`night_ramp.js:63`).
- `NIGHT_GROUND_SCALE_DEFAULT = 0.45` on the retail terrain Gouraud (`:66`, applied `loop.js:1164-1170`, `:1310-1317`).
- Diag: `window.__nightRampState()` (`night_ramp.js:190`) reports both pitches and both sun directions.

The **sun** does dim: `retailSunLighting` (`atmosphere_lights.js:86-114`) sets `sunIntensity = dirBright × worldLightScale` — Dereth night keyframes drop `dirBright` to ~0.0–0.05, while the probe is floored at `LSCAPE_LIGHT_MINIMUM = 0.2`.

---

# 3. RENDERING — how lights reach materials

## 3.1 Material types

- **All lit world/entity/cell geometry: `THREE.MeshStandardMaterial`** (`materials.js:1` "MaterialCache: surfaceDid → MeshStandardMaterial"; `:42` "PBR-style normalised lighting model"). No Lambert, no Phong.
- Wireframe mode uses `MeshBasicMaterial` and skips the entire lighting bundle (`index.js:1483` returns a null-stub `lighting`).
- **Terrain is NOT lit by three.js lights** — it's a raw `THREE.ShaderMaterial` with its own retail-Gouraud path and `uSunDir`/`uAcSunVec`/`uEnvIntensity` uniforms (`terrain.js:4`, `loop.js:1310`, `night_ramp.js:64-66`). Point/spot lights never touch terrain.

## 3.2 Attenuation model

| Path | Law |
|---|---|
| three.js default (`?lightClamp=off\|physical`) | Physical inverse-square, `decay = LIGHT_DECAY = 2.0`, with three's Frostbite eq.26 window on `cutoffDistance` |
| **`?lightClamp` retail arm — DEFAULT ON** (`url-flags.md:712`) | **`saturate(1 - dist/range)`**, `range = cutoffDistance = falloff × 1.3` (acclient.c:454615) |

The retail arm is installed by `_installLightClampShaderPatch` (`materials.js:2324-2458`), gated by `readLightClampRetailFlag()` (`:1619-1630`). It does three things in ONE `onBeforeCompile` chain link:

1. **Linear falloff** (`materials.js:2341-2381`): expands `THREE.ShaderChunk.lights_pars_begin` text and string-replaces the whole stock `getDistanceAttenuation` body with
   ```glsl
   if (cutoffDistance > 0.0) return saturate(1.0 - lightDistance / cutoffDistance);
   return 1.0 / max(pow(lightDistance, decayExponent), 0.01);   // infinite-reach fallback
   ```
   Signature preserved so `getPointLightInfo`/`getSpotLightInfo` call sites are unchanged.

2. **Half-Lambert wrap on diffuse only** (`materials.js:2405-2427`, acclient.c:454608):
   ```glsl
   raw     = saturate(dot(N, L));
   wrapped = saturate((dot(N,L)*0.5 + 0.5)²);
   diffDelta = (raw > 1e-4) ? diffDelta * (wrapped/raw)
                            : directLight.color * wrapped * RECIPROCAL_PI * diffuseColor.rgb;
   ```
   Specular stays on the physical dotNL.

3. **Per-RGB clamp against the light's own color** (`materials.js:2428-2440`, acclient.c:454616-454627). Wraps *each* `RE_Direct(directLight, ...)` invocation inside an expanded `lights_fragment_begin`:
   ```glsl
   diffBefore = reflectedLight.directDiffuse; specBefore = ...;
   RE_Direct(...);                                   // stock BRDF
   diffDelta = directDiffuse - diffBefore;  (then half-Lambert rescale)
   directDiffuse  = diffBefore + mix(diffDelta, min(diffDelta, directLight.color), uLightColorClamp);
   directSpecular = specBefore + mix(specDelta, min(specDelta, directLight.color), uLightColorClamp);
   ```
   `uLightColorClamp` (default 1.0) fades the effect without a relink.
   **Documented divergence** (`materials.js:2306-2321`): retail clamps against the light's BASE color with intensity/attenuation in the scalar coeff; three has already folded intensity×attenuation into `directLight.color` by `RE_Direct`, so the port clamps against the *attenuated* color. Visible behaviour matches (colored lights keep tone); the engage threshold differs.

Install sites: `materials.js:3205, 4765, 5461`; public export `installLightClampShaderPatch` at `:2463`.

## 3.3 Emissive vs light (for completeness — you asked to distinguish)

Emissive is a separate, unrelated channel: `emissive = white`, `emissiveIntensity = min(2.0, sfLuminosity)`, `emissiveMap = mat.map` (`materials.js:1895-1903`, `:4570-4588`, `entities.js:6104-6113`). Retail D3D `Emissive.rgb = luminosity`, acclient.c:454688. No hardware light slot involved.

## 3.4 Shadows

**Point and spot lights NEVER cast shadows.** `lighting.js:870` — `pl.castShadow = false; // CONSTANT — shadow counts are ALSO in the cache key`. Same at `:877` for spots.

Only the sun casts:
- Single-shadow path (`?shadows=on`): `sun.castShadow = true`, ortho frustum half-extent `sceneSize = 600` (1200 m box), `mapSize 2048²`, `bias -0.0005`, `normalBias 0.05` (`lighting.js:215-242`). Texel ≈ 0.59 m. Frustum recentred + texel-snapped on the player each frame (`updateShadowCameraTarget` `:357-397`).
- CSM path (`?csm`, on for `high`+ presets per `quality.js:395, 486`; `low`/`mid` = `csm:false` at `:147, 302`): 3 shadow-only `DirectionalLight(0xffffff, 0)` (`csm.js:223`), splits `[30, 100, 300]` m (`csm.js:60`), map sizes `[2048, 2048, 1024]` (`:66`), blend frac `0.1` (`:71`). Sampled by a manual shader patch in `materials.js:1030-1180` (3-tap-ish PCF, bias 0.0005) — three's own `getShadowMask` is stubbed to 1.0.
- **Static-scene shadow raster gate** (`applyStaticShadowGate`, `lighting.js:1334-1423`): flips `renderer.shadowMap.autoUpdate = false` once and sets `needsUpdate = true` only when (a) camera/sun moved (CSM `didRefitThisTick` / frustum recentre returned true), (b) indoor/outdoor flipped, (c) **any dynamic caster moved** (`scanDynamicCasterMovement` `:1455-1494` — FNV hash of every rig root position+quaternion quantised to 1 mm / 1e-3 rad), or (d) the staleness ceiling `?shadowMaxStale` default **12** frames elapsed, hard-floored at 60 (`SHADOW_MAX_STALE_FLOOR`, `:471`) so a shadow can never permanently freeze.

---

# 4. DUNGEON / INDOOR LIGHTING

## 4.1 Indoor/outdoor sun+ambient toggle — `tickLightingForCellState`, `lighting.js:1054-1276`

```
isIndoor = sessionHandle.isCurrentCellIndoor()
if sessionHandle.isCurrentCellSeenOutside(): isIndoor = false     // lighting.js:1086-1092
     // retail marks every BUILDING interior cell SeenOutside; enclosed dungeon cells are not.
     // So an open-door building is lit by the same sun/sky in or out — no jarring dark cut.

scene3d.atmosphereLights._indoorMute = isIndoor                    // :1101  (the REAL sun)

if lightPool.enabled:                                              // :1103-1130
    sun.visible stays TRUE forever                                 // a DirectionalLight count
    edge-triggered on transition:                                  // change relinks everything
       enter indoor  -> userData.__poolOutdoorIntensity = sun.intensity; sun.intensity = 0
       leave indoor  -> restore, ONLY if a value was captured
else:                                                              // legacy
    sun.visible = !isIndoor
```

Ambient (legacy, non-atmosphere path only — `lighting.js:1153-1197`):
- `AMBIENT_INTENSITY_OUTDOOR = 0.5`, `AMBIENT_INTENSITY_INDOOR = 0.7` (`lighting.js:70-71`). Indoor is *higher* because the sun goes off.
- Outdoor overridden by the diurnal snapshot: `intensity = max(0.2, skyState.ambBright)` (`resolveDiurnalAmbient` `:124-131`, `LSCAPE_LIGHT_MINIMUM = 0.2` `:93`, acclient.c:40344 / 307024), `color` = ARGB unpack of `ambColorArgb` **decoded sRGB→linear** (`:1188`).
- `AMBIENT_COLOR = 0xfff0e0` fallback (`:79`); hemisphere `HEMI_SKY 0xb0c8ff / HEMI_GROUND 0x504030 / HEMI_INTENSITY 0.15` (`:141-143`).
- **On the atmosphere path (the shipped default) the legacy sun+ambient are ZEROED at boot** (`index.js:5698-5706`) and `AtmosphereLights` owns everything.

## 4.2 EnvCell baked static lighting (RND-04) — the big one for a D3D port

**Yes, cells have baked light data — but the client bakes it itself from DAT LightInfo, it is not pre-baked in the DATs.**

Retail basis: `D3DPolyRender::SetStaticLightingVertexColors` (acclient.c:454918) burns the static pool into `cell->constructed_mesh` vertex diffuse, then `DrawEnvCell` (acclient.c:456900) draws it with `SetFFEmissiveColorSource(FromVertex)` (acclient.c:454724). `Render::minimize_envcell_lighting` (acclient.c:379652) enables **DYNAMIC lights only** for an EnvCell draw.

**Rust bake** — `src/vertex_bake.rs`:
- `STATIC_LIGHT_FACTOR = 1.3` (`:27`), `WRAP_BIAS = 0.5`, `WRAP_RECIP = 1/1.5` (`:31-32`), `MAX_STATIC_LIGHTS = 40` (`:36`, acclient.c:45530).
- `accumulate_point_light` (`:75-104`) — term-for-term `calc_point_light`:
  ```
  D = lightPos - vertexPos;  d2 = |D|²;  d = √d2;  range = falloff * 1.3
  if d < range:
      wrap = (0.5*d + N·D) / 1.5                        // half-Lambert, D UNNORMALISED
      if wrap > 0:
          atten = (d2 <= 1) ? wrap/d : wrap/(d2*d)      // no inverse-square inside 1 m
          k = atten * (1 - d/range) * intensity
          for c in RGB: rgb[c] += min(k*color[c], color[c])   // PER-CHANNEL clamp
  ```
- `accumulate_directional_light` (`:110-121`) — `LIGHTINFO::type == 1`; no distance terms, **no per-channel clamp**.
- **`LIGHTINFO::type` dispatch (acclient.c:454987): 0 → point, 1 → directional, ANY OTHER VALUE contributes NOTHING** — so spot/type-2 lights are absent from the static bake entirely (`vertex_bake.rs:38-46`, enforced at `lib.rs:21386-21389`).
- `bake_vertex_colors` (`:132-169`): per emitted (un-indexed) vertex, accumulate → clamp [0,1] → **truncate** `(x*255.0) as u8` (acclient.c:455037 casts through an integer). **Empty light set bakes BLACK, not skipped** (`:127-131`).
- `select_cell_pool` (`:278-333`): candidates = the cell's own statics + its `VisibleCells` statics; each converted to cell-local via `conj(q)·(p − origin)` (`LIGHTINFO::convert_to_local`, acclient.c:454319); exact AABB reach cull (`light_reaches_aabb` `:390`); cap at 40 ranked by distance to cell centre (no viewer at bake time), reporting `dropped_by_cap`.
- Placement space is **landblock-local**, deliberately not world (`:236-243`) — the 0xFF×192 = 48,960 m corner offset would burn ~3 decimal digits of f32 mantissa.
- Gather: `collect_landblock_bake_lights` (`lib.rs:21352-21414`) — walks each EnvCell's `static_objects`, skips `0x01` GfxObjs, **reuses `collect_setup_model_lights` verbatim** so the bake and the live pool can never disagree; light world pos = `stab.position.origin + rotate_by(stab.q, sl.xyz)`.

**JS consumption** — attribute `acBakedLight` (3 × u8, normalized):
- Attached in `adapter.js:1000`, `geom_bundles.js:408, 485`, fused in `cell_fusion.js:58, 82, 127`, pooled in `pool_material.js:361-378, 528, 567, 577`.
- Detected at `cells.js:1675-1689, 1773-1774` → sets **`scene3d._acVertexBakeActive = true`** (the gate).
- Shader: `applyBakedVertexLightPatch(material, {suppressDirect})`, `materials.js:868-949`. Anchors on `<lights_fragment_end>`:
  ```glsl
  reflectedLight.directDiffuse  *= (1.0 - uAcBakedSuppressDirect);
  reflectedLight.directSpecular *= (1.0 - uAcBakedSuppressDirect);
  reflectedLight.indirectDiffuse += diffuseColor.rgb * acBakedEotf(vAcBakedLight) * uAcBakedGain;
  ```
  `acBakedEotf` is an inlined piecewise sRGB→linear EOTF (`:908-915`) — the baked bytes are in authored sRGB space, same as the live path's `setRGB(..., SRGBColorSpace)`.
  Uniforms not `#define`s, so a future light tick can cross-fade without a relink.
- Flag `?vertexBake` (`materials.js:841-856`): absent ⇒ `{enabled: true, suppressDirect: true}` (full retail); `=lit`/`=add` ⇒ additive-only A/B (double-lights walls); `=off` ⇒ disabled.

**The pool consequence (RND-04)** — `lighting.js:725-774` + `:2149-2164`: when `_acVertexBakeActive && dropCellStatics`, **interior cell static lights are never constructed at all** — no THREE light, nothing in `activeLights`, counted as `summary.cellStaticsBaked`. Keeping them would double-count the same photons *and* recreate the slot competition. The pool is thus left to dynamics (entity SetLight, viewer light).
**Known accepted delta** (`lighting.js:738-744`): retail's OBJECT draw path (`Render::minimize_object_lighting` / `remove_object_light` @0x0054C1B0) still walks the static pool, so retail's interior *props* are lit by the same lamps the walls have baked. This port bakes the room mesh only, so props fall back to ambient. `?vertexBakePool=keep` restores the lights to the pool as the A/B arm.

## 4.3 Indoor render layers

`RENDER_LAYER_INDOOR = 1`. Three drops layer-mismatched lights in `projectObject`, so under `?portalPunch` (default ON) the cells pass would render interiors black unless every illuminator is on layer 1:
- all scene lights: `lighting.js:275-277` (`lightsGroup.traverse(o => o.isLight && o.layers.enable(1))`)
- setup-model accent lights: `lighting.js:2466`, `:2642`
- atmosphere sun + sky probe: `atmosphere_lights.js:174-175`

---

# 5. Docs, URL flags, diag surfaces

## 5.1 Docs

There is **no dedicated `docs/*lighting*.md`**. The lighting material is distributed:
- `docs/3d-render-math-waves-2026-05-28.md:182-227` — **the design spec for waves R2.A (entity lights) + R2.B (per-RGB clamp)**, with the acclient math laid out. `:381-383` = "Lighting" summary of what exists.
- `docs/3d-render-completeness-waves-2-2026-05-29.md:23-24, 77, 103, 121` — L1 (diurnal ambient), L2 (`static_light_factor` 1.3), L3 (linear falloff), L4 (flat diffuse) findings and dispositions.
- `docs/2026-08-06-object-glue-census.md:75, 386-388` — the 21-light count, `setupLights` cost, and the "do NOT shrink the pool" warning.
- `docs/url-flags.md` — see below.
- `docs/2026-07-31-terrain-vfx-plan.md`, `docs/2026-08-03-random-review-fixes.md`, `docs/reengineering/pass-04-geometry-spec.md` mention the pool in passing.
- Capture harnesses (executable specs): `capture_f1_setupmodel_lights.cjs`, `capture_c7_lighttemplate_soak.cjs`, `capture_envcell_fusion_ab.cjs`.

## 5.2 `docs/url-flags.md` lighting rows

| Line | Flag | Default | Meaning |
|---|---|---|---|
| 318 | `cellLights` | **on** (`off\|false\|0\|no` disables) | RND-05/03 cell-scoped selection |
| 319 | `viewerLight` | **off** (exact `on\|1\|true\|yes`) | retail SmartBox player light |
| 320 | `viewerLightIntensity` | 2.25 | clamped to `LIGHT_INTENSITY_CLAMP` |
| 352 | `flameFlicker` | **on** (via `visualAll`) | torch intensity jitter; needs `?visual` + `?lightPool=on` |
| 405 | `entityLights` | **off** | SetLight hook 25 entity lights |
| 316 / 712 | `lightClamp` / `flatDiffuse` | **on** (`off\|physical` disables) | retail linear falloff + per-channel clamp |
| 558 | `shadowStaticGate` / `lightSortInterval` / `shadowMaxStale` | on / 4 / 12 | raster + sort perf levers |
| 559 | `csmCamEps` / `csmSunEps` | csm.js defaults | CSM refit thresholds |
| 254 | `csm` | per-preset (high+) | cascaded shadow maps |
| 299 | `worldLightScale` | **0.4** | scalar on takram sun + sky probe |
| 731 | `ibl` | **on** (2026-07-28) | sky IBL; mutes SkyLightProbe to 0 (light LIST unchanged) |
| 831 | `retailSun` | **on** (`!== "off"`) | dirBright/dirColor drive |
| 840 | `nightRamp` | **on** | + `nightRampFloor\|Knee`, `nightEnv`, `nightGround` |
| 1313 | `flameFlickerAmp` | 0.16 | |
| 1328 | `lightHysteresis` | 0.64 | legacy path only |
| 1494 | `vertexBake` | ON (`off` disables, `lit\|add` = additive arm) | EnvCell bake |
| 269 | `portalPunch` | **on** | why lights need layer 1 |

**Not documented in url-flags.md** (defined only in code, `lighting.js:576-579, 754-769`): `?lightPool` (default on, `off` reverts), `?lightPoolSize` (16), `?lightPoolSpot` (2), `?vertexBakePool=keep`.

## 5.3 Diag surfaces

| Surface | Location | Contents |
|---|---|---|
| `liveScene3d.activeLights` | `index.js:1865, 3547` | the Array of all source lights |
| `liveScene3d.lighting` | `index.js:3458` | `{sun, ambient, hemisphere, lightsGroup, csmState, lightPool, dispose}` — `lighting.js:322` |
| `liveScene3d.lighting.lightPool` | `lighting.js:884-893` | `{enabled, pointCount, spotCount, point[], spot[], selPoint[], selSpot[], _tmp}` |
| `liveScene3d._cellLightsStats` | `lighting.js:1720-1738` | `{rebuilds, key, count, srcKey, scoped, candidates, built}` |
| `liveScene3d.setupLightsSummary` | `index.js:2124` | `{lightCount, pointLightCount, spotLightCount, modelsScanned, modelsWithLights, noLightModels, wasmExportMissing, lightsByLbKey, cellStaticsBaked}` — `lighting.js:1967-1986` |
| `LIGHTING_CONSTANTS` (frozen export) | `lighting.js:2659-2672` | `AMBIENT_INTENSITY_OUTDOOR/INDOOR, MAX_ACTIVE_LIGHTS, LIGHT_INTENSITY_CLAMP, SPOTLIGHT_PENUMBRA, LIGHT_DECAY, LSCAPE_LIGHT_MINIMUM, STATIC_LIGHT_FACTOR, VIEWER_LIGHT_FALLOFF, VIEWER_LIGHT_INTENSITY` |
| `window.__diag.render` (`?renderDiag=on`) | `index.js:524-545` | **`programs` = `renderer.info.programs.length`** — THE Problem-A signal; must stay FLAT across a spell cast |
| `window.__nightRampState()` | `night_ramp.js:190-215` | authored vs remapped pitch, sky dir vs `sunLightDir`, `envScaleAtFullNight` |
| `window.__setWorldLightScale(v)` | `index.js:5968` | live sun/probe scalar |
| `liveScene3d._portalPunchDiag` | url-flags.md:269 | aperture punch (affects which lights reach interiors) |
| `material.userData.lightClampShaderUniforms` / `acBakedLightUniforms` / `csmShaderUniforms` | `materials.js:2454, 946` | post-compile uniform handles |
| Test seams | `lighting.js:648, 721, 772` | `__resetLightPoolConfigForTest`, `__resetCellLightsConfigForTest`, `__resetVertexBakePoolConfigForTest` |

---

# 6. Light-source table (color, intensity, radius, flicker)

| Source | Where created | Type | Color | Intensity | Radius / distance | Decay | Flicker | Default state |
|---|---|---|---|---|---|---|---|---|
| DAT SetupModel `LightInfo` — outdoor building/static lamp | `lighting.js:2496` via `attachSetupModelLights:2033/2076` | Point (`cone_angle ≤ 0`) | ARGB→sRGB-decoded linear; sample `(255,150,80)` warm amber | authored 20–100 (p50 100), clamped ≤120 | `falloff × 1.3` | 2.0 | Yes if warm (r≥0.30, r≥0.92g, r>1.25b) | live |
| ...same, EnvCell interior prop (torch/brazier/candelabra) | `lighting.js:2144` | Point | same | same | same | 2.0 | n/a | **DROPPED** — baked into cell verts (`lighting.js:2161`); `?vertexBakePool=keep` restores |
| ...same, `cone_angle > 0` | `lighting.js:2587` | Spot, `angle=coneAngle`, `penumbra=0.3` | same | same | same | 2.0 | no (point-only gate) | **absent in shipped data** — all 285 surveyed lights have uninitialised cone_angle (`lib.rs:21381-21388`) |
| Entity SetLight (held torch/lantern, forge, glowing mob) | `entities.js:12099` → `lighting.js:2653` | Point/Spot, same math | same | authored, but starts at **0** | `falloff × 1.3` | 2.0 | Yes if warm | **OFF** (`?entityLights=on`); hook 25 toggles intensity |
| Viewer light (retail SmartBox) | `lighting.js:828` | synthetic point source (not a THREE object) | **white (1,1,1)** | **2.25** (`?viewerLightIntensity`) | `10.0 × 1.3 = 13.0` | 2.0 | no (white fails the warm gate) | **OFF** (`?viewerLight=on`) |
| Sun — legacy | `lighting.js:204` | DirectionalLight | `SUN_COLOR 0xfff2cc` | 1.0 at construct, **zeroed at boot on atmosphere path** (`index.js:5698`) | — | — | — | inert |
| Sun — atmosphere (the real one) | `atmosphere_lights.js:144` | takram `SunDirectionalLight` | Bruneton transmittance × `dirColor` hue (peak-normalised) | `dirBright × worldLightScale(0.4)`; 0 when `_indoorMute` | — | — | — | on |
| Ambient — legacy | `lighting.js:246` | AmbientLight | `0xfff0e0`, or sRGB-decoded `ambColorArgb` | `max(0.2, ambBright)`; indoor 0.7 / outdoor 0.5 fallback; **zeroed on atmosphere path** | — | — | — | inert |
| Sky probe — atmosphere | `atmosphere_lights.js:155` | takram `SkyLightProbe` (SH) | Bruneton irradiance SH | `max(0.2, ambBright × 0.4)`; **0 when `?ibl` owns diffuse** | — | — | — | on |
| Hemisphere | `lighting.js:255` | HemisphereLight | sky `0xb0c8ff` / ground `0x504030` | 0.15 | — | — | — | on (opt-out `includeHemisphere:false`) |
| Pool point slots ×16 | `lighting.js:868` | PointLight | copied from selected source | copied (0 when unused) | copied | copied | applied here | **always visible, always allocated** |
| Pool spot slots ×2 | `lighting.js:876` | SpotLight, `angle π/6`, `penumbra 0` | copied | copied (0 when unused) | copied | copied | n/a | **always visible, always allocated** |
| CSM cascades ×3 | `csm.js:223` | DirectionalLight | white | **0** (shadow-only) | splits 30/100/300 m, maps 2048/2048/1024 | — | — | `high`+ presets |
| Portals, spell projectiles, spell impacts, wisps, Virindi glow | — | **NO LIGHT** | emissive white × `min(2, luminosity)` + additive sprites + bloom | — | — | — | — | — |

---

# 7. Port checklist / gotchas for a native D3D plugin

1. **You have real HW light slots — the pool exists only because of a three.js shader-relink pathology.** In D3D you can keep the 8-slot retail model directly (`FFLightEnable[8]`) and just toggle state bits. Retain the *selection* algorithm, drop the fixed-count discipline if your pipeline doesn't recompile on light count.
2. **Do not double-count interior statics.** Either bake to vertex diffuse (`vertex_bake.rs`, retail-exact) or keep them as live lights — not both. Retail does the bake AND keeps the static pool for *object* draws only (see the accepted delta at `lighting.js:738-744`).
3. **`falloff × 1.3` exactly once.** Rust surfaces raw falloff; JS multiplies at `lighting.js:2560`; the bake multiplies at `vertex_bake.rs:84`.
4. **ARGB from the DAT is sRGB.** Decode to linear in a linear-space renderer (`lighting.js:2568`, `materials.js:908-915`).
5. **Retail attenuation is linear + half-Lambert + per-channel clamp**, not inverse-square Lambert. That combination is what makes a torch saturate to its own tint across most of its radius. Formula in `vertex_bake.rs:75-104` is the cleanest reference (it's the acclient decomp, term for term).
6. **Selection reference point is the PLAYER, not the camera** (`lighting.js:1775-1792`), and the scope is the current cell + PVS-visible cells (`lighting.js:1580`), rebuilt on cell-set change only. Camera orientation must not appear anywhere.
7. **`cone_angle` in shipped DATs is uninitialised garbage** (≈ -2.3e23). Treat `cone_angle > 0 && isFinite` as the only spot predicate (`lib.rs:21386`).
8. `LIGHTINFO::type` ≠ 0 and ≠ 1 contributes **nothing** to the static bake (acclient.c:454987 has no `else`).
9. Placed lights have **no time-of-day term**. Night = sun-elevation remap + indirect-only dim.