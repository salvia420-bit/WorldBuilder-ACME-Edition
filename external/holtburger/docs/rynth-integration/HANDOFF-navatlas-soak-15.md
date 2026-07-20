# HANDOFF — NavAtlas session (soak-15), 2026-07-18/19 — session closed mid-endgame

Executes `SPEC-navatlas-2026-07-18.md` (+ appendices A/B). Team: Fable lead
inline + Opus agent A (W1 coverage) + Opus agent B (W2 atlas) + Opus agent C
(pose-corruption bug, user-directed mid-session). All work is on
`origin/master` (pushed through `d8a15dba`); agent C's FINAL in-progress fix
is on branch `worktree-agent-afc51b6ce07a81635` (see PICKUP).

## State at close — one paragraph

W1, W2, W3 are COMPLETE, committed, pushed, all suites green. The one open
item is the tail of agent C's pose-corruption fix: root cause fully
identified (see below), first-round fix merged (`d8a15dba`) but proven
insufficient on the rig (heals only on inbound echoes an idle player never
gets), second-round fix (read-chokepoint heal) written + unit-tested on the
worktree branch, NOT yet merged/built/rig-verified. The Phase-2 soak
acceptance run is blocked ONLY on that fix landing; everything else
(full-map mesh live, atlas, director economy) is ready and waiting.

## What landed (all on origin/master)

**W1 — coverage (agent A):** `ee666b7e` corridor bake + loud fallback (goto
results carry `{coverage, estUnits, portalsUsed}`; `globalRouter.lastPlan`);
`302a92d5` retail water rule (ACE CalcCellWater port; 1.84M cells carved);
`6c2833e5` full-map bake + empty-ocean crash guard; `1d603935` spatial
leg-landblock assertion in `rynth_fullmap_verify.cjs`. LIVE sidecar :8767 =
38,689 obstacle-aware tiles (whole map), frozen Arwic repro mixed, spatial
verify + LRU-at-scale PASS. Backups: `rynthnav-data.corridor-union-backup`
(+ older pre-corridor). Buildbox TERMINATED (disk kept; full-map geom on it).

**W2 — route atlas (agent B):** `5f1a87dc` recorder+atlas+mirror, `409964a9`
ETA calibration (source), `3916130e` nav_file (.nav/.af, byte-identical on 3
real VTank routes in `rynth/testdata/`), `44a48155` sweep_probe, `da65f233`
Rust route-validator (empirically measured 3.984 m/s ≈ run_rate×4.0). 50
node tests green. Carry-forward: indoor-furniture BSP population needs the
Stab→Setup→GfxObj recursion (hook wired, recursion deferred).
[CORRECTION 2026-07-20: the live wasm recursion landed 2026-06-28
(46a1e697/ba7ed2a8); the "deferred" note above referred only to the offline
`route_validate.rs` stub's `populate_cell_furniture` hook. Remaining gap =
offline-harness coverage, not the live client.]

**W3 — director economy (Fable):** `e7574ff3` travel-hold + follow_route/
list_routes/name_route + mission line + auto-record + hourly metrics + prompt;
`1e350aa5` failed-leg sweep probe + snake_case `player_run_rate` fallback;
`c1cf7a48` auto-record composition test (real recorder+atlas). SPEC addendum
in `rynth/ai/SPEC.md`. Suites: routes 44/44, director 78/78, full rynth_ai_*
set green. LIVE-PROVEN during acceptance attempts: mission line (correct
ETA + coverage), route-event early check-ins (8s), followRoute, blocked-fact
probe journal note, hourly metrics line.

## The pose-corruption bug (agent C) — the acceptance blocker

