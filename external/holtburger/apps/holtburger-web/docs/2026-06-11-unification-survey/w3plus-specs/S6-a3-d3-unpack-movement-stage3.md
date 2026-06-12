# S6 / A3-D3 — unpack_movement Stage-3 delta: the DoMotion lattice + MovementManager facade

Execution-grade spec for ROADMAP item **A3-D3** (wave **W4**, gate: *Stage-1 eye-test PASS + W2*).
Derived from: survey `agents/A3-movement-stack-gap.md` §4 D3, the A3-D1-amended
`docs/2026-06-11-unified-movement-pipeline/DESIGN.md` ("STAGE 3 AMENDMENT", lines 548–588),
ROADMAP §2 seam ("A3-D3 needs D1's DoMotion lattice; **serialize with A13 on the recv arm**"),
RULINGS.md (no D3-relevant rulings; §7.7 sticky ruling affects only the A2-P3 follow-on).
All repo paths relative to `external/holtburger/` unless rooted. Retail truth:
`/home/wbterminal/ac-headers/acclient.c` (+`.h`). ACE cross-ref: `external/ACE/Source/`.

---

## 1. read-HEAD + W2 assumptions

- **Read HEAD: `61bea82f`** (holtburger: W2/Batch-R2 buildbox dispatch manifest).
  Mid-read, **`3172c03e` (A4-Q1 MotionTableManager pending-animation queue core) landed** —
  the W2 wave is committing live. All `lib.rs` line numbers below were read at `61bea82f`
  and WILL drift; grep symbols, not lines.
- **W0/W1 facts verified in-tree at read time** (not assumptions):
  - canonical tick spine `crates/holtburger-core/src/client/tick_spine.rs` exists
    (`tick_frame` :61–89, `TickSpineHandle` :178–239, gated `?unifiedTick=on`);
  - A13-W1 routing exists: `should_route_message_to_world` (lib.rs:22053) routes
    `UpdatePosition | VectorUpdate | UpdateMotion | PlayerTeleport` to world handlers under
    `?wireStatePacks=stage1` (lib.rs:22088–22099); shared consumer
    `MovementSystem::apply_self_movement_world_events` (movement/system.rs:2948);
  - A13-W2 golden-bytes `server_control_sequence` echo-chain test exists (commit `b5a31b99`);
  - A13-W3 single MoveToState builder exists (commit `6ce48bc9`);
  - Stage-1 `motion_interp.rs` exists but is **ephemeral**: `interpreted_velocity_for_state`
    (motion_interp.rs:402–418) constructs a throwaway `MotionInterp` per call; there is **no
    persistent per-entity instance, no DoMotion, no pending_motions field, no move_to.rs**
    (verified: grep `do_motion|DoMotion|pending_motions` over crates/ = doc-comment hits only;
    `movement/` dir listing has no `move_to.rs`).
- **In-flight W2 items this spec ASSUMES LANDED before D3 starts** (W4 is gated on W2):
  - **A4-Q1** (`3172c03e`, landed mid-read): `movement/motion_table_manager.rs` — AnimNode
    FIFO, `animation_done`, `check_for_completed_motions` skeleton, default-off const.
  - **A3-D2**: `motion_done(success)` / pending_motions consumer half on `MotionInterp` +
    exhaustion lane (`USE_EXHAUSTION_RUN_RATE`). **Uncertain extent**: the W2-PROMPT scopes
    D2 as "the MotionDone/exhaustion consumer half"; whether it ships the FULL DoMotion entry
    lattice (style errors 63–66, 6-cap 69) and `enter_default_state` is unverifiable pre-land.
    → D3 stage **D3-0 below is a verify-or-implement stage**, fully specced so the implementer
    needs no judgment either way.
  - **A2-P1** (interp-node queue generalization), **A7-R1/R2/R3/R6** (spatial helpers),
    **A9-Stage1** (placement-id plumb): no API this spec consumes; only file-conflict ordering
    (entity.rs after A7-R6; lib.rs queueing) matters.
- NOT assumed: A4-Q2 (`notifyAnimationDone` export, W3), A5-P1 (hook drain, W3), A6-T1
  (W4 sibling — see §5 serialization), A2-P3 (sticky owner, W5).

---

## 2. Current-state map (post-W0/W1, pre-D3)

### Retail shape being ported (dual-citation anchors)

`MovementManager::unpack_movement` (acclient.c:339492–339621), the server-UpdateMovement
decoder, per entity:

