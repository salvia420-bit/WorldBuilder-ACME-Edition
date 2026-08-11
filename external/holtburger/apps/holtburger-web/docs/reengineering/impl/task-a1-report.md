# TASK a1 — MOVE-F2-HOLDKEY then MOVE-F3-ENABLE

Branch `fanout-D-a1` off `origin/master` (base `2946486d`). Both queue items landed,
F2 first and verified, then F3 on top, as the card requires.

## What landed (commits)

| Commit | What |
|--------|------|
| `62423506` | **MOVE-F2** — the base gait is the interpreter's `hold_run`, not the last drive |
| `a74514e6` | **MOVE-F3** — `CommandInterpreter::Enable` finally has a caller (world entry) |
| `25f738f1` | MOVE-F3 fixup — the two new fns had swallowed `ingest_key_edge`'s doc comment |

Files touched (all in scope; nothing outside it):

- `crates/holtburger-core/src/client/movement/system.rs`
- `crates/holtburger-core/src/client/movement/system/tests.rs`
- `crates/holtburger-core/src/client/movement/command_interpreter.rs`
- `crates/holtburger-core/src/client/movement/retail_behavior_tests.rs`

`movement/common.rs` (a2's ACTIVE scope) was **not** touched. No wasm/JS/doc files were
touched; `pkg/` untouched.

### F2 — the defect and the fix

`ingest_key_edge` seeded the composed drive from `active_drive` **wholesale, gait
included**:

```rust
let base = match self.active_drive {
    Some(ActiveDriveState { intent: ActiveDriveIntent::Manual(state), .. }) => state,
    _ => MotionState { gait: Gait::Run, ..MotionState::default() },
};
```

So any **non-interpreter** drive installer poisoned the gait: a plugin/script
`setMovementInput` → `ManualHeld(run=false)` (`lib.rs:52832`), the A14-I2 pursuit-end
restore, or the CLI lane all write `active_drive` directly. One stray walk-gait drive
persisted Walk into **every later key edge**, with no way back but a Shift tap. That is
the stuck-walk bug; the JS-side F1 guard is its stopgap.

Retail has no such channel. The gait lives in the minterp's persistent
`raw_state.current_holdkey`, and the interpreter's `hold_run` is its only upstream (see
the anchors below). The fix therefore keeps the **axes** carrying (an edge dispatches
ONE axis; the others keep their last-applied slots) and re-derives the **gait** from
`interp.hold_run`:

```rust
fn interp_base_drive(&self, interp: &CommandInterpreter) -> MotionState {
    let gait = if interp.hold_run != UI_TOGGLES_RUN { Gait::Run } else { Gait::Walk };
    match self.active_drive {
        Some(ActiveDriveState { intent: ActiveDriveIntent::Manual(state), .. }) =>
            MotionState { gait, ..state },
        _ => MotionState { gait, ..MotionState::default() },
    }
}
```

Two notes on shape:

1. **`interp_base_drive` replaced BOTH seed sites.** The card names only
   `system.rs:2607-2619` (`ingest_key_edge`), but `pump_cmd_interp_use_time` had the
   byte-identical `active_drive`-inherited seed (pre-change `system.rs:2739-2748`) —
   the same defect, reachable through the FU-A `use_time` revival instead of an edge.
   Fixing one and not the other would have left the stray-walk poison alive on the
   reclaim path. Recorded here rather than as a DEVIATION: it is the same defect in the
   same file, not a departure from the recipe.
2. **`UI_TOGGLES_RUN` is a new const**, read by BOTH the seam
   (`SystemInterpreterSeams::ui_toggles_run`, which previously returned a bare literal
   `true`) and the derivation, so retail's `hold_run XOR UITogglesRun` can never be
   evaluated against two different options.

On the pure interpreter lane the change is a **no-op by construction**: gait only ever
changed via `SetHoldRun`, which writes `interp.hold_run` and then re-derives through the
seam, so the derived value equals the value `active_drive` was carrying. It bites
exactly when a foreign installer wrote `active_drive` — the bug.

