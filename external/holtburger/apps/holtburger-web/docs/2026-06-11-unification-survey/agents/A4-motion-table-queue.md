# A4 motion-table-queue — unification survey

Scope (per PROMPT §5/A4): the MotionTableManager queue + completion layer and the CMotionTable
selection algorithms it drives. Seam with A5: A4 owns queue/completion (pending_animations,
AnimationDone → MotionDone), A5 owns per-frame CSequence playback + hooks. Seam with A3: A3 owns
the CMotionInterp/MovementManager layer above; A4 flags where MotionDone must land there.

## 1. Retail map

Structs (acclient.h):

- `MotionState { style, substate, substate_mod, modifier_head, action_head, action_tail }` —
  acclient.h:31081-31089.
- `MotionTableManager { physics_obj, table, state, animation_counter,
  DLList<AnimNode> pending_animations }` — acclient.h:31097-31104. Each `AnimNode` carries
  `(motion, num_anims)` (seen as `node[1].dllist_next` = motion, `node[1].dllist_prev` =
  num_anims throughout the bodies).

Call order / responsibilities (acclient.c unless noted):

1. **Submission.** `MotionTableManager::PerformMovement` (acclient.c:330206) — type 2 →
   `CMotionTable::DoObjectMotion` then `add_to_queue(motion, num_anims)` (:330225-330228);
   type 4 → `StopObjectMotion` then `add_to_queue(0x41000003, …)` (:330235-330238); type 5 →
   `StopObjectCompletely` then `add_to_queue(0x41000003, …)` (:330243-330245). A disallowed
   motion returns 67 without queueing (:330231).
2. **Queue insert + coalescing.** `add_to_queue` (acclient.c:330149) allocates an AnimNode,
   appends, then `remove_redundant_links` (:330079): walks the tail backward and — for a
   substate-class (`0x40000000` and not `0x20000000`) or style-class (sign bit) entry that
   re-appears earlier in the queue — calls `truncate_animation_list` (:329842), which sums the
   `num_anims` of every node after the duplicate and calls `CSequence::remove_link_animations`
   to drop the not-yet-played transition anims. This is retail's anti-backlog under input spam.
3. **Initialization.** `initialize_state` (acclient.c:330172) — `CMotionTable::SetDefaultState`
   then queues a node for `0x41000003` (Ready) with the returned `num_anims` (:330185-330200),
   so even the default state completes through the queue.
4. **Completion, event-driven.** Anim-done hook: `AnimDoneHook::Execute` (acclient.c:342336) →
   `CPhysicsObj::Hook_AnimDone` (:317087) → `CPartArray::AnimationDone` (:325080) →
   `MotionTableManager::AnimationDone(success)` (:329873): increments `animation_counter`, then
   pops every head node whose `num_anims <= animation_counter`; for each pop, if the motion has
   the action bit `0x10000000` it calls `MotionState::remove_action_head(&this->state)`
   (:329892-329893), then fires `CPhysicsObj::MotionDone(motion, success)` (:329894) and
   decrements the counter by the node's num_anims. Counter resets to 0 when the queue drains
   (:329933-329936).
5. **Completion, polled.** `MotionTableManager::UseTime` is a tailcall to
   `CheckForCompletedMotions` (BN pseudo-C acclient_2013.bndb_pseudo_c.txt:290845-290850),
   reached per-frame via `CPhysicsObj::update_object_internal` → `CPartArray::HandleMovement`
   (acclient.c:322882 → :325106-325112). `CheckForCompletedMotions` (:329960) pops only
   zero-anim head nodes (`num_anims == 0`) and fires `MotionDone(motion, success=1)` — this is
   how anim-free motions (modifiers, instant stops) complete. It is ALSO called synchronously
   after every `CMotionInterp::PerformMovement` arm (DoMotion/DoInterpretedMotion/StopMotion/
   StopInterpretedMotion/StopCompletely → `CPhysicsObj::CheckForCompletedMotions`,
   acclient.c:344684-344704), so a no-anim motion completes the same call it was issued.
6. **MotionDone fan-out.** `CPhysicsObj::MotionDone` (acclient.c:317097) →
   `MovementManager::MotionDone` (:339349) → `CMotionInterp::MotionDone` (A3's layer — this is
   where one-shot completion re-enters movement interpretation).
