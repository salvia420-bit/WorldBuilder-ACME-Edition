# Wave 2 Phase 2.2 — Diagonal Composition Validation (2026-05-26)

**Status:** validation finding; no code change in this wave. Awaiting user decision on Option A vs Option B for a follow-on wave.

**Context:** Wave 2 of the movement-animation overhaul plan
(`docs/movement-animation-overhaul-plan-2026-05-26.md:103-107`).
This phase asks whether W+D (forward + strafe right) emits BOTH a
`forward_command = WalkForward` AND a `sidestep_command = SideStepRight`
on the wire simultaneously, matching retail's `InterpretedMotionState`.

## Wire contract — what retail / ACE actually accept

Retail `RawMotionState` is a struct with three independent slots
(`~/ac-headers/acclient.c:332564-332578` — `RawMotionState::RawMotionState`
constructor, and `:332970-333113` — `RawMotionState::Pack`):

```text
current_holdkey
current_style
forward_command  + forward_holdkey  + forward_speed
sidestep_command + sidestep_holdkey + sidestep_speed
turn_command     + turn_holdkey     + turn_speed
actions[]
```

All three slots are packed into the same wire packet (per the bitfield
ladder at `acclient.c:333000-333024`). When the player holds W+D,
retail's `RawMotionState::ApplyMotion` (`acclient.c:332852-332921`)
populates the forward slot via the default branch (`motion &
0x40000000 → forward_command = motion`) and the sidestep slot via case
`0x6500000Fu` (`sidestep_command = motion`). The packet carries BOTH.

ACE mirrors this exactly. `RawMotionState`
(`external/ACE/Source/ACE.Server/Physics/Animation/RawMotionState.cs:7-115`)
has the same three independent field groups and the same
`ApplyMotion` switch. Server-side, `MotionInterp.apply_raw_movement`
(`external/ACE/Source/ACE.Server/Physics/Animation/MotionInterp.cs:506-523`)
copies all three pairs from `RawState` to `InterpretedState` and then
calls `apply_interpreted_movement`
(`MotionInterp.cs:440-504`) which dispatches forward, sidestep, and
turn motions to `DoInterpretedMotion` independently in sequence.

**Conclusion:** the ACE wire shape FULLY supports two simultaneous
motion commands per state. There is no server-side filtering that
would drop one in favor of the other.

## Our wire — already supports the retail shape

`crates/holtburger-protocol/src/messages/movement/types.rs:445-505`
defines a `RawMotionState` with separate `forward_command`,
`sidestep_command`, and `turn_command` fields, plus the flag bits
(`RawMotionFlags::FORWARD_COMMAND`, `SIDE_STEP_COMMAND`, `TURN_COMMAND`)
that signal which slots are populated. Pack/unpack code at
`:445-505` reads/writes each field independently. The wire layer is
fine.

## Our MotionState — single-valued, mismatched

The structural mismatch is in
`crates/holtburger-core/src/client/movement_types.rs:70-76`:

```rust
pub struct MotionState {
    pub gait: Gait,
    pub locomotion: Option<Locomotion>,  // ← single-valued
    pub turning: Option<Turn>,
    pub turn_speed: Option<f32>,
}
```

`Locomotion` is one of `{Forward, Backstep, StrafeLeft, StrafeRight}`
(`movement_types.rs:56-62`). Holding W+D produces a `MotionState`
with `locomotion = Some(Forward)` — and the `D` axis is silently
dropped per the priority rule at
`apps/holtburger-web/src/lib.rs:20508-20516`:

```rust
if forward > 0      { builder = builder.forward(); }
else if forward < 0 { builder = builder.backstep(); }
else if strafe > 0  { builder = builder.strafe_right(); }
else if strafe < 0  { builder = builder.strafe_left(); }
```

When that state reaches `build_motion_state_raw_motion_state`
(`crates/holtburger-core/src/client/movement/common.rs:143-189`), only
ONE of `{forward_command, sidestep_command}` gets populated on the
wire — never both.

## Visual / behavioural impact today

- **Server-side:** ACE sees `forward_command = WalkForward` only.
  It moves the player forward at walk/run speed.
- **Other clients (remote observers):** receive UpdateMotion with the
  same single forward command. They render the local player walking
  STRAIGHT forward, not diagonally.
- **Local client (us):** the wasm integrator still adds two velocity
  components on the JS side (the input layer reads W+D and the
  movement system has separate forward + strafe vectors), so the
  PLAYER physically moves diagonally — but the rig only plays the
  walk-forward clip. No sidestep-arm overlay. Net effect: the player
  slides diagonally with a straight-walk animation. Visible if you
  look closely; not catastrophic.
