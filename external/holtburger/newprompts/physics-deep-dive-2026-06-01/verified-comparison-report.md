# Verified Comparison Report — Holtburger Physics vs. Decompiled Retail AC / ACE

**Date:** 2026-06-01
**Method:** 5 broad Explore agents (first pass) → targeted source verification → a 2-phase adversarial workflow (7 deep investigators + ~40 skeptical verifiers, each tasked to *refute*).
**Verdict tally:** 44 confirmed · 13 partially-correct · 0 refuted.
**Evidence:** `artifacts/deep-dive-claims-digest.txt` (per-claim verdicts + corrections), `artifacts/workflow-full-result.json` (raw).

> ACE (`external/ACE/Source/ACE.Server/Physics/`) is a faithful 1:1 C# port of the retail physics engine and is used throughout as the readable proxy for the decompiled `acclient.c`. Where they were cross-checked, retail `acclient.c` line numbers are given too.

---

## Architecture in one picture

```
                 RETAIL / ACE                          OURS
            ┌────────────────────┐        ┌──────────────────────────────────┐
            │  single CPhysicsObj │        │  Rust/wasm authoritative          │
            │  - predicts         │        │  integrator (system.rs)           │
            │  - absorbs server   │        │  - owns Z, heading, gravity,      │
            │    corrections on   │        │    collision, friction            │
            │    the SAME store   │        │  - speeds: MotionTable-derived    │
            │  - InterpolateTo /  │        └──────────────┬───────────────────┘
            │    ConstrainTo      │            Z + heading │  (getLocalPlayerPose)
            └────────────────────┘                        ▼
                                             ┌──────────────────────────────────┐
                                             │  JS dead-reckon predictor          │
                                             │  (camera.js / index.html)          │
                                             │  - owns rendered X/Y               │
                                             │  - flat RUN=4.5 / WALK=1.0         │
                                             │  - 150ms reconcile lerp            │
                                             └──────────────────────────────────┘
```

Retail has **one** integrator that both predicts and reconciles. We have **two**, split by axis (Z+heading from Rust, X/Y from JS), with a third dead-code speed source in the wasm bundle.

---

## Dimension 1 — Integration loop  ·  DIVERGENT · impact HIGH

**Confirmed.** Our authoritative integrator consumes the **raw, unbounded per-frame rAF `dt`** (`handle.rs:96`, computed as `now.saturating_duration_since(prev)` — only a backward-time sign guard, no magnitude clamp) and performs exactly **one** integration step per frame.

ACE's `update_object` (`PhysicsObj.cs:4140-4190`) instead:
- gates entry on `deltaTime < TickRate` (`TickRate = 1/30`),
- **subdivides every frame into ≤0.1 s slices**: `while (deltaTime > MaxQuantum) { UpdateObjectInternal(MaxQuantum); deltaTime -= MaxQuantum; }` (`MaxQuantum = 0.1`),
- floors the remainder at `MinQuantum = 1/30`,
- **drops the whole frame** if `deltaTime > HugeQuantum = 2.0`.

We have none of these guards. Practical consequence (confirmed): a tab-refocus / GC / Playwright-throttle hitch over-integrates a fall in one giant unclamped step (this is the documented "~25 m/s overshoot").

**Also confirmed in this dimension:**
- **First-order symplectic Euler** (`system.rs:936-939`): `vertical_velocity -= 9.8*dt; z += vertical_velocity*dt`. Velocity is updated first, then position uses the *new* velocity — and the `0.5·a·t²` position term is absent. ACE uses `movement = Acceleration*0.5*q² + Velocity*q; … Velocity += Acceleration*q` (`PhysicsObj.cs:1854-1858`, in `UpdatePhysicsInternal`) — position uses the *old* velocity plus the half-step. Magnitude of our error: sub-cm/tick at 16 ms, acknowledged in-code (`system.rs:932-934`).
- **Gravity applied to velocity, not acceleration.** Retail sets `Acceleration.z = -9.8` via `calc_acceleration` when the GRAVITY state flag is set (`PhysicsObj.cs:2079-2080`), so gravity flows through the 2nd-order term. Ours never carries gravity in an acceleration vector — already documented as a known gap at `common.rs:360-398`.
- **No terminal-velocity clamp.** ACE clamps total velocity magnitude to `MaxVelocity = 50` every quantum inside `UpdatePhysicsInternal` (`PhysicsObj.cs:1843-1846`). Ours never clamps `vertical_velocity` — a long fall accelerates unbounded.
- The only `dt` clamp on our side (`Math.min(dt, 0.1)`) lives in the **JS dead-reckon predictors only** (`camera.js`, `index.html:10013`), is planar-only, and does **not** gate the authoritative Rust integrator.

