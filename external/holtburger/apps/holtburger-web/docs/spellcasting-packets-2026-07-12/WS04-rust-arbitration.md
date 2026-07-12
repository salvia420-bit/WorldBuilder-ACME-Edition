# WS04 — Rust movement arbitration during casts (Symptom S3a)

**Charter:** the `castMove`/`slideCast`/`cmdInterp` system lets held keys revive
after each windup node drains (the `use_time` reclaim), so multi-windup war/void
casts leak held-W movement *between* windups without a fresh key edge. Deliverables:
(1) verify the magic-gesture band nodes complete on REAL authored anim lengths
(`authored_len_for` coverage audit + fix gaps); (2) design + implement a flag-gated
`?castHoldReclaim` that keeps the FORWARD slot dead across the WHOLE cast chain
(not per-node), strafe/turn/jump keeping retail semantics (slidecast untouched;
jump resets the lock per LeaveGround).

**Investigation environment:** GCE buildbox. No live ACE / no browser reachable, so
wire behavior is derived from the ACE reference source + acclient decomp + the DAT
oracle; live captures are queued as TODO-FOR-LAPTOP. All cites re-opened
2026-07-12; every line number below was verified against the live file this session.

**Baseline:** `external/holtburger` (crates at repo root `crates/`, web bundle at
`apps/holtburger-web/`). Default flag set relevant here: `cmdInterp=on`,
`castMove=on`, `slideCast=off`, `unifiedTransition=on`, `mtQueue` inert.

---

## 1. VERIFIED FINDINGS

Legend: **[C]** confirmed by code/DAT/decomp read; **[H]** hypothesis (grounded but
not runtime-proven on this box — needs the laptop capture).

### 1.1 The completion-clock shim & `authored_len_for` (deliverable 1)

**[C] The shim exists and is the completion clock for 1-anim gesture nodes.**
`motion_table_manager.rs:58-80` (module doc): *"retail's 1-anim nodes complete ONLY
via the renderer … Our renderer cannot report per-entity completion yet … so a 1-anim
node would pend FOREVER … Until the per-entity renderer route lands, the AUTHORED
ANIM LENGTH is the completion clock: each 1-anim node carries `RENDERER_DONE_FALLBACK_SECS`
… completes it at expiry exactly as a renderer `AnimationDone(success=1)` would."*
`RENDERER_DONE_FALLBACK_SECS = 2.0` (`:155`).

**[C] `authored_len_for` is called at the single enqueue chokepoint**, keyed on the
interpreted style + motion + live speed:
`motion_interp.rs:1212-1222` —
```
let num_anims = renderer_num_anims(motion);
let authored = if num_anims > 0 {
    super::motion_table_manager::authored_len_for(
        self.interpreted_state.current_style, motion, params.speed) } else { None };
motion_table_manager.queue_object_motion_with_len(motion, num_anims, authored);
```
`authored_len_for` (`motion_table_manager.rs:198-207`) looks up
`AUTHORED_MOTION_LENGTHS[(stance & 0xFFFF, motion)]`, divides base secs by `|speed|`
(retail framerate scaling, `AnimSequenceNode::multiply_framerate` acclient.c:340968-340979),
clamps `[0.05, 30.0]`. A miss → `None` → the flat 2.0 s fallback (`AnimNode::new_with_len`
`:134-142`).

**[C] The ingest walks EVERY from-Ready link group, ALL stances, summing every
`AnimData` segment.** `resolve_authored_motion_lengths`
(`apps/holtburger-web/src/lib.rs:7593-7654`): gate `(mtable_id >> 24) != 0x09` →
player MTs only; iterate `mtable.links`, keep `outer_key & 0xFFFF ==
(MOTION_LINK_FROM_READY & 0xFFFF)` = `0x0003` (from-Ready), `stance = outer_key >> 16`;
explicit range `(high-low+1)/|fr|`, freeze-hold `1/30`, `high == -1` play-to-end →
resolve the Animation frame count from the source cache and **`continue 'cmds'` (skip
the command entirely) on a cache miss** (`:7641`). Wired at spawn via
`SessionCommand::IngestMotionLengths` (`lib.rs:46529-46557` → `set_authored_motion_lengths`).

