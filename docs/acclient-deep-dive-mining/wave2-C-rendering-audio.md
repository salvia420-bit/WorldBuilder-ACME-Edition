# Wave 2 — Agent C: rendering + audio mining

Source docs mined in full:
- `external/acclient-deep-dives/2013-09-11.4186-v3/06-rendering.md` (§1–§12, 631 lines — every line read)
- `external/acclient-deep-dives/2013-09-11.4186-v3/09-audio.md` (§1–§8, 430 lines — every line read)
- Context skim: `external/acclient-deep-dives/2013-09-11.4186-v3/README.md`, `external/acclient-deep-dives/2013-09-11.4186-v3/00-architecture.md` §9 (traps)

Contrast target: `external/holtburger/apps/holtburger-web/` (JS `scene3d/`, wasm crate
`apps/holtburger-web/src/lib.rs`, `crates/holtburger-{dat,world,*-bake}`).

Every decomp constant/formula quoted below was re-verified against
`/home/wbterminal/ac-headers/acclient.c` during this pass (line anchors given).
Every holtburger citation is a file the agent opened.

---

## DISPOSITION COUNTS

| Disposition | Rows |
|---|---|
| TASK | 50 |
| PARITY-OK | 23 |
| VERIFY-LIVE | 17 (5 in the main ledger + 12 in the behaviour-gap table) |
| N/A-WEB | 13 |
| REF-ONLY | 17 |
| ANTI-TASK (ledger rows dispositioned as such) | 7 |
| **Total ledger rows** | **124** (112 claim rows + 12 behaviour-gap rows) |

Three rows carry two dispositions (R15 PARITY-OK+VERIFY-LIVE, R44 TASK+ANTI-TASK,
A39 PARITY-OK+TASK), so the tags sum to 127 across 124 rows.

Tasks: 33 rendering (`RND-01`..`RND-33`), 15 audio (`AUD-01`..`AUD-15`) — 48 task IDs
across 50 TASK rows (several rows point at the same ID; RND-14 alone absorbs 4 rows).
9 ANTI-TASKS (`A1`..`A9`) in §3, of which 7 are ledger-row dispositions and 2 (A8, A9) are
cross-cutting cautions.

**Disposition semantics used here (per the mid-flight correction):**
- `PARITY-OK` — provable by reading alone: a constant, a formula transcription, a wire
  field order, an enum value, a data layout, an algorithm transcription.
- `VERIFY-LIVE` — the source *looks* right but the claim is about runtime behaviour
  (pixels, draw order, blend result, cull correctness, audio mix/bed selection, pacing)
  and no running client was observed. Each such row names the check that would settle it.
- `N/A-WEB` / `REF-ONLY` / `TASK` as specified.

---

## 1. COVERAGE LEDGER

### 06-rendering.md

