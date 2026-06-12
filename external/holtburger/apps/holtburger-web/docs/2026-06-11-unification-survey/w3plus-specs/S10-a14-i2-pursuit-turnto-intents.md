# S10 — A14-I2: wasm pursuit / turn-to intents (`PlayerDriveIntent`)

W3+ deep-spec sweep, item S10. Source ROADMAP item: A14-I2 — "synthetic movers off
the input API" (survey `agents/A14-input-to-motion.md` §4 Stage I2; ROADMAP wave W4).
Spec date: 2026-06-12. Author: read-only spec agent (laptop). Dual-citation rule in
force: every behavioral claim cites `~/ac-headers/acclient.c` (retail) AND an in-tree
file:line; anything single-cited lives in §6 OPEN QUESTIONS.

---

## 1. Read-HEAD + landed-W2 facts this spec builds on

`git log --oneline -1` at spec time: **`048573d0` "holtburger: W2 wave results"**
(= master = the fully-landed W2 wave). Repo: `~/WorldBuilder-ACME-Edition/external/holtburger`.

Landed facts this spec treats as current-state (all verified in-tree at 048573d0):

- **A14-I1 single JS InputController is LANDED** (`56bc7bd7`, ancestor of HEAD):
  `apps/holtburger-web/scene3d/input.js` behind `?inputFunnel=on` (default-off),
  documented at `apps/holtburger-web/docs/url-flags.md:135`. Its own header explicitly
  scopes the picking.js synthetic movers OUT: "the synthetic movers (picking.js
  charge/turn-to-face — that is Stage I2, out of scope)" (`scene3d/input.js:17-18`).
  A14-I2 is that promised Stage I2.
- **A4-Q1** `USE_MOTION_TABLE_QUEUE` MotionTableManager queue core (`3172c03e`) and
  **A3-D2** MotionDone/exhaustion consumer (`0c078aa9`) are in
  `crates/holtburger-core/src/client/movement/system.rs` (pump at system.rs:1171-1179).
- **A2-P1** `USE_POSITION_MANAGER_QUEUE` (`e871fca8`) — position trio untouched by
  this spec; noted only because it shares system.rs.
- **A13-W1** canonical movement-message routing on wasm (`ac3f9891`,
  `?wireStatePacks=stage1`) — the recv arm this spec adds SessionCommand arms next to
  is the A13-owned surface; serialize edits (ROADMAP §3 file table, ROADMAP.md:138).
- **`PlayerDriveIntent` already EXISTS** with variants `ManualHeld`, `ManualPulse`,
  `Autonomous(AutonomousDriveIntent)`, `ArriveAtPose`, `SnapFacing`, `Stop`
  (`crates/holtburger-core/src/client/movement_types.rs:184-198`). It dates from the
  May-26 movement overhaul (`421f82f2`), NOT W2. ROADMAP §5 Batch R2's "A14-I2 intent
  enum (code only, JS consumer later)" (ROADMAP.md:171-172) did **not** ship new
  variants in W2 — W2-RESULTS lists no A14-I2 item, and no `Pursue*`/`TurnTo*` variant
  exists in movement_types.rs today (grep clean). The enum EXTENSION is still to do.
- **KIND_TURN exists** (F3-3): `ENTITY_UPDATE_KIND_TURN = 9`
  (`apps/holtburger-web/src/lib.rs:18236`, emission at lib.rs:34124-34150; JS consumers
  `scene3d/loop.js:100,1944,2183`, `scene3d/entities.js:231-236,6619`). That is the
  *server-driven* TurnTo render path for entities; this spec's TurnTo intent is the
  *local-player input-side* entry and does not touch KIND_TURN.
- **Manifest**: `WASM_EXPORT_MANIFEST_VERSION: u32 = 3` (`apps/holtburger-web/src/lib.rs:478`);
  `EXPECTED_WASM_MANIFEST_VERSION = 1` in `apps/holtburger-web/index.html:1803` (F18-2
  handshake, index.html:1794-1801).
- **Tick spine / gates** from W0/W1 (`tick_spine.rs`, `?worldLifecycle`, `?unifiedTick`,
  `?wireStatePacks`) exist; this spec does not add hooks to the spine — pursuit rides
  the existing `MovementSystem::tick` (system.rs:1119).