**[C] The Magic-stance from-Ready link group in the player MT `0x09000001` covers
EVERY magic gesture band — DAT-verified via the oracle.** Outer key
`(0x49 << 16) | 0x03 = 0x00490003`; 54 to-commands present. All the charter's bands:
- MagicPowerUp01-10 windups `0x1000006F..0x10000078` — **all 10 present**;
- colored band `0x1000012B..0x10000134` — **all 10 present** (incl. `0x10000132`
  MagicPowerUp08Purple, the JSON's void-windup example);
- cast substates `0x4000002B..0x40000039` (MagicBlast 0x2B, cast 0x35, aim band) —
  **all 15 present**;
- talisman/secondary windups `0x1000010E..0x10000111`, `0x1000019B` also present.

  Runnable proof: `test_ws04_magic_gesture_lengths.mjs` (§4.1) — PASS on this box.

**[C] The core war/void cast gestures resolve REAL, self-contained authored lengths
(zero extra DAT reads).** Computed from the DAT (base secs @1x → ms @CastSpeed 2.0):
| motion | base | @2.0 | segs |
|---|---|---|---|
| `0x1000006F` MagicPowerUp01 | 0.675 s | 337 ms | `[0-8]/24 + [0-8]/-30` |
| `0x10000078` MagicPowerUp10 | 4.500 s | **2250 ms** | `[0-75]/24 + [0-75]/-57` |
| `0x10000132` Purple08 | 3.738 s | 1868 ms | `[0-60]/24 + [0-60]/-51` |
| `0x4000002B` MagicBlast | 0.708 s | 354 ms | `[0-16]/24` |
| `0x40000035` cast | 1.000 s | 500 ms | `[0-23]/24` |

All 35 core-band members (10 windups + 10 colored + 15 cast substates) are
self-contained (`high >= 0`), so the shim resolves them with no Animation-asset
dependency. **Load-bearing check:** MagicPowerUp10 / colored-top at CastSpeed 2.0 =
**2250 ms > the 2.0 s flat fallback** — so the authored ingest is NOT cosmetic; without
it the highest windups drain ~250 ms early.

**[C] `current_style` IS the Magic stance when the gestures enqueue → the lookup key
hits.** The wire stomp stamps `state.current_style = 0x8000_0000 | style16`
(`motion_interp.rs:1671-1674`); windups (action class) ride the action list and cast
substates ride the forward slot (`:1676-1694`), both flowing through
`do_interpreted_motion` → `authored_len_for(current_style=0x8000_0049 → &0xFFFF=0x49, …)`.
The ingest keys `(0x0049, motion)` (stance `= outer_key>>16 = 0x49`), and
`authored_len_for` masks `stance & 0xFFFF`. **Keys match — no stance-key gap.**

**[H — the only real coverage gap] Secondary/rare bands with `high == -1`
(play-to-end) fall to the 2.0 s fallback if their Animation asset (`0x03xxxxxx`) is
not resident in the source cache at ingest time.** 41 segments across ~15 commands are
Animation-asset-dependent: `0x1000010E-0x111`, `0x1000019B`,
`0x40000011/15/18/1A-1C`, `0x400000D3`, `0x40000136-139`, `0x44000007` (several are
NOT cast gestures — `0x40000018` = Crouch, `0x40000011/15` = poses). **None of the
core war/void bands are in this set.** Whether the spawn bake prefetches these anims
into the cache is unverified on this box (see §2.4 + the laptop recipe §4.3).

### 1.2 The movement-arbitration mechanism (deliverable 2 target)

**[C] The autonomy latch is the drive selector.** `interpreted_movement_active() =
cast_move_enabled() && !last_move_was_autonomous` (`system.rs:1911-1913`). The default
drive dispatch is `advance_manual_slice_via_transition` (reached because
`USE_UNIFIED_TRANSITION = true`, `system.rs:595`, via
`advance_local_pose_for_manual_drive_slice:3869-3872`); at `:5689-5699`:
```
let state = if self.interpreted_movement_active() {
    Self::interpreted_drive_state( … minterp.interpreted_state …, state)
} else { state };
```
Latch LOW → the interpreted (server-echo) state drives, forward dead
(`interpreted_drive_state:2244-2256`: a stored `Substate(_)` or `None` forward command
→ `forward = None`). Latch HIGH → raw `active_drive` (held-W moves).

**[C] The latch is LOWERED per cast stomp, and cast gestures NEVER transfer scene
control (the FU-A-dormant finding).** `player.rs:167-196` (`GameMessage::UpdateMotion`,
local player): `accepted && !data.is_autonomous` →
```
if !matches!(data.data, …MovementTypeData::Invalid(_)) {
    state.scene.set_local_server_controlled(true);
}
```
verbatim comment `:176-177`: *"General (`Invalid`) envelopes — gestures/poses — only
lower the autonomy latch, never the control flag."* The `SelfServerControlledMotion`
event → `note_server_authored_motion(data.is_autonomous)` (`system.rs:1902-1903`)
lowers the latch. So a General cast gesture lowers the latch but leaves
`world.scene.local_server_controlled()` FALSE.

**[C] The FU-A `use_time` reclaim is gated on BOTH `!player_motions_pending` AND
`controlled_by_server`.** `command_interpreter.rs:822-838`:
```
if self.player_present && self.enabled && self.controlled_by_server
   && !seams.player_motions_pending() && !seams.player_is_moving_to()
   && (substate_head || turn_head || sidestep_head || auto_run) {
    self.take_control_from_server(seams, true);
}
```
`interp.controlled_by_server = honor_autonomy_latch && world.scene.local_server_controlled()`
(mirrored each pump/edge, `system.rs:2131-2132`, `:1989`). The reclaim's tail
`take_control_from_server → apply_current_movement` (`:919-937`, `:1052-1078`)
re-drives the forward substate head via `move_player(RUN_FORWARD, start=1)` →
seam `do_motion` → `apply_axis` sets `drive.forward = Forward` (`system.rs:7194-7196,
7232-7238`) → **held-W revives** and raises the latch (`:7235`).

**[C] `player_motions_pending` is the completion-shim gate.** `system.rs:7288-7318`:
reads `manager.moveto_motions_pending()` off the local registry minterp, *"whose queue
the retail `move_to_interpreted_state` body now FILLS on every wire stomp
(gesture substates/windup actions → 1-anim nodes) and the completion-clock shim /
renderer notify DRAINS."* So each windup node holds the gate for its authored length,
then drops it — reopening the reclaim.

**[C] The leak is pinned by an existing test.** `system/tests.rs:7130-7214`
(`cmd_interp_use_time_reclaims_after_gesture_node_drains`): sets
`local_server_controlled(true)` + applies a cast gesture event; after the node drains,
asserts `drive.forward == Some(ForwardLocomotion::Forward)` — *"the held W revived out
of the reclaim's ApplyCurrentMovement"*, WITHOUT a fresh edge. This is the symptom,
already a regression pin.

**[C] Jump resets the lock (LeaveGround).** `acclient.c:344457-344489`
(`CMotionInterp::LeaveGround`): `get_leave_ground_velocity` (held-key state velocity) →
`set_local_velocity` → `standing_longjump = 0` → `RemoveLinkAnimations` (drops the
pending gesture) → `apply_current_movement(v1, 0, 0)` (`:344484`, re-applies held keys).
So a jump during a windup drops the gesture and revives held movement — the retail
"jump out of the cast" escape (`motion_allows_jump` permits jumping out of the windup
bands, foundation §2.2).

### 1.3 What makes it fire for war/void specifically

**[C→H] Targeted casts DO transfer scene control (via the turn-to-target), so FU-A is
NOT dormant for them.** ACE `Player_Magic.cs`:
- `:159-190` non-FastTick (NPK/vanilla): `var rotateTime = Rotate(rotateTarget);`
  before the windups;
- `:189, :215, :803-829` `TurnTo_Magic(target)` →
  `CreateTurnToChain2(target, …, MagicState.AlwaysTurn)`; `:1269` `MagicState.AlwaysTurn = true`.

`Rotate`/`TurnTo` are **non-`Invalid` movement directives**, so when the caster
receives its own turn echo (`GameMessage::UpdateMotion`, non-autonomous, non-Invalid)
→ `set_local_server_controlled(true)` (`player.rs:178-182`) → `controlled_by_server`
true → the `use_time` reclaim is LIVE. **[C]** the JS entry is
`turnToFaceThenAct(guid, doCast, CAST_FACE_TARGET)` (foundation §1.1, `castFaceTarget`
default-ON), and the dev-community lore confirms the server-driven caster turn
(foundation §4b). **[H]** the exact wire timing (turn echo arriving before/among the
windup stomps for a live NPK war cast) is the piece needing a laptop capture (§4.3).

Contrast: **self/untargeted buffs** send no turn directive → scene control stays
false → FU-A dormant → held-W stays dead the whole cast (tap-to-revive only). This
asymmetry is exactly why the charter names **war/void** (always targeted) as the
leakers while self-buffs are quiet.

---

## 2. ROOT CAUSES

**S3a — "run as far as you want while casting" for multi-windup war/void:**

1. **Per-node forward reclaim (the leak).** For a TARGETED cast, the server's
   turn-to-target sets `local_server_controlled` → FU-A live. Each windup node holds
   `player_motions_pending` for its authored length (§1.1) then drops it; the very next
   `use_time` pump reclaims control WITHOUT a fresh edge and re-drives the held forward
   substate head (`apply_current_movement:1060-1061`), so held-W revives in the gap
   before the next windup stomp re-lowers the latch. Multi-windup ⇒ multiple revive
   windows ⇒ net forward travel. **Proven mechanism** (code trace §1.2, pinned by
   `cmd_interp_use_time_reclaims_after_gesture_node_drains`). The *targeted-cast trigger*
   is grounded (§1.3) but wants a live capture to close **[H]**.

2. **The authored-length ingest makes the per-node window CORRECT, not longer.** With
   the real lengths, common windups drain at ~0.3-0.5 s (not the flat 2.0 s), so the
   reclaim windows open sooner — the leak is more visible with the (correct) shim than
   with the old flat fallback. The authored ingest is right; the *reclaim policy* is
   what S3a needs. (The one place the fallback is genuinely wrong is MagicPowerUp10 /
   colored-top at 2250 ms > 2.0 s — those need the authored value or they drain early.)

3. **Coverage is complete for the core bands; the residual gap is Animation-asset
   caching for rare secondary gestures** (§1.1 [H]) — degrades safely to 2.0 s, never
   a hang (the shim's whole point).

**Not a root cause (guardrail):** there is no client-side movement root to "fix in".
Retail's `Windup_MaxMove` fizzle circle is PK-only and server-side (foundation §1.4,
§2.4). The improvement must be a client *animation/drive* lock, flag-gated, not an
invented hard root.

---

## 3. PATCH PLAN

Design: a **flag-gated `?castHoldReclaim` (default OFF)** + a **client cast-window
signal** (`SessionHandle.noteLocalCastWindow(active)`) stamped by the JS cast chain.
While the window is active and the flag is on, the `use_time` FU-A reclaim
**suppresses the FORWARD axis re-apply only** (holds it at Ready/dead across the whole
chain); turn/sidestep still reclaim (slidecast untouched); a jump clears the lock
(`!is_airborne` gate → LeaveGround revival); a fresh forward EDGE is untouched
(fastcast preserved — the edge path never sets the suppress flag). Window ends on chain
completion / fizzle / cancel → held-W resumes.

**Why the JS-stamped signal over wasm-derived:** the movement system cannot tell "gap
between windups" from "chain ended" from wire stomps alone (that is exactly the
per-node ambiguity we are fixing). The JS chain (`playCastSequence`) knows the precise
start/end (windup list, cast gesture, UseDone/fizzle/cancel) — a robust, cheap signal.

