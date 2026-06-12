# S11 — A14-I4: jump charge-clock ownership + single movement-pack send boundary via the A13 builder

Agent: S11 · Item: A14-I4 · Date: 2026-06-11 · Host: buildbox (READ-ONLY sweep)
Sources: agents/A14-input-to-motion.md §4 Stage I4, agents/A13-wire-state-packs.md,
ROADMAP.md §§2/3/5/8/9, RULINGS.md, A3-D1-amended DESIGN.md
(docs/2026-06-11-unified-movement-pipeline/DESIGN.md). Retail truth:
/home/wbterminal/ac-headers/acclient.{c,h}. All `lib.rs` / `index.html` /
crate line numbers verified at the read-HEAD below (they drift — re-grep symbol names
at implementation time).

---

## 1. Read-HEAD + W2 assumptions

**Read HEAD: `61bea82f` (holtburger: W2/Batch-R2 buildbox dispatch manifest).**
W1 batch is LANDED at this HEAD: A1-O1 `?unifiedTick` (656c8ef1, tick_spine.rs), A1-O2
(54162642), A13-W1 `?wireStatePacks=stage1` (ac3f9891), A13-W2 golden echo test
(b5a31b99), **A13-W3 single MoveToState builder (6ce48bc9 — `build_move_to_state` exists
at `crates/holtburger-core/src/client/movement/common.rs:157-171`)**, A8-M1/M2. A14-I1
`?inputFunnel` is landed (`scene3d/input.js` exists; jump keydown/keyup deliberately
stayed in index.html per `scene3d/input.js:31`).

**In-flight W2 (Batch R2) items this spec assumes land BEFORE A14-I4 implementation:**
- **A4-Q1 + A3-D1** (pending_motions queue in `movement/motion_interp.rs`, per
  DESIGN.md:423-462): the release-time gate should consult the queue-HEAD
  `jump_error_code` (retail `jump_is_allowed` acclient.c:343948-343951; DESIGN.md:450-454).
  This spec defines a fallback if Q1 slips (§3, I4-b step 3) so it is a soft dependency.
- **A14-I2 intent enum** (code-only half, `system.rs`): no semantic dependency, but it
  edits the same `movement/system.rs` — serialize per ROADMAP §3 (line 139).
- A3-D2(a), A2-P1, A7-R1/R2/R3/R6, A9-Stage1: **no dependency** for this item.

**Wave placement:** A14-I4 is W5 (ROADMAP §2 waves table, line 129). Its **acceptance**
(default-on feel) is gated on Stage-1 eye-test PASS (ROADMAP §2 line 90-92 names A14-I4
explicitly); **landing it flag-off is NOT gated** (same line). Execution class:
"Needs Fable-class judgment" (ROADMAP §9 line 293) — this spec is written to demote it to
mechanical.

---

## 2. Current-state map (post-W0/W1)

### 2.1 Retail truth — the charge clock and the one send funnel

