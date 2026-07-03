# Can we port the ENTIRE retail movement system faithfully? — YES. (2026-07-03)

Measured answer, not vibes. Method-level inventory of the retail movement classes
in `$DECOMP/acclient.c` vs what holtburger already mirrors (counted by
`Class::Method` citations in our crates — conservative: uncited-but-equivalent
code doesn't count), plus the translation sources available for the remainder.

## §1 Coverage today

| Retail class | decomp methods | mirrored/cited | state |
|---|---|---|---|
| CTransition (+ObjectInfo collision spine) | 31 | 34 (100%+) | **live** (faithfulTransition/retailGround, golden-tested) |
| InterpolationManager | 10 | 11 | **live** (retailLeash) |
| ConstraintManager | 7 | 8 | **live** (retailLeash, F10 offset chain) |
| StickyManager | 9 | 6 | **live** (USE_STICKY_MANAGER + R2) |
| PositionManager | 15 | 10 | **live** (the three slices above) |
| CMotionInterp | 40 | 34 (85%) | live; gaps = lifecycle + small helpers |
| MovementManager | 22 | 14 (64%) | live (A3 registry); gaps = accessors/event fan-outs |
| RawMotionState / InterpretedMotionState | 10 / 12 | ported (raw_state.rs / interp_state.rs) | **live** |
| MovementParameters / MovementStruct | — | ported (params.rs) | **live** |
| MoveToManager | 33 | 13 (39%) | driver live (USE_MOVETO_DRIVER); node machine partial |
| **CommandInterpreter** | **49** | **5 (10%)** | **THE gap — the input layer** |
| ACCmdInterp (shim layer) | 18 | ~4 | Send* shims ≈ our A13 builders; rest unported |
| update_object schedule / friction / jump | — | — | **live** (retailQuantum, calc_friction, jump_charge A14-I4) |

Holtburger's movement/spatial crates carry **757 `acclient.c:` line-citations
across 398 distinct cited sites** — the port methodology (decomp-primary,
per-function cites, unit pins, golden traces, live-ACE bot checks) is
established and battle-tested (three landed waves: transition system, position
lattice, autonomy latch).

**The remaining surface is ONE subsystem** — the input layer
(CommandInterpreter + CommandList + ACCmdInterp, ~65 mostly-small functions;
today's session read a dozen of them at ~20-60 lines each) — plus the
MoveToManager node-machine tail (~20 functions) and assorted small helpers.

## §2 The rosetta stones (all locally vendored)

1. **`acclient.c`** (final client, Hex-Rays, 31 MB) — every movement function
   present and symbol-named. Primary truth.
2. **`acclient_2013.bndb_pseudo_c.txt`** (Binary Ninja, SYMBOLIZED) — resolves
   what Hex-Rays hides: vtable dispatch. Proven today: `vfptr[6]` →
   `HandleNewForwardMovement` → body `SetAutoRun(0,1)` resolved in minutes.
   Also the cross-era diff source (2013 vs final).
3. **ACE `Physics/*`** — a complete, COMPILING C# translation of the entire
   system, including the input layer we lack:
   `Physics/Command/CommandInterpreter.cs` (885 lines), `ACCmdInterp.cs`,
   `Animation/MotionInterp.cs` (835), `Managers/MoveToManager.cs` (874),
   `Transition.cs` (1093). The ACE team already did the naming/semantics
   translation for every remaining function — we port against the decomp and
   USE ACE as the fast disambiguator (per the existing three-source rule:
   acclient.c wins).
4. **PhatSDK** (vendored: `external/GDL/PhatSDK/` — `Movement.cpp` 1314 lines,
   `Transition.cpp` 1755, `PositionManager.cpp`, `MovementManager.cpp`…) — an
   INDEPENDENT C++ translation of the same classes. Tiebreak-only, read-only
   (AGPL taint: never copy, only cross-read — house rule).
5. **State-shape ground truth** — `acclient.h` typed structs + `acclient.txt`
   PDB dump (byte offsets; the awk field-dump recall) + Chorizite ACBindings
   (offset-annotated C# bindings). Every struct field of every class above is
   byte-known.
6. **The verification rig** — golden fixed-dt traces (bit-pinned), 540+432
   crate tests, and the live-ACE headless bot loop (proven again today:
   slideCast A/B measured to the metre). ACE running its own port of the same
   logic server-side means behavioral goldens are cheap.

Four independent translations + byte-level layouts + a working behavioral
oracle. Nothing in the remaining surface is undecompiled, unnamed, or
unreferenced.

## §3 Port plan (bounded, ~3 waves)

- **Wave 1 — the input layer (the payoff wave).** Port CommandInterpreter +
  CommandList + the ACCmdInterp shims into
  `holtburger-core client/movement/command_interpreter.rs`; JS becomes a thin
  key-event forwarder (replaces the `__axisValue` reader at index.html:8395).
  This lands, FOR FREE, every quirk from the strafecast analysis — the
  per-axis stacks + head-wins pop-through, `TakeControlFromServer`'s
  full-list re-apply tail (FU-A), silent releases under server control (FU-C),
  `transient_state`, hold_sidestep/hold_run modifiers, autorun — because we
  port the class instead of approximating behaviors one flag at a time.
  ~65 small functions ≈ the size of the already-landed CTransition wave.
- **Wave 2 — MoveToManager node machine.** The Add*Node/Begin*/CheckProgress
  internals (~20 fns) against ACE MoveToManager.cs scaffolding. Unlocks full
  directive parity (server MoveTo/TurnTo + our pursuit driver on one spine).
- **Wave 3 — closure.** CMotionInterp/MovementManager lifecycle+accessor tails,
  wire packing from the widened slots (ACCmdInterp::Send* ≡ our A13 builders —
  already a pending handoff item), UseTime cadence audit vs retailQuantum.

Per-function loop (unchanged, proven): decomp body → ACE/PhatSDK cross-read →
Rust port with `acclient.c:NNNNNN` cites → unit pin → golden/live-bot check.

## §4 Honest caveats

- **Environment mapping, not fidelity gaps:** mouse-look/HandleSelectLeft and
  keyboard-focus semantics need browser-event policy decisions (DirectInput →
  DOM). The LOGIC ports faithfully; the bindings are ours to define.
- **Renderer animation binding** (CSequence timeline on the JS rig) is a
  parallel track (A4/A5 queues exist) — the movement system doesn't block on it
  (the wasm slots already carry real substates).
- **Bit-identity to retail captures** remains the known x87 decision (handoff
  item 4) — "faithful" here = same state machine, same branches, same wire;
  float-exactness to 2012 hardware is a separate, priced choice.
- Two soft spots from the strafecast analysis (the straight-line gate exact
  threshold; retail gesture-echo axis content) are wire-behavior questions a
  Wave-1 port makes TESTABLE (replay his key script through the ported
  interpreter and watch), and any surfaced 2012-17 caster pcap settles finally.

## §5 Verdict

**We can port the entire movement system faithfully.** ~70% of it already is —
live, flagged, cited, and test-pinned. The remainder is one well-sourced
subsystem (input) plus a directive tail, with four mutually-checking
translations locally on disk and a measurement loop that catches drift at the
metre and the bit. The strafecast session was the dry run for the method:
instructions in, decomp open, mechanism out, fix validated live — the same loop,
run ~85 more times, finishes the system.
