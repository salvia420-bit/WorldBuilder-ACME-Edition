# Animation T1–T8 Implementation — Handoff (2026-06-03)

> **POST-WORKFLOW ADDENDUM (Claude, after the run):**
>
> - **The IDE's hard rustc errors are PRE-EXISTING, not from this work.** git-verified: committed HEAD already has the 4-tuple `build_concatenated_motion_frames` + the 3-tuple test destructure (`lib.rs` ~36934/36964) AND the `IconPixels` "cannot find type" (`lib.rs` ~6031). They break the **host `cargo test`** build (and rust-analyzer), not necessarily the `wasm-pack`/wasm32 bundle. Our +930-line diff does not touch them. The `pkg` import cache-buster is literally `?v=icon-pixels-wiring-fix-20260530` — IconPixels was a prior in-flight wiring change. (Optional: the test fix is 2 lines — destructure `(frames, times, _pos, duration)` at both sites — to unblock `cargo test` for the lib.rs crate so our new host test can run.)
> - **Already applied by Claude:** the `stateGroundSpeed` half of must-fix #1 — threaded into the wasm named-import block (`index.html:~1013`) AND the init3D opts (`index.html:~6651`), mirroring `cycleBaseSpeed`. Takes effect after the final `wasm-pack` rebuild (the new export doesn't exist in the current stale `pkg/` yet). The `playerRunRate` half (#2) was NOT auto-fixed — it needs a design call (see below).
> - **T1 CLOSE-OUT (2026-06-03, second code-only pass) — the three deferred items are now FIXED in source** (still zero-build; gated `?velScale=on`, default OFF):
>   - **(#2) `playerRunRate` shape** — converted the `lib.rs` struct getter into a FREE `#[wasm_bindgen(js_name = playerRunRate)]` export backed by a `thread_local LATEST_RUN_RATE` (set in `publish_player_stats_snapshot`); threaded into the index.html import + opts. entities.js's `wasmExports.playerRunRate()` now resolves, so run-skill/encumbrance modulate gait (was falling back to 1.0).
>   - **(#3) double-scale** — `entities.js` tick now uses `velScaleComponent` ALONE on the getter path (`speedFromGetter ? velScaleComponent : velScaleComponent * motionSpeed`), since the getter already encodes `forward_speed`. EMA fallback unchanged. (Eye-test note: the EMA path may also double-count; revisit when flipping the default.)
>   - **(baseSpeed chain)** — `lib.rs::cycle_base_speed` now runs velocity → MotionKinematics (new `motion_kinematics_cycle_base_speed` helper reads the `holtburger/core` asset; any fetch/parse miss degrades safely via `.ok()?`), addressing the T11 `|velocity|==0` player-cycle case. **Step 3 (GetAnimDist) is the only piece still deferred** — a rare deep fallback hit only when BOTH velocity sources are empty; needs an async PosFrame fetch (`MotionTable::cycle_anim_dist_base_speed` is built and ready in holtburger-dat).
>   - **Still deferred on purpose:** flipping `VEL_SCALE_ON` default-on (`entities.js:~310`) — gated on the 1070 GPU eye-test confirming gait (and #3 at partial speeds). One-line change.
> - **Build-guidance correction:** `IconPixels` (`lib.rs:~6043`) is `#[cfg(target_arch = "wasm32")]`-gated but referenced by a non-gated fn, so **host `cargo test -p holtburger-web` is broken PRE-EXISTING** (plus the 3-tuple test). The wasm32 `wasm-pack` build has `IconPixels` present and is unaffected. So: `cargo test -p holtburger-dat` / `-p holtburger-world` run our new unit tests; the new `lib.rs` host test (`state_ground_speed_walk_run_sidestep`) only runs once those two pre-existing host-build breaks are fixed (the 2-line test-arity + the IconPixels host-gating).
> - **Landed and reviewed `pass` (independent of all T1 wiring):** T2 (Transparent fade-OUT fix), T3 (frameTimes passthrough), T4 (per-part particle anchoring), T5 (Ethereal citation), T6 (CallPES jitter), T7 (bitfield accessors), T8 (24-bit mask). These are the bulk of the value and do not depend on the wasm-boundary plumbing.
> - **Landed and reviewed `pass` (independent of all T1 wiring):** T2 (Transparent fade-OUT fix), T3 (frameTimes passthrough), T4 (per-part particle anchoring), T5 (Ethereal citation), T6 (CallPES jitter), T7 (bitfield accessors), T8 (24-bit mask). These are the bulk of the value and do not depend on the wasm-boundary plumbing.

---

# HANDOFF — Zero-Build Animation Implementation (T1–T8)

**Date:** 2026-06-03
**Mode:** ZERO-BUILD (read/edit only — nothing was compiled or run this session)
**Tree:** `/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger` (canonical; no worktree copies touched)
**Net verdict:** Build-ready by inspection. All five units reviewed `pass` / `pass-with-nits`, no must-fix issues *inside any unit's own files*. There are **3 cross-unit integration must-fixes** (plumbing + interface-shape) that leave the T1 velScale feature **inert until resolved** — detailed in §3 and §4. Everything is gated `?velScale=on` (default OFF), so default render behavior is unchanged and nothing crashes.

---

## 0. MEMORY-SAFE BUILD + TEST COMMAND SEQUENCE (run these, in order)

> HARD RULE (per MEMORY): **NEVER `cargo test --workspace` / `cargo build --workspace`** — that froze the box. Always per-crate with `-j2`. The wasm bundle goes through `wasm-pack`, which is single-target and safe. `cargo` + `wasm-pack` live in `~/.cargo/bin` (already on the user's interactive PATH; the `wasm32-unknown-unknown` target is installed).

All commands assume you start a fresh interactive shell.

### Step 1 — per-crate host tests for the 3 touched Rust crates (memory-safe, `-j2`)

```sh
cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger

# rust-dat: T7 accessors, T8 24-bit mask, T1 GetAnimDist + base-speed resolver
cargo test -j2 -p holtburger-dat motion_table:: motion_kinematics::

# rust-world: ACE GetRunRate parity (run_rate_from_skill_and_burden)
cargo test -j2 -p holtburger-world run_rate_from_skill_and_burden_matches_ace_getrunrate

# rust-wasm host test (host-reachable via #[cfg(any(target_arch="wasm32", test))]):
#   tests_soa_parity::state_ground_speed_walk_run_sidestep
cargo test -j2 -p holtburger-web state_ground_speed_walk_run_sidestep
```

If you want one crate's full suite (still memory-safe), drop the test-name filter but KEEP `-j2 -p`:
```sh
cargo test -j2 -p holtburger-dat
cargo test -j2 -p holtburger-world
cargo test -j2 -p holtburger-web
```

### Step 2 — build the wasm bundle (the production browser bundle is `pkg/`)

```sh
cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web

# Inner-loop (~3 s, no wasm-opt) — use this first to shake out compile errors:
wasm-pack build --target web --out-dir pkg --dev

# Shipping/eye-test bundle (~60 s, runs wasm-opt):
wasm-pack build --target web --out-dir pkg --release
```

> `index.html` imports `./pkg/holtburger_web.js` — `pkg/` is the live bundle. (`pkg-web/`, `pkg-node/`, `pkg-nodejs/` are stale/alternate outputs — do not point the page at them.) `wasm-pack build` honors `.cargo/config.toml`'s `-zstack-size=8388608` automatically.

### Step 3 — JS contract test (standalone Node runner, exit 0/1)

```sh
cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web
node tests/entity_anim_targets.test.cjs
```

### Step 4 — serve for the GPU eye-tests

```sh
cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger
python3 scripts/serve.py        # :8765 by default; validates baked layers, auto-creates the dist symlink
# open http://127.0.0.1:8765/apps/holtburger-web/index.html
# velScale features are OFF by default — append ?velScale=on to exercise T1
```

---

## 1. CHANGE MANIFEST (unit → files → targets → what changed)

### Unit: `rust-dat` (T7, T8, T1-base-speed/GetAnimDist) — *done, reviewed pass-with-nits*
**Files:**
- `crates/holtburger-dat/src/file_type/motion_table.rs`
- `crates/holtburger-dat/src/file_type/motion_kinematics.rs`
- `crates/holtburger-dat/src/file_type/mod.rs`

| Target | What changed |
|---|---|
| **T8** | `MOTION_KEY_MASK` `0x000F_FFFF` → `0x00FF_FFFF` (20-bit→24-bit) in BOTH `motion_table.rs` (~16) and `motion_kinematics.rs` (~14). Applies ONLY to the outer cycle/modifiers/links key — the **Links inner key stays full 32-bit** (`motion_data_for_link` unchanged). |
| **T7** | `MotionData::clears_modifiers()` = bit0 (`&1`), `MotionData::is_allowed_gate()` = bit1 (`&2`) accessors. |
| **T1 base-speed** | `MotionData::get_anim_dist(&self, pos_frames: &[Frame]) -> f32` — ACE `GetAnimDist` (MotionTable.cs:572-589): `offset += frame.origin` accumulated, **`offset.length()` taken AFTER the loop** (magnitude-of-vector-sum, NOT sum-of-magnitudes), `dist/total_frames*anims[0].framerate`. Plus resolver halves on `MotionTable`: `resolve_stance` (0→default_style), `cycle_velocity_base_speed` (chain step 1, `Some(|v|)` iff `HAS_VELOCITY` and `>1e-4`), `cycle_anim_dist_base_speed` (chain step 3). |
| **mod.rs** | Re-export `AnimData` + `MotionData` at `file_type` root so the wasm crate can name the types. |

### Unit: `rust-wasm` (T1: `stateGroundSpeed` + `playerRunRate` + run-rate wiring) — *done, reviewed pass-with-nits*
**Files:**
- `apps/holtburger-web/src/lib.rs`
- `crates/holtburger-world/src/context.rs`

| Target | What changed |
|---|---|
| **T1 state velocity** | New SYNC pure-math export `state_ground_speed(forward_command:u32, forward_speed:f32, sidestep_command:u32, sidestep_speed:f32, run_rate:f32) -> f32`, `#[wasm_bindgen(js_name = stateGroundSpeed)]`. Mirrors retail `get_state_velocity`: X = (sidestep==`0x6500000f`?`1.25`*ss:0); Y = (fwd==`0x45000005`?`3.1199999`*fs : fwd==`0x44000007`?`4.0`*fs : 0); `mag=sqrt(X²+Y²)` clamped to `run_rate*4.0`. **run_rate applied INTERNALLY — JS must not re-scale.** |
| **T1 anim consts** | `WALK_ANIM_SPEED=3.1199999`, `RUN_ANIM_SPEED=4.0`, `SIDESTEP_ANIM_SPEED=1.25` (float precision load-bearing for A/B), gated `cfg(any(wasm32, test))`. |
| **T1 run-rate getter** | `#[wasm_bindgen(getter, js_name = playerRunRate)] pub fn player_run_rate(&self) -> f32` reading cached `LatestStats.run_rate` (new field), fallback `FALLBACK_RUN_RATE_SCALAR=4.5`. Populated in `publish_player_stats_snapshot` via `WorldContextExt::player_run_rate()`. |
| **context.rs** | `run_rate_from_skill_and_burden` — **behavior UNCHANGED**; added a doc comment + a test locking ACE `GetRunRate` math (skill≥800→4.5 cap; skill 300 unencumbered→2.65; over-encumbered→1.0). |

### Unit: `entities-js` (T1 consumer, T2, T4 provider, T5, T6) — *done, reviewed pass-with-nits*
**Files:**
- `apps/holtburger-web/scene3d/entities.js`
- `apps/holtburger-web/tests/entity_anim_targets.test.cjs` (new)

| Target | What changed |
|---|---|
| **T2** | `_applyRampValueToMaterial` hookType 20 (Transparent) / 7 (TransparentPart): `opacity = 1 - value; transparent = value > 0` (was `opacity = value; transparent = value < 1.0`). Hook value is TRANSLUCENCY — retail `SetTranslucencySimple` α = 1-trans; previous code faded IN instead of OUT. |
| **T5** | `_applyEtherealToEntity`: removed false `set_translucency_internal(0.4f)` citation; doc now states retail `set_ethereal` only flips collision bit 0x4 + transient 0x100, touches no opacity; the `0.4` opacity kept as a documented client invention. Behavior unchanged. |
| **T6** | CallPES `setTimeout` pause replaced fixed `pause*1000` with `randPause = pauseW < 0.0002 ? 0 : timeRng()*pauseW` (RollDice(0,pause)); `start_time` stays additive. Applied in both the chain walker and the hookType===19 branch. New import `rng as timeRng` from `./particles/time_rng.js`. |
| **T4 (provider)** | Attach live `root.partFrames` Proxy: `partFrames[partIndex]` lazily returns CURRENT **world-space** `{position:Vector3, quaternion:Quaternion}` of `parts[partIndex]` via `updateWorldMatrix(true,false)`+`getWorldPosition/getWorldQuaternion`. Integer-index guard (neg/OOB/non-int/method-name → undefined → consumer falls back to root). |
| **T1 (consumer)** | `_resolveStateGroundSpeed(inst)` calls `wasmExports.stateGroundSpeed(...)` with `run_rate` from optional `wasmExports.playerRunRate()`; feeds the result as `cycleTimeScale`'s `actual` arg, falling back to `inst._emaSpeed` only when null/0. Stashes `_forwardCommand/_forwardSpeed` (setMotion) + `_sidestepCommand/_sidestepSpeed` (setSidestepLayer). `VEL_SCALE_ON` left default **OFF** with `// T1: flip to default-on only after a GPU eye-test validates gait`. |

### Unit: `animation-js` (T3, T1 cycleTimeScale doc) — *done, reviewed pass-with-nits*
**File:** `apps/holtburger-web/scene3d/animation.js`

| Target | What changed |
|---|---|
| **T3** | `AnimationCache.get()` now forwards `animData.frameTimes` (Float32Array, fail-soft→undefined on old bundles) + `animData.duration` (`+animData.duration`, NaN→undefined) into `buildAnimationClip`. Previously the per-frame timing was discarded so every clip used the uniform `t=i/framerate` fallback at the AVERAGED framerate — wrong for the ~23% multi-segment swings/casts. Both keyframe tracks remain `THREE.InterpolateDiscrete` (load-bearing for non-uniform times) + GUARD comment. |
| **T1** | `cycleTimeScale` clamp `[0.25,4.0]` and `base<=1e-4 → 1.0` no-op confirmed UNCHANGED; stale docstring updated to record the new contract (actual from `stateGroundSpeed`, run_rate already internal). Pure function — no code change. |

### Unit: `particle-js` (T4 consumer) — *done, reviewed PASS*
**File:** `apps/holtburger-web/scene3d/particles/particle_emitter.js`

| Target | What changed |
|---|---|
| **T4** | `updateParticles()` frame resolve hardened the root sentinel from `partIndex === -1` to `partIndex === -1 || (partIndex >>> 0) === 0xffffffff`; consumes the exact `partFrames` accessor `(this.parent.partFrames && this.parent.partFrames[this.partIndex]) || this.parent`. `// T4:` doc block added. (The `partFrames` consume itself pre-existed; only the sentinel + doc are new.) |

---

## 2. TESTS ADDED + HOW TO RUN

### Rust host tests (run via Step 1 above)
- `holtburger-dat motion_table.rs::tests`:
  `t8_high_low24_substate_resolves_and_does_not_alias`, `t7_bitfield_accessors_decode_independent_bits`, `t1_get_anim_dist_straight_line` (2.0/4*30=15.0), `t1_get_anim_dist_is_vector_sum_then_magnitude_not_sum_of_magnitudes` (+1,−1→0.0), `t1_get_anim_dist_curved_three_four_five` (|(3,4,0)|/2*20=50.0), `t1_get_anim_dist_empty_returns_zero`, `t1_cycle_base_speed_resolver_halves`.
- `holtburger-dat motion_kinematics.rs::tests`: `t8_kinematics_high_low24_substate_does_not_alias`.
- `holtburger-world context.rs::tests`: `run_rate_from_skill_and_burden_matches_ace_getrunrate`.
- `holtburger-web lib.rs::tests_soa_parity`: `state_ground_speed_walk_run_sidestep` (Walk/Run/Sidestep/combined/backstep/run_rate*4.0 clamp/SideStepLeft=0/idle=0) — host-reachable (`cfg(any(wasm32, test))`).

### JS contract test (run via Step 3 above)
- `apps/holtburger-web/tests/entity_anim_targets.test.cjs` — re-implements the pure contracts (entities.js can't be imported without THREE+DOM+wasm). Covers: T2 translucency inversion/fade-out direction; T6 RollDice(0,pause) window + sub-0.0002 immediate-fire + additive start_time; T4 partFrames integer-index guard (valid/OOB/neg/non-int/method-name); T1 getter-vs-EMA source selection + run_rate-internal + no-stash→null + absent-getter→null. Standalone `node tests/<name>.test.cjs`, exit 0/1.

**No test was run this session (zero-build rule).** All Rust correctness is by-inspection; the reviews verified every external symbol/signature/field exists.

---

## 3. INTERFACE-CONSISTENCY VERDICT

**`buildReadiness: ready`** — all four cross-file / wasm-boundary contracts (`stateGroundSpeed`, `playerRunRate`, anim consts, `cycleBaseSpeed` unchanged, `partFrames`) are **name- and shape-consistent**. No build-breakers, no missing exports, no signature mismatches, no `#[wasm_bindgen]` gating errors. The arity-5 JS call site matches the export; `run_rate` is applied internally and JS does not double-scale.

### MUST-FIX (cross-unit; will compile + link, but the T1 feature is INERT until resolved)

1. **`stateGroundSpeed` + `playerRunRate` are NOT threaded into the `wasmExports` opts** in `apps/holtburger-web/index.html` (and `scene3d/index.js`). Only `cycleBaseSpeed` is plumbed (index.html:1013 + ~6651). Consequence: `this.wasmExports?.stateGroundSpeed` is `undefined` → `_resolveStateGroundSpeed` always returns null → **T1 silently falls back to the XZ-EMA it was meant to replace.** Fix: add `stateGroundSpeed` (and a callable for run_rate — see #2) to the destructured wasm free-exports AND the init3D opts object, exactly like the existing `cycleBaseSpeed` treatment. *(Owner: JS-wiring/plumb unit — not an entities-js edit.)*

2. **Interface-shape mismatch on `playerRunRate` (no compiler catches it).** `lib.rs` implements it as a `#[wasm_bindgen(getter, …)]` **struct getter** (property on the SessionHandle/client struct), but `entities.js` consumes it as a **free function** on the module-exports object (`typeof rrFn === 'function'`). A struct getter is not a member of the free-export object → `rrFn` is undefined → run_rate silently defaults to **1.0** (gait still runs, but run-skill/encumbrance modulation is dead). Fix: either (a) `lib.rs` exposes a free `#[wasm_bindgen]` fn named `playerRunRate`, OR (b) `entities.js` reads it as a property off the struct handle (and the `typeof===function` guard changes to a property read). Coordinate `lib.rs` ↔ wiring unit.

3. **Double-application of `forward_speed` in the velScale path** (`entities.js:6994-6996`, pre-existing A1 code). `tick()` does `cycleTimeScale(actualSpeed, base) * motionSpeed`. With the getter live, `actualSpeed ≈ const * forward_speed * run_rate` and `base` is the full-speed authored ground speed, so `velScaleComponent ≈ forward_speed`; multiplying again by `motionSpeed (= forward_speed)` yields ≈`forward_speed²`. Harmless at `forward_speed≈1.0` (run), but at partial speeds (e.g. 0.5) the cycle plays at 0.25× instead of retail's single `Framerate *= speed`. Fix during the gating eye-test: either feed `forward_speed=1.0` into the getter, OR drop the `* motionSpeed` multiply in the getter-active branch so the framerate scale applies exactly once. **Confirm before flipping `VEL_SCALE_ON` default-on.**

> **ADDENDUM (2026-06-03, code-review verification pass):** All three cross-unit must-fixes above — **AND** the step-2 baseSpeed/MotionKinematics wiring flagged in the §3 "NON-BREAKING SEMANTIC GAP" below — are **RESOLVED at HEAD** (still gated `?velScale=on`, default OFF). Verified by reading current source:
> - **#1 (opts threading)** — `stateGroundSpeed` and `playerRunRate` ARE threaded into both the wasm named-import block and the init3D opts object (`index.html:6666` / `index.html:6670`), mirroring the existing `cycleBaseSpeed` treatment. `this.wasmExports.stateGroundSpeed` / `.playerRunRate` now resolve.
> - **#2 (`playerRunRate` shape)** — `lib.rs` now exposes `playerRunRate` as a **FREE** `#[wasm_bindgen(js_name = playerRunRate)]` export (`lib.rs:25865`, backed by a `thread_local LATEST_RUN_RATE`), not a struct getter, so `entities.js`'s `typeof rrFn === "function"` guard succeeds — no silent fallback to `run_rate = 1.0`.
> - **#3 (forward_speed double-count)** — the getter-active branch applies the framerate scale exactly once (`speedFromGetter ? velScaleComponent : velScaleComponent * motionSpeed`, `entities.js:7019-7021`); the `* motionSpeed` multiply now fires ONLY on the EMA-fallback path.
> - **Step-2 baseSpeed/MotionKinematics wiring** — `lib.rs::cycle_base_speed` now interleaves the standalone `MotionKinematics` resolver as fallback-chain step 2 (`motion_kinematics_cycle_base_speed`, called at `lib.rs:4708`), addressing the T11 `|velocity|==0` player-cycle case at runtime. (Step 3, `GetAnimDist` pos-frame resolution, remains the only deferred deep fallback — see §4.)
>
> The single remaining gate is the **`?velScale=on` GPU eye-test on the 1070 → then flip `VEL_SCALE_ON` default-on** (`entities.js:314`). The original must-fix/gap text is preserved above for history.

### NON-BREAKING SEMANTIC GAP (completeness shortfall, not a build risk)

- **baseSpeed fallback chain is PROVIDED-BUT-NOT-CONSUMED.** rust-dat added `cycle_velocity_base_speed` / `cycle_anim_dist_base_speed` / `get_anim_dist` (chain steps 2 & 3), but `lib.rs`'s inner `motion_cycle_base_speed` + the `cycleBaseSpeed` export **still return only `|MotionData.velocity|` (step 1)** — they were not extended to interleave `MotionKinematics::cycle_kinematics` or `GetAnimDist`. Unused `pub` methods are legal Rust (at most a dead-code warning). **Effect: the T11 blocker — player RunForward cycle with `|velocity|==0` → returns 0.0 → `cycleTimeScale` no-ops — is NOT actually resolved at runtime.** If `lib.rs` was meant to be extended this session, that edit is missing (owner: the T1 base-speed-wiring unit, `lib.rs` scope).

### Cosmetic nits (no behavior/compile impact)
- rust-dat: dead `if total_frames == 0` guard (line-268 early-return already covers it); `get_anim_dist` omits ACE's explicit `if (dist==0.0) return 0.0;` (behaviorally equivalent, no NaN).
- rust-wasm: two **inaccurate comments** — context.rs comment wrongly claims `/4.0` is ACE's only divisor (spec says the `/scaling` divisor is intentionally omitted, faithful only for scaling=1.0); lib.rs comment wrongly cites the movement-caps path as the fallback-justification source. Comment-only, recommend correcting.
- entities-js nits: sidestep/turn routed through `setMotion` stashes into `_forwardCommand` (getter X-term unused for that path; EMA covers it); backstep correctness depends on upstream remapping WalkBackwards→WalkForward+negate (verify the actual broadcast `forward_command`); `_sidestepSpeed` hardcoded to 1.0 (no real diagonal foot-speed). All graceful, all deferrable.

---

## 4. RESIDUAL RISKS + EVERYTHING DEFERRED

### Deferred (explicitly NOT done this session)
- **`VEL_SCALE_ON` default flip** (`entities.js:~310`) — left default-OFF with the eye-test-gate comment. **Flip only after the 1070 GPU eye-test confirms gait AND must-fix #3 (double-scale) is resolved.** This is the headline deferral.
- **baseSpeed fallback-chain wiring in `lib.rs`** (`motion_cycle_base_speed` → interleave `MotionKinematics::cycle_kinematics` → `GetAnimDist` pos-frame resolution). The rust-dat halves exist; `lib.rs` was not extended (T1 base-speed unit's `lib.rs` scope). Until done, the T11 blocker stands.
- **JS plumbing of `stateGroundSpeed`/`playerRunRate`** into index.html/scene3d/index.js opts (must-fix #1/#2).
- Threading the real wire `sidestep_speed` through `setSidestepLayer` (diagonal foot-speed).
- No JS test added for `animation.js` (no in-file cfg(test); the existing `test_phase7_4a_animation_clip.mjs` already covers the frameTimes+duration path and the new code satisfies it). No JS test added for particle_emitter.js (only the standalone `test_particles.mjs` harness exists; out of the unit's file scope).

### GPU eye-tests — ALL PENDING (run on the 1070, off-screen/headless per MEMORY rules; `?velScale=on` to exercise T1)
- **T1 gait / anti-ice-skating** — confirm the velocity-scaled locomotion matches retail; verify must-fix #3 (no double-scale at partial speeds) and backstep `forward_command` shape before flipping `VEL_SCALE_ON`.
- **T2 fade-out direction** — Transparent/TransparentPart hooks now fade OUT (visible behavior change for any live hook).
- **T3 multi-segment timing** — A/B a real multi-segment swing/cast clip; confirm `THREE.InterpolateDiscrete` snaps correctly over non-uniform `frameTimes` (the non-uniform branch is never exercised in production today — unverified in r184).
- **T4 per-part anchoring** — spawn an entity whose CreateParticle hook carries a non-root, non-0xFFFFFFFF `part_index` (forge embers / weapon-tip trail); confirm the emitter sits on the limb, not the origin. Add a per-LB wire-agent diag counting emitters whose resolved anchor != root.
- **T6 CallPES jitter** — confirm the spawn timing spread (bounded `[0, pause]`).

### Other risks
- **Empirical T11** — does the live player RunForward cycle actually carry `|velocity|==0`? Needs a DAT dump + build to settle whether `GetAnimDist` ever fires for the player MT.
- **DAT-distribution claims** (e.g. "50/436 tables set bit0") validated only by the existing sweep test — needs a build + retail `portal.dat`.
- **Names are load-bearing with no compiler check** across the wasm boundary — the must-fix shape mismatches (#1/#2) are exactly this class. Verify the wired names match `stateGroundSpeed` / `playerRunRate` verbatim.
- T6 introduces non-determinism in CallPES timing (`Math.random` by default; `time_rng.setRng` makes it deterministic for tests) — accepted per spec.

---

## 5. "FIRST BUILD, THEN EYE-TEST THESE" CHECKLIST

1. **[ ]** Run the per-crate host tests — §0 Step 1 (`cargo test -j2 -p holtburger-dat` / `-p holtburger-world` / `-p holtburger-web`, filtered). **Never `--workspace`.**
2. **[ ]** `wasm-pack build --target web --out-dir pkg --dev` (fast) to shake out any compile error; then `--release` for the eye-test bundle. — §0 Step 2
3. **[ ]** `node tests/entity_anim_targets.test.cjs` (exit 0). — §0 Step 3
4. **[ ]** Resolve the 3 cross-unit must-fixes (§3): thread `stateGroundSpeed`+`playerRunRate` into index.html/scene3d opts; reconcile the `playerRunRate` getter-vs-free-fn shape; fix the `* motionSpeed` double-scale. Optionally wire the baseSpeed fallback chain in `lib.rs` (T11).
5. **[ ]** `python3 scripts/serve.py`, open `…/index.html`. — §0 Step 4
6. **[ ]** Eye-test (1070, off-screen) with `?velScale=on`: **T1** gait (no ice-skating, correct partial-speed framerate), **T3** multi-segment swing/cast timing, **T4** non-root particle on the limb not origin, **T2** translucency fade-OUT, **T6** CallPES jitter spread.
7. **[ ]** Only after T1 gait passes AND the double-scale is fixed: **flip `VEL_SCALE_ON` default-on** at `entities.js:~310` (separate change).