| # | § / claim | Disposition | Where / why |
|---|---|---|---|
| R01 | §1 API layer: D3D9 loaded dynamically (`LoadLibraryA("d3d9.dll")` in `D3DPolyRender::Startup` acclient.c:456447/456464), no D3D8 path | N/A-WEB | WebGL2 via three.js; no runtime API selection exists to mirror. |
| R02 | §1/H3 Device creation: `0x50`/`0x40`/`0x20` ladder OR'd with `0x106`, `while (ia<2)` + `Sleep(0xC8)` on `D3DERR_DEVICELOST`, `OnDeviceDisplayModeChange` re-applies states + 3 clear/flip frames | N/A-WEB | Browser owns device lifetime. Nearest analogue `scene3d/webgl_context_recovery.js` already handles `webglcontextlost/restored`; no ladder to port. |
| R03 | §1 `RenderDevice` vtable is game-specific: `DrawInside/DrawBlock/DrawLandCell/DrawSortCell/DrawEnvCell/DrawObjCell/DrawBuilding/DrawMesh` (acclient.h:39019) | REF-ONLY | Record in `docs/RETAIL-PORTAL-RENDERER-*` as the canonical draw-entry taxonomy — it maps 1:1 onto holtburger's `terrain.js / cells.js / buildings.js / statics.js / entities.js` split and is useful when arguing where a pass belongs. |
| R04 | §1 `RenderDevicePresentation` (refresh/bitdepth/triple-buffer/vsync/AA) + `RenderDeviceCaps` (`bCanDoSinglePassDetailing`, point sprites, DXT, occlusion queries) | N/A-WEB | No presentation control in browser; DXT/occlusion caps are WebGL extension queries already handled by three.js. |
| R05 | §2 Two independent renderers; the newer Turbine `RenderMaterial/MaterialLayer/LayerStage` stack is live but drives ONLY 2D UI, atlas fonts, `SceneTool` debug prims (4 call sites: 684176, 123275, 123315, 686275) | REF-ONLY | Settles a recurring question ("is there shader plumbing to mine?"). No — nothing world-facing. Worth recording so nobody mines `RenderPassType` for world passes. |
| R06 | §2 `RenderPassType` enum tops out at `RenderPass_AL_1DL_7PL_Fog = 0x2C` (acclient.h:5374–5423); `RenderPass_LandscapeShadowMap`, `ShaderGlow` are inert parser vocabulary | REF-ONLY | Confirms retail shipped no shadow-map pass. Feeds ANTI-TASK A1. |
| R07 | §2 `MeshBuffer::pRenderMesh` assigned only `0` at all 7 sites (454214, 456097…456397) → the AC1→new-stack bridge is dead | REF-ONLY | Strongest evidence for the separation; record only. |
| R08 | §2/H3 Shaders precisely: zero `CreateVertexShader/CreatePixelShader/SetPixelShader/D3DXCompileShader`; `SetVertexShader` called once with `0` (458543) | N/A-WEB | Retail is fixed-function. holtburger is shader-based by construction; retail can't be a shader reference. |
| R09 | §3 `RenderStateCacheType` full FF mirror + `m_bForceStates` redundancy elision (acclient.h:45869) | N/A-WEB | three.js `WebGLState` does the same job; nothing to port. |
| R10 | §3 FVF table: objects `0x252` = XYZ\|NORMAL\|DIFFUSE\|**TEX2**; landscape `0x242` = XYZ\|DIFFUSE\|**TEX2**; `0x152` non-detail object polys; `0x142` single-texture landscape; `0x144` screen-space | **TASK RND-21** | Two UV sets + a per-vertex DIFFUSE channel on both object and landscape geometry is the *shape* of retail's lighting+detail model. holtburger terrain carries no per-vertex diffuse light channel and objects carry no second UV set. |
| R11 | §4 Frame loop order: `SceneTool::BeginScene` clear → `RenderNormalMode` → `GameSky::Draw(pre)` → landblocks → `GameSky::Draw(after)` (weather cell) → `FlushAlphaList` → pick readback → `EndFrame` UI | VERIFY-LIVE | `scene3d/loop.js` runs an ordered phase list and `index.js` composes an atmosphere post-pass; the *ordering equivalence* (sky before world, weather after world, transparent flush last) is a runtime property. Check: `?renderDiag=on` → `__diag.render` pass list + a `performance_start_trace` frame breakdown on the 1070; confirm cloud/weather layers composite after opaque world. |
| R12 | §4 Outdoor viewer test `objcell_id & 0xFFFF < 0x100` chooses `LScape::draw` vs `DrawInside` (144867) | PARITY-OK | Same discriminator in `scene3d/cells.js` indoor/outdoor branch and in `lib.rs`'s visibility pass (`0xFFFF >= 0xFFFE` outdoor sentinel, lib.rs:32170). Bit-identical rule. |
| R13 | §5 `LScape::draw` walks a sliding `mid_width × mid_width` `CLandBlock` grid far→near; `mid_radius` is the user draw-distance (3/5/8/11/15 by preset) | **TASK RND-14** | holtburger's `pvsRingRadius` default 5 (`cells.js:1740`, 11×11) is not preset-driven; `quality.js` presets (`quality.js:21-110`) carry no draw-distance knob. |
| R14 | §5 Terrain geometry: `CLandBlockStruct` 9×9 heights + per-cell terrain codes; `ConstructPolygons` (354001) picks the diagonal via the `SWtoNEcut` hash `v8 = y*(214614067*x+1813693831) − 1109124029*x − 1369149221; cut = (u32)v8 * 2.3283064e-10 >= 0.5` | PARITY-OK | Transcribed byte-exactly in `crates/holtburger-dat/src/terrain_subdiv.rs:375-390` (`cell_swto_ne_cut`), with the ACE cross-check documented at :350-372. |
| R15 | §5 Vertex assembly is per-frame on the CPU (`landPolysDraw` 720640 / `landPolyDraw` 719994): per-vertex terrain lighting from `curLandBlockVertexLighting`, detail alpha fading 10→50 units, `MY_MAX_MINUS_MIN_OO = 1/40`, depth = view-space `zw`; object equivalent `ACRender::get_alpha_for_z` (719936) | PARITY-OK (constants) + VERIFY-LIVE (result) | `scene3d/terrain.js:628-630` holds `RETAIL_DETAIL_TEX_FADE_START=10.0 / _END=50.0` and cites `get_alpha_for_z` — the constants match. Whether the shipped fade *looks* like retail's 255→0 ramp is a pixel claim: A/B `?terrainDetailTex=global` vs `=off` on the 1070 at 10/30/50 m. Per-vertex lighting itself → RND-21. |
| R16 | §5 **Landscape detail texturing is hard-disabled in the shipped build**: `UpdateFromPreferences` unconditionally sets `Current_Render_LandscapeDetailTextures = 0` (acclient.c:381017-381020) and all five presets set the pref byte to 0 (`byte_81EF94 = 0` in every arm, 378749-378795) | **TASK RND-07** | holtburger's `readTerrainDetailTexMode()` (`terrain.js:2806-2818`) returns `"global"` for *absent or any value except `off`/`percode`* → the landscape detail layer is DEFAULT-ON, i.e. holtburger renders a layer retail never renders. |
| R17 | §5 Texture splatting is offline software work: `LandSurf::SelectTerrain` (304328) + `TexMerge::Merge` (304839) + `FindTerrainAlpha` (304756) → `ImgTex::MergeTexture` (365632) composite per-combination merged textures | **TASK RND-30** | holtburger's `?texMerge` composite exists (`terrain.js:2820+`, alpha mid-point rounding at :2843-2849 citing acclient.c:365787-365798) but was flipped **DEFAULT-OFF** on 2026-06-21 after a failed 1070 eye-test; the shipped default is a bilinear corner cross-dissolve, which is not retail's mechanism at all. |
| R18 | §5 Scenery (`Scene` DAT objects) instantiated as static `CPhysicsObj`s per landblock and drawn as ordinary objects | PARITY-OK | Same model: `crates/holtburger-scenery-bake` resolves the scene-pick noise (`noise.rs:49-121`, same LCG constants) and `statics.js` instances them as ordinary meshes. |
| R19 | §6 `PView::DrawCells` (461450) portal visibility: clip portal polygons in screen space (`ClipPortals`/`GetClip`), per-cell view cones, BFS via `cell_todo_list`, back-to-front `cell_draw_list` | PARITY-OK (algorithm) | Transcribed in `lib.rs:32285-32300+` — a screen-space aperture walk with a per-cell clip polygon queue seeded from the viewport `[-1,-1..1,1]`, max depth 8, plus `get_visible_portal_apertures` (lib.rs:32013). |
| R20 | §6 `DrawCells` sequence: draw landscape through outdoor portals, flush alpha, **partially clear Z**, draw portal polygons into the depth buffer, then each `CEnvCell`, then dynamic objects via `DrawObjCellForDummies` (458143) | **TASK RND-27** | holtburger has `portal_stencil.js` + `portal_punch.js` (both wired from `cells.js:1462/1606`) but no partial-Z-clear + portal-polys-into-depth prepass; the retail sequence is the cheaper and more robust ordering. |
| R21 | §6 Per-object culling is sphere-vs-viewcone **per portal view** inside `DrawMesh` (458209), with `m_nFrameStamp` + `DrawnThisFrame` preventing duplicate draws across views | **TASK RND-28** | holtburger's cull is per-CELL (`lib.rs` visibility set) plus a whole-scene AC-space frustum test (`culling.js:185-188`); no per-portal-view cone test and no cross-view dedup stamp. |
| R22 | §6 `DrawEnvCell` (456878) sets the **environment detail surface** with `curr_detail_src_blend = 9` (BLEND_DSTCOLOR) / `dst = 6` (INVSRCALPHA); `DrawBuilding` (456933) does the same with `building_detail_surface` | **TASK RND-06** | ABSENT. `rg 'envDetail|BuildingDetail|DstColorFactor'` over `scene3d/` → zero hits; `buildings.js` has no detail path. This is the ONE detail-texture path retail actually runs (presets 4/5 set `byte_81EF95/96 = 1`). |
| R23 | §7 `CPhysicsPart::Draw` (314587) picks `gfxobj[deg_level]`, sets `CMaterial`/surfaces/scale, → `DrawMesh`→`DrawMeshInternal`→`D3DPolyRender::DrawMesh`; CGfxObjs compiled **once** into a `MeshBuffer` via `D3DXCreateMeshFVF` (455780/456079) with per-surface attribute ranges | PARITY-OK | Same "decode once, keep resident" shape: the Rust `thread_local` triangulation memo in `triangulate_model_with_substitutions_and_mtable` (per `memory/holtburger-perf.md`) plus per-surface partitioned geometry groups in `statics.js`. |
| R24 | §7 Hybrid pipeline: indexed D3DX meshes for objects/env cells, `DrawPrimitiveUP` for terrain and portal polys, pooled dynamic streams for the UI stack | N/A-WEB | Immediate-mode vs VBO is a D3D9-era distinction; WebGL is buffer-only. |
| R25 | §7/H3 `Render::CalcDegLevel` (380231) is a genuine Mamdani fuzzy controller over `SceneTool::m_FramesPerSecond` with `min_framerate=8 / ideal=10 / max=20` (45517-45519), 5 fuzzy sets with consequents −0.15/−0.02/0/+0.01/+0.10, weighted-average defuzz (380310), added to `Render::deg_mul` clamped to [−1,+1], 29-entry history ring suppressing updates unless the new value differs from *every* recent value by ≥0.01 (380325-380333) | **TASK RND-02** | ABSENT as a geometric controller. `adaptive_render_scale.js` is a *resolution*-only controller (`AdaptiveRenderScaleController`, :74-195; default ON via `adaptiveResEnabled()` :25-35). |
| R26 | §7/H3 `Render::SetDegradeLevelInternal` (379786) maps `deg_mul` linearly to four budgets: object 8→25→50 (stored squared), particle 8→16→25, `max_static_lights` 20→40→60, `max_dynamic_lights` 5→7→10; 60/10 are array capacities, defaults 40/7 | **TASK RND-03** | **Correction to the doc:** `Render::object_distance_2dsq` / `particle_distance_2dsq` are NOT cull distances. They are `min_2D_degrade_distance_sq` in `CPhysicsObj::UpdateViewerDistance` (317932-317934) — the 2D (XY-only) threshold beyond which the viewer-heading-carrying `UpdateViewerDistance` overload runs (enabling degrade + billboard re-orientation). Base constants are literally named `IDEAL_OBJECT_SORT_DISTANCE = 25.0` / `IDEAL_PARTICLE_SORT_DISTANCE = 16.0` (41515-41516). Nothing is culled at 25 m. |
| R27 | §7/H3 `GfxObjDegradeInfo = {num_degrades, GfxObjInfo*}`; `GfxObjInfo = {gfx_obj_id, degrade_mode, min_dist, ideal_dist, max_dist}` (acclient.h:31705/31932) | PARITY-OK | Byte-exact in `crates/holtburger-dat/src/file_type/degrade_info.rs:33-50`, with the real 0x11000001 record pinned as a test fixture (:66-105). |
| R28 | §7/H3 `get_degrade` (332356): biased distance `d' = max(|d| − Render::s_rDegradeDistance, 0)` with `s_rDegradeDistance = 50.0` (45516); advance while `d' >= ideal_dist − (ideal_dist − max_dist)·scale` for `scale ≥ 0`, or `d' <= ideal_dist + (ideal_dist − min_dist)·scale` for `scale < 0`; `scale = deg_mul` when `auto_update_deg_mul` (default true, 45520) else `s_rUserSuppliedDegradeBias`; distance fed in is `CYpt / gfxobj_scale.z` (315199); local player exempt (`physobj->id == CPhysicsPart::player_iid` → level 0/mode 1) | **TASK RND-01** | Divergent in both consumers. Statics: `bandSwapDistances` (`statics.js:341-357`) uses each band's **`min_dist`**, falling back to `LOD_DISTANCE_M = 100.0` (`statics.js:253`, comment claims "the exact retail threshold isn't preserved in the DAT" — it is: `ideal_dist`). Entities: `lib.rs:12207-12212` picks the band with `distance >= min_dist && distance < max_dist`. Neither applies the 50 m bias, the `ideal_dist` threshold, the `deg_mul` scale, the `/gfxobj_scale.z` division, or the player exemption. |
| R29 | §7/H3 `degrades_disabled` and `Render::force_level` (default −1) override degrade selection; the creature preview sets `degrades_disabled = 1` for its own render (143914) | **TASK RND-25** | No force/disable override exists in either LOD consumer; the paperdoll/creature-preview path can therefore render a degraded LOD. |
| R30 | §7/H3 `degrade_mode` is what selects the billboard modes of §10 | PARITY-OK | `statics.js:257-276` documents and consumes it; carried per band at `statics.js:986-988`. |
| R31 | §7/H3 Mouse picking is a CPU ray cast: `set_selection_cursor(x,y,fPolyAccurate)` (379094) arms it, `pick_ray` (379035) unprojects once per frame in `update_viewpoint`, then `DrawMesh` calls `GfxObjUnderSelectionRay` (379997) per part — ray into part-local space, normalise by `gfxobj_scale`, `CSphere::sphere_intersects_ray` vs `mesh->drawing_sphere`, then optional `CPolygon::polygon_hits_ray`; two nearest-hit records kept, polygon preferred (380089) | PARITY-OK | Same class of solution: `picking.js:338-655` builds a `THREE.Raycaster` (layers 0+1 at :346), `setFromCamera(ndc, camera)` at :612, `intersectObjects(roots, true)` at :655 returning near→far triangle hits. Sphere-then-poly two-record staging is an optimisation, not a semantic. |
| R32 | §7/H3 Static scenery excluded from picking: `Render::check_curr_object` only set for parts whose physobj has an ID or is in `creature_mode` (314614) | PARITY-OK | `picking.js:614` explicitly raycasts "ONLY against entity roots, never the [static] …" — same exclusion by construction. |
| R33 | §8 **No shadows at all.** `CShadowObj = {physobj, cell_id, cell}` (acclient.h:30935) and `CShadowPart = {num_planes, planes, frame, part}` (31254) are purely spatial cell-membership/draw-sort structures; no blob, no projection, no stencil pass | ANTI-TASK A1 | holtburger ships CSM (`csm.js`, preset-gated `csm: true` at `quality.js:high/ultra`). Deliberate enhancement — do not remove for "parity". |
| R34 | §8 **No nameplates, speech bubbles, or damage numbers.** Hover name is a `UIElement` tooltip anchored to the *mouse* (`StartTooltipAtMouse` in `RecvNotice_SmartBoxObjectFound`, 275631, tooltip block 275763-275805), gated on `PlayerModule::ShowTooltips` | ANTI-TASK A2 | holtburger has `nameplate_sprite.js` and `speech_bubble.js` — world-space projected UI retail never had. Keep; do not "correct". |
| R35 | §8 `xformPointInternal` (453759) → `SmartBox::GetObjectBoundingBox` (144083, at 144140/144146) projects the selection sphere's viewer-space AABB into a `tagRECT`; `VividTargetIndicator::OnDraw` (289744) moves four corner-bracket widgets to that rect, or shows an edge arrow from a compass heading when off-screen | **TASK RND-23** | Retail's actual target reticle. holtburger uses a world-space selection ring (`entities.js:6744`, `renderOrder = 10`) — a different visual language, and no off-screen indicator. |
| R36 | §8 Selection "glow" is `CPhysicsObj::SetLighting(0.99, 1.0)` → copy-on-write the part's `CMaterial` and raise luminosity+diffuse (275686 → 318929 → 315325 → `CMaterial::SetLuminositySimple`), with a four-flip 0.2 s blink on confirm (275388-275415) | **TASK RND-22** | Retail highlight = material luminosity bump on a COW material, not an outline/ring. `materials.js` already has the luminosity→emissive machinery (`applyFloatLumDiffuse`, used at :1306) to build this cheaply. |
| R37 | §8 The `TextureBasedFont` atlas renderer (685993-687161) exists but is used only by the debug HUD, profiler and debug console | N/A-WEB | DOM/canvas text in the browser; the retail glyph-atlas path has no analogue worth porting. |
| R38 | §9 **No weather engine.** `GameSky` holds `before_sky_cell` (drawn before landblocks) and `after_sky_cell` (the "weather cell", drawn after, gated on `LScape::weather_enabled`); `before_sky_cell` is never passed to a draw call — `GameSky::Draw(0)` iterates `sky_obj` via `DrawRecursive`, only `after_sky_cell` goes through `DrawObjCellForDummies` (308502) | **TASK RND-18** | holtburger's weather is a parametric/procedural pipeline (`weather_state.js`, `cloud_overlay.js`, `cloud_volume.js`, `daygroup_weather.js`). Retail's weather is *DAT EnvCell geometry drawn after the world with UV scroll*. At minimum the ordering + `weather_enabled` gate should be reproduced; the DAT weather cell is an untapped fidelity source. |
| R39 | §9 Celestial bodies are real `CPhysicsObj`s (`GameSky::MakeObject` 308427); clouds/precipitation "move" only via `CPhysicsObj::SetTextureVelocity` UV scroll — no wind vector, no particle path; `CelestialPosition::pes_id` parsed and never consumed | **TASK RND-31** | holtburger renders sky objects as billboards fed from `crates/holtburger-world/src/sky.rs` (day-group → `sky_objects`, :517-518) into the sky-dome host (`loop.js:1081`), but there is no `SetTextureVelocity`-equivalent UV-scroll driver for the sky/weather surfaces (`rg 'textureVelocity'` over `scene3d/` hits only the entity animation hook at `entities.js:14191`). |
| R40 | §9 `GameSky::Draw` (308475) sets a global sky-mode byte, forces `DEPTHTEST_ALWAYS` with depth writes off, and multiplies `zfar` by 4 (`Render::zfar = 4000.0`, 45527; `set_zfar(zfar*4)` at 308496, restored at 308525) | **TASK RND-16** | holtburger's world camera is `new THREE.PerspectiveCamera(60, aspect, 0.1, 5000)` (`index.js:1255`) with the sky drawn as ordinary scene content plus `renderOrder` bands (`entities.js:301-303` catalogues sky/stars at −1, AC moons 800, cloud overlay 999). No separate far-plane expansion for the sky pass; a sky/celestial element beyond 5000 clips. |
| R41 | §9 Weather objects are pinned to the player's XY and forced to **z = −120.0** unless a property bit says otherwise (308415) | **TASK RND-17** | `rg '\-120'` over `sky_dome.js / weather_state.js / daygroup_weather.js` → zero hits. Retail's precipitation/cloud cell rides at a fixed −120 relative altitude under the player, which is why AC rain never parallaxes; holtburger's procedural layers use their own altitudes (`weather_state.js:49`: 20000–60000 for cirrus). |
| R42 | §9 Day/night is DAT-constructed (299972-299985; `GameTime.TimeZeroDelta` a local registry offset) — no message writes game time. `SkyDesc → DayGroup → SkyTimeOfDay`, day group chosen by an LCG hash of the calendar day (`SkyDesc::CalcPresentDayGroup` 301664); `SkyDesc::GetLighting` (301485) lerps ambient brightness+colour and sun heading+pitch | PARITY-OK | Transcribed in `crates/holtburger-world/src/sky.rs`: `calc_present_day_group` (:167, :556), keyframe bracketing + ratio (:200-220), `evaluate_lighting(day_group, time_of_day, …)` (:515), day-group memo (:548-557). |
| R43 | §9 `LScape::UseTime` (307222) re-lights on a `light_tick_size` cadence (region-DAT field, default 20.0 s — bits at 301477-301478), writes `Render::world_lights.sunlight[_color]`, re-runs `CLandBlockStruct::calc_lighting` on every loaded block; ambient is floored at `LScape::min_ambient = LSCAPE_LIGHT_MINIMUM = 0.2` (acclient.c:40344, 783183-783184) | **TASK RND-11** | The 0.2 ambient floor is not in the deep-dive and is not in holtburger: `rg 'min_ambient|minAmbient'` over `scene3d/` + `src/lib.rs` → zero hits. Retail night therefore never reaches black; holtburger's does unless a separate floor exists in the atmosphere pipeline. |
| R44 | §9 Fog is **linear range fog only** — `SetFFFogProperties` (460308) writes `D3DRS_FOGCOLOR/FOGSTART/FOGEND`, no density — behind four independent disable flags (`FFFogSystemDisabled`, `FFFogUserDisabled`, `FFFogAlphaDisabled`, plus the enable) | ANTI-TASK A3 + **TASK RND-32** | ANTI: do not replace holtburger's Bruneton aerial-perspective pass with linear range fog. TASK: the *fog-disable-per-draw* semantics matter — `SetFFFogAlphaDisabled(1)` for ADDITIVE surfaces is a real per-draw fog SKIP (460295-460302) and holtburger's screen-space aerial pass structurally cannot honour it (documented residual in `docs/url-flags.md` under `surfaceParityV2` b1). Needs a decision, not a silent residual. |
| R45 | §9 `PlayerModule::PersistentAtDay` (511150) → `LScape::SetDay` (306897) sets `m_fAlwaysDaylight`, making `set_landscape_lighting` discard real time and re-query `GetLighting(0.5)` — **terrain and object lighting pin to noon while sky objects keep moving** | **TASK RND-19** | No `@day`/always-daylight equivalent found in holtburger. Cheap, high-utility (headless eye-tests and screenshots want deterministic noon lighting with a live sky). |
| R46 | §9 Server "environs" overrides arrive as message 60000 → `Handle_Admin__Environs` (396298), setting `LScape::m_override_{enabled,ambient_level,ambient_color,fog_color,fog_max,fog_min}` + `m_bRadarBlank`, and blend in at `m_override_transition += 0.039999999` per light tick, clamped at 1.0 (307265-307286) | **TASK RND-12** | holtburger handles the message (`index.html:9053-9110`) with the correct per-type colours and `fogMax`, but **snaps** the override (`window.__environFogOverride = {…}`) — no 25-tick ramp, no ambient-level/ambient-colour override, no `fog_min`, no radar blank. |
| R47 | §10 `AddMeshToAlphaList` (454225) writes 84-byte entries into two fixed **3000-entry** arrays (clip list + alpha list); overflow silently drops geometry | N/A-WEB | Fixed-array capacity artefact; three.js's transparent list is dynamic. |
| R48 | §10 **`FlushAlphaList` performs no sorting whatsoever** (455064-455148: two `++`-indexed loops, no comparison); fires when a list is `t × 3000` full with `flush = 0.75` (45787) in `DrawBlock` and `t = 0.0` from every in-scene call | ANTI-TASK A4 | three.js sorts transparent draws by depth. Retail's per-landcell unsorted flush is a correctness *defect* mitigated by the coarse per-part sort of R49. Never port. |
| R49 | §10 Depth ordering happens earlier and coarser, per-part, in `CShadowPart::insertion_sort` (719001) keyed on `CPhysicsPart::CYpt` — where `CYpt = ‖viewer_pos − (part.pos + gfxobj_scale ⊙ GfxObj.sort_center)‖` (calc_draw_frame 315119-315129) | **TASK RND-09** | holtburger's retail-parity path exists but is opt-in: `readSortCenterFlag()` (`entities.js:291-298`) is a strict `=== "on"` check → DEFAULT OFF, so the shipped build uses THREE's per-object bounding-sphere-centre sort. Note holtburger's flag computes view-space Z; retail uses radial distance to the sort-centre point. |
| R50 | §10 Deferral decided by `MeshBuffer::isStippledOrAlphaedMask` vs `s_AlphaDelayMask = 14`: bit1 = ALPHA/INVALPHA/ADDITIVE, bit2 = TRANSLUCENT, bit3 = BASE1_CLIPMAP | PARITY-OK | Same bit taxonomy drives `materials.js`'s ladder (`isAdditive/isAlpha/isInvAlpha/isTranslucent/isClipMap`, :1309-1377) with the flag values documented at :18-19. |
| R51 | §10 **No stipple/screen-door path.** The `stippled` flag selects texture WRAP vs CLAMP and additionally sets `Render::curr_surface_type \|= 0x40000000` on the same line (454437) | **TASK RND-33** | The WRAP-vs-CLAMP consequence of the stipple bit is a real, cheap texture-addressing rule; `rg 'ClampToEdgeWrapping'` in the surface path found no stipple-derived wrap selection. Low effort, removes a class of edge-bleed artefacts on clamped surfaces. |
| R52 | §10 The real cutout mechanism is alpha test: `ALPHAREF` **100** for palettized, **200** for DXT (45764-45765), compared GREATEREQUAL (454546); versus alpha blend | **TASK RND-08** | Implemented but flag-gated OFF: `materials.js:1371-1373` uses `state.hasPalette ? 100/255 : 200/255` only when `parityV2`, and `readSurfaceParityV2Flag()` (:1556-1566) is a strict `on/1/true` opt-in ⇒ DEFAULT OFF. Second code path `materials.js:3526` hardcodes `alphaTest = 0.5`. Shipped default is 0.5 everywhere. |
| R53 | §10 Blend modes come purely from `CSurface::type` bits in `SetSurface` (454471-454497): ADDITIVE alone → ONE/ONE; ALPHA+ADDITIVE → SRCALPHA/ONE; ALPHA → SRCALPHA/INVSRCALPHA. **Nothing in `ParticleEmitter` chooses a blend mode** | PARITY-OK | `materials.js:1309-1348` implements exactly this ladder in retail's evaluation order (ALPHA checked first, INVALPHA before pure-ADDITIVE), citing the same line numbers. Particle blend comes from `Surfaces[0].Type` (`materials.js:1570-1576`). |
| R54 | §10 `PhysicsDesc::translucency` (bitfield 0x40000) → `CPhysicsPart::SetTranslucency` (315488) copy-on-writes the part's `CMaterial` → `SetTranslucencySimple` (360594) sets all four material alphas to `1 − t`; **`t == 1.0` sets `draw_state \|= 1` and the part is skipped entirely**; a `has_alpha` material forces the subset onto the alpha list and, at flush, SRCALPHA/INVSRCALPHA with **z-writes off** (454525-454546) | **TASK RND-24** | `1 − t` and z-write-off are parity (`materials.js:1351-1353`, `:1345-1348`), and the authored base is stashed for hook ramps (:1357). The `t == 1.0 → skip the part` rule was not found — a fully translucent part still submits a draw. |
| R55 | §10 Particles are ordinary `CPhysicsPart`s in a synthetic `CPhysicsObj` (`makeParticleObject` 319617, state `STATIC_PS \| PARTICLE_EMITTER_PS`) using `ParticleEmitterInfo::hw_gfxobj_id` | PARITY-OK | `scene3d/particles/particle_emitter.js` + `particle_emitter_info.js` build from the same `hw_gfxobj_id` field; the "ordinary part" model is what `?particleUnlit` (default ON, `materials.js:1577-1583`) narrows. |
| R56 | §10 `Particle::Update` (330313) writes only origin, scale and translucency, with a parent-frame-derived rotation in the parabolic branch (330470-330498) — no camera/viewer reference | PARITY-OK | `scene3d/particles/particle.js` follows the same per-particle state model; camera-facing is a separate `info.billboard` concern (`index.js:3464`). |
| R57 | §10 Billboarding is live and DAT-driven: `CPhysicsPart::calc_draw_frame` (315066) copies `pos.frame` to `draw_pos.frame`, then `case 2` → `Frame::set_vector_heading` (315080) full camera-facing; `case 3/4/5` → `Frame::rotate_around_axis_to_vector(0\|1\|2, &viewer_heading)` (315083/86/89); `viewer_heading` = normalised viewer→sort-centre vector | **TASK RND-10** | Present but approximate: `_orientBillboardLeaf` (`statics.js:3168-3206`) implements mode 2 exactly (yaw+pitch) but collapses modes **3 and 5 to the mode-4 yaw-only** case with an explicit `TODO(waves-3)` at :3200-3203; and the viewer vector uses the LOD node origin, not the `sort_center`-offset point. Entities have no billboard path at all. |
| R58 | §11 `ImgTex::CreateD3DTexture` (366008) applies the user texture-scale shift with `ImgTex::min_tex_size = 8` (45327) and `D3DXFilterTexture(…, 0x70005)` mips; the shift table is `ImageShift[5] = {0,1,2,4,8}` (40343) indexed by `fLandTextureScale`/`fClipmapTextureScale`/`fRGBATextureScale`/`fIndexedTextureScale` (306252, 306287, 357830-357832) | **TASK RND-14** | ABSENT: `rg 'textureScale|mipShift|min_tex_size'` over `materials.js` + `src/lib.rs` → zero hits. **Trap worth recording:** `ImageScaleType` names (FULL/HALF/QUARTER/EIGHTH, acclient.h:4419-4427) disagree with `ImageShift` — index 3 shifts by 4 (1/16) and index 4 by 8 (1/256); preset `LandscapeTextureDetail = 4` on "low" therefore means `base_tex_size >> 8`, clamped to 8 px. |
| R59 | §11 Clothing/appearance palettes run through `ImgTex::Combine`/`CreateCombinedTexture` (367576): 8-bit indexed source + `Palette` (possibly shifted per `CPhysicsPart::shiftPal`) software-expanded to ARGB, cached by the 64-bit `m_TextureCode` in `ImgTex::texture_table` (45397) | PARITY-OK | Same composite-key cache in Rust: `SurfaceCacheKey::Composed { surface_did, base_palette_id, sub_palettes }` (`lib.rs:9320-9327`) sharing one 96 MiB LRU; composition order documented at `lib.rs:12216-12240`. Effective predicate: `pal_surface_cache_enabled()` = master `?surfaceCache != off` AND `?palSurfaceCache != off/0/false` (`lib.rs:9034-9051`, `:9078-9092`) ⇒ DEFAULT ON. |
| R60 | §11 Eviction: `SceneTool::PurgeOldGraphicsResources` (123094-123105) purges `GraphicsResource`s older than **120 s**, checked every **5 s**, and only when `IsAvailableVideoMemoryLow` (457974) — which is true unless total VRAM ≥ `0xC00000` AND free ≥ `0x1800000` AND free < total/4 | **TASK RND-15** | holtburger evicts by landblock LRU with bulk dispose (`landblock_lru.js`; per `memory/holtburger-perf.md` the observed symptom is a ~4000-mesh dispose spike). Retail's model — age-based, only under memory pressure, no residency change while memory is fine — is exactly the "warm-park eviction" the residency roadmap wants. |
| R61 | §11 **`DrawPrimitiveUP` is the primary path**, `s_bAllowDrawPrimitiveUP` defaults true (45784); `RenderDeviceD3D.AllowDrawPrimUP` is a debug kill-switch. `RenderPrimitivesInHardware` (457860) is the pooled dynamic-stream path with an `m_nStreamFrameID` stale-fill check (457866) | N/A-WEB | Immediate-mode vs pooled-stream is a D3D9 concern. |
| R62 | §11 **Interior lighting is CPU-baked per vertex.** `D3DPolyRender::SetStaticLightingVertexColors` (454918) locks the `ID3DXMesh` VB and evaluates every `Render::world_lights.static_lights[]` per vertex via `LIGHTINFO::convert_to_local`, caching into `MeshBuffer::burnedInStaticLights`; `Render::minimize_envcell_lighting` (379652) then enables only the DYNAMIC lights as hardware FF lights. Cell lights enter via `CObjCell::add_static_to_global_lights` / `add_dynamic_to_global_lights` (346859/346881). `DrawEnvCell` calls the bake per cell (456901) | **TASK RND-04** | ABSENT. Repo-wide `rg 'burnedIn|bakedVertexLight|vertex_light|bakeStaticLight'` → only `static_light_factor` (the 1.3 range multiplier) at `lighting.js:813-814`, `:2130-2132`. holtburger treats every static cell light as a live real-time light in a 32-slot pool. |
| R63 | §11 The hardware light cap is **8 for objects**, enforced twice (caps clamp 457137; hard `v0 >= 8` in `Render::minimize_object_lighting` 380678); `minimize_envcell_lighting` (379652) enables **every** `num_dynamic_lights` with no cap (up to 10 via the degrade controller). Sunlight is `d3dLight.Type = 3` (D3DLIGHT_DIRECTIONAL) in `PrimD3DRender::InitializeLights` (453084) | **TASK RND-05** | holtburger caps globally at `MAX_ACTIVE_LIGHTS = 32` (`lighting.js:406`) with a distance-sorted pool + hysteresis (`pickSelectedSources` :704-731) re-sorted every 4th call (`LIGHT_SORT_INTERVAL = 4`, :420). Retail's cap is PER-OBJECT (each draw picks its own nearest ≤8), which is both cheaper in shader permutations and more locally correct. |
| R64 | §11/H3 Five presets in `Render::SetOverallGraphicsQuality` (378743): `TextureFiltering` 0/0/0/1/1; `LandscapeDetailTextures` always 0; `BuildingDetailTextures`+`MultiPassAlpha` 0/0/0/1/1; `LandscapeTextureDetail` 4/3/2/2/0; `EnvironmentTextureDetail` 4/3/2/1/1; `SceneryDrawDistance` 0/1/1/2/2; `LandscapeDrawDistance` (`mid_radius`) 3/5/8/11/15 — all re-verified at 378749-378795 | **TASK RND-14** | `quality.js` PRESETS (`:21-110`) cover AA/shadows/normal-maps/triplanar/anisotropy/subdiv/POM/CSM/bloom/particles but carry **no** draw-distance, texture-resolution, or scenery-distance knob — the three levers retail actually scales. |
| R65 | §11/H3 `UpdateFromPreferences` (380924) converts texture-detail levels into the four `ImgTex::f*TextureScale` mip shifts, then triggers `FlushGraphicsResources`, gamma, aspect ratio or `Device::ChangePresentation` | REF-ONLY | Record the pref→mip-shift→flush chain alongside RND-14; the flush/gamma/presentation half is browser-owned. |
| R66 | §11/H3 Registry/preference key list (`Render.*`, `Display.*`, `SceneTool.*`, `GameTime.TimeZeroDelta`, `RenderDeviceD3D.AllowDrawPrimUP`) | REF-ONLY | Useful as the canonical settings vocabulary for a holtburger graphics-settings UI; record in `docs/quality-presets.md`. |
| R67 | §11/H3 Console commands `@render radius <5-25>` and `@render fov <10-160>` (`GraphicsOptions::HandleRenderOption` 146792); `Render::fov = 1.1781294` rad = **67.5°** default (45523), `Render::scale = 4000.0`, `vdst = ty / tan(fov*0.5)` (378936) | **TASK RND-13** | holtburger's camera is `PerspectiveCamera(60, …)` (`index.js:1255`) — a narrower FOV than retail's 67.5°, which changes perceived scale and speed. No `@render`-equivalent runtime radius/fov commands. |
| R68 | §12 Trap: `KeyStone` is external `keystone.dll` (390176-390300) hosting `ACHelpPlugin.dll`/`ACPluginManager.dll` — not the game UI | REF-ONLY | Prevents future agents mining it as a renderer. |
| R69 | §12 Trap: `CBaseRenderer`/`CBaseVideoRenderer` are DirectShow (14785-14792) | REF-ONLY | |
| R70 | §12 Trap: `D3DXTex`/`D3DXMesh`/`D3DXCore` really are statically-linked MS D3DX9 (11593-11601, bodies 535171/537033/538154) | REF-ONLY | |
| R71 | §12 Trap: `ParticleEmitter` at 329361 is the **destructor**; live logic is 330313/330909/331003/331097 | REF-ONLY | Already respected by `scene3d/particles/*`. |
| R72 | §12 Trap: `flush = 0.75` (45787) recoverable → per-landcell flush at 2250/3000; the dropped `st0` arg `a2` forwarded to `UpdateObjCell` (459010) is genuinely unrecoverable | REF-ONLY | |