| step | retail behavior | cite |
|---|---|---|
| Press (input action 0x31, `m_fStart`) | `ACCmdInterp::OnAction` case 0x31 → `vfptr[5].OnAction` = `ACCmdInterp::CommenceJump` shim → `ClientCombatSystem::CommenceJump` | acclient.c:435998-436008 (case), 435831-435841 (shim), 408033-408078 (body) |
| Charge-time guard | no-op if `jump_pending` already set | acclient.c:408039-408041 |
| Charge-time validation | `CMotionInterp::charge_jump`: weenie `vfptr[15]` gate fail → **73**; interpreted `forward_command` ∈ {0x40000008 Fallen, 0x41000012-0x41000014 crouch/sit/sleep band} → **72**; else 0 | acclient.c:343845-343879 (charge_jump), 343862-343869 (jump_charge_is_allowed twin at 343318-343341 per A14 §1 row 9) |
| Charge-time refusal text | 73 → `cant_jump_load`, 72 → `cant_jump_position`, default → `cant_jump_in_air`, via `ClientSystem::AddTextToScroll(…, 0x1A, …)` | acclient.c:408050-408059 |
| Standstill long-jump root | `charge_jump` sets `standing_longjump = 1` only when `transient_state & 1 && & 2` (contact+walkable) AND `forward_command == 0x41000003` (Ready) AND no sidestep/turn command | acclient.c:343864-343870 |
| Charge-time success side effects | cancel auto-repeat attack, `jump_pending = 1`, `powerBarMode = PBM_JUMP(3)`, `BeginPowerbar` notice, `StartPowerBarBuild` | acclient.c:408062-408075 |
| Clock start | `StartPowerBarBuild`: `buildInProgress = 1`, `buildStartTime = Timer::cur_time` | acclient.c:407902-407916 |
| Clock read | `GetPowerBarLevel` = `(cur_time − buildStartTime) / divisor` clamped [0,1]; **divisor = 0.8 when local player `InqInterpretedMotionState→current_style == 0x80000046`, else 1.0** (`current_style` is the field at +4 of `InterpretedMotionState`, acclient.h:31389-31391) | acclient.c:407919-407955; divisor branch 407933-407939; clamp 407940-407949 |
| UI read | `GetJumpPowerLevel` = `jump_pending ? max(GetPowerBarLevel, MIN_JUMP_EXTENT) : 0`; `MIN_JUMP_EXTENT = 0.001` | acclient.c:408081-408104, 41626; UI consumer `ClientUISystem::OnAction` acclient.c:402173 |
| Release (`m_fStart == 0`) | OnAction 0x31 else-branch → `vfptr[5].OnLoseFocus(1)` = `ACCmdInterp::DoJump(autonomous)` 3-line shim → `ClientCombatSystem::DoJump` | acclient.c:436004-436008, 435843-435850, 408146-408227 |
| Release ordering | autonomous branch: `jump_pending` check → extent = `GetPowerBarLevel` floored at MIN_JUMP_EXTENT → **`FinishJump` FIRST (clears pending/bar/standing_longjump)** → `CMotionInterp::jump(extent)` validates | acclient.c:408164-408179; FinishJump body 407625-407648 |
| Release validation | `CMotionInterp::jump` → `jump_is_allowed`: in-air → **36**, `IsFullyConstrained` → 71, **pending_motions HEAD `jump_error_code`**, `jump_charge_is_allowed` (73/72), `motion_allows_jump(forward_command)`, weenie stamina vfptr[16] → 71; success stamps `jump_extent` + `set_on_walkable(false)` | acclient.c:344224-344256, 343922-343974 |
| Release refusal text | 0 → pack+send; 73/72/36 → scroll text | acclient.c:408193-408203 |
| Single pack ctor + send | success: `get_local_physics_velocity` → `JumpPack(extent, velocity, m_position, update_times[8], [5], [4], [6])` → `CM_Movement::Event_Jump` (opcode 0xF61B, OrderHdr stamp `Proto_UI::GetNextUICounter`) | acclient.c:408180-408193 (ctor+send), 324037 (JumpPack ctor), A13 §1: quartet slots identical to SendMovementEvent acclient.c:718175-718178 |
| Abort (blur analog) | `ACCmdInterp::FinishJump` shim → `ClientCombatSystem::FinishJump` | acclient.c:435853-435863, 407625-407648 |

Key structural fact: **retail owns the charge clock in the client core
(`ClientCombatSystem` fields `jump_pending`/`buildInProgress`/`buildStartTime`), the UI
only READS it** (acclient.c:402173 via GetJumpPowerLevel), and the pack is constructed at
exactly ONE site (408184-408192) feeding one counter-stamped funnel.

### 2.2 Ours — split-brain clock, inline pack construction

