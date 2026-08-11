# task MOVE-F6-SPEEDCAP — report

Queue item: `MOVE-F6-SPEEDCAP` (batch-D `postBakeCodeWork`).
Branch: `fanout-D-a2`. Scope: `crates/holtburger-core/src/client/movement/common.rs` + its unit tests.

**Headline:** the retail cap is landed and tested, but NOT on
`local_velocity_for_state`. The card's premise does not survive the decomp: that
function is the GROUND composition and retail's ground chain has no magnitude
test in it. The `run_rate × 4.0` renormalize belongs to `get_state_velocity`,
whose only consumer in the entire decomp is `get_leave_ground_velocity`. Full
evidence in **Deviations D1**; the live gap it exposes is **Handoff 1**.

## What landed (commits)

| Commit | What |
|---|---|
| `75b73258` | `holtburger: MOVE-F6 — retail's state-velocity ceiling, landed where retail puts it` |

One file: `crates/holtburger-core/src/client/movement/common.rs` (+337/−1).

* `state_velocity_speed_cap(capabilities) -> f32` = `RUN_ANIM_SPEED × run_rate_scalar`
  — retail's ceiling (`CMotionInterp::get_max_speed` `acclient.c:343486-343509`,
  and the identical inline read inside `get_state_velocity` `:343573-343586`).
  Retail's `InqRunRate → my_run_rate → 1.0` ladder is already resolved upstream
  of us into `capabilities.run_rate_scalar` (`self_movement.rs:80`).
* `cap_state_velocity(velocity, max_speed) -> Vector3` — the renormalize tail
  (`:343586-343593`), in **retail's own operand order** (`(1/|v|)·c·cap`, not
  `c·(cap/|v|)`) and with retail's **strict `>`**, so a vector exactly on the
  ceiling is returned untouched. That matters: run-forward alone composes
  `4.0 × forward_speed` against a `4.0 × run_rate` ceiling and `forward_speed`
  IS `run_rate` after `apply_run_to_command`, so the commonest input in the game
  sits exactly on the line and must not take the divide.