### 09-audio.md

| # | § / claim | Disposition | Where / why |
|---|---|---|---|
| A01 | §1 Backend is DX3-era `DirectSoundCreate` only (import 11409, called 387122); no Miles/XAudio/FMOD/OpenAL; no device enumeration (NULL GUID, 387104) | N/A-WEB | Web Audio API. |
| A02 | §1 Init: `SetCooperativeLevel(DSSCL_PRIORITY)`; primary buffer `PRIMARYBUFFER\|CTRL3D`; listener rolloff 0.01, front (−1,0,0) / top (0,1,0); primary format forced to **11025 Hz / 16-bit / stereo**; `Play(LOOPING)` on the primary | N/A-WEB | Browser owns the output graph and sample rate. |
| A03 | §1 Secondary decode via **MSACM** (`acmStreamOpen/Convert/Size`) converts any non-PCM DAT wave (ADPCM) to 11025/16/**mono** at buffer-fill time (`SoundBuf::Create` 385849, `CopyWaveToBuffer` 385680) | N/A-WEB | `decodeAudioData` handles the RIFF directly (`audio_manager.js:317`). One consequence worth noting: retail downmixes to MONO; the browser may keep stereo — audible only for stereo source waves. |
| A04 | §1 Only fallback is degradation: `SoundManager::Init` (383412) clears **only** `effect_sounds_enabled` when `SoundOK()` is false (383418-383427); the ambient scheduler and UI paths keep running silently | REF-ONLY | Explains why retail ambient timers keep ticking with audio dead — a useful precedent for holtburger's "keep the runtime ticking, drop the output" behaviour on a suspended AudioContext. |
| A05 | §2 `SoundManager` is a namespace of statics; `Init` from `Client::InitUI` (77544); `ShutDown` (383205) **never called**; no per-frame `SoundManager::UseTime` — the only periodic audio work is `Ambient::UseTime` from `SmartBox::UseTime` (146291) | REF-ONLY | Architectural shape only. |
| A06 | §2/H3 Voice pool: `playing_sounds_` is a fixed array of **16** `SoundPlayingData {SoundBuf*, float priority, double start_time}`; `PlaySoundInternal` (383004) round-robins from `curr_playing_buffer_` taking the first empty/priority-0/not-PLAYING slot; if all 16 are live it makes a second pass for a slot whose stored priority is **strictly lower** than the new sound's, stops+deletes it, else **drops the new sound**; early-out on `s_bPlaySoundOnlyWhenActive && !Device::m_bIsActiveApp` | **TASK AUD-01** + **AUD-09** | ABSENT. `audio_manager.js` (whole file read, 519 lines) creates one `AudioBufferSourceNode` per `play()` with no pool, no cap, no priority. `entry.priority` is resolved and then discarded (`sound_table_cache.js:252`). No `visibilitychange`/`document.hidden` handler anywhere in `scene3d/` or `index.html` (verified by grep). |
| A07 | §2/H3 Buffer cache is **eager, not lazy**: every wave referenced by a loaded STable is decoded into a DirectSound static buffer at table-load time. `CreateSound` (383707) refcounts up/creates at 343075, 343140, 385488; `DestroySound` (383747) at 343058, 343088, 385383; `UnPack` recurses into child nodes (385536) so the whole tree is decoded | **TASK AUD-12** | holtburger decodes lazily on first `play()` (`audio_manager.js:268-331`) and caches the in-flight Promise. First occurrence of any sound therefore has fetch+decode latency; retail has none. `SoundTableCache.preload` (:279-294) exists but warms only the *table*, not its waves. |
| A08 | §2/H3 `MediaMachine::Update_Sound`'s `m_stype == 0` branch calls `PlaySoundFromCenter(gid, 1.0)` (383591) — a pure `sound_hash_` lookup with **no `CreateSound` fallback**; a wave never referenced by a loaded STable/hook silently does nothing | REF-ONLY | Explains a whole class of retail silence. holtburger's analogous failure is `fetchWave` "record not prefetched" (`audio_manager.js:286-291`), already handled soft. |
| A09 | §3 **Every game sound is a 2D buffer.** `SoundBufRef::SoundBufRef` always constructs with `use_3D = 0` (383127); the `IDirectSound3DListener` position is never updated; no doppler; no DirectSound rolloff | ANTI-TASK A5 | holtburger's HRTF `PannerNode` + live listener (`audio_manager.js:225-258`, driven from `index.js:2092-2101`) is strictly better. Do not "restore" 2D pan-only. |
| A10 | §3/H3 Software positioning: `PlaySoundInternal(pos)` (383152) takes `Position::distance` + `Position::heading` relative to `player_position_`, subtracts the viewer's own `Frame::get_heading`, wraps to ±180°, then `pan = (int)(sin(Δ·0.017453292) · −15)` — a pan index in [−15,15] scaled ×100 in `SoundBuf::Play` (386102/386140) — and **skips panning entirely when distance < 5.0 or when `s_SoundFeatures == 1` ("Mono")** | **TASK AUD-11** | Two extractable rules: (a) no directional cue inside 5 m; (b) a user Mono option. holtburger pans continuously at all distances and has no mono/stereo preference. The ±15-unit pan quantisation itself is an ANTI-TASK (HRTF is better). |
| A11 | §3/H3 `GetAttenuation` (383079) exactly: `gain = (d >= 5) ? 25·volume/d² : volume; gain = min(gain,1); gain *= is_ambient ? ambient_sound_volume : effect_sound_volume; dB = ceil(log2(gain)·6.0206)` (whole dB); `VOL_MIN = −50` (45626), returns false only when strictly below | **TASK AUD-10** (partial parity) | The 25/d² curve is bit-matched via `distanceModel:"exponential"`, `refDistance 5`, `rolloffFactor 2` (`audio_manager.js:31-33`, :422-427) — PARITY on the curve. The **dB quantisation is applied to the wrong quantity**: `_quantizeGainToDb` (:350-355) snaps only `opts.gain`, while the distance factor (panner) and category slider (bus) stay continuous. Retail quantises the *product*. Also `DEFAULT_MAX_DISTANCE = 200` (:33) is inert under the exponential model (spec ignores `maxDistance` there) — the real cutoff is the −50 dB cull at 88.91 m (:391), which matches retail. |
| A12 | §3/H3 **The listener is the camera, not the player**: `SetPlayerPosition` (383277) is called from `SmartBox::set_viewer` with the viewer position (144034), temporarily overridden to the creature-view frame during `CreatureMode::Render` (143931/143934) | PARITY-OK | `index.js:2090-2101` sets the listener from `cameraSwitcher.activeCamera` position+quaternion every tick. (The creature-preview override has no holtburger analogue — folded into RND-25.) |
| A13 | §3/H3 Attachment to a `CPhysicsObj` is **by value at play time** (`PlaySoundA` reads `sound_table` + `m_position` once, 383681) — a moving object does not update the pan or volume of an already-playing sound | ANTI-TASK A6 | holtburger's `followGuid` panner tracking (`audio_manager.js:200-214`, `:472-477`; driven from `index.js:2108-2125` with the `acToThree` frame fix) is a deliberate improvement. Keep. |
| A14 | §4 `CSoundTable : SerializeUsingPackDBObj`, `GetDBOType() == 34` (0x22, 385565); contains one recursive `SoundTableData` — `IntrusiveHashTable<ulong, SoundTableData*>` keyed by `SoundType` + `num_stdatas_` + `SoundData data_[]`; `SoundData = {DID sound_id_, float priority_, probability_, volume_}` | PARITY-OK | Same shape consumed via `entriesForSound(enum)` → `{waveDid, priority, probability, volume}` (`sound_table_cache.js:250-255`); DID prefix guard `0x20` at :52-56. |
| A15 | §4 Selection (`GetSound` 383433): `CSoundTable::Lookup` → `SoundTableData::Lookup`; if N variants, index = `(u64)((N−1) · Random::RollDice(0,1))` with `Random::rand()` ∈ [0,1) ⇒ **the last variant of every multi-variant node is dead data**; `GetSound` does not roll `probability_` — its callers do (383670, 383696, 383579, and inline `rand()` at 383533/383557) | PARITY-OK | `sound_table_cache.js:246-247` is `Math.floor((entries.length − 1) · rng())` with an explicit "do NOT fix the half-open range" note at :242-245. Callers roll probability separately (`entities.js:13780-13793`). Exactly right. |
| A16 | §4 `DBWave : SerializeUsingPackDBObj, WaveFile` is DBO type 15 (0x0A, 385798); `DBWave::UnPack` (384721) is `u32 formatSize; u32 dataSize; WAVEFORMATEX[formatSize]; bytes[dataSize]`; the `mmio*` file fallback is dead because `SoundBuf::useDatabase = 1` (45652) | PARITY-OK | `fetchWave(did)` returns `{takeRiffBytes(), sampleRate, numChannels, bitsPerSample}` (`audio_manager.js:49`) — the same record reassembled as a RIFF. |
| A17 | §4 A `CPhysicsObj` gets its table from `CSetup::default_stable_id` (`InitDefaults` 320871) or `PhysicsDesc::stable_id` (`set_description` 322310), both via `DBObj::Get(did, 0x22)` | VERIFY-LIVE | holtburger reads `inst.soundTableDid` and, when it is 0 for the LOCAL player only, backfills the canonical humanoid table `0x20000001` (`entities.js:13756-13763`; `index.html:8930-8937`) — an acknowledged workaround for a spawn-path gap, not the retail rule. Check: `__diag.entity_types` / a headless spawn with `?autoLogin=1` asserting `soundTableDid != 0` on remote NPCs before any GMSound arrives. |
| A18 | §4/H3 `SoundType` enum at acclient.h:4569, values 0–0xCC (`NUM_SOUND_TYPES = 0xCD`, 205), with the documented runs (Footstep1/2+Walk1 at 0x37-0x39; Ambient1-8+Waterfall at 0x46-0x4E; the UI block 0x6A-0x8A; TriggerActivated1-50 at 0x98-0xC9) | REF-ONLY | holtburger passes raw `u32` sound enums with no named catalogue (`rg 'Ambient1|Footstep1|TriggerActivated'` finds only doc comments and test fixtures). Record the table so diag surfaces and the event log can label enums instead of printing hex. |
| A19 | §5 Selection is **per landcell**, by terrain type + scene type — not per landblock: `CLandBlock::add_ambient_sounds` (352444) walks EVERY cell, extracts `terrain_id = (t >> 2) & 0x1F` and `scene_type_id = t >> 11`, resolves `CRegionDesc::GetSTBDesc → CTerrainDesc::GetSTBDesc → CSceneType::sound_table_desc` (299022, 303290), lazily loads via `AmbientSTBDesc::InitSoundTable` (299000), and calls `Ambient::AddSound` with the cell's world position; `LScape::add_ambient_sounds` (307180) drives it over **all loaded blocks** | **TASK AUD-02** | Fundamentally different in holtburger: `AmbientRuntime.tick` samples ONE terrain vertex — the nearest of the player's own LB's 9×9 grid (`ambient_runtime.js:671-709`) — and derives a single active STB (`:390-438`). No multi-cell set, no per-cell world positions, no cross-landblock accumulation. The `(word >> 11) & 0x1F` scene-type extraction itself is correct in the baked path (`baked_ambient_source.js:12`; the mask is a no-op on a 16-bit word). |
| A20 | §5 Two `AmbientSound` subclasses: `IntermitSound` (randomised one-shots, with per-direction min/max distance arrays across 8 directions) and `ConstantSound` (continuous drone with a running volume) | **TASK AUD-05** | holtburger distinguishes continuous vs probabilistic (`isContinuous`, `ambient_runtime.js:450`) but has no per-direction distance arrays and no directional model at all. |
| A21 | §5 `Ambient::CalcWeight` (383857, re-read this pass): 0 past `max_dist_sq = 14400` (120 m), 1.0 inside `min_dist_sq = 400` (20 m), `min_dist_sq / d²` between | **TASK AUD-02** | ABSENT — no distance weighting of any kind in `ambient_runtime.js`. |
| A22 | §5 `Ambient::CalcDir` (383880) returns 1–8 for compass octants **and 0** when the 2D offset is inside `min_dist_sq · 0.5`. Re-read this pass: the octants are **not** equal 45° sectors — the test is `\|y\|/\|x\| > 2` → N/S (1/2), `\|x\|/\|y\| > 2` → E/W (3/4), else the four diagonals (5–8), and only x,y are used. `IntermitSound::AddTo` (384260) treats dir 0 by registering the sound in **all eight** slots with `min = 4.0, max = ambient_sound_min_dist·0.5 = 10.0`; for dir ≠ 0 it registers `[d − 10, d + 10]` | **TASK AUD-05** | ABSENT. |
| A23 | §5 Weights accumulate into `total_sound_count`; `UpdateSound` normalises: `IntermitSound::play_chance = base_chance · sound_count / total_weight` (384200), `ConstantSound::current_volume = desc.volume · sound_count / total_weight` (384295). **This normalised weighting is the entire crossfade mechanism** — no fade envelope, no timed crossfade; volumes simply re-derive on cell change | **TASK AUD-02** | holtburger uses the RAW authored `baseChance` for the roll (`ambient_runtime.js:478-479`) and the raw `volume · resolved.volume` for gain (`:811`, `:897`), so no crossfade exists — an STB change is a hard stop/start (`:434-437`). |
| A24 | §5 The set is rebuilt on cell change in `CellManager::ChangePosition` (146646): `InitSounds` → `add_ambient_sounds` → `UpdatePlayQueue` → `ReleaseSoundTables`, the last dropping STables whose `play_count == 0` (146461) | **TASK AUD-06** | holtburger rebuilds on *STB change* only, keyed off the nearest-vertex sample; there is no queue to update and no STable release/refcount (`SoundTableCache` never evicts except `dispose()`, `:323-332`). |
| A25 | §5 `Ambient::UseTime` (384507) pops a **priority queue keyed on absolute time** while `key < Timer::cur_time` and calls `Ambient::Play` (384452), which asks `CanHear`/`PlayNow`, synthesises an emitter position via `IntermitSound::GetSoundPos` (384212), plays through `PlayAmbientSound`, then re-queues at `now + GetPlayInterval` — `RollDice(min_rate, max_rate)` for intermittent (384004), plain `min_rate` for constant (384013). Re-read this pass: `CanHear` false ⇒ `on_queue = 0`, i.e. the sound LEAVES the queue until the next rebuild | **TASK AUD-06** | holtburger uses per-`sType` countdown timers decremented by a wall-clock dt capped at 1 s (`ambient_runtime.js:294-315`, `:475-483`) — functionally similar for intermittents, but there is no absolute-time queue, no `on_queue` drop, and no re-queue-with-fresh-interval for continuous sounds. |
| A26 | §5 **Constant/continuous ambients are re-fired one-shots**, not loops: `GetPlayInterval` returns `min_rate`, `Play` re-derives volume via `GetVolume` each fire, and `ConstantSound::CanHear` (383944) drops the sound when its normalised volume < `Ambient::ambient_sound_min_vol = 0.03` (45650) | **TASK AUD-03** | holtburger starts a genuine `loop: true` source once per STB activation with a FIXED gain (`ambient_runtime.js:788-871`) and never re-derives volume, never applies a min-volume floor. This is the single biggest audible ambient divergence: retail's town/forest bed breathes as you move; holtburger's is constant until it hard-cuts. |
| A27 | §5 `IntermitSound::GetSoundPos` (384212) synthesises the emitter position: pick a random registered direction (`RollDice(0, num_dir)` floored), heading = `LandDefs::heading(dir) + RollDice(0, upper_bound) − upper_bound·0.5` with `upper_bound = 0.39269909` = π/8 (45651) ⇒ **±11.25° jitter around the octant heading**, and radial distance `d = min + (max − min)·u²` (a squared, near-biased distribution) — z is copied from the base position | **TASK AUD-04** | holtburger plays both continuous and probabilistic ambients **at the listener position** (`ambient_runtime.js:839-846`, `:923-930`), so every ambient one-shot is centred instead of arriving from a random octant at a random distance. With HRTF already wired this is a large, cheap immersion win. |
| A28 | §5 `AmbientSoundDesc = {SoundType stype; int is_continuous; float volume, base_chance, min_rate, max_rate}` (acclient.h:35498), where `is_continuous` is derived in `AmbientSTBDesc::UnPack` (384535) as `base_chance == 0` | PARITY-OK | Same derivation in the baked feed (`baked_ambient_source.js:106`: `isContinuous: !!s.continuous`, with the baker computing it) and the same field set consumed at `ambient_runtime.js:445-450`. |
| A29 | §6 A complete winmm MIDI stream player exists (386258-386730, six 84-byte `MIDIHDR`s, tempo multiplier, per-channel volume cache) but `midiPlay` is called only from `midiPlayNext`, itself only from `MidiProc`'s buffer-done handler ⇒ **no MIDI music in the shipped client**; and it plays from a file path, not the DAT | REF-ONLY | Settles "was there music?" — no. Record so nobody hunts for a soundtrack DAT. |
| A30 | §6 A live DirectShow player DOES stream audio: `MovieTheatre::Init` (724263) `CoCreateInstance(CLSID_FilterGraph)` → `AddSourceFilter` (724346) → `IGraphBuilder::Render(pin)` (724371) → `IMediaControl::Run` (724380), reachable from `MD_Data_Movie::Update` (693286) | N/A-WEB | `<video>`/`<audio>` in the browser; entirely outside `SoundManager` in retail too. |
| A31 | §7/H3 `0xF750` SoundEvent: `case 0xF750` → `CM_Physics::DispatchSB_SoundEvent` (392803 → 709642), blob `u32 opcode \| u32 object_id \| u32 sound \| float volume` → `SmartBox::HandleSoundEvent` (143333) resolves via `CObjectMaint::GetObjectA`; **if the object isn't known yet the blob is queued on the object (return code 4 = defer) and replayed on creation**; else `CPhysicsObj::play_sound` (316424) → `PlaySoundA`. The server only ever sends an abstract `SoundType` + volume | **TASK AUD-15** | holtburger's handler DROPS the event when the entity is unknown: `stats.entityMissing += 1` + `console.debug(… "not in registry — skip")` (`index.html:8938-8945`). No defer queue, no replay. This loses exactly the sounds that matter most (a creature's attack/spawn grunt racing its own ObjectCreate). |
| A32 | §7/H3 The other server-driven route is animation hooks: `SoundHook` (absolute wave DID, 342188), `SoundTweakedHook` (DID + priority/probability/volume, defaults 0.9/1.0/1.0, 342207), `SoundTableHook` (`SoundType` resolved against the object's own table, 342219) — **this is how footsteps and weapon swings fire**; `Sound_Footstep1/2` and `Sound_Swoosh*` are never referenced by name in code | PARITY-OK | All three hook types implemented: hookType 1 (Sound) / 21 (SoundTweaked) / 2 (SoundTable) at `entities.js:11886`, `:13742-13830`, `:13960-13975`, with the SoundTweaked wire shape citing acclient.c:343123. |
| A33 | §7/H3 **No surface-type-dependent footstep logic** — no landblock surface query feeds sound selection; variation comes only from the STable's random variant list | ANTI-TASK A7 | Do not add terrain-material footstep switching "for realism": it is not AC. |
| A34 | §7/H3 Collisions produce no direct audio: `report_environment_collision` (320194) / `report_object_collision` (320228) build profiles and hand them to `CWeenieObject` virtuals; `Sound_Collision (0x2F)` is never referenced in client code — collision sounds arrive only as server `0xF750` | VERIFY-LIVE | No client-side collision sound was found in `scene3d/`, which matches retail. But "no collision sound is synthesised locally" is a behaviour claim about the whole physics→audio path. Check: `?eventLog=on` capture during a headless collision run; assert zero `type:"sound"` records with a collision `source_meta`. |
| A35 | §7/H3 UI sounds go through `PlaySoundFromCenter` (pan 0, distance 0) by two routes: (1) `MD_Data_Sound` media descriptors `{DID m_file; SoundType m_stype}` executed by `MediaMachine::Update_Sound` (162243) — `m_stype != 0` ⇒ `m_file` is an STable DID, else a direct wave; (2) hard-coded calls via `ClientUISystem::GetUISoundTable` (401286, `DBObj::GetByEnum(0x10000003, 7, 0x22)`) for teleport in/out (261845, 262562) and the `/environs` bank of 22 sounds (396439-396539) | **TASK AUD-08** | Partially present: `index.html:9079-9110` uses the environs bank via a scanned DID `0x2000004B` (with `window.__environSoundTableDid` override) and `portal_space.js:60-70` hard-codes the portal enter/exit waves. Missing: the `GetByEnum(0x10000003, 7, 0x22)` resolution path, an interface-sound category/bus, and the `MD_Data_Sound` media-descriptor executor for DAT-authored UI sound scripts. |
| A36 | §8 `SoundManager::InitPrefs` (383284) registers eight `UserPreferences` entries: `Sound.{SoundVolume, AmbientSoundVolume, InterfaceSoundVolume, SoundFeatures (Stereo/Mono, 793517-793518), SoundDisabled, AmbientSoundDisabled, InterfaceSoundDisabled, PlaySoundOnlyWhenActive}` | **TASK AUD-13** | holtburger exposes master + effect + ambient gains only (`audio_manager.js:164-187`). No interface category, no mono option, no per-category disable, no play-only-when-active. |
| A37 | §8 `interface_sound_volume` is registered but **never read** — `GetAttenuation` only consumes `ambient_sound_volume` on the ambient path and `effect_sound_volume` everywhere else, so UI sounds are scaled by the *effects* slider and the Interface slider is a no-op; only `interface_sounds_enabled` has any effect | REF-ONLY | Record so nobody "fixes" holtburger by adding an interface *volume* — retail's interface volume is dead. The interface *enable* gate is real (folded into AUD-13). |
| A38 | §8 The three "Disabled" booleans gate whole categories at the entry points (`PlaySoundA`, `PlayAmbientSound*`, `PlaySoundFromCenter`) — a disabled category never reaches the mixer | **TASK AUD-13** | Category buses exist but only as gain nodes (`audio_manager.js:126-135`); setting gain 0 still pays fetch+decode+node cost. Retail short-circuits before the mixer. |
| A39 | §8 Constants: `VOL_MIN = −50` dB (45626), `VOL_MIN_DIST_SQ = 25.0` (793567), `Ambient::{ambient_sound_min_dist = 20, min_dist_sq = 400, max_dist_sq = 14400, min_vol = 0.03}` (45647-45650) | PARITY-OK (2 of 5) + **TASK AUD-03** | `VOL_MIN` and `VOL_MIN_DIST_SQ` are both bit-matched (`audio_manager.js:30`, `:383-391`). `min_dist_sq`/`max_dist_sq`/`min_vol` are unused in holtburger (see AUD-02/AUD-03). |
| A40 | Headline: `SoundManager` is 2D-buffer-only, no doppler, no MIDI; streaming exists but outside `SoundManager` | VERIFY-LIVE | The composite headline is a mix-level behaviour claim about the shipped holtburger audio path. Check: a headless `?autoLogin=1&nullRender=1` run reading `audioManager.playCount/skipCount` + `__ambient.stats()` + `__ambientBaked.stats()` and confirming the bed actually sounds on the 1070 (there is no sound path off that box — see MEMORY §fleet). |

### VERIFY-LIVE rows added to close behaviour gaps

| # | Behaviour claim needing a live check | Check |
|---|---|---|
| V1 | R11 frame-loop ordering equivalence | `?renderDiag=on` → `__diag.render`; 1070 trace. |
| V2 | R15 detail-fade *appearance* over 10→50 m | 1070 A/B `?terrainDetailTex=global` vs `=off`. |
| V3 | R13 draw-distance parity at each preset | `?pvsRingRadius=N` sweep + `terrainBakedLbs.size` plateau. |
| V4 | R28 LOD switch *distance* actually observed on statics | `?lodBandDiag=on` (`statics.js:3260+`) band hit/miss vs camera distance; `__diag.lod`. |
| V5 | R21/R19 portal-view culling correctness (no double draws, no floaters) | `__diag.pvs` + `?stablist` A/B; count `renderer.info.render.calls` with `autoReset=false`. |
| V6 | R63 light-pool selection actually lighting the right objects | `__diag.geometry` + a 200-light dungeon walk with `?lightPool` sweep. |
| V7 | R40 sky clipping at the 5000 far plane | 1070 screenshot at a high vantage; check for celestial clip. |
| V8 | R49 transparent draw order under `?sortCenter=on` vs off | 1070 A/B on a layered-transparency entity (ghost, spell effect). |
| V9 | A17 remote NPC `soundTableDid` non-zero before first GMSound | headless spawn assert. |
| V10 | A34 no locally synthesised collision audio | `?eventLog=on` collision capture. |
| V11 | A40 ambient bed audibly selects + crossfades | 1070 (no audio out — needs a local-chromium `decodeAudioData` + `playCount` proxy or an offline render). |
| V12 | R44 additive-surface fog exemption under the aerial-perspective pass | `?fogLerp=on` + `?surfaceParityV2=on` night-flame A/B. |

---

## 2. TASKS

Perf-relevant tasks are marked **[PERF]**, fidelity **[FID]**; several are both.

### RND-01 — Retail `get_degrade` LOD band selection (50 m bias, `ideal_dist` threshold, `deg_mul` scale) **[FID + PERF]**
- **Source:** 06-rendering.md §7 "Per-object LOD is separate" / "get_degrade".
- **Retail:** `GfxObjDegradeInfo::get_degrade(distance, &deg_index, &deg_mode)` (acclient.c:332356).
  `d' = max(fabs(d) − Render::s_rDegradeDistance, 0)` with `s_rDegradeDistance = 50.0` (45516).
  For `scale ≥ 0`: advance `i` while `d' >= ideal_dist[i] − (ideal_dist[i] − max_dist[i]) · scale`.
  For `scale < 0`: advance while `ideal_dist[i] + (ideal_dist[i] − min_dist[i]) · scale <= d'`.
  Falling off the end ⇒ `deg_index = num_degrades − 1`. `scale = Render::deg_mul` when
  `auto_update_deg_mul` (default **true**, 45520) else `s_rUserSuppliedDegradeBias`; `deg_mul`
  default 0 ⇒ **the effective default threshold is plain `ideal_dist`**.
  The distance fed in is `CYpt / gfxobj_scale.z` (`CPhysicsPart::UpdateViewerDistance` 315199),
  where `CYpt = ‖viewer_pos − (part.pos + gfxobj_scale ⊙ GfxObj.sort_center)‖` (315119-315129).
  The **local player is exempt** (`physobj->id == CPhysicsPart::player_iid` ⇒ level 0, mode 1).
  With the real record 0x11000001 (`{min 10, ideal 25, max 50}`, `{min 25, ideal 50, …}`) retail
  keeps band 0 until `d ≥ 75 m` and band 1 to 100 m.
- **holtburger today:** statics swap at each band's **`min_dist`** — `bandSwapDistances`
  (`statics.js:341-357`) with `LOD_DISTANCE_M = 100.0` (`statics.js:253`) as the fallback; for
  0x11000001 that is a swap at **10 m** vs retail's 75 m. Entities pick the band *containing* `d`:
  `distance >= band.min_dist && distance < band.max_dist` (`lib.rs:12207-12212`). Neither divides
  by `gfxobj_scale.z`, applies the 50 m bias, uses `ideal_dist`, or exempts the player.
  `statics.js:250-252` explicitly (and wrongly) states the retail threshold is not in the DAT.
- **Change:** implement `get_degrade` once in Rust (`lib.rs`, beside `fetch_entity_degrade_for_distance_inner`)
  taking `(distance, gfxobj_scale_z, scale)` and returning `(deg_index, degrade_mode)`; export it;
  have `bandSwapDistances` derive `THREE.LOD` distances from the same formula (`ideal_dist + 50` at
  `scale = 0`) instead of `min_dist`; add the player exemption.
- **Payoff:** fidelity (statics currently degrade ~6-7× too early — the "everything looks like its
  low-poly variant" class of complaint). **Perf-negative on its own** (more full-detail geometry),
  which is precisely why it must land together with RND-02/RND-03 so `deg_mul` can reclaim it.
- **Effort:** M. **Validation:** `?lodBandDiag=on` band hit/miss (`statics.js:3260+`) + `__diag.lod`
  loaded/band counters; A/B mesh-count + `renderer.info.render.calls` (`autoReset=false`, diffed
  over frames) on the 1070 with a fresh `--user-data-dir` per arm.

### RND-02 — Port the Mamdani auto-degrade controller (`Render::CalcDegLevel`) **[PERF]**
- **Source:** §7 "The auto-degrade fuzzy controller".
- **Retail:** `Render::CalcDegLevel` (380231) over `SceneTool::m_FramesPerSecond` with
  `min_framerate = 8`, `ideal_framerate = 10`, `max_framerate = 20` (45517-45519). Five fuzzy sets:
  low (shoulder below 6, up to 9) Δ −0.15; medlow [8, 9.5] Δ −0.02; plateau [9, 15] Δ 0.0;
  medhigh [12.5, 20] Δ +0.01; high [15, 25] + shoulder Δ +0.10. Defuzzify by weighted average
  `rulesum / Σμ` (380310), add to `Render::deg_mul`, clamp to **[−1, +1]**. A **29-entry history
  ring** suppresses the update unless the new value differs from *every* recent value by ≥ 0.01
  (380325-380333). Asymmetric consequents ⇒ fast degrade, slow recovery.
- **holtburger today:** `AdaptiveRenderScaleController` (`adaptive_render_scale.js:74-195`) adapts
  **resolution only** (p75 frame time, band [35, 55] ms, step 0.12, 2 s cooldown), default ON via
  `adaptiveResEnabled()` (:25-35). No geometric/light-budget controller exists.
- **Change:** add a `DegradeController` (JS is fine — it is a scalar feedback loop, not system
  state) publishing `scene3d.degMul ∈ [−1, +1]`; feed it into RND-01's `scale`, RND-03's light
  budgets, and the particle/billboard thresholds of RND-03. Ship default-OFF behind `?autoDegrade`,
  flip after a live bracket.
- **Payoff:** the missing coarse quality knob. Directly addresses the standing anim-scenery/statics
  draw-call wall (`memory/holtburger-perf.md`) by trading geometry for frame rate under load,
  which resolution scaling cannot do (that wall is CPU submission-bound at ≤34% GPU).
- **Effort:** M. **Validation:** headless `?targetFps` + `probe1070.cjs watch` — assert `degMul`
  drops within ~2 s of a forced 8 fps and recovers ~10× slower; A/B fps in a forest at
  `quality=low`.

### RND-03 — `deg_mul`-driven budgets (lights, particle + billboard thresholds) **[PERF]**
- **Source:** §7 "SetDegradeLevelInternal".
- **Retail:** `Render::SetDegradeLevelInternal(new_deg_mul)` (379786) linearly maps `deg_mul` to
  `object_distance_2dsq = (25 ∓ …)²` (8 → 25 → 50), `particle_distance_2dsq` (8 → 16 → 25),
  `max_static_lights` (20 → **40** → 60), `max_dynamic_lights` (5 → **7** → 10). The 60/10 figures
  are `LightParms` array capacities (acclient.h:46630-46635); defaults are 40 and 7. Only two
  `LightParms` instances exist: `Render::world_lights` (56201) and `viewer_lights` (56255).
  **Correction inherited from the doc:** the two "cull distance" rows are really
  `min_2D_degrade_distance_sq` — the XY-only threshold beyond which the heading-carrying
  `UpdateViewerDistance` overload runs, enabling degrade + billboard re-orientation
  (`CPhysicsObj::UpdateViewerDistance` 317932-317934; base constants
  `IDEAL_OBJECT_SORT_DISTANCE = 25.0` / `IDEAL_PARTICLE_SORT_DISTANCE = 16.0`, 41515-41516).
  Nothing is culled at 25 m.
- **holtburger today:** fixed `MAX_ACTIVE_LIGHTS = 32` (`lighting.js:406`); `maxParticlesPerEmitter`
  is preset-static (`quality.js`: 64/256/1024/…); billboard orientation runs for every tagged LOD
  every frame with no distance gate (`tickStaticsBillboards`, `statics.js:3212-3258`).
- **Change:** replace the constant caps with `budgetFromDegMul(degMul)` returning
  `{staticLights, dynamicLights, particleThreshSq, billboardThreshSq}` on retail's ramps; gate the
  billboard walk on `distSq >= billboardThreshSq` (a free win — near billboards barely move).
- **Payoff:** [PERF] fewer lights and fewer per-frame quaternion writes under load; also removes
  the "32 lights always" shader-permutation pressure.
- **Effort:** S–M. **Validation:** `__diag.geometry` light counts + `probe1070.cjs attrib` draw
  census before/after in a lantern-dense town at night.

### RND-04 — Bake static cell/building light contribution into vertex colours (in Rust) **[PERF + FID]**
- **Source:** §11 "Interior lighting is CPU-baked per vertex".
- **Retail:** `D3DPolyRender::SetStaticLightingVertexColors` (454918) locks the `ID3DXMesh` vertex
  buffer and, per vertex, evaluates every `Render::world_lights.static_lights[]` via
  `LIGHTINFO::convert_to_local`, caching the result in `MeshBuffer::burnedInStaticLights`.
  `Render::minimize_envcell_lighting` (379652) then enables **only** the dynamic lights as hardware
  FF lights. Cell lights enter through `CObjCell::add_static_to_global_lights` /
  `add_dynamic_to_global_lights` (346859/346881). `DrawEnvCell` invokes the bake per cell
  (456901) when `use_built_mesh`. Static light range is `falloff · static_light_factor`,
  `static_light_factor = 1.3` (45774).
- **holtburger today:** ABSENT — repo-wide grep for `burnedIn|bakedVertexLight|vertex_light|
  bakeStaticLight` finds only the 1.3 range multiplier (`lighting.js:813-814`, `:2130-2132`).
  Every static cell light is a live `PointLight` competing for the 32-slot pool.
- **Change:** in the bake crates (`holtburger-event-bake` / a new `holtburger-light-bake`, or
  inside the existing cell/statics bake), evaluate static `LIGHTINFO`s per vertex and emit a
  vertex-colour attribute alongside geometry; materials multiply it in (`vertexColors: true`).
  Static lights then stop entering the runtime pool entirely. Fits the standing rule that geometry
  and residency caches belong in Rust and three.js only renders frames.
- **Payoff:** [PERF] the biggest structural lighting win available — a 200-light dungeon collapses
  to a handful of dynamic lights, cutting both the per-frame sort (`LIGHT_SORT_INTERVAL`) and the
  shader light-loop cost. [FID] also fixes the retail look: baked static light is per-vertex and
  unshadowed, which is what AC interiors look like.
- **Effort:** L. **Validation:** byte-identical geometry test in Rust (the bake is deterministic —
  no eye-test gate needed for the *data*); then a 1070 A/B on a lit dungeon comparing fps + a
  screenshot pair; `__diag.geometry` light-count delta.

### RND-05 — Per-object light selection with retail's 8-light hardware cap **[PERF + FID]**
- **Source:** §11 "The hardware light cap is 8 for objects".
- **Retail:** two enforcement sites — a caps clamp at 457137 and a hard `v0 >= 8` cutoff in
  `Render::minimize_object_lighting` (380678). `minimize_envcell_lighting` (379652) enables **every**
  `num_dynamic_lights` with no cap (so env cells can legitimately exceed 8, up to 10 via RND-03).
  Sunlight is `d3dLight.Type = 3` (D3DLIGHT_DIRECTIONAL) in `PrimD3DRender::InitializeLights` (453084).
- **holtburger today:** one global 32-slot pool shared by all materials, distance-sorted with
  stickiness hysteresis (`lighting.js:406`, `pickSelectedSources` :704-731, `feedSelectedIntoPool`
  :735-770), re-sorted every 4th call (:420).
- **Change:** keep the pool, but select per-draw-group (per LB / per cell / per entity) rather than
  globally, capping at 8 for object-class draws and leaving cell draws uncapped. In WebGL this means
  a small number of light-count permutations rather than one 32-light program.
- **Payoff:** [PERF] shorter shader light loops; [FID] a lamp lights its own room, not the nearest
  32 things in the world.
- **Effort:** M–L (interacts with program caching — see ANTI-TASK A8's warning about
  `customProgramCacheKey`). **Validation:** program count via `renderer.info.programs.length`
  before/after; `__diag.geometry`; 1070 A/B in a lantern-lit interior.

### RND-06 — Environment + building detail texturing (the ONE detail path retail runs) **[FID]**
- **Source:** §6 "`DrawEnvCell` also sets the environment detail surface with `src = BLEND_DSTCOLOR (9)`".
- **Retail:** `RenderDeviceD3D::DrawEnvCell` (456878) sets
  `Render::curr_detail_surface = environment_detail_surface`,
  `curr_detail_tiling = environment_detail_tiling`, `curr_detail_src_blend = 9` (BLEND_DSTCOLOR),
  `curr_detail_dst_blend = 6` (BLEND_INVSRCALPHA), then draws; `DrawBuilding` (456933) does the same
  with `building_detail_surface` / `building_detail_tiling`. Enabled by
  `BuildingDetailTextures`/`EnvironmentTextureDetail` — presets 4 and 5 set both to 1
  (`byte_81EF95/96 = 1`, 378783-378795). Unlike landscape detail (RND-07) this path is **live**.
- **holtburger today:** ABSENT. `rg 'envDetail|environmentDetail|BuildingDetail|DstColorFactor'`
  over `scene3d/` → zero hits; `buildings.js` has only a `detailTileCache` passthrough (:592).
- **Change:** add a per-surface detail layer to the env-cell/building material path with
  `blendSrc = DstColorFactor`, `blendDst = OneMinusSrcAlphaFactor`, per-category tiling from the
  DAT (`TexMerge::GetDetailTex`/`GetDetailTiling`, already reachable from the wasm terrain-detail
  work), gated on the `high`/`ultra` presets to mirror retail's preset 4/5 gating.
- **Payoff:** [FID] interior/building surfaces currently lack the grain retail shows at high
  settings — a visible flatness in dungeons and building interiors.
- **Effort:** M. **Validation:** 1070 eye-test A/B in a Holtburg building interior + a dungeon,
  behind `?envDetail=on`, then default-ON at `high`+ per the house default-on rule.

### RND-07 — Decide the landscape-detail default: retail ships it OFF **[FID]**
- **Source:** §5 "Landscape detail texturing is hard-disabled in this build".
- **Retail:** `UpdateFromPreferences` unconditionally forces
  `Current_Render_LandscapeDetailTextures = 0` (acclient.c:381017-381020, re-verified) and calls
  `SmartBox::SetDetailTexturing(smartbox, /*landscape=*/0, environment)`; all five presets set the
  landscape pref byte to 0 (`byte_81EF94 = 0` in every arm, 378749-378795). Only *environment*
  detail texturing (RND-06) remains reachable.
- **holtburger today:** DEFAULT-ON. `readTerrainDetailTexMode()` (`terrain.js:2806-2818`) returns
  `"global"` for an absent parameter and for any value other than `off`/`percode` — the classic
  flag-default footgun, and the in-file comment describes `"global"` as "retail behaviour", which is
  true of the *mechanism* (`GenerateDetailSurface(0)`, one texture world-wide) but false of the
  *shipped state*.
- **Change:** either (a) flip the default to `off` to match the shipped client and keep `=global`
  as an opt-in enhancement, or (b) keep it on and correct the comment + `docs/url-flags.md` to say
  plainly that this is a deliberate divergence. Do **not** leave a divergence documented as parity.
- **Payoff:** [FID] truth-in-flags; also a small perf win if flipped off (one fewer texture-array
  sample + branch per terrain fragment).
- **Effort:** S. **Validation:** 1070 A/B screenshots at 5 m / 30 m / 60 m; user preference call.

### RND-08 — Promote `?surfaceParityV2` (alpha-test refs 100/200, INVALPHA blend, additive fog exemption) **[FID]**
- **Source:** §10 "The real cutout mechanism is alpha test, with `ALPHAREF` 100 for palettized and
  200 for DXT".
- **Retail:** `s_256AlphaTestRef = 100`, `s_ddsAlphaTestRef = 200` (acclient.c:45764-45765), selected
  by whether the current texture has a palette (`ImgTex::m_pPalette`), compared
  `ALPHATESTFUNC_GREATEREQUAL` (454546). INVALPHA blend: `src = BLEND_INVSRCALPHA(6)`,
  `dst = ADDITIVE ? ONE : SRCALPHA` (454478-454484). ADDITIVE ⇒ `SetFFFogAlphaDisabled(1)` whose
  body is `SetRenderState(D3DRS_FOGENABLE, FALSE)` (454551-454553 → 460295-460302).
- **holtburger today:** all three implemented but gated OFF. `materials.js:1371-1373` uses
  `hasPalette ? 100/255 : 200/255` **only** when `parityV2`; `readSurfaceParityV2Flag()`
  (`materials.js:1556-1566`) is a strict `on/1/true` opt-in ⇒ default false; and it is itself inert
  without `?surfaceUnified=on` (also a strict opt-in, reader at `materials.js:1438`). A second code
  path hardcodes `alphaTest = 0.5` (`materials.js:3526`). `docs/url-flags.md:235` lists the 1070
  eye-tests as "BATCHED, pending".
- **Change:** run the batched 1070 eye-test (foliage/fence cutout fringe; foggy-night
  flame/spell-glow under `?fogLerp=on`), then promote `surfaceUnified` + `surfaceParityV2` to
  DEFAULT-ON with `=off` escapes; unify the second `alphaTest = 0.5` site onto the same helper.
- **Payoff:** [FID] correct foliage cutout fringe everywhere (0.5 is wrong for both texture classes)
  and correct additive-surface fog behaviour.
- **Effort:** S (code) + one batched 1070 session. **Validation:** existing headless
  `test_f7_8_surface_bitfield.mjs` Stage 6 + the queued eye-tests.

### RND-09 — Promote `?sortCenter` and key it on retail's `CYpt` **[FID]**
- **Source:** §10 "Depth ordering happens earlier and coarser, per-part, in
  `CShadowPart::insertion_sort` keyed on `CPhysicsPart::CYpt`".
- **Retail:** `CShadowPart::insertion_sort` (719001) is a stable insertion sort over
  `part->CYpt`, where `CYpt = ‖viewer_pos − (part.pos + gfxobj_scale ⊙ GfxObj.sort_center)‖`
  (`calc_draw_frame` 315119-315129) — a **radial** distance to the authored sort centre, not a
  view-space Z.
- **holtburger today:** `readSortCenterFlag()` (`entities.js:291-298`) is a strict `=== "on"`
  opt-in ⇒ DEFAULT OFF, so THREE's per-object bounding-sphere-centre sort runs. When on, the
  implementation projects the sort point to view-space Z and assigns `renderOrder` in a
  `[-100, -100+count)` band (`entities.js:300-317`).
- **Change:** switch the sort key from view-space Z to radial distance to the sort-centre point,
  then eye-test and promote to default-ON. Cheap: the sort point is already computed.
- **Payoff:** [FID] deterministic, retail-matching blend order for layered transparent parts
  (ghosts, shields, spell overlays) instead of THREE's centroid collapse.
- **Effort:** S. **Validation:** 1070 A/B on a multi-transparent-part entity; V8 above.

### RND-10 — Exact axis-constrained billboards + sort-centre-based viewer vector **[FID]**
- **Source:** §10 "But billboarding does exist".
- **Retail:** `CPhysicsPart::calc_draw_frame` (315066) copies `pos.frame` → `draw_pos.frame`, then
  `case 2` → `Frame::set_vector_heading(&draw_pos.frame, &viewer_heading)` (315080, full
  camera-facing); `case 3/4/5` → `Frame::rotate_around_axis_to_vector(&draw_pos.frame, 0|1|2,
  &viewer_heading)` (315083/86/89, exact per-axis pivots, body at 357520).
  `viewer_heading` is the **normalised viewer → (part.pos + scale ⊙ sort_center)** vector.
  `calc_draw_frame` is called from both `UpdateViewerDistance` overloads (315168, 315199) and
  `CPhysicsPart::Draw` passes `&draw_pos` to `DrawMesh` (314620).
- **holtburger today:** `_orientBillboardLeaf` (`statics.js:3168-3206`) implements mode 2 exactly
  (yaw from `atan2(dy,dx)`, pitch from `atan2(dz, horiz)`), but **collapses modes 3 and 5 into the
  mode-4 yaw-only case** with an explicit `TODO(waves-3)` at :3200-3203; and the direction vector
  is to the LOD node origin, not the `sort_center`-offset point. Entities have no billboard path.
- **Change:** implement `rotate_around_axis_to_vector(axis, dir)` for axes 0/1/2; thread
  `GfxObj.sort_center × gfxobj_scale` into the direction computation; extend the billboard tick to
  entity parts (which also carry `degrade_mode` once RND-01 lands).
- **Payoff:** [FID] X/Z-pivot billboard models currently orient wrongly (silently — they just look
  static or lie flat).
- **Effort:** M. **Validation:** find a mode-3/5 model via `WorldBuilder.Terminal`
  `chorizite-parse-dat-record` on `0x11xxxxxx` records (`degrade_mode ∈ {3,5}`); 1070 orbit test.

### RND-11 — Terrain ambient floor `min_ambient = 0.2` **[FID]**
- **Source:** §9 (constant found during verification, not in the doc).
- **Retail:** `LScape::UseTime` (307222) clamps the region's ambient brightness:
  `if (max < LScape::min_ambient) max = min_ambient`, where
  `LScape::min_ambient = LSCAPE_LIGHT_MINIMUM = 0.2` (acclient.c:40344; assignment at 783183-783184).
  Re-lighting runs on a `light_tick_size` cadence (region-DAT `sky_info` field, default 20.0 s from
  the bit pattern at 301477-301478) and re-runs `CLandBlockStruct::calc_lighting` on every loaded
  block.
- **holtburger today:** no floor — `rg 'min_ambient|minAmbient'` over `scene3d/` and `src/lib.rs`
  → zero hits.
- **Change:** clamp the region ambient term to ≥ 0.2 wherever `evaluate_lighting`'s ambient level
  reaches the terrain/object material path (`crates/holtburger-world/src/sky.rs:515` →
  `sky_lighting.js` / `atmosphere_lights.js`); document the cadence.
- **Payoff:** [FID] AC nights are navigable, not black. A single-line clamp with a large visual
  consequence.
- **Effort:** S. **Validation:** headless midnight screenshot pair (`@time`-equivalent or a forced
  `time_of_day`) with and without the clamp.

### RND-12 — Environs override: ramp, ambient, fog-min, radar blank **[FID]**
- **Source:** §9 "Server 'environs' overrides … blend at +0.04 per tick".
- **Retail:** `Handle_Admin__Environs` (396298) sets `LScape::m_override_enabled` plus
  `m_override_{ambient_level, ambient_color, fog_color, fog_max, fog_min}` and
  `ClientUISystem::m_bRadarBlank`; option 0 clears everything (including
  `m_override_transition = 0`). The blend is `m_override_transition += 0.039999999` per light tick,
  clamped at 1.0, lerping ambient level, ambient colour, sunlight colour and fog
  (307265-307286, 307306-307316) — a 25-tick ramp.
- **holtburger today:** `index.html:9053-9078` snaps `window.__environFogOverride = {rgb, fogMax}`
  with the correct per-type colours; no ramp, no ambient-level/colour override, no `fog_min`, no
  radar blank.
- **Change:** publish an `environOverride` state with a `transition ∈ [0,1]` advanced on the light
  tick and lerp fog + ambient toward the override; add `fogMin`; blank the radar.
- **Payoff:** [FID] portal-storm / GM-environs ambience currently pops instead of creeping in.
- **Effort:** S–M. **Validation:** `@environs 1` via `sendChat` on the live ACE server; watch the
  fog lerp over ~25 light ticks.

### RND-13 — Retail default FOV 67.5° and `@render radius` / `@render fov` **[FID]**
- **Source:** §11 "Console commands".
- **Retail:** `Render::fov = 1.1781294` rad = **67.5°** (45523); `Render::SetFOV` sets
  `vdst = ty / tan(fov·0.5)` (378936), so `fov` is the full **vertical** field of view.
  `GraphicsOptions::HandleRenderOption` (146792) exposes `@render radius <5-25>` (the landscape
  `mid_radius`) and `@render fov <10-160>`. Far plane `Render::zfar = 4000.0` (45527).
- **holtburger today:** `new THREE.PerspectiveCamera(60, cssW/cssH, 0.1, 5000)` (`index.js:1255`)
  — 60° vertical, i.e. noticeably narrower than retail, which changes apparent scale and speed.
- **Change:** default the world camera to 67.5°; add `?fov=` / `?renderRadius=` and chat commands
  mirroring `@render`. Note the aspect-ratio caveat: retail ran 4:3 by default and clamped UI
  aspect separately (`OnDeviceDisplayModeChange` 459096), so a widescreen holtburger at 67.5°
  vertical shows *more* horizontally than retail did — worth a user decision, not a silent flip.
- **Payoff:** [FID] the "everything feels zoomed in / too fast" class of feel complaint.
- **Effort:** S. **Validation:** side-by-side screenshot against a retail reference frame at a
  known `@teleloc`.

### RND-14 — Preset-driven draw distance, scenery distance and texture mip shift **[PERF]**
- **Source:** §11 "Graphics settings" + §5 + §11 `ImgTex` scale shifts.
- **Retail:** five presets (378743, values re-verified 378749-378795):
  `LandscapeDrawDistance` (`mid_radius`) **3/5/8/11/15**; `SceneryDrawDistance` 0/1/1/2/2;
  `LandscapeTextureDetail` 4/3/2/2/0; `EnvironmentTextureDetail` 4/3/2/1/1;
  `TextureFiltering` 0/0/0/1/1; `BuildingDetailTextures`+`MultiPassAlpha` 0/0/0/1/1;
  `LandscapeDetailTextures` always 0. `UpdateFromPreferences` (380924) turns the detail levels into
  `ImgTex::{fLandTextureScale, fClipmapTextureScale, fRGBATextureScale, fIndexedTextureScale}`
  mip shifts via `ImageShift[5] = {0,1,2,4,8}` (40343), with `ImgTex::min_tex_size = 8` (45327)
  as the floor and `D3DXFilterTexture(…, 0x70005)` generating mips (366160).
  **Trap:** `ImageScaleType`'s names (FULL/HALF/QUARTER/EIGHTH, acclient.h:4419-4427) do not match
  `ImageShift` — index 3 shifts 4 bits (1/16) and index 4 shifts 8 (1/256).
- **holtburger today:** `quality.js` PRESETS (`:21-110`) carry AA/shadows/normalMaps/detailFlag/
  triplanar/anisotropy/subdivLevel/hero/POM/CSM/bloom/vignette/lensFlare/lightShafts/
  maxParticlesPerEmitter — and **no** draw-distance, scenery-distance or texture-resolution knob.
  `pvsRingRadius` defaults to 5 independently (`cells.js:1740`). No mip-shift path exists
  (`rg 'textureScale|mipShift|min_tex_size'` over `materials.js`/`src/lib.rs` → zero).
- **Change:** add `landscapeRingRadius` (3/5/8/11/15 → low/mid/high/ultra mapped sensibly),
  `sceneryDistance`, and a `textureShift` per class applied in the wasm surface decoder (downsample
  before upload, floor at 8 px) — the decode already owns the pixels, so the shift belongs in Rust.
- **Payoff:** [PERF] the two levers retail used most; texture shift alone is a large VRAM/upload
  win on the laptop iGPU and the R9 290 case that motivated `adaptive_render_scale.js`.
- **Effort:** M (ring radius: S; mip shift: M — touches the surface cache key). **Validation:**
  `?quality=low` vs `high` fps + `renderer.info.memory.textures` bracket on the 1070; assert the
  surface cache key includes the shift so arms don't share entries.

### RND-15 — Age + memory-pressure graphics-resource purge (retail's residency model) **[PERF]**
- **Source:** §11 "Eviction".
- **Retail:** `SceneTool::PurgeOldGraphicsResources` (123094-123105): every **5 s**, and only when
  `RenderDeviceD3D::IsAvailableVideoMemoryLow` (457974) is true, purge `GraphicsResource`s older
  than **120 s**. `IsAvailableVideoMemoryLow` returns true unless total VRAM ≥ `0xC00000` **and**
  free ≥ `0x1800000` **and** free < total/4 — i.e. no purging at all while memory is comfortable.
  Pair this with `LScape::update_block` (307916) shift-in-place slot residency and the refcounted
  `DBOCache` (`GetIfUsing`, 83485) already noted in `memory/holtburger-perf.md`.
- **holtburger today:** landblock-LRU with bulk dispose (`landblock_lru.js`), which the perf notes
  record as a ~4000-mesh dispose spike on move. The Rust surface store is an LRU on a fixed 96 MiB
  byte budget (`lib.rs:9020-9030`) — closer to retail, but still budget-driven rather than
  pressure-driven.
- **Change:** convert landblock/geometry eviction to (a) last-touched age ≥ 120 s, (b) checked on a
  5 s cadence, (c) only when a pressure signal fires (`performance.memory` where available, plus a
  geometry/texture-count high-water mark), and (d) warm-park rather than dispose for the nearest
  ring. Keep the Rust decode cache as the backstop so a re-entered LB re-bakes nothing.
- **Payoff:** [PERF] removes the per-move dispose/GC spike — the top jank source in the standing
  perf notes — without raising steady-state memory when memory is plentiful.
- **Effort:** L. **Validation:** `probe1070.cjs watch` longtask count over a `@teleloc` hop series;
  `renderer.info.memory.{geometries,textures}` should plateau, not saw-tooth.

### RND-16 — Sky pass: expanded far plane, depth-test-always, depth-write-off **[FID]**
- **Source:** §9 "`GameSky::Draw` … forces `DEPTHTEST_ALWAYS` with depth writes off, and multiplies
  `zfar` by 4".
- **Retail:** `GameSky::Draw` (308475) sets a global sky-mode byte, forces `DEPTHTEST_ALWAYS` with
  depth writes off, and calls `Render::set_zfar(Render::zfar * 4.0)` (308496) — `4000 → 16000` —
  restoring it at 308525. `set_zfar` re-applies the FOV (378919-378922).
- **holtburger today:** one camera at `far = 5000` (`index.js:1255`) with the sky as ordinary scene
  content ordered by `renderOrder` bands (`entities.js:301-303`: sky/stars −1, moons 800, cloud
  overlay 999).
- **Change:** render sky/celestial content in its own pass with `depthTest` always-pass and
  `depthWrite = false`, using an expanded far plane (or the standard "sky camera with its own
  projection" trick), so no celestial element can clip against the world far plane.
- **Payoff:** [FID] guarantees sky never clips or z-fights; also lets the world far plane be
  *reduced* for perf independently of sky reach.
- **Effort:** M. **Validation:** V7 — 1070 screenshot from a mountain vantage looking at the
  horizon and at the moons.

### RND-17 — Weather cell pinned to player XY at z = −120 **[FID]**
- **Source:** §9 "Weather objects are pinned to the player's XY and forced to `z = −120.0`".
- **Retail:** in `GameSky`'s per-frame update the weather objects are moved to the player's XY and
  their Z forced to `−120.0` unless a property bit says otherwise (acclient.c:308415).
- **holtburger today:** no such constant anywhere (`rg '\-120'` over `sky_dome.js`,
  `weather_state.js`, `daygroup_weather.js` → zero). Procedural cloud layers use their own
  altitudes (`weather_state.js:49`: 20000–60000 m for cirrus).
- **Change:** if/when the DAT weather cell is rendered (RND-18), pin it to player XY with the
  −120 Z offset and honour the property-bit exemption. Even without the DAT cell, the *behaviour*
  (weather follows the player, does not parallax) is worth reproducing in the procedural layers.
- **Payoff:** [FID] AC precipitation famously travels with you; a parallaxing rain layer reads wrong.
- **Effort:** S. **Validation:** 1070 A/B walking under rain — the rain volume should not slide.

### RND-18 — Reproduce the two-cell sky/weather draw structure and `weather_enabled` gate **[FID]**
- **Source:** §9 "There is no weather engine".
- **Retail:** `GameSky` (acclient.h:35420) holds `before_sky_cell` (nominally drawn before
  landblocks) and `after_sky_cell` — "the weather cell" — drawn **after** landblocks and gated on
  `LScape::weather_enabled`. `GameSky::Draw(0)` iterates `sky_obj` via
  `CPhysicsObj::DrawRecursive`; only `after_sky_cell` goes through `DrawObjCellForDummies` (308502),
  so `before_sky_cell` is never actually drawn.
- **holtburger today:** a fully procedural atmosphere/cloud pipeline (`atmosphere_pipeline.js`,
  `cloud_overlay.js`, `cloud_volume.js`) plus DAT sky objects as billboards from
  `crates/holtburger-world/src/sky.rs` (`day_group.sky_objects`, :517-518) fed via `loop.js:1081`.
  No weather EnvCell geometry and no `weather_enabled` gate.
- **Change:** (a) add a `weatherEnabled` gate mirroring `LScape::weather_enabled`; (b) evaluate
  loading the region's weather EnvCell geometry as a real, DAT-sourced layer drawn after the world
  — an untapped fidelity source that would also give the UV-scroll driver of RND-31 something
  authored to scroll.
- **Payoff:** [FID] retail's actual weather visuals; a clean on/off gate for headless runs.
- **Effort:** L (DAT cell) / S (gate only). **Validation:** WB.Terminal dump of the region's
  `after_sky_cell` EnvCell to confirm content, then a 1070 eye-test.

### RND-19 — `PersistentAtDay` / always-daylight mode **[FID + tooling]**
- **Source:** §9 "`PlayerModule::PersistentAtDay` → `LScape::SetDay`".
- **Retail:** `PersistentAtDay` (511150) → `LScape::SetDay` (306897) sets `m_fAlwaysDaylight`,
  making `set_landscape_lighting` discard the real time and re-query `GetLighting(0.5)`. The
  documented consequence: **terrain and object lighting pin to noon while the sky objects keep
  moving.**
- **holtburger today:** no equivalent found.
- **Change:** add `?alwaysDay` (and a settings toggle) that forces the terrain/object lighting
  evaluation to `time_of_day = 0.5` while leaving the sky-object advance alone — matching retail's
  asymmetry exactly (it is a recognisable AC look, not a bug).
- **Payoff:** [FID] a real retail user option; [tooling] deterministic lighting for headless
  screenshots and A/B eye-tests, which currently drift with game time.
- **Effort:** S. **Validation:** two headless screenshots 6 game-hours apart — terrain identical,
  sky different.

### RND-20 — Retail terrain/object per-vertex DIFFUSE lighting channel (see also RND-21) **[FID]**
- **Source:** §3 FVF table + §5 vertex assembly.
- **Retail:** both live world FVFs carry DIFFUSE: objects `0x252` (XYZ|NORMAL|DIFFUSE|TEX2),
  landscape `0x242` (XYZ|DIFFUSE|TEX2). `landPolyDraw` (719994) writes per-vertex terrain lighting
  from `curLandBlockVertexLighting` into that channel each frame, and the detail-fade alpha
  (RND-15's 10→50 ramp) rides the same vertex colour.
- **holtburger today:** terrain lighting is computed in the fragment shader from normals + the
  scene sun; there is no per-vertex baked lighting channel (`CLandBlockStruct::calc_lighting` is
  referenced only as a comment in `crates/holtburger-dat/src/terrain_subdiv.rs:474`).
- **Change:** bake `calc_lighting`'s per-vertex terrain light into a vertex-colour attribute in the
  terrain bake (Rust), and multiply it in. Pairs with RND-04 (same mechanism, different geometry
  class) and with RND-11 (the 0.2 floor applies to it).
- **Payoff:** [FID] retail terrain shading has a characteristic per-vertex, faceted quality the
  smooth per-fragment model lacks; [PERF] moves per-frame lighting work to bake time.
- **Effort:** M–L. **Validation:** Rust golden test on a known LB's vertex colours; 1070
  screenshot pair.

### RND-21 — Second UV set on object geometry **[FID]**
- **Source:** §3 FVF table (`TEX2` on both `0x252` and `0x242`).
- **Retail:** object and landscape vertices both carry **two** texture coordinate sets; the second
  is what the detail layer (RND-06/RND-07) samples, independently of the base UV.
- **holtburger today:** object geometry from `pack_model_mesh` carries a single UV set (the decode
  path documented in `memory/holtburger-perf.md`: `fetch_model_meshes → triangulate_model →
  pack_model_mesh`); the terrain detail layer synthesises its UVs from a grid UV
  (`terrain.js:611-617`, `uDetailTexBaseScale`) rather than reading an authored second set.
- **Change:** emit `uv2` from the wasm packer where the DAT supplies it, and have the detail layer
  prefer `uv2` over the synthesised grid UV.
- **Payoff:** [FID] prerequisite for authored detail placement (RND-06) rather than procedural
  tiling.
- **Effort:** M. **Validation:** `__diag.geometry` attribute census; visual A/B once RND-06 lands.

### RND-22 — Selection highlight as a luminosity/diffuse bump on a COW material, with the 4-flip blink **[FID]**
- **Source:** §8 "Selection 'glow' is not an outline pass".
- **Retail:** `CPhysicsObj::SetLighting(0.99, 1.0)` (275686 → 318929 → 315325 →
  `CMaterial::SetLuminositySimple`) copies the part's `CMaterial` and raises luminosity to 0.99 and
  diffuse to 1.0; on confirm there is a **four-flip, 0.2 s** blink (275388-275415).
- **holtburger today:** a world-space selection ring mesh at `renderOrder = 10`
  (`entities.js:6744`).
- **Change:** add the material-luminosity highlight (the machinery exists —
  `applyFloatLumDiffuse`, `materials.js:1306`, and the `__baseTranslucency` COW precedent at
  :1357) plus the 4-flip confirm blink; keep the ring as an optional modern affordance.
- **Payoff:** [FID] the retail "the thing you clicked lights up" feel, and the confirm blink is a
  real gameplay signal AC players read.
- **Effort:** S–M. **Validation:** 1070 click test; `__diag.input` selection events.

### RND-23 — `VividTargetIndicator` corner brackets + off-screen compass arrow **[FID]**
- **Source:** §8 "`xformPointInternal` … `VividTargetIndicator::OnDraw`".
- **Retail:** `SmartBox::GetObjectBoundingBox` (144083) projects the selection sphere's viewer-space
  AABB into a `tagRECT` via `xformPointInternal` (453759, at 144140/144146) for
  `SmartBox::target_callback`; `VividTargetIndicator::OnDraw` (289744) then moves **four corner
  bracket widgets** to that rect, or shows an **edge arrow from a compass heading** when the target
  is off-screen.
- **holtburger today:** no bracket/arrow indicator; selection is the world-space ring.
- **Change:** compute the screen AABB of the selected entity's bounds each frame and drive four DOM
  (or sprite) brackets; when the projected point is off-screen, place an edge arrow from the bearing.
- **Payoff:** [FID] retail's target UI; practically useful for off-screen target tracking in combat.
- **Effort:** M. **Validation:** headless bracket-rect assertions against known entity positions;
  1070 combat eye-test.

### RND-24 — `translucency == 1.0` skips the part entirely **[PERF + FID]**
- **Source:** §10 "A translucency of exactly 1.0 sets `draw_state |= 1` and the part is skipped".
- **Retail:** `CPhysicsPart::SetTranslucency` (315488) → `CMaterial::SetTranslucencySimple`
  (360594) sets all four material alphas to `1 − t`; at `t == 1.0` it sets `draw_state |= 1` and the
  part is not drawn at all.
- **holtburger today:** `materials.js:1351-1353` sets `opacity = max(0, 1 − sfTranslucency)` and
  stashes the authored base at :1357, but nothing skips the draw at `t == 1.0` — a fully
  transparent part still submits geometry.
- **Change:** set `mesh.visible = false` (or skip the batch slot) when the effective translucency
  reaches 1.0, and restore it when a hook ramps it back (the `__baseTranslucency` stash already
  supports the floor logic).
- **Payoff:** [PERF] free draw-call removal wherever server-driven translucency fully hides a part
  (invisibility, phased NPCs, some spell effects); [FID] avoids alpha-blend cost and any 1-bit
  rounding residue.
- **Effort:** S. **Validation:** `renderer.info.render.calls` delta while an entity is made fully
  translucent via the live ACE server.

### RND-25 — Force full detail for previews (`degrades_disabled`) **[FID]**
- **Source:** §7 "Globals `degrades_disabled` and `Render::force_level`".
- **Retail:** `degrades_disabled` and `Render::force_level` (default −1) override band selection
  entirely (332367-332380); the creature preview sets `degrades_disabled = 1` for its own render
  (143914). Retail also temporarily re-anchors the audio listener to the creature-view frame during
  `CreatureMode::Render` (143931/143934).
- **holtburger today:** no force/disable override exists in either LOD consumer, so a
  paperdoll/creature preview can render a degraded model; and the audio listener is unconditionally
  the world camera (`index.js:2090-2101`).
- **Change:** add `scene3d.forceFullDetail` / `forceLodLevel` honoured by RND-01's selector, set
  during preview renders; optionally re-anchor the listener during preview.
- **Payoff:** [FID] previews are close-up and are exactly where LOD artefacts show.
- **Effort:** S. **Validation:** preview screenshot A/B; `__diag.lod` substitution counter should
  read 0 during a preview.

### RND-26 — Reconcile far plane and object sort thresholds with retail **[PERF]**
- **Source:** §7 + §11 (constants surfaced during verification).
- **Retail:** `Render::zfar = 4000.0` (45527), `Render::scale = 4000.0` (45524),
  `vdst = 0.0625` derived (45525). `IDEAL_OBJECT_SORT_DISTANCE = 25.0` and
  `IDEAL_PARTICLE_SORT_DISTANCE = 16.0` (41515-41516) are the XY-only thresholds that gate the
  heading-carrying `UpdateViewerDistance` path (317932-317934).
- **holtburger today:** `far = 5000` (`index.js:1255`); no distance horizon at all by default
  (`culling.js:86-104`: `cullDistSq = Infinity` unless `?cullDist=N`, with a documented rationale —
  the loaded ring diagonal is ~1764 m and clear-weather fog reaches ~2500 m).
- **Change:** with RND-14 landing a preset ring radius, derive `far` and an actual `cullDist` from
  it (ring diagonal + fog reach) instead of a fixed 5000/Infinity. Adopt the 25 m / 16 m XY
  thresholds as the gates for RND-03's billboard/particle work.
- **Payoff:** [PERF] a real distance horizon becomes safe once it is derived from the ring rather
  than guessed; depth precision improves with a tighter far plane.
- **Effort:** S. **Validation:** `?cullDist` sweep with `__diag.geometry` visible-count and a
  screenshot check for horizon popping.

### RND-27 — Portal-depth prepass: partial Z clear + portal polygons into depth **[PERF + FID]**
- **Source:** §6 "`DrawCells` … flushes alpha, partially clears Z, draws portal polygons into the
  depth buffer".
- **Retail:** `PView::DrawCells` (461450) draws the landscape through visible outdoor portals,
  flushes the alpha list, **partially clears Z**, writes the portal polygons into the depth buffer,
  then draws each `CEnvCell` (`DrawEnvCell` 456878) and finally the dynamic objects
  (`DrawObjCellForDummies` 458143).
- **holtburger today:** `portal_stencil.js` (stencil masking) and `portal_punch.js` (depth punch),
  both driven from `cells.js:1462/1606` — but no partial-Z-clear + portal-polys-into-depth prepass.
  `lib.rs:32195-32210` documents the resulting artefact class ("floating dungeons in the sky",
  "UNCLIPPED (no `PView::GetClip` yet)") and works around it with a 100 m float-cull band.
- **Change:** write the visible portal apertures (already available:
  `get_visible_portal_apertures`, `lib.rs:32013`) into the depth buffer as a prepass, so interior
  cells are depth-bounded by their aperture rather than heuristically z-banded.
- **Payoff:** [FID] removes the float-cull heuristic and its 100 m magic band; [PERF] early-Z
  rejects interior geometry not visible through the aperture.
- **Effort:** L. **Validation:** `?stablist=on` with the prepass — the Holtburg cells named in
  `lib.rs:32166-32168` (0xA9B40158/0166/016B) must not appear; `__diag.pvs` set size.

### RND-28 — Per-portal-view sphere-vs-viewcone culling + cross-view draw dedup **[PERF]**
- **Source:** §6 "Per-object culling is a sphere-versus-viewcone test per portal view".
- **Retail:** `RenderDeviceD3D::DrawMesh` (458209) tests each object's sphere against the current
  portal view's cone, with `m_nFrameStamp` and `DrawnThisFrame` preventing duplicate draws when an
  object is visible through more than one portal view.
- **holtburger today:** cell-granular visibility from the wasm PVS plus one whole-scene AC-space
  frustum test per object (`culling.js:185-188`, `tickFrustumCull` :264-312). No per-view cone test,
  no dedup stamp — an object reachable through two apertures can be submitted twice.
- **Change:** carry each admitted cell's clip polygon out of the Rust walk, derive a cone/frustum
  per view, and test object spheres against it; add a per-frame stamp on submission.
- **Payoff:** [PERF] cuts submissions in multi-aperture interiors, which is exactly the case the
  `?stablist` work made heavier.
- **Effort:** M–L. **Validation:** `probe1070.cjs attrib` draw census in a multi-door building
  before/after; assert no object appears twice.

### RND-29 — Complete `PView::GetClip` for the stablist path **[FID]**
- **Source:** §6 (portal clipping) — and holtburger's own `lib.rs:32196-32206` TODO.
- **Retail:** `ClipPortals` / `GetClip` build per-cell view cones from clipped portal polygons; a
  cell enters `cell_draw_list` only with a valid clip region.
- **holtburger today:** the `?stablist` render admits every frustum-visible `SeenOutside` cell
  **unclipped**, guarded only by the 100 m `FLOAT_CULL_BAND_M` heuristic (`lib.rs:32215-32250`);
  the comment states the flag is OFF by default "until the portal clip lands".
- **Change:** feed stablist-admitted cells through the same aperture clip the `outdoorPview` walk
  already uses (`lib.rs:32285+`), then retire `FLOAT_CULL_BAND_M` and promote `?stablist`.
- **Payoff:** [FID] building interiors visible from outside (furniture, fountains) without sky
  floaters — the acknowledged open artefact.
- **Effort:** M. **Validation:** the named Holtburg cells stay hidden; interior statics appear over
  a courtyard wall; `__diag.pvs`.

### RND-30 — Decide the TexMerge default: retail's terrain texturing *is* the merge **[FID]**
- **Source:** §5 "Texture splatting is offline software work".
- **Retail:** `LandSurf::SelectTerrain` (304328) + `TexMerge::Merge` (304839) composite base terrain
  textures, transition alpha maps and road alpha maps (`FindTerrainAlpha` 304756) into
  per-combination merged textures via `ImgTex::MergeTexture` (365632), including the mid-point
  alpha rounding at 365787-365798. **There is no runtime terrain blending in retail.**
- **holtburger today:** the composite exists behind `?texMerge` but was flipped **DEFAULT-OFF** on
  2026-06-21 (`terrain.js:2820-2850`) after a 1070 session found per-cell flat tiles reading as
  "big blocks" and road alpha masks painting a "two-lane highway". The shipped default is a
  bilinear four-corner cross-dissolve plus a legacy road painter — neither of which is retail's
  mechanism.
- **Change:** treat the two reported defects as bugs in the *port*, not in the mechanism:
  (a) the "big blocks" symptom points at per-cell rather than per-vertex-quad merge granularity or
  a missing bilinear sample of the merged tile; (b) the road width symptom points at the road alpha
  being applied to both adjacent cell columns of a road vertex-line instead of the authored lane.
  Fix both against the DAT (`FindTerrainAlpha` semantics), then re-eye-test and promote.
- **Payoff:** [FID] terrain currently does not use retail's texturing algorithm at all — the single
  largest remaining terrain-appearance divergence.
- **Effort:** L. **Validation:** WB.Terminal `get-terrain-textures` + a merged-tile golden test in
  Rust; 1070 A/B on a road-through-biome-boundary LB.

### RND-31 — `SetTextureVelocity` UV scroll for sky/weather surfaces **[FID]**
- **Source:** §9 "Clouds and precipitation 'move' via `CPhysicsObj::SetTextureVelocity` UV scroll —
  there is no wind vector and no particle path".
- **Retail:** cloud and precipitation motion is *entirely* UV scroll on the weather cell's
  surfaces; `CelestialPosition::pes_id` is parsed and never consumed (so no particle emitters are
  attached to celestial objects).
- **holtburger today:** the entity-side texture-velocity hook exists
  (`entities.js:14191/14198`) but nothing drives UV scroll on sky/cloud surfaces; the procedural
  cloud layers animate via their own noise.
- **Change:** add a UV-scroll driver for sky/weather materials fed from the DAT's texture-velocity
  fields; use it for RND-18's weather cell.
- **Payoff:** [FID] retail's cloud motion signature (uniform UV drift, no parallax) rather than
  volumetric noise advection.
- **Effort:** S–M. **Validation:** 1070 sky timelapse A/B.

### RND-32 — Resolve the additive-fog-exemption residual in the aerial-perspective pass **[FID]**
- **Source:** §9 fog + §10 additive blend.
- **Retail:** fog is linear range fog only (`SetFFFogProperties` 460308 writes FOGCOLOR/START/END,
  no density) behind four independent disable flags; **ADDITIVE surfaces disable fog for the draw**
  (`SetFFFogAlphaDisabled(1)` at 454551-454553, body `SetRenderState(D3DRS_FOGENABLE, FALSE)` at
  460295-460302) — a per-draw skip, not a fog-to-black.
- **holtburger today:** `material.fog = false` under `?surfaceParityV2` covers only the `scene.fog`
  paths (`?fogLerp`, the wireframe `FogExp2`); the default Bruneton aerial-perspective post pass is
  screen-space and structurally cannot honour a per-draw exemption. Recorded as a residual in
  `docs/url-flags.md:235` (A10-M3 §6 OQ-2).
- **Change:** pick one: (a) write an "additive mask" to a second render target and skip aerial
  perspective there; (b) render additive surfaces in a separate pass after the atmosphere composite;
  (c) accept the residual and state it as a known divergence in the docs.
- **Payoff:** [FID] flames and spell glows currently haze toward fog colour at distance/night,
  which retail never did.
- **Effort:** M (option b) / L (option a). **Validation:** V12 — foggy-night flame A/B on the 1070.

### RND-33 — Texture WRAP-vs-CLAMP from the stipple bit **[FID]**
- **Source:** §10 "There is no stipple or screen-door path in the D3D build."
- **Retail:** the `stippled` flag does **not** select a screen-door pattern; it selects texture
  address mode **WRAP versus CLAMP**, and on the same line sets
  `Render::curr_surface_type |= 0x40000000` (acclient.c:454437).
- **holtburger today:** no stipple-derived wrap selection was found in the surface path; wrap mode
  is set per-use rather than from the surface bit.
- **Change:** thread the stipple bit out of the wasm surface decode alongside `hasPalette` (the
  A10-M3a precedent) and set `wrapS/wrapT` to `ClampToEdgeWrapping` vs `RepeatWrapping` from it.
- **Payoff:** [FID] removes a class of edge-bleed / tile-repeat artefacts on surfaces authored for
  clamping (decals, signage, single-tile panels).
- **Effort:** S. **Validation:** `__diag.assets` surface-flag census; 1070 look at a signage/decal
  surface.

---

### AUD-01 — 16-voice pool with priority stealing **[PERF + FID]**
- **Source:** 09-audio.md §2 "Voice pool and stealing".
- **Retail:** `SoundManager::playing_sounds_` is a fixed array of **16**
  `SoundPlayingData {SoundBuf* buffer; float priority; double start_time}` (acclient.h:46404).
  `PlaySoundInternal(SoundBufRef*, pan, attenuation)` (383004, re-read this pass) round-robins from
  `curr_playing_buffer_` taking the first slot that is empty, has priority 0, or whose
  `GetStatus() & 1` (DSBSTATUS_PLAYING) is clear. If all 16 are live it makes a second pass for a
  slot whose stored priority is **strictly less than** the new sound's `data_.priority_`, stops and
  deletes that voice and reuses the slot; if no slot loses the comparison **the new sound is
  dropped**. `curr_playing_buffer_ = (slot + 1) % 16` after each play.
- **holtburger today:** ABSENT. `audio_manager.js` (all 519 lines read) creates a fresh
  `AudioBufferSourceNode` + `GainNode` + `PannerNode` per `play()` (:416-453) with no cap and no
  priority; the nodes are torn down in `onended` (:462-467). `SoundTableCache.resolveSound` resolves
  `priority` and the callers never use it (`sound_table_cache.js:252`).
- **Change:** add a voice pool to `AudioManager`: 16 slots, round-robin acquisition, retail's
  priority-steal rule, and a drop path that increments a diag counter. Thread `entry.priority`
  through from `resolveSound` at all three call sites (ambient continuous, ambient probabilistic,
  animation-hook / GMSound).
- **Payoff:** [PERF] bounds the Web Audio graph in a busy fight or a dense ambient bed (today an
  unbounded number of concurrent sources is possible); [FID] retail's characteristic
  "important sounds win, unimportant ones vanish" mix. Note this makes `priority_` load-bearing for
  the first time, which is also what makes the STable data meaningful.
- **Effort:** M. **Validation:** headless — fire 40 sounds in one frame via `window.__playWave` and
  assert `playCount ≤ 16` concurrent + a non-zero drop counter; `?eventLog=on` record count vs
  actual starts.

### AUD-02 — Ambient bed as a distance-weighted mixture over all loaded cells **[FID]**
- **Source:** §5 "Selection is per landcell, by terrain type plus scene type" + `CalcWeight` +
  `UpdateSound`.
- **Retail:** `CLandBlock::add_ambient_sounds` (352444) walks **every cell** of the block,
  extracting `terrain_id = (t >> 2) & 0x1F` and `scene_type_id = t >> 11`, resolving
  `CRegionDesc::GetSTBDesc → CTerrainDesc::GetSTBDesc → CSceneType::sound_table_desc`
  (299022, 303290), lazily loading via `AmbientSTBDesc::InitSoundTable` (299000), and calling
  `Ambient::AddSound` **with the cell's own world position**. `LScape::add_ambient_sounds` (307180)
  drives that over **all loaded blocks**. Each contribution is weighted by `Ambient::CalcWeight`
  (383857, re-read): `0` past `max_dist_sq = 14400`, `1.0` inside `min_dist_sq = 400`, else
  `min_dist_sq / d²`. Weights accumulate into `total_sound_count`, and `UpdateSound` normalises:
  `IntermitSound::play_chance = base_chance · sound_count / total_weight` (384200),
  `ConstantSound::current_volume = desc.volume · sound_count / total_weight` (384295).
  **That normalisation is the entire crossfade mechanism** — no envelopes, no timed fades.
- **holtburger today:** one active STB derived from the single nearest vertex of the player's own
  landblock: `_sampleTerrainVertex` snaps to the nearest 24 m vertex of the 9×9 grid
  (`ambient_runtime.js:671-709`), then `_bakedStbForVertex` / `ambientStbForTerrainCode` picks one
  STB (`:390-413`), and an STB change hard-stops all loops and clears all timers (`:430-437`).
  Gains are raw `volume · resolved.volume` (`:811`, `:897`) and rolls use raw `baseChance` (`:478`).
- **Change:** replace the single-STB model with a weighted multiset. Do the accumulation in **Rust**
  (it is per-cell world-position geometry over the loaded set — system state, not view state): walk
  the loaded LBs' terrain words, group by `(terrain_type, scene_type)` → STB, compute `CalcWeight`
  per cell against the listener, sum into `total_weight`, and export a per-`(stbId, sType)` list of
  `{normalizedChance, normalizedVolume, weightedDirections}`. `AmbientRuntime` then just schedules.
  The baked event feed already resolves the real `scene_type` per vertex
  (`baked_ambient_source.js:12`), so the per-cell STB resolution is already available.
- **Payoff:** [FID] the single largest audio divergence: today the bed switches abruptly at a
  vertex boundary and every sound plays at full authored volume regardless of how much of the
  surrounding terrain actually carries it. Retail crossfades continuously as you walk.
- **Effort:** L. **Validation:** `__ambient.stats()` extended with the weight table; headless walk
  across a Grassland→Forest boundary asserting monotonic weight transfer instead of a step;
  `?eventLog=on` fire-rate comparison.

### AUD-03 — Continuous ambients are re-fired one-shots with re-derived volume and a 0.03 floor **[FID]**
- **Source:** §5 (`GetPlayInterval`, `ConstantSound::CanHear`, `min_vol`).
- **Retail:** `ConstantSound::GetPlayInterval` (384013) returns plain `min_rate` — the sound is
  **re-queued and re-played** every `min_rate` seconds, and `Ambient::Play` (384452) calls
  `GetVolume` afresh each fire, so the volume tracks the player's movement. `ConstantSound::CanHear`
  (383944) returns false when that volume is below `Ambient::ambient_sound_min_vol = 0.03`
  (45650), and `Ambient::Play`'s `else` branch then sets `on_queue = 0` — the sound leaves the
  queue until the next rebuild. Each fire also re-rolls the STable variant (`GetSound`) and the
  per-entry `probability_` (`PlayAmbientSound` 383530-383536).
- **holtburger today:** `_startContinuousLoop` (`ambient_runtime.js:788-871`) starts ONE
  `loop: true` source per `sType` per STB activation, with a gain fixed at start
  (`gain = clamp01(ambientVolume · resolved.volume)`, :811), and never re-derives it; the loop only
  ends on STB change or indoor transition (`:961-966`). No min-volume floor.
- **Change:** convert continuous ambients to a re-fire schedule at `min_rate` with per-fire volume
  re-derivation (from AUD-02's normalised weight), a `< 0.03` drop, and a per-fire variant +
  probability roll. Keep an option to cross-fade the re-fires slightly if the re-trigger seam is
  audible in the browser (retail's seam was masked by the wave length matching `min_rate`).
- **Payoff:** [FID] the ambient bed breathes with movement instead of being constant-then-cut. This
  is what makes AC's forests and towns feel alive.
- **Effort:** M. **Validation:** `__ambient.stats()` continuous-fire counter should advance at
  `min_rate`; headless walk asserting gain monotonicity as distance grows.

### AUD-04 — Intermittent ambient emitter positions: random octant, ±11.25° jitter, squared radial distribution **[FID]**
- **Source:** §5 `IntermitSound::GetSoundPos`.
- **Retail:** `IntermitSound::GetSoundPos` (384212, re-read this pass):
  `dir = sound_dir[floor(RollDice(0, num_dir))]`;
  `heading = LandDefs::heading(dir) + RollDice(0, upper_bound) − upper_bound·0.5` with
  `upper_bound = 0.39269909` = **π/8** (45651) ⇒ ±11.25° jitter about the octant heading;
  `u = RollDice(0,1)`; `d = min_dist[dir] + (max_dist[dir] − min_dist[dir])·u²` (note the **squared**
  factor — a near-biased radial distribution); emitter = `base.xy + d·(sin h, cos h)` with **z copied
  from the base position**. If `GetSoundPos` returns 0 the sound instead plays via
  `PlayAmbientSoundFromCenter` (pan 0).
- **holtburger today:** both continuous and probabilistic ambients play **at the listener
  position** (`ambient_runtime.js:839-846` and `:923-930`, each transforming `listenerPos` through
  `acToThree`), so every ambient one-shot arrives centred.
- **Change:** synthesise the emitter position exactly as above from AUD-05's per-direction ranges,
  and pass that (not the listener) to `audioManager.play`. HRTF then does the rest — and the
  existing `-50 dB` cull at 88.91 m (`audio_manager.js:391`) becomes meaningful for ambients.
- **Payoff:** [FID] birds, wind gusts and waterfalls come from *somewhere* instead of from inside
  your head. Very high perceived-quality-per-line-of-code given HRTF is already wired.
- **Effort:** S–M (given AUD-05). **Validation:** `?eventLog=on` — assert `world_pos` differs from
  the listener position and the bearing distribution matches the registered octants over ~200 fires.

### AUD-05 — Per-direction registration: `CalcDir` octants and the all-eight close-range mode **[FID]**
- **Source:** §5 `Ambient::CalcDir` + `IntermitSound::AddTo`.
- **Retail:** `Ambient::CalcDir` (383880, re-read) uses **only x and y** and is **not** an equal
  45° partition: with `ax = |x|`, `ay = |y|`, if `ax < 0.0002 || ay/ax > 2.0` → N (1) or S (2) by
  `sign(y)`; else if `ay < 0.0002 || ax/ay > 2.0` → E (3) / W (4) by `sign(x)`; else the four
  diagonals (5-8). It returns **0** when `x² + y² < ambient_sound_min_dist_sq · 0.5` (= 200).
  `IntermitSound::AddTo` (384260) with `offset = ambient_sound_min_dist · 0.5 = 10.0`:
  for `dir != 0` → `AddDir(dir, d − 10, d + 10)`; for `dir == 0` → `AddDir` on **all eight**
  directions with `min = 4.0, max = 10.0` — an undocumented omnidirectional close-range mode.
  `ConstantSound::AddTo` (383966) ignores direction entirely and only accumulates weight.
- **holtburger today:** ABSENT — no directional model at all.
- **Change:** implement the octant classifier and the eight per-direction `[min, max]` range
  accumulators alongside AUD-02's weight pass (also in Rust); expose them to `AmbientRuntime` for
  AUD-04's position synthesis.
- **Payoff:** [FID] prerequisite for AUD-04; also encodes the real spatial layout of the bed
  (a waterfall to your east stays east).
- **Effort:** M. **Validation:** Rust unit tests against the classifier's 2:1 ratio boundaries and
  the `< 200` all-eight case; `__ambient.stats()` direction table.

### AUD-06 — Absolute-time play queue, `on_queue` drop, and rebuild-on-cell-change **[FID]**
- **Source:** §5 `Ambient::UseTime` / `Ambient::Play` / `CellManager::ChangePosition`.
- **Retail:** `Ambient` holds a `PQueueArray<double>` of scheduled play times.
  `Ambient::UseTime` (384507) pops while `key < Timer::cur_time` and calls `Ambient::Play` (384452),
  which checks `CanHear` → `PlayNow` → `GetSoundPos` → play, then re-queues at
  `now + GetPlayInterval` (`RollDice(min_rate, max_rate)` for intermittent, `min_rate` for
  constant) and sets `on_queue = 1`. **If `CanHear` is false the sound is not re-queued**
  (`on_queue = 0`) — it only re-enters via a rebuild. The set is rebuilt on cell change in
  `CellManager::ChangePosition` (146646): `InitSounds` → `add_ambient_sounds` → `UpdatePlayQueue` →
  `ReleaseSoundTables`, the last dropping STables whose `play_count == 0` (146461).
  `IntermitSound::PlayNow` (383937) is `RollDice(0,1) <= play_chance` (inclusive `<=`).
- **holtburger today:** per-`sType` countdown timers decremented by a wall-clock dt capped at 1 s
  (`ambient_runtime.js:294-315`, `:462-483`) — reasonable for intermittents — but no absolute-time
  queue, no `on_queue` drop, no per-cell-change rebuild (only STB-change), and no STable release
  (`SoundTableCache` evicts nothing outside `dispose()`, `:323-332`).
- **Change:** replace the timer map with a min-heap of `{whenMs, key}`; drive it from the same
  wall clock; drop entries whose `CanHear` fails and re-seed them on the AUD-02 rebuild; add STable
  refcount + release on rebuild.
- **Payoff:** [FID] correct scheduling semantics and bounded work per tick (a heap pop beats
  walking every entry); [PERF] STable release stops unbounded cache growth over a long session.
- **Effort:** M. **Validation:** `__ambient.stats()` queue length + `soundTableCache.stats().cached`
  over a long `@telepoi` tour — both should plateau.

### AUD-07 — Roll the per-entry `probability_` on the ambient path **[FID]**
- **Source:** §5 + §4 ("its callers do").
- **Retail:** `SoundManager::PlayAmbientSound` (383518-383536, re-read) rolls
  `(double)rand() * 0.000030518509 < current_data.probability_` **after** `GetSound` picks the
  variant, and only then calls `PlaySoundInternal`. `PlayAmbientSoundFromCenter` (383542) does the
  same. So an ambient fire passes **two** gates: the normalised `play_chance` (AUD-02) and the
  variant's own `probability_`.
- **holtburger today:** `_fireProbabilistic` rolls only `entry.baseChance`
  (`ambient_runtime.js:478-479`) and then plays unconditionally once `resolveSound` returns
  (`:896-897`); `resolved.probability` is available and unused. The animation-hook path *does* roll
  it correctly (`entities.js:13780-13793`), so this is an inconsistency between two call sites.
- **Change:** add the `rng() < resolved.probability` gate to both ambient fire paths, using the
  cache's rng for test determinism (the pattern already used at `entities.js:13785`).
- **Payoff:** [FID] ambient fire rates are currently too high wherever a variant carries
  `probability < 1.0`.
- **Effort:** S. **Validation:** `?eventLog=on` fire-count comparison against a WB.Terminal dump of
  the STB's probabilities.

### AUD-08 — Interface sound category, UI SoundTable resolution, and `MD_Data_Sound` scripts **[FID]**
- **Source:** §7 "UI sounds".
- **Retail:** two routes, both through `PlaySoundFromCenter` (pan 0, distance 0):
  (1) `MD_Data_Sound {DID m_file; SoundType m_stype}` (acclient.h:34146) executed by
  `MediaMachine::Update_Sound` (162243) — if `m_stype != 0`, `m_file` is an STable DID
  (`DBObj::Get(…, 0x22)`) and the type is looked up in it; if `m_stype == 0`, `m_file` is a direct
  wave DID at volume 1.0 (and, per §2, with no `CreateSound` fallback).
  (2) hard-coded calls via `ClientUISystem::GetUISoundTable` (401286,
  `DBObj::GetByEnum(0x10000003, 7, 0x22)`) — teleport in/out
  (`gmSmartBoxUI::BeginTeleportAnimation` / `UseTime`, 261845/262562) and the `/environs` bank of
  22 sounds (396439-396539). `Sound_UI_ButtonPress`, `IconPickUp`, `GeneralError` appear only in
  the enum — they are authored into DAT UI media scripts.
- **holtburger today:** partial. The environs bank works via a **scanned** DID `0x2000004B`
  (`index.html:9079-9090`, with a `window.__environSoundTableDid` override) and portal enter/exit
  waves are hard-coded (`portal_space.js:60-70`, verified DIDs 0x0A000246/0x0A000245).
  Missing: the `GetByEnum(0x10000003, 7, 0x22)` resolution path, an interface category/bus, and any
  `MD_Data_Sound` executor — so all DAT-authored UI sounds (button press, icon pickup, drop,
  slider, error, transient message) are silent.
- **Change:** (a) add `resolveUiSoundTable()` using the enum-based lookup; (b) add an `interface`
  category bus alongside effect/ambient in `AudioManager`; (c) implement an `MD_Data_Sound`
  executor so DAT UI media scripts fire. Do **not** add an interface *volume* slider — see A37.
- **Payoff:** [FID] the entire retail UI soundscape is currently absent; it is a large part of how
  AC "feels".
- **Effort:** M. **Validation:** `?eventLog=on` records with `source:"UI"` on button press / icon
  drag; WB.Terminal `ui-layout-list` cross-check of which layouts carry sound media.

### AUD-09 — `PlaySoundOnlyWhenActive`: suspend audio when the page is hidden **[PERF + FID]**
- **Source:** §2 + §8.
- **Retail:** both `PlaySoundInternal` overloads early-out entirely when
  `s_bPlaySoundOnlyWhenActive && !Device::m_bIsActiveApp` (383014, 383161), and the preference
  `Sound.PlaySoundOnlyWhenActive` defaults **true** (45627).
- **holtburger today:** ABSENT — no `visibilitychange` / `document.hidden` handler exists anywhere
  in `scene3d/` or `index.html` (verified by grep). `pauseAll()` exists (`audio_manager.js:495-498`)
  but nothing calls it on blur.
- **Change:** add a `visibilitychange` handler that calls `pauseAll()` (or gates `play()`) when
  `document.hidden`, plus a user preference defaulting ON to match retail.
- **Payoff:** [PERF] a backgrounded tab stops decoding and mixing; [FID] a real retail default that
  users expect.
- **Effort:** S. **Validation:** headless — set `document.hidden` via CDP `Page.setWebLifecycleState`
  or emulate, assert `skipCount` rises and `playCount` stops.

### AUD-10 — Quantise the *total* gain to whole dB, not just the per-call gain **[FID]**
- **Source:** §3 "Software positioning" / `GetAttenuation`.
- **Retail:** `SoundManager::GetAttenuation(distance, volume, &attenuation, is_ambient)` (383079,
  re-read in full):
  ```
  v4 = (d >= 5.0) ? 25.0 * volume / (d*d) : volume;   // VOL_MIN_DIST_SQ_13 == 25.0
  if (v4 > 1.0) v4 = 1.0;
  v5 = v4 * (is_ambient ? ambient_sound_volume : effect_sound_volume);
  if (v5 > 0.0) { attenuation = (int)ceil(log2(v5) * 6.0206);      // whole dB
                  if (attenuation >= VOL_MIN /* -50 */) return 1;
                  attenuation = VOL_MIN; return 0; }
  else { attenuation = VOL_MIN; return 0; }
  ```
  `SoundBuf::Play` then does `SetVolume(100 * attenuation)` (386140) — hundredths of a dB.
  **The quantisation is applied to the product of distance × volume × slider.**
- **holtburger today:** the 25/d² curve is bit-matched by `distanceModel:"exponential"` +
  `refDistance 5` + `rolloffFactor 2` (`audio_manager.js:31-33`, :422-427) — genuine parity — and
  the −50 dB cull at 88.91 m (:383-409) matches. But `_quantizeGainToDb` (:350-355) snaps **only**
  `opts.gain` (:445); the distance factor lives in the panner and the slider in the category bus,
  both continuous. Additionally `DEFAULT_MAX_DISTANCE = 200` (:33) is inert under the exponential
  model (the spec's exponential formula does not use `maxDistance`), so the comment at :33 is
  misleading.
- **Change:** compute the effective gain in JS (`25/max(d,5)² · volume · categoryGain`), quantise
  that with `_quantizeGainToDb`, and drive a single `GainNode` with it — using the panner for
  *direction only* (`refDistance` huge / `rolloffFactor` 0), which also makes the −50 dB cull exact
  rather than approximate. Delete or document the inert `maxDistance`.
- **Payoff:** [FID] exact retail loudness curve including the whole-dB stair; also removes an
  invisible mismatch between the cull threshold and the actual applied gain.
- **Effort:** S–M. **Validation:** headless unit test asserting `g'(d)` for d ∈ {1, 5, 10, 25, 50,
  88, 90} against the retail formula — the function is already static+pure for exactly this reason.