**Why the interpreter `use_time` layer:** it is the exact confirmed leak path (§1.2),
it is unit-testable in isolation with the existing `Mock` seam (runnable on this box),
and it distinguishes edgeless-reclaim (suppress) from edge-dispatch (fastcast) by the
`via_use_time` call site.

### 3.1 `crates/holtburger-core/src/client/movement/system.rs`

Add the native const + doc (near `USE_SLIDE_CAST`/`USE_CAST_MOVE`, ~`:804`):
```rust
/// (2026-07-12, WS04 S3a) — `?castHoldReclaim`: while a KNOWN local cast
/// chain is in flight, the FU-A `use_time` reclaim keeps the FORWARD slot
/// dead across the WHOLE chain instead of reviving held-W per-windup-node.
/// Strafe/turn still reclaim (slidecast untouched); a jump clears the lock
/// (retail LeaveGround re-applies movement, acclient.c:344457/:344484); a
/// fresh FORWARD edge is untouched (fastcast anim-break preserved — the
/// edge path never arms the lock). Signal source: the JS chain stamps
/// `SessionHandle::noteLocalCastWindow(active)`. Default OFF — eye-test
/// gated (the leak is targeted-cast-only, FU-A-dormant for self buffs).
const USE_CAST_HOLD_RECLAIM: bool = false;
```

Add fields to `MovementSystem` (next to `cast_move_runtime` ~`:1449`):
```rust
    cast_hold_reclaim_runtime: Option<bool>,
    /// WS04 — set by the JS cast chain via `note_local_cast_window`; true
    /// from windup start to chain completion/fizzle/cancel.
    local_cast_window_active: bool,
```
`new()` init (`:1756`): `cast_hold_reclaim_runtime: None, local_cast_window_active: false,`.

Setters/predicate (mirror `set_cast_move`/`cast_move_enabled`, ~`:1840`):
```rust
    pub(crate) fn set_cast_hold_reclaim(&mut self, on: bool) {
        self.cast_hold_reclaim_runtime = Some(on);
    }
    pub(crate) fn cast_hold_reclaim_enabled(&self) -> bool {
        self.cast_hold_reclaim_runtime.unwrap_or(USE_CAST_HOLD_RECLAIM)
    }
    pub(crate) fn note_local_cast_window(&mut self, active: bool) {
        self.local_cast_window_active = active;
    }
```

Seam impl — add to `impl InterpreterSeams for SystemInterpreterSeams` (~`:7288`,
next to `player_motions_pending`):
```rust
    fn local_cast_forward_lock_active(&self) -> bool {
        // WS04 — the forward lock: flag on + a known cast chain in flight +
        // grounded. `!is_airborne` yields the jump reset (LeaveGround
        // re-applies held movement, acclient.c:344457): a jump mid-cast
        // clears the lock for the airborne window and the landing revives.
        self.system.cast_hold_reclaim_enabled()
            && self.system.local_cast_window_active
            && !self.world.player.is_airborne
    }
```
(`is_airborne` confirmed at `holtburger-world/src/player/types.rs:1374`.)

### 3.2 `crates/holtburger-core/src/client/movement/command_interpreter.rs`

Trait method (add to `InterpreterSeams`, ~`:324`):
```rust
    /// WS04 (`?castHoldReclaim`) — true while a known local cast chain is in
    /// flight AND grounded AND the flag is on; the `use_time` reclaim then
    /// holds the FORWARD axis dead across the whole chain. Default impl in
    /// the Mock returns a field; the system seam reads the cast window.
    fn local_cast_forward_lock_active(&self) -> bool;
```

Interpreter field — a transient scoped flag (add near `effects`, ~`:484`):
```rust
    /// WS04 — set true ONLY around the `use_time` FU-A reclaim while the
    /// cast forward lock is active; read by `apply_current_movement`'s
    /// forward axis to hold Ready instead of replaying the substate head.
    /// Never persists past the scoped reclaim (reset immediately after).
    pub(crate) forward_reclaim_locked: bool,
```
`new()` init: `forward_reclaim_locked: false,`.

`use_time` reclaim — scope the flag (`:826-837`):
```rust
        if self.player_present && self.enabled && self.controlled_by_server
            && !seams.player_motions_pending() && !seams.player_is_moving_to()
            && (self.substate_list.get_head().is_some()
                || self.turn_list.get_head().is_some()
                || self.sidestep_list.get_head().is_some()
                || self.auto_run)
        {
            // WS04 — hold the FORWARD axis dead across the whole chain; the
            // reclaim still returns control + revives turn/sidestep.
            self.forward_reclaim_locked = seams.local_cast_forward_lock_active();
            self.take_control_from_server(seams, true);
            self.forward_reclaim_locked = false;
        }
```

`apply_current_movement` forward axis (`:1056-1064`):
```rust
        // ── forward axis ──
        if self.forward_reclaim_locked {
            // WS04 castHoldReclaim: the cast chain owns the forward slot at
            // zero locomotion — keep it dead (Ready), do NOT replay the
            // held substate head. Turn/sidestep below re-apply normally.
            self.move_player(seams, MOTION_READY, 1, 1.0, 0, 0);
        } else if self.auto_run {
            let speed = self.autorun_speed;
            self.move_player(seams, MOTION_WALK_FORWARD, 1, speed, 1, 1);
        } else if self.substate_list.get_head().is_some() {
            self.apply_list_head_movement(seams, ListKind::Substate);
        } else if !self.transient_state {
            self.move_player(seams, MOTION_READY, 1, 1.0, 0, 0);
        }
```
(Emitting `MOTION_READY` for the forward axis maps in the seam to
`apply_axis(MOTION_READY, …) → drive.forward = None` — `system.rs:7200-7203` — i.e.
held-W stays dead while the substate head remains in the list for later revival.)

