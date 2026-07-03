# HANDOFF — cmdInterp POST-FLIP session 1: AnimationDone → registry `motions_pending` route LANDED (2026-07-03)

Session 5 of the movement-port arc. Executed **item 3 of the post-flip work
order** (`docs/HANDOFF-cmdinterp-step5-landed-2026-07-03.md`): the
AnimationDone → registry `motions_pending` route — "the one lever that makes
`use_time`'s FU-A fully retail." All commits at the regression floor; live
zero-GPU legs vs live ACE **ALL GREEN**: the queue rose 0→3→7 during a real
1708 cast chain and drained back to 0 on the shim clock (~2 s after the
cast-gesture node stamped), the slidecast floor held with ZERO dead samples,
the burst arm matched step 5 exactly, gait smoke matched 5.7, zero console
errors across all legs.

## What the investigation established (read before touching this area)

- **Nothing enqueued on the wire path before this session.** Our
  `move_to_interpreted_state` applied wire actions state-only
  (`apply_action` straight onto the interp FIFO — mislocating
  substate-class windups, which belong in the FORWARD slot, and leaking
  FIFO entries since nothing ever popped them) and skipped retail's
  `apply_interpreted_movement` re-issue entirely. So the registry
  minterp's `pending_motions` stayed EMPTY during casts — the step-5
  composite wasn't guarding a wedge-prone queue, it was guarding an
  empty one (gating on it would have let held-W fight through casts).
- **ACE cast wire shapes (ground truth from ~/ace-server source):** the
  cast RELEASE rides as the forward SUBSTATE
  (`new Motion(MotionStance.Magic, castGesture, speed)` →
  `SetForwardCommand`, `WorldObject_Networking.cs:1078-1095`); windups
  ride EITHER as sequential forward-substate packs (`EnqueueMotionMagic`,
  non-FastTick) OR as ONE pack with the gesture LIST as wire ACTIONS
  (`EnqueueMotionAction` → `MotionState.AddCommand`, FastTick). Both
  shapes are now handled. u32 classes: PowerUp windups = ACTION-class
  (`0x1000006F..78`, `0x1000012B..134`); MagicBlast..Pray + CastSpell =
  SUBSTATE-class (`0x4000002B..39`, `0x400000D3`).
- **Retail truth:** `CMotionInterp::move_to_interpreted_state`
  (acclient.c:344372-344426) stamps raw style, pre-reads the jump gate,
  copies movement, runs `apply_current_movement` (server-controlled arm →
  `apply_interpreted_movement` :344147 — re-issues style/forward/side/turn
  through `DoInterpretedMotion`, ENQUEUEING per axis), then replays
  newer-stamp actions through `DoInterpretedMotion` with speed + the
  autonomous bit. The re-issue params mask `0xFFFD37FF` CLEARS
  ModifyInterpretedState — the re-issue is enqueue/realize-only.
- **FU-A's control gate is separate:** `use_time` requires
  `controlled_by_server` (acclient.c:717595), and vanilla-ACE General
  cast stomps never raise the mirror (the step-5 FU-A-dormant finding).
  So this route does NOT change live cast feel by itself — it makes the
  wire-side control migration (menu item 5) SAFE: control transfer
  without a real queue would have reclaimed MID-cast and killed the
  strafecast floor.

## Commits (this session, oldest first)

| Commit | What |
|---|---|
| `e009d487` | **Route 1/2 — retail wire enqueue + completion-clock shim.** motion_interp: full retail `move_to_interpreted_state` body + `apply_interpreted_movement` port (deliberate cut: the AUTONOMOUS arm stays state-only — the cmdInterp keyboard lane owns realization, a re-issue would double-drive M1); `renderer_num_anims` gains the substate cast band. motion_table_manager: **completion-clock shim** (DOCUMENTED divergence, module doc): 1-anim nodes carry `RENDERER_DONE_FALLBACK_SECS = 2.0`; the tick-driven poll lazy-stamps the HEAD's deadline (serial heads = serial clocks) and completes it at expiry exactly as a renderer `AnimationDone(success=1)` would, `animation_counter` untouched; truncation voids the clock. Rationale: the `?mtQueue` JS notify lane is landed but DORMANT (no play site tags `mtQueued`) and `?nullRender` bots never play clips — without a clock the queue wedges every consumer. system tick: per-entity registry pump (retail per-object UseTime cadence). Gesture nodes carry `jump_error_code = 72`. +5 tests |
| `b651f755` | **Route 2/2 — seam swap.** `player_motions_pending` now reads the local registry minterp's REAL queue (acclient.c:343728); the step-5 latch proxy (`!last_move_was_autonomous`) is RETIRED (it kept FU-A dormant forever-until-tap after ANY server-authored motion). Directive carriers (projection window + pose interpolation) kept — our representations of retail's is_moving_to/TakeControl until the control migration. NEW BEHAVIOR pinned end-to-end: `cmd_interp_use_time_reclaims_after_gesture_node_drains` (stomp → gated → shim expiry → held-W revives through tick, NO tap). Edge-driven TakeControl stays un-gated (new pin). Lane-test FU-C arm updated to the retail grab shape (real gesture node, not a bare latch stamp). |
| `e206dfa4` | **`movementPendingMotionsDiag`** (diagnostics-only, RIDES v6 — no manifest bump, the A2-P2 precedent): per-tick atomic mirror of the local registry queue depth, free-fn export + curated `window.__hbWasm` namespace-rider. The live A/B assertion surface (cast stomp raises it, authored budget drains it) + future 1070 Q3 instrumentation. |
| (docs commit) | url-flags `?cmdInterp` row updated (use_time paragraph → the real queue + shim + diag); index.html `__hbWasm` diag namespace-rider; this handoff. |