### AUD-11 — No directional cue inside 5 m, plus a Mono option **[FID]**
- **Source:** §3 "Software positioning".
- **Retail:** `PlaySoundInternal(pos)` (383152) computes
  `Δ = fmod(heading(pos→player) − player_heading, 360)` wrapped to ±180, then
  `pan = (int)(sin(Δ · 0.017453292) · −15.0)` — **but only when `|dist| >= 5.0`**, and it skips the
  whole pan computation when `SoundManager::s_SoundFeatures == 1` ("Mono"; the enum's two choices
  are at 793517-793518). Pan is relative to the **viewer's facing**, and is azimuth-only (no
  elevation).
- **holtburger today:** HRTF panning applies at every distance with no near-field flattening and no
  mono option (`audio_manager.js:420-434`).
- **Change:** (a) when the emitter is within 5 m of the listener, collapse the panner to the
  listener position (or set `panningModel:"equalpower"` with zero offset) so near sounds are
  non-directional as in retail; (b) add a Mono preference that bypasses the panner entirely.
  Do **not** port the ±15-step pan quantisation (see A5).
- **Payoff:** [FID] retail's near-field behaviour (your own footsteps and UI sounds are centred);
  accessibility win from the Mono option.
- **Effort:** S. **Validation:** headless assertion that a sound at 2 m produces equal L/R;
  `?eventLog=on` position records.

