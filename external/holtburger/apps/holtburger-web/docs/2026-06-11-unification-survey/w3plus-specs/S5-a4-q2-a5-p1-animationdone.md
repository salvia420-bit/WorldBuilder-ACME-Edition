# S5 — A4-Q2 + A5-P1: AnimationDone across the wasm boundary + the hook-drain completion executor

W3+ deep-spec sweep, 2026-06-11, agent S5. Items: **A4-Q2** (notifyAnimationDone export +
renderer wiring, `?mtQueue=`) and **A5-P1** (hook drain-to-completion + deferred fire,
`?hookDrain=`), per the DESIGN.md STAGE 2 AMENDMENT (the A3-D1 fold). These two are ONE
coordinated change-set in `entities.js` (ROADMAP §3 conflict matrix: "A5-P1 and A4-Q2 are one
coordinated change (same `finished` listeners)").

All repo paths relative to `external/holtburger/` inside
`/home/wbterminal/WorldBuilder-ACME-Edition`. Retail truth: `/home/wbterminal/ac-headers/acclient.c`.

---

## 1. read-HEAD + W2 assumptions

**Read HEAD: `61bea82f`** ("W2/Batch-R2 buildbox dispatch manifest"). The W2 wave was
committing DURING this read; the following working-tree state was observed UNCOMMITTED at
read time and this spec depends on it landing essentially as-is:

| W2 item | observed state at read | what this spec uses | what breaks if it slips |
|---|---|---|---|
| **A4-Q1** (queue core) | ON DISK, UNCOMMITTED: `crates/holtburger-core/src/client/movement/motion_table_manager.rs` (untracked, 783 lines, full retail port + 17 tests), `mod.rs:5` (`mod motion_table_manager;`), `system.rs:296` (`const USE_MOTION_TABLE_QUEUE: bool = false`), `system.rs:768` (`motion_table_manager: MotionTableManager` field), `system.rs:~1071-1088` (per-tick `use_time()` + drain-and-drop pump), `docs/url-flags.md:270` (flag row) | `MotionTableManager::animation_done(success)` (motion_table_manager.rs:325-353) is THE target the new export calls; `drain_events()` (:173-175); the empty-queue no-op guard (:326-330) | **Q2 Rust half is BLOCKED outright** — `notifyAnimationDone` has nothing to call. The JS half (Stage D below) degrades to wiring a typeof-guarded call to a missing export (soft no-op, the F18-2 pattern), and A5-P1 (Stages A/B, pure JS) is UNAFFECTED and can ship alone. If W2's final commit renames symbols or moves the pump, re-verify every `motion_table_manager.rs` / `system.rs` cite below before implementing. |
| **A3-D1/D2** (motion_done consumer) | NOT on disk: `motion_interp.rs` has zero `motion_done`/`pending_motions` hits (grep, 804 lines); `interp_state.rs:50` actions FIFO still `#[allow(dead_code)]` | Nothing directly. The system.rs pump drains-and-DROPS `MotionDone` events until D2 lands (system.rs pump comment, working tree) | Nothing breaks — Q2 lands inert-but-tested. Until A3-D2's `PerformMovement` dispatch exists there is also **no enqueue source**, so the queue stays empty and `animation_done` no-ops on the head-null guard (motion_table_manager.rs:326-330; retail `acclient.c:329884`). |
| A2-P1, A7-R1/R2/R3/R6, A9-Stage1 | not inspected | nothing | no dependency — disjoint files. |

W0/W1 state confirmed in-tree: canonical spine `crates/holtburger-core/src/client/tick_spine.rs`
exists (A1-O1, commit 656c8ef1; `tick_frame` at :61), `?unifiedTick` / `?worldLifecycle` /
`?wireStatePacks` gates exist (commits 656c8ef1, 174fa1b4, ac3f9891). A9-Stage2 rig-module
extraction landed (a468c931) — the entities.js conflict-order risk ROADMAP §3 flagged is past.

---

## 2. Current-state map (post-W0/W1, working tree at 61bea82f)

### 2.1 Retail completion chain (every line verified this session)

```
CSequence::update_internal: per crossed frame — combine pos_frame, apply_physics,
  execute_hooks(part_frame[fn])                          acclient.c:340717-340726
  on segment exhaustion: queue anim_done_hook via add_anim_hook IF the finished
  node != head==first_cyclic                              acclient.c:340764-340774
  (clamp at high_frame + fire every crossed frame's hooks BEFORE queueing done:
   acclient.c:340697-340727)
execute_hooks QUEUES, never runs inline                   acclient.c:339683-339699
  -> CPhysicsObj::add_anim_hook (SmartArray append)       acclient.c:322063-322073
CPhysicsObj::UpdatePositionInternal: offset combine -> physics resolve -> ONLY THEN
  CPhysicsObj::process_hooks drains the queue in order    acclient.c:320030-320035
AnimDoneHook::Execute                                     acclient.c:342336-342339
  -> CPhysicsObj::Hook_AnimDone (success hard-coded 1)    acclient.c:317087-317094
  -> CPartArray::AnimationDone                            acclient.c:325080-325087
  -> MotionTableManager::AnimationDone(success):
       ++animation_counter; pop heads with num_anims <= counter;
       action-bit 0x10000000 -> MotionState::remove_action_head;
       CPhysicsObj::MotionDone(motion, success); counter -= num_anims;
       counter = 0 when queue drains                      acclient.c:329873-329936
  -> CPhysicsObj::MotionDone                              acclient.c:317097-317104
  -> MovementManager::MotionDone                          acclient.c:339349-339356
  -> CMotionInterp::MotionDone (pops pending_motions; action bit ->
       unstick_from_object + RemoveAction on both states) acclient.c:343641-343676
zero-anim motions: MotionTableManager::CheckForCompletedMotions pops only
  num_anims==0 heads with success=1                       acclient.c:329960-329980
  called per-frame (UseTime tailcall; BN pseudo-C acclient_2013.bndb_pseudo_c.txt:
  290845-290850) AND synchronously after EVERY CMotionInterp::PerformMovement arm
  (cases 1-5 each call CPhysicsObj::CheckForCompletedMotions)
                                                          acclient.c:344670-344710
exit-world: HandleExitWorld drains queue with success=0   acclient.c:329940-329947
```

Two retail properties this spec exists to reproduce:
1. **Completion is ORDERED AFTER the final frame's hooks** — anim_done is queued at
   advance_anim (acclient.c:340764-340774) after the crossed-frame `execute_hooks` calls
   (:340725), and both drain through the same FIFO `process_hooks` (:320035) AFTER position
   resolve.
2. **Completion is COUNTED, not keyed** — `AnimationDone` is positional (`animation_counter`
   vs `num_anims`, acclient.c:329885-329894); the renderer never says WHICH anim finished.

### 2.2 Our side

**Rust (working tree, includes uncommitted A4-Q1):**
- `motion_table_manager.rs` — faithful queue port: `AnimNode` (:59-62),
  `animation_done(success)` (:325-353, incl. empty-queue no-op :326-330 mirroring
  acclient.c:329884 and counter reset :350-352 mirroring :329931-329936),
  `check_for_completed_motions` (:361-375), `use_time` (:384-386), `handle_exit_world`
  (:394-398), events enum `MotionTableEvent::{MotionDone, RemoveLinkAnimations,
  RemoveAllLinkAnimations}` (:68-83), `drain_events` (:173-175). Doc comment :320-324
  explicitly names this spec: "A4-Q2 wires the `notifyAnimationDone` export to this."
  `MotionTableEvent::RemoveLinkAnimations` doc (:74-78) says "Renderer wiring is A4-Q2" —
  see §6 OQ-3 for the scope cut.
- `system.rs` — `USE_MOTION_TABLE_QUEUE: bool = false` (:296); `MovementSystem` owns the
  local player's instance (:763-768); `tick()` pumps `use_time()` + drains-and-drops events
  after drive ingestion (inside `tick` starting :1037; pump block ~:1071-1088), mirroring
  retail's post-PerformMovement poll (acclient.c:344684-344704) + per-frame UseTime.
- `handle.rs` — `MovementSystemHandle` wraps `MovementSystem`; `inner_mut()` is
  `pub(crate)` (:146), so the wasm crate needs a new public forwarding method (§3 Stage C).
- `interp_state.rs:48-50` — pending-action FIFO, still write-only (`#[allow(dead_code)]`).
- `apps/holtburger-web/src/lib.rs` — `SessionCommand` enum (:17004); export-over-channel
  pattern: `jump_charge_begin` sends `SessionCommand::JumpChargeBegin` via
  `cmd_tx.unbounded_send` (:26297-26305), recv arm consumes it (:38709-38720);
  `TickMovement` arm (:38975+) holds `world` and `movement` (the `MovementSystemHandle`) in
  scope; `WASM_EXPORT_MANIFEST_VERSION: u32 = 2` (:445) with the bump policy comment
  (:431-444). No `notifyAnimationDone`/`AnimationDone`/`MotionDone` symbol anywhere in
  lib.rs (grep: 0).

**JS (`apps/holtburger-web/scene3d/entities.js`):**
- One-shots play as LoopOnce overlays via `_tryPlayLink` (:7484-7622); per-play
  `actionLastHookTime.set(linkKey, 0)` re-arms hook windows (:7560); overlay actions live in
  `inst.actions` keyed `link:<from>-><to>:<stance>` (:7534-7542).
- The ONLY `finished` listener in the file is `_suppressBaseCycleForOverlay`'s
  base-cycle-weight restore (:7632-7661, listener :7647-7659) — registered only when
  `FULL_BODY_ONE_SHOT` (`?fullBodyOneShot`, :445) and only for attack/cast (:7590-7593).
  **Nothing notifies Rust of clip end** (divergence A4 §3 row 2).
- Hook executor `_tickAnimationHooks` (:9859-9905): walks `inst.actions`, **skips finished
  actions** (`if (!action || !action.isRunning()) continue;` :9875) → trailing hooks in
  `(lastHookTime, duration]` are DROPPED when a LoopOnce crosses its end between two rAFs
  (divergence A5 §3 row 3; retail contrast acclient.c:340697-340727 clamps and fires).
- Hooks fire INLINE during the entity tick, immediately after `inst.mixer.update(dt)`
  (:9382) → `_tickAnimationHooks` (:9396), i.e. BEFORE the jump/swing/cast/scale tween and
  omega/material passes (:9411-9516) and not deferred past position application — inverting
  retail's queue-then-drain-after-position-resolve (acclient.c:339696 + :320035; divergence
  A5 §3 row 4). three.js `finished` events fire inside `mixer.update` (library behavior,
  A5 §6 caveat), i.e. before that frame's hooks — completion-before-hooks inversion.
