# A3 movement-stack-gap — unification survey

Audit, not re-spec: diff of `apps/holtburger-web/docs/2026-06-11-unified-movement-pipeline/DESIGN.md`
(Stages 1–3) against the full retail MovementManager / CMotionInterp / MoveToManager cluster.
**Output is a delta to DESIGN.md** (§4), not a new plan. Stage 1 is shipped (gated, not eye-tested);
all plans below inherit the "Stage 1 eye-test PASS" gate.

## 1. Retail map

`MovementManager` is a thin facade owning two lazily-created children and fanning physics events
into both (all cites `~/ac-headers/acclient.c`):

- `PerformMovement` (`acclient.c:339175`): MovementStruct types 1–5 → lazily `CMotionInterp::Create`
  + `enter_default_state`, then `CMotionInterp::PerformMovement`; types 6–9 → lazily
  `MoveToManager::Create`, then `MoveToManager::PerformMovement`.
- `move_to_interpreted_state` (`:339221`) → minterp lane (lazy-create + `enter_default_state` first).
- `EnterDefaultState` (`:339250`), `MotionDone(motion, success)` (`:339349`) → minterp only.
- `UseTime` (`:339359`) → MoveToManager only (the per-frame MoveTo progress pump).
- `HitGround` (`:339369`) → BOTH minterp.HitGround and MoveToManager.HitGround.
- `LeaveGround` (`:339385`), `ReportExhaustion` (`:339421`) → minterp + moveto (decompiler garbles
  the second callee as `gmNoticeHandler::RecvNotice_PrevSpellSelection`; PDB confirms
  MoveToManager::LeaveGround/ReportExhaustion).
- `unpack_movement` (`:339492`): the server UpdateMovement decoder. Per-unpack preamble:
  `CPhysicsObj::cancel_moveto` + `unstick_from_object` (`:339516-339518`); style change →
  `CMotionInterp::DoMotion(style)` when `InqStyle() != style` (`:339540-339546`); case 0
  (interpreted state) → `InterpretedMotionState::UnPack` + optional sticky DID
  (`pack_word_1 & 1` → `stick_to_object`, `:339547-339569`) + `standing_longjump = v7 & 0x200`
  (`:339568`); cases 6/7 (MoveTo) → params + **trailing `my_run_rate` float written into the
  minterp** (`:339577-339589`); case 8 TurnToObject with missing object falls back to
  `MoveToManager::TurnToHeading` with the packed heading (`:339595-339612`).
- `HandleUpdateTarget` (`:339631`) → MoveToManager only.

`CMotionInterp` cluster (the Stage-1 port target plus the parts Stage 1 did NOT port):

- Interpretation chain — ported in Stage 1: `apply_raw_movement` (`:344259`), `adjust_motion`
  (`:343746`), `apply_run_to_command` (`:343439`), `get_state_velocity` (`:343539`),
  `apply_current_movement` (`:344301`), `move_to_interpreted_state` stamp/autonomy gates
  (`:344372-344426`), `StopCompletely` (`:343597`), `set_hold_run`/`SetHoldKey`
  (`:344492`/`:344502`).
- **Pending-motion queue**: `add_to_queue(context_id, motion, jump_error_code)` (`:343406-343437`)
  — every accepted `DoInterpretedMotion` enqueues a node (`:343993-344010`), every
  `StopInterpretedMotion` enqueues a Ready node (`:344056-344060`); `MotionDone(success)`
  (`:343641-343676`) pops the head and, if the completed node was a one-shot action
  (`& 0x10000000`), `unstick_from_object` + `InterpretedMotionState::RemoveAction` +
  `RawMotionState::RemoveAction`; `HandleExitWorld` (`:343679`) drains the queue the same way;
  `motions_pending` (`:343735`) = head non-null.