### AUD-12 — Eager wave decode at SoundTable load **[PERF-adjacent / FID]**
- **Source:** §2 "Buffer cache — eager, not lazy".
- **Retail:** every wave referenced by a loaded STable is decoded into a DirectSound static buffer
  **at table-load time** — `CreateSound` (383707) is called from `SoundHook::UnPack` (343075),
  `SoundTweakedHook::UnPack` (343140) and `SoundTableData::UnPack` (385488, function at 385399),
  and `UnPack` recurses into child nodes (385536), so the whole tree is decoded. `DestroySound`
  (383747) refcounts down at 343058, 343088, 385383. There is no lazy load and therefore no
  first-play latency.
- **holtburger today:** lazy — `_loadBuffer(did)` fetches + `decodeAudioData`s on first `play()`
  and caches the Promise (`audio_manager.js:268-331`). `SoundTableCache.preload(dids)`
  (:279-294) warms the *tables* only. `entities.js` notes a spawn-time prewarm of the cache but not
  of the waves.
- **Change:** on STable install, enumerate `soundKeys()` × `entriesForSound()` and kick
  `_loadBuffer` for every distinct wave DID (bounded concurrency, idle-time scheduled). Refcount by
  table so a released STable (AUD-06) can free its buffers.
- **Payoff:** [FID] removes first-occurrence silence/latency — the "the first footstep of a session
  is missing" class of bug; [PERF] moves decode off the interaction path into idle time.
