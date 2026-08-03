# 2026-08-03 — Random-spot code review: 18 findings, 20 fixes

Three-way review of random spots in `scene3d/` (frame loop / camera / picking /
`src/lib.rs` sample; entities / animation / animated scenery; terrain /
landblock LRU / cells). Every finding was read-verified against source before
fixing; every fix below is live in this commit. **No fix is URL-flag-gated:**
all 20 run unconditionally on the bare default path (the review's flag scan
found zero new `URLSearchParams` reads in the diff). The only new knob is the
code-level `closedLoop` option on `buildSceneryAnimationClip`, with both call
sites explicit (wind = closed, DAT 0x03 = open).

## Fixed (tasks #1–#20)

| # | Defect (severity order within tier) | Fix | Files | Verified by |
|---|---|---|---|---|
| 1 | Per-entity material mutations (camera fade, ethereal, ramp, TextureVelocity) bled across every entity sharing a palette signature — `_getOrCloneEntityMaterial` returned `__cacheOwned` cache materials as entity-owned | Cache-owned entries upgrade to a private `__disposable` clone before return; mesh re-point extracted to `_repointEntityMeshes` | entities.js | test_cast_overlay_guard 23✓; traced all 8 `_entityMaterials` readers |
| 2 | RP4 pooled per-LB DataTexture double-park: LOD re-bake disposed (= parked) textures the LRU entry still tracked → evict re-parked a texture another LB had checked out → wrong terrain/road codes rendered | New `LandblockLRU.untrackDisposables()`; re-bake untracks before disposing. Ownership rule: exactly one dispose() per resource | terrain.js, landblock_lru.js | 6-check scratch harness (stale ref dropped, fresh kept, no double-dispose) |
| 3 | EnvCell build token restarted at 1 after evict (evict deletes the map entry) → cancelled in-flight build aliased the fresh build's token, attached duplicate cells untracked by `cellContainers3d` (permanent leak), and its `finally` cleared the winner's in-flight marker | Token now drawn from a session-monotonic `_envCellBuildSeq` — never reissued | cells.js | Replay reproduced old collision, proved new one impossible |
| 4 | Animation cache self-poisoning pair: (a) rejected fetch promise stayed in `entries` forever; (b) `partNames` memoized per setupId from a possibly-empty first bake → permanent TypeError → rejected → cached by (a) | (a) rejection arm evicts the promise (identity-guarded); (b) `partNames` rebuilt on any `length !== partCount` mismatch | animation.js | Pre-existing suite failures proven identical on pristine HEAD |
| 5 | `csmState.patchedMaterials` had no remover — every terrain material ever baked stayed in the per-frame CSM walk (heap + CPU growth) | Pruned on evict + park + LOD re-bake (`unregisterTerrainMaterial`), re-added on unpark | terrain.js, landblock_lru.js | 7-check harness incl. park→unpark round-trip |
| 6 | `getLocalPlayerPose()` wasm boxes never freed on 8 call sites incl. the default per-rAF path (~60 orphans/s; violates the invariant documented at camera.js `_integratorWorldPose`) | Copy-then-`free?.()` at all 8 sites (loop.js ×3, picking.js, camera.js camDebug, index.js ×3). index.html already complied | loop.js, picking.js, camera.js, index.js | rust_pose 13✓, remote_interp 12✓, camera_retail_math 28✓, col20 15✓, spell_range ✓ |
| 7 | Over-cap/failed animated scenery peeled from the frozen bake was silently dropped → props invisible (wind trees fill the shared 4096 cap in forests) | `attachAnimatedScenery` returns `{built, failed}` (attachWindTrees contract); statics.js attaches before freezing and re-freezes `failed` | animated_scenery.js, statics.js | test_animated_scenery 16✓, park 12✓ |
| 8 | LOD re-bake disposed the per-LB ShaderMaterial but left it in `scene3d.terrainMaterials` (dead per-frame uniform pushes; far_terrain could seed from a disposed "representative") | Same `unregisterTerrainMaterial` call in the kill loop | terrain.js | Covered by #5 harness + call-site grep |
| 9 | `_attachEntityLights` used `entityMap.has(guid)` post-await — true again after a same-guid LOD respawn → lights attached to disposed rigs, `activeLights`/`_entityLightCount` leak until light budget starves | Identity guard (`inst._disposed \|\| get(guid) !== inst`), matching the established sibling pattern | entities.js | Pattern-matched to :5315/:13712/:16125 |
| 10 | Zero-ref animated-scenery DID groups (created before fallible fetches) ticked their mixers 60×/s forever when the build failed; `_windRigCache` never cleared on dispose | DID driver created only after every fallible fetch succeeds ("create the driver last" — no sweep state needed); `_windRigCache.clear()` in dispose | animated_scenery.js | test_animated_scenery 16✓ |
| 11 | Mixer `finished` listeners orphaned on every interrupted overlay (only natural completion removed them) — unbounded accumulation on the session-long local-player mixer | One retire-closure per rig (`_baseSuppressOff`), retired before re-arm and on all cancel paths via `_completeOverlay` | entities.js | test_cast_overlay_guard 23✓ incl. cancel-path bookkeeping |
| 12 | `?warmPark=off` (and headless default) could evict an LB across the terrain bake's `prewarmSubtree` await → duplicate full-res terrain mesh (z-fighting, doubled VBO) — the code comment claiming safety was wrong | Residency re-check on `terrainBakedLbs` after the await; bail releases geom/material/textures/wasm handle | terrain.js | Reasoned + syntax only — see "Needs live coverage" below |
| 13 | Overlapping `bakeTerrainRing` re-run leaked all ~169 prefetched subdivided wasm meshes (the only `free()` was inside the baker, skipped by the already-baked early return) | Baker nulls `subdivEntry.mesh` on consume; ring frees every unconsumed entry (consumed ⇔ null is the single-free discriminator) | terrain.js | test_terrain_ring_batch 23✓ |
| 14 | 15 s terrain light tick + shadow-receive gate throttled on `frameTime.tsSec`, which freezes under `?renderOnDemand=1` → terrain Gouraud lighting frozen at boot values in bot sessions, shadow gate never re-walked (same hazard RP3 already fixed for its own throttles) | Both throttles moved to a live monotonic clock | loop.js | Grep: no test injects that clock; rAF cadence unchanged |
| 15 | `park()` dual-state recovery ran a full `evict()` against the still-resident LB — disposed live geometry, cleared baked marks, purged wasm collision to heal a bookkeeping glitch | Non-destructive `_discardStalePoolCopy` (ownership-gated disposal, `stalePoolCopiesDropped` counter) | landblock_lru.js | dualstate 26✓ (incl. two new assertions), all 9 LRU suites |
| 16 | `getBatch`'s `inFlight.finally()` derived promise adopted rejections unhandled → spurious `Uncaught (in promise)` on every batch prewarm failure | `.then(cb, cb)` — error still propagates exactly once via the returned promise | animation.js | Syntax + semantics review |
| 17 | Scenery clip duration `(n-1)*dt` gave the final DAT frame zero dwell (per-cycle pop on flags/banners). NOTE: the original finding overstated this — wind clips genuinely need `(n-1)*dt` (closed loop, `frame[0]===frame[n-1]`) | Explicit `{closedLoop}` option; wind = closed (default, unregressed), DAT 0x03 = open (`n*dt`) | animated_scenery.js | test_wind_clip_gen 11✓ + 2 new assertions in test_animated_scenery |
| 18 | (a) `drainRemotePoses` didn't bound the poses stride → short array = NaN poses; (b) park-bound telemetry counted candidate exhaustion as "storms prevented", corrupting the counters that validate the bounded-park path | (a) row count includes `floor(poses.length/7)`; (b) `clipped` gated on an explicit `hitParkBound` | loop.js, landblock_lru.js | park_storm 36✓ incl. new negative case (`?lbCap=4` vs 9-LB floor → 0 hits) |
| 19 | (follow-up) dualstate test asserted the old destructive behavior #15 removed | Asserts `evicted === 0` + `stalePoolCopiesDropped === 1` | test_landblock_lru_warmpark_dualstate.mjs | 26✓ |
| 20 | (follow-up to #7) `cells.js` discarded `attachAnimatedScenery`'s return → **interior** over-cap/failed scenery still rendered nowhere | Retro-freeze into the prop's own cell container (residency-checked, layer 1, shadow flags, one-shot matrix compose, `peeledAnimated` decrement) | cells.js | Syntax + frozen-path parity review; envcell_guard failure proven pre-existing on HEAD |

## Not fixed / known remaining

**Needs live coverage before full confidence:**
- **#12's bail path is reasoned-only.** It triggers only under `?warmPark=off`
  with an eviction landing inside a wasm bake — unreachable from node tests.
  Run a headless `?warmPark=off` roam (teleport hops past `?lbCap`) and check
  for the `[terrain]` bail log / absence of duplicate meshes.
- **1070 eye-test queue** (batch per the standing workflow): #1 — camera-fade
  through a recolored-armor character standing next to a same-recolor NPC
  (NPC must NOT fade); #17 — flag/banner loop smoothness (no per-cycle pop,
  wind trees unchanged).

