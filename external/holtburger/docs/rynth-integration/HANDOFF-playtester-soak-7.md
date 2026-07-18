# Handoff — playtester soak, session 7 (verb surface closed + v6.4)

Continues `HANDOFF-playtester-soak-6.md`. That session's §2.2 verb-surface
audit and §3 candidates were the work list; this session implemented all of
it, launched v6.4, and root-caused the 10 pre-existing holtburger-core test
failures (appended, §5). Code is committed as `efaee754`.

## 1. What shipped (all suites green before launch)

1. **Verb-audit gaps 1–5 closed** (handoff-6 §2.2):
   - `rynth/webhost.js` wraps the previously-unwrapped wasm primitives:
     `useWithTarget` (UseWithTarget 0x0035), `moveItem`,
     `splitStackToContainer`, `mergeStacks`, `pendingConfirmations`,
     `sendConfirmationResponse`, `getObjectAppraisal` (JSON parse side of
     the session-6 `requestAppraisal` fix).
   - New LLM verbs (`rynth/ai/tools/world.js`, economy.js for stacks):
     `appraise` (fresh-identify wait via GetLastIdTime, compact snapshot
     render, inventory-item fallback), `use_item_on` (keys/lockpicks/kits/
     tools), `open_container` (contents journaled, shared state),
     `take_item` now ALSO resolves the last-opened container's contents
     (the LLM container-loot path — TakeObject works on contained guids),
     `drop_item`, `confirm` (+ optional `which` text picker),
     `split_stack` / `merge_stacks` (wcid-checked). 32 → 41 action types.
   - Pending server confirm dialogs render as the LEADING observation line
     (observe_ext) — the `confirm` verb is not blind, and unanswered
     dialogs auto-decline server-side.
2. **Closed-door mid-route retry** (handoff-6 §3.3): a route-failed/timeout
   `router.follow` outcome now finds the nearest CLOSED door within 10m and
   re-follows the remaining legs once. Closed-ness is detectable client-side:
   ACE doors flip PhysicsState.Ethereal (0x4) while OPEN (Door.Open), so an
   open door is never re-used (which would shut it). Walk tags splice as
   `route-failed(w/N)+door(Name)+<retag>`.
3. **Event-driven early check-ins** (handoff-6 §3.4, carried 3 sessions):
   `director.requestEarlyCheck(reason)` (debounced: 45s min gap, no-op when
   a check is imminent/in-flight; hourly budget still applies) + bot.js
   wiring on push events — kind 33 portal-space (teleport), kind 29 death
   (self only — u32 is the victim guid), kind 2 chat cat 2 (tell) and cat
   10 (popup). `config.ai.earlyCheckins: false` to disable.
4. **Pose-cell §3.2 follow-ups** (Rust, agent-executed, read-verified):
   - Heartbeat VERIFIED CLEAN: both AutonomousPosition send sites build the
     pulse via `build_autonomous_position` → `local_player_runtime_pose()`
     at send time (common.rs:177); no cached begin-cell exists in the
     compose path. The session-6 caveat is closed.
   - Parity guard: `step_cell_transit_flips` (transition.rs:409) gained an
     indoor→indoor else-arm re-derive via `scene.current_cell` — the
     approximate pipeline is STILL LIVE as the faithful bridge's fallback
     when the begin cell has no physics BSP yet (the indoor pre-bake
     window, faithful_bridge.rs:976), and it pinned cells exactly like the
     pre-fix marshal. The named legacy chain (system.rs:5702) is
     compile-time dead (`unified_transition_enabled()` const-true) —
     documented in place, no dead code added.
   - Tests: `indoor_walk_prebake_fallback_rederives_envcell_low_word`
     (world, 549 green) and `indoor_manual_drive_heartbeats_rederived_envcell`
     (core, wire-boundary: the sent pulse carries the re-derived cell).
5. Suites: 19 AI + navsim 28 + indoorsim 22 + netbrain 22, all green
   (world 79, economy 39, director 67, observe_ext 61 — new coverage
   includes container-loot resolution, door-retry both arms, appraise
   fresh/cached/refused, confirm verbatim passthrough, split/merge bounds).
   Release wasm rebuilt (4.8MB — transition.rs is in the wasm dep tree).

