# Ready-to-Run Task Prompts — Physics Fidelity Work

Copy-pasteable prompts for future agents (or the user), one per prioritized gap from `GUIDE.md §2`. Each is seeded with the verified file:line pointers so the agent starts at the code, not at a blank search. Tackle them roughly in order — **#1 unblocks honest A/B testing of the rest.**

Before starting any of these, read `GUIDE.md` (esp. §3 "do not repeat these mistakes") and skim `verified-comparison-report.md` for the relevant dimension. All paths are relative to `OURS = /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger` unless prefixed.

> ⚠ **1070 testing is invisible-only** (off-screen/headless, no window/focus/input steal — a person uses that box). Use `?wireframe=1&autoLogin=1...` + `window.__diag`. See memory `[1070 tests NEVER on screen]`, `[wire agent mode]`.

---

## §1 — Port ACE's quantum-subdivide integration loop  ·  HIGH · medium effort  ·  DO FIRST

```
Goal: Make our authoritative wasm integrator integrate like retail/ACE — bounded, subdivided timesteps with a terminal-velocity clamp — instead of one raw unbounded Euler step per rAF frame. This fixes frame-hitch fall over-integration and puts the integration loop on retail's exact footing.

Read first:
- OURS crates/holtburger-core/src/client/movement/handle.rs:96-122 (raw dt = saturating_duration_since, no clamp)
- OURS crates/holtburger-core/src/client/movement/system.rs:597-721 (advance_local_pose_for_manual_drive) and :936-939 (gravity step)
- ACE external/ACE/Source/ACE.Server/Physics/PhysicsObj.cs:4140-4190 (update_object: TickRate gate, MaxQuantum while-subdivide, HugeQuantum skip, MinQuantum remainder) and :1832-1860 (UpdatePhysicsInternal: 0.5*a*q^2+v*q, MaxVelocity=50 clamp)
- ACE PhysicsGlobals.cs:38-43 (MinQuantum=1/30, MaxQuantum=0.1, HugeQuantum=2.0), :30 (MaxVelocity=50)

Implement:
1. In the wasm integrator tick, wrap advance_local_pose_for_manual_drive in a clamp-and-subdivide loop: if dt > HugeQuantum (2.0s) skip the frame; else while remaining > MaxQuantum (0.1s) integrate a 0.1s slice and decrement; integrate the remainder if > MinQuantum (1/30s). Gravity, friction, and collision all run per-slice (friction is pow(1-f,quantum) per slice, which composes correctly).
2. Add a terminal-velocity clamp (|velocity| <= 50 m/s) in the integration step.
3. Keep the changes behind a flag if risk-averse (e.g. a const or build feature), default ON, with the old single-step path available for A/B.

Constraints / gotchas:
- These constants must be defined ours-side (don't reach into ACE). Mirror PhysicsGlobals values.
- Do NOT also "fix" the JS dead-reckon predictor's Math.min(dt,0.1) — that's a separate planar predictor (Dimension 5); leave it.
- The grounded friction coefficient stays 0.5 for now (that's a separate, contested decision — see §3-friction open question; don't bundle it).
- Add/extend unit tests: a 2-second simulated hitch should produce a bounded fall, not a teleport; verify subdivision count.

Verify: run the physics-replay harness (capture_physics_replay.cjs / validate_physics_replay.cjs --subject=prediction) and confirm maxDrift stays in the 0.04-0.09m band that Wave 3.F established; confirm a synthetic long-dt frame no longer over-integrates.
```

---

## §2 — Plumb integrator speed to the JS predictor (kill the sawtooth)  ·  HIGH · medium

```
Goal: Eliminate the dual-predictor speed mismatch. The JS dead-reckon advances rendered X/Y at a flat 4.5 m/s while the Rust integrator moves at the real skill-derived speed (base_run_velocity * run_factor, ~2.5 m/s for a low-Run char). The JS predictor structurally can't match it because getLocalPlayerPose() carries no velocity. Result: a sustained forward-bias sawtooth retail never shows.

Read first:
- OURS apps/holtburger-web/scene3d/camera.js:1060-1069 (_advancePrediction uses RUN_SPEED=4.5)
- OURS apps/holtburger-web/scene3d/loop.js:260-285 (axis composite: X/Y from JS, Z/heading from wasm)
- OURS crates/holtburger-world/src/state/self_movement.rs:36-66 (resolved_manual_run_speed = base * run_rate_scalar)
- The LocalPlayerPose wasm export (grep getLocalPlayerPose in apps/holtburger-web/src/lib.rs + pkg-web/*.d.ts) — currently {x,y,z,heading,landblockId}, no velocity.

Pick ONE approach (recommend B):
  A. Add a velocity (vx,vy) or speed+heading field to the LocalPlayerPose export so JS predicts at the integrator's actual speed.
  B. (Simpler, more correct) Stop the JS predictor from independently advancing X/Y; have it ONLY lerp the rendered pose toward getLocalPlayerPose() each frame. The Rust integrator already runs every tick and is authoritative — the JS layer's job becomes pure smoothing, not a second predictor. This collapses three speed sources to one.

Gotchas:
- Confirm the real player MotionTable base_run_forward_velocity magnitude first (see §DATA below) so you know the true target speed.
- The 2D index.html path has its own predictor (index.html:5924-5976, 7635) — decide whether it's in scope (the 3D camera.js path is the live visual).
- build_raw_motion_state_for_input (lib.rs:25462) is dead code (#[allow(dead_code)]) — don't waste time on it, but note its 4.5 should match whatever you settle on.

Verify (off-screen 1070): hold W as a fresh low-Run character; capture window.__diag.physics drift + a position trace; confirm the predicted pose no longer overruns then snaps back (no sawtooth), and rendered motion matches integrator motion.
```

