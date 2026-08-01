# PERF SYNTHESIS — where the fps actually goes (2026-08-01)

Three parallel deep-analyses (default-ON inventory · perf-history/log ledger ·
pipeline big-win hunt), cross-verified. This doc is the decision layer; the
full evidence chains live in the three agent reports (session artifacts) and
the files cited inline. House rule applied: every headline claim below was
re-verified in code or in a named measurement artifact — doc claims that
failed verification are called out as such.

## 0. The frame, as measured (all [1070] real-GPU)

- **Standing still is solved.** walk vs stand (07-15, Holtburg): both 59.9 fps
  median — but the walk carries 10–16 long tasks totalling 3.4–6.3 s per 30 s
  (worst single task 1.1–1.5 s), the stand carries ZERO. Score walking on
  longTasks/p99/worst, never median fps (`scripts/net-review/walk.mjs:15`).
- **The GPU is idle.** shadows-off halves GPU, fps unchanged; renderCPU ≈ 24 ms
  of a 33 ms frame; per-instance frustum culling saves 2.9 % of triangles for
  5,791 draws of CPU work. The client is CPU-bound in three.js submission.
- **The 1070 boots `mid`**, not high — `GPU_HIGH_RE` (quality.js:645) matches
  only RTX 20/30/40-class + Apple. No CSM, no shadow maps at defaults. Also:
  the 1024 atlas gate reads the RAW ?quality param, so probe-resolved tiers
  keep 512 (index.js:1154).

## 1. THE BIG WIN (walking lag): synchronous shader-program links — an
##    unread 2026-07-16 measurement nobody acted on