| layer | ours today | cite |
|---|---|---|
| Charge clock owner = **JS** | keydown stamps `window.__jumpKeydownTs = performance.now()` | index.html:8716-8718 |
| Power curve = **JS** | keyup: `power = clamp(holdMs/1000, 0.001, 1)`; `JUMP_POWER_FULL_HOLD_MS = 1000`, `MIN_JUMP_EXTENT = 0.001` (F1-5 retail-matched curve, no 0.8 stance divisor — acknowledged follow-on in the comment) | index.html:8591-8592, 8747-8749, 8771-8775; divisor caveat 8587-8591 |
| UI bar = JS rAF reading the JS clock | `frame()` reads `__jumpKeydownTs` | index.html:8631-8642 |
| Release → wasm | `handle.jump(power)` → `SessionCommand::Jump{power}` | index.html:8777; lib.rs:26281-26291 |
| Release gates (wasm) | airborne check; `motion_allows_jump(current_substate)`; **silent refusal** (`continue` + optional diag log — no user-facing text) | lib.rs:38757-38760, 38784-38798; predicate `crates/holtburger-world/src/player/types.rs:64` |
| JS pre-check mirror | `canJumpNow()` synchronous shadow getter (published per TickMovement) | lib.rs:25423-25426, 30236, 39208; index.html:8758-8771 |
| vz / stamina / burden | computed inline in the recv arm: `jump_stamina_cost`, `compute_jump_velocity_z`, exhaustion min-hop, `begin_jump` | lib.rs:38800-38880 |
| **Pack built inline** (NOT via a common.rs builder) | quartet read from `w.player.*` + `JumpActionData{…, object_guid, spell_id: 0}` constructed in the recv arm | lib.rs:38884-38891 (quartet), 38909-38918 (ctor), 38920 (`session.send_action`) |
| The A13 pattern it should join | `build_move_to_state` / `build_autonomous_position` construct ALL other outbound movement packs in one module, quartet from `world.player` in one place | crates/holtburger-core/src/client/movement/common.rs:157-171, 173-190 |
| Single counter-stamped funnel (PARITY) | `Session::send_action` increments `game_action_sequence` — retail OrderHdr `GetNextUICounter` analog (A13 §3 row 11 PARITY) | crates/holtburger-session/src/session/send.rs:321-329 ↔ acclient.c:435899-435913, 713161-713172 (per A13 §1) |
| `?longJump=on` (G-7/F1-6) partial charge state in wasm | `jumpChargeBegin/Cancel` exports → `standing_long_jump_charge` flag only (no clock); JS decides standstill via `anyMovementKeyHeld()` | lib.rs:26297-26320, 38709-38725; index.html:8596-8602, 8719-8729 |
| Charge root consumed by | manual-slice + local-solve velocity zeroing (turn allowed); MoveToState bit 0x2 | crates/.../movement/system.rs:1326-1330, 2815-2818; common.rs:131-137 (`encode_contact_long_jump`) |
| Charged launch velocity | `MovementSystemHandle::charged_jump_launch_velocity` (= `manual_intent_velocity`) consumed by the recv arm | crates/.../movement/handle.rs:69-76; lib.rs:38894-38906 |
| Tick spine (post-W1) | `tick_frame` movement→world→simulation; wasm TickMovement arm under `?unifiedTick=on`; `MovementSystemHandle::tick(now, world, session)` already holds the session for pulse sends | crates/holtburger-core/src/client/tick_spine.rs:1-60; lib.rs:38975+; handle.rs:103-110 |

**Divergence summary (A14 §3 rows 6-7, dual-cited above):** (a) the charge clock lives in
JS while charge-gating/rooting lives in wasm — two runtimes own one retail object
(SPLIT-BRAIN); (b) charge-time validation + ALL refusal text are missing (retail prints
72/73 at press and 36/72/73 at release; we silently drop); (c) the 0.8 divisor for stance
0x80000046 is missing; (d) the Jump pack is the LAST outbound movement pack constructed
outside `movement/common.rs` — the A13 single-builder/single-boundary shape is complete
for MoveToState/AutonomousPosition but not Jump.

---

## 3. Staged implementation plan

Flag: **`?jumpParity=on`** — JS-parsed only (index.html, same IIFE pattern as
`LONG_JUMP_ON` at index.html:8596-8602), default-off. The wasm side ships new
SessionCommands/exports unconditionally but they are **unreached** unless JS routes to
them, so flag-off is byte-identical (the legacy `SessionCommand::Jump{power}` arm and the
legacy `JumpChargeBegin/Cancel` arms are NOT touched). Under `jumpParity=on`, the
`?longJump` behavior is implied (the parity clock owns the root); `?longJump=on` alone
keeps its current narrow path.