7. **World transitions.** `HandleExitWorld` (acclient.c:329940) drains the queue with
   `AnimationDone(success=0)`; `HandleEnterWorld` (:329949) additionally calls
   `CSequence::remove_all_link_animations` first — pending one-shots are cancelled, not played,
   across enter/exit-world (teleport/portal).
8. **Selection algorithms (CMotionTable).** `GetObjectSequence` (acclient.c:337641) — style/
   substate resolution with `style_defaults` lookup and early-exit when motion == default
   substate at speed 0 (:337696-337701); `get_link` (:337585) — two-hop lookup: exact
   `(style<<16 | substate)` table then the `style_defaults` bridge fallback (:337616-337636);
   `is_allowed` (:337560) — `bitfield & 2` restricts a motion to firing only from the style's
   default substate; `re_modify` (:337286) — after a sequence swap, pops every held modifier
   and re-issues it through `GetObjectSequence` so held modifier physics persists.

## 2. Ours map

| concern | Rust | JS (scene3d) |
|---|---|---|
| MotionTable DAT model (cycles/links/modifiers/style_defaults) | `crates/holtburger-dat/src/file_type/motion_table.rs:19-56` (fields), `:80` `motion_data_for_cycle`, `:156` `motion_data_for_link`, `:243` `is_allowed_gate` (accessor only) | — |
| Sequence selection (GetObjectSequence replacement) | baked concatenated frames per `(setup, mtable, cmd, stance)` (`build_concatenated_motion_frames`, referenced animation.js:609) | `AnimationCache.get` keyed `setupId:mtableId:motionCommand:stance` — `apps/holtburger-web/scene3d/animation.js:377-378,455-472` |
| Motion → rig dispatch | `expand_motion_command_low16` gate — `crates/holtburger-world/src/player/types.rs:100-155`; `newest_action_command` + `is_action_motion_command` — `crates/holtburger-world/src/entity.rs:107-139,169-201` | `classifyMotionCommand` — `entities.js:1419`; `setMotion` — `entities.js:5768` (Stop→Ready substitution `:5786-5791`) |
| One-shot ("pending animation") execution | none — no queue type exists (grep `pending_anim|AnimationDone|MotionDone` over crates/: 0 hits) | three.js LoopOnce overlay per action — `_tryPlayLink` `entities.js:7341-7420`; spam replay = `action.reset()`, no queue |
| Multi-action FIFO (closest thing to pending_animations) | `MOTION_ACTIONS` thread-local Vec + `pollMotionActions` — `apps/holtburger-web/src/lib.rs:29775-29807`, default-OFF `?multiAction=on` | drained by `drainMotionActions` — `loop.js:230`, called in tick `loop.js:1549` |
| Stage-1 interpreted action FIFO | `InterpretedState.actions: VecDeque<PendingAction>` — `crates/holtburger-core/src/client/movement/interp_state.rs:30-51,86-90` — `#[allow(dead_code)]`, "drained by stage 2's PerformMovement" (not landed) | — |
| Completion signal | none | three.js mixer `finished` events, used only for local overlay bookkeeping (base-cycle weight restore `entities.js:7504-7516`); nothing notifies Rust |
| server_action_stamp dedup | `MOTION_ACTION_STAMPS` 15-bit wrap compare — `lib.rs:29786-29796`; `is_newer_u16` in `entity.rs:107-118` | stamp-dedup consumed at play sites |
| Modifiers / re_modify | `MotionPhysics` + `MotionModifierStack::combined_onto` — `crates/holtburger-world/src/state/self_movement.rs:137-216` — built, NOT wired ("Path B deferred", `motion_table.rs:24-52`) | Path A heading-ease substitute (`motion_table.rs:42-49` note; entities.js setPose/tick) |
| Enter/exit-world drain | none | `mixer.stopAllAction()` only on dispose — `entities.js:1963`; teleport snap path does not cancel overlays (`entities.js:8740` region handles pose only) |

Ownership answer to the brief's key question: **nobody owns a pending-animation queue.** The
"pending one-shot motion" concept exists in three disconnected places — (a) per-entity three.js
overlay actions in entities.js, (b) the default-off `MOTION_ACTIONS` FIFO in lib.rs, (c) the
dead-code Stage-1 `InterpretedState.actions` VecDeque — and none of them has completion
accounting or a MotionDone consumer.