| step | retail behavior | cite |
|---|---|---|
| preamble | `cancel_moveto` + `unstick_from_object` on EVERY unpack, before any gate | acclient.c:339518–339519 |
| header | u16 word: low byte = movement type, high byte = flags (`pack_word_1 = HIBYTE`); u16 style index → full dword via `command_ids_0[]` | acclient.c:339534–339540 |
| style change | `InqStyle() != style` → `CMotionInterp::DoMotion(style, &params)` BEFORE payload dispatch, for ALL types | acclient.c:339541–339542 |
| case 0 | `InterpretedMotionState::UnPack`; sticky DID iff `flags & 1`; `move_to_interpreted_state(state)`; THEN `stick_to_object(guid)`; THEN `standing_longjump = word & 0x200` (= flags-byte bit 0x02) | acclient.c:339546–339560 |
| case 6 MoveToObject | `MakeMoveToManager`; guid + origin + params + trailing float → **`motion_interpreter->my_run_rate = float`**; missing object → **falls back to `MoveToManager::MoveToPosition(pos, params)`** (LABEL_15) | acclient.c:339564–339576, :339571, :339572–:339585 |
| case 7 MoveToPosition | params + float → `my_run_rate`; `MoveToManager::MoveToPosition` | acclient.c:339578–339585, :339583 |
| case 8 TurnToObject | guid + packed heading float + params; missing object → `params.desired_heading = heading; MoveToManager::TurnToHeading(&params)` | acclient.c:339595–339605, :339604–339605 |
| case 9 TurnToHeading | `MoveToManager::TurnToHeading` | acclient.c:339613–339614 |
| default (types 1–5) | no body bytes read, returns 0 | acclient.c:339616–339618 |

`CMotionInterp::DoMotion` — **the lattice** (acclient.c:344600–344666; ACE 1:1
`Physics/Animation/MotionInterp.cs:112–158`):

1. no physics obj → error **8** (`WeenieError.NoPhysicsObject = 0x0008`,
   ACE.Entity/Enum/WeenieError.cs:30) — acclient.c:344616–344617 / MotionInterp.cs:114–115.
2. copy params; `CancelMoveTo` bit (bitfield bit 15, `SBYTE1(v8) < 0`) → `cancel_moveto` —
   acclient.c:344633–344634 / MotionInterp.cs:123–124.
3. `SetHoldKey` bit (bit 11, `BYTE1 & 8`) → `SetHoldKey(hold_key_to_apply, cancel_moveto_bit)` —
   acclient.c:344635–344637 / MotionInterp.cs:126–127.
4. `adjust_motion(&motion, &speed, hold_key)` — acclient.c:344638 / MotionInterp.cs:129
   (already ported: motion_interp.rs `adjust_motion`, Stage 1).
5. style gate, only when `interpreted_state.current_style != 0x8000003D` (NonCombat;
   decompile literal `-2147483587`): Crouch `0x41000012` → **63**, Sitting `0x41000013` → **64**,
   Sleeping `0x41000014` → **65**, `motion & 0x2000000` (ChatEmote mask) → **66** —
   acclient.c:344639–344649 / MotionInterp.cs:131–144; error values
   WeenieError.cs:156–162 (0x3F/0x40/0x41/0x42).
6. action bit `0x10000000` && `GetNumActions() >= 6` → **69** (`TooManyActions = 0x45`,
   WeenieError.cs:169) — acclient.c:344651–344653 / MotionInterp.cs:147–150.
7. `DoInterpretedMotion`; on success && `ModifyRawState` bit (bit 13, `BYTE1 & 0x20`) →
   `RawMotionState::ApplyMotion(motion, params)` — acclient.c:344656–344662 /
   MotionInterp.cs:152–155.

`CMotionInterp::DoInterpretedMotion` (acclient.c:343975–344031; MotionInterp.cs:51–110):
`contact_allows_move` gate (fail + action bit → **36** `YouCantJumpWhileInTheAir = 0x24`,
WeenieError.cs:80; fail + non-action → apply-interp-only, success); `standing_longjump`
suppression for WalkForward `0x45000005` / RunForward `0x44000007` / SideStepRight
`0x6500000F` (acclient.c:343990 / MotionInterp.cs:59); Dead `0x40000011` →
`RemoveLinkAnimations` (acclient.c:343992–343993 / MotionInterp.cs:66–67); jump_error_code:
`DisableJumpDuringLink` bit `0x20000` → **72** (`YouCantJumpFromThisPosition = 0x48`,
WeenieError.cs:176), else `motion_allows_jump(motion)`, else (non-action) fall back to
`motion_allows_jump(forward_command)` (acclient.c:343996–344005 / MotionInterp.cs:73–84);
`add_to_queue(context_id, motion, jump_error_code)` (acclient.c:344006 / MotionInterp.cs:85);
`ModifyInterpretedState` bit (bit 14, `BYTE1 & 0x40`) → interp `ApplyMotion`.

`CMotionInterp::StopInterpretedMotion` (acclient.c:344034–344078): success path enqueues
**Ready `0x41000003`** with jump_error 0; `ModifyInterpretedState` → `RemoveMotion`.
`CMotionInterp::PerformMovement` (acclient.c:344670–344720; MotionInterp.cs:236–258): 5-way
dispatch (DoMotion / DoInterpretedMotion / StopMotion / StopInterpretedMotion /
StopCompletely), `CheckForCompletedMotions` after EACH arm, unknown type → **71**
(`GeneralMovementFailure = 0x47`, WeenieError.cs:171).

