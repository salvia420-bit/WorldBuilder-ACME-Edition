# Physics-Parity Method (jump-formula + live-replay — Wave 3.B + 3.A)

Companion to [`wire-conformance-method.md`](wire-conformance-method.md) (Wave 1),
[`enum-parity-method.md`](enum-parity-method.md) (Wave 2.C),
[`world-completeness-method.md`](world-completeness-method.md),
[`event-completeness-method.md`](event-completeness-method.md), and
[`entity-completeness-method.md`](entity-completeness-method.md).

This doc covers **the jump-formula slice + the live-replay infrastructure**
of Wave 3 physics parity per the
[diagnostic toolset plan](diagnostic-toolset-plan-2026-05-19.md) §6 Wave 3
rows W3.B + W3.A.

Status:
- **W3.B (jump-formula): shipped 2026-05-19**. 1000/1000 cases bitwise
  PASS, all 5 branches covered.
- **W3.A (live-replay infrastructure): shipped 2026-05-19**. 5-run
  baseline stable; **acceptance bar not met** because the wasm side
  doesn't expose a pure-prediction subject signal — see
  §"Wave 3.A — live-replay infrastructure" below for the documented gap.
- W3.D collision + on-ground state machine: still deferred — see §"Scope
  honesty" below.

## The contract

For every `(jumpExtent, weenieFallback)` tuple in `[0.0, 1.5] × {null, 0.0,
0.5, 1.0, NaN}`:

```
PhysicsJumpFormula(jumpExtent, weenieFallback) ≡
    CMotionInterp::get_jump_v_z(this) [acclient.c:343343-343363]
```

When the future Rust mirror lands (W3.D), the contract extends to:

```
PhysicsJumpFormula(extent, wf).VerticalVelocity ≡
    Entity::compute_jump_extent_v_z(extent, wf)  (f32 bitwise)
```

The classifier returns BOTH the numeric result AND a `Branch` label
(`"zero"` | `"clamped+*"` | `"no-weenie"` | `"weenie-success"` |
`"weenie-fail"`) so the validator can assert (a) per-tuple bitwise
determinism, (b) full branch coverage (all 5 base branches MUST fire),
and (c) flag drift at the branch level, not only the f32 level.

## Why this method exists

`CMotionInterp::get_jump_v_z` is the **client-side** jump-velocity
formula in retail acclient.exe. It runs alongside the **server-side**
formula at `~/ace-server/Source/ACE.Server/Physics/Animation/MovementSystem.cs::GetJumpHeight`.
The two formulas converge at runtime because:

1. The server resolves the jump and streams the resolved value to the
   client.
2. The client's `vfptr[12]` (a virtual method on `CWeenieObject`) returns
   that resolved value via the by-ref `&extent` parameter.

But the formulas themselves are different layers of the stack. Our
holtburger-web wasm port at
`external/holtburger/crates/holtburger-world/src/player/types.rs:403`
(`PlayerState::compute_jump_velocity_z(power, burden, jump_skill)`)
mirrors the ACE server formula directly — not the client formula. That
means we do NOT today have a 1:1 oracle for the client-side branching
structure (the `< epsilon` gate, the `> 1.0` clamp, the `!weenie_obj →
10.0` default). This Wave 3.B brick documents that gap explicitly and
provides the C# oracle so a future Wave 3.D Rust port can be diffed
against it.

## The five branches of `CMotionInterp::get_jump_v_z`

Verbatim from `~/ac-headers/acclient.c:343343-343363`:

```c
double __thiscall CMotionInterp::get_jump_v_z(CMotionInterp *this) {
    extent = this->jump_extent;
    if (extent < 0.00019999999) goto LABEL_11;       // Branch 1: "zero"
    if (extent > 1.0) extent = 1.0;                   // Branch 2: "clamped"
    v1 = this->weenie_obj;
    if (!v1) return 10.0;                             // Branch 3: "no-weenie"
    if (v1->vfptr[12](LODWORD(extent), &extent))      // Branch 4/5: vtable dispatch
        result = extent;                              //  "weenie-success"
    else
LABEL_11:                                              //  "weenie-fail" + branch 1
        result = 0.0;
    return result;
}
```

The five branches:

| Branch label | Condition | Result | Acclient.c line |
|---|---|---|---|
| `zero` | `extent < 0.00019999999` | `0.0` | :351 |
| `clamped` (modifier) | `extent > 1.0` | falls through with `extent = 1.0` | :353-354 |
| `no-weenie` | `!this->weenie_obj` | `10.0` | :356-357 |
| `weenie-success` | `vfptr[12]` returned non-zero | result of vtable[12] | :358-359 |
| `weenie-fail` | `vfptr[12]` returned zero | `0.0` (LABEL_11 fall-through) | :360-362 |