**Known defects observed but deliberately not fixed (out of scope / other owners):**
- `index.js` `loadEnvCellsForLandblock`: the `evictedDuringBuild`/`inFlight`
  early-exit paths still call `track()` and register an empty LRU entry.
- `camera.js` `?camDebug` `world()` reads `cs.sessionHandle`, which the
  CameraSwitcher may never set (`_getSessionHandle` is the accessor) — the
  debug helper can silently return `{0,0,0}`.
- Test-harness `stripExports` gaps crash 4 entity-lifecycle suites on
  `entities.js`'s `readParticleEnv` import / missing `readSelectionIndicatorMode`
  stub (pre-existing; symbols exist in the source).

**Pre-existing test failures — all proven byte-identical on pristine HEAD
(checkout-swap + `cmp`); do not chase against this commit:**
- `test_envcell_guard.mjs` — harness doesn't stub `STREAM_BAKE_DEFAULT_MAX_IN_FLIGHT`
- `test_mat_budget_lru.mjs`, `test_materials_paletted_lru.mjs`, `test_terrain_visual_z` — need `THREE_PATH` env
- `test_terrain_{dirt_shader,ice,sand_sparkle,snow,volcano_shader}` — GLSL
  byte-identity/sampler-count locks broken earlier by the range-fog term