- **Entry-point lattice**: `DoMotion` (`:344600-344666`) — cancel-moveto bit, SetHoldKey bit,
  `adjust_motion`, style-gated rejections (errors 63/64/65/66 when `current_style !=
  NonCombat`), **6-action FIFO cap** (`GetNumActions >= 6` → error 69), then
  `DoInterpretedMotion` + `RawMotionState::ApplyMotion`. `DoInterpretedMotion` (`:343975`) —
  `contact_allows_move` gate, StandingLongJump suppression branch, `motion_allows_jump`-derived
  `jump_error_code` for the queue node. `StopMotion` (`:344081`) → adjust + `StopInterpretedMotion`
  (`:344034`) + `RawMotionState::RemoveMotion`. `PerformMovement` (`:344670`) dispatches the four
  and calls `CPhysicsObj::CheckForCompletedMotions` after EACH (the completion pump — A4 seam).
- **Ground-contact fan-out**: `HitGround` (`:344429-344455`) — gravity-state check then
  `RemoveLinkAnimations` + `apply_current_movement` (re-derive on landing); `LeaveGround`
  (`:344457-344490`) — stamp `get_leave_ground_velocity` (`:343806-343843` =
  `get_state_velocity` + `get_jump_v_z` z, falling back to the transformed physics velocity
  when ~zero) via `set_local_velocity`, clear `standing_longjump`/`jump_extent`,
  `RemoveLinkAnimations`, `apply_current_movement`.
- **Jump cluster**: `motion_allows_jump` (`:343295`), `jump_charge_is_allowed` (`:343318` — weenie
  stamina vfptr gate → error 73; forward-command gate → 72), `get_jump_v_z` (`:343343` — extent
  clamp to 1.0, weenie vfptr scale, default 10.0), `charge_jump` (`:343845` — sets
  `standing_longjump` only when on-ground + Ready + no sidestep/turn), `contact_allows_move`
  (`:343882` — LogOut/Dead/LifestoneRecall-class motions exempt from the contact gate),
  `jump_is_allowed` (`:343922` — contact, `IsFullyConstrained`, **pending-queue head's
  `jump_error_code`**, `jump_charge_is_allowed`, `motion_allows_jump(forward_command)`, weenie
  stamina-cost vfptr), `jump` (`:344224` — cancel_moveto, stamp `jump_extent`,
  `set_on_walkable(false)`).
- **Lifecycle**: `enter_default_state` (`:344560-344598`) — reset both states,
  `InitializeMotionTables`, **seed the pending queue with one Ready (0x41000003) node**, set
  `initted`, call `LeaveGround`. `ReportExhaustion` (`:344318-344332`) — re-run
  `apply_raw_movement`/`apply_interpreted_movement` so the run promotion re-resolves with the
  exhausted run rate (server-side: stamina==0 forces runskill 0 → run_rate 1.0, DESIGN.md §2
  retail chain; ACE `MovementSystem.GetRunRate`).

`MoveToManager` (Stage 3 target; declarations `acclient.c:7129-7161`): node list
(`AddTurnToHeadingNode`/`AddMoveToPositionNode`), `BeginNextNode`/`BeginMoveForward`/
`BeginTurnToHeading`, per-frame `UseTime` → `HandleMoveToPosition`/`HandleTurnToHeading`,
`CheckProgressMade(fail_distance)`, `CleanUpAndCallWeenie(status)`, `HitGround` re-begin. Not
re-mapped further here — DESIGN.md Stage 3 owns it; A2 owns the position trio seam.

## 2. Ours map

