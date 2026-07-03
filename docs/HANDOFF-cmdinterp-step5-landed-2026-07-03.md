# HANDOFF — cmdInterp STEP 5 LANDED (all code items); A/B half-run — finish arms b-cast/c + the 1070 batch, then the default flip (2026-07-03)

Session 4 of the movement-port arc. Executed the step-5 work order from
`docs/HANDOFF-cmdinterp-wave1-landing-2026-07-03.md` — **all code items are
DONE, committed, pushed** (7 commits on master, every commit at the
regression floor). The live A/B is HALF-RUN: arm (a) bare floor PASSED, arm
(b) smoke PASSED (and caught+fixed one real bug), the remaining local legs +
the batched 1070 session + the default flip are the next work order. The
wasm `--release` rebuild WITH the 5.7 fix is DONE and in place
(`pkg/holtburger_web_bg.wasm` = 4,700,781 bytes, release+opt) — live tests
can start immediately; see "resume exactly here".

## Commits (this session, oldest first)

| Commit | What |
|---|---|
| `2a030cf8` | 5.1 flag migration: `honor_autonomy_latch`/`slidecast_persist` interpreter configs (both default ON), seeded at construction from the `?castMove`/`?slideCast` carriers (URL aliases); honor-gated control mirror + `!honor` leash-drop; stomp arm consults the interpreter config flag-on. +3 tests |
| `114d3a28` | 5.2 send ownership (row 9): seam `send_move_to_state` queues the composed drive; tick flushes through **M1 over `RawState::from_motion_state`** (decision: option **(b)** — one state truth, wire ≡ pose; option (a) live-lattice raw_state = post-flip endpoint). `note_server_motion_sent` makes the tick's edge-detector self-dedupe — one sender per edge, zero new suppression state. Heartbeat STAYS with the tick (PLAN row 9). `motion_state_pulses_sent` counter pins it. +1 test |
| `296f5f98` | 5.3 UseTime pump: per-tick after ingestion, before the send flush; only pumps an already-constructed interpreter. `player_is_moving_to` real (registry moveto + projection). `player_motions_pending` = **conservative composite** (projection ‖ interpolating ‖ latch-LOW) — reclaim fires ONLY on pure control grabs, never mid-cast (see "deliberate scope cuts"). Retail cadence: reclaim sends nothing (pinned). +2 tests; lane-test FU-C arm now stamps the wire latch like every real grab |
| `59ca05d5` | 5.4 jump lane (row 8): seams get `now`; `commence_jump`→`jump_charge_commence`, `do_jump(true)`→queued `execute_jump_release` flush, `finish_jump`→`jump_charge_abort` (all on the ONE parity clock). JS: space=0x31 in `CMD_INTERP_ACTIONS`, legacy space paths gated off under the flag, charge-bar UI carries over. +1 test |
| `7639f8cd` | 5.5 event stream (rows 12-13): interpreter `effects` ledger (`ForwardSlotEvicted` @HNFM, `ControlReclaimed` @TakeControl flip) → system `CmdInterpEvent` (pub, re-exported to the wasm crate) → **ClientEvent kind 61** (1=evict, 2=reclaim, 3=DriveApplied w/ packed axes) + jump refusals on the EXISTING kind-56 toast. index.html kind-61 arm restores the anim-break cut (same F8-4 busy-window + castMove gate), setSidestepLayer + W3.1 forward clip from DriveApplied, and `window.__cmdInterpReclaims` (the ADJ-15 Q3 counter). +1 test |
| `9c5b1fbb` | 5.6 cleanups: ADJ-10 — `execute_jump_release` gates → `MotionInterp::jump_is_allowed` (codes byte-identical: 36/71/head/72; p13 pins hold); module-level `#![allow(dead_code)]` narrowed to six tagged per-item allows (everything else in the interpreter is LIVE) |
| `8e08e00b` | 5.7 **live-smoke fix**: a bare Shift/HoldRun edge dispatches no motion, so the seam session ended `dispatched=false` and the walk gait was DROPPED (Shift+W ran at Run gait, 14.96 m/1.2 s, found by the A/B). `minterp_set_hold_run` now marks the session dispatched (retail :716995 applies immediately). +1 test |

## Regression floor at HEAD (verified after every commit)

- `cargo test -p holtburger-core --lib` → **562 pass / 10 fail / 1 ignored**;
  failing-set md5 `693c4c01…` = the SAME pre-existing 10 (unchanged all session).
- `-p holtburger-world --lib` → 540/0. `-p holtburger-web --lib` → 125/1
  (pre-existing `tests_substitution::triangulate_…`).
- `node tests/rust_pose.test.cjs` (run from `apps/holtburger-web/`) → 13/0.
- `cargo check --target wasm32-unknown-unknown -p holtburger-web` → clean
  (no new warnings; the TickMovement drain is wasm-only code, native tests
  do NOT compile it — always run this check after touching it).
- `cargo check -p holtburger-core` → warning-free (the narrowed allows).

## Deliberate scope cuts (READ before "fixing")