### F3 — `enable()` gets its caller

`CommandInterpreter::enable` (`command_interpreter.rs:755`, now `:757`) had **zero
callers** and carried `#[allow(dead_code)] // staged: enable/disable lifecycle wiring`.
The interpreter also materialized **lazily on the first key edge**, so until the player
touched the keyboard the `?cmdInterp=on` lane had no interpreter at all — no `IsActive`,
no `UseTime` pump, no attach sequence.

Landed: `attach_command_interpreter_at_world_entry` runs retail's `SetSmartBox`
(`:716822`) → `Enable` (`:716912`) pair on the first in-world tick (`cmd_interp_enabled()
&& command_interpreter.is_none() && world.player.guid != Guid::NULL`), called from
`tick` immediately before the drive-command ingest loop so a first key edge **in the same
tick** already finds an enabled interpreter. The lazy construction survives as the
fallback for paths that reach an edge without a tick between (direct-ingest tests, a flag
flipped mid-tick); both sites now go through one `new_command_interpreter`, so the
`?castMove`/`?slideCast` alias seeding cannot drift between them.

**The composed drive the attach produces is deliberately DISCARDED**, and that is
debug-asserted (`seams.drive == base`, `interp.effects.is_empty()`). Attach is a
lifecycle event, not an input edge; installing an idle manual drive there would stomp
whatever `active_drive` holds (an autonomous steer, a server MoveTo). Nothing else in the
sequence reaches `self`/`world`: under autonomy `SetHoldRun` only calls
`minterp_set_hold_run`, which writes the seam's local drive.

**Sequencing was load-bearing, exactly as the queue said.** Pre-F2 the persistent gait
was `active_drive`'s, so an `Enable` re-assert wrote into a field the next edge
overwrote. Post-F2 `hold_run` IS the gait truth, so the re-assert establishes it at world
entry.

**Honest scope of F3's observable effect.** Because F2 made `hold_run` the live
derivation source (rather than mirroring it into a separate minterp field), `Enable`'s
re-assert is gait-**neutral** in our port — it re-asserts a value the derivation already
reads. F3's real deliverables are therefore: (a) retail lifecycle parity with a real
caller for `enable()`, and (b) the interpreter existing from world entry instead of from
the first keypress. I measured the blast radius of (b) and it is inert on today's code:
`use_time`'s position-event gate cannot open (the seam pins `cur_time` 0.0 and
`player_contact_plane_equals` true), and its FU-A arm needs a non-empty list head or
`auto_run`, neither of which can exist before the first edge. The one other consumer that
branches on the interpreter's existence — the `SelfServerControlledMotion` slidecast
read at `system.rs:7924-7930` — falls back to the same `?slideCast` carrier the
constructor seeds from, so its value is unchanged.

## Tests run + results