| Retail unit | Rust | JS / wasm bridge |
|---|---|---|
| RawMotionState (runtime) | `crates/holtburger-core/src/client/movement/raw_state.rs:99-162` (axes, holdkeys, `RawAction` w/ 15-bit stamp + autonomous bit) | input via `setMovementInput` → recv arm `apps/holtburger-web/src/lib.rs:38377-38417` |
| InterpretedMotionState (runtime) | `movement/interp_state.rs:38-103` (axes + uncapped action `VecDeque`) | — |
| CMotionInterp interpretation chain | `movement/motion_interp.rs:190-381` (apply_raw_movement, get_state_velocity, ground_velocity, apply_current_movement, move_to_interpreted_state, stop_completely, set_hold_run; constants `:42-70`) | gate consumer `movement/system.rs:1316-1320` (`USE_INTERPRETED_VELOCITY`) |
| pending_motions queue / MotionDone / add_to_queue | **absent** (no field on `MotionInterp`, `motion_interp.rs:167-177`) | anim completion lives renderer-side (A4/A5 seam) |
| DoMotion / DoInterpretedMotion / StopMotion lattice | **absent** (grep `DoMotion|do_motion` over crates/ + lib.rs: 0 hits) | one-shot actions dispatched ad-hoc via `em.setMotion` allow-lists (motion-dispatch doc 2026-06-09) |
| HitGround / LeaveGround | implicit: per-tick re-derive (`system.rs:1316`), airborne launch-velocity lock (`system.rs:1390-1398`), jump-arm intent install (`lib.rs:38441-38460`), charge clear `holtburger-world/src/player/types.rs:1740-1745` | Falling/Fallen motion emits in TickMovement diff arm (`lib.rs:38893` area) |
| ReportExhaustion / stamina→run_rate | **absent**: `player_run_rate()` has no stamina term (`crates/holtburger-world/src/context.rs:317-334`); jump arm only (`lib.rs:38384-38392`) | — |
| Jump cluster | `motion_allows_jump` port `holtburger-world/src/player/types.rs:64-72`; `compute_jump_velocity_z` `types.rs:1710`; substate tracking `player/mutations.rs:307-320` | gates in Jump arm `lib.rs:38307-38345`; charge `lib.rs:38260-38276` (`jumpChargeBegin`, grounded + JS standstill check); `?longJump=on` `index.html:8493-8628` |
| unpack_movement | protocol decode `crates/holtburger-protocol/src/messages/movement/messages/motion.rs:23-117`; sticky DID `:163-176` (F3-4); MoveTo `run_rate` float `:197-228` (decoded, **unconsumed**) | apply: `holtburger-world/src/player/mutations.rs:292-321` (self), `entity.rs:265+` (remote), JS dispatch in `scene3d/loop.js` dispatchOne |
| standing_longjump from wire (0x200) | `motion_flags` decoded (`motion.rs:65-67`, `entity.rs:265`) — **no consumer of bit 0x02** (grep `motion_flags` consumers: constructors/tests only) | — |
| enter_default_state | `MotionInterp::default()` resets states only (`motion_interp.rs:179-188`); no Ready seed, no per-entity instances yet | entity default pose set in `scene3d/entities.js` hydration |
| MoveToManager | **Stage 3, not built** (`movement/move_to.rs` does not exist) | KIND_TURN fixed-K ease `lib.rs:18044` (DESIGN Stage 3 cite) |

## 3. Divergences