Classification: **wasm-rebuild** (Batch R4 per ROADMAP §5 line 176 "A14-I4 charge-clock",
plus a movement-crate module — serialize with A14-I2/A6-T1 on `system.rs` per ROADMAP §3
line 139, and queue the lib.rs edits per §3 line 138). **Manifest bump:**
`WASM_EXPORT_MANIFEST_VERSION` 2 → 3 (lib.rs:445) — four new exports (I4-c); JS
typeof-guards degrade to the legacy path on a stale `pkg/` (pattern index.html:8597-8601,
8725-8727).

### I4-a — Rust charge clock (NEW `crates/holtburger-core/src/client/movement/jump_charge.rs`)

New module (keep `system.rs` diff minimal — it is the №2 conflict file, ROADMAP §3):

```rust
pub(super) struct JumpChargeClock {
    jump_pending: bool,            // retail ClientCombatSystem::jump_pending (acclient.c:408041,408071)
    build_start: Option<Instant>,  // retail buildInProgress+buildStartTime    (acclient.c:407902-407916)
}
pub(crate) enum JumpRefusal { Position = 72, InAir = 36, Load = 73, Constrained = 71 }
```

Methods (each cites its retail body in a doc comment):

1. `commence(&mut self, now: Instant, world: &mut WorldState) -> Result<(), JumpRefusal>`
   - `if self.jump_pending { return Ok(()) }` — double-press no-op, clock NOT restarted
     (acclient.c:408039-408041).
   - Position gate → `Err(Position)`: `!motion_allows_jump(world.player.current_substate)`
     (reuse the shipped predicate, types.rs:64 — its blocked set covers retail's
     Fallen/crouch band, types.rs:397-425) mirroring `charge_jump`'s forward-command gate
     (acclient.c:343856-343862). NOTE: retail reads the **interpreted** forward command;
     ours reads `current_substate` fed from server UpdateMotion
     (crates/holtburger-world/src/player/mutations.rs:305-318) — same approximation the
     shipped release gate already makes (lib.rs:38784-38798). Upgrade to the
     motion_interp interpreted state when A3-D1/Stage-2 makes it live (W2 assumption;
     see §6 Q5).
   - **NO charge-time error-73 gate** — DESIGN.md:460-462 explicitly rules "Charge-time
     stamina error 73 stays UNRESOLVED … do not add a speculative charge-time gate."
     (retail's weenie vfptr[15] gate at acclient.c:343855 is implemented as a refusal
     enum variant but never produced at charge time; see §6 Q1.)
   - Success: `jump_pending = true; build_start = Some(now)` (408071, 407902-407916);
     standstill root: `world.player.standing_long_jump_charge = true` iff
     `!world.player.is_airborne` (our contact+walkable analog — same check the shipped
     JumpChargeBegin arm makes, lib.rs:38714-38718) AND the active manual drive has no
     forward/sidestep/turn axes (retail: `forward_command == 0x41000003 Ready && no
     sidestep && no turn`, acclient.c:343864-343870). Read the held axes from the
     movement system's active manual intent (`system.rs` active_drive — the same state
     `manual_intent_velocity` reads, handle.rs:69-76), NOT from JS.
2. `level(&self, now, world) -> f32` — `0.0` if `!jump_pending`; else
   `((now − build_start)/divisor).clamp(0.0, 1.0)`; **divisor = 0.8 iff
   `world.player.last_server_motion_style == Some(0x0046)`**
   (`MotionStance::DualWieldCombat.interpreted()`,
   crates/holtburger-protocol/src/messages/movement/types.rs:85,102-103; stance store
   mutations.rs:335-343) else 1.0 — retail acclient.c:407933-407949 (`current_style ==
   0x80000046 → 0.8`). See §6 Q2 on the enum-name confidence.
3. `power(&self, now, world) -> f32` — `jump_pending ? level().max(MIN_JUMP_EXTENT) : 0.0`
   with `const MIN_JUMP_EXTENT: f32 = 0.001` (retail GetJumpPowerLevel
   acclient.c:408081-408104; constant 41626).
