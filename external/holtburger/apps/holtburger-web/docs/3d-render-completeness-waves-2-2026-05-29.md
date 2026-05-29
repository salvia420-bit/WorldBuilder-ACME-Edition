# 3D Render Completeness — Waves 2 (team-agent handoff)

**Date:** 2026-05-29
**Provenance:** 6-agent parallel sweep cross-referencing ACE DatLoader + `acclient.c/.h/.txt` (retail) + melt + chorizite, with quantitative grounding from `~/ac_base_dats/client_portal.dat`. Every gap below is **NEW** — verified absent from the already-shipped work (render-math R1–R4, AnimationHook dispatch, Surface Tier-1, and the 8-item render-completeness backlog committed `7a254446`/`aa15aa40`).

**This doc is a waves handoff optimized for PARALLELISM.** Each **Wave-1 agent owns a disjoint file domain**, so all 6 run concurrently with no merge conflicts (one shared file — `src/lib.rs` — is touched by 3 agents in *disjoint functions*; use `isolation: 'worktree'` and the documented regions for a clean merge). **Wave 2** holds the items that share `materials.js` / `entities.js` with Wave-1 agents and must land *after* them.

> Validation is invisible (1070 not required to build): `cargo check --target wasm32-unknown-unknown`, `node --check`, host DAT inspection via `cargo run -p holtburger-dat --example parse_dat_record`. GPU eye-test on the 1070 (firefox-driver `:9224`, headless/off-screen per [[1070-tests-never-on-screen]]) is the final proof. Default-on vs flag-gated is called out per item; default-on items MUST be fail-soft.

---

## WAVE 1 — six parallel agents (highest value, disjoint files)

### Agent 1 · TERRAIN  — owns `scene3d/terrain.js` + `src/lib.rs` (terrain-LUT region only)
**T1 — Base terrain texture tiling ignored (HIGH, default-path, S).** Retail `TerrainTex.TexTiling == 2` for **all 33 types** (dumped from real Region 0x13000000); consumed by `TexMerge::CopyAndTile`/`MergeTexture` (`acclient.c:304685,304854`). Holtburger's `atlasUvFor(code, cellUv)` (`terrain.js:927-929`) tiles 1×; `tex_tiling` is parsed (`region.rs:540,556`) but no renderer consumes it (detail tiling IS wired via `uDetailTexTiling`). → every base texture renders ~2× too large on the **always-on default path**. Fix: `fract(cellUv * tiling)` before the atlas sample (atlas layers are ClampToEdge, so raw `*2` clamps — must `fract`), plumb `uBaseTexTiling[33]` like `uDetailTexTiling` (`terrain.js:2279`, `lib.rs:3035-3055`). Even a hardcoded `×2` captures ~all of it.
**T2 — Road overlay not rendered in TexMerge path (MEDIUM, opt-in `?texMerge`, S-M).** Rust selection bakes road into GPU slots 4-5 (`terrain_merge.rs:425-438`) and 3 road masks load at `uAlphaMasks` layers 5-7, but the shader overlay loop is `for (s=1; s<4)` (`terrain.js:1101`) — slots 4-5 never read. Fix: extend loop to `s<6` (slots already carry road atlas layer 32 + mask + rotation) and gate off the legacy bilinear road painter (`terrain.js:1193-1208`).
**T3 — Retire the bilinear road painter (LOW, S, fold into T2).** Once T2 draws authored road masks, delete the `vGridUv * uRoadTileScale` smoothstep approximation. Do NOT parallelize with T2 — same block.
**Parallel-safe:** yes vs all other Wave-1 agents. lib.rs region = terrain-LUT export (~`lib.rs:3035`), disjoint from Agents 2/5.