- **F6-6 is LANDED** (`40a90aa0`, ancestor of HEAD): "read the attack lockout live,
  not at click time" — `fireOnce` reads `cb.attackInProgress` at *execution* time
  (`apps/holtburger-web/scene3d/picking.js:794-819`, mirror note
  `plugins/combat-bar.js:105`). See §2.3.
- **Human rulings**: RULINGS.md has no ruling touching A14-I2 directly; ruling #2 (2D
  stays supported) matters only in that picking.js/charge is 3D-only — no 2D work here.

---

## 2. Current-state map

### 2.1 How pursuit / turn-to flow today (flag-independent, this is the live default)

Retail keeps autonomous movement OUT of the input layer: dedicated MoveTo/TurnTo
managers own it. The single retail entry point is
`MoveToManager::PerformMovement(MovementStruct*)` — it `CancelMoveTo(0x36)` +
`unstick_from_object`, then switches on `mvs->type`: case 6 → `MoveToObject`, 7 →
`MoveToPosition`, 8 → `TurnToObject`, 9 → `TurnToHeading`
(acclient.c:346123-346145; entry prototypes acclient.c:7144-7158; `MovementTypes::Type`
`MoveToObject = 0x6` … acclient.h:2856-2866). Completion/abort funnels through
`MoveToManager::CleanUpAndCallWeenie(status)` (acclient.c:345171) — a status callback,
not a polled flag. Manual raw movement cancels an in-flight MoveTo:
`CMotionInterp::apply_raw_movement(cancel_moveto, …)` → `CPhysicsObj::cancel_moveto`
(acclient.c:344259→344236-ish; `cancel_moveto` body acclient.c:317421-317427 →
`MovementManager::CancelMoveTo(0x36)` acclient.c:339240-339246).

Ours instead synthesizes autonomous movement as **fake WASD axes through the manual
input API** (survey A14 §3 row 2, DIFF-ALGO):

- **Charge pursuit**: `picking.js` `chargeTick()` rAF loop computes bearing JS-side and
  calls `sessionHandle.setMovementInput(1, 0, turn, true)` every frame
  (picking.js:291-378, axis injection :374); stop-at-range fires
  `setMovementInput(0, 0, 0, false)` then `charge.fireAttack()` (picking.js:326-341);
  abort path `cancelCharge()` also sends `(0,0,0,false)` (picking.js:278-289). Started
  by `startCharge(guid, range, fireAttack, motionForWindup, cylinderReach)`
  (picking.js:437-463). Range metric: cylinder under `?melee3dRange=on` (F6-5,
  picking.js:323-325, 449), flat horizontal otherwise. Wall-clock safety net
  `MAX_CHARGE_DURATION_MS = 10_000` (picking.js:98, check :295).
- **Turn-to-face**: `turnToFaceThenAct(targetGuid, act, enabled)` — rAF bang-bang
  turn-in-place via `setMovementInput(0, 0, ±1, false)` until |Δheading| ≤ 0.05 rad or
  `FACE_TURN_TIMEOUT_MS = 800` (picking.js:386-415, constants :29-37), then
  `(0,0,0,false)` + `act()`. Used by missile fire (picking.js:1011) and casting
  (picking.js:657), gated by `MISSILE_FACE_TARGET` (const true, :29) /
  `CAST_FACE_TARGET` (URL-flag IIFE, :37).
- **wasm side**: `setMovementInput` export (`lib.rs:26248-26267`) →
  `SessionCommand::SetMovementInput` (lib.rs:17297) → recv arm (lib.rs:39053-39096) →
  `motion_state_for_input` (lib.rs:29096) →
  `MovementSystemHandle::enqueue_drive_intent(PlayerDriveIntent::ManualHeld(state))`
  (lib.rs:39082-39086; handle at
  `crates/holtburger-core/src/client/movement/handle.rs:36`).
- **Core arbitration today**: one `active_drive` slot. `enqueue_drive_intent` maps
  intents to `QueuedDriveCommand` (system.rs:983-998); `ingest_drive_command`
  (system.rs:1011-1037) — `ManualSet` and `Autonomous` each OVERWRITE `active_drive`;
  `expire_active_drive` (system.rs:1040) clears any `Autonomous` active drive at the
  START of every tick (autonomous intents are one-tick, re-supplied by the caller —
  test `simulation_build_request_carries_active_autonomous_drive`,
  `movement/system/tests.rs` ~:1441). Realization: tick dispatch at system.rs:1232-1252
  (`execute_motion_state_at` :3266 / `execute_autonomous_drive_intent` :3408 /
  `execute_stop_at` :3283); wire emission for autonomous drives via
  `autonomous_wire_motion_state` (system.rs:1062-1117) which emits plain
  forward/turning `MotionState` — **byte-identical MoveToState shape to manual input**
  (DESIGN.md:596-601 wire invariant).
