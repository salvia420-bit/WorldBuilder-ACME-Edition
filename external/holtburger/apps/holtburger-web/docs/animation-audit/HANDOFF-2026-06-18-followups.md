# HANDOFF — 2026-06-18 (session 2): post animation-consolidation follow-ups

The **§5 animation consolidation wave is COMPLETE and pushed** to `origin/master`
(salvia420-bit; `upstream`/Vanquish-6 untouched). The motion interpreter is now
**Rust** (the wasm `MotionSequence`, `src/motion_sequence.rs`); all 6 motion
classes (attack · missile · death · cast · door · locomotion) **+ hooks** are on
it behind default-off `?unifiedMotion=<class>` flags. 7 commits
`534130da..feafc0a1`. Per-entity model + full state in memory
`project_animation_root_cause_2026-06-18`.

**Verified headlessly only:** `cargo test --lib motion_sequence` 7/7 · real-wasm
boundary smoke (`test_motion_sequence_wasm_smoke.mjs`) 17/17 · `run-js-headless`
15/5 (= pre-existing baseline). **IN-WORLD RENDER UNVERIFIED — the user declined
1070 eye-tests; the logic is gated, the pixels are not.**

This document is the **leftover work**: (0) the gated tail of this wave,
(A) the §7 verification harness, (B) the §8 cleanup, (C) the independent backlog.
"§N" refers to `docs/animation-audit/ANIMATION-AUDIT.md`.

---

## 0. GATED TAIL of the consolidation — do FIRST, needs the eye-test

The one thing that unblocks everything else and that I could not do:

1. **1070 eye-test `?unifiedMotion=on`** (all 6 classes at once, or per-class).
   Confirm: swing/cast drive the FULL body then resume; missile fire animates on
   a non-human rig; monster death collapses then HOLDS prone; door SWINGS (not
   teleport/spin); walk/run/idle gait + walk→run with no foot-pop. Watch the
   console for `[motion-link]`/no errors.
   - **Known risk to watch (§8 Q3):** under `?unifiedMotion=locomotion` the
     `CROSSFADE_S=0`/`RESUME_WINDOW` band-aids are BYPASSED, so if the movement
     integrator overshoots you may see Walk→Stop→Walk oscillation / gait jitter.
     That's the upstream integrator bug (see B-1), not the sequence.
2. **If it passes → flip default-on** per the validated-gate rule
   (`feedback_default_on_no_eyetest_gate`): the bar is "bare-default loads +
   spawns + 0 errors". Reconcile the `unifiedMotion` flag(s) to default-on.
3. **Then Step 6 TEARDOWN** (could not do before now — these ARE the live
   default-off path; deleting them pre-validation breaks default):
   - delete `setSwingPose`/`_tickSwingTween`, `setCastPose`/`_tickCastTween`,
     `_suppressBaseCycleForOverlay`, and their manual-null sites (`entities.js`).
   - delete `FULL_BODY_ONE_SHOT` and the cast-tween flags.
   - delete the `crossFadeTo` phase band-aids (`_recentLocomotionTime` /
     `RESUME_WINDOW_MS`, `CROSSFADE_S=0` hard-cut) now superseded by `frameNumber`.
   - the legacy 2D `sprite.rotation` door writes (the 2D path) can stay until 2D
     is retired — out of scope.

---

## A. Verification harness (audit §7) — fully HEADLESS, no eye-test needed

The audit calls this "the single highest-value addition." I built the cargo +
poser + real-wasm smoke half; the **in-world-diag-assertion** half is unbuilt.
The current suite still reports GREEN while attack/death/door render is untested.

- **A-1. Promote `scene3d/diag/motion.js` from console-toy to assertion.** It
  already computes `coverageByCategory()` (`:383`, buckets locomotion/swing/cast/
  emote/reaction/death/door/…), `coverageMatrix()` (`:310`), `stuckEntities()`
  (`:270`), `onMotionLinkPlayed()` (`:230`). **No `*.mjs`/`*.cjs` asserts any of
  it** (grep returns 0). Build an in-world (or wire-replay) test that scripts
  attack/cast/jump/death/door inputs then asserts `coverageByCategory().swing>0`,
  `.cast>0`, death/door buckets `>0`, `unknown===0`, `stuckEntities()` empty.
- **A-2. The "motion oracle" parity test (consolidation spine).** Mirror
  `GetObjectSequence`: feed `(motion, state)` to both the JS path and the Rust
  `MotionSequence`/DAT port; assert identical anim-node sequences. One test then
  covers every class uniformly.
- **A-3. Kill the stale-copy anti-pattern.** `tests/entity_anim_targets.test.cjs:
  4-8` admits it re-implements `entities.js` contracts ("keep in sync") — the
  exact mechanism by which a refactor silently re-breaks motion. Make it import
  the real seam or assert against the wasm boundary.
- **A-4. Explicit regression guards** for the 4 named fragilities (full-body
  swing not one-arm; missile/bow fire produces a clip on a non-human rig; death
  plays then HOLDS final frame; door interpolates). None exist today.
- **A-5. Stop scoring a SKIPPED anim leg as GREEN** (`run-all.mjs:417-422` folds
  `SERVER_DOWN`/`PLAYWRIGHT_MISSING` skips into GREEN). For animation, require
  ≥1 in-world `pass` before green, or surface "anim in-world leg: 0 ran". Fold
  the orphaned `test_ac_*` anim tests into the run-js-headless PLAN with
  `--strict-missing`.

---

## B. §8 leftovers

