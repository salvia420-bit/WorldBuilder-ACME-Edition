# Improvement hunt from the current position (2026-10-20)

Owner prompt (verbatim):

> we have already done comparisons of webac, openac and the decomp with holtburger-web so examine what was done in depth, never retrace old ground. from this position find remaining improvements to holtburger-web, ideally improving fps while not harming holtburger-webs superior graphics. find improvements in other areas as well

**This was a read-only session.** No code changed, and nothing ran in a browser, on the 1070, or through a build or the JS gate (laptop rules). The evidence is source reading at HEAD `ee1456a2`, three r184 / pmndrs / takram / ANGLE sources, the retail decomp, the measurement files already on disk, and a few light node probes written by the agents (fake-GL repros, micro-benches, a GLSL dump). Every gain below is **derived or assumed, not measured**. Each one names the 1070 arm that would prove it.

- Evidence (every finding with citations, the verifier's reasoning and the second refuter's): `docs/improvement-hunt-2026-10-20/findings-round1.json`, `findings-round2.json`
- The covered-ground ledger this hunt was checked against (reusable by later sessions): `docs/improvement-hunt-2026-10-20/prior-ground-ledger.json`, plus flat text copies: `ledger-covered.txt` (963 items), `ledger-open-leads.txt` (462 open leads), `ledger-walls.txt` (209 settled walls)

## 1. How it was run

1. **Ledger of prior ground (7 readers).** Seven agents read the earlier work end to end:
   - the OpenAC rounds (10-04, 10-08 rounds 1-5);
   - the WebAC comparison (151 findings, review, eye tests) and the missile-anim comparison;
   - the 10-18 systematic review, the 10-07 and 08-03 reviews;
   - the October perf work (10-06 / 10-11 1070 logs, the 10-17 fps waves, the 10-19 fps review);
   - the summer perf research (07-02 synthesis, 08-05/06/08 series);
   - the 12-pass re-engineering spec and its lanes;
   - the recent feature handoffs and PARITY-STATUS.

   They produced 963 covered items, 462 open leads and 209 settled walls (refuted theories, measured dead ends, measurement traps).
2. **Round 1 (15 finders).** The angles were GPU shading, main-thread JS, GL-driver load (CrGpuMain), streaming hitches, the wasm boundary, entities and FX, net/session, HUD and audio, boot and caching, and memory. They also covered the three unreviewed diffs since the 10-18 review (render, logic, RynthSuite) and decomp gaps neither comparison touched, plus visuals. Each finder had to rg the ledger, git log and url-flags for every candidate, and report only "new" items or a decisive "advance" on an open lead.
3. **Round 2 (7 finders).** These went after angles round 1 had not reached: terrain GPU, building fill, sun-shadow restoration, frame pacing, flag debt, and a triage of the open leads into what can be done now.
4. **Verification.** One adversarial verifier per finder batch re-opened every file:line, checked novelty against the ledger, checked the walls, judged look safety and re-estimated the gain. Every surviving high-impact finding then went to an independent second refuter.
   - Round 1: 79 findings. 40 confirmed, 37 partial, 1 refuted, 1 duplicate. The second refuter cut one more from high to low (§6).
   - Round 2: 38 findings. 21 confirmed, 16 partial, 1 duplicate.
   - The orchestrator re-read the headline items itself: the serve.py cache tuple, the rp6CullSphere branch order, the IBL environment swap, the Playwright focus emulation and the baked-light direct-light multiply.

Every number below is the **verifier's corrected figure**, not the finder's.

## 2. Headline

**No single change doubles fps.** The 10-19 picture still holds: in towns at ultra, the renderer main thread, Chrome's GPU-process thread and the GPU fill are all near saturation. What this hunt found is a set of independent wins on each of those three, a frame cap that silently holds most of the game at 60 fps, a coherent route to bringing sun shadows back, and a long tail of bugs, hitches and memory waste.

The five that matter most:

1. **Every player is capped at 60 fps (30 when the window is unfocused), and so would every 1070 bench be.** The VTank display options (a58df981) run on every page with their defaults ON, so the 120 Hz panel can never show more than 60 outside saturated towns. That page-wide default was an explicit owner decision (STATUS.md), probably taken with the bot in mind. The bench part is a plain bug: `scene3d/frame_cap.js` assumes an off-screen bench window is never focused, but Playwright's connectOverCDP turns on focus emulation for every page (`playwright-core crPage.js:418`, verified). So every owed 1070 A/B would be capped at 60 (about 73 in `--uncapped` mode). → §3 A1
2. **The GPU light loops run work that provably contributes nothing.**
   - Baked EnvCell surfaces compute the whole direct-light pipeline and then multiply it by a zero uniform (`materials.js` `acKeepDirect`, verified). Compiling it out is exact.
   - Every lit pixel evaluates all 16 pool point lights, out-of-range ones included, plus permanently zero-intensity suns and SH probes.

   Together: ~0.4-1.6 ms GPU in towns, ~0.6-2.5 ms indoors, all pixel-identical. → A5, A6
3. **Linvak-class towns: the shipped frozen-anchor fix (bf474c67) cannot fire for 90% of its population.** The part-frames branch runs first, so the drizzle anchors pay three parent-chain walks on every recheck, a 2.5-7 ms spike every 6th frame. Separately, each landblock park/evict removes ~14k anchors one `splice` at a time, 20-35 ms per row crossing. → A2, A3
4. **Sun shadows can come back at a reasonable cost, but not as the code stands.**
   - The CSM receiver patch samples shadows at the wrong place for every BatchedMesh and InstancedMesh receiver, which is most of the world.
   - The static cache never engages while the camera moves.
   - Three dead cascade lights run in every lit program.

   Fix those first, then re-measure. → §3 C
5. **Memory and load.**
   - Atlas NRA arrays hold 4×-upscaled nearest-neighbour copies of DAT-size planes (~125-137 MB heap, ~170-180 MB VRAM at Nanto).
   - HD texture records stay twice in memory, in wasm and in JS (~110-200 MB).
   - The 78 MB terrain BC7 tier is served `no-store`, so the owner's `?nosw=1` play route re-downloads it every boot. → A9, E1, E2

## 3. Ranked actions

Effort: S = hours, M = a day or two, L = more. "Look" says whether pixels change: **same** = pixel- or bit-identical; **better** = a visual fix; **eye** = ships default-off until a 1070 eye check.

### A. Do first: code-only, safe, high value