4. `finish(&mut self, world)` — clear `jump_pending`/`build_start` AND
   `world.player.standing_long_jump_charge = false` (retail FinishJump
   acclient.c:407625-407648 clears bar state and the minterp `standing_longjump`).
5. `release(&mut self, now, world) -> Option<f32>` — `None` if `!jump_pending`
   (408164); `let extent = self.power(now, world)`; **`self.finish(world)` BEFORE
   returning** (retail order: extent read 408168-408173 → FinishJump 408174 → validate
   408179); `Some(extent)`.

`MovementSystem` gains a `jump_charge: JumpChargeClock` field (one-line `system.rs`
edit + module decl in `movement/mod.rs`).

### I4-b — single Jump builder + movement-owned release (the A13-W3 pattern)

1. **`build_jump` in `movement/common.rs`** next to `build_move_to_state`
   (common.rs:157-171):
   ```rust
   pub(super) fn build_jump(world: &WorldState, extent: f32, velocity: Vector3) -> JumpActionData
   ```
   Quartet from `world.player.{instance,server_control,teleport,force_position}_sequence`
   exactly as `build_move_to_state` reads it — mirroring retail's single JumpPack ctor
   site (acclient.c:408184-408192: `update_times[8]/[5]/[4]/[6]`, the same slots both
   position packs read at 718175-718178). Keep the ACE trailer
   `object_guid = world.player.guid, spell_id = 0` and the omitted Position — ROADMAP §8
   do-not-do (A13 §3 row 2, ACE-sanctioned shape,
   `apps/holtburger-web/validate_wire_conformance.cjs` memo). After this, **every
   outbound movement pack (MoveToState ×3 pulse kinds, AutonomousPosition ×2 sites,
   Jump) is constructed in `movement/common.rs` and dispatched via the one
   counter-stamped funnel `Session::send_action` (send.rs:321-329)** — the A14-I4
   "single send boundary" deliverable (ROADMAP §2 line 116-118: "A14-I4 emits through
   A13's single builder (W3)").
2. **`MovementSystemHandle::execute_jump_release(&mut self, now, world, session)
   -> Result<JumpOutcome>`** (handle.rs + a `system.rs` impl; `JumpOutcome =
   NotCharging | Refused(JumpRefusal) | Jumped { extent, vz }`). Body = the current recv
   arm logic MOVED, not rewritten (lib.rs:38726-38938):
   - `let Some(extent) = self.jump_charge.release(now, world) else { return NotCharging }`.
   - Release gates, retail order (`CMotionInterp::jump` → `jump_is_allowed`,
     acclient.c:344224-344256, 343922-343974): airborne → `Refused(InAir)` (=36;
     current gate lib.rs:38757-38760); **pending_motions HEAD `jump_error_code` if the
     A4-Q1/A3-D1 queue is live** (DESIGN.md:447-454; W2 assumption — if Q1 slipped,
     compile-time-absent, keep the next gate only); `!motion_allows_jump(current_substate)`
     → `Refused(Position)` (=72; current gate lib.rs:38784-38798).
   - vz/stamina: move verbatim from lib.rs:38800-38880 (`jump_stamina_cost`,
     exhaustion → `effective_skill = 0` min-hop, `compute_jump_velocity_z`,
     `begin_jump`, local stamina deduction).
   - Launch planar velocity: charged → `manual_intent_velocity` install (current logic,
     lib.rs:38894-38906 + handle.rs:69-76; retail `get_leave_ground_velocity` interpreted
     intent per DESIGN.md:482-487 — unchanged); else runtime kinematics fallback.
   - `session.send_action(GameAction::Jump(Box::new(build_jump(world, extent, v)))).await`.
   - Side effect: this gives the **cli** a jump capability for free (A13 §2: "cli has no
     jump at all") — no cli wiring in this item, just note the now-shared code.

### I4-c — wasm bridge (lib.rs)

New `SessionCommand` variants (enum at lib.rs:17004) + recv arms (place beside the
legacy arms at lib.rs:38709-38938; legacy arms untouched):
- `JumpChargeCommence` → `movement.jump_charge_commence(Instant::now(), w)`; on
  `Err(code)` queue `ClientEvent { kind: CLIENT_EVENT_KIND_JUMP_REFUSED, u32_payload:
  Some(code as u32), .. }` — new kind constant (next free id after
  `CLIENT_EVENT_KIND_PLAY_EFFECT = 30`, lib.rs:16647; verify free at impl time).
  Retail analog: press-time scroll text acclient.c:408050-408059.
- `JumpChargeRelease` → `movement.execute_jump_release(now, w, &mut session).await`;
  `Refused(code)` → same event kind (retail release-time text 408193-408203);
  `Jumped{..}` → keep the existing `[jump]` console log shape (lib.rs:38931-38934).
- `JumpChargeAbort` → `movement.jump_charge_cancel(w)` (= `finish`; retail
  `ACCmdInterp::FinishJump` acclient.c:435853-435863).

New `SessionHandle` exports (beside lib.rs:26281-26320, doc-comment each):
`jumpChargeCommence()`, `jumpChargeRelease()`, `jumpChargeAbort()` (channel sends,
pattern of `jump`/`jumpChargeBegin`), and **`jumpChargeLevel() -> f32`** — synchronous
shadow getter, exact pattern of `canJumpNow`
(field beside `local_player_can_jump` lib.rs:23350; getter beside lib.rs:25423-25426;
publish `movement.jump_charge_level(now, w)` in the TickMovement arm beside
`publish_local_player_can_jump` at lib.rs:39208 — works both `?unifiedTick` on and off
since both paths run that arm). Retail analog: UI reads `GetJumpPowerLevel`
(acclient.c:402173), never owns the clock.

Bump `WASM_EXPORT_MANIFEST_VERSION` to 3 (lib.rs:445).

### I4-d — JS (index.html only; `scene3d/input.js` untouched — jump stays in index.html per input.js:31)

Parse `JUMP_PARITY_ON` next to `LONG_JUMP_ON` (index.html:8596-8602); effective only when
the four exports exist (typeof guards / manifest ≥ 3, pattern index.html:8597-8601).
Under the flag:
- **keydown space** (index.html:8704-8731): call `handle.jumpChargeCommence()`; do NOT
  stamp `__jumpKeydownTs`; skip the `anyMovementKeyHeld()`+`jumpChargeBegin` branch
  (8719-8729 — the standstill decision moves wasm-side per I4-a); still
  `jumpChargeUi.show()` gated on `canJumpNow()` so a refused press shows text, not a bar.
- **bar `frame()`** (index.html:8631-8642): read `handle.jumpChargeLevel()` (0..1)
  instead of the `__jumpKeydownTs` hold-math.
- **keyup space** (index.html:8743-8780): call `handle.jumpChargeRelease()`; skip the
  holdMs/power computation and `handle.jump(power)` (8747-8779). Keep the `canJumpNow()`
  pre-check ONLY as the local-prediction overlay gate (8758-8771 — unchanged purpose).
- **movement keydown during charge** (index.html:8667-8673): keep calling the LEGACY
  `jumpChargeCancel()` (root-drop only, lib.rs:38721-38725) — deliberate G-7
  modernization retained; retail instead REFUSES forward motions while rooted
  (`DoInterpretedMotion` standing_longjump gate, acclient.c:343996-344004) — see §6 Q4.
- **blur** (index.html:8864-8872): call `jumpChargeAbort()` (replaces the `__jumpKeydownTs
  = null` + longJump cancel pair; retail FinishJump analog).
- **refusal events**: in the ClientEvent drain, map `CLIENT_EVENT_KIND_JUMP_REFUSED`
  `u32_payload` → chat-scroll text: 73 → "You are too encumbered to jump!", 72 → "You
  can't jump from this position!", 36 → "You're in the air!" (ACE WeenieError wording —
  retail string CONTENTS are not in the decompile, only the globals
  `cant_jump_load/position/in_air` acclient.c:56814-56818; see §6 Q3).

Flag-off: every touched site keeps its current branch verbatim (the legacy
`Jump{power}` arm, JS clock, JS power curve, longJump path all remain the default).

---

## 4. Test plan

### Headless-now (land with the change; cargo execution deferred to the W2-owner's batch — NO builds in this sweep)

Rust (`movement/jump_charge.rs` unit tests + `movement/system/tests.rs` style):
1. Clock curve: commence at t0 → `level(t0+0.5s)=0.5`, `level(t0+1.0s)=1.0`,
   `level(t0+2.0s)=1.0`, `level` pre-commence `= 0.0` (acclient.c:407940-407949).
2. Divisor: stance `last_server_motion_style = Some(0x0046)` → `level(t0+0.8s) = 1.0`
   (acclient.c:407933-407939).
3. Floor: instant release → `extent == 0.001` (acclient.c:408081-408104, 408169-408173).
4. Double-press: second `commence` while pending → Ok, `build_start` unchanged
   (acclient.c:408039-408041).
5. Position refusal: `current_substate = 0x41000012` (Crouch) → `Err(Position)`, not
   pending (acclient.c:343856-343862; types.rs:413).
6. Standstill root matrix: grounded+no axes → root set; held forward axis → not set;
   airborne → not set (acclient.c:343864-343870).
7. Release-after-abort → `NotCharging` (acclient.c:408164).
8. Finish-before-validate: a release whose substate gate refuses still clears
   `jump_pending` + root (acclient.c:408168-408179 ordering).
9. **Golden-bytes**: `build_jump` output for a fixed WorldState snapshot byte-equals the
   legacy inline `JumpActionData` construction (pin the extraction; pattern = A13-W2
   golden test, commit b5a31b99).
10. Quartet echo: set `server_control_sequence = N` → `build_jump` echoes N (mirror of
    the A13-W2 echo-chain test).
11. (If A4-Q1 landed) queue-head `jump_error_code` refusal propagates through
    `execute_jump_release` (DESIGN.md:447-454 acceptance row, DESIGN.md:515).

JS (`apps/holtburger-web/tests/jump_charge_parity.test.cjs`, pattern
`keymap_manifest.test.cjs`): mock handle; flag-off → keyup invokes `handle.jump(power)`
with the JS curve; flag-on + exports present → keyup invokes `jumpChargeRelease()` and
NEVER `jump()`; flag-on + stale handle (missing export) → degrades to legacy path.

### 1070-gated (Lane B, ROADMAP §4 line 163 "A14-I2/I4 feel")
- Bar fills in 1.0 s wall-clock; full-hold jump height unchanged vs legacy.
- Running charge: no root, release → moving jump (parity with legacy feel).
- Standstill charge: root + W-held-at-release long jump (G-7 behavior preserved);
  observer sees the long-jump arc (contact_long_jump bit 0x2 still emitted,
  common.rs:131-137).
- Crouch-band press prints refusal text; in-air release prints "in the air" text;
  silent-drop class gone.
- Exhausted player still min-hops (lib.rs:38830-38860 logic relocated, behavior pinned).
- Dual-wield stance 0.8 s fill (if a dual-wield loadout is available; else defer, §6 Q2).

---

## 5. Risks + rollback

1. **The legacy Jump arm is load-bearing** (every jump today goes through
   lib.rs:38726-38938). Mitigation: new commands beside it, legacy arm byte-untouched,
   golden-bytes test 9 pins the pack; flag-off ships dark.
2. **Logic relocation drift** (vz/stamina math moving into the movement crate).
   Mitigation: move-verbatim discipline + test 9/10; the helpers already live in
   `holtburger_world::player` so only call sites move.
3. **Clock-start latency**: DOM keydown → mpsc channel → recv-arm `Instant::now()` adds
   ≤1 frame (~16 ms) vs the JS `performance.now()` stamp — ≤1.6% power error on a full
   hold, and the UI bar reads the SAME wasm clock so no visible bar/extent mismatch.
   Accepted; recorded here so the eye-test doesn't chase it.
4. **Shadow getter staleness**: `jumpChargeLevel()` publishes per TickMovement
   (30-60 Hz) — the bar may quantize. Accepted (alternative = JS-side world borrow,
   rejected).
5. **Conflict surfaces** (ROADMAP §3): `system.rs` (A14-I2 W2-in-flight, A6-T1 W4
   rewrite — land I4 strictly after both, i.e. W5 slot) and `lib.rs` (queue with Batch R4
   getters: A4-Q2 `notifyAnimationDone`, A10-M3a, A11-S4, A5-P3 — ROADMAP §5 line 175-176
   already co-batches "A14-I4 charge-clock" there). `jump_charge.rs` as a new module keeps
   the `system.rs` diff to ~3 lines.
6. **Manifest discipline**: missing bump strands stale `pkg/` consumers — typeof guards
   degrade to legacy; JS test covers the degraded path.

**Rollback:** `?jumpParity` off (JS-only flag) restores the legacy clock/curve/send path
exactly; the wasm additions are dead code behind unreached commands; full revert =
rebuild previous `pkg/` (manifest v2 handles the JS side automatically).

---

## 6. OPEN QUESTIONS

1. **Charge-time error 73 semantics** — retail's `charge_jump` weenie `vfptr[15]` gate
   (acclient.c:343855, refusal text `cant_jump_load` 408050-408052) is single-cited on
   what it computes (stamina adequacy vs burden). DESIGN.md:460-462 rules: no speculative
   charge-time gate; ACE gates at release only. This spec complies (commence can only
   refuse 72). Revisit if ACE-side evidence for a press-time gate appears.
2. **Stance 0x80000046 identity** — our enum maps it to `MotionStance::DualWieldCombat`
   (types.rs:85), making the 0.8 s fast-charge a dual-wield perk, which is surprising.
   The retail cite (acclient.c:407933-407939) is solid on the CONSTANT; the enum NAME for
   this client build is inherited from ACE and unverified against the client's own DAT
   motion table. Implement against the raw constant `0x0046` with the enum used only for
   readability.
3. **Refusal text wording** — `cant_jump_*` string contents are not in the decompile
   (globals only, acclient.c:56814-56818; note retail also has `cant_jump_stamina` and
   `cant_jump_recent` whose producers were not located in this read). ACE WeenieError
   wording proposed; the ACE checkout here lacks the Network tree (A13 §6), so confirm
   wording when greppable.
4. **Root-vs-convert during charge** — retail REFUSES forward motions while
   `standing_longjump` is set (acclient.c:343996-344004); our G-7 path converts a
   movement keypress to an un-rooted moving jump (index.html:8667-8673). This spec keeps
   the modernization (consistent with ROADMAP §8's deliberate-input-modernization class)
   — flag for a human ruling if strict parity is wanted.
5. **Position-gate input fidelity** — retail gates on the INTERPRETED forward command;
   ours uses server-echoed `current_substate` (mutations.rs:305-318). A14 §4 I4's "reads
   interp_state" upgrade requires A3-D1/Stage-2's live interpreted state; the upgrade
   point is `commence`/`execute_jump_release` swapping the predicate input — one line
   each, deferred to when motion_interp's queue lands (W2 assumption).
6. **Server-controlled release lane** — retail's non-autonomous DoJump branch sends
   `Event_Jump_NonAutonomous(extent)` (acclient.c:408206-408224); we have no codec or
   send for it and no current path can reach it (server-controlled projection suppresses
   manual drives, system.rs:714-848 per A14 §3 row 10). Should `execute_jump_release`
   explicitly refuse while server-controlled, or is the suppression sufficient? Defaulting
   to "no extra gate" (matches today); A3-Stage-3/A13 seam owns the non-autonomous lane.
7. **`CommenceJump`'s trailing `cmdinterp->vfptr[6].OnAction()` call**
   (acclient.c:408075) — unidentified virtual (auto-attack/forward-movement family
   suspected); single-cited, not implemented, recorded so the omission is a decision.
8. **JumpCharging body-language pose** — the crouch-charge overlay mentioned at
   index.html:8589-8590 (motion 0x4000001D) has no locatable code-path hit in acclient.c
   (constant appears only in data tables at 40434/40869/43895). Cannot dual-cite →
   out of scope; renderer-side follow-on once a retail cite exists.
