# HANDOFF — coherence-review remediation (2026-07-23): 12 packages landed, owed follow-ups

Context: a 16-agent buildbox code review (all rynth/AI/rig surfaces, coherence-focused) produced
a ranked P0/P1 table + conflict map; a 12-package, 2-agents-at-a-time local remediation then
implemented every fix. Full archive (review parts, SYNTHESIS, WORKLIST with per-package
verification): `/mnt/wbterminal1/rynth-review-2026-07-23/`. This commit contains the entire
remediation. Gates at commit time: node suite **52/0/32** (new steady state — every rynth_* file
now visibly accounted for; was 50/0/2), `cargo test -p holtburger-world` green, `-p
holtburger-core` **610/0/1-ignored** (606 baseline + 4 new), release wasm rebuilt **4.84MB**
(pkg/ is gitignored — REBUILD after pulling: capped `wasm-pack build --target web --out-dir pkg
--release`).

What landed (one line each): control-channel sender allowlist (was: any player could command the
stream bot); single stop authority (kernel operator-hold latch; director can no longer un-pause an
operator pause; in-flight plans abortable); unified `bot.movementClaimed()` + `travel()` restore;
shared host cast token + explicit Magic-mode entry with give-up valve (vitals releases the kernel
tick — livelock closed); LLM config re-scoped to live minimax (provider pin table, $1/hr spend cap
on the live path, 51.4s spacing floor, cost catalog); scratchpad pinned un-droppable + honest
one-call `window.rynthAI.wipeForCleanTest()`; wasm `getLocalPlayerPoseCellResolved()` replacing
the dead cell-0 sentinel (4 consumers converted, graceful degrade); recall-spell table derived
from the canonical map (7 wrong ids fixed); nav_guard per-cell floor planes; settle-land
regression tests (see FINDING below); test-surface consolidation (orphan smokes enumerated,
pose-based boot gates, mock-contract test, pause-survives-director-checkin regression test);
dark-core pre-wiring fixes + quarantine docs; full docs-drift batch; rig hardening (bounded kind=4
auto-reload, CDP recovery watchdog `scripts/stream-rig-watchdog.cjs`, launch.sh URL cleanup,
DEFERRED-KILL-LIST rescued into this repo).

## ⚠ FINDING (highest-value follow-up): settle-land ea2cc7c3 patched DEAD code

Traced and pinned by test during gate G2: `USE_UNIFIED_TRANSITION` is const-true since `a7cfb75e`
(2026-06-16), so `advance_local_pose_for_manual_drive` ALWAYS routes through
`advance_manual_slice_via_transition` — the legacy chain that ea2cc7c3 (2026-07-21) patched with
the `LAND_SETTLE_EPS` hover gate is unreachable. The reachable duplicate,
`resolve_floor_for_step` (`transition.rs:966`, "direct port of the legacy chain's floor block"),
still has the bare pre-fix gate `descending && z <= terrain_z` — no EPS. Pinned by canary test
`settle_land_eps_gate_is_unreachable_under_default_routing` (holtburger-core
movement/system/tests.rs, with a full FINDING comment block) — it fails loudly if routing changes.

Follow-up work, in order:
1. Port the EPS hover gate into `resolve_floor_for_step` (transition.rs:966) — small, but it is
   LIVE physics; gate behind the same `USE_SETTLE_LAND` const and flip the canary + re-pin
   `settle_land_hover_lands_within_two_ticks` back to one-tick when done.
2. Audit `faithful_bridge::faithful_find_transitional_position` — the TRUE live-gameplay path when
   terrain is scene-resident (`SpatialScene::terrain_landblock_resident`) — for the same hover-latch
   bug. UNAUDITED as of this handoff; test fixtures can't reach it because
   `WorldState::populate_terrain_heights` fills a different store than the residency check reads
   (itself a test-infrastructure gap worth closing).
3. Determine on a live soak how the 2026-07-21 slide wedge actually resolved (drift below the
   plane? faithful path immune?) — the fix's live verification is now unexplained.

## Other owed follow-ups (out of remediation scope, all recorded during the waves)

- **Live `--full` suite pass**: the orphan-smoke fold-in (new `AI_INFRA` group), the pose-based
  boot gates in `rynth_boot_helper.cjs`/`supervisor.cjs`, and the new watchdog were verified
  node-only — one `NODE_PATH=<playwright> node rynth_test_all.cjs --full` against live
  ACE+serve.py+wsbridge is owed before trusting them end to end. The rig was DOWN all session;
  the watchdog has never run against a live CDP :9223.