Mock impl (test seam, add field + method ~`:1861`/`:1931`):
```rust
        cast_forward_lock: bool,                     // struct field, default false
        // …
        fn local_cast_forward_lock_active(&self) -> bool { self.cast_forward_lock }
```

### 3.3 `crates/holtburger-core/src/client/movement/handle.rs`

Forwards (mirror `set_cast_move`, ~`:287`):
```rust
    pub fn set_cast_hold_reclaim(&mut self, on: bool) {
        self.inner.set_cast_hold_reclaim(on);
    }
    /// WS04 — JS cast chain stamps the local cast window (true at windup
    /// start, false at chain completion/fizzle/cancel).
    pub fn note_local_cast_window(&mut self, active: bool) {
        self.inner.note_local_cast_window(active);
    }
```

### 3.4 `apps/holtburger-web/src/lib.rs`

Flag parser (mirror `parse_cast_move_flag`, default-OFF `=on`-to-enable, ~`:240`):
```rust
/// (2026-07-12, WS04) parse `?castHoldReclaim=on`. DEFAULT-OFF: true ONLY
/// when `castHoldReclaim=on` (or bare `castHoldReclaim`) is present.
fn parse_cast_hold_reclaim_flag(search: &str) -> bool {
    let trimmed = search.strip_prefix('?').unwrap_or(search);
    trimmed.split('&').any(|kv| kv == "castHoldReclaim" || kv == "castHoldReclaim=on")
}
```
Boot config (next to `set_cast_move`, ~`:36921`):
```rust
    // (2026-07-12, WS04): `?castHoldReclaim=on` — hold the FORWARD slot dead
    // across a whole known cast chain (default OFF, eye-test gated).
    movement.set_cast_hold_reclaim(parse_cast_hold_reclaim_flag(&js_location_search()));
```
`SessionCommand` variant (next to `SetAutoRun`, ~`:21814`):
```rust
    /// WS04 — the JS cast chain's local cast-window signal.
    NoteLocalCastWindow { active: bool },
```
Export (mirror `setAutoRun`, ~`:32171`):
```rust
    /// WS04 (`?castHoldReclaim`) — mark the local cast chain in flight. JS
    /// stamps true at windup start and false at chain completion / fizzle /
    /// cancel. Typeof-guarded JS-side (stale pkg/ degrades silently).
    /// ADDITIVE export — no manifest bump.
    #[wasm_bindgen(js_name = noteLocalCastWindow)]
    pub fn note_local_cast_window(&self, active: bool) -> Result<(), JsValue> {
        use futures::channel::mpsc::TrySendError;
        self.cmd_tx
            .unbounded_send(SessionCommand::NoteLocalCastWindow { active })
            .map_err(|e: TrySendError<_>| {
                JsValue::from_str(&format!("note_local_cast_window: cmd channel closed ({e})"))
            })
    }
```
Recv arm (mirror `SetAutoRun`, ~`:46518`):
```rust
                    Some(SessionCommand::NoteLocalCastWindow { active }) => {
                        movement.note_local_cast_window(active);
                    }
```

### 3.5 `apps/holtburger-web/scene3d/entities.js` (JS — no wasm rebuild)

Stamp the window around the local cast chain. In `playCastSequence`, right after the
token bump (`:6777-6778`):
```js
    inst._castSequenceToken = token;
    // WS04 (?castHoldReclaim) — mark the LOCAL cast chain in flight so the
    // movement system holds the forward slot dead across the whole chain.
    const __ws04sh = (typeof window !== "undefined") ? window.__sessionHandle : null;
    const __ws04local = __ws04sh && typeof __ws04sh.localPlayerGuid === "function"
        && (g === (__ws04sh.localPlayerGuid() >>> 0));
    if (__ws04local && typeof __ws04sh.noteLocalCastWindow === "function") {
        try { __ws04sh.noteLocalCastWindow(true); } catch (_) {}
    }
```
Clear it when THIS chain ends (natural completion — wrap the gesture loop tail so a
preempting recast does not stamp false over the newer chain; guard on the token):
```js
    // …after the cast gesture + casterEffect emit, before returning:
    if (__ws04local && inst._castSequenceToken === token
        && typeof __ws04sh.noteLocalCastWindow === "function") {
        try { __ws04sh.noteLocalCastWindow(false); } catch (_) {}
    }
```
And in `cancelCastSequence` (`:6927`, covers fizzle / UseDone / recast preempt —
bumps the token, so an in-flight chain's token-guarded false-stamp won't double-fire):
```js
    inst._castSequenceToken = ((inst._castSequenceToken | 0) + 1) | 0;
    const __ws04sh2 = (typeof window !== "undefined") ? window.__sessionHandle : null;
    if (__ws04sh2 && typeof __ws04sh2.localPlayerGuid === "function"
        && ((guid >>> 0) === (__ws04sh2.localPlayerGuid() >>> 0))
        && typeof __ws04sh2.noteLocalCastWindow === "function") {
        try { __ws04sh2.noteLocalCastWindow(false); } catch (_) {}
    }
```
(If `localPlayerGuid()` is not the exact export name, use the same source the file's
existing `localGuid` reads use — `entities.js:1927-1934`, `:5704-5708`.)

### 3.6 `apps/holtburger-web/docs/url-flags.md` — new row (drafted)

> \| **`?castHoldReclaim=on`** \| **(2026-07-12, WS04 S3a) — DEFAULT-OFF, `=on` to
> enable; eye-test gated.** Holds the local player's FORWARD locomotion slot DEAD
> across a whole KNOWN cast chain instead of reviving held-W per-windup-node. Fixes the
> multi-windup war/void leak: for a TARGETED cast the server's turn-to-target
> (`Player_Magic.cs` `Rotate`/`TurnTo_Magic`) sets `local_server_controlled`, so FU-A is
> LIVE and the `use_time` reclaim revives held-W each time a windup node drains
> (`cmd_interp_use_time_reclaims_after_gesture_node_drains`) — you drift forward between
> windups without a fresh key edge. ON: the JS cast chain stamps
> `SessionHandle.noteLocalCastWindow(true/false)` (windup start → completion/fizzle/
> cancel); while active + grounded, the interpreter's `use_time` FU-A reclaim suppresses
> the forward-axis re-apply only (`command_interpreter.rs` `forward_reclaim_locked` →
> `apply_current_movement` forward axis holds Ready). Strafe/turn still reclaim
> (SLIDECAST untouched — orthogonal to `?slideCast`); a JUMP clears the lock (retail
> LeaveGround re-applies movement, acclient.c:344457/:344484 — jump out of the cast to
> move forward); a fresh FORWARD edge is untouched (FASTCAST anim-break preserved — only
> the edgeless `use_time` reclaim is gated). No hard root; the send stays authoritative.
> JS reader: `parse_cast_hold_reclaim_flag` → `movement.set_cast_hold_reclaim`; native
> const `USE_CAST_HOLD_RECLAIM`. Needs a wasm rebuild; NO manifest bump. **Pending 1070
> eye-test.** \| In Magic stance, HOLD W and cast a multi-windup war/void bolt AT A MOB
> (targeted): (a) `?castHoldReclaim=on` — hold W through the whole cast; (b) same but tap
> W once mid-cast (fastcast); (c) same but strafe A/D held; (d) jump mid-cast then hold
> W; (e) self-buff (untargeted) hold W; repeat all with the flag off. \| ON: (a) held-W
> produces ZERO forward drift for the entire chain (vs per-windup hops with the flag
> off); (b) the tap still fastcast-anim-breaks and moves you one step; (c) strafe dances
> side-to-side throughout (unchanged); (d) the jump moves you and held-W resumes on
> landing; (e) unchanged (self-buffs never leaked). OFF = today's per-windup hop. \|