## Regression floor at HEAD (verified after every commit)

- `cargo test -p holtburger-core --lib` → **568 pass / 10 fail / 1 ignored**;
  failing-set md5 `693c4c01…` = the SAME pre-existing 10 (verified by
  stash-baseline diff this session; +7 tests net).
- `-p holtburger-world --lib` → 540/0. `-p holtburger-web --lib` → 125/1
  (pre-existing `tests_substitution::triangulate_…`).
- `node tests/rust_pose.test.cjs` → 13/0.
- `cargo check --target wasm32-unknown-unknown -p holtburger-web` → no new
  warnings (the `builder.rs` dead-code + macro-context doc-comment ones are
  pre-existing).
- Release wasm rebuilt: **4,702,085 bytes** (release+opt, includes route +
  diag).

## Live legs vs live ACE (zero-GPU bot, throttle-immune driver)

Driver: `~/.claude/jobs/333ff13e/tmp/postflip-legs.mjs` (self-launched
chromium, the step-5 MCP-throttling fix); results JSON:
`~/.claude/jobs/333ff13e/tmp/postflip-legs.json`.

- **Leg 1 (bare flipped defaults — slidecast arm + queue dynamics): PASS.**
  `movementPendingMotionsDiag`: 0 idle, 0 while strafing (autonomous
  echoes never enqueue — the designed signature), rose 3→7 across the
  1708 cast tail, drained to 0 (`tailPend 0`); the 7→0 cliff landed
  ~1.8 s after the cluster stamped = the cast-gesture node's 2.0 s shim
  budget expiring, then the zero-anim backlog draining in the SAME poll
  (the exact mechanism, observed live). Slide CONTINUOUS through the
  whole chain: speeds 2.0-5.8 m/s, median 3.7, **longestDead 0**
  (step-5's arm-b had a 1-sample hitch — this run had none).
  `reclaimDelta 0` (FU-A dormant during ACE casts — unchanged, as
  documented). 0 console errors.
- **Leg 2 (gait smoke): PASS.** W-run 37.4 m @ 17 m/s (god char),
  Shift-walk 4.1 m @ 2.6 m/s — the 5.7 hold-run gait floor intact.
  (Reproduced twice across runs: 37.79/4.15 and 37.39/4.12.)
- **Leg 3 (burst arm, `?slideCast=off`): PASS.** Slide died at the first
  stomp and stayed dead (10/11 pre-tap samples <0.25 m/s), the mid-chain
  turn-tap revived it (0.6→3.9→4.1 m/s), the next stomp re-killed it
  (authentic burst); pends 0→3→7→0 same shape as leg 1; `reclaimDelta 0`;
  0 errors. Reproduced twice.
- **FINDING (for menu item 5): windup gestures enqueue NOTHING on this
  vanilla-ACE shape.** Non-FastTick ACE sends each windup as
  `EnqueueMotionMagic` with the POWERUP id in the FORWARD slot — but
  PowerUps are ACTION-class (`0x1000006F`), and our wire expander maps
  action-class-in-forward to `None` (only pure-`0x40` substates occupy
  the slot), so no node lands until the CAST-release pack (MagicBlast
  substate → the 1-anim node) + the restore churn. Behavior-neutral
  today (control never transfers during casts), but when item 5 lands,
  decide whether action-ids-as-forward should enqueue (retail expands
  them via command_ids and DoInterpretedMotion's action arm) so the
  FU-A gate also covers the windup phase, not just the release tail.
- **Cast legs REQUIRE a stance toggle first**: ACE rejects
  `HandleActionCastTargetedSpell` outside `CombatMode.Magic`
  (`Player_Magic.cs:84`, log.Warn "CombatMode mismatch") and fresh
  logins are NonCombat/Undef — the driver calls
  `window.__sessionHandle.toggleCombatMode()` + 1.8 s settle before
  casting. (Step-5's early 18:19/18:22 rejections in the ACE log were
  the same thing.)

## Deliberate scope cuts / divergences (READ before "fixing")

- **The completion-clock shim is NOT retail mechanism** (retail = renderer
  `AnimDoneHook`); it IS retail-equivalent timing (ACE's own
  `GetAnimationLength` pacing model). The named follow-up: resolve REAL
  authored lengths at the wasm ingest site (the machinery behind
  `lookupMotionLinkForSwing` + `build_concatenated_motion_frames` can
  compute exact clip durations) and/or land the per-entity renderer
  notify route (tag `mtQueued` plays; then real notifies win the race and
  the deadline becomes a pure backstop — the notify consumer must clear
  deadlines to avoid double-completion, flagged in the module doc).
- **2.0 s budget vs long emotes:** a 10 s dance node completes EARLY under
  the shim (early reclaim only matters under server control). Accepted
  until real lengths ride in.
- **The autonomous arm of `apply_current_movement_reissue` is state-only**
  (retail tailcalls `apply_interpreted_movement` there too) — the local
  autonomous lane realizes through the cmdInterp keyboard lane (M1 wire ≡
  pose single truth); a Rust re-issue would double-drive it.
- **Remote entities enqueue too now** (EntityMovementEvent → same retail
  body). Their queues drain on the same per-tick registry pump; no
  consumer reads them yet (Stage-3 remote drivers will).
- **`?mtQueue` JS lane stays dormant on purpose** — no play site tags
  `mtQueued`. Do NOT tag the cast-sequence lane naively: playCastSequence
  is UI-PREDICTED (not wire-driven), so its clip count/timing is not 1:1
  with wire enqueues; counter poisoning is the risk the tagging contract
  exists to prevent (entities.js:1210-1230).

## Post-flip work order — updated state (value order)

1. **Soak** — unchanged; `?cmdInterp=off` remains the instant escape.
2. **ADJ-8 ruling** (`?slideCast` default: modern continuous vs authentic
   burst) — STILL OPEN, needs the user's word. Ask them.
3. ~~AnimationDone → registry `motions_pending` route~~ — **DONE this
   session** (this handoff).
4. **Option (a) raw_state lattice** — unchanged (post-flip cleanup wave).
5. **Wire-side control migration** — NOW UNBLOCKED by item 3. Study
   `SmartBox::SetObjectMovement`'s control path in the decomp first
   (retail fixtures say General stomps SHOULD transfer control; vanilla-ACE
   wire says no). When it lands, FU-A becomes the FULL retail post-anim
   reclaim on live casts (today's tap-revive stays until then). Consider
   pairing with the real-authored-lengths follow-up so reclaim timing is
   exact.
6. **Legacy deletion wave** (after soak) — unchanged.
7. **Camera lane** — unchanged (confirm with the user before building).
8. **Smaller**: real authored lengths for the shim (named above), M3 emote
   ids, M4 mouse-look, M7 player-options store, movement-refusal toast
   kind, P13 OQ-3 golden replay.

## Traps hit this session (do not re-hit)

- **Bot boot gate: NEVER sample `__bootState === 'in-world'` alone** —
  the wire-agent boot fires `in-world` → `ready` within ~90 ms (Bug 11,
  index.html:9284-9332), so a polled gate misses it whenever the scene
  bake is warm. Scan `window.__bootStateHistory` for an `'in-world'`
  entry (the in-tree fix) — the first TWO leg runs burned ~20 min on
  this exact miss.
- **Ghost clock anchors on the LOGOUT *line*, not the page drop** — a
  closed headless browser's UDP session lingers until ACE's Network
  Timeout (~60 s), THEN the LOGOUT lands, THEN +95 s. A 100 s
  drop-to-login wait still hits "Account In Use" (which vanilla ACE
  resolves by dropping BOTH sessions). Use ~200 s between legs, or grep
  the LOGOUT line.
- **Casting needs `CombatMode.Magic`** (see the legs finding above) —
  `toggleCombatMode()` first or every cast is silently stance-rejected
  and the leg measures nothing.

- **`rg -rn` strikes again** — `-r n` = `--replace n`, mangles output. The
  memory §3 warning is real; plain `rg -n` always.
- **Editing a file with python/sed invalidates the Edit tool's read
  tracking** (the step-5 mtime-race trap, new variant): after any
  script-driven edit, Read the file again before the next Edit call.
- **`AnimNode` gained non-`Eq` fields** (f32 + Instant) — it's
  `PartialEq`-only now; tests construct via `AnimNode::new` (the ONE
  constructor deriving `anim_seconds`), never literals.
- **Truncation must void the shim clock** (`anim_seconds`/`done_deadline`
  → None) or node-vector equality tests break AND a zeroed node would
  carry a meaningless deadline.
- The three motion_table truncation tests fail if you forget the above —
  they compare full node vectors.

## Open questions carried forward

- ADJ-15 Q3/Q5 — unchanged (1070 batch or the user's play observations;
  `movementPendingMotionsDiag` is now available as extra instrumentation).
- ADJ-8 `?slideCast` default ruling — ask the user.
- Whether General cast stomps should transfer control (item 5) — decomp
  study before touching; this session's route is the prerequisite, landed.
