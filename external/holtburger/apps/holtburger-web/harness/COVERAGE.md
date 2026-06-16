# Flag coverage matrix

Every unified-pipeline URL flag → which harness file covers it, which tier, whether
it is **verifiable now (node, no rebuild)** vs **post-rebuild (cargo / playwright)**,
the exact getter / diag-global / rust-test it asserts, and its compose-dep / Rust-const
requirements.

**How to read the tier columns**

- **Tier 1 (node, NOW):** a pure-Node unit test run by `run-js-headless.mjs`.
  Green against the **current** `pkg/`. No rebuild, no server, no browser.
- **Tier 2 (cargo, post-rebuild):** `cargo test -p <crate> --lib` run by
  `cargo-tests.mjs`. Tests run on the **native host target** (these are plain
  `#[test]`, not `wasm_bindgen_test`); the flag only goes *live in the browser*
  after `wasm-pack build --target web --out-dir pkg`.
- **Tier 3 (playwright, post-rebuild + server):** an in-world `assertBrowser` in a
  `flags.*.mjs` descriptor, run by `playwright/drive.mjs`. Reads live wasm getters
  + diag globals inside `page.evaluate`. Needs the rebuild (v4 getters) **and**
  serve.py + ACE + wsbridge.

**Statuses** (see `lib/assert.mjs` + README "Soft-degrade semantics"):
`pass` / `fail` / `skip` (URL-unsettable precond unmet) / `rebuild-pending`
(wasm getter absent from current `pkg/`). Only `fail` is a gate failure.

**Compose / const legend**

- **composeDeps** = other URL flags this flag's *behavior* needs (the playwright
  driver folds them into the boot query automatically).
- **constReq** = a Rust compile-time const NOT settable from any URL. When off, the
  gated behavior is `skip` (presence-only), never `fail`.

---

## TIER 1 group — JS-side flag logic (verifiable NOW, no rebuild)

These are the host-JS unit tests in `run-js-headless.mjs`'s plan. All are
**verifiable now (node)** — pure JS against the current `pkg/`. Many of these
flags ALSO have a wasm/rust half covered in the SPINE/REMOTE/ANIM groups below;
this group is specifically the JS unit-test leg.

| Flag | Harness file | Tier | Verifiable now (node)? | What it asserts | composeDeps | constReq |
|---|---|---|---|---|---|---|
| `inputFunnel` | `test_a14_i1_input_controller.mjs` | 1 | **YES** | Single `InputController` funnel: one `setMovementInput` boundary + one dedup signature; orbit-suppress policy applied at the funnel. Behavioral + static source-pin. | — | — |
| `hookDrain` | `test_hook_windows.mjs` | 1 | **YES** | AnimationHook time-window open/close math (hook fire windows). | — | — |
| `hookDrain` | `test_hook_fire_queue.mjs` | 1 | **YES** | AnimationHook fire-queue drain ordering/dedup. | — | — |
| `surfaceUnified`+`surfaceParityV2` | `test_f7_8_surface_bitfield.mjs` | 1 | **YES** | Surface(0x08) flag→material fold; legacy-cache == unified-cache 70/70 flag×float matrix; parityV2 ClipMap alpha-ref / additive-fog-exempt / InVAlpha-blend (Stage 6). | `surfaceParityV2` requires `surfaceUnified` | — |
| `scriptQueue` | `test_script_manager.mjs` | 1 | **YES** | PhysicsScript manager queue ordering. | — | — |
| `particleOwner` | `test_particle_owner.mjs` | 1 | **YES** | Particle emitter ownership (`__cacheOwned` clone-vs-share). | — | — |
| `preCreateBuffer` | `test_a8_m4_pre_create_buffer.mjs` | 1 | **YES** | Pre-create ring buffer (dependency-free `pre_create_buffer.js`). | — | — |
| `retailRunKeys` (JS half) | `test_a14_i3_run_keys.mjs` | 1 | **YES** | ToggleRun XOR-run key logic (the JS half; the wasm autorun half is in ANIM). | — | — |
| `particleDegrade` (JS half) | `test_a11_s4_particle_degrade.mjs` | 1 | **YES** | Degrade-band distance consumer logic (the JS half; the wasm getter half is in ANIM). | — | — |
| `rootMotionObject` (JS half) | `test_a5_p3_root_motion.mjs` | 1 | **YES** | Root-motion net consumer / `hasRootMotion` predicate (JS half; wasm fold is in ANIM). | — | — |
| `wasmPursuit` (monitor) | `test_a14_i2_pursuit_monitor.mjs` | 1 | **YES** | The rAF `pursuit_monitor.js` state machine (54 cases incl. repeat-charge); pure-JS monitor over a stubbed status. | — | — |
| `rigModule` | `test_a9_stage2_setup_rig.mjs` | 1 | **YES** | Byte-identical rest-pose / part-surface-mesh / partFrames-proxy transforms (pure refactor). **Already default-ON.** | — | — |
| `retailCamZoom`+`camStiffness`+`mouseSmooth` | `tests/camera_retail_math.test.cjs` | 1 | **YES** | Retail camera zoom curve + stiffness + mouse-smoothing math (CJS, `node:assert`). | — | — |
| `remoteInterp` (JS half) | `tests/remote_interp_ownership.test.cjs` | 1 | **YES** | Remote-pose ownership arbitration (JS half; the wasm `pollRemotePoses` half is in REMOTE). | — | — |
| `jumpParity` (JS half) | `tests/jump_charge_parity.test.cjs` | 1 | **YES** | Jump-charge curve parity (JS half; the wasm clock half is in ANIM). | — | — |

