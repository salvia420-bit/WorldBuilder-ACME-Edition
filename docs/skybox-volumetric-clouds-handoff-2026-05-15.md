# Volumetric Clouds — Deep-path handoff (2026-05-15)

**For**: a team-agent (or a fresh Claude Code session) picking this up cold.
**Goal**: replace the retail-AC parametric cloud-band SkyObjects with a DayZ-tier volumetric cloud system that COMPOSITES with the existing retail-AC DayGroup pipeline. **Priority: the new skybox looks the best.** Effort estimate per the survey agent: **1-2 months** of focused work.

---

## TL;DR — what this is

Fork [`takram-design-engineering/three-geospatial`](https://github.com/takram-design-engineering/three-geospatial)'s `@takram/three-clouds` package (MIT-licensed, AGPL v3 compatible), **decouple it from `@takram/three-atmosphere` (Bruneton scattering)**, and plumb our existing **retail-AC DayGroup state** (`sun_dir`, `ambient_rgb`, `horizon_rgb`, `fog`) in as the lighting source of truth instead. Take takram's `<CloudLayer channel='r|g|b'>` layered system (stratus + altocumulus + cirrus via separate channels in one Data3DTexture raymarch) and tune its three default layers to match Asheron's Call retail cloud aesthetics.

This is **the same algorithm DayZ uses** — Andrew Schneider's "Nubis" pipeline (Horizon: Zero Dawn 2015, Evolved 2022, Cubed 2023). Takram has already done the heavy implementation lifting; our work is the decoupling + integration into our existing skybox + tuning.

**Do NOT** adopt takram's `<Atmosphere date={…}>` driver — it will fight our `AC_LAUNCH_UNIX_EPOCH = 941500800.0` wall-clock anchor. The DayGroup pipeline stays the source of truth; clouds are a compositing layer that *consumes* state.

---

## Where this fits in the project

- **Repo**: `~/WorldBuilder-ACME-Edition` on `master`. NOT `~/holtburger` (stale 2026-04-23 mirror; the holtburger-* crates live in WorldBuilder-ACME-Edition as a cargo workspace).
- **Renderer code**: `external/holtburger/apps/holtburger-web/scene3d/`
- **Existing skybox memories** (read these first):
  - `project_holtburger_skybox_done_2026-05-11` — Sky-A→Sky-G+I, current parametric skybox + lessons learned. **Status 2026-05-15 note in that memory: Sky-J carry-forward shipped 2026-05-12.**
  - `project_holtburger_skybox_properties_flags` — Sky-G probe: 0x02=cloud band (HIGH), 0x04=weather streak (MED), 0x08=PhysicsScript-bound (HIGH), 0x01=additive (LOW)
  - `project_holtburger_sky_j_done_2026-05-12` — particle chain (ParticleEmitter+PhysicsScript+Table) shipped — RELEVANT because retail moon/star particles use the same chain you'll need to compose with
  - `project_emit_dynamic_site` — pre-3D-renderer architecture baseline (coords, PixiJS-8 footguns, wasm32 cross-compile pattern)
- **Critical feedback memories**:
  - `feedback_ground_in_real_wire_data` — capture wire packets + parse real DAT bytes BEFORE shipping fixes
  - `feedback_no_partial_demos` — say "no, I can't fully demonstrate this without X" instead of bypassing the load-bearing path
  - `feedback_no_phatac` — ACE-only for AC-server references; PhatSDK cross-checks break 1:1 compat
  - `feedback_base_dats_only_for_bake` — `~/ac_base_dats/` or `dats/base/`; reject modder DATs
  - `feedback_attribution_precision` — quote the user verbatim when briefing sub-agents
  - `feedback_use_external_drives_for_scratch` — write logs/screenshots/traces under `/mnt/wbterminal1/tmp/claude-scratch/`
- **Plugins available in this session** (use them):
  - **context7** (`mcp__plugin_context7_context7__resolve-library-id` + `__query-docs`) — version-current Three.js docs at `/mrdoob/three.js`. **Use even when you think you know** — your training data may be stale. See `reference_context7_plugin` memory for usage notes.
  - **rust-analyzer-lsp + typescript-lsp** — `LSP` MCP tool with goToDefinition / findReferences / hover / documentSymbol / workspaceSymbol / goToImplementation / call hierarchy across 395 .rs files + JS/TS. See `reference_claude_lsp_plugins`.

---

## Quick mental model

- **takram-three-clouds = Nubis-with-Bruneton-bolted-on.** Pure cloud rendering (raymarch, Worley noise bake, layer config, quality presets) lives in ~17 files; atmospheric scattering coupling is concentrated in **5 TS + 2 GLSL files**.
- **The Bruneton seam is small**: one `AtmosphereUniforms` struct (6 keys: `bottomRadius`, `topRadius`, `worldToECEFMatrix`, `ecefToWorldMatrix`, `altitudeCorrection`, `sunDirection`) + three Bruneton GLSL functions (`GetSunAndSkyIrradiance`, `GetSunAndSkyScalarIrradiance`, `GetSkyRadianceToPoint`). All three functions are branched by `#ifdef ACCURATE_SUN_SKY_LIGHT` — the non-accurate path uses precomputed varyings (much easier to replace).
- **Layered clouds = one Data3DTexture + one 2D weather map.** Each `<CloudLayer>` picks a `channel: 'r'|'g'|'b'|'a'` of the weather texture; 4 layers run simultaneously in ONE raymarch (not four separate volumes). Defaults: R=cumulus @750m/650m, G=cumulus @1000m/1200m, B=cirrus @7500m/500m, A=unused.
- **Quality preset matrix** (`qualityPresets.ts:59-121`):
  - `low` — `shapeDetail=false`, `lightShafts=false`, `turbulence=false`, `accurateSunSkyLight=false`, maxIter 500→200, cascadeCount 3→2, shadow map 512²→256². **This is the swiftshader CI target.**
  - `medium` — light shafts + turbulence off, accurateSunSkyLight off
  - `high` — defaults
  - `ultra` — minStepSize 50→10, shadow map 1024²
- **r137 polyfill needed**: takram's peerDep is `three >= 0.170.0`. We're on r137. The `DataArrayTexture` type (used in 4 files) was `DataTexture2DArray` in r137. One-line alias.

---

## Critical constraints (lock these in before coding)

| Constraint | Where it bites | How to honor it |
|---|---|---|
| License: project is **AGPL v3** | Any dep | takram-clouds is **MIT** (verified `LICENSE` + per-package `package.json`); Bruneton GLSL is **BSD-3-Clause**. Both AGPL-compatible. Re-verify on any sub-dep added. |
| **Don't override `AC_LAUNCH_UNIX_EPOCH = 941500800.0`** | takram has its own `<Atmosphere date={…}>` driver | Do not wire `<Atmosphere>`. Drive cloud uniforms from `skyLightingController._lastState` (read by `skyDome.tick` already). |
| **DayGroup is source of truth** | Lighting state for cloud raymarch | Replace takram's 3 Bruneton GLSL stubs with inline GLSL that lerps `(ambient_rgb, horizon_rgb, fog_color)` against altitude+sunCos. |
| **Three.js r137-era** | takram peerDep `>=0.170.0` | Polyfill `DataArrayTexture` (was `DataTexture2DArray` in r137 — renamed in r144). Also note: `RGBFormat` was **removed** in r137 — use `RedFormat`/`RGFormat`/`RGBAFormat` only. |
| **TSL not adopted** (we're firmly pre-TSL — TSL is r166-r171 era, mid-2024) | Don't accept any TSL-only fork or rewrite | Stay with `onBeforeCompile` / `RawShaderMaterial`. Our `_chainBeforeCompile` pattern in `apps/holtburger-web/scene3d/materials.js` is the right tool. |
| **Coordinate transforms** | Cloud volume placement at altitude | `acToThree(ax,ay,az) = [ax, az, -ay]` (verified `adapter.js:968-970`). Cloud base at AC altitude `cloud_base_z` → three.js position `[0, cloud_base_z, 0]` relative to `skyCell`. `worldRoot.rotation.x = -π/2` already applied. |
| **Sky pass renders FIRST, world OVER it** (Sky-I-C learned) | Render order | Cloud volume attaches to `skyCell` (under `skyScene`); rendered in the existing sky `RenderPass`. Direct-render path: cleared color → sky → `clearDepth()` → world overdraws. SSAO composer path: sky pass already wired in `postprocess.js:131`. |
| **Indoor flip**: `outdoorContainer.visible = !isCurrentCellIndoor()` | Don't render clouds in dungeons | `sky_dome.js:1541-1543` short-circuits `renderSkyPass` when `_lastIsIndoor === true` — clouds attached to `skyCell` inherit this. Free. |
| **SwiftShader (Playwright/Chromium CI)** quietly falls back to nearest on float Data3DTexture | Texture format choice | Stick to `UnsignedByteType` + `RedFormat`/`RGBAFormat` for shape + detail volumes (matches Nubis HZD 2015 anyway). Don't bake float 3D textures. |
| **Existing `SCROLLING_CLOUD` SkyObjects (0x02 bit)** in retail Dereth | Don't delete them | Volumetric clouds **coexist** with the parametric cloud-band quads. Both share visibility windows via `getSkyObjectStates()`. Decide compositing order at integration time (probably: dome → volume → quads → celestials, all under skyCell). |
| **Dome's depth quirk** (Sky-I-C: `depthWrite=true` at radius 1000 occludes celestials at ~2700) | Composition with celestials | Cloud volume = atmospheric haze overlay → `depthWrite=false`. Celestials composite over it correctly regardless of volume placement. |
| **Bake against base DATs only** (memory `feedback_base_dats_only_for_bake`) | If we bake Nubis 3D textures from data, do NOT pull from modder iterations | Our shape + detail 3D textures are **procedural noise**, not DAT-derived, so this rule may not apply directly. But emit `bake-source.sha256` if any bake step references DATs. |
| **No PhatSDK** | If any sub-fork of takram or its deps references PhatSDK | Reject it. ACE-only for AC-server references. |
| **Capture suite must not regress** | `capture_skybox_e2e.cjs` bullets 4-16 | New cloud bullets are additive. Existing bullets still pass: 4 (hasSkyDesc), 5 (getSkyState non-null), 6 (dayGroupIndex<20), 7 (fogColor lerps), 8 (7 SkyObjects in Sunny DayGroup), 11 (sky_dome group in scene), 12 (sky_object_id userData), 16 (cloud UV offset advances). |

---

## Recommended phasing — Clouds-A through Clouds-G

Each phase is **independent enough to be a single parallel team-agent workstream**. Phases A-G are the main thrust; H+ is post-shipping polish.

### Clouds-A — Vendor takram-three-clouds + r137 polyfill (3-5 days)

**Goal**: takram-clouds source lives in `external/holtburger/apps/holtburger-web/vendor/takram-three-clouds/` (vendored, not npm-installed, because we will fork it). Compiles + tree-shakes against our Three.js r137.

**Steps**:
1. `git clone --depth=1 https://github.com/takram-design-engineering/three-geospatial /tmp/takram-source` (or use the version at `/tmp/takram-three-geospatial` if a previous agent left it there). Subtree-import `packages/clouds/` into `vendor/takram-three-clouds/`.
2. Copy the BSD-3-Clause Bruneton GLSL headers from `packages/atmosphere/src/shaders/bruneton/` into `vendor/takram-three-clouds/shaders/bruneton-stubs/` — we'll rewrite these but keep them around for reference + license attribution.
3. **r137 polyfill** (`vendor/takram-three-clouds/r137-compat.ts`):
   ```ts
   import * as THREE from 'three';
   // r137 had DataTexture2DArray; renamed to DataArrayTexture in r144.
   if (!(THREE as any).DataArrayTexture) {
     (THREE as any).DataArrayTexture = (THREE as any).DataTexture2DArray;
   }
   ```
   Import this once at the top of `vendor/takram-three-clouds/index.ts`. Confirm via context7 against `/mrdoob/three.js` that nothing else needs aliasing.
4. **Tree-shake**: drop `@takram/three-atmosphere` import wholesale; replace with our shim crate from Clouds-C. `tiny-invariant` + `type-fest` are MIT, trivial to keep.
5. **License attribution**: add `vendor/takram-three-clouds/LICENSE.md` reproducing the takram MIT LICENSE + Bruneton BSD-3-Clause + Sébastien Hillaire TileableVolumeNoise MIT (embedded at `cloudShape.frag:7`).

**Gate**: `apps/holtburger-web/smoke_test.cjs` still 173/0/1; new vendor build emits no TypeScript errors against our r137 types.

**Files (concrete, from Agent A grounding)**:
- `vendor/takram-three-clouds/CloudsEffect.ts` (line 229-289 is the constructor — atmosphere default lives here)
- `vendor/takram-three-clouds/CloudLayers.ts:31-68` (channel/altitude defaults)
- `vendor/takram-three-clouds/qualityPresets.ts:59-121` (preset constants — keep verbatim)
- `vendor/takram-three-clouds/CloudShape.ts` + `cloudShape.frag` (128³ RGBA bake, no atmo coupling)
- `vendor/takram-three-clouds/CloudShapeDetail.ts` (32³ detail, no atmo coupling)
- `vendor/takram-three-clouds/LocalWeather.ts` + `localWeather.frag` (512² 2D weather map bake)

### Clouds-B — Bruneton decoupling surgery (3-5 days)

**Goal**: takram-clouds compiles + runs against synthetic constant inputs for sun direction / ambient color / horizon color. No Bruneton runtime calls remain.

**Steps**:
1. In `vendor/takram-three-clouds/uniforms.ts:188-216`, replace the `AtmosphereUniforms` struct (6 keys) with **`DayGroupUniforms`**:
   ```ts
   interface DayGroupUniforms {
     sunDirection: Vector3;          // unit vector, three.js space (post acToThree)
     sunColor: Color;                // dirColorArgb → THREE.Color
     ambientColor: Color;            // ambColorArgb → THREE.Color
     horizonColor: Color;            // fogColorArgb (used as horizon tint)
     fogDensity: number;             // derived from fogMin/fogMax
   }
   ```
2. In `vendor/takram-three-clouds/CloudsMaterial.ts:21-30`, drop imports of `AtmosphereParameters`, `AtmosphereMaterialBase`, `AtmosphereMaterialBaseUniforms`. Replace `extends AtmosphereMaterialBase` with `extends ShaderMaterial`.
3. In `vendor/takram-three-clouds/shaders/clouds.frag:17-30,419-446,700-715` and `clouds.vert:4-17,43-62`, replace `#include "atmosphere/bruneton/..."` with `#include "bruneton-stubs.glsl"`. The stubs implement:
   ```glsl
   vec3 GetSunAndSkyIrradiance(vec3 worldPos, vec3 worldNormal, vec3 sunDir, out vec3 skyIrradiance) {
     float sunCos = clamp(dot(worldNormal, sunDir), 0.0, 1.0);
     skyIrradiance = uAmbientColor.rgb * 1.0;
     return uSunColor.rgb * sunCos * uSunIntensity;
   }
   vec3 GetSunAndSkyScalarIrradiance(...) { /* scalar form for vertex stage */ }
   vec3 GetSkyRadianceToPoint(vec3 cam, vec3 point, vec3 sunDir, out vec3 transmittance) {
     // For atmospheric perspective: lerp(uHorizonColor, scenePixel, depthFog) — match our existing fog.
     float depth = distance(cam, point);
     float fogAmount = 1.0 - exp(-uFogDensity * depth);
     transmittance = vec3(1.0 - fogAmount);
     return mix(vec3(0.0), uHorizonColor.rgb, fogAmount);
   }
   ```
4. **Disable the `#ifdef ACCURATE_SUN_SKY_LIGHT` path entirely** — set qualityPreset → never defines this macro. The non-accurate path uses precomputed varyings (`vGroundIrradiance.sun/sky`, `vCloudsIrradiance.minSun/maxSun/minSky/maxSky` at `clouds.frag:92, 433-434, 442-444, 691-694`) which our stubs fill in the vertex stage. This is the simpler branch.
5. **Validate per-step**: after the TS edits, run `tsc --noEmit` against the vendor dir. After the GLSL edits, the cloud shader should compile (`THREE.ShaderMaterial.onBeforeCompile` returns no errors; check via console.warn in dev console).

**Gate**: standalone test page (`apps/holtburger-web/cloud_test.html` — new) wires a `CloudsEffect` with hardcoded `(sun_dir=[0.5, 0.7, 0.3], sunColor=#ffeecc, ambientColor=#88aaff, horizonColor=#dddddd, fogDensity=0.002)` and renders to a canvas. Visual smoke: clouds appear, are illuminated from the synthetic sun direction.

**Surgery scope (Agent A verified)**: 3 TS files (`CloudsMaterial.ts`, `CloudsEffect.ts`, `uniforms.ts`) + 2 GLSL files (`clouds.frag`, `clouds.vert`) + 1 new stub file (`bruneton-stubs.glsl`).

### Clouds-C — DayGroup → CloudUniforms bridge (2-3 days)

**Goal**: `skyDome.tick(dt, activeCam)` updates `cloudVolume`'s uniforms each frame from `skyLightingController._lastState` and `sessionHandle.getSkyObjectStates()`. Cloud lighting moves with the AC sun across the day.

**Steps**:
1. Add `scene3d/cloud_volume.js` — a new module that owns the takram `CloudsEffect` instance, exposes `tick(state, objStates)` and `attach(skyCell)` / `detach()`.
2. In `loop.js:277` (`skyDome.tick`), after the existing per-frame work, call `cloudVolume.tick(state, objStates)` where `state` is `skyLightingController._lastState`.
3. Map AC SkyState → DayGroupUniforms:
   - `state.dirHeading`/`state.dirPitch` (DEGREES per Sky-C lesson) → unit vector `sunDir` in AC space → `acToThree(...)` → uniform
   - `state.dirColorArgb` → THREE.Color (drop alpha byte; `& 0xFFFFFF`)
   - `state.ambColorArgb` → THREE.Color
   - `state.fogColorArgb` → horizon tint (THREE.Color)
   - Derive `fogDensity` from `state.fogMin`/`state.fogMax`: `1.0 / max(1, fogMax - fogMin)` or similar (calibrate against existing dome shader's fog math)
4. **Animate `localWeather` texture offset** to slowly drift cloud coverage across the sky. Use AC wall-clock derived from `AC_LAUNCH_UNIX_EPOCH` so it's reproducible across reloads (mirror the existing `tex_offset = tex_velocity × (now - session_start) mod 1.0` pattern from Sky-G).
5. **Per-DayGroup cloud coverage**: each retail Dereth DayGroup encodes weather implicitly (Sunny, Rainy, Cloudy, etc.). Drive `coverage` uniform from the DayGroup name or from a custom lookup table; see open question #2 below.

**Gate**: capture the synthetic test page at 4 reference times (t=0.05/0.25/0.5/0.75 = dawn/noon/dusk/midnight) and verify cloud underside color varies (dawn ≈ pink, noon ≈ white, dusk ≈ orange, midnight ≈ deep blue). Use chrome-devtools-mcp `take_screenshot` against http://localhost:8765/cloud_test.html.

### Clouds-D — Integrate into scene3d (3-5 days)

**Goal**: `?renderer=3d` shows volumetric clouds rendering above Holtburg as the player walks around.

**Steps**:
1. In `scene3d/sky_dome.js` constructor (line 251+), after the existing dome + rotator setup, attach `cloudVolume` as a child of `skyCell` (Agent B integration point: between dome and rotators, OR after all rotators — TBD by visual eye-test).
2. **Render order in `skyScene`**: dome (radius 1000) → cloudVolume (extends from ~750m to ~8000m AC altitude) → rotators (celestials at ~2200-2700m native vertex distance). All under `skyCell` which is camera-anchored.
3. **Depth state on cloudVolume material**: `depthTest=true, depthWrite=false` (atmospheric haze overlay). Celestials composite over correctly.
4. **Direct-render path** (`index.js:802-828`, no SSAO): no changes — `renderer.render(skyScene, skyCamera)` renders the volume as part of skyScene. The existing `clearDepth()` between sky and world is unaffected.
5. **Composer path** (`index.js:1228-1234`, SSAO on, `postprocess.js:110-161`): the sky `RenderPass` already renders the entire skyScene → cloudVolume is rendered as part of that pass. No additional pass required unless cloud system needs G-buffer access (it doesn't — Schneider Nubis is forward-rendered).
6. **Indoor toggle**: `sky_dome.js:1541-1543` already short-circuits `renderSkyPass` when `_lastIsIndoor === true`. Free.
7. **Coexistence with `SCROLLING_CLOUD` SkyObjects (0x02 bit)**: keep them rendering as-is. They're parametric quads at fixed AC altitude; the volume sits behind/in front of them depending on z-depth. Decide visually whether to fade the quads' opacity when the volume is fully covering — open question #3.

**Gate**: `apps/holtburger-web/capture_volumetric_clouds_e2e.cjs` (new) — Playwright + Chromium with `--use-gl=swiftshader`. Capture screenshots at 4 reference times against live ACE at Tailscale `100.116.47.66` (tailnet1/tailnet1 promoted to Developer; tester is PK). Save under `/mnt/wbterminal1/tmp/claude-scratch/volumetric-clouds/` per memory `feedback_use_external_drives_for_scratch`.

### Clouds-E — Layer config tuned for AC retail aesthetics (2-3 days)

**Goal**: the three default takram `CloudLayer` channels (R/G/B) are tuned to render an AC-aesthetic sky — visible cumulus near horizon, layered altocumulus mid-altitude, wispy cirrus high.

**Steps**:
1. Survey retail AC screenshots (or the existing Dereth atlas at `docs/sample-dist/`) for cloud aesthetics by DayGroup. Identify three layer profiles:
   - **R (cumulus)**: altitude 750m, height 650m, densityScale 0.2, weatherExponent 1.0 (default — keep)
   - **G (altocumulus)**: altitude 1000m, height 1200m, densityScale 0.15, weatherExponent 1.2 (slightly more textured)
   - **B (cirrus)**: altitude 7500m, height 500m, densityScale 0.08, weatherExponent 0.5 (thin, high)
2. Bake **per-DayGroup coverage tables** (a 20-row JSON keyed by DayGroup name) and feed into the cloud volume's `coverage` uniform per frame. Calibrate against retail screenshots if available.
3. **Custom weather map** (optional, post-MVP): instead of takram's default `LocalWeather` procedural bake, supply a 2D texture authored from AC sky region data. Defer to Clouds-H if MVP coverage tables don't look retail-faithful enough.

**Gate**: visual eye-test against `docs/images/skybox-demo-sky-i/` baseline + new volumetric-on shots side-by-side. User-approved before sealing.

### Clouds-F — Quality preset matrix + swiftshader fallback (2-3 days)

**Goal**: cloud volume renders at >30 FPS in swiftshader Chromium CI at `qualityPreset='low'`, >60 FPS in real Chrome at `'high'`, and is configurable via `?cloudQuality=low|medium|high|ultra` URL param.

**Steps**:
1. Wire takram's existing `qualityPreset` enum through to a URL param (`?cloudQuality=…`).
2. **swiftshader detection**: detect via `gl.getParameter(gl.RENDERER)` matching `/swiftshader/i`; auto-select `'low'` if so.
3. **Fallback if swiftshader can't render at all**: if cloud shader compile fails or runtime FPS < 5 FPS at `'low'`, hide cloudVolume entirely. The retail-AC parametric SkyObjects still render — degrades gracefully to pre-Clouds-A skybox.
4. **Perf instrumentation**: `requestAnimationFrame` timing harness → log mean frame time over 5s windows; abort if regression > 30% vs pre-Clouds baseline.

**Gate**: `capture_volumetric_clouds_perf.cjs` (new) — measures FPS at each preset under swiftshader. PASS if low ≥ 30 FPS, medium ≥ 30 FPS, high ≥ 30 FPS (or graceful-skip with the fallback).

### Clouds-G — Capture suite (1-2 days)

**Goal**: cloud regression coverage. New bullets are additive to `capture_skybox_e2e.cjs`; cloud-specific assertions go in `capture_volumetric_clouds_e2e.cjs`.

**Cloud-specific assertions to add**:
1. `cloudVolume` exists in `skyScene.children` (or in skyCell)
2. Cloud material has expected uniforms (`uSunDirection`, `uSunColor`, `uAmbientColor`, `uHorizonColor`, `uFogDensity`)
3. Cloud uniforms update per frame (capture two consecutive frames, assert uniforms changed)
4. Sun-direction-driven cloud color varies across 4 reference times (cloud bottom RGB at dawn ≠ noon ≠ dusk ≠ midnight)
5. No `"null pointer passed to rust"` errors during cloud render
6. Cloud volume hidden when indoor (`isCurrentCellIndoor() === true`)
7. Scrolling cloud-band SkyObjects (0x02 property) still present alongside the volume (verify both layers render)

**Regression coverage on existing bullets**: re-run `capture_skybox_e2e.cjs` end-to-end; bullets 4-16 still PASS. No new SKIPs.

---

## Optional later: Clouds-H+ (post-shipping polish)

- **H — Voxel authoring** (Nubis³ 2023): paint cloud shapes via a 3D voxel grid, bake into custom shape texture. Multi-day artist tool.
- **I — Cirrus 2D overlay**: Schneider HZD keeps cirrus as a separate 2D texture above the volume rather than as a Worley-noise channel. Replaces the B-channel cirrus layer with a textured plane. Aesthetics-dependent.
- **J — Multi-scattering approximation**: Nubis Evolved 2022 drops the original `2 * BeerLambert * Powder` formula (breaks at low sun angles) for view-direction-attenuated powder. Audit takram's implementation; if they're still using the broken formula, port the Evolved fix.
- **K — Lightning + weather sync**: PhysicsScript-driven lightning flashes synced to AC weather DayGroups. Wires into the existing particle chain (memory `project_holtburger_sky_j_done_2026-05-12`).
- **L — Real cloud shadows on terrain**: ray-march cloud density from sun direction down to terrain; modulate terrain ambient. Expensive; gates on Visual-fidelity Phase 2.1 subdivision already shipped.

---

## Open questions to confirm with the user before starting

1. **Visual reference**: do you have specific retail AC screenshots / DayZ screenshots you want the result to match? Without a reference image, "looks the best" is subjective. (Optional: spike Clouds-A through Clouds-D with takram defaults, eye-test, then iterate.)
2. **Per-DayGroup coverage**: should each of the 20 retail Dereth DayGroups have a hand-authored coverage profile, or should we infer from the DayGroup name (Sunny→0.2, Rainy→0.8, etc.)? Hand-authoring is multi-day per DayGroup × 20 = potentially weeks; inference is fast but may not match retail.
3. **`SCROLLING_CLOUD` SkyObject coexistence**: keep both rendering (volume + parametric quads), fade quads to zero when volume covers, or replace quads entirely with volume? Visually-driven decision; defer to eye-test post-Clouds-D.
4. **TSL future-proofing**: takram targets r170+ and is moving to TSL. Our r137 polyfill is a stopgap. Should we plan a separate "upgrade to r170 + TSL" workstream BEFORE Clouds-A so we don't carry the polyfill long-term? Adds 1-2 weeks of risk; could also just commit to the polyfill and revisit.
5. **Custom 3D texture bakes**: do we keep takram's procedural bakes (`CloudShape.ts` → 128³ Perlin-Worley) or author our own per Schneider HZD slide parameters? Procedural is faster to ship; authored may look more "AC-flavored". Defer to Clouds-H if MVP looks good enough.

---

## How to validate (per project conventions)

- **Gates**: `cargo test --workspace` 1352/0/1 (current baseline, do not regress), `node smoke_test.cjs` 173/0/1, `wasm-pack build --target {nodejs,web}` both green.
- **Capture suite**: `capture_skybox_e2e.cjs` bullets 4-16 + new `capture_volumetric_clouds_e2e.cjs` bullets above. Run with `--use-gl=swiftshader` under Playwright + Chromium.
- **Live-server validation**: ACE on Tailscale `100.116.47.66` (tailnet1/tailnet1, Developer-promoted). Tester is PK. Account access-level promotion if needed:
  ```bash
  mariadb -uace -pace -e "UPDATE ace_auth.account SET accessLevel = 4 WHERE accountName LIKE 'phaseN%';"
  ```
- **Scratch outputs** under `/mnt/wbterminal1/tmp/claude-scratch/volumetric-clouds/` per `feedback_use_external_drives_for_scratch`. System disk (sda2) fluctuates 85-96% used — never write logs to `/` or `/tmp`.

---

## How to use the new plugins

- **context7** (Upstash MCP) — for anything Three.js version-specific. Use even when you think you know. Workflow: `resolve-library-id` ("Three.js") → pick `/mrdoob/three.js` (highest snippet count + High reputation) → `query-docs` with a specific question. Cap 3 calls per question. Useful queries: r137 `Data3DTexture` API specifics, `EffectComposer` pass ordering details, deprecated APIs we're still using.
- **typescript-language-server LSP** — for cross-file symbol nav in the renderer code. `LSP` MCP tool: `goToDefinition`, `findReferences`, `hover`, `documentSymbol`. Wired at `~/.local/bin/typescript-language-server`. Works on `.ts/.tsx/.js/.cjs/.mjs/.jsx`. See `reference_claude_lsp_plugins`.
- **rust-analyzer LSP** — for `crates/holtburger-world/src/sky.rs` symbol nav and finding callers of `getSkyState()` / `getSkyObjectStates()`.
- **chrome-devtools-mcp** — for visual capture during eye-testing. `take_screenshot`, `navigate_page`, `wait_for`. Use with swiftshader for CI parity; with normal GL for visual-quality reference shots.

---

## Risks + mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| takram's r137 polyfill is more than 1 line (e.g. they use TSL-specific imports we missed) | Low | Spike Clouds-A first; if polyfill creep > 1 day, escalate to user before Clouds-B-G commit. |
| Bruneton stubs produce visually wrong lighting (washed out, wrong color) | Medium | The non-accurate path uses precomputed varyings; our stubs only feed those. Validate Clouds-B gate with synthetic-constant test page BEFORE Clouds-C plumbing. |
| `qualityPreset='low'` still too slow on swiftshader | Low-Medium | Clouds-F has the graceful-skip fallback. Worst case: volumetric clouds are a high-end-GPU feature; swiftshader users see parametric skybox unchanged. |
| Visual result doesn't match user's "DayZ-tier" expectation | Medium | Open question #1 + early eye-tests at Clouds-D + Clouds-E gates. User-approved before sealing. |
| Coexistence with retail `SCROLLING_CLOUD` SkyObjects looks weird (double-clouds) | Medium | Open question #3; if visually broken, fade parametric quads to zero opacity when `coverage > 0.5` (one-line uniform). |
| TSL pressure (takram moves on, we're stuck on r137 fork) | Long-term | Open question #4; revisit at Clouds-G + 3 months. |

---

## References

**Repos**:
- [takram-design-engineering/three-geospatial](https://github.com/takram-design-engineering/three-geospatial) (MIT) — the fork target
- [`@takram/three-clouds` Storybook](https://takram-design-engineering.github.io/three-geospatial/?path=/story/clouds-clouds--basic) — live demos: `Basic`, `CustomLayers`, `WorldOriginRebasing`, `Vanilla`, `Minimal Setup`

**Papers (Schneider Nubis)**:
- [HZD 2015: "The Real-Time Volumetric Cloudscapes of Horizon: Zero Dawn"](https://advances.realtimerendering.com/s2015/The%20Real-time%20Volumetric%20Cloudscapes%20of%20Horizon%20-%20Zero%20Dawn%20-%20ARTR.pdf) — the foundational paper
- [Nubis Cubed (Advances 2023)](https://advances.realtimerendering.com/s2023/Nubis%20Cubed%20(Advances%202023).pdf) — voxel-authoring grid
- [Guerrilla mirror](https://www.guerrilla-games.com/read/nubis-evolved) — Nubis Evolved 2022 (drops the broken Beer-powder formula)

**Reference implementation** (for cross-check):
- [adrianderstroff/realtime-clouds](https://github.com/adrianderstroff/realtime-clouds) — standalone OpenGL port of Schneider HZD; reads cleaner than takram's takram-flavored TSX

**Three.js**:
- [r137 release notes](https://github.com/mrdoob/three.js/releases/tag/r137) — confirms `DataTexture3D` → `Data3DTexture` rename
- [webgl_volume_cloud example](https://threejs.org/examples/webgl_volume_cloud.html) — canonical backside-mesh raymarch
- [Data3DTexture docs](https://threejs.org/docs/pages/Data3DTexture.html)

**Memory cross-refs**:
- `project_holtburger_skybox_done_2026-05-11` (Sky-A→Sky-I architecture + lessons)
- `project_holtburger_skybox_properties_flags` (SkyObject bit decode)
- `project_holtburger_sky_j_done_2026-05-12` (particle chain — coexisting weather/lightning later)
- `project_emit_dynamic_site` (Phase 1-6 architecture baseline)
- `reference_context7_plugin` + `reference_claude_lsp_plugins` (plugins available this session)
- `feedback_*` rules (`base_dats_only`, `no_phatac`, `ground_in_real_wire_data`, `no_partial_demos`, `use_external_drives_for_scratch`, `attribution_precision`)

**Grounding agents' raw findings** (read these for verification if any of the above looks off):
- Takram source analysis report (session 2026-05-15) — concrete file:line at `vendor/takram-three-clouds/{CloudsMaterial.ts:21-30, uniforms.ts:188-216, CloudLayers.ts:31-68, qualityPresets.ts:59-121}` + GLSL `clouds.frag:{17-30, 419-446, 700-715}` / `clouds.vert:{4-17, 43-62}`
- Holtburger-web sky integration audit (session 2026-05-15) — integration seam at `skyCell` (child of `skyScene`), under `sky_dome.js:560-745` (`populateCelestialBodies`) and `sky_dome.js:1536-1561` (`renderSkyPass`). DayGroup state flow via `loop.js:257` (`skyLightingController.tick`) → `loop.js:277` (`skyDome.tick`)
- Schneider Nubis + Three.js r137 primitives report (session 2026-05-15) — 128³ RGBA shape + 32³ RGB detail + 2D RGB weather map; r137 has `Data3DTexture` (NOT `DataTexture3D`); use `UnsignedByteType` for swiftshader compat

---

## When you're done

- Update `MEMORY.md` index with one tight line: `[Volumetric clouds shipped YYYY-MM-DD](project_volumetric_clouds_done_YYYY-MM-DD.md) — Clouds-A→G shipped via N commits; fork of takram-three-clouds + r137 polyfill + Bruneton decouple + DayGroup state bridge`
- Write the `project_volumetric_clouds_done_YYYY-MM-DD.md` memory body with: commits landed, test counts (cargo / smoke / capture), the new files added under `vendor/takram-three-clouds/`, key gotchas you encountered NOT documented here, and any open follow-ons that didn't fit in Clouds-A-G
- If you uncovered facts that contradict this handoff doc (paper details, takram source changed since 2026-05-15, etc.), update this file in-place and note in the "Status" line at the top
- Squash the worktree if you used one. Confirm `cargo test` + smoke + new capture all green on master before declaring done.

**Status**:
- 2026-05-15 — handoff doc written; no code work started. Ready for team-agent pickup.
- 2026-05-15 — **Clouds-A foundation shipped.** Vendor `vendor/takram-three-clouds/` (TS source + assets, ~424 KB, r3f/ kept but unused), peer-dep CDN importmap entries (postprocessing@**6.39.1** not 6.36.7 — see below), browser-side load smoke at `cloud_load_smoke.{html,cjs}` PASS under swiftshader. `node smoke_test.cjs` 224/0/0 (no regression). See "Corrections & deltas vs original plan" below.
- 2026-05-15 — **Clouds-D live integration shipped (plumbing under swiftshader; visible-clouds gate on user's 1070 Ti).** `scene3d/cloud_overlay.js` owns the cloud volume + fullscreen overlay scene. `?renderer=3d&clouds=on` URL flag opts in (default off, no regression). `index.html` importmap now points `@takram/three-clouds` at the local vendored build (so brunetonStubs.glsl is active). SkyDome.renderSkyPass calls `cloudOverlay.preRender(renderer)` → bakes cloud raymarch into the internal cloudsPass.outputBuffer, then `renderer.render(skyScene, skyCamera)` → standard sky paint, then `cloudOverlay.renderOverlay(renderer)` → fullscreen quad composites the cloud buffer over the sky pixels with `transparent + premultipliedAlpha`. Indoor flip is automatic via existing `renderSkyPass` short-circuit. `node smoke_test.cjs` 225/0/0 (new Clouds-D source-pattern check + no regressions). Live page load at `?renderer=3d&clouds=on` under headless swiftshader: 0 console errors, 0 warnings. **User eye-test instructions** in "How to eye-test Clouds-D" below.
- 2026-05-15 — **Clouds-D-mini plumbing gate shipped.** `cloud_render_test.html` validates the full pmndrs EffectComposer + RenderPass + EffectPass(CloudsEffect) pipeline with procedural textures (LocalWeather + CloudShape + CloudShapeDetail + Turbulence) under swiftshader. Composer wires cleanly, 5 frames render with 0 errors, effect output overwrites the clear color → plumbing is valid. Output is uniform `RGB(99, 110, 137)` (vs clear `RGB(32, 40, 64)`), indicating **3D-texture procedural bake fails silently under swiftshader** — the raymarch sees zero density and returns uniform ambient. Real GPU needed for visible clouds. NOT wired into loop.js. See "Swiftshader limitation for Clouds-D" below. `node smoke_test.cjs` 224/0/0.
- 2026-05-15 — **Clouds-C state bridge shipped.** `scene3d/cloud_volume.js` (~190 LoC) wraps `CloudsEffect` and exposes `tick(state, objStates)` that maps AC `SkyState` → 5 DayGroup uniforms + `sunDirection`. ARGB decode + `sin(h)cos(p), sin(p), -cos(h)cos(p)` unit-vec sun direction match `sky_lighting.js`'s existing conventions. `cloud_bridge_test.html` validates the bridge against 4 mocked SkyStates (midnight/dawn/noon/dusk): PASS — sun-color RGB matches within 0.005 of the decoded ARGB, sun-dir unit-length within 0.01, `uFogDensity` finite + positive. Module NOT wired into `loop.js` yet — that's Clouds-D. `node smoke_test.cjs` 224/0/0.
- 2026-05-15 — **Clouds-B Bruneton decouple shipped.** esbuild-based local build pipeline (`vendor/takram-three-clouds/build.mjs`) handles `?raw` GLSL imports + legacy-TS decorators + tiny-invariant inlining + NODE_ENV substitution. Bruneton runtime swap via JS-side `resolveIncludes()` substitution — `CloudsMaterial.ts` imports `runtime` from local `brunetonStubs.glsl` (95 LoC) instead of `@takram/three-atmosphere/shaders/bruneton`; clouds.frag/vert source untouched. 5 new uniforms (`uSunColor`, `uAmbientColor`, `uHorizonColor`, `uFogDensity`, `uSunIntensity`) wired into the material. Synthetic-input gate at `cloud_test.html` PASS under swiftshader: shader compiles in 3 configs (dawn/noon/dusk) with our new uniforms; the 3 short-form lighting fns (GetSunAndSkyIrradiance / GetSunAndSkyScalarIrradiance / GetSkyRadianceToPoint) bind to our stubs. Visible clouds NOT yet rendered (needs texture-bake + EffectComposer wiring — that's Clouds-D). `node smoke_test.cjs` 224/0/0 (no regression). Tactical deviations from the handoff's surgery plan in "Clouds-B deviations" below.

## Clouds-B deviations from the handoff plan

The handoff prescribed full TS-side decoupling (drop AtmosphereMaterialBase / AtmosphereParameters / AtmosphereUniforms wholesale). The actual surgery was more surgical:

1. **AtmosphereMaterialBase parent class kept on `CloudsMaterial`.** Not replaced with `ShaderMaterial`. The base class adds atmosphere-aware setup that's inert without `<Atmosphere date={...}>` driver — but doesn't break either. Replacing the parent is a Clouds-B-extended chore for clean decouple; deferred.
2. **`AtmosphereUniforms` struct kept in `uniforms.ts`** (inert). New `DayGroupUniforms`-equivalent uniforms live alongside it inside `CloudsMaterial.ts`'s uniforms map (not as a struct in uniforms.ts). The 5 names: `uSunColor`, `uAmbientColor`, `uHorizonColor`, `uFogDensity`, `uSunIntensity`. Wire-up from `skyLightingController._lastState` is Clouds-C's job.
3. **GLSL `#include "atmosphere/bruneton/runtime"` literally unchanged** in clouds.frag/vert. The swap happens at the JS-side `resolveIncludes()` call in `CloudsMaterial.ts`: the imported `runtime` symbol now points at our `brunetonStubs.glsl` instead of takram's atmosphere package. Same functional effect with less shader-source churn.
4. **`ACCURATE_SUN_SKY_LIGHT` macro disabling NOT explicitly forced.** It's already inactive by default (qualityPresets don't define it). If a future config sets `accurateSunSkyLight=true`, the precomputed-varying path is taken — and our stubs already fill those varyings via the vertex-stage call to `GetSunAndSkyScalarIrradiance`. So it should still work, but eye-test before enabling.

These keep Clouds-B as a tight, reversible chunk while still meeting the stated gate. The cleaner full-decouple stays available as a Clouds-B-extended task if/when it becomes load-bearing.

## How to eye-test Clouds-D (real GPU)

After the Clouds-D commit, this is the user-facing flow for the 1070 Ti eye-test:

1. **Open the dev page on real Chrome (NOT headless swiftshader)** — Tailscale-served at `http://100.x.x.x:7080/apps/holtburger-web/index.html?renderer=3d&clouds=on`. The key URL params:
   - `?renderer=3d` — opt into the 3D path (defaults to PixiJS 2D)
   - `&clouds=on` — opt into volumetric clouds
   - (optional) `&debugSky=true` etc. as documented elsewhere
2. **Log in + spawn** as usual. The cloud overlay constructs at init3D after SkyDome — look for `[clouds-d] CloudOverlay wired into SkyDome (?clouds=on). Visible clouds require a real GPU — swiftshader output is uniform.` in the console.
3. **Look up** — clouds should appear above the dome's blue gradient, illuminated by the AC sun via brunetonStubs.glsl's uSunColor / uAmbientColor / uHorizonColor / uFogDensity / uSunIntensity uniforms (all driven from the live DayGroup state per Clouds-C).
4. **What "looks right" baseline**: Schneider-style cumulus + altocumulus + cirrus layered cloudscape, with lighting that warms at dawn (`?skytime=0.05`) → bright at noon (`?skytime=0.5`) → orange at dusk (`?skytime=0.7`) → near-black at midnight (`?skytime=0.0`). Use `setSkyTimeOverride(t)` or `?skytime=accel` to fast-cycle the day if the natural wall-clock is in an awkward window.
5. **What to file as bugs if visible** (vs Clouds-E iteration vs swiftshader limit):
   - Page hangs > 30s on init3D after seeing `[clouds-d] CloudOverlay wired …` — likely a real-GPU shader compile slow path (procedural 3D texture bake takes some seconds even on real GPU); wait it out before filing.
   - Console errors mentioning shader compile or link failures — file with full error text.
   - Black canvas where sky should be — probably a render-order bug in our overlay. Try `?clouds=off` (or just remove the flag) to confirm the existing sky still works; if so the bug is in cloud_overlay.js or sky_dome.js's renderSkyPass integration.
   - Clouds visible but ugly aesthetics — that's a Clouds-E concern (layer tuning for AC retail look); not a bug per se.
6. **Fallback if visible clouds don't appear**: try `?clouds=on&cloudCoverage=0.6` (TODO: expose via URL — not yet wired; if needed, edit `cloud_overlay.js` default at construction or set `effect.clouds.coverage = 0.6` after init). The takram default is conservative.
7. **Performance**: 1070 Ti should handle `qualityPreset=high` defaults. If FPS drops below 30, the URL flag for quality is a Clouds-F item (not yet wired). Manual override: `effect.qualityPreset = 'medium'` in dev console.

When the eye-test confirms visible clouds → file a Clouds-E memory with the aesthetic gaps + DayGroup tuning needed. When it confirms NO clouds → check console for shader errors first, then suspect cloud_overlay.js's premultipliedAlpha + transparent settings (may need adjustment for the cloud effect's actual output format).

## Swiftshader limitation for Clouds-D (discovered via Clouds-D-mini)

`cloud_render_test.html` proves the full effect pipeline runs without errors under headless swiftshader Chromium — but the output is uniform RGB instead of textured clouds. Pixel readback after 5 composer frames: `avg=[99, 110, 137], spread=[0, 0, 0]`. Clear color was `RGB(32, 40, 64)`, so the cloud effect IS writing to the buffer (proves the composite ran) — but every pixel is the same color, which means the raymarch saw zero cloud density everywhere.

**Diagnosis**: the 3D-texture procedural bake path (`Procedural3DTextureBase.render`) needs render-to-3D-texture support. Headless swiftshader Chromium technically advertises WebGL2 + `EXT_color_buffer_float`, but `setRenderTarget(data3DRenderTarget)` followed by quad rendering produces zero pixels — silently. No `console.error`, no `gl.getError()` flag. Texture sampling in the raymarch then returns vec4(0) everywhere → cloud density = 0 → no clouds.

**Implications for Clouds-D**:
- The integration code (loop.js wiring, skyCell attachment, render-pass ordering) CAN be written + plumbing-smoked under swiftshader.
- Visible-clouds eye-test MUST happen on real GPU hardware (native Chrome, or Tailscale-served page on the user's device, not headless CI). The `capture_volumetric_clouds_e2e.cjs` from the original Clouds-G plan should track "plumbing PASS" + "visible-clouds PASS" as separate bullets, and the latter is GPU-conditional.
- Pre-baked static 3D textures (load from CDN via custom loader for `assets/shape.bin` etc.) are an alternative for CI parity. The Worley noise bake at takram's build time is captured in the .bin files — we could load those instead of regenerating procedurally. Saves CI a major hassle; bigger payload. Decide at Clouds-D commit time.
- `feedback_no_partial_demos`: don't claim "clouds rendering" until visually validated on real hardware. Plumbing-pass is one milestone; visible-clouds is a separate, real-GPU-only milestone.

## Clouds-B build pipeline ergonomics

- Source-edit → `cd vendor/takram-three-clouds && node build.mjs` → 60-80 ms rebuild
- `node build.mjs --watch` for hot iteration
- Output: `vendor/takram-three-clouds/build/{index.js, index.js.map}` (~170 KB minified-ish)
- Externals: `three`, `three/addons/*`, `postprocessing`, `@takram/three-atmosphere` (+ shaders/bruneton subpath), `@takram/three-geospatial` (+ shaders subpath). `tiny-invariant` inlined to avoid its top-level `process.env.NODE_ENV` ref.
- Importmap to local build: see `cloud_build_smoke.html` for the pattern. `index.html` still uses the CDN bundle (un-modified) — point it at the local build when Clouds-D wires the actual integration. CDN smoke (`cloud_load_smoke.html`) stays as a regression check for upstream parity.
- Decorators: takram source uses legacy TS decorators (`experimentalDecorators: true` + `emitDecoratorMetadata: true` per `tsconfig.base.json`). `build.mjs` passes `tsconfigRaw` with those flags.

## Corrections & deltas vs original plan (Clouds-A grounding)

While executing Clouds-A, the following load-bearing assumptions in this doc turned out to be wrong. They are corrected here in-place so future phases don't repeat the mistakes.

1. **Three.js version is r184, not r137.** `external/holtburger/apps/holtburger-web/index.html`'s importmap already pinned `three@0.184.0`, with `three.REVISION === '184'` confirmed in browser. The handoff's r137 caveat (in "Critical constraints" + "Quick mental model" + Clouds-A step 3) is obsolete; **no `DataArrayTexture` polyfill is needed** (the rename `DataTexture2DArray → DataArrayTexture` happened in r144, well before r184). Likewise, `RGBFormat`-removal-in-r137 is already a known constraint in our existing scene3d code (see `terrain.js` comment). The "TSL not adopted (we're firmly pre-TSL)" line is also wrong — r184 *is* TSL-era — but we still use `onBeforeCompile`/`RawShaderMaterial` by convention, so the practical advice (don't accept TSL-only forks) stands.
2. **pmndrs `postprocessing` needs ≥ 6.39.x for r184 compat.** takram-clouds@0.7.6 declared peer `postprocessing >= 6.36.7`, but **6.36.7's bundle does `import { LuminanceFormat } from 'three'`** and r184 no longer exports that name (silent removal). Browser-load throws `SyntaxError: The requested module 'three' does not provide an export named 'LuminanceFormat'`. **6.39.1** has peer `three >= 0.168.0 < 0.185.0` and no `LuminanceFormat` reference — pinned in the importmap. If we ever bump three past 0.185, audit postprocessing's peer constraint again.
3. **Project has no build pipeline.** holtburger-web is wasm-driven (`Cargo.toml`, `pkg*/` from wasm-pack); JS uses ES-module-via-CDN-importmap. Vite is *not* available, so the takram source's `import X from './shaders/Y.glsl?raw'` pattern is not directly runnable. Clouds-A sidesteps this by **using the npm-prebuilt CDN bundle** for runtime, with the TS source vendored side-by-side for reference + future modification. When Clouds-B starts modifying the source (Bruneton decouple), it must either (a) set up a one-shot tsc/esbuild step or (b) patch the prebuilt bundle directly. Picking (a) is cleaner long-term; (b) is faster for an MVP. Pick at Clouds-B start.
4. **TypeScript build gate (Clouds-A.7) deferred to Clouds-B.** Without a build pipeline, "vendor compiles against r184 types" isn't load-bearing for Clouds-A. The browser-side smoke (`cloud_load_smoke.cjs`) is the actual gate — it validates that the published bundle's exports bind cleanly under our importmap.
5. **CDN importmap entries pinned (in `index.html` + `cloud_load_smoke.html`)**:
   - `@takram/three-clouds@0.7.6`
   - `@takram/three-atmosphere@0.19.1` + `/build/shaders/bruneton.js` subpath
   - `@takram/three-geospatial@0.9.1` + `/build/shaders.js` subpath
   - `postprocessing@6.39.1` (NOT 6.36.7 — see point 2)
   - `tiny-invariant@1.3.3` (inlined by the prebuilt bundle currently, so unused at runtime — kept for future source-compile path)
   - All transitive `./sharedN.js` imports resolve relatively against their CDN URLs — no extra entries needed.
6. **Required-exports spot-check (load smoke)**: `CloudsEffect`, `CloudLayer`, `CloudLayers` confirmed exported from `@takram/three-clouds`. `qualityPresets` (the const, not the type) is NOT in `index.ts` re-exports — Clouds-F's quality-preset wiring will need a subpath import like `@takram/three-clouds/qualityPresets` if available, or we add it to a fork's `index.ts`. The full Clouds-A export surface (17 names): `CLOUD_SHAPE_DETAIL_TEXTURE_SIZE`, `CLOUD_SHAPE_TEXTURE_SIZE`, `CloudLayer`, `CloudLayers`, `CloudShape`, `CloudShapeDetail`, `CloudsEffect`, `DEFAULT_LOCAL_WEATHER_URL`, `DEFAULT_SHAPE_DETAIL_URL`, `DEFAULT_SHAPE_URL`, `DEFAULT_TURBULENCE_URL`, `DensityProfile`, `LocalWeather`, `Procedural3DTextureBase`, `ProceduralTextureBase`, `Turbulence`, `cloudsPassOptionsDefaults`.
7. **`DEFAULT_*_URL` resolves to npm package paths.** Loading those URLs unmodified will hit the CDN-served assets at `https://cdn.jsdelivr.net/npm/@takram/three-clouds@0.7.6/assets/{shape.bin, shape_detail.bin, local_weather.png, turbulence.png}`. We also have those assets vendored locally at `vendor/takram-three-clouds/assets/`. Clouds-D needs to decide whether to use the CDN URLs as-is (simpler, no app changes) or re-point to vendored paths (offline-safe).