`CMotionInterp::enter_default_state` (acclient.c:344560–344597): reset raw+interp states,
`InitializeMotionTables`, **seed pending_motions with one Ready node (`1090519043 =
0x41000003`**, acclient.c:344582), set `initted`, call `LeaveGround`.

`MovementManager` facade (one per physics obj): `PerformMovement` types 1–5 → lazy
`CMotionInterp::Create` + `enter_default_state` then minterp (acclient.c:339192–339200),
types 6–9 → lazy MoveToManager (acclient.c:339203–339211), default → 71 (:339213);
`move_to_interpreted_state` lazy-create-first (:339221–339236); `EnterDefaultState`
(:339250–339268); `MotionDone` → minterp only (:339349–339355); `UseTime` → MoveToManager
only (:339359–339365); `HitGround` → BOTH (:339369–339382); `LeaveGround` → BOTH
(:339385–339398, decompiler garbles the moveto callee; ACE MovementManager.cs:124–132
confirms); `ReportExhaustion` → BOTH (:339421–339434); `HandleUpdateTarget` → MoveToManager
only (:339631–339639). ACE 1:1: `Physics/Managers/MovementManager.cs:9–178`.

`get_leave_ground_velocity` (acclient.c:343806–343843): `get_state_velocity` (closed-form,
clamped run_rate×4.0) + `get_jump_v_z` z; falls back to transformed physics velocity when
~zero; consumed by `LeaveGround` (acclient.c:344457–344490).

### Ours, at read-HEAD

| concern | where | state |
|---|---|---|
| envelope decode | `crates/holtburger-protocol/src/messages/movement/messages/motion.rs:23–117` (`MovementEventData`: guid, 3 sequences, is_autonomous, movement_type, motion_flags, current_style) | PARITY decode; types 1–5 correctly read no body (:94–101) |
| sticky DID decode | motion.rs:167–176 (`MovementInvalid::unpack_ext`, `flags & 0x01`) | decoded; consumed only as a JS hint (lib.rs `sticky_target` emit, grep `inv.sticky_object`, ~:33931) — F3-4 |
| MoveTo trailing run_rate | motion.rs:212 (MoveToObject), :246 (MoveToPosition) | decoded, **unconsumed Rust-side**; JS gets it as a kind=5 vx ride (F3-5) |
| `motion_flags & 0x02` (standing_longjump) | decoded motion.rs:65–67; entity decode entity.rs:265 | **zero consumers** (grep: constructors/tests only) |
| style | `current_style` u16; low16→dword expansion exists: `holtburger_world::player::expand_motion_command_low16` (player/types.rs:100) | consumed for substate tracking (mutations.rs:312–320) + JS stance hint; **no DoMotion-on-style-change path** |
| local-player apply | `handlers/player.rs:96–107` → `apply_self_update_motion` (player/mutations.rs:293–321): sequence gate `should_accept_server_controlled_motion` (:283–289), emits `WorldEvent::SelfServerControlledMotion` (events.rs:197) only when accepted && !autonomous | canonical; reached on wasm only under `?wireStatePacks=stage1` |
| remote apply | `handlers/movement.rs:56–107` (`GameMessage::UpdateMotion`): lossy `EntityMotionSnapshot`, change-gated `WorldEvent::EntityMotionUpdated` (movement.rs:18–24, events.rs:88), ad-hoc TurnTo heading → `set_entity_rotation` (:79–107) | no preamble, no style-DoMotion, no run_rate install, no MoveToManager |
| wasm recv arm | lib.rs `GameMessage::UpdateMotion` arm (:33790+) | JS-facing EntityUpdate hint emitter ONLY (locomotion hint, sticky_target, run_rate vx); A13-W1 made the world-handler path reachable behind the flag |
| MotionInterp | motion_interp.rs:167–188 — ephemeral per-call; no `current_style` field on `InterpretedState` (interp_state.rs:38–51); action FIFO uncapped (interp_state.rs:50) | D3-0 territory (modulo W2 A3-D2) |
| MoveToManager | absent (no `movement/move_to.rs`) | D3-2 creates the skeleton |
| leave-ground velocity | system.rs:1422–1443 freezes UNCLAMPED `current_planar_velocity` at launch; write sites :1473, :1582; charged jump uses interpreted intent (lib.rs jump arm) | survey A3 §3 row 6 DIFF-ALGO |
| MotionTableManager | `movement/motion_table_manager.rs` (A4-Q1, `3172c03e`, landed mid-read) | completion pump source for `check_for_completed_motions` |

---

## 3. Staged implementation plan (all stages default-OFF; wasm-rebuild batch; NO manifest bump — zero new/changed wasm exports)

Flag plan (DESIGN Stage-3 pattern "per-feature Rust consts default OFF", DESIGN.md:585):
- `const USE_UNPACK_MOVEMENT_SEMANTICS: bool = false` — gates D3-1/D3-2/D3-3/D3-4 consumers
  (one switch; the new structs are inert dead code without it). Lives at top of
  `movement/movement_manager.rs`, follows the `USE_*` const-gate pattern (url-flags.md:245–273).