* `local_state_velocity_for_state(heading, state, capabilities)` — the COMPLETE
  `get_state_velocity` port on the legacy axis-helper axis: the composition with
  the ceiling applied, in the world frame (|v| is rotation-invariant, so capping
  after the heading rotation is identical to retail's body-frame cap). This is
  the LAUNCH form. `#[allow(dead_code)]` — staged, see Handoff 1.
* `local_velocity_for_state` — **behaviourally unchanged**. Its existing
  "GEOMETRIC sum ... not the speed-cap-then-project pattern" note was correct but
  incomplete; it now carries the three-step ground chain with anchors and names
  the capped sibling.

## Tests run + results

`cargo test -p holtburger-core` (from `external/holtburger/`, toolchain
`/opt/rust/toolchains/1.95.0-x86_64-unknown-linux-gnu/bin`):

```
baseline (clean HEAD 2946486d): test result: ok. 623 passed; 0 failed; 1 ignored
after   (75b73258):             test result: ok. 628 passed; 0 failed; 1 ignored
doc-tests:                      test result: ok.   0 passed; 0 failed
```

**+5 tests, 0 failures.** No other package was touched, so no other `-p` run applies.

New tests (all in `common.rs::tests`):

| Test | Acceptance bullet |
|---|---|
| `state_velocity_cap_leaves_under_and_at_the_ceiling_untouched` | **(a)** under-cap untouched — asserted `assert_eq!`, bit-for-bit, not epsilon. Also pins the strict `>` boundary and the run-forward-alone-lands-exactly-on-the-ceiling invariant. |
| `state_velocity_cap_renormalizes_over_ceiling_preserving_direction` | **(b)** over-cap → exactly `cap` magnitude; unit vectors agree per-axis to 1e-6; and the result equals `raw × (cap/\|raw\|)` per-axis, i.e. ONE uniform factor, not a projection or per-axis clamp. |
| `state_velocity_cap_scales_with_run_rate` | **(c)** ceiling == `4.0 × run_rate` over the DESIGN §2 rate ladder (1.0 / 1.9166666 / 2.65 / 4.5), and the capped diagonal realizes each ceiling exactly. |
| `ground_composition_is_not_capped` | D1 regression pin — the ground diagonal must still exceed the launch ceiling as retail's does (18.386 vs 18.0 m/s at rate 4.5), spelled out against retail's own numbers. |
| `capped_composition_matches_the_interpreted_leave_ground_port` | Equivalence sweep: `local_state_velocity_for_state` == `motion_interp::leave_ground_velocity_for_state` across 6 locomotions × 2 gaits × 4 run rates × 4 headings (192 cells). That port is an INDEPENDENT derivation of the same decomp body (raw → `apply_raw_movement` → `MotionInterp::get_state_velocity`) carrying its own copy of the `:343586-343593` tail, so the two copies cannot drift. |

Pre-existing suites that had to stay green and did:
`identity_interpreted_matches_legacy_local_velocity_for_state` (DESIGN §1.4 — it
would have FAILED had the ground form been capped: see D1),
`get_state_velocity_clamps_magnitude_to_run_rate_times_four`,
`leave_ground_velocity_clamps_and_falls_back`, `sidestep_axis_speeds_match_retail`.

`cargo clippy -p holtburger-core --all-targets` is RED on clean HEAD
(2 × `approximate value of FRAC_1_SQRT_2` at `movement/system/tests.rs:6387`) —
pre-existing, in another task's file, and unchanged by this work. No clippy
finding lands in the added lines. `cargo fmt --check` is also dirty on clean
HEAD for this crate, so it is not a gate; the added code follows the surrounding
style by hand.

## Read-verified anchors

Everything below was opened this session (`rg -a` / `Read` against
`~/ac-headers/acclient.c`, and the in-repo ACE source).

**The cap itself**
* `CMotionInterp::get_state_velocity` — defn `acclient.c:343539`, body to `:343594`.
  Composition `:343552-343572` (`1.25 × sidestep_speed`; `3.1199999 ×
  forward_speed` for WalkForward `0x45000005`, `4.0 × forward_speed` for
  RunForward `0x44000007`; `z = 0`). Rate resolve `:343573-343585`. Ceiling
  `v9 = v8 * 4.0` `:343586`. Magnitude `:343587`. Strict `if (v10 > v9)` `:343588`.
  Renormalize `:343590-343592`.
* `CMotionInterp::get_max_speed` — `:343486-343509` (same ladder, same `× 4.0`).
* `CMotionInterp::get_adjusted_max_speed` — `:343512-343535` (the INTERP-cap
  variant; not this path, noted so the two are not confused).
* ACE 1:1 — `external/ACE/Source/ACE.Server/Physics/Animation/MotionInterp.cs:678-700`
  (`get_state_velocity`), `:665-676` (`get_max_speed`), `:654-663`
  (`get_leave_ground_velocity`).

**The cap's sole consumer**
* `rg -a -n 'get_state_velocity' ~/ac-headers/acclient.c` → exactly 3 hits:
  `7096` (decl), `343539` (defn), **`343821` (the only call)** — inside
  `CMotionInterp::get_leave_ground_velocity` (`:343806-343842`).
* `rg -n 'get_state_velocity' MotionInterp.cs` → `656` (the only call, inside
  `get_leave_ground_velocity`), `678` (defn). ACE agrees.

**The ground chain has no cap**
* `CMotionInterp::apply_interpreted_movement` `:344147-344200` — issues the
  forward command at `:344177` and, when the sidestep slot is occupied, the
  sidestep command at `:344182`. Retail's ground diagonal is REAL, not an
  artifact of our axis decomposition.
* `add_motion` `:337431-337474` — `CSequence::set_velocity(speed_mod × cycle
  velocity)` at `:337451` (SET).
* `combine_motion` `:337477-337503` — `CSequence::combine_physics` at `:337501`;
  that function is a plain component-wise `+=` (`:339716-339721`) (ADD).
* `CSequence::apply_physics` `:339860-339890` — `origin += quantum × velocity`
  (`:339876-339881`). No magnitude test in any of the four.
* `CMotionInterp::apply_raw_movement` `:344259-344298` — copies raw → interpreted,
  runs `adjust_motion` ×3, calls `apply_interpreted_movement`. It never touches a
  velocity, so nothing routes the capped closed form onto the ground.

**Our side**
* `common.rs:882-930` (pre-change) `local_velocity_for_state` — read-verified as
  charged; it is the ground composer.
* Consumers: `system.rs:4813` (rollback arm of the ground integrator —
  `USE_INTERPRETED_VELOCITY` is `true` at `system.rs:695`, so this arm is the kill
  path), `system.rs:7648` (rollback arm of `manual_intent_velocity`), and
  `system.rs:7679` in `current_local_solve_body_input`, which is **ungated** and
  feeds the canonical spine's local-body solve at `simulation.rs:518` — the live
  ground lane.
* `motion_interp.rs:560-585` `MotionInterp::get_state_velocity` — the cap was
  ALREADY ported here, correctly, and is consumed by
  `leave_ground_velocity_for_state` (`:1849-1867`) → `stamp_leave_ground_velocity`
  (`system.rs:1693-1710`, `USE_LEAVE_GROUND_VELOCITY = true` at `:743`).
* `motion_interp.rs:608-626` `ground_velocity` — carries the matching, already-
  written note: "NO magnitude clamp here — `add_motion` composition is unclamped".
* `DESIGN.md` (`docs/2026-06-11-unified-movement-pipeline/DESIGN.md`) §2 THE
  VELOCITY CONTRACT, lines 182-191, states the split in as many words:
  on-ground = cycle base × speed_mod; "AIRBORNE/clamp = get_state_velocity ...
  |v| clamped to run_rate × 4.0 (only physics consumer = leave-ground/jump path,
  343806-344489)".

## Deviations

### DEVIATION D1 — the cap does NOT go on `local_velocity_for_state`

*Card text:* "Retail `get_state_velocity` renormalizes the composed velocity at a
global cap of `run_rate * 4.0` ... Our composition has no global cap." *Charged
site:* `common.rs:882-930`.

*Evidence (all anchors above).* The renormalize is not global. It lives in
`get_state_velocity`, which has exactly one caller in the decomp — the
leave-ground/launch path — and ACE matches 1:1. Retail's ON-GROUND translation is
a different quantity entirely: both axes are issued as concurrent motions
(`:344177` + `:344182`), their cycle velocities are summed (`set_velocity` then
`combine_physics`), and `apply_physics` integrates the sum with no magnitude test.
Retail's ground diagonal therefore DOES exceed the launch ceiling, exactly as ours
does. DESIGN.md §2:186-191 had already written this down.

*What capping the charged site would have cost, concretely:*

1. **A retail divergence on a live lane.** `local_velocity_for_state` reaches the
   shipped canonical spine ungated (`system.rs:7679` → `simulation.rs:518`).
   Capping it slows the run_rate-4.5 ground diagonal from 18.386 to 18.000 m/s —
   away from retail, not toward it. The acceptance bullet explicitly forbids this
   ("must match retail, not 'sensible' physics").
2. **Two live ground producers disagreeing.** The other shipped producer,
   `interpreted_velocity_for_state` → `ground_velocity`, is uncapped for the same
   retail reason. `identity_interpreted_matches_legacy_local_velocity_for_state`
   (motion_interp.rs:2112) pins them equal and would have FAILED — verified by
   arithmetic on its own grid: `run`/`forward+strafe_right`/`run_rate=4.5` gives
   legacy 18.000 vs interpreted 18.386. "Green tests" would have required
   weakening that invariant in a file outside my scope.
3. **An I7 kill-path change.** `system.rs:4813` is the `USE_INTERPRETED_VELOCITY =
   false` rollback arm, which must stay byte-identical legacy behaviour.

*What was done instead (the minimal sound thing, I3).* The cap is implemented
exactly — same ceiling, same strict `>`, same operand order — as a primitive, and
composed into `local_state_velocity_for_state`, the launch form retail actually
applies it to. All three acceptance test bullets are met against that function
and the primitive. The ground contract is now stated in code with its four
anchors and pinned by a regression test, so the next reader does not re-litigate
this.

### DEVIATION D2 — no flag, no `url-flags.md` row

I7 asks for new behaviour behind a DEFAULT-OFF flag and the preamble asks for the
flag's row. This change alters **no live path** — `local_state_velocity_for_state`
has no callers yet and everything else is comments and tests — so there is no
behaviour to gate and no honest row to add. `url-flags.md` is untouched. The flag
question (if any) belongs to whoever wires Handoff 1; my read is that it wants
the same treatment as `USE_LEAVE_GROUND_VELOCITY` (a const in `system.rs`), not a
URL flag.

### DEVIATION D3 — build-environment fix, uncommitted

The worktree was missing `external/chorizite/Chorizite.ACProtocol`, which
`holtburger-protocol`'s `build.rs:40` canonicalizes; `cargo test` panicked in the
build script before compiling anything. Symlinked it to the main checkout
(`/home/wbterminal/WorldBuilder-ACME-Edition/external/chorizite/Chorizite.ACProtocol`).
That path is gitignored (`.gitignore:630 external/*`), confirmed with
`git check-ignore -v`, and `git status --short` stayed clean of it. Nothing was
committed for this. Other fan-out worktrees will hit the same wall.

## Remainder / follow-ups

### Handoff 1 (the live gap this investigation actually found) — `manual_intent_velocity` launches uncapped

`MovementSystem::manual_intent_velocity` (`system.rs:7638-7650`) is the launch
velocity for a **charged standing-long-jump release** (`system.rs:3192`, and the
wasm Jump arm via `handle.rs:75`). Its own doc comment already says what it is
standing in for: *"retail launches with `get_leave_ground_velocity =
get_state_velocity()` — the velocity the held keys WOULD produce"*. But both of
its arms hand back a GROUND vector:

```rust
Some(if USE_INTERPRETED_VELOCITY {
    interpreted_velocity_for_state(heading, state, &capabilities)  // ground form, uncapped
} else {
    local_velocity_for_state(heading, state, &capabilities)        // ground form, uncapped
})
```

So the one live site that genuinely wants retail's `run_rate × 4.0` ceiling does
not get it — a charged diagonal long-jump launches ~2 % hot at high run rates
(18.386 vs 18.000 m/s) and the airborne trajectory lock carries that error for
the whole arc. This is the real MOVE-F6, and it is a two-line change:

```rust
Some(if USE_INTERPRETED_VELOCITY {
    leave_ground_velocity_for_state(heading, state, &capabilities, world.player.current_planar_velocity)
} else {
    local_state_velocity_for_state(heading, state, &capabilities)
})
```

Both functions now exist and are pinned equivalent by
`capped_composition_matches_the_interpreted_leave_ground_port`. **I did not make
this change: `system.rs` is a1's ACTIVE scope (MOVE-F2-HOLDKEY / MOVE-F3-ENABLE).**
Orchestrator call — hand it to a1, or queue it as a follow-up item once a1 lands.
One caveat for whoever takes it: the ON arm's `integrator_velocity` fallback
argument needs a decision, because a charge roots the planar store near zero and
that is exactly the input `leave_ground_velocity_for_state`'s `~0` test falls back
on. `local_state_velocity_for_state` has no such fallback, which is why the OFF
arm is the simpler of the two.

### Handoff 2 — two copies of the same six lines

`cap_state_velocity` (common.rs) and the inline tail in
`MotionInterp::get_state_velocity` (`motion_interp.rs:579-583`) are both
`:343586-343593`. I deliberately did NOT dedupe: the existing copy computes
`velocity * (max_speed / magnitude)` while retail (and the new primitive) computes
`(1/magnitude) * c * max_speed`, so folding them would perturb float rounding on a
shipped jump path for zero behavioural gain, and `motion_interp.rs` is outside my
scope. The equivalence sweep pins them together instead, so drift is caught by a
test rather than by inspection. If someone does dedupe later, expect sub-ulp
movement and re-run `leave_ground_velocity_clamps_and_falls_back`.

### Handoff 3 — the `get_max_speed` consumers were not audited

`CMotionInterp::get_max_speed` is also read at `acclient.c:388572` (`× 5.0`) and
`:389235` by the interpolation manager, and `get_adjusted_max_speed`
(`:343512-343535`) is the variant that path actually prefers
(`motion_interp.rs:484` already ports it). Whether our interpolation/projection
lanes honour those ceilings is a separate question that MOVE-F6 does not answer
and I did not open.

### Not done

No wasm rebuild (Rust-only change in `holtburger-core`, no `lib.rs` edit, no JS).
No 1070 / eye-test item is created: this change alters no rendered behaviour. If
Handoff 1 lands, a charged-long-jump distance A/B at high Run skill would be the
natural eyetest rider.
