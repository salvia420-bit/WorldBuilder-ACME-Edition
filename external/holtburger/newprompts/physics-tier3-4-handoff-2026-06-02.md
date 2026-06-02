# Holtburger Physics Parity — Tier-3/4 Handoff & Remaining Work

**Date:** 2026-06-02
**Branch:** work landed on `feat/physics-tier3`, fast-forwarded to `master` (origin `salvia420-bit`).
**Predecessor:** `newprompts/physics-deep-dive-2026-06-01/` (the verified gap analysis: GUIDE.md, verified-comparison-report.md, cross-codebase-reference-index.md, PROMPTS.md).

---

## 0. One-paragraph status

The deep-dive's **7 movement-physics gaps + tier-2 (calc_friction + edge-slide)** are **done, reviewed faithful-to-ACE, live-validated in-world, and on `master`** — that's the player-facing movement parity. This round added **tier-3** (run-skill hydration ordering fix, indoor ramp floor-pop, step-up test), **tier-4** (the `CTransition` collision/reconciliation rewrite, landed as **flag-gated DEFAULT-OFF foundations** so the shipped solver is byte-identical), and the **Run-from-Quickness** fix. What remains is *collision-solver depth* — dominated by one large item (the full BSP resolver); the rest is finishing/wiring scaffolding that's already in place. **Everything builds green (core 280 / world 322, 0 regressions).**

---

## 1. Commit map

On `master` (already shipped before this round): gaps 1–7 + tier-2 — commits `7801d453` `766fd4fa` `54152074` `cd4ae687`.

This round (this handoff):
- `c552e219` — **tier-3 smaller:** run-skill hydration ordering fix; indoor ramp floor-pop (`USE_RAMP_FLOOR_SNAP_FIX`, default-on); wired step-up integration test.
- `1adf6934` — **tier-4 CTransition foundations** (all flag-gated DEFAULT-OFF).
- `3310cab0` — **Run derived from Quickness** when the wire lacks the Run skill (always-trained).
- (this doc) — handoff.

---

## 2. THE RUN ISSUE (read this — it blocks the "dramatic low-Run gap-2 A/B")

**Symptom:** every character — existing `tailnet1` chars AND freshly-created `createTestCharacter` Adventurers — runs at ~4.2–4.7 m/s in-world, i.e. the flat fallback, never a skill-accurate slow speed. So the deep-dive's headline worst-case (gap-2 dual-predictor sawtooth, which only shows when the integrator runs ≪ the JS predictor's flat 4.5) **cannot be reproduced**.

**What's correct (don't re-derive wrong):**
- Run is **always trained**, derived from **Quickness**: a fresh trained char's Run skill **== Quickness** (Q10→Run10, Q100→Run100); **specializing adds +10**; ranks accrue from xp. Matches `derive_skill_value` (`Run => (Some(QuicknessAttr), None, div=1)` in `crates/holtburger-world/src/player/stats_calc.rs`).
- `GetRunRate` caps at 4.5 only for Run ≥ 800; a fresh char (Run ≈ Quickness ≈ 10–100) → ~1.1–1.9 m/s.

**Chain of findings (verified live via the local wire-agent, nullRender + playerStats):**
1. The integrator run speed = `player_run_rate_scalar(world) = world.player_run_rate().unwrap_or(FALLBACK_RUN_RATE_SCALAR=4.5)` (`crates/holtburger-core/src/client/movement/common.rs:147`).
2. `player_run_rate` (`crates/holtburger-world/src/context.rs:200`) needs `get_player_skill_current(Run)` → reads `world.player.skills`. For these chars Run (SkillType 24) is **absent** from the skill vector → was returning `None` → 4.5 fallback.
3. **Fix `3310cab0`:** when Run skill is absent, derive Run = Quickness (always-trained) via `get_player_attribute_current(QuicknessAttr)` instead of falling back to 4.5. Correct + committed + unit-green.
4. **BUT the fix did not change the observed run speed** — still ~4.2 m/s. Yet `playerStats()` (the wasm projection, `PlayerStatsSnapshot.attributes`/`.skills` Uint32Arrays) shows **6 attributes (incl. a Quickness entry) and 60 skills** for the fresh char. So the data exists in the playerStats projection but **`player_run_rate` still hits the 4.5 fallback** — meaning `world.player.attributes` (the store `get_player_attribute_current` reads) is **not** populated, even though the playerStats projection is.