---

## §3 — Wire Setup.dat step-up/down into the collision solver  ·  HIGH · medium-high

```
Goal: Give players stair/curb climbing. We have NO step_up/step_down/edge_slide/cliff_slide; any riser currently blocks the player as an impassable vertical wall. Setup.dat StepUpHeight/StepDownHeight are already PARSED (setup_model.rs) but never fed to the movement solver.

Read first:
- OURS crates/holtburger-world/src/spatial/physics.rs (clamp_delta_against_cell_walls ~313-511, highest_floor_z_under, clamp_delta_to_cell_interior 205-255)
- OURS crates/holtburger-world/.../setup_model.rs (grep step_up / StepUpHeight — the parsed-but-ignored values)
- ACE Transition.cs:754,850 (StepUp), Common/PartArray.cs:240-247 (GetStepUpHeight = Setup.StepUpHeight * Scale.Z; default DefaultStepHeight=0.01)
- ACE PhysicsGlobals.cs:58 (DefaultStepHeight)

Implement (start minimal):
1. Step-up: when the lateral sweep is blocked by a wall whose top is within StepUpHeight of the player's feet, allow the player to rise onto it instead of being stopped (raise Z, continue lateral). Use the human Setup's StepUpHeight (needs a DAT value — see §DATA; fallback to ~0.1m or the 0.01 global default while unknown, and log the assumption).
2. Step-down: when walking off a small drop within StepDownHeight, snap down to follow the surface instead of going ballistic (this interacts with LEDGE_FALL_THRESHOLD_M=0.5 in player/types.rs — reconcile them).
3. Defer edge_slide/cliff_slide (harder; needs the contact-plane cross-product skid). File a follow-up.

Gotchas:
- Per memory [Push back when you can't validate]: if you can't get the real StepUpHeight from the DAT, say so and gate the value behind a clearly-logged assumption rather than guessing silently.
- This is the collision dimension where ours is a flat triangle scan, not a BSP — keep the change inside the existing sweep, don't rewrite the solver.

Verify (off-screen 1070): walk up a Holtburg building's steps / a curb; confirm the player ascends instead of stopping; confirm walking off a low ledge follows the ground instead of a visible fall-hitch.
```

---

## §4 — Correct the wasm working pose on force-position + gate the heartbeat  ·  HIGH · medium

```
Goal: Fix the reconciliation mechanism. Today a sub-snap server force-position never corrects the wasm integrator's working pose (Snapshot mode preserves it), and the 1s heartbeat unconditionally re-sends the (possibly drifted) pose — so a small rubberband can persist/oscillate. Retail InterpolateTo/ConstrainTo's the live physics object toward the forced pose and only sends position events when position actually changed.

Read first:
- OURS crates/holtburger-world/.../state/mutations.rs:606 (set_player_position -> Snapshot mode)
- OURS crates/holtburger-world/.../spatial/scene.rs:1230-1246 (preserve_local_runtime_pose; idle hard-set @1243; remote Reset @1244)
- OURS crates/holtburger-core/src/client/movement/system.rs ~1419-1435 (heartbeat Z snap + unconditional send)
- ACE WorldObjects/Player_Tick.cs:411-491 (UpdatePlayerPosition force-correction), :403 (1s threshold)
- DECOMP acclient.c:144717-145227 (SmartBox::HandleReceivedPosition: ConstrainTo/InterpolateTo decision); 388317 InterpolateTo / 388367 ConstrainTo; InterpolationManager 0.05m deadband @389057

Implement:
1. On an inbound local-player force-position under the snap distance, nudge/lerp the integrator's WORKING pose toward the forced pose (a small constraint pull), instead of leaving body.pose untouched — so the next heartbeat reports a corrected pose. Retail uses a leash + interpolation; a simple capped per-tick correction toward the forced pose is a reasonable first cut.
2. Add a position-changed gate to the heartbeat (Frame::is_equal style): skip the send if the pose hasn't meaningfully changed since last_sent (retail also re-sends on contact-plane change — consider it).
3. Make snap thresholds indoor/outdoor-aware to approach retail's 25m indoor / 100m outdoor blip + 5/10m constraint leash, rather than the flat JS 5m.

Gotchas:
- The local-player teleport snap is landblock-ID-crossing-gated (index.html:5960-5968), NOT distance — don't conflate teleport with force-position.
- Remote entities already hard-reset (scene.rs:1244); this task is specifically the LOCAL player's missing soft-correction.
- Keep the existing sequence-gating (teleport/force-position newer-wins) intact.

Verify (off-screen 1070): induce a small rubberband (e.g. run into geometry / low-Run drift); confirm with a position trace + __diag that the integrator pose converges to the server pose and the heartbeat stops re-asserting the stale pose (no persistent oscillation).
```