---

## 4. TESTS

### 4.1 Runnable NOW on this box — DAT coverage audit (deliverable 1) ✅ PASS

`test_ws04_magic_gesture_lengths.mjs` (authored to
`/home/wbterminal/spellcast-fanout/`, ready to copy into
`apps/holtburger-web/tests/`). Uses the WB.Terminal DAT oracle; asserts all magic
gesture bands present as from-Ready links, computes self-contained authored lengths,
and pins the load-bearing MagicPowerUp10 > 2.0 s finding. Output this session:
```
[coverage] Magic-from-Ready group 0x490003:
  ✓ Magic-stance from-Ready link group exists
  ✓ MagicPowerUp01-10 windups: all 10 present
  ✓ colored band 0x12B-0x134: all 10 present
  ✓ cast substates 0x2B-0x39: all 15 present
  ✓ 35/35 core-band members self-contained (no extra DAT read)
  ✓ MagicPowerUp10 window 2250ms @2x EXCEEDS the 2.0s fallback (authored ingest is load-bearing)
PASS — 0 failure(s)
```

### 4.2 Rust unit tests for `?castHoldReclaim` (compile-and-run on the laptop)

**Interpreter-level (isolated, `Mock` seam — command_interpreter.rs `#[cfg(test)]`):**
```rust
/// WS04 — with the cast forward lock active, the use_time reclaim returns
/// control + revives turn/sidestep BUT holds the forward axis at Ready.
#[test]
fn cast_hold_reclaim_suppresses_forward_revival_only() {
    let mut it = CommandInterpreter::new(0.0);
    it.set_smartbox(true, true);
    it.controlled_by_server = true;
    // held W + held strafe-right in the lists (edge press seeds them).
    it.substate_list.add_command(MOTION_WALK_FORWARD, 1.0, false, 0);
    it.sidestep_list.add_command(MOTION_SIDESTEP_RIGHT, 1.0, false, 0);
    let mut m = Mock { motions_pending: false, cast_forward_lock: true, ..Default::default() };
    it.use_time(&mut m);
    // forward axis: a Ready press (dead), NOT a WalkForward/RunForward.
    let fwd = m.log.iter().find(|op| matches!(op,
        Op::DoMotion { cmd, .. } if *cmd == MOTION_WALK_FORWARD || *cmd == MOTION_RUN_FORWARD));
    assert!(fwd.is_none(), "forward held key must NOT revive under the cast lock");
    let ready = m.log.iter().any(|op| matches!(op, Op::DoMotion { cmd, .. } if *cmd == MOTION_READY));
    assert!(ready, "forward axis emits Ready (dead) under the lock");
    // strafe still revives (slidecast untouched).
    let side = m.log.iter().any(|op| matches!(op,
        Op::DoMotion { cmd, .. } if *cmd == MOTION_SIDESTEP_RIGHT));
    assert!(side, "held strafe still reclaims (slidecast semantics preserved)");
    assert!(!it.controlled_by_server, "control still returns to the player");
}

/// WS04 — lock OFF (or no window) → the existing per-node revival stands
/// (regression floor: byte-identical to today when the flag is off).
#[test]
fn cast_hold_reclaim_off_preserves_use_time_revival() {
    let mut it = CommandInterpreter::new(0.0);
    it.set_smartbox(true, true);
    it.controlled_by_server = true;
    it.substate_list.add_command(MOTION_WALK_FORWARD, 1.0, false, 0);
    let mut m = Mock { motions_pending: false, cast_forward_lock: false, ..Default::default() };
    it.use_time(&mut m);
    assert!(m.log.iter().any(|op| matches!(op,
        Op::DoMotion { cmd, .. } if *cmd == MOTION_WALK_FORWARD || *cmd == MOTION_RUN_FORWARD)),
        "flag-off: held-W revives via use_time exactly as today");
}
```

**System-level (mirror `cmd_interp_use_time_reclaims_after_gesture_node_drains`,
system/tests.rs):** clone that test; add `movement.set_cast_hold_reclaim(true);
movement.note_local_cast_window(true);` after `set_cmd_interp(true)`; hold W; drive the
node past its budget; assert the reclaim fired (`!local_server_controlled()`) but
`drive.forward == None` (held-W stays dead). A sibling with a held strafe asserts
`drive.sidestep == Some(StrafeRight)` (slidecast preserved). A third sets
`world.player.is_airborne = true` before the reclaim tick and asserts `drive.forward ==
Some(Forward)` (jump clears the lock).

**Run note (laptop):**
`env PATH="/home/wbterminal/.cargo/bin:/usr/local/bin:/usr/bin:/bin" capped-build \
  cargo test -p holtburger-core --lib cast_hold_reclaim` after
`kill $(pgrep -f rust-analyzer)`. (Not runnable here — I did not edit repo files; the
code above is authored against the live seam/Mock shapes read this session.)

### 4.3 TODO-FOR-LAPTOP — headless capture recipe

Serve: `python3 external/holtburger/scripts/serve.py` → :8765.
Bot URL (bare + flag arm):
`…/apps/holtburger-web/index.html?nosw=1&nullRender=1&renderOnDemand=1&netDrainHz=30&autoLogin=1&account=X&password=X&autoSpawn=first&kickDance=1&agent=1`
then append nothing (control) vs `&castHoldReclaim=on` (treatment).

1. Poll `window.__bootState === 'in-world'`.
2. Read spawn X: `const p0 = window.__sessionHandle.getLocalPlayerPose();`.
3. Simulate held-W: dispatch keydown 'w' (do NOT keyup). Under `?cmdInterp=on` this is
   `handle.handleKeyAction(0x29, true)`.
4. Cast a **targeted** multi-windup war bolt at a mob:
   `window.__sessionHandle.castTargetedSpell(mobGuid, warBoltSpellId)` (low-mana War I;
   pick a 2-3-windup spell). Confirm the caster turn echo lands
   (`__diag.wire.summary()` shows an UpdateMotion TurnTo directive).
5. During the cast, sample `getLocalPlayerPose()` each 100 ms; on `UseDone` (kind=14)
   read final X. keyup 'w'.
6. **Expected:** control arm — forward Δ accumulates in per-windup steps (the leak);
   `?castHoldReclaim=on` — forward Δ ≈ 0 for the whole chain. Strafe arm (hold A instead
   of W): both arms slide identically (slidecast untouched). Jump arm (Space mid-cast):
   both move on the jump; treatment resumes held-W on landing.