| # | Finding | Gain (verified estimate) | Look | Effort | Where |
|---|---|---|---|---|---|
| A1 | **Frame cap.** (i) The bench trap: add `&targetFps=0` (the explicit uncapped pin) to `flag-bench.mjs`, `hbprobe.mjs` and the coldboot URLs before ANY 1070 fps session, and fix the frame_cap.js:8-14 comment and the url-flags targetFps row. (ii) Owner call: should the 60/30 cap and the red steep-ground tint apply to players who never run the bot? Recommended: only when the bot runs or the profile stores an explicit value, plus a `?frameCap=off` escape. (iii) The soft pacer misses its target off 60/120/240 Hz: a 60 cap gives 37.5 fps at 75 Hz, 50 at 100 Hz, 72 at 144 Hz. A timeline gate fixes it. | (i) every owed A/B valid; (ii) up to 120 fps instead of 60 wherever frames are under 8.3-16.7 ms (wilderness, dungeons, interiors); DevTools-focused recordings stop dropping to 30; (iii) correct cap on odd refresh rates | same (the tint removal in ii changes pixels: owner call) | S | `scene3d/frame_cap.js:8-14, 46-54, 90-131`; `plugins/rynth-vt/display.js:48-51, 132-137`; `rynth/vt/settings/schema.js:237-249`; `index.js:506-523` (recent-rynth-diff-1, -3) |
| A2 | **Frozen-part shortcut.** In `createPartFramesProxy`, read `part.matrixWorld` directly when the part is frozen, which is bit-identical. Then memoise frozen cull centres per emitter, resolve the parent-local anchor once per tick instead of once per particle, and optionally stagger the RP6 recheck by emitter id. | Linvak Tukal: removes a ~2.5-7 ms spike every 6th frame (~0.4-1.3 ms/frame average) plus ~0.2 ms/frame of drizzle spawn resolves. FX-dense scenes: 0.1-1 ms. Elsewhere small. | same | S | `setup_rig.js:188-216`; `particles/particle_manager.js:1561-1573, 2546, 2584-2588`; `particles/particle_emitter.js:505-528` (entities-fx-2, -1) |
| A3 | **Bulk child removal on LB park/evict.** One `filter` pass instead of `indexOf`+`splice` per child (~14k frozen anchors are direct staticsGroup children at Linvak). Step 2: move the anchors into an identity sibling group. | 20-35 ms less hitch per row crossing at Linvak on the 1070 (5-10× faster removal); step 2 saves 0.1-0.4 ms per moving frame there | same | S / M | `landblock_lru.js:1787-1800, 2226-2234`; `statics.js:6105, 6292` (open-frontier-perf-2) |
| A4 | **Stable IBL environment identity.** Keep one persistent PMREM target. r184's `fromScene` cannot reuse a target, so copy into it, or render the cube and use `fromCubemap(tex, rt)`, which takes a target. | Removes a ~10 ms hitch every 15 s: getParameters plus the cache key for ~600 materials on every refresh | same | S | `ibl_environment.js:492-502`; three `WebGLRenderer.js:2440` (main-thread-1) |
| A5 | **Compile out direct light on baked EnvCell surfaces.** Add `#undef RE_Direct` when suppressDirect is set, plus a defensive key bit; do the same in `pool_material.js`. | ~55-65% fewer fragment ops on those surfaces: 0.1-0.3 ms GPU outdoors (rooms through apertures), 0.3-1.2 ms indoors; faster interior program compiles | same | S | `materials.js:885-1004`; `pool_material.js:380` (building-fill-2) |
| A6 | **Light-loop early-outs.** An exact squared-range test before `getPointLightInfo` / `getSpotLightInfo`; skip directional `RE_Direct` and SH when the colour is zero (the parked legacy sun, both suns indoors, the zeroed SkyLightProbe while IBL owns diffuse). | 0.2-0.8 ms + 0.1-0.5 ms GPU in towns at ultra. Caveat: FXC must keep a real branch, so dump the translated shader on the 1070 first. | same | S | `light_loops.js:43-79`; `index.js:6430`; `lighting.js:1588-1603` (building-fill-1, -3) |
| A7 | **Fuse two post passes.** Fold the layered haze and the first NaN scrub into the atmosphere EffectPass on the split chain (high/ultra). | Two fewer full-screen RGBA16F passes: ~0.4-0.5 ms GPU at 1440p (~0.25 at 1080p); output within one fp16 ulp | same | M | `atmosphere_pipeline.js:1865-1927`; `layered_haze.js:144-165` (gpu-shading-5) |
| A8 | **No version bump on HD texture swaps.** Set `needsUpdate` only when map presence or the uv channel changes. Today asyncLink skips every affected draw (whole batched variants included) for 1-2 frames on each pre/full swap. | Hundreds of one-frame dropouts in the first minute after arrival disappear | better | S | `bc7_textures.js:2093-2104`; `materials.js:6361-6382` (streaming-hitch-4) |
| A9 | **`.hbc7` served `no-store`.** Add it to serve.py's revalidating tuple; make the SW refresh conditional (skip `put` on 304). | Owner's `?nosw=1` play route stops re-downloading ~78 MB of t1024 every boot. SW origins stop a ~80 MB background re-transfer and Cache Storage rewrite every warm boot. The first context loss after promotion stops re-fetching 78 MB with the frame pump parked (terrain renders black if that misses the 15 s deadline). | same | S | `scripts/serve.py:870-887`; `service-worker.js:483-492`; `terrain_bc7.js:706, 832, 1369` (boot-cache-1) |
| A10 | **Warm the late-scene FX programs.** Particles, glow, ribbons and kids draw in light-less private scenes, so no existing warm produces their program keys, and each class links synchronously on first sight. Warm them once in the tunnel against lateScene/glowScene. | Removes first-sight FX link hitches (the 10-11 bench: FX roughly doubled first-turn hitching); about 4-12 programs | same | M | `atmosphere_pipeline.js:612, 712-713`; `particles_over_clouds.js` (streaming-hitch-1) |
| A11 | **Inventory signal only for owned or viewed objects.** kind 11 is raised for every create, delete, parent and property change in view; gate it with a native-testable ownership predicate. | 0.5-2 ms main thread on affected frames (arrival bursts, combat); also re-enables the 10-07 wield-event filter it defeats | same | S | `src/session/messages/mod.rs:717-850, 1309-1321` (net-session-1) |
| A12 | **One persistent paperdoll viewport.** Today each inventory open and each creature examine creates and force-loses a WebGL2 context. Also filter examine's appearance refresh by guid. | 10-60 ms hitch per inventory open (assumed); fewer context creations, which matters on a GPU that loses contexts | same | M | `ui/ac_paperdoll_viewport.js:73-82, 577-590`; `inventory.js:834, 1937`; `examine-target.js:753, 1538-1550` (hud-audio-2) |
| A13 | **Fade funnel.** Faded DoubleSide entity parts draw twice per frame, each pass with a program re-resolve. First-person parts at opacity 0 are still drawn (retail skips them). A restored part keeps the faded program (missing DOUBLE_SIDED / OPAQUE: a live visual bug). | 1.5-3.5 ms main thread in first person (~+5-15% fps there); ~66 µs per faded mesh elsewhere; fixes the stale-program look | (a) eye, (b)(c) same/better | S | `fade_alpha_state.js:94-112`; `materials.js:2073-2080` (open-frontier-perf-1) |
| A14 | **Particle buffer upload ranges.** Upload only `[0, n)` of instanceMatrix/instanceColor; skip the upload when a bucket parks. | 0.05-0.3 ms CrGpuMain plus a matching renderer memcpy in particle-dense towns | same | S | `particles/particle_manager.js:726-743, 3111-3131` (main-thread-3, gl-driver-4, entities-fx-4) |