## 3. Divergences

| # | behavior | retail cite | our cite(s) | class | symptom | tracked? |
|---|---|---|---|---|---|---|
| 1 | pending-animation queue with `num_anims` accounting (`AnimNode` list, `animation_counter`) | acclient.h:31097-31104; acclient.c:330149 (add_to_queue) | no equivalent (grep `pending_anim` crates/ + scene3d/: 0); closest: lib.rs:29775-29807 (default-off FIFO), entities.js:7341 (overlay) | MISSING | one-shots have no ordered completion; concurrent/queued motions race on mixer weights instead of completing in order | untracked |
| 2 | AnimationDone → MotionDone fan-out (anim end re-enters movement interp; `0x10000000` actions pop `remove_action_head`) | acclient.c:342336 → 317087 → 325080 → 329873-329894 → 317097 → 339349 | mixer `finished` used only for overlay weight restore, entities.js:7504-7516; no Rust notification path (grep `MotionDone` crates/: 0) | MISSING | Stage-1 action FIFO (interp_state.rs:50) is write-only dead code — nothing can ever pop it; completion never reaches motion-interp/MoveTo layers | untracked (DESIGN.md Stage 2/3 do NOT spec it; see §6) |
| 3 | per-frame + post-PerformMovement zero-anim completion (`CheckForCompletedMotions`) | bndb_pseudo_c.txt:290845-290850 (UseTime tailcall); acclient.c:329960, :344684-344704 | no equivalent; loop.js tick has no completion poll (loop.js:1543-1553 block) | MISSING | anim-free motions (instant stops, modifiers) would never complete under any future queue; today masked by divergence #1 | untracked |
| 4 | queue coalescing under spam (`remove_redundant_links` → `truncate_animation_list` → `remove_link_animations`) | acclient.c:330079, :329842 | spam replay = `action.reset()` on the same overlay, entities.js:7392-7398 region | MISSING | no anim-backlog control; rapid stance/motion flips can stack crossfades instead of truncating unplayed transitions | untracked |
| 5 | Stop/StopCompletely queue a Ready (`0x41000003`) completion node; default state completes through the queue (`initialize_state`) | acclient.c:330235-330245, :330172-330200 | JS substitutes Stop→Ready cmd 0x0003 for display only, entities.js:5786-5791 | DIFF-ALGO | visually convergent, but stop completion is unobservable (no MotionDone), so "did the stop finish" can't gate anything | untracked |
| 6 | `get_link` two-hop with `style_defaults` bridge for cross-style transitions | acclient.c:337585, :337616-337636 | `motion_data_for_link` single lookup, motion_table.rs:156; bare low-16 0x0003 can't match full 0x41000003 inner key | DIFF-ALGO | draw/sheathe & cross-style transitions hard-cut (no authored flourish) | C2 (motion-dispatch doc §4) |
| 7 | `re_modify` re-applies held modifiers across a sequence swap | acclient.c:337286 | modeled but unwired: self_movement.rs:206-216 (`combined_onto`), deferral note motion_table.rs:24-52 | MISSING (runtime) | held turn/strafe physics would not persist across a base-cycle swap once Stage 2 drives the rig from interpreted state | DESIGN.md §1 (listed as available) + Stage 2 scope; deep-dive T9 |
| 8 | `is_allowed` (`bitfield & 2`) gates motion start to the style's default substate | acclient.c:337560-337577 | accessor exists (`is_allowed_gate`, motion_table.rs:243) but zero consumers (grep `is_allowed_gate` outside motion_table.rs: 0) | MISSING (runtime) | restricted motions can be issued from a wrong substate (would mis-play where retail refuses, returns 67) | deep-dive T7 (accessor landed; consumer untracked) |
| 9 | enter/exit-world drains pending queue with success=0 + removes link anims | acclient.c:329940-329957 | teleport/portal path does not cancel one-shot overlays; `stopAllAction` only at dispose entities.js:1963 | MISSING | emote/swing overlay keeps playing across a teleport/portal transit | untracked |
| 10 | one motion dispatcher (queue entry decided by CMotionTable presence) | acclient.c:330206 + 337641 | two hand-synced allow-lists: player/types.rs:100-155 (Rust) + entities.js:1419 (JS), plus 2 default-off side-channels lib.rs:29775-29856 | SPLIT-BRAIN (4 sites) | ~90 of ~190 MotionCommands drop (emotes, portals, offhand melee) | C3 / Stages 1-3, motion-dispatch doc §5; memory `motion-dispatch coverage 2026-06-09` |
| 11 | `server_action_stamp` 15-bit wrap-compare dedup of replayed actions | acclient.c:344388-344418 | lib.rs:29786-29796 (`MOTION_ACTION_STAMPS`), entity.rs:107-118 (`is_newer_u16`) | PARITY | — | shipped (Wave 2 2026-06-08) |