---

## §5 — Fix the backstep speed bug  ·  MEDIUM · low

```
Goal: (Run, Backstep) currently returns the bare run_rate_scalar (~4.5) treated as raw m/s; (Walk, Backstep) returns 1.0. Retail backstep = WalkAnimSpeed * BackwardsFactor (3.12*0.65 ~= 2.03), run-scaled by run_factor (the magnitude IS run-scaled even though there's no Run-Backward clip).

Read first:
- OURS crates/holtburger-core/src/client/movement/common.rs:439-446 (forward_axis_speed backstep arms)
- ACE Animation/MotionInterp.cs:543 + adjust_motion (WalkBackwards->WalkForward, speed *= -0.65)
- DECOMP acclient.c:343466 (run-scale unconditional for WalkForward case)

Implement: derive backstep speed from the motion-table walk-forward base velocity * BackwardsFactor (0.65), then apply run_factor — NOT the run_rate_scalar used as a raw magnitude. Add a unit test asserting the resulting m/s against the expected ~2.03 (walk) / ~2.03*run_factor (run).
```

---

## §6 — Align walkable-slope threshold  ·  MEDIUM · low

```
Goal: Our floor classifier accepts normal.z >= 0.5 (slopes up to 60deg); retail FloorZ = 0.66417 (48.4deg). We let players stand on steeper inclines than retail.

Read first:
- OURS crates/holtburger-world/src/spatial/physics.rs (FLOOR_NORMAL_MIN=0.5, WALL_NORMAL_MAX=0.7, highest_floor_z_under)
- ACE PhysicsGlobals.cs:50 (FloorZ=0.66417414618662751)

Implement: raise FLOOR_NORMAL_MIN to FloorZ. Watch the 0.5..0.7 band (floor-for-Z-snap but not wall-clamped) — closing it may need WALL_NORMAL_MAX adjusted too. Verify on a sloped Holtburg/academy cell that the player can no longer stand on a too-steep ramp.
```

---

## §7 — (Low) Second-order gravity integration

```
Optional polish: switch the airborne step (system.rs:936-939) to retail's exact-integral form (position uses OLD velocity + 0.5*a*dt^2, then update velocity) and/or carry gravity in an acceleration vector like calc_acceleration. Sub-cm/tick at 16ms, so low priority — only worth it if §1's subdivision is in and you want exact parity. Don't do this before §1.
```

---

## §DATA — Resolve the open questions that need a live run / DAT dump

These gate the speed-parity claims in §2/§5/§6. Do at least the first before tuning speeds.

```
Goal: Answer "do our grounded speeds actually equal retail's?" — currently unverifiable from source.

1. Dump the REAL player MotionTable (DID 0x09000001) cycle velocity magnitudes (walk-forward, run-forward, sidestep). Test fixtures use synthetic (1.0, 1.5); we need |base_run_forward_velocity|.
   Tools (per memory [Use existing DAT tools first]): survey WB.Terminal / DatReaderWriter / crates/holtburger-dat/examples BEFORE writing a custom dump. The worldbuilder-terminal skill (~/.claude/skills/worldbuilder-terminal/) has a motion-table oracle.
   Decision it settles: if |base_run| ~= 4.0 with grounded speedMod ~= 1.0, our run speed equals retail; if ~1.0-2.5 with run_rate multiplied in, we diverge.

2. Trace (or wire-capture) whether retail's GROUNDED position update uses the Sequence velocity directly (DAT_velocity * run_rate) vs re-deriving via get_state_velocity. ACE clearly uses Sequence for grounded and get_state_velocity only for leave-ground; confirm acclient.c does the same.

3. Off-screen 1070 capture: steady-state visible amplitude of the dual-predictor sawtooth for a low-Run character (est. ~0.12m/emit). Confirms whether §2 is cosmetic or noticeable.

4. Off-screen 1070 capture: does a sub-snap force-position leave a persistent oscillation? Confirms §4's necessity.

Output: append answers to verified-comparison-report.md (the "Open Q" lines) so the next agent doesn't re-ask.
```
