# Casting-ingredient audit + build (2026-06-06)

Goal (user): ensure the client has all the **retail casting motion ingredients** (per
`acclient.txt`/decomp), so a retail-faithful cast sequence renders fully — **independent of ACE**,
because ACE-master is known to neuter fastcasting. NOT building/forcing fastcast; just confirming the
render primitives exist. Fastcast itself is server-timed (`CastSpeed` + `MagicState.CastQueue`,
`Player_Magic.cs`); we keep ACE vanilla ([[feedback_keep_ace_vanilla]]) and only ensure the client
renders what a faithful server would send.

## Ingredient checklist (retail acclient → our client)

| Ingredient (acclient) | Role | Status |
|---|---|---|
| `forward_command` SubState (Magic* gestures, `MagicBlast 0x4000002b`…) | windup/cast gesture anim | ✅ emitted for remotes |
| `forward_speed` (= `CastSpeed`) | cast playback speed | ✅ `motion_speed` |
| Magic stance | caster pose | ✅ |
| ForwardCommand replacement | **cast-break** (move-forward cancels) | ✅ `setMotion` crossfade |
| `Actions` list (`acclient:344388` loop) | emote/gesture queue | ✅ multi-action B (`?multiAction=on`) |
| motion stamps / autonomy | dedup/order | ✅ |
| `sidestep_command/speed` (`get_state_velocity` X) | **strafe-cast footwork** | ✅ **BUILT this pass** (`?castAxes=on`) |
| `turn_command/speed` | turn-in-place cycle | ✅ **BUILT this pass** (turn-in-place; heading-ease rotates) |
| `re_modify` / `MotionState::add_modifier` (0x20000000) | held modifiers thru cycle swap | ⚠️ **DEFERRED** — high-effort multi-record Sequence concat (`entities.js:5919-5924`); anim research judged low *visible* impact (modifiers apply physics, not anim frames) |

## What was built (sidestep + turn axes)

The one genuinely-missing render ingredient: our remote `UpdateMotion` emit (`lib.rs:30634`) read
**only `forward_command`**, dropping `sidestep_command`/`turn_command` (parsed but never surfaced;
`setSidestepLayer` was local-only). So a remote mage strafe-casting showed the cast gesture but no
strafe footwork, and a remote turning in place showed idle.

- **Rust** (`lib.rs`): `MOTION_AXES` side-channel + free getter `pollMotionAxes()` — flat 5 u32
  `[guid, stance, sidestep_low, turn_low, forward_idle]`, pushed in the UpdateMotion `Invalid` block.
  Side-channel → zero touches to the 14 `EntityUpdate` literals.
- **JS** (`loop.js`): `?castAxes=on` (default OFF) → `drainMotionAxes`: sidestep → `setSidestepLayer`
  (additive strafe overlay); turn-in-place (`forward_idle`) → `setMotion(turnCmd)` (the turn cycle as
  base legwork — heading-ease still drives the actual rotation, so no double-rotate).
- Speeds deferred (1.0 — matches today's local `setSidestepLayer` per OQ-3). Default OFF = "ingredient
  available, not forced"; needs a 1070 eye-test (remote strafe-cast + turn-in-place) before flipping.

## Verdict

Casting render ingredients are now **complete except the modifier system** (deferred, low visible
impact). A retail-faithful cast/strafe/turn sequence will render gesture + speed + strafe footwork +
turn legwork + emote queue. The modifier (`re_modify`) port is the only remaining ingredient, tracked
as high-effort / low-visible.