Non-parity divergences: 10.

## 4. Staged unification plan

New module: `crates/holtburger-core/src/client/movement/motion_table_manager.rs` — a literal
port of the retail queue: `AnimNode { motion: u32, num_anims: u32 }`, `animation_counter`,
`pending_animations: VecDeque<AnimNode>`, `add_to_queue`, `remove_redundant_links`,
`truncate_animation_list`, `animation_done(success)`, `check_for_completed_motions`, and a
`MotionDone(motion, success)` callback enum routed to the movement system (A3's
CMotionInterp-equivalent). This extends the existing `movement/` system (DESIGN.md §1
principle), it is not a parallel one.

- **Stage Q1 — queue core, headless (wasm-rebuild).** Scope: the struct + add_to_queue/
  remove_redundant_links/truncate semantics + check_for_completed_motions, consuming the
  existing dead-code `InterpretedState.actions` FIFO (interp_state.rs:50) as the action source;
  divergences #1, #3, #4, #5, #8 (wire `is_allowed_gate` at the DoObjectMotion-equivalent
  entry). Files: new `motion_table_manager.rs`; `movement/system.rs` tick calls
  `check_for_completed_motions` after drive ingestion (mirroring acclient.c:344684 ordering).
  Flag: Rust const `USE_MOTION_TABLE_QUEUE` default-off (Stage-1 style). Tests: headless-now —
  Rust table tests mirroring retail order (queue order, num_anims pop, counter reset, redundant
  substate truncation, zero-anim immediate completion, Stop queues 0x41000003). Rollback: flag
  off (queue inert, current paths untouched).
- **Stage Q2 — AnimationDone wiring from the renderer (wasm-rebuild + JS-live, manifest bump).**
  Scope: divergence #2. New wasm export `notifyAnimationDone(guid, success)`; JS calls it from
  the mixer `finished` listener for LoopOnce overlays (entities.js `_tryPlayLink` play site) and
  on overlay eviction; `MotionDone` fan-out pops the action FIFO (`remove_action_head`
  semantics: only `0x10000000`-flagged motions). Flag: URL `?mtQueue=` (url-flags.md style)
  gating the JS call; Rust side stays behind `USE_MOTION_TABLE_QUEUE`. Tests: headless-now —
  node --check + a wasm-API smoke that done-notification pops exactly one node; 1070-gated —
  spam-click swing shows truncation (no crossfade churn), emote completes then gait resumes.
  Rollback: flag off.
- **Stage Q3 — enter/exit-world drain (JS-live + Rust).** Scope: divergence #9. On teleport/
  portal/exit-world: Rust `handle_exit_world` (drain queue, success=0) + JS stops one-shot
  overlay actions for that entity (NOT the base cycle). Files: `motion_table_manager.rs`,
  entities.js teleport-snap path (entities.js:8740 region), loop.js portal transit hook.
  Tests: 1070-gated (visual: no swing carried through a portal). Rollback: same flags.
- **Stage Q4 — selection-algorithm completion (shared with A3/A5 seam).** Scope: divergences
  #6, #7. `get_link` two-hop + `style_defaults` bridge in `motion_data_for_link`
  (motion_table.rs:156) — subsumes C2; wire `MotionModifierStack` re_modify at the
  sequence-swap point that DESIGN.md Stage 2 `motion_sequence.rs` introduces. Explicitly
  sequenced AFTER movement DESIGN Stage 2 lands (it owns motion_sequence.rs); A4 contributes
  the resolver + queue hooks only. Tests: headless-now Rust link-resolution table tests.