- **launch.sh `botCtlOwner=vendortest`** (out-of-repo file, `.bak` kept beside it): currently set
  to the bot's own account = NO real protection, just preserves behavior. The operator must change
  it to their own character name(s), comma-separated. The in-page default (owner = logged-in
  character) also means only the bot itself can command itself if the flag is dropped — fine for
  refuse-all safety, useless for actual operator control.
- **minimax provider pin re-tune**: `PROVIDER_PIN_TABLE` (index.html) gives minimax/*
  `{order:["novita","minimax"], allow_fallbacks:false}` — intent-mirrored from the z-ai pin, NOT
  soak-measured. Run a provider-ranking soak (the soak-8 method) and re-pin; costs in
  providers.js for glm-5.2/phi-4/minimax-m3 are `estimated:true` over-estimates — replace with
  real OpenRouter listings when convenient.
- **Rust auto-wield for non-caster Magic entry**: the wasm refuses Magic(8) without a wielded
  caster item (mirrors ACE, `is_wielding_caster`). Full non-caster heal rescue needs a
  wield-caster-from-pack-then-set-mode command in `SetCombatMode`'s arm (lib.rs ~45179) or a
  combined wasm command. Spec in the W2b report (`/mnt/wbterminal1/rynth-review-2026-07-23/`).
  Until then heal_reflex (item-based) is the non-caster survival tool.
- **Movement-claim residuals** (documented, pre-existing): (a) `wasRunning` capture across mover
  supersede interleavings (travel→goto at the wrong instant → neither restores the kernel) —
  needs a doGoto/doFollowRoute ownership redesign, not a patch; (b) no regression test exercises
  `!bot come`; (c) a pressure hop can still fire during a long kernel Combat/Buffing stretch
  (`movementClaimed()` covers loot APPROACH only, by scoped design).
- **Dark-core wiring** (order re-validated: suit_solver → loot_policy → heal_reflex →
  confirm_reflex → combat_memory LAST): loot_policy + heal_reflex pre-wiring contracts are now
  fixed (pending-defer appraisal gate, `VERDICT_ACTION_MAP`, shared accessor + valve);
  combat_memory still needs the kill-truth decision (kernel P12 vs its name-keyed estimate) AND
  the kernel's dormant `startOn()`/kind=19 subscription seam fixed before wiring. All five remain
  import-quarantined (verified zero live imports; see rynth/README.md §Dark modules).
- **`extensions.js` deltas-path pose signal**: `rawPoseOf` now carries `cellResolved`, but the
  director-path consumers that re-shape poses downstream were only spot-converted — a sweep for
  any remaining `objCellId === 0` comparisons after the wasm rebuild proves out is cheap insurance
  (`rg -n 'objCellId ?=== ?0' rynth/`).
- **Test-infra gaps flagged by W5a, not in its file scope**: capture/diag smokes
  (`capture_wire_agent_hud_inventory.cjs`, `diag_icon_probe.cjs`, `diag_inventory_paperdoll.cjs`)
  still gate on `__bootState==="ready"`; index.html boot-loop `.free()`/`__connectEpoch` has no JS
  regression test; `thought_overlay.js`/`route_flags.js` have no direct-import coverage.
- **Review coverage gaps** (surfaces NO review task owned — candidates for a future pass): scene3d
  render pipeline (the actual stream image), wasm world/physics beyond movement, economy/vendor/
  advancement action semantics, sidecar network exposure posture (:8767/:8768 bind/auth), and
  `ai/eval/scenarios.js` audited as a behavioral spec.

## Operator notes for the next rig relaunch

launch.sh now spawns the watchdog (logs: `/mnt/wbterminal2/stream/watchdog{,-console}.log`; STOP
file stops it too). The game URL dropped dead `kickDance=1` and no-op `faithfulEntityCollision=on`
and gained `botCtlOwner` (see above). Clean-model tests: use `window.rynthAI.wipeForCleanTest()`
(STREAM-RIG-OPS §wipe — the old hand-typed recipe left RAM caches alive and is superseded). kind=4
disconnects now auto-reload (bot/agent tabs only, 5-per-10min budget) — a persistent DISCONNECTED
banner past that budget means the budget exhausted: investigate, don't just reload.
