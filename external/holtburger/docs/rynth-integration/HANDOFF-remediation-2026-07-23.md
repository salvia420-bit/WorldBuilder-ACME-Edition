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

## ✅ STATUS 2026-07-23 (later same day): FINDING items 1 & 2 RESOLVED, item 3 answered

The three FINDING follow-ups below were then implemented (commit pending), then hardened by an
adversarial physics review. Gates after: holtburger-core **612/0/1-ignored** (610 + faithful-path
test + slow-riser regression test), holtburger-world **579/0**. What landed:

> Review-driven refinement (both paths): the settle-land EPS **band** (0..8 cm ABOVE the plane) is
> gated on a NEW `entry_descending` signal — vz ≤ 0 at TRUE slice entry — NOT the post-gravity
> `descending` (which reads true for entry velocities up to ~0.98 m/s, so it would force-land a slow
> riser mid-ascent and short-circuit a real hop). The below-plane touchdown keeps post-gravity
> `descending`. This closes a latent over-reach that existed in ea2cc7c3's original design. Also:
> the faithful snap now carries `!force_grounded` (fallback parity), and the fallback's
> settle/`landing_walkable` flag interdependence + the faithful raw-terrain-vs-water sampling are
> documented inline. New regression test `settle_land_does_not_force_land_a_slow_riser_within_eps`.

- **Item 1 — DONE.** The EPS hover gate is ported into the reachable `resolve_floor_for_step`
  (transition.rs): its outdoor touchdown ceiling is now `z + LAND_SETTLE_EPS` when the new
  `TransitionGates::settle_land` is set, threaded from `USE_SETTLE_LAND` by the production gates
  builder (system.rs). `LAND_SETTLE_EPS` now lives once in `holtburger_world::spatial` (re-exported
  by core's copy) so the two chains can't drift. The canary was FLIPPED
  (`settle_land_eps_gate_is_reachable_under_default_routing`) and the two hover tests re-pinned to
  the one-tick EPS behavior; `settle_land_does_not_force_land_a_rising_mover` still guards ascent.
- **Item 2 — DONE.** `faithful_bridge::faithful_find_transitional_position` audited (report:
  `FINDING2-faithful-audit-2026-07-23.md`) and found conditionally-buggy (no one-tick EPS snap;
  gravity-bounded, not a forever-latch — the decomp terrain gate records CONTACT only once the
  sphere BOTTOM reaches the plane). Fixed with the faithful twin of the EPS snap at the marshalling
  level (gated on the same `settle_land`, using a new `faithful_terrain_floor` collision-plane
  sampler + the `landing_allows_touchdown` slope gate). The test-infra gap is closed with an OPT-IN
  seeder `WorldState::populate_terrain_heights_scene_resident` (seeds BOTH the WorldState floor
  sampler AND the SpatialScene residency store) — existing fixtures untouched, so the fallback
  tests keep their pinned numbers; new test `settle_land_faithful_outdoor_hover_lands_in_one_tick`
  exercises the faithful path.
- **Item 3 — answered (no live rig needed).** The audit shows the faithful path is NOT independently
  immune: like the fallback it self-terminates via gravity within a few ticks. So the 2026-07-21
  slide most plausibly resolved by gravity reeling the mover below the plane after a few ticks of
  bounded drift, not by the faithful path being immune. A live soak is no longer load-bearing for
  this understanding, though a confirming soak is still cheap insurance once the rig is up.

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
- **`extensions.js` deltas-path pose signal** — ✅ DONE (2026-07-23). Swept `rynth/`; the last
  unconverted dead cell-0 sentinel (`ai/extensions.js` `locationBlock`, the director-path pose
  consumer) now prefers `cellResolved` with a legacy raw-zero fallback, matching
  actions.js/explore_memory.js/indoor_router. All other `objCellId >>> N` sites are world-frame /
  LB-word math, not sentinels (left as-is). `rynth_ai_extensions_test.cjs` 40/0.
- **Test-infra gaps flagged by W5a, not in its file scope**: capture/diag smokes
  (`capture_wire_agent_hud_inventory.cjs`, `diag_icon_probe.cjs`, `diag_inventory_paperdoll.cjs`)
  still gate on `__bootState==="ready"`; index.html boot-loop `.free()`/`__connectEpoch` has no JS
  regression test. ✅ PARTIAL (2026-07-23): `thought_overlay.js` + `route_flags.js` now have
  direct-import coverage (`rynth_thought_overlay_test.cjs` 10/0, `rynth_route_flags_test.cjs`
  14/0; node suite 52→54 pass / 0 fail / 32 skip). The capture/diag boot-gate and the boot-loop
  regression test remain owed.
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
