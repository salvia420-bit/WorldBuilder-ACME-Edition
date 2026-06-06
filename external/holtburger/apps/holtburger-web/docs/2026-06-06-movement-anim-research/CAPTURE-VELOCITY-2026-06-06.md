# Velocity-derivation capture — `+Tester`, local headless wire-agent (2026-06-06)

Pivot from the run-rate probe (which proved run_rate = 4.5 = ACE, no input divergence) to the
velocity derivation. Headless `?nullRender=1` (rAF/TickMovement alive), autoLogin `tailnet1` → `+Tester`,
hold W 4 s, read the wasm movement trace + derivation exports. Harness:
`/mnt/wbterminal2/tmp/claude-scratch/runrate-velocity-capture.cjs`. No rebuild (all exports already exist).

## Derivation inputs (clean)

| value | reading | meaning |
|-------|---------|---------|
| `playerRunRate` | **4.5** | run_rate (capped, Run skill 15225 ≥ 800) |
| `cycleBaseSpeed_run` | **4.0** | MOTK run-cycle base speed = RunAnimSpeed |
| `cycleBaseSpeed_walk` | **2.60** | MOTK walk-cycle base speed |
| `stateGroundSpeed_run` | 4.0 | anim-speed path (RunAnimSpeed × 1.0, unclamped) |

Our forward-run target = `resolved_manual_run_speed = base_run_forward_speed × run_rate`. With
base_run ≈ cycleBaseSpeed_run = 4.0 and run_rate = 4.5 → **target ≈ 18 m/s**, the same ceiling ACE's
`get_state_velocity` clamps to (`maxSpeed = RunAnimSpeed × rate = 4.0 × 4.5 = 18`,
`MotionInterp.cs:678-700`). Both friction-limit far below that.

## Empirical (4 s forward hold)

| | distance | speed |
|--|----------|-------|
| our integrator pose | 30.97 m | **7.74 m/s** |
| ACE authoritative pose | 29.13 m | **7.27 m/s** |

`integrator_over_auth = 1.06` (6%).

## The headline: the 1.63× over-run does NOT reproduce headless

The 2026-06-05 handoff measured (headed `:0`, full rAF) **integrator 9.29 vs ACE 5.70 = 1.63×**. This
headless steady-state capture shows **7.74 vs 7.27 = 1.06×** — and the ACE figure is an *under*estimate
(only 6 un-timestamped auth poses, divided by the full 4 s window, so ACE's real speed is ≥ 7.27),
which can only *shrink* the ratio. So in the current build the integrator and ACE are at parity
(±6%, likely less). The severe snapback over-run is not present in steady-state here.

## Why the 1.63× was a measurement artifact, not a real over-run

The divergence is **not a static velocity multiplier** (run_rate matches, base speed matches, the
target formula matches ACE's), and it is **not** an over-integration hitch either: quantum subdivision
is **already shipped and ON** — `USE_QUANTUM_SUBDIVIDED_INTEGRATION = true`
(`system.rs:41`), so `advance_local_pose_for_manual_drive` accumulates `dt` and integrates bounded
`≤ MAX_QUANTUM` slices with a HugeQuantum skip (the D8 / PRED-2 item is closed, not open). The parity
this capture measures is *because* that path is active.

What actually differs between the handoff's headed `9.29 vs 5.70` and this headless `7.74 vs 7.27` is
the **ACE-speed estimate**, not the integrator: our integrator reads ~7.7 m/s in *both* (the handoff
itself cited "integrator ~7.7 m/s"). The handoff's `5.70` ACE figure was a coarse/under-sampled
authoritative-pose estimate (few un-timestamped server poses ÷ full window) that made the ratio look
like 1.63×. Measured against real server displacement (29.13 m in 4 s ⇒ ≥ 7.27 m/s), ACE and the
integrator are at parity. **There is no 63% steady-state over-run in the current build.**

## Measurement caveats

- Headless `nullRender` cadence ≠ the handoff's headed `:0` full-rAF — and the integrator appears
  tick-rate-sensitive (the point above).
- `vmag` (body.velocity) is **0** throughout the trace: the manual-drive path
  (`advance_local_pose_for_manual_drive`) advances the pose directly and never populates
  `body.velocity`, so instantaneous integrator velocity isn't traceable via that field — pose
  displacement / time is the reliable measure.
- ACE auth speed is coarse (6 un-timestamped poses); treat 7.27 as a lower bound.

## Recommended next step

The steady-state velocity path is **clean** — run_rate matches ACE (4.5), the `base_run × run_rate`
target matches ACE's `RunAnimSpeed × rate` ceiling, quantum subdivision is on, and integrator ≈ ACE
displacement over 4 s. The "snapback" premise (a 1.63× over-run) does not hold up; it was an
ACE-speed measurement artifact. So:

1. **De-prioritize the velocity-multiplier hunt.** Do not change `run_rate` or the `base_run ×
   run_rate` formula — both match ACE (the prior Explore agent's "drop run_rate" instinct, already
   reverted once, remains wrong).
2. If a visible rubberband is still reported in live play, it is a **transient reconciliation snap**
   (a brief predicted-vs-server divergence that the camera lerp/snap resolves), not a sustained
   speed gap — measure it with `__diag.physics.summary()` (drift max/p99/hitchCount) during real
   play rather than average speed. A confirmed-headed re-measure with **timestamped auth poses** (the
   current trace stores no per-pose timestamp) would close the headed/headless gap definitively.
3. Trace-tooling follow-up (optional): the manual-drive path never populates `body.velocity`, so the
   trace's `vmag` slot is dead (always 0). Either populate it from the commanded
   `local_velocity_for_state` for honest instantaneous-velocity traces, or drop the field.
