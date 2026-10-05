# Holtburger Physics — Tier-4 / Calibration / BSP-M2 Handoff

**Date:** 2026-06-02 (session 2, afternoon)
**Branch:** `feat/tier4-physics-followups` → **fast-forwarded to `master`, pushed to origin `salvia420-bit`** (HEAD `cfb07af1`).
**Predecessor:** `newprompts/physics-tier3-4-handoff-2026-06-02.md` (the run-issue + tier-4 remaining-work map).

---

## 0. One-paragraph status

The predecessor handoff's **§2 RUN ISSUE is FIXED and live-verified**, and fixing it **exposed a run-speed calibration bug which is also fixed** (flag-gated, live-validated). On top of that, the four deferred tier-4 movement/collision items + the two InterpolateTo nits all landed flag-gated DEFAULT-OFF, and the **BSP resolver is started** (M0/M1 foundations + M2/M2b primitives). **11 commits, all green, all new behavior DEFAULT-OFF (shipped solver byte-identical).** What remains is collision-solver depth (the BSP placement *loop* = M3/M4, which needs the Transition/SpherePath context) + one open *magnitude* question on the calibration fix + the `precipice` item (spec-ready, deliberately not applied).

---

## 1. Commit map (all on master now)

| Commit | What | State |
|---|---|---|
| `a1c265df` | **fix: hydrate local player entity from its self-CreateObject** | the headline; live-verified |
| `691a1aa0` | tier-4: CalcNumSteps 3D-distance (`USE_CALCNUMSTEPS_3D_DIST`) | default-off |
| `3346779a` | tier-4: outdoor building-wall normals (`USE_OUTDOOR_WALL_NORMALS`) | default-off |
| `8740526b` | **BSP M0** — `spatial/collision.rs`: TransitionState enum + PhysicsGlobals consts | inert |
| `05a788a6` | **BSP M1** — sphere math (`find_time_of_collision`, `collides_with_sphere`) | inert |
| `642e5055` | **calibration**: `normalize_run_speed_to_scalar` (base→1.0) | flag, live-validated |
| `37f96d1e` | tier-4: cliff_slide intra-substep (`USE_CLIFF_SLIDE_INTRA_SUBSTEP`) | default-off |
| `529fed04` | tier-4: wire `keep_heading` into force-position interp (slerp) | dormant |
| `6fbba657` | tier-4: wire force-position interpolator into the hot-loop | default-off |
| `7a24d3d5` | **BSP M2** — `sphere_intersects_solid_poly` (per-poly solid query) | primitive |
| `cfb07af1` | **BSP M2b** — `adjust_to_placement_poly` (sphere displacement) | primitive |

Tests: holtburger-dat 260, holtburger-core 280, holtburger-world 336 — all pass. wasm32 check of holtburger-web clean.

---

## 2. THE RUN-4.5 BUG — ROOT CAUSE & FIX (read this)