Coordination note for A16: Stage Q2's JS half touches `entities.js` (overlay play/finish sites)
— same file as A5's playback work and A9's setup work; serialize. Stage Q1/Q2 Rust touches
`movement/system.rs` — same file as A3's Stage 2/3; the queue is the missing consumer DESIGN.md
Stage 2 assumes ("drained by stage 2's PerformMovement", interp_state.rs:31) but never specs —
A3 should fold Q1/Q2 into the DESIGN delta rather than spec it twice.

## 5. Scores

- Leverage: subsumes **C2** (get_link transition absent) outright; provides the dedup/ordering
  substrate that fixes the **C1** CMT remote-swing double-play key mismatch (queue key replaces
  `currentActionKey` string-prefix guards); is the prerequisite the motion-dispatch doc's
  **Stage 3 / Wave 6** dispatcher and **DESIGN.md Stage 2** action-FIFO drain both silently
  assume. Backlog IDs subsumed/unblocked: `C1` (partial), `C2`, dispatch `Wave 4` items
  (get_link chained resolver), DESIGN.md Stage-2 action-FIFO consumer.
- Regression-risk reduction: **H** — replaces mixer-weight races and string-key guards with one
  ordered completion model; every future one-shot fix lands in one module.
- Implementation risk: **M** — Q1 is a faithful small port with strong headless testability;
  Q2 crosses the wasm boundary (manifest bump) and touches the hot overlay path.
- 1070-dependency: **Y** for Q2/Q3 eye-tests (queue-order and portal-cancel are visual);
  Q1/Q4 verify headless.
- Depends-on: movement **Stage 1 eye-test PASS** (queue pops feed motion-interp state that
  Stage 1 owns); **A3** (MotionDone consumer lives in its layer; DESIGN delta must absorb Q1/Q2);
  **A5** (who owns the playback clock determines where `finished` fires); motion-dispatch
  Stage 1-3 (classification decides what enters the queue).

## 6. SPECULATIVE / UNRESOLVED

- **DESIGN.md Stage 2 omission (single-sided by nature, flagged for A3):** DESIGN.md:80-87
  scope-gates `motion_sequence.rs` to a "minimal GetObjectSequence-shaped output … NOT the full
  CMotionTable port" and Stage 2 (:312-355) drives the rig from interpreted state — but neither
  Stage 2 nor Stage 3 (:355+) mentions `pending_animations`, `AnimationDone`, or `MotionDone`
  (grep over DESIGN.md: only the §0 diagram line :13 names MotionTableManager). I read this as
  "the completion layer is unowned in current plans," but it is a plan-gap claim, not a
  dual-cited behavior divergence — A3 should confirm in its DESIGN delta.
- **Where retail fires the AnimDoneHook within the frame** (before vs after
  `CPartArray::HandleMovement`) — A5's seam; I did not chase `CSequence::update_internal` hook
  execution order. Patterns tried: `grep -n "AnimDoneHook" acclient.c` (Execute site only),
  `grep "add_anim_hook"` (not pursued past 15-min budget).
- **`num_anims` provenance on our side:** retail gets it from
  `DoObjectMotion`/`StopObjectMotion` out-params (acclient.c:330225-330245); our baked-clip path
  concatenates frames in Rust (animation.js:609 comment, `build_concatenated_motion_frames`) and
  may not preserve a per-motion anim count. If the bake flattens N link anims into one clip,
  Q1's `num_anims` should be 1 per queued motion and the truncation semantics still hold — but I
  could not verify the bake's internal anim-count bookkeeping without reading holtburger-dat's
  bake path (out of A4 scope). Patterns tried: `grep -rn build_concatenated_motion_frames
  crates/` (found in animation comments; body not read).
- **Leads from roster not confirmed:** "M1–M4 staged fixes" — the 2026-06-09 motion-dispatch doc
  uses A*/B*/C*/Wave-N IDs, not M1–M4; I found no M-numbered motion items
  (`grep -n "M1\|M2\|M3\|M4" ~/out/holtburger-motion-dispatch-coverage-2026-06-09.md` — no
  such IDs). Treated as a memory mislabel of that doc's wave plan.