7. **Also capture** (closes §1.1 [H] Animation-asset gap): after spawn, in console
   `window.__hbWasm?.…` — verify `[mtlen] 0x09000001: ingested N authored one-shot
   lengths` logged with N large enough to include the secondary bands; if the console
   shows the `no from-Ready link lengths resolved` or a low N, the Animation assets
   weren't cached at ingest → add a re-ingest after the first cast bake (see §6).
8. **Self-buff control:** repeat step 4 with an untargeted self buff — expect ZERO
   forward leak on BOTH arms (FU-A dormant), confirming the targeted-cast root cause.

---

## 5. EYE-TEST QUEUE (1070 GPU box — batched, do NOT run here)

| Flag combo | Repro | Expected visual |
|---|---|---|
| `?castHoldReclaim=on` | Magic stance, HOLD W, cast a targeted multi-windup war bolt at a mob | Avatar plants — ZERO forward creep for the whole cast; vs flag-off per-windup hops |
| `?castHoldReclaim=on` | Same, but tap W once mid-cast | The tap still cuts the cast anim (fastcast) and steps you forward |
| `?castHoldReclaim=on` | Same, HOLD A (strafe) through the cast | Side-to-side dance unchanged (slidecast untouched) |
| `?castHoldReclaim=on` | Jump mid-windup, then hold W | Jump moves you; held-W resumes on landing (LeaveGround reset) |
| `?castHoldReclaim=on&slideCast=on` | HOLD W + strafe, targeted cast | Forward dead, strafe rides through (the two features compose) |
| `?castHoldReclaim=on` | Untargeted self-buff, HOLD W | No change vs flag-off (self-buffs never leaked — sanity) |
| `?castHoldReclaim=off` | All of the above | Byte-identical to today (regression floor) |

---

## 6. RISKS + INTERACTIONS

**Files touched (integration ordering):**
- Rust (needs the single wasm rebuild): `crates/holtburger-core/src/client/movement/system.rs`,
  `.../command_interpreter.rs`, `.../handle.rs`; `apps/holtburger-web/src/lib.rs`.
- JS (no rebuild): `apps/holtburger-web/scene3d/entities.js` (+ `index.html` only if the
  fizzle/UseDone path does not already route through `cancelCastSequence` — it does
  today, so index.html likely needs no change; verify at integration).
- Docs: `apps/holtburger-web/docs/url-flags.md`.
- Tests: `apps/holtburger-web/tests/test_ws04_magic_gesture_lengths.mjs` (new, runnable);
  Rust unit tests in `command_interpreter.rs` + `movement/system/tests.rs`.

**Risks:**
1. **[H] targeted-cast trigger unproven on this box.** If the live turn echo does NOT
   set `local_server_controlled` for a given cast path, the leak (and thus the fix)
   won't engage there. The fix is inert/harmless in that case (window set but no
   reclaim to suppress). §4.3 closes this — do it before sign-off.
2. **Window-signal races.** A recast preempts the token; the false-stamp is
   token-guarded (§3.5) so it can't clear a newer chain's window. If a chain is
   abandoned WITHOUT `cancelCastSequence` (e.g. entity despawn mid-cast), the window
   could stick TRUE. Mitigation: `note_local_cast_window(false)` also on
   despawn/stance-change (add to the local-player despawn path) and/or a wasm safety
   timeout (clear the window after `max(chain_est, 12 s)` — mirror the F8-4
   `_castBusyUntilMs` cap). Recommend the timeout belt for robustness.
3. **Animation-asset coverage gap (§1.1 [H]).** Secondary bands may 2.0 s-fallback.
   Safe (never hangs) but slightly-off timing for rare gestures. Fix if §4.3 step 7
   shows a low ingest N: re-fire `ingestMotionLengths(mtableId)` after the first cast
   bake commits the gesture anims to cache (one extra call, already idempotent —
   wholesale replace).
4. **auto_run + cast.** Under the lock, `apply_current_movement` skips the auto_run
   forward branch (forward Ready). Deliberate (hold forward dead) but note it for the
   eye-test — an auto-running caster stops moving forward during a locked cast.

**Interactions with other workstreams:**
- **WS03 (movement↔anim interplay):** shares the drive/overlay path; WS04 only zeroes
  the FORWARD component of the composed drive during the window — it does not touch the
  overlay suppression or the base-cycle bookkeeping WS03 owns. Coordinate on the
  `advance_manual_slice_via_transition` region (WS04 adds no code there; the change is
  in the interpreter reclaim). No file overlap expected beyond `system.rs`.
- **WS06/WS07 (facing/turn, remote casters):** WS04's root cause DEPENDS on the
  server-driven turn-to-target (§1.3). If WS06 changes how the caster's TurnTo is
  applied locally (e.g. suppressing the self turn echo), it may change whether
  `local_server_controlled` gets set → coordinate: WS04's fix should be robust either
  way (the window signal is JS-authoritative, independent of the TurnTo), but the *leak
  visibility* is coupled. Flag both as reading `player.rs:178-182`.
- **WS08 (cast lifecycle):** owns the `playCastSequence`/`cancelCastSequence`/UseDone/
  fizzle lifecycle where WS04 stamps the window. WS04's JS edits (§3.5) live in that
  lifecycle — WS08 should own/merge them so the stamp sites stay consistent with any
  lifecycle refactor (single source of truth for "cast in flight").
- **WS01 (windup link reliability):** WS01 audits `setSwingMotion`/link lookup for the
  *animation* rising; WS04 audits the *authored-length* completion clock for the same
  bands. Complementary — both read the Magic-from-Ready link group; no code overlap
  (WS01 = JS overlay path, WS04 = Rust queue clock). Share the DAT coverage finding.
- **`?slideCast` / `?castMove`:** orthogonal. `castHoldReclaim` only gates the FORWARD
  reclaim; slideCast governs strafe/turn persistence; castMove is the master latch.
  They compose (§5 row 5). No shared state beyond the interpreter struct.

---

## VERDICT (WS04-verify)

**Verdict: CONFIRMED** (apply: true, conditioned on 2 must-fixes). Adversarial
re-verification on the GCE buildbox, 2026-07-12. Every load-bearing cite was
re-opened against the live tree this session; the central DAT deliverable was
re-run through the oracle. This packet is unusually rigorous — the great majority
of its cites are verbatim-accurate — but two concrete defects in the JS layer
would leave the shipped feature inert / stuck, and the root-cause TRIGGER remains
an honestly-labelled `[H]`.

### A. Load-bearing cites re-verified (all ACCURATE, most verbatim)

Rust (holtburger-core / apps lib.rs), opened live:
- `motion_table_manager.rs` — module-doc completion-clock shim (:58-80),
  `RENDERER_DONE_FALLBACK_SECS = 2.0` (:155), `authored_len_for` (:198-207),
  `new_with_len` (:134-142). **EXACT.**
- `motion_interp.rs:1212-1222` — the single enqueue chokepoint calling
  `authored_len_for(self.interpreted_state.current_style, motion, params.speed)`.
  **VERBATIM.**