- **Effort:** S–M. **Validation:** headless — after spawn, assert `_bufferCache.size` ≥ the wave
  count of the loaded tables and that the first hook fire has zero `skipCount`.

### AUD-13 — Full preference surface: three category enables + mono + play-only-when-active **[FID]**
- **Source:** §8 "Options and gains".
- **Retail:** `SoundManager::InitPrefs` (383284) registers eight entries:
  `Sound.SoundVolume` → `effect_sound_volume`, `Sound.AmbientSoundVolume` →
  `ambient_sound_volume`, `Sound.InterfaceSoundVolume` (**never read** — see A37),
  `Sound.SoundFeatures` (Stereo/Mono), `Sound.SoundDisabled`, `Sound.AmbientSoundDisabled`,
  `Sound.InterfaceSoundDisabled`, `Sound.PlaySoundOnlyWhenActive`. The three "Disabled" booleans are
  checked at the **entry points** (`PlaySoundA` 383504, `PlayAmbientSound*` 383524/383548,
  `PlaySoundFromCenter` 383570) so a disabled category never reaches the mixer at all.
  Defaults: all three `*_enabled` true, both volumes 1.0, `s_bPlaySoundOnlyWhenActive` true
  (45626-45627).
- **holtburger today:** master + effect + ambient **gains** only
  (`audio_manager.js:164-187`); no category enables (gain 0 still pays fetch + decode + node
  construction), no mono, no play-only-when-active.