> `rigModule` is **already default-ON** (escape hatch `?rigModule=off`); its Tier-1
> test pins that the extracted functions are byte-identical to the legacy inline paths.

---

## TIER 4 group — NEW JS tests (verifiable NOW; may be MISSING until authored)

Run by `run-js-headless.mjs` under `--tier=4`. A missing file is a tolerated
`MISSING` row (not a fail) unless `--strict-missing`.

| Flag | Harness file | Tier | Verifiable now (node)? | What it asserts | composeDeps | constReq |
|---|---|---|---|---|---|---|
| `blockingParticleParity` | `test_a11_s0_blocking_particle.mjs` | 4 | **YES** (present, PASS) | A11-S0 blocking-particle parity (the "wait for emitter" gate). | — | — |
| `defaultScriptSpawn` | `test_a11_s5_default_script_spawn.mjs` | 4 | **YES** (when authored) | A11-S5 default PhysicsScript spawn-on-create path. | — | — |

---

## SPINE group — `flags.spine.mjs` (Tier 3 browser) + Tier 2 cargo

The canonical movement-tick spine + message routing. Browser asserts are
"no-regression / coherence" smokes (there is no tick-count getter); the real
proof is the rust tests. **Spine flags' browser behavior is post-rebuild** (reads
`getLocalPlayerPose` etc., guarded → `rebuild-pending` if absent).

| Flag | Harness file(s) | Tier | Verifiable now? | Asserts (getter/diag) | Asserts (rust test) | composeDeps | constReq |
|---|---|---|---|---|---|---|---|
| `unifiedTick` | `flags.spine.mjs` + cargo (`holtburger-core`) | 3 + 2 | post-rebuild | browser: `getLocalPlayerPose()` coherent + `getCurrentCellId()`/`getRenderSet(1)` non-empty across a settle window + no fatal console errors; `__scene3dFrameDriverActive`. | `tick_spine_handle_ticks_and_preserves_tick_count` | — | — |
| `posePublishPostTick` | `flags.spine.mjs` + cargo (`holtburger-core`) | 3 + (2: **no named tests**) | post-rebuild | browser: pose coherent + bounded idle drift (<50 m / 0.5 s, no input) across the publish window; no teleport-scale jump. | *(none — JS-side frame-driver order; spine tests cover the wasm arm)* | `unifiedTick` | — |
| `wireStatePacks` | `flags.spine.mjs` + cargo (`holtburger-world`/-core) | 3 + 2 | post-rebuild | browser: speculative `serverControlSequence` getter (absent ⇒ rebuild-pending) → falls back to clean-boot routing smoke. | descriptor carries verbatim `apply_self_update_motion`, `record_server_control_sequence`, `build_jump_echoes_server_control_sequence` — **CORRECTED**: first two are production fns (zero-test); real coverage is **core** `build_jump_echoes_server_control_sequence` (+ world `test_update_motion_*`). Query uses `wireStatePacks=stage1`. | — | — |
| `worldLifecycle` | `flags.spine.mjs` + cargo (`holtburger-world`) | 3 + 2 | post-rebuild | browser: login+spawn breathes; no lifecycle-routing panic / fatal console error. | `test_remove_entity_clears_lifecycle_metadata`, `test_retention_snapshot_reflects_lifecycle_metadata` (**CORRECTED**: `parse_world_lifecycle_flag`/`entity_lifecycle_state` are production fns, dropped). | — | — |
| `maintPrune` | `flags.spine.mjs` + cargo (`holtburger-core`) | 3 + 2 | post-rebuild | browser: out-of-PVS prune-to-rig coherence (no entity-map blow-up; no fatal error). | `tick_spine_handle_reports_out_of_visibility_prune_despawn` | `unifiedTick` | — |
| `unifiedTransition` | `flags.spine.mjs` + cargo (`holtburger-core`) | 3 + 2 | post-rebuild | browser: pose coherent across the transition pipeline (no-regression). | `unified_transition_spine_manual_collision_matrix`, `unified_transition_manual_slice_matches_legacy_on_open_ground` (**CORRECTED**: `unified_transition_enabled` is a production getter, dropped). | — | — |