- `_fireHooksInRange` (:9917-9928) walks the sorted timeline in `(low, high]`;
  `_fireHook` (:9936+) is the SHARED executor (A11-S1 reuses it via `ScriptManager`,
  :672-690 — "never a 4th copy").
- Eviction: `evictOldestUnused` (:1978-2004) stops + uncaches an LRU action and deletes its
  timeline/lastHookTime; no completion signal of any kind.
- Per-instance tick body: smoothing/pose ease → gait/timeScale (:9332-9379) →
  `mixer.update` (:9382) → hooks (:9396) → tweens (:9411-9469) → omega (:9477-9493) →
  material hooks (:9498-9516) → idle fidget → end of loop (~:9540).
- Flag precedent: `SCRIPT_QUEUE_ON` URLSearchParams const (:680-690); local-guid bridge
  precedent: `window.getLocalPlayerGuid` (used at :9026-9029 and 6 other sites); the
  SessionHandle lives in index.html as `handle` with typeof-guarded calls
  (index.html:8726-8728 `jumpChargeBegin` pattern).
- hookType 4 "AnimationDone" baked-frame hooks emit a plugin event only (:10278-10294) —
  NOT part of the completion chain (see §6 OQ-1).

**Parity findings (no work needed):** Q1's queue semantics vs retail — already at parity in
the working tree (motion_table_manager.rs tests pin FIFO order, num_anims accounting,
counter reset, truncation masks, Stop→Ready, exit-world drain against acclient.c:329842-330260).
This spec adds NO queue-semantics work.