### Agent 2 · LIGHTING / light-response — owns `scene3d/lighting.js` + `atmosphere_lights.js` + `materials.js` + `src/lib.rs` (light-range region)
> This agent is the **single owner of `materials.js` in Wave 1** (Agent G2/wrap is deferred to Wave 2). Fold the existing `?lightClamp=retail` (R2.B) into ONE "retail light response" patch rather than competing `onBeforeCompile` chains.
**L1 — AC diurnal ambient never drives the scene ambient (HIGHEST, M).** Retail lit = `sun·NdotL + ambColor·ambient_level`, clamped [0,1], `ambient_level` floored at `min_ambient=0.2` (`acclient.c:353859-353900,307024`). Holtburger parses + time-lerps it to `SkyState.amb_bright`/`amb_color_argb` (`region.rs:236`→`sky_lighting.js:52`) but **nothing consumes it** (`cloud_volume.js:50` annotates "unused here"); legacy ambient is a flat `0.5/0.7` constant (`lighting.js:69`), zeroed when atmosphere is on; the `SkyLightProbe` has no `amb_bright`/floor term. Fix: drive `ambient.intensity`+`color` (legacy) / probe intensity (atmosphere) from the snapshot with the 0.2 floor.
**L2 — SetupModel light range omits `static_light_factor` 1.3× (HIGH, S).** Retail `range = falloff * 1.3` (`acclient.c:454606,45774`); holtburger maps `falloff`→three `distance` verbatim (`lighting.js:1085`). → every lantern/brazier/torch reaches ~30% short. Fix: `falloff * 1.3` (cleanest at `lib.rs:8054`).
**L3 — Point-light falloff is inverse-square, not AC linear (MED-HIGH, M).** `LIGHT_DECAY=2.0` (`lighting.js:335`) vs retail `1 - dist/range` (`acclient.c:454616`). Fix: patch `getDistanceAttenuation`→`max(0,1-d/range)` via `onBeforeCompile` — **same `lights_fragment_begin` region as R2.B; combine them.** Flag-gate with R2.B's family.
**L4 — PBR specular on metal/lava over-responds vs retail flat-diffuse (MED, S, flag).** Retail FFP has no specular (`SetSurface` never sets `Specular`); holtburger's Metal category uses `metalness:0.9,roughness:0.3` (`materials.js:150`). Fix: `?flatDiffuse=retail` preset → metalness 0 / roughness ~1 for Metal/Lava (don't overwrite the classifier defaults unconditionally).
**Parallel-safe:** yes. lib.rs region = `:8054` (light range), disjoint from Agents 1/5. **Owns materials.js exclusively this wave.**