- **`player_motions_pending` is a composite, not the retail queue.** The
  registry minterp's real `pending_motions` CANNOT drain in the web build —
  action-class nodes (num_anims=1) complete only via renderer AnimationDone,
  and the per-entity route is Stage-3 (`notify_animation_done` is system-level
  + `USE_MOTION_TABLE_QUEUE` default-off). Gating FU-A on it would wedge
  permanently after the first gesture; gating on nothing would let held-W
  fight through casts (kills the strafecast floor). The composite
  (`server_controlled_projection ‖ scene interpolating ‖ !last_move_was_autonomous`)
  means: **use_time reclaims fire only for PURE control grabs** (latch high,
  nothing server-authored). The full retail post-anim reclaim of held keys =
  a named follow-up: wire local AnimationDone → registry minterp
  `motions_pending`, then swap the seam to read it.
- **Retail sends nothing on a use_time reclaim** — we match that (the revival
  rides the tick edge-detector, which no-ops on an unchanged intent).
- **Option (a)** (drive the minterp `raw_state` through `apply_motion_u32`,
  M1 reads `inq_raw_motion_state` — SC-17's retail shape) is deferred to the
  post-flip cleanup wave; option (b) is byte-equivalent for the keyboard
  alphabet by the M1 parity property and keeps ONE state carrier through the
  first live validation.
- **DoMotion refusal toasts** (`display_movement_error`) still log-only
  (flag-on-only surface; kind-56 covers jump refusals; a kind for movement
  refusals is post-flip polish).

## A/B state (the half already run — local zero-GPU bot vs live ACE)

Recipe: chrome-devtools MCP page →
`http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&nullRender=1&renderOnDemand=1&netDrainHz=30&renderer=3d&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=%2BTester2&agent=1[&cmdInterp=on…]`
— Tester2 = parked god mage at LIGHT academy (A9B40016 spawn), knows 1708
(Wedding Bliss, 3 windups) + 85; self-cast via
`window.__sessionHandle.castTargetedSpell(guid, 1708)`; keys via
`document.dispatchEvent(new KeyboardEvent(...))`; pose via
`getLocalPlayerPose()` (call `.free()`); each leg = ONE continuous evaluate.

- **Arm (a) bare — PASS.** Held-strafe through the full 1708 chain: ~14.25 m,
  speeds 2.5-5.6 m/s, longest sub-0.25 m/s window = 1 sample (250 ms), 0
  console errors, casts confirmed real (10 PlayEffect, 225 motion packs).
  The floor did not move at HEAD.
- **Arm (b) smoke — PASS** (post-fix state): W 25.9 m/2.2 s, D strafe
  5.7 m/1.5 s, `__smiCallCount` delta **0** (rows 11/14 silenced — no
  double-drive), jump end-to-end (ACE log shows the god-vz launch;
  `UpdateObjectInternalServer failed transition` lines are routine vanilla-ACE
  DEBUG noise — the login itself emits one for a 0.005 m delta).
  Two finds: (1) the 5.7 hold_run gait drop — FIXED + committed;
  (2) `__bootState` flips to 'error' ~90 s after in-world under SwiftShader —
  the KNOWN scene-ready watchdog artifact (memory trap c), ignore it and gate
  legs on in-world/mesh-count.
- **NOT yet run:** arm (b) cast legs (strafecast parity + turn-tap reclaim
  count + SeqF silent cascade), arm (c) burst (`&slideCast=off`: slide dies
  at first stomp, ONE tap revives the whole pattern — `__cmdInterpReclaims`
  must tick), and the **batched 1070 session**.

## Resume exactly here

1. **Wasm rebuild: DONE** (release+opt, 4,700,781 bytes, includes the 5.7
   fix). Sanity before any live test anyway:
   `ls -la apps/holtburger-web/pkg/holtburger_web_bg.wasm` ≈ 4.7 MB
   (5.8 MB = pre-opt intermediate, ~18 MB = a `--dev` build → rebuild with
   `cd apps/holtburger-web && env PATH="$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin" capped-build wasm-pack build --target web --out-dir pkg --release`).
2. **Ghost clock:** ACE logged the last +Tester2 logout at 18:02:35 — any
   relogin ≥95 s after the LOGOUT line (`grep LOGOUT $ACERT/ACE_Log.txt | tail -1`).
   Ghost-wait ORDER: drop to about:blank FIRST, then wait, then login.
   (Footgun hit this session: an `until`-loop with an unset `START` var
   exits instantly — use `START=$(date +%s); until [ $(( $(date +%s) - START )) -ge 100 ]…`.)
3. **Local legs** (assertions inline in the session transcript, or re-derive):
   - b-cast: hold `a` 700 ms → cast 1708 → sample pose @250 ms for ~9 s →
     no dead window >2 samples; tap `e` at +2.5 s → `__cmdInterpReclaims`
     +1, slide continues; wrap `em.cancelCastSequence` to count row-12 cuts.
   - b-SeqF: hold d,q,s,w → cast → +1 s release w,s,q (SILENT cascade —
     slide on `d` must keep moving ≥1 m over the next 1.2 s) → press `e`
     (reclaim, counter+1) → press `s` (back owns the forward slot).
   - c-burst: hold `a` → cast → speed collapses <0.25 m/s within ~2 samples
     of the first stomp and STAYS dead → tap `e` at +2.5 s → speed >1 m/s
     within 2 samples + reclaim counted.
4. **1070 batch:** driver READY at
   `external/holtburger/apps/holtburger-web/harness/cmdinterp-1070.mjs`
   (deliberately untracked, same convention as the other 1070 harnesses in
   that dir; a job-tmp copy also exists at
   `~/.claude/jobs/333ff13e/tmp/cmdinterp-1070.mjs`). Facts it encodes: tunnels were ALREADY LIVE (`-L 9333` CDP + reverse **18765**→
   laptop 8765 — box-side URLs use `127.0.0.1:18765`, NOT 8765); playwright
   at `~/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core`;
   connectOverCDP, page.close() only, NEVER close the shared browser; GPU
   assert `UNMASKED_RENDERER` ~ "GTX 1070"; three arms with 100 s ghost
   sleeps between; screenshots + `verdict.json` →
   `~/.claude/jobs/333ff13e/tmp/ab1070/`. Run:
   `node ~/.claude/jobs/333ff13e/tmp/cmdinterp-1070.mjs` (laptop). READ the
   screenshots (they are the eye-test record): gesture visuals around the
   Q3 turn-tap, burst-arm dead/revive, charge bar. Q5 = the
   `motionIdsDuringCast` list in verdict.json.
5. **Default flip = its own commit, ONLY if all arms are green** (house
   default-ON bar): `USE_COMMAND_INTERPRETER=true`, update the
   `?cmdInterp` url-flags row (default flipped, `=off` escape documented),
   update this handoff. If the 1070 shows a visual regression the state
   checks missed, DON'T flip — file the observation and stop.

## Interpreter lane — the live surfaces (post-step-5 map)

`system.rs`: honor-gated control mirror + config seeding in
`ingest_key_edge`; `pump_cmd_interp_use_time` (tick, after ingestion);
row-9 flush (`pending_cmd_interp_sends` → M1 → `send_action` →
`note_server_motion_sent`); row-8 flush (`pending_cmd_interp_jump_release`
→ `execute_jump_release`); `cmd_interp_events`/`take_cmd_interp_events`;
seams: `now` field, live jump trio, `minterp_set_hold_run` marks dispatched,
real `player_is_moving_to`, composite `player_motions_pending`.
`command_interpreter.rs`: `honor_autonomy_latch`/`slidecast_persist`
configs, `effects` ledger, six tagged dead-code allows (lifecycle/M4/M7).
`handle.rs`: `take_cmd_interp_events`. Core re-export chain:
`CmdInterpEvent` movement/mod → client/mod → lib.
`apps/holtburger-web/src/lib.rs`: `CLIENT_EVENT_KIND_CMD_INTERP = 61` +
TickMovement drain. `index.html`: space=0x31 + legacy-space gating + G-7
guard + kind-61 consumer arm. `url-flags.md`: ?cmdInterp row rewritten;
?castMove/?slideCast alias notes.

## Traps hit this session (do not re-hit)

- **`git add -A` on the app dir swept in two pre-existing untracked 1070
  harness scripts** (`harness/diag-1070.mjs`, `perf-walk-1070.mjs`) — caught
  and split out via reset+recommit BEFORE push. They are STILL untracked on
  purpose; don't sweep them into unrelated commits.
- **Appending tests with `cat >>` invalidates a pending Edit** on the same
  file (mtime race) — order: Edit first, then append, or re-read.
- The **wasm TickMovement arm is `#[cfg(target_arch = "wasm32")]`** — native
  `cargo test -p holtburger-web` does NOT compile it; a type error there
  only surfaces in the wasm build. Always `cargo check --target
  wasm32-unknown-unknown -p holtburger-web` after touching the recv loop.
- MCP evaluate legs: the bot-lore rules held (one continuous evaluate per
  leg; `!ev.repeat`-safe synthetic KeyboardEvents on `document` reach the
  index.html listeners fine; call `.free()` on returned poses).

## Open questions carried forward

- ADJ-15 **Q3** (turn-tap visual eviction — now instrumented via
  `__cmdInterpReclaims` + kind-61 reclaim console lines + 1070 screenshots)
  and **Q5** (real gesture ids — `motionIdsDuringCast` in the 1070 verdict):
  both land with the 1070 batch.
- Full FU-A post-anim reclaim needs the AnimationDone → registry
  `motions_pending` route (Stage-3; see "deliberate scope cuts").
- Post-flip cleanup wave (NOT now): option (a) raw_state lattice, legacy
  lane deletion (merge_manual_edge + JS sig-diff), wire-side
  `lose_control_to_server` migration (the scene mirror carries it today),
  M3 emote ids, M4 mouse-look, M7 player-options store.
- P13 OQ-3 (charge-time 73/72 gate parity) — DESIGN.md's skip stands.
- The step-3 handoff's session-2 numbers (1.54 m/s strafe) predate the
  god-char speed state — current strafe ~4 m/s, forward run ~12 m/s;
  compare SHAPES (dead windows, continuity), not absolute speeds.