- **Change:** add `effectEnabled` / `ambientEnabled` / `interfaceEnabled` booleans checked at the
  top of `play()` (before `_loadBuffer`), plus the Mono flag (AUD-11) and the visibility gate
  (AUD-09); surface all of them in the settings UI with retail's defaults.
- **Payoff:** [FID] retail's option surface; [PERF] a disabled category costs nothing.
- **Effort:** S. **Validation:** headless — disable ambient, assert `__ambient.stats()` still ticks
  (retail keeps the scheduler running) while `playCount` stops rising.

### AUD-14 — Verify baked `is_continuous` and rate fields against `AmbientSTBDesc::UnPack` **[FID]**
- **Source:** §5 `AmbientSoundDesc` layout.
- **Retail:** `AmbientSoundDesc` (acclient.h:35498) is
  `{SoundType stype; int is_continuous; float volume, base_chance, min_rate, max_rate}`, and
  `is_continuous` is **derived** in `AmbientSTBDesc::UnPack` (384535) as `base_chance == 0`.
  Pack size is `20 · num_sounds + 8` (`AmbientSTBDesc::pack_size` 384195), and `Pack` writes
  `base_chance` conditionally (384170-384176) — worth checking when round-tripping.
- **holtburger today:** the baked feed carries `continuous` as a boolean
  (`baked_ambient_source.js:106`) and the runtime consumes `isContinuous`
  (`ambient_runtime.js:450`). The derivation lives in the baker/wasm.