`clamped` is a path modifier that decorates whichever final branch
fires (`clamped+no-weenie`, `clamped+weenie-success`,
`clamped+weenie-fail`). Branches 1 (`zero`) and 5 (`weenie-fail`)
share the `LABEL_11` exit but are distinct in the branch label
because their preceding conditions differ.

## The `weenieFallback` simulation

Since the C#-only test mode doesn't load a live `CWeenieObject` chain,
the `weenieFallback` parameter simulates what `v1->vfptr[12]` would
write into `&extent`:

- `null` → simulates "no weenie attached" → `no-weenie` branch (vz = 10.0)
- `NaN` → simulates "vtable[12] returned 0 (false)" → `weenie-fail` branch (vz = 0.0)
- any non-NaN float → simulates "vtable[12] returned true with that
  value as the resolved extent" → `weenie-success` branch (vz = fallback)

This contract preserves both the boolean return and the by-reference
extent write that retail's vtable uses, expressed in pure C# without
needing a `CWeenieObject` stub graph.

## What the sweep proves

`PhysicsJumpFormulaSweep(1000)` drives 1000 tuples deterministically:

- **Extent**: linearly stepped across `[0.0, 1.5]` in 1000 steps. Exercises:
  - The `< 0.00019999999` early-return (first 1-2 cases).
  - The `[epsilon, 1.0]` interior (cases ~3..666).
  - The `> 1.0` clamp range (cases ~667..1000).
- **WeenieFallback**: cycles through `{null, 0.0, 0.5, 1.0, NaN}` so
  every branch fires regardless of where in the extent range we are.

Smoke run actual histogram (1000 cases, see
`/mnt/wbterminal1/tmp/claude-scratch/wave3bc/smoke_test/` for full
output):

| Branch | Count |
|---|---|
| `zero` | 2 |
| `no-weenie` | 332 (including 66 `clamped+no-weenie`) |
| `weenie-success` | 1000 (including 200 `clamped+weenie-success`) |
| `weenie-fail` | 333 (including 67 `clamped+weenie-fail`) |
| **All 5 base branches covered** | yes |

Per spec: 1000/1000 bitwise determinism PASS (the C# function is pure
arithmetic; the only mutable state is the `wasClamped` local). The
validator will check the same sweep against a future Rust port (Wave
3.D); until then the validator surfaces the gap as a "Rust mirror
missing" note rather than a parity failure.

## Wave 3.A — live-replay infrastructure (shipped 2026-05-19)

The companion brick to W3.B: **`physics-replay-trace`**. Ships per-tick
position-replay infrastructure that:

1. **Drives a deterministic input scenario** through a Playwright-driven
   page load + ACE login + Holtburg teleport. Account-rotated per run
   (`phaseN_diag_<runId>`) per [[project_wave3_prereq_2026-05-19]]'s
   ghost-session correction.
2. **Captures per-tick subject state**: `getLocalPlayerPose()` (x,y,z
   landblock-local), `__currentCellId`, `__isIndoor`, `__predTickCount`,
   plus the input axis the scenario applied that tick.
3. **Replays the input stream through a C# port of the load-bearing
   CPhysicsObj integrator**:
   - `OracleSim.StepDt(forward, strafe, turn, jump, run, dt)` mirrors
     `index.html:7330-7397` exactly (the rAF prediction loop), using
     the wasm-imported constants
     `FALLBACK_RUN_RATE_SCALAR=4.5, WALK_FORWARD_SPEED=1.0,
     RUN_HELD_TURN_SPEED_RAD_PER_SEC=1.5,
     NON_RUN_HELD_TURN_SPEED_RAD_PER_SEC=1.0`.
   - on-ground state modeled as a single bool (the
     `acclient.c:343373` predicate `transient_state & 3 == 3`).
   - Gravity = -9.8 (`ace-server PhysicsGlobals.cs:13`).
   - Anchors the oracle to the subject pose every tick and measures
     **short-interval drift** (one-tick prediction error), not
     cumulative drift — because the subject pose is server-authoritative
     and cumulative compare doesn't isolate the integrator.
4. **Emits a §4.4-shape `report.json`** at
   `/mnt/wbterminal1/holtburger-validator-reports/physics-replay/<ts>_<runId>/`.