### Agent 3 · STATICS-LOD — owns `scene3d/statics.js`
**G1 — `degrade_mode` is a billboard-orientation flag, completely unconsumed (MED, M).** Correction to prior assumptions: `degrade_mode` is NOT a pixel/distance selector — it's per-LOD-band billboard mode in `CPhysicsPart::calc_draw_frame` (`acclient.c:315074`): 1=fixed, 2=full billboard, 3/4/5=axis-constrained. Parsed (`degrade_info.rs:36`, exposed `lib.rs:6770`), never read for orientation. → distant trees/foliage render edge-on instead of facing camera. Fix: per-frame billboard update on the degraded LOD leaf keyed to the band's mode (reuse R3.B's camera-projection scratch).
**G3 — N-band LOD: only band[0]+min_dist consumed (LOW refinement, M, pair with G1).** Retail `GfxObjDegradeInfo::get_degrade` walks ALL bands by `ideal_dist`/`max_dist`×bias (`acclient.c:332356`); the just-shipped single-band path uses only `bands[0].min_dist` (`statics.js:485`). Fix: multi-level `THREE.LOD` from all bands (JSON already complete).
**G4 — Transparent instances in one InstancedMesh have no per-instance sort (LOW, M).** Statics batch every modelId into InstancedMesh regardless of transparency (`statics.js:779`); three can't depth-sort instances. Fix: force plain Mesh for transparent-material statics, or split batches by transparency. (Most transparent scenery is ClipMap/alphaTest = sort-independent, so low real-world impact.)
**Parallel-safe:** yes vs all. Sole owner of statics.js.

### Agent 4 · PARTICLES — owns `scene3d/particles/*`
**P1 — Per-particle `scale_rand`/`trans_rand` jitter never applied (HIGH, S).** Retail jitters per particle in `EmitParticle` (`acclient.c:331054`); 56%/29% of 2051 emitters carry non-zero rand. Holtburger assigns raw `startScale/finalScale/...` (`particle.js:264`); the 4 `getRandom*` helpers (`particle_emitter_info.js:123-150`) have ZERO callers. → every particle in an emitter is an identical clone (flames/dust/sparks look stamped). Fix: call the jitter helpers in `particle_emitter.js:279`; **also fix 3 helpers from multiply→additive** (`r*rand + value`, not `*value`) — only `getRandomStartScale` is correct.
**P2 — `initEnd` burst uses `total_particles`, not `initial_particles` (MED, S).** Retail loops `initial_particles` (`acclient.c:331278`); holtburger loops `totalParticles` (`particle_emitter.js:354`). → continuous emitters (198) lose their t=0 seed; one-shots over-spawn. `initialParticles` parsed (`particle_emitter.rs:79`), unused. Fix: one identifier.
**Non-gaps (don't pursue):** EmitterType (3) + ParticleType (13) fully covered; 2-point start/final scale+translucency lerp matches retail; there is **no "middle scale" or RGB color-over-life in retail** (`acclient.h:52436`).
**Parallel-safe:** yes vs all. Self-contained in `scene3d/particles/`.

### Agent 5 · ENTITY-MOTION + PHYSICS-HOOKS — owns `scene3d/entities.js` + `scene3d/play_effect_vfx.js` + `src/lib.rs` (motion/EntityUpdate region)
> Bundled because **all touch `entities.js`** — one owner avoids intra-file conflict. KEY: `action.setEffectiveTimeScale` is already written by the gated T11 velScale path (`entities.js:6343`); A1/A3 must **multiply into** it, not both-write.
**A1 — Per-motion `speed` (playspeed) decoded on the wire but dropped at the JS bridge (MED-HIGH, M).** Retail `Framerate *= speed` (ACE `AnimData.cs:17`); wire `forward_speed` is decoded (`movement/types.rs:233`) but the kind=MOTION EntityUpdate surfaces only command+stance (`lib.rs:28683`); `setMotion` has no speed arg. → hasted/slowed/quickness all animate at fixed tempo. Fix: add `motion_speed` to EntityUpdate + getter + `setMotion` arg → `setEffectiveTimeScale`.
**A3 — Attack/cast one-shots ignore server attack-speed (MED, S after A1).** `_tryPlayLink` normalizes to authored duration only (`entities.js:3765`); multiply by A1's SpeedMod.
**P3 — PhysicsScript walker dispatches only 4 of 12 hook types (MED, M).** Both consumers inline a narrow dispatch (`entities.js:5601,5649`; `play_effect_vfx.js:1038`) handling only Sound/SoundTweaked/CreateParticle; **954 of 4248 retail scripts drop hooks** — SoundTable(2)×626 (walker even checks the wrong sound type), Scale(12)×122, **CallPES(19)×354 (recursive sub-script, never followed)**. The full executor `_executeHook` (`entities.js:6649`) already handles all 27 types. Fix: route the walker through `_executeHook`; add a CallPES recursion depth-guard.
**Parallel-safe:** yes vs all. lib.rs region = EntityUpdate/motion (~`:15896,:28683`), disjoint from Agents 1/2.

### Agent 6 · WEATHER — owns `scene3d/weather/*` + `sky_dome.js` + `daygroup_weather.js` + `scene3d/loop.js` (weather tick) + `crates/holtburger-world/src/sky.rs`
> ACE has **no server-side weather** — the authoritative signal is purely client-side: active `dayGroupIndex` + the weather SkyObjects in it.
**W1 — DAT-authored weather SkyObjects are dead; synthetic Three.js rain replaced real AC weather (HIGHEST weather, L).** Retail weather = per-DayGroup SkyObjects: streak GfxObjs `0x01004C42/44` (heavy UV-scroll) + SetupModel rain `0x02000588/589/0xBA6` carrying PhysicsScript droplets `0x33000428/...`, with begin/end time windows. Fully decoded in `sky.rs:88-150` (`SkyObjectSnapshot` has properties/begin_time/end_time/tex_velocity) but the parametric SkyObject renderer was gutted in K.6 — `sky_dome.js:129` `setParametricSkyObjectsVisible` is a no-op stub. Fix: re-add a minimal SkyObject billboard host (UV-scroll, gate on props bits + begin/end window); droplets via the existing PhysicsScript chain walker.
**W4 — Weather profile table is fabricated, not from real DayGroups (MED, M, pair with W1).** `daygroup_weather.js:25-66` hard-codes storm flags ("Order is INFERRED"). Fix: derive `is_storm`/precip-type from "does the active DayGroup expose a weather SkyObject in its time window?" (`sky.rs` snapshot).
**W2 — No snow; `is_storm` boolean can't express precip type (MED-HIGH, M).** `manager.js:60` collapses to one `RainSystem`; `daygroup_weather.js:43` even defines snow profiles (idx 8/9) that never render. Fix: a SnowSystem selected by `temperature_C`/streak-mesh type.
**W3 — Weather only updates when `?clouds=on` → inert on default path (HIGH-but-invisible, S).** The only `updateFromDayGroup` caller is `cloud_volume.js:209`. Fix: move the weather tick into a clouds-independent per-frame hook (`loop.js`) reading `skyLightingController._lastState`; guard double-drive when clouds ARE on.
**W5 — No indoor/cover occlusion (rain falls inside dungeons); constant wind (MED, S).** No indoor check in `weather/*` though `sky_dome.js:150` already reads `isCurrentCellIndoor()`. Fix: gate `rain.setIntensity(0)` indoors; scale drift by intensity.
**Minor (note only):** `world_fog` D3D fog-mode enum parsed (`region.rs:242`) → JS (`worldFog`) but never dispatched (THREE fog always linear). Low impact for Dereth (~one mode).
**Parallel-safe:** yes vs all (touches loop.js weather tick only; sky.rs is world-crate, disjoint from app lib.rs). W1's streak meshes/droplets reuse the GfxObj/particle pipelines but own only the *weather selection + begin/end gating*.

---

## WAVE 2 — two parallel agents (share files with Wave 1; run AFTER it)

### Agent 7 · TEXTURE-SAMPLER — owns `scene3d/adapter.js` + `materials.js` (wrap only)
**G2 — Object surface texture is WRAP everywhere; retail is CLAMP-by-default, WRAP-if-Stippled (LOW-MED, S).** `SetSurface` sets sampler addr CLAMP for normal surfaces, WRAP only when Stippled (`acclient.c:454437`). Holtburger hardcodes `RepeatWrapping` on every object DataTexture (`adapter.js:917,976,1024,1106,1245`); `_materialFromFlags` never reads the `Stippled (0x40000000)` bit. → faint edge-bleed seams (worse if any UVs exceed [0,1]). Fix: derive wrap from `surfaceType & Stippled` (surfaceType already crosses to JS, `lib.rs:5476`); cached normal/height/detail textures already copy `baseTex.wrapS/T` so the fix propagates. **Corrects the earlier "no per-surface wrap signal" assumption — the signal is the runtime Stippled rule.**
**Why Wave 2:** shares `materials.js` with Agent 2. **Parallel-safe** vs Agent 8 (disjoint files).

### Agent 8 · ANIM-EXTRAS — owns `scene3d/entities.js` + `crates/holtburger-dat/.../motion_table.rs` + `src/lib.rs` (motion region)
**A2 — `Modifiers` map (secondary/overlay motions) parsed but never resolved (LOW-MED, M-L; survey population first).** `MotionTable.modifiers` parsed (`motion_table.rs:16`) but no accessor + zero consumers; retail layers held secondary motions via `combine_motion`/`add_modifier` (ACE `MotionTable.cs:234`). Fix: resolution helper + a second concurrent mixer action. **Survey how many retail tables actually use Modifiers (WB.Terminal motion dump) before investing.**
**A4 — Motion-link transitions are single-hop only (LOW, L).** Retail `GetObjectSequence` chains exit-link+dest-link+dest-cycle+re-modify (`MotionTable.cs:60-256`); `_tryPlayLink` plays one from→to clip (`entities.js:5303`). Diminishing returns vs A1-3.
**Why Wave 2:** shares `entities.js` + lib.rs motion region with Agent 5. **Parallel-safe** vs Agent 7.

---

## Cross-cutting coordination (read before launching)
- **`src/lib.rs` is touched by Agents 1, 2, 5 (Wave 1) in DISJOINT functions** (terrain-LUT ~`:3035`; light-range ~`:8054`; EntityUpdate/motion ~`:15896,:28683`). Run with `isolation: 'worktree'`; the merge is mechanical given the regions. Agent 8 reuses Agent 5's motion region → Wave 2.
- **`materials.js` single-owner per wave:** Agent 2 (Wave 1, light-response + PBR) → Agent 7 (Wave 2, wrap). Never both at once.
- **`entities.js` single-owner per wave:** Agent 5 (Wave 1) → Agent 8 (Wave 2).
- **`setEffectiveTimeScale` contention:** T11 velScale (`entities.js:6343`), A1, A3 all write it — **multiply together**, one combined value.
- **R2.B fold-in:** L2+L3 + the existing `?lightClamp=retail` patch should be ONE "retail light response" change (range×1.3 + linear falloff + clamp) behind one flag, not competing `onBeforeCompile` chains.
- **Default-on vs flag:** terrain T1 (default, fail-soft), lighting L1/L2 (default, fail-soft), L3/L4 (flag), particles P1/P2 (default, fail-soft), weather W3/W5 (default), W1/W2 (default once stable). Mirror the Tier-3 discipline: default-on ⇒ fail-soft to current behavior.

## Confirmed NON-gaps — do NOT spend agent time here
- **Mipmaps + trilinear + anisotropy:** done (`adapter.js:913-918`).
- **DrawingBSP poly draw order:** retail renders from `constructed_mesh`; BSP is buildings-only portal occlusion. Z-buffer makes opaque order irrelevant. Faithful as-is.
- **Idle/fidget variety:** retail is **server-driven** (HeartBeat emote category broadcasts UpdateMotion); the client doesn't autonomously fidget. Holtburger already classifies incoming idle one-shots. → **server/content audit (ACE/holtburger-server heartbeat emote dispatch), NOT a client-render gap.**
- **T11 locomotion velocity-scaling:** ACTUALLY wired (`entities.js:6322`, `_resolveCycleBaseSpeed`, `cycleBaseSpeed` export) — the `animation.js:231` "NOT YET WIRED" comment is stale. Just flip `?velScale=on` at eye-test.
- **Region DistanceFogDesc/FogDesc:** not present in retail Dereth data (fog comes from SkyTimeOfDay, R1.C-wired).
- **Gouraud (0x10000000) / Perspective (0x80000000) surface bits:** no meaningful Three.js analogue.
- **Particle "middle scale" / RGB color-over-life:** doesn't exist in retail.
- **Vertex colors:** AC `SWVertex` has none (origin/normal/UV only).

## Suggested execution order
1. **Wave 1** (6 agents, parallel, worktree-isolated) — land highest-value default-path fixes.
2. Eye-test Wave 1 on the 1070 (esp. terrain tiling T1, ambient L1, weather W1/W3, particle jitter P1).
3. **Wave 2** (2 agents, parallel) — the materials.js/entities.js sharers + lower-priority anim.
4. Re-bake/rebuild wasm once per wave; bump `index.html` wasm `?v=`.

---

## SHIPPED STATUS — WAVE 1 (2026-05-29, team-agent execution)

**All 6 Wave-1 agents landed on the working tree (uncommitted).** Grounded first against melt / chorizite / DatReaderWriter / `acclient.c|h|txt` / ACE DatLoader (6 read-only agents); every doc formula/citation re-verified before code. Build: `cargo check -p holtburger-web --target wasm32-unknown-unknown` = 0 errors / 19 warnings (= baseline, +0); `wasm-pack build --target web --release` succeeded; `index.html` wasm cache-bust → `?v=render-completeness-waves2-w1-20260529`. All 18 changed JS files pass ESM-parse; terrain/particles/locomotion test suites green. **GPU eye-test on the 1070 PENDING (atmosphere/1070 offline this session).**

- **A1 TERRAIN** — T1 (default-on, fail-soft): Rust `fetch_terrain_base_tex_tiling()` exports a 33-entry LUT (absent→1); `atlasUvFor` → `vec3(fract(cellUv*uBaseTexTiling[code]), code)`. Atlas confirmed **ClampToEdge** (`terrain.js:1610`), so `fract` is required+correct. T2 (`?texMerge`): overlay loop `s<4`→`s<6` reads road slots 4-5. T3: bilinear painter gated `uRoadEnabled>0.5 && uTexMergeEnabled<0.5` (no double-blend).
- **A2 LIGHTING** — L1 (default-on): diurnal ambient drives legacy `ambient.intensity/color` (`max(0.2,ambBright)` + ARGB unpack) and atmosphere-path SkyLightProbe intensity; gated `!atmosphereLights` (fixes a latent legacy double-up). L2 (default-on): single ×1.3 at `lighting.js:1192` (`STATIC_LIGHT_FACTOR`); lib.rs surfaces raw falloff (no double-multiply). L3 (`?lightClamp=retail`): linear `saturate(1-d/range)` FOLDED into the existing R2.B `onBeforeCompile` (one chain). L4 (`?flatDiffuse=retail`): Metal+Lava → roughness 1 / metalness 0.
- **A3 STATICS** — G1 (default-on, `?billboard=off`): per-frame `degrade_mode` billboard on degraded-LOD plain-Mesh singletons (self-rAF, nameplate_sprite precedent); mode 2 = full billboard, 3/4/5 = yaw-only-upright (dominant mode-4 foliage). InstancedMesh leaves intentionally excluded (can't per-instance rotate one shared mesh). G3 = precise TODO (`acclient.c:332374`); G4 skipped (low impact).
- **A4 PARTICLES** — P1 (default-on): all 5 `getRandom*` helpers made **additive to match RETAIL** (`acclient.c:324328-324403`), flipping the 3 ACE-multiplicative ones (FinalScale/StartTrans/FinalTrans); 5 jitter calls wired into the spawn path on the **seeded** emitter RNG. P2 (default-on): `initEnd` burst loop `totalParticles`→`initialParticles` (fail-soft). `test_particles.mjs` 45/45.
- **A5 ENTITY-MOTION+HOOKS** — A1 (default-on): `motion_speed:f32` on EntityUpdate + wasm getter + `setMotion` arg; multiplied INTO `setEffectiveTimeScale` composing with T11 velScale (not clobber); `loop.js` KIND_MOTION drains thread it through. A3 (default-on): `_tryPlayLink`+`setSwingMotion` timeScale × motionSpeed. P3 (default-on): PhysicsScript walker now fires **SoundTable(2)/Scale(12)/CallPES(19)** (decoded JS-side from `hookData`, reusing `_fireHook` arms; the executor is `_fireHook`, walker entries are `PhysicsScriptEntryJs` not `AnimationHookJs`); CallPES depth-guard MAX=3; `play_effect_vfx.js` deliberately untouched (would double-fire). locomotion+cast tests PASS.
- **A6 WEATHER** — W1 (`?skyWeather=on`): parametric SkyObject billboard host re-added (UV-scroll streak/cloud bands gated by `visible` + properties bits; droplets = TODO), consuming `sessionHandle.getSkyObjectStates()`. W4 (default-on): `is_storm` derived from the active DayGroup's visible weather SkyObjects (props 0x04 / 0x02-SetupModel+PhysicsScript), replacing the fabricated table. W3 (default-on): weather tick relocated to `loop.js` (clouds-independent); the `cloud_volume.js:209` driver removed (no double-drive). W2 (default-on): **SnowSystem** shipped, selected by `temperature_C ≤ 1`. W5 (default-on): precip+lightning gated off indoors; wind scales with intensity.

### Takram-environment hardening (orchestrator, on top of A6)
`skyScene` is a `RenderPass` **inside** the atmosphere EffectComposer (`atmosphere_pipeline.js:163-166`) → HalfFloat + AGX `ToneMappingEffect` (renderer is `NoToneMapping` + exposure 5). W1's `MeshBasicMaterial` streaks would be crushed by AGX vs the HDR sky (unlike the cloud overlay, which composites *after* the composer). Fix in `sky_dome.js`: per-frame radiance gain — `WEATHER_GAIN_LDR=1.0` on the legacy direct-render path, `WEATHER_GAIN_HDR_DEFAULT=3.5` when `liveScene3dRef.atmospherePipeline` is live (also rides the lazy-load LDR→HDR transition cleanly), tunable via `?skyWeatherGain=<float>`. **The exact HDR gain is a 1070 eye-test tuning item** (atmosphere offline this session).

### Regression caught + fixed during integration
`terrain.js` T3 comment originally wrote `` `result` `` (backticks) **inside a GLSL template literal**, closing the string early. `node --check` (CommonJS) passed but the browser loads terrain.js as an **ESM**, where it threw `SyntaxError` → would break the renderer. Fixed (comment-only; no wasm rebuild). **Lesson: validate browser-loaded JS with ESM-parse (`import()`), not just `node --check`.**

### 1070 eye-test checklist (next session, headless/off-screen per [[1070-tests-never-on-screen]])
1. **T1** base terrain ~2× tighter (default path); water UV-scroll still smooth. **L1** ambient warms/cools + dips to the 0.2 floor at dawn/dusk/night. **L2** lantern/brazier reach ~30% longer.
2. **P1** flames/dust/sparks varied (not stamped clones); **P2** continuous-emitter t=0 seed.
3. **A1** hasted/slowed mob animates faster/slower; **A3** hasted swing/cast; **P3** PhysicsScript SoundTable/Scale/CallPES now fire (watch console for `CallPES depth guard`).
4. **G1** distant foliage faces camera (toggle `?billboard=off` to A/B).
5. **W3** rain on the default path (no `?clouds`), **W5** stops in dungeons, **W2** snow in cold DayGroups.
6. **Flags to sweep:** `?lightClamp=retail` (L3 linear falloff), `?flatDiffuse=retail` (L4 matte metal), `?texMerge` (T2 authored road masks), `?skyWeather=on`+`?skyWeatherGain=` (W1 with atmosphere — **tune the gain here**).