## 2. The live run — v6.4

Runner: `/mnt/wbterminal2/holtburger-scratch/soak-v64/soak_run_v6_4.cjs`
(status/journal/scratchpad_persist/monitor alongside). Marker
`bot start (v6.4 verb-surface no-lore`. Same nemotron-3-ultra-550b, 1-min
cadence, maxActions 8, `knowledge: false`; scratchpad CARRIED OVER from
v6.3 (same character Brakis, memory intact — first plan explicitly avoided
the v6.3 BLOCKED entries). Monitor: `monitor_v64.sh` (event-driven: runner
death, FATAL/complete, leaving LB 0x8602, level-up, ticket/confirm/death/
early-checkin journal signals, AI errors ≥3).

### 2.1 First 21 minutes (run still in progress at handoff time)

The strongest opening of the series — every session-6/7 fix demonstrably
live:

- **Armor tutorial COMPLETED at t+8m** — the wall v6.2/v6.3 died on.
  Heard Samuel's quest dialogue, `take_item` route-walked to both ground
  pieces (`routed(4)`/`routed(8)`), picked them up (inv 12→13 in the shard
  status line), re-used Samuel → "You may now proceed to the Training
  Area."
- **Progressed academy**: Training Area door opened, Training Master used,
  cells streaming live the whole way (0x860201AD → ...B1 → ...23A →
  ...273 — pose fix holding under real play).
- **Self-care**: dropped to 1/5 HP (first kill logged, +13 XP), retreated,
  recovered to 5/5; separately ate Bread at 0% stamina (`use_item`).
  Deliberate kernel pause/resume around travel.
- Zero AI errors through 16 calls; one benign 404 console error.

### 2.2 Watch items from the live window

1. **"Central Courtyard" portal never zone-changes** — `use_object:ok`
   repeatedly, no teleport (also seen v6.3). The bot itself concluded
   "local portal, not the academy exit" and moved on. Ticket-worthy
   mismatch if it persists; ALSO possible it teleported once early (the
   cell DID change to 0x86020273) and later uses are legitimately same-area.
2. **`lvl=0` in the runner status line since the XP grant** (was lvl=1) —
   the world state is fine (XP/vitals correct); suspect the runner's raw
   `levelInfo[0]` read or a PlayerStatsSnapshot refresh gap. Runner-side
   read first; wasm second.
3. **route-failed(3/10) toward the far Treasure Chest** (0x7860205D, ~19m
   E, cross-landblock static) — indoor router won't cross the landblock
   seam (by design, indoorLegsTo bails cross-LB) and the door-retry found
   no closed door in reach. The bot then hallucinated "landblock 0x78602"
   from the GUID prefix and tried goto_lb — correctly refused by the
   indoor-cell guard. Static-object GUID ≠ cell id is a recurring model
   confusion; consider a one-line hint in the goto_lb refusal.
