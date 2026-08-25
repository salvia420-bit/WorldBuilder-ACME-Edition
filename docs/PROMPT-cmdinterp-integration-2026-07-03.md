# PROMPT — land the wave-1 CommandInterpreter port (dark lane, zero regressions)

You are integrating a 16-packet Opus fan-out that translated the retail AC
client's movement INPUT LAYER to Rust. The translation is done and
quality-passed; your job is Step 0 onward of the landing order — carefully,
because this session's predecessor landed live-validated movement work TODAY
that the new code overlaps. Treat that live behavior as the regression
baseline, not as scaffolding to sweep away.

## Read first, in this order (≤30 min)

1. `docs/movement-port-wave1-verdict-2026-07-03.md` — must-fix list, structural
   rulings, landing order. This is your work order.
2. `~/from-vm/wave1/QUALITY-integration.md` — the 21 seam conflicts (SC-1..21),
   adjudication table, M1/M2 gaps, verified constants.
3. `~/from-vm/wave1/QUALITY-fidelity.md` — per-packet verdicts + the VERIFIED
   flat-slot vtable table (use it; do not re-derive).
4. `~/from-vm/wave1/parts/p01..p16.md` — the source material you are merging.
5. `docs/strafecast-mechanism-analysis-2026-07-03.md` — the behavior this must
   reproduce (TakeControlFromServer full re-apply tail = FU-A, silent releases
   = FU-C, transient_state, head-wins pop-through).
6. `docs/HANDOFF-physics-parity-mage-pvp-2026-07-03.md` (session-2 section) +
   the `?castMove`/`?slideCast` rows in `apps/holtburger-web/docs/url-flags.md`
   — what is LIVE and VALIDATED today.

## Architecture law (non-negotiable)

- **Rust owns the machine; three.js drives frames.** The CommandInterpreter
  lands in `holtburger-core` (wasm): ONE struct (P08 session state as the
  base), inherent methods, ONE outward seam trait (~15 methods) per the
  integration ruling — the per-packet trait designs do not compose. JS shrinks
  to a raw-input forwarder (key/mouse events or input-action ids into wasm)
  plus obedient renderer reactions to events the interpreter emits. No
  movement DECISION may live in JS when the interpreter lane is on — over the
  migration, today's JS keystate reader (`__axisValue` + sig-diff at
  index.html:8624), the W3.1 local forward `setMotion` prediction, the
  sidestep-overlay trigger, and the anim-break cast-cut all become CONSUMERS
  of interpreter events (e.g. "forward slot evicted" → JS cuts the clip),
  never deciders.
- Strangler pattern: everything lands behind **`?cmdInterp` (default OFF)**.
  The existing input lane (`setMovementInput` → ManualSet → castMove/slideCast)
  stays byte-identical while the flag is off. No default flip this session —
  that waits for the parity harness + one batched 1070 live-bot A/B.

## Conflict contract — the part that will bite if skipped

Before writing code, produce (in your plan file) an **ownership handover
table** for every piece of state both lanes touch; when `?cmdInterp=on`,
exactly ONE writer exists per row, and both lanes must never drive in the same
tick. Rows you must cover (all in
`crates/holtburger-core/src/client/movement/system.rs` unless noted):

- `last_move_was_autonomous` (the latch): today written by ManualSet edges +
  `note_server_authored_motion`; interpreter-on, DoMotion/StopMotion and the
  SetObjectMovement stamp own it.
- `last_manual_drive` (held-keys truth): today the raw record feeding autorun
  restore, jump standstill, and slideCast's `persist_held_manual_axes`;
  interpreter-on, the three CommandLists ARE held-keys truth — those consumers
  must read the interpreter (or its snapshot), not a second copy.
- `pending_take_control` / `consume_pending_take_control` (FU5): SUPERSEDED by
  the ported `TakeControlFromServer` **including its FU-A re-apply tail** — it
  must not double-fire with the old path.
- `merge_manual_edge` (castMove Fix A) + `interpreted_drive_state`: the
  interpreter's per-axis DoMotion dispatch replaces the merge when on; the
  drive consumption seam must be explicit.
- `?slideCast` (`persist_held_manual_axes`, movement_manager.rs): keeps working
  in BOTH lanes; interpreter-on it sources held axes from the CommandLists.
