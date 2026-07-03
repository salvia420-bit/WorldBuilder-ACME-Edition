# Movement-port WAVE 1 — consolidated verdict (2026-07-03)

Pipeline ran end-to-end today: repo `8f222ff8` pushed → buildbox 16× Opus 4.8
fan-out (~35 min, packets P01-P16 per `movement-port-wave1-spec`) → tarball
sha-verified → VM stopped → two-agent Fable quality pass on the laptop.

Artifacts (laptop): `~/from-vm/wave1.tgz` (+.sha256), extracted
`~/from-vm/wave1/parts/p01..p16.md` (~535 KB), reports
`~/from-vm/wave1/QUALITY-fidelity.md` + `QUALITY-integration.md`.

## Yield

Fidelity (adversarial, decomp-verified sampling of every code packet):
**10/13 CONFIRMED branch-exact**, p01 DRIFT-minor, p07 DRIFT (3 findings),
p12 one invented write. **PhatSDK/AGPL sweep clean.** Integration arm:
**21 seam conflicts** (6 behavioral, 8 type/shape, 3 structural, 4 info) +
ranked adjudication list + landing order. The two arms independently found the
SAME top defects — treat the findings as settled.

## Must-fix before landing (the short list)

1. **Direction-name flip (p01, duplicated in p02, poisoned p16):** retail
   `command_strings` (acclient.c:43468): 0x6500000D=TurnRight, 0x0E=TurnLeft,
   0x0F=SideStepRight, 0x10=SideStepLeft. p01 named all four the opposite
   (numerics/logic correct). Rename on merge; REJECT p16's "ACE divergence D6"
   (it was derived from the flip — no divergence exists).
2. **p07 vtable misresolutions (agent skipped the resolver dump):**
   post-dispatch call in HandleSelectLeft/:717198 + HandleMouseMovementCommand
   /:717341 is **SendMovementEvent** (flat 19), NOT ApplyCurrentMovement; the
   :717378 pre-dispatch hook is **TakeControlFromServer** (flat 26 — FU-A on
   the mouse path, strafecast-relevant); `command_turn_to_heading` must gate on
   IsActive (= enabled && player), not enabled alone.
3. **p15 oracle terminal:** `HandleKeyboardCommand` tail is
   `if cmd != 0x2500003B (Jump) → SendMovementEvent` (not
   HandleNewForwardMovement).
4. **p12:** drop the invented `self.moving_away = move_away` at the
   move_to_object_internal probe site (only BeginMoveForward :345424 latches it).
5. **Gap M1 (no packet delivered):** the RawState→wire `RawMotionState`
   converter for the send path.

## Structural rulings (integration arm, decomp-verified)

- ONE `CommandInterpreter` struct (P08's session state as base), inherent
  methods, a single ~15-method outward seam trait — the nine per-packet trait
  worlds do not compose (&mut re-entrancy).
- Input entry: JS forwards input-action ids → wasm `on_action` → `set_motion`
  → `handle_keyboard_command`. P14's two wrong constants corrected: autorun =
  0x090000C7; `w` → WalkForward 0x45000005. MoveToState-only sends stand
  (TurnToEvent 0xF649 stays NO-GO).
- **Errata to my own docs:** the "2013" dump is the SAME binary as acclient.c
  (VA-identical) — it is a symbolized NAME RESOLVER, not an era cross-check;
  the feasibility doc's "cross-era diff" line is void. Also spec errata: no
  0x40 in the moveto WeenieError family; StopListHeadMovement is :717150.

## Landing order (next session(s))

Step 0 the must-fix edits above → Step 1 leaf packets in parallel (P13, P10;
P11 lands as TESTS ONLY — its five methods already exist in move_to.rs with
identical signatures; P12 folds — its "missing" *_Internal fns are stale) →
Step 2 P01→P02 (list engine) → Step 3 the unified interpreter (P03-P09 folded;
P15 fixtures dual-run oracle-vs-real) → Step 4 dark lanes behind `?cmdInterp`
default-OFF + the M1 converter → Step 5 flag migration (`?castMove`/`?slideCast`
become interpreter-native) + ONE batched 1070 live-bot A/B before any default
flip. Go: P01-P06, P08-P11, P13-P15; conditional: P07 (fixes first); partial:
P12, P16.

Bonus answers banked by the pass: 0x2500003B = Jump (p02 OQ-1);
CommenceJump's odd tail ≈ COMDAT-folded no-op (corroborated :339396); retail
CleanUpAndCallWeenie ignores `status` (ACE diverges); ctor seeds
autonomy_level=2, controlled_by_server=1; the verified flat-slot vtable table
is in QUALITY-fidelity.md.