- `apps/holtburger-web/src/lib.rs:7593-7654` — `resolve_authored_motion_lengths`:
  the `(mtable_id >> 24) != 0x09` player-MT gate (:7600), from-Ready-only filter
  (:7615), `stance = outer_key >> 16` (:7618), freeze-hold `1/30` (:7624),
  explicit `(high-low+1)/|fr|` (:7628), and the `continue 'cmds` cache-miss skip
  (:7641). **EXACT.** Ingest is genuinely wired: JS `entities.js:4014-4015`
  (`sh.ingestMotionLengths(mtableId)`), recv arm `lib.rs:46529-46557` →
  `movement.ingest_authored_motion_lengths`. So the shim ISN'T dormant — the
  authored lengths really flow.
- `command_interpreter.rs:822-838` — the `use_time` reclaim predicate
  (`controlled_by_server && !player_motions_pending() && !player_is_moving_to()
  && (substate/turn/sidestep head || auto_run)`). **VERBATIM.**
- `system.rs`: `interpreted_movement_active` (:1911-1913),
  drive dispatch (:5689-5699), `interpreted_drive_state`
  Substate/None → forward=None (:2244-2256), `player_motions_pending`
  (:7288-7318), **`apply_axis(MOTION_READY,true)→drive.forward=None` (:7200-7203)**,
  `do_motion` raises `last_move_was_autonomous` (:7232-7238),
  `note_server_authored_motion` lowers the latch (:1902-1903). **ALL EXACT.**
- `handlers/player.rs:167-196` — the UpdateMotion local-player arm; the
  non-autonomous, non-`Invalid` → `set_local_server_controlled(true)` (:178-182)
  with the verbatim "General (`Invalid`) envelopes … only lower the autonomy
  latch, never the control flag" comment (:176-177). **EXACT.**
- Pinning test `system/tests.rs:7130-7214`
  (`cmd_interp_use_time_reclaims_after_gesture_node_drains`) genuinely asserts
  `drive.forward == Some(Forward)` after the gesture node drains — the LEAK is a
  live regression pin. **EXACT.** (Note: it drains on the flat
  `RENDERER_DONE_FALLBACK_SECS`, not an authored length — the mechanism is
  length-agnostic, so the packet's per-node story holds either way.)
- ACE `Player_Magic.cs`: `Rotate` (:166, within the cited :159-190),
  `TurnTo_Magic` (:189/:215/:803), `CreateTurnToChain2(… MagicState.AlwaysTurn)`
  (:827), `MagicState.AlwaysTurn = true` (:1269). **ALL EXACT** — the targeted-cast
  turn directive is real server truth.
- Decomp `acclient.c:344457` `CMotionInterp::LeaveGround` — body matches the
  packet's description (`get_leave_ground_velocity` → `set_local_velocity` →
  `standing_longjump = 0` → `RemoveLinkAnimations` → `apply_current_movement`).
  **REAL, not hallucinated.**
- All patch INSERTION points exist and mirror live patterns: `parse_cast_move_flag`
  (:240), `setAutoRun` export (:32171, `Result<(),JsValue>` + `unbounded_send` +
  `map_err(TrySendError)`), `SetAutoRun` cmd (:21814), recv arm (:46518), boot
  `set_cast_move` (:36921), `handle.rs:287` `set_cast_move`, system setters
  (:1840/:1858), Mock/Op (`command_interpreter.rs:1843/:1887/:1931`,
  `Op::DoMotion{cmd,..}`), `InterpreterSeams` trait (:282/:324), `effects` field
  (:484), `is_airborne` (`holtburger-world/src/player/types.rs:1374`). **ALL PRESENT.**

### B. DAT deliverable-1 — RE-RUN on this box, PASSES

Ran `test_ws04_magic_gesture_lengths.mjs` against the live oracle
(`0x09000001`, Magic-from-Ready group `0x00490003`). Output reproduces the
packet's table exactly: windups 10/10, colored 10/10, cast substates 15/15
present; 35/35 core-band members self-contained; **MagicPowerUp10 = 2250 ms @
CastSpeed 2.0 > the 2.0 s fallback** (authored ingest is load-bearing, confirmed).
The deliverable-1 "coverage complete for the core war/void bands, only rare
`high==-1` secondary bands may 2.0 s-fallback" finding is **empirically sound**.

### C. Mechanism soundness — traced a potential counter-example, fix HOLDS

I stress-tested the fix against the obvious counter-example: *"the locked reclaim
sets `drive.forward = None` for ONE tick, but W is still physically held — does the
raw drive re-populate forward next tick and defeat the lock?"* Traced
`advance_manual_slice_via_transition:5661-5699`: the manual slice reads the
PERSISTENT `self.active_drive` (`ActiveDriveIntent::Manual(state)`), it is NOT
re-derived from physical key state per tick. Latch-HIGH uses `active_drive`
as-is; nothing re-drives `forward` without either a fresh input EDGE or an
`apply_current_movement` substate-head replay (both suppressed/preserved
correctly by the design). Therefore holding `forward=None` for the reclaim tick
keeps held-W dead across SUBSEQUENT ticks. **The fix works.** Corroborated by the
seam: the locked branch's `move_player(seams, MOTION_READY, 1, 1.0, 0, 0)` is
**byte-identical** to the existing `!transient_state` fallback at
`command_interpreter.rs:1063`, so its behavior (`apply_axis(MOTION_READY)` →
`drive.forward=None`) is guaranteed.

### D. Regression safety — GUARANTEED by default-OFF

`USE_CAST_HOLD_RECLAIM = false` + runtime `cast_hold_reclaim_runtime: None`. Flag
off ⇒ `cast_hold_reclaim_enabled()`=false ⇒ `local_cast_forward_lock_active()`=false
⇒ `forward_reclaim_locked` can never be true ⇒ `apply_current_movement` takes the
existing `auto_run / substate-head / Ready` branches ⇒ **byte-identical** to
today. New fields default false/None. castMove/slideCast/cmdInterp are untouched.
Regression floor holds.

### E. REQUIRED CORRECTIONS