The predecessor handoff's §2 mis-diagnosed this as a skills/`player_run_rate` hydration gap. **Actual root cause (live-confirmed):** the recv-loop `ObjectCreate` arm at `apps/holtburger-web/src/lib.rs:~28714` **bare-seeds the local player entity** (`Entity::new(guid,"LocalPlayer",pos)`, position only) and — unlike every other entity (`handlers/inventory.rs:32`) — **never calls `apply_description`**. So the player's `MotionTable`/`Setup` (carried in the self-CreateObject ODD) were discarded → entity stayed `flags=0x0`/all-None → `resolve_player_motion_table_profile` returned `MotionTableSourceUnavailable` → the movement watchdog (`lib.rs:~33842`) re-installed a hardcoded **4.5 m/s fallback `SelfMovementCapabilities` override** every tick → `resolve_self_movement_capabilities` short-circuits on that override BEFORE `player_run_rate` runs (which is why the predecessor's `3310cab0` "derive Run from Quickness" had zero observable effect). **Fix (`a1c265df`):** one line — `entity.apply_description(&data)` in that branch. Live-verified: `motion_table_profile` MotionTableSourceUnavailable→OK, entity gains `mtable=0x09000001`/`csetup=0x02000001`, watchdog stops firing, run speed resolves from real data on both existing AND fresh `createTestCharacter` chars.

## 3. CALIBRATION — fixed, but ONE OPEN MAGNITUDE QUESTION

Fixing §2 exposed run = **7.79 m/s** (= `base_run_forward_speed × run_rate_scalar`). The base (~1.7–4.1) is a **bake artifact**: motion table `0x09000001` has ZERO raw cycle velocity (DAT-dump confirmed), but `apps/holtburger-tools/src/dat2hba.rs:444 derive_animation_forward_speed` injects a frame-displacement velocity. **Fix (`642e5055`):** `WorldState.normalize_run_speed_to_scalar` (DEFAULT-OFF) — when on, `resolve_self_movement_kinematics` normalizes `base_run_forward_velocity` to unit length so `resolved_manual_run_speed` returns `run_rate_scalar` directly (the handoff's "final = run_rate" model).

**LIVE A/B (flipped on, wasm rebuilt, wire-agent, reverted):** OFF → **7.1 m/s**, ON → **1.899 m/s** (= this char's `run_rate_scalar` ≈ 1.9; it is NOT maxed). The fix mechanically works AND makes a low-skill char run slow → **this unblocks the predecessor's "dramatic gap-2 A/B"** (legacy JS predictor 4.5 vs integrator 1.9). **⚠️ OPEN:** whether **~1.9 (flag-on, "rate is the speed") or ~7.6 (flag-off, "RunAnimSpeed × rate")** is retail-correct is UNRESOLVED — no retail reference measurement, and the deep-dive vs an acclient reading disagree. **It stays DEFAULT-OFF until a real retail run-speed reference settles it.** That settle is the highest-value next investigation. (acclient: `MovementSystem::GetRunRate` decl `acclient.c:14507`, def `~:713790`; ACE `Physics/Animation/RawMotionState.cs:75` `ForwardSpeed = movementParams.Speed`.)

---

## 4. Tier-4 flags (all DEFAULT-OFF — shipped solver unchanged)

| Flag | Item | Live A/B |
|---|---|---|
| `USE_CALCNUMSTEPS_3D_DIST` (physics.rs) | substep count on 3D dist vs lateral-XY | smoke-validated smooth |
| `USE_OUTDOOR_WALL_NORMALS` (system.rs) | outdoor building-clamp surfaces wall normal → edge/cliff-slide fire outdoors | smoke-validated |
| `USE_CLIFF_SLIDE_INTRA_SUBSTEP` (physics.rs) | seam-skid INSIDE the substep loop (N_last/N_new) | smoke-validated |
| `USE_RETAIL_INTERPOLATE` (scene.rs:65) | force-position stepper now WIRED into the hot-loop (matches InterpStep, updates pose); `keep_heading` now actually drives rotation (slerp) | smoke-validated |

**Smoke test caveat:** the 5-flags-on wire-agent run-around (at 1.9 m/s) showed NO rubberbanding/hitches/panics, but it was light — a real per-feature A/B at full speed + edge cases is still owed. NOTE the tier-4 substep flags only fire when `USE_SUBSTEP_TRANSITION` (pre-existing, default-off) is ALSO on.

## 5. BSP resolver — STARTED (M0/M1/M2/M2b), M3/M4 next

- **M0** (`crates/holtburger-world/src/spatial/collision.rs`): `TransitionState{Invalid,OK,Collided,Adjusted,Slid}` + `physics_globals` consts. Inert scaffolding.
- **M1** (`crates/holtburger-world/src/spatial/physics.rs`): `find_time_of_collision` (swept-sphere quadratic, earliest root `(B−√(B²−aC))/a`) + `collides_with_sphere`. (The drafted port had a sign-bug returning −1 for head-on hits; fixed.)
- **M2** (`crates/holtburger-dat/src/physics.rs` `7a24d3d5`): `BspNode::sphere_intersects_solid_poly` — faithful port of ACE `BSPNode.cs:295-325` + `BSPLeaf.cs:93-112`; mirrors the existing `sphere_intersects_solid` walk but threads out `center_solid` + `hit_poly`. **Rejected the spec's "return Vec of all hits" — ACE finds ONE poly then re-queries in the loop.**
- **M2b** (`cfb07af1`): `ResolvedPolygon::adjust_to_placement_poly` — ACE `Polygon.cs:116-126` sphere displacement.
- **M3/M4 (NOT done) = the placement *loop*** (`BSPTree.cs:242-292 placement_insert`): repeatedly query → `adjust_to_placement_poly` → widen radius, up to 20 iters, returns TransitionState. It needs the **Transition/SpherePath collision context** (two-sphere cylinder `validPos`/`validPos_`, `BuildingCheck`/`HitsInteriorCell`, `placement_insert_inner`) which does not exist yet — that context IS M4. The two M2 primitives are everything the loop CALLS; the loop's orchestration + context is the next focused effort.

---

## 6. Remaining work (prioritized)

1. **Settle the calibration magnitude** (~1.9 vs ~7.6) against a real retail run-speed reference, then set `normalize_run_speed_to_scalar` default accordingly. Cheapest high-value item.
2. **Per-feature live A/B** of the 4 tier-4 flags (+ `USE_SUBSTEP_TRANSITION`) at full speed / edge cases, then flip the validated ones on.
3. **`precipice-stepdown-backup`** — a workflow produced a `ready`-verified spec (save/restore_check_pos + step-down walkable re-entry behind a new default-off flag, grounded in real `PlayerState`/`SpatialBody` types) but it was deliberately **NOT applied** (complex hot-loop backup-pose; deserves a careful read). Spec is in the session transcripts.
4. **BSP M4** — stand up the Transition/SpherePath collision context, then the `placement_insert` loop (M3) on top of the M2 primitives.

---

## 7. Build / validate / gotchas

- **MEMORY-SAFE BUILD (the box OOMs):** `cd external/holtburger && export PATH="$HOME/.cargo/bin:$PATH" HOLTBURGER_PORTAL_DAT=/home/wbterminal/ac_base_dats/client_portal.dat CARGO_BUILD_JOBS=2`. Test PER-CRATE: `cargo test -j2 -p holtburger-dat --lib` / `-p holtburger-core --lib` / `-p holtburger-world --lib`. **NEVER `cargo test --workspace`**, and **do NOT `cargo test` 3 crates + examples at once** — it OOMs the linker / fills the disk. wasm: `CARGO_BUILD_JOBS=1 nice -n 12 wasm-pack build apps/holtburger-web --target web --out-dir pkg --release` (~4 min; served dir is `pkg/`).
- **⚠️ DISK FILLS:** `/dev/sda2` hit **100%** this session (`target/debug/{deps 22G, incremental 13G, examples 2G}`). `rm -rf target/debug/{examples,incremental}` reclaimed ~15G. Watch `df -h .` before big builds; a full disk shows up as `cc linking failed` / `No space left on device (os error 28)` — NOT a code error.
- **LIVE wire-agent (no 1070):** Playwright chromium → `http://127.0.0.1:8765/...?wireframe=1&hud=none&plugins=none&nullRender=1&diag=1&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first&kickDance=1`. `nullRender=1` mandatory. ACE is UP (UDP 9000/9001, dotnet at `~/ace-server/.../net10.0`). `NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules` for `require("playwright")`. Scripts left in `/tmp/`: `flag-validation.cjs`, `runspeed-diag-existing.cjs`, `runspeed-diag-confirm.cjs`.
- **Served bundle:** the local dev `pkg/` may still have the validation flags compiled ON (the *source* is reverted/default-off). Rebuild `pkg/` if you need the local server back to default.

## 8. Workflow-vs-direct lesson (process note)

Read-only Claude workflows (spec + adversarial-verify) are good for parallel **research / review** and DID catch real errors before they shipped (the 18 m/s calibration mis-fix, 3 broken reworks). But on this build-heavy box they **cannot compile-verify** — so every spec still needed a serial build in the main loop, which is exactly where the **M1 sign-bug** and the **M2 "Vec" divergence** were caught. Verdict: for build-gated implementation, **work directly** (read ACE source → port → build → test); reserve workflows for genuinely parallel read-only work.

## 9. Key references

- ACE BSP: `external/ACE/.../Physics/BSP/{BSPTree,BSPNode,BSPLeaf}.cs`, `Physics/Polygon.cs`, `Physics/Sphere.cs`. Retail: `~/ac-headers/acclient.c`.
- Predecessor: `newprompts/physics-tier3-4-handoff-2026-06-02.md`; deep-dive: `newprompts/physics-deep-dive-2026-06-01/`.
- Memory: `project_physics_retail_parity_2026-06-02.md` (updated with all of the above), `reference_cloudflare_wire_agent_validation.md`, `reference_external_drive_layout.md` (disk).