**Conclusion / the actual remaining bug:** a wasm-side **hydration/store-routing** mismatch — `PlayerDescription` data reaches the `playerStats()` projection but not `world.player.{attributes,skills}` that the integrator's `player_run_rate` reads (Run absent + Quickness not reaching that store). The tier-3 ordering fix (`c552e219`, cache + re-route `PlayerDescription` after `WorldState` construction) addressed the *world-is-None-drops-the-message* race, but for these `createTestCharacter` chars the integrator's player store still isn't getting attributes/skills. **This is NOT a physics-correctness defect** — the math is right; the data isn't reaching the right struct.

**Concrete next step (the narrow follow-up that unlocks the dramatic A/B):**
- Trace how `playerStats()` is populated vs how `world.player.{attributes,skills}` is populated. Find where the fresh char's `PlayerDescription` (or stats updates) land. Confirm whether `hydrate_from_player_description` (`crates/holtburger-world/src/player/mutations.rs:337`, skill loop ~407-445, attribute loop nearby) actually runs for the integrator's `WorldState` for a `createTestCharacter` spawn — or whether `playerStats()` reads a *separate* projection that's fed by a different path.
- Caveat the user gave: "**when everything is finally built it will be like that**" — i.e. the current char-gen/wire data is incomplete (Run not in the vector yet). Once the data is complete *and* it reaches `world.player`, the `3310cab0` fix makes run speed Quickness-accurate and a low-Quickness char will run slow → the **dramatic gap-2 sawtooth A/B becomes reproducible** (legacy predictor 4.5 vs integrator ~1.5 → big overrun, suppressed by `window.__predPureSmooth` pure-smoothing).

**Note:** the gap-2 *fix itself* is already validated — unit tests (`test_pure_smooth_prediction.mjs` 5/5, maxOverrun ≤ 0 vs a synthetic moving integrator) + consistent live driftMax reduction (ON < OFF across every char tested). Only the worst-case *magnitude* is unreachable until the run issue above is resolved.

---

## 3. Tier-4 flags (all DEFAULT-OFF — shipped solver unchanged)