- `const USE_LEAVE_GROUND_VELOCITY: bool = false` — gates D3-5 alone (separate eye-test,
  separate rollback), top of `movement/system.rs` next to `USE_INTERPRETED_VELOCITY` (:270).
- Both flips are wasm-rebuild + native; record rows in `apps/holtburger-web/docs/url-flags.md`
  const-gate section. **No `WASM_EXPORT_MANIFEST_VERSION` bump** (F18-2 applies only to
  export-surface changes; D3 adds none — if a later reviewer adds any JS-visible getter,
  the bump rule re-engages).

### D3-0 — verify-or-implement the DoMotion lattice (`movement/motion_interp.rs`, `movement/interp_state.rs`)

Precondition audit (W2 drift rule, W2-PROMPT.md:22): grep `do_motion`, `pending_motions`,
`current_style` in `movement/`. Whatever A3-D2/A4-Q1 already landed, KEEP — implement only
the missing pieces below; never duplicate (`a916d12e` DESIGN amendment is the single spec).

1. `InterpretedState.current_style: u32`, default `0x8000003D` (retail NonCombat default —
   acclient.c:344639 literal `-2147483587`; ACE MotionInterp.cs:131; our interp_state.rs:38–51
   lacks it). `InqStyle()` ≙ a getter on `MotionInterp`.
2. Runtime `MovementParameters` (new struct in motion_interp.rs or `movement/params.rs`):
   `{ bitfield: u32, speed: f32, hold_key_to_apply: u32, context_id: u32, desired_heading: f32,
   distance_to_object: f32, min_distance: f32, fail_distance: f32, walk_run_threshhold: f32,
   action_stamp: u32 }`; named bit accessors `cancel_moveto()=bit15, set_hold_key()=bit11,
   modify_raw_state()=bit13, modify_interpreted_state()=bit14, disable_jump_during_link()=bit17,
   sticky()=bit7` (acclient.c:344633/:344636/:344661/:344012/:343996; sticky bit per the
   shipped `moveto_is_sticky` 0x80, lib.rs:5223). Default per retail ctor
   (acclient.c:339441–339489; ACE `MovementParameters.cs` defaults). The protocol
   `MoveToParameters.movement_parameters: u32` (motion.rs:348–349) feeds this verbatim.
3. `MotionInterp::do_motion(&mut self, motion: u32, params: &MovementParameters) -> Result<(), u32>`
   — exact §2 lattice steps 2–7 (errors 63/64/65/66/69; cites above). Physics-obj null
   (error 8) is structurally unreachable in our registry — document, don't port.
4. `do_interpreted_motion` / `stop_interpreted_motion` / `stop_motion` /
   `perform_movement(mvs)` per §2 cites — `perform_movement` calls
   `motion_table_manager.check_for_completed_motions()` after EVERY arm (acclient.c:344684–344704;
   the A4-Q1 module from `3172c03e` provides it). Physics-side effects (`cancel_moveto`,
   `remove_link_animations`, `stick/unstick`) are NOT performed inline: they are returned in
   the `UnpackEffects` value (D3-3) / a small `MotionSideEffects` bitset, because our physics
   owner is the integrator + JS rig, not a `CPhysicsObj`. `CPhysicsObj::DoInterpretedMotion`'s
   inner body (sequence playback) is A4/A5 territory — here it is the
   motion_table_manager `add_to_queue` call (per the DESIGN amendment chain, DESIGN.md:399–413).
5. `enter_default_state()`: reset both states, seed pending_motions with one Ready
   `0x41000003` node (acclient.c:344582), `initted = true`, `leave_ground()`
   (acclient.c:344560–344597; ACE MotionInterp.cs:610–615). `InitializeMotionTables` analog =
   motion_table_manager `initialize_state` Ready node (DESIGN.md:101–102).

### D3-1 — MovementManager facade + registry (NEW `crates/holtburger-core/src/client/movement/movement_manager.rs`)

- `pub(crate) struct MovementManager { motion_interp: Option<MotionInterp>,
  move_to: Option<MoveToManager> }` — children lazily created; minterp creation ALWAYS runs
  `enter_default_state` first (acclient.c:339192–339199, :339221–339236; ACE
  MovementManager.cs:33–56, :106–115 `MakeMoveToManager`).
- Fan-out methods exactly per §2 facade table: `perform_movement` (types 1–5 → minterp,
  6–9 → moveto, else Err(71), acclient.c:339175–339218), `move_to_interpreted_state`,
  `enter_default_state`, `motion_done(motion, success)` → minterp only (:339349–339355),
  `use_time` → moveto only (:339359–339365), `hit_ground` → both (:339369–339382),
  `leave_ground` → both (:339385–339398), `report_exhaustion` → both (:339421–339434),
  `handle_update_target` → moveto only (:339631–339639), `handle_exit_world` → minterp
  (:339417 area; ACE MovementManager.cs:90–94).