- **Change:** add a Rust test asserting `is_continuous == (base_chance == 0.0)` for every
  `AmbientSTBDesc` in the shipped `client_portal.dat`, and that the 20-byte stride matches
  `pack_size`. Cheap insurance against a mis-derived flag silently turning a drone into a one-shot
  or vice versa.
- **Payoff:** [FID] correctness guard on the field that decides AUD-03's whole code path.
- **Effort:** S. **Validation:** the Rust test itself (real DAT per the test-fixtures rule).

### AUD-15 — Defer `0xF750` SoundEvent on an unknown object and replay on creation **[FID]**
- **Source:** §7 "From the network — `0xF750` SoundEvent".
- **Retail:** dispatch `case 0xF750` → `CM_Physics::DispatchSB_SoundEvent` (392803 → 709642); blob
  is `u32 opcode | u32 object_id | u32 sound (SoundType) | float volume`. It forwards to
  `SmartBox::HandleSoundEvent` (143333), which resolves via `CObjectMaint::GetObjectA`; **if the
  object isn't known yet the blob is queued on the object (return code 4 = defer) and replayed on
  creation.** Otherwise `CPhysicsObj::play_sound(type, volume)` (316424) → `PlaySoundA`. The server
  only ever sends an abstract `SoundType` plus a volume — the wave choice is entirely client-side.
- **holtburger today:** the event is **dropped** when the entity is unknown:
  `stats.entityMissing += 1` plus a `console.debug(… "not in registry — skip")`
  (`index.html:8938-8945`). There is no defer queue and no replay on spawn. There is also a
  local-player SoundTable backfill hack at `index.html:8930-8937` / `entities.js:13756-13763`
  (see A17) which is a symptom of the same spawn-race.
- **Change:** queue unresolved sound events keyed by GUID (bounded, with a TTL) and drain the queue
  in the entity-spawn path — mirroring retail's return-code-4 defer. This also removes the need for
  parts of the local-player backfill hack.
- **Payoff:** [FID] recovers exactly the sounds most likely to be lost: a creature's spawn/attack
  vocalisation racing its own `ObjectCreate`, and every sound targeted at the local player before
  its self-create hydrates.
- **Effort:** S. **Validation:** `window.__soundTriggeredStats` — `entityMissing` should convert
  into a `deferredReplayed` counter; headless spawn-under-load run asserting zero net drops.

---

## 3. ANTI-TASKS — retail behaviours that must NOT be ported

**A1 — No shadows.** Retail has none: `CShadowObj {physobj, cell_id, cell}` (acclient.h:30935) and
`CShadowPart {num_planes, planes, frame, part}` (31254) are cell-membership and draw-sort
structures; `RenderPass_LandscapeShadowMap` / `AllowStencilShadows` /
`SpecialTexture_LandscapeShadows` are inert vocabulary of the UI-only material stack.
holtburger's CSM (`csm.js`, `quality.js` high/ultra `csm: true`) is a deliberate enhancement.
Do not remove it, and do not cite retail as evidence that shadow work is wasted.

**A2 — No world-space text.** Retail's hover name is a `UIElement` tooltip anchored to the **mouse**
(`StartTooltipAtMouse`, 275631/275763-275805, gated on `PlayerModule::ShowTooltips`); there are zero
nameplate/speech-bubble/damage-number strings in the binary. holtburger's `nameplate_sprite.js` and
`speech_bubble.js` are intentional modern additions. Keep them. (RND-23's corner brackets are an
*addition* alongside them, not a replacement.)

**A3 — Linear range fog.** `SetFFFogProperties` (460308) writes only FOGCOLOR/FOGSTART/FOGEND with
no density. Do not replace holtburger's Bruneton aerial-perspective pipeline with it. (The
*per-draw fog-skip* semantics for additive surfaces are a separate, real issue — RND-32.)

**A4 — Unsorted alpha flush.** `FlushAlphaList` (455064-455148) contains no comparison at all — two
straight `++`-indexed loops — and fires per landcell at 2250/3000 (`flush = 0.75`, 45787).
Combined with the fixed 3000-entry arrays that **silently drop geometry** on overflow, this is a
defect the coarse per-part `CYpt` sort only partly hides. three.js's depth-sorted transparent list
is strictly better. Port the *sort key* (RND-09), never the flush.

**A5 — 2D-only audio with ±15-step pan.** Every retail voice is a 2D buffer (`use_3D = 0` always,
383127): no listener position updates, no doppler, no DirectSound rolloff, and pan quantised to 31
integer steps then scaled ×100 (386102/386140). holtburger's HRTF `PannerNode` with a live
camera-anchored listener is better in every respect. Port the near-field flattening and the Mono
option (AUD-11); never the 2D buffer or the pan quantisation.

**A6 — Emitter state snapshotted by value at play time.** `PlaySoundA` reads `physobj->sound_table`
and `m_position` once (383681); a moving object never updates the pan or volume of an already-playing
sound. holtburger's `followGuid` tracking (`audio_manager.js:200-214`, `:472-477`) is a deliberate
improvement with the coordinate-frame fix already applied (`index.js:2113-2125`). Keep it.

**A7 — No surface-dependent footsteps.** There is no landblock surface query anywhere in retail's
sound selection; footstep variety comes only from the STable's random variant list for
`Sound_Footstep1/2`. Do not add terrain-material footstep switching "for realism" — it would be
audibly non-AC and would fight AUD-01's priority model for voices.

**A8 — Retail's per-draw state churn and light relinking.** The fixed-function `RenderStateCacheType`
(acclient.h:45869) makes per-draw state changes nearly free; WebGL does not. Two specific hazards
recorded from prior sessions apply to RND-05/RND-06: never change the **light count** on a live
material (three.js relinks the program → freeze), and never vary
`customProgramCacheKey` per instance (the single largest cold-load cost). Any port of retail's
per-object light selection must quantise to a small set of light counts, not follow retail's
"enable exactly N" literally.

**A9 — Retail's dead code as a design signal.** `RenderPassType` up to 0x2C, `ShaderResourceType`,
`ShaderVersionType`, `IDirect3DVertexShader9/PixelShader9`, the winmm MIDI player, and
`before_sky_cell` are all present-but-unreachable. Do not mine them for intent — the shipped
behaviour is the specification. (Recorded because two of the deep-dive's own first-pass errors came
from exactly this.)

---

## 4. OPEN QUESTIONS

1. **Doc correction, needs propagating.** 06-rendering.md §7's budget table labels
   `Render::object_distance_2dsq` / `particle_distance_2dsq` "object/particle cull distance". They
   are not cull distances — they are `min_2D_degrade_distance_sq` in
   `CPhysicsObj::UpdateViewerDistance` (317932-317934), the XY-only threshold beyond which the
   heading-carrying overload runs (enabling degrade + billboard re-orientation), and the base
   constants are literally named `IDEAL_OBJECT_SORT_DISTANCE = 25.0` /
   `IDEAL_PARTICLE_SORT_DISTANCE = 16.0` (41515-41516). Should the deep-dive be amended in place?

2. **Landscape detail: which way?** Retail hard-disables it (RND-07) but holtburger ships it ON and
   the user's own 2026-06-26 bump ("distant swaying trees are desirable") shows a preference for
   *more* visual richness than retail. This is a product decision, not a parity decision — needs a
   user call before either flipping the default or rewriting the comment.

3. **FOV and aspect.** Retail's 67.5° is a **vertical** FOV on a 4:3 default with a separate UI
   aspect clamp (`OnDeviceDisplayModeChange` 459096). At 16:9, matching the vertical FOV shows much
   more horizontally than retail ever did. Match vertical FOV, match horizontal, or match diagonal?

4. **`light_tick_size` = 20 s vs the environs ramp.** The region default appears to be 20.0 s (bit
   pattern at 301477-301478) and `m_override_transition += 0.04` advances only inside the light-tick
   branch (307286) ⇒ a 25-tick ramp would take ~500 s. Either the shipped region DAT carries a much
   smaller `light_tick_size`, or the ramp really is that slow. Needs a WB.Terminal dump of region
   0x13000000's `sky_info.light_tick_size` before RND-12 picks a rate.

5. **`ImageScaleType` vs `ImageShift`.** The enum names (FULL/HALF/QUARTER/EIGHTH,
   acclient.h:4419-4427) do not match `ImageShift[5] = {0,1,2,4,8}` (40343): index 3 shifts 4 bits
   and index 4 shifts 8. Preset "low" sets `LandscapeTextureDetail = 4` ⇒ `>> 8` = /256, clamped to
   `min_tex_size = 8`. Is index 4 a fifth, unnamed level, or is the shift table itself the
   authority? Affects RND-14's mapping.

6. **Is the retail weather EnvCell worth rendering?** RND-18 assumes the `after_sky_cell` carries
   real, useful geometry. Nobody has dumped it. A WB.Terminal `chorizite-parse-dat-record` on the
   region's weather cell would settle whether this is a fidelity win or an empty box.

7. **Ambient bed: Rust or JS?** AUD-02/AUD-05 argue for Rust (per-cell world-position geometry over
   the loaded set = system state). But the ambient runtime is currently pure JS with a clean test
   surface and a baked-events feed. Is the right move a Rust weight pass exported per tick, or
   extending the **baker** to emit per-cell positions + weights so the runtime stays a scheduler?
   The baker already resolves per-vertex `scene_type` correctly, which favours the baker.

8. **Continuous-ambient re-fire seam.** Retail's `min_rate` re-fire worked because the wave length
   ≈ `min_rate`. In the browser, re-triggering a drone every `min_rate` may click audibly where a
   looped source does not. Does AUD-03 need a short cross-fade (a divergence) to be shippable, and
   if so does that undermine the "re-derived volume" benefit?

9. **Voice pool interaction with looped ambients.** Retail's 16-slot pool includes ambient voices,
   and its continuous ambients are one-shots (AUD-03), so a drone never permanently occupies a slot.
   If holtburger keeps looped continuous sources (rejecting AUD-03) while adding AUD-01's pool, a
   handful of loops could starve the pool. AUD-01 and AUD-03 may have to land together.

10. **Static-light bake vs dynamic-light identity.** RND-04 needs the static/dynamic split retail
    gets from `CObjCell::add_static_to_global_lights` vs `add_dynamic_to_global_lights`
    (346859/346881). Does holtburger's cell/light ingest preserve that distinction today, or is
    every cell light treated uniformly? If the latter, RND-04 needs a classification pass first.

11. **Sky far-plane strategy.** RND-16 can be a second camera, a depth-range trick, or an expanded
    single far plane. Which interacts best with `logarithmicDepthBuffer` (already in use per
    `terrain.js:690`) and with the atmosphere post-pass's depth reads?

12. **No audio output on the only real GPU.** MEMORY §fleet records that no sound can reach the
    1070's user. Every audio task's *audible* validation therefore has to run on the laptop
    (SwiftShader, `?nullRender=1` for the sim) or via an offline render
    (`OfflineAudioContext` + buffer analysis). Is an `OfflineAudioContext` harness worth building as
    the standing audio-regression gate? It would make AUD-03/AUD-04/AUD-10 mechanically verifiable
    instead of ear-gated.