**Symptom:** `getLocalPlayerPose().objCellId` reads 0 (x/y correct) →
movement sim resolves against the wrong landblock → MoveToPosition grinds →
this is very likely the true root of the historical soak-14 "Arwic wall"
(all mesh-fidelity conclusions about C6A9 (84,102)/(78,~21) are UNVERIFIED
until re-tested on the fixed client — ping agent-A's probes if they recur).

**Root cause (two parts, both proven):**
1. Seed race: outdoor login can seed the local player's runtime BODY pose
   with landblock NULL (entity + server-authoritative pose stay correct;
   `__diag.physics` predicted==server throughout).
2. THE NULLER: `project_pose_by_offset`
   (crates/holtburger-world/src/spatial/physics.rs:1997-2014) re-derives the
   working landblock arithmetically from `pose.global_coords()+offset`; with
   landblock 0 the global collapses to bare local coords → re-derives 0
   EVERY frame — self-perpetuating (can perpetuate a 0, never corrupt a
   healthy cell). Also explains the render-side zeroed Y-byte (minimap
   0xC600, empty-void scene — screenshot was captured live on the rig).

**Fix round 1 (MERGED, pushed, insufficient alone):** `1eef336c`/`d8a15dba` —
two NULL-gated inbound heals (reconcile preserve gate + authoritative-only
path). 563/563 crate tests. Insufficient because an IDLE player receives no
inbound position messages → never heals (proven on rig: permanent 0 across
hard-reload + fresh wasm; a GRINDING player gets stray echoes → intermittent
heal → the x-oscillation observed).

**Fix round 2 (worktree branch — CHECK ITS STATE FIRST):** heal at the READ
chokepoint `runtime_pose_for_guid` (mutations.rs) — the single point both
`getLocalPlayerPose` AND the movement-solve input read through — surfacing
the landblock from the server-authoritative pose when the working one is
NULL. Idle heals immediately, solve write-back repairs body.pose within a
frame, movement unbreaks. NULL-gated (healthy play byte-identical). A 4th
unit test (read-path heal) was added; full-suite run + wasm build + rig
verification were IN FLIGHT when the session closed.

## PICKUP (next session, in order)

1. Round-2 fix is SECURED on origin: commit `57dc89c` on branch
   `worktree-agent-afc51b6ce07a81635` (pushed at session close). Its 4 new
   unit tests PASS (confirmed); the FULL holtburger-world suite was mid-run
   (result not captured) — re-run it as the first act.
2. `cargo test -p holtburger-world --lib` (capped-build, kill rust-analyzer
   by `pgrep -x` first) — expect 564/564.
3. Merge to master → `capped-build wasm-pack build --target web --out-dir
   pkg --release` in apps/holtburger-web (~8 min; pkg backup from this
   session: /mnt/wbterminal2/holtburger-scratch/pkg-backup-pre-posefix.wasm).
4. Rig verify (kiosk chromium CDP :9223 survives; account vendortest,
   character parked ~C6A9 (78,18) near the Arwic Town Network portal):
   cache-clear + reload (scratch scripts noted below re-create in minutes if
   /tmp was wiped: cdp_eval/cdp_pausedeval/cdp_pause/cdp_shot/cdp_hardreload
   — Runtime.evaluate STARVES minutes on the saturated renderer; the
   Debugger.pause+evaluateOnCallFrame trick is the reliable channel, but the
   page is frozen during it, sync reads only). Expect: repeated
   getLocalPlayerPose reads NEVER 0 from the first frames, idle included;
   then MoveToPosition walks clean.
5. Acceptance (spec Phase 2): director stopped (`rynthAI.stop()`), then
   `__bot.goto({ns:42.1, ew:33.6})` (Arwic→Holtburg, full map live, expect
   coverage mixed) → arrival → auto-record journal note → route in
   `window.__atlas` → `follow_route` reuse. Then the LLM-driven soak window
   at leisure (event-driven economy: expect >50% call cut vs soak-14).
6. Push everything (user directive: all results to origin/master ASAP).

## Environment notes at close

- Survive the session: ACE (:9000/9001), serve.py :8765, rynthnav sidecar
  :8767 (38,689-tile full map LIVE), rig kiosk chromium (CDP :9223,
  vendortest in-world, director STOPPED), MySQL. Buildbox off. Mock LLM off.
- Died with the session: the agents, their in-flight cargo/wasm builds
  (target dirs persist → incremental rebuild is fast), the MCP chromium.
- Test accounts: navatlas15 (accessLevel 4, char Navatlas — saved INDOORS
  academy 0x860201AD; reproduces the seed race on login), navatlas16
  (tutorial-locked char, agent C's).
- ACE console FIFO: /home/wbterminal/ace_stdin.fifo (accesslevel grants etc.).
- The 21 genuinely-ocean shards yield 0 tiles by design; 3 land-bearing ones
  were recovered (+767 tiles) — already in the live map.