- **Registry**: `MovementSystem` gains
  `movement_managers: HashMap<Guid, MovementManager>` (per-entity, per-entity `my_run_rate` —
  the F3-5 no-globals rule, DESIGN.md:655–659). Local player keyed by player guid. Pruned on
  `WorldEvent::EntityDespawned` inside the same event-consumption pass D3-3 adds (the spine
  already surfaces despawns on both targets — tick_spine.rs:115–147, native runtime.rs).
  Do NOT put core types on `holtburger_world::Entity` (dependency direction: core → world).

### D3-2 — MoveToManager skeleton (NEW `crates/holtburger-core/src/client/movement/move_to.rs`)

Scope-minimal for D3 (the per-frame `UseTime`/`HandleMoveToPosition` driver is the base
Stage-3 follow-on; A2 owns the position-trio seam — survey A3 §1 last para, ROADMAP §2):
- `enum MoveToDirective { MoveToObject { target: Guid, origin, params },
  MoveToPosition { origin, params }, TurnToHeading { params } }` + current directive slot,
  `move_to_position`, `turn_to_heading`, `cancel_moveto(err)`, `hit_ground` (re-begin stub),
  `handle_update_target(target_info)` (records target position updates — the A2-P3
  "target-update plumbing" anchor, ROADMAP §2 A2/A3 seam). Declarations cite
  acclient.c:7129–7161; ACE `Physics/Animation/MoveToManager.cs`.
- `use_time()` is a no-op stub with a `// Stage-3 driver follow-on` comment. Until the driver
  lands, the EXISTING render-side consumers (handlers/movement.rs:79–107 TurnTo heading-set;
  JS KIND_TURN fixed-K ease, lib.rs:18044 cite in DESIGN.md:528–529) keep producing motion —
  no double-driver risk because the skeleton stores but does not act.
- Leave an explicit `// A13-W4 TurnToEvent emit hook (design-gated, ROADMAP §8 row 2)` comment
  at `turn_to_heading` — **no send is wired in D3** (A13 §4 W4: ACE handler existence
  unresolved; A13 report :192–202).

### D3-3 — unpack_movement semantics (the core deliverable)

`MovementManager::apply_unpacked_movement(&mut self, data: &MovementEventData,
target_exists: bool) -> UnpackEffects` — pure, returns effects; port of
acclient.c:339492–339621 over our already-decoded `MovementEventData`:

```rust
pub(crate) struct UnpackEffects {
    pub cancel_moveto: bool,        // always true (preamble)
    pub unstick: bool,              // always true (preamble)
    pub stick_to: Option<Guid>,     // case 0, flags & 0x01
    pub style_do_motion: Option<u32>, // expanded style when it changed
    pub standing_longjump: Option<bool>, // case 0 only: flags & 0x02
    pub motion_errors: Vec<u32>,    // lattice rejections (diagnostics only; server is authoritative)
}
```

1. preamble: set `cancel_moveto`/`unstick` effects + `self.move_to.cancel_moveto()`
   (acclient.c:339518–339519). See §3a A13 note for the local-player gating decision.
2. style: `expand_motion_command_low16(data.current_style)` (player/types.rs:100 — our
   `command_ids_0[]` analog, acclient.c:339540); if `Some(style)` and
   `style != minterp.inq_style()` → `minterp.do_motion(style, &MovementParameters::default())`
   (acclient.c:339541–339542). Runs for ALL movement types, before payload dispatch.
3. `MovementType::Invalid` (case 0): `move_to_interpreted_state(&data.state)` (existing
   stamp/autonomy gates, motion_interp.rs Stage 1 ↔ acclient.c:344372–344426) → THEN
   `stick_to = inv.sticky_object` (motion.rs:169) → THEN
   `standing_longjump = Some(data.motion_flags & 0x02 != 0)` — preserve retail's exact
   ordering move→stick→longjump (acclient.c:339557–339560).
4. `MoveToObject` (case 6): `minterp.my_run_rate = m.run_rate` (motion.rs:212 ↔
   acclient.c:339571); `target_exists` → moveto directive `MoveToObject`; **missing target →
   `move_to_position(m.origin, m.params)`** (retail LABEL_15 fallback, acclient.c:339572–339585).
   `target_exists` is computed by the CALLER (`state.entities.get(target).is_some()` — core
   cannot see world entities at this layer).
5. `MoveToPosition` (case 7): `my_run_rate = m.run_rate` (motion.rs:246 ↔ acclient.c:339583);
   `move_to_position`.
6. `TurnToObject` (case 8): `target_exists` → directive TurnToObject-equivalent (record only);
   missing → `params.desired_heading = m.desired_heading; turn_to_heading(params)`
   (acclient.c:339604–339605; our decode motion.rs:265+).
7. `TurnToHeading` (case 9): `turn_to_heading` (acclient.c:339614).
8. types 1–5: no payload (motion.rs:94–101 ↔ acclient.c:339616–339618) — style step still ran.