1. **[MUST-FIX — feature is INERT as written] JS local-guid accessor is wrong.**
   §3.5 hunks call `__ws04sh.localPlayerGuid()`, but **no such SessionHandle
   export exists** (grep of `js_name = *[Gg]uid` in `src/lib.rs` shows only event
   getters — vendorGuid/casterGuid/targetGuid/… — never a `localPlayerGuid`). The
   canonical local-guid source used 26× in `entities.js` is the GLOBAL
   `window.getLocalPlayerGuid()` (see `:1929`, `:5706`, `:11390` — the very lines
   the packet's own parenthetical points at). As literally written,
   `typeof __ws04sh.localPlayerGuid === "function"` is false ⇒ `__ws04local` is
   always false ⇒ the cast window is **never stamped** ⇒ the whole feature is a
   silent no-op even with `?castHoldReclaim=on`. **Fix:** replace
   `__ws04sh.localPlayerGuid()` with `window.getLocalPlayerGuid()` in all three
   §3.5 sites (guard for `typeof window.getLocalPlayerGuid === "function"`). This
   degrades safely (inert, no crash), so it is a correction-before-function, not a
   crash risk — but it MUST land or the deliverable-2 fix does nothing.

2. **[MUST-FIX before flag-on — window can stick TRUE] despawn escape hatch.**
   Confirmed by reading `playCastSequence`: the windup loop `if (!ok) return;`
   (`entities.js:6827`) returns EARLY when `!this.entityMap.has(g)` (despawn
   mid-windup) WITHOUT bumping the token or calling `cancelCastSequence`, so the
   natural-completion false-stamp (tail ~:6911) is never reached and the cast
   window sticks TRUE — which would pin the forward axis dead indefinitely. This
   is the packet's own acknowledged Risk #2. It is harmless while the flag is
   default-OFF, but MUST be fixed before any flip: add a
   `noteLocalCastWindow(false)` on the local-player despawn/stance-change path
   AND/OR a wasm safety timeout (mirror the F8-4 `_castBusyUntilMs` 12 s cap) that
   auto-clears the window. Recommend the timeout belt — it is robust to any
   abandonment path, not just despawn.

### F. NOTES (not blockers)

- **[H] targeted-cast trigger** (turn echo → `set_local_server_controlled`) is
  grounded in verified ACE source + a verified code trace + dev-community lore,
  but the live wire timing is not runtime-proven on this box. Honestly labelled
  `[H]` with a correct laptop capture recipe (§4.3). The fix is inert/harmless if
  the trigger doesn't engage, so this gates *sign-off confidence*, not safety.
  The self-buff asymmetry (self-target ⇒ no TurnTo ⇒ FU-A dormant ⇒ no leak) is
  plausible and consistent with the charter naming war/void; also `[H]`, also
  capture-recipe'd.
- **Rust unit tests (§4.2)** are authored against real Mock/Op shapes (verified:
  `log: Vec<Op>`, `Op::DoMotion{cmd,speed_bits,..}`, manual `Default`,
  `controlled_by_server` is `pub(crate)`), but were not compiled here (the packet
  says so). A laptop `capped-build cargo test -p holtburger-core --lib
  cast_hold_reclaim` is still owed; low risk. `it.substate_list.add_command(...)`
  / `it.set_smartbox(...)` signatures are the only unread shapes.
- **Scope discipline is correct:** the packet adds NO client-side hard movement
  root (retail `Windup_MaxMove` is PK/server-side — foundation §2.4), keeps the
  send authoritative, and only zeroes the FORWARD component (slidecast/strafe/turn
  untouched, jump-clears-lock preserved). No ACE edits. New default-OFF flag with
  a url-flags.md row matches the convention (like `portalStencil`/`perPolyCull`).
- **Cross-workstream:** the JS stamp sites live in the WS08 cast lifecycle and the
  fix reads the same `player.rs:178-182` control-set as WS06/WS07 — the packet's
  coordination notes are accurate; no undeclared out-of-scope file edits.

### Bottom line
Analysis, root cause, DAT audit, and Rust patch are **CONFIRMED and
regression-safe**. Apply is TRUE, but the JS layer needs correction #1 or the
feature does nothing, and correction #2 before the eye-test flip. Neither touches
the (sound, default-OFF-guarded) Rust core.

```json
{"workstream":"WS04","verdict":"CONFIRMED","apply":true,"mustFix":["JS §3.5: replace the non-existent `__ws04sh.localPlayerGuid()` with the canonical global `window.getLocalPlayerGuid()` in all three stamp sites — as written `__ws04local` is always false and the whole ?castHoldReclaim feature is a silent no-op (degrades safe, but does nothing)","Add a despawn/stance-change `noteLocalCastWindow(false)` and/or a wasm safety-timeout auto-clear (mirror F8-4 _castBusyUntilMs 12s cap) before any flag-on flip — the windup loop's `if(!ok) return` at entities.js:6827 leaves the cast window stuck TRUE on mid-cast despawn, pinning forward dead (packet Risk #2, confirmed)"],"notes":"Every load-bearing cite re-opened live and verified (most verbatim); DAT deliverable-1 test RE-RUN on this box and PASSES (MagicPowerUp10=2250ms>2.0s fallback confirmed load-bearing); root cause pinned by the live cmd_interp_use_time_reclaims_after_gesture_node_drains test; fix mechanism traced sound (active_drive is persistent, not per-tick raw rebuild, so forward=None survives across ticks); regression floor guaranteed by default-OFF USE_CAST_HOLD_RECLAIM. Targeted-cast trigger remains honestly-labelled [H] (ACE source + code trace solid, live wire timing needs the §4.3 laptop capture). Rust unit tests unverified-compile (packet says so)."}
```

---

```json
{"workstream":"WS04","title":"Rust movement arbitration during casts (S3a)","packetPath":"/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/docs/spellcasting-packets-2026-07-12/WS04-rust-arbitration.md","confidence":"high","keyFindings":["authored_len_for coverage is COMPLETE for all core war/void magic gesture bands (windups 0x6F-0x78, colored 0x12B-0x134, cast substates 0x2B-0x39) — all 35 present as Magic-from-Ready links in player MT 0x09000001 and self-contained (DAT-verified, runnable test passes)","MagicPowerUp10/colored-top authored length = 2250ms @CastSpeed2.0 EXCEEDS the flat 2.0s fallback — the P16-H2 authored ingest is load-bearing, not cosmetic","Root cause of S3a: for TARGETED casts the server turn-to-target (Player_Magic.cs Rotate/TurnTo_Magic) sets local_server_controlled, making FU-A live; the use_time reclaim then revives held-W each time a windup node drains (pinned by cmd_interp_use_time_reclaims_after_gesture_node_drains) — leaking forward between windups without an edge","FU-A is dormant for self/untargeted buffs (General cast gestures never set scene control, player.rs:176-182), which is why war/void (always targeted) leak and self-buffs do not","Only real coverage gap: rare secondary bands (0x10E-0x111,0x19B,0x40000136-139) with high==-1 anims fall to the 2.0s fallback if their Animation asset isn't cached at ingest — degrades safely, never hangs"],"filesToChange":["crates/holtburger-core/src/client/movement/system.rs","crates/holtburger-core/src/client/movement/command_interpreter.rs","crates/holtburger-core/src/client/movement/handle.rs","apps/holtburger-web/src/lib.rs","apps/holtburger-web/scene3d/entities.js","apps/holtburger-web/docs/url-flags.md","apps/holtburger-web/tests/test_ws04_magic_gesture_lengths.mjs"],"needsWasmRebuild":true,"newFlags":["castHoldReclaim"],"risks":["Targeted-cast trigger (turn echo sets local_server_controlled) is grounded in ACE source + code trace but not runtime-proven on this box — needs the laptop capture (§4.3) to confirm the leak engages live","Cast-window signal could stick TRUE if a chain is abandoned without cancelCastSequence (despawn mid-cast) — mitigate with a despawn/stance-change false-stamp and/or a wasm safety timeout mirroring _castBusyUntilMs","Animation-asset caching gap for rare secondary gesture bands (2.0s fallback) — verify ingest N on the laptop; re-ingest after first cast bake if low","auto_run casters stop moving forward under the lock (deliberate) — flag for eye-test"]}
```