---

## REMOTE group — `flags.remote.mjs` (Tier 3 browser) + Tier 2 cargo

Remote-pose driver + sticky + pursuit. **All rebuild-coupled** (read v4 additive
getters). The composite *behaviors* additionally need a moving remote NPC in view
(else `skip`, presence-only); sticky/pursuit also need a Rust const.

| Flag | Harness file(s) | Tier | Verifiable now? | Asserts (getter/diag) | Asserts (rust test) | composeDeps | constReq |
|---|---|---|---|---|---|---|---|
| `remoteInterp` | `flags.remote.mjs` + cargo (`holtburger-web`) | 3 + 2 | post-rebuild | browser: `pollRemotePoses()` present (absent ⇒ rebuild-pending) → `RemotePoseFrame` stride-7 layout; 0 rows ⇒ `skip("no moving remote in view")` + presence-pass. | `remote_pose_rows_flatten_to_parallel_arrays` (**CORRECTED**: `poll_remote_poses`/`flatten_remote_pose_rows`/`resolve_remote_sticky_target_pose` are production fns, dropped). | `unifiedTick`, `wireStatePacks` (driver adds `unifiedTick=on&wireStatePacks=stage1`) | — |
| `stickyRetail` | `flags.remote.mjs` + cargo (`holtburger-world`) | 3 + 2 | post-rebuild | browser: `localStickyTarget()` + `RemotePoseFrame.stickyFlags` present (absent ⇒ rebuild-pending); nonzero/flagged needs the const ⇒ `skip` if zero. | `remote_sticky_converges_flags_rows_and_times_out`, `remote_sticky_lazy_install_and_removal_cleanup`, `remote_sticky_unstick_clears_and_restick_rearms_timeout`, `remote_sticky_disabled_is_inert`, `local_sticky_install_feed_step_converges_and_times_out` (**CORRECTED**: `remote_sticky_enabled`/`set_remote_sticky_enabled`/`parse_sticky_retail_flag`/`local_sticky_target`/`apply_local_sticky_from_invalid` are production fns, dropped). | `unifiedTick`, `wireStatePacks`, `remoteInterp` | **`USE_STICKY_MANAGER`** (position_manager.rs) |
| `wasmPursuit` | `flags.remote.mjs` + cargo (`holtburger-core`) | 3 + 2 | post-rebuild | browser: `pursuitStatus()` present (absent ⇒ rebuild-pending); issue a pursue intent → state 2 ⇒ pass; fast-fail to 3 ⇒ `skip("USE_MOVETO_DRIVER off")`. | `second_pursuit_entry_turn_begins_on_first_driver_frame`, `pursuit_status_lifecycle_and_cancel_restore` | — | **`USE_MOVETO_DRIVER`** (move_to.rs) |

> `wasmPursuit` also has a pure-JS **monitor** test in Tier 1
> (`test_a14_i2_pursuit_monitor.mjs`) — verifiable now.