All from `external/holtburger/`, toolchain
`/opt/rust/toolchains/1.95.0-x86_64-unknown-linux-gnu/bin` (bare `cargo` hits "no rustup
default" on this box).

| Command | Result |
|---|---|
| `cargo test -p holtburger-core` (final, HEAD `25f738f1`) | **627 passed, 0 failed, 1 ignored, 0 filtered** (628 total; 2nd binary 0/0) |
| `cargo test -p holtburger-core` (base `2946486d`) | 624 passed, 0 failed, 1 ignored (625 total) |
| `cargo test -p holtburger-core cmd_interp` (after F2) | 12 passed, 0 failed |
| `cargo check -p holtburger-core --tests` | clean (pre-existing warnings only) |
| `cargo check -p holtburger-web --target wasm32-unknown-unknown` | **rc=0**, 15 pre-existing warnings — the core change does not break the wasm build |
| `cargo test -p holtburger-cli` | **does not build — PRE-EXISTING**, see below |

Net **+3 tests** (625 → 628). The 1 ignored is `client::movement::system::tests::golden::regen`
(a golden-regeneration helper, ignored on base too; my items cite no `#[ignore]`d
real-DAT differ, so none were run with `-- --ignored`).

### The three new tests

1. `cmd_interp_base_gait_ignores_a_stray_walk_manual_set` (`system/tests.rs`) — **the F2
   acceptance case, verbatim from the card**: install `ManualHeld(run=false)` on one
   tick, then a W edge on the next; the installed drive must be `Gait::Run`, the JS
   `DriveApplied` event must read `run: true`, and a following Shift press must still
   walk (the fix does not pin the gait to Run).
2. `cmd_interp_enable_attaches_at_world_entry` (`system/tests.rs`) — **the F3 acceptance
   case**: one in-world tick with **no key edges and no drive intents** must leave the
   interpreter attached, `is_enabled()`, `is_active()`, `hold_run == false` (Enable
   re-asserts the current latch, it does not invent one), `active_drive` still `None`,
   and zero `CmdInterpEvent`s. A following W edge then runs normally.
3. `cmd_interp_world_entry_attach_is_gated_by_the_flag` (`system/tests.rs`) — the kill
   path: `?cmdInterp=off` attaches nothing.
4. `t_enable_reasserts_the_current_hold_run` (`retail_behavior_tests.rs`) — real-only
   (the P15 oracle models the key alphabet, not the attach sequence): Shift latch →
   `Disable` (drops it, `:716893`) → re-arm → `Enable`, pinning that `enabled` comes back
   true and the **current** `hold_run` is what gets pushed through `SetHoldRun`. Required
   adding one recording field (`hold_run_asserts`) to `SinkSeams`, whose
   `minterp_set_hold_run` was a bare `{}`; purely additive, the dual-run pins are
   untouched.

### Both new pins were checked to actually FAIL pre-fix

Not asserted — measured, by reverting the change and re-running:

- F2: with the one line put back to `MotionState { gait: state.gait, ..state }` →
  `assertion left == right failed … left: Walk right: Run` at `tests.rs:9151`. Restored,
  green.
- F3: with `self.attach_command_interpreter_at_world_entry(now, world);` commented out →
  `cmd_interp_enable_attaches_at_world_entry` FAILED at the
  `expect("F3: world entry attached the interpreter without a key edge")`. Restored,
  green.

### Pre-existing failures (not this branch's)

`cargo test -p holtburger-cli` fails to **compile** on the `tui` bin test with
`error[E0277]: std::cell::Cell<u64> cannot be shared between threads safely`. Verified
pre-existing by `git stash`-ing my working tree and re-running on clean base — identical
error. Not touched, not fixed here.

`cargo fmt -p holtburger-core -- --check` reports diffs across the crate (the tree is not
rustfmt-clean and never has been). I confirmed **none of the diffs fall in my new code**
(grepped the fmt output for `interp_base_drive`, `attach_command_interpreter`,
`new_command_interpreter`, `UI_TOGGLES_RUN`, `hold_run_asserts`, and both new test names
— zero hits), and did NOT run `cargo fmt`, which would have reformatted the whole crate.

## Read-verified anchors

All read this session from `~/ac-headers/acclient.c` / `acclient.h` with `rg -a`,
anchored by symbol. Definition lines (no trailing `;`) confirmed.

| Claim | Anchor | Verified |
|---|---|---|
| `CMotionInterp::adjust_motion` | `acclient.c:343746` (def) | ✅ card said `:343799`, which is the **holdkey read inside it** — both correct, recorded as the pair |
| the holdkey fallback | `:343799-343804` — `if (key == HoldKey_Invalid) v10 = v4->raw_state.current_holdkey;` then `LOBYTE(v11) = v10 == 2; if (v11) apply_run_to_command(...)` | ✅ |
| `HoldKey` enum | `acclient.h:3396-3398` — `Invalid=0, None=1, Run=2` | ✅ (so `current_holdkey == 2` is the Run test) |
| `apply_raw_movement` passes the per-axis holdkeys | `acclient.c:344259` (def), calls at `:344281`, `:344286`, `:344291` | ✅ |
| the ONLY writer of `current_holdkey` | `CMotionInterp::set_hold_run` `:344492` (def) — `if ((val == 0) != (this->raw_state.current_holdkey != 2)) { current_holdkey = (val != 0) + 1; apply_current_movement(...); }` | ✅ |
| `CommandInterpreter::SetHoldRun`'s XOR | `:716978` (def) / `:716990-716991`; our port at `command_interpreter.rs:1000-1003` | ✅ |
| `CommandInterpreter::Enable` | `:716912` (def) — `v2 = this->hold_run; this->enabled = 1; vfptr[2].OnLoseFocus(v2)` — read BEFORE the flip | ✅ card anchor exact |
| `CommandInterpreter::SetSmartBox` | `:716822` (def) — `player = i_smartbox ? i_smartbox->player : 0` | ✅ |
| `CommandInterpreter::Disable` | `:716893` (def) — ClearAllCommands → SetHoldRun(0) → hold_sidestep=0 → … → `enabled = 0` | ✅ (used by the new lifecycle pin) |
| `TakeControlFromServer`'s hold_run re-assert | `:716934` (def), re-assert at `:716950` | ✅ — this is the "control reclaim" half of F3, **already present** in our port (`command_interpreter.rs:957-958`); F3 only owed the world-entry half |
| `ACCmdInterp::UITogglesRun` | `:435818` | ✅ (cited for the new const's doc) |
| our `enable()` at `command_interpreter.rs:755` with zero callers | confirmed by `rg -n 'enable\('` before the change + the `#[allow(dead_code)]` on it | ✅ card anchor exact |
| base-gait seed at `system.rs:2607-2619` | confirmed exact | ✅ card anchor exact |

**Anchor that could NOT be verified, recorded per I4:** retail's own **call sites** for
`Enable`. Every call is vtable-dispatched (`((void (*)(void))this->vfptr[N]…)`) — `rg -a`
on `SetSmartBox(` likewise returns only the declaration and the definition, no callers.
So the retail *body* is read-verified but the retail *site* is not recoverable from the
decomp; world entry is holtburger's choice, made per the queue card's instruction
("wire enable() at world entry / control reclaim"). Stated in the code doc and the commit
message rather than implied.

## Acceptance

| Card bullet | Status | Evidence |
|---|---|---|
| New test: `ManualHeld(run=false)` then a W edge still RUNS (F2) | **MET** | `cmd_interp_base_gait_ignores_a_stray_walk_manual_set`; fails Walk/Run on the pre-fix seed |
| A test or read-verified call-site proving `enable()` fires at world entry (F3) | **MET (both)** | test `cmd_interp_enable_attaches_at_world_entry` + the call site `system.rs` `tick` → `attach_command_interpreter_at_world_entry` → `interp.enable(&mut seams)` |
| `cargo test -p holtburger-core` green | **MET** | 627 passed / 0 failed / 1 ignored |
| Risk note: shipped default lane — keep it minimal, cite retail for every behavioral choice | **MET** | see the two DEVIATION/decision blocks below; every behavioral choice carries a `:line` anchor in-code |

## DEVIATIONS (I3)

**D1 — the F2 test went to `system/tests.rs`, not `retail_behavior_tests.rs`.** The card
says "Add retail_behavior_tests case". `retail_behavior_tests.rs` is a *self-contained
interpreter-level* fixture file (a `CommandInterpreter` + a recording `SinkSeams`); it
has no `MovementSystem`, no `active_drive`, and therefore cannot express
`ManualHeld(run=false)` at all — the defect lives at the system/seam boundary. My task
section anticipated this ("retail_behavior_tests **or** the movement test module — find
where ManualHeld-style cases live"): they live in `system/tests.rs`, next to
`cmd_interp_hold_run_edge_installs_gait`, whose house style the new test matches.
`retail_behavior_tests.rs` still gained the F3 lifecycle pin, which *is* expressible
there.

**D2 — no new URL flag, and no `url-flags.md` row.** I7 wants new behavior default-OFF
behind a SPEC-named flag. Neither MOVE-F2 nor MOVE-F3 names one, and both are root-cause
fixes *on* the shipped default lane — F2's gate is literally "root-cause fix for the
stuck-walk bug (F1 JS guard is the stopgap)", so landing it default-OFF would leave the
bug live and the stopgap load-bearing. `?cmdInterp=off` remains the kill path for this
entire lane and is unchanged. `url-flags.md` was therefore not touched (no row is owed;
the existing `cmdInterp` row 1103 belongs to the flag, not to these items, and I7 forbids
editing rows outside my item).

## Decisions taken (not deviations, but load-bearing)

**Both base-gait seed sites, not one.** See "What landed" note 1.

**The attach discards its composed drive.** See the F3 section. The alternative —
installing it — would stomp `active_drive` at world entry.

**I did NOT add retail's change-guard to `minterp_set_hold_run`.** Retail's
`CMotionInterp::set_hold_run` (`:344494`) is a **no-op when the effective gait is
unchanged**; our seam impl (`system.rs`, `minterp_set_hold_run`) unconditionally sets
`drive.gait` **and `dispatched = true`**. That means every unchanged-gait re-assert —
`TakeControlFromServer`'s at `:716950`, `UpdateToggleRun`'s — currently marks the seam
session "dispatched". Adding the guard is retail-faithful and would remove a small class
of spurious dispatches, but it is a behavioral change on the shipped default lane that
neither card asked for, so I left it and made the attach path immune by discarding its
drive instead. **Recorded as a follow-up** (below) rather than silently taken.

## Remainder / follow-ups

1. **`minterp_set_hold_run` lacks retail's change-guard** (`acclient.c:344494`) — see the
   decision above. Candidate one-line fix: only write `drive.gait`/`dispatched` when the
   effective gait actually changes. Wants its own A/B because it fires on the default
   lane through `TakeControlFromServer`; `cmd_interp_hold_run_edge_installs_gait` and the
   new F2 pin both still pass under it (I reasoned it through but did **not** land or
   test it).
2. **The F1 JS stopgap is now redundant** — F2 removes its cause. It lives in
   `apps/holtburger-web/` (outside my scope) and I did not touch it. Retiring it should
   be a separate item so the two can be A/B'd independently; until then the guard is
   harmless (it can only force run, which is now what the interpreter derives anyway).
3. **`enable()`'s siblings are still unwired.** `new_player` (`:716859`),
   `player_teleported` (`:716924`), `handle_log_off` (`:716956`), `handle_exhaustion`
   (`:717617`), `update_toggle_run` (`:717627`) all still carry
   `#[allow(dead_code)] // staged: …`. In particular **`player_teleported` is the obvious
   next one**: a portal/teleport should `SetAutoRun(0,1)` + `SendMovementEvent`, and
   nothing does today. Out of this card's scope.
4. **No wasm was rebuilt and nothing was deployed.** `cargo check -p holtburger-web
   --target wasm32-unknown-unknown` passes, but a `wasm-pack` build + a live arm is owed
   before these reach a browser — the batch-D note says these CODE items need a wasm
   rebuild. **No live/1070 verification was performed** (no browser on this box, and the
   card gates no eye test). The behavior change is unit-pinned only.
5. **Build-environment note, not a repo change:** the worktree was missing
   `external/chorizite/Chorizite.ACProtocol` (gitignored vendored content, so worktrees
   don't get it), which makes `holtburger-protocol`'s build script panic and blocks every
   Rust build. I symlinked it to the main checkout's copy. That path is gitignored, so
   nothing was committed — but every fanout worktree will hit it.

## Hygiene

Never pushed, never rebased, never `git add -A` — each commit staged its explicit paths.
The queue JSON, `ORCHESTRATOR-HANDOFF.md`, `SPEC.md`, `IMPLEMENTATION.md` and
`url-flags.md` were read but not edited. `git status` is clean apart from this report.