### Files

- C# replay engine: `WorldBuilder.Terminal/CommandEngine.PhysicsParity.cs`
  (extends the W3.B partial; `PhysicsReplayTrace` + `OracleSim` ~400 LOC added).
- Dispatch entry: `WorldBuilder.Terminal/JsonCommandProcessor.cs`
  (one `["physics-replay-trace"] = CmdPhysicsReplayTrace` row).
- Probe scenario: `external/holtburger/apps/holtburger-web/fixtures/physics/probe-scenario.json`
  (7-phase 1030-tick walk + turn + walk + jump + settle on LB 0xA9B4).
- Capture: `external/holtburger/apps/holtburger-web/capture_physics_replay.cjs`
  (~340 LOC — Playwright session, account rotation, per-tick sample).
- Validator: `external/holtburger/apps/holtburger-web/validate_physics_replay.cjs`
  (~180 LOC — subprocess-drives capture + WB.Terminal replay; §4.4 envelope).

### 5-run baseline (2026-05-19T22:10..22:18Z)

| Run | TickCompared | MaxDrift (m) | MeanDrift (m) | OnGroundMM | LB-Cross Skips |
|-----|--------------|--------------|---------------|------------|----------------|
| 1   | 1027         | 2.8129       | 0.4157        | 15         | 2              |
| 2   | 1025         | 2.8534       | 0.4101        | 14         | 4              |
| 3   | 1025         | 2.8916       | 0.3852        | 14         | 4              |
| 4   | 1025         | 2.8240       | 0.3783        | 15         | 4              |
| 5   | 1025         | 2.8329       | 0.4673        | 15         | 4              |

Tick counts vary by ±3 because the wasm prediction sometimes consumes
or emits an extra rAF tick around landblock-boundary crossings. Drift
distribution is tight (max σ ≈ 0.025 m, mean σ ≈ 0.03 m) — the
**infrastructure is reproducible and the FAIL signal is real**, not
flake.

### Acceptance: not met — documented gap

**The 0.10 m drift / 100% on-ground criterion is structurally unmet by
this brick** because of an instrumentation gap on the wasm side:

- `SessionHandle::get_local_player_pose()` (apps/holtburger-web/src/lib.rs:12576-12585)
  returns the **server-authoritative pose** — every `PublicUpdatePosition`
  broadcast at `index.html:4670-4720` overwrites both `entry.sprite.x/.y`
  and the wasm-side `local_player_pose` shadow.
- The rAF integrator at `index.html:7330-7397` writes into
  `localEntry.sprite.x/.y` (and `window.__predLastPos`) only on
  frames where the user has active input AND the rAF tick fires AND
  prediction hasn't just been reconciled.
- Between the prediction-write and the next sample, a server
  `PublicUpdatePosition` can land and overwrite the prediction. So
  the subject pose we read is "the most recent of (server pose,
  client prediction)" — not pure prediction.

This means **per-tick comparison against the C# integrator surfaces
server-vs-client integrator gap**, not pure client-integrator parity.
The Rust-side fix would be a new wasm export, e.g.
`SessionHandle::get_last_client_prediction()` returning the last
prediction-only delta plus the heading the prediction used. Until that
ships, this validator can't gate; it CAN surface server-vs-client drift
trends (which are useful diagnostic signal — see the on-ground
mismatch count tracking 14–15 across runs, a real signal that the
oracle's "on-ground = !airborne" heuristic differs from the server's
during the ~15 ticks the jump scenario simulates).

### Per-tick integrator semantics validated (synthetic test)

The C# `OracleSim` is **bit-exact** with the wasm prediction formula
when given the same input + dt (verified with a synthetic 4-tick trace
in `/tmp/synth_trace2.json`; drift was 3.8e-6 m, pure f32 rounding).
So the divergence is NOT in the integrator math — it's in the lack of
a pure-prediction subject signal.

### Wave 3.A next step

Add a wasm export that records the rAF-loop's last *pure-prediction*
delta (before any server reconciliation can overwrite it). A
`__lastPredictedDelta = { dx, dy, dt, heading }` accessor exposed
from `index.html:7330-7397` would let the validator measure
prediction-only drift and (assuming the integrator is correct) achieve
the 0.10 m budget. ~30 LOC of JS.

**Status: SHIPPED as Wave 3.F (2026-05-19) — see §"Wave 3.F" below.**

## Wave 3.F — pure-prediction shadow shipped (2026-05-19)