---

## ANIM group — `flags.anim.mjs` (Tier 3 browser) + Tier 2 cargo

Animation / jump / run-keys / root-motion / link-resolver / placement / particle.
Getters/exports are **unconditionally present** in the current `pkg/` (probe-guarded
anyway); the *behaviors* are flag-gated, so without the flag the assert is
presence-only.

| Flag | Harness file(s) | Tier | Verifiable now? | Asserts (getter/diag) | Asserts (rust test) | composeDeps | constReq |
|---|---|---|---|---|---|---|---|
| `mtQueue` | `flags.anim.mjs` + cargo (**no named tests**) | 3 + (2: none) | post-rebuild | browser: `window.__notifyAnimationDone` installed + `SessionHandle.notifyAnimationDone` present (absent/no-op ⇒ rebuild-pending). End-to-end notify path needs the flag + tagged keys + const ⇒ presence-only otherwise. | *(none — EMPTY-CONFIRMED: only a production flag-parser exists)* | `hookDrain` | **`USE_MOTION_TABLE_QUEUE`** |
| `jumpParity` | `flags.anim.mjs` + cargo (`holtburger-core`) | 3 + 2 | post-rebuild | browser: `jumpChargeCommence/jumpChargeLevel/jumpChargeRelease/jumpChargeAbort` present (absent ⇒ rebuild-pending); commence → level rises over ~1 s grounded → release. Flag-off ⇒ level 0.0 ⇒ presence-only. | `build_jump_echoes_server_control_sequence` (**CORRECTED**: all 7 `jump_charge_*` are production fns, dropped; real coverage is the shared core jump test + `execute_jump_release_without_charge_is_not_charging`, `queue_head_jump_error_refuses_release`). | — | — |
| `retailRunKeys` | `flags.anim.mjs` + cargo (`holtburger-core`) | 3 + 2 | post-rebuild | browser: `setAutoRun(bool)` present + callable (absent ⇒ rebuild-pending); continuous-forward-run behavior is the wasm autorun path. | `auto_run_default_off_keeps_manual_drive_verbatim`, `auto_run_engage_installs_forward_run_and_cancels_pursuit`, `auto_run_off_restores_held_manual_state`, `auto_run_overrides_forward_keys_but_keeps_sidestep_turn`, `auto_run_same_value_is_a_noop`. | — | — |
| `rootMotionObject` | `flags.anim.mjs` + cargo (`holtburger-web`) | 3 + 2 | post-rebuild | browser: `EntityAnimationData.rootMotionNet` present via `fetchEntityAnimationKeyframes` (absent ⇒ rebuild-pending); non-empty stride-7 net for a translating clip; `?rootMotionObject=1` anchor-apply is remote-only ⇒ presence-only if no translating clip. | `a5p3_net_translation_sums_deltas_across_segments`, `a5p3_forward_then_reverse_nets_to_zero`, `a5p3_yaw_net_survives_fold_that_zeroes_pos_channel`, `a5p3_no_pos_frames_yields_identity_net`, `a5p3_no_cycle_fallback_has_empty_root_motion_net`, `a5p3_inner_v` (**prefix** → `a5p3_inner_v2_surfaces_root_motion_net_for_cycle_and_link`). | — | — |
| `getLink` | `flags.anim.mjs` + cargo (`holtburger-dat`) | 3 + 2 | post-rebuild (browser smoke) | browser: **NO getter by design** — assert clean boot (no module-parse/init console errors) + in-world + transitions play ⇒ pass. NEVER probe a getter; absence is expected, NOT rebuild-pending. | `q4_get_link_forward_hop` (**prefix**, 2 tests), `q4_get_link_backward_hop` (**prefix**, 2 tests), `q4_get_link_full_miss_is_none`, `q4_get_link_inner_key_is_full_command` (**CORRECTED**: `q4_table` is a fixture fn, dropped). | — | — |
| `placementId` | `flags.anim.mjs` + cargo (`holtburger-web`) | 3 + 2 | post-rebuild | browser: `pollEntityUpdates()` present (absent ⇒ rebuild-pending); find a SPAWN-kind chest/corpse, read `.placementId` (0 when the wire carried no placement ⇒ presence + read-0 acceptable, not a fail). | `resolve_static_placement_frame_orders` (**CORRECTED**: `resolve_static_placement_frame` substring still hits the real test; `collect_setup_placement_frames`/`fetch_setup_placement_frames` are production fns, dropped). | — | — |
| `particleDegrade` | `flags.anim.mjs` + cargo (**no named tests**) | 3 + (2: none) | post-rebuild | browser: `window.__hbWasm.fetch_particle_degrade_distance` present (absent ⇒ rebuild-pending); under `?particleDegrade=retail`, a persistent emitter's `.degradeDistance` resolves FINITE (Infinity by default off ⇒ assert finite only under the flag, else skip). | *(none — EMPTY-CONFIRMED: only the production fetch fn exists)* | — | — |