| # | behavior | retail cite | our cite(s) | class | symptom | tracked? |
|---|---|---|---|---|---|---|
| 1 | Pending-motion queue + MotionDone pop: every accepted motion enqueues `(context_id, motion, jump_error_code)`; completion pops head and RemoveActions raw+interp + unstick; queue head's jump_error gates jumping | acclient.c:343406-343437, :343641-343676, :343922-343931 | no queue field on `MotionInterp` (motion_interp.rs:167-177); action FIFO exists but nothing pops it (interp_state.rs:50, :89-91) | MISSING | one-shot actions never "complete" pipeline-side: stuck action state, jump allowed during motions retail would refuse, sticky never auto-released on action end | untracked (DESIGN.md Stages 2–3, lines 312-381, never mentions MotionDone/add_to_queue) |
| 2 | ReportExhaustion: stamina-exhaustion event re-runs the interpretation so run promotion resolves at exhausted rate (runskill 0 → run_rate 1.0) | acclient.c:339421-339434, :344318-344332 | `player_run_rate()` has no stamina input (context.rs:317-334); no exhaustion event; jump arm only (lib.rs:38384-38392) | MISSING | exhausted player keeps predicting full run speed → snapback class regression returns exactly when stamina hits 0 | untracked (DESIGN.md line 283 pins "stamina 0→1.0" as a stage-1 TEST but no stage adds the input or event; test not present in shipped motion_interp.rs tests) |
| 3 | DoMotion validation lattice: style-gated errors 63-66, 6-action FIFO cap (error 69), SetHoldKey bit, RawMotionState::ApplyMotion on success | acclient.c:344600-344666 | absent (grep DoMotion over crates/+lib.rs: 0 hits); action FIFO uncapped (interp_state.rs:89-91) | MISSING | DESIGN.md line 79 lists `DoMotion (344600-344666)` in the stage-1 module spec but shipped stage 1 contains only set_hold_run — spec-vs-shipped delta; unbounded action queue | untracked |
| 4 | unpack_movement completeness: per-unpack cancel_moveto+unstick preamble; style-change DoMotion; `standing_longjump ← flags & 0x200`; TurnToObject→TurnToHeading fallback; MoveTo trailing `my_run_rate` float CONSUMED into minterp | acclient.c:339516-339518, :339540-339546, :339568, :339577-339589, :339595-339612 | envelope decoded motion.rs:23-117; sticky :163-176; run_rate decoded-not-consumed :197-228; motion_flags bit 0x02 has zero consumers (entity.rs:265) | MISSING (decode exists, semantics dropped) | remote standing-longjump pose wrong; remote MoveTo gait tempo falls back to defaults until Stage 3; style changes from server don't re-style the rig through one path | partially tracked: Stage 3 covers the run_rate float (DESIGN.md:359-364) + F3-5; the 0x200 bit, style-DoMotion, preamble, TurnTo fallback are untracked |
| 5 | enter_default_state: reset states + InitializeMotionTables + seed Ready pending node + LeaveGround, run lazily on every minterp creation | acclient.c:344560-344598, :339192-339199 | `MotionInterp::default()` resets fields only (motion_interp.rs:179-188); no per-entity instances exist yet | MISSING | Stage 3's per-entity `MotionInterp` (DESIGN.md §5 remote/local-bleed risk) has no specced construction/default-state semantics | untracked |
| 6 | LeaveGround launch velocity = `get_state_velocity` (closed-form, clamped run_rate×4.0) + jump v_z; falls back to transformed physics velocity when ~zero | acclient.c:343806-343843, :344457-344490 | walk-off-ledge freezes `current_planar_velocity` (unclamped authored ground velocity, system.rs:1390-1398); charged jump uses interpreted intent (lib.rs:38441-38460) | DIFF-ALGO | airborne speed can exceed retail's run_rate×4.0 clamp for diagonal run+strafe launches (~5.7 vs 4.0×rate-capped); small numeric drift vs ACE arcs | untracked (DESIGN cites get_leave_ground_velocity for the charged case only) |
| 7 | MovementManager facade + PerformMovement 4-way dispatch with CheckForCompletedMotions after each entry | acclient.c:339175-339218, :344670-344720 | no facade; entry points scattered (recv arm lib.rs:38377-38417, JS setMotion allow-lists) | SPLIT-BRAIN (≥3 sites) | completion pump never runs synchronously after motion entry; ordering vs retail differs (A1/A4 seam) | partially: motion-dispatch coverage doc 2026-06-09 (allow-lists); the facade shape itself untracked |
| 8 | Stage-1 interpretation chain (adjust/run/get_state_velocity/stamps/echo-skip/StopCompletely/set_hold_run) | acclient.c:344259-344298, :343746-343803, :343439-343483, :343539-343594, :344372-344426, :343597-343638, :344492-344523 | motion_interp.rs:190-381 + tests :420-803 | PARITY | — | DESIGN.md Stage 1 (shipped, gated) |
| 9 | Jump permission/charge/extent (motion_allows_jump, grounded gate, extent clamp, exhausted min-hop, standstill charge) | acclient.c:343295-343404, :343845-343974, :344224-344256 | types.rs:64-72, :1710; lib.rs:38260-38276, :38307-38392 | PARITY (modulo row 1's queue-head gate and row 2's charge-time stamina error 73) | — | G-7 / F1-6 (shipped, `?longJump=on`), Wave 10 Phase 10.2 |

