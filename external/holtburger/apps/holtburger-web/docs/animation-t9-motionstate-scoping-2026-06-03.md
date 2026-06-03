# T9 — MotionState machine: scoping (2026-06-03)

**Deliverable of this doc:** a go/no-go on building a client-side runtime
MotionState machine, NOT an implementation. Grounded in
`animation-deep-dive-2026-06-02.md` §"Motion Resolution & State Machine"
(Layers 1–3) and the retail structs it cites in `acclient.h`.

## TL;DR — recommendation: **NO-GO (defer, conditional)**

The DAT parser + reference for the motion state machine are **solid** (deep-dive
rates subsystems 2 and 3 "solid / 0 gaps"). What holtburger ships is a
*deliberately-reduced runtime*: single base cycle + one-shot transition link,
not the full Layer-1/2/3 machine. Building the full machine is **M–L effort**
for **low client-visible benefit**, because the server is motion-authoritative
and the reduced runtime already covers the realistic rendered cases. Defer until
a concrete visible artifact is found (trigger conditions below).

## What "T9" is (the 3-layer runtime, per the deep-dive)

1. **Layer 1 — `CMotionInterp`** (`acclient.h:31407`): resolves raw key intent
   (`RawMotionState`) → the played command+speed (`InterpretedMotionState`) via
   per-slot `adjust_motion`/`apply_run_to_command`, `get_leave_ground` velocity,
   and the 6-action `TooManyActions` cap (`MotionInterp.cs:147`).
2. **Layer 2 — `MotionState`** (`acclient.h:31081`, 24 bytes): the per-object
   stance + **modifier stack** (prepend/overlay, `add_modifier`) + **action
   queue** (append, `add_action`).
3. **Layer 3 — `CMotionTable::GetObjectSequence`**: consumes `command +
   MotionState` and rebuilds the played `CSequence` (base cycle + layered
   modifiers + queued actions).

## What holtburger does today

- **Base cycle**: `setMotion(cmd, stance)` → `try_resolve_cycle_frames` →
  `motion_data_for_cycle` → concatenated/baked `AnimationFrame`s. (One resolved
  cycle at a time.)
- **One-shot link**: `try_resolve_link_frames` plays a single stance/(from→to)
  transition flourish, then the destination cycle.
- **No** modifier stack, **no** multi-action queue, **no** Layer-1 raw→interp
  resolution for remote entities (the client receives the resolved command on
  the wire; it does not re-derive it from keys).

## Server-authority context (why the benefit is low)

ACE is position- **and** motion-authoritative. It packs the resolved
`InterpretedMotionState` on the wire (`UpdateMotion`: `current_style` +
forward/sidestep/turn command+speed, plus modifiers/actions) for **all** objects
— and the deep-dive confirms retail+ACE are bit-for-bit identical here. So a
client MotionState machine would be a **consumer** that rebuilds the played
sequence from a state the server already resolved — not an authority. The local
player's self-prediction is already handled separately (`camera.js`
`_dispatchLocalRigMotion` → integrator), so Layer-1 raw→interp resolution is
**out of scope** for the client regardless.

## Concrete gaps a full machine WOULD close

| Gap | Visible effect | Frequency in the rendered scene |
|-----|----------------|---------------------------------|
| **Modifier stack** (Layer 2 overlay) | A persistent modifier motion layered over the base cycle isn't overlaid — holtburger plays only the base cycle. | Rare. Most rendered entities (NPCs, props, doors) use a base cycle ± a one-shot; persistent layered modifiers are uncommon. |
| **Multi-action queue** (>1 queued action) | Chained one-shot actions collapse to the single one-shot-link holtburger handles. | Rare for rendered entities; matters most for the local player, who is self-predicted, not server-MotionState-driven. |
| **Full `GetObjectSequence` rebuild** on stance/modifier/action change | Edge sequence-rebuild ordering differences vs retail. | Edge-case; base-cycle + link covers the common transitions. |

## Gaps it would NOT close (out of scope)

- Movement physics / position (server-authoritative; client integrator + the
  physics-retail-parity work own this).
- Raw-key → command resolution (Layer 1) for the local player — already done in
  `camera.js`/the predictor.

## Effort estimate

**M–L.** Port `MotionState` (modifier stack + action queue) + a
`GetObjectSequence`-equivalent resolver into the wasm/JS animation path, thread
the wire `UpdateMotion` modifiers/actions into it, and layer the resulting
`CSequence` in the three.js mixer. The reference is complete (no research risk),
but it's a new runtime subsystem + mixer-layering work + a real risk of
regressing the working base-cycle/one-shot path. Not a "cleanup."

## Go / No-go

**NO-GO now.** Build it only when a **specific, reproducible visible artifact**
is identified that the reduced runtime gets wrong, e.g.:

1. A named entity whose **layered modifier** motion is visibly missing
   (base cycle plays but the overlay doesn't).
2. An entity that should play a **queued sequence of ≥2 actions** and instead
   plays only one.
3. A retail-vs-holtburger A/B that shows a sequence-ordering difference on a
   real creature/prop in the rendered world.

Until one of those exists, the deliberately-reduced runtime is the right
trade — same conclusion the deep-dive reached ("a faithful DAT parser plus a
deliberately-reduced runtime … not the full state machine").

## If greenlit — phased plan

1. **P1** — wasm `MotionState` (stance + modifier stack + action queue) mirroring
   `acclient.h:31081` / ACE `MotionState.cs`; unit-test `add_modifier` dedupe
   (incl. `substate == m`) and `add_action` append order against the deep-dive.
2. **P2** — a `GetObjectSequence`-equivalent that composes base cycle + modifiers
   + actions into the existing `AnimationFrame`/hook timeline; reuse
   `build_concatenated_motion_frames`.
3. **P3** — thread the wire `UpdateMotion` modifiers/actions (currently we consume
   only the base command) into the machine; layer the result in the three.js
   mixer.
4. **P4** — 1070 A/B eye-test on the entity from the trigger artifact.