- `test_phase7_4a_animation_clip.mjs`, `test_motion_sequence.mjs` — expectation
  drift vs. in-place root-motion removal
- `test_a5_p3_root_motion`, `test_phase7_batch9_entity_lifecycle`,
  `test_phase7_4b_entity_pipeline`, `test_phase7_batch7_omega_basescale` —
  the stripExports harness gaps above

## Green at commit time

All 9 LRU suites (evict 39, park_storm 36, sealed_park 46, sealed_keepring 5,
geom_governor 21, pool_scan 12, server_urgency 17, null_lb 12, dualstate 26),
fixed_grid_park 33, park_usetime 27, animated scenery 16 + park 12,
wind 11+11+11, terrain_ring_batch 23, lru_light_eviction 9,
cast_overlay_guard 23, rust_pose 13, remote_interp_ownership 12,
camera_retail_math 28, col20_remote_turn_gate 15, spell_range, hook_windows 11,
gemsparkle 35. All edited files `node --check` clean.

Reminder: JS-only change set — no wasm rebuild needed, but dev loads need
`?nosw=1` once or the service worker serves the old JS.

---

# Round 2 (same day) — fresh random spots: 21 findings, 21 fixes + 1 deferred

Second pass over sections round 1 never touched: buildings + far_terrain (main),
materials + statics + static_atlas (agent A), lighting + play_effect_vfx +
particles (agent B). All 21 findings read-verified before fixing; both agents
additionally proved their fixes against deliberately-reverted source.

## Fixed (tasks R2#1–R2#21)