### B. GPU / CrGpuMain wins that need a 1070 number or an eye check

| # | Finding | Gain | Look | Effort |
|---|---|---|---|---|
| B1 | Cloud shadow march every 2nd frame, through instance wrappers with no vendor edit (`?cloudShadowEvery`) (gpu-shading-4) | 0.3-0.6 ms GPU at high/ultra outdoors | eye (same class as the reverted 928841d5) | S |
| B2 | Legacy POM loops: ANGLE/D3D11 flattens the distance gates and samples mip 0 because the loop samples use implicit gradients; switch to `textureGrad` as statPom does (`?pomGrad`) (gpu-shading-1) | 0.05-0.3 ms; removes a D3D-only shimmer at 5-10 m | eye | S |
| B3 | terrainLast is switched off by any kept doorway/window aperture. Step 1: `?terrainLast=force` plus a `__terrainLast.stats()` suppression counter; step 2: a per-building classifier (recent-render-diff-1) | 0-2.5 ms GPU on frames with apertures × an unknown share of frames | eye | S then M |
| B4 | Skip the sky pass's unused MSAA depth resolve (gl-driver-3) | 0.05-0.15 ms | same | S |
| B5 | Terrain: front-to-back landblock sort plus far patches after the near ring; dedupe repeated BC7 taps; RG8 detail-normal array (terrain-gpu-1/2/3) | ~0.02-0.25 ms each; RG8 saves ~13 MB VRAM | same | S |
| B6 | Sky-glow sheets: move the far depth to the vertex stage so early-Z works (gpu-shading-3) | 0-0.15 ms | same | S |
| B7 | Interior cells as an opaque sub-phase after shells (building-fill-4) | 0-0.4 ms; mainly deterministic draw order for A/B hygiene | same | S |
| B8 | Occlusion proxies: re-query stably visible ones every K frames (only while occludedRun==0); group them as one mesh (main-thread-4, gl-driver-5) | 0.1-0.4 ms parked; needs a moving bench | same | S/M |
| B9 | buildingMatBatch opted into batchedRuns, plus an order-keeping run builder for sorted buckets (gl-driver-1, recent-render-diff-4) | tens of ANGLE ranges; measure with `__batchedRuns.frame()` first | same | S |
| B10 | Terrain batch without gl_DrawID (LB origin packed into aLbSlot) (gl-driver-2) | 0.05-0.2 ms CrGpuMain | same | M |
| B11 | Quaternion writes skip three's Euler sync on rig parts and particle carriers; corpses posed once (entities-fx-6) | 0.15-0.5 ms main thread in crowds | same | S |
| B12 | Particle bucket key/signature memo + skip the unchanged second sort (main-thread-2; the scale was cut by the second refuter, §6) | 0.06-0.25 ms at Linvak | same | S |
| B13 | Step far emitters (40 m to degrade distance) at retail's 30 Hz (decomp-gaps-2) | 0.1-0.2 ms | eye | S |
| B14 | Define-gate the terrain family blocks that are OFF on every tier (gpu-shading-6) | 0-0.1 ms; check fxc dcl_temps first | same | S |
| B15 | Vitals orbs: if arm 4 shows they dominate the DOM raster, first try baked pre-blurred sprites, then an OffscreenCanvas port (hud-audio-4) | unknown, ≤1-2.5 ms CrGpuMain | eye | M/L |