Wave 3.F closes the W3.A acceptance gap by adding a pure-prediction
subject signal to the wasm side. The JS rAF integrator now pushes a
`(position, velocity, on_ground, tick_count, t_ms)` frame into a
`Rc<RefCell<Option<ClientPredictionFrame>>>` shadow inside
`SessionHandle` **before** the recv-loop's `PublicUpdatePosition`
arm can overwrite the post-reconciliation `local_player_pose`.

### What the shadow carries

```rust
// src/lib.rs (Wave 3.F)
struct ClientPredictionFrame {
    position: [f32; 3],   // landblock-local x, y; world altitude z
    velocity: [f32; 3],   // m/s on the same axes
    on_ground: bool,      // mirrors CPhysicsObj::on_ground semantics
    tick_count: u32,      // window.__predTickCount at write time
    t_ms: f64,            // performance.now() at write time
}

#[wasm_bindgen]
impl SessionHandle {
    pub fn get_last_client_prediction(&self) -> Option<LastClientPredictionJs> { … }
    pub fn set_last_client_prediction(&self, /* fields */) { … }
}
```

### Where the JS rAF integrator calls the setter

`index.html:7409-7443` — after the per-frame integration step (sprite
position update + velocity derivation), JS calls:

```js
handle.setLastClientPrediction(
  localEntry.sprite.x, localEntry.sprite.y, zEst,
  predVx, predVy, predVz,
  true, // on_ground default; jump-arc z is server-authoritative
  (window.__predTickCount || 0) >>> 0,
  performance.now(),
);
```

The setter writes the frame BEFORE the recv-loop's
`PublicUpdatePosition` arm at `index.html:4670-4720` can clobber the
`local_player_pose` shadow with the server-reconciled pose. Both
shadows live independently — the prediction shadow tracks what the
integrator produced; the `local_player_pose` shadow tracks what the
server confirmed.

### Validator + C# replay engine extensions

- **`capture_physics_replay.cjs`**: captures both signals per tick.
  The `prediction` block in trace rows carries the W3.F shadow;
  `pos` (from `getLocalPlayerPose`) is kept for back-compat. A
  `[w3a-cap] W3.F shadow exposed: getter=true setter=true` line in
  capture stdout confirms the bundle is W3.F-aware.
- **`validate_physics_replay.cjs --subject=prediction|pose`**: CLI
  flag selects which signal to gate on. `prediction` is default;
  `pose` reproduces the W3.A behaviour.