| # | Defect | Fix | Verified |
|---|---|---|---|
| R2#1 | `material.userData.heightTex` held a live DataTexture → three r184's `Material.copy` JSON-serialized the whole height bitmap on EVERY cache clone (default path); FrontSide clones additionally retained the parsed blob | WeakMap side-channel (`heightTexForMaterial()`), all 5 clone sites inherit explicitly; BONUS same-root-cause: the five `*ShaderUniforms` userData stashes made non-enumerable (`_defineLiveUserData`) so bound textures stay out of the JSON | Measured 3.92→0.01 ms/clone (388×) and 28.43→0.01 (2758×); packNraLayer data-path harness green |
| R2#2 | First outdoor light-pool tick resurrected the atmosphere-zeroed legacy sun to 1.0 → two suns, one frozen at a fixed heading, every default session | Unconditional indoor capture (records 0); outdoor arm restores ONLY a captured value | Scratch harness reproduced `i=1` pre-fix; test_light_pool 14✓ |
| R2#3 | `?buildingBatch` (default-on) placements never reach `buildingsGroup`, so evict couldn't prune their `buildingMap3d` keys → post-evict re-bake skipped every placement → buildings permanently vanished on re-approach | Prefix-prune of `buildingMap3d` by the placementKey's leading 8-hex landblockId in evict()'s building arm | All 5 LRU suites green |
| R2#4 | BC7 upgrade disposed the RGBA8 texture `emissiveMap` still referenced (every luminous surface under `?texBc7=on`) | `emissiveMap` re-pointed on base + 4 variants + vfxVariants before dispose | Re-read (needs BPTC GPU — eye-test queue) |
| R2#5 | Variant-map invalidation was a bare `.delete()` — stale grey clones stayed on live meshes forever + orphaned materials | In-place re-seat (`_reseatVariantsForDid`): same object re-adopts the new surface state, meshes heal automatically | Harness: identity preserved, texture adopted, no Color aliasing |
| R2#6 | `_resolveRough` async arm: no identity guard + minted roughness/AO textures tracked by nothing (unfreeable) | Guard added; `_texchanTextures` tracked, freed on evict + dispose, bytes charged | Harness: 2 planes tracked → disposed on evict |
| R2#7 | Statics evicted-during-build guards gated on `staticsTimeSlice` while ~8 awaits run unconditionally → orphan/duplicate bake under `?noStaticsTimeSlice=1` | Residency re-checks made unconditional | Re-read + suites |
| R2#8 | `combatFxEnabled()` read `!== "off"` directly under its own "STRICT === on, do NOT copy that shape" contract — un-eye-tested splatter path live by default | Strict `=== "on"`; splatter now genuinely opt-in (eye-test to promote later) | Harness: 6-of-7 inputs read ON pre-fix |
| R2#9 | Deferred emitter spawns guarded on `entityMap.has()` → parented to disposed rigs on same-guid respawn | Identity guards (`_isLiveInstance`) at both sites | Harness reproduced `parent=OLD-ROOT` pre-fix |
| R2#10 | Cell-scoped light selection invalidated only by (renderSet, count) → count-preserving churn kept released ghost lights lit and new torches dark indefinitely | Per-light identity hash (`__lightSeqId` FNV) folded into the rebuild key | Harness reproduced ghost selection pre-fix; test_cell_lights 18✓ |
| R2#11 | `destroyParticleEmitter` bypassed the slot-material pool its own contract names → per-cast clone churn on every reaped emitter | One-line route through `_reclaimSlotMaterial` | test_particles 64✓ (4 assertions updated to assert the invariant, not the mechanism) |
| R2#12 | Animated luminous surfaces (lava) cycled `map` but not `emissiveMap` → frozen glow under a moving surface | `cyclesEmissive` recorded at setup; both maps advance | Harness: both advance together |
| R2#13 | Recycled atlas layer committed even when the diffuse write was skipped → previous surface's texels rendered on an unrelated prop | Zero-fill on wrong-stride (RGBA8); release-layer + passthrough on BC7 write failure; counters added | Re-read; counters should stay 0 |
| R2#14 | Walk-in atlas pre-filter used the pre-X6 `img.data` gate → BC7 statics never batched on the walking path | Shared `isBc7AtlasTexture()` used by feed + pre-filter | Re-read (BPTC — eye-test queue) |
| R2#15 | Atlas per-node catch had no undo (leaked layer refcounts; live-but-unrecorded instances double-rendered) + O(n²) `passthrough.includes` | Partial-commit tracking + unwind in catch (`ptErrorUnwound`); includes-scan dropped | Re-read; stats counter |
| R2#16 | `_instGeomCache` never disposed; empty instancing buckets lived forever | Dispose-listener eviction on source geometry; idle-bucket reap after 180 ticks | test_particle suites green |
| R2#17 | Culled count-bounded emitters could never drain (comment claimed otherwise) | 30 s continuous-cull force-stop for `totalParticles>0 && totalSeconds===0`; persistent emitters excluded; stat counter | Harness incl. persistent-emitter negative case |
| R2#18 | `zeroLightPool` truncated selections without clearing `__lightPoolSel` → permanent 0.8× sort bias | Tags cleared before truncation | Harness reproduced stale tag pre-fix |
| R2#19 | `(x ?? -1) >>> 0 >= 0` — precedence made the partIndex guard tautological | Explicit `Number.isInteger(raw) && raw >= 0` | Harness |
| R2#20 | `buildSingletonNode` all-bands-failed fallback returned a mesh whose transform was already zeroed onto the discarded LOD | Transform restored from the LOD before returning | Re-read (latent path) |
| R2#21 | `bakeBuildingsRing` cached `incomplete` (decode-starved) bakes cross-LB, bypassing the per-LB poisoning quarantine | `bake.incomplete` skipped, mirroring the per-LB arm | Re-read (test/capture path) |