- The existing `PlayerDriveIntent::Autonomous` consumer is the native cli only
  (`crates/holtburger-core/src/client/mod.rs:1036`); **no wasm/JS caller** constructs
  `Autonomous`/`ArriveAtPose`/`SnapFacing` today (grep: zero hits in
  `apps/holtburger-web/src/lib.rs`).

### 2.2 The bug A14-I2 fixes (the "charge-end stomp")

Both charge-end paths send `setMovementInput(0,0,0,false)` (picking.js:282, :328, :396,
:406) → `ManualHeld(idle)` overwrites `active_drive`. If the player is HOLDING W at
that moment, the real held intent is zeroed and never re-sent — both legacy
dispatchers AND the A14-I1 funnel are edge-triggered/sig-deduped
(index.html rAF on-change block, survey A14 §2; input.js single shared signature,
url-flags.md:135), so nothing re-issues forward until a key edge. Retail cannot
exhibit this because manual movement and MoveTo are separate channels arbitrated by
the manager (`MovementManager::CancelMoveTo` on raw input, acclient.c:339240 +
344259-region `cancel_moveto` param; per-frame `CommandInterpreter::UseTime` re-take,
acclient.c:717595-717615). LAPTOP-REGREP.md:19 pins the distinction: this stomp is a
DIFFERENT bug from F6-6, in the same picking.js region.

### 2.3 F6-6 — exact behavior to preserve

F6-6 (`40a90aa0`): `fireOnce` must read the attack lockout **live at execution time**,
not at click time, because for a charge-pursuit `fireOnce` runs seconds later on
arrival (picking.js:794-819: `liveCb?.attackInProgress` check :814, set :819;
combat-bar swap note plugins/combat-bar.js:105). Concretely:

1. `charge.fireAttack` is a closure wrapping `fireOnce` (e.g. picking.js:963, :1070);
   it is invoked **on arrival** from `chargeTick` (picking.js:337).
2. The lockout read happens INSIDE `fireOnce` when invoked — any A14-I2 design where
   arrival still calls the same `charge.fireAttack()` closure preserves F6-6 verbatim.
3. Therefore: **A14-I2 must not move, wrap, debounce, or pre-evaluate
   `charge.fireAttack` / `fireOnce`**. The pursuit re-home changes WHO steers the
   avatar and WHO decides "arrived", never the fire path. The flag-on arrival handler
   calls `_releaseLocalWindupHold()` then `charge.fireAttack()` in the same order as
   today (picking.js:329-341).

Adjacent shipped fixes that must also not regress (same region):
- **F6-5** cylinder stop metric for melee charges under `?melee3dRange`
  (picking.js:323-325, 445-449, metric fns :153-162) — the wasm pursuit must stop on
  an equivalent cylinder (radius+height) metric; retail's `MoveToObject` natively
  takes `object_radius`/`object_height` (acclient.c:7145), so this maps cleanly.
- **F6-4** movement-driven CancelAttack throttle (picking.js:248-250) — untouched;
  it lives on the manual-input path, not the pursuit path.
- Windup hold (Wave-4): `setSwingMotion(..., {holdAtPeak:true})` at charge start
  (picking.js:451-457) and `_releaseLocalWindupHold` on cancel/arrival
  (picking.js:268-276, 287, 336) — keep both calls in the flag-on path.

### 2.4 Entry-point-only boundary (what A3 owns)

DESIGN.md Stage 3 (A3-D1-amended, DESIGN.md:520-588) owns **all MoveTo math** in a NEW
`crates/holtburger-core/src/client/movement/move_to.rs` MoveToManager:
MoveToObject/MoveToPosition execution, wire `my_run_rate`, "turn omega rate-limited to
retail turn rate × MoveToParameters.speed (the F3-3 noted refinement, replacing the
fixed heading-ease K in KIND_TURN, lib.rs:18044)" (DESIGN.md:525-529), the
MovementManager facade fan-out (UseTime → MoveToManager only, DESIGN.md:571-577), and
the per-unpack `cancel_moveto` preamble (DESIGN.md:555-556 / acclient.c:339516-339518).
ROADMAP puts A3-D3 and A14-I2 in the SAME wave W4 (ROADMAP.md:128) and the survey pins
the boundary: "A14-I2 targets A3's MoveToManager entry shape (don't duplicate its
math, A14 §4 I2)" (ROADMAP.md:116-117).