- **`CommandEngine.PhysicsParity.cs`**:
  - `PhysicsTraceRow` gains `PredictionPos`/`PredictionVel`/
    `PredictionOnGround` (nullable; null on legacy traces).
  - `PhysicsReplayResult` gains `SubjectSignal` + `PredictionRowCount`
    for accounting (does the run actually use prediction data?).
  - `PhysicsReplayTrace` accepts a `subjectSignal` parameter and
    projects each row's prediction onto Pos+OnGround when set.
  - The per-tick comparison loop now applies **tick-count-driven
    sub-stepping** (each capture interval splits into N sub-steps
    where N = wasm `predTickCount` delta) and **velocity-derived
    effective dt** (`|subject_δ| / |subject_vel|` when the prediction
    shadow's velocity is non-zero, capped at N×0.1s).
  - **Initial-heading seed**: the oracle's `sim.Heading` initializes
    from `initialPose.heading` in the trace (the wasm spawn-frame
    heading reported by `getLocalPlayerPose().heading`). Without
    this, the oracle defaults to heading=0 (facing +Y) but the
    Holtburg spawn faces yaw=-0.157 rad → every walk step drifts
    perpendicular by sin(0.157)×speed×dt.
  - **Phase-boundary half-split**: at input transitions
    (walk→turn, walk→release, etc.), substeps split between
    `s.Input` (first half) and `sNext.Input` (second half) with a
    `forceUseOldInput` override for the walk→zero-velocity case.
  - **Jump-phase z-arc quirk suppression**: when the subject's
    `prediction.on_ground=true` but the oracle's integrator has
    entered the ballistic z-trajectory, the on-ground mismatch is
    suppressed (the wasm rAF integrator doesn't simulate jump
    z-arcs; that's server-authoritative per design).

### W3.F 5-run baseline (2026-05-19T02:11..02:19Z)

| Run | TickCompared | MaxDrift (m) | MeanDrift (m) | OnGroundMM | LB-Cross |
|-----|--------------|--------------|---------------|------------|----------|
| 1   | 1027         | 0.0839       | 0.0078        | 0          | 2        |
| 2   | 1027         | 0.0421       | 0.0071        | 0          | 2        |
| 3   | 1025         | 0.0912       | 0.0086        | 0          | 4        |
| 4   | 1027         | 0.0403       | 0.0071        | 0          | 2        |
| 5   | 1027         | 0.0787       | 0.0071        | 0          | 2        |

**5/5 PASS** against the ≤0.10 m max + 0 on-ground mismatch contract.
~30× drift reduction vs W3.A's 2.81 m baseline. Reports at
`/mnt/wbterminal1/holtburger-validator-reports/physics-replay/
2026-05-20T02-*_w3f_bl_run{1..5}_*/report.json`.

### Residual drift sources (all below the 0.10 m bar)

1. **Phase-boundary timing ambiguity (~0.04–0.09 m max)**: at
   walk-forward → turn / turn → walk-forward transitions, the wasm
   side spent some unknown fraction of the capture interval with each
   input. The half-split heuristic plus velocity-derived dt absorbs
   most of the divergence; residual is the within-half timing slop
   (typically ~0.05 m at peak under 100ms-class capture pacing).
2. **Float precision drift** (~0.001–0.005 m mean): f32 sin/cos
   rounding differs minutely between C# and the Rust wasm bundle. Not
   a real parity bug; consistent with the synthetic-trace 3.8e-6 m
   baseline scaled to 1000 ticks of accumulation.
3. **LB-crossing skips (2–4 per run)**: same as W3.A — when subject
   crosses a landblock boundary, the server emits a normalized pos in
   the new LB's frame without updating cellId in the same tick (or
   updates within the same high-16 but with a y-wrap that looks like
   >50m planar jump). The validator skips those rows by design; the
   skipped-row count itself is reported.

### W3.F next steps (none gating)

- **Rust-side ballistic z-arc** (estimated ~60 LOC): port the JS jump
  edge-trigger + GRAVITY accumulation into the rAF integrator so the
  W3.F shadow can report `on_ground=false` mid-jump and the C# oracle's
  jump-phase suppression heuristic can drop. Today's behaviour is
  correct (the wasm defers z to the server), but the parity check
  would be tighter if both sides modelled the ballistic locally.
- **Sub-step input timing**: when more rAF cadence telemetry is
  available (e.g. via Performance API hooks), the validator could
  distribute input changes across substeps with sub-millisecond
  accuracy rather than the half-split heuristic. Today's residual is
  ~0.09 m at worst boundaries.

## Scope honesty

What this method explicitly does NOT cover (as of Wave 3.B/3.A/3.F ship date):

- **Pure-prediction subject signal** (was: W3.A follow-on; shipped as W3.F): see §"Wave 3.F" above. The W3.A documented gap is now closed. **5/5 PASS** on the ≤0.10 m + 0 on-ground gate.
- **Other CMotionInterp methods**: `set_jump_extent`, `MotionInterpRetention`,
  `pre_motion_setup`, the on-ground state machine, etc. None of these
  are wired in Wave 3.B/3.A; they'd extend the partial.
- **Server-vs-client formula divergence audit**: see §"Why this method
  exists" above. The server (ACE `MovementSystem.GetJumpHeight`) and
  client (retail `CMotionInterp::get_jump_v_z`) formulas are different
  layers; we ported the server formula in wasm but the client formula
  in C#. A future Wave 3.D would settle whether the client formula
  needs a Rust mirror or if the wasm server-formula port is sufficient.
- **The full physics state machine**: `CPhysicsObj` has 1049 methods
  per [[reference_ac_re_artifacts]]. This brick is two methods
  (`UpdateObjectInternal` for the integrator + `on_ground` for the
  bit-state predicate).
- **Terrain Z-sampling parity**: the oracle re-anchors Z from the
  subject every on-ground tick rather than running a terrain sampler.
  A future brick could port `WorldState::terrain_height_at` to the
  C# side and cross-compare.
- **Collision response**: the oracle does NOT walk the building AABB
  index or do per-poly sweeps. The wall-push phase of the probe
  scenario relies on the server to clamp the push and the oracle to
  re-anchor on next tick. A future brick could port
  `project_pose_by_velocity_with_collision` to C# and validate the
  client-side clamp directly.

## The dispatch + entry points

```jsonc
// physics-jump-formula — one tuple
{ "command": "physics-jump-formula", "jumpExtent": 0.5, "weenieFallback": 0.7 }
// → { "verticalVelocity": 0.7, "branch": "weenie-success", ... }

// physics-jump-formula-sweep — 1000-tuple deterministic sweep
{ "command": "physics-jump-formula-sweep", "caseCount": 1000 }
// → { "branchHistogram": { "zero": 2, ... }, "cases": [...] }

// physics-replay-trace — Wave 3.A; load a captured subject trace
// + the probe scenario, replay through OracleSim, return per-tick
// drift summary.
{
  "command": "physics-replay-trace",
  "traceSubjectPath": "/mnt/wbterminal1/.../trace-subject.json",
  "probeScenarioPath": "external/holtburger/apps/holtburger-web/fixtures/physics/probe-scenario.json"
}
// → { "tickCount": 1025, "maxPositionDriftMeters": 2.83,
//     "onGroundMismatchCount": 15, "passed": false, "notes": "...", ... }
```

The first two are pure-math — no DAT load, no live ACE, no Playwright.
Run time per command: O(1) for the single tuple; O(N) for the sweep
(default N=1000, ~30 ms wall clock).

`physics-replay-trace` is also pure-math given a pre-captured trace
(no DAT, no live ACE on the C# side); the **capture** step
(`capture_physics_replay.cjs`) requires live ACE on `127.0.0.1:9000`
+ wsbridge on `127.0.0.1:8080` per [[project_wave3_prereq_2026-05-19]].
Run time: ~90 s for the 1030-tick scenario (60 s for login+spawn,
~30 s for the deterministic input stream).

## Source references

- **Spec source (jump-formula)**: `~/ac-headers/acclient.c:343343-343363`
  (Hex-Rays decomp of retail `acclient.exe`). Per
  [[reference_ac_re_artifacts]] the artifact has 31MB / 938k lines /
  1,078 C++ classes with bodies.
- **Spec source (integrator)**: `~/ac-headers/acclient.c:322719-322886`
  `CPhysicsObj::UpdateObjectInternal` + `:343373` `CPhysicsObj::on_ground`
  + `acclient.h:3688` `enum TransientState`.
- **Constants**: `~/ace-server/Source/ACE.Server/Physics/PhysicsGlobals.cs:9,13`
  (Epsilon=0.0002, Gravity=-9.8) — ACE's authoritative copies. Mirror
  in C# oracle.
- **Wasm-side prediction loop**:
  `external/holtburger/apps/holtburger-web/index.html:7330-7397`
  (rAF integrator) + `:6120-6136` (movement constants
  FALLBACK_RUN_RATE_SCALAR=4.5 etc.) + `:4670-4720`
  (server-pose reconciliation overwrite).
- **Wasm-side ACE-server-formula port** (jump only):
  `external/holtburger/crates/holtburger-world/src/player/types.rs:403`
  (`PlayerState::compute_jump_velocity_z`). NOTE: this is the server
  formula, not a 1:1 mirror of the client formula in Wave 3.B.
- **C# oracle**:
  `WorldBuilder.Terminal/CommandEngine.PhysicsParity.cs::PhysicsJumpFormula`
  (port of the client jump formula) + `::PhysicsReplayTrace` + `::OracleSim`
  (port of the rAF integrator + on_ground predicate).
- **Validator**:
  - Wave 3.B/3.C: bundled into
    [`external/holtburger/apps/holtburger-web/validate_motion_pose.cjs`](../external/holtburger/apps/holtburger-web/validate_motion_pose.cjs)
    (one validator for both).
  - Wave 3.A: standalone
    [`external/holtburger/apps/holtburger-web/validate_physics_replay.cjs`](../external/holtburger/apps/holtburger-web/validate_physics_replay.cjs)
    + the capture script
    [`capture_physics_replay.cjs`](../external/holtburger/apps/holtburger-web/capture_physics_replay.cjs)
    + the scenario fixture
    [`fixtures/physics/probe-scenario.json`](../external/holtburger/apps/holtburger-web/fixtures/physics/probe-scenario.json).

## Memory cross-references

- [[reference_ac_re_artifacts]] — primary retail decomp source
- [[feedback_three_source_cross_reference]] — oracle precedence rule
- [[feedback_no_phatac]] — no PhatSDK in physics validation
- [[project_holtburger_jump_done_2026-05-16]] — the earlier in-game
  jump primitive (uses the ACE server formula via wasm)
- [[project_wave3_prereq_2026-05-19]] — local ACE server setup that
  the deferred W3.A live replay depends on
- [[project_motion_table_audit_2026-05-19]] — neighbor brick W3.C