**Wiring (both targets through ONE path — the A13 rule):**
- `handlers/movement.rs` UpdateMotion arm (remote, :56) and `PositionAndMovementEvent`
  movement half (:130–143) additionally emit a NEW
  `WorldEvent::EntityMovementEvent { guid: Guid, data: Box<MovementEventData>,
  target_exists: bool }` (events.rs — next to :88), emitted UNCONDITIONALLY per message
  (the preamble is per-unpack, not change-gated; the existing change-gated
  `EntityMotionUpdated` (:18–24) is the wrong vehicle — keep it untouched).
- `handlers/player.rs` local arm: reuse the existing `WorldEvent::SelfServerControlledMotion`
  (player.rs:99–104), which already fires only when `apply_self_update_motion` ACCEPTS
  (sequence gate mutations.rs:283–289) — see §3a item 2.
- `MovementSystem` consumer: extend the A13-W1 helper site — a sibling
  `apply_movement_world_events(&mut self, events)` next to
  `apply_self_movement_world_events` (system.rs:2948), called from BOTH the native
  `messages.rs:50–105` event pass and the wasm `?wireStatePacks=stage1` consumption site,
  gated by `USE_UNPACK_MOVEMENT_SEMANTICS`. It looks up/creates the registry entry,
  calls `apply_unpacked_movement`, then applies `UnpackEffects` in core's domain
  (today: record `standing_longjump` for the jump gates; sticky/unstick effects are
  RECORDED on the manager and exposed via a getter for the A2-P3 owner — D3 does not move
  the JS sticky pin, F3-4 stays untouched).
- **Zero edits to the lib.rs UpdateMotion recv arm** (:33790+) — it remains the JS hint
  emitter. See §3a.

### D3-4 — standing_longjump surface (`crates/holtburger-world/src/entity.rs` slice)

`EntityMotionSnapshot` gains `standing_longjump: bool` from `motion_flags & 0x02`
(decode already present: entity.rs:265, motion.rs:65–67; retail consumer
acclient.c:339560 — completes G-7/F1-6 wire-side, survey A3 §3 row 4). Local-player jump
gates may then consult it (lib.rs jump arm reads world state already — follow-on wiring may
ride the same const). Conflict matrix: entity.rs edits serialize A8-M1(W1) → A7-R6(W2) →
**A3-D3(W4)** (ROADMAP §3 row `entity.rs`).

### D3-5 — non-charged leave-ground velocity (`movement/system.rs`, separate const)

Behind `USE_LEAVE_GROUND_VELOCITY`: at the airborne transition, stamp
`current_planar_velocity` from the **clamped** `get_state_velocity` form (run_rate×4.0
magnitude cap — acclient.c:343806–343843 `get_leave_ground_velocity`, consumed by
LeaveGround acclient.c:344457–344490; ACE MotionInterp.cs:192) with the retail fallback to
the integrator's transformed velocity when the closed form is ~zero; replaces the unclamped
freeze (system.rs:1422–1443, write sites :1473/:1582 — survey A3 §3 row 6: diagonal
run+strafe launches ~5.7 m/s vs retail's 4.0×rate cap). Charged-jump departures (interpreted
intent, lib.rs jump arm) unchanged (DESIGN.md:487–488). Also clear
`standing_longjump`/`jump_extent` on the transition (acclient.c:344471–344476) once D3-4's
field exists. HitGround stays event-less per the recorded decision (DESIGN.md:476–479;
survey A3 §6 — per-tick re-derive subsumes it; do NOT add one).

### 3a. SERIALIZE-WITH-A13 NOTE (ordering/serialization constraints — required)

1. **Recv-arm ownership.** A13-W1 (`ac3f9891`) made the canonical world-handler path
   reachable on wasm behind `?wireStatePacks=stage1` (lib.rs:22088–22099). D3 consumes
   ONLY that path. Consequence: **on wasm, D3 semantics are active iff
   `USE_UNPACK_MOVEMENT_SEMANTICS` (rebuild) AND `?wireStatePacks=stage1` (URL)** — without
   stage1, UpdateMotion never reaches `handlers/` and D3 is inert by construction. Document
   the coupling in url-flags.md. D3 makes **no edits to `should_route_message_to_world` and
   no edits to any lib.rs recv arm** — adding a third hand-mirror is the exact F2-3/teleport
   bug class A13 row 3 retired (A13 report §3 row 3; lib.rs:31420-area history).
2. **Sequence gate BEFORE semantics (local player).** Retail runs the unpack preamble
   unconditionally (acclient.c:339518–339519, before any stamp check; the stamp/autonomy
   gates live inside `move_to_interpreted_state`, acclient.c:344398–344426). Ours must NOT
   run preamble/style-DoMotion for a local-player UpdateMotion that FAILS
   `should_accept_server_controlled_motion` (mutations.rs:283–289) or is an autonomous
   self-echo: ACE echoes the originator on every accepted move
   (`BroadcastMovement` `EnqueueBroadcast(true, ...)` — Player_Networking.cs:365, cited in
   the lib.rs arm doc :33793–33801), which retail servers did not; an unconditional preamble
   would cancel-moveto/unstick the local player on every echo. Implementation: the local
   lane keys off `SelfServerControlledMotion`, which already fires only on
   accepted && !autonomous (player.rs:99–104) — the gate is structural. This is a
   deliberate, documented deviation (OPEN QUESTION 1). Remote entities: unconditional, as
   retail.