> `particleDegrade` and `rootMotionObject` and `retailRunKeys` each also have a
> pure-JS **consumer** test in Tier 1 (verifiable now): `test_a11_s4_particle_degrade.mjs`,
> `test_a5_p3_root_motion.mjs`, `test_a14_i3_run_keys.mjs`.

---

## SYNC group — `flags.sync.mjs` (Tier 3 browser; JS-live, NO rebuild)

| Flag | Harness file | Tier | Verifiable now? | Asserts (getter/diag) | Asserts (rust test) | composeDeps | constReq |
|---|---|---|---|---|---|---|---|
| `syncPhysicsTick` | `flags.sync.mjs` | 3 | post-server (JS-live, **NO rebuild**) | browser: `window.__syncTickDiag` installed (absent after a wait ⇒ **fail**, it is JS-live, not a rebuild gap — requires the EXACT token `?syncTickDiag=1`); the four counters (`enqueued`, `hopCompleted`, `poseChangedSameFrame`, `skipped2d`) present + numeric and advance. | *(none — JS-side frame-driver change; the wasm TickMovement arm is covered by the spine tests)* | `unifiedTick`, `posePublishPostTick` (+ canary `syncTickDiag=1`) | — |

> `rebuildCoupled:false` — this flag reads only the pure-JS diag object +
> long-present `tickMovement`/`getLocalPlayerPose`; its absence under the flag is a
> plumbing/flag-parse **fail**, NOT a rebuild gap. (Still Tier 3 because it needs a
> live in-world page to observe the counters advance.)

---

## Cross-cutting notes

- **Manifest freshness oracle:** read the runtime `wasm_export_manifest_version()`
  (==4 in the current `pkg/`), NOT index.html's deliberately-pinned
  `EXPECTED_WASM_MANIFEST_VERSION=1`. If `< 4`, classify v4 additive getters
  `rebuild-pending`, never `fail`.
- **Why "post-rebuild" even though the current `pkg/` has the getters:** the
  current `pkg/` (today, manifest v4) already ships every probed getter, so nothing
  is rebuild-pending *right now*. But the harness runs **after** the user's separate
  rebuild, which could regress `pkg/`. Every getter probe is therefore guarded
  (`readGetter(...).present`) so a regressed getter degrades to `rebuild-pending`.
- **`composeDeps` are URL-settable; `constReq` is not.** The playwright driver folds
  every `composeDep` token into the boot query (e.g. `remoteInterp` →
  `unifiedTick=on&wireStatePacks=stage1`). A `constReq` (`USE_STICKY_MANAGER`,
  `USE_MOVETO_DRIVER`, `USE_MOTION_TABLE_QUEUE`) is a Rust const → its gated effect
  is `skip` (presence-only) when off, never `fail`.
- **Test-name CORRECTIONS:** the `flags.*.mjs` descriptors carry the *verbatim*
  task-spec `rustTests` (incl. production fns / wrong-crate names) for traceability.
  `cargo-tests.mjs` carries the *corrected, runnable* list (production fns dropped,
  crate re-homed, `q4_get_link_*_hop` / `a5p3_inner_v` kept as substring prefixes).
  This matrix flags each correction inline.
- **`wireStatePacks` uses `=stage1`, not `=on`.** `rootMotionObject` uses `=1`.
  `particleDegrade` uses `=retail`. `syncTickDiag` requires the EXACT token `1`.
  The driver preserves a descriptor-authored value and only adds a *bare* composeDep
  as `=on` when absent.