- **Wire-conformance with ACE:** when the server reconciles, it sees
  the player position drift diagonally without a corresponding
  sidestep command. Currently masked by the heartbeat / position
  broadcast loop, but a long-running shift+W+D would accumulate
  drift that ACE's position validator could flag.

## Two options for closing the gap

### Option A — Make `MotionState` carry forward AND sidestep

Replace `locomotion: Option<Locomotion>` with two fields:

```rust
pub struct MotionState {
    pub gait: Gait,
    pub forward: Option<ForwardLocomotion>,   // Forward | Backstep
    pub sidestep: Option<SidestepLocomotion>, // Left | Right
    pub turning: Option<Turn>,
    pub turn_speed: Option<f32>,
}
```

- **Pros:** matches retail/ACE wire shape exactly. Diagonal animation
  blends naturally in the renderer (the AnimationCache can fetch
  both `cycles[(stance, WalkForward)]` and `cycles[(stance, SideStepRight)]`
  and the three.js mixer's weight system blends them).
- **Cons:** structural change with ripples across ~6+ call sites:
  - `MotionStateBuilder::strafe_left/strafe_right` and `forward/backstep`
    methods (`movement_types.rs:111-129`)
  - `build_motion_state_raw_motion_state` populates both forward/sidestep
    independently (`common.rs:143-189`)
  - `local_velocity_for_state` (`common.rs:203-224`) and `local_locomotion_speed_for_state`
    (`common.rs:191-201` post-Phase-2.1) compose both vectors via
    geometric (NOT arithmetic) sum, ~1.41× speed at 45°
  - `MovementSystem::autonomous_wire_motion_state`
    (`system.rs:343-389`) picks one or the other based on planar
    delta direction; would need to expose both axes
  - 12+ tests in `crates/holtburger-core/src/client/movement/system/tests.rs`
    that construct or pattern-match `MotionState`
  - Wasm `motion_state_for_input` (`apps/holtburger-web/src/lib.rs:20494-20533`)
    drops the `else if strafe …` priority chain and unconditionally
    calls both `.forward()`/`.backstep()` AND
    `.strafe_left()`/`.strafe_right()`

### Option B — Keep single-valued, document the gap

No code change. Note that:

- Visual fidelity loses the sidestep-arm overlay on diagonal walk.
- Wire conformance loses the simultaneous sidestep_command broadcast.
- Local diagonal velocity still happens because the JS / wasm
  integrators integrate two axes — only the *animation* is gapped.

- **Pros:** zero surface area; ship Wave 2's other phases without
  touching the type system.
- **Cons:** keeps the visual gap and the wire mismatch open.

## Recommendation

**Defer to user.** Option A is the retail-correct path per the wire
contract above, but it's a structural change that's better reviewed
as its own wave than buried in Wave 2. Option B is safe enough for
the short term — the renderer plays a walk-forward clip while the
player slides diagonally; not great, but not broken.

If the user approves Option A, the natural breakdown is a separate
phase:

1. Split `Locomotion` into `ForwardLocomotion` + `SidestepLocomotion` enums
2. Update `MotionState` fields and `MotionStateBuilder` API
3. Update `build_motion_state_raw_motion_state` to populate both slots
4. Update `local_velocity_for_state` to sum forward + sidestep vectors geometrically
5. Update `motion_state_for_input` in wasm to remove the forward-priority `else if`
6. Update tests
7. Add a wire-conformance fixture for "W+D simultaneous"
8. Renderer-side: extend `setMotion` to handle a second concurrent locomotion
   command (today it only routes one cmd → one cycle clip; would need to
   add forward + sidestep weighted blend via three.js mixer weights)

Estimated surface: ~12 files, ~150-200 LoC including tests, with a wire-format-contract
review on the conformance fixtures.

## Status of Phase 2.2 in Wave 2

- **Validation:** done. ACE wire supports two simultaneous motions.
- **Implementation:** not in this wave (Option A deferred to user
  approval; Option B is the no-op default).
- **Wave 2 exit gate impact:** Wave 2 still passes — the other three
  phases (2.1 backstep/sidestep speed scaling, 2.3 walk→run motion
  swap, 2.4 turn-in-place gating) close their respective gaps. The
  diagonal-animation overlay is the only piece left dangling, and
  it's a visual polish item, not a correctness regression.
