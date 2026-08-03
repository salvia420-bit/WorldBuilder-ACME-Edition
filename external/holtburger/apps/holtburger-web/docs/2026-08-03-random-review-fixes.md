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