**A14-I2 = the `MoveToManager::PerformMovement` analog + the JS/wasm plumbing to reach
it.** It contributes: intent enum variants, SessionCommand variants, exports, recv
arms, ingest routing, manual-restore arbitration, status surface, and the picking.js
consumer. It must NOT contain: bearing/steering math, arrival-radius math, turn-omega
math, node walking, run-rate handling — those are `move_to.rs` (A3-D3) internals.

**Hard dependency**: A3-D3's `move_to.rs` must exist first (serialize inside W4;
system.rs conflict row ROADMAP.md:139 already orders "A14-I2/I3" behind A3 items). If
`crates/holtburger-core/src/client/movement/move_to.rs` is absent at implementation
time, A14-I2 is **blocked — stop and report**, do not write a stand-in steering loop
(that would re-create the math this item exists to evict). The minimal interface
A14-I2 requires from A3-D3 (negotiate in A3-D3's spec, listed here as the consumer
contract):

```rust
// move_to.rs — consumer contract A14-I2 needs (names indicative):
fn move_to_object(&mut self, object_id: Guid, object_radius: f32,
                  object_height: f32, params: &MovementParameters);  // acclient.c:7145
fn turn_to_object(&mut self, object_id: Guid, params: &MovementParameters); // :7146
fn turn_to_heading(&mut self, params: &MovementParameters);                 // :7158
fn cancel_move_to(&mut self, err: u32);                                     // :7147
fn is_active(&self) -> bool;
fn take_completion(&mut self) -> Option<u32>;  // CleanUpAndCallWeenie status analog,
                                               // 0 = arrived/ok (acclient.c:345171)
// pumped per tick (retail UseTime → MoveToManager only, DESIGN.md:573):
fn use_time(&mut self, /* world view A3 defines */);
```

---

## 3. Staged implementation plan

Flag: **`?wasmPursuit=on`** (default-off; name from survey A14 §4 Stage I2). One URL
flag is sufficient — the Rust additions are unreachable unless JS sends the new
SessionCommands, and JS only sends them under the flag. No Rust const gate needed
(matches the A9-Stage1 `?placementId=on` pattern, commit `20a027d6`); the
manual-restore arbitration change (Stage A.3) is inert-by-construction when no pursuit
intent ever arrives.

### Stage A — Rust core (crates/holtburger-core) · wasm-rebuild · Batch with W4 R-items

**A.1 — intent enum extension** (`movement_types.rs`, after line 198):

```rust
pub enum PlayerDriveIntent {
    // ... existing 6 variants unchanged (movement_types.rs:184-198) ...
    /// Retail MovementTypes::MoveToObject = 0x6 (acclient.h:2856-2866) via the
    /// PerformMovement entry (acclient.c:346123-346145). Entry-point only —
    /// steering/arrival math lives in move_to.rs (A3-D3).
    PursueObject { object_id: Guid, object_radius: f32, object_height: f32, run: bool },
    /// Retail MovementTypes::TurnToObject = 0x8 (acclient.c:346137-346139).
    TurnToObject { object_id: Guid },
    /// Retail TurnToHeading = 0x9 (acclient.c:346141-346143).
    TurnToHeading { heading: f32 },
    /// Retail MovementManager::CancelMoveTo (acclient.c:339240-339246).
    CancelPursuit,
}
```

Notes: `object_height` carries the F6-5 cylinder semantics (picking.js:153-162) into
retail's native radius/height parameters (acclient.c:7145). `run` maps to
`MovementParameters` gait the same way `AutonomousDriveIntent.gait` does
(movement_types.rs:48-54). Do NOT reuse `SnapFacing` for TurnTo — `SnapFacing` is an
instantaneous heading set (`execute_snap_facing`, system.rs:3354), not a rate-limited
turn; the rate-limited turn is exactly the math A3 owns.

**A.2 — ingest routing** (`movement/system.rs`):