**Open Q:** does ACE's server reconciliation snap the over-integrated client pose back often enough that the missing guards never produce a *user-visible* desync? The client integrator only feeds the AutonomousPosition heartbeat — needs a live capture.

---

## Dimension 2 — Collision / transition solver  ·  DIVERGENT · impact HIGH

**Confirmed.** A flat, single-pass geometric clamp-and-slide, structurally far simpler than retail's `CTransition` + `SpherePath` + per-cell BSP.

- **No BSP.** Buildings: swept-sphere vs inflated AABB. Cell walls: one mid-height swept-circle vs a flat triangle bag with an AABB pre-cull (`clamp_delta_against_cell_walls`, `spatial/physics.rs:393-511`) — explicitly *not* a BSP and *not* a full swept-capsule test. Retail walks `CellStruct.PhysicsBSP.find_collisions` with up to 2 spheres (low+high) forming a cylsphere. (We have a `HAS_PHYSICS_BSP` flag for *entity* GfxObj collision but it "currently falls through to cylinder" — `entity_collision.rs:27-29`, unwired.)
- **No `step_up` / `step_down` / `edge_slide` / `cliff_slide`** anywhere in the movement/collision path. These four give retail stair-climbing, curb-stepping, ledge edge-sliding, and cliff-sliding. **Crucial detail:** `setup_model.rs` *does* parse `StepUpHeight`/`StepDownHeight` from Setup.dat — **the data is read and then ignored** by the solver. ACE step heights: `DefaultStepHeight=0.01` global, `0.039999999` non-walkable fallback, else `Setup._dat.StepUpHeight*Scale.Z` (`PartArray.cs:240-247`). We also parse `PhysicsState::EDGE_SLIDE (0x00400000)` → `PropertyBool::AllowEdgeSlide` (`object.rs:78`) and never consult it.
- **Walkable-slope threshold diverges:** our floor classifier accepts `normal.z ≥ 0.5` (≤60° slope) as floor; retail `is_valid_walkable` requires `normal.z ≥ FloorZ = 0.66417` (≤48.4°). We let players stand/walk on steeper inclines. (Verifier scoped this to the indoor `highest_floor_z_under` helper; there's also a `0.5..0.7` band where a tri is floor for the Z-snap but not wall-clamped laterally — possible seam, unverified in-world.)
- **Single-iteration slide** (`remaining - normal*(remaining·normal)`, once for buildings, once for cell walls). Retail substeps the whole transition via `CalcNumSteps = ceil(dist/sphereRadius)` and slides via a contact-plane cross-product skid, iterating insert→collide→slide per step — handling concave corners and fast motion we can tunnel/jitter through. Indoors we additionally hard `.clamp()` global X/Y into a radius-inset cell AABB (`clamp_delta_to_cell_interior`, `physics.rs:205-255`) — cruder than a slide.
- **Indoor floor pop:** in the AABB-present-but-triangles-not-yet-baked window, Z snaps to `cell_aabb.min.z + 0.005` (`system.rs:1031-1034`), popping the player to the cell's lowest floor on ramped/multi-level cells until triangles arrive. (When *neither* AABB nor triangles exist, lateral motion is frozen to zero and Z-snap is skipped — `system.rs:746-752,1022-1026`.)
- Entity collision is **2D cylinder-vs-cylinder, Z ignored** (`entity_collision.rs:44-60`); retail CylSphere is height-aware.

**Gameplay-visible net:** no stair climbing (any riser blocks you — there is no step-up at all), no smooth edge-sliding off ledges, coarser slope walkability, indoor pop-to-AABB-floor on ramps.

**Open Q:** the precise per-human Setup `0x02000001` StepUpHeight (commonly cited ~0.1 m) needs a DAT dump to pin the magnitude of the stair gap.

---

## Dimension 3 — Friction & grounded smoothing  ·  FORM MATCHES, MODEL DIVERGES · impact HIGH

**Shared (confirmed):** the decay *form* `v *= pow(1-f, quantum)` gated on grounded, and the `0.25` small-velocity snap (`SmallVelocity`).

**Diverges:**
- **Coefficient `0.5` vs `0.95`** (`common.rs:374` vs `PhysicsGlobals.cs:15`). Coefficient ratio 1.9×; **per-tick velocity-loss ratio ~4.2×** (at 60 Hz: 1.15% vs 4.87% lost/tick). The 0.5 is a deliberate softening, documented as compensation for skipping retail's explicit acceleration step. *(Open Q below questions whether that compensation is even needed.)*
- **8 m/s² lateral accel cap (`common.rs:405`) — retail has no equivalent.** Retail smooths purely via friction + `Acceleration*quantum`. Our cap is gated to the grounded branch; airborne we pass target velocity straight through, which *matches* retail's instant-air behavior.
- **We skip retail's contact-plane projection entirely.** Retail computes `angle = dot(Velocity, ContactPlane.Normal)`, early-returns if `angle ≥ 0.25`, then removes the into-surface component `Velocity -= Normal*angle` *before* damping (`PhysicsObj.cs:2124-2127`). We damp scalar X/Y against an implicit flat horizontal plane. On flat ground this is a near no-op; only matters on slopes.
- **Sledding branches omitted:** retail overrides friction to `1.0` when `velocity_mag2 < 1.5625` and to `0.2` when `≥ 6.25` on a near-flat slope (`Normal.Z > 0.99999536`). We have a single fixed `0.5`.
- The JS predictor has **no friction at all** — constant-velocity extrapolation that stops instantly on key-release.

**Open Q (important):** the in-code rationale for `0.5` claims applying `0.95` directly would cause a 25-35% steady-state speed deficit because we skip retail's acceleration step. But if retail's `apply_raw_movement` re-sets velocity to the full input target *every tick before friction*, then `0.95` only ever damps the single-tick residual and would NOT cause a deficit — meaning **our `0.5` may be over-corrected.** The `apply_raw_movement`/`set_velocity` path in `acclient.c` was not traced. Resolve this before tuning friction.

---

## Dimension 4 — Jump / fall / landing  ·  FORMULAS BIT-FAITHFUL · impact HIGH

**Confirmed 1:1 ports:**
- `compute_jump_velocity_z` (`player/types.rs:715`) == `MovementSystem.GetJumpHeight` + `InqJumpVelocity`: `burdenMod·(skill/(skill+1300)·22.2+0.05)·power`, floor `0.35`, then `√(h·19.6)` (`WeenieObject.cs:73-98`). (We hardcode the always-1.0 `scaling` divisor; every live ACE caller passes 1.0.)
- `burden_mod` == `EncumbranceSystem.GetBurdenMod` (1.0 / 2.0−burden / 0.0).
- `compute_fall_damage` == `Player_Move.HandleFallingDamage` verbatim: `jumpV=11.25434`, `overspeed = jumpV + currVz + 4.5`, `ratio = -overspeed/jumpV`, `damage = ratio·87.293810` (`Player_Move.cs:254-271`). **NOT invented.**

**Diverges:**
- **`compute_fall_damage` has zero production callers** (`types.rs:643-650` — documentation-only). All fall damage deferred to the server. Deliberate.
- **No Jump animation clip.** `MotionCommand JUMP = 0x2500003B` is a wire/enum constant set by `begin_jump` (`types.rs:738`) — but a live `jump_clip_data_check.rs` run against the real `client_portal.dat` returns `OVERALL=FAIL`: **0 of 436 motion tables contain a `0x003B` entry.** The arms-up jump visual is a quaternion `setAirborne` overlay, matching Joe Trevis's note (retail had a combined arms-up jump/fall, not a discrete clip).
- **`begin_jump`/`begin_fall`/`land` + `is_airborne`/`is_jumping` + `Falling(0x40000015)`/`Fallen(0x40000008)` emission** is an invented client-side visual state machine; retail carries only a single `InterpretedState.ForwardCommand` with `set_on_walkable(false)`/`LeaveGround` and no Falling/Fallen broadcast. The double-jump gate (`is_airborne` short-circuit) substitutes for retail's gravity-state/JumpExtent gating.
- Gravity integration differences as in Dimension 1 (symplectic Euler, no terminal clamp).
- `LEDGE_FALL_THRESHOLD_M = 0.5` (walk-off detection) is a wasm heuristic tied to the 24 m terrain-heightmap sample spacing; retail uses continuous collision and has no equivalent — admitted game-feel constant.

---

## Dimension 5 — Dual-predictor architecture  ·  DIVERGENT · impact HIGH

**Confirmed.** Two independent forward integrators for the local player; retail has one `CPhysicsObj.Position` that both predicts and absorbs corrections.

- **Axis split:** rig X/Y from JS `predictedPlayerPos`; Z + heading from the wasm integrator (`loop.js:260-274`). `_advancePrediction` (`camera.js:1060-1069`) mutates only `.x`/`.y`.
- **The JS predictor structurally cannot match the integrator's speed:** `getLocalPlayerPose()` exports only `{x,y,z,heading,landblockId}` — **no velocity field.** So JS reads integrator heading but guesses speed from its own constants.
- **Speed mismatch (partially-correct, corrected):** JS advances at `RUN_SPEED = FALLBACK_RUN_RATE_SCALAR ?? 4.5`. The genuine bug is JS using `4.5` *directly as final m/s* with no base-velocity multiply, never consulting skill/burden. Rust/retail = `base_run_velocity × run_factor`. Real mismatch ≈ 4.5 vs ~2.5 (**~1.8×**, not the 4.5× first claimed; "1.0" is a *scalar*, not m/s).
- **Behavior (corrected):** not a sinusoidal oscillation — a **sustained bounded forward bias with per-frame sawtooth**, predicted staying *ahead* of the server pose, opposed each frame by the 150 ms lerp. "Steady-state forward lag/fight." Retail's single predictor cannot produce this.
- **Camera Z lags rig Z on hills:** camera height reads the lagging `predicted.z` (only updated by the lerp, never integrated) via a 4-hop indirection; rig Z uses the live integrator z (clamped to `getTerrainVisualZ` Catmull-Rom raycast, `loop.js:285`).
- `WALK_SPEED=1.0`/`RUN=4.5` are **live shared constants** from `window.__movementConstants` (set in `index.html`), with `camera.js ?? 4.5/?? 1.0` as a reachable-but-equal defensive fallback during the boot race — **not stale.**
- `get/set_last_client_prediction` are a **Wave-3.F diagnostic shadow only** (consumed by `diag/physics.js` + validators), fed by the 2D rAF loop — **not the render path.**

**Open Q:** does the real player MT `0x09000001` have `base_run_forward_velocity ≈ 1.0` (making 4.5 numerically right only for capped players) or ~2.5? Needs a DAT dump. And: does ACE's server advance the local pose at the skill-derived rate, or accept the client's faster heartbeat (no force_position)? `index.html:5934-5946` implies ACE "happily accepts our heartbeats" at low Run — needs a wire capture to settle whether the lerp target is fast or slow.

---

## Dimension 6 — Motion velocity source  ·  MOSTLY MATCHING · impact MEDIUM

**The big correction:** "ours DAT-derived vs retail hardcoded 4.0/3.12" is half a red herring. **Both** systems are DAT-velocity-driven for *grounded* motion (ACE: `motionData.Velocity * speedMod` into the Sequence → `frame.Origin += Velocity*quantum`). Retail's `RunAnimSpeed=4.0/WalkAnimSpeed=3.12/SidestepAnimSpeed=1.25` live in `get_state_velocity`, whose **sole caller** is `get_leave_ground_velocity` (`MotionInterp.cs:656`; `acclient.c:343821`) — jump take-off + a max-speed clamp, **not** steady-state walking. *(Those constants are also referenced by `get_max_speed`/`adjust_motion` as clamps, but never for per-tick grounded speed.)*

**Confirmed matches:**
- `run_rate_from_skill_and_burden` == `GetRunRate` (4.5 @ skill≥800, else `(loadMod·(runSkill/(runSkill+200)·11)+4)/4`).
- **Walk→run motion-code swap** (`forward_command_for_state`): `RUN_FORWARD 0x44000007` for (Run,Forward), `WALK_FORWARD 0x45000005` for (Walk,Forward) — mirrors `acclient.c apply_run_to_command` rewriting `0x45000005 → 0x44000007` when speed>0 & HoldKey=Run. Distinct DAT clips, not speed variants. ✅
- **Diagonal = geometric sum** of forward+sidestep slots == retail's additive `Sequence.CombinePhysics` (`Velocity += velocity`). Combined magnitude can exceed each axis cap (√2 for walk+strafe) in both. ✅ *(medium-confidence; see open Q on whether retail's per-axis `set_motion` clears the other axis — could make retail NOT produce a true diagonal.)*
- **±3.0 sidestep run cap** == `MaxSidestepAnimRate=3.0` / `acclient.c apply_run_to_command` case `0x6500000F`. ✅