Divergence count (non-PARITY): **7**.

## 4. Staged unification plan — DELTA to DESIGN.md (amendments, not a new plan)

### D1 — amend Stage 2: pending-motion queue + MotionDone (closes rows 1, 3-cap)
- Scope: add `pending_motions: VecDeque<PendingMotion { context_id, motion, jump_error_code }>` to
  `MotionInterp`; `add_to_queue` on every accepted motion; `motion_done(success)` pop +
  `RemoveAction` raw+interp (+ unstick callback hook for A2's sticky owner); 6-action cap on the
  action FIFO (error 69); `jump_is_allowed` consults the queue head. Completion signal arrives
  from the A4 lane (AnimationDone) — D1 defines the receiving API only, keeping the A3/A4 seam:
  A4 owns WHO fires completion, A3 owns what completion DOES to movement state.
- Files: `movement/motion_interp.rs`, `movement/interp_state.rs`, `movement/raw_state.rs`
  (RemoveAction arms exist, raw_state.rs:184-225); wasm completion entry in
  `apps/holtburger-web/src/lib.rs`.
- Flag: rides Stage 2's `?interpRig=` + `WASM_EXPORT_MANIFEST_VERSION` bump (no new flag; the
  queue is inert until the rig lane consumes it). Wasm-rebuild. Rollback: flag off.
- Tests: headless-now Rust unit (queue FIFO, action pop removes raw+interp, 6-cap, Ready seed,
  jump gate on head error); 1070-gated: one-shot action completes → sticky release + jump allowed.

### D2 — amend Stage 1 (point fix) + Stage 3: exhaustion lane (closes row 2)
- Scope: (a) stamina input to the run-rate resolution — `player_run_rate()` returns the exhausted
  rate when wire Stamina current == 0 (runskill treated as 0 → formula 1.0), matching ACE
  `GetRunRate` and DESIGN.md §2's own retail chain; (b) Stage 3's server lane re-runs
  `apply_raw_movement` on the stamina 0-crossing event (the `ReportExhaustion` fan-out, including
  the future MoveToManager). Add the missing "stamina 0→1.0" unit test DESIGN.md line 283 already
  promises.
- Files: `crates/holtburger-world/src/context.rs` (+ vitals read), `movement/motion_interp.rs`
  test, later `movement/move_to.rs`.
- Flag: `const USE_EXHAUSTION_RUN_RATE: bool = false` (default-off, const-gate pattern
  url-flags.md:245-273). Wasm-rebuild. Rollback: const off.
- Tests: headless-now (formula + event re-derive); 1070-gated (run until stamina 0, no snapback).