- Extend `QueuedDriveCommand` (system.rs:853-868) with mirror variants
  `Pursue{..}/TurnToObject{..}/TurnToHeading{..}/CancelPursuit`; map them in
  `enqueue_drive_intent` (system.rs:983-998).
- In `ingest_drive_command` (system.rs:1011-1037), the new arms call the A3 contract
  (§2.4): pursue → `cancel_move_to(0x36)` + `unstick` preamble then `move_to_object`
  — i.e. exactly retail `PerformMovement`'s shape (acclient.c:346128-346131 preamble,
  :346133-346144 switch); CancelPursuit → `cancel_move_to(0x36)`.
- The `QueuedDriveCommand::Stop` arm (system.rs:1032-1036) additionally cancels any
  active pursuit (retail: StopCompletely path runs through `cancel_moveto`,
  acclient.c:343611) — keeps existing JS `Stop` semantics safe.

**A.3 — arbitration: manual-vs-pursuit + the stomp fix** (`movement/system.rs`):

- New field `last_manual_drive: Option<MotionState>` on `MovementSystem`
  (struct ~system.rs:800-850, init in `new()` :924-947). EVERY ingested
  `ManualSet(state)` records `last_manual_drive = Some(state)` (one line in the
  :1013 arm) — this is pure bookkeeping, zero behavior change when flag off.
- While the MoveToManager `is_active()`:
  - a NON-idle `ManualSet` (`!state.is_locomotion_idle() || state.turning.is_some()`,
    `is_locomotion_idle` movement_types.rs:104-106) **cancels the pursuit**
    (`cancel_move_to(0x36)`) and takes over — retail parity: raw player movement
    cancels MoveTo (acclient.c:344259-region `apply_raw_movement(cancel_moveto=1)` →
    :317421-317427 → :339240-339246). This gives manual pursuit-abort for free.
  - an IDLE `ManualSet` (all keys released) is recorded but does NOT stomp the pursuit
    drive (retail: releasing keys does not abort a MoveTo — MoveTo runs until
    CleanUpAndCallWeenie, acclient.c:345171; UseTime keeps it pumped,
    DESIGN.md:573).
- In `tick` (system.rs:1119+), after the A4-Q1 pump (:1171-1179): pump
  `move_to.use_time()` (retail UseTime → MoveToManager only, DESIGN.md:573 /
  MovementManager facade acclient.c:339175-339250). On `take_completion()` returning
  `Some(status)`: stash it for the bridge status getter (A.4) AND **restore
  `last_manual_drive`**: if it is non-idle, set
  `active_drive = Some(ActiveDriveState::manual(state, None))`; else fall through to
  the existing stop edge (`execute_stop_at`, system.rs:3283 — ACE must still see the
  stop, DESIGN.md:602-606 heartbeat/wire invariants). **This is the stomp fix.**