3. **A13-W2 echo-chain invariant.** D3 must not perturb `server_control_sequence`
   record/echo: the golden-bytes chain test (`b5a31b99`; recording via
   `apply_self_movement_world_events`, system.rs:2948–2978; echo via the single A13-W3
   builder, `6ce48bc9`) must pass UNCHANGED with both D3 consts ON — D3 reads
   `MovementEventData` but never writes any of the quartet.
4. **Send surface.** D3 sends NOTHING new. MoveToState stays raw-state-serialized,
   byte-identical (DESIGN.md §4: interpreted speeds are local realization only;
   wire speeds stay 1.0, common.rs:627–633 rationale). The future A13-W4 TurnToEvent emit
   point is D3-2's MoveToManager — comment only, design-gated on ACE-handler confirmation
   (A13 §6; ROADMAP §8).
5. **File serialization in-wave.** lib.rs is the hottest column (ROADMAP §3): D3's only
   lib.rs touch is NONE (by rule 1) — so D3 does not queue behind W3's lib.rs items
   (A4-Q2 export, A5-P3 metadata). `movement/system.rs` column: A6-T1 (same wave W4)
   "rewrites the tick spine those hooks live in" — land D3-0..D3-4 BEFORE A6-T1
   (motion_interp/movement_manager/move_to are new files, minimal system.rs surface), and
   land D3-5 (the system.rs slice) explicitly serialized against A6-T1 in whichever order
   the W4 dispatcher picks, rebasing the loser (ROADMAP §3 row `movement/system.rs`).

---

## 4. Test plan

### Headless-now (Lane A — land flag-off with these green; no 1070)

Rust unit (motion_interp.rs / movement_manager.rs / move_to.rs tests, extending the Stage-1
suite at motion_interp.rs:420+):
1. **DoMotion lattice table**: style errors fire only when `current_style != 0x8000003D`
   (63/64/65 for 0x41000012/13/14, 66 for `0x2000000`-masked) — acclient.c:344639–344649;
   NonCombat style passes. 6-action FIFO cap → 69 (acclient.c:344651–344653); cap counts
   only `0x10000000` actions.
2. **Bit semantics**: CancelMoveTo(bit15) effect, SetHoldKey(bit11) routes
   (hold_key, cancel_bit), ModifyRawState(bit13) applies raw ONLY on success,
   ModifyInterpretedState(bit14) applies/removes interp — acclient.c:344633–344662.
3. **do_interpreted_motion matrix**: jump_error_code = 72 under DisableJumpDuringLink
   (0x20000); action keeps own `motion_allows_jump`; non-action falls back to
   forward_command's; contact-fail + action → 36; contact-fail + non-action →
   interp-apply-only success; standing_longjump suppresses exactly
   {0x45000005, 0x44000007, 0x6500000F} — acclient.c:343975–344031 / MotionInterp.cs:51–110.
4. **perform_movement**: completion pump runs after EVERY arm (zero-anim motion completes
   inside the same call — observable via A4-Q1 queue state); unknown type → 71 —
   acclient.c:344670–344720.
5. **enter_default_state**: queue head == Ready 0x41000003, initted, leave_ground ran —
   acclient.c:344560–344597.
6. **Unpack fixture matrix** (build `MovementEventData` fixtures through the REAL decoder,
   motion.rs:23–117): preamble effects on every unpack incl. repeated identical messages;
   style-DoMotion only on style delta and for ALL types; case-0 effect ORDER
   move→stick→longjump (acclient.c:339557–339560); `motion_flags & 0x02` →
   standing_longjump true/false; case-6/7 `my_run_rate` install (assert per-entity isolation:
   two guids, two rates — F3-5 pin); case-6 missing-target → MoveToPosition directive
   (acclient.c:339572–339585); case-8 missing-target → TurnToHeading with packed heading
   (acclient.c:339604–339605); types 1–5 → style step only, no payload effects.
7. **Facade fan-out**: hit_ground/leave_ground/report_exhaustion reach both children;
   use_time/handle_update_target only moveto; motion_done only minterp — §2 facade cites.
8. **Registry**: lazy-create runs enter_default_state exactly once; prune on
   EntityDespawned; local-player guid keyed.
9. **Regression pins**: sticky decode bytes (motion.rs:167–176) and run_rate decode
   (motion.rs:212/:246) untouched (F3-4/F3-5); A13-W2 golden echo-chain test green with
   both consts ON (§3a.3); default-off byte/behavior identity — with consts false, the
   full `cargo test --workspace` suite passes unmodified.
10. wasm routing assert (existing lane): `should_route_message_to_world` table tests
    (lib.rs:22192+) unchanged — D3 adds no routes.

### 1070-gated (Lane B — parked until the box returns; W4's gate is Stage-1 eye-test PASS)