### C. Bringing sun shadows back (a graphics upgrade, in this order)

CSM has been off in every preset since 10-17, on a measurement taken before shadowStaticCache and shadowMoverScope existed. Re-enabling it today would hit these:

1. **C1, receiver position is wrong for batched/instanced meshes.** The CSM receiver patch computes `vCsmWorldPos` without `batchingMatrix` / `instanceMatrix`, so static_batch_x buckets and ring-baker instanced statics sample cascades near the world origin and are never shadowed. Mirror `worldpos_vertex`. S, prerequisite, survived the second refuter. `materials.js:1461-1462` (shadows-restore-2)
2. **C2, patches lost on clones.** Re-install CSM (and the light clamp) on the floorBias / staticBias / cellBaked clones and in getCachedVariant (swaying trees); ledger open lead #11, still true. Give each sway caster its own depth material: today trunk and leaf alternate one shared customDepthMaterial, which bumps its version and **alpha-tests a leaf with the previous caster's map** (a three r184 probe confirms it). (gpu-shading-2, open-frontier-perf-6)
3. **C3, the static cache never engages while moving.** Any 1 cm or 1e-3 rad camera change refits all three cascades and marks them FRUSTUM, so shadowStaticCache passes through. Cheap and exact: raster FRUSTUM maps as REFRESH. Bigger (eye): camera-centred, texel-snapped cascades with per-cascade slack and staggered sun refits, so moving frames run as overlays. Outdoors, roughly 12 ms → 2-5 ms residual; towns unknown until static vs rig draws are counted. `csm.js:121-140, 500-548`; `lighting.js:1730` (shadows-restore-1)
4. **C4, dead cascade lights.** The three intensity-0 cascade lights put three dead `RE_Direct` + clamp blocks in every lit program, and up to 15 dead PCF taps on receivers. Start the directional loop at NUM_DIR_LIGHT_SHADOWS on the CSM path. 0.3-1.5 ms GPU with CSM on. (shadows-restore-3)
5. **C5, night shadows.** The 0.9° night sun casts ~200 m streak shadows at full strength all night, and the flat ×0.45 multiply also darkens emissive, IBL and fog. Scale by cloud_night's directFactor and skip rasters at strength 0 (~20% of the AC day). Eye. (shadows-restore-5)
6. **C6, smaller items.**
   - Sort shadow casters by depth-program kind: 0.3-2 ms per full raster (shadows-restore-6).
   - Use `textureLod` on the CSM taps, a hardening (shadows-restore-4).
   - Per-cascade depth range and texel-scaled bias: 0.3-0.5 m light leak at contacts today (shadows-restore-7).
   - Off-screen rig casters at low sun (shadows-restore-8).
   - For `?shadows=on` only: three r184's 2D PCF chunk adds shadowBias with the wrong sign under reversed-Z (recent-render-diff-2).