## Deferred / known remaining (round 2)

- **Task #42 (open):** `BLOCKING_PARTICLE_PARITY_ON` (`play_effect_vfx.js:2287`)
  has the same `!== "off"` footgun under a default-off comment, with twins in
  entities.js and statics.js — `test_a11_s0_blocking_particle`'s 3 remaining
  failures are pre-existing assertions demanding the strict form. Needs one
  coordinated pass + a retail-parity decision; not fixed this round.
- **1070 eye-test queue additions:** R2#4 + R2#14 (`?texBc7=on` on BPTC),
  `?statPom=on` relief still marching after the R2#1 height-channel change,
  R2#8 (`?combatFx=on` splatter A/B to promote default-on properly).
- far_terrain.js minor notes (not tasked): bake-rig material clone not disposed
  on `bumpFarCompositeEpoch`/teardown; a patch retired mid-fetch repopulates
  its orphaned `lbData` (GC-recoverable, never GPU-uploaded).
- materials-agent notes: `packNraLayer` return ignores height-only surfaces
  (feeds an unread field); `consolidateSingletonsViaTexArray` is dead code.

## Green at round-2 commit time

light_pool 14, cell_lights 18, particles 64, rp6_cull 16, lru_light_eviction 9,
all LRU suites (evict 39, dualstate 26, park_storm 36, sealed_park 46,
fixed_grid 33), animated_scenery 16, vertex_bake_flags 61, a11_s0 45/48 (3 =
the deferred #42 assertions, pre-existing). Materials-agent ran a full 198-suite
A/B: identical pass/fail to pristine baseline. `node --check` clean everywhere.

---

# Round 3 (same day) — boot/adapter/worker + body-sim/HUD/shadows: 18 findings, 18 fixes + 1 deferred

Third pass: bake_worker_client/adapter/index.js (boot-agent), csm/dismember/
nameplate_sprite/ragdoll (csm-agent), lib.rs + index.html pattern sweeps (main —
no new fixable findings; wire-data getters are length-guarded, flag readers
match their docs). All 18 findings read-verified; both agents proved fixes
against reverted source.

## Fixed (tasks R3#1–R3#18)

| # | Defect | Fix | Verified |
|---|---|---|---|
| R3#1 | CSM refit skip compared position+sun only — first-person look-around (in-head pitch moves the camera 0 m) froze cascades AND the re-raster gate | Orientation term from matrixWorld basis columns + fov/aspect/near/zoom compares; per-instance `camRotDeltaSqEps` | 13/13 harness; reverted source reproduces didRefit=false on pure pitch; static-camera skip intact |
| R3#2 | Corpse-dismemberment archive (cap/TTL evict) disposed geometry still parented to LIVE corpse rigs (?dismember default-ON) | Ownership handback for parented meshes (`__corpseArchived=false, __disposable=true`); restore re-inserts for LRU order | 8/8; reverted source reproduces disposedCount=1 on a live rig |
| R3#3 | Texel snap used per-frame AABB-derived texel size — anti-shimmer guarantee not delivered | Rotation-invariant bounding-sphere fit; snap in a world-anchored light basis | Ortho width rotation-invariant to 1.1e-13 m (pre-fix 326 m spread); texel lock 1.3e-13 |
| R3#4 | refreshCsmUniforms built 6 template-literal keys per material per frame | Uniform refs resolved once, stored non-enumerable (R2#1 JSON lesson applied); Matrix4s hoisted | Suites + program-key lock 15/15 |
| R3#5 | Nameplate LOD: children.find closures ×2 per entity per frame + fresh scratch objects | inst._buffBadgeSprite slot + pooled _lodEntry scratch (refs nulled after use) | lod-badge suite green |
| R3#6 | Nameplate cache FIFO eviction never disposed; "GC reclaims GPU" premise false for three.js — unbounded VRAM leak past 512 unique names | _pendingDispose + mark-and-sweep vs the live entity map (~600-tick cadence); telemetry getter | 4-case harness; all fail on reverted source |
| R3#7 | Ragdoll pose writer allocated ~2n arrays/frame and recomputed after settle | *_Into quat helpers + preallocated swing slots; swing set latches at freeze (pose re-assert kept — must land after mixer) | Byte-identical output over 1200 frames (maxDiff 0) |
| R3#8 | Badge on an entity with no nameplate sprite escaped every cull → stranded "+N" chip at any range | Badge visibility keyed off _buffBadgeSprite incl. the no-sprite arm | Reverted source leaves badge visible at 300 m; fixed hides |
| R3#9 | Debris tick copied the whole registry per rAF frame | Direct Set iteration (deletion-safe, invariant stated) | Re-read |
| R3#10 | dismember header/log claimed strict =on while default-ON (deliberate 2026-08-02 flip); nameplate occlusion comment claimed a retired gate | Comments/log corrected — no flag behavior touched | Grep |
| R3#11 | Crashed bake worker never terminate()d, respawned per bake with no backoff (stale-pkg spawn storm) | terminate + geometric cooldown (1s→30s cap), one-shot stale-pkg warn; explicit terminate() still respawns immediately | 20 bakes in cooldown spawn 1 worker (pre-fix: 20) |
| R3#12 | Request enqueued while worker null never settled → guardedStreamBake slot held forever, fallback never ran | _request settles undispatched entries; queue-off arm + _pump postMessage throws settle + unwind | 29/29 settle-contract harness; pre-fix scores HANG |
| R3#13 | ?targetFps pacer double-charged the sleep → ~2× requested rate, 16/100 ms sawtooth | Budget charged against the frame's start (pure `pacerDelayMs`, exported) | Simulated: 17.24→10.00 fps flat |
| R3#14 | Unguarded direct-path render: a throw killed the frame loop permanently + leaked the camera layer mask | try/catch/finally — finally restores autoClear + mask and always scheduleNext()s | Re-read (mirrors composer guard) |
| R3#15 | Terrain atlas layer index unchecked: undefined→NaN→silently corrupts layer 0; code≥33 aborts whole atlas | Per-tile fail-soft skip + warn + tile free | 25/25; reverted source corrupts layer 0 |
| R3#16 | vfxGauge begin/end asymmetry → GL_INVALID_OPERATION every other frame, multi-frame measurements | begin/end matched via pending slot; poll-only frames issue no endQuery | 10/10 vs strict mock GL; pre-fix 20 errors/30 frames |
| R3#17 | surfacePixelsToTexture had no length check (only sibling without one) | byteLength >= w*h*4 or THROW (deliberate: all 6 callers deref unconditionally — soft-null would crash at call sites) | Harness |
| R3#18 | meshToFusedGeometry unguarded null-ptr first read failed the whole LB statics bake | try/catch → null, matching meshToGeometryGroups | Harness |

## Deferred / known remaining (round 3)

- **Task #61 (open):** dismember slicePart/fracturePart/chipPart mutate a captured
  part after `await _loadPinata()` with no identity guard (R1#9 class) — stump
  meshes on a detached rig after same-guid respawn. Next round.
- **Task #42 (still open):** BLOCKING_PARTICLE_PARITY_ON strict-on trio.
- csm.js `dispose()` → scene.remove(csmGroup) remains the one runtime
  light-count mutation (soft 3D→2D→3D re-init relinks everything) —
  teardown-ownership change in lighting.js, deliberately untouched.
- Debris rAF ignores ?targetFps/?renderOnDemand/?nullRender — left as-is
  (physics must integrate while rendering is gated); revisit if bot CPU matters.
- ragdoll _corpsePoses FIFO (plain Float32Arrays, no GPU) — harmless, noted.
- Boot-agent's scratch harnesses (settle-contract, pacer, adapter, vfxGauge)
  live in the session scratchpad — self-contained, ready to promote into
  tests/ if wanted.

## Green at round-3 commit time

visfid_p33_csm 16, visfid_c4_program_cache_key 15 (light-count lock),
nameplate lod-badge/font-gate/item-type, ragdoll_energy 32, kill_impulse 115,
carnage_finisher 248, light_pool 14, cell_lights 18, lru_light_eviction 9,
spotlight_target 4, p1_alias_split 9. All 7 edited files node --check clean.
Pre-existing failures re-proven on baseline by both agents (md5-verified
restores): phase7_6_lighting (1 check), p33's harness import gap,
f10_hud_nameplate (hud.js, not touched).

---

# Round 4 (same day) — sky/atmosphere + the FIRST Rust-crate review: 21 findings, 21 fixes + 2 deferred

Fourth pass, scoped off this document so no ground was re-covered: the sky/
atmosphere stack (sky-agent), the workspace Rust crates — never reviewed before
(rust-agent), and the leftovers + deferred items from rounds 2-3 (main).
All 21 findings read-verified; both agents proved key fixes against reverted
source.

## Fixed — sky/atmosphere (R4#1–R4#10)

| # | Defect | Fix | Verified |
|---|---|---|---|
| R4#1 | `?skyBirds` (default-ON since 2026-06-23) parked the Swarm anchor in the ROOT Y-up scene while positioning it as AC Z-up → birds 40 m SOUTH at eye level, never overhead. The feature has never worked. | Emitter frame established first (attachSkyParticleChain → static ParticleManager under worldRoot ⇒ AC-frame), anchor re-parented to worldRoot, lift via worldToLocal so it's correct under either parent | Harness: fixed = +40 m AC up / 0 horizontal; reverted = 0 m up, 40 m AC south |
| R4#2 | url-flags.md row 273 claimed `horizonFade`/`aerialDepth` default-ON; code is strict opt-in and row 34 of the SAME doc adjudicates it OFF — the inverse of the four `!== "off"` footguns | Row corrected (default OFF, strict `on/1/true/yes`, third name `horizonDissolve`, `?aerialDebug` note) | Doc-only |
| R4#3 | Cloud composer's lazy sizing fed drawing-buffer px into pmndrs setSize (→ renderer.setSize with updateStyle undefined) → canvas CSS box + backing store resized at DPR≠1 | `renderer.getSize()` (CSS px), matching index.js's correct resize call | Reverted harness: DPR 2 → canvas 1920→3840 CSS/7680 backing; renderScale 0.75 → 1440 |
| R4#4 | night_ramp re-parsed location.search on every flag read → ~14 URLSearchParams/frame from the sky tick | Parsed-params cache (test seam preserved) | 840 allocs/60 frames → 0 |
| R4#5 | IBL 15 s refresh throttled on the freezable frameTime clock — R1#14's hazard at a third call site | Live monotonic clock at the loop.js call site (single hunk) | Re-read + suites |
| R4#6 | SkyDome.dispose orphaned the bird anchor, its Swarm emitters (shared manager) and the idempotence guard → R1#10 zero-owner ticking; stale guard blocked re-attach | destroyAllForOwner on the same key the attach used, guard cleared, anchor removed | sky_birds 19/19 |
| R4#7 | fxPass never re-pointed on camera switch — EffectPass HAS a real mainCamera setter, so top-down ortho decoded depth with the perspective formula (aerial/heatHaze/dissolve all wrong) | retargetFxPass on both switch paths, inside the cam-changed guard; one-time recompile invariant commented | Re-read |
| R4#8 | CloudVolume.snapshotUniforms read five uniforms its own comment says were deleted → guaranteed TypeError (cloud-bridge harness dead since Sky-K.6) | Defensive reads → null; dispose-safe | Reverted throws; fixed returns nulls + sunDirection |
| R4#9 | weather_state.recompute allocated ~6 objects/frame under a "Zero-alloc" comment | Étage table memoised on latitude band; scratch seam for lat/lon; comment corrected | Values stable in-band, rebuild on both crossings |
| R4#10 | `skyObjLum` carried a self-contradicting "default OFF → byte-identical" + "default-ON" comment pair, duplicated in two files | Stale halves deleted (comments only) | Grep |

## Fixed — Rust crates (R4#11–R4#21), first review of this code

Context: wasm32 `usize` is 32-bit and `overflow-checks = false` ships in every
profile for these crates, so integer wrap is silent.

| # | Defect | Fix |
|---|---|---|
| R4#11 | Six unguarded per-entry slice reads in IdentifyObjectResponse stat tables — a truncated 0xF7B0 packet PANICS the wasm module | Per-table bounds pre-check (checked_mul/checked_add idiom from reliability.rs) |
| R4#12 | `update_player_inventory_recursive` had no visited set — a self-referential/cyclic wire `Container` id hangs the tab forever | HashSet visited (also collapses the diamond case) |
| R4#13 | `*offset + len > data.len()` wraps on 32-bit for the 0xFFFF-escape u32 length — the guard itself lets the panic through (3 helpers, dozens of opcodes) | checked_add |
| R4#14 | `count * 8` wraps past its own bounds check on CreateObject → 4.3 GB with_capacity + OOB loop | Clamp/checked math, matching the sibling sites' mask |
| R4#15 | Signed DAT counts sign-extend into with_capacity (surface_texture runs per rendered surface) | `.max(0)`, matching sound_table's idiom |
| R4#16 | Unbounded with_capacity from raw u32 counts in motion_table ×3 and region ×14 — Region parses at boot, so pre-login DoS | New `safe_capacity`; read loops still honor the wire count and fail at EOF |
| R4#17 | CharacterList swallowed entry-parse failure → 4.29e9-iteration spin on the first post-login message | Abort the parse; `Vec::new()` kept deliberately |
| R4#18 | terrain_subdiv neighbour-strip indexing off by one in all four directions, contradicting control_grid_normals in the same file (latent — no non-test callers; independently confirmed) | Aligned with the correct sibling; deleted seam test restored |
| R4#19 | Rotation was NaN-guarded but coords/velocity were not, in the same function — one NaN UpdatePosition poisons the pose permanently (rebucket is NaN-inert) | Guards on player + all remote entities; new Vector3::is_finite/finite_or_zero |
| R4#20 | Building-AABB neighbour ring `continue`d at the landblock edge instead of rebasing → walk-through-wall near any 192 m seam | Cross-LB rebase (pure bit math, no loads); 2 tests |
| R4#21 | Sweep: 32-bit `count*4` guard wraps (4 sites), 11 unclamped with_capacity, height_seam `n*4` wraps, unbounded reorder buffer, fragment-count ceiling | require_fixed_stride / capacity_hint / MAX_PENDING_SERVER_PACKETS / MAX_FRAGMENTS_PER_MESSAGE |

**Found while fixing:** `height_seam.rs micro_detail_dark` indexes `rgba[i*4+2]`
unguarded — private, and its single caller's guard was exactly the `n*4` that
wrapped, so the wrap made it reachable. Both fixed.
**False alarm not forced:** squelch's `filters[i]` write is already bounded by
its own `if i < 4`; only the wrap needed fixing.

## Also fixed this round (main)

- Task #61 (deferred from R3): identity guards at all three dismember
  post-await seams (slice/fracture/chip) — fragments disposed on the bail path.
- Task #42 (deferred from R2): the BLOCKING_PARTICLE_PARITY trio resolved by
  correcting the TEST, not the code — git history (9d06254a "default-on 41
  validated feature-gates") and url-flags.md both show the default-ON flip was
  deliberate, so the three `!== "off"` readers are right and the 2026-06-11
  strict-opt-in assertions were the stale side. `test_a11_s0_blocking_particle`
  48/48 (was 45/48). combatFx's gate comment reworded — it cited the trio as a
  footgun to avoid; it is a validated gate, just not a model for un-eye-tested
  features.
- portal_space.js: wasm mesh handle freed; MAX_HOLD documented as reserved
  (travel always ends at TRAVEL_DUR, so the cap never binds today).
- Stale `?terrainBatch` default-OFF claims corrected in loop.js + url-flags.

## Deferred / known remaining (round 4)

- **Task #84 (open):** IBL PMREM bakes the cloud fullscreen quad + moon
  billboards into `scene.environment` under `?clouds=on&?ibl=on`; also
  cloud_bridge_test.html is still dead (`_internals.decodeArgbToRgb01` removed
  in Sky-K.6 — R4#8 only stopped the throw); url-flags rows 1353/1354 keep
  stale line refs.
- `MAX_FRAGMENTS_PER_MESSAGE = 16384` (~7 MB) is a judgement call — well above
  any real AC message, but the true DDD patch-chunk max was not verifiable.
  Documented as tunable, rejection logged at warn.
- 1070 eye-test queue additions: R4#1 (birds actually overhead), R4#3
  (`?clouds=on` at DPR≠1), R4#7 (C-key to top-down with `?atmosphere=on`).

## Green at round-4 commit time

Rust (independently re-run by main, post-`touch`): holtburger-protocol 389 ✓,
holtburger-world 663 ✓, holtburger-dat 679 ✓ + 1 failure PROVEN pre-existing by
a pristine-source swap (`triangle_corner_ring_matches_height_sampler`, panics in
`point_in_ring_2d`, unrelated to R4#18). Agent total across crates: 2478.
JS: sky_birds 19/19, cloud_overlay_dispose 5/5, ground_fog 65, weather_flags
9/9, a11_s0_blocking_particle 48/48, atmosphere_pipeline_passes, cloud_storm_look,
vfx_weather_inputs, particle_clock, shader_prewarm and the rest of the sky set.
All edited JS files `node --check` clean.

**Process note worth keeping:** restoring backups with `rsync -a` preserves
mtimes, so cargo silently reuses the PRISTINE test binary and reports green
against code that was never compiled. Caught by a test-count mismatch. Always
`touch` after a checkout-swap experiment.