- Remote MoveTo gait tempo per-creature (F3-5 no-regress; rate now also installed Rust-side).
- Sticky melee follow + release on action end (F3-4 no-regress; with D1/D2 queue ON,
  one-shot completion fires the unstick hook chain).
- Server style change (e.g. /sit broadcast, combat-stance change) restyles via the one
  DoMotion path — no rig double-restyle.
- Remote standing-longjump pose (the 0x02 bit).
- `USE_LEAVE_GROUND_VELOCITY`: walk-off-ledge at diagonal run+strafe — measured launch speed
  ≤ run_rate×4.0; jump arcs vs ACE unchanged; jump arms-up pose UNCHANGED (landmine,
  DESIGN.md:635–636).
- Teleport/portal: no moveto/sticky carried through (preamble + handle_exit_world chain).

---

## 5. Risks + rollback

- **Rollback**: both consts default false → all new code inert; the new
  `EntityMovementEvent` emit is the only always-on change (unconditional per-UpdateMotion
  alloc; consumer is gated). If even the emit must go, it is one self-contained hunk in
  handlers/movement.rs. D3-4's snapshot field is additive (Default = false).
- **Local-player echo storm** (§3a.2): mitigated structurally by the accepted-&&-!autonomous
  event gate; deviation from retail's unconditional preamble recorded (OPEN QUESTION 1).
- **Double-driver**: D3-2's MoveToManager stores directives but has no driver; the legacy
  TurnTo heading-set (handlers/movement.rs:79–107) and JS KIND_TURN ease keep running. When
  the Stage-3 driver lands later, those must be retired IN THAT change, not D3.
- **W4 same-wave conflicts**: A6-T1 rewrites the system.rs tick spine — D3-5 is the only
  D3 slice in that blast radius; serialize per §3a.5. A14-I2 also targets system.rs intents —
  it consumes, not conflicts (ROADMAP §2 input seam: I2 targets the MoveToManager entry
  shape; D3-2's directive enum is that shape — coordinate the enum name/fields with A14-I2's
  spec before either lands).
- **W2 drift**: if A3-D2 landed a different motion_done/pending shape than DESIGN's
  amendment, D3-0's audit adapts to the LANDED shape (the in-tree code wins; the DESIGN
  amendment is the spec of record for anything still missing).
- **Effects-vs-trait shape**: `UnpackEffects` (pure return) chosen over a hooks trait —
  keeps motion_interp headless-testable and avoids borrowing knots with `WorldState`; the
  cost is each caller must apply effects. If a reviewer prefers hooks, the test matrix is
  unchanged (assert via mock hooks instead of returned struct).
- **Perf**: per-UpdateMotion HashMap lookup + Box clone for the event; UpdateMotion rate is
  low (per-entity, event-driven) — negligible. Registry growth bounded by entity count +
  despawn prune.

---

## 6. OPEN QUESTIONS

1. **Local-player preamble gating** (§3a.2): retail runs cancel_moveto+unstick on every
   unpack unconditionally (acclient.c:339518–339519); we gate it behind the
   accepted-&&-!autonomous event because ACE echoes the originator
   (Player_Networking.cs:365 cite in lib.rs:33793–33801). Single-cited on the
   "retail servers didn't echo autonomous self-motion" half — no retail-server capture
   exists. If a 1070 capture ever shows ACE sending the local player a NON-echo UpdateMotion
   that should cancel a local MoveTo, revisit the gate.
2. **`MovementParameters` ctor defaults**: retail ctor body (acclient.c:339441–339489) sets
   a default bitfield I did not fully decode field-by-field; implementer must transcribe it
   (or ACE `MovementParameters.cs` defaults) when writing D3-0 step 2 — listed here because
   the exact default bitfield for the style-change `DoMotion(style, &params)` call
   (acclient.c:339542 passes the freshly-constructed params) determines which bits
   (ModifyRawState etc.) the style change applies with.
3. **Does the style-index expansion table match?** Retail expands the wire u16 via
   `command_ids_0[]` (acclient.c:339540); ours via `expand_motion_command_low16`
   (player/types.rs:100). Spot-parity is assumed from Wave-10 use but a full table diff
   (all style ids 0x3C–0x44 etc.) has not been done — add a table test if feasible.
4. **W2 final shape of A3-D2** (in-flight at read time): which of {pending_motions field,
   motion_done, enter_default_state, current_style, DoMotion} it ships. D3-0 is written to
   absorb any answer, but the W4 dispatcher should re-read `W2-RESULTS.md` (being written by
   the W2 wave) before scheduling D3.
5. **`stop_motion` body** (acclient.c:344081+): read only as far as the dispatch shape this
   pass; the implementer should transcribe its adjust+StopInterpretedMotion+RemoveMotion
   sequence from the body (survey A3 §1 cites :344081 → :344034 + RawMotionState::RemoveMotion)
   when porting D3-0 step 4.
6. **MotionDone → server reporting**: still UNRESOLVED from survey A3 §6 (no client→server
   send found; likely none). D3 sends nothing — unchanged.