- A14-I2 pursuit (`wasmPursuit`, cancel/restore arbitration), A14-I3 autorun
  overlay, `jump_charge.rs` (P09/P13's CommenceJump/DoJump must wrap the
  EXISTING jump-charge machinery, not re-implement it), the A13 send builders
  in `common.rs` (P09 maps Send* onto them — zero new send sites; TurnToEvent
  0xF649 stays NO-GO), and gap M1 (the RawState→wire RawMotionState converter
  — you write it, tested against `build_motion_state_raw_motion_state`).
- JS side (apps/holtburger-web/index.html:8395-8790): the sig-diff reader, the
  `CAST_MOVE_ON` anim-break cut and `lastForwardAxis` tracker (added TODAY),
  `setSidestepLayer`, `__inputFunnelOn`/InputController — each gets a
  `?cmdInterp` branch or an interpreter-event replacement; none may dispatch
  movement decisions when the interpreter lane is on.

**Regression floor (must hold at every commit):** core
`cargo test -p holtburger-core --lib` = 432 pass with ONLY the 10 known
pre-existing failures (list in the handoff); world 540/0; web 124 pass +1
known; `node tests/rust_pose.test.cjs` 13/0. The live-validated strafecast
numbers are the behavioral floor for the flag-OFF lane: held-strafe slide
continuous through a cast, strafe-tap lateral-only under held W, `?slideCast=off`
dies at first stomp. If a change makes any of these ambiguous, stop and A/B.

## Work order

- **Step 0 — must-fix edits on the packet sources before merging** (verdict
  §must-fix): p01/p02 direction-name unflip (0x0D=TurnRight family; reject
  p16-D6); p07's three vtable fixes (SendMovementEvent flat-19 post-dispatch,
  TakeControlFromServer flat-26 pre-dispatch on the mouse path, IsActive guard);
  p15 oracle terminal (`cmd != 0x2500003B (Jump) → SendMovementEvent`); p12
  drop the invented `moving_away` write; note M1 as your converter task.
- **Step 1 — leaf packets**: P13 tails (diff against existing
  motion_interp.rs/movement_manager.rs first — port only what's missing), P10
  moveto-nodes (extend move_to.rs, don't fork), P11 as TESTS ONLY (its methods
  already exist, verified), P12 folded minus the invented write.
- **Step 2 — P01→P02** list engine + stacks (with renames), unit-pinned.
- **Step 3 — the unified interpreter**: fold P03-P09 into
  `client/movement/command_interpreter.rs` (one struct + the single seam),
  P15's fixtures dual-run (oracle vs real) — the caster key-script tests must
  pass against the real interpreter.
- **Step 4 — dark lanes**: wasm `on_action` entry (verdict's corrected
  constants: autorun 0x090000C7, `w`→WalkForward 0x45000005), JS forwarder
  behind `?cmdInterp`, M1 converter, ownership handover implemented and
  asserted (debug_assert both-lanes-drive is a bug).
- Stop where the session budget says; a clean Step-2 stop beats a messy
  Step-4. Whatever lands: update the handoff doc + url-flags (a `?cmdInterp`
  row, PENDING eye-test), commit to master per house style
  (cited messages, `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`),
  push.

## Box + house rules digest (violations cost hours)

8 GB laptop: kill rust-analyzer first (`pkill -f 'rust[-]analyzer'`);
single-crate `capped-build cargo test -p …` ONLY (never --workspace); wasm =
`env PATH="$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin" capped-build
wasm-pack build --target web --out-dir pkg --release` from apps/holtburger-web
(never bare). `rg` is a shell function — NEVER pass `-rn`/`-rln` (`-r` =
--replace!). Decomp greps need `-a`. Live tests: serve.py :8765 is up,
`?nosw=1` always; ACE ghost = wait 95-100 s AFTER dropping a session, then log
in; keep browser work inside continuous evaluates (background tabs starve the
net drain at ~2m50s); test char = `<account>/``+Tester2` (autoSpawn=%2BTester2 —
the + prefix matters), @god'd with Wand + spells 1708 (3-windup self) and 85
(war bolt); two 10k-hp target drudges are parked at the academy spot
(`@create 24888` makes more). keep-ACE-vanilla: never edit/rebuild the server.
memory/ is READ-ONLY. Don't chase the 10+1 pre-existing test failures.