### D3 — amend Stage 3: unpack_movement completion + enter_default_state (closes rows 4, 5, 6, 7-shape)
- Scope: Stage 3's "route server UpdateMotion through move_to_interpreted_state for ALL entities"
  must additionally spec: per-unpack cancel_moveto + unstick preamble; style-change `DoMotion`
  before payload dispatch (needs D1's DoMotion lattice); `standing_longjump ← motion_flags & 0x02`
  (completes G-7 wire-side); TurnToObject missing-object → TurnToHeading fallback; MoveTo
  `my_run_rate` float installed per-entity (already specced); `enter_default_state` semantics for
  every new per-entity `MotionInterp` (Ready queue seed + LeaveGround init); leave-ground velocity
  switched to `get_state_velocity` clamped form (row 6) for non-charged departures.
- Files: `movement/move_to.rs` (NEW, as DESIGN), `movement/motion_interp.rs`,
  `holtburger-world/src/entity.rs`, `apps/holtburger-web/src/lib.rs` recv arm.
- Flag: per-feature Rust consts default OFF (DESIGN Stage 3 pattern). Wasm-rebuild.
- Tests: headless-now (unpack fixture matrix incl. 0x200 bit, TurnTo fallback, default-state
  seed); 1070-gated (remote MoveTo tempo, sticky release on action end — F3-4 must not regress).

Dependency order: D2(a) can land with Stage 1 follow-up; D1 before D3 (D3's style-DoMotion needs
the lattice); everything behind "Stage 1 eye-test PASS".

## 5. Scores

- Leverage: completes G-7/F1-6 (wire-side standing_longjump); formalizes the B9 echo-skip's Rust
  replacement (already in DESIGN); D1 unblocks A4's AnimationDone→MotionDone chain and the
  motion-dispatch M1–M4 dispatcher's completion half; F3-4/F3-5 protected (regression tests), not
  re-fixed.
- Regression-risk reduction: **H** — the pending-queue/MotionDone hole is the largest remaining
  split-brain in movement (completion decided renderer-side, state never cleaned), and the
  exhaustion hole reintroduces the exact snapback class Stage 1 fixed.
- Impl risk: **M** — all additive behind default-off gates; D3 touches the recv arm (shared with
  A13's pack-codec plan — serialize with A13).
- 1070-dependency: **Y** for final acceptance (all three deltas have headless-now unit lanes).
- Depends-on: Stage 1 eye-test PASS (gate); A4 (completion signal source, D1 seam); A2
  (sticky/unstick owner, D1 hook); A13 (recv-arm/codec file overlap); A14 (input side of jump
  charge — A3 owns pipeline side only).

## 6. SPECULATIVE / UNRESOLVED

- **MotionDone → server reporting**: whether the retail client tells the server a motion
  completed (vs the server inferring from MoveToState raw-state diffs). `MovementManager::
  MotionDone` (acclient.c:339349) routes only to the minterp; any weenie/server callback would
  live in the MotionTableManager→weenie chain (A4's territory). Greps tried:
  `MotionDone` callers (`CheckForCompletedMotions` hits at acclient.c:317103), `SendMotionDone`,
  `Motion.*Done.*Send` — no client→server send found; UNRESOLVED, likely "no wire message"
  but single-sided.
- **HitGround re-derive materiality**: ours recomputes target velocity every tick
  (system.rs:1316), so retail's event-driven `HitGround → apply_current_movement` may be
  behaviorally subsumed. Single-cited on our side (no retail-vs-ours frame trace); left out of
  the divergence table — D3 need not add a HitGround event unless A1's ordering audit shows a
  late-by-one-frame landing artifact.
- **`jump_charge_is_allowed` error 73 (charge-time stamina gate)**: retail gates the CHARGE via a
  weenie vfptr (acclient.c:343318-343341); ours gates only at release (lib.rs:38384-38392).
  Player-visible difference is a charge UI nuance; could not locate ACE's charge-time equivalent
  (grep `JumpStaminaCost|jump_charge` in ../ACE — release-time only), so the right behavior for
  ACE servers is plausibly ours. UNRESOLVED.
- **MoveToManager internals** (CheckProgressMade thresholds, node-list semantics,
  walk_run_threshhold consumption): bodies not read this pass (declarations acclient.c:7129-7161
  only); DESIGN.md Stage 3 + A2's seam own the detailed port. Recorded so A16 doesn't count
  MoveToManager as "mapped" from this report.