4. **open_container on that chest**: honest degrade ("no contents
   streamed (empty, out of range, or not a container)") — worked as
   designed, but confirms container verbs are still unproven at range.

## 3. Ops (carried)

Wait for ACE `dropped. Account: playtest_soak` + 15s before relaunch;
runner ignores SIGTERM — SIGKILL the exact node pid; ACE (UDP 9000/9001) +
serve.py :8765 + wsbridge :8080 + rynthnav :8767 up before boot; `?nosw=1`
mandatory after JS edits; playwright resolves via
`NODE_PATH=~/.npm/_npx/e41f203b7505f1fb/node_modules`. Release wasm check:
`ls -la pkg/*.wasm` (~4.8MB release, ~18MB = dev tax).

## 4. Next-session candidates

1. Read the v6.4 run to its end (status/journal/monitor files in
   soak-v64/): did it find the real exit (Jonathan token-give 0xA9B40019
   or walk-out portal 29338 at cell 0x0169)? Do the new verbs (appraise,
   open_container on a REAL chest, confirm, use_item_on) get exercised?
2. The §2.2 watch items: lvl=0 runner read; Central Courtyard portal
   verdict (world-DB ground it: does 0x78602052's destination differ from
   its location?); GUID-vs-cell hint in the goto_lb refusal.
3. Cross-landblock indoor routing (route-failed(3/10) to the chest): the
   indoor router deliberately bails cross-LB — either a hint verb-side
   ("walk via goto_object on something nearer") or stitch adjacent-LB
   EnvCell graphs.
4. Fix the 10 stale holtburger-core tests per §5 (mostly gate-aware
   branches; ONE fixture rebuild — write the replacement before deleting).
5. If v6.4 stalls in-academy again: handoff-6 §3.5's "hints tier"
   (world-DB grounded overlay only) remains the next escalation.

## 5. holtburger-core: the 10 pre-existing test failures (root-caused)

(Analysis by execution-verified bisect — suite green at `a7cfb75e~1`,
identical 10 failures at `a7cfb75e` and on master since. Fix sketches
included; nothing implemented this session.)


**Suite state on master @ efaee754:** `cargo test -p holtburger-core --lib` → 577 passed, **10 failed**, 1 ignored (~1s runtime). All 10 live in `crates/holtburger-core/src/client/movement/system/tests.rs`.

**Single origin commit, verified by execution (not just log-reading):** in a temporary worktree (`/mnt/wbterminal2/holtburger-scratch/core-bisect`, since removed) the suite is **421 passed / 0 failed at `1ed3bc44` (= a7cfb75e~1)** and fails with the **exact same 10 tests, same messages, same numeric values** (`Δy = -0.0000`, `y = 50.59822`) at:

> **a7cfb75e** (2026-06-16) — "holtburger: enable full unified pipeline (all movement consts on) + wave-h cache-bust"

That commit flipped 19 default-off movement/physics consts to `true` (`USE_MOVETO_DRIVER`, `USE_UNPACK_MOVEMENT_SEMANTICS`, `USE_MOTION_TABLE_QUEUE`, `USE_UNIFIED_TRANSITION`, `USE_PRECIPICE_SLIDE_REENTRY`, BSP narrow-phase, etc.) after a live eye-test, but never ran/updated the unit suite. Nothing after a7cfb75e fixed or worsened these tests — the failure set is byte-identical a month later. All 10 tests predate the flip (they were added 2026-06-12 in `f6065782` A14-I2, `9568fc0a` A3-D3, the A4/SA4F wave, and `eb391b24`). Doc comments still say "Default OFF" next to `= true` consts (e.g. `movement_manager.rs:31-41`), confirming the flip skipped the docs too.

**Overall verdict: (b) stale tests — behavior intentionally changed (validated default-ON flip), tests not updated.** No product regression found; one test (step-up) deserves a fixture rebuild rather than deletion. Note the suite already contains the correct house pattern: `notify_animation_done_respects_queue_flag` (tests.rs:4750-4788) was written gate-aware ("stays green when the const flips default-on") and passes — the 10 failures are exactly the tests that weren't written that way.

#### Failing tests and grouping

| # | Test (tests.rs line of failing assert) | Group |
|---|---|---|
| 1 | `test_precipice_slide_reentry_flag_is_default_off` (4236) | G1 flag-value pins |
| 2 | `test_movement_manager_registry_create_apply_prune` (4560) | G1 flag-value pins |
| 3 | `notify_animation_done_for_routes_local_gated_and_registry` (5780) | G2 gate-shield pins |
| 4 | `handle_exit_world_for_drains_registry_and_respects_gate` (5858) | G2 gate-shield pins |
| 5 | `held_manual_drive_survives_pursuit_end` (5423) | G3 pursuit same-tick arbitration |
| 6 | `cancel_pursuit_restores_held_manual_drive` (5578) | G3 |
| 7 | `pursuit_active_suppresses_manual_double_drive_and_idle_does_not_stomp` (5610) | G3 |
| 8 | `stop_command_cancels_pursuit_without_restore` (5531) | G3 |
| 9 | `unified_transition_spine_manual_collision_matrix` (4725) | G4 legacy-spine geometry pins |
| 10 | `step_up_within_step_height_climbs_riser_through_integrator` (4166) | G4 |

#### G1 — literal flag-value pins (2 tests) — stale tests

- `test_precipice_slide_reentry_flag_is_default_off` asserts `!USE_PRECIPICE_SLIDE_REENTRY` (tests.rs:4236-4240); the const is now `true` (`system.rs:320`, flipped in a7cfb75e).
- `test_movement_manager_registry_create_apply_prune` asserts the gated wrapper `apply_movement_world_events` is a **no-op** ("registry must not allocate", tests.rs:4552-4563) because `USE_UNPACK_MOVEMENT_SEMANTICS` was default-off; it's now `true` (`movement_manager.rs:41`), so the wrapper allocates a manager and the `is_none()` assert fails. The rest of the test (ungated lanes, prune) is still valid.

**Fix sketch:** precipice test → invert the assertion (pin default-ON, keep the `?`-flag escape documented) or delete; registry test → make the gate block gate-aware (`if USE_UNPACK_MOVEMENT_SEMANTICS { expect Some } else { expect None }`) per the tests.rs:4764 house pattern. Risk: none (test-only).

#### G2 — gate-shield pins on notify/exit-world routing (2 tests) — stale tests

Both seed a `num_anims=1` node on the system-level `MotionTableManager`, call the per-guid route (`notify_animation_done_for` / `handle_exit_world_for`), and assert the system node **survived** the "gated" local half so the `_ungated` seam can pop it later (tests.rs:5768-5790, 5845-5869). With `USE_MOTION_TABLE_QUEUE = true` (`system.rs:536`), the gated half is no longer a no-op: `notify_animation_done` forwards to the ungated body (`system.rs:6687-6691`) and `handle_exit_world_for` drains when `is_local && USE_MOTION_TABLE_QUEUE` (`system.rs:6772-6779`). The node is popped by the gated call, its event discarded by the test's own `drain_events()`, and the later ungated call finds an empty queue → assert fails.

**Fix sketch:** branch on `USE_MOTION_TABLE_QUEUE` exactly like `notify_animation_done_respects_queue_flag` (tests.rs:4750): flag-on → assert the gated route itself produced the `MotionDone` (success=true / success=false respectively) and the ungated re-drain is an empty no-op (the acclient.c:329884 head-null guard the tests already cite); flag-off → keep current asserts. Risk: none (test-only).

#### G3 — pursuit "held manual drive" arbitration (4 tests) — stale tests (const-off assumption baked into the fixture)

All four ingest `ManualHeld(forward)` and `PursueObject` back-to-back **with no driver frame between them** (helper `ingest_intent`, tests.rs:5355-5360; header comment 5341-5348 says outright: "Exercised through the `_ungated` seams **while both consts ship default-off**").

Mechanism of the break:
1. `ingest_drive_command` ManualSet arm: `if USE_MOVETO_DRIVER && non_idle { self.manual_moveto_cancel_pending = true; }` (`system.rs:2833-2835`). Pre-flip this never fired; post-flip every non-idle ManualHeld edge latches a pending moveto-cancel.
2. Pursuit install skips the held-manual **stash** when that pending is set: `if driver_enabled && !self.manual_moveto_cancel_pending && active_drive is Manual { active_drive = None }` (`system.rs:3431-3442`) → `held_manual_drive_survives_pursuit_end` fails at 5423 ("stashed off the active slot").
3. First `drive_local_moveto` frame consumes the pending and/or sees the still-active non-idle manual drive and cancels the fresh pursuit with 0x36 (`system.rs:3613`, `3628-3637`) → `cancel_pursuit_restores_held_manual_drive` fails at 5578 (`moveto_is_active` false), `pursuit_active_suppresses...` fails at 5610 (active drive stayed `Manual`, never `Autonomous`).
4. `stop_command_cancels_pursuit_without_restore`: by the time the explicit `Stop`'s Cancel runs, the pursuit is already dead (`was_active == false` in `apply_pending_pursuit_commands_inner`, `system.rs:3410-3420`) → no stop edge → fails at 5531.

This same-tick "raw manual input wins over a moveto" arbitration is **by design** and was written into the very commit that added these tests (`f6065782` added both the `!manual_moveto_cancel_pending` stash-skip and the S10 tests; the pending flag itself dates to `189e164b`). The comment at `system.rs:3423-3430` documents it, citing retail acclient.c:339240. In production the held-W-then-click flow still works: the W edge lands on an earlier tick, and any driver tick consumes the pending via the unconditional `std::mem::take` at `system.rs:3613` before the click's pursuit installs — so the stash path engages. The tests compress both edges into one tick with no driver frame, so post-flip they exercise the same-tick-manual-wins path instead of the stash path. The same-tick behavior itself is separately and correctly covered by `nonidle_manual_set_cancels_pursuit_and_takes_over` (passes).

**Fix sketch:** in the four tests, model the real tick boundary — after ingesting the pre-pursuit `ManualHeld`, insert one `let _ = movement.drive_local_moveto(now, &mut world);` (no manager exists yet; it only takes the pending and returns) before ingesting the pursue intent. Alternatively add a tiny `#[cfg(test)]` seam to clear `manual_moveto_cancel_pending`. Risk: low; re-run should show the stash → steer → restore chain green again since the underlying S10 machinery is untouched.

#### G4 — legacy-transition-spine geometry pins (2 tests) — stale tests (one with a fixture-rebuild caveat)

- `unified_transition_spine_manual_collision_matrix` (tests.rs:4684-4737) pins the **P2b bug** in its off arm: "flag-off, the spine walks straight through the wall" (assert 4725). The off arm uses the runtime setter `set_unified_transition(false)`, but the effective predicate is `USE_UNIFIED_TRANSITION || unified_transition_runtime` (`system.rs:2657-2658`) — with the const now `true` the off arm **cannot exist**. Both arms stop at the wall at y = 50.598 (= 51.0 face − 0.4 capsule radius), i.e. the product does exactly the right thing; only the pin-the-hole assertion is dead. **Fix:** drop the off-arm pin (keep the flag-on assertions), or if the off arm must stay testable, add a test-only forced-off override to `unified_transition_enabled`. Risk: none for the drop.
- `step_up_within_step_height_climbs_riser_through_integrator` (tests.rs:4133-4178, fixture `run_grounded_step_up_tick` 4048-4119): a synthetic indoor fixture built for the **legacy** manual-advance spine — lateral block from the cell-AABB inset, a free-floating riser triangle only over the destination strip. Post-flip, `advance_local_pose_for_manual_drive` routes through the unified pipeline (`system.rs:3981 if self.unified_transition_enabled()`), which on this synthetic geometry climbs Z onto the riser (the Z assert at 4154 passes) but takes zero lateral (Δy = −0.0000, assert 4166 fails). Its sibling `step_up_beyond_step_height_stays_blocked_through_integrator` still passes. Real step-up is not broken in the product: genuine curb/stair step-up was subsequently landed and live-validated through the FAITHFUL chain in `2f181a96` (2026-06-29, "Phase E1: faithful vertical-lip step-up, default-ON"), which supersedes what this test pins. **Fix:** rebuild the fixture for the unified path (block with real wall geometry that surfaces a normal / a proper EnvCell riser instead of the AABB-inset + floating triangle trick), or retire it in favor of an E1-path step-up test; as a stopgap, relax it to assert the Z-climb only. Risk: medium — this is the one group where the replacement test should be written before deleting, to keep step-up regression coverage.

#### Bisect method note

`git worktree add /mnt/wbterminal2/holtburger-scratch/core-bisect <sha>` + capped-build `cargo test -p holtburger-core --lib`. The worktree needed one shim: `external/chorizite` is not populated in a worktree, so `crates/holtburger-protocol/build.rs` can't find `protocol.xml`; symlinking the main tree's `Chorizite.ACProtocol` directory in fixes the build. Worktree removed afterwards (`git worktree remove --force`); main tree untouched.