**Diverges:**
- **No `get_state_velocity` magnitude clamp** on our composed diagonal — only sidestep is capped, forward is uncapped. (Retail's clamp is on the leave-ground/jump path, so this primarily affects jump take-off fidelity.)
- **Backstep bug:** `forward_axis_speed` returns bare `run_rate_scalar` (~4.5) for (Run,Backstep) and `1.0` for (Walk,Backstep). Retail backstep = `WalkAnimSpeed·(-BackwardsFactor)` (3.12·0.65 ≈ 2.03) and **IS run-scaled** (speed × run_factor; there's no Run*Backward* clip but the magnitude is scaled). We misuse the dimensionless multiplier as raw m/s.
- **JS predictor + a dead-code wasm path** (`build_raw_motion_state_for_input`, `#[allow(dead_code)]`) hardcode `4.5`/`1.0` — a third inconsistent speed source ignoring per-player run_rate and the MotionTable.

**Open Q:** the real DAT cycle-velocity magnitude (Dimension 5 open Q) decides whether grounded speeds actually equal retail. Also unverified: whether retail's per-axis `set_motion` (which calls `clear_physics()`) overwrites the other axis instead of accumulating — would turn our "diagonal match" into a divergence.

---

## Dimension 7 — Server reconciliation  ·  CONTRACT FAITHFUL, MECHANISM DIVERGES · impact HIGH

**Confirmed matches:**
- 1 s AutonomousPosition heartbeat cadence; four sequence stamps (instance / server-control / teleport / force-position).
- **Client-authoritative-with-veto** (autonomy_level==2): we send our own runtime pose and only accept newer server force/teleport corrections — matches retail and ACE `UpdatePlayerPosition` (`Player_Tick.cs:411-491`, `SetRequestedLocation` `Player_Networking.cs:300`). Same veto helper backs the non-autonomous path too (`player/mutations.rs:246`).
- Sequence-gating (teleport-epoch then force-position newer-wins) is a faithful port of `SmartBox::HandleReceivedPosition` (partially-correct: retail's boolean composition + slot-advance-on-skip side effect differ slightly; retail's teleport-vs-interpolate decision is in inner `newer_event` calls, ours collapses to one outer accept/reject).

**Diverges:**
- **Force-position never smoothly reconciles, and never corrects the wasm working pose.** Retail uses `PositionManager.InterpolateTo`/`ConstrainTo`; only teleport zeroes velocity & hard-sets. Ours: `set_player_position` (`mutations.rs:606`) uses **Snapshot mode** — when mid-simulation it *preserves* the runtime pose (`scene.rs:1230-1246`); when idle (`AuthoritativeOnly`) it hard-snaps `body.pose = pose` (`scene.rs:1243`). Neither InterpolateTo's.
- **Snap thresholds not retail-matched / not indoor-aware.** Retail uses autonomy-blip distances of 25 m indoor / 100 m outdoor + 5/10 m constraint-leash + a 0.05 m InterpolationManager dead-band. Our only visual correction is a JS 5 m hard-snap-else-150 ms-lerp.
- **Heartbeat is unconditional** — fires every 1 s whenever a sync target exists, re-asserting a possibly-drifted pose. Retail only sends when position changed since `last_sent_position` (`Frame::is_equal` + a contact-plane-change sub-branch). (Our heartbeat does snap Z to the cached terrain heightmap first, `system.rs:1419-1435`, so Z isn't garbage — but X/Y can be stale.)
- **Local vs remote asymmetry:** remote entities get a hard authoritative reset on force-position (`EntityPositionSyncOutcome::Reset → reconcile_authoritative_body(Reset)`, `scene.rs:1244`); the local player's force-position updates `authoritative_pose` and emits a `ForcedReposition` WorldEvent **without snapping the integrator's working pose** — so the wasm authoritative state is never corrected by a sub-snap rubberband; convergence depends solely on the JS layer.

**Corrected:** the local-player teleport snap is **landblock-ID-crossing-gated** (`index.html:5960-5968`), not the "5 m" rule; wasm reconciliation is sequence-gated. `TeleportPlayer` itself doesn't zero velocity (the caller `SmartBox::HandleReceivedPosition` does, `145203-145206`).

**Open Q:** does a sub-5 m force-position ever correct the wasm working pose, or does the Snapshot-preserve + unconditional-heartbeat loop leave a persistent small-drift oscillation? No code path found that snaps the local integrator back to a sub-snap forced position. Needs a live rubberband capture.

---

## Closing assessment

A **retail-accurate core** (jump, fall-damage, friction *form*, motion architecture, run-rate, walk→run swap, sidestep cap — all sourced and unit-tested against ACE/`acclient.c`) wrapped in **browser concessions**: a gentler hand-tuned grounded friction, a legacy JS smoothing layer, and a simplified collision/reconciliation path. The true gaps versus the decompiled client are concentrated in the **integration loop, collision solver, and reconciliation mechanism** — not the movement *parameters*. See `GUIDE.md §2` for the prioritized fix list and `PROMPTS.md` for ready-to-run tasks.