`/mnt/wbterminal2/tmp/walk-stall-attrib.json` (post-all-July-fixes, [1070]):
in-stall self-time is **`getProgramParameter` 32.9 %** — 59.5 % of the worst
1,493 ms stall. **43 new shader programs link during ONE Holtburg walk**
against a total live set of only ~78–90; isolated frames price a link at
**172–849 ms each** (D3D11 deferred HLSL link; `KHR_parallel_shader_compile`
present but links still block). This CONTRADICTS `RESULTS-task12` ("stalls are
uploads, shaders a trickle") — task12 counted program *count*, the profile
measured *cost*, and the profile is later. The decision NOT to build a shader
prewarm rests on the refuted half.

**The bet: warm the full ~90-program set at the loading screen** (players read
the login form for ~10 s anyway) — and warm it against the COMPOSER's
HalfFloat target, not the canvas sRGB one (the 06-27 finding: boot
`renderer.compile` at index.js:4777 warms the wrong variant, which is also why
cold-load still freezes ~22 s). Expected effect: the 1.1–1.5 s walk hitches
largely vanish; this is the user-felt "laggy when running around".
Validation: re-run `walk-stall-attrib.mjs` on today's default, then with the
prewarm; `getProgramParameter` in-stall share and longTask totals are the
score. Instrument to separate three's cheap `COMPLETION_STATUS_KHR` poll from
the forced first-use link.

**BUILT 2026-08-01 (`?shaderPrewarm=on`, ship-OFF pending this A/B).** Root
cause turned out sharper than "prewarm the set": three keys program variants
on the render target BOUND AT COMPILE TIME (r184 getParameters :7493/:7584 —
null → tone-mapped sRGB canvas; non-null → the composer variant), and EVERY
warm site (boot pass 1/2, guardedCompileAsync → world bakes/envcells/entity/
archetype warms) compiled against the canvas — warming programs the composer
path never uses. The 43 mid-walk links are those same materials linking their
REAL variant on first draw. `shaderPrewarm=on` binds a shared 1×1 HalfFloat
dummy target around every compile (equivalent for the program key; order-
independent of composer construction) so warmed == live; the ~22 s cold-load
freeze should collapse for the same reason. A separate login-screen synthetic
catalog was deliberately NOT built: programs also key on the LIGHT RIG, which
attaches long after the login form (the archetype warm's 4 s delay exists for
exactly this), so a login-idle catalog would warm zero-light variants.
Scoring: `?linkProbe=on` (both arms) wraps gl.linkProgram/getProgramParameter
— `window.__linkProbe.summary()` splits forced LINK_STATUS waits (the hitch)
from cheap COMPLETION_STATUS_KHR polls. 32-check node harness:
`test_shader_prewarm.mjs`. Flags doc'd in url-flags.md §4.

## 2. LANDED TODAY: statics-atlas whole-array re-upload (walk-stall #2)

`static_atlas.js` fed the DataArrayTexture pair with `needsUpdate = true` and
an EMPTY `layerUpdates` → three re-uploaded the whole pre-allocated array
(16–32 MiB) on EVERY per-LB feed and every 10 Hz nra repack, for a live
occupancy of 28–59 layers. terrain_batch/bc7_textures already did it right.
Fixed with per-layer `addLayerUpdate` at all three raw write sites
(commit on master 2026-08-01). Matches task12's 7.8 s of measured
texture-upload stalls. Validate live via `window.__atlasStats()` + the walk
probe's upload bucket.

## 3. THE STEADY-STATE BET (needs a 1070 ceiling probe BEFORE building):
##    collapse statics submission

Pinned-pose ablation (`draw-budget-cpu.json`): hiding statics = **16.6 ms of a
24.6 ms renderCPU (59 %) → 28 → 55 fps**. 511 BatchedMesh emit **~5,791
multiDraw ranges/frame** (`info.render.calls` is blind to this by 3.94×) with
per-instance CPU culling worth 2.9 % of tris; geometry is 54.9× duplicated
because `static_batch_x.js:234` dedups on OBJECT IDENTITY, not content; the
14-InstancedMesh control (2,992 instances) costs −0.28 ms in the same frame.
BUT: the one prior attempt (`walkInInstance`) cut true draws −63 % for only
−10.5 % CPU (likely confounded by the since-fixed three bug #34054), and
ring-wide merging (v1 `statBatchCrossLb`) measured WORSE (22.5 vs 29 fps) by
forfeiting node-level culling.

**Do the one-page-load ceiling probe first** (big-win report §validation):
Arm B monkey-patches every statics BatchedMesh to emit ONE contiguous
multiDraw range (renders garbage; prices the merged form's CPU exactly).
Decision rule pre-registered: B−A ≥ 8 ms → build region-scoped pre-baked
merge behind `?statMerge` (content-hash dedup first — that half is cheap);
3–8 ms → content-hash dedup only; < 3 ms → the paradigm is fine, drop the
lead. Noise floor is ±2.8 ms. Score on Σ`_multiDrawCount` + renderCPU, never
`info.calls` (goes UP on success).

## 4. Real bugs found on the way (fix candidates, unranked)

- **`?multiAction` / `?castAxes` have NEVER run**: loop.js:416/:462 guard on
  `sessionHandle.pollMotionActions` being a method — they are MODULE exports
  (pkg d.ts:9290/:9297). Both drains return on line 1 every frame. Fixing
  CHANGES LIVE COMBAT BEHAVIOR (features were intended-on but the shipped
  reality never exercised them) → owner call + live test, not a silent fix.
- **`flameFlicker` is silently dead** though counted in the DEFAULT-ON 14: the
  component's own reader (`flameFlicker.js:157`) treats absent as false while
  vfx_flags.js claims default-on. Two competing readers; pick one.
- **wasm pose leak**: `getLocalPlayerPose()` ×4/frame, `.free()` never called
  → ~240 orphaned wasm allocations/s. Small (~0.1 ms) + a leak.
- **Dead sky depth blit**: pmndrs RenderPass ctor sets `needsDepthBlit=true`;
  the sky pass's full-res blit is wiped by worldPass.clearDepth next line.
  One line: `skyRenderPass.needsDepthBlit = false`.
- **Bloom luminance at full res** (`resolution.scale = 0.5` ≈ free), and an
  8 MB bespoke DepthTexture the composer overwrites every frame
  (atmosphere_pipeline.js:306 — dead VRAM; `getSceneDepthTexture()` already
  returns pmndrs' own). **CORRECTED + BUILT 2026-08-01:** the original claim
  was half right — `getSceneDepthTexture()` returned the BESPOKE texture
  (cloud overlay + ground fog read it), but pmndrs allocates its own stable
  depth target regardless (AerialPerspective needsDepthTexture), so two
  full-res depth allocations coexisted. `?stableDepthShare=on` (ship-OFF)
  drops the bespoke one and feeds consumers the StableDepth copy — which
  also removes the fog's sample-while-attached feedback hazard, so run the
  P6 adjudication with this flag in both positions. Off = byte-identical.
- **MSAA allocated for nothing** at mid+ (canvas only ever draws the
  composer's fullscreen quad). **FIXED 2026-08-01:** context `antialias` now
  requested only for `?wireframe=1` or the `?canvasMsaa=on` escape; the
  composer RTs were never multisampled, so mid+ visuals are unchanged (one
  1070 glance at edges to confirm).
- **Dead config**: `hero` flag (live settings checkbox, zero consumers —
  REMOVED 486645da); `lightShafts: true` at high/ultra inert without
  `?clouds=on` (ANNOTATED in quality.js 2026-08-01 — kept true so shafts
  arm when clouds promote); `flags.shadows` never read (only `flags.csm`) —
  **REMOVED 2026-08-01** from PRESETS + BOOL_FLAGS (`?shadows=on` keeps its
  own reader; the Phase 0.1 collapse is deliberately abandoned — wiring it
  would default shadow maps ON at mid+ unmeasured). Undocumented live flags
  `retailSun`, `terrainGouraud`: **DOCUMENTED** in url-flags.md §7.
  **Also FIXED 2026-08-01:** the §0 atlas-gate bug — the 1K tier now reads
  the RESOLVED `quality.preset`, so gpu-probe/localStorage high boots get
  the 1024 atlas. Pinning suite: `test_synthesis4_leftovers.mjs` (16
  checks).
- **Cold-load freeze** (~22 s) still unfixed: boot compile warms the sRGB
  variant, composer needs HalfFloat — same fix as §1's prewarm.

## 5. Refuted — do not chase again

Fill/overdraw & log-depth early-Z (real mechanism, idle GPU → ~0 today; keep
for when GPU-bound, dependency web documented in the big-win report §4);
matrix churn (~1 %, and 12,129-node freeze probe measured −0.35 ms); rAF-loop
count (noise; only real item: `cullStaticsGroup` + billboard tick both walk
staticsGroup — fuse); wasm chatter (22 flat crossings/frame); GC (~2 KB/frame
quiet; the one real GC event is telepoi ring teardown); draw-COUNT as a thesis
(walkInInstance −63 % draws → −10.5 % CPU); "statics atlas starvation" (the
1,000 'eligible' statics were particle billboards); upload-throttle task20.

## 6. Standing measurement rules (the record's own failure modes)

1. `renderer.info.render.calls` undercounts 3.94× (BatchedMesh multiDraw = 1).
2. ~19 `renderer.render()` calls per rAF — normalize per-rAF, never per call.
3. `adaptiveRes` is default-ON — pin `?renderScale&adaptiveRes=off` + explicit
   `?quality` in every A/B (July's fps numbers did not).
4. No absolute draw number is portable across POIs/settle states — pin poses.
5. Re-base the frame: every steady-state number predates bmColorTextureFix AND
   the BC7/PBR/IBL/relief/terrain-VFX bundle (the only post-07-15 A/B is
   36.7 → 34.3 ms at Dryreach, measuring the bundle itself).

## 7. Terrain-VFX promotion cost (from the flag inventory)

Flipping the seven family masters at high adds ~73.6 k scatter instances
(grass 60 k), 5 terrain-fragment branches, 1 post effect, 1 256² trail RT; at
ultra ~146 k instances. Gotchas: `terrainTrail` must promote too (else
stomp/prints silently no-op); the global 4 s trail fade is wrong for snow
(300 s) and mud (30 s); `terrainIce` is an independent master still false at
every tier, so ultra's `terrainIceRefraction: true` is unreachable. All of it
lands on a `mid`-booting 1070 only if the tier tables say so — see §0.

## 8. 1070 to-do list (one session, in this order)

1. Ceiling probe (§3) — one page load, pre-registered decision rule.
2. Re-run `walk-stall-attrib.mjs` baseline (add `&linkProbe=on`) → confirms
   §1; then the SAME walk with `&shaderPrewarm=on&linkProbe=on` (built
   2026-08-01, see §1) — score = LINK_STATUS forced-wait ms + longTasks. Win
   → flip shaderPrewarm default-ON. Also compare cold-load first-frame
   freeze.
3. Re-base pinned-pose frame profile under today's defaults (§6.5).
4. Price the 07-28→08-01 visual bundle OFF vs ON at the same pose.
5. `__atlasStats()` before/after a walk (validates §2 live).
6. The residency items from the 08-01 fixes (anim-scenery census; park-pool
   overshoot) + symbolize the 07-23 16 s wasm freezes
   (`/mnt/wbterminal2/stream/freeze-profile.json`).