| Flag | Item | Status | What remains |
|---|---|---|---|
| `USE_SUBSTEP_TRANSITION` | CalcNumSteps substep loop (`ceil(dist/radius)` collide+slide) | **functional** flag-on, unit-tested | key on 3D dist (vs lateral-XY); tighten swept-circle for same-side diagonal approach |
| `USE_PHYSICS_BSP` | physics-BSP narrow-phase (low+high two-sphere) as a solid-gate | **PARTIAL** | full `BSPTree.find_collisions` resolver (~3,500 LOC state machine) — dedicated effort |
| `USE_RETAIL_INTERPOLATE` | InterpolateTo/ConstrainTo easing curve (`force_position_interp.rs`, 1:1 ACE Interpolation/ConstraintManager) | **scaffolding** (curve+stepper done+tested) | wire the single per-frame `step_force_position_interpolation` call into `advance_local_pose_for_manual_drive`; then flip on. Nits: `Failed`-on-stall unconditional, `keep_heading` stored-not-read |
| `USE_CLIFF_SLIDE` | N_new × N_last seam-skid | **scaffolding** (cross-slice, can't fire in real path) | move the seam-skid INSIDE the per-substep loop so it fires intra-substep |

`USE_RAMP_FLOOR_SNAP_FIX` (tier-3, default-ON): aabb.min.z used only as a fall-through lower bound on ramped cells (never pushes the player down); per-poly floor still snaps.

---

## 4. Remaining work (prioritized) — aside from the run issue (§2)

**Large (its own multi-session workflow):**
- Full `BSPTree.find_collisions` resolver — the retail collision state machine (~3,500 interlocking, mutable-by-ref LOC). PASS-1 narrow-phase is the foundation; the resolver is the bulk of all remaining parity work.

**Medium (~a focused day each):**
- cliff_slide intra-substep (move seam-skid into the substep loop so `USE_CLIFF_SLIDE` actually functions).
- precipice_slide + step_down walkable re-entry + `save/restore_check_pos` backup-pose machinery (ACE Transition.cs:282-319).
- Outdoor building-clamp wall normals (so edge/cliff-slide work outdoors, not just indoor cell walls).

**Small (hours):**
- Wire `USE_RETAIL_INTERPOLATE` stepper into the integrator hot-loop (single call-site) + flip on.
- CalcNumSteps refinements (3D dist + same-side approach).
- The 2 InterpolateTo reviewer nits.

**Validate (after wiring; needs hardware/capture, no new code):**
- Flip the 4 tier-4 flags on and validate via the local wire-agent / off-screen 1070.
- Dimension-6 `set_motion` wire capture (does retail per-axis `set_motion` overwrite vs accumulate — affects diagonals).
- Real-GPU render eye-test on the 1070 when it's up (headless nullRender validates physics/poses, not pixels).

---

## 5. How to build / test / validate (memory-safe — the box OOMs)

- **NEVER `cargo test --workspace`** at full parallelism — it FROZE the box. Always: `cd external/holtburger && export PATH="$HOME/.cargo/bin:$PATH" && export HOLTBURGER_PORTAL_DAT=/home/wbterminal/ac_base_dats/client_portal.dat && export CARGO_BUILD_JOBS=2`.
- Physics tests: `cargo test -j2 -p holtburger-core -p holtburger-world` (~2 s). Workspace compile: `nice -n 10 cargo build -j2 --workspace --exclude holtburger-web`. wasm: `CARGO_BUILD_JOBS=1 nice -n 12 wasm-pack build --target web --out-dir pkg --release` (the served dir is `pkg/`, not `pkg-web`).
- rust-analyzer (LSP) can balloon to ~2.4 GB and is the main swap pressure — `kill` it to reclaim if a build is starved (it's in earlyoom's prefer-kill list anyway).

**Live in-world validation (no 1070 needed):** Playwright chromium → `http://127.0.0.1:8765/...` direct (dev server `serve.py` + wsbridge :8080 + ACE :9000 all local). Two non-obvious requirements:
1. `?wireframe=1&hud=none&plugins=none&nullRender=1&diag=1&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first&kickDance=1` — **`nullRender=1` is mandatory**: SwiftShader can't draw baked Holtburg, so without it rAF collapses to ~0.2 Hz and the integrator starves; with it, 60 Hz.
2. Session handle is **`window.__sessionHandle`** (`getLocalPlayerPose`, `setMovementInput(fwd,strafe,turn,run)`, `sendChat`, `createTestCharacter`, `playerStats`). `getLocalPlayerPose()` returns a wasm-bindgen object — read `.x/.y/.z/.heading/.landblockId` **inside** `page.evaluate`, never return it across the boundary. Drive movement via synthetic `KeyboardEvent("keydown/up", {key:"w"})` on `document`; let the 60 Hz rAF tick it. `@telepoi Holtburg` to reach baked geometry. gap-2 A/B via runtime toggle `window.__predPureSmooth`.
   - Working scripts: `/tmp/physics-local-validate.cjs`, `/tmp/physics-create-lowrun.cjs` (reference; recreate if cleaned).

---

## 6. Key references

- Deep-dive package: `external/holtburger/newprompts/physics-deep-dive-2026-06-01/` (GUIDE + verified report + cross-codebase index + prompts).
- ACE retail port: `external/ACE/Source/ACE.Server/Physics/` (Transition.cs, Sphere.cs, PhysicsObj.cs, Managers/InterpolationManager.cs); decompiled retail: `~/ac-headers/acclient.c`.
- Memory: `project_physics_retail_parity_2026-06-02.md`, `reference_cloudflare_wire_agent_validation.md`, `reference_physics_deep_dive_handoff_2026-06-01.md`.
- **Hard rule:** 1070 testing is invisible-only (off-screen/headless) per the user's standing rule, except when the user explicitly opts in for a session.