Then re-measure `?csm=on` on the 1070 against the 10-17 baseline.

### D. Visual bugs and upgrades

| # | Finding | Look | Effort |
|---|---|---|---|
| D1 | Speech bubbles are drawn in the world pass, so clouds/AP, haze, SSAO and decals shade them by the depth behind them, and bursts paint over them. Draw them in the late FX pass and mipmap their text. (visuals-4) | better | S |
| D2 | Instanced synthesized billboard sprites (gemSparkle, brazier embers and smoke, breath fog) face a fixed direction and go edge-on from some azimuths: mixed-space camera vector. (entities-fx-5) | better (eye) | S |
| D3 | Hotbar cooldown: an invented dark wipe that jumps in 4 steps; retail's 10 clock+bar sprites (0x060067CF…D8) are exported and the phase is already computed. HUD rule: apply direct. (hud-audio-1) | better | S |
| D4 | Sky storm-window particle chains (lightning box via CallPES) are never detached; they keep running after the window, a DayGroup change or weather-off. (ofo-1) | better | S |
| D5 | Adaptive resolution: (FP-1) a raise that held 97 s is latched as failed, and every post-boot teleport reads as GPU-bound (the owner's "soft for 5 minutes"). (FP-2) The 3D canvas inherits the old 2D rule `image-rendering: pixelated` plus a 1 px grey border, so any scale below 1 is nearest-neighbour upscaled. (FP-3) Non-agent fullscreen renders a 1888×760 buffer stretched ~40% vertically. (FP-5) The initial scale at native 1440p starts at 0.84. | better | S each |
| D6 | ClipMap cutouts: black clip texels give dark rims and darken at distance on the opaque path. Runtime RGB dilation for the RGBA8 path; the HD lanes need a re-encode. (visuals-1) | better (eye) | S/M |
| D7 | Atlas NRA at native size (also E2): near-field normals and statPom relief go from 4×4 nearest blocks to bilinear, matching singletons. (memory-1) | eye | M |
| D8 | lumNight freezes on all four cache-level variants, possibly including swaying foliage; one adoptLuminousClone each. (open-frontier-perf-5) | better | S |
| D9 | Cell-baked / static-bias / floor-bias clones lose the POM patch and the default-on light clamp while their program keys claim both. The light-clamp loss is the bigger divergence. (gpu-shading-2) | eye | S |
| D10 | Mips for atlas BC7 statics: the only blocker is r184 clearing layerUpdates after mip 0; a per-texture override fixes it exactly. (open-frontier-perf-4) | eye | S |
| D11 | Smaller items: alpha particle buckets sorted by a stale centre (recent-render-diff-3); direct-to-canvas frames lose depth precision under reversed-Z (recent-render-diff-5); alpha-to-coverage for ClipMap on the MSAA target (visuals-2, needs a final-pass alpha=1); Toksvig specular AA (visuals-5); SRGB8 far-ring albedo (visuals-6); FX cue range gates and instant FX-light registration (entities-fx-7/-8, decomp-gaps-5); one-frame-late cell culls on fast turns (FP-4). | mixed | S |

### E. Memory and load

| # | Finding | Gain | Effort |
|---|---|---|---|
| E1 | HD texture records (tex-bc7 / -pre / xu7) stay in the never-evicting wasm ShardCache while JS keeps its own budgeted copy. Take on read, or keep a small per-namespace LRU. (memory-2) | 110-200 MB lower main-wasm linear-memory high-water | S (Rust) |
| E2 | Atlas NRA arrays sized from the 4× BC7 diffuse but filled with DAT-size planes. (memory-1, see D7) | ~125-137 MB heap, ~170-180 MB VRAM at Nanto (scaled from the 08-05 census, re-measure owed); 16× less NRA pack/upload/mip work | M |
| E3 | Far-ring patch render targets keep unused 512² depth buffers; bake arrays kept after baking. (memory-3) | 25-49 MiB VRAM, 2-4 MB heap | S |
| E4 | The shell bundle rebuilds only on request, so the first visitor (and the first cold-boot A/B arm) after an edit gets the 384-module page. (boot-cache-4) | removes an A/B asymmetry; seconds on remote links | S |
| E5 | Load-time tail: .json/.jsonl served no-store (boot-cache-2); importmap deps not preloaded (-3); 51 manifest fetches before the wasm compile (-5); the advisory sidecar on the high-priority lane (-6); SW static routing (-7); release wasm LTO + `-O3` (wasm-boundary-1); SIMD, only with jpeg-decoder `platform_independent` or JPEG output changes (-2); table CRC32 (-3); boot-index and Region memo (-4); one copy fewer per pixel getter (-5); FxHash in physics maps (-6); prewarm light stand-in and dedupe (streaming-hitch-2); two texture-worker jobs in flight (-3); RGBA normals from Rust (-5); Uint32Array.fill for NRA (open-frontier-perf-3); 19 default-off modules loaded at boot (flagdebt-4). | each small; ms to tens of ms, or seconds only on slow links | S/M |
| E6 | A stale parked pool copy leaks its building BatchedMeshes (rare; the counter should stay 0). (memory-5) | hygiene | S |

### F. Correctness, robustness and other areas

| # | Finding | Effort |
|---|---|---|
| F1 | **Windows right-click.** contextmenu fires after mouseup at the release target and is not consumed for canvas presses. Camera turns released over the HUD clear spell-bar slots or the map waypoint, or pop item menus. A short right-click on a 3D entity opens the radial menu and closes it in the same gesture. Fix: a window-capture listener. Survived the second refuter; one on-screen Windows check owed. (ofo-2) | S |
| F2 | RynthSuite: an Items-tab item that leaves the pack wedges the bot on Buffing, recasting at the dead guid about once a second (0x042c is classed transient). (recent-rynth-diff-4) | S |
| F3 | Outdoor collider populates keep staging after their landblock is evicted, so orphan colliders appear and remoteSettle can open on incomplete floors. They need a LandblockBuildEpoch. (recent-logic-diff-1) | S (Rust) |
| F4 | The particle-chain walker has no liveness check after its awaits, so a same-guid respawn doubles the script. (recent-logic-diff-2) | S |
| F5 | fps-dependent retail timing: the InterpolationManager 5-tick window is counted per render frame, so stalled remotes blip ~4× sooner at 120 fps (decomp-gaps-3); particle emission rate follows render fps (decomp-gaps-1). | S |
| F6 | Small fixes: the velScale gait EMA uses x/z in the AC frame, where z is up (entities-fx-9); the corpse handoff's 8 m live-ragdoll match is dead code (ofo-3); the vivid-targeting off-screen arrow points 180° wrong (ofo-4); combat lines lack retail's 0x16 / 0x15 colours (ofo-5); a background cap below 10 fps slows the simulation (recent-rynth-diff-2). | S |
| F7 | Event-rate trims: vital-current updates raise the broad kind 8 refresh (net-session-3); netWorker batching for bots (net-session-4); chat mirror forces a layout per line (hud-audio-3); forced layouts in the rAF tick (main-thread-5). | S/M |
| F8 | Flag debt: retire the 29 JS flags made always-on on 06-17 and signed off 07-11 (flagdebt-1; castFaceTarget is default OFF, do not inline it); the polarity audit and lint miss ~140 live flags (flagdebt-2); docs/quality-presets.md contradicts quality.js on the default ultra tier (flagdebt-3). | M / S |
| F9 | The 256-512 glBlitFramebuffer warnings are best explained by the legacy multisampled ping-pong composer, which has had no producer on the default path since 10-17. One bare 1070 boot closes the lead. (gl-driver-6) | — |
| F10 | Ledger hygiene: 7 open non-perf leads are already fixed or moot at HEAD (62, 134, 124, 182, 27, 442; 61 → NIT). (ofo-6) | — |

## 4. Owed on the 1070 (one session, MODE T, fresh profile per arm)

**First, add `&targetFps=0` to every bench URL (A1-i), or all arms are capped at 60.** Then:

1. The nine fps-review arms already owed (docs/2026-10-19-fps-review.md).
2. A WEBGL_debug_shaders / translated-HLSL dump of one lit MeshStandard program, one legacy-POM program and one CSM receiver. Grep for FLATTEN and `lod0` and check that the light-loop branches stay real. This decides A6, B2 and C6 before any A/B.
3. New arms for this hunt:
   - `lightRangeSkip` on/off (A6), indoors and in town;
   - the baked-cell compile-out (A5), indoors;
   - `postFuse` (A7);
   - `cloudShadowEvery=2` (B1);
   - `pomGrad` (B2);
   - `terrainLast=force` plus `__terrainLast.stats()` (B3);
   - the Linvak Tukal recheck spike before and after A2;
   - the row-crossing hitch before and after A3;
   - first-person fps before and after A13.
4. The `?csm=on` re-measure after C1-C4.

Eye checks owed by the "eye" rows above: B1, B2, B3, D2, D6, D7, D9, D10, A13(a), C3 (stable cascades) and C5.

## 5. Owner calls

1. **Frame cap and steep tint for non-bot players** (A1-ii). Today every player is held at 60 fps (30 unfocused) on a 120 Hz panel.
2. **Shadows** (§3 C): go ahead with the C1-C4 prerequisites and the re-measure?
3. **Cloud shadow cadence** (B1): a look trade of the same class as the reverted cloud frame-skip.
4. **NRA native size** (D7/E2): near-field relief becomes bilinear (singleton parity) and may read softer than today's nearest-neighbour grooves.

## 6. Refuted, downgraded and negative results (do not retrace)

- **Particle bucket key/signature strings "up to 3.3 ms" (entities-fx-3).** The second refuter cut it to 0.06-0.25 ms. The drizzle's 64 m degrade distance (`?particleDegrade`, default on) culls all but ~70-270 emitters before the append; the "76% live" figure applies within that radius, not to all ~5,000.
- **ObjectCreate table resolve "stamps 0 for good" (net-session-2): refuted.** Retail `set_description` clears both tables when the wire omits them (acclient.c:322302-322331). The faithful fix is the opposite, wire-only tables, and is an owner decision.
- **Unanchored instanced-statics THREE.LOD (open lead).** It is not on the default path (only under the declined `?walkInInstance`). Close it as a duplicate of open lead 396; only the url-flags row needs correcting.
- **The liveness-sweep bridge prune (memory-4)** duplicates a 10-07 review item.
- **No per-frame URL parsing survives** (flagdebt-5): 352 raw readers remain, all on creation or event paths, microseconds in total.
- **Terrain:**
  - Ring overlap is small: far patches discard inside the near ring, and visual_ground draws nothing.
  - Terrain cost is near-field. Only 5-8% of ground rows lie past 75 m, so baked splat textures at distance cannot buy much.
  - Triplanar is dead in default sessions.
  - Terrain has ~40-60k triangles, which is not a lever.
- **mediump vs highp:** ANGLE D3D11 compiles everything as fp32, so there is no gain on the 1070.
- **takram clouds:** temporal upscale is already on; the remaining knobs are quality trades.
- **The water cube composite** (open lead) is 128²×6 at 1 Hz, which is small.
- **The SSAO / fx_distort loops** read mip-less depth, so ANGLE gradient flattening does not apply. The cloud march self-terminates under FLATTEN.