- While pursuit is active, the per-tick drive realization consumes the
  MoveToManager's steering output. HOW is A3's call (its `use_time` may itself emit
  an `AutonomousDriveIntent`-shaped drive into the existing
  `execute_autonomous_drive_intent` / `autonomous_wire_motion_state` lane,
  system.rs:3408 / :1062-1117 — that lane already emits the same wire `MotionState`
  bytes as manual input, DESIGN.md:596-601, so the wire shape is unchanged vs
  today's fake-WASD). A14-I2 only requires: pursuit-active ⇒ manual `active_drive`
  does not double-drive (mirror of the Track-B1 suppress-while-steering pattern,
  system.rs:1280-1294).

**A.4 — status surface** (`movement/system.rs` + `movement/handle.rs`):

- `pub(crate) fn pursuit_status(&self) -> u32` — `0` idle, `1` active, `2` arrived
  (completion status 0), `3` failed (non-zero status; low 16 bits carry the WERROR,
  e.g. 0x36/0x38 per acclient.c:345190-region, :346109-346115). "arrived"/"failed"
  latch until read-once or until the next pursuit starts (read-clear, so JS polling
  can't miss a one-tick completion — retail uses a callback,
  `CleanUpAndCallWeenie` acclient.c:345171; we poll because the wasm bridge is
  poll-shaped, cf. existing pose getters lib.rs:12706-12714 region). Expose through
  `MovementSystemHandle` (handle.rs — add alongside `enqueue_drive_intent` :36).

**A.5 — unit tests** (`movement/system/tests.rs`, pattern of
`clearing_server_controlled_projection_reasserts_autonomous_motion_intent`
tests.rs:~1448 and `simulation_build_request_carries_active_autonomous_drive`
tests.rs:~1441):

1. held-W survives pursuit end: ManualSet(forward) → PursueObject → completion →
   active_drive is Manual(forward) again (THE stomp regression test).
2. all-keys-idle at pursuit end → stop edge emitted exactly once
   (`execute_stop_at` consumed; no forward leak).
3. non-idle ManualSet during pursuit cancels it (status reads 3/failed-0x36) and
   manual takes over same tick.
4. `Stop` command cancels pursuit.
5. status lifecycle 0→1→2 and read-clear.
6. pursuit-active ⇒ no double-drive (manual drive not realized while pursuing —
   B1-pattern assertion via `current_local_drive_control`, system.rs:1268).

### Stage B — wasm bridge (`apps/holtburger-web/src/lib.rs`) · same rebuild batch

- 4 new `SessionCommand` variants `PursueObject{..}/TurnToObject{..}/TurnToHeading{..}/CancelPursuit`
  next to `SetMovementInput` (lib.rs:17297), recv arms next to the SetMovementInput
  arm (lib.rs:39053-39096) with the same WorldState-ready / player-seeded guards
  (lib.rs:39066-39078) → `movement.enqueue_drive_intent(...)`.
- 4 new exports on the session handle, modeled on `set_movement_input`
  (lib.rs:26248-26267): `pursueEntity(guid: u32, radiusM: f32, heightM: f32, run: bool)`,
  `turnToEntity(guid: u32)`, `turnToHeading(headingRad: f32)`, `cancelPursuit()`;
  plus 1 getter `pursuitStatus() -> u32` reading A.4 (route via the existing
  state-getter pattern, cf. `getLocalPlayerPose` consumer picking.js:185-198).
- **Manifest**: these are load-bearing exports for the flag-on path → bump
  `WASM_EXPORT_MANIFEST_VERSION` **3 → 4** (lib.rs:478; F18-2 rule, comment
  index.html:1794-1801). `EXPECTED_WASM_MANIFEST_VERSION` in index.html **stays 1**:
  the JS consumer is default-off and `typeof`-guards every new export (Stage C), so a
  stale pkg degrades to legacy behavior instead of a banner; EXPECTED is only raised
  when a default-ON consumer depends on an export (matches the W2/grind convention —
  manifest v3, index.html stays 1).
- Serialize this lib.rs edit with any in-flight A13/A14-I4 bridge work
  (ROADMAP.md:138 — lib.rs is the hottest file).

**Rebuild**: Stages A+B are ONE wasm rebuild, batched with the other W4 Rust items
(A3-D3, A6-T0/T1/T2, A2-P2 — ROADMAP.md:128) on the buildbox (laptop: NO builds;
buildbox currently OFF — code lands inert, joins the pending-rebuild flag set with
projectileGravity/turnOmega/longJump etc.).

### Stage C — JS consumer (`scene3d/picking.js`) · JS-live AFTER the rebuild lands

Read the flag once at module top (IIFE pattern of `CAST_FACE_TARGET`/`MELEE_3D_RANGE`,
picking.js:37-67): `WASM_PURSUIT = /[?&]wasmPursuit=on/.test(location.search)`.
Effective-on requires the exports: `WASM_PURSUIT && typeof
sessionHandle.pursueEntity === "function"` (soft-degrade to legacy, F18-2 spirit).

- **startCharge** (picking.js:437-463): flag-on → keep ALL existing bookkeeping
  (charge object, windup `setSwingMotion` :451-457) but instead of entering the
  steering `chargeTick`, call
  `sessionHandle.pursueEntity(guid, range, charge.cylinderReach ? MELEE_VERTICAL_REACH_M : 0, true)`
  and enter a new **monitor loop** `pursuitMonitorTick` (rAF):
  - timeout: `performance.now() - charge.startMs > MAX_CHARGE_DURATION_MS` →
    `sessionHandle.cancelPursuit()` + existing cancel path (release windup,
    picking.js:295-298 semantics preserved);
  - stance abort: same `isInMeleeStance/isInRangedStance` check as today
    (picking.js:302-307) → `cancelPursuit()` + cancel path;
  - `pursuitStatus() === 2` (arrived) → `_releaseLocalWindupHold()` then
    `charge.fireAttack()` then `charge = null` — **identical order to
    picking.js:329-341; `fireAttack`/`fireOnce` untouched ⇒ F6-6 preserved**;
  - `pursuitStatus() === 3` (failed) → cancel path (no fire);
  - **no `setMovementInput` calls anywhere in the flag-on path** — the (0,0,0)
    stomp sites (picking.js:282, :328) are bypassed; held WASD is restored
    wasm-side (Stage A.3).
- **cancelCharge** (picking.js:278-289): flag-on → `cancelPursuit()` instead of
  `setMovementInput(0,0,0,false)`; windup release unchanged.
- **turnToFaceThenAct** (picking.js:386-415): flag-on → `sessionHandle.turnToEntity(guid)`
  + monitor loop: status 2/3 OR `FACE_TURN_TIMEOUT_MS` elapsed (on timeout also
  `cancelPursuit()`) → `act()`. Same fallback-to-immediate-`act()` when target/pose
  unresolvable (let the wasm side fail it: status 3 arrives next poll — retail
  CancelMoveTo(8) on missing object, acclient.c:346114).
- Arrival authority is the **wasm status**, not the JS distance check — the JS
  `dist <= charge.range` math (picking.js:323-326) is steering math and stays
  flag-off-only (deleting it is a later cleanup once the flag goes always-on per the
  passed-flag policy).
- `url-flags.md`: add the `wasmPursuit` row (format of the `inputFunnel` row,
  url-flags.md:135), cross-referencing F6-6/F6-5 no-regress and the A3-D3 dependency.
- Headless test `test_a14_i2_pursuit_monitor.mjs` (sibling of
  `test_a14_i1_input_controller.mjs`, cited url-flags.md:135): extract the monitor
  state machine into a pure helper (no THREE/DOM, input.js precedent input.js:44-46)
  and unit-test: arrived→fire-once ordering (windup release before fire), timeout→
  cancel-no-fire, failed→cancel-no-fire, stance-abort→cancel, fire called EXACTLY
  once per charge.

Interaction with A14-I1: the funnel (input.js) is NOT in this path — pursuit
deliberately bypasses the input API in both directions; that is the whole point
(survey A14 §4 I2 "move synthetic movers off the input API", input.js:17-18 scope
note). No input.js edits.

### Stage ordering / shipping shape

A3-D3 (move_to.rs) → Stage A → Stage B (one PR or two, same rebuild batch) →
[buildbox wasm rebuild + manifest 4] → Stage C (JS-live, reload-visible). Commits
hunk-selective per standing rule; default behavior byte-identical at every stage
(flag off ⇒ new code unreachable; A.3 bookkeeping inert without pursuit intents).

---

## 4. Test plan

**Headless-now (laptop/buildbox, no GPU):**
- Stage A unit tests 1-6 (§3 A.5) — `cargo test -p holtburger-core` ON THE BUILDBOX
  ONLY (laptop OOM rule; `capped-build` if it must run locally, never `--workspace`).
- Stage B: `cargo check --target wasm32-unknown-unknown` cleanliness (buildbox);
  manifest constant bump asserted by an existing-pattern grep in review.
- Stage C: `node test_a14_i2_pursuit_monitor.mjs`; `node --check` on picking.js;
  grep-assert ZERO `setMovementInput(` calls reachable in the flag-on pursuit path.
- Wire-agent (laptop, no GPU, after rebuild lands): Playwright chromium →
  `127.0.0.1:8765` with `?nullRender=1` (mandatory) + `?wasmPursuit=on`; spawn at
  Academy/Holtburg, drive `__fireAttackOnTarget` at a spawned creature, read
  `getLocalPlayerPose` + `pursuitStatus` inside `page.evaluate` per tick; assert
  pose converges to target range and status hits 2; assert held-W restore by calling
  `setMovementInput(1,0,0,true)` mid-pursuit-end and reading pose advance.

**1070-gated (goes on the BATCHED pending eye-test list, not a per-item step):**
- pursuit feel (turn omega vs today's bang-bang ±1 — A3-owned math, shared eye-test),
- charge → arrival → swing fires after a multi-second chase with a prior swing
  finishing at click time (the F6-6 scenario, must still fire),
- W held through charge-end keeps running with no hitch (the stomp),
- turn-to-face before missile/cast under `?wasmPursuit=on` + `CAST_FACE_TARGET`.
Run hidden/off-screen per the 1070 rule.

---

## 5. Risks + rollback

- **Rollback**: flag off ⇒ legacy chargeTick/turnToFaceThenAct run byte-identical
  (they are not modified, only branched around). Rust side inert without intents.
  Wasm rebuild rollback = previous pkg/ (manifest check tolerates: EXPECTED stays 1).
- **A3-D3 slip**: if W4 lands without move_to.rs, A14-I2 is blocked (§2.4). Do NOT
  ship a JS-side "wasm-ish" interim — the half-state (intents land in core but steer
  nothing) would strand the flag.
- **Double-drive**: manual `active_drive` realized while pursuit also steers ⇒ avatar
  dragged off course (the documented Track-B1 failure shape, system.rs:1280-1294).
  Covered by unit test 6.
- **Missed stop edge**: pursuit ends with idle hands but no `execute_stop_at` ⇒ ACE
  keeps the player moving (server-side run-on; cf. DESIGN.md:596-606 senders). Unit
  test 2.
- **Status race**: completion latched-then-cleared wrongly ⇒ JS monitor spins until
  MAX_CHARGE_DURATION_MS and cancels — degraded (dead click after chase, exactly the
  F6-6 symptom shape) but bounded; read-clear semantics + unit test 5 guard it.
- **Stale pkg with flag on**: typeof-guards degrade to legacy path silently; the
  manifest bump (3→4) keeps the F18-2 console surface honest if EXPECTED is ever
  raised.
- **Server-controlled projection collision**: a server teleport/forced-move arriving
  mid-pursuit (`server_controlled_projection`, system.rs:944-960) — pursuit must
  yield; A.2's Stop/cancel arms + the existing suppress-once flag (system.rs:1181-1196)
  cover the entry; flag it in review as an explicit test-or-open item (see §6.4).

---

## 6. OPEN QUESTIONS

1. **Retail ownership of the melee chase**: which retail client system calls
   `MoveToManager::MoveToObject` for the local player's attack pursuit
   (ClientCombatSystem? sticky?) is single-cited — callers found at
   acclient.c:339574/346130 are the MovementManager/PerformMovement dispatch layers,
   and I did not trace the combat-side originator. Our charge state machine
   (JS-owned fire decision) is therefore a modernization whose retail-fidelity
   ceiling is unverified. Does not block: the entry shape (PerformMovement) is
   dual-citable and is all A14-I2 re-homes.
2. **`MovementParameters` fidelity**: which retail param bits (bitfield at
   acclient.c:344161, distance_to_object, fail_distance, speed) A3-D3 surfaces in
   its `MovementParameters` analog is A3's call; A14-I2 only forwards
   radius/height/run. If A3-D3 exposes fewer/more, the intent variant fields adjust
   at integration time (single negotiation point: §2.4 contract).
3. **TurnTo completion threshold**: legacy JS uses |Δ| ≤ 0.05 rad
   (picking.js:404); retail `TurnToHeading`/`HandleTurnToHeading`
   (acclient.c:345780-region, 346038) owns its own epsilon — ours-vs-retail epsilon
   parity is unmeasured. A3-owned; flag here so the eye-test list includes
   "cast/missile fires while visibly off-bearing".
4. **Pursuit vs server-controlled projection arbitration**: retail fans
   HandleUpdateTarget → MoveToManager only (DESIGN.md:573); our
   `server_controlled_projection` lane predates MoveToManager. Whether an incoming
   projection should hard-cancel a pursuit (proposed: yes, with status 3) is
   single-sourced on our side — no retail citation for the exact precedence found.
   Decide in A3-D3 review; A14-I2 unit-test whatever is ruled.
5. **`pursuitStatus` poll vs event**: retail is callback-shaped
   (`CleanUpAndCallWeenie`, acclient.c:345171); a poll getter is our-side-only
   convenience consistent with existing bridge getters but uncited as a pattern
   equivalence. If A13's send-surface work later adds a JS event channel, migrate.
6. **Missile pursuit gait**: chargeTick always runs (`run=true`, picking.js:374)
   including missile charges; retail MoveToObject gait comes from params — whether
   retail ranged repositioning walks or runs is unchecked. Forwarding `run=true`
   preserves today's behavior; revisit under A3.