- **B-1. §8 Q3 — the upstream movement-integrator overshoot (LOAD-BEARING, not
  animation).** The band-aids I retired/bypassed for unified locomotion
  (`entities.js:2162-2175`, `_recentLocomotionTime`, `CROSSFADE_S=0`) were masking
  a movement integrator that "overshoots the run target (25 m/s vs 4.5 m/s) and
  oscillates Walk→Stop→Walk sub-second." Now exposed when `?unifiedMotion=
  locomotion` is on. Fix at the movement layer (the wasm `MovementSystem` /
  `get_state_velocity` path); do NOT re-add the band-aids. Needs a movement-layer
  owner + likely a sub-800-Run test char (`project_move_anim_research_2026-06-06`:
  don't edit the run_rate formula — snapback is DOWNSTREAM).
- **B-2. §8 Q2 — flag/comment inversion cleanup.** `FULL_BODY_ONE_SHOT` (`:592`),
  `CAST_SPEED` (`:608`), `CAST_STATE_MACHINE` (`:625`), `castFaceTarget`,
  `castAxes`, `castFizzle` are coded `!== "off"` (default-ON) but commented
  "default OFF". Confirm intent (likely intentionally live per
  `feedback_default_on_no_eyetest_gate`), fix the misleading comments, and
  reconcile the `unifiedDispatch` default mismatch (`loop.js:291` ON vs
  `index.html:4657` OFF). Mostly subsumed by the Step-6 teardown above.
- **B-3. §8 Q6 — missile command DAT audit.** `MissileAttack1/2/3` (`0xD0-0xD2`)
  + `Shoot 0x61` are enumerated in `ATTACK_COMMANDS` (`entities.js:1049-1056`) but
  never dispatched for player bows (ACE broadcasts the aim cycle, which the new
  `_tryUnifiedCycleOneShot` now animates). Decide whether they're live for
  *creature* missile tables — `crates/holtburger-dat/examples/dump_cmt_ranged_
  rows.rs` exists; wire via `expandActionCommandLow16` or delete.
- **B-4. §8 Q7 — min-clamp vs identity-pad boundary parity (2 lines, low pri).**
  Wasm pads missing parts to identity/origin (`src/lib.rs:16007-16009`) where
  retail clamps the loop and leaves surplus parts at rest
  (`acclient.c:326616`). Rarely hit; a literal divergence.

---

## C. Independent backlog (separate from animation — full list in memory index)

These predate this wave and are unrelated to the motion authority. Curated
actionable set (open `MEMORY.md` for the rest):

- **Local-player snapback — FIX UNIMPLEMENTED** (`project_local_player_snapback_
  2026-06-13`): local-player guard in `mutations.rs apply_entity_autonomous_
  position`. NOT fps-driven; reconcile-knobs were the wrong axis.
- **Empty-world fill PART II/III** (`project_empty_world_fix_2026-06-17`): PART I
  shipped (4645→38153 LBs, encounters-only); II/III not started; probe blocked by
  a pre-existing `has_resource_source` wasm-init.
- **Building taxonomy + invisible-wall** (`project_building_taxonomy_and_invisible_
  wall_2026-06-15`): fix committed RUNTIME-UNVERIFIED, QUEUED 1070 (Academy +
  exterior-wall gates).
- **Terrain floor z-fight PART B** (`project_terrain_black_and_indoor_floor_zfight_
  2026-06-15`): `?buildingFloorBias` default-ON but swiftshader can't validate
  z-fight → needs REAL-GPU eye-test.
- **Academy stacked gear** (`project_ace_world_dup_landblock_instances_2026-06-14`):
  client stale-entity accumulation; fix = `clearWorldEntities` on disconnect +
  grace-aware `reapStaleEntities` — verify impl/ship status.
- **Move/anim next-items await 1070** (`project_move_anim_next_items_2026-06-06`):
  `?cycleOmega`/`?multiAction`/`?castAxes` default-OFF, committed, pending eye-test.
- **F2-3 teleport LoginComplete** (`project_f2_3_login_complete_teleport_2026-06-09`):
  `DEFER_LOGIN_COMPLETE_AFTER_TELEPORT` default-off, pending eye-test.
- **Cold-load perf parallelization — UNCOMMITTED** (`project_holtburger_load_perf_
  2026-06-06`): 140 modulepreload + scenery join_all + http2; re-measure on 1070.
- **Stutter — surviving items** (`project_holtburger_stutter_diag_2026-06-01`):
  SYNC 33MiB terrain-atlas → Web Worker atlas + frame-budget; pop-in 3×3 vs 17×17.
- **White door/chest + dark buildings** (`project_holtburger_white_objects_lighting_
  2026-05-30`): CLIENT-RENDER bug (data fine per WB.T) — over-bright EnvCell
  PointLights / INDEX16 palette hypotheses.
- **HUD parity** (`project_hud_parity_workflow_2026-06-04`): 5 P0 in the salvaged
  `~/from-vm/PRIORITY-LIST.md`; 20/24 panels already wired — polish not rewrite.
- **Item-manipulation 13-PR plan — NOT IMPLEMENTED** (`project_item_manipulation_
  plan_2026-06-06`): load-bearing gap = no JS `ParentEvent 0xF749` handler.
- **fix-loop PART III deferred** (`docs/fix-loop-2026-06-17/HANDOFF.md`): RUNTIME-
  1/2/3 (1070), TERR-1/SCEN-1/PREFETCH-1 (buildbox).

---

## Pointers
- `docs/animation-audit/ANIMATION-AUDIT.md` — the 18-agent audit (§5 plan, §7
  harness, §8 open questions).
- `docs/animation-audit/HANDOFF-2026-06-18.md` — the PRE-this-session handoff
  (now stale: it describes the JS authority + Step-1-only state).
- memory `project_animation_root_cause_2026-06-18` — the authoritative current
  state of the consolidation.
- memory `feedback_default_on_no_eyetest_gate` — the validated-gate → default-on
  rule that governs the teardown.