---

## 3. Staged implementation plan

Execution order (DESIGN amendment seam contract): **Stage A → B (A5-P1, JS-live) → Stage C
(A4-Q2 Rust, wasm-rebuild) → Stage D (A4-Q2 JS, JS-live)**. A5 decides WHERE `finished`
fires (ROADMAP §2: "A5-P1's per-entity hook queue must exist before Q2 routes completion
through it"); Q2's notify call is then just one more record type in that queue.

### Stage A — finish-drain (A5-P1a). JS-live, flag `?hookDrain=on` (default OFF)

Fixes A5 §3 row 3 (trailing-hook drop). Retail mirror: clamp-to-high_frame + fire every
crossed frame's hooks in the same update (acclient.c:340697-340727).

- **New module `apps/holtburger-web/scene3d/hook_windows.js`** (pure, no THREE — the
  `script_manager.js` testability pattern). Export:
  ```js
  // Returns { windows: [[lowExclusive, highInclusive], ...], drainedTo: number|null }
  export function planHookWindows({ lastTime, currentTime, clipDuration, isRunning, isLoopOnce })
  ```
  Semantics:
  - running, `currentTime >= lastTime` → `[[lastTime, currentTime]]` (today's :9893-9895);
  - running, wrapped (LoopRepeat) → `[[lastTime, clipDuration], [-Infinity, currentTime]]`
    (today's :9896-9902);
  - NOT running, LoopOnce, `lastTime < clipDuration` → `[[lastTime, clipDuration]]`,
    `drainedTo = clipDuration` — the finish-drain;
  - NOT running, `lastTime >= clipDuration` → no windows (already drained — the natural
    drain marker; `_tryPlayLink`'s reset to 0 at :7560 re-arms replays).
- **`entities.js _tickAnimationHooks`** (:9859-9905): under the flag, replace the
  `!action.isRunning()` `continue` (:9875) + inline window math (:9893-9902) with
  `planHookWindows`; write `drainedTo` into `actionLastHookTime` when present. Off-path:
  byte-identical legacy branch retained (the RP2/A11-S1 dual-path house style).
- Flag const `HOOK_DRAIN_ON` per the `SCRIPT_QUEUE_ON` pattern (:680-690); register in
  `docs/url-flags.md`.
- **wasm-rebuild: NO.** Manifest: untouched.

### Stage B — deferred fire queue + completion records (A5-P1b). Same flag `?hookDrain=on`

Fixes A5 §3 row 4 (inline fire + completion-before-hooks inversion). Retail mirror: hooks
queue via add_anim_hook (acclient.c:339696, 322063-322073), anim_done queued AFTER the final
frame's hooks (:340725 then :340764-340774), all drained in order by process_hooks after
position resolve (:320030-320035).

- **`inst._hookFireQueue = []`** on EntityInstance (init next to `hookTimelines`/
  `actionLastHookTime`, :1774-1776).
- Under `?hookDrain=on`, `_fireHooksInRange` pushes `{ kind: "hook", hook }` records instead
  of calling `_fireHook` inline; when Stage A's finish-drain detects a LoopOnce completion
  it pushes `{ kind: "animDone", key, action }` AFTER that overlay's trailing hook records —
  the retail interleave order.
- **Drain point**: end of the per-instance tick body (after the material-hook block
  :9498-9516, i.e. after every pose/position/tween application — our analog of
  process_hooks-after-position-resolve, acclient.c:320035). One loop:
  `"hook"` → `this._fireHook(inst, hook, audioMgr, cache)`;
  `"animDone"` → `this._completeOverlay(inst, key, action, /*finished=*/true)`.
- **New method `_completeOverlay(inst, key, action, finished)`** — the ONE owner of
  overlay-end work:
  1. base-cycle weight restore: when `inst._baseSuppressAction === action`, perform the
     restore logic currently inside the `onFinished` listener (:7647-7659). Under the flag,
     `_suppressBaseCycleForOverlay` records `{ savedWeight, baseAction }` on `inst` and does
     NOT register the mixer listener (avoids double-restore); off-path keeps the listener.
  2. Stage-D's notify call (below) — a no-op until `?mtQueue=on`.
- A11-S1 seam: `ScriptManager`-fired hooks (PhysicsScript chain) keep calling `_fireHook`
  directly — they are wall-clock script hooks, not animation-timeline hooks; only the
  timeline executor + completion route through `_hookFireQueue`. (Retail keeps PhysicsScript
  hooks on the same CPhysicsObj hook array, but our ScriptManager already has its own
  time-ordering; merging the two queues is explicitly OUT of P1 scope — note in code.)
- **wasm-rebuild: NO.**

### Stage C — `notifyAnimationDone` export (A4-Q2 Rust half). Wasm-rebuild, batch R4, manifest bump

- **`crates/holtburger-core/src/client/movement/system.rs`**: new method on
  `MovementSystem`:
  ```rust
  /// A4-Q2 — renderer AnimationDone signal (retail AnimDoneHook::Execute →
  /// Hook_AnimDone → CPartArray::AnimationDone → MotionTableManager::AnimationDone,
  /// acclient.c:342336 → 317087 → 325080 → 329873). Inert unless
  /// USE_MOTION_TABLE_QUEUE (and harmlessly no-op on an empty queue even then,
  /// acclient.c:329884 head-null guard).
  pub(crate) fn notify_animation_done(&mut self, success: bool) {
      if USE_MOTION_TABLE_QUEUE {
          self.motion_table_manager.animation_done(success);
      }
  }
  ```
  The resulting `MotionDone` events ride the EXISTING per-tick pump drain (working-tree
  system.rs ~:1083-1087) — no second drain site.
- **`crates/holtburger-core/src/client/movement/handle.rs`**: public forward
  `pub fn notify_animation_done(&mut self, success: bool)` →
  `self.inner_mut().notify_animation_done(success)` (`inner_mut` :146).
- **`apps/holtburger-web/src/lib.rs`**:
  1. `SessionCommand::AnimationDone { guid: u32, success: bool }` (enum :17004).
  2. `SessionHandle` export, exactly the `jump_charge_begin` shape (:26297-26305):
     ```rust
     #[wasm_bindgen(js_name = notifyAnimationDone)]
     pub fn notify_animation_done(&self, guid: u32, success: bool) -> Result<(), JsValue>
     ```
     → `cmd_tx.unbounded_send(SessionCommand::AnimationDone { guid, success })`.
  3. Recv arm (next to `JumpChargeBegin`, :38709): guard `world.as_mut()` + `entity_seeded`
     (the `TickMovement` arm convention, :38985-38988); **guid filter**: only when
     `guid == w.player.guid.0` call `movement.notify_animation_done(success)`; non-local
     guids are silently dropped (per-entity instances are DESIGN Stage-3 scope —
     "per-entity instances, per-entity my_run_rate — no globals", DESIGN.md Stage 3
     amendment; queue field doc system.rs:763-767).
  4. **Manifest: bump `WASM_EXPORT_MANIFEST_VERSION` 2 → 3** (:445) with a `// v3` comment
     naming the export; index.html `EXPECTED_WASM_MANIFEST_VERSION` (index.html:1801 region)
     stays until the flags integrate always-on — the JS caller is flag-gated +
     typeof-guarded so a v2 pkg soft-degrades (the documented v2 precedent, lib.rs:440-444).
- **num_anims contract (pin it in the motion_table_manager.rs module doc while there):**
  one renderer-realized motion == ONE AnimationDone, because the bake flattens all
  `MotionData.anims` segments into one clip (`build_concatenated_motion_frames`,
  lib.rs:5681-5873) and JS plays ONE LoopOnce action per one-shot. Therefore every future
  enqueue site (A3-D2's `PerformMovement` dispatch) uses `num_anims = 1` for motions with a
  clip and `num_anims = 0` for anim-free motions (which complete via the per-tick poll,
  motion_table_manager.rs:361-375 / acclient.c:329960-329980). This resolves A4 §6's
  "num_anims provenance" open question by convention; retail's multi-anim accounting
  (acclient.c:330225 out-params) is intentionally collapsed to the bake's granularity.
- **wasm-rebuild: YES** — batch with other R4 getter/export items (ROADMAP §5). Build is
  W2-wave-owned; this spec only stages the source change.

### Stage D — JS notify wiring (A4-Q2 JS half). JS-live, flag `?mtQueue=on` (default OFF)

- **index.html**: alongside the `getLocalPlayerGuid` bridge, expose
  ```js
  window.__notifyAnimationDone = (guid, success) => {
    try {
      if (handle && typeof handle.notifyAnimationDone === "function")
        handle.notifyAnimationDone(guid >>> 0, !!success);
    } catch (_) {}
  };
  ```
  (entities.js holds `this.wasmExports` = module exports only, NOT the SessionHandle —
  the window bridge matches the existing `window.getLocalPlayerGuid` seam, entities.js:9026.)
- **entities.js**: `MT_QUEUE_ON` flag const (SCRIPT_QUEUE_ON pattern); register in
  url-flags.md.
- **Tagging contract** (prevents counter poisoning — see §5 risk 2): only overlays the wasm
  pipeline queued may notify. `_tryPlayLink` gains an options field `mtQueued: boolean`
  (default false) stored in a per-instance `inst._mtQueuedKeys: Set<linkKey>` on play and
  cleared on completion/eviction. NO current caller passes true — the callers arrive with
  Stage-2 `?interpRig` consumption / A3-D2; Q2 pins the plumb so D2 cannot fork it.
  Locomotion transition links and server-echo overlays NEVER notify.
- **Call sites** (all gated `MT_QUEUE_ON && inst._mtQueuedKeys.has(key) &&
  inst.guid === localPlayerGuid`):
  1. **Completion**: inside `_completeOverlay` (Stage B) →
     `window.__notifyAnimationDone(inst.guid, true)` — retail success is hard-coded 1 on the
     renderer path (`CPartArray::AnimationDone(v1, 1)`, acclient.c:317093). With
     `?hookDrain=off` but `?mtQueue=on`, fall back to a mixer `finished` listener registered
     at the tagged play site (flags stay independently flippable; full retail ORDERING
     parity only with both on — document in url-flags.md).
  2. **Cancellation**: `evictOldestUnused` (:1990-1995) and any explicit `.stop()` of a
     tagged, not-yet-completed overlay → `window.__notifyAnimationDone(inst.guid, false)`.
     Rationale: hang-prevention — the Rust node (num_anims=1) would otherwise never
     complete, since JS-side eviction has no Rust-side truncation mirror. `success=false`
     is by analogy to the exit-world drain (acclient.c:329940-329947); see §6 OQ-2.
- **wasm-rebuild: NO** (calls degrade to no-ops on a v2 pkg via the typeof guard).

---

## 4. Test plan

### Headless-now (buildbox, no 1070)

Rust (`cargo test -p holtburger-core` — W2 wave owns running it; tests are staged with the
source):
- `system/tests.rs`: `notify_animation_done` with a seeded queue
  (`motion_table_manager` accessed via a `#[cfg(test)]` helper or by seeding through
  `queue_object_motion`) pops exactly one 1-anim node and the pump drains one
  `MotionDone` (pin against acclient.c:329873-329894 semantics, already unit-covered at the
  module level — this test covers the NEW system-level path + the flag gate).
- empty-queue no-op: `notify_animation_done(true)` on a fresh system leaves counter 0,
  emits nothing (acclient.c:329884 guard; motion_table_manager.rs:326-330 already pins the
  module level).
- flag-off inertness: with `USE_MOTION_TABLE_QUEUE = false` the method must not touch the
  queue (compile-time const — test documents intent).

Node (`apps/holtburger-web/`, `test_*.mjs` house pattern, e.g. test_script_manager.mjs):
- **`test_hook_windows.mjs`** — `planHookWindows` table tests: monotonic advance; LoopRepeat
  wrap (two windows); LoopOnce finishing between ticks fires `(lastTime, clipDuration]`
  exactly ONCE (second call with `drainedTo` applied returns zero windows); replay re-arm
  (lastTime reset to 0 → full range fires again); zero-duration clip → no windows.
- **`test_hook_fire_queue.mjs`** — order assertions on a synthetic queue: trailing hook
  records fire BEFORE the `animDone` record for the same overlay (acclient.c:340725 →
  :340764-340774 order); the drain runs once per entity tick after a marker representing
  pose application; a thrown hook does not drop the rest of the queue.
- `node --check` on entities.js, index.html inline script, hook_windows.js.

Post-rebuild wasm smoke (headless Playwright → 127.0.0.1:8765, `?nullRender=1` mandatory —
DESIGN.md §5 measurement-traps):
- `wasm_export_manifest_version() >= 3`; `typeof handle.notifyAnimationDone === "function"`;
  calling it pre-seed does not throw (empty-queue no-op end-to-end).

### 1070-gated (parked; Lane B)

- A5-P1: swing-end sound / door-closed thunk fire reliably (the A5 §3 row 3 intermittent
  drop disappears); no double-fire on spam-click replay.
- A4-Q2 (requires A3-D2 + `?interpRig` + flags on): spam-click swing shows queue truncation
  (no crossfade churn); emote completes then gait resumes; one-shot completion releases
  action state (the A3 §3 row 1 symptoms). These are the DESIGN amendment's listed
  1070 tests — they gate the DEFAULT-ON flip, not the landing.

---

## 5. Risks + rollback

1. **Rollback is total and per-stage**: `?hookDrain` off → legacy inline executor
   byte-identical; `?mtQueue` off → zero notify calls; `USE_MOTION_TABLE_QUEUE` off → queue
   inert even if notified (and `animation_done` additionally no-ops on empty queue). No
   default behavior changes anywhere in this spec.
2. **Counter poisoning** (the big one): a notify for an overlay that was never enqueued
   Rust-side bumps `animation_counter` and can pop a pending node early
   (acclient.c:329885-329894 is positional). Mitigations: the `_mtQueuedKeys` tagging
   contract (only pipeline-queued overlays notify); local-guid filter on BOTH sides (JS call
   gate + recv-arm `w.player.guid` check); counter reset on drain bounds any residual skew
   (motion_table_manager.rs:350-352 / acclient.c:329931-329936).
3. **Missed completion = hung node**: a tagged overlay evicted/stopped without notify leaves
   a num_anims=1 node pending forever (no retail-style truncation mirror). Mitigation: the
   Stage-D cancellation call sites; future A4-Q3 exit-world drain is the backstop for
   teleport/portal.
4. **Cross-boundary frame skew**: the notify rides the FIFO `cmd_tx` channel and is consumed
   relative to `TickMovement` in arrival order — completion may be pumped one tick after the
   visual clip end, vs retail's same-frame process_hooks (acclient.c:320035). Accepted
   (≤1 rAF, same class as existing channel commands); the 1070 eye-tests are the arbiter.
   See §6 OQ-5.
5. **Double-restore of base-cycle weight**: Stage B moves the `onFinished` restore into the
   queue executor under the flag — the listener and the queue path must be mutually
   exclusive (flag-checked at registration in `_suppressBaseCycleForOverlay`, :7647-7659).
6. **Hook-timing shift for all 26 hook types**: `?hookDrain=on` moves every animation hook
   from mid-tick-inline to end-of-instance-tick. Sounds/particles are timing-insensitive at
   ≤1-tick granularity; material/omega hooks now apply after the tween passes instead of
   before — watch for a one-frame visual difference in the 1070 spot-checks. Off by default.
7. **W2 drift**: every `motion_table_manager.rs` / `system.rs` cite above is WORKING-TREE
   (uncommitted) state. Before implementing, re-grep `animation_done|drain_events|
   USE_MOTION_TABLE_QUEUE|motion_table_manager` and re-pin line numbers against the landed
   W2 commits.
8. **entities.js serialization** (ROADMAP §3): this change-set shares entities.js with
   A11-S2 and A15 W3 items — serialize within the wave; A5-P1 + A4-Q2 land as ONE PR-sized
   change-set, not two.

---

## 6. OPEN QUESTIONS

1. **Baked hookType-4 ("AnimationDone") frame hooks** (entities.js:10278-10294): retail's
   completion signal is the SEQUENCE-queued `anim_done_hook` singleton on segment exhaustion
   (acclient.c:340764-340774), not an authored frame hook — but IF authored type-4 hooks
   exist in DAT AnimFrames and retail routes them through `AnimDoneHook::Execute`
   (:342336), they would ALSO bump the counter (double-count vs our convention). I could not
   establish from acclient.c whether the UnPackHook factory produces type-4 instances
   (factory decl :7070 only; per-type Execute bodies not censused — same bounded-effort gap
   as A5 §6). DECISION FOR IMPLEMENTER: keep type-4 OUT of the notify path (plugin-event
   only, as today) until a DAT census proves otherwise.
2. **Cancellation `success` value**: Stage D uses `false` by analogy to `HandleExitWorld`'s
   success=0 drain (acclient.c:329940-329947). Retail's renderer path literally cannot
   express "anim interrupted" (interruption goes through Rust-side truncation, which zeroes
   num_anims and completes with success=1 via the poll, acclient.c:329842-329870 +
   :329960-329980). Once the outbound RemoveLinkAnimations wiring exists (OQ-3) the
   cancellation notify may become wrong-shaped; revisit at A3-D2 time.
3. **Outbound renderer wiring for `MotionTableEvent::RemoveLinkAnimations` /
   `RemoveAllLinkAnimations`** (motion_table_manager.rs:74-83 assigns it to "A4-Q2"): this
   spec deliberately CUTS it. There is no Rust→JS event surface for it yet, no enqueue
   source until A3-D2, and the right transport (poll export à la `pollMotionActions`
   lib.rs:30125 vs the entity-update channel) should be decided together with Stage-2's
   `localInterpretedMotion` export (DESIGN.md Stage 2 files list). Needs a ruling at A3-D2
   spec time; until then truncation simply lets the JS overlay finish visually while the
   Rust node completes via the poll — cosmetic-only divergence under spam.
4. **three.js `finished` intra-`mixer.update` dispatch timing** (A5 §6): unverified against
   the library; moot when both flags are on (completion detection moves to the drain pass),
   relevant only for the `?mtQueue=on`+`?hookDrain=off` fallback listener.
5. **rAF ordering of the `TickMovement` send vs `entityManager.tick` (loop.js:1564)**:
   determines whether a notify is pumped same-frame or next-frame. Not pinned this session;
   either is within the accepted ≤1-tick skew (risk 4), but the implementer should verify
   and document the actual order in the recv-arm comment.
6. **`w.player.guid` as the recv-arm local-guid source**: `WorldState.player.guid` exists
   (test usage lib.rs:13348), but the exact accessor shape in the recv arm
   (`w.player.guid.0` vs a helper) is an implementation detail to confirm in situ.
